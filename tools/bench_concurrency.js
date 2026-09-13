'use strict';

const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const { loadSettings, SERVER_ROOT } = require('../src/config/load_settings');
const { loadPack, resolveContentPath } = require('../src/content/load_pack');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { World } = require('../src/world/world');
const { startHttp } = require('../src/http/server');
const { createLog } = require('../src/log');
const { C2S, S2C } = require('../src/protocol/opcodes');
const { encodeFrame, decodeFrame } = require('../src/protocol/frame');
const { decodeEnterWorld, decodePong } = require('../src/protocol/messages');
const { randomToken, hashToken } = require('../src/security/token');

// Parse CLI arguments:
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        scenario: 'scattered', // 'idle' | 'scattered' | 'cluster'
        max: 200,
        step: 25,
        interval: 5,
        help: false
    };

    for (const arg of args) {
        if (arg === '--help' || arg === '-h') {
            opts.help = true;
        } else if (arg.startsWith('--scenario=')) {
            opts.scenario = arg.split('=')[1];
        } else if (arg.startsWith('--max=')) {
            opts.max = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--step=')) {
            opts.step = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--interval=')) {
            opts.interval = parseInt(arg.split('=')[1], 10);
        }
    }
    return opts;
}

// Bot client representation:
class BotClient {
    constructor({ id, port, rawToken, scenario, spawnPos }) {
        this.id = id;
        this.port = port;
        this.rawToken = rawToken;
        this.scenario = scenario;
        this.spawnPos = spawnPos;
        this.ws = null;
        this.seq = 1;
        this.entered = false;
        this.characterId = 0;
        this.x = spawnPos.x;
        this.y = spawnPos.y;
        this.z = spawnPos.z;
        this.closed = false;
        this.curDir = Math.floor(Math.random() * 4);
        this.stepsInDir = 0;
        this.pingTimer = null;
        this.moveTimer = null;
        this.rttSamples = [];
    }

    connect() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${this.port}/v1/ws`);
            this.ws = ws;
            ws.binaryType = 'arraybuffer';

            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    reject(new Error(`Bot ${this.id} connection timeout`));
                }
            }, 6000);

            ws.on('open', () => {});

            ws.on('message', (raw) => {
                const frame = decodeFrame(Buffer.from(raw));
                if (!frame) return;

                if (frame.opcode === S2C.HELLO) {
                    ws.send(encodeFrame(C2S.ENTER, this.seq++, this.rawToken));
                } else if (frame.opcode === S2C.ENTER_WORLD) {
                    const ew = decodeEnterWorld(frame.payload);
                    this.entered = true;
                    this.characterId = ew.characterId;
                    this.x = ew.x;
                    this.y = ew.y;
                    this.z = ew.z;
                    this.startBehaviors();
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        resolve();
                    }
                } else if (frame.opcode === S2C.PONG) {
                    const pong = decodePong(frame.payload);
                    if (pong && pong.clientMs) {
                        const nowMs = (Date.now() % 0x100000000) >>> 0;
                        const rtt = Math.max(0, nowMs - pong.clientMs);
                        this.rttSamples.push(rtt);
                        if (this.rttSamples.length > 20) this.rttSamples.shift();
                    }
                }
            });

            ws.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    reject(err);
                }
            });

            ws.on('close', () => {
                this.closed = true;
                this.stopBehaviors();
            });
        });
    }

    startBehaviors() {
        // Regular ping to measure event loop latency:
        this.pingTimer = setInterval(() => {
            if (this.closed || !this.entered || this.ws.readyState !== WebSocket.OPEN) return;
            const buf = Buffer.alloc(4);
            buf.writeUInt32LE((Date.now() % 0x100000000) >>> 0, 0);
            this.ws.send(encodeFrame(C2S.PING, this.seq++, buf));
        }, 1500 + Math.floor(Math.random() * 500));

        // Movement behavior:
        if (this.scenario === 'idle') return;

        // Steps every 250ms (respects stepDelayTicks = 4 at 20 UPS):
        const intervalMs = 250;
        this.moveTimer = setInterval(() => {
            if (this.closed || !this.entered || this.ws.readyState !== WebSocket.OPEN) return;
            this.stepsInDir++;
            if (this.stepsInDir > 4 || Math.random() < 0.25) {
                this.curDir = Math.floor(Math.random() * 4);
                this.stepsInDir = 0;
            }
            this.ws.send(encodeFrame(C2S.MOVE_STEP, this.seq++, Buffer.from([this.curDir])));
        }, intervalMs);
    }

    stopBehaviors() {
        if (this.pingTimer) clearInterval(this.pingTimer);
        if (this.moveTimer) clearInterval(this.moveTimer);
        this.pingTimer = null;
        this.moveTimer = null;
    }

    disconnect() {
        this.stopBehaviors();
        if (this.ws) {
            try { this.ws.terminate(); } catch {}
        }
    }
}

// Find walkable locations for bots:
function collectWalkableTiles(tileMap, scenario, town) {
    const tiles = [];
    if (scenario === 'cluster') {
        // Town plaza cluster bounds (small area near town spawn):
        const z = town.z;
        for (let x = town.x - 4; x <= town.x + 4; x++) {
            for (let y = town.y - 4; y <= town.y + 4; y++) {
                if (tileMap.isWalkable(x, y, z)) {
                    tiles.push({ x, y, z });
                }
            }
        }
    } else {
        // Scattered across town and nearby fields on z=6:
        const z = town.z;
        for (let x = town.x - 30; x <= town.x + 30; x += 2) {
            for (let y = town.y - 30; y <= town.y + 30; y += 2) {
                if (tileMap.isWalkable(x, y, z)) {
                    tiles.push({ x, y, z });
                }
            }
        }
    }
    if (tiles.length === 0) {
        tiles.push({ x: town.x, y: town.y, z: town.z });
    }
    return tiles;
}

// Set up isolated benchmark server:
async function setupBenchmarkServer() {
    const settings = loadSettings({ root: SERVER_ROOT, env: {} });
    settings.httpPort = 0; // random available port
    settings.bind = '127.0.0.1';
    settings.maxPlayers = 50000;
    settings.limits.maxConnectionsPerIp = 50000;
    settings.limits.maxHttpPerIpPerMin = 1000000;
    settings.limits.maxPacketsPerSecond = 1000;
    settings.limits.packetBurst = 500;
    settings.logLevel = 'error'; // mute normal server logs for clean test output
    settings.persistIntervalMs = 0; // no periodic database writes

    const store = new MemoryStore();
    const pack = loadPack(resolveContentPath(settings));
    const log = createLog(settings);
    const world = new World({ settings, store, log, pack });

    // Instrument world.step to measure precise execution time of each tick:
    const tickStats = {
        durations: [],
        stepCount: 0
    };

    const originalStep = world.step.bind(world);
    world.step = function(tickIndex) {
        const t0 = process.hrtime.bigint();
        originalStep(tickIndex);
        const dtNs = process.hrtime.bigint() - t0;
        const dtMs = Number(dtNs) / 1000000;
        tickStats.durations.push(dtMs);
        tickStats.stepCount++;
    };

    world.start();
    const limiter = new RateLimiter();
    const httpd = await startHttp({ settings, store, limiter, world, log });

    return {
        port: httpd.port,
        settings,
        store,
        world,
        httpd,
        tickStats
    };
}

// Fast bot account & character creation:
async function provisionBot(store, settings, id, pos) {
    const acc = await store.createAccount({
        email: `bot_${id}@bench.local`,
        passwordHash: 'bench_hash'
    });

    const ch = await store.createCharacter(Object.assign({}, settings.newCharacter, {
        accountId: acc.id,
        name: `Bot_${id}`,
        vocation: 'scout',
        posX: pos.x,
        posY: pos.y,
        posZ: pos.z
    }));

    const rawToken = randomToken();
    const tokenHash = hashToken(rawToken);
    await store.createPlayToken({
        tokenHash,
        accountId: acc.id,
        characterId: ch.id,
        expiresAt: new Date(Date.now() + 3600000)
    });

    return { rawToken, ch };
}

async function runBenchmark() {
    const opts = parseArgs();

    if (opts.help) {
        console.log(`
Uso: node tools/bench_concurrency.js [opções]

Opções:
  --scenario=SCENARIO   'scattered' (padrão), 'cluster' (praça cheia), 'idle' (parados)
  --max=NUM             Número máximo de bots (padrão: 200)
  --step=NUM            Incremento de bots por degrau (padrão: 25)
  --interval=SEC        Duração de cada degrau em segundos (padrão: 5)
  --help                Exibe esta ajuda
`);
        return;
    }

    console.log('='.repeat(80));
    console.log('       BENCHMARK DE CONCORRÊNCIA - SERVER ENGINE (STANDALONE)');
    console.log('='.repeat(80));
    console.log(`Cenário:         ${opts.scenario.toUpperCase()}`);
    console.log(`Ramp-up:         +${opts.step} bots a cada ${opts.interval}s (até máx de ${opts.max})`);
    console.log(`Tick do Mundo:   20 UPS (50ms por tick)`);
    console.log(`Modo:            Totalmente isolado em RAM (sem alterar configs nem banco)`);
    console.log('-'.repeat(80));

    const bench = await setupBenchmarkServer();
    const { port, settings, store, world, httpd, tickStats } = bench;

    const town = world.townSpawn();
    const spawnTiles = collectWalkableTiles(world.tileMap, opts.scenario, town);

    console.log(`Servidor ativo na porta efêmera :${port} | Tiles de spawn mapeados: ${spawnTiles.length}`);
    console.log('-'.repeat(80));
    console.log(
        'Bots'.padStart(6) + ' | ' +
        'Jogadores'.padStart(9) + ' | ' +
        'Monstros'.padStart(8) + ' | ' +
        'Avg Tick'.padStart(9) + ' | ' +
        'Max Tick'.padStart(9) + ' | ' +
        'Missed'.padStart(7) + ' | ' +
        'RTT'.padStart(6) + ' | ' +
        'RAM'.padStart(8) + ' | ' +
        'Status'
    );
    console.log('-'.repeat(80));

    const activeBots = [];
    let botIdCounter = 1;
    let saturationReached = false;
    let maxSmoothPlayers = 0;
    let failureReason = null;

    try {
        while (activeBots.length < opts.max && !saturationReached) {
            const targetCount = Math.min(opts.max, activeBots.length + opts.step);
            const toAdd = targetCount - activeBots.length;

            // Provision and connect new bots concurrently:
            const connectPromises = [];
            for (let i = 0; i < toAdd; i++) {
                const id = botIdCounter++;
                const spawnPos = spawnTiles[id % spawnTiles.length];
                const p = provisionBot(store, settings, id, spawnPos).then(({ rawToken }) => {
                    const bot = new BotClient({
                        id,
                        port,
                        rawToken,
                        scenario: opts.scenario,
                        spawnPos
                    });
                    activeBots.push(bot);
                    return bot.connect();
                });
                connectPromises.push(p);
            }

            await Promise.all(connectPromises);

            // Reset sample window for this interval:
            tickStats.durations = [];
            const missedAtStart = world.tick.missedTicks;

            // Wait interval duration:
            await new Promise((res) => setTimeout(res, opts.interval * 1000));

            // Compute metrics for this interval:
            const durations = tickStats.durations.slice();
            const missedInInterval = world.tick.missedTicks - missedAtStart;
            const avgTickMs = durations.length > 0
                ? (durations.reduce((a, b) => a + b, 0) / durations.length)
                : 0;
            const maxTickMs = durations.length > 0
                ? Math.max(...durations)
                : 0;

            // Compute RTT:
            let allRtts = [];
            for (const b of activeBots) {
                if (b.rttSamples.length > 0) {
                    allRtts.push(b.rttSamples[b.rttSamples.length - 1]);
                }
            }
            const avgRtt = allRtts.length > 0
                ? Math.round(allRtts.reduce((a, b) => a + b, 0) / allRtts.length)
                : 0;

            const memMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
            const livePlayers = world.playerCount();
            const liveCreatures = world.creatures.size;

            let status = 'Fluido (OK)';
            if (missedInInterval > 5 || avgTickMs > 45) {
                status = 'SATURADO';
                saturationReached = true;
                failureReason = `Tick demorou avg ${avgTickMs.toFixed(1)}ms (limite 50ms) com ${missedInInterval} ticks perdidos`;
            } else if (missedInInterval > 0 || avgTickMs > 25) {
                status = 'Carga Alta';
                maxSmoothPlayers = livePlayers;
            } else {
                maxSmoothPlayers = livePlayers;
            }

            console.log(
                String(activeBots.length).padStart(6) + ' | ' +
                String(livePlayers).padStart(9) + ' | ' +
                String(liveCreatures).padStart(8) + ' | ' +
                (avgTickMs.toFixed(2) + 'ms').padStart(9) + ' | ' +
                (maxTickMs.toFixed(2) + 'ms').padStart(9) + ' | ' +
                String(missedInInterval).padStart(7) + ' | ' +
                (avgRtt + 'ms').padStart(6) + ' | ' +
                (memMb + 'MB').padStart(8) + ' | ' +
                status
            );
        }
    } catch (err) {
        console.error('Erro durante o benchmark:', err);
    } finally {
        console.log('-'.repeat(80));
        console.log('Encerrando conexões de bots e finalizando servidor...');
        for (const b of activeBots) b.disconnect();
        world.stop();
        await httpd.close();
    }

    console.log('='.repeat(80));
    console.log('                   RELATÓRIO DE CAPACIDADE');
    console.log('='.repeat(80));
    console.log(`Cenário Testado:           ${opts.scenario.toUpperCase()}`);
    console.log(`Capacidade Fluida (SLA):   ~${maxSmoothPlayers} jogadores simultâneos sem perda de ticks`);
    if (saturationReached) {
        console.log(`Ponto de Ruptura:          ${activeBots.length} jogadores simultâneos`);
        console.log(`Causa da Saturação:        ${failureReason}`);
    } else {
        console.log(`Ponto de Ruptura:          Não atingido até o teto testado (${opts.max} jogadores)`);
    }
    console.log('='.repeat(80));
}

runBenchmark().catch((err) => {
    console.error('Falha fatal no benchmark:', err);
    process.exit(1);
});

'use strict';

const { PROTOCOL_VERSION, C2S, S2C, REASON } = require('../protocol/opcodes');
const { decodeFrame } = require('../protocol/frame');
const { encodeHello } = require('../protocol/messages');
const { hashToken } = require('../security/token');
const { clientIp } = require('../security/client_ip');
const { GameSession } = require('../world/session');

function loadWs() {
    try {
        return require('ws');
    } catch (err) {
        const e = new Error('ws package missing — run npm install in server/');
        e.cause = err;
        throw e;
    }
}

function attachGameWs(server, deps) {
    const { WebSocketServer } = loadWs();
    const { settings, limiter, world, log } = deps;
    const maxPayload = settings.limits.maxWsFrameBytes | 0 || 4096;
    const wss = new WebSocketServer({
        server,
        path: '/v1/ws',
        maxPayload,
        perMessageDeflate: false
    });

    wss.on('connection', (socket, req) => {
        const ip = clientIp(req, settings);
        limiter.metrics.wsAccepted += 1;
        if (limiter.isIpIgnored(ip)) {
            limiter.metrics.wsRejected += 1;
            socket.close(4403);
            return;
        }
        Promise.resolve(deps.store.isIpBanned(ip, Date.now())).then((banned) => {
            if (banned) {
                limiter.metrics.wsRejected += 1;
                socket.close(4403);
                return;
            }
            if (socket.readyState !== 1) return;
            acceptConnection(socket, ip, deps);
        }).catch((err) => {
            log.error('ws ban check', { err: err && err.message });
            socket.terminate();
        });
    });

    return wss;
}

function acceptConnection(socket, ip, deps) {
    const { settings, limiter, world, log } = deps;
    const session = new GameSession({
        socket,
        ip,
        world,
        settings,
        limiter,
        log
    });
    const timeoutMs = settings.limits.wsEnterTimeoutMs | 0 || 10000;
    session.send(S2C.HELLO, encodeHello({
        protocolVersion: PROTOCOL_VERSION,
        ups: settings.logicUps | 0,
        tickIndex: world.tick.tickIndex,
        enterTimeoutMs: timeoutMs
    }));
    session.startEnterTimer(timeoutMs);

    socket.on('message', (data, isBinary) => {
        onMessage(session, data, isBinary);
    });
    socket.on('close', () => {
        session.clearEnterTimer();
        if (!session.dead) {
            session.dead = true;
            world.leave(session);
        }
    });
    socket.on('error', () => {
        // close follows
    });
}

function onMessage(session, data, isBinary) {
    if (session.dead) return;
    if (!isBinary) {
        session.malformed();
        return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const max = session.settings.limits.maxWsFrameBytes | 0 || 4096;
    if (buf.length < 6 || buf.length > max) {
        session.malformed();
        return;
    }
    if (!session.gate.allow()) {
        session.flood();
        return;
    }
    const frame = decodeFrame(buf);
    if (!frame) {
        session.malformed();
        return;
    }
    if (!session.entered) {
        handlePreEnter(session, frame);
        return;
    }
    session.world.enqueueIntent(session, frame);
}

function handlePreEnter(session, frame) {
    if (session.entering) {
        session.kick(REASON.BAD_SEQ);
        session.limiter.metrics.enterFail += 1;
        return;
    }
    if (frame.opcode !== C2S.ENTER) {
        session.kick(REASON.NOT_ENTERED);
        session.limiter.metrics.enterFail += 1;
        return;
    }
    if (frame.seq !== 1 || frame.payload.length !== 32) {
        session.kick(frame.payload.length === 32 ? REASON.BAD_SEQ : REASON.BAD_TOKEN);
        session.limiter.metrics.enterFail += 1;
        return;
    }
    session.entering = true;
    session.nextClientSeq = frame.seq + 1;
    session.clearEnterTimer();
    enterWorld(session, frame.payload).catch((err) => {
        session.log.error('enter failed', { err: err && err.message });
        if (!session.dead) session.kick(REASON.UNAUTHORIZED);
    });
}

async function enterWorld(session, tokenBuf) {
    const store = session.world.store;
    const world = session.world;
    const settings = session.settings;
    const limiter = session.limiter;
    const tok = await store.consumePlayToken(hashToken(tokenBuf), session.now());
    if (session.dead) return;
    if (!tok) {
        limiter.metrics.enterFail += 1;
        session.kick(REASON.BAD_TOKEN);
        return;
    }
    if (settings.limits.playTokenBindIp && tok.ip && tok.ip !== session.ip) {
        limiter.metrics.enterFail += 1;
        session.kick(REASON.IP_MISMATCH);
        return;
    }
    if (await store.isAccountBanned(tok.accountId, session.now())) {
        if (session.dead) return;
        limiter.metrics.enterFail += 1;
        session.kick(REASON.BANNED);
        return;
    }
    let ch = await store.findCharacter(tok.accountId, tok.characterId);
    if (session.dead) return;
    if (!ch) {
        limiter.metrics.enterFail += 1;
        session.kick(REASON.UNAUTHORIZED);
        return;
    }
    const onlineCap = settings.maxPlayersOnlinePerAccount | 0;
    if (onlineCap > 0) {
        const existingAcc = world.getByAccount(ch.accountId);
        if (existingAcc && existingAcc.character.id !== ch.id) {
            limiter.metrics.enterFail += 1;
            session.kick(REASON.ALREADY_ONLINE);
            return;
        }
    }
    const max = settings.maxPlayers | 0;
    if (max > 0 && world.playerCount() >= max) {
        const existingCh = world.getByCharacter(ch.id);
        if (!existingCh) {
            limiter.metrics.enterFail += 1;
            session.kick(REASON.WORLD_FULL);
            return;
        }
    }
    const old = world.getByCharacter(ch.id);
    if (old) {
        const oldId = old.character && old.character.id;
        old.kick(REASON.REPLACED);
        if (oldId && typeof world.awaitPersist === 'function') {
            await world.awaitPersist(oldId);
        }
        const fresh = await store.findCharacter(tok.accountId, tok.characterId);
        if (fresh) ch = fresh;
    }
    if (session.dead) return;
    let state = null;
    let skills = null;
    if (typeof store.loadCharacterState === 'function') {
        state = await store.loadCharacterState(ch.id);
    }
    if (typeof store.loadSkills === 'function') {
        skills = await store.loadSkills(ch.id);
    }
    if (session.dead) return;
    if ((ch.hp | 0) <= 0) {
        const town = world.townSpawn();
        ch.hp = ch.hpMax;
        ch.posX = town.x;
        ch.posY = town.y;
        ch.posZ = town.z;
    }
    const pos = world.spawnPos(ch);
    session.bindCharacter(ch, pos, { state, skills });
    if (!world.add(session)) {
        limiter.metrics.enterFail += 1;
        session.kick(REASON.WORLD_FULL);
        return;
    }
    try {
        await store.touchCharacterLogin(ch.id, new Date(session.now()));
    } catch (err) {
        session.log.error('login touch', { err: err && err.message });
    }
    if (session.dead) {
        world.leave(session);
        return;
    }
    limiter.metrics.enterOk += 1;
    world.sendEnterWorld(session);
    world.syncAppears(session);
}

module.exports = { attachGameWs, enterWorld };

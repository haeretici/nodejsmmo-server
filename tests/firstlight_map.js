'use strict';

const assert = require('assert');
const { testSettings, request, withHttp, waitFor } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C, REASON, DIR } = require('../src/protocol/opcodes');
const { encodeFrame, decodeFrame } = require('../src/protocol/frame');
const {
    decodeEnterWorld,
    decodeMove,
    decodeReject,
    decodeViewport
} = require('../src/protocol/messages');
const { TILE, VIEW_W, VIEW_H, clampSpawn } = require('../src/world/static_map');
const { FRICTION_BLOCKED } = require('../src/world/tilemap');
const { loadPack, resolveContentPath, runtimeMap, resolveMapId } = require('../src/content/load_pack');
const { SERVER_ROOT } = require('../src/config/load_settings');
const { parseHexToken } = require('../src/security/token');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function lastOf(sock, opcode) {
    for (let i = sock.sent.length - 1; i >= 0; i--) {
        const f = decodeFrame(sock.sent[i]);
        if (f.opcode === opcode) return f;
    }
    return null;
}

function makeWorld(pack, extra) {
    const settings = testSettings();
    delete settings.spawns;
    delete settings.npcs;
    if (extra) Object.assign(settings, extra);
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        pack,
        schedule: () => 0,
        clear: () => {}
    });
    return world;
}

function makeSession(world, pos) {
    const sock = fakeSocket();
    const session = new GameSession({
        socket: sock,
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    const ch = {
        id: 1,
        accountId: 1,
        name: 'Ash',
        vocation: 'scout',
        level: 1,
        experience: 0,
        hp: 185,
        hpMax: 185,
        mp: 90,
        mpMax: 90,
        townId: 1
    };
    session.bindCharacter(ch, pos || world.townSpawn());
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    return session;
}

function openWs(port) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
    ws.binaryType = 'arraybuffer';
    const inbox = [];
    const closed = { code: null, done: false };
    let openedOk = false;
    const opened = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('open timeout')), 2000);
        ws.addEventListener('open', () => {
            openedOk = true;
            clearTimeout(t);
            resolve();
        });
        ws.addEventListener('error', () => {
            if (!openedOk) {
                clearTimeout(t);
                reject(new Error('ws error'));
            }
        });
    });
    ws.addEventListener('message', (ev) => {
        inbox.push(decodeFrame(Buffer.from(ev.data)));
    });
    ws.addEventListener('close', (ev) => {
        closed.code = ev.code;
        closed.done = true;
    });
    return { ws, inbox, closed, opened };
}

function findOp(inbox, opcode) {
    return inbox.find((f) => f.opcode === opcode) || null;
}

async function main() {
    const root = resolveContentPath({ contentPath: '../content' }, SERVER_ROOT);
    const pack = loadPack(root);
    const map = runtimeMap(pack);

    assert.strictEqual(map.id, 'firstlight_isle');
    assert.strictEqual(map.width, 225);
    assert.strictEqual(map.height, 198);
    assert.strictEqual(map.spawnX, 80);
    assert.strictEqual(map.spawnY, 132);
    assert.strictEqual(map.spawnZ, 6);
    assert.strictEqual(Object.keys(map.floors).length, 16);
    assert.strictEqual(map.floors[0].friction[0], FRICTION_BLOCKED);
    assert.strictEqual(map.floors[6].friction[132 * 225 + 80], 100);
    assert.ok(map.floors[7]);
    assert.ok(map.floors[15]);
    assert.ok(map.stairs.length >= 2);
    assert.strictEqual(map.spawns.length, 761);
    assert.ok(!map.floors[6].subLayers);
    assert.throws(() => runtimeMap(pack, 'v01'), /bounds-only/);
    assert.strictEqual(resolveMapId({}, pack), 'firstlight_isle');

    const clamped = clampSpawn(map, 12, 12, 0);
    assert.strictEqual(clamped.x, 80);
    assert.strictEqual(clamped.y, 132);
    assert.strictEqual(clamped.z, 6);

    const world = makeWorld(pack);
    assert.strictEqual(world.map.id, 'firstlight_isle');
    assert.strictEqual(world.spawnPins.length, 761);
    assert.ok(world.worldPinById.get('harvest_7_62_138'));
    assert.ok(world.worldPinById.get('harvest_7_99_195'));
    assert.strictEqual(world.creatures.size, 0);
    assert.strictEqual(world.tileMap.isWalkable(80, 132, 6), true);
    assert.strictEqual(world.tileMap.isWalkable(75, 132, 6), false);
    assert.strictEqual(world.tileMap.isWalkable(80, 132, 0), false);
    assert.ok(world.tileMap.getLayer(0));
    assert.ok(world.tileMap.getLayer(15));
    assert.strictEqual(world.tileMap.flagsAt(80, 132, 6), 65);

    const session = makeSession(world);
    assert.ok(world.creatures.size > 0);
    assert.ok(world.creatures.size < 50);
    const living = Array.from(world.creatures.values()).map((c) => c.kind);
    assert.ok(living.includes('mountain_troll') || living.includes('deer'));
    assert.ok(living.includes('outfitter_calder'));
    assert.ok(living.includes('quartermaster_hale'));
    const sock = session.socket;
    const ew = decodeEnterWorld(lastOf(sock, S2C.ENTER_WORLD).payload);
    assert.strictEqual(ew.x, 80);
    assert.strictEqual(ew.y, 132);
    assert.strictEqual(ew.z, 6);
    assert.strictEqual(ew.viewport.width, VIEW_W);
    assert.strictEqual(ew.viewport.height, VIEW_H);
    assert.strictEqual(ew.viewport.z, 6);
    const lx = ew.x - ew.viewport.originX;
    const ly = ew.y - ew.viewport.originY;
    assert.strictEqual(ew.viewport.tiles[ly * ew.viewport.width + lx], TILE.SPAWN);

    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.MOVE_STEP, seq: 1, payload: Buffer.from([DIR.N])
    }));
    world.step(1);
    const mv = decodeMove(lastOf(sock, S2C.MOVE).payload);
    assert.strictEqual(mv.x, 80);
    assert.strictEqual(mv.y, 131);
    assert.strictEqual(mv.z, 6);
    const vp = decodeViewport(lastOf(sock, S2C.VIEWPORT).payload);
    assert.strictEqual(vp.z, 6);

    world.leave(session);

    const blocked = makeSession(world, { x: 78, y: 132, z: 6 });
    blocked.socket.sent.length = 0;
    assert.ok(world.enqueueIntent(blocked, {
        opcode: C2S.MOVE_STEP, seq: 1, payload: Buffer.from([DIR.W])
    }));
    world.step(1);
    const rej = decodeReject(lastOf(blocked.socket, S2C.REJECT).payload);
    assert.strictEqual(rej.reason, REASON.BLOCKED);
    assert.strictEqual(blocked.x, 78);
    assert.strictEqual(blocked.z, 6);
    world.leave(blocked);

    const stair = makeSession(world, { x: 81, y: 133, z: 6 });
    stair.socket.sent.length = 0;
    assert.ok(world.enqueueIntent(stair, {
        opcode: C2S.MOVE_STEP, seq: 1, payload: Buffer.from([DIR.S])
    }));
    world.step(1);
    assert.strictEqual(stair.x, 81);
    assert.strictEqual(stair.y, 135);
    assert.strictEqual(stair.z, 7);
    const hopMove = decodeMove(lastOf(stair.socket, S2C.MOVE).payload);
    assert.strictEqual(hopMove.z, 7);
    const hopVp = decodeViewport(lastOf(stair.socket, S2C.VIEWPORT).payload);
    assert.strictEqual(hopVp.z, 7);
    assert.strictEqual(world.tileMap.getOccupant(81, 134, 6), 0);
    assert.strictEqual(world.tileMap.getOccupant(81, 135, 7), stair.id);

    stair.moveReadyTick = 0;
    assert.ok(world.enqueueIntent(stair, {
        opcode: C2S.MOVE_STEP, seq: 2, payload: Buffer.from([DIR.N])
    }));
    world.step(2);
    assert.strictEqual(stair.x, 81);
    assert.strictEqual(stair.y, 135);
    assert.strictEqual(stair.z, 6);
    const backVp = decodeViewport(lastOf(stair.socket, S2C.VIEWPORT).payload);
    assert.strictEqual(backVp.z, 6);

    world.killPlayer(stair, null, 3);
    assert.ok(stair.downed);
    world.step(3);
    assert.ok(stair.downed);
    const delay = Math.max(1, (world.settings.deathDelayTicks | 0) || 40);
    world.step(3 + delay);
    assert.strictEqual(stair.downed, false);
    const town = world.townSpawn();
    assert.strictEqual(stair.x, town.x);
    assert.strictEqual(stair.y, town.y);
    assert.strictEqual(stair.z, town.z);
    world.leave(stair);
    world.stop();

    const village = makeWorld(pack, { mapId: 'village' });
    assert.strictEqual(village.map.id, 'village');
    assert.strictEqual(village.map.width, 24);
    const vt = village.townSpawn();
    assert.strictEqual(vt.x, 12);
    assert.strictEqual(vt.z, 0);
    village.stop();

    const store = new MemoryStore();
    const httpSettings = testSettings();
    delete httpSettings.spawns;
    delete httpSettings.npcs;
    const httpWorld = new World({
        settings: httpSettings,
        store,
        log: createLog(httpSettings),
        pack
    });
    await withHttp(async ({ port }) => {
        const reg = await request(port, {
            method: 'POST',
            path: '/v1/register',
            body: { email: 'p2@example.com', password: 'correct-horse' }
        });
        assert.strictEqual(reg.status, 201);
        const cookie = `sid=${reg.sid}`;
        const ch = await request(port, {
            method: 'POST',
            path: '/v1/characters',
            cookie,
            body: { name: 'Plaza', vocation: 'scout' }
        });
        assert.strictEqual(ch.status, 201);
        assert.strictEqual(ch.json.pos.x, 80);
        assert.strictEqual(ch.json.pos.y, 132);
        assert.strictEqual(ch.json.pos.z, 6);
        const play = await request(port, {
            method: 'POST',
            path: '/v1/play',
            cookie,
            body: { characterId: ch.json.id }
        });
        assert.strictEqual(play.status, 200);
        const c = openWs(port);
        await c.opened;
        await waitFor(() => findOp(c.inbox, S2C.HELLO), 1000);
        c.ws.send(encodeFrame(C2S.ENTER, 1, parseHexToken(play.json.token)));
        await waitFor(() => findOp(c.inbox, S2C.ENTER_WORLD) || c.closed.done, 1500);
        const entered = decodeEnterWorld(findOp(c.inbox, S2C.ENTER_WORLD).payload);
        assert.strictEqual(entered.x, 80);
        assert.strictEqual(entered.y, 132);
        assert.strictEqual(entered.z, 6);
        c.ws.send(encodeFrame(C2S.MOVE_STEP, 2, Buffer.from([DIR.N])));
        await waitFor(() => findOp(c.inbox, S2C.MOVE), 800);
        const live = decodeMove(findOp(c.inbox, S2C.MOVE).payload);
        assert.strictEqual(live.x, 80);
        assert.strictEqual(live.y, 131);
        assert.strictEqual(live.z, 6);
        c.ws.send(encodeFrame(C2S.LOGOUT, 3, Buffer.alloc(0)));
        await waitFor(() => c.closed.done, 800);
    }, { store, world: httpWorld, settings: httpSettings });

    console.log('ok firstlight_map');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

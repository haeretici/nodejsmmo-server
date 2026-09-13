'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C, REASON, DIR } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');
const { decodeReject, decodeEnterWorld, decodeMove, decodeDisappear } = require('../src/protocol/messages');

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

function allOf(sock, opcode) {
    const out = [];
    for (const buf of sock.sent) {
        const f = decodeFrame(buf);
        if (f.opcode === opcode) out.push(f);
    }
    return out;
}

function makeWorld(extra) {
    const settings = testSettings();
    if (extra) Object.assign(settings, extra);
    const store = new MemoryStore();
    const log = createLog(settings);
    const world = new World({
        settings,
        store,
        log,
        schedule: () => 0,
        clear: () => {}
    });
    world.start();
    return { world, settings, store, log };
}

function makeSession(world, ch, pos) {
    const limiter = new RateLimiter();
    const sock = fakeSocket();
    const session = new GameSession({
        socket: sock,
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter,
        log: world.log
    });
    session.bindCharacter(ch, pos || world.spawnPos(ch));
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    return session;
}

function main() {
    const { world } = makeWorld({ stepDelayTicks: 4 });
    const session = makeSession(world, {
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
    });
    const sock = session.socket;

    const ew = decodeEnterWorld(lastOf(sock, S2C.ENTER_WORLD).payload);
    assert.strictEqual(ew.name, 'Ash');
    assert.strictEqual(ew.x, 12);
    assert.strictEqual(world.tileMap.getOccupant(12, 12, 0), 1);

    assert.strictEqual(world.enqueueIntent(session, {
        opcode: C2S.MOVE_STEP,
        seq: 1,
        payload: Buffer.from([DIR.N])
    }), true);
    assert.strictEqual(world.enqueueIntent(session, {
        opcode: C2S.MOVE_STEP,
        seq: 2,
        payload: Buffer.from([DIR.N])
    }), true);
    assert.strictEqual(world.enqueueIntent(session, {
        opcode: 99,
        seq: 3,
        payload: Buffer.alloc(0)
    }), false);
    world.step(1);
    const mv = decodeMove(lastOf(sock, S2C.MOVE).payload);
    assert.strictEqual(mv.id, 1);
    assert.strictEqual(mv.x, 12);
    assert.strictEqual(mv.y, 11);
    assert.strictEqual(session.y, 11);
    assert.strictEqual(world.tileMap.getOccupant(12, 12, 0), 0);
    assert.strictEqual(world.tileMap.getOccupant(12, 11, 0), 1);
    const rejBusy = allOf(sock, S2C.REJECT).map((f) => decodeReject(f.payload));
    assert.ok(rejBusy.some((r) => r.reason === REASON.BUSY));
    assert.ok(rejBusy.some((r) => r.reason === REASON.UNKNOWN_OPCODE));

    assert.strictEqual(world.playerCount(), 1);
    session.kick(REASON.LOGOUT);
    assert.strictEqual(world.playerCount(), 0);
    assert.strictEqual(world.tileMap.getOccupant(12, 11, 0), 0);
    world.stop();

    const w2 = makeWorld({ stepDelayTicks: 1 }).world;
    const wallWalker = makeSession(w2, {
        id: 2, accountId: 2, name: 'Wall', vocation: 'scout',
        level: 1, experience: 0, hp: 185, hpMax: 185, mp: 90, mpMax: 90, townId: 1
    }, { x: 12, y: 1, z: 0 });
    assert.strictEqual(w2.tileMap.getOccupant(12, 1, 0), 2);
    assert.ok(w2.enqueueIntent(wallWalker, {
        opcode: C2S.MOVE_STEP,
        seq: 1,
        payload: Buffer.from([DIR.N])
    }));
    w2.step(1);
    const blocked = decodeReject(lastOf(wallWalker.socket, S2C.REJECT).payload);
    assert.strictEqual(blocked.reason, REASON.BLOCKED);
    assert.strictEqual(wallWalker.y, 1);
    wallWalker.kick(REASON.LOGOUT);
    w2.stop();

    const w3 = makeWorld({ stepDelayTicks: 1, playerTileMaxStack: 10 }).world;
    const ash = makeSession(w3, {
        id: 10, accountId: 10, name: 'Ash', vocation: 'scout',
        level: 1, experience: 0, hp: 185, hpMax: 185, mp: 90, mpMax: 90, townId: 1
    });
    const bo = makeSession(w3, {
        id: 11, accountId: 11, name: 'Bo', vocation: 'guardian',
        level: 1, experience: 0, hp: 185, hpMax: 185, mp: 90, mpMax: 90, townId: 1
    });
    w3.syncAppears(bo);
    assert.deepStrictEqual(w3.tileMap.getCombatants(12, 12, 0), [10, 11]);
    assert.ok(w3.enqueueIntent(ash, {
        opcode: C2S.MOVE_STEP,
        seq: 1,
        payload: Buffer.from([DIR.N])
    }));
    w3.step(1);
    assert.strictEqual(ash.y, 11);
    assert.strictEqual(w3.tileMap.getOccupant(12, 12, 0), 11);
    const boMove = decodeMove(lastOf(bo.socket, S2C.MOVE).payload);
    assert.strictEqual(boMove.id, 10);
    assert.strictEqual(boMove.y, 11);

    for (let i = 0; i < 6; i++) {
        assert.ok(w3.enqueueIntent(ash, {
            opcode: C2S.MOVE_STEP,
            seq: 2 + i,
            payload: Buffer.from([DIR.N])
        }));
        w3.step(2 + i);
    }
    assert.strictEqual(ash.y, 5);
    const disappeared = decodeDisappear(lastOf(bo.socket, S2C.DISAPPEAR).payload);
    assert.strictEqual(disappeared, 10);
    ash.kick(REASON.LOGOUT);
    bo.kick(REASON.LOGOUT);
    w3.stop();

    const w4 = makeWorld({ stepDelayTicks: 1 }).world;
    const cells = w4.map.width * w4.map.height;
    w4.tileMap.addLayer(1, { friction: new Uint8Array(cells).fill(100) });
    w4.tileMap.addStair(
        { x: 13, y: 12, z: 0 },
        { x: 13, y: 12, z: 1 },
        { type: 'ladder', deltaZ: 1 }
    );
    const climb = makeSession(w4, {
        id: 20, accountId: 20, name: 'Climb', vocation: 'scout',
        level: 1, experience: 0, hp: 185, hpMax: 185, mp: 90, mpMax: 90, townId: 1
    }, { x: 13, y: 11, z: 0 });
    assert.ok(w4.enqueueIntent(climb, {
        opcode: C2S.MOVE_STEP, seq: 1, payload: Buffer.from([DIR.S])
    }));
    w4.step(1);
    assert.strictEqual(climb.x, 13);
    assert.strictEqual(climb.y, 12);
    assert.strictEqual(climb.z, 0);
    climb.socket.sent.length = 0;
    assert.ok(w4.enqueueIntent(climb, {
        opcode: C2S.USE_STAIR, seq: 2, payload: Buffer.alloc(0)
    }));
    w4.step(2);
    assert.strictEqual(climb.z, 1);
    const used = decodeMove(lastOf(climb.socket, S2C.MOVE).payload);
    assert.strictEqual(used.z, 1);
    assert.ok(w4.enqueueIntent(climb, {
        opcode: C2S.MOVE_STEP, seq: 3, payload: Buffer.from([DIR.E])
    }));
    w4.step(3);
    assert.strictEqual(climb.z, 1);
    climb.socket.sent.length = 0;
    assert.ok(w4.enqueueIntent(climb, {
        opcode: C2S.USE_STAIR, seq: 4, payload: Buffer.alloc(0)
    }));
    w4.step(4);
    const noPad = decodeReject(lastOf(climb.socket, S2C.REJECT).payload);
    assert.strictEqual(noPad.reason, REASON.NO_TARGET);
    climb.kick(REASON.LOGOUT);
    w4.stop();

    console.log('ok world');
}

main();

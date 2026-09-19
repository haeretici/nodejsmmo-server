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
const { decodeReject, decodeMove, encodeMovePath } = require('../src/protocol/messages');

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
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {}
    });
    world.start();
    return world;
}

function makeSession(world, id) {
    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter({
        id: id || 1,
        accountId: id || 1,
        name: 'Ash',
        vocation: 'scout',
        level: 1,
        experience: 0,
        hp: 185,
        hpMax: 185,
        mp: 90,
        mpMax: 90,
        townId: 1
    }, world.spawnPos({ posX: 12, posY: 12, posZ: 0 }));
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    return session;
}

function main() {
    assert.strictEqual(C2S.MOVE_PATH, 18);
    assert.ok(!Object.prototype.hasOwnProperty.call(C2S, 'SET_AUTO_CHASE'));
    assert.ok(!worldHasOpcode(12));

    const w = makeWorld({ stepDelayTicks: 1 });
    const s = makeSession(w, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(s, 'hotkeys'));
    s.socket.sent.length = 0;
    assert.ok(w.enqueueIntent(s, {
        opcode: C2S.MOVE_PATH,
        seq: 1,
        payload: encodeMovePath([DIR.N, DIR.N, DIR.E])
    }));
    w.step(1);
    assert.strictEqual(s.x, 12);
    assert.strictEqual(s.y, 11);
    assert.deepStrictEqual(s.path, [DIR.N, DIR.E]);
    w.step(2);
    assert.strictEqual(s.y, 10);
    w.step(3);
    assert.strictEqual(s.x, 13);
    assert.strictEqual(s.y, 10);
    assert.deepStrictEqual(s.path, []);
    const moves = allOf(s.socket, S2C.MOVE).map((f) => decodeMove(f.payload));
    assert.strictEqual(moves.length, 3);
    assert.strictEqual(moves[2].x, 13);
    assert.strictEqual(moves[2].y, 10);
    s.kick(REASON.LOGOUT);
    w.stop();

    const wBusy = makeWorld({ stepDelayTicks: 4 });
    const busy = makeSession(wBusy, 2);
    busy.socket.sent.length = 0;
    assert.ok(wBusy.enqueueIntent(busy, {
        opcode: C2S.MOVE_PATH,
        seq: 1,
        payload: encodeMovePath([DIR.N, DIR.N])
    }));
    wBusy.step(1);
    assert.strictEqual(busy.y, 11);
    wBusy.step(2);
    assert.strictEqual(busy.y, 11, 'queued dir waits on moveReadyTick');
    assert.ok(!lastOf(busy.socket, S2C.REJECT), 'MOVE_PATH does not REJECT BUSY');
    wBusy.step(5);
    assert.strictEqual(busy.y, 10);
    busy.kick(REASON.LOGOUT);
    wBusy.stop();

    const wBlock = makeWorld({ stepDelayTicks: 1 });
    const blocked = makeSession(wBlock, 3);
    blocked.x = 12;
    blocked.y = 2;
    wBlock.tileMap.leaveTile(12, 12, 0, blocked);
    assert.ok(wBlock.tileMap.enterTile(12, 2, 0, blocked));
    blocked.socket.sent.length = 0;
    assert.ok(wBlock.enqueueIntent(blocked, {
        opcode: C2S.MOVE_PATH,
        seq: 1,
        payload: encodeMovePath([DIR.N, DIR.N])
    }));
    wBlock.step(1);
    assert.strictEqual(blocked.y, 1);
    wBlock.step(2);
    assert.strictEqual(blocked.y, 1);
    assert.deepStrictEqual(blocked.path, []);
    const rej = decodeReject(lastOf(blocked.socket, S2C.REJECT).payload);
    assert.strictEqual(rej.reason, REASON.BLOCKED);
    blocked.kick(REASON.LOGOUT);
    wBlock.stop();

    const wRep = makeWorld({ stepDelayTicks: 1 });
    const rep = makeSession(wRep, 4);
    assert.ok(wRep.enqueueIntent(rep, {
        opcode: C2S.MOVE_PATH,
        seq: 1,
        payload: encodeMovePath([DIR.N, DIR.N, DIR.N])
    }));
    wRep.step(1);
    assert.strictEqual(rep.y, 11);
    assert.ok(wRep.enqueueIntent(rep, {
        opcode: C2S.MOVE_PATH,
        seq: 2,
        payload: encodeMovePath([DIR.E, DIR.E])
    }));
    wRep.step(2);
    assert.strictEqual(rep.x, 13);
    assert.strictEqual(rep.y, 11);
    wRep.step(3);
    assert.strictEqual(rep.x, 14);
    assert.strictEqual(rep.y, 11);
    rep.kick(REASON.LOGOUT);
    wRep.stop();

    const wKey = makeWorld({ stepDelayTicks: 1 });
    const key = makeSession(wKey, 5);
    assert.ok(wKey.enqueueIntent(key, {
        opcode: C2S.MOVE_PATH,
        seq: 1,
        payload: encodeMovePath([DIR.N, DIR.N, DIR.N])
    }));
    wKey.step(1);
    assert.strictEqual(key.y, 11);
    assert.ok(wKey.enqueueIntent(key, {
        opcode: C2S.MOVE_STEP,
        seq: 2,
        payload: Buffer.from([DIR.E])
    }));
    wKey.step(2);
    assert.strictEqual(key.x, 13);
    assert.strictEqual(key.y, 11);
    assert.deepStrictEqual(key.path, []);
    key.kick(REASON.LOGOUT);
    wKey.stop();

    const wCancel = makeWorld({ stepDelayTicks: 1 });
    const cancel = makeSession(wCancel, 6);
    assert.ok(wCancel.enqueueIntent(cancel, {
        opcode: C2S.MOVE_PATH,
        seq: 1,
        payload: encodeMovePath([DIR.N, DIR.N, DIR.N])
    }));
    wCancel.step(1);
    assert.ok(wCancel.enqueueIntent(cancel, {
        opcode: C2S.MOVE_PATH,
        seq: 2,
        payload: encodeMovePath([])
    }));
    wCancel.step(2);
    assert.strictEqual(cancel.y, 11);
    assert.deepStrictEqual(cancel.path, []);
    wCancel.step(3);
    assert.strictEqual(cancel.y, 11);
    cancel.kick(REASON.LOGOUT);
    wCancel.stop();

    const wCap = makeWorld({ stepDelayTicks: 1, movePathMaxSteps: 2 });
    const cap = makeSession(wCap, 7);
    cap.socket.sent.length = 0;
    assert.ok(wCap.enqueueIntent(cap, {
        opcode: C2S.MOVE_PATH,
        seq: 1,
        payload: encodeMovePath([DIR.N, DIR.N, DIR.N])
    }));
    wCap.step(1);
    assert.strictEqual(cap.y, 12);
    const capRej = decodeReject(lastOf(cap.socket, S2C.REJECT).payload);
    assert.strictEqual(capRej.reason, REASON.BLOCKED);
    cap.kick(REASON.LOGOUT);
    wCap.stop();

    const w12 = makeWorld({ stepDelayTicks: 1 });
    const unused = makeSession(w12, 8);
    unused.socket.sent.length = 0;
    assert.ok(!w12.enqueueIntent(unused, {
        opcode: 12,
        seq: 1,
        payload: Buffer.alloc(0)
    }));
    const unk = decodeReject(lastOf(unused.socket, S2C.REJECT).payload);
    assert.strictEqual(unk.reason, REASON.UNKNOWN_OPCODE);
    unused.kick(REASON.LOGOUT);
    w12.stop();

    console.log('ok move_path');
}

function worldHasOpcode(id) {
    for (const k of Object.keys(C2S)) {
        if (C2S[k] === id) return true;
    }
    return false;
}

main();

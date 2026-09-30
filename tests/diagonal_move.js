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
const {
    decodeReject,
    decodeMove,
    decodeMovePath,
    encodeMovePath
} = require('../src/protocol/messages');
const { computeMoveDelay, delayToTicks } = require('../src/world/movement');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; },
        terminate() { this.readyState = 3; }
    };
}

function lastOf(sock, opcode) {
    for (let i = sock.sent.length - 1; i >= 0; i--) {
        const f = decodeFrame(sock.sent[i]);
        if (f.opcode === opcode) return f;
    }
    return null;
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
        id,
        accountId: id,
        name: 'Ash',
        vocation: 'scout',
        level: 1,
        experience: 0,
        hp: 185,
        hpMax: 185,
        mp: 90,
        mpMax: 90,
        townId: 1
    }, { x: 12, y: 12, z: 0 });
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    session.speed = 110;
    return session;
}

function block(world, x, y) {
    const patched = world.tileMap.applyCellPatch({ x: x, y: y, z: 0, friction: 255 });
    assert.strictEqual(patched.ok, true);
}

function main() {
    assert.strictEqual(DIR.SW, 4);
    assert.strictEqual(DIR.SE, 5);
    assert.strictEqual(DIR.NW, 6);
    assert.strictEqual(DIR.NE, 7);
    assert.strictEqual(computeMoveDelay(100, 110, false), 0.4);
    assert.strictEqual(computeMoveDelay(100, 110, true), 0.8);
    assert.strictEqual(decodeMovePath(Buffer.from([1, 8])), null);
    assert.deepStrictEqual(decodeMovePath(Buffer.from([1, DIR.NE])), [DIR.NE]);

    const ups = 20;
    const cardinalTicks = delayToTicks(0.4, ups);
    const diagonalTicks = delayToTicks(0.8, ups);
    assert.strictEqual(cardinalTicks, 8);
    assert.strictEqual(diagonalTicks, 16);

    const wCard = makeWorld({ fixedStepDelay: false, logicUps: ups });
    const card = makeSession(wCard, 1);
    assert.strictEqual(wCard.tileMap.frictionAt(12, 11, 0), 100);
    card.socket.sent.length = 0;
    assert.ok(wCard.enqueueIntent(card, {
        opcode: C2S.MOVE_STEP,
        seq: 1,
        payload: Buffer.from([DIR.N])
    }));
    wCard.step(1);
    assert.strictEqual(card.x, 12);
    assert.strictEqual(card.y, 11);
    assert.strictEqual(card.moveReadyTick, 1 + cardinalTicks);
    card.kick(REASON.LOGOUT);
    wCard.stop();

    const wDiag = makeWorld({ fixedStepDelay: false, logicUps: ups });
    const diag = makeSession(wDiag, 2);
    assert.strictEqual(wDiag.tileMap.frictionAt(13, 11, 0), 100);
    diag.socket.sent.length = 0;
    assert.ok(wDiag.enqueueIntent(diag, {
        opcode: C2S.MOVE_STEP,
        seq: 1,
        payload: Buffer.from([DIR.NE])
    }));
    wDiag.step(1);
    const moved = decodeMove(lastOf(diag.socket, S2C.MOVE).payload);
    assert.strictEqual(moved.x, 13);
    assert.strictEqual(moved.y, 11);
    assert.strictEqual(moved.dir, DIR.NE);
    assert.strictEqual(diag.moveReadyTick, 1 + diagonalTicks);
    diag.socket.sent.length = 0;
    assert.ok(wDiag.enqueueIntent(diag, {
        opcode: C2S.MOVE_STEP,
        seq: 2,
        payload: Buffer.from([DIR.NE])
    }));
    wDiag.step(2);
    const early = decodeReject(lastOf(diag.socket, S2C.REJECT).payload);
    assert.strictEqual(early.reason, REASON.BUSY);
    assert.strictEqual(diag.x, 13);
    assert.strictEqual(diag.y, 11);
    diag.kick(REASON.LOGOUT);
    wDiag.stop();

    const wPath = makeWorld({ stepDelayTicks: 1 });
    const path = makeSession(wPath, 3);
    path.socket.sent.length = 0;
    assert.ok(wPath.enqueueIntent(path, {
        opcode: C2S.MOVE_PATH,
        seq: 1,
        payload: encodeMovePath([DIR.NW])
    }));
    wPath.step(1);
    assert.strictEqual(path.x, 11);
    assert.strictEqual(path.y, 11);
    assert.strictEqual(decodeMove(lastOf(path.socket, S2C.MOVE).payload).dir, DIR.NW);
    path.kick(REASON.LOGOUT);
    wPath.stop();

    const wOpen = makeWorld({ stepDelayTicks: 1 });
    const open = makeSession(wOpen, 4);
    block(wOpen, 13, 12);
    open.socket.sent.length = 0;
    assert.ok(wOpen.enqueueIntent(open, {
        opcode: C2S.MOVE_STEP,
        seq: 1,
        payload: Buffer.from([DIR.NE])
    }));
    wOpen.step(1);
    assert.strictEqual(open.x, 13);
    assert.strictEqual(open.y, 11, 'one open side still allows the diagonal');
    open.kick(REASON.LOGOUT);
    wOpen.stop();

    const wShut = makeWorld({ stepDelayTicks: 1 });
    const shut = makeSession(wShut, 5);
    block(wShut, 13, 12);
    block(wShut, 12, 11);
    shut.socket.sent.length = 0;
    assert.ok(wShut.enqueueIntent(shut, {
        opcode: C2S.MOVE_STEP,
        seq: 1,
        payload: Buffer.from([DIR.NE])
    }));
    wShut.step(1);
    const denied = decodeReject(lastOf(shut.socket, S2C.REJECT).payload);
    assert.strictEqual(denied.reason, REASON.BLOCKED);
    assert.strictEqual(shut.x, 12);
    assert.strictEqual(shut.y, 12);
    shut.kick(REASON.LOGOUT);
    wShut.stop();

    console.log('ok diagonal_move');
}

main();

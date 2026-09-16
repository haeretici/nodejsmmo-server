'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { REASON } = require('../src/protocol/opcodes');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function ash() {
    return {
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
}

function makeWorld() {
    const settings = testSettings();
    delete settings.spawns;
    delete settings.npcs;
    settings.spawnActivateMargin = 0;
    settings.spawnDespawnIdleTicks = 2;
    settings.spawnDespawnHomeDist = 0;
    settings.logicUps = 20;
    const n = 32 * 32;
    const map = {
        width: 32,
        height: 32,
        z: 0,
        zMin: 0,
        zMax: 0,
        spawnX: 10,
        spawnY: 10,
        spawnZ: 0,
        floors: { 0: { friction: new Uint8Array(n).fill(100) } },
        stairs: [],
        spawns: [{ kind: 'rat', x: 12, y: 10, z: 0, respawn: 10 }],
        npcs: []
    };
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        map,
        schedule: () => 0,
        clear: () => {}
    });
    world.start();
    return world;
}

function makeSession(world, pos) {
    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter(ash(), pos || { x: 10, y: 10, z: 0 });
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    world.syncAppears(session);
    return session;
}

function testIdleParkKeepsRemainingHp() {
    const world = makeWorld();
    const session = makeSession(world, { x: 12, y: 10, z: 0 });
    const pin = world.spawnPins[0];
    assert.strictEqual(pin.state, 'living');
    const rat = world.creatures.get(pin.entityId);
    const maxHp = rat.hpMax | 0;
    assert.ok(maxHp >= 10);
    world.applyHp(rat, 10);
    assert.strictEqual(rat.hp, 10);

    world.leave(session);
    world.step(1);
    world.step(2);
    assert.strictEqual(pin.state, 'idle', 'idle AOI parks after hysteresis');
    assert.ok(pin.parkedEntity, 'parked body kept');
    assert.strictEqual(pin.parkedEntity.hp, 10, 'park stores remaining HP');
    assert.strictEqual(world.creatures.size, 0);

    const session2 = makeSession(world, { x: 12, y: 10, z: 0 });
    assert.strictEqual(pin.state, 'living');
    const again = world.creatures.get(pin.entityId);
    assert.strictEqual(again, pin.parkedEntity || again);
    assert.strictEqual(again.hp, 10, 're-entry restores parked HP, not full');
    assert.notStrictEqual(again.hp, maxHp);

    session2.kick(REASON.LOGOUT);
    world.stop();
}

function main() {
    testIdleParkKeepsRemainingHp();
    console.log('ok phase7_park_hp');
}

main();

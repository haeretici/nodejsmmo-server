'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { REASON } = require('../src/protocol/opcodes');
const { spawnDespawnHomeDist, DEFAULT_DESPAWN_HOME_DIST } = require('../src/world/spawn_pins');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function ash(id) {
    return {
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
    };
}

function openMap() {
    const n = 64 * 64;
    return {
        width: 64,
        height: 64,
        z: 0,
        zMin: 0,
        zMax: 0,
        spawnX: 10,
        spawnY: 10,
        spawnZ: 0,
        floors: { 0: { friction: new Uint8Array(n).fill(100) } },
        stairs: [],
        spawns: [
            { kind: 'rat', x: 12, y: 10, z: 0, respawn: 10 }
        ],
        npcs: []
    };
}

function makeWorld(extra) {
    const settings = testSettings();
    delete settings.spawns;
    delete settings.npcs;
    settings.spawnActivateMargin = 8;
    settings.spawnDespawnIdleTicks = 100;
    settings.logicUps = 20;
    if (extra) Object.assign(settings, extra);
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        map: openMap(),
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
    session.bindCharacter(ash(1), pos || { x: 10, y: 10, z: 0 });
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    world.syncAppears(session);
    return session;
}

function testHomeDistDefault() {
    assert.strictEqual(DEFAULT_DESPAWN_HOME_DIST, 20);
    assert.strictEqual(spawnDespawnHomeDist({}), 20);
    assert.strictEqual(spawnDespawnHomeDist({ spawnDespawnHomeDist: 0 }), 0);
    assert.strictEqual(spawnDespawnHomeDist({ spawnDespawnHomeDist: 8 }), 8);
}

function testHomeDistanceUnloadsAndCooldowns() {
    const world = makeWorld();
    const session = makeSession(world);
    assert.strictEqual(world.creatures.size, 1);
    const pin = world.spawnPins[0];
    assert.strictEqual(pin.state, 'living');
    const rat = world.creatures.get(pin.entityId);
    assert.ok(rat);
    assert.ok(world.tileMap.moveEntityToTile(12 + 21, 10, 0, rat));
    assert.strictEqual(rat.x, 33);

    world.step(2);
    assert.strictEqual(world.creatures.size, 0, 'leash wanderer past home dist is unloaded');
    assert.strictEqual(pin.state, 'cooldown');
    assert.ok(pin.readyTick > 2, 'home unload waits respawn, not immediate re-entry');
    assert.strictEqual(world.livingPins.size, 0);
    assert.strictEqual(pin.parkedEntity, null, 'home unload destroys, does not park');

    session.kick(REASON.LOGOUT);
    world.stop();
}

function testHomeDistanceZeroDisabled() {
    const world = makeWorld({ spawnDespawnHomeDist: 0 });
    const session = makeSession(world);
    const pin = world.spawnPins[0];
    const rat = world.creatures.get(pin.entityId);
    assert.ok(world.tileMap.moveEntityToTile(40, 10, 0, rat));
    world.step(2);
    assert.strictEqual(pin.state, 'living', 'home dist 0 does not unload');
    assert.strictEqual(world.creatures.size, 1);
    session.kick(REASON.LOGOUT);
    world.stop();
}

function main() {
    testHomeDistDefault();
    testHomeDistanceUnloadsAndCooldowns();
    testHomeDistanceZeroDisabled();
    console.log('ok phase7_home_distance');
}

main();

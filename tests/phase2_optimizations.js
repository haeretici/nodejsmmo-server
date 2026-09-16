'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { createCreature } = require('../src/world/creature');
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

function multiFloorMap(cols, rows) {
    const n = cols * rows;
    return {
        width: cols,
        height: rows,
        z: 0,
        zMin: 0,
        zMax: 1,
        spawnX: 0,
        spawnY: 0,
        spawnZ: 0,
        floors: {
            0: { friction: new Uint8Array(n).fill(100) },
            1: { friction: new Uint8Array(n).fill(100) }
        },
        stairs: [],
        spawns: [],
        npcs: []
    };
}

function makeWorld(extra, map) {
    const settings = testSettings();
    settings.aiCreatureSleep = true;
    settings.aiTickRadius = 12;
    settings.aiRepathIntervalSec = 2;
    if (extra) Object.assign(settings, extra);
    const store = new MemoryStore();
    const log = createLog(settings);
    const world = new World({
        settings,
        store,
        log,
        schedule: () => 0,
        clear: () => {},
        rng: () => 0.5,
        map: map || (extra && extra.map)
    });
    world.start();
    return world;
}

function makeSession(world, ch, pos) {
    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter(ch, pos || world.spawnPos(ch));
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    world.syncAppears(session);
    return session;
}

function ash(id, overrides) {
    return Object.assign({
        id,
        accountId: id,
        name: 'Ash_' + id,
        vocation: 'guardian',
        level: 10,
        experience: 0,
        hp: 185,
        hpMax: 185,
        mp: 90,
        mpMax: 90,
        townId: 1
    }, overrides);
}

function testCreatureInitialization() {
    const template = {
        id: 'rat',
        label: 'Rat',
        hp: 20,
        hpMax: 20,
        armor: 1,
        mitigation: 0,
        speed: 100
    };
    const c = createCreature(1001, template, { x: 5, y: 5, z: 0 });
    assert.strictEqual(c.simSleeping, false, 'creature initializes with simSleeping = false');
}

function testDormancyWhenNoPlayers() {
    const world = makeWorld();
    const rat = world.spawnCreature('rat', 10, 10, 0);
    assert.ok(rat);
    assert.strictEqual(rat.simSleeping, false);

    // After a tick with no players, rat should become simSleeping
    world.step(1);
    assert.strictEqual(rat.simSleeping, true, 'creature goes to sleep when no players exist');

    // Move rat away from its spawn tile to verify tickCreature skips return pathfinding
    rat.x = 15;
    rat.y = 15;
    world.step(2);
    assert.strictEqual(rat.simSleeping, true);
    assert.strictEqual(rat.x, 15, 'sleeping creature does not pathfind toward spawn');
    assert.strictEqual(rat.y, 15);

    world.stop();
}

function testWakeOnProximityAndStaggerRepath() {
    const world = makeWorld();
    const rat = world.spawnCreature('rat', 10, 10, 0);
    world.step(1);
    assert.strictEqual(rat.simSleeping, true);

    const oldRepath = rat._repathNextAt;

    // Place a player at distance 5 (<= 12) on same floor
    const session = makeSession(world, ash(1), { x: 15, y: 10, z: 0 });
    world.step(2);

    assert.strictEqual(rat.simSleeping, false, 'creature wakes up when player is within radius');
    assert.notStrictEqual(rat._repathNextAt, oldRepath, 'repath interval re-seeded on wake');

    session.kick(REASON.LOGOUT);
    world.stop();
}

function testSleepWhenPlayerMovesAway() {
    const world = makeWorld();
    const rat = world.spawnCreature('rat', 2, 2, 0);
    const session = makeSession(world, ash(2), { x: 4, y: 2, z: 0 });

    world.step(1);
    assert.strictEqual(rat.simSleeping, false, 'creature awake near player');

    // Move player far away (> 12 tiles Chebyshev)
    world.tileMap.moveEntityToTile(session, 20, 20, 0);
    session.x = 20;
    session.y = 20;

    // Lose target, leash home if pulled off spawn, then sleep
    let slept = false;
    for (let t = 2; t <= 40; t++) {
        world.step(t);
        if (rat.simSleeping) {
            slept = true;
            break;
        }
    }
    assert.ok(slept, 'creature goes to sleep when player moves away');
    assert.strictEqual(rat.x, rat.spawnX);
    assert.strictEqual(rat.y, rat.spawnY);

    session.kick(REASON.LOGOUT);
    world.stop();
}

function testFloorIsolation() {
    const world = makeWorld(null, multiFloorMap(30, 30));
    const rat = world.spawnCreature('rat', 10, 10, 0);

    // Player at same (x, y) but on z = 1
    const session = makeSession(world, ash(3), { x: 10, y: 10, z: 1 });

    world.step(1);
    assert.strictEqual(rat.simSleeping, true, 'creature remains asleep when player is on different z-level');

    session.kick(REASON.LOGOUT);
    world.stop();
}

function testCombatExemption() {
    const world = makeWorld();
    const rat = world.spawnCreature('rat', 2, 2, 0);
    const session = makeSession(world, ash(4), { x: 20, y: 20, z: 0 });

    // Far away, ordinarily would sleep
    world.step(1);
    assert.strictEqual(rat.simSleeping, true);

    // Exemption 1: Creature has active targetId
    rat.targetId = session.character.id;
    world.step(2);
    assert.strictEqual(rat.simSleeping, false, 'creature with targetId is never asleep');
    rat.targetId = 0;

    // Exemption 2: Player has creature targeted
    session.targetId = rat.id;
    world.step(3);
    assert.strictEqual(rat.simSleeping, false, 'creature targeted by player is never asleep');
    session.targetId = 0;

    world.step(4);
    assert.strictEqual(rat.simSleeping, true);

    // Exemption 3: Wakes on damage
    world.applyDamage(rat, 5, 'physical', 5, session);
    assert.strictEqual(rat.simSleeping, false, 'creature wakes up immediately upon taking damage');

    session.kick(REASON.LOGOUT);
    world.stop();
}

function testConditionsSkippedWhileSleeping() {
    const world = makeWorld();
    const rat = world.spawnCreature('rat', 10, 10, 0);
    rat.conditions = [
        { type: 'poison', tickIntervalSec: 1, durationSec: 10, damage: 2, _elapsed: 0 }
    ];

    world.step(1);
    // Under P12 Step 2, active conditions keep creature awake so DoTs tick to completion
    assert.strictEqual(rat.simSleeping, false, 'active conditions keep creature awake');
    assert.strictEqual(world.activeCreatures.has(rat), true, 'creature with active conditions is in active set');

    // For an entity sleeping without conditions, it remains sleeping and not in activeCreatures
    const sleepingMob = world.spawnCreature('rat', 10, 10, 0);
    world.sleepCreature(sleepingMob);
    assert.strictEqual(sleepingMob.simSleeping, true);
    assert.strictEqual(world.activeCreatures.has(sleepingMob), false);

    world.stop();
}

function testCreatureSleepDisabledSetting() {
    const world = makeWorld({ aiCreatureSleep: false });
    const rat = world.spawnCreature('rat', 10, 10, 0);

    world.step(1);
    assert.strictEqual(rat.simSleeping, false, 'creatures stay awake when aiCreatureSleep = false');

    rat.simSleeping = true;
    world.step(2);
    assert.strictEqual(rat.simSleeping, false, 'disabled sleep wakes up any sleeping creatures');

    world.stop();
}

function main() {
    testCreatureInitialization();
    testDormancyWhenNoPlayers();
    testWakeOnProximityAndStaggerRepath();
    testSleepWhenPlayerMovesAway();
    testFloorIsolation();
    testCombatExemption();
    testConditionsSkippedWhileSleeping();
    testCreatureSleepDisabledSetting();
    console.log('ok phase2_optimizations');
}

main();

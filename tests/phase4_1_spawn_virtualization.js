'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { TEMPLATES } = require('../src/world/templates');
const { S2C } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');
const {
    DEFAULT_MAX_LIVING,
    spawnMaxLiving,
    minChebyshevToObservers,
    livingPinKeepPriority,
    makePinState
} = require('../src/world/spawn_pins');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function ash(id, x, y, z) {
    return {
        id: id || 1,
        accountId: id || 1,
        name: 'Ash_' + (id || 1),
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

function makeSession(world, id, pos) {
    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter(ash(id), pos || { x: 12, y: 12, z: 0 });
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    world.syncAppears(session);
    return session;
}

function testSpawnVirtualizationPriorityFormulas() {
    assert.strictEqual(DEFAULT_MAX_LIVING, 3000);
    assert.strictEqual(spawnMaxLiving({}), 3000);
    assert.strictEqual(spawnMaxLiving({ spawnMaxLiving: 500 }), 500);
    assert.strictEqual(spawnMaxLiving({ maxLiving: 250 }), 250);

    const observers = [
        { x: 10, y: 10, z: 0, dead: false, downed: false },
        { x: 50, y: 50, z: 0, dead: false, downed: false },
        { x: 10, y: 10, z: 1, dead: false, downed: false } // floor 1
    ];

    // minChebyshevToObservers: same floor only
    assert.strictEqual(minChebyshevToObservers(12, 10, 0, observers), 2);
    assert.strictEqual(minChebyshevToObservers(10, 10, 1, observers), 0);
    assert.strictEqual(minChebyshevToObservers(10, 10, 2, observers), Infinity);

    // livingPinKeepPriority
    // Eager pin is protected
    const eagerPin = { eager: true, x: 10, y: 10, z: 0 };
    assert.strictEqual(livingPinKeepPriority(eagerPin, null, observers), 1e12);

    // Dead creature -> -1
    const deadPin = { eager: false, x: 10, y: 10, z: 0 };
    const deadCreature = { hp: 0, x: 10, y: 10, z: 0 };
    assert.strictEqual(livingPinKeepPriority(deadPin, deadCreature, observers), -1);

    // Creature in combat (targetId set) -> protected 1e12
    const combatCreature = { hp: 50, targetId: 1, x: 10, y: 10, z: 0 };
    assert.strictEqual(livingPinKeepPriority(deadPin, combatCreature, observers), 1e12);

    // NPC (dialog set) -> protected 1e12
    const npcCreature = { hp: 50, dialog: 'welcome', x: 10, y: 10, z: 0 };
    assert.strictEqual(livingPinKeepPriority(deadPin, npcCreature, observers), 1e12);

    // Regular creature near observer (distance 2): 2000 - 40 + 50 = 2010
    const nearCreature = { hp: 50, x: 12, y: 10, z: 0 };
    const regularPin = { eager: false, x: 12, y: 10, z: 0 };
    const nearPri = livingPinKeepPriority(regularPin, nearCreature, observers);
    assert.strictEqual(nearPri, 2000 - 2 * 20 + 50);

    // Boss creature gets +10000 rarity bonus
    const bossPri = livingPinKeepPriority(regularPin, nearCreature, observers, { rarity: 'boss' });
    assert.strictEqual(bossPri, nearPri + 10000);

    // Creature on floor with no observers -> priority 0
    const noObsCreature = { hp: 50, x: 12, y: 10, z: 5 };
    const noObsPin = { eager: false, x: 12, y: 10, z: 5 };
    assert.strictEqual(livingPinKeepPriority(noObsPin, noObsCreature, observers), 0);
}

function testSoftCapBudgetEviction() {
    const settings = testSettings();
    delete settings.spawns;
    delete settings.npcs;
    settings.spawnActivateMargin = 0;
    settings.spawnDespawnIdleTicks = 100; // Do not idle-despawn during test
    settings.logicUps = 20;
    settings.spawnMaxLiving = 2; // Hard ceiling of 2 living mobs!

    const map = {
        width: 128,
        height: 128,
        z: 0,
        zMin: 0,
        zMax: 0,
        spawnX: 10,
        spawnY: 10,
        spawnZ: 0,
        floors: {
            0: { friction: new Uint8Array(128 * 128).fill(100) }
        },
        stairs: [],
        spawns: [
            { kind: 'rat', x: 11, y: 10, z: 0, respawn: 10 }, // pin 0: dist 1 from (10, 10)
            { kind: 'rat', x: 12, y: 10, z: 0, respawn: 10 }, // pin 1: dist 2 from (10, 10)
            { kind: 'rat', x: 15, y: 10, z: 0, respawn: 10 }, // pin 2: dist 5 from (10, 10)
            { kind: 'rat', x: 16, y: 10, z: 0, respawn: 10 }  // pin 3: dist 6 from (10, 10)
        ],
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

    assert.strictEqual(world.spawnPins.length, 4);
    assert.strictEqual(world.creatures.size, 0);

    // Player 1 arrives at (10, 10)
    // All 4 pins are in view, but maxLiving = 2
    // Pins at (11, 10) and (12, 10) are closest -> should activate
    // Pins at (15, 10) and (16, 10) remain idle due to budget cap!
    const s1 = makeSession(world, 1, { x: 10, y: 10, z: 0 });

    assert.strictEqual(world.creatures.size, 2, 'Capped at maxLiving = 2');
    assert.strictEqual(world.livingPins.size, 2);
    assert.strictEqual(world.spawnPins[0].state, 'living');
    assert.strictEqual(world.spawnPins[1].state, 'living');
    assert.strictEqual(world.spawnPins[2].state, 'idle');
    assert.strictEqual(world.spawnPins[3].state, 'idle');

    // Now Player 2 arrives at (17, 10)
    // Pin 3 at (16, 10) is dist 1 from Player 2 (high priority).
    // Pin 2 at (15, 10) is dist 2 from Player 2 (high priority).
    // Farthest unengaged idle mobs from observers are pin 0 and pin 1.
    // They should be evicted to make room for the mobs next to Player 2!
    const s2 = makeSession(world, 2, { x: 17, y: 10, z: 0 });

    assert.strictEqual(world.creatures.size, 2, 'Still strictly capped at maxLiving = 2');
    assert.strictEqual(world.livingPins.size, 2);

    // Pin 1 (at 12, 10, dist 2 from P1) has lower priority than Pin 0 (at 11, 10, dist 1 from P1).
    // So Pin 1 is evicted to make room for Pin 3 (at 16, 10, dist 1 from P2).
    assert.strictEqual(world.spawnPins[1].state, 'idle');
    assert.strictEqual(world.spawnPins[1].readyTick, 0);

    // Pin 0 (closer to P1) and Pin 3 (closer to P2) are living
    assert.strictEqual(world.spawnPins[0].state, 'living');
    assert.strictEqual(world.spawnPins[3].state, 'living');
    assert.strictEqual(world.spawnPins[2].state, 'idle');

    world.leave(s1);
    world.leave(s2);
    world.stop();
}

function testCombatProtectsFromBudgetEviction() {
    const settings = testSettings();
    delete settings.spawns;
    delete settings.npcs;
    settings.spawnActivateMargin = 0;
    settings.spawnDespawnIdleTicks = 100;
    settings.logicUps = 20;
    settings.spawnMaxLiving = 1; // Hard ceiling of 1 mob!

    const map = {
        width: 128,
        height: 128,
        z: 0,
        zMin: 0,
        zMax: 0,
        spawnX: 10,
        spawnY: 10,
        spawnZ: 0,
        floors: {
            0: { friction: new Uint8Array(128 * 128).fill(100) }
        },
        stairs: [],
        spawns: [
            { kind: 'rat', x: 11, y: 10, z: 0, respawn: 10 },
            { kind: 'rat', x: 50, y: 50, z: 0, respawn: 10 }
        ],
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

    // Spawn pin 0 next to player 1
    const s1 = makeSession(world, 1, { x: 10, y: 10, z: 0 });
    assert.strictEqual(world.creatures.size, 1);
    const rat1 = Array.from(world.creatures.values())[0];

    // Player 1 engages rat1 in combat
    s1.targetId = rat1.id;
    assert.strictEqual(world.isCreatureInCombat(rat1), true);

    // Player 2 appears at (50, 50) next to pin 1
    // Even though pin 1 has high priority relative to player 2,
    // rat1 is IN COMBAT and must NEVER be evicted!
    const s2 = makeSession(world, 2, { x: 50, y: 50, z: 0 });
    assert.strictEqual(world.creatures.size, 1);
    assert.strictEqual(world.spawnPins[0].state, 'living');
    assert.strictEqual(world.spawnPins[1].state, 'idle', 'Cannot evict combat mob');

    world.leave(s1);
    world.leave(s2);
    world.stop();
}

function testExcessPopulationPruning() {
    const settings = testSettings();
    delete settings.spawns;
    delete settings.npcs;
    settings.spawnActivateMargin = 0;
    settings.spawnDespawnIdleTicks = 100;
    settings.logicUps = 20;
    settings.spawnMaxLiving = 10; // Initially high

    const map = {
        width: 128,
        height: 128,
        z: 0,
        zMin: 0,
        zMax: 0,
        spawnX: 10,
        spawnY: 10,
        spawnZ: 0,
        floors: {
            0: { friction: new Uint8Array(128 * 128).fill(100) }
        },
        stairs: [],
        spawns: [
            { kind: 'rat', x: 11, y: 10, z: 0, respawn: 10 },
            { kind: 'rat', x: 12, y: 10, z: 0, respawn: 10 },
            { kind: 'rat', x: 13, y: 10, z: 0, respawn: 10 },
            { kind: 'rat', x: 14, y: 10, z: 0, respawn: 10 }
        ],
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

    const s1 = makeSession(world, 1, { x: 10, y: 10, z: 0 });
    assert.strictEqual(world.creatures.size, 4);

    // Suddenly settings reduce spawnMaxLiving to 2
    world.settings.spawnMaxLiving = 2;

    // Next tick prunes excess 2 farthest idle mobs down to 2
    world.step(1);
    assert.strictEqual(world.creatures.size, 2);
    assert.strictEqual(world.livingPins.size, 2);

    // The nearest 2 pins (at 11, 10 and 12, 10) remain living
    assert.strictEqual(world.spawnPins[0].state, 'living');
    assert.strictEqual(world.spawnPins[1].state, 'living');
    assert.strictEqual(world.spawnPins[2].state, 'idle');
    assert.strictEqual(world.spawnPins[3].state, 'idle');

    world.leave(s1);
    world.stop();
}

function main() {
    testSpawnVirtualizationPriorityFormulas();
    testSoftCapBudgetEviction();
    testCombatProtectsFromBudgetEviction();
    testExcessPopulationPruning();
    console.log('ok phase4_1_spawn_virtualization');
}

main();

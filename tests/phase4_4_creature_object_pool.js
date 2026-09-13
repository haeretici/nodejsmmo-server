'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { Creature, CreaturePool, createCreature } = require('../src/world/creature');
const { TEMPLATES } = require('../src/world/templates');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function openMap(cols, rows) {
    const n = cols * rows;
    return {
        width: cols,
        height: rows,
        z: 0,
        zMin: 0,
        zMax: 0,
        spawnX: 0,
        spawnY: 0,
        spawnZ: 0,
        floors: {
            0: { friction: new Uint8Array(n).fill(100) }
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
        map: map || (extra && extra.map) || openMap(128, 128)
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

function testCreatureClassInitAndReset() {
    const template = TEMPLATES.rat;
    assert.ok(template, 'template rat exists');

    const c = new Creature();
    assert.strictEqual(c.hp, 0);
    assert.strictEqual(c.targetId, 0);
    assert.strictEqual(c._pooled, true);

    c.init(1001, template, { x: 15, y: 20, z: 0 });
    assert.strictEqual(c.id, 1001);
    assert.strictEqual(c.kind, 'rat');
    assert.strictEqual(c.name, template.label);
    assert.strictEqual(c.x, 15);
    assert.strictEqual(c.y, 20);
    assert.strictEqual(c.z, 0);
    assert.strictEqual(c.hp, template.hp);
    assert.strictEqual(c.hpMax, template.hpMax);
    assert.strictEqual(c.targetId, 0);
    assert.strictEqual(c._pooled, false);

    // Mutate state during simulated life
    c.hp = 5;
    c.targetId = 99;
    c.path.push({ x: 16, y: 20, dir: 1 });
    c.simSleeping = true;
    c._repathNextAt = 123.45;
    c.pinIndex = 42;

    // Reset for pooling
    c.reset();
    assert.strictEqual(c.hp, 0);
    assert.strictEqual(c.hpMax, 0);
    assert.strictEqual(c.targetId, 0);
    assert.strictEqual(c.path.length, 0);
    assert.strictEqual(c.simSleeping, false);
    assert.strictEqual(c._repathNextAt, 0);
    assert.strictEqual(c.pinIndex, null);
    assert.strictEqual(c._pooled, true);
    // Entity ID is preserved on reset so post-mortem references don't crash
    assert.strictEqual(c.id, 1001);

    // Re-init with new ID and template
    c.init(1002, template, { x: 30, y: 40, z: 0 });
    assert.strictEqual(c.id, 1002);
    assert.strictEqual(c.x, 30);
    assert.strictEqual(c.y, 40);
    assert.strictEqual(c.hp, template.hp);
    assert.strictEqual(c._pooled, false);
}

function testCreaturePoolBasicOperations() {
    const pool = new CreaturePool(16);
    assert.strictEqual(pool.size, 0);
    assert.strictEqual(pool.capacity, 16);
    assert.strictEqual(pool.totalCreated, 0);
    assert.strictEqual(pool.totalObtained, 0);
    assert.strictEqual(pool.totalReleased, 0);

    const template = TEMPLATES.rat;
    const c1 = pool.obtain(2001, template, { x: 10, y: 10, z: 0 });
    assert.ok(c1 instanceof Creature);
    assert.strictEqual(c1.id, 2001);
    assert.strictEqual(pool.size, 0);
    assert.strictEqual(pool.totalCreated, 1);
    assert.strictEqual(pool.totalObtained, 1);

    // Release back to pool
    const released = pool.release(c1);
    assert.strictEqual(released, true);
    assert.strictEqual(pool.size, 1);
    assert.strictEqual(pool.totalReleased, 1);
    assert.strictEqual(c1._pooled, true);

    // Double-release guard: releasing again should be rejected and not duplicate in pool
    const doubleReleased = pool.release(c1);
    assert.strictEqual(doubleReleased, false);
    assert.strictEqual(pool.size, 1);

    // Obtain again: must recycle the exact same object reference
    const c2 = pool.obtain(2002, template, { x: 20, y: 20, z: 0 });
    assert.strictEqual(c2, c1, 'obtained creature reuses previous object instance');
    assert.strictEqual(c2.id, 2002);
    assert.strictEqual(c2.x, 20);
    assert.strictEqual(c2.y, 20);
    assert.strictEqual(pool.size, 0);
    assert.strictEqual(pool.totalCreated, 1, 'no new Creature allocated on recycle');
    assert.strictEqual(pool.totalObtained, 2);
}

function testCreaturePoolCapacityAndPreallocate() {
    const pool = new CreaturePool(4);
    assert.strictEqual(pool.capacity, 4);

    pool.preallocate(3);
    assert.strictEqual(pool.size, 3);
    assert.strictEqual(pool.totalCreated, 3);

    // Preallocate beyond capacity caps at capacity
    pool.preallocate(10);
    assert.strictEqual(pool.size, 4);
    assert.strictEqual(pool.totalCreated, 4);

    // Obtain all 4
    const list = [];
    for (let i = 0; i < 4; i++) {
        list.push(pool.obtain(3000 + i, TEMPLATES.rat, { x: i, y: i, z: 0 }));
    }
    assert.strictEqual(pool.size, 0);
    assert.strictEqual(pool.totalCreated, 4);

    // Obtain a 5th: creates a new one exceeding initial preallocation
    const c5 = pool.obtain(3005, TEMPLATES.rat, { x: 5, y: 5, z: 0 });
    assert.strictEqual(pool.totalCreated, 5);

    // Release all 5: first 4 accepted, 5th dropped because pool is full
    for (let i = 0; i < 4; i++) {
        assert.strictEqual(pool.release(list[i]), true);
    }
    assert.strictEqual(pool.size, 4);
    assert.strictEqual(pool.release(c5), false, 'drop release when pool at capacity');
    assert.strictEqual(pool.size, 4);

    pool.clear();
    assert.strictEqual(pool.size, 0);
}

function testZeroAllocationChurnCycle() {
    const pool = new CreaturePool(100);
    const template = TEMPLATES.rat;

    // Cycle 10,000 mob activations and despawns sequentially
    for (let i = 0; i < 10000; i++) {
        const mob = pool.obtain(4000 + i, template, { x: i % 100, y: (i * 2) % 100, z: 0 });
        mob.hp = (i % 20) + 1;
        mob.path.push({ x: 1, y: 1, dir: 0 });
        pool.release(mob);
    }

    assert.strictEqual(pool.totalCreated, 1, 'Only exactly 1 Creature was ever allocated for 10,000 churn cycles');
    assert.strictEqual(pool.totalObtained, 10000);
    assert.strictEqual(pool.totalReleased, 10000);
    assert.strictEqual(pool.size, 1);
}

function testWorldSpawnAndKillRecycling() {
    const world = makeWorld();
    assert.ok(world.creaturePool instanceof CreaturePool);
    assert.strictEqual(world.creaturePool.size, 0);

    const snap1 = world.snapshot();
    assert.strictEqual(snap1.creaturePool, 0);

    // 1. Spawn a mob in world
    const mob1 = world.spawnCreature('rat', 10, 10, 0);
    assert.ok(mob1 instanceof Creature);
    assert.strictEqual(world.creaturePool.totalCreated, 1);
    assert.strictEqual(world.creaturePool.totalObtained, 1);
    assert.strictEqual(world.creatures.size, 1);

    // 2. Kill the mob -> released back to creaturePool
    world.kill(mob1, null, 1);
    assert.strictEqual(world.creatures.size, 0);
    assert.strictEqual(world.creaturePool.size, 1, 'creature returned to pool upon death');
    assert.strictEqual(world.creaturePool.totalReleased, 1);

    const snap2 = world.snapshot();
    assert.strictEqual(snap2.creaturePool, 1);

    // 3. Spawn another mob -> reuses pooled mob1 object
    const mob2 = world.spawnCreature('rat', 20, 20, 0);
    assert.strictEqual(mob2, mob1, 'world.spawnCreature reuses pooled Creature instance');
    assert.strictEqual(world.creaturePool.totalCreated, 1, 'zero new allocations on second spawn');
    assert.strictEqual(world.creaturePool.totalObtained, 2);
    assert.strictEqual(world.creaturePool.size, 0);
    assert.strictEqual(mob2.x, 20);
    assert.strictEqual(mob2.y, 20);

    world.stop();
}

function testWorldDespawnPinRecycling() {
    const world = makeWorld({
        spawnDespawnIdleTicks: 2,
        spawnMaxLiving: 10
    });

    const session = makeSession(world, ash(1), { x: 10, y: 10, z: 0 });

    const pin = {
        index: 0,
        kind: 'rat',
        x: 12,
        y: 10,
        z: 0,
        state: 'idle',
        eager: false,
        readyTick: 0,
        idleTicks: 0,
        entityId: 0
    };
    world.spawnPins = [pin];
    world.spawnPinSpatial.insert({ id: 0, x: 12, y: 10, z: 0, pin });

    // Activate pin -> creates living mob
    const c = world.activatePin(pin, 1);
    assert.ok(c instanceof Creature);
    assert.strictEqual(pin.state, 'living');
    assert.strictEqual(pin.entityId, c.id);
    assert.strictEqual(world.creaturePool.size, 0);
    assert.strictEqual(world.creaturePool.totalCreated, 1);

    // Despawn pin -> returns creature to pool
    world.despawnPin(pin);
    assert.strictEqual(pin.state, 'idle');
    assert.strictEqual(pin.entityId, 0);
    assert.strictEqual(world.creatures.size, 0);
    assert.strictEqual(world.creaturePool.size, 1);
    assert.strictEqual(world.creaturePool.totalReleased, 1);

    // Re-activate pin -> reuses the exact same creature instance
    const c2 = world.activatePin(pin, 2);
    assert.strictEqual(c2, c, 'pin activation reuses pooled creature');
    assert.strictEqual(world.creaturePool.totalCreated, 1);
    assert.strictEqual(world.creaturePool.size, 0);

    world.leave(session);
    world.stop();
}

function testWorldSoftCapBudgetEvictionRecycling() {
    // Test soft-cap budget eviction recycling: when livingPins >= maxLiving,
    // the evicted victim is despawned to creaturePool and immediately reused for the new pin!
    const world = makeWorld({
        spawnMaxLiving: 2,
        spawnActivateMargin: 10,
        spawnDespawnIdleTicks: 50
    });

    const session = makeSession(world, ash(1), { x: 10, y: 10, z: 0 });

    const pinA = { index: 0, kind: 'rat', x: 80, y: 80, z: 0, state: 'idle', eager: false, readyTick: 0, idleTicks: 0, entityId: 0 };
    const pinB = { index: 1, kind: 'rat', x: 14, y: 10, z: 0, state: 'idle', eager: false, readyTick: 0, idleTicks: 0, entityId: 0 };
    const pinC = { index: 2, kind: 'rat', x: 12, y: 10, z: 0, state: 'idle', eager: false, readyTick: 0, idleTicks: 0, entityId: 0 };

    world.spawnPins = [pinA, pinB, pinC];
    world.activatePin(pinA, 1);
    world.activatePin(pinB, 1);

    assert.strictEqual(world.livingPins.size, 2);
    assert.strictEqual(world.creatures.size, 2);
    assert.strictEqual(world.creaturePool.totalCreated, 2);
    assert.strictEqual(world.creaturePool.size, 0);

    // Activating pinC exceeds maxLiving (2), triggering pickBudgetVictim to despawn a victim.
    // The victim is released to creaturePool and immediately obtained for pinC!
    const cC = world.activatePin(pinC, 2);
    assert.ok(cC);
    assert.strictEqual(world.livingPins.size, 2);
    assert.strictEqual(world.creatures.size, 2);
    assert.strictEqual(world.creaturePool.totalCreated, 2, 'No new Creature was allocated during budget eviction spawn');
    assert.strictEqual(world.creaturePool.totalObtained, 3);
    assert.strictEqual(world.creaturePool.totalReleased, 1);

    world.leave(session);
    world.stop();
}

function testPlacementFailureReleasesToPool() {
    // A map with completely impassable terrain everywhere
    const blockedMap = {
        width: 10,
        height: 10,
        z: 0,
        zMin: 0,
        zMax: 0,
        spawnX: 0,
        spawnY: 0,
        spawnZ: 0,
        floors: {
            0: { friction: new Uint8Array(100).fill(255) } // friction 255 = unwalkable wall (FRICTION_BLOCKED)
        },
        stairs: [],
        spawns: [],
        npcs: []
    };

    const world = makeWorld(null, blockedMap);
    assert.strictEqual(world.creaturePool.size, 0);

    const spawned = world.spawnCreature('rat', 5, 5, 0);
    assert.strictEqual(spawned, null, 'spawn fails when all surrounding tiles blocked');
    assert.strictEqual(world.creaturePool.totalCreated, 1, 'creature created during placement attempt');
    assert.strictEqual(world.creaturePool.totalReleased, 1, 'creature returned to pool when placement fails');
    assert.strictEqual(world.creaturePool.size, 1, 'pool contains the returned creature');

    world.stop();
}

function testStandaloneCreateCreatureBackwardCompatibility() {
    const template = TEMPLATES.rat;
    const c = createCreature(5001, template, { x: 7, y: 8, z: 0 });
    assert.ok(c instanceof Creature);
    assert.strictEqual(c.id, 5001);
    assert.strictEqual(c.kind, 'rat');
    assert.strictEqual(c.x, 7);
    assert.strictEqual(c.y, 8);
    assert.strictEqual(c.hp, template.hp);
    assert.strictEqual(typeof c.reset, 'function');
}

function main() {
    testCreatureClassInitAndReset();
    testCreaturePoolBasicOperations();
    testCreaturePoolCapacityAndPreallocate();
    testZeroAllocationChurnCycle();
    testWorldSpawnAndKillRecycling();
    testWorldDespawnPinRecycling();
    testWorldSoftCapBudgetEvictionRecycling();
    testPlacementFailureReleasesToPool();
    testStandaloneCreateCreatureBackwardCompatibility();
    console.log('ok phase4_4_creature_object_pool');
}

main();

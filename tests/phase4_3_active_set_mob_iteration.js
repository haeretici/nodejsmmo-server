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

function testActiveSetSpawnAndSleepLifecycle() {
    const world = makeWorld();
    assert.ok(world.activeCreatures instanceof Set, 'activeCreatures is an instance of Set');
    assert.strictEqual(world.activeCreatures.size, 0, 'initial activeCreatures is empty');

    // 1. Spawning an awake mob adds it to activeCreatures
    const rat = world.spawnCreature('rat', 10, 10, 0);
    assert.ok(rat);
    assert.strictEqual(rat.simSleeping, false);
    assert.strictEqual(world.activeCreatures.size, 1);
    assert.ok(world.activeCreatures.has(rat), 'newly spawned creature is in activeCreatures');

    // 2. Step with no players -> creature sleeps and is removed from activeCreatures
    world.step(1);
    assert.strictEqual(rat.simSleeping, true);
    assert.strictEqual(world.activeCreatures.size, 0, 'sleeping creature removed from activeCreatures');
    assert.strictEqual(world.activeCreatures.has(rat), false);
    assert.strictEqual(world.creatures.size, 1, 'creature still exists in world.creatures');

    // 3. Player enters range (dist 5 <= 12) -> creature wakes up and is added back to activeCreatures
    const session = makeSession(world, ash(1), { x: 15, y: 10, z: 0 });
    world.step(2);
    assert.strictEqual(rat.simSleeping, false, 'creature wakes up near player');
    assert.strictEqual(world.activeCreatures.size, 1);
    assert.ok(world.activeCreatures.has(rat), 'woken creature added back to activeCreatures');

    // 4. Move player far away (> 12 tiles)
    world.tileMap.moveEntityToTile(session, 50, 50, 0);
    session.x = 50;
    session.y = 50;

    // Lose target, leash home if pulled off spawn, then sleep
    let slept = false;
    for (let t = 3; t <= 40; t++) {
        world.step(t);
        if (rat.simSleeping) {
            slept = true;
            break;
        }
    }
    assert.ok(slept, 'creature sleeps when player moves far away');
    assert.strictEqual(rat.x, rat.spawnX);
    assert.strictEqual(rat.y, rat.spawnY);
    assert.strictEqual(world.activeCreatures.size, 0, 'creature removed from activeCreatures');
    assert.strictEqual(world.activeCreatures.has(rat), false);

    session.kick(REASON.LOGOUT);
    world.stop();
}

function testActiveSetIterationOverheadScaleProof() {
    const world = makeWorld(null, multiFloorMap(300, 300));

    // Spawn 5 near mobs (around 10, 10)
    const nearMobs = [];
    for (let i = 0; i < 5; i++) {
        const c = world.spawnCreature('rat', 10 + i, 10, 0);
        nearMobs.push(c);
    }

    // Spawn 1,000 distant mobs (around 200, 200)
    const farMobs = [];
    for (let i = 0; i < 1000; i++) {
        const c = world.spawnCreature('rat', 200 + (i % 25), 200 + Math.floor(i / 25), 0);
        farMobs.push(c);
    }

    assert.strictEqual(world.creatures.size, 1005, '1005 total creatures created');

    // Player at (10, 10, 0)
    const session = makeSession(world, ash(10), { x: 10, y: 10, z: 0 });

    // Step 1: Sleep states settle
    world.step(1);

    // Verify exactly 5 active creatures (the near ones)
    assert.strictEqual(world.activeCreatures.size, 5, 'activeCreatures contains only the 5 near mobs');
    for (const c of nearMobs) {
        assert.strictEqual(c.simSleeping, false);
        assert.ok(world.activeCreatures.has(c));
    }
    for (const c of farMobs) {
        assert.strictEqual(c.simSleeping, true);
        assert.strictEqual(world.activeCreatures.has(c), false);
    }

    // Track invocations of tickCreature and tickCombatantConditions during tick 2
    let tickCreatureCalls = 0;
    const origTickCreature = world.tickCreature.bind(world);
    world.tickCreature = (cr, tickIndex) => {
        tickCreatureCalls++;
        return origTickCreature(cr, tickIndex);
    };

    let tickConditionCalls = 0;
    const origTickConditions = world.tickCombatantConditions.bind(world);
    world.tickCombatantConditions = (ent, dt) => {
        if (ent.type === 'creature') tickConditionCalls++;
        return origTickConditions(ent, dt);
    };

    // Execute step 2
    world.step(2);

    // In Phase 4.3, World.step() and tickCombatStatus() MUST iterate strictly this.activeCreatures (5),
    // NEVER iterating the 1,000 sleeping mobs in this.creatures!
    assert.strictEqual(
        tickCreatureCalls,
        5,
        `tickCreature invoked strictly on ${nearMobs.length} active creatures, not all 1005 world creatures`
    );
    assert.strictEqual(
        tickConditionCalls,
        5,
        `tickCombatantConditions invoked strictly on ${nearMobs.length} active creatures`
    );

    session.kick(REASON.LOGOUT);
    world.stop();
}

function testCreatureDeathAndDespawnRemovesFromActiveSet() {
    const world = makeWorld();
    const session = makeSession(world, ash(20), { x: 10, y: 10, z: 0 });

    const c1 = world.spawnCreature('rat', 11, 10, 0);
    const c2 = world.spawnCreature('rat', 12, 10, 0);
    world.step(1);

    assert.strictEqual(world.activeCreatures.size, 2);
    assert.ok(world.activeCreatures.has(c1));
    assert.ok(world.activeCreatures.has(c2));

    // 1. Kill c1 -> removed from both world.creatures and world.activeCreatures
    world.kill(c1, session, 2);
    assert.strictEqual(world.creatures.has(c1.id), false, 'dead mob deleted from world.creatures');
    assert.strictEqual(world.activeCreatures.has(c1), false, 'dead mob deleted from world.activeCreatures');
    assert.strictEqual(world.activeCreatures.size, 1);

    // 2. Despawn c2 via simulated pin
    const fakePin = {
        state: 'living',
        eager: false,
        entityId: c2.id,
        idleTicks: 0,
        readyTick: 0
    };
    world.livingPins.add(fakePin);
    world.despawnPin(fakePin);

    assert.strictEqual(world.creatures.has(c2.id), false, 'despawned mob deleted from world.creatures');
    assert.strictEqual(world.activeCreatures.has(c2), false, 'despawned mob deleted from world.activeCreatures');
    assert.strictEqual(world.activeCreatures.size, 0);

    session.kick(REASON.LOGOUT);
    world.stop();
}

function testCombatWakeUpAndStickyChasing() {
    const world = makeWorld(null, multiFloorMap(100, 100));
    const session = makeSession(world, ash(30), { x: 10, y: 10, z: 0 });

    // Distant mob (starts sleeping)
    const mob = world.spawnCreature('rat', 60, 60, 0);
    world.step(1);
    assert.strictEqual(mob.simSleeping, true);
    assert.strictEqual(world.activeCreatures.has(mob), false);

    // 1. Damage wake-up: applying damage wakes it up and adds to activeCreatures
    world.applyDamage(mob, 5, 'physical', 2, session);
    assert.strictEqual(mob.simSleeping, false, 'damaged mob wakes up');
    assert.ok(world.activeCreatures.has(mob), 'damaged mob is in activeCreatures');

    // 2. When mob targets player, it stays in activeCreatures even if far away
    mob.targetId = session.character.id;
    world.step(3);
    assert.strictEqual(mob.simSleeping, false, 'mob targeting player stays awake');
    assert.ok(world.activeCreatures.has(mob), 'mob targeting player stays in activeCreatures');

    // 3. Clear target -> leash home if off spawn, then sleep
    world.clearTarget(session.character.id);
    assert.strictEqual(mob.targetId, 0, 'targetId cleared by clearTarget');
    let slept = false;
    for (let t = 4; t <= 80; t++) {
        world.step(t);
        if (mob.simSleeping) {
            slept = true;
            break;
        }
    }
    assert.ok(slept, 'mob goes to sleep once target cleared');
    assert.strictEqual(world.activeCreatures.has(mob), false, 'mob removed from activeCreatures');

    // 4. Swing wake-up: trySwing against sleeping mob wakes it up
    mob.x = 11;
    mob.y = 10;
    world.tileMap.moveEntityToTile(mob, 11, 10, 0);
    mob.simSleeping = true;
    world.activeCreatures.delete(mob);
    assert.strictEqual(world.activeCreatures.has(mob), false);

    world.trySwing(session, mob, 5);
    assert.strictEqual(mob.simSleeping, false, 'swing wakes defender');
    assert.ok(world.activeCreatures.has(mob), 'swing adds defender to activeCreatures');

    session.kick(REASON.LOGOUT);
    world.stop();
}

function testDisabledSleepKeepsAllLivingInActiveSet() {
    const world = makeWorld({ aiCreatureSleep: false });

    const mobs = [];
    for (let i = 0; i < 10; i++) {
        mobs.push(world.spawnCreature('rat', 20 + i, 20, 0));
    }

    world.step(1);

    // When sleep is disabled, all living creatures must stay awake and in activeCreatures
    assert.strictEqual(world.activeCreatures.size, 10, 'all 10 creatures are in activeCreatures');
    for (const m of mobs) {
        assert.strictEqual(m.simSleeping, false);
        assert.ok(world.activeCreatures.has(m));
    }

    world.stop();
}

function testSnapshotIncludesActiveCreatures() {
    const world = makeWorld();
    const snap1 = world.snapshot();
    assert.strictEqual(snap1.activeCreatures, 0);

    const c = world.spawnCreature('rat', 5, 5, 0);
    const snap2 = world.snapshot();
    assert.strictEqual(snap2.activeCreatures, 1);
    assert.strictEqual(snap2.creatures, 1);

    world.kill(c, null, 1);
    const snap3 = world.snapshot();
    assert.strictEqual(snap3.activeCreatures, 0);
    assert.strictEqual(snap3.creatures, 0);

    world.stop();
}

function main() {
    testActiveSetSpawnAndSleepLifecycle();
    testActiveSetIterationOverheadScaleProof();
    testCreatureDeathAndDespawnRemovesFromActiveSet();
    testCombatWakeUpAndStickyChasing();
    testDisabledSleepKeepsAllLivingInActiveSet();
    testSnapshotIncludesActiveCreatures();
    console.log('ok phase4_3_active_set_mob_iteration');
}

main();

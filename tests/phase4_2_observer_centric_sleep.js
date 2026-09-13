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

function testObserverCentricSpatialQueryReduction() {
    const world = makeWorld(null, multiFloorMap(200, 200));

    // Spawn 100 creatures: 5 near (10, 10), 95 spread across the distant map
    const nearMobs = [];
    for (let i = 0; i < 5; i++) {
        const c = world.spawnCreature('rat', 10 + i, 10, 0);
        nearMobs.push(c);
    }
    const farMobs = [];
    for (let i = 0; i < 95; i++) {
        const c = world.spawnCreature('rat', 50 + (i % 20), 50 + Math.floor(i / 20) * 10, 0);
        farMobs.push(c);
    }

    // Connect 1 player at (10, 10, 0)
    const session = makeSession(world, ash(1), { x: 10, y: 10, z: 0 });

    // Track spatial candidate queries
    let creatureSpatialQueries = 0;
    let playerSpatialQueries = 0;
    const origCreatureQuery = world.creatureSpatial.queryChunkCandidates.bind(world.creatureSpatial);
    world.creatureSpatial.queryChunkCandidates = (x, y, z, r) => {
        creatureSpatialQueries++;
        return origCreatureQuery(x, y, z, r);
    };
    const origPlayerQuery = world.playerSpatial.queryChunkCandidates.bind(world.playerSpatial);
    world.playerSpatial.queryChunkCandidates = (x, y, z, r) => {
        playerSpatialQueries++;
        return origPlayerQuery(x, y, z, r);
    };

    // Run a tick - updateCreatureSleepStates executes
    world.updateCreatureSleepStates(1);

    // In Phase 4.2 Observer-Centric AOI:
    // Exactly 1 spatial candidate query (from the 1 active player), NOT 100 queries from 100 creatures!
    assert.strictEqual(creatureSpatialQueries, 1, 'creatureSpatial queried exactly once for the single active player');
    assert.strictEqual(playerSpatialQueries, 0, 'playerSpatial was NOT queried in inverted fashion by any creature');

    // Verify all 5 near mobs are awake
    for (const c of nearMobs) {
        assert.strictEqual(c.simSleeping, false, `near mob ${c.id} should be awake`);
    }

    // Verify all 95 distant mobs are sleeping
    for (const c of farMobs) {
        assert.strictEqual(c.simSleeping, true, `distant mob ${c.id} should be sleeping`);
    }

    session.kick(REASON.LOGOUT);
    world.stop();
}

function testZeroPlayersZeroSpatialQueries() {
    const world = makeWorld(null, multiFloorMap(100, 100));

    // Spawn 50 creatures
    const mobs = [];
    for (let i = 0; i < 50; i++) {
        mobs.push(world.spawnCreature('rat', 20 + i, 20, 0));
    }

    let spatialQueries = 0;
    const origCreatureQuery = world.creatureSpatial.queryChunkCandidates.bind(world.creatureSpatial);
    world.creatureSpatial.queryChunkCandidates = (x, y, z, r) => {
        spatialQueries++;
        return origCreatureQuery(x, y, z, r);
    };

    // Step with 0 active players
    world.updateCreatureSleepStates(1);

    assert.strictEqual(spatialQueries, 0, 'zero spatial queries when no active players exist');
    for (const c of mobs) {
        assert.strictEqual(c.simSleeping, true, `mob ${c.id} went to sleep with no players`);
    }

    world.stop();
}

function testMultiplePlayersObserverCentric() {
    const world = makeWorld(null, multiFloorMap(200, 200));

    // Cluster A near (10, 10, 0)
    const clusterA = [
        world.spawnCreature('rat', 11, 10, 0),
        world.spawnCreature('rat', 12, 10, 0)
    ];
    // Cluster B near (80, 80, 0)
    const clusterB = [
        world.spawnCreature('rat', 81, 80, 0),
        world.spawnCreature('rat', 82, 80, 0)
    ];
    // Remote Cluster C near (150, 150, 0)
    const clusterC = [
        world.spawnCreature('rat', 151, 150, 0),
        world.spawnCreature('rat', 152, 150, 0)
    ];

    // Player 1 at Cluster A, Player 2 at Cluster B
    const session1 = makeSession(world, ash(1), { x: 10, y: 10, z: 0 });
    const session2 = makeSession(world, ash(2), { x: 80, y: 80, z: 0 });

    let spatialQueries = 0;
    const origQuery = world.creatureSpatial.queryChunkCandidates.bind(world.creatureSpatial);
    world.creatureSpatial.queryChunkCandidates = (x, y, z, r) => {
        spatialQueries++;
        return origQuery(x, y, z, r);
    };

    world.updateCreatureSleepStates(1);

    // Exactly 2 queries: one for Player 1, one for Player 2
    assert.strictEqual(spatialQueries, 2, 'creatureSpatial queried exactly 2 times for 2 active players');

    // Clusters A and B are awake
    for (const c of clusterA) assert.strictEqual(c.simSleeping, false, 'Cluster A awake');
    for (const c of clusterB) assert.strictEqual(c.simSleeping, false, 'Cluster B awake');

    // Remote Cluster C is asleep
    for (const c of clusterC) assert.strictEqual(c.simSleeping, true, 'Cluster C sleeping');

    session1.kick(REASON.LOGOUT);
    session2.kick(REASON.LOGOUT);
    world.stop();
}

function testCombatExemptionsObserverCentric() {
    const world = makeWorld(null, multiFloorMap(200, 200));

    // Distant mob far away at (100, 100, 0)
    const distantMob = world.spawnCreature('rat', 100, 100, 0);
    const session = makeSession(world, ash(1), { x: 10, y: 10, z: 0 });

    // Initial state: distant mob sleeps
    world.updateCreatureSleepStates(1);
    assert.strictEqual(distantMob.simSleeping, true);

    // 1. Player targets distant mob -> wakes up despite being far away
    session.targetId = distantMob.id;
    world.updateCreatureSleepStates(2);
    assert.strictEqual(distantMob.simSleeping, false, 'mob targeted by player wakes up');

    // Clear player target -> goes back to sleep
    session.targetId = 0;
    world.updateCreatureSleepStates(3);
    assert.strictEqual(distantMob.simSleeping, true, 'mob goes back to sleep after target cleared');

    // 2. Creature targets player -> stays awake despite being far away
    distantMob.targetId = session.character.id;
    world.updateCreatureSleepStates(4);
    assert.strictEqual(distantMob.simSleeping, false, 'mob targeting player stays awake');

    distantMob.targetId = 0;
    world.updateCreatureSleepStates(5);
    assert.strictEqual(distantMob.simSleeping, true, 'mob goes back to sleep after clearing targetId');

    session.kick(REASON.LOGOUT);
    world.stop();
}

function testFloorIsolationObserverCentric() {
    const world = makeWorld(null, multiFloorMap(50, 50));

    const mobFloor0 = world.spawnCreature('rat', 12, 10, 0);
    const mobFloor1 = world.spawnCreature('rat', 12, 10, 1);

    // Player at (10, 10) on floor 0
    const session = makeSession(world, ash(1), { x: 10, y: 10, z: 0 });

    world.updateCreatureSleepStates(1);
    assert.strictEqual(mobFloor0.simSleeping, false, 'same-floor mob is awake');
    assert.strictEqual(mobFloor1.simSleeping, true, 'different-floor mob is asleep');

    // Move player to floor 1
    session.z = 1;
    world.tileMap.moveEntityToTile(session, 10, 10, 1);

    world.updateCreatureSleepStates(2);
    assert.strictEqual(mobFloor0.simSleeping, true, 'old-floor mob went to sleep');
    assert.strictEqual(mobFloor1.simSleeping, false, 'new-floor mob woke up');

    session.kick(REASON.LOGOUT);
    world.stop();
}

function testDisabledSleepAndZeroRadius() {
    // aiCreatureSleep = false
    const worldDisabled = makeWorld({ aiCreatureSleep: false });
    const rat1 = worldDisabled.spawnCreature('rat', 10, 10, 0);
    assert.ok(rat1, 'rat1 should spawn');
    worldDisabled.updateCreatureSleepStates(1);
    assert.strictEqual(rat1.simSleeping, false, 'creature stays awake when sleep is disabled');

    rat1.simSleeping = true;
    worldDisabled.updateCreatureSleepStates(2);
    assert.strictEqual(rat1.simSleeping, false, 'sleeping creature woke up when sleep is disabled');
    worldDisabled.stop();

    // aiTickRadius = 0
    const worldZeroRadius = makeWorld({ aiTickRadius: 0 });
    const rat2 = worldZeroRadius.spawnCreature('rat', 10, 10, 0);
    assert.ok(rat2, 'rat2 should spawn');
    worldZeroRadius.updateCreatureSleepStates(1);
    assert.strictEqual(rat2.simSleeping, false, 'creature stays awake when aiTickRadius = 0');

    rat2.simSleeping = true;
    worldZeroRadius.updateCreatureSleepStates(2);
    assert.strictEqual(rat2.simSleeping, false, 'sleeping creature woke up when aiTickRadius = 0');
    worldZeroRadius.stop();
}

function main() {
    testObserverCentricSpatialQueryReduction();
    testZeroPlayersZeroSpatialQueries();
    testMultiplePlayersObserverCentric();
    testCombatExemptionsObserverCentric();
    testFloorIsolationObserverCentric();
    testDisabledSleepAndZeroRadius();
    console.log('ok phase4_2_observer_centric_sleep');
}

main();

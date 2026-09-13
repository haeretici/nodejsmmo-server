'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { createLog } = require('../src/log');
const { RateLimiter } = require('../src/security/rate_limit');
const { TileMap, FRICTION_BLOCKED } = require('../src/world/tilemap');
const {
    MonsterComputeService,
    resolveWorkerCount,
    extractGridSnapshot
} = require('../src/world/monster_compute');
const { SnapshotGrid } = require('../src/world/monster_compute_worker');
const { findPath } = require('../src/world/pathfinder');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function gridMap(cols, rows, walls) {
    const n = cols * rows;
    const friction = new Uint8Array(n).fill(100);
    if (walls) {
        for (let i = 0; i < walls.length; i++) {
            const w = walls[i];
            friction[w[1] * cols + w[0]] = FRICTION_BLOCKED;
        }
    }
    return {
        width: cols,
        height: rows,
        z: 0,
        spawnX: 0,
        spawnY: 0,
        spawnZ: 0,
        floors: { 0: { friction } },
        stairs: [],
        spawns: [],
        npcs: []
    };
}

function makeWorld(extra, map) {
    const settings = testSettings();
    if (extra) Object.assign(settings, extra);
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        rng: () => 0,
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
    return session;
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

function testResolveWorkerCount() {
    assert.strictEqual(resolveWorkerCount(0), 0);
    assert.strictEqual(resolveWorkerCount('0'), 0);
    assert.strictEqual(resolveWorkerCount(-1), 0);
    assert.strictEqual(resolveWorkerCount(1), 1);
    assert.strictEqual(resolveWorkerCount('2'), 2);
    assert.strictEqual(resolveWorkerCount(4), 4);
    assert.strictEqual(resolveWorkerCount(8), 4, 'capped at 4');
    assert.strictEqual(resolveWorkerCount('auto') >= 0 && resolveWorkerCount('auto') <= 4, true);
}

function testSnapshotGridAndExtraction() {
    const tm = new TileMap({
        cols: 20,
        rows: 20,
        z: 0,
        friction: new Uint8Array(400).fill(100)
    });
    const layer = tm.getLayer(0);
    // Add an obstacle at (5, 5)
    layer.friction[5 * 20 + 5] = FRICTION_BLOCKED;
    // Add occupant at (6, 5)
    layer.occupancy[5 * 20 + 6] = 1000000002;

    const snap = extractGridSnapshot(tm, 0, { x: 3, y: 5 }, { x: 8, y: 5 }, 4);
    assert.ok(snap);
    assert.strictEqual(snap.isWindow, true);
    assert.ok(snap.cols < 20);
    assert.ok(snap.rows < 20);

    // Verify coordinates in SnapshotGrid
    const grid = new SnapshotGrid({
        cols: snap.cols,
        rows: snap.rows,
        friction: snap.friction,
        occupancy: snap.occupancy,
        flags: snap.flags,
        fields: snap.fields,
        canPushCreatures: false,
        creatureIdBase: 1000000000,
        moverId: 1000000001
    });

    const localX = 5 - snap.minX;
    const localY = 5 - snap.minY;
    assert.strictEqual(grid.friction[localY * snap.cols + localX], FRICTION_BLOCKED);
    assert.strictEqual(grid.pathStepOccupancy(localX, localY), 'free'); // friction blocks, not occupancy
    const occX = 6 - snap.minX;
    const occY = 5 - snap.minY;
    assert.strictEqual(grid.pathStepOccupancy(occX, occY), 'hard'); // cannot push creatures
}

function testQueuePriorityAndEviction() {
    const service = new MonsterComputeService({
        workers: 0,
        capacity: 10,
        visibleReserve: 3, // maxBackground = 10 - 3 = 7
        applyDelayTicks: 1
    });

    // Submit 7 background jobs (fill background allowance)
    for (let i = 1; i <= 7; i++) {
        const res = service.submitPath({
            entityId: 100 + i,
            priority: 'background',
            z: 0,
            start: { x: 0, y: 0 },
            goal: { x: 1, y: 1 }
        });
        assert.ok(res, `background job ${i} accepted`);
    }

    // 8th background job should be rejected (reserve protection)
    const rejectedBg = service.submitPath({
        entityId: 108,
        priority: 'background',
        z: 0,
        start: { x: 0, y: 0 },
        goal: { x: 1, y: 1 }
    });
    assert.strictEqual(rejectedBg, null, 'background job rejected due to visible reserve');
    assert.strictEqual(service.stats().rejected, 1);

    // Visible jobs can fill the remaining 3 slots
    for (let i = 1; i <= 3; i++) {
        const res = service.submitPath({
            entityId: 200 + i,
            priority: 'visible',
            z: 0,
            start: { x: 0, y: 0 },
            goal: { x: 1, y: 1 }
        });
        assert.ok(res, `visible job ${i} accepted`);
    }
    // Now total queued is 10 (capacity limit reached)

    // Submitting an 11th visible job should evict the oldest background job
    const evictingJob = service.submitPath({
        entityId: 204,
        priority: 'visible',
        z: 0,
        start: { x: 0, y: 0 },
        goal: { x: 1, y: 1 }
    });
    assert.ok(evictingJob, 'visible job accepted by evicting background job');
    assert.strictEqual(service.stats().evictions, 1);
}

function testDeterministicDrainOrder() {
    const service = new MonsterComputeService({
        workers: 0,
        capacity: 100,
        applyDelayTicks: 1
    });

    // Submit out of order
    service.submitPath({ entityId: 50, z: 0, start: { x: 0, y: 0 }, goal: { x: 0, y: 0 } });
    service.submitPath({ entityId: 10, z: 0, start: { x: 0, y: 0 }, goal: { x: 0, y: 0 } });
    service.submitPath({ entityId: 30, z: 0, start: { x: 0, y: 0 }, goal: { x: 0, y: 0 } });
    service.submitPath({ entityId: 10, z: 0, start: { x: 0, y: 0 }, goal: { x: 0, y: 0 } });

    const drained = service.drainCompletions();
    assert.strictEqual(drained.length, 4);
    assert.strictEqual(drained[0].entityId, 10);
    assert.strictEqual(drained[1].entityId, 10);
    assert.ok(drained[0].token < drained[1].token);
    assert.strictEqual(drained[2].entityId, 30);
    assert.strictEqual(drained[3].entityId, 50);
}

function testInlineExecution() {
    const tm = new TileMap({
        cols: 10,
        rows: 10,
        z: 0,
        friction: new Uint8Array(100).fill(100)
    });

    const service = new MonsterComputeService({
        workers: 0,
        applyDelayTicks: 0,
        tileMap: tm
    });

    const res = service.submitPath({
        entityId: 1000000001,
        z: 0,
        start: { x: 1, y: 1 },
        goal: { x: 4, y: 1 }
    });

    assert.ok(res);
    assert.strictEqual(res.inline, true);
    assert.strictEqual(res.status, 'found');
    assert.strictEqual(res.path.length, 4); // (1,1), (2,1), (3,1), (4,1)
    assert.strictEqual(res.path[3].x, 4);
    assert.strictEqual(res.path[3].y, 1);
    assert.strictEqual(service.stats().inlineComputed, 1);
}

async function testWorkerThreadExecution() {
    const tm = new TileMap({
        cols: 15,
        rows: 15,
        z: 0,
        friction: new Uint8Array(225).fill(100)
    });
    // Add wall
    const layer = tm.getLayer(0);
    layer.friction[3 * 15 + 3] = FRICTION_BLOCKED;

    const service = new MonsterComputeService({
        workers: 1,
        tileMap: tm
    });
    service.start();

    const res = service.submitPath({
        entityId: 1000000001,
        z: 0,
        start: { x: 2, y: 3 },
        goal: { x: 4, y: 3 }
    });
    assert.ok(res);
    assert.strictEqual(res.inline, false);
    assert.strictEqual(res.status, 'pending');

    // Wait for worker completion
    let attempts = 0;
    while (service.completions.length === 0 && attempts < 50) {
        await new Promise((r) => setTimeout(r, 20));
        attempts++;
    }

    assert.ok(service.completions.length > 0, 'worker produced completion');
    const drained = service.drainCompletions();
    assert.strictEqual(drained.length, 1);
    assert.strictEqual(drained[0].status, 'found');
    assert.ok(Array.isArray(drained[0].path));
    assert.strictEqual(drained[0].path[drained[0].path.length - 1].x, 4);
    assert.strictEqual(drained[0].path[drained[0].path.length - 1].y, 3);

    service.stop();
}

async function testWorldIntegrationWithWorkers() {
    const map = gridMap(10, 5, [[4, 0], [4, 1]]);
    const w = makeWorld({
        computeWorkers: 1,
        computeApplyDelayTicks: 1,
        creatureStepDelayTicks: 1,
        stepDelayTicks: 1,
        spawns: [{ kind: 'rat', x: 1, y: 0, z: 0 }]
    }, map);

    assert.ok(w.computeService);
    assert.strictEqual(w.computeService.workerCount, 1);

    const hunter = makeSession(w, ash(1), { x: 7, y: 0, z: 0 });
    const rat = Array.from(w.creatures.values())[0];
    assert.ok(rat, 'creature spawned');

    // Tick world for rat to acquire target and path
    w.step(1);
    assert.strictEqual(rat.targetId, hunter.id);

    // Run ticks to allow movement & compute completions
    for (let i = 2; i <= 15; i++) {
        await new Promise((r) => setTimeout(r, 10));
        w.step(i);
    }

    // Creature should have stepped toward player around the wall
    assert.ok(rat.x > 1, 'rat progressed toward hunter');
    const snap = w.snapshot();
    assert.ok(snap.compute);
    assert.strictEqual(snap.compute.workerCount, 1);

    w.stop();
}

async function run() {
    testResolveWorkerCount();
    testSnapshotGridAndExtraction();
    testQueuePriorityAndEviction();
    testDeterministicDrainOrder();
    testInlineExecution();
    await testWorkerThreadExecution();
    await testWorldIntegrationWithWorkers();
    console.log('ok phase6_1_monster_compute');
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});

'use strict';

const assert = require('assert');
const { TileMap, fromStaticMap, FRICTION_BLOCKED, DEFAULT_WALK_FRICTION } = require('../src/world/tilemap');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { testSettings } = require('./helpers');
const { C2S, S2C, DIR } = require('../src/protocol/opcodes');
const { loadPack, resolveContentPath, runtimeMap } = require('../src/content/load_pack');
const { SERVER_ROOT } = require('../src/config/load_settings');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function makeWorld(pack, extra) {
    const settings = testSettings();
    settings.pagedFloors = true;
    settings.floorIdleTimeoutSec = 300;
    settings.floorSweepIntervalTicks = 10;
    if (extra) Object.assign(settings, extra);
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        pack,
        schedule: () => 0,
        clear: () => {}
    });
    return world;
}

function makeSession(world, pos) {
    const sock = fakeSocket();
    const session = new GameSession({
        socket: sock,
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    const ch = {
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
    session.bindCharacter(ch, pos || world.townSpawn());
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    return session;
}

function testContinentalDemandPagingBoot() {
    // Simulate continental scale: 2560 x 2048 tiles across 16 floors (z=0..15)
    const width = 2560;
    const height = 2048;
    const n = width * height;
    const homeZ = 6;
    let floorLoads = 0;

    const mockMap = {
        width,
        height,
        spawnZ: homeZ,
        zMin: 0,
        zMax: 15,
        floors: Object.create(null)
    };

    // Populate floor descriptors with lazy channel generation
    for (let z = 0; z <= 15; z++) {
        mockMap.floors[String(z)] = {
            friction: (z === homeZ) ? new Uint8Array(n).fill(100) : null,
            sight: null,
            flags: null,
            fields: null
        };
    }

    const tm = fromStaticMap(mockMap, {
        pagedFloors: true,
        floorIdleTimeoutSec: 300,
        onFloorLoaded: () => { floorLoads++; }
    });

    // Invariant: At boot, only home floor (z=6) is inflated
    assert.strictEqual(tm.isFloorInflated(homeZ), true, 'home floor must be inflated at boot');
    assert.strictEqual(tm.isFloorPinned(homeZ), true, 'home floor must be pinned');
    assert.strictEqual(Object.keys(tm.layers).length, 1, 'strictly 1 floor in memory at boot');

    for (let z = 0; z <= 15; z++) {
        if (z === homeZ) continue;
        assert.strictEqual(tm.isFloorInflated(z), false, `floor ${z} must remain uninflated at boot`);
        assert.strictEqual(tm.layers[String(z)], undefined, `layer ${z} must not exist in memory`);
    }

    // RAM calculation check: 15 unallocated floors save ~1.25 GB
    const bytesPerFloor = n * (1 + 1 + 1 + 1 + 4); // friction, sight, flags, fields, occupancy = 8 bytes
    const ramSavedMb = (15 * bytesPerFloor) / (1024 * 1024);
    assert.ok(ramSavedMb >= 600, `continental savings must be >= 600 MB (calculated: ${ramSavedMb.toFixed(1)} MB)`);
}

function testLazyInflationOnDemand() {
    const width = 64;
    const height = 64;
    const homeZ = 6;
    let loadedZ = null;

    const mockMap = {
        width,
        height,
        spawnZ: homeZ,
        zMin: 0,
        zMax: 15,
        floors: Object.create(null)
    };

    for (let z = 0; z <= 15; z++) {
        const friction = new Uint8Array(width * height).fill(100);
        // Make tile (10, 10) on floor 7 a wall
        if (z === 7) friction[10 * width + 10] = FRICTION_BLOCKED;
        mockMap.floors[String(z)] = { friction, sight: null, flags: null, fields: null };
    }

    const tm = fromStaticMap(mockMap, {
        pagedFloors: true,
        floorIdleTimeoutSec: 300,
        onFloorLoaded: (z) => { loadedZ = z; }
    });

    assert.strictEqual(tm.isFloorInflated(7), false);
    assert.strictEqual(Object.keys(tm.layers).length, 1);

    // Querying floor 7 via isWalkable triggers on-demand inflation
    assert.strictEqual(tm.isWalkable(10, 10, 7), false, 'friction check must read inflated floor');
    assert.strictEqual(tm.isWalkable(12, 12, 7), true);
    assert.strictEqual(tm.isFloorInflated(7), true, 'floor 7 must now be inflated');
    assert.strictEqual(loadedZ, 7, 'onFloorLoaded callback must be triggered for floor 7');
    assert.strictEqual(Object.keys(tm.layers).length, 2, 'exactly 2 floors inflated in memory');
}

function testActiveFloorReferenceCounting() {
    let mockTime = 1000;
    const tm = new TileMap({
        cols: 32,
        rows: 32,
        z: 6,
        now: () => mockTime
    });

    const p1 = { id: 1, type: 'player', x: 5, y: 5, z: 6 };
    const p2 = { id: 2, type: 'player', x: 6, y: 5, z: 6 };
    const cr = { id: 101, type: 'creature', x: 10, y: 10, z: 6 };

    assert.strictEqual(tm.getFloorPlayerCount(6), 0);
    assert.strictEqual(tm.getFloorCreatureCount(6), 0);

    // 1. Enter player 1
    assert.ok(tm.enterTile(5, 5, 6, p1));
    assert.strictEqual(tm.getFloorPlayerCount(6), 1);
    assert.strictEqual(tm.getFloorOccupantCount(6), 1);

    // 2. Enter creature
    assert.ok(tm.enterTile(10, 10, 6, cr));
    assert.strictEqual(tm.getFloorCreatureCount(6), 1);
    assert.strictEqual(tm.getFloorOccupantCount(6), 2);

    // 3. Enter player 2
    assert.ok(tm.enterTile(6, 5, 6, p2));
    assert.strictEqual(tm.getFloorPlayerCount(6), 2);
    assert.strictEqual(tm.getFloorOccupantCount(6), 3);

    // 4. Move player within same floor does not change count
    assert.ok(tm.moveEntityToTile(7, 5, 6, p2));
    assert.strictEqual(tm.getFloorPlayerCount(6), 2);
    assert.strictEqual(tm.getFloorOccupantCount(6), 3);

    // 5. Leave player 1
    assert.ok(tm.leaveTile(5, 5, 6, p1));
    assert.strictEqual(tm.getFloorPlayerCount(6), 1);

    // 6. Leave player 2
    assert.ok(tm.leaveTile(7, 5, 6, p2));
    assert.strictEqual(tm.getFloorPlayerCount(6), 0);
    assert.strictEqual(tm.getFloorCreatureCount(6), 1); // creature still present

    // 7. Leave creature -> floor becomes idle
    mockTime = 5000;
    assert.ok(tm.leaveTile(10, 10, 6, cr));
    assert.strictEqual(tm.getFloorOccupantCount(6), 0);
    assert.strictEqual(tm.getFloorState(6).lastActiveAt, 5000, 'idle time recorded upon becoming empty');
}

function testIdleFloorSweepAndUnload() {
    let mockTime = 10000;
    let unloadedZ = null;

    const mockMap = {
        width: 32,
        height: 32,
        spawnZ: 6,
        zMin: 0,
        zMax: 15,
        floors: Object.create(null)
    };
    for (let z = 0; z <= 15; z++) {
        mockMap.floors[String(z)] = { friction: new Uint8Array(32 * 32).fill(100), sight: null, flags: null, fields: null };
    }

    const tm = fromStaticMap(mockMap, {
        pagedFloors: true,
        floorIdleTimeoutSec: 300, // 5 minutes
        now: () => mockTime,
        onFloorUnloaded: (z) => { unloadedZ = z; }
    });

    // Inflate floor 7
    assert.ok(tm.getLayer(7));
    assert.strictEqual(tm.isFloorInflated(7), true);

    const player = { id: 1, type: 'player', x: 5, y: 5, z: 7 };
    assert.ok(tm.enterTile(5, 5, 7, player));
    assert.strictEqual(tm.getFloorOccupantCount(7), 1);

    // Player leaves floor 7 at t = 20,000
    mockTime = 20000;
    assert.ok(tm.leaveTile(5, 5, 7, player));
    assert.strictEqual(tm.getFloorOccupantCount(7), 0);

    // 1. Advance time by 100s (mockTime = 120,000; elapsed = 100s < 300s) -> sweep must NOT unload
    mockTime = 120000;
    const swept1 = tm.sweepIdleFloors(mockTime);
    assert.deepStrictEqual(swept1, []);
    assert.strictEqual(tm.isFloorInflated(7), true, 'floor 7 must remain inflated while under timeout');

    // 2. Advance time by 305s (mockTime = 325,000; elapsed = 305s > 300s) -> sweep MUST unload floor 7
    mockTime = 325000;
    const swept2 = tm.sweepIdleFloors(mockTime);
    assert.deepStrictEqual(swept2, [7], 'floor 7 must be swept and unloaded');
    assert.strictEqual(unloadedZ, 7, 'onFloorUnloaded callback must be called with 7');
    assert.strictEqual(tm.isFloorInflated(7), false, 'floor 7 is no longer in memory');
    assert.strictEqual(tm.layers['7'], undefined, 'layer 7 is freed from memory');

    // 3. Home floor (z=6) has been idle the whole time (elapsed = 315s) but is pinned!
    assert.strictEqual(tm.isFloorPinned(6), true);
    assert.strictEqual(tm.isFloorInflated(6), true, 'pinned home floor must NEVER be unloaded');
}

function testReInflationAndPatchPersistence() {
    let mockTime = 1000;
    const mockMap = {
        width: 32,
        height: 32,
        spawnZ: 6,
        zMin: 0,
        zMax: 15,
        floors: Object.create(null)
    };
    for (let z = 0; z <= 15; z++) {
        mockMap.floors[String(z)] = { friction: new Uint8Array(32 * 32).fill(100), sight: null, flags: null, fields: null };
    }

    const tm = fromStaticMap(mockMap, {
        pagedFloors: true,
        floorIdleTimeoutSec: 300,
        now: () => mockTime
    });

    // Inflate floor 8
    assert.ok(tm.getLayer(8));
    assert.strictEqual(tm.frictionAt(15, 15, 8), 100);

    // Apply a cell patch on floor 8 (e.g., closed door / wall)
    const patchResult = tm.applyCellPatch({ x: 15, y: 15, z: 8, friction: FRICTION_BLOCKED });
    assert.strictEqual(patchResult.ok, true);
    assert.strictEqual(tm.frictionAt(15, 15, 8), FRICTION_BLOCKED);

    // Unload floor 8
    mockTime += 400000;
    const unloaded = tm.sweepIdleFloors(mockTime);
    assert.deepStrictEqual(unloaded, [8]);
    assert.strictEqual(tm.isFloorInflated(8), false);

    // Re-inflate floor 8 on demand
    const reInflated = tm.getLayer(8);
    assert.ok(reInflated);
    assert.strictEqual(tm.isFloorInflated(8), true);

    // Invariant: Runtime cell patch is preserved and reapplied!
    assert.strictEqual(tm.frictionAt(15, 15, 8), FRICTION_BLOCKED, 'cell patch must persist across floor paging cycles');
}

function testFieldStoreSyncAcrossPaging() {
    let mockTime = 1000;
    const mockMap = {
        width: 32,
        height: 32,
        spawnZ: 6,
        zMin: 0,
        zMax: 15,
        floors: Object.create(null)
    };
    for (let z = 0; z <= 15; z++) {
        const fields = new Uint8Array(32 * 32);
        // Floor 9 has a poison field at (5, 5)
        if (z === 9) fields[5 * 32 + 5] = 2; // POISON mask = 2
        mockMap.floors[String(z)] = { friction: new Uint8Array(32 * 32).fill(100), sight: null, flags: null, fields };
    }

    const { createFieldStore, seedFloorFields, removeFieldsForFloor, getFieldOnTile } = require('../src/world/fields');
    let fieldStore = null;

    const tm = fromStaticMap(mockMap, {
        pagedFloors: true,
        floorIdleTimeoutSec: 300,
        now: () => mockTime,
        onFloorLoaded: (z, layer) => {
            if (fieldStore) seedFloorFields(fieldStore, layer, z, { createdAt: mockTime });
        },
        onFloorUnloaded: (z) => {
            if (fieldStore) removeFieldsForFloor(fieldStore, z);
        }
    });
    fieldStore = createFieldStore(tm);

    // Floor 9 is uninflated at start; fieldStore has no fields for z=9
    assert.strictEqual(getFieldOnTile(fieldStore, 5, 5, 9), null);

    // Inflate floor 9 -> fields are seeded via onFloorLoaded
    assert.ok(tm.getLayer(9));
    const f9 = getFieldOnTile(fieldStore, 5, 5, 9);
    assert.ok(f9, 'field on floor 9 must be seeded upon inflation');
    assert.strictEqual(f9.kind, 'poison');

    // Unload floor 9 -> fields are purged via onFloorUnloaded
    mockTime += 400000;
    assert.deepStrictEqual(tm.sweepIdleFloors(mockTime), [9]);
    assert.strictEqual(getFieldOnTile(fieldStore, 5, 5, 9), null, 'field must be cleaned up upon floor unload');
}

function testWorldIntegrationStairsAndPaging() {
    const root = resolveContentPath({ contentPath: '../content' }, SERVER_ROOT);
    const pack = loadPack(root);
    const world = makeWorld(pack);
    world.start();

    // At boot, firstlight_isle home floor (z=6) is the only inflated layer
    assert.strictEqual(world.tileMap.isFloorInflated(6), true);
    assert.strictEqual(world.tileMap.isFloorInflated(7), false);
    assert.strictEqual(Object.keys(world.tileMap.layers).length, 1);

    const session = makeSession(world, { x: 80, y: 132, z: 6 });
    assert.strictEqual(session.z, 6);
    assert.strictEqual(world.tileMap.getFloorPlayerCount(6), 1);

    // Simulate moving player to floor 7 (e.g. stair pad or direct hop)
    assert.ok(world.tileMap.moveEntityToTile(80, 132, 7, session));
    assert.strictEqual(session.z, 7);
    assert.strictEqual(world.tileMap.isFloorInflated(7), true, 'floor 7 must be inflated on demand');
    assert.strictEqual(world.tileMap.getFloorPlayerCount(7), 1);
    assert.strictEqual(world.tileMap.getFloorPlayerCount(6), 0);

    // Move player back to floor 6
    assert.ok(world.tileMap.moveEntityToTile(80, 132, 6, session));
    assert.strictEqual(session.z, 6);
    assert.strictEqual(world.tileMap.getFloorPlayerCount(7), 0);

    // Advance tick and trigger sweep
    const floor7State = world.tileMap.getFloorState(7);
    floor7State.lastActiveAt = Date.now() - 400000; // simulate > 5m idle

    // Step world
    world.step(10); // tickIndex % 10 === 0 triggers sweepIdleFloors

    assert.strictEqual(world.tileMap.isFloorInflated(7), false, 'floor 7 must be unloaded during world step');
    assert.strictEqual(world.tileMap.isFloorInflated(6), true, 'home floor 6 stays resident');

    world.leave(session);
    world.stop();
}

function main() {
    testContinentalDemandPagingBoot();
    testLazyInflationOnDemand();
    testActiveFloorReferenceCounting();
    testIdleFloorSweepAndUnload();
    testReInflationAndPatchPersistence();
    testFieldStoreSyncAcrossPaging();
    testWorldIntegrationStairsAndPaging();

    console.log('ok phase6_5_continental_floor_windowing');
}

main();

'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { createLog } = require('../src/log');
const {
    SpatialIndex,
    numericChunkKey,
    decodeNumericChunkKey
} = require('../src/world/spatial_index');

function multiFloorMap(cols, rows) {
    const n = cols * rows;
    return {
        width: cols,
        height: rows,
        z: 0,
        zMin: 0,
        zMax: 7,
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
    if (extra) Object.assign(settings, extra);
    const store = new MemoryStore();
    const log = createLog(settings);
    const m = map || multiFloorMap(128, 128);
    const w = new World({
        settings,
        store,
        log,
        map: m,
        schedule: () => 0,
        clear: () => {}
    });
    w.start();
    return w;
}

function ash(id) {
    return {
        id,
        accountId: id,
        name: `Player_${id}`,
        vocation: 'knight',
        level: 1,
        hp: 100,
        hpMax: 100,
        mp: 50,
        mpMax: 50
    };
}

function makeSession(world, ch, tile) {
    const s = new GameSession({
        socket: {
            readyState: 1,
            sent: [],
            send(buf) { this.sent.push(Buffer.from(buf)); },
            close() { this.readyState = 3; }
        },
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: { allow: () => true },
        log: world.log
    });
    s.bindCharacter(ch, tile);
    world.add(s);
    return s;
}

function testNumericChunkKeyEncodingDecoding() {
    // Basic values
    const k0 = numericChunkKey(0, 0, 0);
    assert.strictEqual(typeof k0, 'number');
    assert.strictEqual(k0, 0);
    assert.strictEqual(k0, k0 >>> 0);

    // Floor 7, chunk (2, 3)
    const k7 = numericChunkKey(2, 3, 7);
    assert.strictEqual(typeof k7, 'number');
    assert.strictEqual(k7, (7 << 24) | (2 << 12) | 3);
    assert.strictEqual(k7, k7 >>> 0);

    const d7 = decodeNumericChunkKey(k7);
    assert.strictEqual(d7.z, 7);
    assert.strictEqual(d7.cx, 2);
    assert.strictEqual(d7.cy, 3);

    // Continental coordinates (e.g. 2560x2048 tiles with cs=32 -> cx=80, cy=64, floor 15)
    const kCont = numericChunkKey(80, 64, 15);
    assert.strictEqual(kCont, ((15 << 24) | (80 << 12) | 64) >>> 0);
    const dCont = decodeNumericChunkKey(kCont);
    assert.strictEqual(dCont.z, 15);
    assert.strictEqual(dCont.cx, 80);
    assert.strictEqual(dCont.cy, 64);

    // Max 12-bit coordinates (4095, 4095, floor 15)
    const kMax = numericChunkKey(4095, 4095, 15);
    const dMax = decodeNumericChunkKey(kMax);
    assert.strictEqual(dMax.z, 15);
    assert.strictEqual(dMax.cx, 4095);
    assert.strictEqual(dMax.cy, 4095);

    // Collision check across 5,000 distinct coordinate pairs
    const seen = new Set();
    for (let z = 0; z < 4; z++) {
        for (let cx = 0; cx < 35; cx++) {
            for (let cy = 0; cy < 35; cy++) {
                const key = numericChunkKey(cx, cy, z);
                assert.ok(!seen.has(key), `Numeric key collision at z=${z}, cx=${cx}, cy=${cy}`);
                seen.add(key);
            }
        }
    }
    assert.strictEqual(seen.size, 4 * 35 * 35);
}

function testSpatialIndexNumericKeyBucketing() {
    const index = new SpatialIndex({ chunkSize: 32 });

    const e1 = { id: 101, x: 10, y: 10, z: 0 };
    const e2 = { id: 102, x: 20, y: 20, z: 0 };
    const e3 = { id: 103, x: 50, y: 50, z: 0 }; // cx=1, cy=1
    const e4 = { id: 104, x: 10, y: 10, z: 1 }; // z=1, cx=0, cy=0

    index.insert(e1);
    index.insert(e2);
    index.insert(e3);
    index.insert(e4);

    assert.strictEqual(index.size, 4);

    // Verify all keys in _chunks are numbers (zero string keys)
    for (const key of index._chunks.keys()) {
        assert.strictEqual(typeof key, 'number', 'chunk key must be a numeric primitive');
        assert.strictEqual(key, key >>> 0, 'chunk key must be unsigned 32-bit int');
    }

    // Check specific chunk keys
    const expectedKeyE1 = numericChunkKey(0, 0, 0);
    const expectedKeyE3 = numericChunkKey(1, 1, 0);
    const expectedKeyE4 = numericChunkKey(0, 0, 1);

    assert.ok(index._chunks.has(expectedKeyE1));
    assert.ok(index._chunks.has(expectedKeyE3));
    assert.ok(index._chunks.has(expectedKeyE4));

    // Verify _byId records have numeric chunk keys
    assert.strictEqual(index._byId.get(101).key, expectedKeyE1);
    assert.strictEqual(index._byId.get(103).key, expectedKeyE3);
    assert.strictEqual(index._byId.get(104).key, expectedKeyE4);

    // Verify numericKey helper matches
    assert.strictEqual(index.numericKey(10, 10, 0), expectedKeyE1);
    assert.strictEqual(index.numericKey(50, 50, 0), expectedKeyE3);
    assert.strictEqual(index.numericKey(10, 10, 1), expectedKeyE4);

    // Verify human-readable chunkKey still returns string for diagnostics
    assert.strictEqual(index.chunkKey(10, 10, 0), '0:0:0');
    assert.strictEqual(index.chunkKey(50, 50, 0), '0:1:1');
    assert.strictEqual(index.chunkKey(10, 10, 1), '1:0:0');

    // Update entity across chunks
    e1.x = 70;
    e1.y = 70;
    index.update(e1);
    const expectedKeyE1Moved = numericChunkKey(2, 2, 0);
    assert.strictEqual(index._byId.get(101).key, expectedKeyE1Moved);
    assert.ok(index._chunks.has(expectedKeyE1Moved));

    // Remove entity
    index.remove(102);
    assert.strictEqual(index.has(102), false);

    // Clear
    index.clear();
    assert.strictEqual(index.size, 0);
    assert.strictEqual(index._chunks.size, 0);
}

function testUnsortedByDefaultVsSorted() {
    const index = new SpatialIndex({ chunkSize: 32 });

    // Insert out-of-order IDs
    const e1 = { id: 500, x: 10, y: 10, z: 0 };
    const e2 = { id: 100, x: 12, y: 12, z: 0 };
    const e3 = { id: 300, x: 15, y: 15, z: 0 };
    const e4 = { id: 200, x: 40, y: 10, z: 0 }; // chunk (1, 0)
    const e5 = { id: 50, x: 45, y: 12, z: 0 };

    index.insert(e1);
    index.insert(e2);
    index.insert(e3);
    index.insert(e4);
    index.insert(e5);

    // 1. queryChunkCandidates: default is unsorted
    const unsortedCands = index.queryChunkCandidates(20, 10, 0, 30);
    assert.strictEqual(unsortedCands.length, 5);
    // Insertion order in chunk (0,0) is [500, 100, 300], then chunk (1,0) [200, 50]
    assert.deepStrictEqual(unsortedCands.map((e) => e.id), [500, 100, 300, 200, 50]);

    // With sort: true
    const sortedCands = index.queryChunkCandidates(20, 10, 0, 30, { sort: true });
    assert.strictEqual(sortedCands.length, 5);
    assert.deepStrictEqual(sortedCands.map((e) => e.id), [50, 100, 200, 300, 500]);

    // 2. queryRect: default unsorted, { sort: true } sorted
    const unsortedRect = index.queryRect(0, 0, 60, 30, 0);
    assert.deepStrictEqual(unsortedRect.map((e) => e.id), [500, 100, 300, 200, 50]);

    const sortedRect = index.queryRect(0, 0, 60, 30, 0, { sort: true });
    assert.deepStrictEqual(sortedRect.map((e) => e.id), [50, 100, 200, 300, 500]);

    // 3. queryChebyshev: default unsorted, { sort: true } sorted
    const unsortedCheb = index.queryChebyshev(20, 10, 0, 30, { livingOnly: false });
    assert.deepStrictEqual(unsortedCheb.map((e) => e.id), [500, 100, 300, 200, 50]);

    const sortedCheb = index.queryChebyshev(20, 10, 0, 30, { livingOnly: false, sort: true });
    assert.deepStrictEqual(sortedCheb.map((e) => e.id), [50, 100, 200, 300, 500]);

    // 4. queryNearObservers: default unsorted, { sort: true } sorted
    const obs = [{ x: 10, y: 10, z: 0 }, { x: 40, y: 10, z: 0 }];
    const unsortedNear = index.queryNearObservers(obs, 10);
    assert.deepStrictEqual(unsortedNear.map((e) => e.id), [500, 100, 300, 200, 50]);

    const sortedNear = index.queryNearObservers(obs, 10, { sort: true });
    assert.deepStrictEqual(sortedNear.map((e) => e.id), [50, 100, 200, 300, 500]);
}

function testWorldSpawnPinChunkSizing() {
    const world = makeWorld(null, multiFloorMap(200, 200));

    // Spawn pin spatial must be 64x64 chunks (Phase 5.3 §2.6 item 2)
    assert.strictEqual(world.spawnPinSpatial.chunkSize, 64, 'spawnPinSpatial must default to chunkSize 64');

    // Other spatials maintain standard 32x32 chunks
    assert.strictEqual(world.playerSpatial.chunkSize, 32, 'playerSpatial must remain chunkSize 32');
    assert.strictEqual(world.creatureSpatial.chunkSize, 32, 'creatureSpatial must remain chunkSize 32');
    assert.strictEqual(world.corpseSpatial.chunkSize, 32, 'corpseSpatial must remain chunkSize 32');
    assert.strictEqual(world.worldPinSpatial.chunkSize, 32, 'worldPinSpatial must remain chunkSize 32');

    // Configurable override via settings.spawnPinChunkSize
    const customWorld = makeWorld({ spawnPinChunkSize: 128 }, multiFloorMap(200, 200));
    assert.strictEqual(customWorld.spawnPinSpatial.chunkSize, 128);

    customWorld.stop();
    world.stop();
}

function testProximitySearchesBypassSorting() {
    const world = makeWorld(null, multiFloorMap(100, 100));

    // Connect players with various IDs
    const p1 = makeSession(world, ash(30), { x: 20, y: 20, z: 0 });
    const p2 = makeSession(world, ash(10), { x: 15, y: 15, z: 0 });
    const p3 = makeSession(world, ash(20), { x: 25, y: 25, z: 0 });

    // nearestPlayer should find p2 (dist 5 from 10, 10) correctly without requiring sorted candidates
    const nearest = world.nearestPlayer({ x: 10, y: 10, z: 0 }, 20);
    assert.ok(nearest);
    assert.strictEqual(nearest.character.id, 10);

    // broadcastToViewers should invoke callback for all visible players without error
    const seenViewers = [];
    world.broadcastToViewers(15, 15, 0, (p) => {
        seenViewers.push(p.character.id);
    });
    assert.ok(seenViewers.includes(10));
    assert.ok(seenViewers.includes(30));

    p1.kick();
    p2.kick();
    p3.kick();
    world.stop();
}

function testContinentalScaleBenchmark() {
    const index = new SpatialIndex({ chunkSize: 32 });

    // Continental scale: 4,000 entities spread over an 80x64 grid (2560x2048 tiles)
    const count = 4000;
    for (let i = 0; i < count; i++) {
        const x = (i * 37) % 2560;
        const y = (i * 53) % 2048;
        const z = i % 8;
        index.insert({ id: i + 1, x, y, z });
    }

    assert.strictEqual(index.size, count);

    // Verify all chunk keys are numeric
    for (const k of index._chunks.keys()) {
        assert.strictEqual(typeof k, 'number');
    }

    // Run 1,000 proximity candidate queries across the continent
    const t0 = Date.now();
    let totalFound = 0;
    for (let q = 0; q < 1000; q++) {
        const qx = (q * 71) % 2560;
        const qy = (q * 97) % 2048;
        const qz = q % 8;
        const cands = index.queryChunkCandidates(qx, qy, qz, 16);
        totalFound += cands.length;
    }
    const elapsedMs = Date.now() - t0;

    assert.ok(totalFound > 0, 'queries must find entities');
    // 1,000 spatial queries should complete in under 50ms with numeric keys and unsorted output
    assert.ok(elapsedMs < 100, `1000 queries took ${elapsedMs}ms, should be < 100ms`);

    index.clear();
    assert.strictEqual(index.size, 0);
}

function runAllTests() {
    testNumericChunkKeyEncodingDecoding();
    testSpatialIndexNumericKeyBucketing();
    testUnsortedByDefaultVsSorted();
    testWorldSpawnPinChunkSizing();
    testProximitySearchesBypassSorting();
    testContinentalScaleBenchmark();
    console.log('ok phase5_3_spatial_numeric_keys');
}

runAllTests();

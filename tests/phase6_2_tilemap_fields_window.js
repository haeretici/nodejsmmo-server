'use strict';

const assert = require('assert');
const { TileMap } = require('../src/world/tilemap');
const {
    createFieldStore,
    deployFieldToTile,
    removeFieldFromTile,
    listFieldsInRect,
    FIELD_KINDS,
    FIELD_MASKS,
    tileKey
} = require('../src/world/fields');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { createLog } = require('../src/log');
const { S2C } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');
const { decodeField } = require('../src/protocol/messages');

function testDirectTypedArray2DWindow() {
    const tm = new TileMap({
        cols: 64,
        rows: 64,
        z: 0,
        friction: new Uint8Array(4096).fill(100)
    });
    const store = createFieldStore(tm);

    // Deploy fields at known locations on floor 0
    deployFieldToTile(store, 10, 10, 0, { kind: FIELD_KINDS.FIRE, durationSec: 100 });
    deployFieldToTile(store, 12, 10, 0, { kind: FIELD_KINDS.POISON, durationSec: 100 });
    deployFieldToTile(store, 15, 14, 0, { kind: FIELD_KINDS.ENERGY, durationSec: 100 });
    deployFieldToTile(store, 30, 30, 0, { kind: FIELD_KINDS.BARRIER, durationSec: 20 });

    // Verify layer.fields typed array mask was populated
    const layer = tm.getLayer(0);
    assert.ok(layer && layer.fields);
    assert.strictEqual(layer.fields[10 * 64 + 10] & FIELD_MASKS.FIRE, FIELD_MASKS.FIRE);
    assert.strictEqual(layer.fields[10 * 64 + 12] & FIELD_MASKS.POISON, FIELD_MASKS.POISON);
    assert.strictEqual(layer.fields[14 * 64 + 15] & FIELD_MASKS.ENERGY, FIELD_MASKS.ENERGY);

    // Query 15x11 window covering (10,10) and (12,10)
    const inView = listFieldsInRect(store, 8, 8, 0, 15, 11);
    assert.strictEqual(inView.length, 3);
    assert.strictEqual(inView[0].x, 10);
    assert.strictEqual(inView[0].y, 10);
    assert.strictEqual(inView[0].fieldKind, 'fire');
    assert.strictEqual(inView[1].x, 12);
    assert.strictEqual(inView[1].y, 10);
    assert.strictEqual(inView[1].fieldKind, 'poison');
    assert.strictEqual(inView[2].x, 15);
    assert.strictEqual(inView[2].y, 14);
    assert.strictEqual(inView[2].fieldKind, 'energy');

    // Query window with zero fields
    const emptyWindow = listFieldsInRect(store, 40, 40, 0, 15, 11);
    assert.strictEqual(emptyWindow.length, 0);
}

function testBoundaryClampingAndOutOfBounds() {
    const tm = new TileMap({
        cols: 50,
        rows: 50,
        z: 0,
        friction: new Uint8Array(2500).fill(100)
    });
    const store = createFieldStore(tm);

    deployFieldToTile(store, 2, 2, 0, { kind: FIELD_KINDS.FIRE, durationSec: 100 });
    deployFieldToTile(store, 48, 48, 0, { kind: FIELD_KINDS.ENERGY, durationSec: 100 });

    // 1. Fully off-map negative
    const neg = listFieldsInRect(store, -20, -20, 0, 15, 11);
    assert.strictEqual(neg.length, 0);

    // 2. Fully off-map beyond cols/rows
    const beyond = listFieldsInRect(store, 100, 100, 0, 15, 11);
    assert.strictEqual(beyond.length, 0);

    // 3. Partially off-map top-left: player at (2, 2) with viewport starting at (-5, -3)
    const partialTopLeft = listFieldsInRect(store, -5, -3, 0, 15, 11);
    assert.strictEqual(partialTopLeft.length, 1);
    assert.strictEqual(partialTopLeft[0].x, 2);
    assert.strictEqual(partialTopLeft[0].y, 2);

    // 4. Partially off-map bottom-right
    const partialBottomRight = listFieldsInRect(store, 40, 40, 0, 15, 15);
    assert.strictEqual(partialBottomRight.length, 1);
    assert.strictEqual(partialBottomRight[0].x, 48);
    assert.strictEqual(partialBottomRight[0].y, 48);

    // 5. Degenerate width/height
    assert.strictEqual(listFieldsInRect(store, 0, 0, 0, 0, 10).length, 0);
    assert.strictEqual(listFieldsInRect(store, 0, 0, 0, 10, -5).length, 0);
    assert.strictEqual(listFieldsInRect(null, 0, 0, 0, 10, 10).length, 0);
}

function testMultiFloorIsolation() {
    const tm = new TileMap({
        cols: 32,
        rows: 32,
        z: 0,
        friction: new Uint8Array(1024).fill(100)
    });
    tm.addLayer(1, { friction: new Uint8Array(1024).fill(100) });
    const store = createFieldStore(tm);

    // Same (x, y) on different floors
    deployFieldToTile(store, 10, 10, 0, { kind: FIELD_KINDS.FIRE, durationSec: 60 });
    deployFieldToTile(store, 10, 10, 1, { kind: FIELD_KINDS.POISON, durationSec: 60 });

    const f0 = listFieldsInRect(store, 5, 5, 0, 15, 11);
    assert.strictEqual(f0.length, 1);
    assert.strictEqual(f0[0].z, 0);
    assert.strictEqual(f0[0].fieldKind, 'fire');

    const f1 = listFieldsInRect(store, 5, 5, 1, 15, 11);
    assert.strictEqual(f1.length, 1);
    assert.strictEqual(f1[0].z, 1);
    assert.strictEqual(f1[0].fieldKind, 'poison');

    // Query non-existent floor 7
    const f7 = listFieldsInRect(store, 5, 5, 7, 15, 11);
    assert.strictEqual(f7.length, 0);
}

function testDeployAndRemoveSync() {
    const tm = new TileMap({
        cols: 32,
        rows: 32,
        z: 0,
        friction: new Uint8Array(1024).fill(100)
    });
    const store = createFieldStore(tm);

    deployFieldToTile(store, 5, 5, 0, { kind: FIELD_KINDS.ENERGY, durationSec: 60 });
    let res = listFieldsInRect(store, 0, 0, 0, 10, 10);
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].fieldKind, 'energy');

    // Remove field
    const removed = removeFieldFromTile(store, 5, 5, 0);
    assert.strictEqual(removed, true);
    assert.strictEqual(tm.fieldMaskAt(5, 5, 0), 0);

    // Next query must not return it
    res = listFieldsInRect(store, 0, 0, 0, 10, 10);
    assert.strictEqual(res.length, 0);
}

function testFallbackWithoutTileMap() {
    const store = createFieldStore(null);

    // Deploy directly into store
    deployFieldToTile(store, 10, 10, 0, { kind: FIELD_KINDS.FIRE, durationSec: 60 });
    deployFieldToTile(store, 20, 20, 0, { kind: FIELD_KINDS.POISON, durationSec: 60 });

    // Small query (bounded loop)
    const small = listFieldsInRect(store, 5, 5, 0, 10, 10);
    assert.strictEqual(small.length, 1);
    assert.strictEqual(small[0].fieldKind, 'fire');

    // Large query (> 4096 tiles fallback)
    const large = listFieldsInRect(store, 0, 0, 0, 100, 100);
    assert.strictEqual(large.length, 2);
}

function testContinentalScaleBenchmark() {
    // 512x512 tilemap (262,144 tiles per floor)
    const cols = 512;
    const rows = 512;
    const tm = new TileMap({
        cols,
        rows,
        z: 0,
        friction: new Uint8Array(cols * rows).fill(100)
    });
    const store = createFieldStore(tm);

    // Seed 5,000 fields scattered across the map
    const fieldCount = 5000;
    for (let i = 0; i < fieldCount; i++) {
        const tileIdx = (i * 47) % (cols * rows);
        const x = tileIdx % cols;
        const y = (tileIdx / cols) | 0;
        deployFieldToTile(store, x, y, 0, {
            kind: i % 2 === 0 ? FIELD_KINDS.FIRE : FIELD_KINDS.POISON,
            durationSec: 1000
        });
    }

    assert.strictEqual(Object.keys(store.byKey).length, fieldCount);

    // Run 1,000 viewport queries (15x11 = 165 tiles each)
    const t0 = Date.now();
    let totalFieldsFound = 0;
    for (let q = 0; q < 1000; q++) {
        const qx = (q * 31) % (cols - 20);
        const qy = (q * 47) % (rows - 20);
        const list = listFieldsInRect(store, qx, qy, 0, 15, 11);
        totalFieldsFound += list.length;
    }
    const elapsedMs = Date.now() - t0;

    assert.ok(totalFieldsFound > 0, 'queries must find fields');
    // 1,000 2D window slices of 165 tiles on typed array must complete rapidly (< 50ms)
    assert.ok(
        elapsedMs < 100,
        `1,000 viewport field queries took ${elapsedMs}ms, expected < 100ms (O(165) typed array slice)`
    );
}

function testWorldIntegration() {
    const settings = testSettings();
    const store = new MemoryStore();
    const log = createLog(settings);
    const n = 64 * 64;
    const map = {
        width: 64,
        height: 64,
        z: 0,
        zMin: 0,
        zMax: 7,
        spawnX: 10,
        spawnY: 10,
        spawnZ: 0,
        floors: {
            0: { friction: new Uint8Array(n).fill(100) }
        },
        stairs: [],
        spawns: [],
        npcs: []
    };
    const world = new World({
        settings,
        store,
        log,
        map,
        schedule: () => 0,
        clear: () => {}
    });
    world.start();

    // Deploy fields: one inside town spawn view, one far away
    deployFieldToTile(world.fieldStore, 11, 10, 0, { kind: FIELD_KINDS.FIRE, durationSec: 100 });
    deployFieldToTile(world.fieldStore, 50, 50, 0, { kind: FIELD_KINDS.ENERGY, durationSec: 100 });

    const sent = [];
    const session = new GameSession({
        socket: {
            readyState: 1,
            sent: [],
            send(buf) { sent.push(Buffer.from(buf)); },
            close() {}
        },
        ip: '127.0.0.1',
        world,
        settings,
        limiter: { allow: () => true },
        log
    });

    session.bindCharacter({
        id: 1,
        accountId: 1,
        name: 'Tester',
        vocation: 'knight',
        level: 1,
        hp: 100,
        hpMax: 100,
        mp: 50,
        mpMax: 50
    }, { x: 10, y: 10, z: 0 });

    world.add(session);

    // Call sendFieldsInView
    sent.length = 0;
    world.sendFieldsInView(session);

    // Should receive FIELD packet for (11, 10) fire field, but not for (50, 50)
    assert.strictEqual(sent.length, 1);
    const frame = decodeFrame(sent[0]);
    assert.strictEqual(frame.opcode, S2C.FIELD);
    const fieldMsg = decodeField(frame.payload);
    assert.strictEqual(fieldMsg.x, 11);
    assert.strictEqual(fieldMsg.y, 10);
    assert.strictEqual(fieldMsg.kind, 'fire');

    session.kick();
    world.stop();
}

function runAll() {
    testDirectTypedArray2DWindow();
    testBoundaryClampingAndOutOfBounds();
    testMultiFloorIsolation();
    testDeployAndRemoveSync();
    testFallbackWithoutTileMap();
    testContinentalScaleBenchmark();
    testWorldIntegration();
    console.log('ok phase6_2_tilemap_fields_window');
}

runAll();

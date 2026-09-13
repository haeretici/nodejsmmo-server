'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { SpatialIndex } = require('../src/world/spatial_index');
const { S2C, REASON } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function framesOf(sock, opcode) {
    const out = [];
    for (let i = 0; i < sock.sent.length; i++) {
        const f = decodeFrame(sock.sent[i]);
        if (f.opcode === opcode) out.push(f);
    }
    return out;
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

function testSpatialIndexBasics() {
    const index = new SpatialIndex({ chunkSize: 32 });
    assert.strictEqual(index.chunkSize, 32);
    assert.strictEqual(index.size, 0);

    // Chunk keys
    assert.strictEqual(index.chunkKey(0, 0, 0), '0:0:0');
    assert.strictEqual(index.chunkKey(31, 31, 0), '0:0:0');
    assert.strictEqual(index.chunkKey(32, 0, 0), '0:1:0');
    assert.strictEqual(index.chunkKey(0, 32, 1), '1:0:1');
    assert.strictEqual(index.chunkKey(65, 99, 7), '7:2:3');

    // Insert entities
    const e1 = { id: 101, x: 10, y: 10, z: 0 };
    const e2 = { id: 102, x: 20, y: 20, z: 0 };
    const e3 = { id: 103, x: 50, y: 50, z: 0 }; // chunk 0:1:1
    const e4 = { id: 104, x: 10, y: 10, z: 1 }; // floor 1

    assert.ok(index.insert(e1));
    assert.ok(index.insert(e2));
    assert.ok(index.insert(e3));
    assert.ok(index.insert(e4));
    assert.strictEqual(index.size, 4);

    assert.strictEqual(index.has(101), true);
    assert.strictEqual(index.has(999), false);
    assert.strictEqual(index.get(101), e1);

    // Query candidates in chunk 0:0:0 (radius 5 around 10,10,0)
    const candsLocal = index.queryChunkCandidates(10, 10, 0, 5);
    assert.strictEqual(candsLocal.length, 2);
    assert.deepStrictEqual(candsLocal.map((e) => e.id), [101, 102]);

    // Query across chunk boundaries (overlapping 0:0:0 and 0:1:1)
    const candsCross = index.queryChunkCandidates(30, 30, 0, 10);
    assert.strictEqual(candsCross.length, 3);
    assert.deepStrictEqual(candsCross.map((e) => e.id), [101, 102, 103]);

    // Floor isolation
    const candsFloor1 = index.queryChunkCandidates(10, 10, 1, 5);
    assert.strictEqual(candsFloor1.length, 1);
    assert.strictEqual(candsFloor1[0].id, 104);

    // Query rect
    const rectCands = index.queryRect(0, 0, 25, 25, 0);
    assert.strictEqual(rectCands.length, 2);
    assert.deepStrictEqual(rectCands.map((e) => e.id), [101, 102]);

    // Update entity position across chunks
    e1.x = 70;
    e1.y = 70;
    index.update(e1);
    assert.strictEqual(index.chunkKey(e1.x, e1.y, e1.z), '0:2:2');

    const candsAfterMove = index.queryChunkCandidates(10, 10, 0, 5);
    assert.strictEqual(candsAfterMove.length, 1);
    assert.strictEqual(candsAfterMove[0].id, 102);

    // Remove
    assert.ok(index.remove(102));
    assert.strictEqual(index.size, 3);
    assert.strictEqual(index.has(102), false);

    // Clear
    index.clear();
    assert.strictEqual(index.size, 0);
}

function testSpatialIndexChebyshevFilter() {
    const index = new SpatialIndex({ chunkSize: 32 });
    const living = { id: 1, x: 10, y: 10, z: 0, hp: 100, dead: false, downed: false };
    const dead = { id: 2, x: 11, y: 10, z: 0, hp: 0, dead: true, downed: false };
    const downed = { id: 3, x: 12, y: 10, z: 0, hp: 100, dead: false, downed: true };
    const far = { id: 4, x: 25, y: 10, z: 0, hp: 100, dead: false, downed: false };

    index.insert(living);
    index.insert(dead);
    index.insert(downed);
    index.insert(far);

    // Chebyshev radius 5 with livingOnly = true
    const result = index.queryChebyshev(10, 10, 0, 5, { livingOnly: true });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 1);

    // Without livingOnly filter
    const allNearby = index.queryChebyshev(10, 10, 0, 5, { livingOnly: false });
    assert.strictEqual(allNearby.length, 3);
    assert.deepStrictEqual(allNearby.map((e) => e.id), [1, 2, 3]);
}

function testWorldSpatialTrackingOnJoinLeaveMove() {
    const world = makeWorld(null, multiFloorMap(128, 128));
    assert.ok(world.playerSpatial instanceof SpatialIndex);
    assert.ok(world.creatureSpatial instanceof SpatialIndex);
    assert.strictEqual(world.playerSpatial.size, 0);
    assert.strictEqual(world.creatureSpatial.size, 0);

    // Add player
    const s1 = makeSession(world, ash(10), { x: 5, y: 5, z: 0 });
    assert.strictEqual(world.playerSpatial.size, 1);
    assert.strictEqual(world.playerSpatial.has(10), true);

    // Spawn creature
    const rat = world.spawnCreature('rat', 6, 5, 0);
    assert.strictEqual(world.creatureSpatial.size, 1);
    assert.strictEqual(world.creatureSpatial.has(rat.id), true);

    // Move player via tileMap.moveEntityToTile -> should update playerSpatial
    world.tileMap.moveEntityToTile(40, 40, 0, s1);
    assert.strictEqual(s1.x, 40);
    assert.strictEqual(s1.y, 40);
    const inOldChunk = world.playerSpatial.queryChunkCandidates(5, 5, 0, 10);
    assert.strictEqual(inOldChunk.length, 0);
    const inNewChunk = world.playerSpatial.queryChunkCandidates(40, 40, 0, 10);
    assert.strictEqual(inNewChunk.length, 1);
    assert.strictEqual(inNewChunk[0].id, 10);

    // Move creature via tileMap.moveEntityToTile -> should update creatureSpatial
    world.tileMap.moveEntityToTile(42, 40, 0, rat);
    assert.strictEqual(rat.x, 42);
    assert.strictEqual(rat.y, 40);
    const crInNew = world.creatureSpatial.queryChunkCandidates(40, 40, 0, 10);
    assert.strictEqual(crInNew.length, 1);
    assert.strictEqual(crInNew[0].id, rat.id);

    // Kill creature -> removed from creatureSpatial and added to corpseSpatial
    world.kill(rat, s1, 1);
    assert.strictEqual(world.creatureSpatial.size, 0);
    assert.strictEqual(world.creatureSpatial.has(rat.id), false);
    assert.strictEqual(world.corpseSpatial.size, 1);

    // Leave player -> removed from playerSpatial
    world.leave(s1);
    assert.strictEqual(world.playerSpatial.size, 0);
    assert.strictEqual(world.playerSpatial.has(10), false);

    world.stop();
}

function testNearestPlayerUsesSpatialCandidates() {
    const world = makeWorld(null, multiFloorMap(128, 128));
    const pNear = makeSession(world, ash(1), { x: 10, y: 10, z: 0 });
    const pFar = makeSession(world, ash(2), { x: 80, y: 80, z: 0 });
    const pDiffFloor = makeSession(world, ash(3), { x: 11, y: 10, z: 1 });

    const origin = { x: 12, y: 10, z: 0 };
    // Within range 5: only pNear qualifies
    const nearest = world.nearestPlayer(origin, 5);
    assert.ok(nearest);
    assert.strictEqual(nearest.character.id, 1);

    // Within range 1: none qualify
    assert.strictEqual(world.nearestPlayer(origin, 1), null);

    world.stop();
}

function testBroadcastToViewersScopedToCandidates() {
    const world = makeWorld(null, multiFloorMap(128, 128));
    const pNear = makeSession(world, ash(1), { x: 10, y: 10, z: 0 });
    const pFar = makeSession(world, ash(2), { x: 90, y: 90, z: 0 });

    let nearCalled = 0;
    let farCalled = 0;

    world.broadcastToViewers(12, 10, 0, (p) => {
        if (p.character.id === 1) nearCalled += 1;
        if (p.character.id === 2) farCalled += 1;
    });

    assert.strictEqual(nearCalled, 1, 'near observer receives broadcast');
    assert.strictEqual(farCalled, 0, 'far observer in distant chunk is skipped');

    world.stop();
}

function testBroadcastMoveScopedToLocalChunks() {
    const world = makeWorld(null, multiFloorMap(128, 128));
    const pWalker = makeSession(world, ash(1), { x: 10, y: 10, z: 0 });
    const pNear = makeSession(world, ash(2), { x: 12, y: 10, z: 0 });
    const pFar = makeSession(world, ash(3), { x: 90, y: 90, z: 0 });

    // Spawn a rat near walker
    const ratNear = world.spawnCreature('rat', 14, 10, 0);
    // Spawn a rat far from walker
    const ratFar = world.spawnCreature('rat', 85, 85, 0);

    pNear.socket.sent.length = 0;
    pFar.socket.sent.length = 0;
    pWalker.socket.sent.length = 0;

    // Move walker 1 tile east
    const from = { x: 10, y: 10, z: 0 };
    world.tileMap.moveEntityToTile(11, 10, 0, pWalker);
    world.broadcastMove(pWalker, from, 'east');

    // pNear is in view -> should receive MOVE frame for pWalker
    const nearMoves = framesOf(pNear.socket, S2C.MOVE);
    assert.strictEqual(nearMoves.length, 1);

    // pFar is far away -> should NOT receive any frames
    assert.strictEqual(pFar.socket.sent.length, 0);

    world.stop();
}

function testSpawnPinChunkBucketing() {
    const settings = testSettings();
    delete settings.spawns;
    delete settings.npcs;
    settings.spawnActivateMargin = 0;
    settings.spawnDespawnIdleTicks = 0;
    settings.logicUps = 20;

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
            { kind: 'rat', x: 12, y: 10, z: 0, respawn: 1 },    // Near (10, 10)
            { kind: 'rat', x: 100, y: 100, z: 0, respawn: 1 }  // Far (100, 100) in chunk 3:3
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

    assert.strictEqual(world.spawnPins.length, 2);
    assert.ok(world.spawnPinSpatial instanceof SpatialIndex);
    assert.strictEqual(world.spawnPinSpatial.size, 2);

    // With no players, 0 creatures should be active
    assert.strictEqual(world.creatures.size, 0);

    // Player enters at (10, 10)
    const session = makeSession(world, ash(1), { x: 10, y: 10, z: 0 });

    // Only near pin at (12, 10) should activate into living creature!
    assert.strictEqual(world.creatures.size, 1);
    const activeRat = Array.from(world.creatures.values())[0];
    assert.strictEqual(activeRat.x, 12);
    assert.strictEqual(activeRat.y, 10);

    // Far pin at (100, 100) remains idle
    const farPin = world.spawnPins[1];
    assert.strictEqual(farPin.state, 'idle');
    assert.strictEqual(farPin.entityId, 0);

    world.leave(session);
    world.stop();
}

function main() {
    testSpatialIndexBasics();
    testSpatialIndexChebyshevFilter();
    testWorldSpatialTrackingOnJoinLeaveMove();
    testNearestPlayerUsesSpatialCandidates();
    testBroadcastToViewersScopedToCandidates();
    testBroadcastMoveScopedToLocalChunks();
    testSpawnPinChunkBucketing();
    console.log('ok phase3_optimizations');
}

main();

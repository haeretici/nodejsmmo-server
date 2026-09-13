'use strict';

const assert = require('assert');
const Cooldowns = require('../src/world/cooldowns');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C, REASON } = require('../src/protocol/opcodes');
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

function makeWorld(extra) {
    const settings = testSettings();
    if (extra) Object.assign(settings, extra);
    const store = new MemoryStore();
    const log = createLog(settings);
    const world = new World({
        settings,
        store,
        log,
        schedule: () => 0,
        clear: () => {},
        rng: () => 0.5
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

function testTimestampCooldowns() {
    const entity = { cooldowns: null };
    Cooldowns.ensureCooldowns(entity);

    assert.strictEqual(Cooldowns.canUse(entity, { primary: { attack: 2 } }, 0), true);
    assert.strictEqual(Cooldowns.getRemaining(entity, 'primary', 'attack', 0), 0);
    assert.strictEqual(Cooldowns.isReady(entity, 'primary', 'attack', 0), true);

    // Apply cooldown at t = 1.0 for 2.0s duration -> readyAt = 3.0s
    Cooldowns.apply(entity, { primary: { attack: 2 } }, 1.0);
    assert.strictEqual(Cooldowns.canUse(entity, { primary: { attack: 2 } }, 1.0), false);
    assert.strictEqual(Cooldowns.canUse(entity, { primary: { attack: 2 } }, 2.99), false);
    assert.strictEqual(Cooldowns.isReady(entity, 'primary', 'attack', 2.5), false);
    assert.strictEqual(Math.round(Cooldowns.getRemaining(entity, 'primary', 'attack', 2.0) * 10) / 10, 1.0);

    // At t = 3.0, it becomes ready
    assert.strictEqual(Cooldowns.canUse(entity, { primary: { attack: 2 } }, 3.0), true);
    assert.strictEqual(Cooldowns.isReady(entity, 'primary', 'attack', 3.0), true);
    assert.strictEqual(Cooldowns.getRemaining(entity, 'primary', 'attack', 3.0), 0);
    assert.strictEqual(Cooldowns.getRemaining(entity, 'primary', 'attack', 4.0), 0);

    // Test tryUse
    assert.strictEqual(Cooldowns.tryUse(entity, { item: { use: 1.5 } }, 5.0), true);
    assert.strictEqual(Cooldowns.canUse(entity, { item: { use: 1.5 } }, 5.5), false);
    assert.strictEqual(Cooldowns.canUse(entity, { item: { use: 1.5 } }, 6.5), true);

    // Cooldowns.tick is a no-op that doesn't throw or alter timestamps
    Cooldowns.tick(entity, 0.5);
    assert.strictEqual(Cooldowns.canUse(entity, { item: { use: 1.5 } }, 5.5), false);
}

function testIntentQueueInPlaceTruncation() {
    const world = makeWorld();
    const session = makeSession(world, { id: 10, name: 'Tester', vocation: 'ranger', level: 1 });

    const qRef = session.intentQueue;
    session.intentQueue.push({ opcode: C2S.PING, payload: Buffer.alloc(8) });
    session.intentQueue.push({ opcode: C2S.PING, payload: Buffer.alloc(8) });
    assert.strictEqual(session.intentQueue.length, 2);

    world.step(1);

    // Queue must be truncated in-place (same Array reference, length = 0)
    assert.strictEqual(session.intentQueue, qRef);
    assert.strictEqual(session.intentQueue.length, 0);

    session.kick(REASON.LOGOUT);
    world.stop();
}

function testMonotonicCorpseQueue() {
    const world = makeWorld({ corpseDecayTicks: 5 });

    const c1 = { id: 2001, bornTick: 1, x: 10, y: 10, z: 0 };
    const c2 = { id: 2002, bornTick: 3, x: 11, y: 10, z: 0 };
    const c3 = { id: 2003, bornTick: 6, x: 12, y: 10, z: 0 };

    world.corpses.set(c1.id, c1);
    world.corpseQueue.push(c1);
    world.corpses.set(c2.id, c2);
    world.corpseQueue.push(c2);
    world.corpses.set(c3.id, c3);
    world.corpseQueue.push(c3);

    // At tick 5: c1 (born 1) -> 5 - 1 = 4 < 5 -> none decay
    world.tickCorpses(5);
    assert.strictEqual(world.corpses.size, 3);
    assert.strictEqual(world.corpseQueue.length, 3);

    // At tick 6: c1 (born 1) -> 6 - 1 = 5 >= 5 -> c1 decays; c2 (born 3) -> 6 - 3 = 3 < 5 -> early break!
    world.tickCorpses(6);
    assert.strictEqual(world.corpses.has(2001), false);
    assert.strictEqual(world.corpses.size, 2);
    assert.strictEqual(world.corpseQueue[0].id, 2002);

    // At tick 8: c2 (born 3) -> 8 - 3 = 5 >= 5 -> c2 decays; c3 (born 6) -> 8 - 6 = 2 < 5 -> early break!
    world.tickCorpses(8);
    assert.strictEqual(world.corpses.has(2002), false);
    assert.strictEqual(world.corpses.size, 1);
    assert.strictEqual(world.corpseQueue[0].id, 2003);

    // At tick 11: c3 (born 6) -> 11 - 6 = 5 >= 5 -> c3 decays
    world.tickCorpses(11);
    assert.strictEqual(world.corpses.size, 0);
    assert.strictEqual(world.corpseQueue.length, 0);

    world.stop();
}

function testMonotonicPendingSpawns() {
    const world = makeWorld();

    world.enqueuePendingSpawn({ kind: 'goblin', x: 5, y: 5, z: 0, at: 30 });
    world.enqueuePendingSpawn({ kind: 'rat', x: 1, y: 1, z: 0, at: 10 });
    world.enqueuePendingSpawn({ kind: 'spider', x: 2, y: 2, z: 0, at: 20 });
    world.enqueuePendingSpawn({ kind: 'wolf', x: 3, y: 3, z: 0, at: 15 });

    // Verify binary-search insertion maintains strictly ascending order by `at`
    assert.deepStrictEqual(world.pendingSpawns.map((s) => s.at), [10, 15, 20, 30]);

    // At tick 9: head is at 10 -> early break, none spawn
    world.tickRespawns(9);
    assert.strictEqual(world.pendingSpawns.length, 4);

    // At tick 12: head at 10 pops and spawns; next head is at 15 -> early break!
    world.tickRespawns(12);
    assert.strictEqual(world.pendingSpawns.length, 3);
    assert.strictEqual(world.pendingSpawns[0].at, 15);

    world.stop();
}

function main() {
    testTimestampCooldowns();
    testIntentQueueInPlaceTruncation();
    testMonotonicCorpseQueue();
    testMonotonicPendingSpawns();
    console.log('ok phase1_optimizations');
}

main();

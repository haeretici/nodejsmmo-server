'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { REASON } = require('../src/protocol/opcodes');
const { chebyshev } = require('../src/world/combat');
const { TILE_FLAG_PZ_PACKAGE } = require('../src/world/tilemap');

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
        spawnX: 0,
        spawnY: 0,
        spawnZ: 0,
        floors: { 0: { friction: new Uint8Array(n).fill(100) } },
        stairs: [],
        spawns: [],
        npcs: []
    };
}

const peacefulRat = Object.freeze({
    id: 'peaceful_rat',
    label: 'Peaceful Rat',
    hp: 30,
    hpMax: 30,
    armor: 1,
    mitigation: 0.1,
    maxBlock: 0,
    canBlock: false,
    exp: 10,
    aggro: false,
    resists: Object.freeze({ physical: 0 }),
    speed: 100,
    flags: Object.freeze({
        targetDistance: 1,
        aggroRange: 7,
        loseTargetDistance: 12,
        pushable: true,
        canPushCreatures: false
    }),
    attacks: Object.freeze([]),
    loot: Object.freeze([])
});

function makeWorld(extra, map) {
    const settings = testSettings();
    settings.creatureStepDelayTicks = 1;
    settings.stepDelayTicks = 1;
    settings.aiCreatureSleep = true;
    settings.aiTickRadius = 12;
    if (extra) Object.assign(settings, extra);
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        rng: extra && extra.rng ? extra.rng : (() => 0.5),
        templates: extra && extra.templates,
        map: map || extra && extra.map || openMap(40, 40)
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

function ash(id, extra) {
    return Object.assign({
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
    }, extra || {});
}

function main() {
    // Rat near player, aggro false: at least one cardinal step in N ticks
    const wWander = makeWorld({
        templates: { peaceful_rat: peacefulRat },
        spawns: [{ kind: 'peaceful_rat', x: 5, y: 5, z: 0 }]
    });
    const near = makeSession(wWander, ash(1), { x: 8, y: 5, z: 0 });
    const idleRat = Array.from(wWander.creatures.values())[0];
    assert.ok(idleRat);
    assert.strictEqual(idleRat.aggro, false);
    assert.ok(wWander.activeCreatures.has(idleRat));
    const spawnKey = `${idleRat.x},${idleRat.y}`;
    let stepped = false;
    for (let t = 1; t <= 10; t++) {
        wWander.step(t);
        assert.strictEqual(idleRat.targetId, 0, 'aggro false must not acquire');
        if (`${idleRat.x},${idleRat.y}` !== spawnKey) {
            stepped = true;
            break;
        }
    }
    assert.ok(stepped, 'idle rat near player takes at least one step');
    const dStep = chebyshev(idleRat.x, idleRat.y, 5, 5);
    assert.ok(dStep >= 1, 'wander moved off spawn');
    near.kick(REASON.LOGOUT);
    wWander.stop();

    // Before acquire: think not due, aggro true still shuffles
    const wBefore = makeWorld({
        aiCreatureThinkIntervalSec: 1,
        spawns: [{ kind: 'rat', x: 5, y: 5, z: 0 }]
    });
    const scout = makeSession(wBefore, ash(2), { x: 8, y: 5, z: 0 });
    const waiting = Array.from(wBefore.creatures.values())[0];
    waiting._creatureThinkNextAt = 1e9;
    const beforeKey = `${waiting.x},${waiting.y}`;
    let beforeStep = false;
    for (let t = 1; t <= 10; t++) {
        wBefore.step(t);
        assert.strictEqual(waiting.targetId, 0, 'must not acquire before think');
        if (`${waiting.x},${waiting.y}` !== beforeKey) {
            beforeStep = true;
            break;
        }
    }
    assert.ok(beforeStep, 'rat shuffles before acquire while player is in AOI');
    scout.kick(REASON.LOGOUT);
    wBefore.stop();

    // Pull off spawn, lose target: path home and restore HP
    const wLeash = makeWorld({
        autoIntervalTicks: 1000,
        spawns: [{ kind: 'rat', x: 2, y: 2, z: 0 }]
    });
    const hunter = makeSession(wLeash, ash(3), { x: 6, y: 2, z: 0 });
    const pulled = Array.from(wLeash.creatures.values())[0];
    assert.strictEqual(pulled.spawnX, 2);
    assert.strictEqual(pulled.spawnY, 2);
    let offHome = false;
    for (let t = 1; t <= 12; t++) {
        wLeash.step(t);
        if (pulled.x !== pulled.spawnX || pulled.y !== pulled.spawnY) {
            offHome = true;
            break;
        }
    }
    assert.ok(offHome, 'aggro rat walks off spawn toward player');
    pulled.hp = 5;
    assert.ok(pulled.hp < pulled.hpMax);
    wLeash.tileMap.moveEntityToTile(hunter, 30, 30, 0);
    hunter.x = 30;
    hunter.y = 30;
    let home = false;
    for (let t = 20; t <= 80; t++) {
        wLeash.step(t);
        if (pulled.x === pulled.spawnX && pulled.y === pulled.spawnY && (pulled.z | 0) === (pulled.spawnZ | 0)) {
            home = true;
            break;
        }
    }
    assert.ok(home, 'creature paths home after losing target');
    assert.strictEqual(pulled.hp, pulled.hpMax, 'HP restored on arriving spawn');
    assert.strictEqual(pulled.leashing, false);
    hunter.kick(REASON.LOGOUT);
    wLeash.stop();

    // No player in AOI: sleeping creatures do not wander
    const wSleep = makeWorld({
        templates: { peaceful_rat: peacefulRat },
        spawns: [{ kind: 'peaceful_rat', x: 2, y: 2, z: 0 }]
    }, openMap(80, 80));
    const far = makeSession(wSleep, ash(4), { x: 50, y: 50, z: 0 });
    const sleeping = Array.from(wSleep.creatures.values())[0];
    for (let t = 1; t <= 20; t++) wSleep.step(t);
    assert.strictEqual(sleeping.simSleeping, true, 'far creature sleeps');
    assert.strictEqual(wSleep.activeCreatures.has(sleeping), false);
    assert.strictEqual(sleeping.x, 2, 'sleeping creature does not wander');
    assert.strictEqual(sleeping.y, 2);
    far.kick(REASON.LOGOUT);
    wSleep.stop();

    // Zero players: virtualized / sleeping bodies never shuffle
    const wEmpty = makeWorld({
        templates: { peaceful_rat: peacefulRat },
        spawns: [{ kind: 'peaceful_rat', x: 4, y: 4, z: 0 }]
    });
    const alone = Array.from(wEmpty.creatures.values())[0];
    for (let t = 1; t <= 15; t++) wEmpty.step(t);
    assert.strictEqual(alone.simSleeping, true);
    assert.strictEqual(wEmpty.activeCreatures.size, 0);
    assert.strictEqual(alone.x, 4);
    assert.strictEqual(alone.y, 4);
    wEmpty.stop();

    // Sticky chase into PZ: drop target, keep moving, no damage (engine hunt_ai PZ).
    const wPz = makeWorld({
        autoIntervalTicks: 1,
        spawns: [{ kind: 'rat', x: 2, y: 2, z: 0 }]
    });
    const pzPlayer = makeSession(wPz, ash(5), { x: 6, y: 2, z: 0 });
    const chaser = Array.from(wPz.creatures.values())[0];
    wPz.tileMap.setTileFlags(8, 2, 0, TILE_FLAG_PZ_PACKAGE);
    wPz.tileMap.setTileFlags(9, 2, 0, TILE_FLAG_PZ_PACKAGE);
    wPz.tileMap.setTileFlags(8, 3, 0, TILE_FLAG_PZ_PACKAGE);
    wPz.tileMap.setTileFlags(9, 3, 0, TILE_FLAG_PZ_PACKAGE);
    assert.strictEqual(wPz.tileMap.attackMayAffectTile(8, 2, 0), false);
    assert.strictEqual(wPz.tileMap.isProtectionZonePackage(8, 2, 0), true);
    let acquired = false;
    for (let t = 1; t <= 12; t++) {
        wPz.step(t);
        if (chaser.targetId === pzPlayer.id) {
            acquired = true;
            break;
        }
    }
    assert.ok(acquired, 'rat acquires player off PZ');
    assert.ok(
        chaser.x !== chaser.spawnX || chaser.y !== chaser.spawnY,
        'rat left spawn while chasing'
    );
    assert.ok(wPz.tileMap.moveEntityToTile(8, 2, 0, pzPlayer));
    const hpOnPz = pzPlayer.hp | 0;
    const freezeX = chaser.x | 0;
    const freezeY = chaser.y | 0;
    let movedAfterPz = false;
    for (let t = 20; t <= 40; t++) {
        wPz.step(t);
        assert.strictEqual(chaser.targetId, 0, 'PZ drops sticky creature target');
        assert.strictEqual(pzPlayer.hp | 0, hpOnPz, 'no harmful hits into PZ');
        if ((chaser.x | 0) !== freezeX || (chaser.y | 0) !== freezeY) {
            movedAfterPz = true;
        }
    }
    assert.ok(movedAfterPz, 'creature keeps moving after target enters PZ');
    pzPlayer.kick(REASON.LOGOUT);
    wPz.stop();

    // Already on PZ: never acquire
    const wPzIdle = makeWorld({
        autoIntervalTicks: 1,
        spawns: [{ kind: 'rat', x: 5, y: 5, z: 0 }]
    });
    wPzIdle.tileMap.setTileFlags(8, 5, 0, TILE_FLAG_PZ_PACKAGE);
    const safe = makeSession(wPzIdle, ash(6), { x: 8, y: 5, z: 0 });
    const idleChaser = Array.from(wPzIdle.creatures.values())[0];
    const idleKey = `${idleChaser.x},${idleChaser.y}`;
    let idleStepped = false;
    for (let t = 1; t <= 12; t++) {
        wPzIdle.step(t);
        assert.strictEqual(idleChaser.targetId, 0, 'must not aggro a player on PZ');
        if (`${idleChaser.x},${idleChaser.y}` !== idleKey) idleStepped = true;
    }
    assert.ok(idleStepped, 'awake creature still wanders while player is on PZ');
    safe.kick(REASON.LOGOUT);
    wPzIdle.stop();

    console.log('ok combat_creature_ai');
}

main();

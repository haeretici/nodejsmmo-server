'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { createStaticMap } = require('../src/world/static_map');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function testPack() {
    return {
        features: { runeConsumption: true, skillProgression: true, expProgression: true },
        classes: {
            classes: [{
                id: 'mystic',
                hpPerLevel: 10,
                mpPerLevel: 10,
                critChance: 5,
                critDamage: 10,
                spells: ['delayed_blast', 'delayed_mine'],
                skillRates: { melee: 1.0, fist: 1.0, magic: 1.0 }
            }]
        },
        spells: {
            spells: [
                {
                    id: 'delayed_blast',
                    kind: 'spell',
                    element: 'fire',
                    min: 20,
                    max: 30,
                    range: 5,
                    mana: 10,
                    hitChance: 100,
                    isMelee: false,
                    vocations: ['mystic'],
                    level: 1,
                    delaySec: 1.0,
                    delayPlaceRange: 4,
                    shape: { type: 'area', code: 1 },
                    cooldowns: { primary: { attack: 1 } }
                },
                {
                    id: 'delayed_mine',
                    kind: 'spell',
                    element: 'energy',
                    min: 30,
                    max: 45,
                    range: 5,
                    mana: 15,
                    hitChance: 100,
                    isMelee: false,
                    vocations: ['mystic'],
                    level: 1,
                    delaySec: 0.5,
                    delayPlaceRange: 4,
                    shape: { type: 'area', code: 1 },
                    cooldowns: { primary: { attack: 1 } }
                }
            ]
        },
        equipment: {
            items: []
        }
    };
}

function makeWorld(extra) {
    const settings = testSettings();
    if (extra) Object.assign(settings, extra);
    const pack = extra && extra.pack ? extra.pack : testPack();
    const map = extra && extra.map ? extra.map : createStaticMap();
    const world = new World({
        settings,
        store: extra && extra.store ? extra.store : new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        rng: () => 0.5,
        pack,
        map
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

function testBinarySearchInsertionOrder() {
    const world = makeWorld();

    // Enqueue elements out of chronological order
    world.enqueueDelayedCast({ id: 5, readyAt: 5.0 });
    world.enqueueDelayedCast({ id: 1, readyAt: 1.0 });
    world.enqueueDelayedCast({ id: 3, readyAt: 3.0 });
    world.enqueueDelayedCast({ id: 2, readyAt: 2.0 });
    world.enqueueDelayedCast({ id: 4, readyAt: 4.0 });

    assert.deepStrictEqual(
        world.delayedCasts.map((c) => c.readyTick),
        [20, 40, 60, 80, 100]
    );
    assert.deepStrictEqual(
        world.delayedCasts.map((c) => c.id),
        [1, 2, 3, 4, 5]
    );
    for (let i = 0; i < world.delayedCasts.length; i++) {
        assert.strictEqual(world.delayedCasts[i].readyAt, undefined);
    }

    world.enqueueDelayedCast({ id: 31, readyAt: 3.0 });
    world.enqueueDelayedCast({ id: 32, readyAt: 3.0 });
    const at3 = world.delayedCasts.filter((c) => c.readyTick === 60);
    assert.deepStrictEqual(at3.map((c) => c.id), [3, 31, 32]);

    world.enqueueDelayedCast({ id: 60, readyTick: 120 });
    const item60 = world.delayedCasts.find((c) => c.id === 60);
    assert.ok(item60);
    assert.strictEqual(item60.readyTick, 120);
    assert.strictEqual(item60.readyAt, undefined);

    world.stop();
}

function testO1EarlyExitAndNoArrayAllocation() {
    const world = makeWorld();

    // Schedule cast 50 ticks in future (at 20 UPS -> t = 2.5s)
    world.enqueueDelayedCast({ id: 'future', readyAt: 2.5, readyTick: 50 });

    const originalQueueRef = world.delayedCasts;
    let runCastCalled = 0;
    world.runCast = () => { runCastCalled++; };

    // Tick from tickIndex 0 to 49 (before expiry)
    for (let t = 0; t < 50; t++) {
        const now = t / 20;
        world.tickDelayedCasts(t, now);
        // Queue reference must NOT change (no `keep = []` per-tick allocation)
        assert.strictEqual(world.delayedCasts, originalQueueRef);
        assert.strictEqual(world.delayedCasts.length, 1);
        assert.strictEqual(runCastCalled, 0);
    }

    world.stop();
}

function makeDummyPlayer(id, extra) {
    return Object.assign({
        id,
        alive: true,
        hp: 100,
        type: 'player',
        kick() {}
    }, extra || {});
}

function testExactDiscreteTickDetonation() {
    const world = makeWorld();

    let detonated = [];
    world.runCast = (_caster, spell, opts) => {
        detonated.push({ spell, opts });
    };

    const dummyCaster = makeDummyPlayer(99, { hp: 100 });
    world.entities = world.entities || new Map();
    world.players.set(dummyCaster.id, dummyCaster);

    world.enqueueDelayedCast({
        casterId: 99,
        spell: { id: 'test_bomb' },
        center: { x: 10, y: 10, z: 0 },
        readyAt: 2.5,
        readyTick: 50
    });

    world.enqueueDelayedCast({
        casterId: 99,
        spell: { id: 'later_bomb' },
        center: { x: 15, y: 15, z: 0 },
        readyAt: 4.0,
        readyTick: 80
    });

    // Tick at 49 -> no detonation
    world.tickDelayedCasts(49, 49 / 20);
    assert.strictEqual(detonated.length, 0);
    assert.strictEqual(world.delayedCasts.length, 2);

    // Tick exactly at 50 -> test_bomb detonates, later_bomb remains in queue
    world.tickDelayedCasts(50, 50 / 20);
    assert.strictEqual(detonated.length, 1);
    assert.strictEqual(detonated[0].spell.id, 'test_bomb');
    assert.strictEqual(detonated[0].opts.detonate, true);
    assert.strictEqual(detonated[0].opts.aim.x, 10);
    assert.strictEqual(world.delayedCasts.length, 1);
    assert.strictEqual(world.delayedCasts[0].spell.id, 'later_bomb');

    // Tick at 79 -> no detonation
    world.tickDelayedCasts(79, 79 / 20);
    assert.strictEqual(detonated.length, 1);

    // Tick at 80 -> later_bomb detonates, queue empty
    world.tickDelayedCasts(80, 80 / 20);
    assert.strictEqual(detonated.length, 2);
    assert.strictEqual(detonated[1].spell.id, 'later_bomb');
    assert.strictEqual(world.delayedCasts.length, 0);

    world.stop();
}

function testMultipleCastsAtSameTickAndFIFO() {
    const world = makeWorld();

    const order = [];
    world.runCast = (_caster, spell) => {
        order.push(spell.id);
    };

    const dummyCaster = makeDummyPlayer(77, { hp: 50 });
    world.players.set(dummyCaster.id, dummyCaster);

    world.enqueueDelayedCast({ casterId: 77, spell: { id: 'grenade_1' }, readyTick: 30, readyAt: 1.5 });
    world.enqueueDelayedCast({ casterId: 77, spell: { id: 'grenade_2' }, readyTick: 30, readyAt: 1.5 });
    world.enqueueDelayedCast({ casterId: 77, spell: { id: 'grenade_3' }, readyTick: 30, readyAt: 1.5 });
    world.enqueueDelayedCast({ casterId: 77, spell: { id: 'grenade_4' }, readyTick: 40, readyAt: 2.0 });

    world.tickDelayedCasts(30, 1.5);

    // First 3 should fire in strict FIFO order
    assert.deepStrictEqual(order, ['grenade_1', 'grenade_2', 'grenade_3']);
    assert.strictEqual(world.delayedCasts.length, 1);
    assert.strictEqual(world.delayedCasts[0].spell.id, 'grenade_4');

    world.stop();
}

function testDeadOrDisconnectedCasterHandling() {
    const world = makeWorld();

    const executed = [];
    world.runCast = (_caster, spell) => {
        executed.push(spell.id);
    };

    const liveCaster = makeDummyPlayer(101, { hp: 50 });
    const deadCaster = makeDummyPlayer(102, { alive: false, hp: 0, dead: true });
    world.players.set(liveCaster.id, liveCaster);
    world.players.set(deadCaster.id, deadCaster);

    // Enqueue cast from dead caster, ghost (nonexistent) caster, and live caster
    world.enqueueDelayedCast({ casterId: 102, spell: { id: 'dead_spell' }, readyTick: 10, readyAt: 0.5 });
    world.enqueueDelayedCast({ casterId: 999, spell: { id: 'ghost_spell' }, readyTick: 10, readyAt: 0.5 });
    world.enqueueDelayedCast({ casterId: 101, spell: { id: 'live_spell' }, readyTick: 10, readyAt: 0.5 });

    world.tickDelayedCasts(10, 0.5);

    // Dead and ghost casts are discarded without error; live cast fires
    assert.deepStrictEqual(executed, ['live_spell']);
    assert.strictEqual(world.delayedCasts.length, 0);

    world.stop();
}

function testInterleavedVariableDelaySpells() {
    const world = makeWorld();

    const order = [];
    world.runCast = (_caster, spell) => {
        order.push({ id: spell.id, tick: world._testTick });
    };

    const caster = makeDummyPlayer(50, { hp: 100 });
    world.players.set(caster.id, caster);

    // At tick 0: Cast A with 2.0s delay (ready at tick 40)
    world.enqueueDelayedCast({
        casterId: 50,
        spell: { id: 'slow_bomb' },
        readyTick: 40,
        readyAt: 2.0
    });

    // At tick 10: Cast B with 0.5s delay (ready at tick 20)
    world.enqueueDelayedCast({
        casterId: 50,
        spell: { id: 'fast_bomb' },
        readyTick: 20,
        readyAt: 1.0
    });

    // Verify queue prioritized fast_bomb (tick 20) over slow_bomb (tick 40)
    assert.strictEqual(world.delayedCasts[0].spell.id, 'fast_bomb');
    assert.strictEqual(world.delayedCasts[1].spell.id, 'slow_bomb');

    // Advance to tick 20
    world._testTick = 20;
    world.tickDelayedCasts(20, 1.0);
    assert.strictEqual(order.length, 1);
    assert.strictEqual(order[0].id, 'fast_bomb');
    assert.strictEqual(world.delayedCasts.length, 1);
    assert.strictEqual(world.delayedCasts[0].spell.id, 'slow_bomb');

    // Advance to tick 40
    world._testTick = 40;
    world.tickDelayedCasts(40, 2.0);
    assert.strictEqual(order.length, 2);
    assert.strictEqual(order[1].id, 'slow_bomb');
    assert.strictEqual(world.delayedCasts.length, 0);

    world.stop();
}

function testEndToEndDelayedCastSpell() {
    const world = makeWorld();
    const attacker = makeSession(world, { id: 1, name: 'Attacker', vocation: 'mystic', level: 1, hp: 100, hpMax: 100, mp: 50, mpMax: 50 }, { x: 10, y: 10, z: 0 });
    const dummy = world.spawnCreature('dummy', 12, 11, 0);
    assert.ok(dummy, 'Spawned dummy creature');
    dummy.hp = 100;
    dummy.hpMax = 100;

    const { findSpell } = require('../src/world/spells');
    const spell = findSpell(world.spellBook, 'delayed_blast');
    assert.ok(spell, 'delayed_blast exists in pack');
    assert.strictEqual(spell.delaySec, 1.0);

    // Initial cast at tick 0
    const res = world.runCast(attacker, spell, {
        target: dummy,
        aim: { x: dummy.x, y: dummy.y, z: dummy.z },
        tickIndex: 0
    });

    assert.ok(res.ok);
    assert.ok(res.delayed, 'Spell is marked delayed');
    assert.strictEqual(dummy.hp, 100, 'Target takes no damage upon planting');
    assert.strictEqual(world.delayedCasts.length, 1);
    assert.strictEqual(world.delayedCasts[0].readyTick, 20); // 1.0s * 20 ups = 20 ticks

    // Run world steps up to tick 19
    for (let t = 1; t < 20; t++) {
        world.step(t);
        assert.strictEqual(dummy.hp, 100, 'Target undamaged before detonation tick');
        assert.strictEqual(world.delayedCasts.length, 1);
    }

    // Tick 20: Detonation occurs!
    world.step(20);
    assert.strictEqual(world.delayedCasts.length, 0, 'Delayed cast queue cleared');
    assert.ok(dummy.hp < 100, 'Dummy took damage upon detonation');

    attacker.kick(0);
    world.stop();
}

function testDelayedFuseSameTickWithOrWithoutReadyAt() {
    const world = makeWorld();
    const fired = [];
    world.runCast = (_caster, spell) => {
        fired.push(spell.id);
    };

    const caster = makeDummyPlayer(7, { hp: 100 });
    world.players.set(caster.id, caster);

    world.enqueueDelayedCast({
        casterId: 7,
        spell: { id: 'with_float' },
        readyTick: 20,
        readyAt: 999
    });
    world.enqueueDelayedCast({
        casterId: 7,
        spell: { id: 'tick_only' },
        readyTick: 20
    });

    world.tickDelayedCasts(19);
    assert.deepStrictEqual(fired, []);
    assert.strictEqual(world.delayedCasts.length, 2);
    assert.strictEqual(world.delayedCasts[0].readyAt, undefined);
    assert.strictEqual(world.delayedCasts[1].readyAt, undefined);

    world.tickDelayedCasts(20);
    assert.deepStrictEqual(fired, ['with_float', 'tick_only']);
    assert.strictEqual(world.delayedCasts.length, 0);

    world.stop();
}

function main() {
    testBinarySearchInsertionOrder();
    testO1EarlyExitAndNoArrayAllocation();
    testExactDiscreteTickDetonation();
    testMultipleCastsAtSameTickAndFIFO();
    testDeadOrDisconnectedCasterHandling();
    testInterleavedVariableDelaySpells();
    testEndToEndDelayedCastSpell();
    testDelayedFuseSameTickWithOrWithoutReadyAt();
    console.log('ok phase6_3_monotonic_delayed_casts');
}

main();

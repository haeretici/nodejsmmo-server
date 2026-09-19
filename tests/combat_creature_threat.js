'use strict';

const assert = require('assert');
const path = require('path');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, REASON } = require('../src/protocol/opcodes');
const { createCreature, CreaturePool } = require('../src/world/creature');
const {
    pickWeightedKey,
    pickByStrategy,
    normalizeStrategiesTarget,
    changeTargetFromTemplate,
    applyThreatDecay,
    recordDamageTakenBy,
    threatOf,
    retargetIntervalSec,
    retargetChance,
    armStrategyRetarget,
    clearStrategyRetarget,
    strategyRetargetDue,
    pickCreatureTarget
} = require('../src/world/threat');

const demon = require(path.join(__dirname, '../../content/creatures/demon.json'));

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

function makeWorld(extra) {
    const settings = testSettings();
    settings.creatureStepDelayTicks = 1;
    settings.stepDelayTicks = 1;
    settings.autoIntervalTicks = 1;
    settings.aiCreatureSleep = true;
    settings.aiTickRadius = 12;
    if (extra) Object.assign(settings, extra);
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        rng: extra && extra.rng ? extra.rng : (() => 0),
        templates: extra && extra.templates,
        map: extra && extra.map || openMap(40, 40)
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
        name: 'Ash' + (id || 1),
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

function hunterTpl(extra) {
    return Object.assign({
        id: 'hunter',
        label: 'Hunter',
        hp: 200,
        hpMax: 200,
        armor: 0,
        mitigation: 0,
        maxBlock: 0,
        canBlock: false,
        exp: 0,
        aggro: true,
        resists: { physical: 0 },
        speed: 0,
        flags: {
            targetDistance: 1,
            aggroRange: 8,
            loseTargetDistance: 12,
            pushable: false,
            canPushCreatures: false,
            threatDecayHalflifeSec: 0
        },
        attacks: [{
            id: 'idle',
            kind: 'melee',
            intervalMs: 200000,
            chance: 0,
            range: 1,
            element: 'physical',
            min: 0,
            max: 0
        }],
        loot: []
    }, extra || {});
}

function u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
}

function main() {
    assert.strictEqual(pickWeightedKey({ a: 100, b: 0 }, () => 0), 'a');
    assert.strictEqual(pickWeightedKey({ nearest: 70, health: 10 }, () => 0.5), 'nearest');

    const st = normalizeStrategiesTarget(demon.strategiesTarget);
    assert.strictEqual(st.nearest, 70);
    assert.strictEqual(st.health, 10);
    assert.strictEqual(st.damage, 10);
    assert.strictEqual(st.random, 10);
    assert.deepStrictEqual(normalizeStrategiesTarget(null), { nearest: 100 });
    assert.deepStrictEqual(normalizeStrategiesTarget({ nearest: 0, health: 0 }), { nearest: 100 });

    const ct = changeTargetFromTemplate(demon);
    assert.strictEqual(ct.intervalSec, 4);
    assert.strictEqual(ct.chance, 20);
    assert.deepStrictEqual(changeTargetFromTemplate({}), { intervalSec: null, chance: null });
    const flagsIgnored = changeTargetFromTemplate({
        changeTarget: { interval: 4000, chance: 10 },
        flags: { retargetIntervalSec: 2, retargetChance: 100 }
    });
    assert.strictEqual(flagsIgnored.intervalSec, 4);
    assert.strictEqual(flagsIgnored.chance, 10);

    const owner = {
        x: 0,
        y: 0,
        z: 0,
        flags: { threatDecayHalflifeSec: 0 },
        damageTakenBy: Object.create(null),
        strategiesTarget: { damage: 100 }
    };
    const low = { id: 1, x: 2, y: 0, z: 0, hp: 5 };
    const high = { id: 2, x: 1, y: 0, z: 0, hp: 40 };
    assert.strictEqual(pickByStrategy(owner, [low, high], 'health').id, 1);
    assert.strictEqual(pickByStrategy(owner, [low, high], 'nearest').id, 2);

    recordDamageTakenBy(owner, { id: 1, type: 'player' }, 30, 0, {});
    recordDamageTakenBy(owner, { id: 2, type: 'player' }, 5, 0, {});
    assert.strictEqual(pickByStrategy(owner, [low, high], 'damage').id, 1);

    const monster = {
        x: 0,
        y: 0,
        z: 0,
        flags: { threatDecayHalflifeSec: 10 },
        damageTakenBy: Object.create(null)
    };
    recordDamageTakenBy(monster, { id: 'p1', type: 'player' }, 100, 0, {});
    assert.ok(Math.abs(threatOf(monster, 'p1', 0, {}) - 100) < 1e-6);
    applyThreatDecay(monster, 10, {});
    assert.ok(
        Math.abs(threatOf(monster, 'p1', 10, {}) - 50) < 0.5,
        'expected ~50 threat after half-life'
    );
    applyThreatDecay(monster, 20, {});
    assert.ok(
        Math.abs(threatOf(monster, 'p1', 20, {}) - 25) < 0.5,
        'expected ~25 threat after 2 half-lives'
    );
    recordDamageTakenBy(monster, { id: 'p2', type: 'player' }, 40, 20, {});
    const nearA = { id: 'p1', x: 1, y: 0, z: 0, hp: 50 };
    const nearB = { id: 'p2', x: 2, y: 0, z: 0, hp: 50 };
    assert.strictEqual(pickByStrategy(monster, [nearA, nearB], 'damage', null, { now: 20 }).id, 'p2');

    const noDecay = {
        x: 0,
        y: 0,
        z: 0,
        flags: { threatDecayHalflifeSec: 0 },
        damageTakenBy: Object.create(null)
    };
    recordDamageTakenBy(noDecay, { id: 'x', type: 'player' }, 80, 0, {});
    applyThreatDecay(noDecay, 1000, {});
    assert.ok(Math.abs(threatOf(noDecay, 'x', 1000, {}) - 80) < 1e-6);

    const kitRetarget = changeTargetFromTemplate({
        changeTarget: { interval: 2000, chance: 100 }
    });
    const retargetOwner = {
        changeTarget: kitRetarget,
        strategiesTarget: { health: 100 }
    };
    assert.strictEqual(retargetIntervalSec(retargetOwner), 2);
    assert.strictEqual(retargetChance(retargetOwner), 100);
    armStrategyRetarget(retargetOwner, 50);
    assert.strictEqual(strategyRetargetDue(retargetOwner, 50), false);
    assert.strictEqual(strategyRetargetDue(retargetOwner, 51.9), false);
    assert.strictEqual(strategyRetargetDue(retargetOwner, 52.1), true);
    assert.strictEqual(strategyRetargetDue(retargetOwner, 52.1), false);
    clearStrategyRetarget(retargetOwner);
    assert.strictEqual(strategyRetargetDue(retargetOwner, 52.1), true);

    const chanceZero = {
        changeTarget: changeTargetFromTemplate({ changeTarget: { interval: 4000, chance: 0 } })
    };
    assert.strictEqual(retargetIntervalSec(chanceZero), 4);
    assert.strictEqual(retargetChance(chanceZero), 0);
    armStrategyRetarget(chanceZero, 10);
    assert.strictEqual(strategyRetargetDue(chanceZero, 15, () => 0), false);

    const rollOwner = {
        changeTarget: changeTargetFromTemplate({ changeTarget: { interval: 2000, chance: 20 } })
    };
    armStrategyRetarget(rollOwner, 0);
    assert.strictEqual(strategyRetargetDue(rollOwner, 2.1, () => 0.5), false);
    assert.strictEqual(strategyRetargetDue(rollOwner, 4.2, () => 0.1), true);

    const spawned = createCreature(1, demon, { x: 0, y: 0, z: 0 });
    assert.strictEqual(spawned.strategiesTarget.nearest, 70);
    assert.strictEqual(spawned.changeTarget.intervalSec, demon.changeTarget.interval / 1000);
    assert.strictEqual(spawned.changeTarget.chance, demon.changeTarget.chance);
    assert.ok(spawned.changeTarget.intervalSec > 0);
    assert.ok(spawned.damageTakenBy);
    assert.strictEqual(Object.keys(spawned.damageTakenBy).length, 0);

    const pool = new CreaturePool(4);
    const recycled = pool.obtain(9, demon, { x: 1, y: 1, z: 0 });
    recycled.damageTakenBy[1] = 99;
    recycled._strategyRetargetNextAt = 12;
    assert.ok(pool.release(recycled));
    const again = pool.obtain(10, hunterTpl(), { x: 2, y: 2, z: 0 });
    assert.strictEqual(again, recycled);
    assert.strictEqual(Object.keys(again.damageTakenBy).length, 0);
    assert.strictEqual(again._strategyRetargetNextAt, null);
    assert.deepStrictEqual(again.strategiesTarget, { nearest: 100 });

    const wHealth = makeWorld({
        templates: {
            hunter: hunterTpl({
                strategiesTarget: { health: 100 },
                changeTarget: { interval: 1000, chance: 100 }
            })
        },
        spawns: [{ kind: 'hunter', x: 5, y: 5, z: 0 }]
    });
    const tank = makeSession(wHealth, ash(1, { hp: 80, hpMax: 100 }), { x: 6, y: 5, z: 0 });
    const glass = makeSession(wHealth, ash(2, { hp: 20, hpMax: 100 }), { x: 7, y: 5, z: 0 });
    tank.hp = 80;
    glass.hp = 20;
    const hunter = Array.from(wHealth.creatures.values())[0];
    hunter.moveReadyTick = 1e9;
    wHealth.step(1);
    assert.strictEqual(hunter.targetId, glass.id, 'health strategy → lowest HP');
    tank.hp = 5;
    glass.hp = 50;
    for (let t = 2; t <= 20; t++) wHealth.step(t);
    assert.strictEqual(hunter.targetId, glass.id, 'sticky until changeTarget interval');
    wHealth.step(21);
    assert.strictEqual(hunter.targetId, tank.id, 'retargetInterval re-applies health strategy');
    tank.kick(REASON.LOGOUT);
    glass.kick(REASON.LOGOUT);
    wHealth.stop();

    const wSticky = makeWorld({
        templates: {
            hunter: hunterTpl({
                strategiesTarget: { health: 100 },
                changeTarget: { interval: 1000, chance: 0 }
            })
        },
        spawns: [{ kind: 'hunter', x: 5, y: 5, z: 0 }]
    });
    const tank2 = makeSession(wSticky, ash(3, { hp: 80, hpMax: 100 }), { x: 6, y: 5, z: 0 });
    const glass2 = makeSession(wSticky, ash(4, { hp: 20, hpMax: 100 }), { x: 7, y: 5, z: 0 });
    tank2.hp = 80;
    glass2.hp = 20;
    const sticky = Array.from(wSticky.creatures.values())[0];
    sticky.moveReadyTick = 1e9;
    wSticky.step(1);
    assert.strictEqual(sticky.targetId, glass2.id);
    tank2.hp = 1;
    glass2.hp = 90;
    for (let t = 2; t <= 40; t++) wSticky.step(t);
    assert.strictEqual(sticky.targetId, glass2.id, 'chance 0 never switches');
    tank2.kick(REASON.LOGOUT);
    glass2.kick(REASON.LOGOUT);
    wSticky.stop();

    const wNear = makeWorld({
        templates: { hunter: hunterTpl({ strategiesTarget: { nearest: 100 } }) },
        spawns: [{ kind: 'hunter', x: 5, y: 5, z: 0 }]
    });
    const far = makeSession(wNear, ash(5), { x: 8, y: 5, z: 0 });
    const near = makeSession(wNear, ash(6), { x: 6, y: 5, z: 0 });
    const nearestMob = Array.from(wNear.creatures.values())[0];
    nearestMob.moveReadyTick = 1e9;
    wNear.step(1);
    assert.strictEqual(nearestMob.targetId, near.id, 'nearest strategy picks closer player');
    far.kick(REASON.LOGOUT);
    near.kick(REASON.LOGOUT);
    wNear.stop();

    const wDmg = makeWorld({
        autoIntervalTicks: 1,
        templates: {
            hunter: hunterTpl({
                hp: 500,
                hpMax: 500,
                strategiesTarget: { damage: 100 },
                changeTarget: { interval: 1000, chance: 100 }
            })
        },
        spawns: [{ kind: 'hunter', x: 5, y: 5, z: 0 }]
    });
    const glass3 = makeSession(wDmg, ash(7, { hp: 100, hpMax: 100 }), { x: 7, y: 5, z: 0 });
    const tank3 = makeSession(wDmg, ash(8, { hp: 100, hpMax: 100 }), { x: 6, y: 5, z: 0 });
    const dmgMob = Array.from(wDmg.creatures.values())[0];
    dmgMob.moveReadyTick = 1e9;
    wDmg.step(1);
    assert.strictEqual(
        dmgMob.targetId,
        glass3.id,
        'no threat yet → random fallback (rng 0 = first candidate)'
    );
    assert.ok(wDmg.enqueueIntent(tank3, {
        opcode: C2S.SET_TARGET, seq: 1, payload: u32(dmgMob.id)
    }));
    wDmg.step(2);
    assert.ok(threatOf(dmgMob, tank3.id, wDmg.logicNow(2), wDmg.settings) > 0);
    assert.strictEqual(threatOf(dmgMob, glass3.id, wDmg.logicNow(2), wDmg.settings), 0);
    for (let t = 3; t <= 21; t++) wDmg.step(t);
    assert.strictEqual(dmgMob.targetId, tank3.id, 'damage strategy prefers the player who hit');
    glass3.kick(REASON.LOGOUT);
    tank3.kick(REASON.LOGOUT);
    wDmg.stop();

    const picked = pickCreatureTarget(
        { x: 0, y: 0, z: 0, strategiesTarget: { nearest: 100 } },
        [low, high],
        () => 0
    );
    assert.strictEqual(picked.id, 2);

    console.log('ok combat_creature_threat');
}

main();

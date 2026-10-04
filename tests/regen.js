'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { REASON } = require('../src/protocol/opcodes');
const { createStaticMap } = require('../src/world/static_map');
const {
    nativeRegenRates,
    regenIntervalTicks,
    tickNativeRegen,
    tickEquippedDurations,
    DEFAULT_REGEN_HP_TICKS,
    DEFAULT_REGEN_MP_TICKS,
    DEFAULT_HUNGRY_REGEN_HP_TICKS,
    DEFAULT_HUNGRY_REGEN_MP_TICKS,
    tickFoodSatiation
} = require('../src/world/regen');
const { snapshotSession, foodSecondsFromConditions } = require('../src/world/snapshot');
const {
    createEmptyInventory,
    ensureEquippedBackpack,
    createItemInstance,
    placeInEquipment,
    unequipItem,
    serializeInventory,
    normalizeInventory
} = require('../src/world/inventory');
const classesDoc = require('../../content/classes.json');

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
    if (extra && extra.settings) Object.assign(settings, extra.settings);
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        rng: extra && extra.rng ? extra.rng : (() => 0.5),
        pack: extra && extra.pack,
        map: extra && extra.map ? extra.map : createStaticMap(),
        templates: extra && extra.templates
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

function scoutPack() {
    return {
        classes: {
            classes: [{
                id: 'scout',
                baseRegenHp: 3,
                baseRegenMp: 3,
                promotedRegenHp: 5,
                promotedRegenMp: 4
            }]
        }
    };
}

function stepN(world, fromTick, n) {
    for (let i = 0; i < n; i++) world.step(fromTick + i);
}

function main() {
    const expectedNative = {
        guardian: { base: [4, 2], prom: [6, 3] },
        scout: { base: [3, 3], prom: [5, 4] },
        mystic: { base: [3, 3], prom: [5, 4] },
        adept: { base: [2, 4], prom: [3, 6] },
        warden: { base: [2, 4], prom: [3, 6] },
        adventurer: { base: [2, 2], prom: [2, 2] }
    };
    const list = classesDoc && Array.isArray(classesDoc.classes) ? classesDoc.classes : [];
    for (const [classId, rates] of Object.entries(expectedNative)) {
        const classDef = list.find((c) => c && c.id === classId);
        assert.ok(classDef, `class ${classId} loads`);
        assert.strictEqual(classDef.baseRegenHp, rates.base[0], `${classId} baseRegenHp`);
        assert.strictEqual(classDef.baseRegenMp, rates.base[1], `${classId} baseRegenMp`);
        assert.strictEqual(classDef.promotedRegenHp, rates.prom[0], `${classId} promotedRegenHp`);
        assert.strictEqual(classDef.promotedRegenMp, rates.prom[1], `${classId} promotedRegenMp`);
        const base = nativeRegenRates(classDef, false);
        assert.strictEqual(base.hp, rates.base[0]);
        assert.strictEqual(base.mp, rates.base[1]);
        const prom = nativeRegenRates(classDef, true);
        assert.strictEqual(prom.hp, rates.prom[0]);
        assert.strictEqual(prom.mp, rates.prom[1]);
    }

    const intervals = regenIntervalTicks({}, false, 20);
    assert.strictEqual(intervals.hpTicks, DEFAULT_REGEN_HP_TICKS);
    assert.strictEqual(intervals.mpTicks, DEFAULT_REGEN_MP_TICKS);
    const hungryIv = regenIntervalTicks({}, true, 20);
    assert.strictEqual(hungryIv.hpTicks, DEFAULT_HUNGRY_REGEN_HP_TICKS);
    assert.strictEqual(hungryIv.mpTicks, DEFAULT_HUNGRY_REGEN_MP_TICKS);
    const fullMs = regenIntervalTicks({
        fullRegenHpIntervalMs: 3000,
        fullRegenMpIntervalMs: 5000
    }, false, 20);
    assert.strictEqual(fullMs.hpTicks, 60, 'full stomach is 3s HP');
    assert.strictEqual(fullMs.mpTicks, 100, 'full stomach is 5s MP');
    const baseMs = regenIntervalTicks({
        baseRegenHpIntervalMs: 4000,
        baseRegenMpIntervalMs: 6000
    }, true, 20);
    assert.strictEqual(baseMs.hpTicks, 80, 'hungry is 4s HP');
    assert.strictEqual(baseMs.mpTicks, 120, 'hungry is 6s MP');
    const legacyHungry = regenIntervalTicks({ engageRegenHpTicks: 70, engageRegenMpTicks: 90 }, true, 20);
    assert.strictEqual(legacyHungry.hpTicks, 70);
    assert.strictEqual(legacyHungry.mpTicks, 90);

    const player = {
        type: 'player',
        hp: 50,
        hpMax: 100,
        mp: 20,
        mpMax: 90,
        _regenHpTicks: 0,
        _regenMpTicks: 0
    };
    let accHp = 0;
    let accMp = 0;
    for (let i = 0; i < 59; i++) {
        const d = tickNativeRegen(player, { hp: 3, mp: 3 }, { hpTicks: 60, mpTicks: 100 });
        accHp += d.hpDelta;
        accMp += d.mpDelta;
    }
    assert.strictEqual(accHp, 0, 'no hp before 60 ticks');
    const at60 = tickNativeRegen(player, { hp: 3, mp: 3 }, { hpTicks: 60, mpTicks: 100 });
    accHp += at60.hpDelta;
    accMp += at60.mpDelta;
    assert.strictEqual(accHp, 3, 'hp +3 at 60 ticks');
    assert.strictEqual(accMp, 0, 'mp interval 100 not reached');
    for (let i = 0; i < 39; i++) {
        const d = tickNativeRegen(player, { hp: 3, mp: 3 }, { hpTicks: 60, mpTicks: 100 });
        accMp += d.mpDelta;
    }
    const at100 = tickNativeRegen(player, { hp: 3, mp: 3 }, { hpTicks: 60, mpTicks: 100 });
    accMp += at100.mpDelta;
    assert.strictEqual(accMp, 3, 'mp +3 at 100 ticks');

    const sleeper = {
        type: 'creature',
        hp: 10,
        hpMax: 20,
        simSleeping: true,
        _regenHpTicks: 0
    };
    const skipped = tickNativeRegen(sleeper, { hp: 5, mp: 0 }, { hpTicks: 1, mpTicks: 100 });
    assert.strictEqual(skipped.hpDelta, 0);
    assert.strictEqual(sleeper._regenHpTicks, 0, 'sleeping creature timers freeze');

    const world = makeWorld({ pack: scoutPack() });
    const session = makeSession(world, ash(1, { hp: 50, mp: 20 }));
    assert.strictEqual(session.hp, 50);
    assert.strictEqual(session.foodSeconds, 0);
    stepN(world, 1, 79);
    assert.strictEqual(session.hp, 50, 'hungry: no hp before 80 ticks');
    assert.strictEqual(session.mp, 20);
    world.step(80);
    assert.strictEqual(session.hp, 53, 'hungry scout +3 hp at 80 ticks');
    stepN(world, 81, 39);
    assert.strictEqual(session.mp, 20, 'hungry mp waits for 120 ticks');
    world.step(120);
    assert.strictEqual(session.mp, 23, 'hungry scout +3 mp at 120 ticks');

    session.foodSeconds = 600;
    session._regenHpTicks = 0;
    session._regenMpTicks = 0;
    session.hp = 40;
    session.mp = 10;
    stepN(world, 121, 59);
    assert.strictEqual(session.hp, 40, 'fed: no hp before 60 ticks');
    world.step(180);
    assert.strictEqual(session.hp, 43, 'fed scout +3 hp at 60 ticks');
    assert.ok(session.foodSeconds > 0);
    session.hp = session.hpMax;
    session.mp = session.mpMax;
    const fullHp = session.hp;
    world.step(181);
    assert.strictEqual(session.hp, fullHp, 'regen clamps to max');

    const dummy = world.spawnCreature('dummy', 20, 20, session.z);
    assert.ok(dummy);
    dummy.hp = 30;
    session.targetId = dummy.id;
    session.attackReadyTick = 100000;
    session.foodSeconds = 500;
    session._regenHpTicks = 0;
    session.hp = 30;
    stepN(world, 182, 59);
    assert.strictEqual(session.hp, 30, 'a living target does not slow fed regen');
    world.step(241);
    assert.strictEqual(session.hp, 33, 'fed while targeted still +3 at 60 ticks');

    session.hp = session.hpMax;
    session.mp = session.mpMax;
    session.foodSeconds = 1;
    session._foodSubTicks = 0;
    stepN(world, 242, 19);
    assert.strictEqual(session.foodSeconds, 1, 'one food second lasts 20 ticks');
    world.step(261);
    assert.strictEqual(session.foodSeconds, 0, 'food second expires into hungry');
    assert.strictEqual(session._foodSubTicks, 0);

    session.promoted = true;
    session.foodSeconds = 400;
    session._regenHpTicks = 0;
    session._regenMpTicks = 0;
    session.hp = 10;
    session.mp = 10;
    stepN(world, 262, 59);
    assert.strictEqual(session.hp, 10, 'promoted fed waits 60 ticks');
    world.step(321);
    assert.strictEqual(session.hp, 15, 'promoted fed +5 hp');
    session.foodSeconds = 0;
    session._regenHpTicks = 0;
    session.hp = 10;
    stepN(world, 322, 79);
    assert.strictEqual(session.hp, 10, 'promoted hungry waits 80 ticks');
    world.step(401);
    assert.strictEqual(session.hp, 15, 'promoted hungry +5 hp');

    const dish = { foodSeconds: 3, _foodSubTicks: 19 };
    const mid = tickFoodSatiation(dish, 20);
    assert.strictEqual(mid.expired, false);
    assert.strictEqual(dish.foodSeconds, 2);
    const plain = { foodSeconds: 9, _foodSubTicks: 0 };
    const advanced = tickFoodSatiation(plain, 20);
    assert.strictEqual(advanced.hungry, false);
    assert.strictEqual(plain.foodSeconds, 9);
    assert.strictEqual(plain._foodSubTicks, 1);
    session.downed = true;
    session.foodSeconds = 9;
    session._foodSubTicks = 4;
    world.tickPlayerRegen(session);
    assert.strictEqual(session.foodSeconds, 9, 'a downed body does not spend food');
    assert.strictEqual(session._foodSubTicks, 4);
    session.downed = false;

    session.foodSeconds = 180;
    const foodSnap = snapshotSession(session, {});
    assert.deepStrictEqual(foodSnap.conditions, [{ type: 'food', seconds: 180 }]);
    assert.strictEqual(foodSecondsFromConditions(foodSnap.conditions), 180);
    session.foodSeconds = 0;
    assert.deepStrictEqual(snapshotSession(session, {}).conditions, []);

    const resumed = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    resumed.bindCharacter(ash(2), world.spawnPos({ townId: 1 }), {
        state: { conditions: [{ type: 'food', seconds: 90 }] }
    });
    assert.strictEqual(resumed.foodSeconds, 90);

    session.kick(REASON.LOGOUT);
    world.stop();

    const itemDb = {
        backpack: {
            id: 'backpack',
            slot: 'backpack',
            category: 'container',
            volume: 20,
            weight: 1800
        },
        life_ring: {
            id: 'life_ring',
            label: 'Life Ring',
            slot: 'ring',
            category: 'ring',
            durationSec: 1,
            weight: 90,
            type: ['ring']
        },
        charge_band: {
            id: 'charge_band',
            slot: 'ring',
            category: 'ring',
            charges: 7,
            weight: 90,
            type: ['ring']
        }
    };
    const inv = createEmptyInventory();
    ensureEquippedBackpack(inv, itemDb);
    const ringUid = createItemInstance(inv, 'life_ring', itemDb);
    assert.strictEqual(inv.items[ringUid].remainingDurationSec, 1);
    assert.ok(placeInEquipment(inv, ringUid, 'ring', itemDb).ok);
    const dur0 = tickEquippedDurations(inv, itemDb, 20);
    assert.strictEqual(dur0.expiredUids.length, 0);
    assert.ok(inv.items[ringUid].remainingDurationSec < 1);
    assert.ok(inv.items[ringUid].remainingDurationSec > 0);
    for (let i = 0; i < 18; i++) tickEquippedDurations(inv, itemDb, 20);
    const durLast = tickEquippedDurations(inv, itemDb, 20);
    assert.strictEqual(durLast.expiredUids.length, 1);
    assert.strictEqual(durLast.expiredSlots[0], 'ring');

    const inv2 = createEmptyInventory();
    ensureEquippedBackpack(inv2, itemDb);
    const uid2 = createItemInstance(inv2, 'life_ring', itemDb);
    assert.ok(placeInEquipment(inv2, uid2, 'ring', itemDb).ok);
    for (let i = 0; i < 10; i++) tickEquippedDurations(inv2, itemDb, 20);
    const leftover = inv2.items[uid2].remainingDurationSec;
    assert.ok(leftover > 0 && leftover < 1);
    const un = unequipItem(inv2, 'ring', itemDb);
    assert.strictEqual(un.ok, true);
    const frozen = inv2.items[uid2].remainingDurationSec;
    for (let i = 0; i < 40; i++) tickEquippedDurations(inv2, itemDb, 20);
    assert.strictEqual(inv2.items[uid2].remainingDurationSec, frozen, 'stowed leftover duration freezes');
    const snap = serializeInventory(inv2);
    const ringRow = Object.values(snap.items).find((r) => r && r.itemId === 'life_ring');
    assert.ok(ringRow);
    assert.ok(Math.abs(ringRow.remainingDurationSec - frozen) < 1e-9);
    assert.ok(!Object.prototype.hasOwnProperty.call(ringRow, 'remainingDurationTicks'));
    const loaded = normalizeInventory(snap, itemDb);
    const loadedRing = Object.values(loaded.items).find((r) => r && r.itemId === 'life_ring');
    assert.ok(loadedRing);
    assert.ok(Math.abs(loadedRing.remainingDurationSec - frozen) < 1e-9);

    const inv3 = createEmptyInventory();
    ensureEquippedBackpack(inv3, itemDb);
    const bandUid = createItemInstance(inv3, 'charge_band', itemDb);
    assert.strictEqual(inv3.items[bandUid].remainingCharges, 7);
    const snap3 = serializeInventory(inv3);
    const bandRow = Object.values(snap3.items).find((r) => r && r.itemId === 'charge_band');
    assert.strictEqual(bandRow.remainingCharges, 7);

    const w2 = makeWorld({ pack: scoutPack() });
    w2.itemDb().life_ring = itemDb.life_ring;
    const s2 = makeSession(w2, ash(2, { hp: 50, mp: 20 }));
    const liveUid = createItemInstance(s2.inventory, 'life_ring', w2.itemDb());
    assert.ok(placeInEquipment(s2.inventory, liveUid, 'ring', w2.itemDb()).ok);
    stepN(w2, 1, 20);
    assert.ok(!s2.inventory.equipment.ring, 'equipped duration item destroyed at 0');
    assert.ok(!s2.inventory.items[liveUid]);
    s2.kick(REASON.LOGOUT);
    w2.stop();

    console.log('ok regen');
}

main();

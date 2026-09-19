'use strict';

const assert = require('assert');
const { loadPack, resolveContentPath } = require('../src/content/load_pack');
const { testSettings, SERVER_ROOT } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { meleeAutoBounds } = require('../src/world/combat');
const {
    applyPlayerLoadout,
    createItemInstance,
    placeInEquipment,
    unequipItem
} = require('../src/world/inventory');
const { findItem, stackResists } = require('../src/world/items');

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
    const pack = extra && extra.pack !== undefined
        ? extra.pack
        : loadPack(resolveContentPath({ contentPath: '../content' }, SERVER_ROOT));
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        rng: extra && extra.rng ? extra.rng : (() => 0.5),
        templates: extra && extra.templates,
        pack
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

function fighter(id, opts) {
    const o = opts || {};
    return {
        id: id || 1,
        accountId: id || 1,
        name: 'Ash',
        vocation: o.vocation || 'guardian',
        level: o.level || 1,
        experience: 0,
        hp: o.hp != null ? o.hp : 150,
        hpMax: o.hpMax != null ? o.hpMax : 150,
        mp: o.mp != null ? o.mp : 55,
        mpMax: o.mpMax != null ? o.mpMax : 55,
        townId: 1,
        skills: {
            fist: 10,
            club: 10,
            sword: o.sword != null ? o.sword : 10,
            axe: 10,
            distance: 10,
            shielding: 10,
            magic: 0
        }
    };
}

function main() {
    const w = makeWorld({ autoIntervalTicks: 1 });
    const session = makeSession(w, fighter(1, { level: 1 }));
    const itemDb = w.itemDb();

    assert.strictEqual(session._classBaseSpeed, 110, 'guardian baseSpeed');
    assert.strictEqual(session.baseSpeed, 110);
    assert.strictEqual(w.entitySpeed(session), 110);
    assert.strictEqual(session.resists.fire, 0);
    assert.strictEqual(session.atk, 7);

    const fireRing = findItem(itemDb, 'fire_ring');
    assert.ok(fireRing && fireRing.resists && fireRing.resists.fire === 10, 'catalog fire_ring');
    const legs = findItem(itemDb, 'alloy_legs');
    assert.ok(legs && legs.speed === 10, 'catalog alloy_legs');
    const cleaver = findItem(itemDb, 'ember_cleaver');
    assert.ok(cleaver && cleaver.atk === 27 && cleaver.extraAtk === 11);

    const ringUid = createItemInstance(session.inventory, 'fire_ring', itemDb);
    assert.ok(placeInEquipment(session.inventory, ringUid, 'ring', itemDb).ok);
    const bootUid = createItemInstance(session.inventory, 'alloy_legs', itemDb);
    assert.ok(placeInEquipment(session.inventory, bootUid, 'legs', itemDb).ok);
    applyPlayerLoadout(session, itemDb);

    assert.ok(Math.abs(session.resists.fire - 10) < 1e-6);
    assert.strictEqual(session.baseSpeed, 110 + 10);
    assert.strictEqual(w.entitySpeed(session), 120);

    itemDb.n5_atk_amulet = {
        id: 'n5_atk_amulet',
        slot: 'amulet',
        category: 'amulet',
        atk: 5,
        resists: { fire: 10 },
        weight: 90
    };
    const atkAmuletUid = createItemInstance(session.inventory, 'n5_atk_amulet', itemDb);
    assert.ok(placeInEquipment(session.inventory, atkAmuletUid, 'amulet', itemDb).ok);
    const cleaverUid = createItemInstance(session.inventory, 'ember_cleaver', itemDb);
    assert.ok(placeInEquipment(session.inventory, cleaverUid, 'rightHand', itemDb).ok);
    session._atkBonus = 4;
    applyPlayerLoadout(session, itemDb);
    assert.strictEqual(session.atk, 27 + 5 + 4, 'weapon + ring atk + class atkBonus');
    assert.strictEqual(session.extraAtk, 11, 'elemental extraAtk is not formula-doubled');
    assert.strictEqual(session.extraAtkElement, 'fire');
    assert.ok(Math.abs(session.resists.fire - stackResists([10, 10])) < 1e-6);

    session.mitigation = 0;
    const beforeHp = session.hp | 0;
    w.executeCreatureAttack(
        {
            id: 9001,
            type: 'creature',
            x: session.x,
            y: session.y + 1,
            z: session.z,
            critChance: 0
        },
        session,
        { min: 100, max: 100, element: 'fire', range: 1, hitChance: 100 },
        0
    );
    const fireTaken = beforeHp - (session.hp | 0);
    const stacked = stackResists([10, 10]);
    assert.strictEqual(fireTaken, Math.floor(100 * (1 - stacked / 100)));

    itemDb.n5_leech_sword = {
        id: 'n5_leech_sword',
        slot: 'rightHand',
        category: 'sword',
        weaponType: 'melee',
        atk: 42,
        lifeLeechChance: 100,
        lifeLeechAmount: 5000,
        manaLeechChance: 100,
        manaLeechAmount: 2000,
        weight: 4000
    };
    assert.ok(unequipItem(session.inventory, 'rightHand', itemDb).ok);
    const leechUid = createItemInstance(session.inventory, 'n5_leech_sword', itemDb);
    assert.ok(placeInEquipment(session.inventory, leechUid, 'rightHand', itemDb).ok);
    session._atkBonus = 0;
    applyPlayerLoadout(session, itemDb);
    assert.strictEqual(session.lifeLeechChance, 100);
    assert.strictEqual(session.lifeLeechAmount, 50);
    assert.strictEqual(session.manaLeechAmount, 20);

    session.hp = 40;
    session.hpMax = 150;
    session.mp = 10;
    session.mpMax = 55;
    session.x = 77;
    session.y = 99;
    session.z = 6;
    session.attackReadyTick = 0;
    session.critChance = 0;
    session.weaponTier = 0;

    const dummy = {
        id: 9999,
        type: 'creature',
        name: 'Target Dummy',
        x: 77,
        y: 98,
        z: 6,
        hp: 200,
        hpMax: 200,
        armor: 0,
        mitigation: 0,
        resists: { physical: 0 },
        dead: false,
        downed: false
    };
    w.creatures.set(dummy.id, dummy);

    const bounds = meleeAutoBounds(1, session.atk, 10, 0.102);
    const raw = bounds.min + Math.round(0.5 * (bounds.max - bounds.min));
    const swung = w.trySwing(session, dummy, 0);
    assert.strictEqual(swung, true);
    assert.strictEqual(dummy.hp, 200 - raw);
    assert.strictEqual(session.hp, 40 + Math.round(raw * 0.5));
    assert.strictEqual(session.mp, 10 + Math.round(raw * 0.2));

    const scout = makeSession(w, fighter(2, { vocation: 'scout', level: 3, hp: 160, hpMax: 160 }));
    assert.strictEqual(scout._classBaseSpeed, 120);
    assert.strictEqual(scout.baseSpeed, 120 + 2);

    console.log('ok combat_player_rollup');
}

main();

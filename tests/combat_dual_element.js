'use strict';

const assert = require('assert');
const { loadPack, resolveContentPath } = require('../src/content/load_pack');
const { testSettings, SERVER_ROOT } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C, SWING_FLAG } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');
const { decodeSwing, decodeStats } = require('../src/protocol/messages');
const { resolveMelee, meleeAutoBounds, levelBonus } = require('../src/world/combat');
const {
    applyPlayerLoadout,
    createItemInstance,
    placeInEquipment,
    unequipItem
} = require('../src/world/inventory');
const { findItem } = require('../src/world/items');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function lastOf(sock, opcode) {
    for (let i = sock.sent.length - 1; i >= 0; i--) {
        const f = decodeFrame(sock.sent[i]);
        if (f.opcode === opcode) return f;
    }
    return null;
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

function warrior(id, opts) {
    const o = opts || {};
    return {
        id: id || 1,
        accountId: id || 1,
        name: 'Conan',
        vocation: 'warrior',
        level: o.level || 10,
        experience: 0,
        hp: 200,
        hpMax: 200,
        mp: 50,
        mpMax: 50,
        townId: 1,
        skills: {
            axe: o.axeSkill != null ? o.axeSkill : 40,
            sword: o.swordSkill != null ? o.swordSkill : 40,
            shielding: 30
        }
    };
}

function main() {
    // -------------------------------------------------------------------------
    // 1. Direct Unit Test: resolveMelee with Dual-Element (extraAtk + extraAtkElement)
    // -------------------------------------------------------------------------
    // Weapon: physical atk 30 + extraAtk 15 fire => combinedAtk = 45.
    // Level 10, sword skill 50.
    const dualAttacker = {
        type: 'player',
        level: 10,
        atk: 30,
        extraAtk: 15,
        extraAtkElement: 'fire',
        weaponSkill: 'sword',
        skills: { sword: 50 },
        critChance: 0,
        weaponTier: 0
    };

    const dummy = {
        type: 'creature',
        armor: 0,
        mitigation: 0,
        resists: { physical: 0, fire: 0 }
    };

    // Combined bounds: min = levelBonus(10) = 2.
    // max = ceil(0.102 * 45 * 50 + 2) = ceil(229.5 + 2) = 232.
    const expectedBounds = meleeAutoBounds(10, 45, 50, 0.102);
    assert.strictEqual(expectedBounds.min, 2);
    assert.strictEqual(expectedBounds.max, 232);

    // Roll with rng => 0.5 (midpoint)
    // raw = 2 + round(0.5 * 230) = 117.
    // elemShare = 15 / 45 = 1/3.
    // elemRaw = round(117 / 3) = 39.
    // physRaw = 117 - 39 = 78.
    const midHit = resolveMelee(dualAttacker, dummy, () => 0.5, { hit: true });
    assert.strictEqual(midHit.miss, false);
    assert.strictEqual(midHit.raw, 117);
    assert.strictEqual(midHit.extraAtkElement, 'fire');
    assert.strictEqual(midHit.elemRaw, 39);
    assert.strictEqual(midHit.physRaw, 78);
    assert.strictEqual(midHit.physFinal, 78);
    assert.strictEqual(midHit.elemFinal, 39);
    assert.strictEqual(midHit.final, 117);

    // -------------------------------------------------------------------------
    // 1b. High armor dummy: physical absorbed, fire bypasses armor!
    // -------------------------------------------------------------------------
    const armoredDummy = {
        type: 'creature',
        armor: 200, // rollArmorReduction rolls in [100, 199] => exceeds physRaw (78)
        mitigation: 0,
        resists: { physical: 0, fire: 0 }
    };
    const armorHit = resolveMelee(dualAttacker, armoredDummy, () => 0.5, { hit: true });
    assert.strictEqual(armorHit.miss, false);
    assert.strictEqual(armorHit.raw, 117);
    assert.strictEqual(armorHit.physRaw, 78);
    assert.strictEqual(armorHit.physFinal, 0, 'physical damage must be fully absorbed by 200 armor');
    assert.strictEqual(armorHit.elemRaw, 39);
    assert.strictEqual(armorHit.elemFinal, 39, 'fire damage must bypass physical armor reduction');
    assert.strictEqual(armorHit.final, 39, 'final damage must equal the elemental portion');

    // -------------------------------------------------------------------------
    // 1c. Fire resistance dummy: reduces elemental portion only
    // -------------------------------------------------------------------------
    const fireResistDummy = {
        type: 'creature',
        armor: 0,
        mitigation: 0,
        resists: { physical: 0, fire: 50 } // 50% fire resist
    };
    const resistHit = resolveMelee(dualAttacker, fireResistDummy, () => 0.5, { hit: true });
    assert.strictEqual(resistHit.physFinal, 78, 'physical portion unaffected by fire resist');
    // elemRemaining = 39 * (1 - 0.5) = 19.5 => floor = 19
    assert.strictEqual(resistHit.elemFinal, 19, 'elemental portion reduced by 50% fire resist');
    assert.strictEqual(resistHit.final, 78 + 19, 'final is physFinal + elemFinal');

    // -------------------------------------------------------------------------
    // 1d. Shield block dummy: blocks physical portion only
    // -------------------------------------------------------------------------
    const shieldedDummy = {
        type: 'creature',
        armor: 0,
        mitigation: 0,
        resists: { physical: 0, fire: 0 },
        canBlock: true,
        maxBlock: 40
    };
    // rng => 1 gives max shield block (40)
    const shieldHit = resolveMelee(dualAttacker, shieldedDummy, () => 1, { hit: true });
    assert.strictEqual(shieldHit.shieldBlock, 40, 'shield block must absorb up to maxBlock (40)');
    assert.strictEqual(shieldHit.physFinal, 78 - 40, 'physFinal reduced by shield block');
    assert.strictEqual(shieldHit.elemFinal, 39, 'elemFinal completely unaffected by shield block');
    assert.strictEqual(shieldHit.final, (78 - 40) + 39);

    // -------------------------------------------------------------------------
    // 1e. Critical roll with dual-element
    // -------------------------------------------------------------------------
    // Min critical: auto_st floor = floor(0.65 * 232) = 150.
    const critHit = resolveMelee(dualAttacker, dummy, () => 0, { hit: true, critical: true });
    assert.strictEqual(critHit.critical, true);
    assert.strictEqual(critHit.raw, 150);
    // elemShare = 15/45 = 1/3 => elemRaw = round(150 / 3) = 50. physRaw = 100.
    assert.strictEqual(critHit.elemRaw, 50);
    assert.strictEqual(critHit.physRaw, 100);
    assert.strictEqual(critHit.final, 150);

    // -------------------------------------------------------------------------
    // 1f. Fatal proc with dual-element (weapon tier > 0)
    // -------------------------------------------------------------------------
    const tieredDualAttacker = Object.assign({}, dualAttacker, { weaponTier: 2 });
    const fatalHit = resolveMelee(tieredDualAttacker, dummy, () => 0.5, { hit: true, fatal: true });
    assert.strictEqual(fatalHit.fatal, true);
    // Base raw = 117, fatal bonus = round(117 * 0.6) = 70 => total raw = 187.
    assert.strictEqual(fatalHit.raw, 187);
    // elemRaw = round(187 / 3) = 62. physRaw = 187 - 62 = 125.
    assert.strictEqual(fatalHit.elemRaw, 62);
    assert.strictEqual(fatalHit.physRaw, 125);
    assert.strictEqual(fatalHit.final, 187);

    // -------------------------------------------------------------------------
    // 2. Inventory Loadout Extraction: Ember Cleaver (dual-element axe)
    // -------------------------------------------------------------------------
    const w = makeWorld({ autoIntervalTicks: 1 });
    const session = makeSession(w, warrior(1, { level: 35, axeSkill: 60 }));
    const itemDb = w.itemDb();

    const cleaverItem = findItem(itemDb, 'ember_cleaver');
    assert.ok(cleaverItem, 'ember_cleaver must exist in catalog');
    assert.strictEqual(cleaverItem.category, 'axe');
    assert.strictEqual(cleaverItem.atk, 27);
    assert.strictEqual(cleaverItem.extraAtk, 11);
    assert.strictEqual(cleaverItem.extraAtkElement, 'fire');

    // Equip ember_cleaver in rightHand
    const cleaverUid = createItemInstance(session.inventory, 'ember_cleaver', itemDb);
    const equipRes = placeInEquipment(session.inventory, cleaverUid, 'rightHand', itemDb);
    assert.ok(equipRes.ok);
    applyPlayerLoadout(session, itemDb);

    assert.strictEqual(session.atk, 27);
    assert.strictEqual(session.extraAtk, 11);
    assert.strictEqual(session.extraAtkElement, 'fire');
    assert.strictEqual(session.weaponSkill, 'axe');

    // Unequip ember_cleaver -> reverts to unarmed
    const unequipRes = unequipItem(session.inventory, 'rightHand', itemDb);
    assert.ok(unequipRes.ok);
    applyPlayerLoadout(session, itemDb);

    assert.strictEqual(session.atk, 7);
    assert.strictEqual(session.extraAtk, 0);
    assert.strictEqual(session.extraAtkElement, null);
    assert.strictEqual(session.weaponSkill, 'fist');

    // -------------------------------------------------------------------------
    // 3. World Integration: Swing with Ember Cleaver against High-Armor Target
    // -------------------------------------------------------------------------
    const cleaverUid2 = createItemInstance(session.inventory, 'ember_cleaver', itemDb);
    const equip2 = placeInEquipment(session.inventory, cleaverUid2, 'rightHand', itemDb);
    assert.ok(equip2.ok);
    applyPlayerLoadout(session, itemDb);

    session.attackReadyTick = 0;

    const target = {
        id: 9999,
        type: 'creature',
        name: 'Target Dummy',
        x: session.x,
        y: session.y - 1,
        z: session.z,
        hp: 100,
        hpMax: 100,
        armor: 150, // high armor to block physical damage
        mitigation: 0,
        resists: { physical: 0, fire: 0 },
        dead: false,
        downed: false
    };
    w.creatures.set(target.id, target);

    session.targetId = target.id;
    session.attackReadyTick = 0;

    const swung = w.trySwing(session, target, 0);
    assert.strictEqual(swung, true);

    const swingFrame = lastOf(session.socket, S2C.SWING);
    assert.ok(swingFrame, 'SWING frame must be sent');
    const swingData = decodeSwing(swingFrame.payload);
    assert.ok(swingData.amount > 0, 'Fire damage should damage the high-armor target');
    assert.strictEqual(target.hp, 100 - swingData.amount);

    console.log('ok combat_dual_element');
}

main();

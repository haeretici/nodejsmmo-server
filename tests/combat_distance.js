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
const { decodeSwing, decodeStats, decodeSay } = require('../src/protocol/messages');
const { resolveDistanceAuto, meleeAutoBounds, levelBonus } = require('../src/world/combat');
const { hasLineOfSight } = require('../src/world/shapes');
const {
    applyPlayerLoadout,
    createItemInstance,
    placeInEquipment,
    placeInContainer,
    getStackCount
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

function scout(id, opts) {
    const o = opts || {};
    return {
        id: id || 1,
        accountId: id || 1,
        name: 'Robin',
        vocation: 'scout',
        level: o.level || 1,
        experience: 0,
        hp: 150,
        hpMax: 150,
        mp: o.mp != null ? o.mp : 50,
        mpMax: o.mpMax != null ? o.mpMax : 100,
        townId: 1,
        skills: {
            distance: o.distanceSkill != null ? o.distanceSkill : 20,
            shielding: 10
        }
    };
}

function main() {
    // -------------------------------------------------------------------------
    // 1. Direct Combat Unit Test: resolveDistanceAuto
    // -------------------------------------------------------------------------
    // Bow (28) + Arrow (25) = effectiveAtk 53. Level 10, distance skill 30.
    const bowAttacker = {
        type: 'player',
        level: 10,
        atk: 53,
        weaponSkill: 'distance',
        skills: { distance: 30 },
        hitChance: 96,
        critChance: 0,
        weaponTier: 0
    };

    const unarmoredDummy = {
        type: 'creature',
        armor: 0,
        mitigation: 0,
        resists: { physical: 0 }
    };

    // Expected bounds: min = levelBonus(10) = 2.
    // max = ceil(0.102 * 53 * 30 + 2) = ceil(162.18 + 2) = 165.
    const expectedBounds = meleeAutoBounds(10, 53, 30, 0.102);
    assert.strictEqual(expectedBounds.min, 2);
    assert.strictEqual(expectedBounds.max, 165);

    // Test midpoint gaussian roll (rng => 0.5)
    const midHit = resolveDistanceAuto(bowAttacker, unarmoredDummy, () => 0.5, { hit: true });
    assert.strictEqual(midHit.miss, false);
    assert.strictEqual(midHit.hit, true);
    assert.strictEqual(midHit.raw, expectedBounds.min + Math.round(0.5 * (expectedBounds.max - expectedBounds.min)));
    assert.strictEqual(midHit.final, midHit.raw);

    // Test critical hit uses auto_st:
    // Min crit roll (floor raised to 0.65 * max = floor(107.25) = 107)
    const critMinHit = resolveDistanceAuto(bowAttacker, unarmoredDummy, () => 0, { hit: true, critical: true });
    assert.strictEqual(critMinHit.critical, true);
    assert.strictEqual(critMinHit.raw, 107, 'crit auto_st floor should be floor(0.65 * 165) = 107');

    // Max crit roll (upper bound 165)
    const critMaxHit = resolveDistanceAuto(bowAttacker, unarmoredDummy, () => 0.999999, { hit: true, critical: true });
    assert.strictEqual(critMaxHit.critical, true);
    assert.strictEqual(critMaxHit.raw, 165, 'crit auto_st max should be 165');

    // Test weapon tier fatal proc (+60% damage)
    const tieredAttacker = Object.assign({}, bowAttacker, { weaponTier: 2 });
    const fatalHit = resolveDistanceAuto(tieredAttacker, unarmoredDummy, () => 0.5, { hit: true, fatal: true });
    assert.strictEqual(fatalHit.fatal, true);
    assert.strictEqual(fatalHit.raw, midHit.raw + Math.round(midHit.raw * 0.6), 'fatal bonus must add 60% damage to raw roll');

    // Test hitChance miss
    const missedHit = resolveDistanceAuto(bowAttacker, unarmoredDummy, () => 0.5, { hit: false });
    assert.strictEqual(missedHit.miss, true);
    assert.strictEqual(missedHit.final, 0);

    // Test defender mitigation and armor reduction
    const armoredDefender = {
        type: 'creature',
        armor: 20,
        mitigation: 10,
        resists: { physical: 0 }
    };
    // With raw 100: mit 10% => 90. Armor 20 => reduction in [10, 19].
    const mitigatedHit = resolveDistanceAuto(
        bowAttacker,
        armoredDefender,
        () => 0.5,
        { hit: true }
    );
    assert.ok(mitigatedHit.final < mitigatedHit.raw, 'armored target must reduce distance damage');
    assert.ok(mitigatedHit.armorReduction > 0, 'armor reduction should apply to distance damage');

    const shieldedDummy = {
        type: 'creature',
        armor: 0,
        mitigation: 0,
        resists: { physical: 0 },
        canBlock: true,
        maxBlock: 40
    };
    const arrowVsShield = resolveDistanceAuto(
        bowAttacker,
        shieldedDummy,
        () => 0.5,
        { hit: true, currentTick: 0, isMelee: true }
    );
    assert.strictEqual(arrowVsShield.shieldBlock, 0, 'distance auto must not be shield-blocked');
    assert.strictEqual(arrowVsShield.blockChargeSpent, false, 'distance auto must not spend a shield charge');
    assert.strictEqual(arrowVsShield.final, arrowVsShield.raw, 'wooden_shield must not reduce arrow damage');

    // -------------------------------------------------------------------------
    // 2. Inventory Loadout Extraction: Bow + Arrow and Throwing Weapon
    // -------------------------------------------------------------------------
    const w = makeWorld({ autoIntervalTicks: 1 });
    const session = makeSession(w, scout(1, { level: 10, distanceSkill: 30 }));
    const itemDb = w.itemDb();

    // Verify hunter_bow and arrow exist in itemDb
    const bowItem = findItem(itemDb, 'hunter_bow');
    assert.ok(bowItem, 'hunter_bow must exist');
    assert.strictEqual(bowItem.weaponType, 'distance');
    assert.strictEqual(bowItem.category, 'bow');
    assert.strictEqual(bowItem.atk, 28);

    const arrowItem = findItem(itemDb, 'arrow');
    assert.ok(arrowItem, 'arrow must exist');
    assert.strictEqual(arrowItem.category, 'ammo');
    assert.strictEqual(arrowItem.atk, 25);
    assert.strictEqual(arrowItem.maxHitChance, 91);

    // Equip hunter_bow alone (no ammo)
    const bowUid = createItemInstance(session.inventory, 'hunter_bow', itemDb);
    const equipBow = placeInEquipment(session.inventory, bowUid, 'rightHand', itemDb);
    assert.ok(equipBow.ok);
    applyPlayerLoadout(session, itemDb);

    assert.strictEqual(session.weaponType, 'distance');
    assert.strictEqual(session.weaponSkill, 'distance');
    assert.strictEqual(session.atk, 28, 'without ammo, session.atk is weapon atk alone');
    assert.strictEqual(session.weaponRange, 6, 'default distance weapon range should be 6');
    assert.strictEqual(session.hitChance, 100);

    // Add quiver in leftHand with 10 arrows
    const quiverUid = createItemInstance(session.inventory, 'quiver', itemDb);
    const equipQuiver = placeInEquipment(session.inventory, quiverUid, 'leftHand', itemDb);
    assert.ok(equipQuiver.ok);
    const arrowUid = createItemInstance(session.inventory, 'arrow', itemDb, { count: 10 });
    const addArrowRes = placeInContainer(session.inventory, arrowUid, quiverUid, null, itemDb);
    assert.ok(addArrowRes.ok, 'arrows added to quiver');
    applyPlayerLoadout(session, itemDb);

    assert.strictEqual(session.atk, 53, 'with ammo, session.atk must equal bow.atk (28) + arrow.atk (25)');
    assert.strictEqual(session.hitChance, 91, 'hitChance should be arrow.maxHitChance (91) + bow.hitChanceMod (0)');

    // -------------------------------------------------------------------------
    // 3. World Integration: Range & Line of Sight
    // -------------------------------------------------------------------------
    session.x = 77;
    session.y = 99;
    session.z = 6;
    session.attackReadyTick = 0;

    const dummy = {
        id: 9999,
        type: 'creature',
        name: 'Target Dummy',
        x: 77,
        y: 99,
        z: 6,
        hp: 1000,
        hpMax: 1000,
        armor: 0,
        mitigation: 0,
        resists: { physical: 0 },
        dead: false,
        downed: false
    };
    w.creatures.set(dummy.id, dummy);

    // Attacks succeed at Chebyshev 1–6 (distance_auto.range fallback 6)
    for (const dist of [1, 2, 3, 4, 5, 6]) {
        dummy.x = 77 + dist;
        dummy.y = 99;
        session.attackReadyTick = 0;
        const swung = w.trySwing(session, dummy, 1);
        assert.ok(swung, `distance auto should succeed at distance ${dist}`);
    }

    dummy.x = 77 + 7;
    dummy.y = 99;
    session.attackReadyTick = 0;
    const swungDist7 = w.trySwing(session, dummy, 2);
    assert.strictEqual(swungDist7, false, 'distance auto must fail at Chebyshev 7');

    // Attacks are blocked by solid walls (LOS failure)
    dummy.x = 80;
    dummy.y = 99; // distance 3
    const layer = w.tileMap.getLayer(6);
    assert.ok(layer, 'tileMap layer 6 must exist');
    const wallIdx = w.tileMap.index(78, 99, layer.cols);
    const origSight = layer.sight[wallIdx];
    layer.sight[wallIdx] = 255;
    session.attackReadyTick = 0;

    const swungBlocked = w.trySwing(session, dummy, 3);
    assert.strictEqual(swungBlocked, false, 'distance attack must be blocked by solid wall');

    // Clear wall
    layer.sight[wallIdx] = origSight;
    session.attackReadyTick = 0;
    const swungCleared = w.trySwing(session, dummy, 4);
    assert.ok(swungCleared, 'distance attack must succeed once sight blocker is cleared');

    // -------------------------------------------------------------------------
    // 4. Ammunition Requirement & Consumption on Hit and Miss
    // -------------------------------------------------------------------------
    // Create new session with empty inventory
    const session2 = makeSession(w, scout(2, { level: 10, distanceSkill: 30 }), { x: 77, y: 99, z: 6 });
    session2.attackReadyTick = 0;

    // Equip bow with NO ammo
    const bow2Uid = createItemInstance(session2.inventory, 'hunter_bow', itemDb);
    placeInEquipment(session2.inventory, bow2Uid, 'rightHand', itemDb);
    applyPlayerLoadout(session2, itemDb);

    dummy.x = 79;
    dummy.y = 99; // distance 2

    // Swing without ammo should fail with "You need ammunition." and not arm auto CD.
    session2.socket.sent.length = 0;
    session2.attackReadyTick = 0;
    const noAmmoSwing = w.trySwing(session2, dummy, 10);
    assert.strictEqual(noAmmoSwing, false, 'swing without ammo must return false');
    assert.strictEqual(session2.attackReadyTick, 0, 'empty quiver must not bump attackReadyTick');

    const sayFrame = lastOf(session2.socket, S2C.SAY);
    assert.ok(sayFrame, 'must send SAY packet when ammunition is missing');
    const sayMsg = decodeSay(sayFrame.payload);
    assert.strictEqual(sayMsg, 'You need ammunition.');

    session2.socket.sent.length = 0;
    const noAmmoRetry = w.trySwing(session2, dummy, 10);
    assert.strictEqual(noAmmoRetry, false, 'retry on the same tick must still run (no ghost CD)');
    assert.strictEqual(session2.attackReadyTick, 0, 'retry must still leave attackReadyTick unarmed');
    const sayRetry = lastOf(session2.socket, S2C.SAY);
    assert.ok(sayRetry, 'retry without ammo must still SAY');
    assert.strictEqual(decodeSay(sayRetry.payload), 'You need ammunition.');

    // Now give session2 exactly 2 arrows in a quiver
    const quiver2Uid = createItemInstance(session2.inventory, 'quiver', itemDb);
    placeInEquipment(session2.inventory, quiver2Uid, 'leftHand', itemDb);
    const twoArrowsUid = createItemInstance(session2.inventory, 'arrow', itemDb, { count: 2 });
    const addTwo = placeInContainer(session2.inventory, twoArrowsUid, quiver2Uid, null, itemDb);
    assert.ok(addTwo.ok);
    applyPlayerLoadout(session2, itemDb);

    let arrowInst = session2.inventory.items[twoArrowsUid];
    assert.strictEqual(getStackCount(arrowInst), 2);

    // Shot 1: hit -> arrow count should decrease from 2 to 1
    session2.attackReadyTick = 0;
    const shot1 = w.trySwing(session2, dummy, 11);
    assert.ok(shot1, 'shot 1 should succeed');
    arrowInst = session2.inventory.items[twoArrowsUid];
    assert.strictEqual(getStackCount(arrowInst), 1, 'ammo count should be 1 after shot 1');

    // Shot 2: miss -> arrow count should decrease from 1 to 0 (consumed on miss too!)
    // Mock rng to return 0.999999 which fails hit check when hitChance is 91
    w.rng = () => 0.999999;
    session2.attackReadyTick = 0;
    const shot2 = w.trySwing(session2, dummy, 12);
    assert.ok(shot2, 'shot 2 should succeed even though swing missed');
    assert.strictEqual(session2.inventory.items[twoArrowsUid], undefined, 'last arrow instance should be destroyed when count reaches 0');
    assert.strictEqual(session2.atk, 28, 'atk should drop back to bow atk (28) when ammo is exhausted');

    // Shot 3: ammo empty -> swing should fail with "You need ammunition."
    session2.socket.sent.length = 0;
    session2.attackReadyTick = 0;
    const shot3 = w.trySwing(session2, dummy, 13);
    assert.strictEqual(shot3, false, 'shot 3 must fail when ammo is exhausted');
    assert.strictEqual(session2.attackReadyTick, 0, 'exhausted quiver must not bump attackReadyTick');
    const sayFrame3 = lastOf(session2.socket, S2C.SAY);
    assert.ok(sayFrame3);
    assert.strictEqual(decodeSay(sayFrame3.payload), 'You need ammunition.');

    // -------------------------------------------------------------------------
    // 5. Distance Skill Progression Advances Correctly (+2 blood hit / +1 mitigated)
    // -------------------------------------------------------------------------
    w.rng = () => 0.5; // restore normal rng
    const session3 = makeSession(w, scout(3, { level: 10, distanceSkill: 20 }), { x: 77, y: 99, z: 6 });
    session3.attackReadyTick = 0;

    // Equip bow + 50 arrows
    const bow3Uid = createItemInstance(session3.inventory, 'hunter_bow', itemDb);
    placeInEquipment(session3.inventory, bow3Uid, 'rightHand', itemDb);
    const quiver3Uid = createItemInstance(session3.inventory, 'quiver', itemDb);
    placeInEquipment(session3.inventory, quiver3Uid, 'leftHand', itemDb);
    const fiftyArrowsUid = createItemInstance(session3.inventory, 'arrow', itemDb, { count: 50 });
    const addFifty = placeInContainer(session3.inventory, fiftyArrowsUid, quiver3Uid, null, itemDb);
    assert.ok(addFifty.ok);
    applyPlayerLoadout(session3, itemDb);

    dummy.x = 79;
    dummy.y = 99;
    dummy.armor = 0;
    dummy.mitigation = 0;

    // Verify blood hit gives +2 distance tries
    const beforeTries = (session3.skillTriesGained && session3.skillTriesGained.distance) || 0;
    session3.attackReadyTick = 0;
    w.trySwing(session3, dummy, 20);
    const afterBloodTries = (session3.skillTriesGained && session3.skillTriesGained.distance) || 0;
    assert.strictEqual(afterBloodTries, beforeTries + 2, 'unmitigated blood hit should grant +2 distance tries');

    // Verify mitigated hit gives +1 distance try
    // Give dummy huge armor so final damage is 0
    dummy.armor = 1000;
    session3.attackReadyTick = 0;
    w.trySwing(session3, dummy, 21);
    const afterMitigatedTries = (session3.skillTriesGained && session3.skillTriesGained.distance) || 0;
    assert.strictEqual(afterMitigatedTries, afterBloodTries + 1, 'mitigated hit should grant +1 distance try');

    // -------------------------------------------------------------------------
    // 6. Throwing Weapon Support (e.g. nightshade_star)
    // -------------------------------------------------------------------------
    const session4 = makeSession(w, scout(4, { level: 10, distanceSkill: 25 }), { x: 77, y: 99, z: 6 });
    session4.attackReadyTick = 0;

    const starItem = findItem(itemDb, 'nightshade_star');
    assert.ok(starItem, 'nightshade_star must exist in itemDb');
    assert.strictEqual(starItem.category, 'spear');
    assert.strictEqual(starItem.atk, 65);
    assert.strictEqual(starItem.range, 4);
    assert.strictEqual(starItem.maxHitChance, 96);

    const starUid = createItemInstance(session4.inventory, 'nightshade_star', itemDb);
    placeInEquipment(session4.inventory, starUid, 'rightHand', itemDb);
    applyPlayerLoadout(session4, itemDb);

    assert.strictEqual(session4.weaponType, 'distance');
    assert.strictEqual(session4.weaponSkill, 'distance');
    assert.strictEqual(session4.atk, 65, 'throwing weapon atk is weapon atk');
    assert.strictEqual(session4.hitChance, 96, 'throwing weapon hitChance is weapon maxHitChance');
    assert.strictEqual(session4.weaponRange, 4);

    // Throwing attack does NOT require or consume quiver ammo
    dummy.x = 80; // distance 3 (within range 4)
    dummy.armor = 0;
    session4.attackReadyTick = 0;
    const starSwung = w.trySwing(session4, dummy, 30);
    assert.ok(starSwung, 'throwing weapon auto should succeed without quiver ammo');

    // -------------------------------------------------------------------------
    // 7. World: shielded dummy does not block player arrows
    // -------------------------------------------------------------------------
    w.rng = () => 0.5;
    dummy.x = 79;
    dummy.y = 99;
    dummy.hp = 1000;
    dummy.hpMax = 1000;
    dummy.armor = 0;
    dummy.mitigation = 0;
    dummy.canBlock = true;
    dummy.maxBlock = 1000;
    dummy.shieldBlocksThisWindow = 0;
    dummy.shieldBlockWindowTick = 0;
    session.attackReadyTick = 0;
    const hpBeforeShield = dummy.hp;
    const shieldedSwing = w.trySwing(session, dummy, 40);
    assert.ok(shieldedSwing, 'bow shot vs shielded dummy must swing');
    assert.ok(dummy.hp < hpBeforeShield, 'arrows must land through wooden_shield (isMelee: false)');
    assert.strictEqual(dummy.shieldBlocksThisWindow, 0, 'player distance auto must not spend a shield charge');

    w.stop();
    console.log('ok combat_distance');
}

main();

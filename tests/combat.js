'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SERVER_ROOT } = require('./helpers');
const {
    levelBonus,
    meleeAutoBounds,
    gaussianRaw,
    uniformRaw,
    autoStCritRollMin,
    rollArmorReduction,
    rollCritical,
    fatalChanceFromTier,
    rollFatal,
    applyFatalBonus,
    resolveMelee,
    meleeRangeOk,
    chebyshev,
    classRow,
    playerCombatFromClass,
    MELEE_AUTO_FACTOR,
    UNARMED_ATK,
    FATAL_DAMAGE_BONUS
} = require('../src/world/combat');

function loadRatKit() {
    const file = path.join(SERVER_ROOT, '..', 'content', 'creatures', 'rat.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
    assert.strictEqual(levelBonus(1), 0);
    assert.strictEqual(levelBonus(5), 1);
    assert.strictEqual(levelBonus(500), 100);

    const bounds = meleeAutoBounds(1, UNARMED_ATK, 10, MELEE_AUTO_FACTOR);
    assert.strictEqual(bounds.min, 0);
    assert.strictEqual(bounds.max, 8);

    const mid = gaussianRaw(0, 8, () => 0.5);
    assert.strictEqual(mid, 4);

    assert.strictEqual(uniformRaw(0, 26, () => 0), 0);
    assert.strictEqual(uniformRaw(0, 26, () => 0.999), 26);

    assert.strictEqual(rollArmorReduction(0, () => 0.5), 0);
    assert.strictEqual(rollArmorReduction(1, () => 0.5), 1);
    assert.strictEqual(rollArmorReduction(5, () => 0), 3);

    const player = { type: 'player', level: 1, skills: { fist: 10 } };
    const dummy = { type: 'creature', armor: 0, mitigation: 0, resists: { physical: 0 } };
    const hit = resolveMelee(player, dummy, () => 0.5);
    assert.strictEqual(hit.miss, false);
    assert.strictEqual(hit.final, 4);

    const swordsman = {
        type: 'player',
        level: 1,
        atk: 42,
        weaponSkill: 'sword',
        skills: { fist: 10, sword: 50 },
        weaponTier: 0
    };
    const swordHit = resolveMelee(swordsman, dummy, () => 0.5);
    const swordBounds = meleeAutoBounds(1, 42, 50, MELEE_AUTO_FACTOR);
    assert.strictEqual(swordHit.miss, false);
    assert.ok(swordBounds.max > 8);
    assert.strictEqual(swordHit.raw, swordBounds.min + Math.round(0.5 * (swordBounds.max - swordBounds.min)));
    assert.strictEqual(hit.critical, false);
    assert.strictEqual(hit.fatal, false);

    const rat = {
        type: 'creature',
        attacks: [{ min: 0, max: 26, chance: 100 }]
    };
    const naked = { type: 'player', armor: 0, mitigation: 0 };
    const kit = resolveMelee(rat, naked, () => 0.5);
    assert.strictEqual(kit.final, 13);

    const miss = resolveMelee(
        { type: 'creature', attacks: [{ min: 5, max: 5, chance: 0 }] },
        dummy,
        () => 0
    );
    assert.strictEqual(miss.miss, true);
    assert.strictEqual(miss.final, 0);

    const armored = { armor: 5, mitigation: 0 };
    const vsArmor = resolveMelee(
        { type: 'creature', attacks: [{ min: 10, max: 10, chance: 100 }] },
        armored,
        () => 0
    );
    assert.strictEqual(vsArmor.final, 7);

    assert.strictEqual(chebyshev(12, 12, 12, 11), 1);
    assert.ok(meleeRangeOk(
        { x: 12, y: 12, z: 0 },
        { x: 12, y: 11, z: 0 }
    ));
    assert.ok(!meleeRangeOk(
        { x: 12, y: 12, z: 0 },
        { x: 12, y: 10, z: 0 }
    ));

    const live = loadRatKit();
    assert.strictEqual(live.id, 'rat');
    assert.strictEqual(live.hp, 20);
    assert.strictEqual(live.armor, 1);
    assert.strictEqual(live.mitigation, 0.07);
    assert.strictEqual(live.attacks[0].min, 0);
    assert.strictEqual(live.attacks[0].max, 21);
    const liveRat = {
        type: 'creature',
        armor: live.armor,
        mitigation: live.mitigation,
        resists: live.resists,
        canBlock: live.canBlock,
        maxBlock: live.maxBlock,
        attacks: live.attacks
    };
    const fist = {
        type: 'player',
        level: 1,
        skills: { fist: 10 },
        critChance: 5,
        critDamage: 10,
        weaponTier: 0
    };
    const vsLive = resolveMelee(fist, liveRat, () => 0.5);
    assert.strictEqual(vsLive.miss, false);
    assert.strictEqual(vsLive.critical, false);
    assert.strictEqual(vsLive.fatal, false);
    assert.strictEqual(vsLive.raw, 4);
    assert.strictEqual(vsLive.final, 2);

    const vsLiveCrit = resolveMelee(fist, liveRat, () => 0);
    assert.strictEqual(vsLiveCrit.critical, true);
    assert.strictEqual(vsLiveCrit.fatal, false);
    assert.strictEqual(vsLiveCrit.raw, 5);
    assert.strictEqual(vsLiveCrit.final, 3);

    const ratSwing = resolveMelee(
        { type: 'creature', attacks: live.attacks },
        { type: 'player', armor: 0, mitigation: 0 },
        () => 0.5
    );
    assert.strictEqual(ratSwing.raw, 11);
    assert.strictEqual(ratSwing.final, 11);

    assert.strictEqual(autoStCritRollMin(10, 20), 13);
    assert.strictEqual(rollCritical(0, () => 0), false);
    assert.strictEqual(rollCritical(100, () => 0.99), true);

    const critter = resolveMelee(
        {
            type: 'creature',
            critChance: 100,
            critDamage: 10,
            attacks: [{ min: 10, max: 100, chance: 100, kind: 'melee' }]
        },
        dummy,
        () => 0
    );
    assert.strictEqual(critter.critical, true);
    assert.strictEqual(critter.fatal, false);
    assert.strictEqual(critter.raw, 11);
    assert.ok(critter.raw < autoStCritRollMin(10, 100));

    const noCrit = resolveMelee(
        {
            type: 'creature',
            critChance: 0,
            critDamage: 10,
            attacks: [{ min: 100, max: 100, chance: 100 }]
        },
        dummy,
        () => 0
    );
    assert.strictEqual(noCrit.critical, false);
    assert.strictEqual(noCrit.raw, 100);

    assert.strictEqual(fatalChanceFromTier(0), 0);
    assert.strictEqual(fatalChanceFromTier(1), 0.5);
    assert.strictEqual(fatalChanceFromTier(2), 1.05);
    assert.strictEqual(FATAL_DAMAGE_BONUS, 0.6);
    assert.strictEqual(applyFatalBonus(100), 160);
    assert.strictEqual(rollFatal(0, () => 0), false);
    assert.strictEqual(rollFatal(0.5, () => 0), true);
    assert.strictEqual(rollFatal(0.5, () => 0.005), false);

    const fatalHit = resolveMelee(
        { type: 'player', level: 1, skills: { fist: 10 }, weaponTier: 1, critChance: 0 },
        dummy,
        () => 0
    );
    assert.strictEqual(fatalHit.fatal, true);
    assert.strictEqual(fatalHit.critical, false);
    assert.strictEqual(fatalHit.raw, applyFatalBonus(4));

    const unarmed = resolveMelee(
        { type: 'player', level: 1, skills: { fist: 10 }, weaponTier: 0, critChance: 0 },
        dummy,
        () => 0
    );
    assert.strictEqual(unarmed.fatal, false);
    assert.strictEqual(unarmed.raw, 4);

    const creatureFatal = resolveMelee(
        {
            type: 'creature',
            weaponTier: 10,
            attacks: [{ min: 100, max: 100, chance: 100 }]
        },
        dummy,
        () => 0
    );
    assert.strictEqual(creatureFatal.fatal, false);
    assert.strictEqual(creatureFatal.raw, 100);

    const classesDoc = JSON.parse(fs.readFileSync(
        path.join(SERVER_ROOT, '..', 'content', 'classes.json'),
        'utf8'
    ));
    const scout = classRow({ classes: classesDoc }, 'scout');
    assert.ok(scout);
    assert.strictEqual(scout.critChance, 5);
    const bag = playerCombatFromClass(scout);
    assert.strictEqual(bag.critChance, 5);
    assert.strictEqual(bag.critDamage, 10);

    console.log('ok combat');
}

main();

'use strict';

const assert = require('assert');
const path = require('path');
const {
    asRange,
    asHealRange,
    asManaRange,
    itemDbFromPack
} = require('../src/world/items');
const {
    resolveItemUseEffect,
    applyItemUseEffect,
    rollRange,
    FOOD_SEC_PER_NUTRITION,
    FOOD_MAX_SECONDS,
    foodAddSeconds,
    tryFeed
} = require('../src/world/item_use');

function main() {
    assert.deepStrictEqual(asRange([60, 90]), [60, 90]);
    assert.deepStrictEqual(asRange([90, 60]), [60, 90]);
    assert.deepStrictEqual(asRange(40), [40, 40]);
    assert.strictEqual(asRange(null), null);
    assert.strictEqual(asRange(Number.NaN), null);

    const smallHp = { id: 'small_health_potion', heal: [60, 90], usable: true, consumable: true };
    assert.deepStrictEqual(asHealRange(smallHp), [60, 90]);
    const eHp = resolveItemUseEffect(smallHp);
    assert.deepStrictEqual(eHp.heal, [60, 90]);
    assert.strictEqual(eHp.mana, null);
    assert.ok(eHp.known);

    const mana = { id: 'mana_potion', restoreMana: [75, 125], usable: true, consumable: true };
    assert.deepStrictEqual(asManaRange(mana), [75, 125]);
    const eMana = resolveItemUseEffect(mana);
    assert.deepStrictEqual(eMana.mana, [75, 125]);
    assert.ok(eMana.known);

    const healMin = { healMin: 150, healMax: 200 };
    assert.deepStrictEqual(asHealRange(healMin), [150, 200]);

    const dual = {
        id: 'great_dual_potion',
        heal: [250, 350],
        restoreMana: [100, 200]
    };
    const eDual = resolveItemUseEffect(dual);
    assert.deepStrictEqual(eDual.heal, [250, 350]);
    assert.deepStrictEqual(eDual.mana, [100, 200]);

    const anti = { id: 'antidote_potion', dispel: ['poison'], usable: true };
    const eAnti = resolveItemUseEffect(anti);
    assert.deepStrictEqual(eAnti.dispel, ['poison']);
    assert.ok(eAnti.known);

    const shield = {
        id: 'magic_shield_potion',
        condition: { type: 'mana_shield', durationSec: 60, poolFormula: 'legacy_mana_shield' },
        usable: true
    };
    const eShield = resolveItemUseEffect(shield);
    assert.strictEqual(eShield.condition.type, 'mana_shield');
    assert.strictEqual(eShield.condition.durationSec, 60);
    assert.ok(eShield.known);

    const berserk = { id: 'berserk_potion', usable: true, consumable: true, category: 'potion' };
    const eBerserk = resolveItemUseEffect(berserk);
    assert.strictEqual(eBerserk.known, false);
    assert.strictEqual(eBerserk.heal, null);
    assert.strictEqual(eBerserk.condition, null);

    const meat = { id: 'meat', category: 'food', usable: true, consumable: true, nutrition: 15, eatText: 'Munch.' };
    const eMeat = resolveItemUseEffect(meat);
    assert.strictEqual(eMeat.condition, null);
    assert.strictEqual(eMeat.known, false);
    assert.strictEqual(foodAddSeconds(meat), 15 * FOOD_SEC_PER_NUTRITION);
    assert.strictEqual(FOOD_MAX_SECONDS, 1200);

    const ham = {
        id: 'ham',
        category: 'food',
        usable: true,
        durationSec: 180
    };
    assert.strictEqual(foodAddSeconds(ham), 180);
    const eater = { foodSeconds: 0 };
    assert.strictEqual(tryFeed(eater, meat).ok, true);
    assert.strictEqual(eater.foodSeconds, 180);
    assert.strictEqual(tryFeed(eater, meat).foodSeconds, 360);
    eater.foodSeconds = 1100;
    const full = tryFeed(eater, meat);
    assert.strictEqual(full.reason, 'full');
    assert.strictEqual(eater.foodSeconds, 1100);
    eater.foodSeconds = 0;
    const dragon = { id: 'dragon_ham', category: 'food', nutrition: 60, eatText: 'Chomp.' };
    assert.strictEqual(tryFeed(eater, dragon).foodSeconds, 720);
    assert.strictEqual(tryFeed(eater, dragon).reason, 'full');
    assert.strictEqual(eater.foodSeconds, 720);

    const authoredFood = {
        id: 'special_stew',
        category: 'food',
        condition: { type: 'regen', healthGain: 5, intervalSec: 2, durationSec: 30 }
    };
    const eStew = resolveItemUseEffect(authoredFood);
    assert.strictEqual(eStew.condition.healthGain, 5);
    assert.strictEqual(eStew.condition.durationSec, 30);

    assert.strictEqual(rollRange([5, 5], () => 0.9), 5);
    assert.strictEqual(rollRange([10, 20], () => 0), 10);
    assert.strictEqual(rollRange([10, 20], () => 0.999), 20);
    assert.strictEqual(rollRange([60, 90], () => 0.5), 75);

    const target = {
        hp: 10,
        hpMax: 1000,
        mp: 20,
        mpMax: 500,
        conditions: [{ kind: 'poison', remainingDamage: 40 }]
    };
    const r = applyItemUseEffect(target, resolveItemUseEffect({
        heal: [250, 250],
        restoreMana: [100, 100]
    }), { rng: () => 0 });
    assert.strictEqual(r.healRoll, 250);
    assert.strictEqual(r.manaRoll, 100);
    assert.strictEqual(target.hp, 260);
    assert.strictEqual(target.mp, 120);

    const r2 = applyItemUseEffect(target, resolveItemUseEffect(anti), { rng: () => 0 });
    assert.strictEqual(r2.dispelled, 1);
    assert.strictEqual(target.conditions.length, 0);

    const drinker = {
        hp: 500,
        hpMax: 500,
        mp: 425,
        mpMax: 425,
        level: 14,
        skills: { magic: 0 },
        conditions: []
    };
    const r3 = applyItemUseEffect(drinker, eShield, { rng: () => 0 });
    assert.ok(r3.conditionApplied);
    assert.strictEqual(r3.conditionApplied.kind, 'mana_shield');
    assert.strictEqual(r3.conditionApplied.durationSec, 60);
    assert.strictEqual(r3.conditionApplied.poolRemaining, 406);
    assert.strictEqual(drinker.conditions.length, 1);

    const plainEater = { hp: 50, hpMax: 185, mp: 90, mpMax: 90, foodSeconds: 0 };
    const r4 = applyItemUseEffect(plainEater, eMeat, { rng: () => 0 });
    assert.strictEqual(r4.conditionApplied, null);
    assert.strictEqual(plainEater.hp, 50);

    const packEq = require(path.join(__dirname, '../../content/equipment.json'));
    const liveDb = itemDbFromPack({ equipment: packEq });
    const liveHp = resolveItemUseEffect(liveDb.small_health_potion);
    assert.deepStrictEqual(liveHp.heal, [60, 90]);
    const liveMana = resolveItemUseEffect(liveDb.mana_potion);
    assert.deepStrictEqual(liveMana.mana, [75, 125]);
    const liveAnti = resolveItemUseEffect(liveDb.antidote_potion);
    assert.deepStrictEqual(liveAnti.dispel, ['poison']);
    const liveShield = resolveItemUseEffect(liveDb.magic_shield_potion);
    assert.strictEqual(liveShield.condition.type, 'mana_shield');
    const liveMeat = resolveItemUseEffect(liveDb.meat);
    assert.strictEqual(liveMeat.condition, null);
    const liveFood = {
        meat: [15, 'Munch.'],
        ham: [30, 'Chomp.'],
        dragon_ham: [60, 'Chomp.'],
        fish: [12, 'Munch.'],
        shrimp: [4, 'Gulp.'],
        cheese: [9, 'Smack.'],
        cookie: [2, 'Crunch.'],
        bread: [10, 'Crunch.'],
        brown_bread: [8, 'Crunch.'],
        brown_mushroom: [22, 'Munch.'],
        green_mushroom: [5, 'Munch.'],
        white_mushroom: [9, 'Munch.'],
        dark_mushroom: [6, 'Munch.'],
        grapes: [9, 'Yum.'],
        carrot: [5, 'Crunch.']
    };
    for (const [id, pair] of Object.entries(liveFood)) {
        const row = liveDb[id];
        assert.ok(row, id);
        assert.strictEqual(row.nutrition, pair[0], id + ' nutrition');
        assert.strictEqual(row.eatText, pair[1], id + ' eatText');
        assert.strictEqual(foodAddSeconds(row), pair[0] * FOOD_SEC_PER_NUTRITION, id + ' seconds');
    }
    const liveBerserk = resolveItemUseEffect(liveDb.berserk_potion);
    assert.strictEqual(liveBerserk.known, false);

    console.log('ok item_use');
}

main();

'use strict';

/** Product port of HuntDL item_use. Catalog row is source of truth. No potion id table. */

const {
    asHealRange,
    asManaRange,
    asCondition,
    asDispel,
    itemIsFood
} = require('./items');
const { applyCondition, removeConditions } = require('./conditions');

const FOOD_REGEN_HEALTH_GAIN = 1;
const FOOD_REGEN_INTERVAL_SEC = 3;
const FOOD_REGEN_DURATION_SEC = 60;

function defaultFoodCondition(item) {
    if (!itemIsFood(item)) return null;
    const durationSec = item.durationSec != null && Number(item.durationSec) > 0
        ? Number(item.durationSec)
        : FOOD_REGEN_DURATION_SEC;
    const healthGain = item.healthGain != null && Number(item.healthGain) > 0
        ? Number(item.healthGain)
        : FOOD_REGEN_HEALTH_GAIN;
    const intervalSec = item.intervalSec != null && Number(item.intervalSec) > 0
        ? Number(item.intervalSec)
        : FOOD_REGEN_INTERVAL_SEC;
    return {
        type: 'regen',
        healthGain,
        intervalSec,
        durationSec
    };
}

function resolveItemUseEffect(item) {
    const use = item && item.use && typeof item.use === 'object' ? item.use : null;
    const heal = asHealRange(item);
    const mana = asManaRange(item);
    let dispel = [];
    if (item && Array.isArray(item.dispel)) {
        dispel = asDispel(item.dispel);
    } else if (use && Array.isArray(use.dispel)) {
        dispel = asDispel(use.dispel);
    }
    let condition = asCondition(item && item.condition) || asCondition(use && use.condition) || null;
    if (!condition && !heal && !mana && !dispel.length) {
        condition = defaultFoodCondition(item);
    }
    const known = !!(heal || mana || dispel.length || condition);
    return { heal, mana, dispel, condition, known };
}

function rollRange(range, rng) {
    if (!range) return 0;
    const lo = Math.floor(range[0]);
    const hi = Math.floor(range[1]);
    if (hi <= lo) return Math.max(0, lo);
    const r = typeof rng === 'function' ? rng() : Math.random();
    const u = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : Math.random();
    return lo + Math.floor(u * (hi - lo + 1));
}

function applyItemUseEffect(target, effect, opts) {
    const rng = opts && opts.rng;
    const healRoll = effect && effect.heal ? rollRange(effect.heal, rng) : 0;
    const manaRoll = effect && effect.mana ? rollRange(effect.mana, rng) : 0;
    let hpDelta = 0;
    let mpDelta = 0;
    if (healRoll > 0 && target) {
        const before = target.hp | 0;
        const max = target.hpMax != null ? target.hpMax | 0 : before + healRoll;
        target.hp = Math.min(max, before + healRoll);
        if (target.character) target.character.hp = target.hp;
        hpDelta = (target.hp | 0) - before;
    }
    if (manaRoll > 0 && target) {
        const before = target.mp | 0;
        const max = target.mpMax != null ? target.mpMax | 0 : before + manaRoll;
        target.mp = Math.min(max, before + manaRoll);
        if (target.character) target.character.mp = target.mp;
        mpDelta = (target.mp | 0) - before;
    }
    const dispelled =
        effect && effect.dispel && effect.dispel.length
            ? removeConditions(target, effect.dispel)
            : 0;
    let conditionApplied = null;
    if (effect && effect.condition) {
        conditionApplied = applyCondition(target, effect.condition) || null;
    }
    return { hpDelta, mpDelta, dispelled, healRoll, manaRoll, conditionApplied };
}

module.exports = {
    FOOD_REGEN_HEALTH_GAIN,
    FOOD_REGEN_INTERVAL_SEC,
    FOOD_REGEN_DURATION_SEC,
    resolveItemUseEffect,
    applyItemUseEffect,
    rollRange,
    defaultFoodCondition
};

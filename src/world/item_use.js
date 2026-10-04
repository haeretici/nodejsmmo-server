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

/** Legacy foods.lua: each nutrition point is 12 seconds. Cap is 1200 seconds. */
const FOOD_SEC_PER_NUTRITION = 12;
const FOOD_MAX_SECONDS = 1200;

function foodNutrition(item) {
    const n = Math.floor(Number(item && item.nutrition));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n;
}

/**
 * Seconds one bite adds. `nutrition` × 12 wins. A food row with no nutrition
 * uses `durationSec` as the satiation seconds.
 */
function foodAddSeconds(item) {
    if (!itemIsFood(item)) return 0;
    const nutrition = foodNutrition(item);
    if (nutrition > 0) return nutrition * FOOD_SEC_PER_NUTRITION;
    const sec = Math.floor(Number(item && item.durationSec));
    if (Number.isFinite(sec) && sec > 0) return sec;
    return 0;
}

function foodEatText(item) {
    const raw = item && (item.eatText != null ? item.eatText : item.say);
    const text = raw == null ? '' : String(raw).trim();
    return text || 'Munch.';
}

/**
 * Extend satiation. Already fed and `current + add >= 1200` refuses the bite
 * (legacy "You are full."). A bite from hungry is accepted even past 1200.
 */
function tryFeed(entity, item) {
    const add = foodAddSeconds(item);
    if (!(add > 0) || !entity) return { ok: false, reason: 'not_food', add: 0 };
    const cur = Math.max(0, Math.floor(Number(entity.foodSeconds) || 0));
    if (cur > 0 && cur + add >= FOOD_MAX_SECONDS) {
        return { ok: false, reason: 'full', foodSeconds: cur, add };
    }
    entity.foodSeconds = cur + add;
    return {
        ok: true,
        foodSeconds: entity.foodSeconds,
        add,
        text: foodEatText(item)
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
    const condition = asCondition(item && item.condition) || asCondition(use && use.condition) || null;
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
    FOOD_SEC_PER_NUTRITION,
    FOOD_MAX_SECONDS,
    foodNutrition,
    foodAddSeconds,
    foodEatText,
    tryFeed,
    resolveItemUseEffect,
    applyItemUseEffect,
    rollRange
};

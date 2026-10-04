'use strict';

/** Vocation regen paced by food, plus equipped duration decay. Integer ticks. No Date.now. */

const { findItem } = require('./items');

const DEFAULT_FULL_HP_MS = 3000;
const DEFAULT_FULL_MP_MS = 5000;
const DEFAULT_BASE_HP_MS = 4000;
const DEFAULT_BASE_MP_MS = 6000;
const DEFAULT_REGEN_HP_TICKS = 60;
const DEFAULT_REGEN_MP_TICKS = 100;
const DEFAULT_HUNGRY_REGEN_HP_TICKS = 80;
const DEFAULT_HUNGRY_REGEN_MP_TICKS = 120;

function asNonNegInt(v, fallback) {
    if (v == null || v === '') return fallback;
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) return fallback;
    return n;
}

function nativeRegenRates(cls, promoted) {
    if (!cls || typeof cls !== 'object') return { hp: 0, mp: 0 };
    const useProm = !!promoted;
    const hp = useProm && cls.promotedRegenHp != null
        ? Number(cls.promotedRegenHp)
        : Number(cls.baseRegenHp || 0);
    const mp = useProm && cls.promotedRegenMp != null
        ? Number(cls.promotedRegenMp)
        : Number(cls.baseRegenMp || 0);
    return {
        hp: Number.isFinite(hp) && hp > 0 ? Math.floor(hp) : 0,
        mp: Number.isFinite(mp) && mp > 0 ? Math.floor(mp) : 0
    };
}

function pickSetting(settings, keys) {
    const s = settings || {};
    for (let i = 0; i < keys.length; i++) {
        const v = s[keys[i]];
        if (v != null && v !== '') return v;
    }
    return undefined;
}

function ticksFromMs(ms, ups, fallbackMs) {
    const chosen = asNonNegInt(ms, fallbackMs);
    return Math.max(1, intervalMsToTicks(chosen, ups));
}

/**
 * Full stomach (`hungry` false) uses fullRegen*IntervalMs: 3000 HP / 5000 MP.
 * Hungry uses baseRegen*IntervalMs: 4000 HP / 6000 MP.
 * A living target does not change the pace. Milliseconds become logic ticks.
 * Older tick keys apply only when the matching millisecond key is absent.
 */
function regenIntervalTicks(settings, hungry, ups) {
    const u = (ups | 0) || (settings && (settings.logicUps | 0)) || 20;
    if (hungry) {
        const hpMs = pickSetting(settings, ['baseRegenHpIntervalMs', 'baseRegenHPIntervalMS']);
        const mpMs = pickSetting(settings, ['baseRegenMpIntervalMs', 'baseRegenMPIntervalMS']);
        const hpTicks = hpMs != null
            ? ticksFromMs(hpMs, u, DEFAULT_BASE_HP_MS)
            : Math.max(1, asNonNegInt(
                pickSetting(settings, ['hungryRegenHpTicks', 'engageRegenHpTicks']),
                DEFAULT_HUNGRY_REGEN_HP_TICKS
            ));
        const mpTicks = mpMs != null
            ? ticksFromMs(mpMs, u, DEFAULT_BASE_MP_MS)
            : Math.max(1, asNonNegInt(
                pickSetting(settings, ['hungryRegenMpTicks', 'engageRegenMpTicks']),
                DEFAULT_HUNGRY_REGEN_MP_TICKS
            ));
        return { hpTicks, mpTicks };
    }
    const hpMs = pickSetting(settings, ['fullRegenHpIntervalMs', 'fullRegenHPIntervalMS']);
    const mpMs = pickSetting(settings, ['fullRegenMpIntervalMs', 'fullRegenMPIntervalMS']);
    const hpTicks = hpMs != null
        ? ticksFromMs(hpMs, u, DEFAULT_FULL_HP_MS)
        : Math.max(1, asNonNegInt(pickSetting(settings, ['regenHpTicks']), DEFAULT_REGEN_HP_TICKS));
    const mpTicks = mpMs != null
        ? ticksFromMs(mpMs, u, DEFAULT_FULL_MP_MS)
        : Math.max(1, asNonNegInt(pickSetting(settings, ['regenMpTicks']), DEFAULT_REGEN_MP_TICKS));
    return { hpTicks, mpTicks };
}

/**
 * Count one logic tick of satiation. One second is `ups` ticks.
 * Returns whether the player is hungry after the tick, and whether this tick
 * is the one that reached zero.
 */
function tickFoodSatiation(entity, ups) {
    if (!entity) return { hungry: true, expired: false };
    const upsN = Math.max(1, (ups | 0) || 20);
    const cur = Math.max(0, Math.floor(Number(entity.foodSeconds) || 0));
    entity.foodSeconds = cur;
    if (cur <= 0) {
        entity._foodSubTicks = 0;
        return { hungry: true, expired: false };
    }
    entity._foodSubTicks = (entity._foodSubTicks | 0) + 1;
    if (entity._foodSubTicks < upsN) return { hungry: false, expired: false };
    const steps = Math.floor(entity._foodSubTicks / upsN);
    entity._foodSubTicks -= steps * upsN;
    entity.foodSeconds = Math.max(0, cur - steps);
    if (entity.foodSeconds === 0) entity._foodSubTicks = 0;
    const expired = entity.foodSeconds === 0;
    return { hungry: expired, expired };
}

function intervalMsToTicks(ms, ups) {
    const u = (ups | 0) || 20;
    const n = Math.round((Number(ms) || 0) * u / 1000);
    return n > 0 ? n : 0;
}

function skipRegenEntity(entity) {
    if (!entity) return true;
    if (entity.simSleeping) return true;
    if (entity.downed || entity.dead) return true;
    if (entity.alive === false) return true;
    if ((entity.hp | 0) <= 0) return true;
    return false;
}

/**
 * Advance vocation HP/MP accumulators by one logic tick.
 * Returns pending restore amounts (caller clamps to pools).
 */
function tickNativeRegen(entity, rates, intervals) {
    if (skipRegenEntity(entity)) return { hpDelta: 0, mpDelta: 0 };
    const hpAmt = rates && rates.hp > 0 ? rates.hp | 0 : 0;
    const mpAmt = rates && rates.mp > 0 ? rates.mp | 0 : 0;
    const hpInt = intervals && intervals.hpTicks > 0 ? intervals.hpTicks | 0 : 0;
    const mpInt = intervals && intervals.mpTicks > 0 ? intervals.mpTicks | 0 : 0;
    let hpDelta = 0;
    let mpDelta = 0;
    if (hpAmt > 0 && hpInt > 0) {
        entity._regenHpTicks = (entity._regenHpTicks | 0) + 1;
        while (entity._regenHpTicks >= hpInt) {
            entity._regenHpTicks -= hpInt;
            hpDelta += hpAmt;
        }
    }
    if (mpAmt > 0 && mpInt > 0) {
        entity._regenMpTicks = (entity._regenMpTicks | 0) + 1;
        while (entity._regenMpTicks >= mpInt) {
            entity._regenMpTicks -= mpInt;
            mpDelta += mpAmt;
        }
    }
    return { hpDelta, mpDelta };
}

function itemDurationSec(inst, item) {
    if (inst && inst.remainingDurationSec != null && Number.isFinite(Number(inst.remainingDurationSec))) {
        return Math.max(0, Number(inst.remainingDurationSec));
    }
    if (item && item.durationSec != null && Number.isFinite(Number(item.durationSec))) {
        return Math.max(0, Number(item.durationSec));
    }
    return 0;
}

function ensureDurationTicks(inst, item, ups) {
    if (inst.remainingDurationTicks != null && Number.isFinite(Number(inst.remainingDurationTicks))) {
        return Math.max(0, Math.floor(Number(inst.remainingDurationTicks)));
    }
    const sec = itemDurationSec(inst, item);
    const ticks = Math.max(0, Math.round(sec * ((ups | 0) || 20)));
    inst.remainingDurationTicks = ticks;
    if (inst.remainingDurationSec == null && sec > 0) inst.remainingDurationSec = sec;
    return ticks;
}

/**
 * Decay equipped duration items by one logic tick. Stowed leftover budgets freeze.
 */
function tickEquippedDurations(inv, itemDb, ups) {
    const expiredSlots = [];
    const expiredUids = [];
    if (!inv || !inv.equipment || typeof inv.equipment !== 'object') {
        return { expiredSlots, expiredUids, changed: false };
    }
    const u = (ups | 0) || 20;
    let changed = false;
    const slots = Object.keys(inv.equipment);
    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (slot === 'backpack') continue;
        const uid = inv.equipment[slot];
        if (!uid) continue;
        const inst = inv.items && inv.items[uid];
        if (!inst) continue;
        const item = findItem(itemDb, inst.itemId);
        const catalogDur = item && item.durationSec != null && Number(item.durationSec) > 0;
        const instDur = inst.remainingDurationSec != null && Number.isFinite(Number(inst.remainingDurationSec));
        if (!catalogDur && !instDur && inst.remainingDurationTicks == null) continue;
        const ticks = ensureDurationTicks(inst, item, u);
        if (ticks <= 0) {
            inst.remainingDurationSec = 0;
            inst.remainingDurationTicks = 0;
            expiredSlots.push(slot);
            expiredUids.push(uid);
            changed = true;
            continue;
        }
        inst.remainingDurationTicks = ticks - 1;
        inst.remainingDurationSec = inst.remainingDurationTicks / u;
        changed = true;
        if (inst.remainingDurationTicks <= 0) {
            inst.remainingDurationSec = 0;
            inst.remainingDurationTicks = 0;
            expiredSlots.push(slot);
            expiredUids.push(uid);
        }
    }
    return { expiredSlots, expiredUids, changed };
}

/**
 * Independent equipment regen (catalog regen.hp/mp + *TicksMs → integer ticks).
 */
function tickEquippedItemRegen(inv, itemDb, ups) {
    let hpDelta = 0;
    let mpDelta = 0;
    if (!inv || !inv.equipment || typeof inv.equipment !== 'object') {
        return { hpDelta, mpDelta };
    }
    const u = (ups | 0) || 20;
    const slots = Object.keys(inv.equipment);
    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (slot === 'backpack') continue;
        const uid = inv.equipment[slot];
        if (!uid) continue;
        const inst = inv.items && inv.items[uid];
        if (!inst) continue;
        const item = findItem(itemDb, inst.itemId);
        const r = item && item.regen && typeof item.regen === 'object' ? item.regen : null;
        if (!r) continue;
        const hpInt = intervalMsToTicks(r.hpTicksMs, u);
        const hpAmt = Number(r.hp);
        if (hpInt > 0 && Number.isFinite(hpAmt) && hpAmt !== 0) {
            inst._regenHpTicks = (inst._regenHpTicks | 0) + 1;
            while (inst._regenHpTicks >= hpInt) {
                inst._regenHpTicks -= hpInt;
                hpDelta += hpAmt;
            }
        }
        const mpInt = intervalMsToTicks(r.mpTicksMs, u);
        const mpAmt = Number(r.mp);
        if (mpInt > 0 && Number.isFinite(mpAmt) && mpAmt !== 0) {
            inst._regenMpTicks = (inst._regenMpTicks | 0) + 1;
            while (inst._regenMpTicks >= mpInt) {
                inst._regenMpTicks -= mpInt;
                mpDelta += mpAmt;
            }
        }
    }
    return { hpDelta, mpDelta };
}

module.exports = {
    DEFAULT_REGEN_HP_TICKS,
    DEFAULT_REGEN_MP_TICKS,
    DEFAULT_HUNGRY_REGEN_HP_TICKS,
    DEFAULT_HUNGRY_REGEN_MP_TICKS,
    nativeRegenRates,
    regenIntervalTicks,
    tickFoodSatiation,
    intervalMsToTicks,
    tickNativeRegen,
    tickEquippedDurations,
    tickEquippedItemRegen
};

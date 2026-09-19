'use strict';

/** Vocation food/tick regen + equipped duration decay. Integer ticks. No Date.now. */

const { findItem } = require('./items');
const { isCombatantAlive } = require('./conditions');

const DEFAULT_REGEN_HP_TICKS = 60;
const DEFAULT_REGEN_MP_TICKS = 100;
const DEFAULT_ENGAGE_REGEN_HP_TICKS = 80;
const DEFAULT_ENGAGE_REGEN_MP_TICKS = 120;

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

function regenIntervalTicks(settings, inEngage) {
    const s = settings || {};
    if (inEngage) {
        return {
            hpTicks: Math.max(1, asNonNegInt(s.engageRegenHpTicks, DEFAULT_ENGAGE_REGEN_HP_TICKS) || DEFAULT_ENGAGE_REGEN_HP_TICKS),
            mpTicks: Math.max(1, asNonNegInt(s.engageRegenMpTicks, DEFAULT_ENGAGE_REGEN_MP_TICKS) || DEFAULT_ENGAGE_REGEN_MP_TICKS)
        };
    }
    return {
        hpTicks: Math.max(1, asNonNegInt(s.regenHpTicks, DEFAULT_REGEN_HP_TICKS) || DEFAULT_REGEN_HP_TICKS),
        mpTicks: Math.max(1, asNonNegInt(s.regenMpTicks, DEFAULT_REGEN_MP_TICKS) || DEFAULT_REGEN_MP_TICKS)
    };
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

function playerInEngage(session, world) {
    if (!session) return false;
    const tid = session.targetId | 0;
    if (!tid || !world || typeof world.getEntity !== 'function') return false;
    const t = world.getEntity(tid);
    return !!(t && isCombatantAlive(t));
}

module.exports = {
    DEFAULT_REGEN_HP_TICKS,
    DEFAULT_REGEN_MP_TICKS,
    DEFAULT_ENGAGE_REGEN_HP_TICKS,
    DEFAULT_ENGAGE_REGEN_MP_TICKS,
    nativeRegenRates,
    regenIntervalTicks,
    intervalMsToTicks,
    tickNativeRegen,
    tickEquippedDurations,
    tickEquippedItemRegen,
    playerInEngage
};

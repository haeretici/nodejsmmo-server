'use strict';

/**
 * Creature target strategy + threat table (product port of engine kit
 * strategiesTarget / changeTarget / damageTakenBy half-life).
 * Integer logic seconds. MUST NOT require kernel/.
 */

const DEFAULT_STRATEGIES = Object.freeze({ nearest: 100 });
const THREAT_EPS = 0.01;
const DEFAULT_THREAT_HALFLIFE_SEC = 10;
const DEFAULT_RETARGET_INTERVAL_SEC = 0;
const STRATEGY_RETARGET_AT_KEY = '_strategyRetargetNextAt';

function settingNum(settings, key, fallback) {
    if (!settings || settings[key] == null || settings[key] === '') {
        return fallback;
    }
    const n = Number(settings[key]);
    return Number.isFinite(n) ? n : fallback;
}

function chebyshev(ax, ay, bx, by) {
    return Math.max(Math.abs((ax | 0) - (bx | 0)), Math.abs((ay | 0) - (by | 0)));
}

function currentHp(entity) {
    if (!entity) return 0;
    const hp = entity.hp;
    if (hp && typeof hp === 'object' && hp.current != null) {
        return Number(hp.current) || 0;
    }
    return hp | 0;
}

/**
 * Weighted key pick. Weights are relative (need not sum to 100).
 * @param {Record<string, number>|null|undefined} weights
 * @param {() => number} [rng] [0,1)
 * @returns {string|null}
 */
function pickWeightedKey(weights, rng) {
    if (!weights || typeof weights !== 'object') return null;
    const keys = Object.keys(weights);
    if (!keys.length) return null;
    let total = 0;
    for (let i = 0; i < keys.length; i++) {
        const w = Number(weights[keys[i]]) || 0;
        if (w > 0) total += w;
    }
    if (total <= 0) return keys[keys.length - 1];
    const r = (typeof rng === 'function' ? rng() : Math.random()) * total;
    let acc = 0;
    for (let i = 0; i < keys.length; i++) {
        const w = Number(weights[keys[i]]) || 0;
        if (w <= 0) continue;
        acc += w;
        if (r < acc) return keys[i];
    }
    return keys[keys.length - 1];
}

/**
 * @param {object[]} candidates
 * @param {'lowest'|'highest'} mode
 * @param {(e: object) => number} scoreFn
 * @returns {object|null}
 */
function pickExtreme(candidates, mode, scoreFn) {
    if (!candidates || !candidates.length) return null;
    let best = null;
    let bestScore = mode === 'lowest' ? Infinity : -Infinity;
    for (let i = 0; i < candidates.length; i++) {
        const e = candidates[i];
        if (!e) continue;
        const s = scoreFn(e);
        if (mode === 'lowest' ? s < bestScore : s > bestScore) {
            bestScore = s;
            best = e;
        }
    }
    return best;
}

/**
 * Closest living candidate (Chebyshev, same z).
 * @param {object} origin
 * @param {object[]} candidates
 * @returns {object|null}
 */
function findNearest(origin, candidates) {
    if (!origin || !candidates || !candidates.length) return null;
    let best = null;
    let bestD = Infinity;
    const oz = origin.z | 0;
    for (let i = 0; i < candidates.length; i++) {
        const e = candidates[i];
        if (!e) continue;
        if ((e.z | 0) !== oz) continue;
        const d = chebyshev(origin.x, origin.y, e.x, e.y);
        if (d < bestD) {
            bestD = d;
            best = e;
        }
    }
    return best;
}

/**
 * @param {object|null|undefined} raw
 * @returns {Record<string, number>}
 */
function normalizeStrategiesTarget(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return Object.assign({}, DEFAULT_STRATEGIES);
    }
    const out = Object.create(null);
    let any = false;
    for (const k of Object.keys(raw)) {
        const w = Number(raw[k]);
        if (Number.isFinite(w) && w > 0) {
            out[k] = w;
            any = true;
        }
    }
    return any ? out : Object.assign({}, DEFAULT_STRATEGIES);
}

/**
 * Authored changeTarget {interval ms, chance %} → seconds + 0–100 chance.
 * interval 0 / omitted interval → no periodic retarget from this object.
 * @param {object|null|undefined} template
 * @returns {{ intervalSec: number|null, chance: number|null }}
 */
function changeTargetFromTemplate(template) {
    const ct = template && template.changeTarget;
    if (!ct || typeof ct !== 'object') {
        return { intervalSec: null, chance: null };
    }
    let intervalSec = null;
    if (ct.interval != null && ct.interval !== '') {
        const ms = Number(ct.interval);
        if (Number.isFinite(ms)) intervalSec = Math.max(0, ms / 1000);
    } else if (ct.intervalSec != null && ct.intervalSec !== '') {
        const sec = Number(ct.intervalSec);
        if (Number.isFinite(sec)) intervalSec = Math.max(0, sec);
    }
    let chance = null;
    if (ct.chance != null && ct.chance !== '') {
        const n = Number(ct.chance);
        if (Number.isFinite(n)) chance = Math.max(0, Math.min(100, n));
    }
    return { intervalSec, chance };
}

function emptyThreatBag(creature) {
    if (!creature) return;
    if (creature.damageTakenBy && typeof creature.damageTakenBy === 'object') {
        const bag = creature.damageTakenBy;
        const keys = Object.keys(bag);
        for (let i = 0; i < keys.length; i++) delete bag[keys[i]];
    } else {
        creature.damageTakenBy = Object.create(null);
    }
    creature._threatDecayAt = null;
    creature[STRATEGY_RETARGET_AT_KEY] = null;
}

/**
 * Copy catalog strategiesTarget / changeTarget onto a creature body.
 * @param {object} creature
 * @param {object|null|undefined} template
 */
function attachCreatureThreat(creature, template) {
    if (!creature) return;
    creature.strategiesTarget = normalizeStrategiesTarget(
        template && (template.strategiesTarget || template.targetStrategies)
    );
    creature.changeTarget = changeTargetFromTemplate(template);
    emptyThreatBag(creature);
}

function threatDecayHalflife(creature, settings) {
    const f = creature && creature.flags;
    if (f && f.threatDecayHalflifeSec != null) {
        return Math.max(0, Number(f.threatDecayHalflifeSec) || 0);
    }
    if (creature && creature.threatDecayHalflifeSec != null) {
        return Math.max(0, Number(creature.threatDecayHalflifeSec) || 0);
    }
    return Math.max(
        0,
        settingNum(settings, 'aiCreatureThreatDecayHalflifeSec', DEFAULT_THREAT_HALFLIFE_SEC)
    );
}

/**
 * Lazy exponential decay of damageTakenBy (half-life). No-op when half-life is 0.
 * @param {object} creature
 * @param {number} [now] logic seconds
 * @param {object} [settings]
 */
function applyThreatDecay(creature, now, settings) {
    if (!creature) return;
    if (!creature.damageTakenBy || typeof creature.damageTakenBy !== 'object') {
        creature.damageTakenBy = Object.create(null);
    }
    if (typeof now !== 'number' || !Number.isFinite(now)) return;
    const last = creature._threatDecayAt;
    if (last == null || !Number.isFinite(last)) {
        creature._threatDecayAt = now;
        return;
    }
    const dt = now - last;
    if (!(dt > 0)) return;
    creature._threatDecayAt = now;

    const half = threatDecayHalflife(creature, settings);
    if (!(half > 0)) return;

    const factor = Math.pow(0.5, dt / half);
    if (!(factor < 1) || !Number.isFinite(factor)) return;

    const bag = creature.damageTakenBy;
    const keys = Object.keys(bag);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = Number(bag[k]) * factor;
        if (!Number.isFinite(v) || v < THREAT_EPS) {
            delete bag[k];
        } else {
            bag[k] = v;
        }
    }
}

/**
 * Mid-combat strategy re-roll interval (0 = sticky forever until lose).
 * changeTarget.interval (ms) wins; else aiCreatureRetargetIntervalSec.
 * @param {object} owner
 * @param {object} [settings]
 * @returns {number}
 */
function retargetIntervalSec(owner, settings) {
    const ct = owner && owner.changeTarget;
    if (ct && ct.intervalSec != null) {
        return Math.max(0, Number(ct.intervalSec) || 0);
    }
    return Math.max(
        0,
        settingNum(settings, 'aiCreatureRetargetIntervalSec', DEFAULT_RETARGET_INTERVAL_SEC)
    );
}

/**
 * Percent chance to switch target when the retarget interval elapses.
 * changeTarget.chance wins; default 100 when only an interval is authored.
 * @param {object} owner
 * @returns {number} 0–100; 100 = always
 */
function retargetChance(owner) {
    const ct = owner && owner.changeTarget;
    if (ct && ct.chance != null) {
        return Math.max(0, Math.min(100, Number(ct.chance) || 0));
    }
    return 100;
}

/**
 * Arm full retarget interval after an initial strategy pick (avoid re-roll
 * on the very next think). Interval 0 clears the gate.
 * @param {object} owner
 * @param {number} now
 * @param {object} [settings]
 */
function armStrategyRetarget(owner, now, settings) {
    if (!owner) return;
    const interval = retargetIntervalSec(owner, settings);
    if (!(interval > 0)) {
        owner[STRATEGY_RETARGET_AT_KEY] = null;
        return;
    }
    const t = typeof now === 'number' && Number.isFinite(now) ? now : 0;
    owner[STRATEGY_RETARGET_AT_KEY] = t + interval;
}

/**
 * Clear strategy retarget gate (target lost / leave combat).
 * @param {object} owner
 */
function clearStrategyRetarget(owner) {
    if (!owner) return;
    owner[STRATEGY_RETARGET_AT_KEY] = null;
}

/**
 * Whether a mid-combat strategiesTarget re-roll may run this think.
 * Interval 0 → always false (sticky). First call after arm waits full interval.
 * When the interval elapses the gate always re-arms; changeTarget.chance then
 * decides whether the switch actually happens (0 = stay sticky).
 *
 * @param {object} owner
 * @param {number} now
 * @param {() => number} [rng] [0,1)
 * @param {object} [settings]
 * @returns {boolean}
 */
function strategyRetargetDue(owner, now, rng, settings) {
    if (!owner) return false;
    const interval = retargetIntervalSec(owner, settings);
    if (!(interval > 0)) return false;
    const t = typeof now === 'number' && Number.isFinite(now) ? now : 0;
    const nextAt = owner[STRATEGY_RETARGET_AT_KEY];
    if (nextAt != null && Number.isFinite(nextAt) && t < nextAt) {
        return false;
    }
    owner[STRATEGY_RETARGET_AT_KEY] = t + interval;
    const chance = retargetChance(owner);
    if (!(chance > 0)) return false;
    if (chance >= 100) return true;
    const r = typeof rng === 'function' ? rng() : Math.random();
    return r * 100 < chance;
}

/**
 * Pick a living player by strategy id.
 * @param {object} owner creature
 * @param {object[]} candidates
 * @param {string} strategy
 * @param {() => number} [rng]
 * @param {{ now?: number, settings?: object }} [opts]
 * @returns {object|null}
 */
function pickByStrategy(owner, candidates, strategy, rng, opts) {
    const list = candidates || [];
    if (!list.length) return null;
    const id = String(strategy || 'nearest').toLowerCase();
    switch (id) {
        case 'health':
        case 'lowest_hp':
            return pickExtreme(list, 'lowest', currentHp) || findNearest(owner, list);
        case 'damage':
        case 'highest_damage': {
            applyThreatDecay(owner, opts && opts.now, opts && opts.settings);
            const bag = owner && owner.damageTakenBy;
            const byDmg = pickExtreme(list, 'highest', (e) => {
                if (!bag || e.id == null) return 0;
                return Number(bag[e.id] || bag[String(e.id)] || 0);
            });
            if (
                !byDmg ||
                !bag ||
                !(Number(bag[byDmg.id] || bag[String(byDmg.id)] || 0) > 0)
            ) {
                const r = typeof rng === 'function' ? rng() : Math.random();
                return list[Math.floor(r * list.length)] || null;
            }
            return byDmg;
        }
        case 'random': {
            const r = typeof rng === 'function' ? rng() : Math.random();
            return list[Math.floor(r * list.length)] || null;
        }
        case 'nearest':
        default:
            return findNearest(owner, list);
    }
}

/**
 * Weighted strategiesTarget pick among already-filtered candidates.
 * @param {object} owner
 * @param {object[]} candidates
 * @param {() => number} [rng]
 * @param {{ now?: number, settings?: object }} [opts]
 * @returns {object|null}
 */
function pickCreatureTarget(owner, candidates, rng, opts) {
    if (!candidates || !candidates.length) return null;
    const strategy = pickWeightedKey(
        owner && owner.strategiesTarget,
        rng
    );
    return pickByStrategy(owner, candidates, strategy || 'nearest', rng, opts);
}

/**
 * Record damage a player dealt to this creature (for "damage" targeting).
 * Applies pending threat decay before adding so older hits age correctly.
 * @param {object} creature
 * @param {object} attacker
 * @param {number} amount
 * @param {number} [now]
 * @param {object} [settings]
 */
function recordDamageTakenBy(creature, attacker, amount, now, settings) {
    if (!creature || !attacker || !(amount > 0)) return;
    if (attacker.type === 'creature') return;
    const id = attacker.id;
    if (id == null) return;
    applyThreatDecay(creature, now, settings);
    if (!creature.damageTakenBy) creature.damageTakenBy = Object.create(null);
    const key = id;
    creature.damageTakenBy[key] =
        (Number(creature.damageTakenBy[key]) || 0) + amount;
}

/**
 * Current threat score for a player id after lazy decay (0 if none).
 * @param {object} creature
 * @param {string|number} playerId
 * @param {number} [now]
 * @param {object} [settings]
 * @returns {number}
 */
function threatOf(creature, playerId, now, settings) {
    if (!creature || playerId == null) return 0;
    applyThreatDecay(creature, now, settings);
    const bag = creature.damageTakenBy;
    if (!bag) return 0;
    return Number(bag[playerId] || bag[String(playerId)] || 0) || 0;
}

module.exports = {
    DEFAULT_STRATEGIES,
    THREAT_EPS,
    DEFAULT_THREAT_HALFLIFE_SEC,
    DEFAULT_RETARGET_INTERVAL_SEC,
    STRATEGY_RETARGET_AT_KEY,
    pickWeightedKey,
    pickExtreme,
    findNearest,
    currentHp,
    normalizeStrategiesTarget,
    changeTargetFromTemplate,
    attachCreatureThreat,
    emptyThreatBag,
    threatDecayHalflife,
    applyThreatDecay,
    retargetIntervalSec,
    retargetChance,
    armStrategyRetarget,
    clearStrategyRetarget,
    strategyRetargetDue,
    pickByStrategy,
    pickCreatureTarget,
    recordDamageTakenBy,
    threatOf
};

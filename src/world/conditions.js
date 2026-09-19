'use strict';

/** Product port of HuntDL conditions. Entity HP is `hp`/`hpMax` (not `hp.current`). */

const { applyMitigation } = require('./combat');

const DOT_KINDS = {
    poison: { kind: 'poison', element: 'earth' },
    condition_poison: { kind: 'poison', element: 'earth' },
    fire: { kind: 'fire', element: 'fire' },
    condition_fire: { kind: 'fire', element: 'fire' },
    freezing: { kind: 'ice', element: 'ice' },
    condition_freezing: { kind: 'ice', element: 'ice' },
    ice: { kind: 'ice', element: 'ice' },
    condition_ice: { kind: 'ice', element: 'ice' },
    energy: { kind: 'energy', element: 'energy' },
    condition_energy: { kind: 'energy', element: 'energy' },
    electrification: { kind: 'energy', element: 'energy' },
    electrify: { kind: 'energy', element: 'energy' },
    bleed: { kind: 'bleed', element: 'physical' },
    bleeding: { kind: 'bleed', element: 'physical' },
    condition_bleeding: { kind: 'bleed', element: 'physical' },
    curse: { kind: 'curse', element: 'death' },
    cursed: { kind: 'curse', element: 'death' },
    condition_cursed: { kind: 'curse', element: 'death' },
    holy: { kind: 'holy', element: 'holy' },
    dazzled: { kind: 'holy', element: 'holy' },
    dazzle: { kind: 'holy', element: 'holy' },
    condition_dazzled: { kind: 'holy', element: 'holy' }
};

const DOT_KIND_SET = new Set([
    'poison', 'fire', 'ice', 'energy', 'bleed', 'curse', 'holy'
]);

const FIELD_BURNING = {
    type: 'fire',
    schedule: [{ turns: 7, damage: 10, intervalSec: 9 }],
    totalDamage: 70,
    forceOverride: true
};

const FIELD_POISONED = {
    type: 'poison',
    schedule: [
        { turns: 4, damage: 5, intervalSec: 2 },
        { turns: 5, damage: 4, intervalSec: 2 },
        { turns: 7, damage: 3, intervalSec: 2 },
        { turns: 10, damage: 2, intervalSec: 2 },
        { turns: 19, damage: 1, intervalSec: 2 }
    ],
    totalDamage: 100,
    forceOverride: true
};

function isCombatantAlive(entity) {
    if (!entity) return false;
    if (entity.downed || entity.dead) return false;
    if (entity.alive === false) return false;
    return (entity.hp | 0) > 0;
}

function canonicalKind(raw) {
    return String(raw || '')
        .toLowerCase()
        .replace(/^condition_/, '')
        .replace(/^condition_/, '');
}

function isManaShieldType(type) {
    const t = canonicalKind(type);
    return t === 'mana_shield' || t === 'manashield' || t === 'mana-shield';
}

function isImmuneToCondition(entity, kind) {
    if (!entity || !kind) return false;
    const k = canonicalKind(kind);
    const bags = [];
    if (entity.immunities && typeof entity.immunities === 'object') bags.push(entity.immunities);
    if (entity.template && entity.template.immunities && typeof entity.template.immunities === 'object') {
        bags.push(entity.template.immunities);
    }
    if (entity.flags && typeof entity.flags === 'object') bags.push(entity.flags);
    for (let i = 0; i < bags.length; i++) {
        const imm = bags[i];
        if (imm[k] === true) return true;
        if (imm['CONDITION_' + k.toUpperCase()] === true) return true;
        if (
            (k === 'slow' || k === 'paralyze') &&
            (imm.paralyze === true || imm.CONDITION_PARALYZE === true)
        ) {
            return true;
        }
    }
    return false;
}

function normalizeConditionDef(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let type = canonicalKind(raw.type || raw.kind || raw.name);
    if (type === 'speed') {
        const sc = Number(raw.speedChange);
        if (!Number.isFinite(sc) || sc === 0) return null;
        type = sc < 0 ? 'slow' : 'haste';
    }
    if (type === 'paralyze' || type === 'paralysis' || type === 'paralysed') type = 'slow';
    if (type === 'invisibility') type = 'invisible';

    const durationSec =
        raw.durationSec != null
            ? Math.max(0, Number(raw.durationSec) || 0)
            : raw.durationMs != null
                ? Math.max(0, (Number(raw.durationMs) || 0) / 1000)
                : raw.duration != null
                    ? Math.max(0, (Number(raw.duration) || 0) / 1000)
                    : 0;

    const intervalSec =
        raw.intervalSec != null
            ? Math.max(0.05, Number(raw.intervalSec) || 1)
            : raw.intervalMs != null
                ? Math.max(0.05, (Number(raw.intervalMs) || 4000) / 1000)
                : raw.interval != null
                    ? (() => {
                        const n = Number(raw.interval) || 4000;
                        return n > 20 ? Math.max(0.05, n / 1000) : Math.max(0.05, n);
                    })()
                    : 4;

    let totalDamage =
        raw.totalDamage != null
            ? Math.max(0, Math.abs(Number(raw.totalDamage) || 0))
            : raw.damage != null
                ? Math.max(0, Math.abs(Number(raw.damage) || 0))
                : 0;

    const speedChange = raw.speedChange != null ? Number(raw.speedChange) || 0 : 0;
    const dotMeta = DOT_KINDS[type] || null;
    if (dotMeta || DOT_KIND_SET.has(type)) {
        const kind = dotMeta ? dotMeta.kind : type;
        let schedule = null;
        if (Array.isArray(raw.schedule) && raw.schedule.length > 0) {
            schedule = raw.schedule.map((s) => Object.assign({}, s));
            if (!(totalDamage > 0)) {
                totalDamage = schedule.reduce(
                    (sum, st) => sum + (Number(st.turns || 0) * Number(st.damage || 0)),
                    0
                );
            }
        }
        if (!(totalDamage > 0)) return null;
        return {
            type: kind,
            totalDamage,
            intervalSec,
            intervalMs: Math.round(intervalSec * 1000),
            schedule,
            forceOverride: !!raw.forceOverride
        };
    }

    if (type === 'slow' || type === 'haste') {
        if (!Number.isFinite(speedChange) || speedChange === 0) {
            if (!raw.speedFormula) return null;
            return {
                type,
                speedChange: type === 'slow' ? -1 : 1,
                durationSec: durationSec > 0 ? durationSec : 5,
                speedFormula: raw.speedFormula
            };
        }
        return {
            type,
            speedChange,
            durationSec: durationSec > 0 ? durationSec : 5
        };
    }

    if (type === 'invisible') {
        return { type: 'invisible', durationSec: durationSec > 0 ? durationSec : 2 };
    }

    if (type === 'regen' || type === 'regeneration' || type === 'hot' || type === 'recovery') {
        const healthGain = Math.max(
            0,
            Number(raw.healthGain != null ? raw.healthGain : raw.heal != null ? raw.heal : 0) || 0
        );
        if (!(healthGain > 0)) return null;
        const hotDuration = durationSec > 0 ? durationSec : 60;
        return {
            type: 'regen',
            healthGain,
            intervalSec: intervalSec > 0 ? intervalSec : 3,
            durationSec: hotDuration
        };
    }

    if (type === 'attributes' || type === 'attribute' || type === 'stance') {
        const def = {
            type: 'attributes',
            durationSec: durationSec > 0 ? durationSec : 10
        };
        if (raw.skillPercent && typeof raw.skillPercent === 'object') {
            def.skillPercent = Object.assign({}, raw.skillPercent);
        }
        if (raw.damageDealtPercent != null) def.damageDealtPercent = Number(raw.damageDealtPercent);
        if (raw.damageReceivedPercent != null) {
            def.damageReceivedPercent = Number(raw.damageReceivedPercent);
        }
        if (raw.disableDefense) def.disableDefense = true;
        if (raw.cannotAttack) def.cannotAttack = true;
        if (Number.isFinite(speedChange) && speedChange !== 0) def.speedChange = speedChange;
        if (raw.speedFormula) def.speedFormula = raw.speedFormula;
        if (raw.subId) def.subId = String(raw.subId);
        return def;
    }

    if (isManaShieldType(type)) {
        return {
            type: 'mana_shield',
            durationSec: durationSec > 0 ? durationSec : 180,
            poolRemaining: Math.max(0, Math.floor(Number(raw.poolRemaining != null ? raw.poolRemaining : raw.pool) || 0)),
            poolMax: Math.max(0, Math.floor(Number(raw.poolMax != null ? raw.poolMax : raw.pool) || 0)),
            poolFormula: raw.poolFormula || undefined
        };
    }
    return null;
}

function hasteSpeedChangeFromFormula(baseSpeed, formula) {
    if (!formula || typeof formula !== 'object') return 0;
    const mina = Number(formula.mina);
    const minb = Number(formula.minb);
    if (!Number.isFinite(mina) || !Number.isFinite(minb)) return 0;
    const maxa = formula.maxa != null && Number.isFinite(Number(formula.maxa))
        ? Number(formula.maxa) : mina;
    const maxb = formula.maxb != null && Number.isFinite(Number(formula.maxb))
        ? Number(formula.maxb) : minb;
    const b = Number.isFinite(Number(baseSpeed)) ? Number(baseSpeed) : 100;
    const difference = b - 40;
    const target = Math.floor(((mina * difference + minb) + (maxa * difference + maxb)) / 2);
    return target - b;
}

function computeManaShieldPool(level, magicLevel, maxMana) {
    const L = Math.max(0, Number(level) || 0);
    const M = Math.max(0, Number(magicLevel) || 0);
    const C = Math.max(0, Number(maxMana) || 0);
    return Math.max(0, Math.floor(Math.min(C, 300 + 7.6 * L + 7 * M)));
}

function manaFromEntity(entity) {
    const skills = entity && entity.skills;
    const magic = skills && skills.magic != null ? Number(skills.magic) || 0
        : entity && entity.magic != null ? Number(entity.magic) || 0 : 0;
    const maxMana = entity && entity.mpMax != null ? Number(entity.mpMax) || 0 : 0;
    const level = entity && entity.level != null ? Number(entity.level) || 0 : 0;
    return { level, magic, maxMana };
}

function resolveManaShieldDef(raw, entity) {
    const bag = Object.assign({}, raw);
    const hasExplicit = bag.poolRemaining != null || bag.poolMax != null || bag.pool != null;
    if (!hasExplicit && bag.poolFormula === 'legacy_mana_shield') {
        const snap = manaFromEntity(entity);
        const pool = computeManaShieldPool(snap.level, snap.magic, snap.maxMana);
        bag.poolRemaining = pool;
        bag.poolMax = pool;
    }
    return bag;
}

function conditionDefFromSpell(raw, entity) {
    if (!raw || typeof raw !== 'object') return null;
    const bag = Object.assign({}, raw);
    const rawType = canonicalKind(bag.type || bag.kind);
    if (rawType === 'paralyze' || rawType === 'paralysis' || rawType === 'paralysed') {
        bag.type = 'slow';
    }
    if (isManaShieldType(rawType)) Object.assign(bag, resolveManaShieldDef(bag, entity));
    const needsFormula =
        (bag.type === 'haste' || bag.type === 'slow' || bag.kind === 'haste' || bag.kind === 'slow'
            || bag.type === 'attributes')
        && (bag.speedChange == null || !Number.isFinite(Number(bag.speedChange)))
        && bag.speedFormula;
    if (needsFormula) {
        ensureBaseSpeed(entity);
        const base = entity && entity.baseSpeed != null ? Number(entity.baseSpeed)
            : entity && entity.speed != null ? Number(entity.speed) : 100;
        bag.speedChange = hasteSpeedChangeFromFormula(base, bag.speedFormula);
    }
    return normalizeConditionDef(bag);
}

function ensureConditionList(entity) {
    if (!entity) return [];
    if (!Array.isArray(entity.conditions)) entity.conditions = [];
    return entity.conditions;
}

function ensureBaseSpeed(entity) {
    if (!entity) return;
    if (entity.baseSpeed == null || !Number.isFinite(Number(entity.baseSpeed))) {
        entity.baseSpeed = entity.speed != null && Number.isFinite(Number(entity.speed))
            ? Number(entity.speed)
            : 100;
    }
}

function recomputeDerived(entity) {
    if (!entity) return;
    ensureBaseSpeed(entity);
    const list = ensureConditionList(entity);
    let speedMod = 0;
    let invisible = false;
    let cannotAttack = false;
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c) continue;
        if (c.kind === 'slow' || c.kind === 'haste' || c.kind === 'attributes') {
            speedMod += Number(c.speedChange) || 0;
        }
        if (c.kind === 'invisible') invisible = true;
        if (c.kind === 'attributes' && c.cannotAttack) cannotAttack = true;
    }
    const gearFlags = entity.combatStats && entity.combatStats.flags;
    if (gearFlags && gearFlags.invisible) invisible = true;
    if (speedMod !== 0) {
        entity.speed = Math.max(0, Number(entity.baseSpeed) + speedMod);
    } else if (entity.type === 'player') {
        delete entity.speed;
    } else {
        entity.speed = Number(entity.baseSpeed);
    }
    entity.invisible = invisible;
    entity.cannotAttack = cannotAttack;
}

function applyCondition(entity, def, opts) {
    if (!isCombatantAlive(entity)) return null;
    const incoming = def && isManaShieldType(def.type || def.kind || def.name)
        ? resolveManaShieldDef(def, entity)
        : def;
    const norm = normalizeConditionDef(incoming);
    if (!norm) return null;
    if (isImmuneToCondition(entity, norm.type)) return null;
    if (norm.type === 'slow' && isImmuneToCondition(entity, 'paralyze')) return null;
    const list = ensureConditionList(entity);
    const o = opts || {};
    let inst;

    if (DOT_KIND_SET.has(norm.type)) {
        const meta = DOT_KINDS[norm.type] || { kind: norm.type, element: norm.type };
        inst = {
            id: meta.kind,
            kind: meta.kind,
            remainingDamage: norm.totalDamage,
            tickIntervalSec: norm.intervalSec || 4,
            tickTimer: 0,
            element: meta.element,
            source: o.source || null
        };
        if (norm.schedule && Array.isArray(norm.schedule)) {
            inst.schedule = norm.schedule.map((s) => Object.assign({}, s));
            inst.scheduleIndex = 0;
            inst.scheduleTurnsRemaining = inst.schedule[0] ? Number(inst.schedule[0].turns || 0) : 0;
            if (inst.schedule[0] && inst.schedule[0].intervalSec != null) {
                inst.tickIntervalSec = Number(inst.schedule[0].intervalSec);
            }
        }
        const idx = list.findIndex((c) => c && c.kind === inst.kind);
        if (idx >= 0) {
            const old = list[idx];
            const force = o.forceOverride || norm.forceOverride;
            if (!force && (old.remainingDamage || 0) > (inst.remainingDamage || 0)) return old;
            list[idx] = inst;
        } else {
            list.push(inst);
        }
        recomputeDerived(entity);
        return inst;
    }

    if (norm.type === 'regen') {
        inst = {
            id: 'regen',
            kind: 'regen',
            healthGain: Math.max(0, Number(norm.healthGain) || 0),
            tickIntervalSec: norm.intervalSec > 0 ? Number(norm.intervalSec) : 3,
            tickTimer: 0,
            durationSec: norm.durationSec > 0 ? Number(norm.durationSec) : 60,
            source: o.source || null
        };
        if (!(inst.healthGain > 0) || !(inst.durationSec > 0)) return null;
        const idx = list.findIndex((c) => c && c.kind === 'regen');
        if (idx >= 0) list[idx] = inst;
        else list.push(inst);
        recomputeDerived(entity);
        return inst;
    }

    if (norm.type === 'slow' || norm.type === 'haste') {
        inst = {
            id: norm.type,
            kind: norm.type,
            durationSec: norm.durationSec || 5,
            speedChange: norm.speedChange,
            source: o.source || null
        };
        const idx = list.findIndex((c) => c && c.kind === inst.kind);
        if (idx >= 0) list[idx] = inst;
        else list.push(inst);
        recomputeDerived(entity);
        return inst;
    }

    if (norm.type === 'invisible') {
        inst = {
            id: 'invisible',
            kind: 'invisible',
            durationSec: norm.durationSec || 2,
            source: o.source || null
        };
        const idx = list.findIndex((c) => c && c.kind === 'invisible');
        if (idx >= 0) list[idx] = inst;
        else list.push(inst);
        recomputeDerived(entity);
        return inst;
    }

    if (norm.type === 'attributes') {
        const subId = norm.subId || null;
        if (subId) {
            for (let i = list.length - 1; i >= 0; i--) {
                const c = list[i];
                if (c && c.kind === 'attributes' && c.subId === subId) list.splice(i, 1);
            }
        }
        inst = {
            id: o.source || 'attributes',
            kind: 'attributes',
            durationSec: norm.durationSec > 0 ? norm.durationSec : 10,
            source: o.source || null
        };
        if (subId) inst.subId = subId;
        if (norm.skillPercent) inst.skillPercent = Object.assign({}, norm.skillPercent);
        if (norm.damageDealtPercent != null) inst.damageDealtPercent = Number(norm.damageDealtPercent);
        if (norm.damageReceivedPercent != null) {
            inst.damageReceivedPercent = Number(norm.damageReceivedPercent);
        }
        if (norm.disableDefense) inst.disableDefense = true;
        if (norm.cannotAttack) inst.cannotAttack = true;
        if (norm.speedChange != null && Number.isFinite(Number(norm.speedChange))) {
            inst.speedChange = Number(norm.speedChange);
        }
        const src = o.source || null;
        if (src) {
            const idx = list.findIndex((c) => c && c.kind === 'attributes' && c.source === src);
            if (idx >= 0) list[idx] = inst;
            else list.push(inst);
        } else {
            list.push(inst);
        }
        recomputeDerived(entity);
        return inst;
    }

    if (norm.type === 'mana_shield') {
        const poolRemaining = Math.max(0, Math.floor(Number(norm.poolRemaining) || 0));
        let poolMax = Math.max(0, Math.floor(Number(norm.poolMax) || 0));
        if (poolMax < poolRemaining) poolMax = poolRemaining;
        inst = {
            id: 'mana_shield',
            kind: 'mana_shield',
            durationSec: norm.durationSec > 0 ? Number(norm.durationSec) : 180,
            poolRemaining,
            poolMax,
            source: o.source || null
        };
        const idx = list.findIndex((c) => c && c.kind === 'mana_shield');
        if (idx >= 0) list[idx] = inst;
        else list.push(inst);
        recomputeDerived(entity);
        return inst;
    }
    return null;
}

function removeCondition(entity, kind) {
    const list = ensureConditionList(entity);
    const k = canonicalKind(kind);
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] && list[i].kind === k) {
            list.splice(i, 1);
            n += 1;
        }
    }
    if (n) recomputeDerived(entity);
    return n;
}

function removeConditions(entity, kinds) {
    const list = Array.isArray(kinds) ? kinds : kinds ? [kinds] : [];
    let n = 0;
    for (let i = 0; i < list.length; i++) n += removeCondition(entity, list[i]);
    return n;
}

function entityHasCondition(entity, kind) {
    if (!entity || !kind) return false;
    const list = entity.conditions;
    if (!Array.isArray(list)) return false;
    const want = String(kind);
    for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].kind === want) return true;
    }
    return false;
}

function isInvisible(entity) {
    if (!entity) return false;
    if (entity.invisible === true) return true;
    return entityHasCondition(entity, 'invisible');
}

function hasHaste(entity) {
    return entityHasCondition(entity, 'haste');
}

function isCannotAttack(entity) {
    if (!entity) return false;
    if (entity.cannotAttack === true) return true;
    return getAttributeMods(entity).cannotAttack;
}

function getAttributeMods(entity) {
    const skillMult = Object.create(null);
    let damageDealtMult = 1;
    let damageReceivedMult = 1;
    let disableDefense = false;
    let cannotAttack = false;
    const list = entity && Array.isArray(entity.conditions) ? entity.conditions : [];
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c || c.kind !== 'attributes') continue;
        if (c.skillPercent && typeof c.skillPercent === 'object') {
            const keys = Object.keys(c.skillPercent);
            for (let k = 0; k < keys.length; k++) {
                const key = keys[k];
                const pct = Number(c.skillPercent[key]);
                if (!Number.isFinite(pct) || pct <= 0) continue;
                const m = pct / 100;
                skillMult[key] = (skillMult[key] != null ? skillMult[key] : 1) * m;
            }
        }
        if (c.damageDealtPercent != null && Number.isFinite(Number(c.damageDealtPercent))) {
            damageDealtMult *= Number(c.damageDealtPercent) / 100;
        }
        if (c.damageReceivedPercent != null && Number.isFinite(Number(c.damageReceivedPercent))) {
            damageReceivedMult *= Number(c.damageReceivedPercent) / 100;
        }
        if (c.disableDefense) disableDefense = true;
        if (c.cannotAttack) cannotAttack = true;
    }
    return { skillMult, damageDealtMult, damageReceivedMult, disableDefense, cannotAttack };
}

function absorbWithManaShield(entity, incoming) {
    const dmg = Math.max(0, Number(incoming) || 0);
    if (!(dmg > 0) || !entity) return { leftoverHp: dmg, absorbed: 0 };
    const list = ensureConditionList(entity);
    const shield = list.find((c) => c && c.kind === 'mana_shield');
    const gear = entity.combatStats && entity.combatStats.flags && entity.combatStats.flags.manaShield;
    if (shield && (Number(shield.poolRemaining) || 0) > 0) {
        const pool = Math.max(0, Math.floor(Number(shield.poolRemaining) || 0));
        const take = Math.min(pool, dmg);
        shield.poolRemaining = pool - take;
        if (shield.poolRemaining <= 0) removeCondition(entity, 'mana_shield');
        return { leftoverHp: dmg - take, absorbed: take };
    }
    if (gear) return { leftoverHp: dmg, absorbed: 0 };
    return { leftoverHp: dmg, absorbed: 0 };
}

function applyHpDeltaLocal(entity, amount, element) {
    if (!entity) return 0;
    if (element === 'healing') {
        const before = entity.hp | 0;
        const max = entity.hpMax != null ? entity.hpMax | 0 : before + amount;
        entity.hp = Math.min(max, before + Math.max(0, amount | 0));
        if (entity.character) entity.character.hp = entity.hp;
        return entity.hp - before;
    }
    let incoming = Number(amount) || 0;
    if (incoming > 0 && element !== 'undefined' && element !== 'manadrain') {
        incoming = absorbWithManaShield(entity, incoming).leftoverHp;
    }
    const before = entity.hp | 0;
    entity.hp = Math.max(0, before - incoming);
    if (entity.character) entity.character.hp = entity.hp;
    if (entity.hp <= 0) entity.alive = false;
    return entity.hp - before;
}

function tickConditions(entity, dtSec, hooks) {
    const result = { ticks: [], expired: [] };
    if (!isCombatantAlive(entity) && !(entity && Array.isArray(entity.conditions) && entity.conditions.length)) {
        return result;
    }
    const dt = Number(dtSec) || 0;
    if (!(dt > 0)) return result;
    const list = ensureConditionList(entity);
    const applyHp = hooks && typeof hooks.applyHpDelta === 'function' ? hooks.applyHpDelta : null;

    for (let i = list.length - 1; i >= 0; i--) {
        const c = list[i];
        if (!c) {
            list.splice(i, 1);
            continue;
        }
        if (c.kind === 'regen') {
            const interval = c.tickIntervalSec > 0 ? c.tickIntervalSec : 3;
            const gain = Math.max(0, Math.floor(Number(c.healthGain) || 0));
            c.tickTimer = (c.tickTimer || 0) + dt;
            while (c.tickTimer >= interval && gain > 0 && isCombatantAlive(entity)) {
                c.tickTimer -= interval;
                let healed = gain;
                if (applyHp) applyHp(entity, -gain, 'healing');
                else applyHpDeltaLocal(entity, gain, 'healing');
                result.ticks.push({ kind: 'regen', heal: healed });
            }
            if (c.durationSec != null) {
                c.durationSec -= dt;
                if (c.durationSec <= 0) {
                    result.expired.push('regen');
                    list.splice(i, 1);
                }
            }
            continue;
        }
        if (c.durationSec != null) {
            c.durationSec -= dt;
            if (c.durationSec <= 0) {
                result.expired.push(c.kind);
                list.splice(i, 1);
            }
            continue;
        }
        if (c.remainingDamage != null && c.remainingDamage > 0) {
            c.tickTimer = (c.tickTimer || 0) + dt;
            let interval = c.tickIntervalSec > 0 ? c.tickIntervalSec : 4;
            while (c.tickTimer >= interval && c.remainingDamage > 0) {
                c.tickTimer -= interval;
                let chunk = 1;
                if (c.schedule && Array.isArray(c.schedule) && c.scheduleIndex < c.schedule.length) {
                    const stage = c.schedule[c.scheduleIndex];
                    chunk = Math.max(0, Number(stage.damage || 0));
                    c.scheduleTurnsRemaining = (c.scheduleTurnsRemaining || 0) - 1;
                    if (c.scheduleTurnsRemaining <= 0) {
                        c.scheduleIndex += 1;
                        if (c.scheduleIndex < c.schedule.length) {
                            const nextStage = c.schedule[c.scheduleIndex];
                            c.scheduleTurnsRemaining = Number(nextStage.turns || 0);
                            c.tickIntervalSec = nextStage.intervalSec > 0
                                ? Number(nextStage.intervalSec) : interval;
                        }
                    }
                    if (c.scheduleIndex >= c.schedule.length && c.scheduleTurnsRemaining <= 0) {
                        c.remainingDamage = Math.min(c.remainingDamage, chunk);
                    }
                } else {
                    chunk = Math.max(1, Math.ceil(c.remainingDamage / 10));
                }
                const rawDmg = Math.min(c.remainingDamage, chunk);
                c.remainingDamage -= rawDmg;
                const element = c.element || 'earth';
                const mit = applyMitigation(rawDmg, element, entity);
                const dmg = mit.final;
                if (dmg > 0) {
                    if (applyHp) applyHp(entity, dmg, element);
                    else applyHpDeltaLocal(entity, dmg, element);
                }
                result.ticks.push({
                    kind: c.kind,
                    damage: dmg,
                    rawDamage: rawDmg,
                    element,
                    remaining: c.remainingDamage
                });
                if (!isCombatantAlive(entity)) break;
                interval = c.tickIntervalSec > 0 ? c.tickIntervalSec : 4;
            }
            if (c.remainingDamage <= 0) {
                result.expired.push(c.kind);
                list.splice(i, 1);
            }
        } else {
            list.splice(i, 1);
        }
    }
    recomputeDerived(entity);
    return result;
}

module.exports = {
    DOT_KINDS,
    DOT_KIND_SET,
    FIELD_BURNING,
    FIELD_POISONED,
    isCombatantAlive,
    normalizeConditionDef,
    conditionDefFromSpell,
    applyCondition,
    removeCondition,
    removeConditions,
    tickConditions,
    isInvisible,
    hasHaste,
    entityHasCondition,
    isCannotAttack,
    getAttributeMods,
    absorbWithManaShield,
    recomputeDerived,
    applyHpDeltaLocal,
    isImmuneToCondition,
    hasteSpeedChangeFromFormula,
    computeManaShieldPool
};

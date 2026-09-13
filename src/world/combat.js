'use strict';

const { SWING_FLAG } = require('../protocol/opcodes');

const MELEE_AUTO_FACTOR = 0.102;
const UNARMED_ATK = 7;
const SWING_MISS = SWING_FLAG.MISS;
const SWING_DEATH = SWING_FLAG.DEATH;
const SWING_CRIT = SWING_FLAG.CRIT;
const SWING_FATAL = SWING_FLAG.FATAL;
const CRIT_BAND_AUTO_ST = 'auto_st';
const CRIT_BAND_MULTIPLY = 'multiply';
const AUTO_ST_CRIT_FLOOR = 0.65;
const FATAL_CHANCE_A = 0.05;
const FATAL_CHANCE_B = 0.4;
const FATAL_CHANCE_C = 0.05;
const FATAL_DAMAGE_BONUS = 0.6;

function chebyshev(ax, ay, bx, by) {
    return Math.max(Math.abs((ax | 0) - (bx | 0)), Math.abs((ay | 0) - (by | 0)));
}

function levelBonus(level) {
    let remaining = Math.max(0, Math.floor(Number(level) || 0));
    let bonus = 0;
    let step = 5;
    while (remaining > 0) {
        const bandSize = step * 100;
        const inBand = Math.min(remaining, bandSize);
        bonus += Math.floor(inBand / step);
        remaining -= inBand;
        step += 1;
    }
    return bonus;
}

function meleeAutoBounds(level, atk, skill, factor) {
    const f = factor == null ? MELEE_AUTO_FACTOR : Number(factor);
    const bonus = levelBonus(level);
    const max = Math.ceil(f * (Number(atk) || 0) * (Number(skill) || 0) + bonus);
    return { min: bonus, max: max < bonus ? bonus : max };
}

function randUnit(rng) {
    const n = typeof rng === 'function' ? rng() : Math.random();
    if (!Number.isFinite(n) || n < 0) return 0;
    if (n >= 1) return 0.999999;
    return n;
}

function sampleStandardNormal(rng) {
    let u;
    let v;
    let s;
    let guard = 0;
    do {
        u = 2 * rng() - 1;
        v = 2 * rng() - 1;
        s = u * u + v * v;
        if (++guard > 32) return 0;
    } while (s === 0 || s >= 1);
    return u * Math.sqrt((-2 * Math.log(s)) / s);
}

/** N(0.5, 0.25) rejected outside [0,1], mapped onto [min, max]. */
function gaussianRaw(min, max, rng) {
    const a = Math.min(Number(min) || 0, Number(max) || 0);
    const b = Math.max(Number(min) || 0, Number(max) || 0);
    if (a === b) return a;
    const rand = typeof rng === 'function' ? rng : Math.random;
    let unit;
    let guard = 0;
    do {
        unit = 0.5 + 0.25 * sampleStandardNormal(rand);
        if (++guard > 64) {
            unit = 0.5;
            break;
        }
    } while (unit < 0 || unit > 1);
    return a + Math.round(unit * (b - a));
}

function uniformRaw(min, max, rng) {
    const lo = Math.min(Number(min) || 0, Number(max) || 0);
    const hi = Math.max(Number(min) || 0, Number(max) || 0);
    if (lo >= hi) return lo;
    const raw = Math.floor(lo + randUnit(rng) * (hi - lo + 1));
    return raw > hi ? hi : raw;
}

function autoStCritRollMin(min, max) {
    const lo = Math.min(Number(min) || 0, Number(max) || 0);
    const hi = Math.max(Number(min) || 0, Number(max) || 0);
    const raised = Math.floor(AUTO_ST_CRIT_FLOOR * hi);
    const rollMin = Math.max(lo, raised);
    return rollMin > hi ? hi : rollMin;
}

function rollHit(hitChance, rng) {
    const chance = hitChance == null ? 100 : Number(hitChance);
    if (chance >= 100) return true;
    if (chance <= 0) return false;
    return randUnit(rng) * 100 < chance;
}

function rollCritical(critChance, rng) {
    const c = Math.max(0, Number(critChance) || 0);
    if (c <= 0) return false;
    if (c >= 100) return true;
    return randUnit(rng) * 100 < c;
}

function fatalChanceFromTier(tier) {
    const t = Math.floor(Number(tier) || 0);
    if (t <= 0) return 0;
    return FATAL_CHANCE_A * t * t + FATAL_CHANCE_B * t + FATAL_CHANCE_C;
}

function rollFatal(fatalChance, rng) {
    const c = Number(fatalChance) || 0;
    if (!(c > 0)) return false;
    const sample = Math.floor(randUnit(rng) * 10001);
    return sample / 100 < c;
}

function applyFatalBonus(raw) {
    const n = Math.max(0, Number(raw) || 0);
    return n + Math.round(n * FATAL_DAMAGE_BONUS);
}

function rollArmorReduction(armor, rng) {
    const a = Math.max(0, Math.floor(Number(armor) || 0));
    if (a <= 0) return 0;
    const lo = Math.ceil(a / 2);
    const hi = lo * 2 - 1;
    if (lo >= hi) return lo;
    const n = Math.floor(lo + randUnit(rng) * (hi - lo + 1));
    return n > hi ? hi : n;
}

function rollShieldBlock(maxBlock, rng) {
    const m = Math.max(0, Math.floor(Number(maxBlock) || 0));
    if (m <= 0) return 0;
    const n = Math.floor(randUnit(rng) * (m + 1));
    return n > m ? m : n;
}

function kitAttack(attacker) {
    const list = attacker && attacker.attacks;
    if (!list || !list.length) return null;
    let fallback = null;
    for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!a) continue;
        const kind = String(a.kind || 'melee').toLowerCase();
        if (kind === 'status') continue;
        if (kind === 'melee' || kind === 'auto') return a;
        if (!fallback && (a.min != null || a.max != null)) fallback = a;
    }
    return fallback || list[0];
}

function playerSkill(attacker) {
    if (attacker && attacker.skill != null) return Number(attacker.skill) || 0;
    const key = (attacker && attacker.weaponSkill) || 'fist';
    const skills = attacker && attacker.skills;
    let n = 10;
    if (skills) {
        if (skills[key] != null) {
            n = Number(skills[key]) || 0;
        } else if (skills.melee != null && (key === 'sword' || key === 'axe' || key === 'club' || key === 'fist')) {
            n = Number(skills.melee) || 0;
        }
    }
    const bonus = attacker && attacker._gearSkillBonus && attacker._gearSkillBonus[key];
    if (bonus) n += Number(bonus) || 0;
    return n;
}

function playerFist(attacker) {
    return playerSkill(attacker);
}

function playerAtk(attacker, opts) {
    if (attacker && attacker.atk != null) return Number(attacker.atk) || 0;
    if (opts && opts.unarmedAtk != null) return Number(opts.unarmedAtk) || 0;
    return UNARMED_ATK;
}

function critChanceFor(attacker) {
    if (!attacker) return 0;
    if (attacker.critChance != null) return Math.max(0, Number(attacker.critChance) || 0);
    return 0;
}

function critDamageFor(attacker) {
    if (!attacker) return 0;
    if (attacker.critDamage != null) return Math.max(0, Number(attacker.critDamage) || 0);
    return 0;
}

function weaponTierFor(attacker) {
    if (!attacker || attacker.type === 'creature') return 0;
    if (attacker.weaponTier != null) return Math.max(0, Math.floor(Number(attacker.weaponTier) || 0));
    if (attacker.weapon && attacker.weapon.tier != null) {
        return Math.max(0, Math.floor(Number(attacker.weapon.tier) || 0));
    }
    return 0;
}

function classRow(pack, vocation) {
    const doc = pack && pack.classes;
    const list = doc && Array.isArray(doc.classes) ? doc.classes : null;
    if (!list) return null;
    const id = String(vocation || '').toLowerCase();
    if (!id) return null;
    for (let i = 0; i < list.length; i++) {
        const row = list[i];
        if (row && String(row.id).toLowerCase() === id) return row;
    }
    return null;
}

function playerCombatFromClass(cls) {
    return {
        critChance: cls && cls.critChance != null ? Math.max(0, Number(cls.critChance) || 0) : 0,
        critDamage: cls && cls.critDamage != null ? Math.max(0, Number(cls.critDamage) || 0) : 0
    };
}

function missResult() {
    return {
        miss: true,
        hit: false,
        raw: 0,
        final: 0,
        critical: false,
        fatal: false,
        shieldBlock: 0,
        armorReduction: 0,
        blockChargeSpent: false
    };
}

function rollRaw(min, max, isCritical, critDamage, rng, critBand) {
    const lo = Math.min(Number(min) || 0, Number(max) || 0);
    const hi = Math.max(Number(min) || 0, Number(max) || 0);
    const useAutoSt = !!isCritical && critBand === CRIT_BAND_AUTO_ST;
    let raw;
    if (useAutoSt) {
        raw = uniformRaw(autoStCritRollMin(lo, hi), hi, rng);
    } else if (critBand === CRIT_BAND_AUTO_ST) {
        raw = gaussianRaw(lo, hi, rng);
    } else {
        raw = uniformRaw(lo, hi, rng);
    }
    if (isCritical && critDamage) {
        raw = Math.floor(raw * (1 + (Number(critDamage) || 0) / 100));
    }
    return Math.max(0, raw);
}

/**
 * Physical melee. Order: miss → crit flag → raw → fatal → mit% → resist% → block → armor → floor.
 * Creatures use kit min/max (uniform, multiply crit). Players use unarmed melee_auto (gaussian / auto_st).
 */
function resolveMelee(attacker, defender, rng, opts) {
    const o = opts || {};
    const kit = attacker && attacker.type === 'creature' ? kitAttack(attacker) : null;
    const hitChance = kit
        ? (kit.hitChance != null ? Number(kit.hitChance) : kit.chance != null ? Number(kit.chance) : 100)
        : (attacker && attacker.hitChance != null ? Number(attacker.hitChance) : 100);
    if (o.hit === false || (o.hit !== true && !rollHit(hitChance, rng))) {
        return missResult();
    }

    const critBand = kit ? CRIT_BAND_MULTIPLY : CRIT_BAND_AUTO_ST;
    const isCritical = o.critical === true || o.critical === false
        ? !!o.critical
        : rollCritical(critChanceFor(attacker), rng);

    let raw;
    if (kit) {
        raw = rollRaw(kit.min, kit.max, isCritical, critDamageFor(attacker), rng, critBand);
    } else {
        const bounds = meleeAutoBounds(
            attacker && attacker.level,
            playerAtk(attacker, o),
            playerSkill(attacker),
            o.factor
        );
        raw = rollRaw(bounds.min, bounds.max, isCritical, critDamageFor(attacker), rng, critBand);
    }

    const element = (kit && kit.element) || 'physical';
    let isFatal = false;
    if (element !== 'healing' && element !== 'manadrain' && element !== 'undefined') {
        const fatalChance = attacker && attacker.type === 'creature'
            ? 0
            : (o.fatalChance != null ? Number(o.fatalChance) || 0 : fatalChanceFromTier(weaponTierFor(attacker)));
        isFatal = o.fatal === true || o.fatal === false
            ? !!o.fatal
            : rollFatal(fatalChance, rng);
        if (isFatal) raw = applyFatalBonus(raw);
    }

    const mit = Math.max(0, Math.min(100, Number(defender && defender.mitigation) || 0));
    let remaining = raw * (1 - mit / 100);

    const resists = defender && defender.resists;
    const resist = resists && resists[element] != null ? Number(resists[element]) : 0;
    remaining = remaining * (1 - Math.max(0, Math.min(100, resist)) / 100);

    remaining = Math.max(0, remaining);
    const maxBlock = defender && defender.maxBlock != null ? defender.maxBlock : 0;
    const canBlock = !!(defender && defender.canBlock && maxBlock > 0 && element === 'physical');
    let shieldBlock = 0;
    if (canBlock) {
        shieldBlock = Math.min(rollShieldBlock(maxBlock, rng), remaining);
        remaining -= shieldBlock;
    }

    let armorReduction = 0;
    if (element === 'physical') {
        armorReduction = Math.min(rollArmorReduction(defender && defender.armor, rng), remaining);
        remaining -= armorReduction;
    }

    const final = Math.max(0, Math.floor(remaining));
    return {
        miss: false,
        hit: true,
        raw,
        final,
        critical: isCritical,
        fatal: isFatal,
        shieldBlock,
        armorReduction,
        blockChargeSpent: canBlock
    };
}

/**
 * Authoritative wand/rod auto-attack.
 * Fixed uniform roll in [min, max], elemental damage.
 * Multiplied on crit: uniform in [min, max] * (1 + critDamage/100).
 * Subject to defender mitigation% and resists[element]%.
 * Bypasses shield block (0) and armor reduction (0).
 * Returns { miss, hit, raw, final, critical, fatal: false, shieldBlock: 0, armorReduction: 0, blockChargeSpent: false, element, manaGain }
 */
function resolveWandAuto(attacker, defender, rng, opts) {
    const o = opts || {};
    const hitChance = attacker && attacker.hitChance != null ? Number(attacker.hitChance) : 100;
    const element = String(
        (o && o.element) ||
        (attacker && attacker.weaponElement) ||
        'energy'
    ).toLowerCase();

    if (o.hit === false || (o.hit !== true && !rollHit(hitChance, rng))) {
        return {
            miss: true,
            hit: false,
            raw: 0,
            final: 0,
            critical: false,
            fatal: false,
            shieldBlock: 0,
            armorReduction: 0,
            blockChargeSpent: false,
            element,
            manaGain: 0
        };
    }

    const isCritical = o.critical === true || o.critical === false
        ? !!o.critical
        : rollCritical(critChanceFor(attacker), rng);

    const min = o.min != null
        ? Number(o.min)
        : (attacker && attacker.weaponMin != null ? Number(attacker.weaponMin) : 0);
    const max = o.max != null
        ? Number(o.max)
        : (attacker && attacker.weaponMax != null ? Number(attacker.weaponMax) : 0);

    const raw = rollRaw(min, max, isCritical, critDamageFor(attacker), rng, CRIT_BAND_MULTIPLY);

    const mit = Math.max(0, Math.min(100, Number(defender && defender.mitigation) || 0));
    let remaining = raw * (1 - mit / 100);

    const resists = defender && defender.resists;
    const resist = resists && resists[element] != null ? Number(resists[element]) : 0;
    remaining = remaining * (1 - Math.max(0, Math.min(100, resist)) / 100);
    remaining = Math.max(0, remaining);

    const final = Math.max(0, Math.floor(remaining));

    const weaponManaGain = o.manaGain != null
        ? Math.max(0, Math.floor(Number(o.manaGain) || 0))
        : (attacker && attacker.weaponManaGain != null ? Math.max(0, Math.floor(Number(attacker.weaponManaGain) || 0)) : 0);

    const manaGain = final > 0 ? weaponManaGain : 0;

    return {
        miss: false,
        hit: true,
        raw,
        final,
        critical: isCritical,
        fatal: false,
        shieldBlock: 0,
        armorReduction: 0,
        blockChargeSpent: false,
        element,
        manaGain
    };
}

function meleeRangeOk(a, b) {
    if (!a || !b) return false;
    if ((a.z | 0) !== (b.z | 0)) return false;
    return chebyshev(a.x, a.y, b.x, b.y) <= 1;
}

function round4(n) {
    return Math.round(Number(n) * 1e4) / 1e4;
}

function normalizeDamageAmplitude(amplitude) {
    if (amplitude == null || amplitude === '') return 0;
    const a = Number(amplitude);
    if (!Number.isFinite(a) || a <= 0) return 0;
    return Math.min(0.95, a);
}

const spellParamCache = { magic: Object.create(null), melee: Object.create(null) };

function getMagicSpellParameters(basePower) {
    const bp = Math.max(0, Number(basePower) || 0);
    const key = String(bp);
    if (spellParamCache.magic[key] !== undefined) return spellParamCache.magic[key];
    const x1 =
        -3.096 * Math.pow(10, -8) * Math.pow(bp, 3) +
        5.304 * Math.pow(10, -5) * Math.pow(bp, 2) +
        0.01499 * bp +
        0.705;
    const x2 = x1 * Math.max(
        7.383 * Math.pow(10, -8) * Math.pow(bp, 3) -
            6.507 * Math.pow(10, -5) * Math.pow(bp, 2) +
            0.01571 * bp +
            0.747,
        1.5
    );
    const params = {
        min: { x: round4(x1), y: Math.max(Math.round(0.203 * bp - 4.34), 2) },
        max: { x: round4(x2), y: Math.max(Math.round(0.302 * bp), 3) }
    };
    spellParamCache.magic[key] = params;
    return params;
}

function getMeleeSpellParameters(basePower) {
    const bp = Math.max(0, Number(basePower) || 0);
    const key = String(bp);
    if (spellParamCache.melee[key] !== undefined) return spellParamCache.melee[key];
    const x1 =
        -0.01567 +
        0.002391 * bp -
        0.000041 * (bp * bp) +
        0.000000268 * Math.pow(bp, 3);
    const params = {
        min: { x: round4(x1), y: Math.max(Math.round(0.203 * bp - 4.34), 2) },
        max: { x: round4(x1 * 1.77), y: Math.max(Math.round(0.302 * bp), 3) }
    };
    spellParamCache.melee[key] = params;
    return params;
}

function meanCoefficients(params) {
    return {
        x: (params.min.x + params.max.x) / 2,
        y: (params.min.y + params.max.y) / 2
    };
}

function rangeFromMean(mean, amplitude) {
    const m = Math.max(0, Number(mean) || 0);
    const a = normalizeDamageAmplitude(amplitude);
    if (a <= 0) {
        const v = Math.max(0, Math.round(m));
        return { min: v, max: v };
    }
    let min = Math.round(m * (1 - a));
    let max = Math.round(m * (1 + a));
    if (min < 0) min = 0;
    if (max < min) max = min;
    return { min, max };
}

function attackerMagic(attacker) {
    if (!attacker) return 0;
    if (attacker.magic != null) return Math.max(0, Number(attacker.magic) || 0);
    const skills = attacker.skills;
    if (skills && skills.magic != null) return Math.max(0, Number(skills.magic) || 0);
    return 0;
}

function computeMagicMean(attacker, basePower) {
    const lb = levelBonus(attacker && attacker.level);
    const magic = attackerMagic(attacker);
    const mid = meanCoefficients(getMagicSpellParameters(basePower));
    return lb + magic * mid.x + mid.y;
}

function computeMeleeMean(attacker, basePower) {
    const lb = levelBonus(attacker && attacker.level);
    const atk = Math.max(0, Number(attacker && attacker.atk) || 0);
    const skill = Math.max(0, playerSkill(attacker));
    const mid = meanCoefficients(getMeleeSpellParameters(basePower));
    return lb + skill * atk * mid.x + mid.y;
}

function computeMeleeStrikeRange(attacker, basePower, damageAmplitude) {
    return rangeFromMean(computeMeleeMean(attacker, basePower), damageAmplitude);
}

function computeMagicStrikeRange(attacker, basePower, damageAmplitude) {
    return rangeFromMean(computeMagicMean(attacker, basePower), damageAmplitude);
}

function computeSpellDamageRange(spell, attacker) {
    if (!spell) return { min: 0, max: 0 };
    if (spell.min != null || spell.max != null) {
        const lo = Math.max(0, Number(spell.min) || 0);
        const hi = Math.max(lo, Number(spell.max) || 0);
        return { min: lo, max: hi };
    }
    const curve = spell.powerCurve;
    const bp = spell.basePower;
    const amp = spell.damageAmplitude;
    if (curve === 'melee_strike') return computeMeleeStrikeRange(attacker, bp, amp);
    if (curve === 'magic_strike') return computeMagicStrikeRange(attacker, bp, amp);
    if (curve === 'melee_auto' || curve === 'distance_auto') {
        return meleeAutoBounds(
            attacker && attacker.level,
            playerAtk(attacker),
            playerSkill(attacker)
        );
    }
    return { min: 0, max: 0 };
}

function applyMitigation(raw, element, defender, opts) {
    const options = opts || {};
    const rng = options.rng;
    const el = element || 'physical';
    let dmg = Math.max(0, Number(raw) || 0);
    const initial = dmg;
    if (el === 'healing') {
        return {
            final: Math.max(0, Math.floor(dmg)),
            raw: initial,
            mitigation: 0,
            elementReduction: 0,
            shieldBlock: 0,
            armorReduction: 0,
            element: el
        };
    }
    const mitPct = Math.max(0, Number(defender && defender.mitigation) || 0);
    const mitigation = dmg * (mitPct / 100);
    dmg -= mitigation;
    const resistPct = Math.max(
        0,
        Math.min(100, Number((defender && defender.resists && defender.resists[el]) || 0))
    );
    const elementReduction = dmg * (resistPct / 100);
    dmg -= elementReduction;
    let shieldBlock = 0;
    if (
        options.isMelee &&
        el === 'physical' &&
        defender &&
        defender.canBlock &&
        (defender.maxBlock || 0) > 0
    ) {
        shieldBlock = Math.min(rollShieldBlock(defender.maxBlock, rng), dmg);
        dmg -= shieldBlock;
    }
    let armorReduction = 0;
    if (el === 'physical' && defender && (defender.armor || 0) > 0) {
        armorReduction = Math.min(rollArmorReduction(defender.armor, rng), dmg);
        dmg -= armorReduction;
    }
    return {
        final: Math.max(0, Math.floor(dmg)),
        raw: initial,
        mitigation,
        elementReduction,
        shieldBlock,
        armorReduction,
        element: el,
        blockChargeSpent: shieldBlock > 0
    };
}

function spellCanCritOrLeech(spell) {
    if (!spell) return false;
    if (spell.kind === 'heal' || spell.kind === 'support') return false;
    const el = spell.element || 'physical';
    if (el === 'healing' || el === 'manadrain' || el === 'undefined') return false;
    return true;
}

function spellIsMultiTarget(spell) {
    if (!spell) return false;
    if (spell.shape && typeof spell.shape === 'object') {
        const t = String(spell.shape.type || '');
        if (t === 'area' || t === 'wave' || t === 'beam') return true;
    }
    if (spell.chain != null && Number(spell.chain) > 1) return true;
    if (Array.isArray(spell.followupShapes) && spell.followupShapes.length > 0) return true;
    return false;
}

function critBandForSpell(spell) {
    if (!spell) return CRIT_BAND_MULTIPLY;
    const id = String(spell.id || '');
    if (id === 'wand_auto') return CRIT_BAND_MULTIPLY;
    const curve = spell.powerCurve;
    if (curve === 'magic_strike') return CRIT_BAND_MULTIPLY;
    const isWeaponAuto = spell.kind === 'auto' || id === 'melee_auto' || id === 'distance_auto';
    if (!isWeaponAuto) return CRIT_BAND_MULTIPLY;
    const isMeleeOrDistance =
        curve === 'melee_auto' || curve === 'distance_auto'
        || id === 'melee_auto' || id === 'distance_auto';
    if (!isMeleeOrDistance) return CRIT_BAND_MULTIPLY;
    if (spellIsMultiTarget(spell)) return CRIT_BAND_MULTIPLY;
    return CRIT_BAND_AUTO_ST;
}

function resolveSpellHit(attacker, defender, spell, rng, opts) {
    const o = opts || {};
    const element = (spell && spell.element) || 'physical';
    const healing = element === 'healing' || (spell && spell.kind === 'heal');
    if (o.hit === false || (o.hit !== true && !rollHit(spell && spell.hitChance, rng))) {
        return missResult();
    }
    const canCrit = spellCanCritOrLeech(spell) && !healing;
    const critBand = o.critBand || critBandForSpell(spell);
    const isCritical = !canCrit
        ? false
        : (o.critical === true || o.critical === false ? !!o.critical : rollCritical(critChanceFor(attacker), rng));
    const range = o.range || computeSpellDamageRange(spell, attacker);
    let raw = rollRaw(range.min, range.max, isCritical, canCrit ? critDamageFor(attacker) : 0, rng, critBand);
    if (o.damageScale != null && Number(o.damageScale) !== 1) {
        raw = Math.max(0, Math.round(raw * Number(o.damageScale)));
    }
    if (healing) {
        const final = Math.max(0, Math.floor(raw));
        return {
            miss: false,
            hit: true,
            raw,
            final,
            critical: false,
            fatal: false,
            shieldBlock: 0,
            armorReduction: 0,
            blockChargeSpent: false,
            element: 'healing'
        };
    }
    let isFatal = false;
    if (canCrit) {
        const fatalChance = attacker && attacker.type === 'creature'
            ? 0
            : (o.fatalChance != null ? Number(o.fatalChance) || 0 : fatalChanceFromTier(weaponTierFor(attacker)));
        isFatal = o.fatal === true || o.fatal === false ? !!o.fatal : rollFatal(fatalChance, rng);
        if (isFatal) raw = applyFatalBonus(raw);
    }
    const isMelee = !!(spell && (spell.isMelee === true || spell.powerCurve === 'melee_strike'
        || spell.kind === 'strike' && (spell.element || 'physical') === 'physical'));
    const mit = applyMitigation(raw, element, defender, { rng, isMelee });
    return {
        miss: false,
        hit: true,
        raw,
        final: mit.final,
        critical: isCritical,
        fatal: isFatal,
        shieldBlock: mit.shieldBlock,
        armorReduction: mit.armorReduction,
        blockChargeSpent: mit.blockChargeSpent,
        element
    };
}

module.exports = {
    MELEE_AUTO_FACTOR,
    UNARMED_ATK,
    SWING_MISS,
    SWING_DEATH,
    SWING_CRIT,
    SWING_FATAL,
    CRIT_BAND_AUTO_ST,
    CRIT_BAND_MULTIPLY,
    AUTO_ST_CRIT_FLOOR,
    FATAL_DAMAGE_BONUS,
    chebyshev,
    levelBonus,
    meleeAutoBounds,
    gaussianRaw,
    uniformRaw,
    autoStCritRollMin,
    rollHit,
    rollCritical,
    fatalChanceFromTier,
    rollFatal,
    applyFatalBonus,
    rollArmorReduction,
    rollShieldBlock,
    kitAttack,
    classRow,
    playerCombatFromClass,
    playerSkill,
    resolveMelee,
    resolveWandAuto,
    meleeRangeOk,
    getMagicSpellParameters,
    getMeleeSpellParameters,
    computeMagicStrikeRange,
    computeMeleeStrikeRange,
    computeSpellDamageRange,
    applyMitigation,
    spellCanCritOrLeech,
    critBandForSpell,
    resolveSpellHit
};

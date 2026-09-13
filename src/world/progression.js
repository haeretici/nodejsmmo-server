'use strict';

/** Product port of HuntDL [27] exp / skill math. No kernel require. */

const EXP_LEVEL_CACHE_MAX = 2000;
const EXP_FOR_LEVEL_CACHE = new Array(EXP_LEVEL_CACHE_MAX + 1);

function fillExpForLevelCache() {
    EXP_FOR_LEVEL_CACHE[0] = 0;
    EXP_FOR_LEVEL_CACHE[1] = 0;
    for (let L = 2; L <= EXP_LEVEL_CACHE_MAX; L++) {
        EXP_FOR_LEVEL_CACHE[L] = Math.floor(
            (50 / 3) * (L * L * L - 6 * L * L + 17 * L - 12)
        );
    }
}
fillExpForLevelCache();

const DEFAULT_EXP_RATES = Object.freeze({
    baseRate: 1,
    eventMult: 1,
    staminaMult: 1,
    additiveBonus: 0,
    prey: 0,
    xpBoost: 0
});

const DEFAULT_SKILL_SESSION_RATES = Object.freeze({
    stageMult: 1,
    skillPrey: 0
});

const BLOOD_HIT_BUCKET = 30;
const SHIELD_BLOCK_BUCKET = 30;

const WEAPON_SKILL_BAGS = Object.freeze([
    'sword', 'axe', 'club', 'fist', 'melee', 'distance'
]);

const SKILL_BASE = Object.freeze({
    fist: 50,
    club: 50,
    sword: 50,
    axe: 50,
    melee: 50,
    distance: 30,
    shielding: 100,
    shield: 100,
    fishing: 20
});

const MAGIC_MANA_BASE = 1600;
const SKILL_FLOOR = 10;
const MAGIC_FLOOR = 0;

const SKILL_KEYS = Object.freeze([
    'fist', 'club', 'sword', 'axe', 'distance', 'shielding', 'magic', 'fishing'
]);

function finiteOr(n, fallback) {
    const v = Number(n);
    return Number.isFinite(v) ? v : fallback;
}

function normalizeSkillKey(skill) {
    const k = skill != null ? String(skill).toLowerCase() : '';
    if (k === 'shield' || k === 'shielding') return 'shielding';
    if (k === 'sword' || k === 'axe' || k === 'club') return 'melee';
    if (k === 'magiclevel' || k === 'magic_level' || k === 'ml') return 'magic';
    return k;
}

function skillMultiplier(skill, rates) {
    const key = normalizeSkillKey(skill);
    const r = rates && typeof rates === 'object' ? rates : {};
    if (key === 'magic') {
        const m = r.magic != null ? Number(r.magic) : 1.1;
        return m > 1 ? m : 1.1;
    }
    if (key === 'fist') {
        const m = r.fist != null ? Number(r.fist) : r.melee != null ? Number(r.melee) : 1.1;
        return m > 1 ? m : 1.1;
    }
    if (key === 'distance') {
        const m = r.distance != null ? Number(r.distance) : 1.1;
        return m > 1 ? m : 1.1;
    }
    if (key === 'shielding') {
        const m = r.shielding != null ? Number(r.shielding) : 1.1;
        return m > 1 ? m : 1.1;
    }
    if (key === 'fishing') {
        const m = r.fishing != null ? Number(r.fishing) : 1.1;
        return m > 1 ? m : 1.1;
    }
    const m = r.melee != null ? Number(r.melee) : 1.1;
    return m > 1 ? m : 1.1;
}

function skillBase(skill) {
    const key = normalizeSkillKey(skill);
    if (key === 'magic') return MAGIC_MANA_BASE;
    return SKILL_BASE[key] != null ? SKILL_BASE[key] : SKILL_BASE.melee;
}

function getReqSkillTries(skill, skillLevel, rates) {
    const level = Math.floor(Number(skillLevel) || 0);
    if (level <= SKILL_FLOOR) return 0;
    const base = skillBase(skill);
    const m = skillMultiplier(skill, rates);
    return Math.floor(base * Math.pow(m, level - 11));
}

function totalSkillTries(skill, skillLevel, rates) {
    const level = Math.floor(Number(skillLevel) || 0);
    if (level <= SKILL_FLOOR) return 0;
    const base = skillBase(skill);
    const m = skillMultiplier(skill, rates);
    if (m <= 1) return Math.floor(base * (level - SKILL_FLOOR));
    return Math.floor((base * (Math.pow(m, level - SKILL_FLOOR) - 1)) / (m - 1));
}

function getReqMana(magicLevel, rates) {
    const ml = Math.floor(Number(magicLevel) || 0);
    if (ml <= MAGIC_FLOOR) return 0;
    const mult = skillMultiplier('magic', rates);
    return Math.floor(MAGIC_MANA_BASE * Math.pow(mult, ml - 1));
}

function totalManaForMagicLevel(magicLevel, rates) {
    const ml = Math.floor(Number(magicLevel) || 0);
    if (ml <= MAGIC_FLOOR) return 0;
    let total = 0;
    for (let i = 1; i <= ml; i++) total += getReqMana(i, rates);
    return total;
}

function getExpForLevel(level) {
    const L = Math.floor(Number(level) || 0);
    if (L <= 1) return 0;
    if (L <= EXP_LEVEL_CACHE_MAX) return EXP_FOR_LEVEL_CACHE[L];
    return Math.floor((50 / 3) * (L * L * L - 6 * L * L + 17 * L - 12));
}

function expToNext(level) {
    const L = Math.floor(Number(level) || 0);
    if (L < 1) return getExpForLevel(2);
    return 50 * L * L - 150 * L + 200;
}

function levelFromExp(experience) {
    const exp = Math.max(0, Math.floor(Number(experience) || 0));
    if (exp <= 0) return 1;
    let lo = 1;
    let hi = EXP_LEVEL_CACHE_MAX;
    while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (getExpForLevel(mid) <= exp) lo = mid;
        else hi = mid - 1;
    }
    if (lo >= EXP_LEVEL_CACHE_MAX && getExpForLevel(EXP_LEVEL_CACHE_MAX) <= exp) {
        let L = EXP_LEVEL_CACHE_MAX;
        while (getExpForLevel(L + 1) <= exp && L < 10000) L += 1;
        return L;
    }
    return lo;
}

function vocationKey(memberOrClassId) {
    if (memberOrClassId == null) return 'adventurer';
    if (typeof memberOrClassId === 'string') {
        const s = memberOrClassId.trim().toLowerCase();
        return s || 'adventurer';
    }
    const id = memberOrClassId.classId != null
        ? memberOrClassId.classId
        : memberOrClassId.vocation != null
            ? memberOrClassId.vocation
            : memberOrClassId.class;
    const s = id != null ? String(id).trim().toLowerCase() : '';
    return s || 'adventurer';
}

function uniqueVocationCount(members) {
    const set = new Set();
    const list = Array.isArray(members) ? members : [];
    for (let i = 0; i < list.length; i++) {
        if (set.size >= 4) break;
        if (list[i]) set.add(vocationKey(list[i]));
    }
    return Math.max(1, set.size);
}

function partyShareMultiplier(uniqueVocations, partySize) {
    const V = Math.max(1, Math.min(4, Math.floor(Number(uniqueVocations) || 1)));
    const N = Math.max(1, Math.floor(Number(partySize) || 1));
    let mul = 0.1 * V * V - 0.2 * V + 1.3;
    if (N >= 4) mul -= 0.1;
    return mul;
}

function partySharePerMember(monsterExp, opts) {
    const o = opts || {};
    const exp = Math.max(0, Number(monsterExp) || 0);
    const N = Math.max(
        1,
        Math.floor(
            o.partySize != null
                ? Number(o.partySize)
                : Array.isArray(o.members) ? o.members.length : 1
        ) || 1
    );
    const V = o.uniqueVocations != null
        ? Math.max(1, Math.min(4, Math.floor(Number(o.uniqueVocations) || 1)))
        : Array.isArray(o.members) ? uniqueVocationCount(o.members) : 1;
    const shareOn = o.partyShareEnabled !== false;
    if (N === 1) {
        return { personalRaw: Math.ceil(exp), shareMul: 1, partySize: 1, uniqueVocations: V };
    }
    if (!shareOn) {
        return { personalRaw: Math.ceil(exp / N), shareMul: 1, partySize: N, uniqueVocations: V };
    }
    const shareMul = partyShareMultiplier(V, N);
    return {
        personalRaw: Math.ceil((exp * shareMul) / N),
        shareMul,
        partySize: N,
        uniqueVocations: V
    };
}

function normalizeExpRates(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const pos = (v, d) => {
        const n = finiteOr(v, d);
        return n > 0 ? n : d;
    };
    const nonNeg = (v, d) => {
        const n = finiteOr(v, d);
        return n >= 0 ? n : d;
    };
    return {
        baseRate: pos(r.baseRate, DEFAULT_EXP_RATES.baseRate),
        eventMult: pos(r.eventMult, DEFAULT_EXP_RATES.eventMult),
        staminaMult: pos(r.staminaMult, DEFAULT_EXP_RATES.staminaMult),
        additiveBonus: nonNeg(r.additiveBonus, DEFAULT_EXP_RATES.additiveBonus),
        prey: nonNeg(r.prey, DEFAULT_EXP_RATES.prey),
        xpBoost: nonNeg(r.xpBoost, DEFAULT_EXP_RATES.xpBoost)
    };
}

function applyPersonalExpRates(personalRaw, rates) {
    const raw = Math.max(0, Number(personalRaw) || 0);
    const r = normalizeExpRates(rates);
    const additiveFactor = 1 + r.additiveBonus + r.prey + r.xpBoost;
    const mult = r.baseRate * r.eventMult * r.staminaMult;
    return Math.floor(raw * additiveFactor * mult);
}

function normalizeSkillSessionRates(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const stage = r.stageMult != null
        ? finiteOr(r.stageMult, DEFAULT_SKILL_SESSION_RATES.stageMult)
        : r.skillRateStages != null
            ? finiteOr(r.skillRateStages, DEFAULT_SKILL_SESSION_RATES.stageMult)
            : DEFAULT_SKILL_SESSION_RATES.stageMult;
    const prey = finiteOr(
        r.skillPrey != null ? r.skillPrey : r.prey,
        DEFAULT_SKILL_SESSION_RATES.skillPrey
    );
    return {
        stageMult: stage > 0 ? stage : DEFAULT_SKILL_SESSION_RATES.stageMult,
        skillPrey: prey >= 0 ? prey : DEFAULT_SKILL_SESSION_RATES.skillPrey
    };
}

function applySkillTryRates(rawTries, rates) {
    const raw = Math.max(0, Math.floor(Number(rawTries) || 0));
    const r = normalizeSkillSessionRates(rates);
    return Math.floor(raw * r.stageMult * (1 + r.skillPrey));
}

function seedPlayerExperience(player) {
    if (!player) return 0;
    const level = Math.max(1, Math.floor(Number(player.level) || 1));
    const minExp = getExpForLevel(level);
    if (player.experience != null && Number.isFinite(Number(player.experience))) {
        const curExp = Math.max(0, Math.floor(Number(player.experience)));
        const exp = Math.max(curExp, minExp);
        player.experience = exp;
        return exp;
    }
    player.experience = minExp;
    return minExp;
}

function applyExpProgression(player, awarded) {
    if (!player) {
        return { levelUps: 0, oldLevel: 1, newLevel: 1, experience: 0 };
    }
    seedPlayerExperience(player);
    const gain = Math.max(0, Math.floor(Number(awarded) || 0));
    player.experience = Math.max(0, Math.floor(Number(player.experience) || 0)) + gain;
    const oldLevel = Math.max(1, Math.floor(Number(player.level) || 1));
    const newLevel = levelFromExp(player.experience);
    if (newLevel > oldLevel) {
        player.level = newLevel;
        return {
            levelUps: newLevel - oldLevel,
            oldLevel,
            newLevel,
            experience: player.experience
        };
    }
    return {
        levelUps: 0,
        oldLevel,
        newLevel: oldLevel,
        experience: player.experience
    };
}

function getPlayerSkillLevel(player, skill) {
    const key = skill != null ? String(skill).toLowerCase() : '';
    const bag = player && player.skills;
    if (key === 'magic' || key === 'magiclevel' || key === 'ml') {
        return Math.max(MAGIC_FLOOR, Math.floor(Number(bag && bag.magic) || MAGIC_FLOOR));
    }
    if (key === 'sword' || key === 'axe' || key === 'club') {
        if (bag && bag[key] != null) {
            return Math.max(SKILL_FLOOR, Math.floor(Number(bag[key]) || SKILL_FLOOR));
        }
        if (bag && bag.melee != null) {
            return Math.max(SKILL_FLOOR, Math.floor(Number(bag.melee) || SKILL_FLOOR));
        }
        return SKILL_FLOOR;
    }
    if (key === 'shield' || key === 'shielding') {
        return Math.max(SKILL_FLOOR, Math.floor(Number(bag && bag.shielding) || SKILL_FLOOR));
    }
    if (key === 'fist') {
        if (bag && bag.fist != null) {
            return Math.max(SKILL_FLOOR, Math.floor(Number(bag.fist) || SKILL_FLOOR));
        }
        if (bag && bag.melee != null) {
            return Math.max(SKILL_FLOOR, Math.floor(Number(bag.melee) || SKILL_FLOOR));
        }
        return SKILL_FLOOR;
    }
    if (key === 'distance') {
        return Math.max(SKILL_FLOOR, Math.floor(Number(bag && bag.distance) || SKILL_FLOOR));
    }
    return Math.max(SKILL_FLOOR, Math.floor(Number(bag && bag.melee) || SKILL_FLOOR));
}

function setPlayerSkillLevel(player, skill, level) {
    if (!player) return;
    if (!player.skills || typeof player.skills !== 'object') player.skills = {};
    const key = skill != null ? String(skill).toLowerCase() : '';
    const lv = Math.max(0, Math.floor(Number(level) || 0));
    if (key === 'magic' || key === 'magiclevel' || key === 'ml') {
        player.skills.magic = lv;
        return;
    }
    if (key === 'shield' || key === 'shielding') {
        player.skills.shielding = Math.max(SKILL_FLOOR, lv);
        return;
    }
    if (key === 'sword' || key === 'axe' || key === 'club') {
        player.skills[key] = Math.max(SKILL_FLOOR, lv);
        let best = player.skills.melee != null ? Number(player.skills.melee) || 0 : 0;
        for (const k of ['sword', 'axe', 'club', 'fist']) {
            if (player.skills[k] != null) best = Math.max(best, Number(player.skills[k]) || 0);
        }
        player.skills.melee = Math.max(SKILL_FLOOR, best);
        return;
    }
    if (key === 'fist') {
        player.skills.fist = Math.max(SKILL_FLOOR, lv);
        return;
    }
    if (key === 'distance') {
        player.skills.distance = Math.max(SKILL_FLOOR, lv);
        return;
    }
    player.skills.melee = Math.max(SKILL_FLOOR, lv);
}

function ensureSkillCounterBags(player) {
    if (!player) return;
    if (!player.skillTriesGained || typeof player.skillTriesGained !== 'object') {
        player.skillTriesGained = Object.create(null);
    }
    if (player.skillTriesGained.total == null) player.skillTriesGained.total = 0;
    if (!player._skillTryProgress || typeof player._skillTryProgress !== 'object') {
        player._skillTryProgress = Object.create(null);
    }
    if (player.manaSpentTowardMagic == null) player.manaSpentTowardMagic = 0;
    if (player._manaTowardMagic == null) player._manaTowardMagic = 0;
    if (player.skillLevelsGained == null) player.skillLevelsGained = 0;
    if (player.magicLevelsGained == null) player.magicLevelsGained = 0;
    if (player.bloodHitCount == null) player.bloodHitCount = 0;
    if (player.shieldBlockCount == null) player.shieldBlockCount = 0;
}

function applySkillTries(player, skill, rawTries, opts) {
    const o = opts || {};
    const skillKey = skill != null ? String(skill).toLowerCase() : 'melee';
    const empty = {
        rawTries: 0,
        effectiveTries: 0,
        levelsGained: 0,
        oldLevel: getPlayerSkillLevel(player, skillKey),
        newLevel: getPlayerSkillLevel(player, skillKey),
        skill: skillKey
    };
    if (!player) return empty;

    const sessionSkillRates = normalizeSkillSessionRates(o.skillRates);
    const raw = Math.max(0, Math.floor(Number(rawTries) || 0));
    const effective = applySkillTryRates(raw, sessionSkillRates);
    ensureSkillCounterBags(player);

    if (effective > 0) {
        player.skillTriesGained[skillKey] = (player.skillTriesGained[skillKey] || 0) + effective;
        player.skillTriesGained.total = (player.skillTriesGained.total || 0) + effective;
    }

    const oldLevel = getPlayerSkillLevel(player, skillKey);
    if (!o.skillProgression || effective <= 0) {
        return {
            rawTries: raw,
            effectiveTries: effective,
            levelsGained: 0,
            oldLevel,
            newLevel: oldLevel,
            skill: skillKey
        };
    }

    const vocationRates = o.vocationRates || player.skillRates || null;
    let remaining = effective;
    let level = oldLevel;
    let progress = Math.max(0, Math.floor(Number(player._skillTryProgress[skillKey]) || 0));
    let guard = 0;
    while (remaining > 0 && guard < 500) {
        guard += 1;
        const need = getReqSkillTries(skillKey, level + 1, vocationRates);
        if (need <= 0) {
            const baseNeed = skillBase(skillKey);
            if (baseNeed <= 0) break;
            if (progress + remaining >= baseNeed) {
                remaining -= baseNeed - progress;
                progress = 0;
                level += 1;
                continue;
            }
            progress += remaining;
            remaining = 0;
            break;
        }
        if (progress + remaining >= need) {
            remaining -= need - progress;
            progress = 0;
            level += 1;
        } else {
            progress += remaining;
            remaining = 0;
        }
    }
    player._skillTryProgress[skillKey] = progress;
    const levelsGained = Math.max(0, level - oldLevel);
    if (levelsGained > 0) {
        setPlayerSkillLevel(player, skillKey, level);
        player.skillLevelsGained = (player.skillLevelsGained || 0) + levelsGained;
    }
    return {
        rawTries: raw,
        effectiveTries: effective,
        levelsGained,
        oldLevel,
        newLevel: level,
        skill: skillKey
    };
}

function applyManaTowardMagic(player, manaSpent, opts) {
    const o = opts || {};
    const empty = {
        mana: 0,
        levelsGained: 0,
        oldLevel: getPlayerSkillLevel(player, 'magic'),
        newLevel: getPlayerSkillLevel(player, 'magic')
    };
    if (!player) return empty;
    const mana = Math.max(0, Math.floor(Number(manaSpent) || 0));
    if (mana <= 0) return empty;

    const sessionSkillRates = normalizeSkillSessionRates(o.skillRates);
    const effective = applySkillTryRates(mana, sessionSkillRates);
    ensureSkillCounterBags(player);
    player.manaSpentTowardMagic = (player.manaSpentTowardMagic || 0) + effective;

    const oldLevel = getPlayerSkillLevel(player, 'magic');
    if (!o.skillProgression || effective <= 0) {
        return { mana: effective, levelsGained: 0, oldLevel, newLevel: oldLevel };
    }

    const vocationRates = o.vocationRates || player.skillRates || null;
    let remaining = effective;
    let ml = oldLevel;
    let progress = Math.max(0, Math.floor(Number(player._manaTowardMagic) || 0));
    let guard = 0;
    while (remaining > 0 && guard < 500) {
        guard += 1;
        const need = getReqMana(ml + 1, vocationRates);
        if (need <= 0) break;
        if (progress + remaining >= need) {
            remaining -= need - progress;
            progress = 0;
            ml += 1;
        } else {
            progress += remaining;
            remaining = 0;
        }
    }
    player._manaTowardMagic = progress;
    const levelsGained = Math.max(0, ml - oldLevel);
    if (levelsGained > 0) {
        setPlayerSkillLevel(player, 'magic', ml);
        player.magicLevelsGained = (player.magicLevelsGained || 0) + levelsGained;
    }
    return { mana: effective, levelsGained, oldLevel, newLevel: ml };
}

function classifyAttackBlockType(result) {
    if (!result || result.miss || result.hit === false) return 'miss';
    const final = Math.max(0, Number(result.final) || 0);
    if (final > 0) return 'none';
    const shield = Number(result.shieldBlock) || 0;
    const armor = Number(result.armorReduction) || 0;
    if (shield > 0) return 'defense';
    if (armor > 0) return 'armor';
    return 'immunity';
}

function resolveWeaponSkillBag(attacker) {
    if (!attacker || attacker.type !== 'player') return null;
    const ws = attacker.weaponSkill != null ? String(attacker.weaponSkill) : 'fist';
    if (ws === 'magic') return null;
    if (ws === 'distance') return 'distance';
    if (ws === 'sword' || ws === 'axe' || ws === 'club' || ws === 'fist' || ws === 'melee') {
        return ws;
    }
    return 'fist';
}

function defenderHasShield(defender) {
    if (!defender || defender.type !== 'player') return false;
    if (defender.canBlock === true && (Number(defender.maxBlock) || 0) > 0) return true;
    return false;
}

function processAttackSkillProgression(attacker, defender, result, opts) {
    const o = opts || {};
    const out = {
        weaponTries: 0,
        shieldTries: 0,
        blockType: 'miss',
        weaponSkill: null,
        weaponAdvance: null,
        shieldAdvance: null
    };
    if (!result || result.miss) {
        out.blockType = 'miss';
        return out;
    }

    const blockType = classifyAttackBlockType(result);
    out.blockType = blockType;
    const sessionOpts = {
        skillProgression: !!o.skillProgression,
        skillRates: o.skillRates,
        vocationRates: o.vocationRates
    };

    if (result.hit !== false && blockType === 'none' && defender && defender.type === 'player') {
        ensureSkillCounterBags(defender);
        defender.shieldBlockCount = SHIELD_BLOCK_BUCKET;
    }

    const grantWeapon = o.grantWeaponSkillTry !== false;
    if (grantWeapon && attacker && attacker.type === 'player') {
        ensureSkillCounterBags(attacker);
        const skillBag = resolveWeaponSkillBag(attacker);
        out.weaponSkill = skillBag;

        let allowWeapon = false;
        if (result.hit !== false && skillBag) {
            if (blockType === 'none') {
                attacker.bloodHitCount = BLOOD_HIT_BUCKET;
                allowWeapon = true;
            } else if (blockType === 'defense' || blockType === 'armor') {
                if ((attacker.bloodHitCount || 0) > 0) {
                    allowWeapon = true;
                    attacker.bloodHitCount = Math.max(0, (attacker.bloodHitCount || 0) - 1);
                }
            }
        }

        let rawTries = 0;
        if (allowWeapon && skillBag) {
            if (skillBag === 'distance') {
                if (blockType === 'none') rawTries = 2;
                else if (blockType === 'defense' || blockType === 'armor') rawTries = 1;
            } else if (WEAPON_SKILL_BAGS.indexOf(skillBag) >= 0) {
                rawTries = 1;
            }
        }
        out.weaponTries = rawTries;
        if (rawTries > 0) {
            out.weaponAdvance = applySkillTries(attacker, skillBag, rawTries, sessionOpts);
        }
    }

    if (
        defender &&
        defender.type === 'player' &&
        result.hit !== false &&
        (Number(result.final) || 0) === 0 &&
        o.blockChargeSpent
    ) {
        ensureSkillCounterBags(defender);
        const defOpts = Object.assign({}, sessionOpts, {
            vocationRates: o.defenderVocationRates || defender.skillRates || sessionOpts.vocationRates
        });
        if (defenderHasShield(defender) && (defender.shieldBlockCount || 0) > 0) {
            defender.shieldBlockCount = Math.max(0, (defender.shieldBlockCount || 0) - 1);
            out.shieldTries = 1;
            out.shieldAdvance = applySkillTries(defender, 'shielding', 1, defOpts);
        }
    }

    return out;
}

function skillLabel(skill) {
    const k = skill != null ? String(skill).toLowerCase() : '';
    if (k === 'magic') return 'magic level';
    if (k === 'shielding' || k === 'shield') return 'shielding';
    return k || 'skill';
}

module.exports = {
    SKILL_BASE,
    MAGIC_MANA_BASE,
    SKILL_FLOOR,
    MAGIC_FLOOR,
    EXP_LEVEL_CACHE_MAX,
    DEFAULT_EXP_RATES,
    DEFAULT_SKILL_SESSION_RATES,
    BLOOD_HIT_BUCKET,
    SHIELD_BLOCK_BUCKET,
    WEAPON_SKILL_BAGS,
    SKILL_KEYS,
    normalizeSkillKey,
    skillMultiplier,
    skillBase,
    getReqSkillTries,
    totalSkillTries,
    getReqMana,
    totalManaForMagicLevel,
    getExpForLevel,
    expToNext,
    levelFromExp,
    vocationKey,
    uniqueVocationCount,
    partyShareMultiplier,
    partySharePerMember,
    normalizeExpRates,
    applyPersonalExpRates,
    normalizeSkillSessionRates,
    applySkillTryRates,
    seedPlayerExperience,
    applyExpProgression,
    getPlayerSkillLevel,
    setPlayerSkillLevel,
    ensureSkillCounterBags,
    applySkillTries,
    applyManaTowardMagic,
    classifyAttackBlockType,
    resolveWeaponSkillBag,
    defenderHasShield,
    processAttackSkillProgression,
    skillLabel
};

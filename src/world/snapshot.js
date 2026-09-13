'use strict';

const { serializeInventory, isRuntimeInventory } = require('./inventory');

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function asInt(v, fallback) {
    if (v == null || v === '') return fallback;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? n : fallback;
}

function cloneItems(bag) {
    const out = [];
    if (!Array.isArray(bag)) return out;
    for (let i = 0; i < bag.length; i++) {
        const row = bag[i];
        if (!row) continue;
        const id = row.id != null ? String(row.id).trim() : '';
        if (!id) continue;
        const count = Math.max(1, asInt(row.count, 1));
        out.push({ id, count });
    }
    return out;
}

/** @deprecated flat-bag helper. Runtime uses inventory.normalizeInventory. */
function normalizeInventory(raw) {
    if (isRuntimeInventory(raw)) return raw;
    if (!raw) return [];
    if (Array.isArray(raw)) return cloneItems(raw);
    if (typeof raw === 'object' && Array.isArray(raw.items)) return cloneItems(raw.items);
    return [];
}

function cloneStorage(raw) {
    const out = Object.create(null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const keys = Object.keys(raw);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!KEY_RE.test(k)) continue;
        const v = raw[k];
        if (typeof v === 'number') {
            if (Number.isFinite(v)) out[k] = v;
            continue;
        }
        if (typeof v === 'boolean') {
            out[k] = v ? 1 : 0;
            continue;
        }
        if (typeof v === 'string') {
            const t = v.trim();
            if (!t) continue;
            if (t !== 'true' && t !== 'false' && Number.isFinite(Number(t))) {
                out[k] = Number(t);
            } else {
                out[k] = t;
            }
        }
    }
    return out;
}

const SKILL_KEYS = Object.freeze([
    'fist', 'club', 'sword', 'axe', 'distance', 'shielding', 'magic', 'fishing'
]);

function cloneSkills(raw) {
    const out = {
        fist: 10, club: 10, sword: 10, axe: 10,
        distance: 10, shielding: 10, magic: 0, fishing: 10
    };
    if (!raw || typeof raw !== 'object') return out;
    for (let i = 0; i < SKILL_KEYS.length; i++) {
        const k = SKILL_KEYS[i];
        if (raw[k] == null) continue;
        const n = asInt(raw[k], out[k]);
        out[k] = n < 0 ? 0 : n;
    }
    return out;
}

function tryKey(skill) {
    return skill + 'Tries';
}

function extractSkillTries(raw) {
    const progress = Object.create(null);
    let magicTries = 0;
    const src = raw && typeof raw === 'object' ? raw : {};
    for (let i = 0; i < SKILL_KEYS.length; i++) {
        const k = SKILL_KEYS[i];
        const n = Math.max(0, asInt(src[tryKey(k)], 0));
        if (k === 'magic') magicTries = n;
        else progress[k] = n;
    }
    return { progress, magicTries };
}

function attachSkillTries(skills, progress, manaToward) {
    const out = cloneSkills(skills);
    const bag = progress && typeof progress === 'object' ? progress : {};
    for (let i = 0; i < SKILL_KEYS.length; i++) {
        const k = SKILL_KEYS[i];
        if (k === 'magic') {
            out[tryKey(k)] = Math.max(0, asInt(manaToward, 0));
        } else {
            out[tryKey(k)] = Math.max(0, asInt(bag[k], 0));
        }
    }
    return out;
}

/**
 * Clone a persistable snapshot. Tick must not await SQL; callers clone first.
 * Downed sessions persist town spawn + full HP so reconnect is not dead.
 */
function snapshotSession(session, extra) {
    const downed = !!(session && session.downed);
    const spawn = extra && extra.spawn;
    const x = downed && spawn ? spawn.x : session.x;
    const y = downed && spawn ? spawn.y : session.y;
    const z = downed && spawn ? spawn.z : session.z;
    const hp = downed ? session.hpMax : session.hp;
    const snap = {
        level: session.level | 0,
        experience: Number(session.experience) || 0,
        posX: x | 0,
        posY: y | 0,
        posZ: z | 0,
        hp: hp | 0,
        hpMax: session.hpMax | 0,
        mp: session.mp | 0,
        mpMax: session.mpMax | 0,
        inventory: isRuntimeInventory(session.inventory)
            ? serializeInventory(session.inventory)
            : { items: cloneItems(session.inventory) },
        storage: cloneStorage(session.storage),
        conditions: [],
        hotkeys: {},
        appearance: {},
        skills: attachSkillTries(
            session.skills,
            session._skillTryProgress,
            session._manaTowardMagic
        )
    };
    if (extra && extra.lastLogout) snap.lastLogout = extra.lastLogout;
    return snap;
}

module.exports = {
    KEY_RE,
    SKILL_KEYS,
    cloneItems,
    normalizeInventory,
    cloneStorage,
    cloneSkills,
    extractSkillTries,
    attachSkillTries,
    snapshotSession
};

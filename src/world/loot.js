'use strict';

const MAX_LOOT_CHANCE = 100000;

function asInt(v, fallback) {
    if (v == null || v === '') return fallback;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? n : fallback;
}

function parseChance(raw) {
    const n = asInt(raw, 0);
    if (n <= 0) return 0;
    if (n >= MAX_LOOT_CHANCE) return MAX_LOOT_CHANCE;
    return n;
}

function randUnit(rng) {
    const n = typeof rng === 'function' ? rng() : Math.random();
    if (!Number.isFinite(n) || n < 0) return 0;
    if (n >= 1) return 0.999999;
    return n;
}

/**
 * Chance scale 1e5: drop if floor(rng()*100000) < chance.
 * maxCount ≥ 2 rolls a uniform count in [1, maxCount] on a successful drop.
 */
function rollLoot(rows, rng) {
    const out = [];
    if (!rows || !rows.length) return out;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;
        const id = row.id != null ? String(row.id).trim() : '';
        if (!id) continue;
        const chance = parseChance(row.chance);
        if (chance <= 0) continue;
        const roll = Math.floor(randUnit(rng) * MAX_LOOT_CHANCE);
        if (roll >= chance) continue;
        const maxCount = Math.max(1, asInt(row.maxCount, 1));
        let count = 1;
        if (maxCount > 1) {
            count = 1 + Math.floor(randUnit(rng) * maxCount);
            if (count > maxCount) count = maxCount;
        }
        out.push({ id, count, name: row.name != null ? String(row.name) : id });
    }
    return out;
}

function stackItem(bag, id, count) {
    const n = Math.max(1, asInt(count, 1));
    const key = String(id);
    for (let i = 0; i < bag.length; i++) {
        if (bag[i].id === key) {
            bag[i].count += n;
            return bag[i];
        }
    }
    const row = { id: key, count: n };
    bag.push(row);
    return row;
}

function countItem(bag, id) {
    if (!Array.isArray(bag) || id == null) return 0;
    const key = String(id);
    for (let i = 0; i < bag.length; i++) {
        if (bag[i] && bag[i].id === key) return bag[i].count | 0;
    }
    return 0;
}

function takeItem(bag, id, count) {
    const n = Math.max(1, asInt(count, 1));
    const key = String(id);
    if (!Array.isArray(bag)) return false;
    for (let i = 0; i < bag.length; i++) {
        if (!bag[i] || bag[i].id !== key) continue;
        if ((bag[i].count | 0) < n) return false;
        bag[i].count -= n;
        if (bag[i].count <= 0) bag.splice(i, 1);
        return true;
    }
    return false;
}

module.exports = {
    MAX_LOOT_CHANCE,
    parseChance,
    rollLoot,
    stackItem,
    countItem,
    takeItem
};

'use strict';

/**
 * Monster auto-summon kit (product port of engine normalizeSummonConfig /
 * tryMonsterSummons). Integer ticks. MUST NOT require kernel/.
 */

const SUMMON_SPAWN_MAX_R = 6;

function slugCreatureId(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
}

function titleFromId(id) {
    return String(id || '')
        .split('_')
        .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
        .join(' ');
}

/**
 * Normalize template `summon` block.
 * Accepts `{ maxSummons, summons: [{ id, name, chance, interval|intervalMs, count }] }`.
 * @param {object|null|undefined} raw
 * @returns {{ maxSummons: number, summons: object[] }|null}
 */
function normalizeSummonConfig(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const list = Array.isArray(raw.summons) ? raw.summons : [];
    if (!list.length) return null;
    const summons = [];
    for (let i = 0; i < list.length; i++) {
        const row = list[i];
        if (!row || typeof row !== 'object') continue;
        const id =
            row.id != null
                ? String(row.id).trim()
                : row.name != null
                    ? slugCreatureId(row.name)
                    : '';
        if (!id) continue;
        const intervalMsRaw =
            row.intervalMs != null
                ? Number(row.intervalMs)
                : row.interval != null
                    ? Number(row.interval)
                    : 2000;
        const intervalMs = Number.isFinite(intervalMsRaw) && intervalMsRaw > 0
            ? intervalMsRaw
            : 2000;
        summons.push({
            id,
            name: row.name != null ? String(row.name) : titleFromId(id),
            chance: Math.max(
                0,
                Math.min(100, row.chance != null ? Number(row.chance) : 100)
            ),
            intervalMs,
            count: Math.max(
                1,
                Math.round(row.count != null ? Number(row.count) || 1 : 1)
            ),
            force: !!row.force
        });
    }
    if (!summons.length) return null;
    const maxSummons =
        raw.maxSummons != null && Number.isFinite(Number(raw.maxSummons))
            ? Math.max(0, Math.round(Number(raw.maxSummons) || 0))
            : summons.reduce((acc, s) => acc + (Number(s.count) || 1), 0);
    if (!(maxSummons > 0)) return null;
    return { maxSummons, summons };
}

function isSummon(creature) {
    return !!(creature && creature.masterId != null && creature.masterId > 0);
}

function isCreatureLiving(ent) {
    return !!(ent && (ent.hp | 0) > 0 && !ent.downed && !ent.dead);
}

function summonMatchesEntry(ent, entry) {
    if (!ent || !entry) return false;
    if (ent.kind && (ent.kind === entry.id || ent.kind === entry.name)) return true;
    if (
        ent.name &&
        entry.name &&
        String(ent.name).toLowerCase() === String(entry.name).toLowerCase()
    ) {
        return true;
    }
    return false;
}

/**
 * Prune dead/missing ids from master.summonIds and return living summons.
 * @param {object} master
 * @param {(id: number) => object|null} resolve
 * @returns {object[]}
 */
function livingSummonsOf(master, resolve) {
    if (!master || !Array.isArray(master.summonIds) || !master.summonIds.length) {
        return [];
    }
    const living = [];
    const keep = [];
    for (let i = 0; i < master.summonIds.length; i++) {
        const id = master.summonIds[i];
        const ent = typeof resolve === 'function' ? resolve(id) : null;
        if (!isCreatureLiving(ent)) continue;
        living.push(ent);
        keep.push(id);
    }
    master.summonIds = keep;
    return living;
}

function ensureSummonRuntime(creature) {
    if (!creature) return;
    const n = creature.summon && Array.isArray(creature.summon.summons)
        ? creature.summon.summons.length
        : 0;
    if (!Array.isArray(creature._summonReadyTicks) || creature._summonReadyTicks.length !== n) {
        creature._summonReadyTicks = n ? new Array(n).fill(0) : [];
    }
    if (!Array.isArray(creature.summonIds)) creature.summonIds = [];
}

/**
 * Adjacent empty tile for a summon (skip master tile, spiral r ≤ 6).
 * Occupancy only — no push-on-spawn.
 * @param {object} tileMap
 * @param {number} ox
 * @param {number} oy
 * @param {number} z
 * @param {object} [probe]
 * @returns {{ x: number, y: number, z: number }|null}
 */
function findSummonSpawnTile(tileMap, ox, oy, z, probe) {
    if (!tileMap) return null;
    const x0 = ox | 0;
    const y0 = oy | 0;
    const z0 = z | 0;
    const body = probe || { type: 'creature', canPushCreatures: false };
    for (let r = 1; r <= SUMMON_SPAWN_MAX_R; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const cx = x0 + dx;
                const cy = y0 + dy;
                if (typeof tileMap.canEnter === 'function') {
                    if (!tileMap.canEnter(cx, cy, z0, body)) continue;
                } else if (typeof tileMap.isWalkable === 'function') {
                    if (!tileMap.isWalkable(cx, cy, z0)) continue;
                    if (typeof tileMap.getOccupant === 'function' && tileMap.getOccupant(cx, cy, z0)) {
                        continue;
                    }
                } else {
                    continue;
                }
                return { x: cx, y: cy, z: z0 };
            }
        }
    }
    return null;
}

module.exports = {
    SUMMON_SPAWN_MAX_R,
    normalizeSummonConfig,
    isSummon,
    isCreatureLiving,
    summonMatchesEntry,
    livingSummonsOf,
    ensureSummonRuntime,
    findSummonSpawnTile
};

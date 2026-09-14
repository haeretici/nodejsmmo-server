'use strict';

const { viewportWindow } = require('./static_map');

const DEFAULT_ACTIVATE_MARGIN = 8;
const DEFAULT_DESPAWN_IDLE_TICKS = 40;
const DEFAULT_MAX_LIVING = 3000;

function resolveSpawnMode(settings, overlay) {
    const raw = settings && settings.spawnMode;
    if (raw === 'eager' || raw === 'on_demand') return raw;
    return overlay ? 'eager' : 'on_demand';
}

function spawnActivateMargin(settings) {
    if (settings && settings.spawnActivateMargin != null) {
        return Math.max(0, settings.spawnActivateMargin | 0);
    }
    return DEFAULT_ACTIVATE_MARGIN;
}

function spawnDespawnIdleTicks(settings) {
    if (settings && settings.spawnDespawnIdleTicks != null) {
        return Math.max(0, settings.spawnDespawnIdleTicks | 0);
    }
    if (settings && settings.spawnDespawnIdleSec != null) {
        const ups = Math.max(1, (settings && settings.logicUps | 0) || 20);
        return Math.max(0, Math.round(Number(settings.spawnDespawnIdleSec) * ups));
    }
    return DEFAULT_DESPAWN_IDLE_TICKS;
}

function spawnMaxLiving(settings) {
    if (settings && settings.spawnMaxLiving != null) {
        return Math.max(0, settings.spawnMaxLiving | 0);
    }
    if (settings && settings.maxLiving != null) {
        return Math.max(0, settings.maxLiving | 0);
    }
    return DEFAULT_MAX_LIVING;
}

function pinKind(row) {
    if (!row) return '';
    if (row.kind != null && String(row.kind).trim() !== '') return String(row.kind);
    if (row.creatureId != null) return String(row.creatureId);
    return '';
}

function pinSkipReason(template, dialogDb) {
    if (!template) return 'unknown';
    if (template.isNpc) {
        if (template.dialog) return null;
        if (template.dialogId && dialogDb && dialogDb[template.dialogId]) return null;
        return 'npc';
    }
    return null;
}

function respawnDelayTicks(pin, settings) {
    if (!pin || pin.respawn == null) {
        return Math.max(1, (settings && settings.creatureRespawnTicks | 0) || 200);
    }
    const sec = pin.respawn | 0;
    if (sec <= 0) return 0;
    const ups = Math.max(1, (settings && settings.logicUps | 0) || 20);
    return Math.max(1, Math.round(sec * ups));
}

function inSpawnAoi(map, observerX, observerY, observerZ, x, y, z, margin) {
    if ((z | 0) !== (observerZ | 0)) return false;
    const win = viewportWindow(map, observerX, observerY, null, null, observerZ);
    const m = margin | 0;
    const ix = x | 0;
    const iy = y | 0;
    return ix >= win.originX - m
        && iy >= win.originY - m
        && ix < win.originX + win.width + m
        && iy < win.originY + win.height + m;
}

function makePinState(row, index, eager) {
    return {
        index: index | 0,
        kind: pinKind(row),
        creatureId: row && row.creatureId != null ? String(row.creatureId) : undefined,
        x: row ? row.x | 0 : 0,
        y: row ? row.y | 0 : 0,
        z: row && row.z != null ? row.z | 0 : 0,
        respawn: row && row.respawn != null ? row.respawn | 0 : null,
        eager: !!(eager || (row && row.eager)),
        state: 'idle',
        entityId: 0,
        readyTick: 0,
        idleTicks: 0,
        skipReason: null,
        rarity: row && row.rarity ? String(row.rarity) : undefined
    };
}

function minChebyshevToObservers(x, y, z, observers) {
    if (!observers || !observers.length) return Infinity;
    let minD = Infinity;
    for (let i = 0; i < observers.length; i++) {
        const o = observers[i];
        if (!o || o.dead || o.downed) continue;
        if ((o.z | 0) !== (z | 0)) continue;
        const dx = Math.abs((x | 0) - (o.x | 0));
        const dy = Math.abs((y | 0) - (o.y | 0));
        const d = dx > dy ? dx : dy;
        if (d < minD) minD = d;
    }
    return minD;
}

function livingPinKeepPriority(pin, creature, observers, template) {
    if (!pin) return 0;
    if (pin.eager) return 1e12;
    if (creature && ((creature.hp | 0) <= 0)) return -1;
    if (creature && (creature.targetId || creature.dialog || creature.shop)) {
        return 1e12;
    }
    let p = 0;
    const rarity = (pin.rarity || (template && template.rarity) || (creature && creature.flags && creature.flags.rarity)) || '';
    if (rarity === 'boss') p += 10000;
    else if (rarity === 'elite') p += 5000;
    else if (rarity === 'champion') p += 2000;
    else if (rarity === 'rare') p += 500;

    const posX = creature ? creature.x : pin.x;
    const posY = creature ? creature.y : pin.y;
    const posZ = creature ? creature.z : pin.z;

    if (observers && observers.length) {
        let minD = Infinity;
        let nearCount = 0;
        for (let i = 0; i < observers.length; i++) {
            const o = observers[i];
            if (!o || o.dead || o.downed) continue;
            if ((o.z | 0) !== (posZ | 0)) continue;
            const dx = Math.abs((posX | 0) - (o.x | 0));
            const dy = Math.abs((posY | 0) - (o.y | 0));
            const d = dx > dy ? dx : dy;
            if (d < minD) minD = d;
            if (d <= 20) nearCount += 1;
        }
        if (Number.isFinite(minD)) {
            p += Math.max(0, 2000 - minD * 20);
            p += nearCount * 50;
        }
    }
    return p;
}

module.exports = {
    DEFAULT_ACTIVATE_MARGIN,
    DEFAULT_DESPAWN_IDLE_TICKS,
    DEFAULT_MAX_LIVING,
    resolveSpawnMode,
    spawnActivateMargin,
    spawnDespawnIdleTicks,
    spawnMaxLiving,
    pinKind,
    pinSkipReason,
    respawnDelayTicks,
    inSpawnAoi,
    makePinState,
    minChebyshevToObservers,
    livingPinKeepPriority
};

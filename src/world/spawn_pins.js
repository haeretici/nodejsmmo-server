'use strict';

const { viewportWindow } = require('./static_map');

const DEFAULT_ACTIVATE_MARGIN = 8;
const DEFAULT_DESPAWN_IDLE_TICKS = 40;

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
    return DEFAULT_DESPAWN_IDLE_TICKS;
}

function pinKind(row) {
    if (!row) return '';
    if (row.kind != null && String(row.kind).trim() !== '') return String(row.kind);
    if (row.creatureId != null) return String(row.creatureId);
    return '';
}

function pinSkipReason(template) {
    if (!template) return 'unknown';
    if (template.isNpc && !template.dialog) return 'npc';
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
        eager: !!eager,
        state: 'idle',
        entityId: 0,
        readyTick: 0,
        idleTicks: 0,
        skipReason: null
    };
}

module.exports = {
    DEFAULT_ACTIVATE_MARGIN,
    DEFAULT_DESPAWN_IDLE_TICKS,
    resolveSpawnMode,
    spawnActivateMargin,
    spawnDespawnIdleTicks,
    pinKind,
    pinSkipReason,
    respawnDelayTicks,
    inSpawnAoi,
    makePinState
};

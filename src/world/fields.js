'use strict';

/** Product port of HuntDL elemental fields. RAM registry, no ground-item stack. */

const { applyMitigation } = require('./combat');
const {
    applyCondition,
    FIELD_BURNING,
    FIELD_POISONED,
    isCombatantAlive
} = require('./conditions');

const FRICTION_BLOCKED = 255;

const FIELD_KINDS = {
    FIRE: 'fire',
    POISON: 'poison',
    ENERGY: 'energy',
    BARRIER: 'barrier',
    VINE: 'vine'
};

const FIELD_SOURCES = {
    PLAYER: 'player',
    CREATURE: 'creature',
    SCENARIO: 'scenario'
};

const FIELD_MASKS = {
    FIRE: 1,
    POISON: 2,
    ENERGY: 4,
    PLAYER: 8,
    OBSTACLE: 16
};

const FIELD_DURATIONS_SEC = {
    fire: { stage1: 200, stage2: 348, total: 446 },
    poison: { active: 248, total: 248 },
    energy: { active: 98, total: 98 },
    barrier: { total: 20 },
    vine: { total: 30 }
};

const ACTIVE_FIELD_MAX_DURATION_SEC = 24 * 3600;
const MAP_FIELD_DEFAULT_TTL_SEC = 7 * 24 * 3600;

function tileKey(x, y, z) {
    return `${z | 0}:${x | 0}:${y | 0}`;
}

function parseTileKey(key) {
    if (!key || typeof key !== 'string') return null;
    const parts = key.split(':');
    if (parts.length < 3) return null;
    const z = Number(parts[0]);
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, z: Number.isFinite(z) ? z : parts[0] };
}

function isObstacleFieldKind(kind) {
    return kind === 'barrier' || kind === 'vine';
}

function getFieldKind(input) {
    if (input == null) return null;
    if (typeof input === 'string') {
        const str = input.toLowerCase().trim();
        if (str === 'fire' || str === 'fire_field' || str.startsWith('firefield')) return 'fire';
        if (
            str === 'poison' || str === 'poison_field' || str.startsWith('poisonfield')
            || str.startsWith('earthfield') || str === 'earth'
        ) {
            return 'poison';
        }
        if (str === 'energy' || str === 'energy_field' || str.startsWith('energyfield')) return 'energy';
        if (
            str === 'barrier' || str === 'barrier_wall' || str === 'barrier_field'
            || str === 'magic_wall' || str === 'magicwall' || str.startsWith('magicwall')
        ) {
            return 'barrier';
        }
        if (
            str === 'vine' || str === 'vine_barrier' || str === 'vine_field'
            || str === 'wild_growth' || str === 'wildgrowth' || str.startsWith('wildgrowth')
        ) {
            return 'vine';
        }
        return null;
    }
    if (typeof input === 'object') {
        if (input.fieldKind) return getFieldKind(String(input.fieldKind));
        if (input.field != null) return getFieldKind(input.field);
        if (input.deploysField != null) return getFieldKind(input.deploysField);
        return getFieldKind(String(input.itemId || input.id || input.name || ''));
    }
    return null;
}

function fieldKindFromMask(mask) {
    const m = mask & 0xff;
    if ((m & FIELD_MASKS.FIRE) !== 0) return FIELD_KINDS.FIRE;
    if ((m & FIELD_MASKS.POISON) !== 0) return FIELD_KINDS.POISON;
    if ((m & FIELD_MASKS.ENERGY) !== 0) return FIELD_KINDS.ENERGY;
    if ((m & FIELD_MASKS.OBSTACLE) !== 0) return FIELD_KINDS.BARRIER;
    return null;
}

function defaultDurationSec(kind) {
    const d = FIELD_DURATIONS_SEC[kind];
    return d && d.total != null ? Number(d.total) : 0;
}

function isPlayerEntity(entity) {
    if (!entity) return false;
    return entity.type === 'player' || entity.isPlayer === true;
}

function isEntityImmuneToField(entity, fieldSource) {
    if (!entity) return true;
    const src = fieldSource || FIELD_SOURCES.SCENARIO;
    if (src === FIELD_SOURCES.PLAYER && isPlayerEntity(entity)) return true;
    return false;
}

function fieldExpireAt(field) {
    if (!field) return 0;
    if (field.expireAt != null && Number.isFinite(Number(field.expireAt))) {
        return Number(field.expireAt);
    }
    const createdAt = field.createdAt != null ? Number(field.createdAt) : 0;
    const dur = field.durationSec != null && Number.isFinite(Number(field.durationSec))
        ? Number(field.durationSec)
        : defaultDurationSec(field.fieldKind || getFieldKind(field) || 'fire');
    return createdAt + dur;
}

function getFieldState(field, currentTime) {
    if (!field) {
        return { expired: true, active: false, stage: 0, kind: null, elapsed: 0, duration: 0 };
    }
    const kind = field.fieldKind || getFieldKind(field) || 'fire';
    const now = currentTime != null ? Number(currentTime) : 0;
    const createdAt = field.createdAt != null ? Number(field.createdAt) : 0;
    const elapsed = Math.max(0, now - createdAt);
    const expireAt = fieldExpireAt(field);
    const duration = Math.max(0, expireAt - createdAt);
    if (now >= expireAt || (duration > 0 && elapsed >= duration)) {
        return { expired: true, active: false, stage: 0, kind, elapsed, duration };
    }
    const usesDefaultFireStages =
        kind === 'fire' &&
        field.durationSec == null &&
        (field.expireAt == null
            || Math.abs(Number(field.expireAt) - (createdAt + FIELD_DURATIONS_SEC.fire.total)) < 1e-6);
    if (kind === 'fire' && usesDefaultFireStages) {
        const dur = FIELD_DURATIONS_SEC.fire;
        if (elapsed < dur.stage1) {
            return { expired: false, active: true, stage: 1, kind, elapsed, duration: dur.total };
        }
        if (elapsed < dur.stage2) {
            return { expired: false, active: true, stage: 2, kind, elapsed, duration: dur.total };
        }
        return { expired: false, active: false, stage: 3, kind, elapsed, duration: dur.total };
    }
    return { expired: false, active: true, stage: 1, kind, elapsed, duration };
}

function createFieldStore(tileMap) {
    return {
        tileMap: tileMap || null,
        byKey: Object.create(null),
        heap: [],
        gen: 0
    };
}

function heapPush(heap, node) {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p].expireAt <= heap[i].expireAt) break;
        const t = heap[p];
        heap[p] = heap[i];
        heap[i] = t;
        i = p;
    }
}

function heapPop(heap) {
    if (!heap.length) return null;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
        heap[0] = last;
        let i = 0;
        for (;;) {
            const l = i * 2 + 1;
            const r = l + 1;
            let smallest = i;
            if (l < heap.length && heap[l].expireAt < heap[smallest].expireAt) smallest = l;
            if (r < heap.length && heap[r].expireAt < heap[smallest].expireAt) smallest = r;
            if (smallest === i) break;
            const t = heap[i];
            heap[i] = heap[smallest];
            heap[smallest] = t;
            i = smallest;
        }
    }
    return top;
}

function unregisterActiveField(store, key) {
    if (!store || !store.byKey) return;
    const slot = store.byKey[key];
    if (slot) slot.gen = -1;
}

function registerActiveField(store, key, field) {
    if (!store || !field) return;
    const duration = field.durationSec != null && Number.isFinite(Number(field.durationSec))
        ? Number(field.durationSec)
        : fieldExpireAt(field) - (field.createdAt != null ? Number(field.createdAt) : 0);
    if (!(duration > 0) || duration > ACTIVE_FIELD_MAX_DURATION_SEC) {
        unregisterActiveField(store, key);
        return;
    }
    store.gen += 1;
    const gen = store.gen;
    const expireAt = fieldExpireAt(field);
    const prev = store.byKey[key] && store.byKey[key].field;
    store.byKey[key] = {
        expireAt,
        kind: field.fieldKind || getFieldKind(field) || 'fire',
        gen,
        field: field || prev || null
    };
    heapPush(store.heap, { expireAt, tileKey: key, gen });
}

function getFieldOnTile(store, x, y, z) {
    if (!store || !store.byKey) return null;
    const key = tileKey(Math.round(x), Math.round(y), z != null ? z : 0);
    return store.byKey[key] && store.byKey[key].field ? store.byKey[key].field : null;
}

function syncTileMapFieldMask(store, x, y, z) {
    if (!store || !store.tileMap || typeof store.tileMap.setTileFieldMask !== 'function') return;
    const tz = z != null ? z : 0;
    const field = getFieldOnTile(store, x, y, tz);
    let mask = 0;
    if (field && !getFieldState(field).expired) {
        const kind = field.fieldKind || getFieldKind(field);
        if (kind === 'fire') mask |= FIELD_MASKS.FIRE;
        else if (kind === 'poison') mask |= FIELD_MASKS.POISON;
        else if (kind === 'energy') mask |= FIELD_MASKS.ENERGY;
        else if (isObstacleFieldKind(kind)) mask |= FIELD_MASKS.OBSTACLE;
        if (field.source === FIELD_SOURCES.PLAYER) mask |= FIELD_MASKS.PLAYER;
    }
    store.tileMap.setTileFieldMask(x, y, tz, mask);
}

function syncObstacleFriction(store, x, y, z, field, mode) {
    if (!field || !isObstacleFieldKind(field.fieldKind)) return;
    const tileMap = store && store.tileMap;
    if (!tileMap || typeof tileMap.getLayer !== 'function') return;
    const layer = tileMap.getLayer(z);
    if (!layer || !layer.friction) return;
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) return;
    const idx = typeof tileMap.index === 'function'
        ? tileMap.index(ix, iy, layer.cols)
        : iy * layer.cols + ix;
    if (!layer.sight || layer.sight.length < layer.friction.length) {
        const sight = new Uint8Array(layer.friction.length);
        for (let i = 0; i < layer.friction.length; i++) {
            if (layer.friction[i] === FRICTION_BLOCKED) sight[i] = 255;
        }
        layer.sight = sight;
    }
    if (mode === 'block') {
        if (field.savedFriction == null) field.savedFriction = layer.friction[idx];
        if (field.savedSight == null) field.savedSight = layer.sight[idx];
        layer.friction[idx] = FRICTION_BLOCKED;
        layer.sight[idx] = 255;
    } else if (mode === 'restore') {
        if (field.savedFriction != null && Number.isFinite(Number(field.savedFriction))) {
            if (layer.friction[idx] === FRICTION_BLOCKED) {
                layer.friction[idx] = Number(field.savedFriction) & 0xff;
            }
        }
        if (field.savedSight != null && Number.isFinite(Number(field.savedSight))) {
            if (layer.sight[idx] === 255) {
                layer.sight[idx] = Number(field.savedSight) & 0xff;
            }
        }
        field.savedFriction = null;
        field.savedSight = null;
    }
}

function removeFieldFromTile(store, x, y, z) {
    if (!store || !store.byKey) return false;
    const tz = z != null ? z : 0;
    const tx = Math.round(x);
    const ty = Math.round(y);
    const key = tileKey(tx, ty, tz);
    const slot = store.byKey[key];
    const field = slot && slot.field;
    if (!field) return false;
    syncObstacleFriction(store, tx, ty, tz, field, 'restore');
    delete store.byKey[key];
    syncTileMapFieldMask(store, tx, ty, tz);
    return true;
}

function deployFieldToTile(store, x, y, z, opts) {
    const o = opts || {};
    const kind = getFieldKind(o.kind || o.fieldKind || o.field) || null;
    if (!kind) return null;
    const tz = z != null ? z : 0;
    const tx = Math.round(x);
    const ty = Math.round(y);
    const key = tileKey(tx, ty, tz);
    const createdAt = o.createdAt != null ? Number(o.createdAt) : 0;
    const createdTick = o.createdTick != null
        ? (o.createdTick >>> 0)
        : (Number.isFinite(createdAt) && createdAt > 0 ? Math.round(createdAt * 20) >>> 0 : 0);
    const durationSec = o.durationSec != null && Number.isFinite(Number(o.durationSec))
        ? Number(o.durationSec)
        : defaultDurationSec(kind);
    const prev = getFieldOnTile(store, tx, ty, tz);
    if (prev) removeFieldFromTile(store, tx, ty, tz);
    const field = {
        fieldKind: kind,
        kind,
        source: o.source || FIELD_SOURCES.SCENARIO,
        createdAt,
        createdTick,
        durationSec,
        expireAt: createdAt + durationSec,
        x: tx,
        y: ty,
        z: tz,
        isObstacle: isObstacleFieldKind(kind)
    };
    store.byKey[key] = { field, expireAt: field.expireAt, kind, gen: 0 };
    if (field.isObstacle) syncObstacleFriction(store, tx, ty, tz, field, 'block');
    registerActiveField(store, key, field);
    if (store.byKey[key]) store.byKey[key].field = field;
    syncTileMapFieldMask(store, tx, ty, tz);
    return field;
}

function inflictFieldDamage(entity, amount, element) {
    if (!isCombatantAlive(entity)) return 0;
    const mit = applyMitigation(amount, element, entity);
    return mit.final;
}

function applyFieldEntryEffects(entity, field, currentTime) {
    if (!isCombatantAlive(entity) || !field) return { applied: false, damage: 0 };
    if (isEntityImmuneToField(entity, field.source)) {
        return { applied: false, immunity: true, damage: 0 };
    }
    const state = getFieldState(field, currentTime);
    if (!state.active || state.expired) return { applied: false, active: false, damage: 0 };
    if (isObstacleFieldKind(state.kind)) {
        return { applied: false, kind: state.kind, damage: 0, reason: 'obstacle' };
    }
    let damage = 0;
    let conditionName = null;
    let element = 'physical';
    if (state.kind === 'fire') {
        element = 'fire';
        damage = inflictFieldDamage(entity, 20, 'fire');
        if (isCombatantAlive(entity)) {
            applyCondition(entity, FIELD_BURNING, {
                source: field.source || 'scenario',
                forceOverride: true
            });
            conditionName = 'fire';
        }
    } else if (state.kind === 'poison') {
        element = 'earth';
        damage = inflictFieldDamage(entity, 5, 'earth');
        if (isCombatantAlive(entity)) {
            applyCondition(entity, FIELD_POISONED, {
                source: field.source || 'scenario',
                forceOverride: true
            });
            conditionName = 'poison';
        }
    } else if (state.kind === 'energy') {
        element = 'energy';
        damage = inflictFieldDamage(entity, 30, 'energy');
    }
    return { applied: true, kind: state.kind, element, damage, condition: conditionName };
}

function applyEnergyFieldExitEffect(entity, prevField, nextField, currentTime) {
    if (!isCombatantAlive(entity) || !prevField) return { applied: false, damage: 0 };
    if (isEntityImmuneToField(entity, prevField.source)) {
        return { applied: false, immunity: true, damage: 0 };
    }
    const state = getFieldState(prevField, currentTime);
    const kind = state.kind || prevField.fieldKind || getFieldKind(prevField);
    if (kind !== 'energy') return { applied: false, reason: 'not_energy', damage: 0 };
    if (nextField) {
        const nextState = getFieldState(nextField, currentTime);
        if (!nextState.expired && nextState.kind === 'energy'
            && !isEntityImmuneToField(entity, nextField.source)) {
            return { applied: false, reason: 'moved_to_energy_field', damage: 0 };
        }
    }
    const damage = inflictFieldDamage(entity, 25, 'energy');
    return { applied: true, element: 'energy', damage };
}

function occupantsOn(store, x, y, z) {
    const tileMap = store && store.tileMap;
    if (!tileMap || typeof tileMap.getCombatantEntities !== 'function') return [];
    return tileMap.getCombatantEntities(x, y, z) || [];
}

function checkAndCleanExpiredTileFields(store, x, y, z, currentTime, occupantEntities) {
    const field = getFieldOnTile(store, x, y, z);
    if (!field) return false;
    const now = currentTime != null ? Number(currentTime) : 0;
    const state = getFieldState(field, now);
    if (!state.expired) return false;
    if (state.kind === 'energy' && Array.isArray(occupantEntities)) {
        for (let i = 0; i < occupantEntities.length; i++) {
            const ent = occupantEntities[i];
            if (isCombatantAlive(ent) && !isEntityImmuneToField(ent, field.source)) {
                applyEnergyFieldExitEffect(ent, field, null, now);
            }
        }
    }
    removeFieldFromTile(store, x, y, z);
    return true;
}

function onEntityTileTransition(entity, prevTile, nextTile, store, currentTime) {
    if (!entity || !store || (!prevTile && !nextTile)) return [];
    const now = currentTime != null ? Number(currentTime) : 0;
    const pz = prevTile && prevTile.z != null ? prevTile.z : 0;
    const nz = nextTile && nextTile.z != null ? nextTile.z : 0;
    let prevField = prevTile ? getFieldOnTile(store, prevTile.x, prevTile.y, pz) : null;
    let nextField = nextTile ? getFieldOnTile(store, nextTile.x, nextTile.y, nz) : null;
    const events = [];
    if (prevField && getFieldState(prevField, now).expired) {
        checkAndCleanExpiredTileFields(store, prevTile.x, prevTile.y, pz, now, [entity]);
        prevField = null;
    }
    if (nextField && getFieldState(nextField, now).expired) {
        removeFieldFromTile(store, nextTile.x, nextTile.y, nz);
        nextField = null;
    }
    const activePrev = prevField && !getFieldState(prevField, now).expired ? prevField : null;
    const activeNext = nextField && !getFieldState(nextField, now).expired ? nextField : null;
    const moved = !prevTile || !nextTile
        || Math.round(prevTile.x) !== Math.round(nextTile.x)
        || Math.round(prevTile.y) !== Math.round(nextTile.y)
        || String(pz) !== String(nz);
    if (activePrev && moved) {
        const exit = applyEnergyFieldExitEffect(entity, activePrev, activeNext, now);
        if (exit.applied) events.push({ type: 'exit', result: exit, field: activePrev });
    }
    if (activeNext && moved && isCombatantAlive(entity)) {
        const entry = applyFieldEntryEffects(entity, activeNext, now);
        if (entry.applied) events.push({ type: 'entry', result: entry, field: activeNext });
    }
    return events;
}

function deployFieldAndTriggerOccupants(store, x, y, z, fieldOpts, occupantEntities, now) {
    const field = deployFieldToTile(store, x, y, z, fieldOpts);
    if (!field) return { field: null, hits: [] };
    const occupants = occupantEntities || occupantsOn(store, x, y, z);
    const hits = [];
    for (let i = 0; i < occupants.length; i++) {
        const ent = occupants[i];
        if (!isCombatantAlive(ent)) continue;
        const r = applyFieldEntryEffects(ent, field, now);
        if (r.applied) hits.push({ entity: ent, result: r });
    }
    return { field, hits };
}

function purgeExpiredFields(store, currentTime, getOccupants) {
    if (!store || !store.heap) return [];
    const now = currentTime != null ? Number(currentTime) : 0;
    const gone = [];
    while (store.heap.length) {
        const peek = store.heap[0];
        if (!peek || peek.expireAt > now) break;
        const node = heapPop(store.heap);
        if (!node) break;
        const meta = store.byKey[node.tileKey];
        if (!meta || meta.gen !== node.gen) continue;
        const parsed = parseTileKey(node.tileKey);
        if (!parsed) {
            delete store.byKey[node.tileKey];
            continue;
        }
        const occupants = typeof getOccupants === 'function'
            ? getOccupants(parsed.x, parsed.y, parsed.z) || []
            : occupantsOn(store, parsed.x, parsed.y, parsed.z);
        const field = meta.field || null;
        if (checkAndCleanExpiredTileFields(store, parsed.x, parsed.y, parsed.z, now, occupants)) {
            gone.push({ x: parsed.x, y: parsed.y, z: parsed.z, field });
        } else {
            unregisterActiveField(store, node.tileKey);
        }
    }
    return gone;
}

function seedFloorFields(store, layer, z, opts) {
    if (!store || !layer || !layer.fields) return 0;
    const o = opts || {};
    const durationSec = o.durationSec != null && Number.isFinite(Number(o.durationSec))
        ? Math.max(0, Number(o.durationSec))
        : MAP_FIELD_DEFAULT_TTL_SEC;
    const source = o.source || FIELD_SOURCES.SCENARIO;
    const createdAt = o.createdAt != null ? Number(o.createdAt) : 0;
    let deployed = 0;
    const cols = layer.cols | 0;
    const rows = layer.rows | 0;
    const fields = layer.fields;
    const n = Math.min(fields.length | 0, cols * rows);
    const zVal = z != null ? z : (layer.z != null ? layer.z : 0);
    for (let i = 0; i < n; i++) {
        const mask = fields[i] & 0xff;
        if (!mask) continue;
        const kind = fieldKindFromMask(mask);
        if (!kind) continue;
        const x = i % cols;
        const y = (i / cols) | 0;
        const item = deployFieldToTile(store, x, y, zVal, {
            kind,
            source,
            durationSec,
            createdAt
        });
        if (item) deployed += 1;
    }
    return deployed;
}

function removeFieldsForFloor(store, z) {
    if (!store || !store.byKey) return 0;
    const zInt = z | 0;
    let removed = 0;
    for (const key of Object.keys(store.byKey)) {
        const parsed = parseTileKey(key);
        if (parsed && (parsed.z | 0) === zInt) {
            delete store.byKey[key];
            removed++;
        }
    }
    return removed;
}

function seedMapFieldsFromTileMap(store, tileMap, opts) {
    if (!store || !tileMap || !tileMap.layers) return 0;
    if (!store.tileMap) store.tileMap = tileMap;
    let deployed = 0;
    const zKeys = Object.keys(tileMap.layers);
    for (let zi = 0; zi < zKeys.length; zi++) {
        const zKey = zKeys[zi];
        const layer = tileMap.layers[zKey];
        if (!layer || !layer.fields) continue;
        deployed += seedFloorFields(store, layer, zKey, opts);
    }
    return deployed;
}

function listFieldsInRect(store, originX, originY, z, w, h) {
    const out = [];
    if (!store || !store.byKey) return out;
    const x0 = originX | 0;
    const y0 = originY | 0;
    const width = w | 0;
    const height = h | 0;
    const zInt = z | 0;

    if (width <= 0 || height <= 0) return out;

    const tileMap = store.tileMap;
    const layer = tileMap
        ? (typeof tileMap.getLayer === 'function'
            ? (tileMap.getLayer(zInt) || tileMap.getLayer(z))
            : (tileMap.layers && (tileMap.layers[String(zInt)] || tileMap.layers[String(z)] || tileMap.layers[z])))
        : null;

    // Phase 6.2: Direct 2D window reading from layer typed array (layer.fields).
    // Avoids O(N_world_fields) Object.keys(store.byKey) scans and empty tile string allocations.
    if (layer && layer.fields && layer.cols > 0 && layer.rows > 0) {
        const cols = layer.cols | 0;
        const rows = layer.rows | 0;
        const fields = layer.fields;

        const startX = Math.max(0, x0);
        const endX = Math.min(cols, x0 + width);
        const startY = Math.max(0, y0);
        const endY = Math.min(rows, y0 + height);

        if (startX >= endX || startY >= endY) return out;

        for (let curY = startY; curY < endY; curY++) {
            const rowOffset = curY * cols;
            for (let curX = startX; curX < endX; curX++) {
                if ((fields[rowOffset + curX] & 0xff) === 0) continue;
                const slot = store.byKey[tileKey(curX, curY, zInt)];
                if (slot && slot.field) {
                    out.push(slot.field);
                }
            }
        }
        return out;
    }

    // Fallback when tileMap / layer.fields is not attached (e.g. standalone test stores)
    const tileCount = width * height;
    if (tileCount <= 4096) {
        for (let dy = 0; dy < height; dy++) {
            const curY = y0 + dy;
            for (let dx = 0; dx < width; dx++) {
                const curX = x0 + dx;
                const slot = store.byKey[tileKey(curX, curY, zInt)];
                if (slot && slot.field) {
                    out.push(slot.field);
                }
            }
        }
        return out;
    }

    const x1 = x0 + width;
    const y1 = y0 + height;
    for (const key in store.byKey) {
        const slot = store.byKey[key];
        const f = slot && slot.field;
        if (!f) continue;
        if ((f.z | 0) !== zInt) continue;
        if (f.x < x0 || f.y < y0 || f.x >= x1 || f.y >= y1) continue;
        out.push(f);
    }
    return out;
}

module.exports = {
    FIELD_KINDS,
    FIELD_SOURCES,
    FIELD_MASKS,
    FIELD_DURATIONS_SEC,
    ACTIVE_FIELD_MAX_DURATION_SEC,
    MAP_FIELD_DEFAULT_TTL_SEC,
    tileKey,
    getFieldKind,
    fieldKindFromMask,
    isObstacleFieldKind,
    isPlayerEntity,
    isEntityImmuneToField,
    getFieldState,
    fieldExpireAt,
    createFieldStore,
    getFieldOnTile,
    deployFieldToTile,
    removeFieldFromTile,
    applyFieldEntryEffects,
    applyEnergyFieldExitEffect,
    onEntityTileTransition,
    deployFieldAndTriggerOccupants,
    purgeExpiredFields,
    seedMapFieldsFromTileMap,
    seedFloorFields,
    removeFieldsForFloor,
    listFieldsInRect
};

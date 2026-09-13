'use strict';

const { FRICTION_BLOCKED } = require('./tilemap');

const WORLD_PIN_ID_BASE = 3000000000;
const DEFAULT_CONTAINER_CAPACITY = 20;
const MAX_ITEM_NEST = 8;
const DEFAULT_LEVER_STATES = Object.freeze(['off', 'on']);
const WORLD_KINDS = Object.freeze([
    'container', 'chest', 'lever', 'door', 'teleport', 'switch', 'trap', 'harvest'
]);
const WORLD_USE_KINDS = Object.freeze([
    'chest', 'lever', 'switch', 'door', 'teleport', 'harvest'
]);
const TRAP_FIELD_KINDS = Object.freeze(['fire', 'poison', 'energy', 'barrier', 'vine']);
const STORAGE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const CANNOT_TEXT = 'You cannot use this object.';
const DEFAULT_CHEST_EMPTY_TEXT = 'The chest is empty.';
const DEFAULT_HARVEST_EMPTY_TEXT = 'You find nothing.';
const STUB_TEXT = 'Not available yet.';

function finiteInt(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
}

function slugifyWorldId(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
}

function normalizeWorldKind(raw) {
    const k = String(raw || '').trim().toLowerCase();
    if (!k) return 'container';
    if (WORLD_KINDS.indexOf(k) >= 0) return k;
    const slug = slugifyWorldId(k);
    if (!slug) return 'container';
    if (WORLD_KINDS.indexOf(slug) >= 0) return slug;
    return slug;
}

function normalizeCatalogKind(raw) {
    const k = String(raw || '').trim().toLowerCase();
    return k === 'equipment' ? 'equipment' : 'objects';
}

function kindDefaults(kind) {
    const k = normalizeWorldKind(kind);
    if (k === 'container') return { blocking: false, pickupable: true, shared: true };
    if (k === 'chest') return { blocking: true, pickupable: false, shared: false };
    if (k === 'door') return { blocking: true, pickupable: false, shared: true };
    if (k === 'trap' || k === 'harvest') {
        return { blocking: false, pickupable: false, shared: true };
    }
    return { blocking: false, pickupable: false, shared: true };
}

function worldPinUseReady(kind) {
    return WORLD_USE_KINDS.indexOf(String(kind || '')) >= 0;
}

function worldPinTileKey(x, y, z) {
    return `${x | 0},${y | 0},${z | 0}`;
}

function clampChannelByte(v) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return null;
    if (n < 0) return 0;
    if (n > 255) return 255;
    return n;
}

function normalizeWorldItem(raw, depth) {
    const d = depth | 0;
    if (d > MAX_ITEM_NEST) return null;
    if (!raw || typeof raw !== 'object') return null;
    const item = String(raw.item || raw.id || raw.itemId || '').trim();
    if (!item) return null;
    let count = 1;
    if (raw.count != null) {
        const n = Math.floor(Number(raw.count));
        if (!Number.isFinite(n) || n < 1) return null;
        count = n;
    }
    const row = { item, count };
    if (Array.isArray(raw.items) && raw.items.length) {
        const nested = [];
        for (let i = 0; i < raw.items.length; i++) {
            const child = normalizeWorldItem(raw.items[i], d + 1);
            if (child) nested.push(child);
        }
        if (nested.length) row.items = nested;
    }
    return row;
}

function normalizeWorldItems(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const row = normalizeWorldItem(raw[i], 0);
        if (row) out.push(row);
    }
    return out;
}

function flattenWorldItems(items) {
    const out = [];
    const list = Array.isArray(items) ? items : [];
    for (let i = 0; i < list.length; i++) {
        const row = list[i];
        if (!row || !row.item) continue;
        out.push({ id: String(row.item), count: Math.max(1, row.count | 0) });
    }
    return out;
}

function normalizeWhenClause(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw.item != null
        ? String(raw.item).trim()
        : raw.itemId != null ? String(raw.itemId).trim() : '';
    const clause = {};
    if (item) {
        clause.item = item;
    } else {
        const storage = raw.storage != null
            ? String(raw.storage).trim()
            : raw.key != null ? String(raw.key).trim() : '';
        if (!storage || !STORAGE_KEY_RE.test(storage)) return null;
        clause.storage = storage;
    }
    if (raw.eq !== undefined) clause.eq = raw.eq;
    else if (raw.equals !== undefined) clause.eq = raw.equals;
    if (raw.neq !== undefined) clause.neq = raw.neq;
    if (raw.min !== undefined) clause.min = raw.min;
    if (raw.max !== undefined) clause.max = raw.max;
    return clause;
}

function defaultOnceEq(clause) {
    if (!clause || clause.item) return;
    if (
        clause.eq === undefined
        && clause.neq === undefined
        && clause.min === undefined
        && clause.max === undefined
    ) {
        clause.eq = 0;
    }
}

function normalizeChestOnce(raw) {
    if (raw == null || raw === false || raw === true) return null;
    if (typeof raw === 'string' || typeof raw === 'number') {
        const storage = String(raw).trim();
        if (!storage || !STORAGE_KEY_RE.test(storage)) return null;
        return { storage, eq: 0 };
    }
    if (Array.isArray(raw)) {
        const out = [];
        for (let i = 0; i < raw.length; i++) {
            const clause = normalizeWhenClause(raw[i]);
            if (!clause) continue;
            defaultOnceEq(clause);
            out.push(clause);
        }
        if (!out.length) return null;
        return out.length === 1 ? out[0] : out;
    }
    const clause = normalizeWhenClause(raw);
    if (!clause) return null;
    defaultOnceEq(clause);
    return clause;
}

function normalizeChestWhen(raw) {
    if (raw == null) return null;
    if (Array.isArray(raw)) {
        const out = [];
        for (let i = 0; i < raw.length; i++) {
            const clause = normalizeWhenClause(raw[i]);
            if (clause) out.push(clause);
        }
        return out.length ? out : null;
    }
    return normalizeWhenClause(raw);
}

function normalizeChestSet(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    const keys = Object.keys(raw);
    for (let i = 0; i < keys.length; i++) {
        const k = String(keys[i] || '').trim();
        if (!k || !STORAGE_KEY_RE.test(k)) continue;
        let v = raw[keys[i]];
        if (v == null) continue;
        if (typeof v === 'boolean') v = v ? 1 : 0;
        else if (typeof v === 'number') {
            if (!Number.isFinite(v)) continue;
        } else if (typeof v === 'string') {
            const t = v.trim();
            if (!t) continue;
            if (t !== 'true' && t !== 'false' && Number.isFinite(Number(t))) v = Number(t);
            else v = t;
        } else continue;
        out[k] = v;
    }
    return Object.keys(out).length ? out : null;
}

function normalizeLeverStates(raw) {
    let list = [];
    if (typeof raw === 'string') list = raw.split(',');
    else if (Array.isArray(raw)) list = raw;
    const out = [];
    const seen = Object.create(null);
    for (let i = 0; i < list.length; i++) {
        const s = String(list[i] == null ? '' : list[i]).trim();
        if (!s || seen[s]) continue;
        seen[s] = true;
        out.push(s);
    }
    return out.length ? out : DEFAULT_LEVER_STATES.slice();
}

function normalizeCellEffect(raw, fallbackZ) {
    if (!raw || typeof raw !== 'object') return null;
    const x = finiteInt(raw.x);
    const y = finiteInt(raw.y);
    if (x == null || y == null) return null;
    const zRaw = raw.z != null ? finiteInt(raw.z) : finiteInt(fallbackZ);
    const z = zRaw != null ? zRaw : 0;
    const effect = { type: 'cell', x, y, z };
    let any = false;
    const friction = clampChannelByte(raw.friction);
    if (friction != null && raw.friction != null) {
        effect.friction = friction;
        any = true;
    }
    const sight = clampChannelByte(raw.sight);
    if (sight != null && raw.sight != null) {
        effect.sight = sight;
        any = true;
    }
    const flags = clampChannelByte(raw.flags);
    if (flags != null && raw.flags != null) {
        effect.flags = flags;
        any = true;
    }
    const fields = clampChannelByte(raw.fields);
    if (fields != null && raw.fields != null) {
        effect.fields = fields;
        any = true;
    }
    return any ? effect : null;
}

function normalizeDoorEffect(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = slugifyWorldId(raw.id || raw.doorId || '');
    if (!id) return null;
    return { type: 'door', id, open: raw.open !== false };
}

function normalizeDoorGate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const gate = {};
    const whenSrc = raw.when != null
        ? raw.when
        : (raw.storage != null || raw.item != null || raw.itemId != null || raw.key != null)
            ? raw
            : null;
    const when = normalizeChestWhen(whenSrc);
    if (when) gate.when = when;
    if (raw.level != null) {
        const n = Math.floor(Number(raw.level));
        if (Number.isFinite(n) && n >= 1) gate.level = n;
    }
    return gate.when || gate.level != null ? gate : null;
}

function normalizeTransformOnUse(raw) {
    if (raw == null || raw === false || raw === true) return null;
    if (typeof raw === 'string' || typeof raw === 'number') {
        const s = String(raw).trim();
        return s || null;
    }
    if (Array.isArray(raw)) {
        const out = [];
        let any = false;
        for (let i = 0; i < raw.length; i++) {
            const s = raw[i] != null ? String(raw[i]).trim() : '';
            out.push(s);
            if (s) any = true;
        }
        return any ? out : null;
    }
    return null;
}

function normalizeDecay(raw) {
    if (raw == null || raw === false || raw === true) return null;
    if (typeof raw === 'number' || typeof raw === 'string') {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return null;
        return { sec: n };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    const secRaw = raw.sec != null ? raw.sec : raw.seconds != null ? raw.seconds : raw.ticks;
    const sec = Number(secRaw);
    if (!Number.isFinite(sec) || sec <= 0) return null;
    const decay = { sec };
    if (raw.to != null) {
        const to = String(raw.to).trim();
        if (to) decay.to = to;
    }
    return decay;
}

function normalizeTeleportTo(raw, fallbackZ) {
    if (!raw || typeof raw !== 'object') return null;
    const x = finiteInt(raw.x);
    const y = finiteInt(raw.y);
    if (x == null || y == null) return null;
    const z = raw.z != null ? finiteInt(raw.z) : finiteInt(fallbackZ);
    return { x, y, z: z != null ? z : 0 };
}

function normalizeSpawnEffect(raw, fallbackZ) {
    if (!raw || typeof raw !== 'object') return null;
    const creatureId = String(raw.creatureId || raw.id || raw.name || '').trim();
    if (!creatureId) return null;
    const effect = { type: 'spawn', creatureId };
    const x = finiteInt(raw.x);
    const y = finiteInt(raw.y);
    if (x != null && y != null) {
        effect.x = x;
        effect.y = y;
    }
    const z = raw.z != null ? finiteInt(raw.z) : finiteInt(fallbackZ);
    if (z != null) effect.z = z;
    const count = Math.floor(Number(raw.count));
    if (Number.isFinite(count) && count > 1) effect.count = count;
    if (raw.respawn != null) {
        const r = Number(raw.respawn);
        if (Number.isFinite(r) && r >= 0) effect.respawn = r;
    }
    return effect;
}

function normalizeWaveEffect(raw) {
    if (!raw || typeof raw !== 'object') return { type: 'wave' };
    const effect = { type: 'wave' };
    const id = raw.id != null ? String(raw.id).trim() : '';
    if (id && id !== 'wave') effect.id = id;
    return effect;
}

function normalizeUnlockEffect(raw) {
    if (!raw || typeof raw !== 'object') return { type: 'unlock' };
    const effect = { type: 'unlock' };
    const id = slugifyWorldId(raw.id || raw.doorId || '');
    if (id && id !== 'unlock') effect.id = id;
    return effect;
}

function normalizeCooldownSec(raw) {
    if (raw == null || raw === false || raw === true) return null;
    if (typeof raw === 'number' || typeof raw === 'string') {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return null;
        return n;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    const n = Number(raw.sec != null ? raw.sec : raw.seconds);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

function normalizeTrapField(raw) {
    if (raw == null || raw === false || raw === true) return null;
    let s = '';
    if (typeof raw === 'string' || typeof raw === 'number') s = String(raw);
    else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        s = String(raw.kind || raw.id || raw.name || '');
    }
    s = s.trim().toLowerCase().replace(/_field$/, '').replace(/field$/, '');
    if (s === 'earth') s = 'poison';
    if (s === 'magic_wall' || s === 'magicwall') s = 'barrier';
    if (TRAP_FIELD_KINDS.indexOf(s) >= 0) return s;
    return null;
}

function normalizeTrapDamage(raw) {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return null;
    return n;
}

function normalizeLeverEffects(raw, fallbackZ) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    let hasSpawn = false;
    let hasWave = false;
    for (let i = 0; i < raw.length; i++) {
        const row = raw[i];
        if (!row || typeof row !== 'object') continue;
        const type = String(row.type || '').trim().toLowerCase();
        if (type === 'door') {
            const effect = normalizeDoorEffect(row);
            if (effect) out.push(effect);
        } else if (type === 'spawn') {
            if (hasWave) continue;
            const effect = normalizeSpawnEffect(row, fallbackZ);
            if (effect) {
                out.push(effect);
                hasSpawn = true;
            }
        } else if (type === 'wave') {
            if (hasSpawn) continue;
            out.push(normalizeWaveEffect(row));
            hasWave = true;
        } else if (type === 'unlock') {
            out.push(normalizeUnlockEffect(row));
        } else if (type === 'cell' || type === '') {
            const effect = normalizeCellEffect(row, fallbackZ);
            if (effect) out.push(effect);
        }
    }
    return out;
}

function allocWorldPinId(used, kind, x, y, z) {
    const base = slugifyWorldId(kind + '_' + z + '_' + x + '_' + y) || 'pin';
    const taken = Object.create(null);
    const set = used && typeof used === 'object' ? used : [];
    for (let i = 0; i < set.length; i++) {
        const id = String(set[i] || '').trim();
        if (id) taken[id] = true;
    }
    if (!taken[base]) return base;
    let n = 2;
    while (taken[base + '_' + n]) n += 1;
    return base + '_' + n;
}

function normalizeWorldPin(raw, opts) {
    if (!raw || typeof raw !== 'object') return null;
    const o = opts || {};
    const x = finiteInt(raw.x);
    const y = finiteInt(raw.y);
    if (x == null || y == null) return null;
    const zRaw = raw.z != null ? raw.z : o.z;
    const z = zRaw != null ? finiteInt(zRaw) : 0;
    if (z == null) return null;
    const catalogId = String(raw.catalogId || raw.item || raw.spriteId || '').trim();
    if (!catalogId) return null;
    const kind = normalizeWorldKind(raw.kind);
    const defs = kindDefaults(kind);
    let id = raw.id != null ? slugifyWorldId(raw.id) : '';
    if (!id) id = allocWorldPinId(o.usedIds || [], kind, x, y, z);
    const tag = raw.tag != null ? slugifyWorldId(raw.tag) : '';
    const blocking = raw.blocking != null ? !!raw.blocking : defs.blocking;
    const pickupable = raw.pickupable != null ? !!raw.pickupable : defs.pickupable;
    const pin = {
        id,
        kind,
        catalogId,
        catalogKind: normalizeCatalogKind(raw.catalogKind || raw.kindHint),
        x,
        y,
        z,
        blocking,
        pickupable
    };
    if (tag) pin.tag = tag;
    if (kind === 'container') {
        const cap = raw.capacity != null
            ? Math.floor(Number(raw.capacity))
            : DEFAULT_CONTAINER_CAPACITY;
        pin.capacity = Number.isFinite(cap) && cap >= 1 ? cap : DEFAULT_CONTAINER_CAPACITY;
        pin.shared = raw.shared != null ? !!raw.shared : defs.shared;
        pin.items = normalizeWorldItems(raw.items);
    } else if (kind === 'chest') {
        pin.shared = raw.shared != null ? !!raw.shared : defs.shared;
        const once = normalizeChestOnce(raw.once);
        if (once) pin.once = once;
        const when = normalizeChestWhen(raw.when);
        if (when) pin.when = when;
        pin.give = normalizeWorldItems(raw.give);
        const set = normalizeChestSet(raw.set);
        if (set) pin.set = set;
        if (raw.emptyText != null) {
            const text = String(raw.emptyText).trim();
            if (text) pin.emptyText = text;
        }
        if (raw.transformTo != null) {
            const to = String(raw.transformTo).trim();
            if (to) pin.transformTo = to;
        }
    } else if (kind === 'lever' || kind === 'switch') {
        pin.states = normalizeLeverStates(raw.states);
        const effects = normalizeLeverEffects(raw.effects, z);
        if (effects.length) pin.effects = effects;
        const when = normalizeChestWhen(raw.when);
        if (when) pin.when = when;
    } else if (kind === 'door') {
        if (raw.closedId != null) {
            const closedId = String(raw.closedId).trim();
            if (closedId) pin.closedId = closedId;
        }
        if (raw.openId != null) {
            const openId = String(raw.openId).trim();
            if (openId) pin.openId = openId;
        }
        const gate = normalizeDoorGate(raw.gate);
        if (gate) pin.gate = gate;
        if (raw.lockId != null) {
            const lockId = String(raw.lockId).trim();
            if (lockId) pin.lockId = lockId;
        }
        if (raw.consume === true) pin.consume = true;
    } else if (kind === 'teleport') {
        const to = normalizeTeleportTo(raw.to, z);
        if (to) pin.to = to;
    } else if (kind === 'harvest') {
        pin.shared = raw.shared != null ? !!raw.shared : defs.shared;
        const once = normalizeChestOnce(raw.once);
        if (once) pin.once = once;
        const when = normalizeChestWhen(raw.when);
        if (when) pin.when = when;
        pin.give = normalizeWorldItems(raw.give);
        const set = normalizeChestSet(raw.set);
        if (set) pin.set = set;
        if (raw.emptyText != null) {
            const text = String(raw.emptyText).trim();
            if (text) pin.emptyText = text;
        }
        if (raw.transformTo != null) {
            const to = String(raw.transformTo).trim();
            if (to) pin.transformTo = to;
        }
        const cooldown = normalizeCooldownSec(raw.cooldown);
        if (cooldown != null) pin.cooldown = cooldown;
    } else if (kind === 'trap') {
        pin.shared = raw.shared != null ? !!raw.shared : defs.shared;
        const once = normalizeChestOnce(raw.once);
        if (once) pin.once = once;
        const when = normalizeChestWhen(raw.when);
        if (when) pin.when = when;
        const set = normalizeChestSet(raw.set);
        if (set) pin.set = set;
        if (raw.transformTo != null) {
            const to = String(raw.transformTo).trim();
            if (to) pin.transformTo = to;
        }
        const cooldown = normalizeCooldownSec(raw.cooldown);
        if (cooldown != null) pin.cooldown = cooldown;
        const damage = normalizeTrapDamage(raw.damage);
        if (damage != null) pin.damage = damage;
        const field = normalizeTrapField(raw.field);
        if (field) pin.field = field;
        if (raw.element != null) {
            const element = String(raw.element).trim().toLowerCase();
            if (element) pin.element = element;
        }
    }
    const transformOnUse = normalizeTransformOnUse(raw.transformOnUse);
    if (kind === 'chest' || kind === 'harvest' || kind === 'trap') {
        if (!pin.transformTo && typeof transformOnUse === 'string') {
            pin.transformTo = transformOnUse;
        }
    } else if (transformOnUse) {
        pin.transformOnUse = transformOnUse;
    }
    const decay = normalizeDecay(raw.decay);
    if (decay) pin.decay = decay;
    return pin;
}

function parseWorldRows(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.world)) return data.world;
    return [];
}

function normalizeWorldList(list, opts) {
    const rows = Array.isArray(list) ? list : parseWorldRows(list);
    const out = [];
    const used = [];
    for (let i = 0; i < rows.length; i++) {
        const pin = normalizeWorldPin(rows[i], {
            z: opts && opts.z,
            usedIds: used
        });
        if (!pin) continue;
        used.push(pin.id);
        out.push(pin);
    }
    return out;
}

function applyWorldPinWalkBlock(tileMap, inst) {
    if (!inst || !inst.blocking || !tileMap || typeof tileMap.applyCellPatch !== 'function') {
        return;
    }
    if (inst.kind === 'door' && inst.doorOpen) return;
    const r = tileMap.applyCellPatch({
        x: inst.x,
        y: inst.y,
        z: inst.z,
        friction: FRICTION_BLOCKED
    });
    if (!r.ok) return;
    inst.savedFriction = r.prev.friction;
    inst.frictionPatched = true;
}

function restoreWorldPinWalkBlock(tileMap, inst) {
    if (!inst || !inst.frictionPatched) return;
    if (!tileMap || typeof tileMap.applyCellPatch !== 'function') {
        inst.frictionPatched = false;
        return;
    }
    if (inst.savedFriction != null && Number.isFinite(Number(inst.savedFriction))) {
        tileMap.applyCellPatch({
            x: inst.x,
            y: inst.y,
            z: inst.z,
            friction: Number(inst.savedFriction)
        });
    }
    inst.frictionPatched = false;
}

function makeWorldPinInstance(pin, numericId) {
    const states = Array.isArray(pin.states) && pin.states.length
        ? pin.states.slice()
        : DEFAULT_LEVER_STATES.slice();
    const openByArt = !!(
        pin.kind === 'door'
        && pin.openId
        && pin.catalogId === pin.openId
        && pin.catalogId !== pin.closedId
    );
    const inst = {
        id: numericId >>> 0,
        pinId: pin.id,
        kind: pin.kind,
        tag: pin.tag || '',
        catalogId: pin.catalogId,
        catalogKind: pin.catalogKind,
        catalogBase: pin.catalogId,
        x: pin.x | 0,
        y: pin.y | 0,
        z: pin.z | 0,
        blocking: !!pin.blocking,
        pickupable: !!pin.pickupable,
        shared: pin.shared === true,
        capacity: pin.capacity || DEFAULT_CONTAINER_CAPACITY,
        items: flattenWorldItems(pin.items),
        once: pin.once || null,
        when: pin.when || null,
        give: Array.isArray(pin.give) ? pin.give : [],
        set: pin.set || null,
        emptyText: pin.emptyText || '',
        transformTo: pin.transformTo || '',
        transformOnUse: pin.transformOnUse || null,
        decay: pin.decay || null,
        states,
        effects: Array.isArray(pin.effects) ? pin.effects : [],
        closedId: pin.closedId || '',
        openId: pin.openId || '',
        gate: pin.gate || null,
        lockId: pin.lockId || '',
        consume: pin.consume === true,
        to: pin.to || null,
        cooldown: pin.cooldown != null ? pin.cooldown : null,
        damage: pin.damage != null ? pin.damage : null,
        field: pin.field || '',
        element: pin.element || '',
        used: false,
        doorOpen: openByArt || (pin.kind === 'door' && !pin.blocking),
        unlocked: false,
        stateIndex: 0,
        state: states[0] || 'off',
        harvestReadyAt: null,
        trapReadyAt: null,
        decayAt: null,
        savedFriction: null,
        frictionPatched: false,
        removed: false
    };
    if (pin.kind === 'container') inst.shared = pin.shared !== false;
    return inst;
}

function seedWorldPinInstances(rows, tileMap, startId) {
    const pins = normalizeWorldList(rows);
    const out = [];
    let next = startId != null ? startId >>> 0 : WORLD_PIN_ID_BASE;
    const taken = Object.create(null);
    for (let i = 0; i < pins.length; i++) {
        const pin = pins[i];
        if (!pin || taken[pin.id]) continue;
        const inst = makeWorldPinInstance(pin, next);
        next += 1;
        applyWorldPinWalkBlock(tileMap, inst);
        taken[pin.id] = true;
        out.push(inst);
    }
    return { instances: out, nextId: next };
}

function applyCatalogTransform(inst, catalogId) {
    const id = catalogId != null ? String(catalogId).trim() : '';
    if (!id || !inst) return false;
    inst.catalogId = id;
    return true;
}

function chestEmptyText(inst) {
    const t = inst && inst.emptyText ? String(inst.emptyText).trim() : '';
    return t || DEFAULT_CHEST_EMPTY_TEXT;
}

function harvestEmptyText(inst) {
    const t = inst && inst.emptyText ? String(inst.emptyText).trim() : '';
    return t || DEFAULT_HARVEST_EMPTY_TEXT;
}

module.exports = {
    WORLD_PIN_ID_BASE,
    DEFAULT_CONTAINER_CAPACITY,
    MAX_ITEM_NEST,
    DEFAULT_LEVER_STATES,
    WORLD_KINDS,
    WORLD_USE_KINDS,
    CANNOT_TEXT,
    DEFAULT_CHEST_EMPTY_TEXT,
    DEFAULT_HARVEST_EMPTY_TEXT,
    STUB_TEXT,
    STORAGE_KEY_RE,
    normalizeWorldKind,
    kindDefaults,
    worldPinUseReady,
    worldPinTileKey,
    normalizeWorldPin,
    normalizeWorldList,
    flattenWorldItems,
    applyWorldPinWalkBlock,
    restoreWorldPinWalkBlock,
    makeWorldPinInstance,
    seedWorldPinInstances,
    applyCatalogTransform,
    chestEmptyText,
    harvestEmptyText
};

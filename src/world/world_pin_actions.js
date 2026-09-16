'use strict';

const { chebyshev } = require('./combat');
const { countItem, stackItem, takeItem } = require('./inventory');
const { evalWhen, applyStoragePatch } = require('./npc');
const {
    TILE_FLAG_ROPE_SPOT,
    TILE_FLAG_SHOVEL_SPOT
} = require('./tilemap');
const {
    DEFAULT_LEVER_STATES,
    CANNOT_TEXT,
    STUB_TEXT,
    worldPinUseReady,
    restoreWorldPinWalkBlock,
    applyWorldPinWalkBlock,
    applyCatalogTransform,
    chestEmptyText,
    harvestEmptyText
} = require('./world_pins');

const TOOL_ROLES = Object.freeze({
    rope: { flag: TILE_FLAG_ROPE_SPOT, deltaZ: -1 },
    shovel: { flag: TILE_FLAG_SHOVEL_SPOT, deltaZ: 1 }
});
const TOOL_RANGE = 1;
const USE_RANGE = 1;
const TELEPORT_NO_DEST_TEXT = 'There is no destination.';
const TELEPORT_NO_WAY_TEXT = 'There is no way.';
const DOOR_LOCKED_TEXT = 'The door is locked.';
const DOOR_CANNOT_PASS_TEXT = 'You cannot pass yet.';

function resolveToolRole(itemId) {
    const id = itemId != null ? String(itemId).trim().toLowerCase() : '';
    if (!id) return null;
    if (id === 'rope' || id === 'shovel') return id;
    if (/(^|_)rope(_|$)/.test(id)) return 'rope';
    if (/(^|_)shovel(_|$)/.test(id)) return 'shovel';
    return null;
}

function isWorldToolItem(itemId) {
    return resolveToolRole(itemId) != null;
}

function pinInUseRange(player, inst, range) {
    if (!player || !inst) return false;
    if ((player.z | 0) !== (inst.z | 0)) return false;
    const r = range == null ? USE_RANGE : range | 0;
    return chebyshev(player.x, player.y, inst.x, inst.y) <= r;
}

function stackOk(r) {
    if (!r) return false;
    if (r.ok === false) return false;
    return true;
}

function giveAll(player, specs, itemDb) {
    const list = Array.isArray(specs) ? specs : [];
    const given = [];
    const db = itemDb || (player.world && typeof player.world.itemDb === 'function'
        ? player.world.itemDb()
        : null);
    for (let i = 0; i < list.length; i++) {
        const spec = list[i];
        if (!spec || !spec.item) continue;
        const id = String(spec.item);
        const count = Math.max(1, spec.count | 0);
        const r = stackItem(player.inventory, id, count, db);
        if (!stackOk(r)) {
            for (let j = given.length - 1; j >= 0; j--) {
                takeItem(player.inventory, given[j].id, given[j].count);
            }
            return { ok: false, reason: 'full', text: 'You cannot take that.', given: [] };
        }
        given.push({ id, count });
    }
    return { ok: true, given };
}

function transformAfterUse(inst, explicit) {
    const to = explicit != null && String(explicit).trim()
        ? String(explicit).trim()
        : inst && inst.transformTo
            ? String(inst.transformTo).trim()
            : typeof (inst && inst.transformOnUse) === 'string'
                ? String(inst.transformOnUse).trim()
                : '';
    if (!to) return null;
    applyCatalogTransform(inst, to);
    return to;
}

function useWorldChest(player, inst, opts) {
    if (!inst || inst.kind !== 'chest' || inst.removed) {
        return { ok: false, reason: 'not_chest', text: CANNOT_TEXT };
    }
    if (inst.used) {
        return { ok: false, reason: 'empty', text: chestEmptyText(inst) };
    }
    if (!evalWhen(player, inst.once) || !evalWhen(player, inst.when)) {
        return { ok: false, reason: 'empty', text: chestEmptyText(inst) };
    }
    const moved = giveAll(player, inst.give, opts && opts.itemDb);
    if (!moved.ok) return moved;
    if (inst.set) applyStoragePatch(player.storage, inst.set);
    if (inst.shared) inst.used = true;
    const transformed = transformAfterUse(inst, inst.transformTo);
    return { ok: true, given: moved.given, transformed };
}

function useWorldHarvest(player, inst, nowSec, opts) {
    if (!inst || inst.kind !== 'harvest' || inst.removed) {
        return { ok: false, reason: 'not_harvest', text: CANNOT_TEXT };
    }
    const now = nowSec != null ? Number(nowSec) : 0;
    if (inst.harvestReadyAt != null && Number.isFinite(Number(inst.harvestReadyAt))
        && now < Number(inst.harvestReadyAt)) {
        return { ok: false, reason: 'empty', text: harvestEmptyText(inst) };
    }
    if (inst.used) {
        return { ok: false, reason: 'empty', text: harvestEmptyText(inst) };
    }
    if (!evalWhen(player, inst.once) || !evalWhen(player, inst.when)) {
        return { ok: false, reason: 'empty', text: harvestEmptyText(inst) };
    }
    const moved = giveAll(player, inst.give, opts && opts.itemDb);
    if (!moved.ok) return moved;
    if (inst.set) applyStoragePatch(player.storage, inst.set);
    if (inst.shared) inst.used = true;
    const cooldown = inst.cooldown != null && Number.isFinite(Number(inst.cooldown))
        ? Number(inst.cooldown)
        : 0;
    if (cooldown > 0) inst.harvestReadyAt = now + cooldown;
    const transformed = transformAfterUse(inst, inst.transformTo);
    return { ok: true, given: moved.given, transformed };
}

function playerLevel(player) {
    const n = player && player.level != null ? Number(player.level) : 1;
    return Number.isFinite(n) ? n : 1;
}

function doorIsGated(inst) {
    if (!inst) return false;
    if (inst.gate) return true;
    return !!(inst.lockId && String(inst.lockId).trim());
}

function evalDoorGates(player, inst) {
    const gate = inst.gate;
    if (gate && typeof gate === 'object') {
        const when = gate.when != null
            ? gate.when
            : (gate.storage != null || gate.item != null || gate.itemId != null || gate.key != null)
                ? gate
                : null;
        if (when != null && !evalWhen(player, when)) {
            return { ok: false, reason: 'cannot_pass', text: DOOR_CANNOT_PASS_TEXT };
        }
        if (gate.level != null) {
            const need = Math.floor(Number(gate.level));
            if (Number.isFinite(need) && playerLevel(player) < need) {
                return { ok: false, reason: 'cannot_pass', text: DOOR_CANNOT_PASS_TEXT };
            }
        }
    }
    const lockId = inst.lockId ? String(inst.lockId).trim() : '';
    if (lockId && !inst.unlocked) {
        if (countItem(player && player.inventory, lockId) < 1) {
            return { ok: false, reason: 'locked', text: DOOR_LOCKED_TEXT };
        }
    }
    return { ok: true, lockId, consume: inst.consume === true, unlocked: !!inst.unlocked };
}

function setDoorOpen(inst, open, tileMap) {
    if (!inst || inst.kind !== 'door' || inst.removed) {
        return { ok: false, reason: 'not_door' };
    }
    const want = !!open;
    if (!!inst.doorOpen === want) return { ok: true, changed: false, open: want };
    if (want) {
        restoreWorldPinWalkBlock(tileMap, inst);
        inst.blocking = false;
        if (inst.openId) applyCatalogTransform(inst, inst.openId);
    } else {
        inst.blocking = true;
        applyWorldPinWalkBlock(tileMap, inst);
        if (inst.closedId) applyCatalogTransform(inst, inst.closedId);
    }
    inst.doorOpen = want;
    return { ok: true, changed: true, open: want };
}

function useWorldDoor(player, inst, tileMap) {
    if (!inst || inst.kind !== 'door' || inst.removed) {
        return { ok: false, reason: 'not_door', text: CANNOT_TEXT };
    }
    const opening = !inst.doorOpen;
    if (opening && doorIsGated(inst)) {
        const gate = evalDoorGates(player, inst);
        if (!gate.ok) return { ok: false, reason: gate.reason, text: gate.text };
        if (gate.lockId && gate.consume && !gate.unlocked) {
            if (!takeItem(player.inventory, gate.lockId, 1)) {
                return { ok: false, reason: 'locked', text: DOOR_LOCKED_TEXT };
            }
            inst.unlocked = true;
        }
    }
    const next = !inst.doorOpen;
    const r = setDoorOpen(inst, next, tileMap);
    return { ok: r.ok, open: next, changed: r.changed };
}

function resolveTeleportTo(inst) {
    const src = inst && inst.to;
    if (!src || typeof src !== 'object') return null;
    const x = Math.round(Number(src.x));
    const y = Math.round(Number(src.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const z = src.z != null ? src.z | 0 : inst.z | 0;
    return { x, y, z };
}

function useWorldTeleport(player, inst, tileMap) {
    if (!player || !inst || inst.kind !== 'teleport' || inst.removed) {
        return { ok: false, reason: 'not_teleport', text: CANNOT_TEXT };
    }
    const to = resolveTeleportTo(inst);
    if (!to) return { ok: false, reason: 'no_dest', text: TELEPORT_NO_DEST_TEXT };
    if (!tileMap || typeof tileMap.getLayer !== 'function') {
        return { ok: false, reason: 'no_dest', text: TELEPORT_NO_DEST_TEXT };
    }
    if (!tileMap.getLayer(to.z)) {
        return { ok: false, reason: 'no_dest', text: TELEPORT_NO_DEST_TEXT };
    }
    if (!tileMap.moveEntityToTile(to.x, to.y, to.z, player, { reason: 'stair' })) {
        return { ok: false, reason: 'blocked', text: TELEPORT_NO_WAY_TEXT };
    }
    if (Array.isArray(player.path)) player.path = [];
    return { ok: true, to };
}

function pinByPinId(instances, pinId) {
    const want = pinId != null ? String(pinId) : '';
    if (!want) return null;
    const list = instances || [];
    for (let i = 0; i < list.length; i++) {
        if (list[i] && !list[i].removed && list[i].pinId === want) return list[i];
    }
    return null;
}

function resolveLeverEffects(instances, inst) {
    const own = Array.isArray(inst.effects) ? inst.effects : [];
    const tag = inst.tag ? String(inst.tag) : '';
    const key = tag || String(inst.pinId || '');
    const states = Array.isArray(inst.states) && inst.states.length
        ? inst.states
        : DEFAULT_LEVER_STATES.slice();
    if (own.length) return { effects: own, key, states };
    if (!tag) return { effects: [], key, states };
    const list = instances || [];
    for (let i = 0; i < list.length; i++) {
        const other = list[i];
        if (!other || other === inst || other.removed) continue;
        if (other.tag !== tag) continue;
        if (!Array.isArray(other.effects) || !other.effects.length) continue;
        const st = Array.isArray(other.states) && other.states.length ? other.states : states;
        return { effects: other.effects, key, states: st };
    }
    return { effects: [], key, states };
}

function expandSpawnEffect(effect, inst) {
    if (!effect || !effect.creatureId) return [];
    const x = effect.x != null ? effect.x : inst.x;
    const y = effect.y != null ? effect.y : inst.y;
    if (x == null || y == null) return [];
    const z = effect.z != null ? effect.z : inst.z | 0;
    const countRaw = Math.floor(Number(effect.count));
    const count = Number.isFinite(countRaw) && countRaw > 1 ? countRaw : 1;
    const respawn = effect.respawn != null && Number.isFinite(Number(effect.respawn))
        ? Math.max(0, Number(effect.respawn))
        : 0;
    const rows = [];
    for (let i = 0; i < count; i++) {
        rows.push({
            creatureId: String(effect.creatureId),
            kind: String(effect.creatureId),
            x: Math.round(Number(x)),
            y: Math.round(Number(y)),
            z,
            respawn
        });
    }
    return rows;
}

function applyLeverTransform(inst, index) {
    if (!inst) return;
    const spec = inst.transformOnUse;
    const base = inst.catalogBase || inst.catalogId;
    let id = '';
    if (Array.isArray(spec) && spec.length) {
        const hit = spec[index];
        if (hit) id = String(hit).trim();
    } else if (spec) {
        const on = String(spec).trim();
        if (on) id = index === 0 ? String(base || '').trim() : on;
    }
    if (id) applyCatalogTransform(inst, id);
}

function applyLeverEffects(effects, bag, key, ctx) {
    const list = Array.isArray(effects) ? effects : [];
    const snaps = [];
    const tileMap = ctx.tileMap || null;
    const instances = ctx.instances || [];
    const inst = ctx.inst || null;
    const spawnRows = [];
    let waveWanted = false;
    let waveId = null;
    for (let i = 0; i < list.length; i++) {
        const effect = list[i];
        if (!effect || !effect.type) continue;
        if (effect.type === 'cell') {
            const patch = {
                x: effect.x,
                y: effect.y,
                z: effect.z != null ? effect.z : (inst ? inst.z : 0)
            };
            const keys = [];
            if (effect.friction != null) {
                patch.friction = effect.friction;
                keys.push('friction');
            }
            if (effect.sight != null) {
                patch.sight = effect.sight;
                keys.push('sight');
            }
            if (effect.flags != null) {
                patch.flags = effect.flags;
                keys.push('flags');
            }
            if (effect.fields != null) {
                patch.fields = effect.fields;
                keys.push('fields');
            }
            if (!keys.length || !tileMap || typeof tileMap.applyCellPatch !== 'function') continue;
            const r = tileMap.applyCellPatch(patch);
            if (!r.ok) continue;
            snaps.push({ type: 'cell', x: patch.x, y: patch.y, z: patch.z, keys, prev: r.prev });
        } else if (effect.type === 'door') {
            const id = effect.id != null ? String(effect.id) : '';
            if (!id) continue;
            const door = pinByPinId(instances, id);
            if (!door) continue;
            snaps.push({ type: 'door', id, prevOpen: !!door.doorOpen });
            setDoorOpen(door, effect.open !== false, tileMap);
        } else if (effect.type === 'spawn') {
            const rows = expandSpawnEffect(effect, inst);
            for (let r = 0; r < rows.length; r++) spawnRows.push(rows[r]);
        } else if (effect.type === 'wave') {
            waveWanted = true;
            if (effect.id) waveId = String(effect.id);
        } else if (effect.type === 'unlock') {
            if (effect.id) {
                const door = pinByPinId(instances, effect.id);
                if (door) door.unlocked = true;
            } else {
                waveWanted = true;
            }
        }
    }
    bag.snapshots[key] = snaps;
    if (spawnRows.length && typeof ctx.spawn === 'function') ctx.spawn(spawnRows);
    if (waveWanted && typeof ctx.unlockWaves === 'function') ctx.unlockWaves(waveId);
}

function reverseLeverEffects(bag, key, ctx) {
    const snaps = bag.snapshots[key];
    if (!Array.isArray(snaps) || !snaps.length) {
        delete bag.snapshots[key];
        return;
    }
    const tileMap = ctx.tileMap || null;
    const instances = ctx.instances || [];
    for (let i = snaps.length - 1; i >= 0; i--) {
        const snap = snaps[i];
        if (!snap) continue;
        if (snap.type === 'cell' && snap.prev && tileMap && typeof tileMap.applyCellPatch === 'function') {
            const patch = { x: snap.x, y: snap.y, z: snap.z };
            const keys = Array.isArray(snap.keys) ? snap.keys : ['friction'];
            for (let k = 0; k < keys.length; k++) {
                const ch = keys[k];
                if (snap.prev[ch] != null) patch[ch] = snap.prev[ch];
            }
            tileMap.applyCellPatch(patch);
        } else if (snap.type === 'door' && snap.id) {
            const door = pinByPinId(instances, snap.id);
            if (door) setDoorOpen(door, !!snap.prevOpen, tileMap);
        }
    }
    delete bag.snapshots[key];
}

function syncLeverState(instances, key, tag, index, name) {
    const list = instances || [];
    for (let i = 0; i < list.length; i++) {
        const inst = list[i];
        if (!inst || inst.removed) continue;
        if (inst.kind !== 'lever' && inst.kind !== 'switch') continue;
        const matchTag = tag && inst.tag === tag;
        const matchId = !tag && inst.pinId === key;
        if (!matchTag && !matchId) continue;
        inst.stateIndex = index;
        inst.state = name;
    }
}

function useWorldLever(player, inst, ctx) {
    const o = ctx || {};
    if (!inst || (inst.kind !== 'lever' && inst.kind !== 'switch') || inst.removed) {
        return { ok: false, reason: 'not_lever', text: CANNOT_TEXT };
    }
    if (!evalWhen(player, inst.when)) {
        return { ok: false, reason: 'when', text: CANNOT_TEXT };
    }
    if (!o.bag) {
        o.bag = { state: Object.create(null), snapshots: Object.create(null) };
    }
    const instances = o.instances || [];
    const resolved = resolveLeverEffects(instances, inst);
    const current = o.bag.state[resolved.key] | 0;
    const n = resolved.states.length || 2;
    const next = (current + 1) % n;
    const applyCtx = {
        tileMap: o.tileMap || null,
        instances,
        inst,
        spawn: o.spawn || null,
        unlockWaves: o.unlockWaves || null
    };
    if (next === 0) reverseLeverEffects(o.bag, resolved.key, applyCtx);
    else if (current === 0) applyLeverEffects(resolved.effects, o.bag, resolved.key, applyCtx);
    o.bag.state[resolved.key] = next;
    const name = resolved.states[next] || String(next);
    syncLeverState(instances, resolved.key, inst.tag || '', next, name);
    inst.stateIndex = next;
    inst.state = name;
    applyLeverTransform(inst, next);
    return { ok: true, state: name, stateIndex: next };
}

function useWorldPin(player, inst, ctx) {
    if (!inst || inst.removed) {
        return { ok: false, reason: 'missing', text: CANNOT_TEXT };
    }
    if (inst.kind === 'container') return { ok: true, open: true };
    if (inst.kind === 'chest') return useWorldChest(player, inst, ctx);
    if (inst.kind === 'harvest') return useWorldHarvest(player, inst, ctx && ctx.now, ctx);
    if (inst.kind === 'door') return useWorldDoor(player, inst, ctx && ctx.tileMap);
    if (inst.kind === 'lever' || inst.kind === 'switch') return useWorldLever(player, inst, ctx);
    if (inst.kind === 'teleport') return useWorldTeleport(player, inst, ctx && ctx.tileMap);
    if (inst.kind === 'trap') return { ok: false, reason: 'trap', text: CANNOT_TEXT };
    if (!worldPinUseReady(inst.kind)) {
        return { ok: false, reason: 'stub', text: STUB_TEXT };
    }
    return { ok: false, reason: 'stub', text: STUB_TEXT };
}

function pinMatchesTool(inst, role) {
    if (!inst || inst.removed || !role) return false;
    const tag = inst.tag != null ? String(inst.tag).trim().toLowerCase() : '';
    return tag === role;
}

function pinToolTo(inst) {
    const src = inst && inst.to;
    if (!src || typeof src !== 'object') return null;
    const x = Math.round(Number(src.x));
    const y = Math.round(Number(src.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const z = src.z != null ? src.z | 0 : inst.z | 0;
    return { x, y, z };
}

function useWorldToolWith(player, cmd, opts) {
    const o = opts || {};
    const role = resolveToolRole(cmd && cmd.itemId);
    if (!role) return { ok: false, reason: 'not_tool', text: CANNOT_TEXT };
    if (!player) return { ok: false, reason: 'no_player', text: CANNOT_TEXT };
    const heldId = String(cmd.itemId).trim();
    if (countItem(player.inventory, heldId) < 1) {
        return { ok: false, reason: 'no_item', text: CANNOT_TEXT };
    }
    const x = Math.round(Number(cmd && cmd.x));
    const y = Math.round(Number(cmd && cmd.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, reason: 'no_tile', text: CANNOT_TEXT };
    }
    const z = cmd && cmd.z != null ? cmd.z | 0 : player.z | 0;
    if ((player.z | 0) !== (z | 0)
        || chebyshev(player.x, player.y, x, y) > TOOL_RANGE) {
        return { ok: false, reason: 'too_far', text: CANNOT_TEXT };
    }
    const tileMap = o.tileMap || null;
    const inst = o.inst || null;
    const spec = TOOL_ROLES[role];
    const flags = tileMap && typeof tileMap.flagsAt === 'function'
        ? tileMap.flagsAt(x, y, z) | 0
        : 0;
    const flagged = !!(spec && (flags & spec.flag));
    if (!flagged && !pinMatchesTool(inst, role)) {
        return { ok: false, reason: 'no_spot', text: CANNOT_TEXT };
    }
    let to = pinToolTo(inst);
    if (!to) {
        const delta = spec && spec.deltaZ != null ? spec.deltaZ : 0;
        to = { x, y, z: (z | 0) + delta };
    }
    if (!tileMap || typeof tileMap.getLayer !== 'function') {
        return { ok: false, reason: 'no_dest', text: TELEPORT_NO_DEST_TEXT };
    }
    if (!tileMap.getLayer(to.z)) {
        return { ok: false, reason: 'no_dest', text: TELEPORT_NO_DEST_TEXT };
    }
    if (!tileMap.moveEntityToTile(to.x, to.y, to.z, player, { reason: 'stair' })) {
        return { ok: false, reason: 'blocked', text: TELEPORT_NO_WAY_TEXT };
    }
    if (Array.isArray(player.path)) player.path = [];
    if (inst && typeof inst.transformOnUse === 'string' && inst.transformOnUse.trim()) {
        applyCatalogTransform(inst, inst.transformOnUse.trim());
    }
    return { ok: true, role, to };
}

function trapReady(entity, inst, now) {
    if (!inst || inst.kind !== 'trap' || inst.removed) return false;
    if (inst.used) return false;
    if (inst.trapReadyAt != null && Number.isFinite(Number(inst.trapReadyAt))
        && now < Number(inst.trapReadyAt)) {
        return false;
    }
    if (!evalWhen(entity, inst.once) || !evalWhen(entity, inst.when)) return false;
    return true;
}

function triggerWorldTrap(entity, inst, now) {
    if (!trapReady(entity, inst, now)) return { ok: false };
    const amount = inst.damage != null ? Math.floor(Number(inst.damage)) : 0;
    let damage = 0;
    if (amount >= 1 && entity && (entity.hp | 0) > 0) {
        damage = amount;
    }
    if (inst.set) applyStoragePatch(entity.storage || (entity.storage = Object.create(null)), inst.set);
    const cooldown = inst.cooldown != null && Number.isFinite(Number(inst.cooldown))
        ? Number(inst.cooldown)
        : 0;
    if (inst.shared) inst.used = true;
    if (cooldown > 0) inst.trapReadyAt = now + cooldown;
    const transformed = transformAfterUse(inst, inst.transformTo);
    return {
        ok: true,
        damage,
        field: inst.field || null,
        transformed
    };
}

function onWorldPinStep(entity, prevTile, nextTile, instances, nowSec) {
    if (!entity || !nextTile) return [];
    if (entity.downed || (entity.hp | 0) <= 0) return [];
    if (!prevTile) return [];
    const nx = Math.round(Number(nextTile.x));
    const ny = Math.round(Number(nextTile.y));
    const nz = nextTile.z != null ? nextTile.z | 0 : 0;
    const px = Math.round(Number(prevTile.x));
    const py = Math.round(Number(prevTile.y));
    const pz = prevTile.z != null ? prevTile.z | 0 : 0;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)
        || (nx === px && ny === py && (nz | 0) === (pz | 0))) {
        return [];
    }
    const now = nowSec != null ? Number(nowSec) : 0;
    const list = instances || [];
    const fired = [];
    for (let i = 0; i < list.length; i++) {
        const inst = list[i];
        if (!inst || inst.removed || inst.kind !== 'trap') continue;
        if ((inst.x | 0) !== nx || (inst.y | 0) !== ny || (inst.z | 0) !== nz) continue;
        const r = triggerWorldTrap(entity, inst, now);
        if (r.ok) fired.push({ inst, result: r });
    }
    return fired;
}

/** nowSec is World.logicNow (tickIndex / ups), not Date.now. */
function tickWorldPinCooldowns(instances, nowSec) {
    const now = Number(nowSec);
    if (!Number.isFinite(now)) return 0;
    const list = instances || [];
    let n = 0;
    for (let i = 0; i < list.length; i++) {
        const inst = list[i];
        if (!inst || inst.removed) continue;
        if (inst.kind === 'harvest' && inst.harvestReadyAt != null) {
            if (now < Number(inst.harvestReadyAt)) continue;
            inst.harvestReadyAt = null;
            inst.used = false;
            if (inst.catalogBase && inst.catalogId !== inst.catalogBase) {
                applyCatalogTransform(inst, inst.catalogBase);
            }
            n += 1;
        } else if (inst.kind === 'trap' && inst.trapReadyAt != null) {
            if (now < Number(inst.trapReadyAt)) continue;
            inst.trapReadyAt = null;
            inst.used = false;
            if (inst.catalogBase && inst.catalogId !== inst.catalogBase) {
                applyCatalogTransform(inst, inst.catalogBase);
            }
            n += 1;
        }
    }
    return n;
}

/** nowSec is World.logicNow (tickIndex / ups). decayAt is logic seconds. */
function tickWorldPinDecay(instances, nowSec, tileMap) {
    const now = Number(nowSec);
    if (!Number.isFinite(now)) return [];
    const list = instances || [];
    const changed = [];
    for (let i = 0; i < list.length; i++) {
        const inst = list[i];
        if (!inst || inst.removed || !inst.decay) continue;
        const sec = Number(inst.decay.sec);
        if (!Number.isFinite(sec) || sec <= 0) continue;
        if (inst.decayAt == null) inst.decayAt = now + sec;
        if (now < inst.decayAt) continue;
        const to = inst.decay.to != null ? String(inst.decay.to).trim() : '';
        inst.decay = null;
        inst.decayAt = null;
        if (to) {
            applyCatalogTransform(inst, to);
            changed.push({ inst, removed: false });
        } else {
            restoreWorldPinWalkBlock(tileMap, inst);
            inst.removed = true;
            changed.push({ inst, removed: true });
        }
    }
    return changed;
}

module.exports = {
    TOOL_ROLES,
    TOOL_RANGE,
    USE_RANGE,
    TELEPORT_NO_DEST_TEXT,
    TELEPORT_NO_WAY_TEXT,
    DOOR_LOCKED_TEXT,
    DOOR_CANNOT_PASS_TEXT,
    resolveToolRole,
    isWorldToolItem,
    pinInUseRange,
    useWorldChest,
    useWorldHarvest,
    useWorldDoor,
    setDoorOpen,
    useWorldTeleport,
    useWorldLever,
    useWorldPin,
    useWorldToolWith,
    onWorldPinStep,
    tickWorldPinCooldowns,
    tickWorldPinDecay,
    pinByPinId
};

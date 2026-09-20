/**
 * World ground-item store — player-dropped stacks (C7).
 *
 * Independent of any player inventory. Transfer remints uids (player `iN`
 * would collide on the floor). Stacks are bottom→top (last index = top).
 * Autostack merges same itemId on the dest tile. Range is Chebyshev ≤ 1
 * same z (server policy). HuntDL analog without clone-always-append,
 * engage-range path, or corpse/crate merge.
 */

'use strict';

const { MAX_STACK_SIZE, findItem, itemIsContainer, itemIsStackable, itemIsBackpackEquip, designerSlotToEngine } = require('./items');
const {
    createEmptyInventory,
    createItemInstance,
    destroyItem,
    getStackCount,
    serializeInventory,
    cloneInventory,
    firstFreeSlot,
    findFirstFreeSlotBfs,
    placeInContainer,
    placeInEquipment,
    moveItem,
    itemSubtreeWeight,
    canCarryAdditional,
    totalCarriedWeight,
    ownsContainer,
    resolveLocationUid,
    copyInstanceBudgets
} = require('./inventory');

const MAX_GROUND_RENDER = 10;
const GROUND_RANGE = 1;

function tileKey(x, y, z) {
    return `${z | 0}:${x | 0}:${y | 0}`;
}

function parseTileKey(key) {
    if (!key || typeof key !== 'string') return null;
    const parts = key.split(':');
    if (parts.length < 3) return null;
    const z = parseInt(parts[0], 10);
    const x = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { x, y, z };
}

function createGroundStore() {
    const inv = createEmptyInventory({ rootSlots: 0 });
    if (inv.containers[inv.rootUid]) {
        inv.containers[inv.rootUid].capacity = 0;
        inv.containers[inv.rootUid].slots = [];
    }
    return {
        inventory: inv,
        stacks: Object.create(null)
    };
}

function getStack(store, x, y, z) {
    if (!store || !store.stacks) return [];
    const stack = store.stacks[tileKey(x, y, z)];
    return Array.isArray(stack) ? stack : [];
}

function peekTop(store, x, y, z) {
    const stack = getStack(store, x, y, z);
    if (!stack.length) return null;
    return stack[stack.length - 1] || null;
}

function resolveStackUid(store, x, y, z, stackIndex) {
    const stack = getStack(store, x, y, z);
    if (!stack.length) return null;
    const idx = stackIndex | 0;
    if (idx < 0 || idx >= stack.length) return null;
    return stack[stack.length - 1 - idx] || null;
}

function getRenderableStack(store, x, y, z, maxRender) {
    const stack = getStack(store, x, y, z);
    const max =
        maxRender != null && Number.isFinite(Number(maxRender))
            ? Math.max(0, Math.floor(Number(maxRender)))
            : MAX_GROUND_RENDER;
    if (stack.length <= max) return stack.slice();
    return stack.slice(stack.length - max);
}

function cloneItemTree(srcInv, dstInv, rootUid) {
    if (!srcInv || !dstInv || !rootUid) return null;
    const root = srcInv.items[rootUid];
    if (!root) return null;
    const map = Object.create(null);

    function walkCreate(uid) {
        const inst = srcInv.items[uid];
        if (!inst) return;
        const newUid = createItemInstance(dstInv, inst.itemId, null, {
            count: getStackCount(inst)
        });
        map[uid] = newUid;
        const copy = dstInv.items[newUid];
        if (copy) copyInstanceBudgets(inst, copy);
        const srcCont = srcInv.containers[uid];
        if (srcCont) {
            const cap = Math.max(0, srcCont.capacity | 0);
            const slots = [];
            for (let i = 0; i < cap; i++) slots.push(null);
            dstInv.containers[newUid] = { capacity: cap, slots, isRoot: false };
            for (let i = 0; i < srcCont.slots.length; i++) {
                if (srcCont.slots[i]) walkCreate(srcCont.slots[i]);
            }
        }
    }

    walkCreate(rootUid);

    function walkWire(oldUid) {
        const newUid = map[oldUid];
        const srcCont = srcInv.containers[oldUid];
        if (!srcCont || !newUid) return;
        const dstCont = dstInv.containers[newUid];
        if (!dstCont) return;
        for (let i = 0; i < srcCont.slots.length; i++) {
            const childOld = srcCont.slots[i];
            if (!childOld) continue;
            const childNew = map[childOld];
            if (!childNew) continue;
            dstCont.slots[i] = childNew;
            const child = dstInv.items[childNew];
            if (child) {
                child.location = { kind: 'container', containerUid: newUid, index: i };
            }
            walkWire(childOld);
        }
    }

    walkWire(rootUid);
    const newRoot = map[rootUid];
    if (newRoot && dstInv.items[newRoot]) dstInv.items[newRoot].location = null;
    return newRoot || null;
}

function transferItemTree(srcInv, dstInv, rootUid, itemDb) {
    const newUid = cloneItemTree(srcInv, dstInv, rootUid);
    if (!newUid) return null;
    destroyItem(srcInv, rootUid, itemDb);
    return newUid;
}

function groundRootLocation(ground, uid) {
    if (!ground || !ground.inventory || !uid) return null;
    const seen = new Set();
    let cur = String(uid);
    while (cur && !seen.has(cur)) {
        seen.add(cur);
        const inst = ground.inventory.items[cur];
        if (!inst || !inst.location) return null;
        if (inst.location.kind === 'ground') {
            return {
                x: inst.location.x | 0,
                y: inst.location.y | 0,
                z: inst.location.z | 0,
                rootUid: cur
            };
        }
        if (inst.location.kind === 'container') {
            cur = String(inst.location.containerUid || '');
            continue;
        }
        return null;
    }
    return null;
}

function isGroundStoreItem(ground, uid) {
    return !!(ground && ground.inventory && uid && ground.inventory.items[uid]);
}

function removeFromTileStack(ground, uid, x, y, z) {
    const key = tileKey(x, y, z);
    const stack = ground.stacks[key];
    if (!Array.isArray(stack)) return false;
    const idx = stack.indexOf(uid);
    if (idx < 0) return false;
    stack.splice(idx, 1);
    if (stack.length === 0) delete ground.stacks[key];
    return true;
}

function pushToTileStack(ground, uid, x, y, z) {
    const key = tileKey(x, y, z);
    if (!ground.stacks[key]) ground.stacks[key] = [];
    ground.stacks[key].push(uid);
    const inst = ground.inventory.items[uid];
    if (inst) {
        inst.location = { kind: 'ground', x: x | 0, y: y | 0, z: z | 0 };
    }
}

function chebyshevSameFloor(ax, ay, az, bx, by, bz) {
    if ((az | 0) !== (bz | 0)) return Infinity;
    return Math.max(Math.abs((ax | 0) - (bx | 0)), Math.abs((ay | 0) - (by | 0)));
}

function inGroundRange(px, py, pz, x, y, z) {
    return chebyshevSameFloor(px, py, pz, x, y, z) <= GROUND_RANGE;
}

function findMergeUidOnTile(ground, x, y, z, itemId, exceptUid, itemDb) {
    const item = findItem(itemDb, itemId);
    if (item && !itemIsStackable(item)) return null;
    if (item && itemIsContainer(item)) return null;
    const stack = getStack(ground, x, y, z);
    for (let i = stack.length - 1; i >= 0; i--) {
        const uid = stack[i];
        if (!uid || uid === exceptUid) continue;
        const inst = ground.inventory.items[uid];
        if (!inst || inst.itemId !== itemId) continue;
        if (ground.inventory.containers[uid]) continue;
        if (getStackCount(inst) >= MAX_STACK_SIZE) continue;
        return uid;
    }
    return null;
}

function mergeOntoTile(ground, uid, x, y, z, itemDb) {
    const inst = ground.inventory.items[uid];
    if (!inst) return { ok: false, error: 'unknown_item' };
    const other = findMergeUidOnTile(ground, x, y, z, inst.itemId, uid, itemDb);
    if (!other) return { ok: true, uid, merged: false };
    const dest = ground.inventory.items[other];
    const room = Math.max(0, MAX_STACK_SIZE - getStackCount(dest));
    if (room <= 0) return { ok: true, uid, merged: false };
    const take = Math.min(room, getStackCount(inst));
    dest.count = getStackCount(dest) + take;
    const left = getStackCount(inst) - take;
    if (left <= 0) {
        removeFromTileStack(ground, uid, x, y, z);
        destroyItem(ground.inventory, uid, itemDb);
        return { ok: true, uid: other, merged: true };
    }
    inst.count = left;
    return { ok: true, uid, merged: true, partial: true };
}

function subtreeContainerUids(inv, rootUid) {
    const out = [];
    function walk(uid) {
        if (!uid || !inv.containers[uid]) return;
        out.push(uid);
        const cont = inv.containers[uid];
        for (let i = 0; i < cont.slots.length; i++) {
            if (cont.slots[i]) walk(cont.slots[i]);
        }
    }
    walk(rootUid);
    return out;
}

function serializeGroundStore(store) {
    if (!store || !store.inventory) {
        return { version: 1, nextUid: 1, items: {}, containers: {}, stacks: {} };
    }
    const inv = serializeInventory(store.inventory);
    const stacks = Object.create(null);
    const keys = Object.keys(store.stacks || {});
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const list = store.stacks[k];
        if (Array.isArray(list) && list.length) stacks[k] = list.slice();
    }
    return {
        version: 1,
        nextUid: inv.nextUid | 0,
        items: inv.items || {},
        containers: inv.containers || {},
        stacks
    };
}

function loadGroundStore(blob) {
    const store = createGroundStore();
    if (!blob || typeof blob !== 'object') return store;
    const rawInv = {
        nextUid: Math.max(1, blob.nextUid | 0),
        items: blob.items && typeof blob.items === 'object' && !Array.isArray(blob.items)
            ? blob.items
            : {},
        containers: blob.containers && typeof blob.containers === 'object' ? blob.containers : {},
        rootUid: store.inventory.rootUid,
        equipment: {}
    };
    store.inventory = cloneInventory(rawInv);
    if (store.inventory.containers[store.inventory.rootUid]) {
        store.inventory.containers[store.inventory.rootUid].capacity = 0;
        store.inventory.containers[store.inventory.rootUid].slots = [];
        store.inventory.containers[store.inventory.rootUid].isRoot = true;
    }
    store.inventory.equipment = Object.create(null);
    const stacks = blob.stacks && typeof blob.stacks === 'object' ? blob.stacks : {};
    const keys = Object.keys(stacks);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const list = stacks[k];
        if (!Array.isArray(list) || !list.length) continue;
        const kept = [];
        for (let j = 0; j < list.length; j++) {
            const uid = list[j] != null ? String(list[j]) : '';
            if (!uid || !store.inventory.items[uid]) continue;
            kept.push(uid);
            const inst = store.inventory.items[uid];
            const pos = parseTileKey(k);
            inst.location = pos
                ? { kind: 'ground', x: pos.x, y: pos.y, z: pos.z }
                : inst.location;
        }
        if (kept.length) store.stacks[k] = kept;
    }
    return store;
}

function listGroundTiles(store) {
    if (!store || !store.stacks) return [];
    return Object.keys(store.stacks).filter(
        (k) => Array.isArray(store.stacks[k]) && store.stacks[k].length > 0
    );
}

function isEquippedBackpackLoc(inv, loc) {
    if (!inv || !loc || loc.kind !== 'equipment') return false;
    const slot = designerSlotToEngine(loc.slot) || loc.slot;
    return slot === 'backpack';
}

function dropToGround(opts) {
    const o = opts || {};
    const ground = o.ground;
    const playerInv = o.playerInv;
    const from = o.from;
    const x = o.x | 0;
    const y = o.y | 0;
    const z = o.z | 0;
    const itemDb = o.itemDb || null;
    if (!ground || !playerInv || !from) return { ok: false, error: 'bad_args' };
    if (isEquippedBackpackLoc(playerInv, from)) {
        return { ok: false, error: 'equipped_backpack' };
    }
    const uid = resolveLocationUid(playerInv, from);
    if (!uid) return { ok: false, error: 'empty_source' };
    const inst = playerInv.items[uid];
    if (!inst) return { ok: false, error: 'unknown_item' };
    const total = getStackCount(inst);
    let n = total;
    const amount = Math.floor(Number(o.count));
    if (Number.isFinite(amount) && amount >= 1 && amount < total) {
        const item = findItem(itemDb, inst.itemId);
        if (itemIsStackable(item)) n = amount;
    }
    const partial = n < total;
    let groundUid;
    if (partial) {
        groundUid = createItemInstance(ground.inventory, inst.itemId, itemDb, { count: n });
        if (!groundUid) return { ok: false, error: 'transfer_failed' };
        inst.count = total - n;
        if (getStackCount(inst) <= 1 && inst.count != null) {
            if (getStackCount(inst) === 1) delete inst.count;
        }
    } else {
        groundUid = transferItemTree(playerInv, ground.inventory, uid, itemDb);
        if (!groundUid) return { ok: false, error: 'transfer_failed' };
    }
    pushToTileStack(ground, groundUid, x, y, z);
    const merged = mergeOntoTile(ground, groundUid, x, y, z, itemDb);
    return {
        ok: true,
        groundUid: merged.uid || groundUid,
        merged: !!merged.merged,
        fromUid: uid,
        closedUids: partial ? [] : subtreeContainerUids(ground.inventory, merged.uid || groundUid)
    };
}

function pickupFromGround(opts) {
    const o = opts || {};
    const ground = o.ground;
    const playerInv = o.playerInv;
    const player = o.player;
    const x = o.x | 0;
    const y = o.y | 0;
    const z = o.z | 0;
    const itemDb = o.itemDb || null;
    if (!ground || !playerInv) return { ok: false, error: 'bad_args' };
    const uid = o.uid || resolveStackUid(ground, x, y, z, o.stackIndex | 0);
    if (!uid) return { ok: false, error: 'empty_source' };
    const gInst = ground.inventory.items[uid];
    if (!gInst) return { ok: false, error: 'unknown_item' };
    const root = gInst.location && gInst.location.kind === 'ground'
        ? { x, y, z, rootUid: uid }
        : groundRootLocation(ground, uid);
    if (!root) return { ok: false, error: 'not_on_ground' };

    const total = getStackCount(gInst);
    let n = total;
    const amount = Math.floor(Number(o.count));
    if (Number.isFinite(amount) && amount >= 1 && amount < total) {
        const item = findItem(itemDb, gInst.itemId);
        if (itemIsStackable(item)) n = amount;
    }
    const treeW = n < total
        ? (itemSubtreeWeight(ground.inventory, uid, itemDb) / Math.max(1, total)) * n
        : itemSubtreeWeight(ground.inventory, uid, itemDb);
    if (player) {
        const level = player.level != null ? player.level : 1;
        const classId = player.vocation || player.classId || null;
        const current = totalCarriedWeight(playerInv, itemDb);
        if (!canCarryAdditional(level, current, treeW, classId)) {
            return { ok: false, error: 'not_enough_cap' };
        }
    }

    const closedUids = n >= total ? subtreeContainerUids(ground.inventory, uid) : [];
    let moveUid = uid;
    const onTile = !!(gInst.location && gInst.location.kind === 'ground');
    if (n < total) {
        moveUid = createItemInstance(ground.inventory, gInst.itemId, itemDb, { count: n });
        if (!moveUid) return { ok: false, error: 'transfer_failed' };
        gInst.count = total - n;
        if (getStackCount(gInst) === 1) delete gInst.count;
        ground.inventory.items[moveUid].location = null;
    } else if (onTile) {
        removeFromTileStack(ground, uid, root.x, root.y, root.z);
        gInst.location = null;
    } else {
        const loc = gInst.location;
        if (loc && loc.kind === 'container') {
            const cont = ground.inventory.containers[loc.containerUid];
            if (cont && cont.slots[loc.index] === uid) cont.slots[loc.index] = null;
        }
        gInst.location = null;
    }

    const playerUid = transferItemTree(ground.inventory, playerInv, moveUid, itemDb);
    if (!playerUid) {
        if (n >= total && onTile) pushToTileStack(ground, uid, root.x, root.y, root.z);
        return { ok: false, error: 'transfer_failed' };
    }

    const placed = placePickedItem(playerInv, playerUid, o.to, itemDb);
    if (!placed.ok) {
        const back = transferItemTree(playerInv, ground.inventory, playerUid, itemDb);
        if (back && onTile) pushToTileStack(ground, back, root.x, root.y, root.z);
        return { ok: false, error: placed.error || 'no_room' };
    }
    return { ok: true, playerUid: placed.uid || playerUid, closedUids, equipped: !!placed.equipped };
}

function placePickedItem(playerInv, uid, to, itemDb) {
    if (to && to.kind === 'equipment') {
        const r = placeInEquipment(playerInv, uid, to.slot, itemDb);
        if (!r.ok) return r;
        return { ok: true, uid, equipped: true };
    }
    const destId = to && (to.containerUid || to.containerId);
    const explicit = to && to.kind === 'container' && destId
        && destId !== 'root' && destId !== playerInv.rootUid
        && to.index != null && Number.isFinite(Number(to.index));
    if (explicit && ownsContainer(playerInv, destId)) {
        const r = placeInContainer(playerInv, uid, destId, to.index | 0, itemDb);
        return r.ok ? { ok: true, uid: r.uid || uid } : r;
    }
    const start = playerInv.rootUid;
    const queue = [start];
    const seen = new Set();
    while (queue.length) {
        const cuid = queue.shift();
        if (!cuid || seen.has(cuid)) continue;
        seen.add(cuid);
        const placed = placeInContainer(playerInv, uid, cuid, null, itemDb);
        if (placed.ok) return { ok: true, uid: placed.uid || uid };
        const cont = playerInv.containers[cuid];
        if (!cont) continue;
        for (let i = 0; i < cont.slots.length; i++) {
            const child = cont.slots[i];
            if (child && playerInv.containers[child]) queue.push(child);
        }
    }
    const free = findFirstFreeSlotBfs(playerInv, start);
    if (!free) return { ok: false, error: 'full' };
    return placeInContainer(playerInv, uid, free.containerUid, free.index, itemDb);
}

function slideGroundItem(opts) {
    const o = opts || {};
    const ground = o.ground;
    const itemDb = o.itemDb || null;
    const x0 = o.fromX | 0;
    const y0 = o.fromY | 0;
    const z0 = o.fromZ | 0;
    const x1 = o.toX | 0;
    const y1 = o.toY | 0;
    const z1 = o.toZ | 0;
    if (!ground) return { ok: false, error: 'bad_args' };
    if (x0 === x1 && y0 === y1 && (z0 | 0) === (z1 | 0)) {
        return { ok: true, groundUid: o.uid || peekTop(ground, x0, y0, z0), same: true };
    }
    const uid = o.uid || resolveStackUid(ground, x0, y0, z0, o.stackIndex | 0);
    if (!uid) return { ok: false, error: 'empty_source' };
    const inst = ground.inventory.items[uid];
    if (!inst || !inst.location || inst.location.kind !== 'ground') {
        return { ok: false, error: 'not_on_ground' };
    }
    const total = getStackCount(inst);
    let n = total;
    const amount = Math.floor(Number(o.count));
    if (Number.isFinite(amount) && amount >= 1 && amount < total) {
        const item = findItem(itemDb, inst.itemId);
        if (itemIsStackable(item)) n = amount;
    }
    if (n < total) {
        const splitUid = createItemInstance(ground.inventory, inst.itemId, itemDb, { count: n });
        if (!splitUid) return { ok: false, error: 'transfer_failed' };
        inst.count = total - n;
        if (getStackCount(inst) === 1) delete inst.count;
        pushToTileStack(ground, splitUid, x1, y1, z1);
        const merged = mergeOntoTile(ground, splitUid, x1, y1, z1, itemDb);
        return { ok: true, groundUid: merged.uid || splitUid, merged: !!merged.merged };
    }
    removeFromTileStack(ground, uid, x0, y0, z0);
    pushToTileStack(ground, uid, x1, y1, z1);
    const merged = mergeOntoTile(ground, uid, x1, y1, z1, itemDb);
    return { ok: true, groundUid: merged.uid || uid, merged: !!merged.merged };
}

function visibleGroundSlots(store, x, y, z) {
    const vis = getRenderableStack(store, x, y, z);
    const out = [];
    for (let i = 0; i < vis.length; i++) {
        const uid = vis[vis.length - 1 - i];
        const inst = store.inventory.items[uid];
        if (!inst) continue;
        const item = findItem(null, inst.itemId);
        out.push({
            x: x | 0,
            y: y | 0,
            z: z | 0,
            stackIndex: i,
            uid,
            id: inst.itemId,
            count: getStackCount(inst),
            flags: (itemIsContainer(item) || store.inventory.containers[uid]) ? 1 : 0
        });
    }
    return out;
}

function groundFlagsForUid(store, uid, itemDb) {
    if (!store || !uid) return 0;
    const inst = store.inventory.items[uid];
    if (!inst) return 0;
    const item = findItem(itemDb, inst.itemId);
    if (itemIsContainer(item) || store.inventory.containers[uid]) return 1;
    return 0;
}

function locIsPlayer(inv, loc) {
    if (!loc) return false;
    if (loc.kind === 'equipment') return true;
    if (loc.kind !== 'container') return false;
    const id = loc.containerUid || loc.containerId;
    if (!id || id === 'root') return true;
    return ownsContainer(inv, id);
}

function locIsGroundContainer(ground, loc) {
    if (!loc || loc.kind !== 'container' || !ground || !ground.inventory) return false;
    const id = loc.containerUid || loc.containerId;
    if (!id || id === 'root' || id === ground.inventory.rootUid) return false;
    return !!(id && ownsContainer(ground.inventory, id) && ground.inventory.items[id]);
}

function playerLoc(inv, loc) {
    if (!loc) return loc;
    if (loc.kind !== 'container') return loc;
    const id = loc.containerUid || loc.containerId;
    if (!id || id === 'root') {
        return { kind: 'container', containerUid: inv.rootUid, index: loc.index | 0 };
    }
    return { kind: 'container', containerUid: id, index: loc.index | 0 };
}

/**
 * One MOVE_ITEM involving the ground store (tile and/or open ground bag).
 */
function moveWithGround(opts) {
    const o = opts || {};
    const ground = o.ground;
    const playerInv = o.playerInv;
    const from = o.from;
    const to = o.to;
    if (!ground || !playerInv || !from || !to) return { ok: false, error: 'bad_args' };

    const fromTile = from.kind === 'tile';
    const toTile = to.kind === 'tile';
    const fromGCont = locIsGroundContainer(ground, from);
    const toGCont = locIsGroundContainer(ground, to);
    const fromPlayer = locIsPlayer(playerInv, from);
    const toPlayer = locIsPlayer(playerInv, to);

    if (fromTile && toTile) {
        return Object.assign(slideGroundItem({
            ground,
            fromX: from.x,
            fromY: from.y,
            fromZ: from.z,
            toX: to.x,
            toY: to.y,
            toZ: to.z,
            stackIndex: from.stackIndex,
            count: o.count,
            itemDb: o.itemDb
        }), { fromTile: { x: from.x | 0, y: from.y | 0, z: from.z | 0 }, toTile: { x: to.x | 0, y: to.y | 0, z: to.z | 0 } });
    }

    if (fromPlayer && toTile) {
        const r = dropToGround({
            ground,
            playerInv,
            from: playerLoc(playerInv, from),
            x: to.x,
            y: to.y,
            z: to.z,
            count: o.count,
            itemDb: o.itemDb
        });
        r.toTile = { x: to.x | 0, y: to.y | 0, z: to.z | 0 };
        return r;
    }

    if (fromTile && toPlayer) {
        const r = pickupFromGround({
            ground,
            playerInv,
            player: o.player,
            x: from.x,
            y: from.y,
            z: from.z,
            stackIndex: from.stackIndex,
            count: o.count,
            to: playerLoc(playerInv, to),
            itemDb: o.itemDb
        });
        r.fromTile = { x: from.x | 0, y: from.y | 0, z: from.z | 0 };
        return r;
    }

    if (fromGCont && toPlayer) {
        const uid = resolveLocationUid(ground.inventory, playerLoc(ground.inventory, from));
        if (!uid) return { ok: false, error: 'empty_source' };
        const root = groundRootLocation(ground, uid);
        const r = pickupFromGround({
            ground,
            playerInv,
            player: o.player,
            uid,
            x: root ? root.x : 0,
            y: root ? root.y : 0,
            z: root ? root.z : 0,
            count: o.count,
            to: playerLoc(playerInv, to),
            itemDb: o.itemDb
        });
        if (root) r.fromTile = { x: root.x, y: root.y, z: root.z };
        return r;
    }

    if (fromPlayer && toGCont) {
        const destUid = to.containerUid || to.containerId;
        const root = groundRootLocation(ground, destUid);
        if (!root) return { ok: false, error: 'not_on_ground' };
        const srcUid = resolveLocationUid(playerInv, playerLoc(playerInv, from));
        if (!srcUid) return { ok: false, error: 'empty_source' };
        const r = dropToGround({
            ground,
            playerInv,
            from: playerLoc(playerInv, from),
            x: root.x,
            y: root.y,
            z: root.z,
            count: o.count,
            itemDb: o.itemDb
        });
        if (!r.ok) return r;
        const gUid = r.groundUid;
        const inst = ground.inventory.items[gUid];
        if (inst && inst.location && inst.location.kind === 'ground') {
            removeFromTileStack(ground, gUid, root.x, root.y, root.z);
            inst.location = null;
            const placed = placeInContainer(
                ground.inventory,
                gUid,
                destUid,
                to.index != null ? to.index | 0 : null,
                o.itemDb
            );
            if (!placed.ok) {
                pushToTileStack(ground, gUid, root.x, root.y, root.z);
                return { ok: false, error: placed.error || 'full' };
            }
        }
        r.toTile = { x: root.x, y: root.y, z: root.z };
        return r;
    }

    if (fromGCont && toTile) {
        const uid = resolveLocationUid(ground.inventory, playerLoc(ground.inventory, from));
        if (!uid) return { ok: false, error: 'empty_source' };
        const inst = ground.inventory.items[uid];
        const loc = inst && inst.location;
        if (loc && loc.kind === 'container') {
            const cont = ground.inventory.containers[loc.containerUid];
            if (cont && cont.slots[loc.index] === uid) cont.slots[loc.index] = null;
            inst.location = null;
        }
        pushToTileStack(ground, uid, to.x | 0, to.y | 0, to.z | 0);
        const merged = mergeOntoTile(ground, uid, to.x | 0, to.y | 0, to.z | 0, o.itemDb);
        const root = groundRootLocation(ground, merged.uid || uid);
        return {
            ok: true,
            groundUid: merged.uid || uid,
            fromTile: root ? { x: root.x, y: root.y, z: root.z } : null,
            toTile: { x: to.x | 0, y: to.y | 0, z: to.z | 0 }
        };
    }

    if (fromTile && toGCont) {
        const destUid = to.containerUid || to.containerId;
        const root = groundRootLocation(ground, destUid);
        if (!root) return { ok: false, error: 'not_on_ground' };
        const uid = resolveStackUid(ground, from.x, from.y, from.z, from.stackIndex | 0);
        if (!uid) return { ok: false, error: 'empty_source' };
        const inst = ground.inventory.items[uid];
        if (!inst || inst.location.kind !== 'ground') return { ok: false, error: 'not_on_ground' };
        removeFromTileStack(ground, uid, from.x | 0, from.y | 0, from.z | 0);
        inst.location = null;
        const placed = placeInContainer(
            ground.inventory,
            uid,
            destUid,
            to.index != null ? to.index | 0 : null,
            o.itemDb
        );
        if (!placed.ok) {
            pushToTileStack(ground, uid, from.x | 0, from.y | 0, from.z | 0);
            return { ok: false, error: placed.error || 'full' };
        }
        return {
            ok: true,
            groundUid: placed.uid || uid,
            fromTile: { x: from.x | 0, y: from.y | 0, z: from.z | 0 },
            toTile: { x: root.x, y: root.y, z: root.z }
        };
    }

    if (fromGCont && toGCont) {
        const r = moveItem(
            ground.inventory,
            playerLoc(ground.inventory, from),
            playerLoc(ground.inventory, to),
            o.itemDb,
            o.count
        );
        const root = groundRootLocation(ground, from.containerUid || from.containerId);
        if (root) r.fromTile = { x: root.x, y: root.y, z: root.z };
        return r;
    }

    return { ok: false, error: 'bad_args' };
}

module.exports = {
    MAX_GROUND_RENDER,
    GROUND_RANGE,
    tileKey,
    parseTileKey,
    createGroundStore,
    getStack,
    peekTop,
    resolveStackUid,
    getRenderableStack,
    cloneItemTree,
    transferItemTree,
    groundRootLocation,
    isGroundStoreItem,
    removeFromTileStack,
    pushToTileStack,
    inGroundRange,
    chebyshevSameFloor,
    findMergeUidOnTile,
    mergeOntoTile,
    subtreeContainerUids,
    serializeGroundStore,
    loadGroundStore,
    listGroundTiles,
    isEquippedBackpackLoc,
    dropToGround,
    pickupFromGround,
    slideGroundItem,
    visibleGroundSlots,
    groundFlagsForUid,
    locIsPlayer,
    locIsGroundContainer,
    moveWithGround,
    itemIsBackpackEquip,
    firstFreeSlot
};

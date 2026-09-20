'use strict';

const {
    MAX_STACK_SIZE,
    DEFAULT_ROOT_SLOTS,
    ROOT_UID,
    DEFAULT_BACKPACK_ITEM_ID,
    UNARMED_ATK,
    UNARMED_WEAPON_DEFENSE,
    BOW_MITIGATION_DEFENSE,
    EQUIPMENT_SLOTS,
    findItem,
    itemIsContainer,
    itemIsBackpackEquip,
    itemIsStackable,
    itemIsAmmo,
    itemIsQuiver,
    itemIsShield,
    itemIsTwoHanded,
    itemIsBowOrCrossbowWeapon,
    itemIsThrowingWeapon,
    itemIsMagicWeapon,
    itemIsWeapon,
    itemBreakChance,
    normalizeAutoShape,
    itemAmmoKind,
    weaponRequiredAmmoKind,
    canEquipInSlot,
    preferredEquipSlot,
    containerCapacity,
    canonicalEquipmentSlot,
    engineSlotToDesigner,
    designerSlotToEngine,
    resolveWeaponSkillFromItem,
    computeMitigationPercent,
    computeMaxBlock,
    skillValue,
    DEFAULT_RESISTS,
    pipelineToPercent,
    stackResists
} = require('./items');

const CAP_CLASS_BAND = Object.freeze({
    guardian: 'guardian',
    knight: 'guardian',
    mystic: 'mystic',
    monk: 'mystic',
    scout: 'scout',
    paladin: 'scout',
    adept: 'adept',
    sorcerer: 'adept',
    warden: 'warden',
    druid: 'warden',
    adventurer: 'adventurer',
    none: 'adventurer'
});

function emptySlots(n) {
    const cap = Math.max(0, Math.floor(n) || 0);
    const slots = [];
    for (let i = 0; i < cap; i++) slots.push(null);
    return slots;
}

function createEmptyInventory(opts) {
    const o = opts || {};
    const capacity = o.rootSlots != null && Number.isFinite(Number(o.rootSlots))
        ? Math.max(0, Math.floor(Number(o.rootSlots)))
        : 0;
    const inv = {
        nextUid: 1,
        items: Object.create(null),
        containers: Object.create(null),
        rootUid: ROOT_UID,
        equipment: Object.create(null),
        totalWeight: 0
    };
    inv.containers[ROOT_UID] = {
        capacity,
        slots: emptySlots(capacity),
        isRoot: true
    };
    return inv;
}

function isRuntimeInventory(inv) {
    return !!(
        inv &&
        typeof inv === 'object' &&
        inv.items &&
        typeof inv.items === 'object' &&
        !Array.isArray(inv.items) &&
        inv.containers &&
        typeof inv.containers === 'object'
    );
}

function allocUid(inv) {
    const uid = 'i' + inv.nextUid;
    inv.nextUid += 1;
    return uid;
}

function getStackCount(inst) {
    if (!inst) return 0;
    if (inst.count == null || inst.count === '') return 1;
    const n = Math.floor(Number(inst.count));
    if (!Number.isFinite(n)) return 1;
    return Math.max(0, n);
}

function setStackCount(inst, count) {
    if (!inst) return;
    const n = Math.floor(Number(count) || 0);
    inst.count = n < 1 ? 0 : Math.min(MAX_STACK_SIZE, n);
}

function stackRoom(inst) {
    return Math.max(0, MAX_STACK_SIZE - getStackCount(inst));
}

function instanceWeight(inst, item) {
    if (!inst) return 0;
    let unit = 0;
    if (item && item.weight != null) {
        unit = Number(item.weight) || 0;
    } else if (inst.unitWeight != null) {
        unit = Number(inst.unitWeight) || 0;
    } else if (inst.weight != null) {
        unit = Number(inst.weight) || 0;
    } else {
        const fallback = findItem(null, inst.itemId);
        unit = fallback && fallback.weight != null ? Number(fallback.weight) || 0 : 0;
    }
    return unit * getStackCount(inst);
}

function createItemInstance(inv, itemId, itemDb, opts) {
    if (!inv || itemId == null || String(itemId).trim() === '') {
        throw new Error('createItemInstance: inv and itemId required');
    }
    const id = String(itemId).trim();
    const uid = allocUid(inv);
    const o = opts && typeof opts === 'object' ? opts : {};
    let count = 1;
    if (o.count != null && Number.isFinite(Number(o.count))) {
        count = Math.max(1, Math.floor(Number(o.count)));
    }
    const item = findItem(itemDb, id);
    if (count > 1 && item && !itemIsStackable(item)) count = 1;
    if ((itemIsStackable(item) || !item) && count > MAX_STACK_SIZE) count = MAX_STACK_SIZE;
    const unitWeight = item && item.weight != null
        ? Number(item.weight) || 0
        : (findItem(null, id) && findItem(null, id).weight != null ? Number(findItem(null, id).weight) || 0 : 0);
    const inst = { uid, itemId: id, location: null, unitWeight };
    if (count > 1) inst.count = count;
    seedInstanceBudgets(inst, item, o);
    inv.items[uid] = inst;
    if (itemIsContainer(item) || (item && itemIsBackpackEquip(item))) {
        const cap = containerCapacity(item, itemDb);
        inv.containers[uid] = {
            capacity: cap,
            slots: emptySlots(cap),
            isRoot: false
        };
    }
    if (typeof inv.totalWeight === 'number') {
        inv.totalWeight += unitWeight * count;
    }
    return uid;
}

function firstFreeSlot(cont) {
    if (!cont || !Array.isArray(cont.slots)) return -1;
    for (let i = 0; i < cont.slots.length; i++) {
        if (cont.slots[i] == null) return i;
    }
    return -1;
}

function findFirstFreeSlotBfs(inv, startUid) {
    if (!inv) return null;
    const start = startUid != null && String(startUid) !== '' ? String(startUid) : inv.rootUid;
    const queue = [start];
    const seen = new Set();
    while (queue.length) {
        const cuid = queue.shift();
        if (!cuid || seen.has(cuid)) continue;
        seen.add(cuid);
        const cont = inv.containers[cuid];
        if (!cont) continue;
        const free = firstFreeSlot(cont);
        if (free >= 0) return { containerUid: cuid, index: free };
        for (let i = 0; i < cont.slots.length; i++) {
            const child = cont.slots[i];
            if (child && inv.containers[child]) queue.push(child);
        }
    }
    return null;
}

function detachItem(inv, uid) {
    const inst = inv.items[uid];
    if (!inst) return false;
    const loc = inst.location;
    if (!loc) return true;
    if (loc.kind === 'equipment') {
        if (inv.equipment[loc.slot] === uid) delete inv.equipment[loc.slot];
    } else if (loc.kind === 'container') {
        const cont = inv.containers[loc.containerUid];
        if (cont && cont.slots[loc.index] === uid) cont.slots[loc.index] = null;
    }
    inst.location = null;
    return true;
}

function destroyItem(inv, uid, itemDb) {
    const inst = inv.items[uid];
    if (!inst) return false;
    const cont = inv.containers[uid];
    if (cont) {
        for (let i = 0; i < cont.slots.length; i++) {
            if (cont.slots[i]) destroyItem(inv, cont.slots[i], itemDb);
        }
        delete inv.containers[uid];
    }
    detachItem(inv, uid);
    if (typeof inv.totalWeight === 'number') {
        const item = itemDb ? findItem(itemDb, inst.itemId) : null;
        const w = instanceWeight(inst, item);
        inv.totalWeight = Math.max(0, inv.totalWeight - w);
    }
    delete inv.items[uid];
    return true;
}

function isInsideSubtree(inv, containerUid, ancestorUid) {
    if (!containerUid || !ancestorUid) return false;
    if (containerUid === ancestorUid) return true;
    if (containerUid === ROOT_UID) return false;
    const inst = inv.items[containerUid];
    if (!inst || !inst.location) return false;
    if (inst.location.kind === 'container') {
        return isInsideSubtree(inv, inst.location.containerUid, ancestorUid);
    }
    return false;
}

function canMergeStacks(inv, uidA, uidB, itemDb) {
    if (!inv || !uidA || !uidB || uidA === uidB) return false;
    const a = inv.items[uidA];
    const b = inv.items[uidB];
    if (!a || !b || a.itemId !== b.itemId) return false;
    if (inv.containers[uidA] || inv.containers[uidB]) return false;
    const item = findItem(itemDb, a.itemId);
    if (item && !itemIsStackable(item)) return false;
    if (!item && a.itemId !== b.itemId) return false;
    return stackRoom(b) > 0;
}

function mergeStacks(inv, sourceUid, destUid, itemDb, maxTake) {
    if (!inv || !sourceUid || !destUid || sourceUid === destUid) return false;
    const src = inv.items[sourceUid];
    const dst = inv.items[destUid];
    if (!src || !dst) return false;
    const room = stackRoom(dst);
    if (room <= 0) return false;
    let take = Math.min(getStackCount(src), room);
    if (maxTake != null && Number.isFinite(Number(maxTake))) {
        take = Math.min(take, Math.max(0, Math.floor(Number(maxTake))));
    }
    if (take <= 0) return false;
    setStackCount(dst, getStackCount(dst) + take);
    const left = getStackCount(src) - take;
    setStackCount(src, left);
    if (left <= 0) destroyItem(inv, sourceUid, itemDb);
    return true;
}

function findStackInContainer(inv, containerUid, itemId, exceptUid) {
    const cont = inv.containers[containerUid];
    if (!cont || !itemId) return null;
    const id = String(itemId);
    let best = null;
    let bestRoom = 0;
    for (let i = 0; i < cont.slots.length; i++) {
        const uid = cont.slots[i];
        if (!uid || uid === exceptUid) continue;
        const inst = inv.items[uid];
        if (!inst || inst.itemId !== id || inv.containers[uid]) continue;
        const room = stackRoom(inst);
        if (room > bestRoom) {
            bestRoom = room;
            best = uid;
        }
    }
    return best;
}

function placeInContainer(inv, uid, containerUid, index, itemDb) {
    const inst = inv.items[uid];
    if (!inst) return { ok: false, error: 'unknown_item' };
    if (inst.location) return { ok: false, error: 'still_attached' };
    const cont = inv.containers[containerUid];
    if (!cont) return { ok: false, error: 'unknown_container' };
    if (inv.containers[uid] && isInsideSubtree(inv, containerUid, uid)) {
        return { ok: false, error: 'cycle' };
    }
    const explicitIndex = index != null && Number.isFinite(Number(index))
        ? Math.floor(Number(index))
        : null;
    if (explicitIndex == null && itemDb != null) {
        const item = findItem(itemDb, inst.itemId);
        if (itemIsStackable(item) || !item) {
            while (inv.items[uid] && getStackCount(inv.items[uid]) > 0) {
                const existing = findStackInContainer(inv, containerUid, inst.itemId, uid);
                if (!existing || !canMergeStacks(inv, uid, existing, itemDb)) break;
                mergeStacks(inv, uid, existing, itemDb);
                if (!inv.items[uid]) {
                    const dest = inv.items[existing];
                    const destIndex = dest && dest.location && dest.location.kind === 'container'
                        ? dest.location.index
                        : undefined;
                    return { ok: true, merged: true, uid: existing, index: destIndex };
                }
            }
        }
    }
    let idx = explicitIndex != null ? explicitIndex : firstFreeSlot(cont);
    if (idx < 0 || idx >= cont.capacity) {
        return { ok: false, error: explicitIndex != null ? 'invalid_index' : 'full' };
    }
    if (cont.slots[idx] != null) {
        const occ = cont.slots[idx];
        if (occ && canMergeStacks(inv, uid, occ, itemDb)) {
            mergeStacks(inv, uid, occ, itemDb);
            if (!inv.items[uid]) return { ok: true, merged: true, uid: occ, index: idx };
            idx = firstFreeSlot(cont);
            if (idx < 0) return { ok: false, error: 'full' };
        } else if (explicitIndex == null) {
            idx = firstFreeSlot(cont);
            if (idx < 0) return { ok: false, error: 'full' };
        } else {
            return { ok: false, error: 'occupied' };
        }
    }
    const live = inv.items[uid];
    if (!live) return { ok: true, merged: true, uid: null, index: idx };
    cont.slots[idx] = uid;
    live.location = { kind: 'container', containerUid, index: idx };
    return { ok: true, index: idx, uid };
}

function placeInEquipment(inv, uid, engineSlot, itemDb) {
    const inst = inv.items[uid];
    if (!inst) return { ok: false, error: 'unknown_item' };
    if (inst.location) return { ok: false, error: 'still_attached' };
    const slot = canonicalEquipmentSlot(engineSlot) || engineSlot;
    if (!slot) return { ok: false, error: 'invalid_slot' };
    const item = findItem(itemDb, inst.itemId);
    if (item && !canEquipInSlot(item, slot)) return { ok: false, error: 'wrong_slot' };
    if (!item && slot !== 'backpack') {
        const pref = preferredEquipSlot({ slot: item && item.slot });
        if (pref && pref !== slot) return { ok: false, error: 'wrong_slot' };
    }
    if (inv.equipment[slot]) return { ok: false, error: 'occupied' };
    inv.equipment[slot] = uid;
    inst.location = { kind: 'equipment', slot };
    return { ok: true };
}

function syncRootToEquippedBackpack(inv) {
    if (!inv) return ROOT_UID;
    const bpUid = inv.equipment && inv.equipment.backpack;
    if (bpUid && inv.containers[bpUid]) {
        inv.rootUid = bpUid;
        inv.containers[bpUid].isRoot = true;
        if (inv.containers[ROOT_UID] && ROOT_UID !== bpUid) {
            inv.containers[ROOT_UID].isRoot = false;
        }
        return bpUid;
    }
    inv.rootUid = ROOT_UID;
    if (!inv.containers[ROOT_UID]) {
        inv.containers[ROOT_UID] = { capacity: 0, slots: emptySlots(0), isRoot: true };
    } else {
        inv.containers[ROOT_UID].capacity = 0;
        inv.containers[ROOT_UID].slots = emptySlots(0);
        inv.containers[ROOT_UID].isRoot = true;
    }
    return ROOT_UID;
}

function ensureEquippedBackpack(inv, itemDb, itemId) {
    if (!inv) return null;
    if (inv.equipment && inv.equipment.backpack) {
        syncRootToEquippedBackpack(inv);
        return inv.equipment.backpack;
    }
    const id = itemId != null && String(itemId).trim() !== ''
        ? String(itemId).trim()
        : DEFAULT_BACKPACK_ITEM_ID;
    const template = findItem(itemDb, id);
    const uid = createItemInstance(inv, id, itemDb);
    if (!inv.containers[uid]) {
        const cap = template ? containerCapacity(template, itemDb) : DEFAULT_ROOT_SLOTS;
        inv.containers[uid] = { capacity: cap, slots: emptySlots(cap), isRoot: false };
    }
    const r = placeInEquipment(inv, uid, 'backpack', itemDb);
    if (!r.ok) {
        destroyItem(inv, uid, itemDb);
        syncRootToEquippedBackpack(inv);
        return null;
    }
    syncRootToEquippedBackpack(inv);
    return uid;
}

function resolveLocationUid(inv, loc) {
    if (!loc) return null;
    if (loc.kind === 'equipment') return inv.equipment[loc.slot] || null;
    if (loc.kind === 'container') {
        const cont = inv.containers[loc.containerUid];
        if (!cont) return null;
        return cont.slots[loc.index] || null;
    }
    return null;
}

function locationsEqual(a, b) {
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === 'equipment') return a.slot === b.slot;
    return a.containerUid === b.containerUid && a.index === b.index;
}

function placeAtLocation(inv, uid, loc, itemDb) {
    if (!loc) return;
    if (loc.kind === 'equipment') placeInEquipment(inv, uid, loc.slot, itemDb);
    else placeInContainer(inv, uid, loc.containerUid, loc.index, itemDb);
}

function unequipItem(inv, engineSlot, itemDb, dest) {
    const slot = canonicalEquipmentSlot(engineSlot) || engineSlot;
    const uid = inv.equipment[slot];
    if (!uid) return { ok: false, error: 'empty_slot' };
    const d = dest || {};
    const containerUid = d.containerUid || inv.rootUid;
    if (slot === 'backpack') {
        if (containerUid === uid || isInsideSubtree(inv, containerUid, uid)) {
            return { ok: false, error: 'cycle' };
        }
    }
    const cont = inv.containers[containerUid];
    if (!cont) return { ok: false, error: 'unknown_container' };
    const index = d.index != null ? d.index : firstFreeSlot(cont);
    if (index < 0) return { ok: false, error: 'full' };
    return moveItem(
        inv,
        { kind: 'equipment', slot },
        { kind: 'container', containerUid, index },
        itemDb
    );
}

function prepareLeftHandForTwoHandedEquip(inv, weaponItem, itemDb) {
    if (!inv || !itemIsTwoHanded(weaponItem)) return { ok: true };
    const leftUid = inv.equipment && inv.equipment.leftHand;
    if (!leftUid) return { ok: true };
    const leftInst = inv.items[leftUid];
    const leftItem = leftInst ? findItem(itemDb, leftInst.itemId) : null;
    if (itemIsBowOrCrossbowWeapon(weaponItem) && itemIsQuiver(leftItem)) return { ok: true };
    const root = inv.containers[inv.rootUid];
    if (!root || firstFreeSlot(root) < 0) return { ok: false, error: 'no_room' };
    const un = unequipItem(inv, 'leftHand', itemDb, { containerUid: inv.rootUid });
    if (!un.ok) return { ok: false, error: un.error === 'full' ? 'no_room' : un.error || 'no_room' };
    return { ok: true };
}

function prepareRightHandForLeftHandEquip(inv, leftItem, itemDb) {
    if (!inv) return { ok: true };
    const rightUid = inv.equipment && inv.equipment.rightHand;
    if (!rightUid) return { ok: true };
    const rightInst = inv.items[rightUid];
    const rightItem = rightInst ? findItem(itemDb, rightInst.itemId) : null;
    if (!itemIsTwoHanded(rightItem)) return { ok: true };
    if (itemIsBowOrCrossbowWeapon(rightItem) && itemIsQuiver(leftItem)) return { ok: true };
    const root = inv.containers[inv.rootUid];
    if (!root || firstFreeSlot(root) < 0) return { ok: false, error: 'no_room' };
    const un = unequipItem(inv, 'rightHand', itemDb, { containerUid: inv.rootUid });
    if (!un.ok) return { ok: false, error: un.error === 'full' ? 'no_room' : un.error || 'no_room' };
    return { ok: true };
}

function moveItem(inv, from, to, itemDb, amount) {
    if (!inv || !from || !to) return { ok: false, error: 'bad_args' };
    const uidFrom = resolveLocationUid(inv, from);
    if (!uidFrom) return { ok: false, error: 'empty_source' };
    const src = inv.items[uidFrom];
    if (!src) return { ok: false, error: 'unknown_item' };
    const total = getStackCount(src);
    const n = Math.floor(Number(amount));
    const partial = Number.isFinite(n) && n >= 1 && n < total;
    if (partial) {
        const item = findItem(itemDb, src.itemId);
        if (itemIsStackable(item)) return moveItemAmount(inv, from, to, n, itemDb);
    }
    return moveItemWhole(inv, from, to, itemDb);
}

function moveItemAmount(inv, from, to, amount, itemDb) {
    const uidFrom = resolveLocationUid(inv, from);
    if (!uidFrom) return { ok: false, error: 'empty_source' };
    const src = inv.items[uidFrom];
    if (!src) return { ok: false, error: 'unknown_item' };
    if (locationsEqual(from, to)) return { ok: true };

    const n = Math.max(1, Math.floor(Number(amount)));
    const uidTo = resolveLocationUid(inv, to);

    if (to.kind === 'container' && uidTo && inv.containers[uidTo]) {
        if (uidFrom === uidTo) return { ok: false, error: 'cycle' };
        if (inv.containers[uidFrom] && isInsideSubtree(inv, uidTo, uidFrom)) {
            return { ok: false, error: 'cycle' };
        }
        const existing = findStackInContainer(inv, uidTo, src.itemId, uidFrom);
        if (existing && canMergeStacks(inv, uidFrom, existing, itemDb)) {
            const dest = inv.items[existing];
            const destIndex = dest && dest.location && dest.location.kind === 'container'
                ? dest.location.index
                : 0;
            return moveItemAmount(
                inv,
                from,
                { kind: 'container', containerUid: uidTo, index: destIndex },
                n,
                itemDb
            );
        }
        const free = firstFreeSlot(inv.containers[uidTo]);
        if (free < 0) return { ok: false, error: 'full' };
        return moveItemAmount(
            inv,
            from,
            { kind: 'container', containerUid: uidTo, index: free },
            n,
            itemDb
        );
    }

    if (uidTo && canMergeStacks(inv, uidFrom, uidTo, itemDb)) {
        mergeStacks(inv, uidFrom, uidTo, itemDb, n);
        recomputeTotalWeight(inv, itemDb);
        return { ok: true, merged: true };
    }

    if (to.kind === 'equipment') {
        const item = findItem(itemDb, src.itemId);
        if (item && !canEquipInSlot(item, to.slot)) return { ok: false, error: 'wrong_slot' };
        if (uidTo) return { ok: false, error: 'occupied' };
    }

    if (to.kind === 'container') {
        const cont = inv.containers[to.containerUid];
        if (!cont) return { ok: false, error: 'unknown_container' };
        if (to.index < 0 || to.index >= cont.capacity) return { ok: false, error: 'invalid_index' };
        if (uidTo) return { ok: false, error: 'occupied' };
        if (inv.containers[uidFrom] && isInsideSubtree(inv, to.containerUid, uidFrom)) {
            return { ok: false, error: 'cycle' };
        }
    }

    const prevCount = getStackCount(src);
    setStackCount(src, prevCount - n);
    let splitUid;
    try {
        splitUid = createItemInstance(inv, src.itemId, itemDb, { count: n });
    } catch (e) {
        setStackCount(src, prevCount);
        return { ok: false, error: 'split_failed' };
    }
    const splitInst = inv.items[splitUid];
    if (!splitInst) {
        setStackCount(src, prevCount);
        return { ok: false, error: 'split_failed' };
    }
    splitInst.location = null;

    let placeResult;
    if (to.kind === 'equipment') {
        placeResult = placeInEquipment(inv, splitUid, to.slot, itemDb);
    } else {
        placeResult = placeInContainer(inv, splitUid, to.containerUid, to.index, itemDb);
    }
    if (!placeResult || !placeResult.ok) {
        if (inv.items[splitUid]) destroyItem(inv, splitUid, itemDb);
        setStackCount(src, prevCount);
        recomputeTotalWeight(inv, itemDb);
        return { ok: false, error: (placeResult && placeResult.error) || 'place_failed' };
    }
    recomputeTotalWeight(inv, itemDb);
    return {
        ok: true,
        splitUid: inv.items[splitUid] ? splitUid : undefined,
        merged: !!placeResult.merged
    };
}

function moveItemWhole(inv, from, to, itemDb) {
    const uidFrom = resolveLocationUid(inv, from);
    if (!uidFrom) return { ok: false, error: 'empty_source' };
    if (locationsEqual(from, to)) return { ok: true };
    const uidTo = resolveLocationUid(inv, to);
    if (uidTo && canMergeStacks(inv, uidFrom, uidTo, itemDb)) {
        mergeStacks(inv, uidFrom, uidTo, itemDb);
        return { ok: true, merged: true };
    }
    if (to.kind === 'container' && uidTo && inv.containers[uidTo]) {
        if (uidFrom === uidTo) return { ok: false, error: 'cycle' };
        if (inv.containers[uidFrom] && isInsideSubtree(inv, uidTo, uidFrom)) {
            return { ok: false, error: 'cycle' };
        }
        const free = firstFreeSlot(inv.containers[uidTo]);
        if (free < 0) return { ok: false, error: 'full' };
        return moveItem(inv, from, { kind: 'container', containerUid: uidTo, index: free }, itemDb);
    }
    if (to.kind === 'equipment') {
        const inst = inv.items[uidFrom];
        const item = findItem(itemDb, inst.itemId);
        if (item && !canEquipInSlot(item, to.slot)) return { ok: false, error: 'wrong_slot' };
        if (to.slot === 'rightHand') {
            const prep = prepareLeftHandForTwoHandedEquip(inv, item, itemDb);
            if (!prep.ok) return prep;
        }
        if (to.slot === 'leftHand') {
            const prep = prepareRightHandForLeftHandEquip(inv, item, itemDb);
            if (!prep.ok) return prep;
        }
    }
    if (from.kind === 'equipment' && uidTo) {
        const instTo = inv.items[uidTo];
        const itemTo = findItem(itemDb, instTo.itemId);
        if (itemTo && !canEquipInSlot(itemTo, from.slot)) return { ok: false, error: 'wrong_slot_swap' };
    }
    if (to.kind === 'container') {
        const cont = inv.containers[to.containerUid];
        if (!cont) return { ok: false, error: 'unknown_container' };
        if (to.index < 0 || to.index >= cont.capacity) return { ok: false, error: 'invalid_index' };
        if (inv.containers[uidFrom] && isInsideSubtree(inv, to.containerUid, uidFrom)) {
            return { ok: false, error: 'cycle' };
        }
    }
    const swapIntoNewBag = to.kind === 'equipment' &&
        from.kind === 'container' &&
        !!uidTo &&
        !!inv.containers[uidTo] &&
        !!inv.containers[uidFrom] &&
        isInsideSubtree(inv, from.containerUid, uidTo);
    if (from.kind === 'container' && uidTo && inv.containers[uidTo] && !swapIntoNewBag) {
        if (isInsideSubtree(inv, from.containerUid, uidTo)) return { ok: false, error: 'cycle' };
    }
    if (swapIntoNewBag) {
        const free = firstFreeSlot(inv.containers[uidFrom]);
        if (free < 0) return { ok: false, error: 'full' };
    }
    detachItem(inv, uidFrom);
    if (uidTo) detachItem(inv, uidTo);
    if (to.kind === 'equipment') {
        const r = placeInEquipment(inv, uidFrom, to.slot, itemDb);
        if (!r.ok) {
            placeAtLocation(inv, uidFrom, from, itemDb);
            if (uidTo) placeAtLocation(inv, uidTo, to, itemDb);
            return r;
        }
    } else {
        const r = placeInContainer(inv, uidFrom, to.containerUid, to.index, itemDb);
        if (!r.ok) {
            placeAtLocation(inv, uidFrom, from, itemDb);
            if (uidTo) placeAtLocation(inv, uidTo, to, itemDb);
            return r;
        }
        if (r.merged) return { ok: true, merged: true };
    }
    if (uidTo) {
        if (from.kind === 'equipment') {
            const r = placeInEquipment(inv, uidTo, from.slot, itemDb);
            if (!r.ok) placeAtLocation(inv, uidTo, from, itemDb);
        } else if (swapIntoNewBag) {
            const free = firstFreeSlot(inv.containers[uidFrom]);
            const r = placeInContainer(inv, uidTo, uidFrom, free, itemDb);
            if (!r.ok) {
                placeInContainer(inv, uidTo, from.containerUid, from.index, itemDb);
            }
        } else {
            placeInContainer(inv, uidTo, from.containerUid, from.index, itemDb);
        }
    }
    if (
        (to.kind === 'equipment' && to.slot === 'backpack') ||
        (from.kind === 'equipment' && from.slot === 'backpack')
    ) {
        syncRootToEquippedBackpack(inv);
    }
    return { ok: true };
}

function equipItem(inv, uid, itemDb, engineSlot) {
    const inst = inv.items[uid];
    if (!inst) return { ok: false, error: 'unknown_item' };
    const item = findItem(itemDb, inst.itemId);
    const slot = engineSlot != null
        ? canonicalEquipmentSlot(engineSlot) || engineSlot
        : preferredEquipSlot(item);
    if (!slot || (item && !canEquipInSlot(item, slot))) {
        return { ok: false, error: 'not_equippable' };
    }
    if (!inst.location || inst.location.kind !== 'container') {
        if (inst.location && inst.location.kind === 'equipment') {
            return { ok: true, swappedUid: null };
        }
        return { ok: false, error: 'not_in_container' };
    }
    const from = Object.assign({}, inst.location);
    const r = moveItem(inv, from, { kind: 'equipment', slot }, itemDb);
    if (!r.ok) return r;
    return { ok: true, swappedUid: resolveLocationUid(inv, from) };
}

function itemSubtreeWeight(inv, uid, itemDb) {
    if (!inv || !uid) return 0;
    let w = 0;
    const seen = new Set();
    function walk(id) {
        if (!id || seen.has(id)) return;
        seen.add(id);
        const inst = inv.items[id];
        if (!inst) return;
        w += instanceWeight(inst, findItem(itemDb, inst.itemId));
        const cont = inv.containers[id];
        if (cont) {
            for (let i = 0; i < cont.slots.length; i++) {
                if (cont.slots[i]) walk(cont.slots[i]);
            }
        }
    }
    walk(uid);
    return w;
}

function computeTotalCarriedWeight(inv, itemDb) {
    if (!isRuntimeInventory(inv)) return 0;
    let w = 0;
    const seen = new Set();
    function walk(uid) {
        if (!uid || seen.has(uid)) return;
        seen.add(uid);
        const inst = inv.items[uid];
        if (!inst) return;
        w += instanceWeight(inst, findItem(itemDb, inst.itemId));
        const cont = inv.containers[uid];
        if (cont && Array.isArray(cont.slots)) {
            for (let i = 0; i < cont.slots.length; i++) {
                if (cont.slots[i]) walk(cont.slots[i]);
            }
        }
    }
    const equipment = inv.equipment && typeof inv.equipment === 'object' ? inv.equipment : null;
    if (equipment) {
        const keys = Object.keys(equipment);
        for (let i = 0; i < keys.length; i++) walk(equipment[keys[i]]);
    }
    const root = inv.rootUid != null && inv.containers ? inv.containers[inv.rootUid] : null;
    if (root && Array.isArray(root.slots)) {
        for (let i = 0; i < root.slots.length; i++) {
            if (root.slots[i]) walk(root.slots[i]);
        }
    }
    return w;
}

function recomputeTotalWeight(inv, itemDb) {
    if (!isRuntimeInventory(inv)) return 0;
    const w = computeTotalCarriedWeight(inv, itemDb);
    inv.totalWeight = w;
    return w;
}

function totalCarriedWeight(inv, itemDb) {
    if (!isRuntimeInventory(inv)) return 0;
    if (typeof inv.totalWeight === 'number' && Number.isFinite(inv.totalWeight)) {
        return Math.max(0, inv.totalWeight);
    }
    return recomputeTotalWeight(inv, itemDb);
}

function resolveCapBand(classId) {
    const raw = String(classId != null ? classId : 'adventurer').toLowerCase().trim();
    if (CAP_CLASS_BAND[raw]) return CAP_CLASS_BAND[raw];
    if (raw.includes('knight') || raw.includes('guardian')) return 'guardian';
    if (raw.includes('monk') || raw.includes('mystic')) return 'mystic';
    if (raw.includes('paladin') || raw.includes('scout') || raw.includes('ranger')) return 'scout';
    if (raw.includes('sorcerer') || raw.includes('adept') || raw.includes('mage')) return 'adept';
    if (raw.includes('druid') || raw.includes('warden')) return 'warden';
    return 'adventurer';
}

function baseCapacity(level, classId) {
    const lv = Math.max(1, Math.floor(Number(level) || 1));
    if (lv < 8) return 10 * (lv + 59);
    const band = resolveCapBand(classId);
    switch (band) {
        case 'guardian':
        case 'mystic':
            return 5 * (5 * lv - 5 * 8 + 134);
        case 'scout':
            return 10 * (2 * lv - 8 + 59);
        default:
            return 10 * (lv + 59);
    }
}

function remainingCapacity(level, weight, classId) {
    return Math.max(0, Math.floor(baseCapacity(level, classId) - (Number(weight) || 0) / 100));
}

function canCarryAdditional(level, currentWeight, addWeight, classId) {
    const after = (Number(currentWeight) || 0) + (Number(addWeight) || 0);
    return Math.floor(baseCapacity(level, classId) - after / 100) >= 0;
}

function countItemIdInInventoryTree(inv, itemId, startUid) {
    if (!inv || !itemId) return 0;
    const want = String(itemId);
    const start = startUid != null && String(startUid) !== '' ? String(startUid) : inv.rootUid;
    if (!start) return 0;
    const queue = [start];
    const seen = new Set();
    let total = 0;
    while (queue.length) {
        const cuid = queue.shift();
        if (!cuid || seen.has(cuid)) continue;
        seen.add(cuid);
        const cont = inv.containers[cuid];
        if (!cont || !Array.isArray(cont.slots)) continue;
        for (let i = 0; i < cont.slots.length; i++) {
            const uid = cont.slots[i];
            if (!uid) continue;
            const inst = inv.items[uid];
            if (!inst) continue;
            if (String(inst.itemId) === want) total += getStackCount(inst);
            if (inv.containers[uid]) queue.push(uid);
        }
    }
    return total;
}

function countItemFlat(bag, id) {
    if (!Array.isArray(bag) || id == null) return 0;
    const key = String(id);
    let n = 0;
    for (let i = 0; i < bag.length; i++) {
        if (bag[i] && bag[i].id === key) n += bag[i].count | 0;
    }
    return n;
}

function countItem(inv, id) {
    if (Array.isArray(inv)) return countItemFlat(inv, id);
    if (isRuntimeInventory(inv)) return countItemIdInInventoryTree(inv, id);
    return 0;
}

function consumeItemIdFromInventory(inv, itemId, amount, startUid, itemDb) {
    let need = Math.max(0, Math.floor(Number(amount) || 0));
    let spent = 0;
    let changed = false;
    if (!inv || !itemId || need <= 0) {
        return { ok: need <= 0, spent: 0, changed: false, itemId: itemId ? String(itemId) : null };
    }
    const want = String(itemId);
    const start = startUid != null && String(startUid) !== '' ? String(startUid) : inv.rootUid;
    if (!start) return { ok: false, spent: 0, changed: false, itemId: want };
    const queue = [start];
    const seen = new Set();
    while (queue.length && need > 0) {
        const cuid = queue.shift();
        if (!cuid || seen.has(cuid)) continue;
        seen.add(cuid);
        const cont = inv.containers[cuid];
        if (!cont || !Array.isArray(cont.slots)) continue;
        for (let i = 0; i < cont.slots.length && need > 0; i++) {
            const uid = cont.slots[i];
            if (!uid) continue;
            const inst = inv.items[uid];
            if (!inst) continue;
            if (inv.containers[uid]) queue.push(uid);
            if (String(inst.itemId) !== want) continue;
            const have = getStackCount(inst);
            const take = Math.min(have, need);
            if (take <= 0) continue;
            const item = itemDb ? findItem(itemDb, inst.itemId) : null;
            const unit = item && item.weight != null
                ? Number(item.weight) || 0
                : (inst.unitWeight != null ? Number(inst.unitWeight) || 0 : (findItem(null, inst.itemId) ? Number(findItem(null, inst.itemId).weight) || 0 : 0));
            setStackCount(inst, have - take);
            need -= take;
            spent += take;
            changed = true;
            if (typeof inv.totalWeight === 'number') {
                inv.totalWeight = Math.max(0, inv.totalWeight - unit * take);
            }
            if (getStackCount(inst) <= 0) destroyItem(inv, uid, itemDb);
        }
    }
    return { ok: need <= 0, spent, changed, itemId: want };
}

function takeItemFlat(bag, id, count) {
    const n = Math.max(1, Math.floor(Number(count) || 1));
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

function takeItem(inv, id, count, itemDb) {
    if (Array.isArray(inv)) return takeItemFlat(inv, id, count);
    if (!isRuntimeInventory(inv)) return false;
    const n = Math.max(1, Math.floor(Number(count) || 1));
    const r = consumeItemIdFromInventory(inv, id, n, null, itemDb);
    return r.ok;
}

function stackItemFlat(bag, id, count) {
    const n = Math.max(1, Math.floor(Number(count) || 1));
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

function addItemToInventory(inv, itemId, count, itemDb) {
    if (!isRuntimeInventory(inv)) return { ok: false, error: 'bad_inv' };
    const id = String(itemId);
    let left = Math.max(1, Math.floor(Number(count) || 1));
    const item = findItem(itemDb, id);
    const stackable = !item || itemIsStackable(item);
    while (left > 0) {
        const chunk = stackable ? Math.min(MAX_STACK_SIZE, left) : 1;
        const uid = createItemInstance(inv, id, itemDb, { count: chunk });
        const free = findFirstFreeSlotBfs(inv, inv.rootUid);
        if (!free) {
            destroyItem(inv, uid, itemDb);
            return { ok: false, error: 'full', remaining: left };
        }
        const placed = placeInContainer(inv, uid, free.containerUid, null, itemDb);
        if (!placed.ok) {
            destroyItem(inv, uid, itemDb);
            return { ok: false, error: placed.error || 'full', remaining: left };
        }
        left -= chunk;
    }
    return { ok: true };
}

function stackItem(inv, id, count, itemDb) {
    if (Array.isArray(inv)) return stackItemFlat(inv, id, count);
    return addItemToInventory(inv, id, count, itemDb);
}

function ammoMatchesKind(item, kind) {
    if (!itemIsAmmo(item)) return false;
    if (kind == null || kind === '') return true;
    const at = item.ammoType;
    if (at === kind) return true;
    if (at === 'arrow' || at === 'bolt') return false;
    return itemAmmoKind(item) === kind;
}

function findFirstAmmoUid(inv, containerUid, itemDb, kind) {
    const cont = inv && inv.containers[containerUid];
    if (!cont) return null;
    for (let i = 0; i < cont.slots.length; i++) {
        const uid = cont.slots[i];
        if (!uid) continue;
        const inst = inv.items[uid];
        if (!inst) continue;
        if (ammoMatchesKind(findItem(itemDb, inst.itemId), kind)) return uid;
    }
    return null;
}

function consumeAmmoFromContainer(inv, containerUid, amount, itemDb, kind) {
    let need = Math.max(0, Math.floor(Number(amount) || 0));
    let spent = 0;
    let ammoItemId = null;
    if (!inv || need <= 0) return { ok: need <= 0, spent: 0, changed: false, ammoItemId: null };
    const cont = inv.containers[containerUid];
    if (!cont) return { ok: false, spent: 0, changed: false, ammoItemId: null };
    for (let i = 0; i < cont.slots.length && need > 0; i++) {
        const uid = cont.slots[i];
        if (!uid) continue;
        const inst = inv.items[uid];
        if (!inst) continue;
        const item = findItem(itemDb, inst.itemId);
        if (!ammoMatchesKind(item, kind)) continue;
        if (!ammoItemId) ammoItemId = inst.itemId;
        const have = getStackCount(inst);
        const take = Math.min(have, need);
        if (take <= 0) continue;
        const unit = item && item.weight != null
            ? Number(item.weight) || 0
            : (inst.unitWeight != null ? Number(inst.unitWeight) || 0 : (findItem(null, inst.itemId) ? Number(findItem(null, inst.itemId).weight) || 0 : 0));
        setStackCount(inst, have - take);
        need -= take;
        spent += take;
        if (typeof inv.totalWeight === 'number') {
            inv.totalWeight = Math.max(0, inv.totalWeight - unit * take);
        }
        if (getStackCount(inst) <= 0) destroyItem(inv, uid, itemDb);
    }
    return { ok: need <= 0, spent, changed: spent > 0, ammoItemId };
}

function consumeInstanceCount(inv, uid, amount, itemDb) {
    if (!inv || !uid) return false;
    const inst = inv.items && inv.items[uid];
    if (!inst) return false;
    const n = Math.max(1, Math.floor(Number(amount) || 1));
    const have = getStackCount(inst);
    const take = Math.min(have, n);
    if (take <= 0) return false;
    const item = itemDb ? findItem(itemDb, inst.itemId) : null;
    const unit = item && item.weight != null
        ? Number(item.weight) || 0
        : (inst.unitWeight != null ? Number(inst.unitWeight) || 0 : (findItem(null, inst.itemId) ? Number(findItem(null, inst.itemId).weight) || 0 : 0));
    const left = have - take;
    setStackCount(inst, left);
    if (typeof inv.totalWeight === 'number') {
        inv.totalWeight = Math.max(0, inv.totalWeight - unit * take);
    }
    if (left <= 0) destroyItem(inv, uid, itemDb);
    return true;
}

function equippedWeaponAmmoKind(inv, itemDb) {
    if (!inv || !inv.equipment) return null;
    const wUid = inv.equipment.rightHand;
    if (!wUid || !inv.items[wUid]) return null;
    return weaponRequiredAmmoKind(findItem(itemDb, inv.items[wUid].itemId));
}

function consumeAmmoForShot(inv, itemDb, amount) {
    const kind = equippedWeaponAmmoKind(inv, itemDb);
    if (!kind) return { ok: true, spent: 0, changed: false, ammoItemId: null, needed: false };
    const n = Math.max(1, Math.floor(Number(amount) || 1));
    const qUid = inv.equipment && inv.equipment.leftHand;
    if (qUid) {
        if (inv.containers && inv.containers[qUid]) {
            const q = consumeAmmoFromContainer(inv, qUid, n, itemDb, kind);
            if (q.ok) return Object.assign({ needed: true }, q);
        } else if (inv.items && inv.items[qUid]) {
            const item = findItem(itemDb, inv.items[qUid].itemId);
            if (ammoMatchesKind(item, kind)) {
                const inst = inv.items[qUid];
                const have = getStackCount(inst);
                const take = Math.min(have, n);
                if (take > 0) {
                    const unit = item && item.weight != null
                        ? Number(item.weight) || 0
                        : (inst.unitWeight != null ? Number(inst.unitWeight) || 0 : (findItem(null, inst.itemId) ? Number(findItem(null, inst.itemId).weight) || 0 : 0));
                    const left = have - take;
                    setStackCount(inst, left);
                    if (typeof inv.totalWeight === 'number') {
                        inv.totalWeight = Math.max(0, inv.totalWeight - unit * take);
                    }
                    if (left <= 0) destroyItem(inv, qUid, itemDb);
                    return { ok: true, spent: take, changed: true, ammoItemId: inst.itemId, needed: true };
                }
            }
        }
    }
    const start = inv.rootUid;
    const queue = [start];
    const seen = new Set();
    while (queue.length) {
        const cuid = queue.shift();
        if (!cuid || seen.has(cuid)) continue;
        seen.add(cuid);
        const r = consumeAmmoFromContainer(inv, cuid, n, itemDb, kind);
        if (r.ok) return Object.assign({ needed: true }, r);
        const cont = inv.containers[cuid];
        if (!cont) continue;
        for (let i = 0; i < cont.slots.length; i++) {
            const child = cont.slots[i];
            if (child && inv.containers[child]) queue.push(child);
        }
    }
    return { ok: false, spent: 0, changed: false, ammoItemId: null, needed: true, error: 'no_ammo' };
}

function peekAmmoForShot(inv, itemDb) {
    const kind = equippedWeaponAmmoKind(inv, itemDb);
    if (!kind) return null;
    const qUid = inv.equipment && inv.equipment.leftHand;
    if (qUid) {
        if (inv.containers && inv.containers[qUid]) {
            const uid = findFirstAmmoUid(inv, qUid, itemDb, kind);
            if (uid) return findItem(itemDb, inv.items[uid].itemId);
        } else if (inv.items && inv.items[qUid]) {
            const item = findItem(itemDb, inv.items[qUid].itemId);
            if (ammoMatchesKind(item, kind)) return item;
        }
    }
    const start = inv.rootUid;
    const queue = [start];
    const seen = new Set();
    while (queue.length) {
        const cuid = queue.shift();
        if (!cuid || seen.has(cuid)) continue;
        seen.add(cuid);
        const uid = findFirstAmmoUid(inv, cuid, itemDb, kind);
        if (uid) return findItem(itemDb, inv.items[uid].itemId);
        const cont = inv.containers[cuid];
        if (!cont) continue;
        for (let i = 0; i < cont.slots.length; i++) {
            const child = cont.slots[i];
            if (child && inv.containers[child]) queue.push(child);
        }
    }
    return null;
}

function equippedRightHandItem(inv, itemDb) {
    if (!inv || !inv.equipment) return null;
    const uid = inv.equipment.rightHand;
    if (!uid || !inv.items[uid]) return null;
    return findItem(itemDb, inv.items[uid].itemId);
}

function equippedRightHandCount(inv) {
    if (!inv || !inv.equipment) return 0;
    const uid = inv.equipment.rightHand;
    if (!uid || !inv.items[uid]) return 0;
    return getStackCount(inv.items[uid]);
}

function equippedIsThrowingWeapon(inv, itemDb) {
    return itemIsThrowingWeapon(equippedRightHandItem(inv, itemDb));
}

function tryBreakEquippedThrowingWeapon(inv, itemDb, rng) {
    const empty = {
        attempted: false,
        broke: false,
        changed: false,
        itemId: null,
        remaining: 0,
        breakChance: null
    };
    if (!inv || !inv.equipment) return empty;
    const uid = inv.equipment.rightHand;
    if (!uid || !inv.items[uid]) return empty;
    const inst = inv.items[uid];
    const item = findItem(itemDb, inst.itemId);
    if (!itemIsThrowingWeapon(item)) return empty;
    const chance = itemBreakChance(item);
    const itemId = inst.itemId != null ? String(inst.itemId) : null;
    const remainingBefore = getStackCount(inst);
    if (chance == null) {
        return {
            attempted: false,
            broke: false,
            changed: false,
            itemId,
            remaining: remainingBefore,
            breakChance: null
        };
    }
    if (chance <= 0) {
        return {
            attempted: true,
            broke: false,
            changed: false,
            itemId,
            remaining: remainingBefore,
            breakChance: chance
        };
    }
    if (chance < 100) {
        const r = typeof rng === 'function' ? Number(rng()) : Math.random();
        const roll = (Number.isFinite(r) ? r : Math.random()) * 100;
        if (!(roll < chance)) {
            return {
                attempted: true,
                broke: false,
                changed: false,
                itemId,
                remaining: remainingBefore,
                breakChance: chance
            };
        }
    }
    const unit = item && item.weight != null
        ? Number(item.weight) || 0
        : (inst.unitWeight != null ? Number(inst.unitWeight) || 0 : 0);
    const left = remainingBefore - 1;
    if (left <= 0) {
        destroyItem(inv, uid, itemDb);
        return {
            attempted: true,
            broke: true,
            changed: true,
            itemId,
            remaining: 0,
            breakChance: chance
        };
    }
    setStackCount(inst, left);
    if (typeof inv.totalWeight === 'number') {
        inv.totalWeight = Math.max(0, inv.totalWeight - unit);
    }
    return {
        attempted: true,
        broke: true,
        changed: true,
        itemId,
        remaining: left,
        breakChance: chance
    };
}

function resolveDistanceAutoShape(inv, itemDb) {
    if (equippedIsThrowingWeapon(inv, itemDb)) return null;
    const ammo = peekAmmoForShot(inv, itemDb);
    return normalizeAutoShape(ammo && ammo.autoShape);
}

function equippedLeftHandItem(inv, itemDb) {
    if (!inv || !inv.equipment) return null;
    const uid = inv.equipment.leftHand;
    if (!uid || !inv.items[uid]) return null;
    return findItem(itemDb, inv.items[uid].itemId);
}

function authoredNonNeg(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
}

function applyPlayerLoadout(session, itemDb) {
    if (!session) return;
    const inv = session.inventory;
    const right = equippedRightHandItem(inv, itemDb);
    const left = equippedLeftHandItem(inv, itemDb);
    const unarmed = !right;
    let atk = unarmed ? UNARMED_ATK : Number(right.atk) || 0;
    let ammo = null;
    if (right && weaponRequiredAmmoKind(right)) {
        ammo = peekAmmoForShot(inv, itemDb);
        if (ammo && ammo.atk != null) atk += Number(ammo.atk) || 0;
    }
    session.atk = atk;
    const weaponSkill = unarmed ? 'fist' : (resolveWeaponSkillFromItem(right) || 'fist');
    session.weaponSkill = weaponSkill;
    session.weaponTier = unarmed ? 0 : Math.max(0, Math.floor(Number(right && right.tier) || 0));

    const extraAtk = (!unarmed && right && right.extraAtk != null)
        ? Math.max(0, Number(right.extraAtk) || 0)
        : 0;
    const extraAtkElement = (!unarmed && right && extraAtk > 0 && right.extraAtkElement)
        ? String(right.extraAtkElement).toLowerCase()
        : null;
    session.extraAtk = extraAtk;
    session.extraAtkElement = extraAtkElement;

    const isMagic = !!(
        right && (
            itemIsMagicWeapon(right) ||
            right.weaponType === 'magic' ||
            right.category === 'wand' ||
            right.category === 'rod'
        )
    );

    const isDistance = !!(
        right && (
            weaponSkill === 'distance' ||
            right.weaponType === 'distance' ||
            itemIsBowOrCrossbowWeapon(right) ||
            right.category === 'bow' ||
            right.category === 'crossbow' ||
            right.category === 'spear' ||
            right.category === 'throwing'
        )
    );

    if (isMagic) {
        session.weaponType = 'magic';
        session.weaponMin = authoredNonNeg(right.min);
        session.weaponMax = authoredNonNeg(right.max);
        session.weaponElement = String(right.element || 'energy').toLowerCase();
        session.weaponRange = Math.max(1, Number(right.range) || 4);
        session.weaponManaGain = Math.max(0, Math.floor(Number(right.manaGain) || 0));
        session.extraAtk = 0;
        session.extraAtkElement = null;
    } else if (isDistance) {
        session.weaponType = 'distance';
        session.weaponMin = 0;
        session.weaponMax = 0;
        session.weaponElement = null;
        session.weaponRange = Math.max(1, Number(right && right.range) || 6);
        session.weaponManaGain = 0;
    } else {
        session.weaponType = unarmed ? 'fist' : (right.weaponType || 'melee');
        session.weaponMin = 0;
        session.weaponMax = 0;
        session.weaponElement = null;
        session.weaponRange = 1;
        session.weaponManaGain = 0;
    }

    let hitChance = 100;
    if (isDistance && right) {
        if (weaponRequiredAmmoKind(right)) {
            if (ammo) {
                const ammoHit = ammo.maxHitChance != null
                    ? Number(ammo.maxHitChance)
                    : (ammo.hitChance != null ? Number(ammo.hitChance) : 100);
                const weaponMod = Number(right.hitChanceMod) || Number(right.hitChance) || 0;
                hitChance = Math.min(100, Math.max(0, ammoHit + weaponMod));
            }
        } else {
            const weaponMax = right.maxHitChance != null
                ? Number(right.maxHitChance)
                : (right.hitChance != null && Number(right.hitChance) > 20 ? Number(right.hitChance) : 100);
            const weaponMod = (right.maxHitChance != null && right.hitChance != null)
                ? Number(right.hitChance)
                : (Number(right.hitChanceMod) || 0);
            hitChance = Math.min(100, Math.max(0, weaponMax + weaponMod));
        }
    }
    session.hitChance = hitChance;

    session._gearSkillBonus = Object.create(null);
    let armor = 0;
    let extraCrit = 0;
    let extraCritDmg = 0;
    let gearSpeed = 0;
    let extraFormulaAtk = 0;
    let lifeLeechChance = Number(session._lifeLeechChance) || 0;
    let lifeLeechAmountPipeline = 0;
    let manaLeechChance = Number(session._manaLeechChance) || 0;
    let manaLeechAmountPipeline = 0;
    const resistStacks = Object.create(null);
    const eq = inv && inv.equipment;
    if (eq) {
        const keys = Object.keys(eq);
        for (let i = 0; i < keys.length; i++) {
            const slot = keys[i];
            if (slot === 'backpack') continue;
            const inst = inv.items[eq[slot]];
            if (!inst) continue;
            const item = findItem(itemDb, inst.itemId);
            if (!item) continue;
            armor += Number(item.armor) || 0;
            extraCrit += Number(item.critChance) || 0;
            extraCritDmg += Number(item.critExtraDamage) || Number(item.critDamage) || 0;
            gearSpeed += Number(item.speed) || 0;
            if (!itemIsWeapon(item, slot) && !itemIsAmmo(item) && item.atk != null) {
                extraFormulaAtk += Number(item.atk) || 0;
            }
            lifeLeechChance += Number(item.lifeLeechChance) || 0;
            lifeLeechAmountPipeline += Number(item.lifeLeechAmount) || 0;
            manaLeechChance += Number(item.manaLeechChance) || 0;
            manaLeechAmountPipeline += Number(item.manaLeechAmount) || 0;
            const bonuses = item.skillBonuses || item.skills;
            if (bonuses && typeof bonuses === 'object') {
                const bk = Object.keys(bonuses);
                for (let b = 0; b < bk.length; b++) {
                    const k = bk[b];
                    session._gearSkillBonus[k] = (session._gearSkillBonus[k] || 0) + (Number(bonuses[k]) || 0);
                }
            }
            const resists = item.resists || item.resistances;
            if (resists && typeof resists === 'object') {
                const els = Object.keys(DEFAULT_RESISTS);
                for (let e = 0; e < els.length; e++) {
                    const el = els[e];
                    const v = resists[el];
                    if (v == null) continue;
                    if (!resistStacks[el]) resistStacks[el] = [];
                    if (Array.isArray(v)) {
                        for (let n = 0; n < v.length; n++) resistStacks[el].push(Number(v[n]) || 0);
                    } else {
                        resistStacks[el].push(Number(v) || 0);
                    }
                }
            }
        }
    }
    session.atk = atk + extraFormulaAtk + (Number(session._atkBonus) || 0);
    session.armor = armor + (Number(session._classArmorBonus) || 0);
    const resists = Object.assign({}, DEFAULT_RESISTS, session._classResists || {});
    const stackedEls = Object.keys(resistStacks);
    for (let i = 0; i < stackedEls.length; i++) {
        const el = stackedEls[i];
        resists[el] = stackResists(resistStacks[el]);
    }
    session.resists = resists;
    session.lifeLeechChance = lifeLeechChance;
    session.lifeLeechAmount = (Number(session._lifeLeechAmount) || 0) + pipelineToPercent(lifeLeechAmountPipeline);
    session.manaLeechChance = manaLeechChance;
    session.manaLeechAmount = (Number(session._manaLeechAmount) || 0) + pipelineToPercent(manaLeechAmountPipeline);
    const levelForSpeed = Math.max(1, Math.floor(Number(session.level) || 1));
    const classBaseSpeed = session._classBaseSpeed != null && Number.isFinite(Number(session._classBaseSpeed))
        ? Number(session._classBaseSpeed)
        : 110;
    session.baseSpeed = classBaseSpeed
        + (levelForSpeed - 1)
        + gearSpeed
        + (Number(session._speedBonus) || 0);
    if (session._baseCritChance == null) session._baseCritChance = Number(session.critChance) || 0;
    if (session._baseCritDamage == null) session._baseCritDamage = Number(session.critDamage) || 0;
    session.critChance = session._baseCritChance + extraCrit;
    session.critDamage = session._baseCritDamage + extraCritDmg;
    const skills = session.skills;
    const shielding = skillValue(skills, 'shielding');
    const shield = itemIsShield(left);
    if (shield) {
        const def = (Number(left.defense) || 0) + (Number(left.defenseBonus) || 0);
        session.mitigation = computeMitigationPercent(shielding, def);
        session.maxBlock = computeMaxBlock(shielding, def);
        session.canBlock = session.maxBlock > 0;
        return;
    }
    if (itemIsBowOrCrossbowWeapon(right)) {
        session.mitigation = computeMitigationPercent(shielding, BOW_MITIGATION_DEFENSE);
        session.maxBlock = 0;
        session.canBlock = false;
        return;
    }
    const weaponDef = right && right.defense != null ? Number(right.defense) || 0 : UNARMED_WEAPON_DEFENSE;
    const blockSkill = skillValue(skills, session.weaponSkill);
    session.mitigation = computeMitigationPercent(shielding, weaponDef);
    session.maxBlock = computeMaxBlock(blockSkill, weaponDef);
    session.canBlock = session.maxBlock > 0;
}

function seedInstanceBudgets(inst, item, opts) {
    if (!inst) return;
    const o = opts && typeof opts === 'object' ? opts : {};
    if (o.remainingCharges != null && Number.isFinite(Number(o.remainingCharges))) {
        inst.remainingCharges = Math.max(0, Math.floor(Number(o.remainingCharges)));
    } else if (item && item.charges != null && Number.isFinite(Number(item.charges))) {
        const c = Math.floor(Number(item.charges));
        if (c > 0) inst.remainingCharges = c;
    }
    if (o.remainingDurationSec != null && Number.isFinite(Number(o.remainingDurationSec))) {
        inst.remainingDurationSec = Math.max(0, Number(o.remainingDurationSec));
    } else if (item && item.durationSec != null && Number.isFinite(Number(item.durationSec))) {
        const d = Number(item.durationSec);
        if (d > 0) inst.remainingDurationSec = d;
    }
}

function copyInstanceBudgets(src, dst) {
    if (!src || !dst) return;
    if (src.remainingDurationSec != null && Number.isFinite(Number(src.remainingDurationSec))) {
        dst.remainingDurationSec = Math.max(0, Number(src.remainingDurationSec));
    }
    if (src.remainingCharges != null && Number.isFinite(Number(src.remainingCharges))) {
        dst.remainingCharges = Math.max(0, Math.floor(Number(src.remainingCharges)));
    }
}

function serializeItemInstance(inst) {
    if (!inst) return null;
    const row = {
        uid: String(inst.uid),
        itemId: String(inst.itemId || ''),
        location: inst.location ? Object.assign({}, inst.location) : null
    };
    if (inst.count != null) row.count = inst.count;
    if (inst.unitWeight != null) row.unitWeight = Number(inst.unitWeight) || 0;
    copyInstanceBudgets(inst, row);
    return row;
}

function serializeInventory(inv) {
    if (!isRuntimeInventory(inv)) return { items: [] };
    const items = Object.create(null);
    const src = inv.items || {};
    const keys = Object.keys(src);
    for (let i = 0; i < keys.length; i++) {
        const row = serializeItemInstance(src[keys[i]]);
        if (row && row.uid) items[row.uid] = row;
    }
    const payload = {
        version: 1,
        nextUid: inv.nextUid | 0,
        items,
        containers: inv.containers,
        rootUid: inv.rootUid,
        equipment: inv.equipment
    };
    if (typeof inv.totalWeight === 'number' && Number.isFinite(inv.totalWeight)) {
        payload.totalWeight = Math.max(0, Math.floor(inv.totalWeight));
    }
    return JSON.parse(JSON.stringify(payload));
}

function cloneInventory(inv) {
    const raw = serializeInventory(inv);
    if (!isRuntimeInventory(raw)) return createEmptyInventory();
    const out = {
        nextUid: Math.max(1, raw.nextUid | 0),
        items: Object.create(null),
        containers: Object.create(null),
        rootUid: raw.rootUid || ROOT_UID,
        equipment: Object.create(null),
        totalWeight: typeof (inv && inv.totalWeight) === 'number'
            ? inv.totalWeight
            : (typeof raw.totalWeight === 'number' ? raw.totalWeight : 0)
    };
    const items = raw.items || {};
    const ik = Object.keys(items);
    for (let i = 0; i < ik.length; i++) {
        const row = items[ik[i]];
        if (!row || !row.uid) continue;
        out.items[row.uid] = {
            uid: String(row.uid),
            itemId: String(row.itemId || ''),
            location: row.location ? Object.assign({}, row.location) : null,
            count: row.count,
            unitWeight: row.unitWeight != null ? Number(row.unitWeight) || 0 : undefined
        };
        if (row.count == null) delete out.items[row.uid].count;
        if (out.items[row.uid].unitWeight === undefined) delete out.items[row.uid].unitWeight;
        copyInstanceBudgets(row, out.items[row.uid]);
    }
    const containers = raw.containers || {};
    const ck = Object.keys(containers);
    for (let i = 0; i < ck.length; i++) {
        const c = containers[ck[i]];
        if (!c) continue;
        const cap = Math.max(0, Math.min(255, c.capacity | 0));
        const slots = emptySlots(cap);
        const src = Array.isArray(c.slots) ? c.slots : [];
        for (let s = 0; s < cap && s < src.length; s++) {
            slots[s] = src[s] ? String(src[s]) : null;
        }
        out.containers[ck[i]] = { capacity: cap, slots, isRoot: !!c.isRoot };
    }
    const eq = raw.equipment || {};
    const ek = Object.keys(eq);
    for (let i = 0; i < ek.length; i++) {
        if (eq[ek[i]]) out.equipment[ek[i]] = String(eq[ek[i]]);
    }
    return out;
}

function repairInventory(inv) {
    if (!isRuntimeInventory(inv)) return inv;
    const items = inv.items;
    const uids = Object.keys(items);
    let maxN = 0;
    for (let i = 0; i < uids.length; i++) {
        const m = /^i(\d+)$/.exec(uids[i]);
        if (m) maxN = Math.max(maxN, Number(m[1]) || 0);
        const inst = items[uids[i]];
        if (inst) inst.location = null;
    }
    inv.nextUid = Math.max(inv.nextUid | 0, maxN + 1);
    const eq = inv.equipment || Object.create(null);
    const ek = Object.keys(eq);
    for (let i = 0; i < ek.length; i++) {
        const uid = eq[ek[i]];
        if (!uid || !items[uid]) {
            delete eq[ek[i]];
            continue;
        }
        items[uid].location = { kind: 'equipment', slot: ek[i] };
    }
    inv.equipment = eq;
    const ck = Object.keys(inv.containers);
    for (let i = 0; i < ck.length; i++) {
        const cont = inv.containers[ck[i]];
        if (!cont || !Array.isArray(cont.slots)) continue;
        for (let s = 0; s < cont.slots.length; s++) {
            const uid = cont.slots[s];
            if (!uid) continue;
            if (!items[uid]) {
                cont.slots[s] = null;
                continue;
            }
            items[uid].location = { kind: 'container', containerUid: ck[i], index: s };
        }
    }
    return inv;
}

function migrateFlatItems(inv, rows, itemDb) {
    if (!Array.isArray(rows)) return;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;
        const id = row.id != null ? String(row.id).trim() : (row.itemId != null ? String(row.itemId).trim() : '');
        if (!id) continue;
        const count = Math.max(1, Math.floor(Number(row.count) || 1));
        addItemToInventory(inv, id, count, itemDb);
    }
}

function normalizeInventory(raw, itemDb) {
    if (isRuntimeInventory(raw)) {
        const inv = repairInventory(cloneInventory(raw));
        ensureEquippedBackpack(inv, itemDb);
        const uids = Object.keys(inv.items);
        for (let i = 0; i < uids.length; i++) {
            const inst = inv.items[uids[i]];
            if (inst) {
                const item = findItem(itemDb, inst.itemId);
                inst.unitWeight = item && item.weight != null ? Number(item.weight) || 0 : (inst.unitWeight != null ? Number(inst.unitWeight) || 0 : 0);
            }
        }
        recomputeTotalWeight(inv, itemDb);
        return inv;
    }
    const inv = createEmptyInventory();
    ensureEquippedBackpack(inv, itemDb);
    if (Array.isArray(raw)) migrateFlatItems(inv, raw, itemDb);
    else if (raw && typeof raw === 'object' && Array.isArray(raw.items)) {
        migrateFlatItems(inv, raw.items, itemDb);
    }
    const uids = Object.keys(inv.items);
    for (let i = 0; i < uids.length; i++) {
        const inst = inv.items[uids[i]];
        if (inst) {
            const item = findItem(itemDb, inst.itemId);
            inst.unitWeight = item && item.weight != null ? Number(item.weight) || 0 : (inst.unitWeight != null ? Number(inst.unitWeight) || 0 : 0);
        }
    }
    recomputeTotalWeight(inv, itemDb);
    return inv;
}

function canAddItemToInventory(inv, itemId, count, itemDb) {
    if (!isRuntimeInventory(inv) || itemId == null) return false;
    const id = String(itemId);
    const left = Math.max(1, Math.floor(Number(count) || 1));
    const clone = normalizeInventory(serializeInventory(inv), itemDb);
    const r = addItemToInventory(clone, id, left, itemDb);
    return !!(r && r.ok);
}

function bagView(inv, containerUid, itemDb) {
    const id = containerUid || (inv && inv.rootUid) || ROOT_UID;
    const cont = inv && inv.containers && inv.containers[id];
    const slots = [];
    if (!cont) return { containerId: id, capacity: 0, slots };
    for (let i = 0; i < cont.slots.length; i++) {
        const uid = cont.slots[i];
        if (!uid) continue;
        const inst = inv.items[uid];
        if (!inst) continue;
        const item = findItem(itemDb, inst.itemId);
        slots.push({
            index: i,
            id: inst.itemId,
            count: getStackCount(inst),
            flags: (inv.containers[uid] || itemIsContainer(item)) ? 1 : 0
        });
    }
    return { containerId: id, capacity: cont.capacity | 0, slots };
}

function equipmentView(inv, itemDb) {
    const slots = [];
    if (!inv || !inv.equipment) return slots;
    const keys = EQUIPMENT_SLOTS;
    for (let i = 0; i < keys.length; i++) {
        const uid = inv.equipment[keys[i]];
        if (!uid) continue;
        const inst = inv.items[uid];
        if (!inst) continue;
        const item = findItem(itemDb, inst.itemId);
        slots.push({
            slot: engineSlotToDesigner(keys[i]),
            id: inst.itemId,
            count: getStackCount(inst),
            flags: (inv.containers[uid] || itemIsContainer(item)) ? 1 : 0
        });
    }
    return slots;
}

function playerCap(session, itemDb) {
    const voc = session && session.character && session.character.vocation;
    const level = session && session.level != null ? session.level : 1;
    const capMax = baseCapacity(level, voc);
    const weight = totalCarriedWeight(session && session.inventory, itemDb);
    const cap = remainingCapacity(level, weight, voc);
    return { cap, capMax, weight };
}

function ownsContainer(inv, containerUid) {
    if (!inv || !containerUid) return false;
    if (containerUid === inv.rootUid || containerUid === ROOT_UID) return !!inv.containers[containerUid];
    return !!(inv.containers[containerUid] && inv.items[containerUid]);
}

function ensurePlayerContainer(inv, uid, itemDb) {
    if (!inv || !uid) return null;
    if (inv.containers[uid]) return inv.containers[uid];
    const inst = inv.items[uid];
    if (!inst) return null;
    const item = findItem(itemDb, inst.itemId);
    if (!itemIsContainer(item)) return null;
    const cap = Math.max(0, containerCapacity(item, itemDb) | 0);
    inv.containers[uid] = { capacity: cap, slots: emptySlots(cap), isRoot: false };
    return inv.containers[uid];
}

function resolveOpenBagUid(inv, containerId, index) {
    if (!inv) return null;
    const id = containerId != null ? String(containerId) : '';
    if (!id) return null;
    if (ownsContainer(inv, id)) {
        return resolveLocationUid(inv, {
            kind: 'container',
            containerUid: id,
            index: index | 0
        });
    }
    const slot = designerSlotToEngine(id);
    if (slot && inv.equipment && inv.equipment[slot]) {
        return inv.equipment[slot];
    }
    return null;
}

const STARTER_SLOT_ORDER = Object.freeze([
    'backpack', 'helmet', 'armor', 'legs', 'boots', 'amulet', 'ring', 'leftHand', 'rightHand'
]);

function starterRowId(row) {
    if (row == null) return '';
    if (typeof row === 'string') return row.trim();
    if (typeof row !== 'object') return '';
    if (row.id != null && String(row.id).trim() !== '') return String(row.id).trim();
    if (row.itemId != null && String(row.itemId).trim() !== '') return String(row.itemId).trim();
    return '';
}

function starterRowCount(row) {
    if (row && typeof row === 'object' && row.count != null && Number.isFinite(Number(row.count))) {
        return Math.max(1, Math.floor(Number(row.count)));
    }
    return 1;
}

function resolveStarterSpec(vocation, startersDoc) {
    const doc = startersDoc && typeof startersDoc === 'object' ? startersDoc : {};
    const vocs = doc.vocations && typeof doc.vocations === 'object' ? doc.vocations : {};
    const key = vocation != null ? String(vocation).trim() : '';
    const vocSpec = (key && vocs[key] && typeof vocs[key] === 'object') ? vocs[key] : {};
    const base = doc.baseEquips && typeof doc.baseEquips === 'object' ? doc.baseEquips : {};
    const vocEquips = vocSpec.equips && typeof vocSpec.equips === 'object' ? vocSpec.equips : {};
    return {
        equips: Object.assign({}, base, vocEquips),
        inventory: Array.isArray(vocSpec.inventory) ? vocSpec.inventory : [],
        quiver: Array.isArray(vocSpec.quiver) ? vocSpec.quiver : []
    };
}

function starterEngineEquips(equips) {
    const out = Object.create(null);
    if (!equips || typeof equips !== 'object') return out;
    const keys = Object.keys(equips);
    for (let i = 0; i < keys.length; i++) {
        const slot = canonicalEquipmentSlot(keys[i]) || keys[i];
        const id = starterRowId(equips[keys[i]]);
        if (!slot || !id) continue;
        out[slot] = id;
    }
    return out;
}

function ensureInstanceContainer(inv, uid, itemDb) {
    if (!inv || !uid || inv.containers[uid]) return;
    const inst = inv.items[uid];
    const item = inst ? findItem(itemDb, inst.itemId) : null;
    const cap = containerCapacity(item || (inst && inst.itemId), itemDb);
    inv.containers[uid] = { capacity: cap, slots: emptySlots(cap), isRoot: false };
}

function placeOrBag(inv, uid, itemDb) {
    const bag = placeInContainer(inv, uid, inv.rootUid, null, itemDb);
    if (!bag.ok) destroyItem(inv, uid, itemDb);
    return bag;
}

function equipStarterSlot(inv, slot, itemId, itemDb) {
    if (!inv || !slot || !itemId) return;
    if (inv.equipment && inv.equipment[slot]) return;
    const uid = createItemInstance(inv, itemId, itemDb);
    const r = placeInEquipment(inv, uid, slot, itemDb);
    if (!r.ok) placeOrBag(inv, uid, itemDb);
}

function applyStarterLoadout(inv, vocation, itemDb, startersDoc) {
    if (!inv) return inv;
    const spec = resolveStarterSpec(vocation, startersDoc);
    const engineEquips = starterEngineEquips(spec.equips);
    const backpackId = engineEquips.backpack || DEFAULT_BACKPACK_ITEM_ID;
    if (!inv.equipment || !inv.equipment.backpack) {
        ensureEquippedBackpack(inv, itemDb, backpackId);
    }
    const seen = Object.create(null);
    for (let i = 0; i < STARTER_SLOT_ORDER.length; i++) {
        const slot = STARTER_SLOT_ORDER[i];
        seen[slot] = true;
        if (slot === 'backpack') continue;
        equipStarterSlot(inv, slot, engineEquips[slot], itemDb);
    }
    const extra = Object.keys(engineEquips);
    for (let i = 0; i < extra.length; i++) {
        if (seen[extra[i]] || extra[i] === 'backpack') continue;
        equipStarterSlot(inv, extra[i], engineEquips[extra[i]], itemDb);
    }
    for (let i = 0; i < spec.inventory.length; i++) {
        const id = starterRowId(spec.inventory[i]);
        if (!id) continue;
        addItemToInventory(inv, id, starterRowCount(spec.inventory[i]), itemDb);
    }
    if (spec.quiver.length) {
        const qUid = inv.equipment && inv.equipment.leftHand;
        if (qUid) {
            ensureInstanceContainer(inv, qUid, itemDb);
            for (let i = 0; i < spec.quiver.length; i++) {
                const id = starterRowId(spec.quiver[i]);
                if (!id) continue;
                const uid = createItemInstance(inv, id, itemDb, { count: starterRowCount(spec.quiver[i]) });
                const r = placeInContainer(inv, uid, qUid, null, itemDb);
                if (!r.ok) placeOrBag(inv, uid, itemDb);
            }
        }
    }
    recomputeTotalWeight(inv, itemDb);
    return inv;
}

function buildStarterInventory(vocation, itemDb, startersDoc) {
    const inv = createEmptyInventory();
    applyStarterLoadout(inv, vocation, itemDb, startersDoc);
    return inv;
}

module.exports = {
    ROOT_UID,
    createEmptyInventory,
    isRuntimeInventory,
    createItemInstance,
    getStackCount,
    destroyItem,
    firstFreeSlot,
    findFirstFreeSlotBfs,
    placeInContainer,
    placeInEquipment,
    moveItem,
    equipItem,
    unequipItem,
    resolveLocationUid,
    ensureEquippedBackpack,
    syncRootToEquippedBackpack,
    totalCarriedWeight,
    computeTotalCarriedWeight,
    recomputeTotalWeight,
    itemSubtreeWeight,
    canCarryAdditional,
    canAddItemToInventory,
    consumeInstanceCount,
    baseCapacity,
    remainingCapacity,
    resolveCapBand,
    countItem,
    takeItem,
    stackItem,
    addItemToInventory,
    consumeItemIdFromInventory,
    consumeAmmoForShot,
    peekAmmoForShot,
    equippedWeaponAmmoKind,
    equippedRightHandItem,
    equippedRightHandCount,
    equippedLeftHandItem,
    equippedIsThrowingWeapon,
    tryBreakEquippedThrowingWeapon,
    resolveDistanceAutoShape,
    applyPlayerLoadout,
    serializeInventory,
    serializeItemInstance,
    cloneInventory,
    seedInstanceBudgets,
    copyInstanceBudgets,
    normalizeInventory,
    bagView,
    equipmentView,
    playerCap,
    ownsContainer,
    ensurePlayerContainer,
    resolveOpenBagUid,
    itemIsMagicWeapon,
    applyStarterLoadout,
    buildStarterInventory,
    CAP_CLASS_BAND
};

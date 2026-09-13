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
    itemIsMagicWeapon,
    itemAmmoKind,
    weaponRequiredAmmoKind,
    canEquipInSlot,
    preferredEquipSlot,
    containerCapacity,
    canonicalEquipmentSlot,
    engineSlotToDesigner,
    resolveWeaponSkillFromItem,
    computeMitigationPercent,
    computeMaxBlock,
    skillValue
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
        equipment: Object.create(null)
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
    const unit = item && item.weight != null ? Number(item.weight) || 0 : 0;
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
    const inst = { uid, itemId: id, location: null };
    if (count > 1) inst.count = count;
    inv.items[uid] = inst;
    if (itemIsContainer(item) || (item && itemIsBackpackEquip(item))) {
        const cap = containerCapacity(item, itemDb);
        inv.containers[uid] = {
            capacity: cap,
            slots: emptySlots(cap),
            isRoot: false
        };
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

function destroyItem(inv, uid) {
    const inst = inv.items[uid];
    if (!inst) return false;
    const cont = inv.containers[uid];
    if (cont) {
        for (let i = 0; i < cont.slots.length; i++) {
            if (cont.slots[i]) destroyItem(inv, cont.slots[i]);
        }
        delete inv.containers[uid];
    }
    detachItem(inv, uid);
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

function mergeStacks(inv, sourceUid, destUid) {
    if (!inv || !sourceUid || !destUid || sourceUid === destUid) return false;
    const src = inv.items[sourceUid];
    const dst = inv.items[destUid];
    if (!src || !dst) return false;
    const room = stackRoom(dst);
    if (room <= 0) return false;
    const take = Math.min(getStackCount(src), room);
    if (take <= 0) return false;
    setStackCount(dst, getStackCount(dst) + take);
    const left = getStackCount(src) - take;
    if (left <= 0) destroyItem(inv, sourceUid);
    else setStackCount(src, left);
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
                mergeStacks(inv, uid, existing);
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
            mergeStacks(inv, uid, occ);
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
        destroyItem(inv, uid);
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

function moveItem(inv, from, to, itemDb) {
    if (!inv || !from || !to) return { ok: false, error: 'bad_args' };
    const uidFrom = resolveLocationUid(inv, from);
    if (!uidFrom) return { ok: false, error: 'empty_source' };
    if (locationsEqual(from, to)) return { ok: true };
    const uidTo = resolveLocationUid(inv, to);
    if (uidTo && canMergeStacks(inv, uidFrom, uidTo, itemDb)) {
        mergeStacks(inv, uidFrom, uidTo);
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

function totalCarriedWeight(inv, itemDb) {
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

function consumeItemIdFromInventory(inv, itemId, amount, startUid) {
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
            setStackCount(inst, have - take);
            need -= take;
            spent += take;
            changed = true;
            if (getStackCount(inst) <= 0) destroyItem(inv, uid);
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

function takeItem(inv, id, count) {
    if (Array.isArray(inv)) return takeItemFlat(inv, id, count);
    if (!isRuntimeInventory(inv)) return false;
    const n = Math.max(1, Math.floor(Number(count) || 1));
    const r = consumeItemIdFromInventory(inv, id, n);
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
            destroyItem(inv, uid);
            return { ok: false, error: 'full', remaining: left };
        }
        const placed = placeInContainer(inv, uid, free.containerUid, null, itemDb);
        if (!placed.ok) {
            destroyItem(inv, uid);
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
        setStackCount(inst, have - take);
        need -= take;
        spent += take;
        if (getStackCount(inst) <= 0) destroyItem(inv, uid);
    }
    return { ok: need <= 0, spent, changed: spent > 0, ammoItemId };
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
    if (qUid && inv.containers[qUid]) {
        const q = consumeAmmoFromContainer(inv, qUid, n, itemDb, kind);
        if (q.ok) return Object.assign({ needed: true }, q);
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
    if (qUid && inv.containers[qUid]) {
        const uid = findFirstAmmoUid(inv, qUid, itemDb, kind);
        if (uid) return findItem(itemDb, inv.items[uid].itemId);
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

function equippedLeftHandItem(inv, itemDb) {
    if (!inv || !inv.equipment) return null;
    const uid = inv.equipment.leftHand;
    if (!uid || !inv.items[uid]) return null;
    return findItem(itemDb, inv.items[uid].itemId);
}

function applyPlayerLoadout(session, itemDb) {
    if (!session) return;
    const inv = session.inventory;
    const right = equippedRightHandItem(inv, itemDb);
    const left = equippedLeftHandItem(inv, itemDb);
    const unarmed = !right;
    let atk = unarmed ? UNARMED_ATK : Number(right.atk) || 0;
    if (right && weaponRequiredAmmoKind(right)) {
        const ammo = peekAmmoForShot(inv, itemDb);
        if (ammo && ammo.atk != null) atk += Number(ammo.atk) || 0;
    }
    session.atk = atk;
    session.weaponSkill = unarmed ? 'fist' : (resolveWeaponSkillFromItem(right) || 'fist');
    session.weaponTier = unarmed ? 0 : Math.max(0, Math.floor(Number(right && right.tier) || 0));

    const isMagic = !!(
        right && (
            itemIsMagicWeapon(right) ||
            right.weaponType === 'magic' ||
            right.category === 'wand' ||
            right.category === 'rod'
        )
    );
    if (isMagic) {
        session.weaponType = 'magic';
        session.weaponMin = Number(right.min) || 0;
        session.weaponMax = Number(right.max) || 0;
        session.weaponElement = String(right.element || 'energy').toLowerCase();
        session.weaponRange = Math.max(1, Math.min(7, Number(right.range) || 4));
        session.weaponManaGain = Math.max(0, Math.floor(Number(right.manaGain) || 0));
    } else {
        session.weaponType = unarmed ? 'fist' : (right.weaponType || 'melee');
        session.weaponMin = 0;
        session.weaponMax = 0;
        session.weaponElement = null;
        session.weaponRange = 1;
        session.weaponManaGain = 0;
    }

    session._gearSkillBonus = Object.create(null);
    let armor = 0;
    let extraCrit = 0;
    let extraCritDmg = 0;
    const eq = inv && inv.equipment;
    if (eq) {
        const keys = Object.keys(eq);
        for (let i = 0; i < keys.length; i++) {
            if (keys[i] === 'backpack') continue;
            const inst = inv.items[eq[keys[i]]];
            if (!inst) continue;
            const item = findItem(itemDb, inst.itemId);
            if (!item) continue;
            armor += Number(item.armor) || 0;
            extraCrit += Number(item.critChance) || 0;
            extraCritDmg += Number(item.critExtraDamage) || Number(item.critDamage) || 0;
            const bonuses = item.skillBonuses || item.skills;
            if (bonuses && typeof bonuses === 'object') {
                const bk = Object.keys(bonuses);
                for (let b = 0; b < bk.length; b++) {
                    const k = bk[b];
                    session._gearSkillBonus[k] = (session._gearSkillBonus[k] || 0) + (Number(bonuses[k]) || 0);
                }
            }
        }
    }
    session.armor = armor;
    if (session._baseCritChance == null) session._baseCritChance = Number(session.critChance) || 0;
    if (session._baseCritDamage == null) session._baseCritDamage = Number(session.critDamage) || 0;
    session.critChance = session._baseCritChance + extraCrit;
    session.critDamage = session._baseCritDamage + extraCritDmg;
    const skills = session.skills;
    const shielding = skillValue(skills, 'shielding');
    const shield = itemIsShield(left);
    if (unarmed && !shield) {
        session.mitigation = 0;
        session.maxBlock = 0;
        session.canBlock = false;
        return;
    }
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

function serializeInventory(inv) {
    if (!isRuntimeInventory(inv)) return { items: [] };
    return JSON.parse(JSON.stringify({
        version: 1,
        nextUid: inv.nextUid | 0,
        items: inv.items,
        containers: inv.containers,
        rootUid: inv.rootUid,
        equipment: inv.equipment
    }));
}

function cloneInventory(inv) {
    const raw = serializeInventory(inv);
    if (!isRuntimeInventory(raw)) return createEmptyInventory();
    const out = {
        nextUid: Math.max(1, raw.nextUid | 0),
        items: Object.create(null),
        containers: Object.create(null),
        rootUid: raw.rootUid || ROOT_UID,
        equipment: Object.create(null)
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
            count: row.count
        };
        if (row.count == null) delete out.items[row.uid].count;
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
        return inv;
    }
    const inv = createEmptyInventory();
    ensureEquippedBackpack(inv, itemDb);
    if (Array.isArray(raw)) migrateFlatItems(inv, raw, itemDb);
    else if (raw && typeof raw === 'object' && Array.isArray(raw.items)) {
        migrateFlatItems(inv, raw.items, itemDb);
    }
    return inv;
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
        slots.push({
            slot: engineSlotToDesigner(keys[i]),
            id: inst.itemId,
            count: getStackCount(inst)
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
    itemSubtreeWeight,
    canCarryAdditional,
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
    equippedLeftHandItem,
    applyPlayerLoadout,
    serializeInventory,
    normalizeInventory,
    bagView,
    equipmentView,
    playerCap,
    ownsContainer,
    itemIsMagicWeapon,
    CAP_CLASS_BAND
};

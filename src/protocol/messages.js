'use strict';

const { PROTOCOL_VERSION, APPEAR_FLAG, SKILL_ORDER, LOC_KIND, swingElementId } = require('./opcodes');
const { FastWriter, Writer, Reader, clampU16 } = require('./frame');

function wrap(fn, payload) {
    try {
        return fn(payload);
    } catch {
        return null;
    }
}

function encodeHello({ ups, tickIndex, enterTimeoutMs, protocolVersion }) {
    return new FastWriter()
        .u16(protocolVersion == null ? PROTOCOL_VERSION : protocolVersion)
        .u8(ups)
        .u32(tickIndex >>> 0)
        .u16(enterTimeoutMs)
        .toBuffer();
}

function decodeHello(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        return {
            protocolVersion: r.u16(),
            ups: r.u8(),
            tickIndex: r.u32(),
            enterTimeoutMs: r.u16()
        };
    }, payload);
}

function encodeKick(reason) {
    return new FastWriter().u8(reason).toBuffer();
}

function decodeKick(payload) {
    return wrap((p) => new Reader(p).u8(), payload);
}

function encodeReject(refSeq, reason) {
    return new FastWriter().u32(refSeq).u8(reason).toBuffer();
}

function decodeReject(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        return { refSeq: r.u32(), reason: r.u8() };
    }, payload);
}

function encodePong(clientMs, serverMs, tickIndex) {
    return new FastWriter()
        .u32(clientMs >>> 0)
        .u32(serverMs >>> 0)
        .u32(tickIndex >>> 0)
        .toBuffer();
}

function decodePong(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        return { clientMs: r.u32(), serverMs: r.u32(), tickIndex: r.u32() };
    }, payload);
}

function decodePing(payload) {
    return wrap((p) => {
        if (!p || p.length !== 4) {
            throw new Error('bad ping');
        }
        return new Reader(p).u32();
    }, payload);
}

function decodeMoveStep(payload) {
    return wrap((p) => {
        if (!p || p.length !== 1) {
            throw new Error('bad move');
        }
        return new Reader(p).u8();
    }, payload);
}

function encodeMovePath(dirs) {
    const list = Array.isArray(dirs) ? dirs : [];
    const n = Math.min(255, list.length);
    const w = new FastWriter().u8(n);
    for (let i = 0; i < n; i++) {
        w.u8(list[i] & 0xff);
    }
    return w.toBuffer();
}

function decodeMovePath(payload) {
    return wrap((p) => {
        if (!p || p.length < 1) {
            throw new Error('bad move path');
        }
        const n = p[0];
        if (p.length !== 1 + n) {
            throw new Error('bad move path');
        }
        const dirs = [];
        for (let i = 0; i < n; i++) {
            const d = p[1 + i];
            if (d > 3) {
                throw new Error('bad move path');
            }
            dirs.push(d);
        }
        return dirs;
    }, payload);
}

function decodeUseStair(payload) {
    return wrap((p) => {
        if (p && p.length !== 0) {
            throw new Error('bad use stair');
        }
        return true;
    }, payload);
}

function encodeUseTile(x, y, z) {
    return new FastWriter()
        .i16(x)
        .i16(y)
        .i8(z)
        .toBuffer();
}

function decodeUseTile(payload) {
    return wrap((p) => {
        if (!p || p.length !== 5) {
            throw new Error('bad use');
        }
        const r = new Reader(p);
        return { x: r.i16(), y: r.i16(), z: r.i8() };
    }, payload);
}

function encodeUseItemWith({ x, y, z, itemId }) {
    return new FastWriter()
        .i16(x)
        .i16(y)
        .i8(z)
        .str(itemId || '')
        .toBuffer();
}

function decodeUseItemWith(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const x = r.i16();
        const y = r.i16();
        const z = r.i8();
        const itemId = r.str();
        if (!itemId) {
            throw new Error('bad use with');
        }
        return { x, y, z, itemId };
    }, payload);
}

function worldPinFlags(inst) {
    let flags = 0;
    if (inst && inst.blocking) flags |= 1;
    if (inst && inst.pickupable) flags |= 2;
    return flags;
}

function encodeWorldPin(inst) {
    return new FastWriter()
        .u32((inst && inst.id) >>> 0)
        .i16(inst && inst.x)
        .i16(inst && inst.y)
        .i8(inst && inst.z)
        .str((inst && inst.kind) || '')
        .str((inst && inst.catalogId) || '')
        .u8(worldPinFlags(inst))
        .toBuffer();
}

function decodeWorldPin(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        return {
            id: r.u32(),
            x: r.i16(),
            y: r.i16(),
            z: r.i8(),
            kind: r.str(),
            catalogId: r.str(),
            flags: r.rest().length ? r.u8() : 0
        };
    }, payload);
}

function encodeWorldPinGone(id) {
    return new FastWriter().u32(id >>> 0).toBuffer();
}

function decodeWorldPinGone(payload) {
    return wrap((p) => new Reader(p).u32(), payload);
}

function writeViewport(w, vp) {
    w.i16(vp.originX);
    w.i16(vp.originY);
    w.i8(vp.z);
    w.u8(vp.width);
    w.u8(vp.height);
    w.u16array(vp.tiles);
}

function readViewport(r) {
    const originX = r.i16();
    const originY = r.i16();
    const z = r.i8();
    const width = r.u8();
    const height = r.u8();
    const tiles = r.u16array(width * height);
    return { originX, originY, z, width, height, tiles };
}

function encodeEnterWorld({ character, x, y, z, viewport }) {
    const w = new FastWriter();
    w.u32(character.id);
    w.str(character.name);
    w.str(character.vocation);
    w.u16(character.level);
    w.u32(Math.min(0xffffffff, Number(character.experience) || 0));
    w.u16(clampU16(character.hp));
    w.u16(clampU16(character.hpMax));
    w.u16(clampU16(character.mp));
    w.u16(clampU16(character.mpMax));
    w.i16(x);
    w.i16(y);
    w.i8(z);
    w.u16(character.townId);
    writeViewport(w, viewport);
    return w.toBuffer();
}

function decodeEnterWorld(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        return {
            characterId: r.u32(),
            name: r.str(),
            vocation: r.str(),
            level: r.u16(),
            experience: r.u32(),
            hp: r.u16(),
            hpMax: r.u16(),
            mp: r.u16(),
            mpMax: r.u16(),
            x: r.i16(),
            y: r.i16(),
            z: r.i8(),
            townId: r.u16(),
            viewport: readViewport(r)
        };
    }, payload);
}

function appearLook(entity) {
    if (entity && entity.kind) return String(entity.kind).slice(0, 80);
    const ch = entity && entity.character;
    if (ch && ch.vocation) return String(ch.vocation).slice(0, 80);
    if (entity && entity.vocation) return String(entity.vocation).slice(0, 80);
    return '';
}

function appearView(entity) {
    const ch = entity && entity.character;
    return {
        id: entity && entity.id != null ? entity.id | 0 : 0,
        name: entity && entity.name != null
            ? String(entity.name)
            : String((ch && ch.name) || ''),
        x: entity && entity.x != null ? entity.x | 0 : 0,
        y: entity && entity.y != null ? entity.y | 0 : 0,
        z: entity && entity.z != null ? entity.z | 0 : 0,
        hp: entity && entity.hp != null ? entity.hp : (ch && ch.hp) || 0,
        hpMax: entity && entity.hpMax != null ? entity.hpMax : (ch && ch.hpMax) || 0,
        look: appearLook(entity)
    };
}

function appearFlags(entity) {
    if (entity && (entity.type === 'npc' || entity.isNpc)) return APPEAR_FLAG.NPC;
    return 0;
}

function encodeAppear(entity) {
    const v = appearView(entity);
    return new FastWriter()
        .u32(v.id)
        .str(v.name)
        .i16(v.x)
        .i16(v.y)
        .i8(v.z)
        .u16(clampU16(v.hp))
        .u16(clampU16(v.hpMax))
        .u8(appearFlags(entity))
        .str(v.look || '')
        .u8(entity && entity.dir != null ? (entity.dir & 3) : 0)
        .toBuffer();
}

function decodeAppear(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        return {
            id: r.u32(),
            name: r.str(),
            x: r.i16(),
            y: r.i16(),
            z: r.i8(),
            hp: r.u16(),
            hpMax: r.u16(),
            flags: r.rest().length ? r.u8() : 0,
            look: r.rest().length ? r.str() : '',
            dir: r.rest().length ? r.u8() : 0
        };
    }, payload);
}

function encodeDisappear(id) {
    return new FastWriter().u32(id).toBuffer();
}

function decodeDisappear(payload) {
    return wrap((p) => new Reader(p).u32(), payload);
}

function encodeViewport(vp) {
    const w = new FastWriter();
    writeViewport(w, vp);
    return w.toBuffer();
}

function decodeViewport(payload) {
    return wrap((p) => readViewport(new Reader(p)), payload);
}

function encodeMove({ id, x, y, z, dir }) {
    return new FastWriter()
        .u32(id)
        .i16(x)
        .i16(y)
        .i8(z)
        .u8(dir)
        .toBuffer();
}

function decodeMove(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        return {
            id: r.u32(),
            x: r.i16(),
            y: r.i16(),
            z: r.i8(),
            dir: r.u8()
        };
    }, payload);
}

function decodeSetTarget(payload) {
    return wrap((p) => {
        if (!p || p.length !== 4) {
            throw new Error('bad target');
        }
        return new Reader(p).u32();
    }, payload);
}

function decodeOpenCorpse(payload) {
    return wrap((p) => {
        if (!p || p.length !== 4) {
            throw new Error('bad corpse');
        }
        return new Reader(p).u32();
    }, payload);
}

function decodeLootTake(payload) {
    return wrap((p) => {
        if (!p || p.length !== 5) {
            throw new Error('bad loot');
        }
        const r = new Reader(p);
        return { corpseId: r.u32(), slot: r.u8() };
    }, payload);
}

function decodeLootClose(payload) {
    return wrap((p) => {
        if (!p || p.length !== 4) {
            throw new Error('bad close');
        }
        return new Reader(p).u32();
    }, payload);
}

function encodeStats(entity) {
    const ch = entity && entity.character;
    const mp = entity && entity.mp != null ? entity.mp : (ch && ch.mp) || 0;
    const mpMax = entity && entity.mpMax != null ? entity.mpMax : (ch && ch.mpMax) || 0;
    const v = appearView(entity);
    return new FastWriter()
        .u32(v.id)
        .u16(clampU16(v.hp))
        .u16(clampU16(v.hpMax))
        .u16(clampU16(mp))
        .u16(clampU16(mpMax))
        .toBuffer();
}

function decodeStats(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        return {
            id: r.u32(),
            hp: r.u16(),
            hpMax: r.u16(),
            mp: r.u16(),
            mpMax: r.u16()
        };
    }, payload);
}

function encodeSwing({ sourceId, targetId, amount, flags, element, weaponId, ammoId }) {
    return new FastWriter()
        .u32(sourceId >>> 0)
        .u32(targetId >>> 0)
        .u16(clampU16(amount))
        .u8(flags || 0)
        .u8(swingElementId(element))
        .str(weaponId || '')
        .str(ammoId || '')
        .toBuffer();
}

function decodeSwing(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const out = {
            sourceId: r.u32(),
            targetId: r.u32(),
            amount: r.u16(),
            flags: r.u8(),
            element: 0,
            weaponId: '',
            ammoId: ''
        };
        if (r.rest().length) out.element = r.u8();
        if (r.rest().length) out.weaponId = r.str();
        if (r.rest().length) out.ammoId = r.str();
        return out;
    }, payload);
}

function encodeDeath(id, killerId) {
    return new FastWriter()
        .u32(id >>> 0)
        .u32((killerId || 0) >>> 0)
        .toBuffer();
}

function decodeDeath(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        return { id: r.u32(), killerId: r.u32() };
    }, payload);
}

function encodeCorpse(corpse) {
    return new FastWriter()
        .u32(corpse.id >>> 0)
        .i16(corpse.x)
        .i16(corpse.y)
        .i8(corpse.z)
        .str(corpse.name || '')
        .toBuffer();
}

function decodeCorpse(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        return {
            id: r.u32(),
            x: r.i16(),
            y: r.i16(),
            z: r.i8(),
            name: r.str()
        };
    }, payload);
}

function encodeCorpseGone(id) {
    return new FastWriter().u32(id >>> 0).toBuffer();
}

function decodeCorpseGone(payload) {
    return wrap((p) => new Reader(p).u32(), payload);
}

function encodeContainer(corpse) {
    const items = (corpse && corpse.items) || [];
    const w = new FastWriter();
    w.u32((corpse && corpse.id) >>> 0);
    w.u8(Math.min(255, items.length));
    const n = Math.min(255, items.length);
    for (let i = 0; i < n; i++) {
        w.str(items[i].id);
        w.u16(clampU16(items[i].count));
    }
    return w.toBuffer();
}

function decodeContainer(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const id = r.u32();
        const n = r.u8();
        const items = [];
        for (let i = 0; i < n; i++) {
            items.push({ id: r.str(), count: r.u16() });
        }
        return { id, items };
    }, payload);
}

function encodeItemGain(id, count) {
    return new FastWriter()
        .str(id)
        .u16(clampU16(count))
        .toBuffer();
}

function decodeItemGain(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        return { id: r.str(), count: r.u16() };
    }, payload);
}

function encodeExp(total, gained, level) {
    const w = new FastWriter()
        .u32(total >>> 0)
        .u32(gained >>> 0);
    if (level != null) w.u16(clampU16(level));
    return w.toBuffer();
}

function decodeExp(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const out = { experience: r.u32(), gained: r.u32() };
        if (r.rest().length >= 2) out.level = r.u16();
        return out;
    }, payload);
}

function writeItemList(w, items) {
    const n = Math.min(255, (items && items.length) || 0);
    w.u8(n);
    for (let i = 0; i < n; i++) {
        w.str(items[i].id);
        w.u16(clampU16(items[i].count));
    }
}

function readItemList(r) {
    const n = r.u8();
    const items = [];
    for (let i = 0; i < n; i++) {
        items.push({ id: r.str(), count: r.u16() });
    }
    return items;
}

function asBagView(input) {
    if (input && Array.isArray(input.slots)) {
        return {
            containerId: input.containerId != null ? String(input.containerId) : '',
            capacity: input.capacity | 0,
            slots: input.slots
        };
    }
    const list = Array.isArray(input) ? input : [];
    const slots = [];
    for (let i = 0; i < list.length; i++) {
        slots.push({
            index: i,
            id: list[i].id,
            count: list[i].count,
            flags: list[i].flags | 0
        });
    }
    return { containerId: 'root', capacity: Math.max(list.length, 20), slots };
}

function encodeInventory(input) {
    const view = asBagView(input);
    const w = new FastWriter();
    w.str(view.containerId || '');
    w.u8(Math.min(255, view.capacity | 0));
    const slots = view.slots || [];
    const n = Math.min(255, slots.length);
    w.u8(n);
    for (let i = 0; i < n; i++) {
        w.u8(slots[i].index | 0);
        w.str(slots[i].id);
        w.u16(clampU16(slots[i].count));
        w.u8(slots[i].flags | 0);
    }
    return w.toBuffer();
}

function decodeInventory(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const containerId = r.str();
        const capacity = r.u8();
        const n = r.u8();
        const slots = [];
        for (let i = 0; i < n; i++) {
            slots.push({
                index: r.u8(),
                id: r.str(),
                count: r.u16(),
                flags: r.u8()
            });
        }
        return { containerId, capacity, slots };
    }, payload);
}

function encodeEquipment({ cap, capMax, slots }) {
    const w = new FastWriter();
    w.u16(clampU16(cap));
    w.u16(clampU16(capMax));
    const list = slots || [];
    const n = Math.min(255, list.length);
    w.u8(n);
    for (let i = 0; i < n; i++) {
        w.str(list[i].slot);
        w.str(list[i].id);
        w.u16(clampU16(list[i].count));
    }
    return w.toBuffer();
}

function decodeEquipment(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const cap = r.u16();
        const capMax = r.u16();
        const n = r.u8();
        const slots = [];
        for (let i = 0; i < n; i++) {
            slots.push({ slot: r.str(), id: r.str(), count: r.u16() });
        }
        return { cap, capMax, slots };
    }, payload);
}

function encodeBag(view) {
    return encodeInventory(view);
}

function decodeBag(payload) {
    return decodeInventory(payload);
}

function encodeContainerSlot(containerId, index) {
    return new FastWriter()
        .str(containerId || '')
        .u8(index | 0)
        .toBuffer();
}

function decodeContainerSlot(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const containerId = r.str();
        const index = r.u8();
        return { containerId, index };
    }, payload);
}

function encodeEquip(containerId, index, slot) {
    const w = new FastWriter()
        .str(containerId || '')
        .u8(index | 0);
    w.str(slot || '');
    return w.toBuffer();
}

function decodeEquip(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const containerId = r.str();
        const index = r.u8();
        const slot = r.rest().length ? r.str() : '';
        return { containerId, index, slot };
    }, payload);
}

function encodeUnequip(slot) {
    return new FastWriter().str(slot || '').toBuffer();
}

function decodeUnequip(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const slot = r.str();
        if (!slot) throw new Error('bad unequip');
        return slot;
    }, payload);
}

function writeItemLoc(w, loc) {
    if (loc && loc.kind === 'equipment') {
        w.u8(LOC_KIND.EQUIPMENT);
        w.str(loc.slot || '');
        return;
    }
    w.u8(LOC_KIND.CONTAINER);
    w.str((loc && loc.containerUid) || '');
    w.u8((loc && loc.index) | 0);
}

function encodeMoveItem(from, to, count) {
    const w = new FastWriter();
    writeItemLoc(w, from);
    writeItemLoc(w, to);
    w.u16(clampU16(count || 0));
    return w.toBuffer();
}

function readItemLoc(r) {
    const kind = r.u8();
    if (kind === LOC_KIND.EQUIPMENT) {
        return { kind: 'equipment', slot: r.str() };
    }
    return { kind: 'container', containerUid: r.str(), index: r.u8() };
}

function decodeMoveItem(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const from = readItemLoc(r);
        const to = readItemLoc(r);
        const count = r.rest().length >= 2 ? r.u16() : 0;
        return { from, to, count };
    }, payload);
}

function encodeSay(text, extra) {
    const speakerId = extra && extra.speakerId != null ? extra.speakerId >>> 0 : 0;
    const yell = extra && (extra.yell === true || extra.yell === 1) ? 1 : 0;
    return new FastWriter()
        .str(text == null ? '' : text)
        .u32(speakerId)
        .u8(yell)
        .toBuffer();
}

function encodeSkills(skills) {
    const w = new FastWriter();
    const src = skills && typeof skills === 'object' ? skills : {};
    for (let i = 0; i < SKILL_ORDER.length; i++) {
        const n = Math.floor(Number(src[SKILL_ORDER[i]]));
        w.u16(clampU16(Number.isFinite(n) && n >= 0 ? n : 0));
    }
    return w.toBuffer();
}

function decodeSkills(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const out = {};
        for (let i = 0; i < SKILL_ORDER.length; i++) {
            out[SKILL_ORDER[i]] = r.u16();
        }
        return out;
    }, payload);
}

function decodeSay(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const text = r.str();
        const speakerId = r.rest().length >= 4 ? r.u32() : 0;
        const yell = r.rest().length >= 1 ? r.u8() !== 0 : false;
        return { text, speakerId, yell };
    }, payload);
}

function decodeTalk(payload) {
    return wrap((p) => {
        if (!p || p.length !== 4) {
            throw new Error('bad talk');
        }
        return new Reader(p).u32();
    }, payload);
}

function decodeTalkReply(payload) {
    return wrap((p) => {
        if (!p || p.length !== 5) {
            throw new Error('bad reply');
        }
        const r = new Reader(p);
        return { npcId: r.u32(), index: r.u8() };
    }, payload);
}

function decodeTalkClose(payload) {
    return wrap((p) => {
        if (!p || p.length !== 4) {
            throw new Error('bad close');
        }
        return new Reader(p).u32();
    }, payload);
}

function decodeShopDeal(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const npcId = r.u32();
        const count = r.u16();
        const itemId = r.str();
        if (!itemId) {
            throw new Error('bad deal');
        }
        return { npcId, count, itemId };
    }, payload);
}

function encodeDialog({ npcId, nodeId, text, replies }) {
    const list = replies || [];
    const n = Math.min(255, list.length);
    const w = new FastWriter();
    w.u32(npcId >>> 0);
    w.str(nodeId || '');
    w.str(text == null ? '' : text);
    w.u8(n);
    for (let i = 0; i < n; i++) {
        w.str(list[i].label != null ? list[i].label : list[i].text || '');
    }
    return w.toBuffer();
}

function decodeDialog(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const npcId = r.u32();
        const nodeId = r.str();
        const text = r.str();
        const n = r.u8();
        const replies = [];
        for (let i = 0; i < n; i++) {
            replies.push({ label: r.str() });
        }
        return { npcId, nodeId, text, replies };
    }, payload);
}

function encodeDialogClose(npcId) {
    return new FastWriter().u32(npcId >>> 0).toBuffer();
}

function decodeDialogClose(payload) {
    return wrap((p) => new Reader(p).u32(), payload);
}

function encodeShop({ npcId, currency, items }) {
    const list = items || [];
    const n = Math.min(255, list.length);
    const w = new FastWriter();
    w.u32(npcId >>> 0);
    w.str(currency || 'gold_coin');
    w.u8(n);
    for (let i = 0; i < n; i++) {
        w.str(list[i].itemId);
        w.u16(clampU16(list[i].buy));
        w.u16(clampU16(list[i].sell));
    }
    return w.toBuffer();
}

function decodeShop(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const npcId = r.u32();
        const currency = r.str();
        const n = r.u8();
        const items = [];
        for (let i = 0; i < n; i++) {
            items.push({ itemId: r.str(), buy: r.u16(), sell: r.u16() });
        }
        return { npcId, currency, items };
    }, payload);
}

function encodeCast({ spellId, targetId, x, y, z }) {
    return new FastWriter()
        .str(spellId || '')
        .u32((targetId || 0) >>> 0)
        .i16(x || 0)
        .i16(y || 0)
        .i8(z || 0)
        .toBuffer();
}

function decodeCast(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const spellId = r.str();
        if (!spellId) throw new Error('bad cast');
        const targetId = r.rest().length >= 4 ? r.u32() : 0;
        let x = 0;
        let y = 0;
        let z = 0;
        if (r.rest().length >= 5) {
            x = r.i16();
            y = r.i16();
            z = r.i8();
        }
        return { spellId, targetId, x, y, z };
    }, payload);
}

function encodeCastFx({ sourceId, spellId, targetId, x, y, z, flags }) {
    return new FastWriter()
        .u32((sourceId || 0) >>> 0)
        .str(spellId || '')
        .u32((targetId || 0) >>> 0)
        .i16(x || 0)
        .i16(y || 0)
        .i8(z || 0)
        .u8(flags || 0)
        .toBuffer();
}

function decodeCastFx(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        return {
            sourceId: r.u32(),
            spellId: r.str(),
            targetId: r.u32(),
            x: r.i16(),
            y: r.i16(),
            z: r.i8(),
            flags: r.rest().length ? r.u8() : 0
        };
    }, payload);
}

function fieldCreatedTick(field) {
    if (field && field.createdTick != null) return field.createdTick >>> 0;
    const createdAt = field && field.createdAt != null ? Number(field.createdAt) : 0;
    if (!Number.isFinite(createdAt) || createdAt <= 0) return 0;
    const ups = (field && field.logicUps != null && Number(field.logicUps) > 0)
        ? Number(field.logicUps)
        : 20;
    return Math.round(createdAt * ups) >>> 0;
}

function encodeField(field) {
    let flags = 0;
    if (field && field.isObstacle) flags |= 1;
    if (field && field.source === 'player') flags |= 2;
    return new FastWriter()
        .i16(field && field.x)
        .i16(field && field.y)
        .i8(field && field.z)
        .str((field && (field.fieldKind || field.kind)) || '')
        .u8(flags)
        .u32(fieldCreatedTick(field))
        .toBuffer();
}

function decodeField(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        const out = {
            x: r.i16(),
            y: r.i16(),
            z: r.i8(),
            kind: r.str(),
            flags: 0,
            createdTick: null
        };
        if (r.rest().length) out.flags = r.u8();
        if (r.rest().length >= 4) out.createdTick = r.u32();
        return out;
    }, payload);
}

function encodeFieldGone(x, y, z) {
    return new FastWriter().i16(x).i16(y).i8(z).toBuffer();
}

function decodeFieldGone(payload) {
    return wrap((p) => {
        const r = new Reader(p);
        return { x: r.i16(), y: r.i16(), z: r.i8() };
    }, payload);
}


module.exports = {
    encodeHello,
    decodeHello,
    encodeKick,
    decodeKick,
    encodeReject,
    decodeReject,
    encodePong,
    decodePong,
    decodePing,
    decodeMoveStep,
    encodeMovePath,
    decodeMovePath,
    decodeUseStair,
    encodeUseTile,
    decodeUseTile,
    encodeUseItemWith,
    decodeUseItemWith,
    encodeWorldPin,
    decodeWorldPin,
    encodeWorldPinGone,
    decodeWorldPinGone,
    decodeSetTarget,
    decodeOpenCorpse,
    decodeLootTake,
    decodeLootClose,
    encodeEnterWorld,
    decodeEnterWorld,
    appearView,
    appearLook,
    encodeAppear,
    decodeAppear,
    encodeDisappear,
    decodeDisappear,
    encodeViewport,
    decodeViewport,
    encodeMove,
    decodeMove,
    encodeStats,
    decodeStats,
    encodeSwing,
    decodeSwing,
    encodeDeath,
    decodeDeath,
    encodeCorpse,
    decodeCorpse,
    encodeCorpseGone,
    decodeCorpseGone,
    encodeContainer,
    decodeContainer,
    encodeItemGain,
    decodeItemGain,
    encodeExp,
    decodeExp,
    encodeInventory,
    decodeInventory,
    encodeEquipment,
    decodeEquipment,
    encodeBag,
    decodeBag,
    encodeContainerSlot,
    decodeContainerSlot,
    encodeEquip,
    decodeEquip,
    encodeUnequip,
    decodeUnequip,
    encodeMoveItem,
    decodeMoveItem,
    encodeSay,
    decodeSay,
    encodeSkills,
    decodeSkills,
    decodeTalk,
    decodeTalkReply,
    decodeTalkClose,
    decodeShopDeal,
    encodeCast,
    decodeCast,
    encodeCastFx,
    decodeCastFx,
    encodeField,
    decodeField,
    encodeFieldGone,
    decodeFieldGone,
    encodeDialog,
    decodeDialog,
    encodeDialogClose,
    decodeDialogClose,
    encodeShop,
    decodeShop
};

'use strict';

const { S2C, REASON, INV_FLAG } = require('../protocol/opcodes');
const { encodeTrade, encodeTradeClose, decodeTradeOffer } = require('../protocol/messages');
const {
    findItem,
    itemIsContainer,
    itemIsStackable,
    canonicalEquipmentSlot
} = require('./items');
const {
    getStackCount,
    itemSubtreeWeight,
    computeTotalCarriedWeight,
    canCarryAdditional,
    recomputeTotalWeight,
    syncRootToEquippedBackpack,
    resolveLocationUid,
    ownsContainer
} = require('./inventory');
const {
    transferItemTree,
    groundRootLocation,
    locIsGroundContainer,
    resolveStackUid,
    getStack,
    removeFromTileStack,
    tileKey
} = require('./ground_items');

const PARTNER_RANGE = 2;
const ITEM_RANGE = 1;
const TRADE_MAX = 100;

const ALREADY = 'You are already trading. Finish this trade first.';
const PARTNER_BUSY = 'This player is already trading.';
const NOT_POSSIBLE = 'Sorry, not possible.';
const ALREADY_ITEM = 'This item is already being traded.';
const TOO_MANY = 'You can not trade more than 100 items.';
const CANCELLED = 'Trade cancelled.';
const INCOMPLETE = 'Trade could not be completed.';
const UPSTAIRS = 'First go upstairs.';
const DOWNSTAIRS = 'First go downstairs.';

function chebyshev(ax, ay, az, bx, by, bz) {
    if ((az | 0) !== (bz | 0)) return Infinity;
    return Math.max(Math.abs((ax | 0) - (bx | 0)), Math.abs((ay | 0) - (by | 0)));
}

function manyObjects(inst, itemDb) {
    const item = inst ? findItem(itemDb, inst.itemId) : null;
    return !!(item && itemIsStackable(item) && getStackCount(inst) > 1);
}

function weightOz(weight) {
    const w = Math.max(0, Math.round(Number(weight) || 0));
    if (!(w > 0)) return '';
    let body;
    if (w < 10) body = '0.0' + String(w);
    else if (w < 100) body = '0.' + String(w);
    else {
        const s = String(w);
        body = s.slice(0, -2) + '.' + s.slice(-2);
    }
    return body;
}

function failureSentence(kind, inst, itemDb, weight) {
    if (kind !== 'cap' && kind !== 'room') return INCOMPLETE;
    const phrase = manyObjects(inst, itemDb) ? 'these objects.' : 'this object.';
    if (kind === 'room') return 'You do not have enough room to carry ' + phrase;
    let text = 'You do not have enough capacity to carry ' + phrase;
    const oz = weightOz(weight);
    if (oz) {
        const lead = manyObjects(inst, itemDb) ? 'They weigh ' : 'It weighs ';
        text += '\n ' + lead + oz + ' oz.';
    }
    return text;
}

function contains(inv, ancestor, node) {
    if (!inv || !ancestor || !node) return false;
    if (ancestor === node) return true;
    let cur = node;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
        seen.add(cur);
        const inst = inv.items[cur];
        if (!inst || !inst.location || inst.location.kind !== 'container') return false;
        cur = inst.location.containerUid;
        if (cur === ancestor) return true;
    }
    return false;
}

function detachLocal(inv, uid) {
    const inst = inv && inv.items[uid];
    if (!inst || !inst.location) return;
    const loc = inst.location;
    if (loc.kind === 'equipment') {
        if (inv.equipment && inv.equipment[loc.slot] === uid) delete inv.equipment[loc.slot];
    } else if (loc.kind === 'container') {
        const cont = inv.containers[loc.containerUid];
        if (cont && cont.slots[loc.index] === uid) cont.slots[loc.index] = null;
    }
    inst.location = null;
}

function occupied(cont) {
    if (!cont || !Array.isArray(cont.slots)) return 0;
    let n = 0;
    for (let i = 0; i < cont.slots.length; i++) {
        if (cont.slots[i]) n += 1;
    }
    return n;
}

function hasFreeSlot(cont) {
    if (!cont || !Array.isArray(cont.slots)) return false;
    const n = occupied(cont);
    return n < (cont.capacity | 0) && n < cont.slots.length;
}

function compact(inv, cuid) {
    const cont = inv.containers[cuid];
    if (!cont) return;
    const packed = [];
    for (let i = 0; i < cont.slots.length; i++) {
        const id = cont.slots[i];
        if (id && inv.items[id]) packed.push(id);
    }
    for (let i = 0; i < cont.slots.length; i++) {
        const id = i < packed.length ? packed[i] : null;
        cont.slots[i] = id;
        if (id) inv.items[id].location = { kind: 'container', containerUid: cuid, index: i };
    }
}

function insertFront(inv, uid, cuid) {
    const cont = inv.containers[cuid];
    const cap = cont.slots.length;
    for (let i = cap - 1; i > 0; i--) cont.slots[i] = cont.slots[i - 1];
    cont.slots[0] = uid;
    for (let i = 0; i < cap; i++) {
        const id = cont.slots[i];
        if (id && inv.items[id]) {
            inv.items[id].location = { kind: 'container', containerUid: cuid, index: i };
        }
    }
}

function hasTradeRoom(inv) {
    if (!inv) return false;
    const queue = [inv.rootUid];
    const seen = new Set();
    while (queue.length) {
        const cuid = queue.shift();
        if (!cuid || seen.has(cuid)) continue;
        seen.add(cuid);
        const cont = inv.containers[cuid];
        if (!cont) continue;
        if (hasFreeSlot(cont)) return true;
        for (let i = 0; i < cont.slots.length; i++) {
            const child = cont.slots[i];
            if (child && inv.containers[child]) queue.push(child);
        }
    }
    return false;
}

function placeTrade(inv, uid) {
    const inst = inv && inv.items[uid];
    if (!inst || inst.location) return false;
    const queue = [inv.rootUid];
    const seen = new Set();
    while (queue.length) {
        const cuid = queue.shift();
        if (!cuid || seen.has(cuid)) continue;
        seen.add(cuid);
        const cont = inv.containers[cuid];
        if (!cont) continue;
        if (hasFreeSlot(cont)) {
            compact(inv, cuid);
            insertFront(inv, uid, cuid);
            return true;
        }
        for (let i = 0; i < cont.slots.length; i++) {
            const child = cont.slots[i];
            if (child && inv.containers[child] && child !== uid) queue.push(child);
        }
    }
    return false;
}

function tradeList(inv, uid, itemDb) {
    const out = [];
    const queue = [];
    function push(id) {
        const inst = inv.items[id];
        if (!inst) return;
        const def = findItem(itemDb, inst.itemId);
        const isCont = !!(inv.containers[id] || itemIsContainer(def));
        out.push({
            id: inst.itemId,
            count: getStackCount(inst),
            flags: isCont ? INV_FLAG.CONTAINER : 0
        });
        if (inv.containers[id]) queue.push(id);
    }
    push(uid);
    let qi = 0;
    while (qi < queue.length && out.length <= TRADE_MAX) {
        const cuid = queue[qi++];
        const cont = inv.containers[cuid];
        if (!cont) continue;
        for (let i = 0; i < cont.slots.length; i++) {
            if (cont.slots[i]) push(cont.slots[i]);
        }
    }
    return out;
}

function engineSlot(name) {
    return canonicalEquipmentSlot(name) || name;
}

class TradeBook {
    constructor(world) {
        this.world = world;
        this.byId = new Map();
        this.transferring = false;
    }

    offer(session, intent) {
        const body = decodeTradeOffer(intent.payload);
        if (!body || !body.from) {
            session.malformed();
            return;
        }
        const partner = this.partner(session, body.partnerId);
        if (!partner) {
            this.world.say(session, NOT_POSSIBLE);
            return;
        }
        if (chebyshev(session.x, session.y, session.z, partner.x, partner.y, partner.z) > PARTNER_RANGE) {
            this.world.say(session, partner.name + ' tells you to move closer.');
            return;
        }
        const found = this.resolve(session, body.from);
        if (!found.ok) {
            if (found.reason === 'range') session.reject(intent.seq, REASON.OUT_OF_RANGE);
            else if (found.reason === 'up') this.world.say(session, UPSTAIRS);
            else if (found.reason === 'down') this.world.say(session, DOWNSTAIRS);
            else this.world.say(session, NOT_POSSIBLE);
            return;
        }
        if (this.itemTaken(found.inv, found.uid)) {
            this.world.say(session, ALREADY_ITEM);
            return;
        }
        const itemDb = this.world.itemDb();
        const items = tradeList(found.inv, found.uid, itemDb);
        if (items.length > TRADE_MAX) {
            this.world.say(session, TOO_MANY);
            return;
        }
        const block = this.sessionBlock(session, partner);
        if (block) {
            this.world.say(session, block);
            return;
        }
        const snap = {
            inv: found.inv,
            uid: found.uid,
            home: found.home,
            shape: this.shape(found.inv, found.uid)
        };
        const mine = this.byId.get(session.id);
        if (mine) {
            if (session.id !== mine.bId || !mine.aOffer) {
                this.world.say(session, ALREADY);
                return;
            }
            mine.bOffer = snap;
            mine.bState = 'initiated';
            const init = this.world.players.get(mine.aId);
            this.sendOwn(session, items);
            this.sendCounter(session, init, tradeList(mine.aOffer.inv, mine.aOffer.uid, itemDb));
            this.sendCounter(init, session, items);
            return;
        }
        const deal = {
            aId: session.id,
            bId: partner.id,
            aState: 'initiated',
            bState: 'acknowledge',
            aOffer: snap,
            bOffer: null
        };
        this.byId.set(session.id, deal);
        this.byId.set(partner.id, deal);
        this.sendOwn(session, items);
        this.world.say(partner, session.name + ' wants to trade with you.');
    }

    accept(session) {
        const deal = this.byId.get(session.id);
        if (!deal || this.transferring) return;
        const key = deal.aId === session.id ? 'a' : 'b';
        const state = deal[key + 'State'];
        if (state === 'accept') return;
        if (state !== 'initiated' && state !== 'acknowledge') return;
        if (!deal.aOffer || !deal.bOffer) {
            this.world.say(session, NOT_POSSIBLE);
            return;
        }
        deal[key + 'State'] = 'accept';
        const other = key === 'a' ? 'b' : 'a';
        if (deal[other + 'State'] === 'accept') this.commit(deal);
    }

    cancel(session) {
        if (this.transferring) return;
        const deal = this.byId.get(session.id);
        if (!deal) return;
        this.finishCancel(deal);
    }

    cancelPlayer(session) {
        if (!session || this.transferring) return;
        const deal = this.byId.get(session.id);
        if (!deal) return;
        this.finishCancel(deal);
    }

    onTouched(inv, uid) {
        if (this.transferring || !inv || !uid) return;
        const deals = this.deals();
        for (let i = 0; i < deals.length; i++) {
            const deal = deals[i];
            if (!this.byId.get(deal.aId)) continue;
            const offers = this.offersOn(deal, inv);
            for (let j = 0; j < offers.length; j++) {
                const offer = offers[j];
                if (!inv.items[offer.uid]
                    || contains(inv, offer.uid, uid)
                    || contains(inv, uid, offer.uid)) {
                    this.finishCancel(deal);
                    break;
                }
            }
        }
    }

    audit(inv) {
        if (this.transferring || !inv) return;
        const deals = this.deals();
        for (let i = 0; i < deals.length; i++) {
            const deal = deals[i];
            if (!this.byId.get(deal.aId)) continue;
            const offers = this.offersOn(deal, inv);
            for (let j = 0; j < offers.length; j++) {
                if (this.shape(inv, offers[j].uid) !== offers[j].shape) {
                    this.finishCancel(deal);
                    break;
                }
            }
        }
    }

    onPlayerMoved(session) {
        if (this.transferring || !session) return;
        const deal = this.byId.get(session.id);
        if (!deal) return;
        const partnerId = deal.aId === session.id ? deal.bId : deal.aId;
        const partner = this.world.players.get(partnerId);
        if (!partner || partner.left || partner.dead || partner.downed) {
            this.finishCancel(deal);
            return;
        }
        if (chebyshev(session.x, session.y, session.z, partner.x, partner.y, partner.z) > PARTNER_RANGE) {
            this.finishCancel(deal);
            return;
        }
        const offer = deal.aId === session.id ? deal.aOffer : deal.bOffer;
        if (!offer || offer.home !== 'ground') return;
        const root = groundRootLocation(this.world.ground, offer.uid);
        if (!root || chebyshev(session.x, session.y, session.z, root.x, root.y, root.z) > ITEM_RANGE) {
            this.finishCancel(deal);
        }
    }

    partner(session, partnerId) {
        const id = Number(partnerId);
        if (!session || !id || id === session.id) return null;
        const found = this.world.players.get(id);
        if (!found || found.type !== 'player' || found.dead || found.left || found.downed) return null;
        return found;
    }

    sessionBlock(session, partner) {
        const mine = this.byId.get(session.id);
        if (mine) {
            const partnerId = mine.aId === session.id ? mine.bId : mine.aId;
            const state = mine.aId === session.id ? mine.aState : mine.bState;
            if (state === 'acknowledge' && partnerId === partner.id) return null;
            return ALREADY;
        }
        if (this.byId.get(partner.id)) return PARTNER_BUSY;
        return null;
    }

    resolve(session, loc) {
        if (!session || !loc) return { ok: false, reason: 'sorry' };
        const inv = session.inventory;
        if (loc.kind === 'equipment') {
            const slot = engineSlot(loc.slot);
            const uid = (inv.equipment && (inv.equipment[slot] || inv.equipment[loc.slot])) || null;
            if (!uid || !inv.items[uid]) return { ok: false, reason: 'sorry' };
            return { ok: true, home: 'player', inv, uid };
        }
        if (loc.kind === 'container') {
            const raw = loc.containerUid || loc.containerId;
            if (ownsContainer(inv, raw)) {
                const uid = resolveLocationUid(inv, {
                    kind: 'container',
                    containerUid: raw,
                    index: loc.index | 0
                });
                if (!uid || !inv.items[uid]) return { ok: false, reason: 'sorry' };
                return { ok: true, home: 'player', inv, uid };
            }
            if (locIsGroundContainer(this.world.ground, loc)) {
                const gInv = this.world.ground.inventory;
                const uid = resolveLocationUid(gInv, {
                    kind: 'container',
                    containerUid: raw,
                    index: loc.index | 0
                });
                if (!uid || !gInv.items[uid]) return { ok: false, reason: 'sorry' };
                const root = groundRootLocation(this.world.ground, uid);
                if (!root) return { ok: false, reason: 'sorry' };
                const floor = this.floorOf(session, root);
                if (floor) return floor;
                return { ok: true, home: 'ground', inv: gInv, uid };
            }
            return { ok: false, reason: 'sorry' };
        }
        if (loc.kind === 'tile') {
            const uid = resolveStackUid(this.world.ground, loc.x, loc.y, loc.z, loc.stackIndex | 0);
            if (!uid) return { ok: false, reason: 'sorry' };
            const root = { x: loc.x | 0, y: loc.y | 0, z: loc.z | 0 };
            const floor = this.floorOf(session, root);
            if (floor) return floor;
            return { ok: true, home: 'ground', inv: this.world.ground.inventory, uid };
        }
        return { ok: false, reason: 'sorry' };
    }

    floorOf(session, root) {
        if ((session.z | 0) !== (root.z | 0)) {
            return { ok: false, reason: (session.z | 0) > (root.z | 0) ? 'up' : 'down' };
        }
        if (chebyshev(session.x, session.y, session.z, root.x, root.y, root.z) > ITEM_RANGE) {
            return { ok: false, reason: 'range' };
        }
        return null;
    }

    itemTaken(inv, uid) {
        const deals = this.deals();
        for (let i = 0; i < deals.length; i++) {
            const deal = deals[i];
            if (this.takenBy(deal.aOffer, inv, uid) || this.takenBy(deal.bOffer, inv, uid)) return true;
        }
        return false;
    }

    takenBy(offer, inv, uid) {
        if (!offer || offer.inv !== inv || !offer.uid) return false;
        return contains(inv, offer.uid, uid) || contains(inv, uid, offer.uid);
    }

    offersOn(deal, inv) {
        const out = [];
        if (deal.aOffer && deal.aOffer.inv === inv) out.push(deal.aOffer);
        if (deal.bOffer && deal.bOffer.inv === inv) out.push(deal.bOffer);
        return out;
    }

    deals() {
        const seen = new Set();
        const out = [];
        for (const deal of this.byId.values()) {
            if (!deal || seen.has(deal)) continue;
            seen.add(deal);
            out.push(deal);
        }
        return out;
    }

    shape(inv, uid) {
        const inst = inv && inv.items[uid];
        if (!inst) return '';
        const loc = inst.location;
        let parent = 'loose';
        if (loc && loc.kind === 'equipment') parent = 'eq:' + loc.slot;
        else if (loc && loc.kind === 'ground') {
            parent = 'g:' + (loc.x | 0) + ',' + (loc.y | 0) + ',' + (loc.z | 0);
        } else if (loc && loc.kind === 'container') parent = 'c:' + loc.containerUid;
        let s = String(inst.itemId) + '#' + getStackCount(inst) + '@' + parent;
        const cont = inv.containers[uid];
        if (cont && Array.isArray(cont.slots)) {
            const kids = [];
            for (let i = 0; i < cont.slots.length; i++) {
                if (cont.slots[i]) kids.push(this.shape(inv, cont.slots[i]));
            }
            s += '[' + kids.join(',') + ']';
        }
        return s;
    }

    sendOwn(session, items) {
        if (!session || session.dead) return;
        session.send(S2C.TRADE, encodeTrade({ side: 0, name: session.name, items }));
    }

    sendCounter(session, owner, items) {
        if (!session || session.dead || !owner) return;
        session.send(S2C.TRADE, encodeTrade({ side: 1, name: owner.name, items }));
    }

    finishCancel(deal) {
        if (!deal || this.transferring) return;
        if (this.byId.get(deal.aId) !== deal && this.byId.get(deal.bId) !== deal) return;
        const A = this.world.players.get(deal.aId);
        const B = this.world.players.get(deal.bId);
        this.forget(deal);
        this.notify(A, CANCELLED);
        this.notify(B, CANCELLED);
    }

    notify(session, text) {
        if (!session || session.dead || session.left) return;
        if (text) this.world.say(session, text);
        session.send(S2C.TRADE_CLOSE, encodeTradeClose());
    }

    forget(deal) {
        if (!deal) return;
        if (this.byId.get(deal.aId) === deal) this.byId.delete(deal.aId);
        if (this.byId.get(deal.bId) === deal) this.byId.delete(deal.bId);
    }

    commit(deal) {
        if (!deal || this.transferring) return;
        this.transferring = true;
        const world = this.world;
        const A = world.players.get(deal.aId);
        const B = world.players.get(deal.bId);
        const itemDb = world.itemDb();
        const endFail = (textA, textB) => {
            this.transferring = false;
            this.forget(deal);
            this.notify(A, textA);
            this.notify(B, textB);
        };
        if (!A || !B || !deal.aOffer || !deal.bOffer) {
            endFail(INCOMPLETE, INCOMPLETE);
            return;
        }
        const liftA = this.lift(A, deal.aOffer);
        const liftB = this.lift(B, deal.bOffer);
        if (!liftA.ok || !liftB.ok) {
            if (liftA.ok) this.unlift(liftA, liftA.uid);
            if (liftB.ok) this.unlift(liftB, liftB.uid);
            endFail(INCOMPLETE, INCOMPLETE);
            return;
        }
        const probA = this.deliveryProblem(A, liftB, itemDb);
        const probB = this.deliveryProblem(B, liftA, itemDb);
        if (probA.kind !== 'ok' || probB.kind !== 'ok') {
            this.unlift(liftA, liftA.uid);
            this.unlift(liftB, liftB.uid);
            const instA = liftB.inv.items[liftB.uid];
            const instB = liftA.inv.items[liftA.uid];
            endFail(
                failureSentence(probA.kind, instA, itemDb, probA.weight),
                failureSentence(probB.kind, instB, itemDb, probB.weight)
            );
            return;
        }
        const toB = transferItemTree(liftA.inv, B.inventory, liftA.uid, itemDb);
        const toA = transferItemTree(liftB.inv, A.inventory, liftB.uid, itemDb);
        const placedB = !!(toB && placeTrade(B.inventory, toB));
        const placedA = !!(toA && placeTrade(A.inventory, toA));
        if (!toA || !toB || !placedA || !placedB) {
            this.rollback(liftA, toB, B.inventory, itemDb);
            this.rollback(liftB, toA, A.inventory, itemDb);
            recomputeTotalWeight(A.inventory, itemDb);
            recomputeTotalWeight(B.inventory, itemDb);
            recomputeTotalWeight(world.ground.inventory, itemDb);
            endFail(INCOMPLETE, INCOMPLETE);
            return;
        }
        recomputeTotalWeight(A.inventory, itemDb);
        recomputeTotalWeight(B.inventory, itemDb);
        if (liftA.home === 'ground' || liftB.home === 'ground') {
            recomputeTotalWeight(world.ground.inventory, itemDb);
        }
        this.forget(deal);
        this.transferring = false;
        world.refreshLoadout(A);
        world.refreshLoadout(B);
        if (liftA.tile) world.broadcastGroundTile(liftA.tile.x, liftA.tile.y, liftA.tile.z, liftA.leftTile ? [liftA.oldUid] : []);
        if (liftB.tile && !(liftA.tile && tileKey(liftA.tile.x, liftA.tile.y, liftA.tile.z) === tileKey(liftB.tile.x, liftB.tile.y, liftB.tile.z))) {
            world.broadcastGroundTile(liftB.tile.x, liftB.tile.y, liftB.tile.z, liftB.leftTile ? [liftB.oldUid] : []);
        }
        this.notify(A, '');
        this.notify(B, '');
        world.enqueuePersist(A, 'trade');
        world.enqueuePersist(B, 'trade');
    }

    deliveryProblem(receiver, incoming, itemDb) {
        const inst = incoming.inv.items[incoming.uid];
        if (!inst) return { kind: 'bad', weight: 0 };
        const add = itemSubtreeWeight(incoming.inv, incoming.uid, itemDb);
        const have = computeTotalCarriedWeight(receiver.inventory, itemDb);
        const voc = receiver.vocation || (receiver.character && receiver.character.vocation);
        if (!canCarryAdditional(receiver.level, have, add, voc)) {
            return { kind: 'cap', weight: add };
        }
        if (!hasTradeRoom(receiver.inventory)) return { kind: 'room', weight: add };
        return { kind: 'ok', weight: add };
    }

    lift(player, offer) {
        const inv = offer.inv;
        const inst = inv && inv.items[offer.uid];
        if (!inst || !inst.location) return { ok: false };
        const loc = inst.location;
        if (loc.kind === 'ground') {
            const x = loc.x | 0;
            const y = loc.y | 0;
            const z = loc.z | 0;
            const stack = getStack(this.world.ground, x, y, z);
            const index = stack.indexOf(offer.uid);
            removeFromTileStack(this.world.ground, offer.uid, x, y, z);
            inst.location = null;
            return {
                ok: true,
                home: 'ground',
                inv,
                uid: offer.uid,
                oldUid: offer.uid,
                leftTile: true,
                tile: { x, y, z },
                restore: { type: 'ground', x, y, z, index }
            };
        }
        let tile = null;
        if (offer.home === 'ground') {
            const root = groundRootLocation(this.world.ground, offer.uid);
            if (root) tile = { x: root.x, y: root.y, z: root.z };
        }
        if (loc.kind === 'container') {
            const saved = {
                type: 'container',
                containerUid: loc.containerUid,
                index: loc.index | 0
            };
            detachLocal(inv, offer.uid);
            return {
                ok: true,
                home: offer.home,
                inv,
                uid: offer.uid,
                oldUid: offer.uid,
                leftTile: false,
                tile,
                restore: saved
            };
        }
        if (loc.kind === 'equipment') {
            const slot = loc.slot;
            detachLocal(inv, offer.uid);
            if (slot === 'backpack' && inv === player.inventory) syncRootToEquippedBackpack(inv);
            return {
                ok: true,
                home: 'player',
                inv,
                uid: offer.uid,
                oldUid: offer.uid,
                leftTile: false,
                tile: null,
                restore: { type: 'equipment', slot }
            };
        }
        return { ok: false };
    }

    unlift(lifted, uid) {
        if (!lifted || !lifted.ok) return;
        const id = uid || lifted.uid;
        const inv = lifted.inv;
        const inst = inv && inv.items[id];
        const saved = lifted.restore;
        if (!inst || !saved) return;
        inst.location = null;
        if (saved.type === 'ground') {
            const key = tileKey(saved.x, saved.y, saved.z);
            const ground = this.world.ground;
            if (!ground.stacks[key]) ground.stacks[key] = [];
            const stack = ground.stacks[key];
            const idx = saved.index < 0 ? stack.length : Math.min(saved.index, stack.length);
            stack.splice(idx, 0, id);
            inst.location = { kind: 'ground', x: saved.x | 0, y: saved.y | 0, z: saved.z | 0 };
            return;
        }
        if (saved.type === 'equipment') {
            if (!inv.equipment) inv.equipment = Object.create(null);
            inv.equipment[saved.slot] = id;
            inst.location = { kind: 'equipment', slot: saved.slot };
            if (saved.slot === 'backpack') syncRootToEquippedBackpack(inv);
            return;
        }
        if (saved.type === 'container') {
            const cont = inv.containers[saved.containerUid];
            if (cont && saved.index >= 0 && saved.index < cont.slots.length) {
                cont.slots[saved.index] = id;
                inst.location = {
                    kind: 'container',
                    containerUid: saved.containerUid,
                    index: saved.index
                };
            }
        }
    }

    rollback(lifted, movedUid, destInv, itemDb) {
        if (!lifted) return;
        let back = lifted.uid;
        if (movedUid && destInv && destInv.items[movedUid]) {
            detachLocal(destInv, movedUid);
            const returned = transferItemTree(destInv, lifted.inv, movedUid, itemDb);
            if (returned) back = returned;
            else return;
        } else if (!lifted.inv.items[lifted.uid]) {
            return;
        }
        this.unlift(lifted, back);
    }
}

module.exports = {
    TradeBook,
    TRADE_MAX,
    failureSentence
};

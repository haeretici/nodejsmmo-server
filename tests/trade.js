'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C, DIR, REASON, INV_FLAG } = require('../src/protocol/opcodes');
const { encodeFrame, decodeFrames } = require('../src/protocol/frame');
const {
    encodeTradeOffer,
    encodeTrade,
    encodeTradeClose,
    encodeSay,
    encodeMoveItem,
    encodeEquip,
    decodeTrade,
    decodeSay,
    decodeReject,
    decodeKick,
    decodeGroundGone
} = require('../src/protocol/messages');
const { itemDbFromPack } = require('../src/world/items');
const {
    countItem,
    createItemInstance,
    destroyItem,
    getStackCount,
    placeInContainer,
    placeInEquipment,
    syncRootToEquippedBackpack
} = require('../src/world/inventory');
const { pushToTileStack } = require('../src/world/ground_items');
const { failureSentence } = require('../src/world/trade');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function framesOf(session) {
    const out = [];
    const sent = session && session.socket && session.socket.sent ? session.socket.sent : [];
    for (let i = 0; i < sent.length; i++) {
        const part = decodeFrames(sent[i]);
        for (let j = 0; j < part.length; j++) out.push(part[j]);
    }
    return out;
}

function itemDb() {
    const db = itemDbFromPack(null);
    db.trade_sword = {
        id: 'trade_sword',
        label: 'Trade Sword',
        slot: 'rightHand',
        category: 'sword',
        weaponType: 'sword',
        atk: 10,
        defense: 5,
        weight: 100
    };
    db.trade_shield = {
        id: 'trade_shield',
        label: 'Trade Shield',
        slot: 'leftHand',
        category: 'shield',
        defense: 10,
        weight: 100
    };
    db.trade_bag = { id: 'trade_bag', category: 'container', volume: 8, weight: 100 };
    db.trade_inner = { id: 'trade_inner', category: 'container', volume: 4, weight: 50 };
    db.trade_bin = { id: 'trade_bin', category: 'container', volume: 100, weight: 100 };
    db.trade_pouch = {
        id: 'trade_pouch',
        slot: 'backpack',
        category: 'container',
        volume: 1,
        weight: 100
    };
    db.trade_ruby = { id: 'trade_ruby', category: 'valuable', weight: 100 };
    db.trade_sapphire = { id: 'trade_sapphire', category: 'valuable', weight: 100 };
    db.trade_token = { id: 'trade_token', category: 'valuable', weight: 10 };
    db.trade_filler = { id: 'trade_filler', category: 'valuable', weight: 10 };
    db.trade_heavy = {
        id: 'trade_heavy',
        category: 'valuable',
        stackable: true,
        weight: 40000
    };
    return db;
}

function wireUnit() {
    assert.strictEqual(C2S.TRADE_OFFER, 48);
    assert.strictEqual(C2S.TRADE_ACCEPT, 49);
    assert.strictEqual(C2S.TRADE_CANCEL, 50);
    assert.strictEqual(S2C.TRADE, 139);
    assert.strictEqual(S2C.TRADE_CLOSE, 140);
    assert.ok(!Object.keys(C2S).some((k) => C2S[k] === 12 || C2S[k] === 17));
    const packed = Buffer.concat([
        encodeFrame(S2C.TRADE, 1, encodeTrade({
            side: 0,
            name: 'Ash',
            items: [
                { id: 'trade_bag', count: 1, flags: INV_FLAG.CONTAINER },
                { id: 'trade_sword', count: 1, flags: 0 },
                { id: 'gold_coin', count: 25, flags: 0 }
            ]
        })),
        encodeFrame(S2C.TRADE_CLOSE, 2, encodeTradeClose()),
        encodeFrame(S2C.SAY, 3, encodeSay('Trade cancelled.'))
    ]);
    const frames = decodeFrames(packed);
    assert.strictEqual(frames.length, 3);
    assert.strictEqual(frames[0].opcode, S2C.TRADE);
    assert.strictEqual(frames[1].opcode, S2C.TRADE_CLOSE);
    assert.strictEqual(frames[1].payload.length, 0);
    assert.strictEqual(frames[2].opcode, S2C.SAY);
    const trade = decodeTrade(frames[0].payload);
    assert.strictEqual(trade.side, 0);
    assert.strictEqual(trade.name, 'Ash');
    assert.deepStrictEqual(trade.items.map((it) => it.id), ['trade_bag', 'trade_sword', 'gold_coin']);
    assert.strictEqual(trade.items[0].flags, 1);
    assert.strictEqual(trade.items[2].count, 25);
    assert.strictEqual(decodeSay(frames[2].payload).text, 'Trade cancelled.');
    assert.strictEqual(decodeSay(frames[2].payload).speakerId, 0);
}

function sentenceUnit(db) {
    const heavy = { itemId: 'trade_heavy', count: 2 };
    const ruby = { itemId: 'trade_ruby' };
    assert.strictEqual(
        failureSentence('cap', heavy, db, 80000),
        'You do not have enough capacity to carry these objects.\n They weigh 800.00 oz.'
    );
    assert.strictEqual(
        failureSentence('cap', ruby, db, 10),
        'You do not have enough capacity to carry this object.\n It weighs 0.10 oz.'
    );
    assert.strictEqual(
        failureSentence('cap', ruby, db, 5),
        'You do not have enough capacity to carry this object.\n It weighs 0.05 oz.'
    );
    assert.strictEqual(
        failureSentence('cap', ruby, db, 1800),
        'You do not have enough capacity to carry this object.\n It weighs 18.00 oz.'
    );
    assert.strictEqual(
        failureSentence('room', ruby, db, 100),
        'You do not have enough room to carry this object.'
    );
    assert.strictEqual(
        failureSentence('room', heavy, db, 80000),
        'You do not have enough room to carry these objects.'
    );
    assert.strictEqual(failureSentence('bad', ruby, db, 10), 'Trade could not be completed.');
}

function skills() {
    return { fist: 10, club: 10, sword: 10, axe: 10, distance: 10, shielding: 10, magic: 0, fishing: 10 };
}

function runOpen(tileMap, world, x, y, z, n) {
    for (let dx = 0; dx < n; dx++) {
        const tx = x + dx;
        if (!tileMap.isWalkable(tx, y, z)) return false;
        if (tileMap.getStair(tx, y, z)) return false;
        if (world.worldPinAt(tx, y, z)) return false;
        if (tileMap.getOccupant(tx, y, z)) return false;
    }
    return true;
}

async function boot() {
    const db = itemDb();
    const settings = testSettings();
    const store = new MemoryStore();
    const acc = await store.createAccount({ email: 'trade@example.com', passwordHash: 'phc' });
    const world = new World({
        settings,
        store,
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {}
    });
    world._itemDb = db;
    world.start();
    const limiter = new RateLimiter();
    let nameN = 0;
    let tick = 1;

    async function make(role) {
        nameN += 1;
        const name = 'T' + nameN + role;
        const ch = await store.createCharacter({
            accountId: acc.id,
            name,
            vocation: 'scout',
            level: 1,
            experience: 0,
            posX: 12, posY: 12, posZ: 0,
            hp: 185, hpMax: 185, mp: 90, mpMax: 90,
            townId: 1,
            skills: skills(),
            inventory: { items: [] },
            storage: {}
        });
        const session = new GameSession({
            socket: fakeSocket(),
            ip: '127.0.0.1',
            world,
            settings,
            limiter,
            log: world.log
        });
        session.bindCharacter(ch, world.spawnPos(ch), {
            state: await store.loadCharacterState(ch.id),
            skills: await store.loadSkills(ch.id)
        });
        assert.ok(world.add(session), name);
        world.sendEnterWorld(session);
        session.socket.sent = [];
        return session;
    }

    function claimRun(z, n, nearX, nearY) {
        const tileMap = world.tileMap;
        const layer = tileMap.getLayer(z);
        assert.ok(layer, 'no layer ' + z);
        const limit = Math.max(layer.cols, layer.rows);
        for (let rad = Math.max(n, 4); rad <= limit + n; rad += 4) {
            const y0 = Math.max(0, (nearY | 0) - rad);
            const y1 = Math.min(layer.rows - 1, (nearY | 0) + rad);
            const x0 = Math.max(0, (nearX | 0) - rad);
            const x1 = Math.min(layer.cols - n, (nearX | 0) + rad);
            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    if (runOpen(tileMap, world, x, y, z, n)) return { x, y, z };
                }
            }
        }
        return null;
    }

    function seat(slots, spanLen) {
        const n = spanLen || slots.reduce((m, s) => Math.max(m, s.dx + 1), 0);
        const origin = slots[0].session;
        const spot = claimRun(origin.z | 0, n, origin.x, origin.y);
        assert.ok(spot, 'no run of ' + n + ' at z ' + origin.z);
        for (let i = 0; i < slots.length; i++) {
            const s = slots[i];
            assert.ok(
                world.tileMap.moveEntityToTile(spot.x + s.dx, spot.y, spot.z, s.session),
                'seat ' + s.session.name
            );
        }
        return spot;
    }

    function wipe() {
        for (let i = 0; i < arguments.length; i++) arguments[i].socket.sent = [];
    }

    function act(session, opcode, payload) {
        assert.ok(world.enqueueIntent(session, {
            opcode,
            seq: session.nextClientSeq,
            payload: payload || Buffer.alloc(0)
        }), 'enqueue');
        world.step(tick);
        tick += 1;
    }

    function texts(session) {
        const out = [];
        const frames = framesOf(session);
        for (let i = 0; i < frames.length; i++) {
            if (frames[i].opcode !== S2C.SAY) continue;
            const row = decodeSay(frames[i].payload);
            assert.strictEqual(row.speakerId, 0);
            out.push(row.text);
        }
        return out;
    }

    function tradePkts(session) {
        return framesOf(session)
            .filter((f) => f.opcode === S2C.TRADE)
            .map((f) => decodeTrade(f.payload));
    }

    function closed(session) {
        return framesOf(session).some((f) => f.opcode === S2C.TRADE_CLOSE);
    }

    function hasOp(session, opcode) {
        return framesOf(session).some((f) => f.opcode === opcode);
    }

    function deal(session) {
        return world.trades.byId.get(session.id) || null;
    }

    function put(session, itemId, opts) {
        const o = opts || {};
        const uid = createItemInstance(
            session.inventory,
            itemId,
            db,
            o.count != null ? { count: o.count } : undefined
        );
        const parent = o.containerUid || session.inventory.rootUid;
        const placed = placeInContainer(
            session.inventory,
            uid,
            parent,
            o.index == null ? null : o.index,
            db
        );
        assert.ok(placed.ok, itemId + ' ' + (placed.error || ''));
        return uid;
    }

    function wearBackpack(session, itemId) {
        const inv = session.inventory;
        assert.ok(destroyItem(inv, inv.equipment.backpack, db));
        const uid = createItemInstance(inv, itemId, db);
        const placed = placeInEquipment(inv, uid, 'backpack', db);
        assert.ok(placed.ok, placed.error);
        syncRootToEquippedBackpack(inv);
        assert.strictEqual(inv.rootUid, uid);
        return uid;
    }

    function wield(session, itemId, slot) {
        const uid = createItemInstance(session.inventory, itemId, db);
        const placed = placeInEquipment(session.inventory, uid, slot, db);
        assert.ok(placed.ok, placed.error);
        return uid;
    }

    function lay(itemId, x, y, z) {
        const uid = createItemInstance(world.ground.inventory, itemId, db);
        pushToTileStack(world.ground, uid, x, y, z);
        return uid;
    }

    function slots(inv, uid) {
        const cont = inv.containers[uid || inv.rootUid];
        const out = [];
        if (!cont) return out;
        for (let i = 0; i < cont.slots.length; i++) {
            const id = cont.slots[i];
            if (!id) continue;
            const inst = inv.items[id];
            out.push({ uid: id, index: i, id: inst.itemId, count: getStackCount(inst) });
        }
        return out;
    }

    function offerBackpack(session, uid, partnerId) {
        const loc = session.inventory.items[uid].location;
        assert.strictEqual(loc.kind, 'container');
        return encodeTradeOffer({
            kind: 'container',
            containerUid: loc.containerUid,
            index: loc.index
        }, partnerId);
    }

    function offerTile(x, y, z, partnerId) {
        return encodeTradeOffer({ kind: 'tile', x, y, z, stackIndex: 0 }, partnerId);
    }

    return {
        db, store, acc, world, make, seat, wipe, act, texts, tradePkts, closed, hasOp,
        deal, put, wearBackpack, wield, lay, slots, offerBackpack, offerTile,
        seqOf(session) { return session.nextClientSeq; }
    };
}

async function main() {
    const db = itemDb();
    wireUnit();
    sentenceUnit(db);
    const env = await boot();
    const {
        store, acc, world, make, seat, wipe, act, texts, tradePkts, closed, hasOp,
        deal, put, wearBackpack, wield, lay, slots, offerBackpack, offerTile
    } = env;
    try {
        const idleA = await make('A');
        const idleB = await make('B');
        seat([{ session: idleA, dx: 0 }, { session: idleB, dx: 1 }]);
        wipe(idleA, idleB);
        act(idleA, C2S.TRADE_CANCEL);
        assert.deepStrictEqual(texts(idleA), []);
        assert.ok(!closed(idleA));
        wipe(idleA);
        act(idleA, C2S.TRADE_ACCEPT);
        assert.deepStrictEqual(texts(idleA), []);
        assert.ok(!closed(idleA));

        wipe(idleA);
        const unknownSeq = idleA.nextClientSeq;
        assert.strictEqual(world.enqueueIntent(idleA, {
            opcode: 12,
            seq: unknownSeq,
            payload: Buffer.alloc(0)
        }), false);
        const unknown = framesOf(idleA).find((f) => f.opcode === S2C.REJECT);
        assert.ok(unknown);
        assert.strictEqual(decodeReject(unknown.payload).reason, REASON.UNKNOWN_OPCODE);
        assert.strictEqual(idleA.nextClientSeq, unknownSeq);

        wipe(idleA);
        act(idleA, C2S.TRADE_OFFER, encodeTradeOffer(
            { kind: 'container', containerUid: idleA.inventory.rootUid, index: 0 },
            idleA.id
        ));
        assert.ok(texts(idleA).includes('Sorry, not possible.'));
        assert.ok(!deal(idleA));
        wipe(idleA);
        act(idleA, C2S.TRADE_OFFER, encodeTradeOffer(
            { kind: 'container', containerUid: idleA.inventory.rootUid, index: 0 },
            999999
        ));
        assert.ok(texts(idleA).includes('Sorry, not possible.'));
        assert.ok(!deal(idleA));

        const farA = await make('A');
        const farB = await make('B');
        const span = seat([{ session: farA, dx: 0 }, { session: farB, dx: 1 }], 4);
        const savedZ = farB.z;
        farB.z = farA.z + 1;
        wipe(farA, farB);
        act(farA, C2S.TRADE_OFFER, offerBackpack(farA, put(farA, 'trade_token', { index: 0 }), farB.id));
        assert.ok(texts(farA).includes(farB.name + ' tells you to move closer.'));
        assert.ok(!deal(farA));
        farB.z = savedZ;

        assert.ok(world.tileMap.moveEntityToTile(span.x + 3, span.y, span.z, farB));
        wipe(farA);
        act(farA, C2S.TRADE_OFFER, offerBackpack(farA, farA.inventory.containers[farA.inventory.rootUid].slots[0], farB.id));
        assert.ok(texts(farA).includes(farB.name + ' tells you to move closer.'));
        assert.ok(!deal(farA));
        assert.ok(world.tileMap.moveEntityToTile(span.x + 1, span.y, span.z, farB));

        lay('trade_sword', span.x, span.y, farA.z - 1);
        wipe(farA);
        act(farA, C2S.TRADE_OFFER, offerTile(span.x, span.y, farA.z - 1, farB.id));
        assert.ok(texts(farA).includes('First go upstairs.'));
        assert.ok(!framesOf(farA).some((f) => f.opcode === S2C.REJECT));
        assert.ok(!deal(farA));

        lay('trade_shield', span.x, span.y, farA.z + 1);
        wipe(farA);
        act(farA, C2S.TRADE_OFFER, offerTile(span.x, span.y, farA.z + 1, farB.id));
        assert.ok(texts(farA).includes('First go downstairs.'));
        assert.ok(!deal(farA));

        const farUid = lay('trade_token', span.x + 2, span.y, farA.z);
        wipe(farA);
        const rangeSeq = farA.nextClientSeq;
        act(farA, C2S.TRADE_OFFER, offerTile(span.x + 2, span.y, farA.z, farB.id));
        const rangeRej = framesOf(farA).find((f) => f.opcode === S2C.REJECT);
        assert.ok(rangeRej);
        assert.strictEqual(decodeReject(rangeRej.payload).reason, REASON.OUT_OF_RANGE);
        assert.strictEqual(decodeReject(rangeRej.payload).refSeq, rangeSeq);
        assert.deepStrictEqual(texts(farA), []);
        assert.ok(!deal(farA));
        assert.ok(world.ground.inventory.items[farUid]);

        const ann = await make('A');
        const bo = await make('B');
        const cy = await make('C');
        seat([{ session: ann, dx: 0 }, { session: bo, dx: 1 }, { session: cy, dx: 2 }]);
        const sword = put(ann, 'trade_sword', { index: 0 });
        const token = put(ann, 'trade_token', { index: 1 });
        const shield = put(bo, 'trade_shield', { index: 0 });
        const cyToken = put(cy, 'trade_token', { index: 0 });
        wipe(ann, bo, cy);
        act(ann, C2S.TRADE_OFFER, offerBackpack(ann, sword, bo.id));
        const own = tradePkts(ann);
        assert.strictEqual(own.length, 1);
        assert.strictEqual(own[0].side, 0);
        assert.strictEqual(own[0].name, ann.name);
        assert.deepStrictEqual(own[0].items, [{ id: 'trade_sword', count: 1, flags: 0 }]);
        assert.strictEqual(tradePkts(bo).length, 0);
        assert.ok(texts(bo).includes(ann.name + ' wants to trade with you.'));
        assert.deepStrictEqual(texts(ann), []);
        const invited = deal(ann);
        assert.ok(invited);
        assert.strictEqual(invited.aState, 'initiated');
        assert.strictEqual(invited.bState, 'acknowledge');
        assert.strictEqual(invited.bOffer, null);

        wipe(ann, bo);
        act(bo, C2S.TRADE_ACCEPT);
        assert.ok(texts(bo).includes('Sorry, not possible.'));
        assert.deepStrictEqual(texts(ann), []);
        assert.ok(!closed(ann) && !closed(bo));
        assert.strictEqual(deal(ann).bState, 'acknowledge');

        wipe(ann);
        act(ann, C2S.TRADE_OFFER, offerBackpack(ann, sword, bo.id));
        assert.ok(texts(ann).includes('This item is already being traded.'));
        assert.ok(!closed(ann));
        assert.strictEqual(deal(ann).aOffer.uid, sword);

        wipe(ann);
        act(ann, C2S.TRADE_OFFER, offerBackpack(ann, token, bo.id));
        assert.ok(texts(ann).includes('You are already trading. Finish this trade first.'));
        assert.strictEqual(deal(ann).aOffer.uid, sword);
        assert.ok(!closed(ann) && !closed(bo));

        wipe(cy);
        act(cy, C2S.TRADE_OFFER, offerBackpack(cy, cyToken, ann.id));
        assert.ok(texts(cy).includes('This player is already trading.'));
        assert.ok(!deal(cy));
        assert.ok(deal(ann));

        wipe(bo);
        act(bo, C2S.TRADE_OFFER, offerBackpack(bo, shield, cy.id));
        assert.ok(texts(bo).includes('You are already trading. Finish this trade first.'));
        assert.strictEqual(deal(ann).bOffer, null);

        wipe(ann, bo);
        act(bo, C2S.TRADE_OFFER, offerBackpack(bo, shield, ann.id));
        const boPkts = tradePkts(bo);
        assert.strictEqual(boPkts.length, 2);
        assert.strictEqual(boPkts[0].side, 0);
        assert.strictEqual(boPkts[0].name, bo.name);
        assert.deepStrictEqual(boPkts[0].items, [{ id: 'trade_shield', count: 1, flags: 0 }]);
        assert.strictEqual(boPkts[1].side, 1);
        assert.strictEqual(boPkts[1].name, ann.name);
        assert.strictEqual(boPkts[1].items[0].id, 'trade_sword');
        const annCounter = tradePkts(ann);
        assert.strictEqual(annCounter.length, 1);
        assert.strictEqual(annCounter[0].side, 1);
        assert.strictEqual(annCounter[0].name, bo.name);
        assert.strictEqual(annCounter[0].items[0].id, 'trade_shield');
        assert.strictEqual(deal(ann).aState, 'initiated');
        assert.strictEqual(deal(ann).bState, 'initiated');

        wipe(ann, bo);
        act(ann, C2S.TRADE_ACCEPT);
        assert.strictEqual(deal(ann).aState, 'accept');
        assert.ok(ann.inventory.items[sword]);
        assert.ok(!closed(ann) && !closed(bo));
        wipe(ann, bo);
        act(ann, C2S.TRADE_ACCEPT);
        assert.strictEqual(deal(ann).aState, 'accept');
        assert.ok(ann.inventory.items[sword]);
        assert.ok(!closed(ann));
        wipe(ann, bo);
        act(bo, C2S.TRADE_ACCEPT);
        assert.ok(!deal(ann) && !deal(bo));
        assert.deepStrictEqual(texts(ann), []);
        assert.deepStrictEqual(texts(bo), []);
        assert.ok(closed(ann) && closed(bo));
        assert.ok(hasOp(ann, S2C.INVENTORY) && hasOp(bo, S2C.INVENTORY));
        assert.ok(hasOp(ann, S2C.EQUIPMENT) && hasOp(bo, S2C.EQUIPMENT));
        assert.ok(!ann.inventory.items[sword]);
        assert.ok(!bo.inventory.items[shield]);
        const annSlots = slots(ann.inventory);
        const boSlots = slots(bo.inventory);
        const gotShield = annSlots.find((s) => s.id === 'trade_shield');
        const gotSword = boSlots.find((s) => s.id === 'trade_sword');
        assert.ok(gotShield);
        assert.ok(gotSword);
        assert.notStrictEqual(gotShield.uid, shield);
        assert.notStrictEqual(gotSword.uid, sword);
        assert.ok(!ann.inventory.equipment.leftHand);
        assert.ok(!bo.inventory.equipment.rightHand);
        assert.strictEqual(countItem(ann.inventory, 'trade_token'), 1);
        await world.awaitPersist(ann.id);
        await world.awaitPersist(bo.id);
        const savedAnn = await store.loadCharacterState(ann.id);
        const savedBo = await store.loadCharacterState(bo.id);
        assert.strictEqual(countItem(savedAnn.inventory, 'trade_shield'), 1);
        assert.strictEqual(countItem(savedAnn.inventory, 'trade_sword'), 0);
        assert.strictEqual(countItem(savedBo.inventory, 'trade_sword'), 1);
        assert.strictEqual(countItem(savedBo.inventory, 'trade_shield'), 0);
        assert.ok(!savedAnn.inventory.equipment.leftHand);
        assert.ok(!savedBo.inventory.equipment.rightHand);
        const rowAnn = await store.findCharacter(acc.id, ann.id);
        const rowBo = await store.findCharacter(acc.id, bo.id);
        assert.ok(!rowAnn.lastLogout);
        assert.ok(!rowBo.lastLogout);

        const bagA = await make('A');
        const bagB = await make('B');
        seat([{ session: bagA, dx: 0 }, { session: bagB, dx: 1 }]);
        const bag = put(bagA, 'trade_bag', { index: 0 });
        const bagSword = put(bagA, 'trade_sword', { containerUid: bag, index: 0 });
        const inner = put(bagA, 'trade_inner', { containerUid: bag, index: 1 });
        put(bagA, 'gold_coin', { containerUid: inner, index: 0, count: 4 });
        const bagGem = put(bagB, 'trade_ruby', { index: 0 });
        wipe(bagA, bagB);
        act(bagA, C2S.TRADE_OFFER, offerBackpack(bagA, bag, bagB.id));
        const listed = tradePkts(bagA)[0];
        assert.deepStrictEqual(listed.items.map((it) => it.id), ['trade_bag', 'trade_sword', 'trade_inner', 'gold_coin']);
        assert.deepStrictEqual(listed.items.map((it) => it.flags), [1, 0, 1, 0]);
        assert.strictEqual(listed.items[3].count, 4);
        assert.strictEqual(tradePkts(bagB).length, 0);
        act(bagB, C2S.TRADE_OFFER, offerBackpack(bagB, bagGem, bagA.id));
        wipe(bagA, bagB);
        act(bagA, C2S.TRADE_ACCEPT);
        act(bagB, C2S.TRADE_ACCEPT);
        assert.ok(!deal(bagA));
        const received = slots(bagB.inventory);
        assert.strictEqual(received[0].id, 'trade_bag');
        assert.notStrictEqual(received[0].uid, bag);
        const kids = slots(bagB.inventory, received[0].uid);
        assert.deepStrictEqual(kids.map((s) => s.id), ['trade_sword', 'trade_inner']);
        const golds = slots(bagB.inventory, kids[1].uid);
        assert.strictEqual(golds.length, 1);
        assert.strictEqual(golds[0].id, 'gold_coin');
        assert.strictEqual(golds[0].count, 4);
        assert.ok(!bagA.inventory.items[bagSword]);
        assert.strictEqual(slots(bagA.inventory)[0].id, 'trade_ruby');
        assert.ok(!bagB.inventory.equipment.backpack || bagB.inventory.items[bagB.inventory.equipment.backpack].itemId !== 'trade_bag');

        const capA = await make('A');
        const capB = await make('B');
        seat([{ session: capA, dx: 0 }, { session: capB, dx: 1 }]);
        const heavy = put(capA, 'trade_heavy', { index: 0, count: 2 });
        const light = put(capB, 'trade_ruby', { index: 0 });
        wipe(capA, capB);
        act(capA, C2S.TRADE_OFFER, offerBackpack(capA, heavy, capB.id));
        act(capB, C2S.TRADE_OFFER, offerBackpack(capB, light, capA.id));
        wipe(capA, capB);
        act(capA, C2S.TRADE_ACCEPT);
        act(capB, C2S.TRADE_ACCEPT);
        assert.ok(texts(capB).includes(
            'You do not have enough capacity to carry these objects.\n They weigh 800.00 oz.'
        ));
        assert.ok(texts(capA).includes('Trade could not be completed.'));
        assert.ok(!texts(capA).includes('Trade cancelled.'));
        assert.ok(!texts(capB).includes('Trade cancelled.'));
        assert.ok(closed(capA) && closed(capB));
        assert.ok(!deal(capA));
        assert.strictEqual(capA.inventory.items[heavy].itemId, 'trade_heavy');
        assert.strictEqual(getStackCount(capA.inventory.items[heavy]), 2);
        assert.strictEqual(capB.inventory.items[light].itemId, 'trade_ruby');
        assert.ok(capA.inventory.items[heavy].location);
        assert.ok(capB.inventory.items[light].location);

        const roomA = await make('A');
        const roomB = await make('B');
        seat([{ session: roomA, dx: 0 }, { session: roomB, dx: 1 }]);
        wearBackpack(roomA, 'trade_pouch');
        const filler = put(roomA, 'trade_filler', { index: 0 });
        const weapon = wield(roomA, 'trade_sword', 'rightHand');
        const roomGem = put(roomB, 'trade_ruby', { index: 0 });
        wipe(roomA, roomB);
        act(roomA, C2S.TRADE_OFFER, encodeTradeOffer({ kind: 'equipment', slot: 'weapon' }, roomB.id));
        act(roomB, C2S.TRADE_OFFER, offerBackpack(roomB, roomGem, roomA.id));
        wipe(roomA, roomB);
        act(roomA, C2S.TRADE_ACCEPT);
        act(roomB, C2S.TRADE_ACCEPT);
        assert.ok(texts(roomA).includes('You do not have enough room to carry this object.'));
        assert.ok(!texts(roomA).some((t) => t.indexOf('weigh') >= 0));
        assert.ok(texts(roomB).includes('Trade could not be completed.'));
        assert.ok(!texts(roomA).includes('Trade cancelled.'));
        assert.ok(!texts(roomB).includes('Trade cancelled.'));
        assert.ok(closed(roomA) && closed(roomB));
        assert.strictEqual(roomA.inventory.equipment.rightHand, weapon);
        assert.strictEqual(roomA.inventory.items[filler].itemId, 'trade_filler');
        assert.strictEqual(roomB.inventory.items[roomGem].itemId, 'trade_ruby');

        const swapA = await make('A');
        const swapB = await make('B');
        seat([{ session: swapA, dx: 0 }, { session: swapB, dx: 1 }]);
        wearBackpack(swapA, 'trade_pouch');
        wearBackpack(swapB, 'trade_pouch');
        const ruby = put(swapA, 'trade_ruby', { index: 0 });
        const sapphire = put(swapB, 'trade_sapphire', { index: 0 });
        act(swapA, C2S.TRADE_OFFER, offerBackpack(swapA, ruby, swapB.id));
        act(swapB, C2S.TRADE_OFFER, offerBackpack(swapB, sapphire, swapA.id));
        wipe(swapA, swapB);
        act(swapA, C2S.TRADE_ACCEPT);
        act(swapB, C2S.TRADE_ACCEPT);
        assert.ok(!deal(swapA));
        assert.deepStrictEqual(texts(swapA), []);
        assert.ok(closed(swapA) && closed(swapB));
        const rubyNow = slots(swapB.inventory);
        const sapphireNow = slots(swapA.inventory);
        assert.strictEqual(rubyNow.length, 1);
        assert.strictEqual(sapphireNow.length, 1);
        assert.strictEqual(rubyNow[0].id, 'trade_ruby');
        assert.strictEqual(sapphireNow[0].id, 'trade_sapphire');
        assert.notStrictEqual(rubyNow[0].uid, ruby);
        assert.notStrictEqual(sapphireNow[0].uid, sapphire);
        assert.ok(!swapA.inventory.items[ruby]);
        assert.ok(!swapB.inventory.items[sapphire]);

        const goldA = await make('A');
        const goldB = await make('B');
        seat([{ session: goldA, dx: 0 }, { session: goldB, dx: 1 }]);
        const pile = put(goldA, 'gold_coin', { index: 0, count: 25 });
        const kept = put(goldB, 'gold_coin', { index: 0, count: 10 });
        const goldGem = put(goldB, 'trade_ruby', { index: 1 });
        act(goldA, C2S.TRADE_OFFER, offerBackpack(goldA, pile, goldB.id));
        act(goldB, C2S.TRADE_OFFER, offerBackpack(goldB, goldGem, goldA.id));
        act(goldA, C2S.TRADE_ACCEPT);
        act(goldB, C2S.TRADE_ACCEPT);
        const goldSlots = slots(goldB.inventory);
        assert.strictEqual(goldSlots[0].id, 'gold_coin');
        assert.strictEqual(goldSlots[0].count, 25);
        assert.strictEqual(goldSlots[1].id, 'gold_coin');
        assert.strictEqual(goldSlots[1].count, 10);
        assert.strictEqual(goldSlots[1].uid, kept);
        assert.notStrictEqual(goldSlots[0].uid, pile);
        assert.strictEqual(countItem(goldB.inventory, 'gold_coin'), 35);
        assert.strictEqual(countItem(goldA.inventory, 'gold_coin'), 0);
        assert.strictEqual(slots(goldA.inventory)[0].id, 'trade_ruby');

        const gndA = await make('A');
        const gndB = await make('B');
        const gndSpot = seat([{ session: gndA, dx: 0 }, { session: gndB, dx: 1 }]);
        const groundUid = lay('trade_sword', gndSpot.x, gndSpot.y, gndA.z);
        const gndGem = put(gndB, 'trade_ruby', { index: 0 });
        wipe(gndA, gndB);
        act(gndA, C2S.TRADE_OFFER, offerTile(gndSpot.x, gndSpot.y, gndA.z, gndB.id));
        act(gndB, C2S.TRADE_OFFER, offerBackpack(gndB, gndGem, gndA.id));
        wipe(gndA, gndB);
        act(gndA, C2S.TRADE_ACCEPT);
        act(gndB, C2S.TRADE_ACCEPT);
        assert.ok(!world.ground.inventory.items[groundUid]);
        const picked = slots(gndB.inventory).find((s) => s.id === 'trade_sword');
        assert.ok(picked);
        assert.notStrictEqual(picked.uid, groundUid);
        assert.ok(!gndB.inventory.equipment.rightHand);
        assert.strictEqual(slots(gndA.inventory)[0].id, 'trade_ruby');
        const gone = framesOf(gndA).concat(framesOf(gndB))
            .filter((f) => f.opcode === S2C.GROUND_GONE)
            .map((f) => decodeGroundGone(f.payload).uid);
        assert.ok(gone.includes(groundUid));

        const sameA = await make('A');
        const sameB = await make('B');
        const sameSpot = seat([{ session: sameA, dx: 0 }, { session: sameB, dx: 1 }]);
        const shared = lay('trade_token', sameSpot.x, sameSpot.y, sameA.z);
        act(sameA, C2S.TRADE_OFFER, offerTile(sameSpot.x, sameSpot.y, sameA.z, sameB.id));
        wipe(sameB);
        act(sameB, C2S.TRADE_OFFER, offerTile(sameSpot.x, sameSpot.y, sameA.z, sameA.id));
        assert.ok(texts(sameB).includes('This item is already being traded.'));
        assert.strictEqual(deal(sameA).bOffer, null);
        assert.ok(world.ground.inventory.items[shared]);
        assert.ok(!closed(sameA));

        const eqA = await make('A');
        const eqB = await make('B');
        seat([{ session: eqA, dx: 0 }, { session: eqB, dx: 1 }]);
        const eqSword = put(eqA, 'trade_sword', { index: 0 });
        const eqIndex = eqA.inventory.items[eqSword].location.index;
        act(eqA, C2S.TRADE_OFFER, offerBackpack(eqA, eqSword, eqB.id));
        wipe(eqA, eqB);
        act(eqA, C2S.EQUIP, encodeEquip(eqA.inventory.rootUid, eqIndex, 'weapon'));
        assert.strictEqual(eqA.inventory.items[eqSword].location.kind, 'equipment');
        assert.ok(texts(eqA).includes('Trade cancelled.'));
        assert.ok(texts(eqB).includes('Trade cancelled.'));
        assert.ok(closed(eqA) && closed(eqB));
        assert.ok(!deal(eqA));

        const chA = await make('A');
        const chB = await make('B');
        seat([{ session: chA, dx: 0 }, { session: chB, dx: 1 }]);
        const chBag = put(chA, 'trade_bag', { index: 0 });
        const chSword = put(chA, 'trade_sword', { containerUid: chBag, index: 0 });
        const chLoc = chA.inventory.items[chSword].location;
        act(chA, C2S.TRADE_OFFER, offerBackpack(chA, chBag, chB.id));
        wipe(chA, chB);
        act(chA, C2S.MOVE_ITEM, encodeMoveItem(
            { kind: 'container', containerUid: chLoc.containerUid, index: chLoc.index },
            { kind: 'container', containerUid: chA.inventory.rootUid, index: 1 },
            0
        ));
        assert.ok(slots(chA.inventory).some((s) => s.uid === chSword));
        assert.ok(!slots(chA.inventory, chBag).some((s) => s.uid === chSword));
        assert.ok(texts(chA).includes('Trade cancelled.'));
        assert.ok(texts(chB).includes('Trade cancelled.'));
        assert.ok(!deal(chA));

        const sibA = await make('A');
        const sibB = await make('B');
        seat([{ session: sibA, dx: 0 }, { session: sibB, dx: 1 }]);
        const sibSword = put(sibA, 'trade_sword', { index: 0 });
        wield(sibA, 'trade_shield', 'leftHand');
        act(sibA, C2S.TRADE_OFFER, offerBackpack(sibA, sibSword, sibB.id));
        wipe(sibA, sibB);
        act(sibA, C2S.MOVE_ITEM, encodeMoveItem(
            { kind: 'equipment', slot: 'leftHand' },
            { kind: 'container', containerUid: sibA.inventory.rootUid, index: 0 },
            0
        ));
        assert.ok(!sibA.inventory.equipment.leftHand);
        assert.ok(slots(sibA.inventory).some((s) => s.id === 'trade_shield'));
        assert.ok(sibA.inventory.items[sibSword]);
        assert.ok(deal(sibA));
        assert.ok(!closed(sibA) && !closed(sibB));
        assert.ok(!texts(sibA).includes('Trade cancelled.'));
        assert.ok(!texts(sibB).includes('Trade cancelled.'));

        const walkA = await make('A');
        const walkB = await make('B');
        const walkSpot = seat([{ session: walkA, dx: 1 }, { session: walkB, dx: 3 }]);
        const walkSword = put(walkA, 'trade_sword', { index: 0 });
        act(walkA, C2S.TRADE_OFFER, offerBackpack(walkA, walkSword, walkB.id));
        assert.ok(deal(walkA));
        wipe(walkA, walkB);
        act(walkA, C2S.MOVE_STEP, Buffer.from([DIR.W]));
        assert.strictEqual(walkA.x, walkSpot.x);
        assert.strictEqual(walkB.x, walkSpot.x + 3);
        assert.ok(texts(walkA).includes('Trade cancelled.'));
        assert.ok(texts(walkB).includes('Trade cancelled.'));
        assert.ok(closed(walkA) && closed(walkB));
        assert.ok(!deal(walkA));
        assert.ok(walkA.inventory.items[walkSword]);

        const gwA = await make('A');
        const gwB = await make('B');
        const gwSpot = seat([{ session: gwA, dx: 1 }, { session: gwB, dx: 3 }]);
        const gwUid = lay('trade_token', gwSpot.x, gwSpot.y, gwA.z);
        act(gwA, C2S.TRADE_OFFER, offerTile(gwSpot.x, gwSpot.y, gwA.z, gwB.id));
        assert.ok(deal(gwA));
        wipe(gwA, gwB);
        act(gwA, C2S.MOVE_STEP, Buffer.from([DIR.E]));
        assert.strictEqual(gwA.x, gwSpot.x + 2);
        assert.ok(texts(gwA).includes('Trade cancelled.'));
        assert.ok(texts(gwB).includes('Trade cancelled.'));
        assert.ok(!deal(gwA));
        assert.ok(world.ground.inventory.items[gwUid]);

        const outA = await make('A');
        const outB = await make('B');
        seat([{ session: outA, dx: 0 }, { session: outB, dx: 1 }]);
        const outSword = put(outA, 'trade_sword', { index: 0 });
        act(outA, C2S.TRADE_OFFER, offerBackpack(outA, outSword, outB.id));
        wipe(outA, outB);
        act(outA, C2S.LOGOUT);
        const outOps = framesOf(outA).map((f) => f.opcode);
        const sayAt = outOps.indexOf(S2C.SAY);
        const closeAt = outOps.indexOf(S2C.TRADE_CLOSE);
        const kickAt = outOps.indexOf(S2C.KICK);
        assert.ok(sayAt >= 0 && closeAt > sayAt && kickAt > closeAt);
        assert.ok(texts(outA).includes('Trade cancelled.'));
        assert.strictEqual(decodeKick(framesOf(outA).find((f) => f.opcode === S2C.KICK).payload), REASON.LOGOUT);
        assert.ok(texts(outB).includes('Trade cancelled.'));
        assert.ok(closed(outB));
        assert.ok(!framesOf(outB).some((f) => f.opcode === S2C.KICK));
        assert.ok(outA.dead);
        assert.ok(!outB.dead);
        assert.ok(!deal(outB));

        const deadA = await make('A');
        const deadB = await make('B');
        seat([{ session: deadA, dx: 0 }, { session: deadB, dx: 1 }]);
        act(deadA, C2S.TRADE_OFFER, offerBackpack(deadA, put(deadA, 'trade_sword', { index: 0 }), deadB.id));
        wipe(deadA, deadB);
        world.killPlayer(deadA, null, 1000000);
        assert.ok(texts(deadA).includes('Trade cancelled.'));
        assert.ok(texts(deadB).includes('Trade cancelled.'));
        assert.ok(closed(deadA) && closed(deadB));
        assert.ok(deadA.downed);
        assert.ok(!deadA.dead);
        assert.ok(!deal(deadB));

        const manyA = await make('A');
        const manyB = await make('B');
        seat([{ session: manyA, dx: 0 }, { session: manyB, dx: 1 }]);
        const bin = put(manyA, 'trade_bin', { index: 0 });
        const fillers = [];
        for (let i = 0; i < 100; i++) {
            fillers.push(put(manyA, 'trade_filler', { containerUid: bin, index: i }));
        }
        wipe(manyA, manyB);
        act(manyA, C2S.TRADE_OFFER, offerBackpack(manyA, bin, manyB.id));
        assert.ok(texts(manyA).includes('You can not trade more than 100 items.'));
        assert.ok(!deal(manyA));
        assert.ok(!closed(manyA) && !closed(manyB));
        assert.ok(destroyItem(manyA.inventory, fillers[fillers.length - 1], db));
        wipe(manyA, manyB);
        act(manyA, C2S.TRADE_OFFER, offerBackpack(manyA, bin, manyB.id));
        const hundred = tradePkts(manyA)[0];
        assert.ok(hundred);
        assert.strictEqual(hundred.items.length, 100);
        assert.strictEqual(hundred.items[0].id, 'trade_bin');
        assert.strictEqual(hundred.items[0].flags, 1);
        assert.ok(deal(manyA));
        wipe(manyA, manyB);
        act(manyA, C2S.TRADE_CANCEL);
        assert.ok(texts(manyA).includes('Trade cancelled.'));
        assert.ok(texts(manyB).includes('Trade cancelled.'));
        assert.ok(!deal(manyA));

        const quietA = await make('A');
        const quietB = await make('B');
        seat([{ session: quietA, dx: 0 }, { session: quietB, dx: 1 }]);
        const quietSword = put(quietA, 'trade_sword', { index: 0 });
        act(quietA, C2S.TRADE_OFFER, offerBackpack(quietA, quietSword, quietB.id));
        wipe(quietA, quietB);
        act(quietA, C2S.TRADE_CANCEL);
        assert.ok(!world._persistTails.has(quietA.id));
        assert.ok(!world._persistTails.has(quietB.id));
        const quietSaved = await store.loadCharacterState(quietA.id);
        assert.strictEqual(countItem(quietSaved.inventory, 'trade_sword'), 0);

        const bad = await make('A');
        wipe(bad);
        assert.ok(world.enqueueIntent(bad, {
            opcode: C2S.TRADE_OFFER,
            seq: bad.nextClientSeq,
            payload: Buffer.alloc(0)
        }));
        world.step(1);
        assert.ok(bad.dead);
        const kick = framesOf(bad).find((f) => f.opcode === S2C.KICK);
        assert.ok(kick);
        assert.strictEqual(decodeKick(kick.payload), REASON.BAD_FRAME);
        assert.ok(!world.trades.byId.has(bad.id));

        const down = await make('A');
        down.downed = true;
        down.respawnTick = 1000000;
        wipe(down);
        const downSeq = down.nextClientSeq;
        assert.strictEqual(world.enqueueIntent(down, {
            opcode: C2S.TRADE_OFFER,
            seq: downSeq,
            payload: Buffer.alloc(0)
        }), false);
        const busy = framesOf(down).find((f) => f.opcode === S2C.REJECT);
        assert.ok(busy);
        assert.strictEqual(decodeReject(busy.payload).reason, REASON.BUSY);
        assert.ok(!deal(down));
        down.downed = false;
    } finally {
        world.stop();
    }
    console.log('ok trade');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C, DIR, OPEN_BAG_SELF_INDEX } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');
const {
    encodeMoveItem,
    encodeContainerSlot,
    decodeGround,
    decodeInventory,
    decodeBag
} = require('../src/protocol/messages');
const { itemDbFromPack } = require('../src/world/items');
const {
    addItemToInventory,
    countItem,
    createItemInstance,
    placeInContainer
} = require('../src/world/inventory');
const { peekTop, getStack } = require('../src/world/ground_items');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function lastOf(sock, opcode) {
    for (let i = sock.sent.length - 1; i >= 0; i--) {
        const f = decodeFrame(sock.sent[i]);
        if (f.opcode === opcode) return f;
    }
    return null;
}

function skills() {
    return { fist: 10, club: 10, sword: 10, axe: 10, distance: 10, shielding: 10, magic: 0, fishing: 10 };
}

function encodeStep(dir) {
    return Buffer.from([dir & 0xff]);
}

async function boot() {
    const itemDb = Object.assign(itemDbFromPack(null), {
        bag: {
            id: 'bag',
            slot: 'backpack',
            category: 'container',
            volume: 8,
            weight: 800
        }
    });
    const settings = testSettings();
    const store = new MemoryStore();
    const acc = await store.createAccount({ email: 'ground@example.com', passwordHash: 'phc' });
    const ch = await store.createCharacter({
        accountId: acc.id,
        name: 'Grit',
        vocation: 'scout',
        level: 8,
        experience: 0,
        posX: 12, posY: 12, posZ: 0,
        hp: 185, hpMax: 185, mp: 90, mpMax: 90,
        townId: 1,
        skills: skills(),
        inventory: { items: [] },
        storage: {}
    });
    const world = new World({
        settings,
        store,
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {}
    });
    world._itemDb = itemDb;
    world.start();
    const state = await store.loadCharacterState(ch.id);
    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter(ch, world.spawnPos(ch), { state, skills: await store.loadSkills(ch.id) });
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    return { world, session, store, itemDb, ch };
}

async function main() {
    const { world, session, store, itemDb } = await boot();
    addItemToInventory(session.inventory, 'gold_coin', 6, itemDb);
    const goldUid = Object.keys(session.inventory.items).find(
        (u) => session.inventory.items[u].itemId === 'gold_coin'
    );
    const from = session.inventory.items[goldUid].location;
    session.socket.sent = [];
    const tx = session.x;
    const ty = session.y;
    const tz = session.z;
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.MOVE_ITEM,
        seq: 1,
        payload: encodeMoveItem(
            { kind: 'container', containerUid: from.containerUid, index: from.index },
            { kind: 'tile', x: tx, y: ty, z: tz, stackIndex: 0 },
            3
        )
    }));
    world.step(1);
    assert.strictEqual(countItem(session.inventory, 'gold_coin'), 3);
    const g = lastOf(session.socket, S2C.GROUND);
    assert.ok(g, 'drop sends GROUND');
    const slot = decodeGround(g.payload);
    assert.strictEqual(slot.id, 'gold_coin');
    assert.strictEqual(slot.count, 3);
    assert.strictEqual(slot.stackIndex, 0);
    assert.ok(slot.uid);

    session.socket.sent = [];
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.MOVE_ITEM,
        seq: 2,
        payload: encodeMoveItem(
            { kind: 'tile', x: tx, y: ty, z: tz, stackIndex: 0 },
            { kind: 'container', containerUid: 'root', index: 0 },
            1
        )
    }));
    world.step(1);
    assert.strictEqual(countItem(session.inventory, 'gold_coin'), 4);
    assert.strictEqual(world.ground.inventory.items[peekTop(world.ground, tx, ty, tz)].count, 2);

    const bagUid = createItemInstance(session.inventory, 'bag', itemDb);
    assert.ok(placeInContainer(session.inventory, bagUid, session.inventory.rootUid, null, itemDb).ok);
    const bagLoc = session.inventory.items[bagUid].location;
    session.socket.sent = [];
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.MOVE_ITEM,
        seq: 3,
        payload: encodeMoveItem(
            { kind: 'container', containerUid: bagLoc.containerUid, index: bagLoc.index },
            { kind: 'tile', x: tx, y: ty, z: tz, stackIndex: 0 },
            0
        )
    }));
    world.step(1);
    const bagTop = peekTop(world.ground, tx, ty, tz);
    assert.ok(world.ground.inventory.containers[bagTop]);

    session.socket.sent = [];
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.OPEN_BAG,
        seq: 4,
        payload: encodeContainerSlot(bagTop, OPEN_BAG_SELF_INDEX)
    }));
    world.step(1);
    const bagPkt = lastOf(session.socket, S2C.BAG);
    assert.ok(bagPkt, 'open ground bag sends BAG');
    const bagView = decodeBag ? decodeBag(bagPkt.payload) : decodeInventory(bagPkt.payload);
    assert.strictEqual(bagView.containerId, bagTop);
    assert.ok((bagView.capacity | 0) >= 1);
    assert.ok(session.openBagUids.indexOf(bagTop) >= 0);

    const dest = { x: session.x, y: session.y, z: session.z };
    let stepped = 0;
    for (const dir of [DIR.E, DIR.E]) {
        const nx = dest.x + (dir === DIR.E ? 1 : 0);
        const ny = dest.y;
        if (!world.tileMap.isWalkable(nx, ny, dest.z)) break;
        session.socket.sent = [];
        session.moveReadyTick = 0;
        assert.ok(world.enqueueIntent(session, {
            opcode: C2S.MOVE_STEP,
            seq: 5 + stepped,
            payload: encodeStep(dir)
        }));
        world.step(1);
        dest.x = session.x;
        dest.y = session.y;
        stepped += 1;
    }
    if (stepped >= 2) {
        assert.ok(session.openBagUids.indexOf(bagTop) < 0, 'walk-away closes ground bag');
        const closed = lastOf(session.socket, S2C.BAG);
        if (closed) {
            const view = decodeInventory(closed.payload);
            assert.ok(view.capacity === 0 || view.containerId === '');
        }
        const inv = decodeInventory(lastOf(session.socket, S2C.INVENTORY)
            ? lastOf(session.socket, S2C.INVENTORY).payload
            : lastOf(session.socket, S2C.INVENTORY) && lastOf(session.socket, S2C.INVENTORY).payload);
        void inv;
        assert.ok(session.inventory.containers[session.inventory.rootUid], 'backpack stays');
    }

    world.markGroundDirty();
    await world.saveGroundStore();
    const blob = await store.loadWorldGround();
    assert.ok(blob && blob.stacks);
    const key = Object.keys(blob.stacks).find((k) => blob.stacks[k].length);
    assert.ok(key, 'persist keeps floor items');

    const savedGold = countItem(session.inventory, 'gold_coin');
    await world.enqueuePersist(session, 'logout');
    const chState = await store.loadCharacterState(session.character.id);
    assert.strictEqual(countItem(chState.inventory, 'gold_coin'), savedGold, 'dropped coins not duplicated in character');

    world.stop();
    const world2 = new World({
        settings: testSettings(),
        store,
        log: createLog(testSettings()),
        schedule: () => 0,
        clear: () => {}
    });
    await world2.loadGroundStore();
    assert.ok(getStack(world2.ground, tx, ty, tz).length >= 1, 'restart still has the tile stack');
    world2.stop();

    const loc = encodeMoveItem(
        { kind: 'tile', x: 1, y: 2, z: 0, stackIndex: 0 },
        { kind: 'container', containerUid: 'root', index: 0 },
        0
    );
    assert.ok(loc.length > 8);

    console.log('ok ground_world');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

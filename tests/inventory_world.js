'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');
const {
    decodeInventory,
    decodeEquipment,
    encodeEquip
} = require('../src/protocol/messages');
const { itemDbFromPack } = require('../src/world/items');
const {
    addItemToInventory,
    countItem,
    createItemInstance,
    placeInContainer,
    serializeInventory
} = require('../src/world/inventory');
const { meleeAutoBounds, playerSkill, UNARMED_ATK, MELEE_AUTO_FACTOR } = require('../src/world/combat');

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
    return { fist: 10, club: 10, sword: 50, axe: 10, distance: 10, shielding: 10, magic: 0, fishing: 10 };
}

async function main() {
    const itemDb = Object.assign(itemDbFromPack(null), {
        bag: {
            id: 'bag',
            slot: 'backpack',
            category: 'container',
            volume: 8,
            weight: 800
        },
        iron_longsword: {
            id: 'iron_longsword',
            slot: 'rightHand',
            category: 'sword',
            atk: 42,
            defense: 20,
            weight: 5400
        }
    });
    const settings = testSettings();
    const store = new MemoryStore();
    const acc = await store.createAccount({ email: 'eq@example.com', passwordHash: 'phc' });
    const ch = await store.createCharacter({
        accountId: acc.id,
        name: 'Ash',
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

    const unarmed = meleeAutoBounds(1, UNARMED_ATK, 10, MELEE_AUTO_FACTOR);
    assert.strictEqual(session.weaponSkill, 'fist');
    assert.strictEqual(session.atk, UNARMED_ATK);

    addItemToInventory(session.inventory, 'iron_longsword', 1, itemDb);
    const bagUid = createItemInstance(session.inventory, 'bag', itemDb);
    assert.ok(placeInContainer(session.inventory, bagUid, session.inventory.rootUid, null, itemDb).ok);
    const nestedGold = createItemInstance(session.inventory, 'gold_coin', itemDb, { count: 7 });
    assert.ok(placeInContainer(session.inventory, nestedGold, bagUid, null, itemDb).ok);

    world.sendEnterWorld(session);
    const invPkt = decodeInventory(lastOf(session.socket, S2C.INVENTORY).payload);
    const swordSlot = invPkt.slots.find((s) => s.id === 'iron_longsword');
    assert.ok(swordSlot);
    const bagSlot = invPkt.slots.find((s) => s.id === 'bag');
    assert.ok(bagSlot);
    assert.ok(bagSlot.flags & 1);

    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.EQUIP,
        seq: 1,
        payload: encodeEquip(invPkt.containerId, swordSlot.index, 'weapon')
    }));
    world.step(1);
    assert.strictEqual(session.weaponSkill, 'sword');
    assert.strictEqual(session.atk, 42);
    assert.strictEqual(playerSkill(session), 50);
    const armed = meleeAutoBounds(1, 42, 50, MELEE_AUTO_FACTOR);
    assert.ok(armed.max > unarmed.max);
    const eqPkt = decodeEquipment(lastOf(session.socket, S2C.EQUIPMENT).payload);
    assert.ok(eqPkt.slots.some((s) => s.slot === 'weapon' && s.id === 'iron_longsword'));
    assert.ok(eqPkt.capMax >= 600);

    session.socket.sent = [];
    await world.enqueuePersist(session, 'logout');
    const saved = await store.loadCharacterState(ch.id);
    assert.strictEqual(countItem(saved.inventory, 'gold_coin'), 7);
    assert.strictEqual(saved.inventory.equipment.rightHand != null, true);

    world.stop();

    const world2 = new World({
        settings,
        store,
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {}
    });
    world2._itemDb = itemDb;
    const ch2 = await store.findCharacter(acc.id, ch.id);
    const s2 = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world: world2,
        settings,
        limiter: new RateLimiter(),
        log: world2.log
    });
    s2.bindCharacter(ch2, world2.spawnPos(ch2), {
        state: await store.loadCharacterState(ch.id),
        skills: await store.loadSkills(ch.id)
    });
    assert.ok(world2.add(s2));
    assert.strictEqual(s2.weaponSkill, 'sword');
    assert.strictEqual(s2.atk, 42);
    assert.strictEqual(countItem(s2.inventory, 'gold_coin'), 7);
    const tree = serializeInventory(s2.inventory);
    const bagIds = Object.keys(tree.containers).filter((id) => {
        const inst = tree.items[id];
        return inst && inst.itemId === 'bag';
    });
    assert.strictEqual(bagIds.length, 1);
    world2.stop();

    console.log('ok inventory_world');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

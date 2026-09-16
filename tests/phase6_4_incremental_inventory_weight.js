'use strict';

const assert = require('assert');
const {
    createEmptyInventory,
    ensureEquippedBackpack,
    createItemInstance,
    placeInContainer,
    addItemToInventory,
    canAddItemToInventory,
    countItem,
    takeItem,
    equipItem,
    unequipItem,
    destroyItem,
    consumeInstanceCount,
    consumeAmmoForShot,
    serializeInventory,
    normalizeInventory,
    totalCarriedWeight,
    computeTotalCarriedWeight,
    canCarryAdditional,
    playerCap
} = require('../src/world/inventory');
const { FALLBACK_ITEMS } = require('../src/world/items');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { testSettings } = require('./helpers');
const { C2S, S2C } = require('../src/protocol/opcodes');
const { Writer } = require('../src/protocol/frame');
const { encodeContainerSlot } = require('../src/protocol/messages');

const itemDb = Object.assign(Object.create(null), FALLBACK_ITEMS, {
    bag: {
        id: 'bag',
        slot: 'backpack',
        category: 'container',
        volume: 8,
        weight: 800
    },
    backpack: {
        id: 'backpack',
        slot: 'backpack',
        category: 'container',
        volume: 20,
        weight: 1800
    },
    iron_longsword: {
        id: 'iron_longsword',
        slot: 'rightHand',
        category: 'sword',
        atk: 42,
        defense: 20,
        weight: 5400
    },
    gold_coin: {
        id: 'gold_coin',
        slot: 'inventory',
        category: 'currency',
        stackable: true,
        weight: 10
    },
    health_potion: {
        id: 'health_potion',
        slot: 'inventory',
        category: 'potion',
        stackable: true,
        weight: 270,
        healMin: 150,
        healMax: 200
    },
    wooden_bow: {
        id: 'wooden_bow',
        slot: 'rightHand',
        category: 'bow',
        twoHanded: true,
        weaponType: 'distance',
        requiredAmmo: 'arrow',
        atk: 25,
        weight: 3500
    },
    wooden_arrow: {
        id: 'wooden_arrow',
        slot: 'inventory',
        category: 'ammo',
        ammoType: 'arrow',
        stackable: true,
        atk: 10,
        weight: 8
    },
    cookie: {
        id: 'cookie',
        slot: 'inventory',
        category: 'food',
        stackable: true,
        weight: 15
    }
});

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function encodeLootTake(corpseId, slot) {
    const b = Buffer.alloc(5);
    b.writeUInt32LE(corpseId >>> 0, 0);
    b.writeUInt8(slot & 0xff, 4);
    return b;
}

function encodeShopDeal(npcId, count, itemId) {
    return new Writer().u32(npcId).u16(count).str(itemId).toBuffer();
}

function makeWorld(extra) {
    const settings = testSettings();
    if (extra) Object.assign(settings, extra);
    const world = new World({
        settings,
        store: extra && extra.store ? extra.store : new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {}
    });
    world._itemDb = itemDb;
    world.start();
    return world;
}

function makeSession(world, ch) {
    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter(ch, world.spawnPos(ch));
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    world.syncAppears(session);
    return session;
}

function ash(id) {
    return {
        id: id || 1,
        accountId: id || 1,
        name: 'Ash',
        vocation: 'scout',
        level: 1,
        experience: 0,
        hp: 185,
        hpMax: 185,
        mp: 90,
        mpMax: 90,
        townId: 1
    };
}

function testIncrementalWeightOperations() {
    const inv = createEmptyInventory();
    assert.strictEqual(inv.totalWeight, 0);
    assert.strictEqual(totalCarriedWeight(inv, itemDb), 0);

    // 1. Equip backpack (weight: 1800)
    const bp = ensureEquippedBackpack(inv, itemDb);
    assert.ok(bp);
    assert.strictEqual(inv.totalWeight, 1800);
    assert.strictEqual(totalCarriedWeight(inv, itemDb), 1800);
    assert.strictEqual(inv.totalWeight, computeTotalCarriedWeight(inv, itemDb));

    // 2. Add stackable gold coins (50 * 10 = 500)
    const addCoins = addItemToInventory(inv, 'gold_coin', 50, itemDb);
    assert.strictEqual(addCoins.ok, true);
    assert.strictEqual(inv.totalWeight, 2300);
    assert.strictEqual(inv.totalWeight, computeTotalCarriedWeight(inv, itemDb));

    // 3. Add non-stackable sword (5400)
    const addSword = addItemToInventory(inv, 'iron_longsword', 1, itemDb);
    assert.strictEqual(addSword.ok, true);
    assert.strictEqual(inv.totalWeight, 7700);
    assert.strictEqual(inv.totalWeight, computeTotalCarriedWeight(inv, itemDb));

    // 4. Create nested bag and place inside backpack (bag weight: 800)
    const bagUid = createItemInstance(inv, 'bag', itemDb);
    assert.strictEqual(inv.totalWeight, 8500); // added upon creation
    const placedBag = placeInContainer(inv, bagUid, inv.rootUid, null, itemDb);
    assert.strictEqual(placedBag.ok, true);
    assert.strictEqual(inv.totalWeight, 8500);
    assert.strictEqual(inv.totalWeight, computeTotalCarriedWeight(inv, itemDb));

    // 5. Add items inside the nested bag (2 health potions: 2 * 270 = 540)
    const potionUid = createItemInstance(inv, 'health_potion', itemDb, { count: 2 });
    assert.strictEqual(inv.totalWeight, 9040);
    const placedPotion = placeInContainer(inv, potionUid, bagUid, null, itemDb);
    assert.strictEqual(placedPotion.ok, true);
    assert.strictEqual(inv.totalWeight, 9040);
    assert.strictEqual(inv.totalWeight, computeTotalCarriedWeight(inv, itemDb));

    // 6. Equip sword to right hand (move between container and equipment does NOT change total carried weight)
    const swordUid = Object.keys(inv.items).find((k) => inv.items[k].itemId === 'iron_longsword');
    const eq = equipItem(inv, swordUid, itemDb, 'rightHand');
    assert.strictEqual(eq.ok, true);
    assert.strictEqual(inv.totalWeight, 9040);
    assert.strictEqual(inv.totalWeight, computeTotalCarriedWeight(inv, itemDb));

    // 7. Unequip sword back to container
    const un = unequipItem(inv, 'rightHand', itemDb);
    assert.strictEqual(un.ok, true);
    assert.strictEqual(inv.totalWeight, 9040);
    assert.strictEqual(inv.totalWeight, computeTotalCarriedWeight(inv, itemDb));

    // 8. Merge stacks (adding 30 gold coins merges into existing 50 stack: 50 + 30 = 80, weight + 300)
    const addMoreCoins = addItemToInventory(inv, 'gold_coin', 30, itemDb);
    assert.strictEqual(addMoreCoins.ok, true);
    assert.strictEqual(inv.totalWeight, 9340);
    assert.strictEqual(countItem(inv, 'gold_coin'), 80);
    assert.strictEqual(inv.totalWeight, computeTotalCarriedWeight(inv, itemDb));

    // 9. Consume partial stack of items (take 25 coins: 25 * 10 = 250 removed)
    const tookCoins = takeItem(inv, 'gold_coin', 25, itemDb);
    assert.strictEqual(tookCoins, true);
    assert.strictEqual(countItem(inv, 'gold_coin'), 55);
    assert.strictEqual(inv.totalWeight, 9090);
    assert.strictEqual(inv.totalWeight, computeTotalCarriedWeight(inv, itemDb));

    // 10. Consume instance count directly (drink 1 potion from nested bag: 270 removed)
    const consumedPotion = consumeInstanceCount(inv, potionUid, 1, itemDb);
    assert.strictEqual(consumedPotion, true);
    assert.strictEqual(countItem(inv, 'health_potion'), 1);
    assert.strictEqual(inv.totalWeight, 8820);
    assert.strictEqual(inv.totalWeight, computeTotalCarriedWeight(inv, itemDb));

    // 11. Consume remaining potion so count reaches 0 and item is destroyed
    const consumedLastPotion = consumeInstanceCount(inv, potionUid, 1, itemDb);
    assert.strictEqual(consumedLastPotion, true);
    assert.strictEqual(countItem(inv, 'health_potion'), 0);
    assert.strictEqual(inv.totalWeight, 8550);
    assert.strictEqual(inv.totalWeight, computeTotalCarriedWeight(inv, itemDb));

    // 12. Add item into nested bag, then destroy the bag (recursive container destruction subtracts both bag and contents)
    const arrowUid = createItemInstance(inv, 'wooden_arrow', itemDb, { count: 100 }); // 100 * 8 = 800
    placeInContainer(inv, arrowUid, bagUid, null, itemDb);
    assert.strictEqual(inv.totalWeight, 9350);
    assert.strictEqual(inv.totalWeight, computeTotalCarriedWeight(inv, itemDb));

    // Destroy nested bag (800 bag + 800 arrows = 1600 removed)
    const destroyedBag = destroyItem(inv, bagUid, itemDb);
    assert.strictEqual(destroyedBag, true);
    assert.strictEqual(inv.totalWeight, 7750);
    assert.strictEqual(inv.totalWeight, computeTotalCarriedWeight(inv, itemDb));
    assert.strictEqual(countItem(inv, 'wooden_arrow'), 0);

    // 13. Serialize and normalize round-trip preserves totalWeight
    const snap = serializeInventory(inv);
    assert.strictEqual(snap.totalWeight, 7750);
    const restored = normalizeInventory(snap, itemDb);
    assert.strictEqual(restored.totalWeight, 7750);
    assert.strictEqual(totalCarriedWeight(restored, itemDb), 7750);
    assert.strictEqual(restored.totalWeight, computeTotalCarriedWeight(restored, itemDb));
}

function testO1CapCheckNonTraversal() {
    const inv = createEmptyInventory();
    ensureEquippedBackpack(inv, itemDb);

    // Populate deeply nested containers and dozens of items
    let currentContainerUid = inv.rootUid;
    for (let i = 0; i < 5; i++) {
        const bagId = createItemInstance(inv, 'bag', itemDb);
        placeInContainer(inv, bagId, currentContainerUid, null, itemDb);
        addItemToInventory(inv, 'gold_coin', 10, itemDb);
        currentContainerUid = bagId;
    }
    const expectedWeight = computeTotalCarriedWeight(inv, itemDb);
    assert.strictEqual(inv.totalWeight, expectedWeight);

    // Verify totalCarriedWeight does not traverse when inv.totalWeight is present
    let walkCounter = 0;
    const origItems = inv.items;
    const proxyItems = new Proxy(origItems, {
        get(target, prop) {
            walkCounter++;
            return target[prop];
        }
    });
    inv.items = proxyItems;

    const w = totalCarriedWeight(inv, itemDb);
    assert.strictEqual(w, expectedWeight);
    // Property access on items must be 0 because it did not iterate items!
    assert.strictEqual(walkCounter, 0, 'totalCarriedWeight must be O(1) without iterating items');

    // canCarryAdditional check
    assert.strictEqual(canCarryAdditional(1, totalCarriedWeight(inv, itemDb), 500, 'scout'), true);
    assert.strictEqual(walkCounter, 0, 'Cap check must remain O(1)');

    inv.items = origItems;
}

function testLootingIncrementalWeight() {
    const world = makeWorld();
    const session = makeSession(world, ash(1));

    const initialWeight = session.inventory.totalWeight;
    assert.ok(initialWeight > 0);

    // Create a corpse with loot adjacent to spawn: (12, 11, 0)
    const corpse = {
        id: 1001,
        type: 'corpse',
        name: 'Dead Rat',
        kind: 'rat',
        x: 12,
        y: 11,
        z: 0,
        items: [{ id: 'gold_coin', count: 25 }],
        bornTick: 0
    };
    world.corpses.set(corpse.id, corpse);
    if (world.corpseSpatial) world.corpseSpatial.insert(corpse);
    session.openCorpseId = corpse.id;

    // Perform quickloot / take item from corpse
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.LOOT_TAKE,
        seq: 1,
        payload: encodeLootTake(corpse.id, 0)
    }));
    world.step(1);

    assert.strictEqual(session.inventory.totalWeight, initialWeight + 250);
    assert.strictEqual(session.inventory.totalWeight, computeTotalCarriedWeight(session.inventory, world.itemDb()));

    // Verify cap in equipment stats sent to client is updated
    const capInfo = playerCap(session, world.itemDb());
    assert.strictEqual(capInfo.weight, initialWeight + 250);

    world.stop();
}

function testShoppingIncrementalWeight() {
    const world = makeWorld({
        npcs: [{ kind: 'guide', x: 12, y: 11, z: 0 }]
    });
    const session = makeSession(world, ash(2));

    // Give player 200 gold coins (2000 weight)
    addItemToInventory(session.inventory, 'gold_coin', 200, world.itemDb());
    const initialWeight = session.inventory.totalWeight;
    assert.strictEqual(countItem(session.inventory, 'gold_coin'), 200);

    const guide = Array.from(world.creatures.values())[0];
    assert.ok(guide);
    session.talkTarget = guide.id;

    // 1. Buy 2 cookies (cookie buy: 2 gold coins each; 4 gold lost = -40 weight, 2 cookies gained = +30 weight, net delta = -10)
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.SHOP_BUY,
        seq: 1,
        payload: encodeShopDeal(guide.id, 2, 'cookie')
    }));
    world.step(1);

    assert.strictEqual(countItem(session.inventory, 'cookie'), 2);
    assert.strictEqual(countItem(session.inventory, 'gold_coin'), 196);
    assert.strictEqual(session.inventory.totalWeight, initialWeight - 40 + 30);
    assert.strictEqual(session.inventory.totalWeight, computeTotalCarriedWeight(session.inventory, world.itemDb()));

    // 2. Sell 1 cookie (cookie sell: 1 gold coin; 1 cookie lost = -15 weight, 1 gold gained = +10 weight, net delta = -5)
    const weightBeforeSell = session.inventory.totalWeight;
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.SHOP_SELL,
        seq: 2,
        payload: encodeShopDeal(guide.id, 1, 'cookie')
    }));
    world.step(1);

    assert.strictEqual(countItem(session.inventory, 'cookie'), 1);
    assert.strictEqual(countItem(session.inventory, 'gold_coin'), 197);
    assert.strictEqual(session.inventory.totalWeight, weightBeforeSell - 15 + 10);
    assert.strictEqual(session.inventory.totalWeight, computeTotalCarriedWeight(session.inventory, world.itemDb()));

    world.stop();
}

function testPotionConsumptionWeight() {
    const world = makeWorld();
    const session = makeSession(world, ash(3));

    session.hp = 10;
    addItemToInventory(session.inventory, 'health_potion', 3, world.itemDb());
    const weightWithPotions = session.inventory.totalWeight;

    const potionUid = Object.keys(session.inventory.items).find((k) => session.inventory.items[k].itemId === 'health_potion');
    assert.ok(potionUid);
    const inst = session.inventory.items[potionUid];
    assert.ok(inst && inst.location && inst.location.kind === 'container');

    // Use 1 potion (weight decreases by 270)
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.USE_ITEM,
        seq: 1,
        payload: encodeContainerSlot(inst.location.containerUid, inst.location.index)
    }));
    world.step(1);

    assert.strictEqual(countItem(session.inventory, 'health_potion'), 2);
    assert.strictEqual(session.inventory.totalWeight, weightWithPotions - 270);
    assert.strictEqual(session.inventory.totalWeight, computeTotalCarriedWeight(session.inventory, world.itemDb()));

    world.stop();
}

function testAmmoConsumptionWeight() {
    const inv = createEmptyInventory();
    ensureEquippedBackpack(inv, itemDb);

    // Equip bow and add arrows
    addItemToInventory(inv, 'wooden_bow', 1, itemDb);
    const bowUid = Object.keys(inv.items).find((k) => inv.items[k].itemId === 'wooden_bow');
    equipItem(inv, bowUid, itemDb, 'rightHand');

    addItemToInventory(inv, 'wooden_arrow', 20, itemDb);
    const weightBeforeShot = inv.totalWeight;

    // Consume 1 arrow (weight decreases by 8)
    const shot = consumeAmmoForShot(inv, itemDb, 1);
    assert.strictEqual(shot.ok, true);
    assert.strictEqual(shot.spent, 1);
    assert.strictEqual(countItem(inv, 'wooden_arrow'), 19);
    assert.strictEqual(inv.totalWeight, weightBeforeShot - 8);
    assert.strictEqual(inv.totalWeight, computeTotalCarriedWeight(inv, itemDb));
}

function main() {
    testIncrementalWeightOperations();
    testO1CapCheckNonTraversal();
    testLootingIncrementalWeight();
    testShoppingIncrementalWeight();
    testPotionConsumptionWeight();
    testAmmoConsumptionWeight();

    console.log('ok phase6_4_incremental_inventory_weight');
}

main();

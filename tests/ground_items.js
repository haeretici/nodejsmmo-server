'use strict';

const assert = require('assert');
const { itemDbFromPack } = require('../src/world/items');
const {
    addItemToInventory,
    countItem,
    createEmptyInventory,
    createItemInstance,
    placeInContainer
} = require('../src/world/inventory');
const {
    createGroundStore,
    dropToGround,
    pickupFromGround,
    slideGroundItem,
    peekTop,
    getStack,
    serializeGroundStore,
    loadGroundStore,
    inGroundRange,
    MAX_GROUND_RENDER
} = require('../src/world/ground_items');

function main() {
    assert.strictEqual(MAX_GROUND_RENDER, 10);
    assert.strictEqual(inGroundRange(10, 10, 0, 11, 10, 0), true);
    assert.strictEqual(inGroundRange(10, 10, 0, 12, 10, 0), false);
    assert.strictEqual(inGroundRange(10, 10, 0, 10, 10, 1), false);

    const itemDb = Object.assign(itemDbFromPack(null), {
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
        }
    });
    const player = createEmptyInventory({ rootSlots: 20 });
    addItemToInventory(player, 'gold_coin', 6, itemDb);
    const ground = createGroundStore();
    const fromUid = Object.keys(player.items).find((u) => player.items[u].itemId === 'gold_coin');
    const from = player.items[fromUid].location;
    const drop = dropToGround({
        ground,
        playerInv: player,
        from,
        x: 5,
        y: 6,
        z: 0,
        count: 3,
        itemDb
    });
    assert.ok(drop.ok, drop.error);
    assert.strictEqual(countItem(player, 'gold_coin'), 3);
    const top = peekTop(ground, 5, 6, 0);
    assert.ok(top);
    assert.strictEqual(ground.inventory.items[top].itemId, 'gold_coin');
    assert.strictEqual(ground.inventory.items[top].count, 3);

    const drop2 = dropToGround({
        ground,
        playerInv: player,
        from: player.items[Object.keys(player.items).find((u) => player.items[u].itemId === 'gold_coin')].location,
        x: 5,
        y: 6,
        z: 0,
        count: 0,
        itemDb
    });
    assert.ok(drop2.ok, drop2.error);
    assert.strictEqual(countItem(player, 'gold_coin'), 0);
    assert.strictEqual(getStack(ground, 5, 6, 0).length, 1, 'autostack same itemId');
    assert.strictEqual(ground.inventory.items[peekTop(ground, 5, 6, 0)].count, 6);

    const pick = pickupFromGround({
        ground,
        playerInv: player,
        player: { level: 8, vocation: 'scout' },
        x: 5,
        y: 6,
        z: 0,
        stackIndex: 0,
        count: 2,
        to: { kind: 'container', containerUid: 'root', index: 0 },
        itemDb
    });
    assert.ok(pick.ok, pick.error);
    assert.strictEqual(countItem(player, 'gold_coin'), 2);
    assert.strictEqual(ground.inventory.items[peekTop(ground, 5, 6, 0)].count, 4);

    const slide = slideGroundItem({
        ground,
        fromX: 5, fromY: 6, fromZ: 0,
        toX: 6, toY: 6, toZ: 0,
        stackIndex: 0,
        itemDb
    });
    assert.ok(slide.ok, slide.error);
    assert.strictEqual(getStack(ground, 5, 6, 0).length, 0);
    assert.ok(peekTop(ground, 6, 6, 0));

    const bagInv = createEmptyInventory({ rootSlots: 20 });
    const bagUid = createItemInstance(bagInv, 'bag', itemDb);
    assert.ok(placeInContainer(bagInv, bagUid, bagInv.rootUid, 0, itemDb).ok);
    const nested = createItemInstance(bagInv, 'gold_coin', itemDb, { count: 2 });
    assert.ok(placeInContainer(bagInv, nested, bagUid, 0, itemDb).ok);
    const g2 = createGroundStore();
    const droppedBag = dropToGround({
        ground: g2,
        playerInv: bagInv,
        from: bagInv.items[bagUid].location,
        x: 1, y: 1, z: 0,
        itemDb
    });
    assert.ok(droppedBag.ok, droppedBag.error);
    const gBag = peekTop(g2, 1, 1, 0);
    assert.ok(g2.inventory.containers[gBag]);
    assert.ok(g2.inventory.containers[gBag].slots.some(Boolean), 'nested contents travel');
    assert.strictEqual(countItem(bagInv, 'gold_coin'), 0);

    const blob = serializeGroundStore(g2);
    const loaded = loadGroundStore(blob);
    assert.ok(peekTop(loaded, 1, 1, 0));
    assert.ok(loaded.inventory.containers[peekTop(loaded, 1, 1, 0)]);

    const eq = createEmptyInventory({ rootSlots: 20 });
    const bp = createItemInstance(eq, 'backpack', itemDb);
    eq.equipment.backpack = bp;
    eq.items[bp].location = { kind: 'equipment', slot: 'backpack' };
    const forbid = dropToGround({
        ground: createGroundStore(),
        playerInv: eq,
        from: { kind: 'equipment', slot: 'backpack' },
        x: 0, y: 0, z: 0,
        itemDb
    });
    assert.strictEqual(forbid.ok, false);
    assert.strictEqual(forbid.error, 'equipped_backpack');

    console.log('ok ground_items');
}

main();

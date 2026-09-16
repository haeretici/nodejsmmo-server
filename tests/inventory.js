'use strict';

const assert = require('assert');
const {
    createEmptyInventory,
    ensureEquippedBackpack,
    createItemInstance,
    placeInContainer,
    placeInEquipment,
    addItemToInventory,
    countItem,
    takeItem,
    equipItem,
    unequipItem,
    moveItem,
    serializeInventory,
    normalizeInventory,
    totalCarriedWeight,
    canCarryAdditional,
    baseCapacity,
    remainingCapacity,
    bagView,
    applyPlayerLoadout
} = require('../src/world/inventory');
const {
    FALLBACK_ITEMS,
    UNARMED_WEAPON_DEFENSE,
    computeMitigationPercent,
    computeMaxBlock
} = require('../src/world/items');

const itemDb = Object.assign(Object.create(null), FALLBACK_ITEMS, {
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
    },
    wooden_shield: {
        id: 'wooden_shield',
        slot: 'leftHand',
        category: 'shield',
        defense: 14,
        defenseBonus: 1,
        weight: 4000
    }
});

function main() {
    assert.strictEqual(baseCapacity(1, 'scout'), 600);
    assert.strictEqual(remainingCapacity(1, 1800, 'scout'), 582);

    const inv = createEmptyInventory();
    const bp = ensureEquippedBackpack(inv, itemDb);
    assert.ok(bp);
    assert.strictEqual(inv.equipment.backpack, bp);
    assert.strictEqual(inv.rootUid, bp);
    assert.strictEqual(inv.containers[bp].capacity, 20);

    const added = addItemToInventory(inv, 'gold_coin', 4, itemDb);
    assert.strictEqual(added.ok, true);
    assert.strictEqual(countItem(inv, 'gold_coin'), 4);

    const swordUid = createItemInstance(inv, 'iron_longsword', itemDb);
    assert.ok(placeInContainer(inv, swordUid, inv.rootUid, null, itemDb).ok);
    const eq = equipItem(inv, swordUid, itemDb, 'rightHand');
    assert.strictEqual(eq.ok, true);
    assert.ok(inv.equipment.rightHand);
    assert.strictEqual(inv.items[inv.equipment.rightHand].itemId, 'iron_longsword');
    assert.strictEqual(countItem(inv, 'iron_longsword'), 0, 'equipped sword is not in bag tree');

    const bagUid = createItemInstance(inv, 'bag', itemDb);
    assert.ok(placeInContainer(inv, bagUid, inv.rootUid, null, itemDb).ok);
    const nested = createItemInstance(inv, 'gold_coin', itemDb, { count: 2 });
    assert.ok(placeInContainer(inv, nested, bagUid, null, itemDb).ok);
    assert.strictEqual(countItem(inv, 'gold_coin'), 6);

    const snap = serializeInventory(inv);
    assert.strictEqual(snap.version, 1);
    assert.ok(snap.equipment.backpack);
    const loaded = normalizeInventory(snap, itemDb);
    assert.strictEqual(countItem(loaded, 'gold_coin'), 6);
    assert.strictEqual(loaded.items[loaded.equipment.rightHand].itemId, 'iron_longsword');
    const nestedBags = Object.keys(loaded.containers).filter((k) => k !== loaded.rootUid && k !== 'root');
    assert.ok(nestedBags.length >= 1);

    const un = unequipItem(loaded, 'rightHand', itemDb);
    assert.strictEqual(un.ok, true);
    assert.ok(!loaded.equipment.rightHand);

    const cycle = moveItem(
        loaded,
        { kind: 'equipment', slot: 'backpack' },
        { kind: 'container', containerUid: loaded.rootUid, index: 0 },
        itemDb
    );
    assert.strictEqual(cycle.ok, false);

    const weight = totalCarriedWeight(loaded, itemDb);
    assert.ok(weight > 1800);
    assert.strictEqual(canCarryAdditional(1, weight, 1000000, 'scout'), false);

    const migrated = normalizeInventory({ items: [{ id: 'gold_coin', count: 3 }] }, itemDb);
    assert.strictEqual(countItem(migrated, 'gold_coin'), 3);
    assert.ok(migrated.equipment.backpack);

    const view = bagView(migrated, migrated.rootUid, itemDb);
    assert.ok(view.slots.some((s) => s.id === 'gold_coin' && s.count === 3));
    assert.strictEqual(takeItem(migrated, 'gold_coin', 3), true);
    assert.strictEqual(countItem(migrated, 'gold_coin'), 0);

    assert.strictEqual(countItem([{ id: 'cheese', count: 1 }], 'cheese'), 1);

    const fistSkills = {
        fist: 10,
        club: 10,
        sword: 10,
        axe: 10,
        distance: 10,
        shielding: 10,
        magic: 0
    };
    const naked = {
        inventory: createEmptyInventory(),
        skills: fistSkills,
        critChance: 5,
        critDamage: 10
    };
    applyPlayerLoadout(naked, itemDb);
    assert.strictEqual(naked.weaponSkill, 'fist');
    assert.strictEqual(naked.atk, 7);
    assert.strictEqual(
        naked.mitigation,
        computeMitigationPercent(10, UNARMED_WEAPON_DEFENSE),
        'unarmed mit uses shielding + weaponDefense 5'
    );
    assert.strictEqual(
        naked.maxBlock,
        computeMaxBlock(10, UNARMED_WEAPON_DEFENSE),
        'unarmed maxBlock uses fist + weaponDefense 5'
    );
    assert.strictEqual(naked.canBlock, naked.maxBlock > 0);

    const shieldedFist = {
        inventory: createEmptyInventory(),
        skills: fistSkills,
        critChance: 5,
        critDamage: 10
    };
    const shUid = createItemInstance(shieldedFist.inventory, 'wooden_shield', itemDb);
    assert.ok(placeInEquipment(shieldedFist.inventory, shUid, 'leftHand', itemDb).ok);
    applyPlayerLoadout(shieldedFist, itemDb);
    const shieldDef = 14 + 1;
    assert.strictEqual(shieldedFist.mitigation, computeMitigationPercent(10, shieldDef));
    assert.strictEqual(shieldedFist.maxBlock, computeMaxBlock(10, shieldDef));
    assert.strictEqual(shieldedFist.canBlock, true);

    console.log('ok inventory');
}

main();

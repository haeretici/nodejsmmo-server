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
    applyPlayerLoadout,
    tryBreakEquippedThrowingWeapon,
    equippedRightHandCount,
    equippedIsThrowingWeapon,
    resolveDistanceAutoShape
} = require('../src/world/inventory');
const {
    FALLBACK_ITEMS,
    UNARMED_WEAPON_DEFENSE,
    computeMitigationPercent,
    computeMaxBlock,
    stackResists,
    pipelineToPercent,
    DEFAULT_RESISTS
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
    },
    fire_ring: {
        id: 'fire_ring',
        slot: 'ring',
        category: 'ring',
        resists: { fire: 10 },
        atk: 5,
        weight: 90
    },
    ice_amulet: {
        id: 'ice_amulet',
        slot: 'amulet',
        category: 'amulet',
        resists: { fire: 10, ice: 20 },
        weight: 50
    },
    swift_boots: {
        id: 'swift_boots',
        slot: 'boots',
        category: 'boots',
        speed: 15,
        weight: 800
    },
    leech_blade: {
        id: 'leech_blade',
        slot: 'rightHand',
        category: 'sword',
        atk: 20,
        lifeLeechChance: 100,
        lifeLeechAmount: 1800,
        manaLeechChance: 100,
        manaLeechAmount: 300,
        weight: 4000
    },
    throwing_star: {
        id: 'throwing_star',
        slot: 'rightHand',
        category: 'spear',
        type: ['throwing'],
        weaponType: 'distance',
        stackable: true,
        breakChance: 33,
        atk: 10,
        weight: 200
    },
    snowball: {
        id: 'snowball',
        slot: 'rightHand',
        category: 'spear',
        type: ['throwing'],
        weaponType: 'distance',
        stackable: true,
        breakChance: 100,
        atk: 1,
        weight: 80
    },
    hunter_bow: {
        id: 'hunter_bow',
        slot: 'rightHand',
        category: 'bow',
        weaponType: 'distance',
        atk: 28,
        weight: 3200
    },
    quiver: {
        id: 'quiver',
        slot: 'leftHand',
        category: 'quiver',
        volume: 6,
        weight: 200
    },
    burst_arrow: {
        id: 'burst_arrow',
        category: 'ammo',
        ammoType: 'arrow',
        stackable: true,
        atk: 27,
        autoShape: { type: 'area', code: 3 },
        weight: 90
    },
    sniper_arrow: {
        id: 'sniper_arrow',
        category: 'ammo',
        ammoType: 'arrow',
        stackable: true,
        atk: 28,
        weight: 70
    }
});

function main() {
    assert.strictEqual(baseCapacity(1, 'scout'), 600);
    assert.strictEqual(baseCapacity(8, 'scout'), 670);
    assert.strictEqual(baseCapacity(9, 'guardian'), 695);
    assert.strictEqual(baseCapacity(9, 'mystic'), 695);
    assert.strictEqual(baseCapacity(9, 'scout'), 690);
    assert.strictEqual(baseCapacity(9, 'adept'), 680);
    assert.strictEqual(baseCapacity(9, 'warden'), 680);
    assert.strictEqual(baseCapacity(9, 'adventurer'), 680);
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

    assert.ok(Math.abs(stackResists([10, 10]) - 19) < 1e-6);
    assert.strictEqual(pipelineToPercent(1800), 18);
    assert.strictEqual(naked.resists.physical, 0);
    assert.strictEqual(naked.resists.fire, 0);
    assert.strictEqual(naked.baseSpeed, 110);
    assert.strictEqual(naked.lifeLeechChance, 0);
    assert.strictEqual(naked.lifeLeechAmount, 0);

    const rolled = {
        inventory: createEmptyInventory(),
        skills: fistSkills,
        critChance: 5,
        critDamage: 10,
        level: 8,
        _atkBonus: 3,
        _speedBonus: 2,
        _classBaseSpeed: 110
    };
    const rolledSword = createItemInstance(rolled.inventory, 'iron_longsword', itemDb);
    assert.ok(placeInEquipment(rolled.inventory, rolledSword, 'rightHand', itemDb).ok);
    const rolledRing = createItemInstance(rolled.inventory, 'fire_ring', itemDb);
    assert.ok(placeInEquipment(rolled.inventory, rolledRing, 'ring', itemDb).ok);
    const rolledAmulet = createItemInstance(rolled.inventory, 'ice_amulet', itemDb);
    assert.ok(placeInEquipment(rolled.inventory, rolledAmulet, 'amulet', itemDb).ok);
    const rolledBoots = createItemInstance(rolled.inventory, 'swift_boots', itemDb);
    assert.ok(placeInEquipment(rolled.inventory, rolledBoots, 'boots', itemDb).ok);
    applyPlayerLoadout(rolled, itemDb);
    assert.strictEqual(rolled.atk, 42 + 5 + 3, 'weapon + ring atk + class atkBonus');
    assert.ok(Math.abs(rolled.resists.fire - 19) < 1e-6, 'fire resists stack multiplicatively');
    assert.ok(Math.abs(rolled.resists.ice - 20) < 1e-6);
    assert.strictEqual(rolled.resists.physical, DEFAULT_RESISTS.physical);
    assert.strictEqual(rolled.baseSpeed, 110 + 7 + 15 + 2, 'class base + (L-1) + gear.speed + speedBonus');

    const leech = {
        inventory: createEmptyInventory(),
        skills: fistSkills,
        critChance: 5,
        critDamage: 10,
        level: 1
    };
    const bladeUid = createItemInstance(leech.inventory, 'leech_blade', itemDb);
    assert.ok(placeInEquipment(leech.inventory, bladeUid, 'rightHand', itemDb).ok);
    applyPlayerLoadout(leech, itemDb);
    assert.strictEqual(leech.lifeLeechChance, 100);
    assert.strictEqual(leech.lifeLeechAmount, 18);
    assert.strictEqual(leech.manaLeechChance, 100);
    assert.strictEqual(leech.manaLeechAmount, 3);
    assert.strictEqual(leech.atk, 20);

    const throwInv = createEmptyInventory();
    const starUid = createItemInstance(throwInv, 'throwing_star', itemDb, { count: 10 });
    assert.ok(placeInEquipment(throwInv, starUid, 'rightHand', itemDb).ok);
    assert.ok(equippedIsThrowingWeapon(throwInv, itemDb));
    assert.strictEqual(equippedRightHandCount(throwInv), 10);
    const noBreak = tryBreakEquippedThrowingWeapon(throwInv, itemDb, () => 0.5);
    assert.strictEqual(noBreak.broke, false, 'rng 50 vs chance 33 does not break');
    assert.strictEqual(equippedRightHandCount(throwInv), 10);
    const yesBreak = tryBreakEquippedThrowingWeapon(throwInv, itemDb, () => 0);
    assert.ok(yesBreak.broke);
    assert.strictEqual(yesBreak.remaining, 9);
    assert.strictEqual(equippedRightHandCount(throwInv), 9);

    const snowInv = createEmptyInventory();
    const snowUid = createItemInstance(snowInv, 'snowball', itemDb, { count: 2 });
    assert.ok(placeInEquipment(snowInv, snowUid, 'rightHand', itemDb).ok);
    const wBefore = totalCarriedWeight(snowInv, itemDb);
    const always = tryBreakEquippedThrowingWeapon(snowInv, itemDb, () => 0.99);
    assert.ok(always.broke, 'breakChance 100 always breaks');
    assert.strictEqual(equippedRightHandCount(snowInv), 1);
    assert.strictEqual(totalCarriedWeight(snowInv, itemDb), wBefore - 80);
    tryBreakEquippedThrowingWeapon(snowInv, itemDb, () => 0);
    assert.strictEqual(equippedRightHandCount(snowInv), 0);
    assert.ok(!snowInv.equipment.rightHand, 'empty throwing stack clears rightHand');

    const bowInv = createEmptyInventory();
    const bowUid = createItemInstance(bowInv, 'hunter_bow', itemDb);
    assert.ok(placeInEquipment(bowInv, bowUid, 'rightHand', itemDb).ok);
    const qUid = createItemInstance(bowInv, 'quiver', itemDb);
    assert.ok(placeInEquipment(bowInv, qUid, 'leftHand', itemDb).ok);
    const burstUid = createItemInstance(bowInv, 'burst_arrow', itemDb, { count: 3 });
    assert.ok(placeInContainer(bowInv, burstUid, qUid, null, itemDb).ok);
    assert.deepStrictEqual(resolveDistanceAutoShape(bowInv, itemDb), { type: 'area', code: 3 });
    const sniperUid = createItemInstance(bowInv, 'sniper_arrow', itemDb, { count: 1 });
    assert.ok(placeInContainer(bowInv, sniperUid, qUid, null, itemDb).ok);
    assert.deepStrictEqual(
        resolveDistanceAutoShape(bowInv, itemDb),
        { type: 'area', code: 3 },
        'first quiver ammo stack wins autoShape'
    );
    assert.strictEqual(resolveDistanceAutoShape(throwInv, itemDb), null, 'throwing stays ST');

    console.log('ok inventory');
}

main();

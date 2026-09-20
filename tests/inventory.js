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
    getStackCount,
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

    const nestInv = createEmptyInventory();
    ensureEquippedBackpack(nestInv, itemDb);
    const nestA = createItemInstance(nestInv, 'bag', itemDb);
    assert.ok(placeInContainer(nestInv, nestA, nestInv.rootUid, null, itemDb).ok);
    const nestB = createItemInstance(nestInv, 'bag', itemDb);
    assert.ok(placeInContainer(nestInv, nestB, nestA, null, itemDb).ok);
    const locA = nestInv.items[nestA].location;
    const nestCycle = moveItem(
        nestInv,
        locA,
        { kind: 'container', containerUid: nestB, index: 0 },
        itemDb
    );
    assert.strictEqual(nestCycle.ok, false);
    assert.strictEqual(nestCycle.error, 'cycle');

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

    const splitInv = createEmptyInventory();
    ensureEquippedBackpack(splitInv, itemDb);
    const sixUid = createItemInstance(splitInv, 'gold_coin', itemDb, { count: 6 });
    assert.ok(placeInContainer(splitInv, sixUid, splitInv.rootUid, 0, itemDb).ok);
    const split = moveItem(
        splitInv,
        { kind: 'container', containerUid: splitInv.rootUid, index: 0 },
        { kind: 'container', containerUid: splitInv.rootUid, index: 1 },
        itemDb,
        3
    );
    assert.ok(split.ok, 'split 3 of 6 into empty slot');
    assert.strictEqual(countItem(splitInv, 'gold_coin'), 6);
    assert.strictEqual(getStackCount(splitInv.items[sixUid]), 3);
    const splitView = bagView(splitInv, splitInv.rootUid, itemDb);
    const threeAt0 = splitView.slots.find((s) => s.index === 0);
    const threeAt1 = splitView.slots.find((s) => s.index === 1);
    assert.ok(threeAt0 && threeAt0.id === 'gold_coin' && threeAt0.count === 3);
    assert.ok(threeAt1 && threeAt1.id === 'gold_coin' && threeAt1.count === 3);

    const mergeInv = createEmptyInventory();
    ensureEquippedBackpack(mergeInv, itemDb);
    const srcUid = createItemInstance(mergeInv, 'gold_coin', itemDb, { count: 6 });
    const dstUid = createItemInstance(mergeInv, 'gold_coin', itemDb, { count: 4 });
    assert.ok(placeInContainer(mergeInv, srcUid, mergeInv.rootUid, 0, itemDb).ok);
    assert.ok(placeInContainer(mergeInv, dstUid, mergeInv.rootUid, 1, itemDb).ok);
    const merged = moveItem(
        mergeInv,
        { kind: 'container', containerUid: mergeInv.rootUid, index: 0 },
        { kind: 'container', containerUid: mergeInv.rootUid, index: 1 },
        itemDb,
        3
    );
    assert.ok(merged.ok && merged.merged, 'partial merge into dest stack');
    assert.strictEqual(getStackCount(mergeInv.items[srcUid]), 3);
    assert.strictEqual(getStackCount(mergeInv.items[dstUid]), 7);

    const allMoved = moveItem(
        mergeInv,
        { kind: 'container', containerUid: mergeInv.rootUid, index: 0 },
        { kind: 'container', containerUid: mergeInv.rootUid, index: 1 },
        itemDb,
        0
    );
    assert.ok(allMoved.ok, 'count 0 moves remaining stack');
    assert.ok(!mergeInv.items[srcUid], 'source stack gone after full move');
    assert.strictEqual(getStackCount(mergeInv.items[dstUid]), 10);

    const occInv = createEmptyInventory();
    ensureEquippedBackpack(occInv, itemDb);
    const occGold = createItemInstance(occInv, 'gold_coin', itemDb, { count: 6 });
    const occSword = createItemInstance(occInv, 'iron_longsword', itemDb);
    assert.ok(placeInContainer(occInv, occGold, occInv.rootUid, 0, itemDb).ok);
    assert.ok(placeInContainer(occInv, occSword, occInv.rootUid, 1, itemDb).ok);
    const occupied = moveItem(
        occInv,
        { kind: 'container', containerUid: occInv.rootUid, index: 0 },
        { kind: 'container', containerUid: occInv.rootUid, index: 1 },
        itemDb,
        3
    );
    assert.strictEqual(occupied.ok, false);
    assert.strictEqual(occupied.error, 'occupied');
    assert.strictEqual(getStackCount(occInv.items[occGold]), 6);
    assert.strictEqual(occInv.items[occSword].itemId, 'iron_longsword');

    testOpenEquippedContainer();
    testNestedBags();

    console.log('ok inventory');
}

function testOpenEquippedContainer() {
    const { testSettings } = require('./helpers');
    const { World } = require('../src/world/world');
    const { GameSession } = require('../src/world/session');
    const { MemoryStore } = require('../src/persist/memory_store');
    const { RateLimiter } = require('../src/security/rate_limit');
    const { createLog } = require('../src/log');
    const { C2S, S2C } = require('../src/protocol/opcodes');
    const { decodeFrame } = require('../src/protocol/frame');
    const { encodeContainerSlot, decodeInventory, decodeEquipment } = require('../src/protocol/messages');
    const { createStaticMap } = require('../src/world/static_map');

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

    const world = new World({
        settings: testSettings(),
        store: new MemoryStore(),
        log: createLog(testSettings()),
        schedule: () => 0,
        clear: () => {},
        map: createStaticMap(),
        pack: { classes: { classes: [{ id: 'scout', baseRegenHp: 0, baseRegenMp: 0 }] } }
    });
    world._itemDb = itemDb;
    world.start();

    function makeSession(name) {
        const session = new GameSession({
            socket: fakeSocket(),
            ip: '127.0.0.1',
            world,
            settings: world.settings,
            limiter: new RateLimiter(),
            log: world.log
        });
        session.bindCharacter({
            id: name === 'scout' ? 1 : 2,
            accountId: 1,
            name: name,
            vocation: name === 'scout' ? 'scout' : 'guardian',
            level: 1,
            experience: 0,
            hp: 185,
            hpMax: 185,
            mp: 90,
            mpMax: 90,
            townId: 1
        }, world.spawnPos({ townId: 1 }));
        assert.ok(world.add(session));
        return session;
    }

    const scout = makeSession('scout');
    const scoutInv = createEmptyInventory();
    ensureEquippedBackpack(scoutInv, itemDb);
    const bowUid = createItemInstance(scoutInv, 'hunter_bow', itemDb);
    assert.ok(placeInEquipment(scoutInv, bowUid, 'rightHand', itemDb).ok);
    const quiverUid = createItemInstance(scoutInv, 'quiver', itemDb);
    assert.ok(placeInEquipment(scoutInv, quiverUid, 'leftHand', itemDb).ok);
    const arrowUid = createItemInstance(scoutInv, 'sniper_arrow', itemDb, { count: 100 });
    assert.ok(placeInContainer(scoutInv, arrowUid, quiverUid, null, itemDb).ok);
    const bagUid = createItemInstance(scoutInv, 'bag', itemDb);
    assert.ok(placeInContainer(scoutInv, bagUid, scoutInv.rootUid, null, itemDb).ok);
    scout.inventory = scoutInv;
    applyPlayerLoadout(scout, itemDb);
    world.sendEnterWorld(scout);

    const eqFrame = lastOf(scout.socket, S2C.EQUIPMENT);
    assert.ok(eqFrame, 'EQUIPMENT after enter');
    const eq = decodeEquipment(eqFrame.payload);
    const shield = eq.slots.find((s) => s.slot === 'shield');
    assert.ok(shield && shield.id === 'quiver', 'quiver in left hand');
    const weapon = eq.slots.find((s) => s.slot === 'weapon');
    assert.ok(weapon && weapon.id === 'hunter_bow');
    assert.strictEqual(shield.flags, 1, 'quiver slot flagged container');
    assert.strictEqual(weapon.flags, 0, 'bow is not a container');

    scout.socket.sent = [];
    assert.ok(world.enqueueIntent(scout, {
        opcode: C2S.OPEN_BAG,
        seq: scout.nextClientSeq,
        payload: encodeContainerSlot('shield', 0)
    }));
    world.step(1);
    assert.strictEqual(scout.openBagUid, quiverUid);
    const bagPkt = decodeInventory(lastOf(scout.socket, S2C.BAG).payload);
    assert.strictEqual(bagPkt.containerId, quiverUid);
    const arrows = bagPkt.slots.find((s) => s.id === 'sniper_arrow');
    assert.ok(arrows, 'quiver BAG lists arrows');
    assert.strictEqual(arrows.count, 100);

    const repairedInv = createEmptyInventory();
    ensureEquippedBackpack(repairedInv, itemDb);
    const repairedQ = createItemInstance(repairedInv, 'quiver', itemDb);
    assert.ok(placeInEquipment(repairedInv, repairedQ, 'leftHand', itemDb).ok);
    delete repairedInv.containers[repairedQ];
    scout.inventory = repairedInv;
    applyPlayerLoadout(scout, itemDb);
    scout.socket.sent = [];
    assert.ok(world.enqueueIntent(scout, {
        opcode: C2S.OPEN_BAG,
        seq: scout.nextClientSeq,
        payload: encodeContainerSlot('leftHand', 0)
    }));
    world.step(2);
    assert.ok(repairedInv.containers[repairedQ], 'OPEN_BAG repairs missing quiver container');
    assert.strictEqual(scout.openBagUid, repairedQ);

    scout.inventory = scoutInv;
    applyPlayerLoadout(scout, itemDb);
    world.sendInventory(scout);
    const rootView = decodeInventory(lastOf(scout.socket, S2C.INVENTORY).payload);
    const nested = rootView.slots.find((s) => s.id === 'bag');
    assert.ok(nested && (nested.flags & 1), 'nested bag flagged');
    scout.socket.sent = [];
    assert.ok(world.enqueueIntent(scout, {
        opcode: C2S.OPEN_BAG,
        seq: scout.nextClientSeq,
        payload: encodeContainerSlot(rootView.containerId, nested.index)
    }));
    world.step(3);
    assert.strictEqual(scout.openBagUid, bagUid, 'OPEN_BAG still opens nested bag by parent+index');

    const guard = makeSession('guard');
    const guardInv = createEmptyInventory();
    ensureEquippedBackpack(guardInv, itemDb);
    const swordUid = createItemInstance(guardInv, 'iron_longsword', itemDb);
    assert.ok(placeInEquipment(guardInv, swordUid, 'rightHand', itemDb).ok);
    const shieldUid = createItemInstance(guardInv, 'wooden_shield', itemDb);
    assert.ok(placeInEquipment(guardInv, shieldUid, 'leftHand', itemDb).ok);
    guard.inventory = guardInv;
    applyPlayerLoadout(guard, itemDb);
    world.sendEnterWorld(guard);
    guard.socket.sent = [];
    assert.ok(world.enqueueIntent(guard, {
        opcode: C2S.OPEN_BAG,
        seq: guard.nextClientSeq,
        payload: encodeContainerSlot('shield', 0)
    }));
    world.step(4);
    assert.ok(!guard.openBagUid, 'wooden_shield OPEN_BAG rejected');
    assert.ok(lastOf(guard.socket, S2C.REJECT), 'non-container equipment rejects');

    world.stop();
}

function testNestedBags() {
    const { testSettings } = require('./helpers');
    const { World } = require('../src/world/world');
    const { GameSession } = require('../src/world/session');
    const { MemoryStore } = require('../src/persist/memory_store');
    const { RateLimiter } = require('../src/security/rate_limit');
    const { createLog } = require('../src/log');
    const { C2S, S2C } = require('../src/protocol/opcodes');
    const { decodeFrame } = require('../src/protocol/frame');
    const { encodeContainerSlot, decodeInventory, encodeCloseBag } = require('../src/protocol/messages');
    const { createStaticMap } = require('../src/world/static_map');

    function fakeSocket() {
        return {
            readyState: 1,
            sent: [],
            send(buf) { this.sent.push(Buffer.from(buf)); },
            close() { this.readyState = 3; this.closed = true; },
            terminate() { this.readyState = 3; this.closed = true; }
        };
    }

    function allOf(sock, opcode) {
        const out = [];
        for (let i = 0; i < sock.sent.length; i++) {
            const f = decodeFrame(sock.sent[i]);
            if (f.opcode === opcode) out.push(f);
        }
        return out;
    }

    const world = new World({
        settings: testSettings(),
        store: new MemoryStore(),
        log: createLog(testSettings()),
        schedule: () => 0,
        clear: () => {},
        map: createStaticMap(),
        pack: { classes: { classes: [{ id: 'scout', baseRegenHp: 0, baseRegenMp: 0 }] } }
    });
    world._itemDb = itemDb;
    world.start();

    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter({
        id: 3,
        accountId: 1,
        name: 'nest',
        vocation: 'scout',
        level: 1,
        experience: 0,
        hp: 185,
        hpMax: 185,
        mp: 90,
        mpMax: 90,
        townId: 1
    }, world.spawnPos({ townId: 1 }));
    assert.ok(world.add(session));
    const sock = session.socket;

    const inv = createEmptyInventory();
    ensureEquippedBackpack(inv, itemDb);
    const bagA = createItemInstance(inv, 'bag', itemDb);
    assert.ok(placeInContainer(inv, bagA, inv.rootUid, null, itemDb).ok);
    const goldA = createItemInstance(inv, 'gold_coin', itemDb, { count: 4 });
    assert.ok(placeInContainer(inv, goldA, bagA, null, itemDb).ok);
    const bagB = createItemInstance(inv, 'bag', itemDb);
    assert.ok(placeInContainer(inv, bagB, bagA, null, itemDb).ok);
    const goldB = createItemInstance(inv, 'gold_coin', itemDb, { count: 2 });
    assert.ok(placeInContainer(inv, goldB, bagB, null, itemDb).ok);
    session.inventory = inv;
    applyPlayerLoadout(session, itemDb);
    world.sendEnterWorld(session);

    const rootView = decodeInventory(allOf(sock, S2C.INVENTORY).pop().payload);
    const slotA = rootView.slots.find((s) => s.id === 'bag');
    assert.ok(slotA && (slotA.flags & 1), 'bag in root is flagged container');

    sock.sent = [];
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.OPEN_BAG,
        seq: session.nextClientSeq,
        payload: encodeContainerSlot(rootView.containerId, slotA.index)
    }));
    world.step(1);
    assert.deepStrictEqual(session.openBagUids, [bagA]);
    assert.strictEqual(session.openBagUid, bagA);
    const openA = decodeInventory(allOf(sock, S2C.BAG).pop().payload);
    assert.strictEqual(openA.containerId, bagA);
    assert.ok(openA.slots.some((s) => s.id === 'gold_coin' && s.count === 4), 'bag A inner gold');
    const innerBag = openA.slots.find((s) => s.id === 'bag');
    assert.ok(innerBag && (innerBag.flags & 1), 'bag B flagged inside A');

    sock.sent = [];
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.OPEN_BAG,
        seq: session.nextClientSeq,
        payload: encodeContainerSlot(bagA, innerBag.index)
    }));
    world.step(2);
    assert.strictEqual(session.openBagUids.length, 2, 'parent stays in open list');
    assert.ok(session.openBagUids.indexOf(bagA) >= 0);
    assert.ok(session.openBagUids.indexOf(bagB) >= 0);
    assert.strictEqual(session.openBagUid, bagB);
    const live = allOf(sock, S2C.BAG)
        .map((f) => decodeInventory(f.payload))
        .filter((v) => (v.capacity | 0) > 0);
    assert.ok(live.some((v) => v.containerId === bagA), 'BAG still streams parent A');
    const viewB = live.find((v) => v.containerId === bagB);
    assert.ok(viewB, 'BAG streams nested B');
    assert.ok(viewB.slots.some((s) => s.id === 'gold_coin' && s.count === 2), 'bag B inner gold');

    sock.sent = [];
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.CLOSE_BAG,
        seq: session.nextClientSeq,
        payload: encodeCloseBag(bagB)
    }));
    world.step(3);
    assert.deepStrictEqual(session.openBagUids, [bagA], 'CLOSE_BAG drops only B');
    const afterClose = allOf(sock, S2C.BAG).map((f) => decodeInventory(f.payload));
    assert.ok(afterClose.some((v) => v.containerId === bagB && (v.capacity | 0) === 0), 'closed B is capacity 0');
    assert.ok(afterClose.some((v) => v.containerId === bagA && (v.capacity | 0) > 0), 'A still sent');

    sock.sent = [];
    world.sendInventory(session);
    const refresh = allOf(sock, S2C.BAG).map((f) => decodeInventory(f.payload));
    assert.ok(refresh.every((v) => v.containerId !== bagB || (v.capacity | 0) === 0), 'closed B not refreshed');
    assert.ok(refresh.some((v) => v.containerId === bagA && (v.capacity | 0) > 0));

    sock.sent = [];
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.CLOSE_BAG,
        seq: session.nextClientSeq,
        payload: encodeCloseBag('')
    }));
    world.step(4);
    assert.deepStrictEqual(session.openBagUids, []);
    assert.strictEqual(session.openBagUid, '');
    const closedAll = decodeInventory(allOf(sock, S2C.BAG).pop().payload);
    assert.strictEqual(closedAll.containerId, '');
    assert.strictEqual(closedAll.capacity, 0);

    world.stop();
}

main();

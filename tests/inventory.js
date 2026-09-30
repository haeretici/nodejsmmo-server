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
    const splitOntoSword = moveItem(
        occInv,
        { kind: 'container', containerUid: occInv.rootUid, index: 0 },
        { kind: 'container', containerUid: occInv.rootUid, index: 1 },
        itemDb,
        3
    );
    assert.strictEqual(splitOntoSword.ok, true, 'container index is ignored; split inserts at 0');
    assert.strictEqual(getStackCount(occInv.items[occGold]), 3);
    assert.strictEqual(occInv.containers[occInv.rootUid].slots[1], occGold);
    assert.strictEqual(occInv.containers[occInv.rootUid].slots[2], occSword);
    const splitFront = occInv.containers[occInv.rootUid].slots[0];
    assert.ok(splitFront && splitFront !== occGold);
    assert.strictEqual(occInv.items[splitFront].itemId, 'gold_coin');
    assert.strictEqual(getStackCount(occInv.items[splitFront]), 3);

    testOpenEquippedContainer();
    testNestedBags();
    testContainerDropInsert();

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

function freshInv() {
    const inv = createEmptyInventory();
    ensureEquippedBackpack(inv, itemDb);
    return inv;
}

function setCap(inv, uid, cap) {
    const cont = inv.containers[uid];
    const slots = [];
    for (let i = 0; i < cap; i++) slots.push((cont.slots && cont.slots[i]) || null);
    cont.capacity = cap;
    cont.slots = slots;
}

function packed(inv, uid) {
    const cont = inv.containers[uid];
    const out = [];
    for (let i = 0; i < cont.slots.length; i++) {
        const id = cont.slots[i];
        if (!id) continue;
        const inst = inv.items[id];
        out.push({ index: i, uid: id, id: inst.itemId, count: getStackCount(inst) });
    }
    return out;
}

function assertDense(inv, uid) {
    const cont = inv.containers[uid];
    let hole = false;
    for (let i = 0; i < cont.slots.length; i++) {
        if (!cont.slots[i]) hole = true;
        else assert.strictEqual(hole, false, uid + ' has a hole before an item');
    }
}

function testContainerDropInsert() {
    const empty = freshInv();
    const emptyBag = createItemInstance(empty, 'bag', itemDb);
    assert.ok(placeInContainer(empty, emptyBag, empty.rootUid, 0, itemDb).ok);
    const emptyShield = createItemInstance(empty, 'wooden_shield', itemDb);
    assert.ok(placeInEquipment(empty, emptyShield, 'leftHand', itemDb).ok);
    const intoEmpty = moveItem(
        empty,
        { kind: 'equipment', slot: 'leftHand' },
        { kind: 'container', containerUid: emptyBag, index: 3 },
        itemDb
    );
    assert.strictEqual(intoEmpty.ok, true);
    assert.deepStrictEqual(packed(empty, emptyBag), [
        { index: 0, uid: emptyShield, id: 'wooden_shield', count: 1 }
    ]);
    assert.ok(!empty.equipment.leftHand);
    assertDense(empty, emptyBag);

    const shift = freshInv();
    const shiftBag = createItemInstance(shift, 'bag', itemDb);
    assert.ok(placeInContainer(shift, shiftBag, shift.rootUid, 0, itemDb).ok);
    const shiftGold = createItemInstance(shift, 'gold_coin', itemDb, { count: 4 });
    const shiftShield = createItemInstance(shift, 'wooden_shield', itemDb);
    assert.ok(placeInContainer(shift, shiftGold, shiftBag, 0, itemDb).ok);
    assert.ok(placeInContainer(shift, shiftShield, shiftBag, 1, itemDb).ok);
    const shiftSword = createItemInstance(shift, 'iron_longsword', itemDb);
    assert.ok(placeInContainer(shift, shiftSword, shift.rootUid, 1, itemDb).ok);
    const shifted = moveItem(
        shift,
        { kind: 'container', containerUid: shift.rootUid, index: 1 },
        { kind: 'container', containerUid: shiftBag, index: 255 },
        itemDb
    );
    assert.strictEqual(shifted.ok, true);
    assert.deepStrictEqual(packed(shift, shiftBag).map((s) => s.id), [
        'iron_longsword',
        'gold_coin',
        'wooden_shield'
    ]);
    assert.strictEqual(packed(shift, shiftBag)[0].index, 0);
    assert.deepStrictEqual(packed(shift, shift.rootUid).map((s) => s.id), ['bag']);
    assertDense(shift, shiftBag);
    assertDense(shift, shift.rootUid);

    const reorder = freshInv();
    const reorderGold = createItemInstance(reorder, 'gold_coin', itemDb, { count: 2 });
    const reorderShield = createItemInstance(reorder, 'wooden_shield', itemDb);
    const reorderSword = createItemInstance(reorder, 'iron_longsword', itemDb);
    assert.ok(placeInContainer(reorder, reorderGold, reorder.rootUid, 0, itemDb).ok);
    assert.ok(placeInContainer(reorder, reorderShield, reorder.rootUid, 1, itemDb).ok);
    assert.ok(placeInContainer(reorder, reorderSword, reorder.rootUid, 2, itemDb).ok);
    const reordered = moveItem(
        reorder,
        { kind: 'container', containerUid: reorder.rootUid, index: 2 },
        { kind: 'container', containerUid: reorder.rootUid, index: 2 },
        itemDb
    );
    assert.strictEqual(reordered.ok, true);
    assert.deepStrictEqual(packed(reorder, reorder.rootUid).map((s) => s.uid), [
        reorderSword,
        reorderGold,
        reorderShield
    ]);
    assertDense(reorder, reorder.rootUid);

    const full = freshInv();
    const pouch = createItemInstance(full, 'bag', itemDb);
    assert.ok(placeInContainer(full, pouch, full.rootUid, 0, itemDb).ok);
    const fullA = createItemInstance(full, 'iron_longsword', itemDb);
    const fullB = createItemInstance(full, 'wooden_shield', itemDb);
    assert.ok(placeInContainer(full, fullA, pouch, 0, itemDb).ok);
    assert.ok(placeInContainer(full, fullB, pouch, 1, itemDb).ok);
    setCap(full, pouch, 2);
    const fullC = createItemInstance(full, 'hunter_bow', itemDb);
    assert.ok(placeInContainer(full, fullC, full.rootUid, 1, itemDb).ok);
    const rejected = moveItem(
        full,
        { kind: 'container', containerUid: full.rootUid, index: 1 },
        { kind: 'container', containerUid: pouch, index: 0 },
        itemDb
    );
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.error, 'full');
    assert.deepStrictEqual(packed(full, pouch).map((s) => s.uid), [fullA, fullB]);
    assert.strictEqual(full.containers[full.rootUid].slots[1], fullC);

    const fullReorder = moveItem(
        full,
        { kind: 'container', containerUid: pouch, index: 1 },
        { kind: 'container', containerUid: pouch, index: 0 },
        itemDb
    );
    assert.strictEqual(fullReorder.ok, true, 'full same-container reorder detaches first');
    assert.deepStrictEqual(packed(full, pouch).map((s) => s.uid), [fullB, fullA]);
    assertDense(full, pouch);

    const fullStack = freshInv();
    const stackPouch = createItemInstance(fullStack, 'bag', itemDb);
    const stackGold = createItemInstance(fullStack, 'gold_coin', itemDb, { count: 6 });
    const stackSword = createItemInstance(fullStack, 'iron_longsword', itemDb);
    assert.ok(placeInContainer(fullStack, stackPouch, fullStack.rootUid, 0, itemDb).ok);
    assert.ok(placeInContainer(fullStack, stackGold, stackPouch, 0, itemDb).ok);
    assert.ok(placeInContainer(fullStack, stackSword, stackPouch, 1, itemDb).ok);
    setCap(fullStack, stackPouch, 2);
    const fullSplit = moveItem(
        fullStack,
        { kind: 'container', containerUid: stackPouch, index: 0 },
        { kind: 'container', containerUid: stackPouch, index: 1 },
        itemDb,
        2
    );
    assert.strictEqual(fullSplit.ok, false);
    assert.strictEqual(fullSplit.error, 'full');
    assert.strictEqual(getStackCount(fullStack.items[stackGold]), 6);
    assert.deepStrictEqual(packed(fullStack, stackPouch).map((s) => s.uid), [stackGold, stackSword]);

    const nest = freshInv();
    const nestBag = createItemInstance(nest, 'bag', itemDb);
    const nestShield = createItemInstance(nest, 'wooden_shield', itemDb);
    const nestSword = createItemInstance(nest, 'iron_longsword', itemDb);
    const nestGold = createItemInstance(nest, 'gold_coin', itemDb, { count: 3 });
    assert.ok(placeInContainer(nest, nestBag, nest.rootUid, 0, itemDb).ok);
    assert.ok(placeInContainer(nest, nestShield, nestBag, 0, itemDb).ok);
    assert.ok(placeInContainer(nest, nestSword, nest.rootUid, 1, itemDb).ok);
    assert.ok(placeInContainer(nest, nestGold, nest.rootUid, 2, itemDb).ok);
    const entered = moveItem(
        nest,
        { kind: 'container', containerUid: nest.rootUid, index: 1 },
        { kind: 'container', containerUid: nest.rootUid, index: 0 },
        itemDb
    );
    assert.strictEqual(entered.ok, true);
    assert.deepStrictEqual(packed(nest, nestBag).map((s) => s.uid), [nestSword, nestShield]);
    assert.deepStrictEqual(packed(nest, nest.rootUid).map((s) => s.uid), [nestBag, nestGold]);
    assertDense(nest, nestBag);
    assertDense(nest, nest.rootUid);
    const beside = moveItem(
        nest,
        { kind: 'container', containerUid: nest.rootUid, index: 1 },
        { kind: 'container', containerUid: nest.rootUid, index: 1 },
        itemDb
    );
    assert.strictEqual(beside.ok, true);
    assert.deepStrictEqual(packed(nest, nest.rootUid).map((s) => s.uid), [nestGold, nestBag]);

    const part = freshInv();
    const partBag = createItemInstance(part, 'bag', itemDb);
    const partHave = createItemInstance(part, 'gold_coin', itemDb, { count: 90 });
    const partMove = createItemInstance(part, 'gold_coin', itemDb, { count: 15 });
    assert.ok(placeInContainer(part, partBag, part.rootUid, 0, itemDb).ok);
    assert.ok(placeInContainer(part, partHave, partBag, 0, itemDb).ok);
    assert.ok(placeInContainer(part, partMove, part.rootUid, 1, itemDb).ok);
    const wPart = totalCarriedWeight(part, itemDb);
    const mergedPart = moveItem(
        part,
        { kind: 'container', containerUid: part.rootUid, index: 1 },
        { kind: 'container', containerUid: partBag, index: 4 },
        itemDb,
        0
    );
    assert.strictEqual(mergedPart.ok, true);
    assert.strictEqual(getStackCount(part.items[partHave]), 100);
    const partSlots = packed(part, partBag);
    assert.strictEqual(partSlots[0].uid, partMove);
    assert.strictEqual(partSlots[0].count, 5);
    assert.strictEqual(partSlots[1].uid, partHave);
    assert.strictEqual(partSlots[1].count, 100);
    assert.strictEqual(totalCarriedWeight(part, itemDb), wPart);
    assert.strictEqual(part.totalWeight, wPart);

    const outside = freshInv();
    const outsideBag = createItemInstance(outside, 'bag', itemDb);
    const outsideGold = createItemInstance(outside, 'gold_coin', itemDb, { count: 6 });
    assert.ok(placeInContainer(outside, outsideBag, outside.rootUid, 0, itemDb).ok);
    assert.ok(placeInContainer(outside, outsideGold, outside.rootUid, 1, itemDb).ok);
    const wOut = totalCarriedWeight(outside, itemDb);
    const splitOut = moveItem(
        outside,
        { kind: 'container', containerUid: outside.rootUid, index: 1 },
        { kind: 'container', containerUid: outsideBag, index: 0 },
        itemDb,
        2
    );
    assert.strictEqual(splitOut.ok, true);
    assert.strictEqual(getStackCount(outside.items[outsideGold]), 4);
    assert.deepStrictEqual(packed(outside, outsideBag).map((s) => s.count), [2]);
    assert.strictEqual(totalCarriedWeight(outside, itemDb), wOut);
    assert.strictEqual(outside.totalWeight, wOut);

    const same = freshInv();
    const sameGold = createItemInstance(same, 'gold_coin', itemDb, { count: 6 });
    const sameSword = createItemInstance(same, 'iron_longsword', itemDb);
    assert.ok(placeInContainer(same, sameGold, same.rootUid, 0, itemDb).ok);
    assert.ok(placeInContainer(same, sameSword, same.rootUid, 1, itemDb).ok);
    const wSame = totalCarriedWeight(same, itemDb);
    const sameSplit = moveItem(
        same,
        { kind: 'container', containerUid: same.rootUid, index: 0 },
        { kind: 'container', containerUid: same.rootUid, index: 1 },
        itemDb,
        2
    );
    assert.strictEqual(sameSplit.ok, true);
    assert.strictEqual(getStackCount(same.items[sameGold]), 4);
    const sameSlots = packed(same, same.rootUid);
    assert.strictEqual(sameSlots[0].count, 2);
    assert.strictEqual(sameSlots[0].id, 'gold_coin');
    assert.notStrictEqual(sameSlots[0].uid, sameGold);
    assert.strictEqual(sameSlots[1].uid, sameGold);
    assert.strictEqual(sameSlots[1].count, 4);
    assert.strictEqual(sameSlots[2].uid, sameSword);
    assert.strictEqual(totalCarriedWeight(same, itemDb), wSame);
    assert.strictEqual(same.totalWeight, wSame);

    const holes = freshInv();
    const holeSword = createItemInstance(holes, 'iron_longsword', itemDb);
    const holeShield = createItemInstance(holes, 'wooden_shield', itemDb);
    const holeGold = createItemInstance(holes, 'gold_coin', itemDb, { count: 1 });
    const holeBag = createItemInstance(holes, 'bag', itemDb);
    assert.ok(placeInContainer(holes, holeSword, holes.rootUid, 0, itemDb).ok);
    assert.ok(placeInContainer(holes, holeShield, holes.rootUid, 2, itemDb).ok);
    assert.ok(placeInContainer(holes, holeBag, holes.rootUid, 3, itemDb).ok);
    assert.ok(placeInContainer(holes, holeGold, holeBag, 0, itemDb).ok);
    const closed = moveItem(
        holes,
        { kind: 'container', containerUid: holeBag, index: 0 },
        { kind: 'container', containerUid: holes.rootUid, index: 1 },
        itemDb
    );
    assert.strictEqual(closed.ok, true);
    assert.deepStrictEqual(packed(holes, holes.rootUid).map((s) => s.uid), [
        holeGold,
        holeSword,
        holeShield,
        holeBag
    ]);
    assertDense(holes, holes.rootUid);
    assert.deepStrictEqual(packed(holes, holeBag), []);

    const cyc = freshInv();
    const cycBag = createItemInstance(cyc, 'bag', itemDb);
    const cycInner = createItemInstance(cyc, 'bag', itemDb);
    assert.ok(placeInContainer(cyc, cycBag, cyc.rootUid, 0, itemDb).ok);
    assert.ok(placeInContainer(cyc, cycInner, cycBag, 0, itemDb).ok);
    const beforeCycle = packed(cyc, cyc.rootUid).map((s) => s.uid);
    const selfCycle = moveItem(
        cyc,
        { kind: 'container', containerUid: cyc.rootUid, index: 0 },
        { kind: 'container', containerUid: cycBag, index: 0 },
        itemDb
    );
    assert.strictEqual(selfCycle.ok, false);
    assert.strictEqual(selfCycle.error, 'cycle');
    const innerCycle = moveItem(
        cyc,
        { kind: 'container', containerUid: cyc.rootUid, index: 0 },
        { kind: 'container', containerUid: cycInner, index: 0 },
        itemDb
    );
    assert.strictEqual(innerCycle.ok, false);
    assert.strictEqual(innerCycle.error, 'cycle');
    assert.deepStrictEqual(packed(cyc, cyc.rootUid).map((s) => s.uid), beforeCycle);
    assert.strictEqual(cyc.containers[cycBag].slots[0], cycInner);

    const quiverInv = freshInv();
    const quiver = createItemInstance(quiverInv, 'quiver', itemDb);
    assert.ok(placeInEquipment(quiverInv, quiver, 'leftHand', itemDb).ok);
    const qSword = createItemInstance(quiverInv, 'iron_longsword', itemDb);
    assert.ok(placeInContainer(quiverInv, qSword, quiverInv.rootUid, 0, itemDb).ok);
    const ammoReject = moveItem(
        quiverInv,
        { kind: 'container', containerUid: quiverInv.rootUid, index: 0 },
        { kind: 'container', containerUid: quiver, index: 0 },
        itemDb
    );
    assert.strictEqual(ammoReject.ok, false);
    assert.strictEqual(ammoReject.error, 'only_ammo');
    assert.deepStrictEqual(packed(quiverInv, quiver), []);
    assert.strictEqual(quiverInv.containers[quiverInv.rootUid].slots[0], qSword);
    assert.strictEqual(quiverInv.equipment.leftHand, quiver);

    const looseQ = freshInv();
    const looseQuiver = createItemInstance(looseQ, 'quiver', itemDb);
    const looseSword = createItemInstance(looseQ, 'iron_longsword', itemDb);
    assert.ok(placeInContainer(looseQ, looseQuiver, looseQ.rootUid, 0, itemDb).ok);
    assert.ok(placeInContainer(looseQ, looseSword, looseQ.rootUid, 1, itemDb).ok);
    const ontoQuiver = moveItem(
        looseQ,
        { kind: 'container', containerUid: looseQ.rootUid, index: 1 },
        { kind: 'container', containerUid: looseQ.rootUid, index: 0 },
        itemDb
    );
    assert.strictEqual(ontoQuiver.ok, false);
    assert.strictEqual(ontoQuiver.error, 'only_ammo');
    assert.deepStrictEqual(packed(looseQ, looseQ.rootUid).map((s) => s.uid), [looseQuiver, looseSword]);
    assert.deepStrictEqual(packed(looseQ, looseQuiver), []);

    const ammoInv = freshInv();
    const ammoQuiver = createItemInstance(ammoInv, 'quiver', itemDb);
    assert.ok(placeInEquipment(ammoInv, ammoQuiver, 'leftHand', itemDb).ok);
    const burst = createItemInstance(ammoInv, 'burst_arrow', itemDb, { count: 4 });
    const sniper = createItemInstance(ammoInv, 'sniper_arrow', itemDb, { count: 5 });
    assert.ok(placeInContainer(ammoInv, burst, ammoQuiver, 0, itemDb).ok);
    assert.ok(placeInContainer(ammoInv, sniper, ammoInv.rootUid, 0, itemDb).ok);
    const intoQuiver = moveItem(
        ammoInv,
        { kind: 'container', containerUid: ammoInv.rootUid, index: 0 },
        { kind: 'equipment', slot: 'shield' },
        itemDb
    );
    assert.strictEqual(intoQuiver.ok, true);
    assert.strictEqual(ammoInv.equipment.leftHand, ammoQuiver);
    assert.deepStrictEqual(packed(ammoInv, ammoQuiver).map((s) => ({ id: s.id, count: s.count })), [
        { id: 'sniper_arrow', count: 5 },
        { id: 'burst_arrow', count: 4 }
    ]);
    assert.strictEqual(packed(ammoInv, ammoQuiver)[0].index, 0);
    assert.deepStrictEqual(packed(ammoInv, ammoInv.rootUid), []);

    const rightInv = freshInv();
    const rightQuiver = createItemInstance(rightInv, 'quiver', itemDb);
    assert.ok(placeInEquipment(rightInv, rightQuiver, 'leftHand', itemDb).ok);
    const rightArrows = createItemInstance(rightInv, 'sniper_arrow', itemDb, { count: 3 });
    assert.ok(placeInContainer(rightInv, rightArrows, rightInv.rootUid, 0, itemDb).ok);
    const notRetarget = moveItem(
        rightInv,
        { kind: 'container', containerUid: rightInv.rootUid, index: 0 },
        { kind: 'equipment', slot: 'weapon' },
        itemDb
    );
    assert.strictEqual(notRetarget.ok, false);
    assert.strictEqual(notRetarget.error, 'wrong_slot');
    assert.deepStrictEqual(packed(rightInv, rightQuiver), []);
    assert.strictEqual(rightInv.containers[rightInv.rootUid].slots[0], rightArrows);
    assert.strictEqual(rightInv.equipment.leftHand, rightQuiver);

    const swapInv = freshInv();
    const swapGold = createItemInstance(swapInv, 'gold_coin', itemDb, { count: 1 });
    const swapSword = createItemInstance(swapInv, 'iron_longsword', itemDb);
    const swapBow = createItemInstance(swapInv, 'hunter_bow', itemDb);
    assert.ok(placeInContainer(swapInv, swapGold, swapInv.rootUid, 0, itemDb).ok);
    assert.ok(placeInContainer(swapInv, swapSword, swapInv.rootUid, 1, itemDb).ok);
    assert.ok(placeInEquipment(swapInv, swapBow, 'rightHand', itemDb).ok);
    const swapped = moveItem(
        swapInv,
        { kind: 'container', containerUid: swapInv.rootUid, index: 1 },
        { kind: 'equipment', slot: 'rightHand' },
        itemDb
    );
    assert.strictEqual(swapped.ok, true);
    assert.strictEqual(swapInv.equipment.rightHand, swapSword);
    assert.strictEqual(swapInv.containers[swapInv.rootUid].slots[0], swapGold);
    assert.strictEqual(swapInv.containers[swapInv.rootUid].slots[1], swapBow);

    const paper = freshInv();
    const paperQuiver = createItemInstance(paper, 'quiver', itemDb);
    const paperArrow = createItemInstance(paper, 'sniper_arrow', itemDb, { count: 2 });
    const paperShield = createItemInstance(paper, 'wooden_shield', itemDb);
    assert.ok(placeInEquipment(paper, paperQuiver, 'leftHand', itemDb).ok);
    assert.ok(placeInContainer(paper, paperArrow, paperQuiver, 0, itemDb).ok);
    assert.ok(placeInContainer(paper, paperShield, paper.rootUid, 0, itemDb).ok);
    const paperDrop = moveItem(
        paper,
        { kind: 'container', containerUid: paper.rootUid, index: 0 },
        { kind: 'equipment', slot: 'leftHand' },
        itemDb
    );
    assert.strictEqual(paperDrop.ok, true);
    assert.strictEqual(paper.equipment.leftHand, paperShield);
    assert.ok(packed(paper, paperQuiver).every((s) => s.uid !== paperShield));
    assert.deepStrictEqual(packed(paper, paperQuiver).map((s) => s.uid), [paperArrow]);
    assert.strictEqual(paper.items[paperQuiver].location.kind, 'container');

    testContainerDropRefresh();
}

function testContainerDropRefresh() {
    const { testSettings } = require('./helpers');
    const { World } = require('../src/world/world');
    const { GameSession } = require('../src/world/session');
    const { MemoryStore } = require('../src/persist/memory_store');
    const { RateLimiter } = require('../src/security/rate_limit');
    const { createLog } = require('../src/log');
    const { C2S, S2C } = require('../src/protocol/opcodes');
    const { decodeFrame } = require('../src/protocol/frame');
    const {
        encodeContainerSlot,
        encodeMoveItem,
        decodeInventory,
        decodeSay
    } = require('../src/protocol/messages');
    const { createStaticMap } = require('../src/world/static_map');

    function fakeSocket() {
        return {
            readyState: 1,
            sent: [],
            send(buf) { this.sent.push(Buffer.from(buf)); },
            close() { this.readyState = 3; },
            terminate() { this.readyState = 3; }
        };
    }

    function frames(sock, opcode) {
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
        id: 9,
        accountId: 1,
        name: 'drop',
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
    const inv = freshInv();
    const bag = createItemInstance(inv, 'bag', itemDb);
    const shield = createItemInstance(inv, 'wooden_shield', itemDb);
    const sword = createItemInstance(inv, 'iron_longsword', itemDb);
    assert.ok(placeInContainer(inv, bag, inv.rootUid, 0, itemDb).ok);
    assert.ok(placeInContainer(inv, shield, bag, 0, itemDb).ok);
    assert.ok(placeInContainer(inv, sword, inv.rootUid, 1, itemDb).ok);
    session.inventory = inv;
    applyPlayerLoadout(session, itemDb);
    world.sendEnterWorld(session);

    const rootView = decodeInventory(frames(session.socket, S2C.INVENTORY).pop().payload);
    session.socket.sent = [];
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.OPEN_BAG,
        seq: session.nextClientSeq,
        payload: encodeContainerSlot(rootView.containerId, 0)
    }));
    world.step(1);
    assert.strictEqual(session.openBagUid, bag);

    session.socket.sent = [];
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.MOVE_ITEM,
        seq: session.nextClientSeq,
        payload: encodeMoveItem(
            { kind: 'container', containerUid: inv.rootUid, index: 1 },
            { kind: 'container', containerUid: bag, index: 255 },
            0
        )
    }));
    world.step(1);
    const invPkt = decodeInventory(frames(session.socket, S2C.INVENTORY).pop().payload);
    assert.deepStrictEqual(invPkt.slots.map((s) => s.id), ['bag']);
    const bagPkt = frames(session.socket, S2C.BAG)
        .map((f) => decodeInventory(f.payload))
        .filter((v) => v.containerId === bag)
        .pop();
    assert.ok(bagPkt, 'open bag snapshot after the shift');
    assert.deepStrictEqual(bagPkt.slots.map((s) => ({ index: s.index, id: s.id })), [
        { index: 0, id: 'iron_longsword' },
        { index: 1, id: 'wooden_shield' }
    ]);

    const quiver = createItemInstance(inv, 'quiver', itemDb);
    const bow = createItemInstance(inv, 'hunter_bow', itemDb);
    assert.ok(placeInEquipment(inv, quiver, 'leftHand', itemDb).ok);
    assert.ok(placeInEquipment(inv, bow, 'rightHand', itemDb).ok);
    const rejectedSword = createItemInstance(inv, 'iron_longsword', itemDb);
    assert.ok(placeInContainer(inv, rejectedSword, inv.rootUid, null, itemDb).ok);
    const swordLoc = inv.items[rejectedSword].location;
    session.socket.sent = [];
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.MOVE_ITEM,
        seq: session.nextClientSeq,
        payload: encodeMoveItem(
            { kind: 'container', containerUid: swordLoc.containerUid, index: swordLoc.index },
            { kind: 'container', containerUid: quiver, index: 0 },
            0
        )
    }));
    world.step(1);
    const said = frames(session.socket, S2C.SAY).map((f) => decodeSay(f.payload).text);
    assert.ok(said.indexOf('This quiver only holds ammunition.') >= 0);
    assert.deepStrictEqual(packed(inv, quiver), []);
    assert.strictEqual(inv.containers[inv.rootUid].slots[swordLoc.index], rejectedSword);
    assert.strictEqual(inv.equipment.leftHand, quiver);

    world.stop();
}

main();

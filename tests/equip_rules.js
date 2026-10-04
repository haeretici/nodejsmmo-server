'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { createStaticMap } = require('../src/world/static_map');
const { C2S, S2C } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');
const { encodeEquip, decodeInventory } = require('../src/protocol/messages');
const {
    DRESS_DENIED,
    BOTH_HANDS_DENIED,
    planEquipmentAdd,
    penalizedWeaponStats
} = require('../src/world/items');
const {
    createEmptyInventory,
    ensureEquippedBackpack,
    createItemInstance,
    placeInContainer,
    equipItem,
    moveItem,
    applyPlayerLoadout
} = require('../src/world/inventory');

const itemDb = {
    backpack: { id: 'backpack', slot: 'backpack', category: 'container', volume: 20 },
    sword: { id: 'sword', slot: 'rightHand', category: 'sword', weaponType: 'melee', atk: 10 },
    twoh: { id: 'twoh', slot: 'rightHand', category: 'sword', weaponType: 'melee', atk: 20, twoHanded: true },
    bow: { id: 'bow', slot: 'rightHand', category: 'bow', weaponType: 'distance', atk: 15, twoHanded: true },
    xbow: { id: 'xbow', slot: 'rightHand', category: 'crossbow', weaponType: 'distance', twoHanded: true },
    spear: { id: 'spear', slot: 'rightHand', category: 'spear', weaponType: 'distance', atk: 8 },
    shield: { id: 'shield', slot: 'leftHand', category: 'shield', weaponType: 'shield', defense: 20 },
    book: { id: 'book', slot: 'leftHand', category: 'spellbook', defense: 12 },
    quiver: { id: 'quiver', slot: 'leftHand', category: 'quiver', volume: 4 },
    arrow: { id: 'arrow', category: 'ammo', ammoType: 'arrow', stackable: true },
    guard: {
        id: 'guard',
        slot: 'rightHand',
        category: 'sword',
        atk: 30,
        twoHanded: true,
        level: 20,
        vocation: ['guardian']
    },
    armor: {
        id: 'armor',
        slot: 'armor',
        category: 'armor',
        armor: 5,
        level: 8,
        vocation: ['guardian', 'scout']
    },
    heavy: {
        id: 'heavy',
        slot: 'rightHand',
        category: 'axe',
        weaponType: 'melee',
        atk: 100,
        defense: 80,
        level: 100
    },
    split: {
        id: 'split',
        slot: 'rightHand',
        category: 'sword',
        weaponType: 'melee',
        atk: 7,
        extraAtk: 49,
        extraAtkElement: 'earth',
        defense: 32,
        level: 250
    },
    glove: {
        id: 'glove',
        slot: 'rightHand',
        category: 'fist',
        weaponType: 'melee',
        atk: 20,
        defense: 10,
        level: 40
    },
    highbow: {
        id: 'highbow',
        slot: 'rightHand',
        category: 'bow',
        weaponType: 'distance',
        atk: 7,
        twoHanded: true,
        level: 45
    },
    javelin: {
        id: 'javelin',
        slot: 'rightHand',
        category: 'spear',
        weaponType: 'distance',
        atk: 32,
        level: 20
    }
};

function fresh() {
    const inv = createEmptyInventory();
    assert.ok(ensureEquippedBackpack(inv, itemDb));
    return inv;
}

function put(inv, id, count) {
    const uid = createItemInstance(inv, id, itemDb, count != null ? { count: count } : undefined);
    const placed = placeInContainer(inv, uid, inv.rootUid, null, itemDb);
    assert.ok(placed.ok, placed.error);
    return uid;
}

function worn(inv, slot) {
    const uid = inv.equipment[slot];
    return uid ? inv.items[uid].itemId : null;
}

function wear(inv, id, actor) {
    const uid = put(inv, id);
    return { uid: uid, result: equipItem(inv, uid, itemDb, null, actor || null) };
}

function hands(right, left) {
    return { right: right || null, left: left || null };
}

function main() {
    assert.strictEqual(DRESS_DENIED, 'You cannot dress this object there.');
    assert.strictEqual(BOTH_HANDS_DENIED, 'Both hands need to be free.');

    const sword = itemDb.sword;
    const twoh = itemDb.twoh;
    const bow = itemDb.bow;
    const shield = itemDb.shield;
    const quiver = itemDb.quiver;
    const book = itemDb.book;

    assert.strictEqual(planEquipmentAdd(sword, 'rightHand', hands(null, shield), { mode: 'move' }).ok, true);
    assert.strictEqual(planEquipmentAdd(shield, 'leftHand', hands(sword, null), { mode: 'move' }).ok, true);
    assert.strictEqual(planEquipmentAdd(twoh, 'rightHand', hands(null, shield), { mode: 'move' }).error, 'both_hands');
    assert.strictEqual(planEquipmentAdd(twoh, 'weapon', hands(null, shield), { mode: 'equip' }).clearSlot, 'leftHand');
    assert.strictEqual(planEquipmentAdd(twoh, 'rightHand', hands(null, quiver), { mode: 'equip' }).error, 'both_hands');
    assert.strictEqual(planEquipmentAdd(bow, 'rightHand', hands(null, quiver), { mode: 'move' }).ok, true);
    assert.strictEqual(planEquipmentAdd(bow, 'rightHand', hands(null, shield), { mode: 'equip' }).error, 'both_hands');
    assert.strictEqual(planEquipmentAdd(shield, 'shield', hands(bow, null), { mode: 'move' }).error, 'both_hands');
    assert.strictEqual(planEquipmentAdd(quiver, 'leftHand', hands(bow, null), { mode: 'move' }).ok, true);
    assert.strictEqual(planEquipmentAdd(quiver, 'leftHand', hands(bow, null), { mode: 'equip' }).clearSlot, 'rightHand');
    assert.strictEqual(planEquipmentAdd(quiver, 'leftHand', hands(bow, quiver), { mode: 'equip' }).clearSlot, 'leftHand');
    assert.strictEqual(planEquipmentAdd(itemDb.guard, 'rightHand', hands(), {
        mode: 'equip',
        level: 19,
        vocation: 'guardian'
    }).ok, true);
    assert.strictEqual(planEquipmentAdd(itemDb.guard, 'rightHand', hands(), {
        mode: 'equip',
        level: 20,
        vocation: 'scout'
    }).error, 'vocation');
    assert.strictEqual(planEquipmentAdd(itemDb.guard, 'rightHand', hands(), {
        mode: 'equip',
        level: 20,
        vocation: 'Guardian'
    }).ok, true);

    const pair = fresh();
    assert.strictEqual(wear(pair, 'sword').result.ok, true);
    assert.strictEqual(wear(pair, 'shield').result.ok, true);
    assert.strictEqual(worn(pair, 'rightHand'), 'sword');
    assert.strictEqual(worn(pair, 'leftHand'), 'shield');

    const cleared = fresh();
    assert.strictEqual(wear(cleared, 'shield').result.ok, true);
    assert.strictEqual(wear(cleared, 'twoh').result.ok, true);
    assert.strictEqual(worn(cleared, 'rightHand'), 'twoh');
    assert.strictEqual(worn(cleared, 'leftHand'), null);
    assert.ok(Object.values(cleared.items).some((inst) => inst.itemId === 'shield' && inst.location.kind === 'container'));

    const keepQuiver = fresh();
    assert.strictEqual(wear(keepQuiver, 'quiver').result.ok, true);
    const refusedSword = wear(keepQuiver, 'twoh');
    assert.strictEqual(refusedSword.result.error, 'both_hands');
    assert.strictEqual(worn(keepQuiver, 'leftHand'), 'quiver');
    assert.strictEqual(worn(keepQuiver, 'rightHand'), null);

    const bowQuiver = fresh();
    assert.strictEqual(wear(bowQuiver, 'quiver').result.ok, true);
    assert.strictEqual(wear(bowQuiver, 'bow').result.ok, true);
    assert.strictEqual(worn(bowQuiver, 'rightHand'), 'bow');
    assert.strictEqual(worn(bowQuiver, 'leftHand'), 'quiver');

    const bowShield = fresh();
    assert.strictEqual(wear(bowShield, 'shield').result.ok, true);
    const refusedBow = wear(bowShield, 'bow');
    assert.strictEqual(refusedBow.result.error, 'both_hands');
    assert.strictEqual(worn(bowShield, 'rightHand'), null);
    assert.strictEqual(worn(bowShield, 'leftHand'), 'shield');

    const bowThenQuiver = fresh();
    assert.strictEqual(wear(bowThenQuiver, 'bow').result.ok, true);
    assert.strictEqual(wear(bowThenQuiver, 'quiver').result.ok, true);
    assert.strictEqual(worn(bowThenQuiver, 'rightHand'), null);
    assert.strictEqual(worn(bowThenQuiver, 'leftHand'), 'quiver');

    const replaceQuiver = fresh();
    assert.strictEqual(wear(replaceQuiver, 'bow').result.ok, true);
    const firstQuiver = put(replaceQuiver, 'quiver');
    const firstLoc = replaceQuiver.items[firstQuiver].location;
    assert.strictEqual(moveItem(
        replaceQuiver,
        { kind: 'container', containerUid: firstLoc.containerUid, index: firstLoc.index },
        { kind: 'equipment', slot: 'shield' },
        itemDb
    ).ok, true);
    const second = put(replaceQuiver, 'quiver');
    assert.strictEqual(equipItem(replaceQuiver, second, itemDb, 'shield').ok, true);
    assert.strictEqual(worn(replaceQuiver, 'rightHand'), 'bow');
    assert.strictEqual(worn(replaceQuiver, 'leftHand'), 'quiver');
    assert.notStrictEqual(replaceQuiver.equipment.leftHand, firstQuiver);

    const dragQuiver = fresh();
    assert.strictEqual(wear(dragQuiver, 'bow').result.ok, true);
    const looseQuiver = put(dragQuiver, 'quiver');
    const loc = dragQuiver.items[looseQuiver].location;
    const dragged = moveItem(
        dragQuiver,
        { kind: 'container', containerUid: loc.containerUid, index: loc.index },
        { kind: 'equipment', slot: 'shield' },
        itemDb
    );
    assert.strictEqual(dragged.ok, true);
    assert.strictEqual(worn(dragQuiver, 'rightHand'), 'bow');
    assert.strictEqual(worn(dragQuiver, 'leftHand'), 'quiver');

    const dragTwo = fresh();
    assert.strictEqual(wear(dragTwo, 'shield').result.ok, true);
    const looseTwo = put(dragTwo, 'twoh');
    const twoLoc = dragTwo.items[looseTwo].location;
    const draggedTwo = moveItem(
        dragTwo,
        { kind: 'container', containerUid: twoLoc.containerUid, index: twoLoc.index },
        { kind: 'equipment', slot: 'weapon' },
        itemDb
    );
    assert.strictEqual(draggedTwo.error, 'both_hands');
    assert.strictEqual(worn(dragTwo, 'leftHand'), 'shield');
    assert.strictEqual(worn(dragTwo, 'rightHand'), null);

    const spear = fresh();
    assert.strictEqual(wear(spear, 'spear').result.ok, true);
    assert.strictEqual(wear(spear, 'quiver').result.ok, true);
    assert.strictEqual(worn(spear, 'rightHand'), 'spear');
    assert.strictEqual(worn(spear, 'leftHand'), 'quiver');

    const bookHands = fresh();
    assert.strictEqual(wear(bookHands, 'sword').result.ok, true);
    assert.strictEqual(wear(bookHands, 'book').result.ok, true);
    assert.strictEqual(worn(bookHands, 'rightHand'), 'sword');
    assert.strictEqual(worn(bookHands, 'leftHand'), 'book');

    const bookTwo = fresh();
    assert.strictEqual(wear(bookTwo, 'book').result.ok, true);
    assert.strictEqual(wear(bookTwo, 'twoh').result.ok, true);
    assert.strictEqual(worn(bookTwo, 'rightHand'), 'twoh');
    assert.strictEqual(worn(bookTwo, 'leftHand'), null);

    const bookBow = fresh();
    assert.strictEqual(wear(bookBow, 'book').result.ok, true);
    assert.strictEqual(wear(bookBow, 'bow').result.error, 'both_hands');
    assert.strictEqual(worn(bookBow, 'leftHand'), 'book');

    const xbowQuiver = fresh();
    assert.strictEqual(wear(xbowQuiver, 'xbow').result.ok, true);
    const xq = put(xbowQuiver, 'quiver');
    const xLoc = xbowQuiver.items[xq].location;
    assert.strictEqual(moveItem(
        xbowQuiver,
        { kind: 'container', containerUid: xLoc.containerUid, index: xLoc.index },
        { kind: 'equipment', slot: 'leftHand' },
        itemDb
    ).ok, true);
    assert.strictEqual(worn(xbowQuiver, 'rightHand'), 'xbow');
    assert.strictEqual(worn(xbowQuiver, 'leftHand'), 'quiver');

    const low = fresh();
    const lowWear = wear(low, 'guard', { level: 1, vocation: 'guardian' });
    assert.strictEqual(lowWear.result.ok, true);
    assert.strictEqual(worn(low, 'rightHand'), 'guard');
    const wrongClass = fresh();
    assert.strictEqual(wear(wrongClass, 'guard', { level: 40, vocation: 'scout' }).result.error, 'vocation');
    const allowed = fresh();
    assert.strictEqual(wear(allowed, 'guard', { level: 20, vocation: 'guardian' }).result.ok, true);
    assert.strictEqual(worn(allowed, 'rightHand'), 'guard');

    const thinArmor = fresh();
    assert.strictEqual(wear(thinArmor, 'armor', { level: 7, vocation: 'guardian' }).result.error, 'level');
    const scoutArmor = fresh();
    assert.strictEqual(wear(scoutArmor, 'armor', { level: 8, vocation: 'scout' }).result.ok, true);
    assert.strictEqual(worn(scoutArmor, 'armor'), 'armor');

    const ammoInv = fresh();
    assert.strictEqual(wear(ammoInv, 'bow').result.ok, true);
    const ammoQuiver = put(ammoInv, 'quiver');
    const quiverLoc = ammoInv.items[ammoQuiver].location;
    assert.strictEqual(moveItem(
        ammoInv,
        { kind: 'container', containerUid: quiverLoc.containerUid, index: quiverLoc.index },
        { kind: 'equipment', slot: 'shield' },
        itemDb
    ).ok, true);
    const arrows = put(ammoInv, 'arrow', 5);
    const arrowLoc = ammoInv.items[arrows].location;
    assert.strictEqual(moveItem(
        ammoInv,
        { kind: 'container', containerUid: arrowLoc.containerUid, index: arrowLoc.index },
        { kind: 'equipment', slot: 'shield' },
        itemDb
    ).ok, true);
    assert.strictEqual(worn(ammoInv, 'rightHand'), 'bow');
    assert.strictEqual(worn(ammoInv, 'leftHand'), 'quiver');
    assert.strictEqual(ammoInv.containers[ammoQuiver].slots[0], arrows);

    testLevelPenalty();
    testDressMessage();
}

function testLevelPenalty() {
    assert.deepStrictEqual(penalizedWeaponStats(itemDb.heavy, 10), {
        atk: 10, extraAtk: 0, defense: 0, gap: 90
    });
    assert.deepStrictEqual(penalizedWeaponStats(itemDb.heavy, 50), {
        atk: 50, extraAtk: 0, defense: 30, gap: 50
    });
    assert.strictEqual(penalizedWeaponStats(itemDb.heavy, 100), null);
    assert.deepStrictEqual(penalizedWeaponStats(itemDb.split, 202), {
        atk: 1, extraAtk: 7, defense: 0, gap: 48
    });
    assert.deepStrictEqual(penalizedWeaponStats(itemDb.glove, 30), {
        atk: 10, extraAtk: 0, defense: 0, gap: 10
    });
    assert.strictEqual(penalizedWeaponStats(itemDb.highbow, 1), null);
    assert.strictEqual(planEquipmentAdd(itemDb.highbow, 'rightHand', hands(), {
        mode: 'equip',
        level: 1,
        vocation: 'scout'
    }).error, 'level');
    assert.strictEqual(planEquipmentAdd(itemDb.javelin, 'rightHand', hands(), {
        mode: 'equip',
        level: 1
    }).ok, true);

    const wornHeavy = fresh();
    assert.strictEqual(wear(wornHeavy, 'heavy', { level: 10 }).result.ok, true);
    const lowAxe = { inventory: wornHeavy, level: 10, skills: {}, critChance: 0, critDamage: 0 };
    applyPlayerLoadout(lowAxe, itemDb);
    assert.strictEqual(lowAxe.atk, 10);
    assert.strictEqual(lowAxe.extraAtk, 0);

    const wornSplit = fresh();
    assert.strictEqual(wear(wornSplit, 'split', { level: 202 }).result.ok, true);
    const midSword = { inventory: wornSplit, level: 202, skills: {}, critChance: 0, critDamage: 0 };
    applyPlayerLoadout(midSword, itemDb);
    assert.strictEqual(midSword.atk, 1);
    assert.strictEqual(midSword.extraAtk, 7);
    assert.strictEqual(midSword.extraAtkElement, 'earth');

    const wornThrow = fresh();
    assert.strictEqual(wear(wornThrow, 'javelin', { level: 10 }).result.ok, true);
    const thrower = { inventory: wornThrow, level: 10, skills: {}, critChance: 0, critDamage: 0 };
    applyPlayerLoadout(thrower, itemDb);
    assert.strictEqual(thrower.atk, 22);
}

function testDressMessage() {
    const world = new World({
        settings: testSettings(),
        store: new MemoryStore(),
        log: createLog(testSettings()),
        schedule: () => 0,
        clear: () => {},
        map: createStaticMap(),
        pack: { classes: { classes: [{ id: 'guardian', baseRegenHp: 0, baseRegenMp: 0 }] } }
    });
    world._itemDb = itemDb;
    world.start();
    const session = new GameSession({
        socket: {
            readyState: 1,
            sent: [],
            send(buf) { this.sent.push(Buffer.from(buf)); },
            close() { this.readyState = 3; },
            terminate() { this.readyState = 3; }
        },
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter({
        id: 3,
        accountId: 1,
        name: 'wear',
        vocation: 'guardian',
        level: 1,
        experience: 0,
        hp: 150,
        hpMax: 150,
        mp: 50,
        mpMax: 50,
        townId: 1
    }, world.spawnPos({ townId: 1 }));
    assert.ok(world.add(session));
    session.inventory = fresh();
    const uid = put(session.inventory, 'guard');
    const loc = session.inventory.items[uid].location;
    session.socket.sent = [];
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.EQUIP,
        seq: 1,
        payload: encodeEquip(loc.containerUid, loc.index, 'weapon')
    }));
    world.step(1);
    const said = session.socket.sent.map((buf) => decodeFrame(buf)).filter((f) => f.opcode === S2C.SAY);
    assert.strictEqual(said.length, 0);
    const view = session.socket.sent.map((buf) => decodeFrame(buf)).filter((f) => f.opcode === S2C.INVENTORY);
    if (view.length) decodeInventory(view[view.length - 1].payload);
    assert.strictEqual(worn(session.inventory, 'rightHand'), 'guard');
    assert.strictEqual(session.atk, 11);
    world.stop();
}

main();

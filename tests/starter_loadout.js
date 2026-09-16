'use strict';

const assert = require('assert');
const { loadPack, resolveContentPath } = require('../src/content/load_pack');
const { testSettings, request, withHttp, SERVER_ROOT } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { S2C } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');
const { decodeEquipment } = require('../src/protocol/messages');
const { itemDbFromPack, findItem } = require('../src/world/items');
const {
    applyPlayerLoadout,
    applyStarterLoadout,
    buildStarterInventory,
    countItem,
    equippedRightHandItem,
    equippedLeftHandItem,
    getStackCount,
    normalizeInventory,
    peekAmmoForShot,
    serializeInventory
} = require('../src/world/inventory');

function skills() {
    return {
        fist: 10, club: 10, sword: 10, axe: 10,
        distance: 10, shielding: 10, magic: 0, fishing: 10
    };
}

function sessionFor(inv, itemDb) {
    const session = {
        inventory: inv,
        skills: skills(),
        critChance: 0,
        critDamage: 0
    };
    applyPlayerLoadout(session, itemDb);
    return session;
}

function equippedId(inv, slot) {
    const uid = inv.equipment && inv.equipment[slot];
    const inst = uid && inv.items[uid];
    return inst ? inst.itemId : null;
}

function quiverArrowCount(inv) {
    const qUid = inv.equipment && inv.equipment.leftHand;
    if (!qUid || !inv.containers[qUid]) return 0;
    let n = 0;
    const slots = inv.containers[qUid].slots;
    for (let i = 0; i < slots.length; i++) {
        const uid = slots[i];
        const inst = uid && inv.items[uid];
        if (inst && inst.itemId === 'simple_arrow') n += getStackCount(inst);
    }
    return n;
}

function assertNoL50(inv) {
    const ids = Object.keys(inv.items).map((uid) => inv.items[uid] && inv.items[uid].itemId);
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        assert.ok(id !== 'hunter_bow', 'no L50 hunter_bow');
        assert.ok(id !== 'nunchaku', 'no L50 nunchaku');
        assert.ok(id !== 'steel_plate', 'no L50 steel_plate');
        assert.ok(id !== 'iron_longsword', 'no L50 iron_longsword');
    }
}

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

async function main() {
    const pack = loadPack(resolveContentPath({ contentPath: '../content' }, SERVER_ROOT));
    const itemDb = itemDbFromPack(pack);
    const starters = pack.starters;
    assert.ok(starters);
    assert.ok(findItem(itemDb, 'dagger'));
    assert.ok(findItem(itemDb, 'simple_arrow'));
    assert.ok(findItem(itemDb, 'scorcher_wand'));

    const empty = buildStarterInventory('guardian', itemDb, null);
    assert.strictEqual(equippedId(empty, 'backpack'), 'backpack');
    assert.ok(!equippedId(empty, 'rightHand'));

    const guardian = buildStarterInventory('guardian', itemDb, starters);
    assert.strictEqual(equippedId(guardian, 'rightHand'), 'dagger');
    assert.strictEqual(equippedId(guardian, 'leftHand'), 'wooden_shield');
    assert.strictEqual(equippedId(guardian, 'helmet'), 'leather_helmet');
    assert.strictEqual(equippedId(guardian, 'armor'), 'jacket');
    assert.strictEqual(equippedId(guardian, 'legs'), 'leather_legs');
    assert.strictEqual(equippedId(guardian, 'boots'), 'leather_boots');
    assert.strictEqual(equippedId(guardian, 'backpack'), 'backpack');
    assert.strictEqual(countItem(guardian, 'small_health_potion'), 10);
    assert.strictEqual(countItem(guardian, 'mana_potion'), 2);
    assert.strictEqual(countItem(guardian, 'meat'), 1);
    const gLoad = sessionFor(guardian, itemDb);
    assert.notStrictEqual(gLoad.weaponType, 'fist');
    assert.strictEqual(equippedRightHandItem(guardian, itemDb).id, 'dagger');
    assertNoL50(guardian);

    const adventurer = buildStarterInventory('adventurer', itemDb, starters);
    assert.strictEqual(equippedId(adventurer, 'rightHand'), 'dagger');
    assert.strictEqual(equippedId(adventurer, 'leftHand'), 'wooden_shield');
    assert.strictEqual(countItem(adventurer, 'small_health_potion'), 10);

    const scout = buildStarterInventory('scout', itemDb, starters);
    assert.strictEqual(equippedId(scout, 'rightHand'), 'bow');
    assert.strictEqual(equippedId(scout, 'leftHand'), 'quiver');
    assert.ok(scout.containers[scout.equipment.leftHand], 'quiver stays a nested container');
    assert.strictEqual(quiverArrowCount(scout), 100);
    assert.strictEqual(countItem(scout, 'simple_arrow'), 0, 'arrows are not loose bag spam');
    const ammo = peekAmmoForShot(scout, itemDb);
    assert.ok(ammo);
    assert.strictEqual(ammo.id, 'simple_arrow');
    const sLoad = sessionFor(scout, itemDb);
    assert.strictEqual(sLoad.weaponType, 'distance');
    assert.ok(sLoad.atk > 7);
    assertNoL50(scout);

    const mystic = buildStarterInventory('mystic', itemDb, starters);
    assert.strictEqual(equippedId(mystic, 'rightHand'), 'light_jo_staff');
    const mLoad = sessionFor(mystic, itemDb);
    assert.notStrictEqual(mLoad.weaponType, 'fist');
    assert.ok(!equippedId(mystic, 'leftHand'), 'two-handed staff leaves left hand empty');

    const warden = buildStarterInventory('warden', itemDb, starters);
    assert.strictEqual(equippedId(warden, 'rightHand'), 'frostbite_wand');
    assert.strictEqual(equippedId(warden, 'leftHand'), 'novice_spellbook');
    const wLoad = sessionFor(warden, itemDb);
    assert.strictEqual(wLoad.weaponType, 'magic');
    assert.strictEqual(equippedRightHandItem(warden, itemDb).weaponType, 'magic');

    const adept = buildStarterInventory('adept', itemDb, starters);
    assert.strictEqual(equippedId(adept, 'rightHand'), 'scorcher_wand');
    assert.strictEqual(equippedId(adept, 'leftHand'), 'novice_spellbook');
    const aLoad = sessionFor(adept, itemDb);
    assert.strictEqual(aLoad.weaponType, 'magic');
    assert.strictEqual(equippedRightHandItem(adept, itemDb).weaponType, 'magic');
    assert.ok(itemIsMagicFromLoadout(adept, itemDb));

    const relog = normalizeInventory(serializeInventory(scout), itemDb);
    assert.strictEqual(equippedId(relog, 'rightHand'), 'bow');
    assert.strictEqual(quiverArrowCount(relog), 100);
    assert.ok(peekAmmoForShot(relog, itemDb));
    const relogLoad = sessionFor(relog, itemDb);
    assert.strictEqual(relogLoad.weaponType, 'distance');

    const reused = buildStarterInventory('guardian', itemDb, starters);
    applyStarterLoadout(reused, 'guardian', itemDb, starters);
    assert.strictEqual(equippedId(reused, 'rightHand'), 'dagger');

    const settings = testSettings();
    delete settings.spawns;
    delete settings.npcs;
    const store = new MemoryStore();
    const world = new World({
        settings,
        store,
        log: createLog(settings),
        pack,
        schedule: () => 0,
        clear: () => {}
    });

    await withHttp(async ({ port, store: httpStore }) => {
        const reg = await request(port, {
            method: 'POST',
            path: '/v1/register',
            body: { email: 'starter@example.com', password: 'correct-horse' }
        });
        assert.strictEqual(reg.status, 201);
        const cookie = `sid=${reg.sid}`;

        async function createVoc(name, vocation) {
            const created = await request(port, {
                method: 'POST',
                path: '/v1/characters',
                cookie,
                body: { name, vocation }
            });
            assert.strictEqual(created.status, 201, name);
            const state = await httpStore.loadCharacterState(created.json.id);
            const inv = normalizeInventory(state.inventory, world.itemDb());
            const session = new GameSession({
                socket: fakeSocket(),
                ip: '127.0.0.1',
                world,
                settings,
                limiter: new RateLimiter(),
                log: world.log
            });
            const ch = await httpStore.findCharacter(reg.json.id, created.json.id);
            session.bindCharacter(ch, world.spawnPos(ch), {
                state,
                skills: await httpStore.loadSkills(created.json.id)
            });
            return { inv, session, id: created.json.id };
        }

        const g = await createVoc('Guard', 'guardian');
        assert.strictEqual(equippedId(g.inv, 'rightHand'), 'dagger');
        assert.strictEqual(equippedId(g.inv, 'leftHand'), 'wooden_shield');
        assert.strictEqual(g.session.weaponType, 'melee');
        assert.notStrictEqual(g.session.weaponSkill, 'fist');
        assert.strictEqual(countItem(g.inv, 'small_health_potion'), 10);

        const sc = await createVoc('Robin', 'scout');
        assert.strictEqual(equippedId(sc.inv, 'rightHand'), 'bow');
        assert.strictEqual(quiverArrowCount(sc.inv), 100);
        assert.ok(peekAmmoForShot(sc.session.inventory, world.itemDb()));
        assert.strictEqual(sc.session.weaponType, 'distance');

        const my = await createVoc('Monk', 'mystic');
        assert.strictEqual(equippedId(my.inv, 'rightHand'), 'light_jo_staff');
        assert.notStrictEqual(my.session.weaponType, 'fist');

        const ad = await createVoc('Mage', 'adept');
        assert.strictEqual(equippedId(ad.inv, 'rightHand'), 'scorcher_wand');
        assert.strictEqual(ad.session.weaponType, 'magic');
        assert.strictEqual(equippedRightHandItem(ad.session.inventory, world.itemDb()).weaponType, 'magic');

        const wd = await createVoc('Druid', 'warden');
        assert.strictEqual(equippedId(wd.inv, 'rightHand'), 'frostbite_wand');
        assert.strictEqual(wd.session.weaponType, 'magic');

        const av = await createVoc('Rook', 'adventurer');
        assert.strictEqual(equippedId(av.inv, 'rightHand'), 'dagger');

        world.rng = () => 0.5;

        function enterKit(row, expectWeapon) {
            row.session.socket.sent.length = 0;
            assert.ok(world.add(row.session), expectWeapon + ' enter');
            world.sendEnterWorld(row.session);
            const eqFrame = lastOf(row.session.socket, S2C.EQUIPMENT);
            assert.ok(eqFrame, expectWeapon + ' EQUIPMENT');
            const eq = decodeEquipment(eqFrame.payload);
            assert.ok(eq.slots.some((s) => s.slot === 'weapon' && s.id === expectWeapon), expectWeapon);
            return eq;
        }

        function dummyNear(session, id) {
            return {
                id,
                type: 'creature',
                name: 'rat',
                x: 79,
                y: 99,
                z: 6,
                hp: 40,
                hpMax: 40,
                armor: 0,
                mitigation: 0,
                resists: { physical: 0, fire: 0 },
                dead: false,
                downed: false
            };
        }

        function parkForSwing(session) {
            session.x = 77;
            session.y = 99;
            session.z = 6;
            session.attackReadyTick = 0;
        }

        enterKit(g, 'dagger');
        world.leave(g.session);

        enterKit(sc, 'bow');
        const scoutTile = { x: sc.session.x, y: sc.session.y, z: sc.session.z };
        parkForSwing(sc.session);
        const ratScout = dummyNear(sc.session, 9001);
        world.creatures.set(ratScout.id, ratScout);
        assert.ok(world.trySwing(sc.session, ratScout, 1), 'scout distance auto fires');
        world.creatures.delete(ratScout.id);
        sc.session.x = scoutTile.x;
        sc.session.y = scoutTile.y;
        sc.session.z = scoutTile.z;
        world.leave(sc.session);

        enterKit(ad, 'scorcher_wand');
        const adeptTile = { x: ad.session.x, y: ad.session.y, z: ad.session.z };
        parkForSwing(ad.session);
        const ratAdept = dummyNear(ad.session, 9002);
        world.creatures.set(ratAdept.id, ratAdept);
        assert.ok(world.trySwing(ad.session, ratAdept, 1), 'adept wand_auto fires');
        world.creatures.delete(ratAdept.id);
        ad.session.x = adeptTile.x;
        ad.session.y = adeptTile.y;
        ad.session.z = adeptTile.z;
        world.leave(ad.session);

        const persisted = await httpStore.loadCharacterState(g.id);
        const persistedInv = normalizeInventory(persisted.inventory, world.itemDb());
        assert.strictEqual(equippedId(persistedInv, 'rightHand'), 'dagger');
        assert.strictEqual(equippedId(persistedInv, 'leftHand'), 'wooden_shield');
        assert.strictEqual(countItem(persistedInv, 'small_health_potion'), 10);
    }, { world, store, settings, limits: { maxCharsPerAccount: 8 } });

    world.stop();
    console.log('ok starter_loadout');
}

function itemIsMagicFromLoadout(inv, itemDb) {
    const right = equippedRightHandItem(inv, itemDb);
    const left = equippedLeftHandItem(inv, itemDb);
    return !!(right && right.weaponType === 'magic' && left);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

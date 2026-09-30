'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C, DIR, REASON, OPEN_BAG_SELF_INDEX } = require('../src/protocol/opcodes');
const { encodeFrame, decodeFrames } = require('../src/protocol/frame');
const {
    encodeBrowseFieldTile,
    encodeBrowseField,
    decodeBrowseField,
    decodeGround,
    decodeReject,
    encodeGround,
    encodeContainerSlot
} = require('../src/protocol/messages');
const { itemDbFromPack } = require('../src/world/items');
const { createItemInstance } = require('../src/world/inventory');
const {
    MAX_GROUND_RENDER,
    BROWSE_FIELD_MAX,
    createGroundStore,
    pushToTileStack,
    browseFieldSlots,
    visibleGroundSlots,
    tileKey
} = require('../src/world/ground_items');
const { deployFieldToTile, getFieldOnTile, removeFieldFromTile, FIELD_KINDS } = require('../src/world/fields');
const { normalizeWorldPin, makeWorldPinInstance } = require('../src/world/world_pins');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function framesOf(sock) {
    const out = [];
    const sent = sock && sock.sent ? sock.sent : [];
    for (let i = 0; i < sent.length; i++) {
        const part = decodeFrames(sent[i]);
        for (let j = 0; j < part.length; j++) out.push(part[j]);
    }
    return out;
}

function ofOpcode(sock, opcode) {
    return framesOf(sock).filter((f) => f.opcode === opcode);
}

function skills() {
    return { fist: 10, club: 10, sword: 10, axe: 10, distance: 10, shielding: 10, magic: 0, fishing: 10 };
}

function lay(ground, itemId, x, y, z) {
    const uid = createItemInstance(ground.inventory, itemId, null, { count: 1 });
    pushToTileStack(ground, uid, x, y, z);
    return uid;
}

function capUnit() {
    assert.strictEqual(MAX_GROUND_RENDER, 10);
    assert.strictEqual(BROWSE_FIELD_MAX, 255);
    assert.ok(!Object.keys(C2S).some((k) => C2S[k] === 17));
    const ground = createGroundStore();
    const x = 3;
    const y = 4;
    const z = 1;
    let topUid = null;
    for (let i = 0; i < 256; i++) {
        topUid = lay(ground, 'cap_' + i, x, y, z);
    }
    const drawn = visibleGroundSlots(ground, x, y, z);
    const full = browseFieldSlots(ground, x, y, z, null);
    assert.strictEqual(drawn.length, 10);
    assert.strictEqual(full.length, 255);
    assert.strictEqual(full[0].uid, topUid);
    assert.strictEqual(full[0].id, 'cap_255');
    assert.strictEqual(full[0].stackIndex, 0);
    assert.strictEqual(full[254].id, 'cap_1');
    assert.strictEqual(full[254].stackIndex, 254);
    assert.ok(!full.some((s) => s.id === 'cap_0'));
    const wire = decodeBrowseField(encodeBrowseField({ x, y, z, slots: full }));
    assert.strictEqual(wire.n, 255);
    assert.strictEqual(wire.slots[0].uid, topUid);
    const packed = Buffer.concat([
        encodeFrame(S2C.BROWSE_FIELD, 1, encodeBrowseField({ x, y, z, slots: full.slice(0, 2) })),
        encodeFrame(S2C.GROUND, 2, encodeGround(drawn[0]))
    ]);
    const split = decodeFrames(packed);
    assert.strictEqual(split.length, 2);
    assert.strictEqual(split[0].opcode, S2C.BROWSE_FIELD);
    assert.strictEqual(split[1].opcode, S2C.GROUND);
    assert.strictEqual(decodeGround(split[1].payload).uid, drawn[0].uid);
}

function placeOnRun(world, session) {
    const tileMap = world.tileMap;
    const z = session.z | 0;
    const layer = tileMap.getLayer(z);
    if (!layer) return null;
    for (let y = 0; y < layer.rows; y++) {
        for (let x = 0; x < layer.cols - 2; x++) {
            let open = true;
            for (let dx = 0; dx < 3; dx++) {
                const tx = x + dx;
                if (!tileMap.isWalkable(tx, y, z)) { open = false; break; }
                if (tileMap.getStair(tx, y, z)) { open = false; break; }
                if (world.worldPinAt(tx, y, z)) { open = false; break; }
            }
            if (!open) continue;
            if (tileMap.moveEntityToTile(x, y, z, session)) return { x, y, z };
        }
    }
    return null;
}

async function boot() {
    const itemDb = itemDbFromPack(null);
    itemDb.bf_satchel = { id: 'bf_satchel', category: 'container', volume: 4 };
    const settings = testSettings();
    const store = new MemoryStore();
    const acc = await store.createAccount({ email: 'browse@example.com', passwordHash: 'phc' });
    const ch = await store.createCharacter({
        accountId: acc.id,
        name: 'Browser',
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
    return { world, session, itemDb, ch };
}

async function main() {
    capUnit();
    const { world, session, ch } = await boot();
    try {
        const spot = placeOnRun(world, session);
        assert.ok(spot, 'need three walkable tiles in a row');
        const x = spot.x;
        const y = spot.y;
        const z = spot.z;
        const key = tileKey(x, y, z);
        const ids = [];
        function push(id) {
            const uid = lay(world.ground, id, x, y, z);
            ids.push({ id, uid });
            return uid;
        }
        const bottomUid = push('bf_0');
        push('bf_1');
        const satchelUid = push('bf_satchel');
        assert.strictEqual(world.ground.inventory.containers[satchelUid], undefined);
        for (let i = 2; i <= 10; i++) push('bf_' + i);
        assert.strictEqual(ids.length, 12);

        deployFieldToTile(world.fieldStore, x, y, z, { kind: FIELD_KINDS.FIRE, durationSec: 100 });
        assert.ok(getFieldOnTile(world.fieldStore, x, y, z));
        world.corpses.set(4242, {
            id: 4242,
            x, y, z,
            name: 'Rat',
            items: [{ id: 'rat_meat', count: 1 }]
        });
        const pin = normalizeWorldPin({
            id: 'bf-chest',
            kind: 'container',
            catalogId: 'wooden_chest',
            x, y, z,
            blocking: false,
            items: [{ id: 'pin_coin', count: 1 }]
        });
        assert.ok(pin);
        world.indexWorldPin(makeWorldPinInstance(pin, 900001));
        assert.ok(world.worldPinAt(x, y, z));

        session.socket.sent = [];
        world.broadcastGroundTile(x, y, z);
        const drawn = ofOpcode(session.socket, S2C.GROUND).map((f) => decodeGround(f.payload));
        assert.strictEqual(drawn.length, MAX_GROUND_RENDER);
        assert.strictEqual(drawn[0].id, 'bf_10');
        assert.strictEqual(drawn[0].stackIndex, 0);
        assert.ok(!drawn.some((s) => s.uid === bottomUid));

        let seq = 1;
        function send(opcode, payload) {
            session.moveReadyTick = 0;
            session.socket.sent = [];
            assert.ok(world.enqueueIntent(session, { opcode, seq, payload }));
            seq += 1;
            world.step(seq);
        }
        function browse(tx, ty, tz) {
            send(C2S.BROWSE_FIELD, encodeBrowseFieldTile(tx, ty, tz));
            const got = ofOpcode(session.socket, S2C.BROWSE_FIELD);
            assert.strictEqual(got.length, 1);
            return decodeBrowseField(got[0].payload);
        }
        function watching(tx, ty, tz) {
            return !!(session.browseTiles && session.browseTiles[tileKey(tx, ty, tz)]);
        }

        const snap = browse(x, y, z);
        assert.strictEqual(snap.x, x);
        assert.strictEqual(snap.y, y);
        assert.strictEqual(snap.z, z);
        assert.strictEqual(snap.n, 12);
        assert.strictEqual(snap.slots[0].id, 'bf_10');
        assert.strictEqual(snap.slots[0].stackIndex, 0);
        assert.strictEqual(snap.slots[11].id, 'bf_0');
        assert.strictEqual(snap.slots[11].uid, bottomUid);
        assert.strictEqual(snap.slots[11].stackIndex, 11);
        const satchel = snap.slots.find((s) => s.uid === satchelUid);
        assert.ok(satchel);
        assert.strictEqual(satchel.flags, 1);
        for (let i = 0; i < snap.slots.length; i++) {
            if (snap.slots[i].uid !== satchelUid) assert.strictEqual(snap.slots[i].flags, 0);
            assert.ok(snap.slots[i].id.indexOf('bf_') === 0);
        }
        assert.ok(watching(x, y, z));
        removeFieldFromTile(world.fieldStore, x, y, z);

        session.socket.sent = [];
        lay(world.ground, 'bf_extra', x, y, z);
        world.broadcastGroundTile(x, y, z);
        const refreshed = ofOpcode(session.socket, S2C.BROWSE_FIELD);
        assert.strictEqual(refreshed.length, 1);
        const again = decodeBrowseField(refreshed[0].payload);
        assert.strictEqual(again.n, 13);
        assert.strictEqual(again.slots[0].id, 'bf_extra');
        assert.strictEqual(again.slots[0].stackIndex, 0);
        assert.strictEqual(again.slots[1].id, 'bf_10');
        assert.ok(watching(x, y, z));
        assert.strictEqual(ofOpcode(session.socket, S2C.GROUND).length, MAX_GROUND_RENDER);

        send(C2S.BROWSE_FIELD_CLOSE, encodeBrowseFieldTile(x, y, z));
        assert.strictEqual(ofOpcode(session.socket, S2C.BROWSE_FIELD).length, 0);
        assert.ok(!watching(x, y, z));
        session.socket.sent = [];
        lay(world.ground, 'bf_after_close', x, y, z);
        world.broadcastGroundTile(x, y, z);
        assert.strictEqual(ofOpcode(session.socket, S2C.BROWSE_FIELD).length, 0);

        const ey = y + 1;
        delete world.ground.stacks[tileKey(x, ey, z)];
        const empty = browse(x, ey, z);
        assert.strictEqual(empty.n, 0);
        assert.strictEqual(empty.x, x);
        assert.strictEqual(empty.y, ey);
        assert.ok(!watching(x, ey, z));
        session.socket.sent = [];
        lay(world.ground, 'bf_late', x, ey, z);
        world.broadcastGroundTile(x, ey, z);
        assert.strictEqual(ofOpcode(session.socket, S2C.BROWSE_FIELD).length, 0);

        send(C2S.BROWSE_FIELD, encodeBrowseFieldTile(x + 4, y, z));
        assert.strictEqual(ofOpcode(session.socket, S2C.BROWSE_FIELD).length, 0);
        const far = ofOpcode(session.socket, S2C.REJECT);
        assert.strictEqual(far.length, 1);
        assert.strictEqual(decodeReject(far[0].payload).reason, REASON.OUT_OF_RANGE);
        assert.ok(!watching(x + 4, y, z));

        send(C2S.BROWSE_FIELD, encodeBrowseFieldTile(x, y, z + 1));
        assert.strictEqual(ofOpcode(session.socket, S2C.BROWSE_FIELD).length, 0);
        assert.strictEqual(decodeReject(ofOpcode(session.socket, S2C.REJECT)[0].payload).reason, REASON.OUT_OF_RANGE);

        const back = browse(x, y, z);
        assert.ok(back.n >= 14);
        assert.ok(watching(x, y, z));
        const piled = (world.ground.stacks[key] || []).slice();
        session.socket.sent = [];
        world.ground.stacks[key] = [];
        world.broadcastGroundTile(x, y, z, piled);
        const cleared = ofOpcode(session.socket, S2C.BROWSE_FIELD);
        assert.strictEqual(cleared.length, 1);
        assert.strictEqual(decodeBrowseField(cleared[0].payload).n, 0);
        assert.ok(!watching(x, y, z));
        session.socket.sent = [];
        lay(world.ground, 'bf_refill', x, y, z);
        world.broadcastGroundTile(x, y, z);
        assert.strictEqual(ofOpcode(session.socket, S2C.BROWSE_FIELD).length, 0);
        assert.strictEqual(ofOpcode(session.socket, S2C.GROUND).length, 1);

        browse(x, y, z);
        assert.ok(watching(x, y, z));
        session.z = z + 1;
        world.dropBrowseWatchesOutOfRange(session);
        assert.ok(!watching(x, y, z));
        session.z = z;

        const held = browse(x, y, z);
        assert.strictEqual(held.n, 1);
        assert.ok(watching(x, y, z));
        send(C2S.MOVE_STEP, Buffer.from([DIR.E]));
        assert.strictEqual(session.x, x + 1);
        assert.strictEqual(session.z, z);
        assert.ok(watching(x, y, z));
        assert.strictEqual(ofOpcode(session.socket, S2C.BROWSE_FIELD).length, 0);
        send(C2S.MOVE_STEP, Buffer.from([DIR.E]));
        assert.strictEqual(session.x, x + 2);
        assert.ok(!watching(x, y, z));
        session.socket.sent = [];
        lay(world.ground, 'bf_away', x, y, z);
        world.broadcastGroundTile(x, y, z);
        assert.strictEqual(ofOpcode(session.socket, S2C.BROWSE_FIELD).length, 0);

        send(C2S.MOVE_STEP, Buffer.from([DIR.W]));
        assert.strictEqual(session.x, x + 1);
        assert.strictEqual(ofOpcode(session.socket, S2C.BROWSE_FIELD).length, 0);
        assert.ok(!watching(x, y, z));
        send(C2S.MOVE_STEP, Buffer.from([DIR.W]));
        assert.strictEqual(session.x, x);
        assert.strictEqual(ofOpcode(session.socket, S2C.BROWSE_FIELD).length, 0);
        session.socket.sent = [];
        lay(world.ground, 'bf_returned', x, y, z);
        world.broadcastGroundTile(x, y, z);
        assert.strictEqual(ofOpcode(session.socket, S2C.BROWSE_FIELD).length, 0);

        const reopened = browse(x, y, z);
        assert.ok(reopened.n >= 3);
        assert.ok(watching(x, y, z));
        session.socket.sent = [];
        lay(world.ground, 'bf_live', x, y, z);
        world.broadcastGroundTile(x, y, z);
        const live = ofOpcode(session.socket, S2C.BROWSE_FIELD);
        assert.strictEqual(live.length, 1);
        assert.strictEqual(decodeBrowseField(live[0].payload).slots[0].id, 'bf_live');

        send(C2S.BROWSE_FIELD, encodeBrowseFieldTile(x, y, z));
        assert.ok(watching(x, y, z));
        session.kick(REASON.LOGOUT);
        assert.strictEqual(Object.keys(session.browseTiles).length, 0);
        assert.ok(!world.players.has(ch.id));
        session.socket.sent = [];
        lay(world.ground, 'bf_logout', x, y, z);
        world.broadcastGroundTile(x, y, z);
        assert.strictEqual(ofOpcode(session.socket, S2C.BROWSE_FIELD).length, 0);
    } finally {
        world.stop();
    }
    await groundUse();
    console.log('ok browse_field');
}

async function groundUse() {
    const { world, session } = await boot();
    try {
        world._itemDb.bf_potion = {
            id: 'bf_potion',
            category: 'potion',
            stackable: true,
            consumable: true,
            usable: true,
            weight: 10,
            heal: [10, 10]
        };
        world._itemDb.bf_helm = {
            id: 'bf_helm',
            category: 'helmet',
            slot: 'helmet',
            armor: 1,
            weight: 10
        };
        const spot = placeOnRun(world, session);
        assert.ok(spot, 'need a walkable tile');
        const uid = lay(world.ground, 'bf_potion', spot.x, spot.y, spot.z);
        session.hp = 40;
        if (session.character) session.character.hp = 40;
        let seq = 1;
        function send(opcode, payload) {
            session.moveReadyTick = 0;
            session.socket.sent = [];
            assert.ok(world.enqueueIntent(session, { opcode, seq, payload }));
            seq += 1;
            world.step(seq);
        }
        send(C2S.USE_ITEM, encodeContainerSlot(uid, OPEN_BAG_SELF_INDEX));
        assert.ok((session.hp | 0) >= 50, 'potion heals in place');
        assert.ok((session.hp | 0) <= 60, 'one step does not add a second potion');
        assert.ok(!world.ground.inventory.items[uid]);
        assert.ok(!(world.ground.stacks[tileKey(spot.x, spot.y, spot.z)] || []).includes(uid));

        const farUid = lay(world.ground, 'bf_potion', spot.x + 4, spot.y, spot.z);
        const hpFar = session.hp | 0;
        send(C2S.USE_ITEM, encodeContainerSlot(farUid, OPEN_BAG_SELF_INDEX));
        const rejected = ofOpcode(session.socket, S2C.REJECT);
        assert.strictEqual(rejected.length, 1);
        assert.strictEqual(decodeReject(rejected[0].payload).reason, REASON.OUT_OF_RANGE);
        assert.ok(world.ground.inventory.items[farUid]);
        assert.ok((session.hp | 0) < hpFar + 10);

        const helmUid = lay(world.ground, 'bf_helm', spot.x, spot.y, spot.z);
        send(C2S.USE_ITEM, encodeContainerSlot(helmUid, OPEN_BAG_SELF_INDEX));
        const worn = session.inventory.equipment.helmet;
        assert.ok(worn);
        assert.strictEqual(session.inventory.items[worn].itemId, 'bf_helm');
        assert.ok(!world.ground.inventory.items[helmUid]);
    } finally {
        world.stop();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C, REASON } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');
const {
    encodeUseTile,
    encodeUseItemWith,
    decodeUseTile,
    decodeUseItemWith,
    decodeWorldPin,
    decodeSay,
    decodeInventory,
    decodeReject,
    decodeMove,
    decodeStats,
    decodeContainer,
    decodeItemGain
} = require('../src/protocol/messages');
const { createStaticMap, TILE } = require('../src/world/static_map');
const { FRICTION_BLOCKED, TILE_FLAG_ROPE_SPOT, TILE_FLAG_SHOVEL_SPOT } = require('../src/world/tilemap');
const { stackItem, countItem } = require('../src/world/inventory');
const { getStorage } = require('../src/world/npc');
const {
    normalizeWorldPin,
    normalizeWorldList,
    seedWorldPinInstances
} = require('../src/world/world_pins');
const { useWorldHarvest, useWorldToolWith, onWorldPinStep } = require('../src/world/world_pin_actions');
const { loadPack, resolveContentPath, runtimeMap } = require('../src/content/load_pack');
const { SERVER_ROOT } = require('../src/config/load_settings');

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

function twoFloorMap() {
    const map = createStaticMap();
    const n = map.width * map.height;
    const friction0 = new Uint8Array(n);
    const friction1 = new Uint8Array(n);
    const flags0 = new Uint8Array(n);
    const flags1 = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const id = map.tiles[i];
        const walk = id !== TILE.WALL && id !== TILE.WATER && id !== TILE.VOID;
        friction0[i] = walk ? 100 : FRICTION_BLOCKED;
        friction1[i] = walk ? 100 : FRICTION_BLOCKED;
    }
    map.zMin = 0;
    map.zMax = 1;
    map.floors = {
        0: { friction: friction0, flags: flags0 },
        1: { friction: friction1, flags: flags1 }
    };
    return map;
}

function makeWorld(extra, map) {
    const settings = testSettings();
    if (extra) Object.assign(settings, extra);
    const world = new World({
        settings,
        store: extra && extra.store ? extra.store : new MemoryStore(),
        log: createLog(settings),
        map: map || undefined,
        schedule: () => 0,
        clear: () => {}
    });
    world.start();
    return world;
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

function makeSession(world, pos, extras) {
    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter(ash(1), pos || world.spawnPos(ash(1)), extras);
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    world.syncAppears(session);
    return session;
}

function main() {
    assert.strictEqual(C2S.USE, 14);
    assert.strictEqual(C2S.USE_ITEM_WITH, 15);
    assert.strictEqual(S2C.WORLD_PIN, 125);
    const tile = decodeUseTile(encodeUseTile(62, 138, 7));
    assert.strictEqual(tile.x, 62);
    assert.strictEqual(tile.y, 138);
    assert.strictEqual(tile.z, 7);
    const withTool = decodeUseItemWith(encodeUseItemWith({
        x: 99, y: 195, z: 7, itemId: 'shovel'
    }));
    assert.strictEqual(withTool.itemId, 'shovel');

    const herbRaw = {
        id: 'harvest_7_62_138',
        kind: 'harvest',
        catalogId: 'abandoned_flower_patch',
        catalogKind: 'objects',
        x: 62,
        y: 138,
        z: 7,
        blocking: false,
        pickupable: false,
        shared: false,
        once: { storage: 'firstlight.morris.herbs', eq: 1 },
        give: [],
        set: { 'firstlight.morris.herbs': 2 }
    };
    const herb = normalizeWorldPin(herbRaw);
    assert.strictEqual(herb.kind, 'harvest');
    assert.strictEqual(herb.shared, false);
    assert.strictEqual(herb.once.storage, 'firstlight.morris.herbs');
    assert.strictEqual(herb.once.eq, 1);

    const amulet = normalizeWorldPin({
        id: 'harvest_7_99_195',
        kind: 'harvest',
        catalogId: 'abandoned_meteor_rock',
        x: 99,
        y: 195,
        z: 7,
        shared: false,
        once: { storage: 'firstlight.morris.amulet', eq: 1 },
        when: { item: 'shovel', min: 1 },
        give: [{ item: 'strange_amulet', count: 1 }],
        set: { 'firstlight.morris.amulet': 2 }
    });
    assert.strictEqual(amulet.when.item, 'shovel');
    assert.strictEqual(amulet.give[0].item, 'strange_amulet');

    const list = normalizeWorldList([herbRaw, amulet, { kind: 'nope' }]);
    assert.strictEqual(list.length, 2);

    const seeded = seedWorldPinInstances([
        {
            id: 'crate_1',
            kind: 'container',
            catalogId: 'crate',
            x: 2,
            y: 2,
            z: 0,
            pickupable: false,
            items: [{ item: 'gold_coin', count: 4 }]
        }
    ], null, 3000000000);
    assert.strictEqual(seeded.instances[0].items[0].id, 'gold_coin');

    const harvestWorld = makeWorld({
        world: [herbRaw],
        spawns: [],
        npcs: []
    });
    const herbSession = makeSession(harvestWorld, { x: 12, y: 12, z: 0 }, {
        state: { storage: { 'firstlight.morris.herbs': 1 } }
    });
    harvestWorld.worldPins[0].x = 12;
    harvestWorld.worldPins[0].y = 11;
    harvestWorld.worldPins[0].z = 0;
    harvestWorld.worldPinsByTile.clear();
    harvestWorld.worldPinsByTile.set('12,11,0', harvestWorld.worldPins[0]);
    herbSession.socket.sent.length = 0;
    assert.ok(harvestWorld.enqueueIntent(herbSession, {
        opcode: C2S.USE, seq: 1, payload: encodeUseTile(12, 11, 0)
    }));
    harvestWorld.step(1);
    assert.strictEqual(getStorage(herbSession.storage, 'firstlight.morris.herbs'), 2);
    herbSession.socket.sent.length = 0;
    assert.ok(harvestWorld.enqueueIntent(herbSession, {
        opcode: C2S.USE, seq: 2, payload: encodeUseTile(12, 11, 0)
    }));
    harvestWorld.step(2);
    const emptySay = decodeSay(lastOf(herbSession.socket, S2C.SAY).payload);
    assert.strictEqual(emptySay, 'You find nothing.');
    harvestWorld.stop();

    const amuletWorld = makeWorld({
        world: [{
            id: 'harvest_7_99_195',
            kind: 'harvest',
            catalogId: 'abandoned_meteor_rock',
            x: 12,
            y: 11,
            z: 0,
            shared: false,
            once: { storage: 'firstlight.morris.amulet', eq: 1 },
            when: { item: 'shovel', min: 1 },
            give: [{ item: 'strange_amulet', count: 1 }],
            set: { 'firstlight.morris.amulet': 2 }
        }],
        spawns: [],
        npcs: []
    });
    const digger = makeSession(amuletWorld, { x: 12, y: 12, z: 0 }, {
        state: {
            inventory: [{ id: 'shovel', count: 1 }],
            storage: { 'firstlight.morris.amulet': 1 }
        }
    });
    assert.ok(amuletWorld.enqueueIntent(digger, {
        opcode: C2S.USE, seq: 1, payload: encodeUseTile(12, 11, 0)
    }));
    amuletWorld.step(1);
    assert.strictEqual(countItem(digger.inventory, 'strange_amulet'), 1);
    assert.strictEqual(countItem(digger.inventory, 'shovel'), 1);
    assert.strictEqual(getStorage(digger.storage, 'firstlight.morris.amulet'), 2);
    const gain = decodeItemGain(lastOf(digger.socket, S2C.ITEM_GAIN).payload);
    assert.strictEqual(gain.id, 'strange_amulet');
    amuletWorld.stop();

    const crateWorld = makeWorld({
        world: [{
            id: 'crate_east',
            kind: 'container',
            catalogId: 'crate',
            x: 12,
            y: 11,
            z: 0,
            pickupable: false,
            items: [{ item: 'gold_coin', count: 3 }]
        }],
        spawns: [],
        npcs: []
    });
    const looter = makeSession(crateWorld, { x: 12, y: 12, z: 0 });
    const pin = crateWorld.worldPins[0];
    looter.socket.sent.length = 0;
    assert.ok(crateWorld.enqueueIntent(looter, {
        opcode: C2S.USE, seq: 1, payload: encodeUseTile(12, 11, 0)
    }));
    crateWorld.step(1);
    const bag = decodeContainer(lastOf(looter.socket, S2C.CONTAINER).payload);
    assert.strictEqual(bag.id, pin.id);
    assert.strictEqual(bag.items[0].count, 3);
    const take = Buffer.alloc(5);
    take.writeUInt32LE(pin.id >>> 0, 0);
    take.writeUInt8(0, 4);
    assert.ok(crateWorld.enqueueIntent(looter, {
        opcode: C2S.LOOT_TAKE, seq: 2, payload: take
    }));
    crateWorld.step(2);
    assert.strictEqual(countItem(looter.inventory, 'gold_coin'), 3);
    crateWorld.stop();

    const doorWorld = makeWorld({
        world: [{
            id: 'door_1',
            kind: 'door',
            catalogId: 'door_closed',
            closedId: 'door_closed',
            openId: 'door_open',
            x: 12,
            y: 11,
            z: 0,
            blocking: true
        }],
        spawns: [],
        npcs: []
    });
    assert.strictEqual(doorWorld.tileMap.isWalkable(12, 11, 0), false);
    const opener = makeSession(doorWorld, { x: 12, y: 12, z: 0 });
    assert.ok(doorWorld.enqueueIntent(opener, {
        opcode: C2S.USE, seq: 1, payload: encodeUseTile(12, 11, 0)
    }));
    doorWorld.step(1);
    assert.strictEqual(doorWorld.tileMap.isWalkable(12, 11, 0), true);
    assert.strictEqual(doorWorld.worldPins[0].catalogId, 'door_open');
    doorWorld.stop();

    const leverWorld = makeWorld({
        world: [{
            id: 'lever_1',
            kind: 'lever',
            catalogId: 'lever',
            x: 12,
            y: 11,
            z: 0,
            effects: [{ type: 'cell', x: 13, y: 12, z: 0, friction: 255 }]
        }],
        spawns: [],
        npcs: []
    });
    assert.strictEqual(leverWorld.tileMap.isWalkable(13, 12, 0), true);
    const puller = makeSession(leverWorld, { x: 12, y: 12, z: 0 });
    assert.ok(leverWorld.enqueueIntent(puller, {
        opcode: C2S.USE, seq: 1, payload: encodeUseTile(12, 11, 0)
    }));
    leverWorld.step(1);
    assert.strictEqual(leverWorld.tileMap.isWalkable(13, 12, 0), false);
    assert.ok(leverWorld.enqueueIntent(puller, {
        opcode: C2S.USE, seq: 2, payload: encodeUseTile(12, 11, 0)
    }));
    leverWorld.step(2);
    assert.strictEqual(leverWorld.tileMap.isWalkable(13, 12, 0), true);
    leverWorld.stop();

    const hopMap = twoFloorMap();
    const tpWorld = makeWorld({
        world: [{
            id: 'pad_1',
            kind: 'teleport',
            catalogId: 'portal',
            x: 12,
            y: 11,
            z: 0,
            to: { x: 12, y: 11, z: 1 }
        }],
        spawns: [],
        npcs: []
    }, hopMap);
    const jumper = makeSession(tpWorld, { x: 12, y: 12, z: 0 });
    assert.ok(tpWorld.enqueueIntent(jumper, {
        opcode: C2S.USE, seq: 1, payload: encodeUseTile(12, 11, 0)
    }));
    tpWorld.step(1);
    assert.strictEqual(jumper.z, 1);
    assert.strictEqual(jumper.x, 12);
    assert.strictEqual(jumper.y, 11);
    const mv = decodeMove(lastOf(jumper.socket, S2C.MOVE).payload);
    assert.strictEqual(mv.z, 1);
    tpWorld.stop();

    const trapWorld = makeWorld({
        world: [{
            id: 'spike_1',
            kind: 'trap',
            catalogId: 'spike',
            x: 12,
            y: 11,
            z: 0,
            damage: 10,
            shared: true
        }],
        spawns: [],
        npcs: []
    });
    const stepper = makeSession(trapWorld, { x: 12, y: 12, z: 0 });
    const before = stepper.hp;
    assert.ok(trapWorld.enqueueIntent(stepper, {
        opcode: C2S.MOVE_STEP, seq: 1, payload: Buffer.from([0])
    }));
    trapWorld.step(1);
    assert.strictEqual(stepper.hp, before - 10);
    assert.ok(decodeStats(lastOf(stepper.socket, S2C.STATS).payload));
    trapWorld.stop();

    const toolMap = twoFloorMap();
    const shovelIdx = 11 * toolMap.width + 12;
    toolMap.floors[0].flags[shovelIdx] = TILE_FLAG_SHOVEL_SPOT;
    const toolWorld = makeWorld({
        world: [],
        spawns: [],
        npcs: []
    }, toolMap);
    const digHop = makeSession(toolWorld, { x: 12, y: 12, z: 0 }, {
        state: { inventory: [{ id: 'shovel', count: 1 }] }
    });
    assert.ok(toolWorld.enqueueIntent(digHop, {
        opcode: C2S.USE_ITEM_WITH,
        seq: 1,
        payload: encodeUseItemWith({ x: 12, y: 11, z: 0, itemId: 'shovel' })
    }));
    toolWorld.step(1);
    assert.strictEqual(digHop.z, 1);
    assert.strictEqual(countItem(digHop.inventory, 'shovel'), 1);
    toolWorld.stop();

    const ropeMap = twoFloorMap();
    const ropeIdx = 11 * ropeMap.width + 12;
    ropeMap.floors[1].flags[ropeIdx] = TILE_FLAG_ROPE_SPOT;
    const ropeWorld = makeWorld({
        world: [],
        spawns: [],
        npcs: []
    }, ropeMap);
    const climber = makeSession(ropeWorld, { x: 12, y: 12, z: 1 }, {
        state: { inventory: [{ id: 'rope', count: 1 }] }
    });
    assert.ok(ropeWorld.enqueueIntent(climber, {
        opcode: C2S.USE_ITEM_WITH,
        seq: 1,
        payload: encodeUseItemWith({ x: 12, y: 11, z: 1, itemId: 'rope' })
    }));
    ropeWorld.step(1);
    assert.strictEqual(climber.z, 0);
    ropeWorld.stop();

    const farWorld = makeWorld({
        world: [{
            id: 'far_chest',
            kind: 'chest',
            catalogId: 'chest',
            x: 14,
            y: 14,
            z: 0,
            give: [{ item: 'gold_coin', count: 1 }]
        }],
        spawns: [],
        npcs: []
    });
    const far = makeSession(farWorld, { x: 12, y: 12, z: 0 });
    far.socket.sent.length = 0;
    assert.ok(farWorld.enqueueIntent(far, {
        opcode: C2S.USE, seq: 1, payload: encodeUseTile(14, 14, 0)
    }));
    farWorld.step(1);
    assert.strictEqual(decodeReject(lastOf(far.socket, S2C.REJECT).payload).reason, REASON.OUT_OF_RANGE);
    farWorld.stop();

    const root = resolveContentPath({ contentPath: '../content' }, SERVER_ROOT);
    const pack = loadPack(root);
    const map = runtimeMap(pack);
    assert.ok(Array.isArray(map.world));
    assert.ok(map.world.some((p) => p && p.id === 'harvest_7_62_138'));
    assert.ok(map.world.some((p) => p && p.id === 'harvest_7_99_195'));
    const flSettings = testSettings();
    delete flSettings.spawns;
    delete flSettings.npcs;
    const flWorld = new World({
        settings: flSettings,
        store: new MemoryStore(),
        log: createLog(flSettings),
        pack,
        schedule: () => 0,
        clear: () => {}
    });
    const herbPin = flWorld.worldPinById.get('harvest_7_62_138');
    const amuletPin = flWorld.worldPinById.get('harvest_7_99_195');
    assert.ok(herbPin);
    assert.ok(amuletPin);
    assert.strictEqual(herbPin.x, 62);
    assert.strictEqual(herbPin.y, 138);
    assert.strictEqual(herbPin.z, 7);
    assert.strictEqual(amuletPin.when.item, 'shovel');
    const flSession = makeSession(flWorld, { x: 62, y: 137, z: 7 }, {
        state: { storage: { 'firstlight.morris.herbs': 1 } }
    });
    flSession.socket.sent.length = 0;
    assert.ok(flWorld.enqueueIntent(flSession, {
        opcode: C2S.USE, seq: 1, payload: encodeUseTile(62, 138, 7)
    }));
    flWorld.step(1);
    assert.strictEqual(getStorage(flSession.storage, 'firstlight.morris.herbs'), 2);
    stackItem(flSession.inventory, 'shovel', 1);
    flSession.storage['firstlight.morris.amulet'] = 1;
    flSession.x = 99;
    flSession.y = 194;
    flSession.z = 7;
    flWorld.tileMap.leaveTile(62, 137, 7, flSession);
    assert.ok(flWorld.tileMap.enterTile(99, 194, 7, flSession));
    assert.ok(flWorld.enqueueIntent(flSession, {
        opcode: C2S.USE, seq: 2, payload: encodeUseTile(99, 195, 7)
    }));
    flWorld.step(2);
    assert.strictEqual(countItem(flSession.inventory, 'strange_amulet'), 1);
    assert.strictEqual(countItem(flSession.inventory, 'shovel'), 1);
    assert.strictEqual(getStorage(flSession.storage, 'firstlight.morris.amulet'), 2);
    flWorld.stop();

    const appearWorld = makeWorld({
        world: [{
            id: 'bush',
            kind: 'harvest',
            catalogId: 'abandoned_flower_patch',
            x: 12,
            y: 12,
            z: 0
        }],
        spawns: [],
        npcs: []
    });
    const viewer = makeSession(appearWorld, { x: 12, y: 12, z: 0 });
    const pinPkt = lastOf(viewer.socket, S2C.WORLD_PIN);
    assert.ok(pinPkt);
    const seen = decodeWorldPin(pinPkt.payload);
    assert.strictEqual(seen.kind, 'harvest');
    appearWorld.stop();

    console.log('ok world_pins');
}

main();

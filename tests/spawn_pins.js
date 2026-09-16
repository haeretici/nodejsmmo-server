'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { createStaticMap } = require('../src/world/static_map');
const { TEMPLATES } = require('../src/world/templates');
const { S2C } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');
const {
    resolveSpawnMode,
    respawnDelayTicks,
    pinSkipReason,
    inSpawnAoi,
    makePinState
} = require('../src/world/spawn_pins');

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

const MUTE = {
    id: 'mute_npc',
    label: 'Mute',
    isNpc: true,
    hp: 10,
    hpMax: 10,
    armor: 0,
    mitigation: 1,
    exp: 0,
    aggro: false,
    attacks: [],
    loot: []
};

function makeOnDemandWorld() {
    const settings = testSettings();
    delete settings.spawns;
    delete settings.npcs;
    settings.spawnActivateMargin = 0;
    settings.spawnDespawnIdleTicks = 0;
    settings.logicUps = 20;
    const map = createStaticMap();
    map.spawns = [
        { kind: 'rat', x: 12, y: 12, z: 0, respawn: 1 },
        { kind: 'dummy', x: 12, y: 12, z: 1, respawn: 1 },
        { kind: 'missing_kit', x: 13, y: 12, z: 0, respawn: 1 },
        { kind: 'mute_npc', x: 11, y: 12, z: 0, respawn: 1 }
    ];
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        map,
        templates: Object.assign(Object.create(null), TEMPLATES, { mute_npc: MUTE }),
        schedule: () => 0,
        clear: () => {}
    });
    world.start();
    return world;
}

function makeSession(world, pos) {
    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter(ash(1), pos || world.spawnPos(ash(1)));
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    world.syncAppears(session);
    return session;
}

function main() {
    assert.strictEqual(resolveSpawnMode({}, false), 'on_demand');
    assert.strictEqual(resolveSpawnMode({}, true), 'eager');
    assert.strictEqual(resolveSpawnMode({ spawnMode: 'on_demand' }, true), 'on_demand');
    assert.strictEqual(respawnDelayTicks({ respawn: 90 }, { logicUps: 20 }), 1800);
    assert.strictEqual(respawnDelayTicks({}, { creatureRespawnTicks: 200 }), 200);
    assert.strictEqual(respawnDelayTicks({ respawn: 0 }, { logicUps: 20 }), 0);
    assert.strictEqual(pinSkipReason(null), 'unknown');
    assert.strictEqual(pinSkipReason(MUTE), 'npc');
    assert.strictEqual(pinSkipReason(TEMPLATES.guide), null);
    assert.strictEqual(pinSkipReason(TEMPLATES.rat), null);
    const pin = makePinState({ creatureId: 'cave_rat', x: 1, y: 2, z: 7, respawn: 90 }, 0, false);
    assert.strictEqual(pin.kind, 'cave_rat');
    assert.strictEqual(pin.respawn, 90);

    const map = createStaticMap();
    assert.strictEqual(inSpawnAoi(map, 12, 12, 0, 12, 12, 0, 0), true);
    assert.strictEqual(inSpawnAoi(map, 12, 12, 0, 12, 12, 1, 0), false);
    assert.strictEqual(inSpawnAoi(map, 12, 12, 0, 2, 2, 0, 0), false);
    assert.strictEqual(inSpawnAoi(map, 12, 12, 0, 2, 2, 0, 8), true);

    const world = makeOnDemandWorld();
    assert.strictEqual(world.spawnMode, 'on_demand');
    assert.strictEqual(world.spawnPins.length, 4);
    assert.strictEqual(world.creatures.size, 0);
    const skipped = world.spawnPins.filter((p) => p.state === 'skipped').map((p) => p.kind).sort();
    assert.deepStrictEqual(skipped, ['missing_kit', 'mute_npc']);

    const session = makeSession(world);
    assert.strictEqual(world.creatures.size, 1);
    const rat = Array.from(world.creatures.values())[0];
    assert.strictEqual(rat.kind, 'rat');
    assert.ok(lastOf(session.socket, S2C.APPEAR));

    world.kill(rat, session, 1);
    assert.strictEqual(world.creatures.size, 0);
    const ratPin = world.spawnPins[0];
    assert.strictEqual(ratPin.state, 'cooldown');
    assert.strictEqual(ratPin.readyTick, 1 + 20);
    world.step(20);
    assert.strictEqual(world.creatures.size, 0);
    world.step(21);
    assert.strictEqual(world.creatures.size, 1);
    assert.strictEqual(Array.from(world.creatures.values())[0].kind, 'rat');

    world.leave(session);
    let gone = false;
    for (let t = 22; t <= 50; t++) {
        world.step(t);
        if (world.creatures.size === 0) {
            gone = true;
            break;
        }
    }
    assert.ok(gone, 'on_demand pin despawns after logout (leash home first if off spawn)');
    world.stop();

    const eager = testSettings();
    eager.spawns = [{ kind: 'dummy', x: 12, y: 11, z: 0 }];
    const w2 = new World({
        settings: eager,
        store: new MemoryStore(),
        log: createLog(eager),
        schedule: () => 0,
        clear: () => {}
    });
    assert.strictEqual(w2.spawnMode, 'eager');
    assert.strictEqual(w2.creatures.size, 1);
    w2.stop();

    console.log('ok spawn_pins');
}

main();

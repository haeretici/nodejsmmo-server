'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { createStaticMap } = require('../src/world/static_map');
const { REASON } = require('../src/protocol/opcodes');
const { useWorldHarvest } = require('../src/world/world_pin_actions');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function ash() {
    return {
        id: 1,
        accountId: 1,
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

function makeWorld(extra) {
    const settings = testSettings();
    delete settings.spawns;
    delete settings.npcs;
    if (extra) Object.assign(settings, extra);
    const map = createStaticMap();
    map.world = settings.world || [];
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        map,
        schedule: () => 0,
        clear: () => {}
    });
    world.start();
    return world;
}

function makeSession(world) {
    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter(ash(), { x: 12, y: 12, z: 0 });
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    return session;
}

function testHarvestCooldownUsesDeadlineQueue() {
    const world = makeWorld({
        world: [
            {
                id: 'herb',
                kind: 'harvest',
                catalogId: 'abandoned_flower_patch',
                x: 12,
                y: 12,
                z: 0,
                give: [],
                cooldown: 1,
                shared: true
            },
            {
                id: 'chest_far',
                kind: 'container',
                catalogId: 'chest',
                x: 14,
                y: 12,
                z: 0,
                decay: { sec: 1000 }
            }
        ]
    });
    const herb = world.worldPinById.get('herb');
    const chest = world.worldPinById.get('chest_far');
    assert.ok(herb);
    assert.ok(chest);
    assert.ok(world.worldPinDeadlines.length >= 1, 'decay pin is queued at seed');
    const session = makeSession(world);

    const used = useWorldHarvest(session, herb, world.logicNow(1), { itemDb: world.itemDb() });
    assert.strictEqual(used.ok, true);
    assert.ok(herb.harvestReadyAt > 0);
    world.scheduleWorldPinDeadline(herb, world.logicNow(1));

    const before = world.worldPinDeadlines.length;
    world.tickWorldPins(1);
    assert.ok(herb.harvestReadyAt != null, 'harvest still cooling at t=1s/20');
    assert.strictEqual(chest.decay != null, true, 'unrelated decay pin is not scanned to completion');
    assert.ok(world.worldPinDeadlines.length >= 1);

    // cooldown is 1s → ready at logicNow 1 + 1 = 2. Tick 40 is 2.0s at 20 UPS.
    world.tickWorldPins(40);
    assert.strictEqual(herb.harvestReadyAt, null, 'harvest cooldown expires from deadline queue');
    assert.strictEqual(herb.used, false);
    assert.ok(chest.decay, 'far decay pin still waiting');
    assert.ok(before >= 1);

    session.kick(REASON.LOGOUT);
    world.stop();
}

function testDecayFiresFromQueueNotFullScan() {
    const world = makeWorld({
        world: [
            { id: 'rot', kind: 'container', catalogId: 'chest', x: 12, y: 11, z: 0, decay: { sec: 0.05 } },
            { id: 'stay', kind: 'container', catalogId: 'chest', x: 13, y: 11, z: 0, decay: { sec: 50 } }
        ]
    });
    const rot = world.worldPinById.get('rot');
    const stay = world.worldPinById.get('stay');
    assert.strictEqual(rot.decayAt, 0.05);
    assert.strictEqual(stay.decayAt, 50);

    world.tickWorldPins(0);
    assert.strictEqual(rot.removed, false, 'not due at t=0');

    world.tickWorldPins(1); // 0.05s at 20 UPS
    assert.strictEqual(rot.removed, true, 'short decay fires from queue head');
    assert.strictEqual(stay.removed, false);
    assert.ok(stay.decay);

    world.stop();
}

function main() {
    testHarvestCooldownUsesDeadlineQueue();
    testDecayFiresFromQueueNotFullScan();
    console.log('ok phase7_world_pin_deadlines');
}

main();

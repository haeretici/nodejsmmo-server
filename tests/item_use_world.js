'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');
const { encodeContainerSlot, decodeStats, decodeSay } = require('../src/protocol/messages');
const { FALLBACK_ITEMS } = require('../src/world/items');
const { addItemToInventory, countItem } = require('../src/world/inventory');
const { applyCondition } = require('../src/world/conditions');
const { createStaticMap } = require('../src/world/static_map');
const {
    FOOD_REGEN_HEALTH_GAIN,
    FOOD_REGEN_INTERVAL_SEC
} = require('../src/world/item_use');

const itemDb = Object.assign(Object.create(null), FALLBACK_ITEMS, {
    small_health_potion: {
        id: 'small_health_potion',
        category: 'potion',
        stackable: true,
        consumable: true,
        usable: true,
        weight: 175,
        heal: [60, 90]
    },
    mana_potion: {
        id: 'mana_potion',
        category: 'potion',
        stackable: true,
        consumable: true,
        usable: true,
        weight: 180,
        restoreMana: [75, 125]
    },
    antidote_potion: {
        id: 'antidote_potion',
        category: 'potion',
        stackable: true,
        consumable: true,
        usable: true,
        weight: 175,
        dispel: ['poison']
    },
    berserk_potion: {
        id: 'berserk_potion',
        category: 'potion',
        stackable: true,
        consumable: true,
        usable: true,
        weight: 200
    },
    magic_shield_potion: {
        id: 'magic_shield_potion',
        category: 'potion',
        stackable: true,
        consumable: true,
        usable: true,
        weight: 320,
        condition: {
            type: 'mana_shield',
            durationSec: 60,
            poolFormula: 'legacy_mana_shield'
        }
    },
    meat: {
        id: 'meat',
        category: 'food',
        stackable: true,
        consumable: true,
        usable: true,
        weight: 1300
    },
    rock: {
        id: 'rock',
        category: 'gem',
        weight: 100
    }
});

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

function makeWorld() {
    const settings = testSettings();
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        rng: () => 0.5,
        map: createStaticMap(),
        pack: {
            classes: {
                classes: [{ id: 'scout', baseRegenHp: 0, baseRegenMp: 0 }]
            }
        }
    });
    world._itemDb = itemDb;
    world.start();
    return world;
}

function makeSession(world, extra) {
    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter(Object.assign({
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
    }, extra || {}), world.spawnPos({ townId: 1 }));
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    return session;
}

function enqueueUse(world, session, itemId) {
    const uid = Object.keys(session.inventory.items).find((k) => {
        const inst = session.inventory.items[k];
        return inst && inst.itemId === itemId && inst.location && inst.location.kind === 'container';
    });
    assert.ok(uid, itemId + ' in bag');
    const inst = session.inventory.items[uid];
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.USE_ITEM,
        seq: session.nextClientSeq,
        payload: encodeContainerSlot(inst.location.containerUid, inst.location.index)
    }));
}

function main() {
    const world = makeWorld();
    const session = makeSession(world);
    session.hp = 10;
    session.mp = 10;
    session.mpMax = 500;
    addItemToInventory(session.inventory, 'small_health_potion', 2, itemDb);
    addItemToInventory(session.inventory, 'mana_potion', 2, itemDb);
    enqueueUse(world, session, 'small_health_potion');
    world.step(1);
    assert.strictEqual(countItem(session.inventory, 'small_health_potion'), 1);
    assert.strictEqual(session.hp, 10 + 75);
    const stats = decodeStats(lastOf(session.socket, S2C.STATS).payload);
    assert.strictEqual(stats.hp, 85);

    enqueueUse(world, session, 'mana_potion');
    world.step(2);
    assert.strictEqual(countItem(session.inventory, 'mana_potion'), 1);
    assert.strictEqual(session.mp, 10 + 100);

    applyCondition(session, { type: 'poison', totalDamage: 40, intervalSec: 4 });
    assert.ok(session.conditions.some((c) => c.kind === 'poison'));
    addItemToInventory(session.inventory, 'antidote_potion', 1, itemDb);
    enqueueUse(world, session, 'antidote_potion');
    world.step(3);
    assert.strictEqual(countItem(session.inventory, 'antidote_potion'), 0);
    assert.ok(!session.conditions.some((c) => c.kind === 'poison'));

    addItemToInventory(session.inventory, 'berserk_potion', 1, itemDb);
    session.socket.sent = [];
    enqueueUse(world, session, 'berserk_potion');
    world.step(4);
    assert.strictEqual(countItem(session.inventory, 'berserk_potion'), 0);
    const say = lastOf(session.socket, S2C.SAY);
    if (say) {
        assert.notStrictEqual(decodeSay(say.payload).text, 'You cannot use that.');
    }

    session.level = 14;
    session.mpMax = 425;
    session.mp = 425;
    session.skills = Object.assign({}, session.skills, { magic: 0 });
    addItemToInventory(session.inventory, 'magic_shield_potion', 1, itemDb);
    enqueueUse(world, session, 'magic_shield_potion');
    world.step(5);
    assert.strictEqual(countItem(session.inventory, 'magic_shield_potion'), 0);
    const shield = session.conditions.find((c) => c.kind === 'mana_shield');
    assert.ok(shield);
    assert.ok(shield.durationSec > 59 && shield.durationSec <= 60);
    assert.strictEqual(shield.poolRemaining, 406);

    session.hp = 50;
    addItemToInventory(session.inventory, 'meat', 1, itemDb);
    enqueueUse(world, session, 'meat');
    world.step(6);
    assert.strictEqual(countItem(session.inventory, 'meat'), 0);
    const regen = session.conditions.find((c) => c.kind === 'regen');
    assert.ok(regen);
    assert.strictEqual(regen.healthGain, FOOD_REGEN_HEALTH_GAIN);
    const intervalTicks = Math.round(FOOD_REGEN_INTERVAL_SEC * ((world.settings.logicUps | 0) || 20));
    const hpBeforeTick = session.hp | 0;
    for (let i = 0; i < intervalTicks; i++) world.step(7 + i);
    assert.strictEqual(session.hp, hpBeforeTick + FOOD_REGEN_HEALTH_GAIN);

    addItemToInventory(session.inventory, 'rock', 1, itemDb);
    session.socket.sent = [];
    enqueueUse(world, session, 'rock');
    world.step(200);
    assert.strictEqual(countItem(session.inventory, 'rock'), 1);
    assert.strictEqual(decodeSay(lastOf(session.socket, S2C.SAY).payload).text, 'You cannot use that.');

    world.stop();
    console.log('ok item_use_world');
}

main();

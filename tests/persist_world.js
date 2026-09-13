'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C, REASON, DIR } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');
const { decodeInventory } = require('../src/protocol/messages');
const { stackItem, countItem } = require('../src/world/inventory');

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

function skills() {
    return { fist: 10, club: 10, sword: 10, axe: 10, distance: 10, shielding: 10, magic: 0, fishing: 10 };
}

async function main() {
    const settings = testSettings();
    const store = new MemoryStore();
    const acc = await store.createAccount({ email: 'persist@example.com', passwordHash: 'phc' });
    const ch = await store.createCharacter({
        accountId: acc.id,
        name: 'Ash',
        vocation: 'scout',
        level: 1,
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
    const inv0 = decodeInventory(lastOf(session.socket, S2C.INVENTORY).payload);
    assert.strictEqual(inv0.slots.length, 0);

    stackItem(session.inventory, 'gold_coin', 4, world.itemDb());
    session.experience = 20;
    if (session.character) session.character.experience = 20;

    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.MOVE_STEP, seq: 1, payload: Buffer.from([DIR.N])
    }));
    world.step(1);
    assert.strictEqual(session.y, 11);
    const walked = await store.findCharacter(acc.id, ch.id);
    assert.strictEqual(walked.posY, 12, 'walk stays RAM until logout or interval/wall-clock');
    assert.ok(!walked.lastLogout);
    const ramOnly = await store.loadCharacterState(ch.id);
    assert.strictEqual(ramOnly.inventory.items.length, 0, 'loot/bag stays RAM until interval/logout');
    assert.strictEqual(walked.experience, 0);

    await world.runIntervalSave();
    const interval = await store.findCharacter(acc.id, ch.id);
    assert.strictEqual(interval.posY, 11);
    assert.strictEqual(interval.experience, 20);
    assert.ok(!interval.lastLogout, 'interval save does not set last_logout');
    const saved = await store.loadCharacterState(ch.id);
    assert.strictEqual(countItem(saved.inventory, 'gold_coin'), 4);

    await world.saveAllOnline('global');
    const global = await store.findCharacter(acc.id, ch.id);
    assert.strictEqual(global.posY, 11);
    assert.ok(!global.lastLogout, 'wall-clock save does not set last_logout');

    session.kick(REASON.LOGOUT);
    await world.flushPersist();
    const after = await store.findCharacter(acc.id, ch.id);
    assert.strictEqual(after.posY, 11);
    assert.ok(after.lastLogout);
    world.stop();

    const world2 = new World({
        settings,
        store,
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {}
    });
    const ch2 = await store.findCharacter(acc.id, ch.id);
    const s2 = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world: world2,
        settings,
        limiter: new RateLimiter(),
        log: world2.log
    });
    s2.bindCharacter(ch2, world2.spawnPos(ch2), {
        state: await store.loadCharacterState(ch.id),
        skills: await store.loadSkills(ch.id)
    });
    assert.ok(world2.add(s2));
    world2.sendEnterWorld(s2);
    assert.strictEqual(s2.y, 11);
    assert.strictEqual(s2.experience, 20);
    assert.strictEqual(countItem(s2.inventory, 'gold_coin'), 4);
    const inv1 = decodeInventory(lastOf(s2.socket, S2C.INVENTORY).payload);
    assert.ok(inv1.slots.some((s) => s.id === 'gold_coin' && s.count === 4));

    s2.downed = true;
    s2.hp = 0;
    s2.x = 8;
    s2.y = 8;
    await world2.enqueuePersist(s2, 'logout');
    const dead = await store.findCharacter(acc.id, ch.id);
    assert.strictEqual(dead.hp, 185);
    assert.strictEqual(dead.posX, 12);
    assert.strictEqual(dead.posY, 12);
    s2.kick(REASON.LOGOUT);
    world2.stop();

    const world3 = new World({
        settings,
        store,
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {}
    });
    let requested = null;
    world3.onRequestShutdown = async (reason) => { requested = reason; };
    world3.settings.globalSaveShutdown = true;
    await world3.runGlobalSave();
    assert.strictEqual(requested, 'global-save');
    world3.stop();

    console.log('ok persist_world');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

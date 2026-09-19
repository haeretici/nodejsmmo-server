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
const { snapshotSession } = require('../src/world/snapshot');
const { createStaticMap } = require('../src/world/static_map');

function mysticPack() {
    return {
        classes: {
            classes: [{
                id: 'mystic',
                spells: ['melee_auto', 'distance_auto', 'wand_auto', 'snap_jab', 'fang_clash', 'haste']
            }]
        }
    };
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

function skills() {
    return { fist: 10, club: 10, sword: 10, axe: 10, distance: 10, shielding: 10, magic: 0, fishing: 10 };
}

async function bootMystic() {
    const settings = testSettings();
    const store = new MemoryStore();
    const acc = await store.createAccount({ email: 'mystic-hotkeys@example.com', passwordHash: 'phc' });
    const ch = await store.createCharacter({
        accountId: acc.id,
        name: 'Mira',
        vocation: 'mystic',
        level: 1,
        experience: 0,
        posX: 12, posY: 12, posZ: 0,
        hp: 185, hpMax: 185, mp: 90, mpMax: 90,
        townId: 1,
        skills: skills(),
        inventory: { items: [] },
        storage: {},
        hotkeys: { v: 1, bars: [{ id: 1, slots: [{ i: 0, t: 'spell', id: 'snap_jab' }] }] }
    });
    const world = new World({
        settings,
        store,
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        pack: mysticPack(),
        map: createStaticMap()
    });
    world.start();
    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter(ch, world.spawnPos(ch), {
        state: await store.loadCharacterState(ch.id),
        skills: await store.loadSkills(ch.id)
    });
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    return { world, store, acc, ch, session };
}

async function main() {
    assert.strictEqual(C2S.CAST, 16);
    assert.strictEqual(S2C.CAST, 129);
    assert.ok(!Object.prototype.hasOwnProperty.call(C2S, 'SET_HOTKEYS'));
    assert.ok(!Object.prototype.hasOwnProperty.call(S2C, 'HOTKEYS'));

    const { world, store, ch, session } = await bootMystic();
    assert.strictEqual(session.hotkeys, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(session, 'hotkeys'));
    assert.ok(!lastOf(session.socket, 135), 'enter does not send HOTKEYS');

    const snap = snapshotSession(session, {});
    assert.deepStrictEqual(snap.hotkeys, {}, 'snapshot does not copy bar JSON');

    session.socket.sent.length = 0;
    assert.ok(!world.enqueueIntent(session, {
        opcode: 17,
        seq: 1,
        payload: Buffer.from('{"v":1,"bars":[]}', 'utf8')
    }));
    const rej = lastOf(session.socket, S2C.REJECT);
    assert.ok(rej, 'opcode 17 REJECT');
    const { decodeReject } = require('../src/protocol/messages');
    assert.strictEqual(decodeReject(rej.payload).reason, REASON.UNKNOWN_OPCODE);

    session.kick(REASON.LOGOUT);
    await world.flushPersist();
    const saved = await store.loadCharacterState(ch.id);
    assert.deepStrictEqual(saved.hotkeys, {}, 'persist column stays empty');
    world.stop();

    console.log('ok hotkeys');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

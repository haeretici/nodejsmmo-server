'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C, REASON } = require('../src/protocol/opcodes');
const { decodeFrame, Writer } = require('../src/protocol/frame');
const {
    decodeReject,
    decodeDialog,
    decodeSay,
    decodeShop,
    decodeInventory,
    decodeAppear
} = require('../src/protocol/messages');
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

function u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
}

function replyBuf(npcId, index) {
    const b = Buffer.alloc(5);
    b.writeUInt32LE(npcId >>> 0, 0);
    b.writeUInt8(index, 4);
    return b;
}

function dealBuf(npcId, count, itemId) {
    return new Writer().u32(npcId).u16(count).str(itemId).toBuffer();
}

function makeWorld(extra) {
    const settings = testSettings();
    if (extra) Object.assign(settings, extra);
    const world = new World({
        settings,
        store: extra && extra.store ? extra.store : new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {}
    });
    world.start();
    return world;
}

function makeSession(world, ch) {
    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter(ch, world.spawnPos(ch));
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    world.syncAppears(session);
    return session;
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

function main() {
    const w = makeWorld({
        npcs: [{ kind: 'guide', x: 12, y: 11, z: 0 }]
    });
    const session = makeSession(w, ash(1));
    const guide = Array.from(w.creatures.values())[0];
    assert.ok(guide);
    assert.strictEqual(guide.name, 'Guide');
    assert.strictEqual(guide.type, 'npc');
    const appear = decodeAppear(lastOf(session.socket, S2C.APPEAR).payload);
    assert.strictEqual(appear.name, 'Guide');
    assert.strictEqual(appear.flags, 1);
    assert.ok(appear.dir === 0 || appear.dir === 1 || appear.dir === 2 || appear.dir === 3);

    assert.ok(w.enqueueIntent(session, {
        opcode: C2S.SET_TARGET, seq: 1, payload: u32(guide.id)
    }));
    w.step(1);
    assert.strictEqual(decodeReject(lastOf(session.socket, S2C.REJECT).payload).reason, REASON.BLOCKED);

    assert.ok(w.enqueueIntent(session, {
        opcode: C2S.TALK, seq: 2, payload: u32(guide.id)
    }));
    w.step(2);
    const dlg = decodeDialog(lastOf(session.socket, S2C.DIALOG).payload);
    assert.ok(dlg.text.indexOf('Welcome') >= 0);
    const trade = dlg.replies.findIndex((r) => r.label === 'Trade');
    assert.ok(trade >= 0);
    assert.ok(w.enqueueIntent(session, {
        opcode: C2S.TALK_REPLY, seq: 3, payload: replyBuf(guide.id, trade)
    }));
    w.step(3);
    const shop = decodeShop(lastOf(session.socket, S2C.SHOP).payload);
    assert.strictEqual(shop.currency, 'gold_coin');
    assert.ok(shop.items.some((r) => r.itemId === 'cookie'));
    assert.ok(!shop.items.some((r) => r.itemId === 'torch'));

    assert.ok(w.enqueueIntent(session, {
        opcode: C2S.SHOP_BUY, seq: 4, payload: dealBuf(guide.id, 1, 'cookie')
    }));
    w.step(4);
    assert.strictEqual(decodeSay(lastOf(session.socket, S2C.SAY).payload).text, 'You cannot afford that.');

    stackItem(session.inventory, 'gold_coin', 10, w.itemDb());
    assert.ok(w.enqueueIntent(session, {
        opcode: C2S.SHOP_BUY, seq: 5, payload: dealBuf(guide.id, 1, 'cookie')
    }));
    w.step(5);
    assert.strictEqual(countItem(session.inventory, 'cookie'), 1);
    assert.strictEqual(countItem(session.inventory, 'gold_coin'), 8);
    const inv = decodeInventory(lastOf(session.socket, S2C.INVENTORY).payload);
    assert.ok(inv.slots.some((r) => r.id === 'cookie'));

    assert.ok(w.enqueueIntent(session, {
        opcode: C2S.TALK, seq: 6, payload: u32(guide.id)
    }));
    w.step(6);
    const start2 = decodeDialog(lastOf(session.socket, S2C.DIALOG).payload);
    const job = start2.replies.findIndex((r) => r.label === 'Job');
    stackItem(session.inventory, 'cheese', 1, w.itemDb());
    assert.ok(w.enqueueIntent(session, {
        opcode: C2S.TALK_REPLY, seq: 7, payload: replyBuf(guide.id, job)
    }));
    w.step(7);
    assert.strictEqual(session.storage['guide.mission'], 1);
    const jobDlg = decodeDialog(lastOf(session.socket, S2C.DIALOG).payload);
    const cheese = jobDlg.replies.findIndex((r) => r.label === 'I have the cheese');
    assert.ok(cheese >= 0);
    assert.ok(w.enqueueIntent(session, {
        opcode: C2S.TALK_REPLY, seq: 8, payload: replyBuf(guide.id, cheese)
    }));
    w.step(8);
    assert.strictEqual(countItem(session.inventory, 'cheese'), 0);
    assert.strictEqual(countItem(session.inventory, 'gold_coin'), 13);
    assert.strictEqual(session.storage['guide.mission'], 2);

    session.x = 1;
    session.y = 1;
    w.tickTalkRange(session);
    assert.strictEqual(session.talkNpcId, 0);
    assert.ok(lastOf(session.socket, S2C.DIALOG_CLOSE));

    session.x = 12;
    session.y = 12;
    session.kick(REASON.LOGOUT);
    w.stop();

    const far = makeWorld({
        npcs: [{ kind: 'guide', x: 6, y: 12, z: 0 }]
    });
    const walker = makeSession(far, ash(2));
    const g2 = Array.from(far.creatures.values())[0];
    assert.ok(far.enqueueIntent(walker, {
        opcode: C2S.TALK, seq: 1, payload: u32(g2.id)
    }));
    far.step(1);
    assert.strictEqual(decodeReject(lastOf(walker.socket, S2C.REJECT).payload).reason, REASON.OUT_OF_RANGE);
    walker.kick(REASON.LOGOUT);
    far.stop();

    console.log('ok npc_world');
}

main();

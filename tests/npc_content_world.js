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
const { loadPack, resolveContentPath } = require('../src/content/load_pack');
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

function allOf(sock, opcode) {
    const out = [];
    for (let i = 0; i < sock.sent.length; i++) {
        const f = decodeFrame(sock.sent[i]);
        if (f.opcode === opcode) out.push(f);
    }
    return out;
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

function makeWorld(pack, store) {
    const settings = testSettings();
    delete settings.spawns;
    delete settings.npcs;
    const s = store || new MemoryStore();
    const world = new World({
        settings,
        store: s,
        log: createLog(settings),
        pack,
        schedule: () => 0,
        clear: () => {}
    });
    world.start();
    return world;
}

async function makeSession(world, ch, pos, store) {
    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    const state = store ? await store.loadCharacterState(ch.id) : null;
    const skills = store ? await store.loadSkills(ch.id) : null;
    session.bindCharacter(ch, pos || world.spawnPos(ch), { state, skills });
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    world.syncAppears(session);
    return session;
}

async function main() {
    const root = resolveContentPath({ contentPath: '../content' }, SERVER_ROOT);
    const pack = loadPack(root);

    // 1. Verify 9 dialog packs exist
    const expectedDialogs = [
        'arcanist_quell',
        'captain_riven',
        'goblin_nibb',
        'outfitter_calder',
        'quartermaster_hale',
        'sister_mira',
        'smith_brannok',
        'town_guide',
        'wayguide_osric'
    ];
    for (const id of expectedDialogs) {
        assert.ok(pack.dialogs[id], `missing dialog pack: ${id}`);
        assert.ok(pack.dialogs[id].nodes, `dialog pack ${id} missing nodes`);
    }

    const store = new MemoryStore();
    const acc = await store.createAccount({ email: 'hale@example.com', passwordHash: 'phc' });
    const ch = await store.createCharacter({
        accountId: acc.id,
        name: 'Ash',
        vocation: 'scout',
        level: 1,
        experience: 0,
        posX: 80, posY: 132, posZ: 6,
        hp: 185, hpMax: 185, mp: 90, mpMax: 90,
        townId: 1,
        skills: { fist: 10, club: 10, sword: 10, axe: 10, distance: 10, shielding: 10, magic: 0, fishing: 10 },
        inventory: { items: [] },
        storage: {}
    });
    const world = makeWorld(pack, store);

    // 2. Verify all firstlight NPC spawn pins are active (none skipped)
    const activePins = world.spawnPins.filter((p) => p.state !== 'skipped');
    const expectedNpcs = [
        'quartermaster_hale',
        'wayguide_osric',
        'outfitter_calder',
        'smith_brannok',
        'arcanist_quell',
        'sister_mira',
        'captain_riven',
        'goblin_nibb'
    ];
    for (const kind of expectedNpcs) {
        const pin = activePins.find((p) => p.kind === kind);
        assert.ok(pin, `missing active spawn pin for ${kind}`);
        assert.strictEqual(pin.state, 'idle');
    }

    // 3. Connect player at plaza spawn (80, 132, 6)
    const session = await makeSession(world, ch, { x: 80, y: 132, z: 6 }, store);
    world.step(1);

    // NPCs in plaza AOI should have activated
    const hale = Array.from(world.creatures.values()).find((c) => c.kind === 'quartermaster_hale');
    const osric = Array.from(world.creatures.values()).find((c) => c.kind === 'wayguide_osric');
    const calder = Array.from(world.creatures.values()).find((c) => c.kind === 'outfitter_calder');
    const brannok = Array.from(world.creatures.values()).find((c) => c.kind === 'smith_brannok');
    const quell = Array.from(world.creatures.values()).find((c) => c.kind === 'arcanist_quell');

    assert.ok(hale, 'Hale must spawn in plaza AOI');
    assert.ok(osric, 'Osric must spawn in plaza AOI');
    assert.ok(calder, 'Calder must spawn in plaza AOI');
    assert.ok(brannok, 'Brannok must spawn in plaza AOI');
    assert.ok(quell, 'Quell must spawn in plaza AOI');
    for (const npc of [hale, osric, calder, brannok]) {
        assert.ok(npc.voices && npc.voices.length, npc.kind + ' idle voices');
        assert.ok(npc.voiceInterval > 0, npc.kind + ' voiceInterval');
        assert.ok(npc.voiceChance > 0, npc.kind + ' voiceChance');
    }

    assert.strictEqual(hale.type, 'npc');
    assert.strictEqual(hale.name, 'Hale');
    assert.strictEqual(hale.x, 83);
    assert.strictEqual(hale.y, 132);
    assert.strictEqual(hale.z, 6);

    // 4. Talk to Hale: Accept Amulet Quest (storage 0 -> 1)
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.TALK, seq: 1, payload: u32(hale.id)
    }));
    world.step(2);
    const haleDlg1 = decodeDialog(lastOf(session.socket, S2C.DIALOG).payload);
    assert.ok(haleDlg1.text.includes('lost amulet'));
    const amuletIdx = haleDlg1.replies.findIndex((r) => r.label === 'Amulet');
    assert.ok(amuletIdx >= 0, 'Start node must offer Amulet');

    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.TALK_REPLY, seq: 2, payload: replyBuf(hale.id, amuletIdx)
    }));
    world.step(3);
    const haleOffer = decodeDialog(lastOf(session.socket, S2C.DIALOG).payload);
    assert.ok(haleOffer.text.includes('south beach'));
    assert.strictEqual(session.storage['firstlight.morris.amulet'], 1);

    // Close talk
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.TALK_CLOSE, seq: 3, payload: u32(hale.id)
    }));
    world.step(4);

    // Re-talk: should now show amulet_wait ("Still missing.")
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.TALK, seq: 4, payload: u32(hale.id)
    }));
    world.step(5);
    const haleDlg2 = decodeDialog(lastOf(session.socket, S2C.DIALOG).payload);
    const amuletIdx2 = haleDlg2.replies.findIndex((r) => r.label === 'Amulet');
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.TALK_REPLY, seq: 5, payload: replyBuf(hale.id, amuletIdx2)
    }));
    world.step(6);
    const haleWait = decodeDialog(lastOf(session.socket, S2C.DIALOG).payload);
    assert.ok(haleWait.text.includes('Still missing'));

    // 5. Simulate finding amulet on beach (storage 2, strange_amulet in backpack)
    session.storage['firstlight.morris.amulet'] = 2;
    stackItem(session.inventory, 'strange_amulet', 1, world.itemDb());

    // Talk to Hale: Turn in Amulet (storage 2 -> 3, gives 50 gold_coin)
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.TALK, seq: 6, payload: u32(hale.id)
    }));
    world.step(7);
    const haleDlg3 = decodeDialog(lastOf(session.socket, S2C.DIALOG).payload);
    const amuletIdx3 = haleDlg3.replies.findIndex((r) => r.label === 'Amulet');
    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.TALK_REPLY, seq: 7, payload: replyBuf(hale.id, amuletIdx3)
    }));
    world.step(8);
    const turninDlg = decodeDialog(lastOf(session.socket, S2C.DIALOG).payload);
    assert.ok(turninDlg.text.includes('Hand it over') || turninDlg.text.includes("That's the one"));
    const foundIdx = turninDlg.replies.findIndex((r) => r.label === 'Here it is');
    assert.ok(foundIdx >= 0, 'Must have reply "Here it is"');

    assert.ok(world.enqueueIntent(session, {
        opcode: C2S.TALK_REPLY, seq: 8, payload: replyBuf(hale.id, foundIdx)
    }));
    world.step(9);
    assert.strictEqual(countItem(session.inventory, 'strange_amulet'), 0);
    assert.strictEqual(countItem(session.inventory, 'gold_coin'), 50);
    assert.strictEqual(session.storage['firstlight.morris.amulet'], 3);
    const doneDlg = decodeDialog(lastOf(session.socket, S2C.DIALOG).payload);
    assert.ok(doneDlg.text.includes('Fifty gold') || doneDlg.text.includes('Well done'));

    // 6. Test Quest Storage Persistence across logout / relog
    await world.enqueuePersist(session, 'logout');
    world.leave(session);
    world.step(10);
    world.stop();

    // Reopen world with same store
    const world2 = makeWorld(pack, store);
    const session2 = await makeSession(world2, ch, { x: 80, y: 132, z: 6 }, store);
    world2.step(1);
    assert.strictEqual(session2.storage['firstlight.morris.amulet'], 3, 'Quest storage must persist across relog');
    assert.strictEqual(countItem(session2.inventory, 'gold_coin'), 50);

    const hale2 = Array.from(world2.creatures.values()).find((c) => c.kind === 'quartermaster_hale');
    assert.ok(hale2);
    assert.ok(world2.enqueueIntent(session2, {
        opcode: C2S.TALK, seq: 1, payload: u32(hale2.id)
    }));
    world2.step(2);
    const haleDoneCheck = decodeDialog(lastOf(session2.socket, S2C.DIALOG).payload);
    const amuletDoneIdx = haleDoneCheck.replies.findIndex((r) => r.label === 'Amulet');
    assert.ok(world2.enqueueIntent(session2, {
        opcode: C2S.TALK_REPLY, seq: 2, payload: replyBuf(hale2.id, amuletDoneIdx)
    }));
    world2.step(3);
    const alreadyDone = decodeDialog(lastOf(session2.socket, S2C.DIALOG).payload);
    assert.ok(alreadyDone.text.includes('settled') || alreadyDone.text.includes('another'));

    // 7. Talk to Osric (Wayguide)
    const osric2 = Array.from(world2.creatures.values()).find((c) => c.kind === 'wayguide_osric');
    assert.ok(osric2);
    assert.ok(world2.enqueueIntent(session2, {
        opcode: C2S.TALK, seq: 3, payload: u32(osric2.id)
    }));
    world2.step(4);
    const osricDlg = decodeDialog(lastOf(session2.socket, S2C.DIALOG).payload);
    assert.ok(osricDlg.text.includes('Shops, Hale'));
    const shopsIdx = osricDlg.replies.findIndex((r) => r.label === 'Shops');
    assert.ok(shopsIdx >= 0);
    assert.ok(world2.enqueueIntent(session2, {
        opcode: C2S.TALK_REPLY, seq: 4, payload: replyBuf(osric2.id, shopsIdx)
    }));
    world2.step(5);
    const shopsInfo = decodeDialog(lastOf(session2.socket, S2C.DIALOG).payload);
    assert.ok(shopsInfo.text.includes('Calder') && shopsInfo.text.includes('Brannok'));

    // 8. Talk & Shop with Calder (Outfitter)
    // Walk to Calder (75, 133, 6) from (80, 132, 6)
    session2.x = 76;
    session2.y = 133;
    session2.z = 6;
    const calder2 = Array.from(world2.creatures.values()).find((c) => c.kind === 'outfitter_calder');
    assert.ok(calder2);
    assert.ok(world2.enqueueIntent(session2, {
        opcode: C2S.TALK, seq: 5, payload: u32(calder2.id)
    }));
    world2.step(6);
    const calderDlg = decodeDialog(lastOf(session2.socket, S2C.DIALOG).payload);
    assert.ok(calderDlg.text.includes('Ropes, shovels, food'));
    const tradeIdx = calderDlg.replies.findIndex((r) => r.label === 'Trade');
    assert.ok(tradeIdx >= 0);

    assert.ok(world2.enqueueIntent(session2, {
        opcode: C2S.TALK_REPLY, seq: 6, payload: replyBuf(calder2.id, tradeIdx)
    }));
    world2.step(7);
    const shop = decodeShop(lastOf(session2.socket, S2C.SHOP).payload);
    assert.strictEqual(shop.currency, 'gold_coin');
    assert.ok(shop.items.some((it) => it.itemId === 'bread' && it.buy === 3));
    assert.ok(shop.items.some((it) => it.itemId === 'cheese' && it.sell === 2));

    // Buy 2 bread from Calder (3 gold each = 6 gold)
    const preGold = countItem(session2.inventory, 'gold_coin');
    assert.ok(world2.enqueueIntent(session2, {
        opcode: C2S.SHOP_BUY, seq: 7, payload: dealBuf(calder2.id, 2, 'bread')
    }));
    world2.step(8);
    assert.strictEqual(countItem(session2.inventory, 'bread'), 2);
    assert.strictEqual(countItem(session2.inventory, 'gold_coin'), preGold - 6);

    // Sell 1 cheese to Calder (gain 2 gold)
    stackItem(session2.inventory, 'cheese', 1, world2.itemDb());
    assert.ok(world2.enqueueIntent(session2, {
        opcode: C2S.SHOP_SELL, seq: 8, payload: dealBuf(calder2.id, 1, 'cheese')
    }));
    world2.step(9);
    assert.strictEqual(countItem(session2.inventory, 'cheese'), 0);
    assert.strictEqual(countItem(session2.inventory, 'gold_coin'), preGold - 6 + 2);

    // 9. Talk to Nibb on floor 7 (59, 140, 7)
    session2.x = 60;
    session2.y = 140;
    session2.z = 7;
    world2.step(10); // AOI activates Nibb
    const nibb = Array.from(world2.creatures.values()).find((c) => c.kind === 'goblin_nibb');
    assert.ok(nibb, 'Nibb must spawn on floor 7 west meadow');
    assert.strictEqual(nibb.x, 59);
    assert.strictEqual(nibb.y, 140);
    assert.strictEqual(nibb.z, 7);

    assert.ok(world2.enqueueIntent(session2, {
        opcode: C2S.TALK, seq: 9, payload: u32(nibb.id)
    }));
    world2.step(11);
    const nibbDlg = decodeDialog(lastOf(session2.socket, S2C.DIALOG).payload);
    assert.ok(nibbDlg.text.includes('West is water'));
    const plantIdx = nibbDlg.replies.findIndex((r) => r.label === 'Plant');
    assert.ok(plantIdx >= 0);
    assert.ok(world2.enqueueIntent(session2, {
        opcode: C2S.TALK_REPLY, seq: 10, payload: replyBuf(nibb.id, plantIdx)
    }));
    world2.step(12);
    const plantInfo = decodeDialog(lastOf(session2.socket, S2C.DIALOG).payload);
    assert.ok(plantInfo.text.includes('rare plant sits on the meadow'));

    // 10. Out-of-range rejection
    session2.x = 100;
    session2.y = 100;
    assert.ok(world2.enqueueIntent(session2, {
        opcode: C2S.TALK, seq: 11, payload: u32(nibb.id)
    }));
    world2.step(13);
    const rej = decodeReject(lastOf(session2.socket, S2C.REJECT).payload);
    assert.strictEqual(rej.reason, REASON.OUT_OF_RANGE);

    world2.leave(session2);
    world2.stop();

    console.log('ok npc_content_world');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

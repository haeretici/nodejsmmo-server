'use strict';

const assert = require('assert');
const { encodeFrame, decodeFrame, decodeFrames, Writer, Reader } = require('../src/protocol/frame');
const { C2S, S2C, PROTOCOL_VERSION, SWING_ELEMENT } = require('../src/protocol/opcodes');
const {
    encodeHello,
    decodeHello,
    encodeEnterWorld,
    decodeEnterWorld,
    encodeReject,
    decodeReject,
    encodeMove,
    decodeMove,
    decodeUseStair,
    encodeViewport,
    decodeViewport,
    encodeStats,
    decodeStats,
    encodeSwing,
    decodeSwing,
    encodeCorpse,
    decodeCorpse,
    encodeContainer,
    decodeContainer,
    encodeAppear,
    decodeAppear,
    encodeField,
    decodeField,
    encodeInventory,
    decodeInventory,
    encodeEquipment,
    decodeEquipment,
    encodeDialog,
    decodeDialog,
    encodeShop,
    decodeShop,
    encodeSay,
    decodeSay,
    encodeSkills,
    decodeSkills,
    encodeExp,
    decodeExp
} = require('../src/protocol/messages');
const { createStaticMap, viewport, TILE } = require('../src/world/static_map');

function main() {
    assert.strictEqual(decodeFrame(Buffer.alloc(5)), null);
    const payload = Buffer.from([9, 8, 7]);
    const framed = encodeFrame(C2S.PING, 42, payload);
    const got = decodeFrame(framed);
    assert.strictEqual(got.opcode, C2S.PING);
    assert.strictEqual(got.seq, 42);
    assert.deepStrictEqual(Buffer.from(got.payload), payload);

    const empty = decodeFrame(encodeFrame(S2C.KICK, 1, Buffer.alloc(0)));
    assert.strictEqual(empty.opcode, S2C.KICK);
    assert.strictEqual(empty.payload.length, 0);

    const w = new Writer().u8(1).u16(512).i16(-3).str('Ash').toBuffer();
    const r = new Reader(w);
    assert.strictEqual(r.u8(), 1);
    assert.strictEqual(r.u16(), 512);
    assert.strictEqual(r.i16(), -3);
    assert.strictEqual(r.str(), 'Ash');

    const hello = decodeHello(encodeHello({
        protocolVersion: PROTOCOL_VERSION,
        ups: 20,
        tickIndex: 7,
        enterTimeoutMs: 10000
    }));
    assert.strictEqual(hello.ups, 20);
    assert.strictEqual(hello.tickIndex, 7);

    const skills = decodeSkills(encodeSkills({
        fist: 10, club: 10, sword: 11, axe: 10,
        distance: 12, shielding: 10, magic: 0, fishing: 10
    }));
    assert.strictEqual(skills.sword, 11);
    assert.strictEqual(skills.distance, 12);
    assert.strictEqual(skills.magic, 0);

    const exp = decodeExp(encodeExp(100, 5, 2));
    assert.strictEqual(exp.experience, 100);
    assert.strictEqual(exp.gained, 5);
    assert.strictEqual(exp.level, 2);
    const expOld = decodeExp(encodeExp(20, 5));
    assert.strictEqual(expOld.experience, 20);
    assert.strictEqual(expOld.gained, 5);
    assert.ok(expOld.level == null);

    const map = createStaticMap();
    const vp = viewport(map, 12, 12);
    const ew = decodeEnterWorld(encodeEnterWorld({
        character: {
            id: 3, name: 'Ash', vocation: 'scout', level: 1, experience: 0,
            hp: 185, hpMax: 185, mp: 90, mpMax: 90, townId: 1
        },
        x: 12, y: 12, z: 0,
        viewport: vp
    }));
    assert.strictEqual(ew.name, 'Ash');
    assert.strictEqual(ew.x, 12);
    const lx = 12 - ew.viewport.originX;
    const ly = 12 - ew.viewport.originY;
    assert.strictEqual(ew.viewport.tiles[ly * ew.viewport.width + lx], TILE.SPAWN);

    const rej = decodeReject(encodeReject(9, 10));
    assert.strictEqual(rej.refSeq, 9);
    assert.strictEqual(rej.reason, 10);

    assert.strictEqual(decodeUseStair(Buffer.alloc(0)), true);
    assert.strictEqual(decodeUseStair(Buffer.from([1])), null);
    assert.strictEqual(C2S.USE_STAIR, 13);
    assert.strictEqual(C2S.USE, 14);
    assert.strictEqual(C2S.USE_ITEM_WITH, 15);
    assert.strictEqual(S2C.WORLD_PIN, 125);
    assert.strictEqual(S2C.WORLD_PIN_GONE, 126);

    const mv = decodeMove(encodeMove({ id: 3, x: 12, y: 11, z: 0, dir: 0 }));
    assert.strictEqual(mv.id, 3);
    assert.strictEqual(mv.y, 11);
    assert.strictEqual(mv.dir, 0);

    const vp2 = decodeViewport(encodeViewport(vp));
    assert.strictEqual(vp2.width, vp.width);
    assert.strictEqual(vp2.tiles[0], vp.tiles[0]);

    const st = decodeStats(encodeStats({
        id: 3, hp: 10, hpMax: 185, mp: 4, mpMax: 90
    }));
    assert.strictEqual(st.hp, 10);
    assert.strictEqual(st.mp, 4);

    const sw = decodeSwing(encodeSwing({
        sourceId: 3, targetId: 1000000000, amount: 4, flags: 2
    }));
    assert.strictEqual(sw.targetId, 1000000000);
    assert.strictEqual(sw.flags, 2);
    assert.strictEqual(sw.element, SWING_ELEMENT.PHYSICAL);
    assert.strictEqual(sw.weaponId, '');
    const sw2 = decodeSwing(encodeSwing({
        sourceId: 3, targetId: 1, amount: 6, flags: 4 | 8, element: 'fire', weaponId: 'ember_wand'
    }));
    assert.strictEqual(sw2.flags, 12);
    assert.strictEqual(sw2.element, SWING_ELEMENT.FIRE);
    assert.strictEqual(sw2.weaponId, 'ember_wand');
    const swOld = decodeSwing(Buffer.from([3, 0, 0, 0, 1, 0, 0, 0, 6, 0, 4]));
    assert.strictEqual(swOld.amount, 6);
    assert.strictEqual(swOld.flags, 4);
    assert.strictEqual(swOld.element, 0);

    const corpse = decodeCorpse(encodeCorpse({
        id: 2000000000, x: 12, y: 11, z: 0, name: 'Dummy'
    }));
    assert.strictEqual(corpse.name, 'Dummy');

    const bag = decodeContainer(encodeContainer({
        id: 2000000000,
        items: [{ id: 'gold_coin', count: 2 }]
    }));
    assert.strictEqual(bag.items[0].count, 2);

    const ap = decodeAppear(encodeAppear({
        id: 3, name: 'Ash', x: 12, y: 12, z: 0, hp: 185, hpMax: 185, dir: 3
    }));
    assert.strictEqual(ap.flags, 0);
    assert.strictEqual(ap.dir, 3);
    const npc = decodeAppear(encodeAppear({
        id: 9, name: 'Guide', x: 6, y: 12, z: 0, hp: 100, hpMax: 100, type: 'npc', isNpc: true
    }));
    assert.strictEqual(npc.flags, 1);
    assert.strictEqual(npc.dir, 0);
    const field = decodeField(encodeField({
        x: 14, y: 16, z: 7, kind: 'fire', createdTick: 40, source: 'player'
    }));
    assert.strictEqual(field.kind, 'fire');
    assert.strictEqual(field.flags, 2);
    assert.strictEqual(field.createdTick, 40);
    const fieldOld = decodeField(encodeField({ x: 1, y: 2, z: 0, kind: 'poison' }).subarray(0, -4));
    assert.strictEqual(fieldOld.kind, 'poison');
    assert.strictEqual(fieldOld.createdTick, null);

    const batched = Buffer.concat([
        encodeFrame(S2C.APPEAR, 1, encodeAppear({
            id: 2, name: 'Rat', x: 1, y: 2, z: 6, hp: 5, hpMax: 20, kind: 'rat', dir: 1
        })),
        encodeFrame(S2C.FIELD, 2, encodeField({
            x: 3, y: 4, z: 6, kind: 'energy', createdTick: 80
        })),
        encodeFrame(S2C.SWING, 3, encodeSwing({
            sourceId: 2, targetId: 3, amount: 7, flags: 0, element: 'energy', weaponId: 'spark_wand'
        })),
        encodeFrame(S2C.SAY, 4, encodeSay('Need directions?', { speakerId: 2, yell: true }))
    ]);
    const parsed = decodeFrames(batched);
    assert.strictEqual(parsed.length, 4);
    assert.strictEqual(decodeAppear(parsed[0].payload).dir, 1);
    assert.strictEqual(decodeField(parsed[1].payload).createdTick, 80);
    assert.strictEqual(decodeSwing(parsed[2].payload).element, SWING_ELEMENT.ENERGY);
    assert.strictEqual(decodeSwing(parsed[2].payload).weaponId, 'spark_wand');
    assert.strictEqual(decodeSay(parsed[3].payload).speakerId, 2);
    assert.strictEqual(decodeSay(parsed[3].payload).yell, true);

    const inv = decodeInventory(encodeInventory([{ id: 'gold_coin', count: 4 }]));
    assert.strictEqual(inv.slots[0].count, 4);
    const eq = decodeEquipment(encodeEquipment({
        cap: 582, capMax: 600, slots: [{ slot: 'weapon', id: 'iron_longsword', count: 1, flags: 0 }]
    }));
    assert.strictEqual(eq.slots[0].id, 'iron_longsword');
    assert.strictEqual(eq.slots[0].flags, 0);
    const eqBag = decodeEquipment(encodeEquipment({
        cap: 1, capMax: 2, slots: [{ slot: 'shield', id: 'quiver', count: 1, flags: 1 }]
    }));
    assert.strictEqual(eqBag.slots[0].flags, 1);
    const saySys = decodeSay(encodeSay('You cannot afford that.'));
    assert.strictEqual(saySys.text, 'You cannot afford that.');
    assert.strictEqual(saySys.speakerId, 0);
    assert.strictEqual(saySys.yell, false);
    const sayVoice = decodeSay(encodeSay('Need directions?', { speakerId: 9, yell: true }));
    assert.strictEqual(sayVoice.text, 'Need directions?');
    assert.strictEqual(sayVoice.speakerId, 9);
    assert.strictEqual(sayVoice.yell, true);
    const sayOld = decodeSay(encodeSay('Need directions?', { speakerId: 9, yell: true }).subarray(0, -5));
    assert.strictEqual(sayOld.text, 'Need directions?');
    assert.strictEqual(sayOld.speakerId, 0);
    assert.strictEqual(sayOld.yell, false);
    const dlg = decodeDialog(encodeDialog({
        npcId: 9, nodeId: 'start', text: 'Hi', replies: [{ label: 'Bye' }]
    }));
    assert.strictEqual(dlg.replies[0].label, 'Bye');
    const shop = decodeShop(encodeShop({
        npcId: 9, currency: 'gold_coin', items: [{ itemId: 'cookie', buy: 2, sell: 1 }]
    }));
    assert.strictEqual(shop.items[0].buy, 2);

    assert.strictEqual(decodeEnterWorld(Buffer.from([1, 2, 3])), null);
    console.log('ok frame');
}

main();

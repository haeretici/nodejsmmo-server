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
    encodeCast,
    decodeCastFx,
    decodeSwing,
    decodeReject,
    decodeSay,
    decodeField
} = require('../src/protocol/messages');
const { TILE_FLAG_NO_CAST } = require('../src/world/tilemap');
const { addItemToInventory, countItem } = require('../src/world/inventory');
const { getFieldOnTile } = require('../src/world/fields');
const { loadPack, resolveContentPath } = require('../src/content/load_pack');
const { SERVER_ROOT } = require('../src/config/load_settings');
const { createStaticMap } = require('../src/world/static_map');

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

function mysticPack() {
    return {
        features: { runeConsumption: true, skillProgression: true, expProgression: true },
        classes: {
            classes: [{
                id: 'mystic',
                hpPerLevel: 10,
                mpPerLevel: 10,
                critChance: 5,
                critDamage: 10,
                spells: ['snap_jab', 'blaze_field_rune'],
                skillRates: { melee: 1.4, fist: 1.1, magic: 1.25 }
            }]
        },
        spells: {
            spells: [
                {
                    id: 'snap_jab',
                    kind: 'strike',
                    element: 'physical',
                    powerCurve: 'melee_strike',
                    basePower: 12,
                    range: 1,
                    mana: 3,
                    hitChance: 100,
                    isMelee: true,
                    requiresTarget: true,
                    vocations: ['mystic'],
                    level: 1,
                    damageAmplitude: 0.1726,
                    cooldowns: { primary: { attack: 2 } }
                },
                {
                    id: 'blaze_field_rune',
                    kind: 'spell',
                    element: 'fire',
                    min: 0,
                    max: 0,
                    statusOnly: true,
                    range: 7,
                    mana: 0,
                    hitChance: 100,
                    source: 'rune',
                    runeItemId: 'blaze_field_rune',
                    deploysField: 'fire',
                    field: 'fire',
                    allowFarUse: true,
                    vocations: ['mystic'],
                    level: 1,
                    shape: { type: 'area', code: 1 },
                    cooldowns: { primary: { attack: 2 } }
                }
            ]
        },
        equipment: {
            items: [
                { id: 'blaze_field_rune', name: 'Blaze Field Rune', stack: 100, category: 'rune', type: ['rune'] }
            ]
        }
    };
}

function makeWorld(extra) {
    const settings = testSettings();
    if (extra) Object.assign(settings, extra);
    const pack = extra && extra.pack ? extra.pack : mysticPack();
    const map = extra && extra.map
        ? extra.map
        : (pack && pack.maps ? undefined : createStaticMap());
    const world = new World({
        settings,
        store: extra && extra.store ? extra.store : new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        rng: extra && extra.rng ? extra.rng : (() => 0.5),
        pack,
        map
    });
    world.start();
    return world;
}

function makeSession(world, ch, pos) {
    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter(ch, pos || world.spawnPos(ch));
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
        vocation: 'mystic',
        level: 8,
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
        autoIntervalTicks: 40,
        spawns: [{ kind: 'dummy', x: 12, y: 11, z: 0 }]
    });
    const session = makeSession(w, ash(1));
    const dummy = Array.from(w.creatures.values())[0];
    assert.ok(dummy);
    dummy.hp = 20;
    dummy.hpMax = 20;
    const beforeMp = session.mp | 0;
    assert.ok(w.enqueueIntent(session, {
        opcode: C2S.CAST,
        seq: 1,
        payload: encodeCast({ spellId: 'snap_jab', targetId: dummy.id, x: dummy.x, y: dummy.y, z: dummy.z })
    }));
    w.step(1);
    assert.strictEqual(dummy.hp, 15);
    assert.strictEqual(session.mp, beforeMp - 3);
    const fx = decodeCastFx(lastOf(session.socket, S2C.CAST).payload);
    assert.strictEqual(fx.spellId, 'snap_jab');
    assert.strictEqual(fx.sourceId, session.id);
    let swing = null;
    for (let i = session.socket.sent.length - 1; i >= 0; i--) {
        const f = decodeFrame(session.socket.sent[i]);
        if (f.opcode !== S2C.SWING) continue;
        const sw = decodeSwing(f.payload);
        if (sw && sw.sourceId === session.id) {
            swing = sw;
            break;
        }
    }
    assert.ok(swing);
    assert.strictEqual(swing.targetId, dummy.id);
    assert.strictEqual(swing.amount, 5);

    assert.ok(w.enqueueIntent(session, {
        opcode: C2S.CAST,
        seq: 2,
        payload: encodeCast({ spellId: 'snap_jab', targetId: dummy.id, x: dummy.x, y: dummy.y, z: dummy.z })
    }));
    w.step(2);
    const tired = decodeSay(lastOf(session.socket, S2C.SAY).payload);
    assert.strictEqual(tired, 'You are exhausted.');
    session.kick(REASON.LOGOUT);
    w.stop();

    const w2 = makeWorld({
        autoIntervalTicks: 40,
        spawns: [{ kind: 'dummy', x: 12, y: 11, z: 0 }]
    });
    const caster = makeSession(w2, ash(2));
    w2.tileMap.setTileFlags(caster.x, caster.y, caster.z, TILE_FLAG_NO_CAST);
    const dummy2 = Array.from(w2.creatures.values())[0];
    assert.ok(w2.enqueueIntent(caster, {
        opcode: C2S.CAST,
        seq: 1,
        payload: encodeCast({ spellId: 'snap_jab', targetId: dummy2.id, x: dummy2.x, y: dummy2.y, z: dummy2.z })
    }));
    w2.step(1);
    const pz = decodeReject(lastOf(caster.socket, S2C.REJECT).payload);
    assert.ok(pz);
    assert.strictEqual(pz.reason, REASON.BLOCKED);
    assert.strictEqual(dummy2.hp, dummy2.hpMax);
    caster.kick(REASON.LOGOUT);
    w2.stop();

    const w3 = makeWorld({
        autoIntervalTicks: 40,
        spawns: [{ kind: 'dummy', x: 12, y: 11, z: 0 }]
    });
    const fieldCaster = makeSession(w3, ash(3));
    addItemToInventory(fieldCaster.inventory, 'blaze_field_rune', 2, w3.itemDb());
    const dummy3 = Array.from(w3.creatures.values())[0];
    dummy3.hp = 100;
    dummy3.hpMax = 100;
    assert.ok(w3.enqueueIntent(fieldCaster, {
        opcode: C2S.CAST,
        seq: 1,
        payload: encodeCast({
            spellId: 'blaze_field_rune',
            targetId: dummy3.id,
            x: dummy3.x,
            y: dummy3.y,
            z: dummy3.z
        })
    }));
    w3.step(1);
    const planted = getFieldOnTile(w3.fieldStore, dummy3.x, dummy3.y, dummy3.z);
    assert.ok(planted);
    assert.strictEqual(planted.fieldKind, 'fire');
    assert.strictEqual(dummy3.hp, 80);
    assert.ok(dummy3.conditions && dummy3.conditions.some((c) => c.kind === 'fire'));
    assert.strictEqual(countItem(fieldCaster.inventory, 'blaze_field_rune'), 1);
    const fieldMsg = decodeField(lastOf(fieldCaster.socket, S2C.FIELD).payload);
    assert.strictEqual(fieldMsg.kind, 'fire');
    fieldCaster.kick(REASON.LOGOUT);
    w3.stop();

    const root = resolveContentPath({ contentPath: '../content' }, SERVER_ROOT);
    const pack = loadPack(root);
    let cells = 0;
    for (const z of Object.keys(pack.map.floors)) {
        const f = pack.map.floors[z].fields;
        if (!f) continue;
        for (let i = 0; i < f.length; i++) if (f[i]) cells += 1;
    }
    assert.ok(cells >= 1);
    const live = makeWorld({ pack });
    let seeded = 0;
    const keys = Object.keys(live.fieldStore.byKey);
    for (let i = 0; i < keys.length; i++) {
        if (live.fieldStore.byKey[keys[i]] && live.fieldStore.byKey[keys[i]].field) seeded += 1;
    }
    assert.strictEqual(seeded, cells);
    live.stop();

    console.log('ok spells_world');
}

main();

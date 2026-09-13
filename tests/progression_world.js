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
const { decodeExp, decodeSkills, decodeSay } = require('../src/protocol/messages');
const { createStaticMap } = require('../src/world/static_map');
const { TEMPLATES } = require('../src/world/templates');

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

function stubPack() {
    return {
        features: { expProgression: true, skillProgression: true },
        classes: {
            classes: [{
                id: 'scout',
                hpPerLevel: 10,
                mpPerLevel: 15,
                critChance: 5,
                critDamage: 10,
                skillRates: {
                    melee: 1.2, fist: 1.2, distance: 1.1, shielding: 1.1, magic: 1.4
                }
            }]
        }
    };
}

function makeWorld(extra) {
    const settings = testSettings();
    if (extra) Object.assign(settings, extra);
    const world = new World({
        settings,
        store: extra && extra.store ? extra.store : new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        rng: extra && extra.rng ? extra.rng : (() => 0.5),
        templates: extra && extra.templates,
        pack: extra && extra.pack,
        map: extra && extra.map
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

function makeSession(world, ch, pos, extras) {
    const session = new GameSession({
        socket: fakeSocket(),
        ip: '127.0.0.1',
        world,
        settings: world.settings,
        limiter: new RateLimiter(),
        log: world.log
    });
    session.bindCharacter(ch, pos || world.spawnPos(ch), extras);
    assert.ok(world.add(session));
    world.sendEnterWorld(session);
    world.syncAppears(session);
    return session;
}

function dummyTpl(patch) {
    return Object.assign({}, TEMPLATES.dummy, patch || {});
}

async function main() {
    const w = makeWorld({
        autoIntervalTicks: 1,
        pack: stubPack(),
        map: createStaticMap(),
        templates: { dummy: dummyTpl({ exp: 100, hp: 1, hpMax: 1 }) },
        spawns: [{ kind: 'dummy', x: 12, y: 11, z: 0 }]
    });
    const session = makeSession(w, ash(1));
    assert.strictEqual(session.level, 1);
    assert.strictEqual(session.hpMax, 185);
    const dummy = Array.from(w.creatures.values())[0];
    dummy.hp = 1;
    assert.ok(w.enqueueIntent(session, {
        opcode: C2S.SET_TARGET, seq: 1, payload: u32(dummy.id)
    }));
    w.step(1);
    assert.strictEqual(session.experience, 100);
    assert.strictEqual(session.level, 2);
    assert.strictEqual(session.hpMax, 195);
    const exp = decodeExp(lastOf(session.socket, S2C.EXP).payload);
    assert.strictEqual(exp.gained, 100);
    assert.strictEqual(exp.experience, 100);
    assert.strictEqual(exp.level, 2);
    const say = decodeSay(lastOf(session.socket, S2C.SAY).payload);
    assert.ok(String(say).indexOf('level 2') >= 0);
    session.kick(REASON.LOGOUT);
    w.stop();

    const store = new MemoryStore();
    const acc = await store.createAccount({ email: 'prog@example.com', passwordHash: 'phc' });
    const ch = await store.createCharacter({
        accountId: acc.id,
        name: 'Ash',
        vocation: 'scout',
        level: 1,
        experience: 0,
        posX: 12, posY: 12, posZ: 0,
        hp: 185, hpMax: 185, mp: 90, mpMax: 90,
        townId: 1,
        skills: {
            fist: 10, club: 10, sword: 10, axe: 10,
            distance: 10, shielding: 10, magic: 0, fishing: 10
        },
        inventory: { items: [] },
        storage: {}
    });
    const w2 = makeWorld({
        autoIntervalTicks: 1,
        store,
        pack: stubPack(),
        map: createStaticMap(),
        templates: { dummy: dummyTpl({ exp: 100, hp: 20, hpMax: 20, armor: 0, mitigation: 0 }) },
        spawns: [{ kind: 'dummy', x: 12, y: 11, z: 0 }]
    });
    const hunter = makeSession(w2, ch, w2.spawnPos(ch), {
        state: await store.loadCharacterState(ch.id),
        skills: await store.loadSkills(ch.id)
    });
    hunter._skillTryProgress.fist = 49;
    const d2 = Array.from(w2.creatures.values())[0];
    d2.hp = 1;
    assert.ok(w2.enqueueIntent(hunter, {
        opcode: C2S.SET_TARGET, seq: 1, payload: u32(d2.id)
    }));
    w2.step(1);
    assert.strictEqual(hunter.skills.fist, 11);
    assert.strictEqual(hunter.level, 2);
    const skillsPkt = decodeSkills(lastOf(hunter.socket, S2C.SKILLS).payload);
    assert.strictEqual(skillsPkt.fist, 11);
    hunter.kick(REASON.LOGOUT);
    await w2.flushPersist();
    w2.stop();

    const saved = await store.findCharacter(acc.id, ch.id);
    assert.strictEqual(saved.level, 2);
    assert.strictEqual(saved.experience, 100);
    const savedSkills = await store.loadSkills(ch.id);
    assert.strictEqual(savedSkills.fist, 11);
    assert.ok(savedSkills.fistTries >= 0);

    const w3 = makeWorld({
        store,
        pack: stubPack(),
        map: createStaticMap(),
        spawns: []
    });
    const ch2 = await store.findCharacter(acc.id, ch.id);
    const s2 = makeSession(w3, ch2, w3.spawnPos(ch2), {
        state: await store.loadCharacterState(ch.id),
        skills: await store.loadSkills(ch.id)
    });
    assert.strictEqual(s2.level, 2);
    assert.strictEqual(s2.experience, 100);
    assert.strictEqual(s2.skills.fist, 11);
    s2.kick(REASON.LOGOUT);
    w3.stop();

    const w4 = makeWorld({
        autoIntervalTicks: 1,
        pack: stubPack(),
        map: createStaticMap(),
        templates: { dummy: dummyTpl({ exp: 100, hp: 1, hpMax: 1 }) },
        spawns: [{ kind: 'dummy', x: 12, y: 11, z: 0 }]
    });
    w4.settings.features = Object.assign({}, w4.settings.features, {
        expProgression: false,
        skillProgression: false
    });
    const off = makeSession(w4, ash(40));
    const d4 = Array.from(w4.creatures.values())[0];
    d4.hp = 1;
    w4.enqueueIntent(off, { opcode: C2S.SET_TARGET, seq: 1, payload: u32(d4.id) });
    w4.step(1);
    assert.strictEqual(off.experience, 100);
    assert.strictEqual(off.level, 1, 'flag off does not level');
    assert.strictEqual(off.skills.fist, 10);
    off.kick(REASON.LOGOUT);
    w4.stop();

    console.log('ok progression_world');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

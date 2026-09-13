'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C, REASON, SWING_FLAG } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');
const {
    decodeReject,
    decodeAppear,
    decodeSwing,
    decodeDeath,
    decodeCorpse,
    decodeContainer,
    decodeItemGain,
    decodeExp,
    decodeStats,
    decodeMove
} = require('../src/protocol/messages');
const { countItem } = require('../src/world/inventory');

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

function lastSwingFrom(sock, sourceId) {
    for (let i = sock.sent.length - 1; i >= 0; i--) {
        const f = decodeFrame(sock.sent[i]);
        if (f.opcode !== S2C.SWING) continue;
        const sw = decodeSwing(f.payload);
        if (sw && sw.sourceId === sourceId) return sw;
    }
    return null;
}

function u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
}

function makeWorld(extra) {
    const settings = testSettings();
    if (extra) Object.assign(settings, extra);
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        rng: extra && extra.rng ? extra.rng : (() => 0.5),
        templates: extra && extra.templates
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
        autoIntervalTicks: 1,
        spawns: [{ kind: 'dummy', x: 12, y: 11, z: 0 }]
    });
    const session = makeSession(w, ash(1));
    const dummy = Array.from(w.creatures.values())[0];
    assert.ok(dummy);
    assert.strictEqual(dummy.name, 'Dummy');
    const appear = decodeAppear(lastOf(session.socket, S2C.APPEAR).payload);
    assert.strictEqual(appear.name, 'Dummy');
    dummy.hp = 1;

    assert.ok(w.enqueueIntent(session, {
        opcode: C2S.SET_TARGET, seq: 1, payload: u32(dummy.id)
    }));
    w.step(1);
    assert.strictEqual(dummy.hp, 0);
    assert.strictEqual(w.creatures.size, 0);
    const swing = decodeSwing(lastOf(session.socket, S2C.SWING).payload);
    assert.strictEqual(swing.targetId, dummy.id);
    assert.ok(swing.amount >= 1);
    const death = decodeDeath(lastOf(session.socket, S2C.DEATH).payload);
    assert.strictEqual(death.id, dummy.id);
    const corpse = decodeCorpse(lastOf(session.socket, S2C.CORPSE).payload);
    assert.strictEqual(corpse.name, 'Dummy');
    const exp = decodeExp(lastOf(session.socket, S2C.EXP).payload);
    assert.strictEqual(exp.gained, 5);
    assert.strictEqual(session.experience, 5);

    const corpseId = Array.from(w.corpses.values())[0].id;
    assert.ok(w.enqueueIntent(session, {
        opcode: C2S.OPEN_CORPSE, seq: 2, payload: u32(corpseId)
    }));
    w.step(2);
    const bag = decodeContainer(lastOf(session.socket, S2C.CONTAINER).payload);
    assert.strictEqual(bag.items[0].id, 'gold_coin');
    const take = Buffer.alloc(5);
    take.writeUInt32LE(corpseId, 0);
    take.writeUInt8(0, 4);
    assert.ok(w.enqueueIntent(session, {
        opcode: C2S.LOOT_TAKE, seq: 3, payload: take
    }));
    w.step(3);
    const gain = decodeItemGain(lastOf(session.socket, S2C.ITEM_GAIN).payload);
    assert.strictEqual(gain.id, 'gold_coin');
    assert.strictEqual(countItem(session.inventory, 'gold_coin'), 1);
    session.kick(REASON.LOGOUT);
    w.stop();

    const w2 = makeWorld({ spawns: [] });
    const a = makeSession(w2, ash(10));
    const b = makeSession(w2, {
        id: 11, accountId: 11, name: 'Bo', vocation: 'guardian',
        level: 1, experience: 0, hp: 185, hpMax: 185, mp: 90, mpMax: 90, townId: 1
    });
    assert.ok(w2.enqueueIntent(a, {
        opcode: C2S.SET_TARGET, seq: 1, payload: u32(b.id)
    }));
    w2.step(1);
    const pvp = decodeReject(lastOf(a.socket, S2C.REJECT).payload);
    assert.strictEqual(pvp.reason, REASON.BLOCKED);
    assert.ok(w2.enqueueIntent(a, {
        opcode: C2S.SET_TARGET, seq: 2, payload: u32(99)
    }));
    w2.step(2);
    const missing = decodeReject(lastOf(a.socket, S2C.REJECT).payload);
    assert.strictEqual(missing.reason, REASON.NO_TARGET);
    a.kick(REASON.LOGOUT);
    b.kick(REASON.LOGOUT);
    w2.stop();

    const w3 = makeWorld({
        creatureStepDelayTicks: 1,
        autoIntervalTicks: 1,
        spawns: [{ kind: 'rat', x: 12, y: 10, z: 0 }]
    });
    const hunter = makeSession(w3, ash(20));
    const rat = Array.from(w3.creatures.values())[0];
    assert.strictEqual(rat.y, 10);
    w3.step(1);
    w3.step(2);
    assert.strictEqual(rat.y, 11);
    assert.ok(meleeAdj(hunter, rat));
    const hpBefore = hunter.hp;
    w3.step(3);
    assert.ok(hunter.hp < hpBefore);
    hunter.kick(REASON.LOGOUT);
    w3.stop();

    const w4 = makeWorld({
        autoIntervalTicks: 1,
        deathDelayTicks: 2,
        spawns: [{ kind: 'rat', x: 12, y: 11, z: 0 }]
    });
    const victim = makeSession(w4, ash(30));
    victim.hp = 1;
    victim.character.hp = 1;
    const r2 = Array.from(w4.creatures.values())[0];
    w4.step(1);
    assert.ok(victim.downed);
    assert.strictEqual(w4.tileMap.getOccupant(12, 12, 0), 0);
    assert.ok(lastOf(victim.socket, S2C.DEATH));
    w4.step(2);
    assert.ok(victim.downed);
    w4.step(3);
    assert.strictEqual(victim.downed, false);
    assert.strictEqual(victim.hp, victim.hpMax);
    assert.strictEqual(w4.tileMap.getOccupant(victim.x, victim.y, victim.z), 30);
    const stats = decodeStats(lastOf(victim.socket, S2C.STATS).payload);
    assert.strictEqual(stats.hp, 185);
    assert.ok(decodeMove(lastOf(victim.socket, S2C.MOVE).payload));
    victim.kick(REASON.LOGOUT);
    w4.stop();

    const w5 = makeWorld({
        corpseDecayTicks: 2,
        autoIntervalTicks: 1,
        spawns: [{ kind: 'dummy', x: 12, y: 11, z: 0 }]
    });
    const looter = makeSession(w5, ash(40));
    const d2 = Array.from(w5.creatures.values())[0];
    d2.hp = 1;
    w5.enqueueIntent(looter, { opcode: C2S.SET_TARGET, seq: 1, payload: u32(d2.id) });
    w5.step(1);
    assert.strictEqual(w5.corpses.size, 1);
    w5.step(2);
    assert.strictEqual(w5.corpses.size, 1);
    w5.step(3);
    assert.strictEqual(w5.corpses.size, 0);
    assert.ok(lastOf(looter.socket, S2C.CORPSE_GONE));
    looter.kick(REASON.LOGOUT);
    w5.stop();

    const critterTpl = {
        id: 'critter',
        label: 'Critter',
        hp: 50,
        hpMax: 50,
        armor: 0,
        mitigation: 0,
        maxBlock: 0,
        canBlock: false,
        exp: 1,
        aggro: true,
        resists: { physical: 0 },
        critChance: 100,
        critDamage: 10,
        flags: { targetDistance: 1, aggroRange: 7, loseTargetDistance: 12 },
        attacks: [{
            id: 'melee_0',
            kind: 'melee',
            intervalMs: 2000,
            chance: 100,
            range: 1,
            element: 'physical',
            min: 10,
            max: 10
        }],
        loot: []
    };
    const w6 = makeWorld({
        autoIntervalTicks: 1,
        templates: { critter: critterTpl },
        spawns: [{ kind: 'critter', x: 12, y: 11, z: 0 }],
        rng: () => 0
    });
    const critHunter = makeSession(w6, ash(50));
    const critter = Array.from(w6.creatures.values())[0];
    assert.strictEqual(critter.critChance, 100);
    const hpBeforeCrit = critHunter.hp;
    w6.step(1);
    assert.strictEqual(critHunter.hp, hpBeforeCrit - 11);
    const critSwing = decodeSwing(lastOf(critHunter.socket, S2C.SWING).payload);
    assert.strictEqual(critSwing.amount, 11);
    assert.strictEqual(critSwing.flags & SWING_FLAG.CRIT, SWING_FLAG.CRIT);
    assert.strictEqual(critSwing.flags & SWING_FLAG.FATAL, 0);
    critHunter.kick(REASON.LOGOUT);
    w6.stop();

    const w7 = makeWorld({
        autoIntervalTicks: 1,
        spawns: [{ kind: 'dummy', x: 12, y: 11, z: 0 }],
        rng: () => 0
    });
    const slayer = makeSession(w7, ash(60));
    slayer.weaponTier = 1;
    const dummy7 = Array.from(w7.creatures.values())[0];
    dummy7.hp = 100;
    dummy7.hpMax = 100;
    assert.ok(w7.enqueueIntent(slayer, {
        opcode: C2S.SET_TARGET, seq: 1, payload: u32(dummy7.id)
    }));
    w7.step(1);
    assert.strictEqual(dummy7.hp, 94);
    const fatalSwing = lastSwingFrom(slayer.socket, slayer.id);
    assert.ok(fatalSwing);
    assert.strictEqual(fatalSwing.amount, 6);
    assert.strictEqual(fatalSwing.flags & SWING_FLAG.FATAL, SWING_FLAG.FATAL);
    assert.strictEqual(fatalSwing.flags & SWING_FLAG.CRIT, 0);
    slayer.weaponTier = 0;
    dummy7.hp = 100;
    w7.enqueueIntent(slayer, { opcode: C2S.SET_TARGET, seq: 2, payload: u32(dummy7.id) });
    w7.step(2);
    assert.strictEqual(dummy7.hp, 96);
    const noFatal = lastSwingFrom(slayer.socket, slayer.id);
    assert.strictEqual(noFatal.amount, 4);
    assert.strictEqual(noFatal.flags & SWING_FLAG.FATAL, 0);
    slayer.kick(REASON.LOGOUT);
    w7.stop();

    console.log('ok combat_world');
}

function meleeAdj(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1;
}

main();

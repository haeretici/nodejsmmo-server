'use strict';

const assert = require('assert');
const { loadPack, resolveContentPath } = require('../src/content/load_pack');
const { testSettings, SERVER_ROOT } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C, SWING_FLAG, SWING_ELEMENT } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');
const { decodeSwing, decodeStats } = require('../src/protocol/messages');
const { resolveWandAuto, computeMagicStrikeRange, WAND_AUTO_FALLBACK_BASE_POWER } = require('../src/world/combat');
const { hasLineOfSight } = require('../src/world/shapes');
const {
    applyPlayerLoadout,
    createItemInstance,
    placeInEquipment,
    unequipItem
} = require('../src/world/inventory');
const { findItem } = require('../src/world/items');

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

function makeWorld(extra) {
    const settings = testSettings();
    if (extra) Object.assign(settings, extra);
    const pack = extra && extra.pack !== undefined
        ? extra.pack
        : loadPack(resolveContentPath({ contentPath: '../content' }, SERVER_ROOT));
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        rng: extra && extra.rng ? extra.rng : (() => 0.5),
        templates: extra && extra.templates,
        pack
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

function readyAuto(session) {
    session.attackReadyTick = 0;
    session.moveReadyTick = 0;
}

function adept(id, opts) {
    const o = opts || {};
    return {
        id: id || 1,
        accountId: id || 1,
        name: 'Merlin',
        vocation: 'adept',
        level: o.level || 1,
        experience: 0,
        hp: 150,
        hpMax: 150,
        mp: o.mp != null ? o.mp : 50,
        mpMax: o.mpMax != null ? o.mpMax : 100,
        townId: 1,
        skills: {
            magic: o.magicSkill != null ? o.magicSkill : 10
        }
    };
}

function main() {
    // -------------------------------------------------------------------------
    // 1. Direct combat unit test of resolveWandAuto
    // -------------------------------------------------------------------------
    const lowAttacker = {
        type: 'player',
        level: 1,
        skills: { magic: 10 },
        weaponMin: 1,
        weaponMax: 10,
        weaponElement: 'fire',
        weaponManaGain: 2
    };

    const highAttacker = {
        type: 'player',
        level: 500,
        skills: { magic: 120 },
        weaponMin: 1,
        weaponMax: 10,
        weaponElement: 'fire',
        weaponManaGain: 2
    };

    const unarmoredDummy = {
        type: 'creature',
        armor: 0,
        mitigation: 0,
        resists: { fire: 0 }
    };

    // Verify Ember Wand rolls [1, 10] regardless of player level or skill
    const lowMin = resolveWandAuto(lowAttacker, unarmoredDummy, () => 0);
    const highMin = resolveWandAuto(highAttacker, unarmoredDummy, () => 0);
    assert.strictEqual(lowMin.raw, 1, 'min roll should be exactly 1');
    assert.strictEqual(highMin.raw, 1, 'high level min roll should be exactly 1');
    assert.strictEqual(lowMin.final, 1);
    assert.strictEqual(highMin.final, 1);
    assert.strictEqual(lowMin.element, 'fire');
    assert.strictEqual(lowMin.manaGain, 2);

    const lowMax = resolveWandAuto(lowAttacker, unarmoredDummy, () => 0.999999);
    const highMax = resolveWandAuto(highAttacker, unarmoredDummy, () => 0.999999);
    assert.strictEqual(lowMax.raw, 10, 'max roll should be exactly 10');
    assert.strictEqual(highMax.raw, 10, 'high level max roll should be exactly 10');
    assert.strictEqual(lowMax.final, 10);
    assert.strictEqual(highMax.final, 10);

    const lowMid = resolveWandAuto(lowAttacker, unarmoredDummy, () => 0.5);
    const highMid = resolveWandAuto(highAttacker, unarmoredDummy, () => 0.5);
    assert.strictEqual(lowMid.raw, highMid.raw, 'rolls should be identical between level 1 and 500');
    assert.ok(lowMid.raw >= 1 && lowMid.raw <= 10);

    // Verify fire damage bypasses armor reduction and shield block
    const heavyDefender = {
        type: 'creature',
        armor: 100,
        mitigation: 0,
        maxBlock: 50,
        canBlock: true,
        resists: { fire: 0 }
    };
    const bypassedHit = resolveWandAuto(lowAttacker, heavyDefender, () => 0.5);
    assert.strictEqual(bypassedHit.shieldBlock, 0, 'magic auto must bypass shield block');
    assert.strictEqual(bypassedHit.armorReduction, 0, 'magic auto must bypass armor reduction');
    assert.strictEqual(bypassedHit.blockChargeSpent, false);
    assert.strictEqual(bypassedHit.final, bypassedHit.raw, 'final damage should equal raw damage when resists=0 and mit=0');

    // Verify fire damage is mitigated by creature fire resistance
    const resistantDefender = {
        type: 'creature',
        armor: 100,
        mitigation: 0,
        resists: { fire: 50 }
    };
    const resistHit = resolveWandAuto(lowAttacker, resistantDefender, () => 0.999999);
    assert.strictEqual(resistHit.raw, 10);
    assert.strictEqual(resistHit.final, 5, '50% fire resist on 10 raw should yield 5 final damage');
    assert.strictEqual(resistHit.manaGain, 2);

    const immuneDefender = {
        type: 'creature',
        armor: 0,
        mitigation: 0,
        resists: { fire: 100 }
    };
    const immuneHit = resolveWandAuto(lowAttacker, immuneDefender, () => 0.999999);
    assert.strictEqual(immuneHit.raw, 10);
    assert.strictEqual(immuneHit.final, 0, '100% fire resist yields 0 final damage');
    assert.strictEqual(immuneHit.manaGain, 0, 'manaGain must be 0 when final damage is 0');

    // Verify miss result
    const missHit = resolveWandAuto(lowAttacker, unarmoredDummy, () => 0.5, { hit: false });
    assert.strictEqual(missHit.miss, true);
    assert.strictEqual(missHit.hit, false);
    assert.strictEqual(missHit.raw, 0);
    assert.strictEqual(missHit.final, 0);
    assert.strictEqual(missHit.manaGain, 0);

    // -------------------------------------------------------------------------
    // 2. Inventory Loadout Extraction for Ember Wand
    // -------------------------------------------------------------------------
    const w = makeWorld({ autoIntervalTicks: 1 });
    const session = makeSession(w, adept(1, { mp: 50, mpMax: 100 }));
    const itemDb = w.itemDb();

    const emberWandItem = findItem(itemDb, 'ember_wand');
    assert.ok(emberWandItem, 'ember_wand must exist in itemDb');
    assert.strictEqual(emberWandItem.weaponType, 'magic');
    assert.strictEqual(emberWandItem.element, 'fire');
    assert.strictEqual(emberWandItem.min, 1);
    assert.strictEqual(emberWandItem.max, 10);
    assert.strictEqual(emberWandItem.range, 4);
    assert.strictEqual(emberWandItem.manaGain, 2);

    const wandUid = createItemInstance(session.inventory, 'ember_wand', itemDb);
    const equipRes = placeInEquipment(session.inventory, wandUid, 'rightHand', itemDb);
    assert.ok(equipRes.ok, 'placing ember_wand in rightHand should succeed');
    applyPlayerLoadout(session, itemDb);

    assert.strictEqual(session.weaponType, 'magic', 'session.weaponType must be magic');
    assert.strictEqual(session.weaponMin, 1);
    assert.strictEqual(session.weaponMax, 10);
    assert.strictEqual(session.weaponElement, 'fire');
    assert.strictEqual(session.weaponRange, 4);
    assert.strictEqual(session.weaponManaGain, 2);
    assert.strictEqual(session.weaponSkill, 'magic');

    // -------------------------------------------------------------------------
    // 3. World Integration: Range & LOS & MP Restoration & Progression
    // -------------------------------------------------------------------------
    // Position player at (77, 99, 6) - open meadow on floor 6
    session.x = 77;
    session.y = 99;
    session.z = 6;
    session.attackReadyTick = 0;

    const dummy = {
        id: 9999,
        type: 'creature',
        name: 'Target Dummy',
        x: 77,
        y: 99,
        z: 6,
        hp: 100,
        hpMax: 100,
        armor: 50,
        mitigation: 0,
        resists: { fire: 0 },
        dead: false,
        downed: false
    };
    w.creatures.set(dummy.id, dummy);

    // Attacks succeed at distance 2, 3, 4
    for (const dist of [2, 3, 4]) {
        dummy.x = 77 + dist;
        dummy.y = 99;
        readyAuto(session);
        const swung = w.trySwing(session, dummy, 1);
        assert.ok(swung, `wand auto should succeed at distance ${dist}`);
    }
    const wandWire = w.swingWire(session, dummy, 4, 0, { element: 'fire' });
    assert.strictEqual(wandWire.element, 'fire');
    assert.strictEqual(wandWire.weaponId, 'ember_wand');
    assert.strictEqual(SWING_ELEMENT.FIRE, 1);

    // Attacks fail at distance 5 (Ember Wand range is 4)
    dummy.x = 77 + 5;
    dummy.y = 99;
    readyAuto(session);
    const swungDist5 = w.trySwing(session, dummy, 2);
    assert.strictEqual(swungDist5, false, 'wand auto must fail at distance 5');

    // Attacks are blocked by solid walls (LOS failure)
    dummy.x = 80;
    dummy.y = 99; // distance 3
    const layer = w.tileMap.getLayer(6);
    assert.ok(layer, 'tileMap layer 6 must exist');

    // Place solid sight blocker at (78, 99, 6) between player (77, 99) and dummy (80, 99)
    const wallIdx = w.tileMap.index(78, 99, layer.cols);
    const origSight = layer.sight[wallIdx];
    layer.sight[wallIdx] = 255;
    readyAuto(session);

    const swungBlocked = w.trySwing(session, dummy, 3);
    assert.strictEqual(swungBlocked, false, 'attacks must be blocked by solid sight blocker');

    // Clear wall blocker
    layer.sight[wallIdx] = origSight;
    readyAuto(session);
    const swungCleared = w.trySwing(session, dummy, 4);
    assert.ok(swungCleared, 'attacks must succeed after sight blocker is cleared');

    // Verify player recovers manaGain MP on hit
    session.mp = 50;
    session.mpMax = 100;
    dummy.hp = 100;
    dummy.x = 79;
    dummy.y = 99; // distance 2, clear line of sight
    readyAuto(session);

    const beforeMp = session.mp;
    const mpSwung = w.trySwing(session, dummy, 5);
    assert.ok(mpSwung);
    assert.strictEqual(session.mp, beforeMp + 2, 'player must recover 2 MP from ember_wand on hit');

    // Test MP does not exceed mpMax
    session.mp = 99;
    readyAuto(session);
    w.trySwing(session, dummy, 6);
    assert.strictEqual(session.mp, 100, 'player MP must cap at mpMax');

    // Verify no weapon skill tries are awarded on wand auto
    const magicTriesBefore = (session._skillCounters && session._skillCounters.magic) || 0;
    readyAuto(session);
    w.trySwing(session, dummy, 7);
    const magicTriesAfter = (session._skillCounters && session._skillCounters.magic) || 0;
    assert.strictEqual(magicTriesAfter, magicTriesBefore, 'no weapon skill tries should be awarded for wand auto');

    // Omit both min/max → magic_strike fallback (not 0 damage)
    session.weaponMin = null;
    session.weaponMax = null;
    const curve = computeMagicStrikeRange(session, WAND_AUTO_FALLBACK_BASE_POWER, 0);
    assert.ok(curve.max > 0);
    dummy.hp = 1000;
    dummy.hpMax = 1000;
    dummy.armor = 0;
    dummy.mitigation = 0;
    dummy.resists = { fire: 0 };
    readyAuto(session);
    const omitSwung = w.trySwing(session, dummy, 8);
    assert.ok(omitSwung, 'wand without min/max still swings');
    assert.ok(dummy.hp < 1000, 'magic_strike fallback deals damage');
    const omitUnit = resolveWandAuto(session, dummy, () => 0);
    assert.strictEqual(omitUnit.raw, curve.min);

    w.stop();
    console.log('ok combat_wands');
}

main();

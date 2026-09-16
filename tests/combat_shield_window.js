'use strict';

const assert = require('assert');
const { loadPack, resolveContentPath } = require('../src/content/load_pack');
const { testSettings, SERVER_ROOT } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { C2S, S2C, SWING_FLAG } = require('../src/protocol/opcodes');
const { decodeFrame } = require('../src/protocol/frame');
const { decodeSwing, decodeStats } = require('../src/protocol/messages');
const {
    resolveMelee,
    checkCanBlock,
    spendShieldBlock,
    SHIELD_BLOCK_MAX_PER_WINDOW,
    SHIELD_BLOCK_WINDOW_TICKS
} = require('../src/world/combat');
const {
    applyPlayerLoadout,
    createItemInstance,
    placeInEquipment
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

function warrior(id, opts) {
    const o = opts || {};
    return {
        id: id || 1,
        accountId: id || 1,
        name: 'Galahad',
        vocation: 'warrior',
        level: o.level || 10,
        experience: 0,
        hp: 300,
        hpMax: 300,
        mp: 50,
        mpMax: 50,
        townId: 1,
        skills: {
            sword: 40,
            shielding: 50
        }
    };
}

function main() {
    // -------------------------------------------------------------------------
    // 1. Direct Unit Test: Rate limiting helper contracts
    // -------------------------------------------------------------------------
    assert.strictEqual(SHIELD_BLOCK_MAX_PER_WINDOW, 2);
    assert.strictEqual(SHIELD_BLOCK_WINDOW_TICKS, 40);

    const testEntity = {
        canBlock: true,
        maxBlock: 30,
        shieldBlocksThisWindow: 0,
        shieldBlockWindowTick: 0
    };

    assert.strictEqual(checkCanBlock(testEntity, true, 'physical', 0), true);
    spendShieldBlock(testEntity, 0);
    assert.strictEqual(testEntity.shieldBlocksThisWindow, 1);

    assert.strictEqual(checkCanBlock(testEntity, true, 'physical', 0), true);
    spendShieldBlock(testEntity, 0);
    assert.strictEqual(testEntity.shieldBlocksThisWindow, 2);

    // 3rd block check in same window fails!
    assert.strictEqual(checkCanBlock(testEntity, true, 'physical', 0), false);
    assert.strictEqual(checkCanBlock(testEntity, true, 'physical', 20), false);

    // 40 ticks later, window resets
    assert.strictEqual(checkCanBlock(testEntity, true, 'physical', 40), true);
    assert.strictEqual(testEntity.shieldBlocksThisWindow, 0);
    assert.strictEqual(testEntity.shieldBlockWindowTick, 40);

    // -------------------------------------------------------------------------
    // 2. Direct Combat Unit Test: resolveMelee with 3 Simultaneous Attackers
    // -------------------------------------------------------------------------
    const defender = {
        type: 'player',
        armor: 0,
        mitigation: 0,
        resists: { physical: 0 },
        canBlock: true,
        maxBlock: 50,
        shieldBlocksThisWindow: 0,
        shieldBlockWindowTick: 0
    };

    const attacker = {
        type: 'creature',
        attacks: [{ min: 30, max: 30, chance: 100, kind: 'melee', element: 'physical' }]
    };

    // Attacker 1 strikes at tick 0: Blocked!
    const hit1 = resolveMelee(attacker, defender, () => 1, { currentTick: 0 });
    assert.strictEqual(hit1.miss, false);
    assert.strictEqual(hit1.blockChargeSpent, true, 'first attack must spend shield block charge');
    assert.strictEqual(hit1.shieldBlock, 30, 'shield must block the full 30 incoming raw damage');
    assert.strictEqual(hit1.final, 0);
    assert.strictEqual(defender.shieldBlocksThisWindow, 1);

    // Attacker 2 strikes at tick 0: Blocked!
    const hit2 = resolveMelee(attacker, defender, () => 1, { currentTick: 0 });
    assert.strictEqual(hit2.miss, false);
    assert.strictEqual(hit2.blockChargeSpent, true, 'second attack must spend shield block charge');
    assert.strictEqual(hit2.shieldBlock, 30);
    assert.strictEqual(hit2.final, 0);
    assert.strictEqual(defender.shieldBlocksThisWindow, 2);

    // Attacker 3 strikes at tick 0: Shield block rate-limited (max 2 per 2-second window)!
    const hit3 = resolveMelee(attacker, defender, () => 1, { currentTick: 0 });
    assert.strictEqual(hit3.miss, false);
    assert.strictEqual(hit3.blockChargeSpent, false, 'third attack cannot block (budget exhausted)');
    assert.strictEqual(hit3.shieldBlock, 0, 'shield block must be 0 for rate-limited attack');
    assert.strictEqual(hit3.final, 30, 'third attack strikes defender directly');
    assert.strictEqual(defender.shieldBlocksThisWindow, 2);

    // Attacker 4 strikes at tick 10: Still within 40-tick window, cannot block
    const hit4 = resolveMelee(attacker, defender, () => 1, { currentTick: 10 });
    assert.strictEqual(hit4.blockChargeSpent, false);
    assert.strictEqual(hit4.shieldBlock, 0);
    assert.strictEqual(hit4.final, 30);

    // Attacker 5 strikes at tick 40: 40 ticks have elapsed (2.0s), window resets!
    const hit5 = resolveMelee(attacker, defender, () => 1, { currentTick: 40 });
    assert.strictEqual(hit5.blockChargeSpent, true, 'attack after 40 ticks must reset shield window and block');
    assert.strictEqual(hit5.shieldBlock, 30);
    assert.strictEqual(hit5.final, 0);
    assert.strictEqual(defender.shieldBlocksThisWindow, 1);
    assert.strictEqual(defender.shieldBlockWindowTick, 40);

    // -------------------------------------------------------------------------
    // 3. Shield Rate Limiting with Armor Reduction Parity
    // -------------------------------------------------------------------------
    const armoredDefender = {
        type: 'player',
        armor: 10, // lo = ceil(10/2) = 5, hi = 5*2-1 = 9 => armor reduction in [5, 9]
        mitigation: 0,
        resists: { physical: 0 },
        canBlock: true,
        maxBlock: 20,
        shieldBlocksThisWindow: 0,
        shieldBlockWindowTick: 100
    };

    const strongAttacker = {
        type: 'creature',
        attacks: [{ min: 40, max: 40, chance: 100, kind: 'melee', element: 'physical' }]
    };

    // 1st attack at tick 100:
    // Raw 40 -> maxBlock 20 -> remaining 20 -> armor reduces 9 -> final 11
    const armHit1 = resolveMelee(strongAttacker, armoredDefender, () => 1, { currentTick: 100 });
    assert.strictEqual(armHit1.shieldBlock, 20);
    assert.strictEqual(armHit1.armorReduction, 9);
    assert.strictEqual(armHit1.final, 11);
    assert.strictEqual(armHit1.blockChargeSpent, true);

    // 2nd attack at tick 100:
    const armHit2 = resolveMelee(strongAttacker, armoredDefender, () => 1, { currentTick: 100 });
    assert.strictEqual(armHit2.shieldBlock, 20);
    assert.strictEqual(armHit2.armorReduction, 9);
    assert.strictEqual(armHit2.final, 11);
    assert.strictEqual(armHit2.blockChargeSpent, true);

    // 3rd attack at tick 100: Bypasses shield block, hits armor directly!
    // Raw 40 -> shieldBlock 0 -> remaining 40 -> armor reduces 9 -> final 31!
    const armHit3 = resolveMelee(strongAttacker, armoredDefender, () => 1, { currentTick: 100 });
    assert.strictEqual(armHit3.shieldBlock, 0, 'third attack bypasses shield block');
    assert.strictEqual(armHit3.armorReduction, 9, 'third attack is reduced only by armor');
    assert.strictEqual(armHit3.final, 31, 'final damage is raw (40) - armor (9) = 31');
    assert.strictEqual(armHit3.blockChargeSpent, false);

    // -------------------------------------------------------------------------
    // 4. World Integration: 3 Creature Attackers vs 1 Shielded Player
    // -------------------------------------------------------------------------
    const w = makeWorld({ autoIntervalTicks: 40 });
    const session = makeSession(w, warrior(1, { level: 10 }));
    const itemDb = w.itemDb();

    // Equip a wooden shield in leftHand
    const shieldUid = createItemInstance(session.inventory, 'wooden_shield', itemDb);
    const eqRes = placeInEquipment(session.inventory, shieldUid, 'leftHand', itemDb);
    assert.ok(eqRes.ok, 'placing wooden_shield in leftHand should succeed');
    applyPlayerLoadout(session, itemDb);

    assert.strictEqual(session.canBlock, true, 'session must be able to block with shield equipped');
    assert.ok(session.maxBlock > 0, 'maxBlock must be greater than 0');

    // Spawn 3 rat attackers around session
    const rat1 = {
        id: 1001,
        type: 'creature',
        x: session.x + 1,
        y: session.y,
        z: session.z,
        hp: 50,
        hpMax: 50,
        armor: 0,
        attacks: [{ min: 10, max: 10, chance: 100, kind: 'melee', element: 'physical' }],
        attackReadyTick: 0
    };
    const rat2 = {
        id: 1002,
        type: 'creature',
        x: session.x - 1,
        y: session.y,
        z: session.z,
        hp: 50,
        hpMax: 50,
        attacks: [{ min: 10, max: 10, chance: 100, kind: 'melee', element: 'physical' }],
        attackReadyTick: 0
    };
    const rat3 = {
        id: 1003,
        type: 'creature',
        x: session.x,
        y: session.y + 1,
        z: session.z,
        hp: 50,
        hpMax: 50,
        attacks: [{ min: 10, max: 10, chance: 100, kind: 'melee', element: 'physical' }],
        attackReadyTick: 0
    };

    w.creatures.set(rat1.id, rat1);
    w.creatures.set(rat2.id, rat2);
    w.creatures.set(rat3.id, rat3);

    // Initial state
    session.shieldBlocksThisWindow = 0;
    session.shieldBlockWindowTick = 0;
    const startHp = session.hp;

    // All 3 rats swing in the same tick (tick 0)
    const swing1 = w.trySwing(rat1, session, 0);
    assert.strictEqual(swing1, true);
    assert.strictEqual(session.shieldBlocksThisWindow, 1, 'rat 1 swing should consume 1st block');

    const swing2 = w.trySwing(rat2, session, 0);
    assert.strictEqual(swing2, true);
    assert.strictEqual(session.shieldBlocksThisWindow, 2, 'rat 2 swing should consume 2nd block');

    const swing3 = w.trySwing(rat3, session, 0);
    assert.strictEqual(swing3, true);
    assert.strictEqual(session.shieldBlocksThisWindow, 2, 'rat 3 swing cannot block (limit reached)');

    // Verify 40 ticks later (tick 40) the window resets and block is available again
    rat1.attackReadyTick = 40;
    const swing4 = w.trySwing(rat1, session, 40);
    assert.strictEqual(swing4, true);
    assert.strictEqual(session.shieldBlocksThisWindow, 1, 'swing at tick 40 should start new window and block');
    assert.strictEqual(session.shieldBlockWindowTick, 40);

    console.log('ok combat_shield_window');
}

main();

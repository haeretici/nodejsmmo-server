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
const { resolveCreatureAttack, chebyshev } = require('../src/world/combat');
const { creatureStandDistance } = require('../src/world/creature');
const { hasLineOfSight } = require('../src/world/shapes');
const { UNARMED_WEAPON_DEFENSE, computeMitigationPercent } = require('../src/world/items');

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

function hero(id, opts) {
    const o = opts || {};
    return {
        id: id || 1,
        accountId: id || 1,
        name: 'Hero',
        vocation: 'warrior',
        level: o.level || 10,
        experience: 0,
        hp: o.hp != null ? o.hp : 200,
        hpMax: o.hpMax != null ? o.hpMax : 200,
        mp: 50,
        mpMax: 50,
        townId: 1,
        skills: { sword: 30, shielding: 30 }
    };
}

function unarmedMitigated(raw, shielding) {
    const mit = computeMitigationPercent(shielding, UNARMED_WEAPON_DEFENSE);
    return Math.max(0, Math.floor(raw * (1 - mit / 100)));
}

function main() {
    // -------------------------------------------------------------------------
    // 1. Direct Unit Tests: resolveCreatureAttack
    // -------------------------------------------------------------------------

    // 1.1 Uniform damage roll within [min, max]
    const rangedMob = {
        type: 'creature',
        critChance: 0,
        critDamage: 0
    };
    const nakedPlayer = {
        type: 'player',
        armor: 0,
        mitigation: 0,
        resists: { physical: 0 }
    };
    const basicAttack = {
        id: 'knife_0',
        kind: 'ranged',
        range: 5,
        min: 20,
        max: 40,
        element: 'physical'
    };
    // rng 0.5 on [20, 40] => 20 + round(0.5 * 20) = 30
    const hitRoll = resolveCreatureAttack(rangedMob, nakedPlayer, basicAttack, () => 0.5, { hit: true });
    assert.strictEqual(hitRoll.miss, false);
    assert.strictEqual(hitRoll.hit, true);
    assert.strictEqual(hitRoll.raw, 30);
    assert.strictEqual(hitRoll.final, 30);

    // 1.2 Elemental attack bypasses shield block and physical armor reduction
    const fireAttack = {
        id: 'fire_0',
        kind: 'ranged',
        range: 6,
        min: 50,
        max: 50,
        element: 'fire'
    };
    const shieldedArmoredPlayer = {
        type: 'player',
        armor: 30,
        maxBlock: 40,
        canBlock: true,
        mitigation: 10,
        resists: { fire: 20 }
    };
    // Raw 50. Mit 10% => 45. Fire resist 20% => 36. Shield and armor bypassed!
    const fireHit = resolveCreatureAttack(rangedMob, shieldedArmoredPlayer, fireAttack, () => 0.5, { hit: true });
    assert.strictEqual(fireHit.shieldBlock, 0, 'fire attack must bypass shield block');
    assert.strictEqual(fireHit.armorReduction, 0, 'fire attack must bypass physical armor reduction');
    assert.strictEqual(fireHit.final, 36, 'final damage: 50 * 0.9 * 0.8 = 36');

    // 1.3 Physical ranged attack (range > 1, isMelee = false) bypasses shield block, but applies armor reduction
    const physRangedAttack = {
        id: 'arrow_0',
        kind: 'ranged',
        range: 5,
        min: 60,
        max: 60,
        element: 'physical'
    };
    const defenderWithShieldAndArmor = {
        type: 'player',
        armor: 20,
        maxBlock: 50,
        canBlock: true,
        mitigation: 0,
        resists: { physical: 0 }
    };
    // Armor 20 => lo = ceil(20/2) = 10, hi = 19. With rng 0.5 => 10 + round(0.5*9) = 15.
    const physRangedHit = resolveCreatureAttack(rangedMob, defenderWithShieldAndArmor, physRangedAttack, () => 0.5, { hit: true });
    assert.strictEqual(physRangedHit.shieldBlock, 0, 'ranged physical attack must bypass shield block');
    assert.strictEqual(physRangedHit.armorReduction, 15, 'physical armor reduction must apply to physical ranged attacks');
    assert.strictEqual(physRangedHit.final, 45, '60 raw - 15 armor = 45');

    // 1.4 Physical melee attack (range <= 1, isMelee = true) CAN be shield blocked
    const physMeleeAttack = {
        id: 'claw_0',
        kind: 'melee',
        range: 1,
        min: 60,
        max: 60,
        element: 'physical'
    };
    const physMeleeHit = resolveCreatureAttack(rangedMob, defenderWithShieldAndArmor, physMeleeAttack, () => 1, { hit: true, currentTick: 0 });
    assert.strictEqual(physMeleeHit.shieldBlock, 50, 'melee physical attack can be shield blocked up to maxBlock');
    assert.strictEqual(physMeleeHit.final, 0, 'shield block absorbed remaining damage');

    // 1.5 Critical hits use CRIT_BAND_MULTIPLY and scale with critDamage
    const critMob = {
        type: 'creature',
        critChance: 100,
        critDamage: 50
    };
    const critHit = resolveCreatureAttack(critMob, nakedPlayer, basicAttack, () => 0.5, { hit: true, critical: true });
    assert.strictEqual(critHit.critical, true);
    assert.strictEqual(critHit.fatal, false, 'creatures never proc weapon fatal');
    // raw 30 * (1 + 50/100) = 45
    assert.strictEqual(critHit.raw, 45, 'critDamage multiplies raw roll');

    // 1.6 Hit chance miss
    const missedAttack = {
        id: 'miss_0',
        kind: 'ranged',
        range: 5,
        min: 30,
        max: 30,
        hitChance: 0
    };
    const missHit = resolveCreatureAttack(rangedMob, nakedPlayer, missedAttack, () => 0.5);
    assert.strictEqual(missHit.miss, true);
    assert.strictEqual(missHit.final, 0);

    // -------------------------------------------------------------------------
    // 2. World Integration Tests: Creature Ranged Combat & AI
    // -------------------------------------------------------------------------
    const archerTemplate = {
        id: 'test_archer',
        label: 'Test Archer',
        hp: 100,
        hpMax: 100,
        armor: 0,
        mitigation: 0,
        maxBlock: 0,
        canBlock: false,
        exp: 50,
        aggro: true,
        resists: { physical: 0 },
        speed: 100,
        flags: {
            targetDistance: 4,
            aggroRange: 7,
            loseTargetDistance: 12,
            pushable: true,
            canPushCreatures: false
        },
        attacks: [
            {
                id: 'arrow_0',
                kind: 'ranged',
                intervalMs: 2000,
                chance: 100,
                range: 5,
                element: 'physical',
                min: 20,
                max: 20
            }
        ],
        loot: []
    };

    // Test 2.1: Creature executes ranged attack within range & LOS
    const w = makeWorld({
        autoIntervalTicks: 40,
        templates: { test_archer: archerTemplate },
        spawns: [{ kind: 'test_archer', x: 77, y: 99, z: 6 }]
    });

    const playerSession = makeSession(w, hero(1), { x: 81, y: 99, z: 6 }); // distance 4
    const archer = Array.from(w.creatures.values())[0];
    assert.ok(archer, 'archer must spawn');
    assert.strictEqual(archer.x, 77);
    assert.strictEqual(archer.y, 99);
    assert.strictEqual(archer.targetDistance, 4);

    const initialHp = playerSession.hp;
    const arrowFinal = unarmedMitigated(20, 30);
    // Step world to tick AI
    w.step(1);
    assert.strictEqual(archer.targetId, playerSession.id, 'archer must acquire player target');
    assert.strictEqual(playerSession.hp, initialHp - arrowFinal, 'player must take unarmed-mitigated ranged damage');

    // Verify S2C.SWING packet was received on player socket
    const swingFrame = lastOf(playerSession.socket, S2C.SWING);
    assert.ok(swingFrame, 'SWING frame must be sent');
    const swingData = decodeSwing(swingFrame.payload);
    assert.strictEqual(swingData.sourceId, archer.id);
    assert.strictEqual(swingData.targetId, playerSession.id);
    assert.strictEqual(swingData.amount, arrowFinal);

    // Verify archer held position (targetDistance 4 maintained)
    assert.strictEqual(archer.x, 77);
    assert.strictEqual(archer.y, 99);
    assert.strictEqual(chebyshev(archer.x, archer.y, playerSession.x, playerSession.y), 4);

    // Test 2.2: Attack cooldown interval (tick 2 should not attack)
    w.step(2);
    assert.strictEqual(playerSession.hp, initialHp - arrowFinal, 'player HP must not decrease during attack cooldown');

    // Test 2.3: Attack fires again when interval expires
    w.step(41); // 1 + 40 ticks = tick 41
    assert.strictEqual(playerSession.hp, initialHp - 2 * arrowFinal, 'ranged attack must fire again after cooldown expires');

    playerSession.kick();
    w.stop();

    // -------------------------------------------------------------------------
    // 3. Attack Range Limit (target at distance 6 with weapon range 5)
    // -------------------------------------------------------------------------
    const wRange = makeWorld({
        autoIntervalTicks: 1,
        creatureStepDelayTicks: 1,
        templates: { test_archer: archerTemplate },
        spawns: [{ kind: 'test_archer', x: 77, y: 99, z: 6 }]
    });
    const farPlayer = makeSession(wRange, hero(2), { x: 83, y: 99, z: 6 }); // distance 6
    const archerFar = Array.from(wRange.creatures.values())[0];
    assert.strictEqual(chebyshev(archerFar.x, archerFar.y, farPlayer.x, farPlayer.y), 6);

    // At distance 6, range 5 attack cannot reach yet, but archer steps closer (want = 4)
    const farHp = farPlayer.hp;
    wRange.step(1);
    // Archer took a step from 77 toward 83 (now at 78, distance 5)
    assert.strictEqual(archerFar.x, 78);
    assert.strictEqual(chebyshev(archerFar.x, archerFar.y, farPlayer.x, farPlayer.y), 5);
    // Now at distance 5 (within range 5), next step can shoot and close to distance 4
    wRange.step(2);
    assert.strictEqual(farPlayer.hp, farHp - unarmedMitigated(20, 30), 'player takes damage once in range');
    assert.strictEqual(archerFar.x, 79, 'archer closes to stand-off distance 4');
    assert.strictEqual(chebyshev(archerFar.x, archerFar.y, farPlayer.x, farPlayer.y), 4);

    // Step again at distance 4: archer holds position (does NOT rush to melee)
    wRange.step(3);
    assert.strictEqual(archerFar.x, 79, 'archer must hold position at targetDistance 4');

    farPlayer.kick();
    wRange.stop();

    // -------------------------------------------------------------------------
    // 4. Line of Sight (LOS) blocking by solid wall
    // -------------------------------------------------------------------------
    const wLos = makeWorld({
        autoIntervalTicks: 1,
        templates: { test_archer: archerTemplate },
        spawns: [{ kind: 'test_archer', x: 77, y: 99, z: 6 }]
    });
    const losPlayer = makeSession(wLos, hero(3), { x: 81, y: 99, z: 6 }); // distance 4
    const archerLos = Array.from(wLos.creatures.values())[0];

    const layer = wLos.tileMap.getLayer(6);
    assert.ok(layer, 'layer 6 must exist');
    // Place wall sight blocker between archer (77, 99) and player (81, 99) at (79, 99)
    const wallIdx = wLos.tileMap.index(79, 99, layer.cols);
    const origSight = layer.sight[wallIdx];
    layer.sight[wallIdx] = 255;

    // Line of sight is blocked
    assert.strictEqual(
        hasLineOfSight(archerLos.x, archerLos.y, archerLos.z, losPlayer.x, losPlayer.y, losPlayer.z, wLos.tileMap),
        false,
        'line of sight must be blocked by wall'
    );

    // tryCreatureAttacks must fail due to blocked LOS, but still arm the ready-row CD
    const attackedThroughWall = wLos.tryCreatureAttacks(archerLos, losPlayer, 1);
    assert.strictEqual(attackedThroughWall, false, 'ranged attack must not shoot through wall');
    assert.ok(
        archerLos._attackReadyTicks.arrow_0 != null && archerLos._attackReadyTicks.arrow_0 > 1,
        'blocked LOS still arms the ready row CD'
    );

    // Clear sight blocker
    layer.sight[wallIdx] = origSight;
    assert.strictEqual(
        hasLineOfSight(archerLos.x, archerLos.y, archerLos.z, losPlayer.x, losPlayer.y, losPlayer.z, wLos.tileMap),
        true,
        'line of sight must be clear after removing blocker'
    );
    const attackedSameTick = wLos.tryCreatureAttacks(archerLos, losPlayer, 1);
    assert.strictEqual(attackedSameTick, false, 'same-tick retry must wait for the armed CD');
    const attackedCleared = wLos.tryCreatureAttacks(archerLos, losPlayer, 2);
    assert.strictEqual(attackedCleared, true, 'ranged attack must succeed with clear LOS after CD');

    losPlayer.kick();
    wLos.stop();

    // -------------------------------------------------------------------------
    // 5. Kiting Behavior: stepping away when target approaches (dist < targetDistance)
    // -------------------------------------------------------------------------
    const wKite = makeWorld({
        autoIntervalTicks: 1,
        templates: { test_archer: archerTemplate },
        spawns: [{ kind: 'test_archer', x: 79, y: 99, z: 6 }]
    });
    // Place player at distance 2 (81, 99) while archer is at (79, 99) -> dist = 2 < targetDistance 4
    const rushPlayer = makeSession(wKite, hero(4), { x: 81, y: 99, z: 6 });
    const archerKite = Array.from(wKite.creatures.values())[0];
    archerKite.targetId = rushPlayer.id;

    assert.strictEqual(chebyshev(archerKite.x, archerKite.y, rushPlayer.x, rushPlayer.y), 2);
    // Tick AI: archer should shoot AND step away from (81, 99)
    wKite.step(1);
    const newDist = chebyshev(archerKite.x, archerKite.y, rushPlayer.x, rushPlayer.y);
    assert.ok(newDist > 2, 'archer must step away to increase distance when player approaches');
    assert.strictEqual(archerKite.x, 78, 'archer must step West (away from player to the East)');

    rushPlayer.kick();
    wKite.stop();

    // -------------------------------------------------------------------------
    // 6. Cornered Archer: Stands ground and attacks when unable to retreat
    // -------------------------------------------------------------------------
    const wCorner = makeWorld({
        autoIntervalTicks: 1,
        templates: { test_archer: archerTemplate },
        spawns: [{ kind: 'test_archer', x: 77, y: 99, z: 6 }]
    });
    const cornerPlayer = makeSession(wCorner, hero(5), { x: 78, y: 99, z: 6 }); // dist 1
    const archerCorner = Array.from(wCorner.creatures.values())[0];
    archerCorner.targetId = cornerPlayer.id;

    // Surround North, South, and West of archer (77, 99) with blocked tiles
    const layerC = wCorner.tileMap.getLayer(6);
    const b1 = wCorner.tileMap.index(76, 99, layerC.cols); // West (already solid, but ensure)
    const b2 = wCorner.tileMap.index(77, 98, layerC.cols); // North
    const b3 = wCorner.tileMap.index(77, 100, layerC.cols); // South
    const b4 = wCorner.tileMap.index(76, 98, layerC.cols); // North-West
    const b5 = wCorner.tileMap.index(76, 100, layerC.cols); // South-West
    const origB1 = layerC.friction[b1];
    const origB2 = layerC.friction[b2];
    const origB3 = layerC.friction[b3];
    const origB4 = layerC.friction[b4];
    const origB5 = layerC.friction[b5];
    layerC.friction[b1] = 255;
    layerC.friction[b2] = 255;
    layerC.friction[b3] = 255;
    layerC.friction[b4] = 255;
    layerC.friction[b5] = 255;

    const cornerHpBefore = cornerPlayer.hp;
    wCorner.step(1);
    // Archer cannot step away (cornered), stays at (77, 99), but still attacks
    assert.strictEqual(archerCorner.x, 77);
    assert.strictEqual(archerCorner.y, 99);
    assert.strictEqual(cornerPlayer.hp, cornerHpBefore - unarmedMitigated(20, 30), 'cornered archer still attacks');

    layerC.friction[b1] = origB1;
    layerC.friction[b2] = origB2;
    layerC.friction[b3] = origB3;
    layerC.friction[b4] = origB4;
    layerC.friction[b5] = origB5;
    cornerPlayer.kick();
    wCorner.stop();

    // -------------------------------------------------------------------------
    // 7. Melee Creature Regression Check (Cave Rat rushes to melee at dist 1)
    // -------------------------------------------------------------------------
    const wMelee = makeWorld({
        autoIntervalTicks: 1,
        spawns: [{ kind: 'rat', x: 77, y: 99, z: 6 }]
    });
    const meleePlayer = makeSession(wMelee, hero(6), { x: 79, y: 99, z: 6 }); // dist 2
    const rat = Array.from(wMelee.creatures.values())[0];
    assert.strictEqual(rat.targetDistance, 1);

    // Rat should step toward player to reach melee distance 1
    wMelee.step(1);
    assert.strictEqual(chebyshev(rat.x, rat.y, meleePlayer.x, meleePlayer.y), 1, 'rat must close to melee distance 1');
    assert.strictEqual(rat.x, 78);

    // Step again: rat attacks in melee
    const meleeHpBefore = meleePlayer.hp;
    wMelee.step(2);
    assert.ok(meleePlayer.hp < meleeHpBefore, 'rat must attack in melee at distance 1');
    assert.strictEqual(rat.x, 78, 'rat stays in melee range');

    meleePlayer.kick();
    wMelee.stop();

    // -------------------------------------------------------------------------
    // 8. Mixed melee+ranged kit: OOR on the ready row burns that row, does not
    //    skip to the in-range ranged row on the same think.
    // -------------------------------------------------------------------------
    const mixedTemplate = {
        id: 'test_mixed',
        label: 'Test Mixed',
        hp: 100,
        hpMax: 100,
        armor: 0,
        mitigation: 0,
        maxBlock: 0,
        canBlock: false,
        exp: 50,
        aggro: true,
        resists: { physical: 0 },
        speed: 100,
        flags: {
            targetDistance: 4,
            aggroRange: 7,
            loseTargetDistance: 12,
            pushable: true,
            canPushCreatures: false
        },
        attacks: [
            {
                id: 'melee_0',
                kind: 'melee',
                intervalMs: 2000,
                chance: 100,
                range: 1,
                element: 'physical',
                min: 10,
                max: 10
            },
            {
                id: 'ranged_0',
                kind: 'ranged',
                intervalMs: 2000,
                chance: 100,
                range: 5,
                element: 'physical',
                min: 20,
                max: 20
            }
        ],
        loot: []
    };

    const wMixed = makeWorld({
        autoIntervalTicks: 40,
        creatureStepDelayTicks: 1000,
        templates: { test_mixed: mixedTemplate },
        spawns: [{ kind: 'test_mixed', x: 77, y: 99, z: 6 }]
    });
    const mixedPlayer = makeSession(wMixed, hero(7), { x: 81, y: 99, z: 6 }); // dist 4
    const mixed = Array.from(wMixed.creatures.values())[0];
    assert.strictEqual(chebyshev(mixed.x, mixed.y, mixedPlayer.x, mixedPlayer.y), 4);
    const mixedHp = mixedPlayer.hp;

    wMixed.step(1);
    assert.strictEqual(mixedPlayer.hp, mixedHp, 'OOR melee row must not skip to ranged on the same think');
    assert.ok(mixed._attackReadyTicks.melee_0 > 1, 'melee row CD must arm on OOR');
    assert.ok(
        mixed._attackReadyTicks.ranged_0 == null,
        'ranged row must stay unarmed when the ready melee row burned the think'
    );

    wMixed.step(2);
    assert.strictEqual(
        mixedPlayer.hp,
        mixedHp - unarmedMitigated(20, 30),
        'next think fires the in-range row after melee CD'
    );
    assert.ok(mixed._attackReadyTicks.ranged_0 > 2, 'ranged row CD arms when it actually fires');

    mixedPlayer.kick();
    wMixed.stop();

    // -------------------------------------------------------------------------
    // 9. runHealth: HP at/under threshold raises stand-off (kite instead of hug)
    // -------------------------------------------------------------------------
    const kiterTemplate = {
        id: 'test_kiter',
        label: 'Test Kiter',
        hp: 100,
        hpMax: 100,
        armor: 0,
        mitigation: 0,
        maxBlock: 0,
        canBlock: false,
        exp: 50,
        aggro: true,
        resists: { physical: 0 },
        speed: 100,
        flags: {
            targetDistance: 1,
            runHealth: 20,
            fleeTargetDistance: 4,
            aggroRange: 7,
            loseTargetDistance: 12,
            pushable: true,
            canPushCreatures: false
        },
        attacks: [
            {
                id: 'arrow_0',
                kind: 'ranged',
                intervalMs: 2000,
                chance: 100,
                range: 5,
                element: 'physical',
                min: 0,
                max: 0
            }
        ],
        loot: []
    };

    const wKiter = makeWorld({
        autoIntervalTicks: 40,
        creatureStepDelayTicks: 1,
        templates: { test_kiter: kiterTemplate },
        spawns: [{ kind: 'test_kiter', x: 82, y: 99, z: 6 }]
    });
    const kiterPlayer = makeSession(wKiter, hero(8, { hp: 400, hpMax: 400 }), { x: 83, y: 99, z: 6 }); // dist 1
    const kiter = Array.from(wKiter.creatures.values())[0];
    kiter.targetId = kiterPlayer.id;
    assert.strictEqual(chebyshev(kiter.x, kiter.y, kiterPlayer.x, kiterPlayer.y), 1);
    assert.strictEqual(creatureStandDistance(kiter), 1, 'full HP stand-off is targetDistance');

    wKiter.step(1);
    assert.strictEqual(
        chebyshev(kiter.x, kiter.y, kiterPlayer.x, kiterPlayer.y),
        1,
        'full HP keeps targetDistance 1 (no kite)'
    );

    kiter.hp = 20;
    assert.strictEqual(creatureStandDistance(kiter), 4, 'runHealth at 20% HP raises stand-off to fleeTargetDistance');
    wKiter.step(2);
    const hurtDist = chebyshev(kiter.x, kiter.y, kiterPlayer.x, kiterPlayer.y);
    assert.ok(hurtDist > 1, 'runHealth at 20% HP raises stand-off (steps away)');

    let held = false;
    for (let t = 3; t <= 20; t++) {
        wKiter.step(t);
        if (chebyshev(kiter.x, kiter.y, kiterPlayer.x, kiterPlayer.y) === 4) {
            held = true;
            break;
        }
    }
    assert.ok(held, 'hurt kiter holds fleeTargetDistance 4 instead of face-tanking');

    kiterPlayer.kick();
    wKiter.stop();

    console.log('ok combat_creature_ranged');
}

main();

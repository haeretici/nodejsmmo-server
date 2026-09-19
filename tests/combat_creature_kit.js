'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { REASON } = require('../src/protocol/opcodes');
const { hasHaste } = require('../src/world/conditions');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function openMap(cols, rows) {
    const n = cols * rows;
    return {
        width: cols,
        height: rows,
        z: 0,
        spawnX: 0,
        spawnY: 0,
        spawnZ: 0,
        floors: { 0: { friction: new Uint8Array(n).fill(100) } },
        stairs: [],
        spawns: [],
        npcs: []
    };
}

function makeWorld(extra) {
    const settings = testSettings();
    settings.creatureStepDelayTicks = 1;
    settings.stepDelayTicks = 1;
    settings.autoIntervalTicks = 1;
    settings.aiCreatureSleep = true;
    settings.aiTickRadius = 12;
    if (extra) Object.assign(settings, extra);
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        rng: extra && extra.rng ? extra.rng : (() => 0.5),
        templates: extra && extra.templates,
        map: extra && extra.map || openMap(40, 40)
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

function ash(id, extra) {
    return Object.assign({
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
    }, extra || {});
}

function baseFlags() {
    return {
        targetDistance: 1,
        aggroRange: 7,
        loseTargetDistance: 12,
        pushable: true,
        canPushCreatures: false
    };
}

function kitMob(id, extra) {
    return Object.assign({
        id,
        label: id,
        hp: 100,
        hpMax: 100,
        armor: 0,
        mitigation: 0,
        maxBlock: 0,
        canBlock: false,
        exp: 10,
        aggro: true,
        resists: { physical: 0, fire: 0 },
        speed: 100,
        critChance: 0,
        flags: baseFlags(),
        attacks: [],
        defenseSpells: [],
        loot: []
    }, extra || {});
}

function livingCreature(world) {
    const cr = Array.from(world.creatures.values())[0];
    assert.ok(cr, 'creature must spawn');
    return cr;
}

function main() {
    // Area (code 3 = 3×3) hits sticky target and an adjacent player.
    const areaTpl = kitMob('spitter', {
        attacks: [{
            id: 'area_0',
            kind: 'area',
            intervalMs: 2000,
            chance: 100,
            range: 7,
            radius: 3,
            element: 'fire',
            min: 40,
            max: 40,
            target: true
        }]
    });
    const wArea = makeWorld({
        templates: { spitter: areaTpl },
        spawns: [{ kind: 'spitter', x: 5, y: 5, z: 0 }]
    });
    const a = makeSession(wArea, ash(1), { x: 7, y: 5, z: 0 });
    const b = makeSession(wArea, ash(2), { x: 7, y: 6, z: 0 });
    const spit = livingCreature(wArea);
    spit.targetId = a.id;
    const hpA = a.hp;
    const hpB = b.hp;
    assert.strictEqual(wArea.tryCreatureAttacks(spit, a, 1), true);
    assert.ok(a.hp < hpA, 'area must damage sticky target');
    assert.ok(b.hp < hpB, 'area must damage adjacent player in 3×3');
    assert.strictEqual(hpA - a.hp, hpB - b.hp, 'shared area swing deals the same fire hit');
    a.kick(REASON.LOGOUT);
    b.kick(REASON.LOGOUT);
    wArea.stop();

    // Wave (spread 0 × length 4) hits the tile in front of the caster, not off-axis.
    const waveTpl = kitMob('breather', {
        attacks: [{
            id: 'wave_0',
            kind: 'wave',
            intervalMs: 2000,
            chance: 100,
            range: 4,
            length: 4,
            spread: 0,
            element: 'lifedrain',
            min: 25,
            max: 25,
            target: false
        }]
    });
    const wWave = makeWorld({
        templates: { breather: waveTpl },
        spawns: [{ kind: 'breather', x: 5, y: 5, z: 0 }]
    });
    const east = makeSession(wWave, ash(3), { x: 8, y: 5, z: 0 });
    const south = makeSession(wWave, ash(4), { x: 5, y: 8, z: 0 });
    const breath = livingCreature(wWave);
    breath.targetId = east.id;
    const eastHp = east.hp;
    const southHp = south.hp;
    assert.strictEqual(wWave.tryCreatureAttacks(breath, east, 1), true);
    assert.ok(east.hp < eastHp, 'east player is in the east-facing beam');
    assert.strictEqual(south.hp, southHp, 'south player is outside the beam');
    east.kick(REASON.LOGOUT);
    south.kick(REASON.LOGOUT);
    wWave.stop();

    // Status applies slow without a damage roll.
    const statusTpl = kitMob('slower', {
        attacks: [{
            id: 'slow_0',
            kind: 'status',
            intervalMs: 2000,
            chance: 100,
            range: 4,
            statusOnly: true,
            min: 0,
            max: 0,
            condition: { type: 'slow', speedChange: -50, durationSec: 10 }
        }]
    });
    const wStatus = makeWorld({
        templates: { slower: statusTpl },
        spawns: [{ kind: 'slower', x: 5, y: 5, z: 0 }]
    });
    const slowed = makeSession(wStatus, ash(5), { x: 7, y: 5, z: 0 });
    const mage = livingCreature(wStatus);
    const statusHp = slowed.hp;
    assert.strictEqual(wStatus.tryCreatureAttacks(mage, slowed, 1), true);
    assert.strictEqual(slowed.hp, statusHp, 'status-only does not deal HP');
    assert.ok(
        slowed.conditions && slowed.conditions.some((c) => c && c.kind === 'slow'),
        'slow condition applied'
    );
    slowed.kick(REASON.LOGOUT);
    wStatus.stop();

    // Heal fires before melee when wounded; player is not hit that pass.
    const healerTpl = kitMob('healer', {
        hp: 40,
        hpMax: 100,
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
        defenseSpells: [{
            id: 'heal_0',
            kind: 'heal',
            intervalMs: 2000,
            chance: 100,
            min: 20,
            max: 20,
            hpBelow: 0.7
        }]
    });
    const wHeal = makeWorld({
        templates: { healer: healerTpl },
        spawns: [{ kind: 'healer', x: 5, y: 5, z: 0 }]
    });
    const victim = makeSession(wHeal, ash(6), { x: 6, y: 5, z: 0 });
    const healer = livingCreature(wHeal);
    healer.hp = 40;
    const vHp = victim.hp;
    assert.strictEqual(wHeal.tryCreatureAttacks(healer, victim, 1), true);
    assert.strictEqual(healer.hp, 60, 'heal restores 20');
    assert.strictEqual(victim.hp, vHp, 'offense skipped after a defense success');
    victim.kick(REASON.LOGOUT);
    wHeal.stop();

    // Full HP: heal arms but does not fire; melee still lands.
    const wFull = makeWorld({
        templates: { healer: healerTpl },
        spawns: [{ kind: 'healer', x: 5, y: 5, z: 0 }]
    });
    const fullP = makeSession(wFull, ash(7), { x: 6, y: 5, z: 0 });
    const fullMob = livingCreature(wFull);
    fullMob.hp = 100;
    const fullHp = fullP.hp;
    assert.strictEqual(wFull.tryCreatureAttacks(fullMob, fullP, 1), true);
    assert.strictEqual(fullMob.hp, 100);
    assert.ok(fullP.hp < fullHp, 'melee fires when heal is not needed');
    fullP.kick(REASON.LOGOUT);
    wFull.stop();

    // Haste before offense.
    const hasteTpl = kitMob('dasher', {
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
        defenseSpells: [{
            id: 'haste_0',
            kind: 'haste',
            intervalMs: 2000,
            chance: 100,
            speedChange: 40,
            durationSec: 5
        }]
    });
    const wHaste = makeWorld({
        templates: { dasher: hasteTpl },
        spawns: [{ kind: 'dasher', x: 5, y: 5, z: 0 }]
    });
    const hasteP = makeSession(wHaste, ash(8), { x: 6, y: 5, z: 0 });
    const dasher = livingCreature(wHaste);
    const hasteHp = hasteP.hp;
    assert.strictEqual(wHaste.tryCreatureAttacks(dasher, hasteP, 1), true);
    assert.ok(hasHaste(dasher), 'haste condition applied');
    assert.strictEqual(dasher.speed, 140);
    assert.strictEqual(hasteP.hp, hasteHp, 'haste skips offense');
    hasteP.kick(REASON.LOGOUT);
    wHaste.stop();

    // Area OOR still burns that row and does not fall through to melee.
    const mixedTpl = kitMob('mixed', {
        attacks: [
            {
                id: 'area_0',
                kind: 'area',
                intervalMs: 2000,
                chance: 100,
                range: 4,
                radius: 3,
                element: 'fire',
                min: 40,
                max: 40,
                target: true
            },
            {
                id: 'melee_1',
                kind: 'melee',
                intervalMs: 2000,
                chance: 100,
                range: 1,
                element: 'physical',
                min: 10,
                max: 10
            }
        ]
    });
    const wMix = makeWorld({
        templates: { mixed: mixedTpl },
        spawns: [{ kind: 'mixed', x: 5, y: 5, z: 0 }]
    });
    const far = makeSession(wMix, ash(9), { x: 11, y: 5, z: 0 });
    const mixed = livingCreature(wMix);
    mixed.targetId = far.id;
    const farHp = far.hp;
    assert.strictEqual(wMix.tryCreatureAttacks(mixed, far, 1), false);
    assert.strictEqual(far.hp, farHp, 'OOR area must not damage');
    assert.ok(mixed._attackReadyTicks.area_0 > 1, 'OOR area still arms CD');
    assert.strictEqual(
        mixed._attackReadyTicks.melee_1,
        undefined,
        'later melee row is not tried after a ready area miss'
    );
    far.kick(REASON.LOGOUT);
    wMix.stop();

    console.log('ok combat_creature_kit');
}

main();

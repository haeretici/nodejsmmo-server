'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { REASON } = require('../src/protocol/opcodes');
const { chebyshev } = require('../src/world/combat');
const { normalizeSummonConfig, isSummon, findSummonSpawnTile } = require('../src/world/summons');

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

function walkMap(walkCells, cols, rows) {
    const c = cols || 12;
    const r = rows || 12;
    const n = c * r;
    const friction = new Uint8Array(n).fill(255);
    for (let i = 0; i < walkCells.length; i++) {
        const cell = walkCells[i];
        friction[(cell.y | 0) * c + (cell.x | 0)] = 100;
    }
    return {
        width: c,
        height: r,
        z: 0,
        spawnX: 0,
        spawnY: 0,
        spawnZ: 0,
        floors: { 0: { friction } },
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
    settings.creatureRespawnTicks = 1;
    if (extra) Object.assign(settings, extra);
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        rng: extra && extra.rng ? extra.rng : (() => 0),
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

function livingOfKind(world, kind) {
    const out = [];
    for (const cr of world.creatures.values()) {
        if (cr.kind === kind && (cr.hp | 0) > 0) out.push(cr);
    }
    return out;
}

function main() {
    const demonCfg = normalizeSummonConfig({
        maxSummons: 1,
        summons: [{
            name: 'Fire Elemental',
            id: 'fire_elemental',
            chance: 10,
            interval: 2000,
            count: 1
        }]
    });
    assert.ok(demonCfg);
    assert.strictEqual(demonCfg.maxSummons, 1);
    assert.strictEqual(demonCfg.summons.length, 1);
    assert.strictEqual(demonCfg.summons[0].id, 'fire_elemental');
    assert.strictEqual(demonCfg.summons[0].intervalMs, 2000);
    assert.strictEqual(demonCfg.summons[0].count, 1);
    assert.strictEqual(demonCfg.summons[0].chance, 10);

    const fromName = normalizeSummonConfig({
        summons: [{ name: 'Fire Elemental', chance: 100, interval: 1000, count: 2 }]
    });
    assert.strictEqual(fromName.summons[0].id, 'fire_elemental');
    assert.strictEqual(fromName.maxSummons, 2);

    assert.strictEqual(normalizeSummonConfig(null), null);
    assert.strictEqual(normalizeSummonConfig({ maxSummons: 1, summons: [] }), null);

    const minion = kitMob('fire_elemental', {
        hp: 40,
        hpMax: 40,
        exp: 220,
        loot: [{ id: 'gold_coin', chance: 100000, maxCount: 1 }]
    });
    const summoner = kitMob('demon', {
        attacks: [{
            id: 'melee_0',
            kind: 'melee',
            intervalMs: 2000,
            chance: 100,
            range: 1,
            element: 'physical',
            min: 8,
            max: 8
        }],
        summon: {
            maxSummons: 1,
            summons: [{
                name: 'Fire Elemental',
                id: 'fire_elemental',
                chance: 100,
                interval: 2000,
                count: 1
            }]
        }
    });

    const w = makeWorld({
        templates: { demon: summoner, fire_elemental: minion },
        spawns: [{ kind: 'demon', x: 5, y: 5, z: 0 }]
    });
    const p = makeSession(w, ash(1), { x: 6, y: 5, z: 0 });
    const master = livingOfKind(w, 'demon')[0];
    assert.ok(master);
    assert.ok(master.summon);
    assert.strictEqual(master.summon.maxSummons, 1);

    const hp0 = p.hp;
    assert.strictEqual(w.tryCreatureAttacks(master, p, 1), true);
    assert.ok(p.hp < hp0, 'summon does not consume the offensive pass');
    const adds = livingOfKind(w, 'fire_elemental');
    assert.strictEqual(adds.length, 1, 'demon summons one fire elemental');
    const add = adds[0];
    assert.ok(isSummon(add));
    assert.strictEqual(add.masterId, master.id);
    assert.ok(chebyshev(add.x, add.y, master.x, master.y) >= 1, 'not on master tile');
    assert.ok(chebyshev(add.x, add.y, master.x, master.y) <= 6);
    assert.strictEqual(master.summonIds.length, 1);
    assert.strictEqual(add.targetId, p.id);
    assert.strictEqual(add.pinIndex, null);

    assert.strictEqual(w.tryCreatureAttacks(master, p, 2), true);
    assert.strictEqual(livingOfKind(w, 'fire_elemental').length, 1, 'interval gate');

    master._summonReadyTicks[0] = 0;
    assert.strictEqual(w.tryMonsterSummons(master, p, 3), false, 'maxSummons cap');
    assert.strictEqual(livingOfKind(w, 'fire_elemental').length, 1);

    add._summonReadyTicks = [0];
    add.summon = master.summon;
    add.summonIds = [];
    assert.strictEqual(w.tryMonsterSummons(add, p, 4), false, 'summons must not nest');
    assert.strictEqual(livingOfKind(w, 'fire_elemental').length, 1);

    p.kick(REASON.LOGOUT);
    w.stop();

    const wOff = makeWorld({
        features: Object.assign({}, testSettings().features, { monsterSummons: false }),
        templates: { demon: summoner, fire_elemental: minion },
        spawns: [{ kind: 'demon', x: 5, y: 5, z: 0 }]
    });
    const pOff = makeSession(wOff, ash(2), { x: 6, y: 5, z: 0 });
    const masterOff = livingOfKind(wOff, 'demon')[0];
    wOff.tryCreatureAttacks(masterOff, pOff, 1);
    assert.strictEqual(livingOfKind(wOff, 'fire_elemental').length, 0, 'feature off');
    pOff.kick(REASON.LOGOUT);
    wOff.stop();

    const wCount = makeWorld({
        templates: {
            demon: kitMob('demon', {
                summon: {
                    maxSummons: 3,
                    summons: [{
                        id: 'fire_elemental',
                        chance: 100,
                        interval: 2000,
                        count: 1
                    }]
                }
            }),
            fire_elemental: minion
        },
        spawns: [{ kind: 'demon', x: 5, y: 5, z: 0 }]
    });
    const pCount = makeSession(wCount, ash(3), { x: 6, y: 5, z: 0 });
    const mCount = livingOfKind(wCount, 'demon')[0];
    assert.ok(wCount.tryMonsterSummons(mCount, pCount, 1));
    mCount._summonReadyTicks[0] = 0;
    assert.strictEqual(wCount.tryMonsterSummons(mCount, pCount, 2), false, 'per-type count cap');
    assert.strictEqual(livingOfKind(wCount, 'fire_elemental').length, 1);
    pCount.kick(REASON.LOGOUT);
    wCount.stop();

    const island = walkMap([
        { x: 4, y: 5 },
        { x: 5, y: 5 },
        { x: 6, y: 5 }
    ]);
    const wOcc = makeWorld({
        map: island,
        templates: { demon: summoner, fire_elemental: minion },
        spawns: [{ kind: 'demon', x: 5, y: 5, z: 0 }]
    });
    const pOcc = makeSession(wOcc, ash(4), { x: 4, y: 5, z: 0 });
    const mOcc = livingOfKind(wOcc, 'demon')[0];
    assert.ok(wOcc.tryMonsterSummons(mOcc, pOcc, 1));
    const occAdd = livingOfKind(wOcc, 'fire_elemental')[0];
    assert.strictEqual(occAdd.x, 6);
    assert.strictEqual(occAdd.y, 5);
    const occTile = wOcc.tileMap.getOccupant(6, 5, 0);
    assert.strictEqual(occTile, occAdd.id);
    assert.notStrictEqual(wOcc.tileMap.getOccupant(5, 5, 0), occAdd.id);
    pOcc.kick(REASON.LOGOUT);
    wOcc.stop();

    const blocked = walkMap([
        { x: 4, y: 5 },
        { x: 5, y: 5 }
    ]);
    const wBlock = makeWorld({
        map: blocked,
        templates: { demon: summoner, fire_elemental: minion },
        spawns: [{ kind: 'demon', x: 5, y: 5, z: 0 }]
    });
    const pBlock = makeSession(wBlock, ash(5), { x: 4, y: 5, z: 0 });
    const mBlock = livingOfKind(wBlock, 'demon')[0];
    assert.strictEqual(wBlock.tryMonsterSummons(mBlock, pBlock, 1), false, 'no empty adjacent tile');
    assert.strictEqual(livingOfKind(wBlock, 'fire_elemental').length, 0);
    pBlock.kick(REASON.LOGOUT);
    wBlock.stop();

    const wDie = makeWorld({
        templates: { demon: summoner, fire_elemental: minion },
        spawns: [{ kind: 'demon', x: 5, y: 5, z: 0 }]
    });
    const pDie = makeSession(wDie, ash(6), { x: 6, y: 5, z: 0 });
    const mDie = livingOfKind(wDie, 'demon')[0];
    assert.ok(wDie.tryMonsterSummons(mDie, pDie, 1));
    assert.strictEqual(livingOfKind(wDie, 'fire_elemental').length, 1);
    const corpsesBefore = wDie.corpses.size;
    const expBefore = Number(pDie.experience) || 0;
    wDie.kill(mDie, pDie, 2);
    assert.strictEqual(livingOfKind(wDie, 'fire_elemental').length, 0, 'master death dismisses');
    assert.strictEqual(livingOfKind(wDie, 'demon').length, 0);
    assert.strictEqual(wDie.corpses.size, corpsesBefore + 1, 'only master corpse');
    const gained = (Number(pDie.experience) || 0) - expBefore;
    assert.ok(gained > 0 && gained < 220, 'dismiss does not award summon exp');
    pDie.kick(REASON.LOGOUT);
    wDie.stop();

    const wKillAdd = makeWorld({
        templates: { demon: summoner, fire_elemental: minion },
        spawns: [{ kind: 'demon', x: 5, y: 5, z: 0 }]
    });
    const pKill = makeSession(wKillAdd, ash(7, { experience: 0 }), { x: 6, y: 5, z: 0 });
    const mKill = livingOfKind(wKillAdd, 'demon')[0];
    assert.ok(wKillAdd.tryMonsterSummons(mKill, pKill, 1));
    const addKill = livingOfKind(wKillAdd, 'fire_elemental')[0];
    const corpses0 = wKillAdd.corpses.size;
    wKillAdd.kill(addKill, pKill, 2);
    assert.strictEqual(livingOfKind(wKillAdd, 'fire_elemental').length, 0);
    assert.ok(isSummon({ masterId: 0 }) === false);
    assert.strictEqual(mKill.summonIds.length, 0, 'unlink on summon death');
    assert.strictEqual(wKillAdd.corpses.size, corpses0, 'summon has no corpse');
    assert.ok((pKill.experience || 0) > 0, 'player kill of add awards exp');
    assert.ok(livingOfKind(wKillAdd, 'demon')[0], 'master still alive');
    wKillAdd.tickRespawns(3);
    wKillAdd.tickRespawns(4);
    assert.strictEqual(livingOfKind(wKillAdd, 'fire_elemental').length, 0, 'summon does not respawn');
    pKill.kick(REASON.LOGOUT);
    wKillAdd.stop();

    const healer = kitMob('demon', {
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
        }],
        summon: {
            maxSummons: 1,
            summons: [{
                id: 'fire_elemental',
                chance: 100,
                interval: 2000,
                count: 1
            }]
        }
    });
    const wHeal = makeWorld({
        templates: { demon: healer, fire_elemental: minion },
        spawns: [{ kind: 'demon', x: 5, y: 5, z: 0 }]
    });
    const pHeal = makeSession(wHeal, ash(8), { x: 6, y: 5, z: 0 });
    const mHeal = livingOfKind(wHeal, 'demon')[0];
    mHeal.hp = 40;
    const vHp = pHeal.hp;
    assert.strictEqual(wHeal.tryCreatureAttacks(mHeal, pHeal, 1), true);
    assert.strictEqual(mHeal.hp, 60, 'heal still fires');
    assert.strictEqual(pHeal.hp, vHp, 'offense skipped after defense');
    assert.strictEqual(livingOfKind(wHeal, 'fire_elemental').length, 1, 'summon still rolls on defense pass');
    pHeal.kick(REASON.LOGOUT);
    wHeal.stop();

    const tile = findSummonSpawnTile(
        { canEnter(x, y) { return x === 6 && y === 5; } },
        5, 5, 0
    );
    assert.ok(tile);
    assert.strictEqual(tile.x, 6);
    assert.strictEqual(tile.y, 5);

    console.log('ok combat_creature_summons');
}

main();

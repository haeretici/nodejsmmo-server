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
const { decodeSay } = require('../src/protocol/messages');
const { chebyshev } = require('../src/world/combat');

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

const wanderer = Object.freeze({
    id: 'wanderer',
    label: 'Wanderer',
    isNpc: true,
    attackableNpc: false,
    hp: 80,
    hpMax: 80,
    armor: 0,
    mitigation: 1,
    maxBlock: 0,
    canBlock: false,
    exp: 0,
    aggro: false,
    speed: 80,
    walkInterval: 2000,
    walkRadius: 2,
    voices: Object.freeze([
        Object.freeze({ text: 'Need directions?' })
    ]),
    voiceInterval: 1000,
    voiceChance: 100,
    resists: Object.freeze({ physical: 0 }),
    flags: Object.freeze({
        targetDistance: 1,
        aggroRange: 0,
        loseTargetDistance: 12
    }),
    attacks: Object.freeze([]),
    loot: Object.freeze([]),
    dialog: Object.freeze({
        start: 'start',
        nodes: Object.freeze({
            start: Object.freeze({
                text: 'Hello.',
                replies: Object.freeze([
                    Object.freeze({ label: 'Bye', action: 'close' })
                ])
            })
        })
    })
});

const aggroNpc = Object.freeze(Object.assign({}, wanderer, {
    id: 'aggro_npc',
    label: 'Aggro Npc',
    aggro: true
}));

function makeWorld(extra, map) {
    const settings = testSettings();
    settings.creatureStepDelayTicks = 1;
    settings.stepDelayTicks = 1;
    settings.logicUps = 20;
    if (extra) Object.assign(settings, extra);
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        rng: extra && extra.rng ? extra.rng : (() => 0),
        templates: extra && extra.templates,
        map: map || extra && extra.map || openMap(40, 40)
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
    const templates = { wanderer, aggro_npc: aggroNpc };

    // Nearby player: cardinal step inside walkRadius of spawn; not on hostile AI set
    const wNear = makeWorld({
        templates,
        npcs: [{ kind: 'wanderer', x: 5, y: 5, z: 0 }]
    });
    const near = makeSession(wNear, ash(1), { x: 8, y: 5, z: 0 });
    const npc = Array.from(wNear.creatures.values())[0];
    assert.ok(npc);
    assert.strictEqual(npc.type, 'npc');
    assert.strictEqual(npc.walkInterval, 2000);
    assert.strictEqual(npc.walkRadius, 2);
    assert.strictEqual(npc.voiceInterval, 1000);
    assert.strictEqual(npc.voiceChance, 100);
    assert.ok(npc.voices && npc.voices.length);
    assert.strictEqual(wNear.activeCreatures.has(npc), false);
    const spawnX = npc.spawnX;
    const spawnY = npc.spawnY;
    let moved = false;
    for (let t = 1; t <= 80; t++) {
        wNear.step(t);
        assert.strictEqual(npc.targetId, 0);
        assert.strictEqual(wNear.activeCreatures.has(npc), false);
        const d = chebyshev(npc.x, npc.y, spawnX, spawnY);
        assert.ok(d <= 2, 'stayed in walkRadius');
        assert.strictEqual(npc.z, 0);
        if (npc.x !== spawnX || npc.y !== spawnY) {
            moved = true;
            break;
        }
    }
    assert.ok(moved, 'nearby spectator: NPC walked off spawn');
    assert.ok(
        (npc.x === spawnX) !== (npc.y === spawnY) || chebyshev(npc.x, npc.y, spawnX, spawnY) === 1,
        'cardinal step'
    );
    const say = lastOf(near.socket, S2C.SAY);
    assert.ok(say, 'idle voice SAY to viewers');
    assert.strictEqual(decodeSay(say.payload), 'Need directions?');
    near.kick(REASON.LOGOUT);
    wNear.stop();

    // Open TALK: frozen until TALK_CLOSE
    const wTalk = makeWorld({
        templates,
        npcs: [{ kind: 'wanderer', x: 5, y: 5, z: 0 }]
    });
    const talker = makeSession(wTalk, ash(2), { x: 6, y: 5, z: 0 });
    const talking = Array.from(wTalk.creatures.values())[0];
    assert.ok(wTalk.enqueueIntent(talker, {
        opcode: C2S.TALK, seq: 1, payload: u32(talking.id)
    }));
    wTalk.step(1);
    assert.strictEqual(talker.talkNpcId, talking.id);
    for (let t = 2; t <= 80; t++) {
        wTalk.step(t);
        assert.strictEqual(talking.x, 5, 'frozen while TALK open');
        assert.strictEqual(talking.y, 5);
    }
    assert.ok(wTalk.enqueueIntent(talker, {
        opcode: C2S.TALK_CLOSE, seq: 2, payload: u32(talking.id)
    }));
    wTalk.step(81);
    assert.strictEqual(talker.talkNpcId, 0);
    let resumed = false;
    for (let t = 82; t <= 160; t++) {
        wTalk.step(t);
        if (talking.x !== 5 || talking.y !== 5) {
            resumed = true;
            break;
        }
    }
    assert.ok(resumed, 'walks after TALK_CLOSE');
    talker.kick(REASON.LOGOUT);
    wTalk.stop();

    // Walk-away closes talk and allows wander
    const wAway = makeWorld({
        templates,
        npcs: [{ kind: 'wanderer', x: 5, y: 5, z: 0 }]
    });
    const walker = makeSession(wAway, ash(3), { x: 6, y: 5, z: 0 });
    const awayNpc = Array.from(wAway.creatures.values())[0];
    assert.ok(wAway.enqueueIntent(walker, {
        opcode: C2S.TALK, seq: 1, payload: u32(awayNpc.id)
    }));
    wAway.step(1);
    assert.strictEqual(walker.talkNpcId, awayNpc.id);
    walker.x = 20;
    walker.y = 5;
    for (let t = 2; t <= 5; t++) wAway.step(t);
    assert.strictEqual(walker.talkNpcId, 0, 'walk-away closes talk');
    walker.x = 8;
    walker.y = 5;
    let afterAway = false;
    for (let t = 6; t <= 80; t++) {
        wAway.step(t);
        if (awayNpc.x !== 5 || awayNpc.y !== 5) {
            afterAway = true;
            break;
        }
    }
    assert.ok(afterAway, 'walks after walk-away');
    walker.kick(REASON.LOGOUT);
    wAway.stop();

    // No player in spectator AOI: no walk
    const wFar = makeWorld({
        templates,
        npcs: [{ kind: 'wanderer', x: 5, y: 5, z: 0 }]
    }, openMap(80, 80));
    const far = makeSession(wFar, ash(4), { x: 40, y: 40, z: 0 });
    const farNpc = Array.from(wFar.creatures.values())[0];
    for (let t = 1; t <= 80; t++) wFar.step(t);
    assert.strictEqual(farNpc.x, 5);
    assert.strictEqual(farNpc.y, 5);
    assert.strictEqual(wFar.activeCreatures.has(farNpc), false);
    far.kick(REASON.LOGOUT);
    wFar.stop();

    // Zero players: no walk
    const wEmpty = makeWorld({
        templates,
        npcs: [{ kind: 'wanderer', x: 4, y: 4, z: 0 }]
    });
    const alone = Array.from(wEmpty.creatures.values())[0];
    for (let t = 1; t <= 80; t++) wEmpty.step(t);
    assert.strictEqual(alone.x, 4);
    assert.strictEqual(alone.y, 4);
    wEmpty.stop();

    // aggro NPCs do not wander
    const wAggro = makeWorld({
        templates,
        npcs: [{ kind: 'aggro_npc', x: 5, y: 5, z: 0 }]
    });
    const hunter = makeSession(wAggro, ash(5), { x: 8, y: 5, z: 0 });
    const hostile = Array.from(wAggro.creatures.values())[0];
    assert.strictEqual(hostile.aggro, true);
    assert.strictEqual(wAggro.activeCreatures.has(hostile), false);
    for (let t = 1; t <= 80; t++) wAggro.step(t);
    assert.strictEqual(hostile.x, 5);
    assert.strictEqual(hostile.y, 5);
    hunter.kick(REASON.LOGOUT);
    wAggro.stop();

    console.log('ok npc_wander');
}

main();

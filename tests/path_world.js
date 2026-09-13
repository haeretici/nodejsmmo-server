'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { GameSession } = require('../src/world/session');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { createLog } = require('../src/log');
const { REASON } = require('../src/protocol/opcodes');
const { FRICTION_BLOCKED } = require('../src/world/tilemap');
const { PathBudget } = require('../src/world/path_budget');

function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        send(buf) { this.sent.push(Buffer.from(buf)); },
        close() { this.readyState = 3; this.closed = true; },
        terminate() { this.readyState = 3; this.closed = true; }
    };
}

function gridMap(cols, rows, walls) {
    const n = cols * rows;
    const friction = new Uint8Array(n).fill(100);
    for (let i = 0; i < walls.length; i++) {
        const w = walls[i];
        friction[w[1] * cols + w[0]] = FRICTION_BLOCKED;
    }
    return {
        width: cols,
        height: rows,
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

function makeWorld(extra, map) {
    const settings = testSettings();
    if (extra) Object.assign(settings, extra);
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        schedule: () => 0,
        clear: () => {},
        rng: extra && extra.rng ? extra.rng : (() => 0),
        map: map || extra && extra.map
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

function main() {
    const map = gridMap(5, 3, [[2, 0], [2, 1]]);
    const w = makeWorld({
        creatureStepDelayTicks: 1,
        stepDelayTicks: 1,
        spawns: [{ kind: 'rat', x: 0, y: 0, z: 0 }]
    }, map);
    const hunter = makeSession(w, ash(1), { x: 4, y: 0, z: 0 });
    const rat = Array.from(w.creatures.values())[0];
    assert.ok(rat);
    const walls = new Set(['2,0', '2,1']);
    let reached = false;
    for (let t = 1; t <= 16; t++) {
        w.step(t);
        assert.ok(!walls.has(`${rat.x},${rat.y}`), `rat walked a wall at ${rat.x},${rat.y}`);
        const d = Math.max(Math.abs(rat.x - hunter.x), Math.abs(rat.y - hunter.y));
        if (d <= 1) {
            reached = true;
            break;
        }
    }
    assert.ok(reached, 'creature paths around a wall');
    hunter.kick(REASON.LOGOUT);
    w.stop();

    const stackMap = gridMap(4, 4, []);
    const w2 = makeWorld({
        stepDelayTicks: 1,
        playerTileMaxStack: 10,
        spawns: []
    }, stackMap);
    const a = makeSession(w2, ash(10), { x: 1, y: 1, z: 0 });
    const b = makeSession(w2, ash(11, { name: 'Bo', accountId: 11 }), { x: 1, y: 1, z: 0 });
    assert.deepStrictEqual(w2.tileMap.getCombatants(1, 1, 0), [10, 11]);
    a.kick(REASON.LOGOUT);
    b.kick(REASON.LOGOUT);
    w2.stop();

    const w3 = makeWorld({
        creatureStepDelayTicks: 1,
        spawns: [
            { kind: 'rat', x: 1, y: 1, z: 0 },
            { kind: 'rat', x: 2, y: 1, z: 0 }
        ]
    }, gridMap(4, 4, []));
    const rats = Array.from(w3.creatures.values());
    assert.strictEqual(rats.length, 2);
    assert.strictEqual(w3.tileMap.canEnter(rats[0].x, rats[0].y, 0, rats[1]), false);
    assert.notStrictEqual(
        `${rats[0].x},${rats[0].y}`,
        `${rats[1].x},${rats[1].y}`
    );
    w3.stop();

    const budget = new PathBudget(1);
    budget.begin(1);
    assert.strictEqual(budget.take({ critical: true }), true);
    assert.strictEqual(budget.take({ critical: false }), true);
    assert.strictEqual(budget.take({ critical: false }), false);
    assert.strictEqual(budget.stats().budgetSkips, 1);
    budget.begin(2);
    assert.strictEqual(budget.take({ critical: false }), true);

    console.log('ok path_world');
}

main();

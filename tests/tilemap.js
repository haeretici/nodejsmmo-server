'use strict';

const assert = require('assert');
const { createStaticMap, tileAt, TILE } = require('../src/world/static_map');
const {
    TileMap, fromStaticMap, FRICTION_BLOCKED,
    hopsOnStep, hopDirOffset, resolveStairDest
} = require('../src/world/tilemap');

function main() {
    const ents = new Map();
    const map = createStaticMap();
    const tm = fromStaticMap(map, {
        maxStack: 3,
        resolveEntity: (id) => ents.get(id) || null
    });

    function player(id, x, y) {
        const e = { id, type: 'player', x, y, z: 0 };
        ents.set(id, e);
        return e;
    }

    assert.strictEqual(tileAt(map, 0, 0), TILE.WALL);
    assert.strictEqual(tm.frictionAt(0, 0, 0), FRICTION_BLOCKED);
    assert.strictEqual(tm.isWalkable(12, 12, 0), true);
    assert.strictEqual(tm.isWalkable(4, 4, 0), false);

    const a = player(1, 12, 12);
    assert.ok(tm.enterTile(12, 12, 0, a));
    assert.strictEqual(tm.getOccupant(12, 12, 0), 1);
    assert.deepStrictEqual(tm.getCombatants(12, 12, 0), [1]);

    const b = player(2, 12, 12);
    assert.ok(tm.enterTile(12, 12, 0, b));
    assert.deepStrictEqual(tm.getCombatants(12, 12, 0), [1, 2]);
    assert.strictEqual(tm.getFirstOccupant(12, 12, 0), 1);

    const c = player(3, 12, 12);
    assert.ok(tm.enterTile(12, 12, 0, c));
    const d = player(4, 12, 12);
    assert.strictEqual(tm.enterTile(12, 12, 0, d), false);

    assert.ok(tm.leaveTile(12, 12, 0, a));
    assert.strictEqual(tm.getFirstOccupant(12, 12, 0), 2);
    assert.deepStrictEqual(tm.getCombatants(12, 12, 0), [2, 3]);

    assert.ok(tm.leaveTile(12, 12, 0, b));
    assert.ok(tm.leaveTile(12, 12, 0, c));
    assert.strictEqual(tm.getOccupant(12, 12, 0), 0);
    assert.strictEqual(tm.playerStacks.size, 0);

    assert.strictEqual(tm.canEnter(0, 0, 0, a), false);
    assert.strictEqual(tm.canEnter(4, 4, 0, a), false);

    tm.setNoPlayerStack(10, 8, 0, true);
    const e = player(5, 10, 8);
    assert.ok(tm.enterTile(10, 8, 0, e));
    const f = player(6, 10, 8);
    assert.strictEqual(tm.enterTile(10, 8, 0, f), false);
    assert.ok(tm.leaveTile(10, 8, 0, e));

    a.x = 12;
    a.y = 12;
    assert.ok(tm.enterTile(12, 12, 0, a));
    assert.ok(tm.moveEntityToTile(12, 11, 0, a));
    assert.strictEqual(a.y, 11);
    assert.strictEqual(tm.getOccupant(12, 12, 0), 0);
    assert.strictEqual(tm.getOccupant(12, 11, 0), 1);
    assert.strictEqual(tm.moveEntityToTile(12, 0, 0, a), false);
    assert.strictEqual(tm.getOccupant(12, 11, 0), 1);

    const cr = { id: 99, type: 'creature', x: 11, y: 8, z: 0 };
    ents.set(99, cr);
    assert.ok(tm.canEnter(11, 8, 0, cr));
    assert.ok(tm.enterTile(11, 8, 0, cr));
    assert.strictEqual(tm.canEnter(11, 8, 0, f), false);
    assert.strictEqual(tm.canEnter(12, 11, 0, cr), false);

    const solo = new TileMap({
        cols: 8,
        rows: 8,
        friction: new Uint8Array(64).fill(100),
        maxStack: 1,
        resolveEntity: (id) => ents.get(id) || null
    });
    const p1 = player(21, 3, 3);
    const p2 = player(22, 3, 3);
    assert.ok(solo.enterTile(3, 3, 0, p1));
    assert.strictEqual(solo.canEnter(3, 3, 0, p2), false);
    const near = solo.findNearestEnterable(3, 3, 0, p2);
    assert.ok(near);
    assert.ok(!(near.x === 3 && near.y === 3));
    assert.ok(solo.enterTile(near.x, near.y, 0, p2));

    assert.strictEqual(hopsOnStep('stairs'), true);
    assert.strictEqual(hopsOnStep('hole'), true);
    assert.strictEqual(hopsOnStep(null), true);
    assert.strictEqual(hopsOnStep('ladder'), false);
    assert.strictEqual(hopsOnStep('rope'), false);
    assert.deepStrictEqual(hopDirOffset('south'), { dx: 0, dy: 1 });
    const derived = resolveStairDest({
        x: 2, y: 2, z: 6, dir: 'south', type: 'stairs', deltaZ: 1
    });
    assert.strictEqual(derived.to.x, 2);
    assert.strictEqual(derived.to.y, 3);
    assert.strictEqual(derived.to.z, 7);
    assert.strictEqual(resolveStairDest({
        x: 2, y: 2, z: 6, dir: 'custom', type: 'stairs', deltaZ: 1
    }), null);

    const floors = new TileMap({
        cols: 8,
        rows: 8,
        z: 0,
        friction: new Uint8Array(64).fill(100),
        resolveEntity: (id) => ents.get(id) || null
    });
    floors.addLayer(1, { friction: new Uint8Array(64).fill(100) });
    floors.installStairs([
        { x: 3, y: 3, z: 0, type: 'stairs', dir: 'center', deltaZ: 1, to: { x: 3, y: 4, z: 1 } },
        { x: 5, y: 5, z: 0, type: 'ladder', dir: 'center', deltaZ: 1, to: { x: 5, y: 5, z: 1 } },
        { x: 4, y: 4, z: 0, type: 'hole', dir: 'center', deltaZ: 1, to: { x: 4, y: 4, z: 1 } }
    ]);
    const climber = player(31, 3, 2);
    climber.z = 0;
    assert.ok(floors.enterTile(3, 2, 0, climber));
    assert.ok(floors.moveEntityToTile(3, 3, 0, climber));
    assert.strictEqual(climber.x, 3);
    assert.strictEqual(climber.y, 4);
    assert.strictEqual(climber.z, 1);
    assert.strictEqual(floors.getOccupant(3, 3, 0), 0);
    assert.strictEqual(floors.getOccupant(3, 4, 1), 31);

    const hole = player(32, 4, 3);
    hole.z = 0;
    assert.ok(floors.enterTile(4, 3, 0, hole));
    assert.ok(floors.moveEntityToTile(4, 4, 0, hole));
    assert.strictEqual(hole.z, 1);

    const lad = player(33, 5, 4);
    lad.z = 0;
    assert.ok(floors.enterTile(5, 4, 0, lad));
    assert.ok(floors.moveEntityToTile(5, 5, 0, lad));
    assert.strictEqual(lad.x, 5);
    assert.strictEqual(lad.y, 5);
    assert.strictEqual(lad.z, 0);
    assert.ok(floors.tryUseStair(lad));
    assert.strictEqual(lad.z, 1);

    const bounce = player(34, 3, 3);
    bounce.z = 1;
    floors.addStair({ x: 3, y: 4, z: 1 }, { x: 3, y: 3, z: 0 }, { type: 'stairs', deltaZ: -1 });
    assert.ok(floors.enterTile(3, 3, 1, bounce));
    assert.ok(floors.moveEntityToTile(3, 4, 1, bounce, { reason: 'stair' }));
    assert.strictEqual(bounce.z, 1);
    assert.strictEqual(bounce.y, 4);

    const mixed = { id: 40, type: 'creature', x: 6, y: 6, z: 1 };
    ents.set(40, mixed);
    assert.ok(floors.enterTile(6, 6, 1, mixed));
    floors.addStair({ x: 6, y: 5, z: 0 }, { x: 6, y: 6, z: 1 }, { type: 'stairs', deltaZ: 1 });
    const hopper = player(35, 6, 5);
    hopper.z = 0;
    assert.ok(floors.enterTile(6, 5, 0, hopper));
    assert.ok(floors.tryUseStair(hopper));
    assert.strictEqual(hopper.z, 1);
    assert.deepStrictEqual(floors.getCombatants(6, 6, 1).sort(), [35, 40].sort());

    const grid = new TileMap({
        cols: 5,
        rows: 5,
        friction: new Uint8Array(25).fill(100),
        resolveEntity: (id) => ents.get(id) || null,
        rng: () => 0
    });
    const m1 = { id: 50, type: 'creature', x: 2, y: 2, z: 0, hp: 10, pushable: true };
    const m2 = { id: 51, type: 'creature', x: 3, y: 2, z: 0, hp: 10, pushable: true };
    ents.set(50, m1);
    ents.set(51, m2);
    assert.ok(grid.enterTile(2, 2, 0, m1));
    assert.ok(grid.enterTile(3, 2, 0, m2));
    assert.strictEqual(grid.canEnter(2, 2, 0, m2), false, 'creature does not stack');
    assert.strictEqual(grid.pathStepOccupancy(2, 2, 0, m2), 'hard');

    const pusher = {
        id: 52, type: 'creature', x: 1, y: 2, z: 0, hp: 10,
        canPushCreatures: true, pushable: false
    };
    ents.set(52, pusher);
    assert.ok(grid.enterTile(1, 2, 0, pusher));
    assert.strictEqual(grid.pathStepOccupancy(2, 2, 0, pusher), 'soft');
    assert.ok(grid.canEnter(2, 2, 0, pusher));
    assert.ok(grid.moveEntityToTile(2, 2, 0, pusher));
    assert.strictEqual(grid.getOccupant(2, 2, 0), 52);
    assert.ok(grid.getOccupant(m1.x, m1.y, 0) === 50);
    assert.ok(!(m1.x === 2 && m1.y === 2), 'shoved off dest');
    assert.strictEqual(grid.getCombatants(2, 2, 0).length, 1);

    const box = new TileMap({
        cols: 3,
        rows: 3,
        friction: new Uint8Array(9).fill(255),
        resolveEntity: (id) => ents.get(id) || null,
        rng: () => 0,
        crush: true
    });
    box.getLayer(0).friction[box.index(0, 0, 3)] = 100;
    box.getLayer(0).friction[box.index(1, 1, 3)] = 100;
    const trapped = { id: 60, type: 'creature', x: 1, y: 1, z: 0, hp: 8, pushable: true };
    const crusher = {
        id: 61, type: 'creature', x: 0, y: 0, z: 0, hp: 8,
        canPushCreatures: true, pushable: false
    };
    ents.set(60, trapped);
    ents.set(61, crusher);
    assert.ok(box.enterTile(1, 1, 0, trapped));
    assert.ok(box.enterTile(0, 0, 0, crusher));
    assert.ok(box.moveEntityToTile(1, 1, 0, crusher));
    assert.strictEqual(trapped.hp, 0);
    assert.strictEqual(box.getOccupant(1, 1, 0), 61);

    console.log('ok tilemap');
}

main();

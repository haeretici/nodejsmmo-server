'use strict';

const assert = require('assert');
const { TileMap, FRICTION_BLOCKED } = require('../src/world/tilemap');
const { findPath, MinHeap, heuristic } = require('../src/world/pathfinder');

function openFloor(cols, rows) {
    return new TileMap({
        cols,
        rows,
        friction: new Uint8Array(cols * rows).fill(100)
    });
}

function wallAt(map, x, y) {
    const layer = map.getLayer(0);
    layer.friction[map.index(x, y, layer.cols)] = FRICTION_BLOCKED;
}

function main() {
    const h = new MinHeap((a, b) => a.f - b.f || a.h - b.h);
    h.push({ f: 3, h: 1, id: 'c' });
    h.push({ f: 1, h: 2, id: 'a' });
    h.push({ f: 2, h: 0, id: 'b' });
    h.push({ f: 1, h: 1, id: 'a2' });
    assert.strictEqual(h.pop().id, 'a2');
    assert.strictEqual(h.pop().id, 'a');
    assert.strictEqual(h.pop().id, 'b');
    assert.strictEqual(h.pop().id, 'c');

    assert.strictEqual(heuristic(3, 0, false), 3);
    const oct = heuristic(3, 4, true);
    assert.ok(Math.abs(oct - (1 + 3 * Math.SQRT2)) < 1e-9);

    const straight = findPath(
        openFloor(5, 5),
        { x: 0, y: 2, z: 0 },
        { x: 4, y: 2, z: 0 },
        { allowDiagonal: false }
    );
    assert.ok(straight);
    assert.strictEqual(straight.length, 5);
    for (const p of straight) assert.strictEqual(p.y, 2);

    const diag = findPath(
        openFloor(5, 5),
        { x: 0, y: 0, z: 0 },
        { x: 3, y: 3, z: 0 },
        { allowDiagonal: true }
    );
    assert.ok(diag);
    assert.strictEqual(diag.length, 4);

    const detour = openFloor(5, 3);
    wallAt(detour, 2, 0);
    wallAt(detour, 2, 1);
    const path = findPath(
        detour,
        { x: 0, y: 0, z: 0 },
        { x: 4, y: 0, z: 0 },
        { allowDiagonal: true }
    );
    assert.ok(path, 'detour path');
    const walls = new Set(['2,0', '2,1']);
    for (const p of path) {
        assert.ok(!walls.has(`${p.x},${p.y}`), `stepped on wall ${p.x},${p.y}`);
    }
    assert.deepStrictEqual(path[0], { x: 0, y: 0 });
    assert.deepStrictEqual(path[path.length - 1], { x: 4, y: 0 });

    const same = findPath(openFloor(3, 3), { x: 1, y: 1, z: 0 }, { x: 1, y: 1, z: 0 });
    assert.deepStrictEqual(same, [{ x: 1, y: 1 }]);

    const crossZ = findPath(
        openFloor(3, 3),
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 2, z: 1 }
    );
    assert.strictEqual(crossZ, null);

    const frictionCost = openFloor(4, 1);
    frictionCost.getLayer(0).friction[1] = 200;
    frictionCost.getLayer(0).friction[2] = 70;
    const a = findPath(
        frictionCost,
        { x: 0, y: 0, z: 0 },
        { x: 3, y: 0, z: 0 },
        { allowDiagonal: false }
    );
    assert.ok(a);
    assert.strictEqual(a.length, 4, 'walkable gray is not A* cost');

    console.log('ok pathfinder');
}

main();

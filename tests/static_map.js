'use strict';

const assert = require('assert');
const {
    createStaticMap,
    viewport,
    clampSpawn,
    tileAt,
    inViewport,
    TILE,
    MAP_W,
    VIEW_W,
    VIEW_H
} = require('../src/world/static_map');

function main() {
    const map = createStaticMap();
    assert.strictEqual(map.width, MAP_W);
    assert.strictEqual(tileAt(map, 0, 0), TILE.WALL);
    assert.strictEqual(tileAt(map, 12, 12), TILE.SPAWN);
    assert.strictEqual(tileAt(map, 12, 8), TILE.PATH);

    const edge = clampSpawn(map, 0, 0, 0);
    assert.strictEqual(edge.x, 12);
    assert.strictEqual(edge.y, 12);

    const ok = clampSpawn(map, 10, 8, 0);
    assert.strictEqual(ok.x, 10);
    assert.strictEqual(ok.y, 8);
    const badZ = clampSpawn(map, 10, 8, 1);
    assert.strictEqual(badZ.x, 12);
    assert.strictEqual(badZ.y, 12);
    assert.strictEqual(badZ.z, 0);

    const vp = viewport(map, 12, 12);
    assert.strictEqual(vp.width, VIEW_W);
    assert.strictEqual(vp.height, VIEW_H);
    assert.strictEqual(vp.z, 0);
    assert.ok(vp.originX >= 0);
    assert.ok(vp.originX + vp.width <= map.width);

    const corner = viewport(map, 1, 1);
    assert.strictEqual(corner.originX, 0);
    assert.strictEqual(corner.originY, 0);
    assert.ok(inViewport(map, 12, 12, 12, 12, 0));
    assert.strictEqual(inViewport(map, 12, 12, 12, 6, 0), false);
    console.log('ok static_map');
}

main();

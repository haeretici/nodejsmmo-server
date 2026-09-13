'use strict';

const assert = require('assert');
const { testSettings } = require('./helpers');
const { World } = require('../src/world/world');
const { MemoryStore } = require('../src/persist/memory_store');
const { createLog } = require('../src/log');
const { isBlocked, TILE } = require('../src/world/static_map');
const { loadPack, resolveContentPath, runtimeMap, resolveMapId } = require('../src/content/load_pack');
const { SERVER_ROOT } = require('../src/config/load_settings');

function main() {
    assert.strictEqual(isBlocked(TILE.WALL), true);
    assert.strictEqual(isBlocked(1, { 1: { walk: true } }), false);
    assert.strictEqual(isBlocked(1, { 1: { walk: false } }), true);

    const root = resolveContentPath({ contentPath: '../content' }, SERVER_ROOT);
    const pack = loadPack(root);
    assert.strictEqual(pack.map.id, 'firstlight_isle');
    assert.strictEqual(pack.map.width, 225);
    assert.strictEqual(pack.map.height, 198);
    assert.ok(pack.templates.rat);
    assert.ok(pack.templates.town_guide);
    assert.ok(!pack.templates.guide);

    const map = runtimeMap(pack);
    assert.strictEqual(map.width, 225);
    assert.strictEqual(map.spawnX, 80);
    assert.strictEqual(map.spawnY, 132);
    assert.strictEqual(map.spawnZ, 6);
    assert.ok(map.tileset[5].walk);
    assert.strictEqual(Object.keys(map.floors).length, 16);
    assert.strictEqual(map.floors[0].friction[0], 255);
    assert.strictEqual(map.floors[6].friction[132 * 225 + 80], 100);
    assert.ok(map.stairs.length >= 2);
    assert.strictEqual(map.spawns.length, 761);
    assert.ok(Array.isArray(map.world));
    assert.ok(map.world.some((p) => p && p.id === 'harvest_7_62_138'));
    assert.ok(map.world.some((p) => p && p.id === 'harvest_7_99_195'));
    assert.ok(map.spawns.some((s) => s.kind === 'woodling' && s.z === 5));
    assert.ok(!map.spawns.some((s) => s.kind === 'rat' && s.x === 224 && s.y === 51 && s.z === 7));
    assert.ok(!map.floors[6].subLayers);
    assert.strictEqual(resolveMapId({}, pack), 'firstlight_isle');
    assert.strictEqual(resolveMapId({ mapId: 'village' }, pack), 'village');
    const village = runtimeMap(pack, 'village');
    assert.strictEqual(village.format, 'hybrid');
    assert.strictEqual(village.width, 24);
    assert.strictEqual(village.friction[0], 255);
    assert.ok(!village.subLayers);

    const settings = testSettings();
    delete settings.spawns;
    delete settings.npcs;
    const world = new World({
        settings,
        store: new MemoryStore(),
        log: createLog(settings),
        pack,
        schedule: () => 0,
        clear: () => {}
    });
    assert.strictEqual(world.spawnPins.length, 761);
    assert.strictEqual(world.creatures.size, 0);
    const town = world.townSpawn();
    assert.strictEqual(town.x, 80);
    assert.strictEqual(town.y, 132);
    assert.strictEqual(town.z, 6);
    assert.strictEqual(world.stairs.length, map.stairs.length);
    assert.ok(world.tileMap.getLayer(0));
    assert.ok(world.tileMap.getLayer(6));
    assert.ok(world.tileMap.getLayer(15));
    assert.strictEqual(world.tileMap.isWalkable(80, 132, 6), true);
    assert.strictEqual(world.tileMap.isWalkable(75, 132, 6), false);
    assert.strictEqual(world.tileMap.isWalkable(80, 132, 0), false);
    world.stop();

    const empty = testSettings();
    const isolated = new World({
        settings: empty,
        store: new MemoryStore(),
        log: createLog(empty),
        schedule: () => 0,
        clear: () => {}
    });
    assert.strictEqual(isolated.creatures.size, 0);
    isolated.stop();

    console.log('ok content_pack');
}

main();

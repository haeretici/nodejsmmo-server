'use strict';

const assert = require('assert');
const { WorldTick } = require('../src/world/tick');

function main() {
    let t = 0;
    const queued = [];
    const ticks = [];
    const world = new WorldTick({
        ups: 20,
        now: () => t,
        schedule: (fn, ms) => {
            queued.push({ fn, ms });
            return queued.length;
        },
        clear: () => {},
        onTick: (i) => ticks.push(i),
        maxCatchUp: 5
    });
    world.start();
    assert.strictEqual(world.running, true);
    assert.strictEqual(queued.length, 1);
    assert.strictEqual(queued[0].ms, 50);

    t = 50;
    queued.shift().fn();
    assert.deepStrictEqual(ticks, [1]);
    assert.strictEqual(world.tickIndex, 1);

    t = 50 + 50 * 10;
    queued.shift().fn();
    assert.strictEqual(ticks.length, 1 + 5);
    assert.ok(world.missedTicks >= 1);

    world.stop();
    assert.strictEqual(world.running, false);
    console.log('ok tick');
}

main();

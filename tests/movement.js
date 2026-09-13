'use strict';

const assert = require('assert');
const {
    computeMoveDelay,
    delayToTicks,
    getMovementDelay,
    DEFAULT_TILE_FRICTION
} = require('../src/world/movement');

function main() {
    assert.strictEqual(getMovementDelay(100, 110), 0.4);
    assert.strictEqual(getMovementDelay(100, 220), 0.2);
    assert.strictEqual(computeMoveDelay(100, 110, false), 0.4);
    assert.strictEqual(computeMoveDelay(100, 110, true), 0.8);
    assert.strictEqual(computeMoveDelay(255, 110, false), 0.4, 'blocked gray falls back');
    assert.strictEqual(delayToTicks(0.4, 20), 8);
    assert.strictEqual(delayToTicks(0.05, 20), 1);
    assert.strictEqual(DEFAULT_TILE_FRICTION, 100);
    console.log('ok movement');
}

main();

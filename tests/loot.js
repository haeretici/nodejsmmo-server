'use strict';

const assert = require('assert');
const { rollLoot, stackItem, countItem, takeItem, MAX_LOOT_CHANCE } = require('../src/world/loot');

function main() {
    assert.strictEqual(MAX_LOOT_CHANCE, 100000);

    const never = rollLoot([{ id: 'gold_coin', chance: 0 }], () => 0);
    assert.deepStrictEqual(never, []);

    const always = rollLoot(
        [{ id: 'gold_coin', name: 'Gold Coin', chance: 100000, maxCount: 1 }],
        () => 0.5
    );
    assert.strictEqual(always.length, 1);
    assert.strictEqual(always[0].id, 'gold_coin');
    assert.strictEqual(always[0].count, 1);

    const skipUnknown = rollLoot([{ chance: 100000, name: 'x' }], () => 0);
    assert.strictEqual(skipUnknown.length, 0);

    const stacked = [];
    stackItem(stacked, 'gold_coin', 2);
    stackItem(stacked, 'gold_coin', 1);
    stackItem(stacked, 'cheese', 1);
    assert.strictEqual(stacked.length, 2);
    assert.strictEqual(stacked[0].count, 3);
    assert.strictEqual(stacked[1].id, 'cheese');
    assert.strictEqual(countItem(stacked, 'gold_coin'), 3);
    assert.strictEqual(takeItem(stacked, 'gold_coin', 1), true);
    assert.strictEqual(countItem(stacked, 'gold_coin'), 2);
    assert.strictEqual(takeItem(stacked, 'gold_coin', 99), false);
    assert.strictEqual(takeItem(stacked, 'missing', 1), false);

    console.log('ok loot');
}

main();

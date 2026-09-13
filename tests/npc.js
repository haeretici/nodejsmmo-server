'use strict';

const assert = require('assert');
const { TEMPLATES } = require('../src/world/templates');
const {
    evalWhen,
    listReplies,
    resolveNode,
    normalizeDialog,
    resolveShop,
    listShopRows,
    talkRangeOk,
    isNpcEntity
} = require('../src/world/npc');

function main() {
    const player = { inventory: [], storage: Object.create(null) };
    assert.strictEqual(evalWhen(player, { storage: 'guide.mission', min: 1 }), false);
    player.storage['guide.mission'] = 1;
    assert.strictEqual(evalWhen(player, { storage: 'guide.mission', min: 1 }), true);
    player.inventory = [{ id: 'cheese', count: 1 }];
    assert.strictEqual(evalWhen(player, { item: 'cheese', min: 1 }), true);
    assert.strictEqual(evalWhen(player, [
        { item: 'cheese', min: 1 },
        { storage: 'guide.mission', max: 1 }
    ]), true);

    const dialog = normalizeDialog(TEMPLATES.guide.dialog);
    const start = resolveNode(dialog, null);
    const empty = listReplies(start.node, { inventory: [], storage: {} });
    assert.ok(empty.some((r) => r.label === 'Trade'));
    assert.ok(empty.some((r) => r.label === 'Job'));

    const job = resolveNode(dialog, 'job');
    const noCheese = listReplies(job.node, { inventory: [], storage: { 'guide.mission': 1 } });
    assert.ok(!noCheese.some((r) => r.label === 'I have the cheese'));
    const yes = listReplies(job.node, {
        inventory: [{ id: 'cheese', count: 1 }],
        storage: { 'guide.mission': 1 }
    });
    assert.ok(yes.some((r) => r.label === 'I have the cheese'));

    const shop = resolveShop(TEMPLATES.guide);
    assert.strictEqual(shop.currency, 'gold_coin');
    const hidden = listShopRows(shop, { inventory: [], storage: {} });
    assert.ok(hidden.some((r) => r.itemId === 'cookie'));
    assert.ok(!hidden.some((r) => r.itemId === 'torch'));
    const shown = listShopRows(shop, { inventory: [], storage: { 'guide.mission': 1 } });
    assert.ok(shown.some((r) => r.itemId === 'torch'));

    assert.strictEqual(talkRangeOk({ x: 12, y: 12, z: 0 }, { x: 12, y: 9, z: 0 }, 3), true);
    assert.strictEqual(talkRangeOk({ x: 12, y: 12, z: 0 }, { x: 12, y: 8, z: 0 }, 3), false);
    assert.ok(isNpcEntity({ type: 'npc', isNpc: true }));
    assert.ok(!isNpcEntity({ type: 'creature' }));

    console.log('ok npc');
}

main();

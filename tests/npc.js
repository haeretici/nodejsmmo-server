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
    isNpcEntity,
    SPECTATOR_RANGE,
    normalizeVoices,
    copyNpcWanderFields,
    hasNpcIdle,
    intervalMsToTicks,
    inWalkZone,
    npcIsInConversation,
    hasNearbySpectator
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

    assert.deepStrictEqual(normalizeVoices(['Hi', '  ', { text: 'Yo', yellText: true }]), [
        { text: 'Hi', yell: false },
        { text: 'Yo', yell: true }
    ]);
    const dest = {};
    copyNpcWanderFields(dest, {
        walkInterval: 2000,
        walkRadius: 2,
        voiceVector: [{ text: 'A', yellText: true }],
        yellSpeedTicks: 15000,
        yellChance: 25
    });
    assert.strictEqual(dest.walkInterval, 2000);
    assert.strictEqual(dest.walkRadius, 2);
    assert.strictEqual(dest.voiceInterval, 15000);
    assert.strictEqual(dest.voiceChance, 25);
    assert.deepStrictEqual(dest.voices, [{ text: 'A', yell: true }]);
    assert.strictEqual(hasNpcIdle(dest), true);
    assert.strictEqual(hasNpcIdle({}), false);
    assert.strictEqual(SPECTATOR_RANGE, 8);
    assert.strictEqual(intervalMsToTicks(2000, 20), 40);
    assert.strictEqual(intervalMsToTicks(0, 20), 0);
    const home = { x: 5, y: 5, z: 0 };
    assert.strictEqual(inWalkZone(home, { x: 7, y: 5, z: 0 }, 2), true);
    assert.strictEqual(inWalkZone(home, { x: 8, y: 5, z: 0 }, 2), false);
    const npc = { id: 9, x: 5, y: 5, z: 0 };
    assert.strictEqual(npcIsInConversation(npc, [{ talkNpcId: 9 }]), true);
    assert.strictEqual(npcIsInConversation(npc, [{ talkNpcId: 0 }]), false);
    assert.strictEqual(hasNearbySpectator(npc, [{ x: 5, y: 13, z: 0, hp: 10 }], 8), true);
    assert.strictEqual(hasNearbySpectator(npc, [{ x: 5, y: 14, z: 0, hp: 10 }], 8), false);

    console.log('ok npc');
}

main();

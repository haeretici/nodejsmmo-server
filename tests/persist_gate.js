'use strict';

const assert = require('assert');
const { PersistGate } = require('../src/persist/persist_gate');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const g = new PersistGate(2);
    let current = 0;
    let max = 0;
    const jobs = [];
    for (let i = 0; i < 6; i++) {
        jobs.push(g.run(async () => {
            current += 1;
            max = Math.max(max, current);
            await delay(20);
            current -= 1;
        }));
    }
    await Promise.all(jobs);
    assert.strictEqual(max, 2);
    assert.strictEqual(g.active, 0);

    const one = new PersistGate(0);
    assert.strictEqual(one.limit, 8, '0 / invalid falls back to 8');

    console.log('ok persist_gate');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

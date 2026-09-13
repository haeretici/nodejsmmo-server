'use strict';

const assert = require('assert');
const { hashPassword, verifyPassword, parsePhc, dummyPasswordHash } = require('../src/security/password');

const TEST_ARGON = {
    memoryCost: 32,
    timeCost: 1,
    parallelism: 1,
    hashLength: 32,
    saltLength: 16
};

async function main() {
    const phc = await hashPassword('correct-horse', TEST_ARGON);
    assert.ok(phc.startsWith('$argon2id$v=19$m=32,t=1,p=1$'));
    const parsed = parsePhc(phc);
    assert.ok(parsed);
    assert.strictEqual(parsed.memoryCost, 32);
    assert.strictEqual(await verifyPassword('correct-horse', phc), true);
    assert.strictEqual(await verifyPassword('wrong-password', phc), false);
    assert.strictEqual(await verifyPassword('correct-horse', 'not-a-hash'), false);

    const dummy = dummyPasswordHash(TEST_ARGON);
    assert.strictEqual(dummy, dummyPasswordHash(TEST_ARGON));
    assert.strictEqual(await verifyPassword('correct-horse', dummy), false);

    console.log('ok password');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

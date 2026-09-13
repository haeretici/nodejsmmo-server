'use strict';

const assert = require('assert');
const { randomToken, tokenToHex, parseHexToken, hashToken } = require('../src/security/token');

function main() {
    const a = randomToken();
    const b = randomToken();
    assert.strictEqual(a.length, 32);
    assert.notDeepStrictEqual(a, b);
    const hex = tokenToHex(a);
    assert.strictEqual(hex.length, 64);
    assert.deepStrictEqual(parseHexToken(hex), a);
    assert.strictEqual(parseHexToken('zz'), null);
    assert.strictEqual(parseHexToken(hex.slice(1)), null);
    const h1 = hashToken(a);
    const h2 = hashToken(a);
    assert.strictEqual(h1.length, 32);
    assert.deepStrictEqual(h1, h2);
    assert.notDeepStrictEqual(h1, a);
    console.log('ok token');
}

main();

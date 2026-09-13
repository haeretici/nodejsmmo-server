'use strict';

const { randomBytes, createHash } = require('crypto');

function randomToken() {
    return randomBytes(32);
}

function tokenToHex(buf) {
    return Buffer.from(buf).toString('hex');
}

function parseHexToken(hex) {
    if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/i.test(hex)) {
        return null;
    }
    return Buffer.from(hex, 'hex');
}

function hashToken(buf) {
    return createHash('sha256').update(buf).digest();
}

module.exports = {
    randomToken,
    tokenToHex,
    parseHexToken,
    hashToken
};

'use strict';

const assert = require('assert');
const { clientIp, normalizeIp } = require('../src/security/client_ip');

function main() {
    assert.strictEqual(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
    const req = {
        socket: { remoteAddress: '::ffff:10.0.0.8' },
        headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }
    };
    assert.strictEqual(clientIp(req, { trustedProxy: false }), '10.0.0.8');
    assert.strictEqual(clientIp(req, { trustedProxy: true }), '1.2.3.4');
    console.log('ok client_ip');
}

main();

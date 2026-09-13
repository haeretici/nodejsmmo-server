'use strict';

const assert = require('assert');
const { RateLimiter, PacketGate } = require('../src/security/rate_limit');

function main() {
    let t = 0;
    const lim = new RateLimiter({ now: () => t });
    const limits = {
        maxLoginFailsPerAccount: 3,
        loginLockBaseSec: 30,
        loginLockCapSec: 900,
        maxLoginFailsPerIpPer10Min: 3,
        ipLoginRefuseSec: 600
    };

    assert.strictEqual(lim.allowHttp('1.1.1.1', 2), true);
    assert.strictEqual(lim.allowHttp('1.1.1.1', 2), true);
    assert.strictEqual(lim.allowHttp('1.1.1.1', 2), false);
    assert.strictEqual(lim.allowHttp('2.2.2.2', 2), true);

    t = 61 * 1000;
    assert.strictEqual(lim.allowHttp('1.1.1.1', 2), true);

    assert.strictEqual(lim.nextLockSec(2, limits), 0);
    assert.strictEqual(lim.nextLockSec(3, limits), 30);
    assert.strictEqual(lim.nextLockSec(4, limits), 60);
    assert.strictEqual(lim.nextLockSec(20, limits), 900);

    t = 0;
    lim.recordIpLoginFail('9.9.9.9', limits);
    lim.recordIpLoginFail('9.9.9.9', limits);
    assert.strictEqual(lim.isIpLoginRefused('9.9.9.9'), false);
    lim.recordIpLoginFail('9.9.9.9', limits);
    assert.strictEqual(lim.isIpLoginRefused('9.9.9.9'), true);
    t = 601 * 1000;
    assert.strictEqual(lim.isIpLoginRefused('9.9.9.9'), false);

    t = 0;
    const g = new PacketGate({ rate: 10, burst: 2, now: () => t });
    assert.strictEqual(g.allow(), true);
    assert.strictEqual(g.allow(), true);
    assert.strictEqual(g.allow(), false);
    t = 100;
    assert.strictEqual(g.allow(), true);

    t = 0;
    const lim2 = new RateLimiter({ now: () => t });
    const mal = { malformedClosesPerMin: 2, malformedIgnoreSec: 30 };
    lim2.recordMalformedClose('1.1.1.1', mal);
    assert.strictEqual(lim2.isIpIgnored('1.1.1.1'), false);
    lim2.recordMalformedClose('1.1.1.1', mal);
    assert.strictEqual(lim2.isIpIgnored('1.1.1.1'), true);
    t = 31 * 1000;
    assert.strictEqual(lim2.isIpIgnored('1.1.1.1'), false);

    console.log('ok rate_limit');
}

main();

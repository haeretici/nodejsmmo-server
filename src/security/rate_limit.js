'use strict';

const WINDOW_HTTP_MS = 60 * 1000;
const WINDOW_LOGIN_IP_MS = 10 * 60 * 1000;
const WINDOW_MALFORMED_MS = 60 * 1000;

class PacketGate {
    /**
     * Token bucket: `rate` tokens/sec, capacity `burst`.
     * @param {{ rate: number, burst: number, now?: () => number }} opts
     */
    constructor(opts) {
        this.rate = opts.rate > 0 ? opts.rate : 30;
        this.burst = opts.burst > 0 ? opts.burst : 10;
        this.now = opts.now || (() => Date.now());
        this.tokens = this.burst;
        this.last = this.now();
    }

    allow() {
        const t = this.now();
        const dt = Math.max(0, t - this.last) / 1000;
        this.last = t;
        this.tokens = Math.min(this.burst, this.tokens + dt * this.rate);
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return true;
        }
        return false;
    }
}

class RateLimiter {
    /**
     * @param {{ now?: () => number }} [opts]
     */
    constructor(opts = {}) {
        this.now = opts.now || (() => Date.now());
        this.httpHits = new Map();
        this.loginFailsIp = new Map();
        this.ipRefuseUntil = new Map();
        this.malformedCloses = new Map();
        this.ipIgnoreUntil = new Map();
        this.metrics = {
            httpRejected: 0,
            loginFails: 0,
            ipRefused: 0,
            connRejected: 0,
            packetsDropped: 0,
            wsAccepted: 0,
            wsRejected: 0,
            malformed: 0,
            enterOk: 0,
            enterFail: 0
        };
    }

    allowHttp(ip, maxPerMin) {
        const t = this.now();
        const arr = (this.httpHits.get(ip) || []).filter((x) => t - x < WINDOW_HTTP_MS);
        if (arr.length >= maxPerMin) {
            this.httpHits.set(ip, arr);
            this.metrics.httpRejected += 1;
            return false;
        }
        arr.push(t);
        this.httpHits.set(ip, arr);
        return true;
    }

    isIpLoginRefused(ip) {
        const until = this.ipRefuseUntil.get(ip) || 0;
        if (until > this.now()) {
            this.metrics.ipRefused += 1;
            return true;
        }
        if (until) this.ipRefuseUntil.delete(ip);
        return false;
    }

    recordIpLoginFail(ip, limits) {
        const t = this.now();
        this.metrics.loginFails += 1;
        const arr = (this.loginFailsIp.get(ip) || []).filter((x) => t - x < WINDOW_LOGIN_IP_MS);
        arr.push(t);
        this.loginFailsIp.set(ip, arr);
        const max = limits.maxLoginFailsPerIpPer10Min | 0;
        if (max > 0 && arr.length >= max) {
            this.ipRefuseUntil.set(ip, t + (limits.ipLoginRefuseSec | 0) * 1000);
        }
    }

    nextLockSec(failedLogins, limits) {
        const max = limits.maxLoginFailsPerAccount | 0;
        if (failedLogins < max) return 0;
        const base = limits.loginLockBaseSec | 0 || 30;
        const cap = limits.loginLockCapSec | 0 || 900;
        const exp = base * Math.pow(2, failedLogins - max);
        return Math.min(cap, exp);
    }

    isIpIgnored(ip) {
        const until = this.ipIgnoreUntil.get(ip) || 0;
        if (until > this.now()) return true;
        if (until) this.ipIgnoreUntil.delete(ip);
        return false;
    }

    recordMalformedClose(ip, limits) {
        this.metrics.malformed += 1;
        const t = this.now();
        const arr = (this.malformedCloses.get(ip) || []).filter((x) => t - x < WINDOW_MALFORMED_MS);
        arr.push(t);
        this.malformedCloses.set(ip, arr);
        const max = limits.malformedClosesPerMin | 0;
        if (max > 0 && arr.length >= max) {
            this.ipIgnoreUntil.set(ip, t + (limits.malformedIgnoreSec | 0) * 1000);
        }
    }
}

module.exports = { RateLimiter, PacketGate };

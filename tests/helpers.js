'use strict';

const http = require('http');
const { loadSettings, SERVER_ROOT } = require('../src/config/load_settings');
const { MemoryStore } = require('../src/persist/memory_store');
const { RateLimiter } = require('../src/security/rate_limit');
const { World } = require('../src/world/world');
const { startHttp } = require('../src/http/server');
const { createLog } = require('../src/log');

function testSettings() {
    const s = loadSettings({ root: SERVER_ROOT, env: {} });
    s.httpPort = 0;
    s.bind = '127.0.0.1';
    s.security.argon2 = {
        memoryCost: 32,
        timeCost: 1,
        parallelism: 1,
        hashLength: 32,
        saltLength: 16
    };
    s.limits.maxHttpPerIpPerMin = 1000;
    s.limits.maxLoginFailsPerAccount = 3;
    s.limits.loginLockBaseSec = 30;
    s.limits.maxConnectionsPerIp = 32;
    s.logLevel = 'error';
    s.spawns = [];
    s.npcs = [];
    s.fixedStepDelay = true;
    s.aiCreatureThinkIntervalSec = 0;
    s.aiRepathIntervalSec = 0;
    s.persistIntervalMs = 0;
    s.persistConcurrency = 8;
    s.globalSaveTime = '';
    s.globalSaveNotifyMinutes = 0;
    s.globalSaveShutdown = false;
    return s;
}

function request(port, { method, path, body, cookie }) {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
    }
    if (cookie) headers.Cookie = cookie;
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            method,
            path,
            headers
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks);
                const text = raw.toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch { /* ignore */ }
                const setCookie = res.headers['set-cookie'] && res.headers['set-cookie'][0];
                let sid = null;
                if (setCookie) {
                    const m = /sid=([0-9a-f]*)/i.exec(setCookie);
                    if (m) sid = m[1];
                }
                resolve({ status: res.statusCode, json, raw, text, setCookie, sid });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function withHttp(fn, extra) {
    const settings = testSettings();
    if (extra && extra.settings) Object.assign(settings, extra.settings);
    if (extra && extra.limits) Object.assign(settings.limits, extra.limits);
    const store = extra && extra.store ? extra.store : new MemoryStore();
    const log = createLog(settings);
    const world = extra && extra.world
        ? extra.world
        : new World({ settings, store, log });
    world.start();
    const limiter = extra && extra.limiter ? extra.limiter : new RateLimiter();
    const httpd = await startHttp({ settings, store, limiter, world, log });
    try {
        return await fn({ port: httpd.port, store, settings, limiter, world });
    } finally {
        world.stop();
        await httpd.close();
    }
}

function waitFor(pred, ms) {
    const budget = ms == null ? 1000 : ms;
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (pred()) {
                resolve();
                return;
            }
            if (Date.now() - t0 > budget) {
                reject(new Error('timeout'));
                return;
            }
            setTimeout(tick, 10);
        };
        tick();
    });
}

module.exports = { testSettings, request, withHttp, waitFor, SERVER_ROOT };

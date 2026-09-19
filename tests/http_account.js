'use strict';

const assert = require('assert');
const { request, withHttp } = require('./helpers');
const { hashToken, parseHexToken } = require('../src/security/token');

async function main() {
    await withHttp(async ({ port, store }) => {
        const health = await request(port, { method: 'GET', path: '/health' });
        assert.strictEqual(health.status, 200);
        assert.strictEqual(health.json.ok, true);
        assert.strictEqual(health.json.tick.running, true);
        assert.strictEqual(health.json.tick.players, 0);

        const ready = await request(port, { method: 'GET', path: '/ready' });
        assert.strictEqual(ready.status, 200);

        const dbg = await request(port, { method: 'GET', path: '/debug' });
        assert.strictEqual(dbg.status, 200);
        assert.ok(dbg.text.includes('engine-server debug'));
        // `name` is window.name in browsers; Play must not read the input via that global.
        assert.ok(dbg.text.includes("getElementById('name')"));
        assert.ok(!/\bname\.value\b/.test(dbg.text));

        const badReg = await request(port, {
            method: 'POST',
            path: '/v1/register',
            body: { email: 'x', password: 'short' }
        });
        assert.strictEqual(badReg.status, 422);

        const reg = await request(port, {
            method: 'POST',
            path: '/v1/register',
            body: { email: 'User@Example.com', password: 'correct-horse' }
        });
        assert.strictEqual(reg.status, 201);
        assert.strictEqual(reg.json.email, 'user@example.com');
        assert.ok(reg.sid && reg.sid.length === 64);
        const cookie = `sid=${reg.sid}`;

        const dup = await request(port, {
            method: 'POST',
            path: '/v1/register',
            body: { email: 'user@example.com', password: 'correct-horse' }
        });
        assert.strictEqual(dup.status, 409);

        const me = await request(port, { method: 'GET', path: '/v1/me', cookie });
        assert.strictEqual(me.status, 200);
        assert.strictEqual(me.json.email, 'user@example.com');

        const created = await request(port, {
            method: 'POST',
            path: '/v1/characters',
            cookie,
            body: { name: 'Ash', vocation: 'scout' }
        });
        assert.strictEqual(created.status, 201);
        assert.strictEqual(created.json.vocation, 'scout');
        assert.strictEqual(created.json.level, 1);
        assert.strictEqual(created.json.hp, 150);
        assert.strictEqual(created.json.hpMax, 150);
        assert.strictEqual(created.json.mp, 55);
        assert.strictEqual(created.json.mpMax, 55);
        assert.strictEqual(created.json.pos.x, 12);
        assert.strictEqual(created.json.pos.y, 12);

        const badVoc = await request(port, {
            method: 'POST',
            path: '/v1/characters',
            cookie,
            body: { name: 'Other', vocation: 'wizard' }
        });
        assert.strictEqual(badVoc.status, 422);

        const list = await request(port, { method: 'GET', path: '/v1/characters', cookie });
        assert.strictEqual(list.status, 200);
        assert.strictEqual(list.json.characters.length, 1);

        const play = await request(port, {
            method: 'POST',
            path: '/v1/play',
            cookie,
            body: { characterId: created.json.id }
        });
        assert.strictEqual(play.status, 200);
        assert.ok(/^[0-9a-f]{64}$/.test(play.json.token));
        const tok = await store.findPlayToken(hashToken(parseHexToken(play.json.token)));
        assert.strictEqual(tok.characterId, created.json.id);

        const logout = await request(port, { method: 'POST', path: '/v1/logout', cookie });
        assert.strictEqual(logout.status, 200);
        const me2 = await request(port, { method: 'GET', path: '/v1/me', cookie });
        assert.strictEqual(me2.status, 401);

        const login = await request(port, {
            method: 'POST',
            path: '/v1/login',
            body: { email: 'user@example.com', password: 'correct-horse' }
        });
        assert.strictEqual(login.status, 200);
        const cookie2 = `sid=${login.sid}`;

        const wrong = await request(port, {
            method: 'POST',
            path: '/v1/login',
            body: { email: 'user@example.com', password: 'definitely-wrong' }
        });
        assert.strictEqual(wrong.status, 401);
        assert.strictEqual(wrong.json.error, 'invalid_credentials');

        await request(port, {
            method: 'POST', path: '/v1/login',
            body: { email: 'user@example.com', password: 'definitely-wrong' }
        });
        const locked = await request(port, {
            method: 'POST', path: '/v1/login',
            body: { email: 'user@example.com', password: 'definitely-wrong' }
        });
        assert.strictEqual(locked.status, 401);
        const stillLocked = await request(port, {
            method: 'POST', path: '/v1/login',
            body: { email: 'user@example.com', password: 'correct-horse' }
        });
        assert.strictEqual(stillLocked.status, 403);
        assert.strictEqual(stillLocked.json.error, 'locked');

        const missing = await request(port, {
            method: 'POST',
            path: '/v1/login',
            body: { email: 'nobody@example.com', password: 'correct-horse' }
        });
        assert.strictEqual(missing.status, 401);
        assert.strictEqual(missing.json.error, 'invalid_credentials');

        const del = await request(port, {
            method: 'DELETE',
            path: `/v1/characters/${created.json.id}`,
            cookie: cookie2
        });
        assert.strictEqual(del.status, 200);
        const list2 = await request(port, { method: 'GET', path: '/v1/characters', cookie: cookie2 });
        assert.strictEqual(list2.json.characters.length, 0);
    });

    await withHttp(async ({ port }) => {
        const r1 = await request(port, { method: 'GET', path: '/v1/me' });
        assert.strictEqual(r1.status, 401);
        const r2 = await request(port, { method: 'GET', path: '/v1/me' });
        assert.strictEqual(r2.status, 429);
        const health = await request(port, { method: 'GET', path: '/health' });
        assert.strictEqual(health.status, 200);
    }, { limits: { maxHttpPerIpPerMin: 1 } });

    await withHttp(async ({ port }) => {
        const dbg = await request(port, { method: 'GET', path: '/debug' });
        assert.strictEqual(dbg.status, 404);
    }, { settings: { debugPlayPage: false } });

    console.log('ok http_account');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

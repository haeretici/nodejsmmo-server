'use strict';

const fs = require('fs');
const path = require('path');
const { clientIp } = require('../security/client_ip');
const { readBody, parseJsonBody } = require('./read_body');
const { SERVER_ROOT } = require('../config/load_settings');
const {
    send,
    handleRegister,
    handleLogin,
    handleLogout,
    handleMe,
    handleListCharacters,
    handleCreateCharacter,
    handleDeleteCharacter,
    handlePlay
} = require('./account');

const CHAR_DELETE = /^\/v1\/characters\/(\d+)$/;

function createHandler(deps) {
    const { settings, store, limiter, world, log } = deps;
    const now = deps.now || (() => Date.now());

    return function handler(req, res) {
        Promise.resolve(dispatch(req, res)).catch((err) => {
            if (err && err.code === 'PAYLOAD') {
                send(res, 413, { error: 'payload_too_large' });
                return;
            }
            if (err && (err.code === 'UNPROCESSABLE' || err instanceof SyntaxError)) {
                send(res, 422, { error: 'unprocessable' });
                return;
            }
            log.error('http error', { err: err && err.message });
            if (!res.headersSent) send(res, 500, { error: 'internal' });
            else res.destroy();
        });
    };

    async function dispatch(req, res) {
        const ip = clientIp(req, settings);
        const ctx = { settings, store, limiter, world, log, now, ip };

        if (await store.isIpBanned(ip, now())) {
            send(res, 403, { error: 'forbidden' });
            return;
        }

        let pathname;
        try {
            pathname = new URL(req.url || '/', 'http://local').pathname;
        } catch {
            send(res, 400, { error: 'unprocessable' });
            return;
        }

        const exempt = pathname === '/health' || pathname === '/ready';
        if (!exempt && !limiter.allowHttp(ip, settings.limits.maxHttpPerIpPerMin | 0)) {
            send(res, 429, { error: 'too_many_requests' });
            return;
        }

        if (req.method === 'GET' && pathname === '/debug') {
            if (!settings.debugPlayPage) {
                send(res, 404, { error: 'not_found' });
                return;
            }
            const html = fs.readFileSync(path.join(SERVER_ROOT, 'static', 'debug.html'));
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': html.length,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'self'"
            });
            res.end(html);
            return;
        }

        if (req.method === 'GET' && pathname === '/health') {
            send(res, 200, {
                ok: true,
                tick: world.snapshot(),
                metrics: limiter.metrics
            });
            return;
        }

        if (req.method === 'GET' && pathname === '/ready') {
            let db = false;
            try {
                db = await store.ping();
            } catch {
                db = false;
            }
            const tick = world.snapshot();
            const ready = !!(db && tick.running);
            send(res, ready ? 200 : 503, { ok: ready, db, tick });
            return;
        }

        let body = {};
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            const raw = await readBody(req, settings.limits.jsonBodyBytes | 0);
            body = parseJsonBody(raw);
        }

        if (req.method === 'POST' && pathname === '/v1/register') {
            await handleRegister(ctx, req, res, body);
            return;
        }
        if (req.method === 'POST' && pathname === '/v1/login') {
            await handleLogin(ctx, req, res, body);
            return;
        }
        if (req.method === 'POST' && pathname === '/v1/logout') {
            await handleLogout(ctx, req, res);
            return;
        }
        if (req.method === 'GET' && pathname === '/v1/me') {
            await handleMe(ctx, req, res);
            return;
        }
        if (req.method === 'GET' && pathname === '/v1/characters') {
            await handleListCharacters(ctx, req, res);
            return;
        }
        if (req.method === 'POST' && pathname === '/v1/characters') {
            await handleCreateCharacter(ctx, req, res, body);
            return;
        }
        const del = CHAR_DELETE.exec(pathname);
        if (req.method === 'DELETE' && del) {
            await handleDeleteCharacter(ctx, req, res, Number(del[1]));
            return;
        }
        if (req.method === 'POST' && pathname === '/v1/play') {
            await handlePlay(ctx, req, res, body);
            return;
        }

        send(res, 404, { error: 'not_found' });
    }
}

module.exports = { createHandler };

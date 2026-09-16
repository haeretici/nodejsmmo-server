'use strict';

const { hashPassword, verifyPassword, dummyPasswordHash } = require('../security/password');
const { randomToken, tokenToHex, parseHexToken, hashToken } = require('../security/token');
const { sessionCookieHeader, sidFromRequest } = require('./cookies');
const { buildStarterInventory, serializeInventory } = require('../world/inventory');

const NAME_RE = /^[A-Za-z][A-Za-z0-9]*(?: [A-Za-z0-9]+)*$/;
const RESERVED_NAMES = new Set([
    'admin', 'administrator', 'gm', 'god', 'owner', 'server', 'system', 'null', 'undefined'
]);

function send(res, status, obj, extraHeaders) {
    const buf = Buffer.from(JSON.stringify(obj));
    const headers = Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    }, extraHeaders || {});
    res.writeHead(status, headers);
    res.end(buf);
}

function normalizeEmail(v) {
    if (typeof v !== 'string') return '';
    return v.trim().toLowerCase();
}

function validEmail(email) {
    if (email.length < 5 || email.length > 255) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validPassword(password) {
    return typeof password === 'string' && password.length >= 10 && password.length <= 128;
}

function validCharName(name) {
    if (typeof name !== 'string') return false;
    const n = name.trim();
    if (n.length < 3 || n.length > 20) return false;
    if (!NAME_RE.test(n)) return false;
    if (RESERVED_NAMES.has(n.toLowerCase())) return false;
    return n;
}

function publicAccount(account) {
    return {
        id: account.id,
        email: account.email,
        status: account.status,
        createdAt: account.createdAt instanceof Date ? account.createdAt.toISOString() : account.createdAt
    };
}

function inventoryForNewCharacter(ctx, vocation) {
    const world = ctx && ctx.world;
    const itemDb = world && typeof world.itemDb === 'function' ? world.itemDb() : null;
    const starters = world && world.pack ? world.pack.starters : null;
    return serializeInventory(buildStarterInventory(vocation, itemDb, starters));
}

function publicCharacter(ch) {
    return {
        id: ch.id,
        name: ch.name,
        vocation: ch.vocation,
        level: ch.level,
        experience: ch.experience,
        pos: { x: ch.posX, y: ch.posY, z: ch.posZ },
        hp: ch.hp,
        hpMax: ch.hpMax,
        mp: ch.mp,
        mpMax: ch.mpMax,
        townId: ch.townId,
        lastLogin: ch.lastLogin instanceof Date ? ch.lastLogin.toISOString() : ch.lastLogin,
        lastLogout: ch.lastLogout instanceof Date ? ch.lastLogout.toISOString() : ch.lastLogout,
        createdAt: ch.createdAt instanceof Date ? ch.createdAt.toISOString() : ch.createdAt
    };
}

async function issueSession(ctx, account, req) {
    const raw = randomToken();
    const expiresAt = new Date(ctx.now() + (ctx.settings.limits.sessionTtlSec | 0) * 1000);
    const ua = req.headers['user-agent'];
    await ctx.store.createSession({
        tokenHash: hashToken(raw),
        accountId: account.id,
        expiresAt,
        userAgent: typeof ua === 'string' ? ua.slice(0, 255) : null,
        ip: ctx.ip
    });
    return tokenToHex(raw);
}

async function loadSession(ctx, req) {
    const hex = sidFromRequest(req);
    const raw = parseHexToken(hex);
    if (!raw) return null;
    const row = await ctx.store.findSessionByHash(hashToken(raw));
    if (!row) return null;
    const exp = row.expiresAt instanceof Date ? row.expiresAt.getTime() : new Date(row.expiresAt).getTime();
    if (exp <= ctx.now()) return null;
    const account = await ctx.store.findAccountById(row.accountId);
    if (!account || account.status !== 'active') return null;
    if (await ctx.store.isAccountBanned(account.id, ctx.now())) return null;
    return { account, tokenHash: hashToken(raw) };
}

async function requireSession(ctx, req, res) {
    const sess = await loadSession(ctx, req);
    if (!sess) {
        send(res, 401, { error: 'unauthorized' });
        return null;
    }
    return sess;
}

async function handleRegister(ctx, req, res, body) {
    const email = normalizeEmail(body.email);
    const password = body.password;
    if (!validEmail(email) || !validPassword(password)) {
        send(res, 422, { error: 'unprocessable' });
        return;
    }
    const passwordHash = await hashPassword(password, ctx.settings.security.argon2);
    let account;
    try {
        account = await ctx.store.createAccount({ email, passwordHash });
    } catch (err) {
        if (err && err.code === 'DUPLICATE') {
            send(res, 409, { error: 'conflict' });
            return;
        }
        throw err;
    }
    const sid = await issueSession(ctx, account, req);
    send(res, 201, publicAccount(account), {
        'Set-Cookie': sessionCookieHeader(sid, ctx.settings)
    });
}

async function handleLogin(ctx, req, res, body) {
    if (ctx.limiter.isIpLoginRefused(ctx.ip)) {
        send(res, 429, { error: 'too_many_requests' });
        return;
    }
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const account = validEmail(email) ? await ctx.store.findAccountByEmail(email) : null;
    if (account && account.lockedUntil) {
        const until = account.lockedUntil instanceof Date
            ? account.lockedUntil.getTime()
            : new Date(account.lockedUntil).getTime();
        if (until > ctx.now()) {
            send(res, 403, { error: 'locked' });
            return;
        }
    }
    const hash = account ? account.passwordHash : dummyPasswordHash(ctx.settings.security.argon2);
    const ok = await verifyPassword(password, hash);
    if (!account || !ok) {
        ctx.limiter.recordIpLoginFail(ctx.ip, ctx.settings.limits);
        if (account) {
            const fails = (account.failedLogins | 0) + 1;
            const lockSec = ctx.limiter.nextLockSec(fails, ctx.settings.limits);
            await ctx.store.updateAccountLoginMeta(account.id, {
                failedLogins: fails,
                lockedUntil: lockSec ? new Date(ctx.now() + lockSec * 1000) : null
            });
        }
        send(res, 401, { error: 'invalid_credentials' });
        return;
    }
    if (account.status !== 'active' || await ctx.store.isAccountBanned(account.id, ctx.now())) {
        send(res, 403, { error: 'forbidden' });
        return;
    }
    await ctx.store.updateAccountLoginMeta(account.id, {
        failedLogins: 0,
        lockedUntil: null,
        lastLoginAt: new Date(ctx.now()),
        lastLoginIp: ctx.ip
    });
    const sid = await issueSession(ctx, account, req);
    send(res, 200, publicAccount(account), {
        'Set-Cookie': sessionCookieHeader(sid, ctx.settings)
    });
}

async function handleLogout(ctx, req, res) {
    const sess = await loadSession(ctx, req);
    if (sess) await ctx.store.deleteSession(sess.tokenHash);
    send(res, 200, { ok: true }, {
        'Set-Cookie': sessionCookieHeader('', ctx.settings, { clear: true })
    });
}

async function handleMe(ctx, req, res) {
    const sess = await requireSession(ctx, req, res);
    if (!sess) return;
    send(res, 200, publicAccount(sess.account));
}

async function handleListCharacters(ctx, req, res) {
    const sess = await requireSession(ctx, req, res);
    if (!sess) return;
    const list = await ctx.store.listCharacters(sess.account.id);
    send(res, 200, { characters: list.map(publicCharacter) });
}

async function handleCreateCharacter(ctx, req, res, body) {
    const sess = await requireSession(ctx, req, res);
    if (!sess) return;
    const name = validCharName(body.name);
    const vocation = typeof body.vocation === 'string' ? body.vocation.trim() : '';
    const allowed = ctx.settings.vocations || [];
    if (!name || !allowed.includes(vocation)) {
        send(res, 422, { error: 'unprocessable' });
        return;
    }
    const n = await ctx.store.countCharacters(sess.account.id);
    if (n >= (ctx.settings.limits.maxCharsPerAccount | 0)) {
        send(res, 409, { error: 'limit' });
        return;
    }
    const nc = ctx.settings.newCharacter;
    const town = ctx.world && typeof ctx.world.townSpawn === 'function'
        ? ctx.world.townSpawn()
        : { x: nc.posX, y: nc.posY, z: nc.posZ };
    let ch;
    try {
        ch = await ctx.store.createCharacter({
            accountId: sess.account.id,
            name,
            vocation,
            level: nc.level,
            experience: nc.experience,
            posX: town.x,
            posY: town.y,
            posZ: town.z,
            hp: nc.hp,
            hpMax: nc.hpMax,
            mp: nc.mp,
            mpMax: nc.mpMax,
            townId: nc.townId,
            skills: nc.skills,
            inventory: inventoryForNewCharacter(ctx, vocation),
            storage: {},
            conditions: [],
            hotkeys: {},
            appearance: {}
        });
    } catch (err) {
        if (err && err.code === 'DUPLICATE') {
            send(res, 409, { error: 'conflict' });
            return;
        }
        throw err;
    }
    send(res, 201, publicCharacter(ch));
}

async function handleDeleteCharacter(ctx, req, res, characterId) {
    const sess = await requireSession(ctx, req, res);
    if (!sess) return;
    const ok = await ctx.store.deleteCharacter(sess.account.id, characterId);
    if (!ok) {
        send(res, 404, { error: 'not_found' });
        return;
    }
    send(res, 200, { ok: true });
}

async function handlePlay(ctx, req, res, body) {
    const sess = await requireSession(ctx, req, res);
    if (!sess) return;
    const characterId = Number(body.characterId);
    if (!Number.isInteger(characterId) || characterId < 1) {
        send(res, 422, { error: 'unprocessable' });
        return;
    }
    const ch = await ctx.store.findCharacter(sess.account.id, characterId);
    if (!ch) {
        send(res, 404, { error: 'not_found' });
        return;
    }
    await ctx.store.invalidatePlayTokensForCharacter(ch.id);
    const raw = randomToken();
    const expiresAt = new Date(ctx.now() + (ctx.settings.limits.playTokenTtlSec | 0) * 1000);
    await ctx.store.createPlayToken({
        tokenHash: hashToken(raw),
        accountId: sess.account.id,
        characterId: ch.id,
        ip: ctx.ip,
        expiresAt
    });
    send(res, 200, {
        token: tokenToHex(raw),
        expiresAt: expiresAt.toISOString(),
        characterId: ch.id
    });
}

module.exports = {
    send,
    handleRegister,
    handleLogin,
    handleLogout,
    handleMe,
    handleListCharacters,
    handleCreateCharacter,
    handleDeleteCharacter,
    handlePlay,
    validEmail,
    validPassword,
    validCharName
};

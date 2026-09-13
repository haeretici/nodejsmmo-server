'use strict';

function parseCookieHeader(header) {
    const out = {};
    if (typeof header !== 'string' || header === '') return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k) out[k] = v;
    }
    return out;
}

function sessionCookieHeader(rawHex, settings, { clear = false } = {}) {
    if (clear) {
        return 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0';
    }
    const parts = [
        `sid=${rawHex}`,
        'HttpOnly',
        'Path=/',
        'SameSite=Lax',
        `Max-Age=${settings.limits.sessionTtlSec | 0}`
    ];
    if (settings.cookieSecure) parts.push('Secure');
    return parts.join('; ');
}

function sidFromRequest(req) {
    const cookies = parseCookieHeader(req.headers.cookie);
    return cookies.sid || null;
}

module.exports = {
    parseCookieHeader,
    sessionCookieHeader,
    sidFromRequest
};

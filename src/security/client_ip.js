'use strict';

function stripV4Mapped(ip) {
    if (typeof ip !== 'string') return '0.0.0.0';
    if (ip.startsWith('::ffff:')) return ip.slice(7);
    return ip;
}

function normalizeIp(ip) {
    const s = stripV4Mapped(ip);
    return s || '0.0.0.0';
}

function clientIp(req, settings) {
    const remote = normalizeIp(req.socket && req.socket.remoteAddress);
    if (!settings || !settings.trustedProxy) {
        return remote;
    }
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff !== 'string' || xff.trim() === '') {
        return remote;
    }
    const first = xff.split(',')[0].trim();
    return first ? normalizeIp(first) : remote;
}

module.exports = { normalizeIp, clientIp };

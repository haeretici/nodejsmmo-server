'use strict';

const http = require('http');
const { normalizeIp } = require('../security/client_ip');
const { createHandler } = require('./handler');
const { attachGameWs } = require('../ws/game');

function attachConnectionGuard(server, settings, limiter) {
    const counts = new Map();
    const max = settings.limits.maxConnectionsPerIp | 0;
    server.on('connection', (socket) => {
        const ip = normalizeIp(socket.remoteAddress);
        const n = counts.get(ip) || 0;
        if (max > 0 && n >= max) {
            limiter.metrics.connRejected += 1;
            socket.destroy();
            return;
        }
        counts.set(ip, n + 1);
        socket.on('close', () => {
            const m = (counts.get(ip) || 1) - 1;
            if (m <= 0) counts.delete(ip);
            else counts.set(ip, m);
        });
    });
}

function startHttp(deps) {
    const { settings, limiter } = deps;
    const handler = createHandler(deps);
    const server = http.createServer(handler);
    attachConnectionGuard(server, settings, limiter);
    const port = settings.httpPort;
    const bind = settings.bind;
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bind, () => {
            server.removeListener('error', reject);
            const addr = server.address();
            const wss = attachGameWs(server, deps);
            resolve({
                server,
                wss,
                port: addr.port,
                bind: addr.address,
                close() {
                    return new Promise((res, rej) => {
                        try {
                            for (const c of wss.clients) c.terminate();
                        } catch {
                            // ignore
                        }
                        wss.close(() => {
                            if (typeof server.closeAllConnections === 'function') {
                                server.closeAllConnections();
                            }
                            server.close((err) => (err ? rej(err) : res()));
                        });
                    });
                }
            });
        });
    });
}

module.exports = { startHttp, attachConnectionGuard };

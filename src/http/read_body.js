'use strict';

function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length'] || 0);
        if (declared > maxBytes) {
            const err = new Error('payload_too_large');
            err.code = 'PAYLOAD';
            reject(err);
            return;
        }
        const chunks = [];
        let size = 0;
        let done = false;
        req.on('data', (c) => {
            if (done) return;
            size += c.length;
            if (size > maxBytes) {
                done = true;
                const err = new Error('payload_too_large');
                err.code = 'PAYLOAD';
                req.destroy();
                reject(err);
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (done) return;
            done = true;
            resolve(Buffer.concat(chunks));
        });
        req.on('error', (err) => {
            if (done) return;
            done = true;
            reject(err);
        });
    });
}

function parseJsonBody(buf) {
    if (!buf || buf.length === 0) return {};
    const text = buf.toString('utf8');
    const value = JSON.parse(text);
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
        const err = new Error('unprocessable');
        err.code = 'UNPROCESSABLE';
        throw err;
    }
    return value;
}

module.exports = { readBody, parseJsonBody };

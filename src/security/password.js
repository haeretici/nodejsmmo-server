'use strict';

const { promisify } = require('util');
const { argon2, argon2Sync, randomBytes, timingSafeEqual } = require('crypto');

const argon2Async = promisify(argon2);

function argonParams(opts, message, nonce) {
    const memory = opts.memoryCost | 0;
    const passes = opts.timeCost | 0;
    const parallelism = opts.parallelism | 0;
    const tagLength = opts.hashLength | 0;
    if (memory < 8 || passes < 1 || parallelism < 1 || tagLength < 16) {
        throw new Error('invalid argon2 parameters');
    }
    return {
        message,
        nonce,
        parallelism,
        tagLength,
        memory,
        passes
    };
}

function b64(buf) {
    return Buffer.from(buf).toString('base64');
}

function fromB64(s) {
    return Buffer.from(s, 'base64');
}

function toPhc(nonce, hash, opts) {
    return (
        `$argon2id$v=19$m=${opts.memoryCost},t=${opts.timeCost},p=${opts.parallelism}$` +
        `${b64(nonce)}$${b64(hash)}`
    );
}

function parsePhc(phc) {
    if (typeof phc !== 'string') return null;
    const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(phc);
    if (!m) return null;
    const nonce = fromB64(m[4]);
    const hash = fromB64(m[5]);
    if (nonce.length < 8 || hash.length < 16) return null;
    return {
        memoryCost: Number(m[1]),
        timeCost: Number(m[2]),
        parallelism: Number(m[3]),
        nonce,
        hash
    };
}

async function hashPassword(password, opts) {
    const nonce = randomBytes(opts.saltLength | 0 || 16);
    const hash = await argon2Async('argon2id', argonParams(opts, password, nonce));
    return toPhc(nonce, hash, opts);
}

function hashPasswordSync(password, opts) {
    const nonce = randomBytes(opts.saltLength | 0 || 16);
    const hash = argon2Sync('argon2id', argonParams(opts, password, nonce));
    return toPhc(nonce, hash, opts);
}

async function verifyPassword(password, phc) {
    const parsed = parsePhc(phc);
    if (!parsed || typeof password !== 'string') {
        return false;
    }
    let candidate;
    try {
        candidate = await argon2Async(
            'argon2id',
            argonParams(
                {
                    memoryCost: parsed.memoryCost,
                    timeCost: parsed.timeCost,
                    parallelism: parsed.parallelism,
                    hashLength: parsed.hash.length
                },
                password,
                parsed.nonce
            )
        );
    } catch {
        return false;
    }
    if (candidate.length !== parsed.hash.length) return false;
    return timingSafeEqual(candidate, parsed.hash);
}

const dummyCache = new Map();

function dummyPasswordHash(opts) {
    const key = `${opts.memoryCost}:${opts.timeCost}:${opts.parallelism}:${opts.hashLength}:${opts.saltLength}`;
    let phc = dummyCache.get(key);
    if (!phc) {
        phc = hashPasswordSync('dummy-account-not-used', opts);
        dummyCache.set(key, phc);
    }
    return phc;
}

module.exports = {
    hashPassword,
    hashPasswordSync,
    verifyPassword,
    dummyPasswordHash,
    parsePhc
};

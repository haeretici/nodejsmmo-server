'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.resolve(__dirname, '../..');

const ENV_MAP = [
    ['GAME_BIND', ['bind'], String],
    ['GAME_HTTP_PORT', ['httpPort'], toInt],
    ['GAME_LOG_LEVEL', ['logLevel'], String],
    ['GAME_TRUSTED_PROXY', ['trustedProxy'], toBool],
    ['GAME_COOKIE_SECURE', ['cookieSecure'], toBool],
    ['GAME_MYSQL_HOST', ['mysql', 'host'], String],
    ['GAME_MYSQL_PORT', ['mysql', 'port'], toInt],
    ['GAME_MYSQL_USER', ['mysql', 'user'], String],
    ['GAME_MYSQL_DATABASE', ['mysql', 'database'], String],
    ['GAME_MYSQL_PASSWORD', ['mysql', 'password'], String],
    ['GAME_SESSION_TTL_SEC', ['limits', 'sessionTtlSec'], toInt],
    ['GAME_MAX_PLAYERS', ['maxPlayers'], toInt],
    ['GAME_GLOBAL_SAVE_TIME', ['globalSaveTime'], String],
    ['GAME_GLOBAL_SAVE_NOTIFY_MINUTES', ['globalSaveNotifyMinutes'], toInt],
    ['GAME_GLOBAL_SAVE_SHUTDOWN', ['globalSaveShutdown'], toBool],
    ['GAME_PERSIST_INTERVAL_MS', ['persistIntervalMs'], toInt],
    ['GAME_PERSIST_CONCURRENCY', ['persistConcurrency'], toInt],
    ['GAME_CONTENT_PATH', ['contentPath'], String],
    ['GAME_MAP_ID', ['mapId'], String],
    ['GAME_SPAWN_MAX_LIVING', ['spawnMaxLiving'], toInt],
    ['GAME_OUTBOUND_BATCHING', ['limits', 'outboundBatching'], toBool],
    ['GAME_COALESCE_PAYLOADS', ['limits', 'coalescePayloads'], toBool],
    ['GAME_COMPUTE_WORKERS', ['computeWorkers'], toWorkerSetting],
    ['GAME_COMPUTE_QUEUE_CAPACITY', ['computeQueueCapacity'], toInt],
    ['GAME_COMPUTE_APPLY_DELAY_TICKS', ['computeApplyDelayTicks'], toInt]
];

function toWorkerSetting(v) {
    const s = String(v).trim().toLowerCase();
    if (s === 'auto') return 'auto';
    return toInt(s);
}

function toInt(v) {
    const n = Number.parseInt(String(v), 10);
    if (!Number.isFinite(n)) {
        throw new Error('invalid integer setting');
    }
    return n;
}

function toBool(v) {
    const s = String(v).trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes') return true;
    if (s === '0' || s === 'false' || s === 'no') return false;
    throw new Error('invalid boolean setting');
}

function isPlainObject(v) {
    return v != null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, overlay) {
    if (!isPlainObject(overlay)) {
        return overlay;
    }
    const out = isPlainObject(base) ? Object.assign({}, base) : {};
    for (const key of Object.keys(overlay)) {
        const v = overlay[key];
        if (v === undefined) continue;
        if (Array.isArray(v)) {
            out[key] = v.slice();
        } else if (isPlainObject(v) && isPlainObject(out[key])) {
            out[key] = deepMerge(out[key], v);
        } else {
            out[key] = v;
        }
    }
    return out;
}

function readJson(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const value = JSON.parse(text);
    if (!isPlainObject(value)) {
        throw new Error(`settings file must be a JSON object: ${filePath}`);
    }
    return value;
}

function setPath(obj, keys, value) {
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (!isPlainObject(cur[k])) {
            cur[k] = {};
        }
        cur = cur[k];
    }
    cur[keys[keys.length - 1]] = value;
}

function applyEnv(settings, env) {
    const out = deepMerge({}, settings);
    for (const [envKey, pathKeys, coerce] of ENV_MAP) {
        if (env[envKey] == null || env[envKey] === '') continue;
        setPath(out, pathKeys, coerce(env[envKey]));
    }
    return out;
}

function stripCommittedSecrets(settings) {
    const out = deepMerge({}, settings);
    if (isPlainObject(out.mysql) && Object.prototype.hasOwnProperty.call(out.mysql, 'password')) {
        delete out.mysql.password;
    }
    return out;
}

/**
 * @param {{ root?: string, localPath?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
function loadSettings(opts = {}) {
    const root = opts.root || SERVER_ROOT;
    const env = opts.env || process.env;
    const committedPath = path.join(root, 'config', 'settings.json');
    if (!fs.existsSync(committedPath)) {
        throw new Error(`missing ${committedPath}`);
    }
    let merged = stripCommittedSecrets(readJson(committedPath));
    const localPath = opts.localPath || path.join(root, 'config', 'settings.local.json');
    if (fs.existsSync(localPath)) {
        merged = deepMerge(merged, readJson(localPath));
    }
    return applyEnv(merged, env);
}

function assertBootSecrets(settings) {
    const mysql = settings && settings.mysql;
    if (!mysql || typeof mysql !== 'object') {
        throw new Error('settings.mysql is required');
    }
    if (!mysql.host || !mysql.user || !mysql.database) {
        throw new Error('settings.mysql.host, user, and database are required');
    }
    if (!mysql.password) {
        throw new Error('GAME_MYSQL_PASSWORD is required (or mysql.password in settings.local.json)');
    }
    if (typeof settings.logicUps !== 'number' || settings.logicUps < 1) {
        throw new Error('settings.logicUps must be >= 1');
    }
}

const SECRET_KEYS = new Set(['password', 'password_hash', 'token', 'sid']);

function redactSettings(settings) {
    return redactValue(settings);
}

function redactValue(v) {
    if (Array.isArray(v)) return v.map(redactValue);
    if (!isPlainObject(v)) return v;
    const out = {};
    for (const [k, val] of Object.entries(v)) {
        if (SECRET_KEYS.has(k) || /password|secret|token/i.test(k)) {
            out[k] = '***';
        } else {
            out[k] = redactValue(val);
        }
    }
    return out;
}

module.exports = {
    SERVER_ROOT,
    loadSettings,
    assertBootSecrets,
    deepMerge,
    redactSettings
};

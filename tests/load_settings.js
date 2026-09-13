'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    loadSettings,
    assertBootSecrets,
    deepMerge,
    redactSettings,
    SERVER_ROOT
} = require('../src/config/load_settings');

function withTempRoot(files, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-settings-'));
    fs.mkdirSync(path.join(dir, 'config'));
    for (const [name, obj] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, 'config', name), JSON.stringify(obj, null, 4) + '\n');
    }
    try {
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function main() {
    const nested = deepMerge(
        { mysql: { host: '127.0.0.1', user: 'game', database: 'game' }, vocations: ['a'] },
        { mysql: { database: 'lab' }, vocations: ['b', 'c'] }
    );
    assert.strictEqual(nested.mysql.host, '127.0.0.1');
    assert.strictEqual(nested.mysql.user, 'game');
    assert.strictEqual(nested.mysql.database, 'lab');
    assert.deepStrictEqual(nested.vocations, ['b', 'c']);

    const noLocal = path.join(os.tmpdir(), 'engine-no-local-settings.json');
    const committed = loadSettings({ root: SERVER_ROOT, env: {}, localPath: noLocal });
    assert.strictEqual(committed.logicUps, 20);
    assert.strictEqual(committed.mysql.host, '127.0.0.1');
    assert.ok(!committed.mysql.password);
    assert.ok(committed.vocations.includes('adept'));
    assert.strictEqual(committed.stepDelayTicks, 4);
    assert.strictEqual(committed.playerBaseSpeed, 110);
    assert.strictEqual(committed.aiCreaturePathMaxDistance, 12);
    assert.strictEqual(committed.creaturePushCrush, true);
    assert.strictEqual(committed.playerTileMaxStack, 10);
    assert.strictEqual(committed.persistIntervalMs, 3600000);
    assert.strictEqual(committed.persistConcurrency, 8);
    assert.strictEqual(committed.globalSaveTime, '06:00');
    assert.strictEqual(committed.globalSaveNotifyMinutes, 5);
    assert.strictEqual(committed.globalSaveShutdown, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(committed, 'persistSoonMs'));
    assert.strictEqual(committed.contentPath, '../content');
    assert.ok(!Object.prototype.hasOwnProperty.call(committed, 'mapId'));
    assert.ok(!Object.prototype.hasOwnProperty.call(committed, 'spawns'));
    assert.ok(!Object.prototype.hasOwnProperty.call(committed, 'npcs'));

    withTempRoot({
        'settings.json': {
            bind: '0.0.0.0',
            logicUps: 20,
            mysql: { host: '127.0.0.1', user: 'game', database: 'game', password: 'LEAK' },
            limits: { a: 1 }
        },
        'settings.local.json': {
            mysql: { database: 'lab', user: 'local' },
            logLevel: 'debug'
        }
    }, (root) => {
        const s = loadSettings({
            root,
            env: {
                GAME_MYSQL_PASSWORD: 'from-env',
                GAME_BIND: '127.0.0.1',
                GAME_MAP_ID: 'village'
            }
        });
        assert.strictEqual(s.mysql.password, 'from-env', 'env wins; committed password stripped');
        assert.strictEqual(s.mysql.host, '127.0.0.1');
        assert.strictEqual(s.mysql.database, 'lab');
        assert.strictEqual(s.mysql.user, 'local');
        assert.strictEqual(s.bind, '127.0.0.1');
        assert.strictEqual(s.logLevel, 'debug');
        assert.strictEqual(s.logicUps, 20);
        assert.strictEqual(s.mapId, 'village');

        const redacted = redactSettings(s);
        assert.strictEqual(redacted.mysql.password, '***');
        assert.strictEqual(s.mysql.password, 'from-env');
    });

    const noSecret = loadSettings({ root: SERVER_ROOT, env: {}, localPath: noLocal });
    assert.throws(() => assertBootSecrets(noSecret), /GAME_MYSQL_PASSWORD/);
    noSecret.mysql.password = 'x';
    assertBootSecrets(noSecret);

    console.log('ok load_settings');
}

main();

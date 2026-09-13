'use strict';

const { loadSettings, assertBootSecrets } = require('./config/load_settings');
const { createLog } = require('./log');
const { RateLimiter } = require('./security/rate_limit');
const { World } = require('./world/world');
const { startHttp } = require('./http/server');
const { loadPack, resolveContentPath } = require('./content/load_pack');

async function main() {
    const settings = loadSettings();
    assertBootSecrets(settings);
    const log = createLog(settings);

    let MysqlStore;
    try {
        MysqlStore = require('./persist/mysql_store').MysqlStore;
    } catch (err) {
        log.error('mysql2 missing — run npm install in server/', { err: err && err.message });
        process.exitCode = 1;
        return;
    }

    const store = await MysqlStore.open(settings);
    const pack = loadPack(resolveContentPath(settings));
    const world = new World({ settings, store, log, pack });
    world.start();
    const limiter = new RateLimiter();
    const httpd = await startHttp({ settings, store, limiter, world, log });

    const map = world.map;
    log.info('listen', {
        bind: httpd.bind,
        port: httpd.port,
        ups: settings.logicUps,
        map: map.id || 'static',
        width: map.width,
        height: map.height,
        spawn: world.townSpawn()
    });

    let stopping = false;
    async function shutdown(signal) {
        if (stopping) return;
        stopping = true;
        log.info('shutdown', { signal });
        try {
            if (typeof world.shutdown === 'function') {
                await world.shutdown();
            } else {
                world.stop();
            }
        } catch (err) {
            log.error('world shutdown', { err: err && err.message });
        }
        try {
            await httpd.close();
        } catch (err) {
            log.error('http close', { err: err && err.message });
        }
        try {
            await store.close();
        } catch (err) {
            log.error('store close', { err: err && err.message });
        }
    }

    world.onRequestShutdown = (reason) => shutdown(reason).then(() => process.exit(0));

    process.on('SIGINT', () => {
        shutdown('SIGINT').then(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
        shutdown('SIGTERM').then(() => process.exit(0));
    });
}

main().catch((err) => {
    process.stderr.write(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        msg: 'boot failed',
        err: err && err.message
    }) + '\n');
    process.exit(1);
});

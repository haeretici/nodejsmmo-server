'use strict';

const LEVELS = Object.freeze({
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
});

function createLog(settings) {
    const name = settings && settings.logLevel ? String(settings.logLevel) : 'info';
    const min = Object.prototype.hasOwnProperty.call(LEVELS, name) ? LEVELS[name] : LEVELS.info;

    function write(level, msg, extra) {
        if (LEVELS[level] > min) return;
        const line = { ts: new Date().toISOString(), level, msg };
        if (extra && typeof extra === 'object') {
            for (const [k, v] of Object.entries(extra)) {
                if (/password|secret|token|sid|authorization/i.test(k)) continue;
                line[k] = v;
            }
        }
        const s = JSON.stringify(line) + '\n';
        if (level === 'error') process.stderr.write(s);
        else process.stdout.write(s);
    }

    return {
        error(msg, extra) { write('error', msg, extra); },
        warn(msg, extra) { write('warn', msg, extra); },
        info(msg, extra) { write('info', msg, extra); },
        debug(msg, extra) { write('debug', msg, extra); }
    };
}

module.exports = { createLog };

'use strict';

/**
 * Wall-clock global save. Empty / invalid `globalSaveTime` disables.
 * Accepts `HH:MM` or `HH:MM:SS` in the process local timezone.
 */

function parseClock(value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    const sec = Number(m[3] || 0);
    if (h > 23 || min > 59 || sec > 59) return null;
    return { h, min, sec };
}

function nextClockDate(clock, now) {
    const t = new Date(now.getTime());
    t.setHours(clock.h, clock.min, clock.sec, 0);
    if (t.getTime() <= now.getTime()) {
        t.setDate(t.getDate() + 1);
    }
    return t;
}

function msUntilClock(clock, nowMs) {
    return nextClockDate(clock, new Date(nowMs)).getTime() - nowMs;
}

function globalSaveMessage(minutes) {
    const n = Math.max(1, minutes | 0);
    const unit = n === 1 ? 'minute' : 'minutes';
    return `Server is saving the game in ${n} ${unit}. Please logout.`;
}

module.exports = {
    parseClock,
    nextClockDate,
    msUntilClock,
    globalSaveMessage
};

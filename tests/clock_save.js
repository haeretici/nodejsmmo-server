'use strict';

const assert = require('assert');
const {
    parseClock,
    nextClockDate,
    msUntilClock,
    globalSaveMessage
} = require('../src/world/clock_save');

function main() {
    assert.deepStrictEqual(parseClock('06:00'), { h: 6, min: 0, sec: 0 });
    assert.deepStrictEqual(parseClock('6:00:00'), { h: 6, min: 0, sec: 0 });
    assert.deepStrictEqual(parseClock('23:59:59'), { h: 23, min: 59, sec: 59 });
    assert.strictEqual(parseClock(''), null);
    assert.strictEqual(parseClock('  '), null);
    assert.strictEqual(parseClock('25:00'), null);
    assert.strictEqual(parseClock('12:60'), null);
    assert.strictEqual(parseClock('nope'), null);

    const morning = new Date(2026, 8, 11, 5, 0, 0, 0);
    const atSix = nextClockDate(parseClock('06:00'), morning);
    assert.strictEqual(atSix.getHours(), 6);
    assert.strictEqual(atSix.getDate(), 11);
    assert.strictEqual(msUntilClock(parseClock('06:00'), morning.getTime()), 60 * 60 * 1000);

    const onTheHour = new Date(2026, 8, 11, 6, 0, 0, 0);
    const nextDay = nextClockDate(parseClock('06:00'), onTheHour);
    assert.strictEqual(nextDay.getDate(), 12);

    const evening = new Date(2026, 8, 11, 18, 0, 0, 0);
    assert.strictEqual(nextClockDate(parseClock('06:00'), evening).getDate(), 12);

    assert.strictEqual(
        globalSaveMessage(5),
        'Server is saving the game in 5 minutes. Please logout.'
    );
    assert.strictEqual(
        globalSaveMessage(1),
        'Server is saving the game in 1 minute. Please logout.'
    );
    console.log('ok clock_save');
}

main();

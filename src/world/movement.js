'use strict';

/** Walkable friction when tile data is missing or out of table range. */
const DEFAULT_TILE_FRICTION = 100;

const FRICTION_TABLE = Object.freeze({
    70: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 111, 142, 200, 342, 1070]),
    90: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 120, 147, 192, 278, 499, 1842]),
    95: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 127, 157, 205, 299, 543, 2096]),
    100: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 113, 135, 167, 219, 321, 592, 2382]),
    110: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 126, 150, 187, 248, 367, 696, 3060]),
    120: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 120, 139, 167, 208, 278, 417, 813, 3913]),
    121: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 121, 140, 168, 211, 281, 423, 826, 4012]),
    125: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 125, 146, 175, 219, 293, 444, 876, 4419]),
    130: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 115, 131, 153, 183, 230, 310, 472, 944, 4992]),
    140: Object.freeze([0, 0, 0, 0, 0, 0, 0, 111, 125, 143, 167, 201, 254, 344, 531, 1092, 6341]),
    150: Object.freeze([0, 0, 0, 0, 0, 0, 0, 120, 135, 155, 181, 219, 278, 380, 595, 1258, 8036]),
    160: Object.freeze([0, 0, 0, 0, 0, 0, 116, 129, 145, 167, 196, 238, 304, 419, 663, 1443, 10167]),
    170: Object.freeze([0, 0, 0, 0, 0, 112, 124, 138, 156, 179, 212, 258, 331, 459, 737, 1652, 12846]),
    180: Object.freeze([0, 0, 0, 0, 0, 120, 132, 148, 167, 192, 227, 279, 359, 502, 818, 1886, 16212]),
    200: Object.freeze([0, 0, 0, 114, 124, 135, 149, 167, 190, 219, 261, 322, 419, 597, 998, 2444, 25761]),
    250: Object.freeze([117, 126, 135, 146, 160, 175, 195, 220, 252, 295, 356, 446, 598, 884, 1591, 4557, 81351])
});

const FRICTION_KEYS = Object.freeze(
    Object.keys(FRICTION_TABLE)
        .map(Number)
        .sort((a, b) => a - b)
);

const DELAY_TABLE = Object.freeze([
    1.5, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3,
    0.25, 0.2, 0.15, 0.1, 0.05
]);

function normalizeFriction(friction) {
    const n = Number(friction);
    if (!Number.isFinite(n) || n <= 0 || n >= 255) {
        return DEFAULT_TILE_FRICTION;
    }
    if (n < 70) return 70;
    if (n > 250) return 250;
    return n;
}

function getFrictionBreakpoints(friction) {
    const f = normalizeFriction(friction);
    if (FRICTION_TABLE[f]) {
        return FRICTION_TABLE[f].slice();
    }

    let lower = FRICTION_KEYS[0];
    let upper = FRICTION_KEYS[FRICTION_KEYS.length - 1];
    for (let i = 0; i < FRICTION_KEYS.length; i++) {
        const key = FRICTION_KEYS[i];
        if (key <= f) lower = key;
        if (key >= f) {
            upper = key;
            break;
        }
    }
    if (lower === upper) {
        return FRICTION_TABLE[lower].slice();
    }

    const lowerValues = FRICTION_TABLE[lower];
    const upperValues = FRICTION_TABLE[upper];
    const fraction = (f - lower) / (upper - lower);
    const result = new Array(17);
    for (let i = 0; i < 17; i++) {
        result[i] = Math.round(
            lowerValues[i] + fraction * (upperValues[i] - lowerValues[i])
        );
    }
    return result;
}

function movementDelay(breakpoint) {
    const i = Math.max(0, Math.min(DELAY_TABLE.length - 1, Math.floor(Number(breakpoint) || 0)));
    return DELAY_TABLE[i];
}

function getBreakpointForFrictionAndSpeed(friction, speed) {
    const s = Number(speed);
    const safeSpeed = Number.isFinite(s) && s >= 0 ? s : 0;
    const breakpointValues = getFrictionBreakpoints(friction);

    let maxBreakpointIndex = -1;
    for (let i = 0; i < breakpointValues.length; i++) {
        if (safeSpeed > breakpointValues[i]) {
            maxBreakpointIndex = i;
        } else {
            break;
        }
    }
    return maxBreakpointIndex + 1;
}

function getMovementDelay(friction, speed) {
    return movementDelay(getBreakpointForFrictionAndSpeed(friction, speed));
}

function computeMoveDelay(friction, speed, isDiagonal, opts) {
    const diag = opts && opts.diagonalFactor != null ? Number(opts.diagonalFactor) : 2;
    const min = opts && opts.minDelay != null ? Number(opts.minDelay) : 0.05;
    let delay = getMovementDelay(friction, speed);
    if (isDiagonal) delay *= Number.isFinite(diag) && diag > 0 ? diag : 2;
    const floor = Number.isFinite(min) && min > 0 ? min : 0.05;
    return Math.max(floor, delay);
}

function delayToTicks(seconds, ups) {
    const rate = Number(ups);
    const safeUps = Number.isFinite(rate) && rate >= 1 ? rate : 20;
    const sec = Number(seconds);
    if (!Number.isFinite(sec) || sec <= 0) return 1;
    return Math.max(1, Math.round(sec * safeUps));
}

function isDiagonalStep(fromX, fromY, toX, toY) {
    return (
        Math.abs((toX | 0) - (fromX | 0)) > 0 &&
        Math.abs((toY | 0) - (fromY | 0)) > 0
    );
}

function isAdjacentStep(from, to) {
    if (!from || !to) return false;
    if ((from.z | 0) !== (to.z | 0)) return false;
    const dx = Math.abs((to.x | 0) - (from.x | 0));
    const dy = Math.abs((to.y | 0) - (from.y | 0));
    if (dx === 0 && dy === 0) return false;
    return dx <= 1 && dy <= 1;
}

module.exports = {
    DEFAULT_TILE_FRICTION,
    FRICTION_TABLE,
    FRICTION_KEYS,
    DELAY_TABLE,
    normalizeFriction,
    getFrictionBreakpoints,
    movementDelay,
    getBreakpointForFrictionAndSpeed,
    getMovementDelay,
    computeMoveDelay,
    delayToTicks,
    isDiagonalStep,
    isAdjacentStep
};

'use strict';

const SQRT2 = Math.SQRT2;

const DEFAULT_MAX_DISTANCE = 100;
const DEFAULT_MAX_ITERATIONS = 512;
const FRICTION_BLOCKED = 255;

class MinHeap {
    constructor(compare) {
        this._data = [];
        this._cmp = compare;
    }

    get size() {
        return this._data.length;
    }

    push(item) {
        const d = this._data;
        d.push(item);
        this._up(d.length - 1);
    }

    pop() {
        const d = this._data;
        if (d.length === 0) return undefined;
        const top = d[0];
        const last = d.pop();
        if (d.length > 0 && last !== undefined) {
            d[0] = last;
            this._down(0);
        }
        return top;
    }

    _up(i) {
        const d = this._data;
        const cmp = this._cmp;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (cmp(d[i], d[p]) >= 0) break;
            const tmp = d[p];
            d[p] = d[i];
            d[i] = tmp;
            i = p;
        }
    }

    _down(i) {
        const d = this._data;
        const cmp = this._cmp;
        const n = d.length;
        for (;;) {
            let best = i;
            const l = i * 2 + 1;
            const r = l + 1;
            if (l < n && cmp(d[l], d[best]) < 0) best = l;
            if (r < n && cmp(d[r], d[best]) < 0) best = r;
            if (best === i) break;
            const tmp = d[best];
            d[best] = d[i];
            d[i] = tmp;
            i = best;
        }
    }
}

function heuristic(dx, dy, allowDiagonal) {
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (allowDiagonal) {
        return adx + ady + (SQRT2 - 2) * Math.min(adx, ady);
    }
    return adx + ady;
}

function reconstructPath(node) {
    const path = [];
    let cur = node;
    while (cur) {
        path.push({ x: cur.x, y: cur.y });
        cur = cur.parent;
    }
    path.reverse();
    return path;
}

/**
 * Binary-friction A*. Walkable gray never changes step cost (cardinal 1,
 * diagonal √2). End tile stays open so melee can path to a combatant.
 */
function findPath(tileMap, start, end, options) {
    if (!tileMap || !start || !end) return null;

    const allowDiagonal =
        options && options.allowDiagonal !== undefined
            ? !!options.allowDiagonal
            : true;
    const checkOccupied =
        options && options.checkOccupied !== undefined
            ? !!options.checkOccupied
            : false;
    const useStackPolicy =
        !!(options && options.useStackPolicy) ||
        !!(options && options.mover != null);
    const mover = options && options.mover != null ? options.mover : null;
    const occupantStepPenalty =
        options && options.occupantStepPenalty !== undefined
            ? Number(options.occupantStepPenalty)
            : 0;
    const maxDistance =
        options && options.maxDistance !== undefined
            ? options.maxDistance
            : DEFAULT_MAX_DISTANCE;
    const maxIterations =
        options && options.maxIterations !== undefined
            ? options.maxIterations
            : DEFAULT_MAX_ITERATIONS;

    const sx = Math.round(start.x);
    const sy = Math.round(start.y);
    const ex = Math.round(end.x);
    const ey = Math.round(end.y);
    const z = start.z !== undefined && start.z !== null ? start.z : end.z;
    if (
        start &&
        end &&
        start.z !== undefined &&
        start.z !== null &&
        end.z !== undefined &&
        end.z !== null &&
        String(start.z) !== String(end.z)
    ) {
        return null;
    }

    const layer = tileMap.getLayer(z);
    if (!layer) return null;

    const cols = layer.cols;
    const rows = layer.rows;
    const friction = layer.friction;
    const occupancy = layer.occupancy;
    const fields = layer.fields || null;

    const avoidFieldMask =
        options && options.avoidFieldMask !== undefined
            ? Number(options.avoidFieldMask) | 0
            : 0;
    const ignorePlayerFields =
        options && options.ignorePlayerFields !== undefined
            ? !!options.ignorePlayerFields
            : false;
    const fieldPenalty =
        options && options.fieldPenalty !== undefined
            ? Number(options.fieldPenalty)
            : 0;

    if (sx < 0 || sy < 0 || sx >= cols || sy >= rows) return null;
    if (ex < 0 || ey < 0 || ex >= cols || ey >= rows) return null;

    if (sx === ex && sy === ey) {
        return [{ x: sx, y: sy }];
    }

    function isHazardField(idx) {
        if (!fields || avoidFieldMask <= 0 || (fields[idx] & avoidFieldMask) === 0) {
            return false;
        }
        if (ignorePlayerFields && (fields[idx] & 8) !== 0) {
            return false;
        }
        return true;
    }

    function occupancyKind(x, y) {
        if (
            useStackPolicy &&
            tileMap &&
            typeof tileMap.pathStepOccupancy === 'function'
        ) {
            return tileMap.pathStepOccupancy(x, y, z, mover);
        }
        const idx = y * cols + x;
        if (!checkOccupied || occupancy[idx] === 0) return 'free';
        return 'hard';
    }

    function isBlocked(x, y) {
        const isEnd = x === ex && y === ey;
        const idx = y * cols + x;
        if (fields && (fields[idx] & 16) !== 0) return true;
        if (
            mover &&
            tileMap &&
            typeof tileMap.creatureMayEnterTile === 'function' &&
            !tileMap.creatureMayEnterTile(x, y, z, mover)
        ) {
            return true;
        }
        if (!isEnd) {
            if (friction[idx] === FRICTION_BLOCKED) return true;
            if (occupancyKind(x, y) === 'hard') return true;
        }
        if (fieldPenalty <= 0 && isHazardField(idx)) return true;
        return false;
    }

    const open = new MinHeap((a, b) => {
        if (a.f !== b.f) return a.f - b.f;
        return a.h - b.h;
    });

    const gValues = new Map();
    const startH = heuristic(sx - ex, sy - ey, allowDiagonal);
    const startNode = {
        x: sx,
        y: sy,
        g: 0,
        h: startH,
        f: startH,
        parent: null
    };
    gValues.set(sy * cols + sx, 0);
    open.push(startNode);

    const moves = allowDiagonal
        ? [
            [0, -1],
            [-1, 0],
            [0, 1],
            [1, 0],
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1]
        ]
        : [
            [0, -1],
            [-1, 0],
            [0, 1],
            [1, 0]
        ];

    let expanded = 0;

    while (open.size > 0) {
        const current = open.pop();
        if (!current) break;

        const cIdx = current.y * cols + current.x;
        const bestG = gValues.get(cIdx);
        if (bestG !== undefined && current.g > bestG) {
            continue;
        }

        if (current.x === ex && current.y === ey) {
            return reconstructPath(current);
        }

        expanded += 1;
        if (expanded > maxIterations) {
            return null;
        }

        for (let m = 0; m < moves.length; m++) {
            const mx = moves[m][0];
            const my = moves[m][1];
            const nx = current.x + mx;
            const ny = current.y + my;

            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            if (isBlocked(nx, ny)) continue;

            if (allowDiagonal && mx !== 0 && my !== 0) {
                const c1x = current.x + mx;
                const c1y = current.y;
                const c2x = current.x;
                const c2y = current.y + my;
                const c1ok = c1x >= 0 && c1x < cols && c1y >= 0 && c1y < rows;
                const c2ok = c2x >= 0 && c2x < cols && c2y >= 0 && c2y < rows;
                if (c1ok && c2ok && isBlocked(c1x, c1y) && isBlocked(c2x, c2y)) {
                    continue;
                }
            }

            if (
                (nx !== ex || ny !== ey) &&
                (Math.abs(nx - sx) > maxDistance || Math.abs(ny - sy) > maxDistance)
            ) {
                continue;
            }

            let moveCost = mx !== 0 && my !== 0 ? SQRT2 : 1;
            const nIdx = ny * cols + nx;
            if (
                occupantStepPenalty > 0 &&
                (nx !== ex || ny !== ey) &&
                occupancyKind(nx, ny) === 'soft'
            ) {
                moveCost += occupantStepPenalty;
            }
            if (fieldPenalty > 0 && isHazardField(nIdx)) {
                moveCost += fieldPenalty;
            }
            const tentativeG = current.g + moveCost;
            const prevG = gValues.get(nIdx);
            if (prevG !== undefined && tentativeG >= prevG) continue;

            gValues.set(nIdx, tentativeG);
            const h = heuristic(nx - ex, ny - ey, allowDiagonal);
            open.push({
                x: nx,
                y: ny,
                g: tentativeG,
                h,
                f: tentativeG + h,
                parent: current
            });
        }
    }

    return null;
}

class Pathfinder {
    constructor(defaults) {
        this.defaults = defaults || {};
    }

    findPath(tileMap, start, end, options) {
        return findPath(tileMap, start, end, Object.assign({}, this.defaults, options));
    }
}

module.exports = {
    Pathfinder,
    MinHeap,
    findPath,
    heuristic,
    DEFAULT_MAX_DISTANCE,
    DEFAULT_MAX_ITERATIONS,
    FRICTION_BLOCKED
};

'use strict';

const TILE = Object.freeze({
    VOID: 0,
    GRASS: 1,
    PATH: 2,
    WALL: 3,
    WATER: 4,
    SPAWN: 5
});

const MAP_W = 24;
const MAP_H = 24;
const VIEW_W = 15;
const VIEW_H = 11;
const SPAWN_X = 12;
const SPAWN_Y = 12;
const FRICTION_BLOCKED = 255;

function createStaticMap() {
    const tiles = new Uint16Array(MAP_W * MAP_H);
    for (let y = 0; y < MAP_H; y++) {
        for (let x = 0; x < MAP_W; x++) {
            let t = TILE.GRASS;
            if (x === 0 || y === 0 || x === MAP_W - 1 || y === MAP_H - 1) {
                t = TILE.WALL;
            } else if (x >= 3 && x <= 6 && y >= 3 && y <= 6) {
                t = TILE.WATER;
            } else if (x === SPAWN_X || y === SPAWN_Y) {
                t = TILE.PATH;
            }
            if (x === SPAWN_X && y === SPAWN_Y) {
                t = TILE.SPAWN;
            }
            tiles[y * MAP_W + x] = t;
        }
    }
    return {
        width: MAP_W,
        height: MAP_H,
        z: 0,
        spawnX: SPAWN_X,
        spawnY: SPAWN_Y,
        spawnZ: 0,
        tiles
    };
}

function townZ(map) {
    return map.spawnZ != null ? map.spawnZ : map.z;
}

function tileAt(map, x, y) {
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) {
        return TILE.VOID;
    }
    return map.tiles[y * map.width + x];
}

function floorChannels(map, z) {
    const zz = z == null ? townZ(map) : (z | 0);
    const fl = map.floors && (map.floors[String(zz)] || map.floors[zz]);
    if (fl && fl.friction) return fl;
    if ((zz | 0) === (townZ(map) | 0) && map.friction) {
        return { friction: map.friction, sight: map.sight, flags: map.flags };
    }
    return null;
}

function isBlocked(tileId, tileset) {
    if (tileset && tileset[tileId]) return !tileset[tileId].walk;
    return tileId === TILE.WALL || tileId === TILE.WATER || tileId === TILE.VOID;
}

function isWalkableCell(map, x, y, z) {
    const ix = x | 0;
    const iy = y | 0;
    if (ix < 0 || iy < 0 || ix >= map.width || iy >= map.height) return false;
    const ch = floorChannels(map, z);
    if (ch) {
        return (ch.friction[iy * map.width + ix] | 0) !== FRICTION_BLOCKED;
    }
    if ((z | 0) !== (townZ(map) | 0) && (z | 0) !== (map.z | 0)) return false;
    return !isBlocked(tileAt(map, ix, iy), map.tileset);
}

/** Friction-derived debug id (not visual stamps). */
function debugTileAt(map, x, y, z) {
    const ix = x | 0;
    const iy = y | 0;
    if (ix < 0 || iy < 0 || ix >= map.width || iy >= map.height) return TILE.VOID;
    const ch = floorChannels(map, z);
    if (ch) {
        const i = iy * map.width + ix;
        const f = ch.friction[i] | 0;
        const s = ch.sight ? (ch.sight[i] | 0) : (f === FRICTION_BLOCKED ? FRICTION_BLOCKED : 0);
        if (f === FRICTION_BLOCKED && s === 0) return TILE.WATER;
        if (f === FRICTION_BLOCKED) return TILE.WALL;
        if (ix === map.spawnX && iy === map.spawnY && (z | 0) === (townZ(map) | 0)) {
            return TILE.SPAWN;
        }
        return TILE.GRASS;
    }
    return tileAt(map, ix, iy);
}

function clampSpawn(map, x, y, z) {
    const home = townZ(map);
    const zz = z == null ? home : (z | 0);
    const ix = x | 0;
    const iy = y | 0;
    if (isWalkableCell(map, ix, iy, zz)) {
        return { x: ix, y: iy, z: zz };
    }
    return { x: map.spawnX, y: map.spawnY, z: home };
}

function viewportWindow(map, cx, cy, vw, vh, z) {
    const width = vw == null ? VIEW_W : vw;
    const height = vh == null ? VIEW_H : vh;
    const hx = (width - 1) >> 1;
    const hy = (height - 1) >> 1;
    let originX = (cx | 0) - hx;
    let originY = (cy | 0) - hy;
    if (originX < 0) originX = 0;
    if (originY < 0) originY = 0;
    if (originX + width > map.width) originX = Math.max(0, map.width - width);
    if (originY + height > map.height) originY = Math.max(0, map.height - height);
    const w = Math.min(width, map.width - originX);
    const h = Math.min(height, map.height - originY);
    const floorZ = z == null ? townZ(map) : (z | 0);
    return { originX, originY, z: floorZ, width: w, height: h };
}

function viewport(map, cx, cy, vw, vh, z) {
    const win = viewportWindow(map, cx, cy, vw, vh, z);
    const tiles = new Uint16Array(win.width * win.height);
    for (let y = 0; y < win.height; y++) {
        for (let x = 0; x < win.width; x++) {
            tiles[y * win.width + x] = debugTileAt(
                map, win.originX + x, win.originY + y, win.z
            );
        }
    }
    return {
        originX: win.originX,
        originY: win.originY,
        z: win.z,
        width: win.width,
        height: win.height,
        tiles
    };
}

/** Chebyshev disk around the observer (not clamped). Prefer inViewport for AOI. */
function inView(ax, ay, bx, by, vw, vh) {
    const width = vw == null ? VIEW_W : vw;
    const height = vh == null ? VIEW_H : vh;
    const hx = (width - 1) >> 1;
    const hy = (height - 1) >> 1;
    return Math.abs((ax | 0) - (bx | 0)) <= hx && Math.abs((ay | 0) - (by | 0)) <= hy;
}

/** True when (x,y) is inside the observer's sent viewport rectangle (clamped). */
function inViewport(map, observerX, observerY, x, y, z, vw, vh, observerZ) {
    const floorZ = observerZ == null ? townZ(map) : (observerZ | 0);
    if (z != null && (z | 0) !== floorZ) return false;
    const win = viewportWindow(map, observerX, observerY, vw, vh, floorZ);
    const ix = x | 0;
    const iy = y | 0;
    return ix >= win.originX && iy >= win.originY
        && ix < win.originX + win.width && iy < win.originY + win.height;
}

module.exports = {
    TILE,
    MAP_W,
    MAP_H,
    VIEW_W,
    VIEW_H,
    SPAWN_X,
    SPAWN_Y,
    FRICTION_BLOCKED,
    createStaticMap,
    townZ,
    tileAt,
    floorChannels,
    isBlocked,
    isWalkableCell,
    debugTileAt,
    clampSpawn,
    viewportWindow,
    viewport,
    inView,
    inViewport
};

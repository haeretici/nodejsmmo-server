'use strict';

const { isBlocked } = require('./static_map');
const { findPath, DEFAULT_MAX_DISTANCE, DEFAULT_MAX_ITERATIONS } = require('./pathfinder');
const { isAdjacentStep } = require('./movement');
const { isLogicIntervalDue, forceDue } = require('./path_budget');

/** Non-walkable sentinel in friction (same as HuntDL TileMap). */
const FRICTION_BLOCKED = 255;

/** Walkable floor delay placeholder (mid-gray / table key 100). */
const DEFAULT_WALK_FRICTION = 100;

const TILE_FLAG_NO_CAST = 1;
const TILE_FLAG_STAIR = 2;
const TILE_FLAG_LADDER = 4;
const TILE_FLAG_HOLE = 8;
const TILE_FLAG_ROPE_SPOT = 16;
const TILE_FLAG_SHOVEL_SPOT = 32;
const TILE_FLAG_NO_CREATURE = 64;
const TILE_FLAG_PZ_PACKAGE = TILE_FLAG_NO_CAST | TILE_FLAG_NO_CREATURE;
const TILE_FLAG_HOP_PAD = TILE_FLAG_STAIR | TILE_FLAG_LADDER | TILE_FLAG_HOLE;

const HOP_DIRS = Object.freeze({
    center: 1,
    north: 1,
    south: 1,
    east: 1,
    west: 1
});

/**
 * Whether a registered pad of this type hops when a player lands on it.
 * `stairs` / `hole` / missing type hop on step. `ladder` / `rope` / `shovel` stay until Use.
 */
function hopsOnStep(type) {
    if (type == null || type === '') return true;
    const t = String(type).trim().toLowerCase();
    return t === 'stairs' || t === 'hole';
}

function hopDirOffset(dir) {
    const d = dir != null ? String(dir).trim().toLowerCase() : 'center';
    switch (d) {
        case 'north':
            return { dx: 0, dy: -1 };
        case 'south':
            return { dx: 0, dy: 1 };
        case 'west':
            return { dx: -1, dy: 0 };
        case 'east':
            return { dx: 1, dy: 0 };
        default:
            return { dx: 0, dy: 0 };
    }
}

function reverseHopDir(dir) {
    if (dir == null) return null;
    const d = String(dir).trim().toLowerCase();
    switch (d) {
        case 'north':
            return 'south';
        case 'south':
            return 'north';
        case 'east':
            return 'west';
        case 'west':
            return 'east';
        case 'center':
            return 'center';
        default:
            return d || null;
    }
}

function stairKey(x, y, z) {
    return `${x | 0},${y | 0},${z | 0}`;
}

function playerHopsOnStep(ent) {
    if (!isPlayerEntity(ent)) return false;
    const mode = ent.controlMode;
    if (mode == null || mode === '') return true;
    return mode === 'manual';
}

function isStairReason(reason) {
    return reason === 'stair' || reason === 'floor-change' || reason === 'floor_change';
}

/**
 * Pad dest from a hybrid / editor row. Omitted `to` uses dir offset on z+deltaZ.
 * `custom` without `to` is not a hop.
 */
function resolveStairDest(row) {
    if (!row || typeof row !== 'object') return null;
    const fromRaw = row.from && typeof row.from === 'object' ? row.from : row;
    if (fromRaw.x == null || fromRaw.y == null) return null;
    const fromZ = fromRaw.z != null ? fromRaw.z : row.z;
    const from = {
        x: fromRaw.x | 0,
        y: fromRaw.y | 0,
        z: fromZ | 0
    };
    const dirRaw = row.dir != null ? String(row.dir).trim().toLowerCase() : 'center';
    const isCustom = dirRaw === 'custom';
    const dir = isCustom || HOP_DIRS[dirRaw] ? dirRaw : 'center';
    const deltaZ = row.deltaZ != null && Number.isFinite(Number(row.deltaZ))
        ? Math.trunc(Number(row.deltaZ))
        : 0;
    const toRaw = row.to && typeof row.to === 'object' ? row.to : null;
    let to;
    if (toRaw && toRaw.x != null && toRaw.y != null) {
        to = {
            x: toRaw.x | 0,
            y: toRaw.y | 0,
            z: toRaw.z != null ? (toRaw.z | 0) : (from.z + deltaZ)
        };
    } else if (isCustom) {
        return null;
    } else {
        const off = hopDirOffset(dir);
        to = {
            x: from.x + off.dx,
            y: from.y + off.dy,
            z: from.z + deltaZ
        };
    }
    if (from.x === to.x && from.y === to.y && from.z === to.z) return null;
    return {
        from,
        to,
        dir,
        type: row.type != null ? String(row.type).trim().toLowerCase() : 'stairs',
        deltaZ,
        bidirectional: row.bidirectional === true,
        link: row.link != null ? String(row.link) : null
    };
}

function entityIdOf(entity) {
    if (entity == null) return 0;
    if (typeof entity === 'number') {
        const n = entity | 0;
        return n > 0 ? n : 0;
    }
    if (typeof entity === 'object' && entity.id != null) {
        const n = entity.id | 0;
        return n > 0 ? n : 0;
    }
    return 0;
}

function isPlayerEntity(ent) {
    return !!(ent && typeof ent === 'object' && ent.type === 'player');
}

function isNpcEntity(ent) {
    return !!(ent && typeof ent === 'object' && (ent.type === 'npc' || ent.isNpc));
}

function isSummonEntity(ent) {
    if (!ent) return false;
    return ent.masterId != null && (ent.masterId | 0) > 0;
}

function isTalkableNpc(ent) {
    if (!isNpcEntity(ent)) return false;
    return !ent.attackableNpc;
}

function occupantsHavePlayer(occupants) {
    for (let i = 0; i < occupants.length; i++) {
        if (isPlayerEntity(occupants[i])) return true;
    }
    return false;
}

function entityCanPushCreatures(ent) {
    if (!ent || isPlayerEntity(ent) || isSummonEntity(ent) || isNpcEntity(ent)) {
        return false;
    }
    if (ent.canPushCreatures === true) return true;
    if (ent.flags && ent.flags.canPushCreatures === true) return true;
    return false;
}

function isPushableEntity(ent) {
    if (!ent || typeof ent !== 'object') return false;
    if (isPlayerEntity(ent)) return false;
    if (isNpcEntity(ent)) return false;
    if (isSummonEntity(ent)) return false;
    if (ent.alive === false) return false;
    if ((ent.hp | 0) <= 0) return false;
    if (ent.speed != null && Number(ent.speed) === 0) return false;
    if (ent.pushable === false) return false;
    if (ent.flags && ent.flags.pushable === false) return false;
    return true;
}

function noCreatureExempt(entity, tileMap, x, y, z) {
    if (!entity || typeof entity !== 'object') return false;
    if (isPlayerEntity(entity)) return true;
    if (!isTalkableNpc(entity)) return false;
    const flags = tileMap.flagsAt(x, y, z);
    return (flags & TILE_FLAG_HOP_PAD) === 0;
}

function canCrossFieldHazards(entity, now) {
    if (!entity) return false;
    if (entity.provokedUntil && entity.provokedUntil >= now) return true;
    if (entity.canCrossFieldHazards === true) return true;
    if (entity._hazardRouteUntil != null && now < entity._hazardRouteUntil) return true;
    if (entity.controlMode === 'manual') return true;
    return false;
}

/**
 * Occupancy + player stack. Flat friction/occupancy per floor; sparse stacks
 * only when length ≥ 2. Sole writers: enterTile / leaveTile.
 *
 * Players stack with players. Creatures never stack. canPushCreatures movers
 * shove/crush pushable creatures then claim the empty tile.
 */
class TileMap {
    /**
     * @param {{
     *   cols: number,
     *   rows: number,
     *   z?: number,
     *   friction?: Uint8Array,
     *   maxStack?: number,
     *   resolveEntity?: (id: number) => object|null
     * }} opts
     */
    constructor(opts) {
        const cols = opts.cols | 0;
        const rows = opts.rows | 0;
        const z = opts.z == null ? 0 : opts.z;
        const n = cols * rows;
        const friction = opts.friction instanceof Uint8Array
            ? opts.friction
            : new Uint8Array(n);
        this.z = z;
        this.layers = Object.create(null);
        this.layers[String(z)] = {
            cols,
            rows,
            friction,
            sight: opts.sight instanceof Uint8Array ? opts.sight : new Uint8Array(n),
            flags: opts.flags instanceof Uint8Array ? opts.flags : new Uint8Array(n),
            fields: opts.fields instanceof Uint8Array ? opts.fields : new Uint8Array(n),
            occupancy: new Int32Array(n)
        };
        this.playerStacks = new Map();
        this.noPlayerStackTiles = new Set();
        this.stairs = Object.create(null);
        this.maxStack = opts.maxStack == null ? 10 : opts.maxStack | 0;
        this.resolveEntity = opts.resolveEntity || (() => null);
        this.rng = opts.rng || Math.random;
        this.crushOn = opts.crush == null ? true : !!opts.crush;
        this.onCrush = opts.onCrush || null;
        this.onPushed = opts.onPushed || null;
        this.onMove = opts.onMove || null;
        this.playerSpatial = opts.playerSpatial || null;
        this.creatureSpatial = opts.creatureSpatial || null;
        this.budget = opts.budget || null;
        this.computeService = opts.computeService || null;
        this.pathOpts = opts.path && typeof opts.path === 'object' ? opts.path : {};
    }

    tileStackKey(x, y, z) {
        return `${z | 0}:${x | 0}:${y | 0}`;
    }

    index(x, y, cols) {
        return y * cols + x;
    }

    getLayer(z) {
        return this.layers[String(z)] || null;
    }

    addLayer(z, opts) {
        const key = String(z | 0);
        if (this.layers[key]) return this.layers[key];
        const sample = this.layers[String(this.z)] || Object.values(this.layers)[0];
        const cols = (opts && opts.cols) || sample.cols;
        const rows = (opts && opts.rows) || sample.rows;
        const n = cols * rows;
        const layer = {
            cols,
            rows,
            friction: opts && opts.friction instanceof Uint8Array
                ? opts.friction
                : new Uint8Array(n).fill(FRICTION_BLOCKED),
            sight: opts && opts.sight instanceof Uint8Array ? opts.sight : new Uint8Array(n),
            flags: opts && opts.flags instanceof Uint8Array ? opts.flags : new Uint8Array(n),
            fields: opts && opts.fields instanceof Uint8Array ? opts.fields : new Uint8Array(n),
            occupancy: new Int32Array(n)
        };
        this.layers[key] = layer;
        return layer;
    }

    sightAt(x, y, z) {
        const layer = this.getLayer(z);
        if (!layer || !layer.sight) return FRICTION_BLOCKED;
        const ix = x | 0;
        const iy = y | 0;
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) {
            return FRICTION_BLOCKED;
        }
        return layer.sight[this.index(ix, iy, layer.cols)];
    }

    flagsAt(x, y, z) {
        const layer = this.getLayer(z);
        if (!layer || !layer.flags) return 0;
        const ix = x | 0;
        const iy = y | 0;
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) {
            return 0;
        }
        return layer.flags[this.index(ix, iy, layer.cols)] & 0xff;
    }

    setTileFlags(x, y, z, flags) {
        const layer = this.getLayer(z);
        if (!layer) return false;
        const ix = x | 0;
        const iy = y | 0;
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) return false;
        if (!layer.flags || layer.flags.length < layer.friction.length) {
            layer.flags = new Uint8Array(layer.friction.length);
        }
        layer.flags[this.index(ix, iy, layer.cols)] = flags & 0xff;
        return true;
    }

    blocksCreatures(x, y, z) {
        return (this.flagsAt(x, y, z) & TILE_FLAG_NO_CREATURE) !== 0;
    }

    blocksCast(x, y, z) {
        return (this.flagsAt(x, y, z) & TILE_FLAG_NO_CAST) !== 0;
    }

    getFriction(x, y, z) {
        return this.frictionAt(x, y, z);
    }

    blocksSight(x, y, z) {
        return this.sightAt(x, y, z) === FRICTION_BLOCKED;
    }

    fieldMaskAt(x, y, z) {
        const layer = this.getLayer(z);
        if (!layer || !layer.fields) return 0;
        const ix = x | 0;
        const iy = y | 0;
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) return 0;
        return layer.fields[this.index(ix, iy, layer.cols)] & 0xff;
    }

    getTileFieldMask(x, y, z) {
        return this.fieldMaskAt(x, y, z);
    }

    setTileFieldMask(x, y, z, mask) {
        const layer = this.getLayer(z);
        if (!layer) return false;
        const ix = x | 0;
        const iy = y | 0;
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) return false;
        if (!layer.fields || layer.fields.length < layer.friction.length) {
            layer.fields = new Uint8Array(layer.friction.length);
        }
        layer.fields[this.index(ix, iy, layer.cols)] = mask & 0xff;
        return true;
    }

    getCombatantEntities(x, y, z) {
        const ids = this.getCombatants(x, y, z);
        const out = [];
        for (let i = 0; i < ids.length; i++) {
            const ent = this.resolveOccupant(ids[i]);
            if (ent) out.push(ent);
        }
        return out;
    }

    creatureMayEnterTile(x, y, z, entity) {
        if (!this.blocksCreatures(x, y, z)) return true;
        if (noCreatureExempt(entity, this, x, y, z)) return true;
        const id = entityIdOf(entity);
        const mover = entity && typeof entity === 'object'
            ? entity
            : this.resolveOccupant(id);
        if (mover && mover !== entity && noCreatureExempt(mover, this, x, y, z)) {
            return true;
        }
        return false;
    }

    inBounds(x, y, z) {
        const layer = this.getLayer(z);
        if (!layer) return false;
        const ix = x | 0;
        const iy = y | 0;
        return ix >= 0 && iy >= 0 && ix < layer.cols && iy < layer.rows;
    }

    frictionAt(x, y, z) {
        const layer = this.getLayer(z);
        if (!layer) return FRICTION_BLOCKED;
        const ix = x | 0;
        const iy = y | 0;
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) {
            return FRICTION_BLOCKED;
        }
        return layer.friction[this.index(ix, iy, layer.cols)];
    }

    /**
     * Patch one baked cell. Missing channels in `patch` stay unchanged.
     * Occupancy is creature-only — walk-block is friction 255.
     */
    applyCellPatch(patch) {
        if (!patch) return { ok: false, reason: 'bad_args' };
        const x = Math.round(Number(patch.x));
        const y = Math.round(Number(patch.y));
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return { ok: false, reason: 'bad_args' };
        }
        const z = patch.z !== undefined && patch.z !== null ? patch.z : 0;
        const layer = this.getLayer(z);
        if (!layer || !layer.friction) return { ok: false, reason: 'no_layer' };
        if (x < 0 || y < 0 || x >= layer.cols || y >= layer.rows) {
            return { ok: false, reason: 'oob' };
        }
        const idx = this.index(x, y, layer.cols);
        const prev = {
            friction: layer.friction[idx] & 0xff,
            sight: layer.sight ? layer.sight[idx] & 0xff : 0,
            flags: layer.flags ? layer.flags[idx] & 0xff : 0,
            fields: layer.fields ? layer.fields[idx] & 0xff : 0
        };
        let changed = false;
        const setByte = (name, value) => {
            if (value == null) return;
            const n = Math.floor(Number(value));
            if (!Number.isFinite(n)) return;
            const v = n < 0 ? 0 : n > 255 ? 255 : n;
            let buf = layer[name];
            if (!buf || buf.length < layer.friction.length) {
                buf = new Uint8Array(layer.friction.length);
                layer[name] = buf;
            }
            if (buf[idx] !== v) {
                buf[idx] = v;
                changed = true;
            }
        };
        if (patch.friction != null) setByte('friction', patch.friction);
        if (patch.sight != null) setByte('sight', patch.sight);
        if (patch.flags != null) setByte('flags', patch.flags);
        if (patch.fields != null) setByte('fields', patch.fields);
        return { ok: true, changed, prev };
    }

    isWalkable(x, y, z) {
        return this.frictionAt(x, y, z) !== FRICTION_BLOCKED;
    }

    getOccupant(x, y, z) {
        const layer = this.getLayer(z);
        if (!layer) return 0;
        const ix = x | 0;
        const iy = y | 0;
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) {
            return 0;
        }
        return layer.occupancy[this.index(ix, iy, layer.cols)] | 0;
    }

    getFirstOccupant(x, y, z) {
        return this.getOccupant(x, y, z);
    }

    getCombatants(x, y, z) {
        const first = this.getOccupant(x, y, z);
        if (first === 0) return [];
        const stack = this.playerStacks.get(this.tileStackKey(x, y, z));
        if (stack && stack.length >= 2) return stack.slice();
        return [first];
    }

    /**
     * A* intermediate occupancy (4C).
     * @returns {'free'|'soft'|'hard'}
     */
    pathStepOccupancy(x, y, z, mover) {
        const first = this.getOccupant(x, y, z);
        if (first === 0) return 'free';
        const id = entityIdOf(mover);
        if (id !== 0 && first === id) return 'free';
        const combatants = this.getCombatants(x, y, z);
        if (id !== 0 && combatants.indexOf(id) >= 0) return 'free';

        const moverEnt = mover && typeof mover === 'object'
            ? mover
            : this.resolveOccupant(id);
        if (!moverEnt) return 'hard';

        const occupants = this._resolveCombatants(combatants);
        if (!occupants.length || occupants.length < combatants.length) {
            return 'hard';
        }

        if (isPlayerEntity(moverEnt)) {
            for (let i = 0; i < occupants.length; i++) {
                if (!isPlayerEntity(occupants[i])) return 'hard';
            }
            return 'free';
        }

        if (occupantsHavePlayer(occupants)) return 'hard';
        if (!entityCanPushCreatures(moverEnt)) return 'hard';
        for (let i = 0; i < occupants.length; i++) {
            if (!isPushableEntity(occupants[i])) return 'hard';
        }
        return 'soft';
    }

    resolveOccupant(id) {
        if (!id) return null;
        return this.resolveEntity(id) || null;
    }

    setNoPlayerStack(x, y, z, value) {
        const key = this.tileStackKey(x, y, z);
        if (value === false) this.noPlayerStackTiles.delete(key);
        else this.noPlayerStackTiles.add(key);
    }

    isNoPlayerStack(x, y, z) {
        return this.noPlayerStackTiles.has(this.tileStackKey(x, y, z));
    }

    addStair(from, to, meta) {
        const a = from && typeof from === 'object'
            ? { x: from.x | 0, y: from.y | 0, z: from.z | 0 }
            : null;
        const b = to && typeof to === 'object'
            ? { x: to.x | 0, y: to.y | 0, z: to.z | 0 }
            : null;
        if (!a || !b) return this;
        if (a.x === b.x && a.y === b.y && a.z === b.z) return this;
        const m = meta && typeof meta === 'object' ? meta : null;
        this.stairs[stairKey(a.x, a.y, a.z)] = {
            x: b.x,
            y: b.y,
            z: b.z,
            dir: m && m.dir != null ? String(m.dir) : null,
            link: m && m.link != null ? String(m.link) : null,
            type: m && m.type != null ? String(m.type).toLowerCase() : null,
            bidirectional: m && m.bidirectional != null ? !!m.bidirectional : null,
            deltaZ: m && m.deltaZ != null && Number.isFinite(Number(m.deltaZ))
                ? Math.trunc(Number(m.deltaZ))
                : null
        };
        return this;
    }

    getStair(x, y, z) {
        return this.stairs[stairKey(x, y, z)] || null;
    }

    isStair(x, y, z) {
        return this.getStair(x, y, z) != null;
    }

    hopsOnStepAt(x, y, z) {
        const row = this.getStair(x, y, z);
        if (!row) return false;
        return hopsOnStep(row.type);
    }

    installStairs(rows) {
        const list = Array.isArray(rows) ? rows : [];
        for (let i = 0; i < list.length; i++) {
            const resolved = resolveStairDest(list[i]);
            if (!resolved) continue;
            const meta = {
                dir: resolved.dir,
                type: resolved.type,
                deltaZ: resolved.deltaZ,
                bidirectional: resolved.bidirectional,
                link: resolved.link
            };
            this.addStair(resolved.from, resolved.to, meta);
            if (resolved.bidirectional) {
                this.addStair(resolved.to, resolved.from, {
                    dir: reverseHopDir(resolved.dir) || resolved.dir,
                    type: resolved.type,
                    deltaZ: resolved.deltaZ != null ? -resolved.deltaZ : null,
                    bidirectional: true,
                    link: resolved.link
                });
            }
        }
        return this;
    }

    tryUseStair(entity, preferredDest) {
        if (!entity || typeof entity !== 'object') return false;
        const dest = this.getStair(entity.x, entity.y, entity.z);
        if (!dest) return false;
        if (preferredDest != null && preferredDest.z !== undefined) {
            if ((preferredDest.z | 0) !== (dest.z | 0)) return false;
        }
        return this.moveEntityToTile(dest.x, dest.y, dest.z, entity, { reason: 'stair' });
    }

    tryAutoStairHop(entity) {
        if (!entity || typeof entity !== 'object') return false;
        if (!playerHopsOnStep(entity)) return false;
        if (!this.hopsOnStepAt(entity.x, entity.y, entity.z)) return false;
        return this.tryUseStair(entity, null);
    }

    _resolveCombatants(ids) {
        const out = [];
        for (let i = 0; i < ids.length; i++) {
            const ent = this.resolveOccupant(ids[i]);
            if (ent) out.push(ent);
        }
        return out;
    }

    _canPlayerEnter(x, y, z, occupants, isStair) {
        if (!occupants.length) return false;
        let playerCount = 0;
        let creatureCount = 0;
        for (let i = 0; i < occupants.length; i++) {
            if (isPlayerEntity(occupants[i])) playerCount += 1;
            else creatureCount += 1;
        }
        if (playerCount === 0 && creatureCount === 0) return false;
        if (playerCount === 0 && creatureCount >= 1) {
            if (!isStair) return false;
            return creatureCount === 1;
        }
        if (creatureCount > 1) return false;
        if (this.isNoPlayerStack(x, y, z) && playerCount >= 1) return false;
        const max = this.maxStack;
        if (max > 0 && playerCount >= max) return false;
        return true;
    }

    /**
     * @param {{ id?: number, type?: string }|number|null} [entity]
     * @param {{ reason?: string }} [opts] `reason: 'stair'` mixed hop (S4+)
     */
    canEnter(x, y, z, entity, opts) {
        if (!this.isWalkable(x, y, z)) return false;
        if (!this.creatureMayEnterTile(x, y, z, entity)) return false;
        const firstId = this.getOccupant(x, y, z);
        if (firstId === 0) return true;
        const id = entityIdOf(entity);
        if (id !== 0 && firstId === id) return true;
        const combatants = this.getCombatants(x, y, z);
        if (id !== 0 && combatants.indexOf(id) >= 0) return true;

        const mover = entity && typeof entity === 'object'
            ? entity
            : this.resolveOccupant(id);
        if (!mover) return false;

        const occupants = this._resolveCombatants(combatants);
        const reason = opts && opts.reason != null ? String(opts.reason) : '';
        const isStair = isStairReason(reason);

        if (isPlayerEntity(mover)) {
            return this._canPlayerEnter(x, y, z, occupants, isStair);
        }
        if (occupantsHavePlayer(occupants)) return false;
        if (!occupants.length) return false;
        if (!entityCanPushCreatures(mover)) return false;
        for (let i = 0; i < occupants.length; i++) {
            if (!isPushableEntity(occupants[i])) return false;
        }
        return true;
    }

    enterTile(x, y, z, entity, opts) {
        const id = entityIdOf(entity);
        if (id === 0) return false;
        if (!this.canEnter(x, y, z, entity, opts)) return false;
        const layer = this.getLayer(z);
        if (!layer) return false;
        const ix = x | 0;
        const iy = y | 0;
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) return false;
        const idx = this.index(ix, iy, layer.cols);
        const firstId = layer.occupancy[idx] | 0;
        if (firstId === id) return true;
        const key = this.tileStackKey(ix, iy, z);
        const existing = this.playerStacks.get(key);
        if (existing && existing.indexOf(id) >= 0) return true;

        const mover = entity && typeof entity === 'object'
            ? entity
            : this.resolveOccupant(id);

        if (
            firstId !== 0 &&
            mover &&
            !isPlayerEntity(mover) &&
            entityCanPushCreatures(mover)
        ) {
            if (!this._pushCreaturesOnTile(ix, iy, z, mover)) return false;
            if ((layer.occupancy[idx] | 0) !== 0) return false;
        }

        const occNow = layer.occupancy[idx] | 0;
        if (occNow === 0) {
            layer.occupancy[idx] = id;
            return true;
        }
        if (occNow === id) return true;

        let stack = this.playerStacks.get(key);
        if (!stack) {
            stack = [occNow, id];
            this.playerStacks.set(key, stack);
        } else if (stack.indexOf(id) < 0) {
            stack.push(id);
        }
        layer.occupancy[idx] = stack[0];
        return true;
    }

    leaveTile(x, y, z, entity) {
        const id = entityIdOf(entity);
        if (id === 0) return false;
        const layer = this.getLayer(z);
        if (!layer) return false;
        const ix = x | 0;
        const iy = y | 0;
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) return false;
        const idx = this.index(ix, iy, layer.cols);
        const key = this.tileStackKey(ix, iy, z);
        const stack = this.playerStacks.get(key);

        if (stack && stack.length >= 2) {
            const at = stack.indexOf(id);
            if (at < 0) return false;
            stack.splice(at, 1);
            if (stack.length <= 1) {
                this.playerStacks.delete(key);
                layer.occupancy[idx] = stack.length === 1 ? stack[0] : 0;
            } else {
                layer.occupancy[idx] = stack[0];
            }
            return true;
        }

        if ((layer.occupancy[idx] | 0) !== id) return false;
        layer.occupancy[idx] = 0;
        this.playerStacks.delete(key);
        return true;
    }

    tryOccupy(x, y, z, entity, opts) {
        return this.enterTile(x, y, z, entity, opts);
    }

    release(x, y, z, entity) {
        return this.leaveTile(x, y, z, entity);
    }

    moveEntityToTile(x, y, z, entity, opts) {
        const id = entityIdOf(entity);
        if (id === 0) return false;
        const fromX = entity && entity.x != null ? entity.x | 0 : x | 0;
        const fromY = entity && entity.y != null ? entity.y | 0 : y | 0;
        const fromZ = entity && entity.z != null ? entity.z : z;
        if (fromX === (x | 0) && fromY === (y | 0) && (fromZ | 0) === (z | 0)) {
            return true;
        }
        if (!this.canEnter(x, y, z, entity, opts)) return false;
        const left = this.leaveTile(fromX, fromY, fromZ, entity);
        if (!this.enterTile(x, y, z, entity, opts)) {
            if (left) this.enterTile(fromX, fromY, fromZ, entity, opts);
            return false;
        }
        if (entity && typeof entity === 'object') {
            entity.x = x | 0;
            entity.y = y | 0;
            entity.z = z | 0;
        }
        if (this.onMove) {
            this.onMove(entity, fromX, fromY, fromZ, x, y, z);
        }
        if (this.playerSpatial && (entity.type === 'player' || this.playerSpatial.has(id))) {
            this.playerSpatial.update(entity);
        } else if (this.creatureSpatial && (entity.type === 'creature' || entity.type === 'npc' || this.creatureSpatial.has(id))) {
            this.creatureSpatial.update(entity);
        }
        const reason = opts && opts.reason != null ? String(opts.reason) : '';
        if (!isStairReason(reason)) this.tryAutoStairHop(entity);
        return true;
    }

    search(start, end, options) {
        const caps = this.pathOpts || {};
        const opts = Object.assign({
            maxDistance: caps.maxDistance != null ? caps.maxDistance : DEFAULT_MAX_DISTANCE,
            maxIterations: caps.maxIterations != null
                ? caps.maxIterations
                : DEFAULT_MAX_ITERATIONS
        }, options || {});
        return findPath(this, start, end, opts);
    }

    followPath(entity, targetX, targetY, targetZ, maxDistance, retries, extras) {
        if (!entity) return false;
        if (!Array.isArray(entity.path)) entity.path = [];

        const tx = targetX | 0;
        const ty = targetY | 0;
        const tz = targetZ != null ? targetZ | 0 : entity.z | 0;
        if ((entity.z | 0) !== tz) {
            entity.path = [];
            return false;
        }
        const knobs = this.pathOpts || {};
        const cap = maxDistance !== undefined && maxDistance !== null
            ? maxDistance
            : (knobs.maxDistance != null ? knobs.maxDistance : DEFAULT_MAX_DISTANCE);
        const attempt = retries | 0;
        const now = extras && extras.now != null ? Number(extras.now) : 0;
        const budget = extras && extras.budget ? extras.budget : this.budget;

        if (
            entity._repathGoalX !== tx ||
            entity._repathGoalY !== ty ||
            (entity._repathGoalZ | 0) !== tz
        ) {
            entity._repathFailBackoffUntil = null;
            entity._repathGoalX = tx;
            entity._repathGoalY = ty;
            entity._repathGoalZ = tz;
        }

        const last = entity.path.length ? entity.path[entity.path.length - 1] : null;
        const needRepath =
            !last ||
            last.x !== tx ||
            last.y !== ty;

        if (needRepath) {
            const here = { x: entity.x | 0, y: entity.y | 0, z: entity.z | 0 };
            if (isAdjacentStep(here, { x: tx, y: ty, z: tz }) && this.canEnter(tx, ty, tz, entity)) {
                entity.path = [];
                entity._repathFailBackoffUntil = null;
                if (this.moveEntityToTile(tx, ty, tz, entity)) {
                    return (entity.x | 0) === tx && (entity.y | 0) === ty;
                }
            }

            const hasPath = entity.path.length > 0;
            const critical = !hasPath || attempt > 0;
            const failBackoff = knobs.failBackoffSec != null
                ? Number(knobs.failBackoffSec)
                : 0.25;
            if (critical && canCrossFieldHazards(entity, now)) {
                entity._repathFailBackoffUntil = null;
            }
            const inFailBackoff =
                critical &&
                entity._repathFailBackoffUntil != null &&
                Number.isFinite(entity._repathFailBackoffUntil) &&
                now < entity._repathFailBackoffUntil;

            let due = false;
            if (critical) {
                due = !inFailBackoff;
            } else {
                const repathSec = knobs.repathIntervalSec != null
                    ? Number(knobs.repathIntervalSec)
                    : 2;
                due = isLogicIntervalDue(entity, '_repathNextAt', repathSec, now);
            }

            const allowed = due && (!budget || budget.take({ critical }));
            if (allowed) {
                const occupantPenalty = knobs.occupantStepPenalty != null
                    ? Number(knobs.occupantStepPenalty)
                    : 4;
                const computeService = (extras && extras.computeService) || this.computeService;
                if (computeService && computeService.enabled && !critical) {
                    const priority = (extras && extras.priority) || 'visible';
                    const token = computeService.submitPath({
                        entityId: entity.id | 0,
                        priority,
                        z: tz,
                        start: { x: entity.x | 0, y: entity.y | 0 },
                        goal: { x: tx, y: ty },
                        flags: {
                            allowDiagonal: knobs.allowDiagonal !== false,
                            useStackPolicy: true,
                            canPushCreatures: !!(entity.canPushCreatures || (entity.flags && entity.flags.canPushCreatures)),
                            occupantStepPenalty: occupantPenalty,
                            avoidFieldMask: 0,
                            fieldPenalty: 0
                        },
                        caps: {
                            maxDistance: cap,
                            maxIterations: knobs.maxIterations != null ? knobs.maxIterations : DEFAULT_MAX_ITERATIONS
                        },
                        tileMap: this
                    });
                    if (token) {
                        entity._computeToken = typeof token === 'object' ? token.token : token;
                        if (typeof token === 'object' && token.inline && token.path && token.path.length > 0) {
                            entity.path = token.path.slice(1);
                            entity._repathFailBackoffUntil = null;
                        }
                    }
                } else {
                    const path = this.search(
                        { x: entity.x | 0, y: entity.y | 0, z: entity.z | 0 },
                        { x: tx, y: ty, z: tz },
                        {
                            allowDiagonal: knobs.allowDiagonal !== false,
                            maxDistance: cap,
                            mover: entity,
                            useStackPolicy: true,
                            occupantStepPenalty: occupantPenalty,
                            avoidFieldMask: 0,
                            fieldPenalty: 0
                        }
                    );
                    if (path && path.length > 0) {
                        entity.path = path.slice(1);
                        entity._repathFailBackoffUntil = null;
                    } else {
                        entity.path = [];
                        if (critical && Number.isFinite(failBackoff) && failBackoff > 0) {
                            entity._repathFailBackoffUntil = now + failBackoff;
                            if (budget && typeof budget.noteFailBackoff === 'function') {
                                budget.noteFailBackoff();
                            }
                        }
                    }
                }
            }
        }

        if (entity.path.length === 0) {
            if ((entity.x | 0) === tx && (entity.y | 0) === ty) return true;
            if (isAdjacentStep(
                { x: entity.x | 0, y: entity.y | 0, z: entity.z | 0 },
                { x: tx, y: ty, z: tz }
            )) {
                if (this.moveEntityToTile(tx, ty, tz, entity)) {
                    return (entity.x | 0) === tx && (entity.y | 0) === ty;
                }
            }
            return false;
        }

        const step = entity.path[0];
        if (step.x === (entity.x | 0) && step.y === (entity.y | 0)) {
            entity.path.shift();
            return true;
        }

        const moved = this.moveEntityToTile(step.x, step.y, entity.z, entity);
        if (moved) {
            entity.path.shift();
            return true;
        }

        if (attempt === 0) {
            entity.path = [];
            entity._repathFailBackoffUntil = null;
            forceDue(entity, '_repathNextAt');
            return this.followPath(entity, tx, ty, tz, cap, 1, extras);
        }
        return false;
    }

    _pushCreaturesOnTile(x, y, z, mover) {
        const ids = this.getCombatants(x, y, z);
        for (let i = ids.length - 1; i >= 0; i--) {
            const tid = ids[i];
            if (tid === entityIdOf(mover)) continue;
            const target = this.resolveOccupant(tid);
            if (!target) return false;
            if (isPlayerEntity(target) || !isPushableEntity(target)) return false;
            if (!this._tryShoveOrthogonal(target)) {
                if (!this.crushOn) return false;
                this._crushCreature(target, mover);
            }
        }
        return this.getOccupant(x, y, z) === 0;
    }

    _tryShoveOrthogonal(target) {
        if (!target) return false;
        const dirs = [
            [0, -1],
            [-1, 0],
            [1, 0],
            [0, 1]
        ];
        const rng = typeof this.rng === 'function' ? this.rng : Math.random;
        for (let i = dirs.length - 1; i > 0; i--) {
            const j = (rng() * (i + 1)) | 0;
            const tmp = dirs[i];
            dirs[i] = dirs[j];
            dirs[j] = tmp;
        }
        const z = target.z | 0;
        const bx = target.x | 0;
        const by = target.y | 0;
        const from = { x: bx, y: by, z };
        for (let i = 0; i < dirs.length; i++) {
            const nx = bx + dirs[i][0];
            const ny = by + dirs[i][1];
            if (!this.canEnter(nx, ny, z, target)) continue;
            if (this.moveEntityToTile(nx, ny, z, target)) {
                target.path = [];
                if (typeof this.onPushed === 'function') this.onPushed(target, from);
                return true;
            }
        }
        return false;
    }

    _crushCreature(target, mover) {
        if (!target) return;
        target.hp = 0;
        if (typeof this.onCrush === 'function') {
            this.onCrush(target, mover);
            return;
        }
        this.leaveTile(target.x, target.y, target.z, target);
    }

    findNearestEnterable(ox, oy, z, entity) {
        const layer = this.getLayer(z);
        if (!layer) return null;
        const maxR = Math.max(layer.cols, layer.rows);
        for (let r = 0; r <= maxR; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (r !== 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                    const cx = (ox | 0) + dx;
                    const cy = (oy | 0) + dy;
                    if (this.canEnter(cx, cy, z, entity)) {
                        return { x: cx, y: cy, z };
                    }
                }
            }
        }
        return null;
    }

    clearOccupancy(z) {
        if (z == null) {
            for (const key of Object.keys(this.layers)) {
                this.layers[key].occupancy.fill(0);
            }
            this.playerStacks.clear();
            return;
        }
        const layer = this.getLayer(z);
        if (layer) layer.occupancy.fill(0);
        const prefix = `${z | 0}:`;
        for (const key of Array.from(this.playerStacks.keys())) {
            if (key.startsWith(prefix)) this.playerStacks.delete(key);
        }
    }
}

function frictionFromTiles(map, n) {
    const friction = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const id = map.tiles[i];
        const ts = map.tileset && map.tileset[id];
        if (ts) {
            friction[i] = ts.walk ? (ts.friction | 0) || DEFAULT_WALK_FRICTION : FRICTION_BLOCKED;
        } else {
            friction[i] = isBlocked(id) ? FRICTION_BLOCKED : DEFAULT_WALK_FRICTION;
        }
    }
    return friction;
}

function layerChannels(map, z, n) {
    const fl = map.floors && (map.floors[String(z)] || map.floors[z]);
    if (fl && fl.friction && fl.friction.length === n) {
        return {
            friction: fl.friction instanceof Uint8Array
                ? fl.friction
                : Uint8Array.from(fl.friction),
            sight: fl.sight
                ? (fl.sight instanceof Uint8Array ? fl.sight : Uint8Array.from(fl.sight))
                : null,
            flags: fl.flags
                ? (fl.flags instanceof Uint8Array ? fl.flags : Uint8Array.from(fl.flags))
                : null,
            fields: fl.fields
                ? (fl.fields instanceof Uint8Array ? fl.fields : Uint8Array.from(fl.fields))
                : null
        };
    }
    const homeZ = map.spawnZ != null ? map.spawnZ : map.z;
    if ((z | 0) === (homeZ | 0) && map.friction instanceof Uint8Array && map.friction.length === n) {
        return { friction: map.friction, sight: map.sight, flags: map.flags, fields: map.fields };
    }
    if ((z | 0) === (map.z | 0) && map.tiles && map.tiles.length === n) {
        return { friction: frictionFromTiles(map, n), sight: null, flags: null, fields: null };
    }
    return {
        friction: new Uint8Array(n).fill(FRICTION_BLOCKED),
        sight: new Uint8Array(n).fill(FRICTION_BLOCKED),
        flags: new Uint8Array(n),
        fields: new Uint8Array(n)
    };
}

function fromStaticMap(map, opts) {
    const cols = map.width;
    const rows = map.height;
    const n = cols * rows;
    const homeZ = map.spawnZ != null ? map.spawnZ : map.z;
    const zMin = map.zMin != null ? map.zMin : homeZ;
    const zMax = map.zMax != null ? map.zMax : homeZ;
    const home = layerChannels(map, homeZ, n);
    const tm = new TileMap({
        cols,
        rows,
        z: homeZ,
        friction: home.friction,
        sight: home.sight,
        flags: home.flags,
        fields: home.fields,
        maxStack: opts && opts.maxStack,
        resolveEntity: opts && opts.resolveEntity,
        rng: opts && opts.rng,
        crush: opts && opts.crush,
        onCrush: opts && opts.onCrush,
        onPushed: opts && opts.onPushed,
        onMove: opts && opts.onMove,
        playerSpatial: opts && opts.playerSpatial,
        creatureSpatial: opts && opts.creatureSpatial,
        budget: opts && opts.budget,
        computeService: opts && opts.computeService,
        path: opts && opts.path
    });
    for (let z = zMin; z <= zMax; z++) {
        if ((z | 0) === (homeZ | 0)) continue;
        tm.addLayer(z, layerChannels(map, z, n));
    }
    if (Array.isArray(map.stairs)) tm.installStairs(map.stairs);
    return tm;
}

module.exports = {
    FRICTION_BLOCKED,
    DEFAULT_WALK_FRICTION,
    TILE_FLAG_NO_CAST,
    TILE_FLAG_STAIR,
    TILE_FLAG_LADDER,
    TILE_FLAG_HOLE,
    TILE_FLAG_ROPE_SPOT,
    TILE_FLAG_SHOVEL_SPOT,
    TILE_FLAG_NO_CREATURE,
    TILE_FLAG_PZ_PACKAGE,
    TILE_FLAG_HOP_PAD,
    hopsOnStep,
    hopDirOffset,
    reverseHopDir,
    stairKey,
    resolveStairDest,
    entityIdOf,
    isPlayerEntity,
    isNpcEntity,
    isSummonEntity,
    entityCanPushCreatures,
    isPushableEntity,
    TileMap,
    fromStaticMap
};

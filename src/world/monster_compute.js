'use strict';

const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { findPath } = require('./pathfinder');

const DEFAULT_CAPACITY = 2048;
const DEFAULT_MARGIN = 8;

/**
 * Resolves worker count based on configuration setting.
 * Reference formula for 'auto':
 * 0 if os.cpus().length <= 2, else clamp(floor((n-2)/2), 1, 4).
 */
function resolveWorkerCount(val) {
    if (val === 'auto') {
        const cpus = os.cpus() ? os.cpus().length : 1;
        if (cpus <= 2) return 0;
        return Math.min(4, Math.max(1, Math.floor((cpus - 2) / 2)));
    }
    const n = Number.parseInt(String(val), 10);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(4, Math.max(1, n));
}

/**
 * Extracts a typed snapshot or bounding window from the TileMap layer.
 * No live entity objects are cloned.
 */
function extractGridSnapshot(tileMap, z, start, goal, margin = DEFAULT_MARGIN) {
    if (!tileMap || typeof tileMap.getLayer !== 'function') return null;
    const layer = tileMap.getLayer(z);
    if (!layer || !layer.friction || !layer.occupancy) return null;

    const cols = layer.cols | 0;
    const rows = layer.rows | 0;
    const pad = Math.max(1, margin | 0);

    const minX = Math.max(0, Math.min(start.x | 0, goal.x | 0) - pad);
    const maxX = Math.min(cols - 1, Math.max(start.x | 0, goal.x | 0) + pad);
    const minY = Math.max(0, Math.min(start.y | 0, goal.y | 0) - pad);
    const maxY = Math.min(rows - 1, Math.max(start.y | 0, goal.y | 0) + pad);

    const winW = maxX - minX + 1;
    const winH = maxY - minY + 1;
    const winSize = winW * winH;
    const totalSize = cols * rows;

    if (winSize < totalSize / 2) {
        const winFriction = new Uint8Array(winSize);
        const winOccupancy = new Int32Array(winSize);
        const winFlags = layer.flags ? new Uint8Array(winSize) : null;
        const winFields = layer.fields ? new Uint8Array(winSize) : null;

        for (let y = minY; y <= maxY; y++) {
            const srcOffset = y * cols + minX;
            const dstOffset = (y - minY) * winW;
            winFriction.set(layer.friction.subarray(srcOffset, srcOffset + winW), dstOffset);
            winOccupancy.set(layer.occupancy.subarray(srcOffset, srcOffset + winW), dstOffset);
            if (winFlags && layer.flags) {
                winFlags.set(layer.flags.subarray(srcOffset, srcOffset + winW), dstOffset);
            }
            if (winFields && layer.fields) {
                winFields.set(layer.fields.subarray(srcOffset, srcOffset + winW), dstOffset);
            }
        }

        return {
            isWindow: true,
            minX,
            minY,
            cols: winW,
            rows: winH,
            friction: winFriction,
            occupancy: winOccupancy,
            flags: winFlags,
            fields: winFields
        };
    }

    return {
        isWindow: false,
        minX: 0,
        minY: 0,
        cols,
        rows,
        friction: layer.friction.slice(),
        occupancy: layer.occupancy.slice(),
        flags: layer.flags ? layer.flags.slice() : null,
        fields: layer.fields ? layer.fields.slice() : null
    };
}

class MonsterComputeService {
    constructor(opts = {}) {
        this.workerCount = resolveWorkerCount(opts.workers);
        this.capacity = Number.isFinite(Number(opts.capacity)) && Number(opts.capacity) > 0
            ? Number(opts.capacity) | 0
            : DEFAULT_CAPACITY;
        this.visibleReserve = Number.isFinite(Number(opts.visibleReserve)) && Number(opts.visibleReserve) > 0
            ? Number(opts.visibleReserve) | 0
            : Math.floor(this.capacity / 4);
        this.applyDelayTicks = opts.applyDelayTicks !== undefined
            ? Math.max(0, Number(opts.applyDelayTicks) | 0)
            : 0;
        this.tileMap = opts.tileMap || null;
        this.creatureIdBase = Number(opts.creatureIdBase) || 1000000000;
        this.log = opts.log || null;
        this.workerScriptPath = opts.workerScriptPath || path.join(__dirname, 'monster_compute_worker.js');
        this.enabled = opts.enabled !== undefined ? !!opts.enabled : true;

        this.running = false;
        this.workers = [];
        this.visibleQueue = [];
        this.backgroundQueue = [];
        this.completions = [];

        this._nextToken = 0;
        this._jobsByToken = new Map();
        this._entityActiveToken = new Map();

        this._totalSubmitted = 0;
        this._inlineComputed = 0;
        this._workerComputed = 0;
        this._totalDrained = 0;
        this._totalRejected = 0;
        this._totalEvictions = 0;
        this._totalStaleDropped = 0;
        this._totalErrors = 0;
    }

    start() {
        if (this.running) return;
        this.running = true;

        if (this.workerCount > 0) {
            for (let i = 0; i < this.workerCount; i++) {
                this._spawnWorker(i);
            }
        }
    }

    stop() {
        this.running = false;
        for (let i = 0; i < this.workers.length; i++) {
            try {
                this.workers[i].worker.terminate();
            } catch (_) {}
        }
        this.workers.length = 0;
        this.visibleQueue.length = 0;
        this.backgroundQueue.length = 0;
        this.completions.length = 0;
        this._jobsByToken.clear();
        this._entityActiveToken.clear();
    }

    _spawnWorker(index) {
        try {
            const worker = new Worker(this.workerScriptPath);
            worker.unref();

            const entry = {
                id: index,
                worker,
                busy: false
            };

            worker.on('message', (msg) => {
                if (msg && msg.type === 'COMPLETION') {
                    entry.busy = false;
                    this._handleWorkerCompletion(msg.completion);
                    this._dispatchNext();
                }
            });

            worker.on('error', (err) => {
                if (this.log && typeof this.log.error === 'function') {
                    this.log.error(`MonsterComputeWorker ${index} error: ${err.message}`);
                }
                this._totalErrors++;
                entry.busy = false;
                if (this.running) {
                    this._replaceWorker(entry);
                }
            });

            worker.on('exit', (code) => {
                if (this.running && code !== 0) {
                    if (this.log && typeof this.log.warn === 'function') {
                        this.log.warn(`MonsterComputeWorker ${index} exited with code ${code}`);
                    }
                    this._replaceWorker(entry);
                }
            });

            this.workers.push(entry);
        } catch (err) {
            if (this.log && typeof this.log.error === 'function') {
                this.log.error(`Failed to spawn MonsterComputeWorker: ${err.message}`);
            }
        }
    }

    _replaceWorker(entry) {
        const idx = this.workers.indexOf(entry);
        if (idx >= 0) {
            this.workers.splice(idx, 1);
        }
        try {
            entry.worker.terminate();
        } catch (_) {}
        if (this.running && this.workers.length < this.workerCount) {
            this._spawnWorker(entry.id);
            this._dispatchNext();
        }
    }

    submitPath(jobDesc) {
        if (!this.enabled || !jobDesc || !jobDesc.start || !jobDesc.goal) {
            return null;
        }

        const priority = jobDesc.priority === 'background' ? 'background' : 'visible';
        const totalQueued = this.visibleQueue.length + this.backgroundQueue.length;
        const maxBackground = Math.max(0, this.capacity - this.visibleReserve);

        if (priority === 'background') {
            if (this.backgroundQueue.length >= maxBackground || totalQueued >= this.capacity) {
                this._totalRejected++;
                return null;
            }
        } else {
            if (totalQueued >= this.capacity) {
                if (this.backgroundQueue.length > 0) {
                    const evicted = this.backgroundQueue.shift();
                    this._totalEvictions++;
                    this._jobsByToken.delete(evicted.token);
                    this.completions = this.completions.filter(c => c.token !== evicted.token);
                } else {
                    this._totalRejected++;
                    return null;
                }
            }
        }

        const token = ++this._nextToken;
        const entityId = jobDesc.entityId | 0;
        this._entityActiveToken.set(entityId, token);
        this._totalSubmitted++;

        const job = {
            token,
            entityId,
            priority,
            z: jobDesc.z,
            start: { x: jobDesc.start.x | 0, y: jobDesc.start.y | 0 },
            goal: { x: jobDesc.goal.x | 0, y: jobDesc.goal.y | 0 },
            flags: jobDesc.flags || {},
            caps: jobDesc.caps || {}
        };

        this._jobsByToken.set(token, job);

        if (priority === 'visible') {
            this.visibleQueue.push(job);
        } else {
            this.backgroundQueue.push(job);
        }

        if (this.workerCount === 0) {
            this._inlineComputed++;
            const comp = this._computeInline(token, jobDesc);
            if (this.applyDelayTicks === 0) {
                if (priority === 'visible') {
                    const idx = this.visibleQueue.indexOf(job);
                    if (idx >= 0) this.visibleQueue.splice(idx, 1);
                } else {
                    const idx = this.backgroundQueue.indexOf(job);
                    if (idx >= 0) this.backgroundQueue.splice(idx, 1);
                }
                this._jobsByToken.delete(token);
                return {
                    token,
                    inline: true,
                    status: comp.status,
                    path: comp.path,
                    goal: jobDesc.goal
                };
            }
            this.completions.push(comp);
            return {
                token,
                inline: false,
                status: 'pending',
                path: null,
                goal: jobDesc.goal
            };
        }

        const tileMap = jobDesc.tileMap || this.tileMap;
        const grid = extractGridSnapshot(
            tileMap,
            jobDesc.z,
            jobDesc.start,
            jobDesc.goal,
            jobDesc.margin || DEFAULT_MARGIN
        );

        if (!grid) {
            if (priority === 'visible') {
                const idx = this.visibleQueue.indexOf(job);
                if (idx >= 0) this.visibleQueue.splice(idx, 1);
            } else {
                const idx = this.backgroundQueue.indexOf(job);
                if (idx >= 0) this.backgroundQueue.splice(idx, 1);
            }
            this._jobsByToken.delete(token);
            this._totalRejected++;
            return null;
        }

        grid.canPushCreatures = !!(jobDesc.flags && jobDesc.flags.canPushCreatures);
        grid.creatureIdBase = this.creatureIdBase;
        grid.moverId = entityId;
        job.grid = grid;

        this._dispatchNext();

        return {
            token,
            inline: false,
            status: 'pending',
            path: null,
            goal: jobDesc.goal
        };
    }

    _computeInline(token, jobDesc) {
        const tileMap = jobDesc.tileMap || this.tileMap;
        const flags = jobDesc.flags || {};
        const caps = jobDesc.caps || {};
        const path = findPath(
            tileMap,
            { x: jobDesc.start.x | 0, y: jobDesc.start.y | 0, z: jobDesc.z },
            { x: jobDesc.goal.x | 0, y: jobDesc.goal.y | 0, z: jobDesc.z },
            {
                allowDiagonal: flags.allowDiagonal !== false,
                useStackPolicy: flags.useStackPolicy !== false,
                occupantStepPenalty: flags.occupantStepPenalty != null ? Number(flags.occupantStepPenalty) : 4,
                avoidFieldMask: flags.avoidFieldMask || 0,
                ignorePlayerFields: !!flags.ignorePlayerFields,
                fieldPenalty: flags.fieldPenalty || 0,
                maxDistance: caps.maxDistance || 100,
                maxIterations: caps.maxIterations || 512,
                mover: {
                    id: jobDesc.entityId | 0,
                    canPushCreatures: !!flags.canPushCreatures
                }
            }
        );

        return {
            token,
            entityId: jobDesc.entityId | 0,
            status: path && path.length > 0 ? 'found' : 'none',
            path: path || null,
            goal: jobDesc.goal
        };
    }

    _dispatchNext() {
        if (!this.running || this.workerCount <= 0) return;

        for (let i = 0; i < this.workers.length; i++) {
            const w = this.workers[i];
            if (!w.busy) {
                let job = null;
                // Find next job that is not already dispatched
                for (let j = 0; j < this.visibleQueue.length; j++) {
                    if (!this.visibleQueue[j].dispatched) {
                        job = this.visibleQueue[j];
                        break;
                    }
                }
                if (!job) {
                    for (let j = 0; j < this.backgroundQueue.length; j++) {
                        if (!this.backgroundQueue[j].dispatched) {
                            job = this.backgroundQueue[j];
                            break;
                        }
                    }
                }

                if (!job) break;

                const currentToken = this._entityActiveToken.get(job.entityId);
                if (currentToken !== job.token) {
                    this._jobsByToken.delete(job.token);
                    this._totalStaleDropped++;
                    if (job.priority === 'visible') {
                        const idx = this.visibleQueue.indexOf(job);
                        if (idx >= 0) this.visibleQueue.splice(idx, 1);
                    } else {
                        const idx = this.backgroundQueue.indexOf(job);
                        if (idx >= 0) this.backgroundQueue.splice(idx, 1);
                    }
                    i--;
                    continue;
                }

                job.dispatched = true;
                w.busy = true;
                w.worker.postMessage({ type: 'JOB', job });
            }
        }
    }

    _handleWorkerCompletion(comp) {
        this._workerComputed++;
        this._jobsByToken.delete(comp.token);

        const currentToken = this._entityActiveToken.get(comp.entityId);
        if (currentToken !== comp.token) {
            this._totalStaleDropped++;
            return;
        }

        this.completions.push(comp);
    }

    drainCompletions(max = Infinity) {
        const limit = Number.isFinite(max) && max > 0 ? max | 0 : this.completions.length;
        if (this.completions.length === 0 || limit <= 0) return [];

        let drained;
        if (limit >= this.completions.length) {
            drained = this.completions;
            this.completions = [];
        } else {
            drained = this.completions.splice(0, limit);
        }

        drained.sort((a, b) => {
            if (a.entityId !== b.entityId) return (a.entityId | 0) - (b.entityId | 0);
            return (a.token | 0) - (b.token | 0);
        });

        for (let i = 0; i < drained.length; i++) {
            const token = drained[i].token;
            this._jobsByToken.delete(token);
        }

        this.visibleQueue = this.visibleQueue.filter(j => this._jobsByToken.has(j.token));
        this.backgroundQueue = this.backgroundQueue.filter(j => this._jobsByToken.has(j.token));

        this._totalDrained += drained.length;
        return drained;
    }

    cancelEntityJobs(entityId) {
        const id = entityId | 0;
        this._entityActiveToken.delete(id);
        if (this.visibleQueue.length > 0) {
            this.visibleQueue = this.visibleQueue.filter(j => j.entityId !== id);
        }
        if (this.backgroundQueue.length > 0) {
            this.backgroundQueue = this.backgroundQueue.filter(j => j.entityId !== id);
        }
        if (this.completions.length > 0) {
            this.completions = this.completions.filter(c => c.entityId !== id);
        }
    }

    recordStale() {
        this._totalStaleDropped++;
    }

    stats() {
        return {
            workerCount: this.workerCount,
            queued: this.visibleQueue.length + this.backgroundQueue.length,
            visibleQueued: this.visibleQueue.length,
            backgroundQueued: this.backgroundQueue.length,
            completionsQueued: this.completions.length,
            totalSubmitted: this._totalSubmitted,
            inlineComputed: this._inlineComputed,
            workerComputed: this._workerComputed,
            drained: this._totalDrained,
            rejected: this._totalRejected,
            evictions: this._totalEvictions,
            staleDropped: this._totalStaleDropped,
            errors: this._totalErrors
        };
    }
}

module.exports = {
    MonsterComputeService,
    resolveWorkerCount,
    extractGridSnapshot,
    DEFAULT_CAPACITY,
    DEFAULT_MARGIN
};

'use strict';

const { parentPort } = require('worker_threads');
const { findPath } = require('./pathfinder');

class SnapshotGrid {
    constructor(grid) {
        this.cols = grid.cols | 0;
        this.rows = grid.rows | 0;
        this.friction = grid.friction;
        this.occupancy = grid.occupancy;
        this.flags = grid.flags || null;
        this.fields = grid.fields || null;
        this.canPushCreatures = !!grid.canPushCreatures;
        this.creatureIdBase = Number(grid.creatureIdBase) || 1000000000;
        this.moverId = grid.moverId | 0;
    }

    getLayer(z) {
        return this;
    }

    pathStepOccupancy(x, y, z, mover) {
        const idx = (y | 0) * this.cols + (x | 0);
        const occ = this.occupancy ? (this.occupancy[idx] | 0) : 0;
        if (occ === 0) return 'free';
        const id = mover && mover.id != null ? (mover.id | 0) : this.moverId;
        if (id !== 0 && occ === id) return 'free';
        if (occ > 0 && occ < this.creatureIdBase) {
            return 'hard';
        }
        if (this.canPushCreatures) {
            return 'soft';
        }
        return 'hard';
    }

    creatureMayEnterTile(x, y, z, mover) {
        if (!this.flags) return true;
        const idx = (y | 0) * this.cols + (x | 0);
        return (this.flags[idx] & 1) === 0;
    }
}

if (parentPort) {
    parentPort.on('message', (msg) => {
        if (!msg || msg.type !== 'JOB' || !msg.job) return;
        const job = msg.job;
        try {
            const gridData = job.grid;
            const grid = new SnapshotGrid(gridData);

            let startX = job.start.x | 0;
            let startY = job.start.y | 0;
            let goalX = job.goal.x | 0;
            let goalY = job.goal.y | 0;

            if (gridData.isWindow) {
                startX -= gridData.minX | 0;
                startY -= gridData.minY | 0;
                goalX -= gridData.minX | 0;
                goalY -= gridData.minY | 0;
            }

            const flags = job.flags || {};
            const caps = job.caps || {};

            const path = findPath(
                grid,
                { x: startX, y: startY, z: job.z },
                { x: goalX, y: goalY, z: job.z },
                {
                    allowDiagonal: flags.allowDiagonal !== false,
                    useStackPolicy: flags.useStackPolicy !== false,
                    occupantStepPenalty: flags.occupantStepPenalty != null ? Number(flags.occupantStepPenalty) : 4,
                    avoidFieldMask: flags.avoidFieldMask || 0,
                    ignorePlayerFields: !!flags.ignorePlayerFields,
                    fieldPenalty: flags.fieldPenalty || 0,
                    maxDistance: caps.maxDistance || 100,
                    maxIterations: caps.maxIterations || 512,
                    mover: { id: job.entityId }
                }
            );

            let resultPath = null;
            if (path && path.length > 0) {
                if (gridData.isWindow) {
                    const ox = gridData.minX | 0;
                    const oy = gridData.minY | 0;
                    resultPath = new Array(path.length);
                    for (let i = 0; i < path.length; i++) {
                        resultPath[i] = {
                            x: path[i].x + ox,
                            y: path[i].y + oy
                        };
                    }
                } else {
                    resultPath = path;
                }
            }

            parentPort.postMessage({
                type: 'COMPLETION',
                completion: {
                    token: job.token,
                    entityId: job.entityId,
                    status: resultPath ? 'found' : 'none',
                    path: resultPath,
                    goal: job.goal
                }
            });
        } catch (err) {
            parentPort.postMessage({
                type: 'COMPLETION',
                completion: {
                    token: job.token,
                    entityId: job.entityId,
                    status: 'error',
                    error: err.message,
                    path: null,
                    goal: job.goal
                }
            });
        }
    });
}

module.exports = {
    SnapshotGrid
};

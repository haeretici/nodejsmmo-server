'use strict';

/**
 * Caps concurrent character SQL writes. Interval / daily / logout storms
 * at 1000 online must not open one transaction per player at once.
 */
class PersistGate {
    constructor(limit) {
        const n = Number(limit);
        this.limit = Number.isFinite(n) && n > 0 ? (n | 0) : 8;
        this.active = 0;
        this.wait = [];
    }

    async run(fn) {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    acquire() {
        if (this.active < this.limit) {
            this.active += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.wait.push(resolve);
        });
    }

    release() {
        const next = this.wait.shift();
        if (next) {
            next();
            return;
        }
        this.active -= 1;
        if (this.active < 0) this.active = 0;
    }
}

module.exports = { PersistGate };

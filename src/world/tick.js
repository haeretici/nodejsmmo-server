'use strict';

class WorldTick {
    /**
     * @param {{
     *   ups?: number,
     *   now?: () => number,
     *   schedule?: (fn: () => void, ms: number) => any,
     *   clear?: (id: any) => void,
     *   onTick?: (tickIndex: number) => void,
     *   maxCatchUp?: number
     * }} [opts]
     */
    constructor(opts = {}) {
        this.ups = opts.ups != null ? opts.ups : 20;
        this.dtMs = 1000 / this.ups;
        this.now = opts.now || (() => Date.now());
        this.schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
        this.clear = opts.clear || ((id) => clearTimeout(id));
        this.onTick = opts.onTick || null;
        this.maxCatchUp = opts.maxCatchUp != null ? opts.maxCatchUp : 5;
        this.tickIndex = 0;
        this.missedTicks = 0;
        this.running = false;
        this._timer = null;
        this._nextAt = 0;
        this.startedAt = 0;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.startedAt = this.now();
        this._nextAt = this.startedAt + this.dtMs;
        this._arm();
    }

    stop() {
        this.running = false;
        if (this._timer != null) {
            this.clear(this._timer);
            this._timer = null;
        }
    }

    snapshot() {
        return {
            running: this.running,
            tickIndex: this.tickIndex,
            ups: this.ups,
            missedTicks: this.missedTicks
        };
    }

    _arm() {
        if (!this.running) return;
        const delay = Math.max(0, this._nextAt - this.now());
        this._timer = this.schedule(() => this._fire(), delay);
    }

    _fire() {
        this._timer = null;
        if (!this.running) return;
        const now = this.now();
        let n = 0;
        while (now >= this._nextAt && n < this.maxCatchUp) {
            this.tickIndex += 1;
            if (this.onTick) this.onTick(this.tickIndex);
            this._nextAt += this.dtMs;
            n += 1;
        }
        if (n === this.maxCatchUp && now >= this._nextAt) {
            const skipped = Math.floor((now - this._nextAt) / this.dtMs) + 1;
            this.missedTicks += skipped;
            this._nextAt = now + this.dtMs;
        }
        this._arm();
    }
}

module.exports = { WorldTick };

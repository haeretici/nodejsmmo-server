'use strict';

/**
 * Per-tick budget for optional A* repaths (Option B).
 * Critical (empty path / blocked-step) always runs. Optional moving-goal
 * repaths consume the frame limit; 0 = unlimited.
 */
class PathBudget {
    constructor(limit) {
        this._limit = Number(limit) || 0;
        this.stamp = null;
        this.used = 0;
        this.repaths = 0;
        this.criticalRepaths = 0;
        this.optionalRepaths = 0;
        this.budgetSkips = 0;
        this.failBackoffs = 0;
        this.repathsFrame = 0;
        this.criticalRepathsFrame = 0;
        this.optionalRepathsFrame = 0;
        this.budgetSkipsFrame = 0;
        this.failBackoffsFrame = 0;
    }

    setLimit(limit) {
        const n = Number(limit);
        this._limit = Number.isFinite(n) && n > 0 ? n | 0 : 0;
    }

    begin(stamp) {
        if (this.stamp === stamp) return;
        this.stamp = stamp;
        this.used = 0;
        this.repathsFrame = 0;
        this.criticalRepathsFrame = 0;
        this.optionalRepathsFrame = 0;
        this.budgetSkipsFrame = 0;
        this.failBackoffsFrame = 0;
    }

    take(opts) {
        const critical = !!(opts && opts.critical);
        if (critical) {
            this.criticalRepaths += 1;
            this.criticalRepathsFrame += 1;
            this.repaths += 1;
            this.repathsFrame += 1;
            return true;
        }
        const limit = this._limit;
        if (limit <= 0) {
            this.optionalRepaths += 1;
            this.optionalRepathsFrame += 1;
            this.repaths += 1;
            this.repathsFrame += 1;
            return true;
        }
        if (this.used >= limit) {
            this.budgetSkips += 1;
            this.budgetSkipsFrame += 1;
            return false;
        }
        this.used += 1;
        this.optionalRepaths += 1;
        this.optionalRepathsFrame += 1;
        this.repaths += 1;
        this.repathsFrame += 1;
        return true;
    }

    noteFailBackoff() {
        this.failBackoffs += 1;
        this.failBackoffsFrame += 1;
    }

    stats() {
        return {
            stamp: this.stamp,
            used: this.used,
            limit: this._limit,
            repaths: this.repaths,
            criticalRepaths: this.criticalRepaths,
            optionalRepaths: this.optionalRepaths,
            budgetSkips: this.budgetSkips,
            failBackoffs: this.failBackoffs,
            repathsFrame: this.repathsFrame,
            criticalRepathsFrame: this.criticalRepathsFrame,
            optionalRepathsFrame: this.optionalRepathsFrame,
            budgetSkipsFrame: this.budgetSkipsFrame,
            failBackoffsFrame: this.failBackoffsFrame
        };
    }

    reset() {
        this.stamp = null;
        this.used = 0;
        this.repaths = 0;
        this.criticalRepaths = 0;
        this.optionalRepaths = 0;
        this.budgetSkips = 0;
        this.failBackoffs = 0;
        this.repathsFrame = 0;
        this.criticalRepathsFrame = 0;
        this.optionalRepathsFrame = 0;
        this.budgetSkipsFrame = 0;
        this.failBackoffsFrame = 0;
    }
}

function isLogicIntervalDue(host, key, intervalSec, now) {
    const interval = Number(intervalSec);
    if (!host || !Number.isFinite(interval) || interval <= 0) return true;
    const t = typeof now === 'number' && Number.isFinite(now) ? now : 0;
    const nextAt = host[key];
    if (nextAt != null && Number.isFinite(nextAt) && t < nextAt) {
        return false;
    }
    host[key] = t + interval;
    return true;
}

function forceDue(host, key) {
    if (!host || !key) return;
    host[key] = null;
}

function seedPathPhase(entity, intervalSec, now) {
    if (!entity) return;
    const interval = Number(intervalSec);
    if (!Number.isFinite(interval) || interval <= 0) return;
    const t = typeof now === 'number' && Number.isFinite(now) ? now : 0;
    const id = entity.id != null ? entity.id | 0 : 0;
    const phase = ((id % 1000) + 1000) % 1000;
    entity._repathNextAt = t + (phase / 1000) * interval;
}

module.exports = {
    PathBudget,
    isLogicIntervalDue,
    forceDue,
    seedPathPhase
};

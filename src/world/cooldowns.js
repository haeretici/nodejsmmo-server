'use strict';

/** Product port of HuntDL cooldown buckets. No kernel require. */

const BUCKETS = ['auto', 'primary', 'secondary', 'spell', 'item'];
const SEEDED_BUCKETS = { auto: true, primary: true, item: true };

function createCooldownState() {
    return {
        auto: { attack: 0 },
        primary: { attack: 0, healing: 0, support: 0 },
        secondary: {},
        spell: {},
        item: { use: 0, equip: 0, open: 0 }
    };
}

function ensureCooldowns(entity) {
    if (!entity) return createCooldownState();
    if (!entity.cooldowns) {
        entity.cooldowns = createCooldownState();
    } else {
        const seed = createCooldownState();
        for (let i = 0; i < BUCKETS.length; i++) {
            const b = BUCKETS[i];
            if (!entity.cooldowns[b] || typeof entity.cooldowns[b] !== 'object') {
                entity.cooldowns[b] = SEEDED_BUCKETS[b] ? seed[b] : {};
            } else if (SEEDED_BUCKETS[b]) {
                const keys = Object.keys(seed[b]);
                for (let k = 0; k < keys.length; k++) {
                    const key = keys[k];
                    if (entity.cooldowns[b][key] == null) {
                        entity.cooldowns[b][key] = 0;
                    }
                }
            }
        }
    }
    return entity.cooldowns;
}

function resolveNow(entity, now) {
    if (now != null && Number.isFinite(Number(now))) {
        return Number(now);
    }
    if (entity && entity.world && typeof entity.world.logicNow === 'function') {
        return entity.world.logicNow(entity.world._tickIndex);
    }
    return 0;
}

function getRemaining(entity, bucket, key, now) {
    const cds = entity && entity.cooldowns;
    if (!cds || !cds[bucket]) return 0;
    const readyAt = cds[bucket][key];
    if (readyAt == null || readyAt <= 0) return 0;
    const current = resolveNow(entity, now);
    const rem = readyAt - current;
    return rem > 0 ? rem : 0;
}

function isReady(entity, bucket, key, now) {
    const cds = entity && entity.cooldowns;
    if (!cds || !cds[bucket]) return true;
    const readyAt = cds[bucket][key];
    if (readyAt == null || readyAt <= 0) return true;
    const current = resolveNow(entity, now);
    return current >= readyAt;
}

function canUse(entity, spec, now) {
    if (!spec || typeof spec !== 'object') return true;
    ensureCooldowns(entity);
    const current = resolveNow(entity, now);
    for (let i = 0; i < BUCKETS.length; i++) {
        const bucket = BUCKETS[i];
        const keys = spec[bucket];
        if (!keys || typeof keys !== 'object') continue;
        const bucketCds = entity.cooldowns[bucket];
        for (const key of Object.keys(keys)) {
            const readyAt = bucketCds && bucketCds[key];
            if (readyAt != null && readyAt > current) return false;
        }
    }
    return true;
}

function apply(entity, spec, now) {
    if (!spec || typeof spec !== 'object') return;
    const cds = ensureCooldowns(entity);
    const current = resolveNow(entity, now);
    for (let i = 0; i < BUCKETS.length; i++) {
        const bucket = BUCKETS[i];
        const keys = spec[bucket];
        if (!keys || typeof keys !== 'object') continue;
        if (!cds[bucket]) cds[bucket] = {};
        for (const key of Object.keys(keys)) {
            const dur = Number(keys[key]) || 0;
            if (dur > 0) {
                cds[bucket][key] = current + dur;
            }
        }
    }
}

function tick(entity, dt) {
    // No-op with timestamp-based cooldown deadlines.
}

function tryUse(entity, spec, now) {
    const current = resolveNow(entity, now);
    if (!canUse(entity, spec, current)) return false;
    apply(entity, spec, current);
    return true;
}

module.exports = {
    BUCKETS,
    createCooldownState,
    ensureCooldowns,
    getRemaining,
    isReady,
    canUse,
    apply,
    tick,
    tryUse
};

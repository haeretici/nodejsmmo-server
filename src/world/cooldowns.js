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

const DEFAULT_UPS = 20;

function resolveUps(ups) {
    return (ups != null && Number(ups) > 0) ? Number(ups) : DEFAULT_UPS;
}

function resolveTick(entity, tickIndex) {
    if (tickIndex != null && Number.isFinite(Number(tickIndex))) {
        return Math.floor(Number(tickIndex));
    }
    if (entity && entity.world && entity.world._tickIndex != null) {
        return Math.floor(Number(entity.world._tickIndex));
    }
    return 0;
}

function getRemaining(entity, bucket, key, tickIndex, ups) {
    const cds = entity && entity.cooldowns;
    if (!cds || !cds[bucket]) return 0;
    const readyTick = cds[bucket][key];
    if (readyTick == null || readyTick <= 0) return 0;
    const current = resolveTick(entity, tickIndex);
    const diff = readyTick - current;
    if (diff <= 0) return 0;
    return diff / resolveUps(ups);
}

function isReady(entity, bucket, key, tickIndex) {
    const cds = entity && entity.cooldowns;
    if (!cds || !cds[bucket]) return true;
    const readyTick = cds[bucket][key];
    if (readyTick == null || readyTick <= 0) return true;
    const current = resolveTick(entity, tickIndex);
    return current >= readyTick;
}

function canUse(entity, spec, tickIndex) {
    if (!spec || typeof spec !== 'object') return true;
    ensureCooldowns(entity);
    const current = resolveTick(entity, tickIndex);
    for (let i = 0; i < BUCKETS.length; i++) {
        const bucket = BUCKETS[i];
        const keys = spec[bucket];
        if (!keys || typeof keys !== 'object') continue;
        const bucketCds = entity.cooldowns[bucket];
        for (const key of Object.keys(keys)) {
            const readyTick = bucketCds && bucketCds[key];
            if (readyTick != null && readyTick > current) return false;
        }
    }
    return true;
}

function apply(entity, spec, tickIndex, ups) {
    if (!spec || typeof spec !== 'object') return;
    const cds = ensureCooldowns(entity);
    const current = resolveTick(entity, tickIndex);
    const rate = resolveUps(ups);
    for (let i = 0; i < BUCKETS.length; i++) {
        const bucket = BUCKETS[i];
        const keys = spec[bucket];
        if (!keys || typeof keys !== 'object') continue;
        if (!cds[bucket]) cds[bucket] = {};
        for (const key of Object.keys(keys)) {
            const dur = Number(keys[key]) || 0;
            if (dur > 0) {
                const addTicks = Math.max(1, Math.round(dur * rate));
                cds[bucket][key] = current + addTicks;
            }
        }
    }
}

function tick(entity, dt) {
    // No-op with discrete integer tick deadlines.
}

function tryUse(entity, spec, tickIndex, ups) {
    const current = resolveTick(entity, tickIndex);
    if (!canUse(entity, spec, current)) return false;
    apply(entity, spec, current, ups);
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

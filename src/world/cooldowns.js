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

function getRemaining(entity, bucket, key) {
    const cds = entity && entity.cooldowns;
    if (!cds || !cds[bucket]) return 0;
    const v = cds[bucket][key];
    return v > 0 ? v : 0;
}

function canUse(entity, spec) {
    if (!spec || typeof spec !== 'object') return true;
    ensureCooldowns(entity);
    for (let i = 0; i < BUCKETS.length; i++) {
        const bucket = BUCKETS[i];
        const keys = spec[bucket];
        if (!keys || typeof keys !== 'object') continue;
        for (const key of Object.keys(keys)) {
            if (getRemaining(entity, bucket, key) > 0) return false;
        }
    }
    return true;
}

function apply(entity, spec) {
    if (!spec || typeof spec !== 'object') return;
    const cds = ensureCooldowns(entity);
    for (let i = 0; i < BUCKETS.length; i++) {
        const bucket = BUCKETS[i];
        const keys = spec[bucket];
        if (!keys || typeof keys !== 'object') continue;
        if (!cds[bucket]) cds[bucket] = {};
        for (const key of Object.keys(keys)) {
            const dur = Number(keys[key]) || 0;
            if (dur > 0) cds[bucket][key] = dur;
        }
    }
}

function tick(entity, dt) {
    if (!entity || !entity.cooldowns) return;
    const step = Math.max(0, Number(dt) || 0);
    if (step === 0) return;
    const cds = entity.cooldowns;
    for (let i = 0; i < BUCKETS.length; i++) {
        const bucket = BUCKETS[i];
        const map = cds[bucket];
        if (!map) continue;
        for (const key of Object.keys(map)) {
            if (map[key] > 0) map[key] = Math.max(0, map[key] - step);
        }
    }
}

function tryUse(entity, spec) {
    if (!canUse(entity, spec)) return false;
    apply(entity, spec);
    return true;
}

module.exports = {
    BUCKETS,
    createCooldownState,
    ensureCooldowns,
    getRemaining,
    canUse,
    apply,
    tick,
    tryUse
};

'use strict';

const { DIR } = require('../protocol/opcodes');
const { copyNpcWanderFields } = require('./npc');

function dirFromDelta(dx, dy) {
    const adx = Math.abs(dx | 0);
    const ady = Math.abs(dy | 0);
    if (adx === 0 && ady === 0) return DIR.N;
    if (adx >= ady) return (dx | 0) > 0 ? DIR.E : DIR.W;
    return (dy | 0) > 0 ? DIR.S : DIR.N;
}

function greedyOrthogonal(fromX, fromY, toX, toY) {
    const dx = Math.sign((toX | 0) - (fromX | 0));
    const dy = Math.sign((toY | 0) - (fromY | 0));
    const adx = Math.abs((toX | 0) - (fromX | 0));
    const ady = Math.abs((toY | 0) - (fromY | 0));
    const out = [];
    function push(x, y, dir) {
        out.push({ x, y, dir });
    }
    if (dx !== 0 && dy !== 0) {
        if (adx >= ady) {
            push((fromX | 0) + dx, fromY | 0, dx > 0 ? DIR.E : DIR.W);
            push(fromX | 0, (fromY | 0) + dy, dy > 0 ? DIR.S : DIR.N);
        } else {
            push(fromX | 0, (fromY | 0) + dy, dy > 0 ? DIR.S : DIR.N);
            push((fromX | 0) + dx, fromY | 0, dx > 0 ? DIR.E : DIR.W);
        }
    } else if (dx !== 0) {
        push((fromX | 0) + dx, fromY | 0, dx > 0 ? DIR.E : DIR.W);
    } else if (dy !== 0) {
        push(fromX | 0, (fromY | 0) + dy, dy > 0 ? DIR.S : DIR.N);
    }
    return out;
}

/** Engine `AI_CREATURE_FLEE_STAND_DIST` default. */
const DEFAULT_FLEE_STAND_DIST = 10;

function isCreatureFleeing(cr) {
    if (!cr) return false;
    const f = cr.flags;
    if (!f) return false;
    const runHealth = Number(f.runHealth) || 0;
    const runPct = Number(f.runHealthPercent) || 0;
    const hp = cr.hp | 0;
    const max = cr.hpMax | 0;
    if (runHealth > 0 && hp <= runHealth) return true;
    if (runPct > 0 && max > 0 && hp / max <= runPct) return true;
    return false;
}

function creatureFleeStandDistance(cr) {
    const f = cr && cr.flags;
    const raw = f && f.fleeTargetDistance != null
        ? Number(f.fleeTargetDistance)
        : DEFAULT_FLEE_STAND_DIST;
    const n = raw | 0;
    return Math.max(1, n || DEFAULT_FLEE_STAND_DIST);
}

function creatureStandDistance(cr) {
    if (isCreatureFleeing(cr)) return creatureFleeStandDistance(cr);
    if (cr && cr.targetDistance != null) return Math.max(1, cr.targetDistance | 0);
    const f = cr && cr.flags;
    if (f && f.targetDistance != null) return Math.max(1, f.targetDistance | 0);
    return 1;
}

function creatureLoseTargetDistance(cr) {
    const base = cr && cr.loseTargetDistance != null
        ? Math.max(1, cr.loseTargetDistance | 0)
        : 12;
    if (isCreatureFleeing(cr)) {
        return Math.max(base, creatureFleeStandDistance(cr));
    }
    return base;
}

function resetCooldowns(cds) {
    if (!cds || typeof cds !== 'object') return;
    if (cds.auto) cds.auto.attack = 0;
    if (cds.primary) {
        cds.primary.attack = 0;
        cds.primary.healing = 0;
        cds.primary.support = 0;
    }
    if (cds.secondary) {
        for (const k of Object.keys(cds.secondary)) delete cds.secondary[k];
    }
    if (cds.spell) {
        for (const k of Object.keys(cds.spell)) delete cds.spell[k];
    }
    if (cds.item) {
        cds.item.use = 0;
        cds.item.equip = 0;
        cds.item.open = 0;
    }
}

class Creature {
    constructor() {
        this.id = 0;
        this.kind = '';
        this.name = '';
        this._pooled = false;
        this.reset();
    }

    init(id, template, pos) {
        const flags = (template && template.flags) || {};
        const isNpc = !!(template && template.isNpc);
        const speed = template && template.speed != null ? Number(template.speed) : 100;
        const posX = pos ? pos.x | 0 : 0;
        const posY = pos ? pos.y | 0 : 0;
        const posZ = pos ? pos.z | 0 : 0;

        this.id = id | 0;
        this.type = isNpc ? 'npc' : 'creature';
        this.isNpc = isNpc;
        this.attackableNpc = !!(template && template.attackableNpc);
        this.kind = (template && template.id) || '';
        this.name = (template && template.label) || '';
        this.x = posX;
        this.y = posY;
        this.z = posZ;
        this.spawnX = posX;
        this.spawnY = posY;
        this.spawnZ = posZ;
        this.dir = 0;
        this.hp = template ? template.hp | 0 : 0;
        this.hpMax = template ? template.hpMax | 0 : 0;
        this.mp = 0;
        this.mpMax = 0;
        this.armor = template ? template.armor : undefined;
        this.mitigation = template ? template.mitigation : undefined;
        this.maxBlock = (template && template.maxBlock) || 0;
        this.canBlock = !!(template && template.canBlock);
        this.shieldBlocksThisWindow = 0;
        this.shieldBlockWindowTick = 0;
        this.resists = (template && template.resists) || { physical: 0 };
        this.critChance = Math.max(0, Number(template && template.critChance) || 0);
        this.critDamage = Math.max(0, Number(template && template.critDamage) || 0);
        this.exp = template ? template.exp | 0 : 0;
        this.speed = Number.isFinite(speed) ? speed : 100;
        this.pushable = flags.pushable !== false;
        this.canPushCreatures = flags.canPushCreatures === true;
        this.flags = flags;
        this.aggro = !template || template.aggro !== false;
        this.attacks = (template && template.attacks) || [];
        this.loot = (template && template.loot) || [];
        this.dialog = (template && template.dialog) || null;
        this.dialogId = (template && template.dialogId) || null;
        this.shop = (template && template.shop) || (this.dialog && this.dialog.shop) || null;
        this.walkInterval = 0;
        this.walkRadius = 0;
        this.voices = null;
        this.voiceInterval = 0;
        this.voiceChance = 0;
        this._npcWalkTicks = 0;
        this._npcVoiceTicks = 0;
        if (isNpc) copyNpcWanderFields(this, template);
        this.targetDistance = flags.targetDistance != null ? Math.max(1, flags.targetDistance | 0) : 1;
        this.aggroRange = flags.aggroRange == null ? 7 : flags.aggroRange | 0;
        this.loseTargetDistance = flags.loseTargetDistance == null ? 12 : flags.loseTargetDistance | 0;
        this.targetId = 0;
        this.leashing = false;
        if (Array.isArray(this.path)) {
            this.path.length = 0;
        } else {
            this.path = [];
        }
        this.moveReadyTick = 0;
        this.attackReadyTick = 0;
        this._attackReadyTicks = {};
        this.simSleeping = false;
        this.pinIndex = null;
        this.baseSpeed = this.speed;
        this._repathNextAt = 0;
        if (this.conditions && Array.isArray(this.conditions)) {
            this.conditions.length = 0;
        } else {
            this.conditions = null;
        }
        if (this.cooldowns) {
            resetCooldowns(this.cooldowns);
        } else {
            this.cooldowns = null;
        }
        this._pooled = false;
        return this;
    }

    reset() {
        this.type = 'creature';
        this.isNpc = false;
        this.attackableNpc = false;
        this.x = 0;
        this.y = 0;
        this.z = 0;
        this.spawnX = 0;
        this.spawnY = 0;
        this.spawnZ = 0;
        this.dir = 0;
        this.hp = 0;
        this.hpMax = 0;
        this.mp = 0;
        this.mpMax = 0;
        this.armor = undefined;
        this.mitigation = undefined;
        this.maxBlock = 0;
        this.canBlock = false;
        this.shieldBlocksThisWindow = 0;
        this.shieldBlockWindowTick = 0;
        this.resists = null;
        this.critChance = 0;
        this.critDamage = 0;
        this.exp = 0;
        this.speed = 100;
        this.pushable = true;
        this.canPushCreatures = false;
        this.flags = null;
        this.aggro = true;
        this.attacks = null;
        this.loot = null;
        this.dialog = null;
        this.dialogId = null;
        this.shop = null;
        this.walkInterval = 0;
        this.walkRadius = 0;
        this.voices = null;
        this.voiceInterval = 0;
        this.voiceChance = 0;
        this._npcWalkTicks = 0;
        this._npcVoiceTicks = 0;
        this.targetDistance = 1;
        this.aggroRange = 7;
        this.loseTargetDistance = 12;
        this.targetId = 0;
        this.leashing = false;
        if (Array.isArray(this.path)) {
            this.path.length = 0;
        } else {
            this.path = [];
        }
        this.moveReadyTick = 0;
        this.attackReadyTick = 0;
        this._attackReadyTicks = {};
        this.simSleeping = false;
        this.pinIndex = null;
        this.baseSpeed = 100;
        this._repathNextAt = 0;
        if (this.conditions && Array.isArray(this.conditions)) {
            this.conditions.length = 0;
        } else {
            this.conditions = null;
        }
        if (this.cooldowns) {
            resetCooldowns(this.cooldowns);
        } else {
            this.cooldowns = null;
        }
        this._pooled = true;
        return this;
    }
}

class CreaturePool {
    constructor(capacity = 4096) {
        this.pool = [];
        this.capacity = Math.max(0, capacity | 0) || 4096;
        this.totalCreated = 0;
        this.totalObtained = 0;
        this.totalReleased = 0;
    }

    get size() {
        return this.pool.length;
    }

    obtain(id, template, pos) {
        this.totalObtained += 1;
        let c = this.pool.pop();
        if (!c) {
            c = new Creature();
            this.totalCreated += 1;
        }
        c.init(id, template, pos);
        return c;
    }

    release(creature) {
        if (!creature || creature._pooled) return false;
        if (this.pool.length < this.capacity) {
            if (typeof creature.reset === 'function') {
                creature.reset();
            } else {
                creature._pooled = true;
            }
            this.pool.push(creature);
            this.totalReleased += 1;
            return true;
        }
        return false;
    }

    preallocate(count) {
        const target = Math.min(this.capacity, Math.max(0, count | 0));
        while (this.pool.length < target) {
            this.pool.push(new Creature());
            this.totalCreated += 1;
        }
        return this.pool.length;
    }

    clear() {
        this.pool.length = 0;
    }
}

function createCreature(id, template, pos) {
    const c = new Creature();
    c.init(id, template, pos);
    return c;
}

function createCorpse(id, creature, items, tickIndex) {
    return {
        id: id | 0,
        type: 'corpse',
        name: creature.name,
        kind: creature.kind,
        x: creature.x | 0,
        y: creature.y | 0,
        z: creature.z | 0,
        items: items.slice(),
        bornTick: tickIndex | 0
    };
}

module.exports = {
    dirFromDelta,
    greedyOrthogonal,
    DEFAULT_FLEE_STAND_DIST,
    isCreatureFleeing,
    creatureFleeStandDistance,
    creatureStandDistance,
    creatureLoseTargetDistance,
    Creature,
    CreaturePool,
    createCreature,
    createCorpse
};

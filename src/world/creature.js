'use strict';

const { DIR } = require('../protocol/opcodes');

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

function createCreature(id, template, pos) {
    const flags = template.flags || {};
    const isNpc = !!template.isNpc;
    const speed = template.speed != null ? Number(template.speed) : 100;
    return {
        id: id | 0,
        type: isNpc ? 'npc' : 'creature',
        isNpc,
        attackableNpc: !!template.attackableNpc,
        kind: template.id,
        name: template.label,
        x: pos.x | 0,
        y: pos.y | 0,
        z: pos.z | 0,
        spawnX: pos.x | 0,
        spawnY: pos.y | 0,
        spawnZ: pos.z | 0,
        dir: 0,
        hp: template.hp | 0,
        hpMax: template.hpMax | 0,
        mp: 0,
        mpMax: 0,
        armor: template.armor,
        mitigation: template.mitigation,
        maxBlock: template.maxBlock || 0,
        canBlock: !!template.canBlock,
        resists: template.resists || { physical: 0 },
        critChance: Math.max(0, Number(template.critChance) || 0),
        critDamage: Math.max(0, Number(template.critDamage) || 0),
        exp: template.exp | 0,
        speed: Number.isFinite(speed) ? speed : 100,
        pushable: flags.pushable !== false,
        canPushCreatures: flags.canPushCreatures === true,
        flags,
        aggro: template.aggro !== false,
        attacks: template.attacks || [],
        loot: template.loot || [],
        dialog: template.dialog || null,
        shop: template.shop || null,
        aggroRange: flags.aggroRange == null ? 7 : flags.aggroRange | 0,
        loseTargetDistance: flags.loseTargetDistance == null ? 12 : flags.loseTargetDistance | 0,
        targetId: 0,
        path: [],
        moveReadyTick: 0,
        attackReadyTick: 0,
        simSleeping: false
    };
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
    createCreature,
    createCorpse
};

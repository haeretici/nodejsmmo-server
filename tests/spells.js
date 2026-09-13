'use strict';

const assert = require('assert');
const {
    computeMeleeStrikeRange,
    computeMagicStrikeRange,
    resolveSpellHit,
    applyMitigation
} = require('../src/world/combat');
const { applyCondition, tickConditions, FIELD_BURNING, FIELD_POISONED } = require('../src/world/conditions');
const {
    createFieldStore,
    deployFieldToTile,
    applyFieldEntryEffects,
    getFieldOnTile
} = require('../src/world/fields');
const { canCast, resolveCast, indexSpellBook } = require('../src/world/spells');
const Cooldowns = require('../src/world/cooldowns');
const { TILE_FLAG_NO_CAST } = require('../src/world/tilemap');

function dummyDef() {
    return { type: 'creature', armor: 0, mitigation: 0, resists: { physical: 0, fire: 0, earth: 0, energy: 0 }, hp: 100, hpMax: 100 };
}

function main() {
    const snapRange = computeMeleeStrikeRange(
        { type: 'player', level: 1, atk: 7, skills: { fist: 10 }, weaponSkill: 'fist' },
        12,
        0.1726
    );
    assert.strictEqual(snapRange.min, 3);
    assert.strictEqual(snapRange.max, 4);

    const mystic = {
        type: 'player',
        level: 1,
        atk: 7,
        weaponSkill: 'fist',
        skills: { fist: 10, magic: 0 },
        critChance: 5,
        critDamage: 10,
        weaponTier: 0
    };
    const dummy = dummyDef();
    const snap = {
        id: 'snap_jab',
        kind: 'strike',
        element: 'physical',
        powerCurve: 'melee_strike',
        basePower: 12,
        damageAmplitude: 0.1726,
        hitChance: 100,
        isMelee: true
    };
    const hit = resolveSpellHit(mystic, dummy, snap, () => 0.5);
    assert.strictEqual(hit.miss, false);
    assert.strictEqual(hit.raw, 4);
    assert.strictEqual(hit.final, 4);
    assert.strictEqual(hit.critical, false);

    const boltRange = computeMagicStrikeRange({ level: 15, skills: { magic: 0 } }, 9, 0.1462);
    assert.strictEqual(boltRange.min, 5);
    assert.strictEqual(boltRange.max, 6);

    const fire = applyMitigation(20, 'fire', dummy);
    assert.strictEqual(fire.final, 20);
    const poison = applyMitigation(5, 'earth', dummy);
    assert.strictEqual(poison.final, 5);

    const burned = dummyDef();
    applyCondition(burned, FIELD_BURNING, { forceOverride: true });
    assert.ok(burned.conditions.some((c) => c.kind === 'fire'));
    tickConditions(burned, 9);
    assert.ok((burned.hp | 0) < 100);

    const poisoned = dummyDef();
    applyCondition(poisoned, FIELD_POISONED, { forceOverride: true });
    tickConditions(poisoned, 2);
    assert.ok((poisoned.hp | 0) < 100);

    const store = createFieldStore(null);
    const field = deployFieldToTile(store, 1, 1, 0, { kind: 'fire', source: 'scenario', createdAt: 0 });
    assert.ok(field);
    assert.strictEqual(getFieldOnTile(store, 1, 1, 0).fieldKind, 'fire');
    const walker = dummyDef();
    walker.alive = true;
    const entry = applyFieldEntryEffects(walker, field, 0);
    assert.strictEqual(entry.applied, true);
    assert.strictEqual(entry.damage, 20);
    assert.strictEqual(entry.condition, 'fire');

    const caster = {
        type: 'player',
        id: 1,
        x: 0,
        y: 0,
        z: 0,
        hp: 185,
        hpMax: 185,
        mp: 90,
        mpMax: 90,
        level: 1,
        vocation: 'mystic',
        knownSpells: ['snap_jab'],
        skills: { fist: 10, magic: 0 },
        atk: 7,
        weaponSkill: 'fist',
        moveReadyTick: 0
    };
    Cooldowns.ensureCooldowns(caster);
    const book = indexSpellBook({
        spells: [Object.assign({}, snap, { mana: 3, vocations: ['mystic'], cooldowns: { primary: { attack: 2 } } })]
    });
    const spell = book.byId.snap_jab;
    const ok = canCast(caster, spell, { tickIndex: 0 });
    assert.strictEqual(ok.ok, true);

    const pzMap = {
        blocksCast(x, y, z) { return (this.flags & TILE_FLAG_NO_CAST) !== 0; },
        flags: TILE_FLAG_NO_CAST
    };
    const blocked = canCast(caster, spell, { tickIndex: 0, tileMap: pzMap });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.reason, 'no_cast');

    const target = Object.assign(dummyDef(), { id: 2, x: 0, y: 1, z: 0, type: 'creature' });
    const cast = resolveCast({
        attacker: caster,
        spell,
        target,
        rng: () => 0.5,
        tickIndex: 0,
        skipMoveLock: true
    });
    assert.strictEqual(cast.ok, true);
    assert.strictEqual(cast.hits.length, 1);
    assert.strictEqual(cast.hits[0].result.final, 4);
    assert.strictEqual(caster.mp, 87);
    assert.ok(!Cooldowns.canUse(caster, spell.cooldowns));

    console.log('ok spells');
}

main();

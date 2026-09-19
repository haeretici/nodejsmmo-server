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
const { canCast, resolveCast, indexSpellBook, isSelfTargetSpell } = require('../src/world/spells');
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

    const patch = {
        id: 'magic_patch',
        kind: 'heal',
        element: 'healing',
        powerCurve: 'magic_strike',
        basePower: 20,
        range: 1,
        mana: 6,
        hitChance: 100,
        requiresTarget: false,
        selfTarget: true,
        vocations: ['mystic'],
        level: 1,
        damageAmplitude: 0.1702,
        cooldowns: { primary: { healing: 1 } }
    };
    const healer = Object.assign({}, caster, {
        knownSpells: ['magic_patch'],
        hp: 50,
        mp: 90,
        cooldowns: null
    });
    Cooldowns.ensureCooldowns(healer);
    assert.strictEqual(isSelfTargetSpell(patch), true);
    assert.strictEqual(isSelfTargetSpell({ id: 'heal_light', kind: 'heal', requiresTarget: false }), true);
    assert.strictEqual(isSelfTargetSpell({ id: 'heal_friend', kind: 'heal', requiresTarget: true }), false);
    assert.strictEqual(isSelfTargetSpell({
        id: 'mass_heal', kind: 'heal', requiresTarget: false, shape: { type: 'area', code: 5 }
    }), false);
    const pzHeal = canCast(healer, patch, { tickIndex: 0, tileMap: pzMap });
    assert.strictEqual(pzHeal.ok, true, 'heal allowed on caster PZ');

    const other = Object.assign(dummyDef(), { id: 2, x: 0, y: 1, z: 0, type: 'creature', hp: 10, hpMax: 100 });
    const selfHeal = resolveCast({
        attacker: healer,
        spell: patch,
        target: other,
        aim: { x: other.x, y: other.y, z: other.z },
        rng: () => 0.5,
        tickIndex: 0,
        skipMoveLock: true
    });
    assert.strictEqual(selfHeal.ok, true);
    assert.strictEqual(selfHeal.hits.length, 1);
    assert.strictEqual(selfHeal.hits[0].defender, healer);
    assert.ok(selfHeal.hits[0].result.final > 0);
    assert.strictEqual(other.hp, 10);

    const friend = Object.assign({}, patch, {
        id: 'heal_friend',
        requiresTarget: true,
        selfTarget: false,
        allowOnSelf: false,
        mana: 12
    });
    const friendCaster = Object.assign({}, caster, {
        knownSpells: ['heal_friend'],
        hp: 50,
        mp: 90,
        cooldowns: null
    });
    Cooldowns.ensureCooldowns(friendCaster);
    const friendOther = Object.assign(dummyDef(), { id: 3, x: 0, y: 1, z: 0, type: 'creature', hp: 10, hpMax: 100 });
    const onOther = resolveCast({
        attacker: friendCaster,
        spell: friend,
        target: friendOther,
        rng: () => 0.5,
        tickIndex: 0,
        skipMoveLock: true
    });
    assert.strictEqual(onOther.ok, true);
    assert.strictEqual(onOther.hits[0].defender, friendOther);

    const selfCaster = Object.assign({}, friendCaster, { cooldowns: null, mp: 90 });
    Cooldowns.ensureCooldowns(selfCaster);
    const onSelf = resolveCast({
        attacker: selfCaster,
        spell: friend,
        target: selfCaster,
        rng: () => 0.5,
        tickIndex: 0,
        skipMoveLock: true
    });
    assert.strictEqual(onSelf.ok, false);
    assert.strictEqual(onSelf.reason, 'no_target');

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
    assert.ok(!Cooldowns.canUse(caster, spell.cooldowns));
    assert.strictEqual(Cooldowns.canUse(caster, spell.cooldowns, 0), false);
    assert.strictEqual(Cooldowns.canUse(caster, spell.cooldowns, 39), false);
    assert.strictEqual(Cooldowns.canUse(caster, spell.cooldowns, 40), true);
    assert.strictEqual(Cooldowns.getRemaining(caster, 'primary', 'attack', 40), 0);

    const viaNow = canCast(caster, spell, { now: 2.0 });
    assert.strictEqual(viaNow.ok, false);
    assert.strictEqual(viaNow.reason, 'cooldown');
    assert.strictEqual(canCast(caster, spell, { tickIndex: 40 }).ok, true);

    // Verify exact discrete tick expiration without float drift (0.10s = 2 ticks)
    const shortSpell = Object.assign({}, spell, { cooldowns: { primary: { attack: 0.10 } } });
    Cooldowns.apply(caster, shortSpell.cooldowns, 10);
    assert.strictEqual(Cooldowns.canUse(caster, shortSpell.cooldowns, 11), false);
    assert.strictEqual(Cooldowns.canUse(caster, shortSpell.cooldowns, 12), true);

    const casterUps = Object.assign({}, caster, { cooldowns: null, mp: 90 });
    Cooldowns.ensureCooldowns(casterUps);
    const shortUps = Object.assign({}, spell, { cooldowns: { primary: { attack: 0.10 } } });
    resolveCast({
        attacker: casterUps,
        spell: shortUps,
        target,
        rng: () => 0.5,
        tickIndex: 1,
        logicUps: 10,
        skipMoveLock: true
    });
    assert.strictEqual(Cooldowns.canUse(casterUps, shortUps.cooldowns, 1), false);
    assert.strictEqual(Cooldowns.canUse(casterUps, shortUps.cooldowns, 2), true);

    console.log('ok spells');
}

main();

'use strict';

const assert = require('assert');
const {
    getExpForLevel,
    expToNext,
    levelFromExp,
    getReqSkillTries,
    totalSkillTries,
    getReqMana,
    totalManaForMagicLevel,
    partyShareMultiplier,
    partySharePerMember,
    applyPersonalExpRates,
    applyExpProgression,
    applySkillTries,
    applyManaTowardMagic,
    classifyAttackBlockType,
    processAttackSkillProgression,
    resolveWeaponSkillBag,
    SKILL_FLOOR,
    poolMaxForLevel,
    applyLevelPoolDelta
} = require('../src/world/progression');

function main() {
    assert.strictEqual(getExpForLevel(1), 0);
    assert.strictEqual(getExpForLevel(2), 100);
    assert.strictEqual(getExpForLevel(50), 1847300);
    assert.strictEqual(expToNext(50), 117700);
    assert.strictEqual(getExpForLevel(51) - getExpForLevel(50), expToNext(50));
    assert.strictEqual(levelFromExp(0), 1);
    assert.strictEqual(levelFromExp(99), 1);
    assert.strictEqual(levelFromExp(100), 2);
    assert.strictEqual(levelFromExp(1847300), 50);
    assert.strictEqual(levelFromExp(1847299), 49);
    assert.strictEqual(levelFromExp(1847300 + 117700), 51);

    const guardian = { melee: 1.1, fist: 1.1, distance: 1.4, shielding: 1.1, magic: 3.0 };
    assert.strictEqual(totalSkillTries('melee', 50, guardian), 22129);
    assert.strictEqual(totalSkillTries('sword', 50, guardian), 22129);
    assert.strictEqual(getReqSkillTries('melee', 10, guardian), 0);
    assert.strictEqual(getReqSkillTries('melee', 11, guardian), 50);

    const adeptMagic = { magic: 1.1 };
    assert.strictEqual(getReqMana(1, adeptMagic), 1600);
    assert.strictEqual(getReqMana(2, adeptMagic), Math.floor(1600 * 1.1));
    assert.strictEqual(totalManaForMagicLevel(50, adeptMagic), 1862225);

    const mystic = { melee: 1.4, shielding: 1.15, magic: 1.25 };
    assert.ok(totalSkillTries('melee', 50, mystic) < totalSkillTries('melee', 50, { melee: 1.5 }));

    assert.strictEqual(partyShareMultiplier(1, 2), 1.2);
    assert.ok(Math.abs(partyShareMultiplier(1, 4) - 1.1) < 1e-9);
    assert.strictEqual(partyShareMultiplier(2, 2), 1.3);
    const solo = partySharePerMember(5, { partySize: 1 });
    assert.strictEqual(solo.personalRaw, 5);
    assert.strictEqual(applyPersonalExpRates(5, null), 5);

    const p = {
        type: 'player',
        level: 1,
        experience: 0,
        skills: { fist: 10, club: 10, sword: 10, axe: 10, distance: 10, shielding: 10, magic: 0, fishing: 10 },
        skillRates: guardian
    };
    const prog = applyExpProgression(p, 100);
    assert.strictEqual(prog.levelUps, 1);
    assert.strictEqual(p.level, 2);
    assert.strictEqual(p.experience, 100);

    const hp1to8 = [150, 155, 160, 165, 170, 175, 180, 185];
    const mp1to8 = [55, 60, 65, 70, 75, 80, 85, 90];
    const classes = [
        { id: 'guardian', baseHp: 185, baseMp: 90, hpPerLevel: 15, mpPerLevel: 5 },
        { id: 'scout', baseHp: 185, baseMp: 90, hpPerLevel: 10, mpPerLevel: 15 },
        { id: 'mystic', baseHp: 185, baseMp: 90, hpPerLevel: 10, mpPerLevel: 10 },
        { id: 'adept', baseHp: 185, baseMp: 90, hpPerLevel: 5, mpPerLevel: 30 },
        { id: 'warden', baseHp: 185, baseMp: 90, hpPerLevel: 5, mpPerLevel: 30 },
        { id: 'adventurer', baseHp: 185, baseMp: 90, hpPerLevel: 5, mpPerLevel: 5 }
    ];
    const l9 = {
        guardian: { hp: 200, mp: 95 },
        scout: { hp: 195, mp: 105 },
        mystic: { hp: 195, mp: 100 },
        adept: { hp: 190, mp: 120 },
        warden: { hp: 190, mp: 120 },
        adventurer: { hp: 190, mp: 95 }
    };
    for (let i = 0; i < classes.length; i++) {
        const cls = classes[i];
        for (let lv = 1; lv <= 8; lv++) {
            const pooled = poolMaxForLevel(lv, cls);
            assert.strictEqual(pooled.hpMax, hp1to8[lv - 1], cls.id + ' L' + lv + ' hp');
            assert.strictEqual(pooled.mpMax, mp1to8[lv - 1], cls.id + ' L' + lv + ' mp');
        }
        const at9 = poolMaxForLevel(9, cls);
        assert.strictEqual(at9.hpMax, l9[cls.id].hp, cls.id + ' L9 hp');
        assert.strictEqual(at9.mpMax, l9[cls.id].mp, cls.id + ' L9 mp');
    }
    const l1 = { hp: 50, hpMax: 150, mp: 10, mpMax: 55 };
    assert.strictEqual(applyLevelPoolDelta(l1, 1, 2, classes[1]), true);
    assert.strictEqual(l1.hpMax, 155);
    assert.strictEqual(l1.mpMax, 60);
    assert.strictEqual(l1.hp, 55, 'wounded L1→L2 heals the +5 gain');
    assert.strictEqual(l1.mp, 15);
    const jump = { hp: 150, hpMax: 150, mp: 55, mpMax: 55 };
    assert.strictEqual(applyLevelPoolDelta(jump, 1, 9, classes[0]), true);
    assert.strictEqual(jump.hpMax, 200);
    assert.strictEqual(jump.mpMax, 95);
    assert.strictEqual(jump.hp, 200);
    const wrongSeed = { hp: 185, hpMax: 185, mp: 90, mpMax: 90 };
    assert.strictEqual(applyLevelPoolDelta(wrongSeed, 1, 2, classes[0]), true);
    assert.strictEqual(wrongSeed.hpMax, 155);
    assert.strictEqual(wrongSeed.hp, 155, 'wrong L1 185 seed clamps on first level-up');

    const fist = applySkillTries(p, 'fist', 50, { skillProgression: true, vocationRates: guardian });
    assert.strictEqual(fist.levelsGained, 1);
    assert.strictEqual(p.skills.fist, 11);
    assert.strictEqual(SKILL_FLOOR, 10);

    const blocked = applySkillTries({
        type: 'player',
        skills: { fist: 10 }
    }, 'fist', 50, { skillProgression: false, vocationRates: guardian });
    assert.strictEqual(blocked.levelsGained, 0);

    const ml = applyManaTowardMagic({
        type: 'player',
        skills: { magic: 0 },
        skillRates: adeptMagic
    }, 1600, { skillProgression: true, vocationRates: adeptMagic });
    assert.strictEqual(ml.levelsGained, 1);
    assert.strictEqual(ml.newLevel, 1);

    assert.strictEqual(classifyAttackBlockType({ miss: true }), 'miss');
    assert.strictEqual(classifyAttackBlockType({ hit: true, final: 4 }), 'none');
    assert.strictEqual(classifyAttackBlockType({ hit: true, final: 0, shieldBlock: 3 }), 'defense');
    assert.strictEqual(classifyAttackBlockType({ hit: true, final: 0, armorReduction: 2 }), 'armor');
    assert.strictEqual(classifyAttackBlockType({ hit: true, final: 0 }), 'immunity');

    const attacker = {
        type: 'player',
        weaponSkill: 'fist',
        skills: { fist: 10 },
        skillRates: guardian
    };
    const blood = processAttackSkillProgression(
        attacker,
        { type: 'creature' },
        { hit: true, miss: false, final: 4 },
        { skillProgression: true, vocationRates: guardian }
    );
    assert.strictEqual(blood.weaponTries, 1);
    assert.strictEqual(blood.weaponAdvance.rawTries, 1);
    assert.strictEqual(attacker.bloodHitCount, 30);

    const wand = { type: 'player', weaponSkill: 'magic', skills: { fist: 10, magic: 0 } };
    assert.strictEqual(resolveWeaponSkillBag(wand), null);
    const noWand = processAttackSkillProgression(
        wand,
        { type: 'creature' },
        { hit: true, miss: false, final: 4 },
        { skillProgression: true }
    );
    assert.strictEqual(noWand.weaponTries, 0);

    const archer = {
        type: 'player',
        weaponSkill: 'distance',
        skills: { distance: 10 },
        skillRates: { distance: 1.1 }
    };
    const dist = processAttackSkillProgression(
        archer,
        { type: 'creature' },
        { hit: true, miss: false, final: 5 },
        { skillProgression: true, vocationRates: { distance: 1.1 } }
    );
    assert.strictEqual(dist.weaponTries, 2);

    const tank = {
        type: 'player',
        canBlock: true,
        maxBlock: 10,
        skills: { shielding: 10 },
        skillRates: guardian,
        shieldBlockCount: 30
    };
    const block = processAttackSkillProgression(
        { type: 'creature' },
        tank,
        { hit: true, miss: false, final: 0, shieldBlock: 8 },
        { skillProgression: true, blockChargeSpent: true, defenderVocationRates: guardian }
    );
    assert.strictEqual(block.shieldTries, 1);
    assert.strictEqual(block.shieldAdvance.rawTries, 1);

    console.log('ok progression');
}

main();

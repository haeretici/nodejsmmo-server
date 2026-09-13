'use strict';

const assert = require('assert');
const { MemoryStore } = require('../src/persist/memory_store');
const { DuplicateError } = require('../src/persist/errors');
const { randomToken, hashToken } = require('../src/security/token');

async function main() {
    const store = new MemoryStore();
    const a = await store.createAccount({ email: 'a@example.com', passwordHash: 'phc' });
    assert.strictEqual(a.email, 'a@example.com');
    await assert.rejects(
        () => store.createAccount({ email: 'A@example.com', passwordHash: 'x' }),
        DuplicateError
    );

    const ch = await store.createCharacter({
        accountId: a.id,
        name: 'Hero',
        vocation: 'scout',
        level: 1,
        experience: 0,
        posX: 0, posY: 0, posZ: 0,
        hp: 185, hpMax: 185, mp: 90, mpMax: 90,
        townId: 1,
        skills: { fist: 10, club: 10, sword: 10, axe: 10, distance: 10, shielding: 10, magic: 0, fishing: 10 }
    });
    assert.strictEqual(ch.name, 'Hero');
    await assert.rejects(
        () => store.createCharacter({
            accountId: a.id, name: 'hero', vocation: 'scout',
            level: 1, experience: 0, posX: 0, posY: 0, posZ: 0,
            hp: 1, hpMax: 1, mp: 1, mpMax: 1, townId: 1, skills: {}
        }),
        DuplicateError
    );
    assert.strictEqual(await store.countCharacters(a.id), 1);

    const raw = randomToken();
    await store.createPlayToken({
        tokenHash: hashToken(raw),
        accountId: a.id,
        characterId: ch.id,
        ip: '127.0.0.1',
        expiresAt: new Date(Date.now() + 45000)
    });
    const found = await store.findPlayToken(hashToken(raw));
    assert.strictEqual(found.characterId, ch.id);
    await store.markPlayTokenUsed(hashToken(raw), new Date());
    const used = await store.findPlayToken(hashToken(raw));
    assert.ok(used.usedAt);

    const raw2 = randomToken();
    await store.createPlayToken({
        tokenHash: hashToken(raw2),
        accountId: a.id,
        characterId: ch.id,
        ip: '127.0.0.1',
        expiresAt: new Date(Date.now() + 45000)
    });
    const consumed = await store.consumePlayToken(hashToken(raw2), Date.now());
    assert.strictEqual(consumed.characterId, ch.id);
    assert.strictEqual(await store.consumePlayToken(hashToken(raw2), Date.now()), null);

    const raw3 = randomToken();
    await store.createPlayToken({
        tokenHash: hashToken(raw3),
        accountId: a.id,
        characterId: ch.id,
        ip: '127.0.0.1',
        expiresAt: new Date(Date.now() - 1000)
    });
    assert.strictEqual(await store.consumePlayToken(hashToken(raw3), Date.now()), null);

    await store.touchCharacterLogin(ch.id, new Date());
    await store.touchCharacterLogout(ch.id, new Date());
    const after = await store.findCharacter(a.id, ch.id);
    assert.ok(after.lastLogin);
    assert.ok(after.lastLogout);

    await store.saveCharacter(ch.id, {
        level: 1,
        experience: 15,
        posX: 12,
        posY: 10,
        posZ: 0,
        hp: 100,
        hpMax: 185,
        mp: 90,
        mpMax: 90,
        inventory: { items: [{ id: 'gold_coin', count: 3 }] },
        storage: { 'guide.mission': 1 },
        conditions: [],
        hotkeys: {},
        appearance: {},
        skills: { fist: 10, club: 10, sword: 10, axe: 10, distance: 10, shielding: 10, magic: 0, fishing: 10 },
        lastLogout: new Date()
    });
    const loaded = await store.findCharacter(a.id, ch.id);
    assert.strictEqual(loaded.experience, 15);
    assert.strictEqual(loaded.posY, 10);
    assert.strictEqual(loaded.hp, 100);
    const state = await store.loadCharacterState(ch.id);
    assert.strictEqual(state.inventory.items[0].count, 3);
    assert.strictEqual(state.storage['guide.mission'], 1);
    const skills = await store.loadSkills(ch.id);
    assert.strictEqual(skills.fist, 10);
    assert.strictEqual(await store.saveCharacter(9999, { hp: 1 }), false);

    console.log('ok memory_store');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

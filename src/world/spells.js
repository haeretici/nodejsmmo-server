'use strict';

/** Product spell book + CAST resolve. No kernel require. */

const Cooldowns = require('./cooldowns');
const {
    chebyshev,
    resolveSpellHit
} = require('./combat');
const {
    applyCondition,
    conditionDefFromSpell,
    removeConditions,
    isCannotAttack,
    isCombatantAlive,
    isInvisible
} = require('./conditions');
const {
    getAffectedTiles,
    cardinalDirection,
    octantDirection,
    hasLineOfSight,
    spellTypeFromShape
} = require('./shapes');
const {
    getFieldKind,
    deployFieldAndTriggerOccupants,
    removeFieldFromTile,
    getFieldOnTile
} = require('./fields');

const FAR_USE_RANGE_X = 7;
const FAR_USE_RANGE_Y = 7;
const SPELL_MOVE_LOCK_DEFAULT = 0.05;
const DEFAULT_CHAIN_DISTANCE = 3;

function indexSpellBook(doc) {
    const out = Object.create(null);
    const byRune = Object.create(null);
    if (!doc) return { byId: out, byRune };
    const list = Array.isArray(doc.spells) ? doc.spells
        : Array.isArray(doc) ? doc
            : Object.keys(doc).map((k) => doc[k]);
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s || s.id == null) continue;
        const id = String(s.id);
        out[id] = s;
        const runeId = s.runeItemId != null ? String(s.runeItemId) : '';
        if (runeId) byRune[runeId] = s;
    }
    return { byId: out, byRune };
}

function findSpell(book, id) {
    if (!book || id == null) return null;
    const key = String(id);
    if (book.byId && book.byId[key]) return book.byId[key];
    if (book[key] && book[key].id) return book[key];
    return null;
}

function findSpellByRuneItem(book, itemId) {
    if (!book || !itemId) return null;
    const key = String(itemId);
    if (book.byRune && book.byRune[key]) return book.byRune[key];
    return null;
}

function isRuneSpell(spell) {
    if (!spell) return false;
    if (spell.source === 'rune') return true;
    return !!(spell.runeItemId || spell.rune);
}

function isAutoAttackId(id) {
    const s = String(id || '');
    return s === 'melee_auto' || s === 'distance_auto' || s === 'wand_auto' || s === 'auto';
}

function spellHasShape(spell) {
    if (!spell || !spell.shape || typeof spell.shape !== 'object') return false;
    const t = String(spell.shape.type || '');
    return t === 'area' || t === 'wave' || t === 'beam';
}

function isSelfCenteredAreaSpell(spell) {
    if (!spellHasShape(spell)) return false;
    const t = String(spell.shape.type || '');
    if (t !== 'area') return false;
    const range = spell.range != null ? Number(spell.range) : 1;
    const isMelee = spell.isMelee === true
        || (spell.isMelee == null && (spell.kind === 'auto'
            || spell.powerCurve === 'melee_auto'
            || spell.powerCurve === 'melee_strike'
            || range <= 1));
    return isMelee || range <= 1;
}

function isHarmfulSpell(spell) {
    if (!spell) return false;
    const kind = String(spell.kind || '');
    if (kind === 'heal' || kind === 'support') return false;
    if (spell.element === 'healing') return false;
    if (spell.statusOnly && kind !== 'auto' && kind !== 'strike') {
        const cd = spell.cooldowns && spell.cooldowns.primary;
        if (cd && cd.support != null && cd.attack == null) return false;
        if (spell.dispel || spell.destroysField) return false;
        if (spell.deploysField || spell.field) return true;
    }
    return true;
}

function isWithinSpellCastRange(from, to, spell, range) {
    if (!from || !to) return false;
    if (from.z != null && to.z != null && (from.z | 0) !== (to.z | 0)) return false;
    const dx = Math.abs((from.x | 0) - (to.x | 0));
    const dy = Math.abs((from.y | 0) - (to.y | 0));
    if (spell && spell.allowFarUse === true) {
        if (dx > FAR_USE_RANGE_X || dy > FAR_USE_RANGE_Y) return false;
    }
    let r = range;
    if (r == null || !Number.isFinite(r)) {
        r = spell && spell.range != null ? Number(spell.range) : 1;
    }
    if (!Number.isFinite(r)) r = 1;
    return Math.max(dx, dy) <= r;
}

function canUseSpell(attacker, spell) {
    if (!attacker || !spell) return false;
    const sid = spell.id != null ? String(spell.id) : '';
    if (sid && isAutoAttackId(sid)) return true;
    const known = attacker.knownSpells;
    if (Array.isArray(known) && known.length) {
        return !!(sid && known.indexOf(sid) >= 0);
    }
    const allowed = Array.isArray(spell.vocations) ? spell.vocations : null;
    if (allowed && allowed.length) {
        const classId = attacker.vocation
            || (attacker.character && attacker.character.vocation)
            || attacker.classId
            || '';
        if (!classId) return true;
        return allowed.indexOf(String(classId)) >= 0;
    }
    return true;
}

function meetsSpellLevel(attacker, spell) {
    if (!spell || spell.level == null) return true;
    const need = Number(spell.level);
    if (!(need > 0)) return true;
    const have = Number(attacker && attacker.level != null ? attacker.level : 1);
    return have >= need;
}

function meetsSpellMagicLevel(attacker, spell) {
    if (!spell || spell.magicLevel == null) return true;
    const need = Number(spell.magicLevel);
    if (!(need > 0)) return true;
    const have = attacker && attacker.skills && attacker.skills.magic != null
        ? Number(attacker.skills.magic) || 0
        : 0;
    return have >= need;
}

function hasMana(attacker, cost) {
    const n = Math.max(0, Math.floor(Number(cost) || 0));
    if (n <= 0) return true;
    if (!attacker) return false;
    return (attacker.mp | 0) >= n;
}

function spendMana(attacker, cost) {
    const n = Math.max(0, Math.floor(Number(cost) || 0));
    if (n <= 0) return 0;
    const have = attacker.mp | 0;
    const take = Math.min(have, n);
    attacker.mp = have - take;
    if (attacker.character) attacker.character.mp = attacker.mp;
    return take;
}

function resolveMoveLock(spell) {
    if (spell && spell.moveLock != null && Number.isFinite(Number(spell.moveLock))) {
        return Math.max(0, Number(spell.moveLock));
    }
    return SPELL_MOVE_LOCK_DEFAULT;
}

function posOf(entity) {
    if (!entity) return null;
    return { x: entity.x | 0, y: entity.y | 0, z: entity.z | 0 };
}

function canCastPlayerAreaOnTile(attacker, tileMap) {
    if (!attacker || attacker.type !== 'player') return true;
    if (!tileMap) return true;
    if (typeof tileMap.getFirstOccupant !== 'function') return true;
    const first = tileMap.getFirstOccupant(attacker.x, attacker.y, attacker.z) | 0;
    if (first === 0) return true;
    return (attacker.id | 0) !== 0 && first === (attacker.id | 0);
}

function canCast(attacker, spell, ctx) {
    const c = ctx || {};
    if (!attacker || !spell) return { ok: false, reason: 'unknown_spell' };
    if (!isCombatantAlive(attacker)) return { ok: false, reason: 'missing_combatant' };
    if (isAutoAttackId(spell.id)) return { ok: false, reason: 'unknown_spell' };
    if (!canUseSpell(attacker, spell)) return { ok: false, reason: 'unknown_spell' };
    if (!meetsSpellLevel(attacker, spell)) return { ok: false, reason: 'level' };
    if (!meetsSpellMagicLevel(attacker, spell)) return { ok: false, reason: 'magic_level' };
    if ((attacker.moveReadyTick | 0) > (c.tickIndex | 0) && !c.skipMoveLock) {
        return { ok: false, reason: 'busy' };
    }
    if (isCannotAttack(attacker) && isHarmfulSpell(spell)) {
        return { ok: false, reason: 'pacified' };
    }
    const tileMap = c.tileMap || null;
    if (tileMap && typeof tileMap.blocksCast === 'function'
        && tileMap.blocksCast(attacker.x, attacker.y, attacker.z)) {
        return { ok: false, reason: 'no_cast' };
    }
    Cooldowns.ensureCooldowns(attacker);
    if (!c.skipCooldown && !Cooldowns.canUse(attacker, spell.cooldowns)) {
        return { ok: false, reason: 'cooldown' };
    }
    if (!c.skipMana && !hasMana(attacker, spell.mana || 0)) {
        return { ok: false, reason: 'mana' };
    }
    if (isRuneSpell(spell) && c.runeConsumption && typeof c.hasRune === 'function') {
        if (!c.hasRune(attacker, spell)) return { ok: false, reason: 'no_rune' };
    }
    if (spellHasShape(spell) && !canCastPlayerAreaOnTile(attacker, tileMap)) {
        return { ok: false, reason: 'not_tile_controller' };
    }
    return { ok: true };
}

function resolveAreaCenter(attacker, spell, primary, aim) {
    const range = spell.range != null ? Number(spell.range) : 1;
    if (isSelfCenteredAreaSpell(spell) || (spell.isMelee && range <= 1)) {
        return posOf(attacker);
    }
    if (aim && aim.x != null) return { x: aim.x | 0, y: aim.y | 0, z: aim.z != null ? aim.z | 0 : attacker.z | 0 };
    if (primary) return posOf(primary);
    return posOf(attacker);
}

function normalizeChainSpec(spell) {
    if (!spell || spell.chain == null) return null;
    const c = spell.chain;
    if (typeof c === 'number' && Number.isFinite(c)) {
        return { maxTargets: Math.max(1, Math.floor(c)), distance: DEFAULT_CHAIN_DISTANCE };
    }
    if (typeof c === 'object') {
        const raw = c.maxTargets != null ? c.maxTargets : c.targets != null ? c.targets : c.max;
        if (raw == null || !Number.isFinite(Number(raw))) return null;
        const distance = c.distance != null && Number.isFinite(Number(c.distance))
            ? Math.max(1, Math.floor(Number(c.distance)))
            : DEFAULT_CHAIN_DISTANCE;
        return { maxTargets: Math.max(1, Math.floor(Number(raw))), distance };
    }
    return null;
}

function pickChainTargets(attacker, primary, spec, candidates, tileMap) {
    const out = [];
    if (primary && primary !== attacker) out.push(primary);
    const pool = Array.isArray(candidates) ? candidates : [];
    const visited = new Set(out.map((e) => e.id));
    let cursor = primary || attacker;
    while (out.length < spec.maxTargets) {
        let best = null;
        let bestD = Infinity;
        for (let i = 0; i < pool.length; i++) {
            const e = pool[i];
            if (!e || e === attacker || visited.has(e.id)) continue;
            if (!isCombatantAlive(e)) continue;
            if ((e.z | 0) !== (cursor.z | 0)) continue;
            const d = chebyshev(cursor.x, cursor.y, e.x, e.y);
            if (d > spec.distance || d <= 0) continue;
            if (tileMap && !hasLineOfSight(cursor.x, cursor.y, cursor.z, e.x, e.y, e.z, tileMap)) {
                continue;
            }
            if (d < bestD) {
                best = e;
                bestD = d;
            }
        }
        if (!best) break;
        visited.add(best.id);
        out.push(best);
        cursor = best;
    }
    return out;
}

function defendersOnTiles(attacker, spell, tiles, tileMap, primary) {
    const z = tiles[0] ? tiles[0].z : attacker.z;
    const playerCast = attacker.type === 'player';
    const fieldish = !!(spell.deploysField || spell.field || spell.destroysField);
    const seen = new Set();
    const out = [];
    function push(ent) {
        if (!ent || seen.has(ent.id)) return;
        if (!isCombatantAlive(ent)) return;
        seen.add(ent.id);
        out.push(ent);
    }
    if (!spellHasShape(spell) && primary) {
        push(primary);
        return out;
    }
    for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        const ents = tileMap && typeof tileMap.getCombatantEntities === 'function'
            ? tileMap.getCombatantEntities(t.x, t.y, t.z != null ? t.z : z)
            : [];
        if (fieldish) {
            for (let k = 0; k < ents.length; k++) push(ents[k]);
            continue;
        }
        if (playerCast) {
            const first = ents[0];
            if (first && first !== attacker) push(first);
        } else {
            for (let k = 0; k < ents.length; k++) {
                if (ents[k] && ents[k].type === 'player') push(ents[k]);
            }
        }
    }
    return out;
}

function applySpellSideEffects(spell, attacker, defender) {
    if (!spell || !defender) return;
    if (Array.isArray(spell.dispel) && spell.dispel.length) {
        removeConditions(defender, spell.dispel);
    }
    if (spell.condition) {
        const def = conditionDefFromSpell(spell.condition, defender);
        if (def) applyCondition(defender, def, { source: spell.id });
    }
}

function resolveCast(opts) {
    const o = opts || {};
    const attacker = o.attacker;
    const spell = o.spell;
    const empty = {
        ok: false,
        reason: 'unknown_spell',
        spell: spell || null,
        hits: [],
        fields: [],
        purged: [],
        manaSpent: 0,
        moveLock: 0
    };
    if (!attacker || !spell) return empty;
    const gate = canCast(attacker, spell, o);
    if (!gate.ok) return Object.assign({}, empty, { reason: gate.reason, spell });

    const tileMap = o.tileMap || null;
    const primary = o.target && o.target !== attacker ? o.target : null;
    const aim = o.aim || null;
    const casterPos = posOf(attacker);

    if (spell.requiresTarget && !isSelfCenteredAreaSpell(spell) && !spell.deploysField && !spell.destroysField) {
        if (!primary || !isCombatantAlive(primary)) {
            return Object.assign({}, empty, { reason: 'no_target', spell });
        }
        if (isInvisible(primary) && attacker.type === 'player') {
            return Object.assign({}, empty, { reason: 'no_target', spell });
        }
        if (!isWithinSpellCastRange(casterPos, posOf(primary), spell)) {
            return Object.assign({}, empty, { reason: 'out_of_range', spell });
        }
        if (tileMap && !hasLineOfSight(
            casterPos.x, casterPos.y, casterPos.z,
            primary.x, primary.y, primary.z, tileMap
        )) {
            return Object.assign({}, empty, { reason: 'out_of_range', spell });
        }
        if (tileMap && isHarmfulSpell(spell) && typeof tileMap.blocksCast === 'function'
            && tileMap.blocksCast(primary.x, primary.y, primary.z)) {
            return Object.assign({}, empty, { reason: 'no_cast', spell });
        }
    }

    let tiles = [];
    let center = null;
    let direction = { x: 1, y: 0 };
    if (spellHasShape(spell)) {
        center = resolveAreaCenter(attacker, spell, primary, aim);
        if (!center) {
            return Object.assign({}, empty, { reason: 'no_shape', spell });
        }
        if (!isWithinSpellCastRange(casterPos, center, spell) && !isSelfCenteredAreaSpell(spell)) {
            return Object.assign({}, empty, { reason: 'out_of_range', spell });
        }
        const t = spellTypeFromShape(spell.shape);
        if (t === 'wave' || t === 'beam') {
            direction = cardinalDirection(casterPos, center);
        } else if (aim || primary) {
            direction = octantDirection(casterPos, center);
        }
        tiles = getAffectedTiles({
            caster: casterPos,
            center,
            shape: spell.shape,
            direction,
            tileMap
        });
        if (!tiles.length) {
            return Object.assign({}, empty, { reason: 'no_tiles', spell });
        }
    } else if (primary) {
        tiles = [posOf(primary)];
        center = tiles[0];
    } else if (aim) {
        tiles = [{ x: aim.x | 0, y: aim.y | 0, z: aim.z != null ? aim.z | 0 : attacker.z | 0 }];
        center = tiles[0];
        if (!isWithinSpellCastRange(casterPos, center, spell)) {
            return Object.assign({}, empty, { reason: 'out_of_range', spell });
        }
    } else {
        tiles = [casterPos];
        center = casterPos;
    }

    const delaySec = spell.delaySec != null ? Number(spell.delaySec) : 0;
    if (delaySec > 0 && !o.detonate) {
        const manaCost = spell.mana != null ? spell.mana : 0;
        if (!o.skipMana) spendMana(attacker, manaCost);
        if (!o.skipCooldown) Cooldowns.apply(attacker, spell.cooldowns);
        if (isRuneSpell(spell) && o.runeConsumption && typeof o.consumeRune === 'function') {
            o.consumeRune(attacker, spell);
        }
        return {
            ok: true,
            reason: null,
            spell,
            hits: [],
            fields: [],
            purged: [],
            manaSpent: o.skipMana ? 0 : manaCost,
            moveLock: resolveMoveLock(spell),
            delayed: { center, direction, delaySec, tiles }
        };
    }

    const fieldKind = getFieldKind(spell.deploysField || spell.field);
    if ((spell.deploysField || spell.field) && !fieldKind && !spell.destroysField) {
        return Object.assign({}, empty, { reason: 'no_tiles', spell });
    }

    const manaCost = spell.mana != null ? spell.mana : 0;
    if (!o.skipMana) spendMana(attacker, manaCost);
    if (!o.skipCooldown) Cooldowns.apply(attacker, spell.cooldowns);
    if (isRuneSpell(spell) && o.runeConsumption && typeof o.consumeRune === 'function') {
        o.consumeRune(attacker, spell);
    }

    const now = o.now != null ? Number(o.now) : 0;
    const hits = [];
    const fields = [];
    const purged = [];
    const store = o.fieldStore || null;

    if (spell.destroysField && store) {
        for (let i = 0; i < tiles.length; i++) {
            const t = tiles[i];
            if (getFieldOnTile(store, t.x, t.y, t.z)) {
                removeFieldFromTile(store, t.x, t.y, t.z);
                purged.push({ x: t.x, y: t.y, z: t.z });
            }
        }
    }

    if (fieldKind && store) {
        const source = attacker.type === 'player' ? 'player'
            : attacker.type === 'creature' ? 'creature' : 'scenario';
        for (let i = 0; i < tiles.length; i++) {
            const t = tiles[i];
            const deployed = deployFieldAndTriggerOccupants(
                store,
                t.x,
                t.y,
                t.z,
                { kind: fieldKind, source, createdAt: now },
                tileMap && typeof tileMap.getCombatantEntities === 'function'
                    ? tileMap.getCombatantEntities(t.x, t.y, t.z)
                    : [],
                now
            );
            if (deployed.field) fields.push(deployed.field);
            for (let h = 0; h < deployed.hits.length; h++) {
                const row = deployed.hits[h];
                hits.push({
                    defender: row.entity,
                    result: {
                        miss: false,
                        hit: true,
                        raw: row.result.damage,
                        final: row.result.damage,
                        critical: false,
                        fatal: false,
                        element: row.result.element,
                        field: true
                    }
                });
            }
        }
    }

    let targets = defendersOnTiles(attacker, spell, tiles, tileMap, primary);
    const chain = normalizeChainSpec(spell);
    if (chain && o.candidates) {
        targets = pickChainTargets(attacker, primary, chain, o.candidates, tileMap);
    }

    const statusOnly = !!spell.statusOnly && !(spell.min || spell.max || spell.powerCurve);
    const selfCast = !primary && !spellHasShape(spell) && (spell.kind === 'heal' || spell.kind === 'support'
        || (spell.range != null && Number(spell.range) <= 0));
    if (selfCast) targets = [attacker];

    let sharedCrit = null;
    for (let i = 0; i < targets.length; i++) {
        const def = targets[i];
        if (!def) continue;
        if (isHarmfulSpell(spell) && tileMap && typeof tileMap.blocksCast === 'function'
            && tileMap.blocksCast(def.x, def.y, def.z) && def !== attacker) {
            continue;
        }
        if (statusOnly && !spell.condition && !spell.dispel) {
            applySpellSideEffects(spell, attacker, def);
            hits.push({
                defender: def,
                result: {
                    miss: false, hit: true, raw: 0, final: 0,
                    critical: false, fatal: false, element: spell.element || 'physical'
                }
            });
            continue;
        }
        const hitOpts = {};
        if (spellHasShape(spell) || chain) {
            if (sharedCrit == null) {
                const probe = resolveSpellHit(attacker, def, spell, o.rng, {});
                sharedCrit = probe.critical;
                hitOpts.critical = sharedCrit;
                hits.push({ defender: def, result: probe });
            } else {
                hitOpts.critical = sharedCrit;
                hits.push({ defender: def, result: resolveSpellHit(attacker, def, spell, o.rng, hitOpts) });
            }
        } else {
            hits.push({ defender: def, result: resolveSpellHit(attacker, def, spell, o.rng, hitOpts) });
        }
        const last = hits[hits.length - 1];
        if (last && last.result && last.result.hit && !last.result.miss) {
            applySpellSideEffects(spell, attacker, def);
        }
    }

    if (Array.isArray(spell.followupShapes) && spell.followupShapes.length && center) {
        for (let f = 0; f < spell.followupShapes.length; f++) {
            const shape = spell.followupShapes[f];
            const extraTiles = getAffectedTiles({
                caster: casterPos,
                center,
                shape,
                direction,
                tileMap
            });
            const extra = defendersOnTiles(attacker, spell, extraTiles, tileMap, primary);
            const scale = shape && shape.damageScale != null ? Number(shape.damageScale) : 1;
            for (let i = 0; i < extra.length; i++) {
                const def = extra[i];
                if (!def || def === attacker) continue;
                hits.push({
                    defender: def,
                    result: resolveSpellHit(attacker, def, spell, o.rng, {
                        damageScale: scale,
                        critical: sharedCrit === true
                    })
                });
            }
        }
    }

    return {
        ok: true,
        reason: null,
        spell,
        hits,
        fields,
        purged,
        manaSpent: o.skipMana ? 0 : manaCost,
        moveLock: resolveMoveLock(spell),
        center
    };
}

function sayForReason(reason) {
    switch (reason) {
        case 'unknown_spell':
        case 'level':
        case 'magic_level':
            return 'You cannot cast that.';
        case 'cooldown':
            return 'You are exhausted.';
        case 'mana':
            return 'You do not have enough mana.';
        case 'no_rune':
            return 'You need a rune.';
        case 'no_tiles':
            return 'There is no way.';
        case 'pacified':
            return 'You cannot attack.';
        default:
            return null;
    }
}

module.exports = {
    FAR_USE_RANGE_X,
    FAR_USE_RANGE_Y,
    SPELL_MOVE_LOCK_DEFAULT,
    indexSpellBook,
    findSpell,
    findSpellByRuneItem,
    isRuneSpell,
    isAutoAttackId,
    spellHasShape,
    isHarmfulSpell,
    isWithinSpellCastRange,
    canUseSpell,
    canCast,
    hasMana,
    spendMana,
    resolveMoveLock,
    resolveCast,
    sayForReason
};

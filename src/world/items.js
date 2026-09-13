'use strict';

const UNARMED_ATK = 7;
const UNARMED_WEAPON_DEFENSE = 5;
const BOW_MITIGATION_DEFENSE = 18;
const MAX_STACK_SIZE = 100;
const DEFAULT_ROOT_SLOTS = 20;
const ROOT_UID = 'root';
const DEFAULT_BACKPACK_ITEM_ID = 'backpack';
const INV_FLAG_CONTAINER = 1;

const EQUIPMENT_SLOTS = Object.freeze([
    'amulet',
    'helmet',
    'armor',
    'legs',
    'boots',
    'rightHand',
    'leftHand',
    'ring',
    'backpack'
]);

const EQUIPMENT_SLOT_ALIASES = Object.freeze({
    head: 'helmet',
    helmet: 'helmet',
    chest: 'armor',
    body: 'armor',
    armor: 'armor',
    weapon: 'rightHand',
    righthand: 'rightHand',
    rightHand: 'rightHand',
    shield: 'leftHand',
    lefthand: 'leftHand',
    leftHand: 'leftHand',
    legs: 'legs',
    boots: 'boots',
    feet: 'boots',
    amulet: 'amulet',
    necklace: 'amulet',
    neck: 'amulet',
    ring: 'ring',
    backpack: 'backpack',
    bag: 'backpack',
    container: 'backpack'
});

const ENGINE_TO_DESIGNER = Object.freeze({
    helmet: 'head',
    armor: 'chest',
    rightHand: 'weapon',
    leftHand: 'shield',
    amulet: 'amulet',
    ring: 'ring',
    legs: 'legs',
    boots: 'boots',
    backpack: 'backpack'
});

const DESIGNER_TO_ENGINE = Object.freeze({
    head: 'helmet',
    chest: 'armor',
    weapon: 'rightHand',
    shield: 'leftHand',
    amulet: 'amulet',
    ring: 'ring',
    legs: 'legs',
    boots: 'boots',
    backpack: 'backpack'
});

const FALLBACK_ITEMS = Object.freeze({
    backpack: Object.freeze({
        id: 'backpack',
        label: 'Backpack',
        slot: 'backpack',
        category: 'container',
        volume: DEFAULT_ROOT_SLOTS,
        weight: 1800,
        type: ['container']
    }),
    gold_coin: Object.freeze({
        id: 'gold_coin',
        label: 'Gold Coin',
        category: 'currency',
        stackable: true,
        weight: 10
    })
});

function canonicalEquipmentSlot(slot) {
    if (slot == null || slot === '') return null;
    const raw = String(slot);
    if (Object.prototype.hasOwnProperty.call(EQUIPMENT_SLOT_ALIASES, raw)) {
        return EQUIPMENT_SLOT_ALIASES[raw];
    }
    const lower = raw.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(EQUIPMENT_SLOT_ALIASES, lower)) {
        return EQUIPMENT_SLOT_ALIASES[lower];
    }
    return raw;
}

function designerSlotToEngine(slot) {
    if (!slot) return null;
    if (DESIGNER_TO_ENGINE[slot]) return DESIGNER_TO_ENGINE[slot];
    return canonicalEquipmentSlot(slot);
}

function engineSlotToDesigner(slot) {
    if (!slot) return slot;
    return ENGINE_TO_DESIGNER[slot] || slot;
}

function itemMatchesId(item, key) {
    if (!item || key == null) return false;
    if (String(item.id) === key) return true;
    const aliases = item.aliases;
    if (!Array.isArray(aliases)) return false;
    for (let i = 0; i < aliases.length; i++) {
        if (aliases[i] != null && String(aliases[i]) === key) return true;
    }
    return false;
}

function findItem(itemDb, id) {
    if (id == null || id === '' || !itemDb) return null;
    const key = String(id);
    if (!Array.isArray(itemDb)) {
        if (itemDb[key]) return itemDb[key];
        const vals = Object.keys(itemDb);
        for (let i = 0; i < vals.length; i++) {
            const row = itemDb[vals[i]];
            if (itemMatchesId(row, key)) return row;
        }
        return null;
    }
    for (let i = 0; i < itemDb.length; i++) {
        if (itemMatchesId(itemDb[i], key)) return itemDb[i];
    }
    return null;
}

function itemDbFromPack(pack) {
    const out = Object.create(null);
    const fbKeys = Object.keys(FALLBACK_ITEMS);
    for (let i = 0; i < fbKeys.length; i++) {
        out[fbKeys[i]] = FALLBACK_ITEMS[fbKeys[i]];
    }
    if (!pack) return out;
    const toys = pack.items;
    if (toys && typeof toys === 'object') {
        const keys = Object.keys(toys);
        for (let i = 0; i < keys.length; i++) {
            out[keys[i]] = toys[keys[i]];
        }
    }
    const eq = pack.equipment;
    const list = eq && Array.isArray(eq.items) ? eq.items : [];
    for (let i = 0; i < list.length; i++) {
        const row = list[i];
        if (!row || row.id == null) continue;
        out[String(row.id)] = row;
    }
    return out;
}

function itemIsAmmo(item) {
    if (!item || typeof item !== 'object') return false;
    const cat = item.category != null ? String(item.category).toLowerCase() : '';
    if (cat === 'ammo' || cat === 'ammunition') return true;
    if (item.ammoType) return true;
    if (Array.isArray(item.type)) {
        for (let i = 0; i < item.type.length; i++) {
            const t = String(item.type[i]).toLowerCase();
            if (t === 'ammo' || t === 'ammunition') return true;
        }
    }
    return false;
}

function itemIsQuiver(item) {
    if (!item) return false;
    const cat = item.category != null ? String(item.category).toLowerCase() : '';
    if (cat === 'quiver') return true;
    if (Array.isArray(item.type)) {
        for (let i = 0; i < item.type.length; i++) {
            if (String(item.type[i]).toLowerCase() === 'quiver') return true;
        }
    }
    return false;
}

function itemIsShield(item) {
    if (!item || itemIsAmmo(item) || itemIsQuiver(item)) return false;
    if (item.weaponType === 'shield' || item.category === 'shield') return true;
    if (item.category === 'spellbook') return true;
    return false;
}

function itemIsTwoHanded(item) {
    if (!item) return false;
    return item.twoHanded === true || item.twoHanded === 'true' || item.twoHanded === 1;
}

function normalizeAmmoTypeToken(raw) {
    if (raw == null) return null;
    if (raw === 'arrow' || raw === 'bolt') return raw;
    const a = String(raw).toLowerCase().trim();
    if (a === 'bolt' || a === 'bolts') return 'bolt';
    if (a === 'arrow' || a === 'arrows') return 'arrow';
    return null;
}

function itemAmmoKind(item) {
    if (!itemIsAmmo(item)) return null;
    const fromField = normalizeAmmoTypeToken(item.ammoType);
    if (fromField) return fromField;
    if (Array.isArray(item.type)) {
        for (let i = 0; i < item.type.length; i++) {
            const k = normalizeAmmoTypeToken(item.type[i]);
            if (k) return k;
        }
    }
    const s = `${item.id || ''} ${item.label || item.name || ''}`.toLowerCase();
    if (s.indexOf('bolt') >= 0) return 'bolt';
    if (s.indexOf('arrow') >= 0) return 'arrow';
    return null;
}

function weaponRequiredAmmoKind(weapon) {
    if (!weapon) return null;
    const cat = weapon.category != null ? String(weapon.category).toLowerCase() : '';
    if (cat === 'bow' || cat === 'bows') return 'arrow';
    if (cat === 'crossbow' || cat === 'crossbows') return 'bolt';
    if (Array.isArray(weapon.type)) {
        for (let i = 0; i < weapon.type.length; i++) {
            const t = String(weapon.type[i]).toLowerCase();
            if (t === 'bow' || t === 'bows') return 'arrow';
            if (t === 'crossbow' || t === 'crossbows') return 'bolt';
        }
    }
    return null;
}

function itemIsBowOrCrossbowWeapon(item) {
    return weaponRequiredAmmoKind(item) != null;
}

function mapTokenToWeaponSkill(token) {
    if (token == null || token === '') return null;
    const k = String(token).toLowerCase();
    if (k === 'sword' || k === 'axe' || k === 'club' || k === 'fist') return k;
    if (k === 'mace') return 'club';
    if (k === 'dagger') return 'sword';
    if (k === 'bow' || k === 'crossbow' || k === 'spear' || k === 'throwing') return 'distance';
    if (k === 'wand' || k === 'rod' || k === 'staff') return 'magic';
    if (k === 'distance' || k === 'ranged') return 'distance';
    if (k === 'magic') return 'magic';
    if (k === 'melee') return 'melee';
    return null;
}

function resolveWeaponSkillFromItem(item) {
    if (!item || typeof item !== 'object') return null;
    const fromCat = mapTokenToWeaponSkill(item.category);
    if (fromCat) return fromCat;
    const types = Array.isArray(item.type)
        ? item.type
        : item.type != null && item.type !== '' ? [item.type] : [];
    for (let i = 0; i < types.length; i++) {
        const fromType = mapTokenToWeaponSkill(types[i]);
        if (fromType === 'sword' || fromType === 'axe' || fromType === 'club' || fromType === 'fist') {
            return fromType;
        }
        if (fromType === 'distance' || fromType === 'magic') return fromType;
    }
    for (let i = 0; i < types.length; i++) {
        const fromType = mapTokenToWeaponSkill(types[i]);
        if (fromType) return fromType;
    }
    return mapTokenToWeaponSkill(item.weaponType);
}

function itemIsContainer(item) {
    if (!item || typeof item !== 'object') return false;
    if (itemIsQuiver(item)) return true;
    const cat = item.category != null ? String(item.category).toLowerCase() : '';
    if (cat === 'container' || cat === 'backpack' || cat === 'bag' || cat === 'quiver') {
        return true;
    }
    const slot = item.slot != null ? String(item.slot).toLowerCase() : '';
    if (slot === 'backpack' || slot === 'container' || slot === 'bag') return true;
    if (Array.isArray(item.type)) {
        for (let i = 0; i < item.type.length; i++) {
            const t = String(item.type[i]).toLowerCase();
            if (t === 'container' || t === 'backpack' || t === 'bag' || t === 'quiver') return true;
        }
    }
    if (item.volume != null && Number.isFinite(Number(item.volume)) && Number(item.volume) > 0) {
        if (!item.atk && !item.armor && cat !== 'ammo' && cat !== 'ammunition') return true;
    }
    return false;
}

function itemIsBackpackEquip(item) {
    if (!item || item.slot == null) return false;
    const raw = String(item.slot).toLowerCase().trim();
    if (raw === 'backpack') return true;
    return canonicalEquipmentSlot(item.slot) === 'backpack';
}

function itemIsStackable(item) {
    if (!item || typeof item !== 'object') return false;
    return item.stackable === true;
}

function itemIsRune(item) {
    if (!item) return false;
    const cat = item.category != null ? String(item.category).toLowerCase() : '';
    if (cat === 'rune') return true;
    if (Array.isArray(item.type)) {
        for (let i = 0; i < item.type.length; i++) {
            if (String(item.type[i]).toLowerCase() === 'rune') return true;
        }
    }
    return false;
}

function itemIsMultiUse(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.multiUse === true) return true;
    const cat = item.category != null ? String(item.category).toLowerCase() : '';
    if (cat === 'rune' || cat === 'tool') return true;
    if (Array.isArray(item.type)) {
        for (let i = 0; i < item.type.length; i++) {
            const t = String(item.type[i]).toLowerCase();
            if (t === 'rune' || t === 'tool') return true;
        }
    }
    return false;
}

function itemIsUsable(item) {
    if (!item || typeof item !== 'object') return false;
    if (itemIsContainer(item) || itemIsMultiUse(item)) return false;
    if (item.usable === true || item.consumable === true) return true;
    const cat = item.category != null ? String(item.category).toLowerCase() : '';
    if (cat === 'potion' || cat === 'consumable' || cat === 'food' || cat === 'scroll') return true;
    if (
        item.heal != null ||
        item.restoreMana != null ||
        item.dispel != null ||
        item.condition != null ||
        item.effect != null
    ) {
        return true;
    }
    return false;
}

function preferredEquipSlot(item) {
    if (!item) return null;
    if (itemIsAmmo(item)) return null;
    if (item.slot != null && String(item.slot).trim() !== '') {
        const c = canonicalEquipmentSlot(item.slot);
        if (c) return c;
    }
    const cat = item.category != null ? String(item.category).toLowerCase() : '';
    if (cat === 'helmet' || cat === 'head') return 'helmet';
    if (cat === 'armor' || cat === 'chest' || cat === 'body') return 'armor';
    if (cat === 'legs') return 'legs';
    if (cat === 'boots' || cat === 'feet') return 'boots';
    if (cat === 'amulet' || cat === 'necklace' || cat === 'neck') return 'amulet';
    if (cat === 'ring') return 'ring';
    if (cat === 'shield' || cat === 'spellbook' || cat === 'quiver') return 'leftHand';
    if (cat === 'container' || cat === 'backpack' || cat === 'bag') return 'backpack';
    if (itemIsShield(item)) return 'leftHand';
    if (item.atk != null || item.weaponType) return 'rightHand';
    return null;
}

function canEquipInSlot(item, engineSlot) {
    if (!item || !engineSlot) return false;
    if (itemIsAmmo(item)) return false;
    const slot = canonicalEquipmentSlot(engineSlot) || engineSlot;
    if (slot === 'backpack') return itemIsBackpackEquip(item);
    const preferred = preferredEquipSlot(item);
    if (!preferred) return false;
    return preferred === slot;
}

function itemIsEquipable(item) {
    if (!item || typeof item !== 'object') return false;
    if (itemIsAmmo(item)) return false;
    return preferredEquipSlot(item) != null || item.slot != null;
}

function containerCapacity(itemOrId, itemDb) {
    const item = typeof itemOrId === 'string' || typeof itemOrId === 'number'
        ? findItem(itemDb, itemOrId)
        : itemOrId;
    if (item && item.volume != null && Number.isFinite(Number(item.volume))) {
        return Math.max(1, Math.min(255, Math.floor(Number(item.volume))));
    }
    return DEFAULT_ROOT_SLOTS;
}

function asHealRange(item) {
    if (!item) return null;
    if (item.heal != null && Number.isFinite(Number(item.heal))) {
        const n = Math.max(0, Math.floor(Number(item.heal)));
        return [n, n];
    }
    if (item.healMin != null) {
        const a = Math.floor(Number(item.healMin) || 0);
        const b = Math.floor(Number(item.healMax != null ? item.healMax : item.healMin) || 0);
        return a <= b ? [a, b] : [b, a];
    }
    return null;
}

function asManaRange(item) {
    if (!item) return null;
    if (item.restoreMana != null && Number.isFinite(Number(item.restoreMana))) {
        const n = Math.max(0, Math.floor(Number(item.restoreMana)));
        return [n, n];
    }
    if (item.mana != null && Number.isFinite(Number(item.mana))) {
        const n = Math.max(0, Math.floor(Number(item.mana)));
        return [n, n];
    }
    return null;
}

function computeMitigationPercent(shieldingSkill, defense) {
    const s = Math.max(0, Number(shieldingSkill) || 0);
    const d = Math.max(0, Number(defense) || 0);
    const base = -0.0817 + 0.008894 * s + 0.0163 * d;
    return Math.max(0, Math.min(80, base));
}

function computeMaxBlock(blockSkill, defense) {
    const s = Math.max(0, Number(blockSkill) || 0);
    const d = Math.max(0, Number(defense) || 0);
    if (d <= 0) return 0;
    return Math.ceil(d * ((s + 10) / 40));
}

function skillValue(skills, key) {
    const bag = skills || {};
    if (key === 'magic') return Number(bag.magic) || 0;
    if (key === 'distance') return bag.distance != null ? Number(bag.distance) || 0 : 10;
    if (key === 'fist') return bag.fist != null ? Number(bag.fist) || 0 : 10;
    if (key === 'sword' || key === 'axe' || key === 'club') {
        if (bag[key] != null) return Number(bag[key]) || 0;
        return 10;
    }
    if (key === 'shielding') return bag.shielding != null ? Number(bag.shielding) || 0 : 10;
    return bag[key] != null ? Number(bag[key]) || 0 : 10;
}

module.exports = {
    UNARMED_ATK,
    UNARMED_WEAPON_DEFENSE,
    BOW_MITIGATION_DEFENSE,
    MAX_STACK_SIZE,
    DEFAULT_ROOT_SLOTS,
    ROOT_UID,
    DEFAULT_BACKPACK_ITEM_ID,
    INV_FLAG_CONTAINER,
    EQUIPMENT_SLOTS,
    EQUIPMENT_SLOT_ALIASES,
    ENGINE_TO_DESIGNER,
    DESIGNER_TO_ENGINE,
    FALLBACK_ITEMS,
    canonicalEquipmentSlot,
    designerSlotToEngine,
    engineSlotToDesigner,
    findItem,
    itemDbFromPack,
    itemIsAmmo,
    itemIsQuiver,
    itemIsShield,
    itemIsTwoHanded,
    itemAmmoKind,
    weaponRequiredAmmoKind,
    itemIsBowOrCrossbowWeapon,
    mapTokenToWeaponSkill,
    resolveWeaponSkillFromItem,
    itemIsContainer,
    itemIsBackpackEquip,
    itemIsStackable,
    itemIsRune,
    itemIsMultiUse,
    itemIsUsable,
    preferredEquipSlot,
    canEquipInSlot,
    itemIsEquipable,
    containerCapacity,
    asHealRange,
    asManaRange,
    computeMitigationPercent,
    computeMaxBlock,
    skillValue
};

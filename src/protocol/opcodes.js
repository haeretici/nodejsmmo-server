'use strict';

const PROTOCOL_VERSION = 1;
const HEADER_SIZE = 6;

const C2S = Object.freeze({
    ENTER: 1,
    PING: 2,
    LOGOUT: 3,
    MOVE_STEP: 10,
    SET_TARGET: 11,
    // 12 unused (was SET_AUTO_CHASE; chase is client MOVE_PATH)
    USE_STAIR: 13,
    USE: 14,
    USE_ITEM_WITH: 15,
    CAST: 16,
    // 17 unused (was SET_HOTKEYS; bars are client IndexedDB)
    MOVE_PATH: 18,
    OPEN_CORPSE: 20,
    LOOT_TAKE: 21,
    LOOT_CLOSE: 22,
    TALK: 30,
    TALK_REPLY: 31,
    TALK_CLOSE: 32,
    SHOP_BUY: 33,
    SHOP_SELL: 34,
    EQUIP: 40,
    UNEQUIP: 41,
    MOVE_ITEM: 42,
    USE_ITEM: 43,
    OPEN_BAG: 44,
    CLOSE_BAG: 45
});

const S2C = Object.freeze({
    HELLO: 100,
    ENTER_WORLD: 101,
    KICK: 102,
    REJECT: 103,
    PONG: 104,
    VIEWPORT: 110,
    APPEAR: 111,
    DISAPPEAR: 112,
    MOVE: 113,
    STATS: 114,
    SWING: 115,
    DEATH: 116,
    CORPSE: 117,
    CORPSE_GONE: 118,
    CONTAINER: 119,
    ITEM_GAIN: 120,
    EXP: 121,
    INVENTORY: 122,
    SAY: 123,
    SKILLS: 124,
    WORLD_PIN: 125,
    WORLD_PIN_GONE: 126,
    EQUIPMENT: 127,
    BAG: 128,
    CAST: 129,
    DIALOG: 130,
    DIALOG_CLOSE: 131,
    SHOP: 132,
    FIELD: 133,
    FIELD_GONE: 134,
    // 135 unused (was HOTKEYS; bars are client IndexedDB)
    GROUND: 136,
    GROUND_GONE: 137
});

const REASON = Object.freeze({
    BAD_FRAME: 1,
    BAD_TOKEN: 2,
    UNAUTHORIZED: 5,
    WORLD_FULL: 6,
    ALREADY_ONLINE: 7,
    RATE_LIMITED: 8,
    UNKNOWN_OPCODE: 9,
    NOT_IMPLEMENTED: 10,
    NOT_ENTERED: 11,
    TIMEOUT: 12,
    IP_MISMATCH: 13,
    BANNED: 14,
    REPLACED: 15,
    LOGOUT: 16,
    BAD_SEQ: 17,
    BLOCKED: 18,
    BUSY: 19,
    NO_TARGET: 20,
    OUT_OF_RANGE: 21
});

const APPEAR_FLAG = Object.freeze({
    NPC: 1
});

const INV_FLAG = Object.freeze({
    CONTAINER: 1
});

const LOC_KIND = Object.freeze({
    CONTAINER: 0,
    EQUIPMENT: 1,
    TILE: 2
});

/** OPEN_BAG index that names the container uid itself (canvas ground bag). */
const OPEN_BAG_SELF_INDEX = 255;

/** Wire order for S2C.SKILLS (u16 each). Persist column names. */
const SKILL_ORDER = Object.freeze([
    'fist', 'club', 'sword', 'axe', 'distance', 'shielding', 'magic', 'fishing'
]);

const SWING_FLAG = Object.freeze({
    MISS: 1,
    DEATH: 2,
    CRIT: 4,
    FATAL: 8
});

/** Wire `SWING` extra `element u8`. Unknown names → PHYSICAL. */
const SWING_ELEMENT = Object.freeze({
    PHYSICAL: 0,
    FIRE: 1,
    ICE: 2,
    ENERGY: 3,
    EARTH: 4,
    DEATH: 5,
    HOLY: 6,
    HEALING: 7,
    POISON: 8,
    LIFEDRAIN: 9,
    MANADRAIN: 10
});

const SWING_ELEMENT_NAMES = Object.freeze([
    'physical',
    'fire',
    'ice',
    'energy',
    'earth',
    'death',
    'holy',
    'healing',
    'poison',
    'lifedrain',
    'manadrain'
]);

function swingElementId(name) {
    if (typeof name === 'number' && Number.isFinite(name)) {
        const n = name | 0;
        return n >= 0 && n < SWING_ELEMENT_NAMES.length ? n : SWING_ELEMENT.PHYSICAL;
    }
    if (name == null || name === '') return SWING_ELEMENT.PHYSICAL;
    const s = String(name).toLowerCase();
    const i = SWING_ELEMENT_NAMES.indexOf(s);
    return i >= 0 ? i : SWING_ELEMENT.PHYSICAL;
}

function swingElementName(id) {
    return SWING_ELEMENT_NAMES[id | 0] || 'physical';
}

const DIR = Object.freeze({
    N: 0,
    E: 1,
    S: 2,
    W: 3
});

const DIR_DELTA = Object.freeze([
    Object.freeze({ dx: 0, dy: -1 }),
    Object.freeze({ dx: 1, dy: 0 }),
    Object.freeze({ dx: 0, dy: 1 }),
    Object.freeze({ dx: -1, dy: 0 })
]);

const C2S_ENTERED = new Set([
    C2S.PING,
    C2S.LOGOUT,
    C2S.MOVE_STEP,
    C2S.SET_TARGET,
    C2S.USE_STAIR,
    C2S.MOVE_PATH,
    C2S.USE,
    C2S.USE_ITEM_WITH,
    C2S.CAST,
    C2S.OPEN_CORPSE,
    C2S.LOOT_TAKE,
    C2S.LOOT_CLOSE,
    C2S.TALK,
    C2S.TALK_REPLY,
    C2S.TALK_CLOSE,
    C2S.SHOP_BUY,
    C2S.SHOP_SELL,
    C2S.EQUIP,
    C2S.UNEQUIP,
    C2S.MOVE_ITEM,
    C2S.USE_ITEM,
    C2S.OPEN_BAG,
    C2S.CLOSE_BAG
]);

const C2S_DOWNED = new Set([C2S.PING, C2S.LOGOUT]);

function wsCloseCode(reason) {
    const n = 4000 + (reason | 0);
    return n >= 4000 && n <= 4999 ? n : 4000;
}

module.exports = {
    PROTOCOL_VERSION,
    HEADER_SIZE,
    C2S,
    S2C,
    REASON,
    APPEAR_FLAG,
    INV_FLAG,
    LOC_KIND,
    OPEN_BAG_SELF_INDEX,
    SKILL_ORDER,
    SWING_FLAG,
    SWING_ELEMENT,
    SWING_ELEMENT_NAMES,
    swingElementId,
    swingElementName,
    DIR,
    DIR_DELTA,
    C2S_ENTERED,
    C2S_DOWNED,
    wsCloseCode
};

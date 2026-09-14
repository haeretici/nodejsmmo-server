'use strict';

const { chebyshev } = require('./combat');
const { countItem } = require('./inventory');
const { KEY_RE } = require('./snapshot');

const DEFAULT_TALK_RANGE = 3;
const DEFAULT_CURRENCY = 'gold_coin';
const MAX_DEAL_COUNT = 100;

function isNpcEntity(ent) {
    return !!(ent && (ent.type === 'npc' || ent.isNpc));
}

function talkRangeOk(a, b, range) {
    if (!a || !b) return false;
    if ((a.z | 0) !== (b.z | 0)) return false;
    const r = range == null ? DEFAULT_TALK_RANGE : range | 0;
    return chebyshev(a.x, a.y, b.x, b.y) <= r;
}

function asInt(v, fallback) {
    if (v == null || v === '') return fallback;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? n : fallback;
}

function normalizeItemSpec(raw, fallbackCount) {
    if (raw == null) return null;
    let itemId = '';
    let count = fallbackCount;
    if (typeof raw === 'string' || typeof raw === 'number') {
        itemId = String(raw).trim();
    } else if (typeof raw === 'object' && !Array.isArray(raw)) {
        if (raw.itemId != null) itemId = String(raw.itemId).trim();
        else if (raw.id != null) itemId = String(raw.id).trim();
        else if (raw.item != null) itemId = String(raw.item).trim();
        if (raw.count != null) count = raw.count;
    } else {
        return null;
    }
    if (!itemId) return null;
    let n = count != null ? asInt(count, 1) : 1;
    if (n < 1) return null;
    return { itemId, count: n };
}

function getStorage(bag, key) {
    const k = key != null ? String(key).trim() : '';
    if (!k || !KEY_RE.test(k)) return 0;
    if (!bag || typeof bag !== 'object' || Array.isArray(bag) || bag[k] == null) return 0;
    const v = bag[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string' && v.trim()) {
        const t = v.trim();
        if (t !== 'true' && t !== 'false' && Number.isFinite(Number(t))) return Number(t);
        return t;
    }
    return 0;
}

function setStorage(bag, key, value) {
    const k = key != null ? String(key).trim() : '';
    if (!k || !KEY_RE.test(k) || !bag) return false;
    if (value == null) {
        delete bag[k];
        return true;
    }
    if (typeof value === 'boolean') {
        bag[k] = value ? 1 : 0;
        return true;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        bag[k] = value;
        return true;
    }
    if (typeof value === 'string') {
        const t = value.trim();
        if (!t) {
            delete bag[k];
            return true;
        }
        bag[k] = t;
        return true;
    }
    return false;
}

function applyStoragePatch(bag, patch) {
    if (!bag || !patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
    const keys = Object.keys(patch);
    let any = false;
    for (let i = 0; i < keys.length; i++) {
        if (setStorage(bag, keys[i], patch[keys[i]])) any = true;
    }
    return any;
}

function valuesEqual(a, b) {
    if (a === b) return true;
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && typeof a !== 'boolean' && typeof b !== 'boolean') {
        if (a === '' || b === '') return false;
        return na === nb;
    }
    return String(a) === String(b);
}

function compareWhenValue(value, clause) {
    let anyOp = false;
    if (clause.eq !== undefined) {
        anyOp = true;
        if (!valuesEqual(value, clause.eq)) return false;
    }
    if (clause.neq !== undefined) {
        anyOp = true;
        if (valuesEqual(value, clause.neq)) return false;
    }
    if (clause.min !== undefined) {
        anyOp = true;
        const min = Number(clause.min);
        if (!Number.isFinite(min) || Number(value) < min) return false;
    }
    if (clause.max !== undefined) {
        anyOp = true;
        const max = Number(clause.max);
        if (!Number.isFinite(max) || Number(value) > max) return false;
    }
    if (!anyOp) return Number(value) !== 0 && value !== '' && value !== 0;
    return true;
}

function evalWhenClause(player, clause) {
    if (!clause || typeof clause !== 'object' || Array.isArray(clause)) return false;
    const itemId = clause.item != null
        ? String(clause.item).trim()
        : clause.itemId != null
            ? String(clause.itemId).trim()
            : '';
    if (itemId) {
        return compareWhenValue(countItem(player && player.inventory, itemId), clause);
    }
    const key = clause.storage != null ? clause.storage : clause.key != null ? clause.key : '';
    return compareWhenValue(getStorage(player && player.storage, key), clause);
}

function evalWhen(player, when) {
    if (when == null) return true;
    if (Array.isArray(when)) {
        if (!when.length) return true;
        for (let i = 0; i < when.length; i++) {
            if (!evalWhenClause(player, when[i])) return false;
        }
        return true;
    }
    if (typeof when === 'object') return evalWhenClause(player, when);
    return false;
}

function replyMatchesWhen(player, reply) {
    if (!reply || typeof reply !== 'object') return false;
    if (reply.when == null) return true;
    if (!player) return false;
    return evalWhen(player, reply.when);
}

function isDialogTree(obj) {
    return !!(obj && typeof obj === 'object' && !Array.isArray(obj)
        && obj.nodes && typeof obj.nodes === 'object' && !Array.isArray(obj.nodes)
        && Object.keys(obj.nodes).length > 0);
}

function normalizeDialog(raw) {
    if (!isDialogTree(raw)) return null;
    const dialog = JSON.parse(JSON.stringify(raw));
    const nodeIds = Object.keys(dialog.nodes);
    if (dialog.start != null && String(dialog.start).trim()) {
        dialog.start = String(dialog.start).trim();
    } else if (dialog.nodes.start) {
        dialog.start = 'start';
    } else {
        dialog.start = nodeIds[0];
    }
    if (!dialog.nodes[dialog.start] || typeof dialog.nodes[dialog.start] !== 'object') return null;
    return dialog;
}

function resolveNode(dialog, nodeId) {
    if (!dialog || !dialog.nodes) return null;
    const id = nodeId != null && String(nodeId).trim()
        ? String(nodeId).trim()
        : dialog.start || 'start';
    const node = dialog.nodes[id];
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    return { nodeId: id, node };
}

function listReplies(node, player) {
    if (!node || !Array.isArray(node.replies)) return [];
    const out = [];
    for (let i = 0; i < node.replies.length; i++) {
        const raw = node.replies[i];
        if (!raw || typeof raw !== 'object') continue;
        const label = raw.label != null
            ? String(raw.label).trim()
            : raw.text != null ? String(raw.text).trim() : '';
        if (!label) continue;
        const reply = { label };
        const gotoId = raw.goto != null ? String(raw.goto).trim() : '';
        if (raw.action != null && String(raw.action).trim()) {
            reply.action = String(raw.action).trim();
        } else if (gotoId) {
            reply.action = 'goto';
        } else {
            reply.action = 'close';
        }
        if (reply.action === 'trade') reply.action = 'open_shop';
        if (gotoId) reply.goto = gotoId;
        if (raw.when != null) reply.when = raw.when;
        if (raw.set && typeof raw.set === 'object') reply.set = raw.set;
        const give = normalizeItemSpec(raw.give, raw.count);
        const take = normalizeItemSpec(raw.take, raw.count);
        if (give) reply.give = give;
        if (take) reply.take = take;
        if (reply.action === 'give_item' || reply.action === 'take_item') {
            const spec = normalizeItemSpec(
                raw.itemId != null ? raw.itemId : raw.item,
                raw.count
            );
            if (spec) {
                if (reply.action === 'give_item' && !reply.give) reply.give = spec;
                if (reply.action === 'take_item' && !reply.take) reply.take = spec;
            }
        }
        if (!replyMatchesWhen(player, reply)) continue;
        out.push(reply);
    }
    return out;
}

function normalizeShop(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const currencySpec = normalizeItemSpec(
        raw.currency != null ? raw.currency : DEFAULT_CURRENCY,
        1
    );
    const currency = currencySpec ? currencySpec.itemId : DEFAULT_CURRENCY;
    const items = [];
    const list = Array.isArray(raw.items) ? raw.items : [];
    for (let i = 0; i < list.length; i++) {
        const row = list[i];
        if (!row || typeof row !== 'object') continue;
        const spec = normalizeItemSpec(row.itemId != null ? row.itemId : row.item, 1);
        if (!spec || spec.itemId === currency) continue;
        const buy = Math.max(0, asInt(row.buy, 0));
        const sell = Math.max(0, asInt(row.sell, 0));
        if (buy < 1 && sell < 1) continue;
        const out = { itemId: spec.itemId, buy, sell };
        if (row.when != null) out.when = row.when;
        items.push(out);
    }
    const shop = { currency, items };
    if (raw.when != null) shop.when = raw.when;
    if (raw.denyText != null && String(raw.denyText).trim()) {
        shop.denyText = String(raw.denyText).trim();
    }
    return shop;
}

function resolveShop(source) {
    if (!source || typeof source !== 'object') return null;
    if (source.shop) return normalizeShop(source.shop);
    if (source.dialog && source.dialog.shop) return normalizeShop(source.dialog.shop);
    return normalizeShop(source);
}

function listShopRows(shop, player) {
    if (!shop || !Array.isArray(shop.items)) return [];
    const out = [];
    for (let i = 0; i < shop.items.length; i++) {
        const row = shop.items[i];
        if (!row) continue;
        if (row.when != null && (!player || !evalWhen(player, row.when))) continue;
        out.push(row);
    }
    return out;
}

function findShopRow(shop, itemId) {
    if (!shop || itemId == null) return null;
    const id = String(itemId).trim();
    if (!id) return null;
    for (let i = 0; i < shop.items.length; i++) {
        if (shop.items[i] && shop.items[i].itemId === id) return shop.items[i];
    }
    return null;
}

function clampDealCount(raw) {
    const n = asInt(raw, 1);
    if (n < 1) return 0;
    return n > MAX_DEAL_COUNT ? MAX_DEAL_COUNT : n;
}

function resolveDialog(source, dialogDb) {
    if (!source) return null;
    if (typeof source === 'string') {
        const id = source.trim();
        const raw = dialogDb && dialogDb[id];
        return raw ? normalizeDialog(raw) : null;
    }
    if (typeof source !== 'object' || Array.isArray(source)) return null;
    if (source.dialog != null) {
        return normalizeDialog(source.dialog);
    }
    const dialogId = source.dialogId != null ? String(source.dialogId).trim() : '';
    if (dialogId) {
        const raw = dialogDb && dialogDb[dialogId];
        if (raw) return normalizeDialog(raw);
    }
    if (isDialogTree(source)) {
        return normalizeDialog(source);
    }
    return null;
}

module.exports = {
    DEFAULT_TALK_RANGE,
    DEFAULT_CURRENCY,
    MAX_DEAL_COUNT,
    isNpcEntity,
    talkRangeOk,
    normalizeItemSpec,
    getStorage,
    setStorage,
    applyStoragePatch,
    evalWhen,
    replyMatchesWhen,
    isDialogTree,
    normalizeDialog,
    resolveDialog,
    resolveNode,
    listReplies,
    normalizeShop,
    resolveShop,
    listShopRows,
    findShopRow,
    clampDealCount
};

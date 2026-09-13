'use strict';

const path = require('path');
const { SERVER_ROOT } = require('../config/load_settings');

function packLoader() {
    return require(path.join(SERVER_ROOT, '..', 'content', 'src', 'pack.js'));
}

function resolveContentPath(settings, root) {
    const base = root || SERVER_ROOT;
    const raw = (settings && settings.contentPath) || '../content';
    return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw);
}

function loadPack(root) {
    return packLoader().loadPack(root);
}

function runtimeMap(pack, mapId) {
    return packLoader().runtimeMap(pack, mapId);
}

function resolveMapId(settings, pack) {
    return packLoader().resolveMapId(settings, pack);
}

module.exports = { resolveContentPath, loadPack, runtimeMap, resolveMapId };

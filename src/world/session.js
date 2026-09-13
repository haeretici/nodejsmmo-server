'use strict';

const { S2C, REASON, wsCloseCode } = require('../protocol/opcodes');
const { encodeFrame } = require('../protocol/frame');
const { encodeKick, encodeReject } = require('../protocol/messages');
const { PacketGate } = require('../security/rate_limit');
const { cloneStorage, cloneSkills, extractSkillTries } = require('./snapshot');
const { ensureSkillCounterBags, seedPlayerExperience } = require('./progression');
const { normalizeInventory, applyPlayerLoadout } = require('./inventory');
const { UNARMED_ATK } = require('./items');

class GameSession {
    /**
     * @param {{
     *   socket: object,
     *   ip: string,
     *   world: object,
     *   settings: object,
     *   limiter: object,
     *   log: object,
     *   now?: () => number
     * }} opts
     */
    constructor(opts) {
        this.socket = opts.socket;
        this.ip = opts.ip;
        this.world = opts.world;
        this.settings = opts.settings;
        this.limiter = opts.limiter;
        this.log = opts.log;
        this.now = opts.now || (() => Date.now());
        this.entered = false;
        this.entering = false;
        this.dead = false;
        this.left = false;
        this.nextClientSeq = 1;
        this.nextServerSeq = 1;
        this.intentQueue = [];
        this.character = null;
        this.id = 0;
        this.type = 'player';
        this.x = 0;
        this.y = 0;
        this.z = 0;
        this.dir = 0;
        this.moveReadyTick = 0;
        this.name = '';
        this.hp = 0;
        this.hpMax = 0;
        this.mp = 0;
        this.mpMax = 0;
        this.level = 1;
        this.experience = 0;
        this.skills = null;
        this.skillRates = null;
        this._skillTryProgress = Object.create(null);
        this._manaTowardMagic = 0;
        this.bloodHitCount = 0;
        this.shieldBlockCount = 0;
        this.armor = 0;
        this.mitigation = 0;
        this.maxBlock = 0;
        this.canBlock = false;
        this.resists = { physical: 0 };
        this.critChance = 0;
        this.critDamage = 0;
        this.weaponTier = 0;
        this.atk = UNARMED_ATK;
        this.weaponSkill = 'fist';
        this._baseCritChance = 0;
        this._baseCritDamage = 0;
        this._gearSkillBonus = Object.create(null);
        this.targetId = 0;
        this.autoChase = false;
        this.attackReadyTick = 0;
        this.movedThisTick = false;
        this.path = [];
        this.downed = false;
        this.respawnTick = 0;
        this.inventory = normalizeInventory(null, null);
        this.storage = Object.create(null);
        this.openCorpseId = 0;
        this.openBagUid = '';
        this.talkNpcId = 0;
        this.talkNodeId = '';
        this.shopOpen = false;
        this.enterTimer = null;
        const limits = opts.settings.limits;
        this.gate = new PacketGate({
            rate: limits.maxPacketsPerSecond | 0,
            burst: limits.packetBurst | 0,
            now: this.now
        });
    }

    bindCharacter(ch, pos, extras) {
        this.character = ch;
        this.id = ch.id;
        this.type = 'player';
        this.x = pos.x;
        this.y = pos.y;
        this.z = pos.z;
        this.dir = 0;
        this.moveReadyTick = 0;
        this.name = ch.name;
        this.hp = ch.hp | 0;
        this.hpMax = ch.hpMax | 0;
        this.mp = ch.mp | 0;
        this.mpMax = ch.mpMax | 0;
        this.level = ch.level | 0;
        this.experience = Number(ch.experience) || 0;
        const defaults = this.settings && this.settings.newCharacter && this.settings.newCharacter.skills;
        const loadedSkills = extras && extras.skills;
        const mergedSkills = Object.assign({}, defaults || {}, loadedSkills || {});
        this.skills = cloneSkills(mergedSkills);
        const tries = extractSkillTries(mergedSkills);
        this._skillTryProgress = tries.progress;
        this._manaTowardMagic = tries.magicTries;
        this.bloodHitCount = 0;
        this.shieldBlockCount = 0;
        this.skillRates = null;
        ensureSkillCounterBags(this);
        seedPlayerExperience(this);
        if (this.character) this.character.experience = this.experience;
        this.armor = 0;
        this.mitigation = 0;
        this.maxBlock = 0;
        this.canBlock = false;
        this.resists = { physical: 0 };
        this.critChance = 0;
        this.critDamage = 0;
        this.weaponTier = 0;
        this.atk = UNARMED_ATK;
        this.weaponSkill = 'fist';
        this._gearSkillBonus = Object.create(null);
        this.targetId = 0;
        this.autoChase = false;
        this.attackReadyTick = 0;
        this.movedThisTick = false;
        this.path = [];
        this.downed = false;
        this.respawnTick = 0;
        const state = extras && extras.state;
        const itemDb = this.world && typeof this.world.itemDb === 'function'
            ? this.world.itemDb()
            : null;
        this.inventory = normalizeInventory(state && state.inventory, itemDb);
        applyPlayerLoadout(this, itemDb);
        this.storage = cloneStorage(state && state.storage);
        this.openCorpseId = 0;
        this.openBagUid = '';
        this.talkNpcId = 0;
        this.talkNodeId = '';
        this.shopOpen = false;
        this.entered = true;
        this.entering = false;
        this.clearEnterTimer();
    }

    send(opcode, payload) {
        if (this.dead) return;
        const sock = this.socket;
        if (!sock || sock.readyState !== 1) return;
        const seq = this.nextServerSeq;
        this.nextServerSeq += 1;
        const buf = encodeFrame(opcode, seq, payload);
        try {
            sock.send(buf, { binary: true });
        } catch {
            // drop; close handler will leave
        }
    }

    reject(refSeq, reason) {
        this.send(S2C.REJECT, encodeReject(refSeq, reason));
    }

    kick(reason) {
        if (this.dead) return;
        try {
            this.send(S2C.KICK, encodeKick(reason));
        } catch {
            // ignore
        }
        this.dead = true;
        this.clearEnterTimer();
        if (this.world) this.world.leave(this);
        const sock = this.socket;
        if (!sock) return;
        try {
            if (sock.readyState === 1 && typeof sock.close === 'function') {
                sock.close(wsCloseCode(reason));
            } else if (typeof sock.terminate === 'function') {
                sock.terminate();
            }
        } catch {
            // ignore
        }
    }

    malformed() {
        this.limiter.metrics.packetsDropped += 1;
        this.limiter.recordMalformedClose(this.ip, this.settings.limits);
        this.kick(REASON.BAD_FRAME);
    }

    flood() {
        this.limiter.metrics.packetsDropped += 1;
        this.limiter.recordMalformedClose(this.ip, this.settings.limits);
        this.kick(REASON.RATE_LIMITED);
    }

    startEnterTimer(ms) {
        this.clearEnterTimer();
        this.enterTimer = setTimeout(() => {
            this.enterTimer = null;
            if (!this.entered && !this.entering) {
                this.limiter.metrics.enterFail += 1;
                this.kick(REASON.TIMEOUT);
            }
        }, ms);
        if (typeof this.enterTimer.unref === 'function') this.enterTimer.unref();
    }

    clearEnterTimer() {
        if (this.enterTimer != null) {
            clearTimeout(this.enterTimer);
            this.enterTimer = null;
        }
    }
}

module.exports = { GameSession };

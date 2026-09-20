'use strict';

const { DuplicateError } = require('./errors');

function cloneJson(v) {
    return JSON.parse(JSON.stringify(v));
}

function asDate(v) {
    if (v == null) return null;
    return v instanceof Date ? v : new Date(v);
}

class MemoryStore {
    constructor() {
        this._accountId = 0;
        this._characterId = 0;
        this.accounts = new Map();
        this.accountsByEmail = new Map();
        this.sessions = new Map();
        this.characters = new Map();
        this.charactersByName = new Map();
        this.skills = new Map();
        this.state = new Map();
        this.playTokens = new Map();
        this.ipBans = new Map();
        this.accountBans = new Map();
        this.worldGround = null;
    }

    async ping() {
        return true;
    }

    async close() {}

    async createAccount({ email, passwordHash }) {
        const key = email.toLowerCase();
        if (this.accountsByEmail.has(key)) {
            throw new DuplicateError('email');
        }
        this._accountId += 1;
        const row = {
            id: this._accountId,
            email: key,
            passwordHash,
            createdAt: new Date(),
            status: 'active',
            failedLogins: 0,
            lockedUntil: null,
            lastLoginAt: null,
            lastLoginIp: null
        };
        this.accounts.set(row.id, row);
        this.accountsByEmail.set(key, row.id);
        return { id: row.id, email: row.email, status: row.status, createdAt: row.createdAt };
    }

    async findAccountByEmail(email) {
        const id = this.accountsByEmail.get(String(email).toLowerCase());
        if (!id) return null;
        return this._account(id);
    }

    async findAccountById(id) {
        return this._account(id);
    }

    _account(id) {
        const row = this.accounts.get(Number(id));
        if (!row) return null;
        return {
            id: row.id,
            email: row.email,
            passwordHash: row.passwordHash,
            createdAt: row.createdAt,
            status: row.status,
            failedLogins: row.failedLogins,
            lockedUntil: row.lockedUntil,
            lastLoginAt: row.lastLoginAt,
            lastLoginIp: row.lastLoginIp
        };
    }

    async updateAccountLoginMeta(id, patch) {
        const row = this.accounts.get(Number(id));
        if (!row) return;
        if (patch.failedLogins != null) row.failedLogins = patch.failedLogins;
        if (Object.prototype.hasOwnProperty.call(patch, 'lockedUntil')) {
            row.lockedUntil = patch.lockedUntil ? asDate(patch.lockedUntil) : null;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'lastLoginAt')) {
            row.lastLoginAt = patch.lastLoginAt ? asDate(patch.lastLoginAt) : null;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'lastLoginIp')) {
            row.lastLoginIp = patch.lastLoginIp;
        }
    }

    async createSession({ tokenHash, accountId, expiresAt, userAgent, ip }) {
        const key = tokenHash.toString('hex');
        this.sessions.set(key, {
            tokenHash: Buffer.from(tokenHash),
            accountId: Number(accountId),
            expiresAt: asDate(expiresAt),
            userAgent: userAgent || null,
            ip: ip || null
        });
    }

    async findSessionByHash(tokenHash) {
        const row = this.sessions.get(tokenHash.toString('hex'));
        if (!row) return null;
        return {
            accountId: row.accountId,
            expiresAt: row.expiresAt,
            userAgent: row.userAgent,
            ip: row.ip
        };
    }

    async deleteSession(tokenHash) {
        this.sessions.delete(tokenHash.toString('hex'));
    }

    async listCharacters(accountId) {
        const out = [];
        for (const ch of this.characters.values()) {
            if (ch.accountId === Number(accountId)) out.push(this._publicCharacter(ch));
        }
        out.sort((a, b) => a.id - b.id);
        return out;
    }

    async countCharacters(accountId) {
        let n = 0;
        for (const ch of this.characters.values()) {
            if (ch.accountId === Number(accountId)) n += 1;
        }
        return n;
    }

    async findCharacter(accountId, characterId) {
        const ch = this.characters.get(Number(characterId));
        if (!ch || ch.accountId !== Number(accountId)) return null;
        return this._publicCharacter(ch);
    }

    async findCharacterByName(name) {
        const id = this.charactersByName.get(String(name).toLowerCase());
        if (!id) return null;
        return this._publicCharacter(this.characters.get(id));
    }

    async createCharacter(input) {
        const nameKey = String(input.name).toLowerCase();
        if (this.charactersByName.has(nameKey)) {
            throw new DuplicateError('name');
        }
        this._characterId += 1;
        const ch = {
            id: this._characterId,
            accountId: Number(input.accountId),
            name: input.name,
            vocation: input.vocation,
            level: input.level,
            experience: input.experience,
            posX: input.posX,
            posY: input.posY,
            posZ: input.posZ,
            hp: input.hp,
            hpMax: input.hpMax,
            mp: input.mp,
            mpMax: input.mpMax,
            townId: input.townId,
            lastLogin: null,
            lastLogout: null,
            createdAt: new Date()
        };
        this.characters.set(ch.id, ch);
        this.charactersByName.set(nameKey, ch.id);
        this.skills.set(ch.id, Object.assign({
            fistTries: 0, clubTries: 0, swordTries: 0, axeTries: 0,
            distanceTries: 0, shieldingTries: 0, magicTries: 0, fishingTries: 0
        }, input.skills));
        this.state.set(ch.id, {
            inventory: cloneJson(input.inventory && Object.keys(input.inventory).length
                ? input.inventory
                : { items: [] }),
            storage: cloneJson(input.storage || {}),
            conditions: cloneJson(input.conditions || []),
            hotkeys: cloneJson(input.hotkeys || {}),
            appearance: cloneJson(input.appearance || {})
        });
        return this._publicCharacter(ch);
    }

    async deleteCharacter(accountId, characterId) {
        const ch = this.characters.get(Number(characterId));
        if (!ch || ch.accountId !== Number(accountId)) return false;
        this.characters.delete(ch.id);
        this.charactersByName.delete(ch.name.toLowerCase());
        this.skills.delete(ch.id);
        this.state.delete(ch.id);
        for (const [k, tok] of this.playTokens) {
            if (tok.characterId === ch.id) this.playTokens.delete(k);
        }
        return true;
    }

    async invalidatePlayTokensForCharacter(characterId) {
        for (const [k, tok] of this.playTokens) {
            if (tok.characterId === Number(characterId) && !tok.usedAt) {
                this.playTokens.delete(k);
            }
        }
    }

    async createPlayToken({ tokenHash, accountId, characterId, ip, expiresAt }) {
        const key = tokenHash.toString('hex');
        this.playTokens.set(key, {
            tokenHash: Buffer.from(tokenHash),
            accountId: Number(accountId),
            characterId: Number(characterId),
            ip: ip || null,
            expiresAt: asDate(expiresAt),
            usedAt: null
        });
    }

    async findPlayToken(tokenHash) {
        const row = this.playTokens.get(tokenHash.toString('hex'));
        if (!row) return null;
        return {
            accountId: row.accountId,
            characterId: row.characterId,
            ip: row.ip,
            expiresAt: row.expiresAt,
            usedAt: row.usedAt
        };
    }

    async markPlayTokenUsed(tokenHash, at) {
        const row = this.playTokens.get(tokenHash.toString('hex'));
        if (!row) return false;
        row.usedAt = asDate(at) || new Date();
        return true;
    }

    async consumePlayToken(tokenHash, now) {
        const row = this.playTokens.get(tokenHash.toString('hex'));
        if (!row || row.usedAt) return null;
        const t = now instanceof Date ? now.getTime() : Number(now);
        if (row.expiresAt.getTime() <= t) return null;
        row.usedAt = new Date(t);
        return {
            accountId: row.accountId,
            characterId: row.characterId,
            ip: row.ip,
            expiresAt: row.expiresAt,
            usedAt: row.usedAt
        };
    }

    async touchCharacterLogin(id, at) {
        const row = this.characters.get(Number(id));
        if (!row) return false;
        row.lastLogin = asDate(at);
        return true;
    }

    async touchCharacterLogout(id, at) {
        const row = this.characters.get(Number(id));
        if (!row) return false;
        row.lastLogout = asDate(at);
        return true;
    }

    async loadCharacterState(id) {
        const row = this.state.get(Number(id));
        if (!row) return null;
        return cloneJson(row);
    }

    async loadSkills(id) {
        const row = this.skills.get(Number(id));
        if (!row) return null;
        return {
            fist: row.fist, club: row.club, sword: row.sword, axe: row.axe,
            distance: row.distance, shielding: row.shielding, magic: row.magic, fishing: row.fishing,
            fistTries: row.fistTries | 0, clubTries: row.clubTries | 0,
            swordTries: row.swordTries | 0, axeTries: row.axeTries | 0,
            distanceTries: row.distanceTries | 0, shieldingTries: row.shieldingTries | 0,
            magicTries: row.magicTries | 0, fishingTries: row.fishingTries | 0
        };
    }

    async saveCharacter(id, snap) {
        const row = this.characters.get(Number(id));
        if (!row || !snap) return false;
        if (snap.level != null) row.level = snap.level | 0;
        if (snap.experience != null) row.experience = Number(snap.experience) || 0;
        if (snap.posX != null) row.posX = snap.posX | 0;
        if (snap.posY != null) row.posY = snap.posY | 0;
        if (snap.posZ != null) row.posZ = snap.posZ | 0;
        if (snap.hp != null) row.hp = snap.hp | 0;
        if (snap.hpMax != null) row.hpMax = snap.hpMax | 0;
        if (snap.mp != null) row.mp = snap.mp | 0;
        if (snap.mpMax != null) row.mpMax = snap.mpMax | 0;
        if (snap.lastLogout) row.lastLogout = asDate(snap.lastLogout);
        const prev = this.state.get(row.id) || {
            inventory: { items: [] },
            storage: {},
            conditions: [],
            hotkeys: {},
            appearance: {}
        };
        this.state.set(row.id, {
            inventory: cloneJson(snap.inventory != null ? snap.inventory : prev.inventory),
            storage: cloneJson(snap.storage != null ? snap.storage : prev.storage),
            conditions: cloneJson(snap.conditions != null ? snap.conditions : prev.conditions),
            hotkeys: cloneJson(snap.hotkeys != null ? snap.hotkeys : prev.hotkeys),
            appearance: cloneJson(snap.appearance != null ? snap.appearance : prev.appearance)
        });
        if (snap.skills) {
            const sk = this.skills.get(row.id) || {};
            this.skills.set(row.id, Object.assign({}, sk, snap.skills));
        }
        return true;
    }

    async loadWorldGround() {
        return this.worldGround ? cloneJson(this.worldGround) : null;
    }

    async saveWorldGround(blob) {
        this.worldGround = blob ? cloneJson(blob) : { version: 1, nextUid: 1, items: {}, containers: {}, stacks: {} };
        return true;
    }

    async isIpBanned(ip, now) {
        const row = this.ipBans.get(ip);
        if (!row) return false;
        if (row.expiresAt && row.expiresAt.getTime() <= (now || Date.now())) return false;
        return true;
    }

    async isAccountBanned(accountId, now) {
        const row = this.accountBans.get(Number(accountId));
        if (!row) return false;
        if (row.expiresAt && row.expiresAt.getTime() <= (now || Date.now())) return false;
        return true;
    }

    addIpBan(ip, reason, expiresAt) {
        this.ipBans.set(ip, { reason, expiresAt: expiresAt ? asDate(expiresAt) : null });
    }

    addAccountBan(accountId, reason, expiresAt) {
        this.accountBans.set(Number(accountId), { reason, expiresAt: expiresAt ? asDate(expiresAt) : null });
    }

    _publicCharacter(ch) {
        return {
            id: ch.id,
            accountId: ch.accountId,
            name: ch.name,
            vocation: ch.vocation,
            level: ch.level,
            experience: ch.experience,
            posX: ch.posX,
            posY: ch.posY,
            posZ: ch.posZ,
            hp: ch.hp,
            hpMax: ch.hpMax,
            mp: ch.mp,
            mpMax: ch.mpMax,
            townId: ch.townId,
            lastLogin: ch.lastLogin,
            lastLogout: ch.lastLogout,
            createdAt: ch.createdAt
        };
    }
}

module.exports = { MemoryStore };

'use strict';

const mysql = require('mysql2/promise');
const { DuplicateError } = require('./errors');
const { migrate } = require('./migrate');

function assertDbName(name) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
        throw new Error('invalid mysql database name');
    }
    return name;
}

function asJson(v, fallback) {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try {
        return JSON.parse(v);
    } catch {
        return fallback;
    }
}

function mapAccount(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        email: row.email,
        passwordHash: row.password_hash,
        createdAt: row.created_at,
        status: row.status,
        failedLogins: Number(row.failed_logins),
        lockedUntil: row.locked_until,
        lastLoginAt: row.last_login_at,
        lastLoginIp: row.last_login_ip
    };
}

function mapCharacter(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        accountId: Number(row.account_id),
        name: row.name,
        vocation: row.vocation,
        level: Number(row.level),
        experience: Number(row.experience),
        posX: Number(row.pos_x),
        posY: Number(row.pos_y),
        posZ: Number(row.pos_z),
        hp: Number(row.hp),
        hpMax: Number(row.hp_max),
        mp: Number(row.mp),
        mpMax: Number(row.mp_max),
        townId: Number(row.town_id),
        lastLogin: row.last_login,
        lastLogout: row.last_logout,
        createdAt: row.created_at
    };
}

class MysqlStore {
    constructor(pool) {
        this.pool = pool;
    }

    static async open(settings) {
        const db = assertDbName(settings.mysql.database);
        const base = {
            host: settings.mysql.host,
            port: settings.mysql.port || 3306,
            user: settings.mysql.user,
            password: settings.mysql.password,
            charset: 'utf8mb4',
            timezone: 'Z',
            supportBigNumbers: true,
            bigNumberStrings: false
        };
        const admin = await mysql.createConnection(base);
        try {
            await admin.query(
                `CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
            );
        } finally {
            await admin.end();
        }
        const pool = mysql.createPool({
            ...base,
            database: db,
            waitForConnections: true,
            connectionLimit: settings.mysql.connectionLimit || 10
        });
        await migrate(pool);
        return new MysqlStore(pool);
    }

    async ping() {
        await this.pool.query('SELECT 1');
        return true;
    }

    async close() {
        await this.pool.end();
    }

    async createAccount({ email, passwordHash }) {
        try {
            const [res] = await this.pool.query(
                'INSERT INTO accounts (email, password_hash) VALUES (?, ?)',
                [email, passwordHash]
            );
            return this.findAccountById(res.insertId);
        } catch (err) {
            if (err && err.code === 'ER_DUP_ENTRY') throw new DuplicateError('email');
            throw err;
        }
    }

    async findAccountByEmail(email) {
        const [rows] = await this.pool.query('SELECT * FROM accounts WHERE email = ? LIMIT 1', [email]);
        return mapAccount(rows[0]);
    }

    async findAccountById(id) {
        const [rows] = await this.pool.query('SELECT * FROM accounts WHERE id = ? LIMIT 1', [id]);
        return mapAccount(rows[0]);
    }

    async updateAccountLoginMeta(id, patch) {
        const fields = [];
        const values = [];
        if (patch.failedLogins != null) {
            fields.push('failed_logins = ?');
            values.push(patch.failedLogins);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'lockedUntil')) {
            fields.push('locked_until = ?');
            values.push(patch.lockedUntil);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'lastLoginAt')) {
            fields.push('last_login_at = ?');
            values.push(patch.lastLoginAt);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'lastLoginIp')) {
            fields.push('last_login_ip = ?');
            values.push(patch.lastLoginIp);
        }
        if (!fields.length) return;
        values.push(id);
        await this.pool.query(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`, values);
    }

    async createSession({ tokenHash, accountId, expiresAt, userAgent, ip }) {
        await this.pool.query(
            'INSERT INTO account_sessions (token_hash, account_id, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?)',
            [tokenHash, accountId, expiresAt, userAgent || null, ip || null]
        );
    }

    async findSessionByHash(tokenHash) {
        const [rows] = await this.pool.query(
            'SELECT account_id, expires_at, user_agent, ip FROM account_sessions WHERE token_hash = ? LIMIT 1',
            [tokenHash]
        );
        const row = rows[0];
        if (!row) return null;
        return {
            accountId: Number(row.account_id),
            expiresAt: row.expires_at,
            userAgent: row.user_agent,
            ip: row.ip
        };
    }

    async deleteSession(tokenHash) {
        await this.pool.query('DELETE FROM account_sessions WHERE token_hash = ?', [tokenHash]);
    }

    async listCharacters(accountId) {
        const [rows] = await this.pool.query(
            'SELECT * FROM characters WHERE account_id = ? ORDER BY id ASC',
            [accountId]
        );
        return rows.map(mapCharacter);
    }

    async countCharacters(accountId) {
        const [rows] = await this.pool.query(
            'SELECT COUNT(*) AS n FROM characters WHERE account_id = ?',
            [accountId]
        );
        return Number(rows[0].n);
    }

    async findCharacter(accountId, characterId) {
        const [rows] = await this.pool.query(
            'SELECT * FROM characters WHERE id = ? AND account_id = ? LIMIT 1',
            [characterId, accountId]
        );
        return mapCharacter(rows[0]);
    }

    async findCharacterByName(name) {
        const [rows] = await this.pool.query('SELECT * FROM characters WHERE name = ? LIMIT 1', [name]);
        return mapCharacter(rows[0]);
    }

    async createCharacter(input) {
        const conn = await this.pool.getConnection();
        try {
            await conn.beginTransaction();
            let insertId;
            try {
                const [res] = await conn.query(
                    `INSERT INTO characters (
                        account_id, name, vocation, level, experience,
                        pos_x, pos_y, pos_z, hp, hp_max, mp, mp_max, town_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        input.accountId, input.name, input.vocation, input.level, input.experience,
                        input.posX, input.posY, input.posZ, input.hp, input.hpMax, input.mp, input.mpMax,
                        input.townId
                    ]
                );
                insertId = res.insertId;
            } catch (err) {
                if (err && err.code === 'ER_DUP_ENTRY') throw new DuplicateError('name');
                throw err;
            }
            const sk = input.skills || {};
            await conn.query(
                `INSERT INTO character_skills (
                    character_id, fist, club, sword, axe, distance, shielding, magic, fishing
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    insertId,
                    sk.fist, sk.club, sk.sword, sk.axe, sk.distance, sk.shielding, sk.magic, sk.fishing
                ]
            );
            await conn.query(
                `INSERT INTO character_state (
                    character_id, inventory, storage, conditions, hotkeys, appearance
                ) VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    insertId,
                    JSON.stringify(input.inventory && Object.keys(input.inventory).length
                        ? input.inventory
                        : { items: [] }),
                    JSON.stringify(input.storage || {}),
                    JSON.stringify(input.conditions || []),
                    JSON.stringify(input.hotkeys || {}),
                    JSON.stringify(input.appearance || {})
                ]
            );
            await conn.commit();
            return this.findCharacter(input.accountId, insertId);
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    }

    async deleteCharacter(accountId, characterId) {
        const [res] = await this.pool.query(
            'DELETE FROM characters WHERE id = ? AND account_id = ?',
            [characterId, accountId]
        );
        return res.affectedRows > 0;
    }

    async invalidatePlayTokensForCharacter(characterId) {
        await this.pool.query(
            'DELETE FROM play_tokens WHERE character_id = ? AND used_at IS NULL',
            [characterId]
        );
    }

    async createPlayToken({ tokenHash, accountId, characterId, ip, expiresAt }) {
        await this.pool.query(
            `INSERT INTO play_tokens (token_hash, account_id, character_id, ip, expires_at)
             VALUES (?, ?, ?, ?, ?)`,
            [tokenHash, accountId, characterId, ip || null, expiresAt]
        );
    }

    async findPlayToken(tokenHash) {
        const [rows] = await this.pool.query(
            'SELECT account_id, character_id, ip, expires_at, used_at FROM play_tokens WHERE token_hash = ? LIMIT 1',
            [tokenHash]
        );
        const row = rows[0];
        if (!row) return null;
        return {
            accountId: Number(row.account_id),
            characterId: Number(row.character_id),
            ip: row.ip,
            expiresAt: row.expires_at,
            usedAt: row.used_at
        };
    }

    async markPlayTokenUsed(tokenHash, at) {
        const [res] = await this.pool.query(
            'UPDATE play_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL',
            [at, tokenHash]
        );
        return res.affectedRows > 0;
    }

    async consumePlayToken(tokenHash, now) {
        const at = now instanceof Date ? now : new Date(now);
        const conn = await this.pool.getConnection();
        try {
            await conn.beginTransaction();
            const [rows] = await conn.query(
                `SELECT account_id, character_id, ip, expires_at, used_at
                 FROM play_tokens WHERE token_hash = ? LIMIT 1 FOR UPDATE`,
                [tokenHash]
            );
            const row = rows[0];
            if (!row || row.used_at) {
                await conn.rollback();
                return null;
            }
            const exp = row.expires_at instanceof Date
                ? row.expires_at.getTime()
                : new Date(row.expires_at).getTime();
            if (exp <= at.getTime()) {
                await conn.rollback();
                return null;
            }
            await conn.query(
                'UPDATE play_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL',
                [at, tokenHash]
            );
            await conn.commit();
            return {
                accountId: Number(row.account_id),
                characterId: Number(row.character_id),
                ip: row.ip,
                expiresAt: row.expires_at,
                usedAt: at
            };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    }

    async touchCharacterLogin(id, at) {
        const [res] = await this.pool.query(
            'UPDATE characters SET last_login = ? WHERE id = ?',
            [at, id]
        );
        return res.affectedRows > 0;
    }

    async touchCharacterLogout(id, at) {
        const [res] = await this.pool.query(
            'UPDATE characters SET last_logout = ? WHERE id = ?',
            [at, id]
        );
        return res.affectedRows > 0;
    }

    async loadCharacterState(id) {
        const [rows] = await this.pool.query(
            'SELECT inventory, storage, conditions, hotkeys, appearance FROM character_state WHERE character_id = ? LIMIT 1',
            [id]
        );
        const row = rows[0];
        if (!row) return null;
        return {
            inventory: asJson(row.inventory, { items: [] }),
            storage: asJson(row.storage, {}),
            conditions: asJson(row.conditions, []),
            hotkeys: asJson(row.hotkeys, {}),
            appearance: asJson(row.appearance, {})
        };
    }

    async loadSkills(id) {
        const [rows] = await this.pool.query(
            `SELECT fist, club, sword, axe, distance, shielding, magic, fishing,
                    fist_tries, club_tries, sword_tries, axe_tries,
                    distance_tries, shielding_tries, magic_tries, fishing_tries
             FROM character_skills WHERE character_id = ? LIMIT 1`,
            [id]
        );
        const row = rows[0];
        if (!row) return null;
        return {
            fist: Number(row.fist),
            club: Number(row.club),
            sword: Number(row.sword),
            axe: Number(row.axe),
            distance: Number(row.distance),
            shielding: Number(row.shielding),
            magic: Number(row.magic),
            fishing: Number(row.fishing),
            fistTries: Number(row.fist_tries) || 0,
            clubTries: Number(row.club_tries) || 0,
            swordTries: Number(row.sword_tries) || 0,
            axeTries: Number(row.axe_tries) || 0,
            distanceTries: Number(row.distance_tries) || 0,
            shieldingTries: Number(row.shielding_tries) || 0,
            magicTries: Number(row.magic_tries) || 0,
            fishingTries: Number(row.fishing_tries) || 0
        };
    }

    async saveCharacter(id, snap) {
        if (!snap) return false;
        const conn = await this.pool.getConnection();
        try {
            await conn.beginTransaction();
            const fields = [
                'level = ?', 'experience = ?', 'pos_x = ?', 'pos_y = ?', 'pos_z = ?',
                'hp = ?', 'hp_max = ?', 'mp = ?', 'mp_max = ?'
            ];
            const values = [
                snap.level | 0,
                Number(snap.experience) || 0,
                snap.posX | 0,
                snap.posY | 0,
                snap.posZ | 0,
                snap.hp | 0,
                snap.hpMax | 0,
                snap.mp | 0,
                snap.mpMax | 0
            ];
            if (snap.lastLogout) {
                fields.push('last_logout = ?');
                values.push(snap.lastLogout);
            }
            values.push(id);
            const [res] = await conn.query(
                `UPDATE characters SET ${fields.join(', ')} WHERE id = ?`,
                values
            );
            if (!res.affectedRows) {
                await conn.rollback();
                return false;
            }
            await conn.query(
                `UPDATE character_state SET
                    inventory = ?, storage = ?, conditions = ?, hotkeys = ?, appearance = ?
                 WHERE character_id = ?`,
                [
                    JSON.stringify(snap.inventory != null ? snap.inventory : { items: [] }),
                    JSON.stringify(snap.storage != null ? snap.storage : {}),
                    JSON.stringify(snap.conditions != null ? snap.conditions : []),
                    JSON.stringify(snap.hotkeys != null ? snap.hotkeys : {}),
                    JSON.stringify(snap.appearance != null ? snap.appearance : {}),
                    id
                ]
            );
            if (snap.skills) {
                const sk = snap.skills;
                await conn.query(
                    `UPDATE character_skills SET
                        fist = ?, club = ?, sword = ?, axe = ?, distance = ?,
                        shielding = ?, magic = ?, fishing = ?,
                        fist_tries = ?, club_tries = ?, sword_tries = ?, axe_tries = ?,
                        distance_tries = ?, shielding_tries = ?, magic_tries = ?, fishing_tries = ?
                     WHERE character_id = ?`,
                    [
                        sk.fist | 0, sk.club | 0, sk.sword | 0, sk.axe | 0, sk.distance | 0,
                        sk.shielding | 0, sk.magic | 0, sk.fishing | 0,
                        sk.fistTries | 0, sk.clubTries | 0, sk.swordTries | 0, sk.axeTries | 0,
                        sk.distanceTries | 0, sk.shieldingTries | 0, sk.magicTries | 0, sk.fishingTries | 0,
                        id
                    ]
                );
            }
            await conn.commit();
            return true;
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    }

    async isIpBanned(ip, now) {
        const [rows] = await this.pool.query(
            'SELECT expires_at FROM ip_bans WHERE ip = ? LIMIT 1',
            [ip]
        );
        const row = rows[0];
        if (!row) return false;
        if (row.expires_at && new Date(row.expires_at).getTime() <= (now || Date.now())) return false;
        return true;
    }

    async isAccountBanned(accountId, now) {
        const [rows] = await this.pool.query(
            'SELECT expires_at FROM account_bans WHERE account_id = ? LIMIT 1',
            [accountId]
        );
        const row = rows[0];
        if (!row) return false;
        if (row.expires_at && new Date(row.expires_at).getTime() <= (now || Date.now())) return false;
        return true;
    }
}

module.exports = { MysqlStore, asJson };

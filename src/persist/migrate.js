'use strict';

const fs = require('fs');
const path = require('path');
const { SERVER_ROOT } = require('../config/load_settings');

function splitSql(text) {
    const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, '');
    const lines = withoutBlock.split('\n').map((line) => {
        const i = line.indexOf('--');
        return i >= 0 ? line.slice(0, i) : line;
    });
    const joined = lines.join('\n');
    return joined
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

async function migrate(pool, opts = {}) {
    const root = opts.root || SERVER_ROOT;
    const dir = path.join(root, 'sql');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id VARCHAR(64) NOT NULL,
            applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
        const [rows] = await pool.query('SELECT id FROM schema_migrations WHERE id = ?', [file]);
        if (rows.length) continue;
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        const statements = splitSql(sql);
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            for (const stmt of statements) {
                await conn.query(stmt);
            }
            await conn.query('INSERT INTO schema_migrations (id) VALUES (?)', [file]);
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    }
}

module.exports = { migrate, splitSql };

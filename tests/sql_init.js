'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SERVER_ROOT } = require('../src/config/load_settings');
const { splitSql } = require('../src/persist/migrate');

function main() {
    const sql = fs.readFileSync(path.join(SERVER_ROOT, 'sql', '001_init.sql'), 'utf8');
    const stmts = splitSql(sql);
    assert.ok(stmts.length >= 8);
    const joined = sql.toLowerCase();
    for (const table of [
        'accounts', 'account_sessions', 'characters', 'character_skills',
        'character_state', 'play_tokens', 'ip_bans', 'account_bans'
    ]) {
        assert.ok(joined.includes(`create table if not exists ${table}`), table);
    }
    assert.ok(joined.includes('utf8mb4'));
    assert.ok(joined.includes('inventory json'));
    assert.ok(joined.includes('storage json'));
    assert.ok(!/index\s*\(\s*password/i.test(sql));
    assert.ok(!/sha1/i.test(sql));
    assert.ok(!/profile\s+(json|text)/i.test(sql));
    console.log('ok sql_init');
}

main();

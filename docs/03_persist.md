# 03. Persist / settings

Hybrid MySQL: relational identity + JSON bags on `character_state`. Prefer **MySQL 8** (`JSON` type). MariaDB 10.x JSON is LONGTEXT+check — OK for local S1 only.

## Do not

- One `profile` TEXT/JSON for the whole character.
- Password in committed `settings.json`.
- Log merged config / `settings.local.json`.
- Index password hashes. SHA1.
- Client 10 s save. SQL on the tick. SQL on loot/shop. `persistSoonMs`.
- Trust `X-Forwarded-For` unless `trustedProxy: true`.
- Bind MySQL to a public interface.

## Settings merge

1. `config/settings.json` (committed). `mysql.password` stripped if present.
2. `config/settings.local.json` if present — **deep-merge** (objects merge, arrays replace).
3. `GAME_*` env. Env wins.

Required secret: `GAME_MYSQL_PASSWORD` or `mysql.password` in the **local** overlay. Boot fails if missing.

| Committed | Local overlay | Env |
| :--- | :--- | :--- |
| `logicUps: 20`, rate limits, vocations | bind, log level, mysql host/user/db | `GAME_MYSQL_PASSWORD` |
| packet cap, `pvp: false`, `globalSaveTime`, `persistIntervalMs`, `contentPath` | `httpPort`, `maxPlayers`, `mapId` | `GAME_BIND`, `GAME_HTTP_PORT`, `GAME_LOG_LEVEL`, `GAME_GLOBAL_SAVE_*`, `GAME_PERSIST_*`, `GAME_CONTENT_PATH`, `GAME_MAP_ID` |

## Tables (`sql/001_init.sql`)

| Table | Why columns vs JSON |
| :--- | :--- |
| `accounts` | email UNIQUE, lockout, status |
| `account_sessions` | `token_hash` BINARY(32) — raw cookie never stored |
| `characters` | name UNIQUE, voc, level, exp, pos, hp/mp |
| `character_skills` | levels + `*_tries` toward next (skill try progress / ML mana) |
| `character_state` | `inventory` `storage` `conditions` `hotkeys` `appearance` JSON |
| `play_tokens` | one-time game token, hashed |
| `ip_bans` `account_bans` | expiry + reason |

Passwords: **argon2id** PHC (`crypto.argon2`, Node 24+). OWASP pin: m=19456, t=2, p=1.

**Saves** (never on the 50 ms tick). Clone snapshot after a persist slot, then `store.saveCharacter`. World (creatures, corpses, occupancy) is RAM until process exit — not SQL. Character bag / pos / HP / quest flags are RAM while online.

| Event | Save |
| :--- | :--- |
| Logout / disconnect / SIGINT / SIGTERM | Always, full snapshot (`last_logout` set) |
| Interval `persistIntervalMs` | **All** online (`last_logout` unchanged). No process exit. Default **1 hour**. `0` disables |
| Wall-clock `globalSaveTime` | **All** online (`last_logout` unchanged). Then process exit if `globalSaveShutdown` |
| Loot, shop, quest, walk, HP, exp, level, skills, death | RAM only until logout / interval / wall-clock |
| Client timer | **Never** |

Do **not** debounce-save on loot/shop. Those fire at hunt rate; at 1000 online that is SQL-bound, not player-bound. Interval + logout is the 1000-player path. Trade/bank/mail (when they exist) save the two characters involved, not a 500 ms timer.

| Knob | Default |
| :--- | :--- |
| `persistIntervalMs` | **3600000** (1 hour; `0` disables). Production: minutes/hours, not sub-second |
| `persistConcurrency` | **8** (cap concurrent character transactions; keep `< mysql.connectionLimit`) |
| `mysql.connectionLimit` | **10** |
| `globalSaveTime` | **`06:00`** local (`HH:MM` or `HH:MM:SS`; empty disables) |
| `globalSaveNotifyMinutes` | **5** (`SAY` once at T−N; 0 skips) |
| `globalSaveShutdown` | **true** |

Env: `GAME_GLOBAL_SAVE_TIME`, `GAME_GLOBAL_SAVE_NOTIFY_MINUTES`, `GAME_GLOBAL_SAVE_SHUTDOWN`, `GAME_PERSIST_INTERVAL_MS`, `GAME_PERSIST_CONCURRENCY`. Tests set `globalSaveTime: ""` and `persistIntervalMs: 0`.

Inventory JSON: runtime tree `{ version: 1, nextUid, items, containers, rootUid, equipment }` (nested bags + slots). Flat `{ items: [{ id, count }] }` still loads (migrates into an equipped backpack). Storage JSON: quest flags object. Unset keys read as 0. Downed logout writes town spawn + full HP.

S2: `consumePlayToken` (atomic unused+unexpired). `touchCharacterLogin` off-tick. Logout persist writes `last_logout`.

## Key files

| Path | Role |
| :--- | :--- |
| `src/config/load_settings.js` | merge + env |
| `src/persist/mysql_store.js` | live store |
| `src/persist/memory_store.js` | tests only |
| `src/persist/migrate.js` | apply `sql/*.sql` |
| `src/persist/persist_gate.js` | concurrent-save cap |
| `src/world/snapshot.js` | clone bag tree / storage / skills |
| `src/world/inventory.js` | runtime tree + cap |
| `src/world/clock_save.js` | wall-clock parse / next fire |
| `src/security/password.js` | argon2id |

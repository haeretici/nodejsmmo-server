# 02. Protocol

v1 pipe is **WebSocket only** (`ws` / `wss`). Binary frames. Play token from `POST /v1/play`.

## Do not

- WebTransport / raw UDP / custom reliability.
- Passwords on the game socket.
- Token in the URL or query string.
- Copy dump opcodes, XTEA, RSA, checksum flavors.
- Send the whole continent, other players’ inventories, or loot tables.
- Persist action-bar / hotkey JSON. Bars are browser prefs; fire is `CAST` / `USE_ITEM` / `EQUIP`.
- Run player A* or chase on this process. Client sends dirs (`MOVE_PATH` / `MOVE_STEP`). Occupancy, bag, target, auto-swing stay here.

## Frame (little-endian)

```text
[opcode u16][seq u32][payload…]
```

`PROTOCOL_VERSION = 1`. Path: `GET /v1/ws` upgrade on the HTTP listener. TLS at the reverse proxy; this process speaks `ws` on `bind`.

Client seq and server seq are independent, both start at **1**, monotonic. Bad seq → `REJECT` (after enter) or kick (before enter).

Max frame: `limits.maxWsFrameBytes` **4096**. Text frames, short frames, oversize → close `BAD_FRAME`.

## Auth

1. HTTP session cookie (see 06) → `POST /v1/play` → 32-byte token (hex on HTTP).
2. Open `/v1/ws`. Server sends `HELLO`.
3. Client `ENTER` seq=1, payload = **32 raw bytes** (not hex).
4. Server consumes token (one-shot, hashed). Failure is always `BAD_TOKEN` (no used/expired split).
5. `limits.playTokenBindIp` default **false**. If true, token IP must match.

Enter deadline: `wsEnterTimeoutMs` **10000**. One online character per account (`maxPlayersOnlinePerAccount`). Same character reconnect with a new token kicks the old socket `REPLACED`.

## Opcodes

| C2S | id | Payload |
| :--- | ---: | :--- |
| `ENTER` | 1 | token 32 B (only before enter) |
| `PING` | 2 | `clientMs u32` |
| `LOGOUT` | 3 | empty |
| `MOVE_STEP` | 10 | `dir u8` N=0 E=1 S=2 W=3 — orthogonal; occupancy + `stepDelayTicks`. Clears a queued `MOVE_PATH`. Landing on `stairs`/`hole` hops. Keyboard. Extra before ready → `REJECT BUSY` |
| `SET_TARGET` | 11 | `id u32` (0 = clear). Auto-swing when in weapon range |
| *(unused)* | 12 | Do not reuse. Chase is client `MOVE_PATH` |
| `USE_STAIR` | 13 | empty. Standing on a registered pad (type-blind, including ladder). Same `stepDelayTicks`. Clears a queued `MOVE_PATH` |
| `USE` | 14 | `x i16 y i16 z i8`. World pin on that tile. Chebyshev ≤ **1**, same `z`. Container opens `CONTAINER`; chest/lever/door/teleport/harvest run; trap / unknown → `SAY` |
| `USE_ITEM_WITH` | 15 | `x i16 y i16 z i8` + `itemId str`. Rope/shovel Use-with. Chebyshev ≤ **1**, same `z`. Does not consume the tool |
| `CAST` | 16 | `spellId str`, `targetId u32`, `x i16 y i16 z i8`. Server admits (P12). Bars: `../frontend/docs/03_action_bars.md` |
| *(unused)* | 17 | Do not reuse. Bars are client IndexedDB; fire is `CAST` / `USE_ITEM` / `EQUIP` |
| `MOVE_PATH` | 18 | `n u8` + `n × dir u8` (N=0 E=1 S=2 W=3). Click-to-walk / chase. Cap `movePathMaxSteps` **165**. `n=0` clears the queue. Replaces remaining dirs (no `BUSY` reject). This process consumes **one** dir per `moveReadyTick`, occupancy each step. Blocked → stop + `REJECT BLOCKED`. Client does **not** send a landing tile |
| `OPEN_CORPSE` | 20 | `id u32` Chebyshev ≤ 1 |
| `LOOT_TAKE` | 21 | `corpseId u32`, `slot u8` |
| `LOOT_CLOSE` | 22 | `id u32` |
| `TALK` | 30 | `npcId u32` Chebyshev ≤ **3** |
| `TALK_REPLY` | 31 | `npcId u32`, `index u8` (visible replies only) |
| `TALK_CLOSE` | 32 | `npcId u32` (0 = current) |
| `SHOP_BUY` | 33 | `npcId u32`, `count u16`, `itemId str` |
| `SHOP_SELL` | 34 | same as buy |
| `EQUIP` | 40 | `containerId str`, `index u8`, `slot str` (empty = preferred). Designer or engine slot names |
| `UNEQUIP` | 41 | `slot str` into backpack |
| `MOVE_ITEM` | 42 | from loc + to loc + `count u16` (0 = all). Loc: `kind u8` 0=container (`id str` `index u8`) 1=equipment (`slot str`) |
| `USE_ITEM` | 43 | `containerId str`, `index u8` — equip / open bag / consume (`heal` / `restoreMana` arrays, food regen, dispel, condition; empty-effect `usable` still consume) |
| `OPEN_BAG` | 44 | `containerId str`, `index u8` nested container |

| S2C | id | Payload |
| :--- | ---: | :--- |
| `HELLO` | 100 | `protocol u16`, `ups u8`, `tickIndex u32`, `enterTimeoutMs u16` |
| `ENTER_WORLD` | 101 | self + viewport (see below) |
| `KICK` | 102 | `reason u8` |
| `REJECT` | 103 | `refSeq u32`, `reason u8` |
| `PONG` | 104 | `clientMs u32`, `serverMs u32`, `tickIndex u32` |
| `VIEWPORT` | 110 | same tile window as `ENTER_WORLD` (sent to mover after a step) |
| `APPEAR` | 111 | `id u32`, name, `x i16 y i16 z i8`, `hp u16 hpMax u16`, `flags u8`, `look str` (creature kind or vocation), extra `dir u8` (N=0 E=1 S=2 W=3). Extra bytes ignored |
| `DISAPPEAR` | 112 | `id u32` |
| `MOVE` | 113 | `id u32`, `x i16 y i16 z i8`, `dir u8` |
| `STATS` | 114 | `id u32`, hp/mp u16×4 |
| `SWING` | 115 | `sourceId u32`, `targetId u32`, `amount u16`, `flags u8` (1=miss, 2=death, 4=crit, 8=fatal), extra `element u8` + `weaponId str` + `ammoId str`. Extra bytes ignored |
| `DEATH` | 116 | `id u32`, `killerId u32` |
| `CORPSE` | 117 | `id u32`, `x i16 y i16 z i8`, name |
| `CORPSE_GONE` | 118 | `id u32` |
| `CONTAINER` | 119 | `id u32`, `n u8`, then n× (`id str`, `count u16`) |
| `ITEM_GAIN` | 120 | `id str`, `count u16` |
| `EXP` | 121 | `experience u32`, `gained u32`, optional `level u16` (extra bytes ignored) |
| `INVENTORY` | 122 | backpack: `containerId str`, `capacity u8`, `n u8`, n× (`index u8`, `id str`, `count u16`, `flags u8`). Flag 1 = nested container |
| `SAY` | 123 | `text str` (fail / system), extra `speakerId u32` (0 = system) + `yell u8`. Extra bytes ignored |
| `SKILLS` | 124 | 8× `u16`: fist, club, sword, axe, distance, shielding, magic, fishing. Sent on enter and skill level-up. Extra bytes ignored |
| `WORLD_PIN` | 125 | `id u32`, `x i16 y i16 z i8`, `kind str`, `catalogId str`, `flags u8` (`1` blocking, `2` pickupable). Viewport AOI. Extra bytes ignored |
| `WORLD_PIN_GONE` | 126 | `id u32` |
| `EQUIPMENT` | 127 | `cap u16`, `capMax u16`, `n u8`, n× (`slot str`, `id str`, `count u16`). Designer slot names. Sent with inventory |
| `BAG` | 128 | same payload as `INVENTORY` for the open nested bag. Empty `containerId` closes it |
| `CAST` | 129 | `sourceId u32`, `spellId str`, `targetId u32`, `x i16 y i16 z i8`, `flags u8`. FX after accepted cast |
| `DIALOG` | 130 | `npcId u32`, `nodeId str`, `text str`, `n u8`, n× `label str` |
| `DIALOG_CLOSE` | 131 | `npcId u32` |
| `SHOP` | 132 | `npcId u32`, `currency str`, `n u8`, n× (`id str`, `buy u16`, `sell u16`) |
| `FIELD` | 133 | `x i16 y i16 z i8`, `kind str`, `flags u8`, extra `createdTick u32` (logic tick at plant). Extra bytes ignored |
| `FIELD_GONE` | 134 | `x i16 y i16 z i8` |
| *(unused)* | 135 | Do not reuse. Bars are client IndexedDB |

`ENTER_WORLD`: `id u32`, name, vocation, `level u16`, `experience u32`, hp/mp u16×4, `x i16 y i16 z i8`, `townId u16`, then viewport: `originX i16 originY i16 z i8 w u8 h u8 tiles u16[w*h]`. Viewport `z` is the player floor. `tiles` are friction-derived debug ids (`0` void, `1` walk, `3` wall, `4` water, `5` town) — not visual stamps. Strings: `u8 len` + UTF-8.

## Admit

One function: `World.enqueueIntent`. After enter only: legal opcode, expected seq, queue depth ≤ `maxIntentsPerTick` **5**. Applied on the 20 UPS tick. Rejects never “run anyway.”

## Rate limits

| Knob | Default |
| ---: | ---: |
| `maxPacketsPerSecond` | 30 |
| `packetBurst` | 10 |
| `maxIntentsPerTick` | 5 |
| `maxConnectionsPerIp` | 8 (TCP, already S1) |
| `malformedClosesPerMin` | 10 → ignore IP `malformedIgnoreSec` **60** |

Packet flood → kick `RATE_LIMITED`. Close code = `4000 + reason`. Clients MUST NOT dump OS key-repeat onto `MOVE_STEP` (first down immediate; auto-repeat after **200** ms; interval ≥ step delay). Click-to-walk is one `MOVE_PATH`, not a drip of `MOVE_STEP`.

## Reasons

`BAD_FRAME=1` `BAD_TOKEN=2` `UNAUTHORIZED=5` `WORLD_FULL=6` `ALREADY_ONLINE=7` `RATE_LIMITED=8` `UNKNOWN_OPCODE=9` `NOT_IMPLEMENTED=10` `NOT_ENTERED=11` `TIMEOUT=12` `IP_MISMATCH=13` `BANNED=14` `REPLACED=15` `LOGOUT=16` `BAD_SEQ=17` `BLOCKED=18` `BUSY=19` `NO_TARGET=20` `OUT_OF_RANGE=21`

`BLOCKED` = dest not walkable / occupancy deny / bad dir / `MOVE_PATH` over cap / PvP-off player target / talkable NPC target / stair dest deny. Mid-path occupancy fail stops the queue and `REJECT`s the path seq. `BUSY` = `MOVE_STEP` / `USE_STAIR` before `stepDelayTicks`, or non-`PING`/`LOGOUT` while downed. `MOVE_PATH` while not ready **replaces** the queue and waits. `NO_TARGET=20` unknown / empty slot / bad reply index / `USE_STAIR` with no pad. `OUT_OF_RANGE=21` corpse farther than Chebyshev 1, NPC farther than **3**, or `USE` / `USE_ITEM_WITH` farther than Chebyshev **1**. Do not renumber existing codes.

`APPEAR` ends with `flags u8` (`1` = NPC) then `look str` (catalog / vocation id for sprites) then extra `dir u8`. Extra bytes after older fields stay backward compatible. The game process still does **not** send visual stamps.

`SWING` extra `element u8`: 0 physical, 1 fire, 2 ice, 3 energy, 4 earth, 5 death, 6 holy, 7 healing, 8 poison, 9 lifedrain, 10 manadrain. Empty weapon/ammo strings when none. `FIELD` extra `createdTick` is `tickIndex` at deploy (`createdAt` logic seconds × `logicUps`). `SAY` extra `speakerId` is the talking entity (NPC idle voice); `0` is a system line. `yell` 1 = shout tint. Old decoders ignore the extra bytes.

## Key files

| Path | Role |
| :--- | :--- |
| `src/protocol/opcodes.js` | ids |
| `src/protocol/frame.js` | encode/decode header |
| `src/protocol/messages.js` | payloads |
| `src/ws/game.js` | `/v1/ws` |
| `src/world/world.js` | admit + presence |
| `static/debug.html` | loopback click test (`GET /debug`) |

S6 frontend (`../frontend`) uses this pipe. Do not add WebTransport. Play token stays in the ENTER payload, never the URL.

P18 bars fire `CAST` **16** / `USE_ITEM` / `EQUIP` only. No hotkeys JSON on the socket. Contract: `../frontend/docs/03_action_bars.md`.

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
| `MOVE_STEP` | 10 | `dir u8` N=0 E=1 S=2 W=3 SW=4 SE=5 NW=6 NE=7. Occupancy + step delay. A diagonal step uses `moveDiagonalFactor` (default **2**) on the friction×speed delay, and is refused when both adjacent cardinal tiles are closed. Clears a queued `MOVE_PATH`. Landing on `stairs`/`hole` hops. Keyboard, including a two-key chord. Extra before ready → `REJECT BUSY` |
| `SET_TARGET` | 11 | `id u32` (0 = clear). Auto-swing when in weapon range |
| *(unused)* | 12 | Do not reuse. Chase is client `MOVE_PATH` |
| `USE_STAIR` | 13 | empty. Standing on a registered pad (type-blind, including ladder). Same `stepDelayTicks`. Clears a queued `MOVE_PATH` |
| `USE` | 14 | `x i16 y i16 z i8`. World pin on that tile. Chebyshev ≤ **1**, same `z`. Container opens `CONTAINER`; chest/lever/door/teleport/harvest run; trap / unknown → `SAY` |
| `USE_ITEM_WITH` | 15 | `x i16 y i16 z i8` + `itemId str`. Rope/shovel Use-with. Chebyshev ≤ **1**, same `z`. Does not consume the tool |
| `CAST` | 16 | `spellId str`, `targetId u32`, `x i16 y i16 z i8`. Server admits (P12). Bars: `../frontend/docs/03_action_bars.md` |
| *(unused)* | 17 | Do not reuse. Bars are client IndexedDB; fire is `CAST` / `USE_ITEM` / `EQUIP` |
| `MOVE_PATH` | 18 | `n u8` + `n × dir u8` (N=0 E=1 S=2 W=3 SW=4 SE=5 NW=6 NE=7). Click-to-walk / chase. Cap `movePathMaxSteps` **165**. `n=0` clears the queue. Replaces remaining dirs (no `BUSY` reject). This process consumes **one** dir per `moveReadyTick`, occupancy and the diagonal delay each step. Blocked → stop + `REJECT BLOCKED`. Client does **not** send a landing tile |
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
| `MOVE_ITEM` | 42 | from loc + to loc + `count u16` (0 = all). Loc: `kind u8` 0=container (`id str` `index u8`) 1=equipment (`slot str`) 2=tile (`x i16 y i16 z i8` + `stackIndex u8`, **0 = top**). Pickup / drop / tile slide are this opcode. No `PICKUP`/`DROP` C2S |
| `USE_ITEM` | 43 | `containerId str`, `index u8` — equip / open bag / consume (`heal` / `restoreMana` arrays, food satiation, dispel, condition; empty-effect `usable` still consume). Food adds `nutrition` × 12 seconds (cap 1200 while already fed; `You are full.` does not consume). Index **255** names a ground uid and uses that tile item in place (open a container, spend a consumable on the tile, equip onto the paperdoll, or cast a rune from the tile). Chebyshev ≤ **1**, same `z`. The server does not path |
| `OPEN_BAG` | 44 | `containerId str`, `index u8`. Nested bag: parent uid + slot `0–254`. Equipped container: designer slot name (`shield`, `backpack`, …) + index 0. Ground bag from canvas: GROUND uid + index **255** (open that uid). Ground nested: parent ground uid + slot |
| `CLOSE_BAG` | 45 | `containerId str` (instance uid). Empty string closes all open bags |
| `BROWSE_FIELD` | 46 | `x i16 y i16 z i8`. In range (Chebyshev ≤ 1, same `z`) the server watches that tile and answers with S2C `BROWSE_FIELD`. Farther, or another floor: `REJECT` `OUT_OF_RANGE` and no snapshot. The server does not path |
| `BROWSE_FIELD_CLOSE` | 47 | same tile. Drops that session’s watch. No snapshot |
| `TRADE_OFFER` | 48 | from loc (same as `MOVE_ITEM`) then `partnerId u32`. One item, or one container and its contents. The whole stack |
| `TRADE_ACCEPT` | 49 | empty. Legal only when both sides have an offer. Sticks. A second accept from the same side is ignored |
| `TRADE_CANCEL` | 50 | empty. No session: no reply |

| S2C | id | Payload |
| :--- | ---: | :--- |
| `HELLO` | 100 | `protocol u16`, `ups u8`, `tickIndex u32`, `enterTimeoutMs u16` |
| `ENTER_WORLD` | 101 | self + viewport (see below) |
| `KICK` | 102 | `reason u8` |
| `REJECT` | 103 | `refSeq u32`, `reason u8` |
| `PONG` | 104 | `clientMs u32`, `serverMs u32`, `tickIndex u32` |
| `VIEWPORT` | 110 | same tile window as `ENTER_WORLD` (sent to mover after a step) |
| `APPEAR` | 111 | `id u32`, name, `x i16 y i16 z i8`, `hp u32 hpMax u32`, `flags u8`, `look str` (creature kind or vocation), extra `dir u8` (N=0 E=1 S=2 W=3 SW=4 SE=5 NW=6 NE=7). Extra bytes ignored |
| `DISAPPEAR` | 112 | `id u32` |
| `MOVE` | 113 | `id u32`, `x i16 y i16 z i8`, `dir u8` (N=0 E=1 S=2 W=3 SW=4 SE=5 NW=6 NE=7) |
| `STATS` | 114 | `id u32`, `hp u32`, `hpMax u32`, `mp u32`, `mpMax u32`, `foodSec u16`. Fixed 22 bytes. `foodSec` is remaining food seconds on a player (0 = hungry). Creatures send 0 |
| `SWING` | 115 | `sourceId u32`, `targetId u32`, `amount u16`, `flags u8` (1=miss, 2=death, 4=crit, 8=fatal), extra `element u8` + `weaponId str` + `ammoId str`. Extra bytes ignored |
| `DEATH` | 116 | `id u32`, `killerId u32` |
| `CORPSE` | 117 | `id u32`, `x i16 y i16 z i8`, name |
| `CORPSE_GONE` | 118 | `id u32` |
| `CONTAINER` | 119 | `id u32`, `n u8`, then n× (`id str`, `count u16`) |
| `ITEM_GAIN` | 120 | `id str`, `count u16` |
| `EXP` | 121 | `experience u64`, `gained u64`, `level u16`. Fixed 18 bytes |
| `INVENTORY` | 122 | backpack: `containerId str`, `capacity u8`, `n u8`, n× (`index u8`, `id str`, `count u16`, `flags u8`). Flag 1 = nested container |
| `SAY` | 123 | `text str` (fail / system), extra `speakerId u32` (0 = system) + `yell u8`. Extra bytes ignored |
| `SKILLS` | 124 | 8× `u16`: fist, club, sword, axe, distance, shielding, magic, fishing. Sent on enter and skill level-up. Extra bytes ignored |
| `WORLD_PIN` | 125 | `id u32`, `x i16 y i16 z i8`, `kind str`, `catalogId str`, `flags u8` (`1` blocking, `2` pickupable). Viewport AOI. Extra bytes ignored |
| `WORLD_PIN_GONE` | 126 | `id u32` |
| `EQUIPMENT` | 127 | `cap u16`, `capMax u16`, `n u8`, n× (`slot str`, `id str`, `count u16`, `flags u8`). Designer slot names. Flag 1 = container. Sent with inventory |
| `BAG` | 128 | same payload as `INVENTORY` for one open nested bag. One stream per open uid (cap 8). Empty `containerId` closes all; `capacity` 0 closes that uid |
| `CAST` | 129 | `sourceId u32`, `spellId str`, `targetId u32`, `x i16 y i16 z i8`, `flags u8`. FX after accepted cast |
| `DIALOG` | 130 | `npcId u32`, `nodeId str`, `text str`, `n u8`, n× `label str` |
| `DIALOG_CLOSE` | 131 | `npcId u32` |
| `SHOP` | 132 | `npcId u32`, `currency str`, `n u8`, n× (`id str`, `buy u16`, `sell u16`) |
| `FIELD` | 133 | `x i16 y i16 z i8`, `kind str`, `flags u8`, extra `createdTick u32` (logic tick at plant). Extra bytes ignored |
| `FIELD_GONE` | 134 | `x i16 y i16 z i8` |
| `SKILL_PROGRESS` | 135 | 8× `u64` in the `SKILLS` order. Magic is mana already counted toward the next magic level. The other slots are tries toward the next skill level. Fixed 64 bytes. Sent on enter and whenever a counter changes |
| `GROUND` | 136 | one visible stack slot: `x i16 y i16 z i8`, `stackIndex u8` (0 = top), `uid str`, `id str`, `count u16`, `flags u8` (flag 1 = container). Viewport AOI. Cap **N ≤ 10** from the top; extras stay on the server. No nested guts |
| `GROUND_GONE` | 137 | `uid str`, extra `x i16 y i16 z i8` ignored |
| `BROWSE_FIELD` | 138 | `x i16 y i16 z i8`, `n u8`, then n× (`stackIndex u8`, `uid str`, `id str`, `count u16`, `flags u8`). Flag 1 = container. Full ground pile, top first, `stackIndex` **0 = top**, capped at **255**. No nested guts. `n = 0` means that tile’s pile is empty |
| `TRADE` | 139 | `side u8` (0 = own column, 1 = counter), `name str` of that column’s owner, `n u8`, then n× (`id str`, `count u16`, `flags u8`). Flag 1 = container. Root first, then each container’s items in slot order, nested containers queued as seen. Cap **100** including the root |
| `TRADE_CLOSE` | 140 | empty |

`ENTER_WORLD`: `id u32`, name, vocation, `level u16`, `experience u64`, `hp u32`, `hpMax u32`, `mp u32`, `mpMax u32`, `x i16 y i16 z i8`, `townId u16`, then viewport: `originX i16 originY i16 z i8 w u8 h u8 tiles u16[w*h]`, then `foodSec u16`. Viewport `z` is the player floor. `tiles` are friction-derived debug ids (`0` void, `1` walk, `3` wall, `4` water, `5` town) — not visual stamps. Strings: `u8 len` + UTF-8. Experience and the four pools are wide enough for level 5000. Swing damage, capacity, and item counts stay u16. `foodSec` is the same remaining food seconds as `STATS`.

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

`BLOCKED` = dest not walkable / occupancy deny / bad dir / `MOVE_PATH` over cap / PvP-off player target / talkable NPC target / stair dest deny. Mid-path occupancy fail stops the queue and `REJECT`s the path seq. `BUSY` = `MOVE_STEP` / `USE_STAIR` before `stepDelayTicks`, or non-`PING`/`LOGOUT` while downed. `MOVE_PATH` while not ready **replaces** the queue and waits. `NO_TARGET=20` unknown / empty slot / bad reply index / `USE_STAIR` with no pad. `OUT_OF_RANGE=21` corpse farther than Chebyshev 1, NPC farther than **3**, or `USE` / `USE_ITEM_WITH` / `MOVE_ITEM` tile loc / `OPEN_BAG` of a ground uid / `USE_ITEM` of a ground uid / `BROWSE_FIELD` / `TRADE_OFFER` of a ground item farther than Chebyshev **1** (same `z`). Do not renumber existing codes. A far trade partner, or a ground item on another floor, is a `SAY`, not this reject.

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

## Container moves

A container destination index is ignored. The server inserts the item at slot 0 and shifts later items up so occupied slots stay a prefix. A destination slot that holds a container enters that container. Equipment slots and map tiles keep their own locs. `count u16` stays **0 = all**, `n` = split n.

## Ground items (player-dropped stacks)

Fifth surface next to bags (`MOVE_ITEM` / `OPEN_BAG` / `BAG`), authored pins (`WORLD_PIN` / `USE` / `CONTAINER`), corpses (`CORPSE` / `OPEN_CORPSE` / `LOOT_TAKE`), terrain (`VIEWPORT`), and fields (`FIELD`). Do **not** stuff drops into `VIEWPORT.tiles` or `WORLD_PIN`. Corpses and world-pin crates stay their own packets.

**Loc kind `2` (tile)** on `MOVE_ITEM` 42: `x i16 y i16 z i8` + `stackIndex u8` with **0 = top**. Server resolves the current uid; a stale index is `NO_TARGET`. Pickup = from tile → backpack/equipment loc (autostack / first free — never “move to the same tile”). Drop = from container/equipment → tile. Slide = tile → tile. `count u16` is C1 (`0` = all). Same-id stackables **merge** on the dest tile.

**Range** is server policy, not on the wire: Chebyshev ≤ **1**, same `z`. Dest tile must be walkable terrain (dropped stacks do not block; occupancy of creatures is allowed). Out of range → `OUT_OF_RANGE`. Blocked dest → `BLOCKED`. Do not path the player. Do not copy throw range 15. Dropping the equipped backpack is forbidden.

**Identity:** world `GroundStore` (tile → uid[] bottom→top) with its own `nextUid`. Transfer the item tree player ↔ ground and **remint** uids (player `iN` would collide on the floor). Nested `containers[uid]` travel with the bag. Open bag stays on the tile; guts travel only via `BAG` after `OPEN_BAG`.

**S2C AOI:** `GROUND` **136** (one visible slot) + `GROUND_GONE` **137** (by uid). Mutation broadcasts to viewers of **that tile**. Enter/step: appear/gone when the tile crosses the viewport (same loop as `WORLD_PIN`). Draw/send cap top **N ≤ 10**. Client indexes sprites by uid. No optimistic local remove.

**Open:** `OPEN_BAG` resolves a ground uid the same way it resolves equipment. Canvas opens the named uid with index **255**. Nested open is parent uid + slot (C3). `USE` 14 stays world-pins only.

**Walk-away close (Q7.6 A):** after each accepted `MOVE_STEP` / `MOVE_PATH` dir (and when the bag slides/is taken), if the **ground root** tile is Chebyshev > 1 or different `z`, forget that uid and send `BAG` capacity 0. Nested open bags of that root close with it. Backpack / equipped quiver stay. `#loot-panel` (`openCorpseId` / crate) uses the same range: clear the id and send empty `CONTAINER` so take cannot succeed from 2 sqm. Authority on the server — the client does not distance-poll and must not echo `CLOSE_BAG` for a uid the server already forgot.

**Persist:** world ground blob (`saveWorldGround` / `loadWorldGround`), not the dropper’s character row. Restart must not delete floor items and must not duplicate them back into the backpack. Character snapshot after a drop must not still hold that uid.

**Browse field:** `BROWSE_FIELD` **46** asks for one tile. The answer is S2C `BROWSE_FIELD` **138**, the whole `GroundStore` pile top-first (not the draw cap of 10). Corpses, world pins, and fields stay on their own packets and are not in this list. While the session is within Chebyshev 1 of that tile, a ground change there pushes a fresh snapshot (the whole list, not a delta). `BROWSE_FIELD_CLOSE` **47**, logout, `n = 0`, or the player leaving that range drops the watch. Stepping back into range does not push until the client sends `BROWSE_FIELD` again. Opcode **17** stays unused. Pickup, map-tile drop, and `OPEN_BAG` stay on their current opcodes. Use of a listed ground item is `USE_ITEM` with that uid and index **255** (same range, no path). A rope or shovel on an adjacent tile also satisfies `USE_ITEM_WITH` when the backpack does not hold that tool.

**Player trade:** `TRADE_OFFER` **48**, `TRADE_ACCEPT` **49**, `TRADE_CANCEL` **50**, S2C `TRADE` **139**, S2C `TRADE_CLOSE` **140**. This is player to player. NPC shop stays `SHOP` **33** / **34**. Opcodes **12** and **17** stay unused. There is no look opcode and no `TRADE_STATUS`.

One offer is one item, or one container and everything inside it. The list is the root, then each container’s items in slot order, with nested containers queued as they are seen. The whole stack is offered. `n` counts the container. More than **100** entries answers `You can not trade more than 100 items.` and does not change the session. Flag **1** marks a container. `side` 0 is that player’s own column (`name` is them). `side` 1 is the other column (`name` is its owner).

The partner is an online player on the same floor within Chebyshev **2**. Farther, or on another floor: `{name} tells you to move closer.` The server does not path and does not test a sight line. A ground item on another floor: `First go upstairs.` when the player’s `z` is greater than the item’s, otherwise `First go downstairs.` A ground item on this floor farther than Chebyshev **1**: `REJECT` `OUT_OF_RANGE` and no session. Self, NPC, monster, corpse, world pin, and field: `Sorry, not possible.`

One session per player. The invited player gets `{name} wants to trade with you.` and no `TRADE` until they offer, and they may offer only back to the inviter. Someone who already has a session and offers again: `You are already trading. Finish this trade first.` A third player: `This player is already trading.` An item that is a live offer, inside one, or a container that holds one: `This item is already being traded.` An offer cannot be replaced. Accept before both sides have an item: `Sorry, not possible.` and it does not stick. Accept sticks. The second side’s accept commits. Another accept from a side that already accepted is ignored. `TRADE_CANCEL` with no session does nothing.

Commit detaches both offers, then places each into the other backpack at slot 0 (insert at front, no merge, not into equipment). A slot freed by that detach counts, so two full one-slot backpacks can swap when the result fits. If either delivery cannot be placed, both offers go back and nothing moves. Capacity is `canCarryAdditional` on the incoming subtree after the outgoing subtree is already detached. The side that cannot take the item hears `You do not have enough capacity to carry this object.` / `these objects.` plus the weight line (`It weighs ` / `They weigh `, centi-oz printed as `0.0N` / `0.NN` / `N.NN`, then ` oz.`), or `You do not have enough room to carry this object.` / `these objects.` The side that would have succeeded hears `Trade could not be completed.` Failure sends that sentence and `TRADE_CLOSE`, not `Trade cancelled.` Success sends `TRADE_CLOSE` and no success sentence, then saves both characters (persist reason `trade`, `last_logout` unchanged). A ground uid is reminted the same way a pickup remints. `INVENTORY`, `EQUIPMENT`, and, when a ground tile changed, `GROUND` / `GROUND_GONE`, go out the same way a normal move already notifies.

`Trade cancelled.` plus `TRADE_CLOSE` to both also runs on logout, death, the walking player leaving Chebyshev **2** of the partner or Chebyshev **1** of their own ground item, and when the offered item or anything inside it is moved, split, merged, or updated. A sibling whose index shifts because something else was inserted at the front does not cancel. Cancel during the commit is ignored. A downed player’s trade opcode is `BUSY` (`PING` and `LOGOUT` stay admitted). Every sentence above is `SAY` with `speakerId` 0.

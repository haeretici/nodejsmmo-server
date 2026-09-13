# 05. Map / path

**P5:** live map is `../content` (`settings.contentPath` + `pack.json` `defaultMap`, overlay `settings.mapId` / `GAME_MAP_ID`). Fallback 24×24 village in `static_map.js` is **tests only**. Pack also ships hybrid `maps/village/` (same 24×24, no pins) so tests do not need firstlight. Viewport **15×11** on the player’s `z` (follows hops). Shipped `firstlight_isle` is hybrid **225×198**, town **(80, 132, 6)**. Boot loads **all 16 floors’** `friction` `sight` `flags` (missing hybrid z = blocked). Stair registry in RAM (`type`, `deltaZ`, dest, `hopsOnStep`). Spawn pins are in RAM (**761**, hybrid `map.json` wins over `by_floor`). `spawnMode` default **on_demand** (viewport + `spawnActivateMargin` **8**). **Do not** instantiate all pins at t=0. `v01` is bounds-only (do not preload). Debug tiles are friction-derived ids (not `sub_*` stamps). Server **MUST NOT** gunzip `sub_*.u16.gz`.

Town tile is pack `bounds.json` `town` / `spawn` (`map.spawn` / `spawnX,Y,Z`). **Not** `newCharacter.posZ`. New characters and downed logout use `World.townSpawn()`. Positions on wall/water/void/missing-z clamp to that spawn in memory (not written back). Occupancy full at spawn spirals to the nearest enterable tile; if none, enter kicks `WORLD_FULL`.

## Do not

- Dungeon generator as world gen.
- Client-authoritative walk (client may interpolate only).
- Nested `data[z][y][x]` tile objects. Player ids in ground-item lists.
- Creature–creature stack. Creature enter player/mixed on normal move. Swap/yield/hold.
- SQL on the tick. Position persists on logout / interval / wall-clock, not on each step.
- Weight A* by walkable friction gray (binary 255 only). Auto-reverse hops (hybrid pads are one-way unless `bidirectional`). Navmesh long routes.
- Instantiate every hybrid spawn pin at boot. Preload `v01` floors.

## Tiles

Viewport debug ids (from friction/sight, not stamps):

| id | name | Walk |
| ---: | :--- | :--- |
| 0 | void | no (`friction` 255) |
| 1 | grass | yes (100) |
| 2 | path | yes (100) |
| 3 | wall | no |
| 4 | water | no |
| 5 | spawn | yes (100) |

## Occupancy

Hybrid like the lab TileMap: `occupancy` is **0** or **first** combatant id (`Int32Array`). Sparse `playerStacks` only when `length ≥ 2`.

| Knob | Default |
| ---: | ---: |
| `playerTileMaxStack` | **10** (0 = unlimited) |
| `playerBaseSpeed` | **110** (+ `level−1`). Kit `speed` on creatures |
| `stepDelayTicks` | **4** — tests only when `fixedStepDelay` |
| `creatureStepDelayTicks` | **5** — tests only when `fixedStepDelay` |
| Live delay | friction×speed tables (`movement.js`). Friction 100 + speed 110 → **0.4 s** = **8** ticks at 20 UPS. Diagonal `×2`. Extra `MOVE_STEP` / `USE_STAIR` before ready → `REJECT BUSY`. `/play` and `/debug` ignore OS key-repeat (200 ms auto-repeat) |
| `pathMaxDistance` | **100** (player chase / return-home) |
| `pathMaxIterations` | **512** |
| `aiCreaturePathMaxDistance` | **12** (creature chase) |
| `aiRepathIntervalSec` | **2.0** optional moving-goal A* |
| `aiRepathFailBackoffSec` | **0.25** after failed critical |
| `aiPathBudgetPerFrame` | **0** unlimited (stress **48**) — optional repaths only |
| `aiCreatureThinkIntervalSec` | **1.0** (≤0 = every tick) |
| `aiOccupantStepPenalty` | **4** soft cost on push-enterable tiles |
| `creaturePushCrush` | **true** |
| `noPlayerStack` | off everywhere |

Join order. Index 0 = first. Players stack with players. `enterTile` / `leaveTile` are the only occupancy writers. `canPushCreatures` movers shove pushable creatures orthogonally (N/W/E/S shuffled) then claim; failed shove **crush** (zero HP → death). Never two creatures on one tile.

## Key files

| Path | Role |
| :--- | :--- |
| `src/world/static_map.js` | debug tile ids, viewport at `z`, test fallback map |
| `src/content/load_pack.js` | `contentPath` + `mapId` → pack `runtimeMap` / `resolveMapId` |
| `src/world/tilemap.js` | per-floor friction/sight/flags + occupancy + stack + stair registry + push/A* |
| `src/world/pathfinder.js` | binary-friction A* (`findPath`) |
| `src/world/movement.js` | friction×speed delay tables |
| `src/world/path_budget.js` | Option B optional-repath budget |
| `src/world/world.js` | apply `MOVE_STEP` / `USE_STAIR`, AOI appear/move, on_demand pins, `followPath` chase |
| `src/world/spawn_pins.js` | pin catalog, AOI margin, respawn seconds → ticks |
| `src/world/world_pins.js` | `world[]` seed at boot (not SQL). Blocking pins patch friction 255 |
| `src/world/world_pin_actions.js` | USE / rope-shovel hop / trap step |

Appear/disappear AOI uses the **clamped viewport rectangle** (`inViewport`), not unbounded Chebyshev. Spawn activate/despawn uses that rectangle plus `spawnActivateMargin` (**8**), same `z`.

Creatures and NPCs occupy empty tiles only except push/crush (dest emptied first). A* chase (binary friction; end tile open for melee). Player tiles hard-block creature intermediates. Corpses are not occupancy. `NO_CREATURE` blocks monsters; players and talkable NPCs walk (hop pads still block talkable NPCs).

## Stairs

Registry is authoritative (flag bits are markers only). Hybrid rows: `{ x, y, z, type, dir, deltaZ, to?, bidirectional? }`. Omitted `to` → dest `(x,y)+dir` on `z+deltaZ`. `custom` without `to` is not a hop. Return hop is a second pad (no auto reverse unless `bidirectional: true`). Exact dest (player stack or mixed onto ≤1 creature). No spiral free-tile.

| type | Player lands | `USE_STAIR` |
| :--- | :--- | :--- |
| `stairs` / `hole` / missing type | hop (`tryAutoStairHop` after `MOVE_STEP`; `reason: stair` does not bounce) | optional |
| `ladder` | stay | required |
| `rope` / `shovel` | stay | `USE_ITEM_WITH` (flag or pin `tag`) |

`USE_STAIR` is type-blind. Creatures do not auto-hop. Death / downed logout still use town spawn.

**P14 world pins:** seed `map.world` (or overlay `settings.world`) at boot into RAM instances (`id` ≥ **3000000000**). Furniture stamps stay visual. `USE` Chebyshev ≤ 1. Trap fires on step (HP loss; field deploy waits for P12). Rope/shovel: flag **16** / **32** or pin `tag`, hop `z−1` / `z+1` unless pin `to`. Do not persist pin used/open state.

## Remaining

Navmesh long routes. Maps are edited in `../map-editor` (P3). Talkable NPCs without dialog wait for P15. Trap elemental fields (P12).

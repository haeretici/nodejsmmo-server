# 01. Tick / process

One OS process. One mutator. S5: occupancy, combat, loot, NPC talk/shop, and **off-tick** persist.

## Do not

- SQL inside the 50 ms tick.
- `setInterval` without catch-up cap (spiral of death).
- Run HuntDL `Simulator` / seek / replay here.
- Cluster or one-process-per-floor.

## Pins

| Knob | Value |
| :--- | :--- |
| `logicUps` | **20** (`LOGIC_DT` = 50 ms) |
| Catch-up | max **5** ticks per fire, then skip |
| Step delay | friction×speed tables (friction 100 + speed 110 → **0.4 s** = **8** ticks). `stepDelayTicks` **4** only when `fixedStepDelay` (tests) |
| Persist | off-tick only. Logout always; interval **1 hour**; wall-clock `06:00` then shutdown. No loot/shop SQL |

## Key files

| Path | Role |
| :--- | :--- |
| `src/world/tick.js` | clock (`WorldTick`) |
| `src/world/world.js` | sessions, occupancy, `enqueueIntent`, `step` |
| `src/world/tilemap.js` | friction + stack + A* + push |
| `src/index.js` | boot: settings → MySQL → World → HTTP+WS |

## Boot order

1. `loadSettings` + `assertBootSecrets`
2. MySQL pool + migrate
3. Load `contentPath` pack (boot fails if missing). Live map = `defaultMap` / `mapId`. Firstlight: all logic floors + spawn pins in RAM; no `v01` floors; no pin instantiate at t=0 (`on_demand`)
4. `World.start` (tick)
5. HTTP listen (`bind` + `httpPort`) + WS `/v1/ws`
6. SIGINT/SIGTERM (and wall-clock save if `globalSaveShutdown`): stop listen, stop world, pool end

Tick drains intent queues, then player chase/swing, on_demand pin activate/despawn, creature AI, world-pin decay/cooldown, corpse decay, respawn, talk-range close. `PING` / `LOGOUT` / `MOVE_STEP` / `USE_STAIR` / `USE` / `USE_ITEM_WITH` / `SET_TARGET` / loot / `TALK` / shop apply. Empty tick still does no SQL. Persist clones on logout / interval / wall-clock, never inside `step`. World pins are RAM only.

## Remaining

S8 own GitHub remote. Spells stay out. Account UI is `../frontend`. Pack is `../content` at boot. Next named port stage is **P6**.

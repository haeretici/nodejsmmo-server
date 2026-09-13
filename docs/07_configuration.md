# 07. Configuration & Scale Tuning

Authoritative settings contract, environment overrides, multi-core compute worker sizing, queue bounds, and benchmark limits.

## Key files

| Path | Role |
| :--- | :--- |
| `config/settings.json` | Committed defaults |
| `config/settings.local.json` | Gitignored local overlay |
| `src/config/load_settings.js` | Environment mapping & type validation |
| `src/world/monster_compute.js` | Multi-core compute service (`MonsterComputeService`) |
| `src/world/monster_compute_worker.js` | Worker thread A* runtime |
| `src/world/path_budget.js` | Optional repath per-frame budget |

## Invariants & Do Not

- **MUST NOT** hardcode `computeWorkers: 4` on unknown/small VM hosts (starves the main 50 ms authority tick).
- **MUST NOT** exceed `computeWorkers: 4` even on 16+ core machines (inter-thread dispatch overhead yields diminishing returns).
- **MUST NOT** mutate live entities inside worker threads (typed array snapshots only).
- **MUST NOT** execute blocking file I/O or SQL inside the 50 ms tick budget.

## Multi-Core Compute & Pathfinding Knobs

| Knob | Default | Recommended (Prod) | Description |
| :--- | :--- | :--- | :--- |
| `computeWorkers` | `0` | `"auto"` | Worker thread count. `0` = inline. `1–4` = thread pool. `"auto"` uses reference formula: `0` if cores $\le 2$, else $\text{clamp}(\lfloor(\text{cores}-2)/2\rfloor, 1, 4)$. |
| `computeQueueCapacity` | `2048` | `2048` | Maximum in-flight/queued path searches across priority queues. Caps worker snapshot memory to < 6 MB. |
| `computeApplyDelayTicks` | `0` | `0` | Completion pipeline delay. `0` = same-tick / immediate drain. `1` = staged next-tick drain (used for 100% deterministic parity testing). |
| `aiPathBudgetPerFrame` | `0` | `0` (stress `48`) | Limit for optional moving-goal repaths per tick; `0` = unlimited. Critical repaths (empty path / recovery) bypass budget. |
| `aiCreaturePathMaxDistance` | `12` | `12` | Maximum chase distance from creature to target before giving up. |
| `pathMaxDistance` | `100` | `100` | Maximum distance for return-to-spawn or long routes. |
| `aiRepathIntervalSec` | `2.0` | `2.0` | Interval between optional moving-goal repaths for a chasing entity. |
| `aiRepathFailBackoffSec` | `0.25` | `0.25` | Cooldown penalty before attempting another search after an A* failure. |
| `aiOccupantStepPenalty` | `4` | `4` | Soft step cost penalty for pathing through push-enterable creatures. |

## Scale & Population Tuning (40,000 World Spawns)

| Knob | Default | Recommended | Description |
| :--- | :--- | :--- | :--- |
| `spawnMaxLiving` | `3000` | `3000` | Soft cap for instantiated living entities ($C_{\text{slots}} \gg C_{\text{living}}$). Unengaged idle mobs are evicted beyond this limit. |
| `spawnActivateMargin` | `8` | `8` | Tile padding beyond the observer viewport rectangle to activate dormant spawn pins. |
| `spawnDespawnIdleTicks` | `40` | `40` | Ticks (2.0s at 20 UPS) an unengaged mob remains alive without players in range before despawning back to its pin. |
| `aiCreatureSleep` | `true` | `true` | Enables sleep state. Dormant mobs skip AI, targeting, cooldown updates, and return pathing. |
| `aiTickRadius` | `12` | `12` | Observer-centric wake radius. Sweep radiates outward from active players ($O(N_{\text{players}})$). |

## Network & Batching Limits

| Knob | Default | Recommended | Description |
| :--- | :--- | :--- | :--- |
| `logicUps` | `20` | `20` | Authoritative tick rate (`dt = 50ms`). |
| `limits.outboundBatching` | `true` | `true` | Coalesces micro-events during `World.step()` into a single outbound frame per player at tick exit. |
| `limits.maxIntentsPerTick` | `5` | `5` | Maximum client action intents admitted per player per 50 ms frame. |
| `playerTileMaxStack` | `10` | `10` | Max players stacked on a single coordinate tile. |

## Environment Variable Overrides

| Environment Variable | Target Setting Key | Type |
| :--- | :--- | :--- |
| `GAME_COMPUTE_WORKERS` | `computeWorkers` | `int` or `"auto"` |
| `GAME_COMPUTE_QUEUE_CAPACITY` | `computeQueueCapacity` | `int` |
| `GAME_COMPUTE_APPLY_DELAY_TICKS` | `computeApplyDelayTicks` | `int` |
| `GAME_SPAWN_MAX_LIVING` | `spawnMaxLiving` | `int` |
| `GAME_OUTBOUND_BATCHING` | `limits.outboundBatching` | `bool` |
| `GAME_HTTP_PORT` | `httpPort` | `int` |
| `GAME_BIND` | `bind` | `string` |

## Hardware Sizing & Empirical Benchmarks

### Sizing Matrix

| Host Profile | CPU Cores | `computeWorkers: "auto"` | Main Thread Safety Margin |
| :--- | :--- | :--- | :--- |
| **Small VPS / Micro** | 2 cores | `0` (inline) | Protects main thread from thread contention. |
| **Mid-Tier Server** | 4 cores | `1` worker | 1 worker calculates A*; 3 cores reserved for main loop + libuv + OS. |
| **Standard Game Node** | 6–8 cores | `2–3` workers | Parallel worker offloading with full tick stability. |
| **Dedicated Bare-Metal** | 10+ cores | `4` workers | Peak throughput (~5,000 paths/sec). |

### Benchmark Results (Empirical Hardware Profile)

| Scenario | Mode | Main Thread Avg | Main Thread p95 | Savings vs Inline |
| :--- | :--- | :--- | :--- | :--- |
| **300 Mobs Repathing** | Inline (Single-Core) | `7.68 ms` | `16.92 ms` | Baseline |
| **300 Mobs Repathing** | 2 Workers | `3.71 ms` | `8.13 ms` | **51.7% less CPU** |
| **300 Mobs Repathing** | 4 Workers | `2.38 ms` | `3.75 ms` | **69.0% less CPU** |
| **600 Mobs Repathing** | Inline (Single-Core) | `12.75 ms` | `19.26 ms` | Baseline (consumes 25.5% of tick) |
| **600 Mobs Repathing** | 4 Workers | `5.07 ms` | `20.58 ms` | **60.2% less CPU** |

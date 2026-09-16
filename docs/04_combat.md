# 04. Combat

**S5:** combat, creatures, corpse loot, NPC talk/shop, and character persist resolve **only** in this process. Client displays `SWING` / `STATS` / `DEATH` / `CORPSE` / `DIALOG` / `SHOP` / `INVENTORY` / `EQUIPMENT`.

## Do not

- Share `kernel/core/lib/combat` into a client bundle.
- Trust client HP, loot rolls, or “I hit”.
- Port Hunt Simulator as the world.
- Spells, fields, conditions.
- SQL on the tick.
- Load HuntDL `presets/`. Live kits come from `../content`. Built-in `rat` / `dummy` / `guide` are test fallbacks only.
- Lua VM, bank/depot. Quickloot.
- Furniture stamps as behavior (pins are `world[]` in RAM).

## Pins

| Knob | Default |
| ---: | :--- |
| `autoIntervalTicks` | **40** (2 s at 20 UPS) |
| `creatureStepDelayTicks` | **5** |
| `deathDelayTicks` | **40** |
| `corpseDecayTicks` | **600** (30 s) |
| `creatureRespawnTicks` | **200** (10 s; used when pin `respawn` is missing) |
| `spawnActivateMargin` | **8** (tiles beyond the viewport rect, same `z`) |
| `spawnDespawnIdleTicks` | **40** (2 s). On_demand only. **0** = next tick out of AOI. Idle/budget **parks** HP |
| `spawnDespawnHomeDist` | **20** Chebyshev from pin home. Beyond → destroy + `respawn` cooldown. **0** disables |
| `unarmedAtk` | **7** |
| `meleeAutoFactor` | **0.102** |
| `features.pvp` | **false** |
| `features.expProgression` | **true** (product). Kill credits `experience` + `levelFromExp`. Cubic: `(50/3)×(L³−6L²+17L−12)`. L2 = **100** |
| `features.skillProgression` | **true** (product). Weapon tries on auto; shield try when block zeros damage. Rates from pack `classes.json` `skillRates` |
| Creature ids | `creatureIdBase` **1000000000** |
| Corpse ids | `corpseIdBase` **2000000000** |

Live map: pack `maps/firstlight_isle/` hybrid (town **80,132,6**). Pack pins load at boot; `spawnMode` **on_demand** (viewport + margin **8**). Tests set `spawns: []` `npcs: []` (eager overlay when those keys are present) or delete the keys to use pack pins. One AOI frame per tick (observers + nearby creatures + spawn-pin candidates) is reused by sleep, spawn, aggro, and broadcast.

## Intents

| C2S | id | Rule |
| :--- | ---: | :--- |
| `SET_TARGET` | 11 | `id u32`, **0** clears. Unknown → `NO_TARGET`. Self / other player while `pvp` off → `BLOCKED`. |
| `SET_AUTO_CHASE` | 12 | `u8` 0/1. Needs a target. |
| `USE` | 14 | World pin at `x,y,z`. Chebyshev ≤ 1 same `z`. Container / chest / lever / door / teleport / harvest. Trap is step-on |
| `USE_ITEM_WITH` | 15 | Rope/shovel hop. Count the item; do not consume |
| `OPEN_CORPSE` | 20 | Chebyshev ≤ 1 same `z` |
| `LOOT_TAKE` | 21 | `corpseId u32` + `slot u8` into bag (also world-pin containers); RAM until logout / interval / wall-clock |
| `LOOT_CLOSE` | 22 | clears open container |
| `TALK` | 30 | Chebyshev ≤ **3**. Talkable NPC only |
| `TALK_REPLY` | 31 | visible index; give/take/shop/goto/close |
| `TALK_CLOSE` | 32 | |
| `SHOP_BUY` / `SHOP_SELL` | 33 / 34 | range 3; currency `gold_coin`; count 1–100 |

Auto-attack is **not** an intent: each tick, if target is in weapon range (Chebyshev ≤ 1 for melee, ≤ range with LOS for magic/distance) and `attackReadyTick` elapsed, the server swings. Distance empty ammo: SAY “You need ammunition.” and return **without** arming `attackReadyTick`.

## Damage (melee, wand & distance auto)

Order: miss → **crit** → raw → **fatal** → mit% → resist% → shield block → armor → floor 0.

| Attacker | Raw |
| :--- | :--- |
| Player (Melee) | `melee_auto`: non-crit gaussian μ=0.5 σ=0.25 on `[levelBonus, ceil(0.102×atk×skill + levelBonus)]`. Unarmed atk **7** / fist. Equipped: catalog `atk` + weapon skill. Dual-element (`extraAtk` + `extraAtkElement`, e.g. ember cleaver): auto formula uses combined atk (`atk + extraAtk`), splits raw by `extraAtk/combinedAtk`; physical share through block+armor; extra share through that element resist only. Crit = `auto_st` uniform `[max(min, floor(0.65×max)), max]`, then `×(1+critDamage/100)` |
| Player (Distance) | `distance_auto`: range from item (fallback **6**, no cap of 7), requires LOS; `effectiveAtk = weapon.atk + ammo.atk` (throwing without ammo: weapon only); hit% = `min(100, ammo.maxHitChance + weapon.hitChanceMod)` (throwing uses weapon `maxHitChance`); non-crit gaussian μ=0.5 σ=0.25 on `[levelBonus, ceil(0.102×effectiveAtk×skills.distance + levelBonus)]`. Crit = `auto_st` uniform `[max(min, floor(0.65×max)), max]`, then `×(1+critDamage/100)`. `isMelee: false` — shield cannot block arrows. Consumes 1 ammo per shot when `features.ammoConsumption`. Skill tries: +2 blood hit / +1 mitigated hit. |
| Player (Magic) | `wand_auto`: fixed uniform `[min, max]` elemental damage; range from item (fallback 4, no cap of 7), requires LOS; bypasses shield block and armor; mitigated by `mitigation%` and `resists[element]%`. Restores `manaGain` MP on hit. No weapon skill tries. |
| Creature | kit `attacks[]` rows (melee or ranged) uniform `[min, max]`. Range > 1 requires LOS; elemental bypasses armor and shield block; physical ranged bypasses shield block and applies armor reduction. Crit = `multiply` (same roll × extra). Never fatal |

| Proc | Rule |
| :--- | :--- |
| Crit | `critChance` 0–100. Player: class row from pack `classes.json` (unarmed 5/10). Creature: kit `critChance`/`critDamage` (omit = 0) |
| Fatal | player weapon `tier`>0 only. Chance `0.05t²+0.4t+0.05`%. `raw + round(raw×0.6)` after crit. Unarmed / omit / creature → never |

Armor: `[ceil(a/2), ceil(a/2)×2−1]`. Shield block: physical + melee only if `canBlock` and `maxBlock > 0` (distance / wand / creature ranged pass `isMelee: false`); at most **2 blocks per 2-second logic window** (40 ticks at 20 UPS); subsequent hits in window bypass shield block directly to armor. Players: unarmed = armor 0, `weaponDefense` **5**, mit from shielding+5, `maxBlock` from fist+5, `weaponTier` 0, atk **7**, skill **fist**. Equipped weapon: catalog `atk` + weapon skill (`sword`/`axe`/`club`/`fist`/`distance`/`magic`). Shield/armor from slots. Cap = 600@L1 + vocation curve; weight from catalog (centi-oz / 100). Nested bags in `character_state.inventory` tree. Corpse/world-pin remain flat containers. `features.ammoConsumption` spends quiver/bag ammo on bow/xbow auto. Live rat (`content/creatures/rat.json`): hp 20, armor 1, mit 0.07, melee 0–21 / 2 s. Test fallback `rat`: hp 30, mit 0.1, 0–26.

`hitChance` 100 except kit `chance` and distance weapons (ammo `maxHitChance` + weapon modifier). No spells or mana-shield. PvP off.

## Creatures

Occupy **empty** tiles only except `canPushCreatures` shove/crush. No creature–creature stack, no walk onto players.

AI: aggro nearest player in `aggroRange` (7) on think interval (integer ticks via `logicNow`, not `Date.now`). Kit rows: arm that row’s CD when the window opens, then range/LOS; OOR or no LOS still burns the interval and does **not** skip to a later in-range row (chance fail still continues). Melee rows are skipped without CD while `runHealth` flee is active. Stand-off `flags.targetDistance`: `dist > want` closes; `dist === want` holds; `dist < want` kites; cornered creatures stand ground. When `hp ≤ flags.runHealth` (or `hp/hpMax ≤ runHealthPercent`), `want` becomes `fleeTargetDistance` (default **10**) and lose-target is `max(loseTargetDistance, fleeTargetDistance)`. A* `followPath` (chase cap **12**, return-home **100**). Optional repath **2 s**; empty/blocked is critical. Melee at Chebyshev ≤ 1. Lose at 12. Idle wander: awake (`activeCreatures` only), no target, player in aggro/AOI (or `flags.idleWander`) → random cardinal step on `moveReadyTick`. Speed 0 does not wander. Leash: on target loss while off spawn, stay awake, path home; arriving spawn restores `hp` to `hpMax`. Sleeping / virtualized bodies do not wander. `dummy` kit: `aggro: false` (tests).

Death: `DISAPPEAR` + corpse on the death tile (not occupancy). Loot chance scale **1e5**. Empty roll still spawns a corpse. Killer: solo share → personal rates (defaults 1) → `experience`. If `expProgression`, `levelFromExp` (one call). Level-up: class `hpPerLevel`/`mpPerLevel` added to pools; `EXP` includes `level u16`. Skill tries: blood bucket **30**; melee/fist **+1**; distance **+2** full / **+1** mitigated; wand/rod no weapon try. Shield: full-zero + `blockChargeSpent` + equipped shield. Persist `character_skills` levels + `*_tries`. Respawn from pin `respawn` seconds × `logicUps` (missing pin delay = `creatureRespawnTicks`). `respawn` **0** = one-shot. On_demand: idle creatures outside AOI for `spawnDespawnIdleTicks` (**40**) **park** (same body / remaining HP, no respawn delay). Home-distance **> 20** destroys and waits pin `respawn`. World-pin harvest/trap cooldown and decay use a monotonic deadline queue (no full pin scan each tick).

Player HP 0: leave tile, `DEATH`, others `DISAPPEAR`, `downed` (not socket `dead`). After `deathDelayTicks` occupy spawn, full HP, `STATS`+`MOVE`+`VIEWPORT`. Downed admits only `PING`/`LOGOUT` (`BUSY` else).

## NPC

`guide` occupies an empty tile (same as creatures). Not attackable (`SET_TARGET` → `BLOCKED`). Talk range Chebyshev ≤ 3, same `z`. Walk out of range → `DIALOG_CLOSE`. Shop currency `gold_coin`. Quest flag `guide.mission` in `character_state.storage`. Missing dialog → `SAY` “Nothing to say.” Idle walk: copy `walkInterval` (ms → ticks via `logicUps`) / `walkRadius` / `voices` on NPC init. Cardinal step in Chebyshev radius of spawn when a living player is within Chebyshev **8**, same `z`. Freeze walk while any `talkNpcId` is this NPC. `aggro === true` does not wander. Voices `S2C.SAY` to viewers (no combat). NPCs stay off `activeCreatures` / `tickCreatureAi`.

## Persist (off tick)

Logout always. Interval (1 hour) and wall-clock save all online. Loot/shop/quest/walk/HP/exp/skills stay RAM until then. Downed logout → town spawn + full HP.

## Key files

| Path | Role |
| :--- | :--- |
| `src/world/combat.js` | pipeline |
| `src/world/progression.js` | exp cubic + skill tries (no `kernel/` require) |
| `src/world/loot.js` | 1e5 roll |
| `src/world/items.js` | catalog lookup / slots |
| `src/world/inventory.js` | tree bags, equip, cap |
| `src/world/templates.js` | test fallback `rat` / `dummy` / `guide`; live uses pack |
| `src/world/creature.js` | spawn + speed / push flags |
| `src/world/pathfinder.js` | A* |
| `src/world/path_budget.js` | optional repath budget |
| `src/world/npc.js` | dialog / `when` / shop / wander fields |
| `src/world/snapshot.js` | persist clone |
| `src/world/world.js` | tick: intents → chase/swing → on_demand pins → AI → decay |
| `src/world/spawn_pins.js` | pin catalog / AOI / respawn seconds |
| `src/world/world_pins.js` | hybrid `world[]` normalize / seed (RAM, not SQL) |
| `src/world/world_pin_actions.js` | USE / Use-with / trap step / decay |

## Remaining

Conditions, **trap fields**. Threat/`changeTarget`/`strategiesTarget`, defense kit, area/wave kit, summons. ML from mana spend waits P12. Bank/depot. Lever `wave` is a no-op (Hunt Simulator leftover). Do not load HuntDL `presets/`.

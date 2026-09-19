# 04. Combat

**S5:** combat, creatures, corpse loot, NPC talk/shop, and character persist resolve **only** in this process. Client displays `SWING` / `STATS` / `DEATH` / `CORPSE` / `DIALOG` / `SHOP` / `INVENTORY` / `EQUIPMENT`.

## Do not

- Share `kernel/core/lib/combat` into a client bundle.
- Trust client HP, loot rolls, or “I hit”.
- Port Hunt Simulator as the world.
- Spell formulas (`powerCurve` / `basePower` / `damageAmplitude`) in the browser.
- SQL on the tick.
- Load HuntDL `presets/`. Live kits come from `../content`. Built-in `rat` / `dummy` / `guide` are test fallbacks only.
- Lua VM, bank/depot. Quickloot.
- Furniture stamps as behavior (pins are `world[]` in RAM).

## Pins

| Knob | Default |
| ---: | :--- |
| `autoIntervalTicks` | **40** (2 s at 20 UPS) |
| `aiCreatureThreatDecayHalflifeSec` | **10** (0 = no decay) |
| `aiCreatureRetargetIntervalSec` | **0** (sticky; kit `changeTarget` overrides) |
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
| L1–7 pools | HP **150+(L−1)×5** (L1 **150**), MP **50+L×5** (L1 **55**). L8 = class `baseHp`/`baseMp` (**185**/**90**). After 8: `base + (L−8)×perLevel`. `newCharacter` and `applyLevelPools` use absolute `poolMaxForLevel` |
| `regenHpTicks` / `regenMpTicks` | **60** / **100** (3 s / 5 s at 20 UPS). Living players. Class `baseRegenHp`/`baseRegenMp` (promoted variants if `promoted`) |
| `engageRegenHpTicks` / `engageRegenMpTicks` | **80** / **120** (4 s / 6 s). While `targetId` is a living entity |
| Creature ids | `creatureIdBase` **1000000000** |
| Corpse ids | `corpseIdBase` **2000000000** |

Live map: pack `maps/firstlight_isle/` hybrid (town **80,132,6**). Pack pins load at boot; `spawnMode` **on_demand** (viewport + margin **8**). Tests set `spawns: []` `npcs: []` (eager overlay when those keys are present) or delete the keys to use pack pins. One AOI frame per tick (observers + nearby creatures + spawn-pin candidates) is reused by sleep, spawn, aggro, and broadcast.

## Intents

| C2S | id | Rule |
| :--- | ---: | :--- |
| `SET_TARGET` | 11 | `id u32`, **0** clears. Unknown → `NO_TARGET`. Self / other player while `pvp` off → `BLOCKED`. |
| `USE` | 14 | World pin at `x,y,z`. Chebyshev ≤ 1 same `z`. Container / chest / lever / door / teleport / harvest. Trap is step-on |
| `USE_ITEM_WITH` | 15 | Rope/shovel hop. Count the item; do not consume |
| `OPEN_CORPSE` | 20 | Chebyshev ≤ 1 same `z` |
| `LOOT_TAKE` | 21 | `corpseId u32` + `slot u8` into bag (also world-pin containers); RAM until logout / interval / wall-clock |
| `LOOT_CLOSE` | 22 | clears open container |
| `TALK` | 30 | Chebyshev ≤ **3**. Talkable NPC only |
| `TALK_REPLY` | 31 | visible index; give/take/shop/goto/close |
| `TALK_CLOSE` | 32 | |
| `SHOP_BUY` / `SHOP_SELL` | 33 / 34 | range 3; currency `gold_coin`; count 1–100 |
| `CAST` | 16 | Spell book in `../content/spells.json`. Targeting / PZ below |

**CAST targeting / PZ** (reference `isSelfTarget` / `isAggressive` / `allowOnSelf`):

| Spell | Rule |
| :--- | :--- |
| Harmful (`kind` not heal/support, element not healing) | Caster tile `NO_CAST` / PZ → `REJECT BLOCKED` (18). Target tile PZ skipped |
| Heal / support | Allowed on caster PZ. Harmful-only `blocksCast` on target tiles |
| `selfTarget` (Magic Patch, Light Heal, haste, …) | Always the caster. Ignore CAST `targetId`, sticky, aim. Infer when omitted: shapeless heal/support, not `requiresTarget` / chain / field |
| `requiresTarget` (Heal Friend, strikes) | Living primary required. `allowOnSelf: false` → self is `NO_TARGET` |
| Area / wave (`shape`) | Center from aim/primary; range ≤ 1 area centers on caster |

Auto-attack is **not** an intent: each tick, if target is in weapon range (Chebyshev ≤ 1 for melee, ≤ range with LOS for magic/distance) and `attackReadyTick` elapsed, the server swings. Closing distance is client `MOVE_PATH` (viewport BFS → dirs). Distance empty ammo: SAY “You need ammunition.” and return **without** arming `attackReadyTick`. Weapon auto applies `moveLock` **0.05s** (`max` with current `moveReadyTick`) after an accepted swing (hit or miss). `MOVE_STEP` / `CAST` fail while locked. Queued `MOVE_PATH` dirs wait on `moveReadyTick`. Empty-ammo / OOR / LOS fail do **not** lock. Same-tick auto yields if a spell already planted `moveReadyTick`. Do not move target / auto-swing / bag / occupancy into the browser.

## Damage (melee, wand & distance auto)

Order: miss → **crit** → raw → **fatal** → mit% → resist% → shield block → armor → floor 0.

| Attacker | Raw |
| :--- | :--- |
| Player (Melee) | `melee_auto`: non-crit gaussian μ=0.5 σ=0.25 on `[levelBonus, ceil(0.102×atk×skill + levelBonus)]`. Unarmed atk **7** / fist. Equipped: catalog `atk` + weapon skill. Dual-element (`extraAtk` + `extraAtkElement`, e.g. ember cleaver): auto formula uses combined atk (`atk + extraAtk`), splits raw by `extraAtk/combinedAtk`; physical share through block+armor; extra share through that element resist only. Crit = `auto_st` uniform `[max(min, floor(0.65×max)), max]`, then `×(1+critDamage/100)` |
| Player (Distance) | `distance_auto`: range from item (fallback **6**, no cap of 7), requires LOS; `effectiveAtk = weapon.atk + ammo.atk` (throwing without ammo: weapon only); hit% = `min(100, ammo.maxHitChance + weapon.hitChanceMod)` (throwing uses weapon `maxHitChance`); non-crit gaussian μ=0.5 σ=0.25 on `[levelBonus, ceil(0.102×effectiveAtk×skills.distance + levelBonus)]`. Crit = `auto_st` uniform `[max(min, floor(0.65×max)), max]`, then `×(1+critDamage/100)`. `isMelee: false` — shield cannot block arrows. Consumes 1 ammo per shot when `features.ammoConsumption`. Throwing `breakChance` (0–100) rolls on every accepted swing (hit **or** miss) and removes one hand stack unit on break. Ammo `autoShape`: `burst_arrow` `{type:'area',code:3}` 3×3; `diamond_arrow` `{type:'area',code:4}` 5×5 circle (corners empty). Center = sticky target. Hit% once (miss spends ammo, no footprint). Crit = `multiply`, one flag / swing (no 65% ST band). Same auto CD / 1 ammo. Throwing stays ST. Skill tries: +2 blood hit / +1 mitigated hit (primary only). |
| Player (Magic) | `wand_auto`: item `min`/`max` uniform elemental damage. Omit **both** → `magic_strike` `basePower` **18**. Range from item (fallback 4, no cap of 7), requires LOS; bypasses shield block and armor; mitigated by `mitigation%` and `resists[element]%`. Restores `manaGain` MP on hit with final > 0. No weapon skill tries. |
| Creature | kit `attacks[]` rows. Melee/ranged: uniform `[min, max]` on the sticky target (range > 1 needs LOS). Area/wave: P12 `shapes.js` footprint + `resolveSpellHit` (one crit flag / swing, `multiply`). Status: apply `condition` (no damage roll). Heal/haste/invisible: `defenseSpells` before offense. Elemental bypasses armor and shield block; physical ranged bypasses shield block and applies armor. Crit = `multiply`. Never fatal |

| Proc | Rule |
| :--- | :--- |
| Crit | `critChance` 0–100. Player: class row from pack `classes.json` (unarmed 5/10). Creature: kit `critChance`/`critDamage` (omit = 0) |
| Fatal | player weapon `tier`>0 only. Chance `0.05t²+0.4t+0.05`%. `raw + round(raw×0.6)` after crit. Unarmed / omit / creature → never |

Armor: `[ceil(a/2), ceil(a/2)×2−1]`. Shield block: physical + melee only if `canBlock` and `maxBlock > 0` (distance / wand / creature ranged pass `isMelee: false`); at most **2 blocks per 2-second logic window** (40 ticks at 20 UPS); subsequent hits in window bypass shield block directly to armor. Players: unarmed = armor 0, `weaponDefense` **5**, mit from shielding+5, `maxBlock` from fist+5, `weaponTier` 0, atk **7**, skill **fist**. Equipped weapon: catalog `atk` + weapon skill (`sword`/`axe`/`club`/`fist`/`distance`/`magic`). Formula atk also folds non-weapon `atk` (rings) + class `atkBonus`; dual-element split uses weapon `extraAtk` only. Player `resists`: multiplicative `1−Π(1−rᵢ/100)` from equipped gear (100 = immune). Speed: class `baseSpeed` (fallback `playerBaseSpeed` **110**) + (level−1) + gear.speed + class `speedBonus`. Life/mana leech: chance 0–100 additive; amount catalog pipeline/100 percent of real HP lost (miss / heal / 0 HP skip). Shield/armor from slots. Cap = 600@L1 + vocation curve; weight from catalog (centi-oz / 100). Nested bags in `character_state.inventory` tree. Corpse/world-pin remain flat containers. `features.ammoConsumption` spends quiver/bag ammo on bow/xbow auto. Live rat (`content/creatures/rat.json`): hp 20, armor 1, mit 0.07, melee 0–21 / 2 s. Test fallback `rat`: hp 30, mit 0.1, 0–26.

`hitChance` 100 except kit `chance` and distance weapons (ammo `maxHitChance` + weapon modifier). No spells or mana-shield. PvP off.

## Creatures

Occupy **empty** tiles only except `canPushCreatures` shove/crush. No creature–creature stack, no walk onto players.

AI: acquire on think interval (integer ticks via `logicNow`, not `Date.now`) via weighted `strategiesTarget` (`nearest` / `health` / `damage` / `random`; omit → `nearest: 100`). Players on `NO_CAST` / PZ are not valid creature targets (drop sticky, skip aggro, no harmful hits). Sticky until lose, unless `changeTarget.interval` (ms) + `changeTarget.chance` (%) re-roll the same weights. Interval 0 or chance 0 = sticky. Interval always re-arms; chance is the roll. No `flags.retarget*` path. Global fallback `aiCreatureRetargetIntervalSec` **0**. `damage` uses `damageTakenBy` (player HP dealt); lazy half-life `aiCreatureThreatDecayHalflifeSec` **10** (flags `threatDecayHalflifeSec` 0 = no decay). Chase paths to an enterable neighbor when the goal blocks the mover; a failed chase step is a random cardinal (keep target). `tryDefenseSpells` (heal if `hp/hpMax < hpBelow` default **0.7**; haste if not already hasted; invisible) fires at most one success and skips offense that pass. Kit rows: arm that row’s CD when the window opens, then range/LOS; OOR or no LOS still burns the interval and does **not** skip to a later in-range row (chance fail still continues). Area centers on the sticky target (`shape.code` = catalog `radius`). Wave origin is one step in front of the caster, facing the target (`length`×`spread`). Status applies `condition` in range/LOS. Melee rows are skipped without CD while `runHealth` flee is active. Stand-off `flags.targetDistance`: `dist > want` closes; `dist === want` holds; `dist < want` kites; cornered creatures stand ground. When `hp ≤ flags.runHealth` (or `hp/hpMax ≤ runHealthPercent`), `want` becomes `fleeTargetDistance` (default **10**) and lose-target is `max(loseTargetDistance, fleeTargetDistance)`. A* `followPath` (chase cap **12**, return-home **100**). Optional repath **2 s**; empty/blocked is critical. Melee at Chebyshev ≤ 1. Lose at 12. Idle wander: awake (`activeCreatures` only), no target, player in aggro/AOI (or `flags.idleWander`) → random cardinal step on `moveReadyTick`. Speed 0 does not wander. Leash: on target loss while off spawn, stay awake, path home; arriving spawn restores `hp` to `hpMax`. Sleeping / virtualized bodies do not wander. `dummy` kit: `aggro: false` (tests).

Monster summons (`pack.features.monsterSummons`, default **true**): kit `summon.maxSummons` + `summons[]` (`id`, `chance`, `interval` ms, `count`). In combat only. One successful spawn per kit pass; does **not** consume offense. Living ≥ `maxSummons` stops; per-row `count` is a living-type cap. Interval arms before chance. Occupancy: empty adjacent tile, not the master tile, spiral r ≤ **6**. Summons do not nest. No pin / respawn. Master death, pin despawn, and park dismiss adds (no corpse, no exp). Player kill of an add awards exp; still no corpse / respawn. Summons acquire even if template `aggro: false`.

Death: `DISAPPEAR` + corpse on the death tile (not occupancy). Loot chance scale **1e5**. Empty roll still spawns a corpse. Killer: solo share → personal rates (defaults 1) → `experience`. If `expProgression`, `levelFromExp` (one call). Level-up: absolute `poolMaxForLevel` (pre-voc +5/+5 until 8, then class `hpPerLevel`/`mpPerLevel`); positive delta heals current HP/MP; `EXP` includes `level u16`. Skill tries: blood bucket **30**; melee/fist **+1**; distance **+2** full / **+1** mitigated; wand/rod no weapon try. Shield: full-zero + `blockChargeSpent` + equipped shield. Persist `character_skills` levels + `*_tries`. Respawn from pin `respawn` seconds × `logicUps` (missing pin delay = `creatureRespawnTicks`). `respawn` **0** = one-shot. On_demand: idle creatures outside AOI for `spawnDespawnIdleTicks` (**40**) **park** (same body / remaining HP, no respawn delay). Home-distance **> 20** destroys and waits pin `respawn`. World-pin harvest/trap cooldown and decay use a monotonic deadline queue (no full pin scan each tick).

Player HP 0: leave tile, `DEATH`, others `DISAPPEAR`, `downed` (not socket `dead`). After `deathDelayTicks` occupy spawn, full HP, `STATS`+`MOVE`+`VIEWPORT`. Downed admits only `PING`/`LOGOUT` (`BUSY` else).

## NPC

`guide` occupies an empty tile (same as creatures). Not attackable (`SET_TARGET` → `BLOCKED`). Talk range Chebyshev ≤ 3, same `z`. Walk out of range → `DIALOG_CLOSE`. Shop currency `gold_coin`. Quest flag `guide.mission` in `character_state.storage`. Missing dialog → `SAY` “Nothing to say.” Idle walk: copy `walkInterval` (ms → ticks via `logicUps`) / `walkRadius` / `voices` on NPC init. Cardinal step in Chebyshev radius of spawn when a living player is within Chebyshev **8**, same `z`. Freeze walk while any `talkNpcId` is this NPC. `aggro === true` does not wander. Voices `S2C.SAY` to viewers (extra `speakerId` + `yell`; no combat). NPCs stay off `activeCreatures` / `tickCreatureAi`.

## Persist (off tick)

Logout always. Interval (1 hour) and wall-clock save all online. Loot/shop/quest/walk/HP/exp/skills stay RAM until then. Downed logout → town spawn + full HP.

## Regen / duration

Living players restore class `baseRegenHp`/`baseRegenMp` (promoted rows if `promoted`) on integer tick accumulators. Out-of-combat intervals `regenHpTicks` **60** / `regenMpTicks` **100**; engage (living `targetId`) **80** / **120**. Skip `simSleeping` creatures. MUST NOT `Date.now`. Equipped `durationSec` items decay while worn; leftover `remainingDurationSec` / `remainingCharges` persist on inventory instances. Stowed leftover duration freezes. MUST NOT weapon-charge attack-use.

`USE_ITEM` consumables: catalog `heal` / `restoreMana` (array or scalar) / `dispel` / `condition`. No built-in potion id table. Empty-effect `usable`/`consumable` (berserk / savant / marksman) still consume. Food (`category: food`) with no other effect applies regen `{healthGain:1,intervalSec:3,durationSec:60}` (catalog `condition` / `durationSec` / `healthGain` override). Regen overwrite. Stacks max **100**.

## Key files

| Path | Role |
| :--- | :--- |
| `src/world/combat.js` | pipeline |
| `src/world/spells.js` | CAST book, PZ (harmful only), `selfTarget` / `allowOnSelf` |
| `src/world/progression.js` | exp cubic + skill tries + `poolMaxForLevel` (no `kernel/` require) |
| `src/world/loot.js` | 1e5 roll |
| `src/world/items.js` | catalog lookup / slots / `asRange` |
| `src/world/item_use.js` | `USE_ITEM` heal / mana / food regen / dispel / condition |
| `src/world/inventory.js` | tree bags, equip, cap, player gear rollup |
| `src/world/templates.js` | test fallback `rat` / `dummy` / `guide`; live uses pack |
| `src/world/creature.js` | spawn + speed / push flags |
| `src/world/summons.js` | `normalizeSummonConfig` / occupancy / living list |
| `src/world/threat.js` | `strategiesTarget` / `changeTarget` / threat half-life |
| `src/world/pathfinder.js` | A* |
| `src/world/path_budget.js` | optional repath budget |
| `src/world/npc.js` | dialog / `when` / shop / wander fields |
| `src/world/snapshot.js` | persist clone |
| `src/world/world.js` | tick: intents → chase/swing → on_demand pins → AI (strategy pick / retarget) → decay |
| `src/world/regen.js` | vocation HP/MP integer-tick regen; equipped `durationSec` decay |
| `src/world/spawn_pins.js` | pin catalog / AOI / respawn seconds |
| `src/world/world_pins.js` | hybrid `world[]` normalize / seed (RAM, not SQL) |
| `src/world/world_pin_actions.js` | USE / Use-with / trap step / decay |

## Remaining

**Trap fields**. Bank/depot. Lever `wave` is a no-op (Hunt Simulator leftover). Do not load HuntDL `presets/`.

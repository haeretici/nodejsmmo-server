'use strict';

const { WorldTick } = require('./tick');
const { C2S, S2C, C2S_ENTERED, C2S_DOWNED, REASON, DIR_DELTA } = require('../protocol/opcodes');
const {
    encodeEnterWorld,
    encodeAppear,
    encodeDisappear,
    encodePong,
    encodeMove,
    encodeViewport,
    encodeStats,
    encodeSwing,
    encodeDeath,
    encodeCorpse,
    encodeCorpseGone,
    encodeContainer,
    encodeItemGain,
    encodeExp,
    encodeInventory,
    encodeEquipment,
    encodeSay,
    encodeSkills,
    encodeDialog,
    encodeDialogClose,
    encodeShop,
    encodeWorldPin,
    encodeWorldPinGone,
    encodeCastFx,
    encodeField,
    encodeFieldGone,
    decodeCast,
    decodePing,
    decodeMoveStep,
    decodeMovePath,
    decodeUseStair,
    decodeUseTile,
    decodeUseItemWith,
    decodeSetTarget,
    decodeOpenCorpse,
    decodeLootTake,
    decodeLootClose,
    decodeTalk,
    decodeTalkReply,
    decodeTalkClose,
    decodeShopDeal,
    decodeEquip,
    decodeUnequip,
    decodeMoveItem,
    decodeContainerSlot
} = require('../protocol/messages');
const { createStaticMap, viewport, viewportWindow, inViewport, clampSpawn } = require('./static_map');
const { fromStaticMap } = require('./tilemap');
const { computeMoveDelay, delayToTicks, isDiagonalStep } = require('./movement');
const { PathBudget, isLogicIntervalDue, seedPathPhase } = require('./path_budget');
const { MonsterComputeService } = require('./monster_compute');
const {
    resolveMelee,
    resolveWandAuto,
    resolveDistanceAuto,
    resolveCreatureAttack,
    resolveSpellHit,
    meleeRangeOk,
    chebyshev,
    classRow,
    playerCombatFromClass,
    applyClassCombatExtras,
    computeAttackLeech,
    spellCanCritOrLeech,
    isKitStatusAttack,
    isKitShapedAttack,
    kitAttackNeedsTarget,
    kitAttackReach,
    kitAttackToSpell,
    rollHit,
    rollCritical,
    rollFatal,
    fatalChanceFromTier,
    SWING_MISS,
    SWING_DEATH,
    SWING_CRIT,
    SWING_FATAL,
    CRIT_BAND_MULTIPLY
} = require('./combat');
const { hasLineOfSight, getAffectedTiles, cardinalDirection } = require('./shapes');
const { rollLoot } = require('./loot');
const { itemDbFromPack, findItem, itemIsContainer, itemIsEquipable, itemIsRune, itemIsUsable, designerSlotToEngine } = require('./items');
const { resolveItemUseEffect, applyItemUseEffect } = require('./item_use');
const {
    takeItem,
    addItemToInventory,
    canCarryAdditional,
    canAddItemToInventory,
    consumeInstanceCount,
    totalCarriedWeight,
    serializeInventory,
    normalizeInventory,
    applyPlayerLoadout,
    bagView,
    equipmentView,
    playerCap,
    ownsContainer,
    resolveLocationUid,
    equipItem,
    unequipItem,
    moveItem,
    consumeAmmoForShot,
    peekAmmoForShot,
    equippedRightHandItem,
    equippedWeaponAmmoKind,
    equippedIsThrowingWeapon,
    tryBreakEquippedThrowingWeapon,
    resolveDistanceAutoShape,
    consumeItemIdFromInventory,
    countItem,
    destroyItem,
    getStackCount
} = require('./inventory');
const { TEMPLATES, getTemplate } = require('./templates');
const { runtimeMap, resolveMapId } = require('../content/load_pack');
const {
    dirFromDelta,
    createCreature,
    createCorpse,
    Creature,
    CreaturePool,
    isCreatureFleeing,
    creatureStandDistance,
    creatureLoseTargetDistance
} = require('./creature');
const {
    isSummon,
    livingSummonsOf,
    ensureSummonRuntime,
    summonMatchesEntry,
    findSummonSpawnTile
} = require('./summons');
const {
    applyThreatDecay,
    recordDamageTakenBy,
    pickCreatureTarget: pickCreatureTargetFromKit,
    armStrategyRetarget,
    clearStrategyRetarget,
    strategyRetargetDue
} = require('./threat');
const {
    DEFAULT_ACTIVATE_MARGIN,
    DEFAULT_DESPAWN_IDLE_TICKS,
    DEFAULT_MAX_LIVING,
    spawnMaxLiving,
    resolveSpawnMode,
    spawnActivateMargin,
    spawnDespawnIdleTicks,
    spawnDespawnHomeDist,
    pinSkipReason,
    respawnDelayTicks,
    inSpawnAoi,
    makePinState,
    minChebyshevToObservers,
    livingPinKeepPriority
} = require('./spawn_pins');
const { snapshotSession } = require('./snapshot');
const {
    applyExpProgression,
    applyPersonalExpRates,
    partySharePerMember,
    processAttackSkillProgression,
    applyManaTowardMagic,
    skillLabel,
    applyLevelPoolDelta
} = require('./progression');
const { parseClock, msUntilClock, globalSaveMessage } = require('./clock_save');
const { PersistGate } = require('../persist/persist_gate');
const {
    DEFAULT_TALK_RANGE,
    SPECTATOR_RANGE,
    isNpcEntity,
    talkRangeOk,
    normalizeDialog,
    resolveDialog,
    resolveNode,
    listReplies,
    applyStoragePatch,
    resolveShop,
    listShopRows,
    findShopRow,
    evalWhen,
    clampDealCount,
    hasNpcIdle,
    intervalMsToTicks,
    npcIsInConversation,
    hasNearbySpectator,
    shuffledCardinals,
    canNpcWalkTo
} = require('./npc');
const {
    WORLD_PIN_ID_BASE,
    worldPinTileKey,
    seedWorldPinInstances,
    applyWorldPinWalkBlock
} = require('./world_pins');
const {
    USE_RANGE,
    pinInUseRange,
    useWorldPin,
    useWorldToolWith,
    onWorldPinStep,
    tickWorldPinDeadlineQueue,
    nextWorldPinDeadline,
    enqueueWorldPinDeadline
} = require('./world_pin_actions');
const Cooldowns = require('./cooldowns');
const {
    tickConditions,
    absorbWithManaShield,
    isCombatantAlive,
    applyCondition,
    isInvisible,
    hasHaste,
    recomputeDerived
} = require('./conditions');
const {
    nativeRegenRates,
    regenIntervalTicks,
    tickNativeRegen,
    tickEquippedDurations,
    tickEquippedItemRegen,
    playerInEngage
} = require('./regen');
const {
    createFieldStore,
    seedMapFieldsFromTileMap,
    seedFloorFields,
    removeFieldsForFloor,
    onEntityTileTransition,
    deployFieldAndTriggerOccupants,
    purgeExpiredFields,
    listFieldsInRect,
    getFieldKind,
    getFieldOnTile
} = require('./fields');
const {
    indexSpellBook,
    findSpell,
    findSpellByRuneItem,
    isRuneSpell,
    resolveCast,
    sayForReason,
    spellHasShape,
    isSelfTargetSpell,
    SPELL_MOVE_LOCK_DEFAULT
} = require('./spells');
const { SpatialIndex } = require('./spatial_index');

const CREATURE_ID_BASE = 1000000000;
const CORPSE_ID_BASE = 2000000000;
const LOGOUT_PERSIST = 'logout';

function kitAttackIsMelee(atk) {
    if (!atk) return false;
    if (atk.isMelee === true || atk.kind === 'melee') return true;
    if (atk.kind && atk.kind !== 'melee') return false;
    return atk.range == null || Number(atk.range) <= 1;
}

class World {
    /**
     * @param {{
     *   settings: object,
     *   store: object,
     *   log?: object,
     *   now?: () => number,
     *   schedule?: Function,
     *   clear?: Function,
     *   maxCatchUp?: number,
     *   rng?: () => number,
     *   onRequestShutdown?: (reason: string) => Promise<void>|void
     * }} opts
     */
    constructor(opts) {
        this.settings = opts.settings;
        this.store = opts.store;
        this.log = opts.log || { error() {}, warn() {}, info() {}, debug() {} };
        this.now = opts.now || (() => Date.now());
        this.rng = opts.rng || Math.random;
        this.onRequestShutdown = opts.onRequestShutdown || null;
        this.pack = opts.pack || null;
        this._itemDb = itemDbFromPack(this.pack);
        this.dialogs = opts.dialogs || (this.pack && this.pack.dialogs) || Object.create(null);
        this.templates = Object.assign(Object.create(null), opts.templates || (this.pack && this.pack.templates) || TEMPLATES);
        for (const id of Object.keys(this.templates)) {
            const tmpl = this.templates[id];
            if (tmpl && !tmpl.dialog && tmpl.dialogId && this.dialogs[tmpl.dialogId]) {
                this.templates[id] = Object.assign({}, tmpl, { dialog: this.dialogs[tmpl.dialogId] });
            }
        }
        this.map = opts.map || (this.pack
            ? runtimeMap(this.pack, resolveMapId(this.settings, this.pack))
            : createStaticMap());
        this.stairs = Array.isArray(this.map.stairs) ? this.map.stairs.slice() : [];
        this.players = new Map();
        this.byAccount = new Map();
        this.creatures = new Map();
        this.activeCreatures = new Set();
        this._aoiFrame = null;
        const poolCap = (opts.settings && opts.settings.creaturePoolCapacity != null)
            ? opts.settings.creaturePoolCapacity
            : 4096;
        this.creaturePool = new CreaturePool(poolCap);
        this.corpses = new Map();
        this.corpseQueue = [];
        this.pendingSpawns = [];
        this.playerSpatial = new SpatialIndex({ chunkSize: 32 });
        this.creatureSpatial = new SpatialIndex({ chunkSize: 32 });
        this.corpseSpatial = new SpatialIndex({ chunkSize: 32 });
        this.worldPinSpatial = new SpatialIndex({ chunkSize: 32 });
        const spawnPinChunkSize = (opts.settings && opts.settings.spawnPinChunkSize != null)
            ? opts.settings.spawnPinChunkSize | 0
            : 64;
        this.spawnPinSpatial = new SpatialIndex({ chunkSize: spawnPinChunkSize });
        this.livingPins = new Set();
        this.eagerPins = [];
        this._conditionHooks = {
            applyHpDelta: (ent, amount, element) => this._applyConditionHpDelta(ent, amount, element)
        };
        this.spawnPins = [];
        this._spawnSkipLogged = new Set();
        this.nextCreatureId = (opts.settings && opts.settings.creatureIdBase) || CREATURE_ID_BASE;
        this.nextCorpseId = (opts.settings && opts.settings.corpseIdBase) || CORPSE_ID_BASE;
        this.nextWorldPinId = (opts.settings && opts.settings.worldPinIdBase) || WORLD_PIN_ID_BASE;
        this.worldPins = [];
        this.worldPinById = new Map();
        this.worldPinByNumeric = new Map();
        this.worldPinsByTile = new Map();
        this.worldPinDeadlines = [];
        this.worldPinLever = { state: Object.create(null), snapshots: Object.create(null) };
        this._persistTails = new Map();
        this._persistGate = new PersistGate(
            (opts.settings && opts.settings.persistConcurrency) || 8
        );
        this._globalSaveTimer = null;
        this._globalNotifyTimer = null;
        this._intervalTimer = null;
        this._intervalRunning = false;
        this._tickIndex = 0;
        this.pathBudget = new PathBudget(
            opts.settings && opts.settings.aiPathBudgetPerFrame
        );
        this.computeService = new MonsterComputeService({
            workers: opts.settings && opts.settings.computeWorkers,
            capacity: opts.settings && opts.settings.computeQueueCapacity,
            visibleReserve: opts.settings && opts.settings.computeVisibleReserve,
            applyDelayTicks: opts.settings && opts.settings.computeApplyDelayTicks,
            creatureIdBase: (opts.settings && opts.settings.creatureIdBase) || 1000000000,
            log: this.log
        });
        const pagedFloors = opts.settings
            ? (opts.settings.pagedFloors !== undefined
                ? !!opts.settings.pagedFloors
                : (opts.settings.floorWindowing !== undefined ? !!opts.settings.floorWindowing : false))
            : false;
        const floorIdleTimeoutSec = opts.settings && opts.settings.floorIdleTimeoutSec != null
            ? Number(opts.settings.floorIdleTimeoutSec)
            : 300;
        this.floorSweepIntervalTicks = opts.settings && opts.settings.floorSweepIntervalTicks != null
            ? Math.max(1, opts.settings.floorSweepIntervalTicks | 0)
            : 200;
        this.floorIdleTimeoutSec = floorIdleTimeoutSec;
        this.pagedFloors = pagedFloors;

        this.tileMap = fromStaticMap(this.map, {
            maxStack: opts.settings && opts.settings.playerTileMaxStack,
            resolveEntity: (id) => this.getEntity(id),
            rng: this.rng,
            crush: opts.settings && opts.settings.creaturePushCrush,
            playerSpatial: this.playerSpatial,
            creatureSpatial: this.creatureSpatial,
            pagedFloors: this.pagedFloors,
            floorIdleTimeoutSec: this.floorIdleTimeoutSec,
            pinnedFloors: opts.settings && opts.settings.pinnedFloors,
            wallNow: this.now,
            onFloorLoaded: (z, layer) => {
                if (this.fieldStore) {
                    seedFloorFields(this.fieldStore, layer, z, { createdAt: 0 });
                }
                this._applyWorldPinsForFloor(z);
            },
            onFloorUnloaded: (z, layer) => {
                if (this.fieldStore) {
                    removeFieldsForFloor(this.fieldStore, z);
                }
                this._unmarkWorldPinsForFloor(z);
            },
            onMove: (entity, fromX, fromY, fromZ, toX, toY, toZ) => {
                this.onEntityMoved(entity, fromX, fromY, fromZ, toX, toY, toZ);
            },
            budget: this.pathBudget,
            computeService: this.computeService,
            path: {
                maxDistance: opts.settings && opts.settings.pathMaxDistance,
                maxIterations: opts.settings && opts.settings.pathMaxIterations,
                repathIntervalSec: opts.settings && opts.settings.aiRepathIntervalSec,
                failBackoffSec: opts.settings && opts.settings.aiRepathFailBackoffSec,
                occupantStepPenalty: opts.settings && opts.settings.aiOccupantStepPenalty,
                allowDiagonal: true
            },
            onCrush: (target, mover) => {
                if (target && target.type === 'creature') {
                    this.kill(target, mover, this._tickIndex);
                }
            },
            onPushed: (target, from) => {
                const dir = dirFromDelta(
                    (target.x | 0) - (from.x | 0),
                    (target.y | 0) - (from.y | 0)
                );
                target.dir = dir;
                this.broadcastMove(target, from, dir);
            }
        });
        this.computeService.tileMap = this.tileMap;
        this.tick = new WorldTick({
            ups: (opts.settings && opts.settings.logicUps) || 20,
            now: this.now,
            schedule: opts.schedule,
            clear: opts.clear,
            maxCatchUp: opts.maxCatchUp,
            onTick: (i) => this.step(i)
        });
        this.spellBook = indexSpellBook(this.pack && this.pack.spells);
        this.fieldStore = createFieldStore(this.tileMap);
        this.delayedCasts = [];
        this._batchingOutbound = false;
        this._dirtyOutboundSessions = new Set();
        this.seedSpawns();
        this.seedWorldPins();
        seedMapFieldsFromTileMap(this.fieldStore, this.tileMap, { createdAt: 0 });
    }

    start() {
        if (this.computeService) {
            this.computeService.start();
        }
        this.tick.start();
        this._scheduleGlobalSave();
        this._scheduleIntervalSave();
    }

    stop() {
        if (this.computeService) {
            this.computeService.stop();
        }
        this.tick.stop();
        this._stopPersistClock();
        for (const session of Array.from(this.players.values())) {
            session.kick(REASON.LOGOUT);
        }
    }

    async shutdown() {
        this.stop();
        await this.flushPersist();
    }

    snapshot() {
        return Object.assign({}, this.tick.snapshot(), {
            players: this.players.size,
            creatures: this.creatures.size,
            activeCreatures: this.activeCreatures ? this.activeCreatures.size : 0,
            corpses: this.corpses.size,
            creaturePool: this.creaturePool ? this.creaturePool.size : 0,
            compute: this.computeService ? this.computeService.stats() : null
        });
    }

    playerCount() {
        return this.players.size;
    }

    getByCharacter(id) {
        return this.players.get(Number(id)) || null;
    }

    getByAccount(id) {
        return this.byAccount.get(Number(id)) || null;
    }

    getEntity(id) {
        const n = Number(id);
        return this.players.get(n) || this.creatures.get(n) || null;
    }

    onEntityMoved(entity, fromX, fromY, fromZ, toX, toY, toZ) {
        if (!entity) return;
        const id = entity.id != null ? entity.id : (entity.character && entity.character.id);
        if (entity.type === 'player' || (id != null && this.players.has(id))) {
            this.playerSpatial.update(entity);
        } else if (entity.type === 'creature' || entity.type === 'npc' || (id != null && this.creatures.has(id))) {
            this.creatureSpatial.update(entity);
        }
    }

    sees(observer, x, y, z) {
        if (!observer || observer.downed) return false;
        return inViewport(
            this.map, observer.x, observer.y, x, y, z, null, null, observer.z
        );
    }

    viewportOf(entity) {
        return viewport(this.map, entity.x, entity.y, null, null, entity.z);
    }

    pvpOn() {
        return !!(this.settings.features && this.settings.features.pvp);
    }

    stepDelay(entity, destFriction, isDiagonal) {
        if (this.settings.fixedStepDelay) {
            if (entity && entity.type === 'creature') {
                return Math.max(1, (this.settings.creatureStepDelayTicks | 0) || 5);
            }
            return Math.max(1, (this.settings.stepDelayTicks | 0) || 1);
        }
        const sec = computeMoveDelay(
            destFriction,
            this.entitySpeed(entity),
            !!isDiagonal,
            {
                diagonalFactor: this.settings.moveDiagonalFactor,
                minDelay: this.settings.moveMinDelay
            }
        );
        return delayToTicks(sec, this.settings.logicUps);
    }

    entitySpeed(entity) {
        if (!entity) return (this.settings.defaultCreatureSpeed | 0) || 100;
        if (entity.speed != null && Number.isFinite(Number(entity.speed))) {
            return Number(entity.speed);
        }
        if (entity.type === 'player') {
            if (entity.baseSpeed != null && Number.isFinite(Number(entity.baseSpeed))) {
                return Number(entity.baseSpeed);
            }
            const base = (this.settings.playerBaseSpeed | 0) || 110;
            const level = (entity.level | 0) || 1;
            return base + Math.max(0, level - 1);
        }
        return (this.settings.defaultCreatureSpeed | 0) || 100;
    }

    logicNow(tickIndex) {
        const ups = (this.settings.logicUps | 0) || 20;
        return (tickIndex | 0) / ups;
    }

    pathCap(entity, opts) {
        if (opts && opts.maxDistance != null) return Number(opts.maxDistance);
        if (entity && entity.type === 'player') {
            return (this.settings.pathMaxDistance | 0) || 100;
        }
        const n = this.settings.aiCreaturePathMaxDistance;
        return n != null ? n | 0 : 12;
    }

    autoInterval() {
        return Math.max(1, (this.settings.autoIntervalTicks | 0) || 40);
    }

    seedSpawns() {
        const packMap = this.map;
        const overlay = Object.prototype.hasOwnProperty.call(this.settings, 'spawns')
            || Object.prototype.hasOwnProperty.call(this.settings, 'npcs');
        const list = Object.prototype.hasOwnProperty.call(this.settings, 'spawns')
            ? (this.settings.spawns || [])
            : ((packMap && packMap.spawns) || []);
        const npcs = Object.prototype.hasOwnProperty.call(this.settings, 'npcs')
            ? (this.settings.npcs || [])
            : ((packMap && packMap.npcs) || []);
        const rows = [];
        for (let i = 0; i < list.length; i++) {
            if (list[i]) rows.push(list[i]);
        }
        for (let i = 0; i < npcs.length; i++) {
            if (npcs[i]) rows.push(npcs[i]);
        }
        this.spawnMode = resolveSpawnMode(this.settings, overlay);
        this.spawnPins = [];
        if (this.spawnPinSpatial) this.spawnPinSpatial.clear();
        if (this.livingPins) this.livingPins.clear();
        this.eagerPins = [];
        for (let i = 0; i < rows.length; i++) {
            const pin = makePinState(rows[i], this.spawnPins.length, this.spawnMode === 'eager');
            const template = getTemplate(pin.kind, this.templates);
            const skip = pinSkipReason(template, this.dialogs);
            if (skip) {
                pin.state = 'skipped';
                pin.skipReason = skip;
                this.logSpawnSkip(pin.kind, skip);
            }
            this.spawnPins.push(pin);
            if (pin.state !== 'skipped') {
                if (this.spawnPinSpatial) {
                    this.spawnPinSpatial.insert({ id: pin.index, x: pin.x, y: pin.y, z: pin.z, pin });
                }
                if (pin.eager) {
                    this.eagerPins.push(pin);
                }
            }
        }
        if (this.spawnMode === 'eager') {
            for (let i = 0; i < this.spawnPins.length; i++) {
                this.activatePin(this.spawnPins[i], 0, { appear: false });
            }
        }
    }

    worldPinRows() {
        if (Object.prototype.hasOwnProperty.call(this.settings, 'world')) {
            return this.settings.world || [];
        }
        return (this.map && this.map.world) || [];
    }

    seedWorldPins() {
        this.worldPins = [];
        this.worldPinById = new Map();
        this.worldPinByNumeric = new Map();
        this.worldPinsByTile = new Map();
        this.worldPinDeadlines = [];
        if (this.worldPinSpatial) this.worldPinSpatial.clear();
        this.worldPinLever = { state: Object.create(null), snapshots: Object.create(null) };
        const seeded = seedWorldPinInstances(
            this.worldPinRows(),
            this.tileMap,
            this.nextWorldPinId
        );
        this.nextWorldPinId = seeded.nextId;
        for (let i = 0; i < seeded.instances.length; i++) {
            this.indexWorldPin(seeded.instances[i]);
        }
    }

    indexWorldPin(inst) {
        if (!inst || inst.removed) return;
        this.worldPins.push(inst);
        this.worldPinById.set(inst.pinId, inst);
        this.worldPinByNumeric.set(inst.id, inst);
        this.worldPinsByTile.set(worldPinTileKey(inst.x, inst.y, inst.z), inst);
        if (this.worldPinSpatial) this.worldPinSpatial.insert(inst);
        this.scheduleWorldPinDeadline(inst, 0);
    }

    scheduleWorldPinDeadline(inst, nowSec) {
        if (!inst || inst.removed) return;
        const at = nextWorldPinDeadline(inst, nowSec);
        if (at == null) return;
        enqueueWorldPinDeadline(this.worldPinDeadlines, at, inst.id);
    }

    worldPinAt(x, y, z) {
        const inst = this.worldPinsByTile.get(worldPinTileKey(x, y, z));
        if (!inst || inst.removed) return null;
        return inst;
    }

    _applyWorldPinsForFloor(z) {
        if (!this.worldPins || !this.tileMap) return;
        const zi = z | 0;
        for (let i = 0; i < this.worldPins.length; i++) {
            const inst = this.worldPins[i];
            if (!inst || (inst.z | 0) !== zi) continue;
            applyWorldPinWalkBlock(this.tileMap, inst);
        }
    }

    _unmarkWorldPinsForFloor(z) {
        if (!this.worldPins) return;
        const zi = z | 0;
        for (let i = 0; i < this.worldPins.length; i++) {
            const inst = this.worldPins[i];
            if (!inst || (inst.z | 0) !== zi) continue;
            inst.frictionPatched = false;
        }
    }

    addLeverSpawns(rows) {
        const list = Array.isArray(rows) ? rows : [];
        for (let i = 0; i < list.length; i++) {
            const row = list[i];
            if (!row) continue;
            const pin = makePinState(row, this.spawnPins.length, true);
            const template = getTemplate(pin.kind, this.templates);
            const skip = pinSkipReason(template);
            if (skip) {
                pin.state = 'skipped';
                pin.skipReason = skip;
                this.logSpawnSkip(pin.kind, skip);
                this.spawnPins.push(pin);
                continue;
            }
            this.spawnPins.push(pin);
            if (this.spawnPinSpatial) {
                this.spawnPinSpatial.insert({ id: pin.index, x: pin.x, y: pin.y, z: pin.z, pin });
            }
            this.activatePin(pin, this._tickIndex);
        }
    }

    logSpawnSkip(kind, reason) {
        const key = `${reason}:${kind}`;
        if (this._spawnSkipLogged.has(key)) return;
        this._spawnSkipLogged.add(key);
        this.log.warn('spawn pin skipped', { kind, reason });
    }

    spawnCreature(kind, x, y, z, opts) {
        const template = getTemplate(kind, this.templates);
        if (!template) return null;
        if (pinSkipReason(template, this.dialogs)) return null;
        const id = this.nextCreatureId;
        this.nextCreatureId += 1;
        const creature = this.creaturePool
            ? this.creaturePool.obtain(id, template, { x: x | 0, y: y | 0, z: z | 0 })
            : createCreature(id, template, { x: x | 0, y: y | 0, z: z | 0 });
        if (opts && opts.pinIndex != null) creature.pinIndex = opts.pinIndex | 0;
        if (opts && opts.masterId) creature.masterId = opts.masterId | 0;
        if (!this.tileMap.enterTile(creature.x, creature.y, creature.z, creature)) {
            const alt = this.tileMap.findNearestEnterable(
                creature.x, creature.y, creature.z, creature
            );
            if (!alt || !this.tileMap.enterTile(alt.x, alt.y, alt.z, creature)) {
                if (this.creaturePool) this.creaturePool.release(creature);
                return null;
            }
            creature.x = alt.x;
            creature.y = alt.y;
            creature.z = alt.z;
            creature.spawnX = alt.x;
            creature.spawnY = alt.y;
            creature.spawnZ = alt.z;
        }
        this.creatures.set(creature.id, creature);
        if (this.creatureSpatial) this.creatureSpatial.insert(creature);
        if (!creature.simSleeping && (creature.hp | 0) > 0 && !isNpcEntity(creature)) {
            this.activeCreatures.add(creature);
        }
        Cooldowns.ensureCooldowns(creature);
        if (creature.speed != null) creature.baseSpeed = Number(creature.speed);
        seedPathPhase(
            creature,
            this.settings.aiRepathIntervalSec,
            this.logicNow(this._tickIndex)
        );
        if (!opts || opts.appear !== false) this.broadcastAppear(creature);
        return creature;
    }

    summonIntervalTicks(entry) {
        const ms = entry && entry.intervalMs != null ? Number(entry.intervalMs) : 2000;
        const ticks = intervalMsToTicks(ms, (this.settings.logicUps | 0) || 20);
        return Math.max(1, ticks | 0);
    }

    /**
     * Spawn a kit summon on an empty adjacent tile. No pin / no respawn slot.
     * @param {{ creatureId?: string, id?: string, master: object, x?: number, y?: number, z?: number }} opts
     * @returns {object|null}
     */
    spawnSummon(opts) {
        const o = opts || {};
        const master = o.master;
        if (!master || (master.hp | 0) <= 0) return null;
        if (isSummon(master)) return null;
        const creatureId = o.creatureId || o.id;
        if (!creatureId) return null;
        const mx = o.x != null ? o.x | 0 : master.x | 0;
        const my = o.y != null ? o.y | 0 : master.y | 0;
        const z = o.z != null ? o.z | 0 : master.z | 0;
        if (!getTemplate(creatureId, this.templates)) return null;
        const tile = findSummonSpawnTile(this.tileMap, mx, my, z, {
            type: 'creature',
            canPushCreatures: false
        });
        if (!tile) return null;
        const creature = this.spawnCreature(creatureId, tile.x, tile.y, tile.z, {
            masterId: master.id,
            appear: true
        });
        if (!creature) return null;
        creature.masterId = master.id | 0;
        creature.spawnX = master.spawnX | 0;
        creature.spawnY = master.spawnY | 0;
        creature.spawnZ = master.spawnZ | 0;
        creature.pinIndex = null;
        const sticky = o.target && o.target.id ? o.target : this.getEntity(master.targetId);
        if (sticky && sticky.id) creature.targetId = sticky.id | 0;
        if (!Array.isArray(master.summonIds)) master.summonIds = [];
        master.summonIds.push(creature.id);
        return creature;
    }

    unlinkSummon(summon) {
        if (!summon || summon.masterId == null || !(summon.masterId > 0)) return;
        const master = this.getEntity(summon.masterId);
        if (master && Array.isArray(master.summonIds)) {
            master.summonIds = master.summonIds.filter((id) => id !== summon.id);
        }
        summon.masterId = 0;
    }

    /**
     * Master gone → dismiss living adds (no corpse, no exp, no respawn).
     * @param {object} master
     * @param {number} tickIndex
     */
    dismissSummonsOf(master, tickIndex) {
        if (!master || !Array.isArray(master.summonIds) || !master.summonIds.length) return;
        const ids = master.summonIds.slice();
        master.summonIds = [];
        const tick = tickIndex != null ? tickIndex : this._tickIndex;
        for (let i = 0; i < ids.length; i++) {
            const s = this.creatures.get(ids[i]);
            if (!s || (s.hp | 0) <= 0) continue;
            s.masterId = 0;
            this.killCreature(s, null, tick, { dismiss: true });
        }
    }

    activatePin(pin, tickIndex, opts) {
        if (!pin || pin.state === 'skipped' || pin.state === 'living') return null;
        if ((tickIndex | 0) < (pin.readyTick | 0)) return null;
        const maxLiving = spawnMaxLiving(this.settings);
        if (maxLiving > 0 && !pin.eager && this.livingPins && this.livingPins.size >= maxLiving) {
            const victim = this.pickBudgetVictim(null, pin);
            if (!victim) return null;
            this.despawnPin(victim, { reason: 'budget', tickIndex });
        }
        const creature = pin.parkedEntity
            ? this.unparkPin(pin, tickIndex, opts)
            : this.spawnCreature(pin.kind, pin.x, pin.y, pin.z, {
                pinIndex: pin.index,
                appear: opts && opts.appear
            });
        if (!creature) {
            pin.readyTick = (tickIndex | 0) + 20;
            return null;
        }
        pin.state = 'living';
        pin.entityId = creature.id;
        pin.idleTicks = 0;
        pin.parkedEntity = null;
        if (this.livingPins) this.livingPins.add(pin);
        creature.spawnX = pin.x;
        creature.spawnY = pin.y;
        creature.spawnZ = pin.z;
        creature.pinIndex = pin.index;
        this.noteAoiCreature(creature);
        return creature;
    }

    unparkPin(pin, tickIndex, opts) {
        const creature = pin.parkedEntity;
        if (!creature) return null;
        const appear = !opts || opts.appear !== false;
        let x = creature.x | 0;
        let y = creature.y | 0;
        let z = creature.z != null ? creature.z | 0 : pin.z | 0;
        if (!this.tileMap.enterTile(x, y, z, creature)) {
            const alt = this.tileMap.findNearestEnterable(x, y, z, creature)
                || this.tileMap.findNearestEnterable(pin.x, pin.y, pin.z, creature);
            if (!alt || !this.tileMap.enterTile(alt.x, alt.y, alt.z, creature)) {
                return null;
            }
            x = alt.x;
            y = alt.y;
            z = alt.z;
            creature.x = x;
            creature.y = y;
            creature.z = z;
        }
        creature.targetId = 0;
        creature.leashing = false;
        if (Array.isArray(creature.path)) creature.path.length = 0;
        this.creatures.set(creature.id, creature);
        if (this.creatureSpatial) this.creatureSpatial.insert(creature);
        if (!creature.simSleeping && (creature.hp | 0) > 0 && !isNpcEntity(creature)) {
            this.activeCreatures.add(creature);
        }
        if (appear) this.broadcastAppear(creature);
        return creature;
    }

    despawnPin(pin, opts) {
        if (!pin || pin.state !== 'living' || pin.eager) return;
        const reason = (opts && opts.reason) || 'idle_aoi';
        const tickIndex = opts && opts.tickIndex != null ? opts.tickIndex : this._tickIndex;
        if (this.livingPins) this.livingPins.delete(pin);
        const creature = this.creatures.get(pin.entityId);
        const park = (reason === 'idle_aoi' || reason === 'budget') && creature && (creature.hp | 0) > 0;
        if (creature) {
            this.dismissSummonsOf(creature, tickIndex);
            if (this.computeService) {
                this.computeService.cancelEntityJobs(creature.id);
            }
            creature._computeToken = null;
            this.tileMap.leaveTile(creature.x, creature.y, creature.z, creature);
            this.creatures.delete(creature.id);
            this.activeCreatures.delete(creature);
            if (this.creatureSpatial) this.creatureSpatial.remove(creature.id);
            this.clearTarget(creature.id);
            this.broadcastToViewers(creature.x, creature.y, creature.z, (p) => {
                p.send(S2C.DISAPPEAR, encodeDisappear(creature.id));
            });
            if (park) {
                creature.simSleeping = true;
                creature.targetId = 0;
                creature.leashing = false;
                if (Array.isArray(creature.path)) creature.path.length = 0;
                pin.parkedEntity = creature;
            } else {
                pin.parkedEntity = null;
                if (this.creaturePool) this.creaturePool.release(creature);
            }
        } else {
            pin.parkedEntity = null;
        }
        pin.entityId = 0;
        pin.idleTicks = 0;
        if (reason === 'home_distance' || reason === 'home_floor') {
            pin.parkedEntity = null;
            const delay = respawnDelayTicks(pin, this.settings);
            if (delay <= 0) {
                pin.state = 'skipped';
                pin.skipReason = 'oneshot';
                pin.readyTick = 0;
            } else {
                pin.state = 'cooldown';
                pin.readyTick = (tickIndex | 0) + delay;
            }
            return;
        }
        pin.state = 'idle';
        pin.readyTick = 0;
    }

    isCreatureInCombat(cr, playerTargets) {
        if (!cr) return false;
        if (cr.targetId) return true;
        if (cr.leashing) return true;
        if (playerTargets) return playerTargets.has(cr.id);
        const candidates = this.playerSpatial
            ? this.playerSpatial.queryChunkCandidates(cr.x, cr.y, cr.z, 16)
            : this.players.values();
        for (const p of candidates) {
            if (!p.dead && !p.downed && p.targetId === cr.id) return true;
        }
        return false;
    }

    pinInCombat(pin, playerTargets) {
        if (!pin || pin.state !== 'living') return false;
        const creature = this.creatures.get(pin.entityId);
        if (!creature) return false;
        return this.isCreatureInCombat(creature, playerTargets);
    }

    pickBudgetVictim(observers, incomingPin, playerTargets) {
        if (!this.livingPins || this.livingPins.size === 0) return null;
        const activeObservers = observers || Array.from(this.players.values()).filter((p) => !p.dead && !p.downed);
        let bestPin = null;
        let bestPri = Infinity;
        let incomingPri = Infinity;

        if (incomingPin) {
            const template = getTemplate(incomingPin.kind, this.templates);
            incomingPri = livingPinKeepPriority(incomingPin, null, activeObservers, template);
        }

        for (const pin of this.livingPins) {
            if (pin.eager) continue;
            const creature = this.creatures.get(pin.entityId);
            if (!creature) {
                return pin;
            }
            if (this.pinInCombat(pin, playerTargets)) continue;
            const template = getTemplate(pin.kind, this.templates);
            const pri = livingPinKeepPriority(pin, creature, activeObservers, template);
            if (pri >= 1e11) continue;
            if (incomingPin && pri >= incomingPri) continue;

            if (pri < bestPri || (pri === bestPri && bestPin && pin.index < bestPin.index)) {
                bestPri = pri;
                bestPin = pin;
            }
        }
        return bestPin;
    }

    invalidateAoiFrame() {
        this._aoiFrame = null;
    }

    aoiFrameKey(tickIndex, observers, radius, margin) {
        let key = (tickIndex | 0) + '|' + (radius | 0) + '|' + (margin | 0) + '|' + observers.length;
        for (let i = 0; i < observers.length; i++) {
            const o = observers[i];
            key += '|' + (o.id | 0) + ':' + (o.x | 0) + ',' + (o.y | 0) + ',' + (o.z | 0);
        }
        return key;
    }

    ensureAoiFrame(tickIndex) {
        const radius = (this.settings && this.settings.aiTickRadius != null)
            ? (this.settings.aiTickRadius | 0)
            : 12;
        const margin = spawnActivateMargin(this.settings);
        const observers = [];
        const playerTargets = new Set();
        for (const p of this.players.values()) {
            if (p.dead || p.downed) continue;
            observers.push(p);
            if (p.targetId) playerTargets.add(p.targetId);
        }
        const key = this.aoiFrameKey(tickIndex, observers, radius, margin);
        if (this._aoiFrame && this._aoiFrame.key === key) {
            this._aoiFrame.playerTargets = playerTargets;
            return this._aoiFrame;
        }
        return this.buildAoiFrame(tickIndex | 0, observers, playerTargets, radius, margin, key);
    }

    buildAoiFrame(tickIndex, observers, playerTargets, radius, margin, key) {
        const nearbyCreatures = new Set();
        const nearbyCreatureIds = new Set();
        const spawnPins = [];
        const spawnPinSeen = new Set();
        let usedCreatureSpatial = false;
        let usedSpawnPinSpatial = false;

        for (let i = 0; i < observers.length; i++) {
            const ob = observers[i];
            const px = ob.x | 0;
            const py = ob.y | 0;
            const pz = ob.z | 0;
            if (radius > 0) {
                const creatureCandidates = this.creatureSpatial
                    ? this.creatureSpatial.queryChunkCandidates(px, py, pz, radius)
                    : this.creatures.values();
                if (this.creatureSpatial) usedCreatureSpatial = true;
                for (const cr of creatureCandidates) {
                    if (!cr || (cr.hp | 0) <= 0 || isNpcEntity(cr)) continue;
                    if ((cr.z | 0) !== pz) continue;
                    if (chebyshev(cr.x | 0, cr.y | 0, px, py) <= radius) {
                        nearbyCreatures.add(cr);
                        nearbyCreatureIds.add(cr.id);
                    }
                }
            }
            if (this.spawnPins && this.spawnPins.length) {
                const win = viewportWindow(this.map, px, py, null, null, pz);
                const minX = win.originX - margin;
                const maxX = win.originX + win.width + margin - 1;
                const minY = win.originY - margin;
                const maxY = win.originY + win.height + margin - 1;
                const pinEntries = this.spawnPinSpatial
                    ? this.spawnPinSpatial.queryRect(minX, minY, maxX, maxY, pz)
                    : this.spawnPins;
                if (this.spawnPinSpatial) usedSpawnPinSpatial = true;
                for (let p = 0; p < pinEntries.length; p++) {
                    const entry = pinEntries[p];
                    const pin = entry.pin || entry;
                    if (!pin || pin.state === 'skipped') continue;
                    if (spawnPinSeen.has(pin.index)) continue;
                    spawnPinSeen.add(pin.index);
                    if (inSpawnAoi(this.map, px, py, pz, pin.x, pin.y, pin.z, margin)) {
                        spawnPins.push(pin);
                    }
                }
            }
        }

        const frame = {
            key,
            tickIndex: tickIndex | 0,
            radius,
            margin,
            observers,
            playerTargets,
            nearbyCreatures,
            nearbyCreatureIds,
            spawnPins,
            usedCreatureSpatial,
            usedSpawnPinSpatial
        };
        this._aoiFrame = frame;
        return frame;
    }

    noteAoiCreature(creature) {
        const frame = this._aoiFrame;
        if (!frame || !creature) return;
        frame.nearbyCreatures.add(creature);
        if (creature.id != null) frame.nearbyCreatureIds.add(creature.id);
    }

    tickSpawnPins(tickIndex, opts) {
        if (!this.spawnPins.length) return;
        const appear = !opts || opts.appear !== false;
        const frame = this.ensureAoiFrame(tickIndex);
        const margin = frame.margin;
        const idleLimit = spawnDespawnIdleTicks(this.settings);
        const homeDist = spawnDespawnHomeDist(this.settings);
        const maxLiving = spawnMaxLiving(this.settings);
        const observers = frame.observers;
        const playerTargets = frame.playerTargets;

        if (this.livingPins && this.livingPins.size > 0) {
            const livingList = Array.from(this.livingPins);
            for (let i = 0; i < livingList.length; i++) {
                const pin = livingList[i];
                if (pin.eager) continue;
                const creature = this.creatures.get(pin.entityId);
                if (!creature) {
                    pin.state = 'idle';
                    pin.entityId = 0;
                    this.livingPins.delete(pin);
                    continue;
                }
                if (homeDist > 0) {
                    const sameFloor = (creature.z | 0) === (pin.z | 0);
                    if (!sameFloor) {
                        this.despawnPin(pin, { reason: 'home_floor', tickIndex });
                        continue;
                    }
                    if (chebyshev(creature.x | 0, creature.y | 0, pin.x | 0, pin.y | 0) > homeDist) {
                        this.despawnPin(pin, { reason: 'home_distance', tickIndex });
                        continue;
                    }
                }
                let seen = false;
                for (let o = 0; o < observers.length; o++) {
                    const ob = observers[o];
                    if (inSpawnAoi(
                        this.map, ob.x, ob.y, ob.z, creature.x, creature.y, creature.z, margin
                    )) {
                        seen = true;
                        break;
                    }
                }
                if (seen || this.pinInCombat(pin, playerTargets)) {
                    pin.idleTicks = 0;
                    continue;
                }
                pin.idleTicks += 1;
                if (pin.idleTicks >= idleLimit) {
                    this.despawnPin(pin, { reason: 'idle_aoi', tickIndex });
                }
            }
        }

        if (maxLiving > 0 && this.livingPins && this.livingPins.size > maxLiving) {
            while (this.livingPins.size > maxLiving) {
                const victim = this.pickBudgetVictim(observers, null, playerTargets);
                if (!victim) break;
                this.despawnPin(victim, { reason: 'budget', tickIndex });
            }
        }

        if (this.eagerPins && this.eagerPins.length) {
            for (let i = 0; i < this.eagerPins.length; i++) {
                const pin = this.eagerPins[i];
                if (pin.state === 'idle' || pin.state === 'cooldown') {
                    this.activatePin(pin, tickIndex, { appear });
                }
            }
        }

        if (observers.length > 0) {
            const candidates = [];
            for (let i = 0; i < frame.spawnPins.length; i++) {
                const pin = frame.spawnPins[i];
                if (pin.state === 'skipped' || pin.state === 'living' || pin.eager) continue;
                candidates.push(pin);
            }
            if (candidates.length > 0) {
                if (maxLiving > 0 && candidates.length > 1) {
                    candidates.sort((a, b) => {
                        const da = minChebyshevToObservers(a.x, a.y, a.z, observers);
                        const db = minChebyshevToObservers(b.x, b.y, b.z, observers);
                        if (da !== db) return da - db;
                        return a.index - b.index;
                    });
                }
                for (let i = 0; i < candidates.length; i++) {
                    const pin = candidates[i];
                    if (maxLiving > 0 && this.livingPins && this.livingPins.size >= maxLiving) {
                        const victim = this.pickBudgetVictim(observers, pin, playerTargets);
                        if (!victim) continue;
                        this.despawnPin(victim, { reason: 'budget', tickIndex });
                    }
                    this.activatePin(pin, tickIndex, { appear });
                }
            }
        }
    }

    add(session) {
        const ch = session.character;
        if (!ch) return false;
        if (!this.tileMap.enterTile(session.x, session.y, session.z, session)) {
            const alt = this.tileMap.findNearestEnterable(
                session.x, session.y, session.z, session
            );
            if (!alt || !this.tileMap.enterTile(alt.x, alt.y, alt.z, session)) {
                return false;
            }
            session.x = alt.x;
            session.y = alt.y;
            session.z = alt.z;
        }
        const cls = classRow(this.pack, ch.vocation);
        const combat = playerCombatFromClass(cls);
        session._baseCritChance = combat.critChance;
        session._baseCritDamage = combat.critDamage;
        session.critChance = combat.critChance;
        session.critDamage = combat.critDamage;
        session.skillRates = cls && cls.skillRates && typeof cls.skillRates === 'object'
            ? cls.skillRates
            : null;
        session.knownSpells = cls && Array.isArray(cls.spells) ? cls.spells.slice() : [];
        session.vocation = ch.vocation || '';
        applyClassCombatExtras(session, cls, this.settings);
        Cooldowns.ensureCooldowns(session);
        applyPlayerLoadout(session, this.itemDb());
        recomputeDerived(session);
        this.players.set(ch.id, session);
        this.byAccount.set(ch.accountId, session);
        if (this.playerSpatial) this.playerSpatial.insert(session);
        this.invalidateAoiFrame();
        return true;
    }

    leave(session) {
        if (session.left) return;
        session.left = true;
        const ch = session.character;
        if (!ch) return;
        if (!session.downed) {
            this.tileMap.leaveTile(session.x, session.y, session.z, session);
        }
        if (this.players.get(ch.id) === session) {
            this.players.delete(ch.id);
            if (this.playerSpatial) this.playerSpatial.remove(ch.id);
        }
        if (this.byAccount.get(ch.accountId) === session) {
            this.byAccount.delete(ch.accountId);
        }
        this.clearTarget(ch.id);
        this.closeTalk(session, false);
        this.invalidateAoiFrame();
        this.broadcastDisappear(ch.id, session);
        if (this._dirtyOutboundSessions) {
            this._dirtyOutboundSessions.delete(session);
        }
        if (typeof session.clearOutbound === 'function') {
            session.clearOutbound();
        }
        this.enqueuePersist(session, LOGOUT_PERSIST);
    }

    markOutboundDirty(session) {
        if (session && !session.dead && this._dirtyOutboundSessions) {
            this._dirtyOutboundSessions.add(session);
        }
    }

    flushOutbound(opts) {
        if (!this._dirtyOutboundSessions || this._dirtyOutboundSessions.size === 0) {
            return 0;
        }
        let total = 0;
        for (const session of this._dirtyOutboundSessions) {
            if (!session.dead) {
                total += session.flushOutbound(opts);
            } else if (typeof session.clearOutbound === 'function') {
                session.clearOutbound();
            }
        }
        this._dirtyOutboundSessions.clear();
        return total;
    }

    sendEnterWorld(session) {
        const vp = this.viewportOf(session);
        session.send(S2C.ENTER_WORLD, encodeEnterWorld({
            character: session.character,
            x: session.x,
            y: session.y,
            z: session.z,
            viewport: vp
        }));
        this.tickSpawnPins(this.tick.tickIndex, { appear: false });
        this.sendInventory(session);
        this.sendSkills(session);
    }

    syncAppears(session) {
        const candidatePlayers = this.playerSpatial
            ? this.playerSpatial.queryChunkCandidates(session.x, session.y, session.z, 16)
            : this.players.values();
        for (const other of candidatePlayers) {
            if (other === session || other.downed || other.dead) continue;
            if (this.sees(other, session.x, session.y, session.z)) {
                other.send(S2C.APPEAR, encodeAppear(session));
            }
            if (this.sees(session, other.x, other.y, other.z)) {
                session.send(S2C.APPEAR, encodeAppear(other));
            }
        }
        const candidateCreatures = this.creatureSpatial
            ? this.creatureSpatial.queryChunkCandidates(session.x, session.y, session.z, 16)
            : this.creatures.values();
        for (const cr of candidateCreatures) {
            if (this.sees(session, cr.x, cr.y, cr.z)) {
                session.send(S2C.APPEAR, encodeAppear(cr));
            }
        }
        const candidateCorpses = this.corpseSpatial
            ? this.corpseSpatial.queryChunkCandidates(session.x, session.y, session.z, 16)
            : this.corpses.values();
        for (const corpse of candidateCorpses) {
            if (this.sees(session, corpse.x, corpse.y, corpse.z)) {
                session.send(S2C.CORPSE, encodeCorpse(corpse));
            }
        }
        const candidatePins = this.worldPinSpatial
            ? this.worldPinSpatial.queryChunkCandidates(session.x, session.y, session.z, 16)
            : this.worldPins;
        for (let i = 0; i < candidatePins.length; i++) {
            const inst = candidatePins[i];
            if (!inst || inst.removed) continue;
            if (this.sees(session, inst.x, inst.y, inst.z)) {
                session.send(S2C.WORLD_PIN, encodeWorldPin(inst));
            }
        }
        this.sendFieldsInView(session);
    }

    broadcastAppear(entity) {
        const buf = encodeAppear(entity);
        const candidates = this.viewerCandidates(entity.x, entity.y, entity.z, 16);
        for (const p of candidates) {
            if (p.downed || p.dead) continue;
            if (this.sees(p, entity.x, entity.y, entity.z)) {
                p.send(S2C.APPEAR, buf);
            }
        }
    }

    broadcastDisappear(id, leaving) {
        const x = leaving.x;
        const y = leaving.y;
        const z = leaving.z;
        const candidates = this.viewerCandidates(x, y, z, 16);
        for (const other of candidates) {
            if (other === leaving || other.downed || other.dead) continue;
            if (this.sees(other, x, y, z)) {
                other.send(S2C.DISAPPEAR, encodeDisappear(id));
            }
        }
    }

    spawnPos(ch) {
        return clampSpawn(this.map, ch.posX, ch.posY, ch.posZ);
    }

    enqueueIntent(session, frame) {
        if (session.dead || !session.entered) return false;
        if (!C2S_ENTERED.has(frame.opcode)) {
            session.reject(frame.seq, REASON.UNKNOWN_OPCODE);
            return false;
        }
        if (frame.seq !== session.nextClientSeq) {
            session.reject(frame.seq, REASON.BAD_SEQ);
            return false;
        }
        session.nextClientSeq += 1;
        if (session.downed && !C2S_DOWNED.has(frame.opcode)) {
            session.reject(frame.seq, REASON.BUSY);
            return false;
        }
        const cap = this.settings.limits.maxIntentsPerTick | 0 || 5;
        if (session.intentQueue.length >= cap) {
            session.reject(frame.seq, REASON.RATE_LIMITED);
            return false;
        }
        session.intentQueue.push(frame);
        return true;
    }

    drainComputeCompletions(tickIndex) {
        if (!this.computeService) return;
        const completions = this.computeService.drainCompletions();
        if (!completions || completions.length === 0) return;

        const now = this.logicNow(tickIndex);
        const failBackoff = this.tileMap && this.tileMap.pathOpts && this.tileMap.pathOpts.failBackoffSec != null
            ? Number(this.tileMap.pathOpts.failBackoffSec)
            : 0.25;

        for (let i = 0; i < completions.length; i++) {
            const comp = completions[i];
            const cr = this.creatures.get(comp.entityId);
            if (!cr || cr.dead || (cr.hp | 0) <= 0) {
                this.computeService.recordStale();
                continue;
            }
            if (cr._computeToken !== comp.token) {
                this.computeService.recordStale();
                continue;
            }
            if (comp.goal && (cr._repathGoalX !== comp.goal.x || cr._repathGoalY !== comp.goal.y)) {
                this.computeService.recordStale();
                continue;
            }

            if (comp.status === 'found' && Array.isArray(comp.path) && comp.path.length > 0) {
                cr.path = comp.path.slice(1);
                cr._repathFailBackoffUntil = null;
            } else {
                if (Number.isFinite(failBackoff) && failBackoff > 0) {
                    cr._repathFailBackoffUntil = now + failBackoff;
                }
            }
        }
    }

    step(tickIndex) {
        this._tickIndex = tickIndex | 0;
        this.pathBudget.begin(this._tickIndex);
        this._batchingOutbound = true;
        this.invalidateAoiFrame();
        try {
            this.drainComputeCompletions(tickIndex);
            for (const session of this.players.values()) {
                if (session.dead) continue;
                session.movedThisTick = false;
                const queue = session.intentQueue;
                const len = queue.length;
                if (len > 0) {
                    for (let i = 0; i < len; i++) {
                        if (session.dead) break;
                        this.applyIntent(session, queue[i], tickIndex);
                    }
                    queue.length = 0;
                }
            }
            for (const session of this.players.values()) {
                if (session.dead || session.downed) continue;
                this.consumeWalkQueue(session, tickIndex);
            }
            for (const session of this.players.values()) {
                if (session.dead || session.downed) continue;
                this.tickPlayerCombat(session, tickIndex);
                this.tickTalkRange(session);
            }
            this.ensureAoiFrame(tickIndex);
            this.tickSpawnPins(tickIndex);
            this.updateCreatureSleepStates(tickIndex);
            for (const cr of this.activeCreatures) {
                this.tickCreature(cr, tickIndex);
            }
            this.tickNpcIdle(tickIndex);
            this.tickWorldPins(tickIndex);
            this.tickCombatStatus(tickIndex);
            this.tickCorpses(tickIndex);
            this.tickRespawns(tickIndex);
            for (const session of this.players.values()) {
                if (session.dead || !session.downed) continue;
                if (tickIndex >= session.respawnTick) {
                    this.respawnPlayer(session, tickIndex);
                }
            }
            if (this.tileMap && typeof this.tileMap.sweepIdleFloors === 'function' && (tickIndex % this.floorSweepIntervalTicks === 0)) {
                this.tileMap.sweepIdleFloors(this.now(), this.floorIdleTimeoutSec);
            }
        } finally {
            this.flushOutbound();
            this._batchingOutbound = false;
        }
    }

    applyIntent(session, intent, tickIndex) {
        switch (intent.opcode) {
            case C2S.PING: {
                const clientMs = decodePing(intent.payload);
                if (clientMs == null) {
                    session.malformed();
                    return;
                }
                session.send(S2C.PONG, encodePong(clientMs, session.now(), tickIndex >>> 0));
                return;
            }
            case C2S.LOGOUT:
                session.kick(REASON.LOGOUT);
                return;
            case C2S.MOVE_STEP:
                this.applyMoveStep(session, intent, tickIndex);
                return;
            case C2S.MOVE_PATH:
                this.applyMovePath(session, intent, tickIndex);
                return;
            case C2S.USE_STAIR:
                this.applyUseStair(session, intent, tickIndex);
                return;
            case C2S.USE:
                this.applyUse(session, intent, tickIndex);
                return;
            case C2S.USE_ITEM_WITH:
                this.applyUseItemWith(session, intent, tickIndex);
                return;
            case C2S.SET_TARGET:
                this.applySetTarget(session, intent);
                return;
            case C2S.OPEN_CORPSE:
                this.applyOpenCorpse(session, intent);
                return;
            case C2S.LOOT_TAKE:
                this.applyLootTake(session, intent);
                return;
            case C2S.LOOT_CLOSE:
                this.applyLootClose(session, intent);
                return;
            case C2S.TALK:
                this.applyTalk(session, intent);
                return;
            case C2S.TALK_REPLY:
                this.applyTalkReply(session, intent);
                return;
            case C2S.TALK_CLOSE:
                this.applyTalkClose(session, intent);
                return;
            case C2S.SHOP_BUY:
                this.applyShopDeal(session, intent, 'buy');
                return;
            case C2S.SHOP_SELL:
                this.applyShopDeal(session, intent, 'sell');
                return;
            case C2S.EQUIP:
                this.applyEquip(session, intent);
                return;
            case C2S.UNEQUIP:
                this.applyUnequip(session, intent);
                return;
            case C2S.MOVE_ITEM:
                this.applyMoveItem(session, intent);
                return;
            case C2S.USE_ITEM:
                this.applyUseItem(session, intent);
                return;
            case C2S.OPEN_BAG:
                this.applyOpenBag(session, intent);
                return;
            case C2S.CAST:
                this.applyCastIntent(session, intent, tickIndex);
                return;
            default:
                session.reject(intent.seq, REASON.UNKNOWN_OPCODE);
        }
    }

    clearPlayerWalk(session) {
        if (!session) return;
        session.path = [];
        session.walkSeq = 0;
    }

    applyMoveStep(session, intent, tickIndex) {
        const dir = decodeMoveStep(intent.payload);
        if (dir == null) {
            session.malformed();
            return;
        }
        this.clearPlayerWalk(session);
        const delta = DIR_DELTA[dir];
        if (!delta) {
            session.reject(intent.seq, REASON.BLOCKED);
            return;
        }
        if (tickIndex < session.moveReadyTick) {
            session.reject(intent.seq, REASON.BUSY);
            return;
        }
        if (!this.tryPlayerWalkDir(session, dir, tickIndex)) {
            session.reject(intent.seq, REASON.BLOCKED);
        }
    }

    applyMovePath(session, intent, _tickIndex) {
        const dirs = decodeMovePath(intent.payload);
        if (dirs == null) {
            session.malformed();
            return;
        }
        const cap = Math.max(0, (this.settings.movePathMaxSteps | 0) || 165);
        if (dirs.length > cap) {
            session.reject(intent.seq, REASON.BLOCKED);
            this.clearPlayerWalk(session);
            return;
        }
        session.path = dirs.slice();
        session.walkSeq = dirs.length ? (intent.seq | 0) : 0;
    }

    consumeWalkQueue(session, tickIndex) {
        if (!session || session.dead || session.downed) return;
        if (!Array.isArray(session.path) || session.path.length === 0) return;
        if (session.movedThisTick) return;
        if (tickIndex < session.moveReadyTick) return;
        const dir = session.path[0];
        const fromZ = session.z | 0;
        if (!this.tryPlayerWalkDir(session, dir, tickIndex)) {
            const seq = session.walkSeq | 0;
            this.clearPlayerWalk(session);
            if (seq) session.reject(seq, REASON.BLOCKED);
            return;
        }
        session.path.shift();
        if ((session.z | 0) !== fromZ) {
            this.clearPlayerWalk(session);
            return;
        }
        if (session.path.length === 0) session.walkSeq = 0;
    }

    tryPlayerWalkDir(session, dir, tickIndex) {
        const delta = DIR_DELTA[dir];
        if (!delta) return false;
        if (tickIndex < session.moveReadyTick) return false;
        const nx = session.x + delta.dx;
        const ny = session.y + delta.dy;
        const nz = session.z;
        if (!this.tileMap.canEnter(nx, ny, nz, session)) return false;
        const from = { x: session.x, y: session.y, z: session.z };
        if (!this.tileMap.moveEntityToTile(nx, ny, nz, session)) return false;
        session.dir = dir;
        session.moveReadyTick = tickIndex + this.stepDelay(
            session,
            this.tileMap.frictionAt(session.x, session.y, session.z),
            false
        );
        session.movedThisTick = true;
        this.broadcastMove(session, from, dir);
        this.applyWorldPinStep(session, from, tickIndex);
        return true;
    }

    applyUseStair(session, intent, tickIndex) {
        const ok = decodeUseStair(intent.payload);
        if (ok == null) {
            session.malformed();
            return;
        }
        this.clearPlayerWalk(session);
        if (tickIndex < session.moveReadyTick) {
            session.reject(intent.seq, REASON.BUSY);
            return;
        }
        if (!this.tileMap.getStair(session.x, session.y, session.z)) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        const from = { x: session.x, y: session.y, z: session.z };
        if (!this.tileMap.tryUseStair(session)) {
            session.reject(intent.seq, REASON.BLOCKED);
            return;
        }
        session.moveReadyTick = tickIndex + this.stepDelay(
            session,
            this.tileMap.frictionAt(session.x, session.y, session.z),
            false
        );
        session.movedThisTick = true;
        this.broadcastMove(session, from, session.dir);
        this.applyWorldPinStep(session, from, tickIndex);
    }

    applyUse(session, intent, tickIndex) {
        const tile = decodeUseTile(intent.payload);
        if (!tile) {
            session.malformed();
            return;
        }
        const inst = this.worldPinAt(tile.x, tile.y, tile.z);
        if (!inst) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        if (!pinInUseRange(session, inst, USE_RANGE)) {
            session.reject(intent.seq, REASON.OUT_OF_RANGE);
            return;
        }
        if (inst.kind === 'container') {
            session.openCorpseId = inst.id;
            session.send(S2C.CONTAINER, encodeContainer(inst));
            return;
        }
        if (inst.kind === 'teleport' && tickIndex < session.moveReadyTick) {
            session.reject(intent.seq, REASON.BUSY);
            return;
        }
        const from = { x: session.x, y: session.y, z: session.z };
        const result = useWorldPin(session, inst, this.worldPinUseCtx(tickIndex));
        this.finishWorldPinUse(session, intent, inst, from, result, tickIndex);
    }

    applyUseItemWith(session, intent, tickIndex) {
        const cmd = decodeUseItemWith(intent.payload);
        if (!cmd) {
            session.malformed();
            return;
        }
        if (tickIndex < session.moveReadyTick) {
            session.reject(intent.seq, REASON.BUSY);
            return;
        }
        const runeSpell = findSpellByRuneItem(this.spellBook, cmd.itemId);
        if (runeSpell) {
            this.runCast(session, runeSpell, {
                target: this.getEntity(session.targetId),
                aim: { x: cmd.x, y: cmd.y, z: cmd.z },
                tickIndex
            });
            return;
        }
        const inst = this.worldPinAt(cmd.x, cmd.y, cmd.z);
        const from = { x: session.x, y: session.y, z: session.z };
        const result = useWorldToolWith(session, cmd, {
            tileMap: this.tileMap,
            inst
        });
        if (!result.ok) {
            if (result.reason === 'too_far') {
                session.reject(intent.seq, REASON.OUT_OF_RANGE);
                return;
            }
            this.say(session, result.text);
            return;
        }
        session.moveReadyTick = tickIndex + this.stepDelay(
            session,
            this.tileMap.frictionAt(session.x, session.y, session.z),
            false
        );
        session.movedThisTick = true;
        this.broadcastMove(session, from, session.dir);
        this.applyWorldPinStep(session, from, tickIndex);
        if (inst) this.broadcastWorldPin(inst);
    }

    worldPinUseCtx(tickIndex) {
        return {
            tileMap: this.tileMap,
            instances: this.worldPins,
            bag: this.worldPinLever,
            now: this.logicNow(tickIndex),
            itemDb: this.itemDb(),
            spawn: (rows) => this.addLeverSpawns(rows)
        };
    }

    finishWorldPinUse(session, intent, inst, from, result, tickIndex) {
        if (!result.ok) {
            if (result.text) this.say(session, result.text);
            return;
        }
        if (result.given && result.given.length) {
            for (let i = 0; i < result.given.length; i++) {
                session.send(S2C.ITEM_GAIN, encodeItemGain(result.given[i].id, result.given[i].count));
            }
            this.sendInventory(session);
        }
        if (result.to) {
            session.moveReadyTick = tickIndex + this.stepDelay(
                session,
                this.tileMap.frictionAt(session.x, session.y, session.z),
                false
            );
            session.movedThisTick = true;
            this.broadcastMove(session, from, session.dir);
            this.applyWorldPinStep(session, from, tickIndex);
        }
        if (result.changed || result.transformed || result.state != null) {
            this.broadcastWorldPin(inst);
            this.sendViewportToViewers(inst.x, inst.y, inst.z);
        }
        if (result.open != null || result.changed) {
            this.sendViewportToViewers(inst.x, inst.y, inst.z);
            this.broadcastWorldPin(inst);
        }
        this.scheduleWorldPinDeadline(inst, this.logicNow(tickIndex));
    }

    applyWorldPinStep(entity, from, tickIndex) {
        const now = this.logicNow(tickIndex);
        const to = { x: entity.x, y: entity.y, z: entity.z };
        const fired = onWorldPinStep(
            entity,
            from,
            to,
            this.worldPins,
            now
        );
        for (let i = 0; i < fired.length; i++) {
            const row = fired[i];
            if (row.result.field) {
                const kind = getFieldKind(row.result.field);
                if (kind) {
                    const source = entity.type === 'player' ? 'player' : 'creature';
                    const deployed = deployFieldAndTriggerOccupants(
                        this.fieldStore,
                        to.x,
                        to.y,
                        to.z,
                        { kind, source, createdAt: now, createdTick: tickIndex },
                        this.tileMap.getCombatantEntities(to.x, to.y, to.z),
                        now
                    );
                    if (deployed.field) this.broadcastField(deployed.field);
                    for (let h = 0; h < deployed.hits.length; h++) {
                        this.applyFieldHit(deployed.hits[h].entity, deployed.hits[h].result, tickIndex);
                    }
                }
            }
            if (row.result.damage > 0) {
                this.applyDamage(entity, row.result.damage, 'physical', tickIndex, null);
            }
            this.broadcastWorldPin(row.inst);
            this.scheduleWorldPinDeadline(row.inst, now);
        }
        const fieldEvents = onEntityTileTransition(entity, from, to, this.fieldStore, now);
        for (let i = 0; i < fieldEvents.length; i++) {
            const ev = fieldEvents[i];
            if (ev && ev.result && ev.result.damage > 0) {
                this.applyDamage(entity, ev.result.damage, ev.result.element || 'physical', tickIndex, null);
            }
        }
    }

    tickWorldPins(tickIndex) {
        const now = this.logicNow(tickIndex);
        const out = tickWorldPinDeadlineQueue(
            this.worldPinDeadlines,
            (id) => this.worldPinByNumeric.get(id) || this.worldPinById.get(id) || null,
            now,
            this.tileMap
        );
        const decayed = out.decayed || [];
        for (let i = 0; i < decayed.length; i++) {
            const row = decayed[i];
            if (row.removed) {
                this.forgetWorldPin(row.inst);
            } else {
                this.broadcastWorldPin(row.inst);
                this.scheduleWorldPinDeadline(row.inst, now);
            }
        }
    }

    forgetWorldPin(inst) {
        if (!inst) return;
        this.worldPinById.delete(inst.pinId);
        this.worldPinByNumeric.delete(inst.id);
        const key = worldPinTileKey(inst.x, inst.y, inst.z);
        if (this.worldPinsByTile.get(key) === inst) this.worldPinsByTile.delete(key);
        if (this.worldPinSpatial) this.worldPinSpatial.remove(inst.id);
        const gone = encodeWorldPinGone(inst.id);
        this.broadcastToViewers(inst.x, inst.y, inst.z, (p) => {
            p.send(S2C.WORLD_PIN_GONE, gone);
        });
        this.sendViewportToViewers(inst.x, inst.y, inst.z);
        for (const p of this.players.values()) {
            if (p.openCorpseId === inst.id) p.openCorpseId = 0;
        }
    }

    broadcastWorldPin(inst) {
        if (!inst || inst.removed) return;
        const buf = encodeWorldPin(inst);
        this.broadcastToViewers(inst.x, inst.y, inst.z, (p) => {
            p.send(S2C.WORLD_PIN, buf);
        });
    }

    sendViewportToViewers(x, y, z) {
        const candidates = this.viewerCandidates(x, y, z, 16);
        for (const p of candidates) {
            if (!p || p.dead || p.downed) continue;
            if (this.sees(p, x, y, z)) {
                p.send(S2C.VIEWPORT, encodeViewport(this.viewportOf(p)));
            }
        }
    }

    applySetTarget(session, intent) {
        const id = decodeSetTarget(intent.payload);
        if (id == null) {
            session.malformed();
            return;
        }
        if (id === 0) {
            session.targetId = 0;
            return;
        }
        if (id === session.id) {
            session.reject(intent.seq, REASON.BLOCKED);
            return;
        }
        const target = this.getEntity(id);
        if (!target || target.downed) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        if (target.type === 'player' && !this.pvpOn()) {
            session.reject(intent.seq, REASON.BLOCKED);
            return;
        }
        if (isNpcEntity(target) && !target.attackableNpc) {
            session.reject(intent.seq, REASON.BLOCKED);
            return;
        }
        session.targetId = id;
    }

    containerById(id) {
        const corpse = this.corpses.get(id);
        if (corpse) return corpse;
        const pin = this.worldPinByNumeric.get(id);
        if (pin && !pin.removed && pin.kind === 'container') return pin;
        return null;
    }

    applyOpenCorpse(session, intent) {
        const id = decodeOpenCorpse(intent.payload);
        if (id == null) {
            session.malformed();
            return;
        }
        const corpse = this.corpses.get(id);
        if (!corpse) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        if ((corpse.z | 0) !== (session.z | 0)
            || chebyshev(session.x, session.y, corpse.x, corpse.y) > 1) {
            session.reject(intent.seq, REASON.OUT_OF_RANGE);
            return;
        }
        session.openCorpseId = id;
        session.send(S2C.CONTAINER, encodeContainer(corpse));
    }

    applyLootTake(session, intent) {
        const body = decodeLootTake(intent.payload);
        if (!body) {
            session.malformed();
            return;
        }
        const container = this.containerById(body.corpseId);
        if (!container) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        if (session.openCorpseId !== container.id) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        if ((container.z | 0) !== (session.z | 0)
            || chebyshev(session.x, session.y, container.x, container.y) > 1) {
            session.reject(intent.seq, REASON.OUT_OF_RANGE);
            return;
        }
        const item = container.items[body.slot];
        if (!item) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        if (!this.tryGiveItem(session, item.id, item.count)) {
            this.say(session, 'You cannot carry that.');
            return;
        }
        container.items.splice(body.slot, 1);
        session.send(S2C.ITEM_GAIN, encodeItemGain(item.id, item.count));
        this.sendInventory(session);
        session.send(S2C.CONTAINER, encodeContainer(container));
    }

    applyLootClose(session, intent) {
        const id = decodeLootClose(intent.payload);
        if (id == null) {
            session.malformed();
            return;
        }
        if (session.openCorpseId === id) session.openCorpseId = 0;
    }

    playerCanAttackTarget(attacker, target) {
        if (!attacker || !target) return false;
        if ((attacker.z | 0) !== (target.z | 0)) return false;
        const isMagic = attacker.weaponType === 'magic';
        const isDistance = attacker.weaponType === 'distance';
        if (isMagic || isDistance) {
            const defaultRange = isMagic ? 4 : 6;
            const range = attacker.weaponRange != null ? attacker.weaponRange : defaultRange;
            const dist = chebyshev(attacker.x, attacker.y, target.x, target.y);
            if (dist > range) return false;
            return hasLineOfSight(attacker.x, attacker.y, attacker.z, target.x, target.y, target.z, this.tileMap || this.map);
        }
        return meleeRangeOk(attacker, target);
    }

    tickPlayerCombat(session, tickIndex) {
        const target = this.getEntity(session.targetId);
        if (!target || target.downed) {
            if (session.targetId) {
                session.targetId = 0;
            }
            return;
        }
        if (this.playerCanAttackTarget(session, target)) {
            this.trySwing(session, target, tickIndex);
        }
    }

    creatureIsStickyAwake(cr, playerTargets) {
        if (!cr || (cr.hp | 0) <= 0 || isNpcEntity(cr)) return false;
        if (cr.targetId) return true;
        if (cr.leashing) return true;
        if (playerTargets && playerTargets.has(cr.id)) return true;
        if (cr.conditions && cr.conditions.length > 0) return true;
        return false;
    }

    updateCreatureSleepStates(tickIndex) {
        const sleepEnabled = !this.settings || this.settings.aiCreatureSleep !== false;
        const radius = (this.settings && this.settings.aiTickRadius != null)
            ? (this.settings.aiTickRadius | 0)
            : 12;

        if (!sleepEnabled || radius <= 0) {
            for (const cr of this.creatures.values()) {
                if (isNpcEntity(cr)) continue;
                this.wakeCreature(cr, tickIndex);
            }
            return;
        }

        const frame = this.ensureAoiFrame(tickIndex);
        const playerTargets = frame.playerTargets;

        // Observer-centric gather from the shared AOI frame, then sleep/wake
        // deltas only against the previous-awake set — never this.creatures.values().
        const wantAwake = new Set();
        for (const cr of frame.nearbyCreatures) {
            if (cr && (cr.hp | 0) > 0 && !isNpcEntity(cr)) wantAwake.add(cr);
        }

        for (const targetId of playerTargets) {
            const cr = this.creatures.get(targetId);
            if (cr && (cr.hp | 0) > 0 && !isNpcEntity(cr)) wantAwake.add(cr);
        }

        const prevAwake = [];
        for (const cr of this.activeCreatures) {
            prevAwake.push(cr);
            if (this.creatureIsStickyAwake(cr, playerTargets)) wantAwake.add(cr);
        }

        for (let i = 0; i < prevAwake.length; i++) {
            const cr = prevAwake[i];
            if ((cr.hp | 0) <= 0) {
                if (cr.simSleeping) cr.simSleeping = false;
                this.activeCreatures.delete(cr);
                continue;
            }
            if (!wantAwake.has(cr)) this.sleepCreature(cr);
        }
        for (const cr of wantAwake) {
            if (cr.simSleeping || !this.activeCreatures.has(cr)) {
                this.wakeCreature(cr, tickIndex);
            }
        }
    }

    wakeCreature(cr, tickIndex) {
        if (!cr || (cr.hp | 0) <= 0 || isNpcEntity(cr)) return;
        if (cr.simSleeping) {
            cr.simSleeping = false;
            seedPathPhase(
                cr,
                (this.settings && this.settings.aiRepathIntervalSec) || 2.0,
                this.logicNow(tickIndex != null ? tickIndex : this._tickIndex)
            );
        }
        this.activeCreatures.add(cr);
    }

    sleepCreature(cr) {
        if (!cr || isNpcEntity(cr)) return;
        cr.simSleeping = true;
        this.activeCreatures.delete(cr);
    }

    tickCreature(cr, tickIndex) {
        if (isNpcEntity(cr)) return;
        if ((cr.hp | 0) <= 0) return;
        if (cr.simSleeping) return;
        const now = this.logicNow(tickIndex);
        applyThreatDecay(cr, now, this.settings);
        let target = this.getEntity(cr.targetId);
        if (target && (target.downed || target.type !== 'player')) target = null;
        if (target) {
            const dist = chebyshev(cr.x, cr.y, target.x, target.y);
            const sameZ = (cr.z | 0) === (target.z | 0);
            if (!sameZ || dist > creatureLoseTargetDistance(cr) || this.isProtectedCombatant(target)) {
                target = null;
                cr.path = [];
            }
        }
        const thinkSec = this.settings.aiCreatureThinkIntervalSec;
        const thinkDue = isLogicIntervalDue(
            cr, '_creatureThinkNextAt', thinkSec, now
        );
        if (!target && (cr.aggro || isSummon(cr)) && thinkDue) {
            target = this.pickCreatureTarget(cr, now);
            if (target) armStrategyRetarget(cr, now, this.settings);
        } else if (target && strategyRetargetDue(cr, now, this.rng, this.settings)) {
            const next = this.pickCreatureTarget(cr, now);
            if (next) target = next;
        }
        if (cr.targetId && target && cr.targetId !== target.id) {
            cr.path = [];
        }
        if (!target) clearStrategyRetarget(cr);
        cr.targetId = target ? target.id : 0;

        if (target) {
            cr.leashing = false;
            this.tickCreatureAi(cr, target, tickIndex);
            return;
        }

        const atHome = this.creatureAtHome(cr);
        const playerNear = this.hasCreatureIdlePresence(cr);
        const forceWander = !!(cr.flags && cr.flags.idleWander);

        if (cr.leashing || (!atHome && !playerNear)) {
            if (!atHome) cr.leashing = true;
            this.tickCreatureLeash(cr, tickIndex);
            return;
        }

        cr.leashing = false;
        if (playerNear || forceWander) {
            this.tryIdleWander(cr, tickIndex);
        }
    }

    creatureAtHome(cr) {
        if (!cr) return true;
        return (cr.x | 0) === (cr.spawnX | 0)
            && (cr.y | 0) === (cr.spawnY | 0)
            && (cr.z | 0) === (cr.spawnZ | 0);
    }

    hasCreatureIdlePresence(cr) {
        if (!cr) return false;
        const aggro = cr.aggroRange == null ? 7 : cr.aggroRange | 0;
        const sleepOn = !this.settings || this.settings.aiCreatureSleep !== false;
        const aoi = (this.settings && this.settings.aiTickRadius != null)
            ? (this.settings.aiTickRadius | 0)
            : 12;
        const range = sleepOn && aoi > 0 ? Math.max(aggro, aoi) : Math.max(0, aggro);
        if (range <= 0) return false;
        return !!this.nearestPlayer(cr, range);
    }

    restoreCreatureAtHome(cr) {
        if (!cr) return;
        const max = cr.hpMax | 0;
        const prev = cr.hp | 0;
        if (max > 0) this.applyHp(cr, max);
        cr.leashing = false;
        cr.path = [];
        if ((cr.hp | 0) !== prev) this.broadcastStats(cr);
    }

    tickCreatureLeash(cr, tickIndex) {
        if (!cr) return;
        if (this.creatureAtHome(cr)) {
            this.restoreCreatureAtHome(cr);
            return;
        }
        if (!(cr.speed > 0)) {
            cr.leashing = false;
            return;
        }
        this.tryStepToward(cr, cr.spawnX, cr.spawnY, tickIndex, {
            maxDistance: (this.settings.pathMaxDistance | 0) || 100
        });
        if (this.creatureAtHome(cr)) this.restoreCreatureAtHome(cr);
    }

    tryIdleWander(cr, tickIndex) {
        if (!cr || !(cr.speed > 0)) return false;
        if (tickIndex < cr.moveReadyTick) return false;
        const from = { x: cr.x | 0, y: cr.y | 0, z: cr.z | 0 };
        const opts = [];
        for (let i = 0; i < DIR_DELTA.length; i++) {
            const d = DIR_DELTA[i];
            const nx = from.x + d.dx;
            const ny = from.y + d.dy;
            if (this.tileMap.canEnter(nx, ny, from.z, cr)) opts.push(i);
        }
        if (!opts.length) return false;
        const r = this.rng();
        let pick = Math.floor(r * opts.length);
        if (pick < 0) pick = 0;
        if (pick >= opts.length) pick = opts.length - 1;
        const dir = opts[pick];
        const d = DIR_DELTA[dir];
        const nx = from.x + d.dx;
        const ny = from.y + d.dy;
        if (!this.tileMap.moveEntityToTile(nx, ny, from.z, cr)) return false;
        cr.path = [];
        cr.dir = dir;
        cr.moveReadyTick = tickIndex + this.stepDelay(
            cr,
            this.tileMap.frictionAt(cr.x, cr.y, cr.z),
            false
        );
        this.broadcastMove(cr, from, dir);
        this.applyWorldPinStep(cr, from, tickIndex);
        return true;
    }

    npcSpectatorRange() {
        return SPECTATOR_RANGE;
    }

    tickNpcIdle(tickIndex) {
        if (!this.players.size) return;
        const range = this.npcSpectatorRange();
        const players = [];
        for (const p of this.players.values()) {
            if (p.dead || p.downed) continue;
            players.push(p);
        }
        if (!players.length) return;

        const seen = new Set();
        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            const candidates = this.creatureSpatial
                ? this.creatureSpatial.queryChunkCandidates(p.x, p.y, p.z, range)
                : this.creatures.values();
            for (const cr of candidates) {
                if (!cr || seen.has(cr.id)) continue;
                if (!isNpcEntity(cr)) continue;
                if ((cr.hp | 0) <= 0) continue;
                if ((cr.z | 0) !== (p.z | 0)) continue;
                if (chebyshev(cr.x | 0, cr.y | 0, p.x | 0, p.y | 0) > range) continue;
                seen.add(cr.id);
                if (!hasNpcIdle(cr)) continue;
                this.tickNpcVoices(cr, players, range);
                this.tickNpcWander(cr, tickIndex, players, range);
            }
        }
    }

    tickNpcWander(npc, tickIndex, players, range) {
        if (!npc || !(npc.walkInterval > 0)) return false;
        if (!(npc.speed > 0)) return false;
        if (npc.aggro === true) return false;
        if (npcIsInConversation(npc, players)) {
            npc._npcWalkTicks = 0;
            return false;
        }
        if (!hasNearbySpectator(npc, players, range)) return false;

        const intervalTicks = intervalMsToTicks(
            npc.walkInterval,
            (this.settings && this.settings.logicUps) || 20
        );
        if (!(intervalTicks > 0)) return false;
        npc._npcWalkTicks = (npc._npcWalkTicks | 0) + 1;
        if (npc._npcWalkTicks < intervalTicks) return false;
        npc._npcWalkTicks = 0;

        if (tickIndex < (npc.moveReadyTick | 0)) return false;
        const from = { x: npc.x | 0, y: npc.y | 0, z: npc.z | 0 };
        const dirs = shuffledCardinals(this.rng);
        for (let i = 0; i < dirs.length; i++) {
            const dir = dirs[i];
            if (!canNpcWalkTo(npc, dir, this.tileMap)) continue;
            const nx = from.x + (dir.dx | 0);
            const ny = from.y + (dir.dy | 0);
            if (this.fieldStore && getFieldOnTile(this.fieldStore, nx, ny, from.z)) continue;
            if (!this.tileMap.moveEntityToTile(nx, ny, from.z, npc)) continue;
            const face = dirFromDelta((npc.x | 0) - from.x, (npc.y | 0) - from.y);
            npc.dir = face;
            npc.path = [];
            npc.moveReadyTick = tickIndex + this.stepDelay(
                npc,
                this.tileMap.frictionAt(npc.x, npc.y, npc.z),
                false
            );
            this.broadcastMove(npc, from, face);
            this.applyWorldPinStep(npc, from, tickIndex);
            return true;
        }
        return false;
    }

    tickNpcVoices(npc, players, range) {
        if (!npc || !(npc.voiceInterval > 0)) return false;
        const voices = Array.isArray(npc.voices) ? npc.voices : [];
        if (!voices.length) return false;
        if (!hasNearbySpectator(npc, players, range)) return false;

        const intervalTicks = intervalMsToTicks(
            npc.voiceInterval,
            (this.settings && this.settings.logicUps) || 20
        );
        if (!(intervalTicks > 0)) return false;
        npc._npcVoiceTicks = (npc._npcVoiceTicks | 0) + 1;
        if (npc._npcVoiceTicks < intervalTicks) return false;
        npc._npcVoiceTicks = 0;

        const chance = npc.voiceChance | 0;
        if (chance <= 0) return false;
        const rng = this.rng || Math.random;
        const roll = Math.floor(rng() * 100) + 1;
        if (roll > chance) return false;

        const pick = voices[Math.floor(rng() * voices.length)] || voices[0];
        if (!pick || !pick.text) return false;
        const payload = encodeSay(pick.text, {
            speakerId: npc.id,
            yell: !!pick.yell
        });
        this.broadcastToViewers(npc.x, npc.y, npc.z, (p) => {
            p.send(S2C.SAY, payload);
        });
        return true;
    }

    tickCreatureAi(cr, targetOrTick, tickIndex) {
        let target;
        let tick;
        if (typeof targetOrTick === 'number') {
            tick = targetOrTick;
            target = this.getEntity(cr.targetId);
        } else {
            target = targetOrTick;
            tick = tickIndex != null ? tickIndex : this._tickIndex;
        }
        if (!cr || !target || target.downed || target.dead) return;
        if ((cr.z | 0) !== (target.z | 0)) return;

        // 1. Attack evaluation: evaluate creature kit attacks (both ranged and melee)
        this.tryCreatureAttacks(cr, target, tick);

        // If target died or was downed from the attack, no movement needed
        if (target.dead || target.downed || (target.hp | 0) <= 0) {
            return;
        }

        // 2. Stand-off distance and movement (runHealth raises want while fleeing)
        const want = creatureStandDistance(cr);
        const dist = chebyshev(cr.x, cr.y, target.x, target.y);
        const hasLos = hasLineOfSight(cr.x, cr.y, cr.z, target.x, target.y, target.z, this.tileMap || this.map);

        if (dist > want || !hasLos) {
            if (!this.tryStepToward(cr, target.x, target.y, tick)) {
                this.tryIdleWander(cr, tick);
            }
        } else if (dist < want) {
            cr.path = [];
            this.tryStepAwayFrom(cr, target.x, target.y, tick);
        } else {
            // At ideal stand-off distance with line of sight: hold position
            cr.path = [];
        }
    }

    isProtectedCombatant(entity) {
        if (!entity || !this.tileMap || typeof this.tileMap.attackMayAffectTile !== 'function') {
            return false;
        }
        return !this.tileMap.attackMayAffectTile(entity.x | 0, entity.y | 0, entity.z | 0);
    }

    harmfulCombatAllowed(attacker, defender) {
        const tm = this.tileMap;
        if (!tm || typeof tm.attackMayAffectTile !== 'function') return true;
        if (attacker && !tm.attackMayAffectTile(attacker.x | 0, attacker.y | 0, attacker.z | 0)) {
            return false;
        }
        if (defender && !tm.attackMayAffectTile(defender.x | 0, defender.y | 0, defender.z | 0)) {
            return false;
        }
        return true;
    }

    playersInRange(from, range, opts) {
        const r = Math.max(0, Number(range) || 0);
        const attackable = !!(opts && opts.attackable);
        const out = [];
        const frame = this._aoiFrame;
        const candidates = (frame && frame.observers)
            ? frame.observers
            : (this.playerSpatial
                ? this.playerSpatial.queryChunkCandidates(from.x, from.y, from.z, r)
                : this.players.values());
        for (const p of candidates) {
            if (!p || p.downed || p.dead) continue;
            if ((p.z | 0) !== (from.z | 0)) continue;
            if (attackable && this.isProtectedCombatant(p)) continue;
            const d = chebyshev(from.x, from.y, p.x, p.y);
            if (d <= r) out.push(p);
        }
        return out;
    }

    pickCreatureTarget(cr, now) {
        if (!cr) return null;
        const range = cr.aggroRange == null ? 7 : cr.aggroRange | 0;
        const list = this.playersInRange(cr, range, { attackable: true });
        return pickCreatureTargetFromKit(cr, list, this.rng, {
            now,
            settings: this.settings
        });
    }

    nearestPlayer(from, range, opts) {
        const r = Math.max(0, Number(range) || 0);
        const list = this.playersInRange(from, range, opts);
        let best = null;
        let bestD = r + 1;
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            const d = chebyshev(from.x, from.y, p.x, p.y);
            if (d < bestD) {
                best = p;
                bestD = d;
            }
        }
        return best;
    }

    noteCreatureThreat(attacker, defender, amount, tickIndex) {
        if (!defender || defender.type !== 'creature') return;
        if (!attacker || attacker.type !== 'player') return;
        if (!(amount > 0)) return;
        recordDamageTakenBy(
            defender,
            attacker,
            amount,
            this.logicNow(tickIndex),
            this.settings
        );
    }

    pickEngageTile(entity, tx, ty, tz) {
        if (!entity || !this.tileMap) return null;
        const z = tz != null ? tz | 0 : entity.z | 0;
        const gx = tx | 0;
        const gy = ty | 0;
        let best = null;
        let bestD = Infinity;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = gx + dx;
                const ny = gy + dy;
                if (!this.tileMap.canEnter(nx, ny, z, entity)) continue;
                const d = chebyshev(entity.x | 0, entity.y | 0, nx, ny);
                if (d < bestD) {
                    bestD = d;
                    best = { x: nx, y: ny, z };
                }
            }
        }
        return best;
    }

    computePriorityFor(entity) {
        if (!entity) return 'background';
        if (entity.type === 'player') return 'visible';
        if (entity.targetId && entity.targetId > 0) return 'visible';
        if (!entity.simSleeping) return 'visible';
        return 'background';
    }

    tryStepToward(entity, tx, ty, tickIndex, opts) {
        if (tickIndex < entity.moveReadyTick) return false;
        const from = { x: entity.x | 0, y: entity.y | 0, z: entity.z | 0 };
        if ((from.z | 0) !== (entity.z | 0)) {
            entity.path = [];
            return false;
        }
        let gx = tx | 0;
        let gy = ty | 0;
        const gz = entity.z | 0;
        if (
            this.tileMap
            && typeof this.tileMap.creatureMayEnterTile === 'function'
            && !this.tileMap.creatureMayEnterTile(gx, gy, gz, entity)
        ) {
            const dest = this.pickEngageTile(entity, gx, gy, gz);
            if (dest) {
                gx = dest.x;
                gy = dest.y;
            }
        }
        const cap = this.pathCap(entity, opts);
        const priority = this.computePriorityFor(entity);
        this.tileMap.followPath(
            entity,
            gx,
            gy,
            gz,
            cap,
            0,
            {
                logicNow: this.logicNow(tickIndex),
                budget: this.pathBudget,
                computeService: this.computeService,
                priority
            }
        );
        if ((entity.x | 0) === from.x && (entity.y | 0) === from.y) {
            return false;
        }
        const dir = dirFromDelta((entity.x | 0) - from.x, (entity.y | 0) - from.y);
        entity.dir = dir;
        entity.moveReadyTick = tickIndex + this.stepDelay(
            entity,
            this.tileMap.frictionAt(entity.x, entity.y, entity.z),
            isDiagonalStep(from.x, from.y, entity.x, entity.y)
        );
        if (entity.type === 'player') {
            entity.movedThisTick = true;
        }
        this.broadcastMove(entity, from, dir);
        this.applyWorldPinStep(entity, from, tickIndex);
        return true;
    }

    tryStepAwayFrom(entity, tx, ty, tickIndex) {
        if (tickIndex < entity.moveReadyTick) return false;
        const from = { x: entity.x | 0, y: entity.y | 0, z: entity.z | 0 };
        if ((from.z | 0) !== (entity.z | 0)) {
            entity.path = [];
            return false;
        }
        const curDist = chebyshev(from.x, from.y, tx, ty);
        const candidates = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const nx = from.x + dx;
                const ny = from.y + dy;
                const ndist = chebyshev(nx, ny, tx, ty);
                if (ndist > curDist && this.tileMap.canEnter(nx, ny, from.z, entity)) {
                    candidates.push({
                        x: nx,
                        y: ny,
                        dist: ndist,
                        diagonal: dx !== 0 && dy !== 0
                    });
                }
            }
        }
        if (candidates.length === 0) return false;
        candidates.sort((a, b) => (b.dist - a.dist) || ((a.diagonal ? 1 : 0) - (b.diagonal ? 1 : 0)));
        const best = candidates[0];
        if (!this.tileMap.moveEntityToTile(best.x, best.y, from.z, entity)) {
            return false;
        }
        entity.path = [];
        const dir = dirFromDelta((entity.x | 0) - from.x, (entity.y | 0) - from.y);
        entity.dir = dir;
        entity.moveReadyTick = tickIndex + this.stepDelay(
            entity,
            this.tileMap.frictionAt(entity.x, entity.y, entity.z),
            isDiagonalStep(from.x, from.y, entity.x, entity.y)
        );
        if (entity.type === 'player') {
            entity.movedThisTick = true;
        }
        this.broadcastMove(entity, from, dir);
        this.applyWorldPinStep(entity, from, tickIndex);
        return true;
    }

    creatureAttackIntervalTicks(atk) {
        const baseAuto = this.autoInterval();
        if (!atk || atk.intervalMs == null) return baseAuto;
        const ms = Number(atk.intervalMs) || 2000;
        return Math.max(1, Math.round((ms / 2000) * baseAuto));
    }

    tryDefenseSpells(cr, tickIndex) {
        const list = cr && cr.defenseSpells;
        if (!list || !Array.isArray(list) || list.length === 0) return false;
        if (!cr._defenseReadyTicks) cr._defenseReadyTicks = {};
        const rng = this.rng || Math.random;
        const hp = cr.hp | 0;
        const hpMax = cr.hpMax | 0;
        const hpFrac = hpMax > 0 ? hp / hpMax : 1;

        for (let i = 0; i < list.length; i++) {
            const spell = list[i];
            if (!spell) continue;
            const kind = String(spell.kind || '').toLowerCase();
            if (kind !== 'heal' && kind !== 'haste' && kind !== 'invisible') continue;
            const key = spell.id || String(i);
            const readyTick = cr._defenseReadyTicks[key];
            if (readyTick != null && tickIndex < readyTick) continue;

            const intervalTicks = this.creatureAttackIntervalTicks(spell);
            cr._defenseReadyTicks[key] = tickIndex + intervalTicks;

            const chance = spell.chance != null ? Number(spell.chance) : 100;
            if (chance < 100 && rng() * 100 >= chance) continue;

            if (kind === 'heal') {
                const below = spell.hpBelow != null ? Number(spell.hpBelow) : 0.7;
                if (!(hpFrac < below)) continue;
                if (!(hpMax > 0) || hp >= hpMax) continue;
                const min = Math.max(0, Number(spell.min) || 0);
                let max = Math.max(0, Number(spell.max) || min);
                if (max < min) max = min;
                const roll = max <= min
                    ? min
                    : min + Math.floor(rng() * (max - min + 1));
                if (!(roll > 0)) continue;
                this.applyHp(cr, hp + roll);
                this.broadcastStats(cr);
                return true;
            }

            if (kind === 'haste') {
                if (hasHaste(cr)) continue;
                const sc = Number(spell.speedChange) || 0;
                if (!(sc > 0)) continue;
                const durationSec = spell.durationSec != null
                    ? Math.max(0.1, Number(spell.durationSec) || 5)
                    : 5;
                applyCondition(cr, {
                    type: 'haste',
                    speedChange: sc,
                    durationSec
                }, { source: 'defense_spell' });
                this.broadcastStats(cr);
                return true;
            }

            if (kind === 'invisible') {
                if (isInvisible(cr)) continue;
                const durationSec = spell.durationSec != null
                    ? Math.max(0.1, Number(spell.durationSec) || 2)
                    : 2;
                applyCondition(cr, {
                    type: 'invisible',
                    durationSec
                }, { source: 'defense_spell' });
                this.broadcastStats(cr);
                return true;
            }
        }
        return false;
    }

    playersOnTiles(tiles) {
        const out = [];
        const tileMap = this.tileMap;
        if (!tileMap || !tiles || !tiles.length) return out;
        const seen = new Set();
        for (let i = 0; i < tiles.length; i++) {
            const t = tiles[i];
            if (!t) continue;
            const ents = typeof tileMap.getCombatantEntities === 'function'
                ? tileMap.getCombatantEntities(t.x, t.y, t.z)
                : [];
            for (let k = 0; k < ents.length; k++) {
                const e = ents[k];
                if (!e || e.type !== 'player') continue;
                if (e.downed || e.dead || (e.hp | 0) <= 0) continue;
                if (seen.has(e.id)) continue;
                seen.add(e.id);
                out.push(e);
            }
        }
        return out;
    }

    applyCreatureKitHit(attacker, defender, hit, attack, tickIndex) {
        if (!defender || !hit) return false;
        let amount = 0;
        let flags = 0;
        if (hit.miss) {
            flags |= SWING_MISS;
        } else if (hit.element === 'healing') {
            this.applyHp(defender, (defender.hp | 0) + (hit.final | 0));
            amount = hit.final | 0;
        } else {
            amount = this.applyDamage(defender, hit.final, hit.element, tickIndex, attacker);
            if (hit.critical) flags |= SWING_CRIT;
            if (hit.fatal) flags |= SWING_FATAL;
            if ((defender.hp | 0) <= 0) flags |= SWING_DEATH;
        }
        if (attack && attack.condition && !hit.miss && isCombatantAlive(defender)) {
            applyCondition(defender, attack.condition, {
                source: attacker.kind || attacker.name || null
            });
        }
        this.applyAttackProgression(attacker, defender, hit);
        this.broadcastSwing(attacker, defender, amount, flags, hit);
        return true;
    }

    executeShapedKitAttack(attacker, primary, attack, spell, tickIndex) {
        if (!attacker || !spell || !spellHasShape(spell)) return false;
        const casterPos = { x: attacker.x | 0, y: attacker.y | 0, z: attacker.z | 0 };
        const kind = String((attack && attack.kind) || spell.attackKind || '');
        const tileMap = this.tileMap || this.map;
        let direction = { x: 1, y: 0 };
        let center = null;
        if (kind === 'wave') {
            if (primary) direction = cardinalDirection(casterPos, primary);
            center = {
                x: casterPos.x + (direction.x || 0),
                y: casterPos.y + (direction.y || 0),
                z: casterPos.z
            };
        } else if (primary) {
            center = { x: primary.x | 0, y: primary.y | 0, z: primary.z | 0 };
        } else {
            center = casterPos;
        }
        const tiles = getAffectedTiles({
            caster: casterPos,
            center,
            shape: spell.shape,
            direction,
            tileMap
        });
        const defenders = this.playersOnTiles(tiles);
        let sharedCrit = null;
        for (let i = 0; i < defenders.length; i++) {
            const def = defenders[i];
            const hitOpts = { critBand: CRIT_BAND_MULTIPLY, currentTick: tickIndex };
            if (sharedCrit != null) hitOpts.critical = sharedCrit;
            const hit = resolveSpellHit(attacker, def, spell, this.rng, hitOpts);
            if (sharedCrit == null) sharedCrit = !!hit.critical;
            this.applyCreatureKitHit(attacker, def, hit, attack, tickIndex);
        }
        return true;
    }

    executeCreatureStatus(attacker, defender, attack, tickIndex) {
        if (!attacker || !defender) return false;
        if (attack && attack.condition && isCombatantAlive(defender)) {
            applyCondition(defender, attack.condition, {
                source: attacker.kind || attacker.name || null
            });
        }
        this.broadcastSwing(attacker, defender, 0, 0);
        return true;
    }

    tryMonsterSummons(cr, target, tickIndex) {
        if (!this.featureFlag('monsterSummons', true)) return false;
        if (!cr || isSummon(cr) || (cr.hp | 0) <= 0) return false;
        const cfg = cr.summon;
        if (!cfg || !Array.isArray(cfg.summons) || !cfg.summons.length || !(cfg.maxSummons > 0)) {
            return false;
        }
        const engaged = !!(target && !target.dead && !target.downed && (target.hp | 0) > 0)
            || !!(cr.targetId);
        if (!engaged) return false;

        ensureSummonRuntime(cr);
        const resolve = (id) => this.getEntity(id);
        if (livingSummonsOf(cr, resolve).length >= cfg.maxSummons) return false;

        const ready = cr._summonReadyTicks;
        const rng = this.rng || Math.random;
        for (let i = 0; i < cfg.summons.length; i++) {
            const entry = cfg.summons[i];
            if (!entry) continue;
            if (livingSummonsOf(cr, resolve).length >= cfg.maxSummons) break;
            if ((ready[i] | 0) > 0 && tickIndex < ready[i]) continue;
            ready[i] = (tickIndex | 0) + this.summonIntervalTicks(entry);
            const chance = entry.chance != null ? Number(entry.chance) : 100;
            if (chance < 100 && rng() * 100 >= chance) continue;

            const current = livingSummonsOf(cr, resolve);
            let typeCount = 0;
            for (let j = 0; j < current.length; j++) {
                if (summonMatchesEntry(current[j], entry)) typeCount += 1;
            }
            if (typeCount >= entry.count) continue;

            const spawned = this.spawnSummon({
                creatureId: entry.id,
                master: cr,
                force: entry.force,
                target
            });
            if (spawned) return true;
        }
        return false;
    }

    tryCreatureAttacks(cr, target, tickIndex) {
        if (!cr || !target) return false;
        if ((cr.z | 0) !== (target.z | 0)) return false;
        if (target.dead || target.downed || (target.hp | 0) <= 0) return false;
        if (!this.harmfulCombatAllowed(cr, target)) return false;

        this.tryMonsterSummons(cr, target, tickIndex);

        if (this.tryDefenseSpells(cr, tickIndex)) return true;

        const attacks = cr.attacks;
        if (!attacks || !Array.isArray(attacks) || attacks.length === 0) {
            if (meleeRangeOk(cr, target)) {
                return this.trySwing(cr, target, tickIndex);
            }
            return false;
        }

        if (!cr._attackReadyTicks) cr._attackReadyTicks = {};
        const fleeing = isCreatureFleeing(cr);

        for (let i = 0; i < attacks.length; i++) {
            const atk = attacks[i];
            if (!atk) continue;
            const atkKey = atk.id || String(i);

            const readyTick = cr._attackReadyTicks[atkKey];
            if (readyTick != null && tickIndex < readyTick) {
                continue;
            }

            // Engine: melee is suppressed while runHealth flee is active (no CD arm).
            if (kitAttackIsMelee(atk) && fleeing) {
                continue;
            }

            const intervalTicks = this.creatureAttackIntervalTicks(atk);
            // Window opened: arm this row first. OOR / no LOS still burns the
            // interval so the kit cannot skip to a later in-range row.
            cr._attackReadyTicks[atkKey] = tickIndex + intervalTicks;

            const chance = atk.chance != null ? Number(atk.chance) : 100;
            if (chance < 100 && (this.rng() * 100 >= chance)) {
                continue;
            }

            const reach = kitAttackReach(atk);
            const dist = chebyshev(cr.x, cr.y, target.x, target.y);
            const needsTarget = kitAttackNeedsTarget(atk);
            const shaped = isKitShapedAttack(atk);
            const spell = shaped ? kitAttackToSpell(atk) : null;

            if (shaped && spell && spellHasShape(spell)) {
                if (needsTarget && dist > reach) {
                    return false;
                }
                cr.attackReadyTick = tickIndex + Math.min(intervalTicks, this.autoInterval());
                this.executeShapedKitAttack(cr, target, atk, spell, tickIndex);
                return true;
            }

            if (needsTarget && dist > reach) {
                return false;
            }

            if (reach > 1 || dist > 1) {
                if (!hasLineOfSight(cr.x, cr.y, cr.z, target.x, target.y, target.z, this.tileMap || this.map)) {
                    return false;
                }
            }

            cr.attackReadyTick = tickIndex + Math.min(intervalTicks, this.autoInterval());
            if (isKitStatusAttack(atk)) {
                this.executeCreatureStatus(cr, target, atk, tickIndex);
            } else {
                this.executeCreatureAttack(cr, target, atk, tickIndex);
            }
            return true;
        }

        return false;
    }

    executeCreatureAttack(attacker, defender, attack, tickIndex) {
        if (!attacker || !defender) return false;
        if ((attacker.z | 0) !== (defender.z | 0)) return false;

        const isMelee = (attack && attack.range != null)
            ? Number(attack.range) <= 1
            : (attack && attack.kind === 'melee');
        const hitChance = attack && attack.hitChance != null ? Number(attack.hitChance) : 100;
        const hit = resolveCreatureAttack(attacker, defender, attack, this.rng, {
            currentTick: tickIndex,
            isMelee,
            hitChance
        });

        let amount = 0;
        let flags = 0;
        if (hit.miss) {
            flags |= SWING_MISS;
        } else {
            amount = absorbWithManaShield(defender, Math.min(defender.hp | 0, hit.final)).leftoverHp;
            this.applyHp(defender, (defender.hp | 0) - amount);
            if (hit.critical) flags |= SWING_CRIT;
            if ((defender.hp | 0) <= 0) flags |= SWING_DEATH;
        }

        this.applyAttackProgression(attacker, defender, hit);
        this.broadcastSwing(attacker, defender, amount, flags, hit);

        if (flags & SWING_DEATH) {
            this.kill(defender, attacker, tickIndex);
        } else if (!hit.miss && defender.type === 'creature') {
            if (!defender.targetId) defender.targetId = attacker.id;
            this.wakeCreature(defender, tickIndex);
        }
        return true;
    }

    playerMoveLocked(attacker, tickIndex) {
        return !!(attacker && attacker.type === 'player' && tickIndex < (attacker.moveReadyTick | 0));
    }

    applyAutoMoveLock(attacker, tickIndex) {
        if (!attacker || attacker.type !== 'player') return;
        const extra = delayToTicks(SPELL_MOVE_LOCK_DEFAULT, this.settings.logicUps);
        if (!(extra > 0)) return;
        attacker.moveReadyTick = Math.max(attacker.moveReadyTick | 0, tickIndex + extra);
    }

    spendAutoConsumables(attacker) {
        if (!attacker || attacker.type !== 'player') return;
        const itemDb = this.itemDb();
        if (!itemDb || !attacker.inventory) return;
        let changed = false;
        if (equippedIsThrowingWeapon(attacker.inventory, itemDb)) {
            const br = tryBreakEquippedThrowingWeapon(attacker.inventory, itemDb, this.rng);
            if (br.changed) changed = true;
        } else if (equippedWeaponAmmoKind(attacker.inventory, itemDb)) {
            const ammoOn = this.featureFlag('ammoConsumption', this.packFeature('ammoConsumption'));
            if (ammoOn) {
                const used = consumeAmmoForShot(attacker.inventory, itemDb, 1);
                if (used.ok) changed = true;
            }
        }
        if (changed) {
            applyPlayerLoadout(attacker, itemDb);
            this.sendInventory(attacker);
        }
    }

    shapedAutoTargets(attacker, primary, tiles) {
        const out = [];
        const seen = new Set();
        const push = (ent) => {
            if (!ent || seen.has(ent.id)) return;
            if (ent === attacker) return;
            if (ent.type === 'player') return;
            if (isNpcEntity(ent)) return;
            if (ent.dead || ent.downed || (ent.hp | 0) <= 0) return;
            seen.add(ent.id);
            out.push(ent);
        };
        if (primary) push(primary);
        const tileMap = this.tileMap;
        const keys = new Set();
        if (tiles) {
            for (let i = 0; i < tiles.length; i++) {
                const t = tiles[i];
                if (!t) continue;
                keys.add((t.z | 0) + ':' + (t.x | 0) + ':' + (t.y | 0));
                const ents = tileMap && typeof tileMap.getCombatantEntities === 'function'
                    ? tileMap.getCombatantEntities(t.x, t.y, t.z)
                    : [];
                for (let k = 0; k < ents.length; k++) push(ents[k]);
            }
        }
        if (this.creatures) {
            for (const cr of this.creatures.values()) {
                const k = (cr.z | 0) + ':' + (cr.x | 0) + ':' + (cr.y | 0);
                if (keys.has(k)) push(cr);
            }
        }
        return out;
    }

    applyWeaponAutoHit(attacker, defender, hit, tickIndex) {
        let amount = 0;
        let flags = 0;
        if (!hit || hit.miss) {
            flags |= SWING_MISS;
        } else {
            amount = absorbWithManaShield(defender, Math.min(defender.hp | 0, hit.final)).leftoverHp;
            this.applyHp(defender, (defender.hp | 0) - amount);
            this.noteCreatureThreat(attacker, defender, amount, tickIndex);
            if (amount > 0 && attacker.type === 'player') this.applyAttackLeech(attacker, amount);
            if (hit.critical) flags |= SWING_CRIT;
            if (hit.fatal) flags |= SWING_FATAL;
            if ((defender.hp | 0) <= 0) flags |= SWING_DEATH;
        }
        this.broadcastSwing(attacker, defender, amount, flags, hit);
        if (flags & SWING_DEATH) {
            this.kill(defender, attacker, tickIndex);
        } else if (hit && !hit.miss && defender.type === 'creature') {
            if (!defender.targetId) defender.targetId = attacker.id;
            this.wakeCreature(defender, tickIndex);
        }
        return flags;
    }

    executeShapedDistanceAuto(attacker, defender, shape, tickIndex) {
        const hitChance = attacker && attacker.hitChance != null ? Number(attacker.hitChance) : 100;
        if (!rollHit(hitChance, this.rng)) {
            const miss = {
                miss: true,
                hit: false,
                raw: 0,
                final: 0,
                critical: false,
                fatal: false,
                shieldBlock: 0,
                armorReduction: 0,
                blockChargeSpent: false
            };
            this.applyWeaponAutoHit(attacker, defender, miss, tickIndex);
            this.applyAttackProgression(attacker, defender, miss);
            return miss;
        }
        const spell = {
            id: 'distance_auto',
            kind: 'auto',
            element: 'physical',
            powerCurve: 'distance_auto',
            isMelee: false,
            hitChance: 100,
            shape
        };
        const casterPos = { x: attacker.x | 0, y: attacker.y | 0, z: attacker.z | 0 };
        const center = { x: defender.x | 0, y: defender.y | 0, z: defender.z | 0 };
        const tiles = getAffectedTiles({
            caster: casterPos,
            center,
            shape,
            tileMap: this.tileMap || this.map
        });
        const targets = this.shapedAutoTargets(attacker, defender, tiles);
        const swingCritical = rollCritical(Number(attacker.critChance) || 0, this.rng);
        const swingFatal = attacker.type === 'creature'
            ? false
            : rollFatal(fatalChanceFromTier(attacker.weaponTier), this.rng);
        let primaryHit = null;
        for (let i = 0; i < targets.length; i++) {
            const def = targets[i];
            const hit = resolveSpellHit(attacker, def, spell, this.rng, {
                hit: true,
                critical: swingCritical,
                fatal: swingFatal,
                critBand: CRIT_BAND_MULTIPLY,
                currentTick: tickIndex
            });
            if (def === defender) primaryHit = hit;
            this.applyWeaponAutoHit(attacker, def, hit, tickIndex);
        }
        const used = primaryHit || {
            miss: false,
            hit: true,
            raw: 0,
            final: 0,
            critical: swingCritical,
            fatal: swingFatal,
            shieldBlock: 0,
            armorReduction: 0,
            blockChargeSpent: false
        };
        this.applyAttackProgression(attacker, defender, used);
        return used;
    }

    trySwing(attacker, defender, tickIndex) {
        if (tickIndex < attacker.attackReadyTick) return false;
        if (this.playerMoveLocked(attacker, tickIndex)) return false;
        if (!attacker || !defender) return false;
        if ((attacker.z | 0) !== (defender.z | 0)) return false;
        if (!this.harmfulCombatAllowed(attacker, defender)) return false;

        const isMagic = attacker && attacker.weaponType === 'magic';
        const isDistance = attacker && attacker.weaponType === 'distance';
        if (isMagic || isDistance) {
            const defaultRange = isMagic ? 4 : 6;
            const range = attacker.weaponRange != null ? attacker.weaponRange : defaultRange;
            if (chebyshev(attacker.x, attacker.y, defender.x, defender.y) > range) return false;
            if (!hasLineOfSight(attacker.x, attacker.y, attacker.z, defender.x, defender.y, defender.z, this.tileMap || this.map)) {
                return false;
            }
        } else {
            if (!meleeRangeOk(attacker, defender)) return false;
        }

        const itemDb = attacker.type === 'player' ? this.itemDb() : null;
        const needsAmmo = attacker.type === 'player' && !isMagic && itemDb && equippedWeaponAmmoKind(attacker.inventory, itemDb);
        if (needsAmmo) {
            if (!peekAmmoForShot(attacker.inventory, itemDb)) {
                this.say(attacker, 'You need ammunition.');
                return false;
            }
        }

        attacker.attackReadyTick = tickIndex + this.autoInterval();

        const autoShape = isDistance && attacker.type === 'player' && itemDb
            ? resolveDistanceAutoShape(attacker.inventory, itemDb)
            : null;

        if (autoShape) {
            this.executeShapedDistanceAuto(attacker, defender, autoShape, tickIndex);
            this.spendAutoConsumables(attacker);
            this.applyAutoMoveLock(attacker, tickIndex);
            return true;
        }

        let hit;
        if (isMagic) {
            hit = resolveWandAuto(attacker, defender, this.rng);
        } else if (isDistance) {
            hit = resolveDistanceAuto(attacker, defender, this.rng, {
                factor: this.settings.meleeAutoFactor,
                currentTick: tickIndex,
                isMelee: false
            });
        } else {
            const meleeOpts = {
                factor: this.settings.meleeAutoFactor,
                currentTick: tickIndex
            };
            if (attacker.atk == null) meleeOpts.unarmedAtk = this.settings.unarmedAtk;
            hit = resolveMelee(attacker, defender, this.rng, meleeOpts);
        }

        this.applyWeaponAutoHit(attacker, defender, hit, tickIndex);

        if (isMagic) {
            if (hit.manaGain > 0) {
                this.applyMp(attacker, (attacker.mp | 0) + hit.manaGain);
                this.broadcastStats(attacker);
            }
        } else {
            this.applyAttackProgression(attacker, defender, hit);
        }

        if (attacker.type === 'player') {
            this.spendAutoConsumables(attacker);
            this.applyAutoMoveLock(attacker, tickIndex);
        }
        return true;
    }

    applyHp(entity, hp) {
        const next = Math.max(0, Math.min(entity.hpMax | 0, hp | 0));
        entity.hp = next;
        if (entity.character) entity.character.hp = next;
    }

    applyAttackLeech(attacker, realDamage) {
        if (!attacker || !(realDamage > 0)) return { life: 0, mana: 0 };
        const rolled = computeAttackLeech(attacker, realDamage, this.rng);
        if (rolled.life > 0) this.applyHp(attacker, (attacker.hp | 0) + rolled.life);
        if (rolled.mana > 0) this.applyMp(attacker, (attacker.mp | 0) + rolled.mana);
        if (rolled.life > 0 || rolled.mana > 0) this.broadcastStats(attacker);
        return rolled;
    }

    applyMp(entity, mp) {
        if (!entity) return;
        const next = Math.max(0, Math.min(entity.mpMax | 0, mp | 0));
        entity.mp = next;
        if (entity.character) entity.character.mp = next;
    }

    applyDamage(entity, amount, element, tickIndex, killer) {
        if (!entity) return 0;
        let incoming = Math.max(0, Math.floor(Number(amount) || 0));
        if (incoming > 0 && element !== 'healing' && element !== 'undefined' && element !== 'manadrain') {
            incoming = absorbWithManaShield(entity, incoming).leftoverHp;
        }
        if (incoming <= 0) return 0;
        this.applyHp(entity, (entity.hp | 0) - incoming);
        this.noteCreatureThreat(killer, entity, incoming, tickIndex);
        if (entity.type === 'creature' && entity.simSleeping) {
            this.wakeCreature(entity, tickIndex);
        }
        this.broadcastStats(entity);
        if ((entity.hp | 0) <= 0) this.kill(entity, killer || null, tickIndex);
        return incoming;
    }

    featureFlag(name, defaultValue) {
        const s = this.settings && this.settings.features;
        if (s && typeof s[name] === 'boolean') return s[name];
        const p = this.pack && this.pack.features;
        if (p && typeof p[name] === 'boolean') return p[name];
        return defaultValue !== undefined ? !!defaultValue : true;
    }

    syncCharacterProgress(session) {
        if (!session || !session.character) return;
        session.character.level = session.level | 0;
        session.character.experience = Number(session.experience) || 0;
        session.character.hp = session.hp | 0;
        session.character.hpMax = session.hpMax | 0;
        session.character.mp = session.mp | 0;
        session.character.mpMax = session.mpMax | 0;
    }

    applyLevelPools(session, oldLevel, newLevel) {
        if (!session || newLevel <= oldLevel) return false;
        const cls = classRow(this.pack, session.character && session.character.vocation);
        if (!applyLevelPoolDelta(session, oldLevel, newLevel, cls)) return false;
        this.syncCharacterProgress(session);
        return true;
    }

    awardKillExp(killer, monsterExp) {
        const raw = Math.max(0, monsterExp | 0);
        if (!killer || killer.type !== 'player' || raw <= 0) return 0;
        const share = partySharePerMember(raw, { partySize: 1 });
        const awarded = applyPersonalExpRates(share.personalRaw, null);
        const oldLevel = Math.max(1, killer.level | 0);
        if (this.featureFlag('expProgression')) {
            applyExpProgression(killer, awarded);
        } else {
            killer.experience = (Number(killer.experience) || 0) + awarded;
        }
        this.syncCharacterProgress(killer);
        const newLevel = Math.max(1, killer.level | 0);
        if (newLevel > oldLevel) {
            this.applyLevelPools(killer, oldLevel, newLevel);
            applyPlayerLoadout(killer, this.itemDb());
            recomputeDerived(killer);
            this.say(killer, 'You advanced to level ' + newLevel + '.');
            this.broadcastStats(killer);
            this.sendInventory(killer);
        }
        killer.send(S2C.EXP, encodeExp(
            Math.min(0xffffffff, Number(killer.experience) || 0),
            awarded,
            killer.level | 0
        ));
        return awarded;
    }

    applyAttackProgression(attacker, defender, hit) {
        if (!hit) return;
        const skillOn = this.featureFlag('skillProgression');
        if (!skillOn) return;
        const voc = attacker && attacker.type === 'player' ? attacker.skillRates : null;
        const out = processAttackSkillProgression(attacker, defender, hit, {
            skillProgression: skillOn,
            vocationRates: voc,
            defenderVocationRates: defender && defender.type === 'player' ? defender.skillRates : null,
            blockChargeSpent: !!hit.blockChargeSpent
        });
        let reload = false;
        if (out.weaponAdvance && out.weaponAdvance.levelsGained > 0 && attacker && attacker.type === 'player') {
            this.sendSkills(attacker);
            this.say(
                attacker,
                'Your ' + skillLabel(out.weaponAdvance.skill) + ' skill increased to ' +
                    out.weaponAdvance.newLevel + '.'
            );
            reload = true;
        }
        if (out.shieldAdvance && out.shieldAdvance.levelsGained > 0 && defender && defender.type === 'player') {
            this.sendSkills(defender);
            this.say(
                defender,
                'Your ' + skillLabel('shielding') + ' skill increased to ' +
                    out.shieldAdvance.newLevel + '.'
            );
            applyPlayerLoadout(defender, this.itemDb());
            this.sendInventory(defender);
        }
        if (reload && attacker && attacker.type === 'player') {
            applyPlayerLoadout(attacker, this.itemDb());
        }
    }

    broadcastStats(entity) {
        if (!entity) return;
        const stats = encodeStats(entity);
        if (entity.type === 'player' && entity.send && !entity.dead) {
            entity.send(S2C.STATS, stats);
        }
        const candidates = this.viewerCandidates(entity.x, entity.y, entity.z, 16);
        for (const p of candidates) {
            if (!p || p === entity || p.downed || p.dead) continue;
            if (this.sees(p, entity.x, entity.y, entity.z)) {
                p.send(S2C.STATS, stats);
            }
        }
    }

    swingWire(attacker, defender, amount, flags, hit) {
        const element = (hit && (hit.element || hit.extraAtkElement))
            || (attacker && attacker.weaponElement)
            || 'physical';
        let weaponId = '';
        let ammoId = '';
        if (attacker && attacker.type === 'player' && attacker.inventory) {
            const itemDb = this.itemDb();
            const right = equippedRightHandItem(attacker.inventory, itemDb);
            if (right && (right.id || right.itemId)) weaponId = String(right.id || right.itemId);
            const ammo = peekAmmoForShot(attacker.inventory, itemDb);
            if (ammo && (ammo.id || ammo.itemId)) ammoId = String(ammo.id || ammo.itemId);
        }
        return {
            sourceId: attacker.id,
            targetId: defender.id,
            amount,
            flags,
            element,
            weaponId,
            ammoId
        };
    }

    broadcastSwing(attacker, defender, amount, flags, hit) {
        const swing = encodeSwing(this.swingWire(attacker, defender, amount, flags, hit));
        const stats = encodeStats(defender);
        const candidates = this.viewerCandidates(defender.x, defender.y, defender.z, 16);
        for (const p of candidates) {
            if (!p || (p.downed && p !== defender) || p.dead) continue;
            if (p === attacker || p === defender
                || this.sees(p, defender.x, defender.y, defender.z)
                || this.sees(p, attacker.x, attacker.y, attacker.z)) {
                p.send(S2C.SWING, swing);
                p.send(S2C.STATS, stats);
            }
        }
    }

    kill(victim, killer, tickIndex) {
        this.clearTarget(victim.id);
        if (victim.type === 'player') {
            this.killPlayer(victim, killer, tickIndex);
            return;
        }
        this.killCreature(victim, killer, tickIndex);
    }

    killPlayer(session, killer, tickIndex) {
        const delay = Math.max(1, (this.settings.deathDelayTicks | 0) || 40);
        this.tileMap.leaveTile(session.x, session.y, session.z, session);
        this.broadcastToViewers(session.x, session.y, session.z, (p) => {
            p.send(S2C.DEATH, encodeDeath(session.id, killer && killer.id));
        }, session);
        this.broadcastDisappear(session.id, session);
        session.downed = true;
        session.targetId = 0;
        this.clearPlayerWalk(session);
        session.respawnTick = tickIndex + delay;
        session.openCorpseId = 0;
        this.closeTalk(session, true);
    }

    killCreature(creature, killer, tickIndex, opts) {
        const dismiss = !!(opts && opts.dismiss);
        const summoned = isSummon(creature);
        if (this.computeService) {
            this.computeService.cancelEntityJobs(creature.id);
        }
        creature._computeToken = null;
        this.clearTarget(creature.id);
        if (!dismiss && !summoned) {
            this.dismissSummonsOf(creature, tickIndex);
        } else if (summoned) {
            this.unlinkSummon(creature);
        }
        this.tileMap.leaveTile(creature.x, creature.y, creature.z, creature);
        this.creatures.delete(creature.id);
        this.activeCreatures.delete(creature);
        if (this.creatureSpatial) this.creatureSpatial.remove(creature.id);
        this.broadcastToViewers(creature.x, creature.y, creature.z, (p) => {
            p.send(S2C.DEATH, encodeDeath(creature.id, killer && killer.id));
            p.send(S2C.DISAPPEAR, encodeDisappear(creature.id));
        });
        const skipCorpse = dismiss || summoned;
        if (!skipCorpse) {
            const items = rollLoot(creature.loot, this.rng);
            const corpse = createCorpse(this.nextCorpseId, creature, items, tickIndex);
            this.nextCorpseId += 1;
            this.corpses.set(corpse.id, corpse);
            this.corpseQueue.push(corpse);
            if (this.corpseSpatial) this.corpseSpatial.insert(corpse);
            const corpseBuf = encodeCorpse(corpse);
            this.broadcastToViewers(corpse.x, corpse.y, corpse.z, (p) => {
                p.send(S2C.CORPSE, corpseBuf);
            });
        }
        if (!dismiss && killer && killer.type === 'player') {
            this.awardKillExp(killer, creature.exp | 0);
        }
        if (skipCorpse) {
            if (this.creaturePool) this.creaturePool.release(creature);
            return;
        }
        const pin = creature.pinIndex != null ? this.spawnPins[creature.pinIndex] : null;
        if (pin) {
            if (this.livingPins) this.livingPins.delete(pin);
            pin.entityId = 0;
            pin.parkedEntity = null;
            pin.idleTicks = 0;
            const delay = respawnDelayTicks(pin, this.settings);
            if (delay <= 0) {
                pin.state = 'skipped';
                pin.skipReason = 'oneshot';
            } else {
                pin.state = 'cooldown';
                pin.readyTick = tickIndex + delay;
            }
            if (this.creaturePool) this.creaturePool.release(creature);
            return;
        }
        const respawn = Math.max(1, (this.settings.creatureRespawnTicks | 0) || 200);
        this.enqueuePendingSpawn({
            kind: creature.kind,
            x: creature.spawnX,
            y: creature.spawnY,
            z: creature.spawnZ,
            at: (tickIndex | 0) + respawn
        });
        if (this.creaturePool) this.creaturePool.release(creature);
    }

    respawnPlayer(session, tickIndex) {
        if (!session.downed || session.dead) return;
        const pos = this.spawnPos(session.character);
        session.x = pos.x;
        session.y = pos.y;
        session.z = pos.z;
        if (!this.tileMap.enterTile(session.x, session.y, session.z, session)) {
            const alt = this.tileMap.findNearestEnterable(
                session.x, session.y, session.z, session
            );
            if (!alt || !this.tileMap.enterTile(alt.x, alt.y, alt.z, session)) {
                session.respawnTick = tickIndex + 20;
                return;
            }
            session.x = alt.x;
            session.y = alt.y;
            session.z = alt.z;
        }
        if (this.playerSpatial) this.playerSpatial.update(session);
        this.applyHp(session, session.hpMax);
        session.downed = false;
        session.targetId = 0;
        this.clearPlayerWalk(session);
        session.moveReadyTick = tickIndex;
        session.attackReadyTick = tickIndex;
        session.send(S2C.STATS, encodeStats(session));
        session.send(S2C.MOVE, encodeMove({
            id: session.id, x: session.x, y: session.y, z: session.z, dir: session.dir
        }));
        session.send(S2C.VIEWPORT, encodeViewport(this.viewportOf(session)));
        this.syncAppears(session);
    }

    tickCorpses(tickIndex) {
        const decay = Math.max(1, (this.settings.corpseDecayTicks | 0) || 600);
        while (this.corpseQueue.length > 0) {
            const head = this.corpseQueue[0];
            if (!this.corpses.has(head.id)) {
                this.corpseQueue.shift();
                continue;
            }
            if ((tickIndex | 0) - (head.bornTick | 0) < decay) {
                break;
            }
            this.corpseQueue.shift();
            this.removeCorpse(head);
        }
    }

    removeCorpse(corpse) {
        this.corpses.delete(corpse.id);
        if (this.corpseSpatial) this.corpseSpatial.remove(corpse.id);
        const gone = encodeCorpseGone(corpse.id);
        this.broadcastToViewers(corpse.x, corpse.y, corpse.z, (p) => {
            p.send(S2C.CORPSE_GONE, gone);
        });
        for (const p of this.players.values()) {
            if (p.openCorpseId === corpse.id) p.openCorpseId = 0;
        }
    }

    enqueuePendingSpawn(item) {
        let low = 0;
        let high = this.pendingSpawns.length;
        const target = item.at | 0;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if ((this.pendingSpawns[mid].at | 0) <= target) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        this.pendingSpawns.splice(low, 0, item);
    }

    tickRespawns(tickIndex) {
        while (this.pendingSpawns.length > 0) {
            const head = this.pendingSpawns[0];
            if ((tickIndex | 0) < (head.at | 0)) {
                break;
            }
            this.pendingSpawns.shift();
            if (!this.spawnCreature(head.kind, head.x, head.y, head.z)) {
                head.at = (tickIndex | 0) + 20;
                this.enqueuePendingSpawn(head);
            }
        }
    }

    clearTarget(id) {
        const n = Number(id);
        for (const p of this.players.values()) {
            if (p.targetId === n) {
                p.targetId = 0;
            }
        }
        for (const cr of this.activeCreatures) {
            if (cr.targetId === n) {
                cr.targetId = 0;
                if (!this.creatureAtHome(cr)) cr.leashing = true;
            }
        }
    }

    viewerCandidates(x, y, z, radius) {
        const frame = this._aoiFrame;
        if (frame && frame.observers) return frame.observers;
        if (this.playerSpatial) {
            return this.playerSpatial.queryChunkCandidates(x, y, z, radius != null ? radius : 16);
        }
        return this.players.values();
    }

    broadcastToViewers(x, y, z, fn, include) {
        if (include && !include.dead) {
            fn(include);
        }
        const candidates = this.viewerCandidates(x, y, z, 16);
        for (const p of candidates) {
            if (!p || p.dead || p === include) continue;
            if (this.sees(p, x, y, z)) fn(p);
        }
    }

    broadcastMove(entity, from, dir) {
        const id = entity.id;
        const move = encodeMove({
            id,
            x: entity.x,
            y: entity.y,
            z: entity.z,
            dir
        });
        if (entity.type === 'player' && !entity.downed) {
            entity.send(S2C.MOVE, move);
            entity.send(S2C.VIEWPORT, encodeViewport(this.viewportOf(entity)));
        }

        const candidatePlayers = [];
        const seen = new Set();
        const addPlayers = (list) => {
            for (const p of list) {
                if (!p || seen.has(p.id)) continue;
                seen.add(p.id);
                candidatePlayers.push(p);
            }
        };
        addPlayers(this.viewerCandidates(entity.x, entity.y, entity.z, 16));
        if ((from.z | 0) !== (entity.z | 0) && !(this._aoiFrame && this._aoiFrame.observers)) {
            addPlayers(this.viewerCandidates(from.x, from.y, from.z, 16));
        }

        for (let i = 0; i < candidatePlayers.length; i++) {
            const other = candidatePlayers[i];
            if (other === entity || other.downed || other.dead) continue;
            const otherSaw = this.sees(other, from.x, from.y, from.z);
            const otherSees = this.sees(other, entity.x, entity.y, entity.z);
            if (!otherSaw && otherSees) {
                other.send(S2C.APPEAR, encodeAppear(entity));
            } else if (otherSaw && !otherSees) {
                other.send(S2C.DISAPPEAR, encodeDisappear(id));
            } else if (otherSaw && otherSees) {
                other.send(S2C.MOVE, move);
            }
        }

        if (entity.type !== 'player' || entity.downed) return;

        const candidateCreatures = [];
        if (this.creatureSpatial) {
            const seenCr = new Set();
            const addCr = (list) => {
                for (let i = 0; i < list.length; i++) {
                    const cr = list[i];
                    if (!cr || seenCr.has(cr.id)) continue;
                    seenCr.add(cr.id);
                    candidateCreatures.push(cr);
                }
            };
            addCr(this.creatureSpatial.queryChunkCandidates(entity.x, entity.y, entity.z, 16));
            if ((from.z | 0) !== (entity.z | 0)) {
                addCr(this.creatureSpatial.queryChunkCandidates(from.x, from.y, from.z, 16));
            }
        } else {
            for (const cr of this.creatures.values()) candidateCreatures.push(cr);
        }

        for (let i = 0; i < candidateCreatures.length; i++) {
            const cr = candidateCreatures[i];
            const selfSaw = inViewport(
                this.map, from.x, from.y, cr.x, cr.y, cr.z, null, null, from.z
            );
            const selfSees = this.sees(entity, cr.x, cr.y, cr.z);
            if (!selfSaw && selfSees) {
                entity.send(S2C.APPEAR, encodeAppear(cr));
            } else if (selfSaw && !selfSees) {
                entity.send(S2C.DISAPPEAR, encodeDisappear(cr.id));
            }
        }

        for (let i = 0; i < candidatePlayers.length; i++) {
            const other = candidatePlayers[i];
            if (other === entity || other.downed || other.dead) continue;
            const selfSaw = inViewport(
                this.map, from.x, from.y, other.x, other.y, other.z, null, null, from.z
            );
            const selfSees = this.sees(entity, other.x, other.y, other.z);
            if (!selfSaw && selfSees) {
                entity.send(S2C.APPEAR, encodeAppear(other));
            } else if (selfSaw && !selfSees) {
                entity.send(S2C.DISAPPEAR, encodeDisappear(other.id));
            }
        }

        const candidateCorpses = [];
        if (this.corpseSpatial) {
            const seenCp = new Set();
            const addCp = (list) => {
                for (let i = 0; i < list.length; i++) {
                    const cp = list[i];
                    if (!cp || seenCp.has(cp.id)) continue;
                    seenCp.add(cp.id);
                    candidateCorpses.push(cp);
                }
            };
            addCp(this.corpseSpatial.queryChunkCandidates(entity.x, entity.y, entity.z, 16));
            if ((from.z | 0) !== (entity.z | 0)) {
                addCp(this.corpseSpatial.queryChunkCandidates(from.x, from.y, from.z, 16));
            }
        } else {
            for (const cp of this.corpses.values()) candidateCorpses.push(cp);
        }

        for (let i = 0; i < candidateCorpses.length; i++) {
            const corpse = candidateCorpses[i];
            const selfSaw = inViewport(
                this.map, from.x, from.y, corpse.x, corpse.y, corpse.z, null, null, from.z
            );
            const selfSees = this.sees(entity, corpse.x, corpse.y, corpse.z);
            if (!selfSaw && selfSees) {
                entity.send(S2C.CORPSE, encodeCorpse(corpse));
            } else if (selfSaw && !selfSees) {
                entity.send(S2C.CORPSE_GONE, encodeCorpseGone(corpse.id));
            }
        }

        const candidatePins = [];
        if (this.worldPinSpatial) {
            const seenP = new Set();
            const addP = (list) => {
                for (let i = 0; i < list.length; i++) {
                    const pin = list[i];
                    if (!pin || seenP.has(pin.id)) continue;
                    seenP.add(pin.id);
                    candidatePins.push(pin);
                }
            };
            addP(this.worldPinSpatial.queryChunkCandidates(entity.x, entity.y, entity.z, 16));
            if ((from.z | 0) !== (entity.z | 0)) {
                addP(this.worldPinSpatial.queryChunkCandidates(from.x, from.y, from.z, 16));
            }
        } else {
            for (let i = 0; i < this.worldPins.length; i++) {
                const inst = this.worldPins[i];
                if (inst && !inst.removed) candidatePins.push(inst);
            }
        }

        for (let i = 0; i < candidatePins.length; i++) {
            const inst = candidatePins[i];
            if (!inst || inst.removed) continue;
            const selfSaw = inViewport(
                this.map, from.x, from.y, inst.x, inst.y, inst.z, null, null, from.z
            );
            const selfSees = this.sees(entity, inst.x, inst.y, inst.z);
            if (!selfSaw && selfSees) {
                entity.send(S2C.WORLD_PIN, encodeWorldPin(inst));
            } else if (selfSaw && !selfSees) {
                entity.send(S2C.WORLD_PIN_GONE, encodeWorldPinGone(inst.id));
            }
        }
    }

    talkRange() {
        return Math.max(1, (this.settings.talkRange | 0) || DEFAULT_TALK_RANGE);
    }

    townSpawn() {
        const z = this.map.spawnZ != null ? this.map.spawnZ : this.map.z;
        return clampSpawn(this.map, this.map.spawnX, this.map.spawnY, z);
    }

    sendInventory(session) {
        const itemDb = this.itemDb();
        const inv = session.inventory;
        session.send(S2C.INVENTORY, encodeInventory(bagView(inv, inv && inv.rootUid, itemDb)));
        const cap = playerCap(session, itemDb);
        session.send(S2C.EQUIPMENT, encodeEquipment({
            cap: cap.cap,
            capMax: cap.capMax,
            slots: equipmentView(inv, itemDb)
        }));
        if (session.openBagUid && ownsContainer(inv, session.openBagUid)) {
            session.send(S2C.BAG, encodeInventory(bagView(inv, session.openBagUid, itemDb)));
        } else if (session.openBagUid) {
            session.openBagUid = '';
            session.send(S2C.BAG, encodeInventory({ containerId: '', capacity: 0, slots: [] }));
        }
    }

    sendSkills(session) {
        session.send(S2C.SKILLS, encodeSkills(session.skills));
    }

    say(session, text) {
        session.send(S2C.SAY, encodeSay(text));
    }

    _clearGlobalSaveTimers() {
        if (this._globalSaveTimer != null) {
            clearTimeout(this._globalSaveTimer);
            this._globalSaveTimer = null;
        }
        if (this._globalNotifyTimer != null) {
            clearTimeout(this._globalNotifyTimer);
            this._globalNotifyTimer = null;
        }
    }

    _scheduleGlobalSave() {
        this._clearGlobalSaveTimers();
        const clock = parseClock(this.settings && this.settings.globalSaveTime);
        if (!clock) return;
        const now = this.now();
        const until = msUntilClock(clock, now);
        const notifyMin = Math.max(0, (this.settings.globalSaveNotifyMinutes | 0));
        const notifyMs = notifyMin * 60 * 1000;
        if (notifyMin > 0 && until > 1000) {
            const wait = until - notifyMs;
            const fireNotify = () => {
                const remainMs = Math.max(0, msUntilClock(clock, this.now()));
                const mins = Math.max(1, Math.ceil(remainMs / 60000));
                this.broadcastSay(globalSaveMessage(mins));
            };
            if (wait <= 0) {
                fireNotify();
            } else {
                this._globalNotifyTimer = setTimeout(fireNotify, wait);
                if (typeof this._globalNotifyTimer.unref === 'function') this._globalNotifyTimer.unref();
            }
        }
        this._globalSaveTimer = setTimeout(() => {
            this.runGlobalSave().catch((err) => {
                this.log.error('global save', { err: err && err.message });
            });
        }, Math.max(0, until));
        if (typeof this._globalSaveTimer.unref === 'function') this._globalSaveTimer.unref();
    }

    _clearIntervalTimer() {
        if (this._intervalTimer != null) {
            clearTimeout(this._intervalTimer);
            this._intervalTimer = null;
        }
    }

    _scheduleIntervalSave() {
        this._clearIntervalTimer();
        const ms = this.settings && (this.settings.persistIntervalMs | 0);
        if (ms <= 0) return;
        this._intervalTimer = setTimeout(() => {
            this.runIntervalSave().catch((err) => {
                this.log.error('interval save', { err: err && err.message });
            });
        }, ms);
        if (typeof this._intervalTimer.unref === 'function') this._intervalTimer.unref();
    }

    async runIntervalSave() {
        if (this._intervalRunning) {
            this._scheduleIntervalSave();
            return;
        }
        this._intervalRunning = true;
        this._clearIntervalTimer();
        this.log.info('interval save', { players: this.players.size });
        try {
            await this.saveAllOnline('interval');
        } finally {
            this._intervalRunning = false;
            this._scheduleIntervalSave();
        }
    }

    _stopPersistClock() {
        this._clearGlobalSaveTimers();
        this._clearIntervalTimer();
        this._intervalRunning = false;
    }

    broadcastSay(text) {
        for (const session of this.players.values()) {
            if (!session.left) this.say(session, text);
        }
    }

    async saveAllOnline(reason) {
        const r = reason || 'global';
        const jobs = [];
        for (const session of this.players.values()) {
            if (session.left) continue;
            jobs.push(this.enqueuePersist(session, r));
        }
        if (!jobs.length) return;
        await Promise.all(jobs.map((p) => p.catch(() => {})));
    }

    async runGlobalSave() {
        this._clearGlobalSaveTimers();
        const shutdown = !!(this.settings && this.settings.globalSaveShutdown);
        this.log.info('global save', { shutdown, players: this.players.size });
        if (shutdown) {
            if (typeof this.onRequestShutdown === 'function') {
                await this.onRequestShutdown('global-save');
                return;
            }
            await this.shutdown();
            return;
        }
        await this.saveAllOnline();
        this._scheduleGlobalSave();
    }

    enqueuePersist(session, reason) {
        if (!this.store || typeof this.store.saveCharacter !== 'function') {
            return Promise.resolve(false);
        }
        if (!session || !session.character) return Promise.resolve(false);
        const id = session.character.id;
        const run = () => this.writeSnapshot(session, reason);
        const prev = this._persistTails.get(id) || Promise.resolve();
        const tail = prev.then(run, run);
        this._persistTails.set(id, tail);
        return tail;
    }

    async writeSnapshot(session, reason) {
        if (!session || !session.character) return false;
        if (session.left && reason !== LOGOUT_PERSIST) return false;
        return this._persistGate.run(async () => {
            if (!session.character) return false;
            if (session.left && reason !== LOGOUT_PERSIST) return false;
            const snap = snapshotSession(session, {
                spawn: this.townSpawn(),
                lastLogout: reason === LOGOUT_PERSIST || session.left ? new Date(this.now()) : null
            });
            try {
                return await this.store.saveCharacter(session.character.id, snap);
            } catch (err) {
                this.log.error('persist', { err: err && err.message });
                return false;
            }
        });
    }

    async flushPersist() {
        const jobs = Array.from(this._persistTails.values());
        if (!jobs.length) return;
        await Promise.all(jobs.map((p) => p.catch(() => {})));
    }

    async awaitPersist(id) {
        const tail = this._persistTails.get(Number(id));
        if (!tail) return;
        try {
            await tail;
        } catch {
            // already logged in writeSnapshot
        }
    }

    closeTalk(session, notify) {
        const id = session.talkNpcId;
        session.talkNpcId = 0;
        session.talkNodeId = '';
        session.shopOpen = false;
        if (notify && id) {
            session.send(S2C.DIALOG_CLOSE, encodeDialogClose(id));
        }
    }

    tickTalkRange(session) {
        if (!session.talkNpcId) return;
        const npc = this.getEntity(session.talkNpcId);
        if (!npc || !isNpcEntity(npc) || !talkRangeOk(session, npc, this.talkRange())) {
            this.closeTalk(session, true);
        }
    }

    npcForTalk(session, id) {
        const npc = this.getEntity(id);
        if (!npc || !isNpcEntity(npc)) return null;
        return npc;
    }

    sendDialog(session, npc, nodeId) {
        const dialog = normalizeDialog(npc.dialog) || resolveDialog(npc, this.dialogs);
        if (!dialog) {
            this.say(session, 'Nothing to say.');
            return false;
        }
        const resolved = resolveNode(dialog, nodeId);
        if (!resolved) {
            this.say(session, 'Nothing to say.');
            return false;
        }
        applyStoragePatch(session.storage, resolved.node.set);
        session.talkNpcId = npc.id;
        session.talkNodeId = resolved.nodeId;
        const replies = listReplies(resolved.node, session);
        session.send(S2C.DIALOG, encodeDialog({
            npcId: npc.id,
            nodeId: resolved.nodeId,
            text: resolved.node.text != null ? String(resolved.node.text) : '',
            replies
        }));
        return true;
    }

    sendShop(session, npc) {
        const shop = resolveShop(npc)
            || (this.dialogs && npc.dialogId && resolveShop(this.dialogs[npc.dialogId]));
        if (!shop) {
            this.say(session, 'I do not trade with you.');
            return false;
        }
        if (shop.when != null && !evalWhen(session, shop.when)) {
            this.say(session, shop.denyText || 'I do not trade with you.');
            return false;
        }
        session.shopOpen = true;
        session.send(S2C.SHOP, encodeShop({
            npcId: npc.id,
            currency: shop.currency,
            items: listShopRows(shop, session)
        }));
        return true;
    }

    applyTalk(session, intent) {
        const id = decodeTalk(intent.payload);
        if (id == null) {
            session.malformed();
            return;
        }
        if (id === 0) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        const npc = this.npcForTalk(session, id);
        if (!npc) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        if (!talkRangeOk(session, npc, this.talkRange())) {
            session.reject(intent.seq, REASON.OUT_OF_RANGE);
            return;
        }
        this.sendDialog(session, npc, null);
    }

    applyTalkReply(session, intent) {
        const body = decodeTalkReply(intent.payload);
        if (!body) {
            session.malformed();
            return;
        }
        const npc = this.npcForTalk(session, body.npcId);
        if (!npc || session.talkNpcId !== npc.id) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        if (!talkRangeOk(session, npc, this.talkRange())) {
            session.reject(intent.seq, REASON.OUT_OF_RANGE);
            return;
        }
        const dialog = normalizeDialog(npc.dialog) || resolveDialog(npc, this.dialogs);
        const resolved = dialog ? resolveNode(dialog, session.talkNodeId) : null;
        if (!resolved) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        const replies = listReplies(resolved.node, session);
        const reply = replies[body.index];
        if (!reply) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        if (reply.give && !this.canGiveItem(session, reply.give.itemId, reply.give.count)) {
            this.say(session, 'You cannot carry that.');
            return;
        }
        if (reply.take) {
            if (!takeItem(session.inventory, reply.take.itemId, reply.take.count, this.itemDb())) {
                this.say(session, 'You do not have that.');
                return;
            }
            this.sendInventory(session);
        }
        if (reply.give) {
            this.tryGiveItem(session, reply.give.itemId, reply.give.count);
            session.send(S2C.ITEM_GAIN, encodeItemGain(reply.give.itemId, reply.give.count));
            this.sendInventory(session);
        }
        applyStoragePatch(session.storage, reply.set);
        const action = reply.action || 'close';
        if (action === 'close') {
            this.closeTalk(session, true);
            return;
        }
        if (action === 'open_shop') {
            this.sendShop(session, npc);
            if (reply.goto) this.sendDialog(session, npc, reply.goto);
            return;
        }
        if (reply.goto || action === 'goto' || action === 'give_item' || action === 'take_item') {
            if (reply.goto) this.sendDialog(session, npc, reply.goto);
            return;
        }
        this.closeTalk(session, true);
    }

    applyTalkClose(session, intent) {
        const id = decodeTalkClose(intent.payload);
        if (id == null) {
            session.malformed();
            return;
        }
        if (id !== 0 && session.talkNpcId && session.talkNpcId !== id) return;
        this.closeTalk(session, true);
    }

    applyShopDeal(session, intent, side) {
        const body = decodeShopDeal(intent.payload);
        if (!body) {
            session.malformed();
            return;
        }
        const npc = this.npcForTalk(session, body.npcId);
        if (!npc) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        if (!talkRangeOk(session, npc, this.talkRange())) {
            session.reject(intent.seq, REASON.OUT_OF_RANGE);
            return;
        }
        const shop = resolveShop(npc)
            || (this.dialogs && npc.dialogId && resolveShop(this.dialogs[npc.dialogId]));
        if (!shop) {
            this.say(session, 'I do not trade with you.');
            return;
        }
        if (shop.when != null && !evalWhen(session, shop.when)) {
            this.say(session, shop.denyText || 'I do not trade with you.');
            return;
        }
        const count = clampDealCount(body.count);
        if (count < 1) {
            session.malformed();
            return;
        }
        const row = findShopRow(shop, body.itemId);
        if (!row) {
            this.say(session, side === 'buy' ? 'I do not sell that.' : 'I do not buy that.');
            return;
        }
        if (row.when != null && !evalWhen(session, row.when)) {
            this.say(session, side === 'buy' ? 'I cannot sell you that.' : 'I cannot buy that.');
            return;
        }
        if (side === 'buy') {
            if (row.buy < 1) {
                this.say(session, 'I do not sell that.');
                return;
            }
            const cost = row.buy * count;
            if (!this.canGiveItem(session, row.itemId, count)) {
                this.say(session, 'You cannot carry that.');
                return;
            }
            if (!takeItem(session.inventory, shop.currency, cost, this.itemDb())) {
                this.say(session, 'You cannot afford that.');
                return;
            }
            this.tryGiveItem(session, row.itemId, count);
            session.send(S2C.ITEM_GAIN, encodeItemGain(row.itemId, count));
        } else {
            if (row.sell < 1) {
                this.say(session, 'I do not buy that.');
                return;
            }
            if (!takeItem(session.inventory, row.itemId, count, this.itemDb())) {
                this.say(session, 'Nothing to sell.');
                return;
            }
            const gained = row.sell * count;
            this.tryGiveItem(session, shop.currency, gained);
            session.send(S2C.ITEM_GAIN, encodeItemGain(shop.currency, gained));
        }
        this.sendInventory(session);
        this.sendShop(session, npc);
    }

    itemDb() {
        if (!this._itemDb) this._itemDb = itemDbFromPack(this.pack);
        return this._itemDb;
    }

    packFeature(name) {
        return !!(this.pack && this.pack.features && this.pack.features[name]);
    }

    canGiveItem(session, itemId, count) {
        const itemDb = this.itemDb();
        const item = findItem(itemDb, itemId);
        const n = Math.max(1, Math.floor(Number(count) || 1));
        const unit = item && item.weight != null ? Number(item.weight) || 0 : 0;
        const voc = session.character && session.character.vocation;
        if (!canCarryAdditional(session.level, totalCarriedWeight(session.inventory, itemDb), unit * n, voc)) {
            return false;
        }
        return canAddItemToInventory(session.inventory, itemId, n, itemDb);
    }

    tryGiveItem(session, itemId, count) {
        const itemDb = this.itemDb();
        const n = Math.max(1, Math.floor(Number(count) || 1));
        const item = findItem(itemDb, itemId);
        const unit = item && item.weight != null ? Number(item.weight) || 0 : 0;
        const voc = session.character && session.character.vocation;
        if (!canCarryAdditional(session.level, totalCarriedWeight(session.inventory, itemDb), unit * n, voc)) {
            return false;
        }
        const r = addItemToInventory(session.inventory, itemId, n, itemDb);
        return !!(r && r.ok !== false);
    }

    refreshLoadout(session) {
        applyPlayerLoadout(session, this.itemDb());
        recomputeDerived(session);
        this.sendInventory(session);
    }

    applyEquip(session, intent) {
        const body = decodeEquip(intent.payload);
        if (!body) {
            session.malformed();
            return;
        }
        if (!ownsContainer(session.inventory, body.containerId)) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        const uid = resolveLocationUid(session.inventory, {
            kind: 'container',
            containerUid: body.containerId,
            index: body.index
        });
        if (!uid) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        const slot = body.slot ? designerSlotToEngine(body.slot) : null;
        const r = equipItem(session.inventory, uid, this.itemDb(), slot);
        if (!r.ok) {
            this.say(session, r.error === 'not_equippable' || r.error === 'wrong_slot'
                ? 'You cannot equip that.'
                : r.error === 'no_room' || r.error === 'full'
                    ? 'You cannot carry that.'
                    : 'You cannot do that.');
            return;
        }
        this.refreshLoadout(session);
    }

    applyUnequip(session, intent) {
        const slotName = decodeUnequip(intent.payload);
        if (!slotName) {
            session.malformed();
            return;
        }
        const slot = designerSlotToEngine(slotName);
        const r = unequipItem(session.inventory, slot, this.itemDb());
        if (!r.ok) {
            this.say(session, r.error === 'full' || r.error === 'cycle'
                ? 'You cannot carry that.'
                : 'You cannot do that.');
            return;
        }
        this.refreshLoadout(session);
    }

    applyMoveItem(session, intent) {
        const body = decodeMoveItem(intent.payload);
        if (!body || !body.from || !body.to) {
            session.malformed();
            return;
        }
        if (body.from.kind === 'container' && !ownsContainer(session.inventory, body.from.containerUid)) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        if (body.to.kind === 'container' && !ownsContainer(session.inventory, body.to.containerUid)) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        const r = moveItem(session.inventory, body.from, body.to, this.itemDb());
        if (!r.ok) {
            this.say(session, r.error === 'full' || r.error === 'no_room' || r.error === 'cycle'
                ? 'You cannot carry that.'
                : 'You cannot do that.');
            return;
        }
        this.refreshLoadout(session);
    }

    applyOpenBag(session, intent) {
        const body = decodeContainerSlot(intent.payload);
        if (!body) {
            session.malformed();
            return;
        }
        if (!ownsContainer(session.inventory, body.containerId)) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        const uid = resolveLocationUid(session.inventory, {
            kind: 'container',
            containerUid: body.containerId,
            index: body.index
        });
        if (!uid || !session.inventory.containers[uid]) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        session.openBagUid = uid;
        this.sendInventory(session);
    }

    sendFieldsInView(session) {
        const vp = this.viewportOf(session);
        const list = listFieldsInRect(
            this.fieldStore, vp.originX, vp.originY, session.z, vp.width, vp.height
        );
        for (let i = 0; i < list.length; i++) {
            session.send(S2C.FIELD, encodeField(list[i]));
        }
    }

    broadcastField(field) {
        if (!field) return;
        const buf = encodeField(field);
        this.broadcastToViewers(field.x, field.y, field.z, (p) => {
            p.send(S2C.FIELD, buf);
        });
    }

    broadcastFieldGone(x, y, z) {
        const buf = encodeFieldGone(x, y, z);
        this.broadcastToViewers(x, y, z, (p) => {
            p.send(S2C.FIELD_GONE, buf);
        });
    }

    broadcastCastFx(fx, includeSelf) {
        if (!fx) return;
        const buf = encodeCastFx(fx);
        this.broadcastToViewers(fx.x, fx.y, fx.z, (p) => {
            p.send(S2C.CAST, buf);
        }, includeSelf);
    }

    applyFieldHit(entity, result, tickIndex) {
        if (!entity || !result) return;
        if (result.damage > 0) {
            this.applyDamage(entity, result.damage, result.element || 'physical', tickIndex, null);
        }
    }

    livingCombatants() {
        const out = [];
        for (const p of this.players.values()) {
            if (!p.dead && !p.downed && (p.hp | 0) > 0) out.push(p);
        }
        for (const cr of this.activeCreatures) {
            if ((cr.hp | 0) > 0 && !cr.simSleeping) out.push(cr);
        }
        return out;
    }

    _applyConditionHpDelta(ent, amount, element) {
        if (element === 'healing') {
            this.applyHp(ent, (ent.hp | 0) + Math.abs(amount | 0));
            this.broadcastStats(ent);
            return;
        }
        this.applyDamage(ent, amount, element, this._tickIndex, null);
    }

    tickCombatantConditions(ent, dt) {
        if (ent.conditions && ent.conditions.length > 0) {
            const cond = tickConditions(ent, dt, this._conditionHooks);
            if (cond.ticks && cond.ticks.length) this.broadcastStats(ent);
        }
    }

    applyRegenDeltas(entity, hpDelta, mpDelta) {
        if (!entity) return false;
        const hpAdd = Math.floor(Number(hpDelta) || 0);
        const mpAdd = Math.floor(Number(mpDelta) || 0);
        if (!(hpAdd > 0) && !(mpAdd > 0)) return false;
        const beforeHp = entity.hp | 0;
        const beforeMp = entity.mp | 0;
        if (hpAdd > 0) this.applyHp(entity, beforeHp + hpAdd);
        if (mpAdd > 0) this.applyMp(entity, beforeMp + mpAdd);
        if ((entity.hp | 0) === beforeHp && (entity.mp | 0) === beforeMp) return false;
        this.broadcastStats(entity);
        return true;
    }

    tickPlayerRegen(session) {
        if (!session || session.simSleeping) return;
        if (session.dead || session.downed || (session.hp | 0) <= 0) return;
        const cls = classRow(this.pack, session.vocation || (session.character && session.character.vocation));
        const rates = nativeRegenRates(cls, !!(session.promoted || (session.character && session.character.promoted)));
        const intervals = regenIntervalTicks(this.settings, playerInEngage(session, this));
        const native = tickNativeRegen(session, rates, intervals);
        const itemDb = this.itemDb();
        const ups = (this.settings.logicUps | 0) || 20;
        const gear = tickEquippedItemRegen(session.inventory, itemDb, ups);
        this.applyRegenDeltas(session, native.hpDelta + gear.hpDelta, native.mpDelta + gear.mpDelta);
    }

    tickPlayerDurationItems(session) {
        if (!session || session.dead || session.downed) return;
        const itemDb = this.itemDb();
        const ups = (this.settings.logicUps | 0) || 20;
        const tick = tickEquippedDurations(session.inventory, itemDb, ups);
        if (!tick.expiredUids.length) return;
        for (let i = 0; i < tick.expiredUids.length; i++) {
            const uid = tick.expiredUids[i];
            const inst = session.inventory.items[uid];
            const item = inst ? findItem(itemDb, inst.itemId) : null;
            const label = item && item.label ? item.label : (inst && inst.itemId) || 'item';
            destroyItem(session.inventory, uid, itemDb);
            this.say(session, 'Your ' + label + ' has decayed.');
        }
        this.refreshLoadout(session);
    }

    tickCombatStatus(tickIndex) {
        const dt = 1 / ((this.settings.logicUps | 0) || 20);
        const now = this.logicNow(tickIndex);
        for (const p of this.players.values()) {
            if (p.dead || p.downed || (p.hp | 0) <= 0) continue;
            this.tickCombatantConditions(p, dt);
            this.tickPlayerRegen(p);
            this.tickPlayerDurationItems(p);
        }
        for (const cr of this.activeCreatures) {
            if ((cr.hp | 0) <= 0 || cr.simSleeping) continue;
            this.tickCombatantConditions(cr, dt);
        }
        const gone = purgeExpiredFields(
            this.fieldStore,
            now,
            (x, y, z) => this.tileMap.getCombatantEntities(x, y, z)
        );
        for (let i = 0; i < gone.length; i++) {
            this.broadcastFieldGone(gone[i].x, gone[i].y, gone[i].z);
        }
        this.tickDelayedCasts(tickIndex);
    }

    enqueueDelayedCast(entry) {
        if (!entry) return;
        const ups = (this.settings.logicUps | 0) || 20;
        if (entry.readyTick == null && entry.readyAt != null) {
            entry.readyTick = Math.round(Number(entry.readyAt) * ups);
        }
        entry.readyTick = entry.readyTick | 0;
        if (Object.prototype.hasOwnProperty.call(entry, 'readyAt')) {
            delete entry.readyAt;
        }
        let low = 0;
        let high = this.delayedCasts.length;
        const target = entry.readyTick;
        while (low < high) {
            const mid = (low + high) >>> 1;
            const midVal = this.delayedCasts[mid]
                ? (this.delayedCasts[mid].readyTick | 0)
                : 0;
            if (midVal <= target) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        this.delayedCasts.splice(low, 0, entry);
    }

    tickDelayedCasts(tickIndex) {
        if (!this.delayedCasts.length) return;
        const tick = tickIndex | 0;
        while (this.delayedCasts.length > 0) {
            const head = this.delayedCasts[0];
            if (!head) {
                this.delayedCasts.shift();
                continue;
            }
            if ((head.readyTick | 0) > tick) {
                break;
            }
            this.delayedCasts.shift();
            const caster = this.getEntity(head.casterId);
            if (!caster || !isCombatantAlive(caster)) continue;
            this.runCast(caster, head.spell, {
                target: null,
                aim: head.center,
                tickIndex: tick,
                detonate: true,
                skipMana: true,
                skipCooldown: true,
                skipMoveLock: true
            });
        }
    }

    applyCastIntent(session, intent, tickIndex) {
        const body = decodeCast(intent.payload);
        if (!body) {
            session.malformed();
            return;
        }
        const spell = findSpell(this.spellBook, body.spellId);
        if (!spell) {
            this.say(session, 'You cannot cast that.');
            return;
        }
        const selfCast = isSelfTargetSpell(spell);
        const target = selfCast
            ? session
            : (body.targetId ? this.getEntity(body.targetId) : this.getEntity(session.targetId));
        const aim = selfCast
            ? { x: session.x | 0, y: session.y | 0, z: session.z | 0 }
            : { x: body.x | 0, y: body.y | 0, z: body.z | 0 };
        this.runCast(session, spell, { target, aim, tickIndex, seq: intent.seq });
    }

    runCast(attacker, spell, opts) {
        const o = opts || {};
        const tickIndex = o.tickIndex | 0;
        const runeOn = this.featureFlag('runeConsumption', true) || this.packFeature('runeConsumption');
        const result = resolveCast({
            attacker,
            spell,
            target: o.target || null,
            aim: o.aim || null,
            tileMap: this.tileMap,
            fieldStore: this.fieldStore,
            rng: this.rng,
            now: this.logicNow(tickIndex),
            tickIndex,
            logicUps: (this.settings.logicUps | 0) || 20,
            skipMana: !!o.skipMana,
            skipCooldown: !!o.skipCooldown,
            skipMoveLock: !!o.skipMoveLock,
            detonate: !!o.detonate,
            runeConsumption: runeOn,
            hasRune: (ent, sp) => {
                if (!isRuneSpell(sp)) return true;
                const id = sp.runeItemId;
                if (!id) return true;
                return countItem(ent.inventory, id) >= 1;
            },
            consumeRune: (ent, sp) => {
                if (!isRuneSpell(sp) || !runeOn) return;
                const id = sp.runeItemId;
                if (!id || !ent.inventory) return;
                consumeItemIdFromInventory(ent.inventory, id, 1);
                if (ent.type === 'player') this.sendInventory(ent);
            },
            candidates: (spell && spell.chain) ? this.livingCombatants() : undefined
        });
        if (!result.ok) {
            const text = sayForReason(result.reason);
            if (text && attacker.type === 'player') this.say(attacker, text);
            else if (attacker.type === 'player' && o.seq != null) {
                if (result.reason === 'busy') attacker.reject(o.seq, REASON.BUSY);
                else if (result.reason === 'out_of_range') attacker.reject(o.seq, REASON.OUT_OF_RANGE);
                else if (result.reason === 'no_target') attacker.reject(o.seq, REASON.NO_TARGET);
                else if (result.reason === 'no_cast' || result.reason === 'not_tile_controller') {
                    attacker.reject(o.seq, REASON.BLOCKED);
                }
            }
            return result;
        }
        if (result.delayed) {
            const ups = (this.settings.logicUps | 0) || 20;
            const delaySec = Number(result.delayed.delaySec) || 0;
            const delayTicks = Math.max(1, Math.round(delaySec * ups));
            this.enqueueDelayedCast({
                casterId: attacker.id,
                spell,
                center: result.delayed.center,
                readyTick: (tickIndex | 0) + delayTicks
            });
        }
        const lock = result.moveLock || 0;
        if (lock > 0) {
            const extra = delayToTicks(lock, this.settings.logicUps);
            attacker.moveReadyTick = Math.max(attacker.moveReadyTick | 0, tickIndex + extra);
        }
        if (result.manaSpent > 0 && attacker.type === 'player' && this.featureFlag('skillProgression')) {
            const ml = applyManaTowardMagic(attacker, result.manaSpent, {
                skillProgression: true,
                vocationRates: attacker.skillRates
            });
            if (ml.levelsGained > 0) {
                this.sendSkills(attacker);
                this.say(attacker, 'Your magic skill increased to ' + ml.newLevel + '.');
            }
        }
        if (attacker.type === 'player') {
            attacker.send(S2C.STATS, encodeStats(attacker));
        }
        const fxTarget = o.target || attacker;
        this.broadcastCastFx({
            sourceId: attacker.id,
            spellId: spell.id,
            targetId: fxTarget && fxTarget.id || 0,
            x: (result.center && result.center.x) || attacker.x,
            y: (result.center && result.center.y) || attacker.y,
            z: (result.center && result.center.z) || attacker.z,
            flags: 0
        }, attacker);
        for (let i = 0; i < result.fields.length; i++) this.broadcastField(result.fields[i]);
        for (let i = 0; i < result.purged.length; i++) {
            this.broadcastFieldGone(result.purged[i].x, result.purged[i].y, result.purged[i].z);
        }
        for (let i = 0; i < result.hits.length; i++) {
            const row = result.hits[i];
            if (!row || !row.defender || !row.result) continue;
            const def = row.defender;
            const hit = row.result;
            let amount = 0;
            let flags = 0;
            if (hit.miss) {
                flags |= SWING_MISS;
            } else if (hit.element === 'healing') {
                this.applyHp(def, (def.hp | 0) + (hit.final | 0));
                amount = hit.final | 0;
            } else if (hit.field) {
                amount = this.applyDamage(def, hit.final, hit.element, tickIndex, attacker);
            } else {
                amount = this.applyDamage(def, hit.final, hit.element, tickIndex, attacker);
                if (amount > 0 && attacker.type === 'player' && spellCanCritOrLeech(spell)) {
                    this.applyAttackLeech(attacker, amount);
                }
                if (hit.critical) flags |= SWING_CRIT;
                if (hit.fatal) flags |= SWING_FATAL;
                if ((def.hp | 0) <= 0) flags |= SWING_DEATH;
            }
            if (!hit.field && def !== attacker) {
                this.broadcastSwing(attacker, def, amount, flags, hit);
            } else {
                this.broadcastStats(def);
            }
            if (!hit.miss && def.type === 'creature' && !def.targetId && attacker.type === 'player') {
                def.targetId = attacker.id;
            }
        }
        return result;
    }

    applyUseItem(session, intent) {
        const body = decodeContainerSlot(intent.payload);
        if (!body) {
            session.malformed();
            return;
        }
        if (!ownsContainer(session.inventory, body.containerId)) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        const uid = resolveLocationUid(session.inventory, {
            kind: 'container',
            containerUid: body.containerId,
            index: body.index
        });
        if (!uid) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        const inst = session.inventory.items[uid];
        if (!inst) {
            session.reject(intent.seq, REASON.NO_TARGET);
            return;
        }
        const itemDb = this.itemDb();
        const item = findItem(itemDb, inst.itemId);
        if (itemIsContainer(item) && session.inventory.containers[uid]) {
            session.openBagUid = uid;
            this.sendInventory(session);
            return;
        }
        const effect = resolveItemUseEffect(item);
        if (effect.known || itemIsUsable(item)) {
            if (!consumeInstanceCount(session.inventory, uid, 1, itemDb)) {
                this.say(session, 'You cannot use that.');
                return;
            }
            applyItemUseEffect(session, effect, { rng: this.rng });
            this.sendInventory(session);
            session.send(S2C.STATS, encodeStats(session));
            return;
        }
        if (itemIsRune(item)) {
            const spell = findSpellByRuneItem(this.spellBook, inst.itemId);
            if (!spell) {
                this.say(session, 'You cannot use that.');
                return;
            }
            const target = this.getEntity(session.targetId);
            this.runCast(session, spell, {
                target,
                aim: target ? { x: target.x, y: target.y, z: target.z } : { x: session.x, y: session.y, z: session.z },
                tickIndex: this._tickIndex
            });
            return;
        }
        if (itemIsEquipable(item)) {
            const r = equipItem(session.inventory, uid, itemDb, null);
            if (!r.ok) {
                this.say(session, r.error === 'not_equippable'
                    ? 'You cannot equip that.'
                    : r.error === 'no_room' || r.error === 'full'
                        ? 'You cannot carry that.'
                        : 'You cannot do that.');
                return;
            }
            this.refreshLoadout(session);
            return;
        }
        this.say(session, 'You cannot use that.');
    }
}

module.exports = { World, CREATURE_ID_BASE, CORPSE_ID_BASE };

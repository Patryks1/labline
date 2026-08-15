/**
 * Async save format v5.
 *
 * Compact worlds persist only their deterministic descriptor and sparse
 * dynamic snapshot. Static typed layers, indexes, metrics, journals, and any
 * renderer state are regenerated after load.
 */
import type {
  MapCity,
  MapRegion,
  MapTile,
  Model,
  ModelFinanceRow,
  RackDesign,
  SimState,
} from './types'
import { calendarForDay, formatCampaignDate } from './campaign'
import { DEMAND_MODEL_VERSION, ECONOMY, WORLD_POPULATION } from './balance/economy'
import { normalizeModelEvaluations } from './balance/evaluationSuites'
import { scoreDesign } from './balance/racks'
import {
  createWorldMarkets,
  syncLabIndex,
  syncLabIndexForPersistence,
} from './systems/labEngine'
import { normalizeSiteEnergyState } from './systems/siteEnergy'
import { clampSegmentUsageIntensity } from './systems/events'
import {
  WORLD_FORMAT_VERSION,
  createDynamicWorld,
  regenerateStaticWorld,
  type DynamicWorldSnapshotV2,
  type StaticWorld,
} from './world'

export const SAVE_FORMAT = 'labline-save' as const
export const SAVE_VERSION = 5 as const
export const V1_INCOMPATIBILITY_REASON =
  'Save format v1 is incompatible with the compact-world renderer. This campaign cannot be migrated; start a new operation.'
export const V2_INCOMPATIBILITY_REASON =
  'Save format v2 uses the retired split player/rival simulation. It remains stored but cannot be loaded in Simulation v3; start a new operation.'
export const V3_INCOMPATIBILITY_REASON =
  'Save format v3 uses the short-run economy and cannot be converted into the 2026–2036 campaign. Its valid rack blueprints may still be imported into the profile library.'

export type SaveSlotId = 'auto' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8'

export const SAVE_SLOTS: SaveSlotId[] = ['auto', '1', '2', '3', '4', '5', '6', '7', '8']
export const MANUAL_SLOTS: SaveSlotId[] = ['1', '2', '3', '4', '5', '6', '7', '8']

const LEGACY_INDEX_KEY = 'labline.saves.index'
const legacySlotKey = (id: SaveSlotId) => `labline.saves.${id}`
const DATABASE_NAME = 'labline-saves-v2'
const DATABASE_VERSION = 1
const SLOT_STORE = 'slots'

export interface SaveMeta {
  slotId: SaveSlotId
  labName: string
  day: number
  difficulty: string
  seed: number
  cash: number
  valuation: number
  outcome: string
  savedAt: string
  /** Calendar date inside the sandbox at the moment it was saved. */
  campaignDate?: string
  companyMark?: import('./balance/gameConfig').CompanyMarkId
  version: number
  compatible: boolean
  incompatibilityReason?: string
}

interface PersistedCompactMap {
  width: number
  height: number
  storage: 'compact'
  energyPricePerMWh: number
  activeRegionId: string
  /** Includes dynamic talent pools in addition to city population. */
  cities: MapCity[]
}

interface PersistedLegacyMap {
  width: number
  height: number
  storage: 'legacy'
  tiles: MapTile[]
  regions: MapRegion[]
  energyPricePerMWh: number
  activeRegionId: string
  cities?: MapCity[]
}

type PersistedSimState = Omit<SimState, 'map'> & {
  map: PersistedCompactMap | PersistedLegacyMap
}

export interface SaveFile {
  format: typeof SAVE_FORMAT
  version: typeof SAVE_VERSION
  /** Campaign balance/content identity is immutable for the life of a save. */
  contentPackId: string
  meta: SaveMeta
  state: PersistedSimState
  /** Null for v2 saves of legacy small maps. */
  world: DynamicWorldSnapshotV2 | null
}

export interface LoadedSaveFile extends Omit<SaveFile, 'state'> {
  state: SimState
}

export type SaveErrorCode =
  | 'corrupt'
  | 'incompatible-version'
  | 'newer-version'
  | 'not-found'
  | 'quota'
  | 'storage'

export class SaveError extends Error {
  readonly code: SaveErrorCode

  constructor(message: string, code: SaveErrorCode = 'corrupt') {
    super(message)
    this.name = 'SaveError'
    this.code = code
  }
}

interface StoredSaveRecord {
  slotId: SaveSlotId
  meta: SaveMeta
  file: SaveFile
}

type LegacySaveIndex = {
  slots?: Partial<Record<SaveSlotId, Partial<SaveMeta> | null>>
}

const memoryRecords = new Map<SaveSlotId, StoredSaveRecord>()
let databasePromise: Promise<IDBDatabase | null> | null = null

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) return Promise.resolve(null)
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve) => {
    let settled = false
    const finish = (database: IDBDatabase | null) => {
      if (settled) return
      settled = true
      resolve(database)
    }
    try {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(SLOT_STORE)) {
          database.createObjectStore(SLOT_STORE, { keyPath: 'slotId' })
        }
      }
      request.onsuccess = () => finish(request.result)
      request.onerror = () => finish(null)
      request.onblocked = () => finish(null)
    } catch {
      finish(null)
    }
  })
  return databasePromise
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'))
  })
}

async function putRecord(record: StoredSaveRecord): Promise<void> {
  const database = await openDatabase()
  if (!database) {
    memoryRecords.set(record.slotId, record)
    return
  }
  const transaction = database.transaction(SLOT_STORE, 'readwrite')
  transaction.objectStore(SLOT_STORE).put(record)
  await transactionDone(transaction)
}

async function getRecord(slotId: SaveSlotId): Promise<StoredSaveRecord | undefined> {
  const database = await openDatabase()
  if (!database) return memoryRecords.get(slotId)
  const transaction = database.transaction(SLOT_STORE, 'readonly')
  const done = transactionDone(transaction)
  const value = await requestValue(
    transaction.objectStore(SLOT_STORE).get(slotId) as IDBRequest<StoredSaveRecord | undefined>,
  )
  await done
  return value
}

async function getAllRecords(): Promise<StoredSaveRecord[]> {
  const database = await openDatabase()
  if (!database) return [...memoryRecords.values()]
  const transaction = database.transaction(SLOT_STORE, 'readonly')
  const done = transactionDone(transaction)
  const values = await requestValue(
    transaction.objectStore(SLOT_STORE).getAll() as IDBRequest<StoredSaveRecord[]>,
  )
  await done
  return values
}

async function removeRecord(slotId: SaveSlotId): Promise<void> {
  memoryRecords.delete(slotId)
  const database = await openDatabase()
  if (!database) return
  const transaction = database.transaction(SLOT_STORE, 'readwrite')
  transaction.objectStore(SLOT_STORE).delete(slotId)
  await transactionDone(transaction)
}

function legacyStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function legacyMeta(): SaveMeta[] {
  const storage = legacyStorage()
  if (!storage) return []
  try {
    const raw = storage.getItem(LEGACY_INDEX_KEY)
    if (!raw) return []
    const index = JSON.parse(raw) as LegacySaveIndex
    const result: SaveMeta[] = []
    for (const slotId of SAVE_SLOTS) {
      const meta = index.slots?.[slotId]
      if (!meta) continue
      result.push({
        slotId,
        labName: typeof meta.labName === 'string' ? meta.labName : 'Legacy campaign',
        day: typeof meta.day === 'number' ? meta.day : 0,
        difficulty: typeof meta.difficulty === 'string' ? meta.difficulty : 'unknown',
        seed: typeof meta.seed === 'number' ? meta.seed : 0,
        cash: typeof meta.cash === 'number' ? meta.cash : 0,
        valuation: typeof meta.valuation === 'number' ? meta.valuation : 0,
        outcome: typeof meta.outcome === 'string' ? meta.outcome : 'unknown',
        savedAt: typeof meta.savedAt === 'string' ? meta.savedAt : new Date(0).toISOString(),
        version: 1,
        compatible: false,
        incompatibilityReason: V1_INCOMPATIBILITY_REASON,
      })
    }
    return result
  } catch {
    return []
  }
}

/** Test helper: wipe IndexedDB, memory fallback, and legacy localStorage slots. */
export async function clearAllSaves(): Promise<void> {
  memoryRecords.clear()
  const storage = legacyStorage()
  if (storage) {
    try {
      for (const id of SAVE_SLOTS) storage.removeItem(legacySlotKey(id))
      storage.removeItem(LEGACY_INDEX_KEY)
    } catch {
      // Storage cleanup is best effort in private mode.
    }
  }
  if (!hasIndexedDb()) return
  const database = await databasePromise
  database?.close()
  databasePromise = null
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DATABASE_NAME)
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
      request.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}

function jsonClone<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested === 'number' && !Number.isFinite(nested)) {
        if (nested === Infinity) return null
        if (nested === -Infinity) return '$-Infinity'
        return null
      }
      return nested
    }),
  ) as T
}

function compactPersistedState(state: SimState): PersistedSimState {
  const { map, ...simulation } = state
  if (map.storage === 'compact' && map.world) {
    return {
      ...simulation,
      map: {
        width: map.width,
        height: map.height,
        storage: 'compact',
        energyPricePerMWh: map.energyPricePerMWh,
        activeRegionId: map.activeRegionId,
        cities: map.cities?.map((city) => ({ ...city })) ?? [],
      },
    }
  }
  return {
    ...simulation,
    map: {
      width: map.width,
      height: map.height,
      storage: 'legacy',
      tiles: map.tiles,
      regions: map.regions,
      energyPricePerMWh: map.energyPricePerMWh,
      activeRegionId: map.activeRegionId,
      cities: map.cities,
    },
  }
}

/** Public sanitization helper retained for tests/export tooling. */
export function sanitizeState(state: SimState): SimState {
  return jsonClone(compactPersistedState(state)) as unknown as SimState
}

function reviveInfinities(value: unknown, path = ''): unknown {
  if (value === null) return path.endsWith('.runwayDays') ? Infinity : value
  if (value === '$-Infinity') return -Infinity
  if (Array.isArray(value)) {
    return value.map((nested, index) => reviveInfinities(nested, `${path}[${index}]`))
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = reviveInfinities(nested, path ? `${path}.${key}` : key)
    }
    return result
  }
  return value
}

function ensureArray<T>(value: unknown, fallback: T[] = []): T[] {
  return Array.isArray(value) ? (value as T[]) : fallback
}

function ensureRecord(value: unknown): Record<string, number> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, number>)
    : {}
}

function regionsFromStatic(world: StaticWorld): MapRegion[] {
  return world.regions.map((region) => ({
    id: region.id,
    name: region.name,
    originX: region.originX,
    originY: region.originY,
    width: region.width,
    height: region.height,
    energyPriceMult: region.energyPriceMult,
    latencyToMarket: region.latencyToMarket,
    regulationRisk: region.regulationRisk,
  }))
}

function validateBaseState(raw: unknown): PersistedSimState {
  if (!raw || typeof raw !== 'object') throw new SaveError('Save data is empty or corrupt.')
  const state = reviveInfinities(raw) as PersistedSimState
  if (typeof state.seed !== 'number' || typeof state.day !== 'number') {
    throw new SaveError('Save is missing seed/day.')
  }
  if (!state.player || typeof state.player !== 'object') {
    throw new SaveError('Save is missing player state.')
  }
  if (!state.map || typeof state.map !== 'object') {
    throw new SaveError('Save is missing map state.')
  }
  return state
}

function restoreState(stateRaw: unknown, snapshot: DynamicWorldSnapshotV2 | null): SimState {
  const state = validateBaseState(stateRaw)
  let map: SimState['map']
  if (state.map.storage === 'compact') {
    if (!snapshot || snapshot.formatVersion !== WORLD_FORMAT_VERSION) {
      throw new SaveError('Compact save is missing its v2 world snapshot.')
    }
    if (
      snapshot.descriptor.seed !== state.seed ||
      snapshot.descriptor.width !== state.map.width ||
      snapshot.descriptor.height !== state.map.height
    ) {
      throw new SaveError('Compact world descriptor does not match the saved campaign.')
    }
    let staticWorld: StaticWorld
    try {
      staticWorld = regenerateStaticWorld(snapshot.descriptor)
    } catch (error) {
      throw new SaveError(
        error instanceof Error ? `Could not regenerate compact world: ${error.message}` : 'Could not regenerate compact world.',
      )
    }
    if (staticWorld.staticHash !== snapshot.staticHash) {
      throw new SaveError(
        'Compact world hash does not match this build. The save cannot be loaded safely.',
        'incompatible-version',
      )
    }
    const world = createDynamicWorld(staticWorld, {
      terrainOverrides: snapshot.terrainOverrides,
      facilities: snapshot.facilities,
      cities: snapshot.cities,
    })
    if (!Array.isArray(state.map.cities)) {
      throw new SaveError('Compact save is missing city runtime state.')
    }
    map = {
      width: snapshot.descriptor.width,
      height: snapshot.descriptor.height,
      storage: 'compact',
      world,
      worldRevision: world.revision,
      tiles: [],
      regions: regionsFromStatic(staticWorld),
      energyPricePerMWh: state.map.energyPricePerMWh,
      activeRegionId: state.map.activeRegionId,
      cities: state.map.cities,
    }
  } else {
    if (!Array.isArray(state.map.tiles) || !Array.isArray(state.map.regions)) {
      throw new SaveError('Legacy-map v2 save is missing map tiles or regions.')
    }
    map = {
      ...state.map,
      storage: 'legacy',
      tiles: state.map.tiles,
      regions: state.map.regions,
    }
  }

  const restored = { ...state, map } as SimState
  // Old campaigns may persist a spot price from the earlier, cheaper energy
  // economy. Bring them onto the current industrial-power floor immediately
  // instead of waiting for the first map tick.
  restored.map.energyPricePerMWh = Math.max(
    Number.isFinite(restored.map.energyPricePerMWh)
      ? restored.map.energyPricePerMWh
      : ECONOMY.energyBasePrice,
    ECONOMY.energyBasePrice * 0.7,
  )
  if (
    !restored.industryDataPack ||
    restored.industryDataPack.id !== restored.config.campaignRules.contentPackId
  ) {
    throw new SaveError(
      'Save is missing its pinned industry data-pack snapshot.',
      'incompatible-version',
    )
  }
  restored.player.rackFleet = ensureArray(restored.player.rackFleet)
  restored.player.loans = ensureArray(restored.player.loans)
  restored.player.models = ensureArray(restored.player.models).map((model) =>
    normalizeModelEvaluations(model as Model),
  )
  restored.player.safetyCampaign = restored.player.safetyCampaign ?? null
  restored.player.researchUnlocked = ensureArray(restored.player.researchUnlocked)
  restored.player.researchQueue = ensureArray(restored.player.researchQueue)
  restored.player.chips = ensureArray(restored.player.chips)
  restored.rivals = (ensureArray(restored.rivals) as SimState['rivals']).map((rival) => ({
    ...rival,
    models: (ensureArray(rival.models) as Model[]).map((model) => normalizeModelEvaluations(model)),
  }))
  restored.computeLeases = ensureArray(restored.computeLeases)
  restored.computeContracts = ensureArray(restored.computeContracts)
  restored.cityPowerContracts = ensureArray(restored.cityPowerContracts)
  restored.powerExportContracts = ensureArray(restored.powerExportContracts)
  restored.siteProjects = ensureArray(restored.siteProjects)
  restored.siteCapacities = ensureArray(restored.siteCapacities)
  restored.energyContracts = ensureArray(restored.energyContracts)
  restored.regionInterconnections = ensureArray(restored.regionInterconnections)
  restored.segments = ensureArray(restored.segments)
  if (restored.lastMarket) {
    const legacyDirect = Math.max(0, restored.lastMarket.apiDayCogs ?? 0)
    restored.lastMarket = {
      ...restored.lastMarket,
      apiDayDirectCogs: Math.max(
        0,
        restored.lastMarket.apiDayDirectCogs ?? legacyDirect,
      ),
      apiDayAllocatedOps: Math.max(0, restored.lastMarket.apiDayAllocatedOps ?? 0),
      modelFinance: ensureArray<ModelFinanceRow>(restored.lastMarket.modelFinance).map((row) => {
        const direct = Math.max(0, row.dayApiDirectCogs ?? row.dayApiCogs ?? 0)
        return {
          ...row,
          dayApiDirectCogs: direct,
          dayApiAllocatedOps: Math.max(0, row.dayApiAllocatedOps ?? 0),
          dayApiContribution: row.dayApiContribution ?? row.dayApiRevenue - direct,
          apiCapacityUtilization: Math.max(0, row.apiCapacityUtilization ?? 0),
        }
      }),
    }
  }
  const restoredAudience = restored.segments.reduce(
    (sum, segment) => sum + Math.max(0, segment.size),
    0,
  )
  if (restoredAudience > WORLD_POPULATION) {
    const audienceScale = WORLD_POPULATION / restoredAudience
    restored.segments = restored.segments.map((segment) => ({
      ...segment,
      size: Math.max(0, segment.size) * audienceScale,
    }))
  }
  const priorUsageWeight = restored.segments.reduce(
    (sum, segment) => sum + Math.max(0, segment.size) * Math.max(0, segment.usageIntensity),
    0,
  )
  restored.segments = restored.segments.map((segment) => ({
    ...segment,
    usageIntensity: clampSegmentUsageIntensity(segment.id, segment.usageIntensity),
  }))
  const normalizedUsageWeight = restored.segments.reduce(
    (sum, segment) => sum + Math.max(0, segment.size) * Math.max(0, segment.usageIntensity),
    0,
  )
  const usageRepairScale =
    priorUsageWeight > 0
      ? Math.max(0, Math.min(1, normalizedUsageWeight / priorUsageWeight))
      : 1
  const demandModelRepairScale =
    restored.lastMarket?.demandModelVersion === DEMAND_MODEL_VERSION
      ? 1
      : ECONOMY.marketDailyActiveUsageShare
  const demandRepairScale = usageRepairScale * demandModelRepairScale
  if (demandRepairScale < 0.999 && restored.lastMarket) {
    const previousMarket = restored.lastMarket
    const playerDemandMTok = Math.max(0, previousMarket.playerDemandMTok * demandRepairScale)
    const servedMTok = Math.min(playerDemandMTok, previousMarket.servedMTok)
    const unservedRatio =
      playerDemandMTok > 0
        ? Math.max(0, 1 - Math.min(1, previousMarket.capacityMTok / playerDemandMTok))
        : 0
    const demandPf =
      previousMarket.capacityMTok > 0
        ? previousMarket.capacityPf * (playerDemandMTok / previousMarket.capacityMTok)
        : Math.max(0, previousMarket.demandPf * demandRepairScale)
    const playerShare = previousMarket.sharesByLab[restored.playerLabId] ?? 0
    const capacitySalesCapped = playerShare >= 0.5 && unservedRatio > 0.005
    restored.lastMarket = {
      ...previousMarket,
      demandModelVersion: DEMAND_MODEL_VERSION,
      demandMTok: Math.max(0, previousMarket.demandMTok * demandRepairScale),
      playerDemandMTok,
      servedMTok,
      unservedRatio,
      servicePain: Math.min(previousMarket.servicePain, unservedRatio),
      apiDemandMTok: Math.max(0, (previousMarket.apiDemandMTok ?? 0) * demandRepairScale),
      apiDayMTok: Math.min(
        previousMarket.apiDayMTok,
        Math.max(0, (previousMarket.apiDemandMTok ?? 0) * demandRepairScale),
      ),
      demandPf,
      servedPf: Math.min(
        demandPf,
        Math.max(0, previousMarket.capacityPf),
      ),
      industryDemandMTok: Math.max(
        0,
        (previousMarket.industryDemandMTok ?? previousMarket.demandMTok) * demandRepairScale,
      ),
      apiServeFrac: unservedRatio > 0 ? Math.max(0, 1 - unservedRatio) : 1,
      capacitySalesCapped,
      blockedApiMTok: capacitySalesCapped
        ? Math.max(0, (previousMarket.blockedApiMTok ?? 0) * demandRepairScale)
        : 0,
    }
    restored.player.servicePain = Math.min(restored.player.servicePain ?? 0, unservedRatio)
  }
  restored.alerts = ensureArray(restored.alerts)
  restored.news = ensureArray(restored.news)
  restored.activeEvents = ensureArray(restored.activeEvents)
  restored.financeHistory = ensureArray(restored.financeHistory)
  restored.financeMonthlyHistory = ensureArray(restored.financeMonthlyHistory)
  restored.externalities = restored.externalities ?? { accounts: {}, incidents: [] }
  restored.externalities.accounts =
    restored.externalities.accounts && typeof restored.externalities.accounts === 'object'
      ? restored.externalities.accounts
      : {}
  restored.externalities.incidents = ensureArray(restored.externalities.incidents)
  restored.benchmarkSeasons = ensureArray(restored.benchmarkSeasons)
  restored.evaluations = ensureArray(restored.evaluations)
  restored.reviews = ensureArray(restored.reviews)
  restored.eventCooldowns = ensureRecord(restored.eventCooldowns)
  restored.automation = restored.automation ?? {
    overflowCloud: {
      enabled: false,
      targetUtilization: 0.78,
      maxPf: 96,
      maxDailySpend: 180_000,
    },
    allocation: { enabled: false, inferenceHeadroom: 0.2 },
    dataProcessing: { enabled: false },
    fleetDeployment: { enabled: false, weeklyBudget: 2_500_000 },
    productCapacity: { enabled: false },
  }
  restored.playerLabId = restored.playerLabId || 'player'
  restored.worldMarkets = restored.worldMarkets ?? createWorldMarkets()
  // Older saves shipped with every auto-pause enabled and no UI to disable it.
  // Migrate that implicit behavior to the new opt-in preference model once.
  if (restored.config.campaignRules.autoPauseConfigured !== true) {
    restored.config = {
      ...restored.config,
      campaignRules: {
        ...restored.config.campaignRules,
        autoPauseConfigured: true,
        autoPause: {
          projectComplete: false,
          majorEvent: false,
          quarterlyReport: false,
          runwayEmergency: false,
        },
      },
    }
  }
  if (typeof restored.paused !== 'boolean') restored.paused = true
  if (
    restored.speed !== 0 &&
    restored.speed !== 1 &&
    restored.speed !== 2 &&
    restored.speed !== 5
  ) {
    restored.speed = 1
  }
  if (typeof restored.tick !== 'number') restored.tick = restored.day
  restored.calendar = calendarForDay(restored.day, restored.config.campaignRules)
  return syncLabIndex(normalizeSiteEnergyState(restored))
}

export function buildSaveMeta(
  state: SimState,
  slotId: SaveSlotId,
  savedAt = new Date().toISOString(),
): SaveMeta {
  return {
    slotId,
    labName: state.config?.labName || state.player.name || 'Labline',
    day: state.day,
    difficulty: state.config?.difficulty ?? 'normal',
    seed: state.seed,
    cash: state.player.cash,
    valuation: state.player.finance?.valuation ?? 0,
    outcome: state.victory?.outcome ?? 'playing',
    savedAt,
    campaignDate: formatCampaignDate(state.calendar),
    companyMark: state.config.companyMark,
    version: SAVE_VERSION,
    compatible: true,
  }
}

export function buildSaveFile(state: SimState, slotId: SaveSlotId): SaveFile {
  const synchronized = syncLabIndexForPersistence(state)
  const meta = buildSaveMeta(synchronized, slotId)
  const persisted = compactPersistedState(synchronized)
  const world = synchronized.map.storage === 'compact' && synchronized.map.world
    ? synchronized.map.world.toSnapshot()
    : null
  return jsonClone({
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    contentPackId: synchronized.config.campaignRules.contentPackId,
    meta,
    state: persisted,
    world,
  })
}

export function serializeSave(file: SaveFile): string {
  return JSON.stringify(file)
}

function validateSaveEnvelope(data: unknown): SaveFile {
  if (!data || typeof data !== 'object') throw new SaveError('Invalid save file.')
  const candidate = data as { format?: unknown; version?: unknown }
  if (candidate.format !== SAVE_FORMAT) throw new SaveError('Not a Labline save file.')
  if (typeof candidate.version !== 'number') throw new SaveError('Save is missing a version.')
  if (candidate.version === 1) {
    throw new SaveError(V1_INCOMPATIBILITY_REASON, 'incompatible-version')
  }
  if (candidate.version === 2) {
    throw new SaveError(V2_INCOMPATIBILITY_REASON, 'incompatible-version')
  }
  if (candidate.version === 3) {
    throw new SaveError(V3_INCOMPATIBILITY_REASON, 'incompatible-version')
  }
  if (candidate.version > SAVE_VERSION) {
    throw new SaveError(
      `Save version ${candidate.version} is newer than this build (supports ${SAVE_VERSION}).`,
      'newer-version',
    )
  }
  if (candidate.version !== SAVE_VERSION && candidate.version !== 4) {
    throw new SaveError(`Unsupported save version ${candidate.version}.`, 'incompatible-version')
  }
  const file = data as SaveFile
  if (!file.meta || !file.state) throw new SaveError('Save is missing metadata or simulation state.')
  if (
    !Number.isFinite(file.meta.day) ||
    file.meta.day < 1 ||
    typeof file.meta.labName !== 'string' ||
    !file.meta.labName.trim() ||
    typeof file.meta.savedAt !== 'string' ||
    Number.isNaN(Date.parse(file.meta.savedAt))
  ) {
    throw new SaveError('Save metadata is damaged (company, day, or timestamp is invalid).')
  }
  if (
    !Number.isFinite(file.state.day) ||
    file.state.day < 1 ||
    !file.state.player ||
    !file.state.map ||
    !file.state.config
  ) {
    throw new SaveError('Simulation state is incomplete (day, company, or world data is missing).')
  }
  const pinnedPack = file.state.config?.campaignRules?.contentPackId
  const snapshotPack = file.state.industryDataPack?.id
  if (
    !file.contentPackId ||
    !pinnedPack ||
    !snapshotPack ||
    file.contentPackId !== pinnedPack ||
    snapshotPack !== pinnedPack
  ) {
    throw new SaveError('Save content-pack identity is missing or does not match the campaign.', 'incompatible-version')
  }
  return file
}

export function inspectSaveCompatibility(data: unknown): {
  compatible: boolean
  reason?: string
} {
  try {
    validateSaveEnvelope(data)
    return { compatible: true }
  } catch (error) {
    return {
      compatible: false,
      reason: error instanceof SaveError ? error.message : 'Save validation failed.',
    }
  }
}

function parseSaveObject(data: unknown): LoadedSaveFile {
  const file = validateSaveEnvelope(data)
  return { ...file, state: restoreState(file.state, file.world) }
}

/**
 * V3 campaigns are never migrated, but reusable rack designs are safe to copy
 * into profile persistence after validating them against the current catalog.
 */
export function extractV3RackBlueprints(json: string): RackDesign[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const candidate = parsed as {
    format?: unknown
    version?: unknown
    state?: { player?: { rackDesigns?: unknown } }
  }
  if (candidate.format !== SAVE_FORMAT || candidate.version !== 3) return []
  if (!Array.isArray(candidate.state?.player?.rackDesigns)) return []
  const valid: RackDesign[] = []
  for (const raw of candidate.state.player.rackDesigns) {
    if (!raw || typeof raw !== 'object') continue
    const design = raw as RackDesign
    if (
      typeof design.id !== 'string' ||
      typeof design.name !== 'string' ||
      typeof design.chassisId !== 'string' ||
      !Array.isArray(design.placements)
    ) continue
    try {
      if (scoreDesign(design).valid) valid.push(design)
    } catch {
      // Retired or malformed modules are intentionally skipped.
    }
  }
  return valid
}

export function parseSave(json: string): LoadedSaveFile {
  try {
    return parseSaveObject(JSON.parse(json))
  } catch (error) {
    if (error instanceof SaveError) throw error
    throw new SaveError('Could not parse save file.')
  }
}

export async function listSaveSlots(): Promise<SaveMeta[]> {
  let records: StoredSaveRecord[]
  try {
    records = await getAllRecords()
  } catch {
    records = [...memoryRecords.values()]
  }
  const bySlot = new Map<SaveSlotId, SaveMeta>()
  for (const record of records) {
    if (!SAVE_SLOTS.includes(record.slotId)) continue
    const rawMeta = record.meta as Partial<SaveMeta> | null | undefined
    const version = record.file?.version ?? rawMeta?.version ?? 0
    const fallback: SaveMeta = {
      slotId: record.slotId,
      labName: typeof rawMeta?.labName === 'string' ? rawMeta.labName : 'Damaged save',
      day: typeof rawMeta?.day === 'number' ? rawMeta.day : 0,
      difficulty: typeof rawMeta?.difficulty === 'string' ? rawMeta.difficulty : 'unknown',
      seed: typeof rawMeta?.seed === 'number' ? rawMeta.seed : 0,
      cash: typeof rawMeta?.cash === 'number' ? rawMeta.cash : 0,
      valuation: typeof rawMeta?.valuation === 'number' ? rawMeta.valuation : 0,
      outcome: typeof rawMeta?.outcome === 'string' ? rawMeta.outcome : 'unknown',
      savedAt:
        typeof rawMeta?.savedAt === 'string' ? rawMeta.savedAt : new Date(0).toISOString(),
      campaignDate: rawMeta?.campaignDate,
      companyMark: rawMeta?.companyMark,
      version,
      compatible: false,
    }
    const inspection = inspectSaveCompatibility(record.file)
    if (inspection.compatible) {
      bySlot.set(record.slotId, {
        ...fallback,
        ...rawMeta,
        slotId: record.slotId,
        compatible: true,
        incompatibilityReason: undefined,
      })
    } else {
      bySlot.set(record.slotId, {
        ...fallback,
        compatible: false,
        incompatibilityReason: inspection.reason,
      })
    }
  }
  for (const meta of legacyMeta()) {
    if (!bySlot.has(meta.slotId)) bySlot.set(meta.slotId, meta)
  }
  return [...bySlot.values()].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
}

export async function hasAnySave(): Promise<boolean> {
  return (await listSaveSlots()).length > 0
}

export async function hasAutosave(): Promise<boolean> {
  return (await listSaveSlots()).some((meta) => meta.slotId === 'auto')
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  )
}

export async function writeSaveSlot(slotId: SaveSlotId, state: SimState): Promise<SaveMeta> {
  const file = buildSaveFile(state, slotId)
  const record: StoredSaveRecord = { slotId, meta: file.meta, file }
  try {
    await putRecord(record)
  } catch (error) {
    if (isQuotaError(error)) {
      throw new SaveError(
        'Save failed — browser storage is full. Delete an old slot and try again.',
        'quota',
      )
    }
    throw new SaveError(error instanceof Error ? error.message : 'Save failed.', 'storage')
  }
  return file.meta
}

export async function readSaveSlot(slotId: SaveSlotId): Promise<SimState> {
  let record: StoredSaveRecord | undefined
  try {
    record = await getRecord(slotId)
  } catch (error) {
    throw new SaveError(error instanceof Error ? error.message : 'Load failed.', 'storage')
  }
  if (record) return parseSaveObject(record.file).state

  const raw = legacyStorage()?.getItem(legacySlotKey(slotId))
  if (raw) return parseSave(raw).state
  throw new SaveError(`No save in slot ${slotId}.`, 'not-found')
}

export async function deleteSaveSlot(slotId: SaveSlotId): Promise<void> {
  try {
    await removeRecord(slotId)
    legacyStorage()?.removeItem(legacySlotKey(slotId))
    const storage = legacyStorage()
    const rawIndex = storage?.getItem(LEGACY_INDEX_KEY)
    if (storage && rawIndex) {
      const index = JSON.parse(rawIndex) as LegacySaveIndex
      if (index.slots) index.slots[slotId] = null
      storage.setItem(LEGACY_INDEX_KEY, JSON.stringify(index))
    }
  } catch (error) {
    throw new SaveError(error instanceof Error ? error.message : 'Delete failed.', 'storage')
  }
}

/** Return the newest compatible save, regardless of whether it was automatic or manual. */
export async function mostRecentSlotId(): Promise<SaveSlotId | null> {
  const saves = await listSaveSlots()
  if (saves.length === 0) return null
  const compatible = saves.filter((meta) => meta.compatible)
  return compatible[0]?.slotId ?? saves[0]!.slotId
}

/** In-memory serialization round trip; does not touch IndexedDB. */
export function roundTripState(state: SimState): SimState {
  const file = buildSaveFile(state, '1')
  return parseSave(serializeSave(file)).state
}

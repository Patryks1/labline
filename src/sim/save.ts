/**
 * Async save format v14.
 *
 * v13 player/rival records become `companies[id]`. Compatibility player, rivals
 * and labs remain projections during Stage A. Compact worlds persist only their
 * deterministic descriptor and sparse dynamic snapshot.
 *
 * Compact worlds persist only their deterministic descriptor and sparse
 * dynamic snapshot. Static typed layers, indexes, metrics, journals, and any
 * renderer state are regenerated after load.
 */
import type {
  ComputeWorkItem,
  CapitalStack,
  CloudProvider,
  ComputeContract,
  DataSupplierContract,
  MapCity,
  MapRegion,
  MapTile,
  Model,
  ModelFinanceRow,
  PowerEfficiencySample,
  PrivateEvaluationJob,
  RackDesign,
  RackInstall,
  RivalTrainJob,
  SimState,
  SubPlan,
  SynthGenJob,
  TrainingBenchmarkSnapshot,
  TrainingCheckpointCandidate,
  TrainingDataPlan,
  TrainingJob,
  TrainingNumerics,
  InvestorPitchRecord,
  WorldFeedEvent,
} from "./types";
import { calendarForDay, formatCampaignDate } from "./campaign";
import {
  DEMAND_MODEL_VERSION,
  ECONOMY,
  WORLD_POPULATION,
} from "./balance/economy";
import { DATA_DOMAINS } from "./balance/data";
import { normalizeCompanyLogoSpec } from "./balance/gameConfig";
import { normalizeDomainHeat } from "./balance/domainHeat";
import { normalizeModelEvaluations } from "./balance/evaluationSuites";
import type { CheckpointEvaluationReport } from "./balance/checkpointEvaluation";
import { API_PRICE_EPSILON, blendApiPrice } from "./balance/pricing";
import {
  backboneFromFamily,
  ioForPreset,
  migrateLegacyProductPreset,
  presetFromFamily,
} from "./balance/trainingV3";
import { nativeWeightPrecisionForNumerics } from "./balance/trainingPrecision";
import { hydrateFrozenTrainingPlan } from "./balance/trainingPlan";
import { minimumTrainingCalendarDays } from "./balance/training";
import { scoreDesign } from "./balance/racks";
import {
  createWorldMarkets,
  syncLabIndex,
  syncLabIndexForPersistence,
} from "./systems/labEngine";
import { normalizeSiteEnergyState } from "./systems/siteEnergy";
import { reconcileCheckpointOwnership } from "./systems/checkpointOwnership";
import { normalizeRivalFinancialComeback } from "./systems/rivalComeback";
import { clampSegmentUsageIntensity } from "./systems/events";
import {
  clampPlanDataCollectionRate,
  defaultPlanDataCollectionRate,
  defaultSteadyPlanUsage,
  normalizedPlanRoutes,
  planAllowanceMTokPerMonth,
  subsidyFromIncludedMTok,
} from "./systems/plans";
import {
  DEFAULT_PEAK_PRICING_PCT,
  DEFAULT_SERVE_SLOWDOWN_LIMIT,
  legacyServeControls,
} from "./balance/serveThrottle";
import {
  migrateDataHallLayouts,
  refreshAllDataHallAnalyses,
} from "./systems/dataHallLayouts";
import { migrateHqOfficeLayouts } from "./systems/hqOffice";
import { ensureModelStudio } from "./balance/modelStudio";
import {
  defaultEffortIdOf,
  INSTANT_EFFORT_ID,
  migrateEffortRecipes,
} from "./balance/modelProduct";
import {
  WORLD_FORMAT_VERSION,
  createDynamicWorld,
  regenerateStaticWorld,
  type DynamicWorldSnapshotV2,
  type StaticWorld,
} from "./world";

export const SAVE_FORMAT = "labline-save" as const;
export const SAVE_VERSION = 14 as const;
export const V1_INCOMPATIBILITY_REASON =
  "Save format v1 is incompatible with the compact-world renderer. This campaign cannot be migrated; start a new operation.";
export const V2_INCOMPATIBILITY_REASON =
  "Save format v2 uses the retired split player/rival simulation. It remains stored but cannot be loaded in Simulation v3; start a new operation.";
export const V3_INCOMPATIBILITY_REASON =
  "Save format v3 uses the short-run economy and cannot be converted into the 2026–2036 campaign. Its valid rack blueprints may still be imported into the profile library.";

export type SaveSlotId = "auto" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";

export const SAVE_SLOTS: SaveSlotId[] = [
  "auto",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
];
export const MANUAL_SLOTS: SaveSlotId[] = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
];

type LegacyComputeWorkItem = Omit<ComputeWorkItem, "channel"> & {
  channel?: ComputeWorkItem["channel"];
};

const LEGACY_INDEX_KEY = "labline.saves.index";
const legacySlotKey = (id: SaveSlotId) => `labline.saves.${id}`;
const DATABASE_NAME = "labline-saves-v2";
const DATABASE_VERSION = 1;
const SLOT_STORE = "slots";
const SYNTH_DOMAIN_KEYS = new Set<string>(DATA_DOMAINS);
const CLOUD_OPENING_MAX_MW = 1;
const CLOUD_MW_PER_PF_PROXY = ECONOMY.mwPerPfProxy ?? 0.001;
const CLOUD_OPENING_MAX_PF = Math.floor(
  CLOUD_OPENING_MAX_MW / Math.max(1e-9, CLOUD_MW_PER_PF_PROXY),
);

export interface SaveMeta {
  slotId: SaveSlotId;
  labName: string;
  day: number;
  difficulty: string;
  seed: number;
  cash: number;
  valuation: number;
  outcome: string;
  savedAt: string;
  /** Calendar date inside the sandbox at the moment it was saved. */
  campaignDate?: string;
  companyMark?: import("./balance/gameConfig").CompanyMarkId;
  version: number;
  compatible: boolean;
  incompatibilityReason?: string;
}

interface PersistedCompactMap {
  width: number;
  height: number;
  storage: "compact";
  energyPricePerMWh: number;
  activeRegionId: string;
  /** Includes dynamic talent pools in addition to city population. */
  cities: MapCity[];
}

interface PersistedLegacyMap {
  width: number;
  height: number;
  storage: "legacy";
  tiles: MapTile[];
  regions: MapRegion[];
  energyPricePerMWh: number;
  activeRegionId: string;
  cities?: MapCity[];
}

type PersistedSimState = Omit<SimState, "map"> & {
  map: PersistedCompactMap | PersistedLegacyMap;
};

export interface SaveFile {
  format: typeof SAVE_FORMAT;
  version: typeof SAVE_VERSION;
  /** Campaign balance/content identity is immutable for the life of a save. */
  contentPackId: string;
  meta: SaveMeta;
  state: PersistedSimState;
  /** Null for v2 saves of legacy small maps. */
  world: DynamicWorldSnapshotV2 | null;
}

export interface LoadedSaveFile extends Omit<SaveFile, "state"> {
  state: SimState;
}

export type SaveErrorCode =
  | "corrupt"
  | "incompatible-version"
  | "newer-version"
  | "not-found"
  | "quota"
  | "storage";

export class SaveError extends Error {
  readonly code: SaveErrorCode;

  constructor(message: string, code: SaveErrorCode = "corrupt") {
    super(message);
    this.name = "SaveError";
    this.code = code;
  }
}

interface StoredSaveRecord {
  slotId: SaveSlotId;
  meta: SaveMeta;
  file: SaveFile;
}

type LegacySaveIndex = {
  slots?: Partial<Record<SaveSlotId, Partial<SaveMeta> | null>>;
};

const memoryRecords = new Map<SaveSlotId, StoredSaveRecord>();
let databasePromise: Promise<IDBDatabase | null> | null = null;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    let settled = false;
    const finish = (database: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      resolve(database);
    };
    try {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SLOT_STORE)) {
          database.createObjectStore(SLOT_STORE, { keyPath: "slotId" });
        }
      };
      request.onsuccess = () => finish(request.result);
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });
  return databasePromise;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

async function putRecord(record: StoredSaveRecord): Promise<void> {
  const database = await openDatabase();
  if (!database) {
    memoryRecords.set(record.slotId, record);
    return;
  }
  const transaction = database.transaction(SLOT_STORE, "readwrite");
  transaction.objectStore(SLOT_STORE).put(record);
  await transactionDone(transaction);
}

async function getRecord(
  slotId: SaveSlotId,
): Promise<StoredSaveRecord | undefined> {
  const database = await openDatabase();
  if (!database) return memoryRecords.get(slotId);
  const transaction = database.transaction(SLOT_STORE, "readonly");
  const done = transactionDone(transaction);
  const value = await requestValue(
    transaction.objectStore(SLOT_STORE).get(slotId) as IDBRequest<
      StoredSaveRecord | undefined
    >,
  );
  await done;
  return value;
}

async function getAllRecords(): Promise<StoredSaveRecord[]> {
  const database = await openDatabase();
  if (!database) return [...memoryRecords.values()];
  const transaction = database.transaction(SLOT_STORE, "readonly");
  const done = transactionDone(transaction);
  const values = await requestValue(
    transaction.objectStore(SLOT_STORE).getAll() as IDBRequest<
      StoredSaveRecord[]
    >,
  );
  await done;
  return values;
}

async function removeRecord(slotId: SaveSlotId): Promise<void> {
  memoryRecords.delete(slotId);
  const database = await openDatabase();
  if (!database) return;
  const transaction = database.transaction(SLOT_STORE, "readwrite");
  transaction.objectStore(SLOT_STORE).delete(slotId);
  await transactionDone(transaction);
}

function legacyStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function legacyMeta(): SaveMeta[] {
  const storage = legacyStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(LEGACY_INDEX_KEY);
    if (!raw) return [];
    const index = JSON.parse(raw) as LegacySaveIndex;
    const result: SaveMeta[] = [];
    for (const slotId of SAVE_SLOTS) {
      const meta = index.slots?.[slotId];
      if (!meta) continue;
      result.push({
        slotId,
        labName:
          typeof meta.labName === "string" ? meta.labName : "Legacy campaign",
        day: typeof meta.day === "number" ? meta.day : 0,
        difficulty:
          typeof meta.difficulty === "string" ? meta.difficulty : "unknown",
        seed: typeof meta.seed === "number" ? meta.seed : 0,
        cash: typeof meta.cash === "number" ? meta.cash : 0,
        valuation: typeof meta.valuation === "number" ? meta.valuation : 0,
        outcome: typeof meta.outcome === "string" ? meta.outcome : "unknown",
        savedAt:
          typeof meta.savedAt === "string"
            ? meta.savedAt
            : new Date(0).toISOString(),
        version: 1,
        compatible: false,
        incompatibilityReason: V1_INCOMPATIBILITY_REASON,
      });
    }
    return result;
  } catch {
    return [];
  }
}

/** Test helper: wipe IndexedDB, memory fallback, and legacy localStorage slots. */
export async function clearAllSaves(): Promise<void> {
  memoryRecords.clear();
  const storage = legacyStorage();
  if (storage) {
    try {
      for (const id of SAVE_SLOTS) storage.removeItem(legacySlotKey(id));
      storage.removeItem(LEGACY_INDEX_KEY);
    } catch {
      // Storage cleanup is best effort in private mode.
    }
  }
  if (!hasIndexedDb()) return;
  const database = await databasePromise;
  database?.close();
  databasePromise = null;
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DATABASE_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

function jsonClone<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "number" && !Number.isFinite(nested)) {
        if (nested === Infinity) return null;
        if (nested === -Infinity) return "$-Infinity";
        return null;
      }
      return nested;
    }),
  ) as T;
}

function compactPersistedState(state: SimState): PersistedSimState {
  const { map, ...simulation } = state;
  const compactLayouts = Object.fromEntries(
    Object.entries(simulation.dataHallLayouts ?? {}).map(
      ([facilityId, layout]) => [
        facilityId,
        {
          ...layout,
          analysis: {
            ...layout.analysis,
            powerRoutes: [],
            coolingRoutes: [],
            networkRoutes: [],
            serviceRoutes: [],
          },
        },
      ],
    ),
  );
  const compactSimulation = { ...simulation, dataHallLayouts: compactLayouts };
  if (map.storage === "compact" && map.world) {
    return {
      ...compactSimulation,
      map: {
        width: map.width,
        height: map.height,
        storage: "compact",
        energyPricePerMWh: map.energyPricePerMWh,
        activeRegionId: map.activeRegionId,
        cities: map.cities?.map((city) => ({ ...city })) ?? [],
      },
    };
  }
  return {
    ...compactSimulation,
    map: {
      width: map.width,
      height: map.height,
      storage: "legacy",
      tiles: map.tiles,
      regions: map.regions,
      energyPricePerMWh: map.energyPricePerMWh,
      activeRegionId: map.activeRegionId,
      cities: map.cities,
    },
  };
}

/** Public sanitization helper retained for tests/export tooling. */
export function sanitizeState(state: SimState): SimState {
  return jsonClone(compactPersistedState(state)) as unknown as SimState;
}

function reviveInfinities(value: unknown, path = ""): unknown {
  if (value === null) return path.endsWith(".runwayDays") ? Infinity : value;
  if (value === "$-Infinity") return -Infinity;
  if (Array.isArray(value)) {
    return value.map((nested, index) =>
      reviveInfinities(nested, `${path}[${index}]`),
    );
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      result[key] = reviveInfinities(nested, path ? `${path}.${key}` : key);
    }
    return result;
  }
  return value;
}

function ensureArray<T>(value: unknown, fallback: T[] = []): T[] {
  return Array.isArray(value) ? (value as T[]) : fallback;
}

function ensureRecord(value: unknown): Record<string, number> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, number>)
    : {};
}

/** Additive migration for model-backed investor pitches introduced after v14. */
function normalizeCapitalStack(
  capital: CapitalStack | undefined,
): CapitalStack | undefined {
  if (!capital || typeof capital !== "object") return capital;
  const cooldowns = ensureRecord(capital.pitchModelCooldowns);
  const pitchModelCooldowns = Object.fromEntries(
    Object.entries(cooldowns)
      .filter(([, value]) => Number.isFinite(value))
      .map(([modelId, value]) => [modelId, Math.max(0, Math.floor(value))]),
  );
  const pitchHistory = ensureArray<InvestorPitchRecord>(capital.pitchHistory)
    .filter(
      (record) =>
        record &&
        typeof record.id === "string" &&
        typeof record.modelId === "string" &&
        typeof record.modelName === "string" &&
        typeof record.investorName === "string",
    )
    // Pitch records are stored newest-first. Keep the latest records when an
    // imported or hand-edited save exceeds the normal writer's history cap.
    .slice(0, 16)
    .map((record) => {
      const effortId =
        typeof record.effortId === "string" && record.effortId.length > 0
          ? record.effortId
          : INSTANT_EFFORT_ID;
      return {
        ...record,
        effortId,
        day: Math.max(0, Math.floor(Number(record.day) || 0)),
        successChance: Math.max(0, Math.min(1, Number(record.successChance) || 0)),
        requestedCashRaised: Math.max(
          0,
          Number(record.requestedCashRaised) || Number(record.cashRaised) || 0,
        ),
        dataDrag: Math.max(0, Math.min(1, Number(record.dataDrag) || 0)),
        cashRaised: Math.max(0, Number(record.cashRaised) || 0),
        preMoneyValuation: Math.max(0, Number(record.preMoneyValuation) || 0),
        postMoneyValuation: Math.max(0, Number(record.postMoneyValuation) || 0),
        investorOwnership: Math.max(0, Math.min(1, Number(record.investorOwnership) || 0)),
        cooldownUntilDay: Math.max(0, Math.floor(Number(record.cooldownUntilDay) || 0)),
        outcome: record.outcome === "funded" ? ("funded" as const) : ("declined" as const),
      };
    });
  const deskCooldown = Number(capital.pitchCooldownUntilDay);
  return {
    ...capital,
    pitchCooldownUntilDay: Number.isFinite(deskCooldown)
      ? Math.max(0, Math.floor(deskCooldown))
      : 0,
    pitchModelCooldowns,
    pitchHistory,
  };
}

/**
 * Migrate pre-supply-curve cloud pools without losing already signed capacity.
 * Day-one legacy pools are reduced to the one-MW opening envelope; any active
 * reservation is grandfathered so provider availability remains coherent.
 */
function normalizeCloudProviders(
  providers: CloudProvider[],
  contracts: ComputeContract[],
  day: number,
): CloudProvider[] {
  return providers.map((provider) => {
    const rawBaseline = Number(provider.baselinePf);
    const baselineInput = Number.isFinite(rawBaseline)
      ? Math.max(0, rawBaseline)
      : 0;
    const rawAvailable = Number(provider.availablePf);
    const availableInput = Number.isFinite(rawAvailable)
      ? Math.max(0, rawAvailable)
      : baselineInput;
    const launchInput = Number(provider.launchBaselinePf);
    const launchCandidate =
      Number.isFinite(launchInput) && launchInput > 0
        ? launchInput
        : baselineInput;
    const launchBaselinePf = Math.max(
      1,
      day <= 1
        ? Math.min(launchCandidate, CLOUD_OPENING_MAX_PF)
        : launchCandidate,
    );
    const activeReservedPf = contracts
      .filter(
        (contract) =>
          contract.providerId === provider.id &&
          (contract.status === "active" || contract.status === "interrupted") &&
          contract.kind !== "emergency" &&
          contract.kind !== "rival_resale",
      )
      .reduce((sum, contract) => sum + Math.max(0, contract.pf), 0);
    const openingBaseline =
      day <= 1
        ? Math.min(baselineInput, CLOUD_OPENING_MAX_PF)
        : baselineInput;
    const baselinePf = Math.max(openingBaseline, activeReservedPf);
    const availablePf = Math.max(
      0,
      Math.min(availableInput, Math.max(0, baselinePf - activeReservedPf)),
    );
    return {
      ...provider,
      baselinePf,
      launchBaselinePf: Math.min(launchBaselinePf, baselinePf),
      maxBaselinePf: Math.max(
        baselinePf,
        Number.isFinite(provider.maxBaselinePf)
          ? Math.max(0, provider.maxBaselinePf!)
          : baselinePf,
      ),
      availablePf,
    };
  });
}

const LEGACY_PLAN_BASE_ALLOWANCE_MTOK_PER_MONTH = 0.6;

/**
 * Earlier saves initialized subscription allowances from a 0.6M-token
 * monthly baseline. Only migrate values still close to that generated shape;
 * deliberately customized plans remain untouched.
 */
function migrateLegacyPlanAllowances(state: SimState): void {
  const plans = ensureArray<SubPlan>(state.player.pricing?.plans);
  state.player.pricing.plans = plans.map((plan) => {
    const multiplier = Math.max(0.1, Number(plan.usageMultiplier) || 1);
    const allowance = Number(plan.includedMTokPerMonth);
    if (!Number.isFinite(allowance) || allowance <= 0) return plan;

    const legacyAllowance =
      LEGACY_PLAN_BASE_ALLOWANCE_MTOK_PER_MONTH * multiplier;
    const legacyTolerance = Math.max(0.06, legacyAllowance * 0.12);
    if (Math.abs(allowance - legacyAllowance) > legacyTolerance) return plan;

    return {
      ...plan,
      includedMTokPerMonth:
        ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth * multiplier,
    };
  });
}

/** Blended lab list price used when deriving missing plan subsidies on load. */
function restoreBlendedApiPrice(state: SimState): number {
  const pricing = state.player.pricing;
  if (
    Number.isFinite(pricing.apiPriceInPerMTok) &&
    Number.isFinite(pricing.apiPriceOutPerMTok)
  ) {
    return blendApiPrice(pricing.apiPriceInPerMTok, pricing.apiPriceOutPerMTok);
  }
  return Math.max(
    API_PRICE_EPSILON,
    Number(pricing.apiPricePerMTok) || API_PRICE_EPSILON,
  );
}

/**
 * Soft-migrate plans onto advertised monthly API-value subsidy. Missing
 * `monthlyApiValueSubsidyGbp` is derived from included MTok × blended API
 * price (legacy conversion documented in plans.ts).
 */
function migratePlanApiValueSubsidies(state: SimState): void {
  const blended = restoreBlendedApiPrice(state);
  const plans = ensureArray<SubPlan>(state.player.pricing?.plans);
  state.player.pricing.plans = plans.map((plan) => {
    if (
      Number.isFinite(plan.monthlyApiValueSubsidyGbp) &&
      (plan.monthlyApiValueSubsidyGbp ?? 0) > 0
    ) {
      return plan;
    }
    const subsidy = subsidyFromIncludedMTok(
      planAllowanceMTokPerMonth(plan),
      blended,
    );
    return {
      ...plan,
      monthlyApiValueSubsidyGbp: subsidy > 0 ? subsidy : undefined,
    };
  });
}

/**
 * Soft-migrate supplier contracts so pre-negotiation saves stay loadable.
 * Legacy terminal `completed` is preserved; new bookkeeping fields default.
 */
function normalizeDataSupplierContract(
  contract: DataSupplierContract,
): DataSupplierContract {
  // Old saves can carry the retired 'pending' status; map it onto 'offered'
  // so the negotiation actually resolves on the next daily tick instead of
  // sitting invisibly stuck forever.
  const status =
    (contract.status as string) === "pending"
      ? ("offered" as const)
      : contract.status;
  return {
    ...contract,
    status,
    qualityFloor: contract.qualityFloor ?? contract.quality,
    deliveredMTok: Math.max(0, contract.deliveredMTok ?? 0),
    cancellationFeeCharged: Math.max(0, contract.cancellationFeeCharged ?? 0),
    extendedDays: Math.max(0, contract.extendedDays ?? 0),
    extensionCount: Math.max(0, contract.extensionCount ?? 0),
    offeredDay: contract.offeredDay ?? contract.acceptedDay,
  };
}

const LEGACY_TRAINING_NUMERICS: TrainingNumerics = {
  computeFormat: "bf16_mixed",
  nativeWeightFormat: "float",
  recipeVersion: 1,
};

function normalizeModelProductProfile(
  profile: Model["productProfile"],
): Model["productProfile"] {
  if (!profile) return undefined;
  const effortRecipes = migrateEffortRecipes(profile);
  return {
    ...profile,
    effortRecipes,
    defaultEffortId: defaultEffortIdOf({ ...profile, effortRecipes }),
  };
}

function normalizeSyntheticTeacherEffortIds(
  value: unknown,
): TrainingDataPlan["syntheticTeacherEffortIds"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([domain, recipeId]) =>
          SYNTH_DOMAIN_KEYS.has(domain) &&
          typeof recipeId === "string" &&
          recipeId.trim().length > 0,
      )
      .map(([domain, recipeId]) => [domain, (recipeId as string).trim()]),
  );
}

function normalizeTrainingDataPlan(
  dataPlan: TrainingDataPlan,
): TrainingDataPlan {
  return {
    ...dataPlan,
    // Soft-migrate synthetic teacher/corpus selection fields. Recipe ids are
    // model-owned, so deleted/unknown ids remain a runtime Instant fallback.
    syntheticTeacherIds: dataPlan.syntheticTeacherIds
      ? { ...dataPlan.syntheticTeacherIds }
      : undefined,
    syntheticTeacherEffortIds: normalizeSyntheticTeacherEffortIds(
      dataPlan.syntheticTeacherEffortIds,
    ),
    syntheticMultiplier:
      dataPlan.syntheticMultiplier != null &&
      Number.isFinite(dataPlan.syntheticMultiplier)
        ? Math.max(0, Math.min(7, dataPlan.syntheticMultiplier))
        : undefined,
    syntheticProvenance: ensureArray<
      NonNullable<TrainingDataPlan["syntheticProvenance"]>[number]
    >(dataPlan.syntheticProvenance),
  };
}

function normalizeTrainingJob(job: TrainingJob): TrainingJob {
  const backbone = job.backbone ?? backboneFromFamily(job.family);
  const rawPreset = job.productPreset ?? presetFromFamily(job.family);
  const io = job.io ?? ioForPreset(rawPreset);
  const productPreset = migrateLegacyProductPreset(rawPreset, io);
  // Intentional: old saves without stored numerics keep the historical bf16
  // mixed default rather than the new-game FP32 starting recipe.
  const trainingNumerics =
    job.trainingNumerics ?? job.numerics ?? LEGACY_TRAINING_NUMERICS;
  const recommendedPfDays = Math.max(
    0,
    job.recommendedPfDays ?? job.targetPfDays,
  );
  const minCalendarDays =
    job.targetParamsB >= 1_000
      ? Number.isFinite(job.minCalendarDays) && (job.minCalendarDays ?? 0) > 0
        ? Math.max(1, job.minCalendarDays ?? 0)
        : minimumTrainingCalendarDays({
            paramsB: job.targetParamsB,
            family: job.family,
            backbone,
            mode: job.mode,
            trainingTokensMTok: job.trainMTok,
            verificationTokensMTok: job.verifyMTok,
          })
      : 0;
  const setupCost = Math.max(
    0,
    job.economics?.setupCost ??
      Math.max(0, (job.cashSunk ?? 0) - Math.max(0, job.cashBurnPerDay ?? 0)),
  );
  const dataCost = Math.max(0, job.economics?.dataCost ?? 0);
  const trainingCostAccrued = Math.max(
    0,
    job.economics?.trainingCostAccrued ??
      Math.max(0, (job.cashSunk ?? 0) - setupCost - dataCost),
  );
  const completedPostTrainStages = new Set(job.completedPostTrainStages ?? []);
  if (
    job.postTrain !== "none" &&
    job.postTrainTarget > 0 &&
    job.postTrainProgress + 1e-9 >= job.postTrainTarget
  ) {
    completedPostTrainStages.add(job.postTrain);
  }
  const dataPlan = normalizeTrainingDataPlan(job.dataPlan);
  const plan = job.plan
    ? {
        ...job.plan,
        dataRecipe: normalizeTrainingDataPlan(job.plan.dataRecipe),
      }
    : job.plan;
  const normalized: TrainingJob = {
    ...job,
    backbone,
    productPreset,
    io,
    dataPlan,
    plan,
    productProfile: normalizeModelProductProfile(job.productProfile),
    trainingFormulaVersion: job.trainingFormulaVersion ?? 1,
    trainingNumerics,
    numerics: trainingNumerics,
    minCalendarDays,
    daysElapsed: Math.max(0, job.daysElapsed ?? 0),
    postTrainDaysElapsed: Math.max(0, job.postTrainDaysElapsed ?? 0),
    postTrainRiskPlan:
      job.postTrainRiskPlan && job.postTrainRiskPlan.stage === job.postTrain
        ? {
            ...job.postTrainRiskPlan,
            probability: Math.max(
              0,
              Math.min(
                1,
                Number.isFinite(job.postTrainRiskPlan.probability)
                  ? job.postTrainRiskPlan.probability
                  : 0,
              ),
            ),
            atFraction: Math.max(
              0,
              Math.min(
                1,
                Number.isFinite(job.postTrainRiskPlan.atFraction)
                  ? job.postTrainRiskPlan.atFraction
                  : 0.5,
              ),
            ),
            startFraction:
              job.postTrainRiskPlan.startFraction == null
                ? undefined
                : Math.max(
                    0,
                    Math.min(
                      0.98,
                      Number.isFinite(job.postTrainRiskPlan.startFraction)
                        ? job.postTrainRiskPlan.startFraction
                        : 0,
                    ),
                  ),
            factors: ensureArray<string>(job.postTrainRiskPlan.factors),
            seedVersion: 2,
          }
        : undefined,
    postTrainRecoveryAttempt: Math.max(
      0,
      Math.floor(job.postTrainRecoveryAttempt ?? 0),
    ),
    failureRecord: job.failureRecord
      ? {
          ...job.failureRecord,
          day: Math.max(0, Math.floor(job.failureRecord.day ?? 0)),
          progressPfDays: Math.max(
            0,
            Number.isFinite(job.failureRecord.progressPfDays)
              ? job.failureRecord.progressPfDays
              : Number.isFinite(job.progressPfDays)
                ? job.progressPfDays
                : 0,
          ),
          stageProgress: Math.max(
            0,
            Math.min(
              1,
              Number.isFinite(job.failureRecord.stageProgress)
                ? job.failureRecord.stageProgress
                : 0,
            ),
          ),
          probability: Math.max(
            0,
            Math.min(
              1,
              Number.isFinite(job.failureRecord.probability)
                ? job.failureRecord.probability
                : 0,
            ),
          ),
          factors: ensureArray<string>(job.failureRecord.factors),
          recoveryCheckpointId:
            job.failureRecord.recoveryCheckpointId ??
            job.failureRecoveryCheckpointId,
        }
      : undefined,
    failureRecoveryCheckpointId:
      job.failureRecord?.recoveryCheckpointId ??
      job.failureRecoveryCheckpointId,
    completedPostTrainStages: [...completedPostTrainStages],
    postTrainStageEffectiveness: { ...(job.postTrainStageEffectiveness ?? {}) },
    postTrainStageRuns: {
      ...Object.fromEntries(
        [...completedPostTrainStages].map((stage) => [stage, 1]),
      ),
      ...(job.postTrainStageRuns ?? {}),
    },
    postTrainStagesCompletedThisRun: ensureArray(
      job.postTrainStagesCompletedThisRun,
    ),
    computePriority: Math.max(0, Math.min(100, job.computePriority ?? 50)),
    reservedPf: Math.max(0, job.reservedPf ?? 0),
    paused: job.paused ?? false,
    preemptible: job.preemptible ?? true,
    stallReason: job.stallReason ?? null,
    failed: job.failed ?? false,
    lossHistory: ensureArray<NonNullable<TrainingJob["lossHistory"]>[number]>(
      job.lossHistory,
    ).slice(-64),
    recommendedPfDays,
    extensionDays: 0,
    awaitingDecision: false,
    autoExtend: false,
    autoChainPostTrain: false,
    energyMwDays: Math.max(0, job.energyMwDays ?? 0),
    energyMWh: Math.max(0, job.energyMWh ?? (job.energyMwDays ?? 0) * 24),
    daysRemaining: Math.max(0, job.daysRemaining ?? 0),
    economics: {
      setupCost,
      dataCost,
      trainingCostAccrued,
    },
    benchmarkSnapshots: ensureArray<TrainingBenchmarkSnapshot>(
      job.benchmarkSnapshots,
    ).slice(-32),
    pendingBenchmark: job.pendingBenchmark
      ? {
          ...job.pendingBenchmark,
          id:
            job.pendingBenchmark.id ??
            `${job.id}-legacy-benchmark-${job.pendingBenchmark.startedDay}`,
          suiteIds: job.pendingBenchmark.suiteIds
            ? [...job.pendingBenchmark.suiteIds]
            : undefined,
        }
      : undefined,
    benchmarkSequence: Math.max(
      0,
      job.benchmarkSequence ?? job.benchmarkSnapshots?.length ?? 0,
    ),
    lineageId: job.lineageId ?? job.continueLineageId ?? job.id,
  };
  return {
    ...normalized,
    plan: hydrateFrozenTrainingPlan(
      normalized,
      job.plan?.companyId ?? "player",
    ),
  };
}

function normalizeModelComputeV2(model: Model): Model {
  // Intentional: old saves without stored numerics keep historical bf16 mixed.
  const trainingNumerics = model.trainingNumerics ?? LEGACY_TRAINING_NUMERICS;
  const completedPostTrainStages = new Set(
    model.completedPostTrainStages ?? [],
  );
  const postTrainStageEffectiveness = {
    ...(model.postTrainStageEffectiveness ?? {}),
  };
  const legacyEffectiveness = Math.max(
    0.2,
    Math.min(
      1,
      (model.capability * 0.45 +
        model.quality.reliability * 0.3 +
        model.quality.reasoning * 0.25) /
        100,
    ),
  );
  for (const stage of completedPostTrainStages) {
    postTrainStageEffectiveness[stage] ??= legacyEffectiveness;
  }
  const effectivePostTrain = completedPostTrainStages.has("tools")
    ? "tools"
    : completedPostTrainStages.has("process")
      ? "process"
      : completedPostTrainStages.has("rlhf")
        ? "rlhf"
        : completedPostTrainStages.has("sft")
          ? "sft"
          : "none";
  const reasoningEnabled =
    completedPostTrainStages.has("process") ||
    completedPostTrainStages.has("tools") ||
    model.integratedMethods?.includes("align_process") === true ||
    model.modelStack?.includes("align_process") === true;
  const rawPreset = model.productPreset ?? presetFromFamily(model.family);
  const baseIo = model.io ?? ioForPreset(rawPreset, model.capability);
  const productPreset = migrateLegacyProductPreset(rawPreset, baseIo);
  const released = model.release === "released" || model.shipped;
  return {
    ...normalizeModelEvaluations({
      ...model,
      productPreset,
      io: baseIo,
      postTrain: effectivePostTrain,
      reasoningEnabled,
      completedPostTrainStages: [...completedPostTrainStages],
      postTrainStageEffectiveness,
    }),
    productProfile: normalizeModelProductProfile(model.productProfile),
    lineageId: model.lineageId ?? model.id,
    parentModelId: model.parentModelId,
    revision: Math.max(1, model.revision ?? 1),
    postTrainStageRuns: {
      ...Object.fromEntries(
        [...completedPostTrainStages].map((stage) => [stage, 1]),
      ),
      ...(model.postTrainStageRuns ?? {}),
    },
    trainingLossHistory: ensureArray<
      NonNullable<Model["trainingLossHistory"]>[number]
    >(model.trainingLossHistory).slice(-64),
    trainingBenchmarkSnapshots: ensureArray<TrainingBenchmarkSnapshot>(
      model.trainingBenchmarkSnapshots,
    ).slice(-32),
    checkpointEvaluations: ensureArray<CheckpointEvaluationReport>(
      model.checkpointEvaluations,
    ).slice(-16),
    trainingFormulaVersion: model.trainingFormulaVersion ?? 1,
    trainingNumerics,
    nativeWeightPrecision:
      model.nativeWeightPrecision ??
      (released
        ? nativeWeightPrecisionForNumerics(trainingNumerics)
        : model.nativeWeightPrecision),
    deploymentArtifacts: ensureArray(model.deploymentArtifacts),
    syntheticProvenance: ensureArray(model.syntheticProvenance),
    archived: model.archived === true ? true : undefined,
  };
}

function rivalJobToCanonical(job: RivalTrainJob): TrainingJob {
  const totalMTok = Math.max(0, job.totalMTok ?? 0);
  const trainShare = Math.max(0.4, Math.min(0.95, job.trainShare ?? 0.82));
  return normalizeTrainingJob({
    id: job.id,
    name: job.name,
    family: job.family,
    backbone: job.backbone ?? backboneFromFamily(job.family),
    productPreset: job.productPreset ?? presetFromFamily(job.family),
    io:
      job.io ?? ioForPreset(job.productPreset ?? presetFromFamily(job.family)),
    targetParamsB: job.paramsB,
    activeParamsB: job.activeParamsB,
    targetPfDays: job.targetPfDays,
    progressPfDays: job.progressPfDays,
    postTrain: "none",
    postTrainProgress: 0,
    postTrainTarget: 0,
    mode: "pretrain",
    dataMix: "web",
    dataPlan: {
      totalUnits: totalMTok,
      totalMTok,
      trainShare,
      weights: { chat: 1 },
      allowSynthetic: job.includeSynthHQ || job.includeSynthLQ,
      includeSynthHQ: job.includeSynthHQ,
      includeSynthLQ: job.includeSynthLQ,
    },
    dataConsumed: { chat: totalMTok },
    dataCoverage: job.dataCoverage,
    dataQualityUsed: job.dataQuality,
    syntheticUnits: totalMTok * Math.max(0, job.synthLqShare ?? 0),
    trainShare,
    trainMTok: totalMTok * trainShare,
    verifyMTok: totalMTok * (1 - trainShare),
    cashBurnPerDay: job.cashBurnPerDay ?? 0,
    cashSunk: job.cashSunk ?? 0,
    synthLqShare: job.synthLqShare,
    outcomeSeed: job.outcomeSeed,
    outcomeRisk: job.outcomeRisk,
    effectiveDataRatio: job.effectiveDataRatio,
    repeatedDataEpochs: job.repeatedDataEpochs,
    modalityComputeMult: job.modalityComputeMult,
    trainingFormulaVersion: 1,
    trainingNumerics: LEGACY_TRAINING_NUMERICS,
  });
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
  }));
}

function validateBaseState(raw: unknown): PersistedSimState {
  if (!raw || typeof raw !== "object")
    throw new SaveError("Save data is empty or corrupt.");
  const state = reviveInfinities(raw) as PersistedSimState;
  if (typeof state.seed !== "number" || typeof state.day !== "number") {
    throw new SaveError("Save is missing seed/day.");
  }
  if (!state.player || typeof state.player !== "object") {
    throw new SaveError("Save is missing player state.");
  }
  if (!state.map || typeof state.map !== "object") {
    throw new SaveError("Save is missing map state.");
  }
  return state;
}

function restoreState(
  stateRaw: unknown,
  snapshot: DynamicWorldSnapshotV2 | null,
): SimState {
  const state = validateBaseState(stateRaw);
  let map: SimState["map"];
  if (state.map.storage === "compact") {
    if (!snapshot || snapshot.formatVersion !== WORLD_FORMAT_VERSION) {
      throw new SaveError("Compact save is missing its v2 world snapshot.");
    }
    if (
      snapshot.descriptor.seed !== state.seed ||
      snapshot.descriptor.width !== state.map.width ||
      snapshot.descriptor.height !== state.map.height
    ) {
      throw new SaveError(
        "Compact world descriptor does not match the saved campaign.",
      );
    }
    let staticWorld: StaticWorld;
    try {
      staticWorld = regenerateStaticWorld(snapshot.descriptor);
    } catch (error) {
      throw new SaveError(
        error instanceof Error
          ? `Could not regenerate compact world: ${error.message}`
          : "Could not regenerate compact world.",
      );
    }
    if (staticWorld.staticHash !== snapshot.staticHash) {
      throw new SaveError(
        "Compact world hash does not match this build. The save cannot be loaded safely.",
        "incompatible-version",
      );
    }
    const world = createDynamicWorld(staticWorld, {
      terrainOverrides: snapshot.terrainOverrides,
      facilities: snapshot.facilities,
      cities: snapshot.cities,
    });
    if (!Array.isArray(state.map.cities)) {
      throw new SaveError("Compact save is missing city runtime state.");
    }
    const staticCityIndexById = new Map(
      staticWorld.cities.map((city) => [city.id, city.index]),
    );
    const compatibilityCities = state.map.cities.map(
      (city, compatibilityIndex) => {
        const cityIndex =
          staticCityIndexById.get(city.id) ?? compatibilityIndex;
        const population = world.cityRuntime.get(cityIndex)?.population;
        return population === undefined || population === city.population
          ? city
          : { ...city, population };
      },
    );
    map = {
      width: snapshot.descriptor.width,
      height: snapshot.descriptor.height,
      storage: "compact",
      world,
      worldRevision: world.revision,
      tiles: [],
      regions: regionsFromStatic(staticWorld),
      energyPricePerMWh: state.map.energyPricePerMWh,
      activeRegionId: state.map.activeRegionId,
      cities: compatibilityCities,
    };
  } else {
    if (!Array.isArray(state.map.tiles) || !Array.isArray(state.map.regions)) {
      throw new SaveError(
        "Legacy-map v2 save is missing map tiles or regions.",
      );
    }
    map = {
      ...state.map,
      storage: "legacy",
      tiles: state.map.tiles,
      regions: state.map.regions,
    };
  }

  const restored = {
    ...state,
    map,
    config: {
      ...state.config,
      companyLogo: normalizeCompanyLogoSpec(
        state.config.companyLogo,
        state.config.companyMark ?? "orbit",
      ),
      drivingSide: state.config.drivingSide === "right" ? "right" : "left",
    },
    transport:
      state.transport && state.transport.version === 1
        ? state.transport
        : {
            version: 1 as const,
            day: 0,
            networkRevision: 0,
            segmentLoads: [],
            junctionLoads: [],
            regionCongestion: {},
            cityAccess: {},
            facilityAccess: {},
          },
  } as SimState;
  // Old campaigns may persist a spot price from the earlier, cheaper energy
  // economy. Bring them onto the current industrial-power floor immediately
  // instead of waiting for the first map tick.
  restored.map.energyPricePerMWh = Math.max(
    Number.isFinite(restored.map.energyPricePerMWh)
      ? restored.map.energyPricePerMWh
      : ECONOMY.energyBasePrice,
    ECONOMY.energyBasePrice * 0.7,
  );
  if (
    !restored.industryDataPack ||
    restored.industryDataPack.id !== restored.config.campaignRules.contentPackId
  ) {
    throw new SaveError(
      "Save is missing its pinned industry data-pack snapshot.",
      "incompatible-version",
    );
  }
  restored.player.rackFleet = ensureArray<RackInstall>(
    restored.player.rackFleet,
  ).map((rack) => ({
    ...rack,
    // Old saves can carry retired statuses (e.g. 'installing', 'shipping');
    // the commissioning tick only advances 'ordered', so anything that is not
    // provably live is re-queued as 'ordered' rather than stranded forever.
    status: rack.status === "live" ? ("live" as const) : ("ordered" as const),
    facilityId:
      typeof rack.facilityId === "string" && rack.facilityId.trim()
        ? rack.facilityId
        : undefined,
    bayStarts: ensureArray<number>(rack.bayStarts)
      .slice(0, Math.max(0, Math.floor(rack.count)))
      .map((value) => (Number.isSafeInteger(value) && value >= 0 ? value : -1)),
    unitIds: ensureArray<string>(rack.unitIds).slice(
      0,
      Math.max(0, Math.floor(rack.count)),
    ),
  }));
  restored.player.loans = ensureArray(restored.player.loans);
  restored.player.capital = normalizeCapitalStack(restored.player.capital);
  restored.player.models = ensureArray(restored.player.models).map((model) =>
    normalizeModelComputeV2(model as Model),
  );
  if (restored.player.data) {
    restored.player.data = {
      ...restored.player.data,
      synthQueue: ensureArray<SynthGenJob>(restored.player.data.synthQueue).map(
        (job) => ({
          ...job,
          teacherModelIds:
            job.teacherModelIds && typeof job.teacherModelIds === "object"
              ? Object.fromEntries(
                  Object.entries(job.teacherModelIds).filter(
                    ([domain, modelId]) =>
                      SYNTH_DOMAIN_KEYS.has(domain) &&
                      typeof modelId === "string" &&
                      modelId.trim().length > 0,
                  ),
                )
              : undefined,
          teacherEffortIds: normalizeSyntheticTeacherEffortIds(
            job.teacherEffortIds,
          ),
        }),
      ),
    };
  }
  restored.player.trainingCheckpoints =
    ensureArray<TrainingCheckpointCandidate>(
      restored.player.trainingCheckpoints,
    ).map((candidate) => {
      const model = normalizeModelComputeV2({
        ...candidate.model,
        release: "internal",
        shipped: false,
        checkpointCandidateId: candidate.id,
        sourceTrainingJobId: candidate.sourceJobId,
        checkpointProgress:
          candidate.telemetry?.progress ?? candidate.milestone,
      });
      const progress = Math.max(
        0,
        Math.min(1, candidate.telemetry?.progress ?? candidate.milestone ?? 0),
      );
      const status =
        candidate.status === "promoted" || candidate.status === "discarded"
          ? candidate.status
          : "stealth";
      const ownerModelId = candidate.sourceOwnershipRevoked
        ? undefined
        : restored.player.models.some(
              (candidateModel) => candidateModel.id === candidate.ownerModelId,
            )
          ? candidate.ownerModelId
          : restored.player.models.find(
              (candidateModel) =>
                candidateModel.sourceTrainingJobId === candidate.sourceJobId &&
                candidateModel.id !== model.id &&
                candidateModel.id.startsWith("model-") &&
                candidateModel.id.endsWith(`-${candidate.sourceJobId}`),
            )?.id;
      return {
        ...candidate,
        lineageId: candidate.lineageId ?? model.lineageId ?? model.id,
        ownerModelId,
        sourceOwnershipRevoked: candidate.sourceOwnershipRevoked === true,
        ordinal: Math.max(1, Math.floor(candidate.ordinal ?? 1)),
        kind: candidate.kind ?? "milestone",
        branchDirection: candidate.branchDirection ?? "general",
        milestone: Math.max(0, Math.min(1, candidate.milestone ?? progress)),
        capturedDay: Math.max(
          0,
          candidate.capturedDay ?? model.releaseDay ?? 0,
        ),
        stage: candidate.stage ?? "base",
        status,
        model,
        telemetry: {
          progressPfDays: Math.max(0, candidate.telemetry?.progressPfDays ?? 0),
          targetPfDays: Math.max(0, candidate.telemetry?.targetPfDays ?? 0),
          progress,
          daysElapsed: Math.max(0, candidate.telemetry?.daysElapsed ?? 0),
          stage: candidate.telemetry?.stage ?? candidate.stage ?? "base",
          stageProgress: Math.max(
            0,
            Math.min(1, candidate.telemetry?.stageProgress ?? progress),
          ),
          loss:
            candidate.telemetry?.loss != null &&
            Number.isFinite(candidate.telemetry.loss)
              ? candidate.telemetry.loss
              : null,
          energyMWh: Math.max(0, candidate.telemetry?.energyMWh ?? 0),
          trainingNumerics:
            candidate.telemetry?.trainingNumerics ?? model.trainingNumerics,
        },
        evaluations: ensureArray<CheckpointEvaluationReport>(
          candidate.evaluations,
        )
          .slice(-16)
          .map((report) => ({
            ...report,
            request: {
              ...report.request,
              suiteIds: [...report.request.suiteIds],
            },
            quote: { ...report.quote, suiteIds: [...report.quote.suiteIds] },
            flags: [...report.flags],
            suites: report.suites.map((suite) => ({
              ...suite,
              metrics: suite.metrics.map((metric) => ({ ...metric })),
            })),
            reviews: report.reviews.map((review) => ({
              ...review,
              strengths: [...review.strengths],
              concerns: [...review.concerns],
            })),
          })),
        pendingEvaluation: candidate.pendingEvaluation
          ? {
              ...candidate.pendingEvaluation,
              request: {
                ...candidate.pendingEvaluation.request,
                suiteIds: [...candidate.pendingEvaluation.request.suiteIds],
              },
              quote: {
                ...candidate.pendingEvaluation.quote,
                suiteIds: [...candidate.pendingEvaluation.quote.suiteIds],
              },
            }
          : undefined,
      };
    });
  migrateLegacyPlanAllowances(restored);
  migratePlanApiValueSubsidies(restored);
  restored.player.trainingJobs = ensureArray<TrainingJob>(
    restored.player.trainingJobs,
  )
    .map(normalizeTrainingJob)
    .map((job) => {
      if (!job.continueFromId || job.continueLineageId) return job;
      const source = restored.player.models.find(
        (model) => model.id === job.continueFromId,
      );
      return {
        ...job,
        continueLineageId:
          source?.lineageId ?? source?.id ?? job.continueFromId,
      };
    });
  if (restored.player.trainingJob) {
    const normalizedLegacy = normalizeTrainingJob(restored.player.trainingJob);
    const legacySource = normalizedLegacy.continueFromId
      ? restored.player.models.find(
          (model) => model.id === normalizedLegacy.continueFromId,
        )
      : undefined;
    const legacy = normalizedLegacy.continueFromId
      ? {
          ...normalizedLegacy,
          continueLineageId:
            normalizedLegacy.continueLineageId ??
            legacySource?.lineageId ??
            legacySource?.id ??
            normalizedLegacy.continueFromId,
        }
      : normalizedLegacy;
    restored.player.trainingJobs = [
      legacy,
      ...restored.player.trainingJobs.filter((job) => job.id !== legacy.id),
    ];
  }
  restored.player.trainingJob = restored.player.trainingJobs[0] ?? null;
  // One authoritative scheduler replaces the two legacy singular pending
  // fields. Backfill mirrors once, then keep unique IDs for concurrent work.
  const evaluationQueue: PrivateEvaluationJob[] =
    ensureArray<PrivateEvaluationJob>(
      restored.player.privateEvaluationJobs,
    ).map((entry): PrivateEvaluationJob => {
      const scheduledDay = Math.max(0, entry.scheduledDay ?? 0);
      const readyDay = Math.max(scheduledDay, entry.readyDay ?? 0);
      if (
        entry.kind === "checkpoint_evaluation" ||
        entry.kind === "released_model_evaluation"
      ) {
        return {
          ...entry,
          scheduledDay,
          readyDay,
          pending: {
            ...entry.pending,
            request: {
              ...entry.pending.request,
              suiteIds: [...entry.pending.request.suiteIds],
            },
            quote: {
              ...entry.pending.quote,
              suiteIds: [...entry.pending.quote.suiteIds],
            },
          },
        };
      }
      return {
        ...entry,
        scheduledDay,
        readyDay,
        pending: {
          ...entry.pending,
          id: entry.pending.id ?? entry.id,
          suiteIds: entry.pending.suiteIds
            ? [...entry.pending.suiteIds]
            : undefined,
        },
      };
    });
  const queuedIds = new Set(evaluationQueue.map((entry) => entry.id));
  for (const job of restored.player.trainingJobs) {
    const pending = job.pendingBenchmark;
    if (!pending || queuedIds.has(pending.id)) continue;
    evaluationQueue.push({
      id: pending.id,
      kind: "training_benchmark",
      subjectId: job.id,
      scheduledDay: pending.startedDay,
      readyDay: pending.readyDay,
      pending,
    });
    queuedIds.add(pending.id);
  }
  for (const checkpoint of restored.player.trainingCheckpoints) {
    const pending = checkpoint.pendingEvaluation;
    if (!pending || queuedIds.has(pending.id)) continue;
    evaluationQueue.push({
      id: pending.id,
      kind: "checkpoint_evaluation",
      subjectId: checkpoint.id,
      scheduledDay: pending.scheduledDay,
      readyDay: pending.readyDay,
      pending,
    });
    queuedIds.add(pending.id);
  }
  const validTrainingJobIds = new Set(
    restored.player.trainingJobs.map((job) => job.id),
  );
  const ownership = reconcileCheckpointOwnership({
    checkpoints: restored.player.trainingCheckpoints,
    privateEvaluationJobs: evaluationQueue.filter(
      (entry) =>
        entry.kind !== "training_benchmark" ||
        validTrainingJobIds.has(entry.subjectId),
    ),
    models: restored.player.models,
    jobs: restored.player.trainingJobs,
  });
  restored.player.privateEvaluationJobs = ownership.privateEvaluationJobs;
  restored.player.trainingCheckpoints = ownership.checkpoints.map(
    (checkpoint) => ({
      ...checkpoint,
      pendingEvaluation: ownership.privateEvaluationJobs.find(
        (
          entry,
        ): entry is Extract<
          PrivateEvaluationJob,
          { kind: "checkpoint_evaluation" }
        > =>
          entry.kind === "checkpoint_evaluation" &&
          entry.subjectId === checkpoint.id,
      )?.pending,
    }),
  );
  const restoredTrainingJobs = restored.player.trainingJobs ?? [];
  restored.player.trainingJobs = restoredTrainingJobs.map((job) => ({
    ...job,
    pendingBenchmark: ownership.privateEvaluationJobs.find(
      (
        entry,
      ): entry is Extract<
        PrivateEvaluationJob,
        { kind: "training_benchmark" }
      > => entry.kind === "training_benchmark" && entry.subjectId === job.id,
    )?.pending,
  }));
  restored.player.trainingJob = restored.player.trainingJobs[0] ?? null;
  restored.player.pricing.plans = restored.player.pricing.plans.map((plan) => ({
    ...plan,
    subscriberCap:
      Number.isFinite(plan.subscriberCap) && (plan.subscriberCap ?? 0) > 0
        ? Math.max(1, Math.floor(plan.subscriberCap!))
        : undefined,
    acceptingNew: plan.acceptingNew !== false,
    steadyUsageTarget:
      plan.steadyUsageTarget ?? defaultSteadyPlanUsage(plan.pricePerMonth),
    dataCollectionRate: clampPlanDataCollectionRate(
      plan.pricePerMonth,
      plan.dataCollectionRate ??
        defaultPlanDataCollectionRate(plan.pricePerMonth),
    ),
    demandShocks: ensureArray(plan.demandShocks),
    modalityRoutes: plan.modalityRoutes ?? normalizedPlanRoutes(restored, plan),
  }));
  restored.player.dataSupplierContracts = ensureArray<DataSupplierContract>(
    restored.player.dataSupplierContracts,
  ).map(normalizeDataSupplierContract);
  restored.player.dataSupplierOffers = ensureArray<DataSupplierContract>(
    restored.player.dataSupplierOffers,
  ).map(normalizeDataSupplierContract);
  restored.player.safetyCampaign = restored.player.safetyCampaign ?? null;
  restored.player = ensureModelStudio(restored.player);
  restored.player.researchUnlocked = ensureArray(
    restored.player.researchUnlocked,
  );
  restored.player.researchQueue = ensureArray(restored.player.researchQueue);
  restored.player.chips = ensureArray(restored.player.chips);
  // Keep the Power panel trend inside its 30-day window and drop corrupt samples.
  restored.player.powerEfficiencyHistory = ensureArray<PowerEfficiencySample>(
    restored.player.powerEfficiencyHistory,
  )
    .filter(
      (sample) =>
        sample &&
        Number.isFinite(sample.day) &&
        Number.isFinite(sample.pfPerMw),
    )
    .map((sample) => ({
      day: Math.floor(sample.day),
      pfPerMw: Math.max(0, sample.pfPerMw),
      ...(Number.isFinite(sample.localPf)
        ? { localPf: Math.max(0, sample.localPf!) }
        : {}),
      ...(Number.isFinite(sample.cloudPf)
        ? { cloudPf: Math.max(0, sample.cloudPf!) }
        : {}),
      ...(Number.isFinite(sample.localMw)
        ? { localMw: Math.max(0, sample.localMw!) }
        : {}),
      ...(Number.isFinite(sample.combinedEffectivePf)
        ? { combinedEffectivePf: Math.max(0, sample.combinedEffectivePf!) }
        : {}),
      ...(Number.isFinite(sample.cloudEffectivePf)
        ? { cloudEffectivePf: Math.max(0, sample.cloudEffectivePf!) }
        : {}),
    }))
    .slice(-30);
  restored.rivals = (ensureArray(restored.rivals) as SimState["rivals"]).map(
    (rival) => {
      const canonicalJobs = ensureArray<TrainingJob>(rival.trainingJobs).map(
        normalizeTrainingJob,
      );
      if (canonicalJobs.length === 0 && rival.trainingJob) {
        canonicalJobs.push(rivalJobToCanonical(rival.trainingJob));
      }
      return {
        ...rival,
        capital: normalizeCapitalStack(rival.capital),
        rackFleet: ensureArray<RackInstall>(rival.rackFleet).map((rack) => ({
          ...rack,
          facilityId:
            typeof rack.facilityId === "string" && rack.facilityId.trim()
              ? rack.facilityId
              : undefined,
          bayStarts: ensureArray<number>(rack.bayStarts)
            .slice(0, Math.max(0, Math.floor(rack.count)))
            .map((value) =>
              Number.isSafeInteger(value) && value >= 0 ? value : -1,
            ),
          unitIds: ensureArray<string>(rack.unitIds).slice(
            0,
            Math.max(0, Math.floor(rack.count)),
          ),
        })),
        rackDesigns: ensureArray(rival.rackDesigns),
        models: (ensureArray(rival.models) as Model[]).map(
          normalizeModelComputeV2,
        ),
        financialComeback: normalizeRivalFinancialComeback(rival),
        trainingJobs: canonicalJobs,
        researchQueue: ensureArray(rival.researchQueue),
        strategy: rival.strategy ?? {
          profileId: rival.archetype,
          goal:
            rival.servicePain && rival.servicePain > 0.25
              ? "restore_service"
              : "ship_model",
          beliefs: {
            observedDay: restored.day,
            frontierCapability: Math.max(
              0,
              ...restored.player.models.map((model) => model.capability),
            ),
            marketPricePerMTok: Math.max(
              API_PRICE_EPSILON,
              restored.player.pricing.apiPricePerMTok,
            ),
            demandGrowth: 0,
            confidence:
              restored.config.difficulty === "hard"
                ? 0.88
                : restored.config.difficulty === "easy"
                  ? 0.58
                  : 0.72,
          },
          plan: [],
          memory: [],
          cooldowns: {},
          decisionRevision: 0,
          lastOperationalDay: restored.day,
          lastTacticalDay: restored.day,
          lastStrategicDay: restored.day,
        },
      };
    },
  );
  if (restored.labs && typeof restored.labs === "object") {
    restored.labs = Object.fromEntries(
      Object.entries(restored.labs).map(([labId, lab]) => [
        labId,
        { ...lab, capital: normalizeCapitalStack(lab.capital) },
      ]),
    );
  }
  restored.computeLeases = ensureArray(restored.computeLeases);
  restored.computeContracts = ensureArray(restored.computeContracts);
  restored.cityPowerContracts = ensureArray(restored.cityPowerContracts);
  restored.powerExportContracts = ensureArray(restored.powerExportContracts);
  restored.siteProjects = ensureArray(restored.siteProjects);
  restored.siteCapacities = ensureArray(restored.siteCapacities);
  restored.facilityMarket = {
    offers: ensureArray(restored.facilityMarket?.offers),
  };
  restored.energyContracts = ensureArray(restored.energyContracts);
  restored.regionInterconnections = ensureArray(
    restored.regionInterconnections,
  );
  restored.segments = ensureArray(restored.segments);
  restored.domainHeat = normalizeDomainHeat(restored.domainHeat);
  if (
    restored.catchUpCampaign &&
    typeof restored.catchUpCampaign.rivalId === "string" &&
    restored.catchUpCampaign.rivalId.length > 0
  ) {
    restored.catchUpCampaign = {
      rivalId: restored.catchUpCampaign.rivalId,
      armedDay: Math.max(
        1,
        Math.floor(restored.catchUpCampaign.armedDay ?? restored.day ?? 1),
      ),
    };
  } else {
    restored.catchUpCampaign = undefined;
  }
  if (restored.lastMarket) {
    const legacyDirect = Math.max(0, restored.lastMarket.apiDayCogs ?? 0);
    restored.lastMarket = {
      ...restored.lastMarket,
      apiDayDirectCogs: Math.max(
        0,
        restored.lastMarket.apiDayDirectCogs ?? legacyDirect,
      ),
      apiDayAllocatedOps: Math.max(
        0,
        restored.lastMarket.apiDayAllocatedOps ?? 0,
      ),
      modelFinance: ensureArray<ModelFinanceRow>(
        restored.lastMarket.modelFinance,
      ).map((row) => {
        const direct = Math.max(0, row.dayApiDirectCogs ?? row.dayApiCogs ?? 0);
        return {
          ...row,
          dayApiDirectCogs: direct,
          dayApiAllocatedOps: Math.max(0, row.dayApiAllocatedOps ?? 0),
          dayApiContribution:
            row.dayApiContribution ?? row.dayApiRevenue - direct,
          apiCapacityUtilization: Math.max(0, row.apiCapacityUtilization ?? 0),
        };
      }),
      computeLedger: restored.lastMarket.computeLedger
        ? {
            ...restored.lastMarket.computeLedger,
            items: ensureArray<LegacyComputeWorkItem>(
              restored.lastMarket.computeLedger.items,
            ).map((item) => ({
              ...item,
              channel:
                item.channel ??
                (item.kind === "api_text" ? "api" : "subscription"),
            })),
          }
        : undefined,
    };
  }
  restored.victory = {
    ...restored.victory,
    dominanceQualifiedDays: restored.victory.dominanceQualifiedDays ?? 0,
    lastDominanceQualifiedDay: restored.victory.lastDominanceQualifiedDay ?? 0,
  };
  const restoredAudience = restored.segments.reduce(
    (sum, segment) => sum + Math.max(0, segment.size),
    0,
  );
  if (restoredAudience > WORLD_POPULATION) {
    const audienceScale = WORLD_POPULATION / restoredAudience;
    restored.segments = restored.segments.map((segment) => ({
      ...segment,
      size: Math.max(0, segment.size) * audienceScale,
    }));
  }
  const priorUsageWeight = restored.segments.reduce(
    (sum, segment) =>
      sum + Math.max(0, segment.size) * Math.max(0, segment.usageIntensity),
    0,
  );
  restored.segments = restored.segments.map((segment) => ({
    ...segment,
    usageIntensity: clampSegmentUsageIntensity(
      segment.id,
      segment.usageIntensity,
    ),
  }));
  const normalizedUsageWeight = restored.segments.reduce(
    (sum, segment) =>
      sum + Math.max(0, segment.size) * Math.max(0, segment.usageIntensity),
    0,
  );
  const usageRepairScale =
    priorUsageWeight > 0
      ? Math.max(0, Math.min(1, normalizedUsageWeight / priorUsageWeight))
      : 1;
  const demandModelRepairScale =
    restored.lastMarket?.demandModelVersion === DEMAND_MODEL_VERSION
      ? 1
      : ECONOMY.marketDailyActiveUsageShare;
  const demandRepairScale = usageRepairScale * demandModelRepairScale;
  if (demandRepairScale < 0.999 && restored.lastMarket) {
    const previousMarket = restored.lastMarket;
    const playerDemandMTok = Math.max(
      0,
      previousMarket.playerDemandMTok * demandRepairScale,
    );
    const servedMTok = Math.min(playerDemandMTok, previousMarket.servedMTok);
    const unservedRatio =
      playerDemandMTok > 0
        ? Math.max(
            0,
            1 - Math.min(1, previousMarket.capacityMTok / playerDemandMTok),
          )
        : 0;
    const demandPf =
      previousMarket.capacityMTok > 0
        ? previousMarket.capacityPf *
          (playerDemandMTok / previousMarket.capacityMTok)
        : Math.max(0, previousMarket.demandPf * demandRepairScale);
    const playerShare = previousMarket.sharesByLab[restored.playerLabId] ?? 0;
    const capacitySalesCapped = playerShare >= 0.5 && unservedRatio > 0.005;
    restored.lastMarket = {
      ...previousMarket,
      demandModelVersion: DEMAND_MODEL_VERSION,
      demandMTok: Math.max(0, previousMarket.demandMTok * demandRepairScale),
      playerDemandMTok,
      servedMTok,
      unservedRatio,
      servicePain: Math.min(previousMarket.servicePain, unservedRatio),
      apiDemandMTok: Math.max(
        0,
        (previousMarket.apiDemandMTok ?? 0) * demandRepairScale,
      ),
      apiDayMTok: Math.min(
        previousMarket.apiDayMTok,
        Math.max(0, (previousMarket.apiDemandMTok ?? 0) * demandRepairScale),
      ),
      demandPf,
      servedPf: Math.min(demandPf, Math.max(0, previousMarket.capacityPf)),
      industryDemandMTok: Math.max(
        0,
        (previousMarket.industryDemandMTok ?? previousMarket.demandMTok) *
          demandRepairScale,
      ),
      apiServeFrac: unservedRatio > 0 ? Math.max(0, 1 - unservedRatio) : 1,
      capacitySalesCapped,
      blockedApiMTok: capacitySalesCapped
        ? Math.max(0, (previousMarket.blockedApiMTok ?? 0) * demandRepairScale)
        : 0,
    };
    restored.player.servicePain = Math.min(
      restored.player.servicePain ?? 0,
      unservedRatio,
    );
  }
  // Live models missing a ship day start aging from now so old saves don't
  // take a retroactive staleness cliff.
  const releaseDayFallback = Math.max(1, restored.day);
  const withReleaseDay = (model: Model): Model => {
    if (Number.isFinite(model.releaseDay) && model.releaseDay > 0) return model;
    if (model.release === "released" || model.shipped) {
      return { ...model, releaseDay: releaseDayFallback };
    }
    return { ...model, releaseDay: model.releaseDay ?? 0 };
  };
  const migrateListing = (model: Model, planIds: ReadonlySet<string>): Model => {
    const recipes = migrateEffortRecipes(model.productProfile);
    const productProfile = model.productProfile
      ? {
          ...model.productProfile,
          effortRecipes: recipes,
          defaultEffortId: defaultEffortIdOf({
            ...model.productProfile,
            effortRecipes: recipes,
          }),
        }
      : model.productProfile;
    const listed =
      model.commerciallyOffered === true ||
      model.commerciallyOffered === false
        ? model.commerciallyOffered
        : (model.release === "released" || model.shipped === true) &&
          (model.apiPriceInPerMTok != null ||
            model.apiPricePerMTok != null ||
            planIds.has(model.id));
    return {
      ...model,
      productProfile,
      commerciallyOffered: listed,
    };
  };
  const playerPlanModelIds = new Set(
    (restored.player.pricing.plans ?? []).flatMap((plan) => plan.modelIds),
  );
  restored.player.models = restored.player.models.map((model) =>
    migrateListing(withReleaseDay(model), playerPlanModelIds),
  );
  restored.rivals = restored.rivals.map((rival) => {
    const rivalPlanIds = new Set(
      (rival.pricing?.plans ?? []).flatMap((plan) => plan.modelIds ?? []),
    );
    return {
      ...rival,
      models: rival.models.map((model) =>
        migrateListing(withReleaseDay(model), rivalPlanIds),
      ),
    };
  });
  // Throttle-policy era defaults for older saves.
  restored.player.speedStrain = Math.max(
    0,
    Math.min(1, restored.player.speedStrain ?? 0),
  );
  restored.player.apiSpeedStrain = Math.max(
    0,
    Math.min(1, restored.player.apiSpeedStrain ?? restored.player.speedStrain),
  );
  restored.player.subSpeedStrain = Math.max(
    0,
    Math.min(1, restored.player.subSpeedStrain ?? restored.player.speedStrain),
  );
  restored.player.apiSurgeLevel = Math.max(
    0,
    Math.min(1, restored.player.apiSurgeLevel ?? 0),
  );
  restored.player.pricing = {
    ...restored.player.pricing,
    serveThrottlePolicy:
      restored.player.pricing.serveThrottlePolicy ?? "balanced",
    serveSlowdownLimit:
      Number.isFinite(restored.player.pricing.serveSlowdownLimit)
        ? Math.max(0, Math.min(1, restored.player.pricing.serveSlowdownLimit!))
        : legacyServeControls(restored.player.pricing.serveThrottlePolicy)
            .slowdownLimit ?? DEFAULT_SERVE_SLOWDOWN_LIMIT,
    peakPricingPct:
      Number.isFinite(restored.player.pricing.peakPricingPct)
        ? Math.max(0, Math.min(100, restored.player.pricing.peakPricingPct!))
        : legacyServeControls(restored.player.pricing.serveThrottlePolicy)
            .peakPricingPct ?? DEFAULT_PEAK_PRICING_PCT,
    apiAcceptingNew: restored.player.pricing.apiAcceptingNew !== false,
    subsAcceptingNew: restored.player.pricing.subsAcceptingNew !== false,
  };
  restored.rivals = restored.rivals.map((rival) => ({
    ...rival,
    speedStrain: Math.max(0, Math.min(1, rival.speedStrain ?? 0)),
  }));
  restored.alerts = ensureArray(restored.alerts);
  restored.news = ensureArray(restored.news);
  restored.feedEvents = ensureArray<WorldFeedEvent>(restored.feedEvents)
    .filter(
      (event) =>
        event &&
        typeof event.id === "string" &&
        typeof event.title === "string" &&
        typeof event.body === "string" &&
        (event.category === "world" ||
          event.category === "models" ||
          event.category === "market" ||
          event.category === "rivals"),
    )
    .map((event) => ({
      ...event,
      day: Math.max(0, Math.floor(Number(event.day) || 0)),
    }))
    .slice(0, 96);
  restored.activeEvents = ensureArray(restored.activeEvents);
  restored.financeHistory = ensureArray(restored.financeHistory);
  restored.financeMonthlyHistory = ensureArray(restored.financeMonthlyHistory);
  restored.planStatsHistory = ensureArray(restored.planStatsHistory);
  restored.externalities = restored.externalities ?? {
    accounts: {},
    incidents: [],
  };
  restored.externalities.accounts =
    restored.externalities.accounts &&
    typeof restored.externalities.accounts === "object"
      ? restored.externalities.accounts
      : {};
  restored.externalities.incidents = ensureArray(
    restored.externalities.incidents,
  );
  restored.benchmarkSeasons = ensureArray(restored.benchmarkSeasons);
  restored.evaluations = ensureArray(restored.evaluations);
  restored.reviews = ensureArray(restored.reviews);
  restored.eventCooldowns = ensureRecord(restored.eventCooldowns);
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
  };
  restored.playerLabId = restored.playerLabId || "player";
  restored.worldMarkets = restored.worldMarkets ?? createWorldMarkets();
  const savedCloudProviders = ensureArray<CloudProvider>(
    restored.worldMarkets.cloudProviders,
  );
  restored.worldMarkets.cloudProviders = normalizeCloudProviders(
    savedCloudProviders.length > 0
      ? savedCloudProviders
      : createWorldMarkets().cloudProviders,
    restored.computeContracts,
    restored.day,
  );
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
    };
  }
  if (typeof restored.paused !== "boolean") restored.paused = true;
  if (
    restored.speed !== 0 &&
    restored.speed !== 1 &&
    restored.speed !== 2 &&
    restored.speed !== 5
  ) {
    restored.speed = 1;
  }
  if (typeof restored.tick !== "number") restored.tick = restored.day;
  restored.calendar = calendarForDay(
    restored.day,
    restored.config.campaignRules,
  );
  return syncLabIndex(
    refreshAllDataHallAnalyses(
      migrateHqOfficeLayouts(
        migrateDataHallLayouts(normalizeSiteEnergyState(restored)),
      ),
    ),
  );
}

export function buildSaveMeta(
  state: SimState,
  slotId: SaveSlotId,
  savedAt = new Date().toISOString(),
): SaveMeta {
  return {
    slotId,
    labName: state.config?.labName || state.player.name || "Labline",
    day: state.day,
    difficulty: state.config?.difficulty ?? "normal",
    seed: state.seed,
    cash: state.player.cash,
    valuation: state.player.finance?.valuation ?? 0,
    outcome: state.victory?.outcome ?? "playing",
    savedAt,
    campaignDate: formatCampaignDate(state.calendar),
    companyMark: state.config.companyMark,
    version: SAVE_VERSION,
    compatible: true,
  };
}

export function buildSaveFile(state: SimState, slotId: SaveSlotId): SaveFile {
  const synchronized = syncLabIndexForPersistence(state);
  const meta = buildSaveMeta(synchronized, slotId);
  const persisted = compactPersistedState(synchronized);
  const world =
    synchronized.map.storage === "compact" && synchronized.map.world
      ? synchronized.map.world.toSnapshot()
      : null;
  return jsonClone({
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    contentPackId: synchronized.config.campaignRules.contentPackId,
    meta,
    state: persisted,
    world,
  });
}

export function serializeSave(file: SaveFile): string {
  return JSON.stringify(file);
}

function validateSaveEnvelope(data: unknown): SaveFile {
  if (!data || typeof data !== "object")
    throw new SaveError("Invalid save file.");
  const candidate = data as { format?: unknown; version?: unknown };
  if (candidate.format !== SAVE_FORMAT)
    throw new SaveError("Not a Labline save file.");
  if (typeof candidate.version !== "number")
    throw new SaveError("Save is missing a version.");
  if (candidate.version === 1) {
    throw new SaveError(V1_INCOMPATIBILITY_REASON, "incompatible-version");
  }
  if (candidate.version === 2) {
    throw new SaveError(V2_INCOMPATIBILITY_REASON, "incompatible-version");
  }
  if (candidate.version === 3) {
    throw new SaveError(V3_INCOMPATIBILITY_REASON, "incompatible-version");
  }
  if (candidate.version > SAVE_VERSION) {
    throw new SaveError(
      `Save version ${candidate.version} is newer than this build (supports ${SAVE_VERSION}).`,
      "newer-version",
    );
  }
  if (
    candidate.version !== SAVE_VERSION &&
    candidate.version !== 13 &&
    candidate.version !== 12 &&
    candidate.version !== 11 &&
    candidate.version !== 10 &&
    candidate.version !== 9 &&
    candidate.version !== 8 &&
    candidate.version !== 7 &&
    candidate.version !== 6 &&
    candidate.version !== 5 &&
    candidate.version !== 4
  ) {
    throw new SaveError(
      `Unsupported save version ${candidate.version}.`,
      "incompatible-version",
    );
  }
  const file = data as SaveFile;
  if (!file.meta || !file.state)
    throw new SaveError("Save is missing metadata or simulation state.");
  if (
    !Number.isFinite(file.meta.day) ||
    file.meta.day < 1 ||
    typeof file.meta.labName !== "string" ||
    !file.meta.labName.trim() ||
    typeof file.meta.savedAt !== "string" ||
    Number.isNaN(Date.parse(file.meta.savedAt))
  ) {
    throw new SaveError(
      "Save metadata is damaged (company, day, or timestamp is invalid).",
    );
  }
  if (
    !Number.isFinite(file.state.day) ||
    file.state.day < 1 ||
    !file.state.player ||
    !file.state.map ||
    !file.state.config
  ) {
    throw new SaveError(
      "Simulation state is incomplete (day, company, or world data is missing).",
    );
  }
  const pinnedPack = file.state.config?.campaignRules?.contentPackId;
  const snapshotPack = file.state.industryDataPack?.id;
  if (
    !file.contentPackId ||
    !pinnedPack ||
    !snapshotPack ||
    file.contentPackId !== pinnedPack ||
    snapshotPack !== pinnedPack
  ) {
    throw new SaveError(
      "Save content-pack identity is missing or does not match the campaign.",
      "incompatible-version",
    );
  }
  return file;
}

export function inspectSaveCompatibility(data: unknown): {
  compatible: boolean;
  reason?: string;
} {
  try {
    validateSaveEnvelope(data);
    return { compatible: true };
  } catch (error) {
    return {
      compatible: false,
      reason:
        error instanceof SaveError ? error.message : "Save validation failed.",
    };
  }
}

function parseSaveObject(data: unknown): LoadedSaveFile {
  const file = validateSaveEnvelope(data);
  return { ...file, state: restoreState(file.state, file.world) };
}

/**
 * V3 campaigns are never migrated, but reusable rack designs are safe to copy
 * into profile persistence after validating them against the current catalog.
 */
export function extractV3RackBlueprints(json: string): RackDesign[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const candidate = parsed as {
    format?: unknown;
    version?: unknown;
    state?: { player?: { rackDesigns?: unknown } };
  };
  if (candidate.format !== SAVE_FORMAT || candidate.version !== 3) return [];
  if (!Array.isArray(candidate.state?.player?.rackDesigns)) return [];
  const valid: RackDesign[] = [];
  for (const raw of candidate.state.player.rackDesigns) {
    if (!raw || typeof raw !== "object") continue;
    const design = raw as RackDesign;
    if (
      typeof design.id !== "string" ||
      typeof design.name !== "string" ||
      typeof design.chassisId !== "string" ||
      !Array.isArray(design.placements)
    )
      continue;
    try {
      if (scoreDesign(design).valid) valid.push(design);
    } catch {
      // Retired or malformed modules are intentionally skipped.
    }
  }
  return valid;
}

export function parseSave(json: string): LoadedSaveFile {
  try {
    return parseSaveObject(JSON.parse(json));
  } catch (error) {
    if (error instanceof SaveError) throw error;
    throw new SaveError("Could not parse save file.");
  }
}

export async function listSaveSlots(): Promise<SaveMeta[]> {
  let records: StoredSaveRecord[];
  try {
    records = await getAllRecords();
  } catch {
    records = [...memoryRecords.values()];
  }
  const bySlot = new Map<SaveSlotId, SaveMeta>();
  for (const record of records) {
    if (!SAVE_SLOTS.includes(record.slotId)) continue;
    const rawMeta = record.meta as Partial<SaveMeta> | null | undefined;
    const version = record.file?.version ?? rawMeta?.version ?? 0;
    const fallback: SaveMeta = {
      slotId: record.slotId,
      labName:
        typeof rawMeta?.labName === "string" ? rawMeta.labName : "Damaged save",
      day: typeof rawMeta?.day === "number" ? rawMeta.day : 0,
      difficulty:
        typeof rawMeta?.difficulty === "string"
          ? rawMeta.difficulty
          : "unknown",
      seed: typeof rawMeta?.seed === "number" ? rawMeta.seed : 0,
      cash: typeof rawMeta?.cash === "number" ? rawMeta.cash : 0,
      valuation: typeof rawMeta?.valuation === "number" ? rawMeta.valuation : 0,
      outcome:
        typeof rawMeta?.outcome === "string" ? rawMeta.outcome : "unknown",
      savedAt:
        typeof rawMeta?.savedAt === "string"
          ? rawMeta.savedAt
          : new Date(0).toISOString(),
      campaignDate: rawMeta?.campaignDate,
      companyMark: rawMeta?.companyMark,
      version,
      compatible: false,
    };
    const inspection = inspectSaveCompatibility(record.file);
    if (inspection.compatible) {
      bySlot.set(record.slotId, {
        ...fallback,
        ...rawMeta,
        slotId: record.slotId,
        compatible: true,
        incompatibilityReason: undefined,
      });
    } else {
      bySlot.set(record.slotId, {
        ...fallback,
        compatible: false,
        incompatibilityReason: inspection.reason,
      });
    }
  }
  for (const meta of legacyMeta()) {
    if (!bySlot.has(meta.slotId)) bySlot.set(meta.slotId, meta);
  }
  return [...bySlot.values()].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

export async function hasAnySave(): Promise<boolean> {
  return (await listSaveSlots()).length > 0;
}

export async function hasAutosave(): Promise<boolean> {
  return (await listSaveSlots()).some((meta) => meta.slotId === "auto");
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

export async function writeSaveSlot(
  slotId: SaveSlotId,
  state: SimState,
): Promise<SaveMeta> {
  const file = buildSaveFile(state, slotId);
  const record: StoredSaveRecord = { slotId, meta: file.meta, file };
  try {
    await putRecord(record);
  } catch (error) {
    if (isQuotaError(error)) {
      throw new SaveError(
        "Save failed — browser storage is full. Delete an old slot and try again.",
        "quota",
      );
    }
    throw new SaveError(
      error instanceof Error ? error.message : "Save failed.",
      "storage",
    );
  }
  return file.meta;
}

export async function readSaveSlot(slotId: SaveSlotId): Promise<SimState> {
  let record: StoredSaveRecord | undefined;
  try {
    record = await getRecord(slotId);
  } catch (error) {
    throw new SaveError(
      error instanceof Error ? error.message : "Load failed.",
      "storage",
    );
  }
  if (record) return parseSaveObject(record.file).state;

  const raw = legacyStorage()?.getItem(legacySlotKey(slotId));
  if (raw) return parseSave(raw).state;
  throw new SaveError(`No save in slot ${slotId}.`, "not-found");
}

export async function deleteSaveSlot(slotId: SaveSlotId): Promise<void> {
  try {
    await removeRecord(slotId);
    legacyStorage()?.removeItem(legacySlotKey(slotId));
    const storage = legacyStorage();
    const rawIndex = storage?.getItem(LEGACY_INDEX_KEY);
    if (storage && rawIndex) {
      const index = JSON.parse(rawIndex) as LegacySaveIndex;
      if (index.slots) index.slots[slotId] = null;
      storage.setItem(LEGACY_INDEX_KEY, JSON.stringify(index));
    }
  } catch (error) {
    throw new SaveError(
      error instanceof Error ? error.message : "Delete failed.",
      "storage",
    );
  }
}

/** Return the newest compatible save, regardless of whether it was automatic or manual. */
export async function mostRecentSlotId(): Promise<SaveSlotId | null> {
  const saves = await listSaveSlots();
  if (saves.length === 0) return null;
  const compatible = saves.filter((meta) => meta.compatible);
  return compatible[0]?.slotId ?? saves[0]!.slotId;
}

/** In-memory serialization round trip; does not touch IndexedDB. */
export function roundTripState(state: SimState): SimState {
  const file = buildSaveFile(state, "1");
  return parseSave(serializeSave(file)).state;
}

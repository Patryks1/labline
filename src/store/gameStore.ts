import { create } from "zustand";
import { useUiStore } from "./uiStore";
import { createGame, type CreateGameOpts } from "../sim/createGame";
import { blendApiPrice, splitBlendedApiPrice } from "../sim/balance/pricing";
import { tickDay, computeSnapshot } from "../sim/tick";
import {
  startResearch,
  enqueueResearch,
  dequeueResearch,
  moveQueue,
  cancelActiveResearch,
} from "../sim/systems/research";
import {
  startTraining,
  advancePostTrain,
  selectPostTrain,
  cancelTraining,
  benchmarkTrainingJob,
  extendTraining,
  shipModel,
  keepInternal,
  releaseFromJob,
  releaseTrainingEarly,
  captureTrainingCheckpoint,
  createManualTrainingCheckpoint,
  forkTrainingCheckpoint,
  recoverFailedPostTrainFromCheckpoint,
  rollbackTrainingJobToCheckpoint,
  promoteTrainingCheckpoint,
  discardTrainingCheckpoint,
  releaseModel,
  deleteModel,
  archiveModel,
  restoreArchivedModel,
  setModelApiPrice,
  setDefaultEffort,
  setServedEffort,
  startEffortTraining,
  listReleasedModel,
  resolveTrainingCampaignEvent,
  resolvePostTrainPhase,
  playerTrainingJobs,
  withTrainingJobs,
  setTrainingLabs,
} from "../sim/systems/training";
import {
  scheduleCheckpointEvaluation,
  scheduleReleasedModelEvaluation,
} from "../sim/systems/checkpointEvaluations";
import type { CheckpointEvaluationRequest } from "../sim/balance/checkpointEvaluation";
import {
  createModelRouter,
  deleteModelRouter,
  investPostTrainGym,
  setActiveModelRouter,
  setRouterLane,
  teachToolSkill,
} from "../sim/systems/modelStudio";
import { applyLabAction } from "../sim/systems/labActionKernel";
import {
  setActiveBalanceTuning,
  resolveBalanceTuning,
  type BalanceTuning,
} from "../sim/balance/tuning";
import {
  cancelSafetyCampaign,
  startSafetyCampaign,
} from "../sim/systems/safetyCampaigns";
import {
  cancelRackOrder,
  orderRacksIntoDc,
  sellRacksFromDc,
} from "../sim/systems/dcRacks";
import {
  autoBalanceHosting,
  deployRackBatchAcrossHalls,
  fillAllAvailableRackBays,
  type RackDeploymentTarget,
} from "../sim/systems/hosting";
import {
  placeBuilding,
  upgradeBuilding,
  renameBuilding,
  mapTileAt,
} from "../sim/systems/map";
import { buyRivalDataCenter } from "../sim/systems/facilities";
import {
  acceptFacilityOffer,
  demolishFacility,
  submitFacilityOffer,
  withdrawFacilityOffer,
} from "../sim/systems/facilityMarket";
import {
  applyInstantCheat,
  type InstantCheatAction,
} from "../sim/systems/cheats";
import {
  applyHallPlan,
  migrateDataHallLayouts,
} from "../sim/systems/dataHallLayouts";
import {
  applyHqOfficePlan,
  migrateHqOfficeLayouts,
  type HqOfficePlan,
} from "../sim/systems/hqOffice";
import { facilityAnchorTiles } from "../sim/systems/worldAccess";
import type { DataHallEditPlan } from "../sim/types";
import {
  setChipDesignFocus,
  startFabCampaign,
  toggleChipDesignTech,
} from "../sim/systems/silicon";
import {
  hireTalent,
  buyDataPartnership,
  setMarketing,
  setMarketingChannel,
} from "../sim/systems/org";
import { loanOffers, takeLoan, repayLoan } from "../sim/systems/loans";
import {
  acceptFirmLoanOffer,
  declineFirmLoanOffer,
  submitLoanApplication,
} from "../sim/systems/sharedMarkets";
import {
  buyDataPortfolio,
  buyDataLotAmount,
  buyAllFilteredDataLots,
  cancelSynthGen,
  enqueueAllDataPrunes,
  enqueueDataPrune,
  enqueueProcess,
  enqueueProcessAll,
  setAutoProcess,
  setCollectionRate,
  startSynthGen,
  startSynthBudget,
  purchaseDataPruneAudit,
  listDataSupplierOffers,
  acceptDataSupplierOffer,
  acceptDataSupplierCounter,
  proposeDataSupplierTerms,
  counterDataSupplierOffer,
  rejectDataSupplierCounter,
  cancelDataSupplierContract,
  type DataPortfolioChannel,
} from "../sim/systems/data";
import {
  createPlan,
  deletePlan,
  MAX_PLANS,
  updatePlan,
} from "../sim/systems/plans";
import {
  deleteSaveSlot,
  listSaveSlots,
  mostRecentSlotId,
  readSaveSlot,
  type SaveMeta,
  type SaveSlotId,
  writeSaveSlot,
  SaveError,
} from "../sim/save";
import type {
  Allocation,
  DataDomain,
  DataSupplierTerms,
  ModelRouterLane,
  PanelId,
  PostTrainGymKind,
  ProductPricing,
  SimState,
  Speed,
  StartTrainingOpts,
  SubPlan,
  TrainingBenchmarkRequest,
  TrainingCampaignChoiceEffects,
  TrainingCheckpointBranchDirection,
  BuildableKind,
  ChipDesignFocus,
  ChipDesignTechId,
  MarketingChannel,
  CampaignRules,
  MapOverlayMode,
  MapToolMode,
  ToolSkillId,
} from "../sim/types";
import type { CommandViewId } from "../view/hud/navConfig";

type BuildKind = BuildableKind;
export type GamePhase = "menu" | "loading" | "playing";
export type { SaveMeta, SaveSlotId };

export type SaveResult =
  { ok: true; meta: SaveMeta } | { ok: false; error: string };
export type LoadResult = { ok: true } | { ok: false; error: string };

export interface GameLoadingState {
  operation: "new-game" | "load-game";
  message: string;
  progress: number;
}

/** Tiny placeholder so TypeScript consumers always have a state shape offline. */
function placeholderState(): SimState {
  return createGame({
    seed: 0,
    labName: "Labline",
    difficulty: "easy",
    advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
  });
}

export interface MapViewport {
  /** Conservative axis-aligned bounds retained for navigator follow behavior. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Exact footprint: screen bottom-left, bottom-right, top-right, top-left. */
  corners?: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
}

interface GameStore {
  phase: GamePhase;
  loading: GameLoadingState | null;
  lifecycleError: string | null;
  saveSlots: SaveMeta[];
  storageReady: boolean;
  saveStatus: "idle" | "saving" | "saved" | "error";
  state: SimState;
  activePanel: PanelId;
  rackWorkspaceTab: "fleet" | "hall" | "blueprints";
  hallEditorFacilityId: string | null;
  hqOfficeEditorFacilityId: string | null;
  selectedTile: { x: number; y: number } | null;
  selectedRivalId: string | null;
  mapTool: MapToolMode;
  mapOverlay: MapOverlayMode;
  mapViewport: MapViewport | null;
  fleetOwnerFilter: string | null;
  mapFocusRequest: {
    x: number;
    y: number;
    sequence: number;
    /** Keep the current main-map zoom when panning from the navigator. */
    preserveZoom: boolean;
  } | null;
  researchFocusRequest: { nodeId: string; sequence: number } | null;
  buildMode: BuildKind | null;
  /** Left workspace drawer open */
  leftRailOpen: boolean;
  /** Right command dock open */
  commandDockOpen: boolean;
  /** Active command dock view (P&L / trends / rivals / feed) */
  commandView: CommandViewId;
  hotkeyHelpOpen: boolean;
  /** In-run pause / save-load menu */
  pauseMenuOpen: boolean;
  setPanel: (p: PanelId) => void;
  openHallEditor: (facilityId: string) => void;
  closeHallEditor: () => void;
  applyHallEditorPlan: (plan: DataHallEditPlan) => {
    ok: boolean;
    error?: string;
    netCost: number;
  };
  openHqOfficeEditor: (facilityId: string) => void;
  closeHqOfficeEditor: () => void;
  applyHqOfficeEditorPlan: (plan: HqOfficePlan) => {
    ok: boolean;
    error?: string;
    netCost: number;
  };
  /** Open Infrastructure → Overview (map) and expand the left rail. */
  openSites: () => void;
  openInfrastructureOverview: () => void;
  /** Open Research, select the requested method, and center it in the tree. */
  openResearchNode: (nodeId: string) => void;
  /** Open Fleet → Racks and expand the left rail (never switches to Sites). */
  openFleet: () => void;
  openRackDesigner: (facilityId: string) => void;
  setRackWorkspaceTab: (tab: "fleet" | "hall" | "blueprints") => void;
  openFleetForOwner: (ownerId: string) => void;
  setSelectedRivalId: (id: string | null) => void;
  setMapTool: (tool: MapToolMode) => void;
  setMapOverlay: (overlay: MapOverlayMode) => void;
  setMapViewport: (viewport: MapViewport | null) => void;
  selectTile: (x: number, y: number | null) => void;
  focusMapTile: (x: number, y: number) => void;
  /** Pan without changing selection, build mode, or main-map zoom. */
  panMapToTile: (x: number, y: number) => void;
  clearSelection: () => void;
  setBuildMode: (k: BuildKind | null) => void;
  setLeftRailOpen: (open: boolean) => void;
  toggleLeftRail: () => void;
  setCommandDockOpen: (open: boolean) => void;
  toggleCommandDock: () => void;
  setCommandView: (v: CommandViewId) => void;
  setHotkeyHelpOpen: (open: boolean) => void;
  toggleHotkeyHelp: () => void;
  setPauseMenuOpen: (open: boolean) => void;
  togglePauseMenu: () => void;
  setSpeed: (s: Speed) => void;
  setPaused: (p: boolean) => void;
  setAutoPause: (
    key: keyof CampaignRules["autoPause"],
    enabled: boolean,
  ) => void;
  /** Adjust player cash from the explicitly scoped in-run cheat settings. */
  adjustCheatMoney: (delta: number) => boolean;
  /** Complete a supported in-progress operation and return the affected count. */
  runInstantCheat: (action: InstantCheatAction) => number;
  togglePause: () => void;
  stepDay: () => void;
  setAllocation: (a: Partial<Allocation>) => void;
  startResearch: (nodeId: string) => void;
  enqueueResearch: (nodeId: string) => void;
  dequeueResearch: (nodeId: string) => void;
  moveQueue: (nodeId: string, dir: -1 | 1) => void;
  cancelActiveResearch: () => void;
  setChipDesignFocus: (focus: ChipDesignFocus) => void;
  toggleChipDesignTech: (techId: ChipDesignTechId) => void;
  startTraining: (opts: StartTrainingOpts) => void;
  setTrainingPriority: (
    jobId: string,
    priority: number,
    reservedPf?: number,
  ) => void;
  pauseTraining: (jobId: string, paused: boolean) => void;
  extendTraining: (jobId: string) => void;
  resolveTrainingCampaignEvent: (
    jobId: string,
    choiceId: string,
    customEffects?: TrainingCampaignChoiceEffects,
  ) => void;
  resolvePostTrainPhase: (
    jobId: string,
    decision: {
      kind: "start" | "skip";
      postTrainWeights?: Partial<Record<DataDomain, number>>;
      postTrainMTok?: number;
    },
  ) => void;
  /** Auto-extend at the recommendation milestone instead of pausing. */
  setTrainingAutoExtend: (jobId: string, on: boolean) => void;
  /** Auto-advance to the next post-training stage when one completes. */
  setTrainingAutoChain: (jobId: string, on: boolean) => void;
  /** Merge balance-tuning overrides (pause-menu Balance tab). */
  setBalanceTuning: (patch: Partial<BalanceTuning>) => void;
  /** Restore all balance-tuning knobs to defaults. */
  resetBalanceTuning: () => void;
  cancelTraining: (jobId: string) => void;
  selectPostTrain: (
    jobId: string,
    stage: Exclude<import("../sim/types").PostTrainStage, "none">,
  ) => void;
  investPostTrainGym: (kind: PostTrainGymKind, packageId: string) => void;
  setTrainingLabs: (jobId: string, kinds: PostTrainGymKind[]) => void;
  teachToolSkill: (skillId: ToolSkillId, packageId: string) => void;
  createModelRouter: (name?: string) => void;
  setRouterLane: (
    routerId: string,
    lane: ModelRouterLane,
    modelId: string | null,
  ) => void;
  setActiveModelRouter: (routerId: string | null) => void;
  deleteModelRouter: (routerId: string) => void;
  benchmarkTrainingJob: (
    jobId: string,
    request?: TrainingBenchmarkRequest,
  ) => void;
  advancePostTrain: (jobId?: string) => void;
  shipModel: () => void;
  keepInternal: (jobId?: string) => void;
  releaseFromJob: (jobId?: string, opts?: { list?: boolean }) => void;
  releaseTrainingEarly: (jobId: string) => void;
  captureTrainingCheckpoint: (jobId: string) => void;
  createManualTrainingCheckpoint: (request: {
    sourceJobId: string;
    label?: string;
    branchDirection?: TrainingCheckpointBranchDirection;
  }) => void;
  forkTrainingCheckpoint: (request: {
    checkpointId: string;
    direction: TrainingCheckpointBranchDirection;
    label?: string;
    weights?: Partial<Record<DataDomain, number>>;
    specializationFocus?: import("../sim/types").SpecializationFocus;
  }) => void;
  rollbackTrainingJobToCheckpoint: (request: {
    jobId: string;
    checkpointId: string;
  }) => void;
  recoverFailedPostTrainFromCheckpoint: (request: {
    jobId: string;
    checkpointId: string;
  }) => void;
  promoteTrainingCheckpoint: (checkpointId: string) => void;
  discardTrainingCheckpoint: (checkpointId: string) => void;
  scheduleCheckpointEvaluation: (
    checkpointId: string,
    request: CheckpointEvaluationRequest,
  ) => void;
  scheduleReleasedModelEvaluation: (
    modelId: string,
    request: CheckpointEvaluationRequest,
  ) => void;
  releaseModel: (id: string, opts?: { list?: boolean }) => void;
  archiveModel: (id: string) => void;
  restoreArchivedModel: (id: string) => void;
  deleteModel: (id: string) => void;
  setModelApiPrice: (id: string, price: number | null) => void;
  setDefaultEffort: (id: string, effort: string) => void;
  setServedEffort: (id: string, effort: string, served: boolean) => void;
  startEffortTraining: (request: {
    id: string;
    name: string;
    thinkingTokenMult: number;
    trainPfDays?: number;
  }) => void;
  listReleasedModel: (request: {
    modelId: string;
    sell: boolean;
    apiIn?: number | null;
    apiOut?: number | null;
    planIds?: readonly string[];
  }) => void;
  setModelApiInOut: (
    id: string,
    priceIn: number | null,
    priceOut: number | null,
  ) => void;
  applyModelApiMarkup: (id: string, markupPct: number) => void;
  startSafetyCampaign: (
    modelId: string,
    intensity: import("../sim/types").SafetyCampaignIntensity,
    researchers: number,
  ) => void;
  cancelSafetyCampaign: () => void;
  /** Order complete racks into a data hall (x,y). */
  orderRacks: (x: number, y: number, skuId: string, count: number) => void;
  /** Sell live racks from a hall to free bays / recoup cash. */
  sellRacks: (x: number, y: number, skuId: string, count: number) => void;
  cancelRackOrder: (x: number, y: number, skuId: string, count: number) => void;
  /** Rebalance allocation + order racks toward ~80% serve compute / VRAM needs */
  autoBalanceHosting: () => void;
  /** Queue racks to reserve every free bay in every completed data hall. */
  fillAllAvailableRackBays: () => void;
  deployRackBatch: (
    skuId: string,
    targets: RackDeploymentTarget[],
    count: number,
  ) => void;
  setPricing: (p: Partial<ProductPricing>) => void;
  setActiveModel: (id: string) => void;
  createPlan: (input: {
    name: string;
    pricePerMonth: number;
    usageMultiplier: number;
    modelIds?: string[];
    includedMTokPerMonth?: number;
    monthlyApiValueSubsidyGbp?: number;
  }) => void;
  updatePlan: (planId: string, patch: Partial<SubPlan>) => void;
  deletePlan: (planId: string) => void;
  placeBuilding: (kind?: BuildKind) => void;
  upgradeBuilding: () => void;
  /** Rename selected / given player building (multi-tile campuses included). */
  renameBuilding: (x: number, y: number, name: string) => void;
  submitFacilityOffer: (facilityId: string, amount: number) => void;
  withdrawFacilityOffer: (offerId: string) => void;
  acceptFacilityOffer: (offerId: string) => void;
  /** Compatibility purchase action for map/fleet callers. */
  buyRivalDataCenter: (x: number, y: number) => void;
  demolishFacility: (facilityId: string) => void;
  startFab: () => void;
  hireTalent: () => void;
  buyData: () => void;
  buyDataPortfolio: (
    budget: number,
    mix: Record<DataPortfolioChannel, number>,
  ) => void;
  listDataSupplierOffers: () => ReturnType<typeof listDataSupplierOffers>;
  acceptDataSupplierOffer: (offerId: string, priceMultiplier?: number) => void;
  proposeDataSupplierTerms: (
    supplierId: string,
    terms: DataSupplierTerms,
  ) => void;
  counterDataSupplierOffer: (
    contractId: string,
    terms: DataSupplierTerms,
  ) => void;
  acceptDataSupplierCounter: (contractId: string) => void;
  rejectDataSupplierCounter: (contractId: string) => void;
  cancelDataSupplierContract: (contractId: string) => void;
  buyDataLotAmount: (lotId: string, amountMTok: number) => void;
  buyAllFilteredDataLots: (offerIds: readonly string[]) => void;
  setMarketing: (n: number) => void;
  setMarketingChannel: (channel: MarketingChannel, n: number) => void;
  takeLoan: (offerId: string) => void;
  takeCustomLoan: (opts: {
    principal: number;
    termDays: number;
    label?: string;
  }) => void;
  acceptLoanOffer: (offerId: string) => void;
  declineLoanOffer: (offerId: string) => void;
  repayLoan: (loanId: string, amount?: number) => void;
  setCollectionRate: (n: number) => void;
  setAutoProcess: (on: boolean) => void;
  enqueueProcess: (
    domain: DataDomain,
    amount: number,
    qualityTarget?: number,
  ) => void;
  enqueueProcessAll: () => void;
  enqueueDataPrune: (domain: DataDomain) => void;
  enqueueAllDataPrunes: () => void;
  purchaseDataPruneAudit: () => void;
  startSynthGen: (opts: {
    domain: DataDomain;
    modelId: string;
    targetMTok?: number;
    researchShare: number;
    qualityTier?: "hq" | "lq";
  }) => void;
  startSynthBudget: (opts: {
    researchShare: number;
    teacherModelIds?: Partial<Record<DataDomain, string>>;
  }) => void;
  cancelSynthGen: (jobId: string) => void;
  dismissOnboarding: () => void;
  setOnboardingDismissed: (dismissed: boolean) => void;
  /** Open new-game menu (does not start a run). */
  newGame: () => Promise<void>;
  /** Start a run from menu config. */
  startGame: (opts: CreateGameOpts) => Promise<LoadResult>;
  refreshSaves: () => Promise<SaveMeta[]>;
  listSaves: () => SaveMeta[];
  hasSave: () => boolean;
  saveGame: (slotId?: SaveSlotId) => Promise<SaveResult>;
  quickSave: () => Promise<SaveResult>;
  flushAutosave: () => Promise<SaveResult | null>;
  loadGame: (slotId: SaveSlotId) => Promise<LoadResult>;
  continueGame: () => Promise<LoadResult>;
  deleteSave: (slotId: SaveSlotId) => Promise<void>;
  clearLifecycleError: () => void;
  snapshot: () => ReturnType<typeof computeSnapshot>;
}

const AUTOSAVE_MIN_INTERVAL_MS = 5_000;
const AUTOSAVE_FORCE_DAYS = 5;
let autosaveDirty = false;
let lastAutosaveAt = 0;
let lastPersistedDay = 1;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let autosaveInFlight: Promise<SaveResult | null> | null = null;
let forcedAutosaveRequested = 0;
let forcedAutosavePersisted = 0;

export type GameSaveWriter = (
  slotId: SaveSlotId,
  state: SimState,
) => Promise<SaveMeta>;
let saveSlotWriter: GameSaveWriter = writeSaveSlot;

/** Deterministic write barrier for store concurrency tests. */
export function setGameSaveWriterForTests(writer?: GameSaveWriter): void {
  saveSlotWriter = writer ?? writeSaveSlot;
}

type StoreGet = () => GameStore;
type StoreSet = (partial: Partial<GameStore>) => void;

function mergeSaveMeta(saves: readonly SaveMeta[], meta: SaveMeta): SaveMeta[] {
  return [
    meta,
    ...saves.filter((candidate) => candidate.slotId !== meta.slotId),
  ].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

function clearAutosaveTimer() {
  if (autosaveTimer !== undefined) clearTimeout(autosaveTimer);
  autosaveTimer = undefined;
}

function resetAutosaveTracking(day: number) {
  clearAutosaveTimer();
  autosaveDirty = false;
  lastPersistedDay = day;
  lastAutosaveAt = 0;
}

function yieldForPaint(): Promise<void> {
  if (typeof requestAnimationFrame === "function") {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function persistAutosave(
  get: StoreGet,
  set: StoreSet,
  force: boolean,
): Promise<SaveResult | null> {
  const current = get();
  if (current.phase !== "playing" || (!force && !autosaveDirty)) return null;
  if (force) forcedAutosaveRequested++;
  if (autosaveInFlight) return autosaveInFlight;
  clearAutosaveTimer();
  autosaveInFlight = (async () => {
    let result: SaveResult | null = null;
    let writeAgain = true;
    while (writeAgain) {
      clearAutosaveTimer();
      const targetForceGeneration = forcedAutosaveRequested;
      const snapshot = get().state;
      set({ saveStatus: "saving" });
      try {
        const meta = await saveSlotWriter("auto", snapshot);
        lastAutosaveAt = Date.now();
        lastPersistedDay = snapshot.day;
        autosaveDirty =
          get().phase === "playing" && get().state.day > snapshot.day;
        forcedAutosavePersisted = Math.max(
          forcedAutosavePersisted,
          targetForceGeneration,
        );
        set({
          saveStatus: "saved",
          saveSlots: mergeSaveMeta(get().saveSlots, meta),
          storageReady: true,
        });
        result = { ok: true as const, meta };
      } catch (error) {
        const message =
          error instanceof SaveError ? error.message : "Autosave failed.";
        set({ saveStatus: "error" });
        return { ok: false as const, error: message };
      }
      writeAgain = forcedAutosaveRequested > forcedAutosavePersisted;
      if (!writeAgain && autosaveDirty) scheduleAutosave(get, set);
    }
    return result;
  })().finally(() => {
    autosaveInFlight = null;
  });
  return autosaveInFlight;
}

function scheduleAutosave(get: StoreGet, set: StoreSet) {
  autosaveDirty = true;
  const state = get().state;
  const earliest = Math.max(
    0,
    lastAutosaveAt + AUTOSAVE_MIN_INTERVAL_MS - Date.now(),
  );
  const forcedByDays = state.day - lastPersistedDay >= AUTOSAVE_FORCE_DAYS;
  const delay = forcedByDays
    ? earliest
    : Math.max(earliest, AUTOSAVE_MIN_INTERVAL_MS);
  if (autosaveTimer !== undefined && !forcedByDays) return;
  clearAutosaveTimer();
  autosaveTimer = setTimeout(() => {
    autosaveTimer = undefined;
    void persistAutosave(get, set, false);
  }, delay);
}

function applyLoadedState(state: SimState) {
  return {
    phase: "playing" as const,
    loading: null,
    lifecycleError: null,
    state: { ...state, paused: true },
    activePanel: "stats" as PanelId,
    rackWorkspaceTab: "fleet" as const,
    hallEditorFacilityId: null,
    hqOfficeEditorFacilityId: null,
    selectedTile: null,
    selectedRivalId: null,
    mapTool: "select" as MapToolMode,
    mapOverlay: "zones" as MapOverlayMode,
    mapViewport: null,
    fleetOwnerFilter: null,
    mapFocusRequest: null,
    researchFocusRequest: null,
    buildMode: null,
    leftRailOpen: false,
    commandDockOpen: false,
    commandView: "pnl" as CommandViewId,
    hotkeyHelpOpen: false,
    pauseMenuOpen: false,
  };
}

export const useGameStore = create<GameStore>((set, get) => ({
  phase: "menu",
  loading: null,
  lifecycleError: null,
  saveSlots: [],
  storageReady: false,
  saveStatus: "idle",
  state: placeholderState(),
  activePanel: "stats",
  rackWorkspaceTab: "fleet",
  hallEditorFacilityId: null,
  hqOfficeEditorFacilityId: null,
  selectedTile: null,
  selectedRivalId: null,
  mapTool: "select" as MapToolMode,
  mapOverlay: "zones" as MapOverlayMode,
  mapViewport: null,
  fleetOwnerFilter: null,
  mapFocusRequest: null,
  researchFocusRequest: null,
  buildMode: null,
  leftRailOpen: true,
  commandDockOpen: true,
  commandView: "pnl",
  hotkeyHelpOpen: false,
  pauseMenuOpen: false,

  setPanel: (p) =>
    set({
      activePanel: p,
      // Opening a panel re-expands the drawer
      leftRailOpen: true,
      // Leaving Sites ends build placement so Fleet/other workspaces stay put
      buildMode: p === "map" ? get().buildMode : null,
    }),

  openSites: () =>
    set({
      activePanel: "map",
      leftRailOpen: true,
    }),

  openInfrastructureOverview: () =>
    set({
      activePanel: "map",
      leftRailOpen: true,
      buildMode: null,
    }),

  openResearchNode: (nodeId) =>
    set((store) => ({
      activePanel: "research",
      leftRailOpen: true,
      buildMode: null,
      researchFocusRequest: {
        nodeId,
        sequence: (store.researchFocusRequest?.sequence ?? 0) + 1,
      },
    })),
  openHallEditor: (hallEditorFacilityId) =>
    set((store) => ({
      state: migrateDataHallLayouts(store.state),
      hallEditorFacilityId,
      hqOfficeEditorFacilityId: null,
      leftRailOpen: false,
      commandDockOpen: false,
    })),
  closeHallEditor: () => set({ hallEditorFacilityId: null }),
  applyHallEditorPlan: (plan) => {
    const result = applyHallPlan(get().state, plan);
    if (result.ok) set({ state: result.state });
    return { ok: result.ok, error: result.error, netCost: result.netCost };
  },
  openHqOfficeEditor: (hqOfficeEditorFacilityId) =>
    set((store) => ({
      state: migrateHqOfficeLayouts(store.state),
      hqOfficeEditorFacilityId,
      hallEditorFacilityId: null,
      leftRailOpen: false,
      commandDockOpen: false,
    })),
  closeHqOfficeEditor: () => set({ hqOfficeEditorFacilityId: null }),
  applyHqOfficeEditorPlan: (plan) => {
    const result = applyHqOfficePlan(get().state, plan);
    if (result.ok) set({ state: result.state });
    return { ok: result.ok, error: result.error, netCost: result.netCost };
  },

  openFleet: () =>
    set({
      activePanel: "racks",
      rackWorkspaceTab: "fleet",
      leftRailOpen: true,
      buildMode: null,
    }),
  openRackDesigner: (facilityId) =>
    set((store) => {
      const hall = facilityAnchorTiles(store.state).find(
        (candidate) =>
          (candidate.campusId ?? `facility:${candidate.x},${candidate.y}`) ===
          facilityId,
      );
      return {
        activePanel: "racks",
        rackWorkspaceTab: "blueprints",
        hallEditorFacilityId: null,
        selectedTile: hall ? { x: hall.x, y: hall.y } : store.selectedTile,
        leftRailOpen: true,
        buildMode: null,
      };
    }),
  setRackWorkspaceTab: (rackWorkspaceTab) => set({ rackWorkspaceTab }),
  openFleetForOwner: (ownerId) =>
    set({
      fleetOwnerFilter: ownerId,
      selectedRivalId: ownerId === "player" ? null : ownerId,
      activePanel: "racks",
      rackWorkspaceTab: "fleet",
      leftRailOpen: true,
    }),
  setSelectedRivalId: (id) => set({ selectedRivalId: id }),
  setMapTool: (tool) =>
    set({
      mapTool: tool,
      buildMode: tool === "build" ? get().buildMode : null,
    }),
  setMapOverlay: (overlay) => set({ mapOverlay: overlay }),
  setMapViewport: (viewport) => set({ mapViewport: viewport }),

  setLeftRailOpen: (open) => set({ leftRailOpen: open }),
  toggleLeftRail: () => set((s) => ({ leftRailOpen: !s.leftRailOpen })),
  setCommandDockOpen: (open) =>
    set(
      open
        ? { commandDockOpen: true, leftRailOpen: false }
        : { commandDockOpen: false },
    ),
  toggleCommandDock: () =>
    set((s) =>
      s.commandDockOpen
        ? { commandDockOpen: false }
        : { commandDockOpen: true, leftRailOpen: false },
    ),
  setCommandView: (v) =>
    set({ commandView: v, commandDockOpen: true, leftRailOpen: false }),
  setHotkeyHelpOpen: (open) => set({ hotkeyHelpOpen: open }),
  toggleHotkeyHelp: () => set((s) => ({ hotkeyHelpOpen: !s.hotkeyHelpOpen })),
  setPauseMenuOpen: (open) => {
    set((st) => ({
      pauseMenuOpen: open,
      // Pause sim while the menu is open so days don't advance under the modal
      state: open ? { ...st.state, paused: true } : st.state,
    }));
    if (open) void persistAutosave(get, (partial) => set(partial), true);
  },
  togglePauseMenu: () => {
    const open = !get().pauseMenuOpen;
    get().setPauseMenuOpen(open);
  },

  setBuildMode: (k) =>
    set({
      buildMode: k,
      // Build is its own workspace now. Keep its catalogue visible while the
      // player previews, drags, and multi-places facilities on the map.
      ...(k
        ? {
            activePanel: "build" as const,
            leftRailOpen: true,
            selectedTile: null,
          }
        : {}),
    }),

  clearSelection: () => set({ selectedTile: null }),

  focusMapTile: (x, y) =>
    set((store) => ({
      selectedTile: { x, y },
      buildMode: null,
      mapFocusRequest: {
        x,
        y,
        sequence: (store.mapFocusRequest?.sequence ?? 0) + 1,
        preserveZoom: false,
      },
    })),

  panMapToTile: (x, y) =>
    set((store) => ({
      mapFocusRequest: {
        x,
        y,
        sequence: (store.mapFocusRequest?.sequence ?? 0) + 1,
        preserveZoom: true,
      },
    })),

  selectTile: (x, y) => {
    // Explicit single-select: always one tile or none
    if (y === null) {
      set({ selectedTile: null });
      return;
    }
    const { buildMode, state, phase } = get();
    if (phase !== "playing") return;

    const tile = mapTileAt(state, x, y);
    if (!tile) {
      set({ selectedTile: null });
      return;
    }

    if (
      buildMode &&
      tile.kind === "empty" &&
      (tile.owner === "neutral" || tile.owner === "player")
    ) {
      const next = placeBuilding(state, x, y, buildMode);
      // Keep build mode so you can place multiple of the same type
      const placed = mapTileAt(next, x, y);
      const ok =
        placed && placed.kind === buildMode && placed.owner === "player";
      set({
        selectedTile: ok ? { x, y } : null,
        state: next,
        buildMode: get().buildMode,
        activePanel: "build",
        leftRailOpen: true,
      });
      return;
    }

    // Physical ambient props and municipal campuses are inspectable. Flat
    // transport/water surfaces retain their historical non-selection behavior.
    if (
      (tile.kind === "road" || tile.kind === "lake") &&
      tile.owner === "neutral"
    ) {
      set({ selectedTile: null });
      return;
    }

    // Toggle off if clicking the same tile again
    const cur = get().selectedTile;
    if (cur && cur.x === x && cur.y === y) {
      set({ selectedTile: null });
      return;
    }
    // Select tile only — do not steal the active workspace (Fleet stays on Racks, etc.)
    set({ selectedTile: { x, y } });
  },

  setSpeed: (s) => {
    set((st) => ({
      state: {
        ...st.state,
        speed: s,
        paused: s === 0 ? true : st.state.paused,
      },
    }));
    if (s === 0) void persistAutosave(get, (partial) => set(partial), true);
  },

  setPaused: (p) => {
    set((st) => ({ state: { ...st.state, paused: p } }));
    if (p) void persistAutosave(get, (partial) => set(partial), true);
  },

  setAutoPause: (key, enabled) =>
    set((st) => ({
      state: {
        ...st.state,
        config: {
          ...st.state.config,
          campaignRules: {
            ...st.state.config.campaignRules,
            autoPauseConfigured: true,
            autoPause: {
              ...st.state.config.campaignRules.autoPause,
              [key]: enabled,
            },
          },
        },
      },
    })),

  adjustCheatMoney: (delta) => {
    if (!Number.isFinite(delta) || delta === 0) return false;
    const current = get().state.player.cash;
    const cash = Math.max(0, current + delta);
    if (!Number.isFinite(cash)) return false;
    set((st) => {
      const playerLab = st.state.labs[st.state.playerLabId];
      return {
        state: {
          ...st.state,
          player: {
            ...st.state.player,
            cash,
            finance: { ...st.state.player.finance, cash },
          },
          labs: playerLab
            ? {
                ...st.state.labs,
                [st.state.playerLabId]: {
                  ...playerLab,
                  cash,
                  finance: { ...playerLab.finance, cash },
                },
              }
            : st.state.labs,
        },
      };
    });
    return true;
  },

  runInstantCheat: (action) => {
    const result = applyInstantCheat(get().state, action);
    if (result.affected > 0) set({ state: result.state });
    return result.affected;
  },

  togglePause: () => {
    const paused = !get().state.paused;
    set((st) => ({ state: { ...st.state, paused } }));
    if (paused) void persistAutosave(get, (partial) => set(partial), true);
  },

  stepDay: () => {
    if (get().phase !== "playing") return;
    set((st) => {
      setActiveBalanceTuning(st.state.balanceTuning);
      return { state: tickDay(st.state) };
    });
    scheduleAutosave(get, (partial) => set(partial));
  },

  setAllocation: (a) =>
    set((st) => {
      const allocation = { ...st.state.player.allocation, ...a };
      const sum =
        allocation.training + allocation.inference + allocation.research;
      return {
        state: {
          ...st.state,
          player: {
            ...st.state.player,
            allocation:
              sum > 0
                ? {
                    training: allocation.training / sum,
                    inference: allocation.inference / sum,
                    research: allocation.research / sum,
                  }
                : allocation,
          },
        },
      };
    }),

  startResearch: (nodeId) =>
    set((st) => ({ state: startResearch(st.state, nodeId) })),
  enqueueResearch: (nodeId) =>
    set((st) => ({ state: enqueueResearch(st.state, nodeId) })),
  dequeueResearch: (nodeId) =>
    set((st) => ({ state: dequeueResearch(st.state, nodeId) })),
  moveQueue: (nodeId, dir) =>
    set((st) => ({ state: moveQueue(st.state, nodeId, dir) })),
  cancelActiveResearch: () =>
    set((st) => ({ state: cancelActiveResearch(st.state) })),

  startTraining: (opts) =>
    set((st) => ({ state: startTraining(st.state, opts) })),
  setTrainingPriority: (jobId, priority, reservedPf) =>
    set((st) => ({
      state: applyLabAction(st.state, st.state.playerLabId, {
        kind: "set_training_priority",
        jobId,
        priority,
        reservedPf,
      }),
    })),
  pauseTraining: (jobId, paused) =>
    set((st) => ({
      state: applyLabAction(st.state, st.state.playerLabId, {
        kind: "pause_training",
        jobId,
        paused,
      }),
    })),
  extendTraining: (jobId) =>
    set((st) => ({ state: extendTraining(st.state, jobId) })),
  resolveTrainingCampaignEvent: (jobId, choiceId, customEffects) =>
    set((st) => ({
      state: resolveTrainingCampaignEvent(
        st.state,
        jobId,
        choiceId,
        customEffects,
      ),
    })),
  resolvePostTrainPhase: (jobId, decision) =>
    set((st) => ({
      state: resolvePostTrainPhase(st.state, jobId, decision),
    })),
  setTrainingAutoExtend: (jobId, on) =>
    set((st) => {
      const jobs = playerTrainingJobs(st.state);
      if (!jobs.some((job) => job.id === jobId)) return st;
      return {
        state: withTrainingJobs(
          st.state,
          jobs.map((job) =>
            job.id === jobId ? { ...job, autoExtend: on } : job,
          ),
        ),
      };
    }),
  setTrainingAutoChain: (jobId, on) =>
    set((st) => {
      const jobs = playerTrainingJobs(st.state);
      if (!jobs.some((job) => job.id === jobId)) return st;
      return {
        state: withTrainingJobs(
          st.state,
          jobs.map((job) =>
            job.id === jobId ? { ...job, autoChainPostTrain: on } : job,
          ),
        ),
      };
    }),
  setBalanceTuning: (patch) =>
    set((st) => {
      const merged = resolveBalanceTuning({
        ...st.state.balanceTuning,
        ...patch,
      });
      setActiveBalanceTuning(merged);
      return { state: { ...st.state, balanceTuning: { ...merged } } };
    }),
  resetBalanceTuning: () =>
    set((st) => {
      setActiveBalanceTuning(null);
      const next = { ...st.state };
      delete next.balanceTuning;
      return { state: next };
    }),
  cancelTraining: (jobId) =>
    set((st) => ({ state: cancelTraining(st.state, jobId) })),
  selectPostTrain: (jobId, stage) =>
    set((st) => ({ state: selectPostTrain(st.state, jobId, stage) })),
  investPostTrainGym: (kind, packageId) =>
    set((st) => ({ state: investPostTrainGym(st.state, kind, packageId) })),
  setTrainingLabs: (jobId, kinds) =>
    set((st) => ({ state: setTrainingLabs(st.state, jobId, kinds) })),
  teachToolSkill: (skillId, packageId) =>
    set((st) => ({ state: teachToolSkill(st.state, skillId, packageId) })),
  createModelRouter: (name) =>
    set((st) => ({ state: createModelRouter(st.state, name) })),
  setRouterLane: (routerId, lane, modelId) =>
    set((st) => ({
      state: setRouterLane(st.state, routerId, lane, modelId),
    })),
  setActiveModelRouter: (routerId) =>
    set((st) => ({ state: setActiveModelRouter(st.state, routerId) })),
  deleteModelRouter: (routerId) =>
    set((st) => ({ state: deleteModelRouter(st.state, routerId) })),
  benchmarkTrainingJob: (jobId, request) =>
    set((st) => ({
      state: benchmarkTrainingJob(st.state, jobId, request),
    })),
  advancePostTrain: (jobId) =>
    set((st) => ({ state: advancePostTrain(st.state, jobId) })),
  shipModel: () => set((st) => ({ state: shipModel(st.state) })),
  keepInternal: (jobId) =>
    set((st) => ({ state: keepInternal(st.state, jobId) })),
  releaseFromJob: (jobId, opts) =>
    set((st) => ({ state: releaseFromJob(st.state, jobId, opts) })),
  releaseTrainingEarly: (jobId) =>
    set((st) => ({ state: releaseTrainingEarly(st.state, jobId) })),
  captureTrainingCheckpoint: (jobId) =>
    set((st) => ({ state: captureTrainingCheckpoint(st.state, jobId) })),
  createManualTrainingCheckpoint: (request) =>
    set((st) => ({
      state: createManualTrainingCheckpoint(st.state, request),
    })),
  forkTrainingCheckpoint: (request) =>
    set((st) => ({ state: forkTrainingCheckpoint(st.state, request) })),
  rollbackTrainingJobToCheckpoint: (request) =>
    set((st) => ({
      state: rollbackTrainingJobToCheckpoint(st.state, request),
    })),
  recoverFailedPostTrainFromCheckpoint: (request) =>
    set((st) => ({
      state: recoverFailedPostTrainFromCheckpoint(st.state, request),
    })),
  promoteTrainingCheckpoint: (checkpointId) =>
    set((st) => ({
      state: promoteTrainingCheckpoint(st.state, checkpointId),
    })),
  discardTrainingCheckpoint: (checkpointId) =>
    set((st) => ({
      state: discardTrainingCheckpoint(st.state, checkpointId),
    })),
  scheduleCheckpointEvaluation: (checkpointId, request) =>
    set((st) => ({
      state: scheduleCheckpointEvaluation(st.state, checkpointId, request),
    })),
  scheduleReleasedModelEvaluation: (modelId, request) =>
    set((st) => ({
      state: scheduleReleasedModelEvaluation(st.state, modelId, request),
    })),
  releaseModel: (id, opts) =>
    set((st) => ({ state: releaseModel(st.state, id, opts) })),
  archiveModel: (id) => set((st) => ({ state: archiveModel(st.state, id) })),
  restoreArchivedModel: (id) =>
    set((st) => ({ state: restoreArchivedModel(st.state, id) })),
  deleteModel: (id) => set((st) => ({ state: deleteModel(st.state, id) })),
  setModelApiPrice: (id, price) =>
    set((st) => ({ state: setModelApiPrice(st.state, id, price) })),
  setDefaultEffort: (id, effort) =>
    set((st) => ({ state: setDefaultEffort(st.state, id, effort) })),
  setServedEffort: (id, effort, served) =>
    set((st) => ({ state: setServedEffort(st.state, id, effort, served) })),
  startEffortTraining: (request) =>
    set((st) => ({ state: startEffortTraining(st.state, request) })),
  listReleasedModel: (request) =>
    set((st) => ({ state: listReleasedModel(st.state, request) })),
  setModelApiInOut: (id, priceIn, priceOut) =>
    set((st) => {
      const model = st.state.player.models.find(
        (candidate) => candidate.id === id,
      );
      if (!model) return st;
      const input = Math.max(
        0,
        priceIn ?? model.apiPriceInPerMTok ?? model.costApiPriceIn,
      );
      const output = Math.max(
        0,
        priceOut ?? model.apiPriceOutPerMTok ?? model.costApiPriceOut,
      );
      return {
        state: applyLabAction(st.state, st.state.playerLabId, {
          kind: "set_api_price",
          modelId: id,
          input,
          output,
        }),
      };
    }),
  applyModelApiMarkup: (id, markupPct) =>
    set((st) => {
      const model = st.state.player.models.find(
        (candidate) => candidate.id === id,
      );
      if (!model) return st;
      const multiplier = 1 + Math.max(0, markupPct) / 100;
      const input = Math.round(model.costApiPriceIn * multiplier * 1000) / 1000;
      const output =
        Math.round(model.costApiPriceOut * multiplier * 1000) / 1000;
      return {
        state: applyLabAction(st.state, st.state.playerLabId, {
          kind: "set_api_price",
          modelId: id,
          input,
          output,
        }),
      };
    }),
  startSafetyCampaign: (modelId, intensity, researchers) =>
    set((st) => ({
      state: startSafetyCampaign(st.state, { modelId, intensity, researchers }),
    })),
  cancelSafetyCampaign: () =>
    set((st) => ({ state: cancelSafetyCampaign(st.state) })),

  orderRacks: (x, y, skuId, count) =>
    set((st) => ({ state: orderRacksIntoDc(st.state, x, y, skuId, count) })),
  sellRacks: (x, y, skuId, count) =>
    set((st) => ({ state: sellRacksFromDc(st.state, x, y, skuId, count) })),
  cancelRackOrder: (x, y, skuId, count) =>
    set((st) => ({ state: cancelRackOrder(st.state, x, y, skuId, count) })),
  autoBalanceHosting: () =>
    set((st) => ({ state: autoBalanceHosting(st.state) })),
  fillAllAvailableRackBays: () =>
    set((st) => ({ state: fillAllAvailableRackBays(st.state) })),
  deployRackBatch: (skuId, targets, count) =>
    set((st) => ({
      state: deployRackBatchAcrossHalls(st.state, skuId, targets, count),
    })),

  setPricing: (p) =>
    set((st) => {
      if (p.plans && p.plans.length > MAX_PLANS) {
        return {
          state: {
            ...st.state,
            alerts: [
              {
                id: `plan-pricing-blocked-${st.state.day}-${p.plans.length}`,
                day: st.state.day,
                severity: "warn" as const,
                message: `Plan limit reached (${MAX_PLANS}). Delete a plan before creating another.`,
              },
              ...st.state.alerts,
            ].slice(0, 40),
          },
        };
      }
      const next = { ...st.state.player.pricing, ...p };
      if (
        p.apiPriceInPerMTok !== undefined ||
        p.apiPriceOutPerMTok !== undefined
      ) {
        const fallback = splitBlendedApiPrice(next.apiPricePerMTok);
        const pin = next.apiPriceInPerMTok ?? fallback.priceIn;
        const pout = next.apiPriceOutPerMTok ?? fallback.priceOut;
        next.apiPriceInPerMTok = pin;
        next.apiPriceOutPerMTok = pout;
        next.apiPricePerMTok =
          Math.round(blendApiPrice(pin, pout) * 1000) / 1000;
      } else if (p.apiPricePerMTok !== undefined) {
        const split = splitBlendedApiPrice(p.apiPricePerMTok);
        next.apiPriceInPerMTok = Math.round(split.priceIn * 1000) / 1000;
        next.apiPriceOutPerMTok = Math.round(split.priceOut * 1000) / 1000;
        next.apiPricePerMTok = p.apiPricePerMTok;
      }
      // Plans edits also update the active model's own in/out list (only fields touched).
      let models = st.state.player.models;
      const activeId = next.activeModelId;
      const touchedIn = p.apiPriceInPerMTok !== undefined;
      const touchedOut = p.apiPriceOutPerMTok !== undefined;
      const touchedBlend = p.apiPricePerMTok !== undefined;
      if (activeId && (touchedIn || touchedOut || touchedBlend)) {
        models = models.map((m) => {
          if (m.id !== activeId) return m;
          const pin =
            touchedIn || touchedBlend
              ? next.apiPriceInPerMTok
              : (m.apiPriceInPerMTok ?? next.apiPriceInPerMTok);
          const pout =
            touchedOut || touchedBlend
              ? next.apiPriceOutPerMTok
              : (m.apiPriceOutPerMTok ?? next.apiPriceOutPerMTok);
          return {
            ...m,
            apiPriceInPerMTok: pin,
            apiPriceOutPerMTok: pout,
            apiPricePerMTok: Math.round(blendApiPrice(pin, pout) * 1000) / 1000,
          };
        });
      }
      return {
        state: {
          ...st.state,
          player: { ...st.state.player, pricing: next, models },
        },
      };
    }),

  setActiveModel: (id) =>
    set((st) => ({
      state: {
        ...st.state,
        player: {
          ...st.state.player,
          pricing: { ...st.state.player.pricing, activeModelId: id },
        },
      },
    })),

  createPlan: (input) => set((st) => ({ state: createPlan(st.state, input) })),
  updatePlan: (planId, patch) =>
    set((st) => ({ state: updatePlan(st.state, planId, patch) })),
  deletePlan: (planId) =>
    set((st) => ({ state: deletePlan(st.state, planId) })),

  placeBuilding: (kind) => {
    const { selectedTile, state, buildMode } = get();
    if (!selectedTile) return;
    const k = kind ?? buildMode;
    if (!k) return;
    set({
      state: placeBuilding(state, selectedTile.x, selectedTile.y, k),
      // Stay in build mode to place another of the same type
      buildMode: k,
      selectedTile: { x: selectedTile.x, y: selectedTile.y },
    });
  },

  upgradeBuilding: () => {
    const { selectedTile, state } = get();
    if (!selectedTile) return;
    set({ state: upgradeBuilding(state, selectedTile.x, selectedTile.y) });
  },

  renameBuilding: (x, y, name) =>
    set((st) => ({ state: renameBuilding(st.state, x, y, name) })),

  submitFacilityOffer: (facilityId, amount) =>
    set((st) => ({
      state: submitFacilityOffer(
        st.state,
        facilityId,
        st.state.playerLabId,
        amount,
      ),
    })),
  withdrawFacilityOffer: (offerId) =>
    set((st) => ({ state: withdrawFacilityOffer(st.state, offerId) })),
  acceptFacilityOffer: (offerId) =>
    set((st) => ({ state: acceptFacilityOffer(st.state, offerId) })),
  buyRivalDataCenter: (x, y) =>
    set((st) => ({ state: buyRivalDataCenter(st.state, x, y) })),
  demolishFacility: (facilityId) =>
    set((st) => ({
      state: demolishFacility(st.state, facilityId, st.state.playerLabId),
    })),

  startFab: () => set((st) => ({ state: startFabCampaign(st.state) })),
  setChipDesignFocus: (focus) =>
    set((st) => ({ state: setChipDesignFocus(st.state, focus) })),
  toggleChipDesignTech: (techId) =>
    set((st) => ({ state: toggleChipDesignTech(st.state, techId) })),
  hireTalent: () => set((st) => ({ state: hireTalent(st.state) })),
  buyData: () => set((st) => ({ state: buyDataPartnership(st.state) })),
  buyDataPortfolio: (budget, mix) =>
    set((st) => ({ state: buyDataPortfolio(st.state, budget, mix) })),
  listDataSupplierOffers: () => listDataSupplierOffers(get().state),
  acceptDataSupplierOffer: (offerId, priceMultiplier) =>
    set((st) => ({
      state: acceptDataSupplierOffer(st.state, offerId, priceMultiplier),
    })),
  proposeDataSupplierTerms: (supplierId, terms) =>
    set((st) => ({
      state: proposeDataSupplierTerms(st.state, supplierId, terms),
    })),
  counterDataSupplierOffer: (contractId, terms) =>
    set((st) => ({
      state: counterDataSupplierOffer(st.state, contractId, terms),
    })),
  acceptDataSupplierCounter: (contractId) =>
    set((st) => ({
      state: acceptDataSupplierCounter(st.state, contractId),
    })),
  rejectDataSupplierCounter: (contractId) =>
    set((st) => ({
      state: rejectDataSupplierCounter(st.state, contractId),
    })),
  cancelDataSupplierContract: (contractId) =>
    set((st) => ({
      state: cancelDataSupplierContract(st.state, contractId),
    })),
  buyDataLotAmount: (lotId, amountMTok) =>
    set((st) => ({
      state: buyDataLotAmount(st.state, lotId, amountMTok),
    })),
  buyAllFilteredDataLots: (offerIds) =>
    set((st) => ({
      state: buyAllFilteredDataLots(st.state, offerIds),
    })),
  setMarketing: (n) => set((st) => ({ state: setMarketing(st.state, n) })),
  setMarketingChannel: (channel, n) =>
    set((st) => ({ state: setMarketingChannel(st.state, channel, n) })),
  takeLoan: (offerId) =>
    set((st) => {
      if (offerId === "bailout") return { state: takeLoan(st.state, offerId) };
      const offer = loanOffers(st.state).find(
        (candidate) => candidate.id === offerId,
      );
      if (!offer) return { state: st.state };
      return {
        state: submitLoanApplication(
          st.state,
          st.state.playerLabId,
          offer.principal,
          offer.termDays,
        ),
      };
    }),
  takeCustomLoan: (opts) =>
    set((st) => ({
      state: submitLoanApplication(
        st.state,
        st.state.playerLabId,
        opts.principal,
        opts.termDays,
      ),
    })),
  acceptLoanOffer: (offerId) =>
    set((st) => ({ state: acceptFirmLoanOffer(st.state, offerId) })),
  declineLoanOffer: (offerId) =>
    set((st) => ({ state: declineFirmLoanOffer(st.state, offerId) })),
  repayLoan: (loanId, amount) =>
    set((st) => ({ state: repayLoan(st.state, loanId, amount) })),
  setCollectionRate: (n) =>
    set((st) => ({ state: setCollectionRate(st.state, n) })),
  setAutoProcess: (on) =>
    set((st) => ({ state: setAutoProcess(st.state, on) })),
  enqueueProcess: (domain, amount, qualityTarget) =>
    set((st) => ({
      state: enqueueProcess(st.state, domain, amount, qualityTarget),
    })),
  enqueueProcessAll: () =>
    set((st) => ({ state: enqueueProcessAll(st.state) })),
  enqueueDataPrune: (domain) =>
    set((st) => ({ state: enqueueDataPrune(st.state, domain) })),
  enqueueAllDataPrunes: () =>
    set((st) => ({ state: enqueueAllDataPrunes(st.state) })),
  purchaseDataPruneAudit: () =>
    set((st) => ({ state: purchaseDataPruneAudit(st.state) })),

  startSynthGen: (opts) =>
    set((st) => ({ state: startSynthGen(st.state, opts) })),
  startSynthBudget: (opts) =>
    set((st) => ({ state: startSynthBudget(st.state, opts) })),
  cancelSynthGen: (jobId) =>
    set((st) => ({ state: cancelSynthGen(st.state, jobId) })),

  dismissOnboarding: () =>
    set((st) => ({ state: { ...st.state, onboardingDismissed: true } })),
  setOnboardingDismissed: (onboardingDismissed) =>
    set((st) => ({ state: { ...st.state, onboardingDismissed } })),

  newGame: async () => {
    set((store) => ({ state: { ...store.state, paused: true } }));
    await persistAutosave(get, (partial) => set(partial), true);
    set({
      phase: "menu",
      loading: null,
      lifecycleError: null,
      selectedTile: null,
      mapFocusRequest: null,
      researchFocusRequest: null,
      buildMode: null,
      pauseMenuOpen: false,
      hallEditorFacilityId: null,
    });
  },

  startGame: async (opts) => {
    useUiStore.getState().clearNegotiations();
    set({
      phase: "loading",
      lifecycleError: null,
      loading: {
        operation: "new-game",
        message: "Preparing world generation…",
        progress: 0.1,
      },
    });
    await yieldForPaint();
    try {
      const state = createGame({
        ...opts,
        seed: opts.seed ?? Date.now() % 100000,
      });
      set({
        loading: {
          operation: "new-game",
          message: "Indexing cities and facilities…",
          progress: 0.9,
        },
      });
      await yieldForPaint();
      resetAutosaveTracking(state.day);
      setActiveBalanceTuning(state.balanceTuning);
      set({
        phase: "playing",
        loading: null,
        lifecycleError: null,
        saveStatus: "idle",
        state: { ...state, paused: true },
        // HQ-first: enter build mode so the free starter HQ can be placed immediately.
        activePanel: "build",
        rackWorkspaceTab: "fleet",
        selectedTile: null,
        mapFocusRequest: null,
        researchFocusRequest: null,
        buildMode: "hq",
        mapTool: "build",
        leftRailOpen: true,
        commandDockOpen: false,
        commandView: "pnl",
        hotkeyHelpOpen: false,
        pauseMenuOpen: false,
        hallEditorFacilityId: null,
      });
      return { ok: true as const };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "World generation failed.";
      set({ phase: "menu", loading: null, lifecycleError: message });
      return { ok: false as const, error: message };
    }
  },

  refreshSaves: async () => {
    try {
      const saves = await listSaveSlots();
      set({ saveSlots: saves, storageReady: true });
      return saves;
    } catch (error) {
      const message =
        error instanceof SaveError
          ? error.message
          : "Could not read save slots.";
      set({ storageReady: true, lifecycleError: message });
      return [];
    }
  },
  listSaves: () => get().saveSlots,
  hasSave: () => get().saveSlots.length > 0,

  saveGame: async (slotId = "1") => {
    if (get().phase !== "playing") {
      return { ok: false as const, error: "No active run to save." };
    }
    if (autosaveInFlight) await autosaveInFlight;
    if (get().phase !== "playing") {
      return { ok: false as const, error: "No active run to save." };
    }
    clearAutosaveTimer();
    const snapshot = get().state;
    set({ saveStatus: "saving" });
    try {
      const meta = await saveSlotWriter(slotId, snapshot);
      lastPersistedDay = snapshot.day;
      autosaveDirty = get().state.day > snapshot.day;
      if (slotId === "auto") lastAutosaveAt = Date.now();
      set({
        saveStatus: "saved",
        saveSlots: mergeSaveMeta(get().saveSlots, meta),
        storageReady: true,
      });
      if (autosaveDirty) scheduleAutosave(get, (partial) => set(partial));
      return { ok: true as const, meta };
    } catch (e) {
      const msg = e instanceof SaveError ? e.message : "Save failed.";
      set({ saveStatus: "error" });
      return { ok: false as const, error: msg };
    }
  },

  quickSave: () => get().saveGame("auto"),

  flushAutosave: () => persistAutosave(get, (partial) => set(partial), true),

  loadGame: async (slotId) => {
    const previousPhase = get().phase === "playing" ? "playing" : "menu";
    set({
      phase: "loading",
      lifecycleError: null,
      loading: {
        operation: "load-game",
        message: "Reading campaign data…",
        progress: 0.15,
      },
    });
    await yieldForPaint();
    try {
      const state = await readSaveSlot(slotId);
      set({
        loading: {
          operation: "load-game",
          message: "Regenerating world indexes…",
          progress: 0.9,
        },
      });
      await yieldForPaint();
      resetAutosaveTracking(state.day);
      const loadedState = applyLoadedState(state);
      setActiveBalanceTuning(loadedState.state.balanceTuning);
      useUiStore.getState().clearNegotiations();
      set({ ...loadedState, saveStatus: "idle" });
      return { ok: true as const };
    } catch (e) {
      const msg = e instanceof SaveError ? e.message : "Load failed.";
      set({
        phase: previousPhase,
        loading: null,
        lifecycleError: msg,
        saveStatus: "error",
      });
      return { ok: false as const, error: msg };
    }
  },

  continueGame: async () => {
    try {
      const id = await mostRecentSlotId();
      if (!id) return { ok: false as const, error: "No saved run found." };
      return get().loadGame(id);
    } catch (error) {
      const message =
        error instanceof SaveError
          ? error.message
          : "Could not read save slots.";
      set({ lifecycleError: message });
      return { ok: false as const, error: message };
    }
  },

  deleteSave: async (slotId) => {
    try {
      await deleteSaveSlot(slotId);
      await get().refreshSaves();
    } catch (error) {
      const message =
        error instanceof SaveError ? error.message : "Could not delete save.";
      set({ lifecycleError: message });
    }
  },

  clearLifecycleError: () => set({ lifecycleError: null }),

  snapshot: () => computeSnapshot(get().state),
}));

/** Flush pending world/simulation changes when the tab moves to the background. */
export function installGameSaveLifecycle(): () => void {
  if (typeof document === "undefined") return () => undefined;
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      void useGameStore.getState().flushAutosave();
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () =>
    document.removeEventListener("visibilitychange", onVisibilityChange);
}

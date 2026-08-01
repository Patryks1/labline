import type { DynamicWorld } from "./world/dynamicWorld";
import type {
  CityGrowthMetadata,
  CityPalette,
  CityTier,
} from "./world/types";

export type LabId = string;
export type LabController = "player" | "rival";

export type ModelFamily =
  "dense" | "moe" | "diffusion" | "video" | "omni" | "embedding";

/** V3 separates the parameter topology from the product's input/output feature set. */
export type ModelBackbone = "dense" | "moe" | "diffusion";
export type ModelProductPreset =
  | "language"
  | "vision_language"
  | "audio"
  | "image_generation"
  | "video_generation"
  | "omni";

export type ModelIOModality = "text" | "image" | "audio" | "video";

/** Numerical format used by matrix engines while a checkpoint is trained. */
export type TrainingComputeFormat =
  "fp32" | "fp16_mixed" | "bf16_mixed" | "fp8_hybrid" | "nvfp4";

/** Native weight topology is independent from the training compute format. */
export type NativeWeightFormat = "float" | "ternary_1_58";

/** Precision of a concrete serving artifact, not of its source checkpoint. */
export type ServePrecision =
  "fp16" | "bf16" | "fp8" | "int8" | "int4" | "nvfp4" | "ternary_1_58";

export interface TrainingNumerics {
  computeFormat: TrainingComputeFormat;
  nativeWeightFormat: NativeWeightFormat;
  recipeVersion: number;
}

export interface DeploymentArtifact {
  id: string;
  modelId: string;
  precision: ServePrecision;
  kvCachePrecision: "fp16" | "bf16" | "fp8" | "int8";
  calibrationDay: number;
  qualityDeltaByDomain: Partial<Record<CapabilityDomain, number>>;
  throughputMultiplier: number;
  weightMemoryMultiplier: number;
  supported: boolean;
}

/** Domain-first capability truth used by demand, evals, and synthetic data. */
export type CapabilityDomain =
  | "language"
  | "reasoning"
  | "code"
  | "math"
  | "science"
  | "vision"
  | "video"
  | "audio"
  | "tools";

export interface ModelCapabilities {
  domains: Record<CapabilityDomain, number>;
  factuality: number;
  steerability: number;
  robustness: number;
  safety: number;
  reliability: number;
}

/** 0–100 learned skill for each accepted/generated modality. */
export interface ModelIO {
  inputs: Partial<Record<ModelIOModality, number>>;
  outputs: Partial<Record<ModelIOModality, number>>;
  tools: number;
}

export interface ServiceProfile {
  /** Single-stream decoding speed; adding replicas raises capacity, not this value. */
  interactiveTokPerSec: number;
  timeToFirstTokenMs: number;
  imageSeconds: number | null;
  audioRealtimeFactor: number | null;
  videoSecondsPerSecond: number | null;
}

export type TrainingOutcomeKind = "stumble" | "normal" | "breakthrough";

export interface TrainingOutcome {
  kind: TrainingOutcomeKind;
  yieldMultiplier: number;
  capabilityDelta: number;
  reliabilityDelta: number;
  revealedDay: number;
  explanation: string;
}

export type Modality = "text" | "image" | "video" | "audio" | "tools";

export type PostTrainStage = "none" | "sft" | "rlhf" | "process" | "tools";

export type Speed = 0 | 1 | 2 | 5;

export type MapOverlayMode = "none" | "zones" | "power" | "latency" | "risk";
export type MapToolMode = "select" | "build" | "destroy";

export type PanelId =
  | "allocate"
  | "research"
  | "models"
  | "plans"
  | "market"
  | "marketing"
  | "chips"
  | "racks"
  | "power"
  | "computeMarket"
  | "build"
  | "buildings"
  | "map"
  | "org"
  | "events"
  | "stats"
  | "data"
  | "benchmarks"
  | "rivals";

/** Wholesale PF lease between player and a rival. */
export interface ComputeLease {
  id: string;
  rivalId: string;
  /** V3 generic endpoints. Legacy playerSells/rivalId fields remain during migration. */
  sellerLabId?: LabId;
  buyerLabId?: LabId;
  /** true = player leases PF *to* the rival */
  playerSells: boolean;
  pf: number;
  pricePerPfDay: number;
  daysLeft: number;
  daysTotal: number;
  status: "offer" | "active";
  from: "player" | "rival";
  dayStarted?: number;
  note?: string;
}

export type ComputeContractKind =
  | "on_demand"
  | "reserved"
  | "spot"
  | "colocation"
  | "rival_resale"
  | "emergency";

/** Provider-neutral capacity contract. PF is remote unless kind=colocation. */
export interface ComputeContract {
  id: string;
  providerId: string;
  providerName: string;
  buyerLabId: LabId;
  sellerLabId?: LabId;
  kind: ComputeContractKind;
  regionId: string;
  pf: number;
  pricePerPfDay: number;
  daysLeft: number;
  daysTotal: number;
  interruptionRisk: number;
  terminationFee: number;
  status: "offered" | "active" | "interrupted" | "expired";
  signedDay?: number;
  /** Colocation capacity is reserved immediately but becomes usable only after provisioning. */
  availableDay?: number;
  interruptionDaysLeft?: number;
  /** Accelerator capability snapshot; old contracts default conservatively to generation 1. */
  acceleratorGeneration?: number;
  supportedTrainingFormats?: TrainingComputeFormat[];
  supportedServePrecisions?: ServePrecision[];
}

export interface CloudProvider {
  id: string;
  name: string;
  regionId: string;
  baselinePf: number;
  /** Long-run expansion ceiling, initialized from the first simulated baseline when absent. */
  maxBaselinePf?: number;
  availablePf: number;
  basePricePerPfDay: number;
  reliability: number;
  spotVolatility: number;
  /** Hardware offered by this provider today. Copied into signed contracts. */
  acceleratorGeneration?: number;
  supportedTrainingFormats?: TrainingComputeFormat[];
  supportedServePrecisions?: ServePrecision[];
}

/** Public listing the player advertises. */
export interface ComputeListing {
  side: "sell" | "buy";
  pf: number;
  pricePerPfDay: number;
  termDays: number;
}

/** Firm city utility offtake at a locked $/MWh for a term. */
export interface CityPowerContract {
  id: string;
  cityId: string;
  cityName: string;
  /** Firm MW covered at locked price (import) */
  mw: number;
  /** Locked $/MWh (below spot at signing) */
  pricePerMWh: number;
  daysLeft: number;
  daysTotal: number;
}

/** Fixed-term sale of player-generated surplus to a metro utility. */
export interface PowerExportContract {
  id: string;
  cityId: string;
  cityName: string;
  mw: number;
  pricePerMWh: number;
  daysLeft: number;
  daysTotal: number;
  signedDay: number;
}

/** Long-term utility/PPA instrument; CityPowerContract remains the legacy runtime view. */
export interface EnergyContract extends CityPowerContract {
  labId: LabId;
  kind: "utility" | "ppa";
  takeOrPay: boolean;
  counterparty: string;
  regionId: string;
  status: "offered" | "active" | "expired" | "terminated";
  signedDay?: number;
  terminationFee: number;
}

/** Multi-quarter colocation or owned-campus delivery project. */
export interface SiteProject {
  id: string;
  labId: LabId;
  name: string;
  route: "colocation" | "owned";
  regionId: string;
  targetMw: number;
  gridQueueMw: number;
  capexTotal: number;
  capexPaid: number;
  startDay: number;
  completionDay: number;
  /** Construction duration after an interconnection award; queue time is additional. */
  constructionDays?: number;
  /** Firm regional grid capacity reserved for this project. */
  gridAllocatedMw?: number;
  completedDay?: number;
  cancelledDay?: number;
  status:
    | "planning"
    | "grid_queue"
    | "construction"
    | "commissioning"
    | "complete"
    | "cancelled";
}

/** Commissioned shell and firm interconnection; contains no accelerator compute. */
export interface SiteCapacity {
  id: string;
  projectId: string;
  labId: LabId;
  route: "colocation" | "owned";
  regionId: string;
  siteMw: number;
  firmMw: number;
  commissionedDay: number;
  status: "active";
  /** Physical campus this interconnection belongs to. Absent on old saves. */
  facilityId?: string;
}

export interface FacilityNavBreakdown {
  land: number;
  shell: number;
  racks: number;
  sitePower: number;
  total: number;
}

export type FacilityAcquisitionStatus =
  | "pending"
  | "countered"
  | "accepted"
  | "rejected"
  | "withdrawn"
  | "expired";

/** Lab-neutral, cash-backed offer for a physical data-centre campus. */
export interface FacilityAcquisitionOffer {
  id: string;
  facilityId: string;
  buyerLabId: LabId;
  sellerLabId: LabId;
  amount: number;
  escrow: number;
  submittedDay: number;
  respondDay: number;
  expiresDay: number;
  status: FacilityAcquisitionStatus;
  counterAmount?: number;
  resolvedDay?: number;
}

export interface FacilityMarketState {
  offers: FacilityAcquisitionOffer[];
}

/** Finite regional interconnection pool shared by every lab. */
export interface RegionInterconnection {
  regionId: string;
  firmCapacityMw: number;
  allocatedMw: number;
  queuedMw: number;
}

export type ModuleKind = "gpu" | "ram" | "cpu" | "cooling" | "nic" | "psu";
export type SlotSize = 1 | 2 | 4;

export type SegmentId =
  | "hobby"
  | "consumer"
  | "indie_api"
  | "startup_api"
  | "science"
  | "enterprise"
  | "creative"
  | "legal"
  | "healthcare";

export type RivalArchetype =
  "hyperscale" | "open_weights" | "efficiency" | "multimodal" | "safety";

/** Player-constructible facility kinds (have BUILD_DEFS). */
export type BuildableKind =
  | "dc"
  | "dc_m"
  | "dc_l"
  | "substation"
  | "solar"
  | "gas"
  | "nuclear"
  | "fab"
  | "cooling"
  | "battery"
  | "hq"
  | "hq_m"
  | "hq_l"
  /** @deprecated use hq — kept for save/map compat */
  | "office"
  | "lab";

/** Data-hall size class (small 1-tile / medium 4-tile / large 6-tile). */
export type DcSize = "small" | "medium" | "large";

/** HQ size class (small / medium / large desk capacity). */
export type HqSize = "small" | "medium" | "large";

/** Roles hired into HQ buildings from city talent pools. */
export type StaffRole = "researcher" | "data_processor" | "engineer" | "ops";

export type StaffHeadcount = Record<StaffRole, number>;

/** Map scenery — blocks construction, rendered as detailed 3D kits. */
export type ScenicKind =
  "city" | "lake" | "forest" | "house" | "road" | "park" | "warehouse";

export type TileKind = "empty" | BuildableKind | ScenicKind;

export type TileOwner = "player" | "neutral" | string; // rival id

export type FabPhase =
  "idle" | "architecture" | "tapeout" | "fab_queue" | "yield_ramp" | "volume";

export type GameOutcome = "playing" | "won" | "lost";

export type BenchmarkId =
  | "mmlu"
  | "coding"
  | "math"
  | "vision"
  | "law"
  | "health"
  | "science"
  | "multilingual"
  | "agents"
  | "safety";

export type BenchmarkScores = Record<BenchmarkId, number>;

export type BenchmarkSuiteId =
  | "language"
  | "image_generation"
  | "video_generation"
  | "audio_generation"
  | "omni_overview";

export type ImageGenerationMetricId =
  | "prompt_alignment"
  | "aesthetics"
  | "typography"
  | "subject_consistency"
  | "editing_control"
  | "image_safety";

export type VideoGenerationMetricId =
  | "video_prompt_alignment"
  | "visual_quality"
  | "temporal_coherence"
  | "motion_physics"
  | "video_control"
  | "video_safety";

export type AudioGenerationMetricId =
  | "intelligibility"
  | "naturalness"
  | "voice_consistency"
  | "music_quality"
  | "realtime_performance"
  | "audio_safety";

export type OmniOverviewMetricId =
  | "omni_language"
  | "omni_reasoning"
  | "omni_tools"
  | "omni_image"
  | "omni_video"
  | "omni_audio"
  | "omni_safety";

export type BenchmarkMetricId =
  | BenchmarkId
  | ImageGenerationMetricId
  | VideoGenerationMetricId
  | AudioGenerationMetricId
  | OmniOverviewMetricId;

export type BenchmarkSuiteScores = Partial<
  Record<BenchmarkSuiteId, Partial<Record<BenchmarkMetricId, number>>>
>;

export interface EvaluationMetricDriver {
  positive: string;
  penalty: string;
  ceiling: number;
}

export type EvaluationProfile = Partial<
  Record<BenchmarkMetricId, EvaluationMetricDriver>
>;

export interface QualityAxes {
  reasoning: number;
  coding: number;
  chat: number;
  image: number;
  video: number;
  safety: number;
  reliability: number;
}

export interface ChipDef {
  id: string;
  name: string;
  generation: number;
  flopsPf: number;
  mwPerChip: number;
  tokPerSec: number;
  price: number;
  leadTimeDays: number;
  perfPerWatt: number;
  custom?: boolean;
  moeBoost?: number;
}

export interface ChipInventory {
  defId: string;
  count: number;
  arriving: { daysLeft: number; count: number }[];
}

export type ChipDesignFocus = "balanced" | "training" | "inference";
export type ChipDesignTechId =
  | "matrix_array"
  | "hbm_fabric"
  | "kv_cache"
  | "chiplet_mesh"
  | "optical_io"
  | "sparse_router";

/** Chassis slot in the rack designer grid. */
export interface ChassisSlot {
  id: string;
  size: SlotSize;
  /** Grid cell (column, row) for UI */
  col: number;
  row: number;
  /** How many grid cells wide (matches size often) */
  w: number;
  h: number;
}

export interface ChassisDef {
  id: string;
  name: string;
  blurb: string;
  slots: ChassisSlot[];
  /** Max heat the backplane accepts before thermal trip */
  maxMw: number;
  baseCost: number;
  /** DC rack slots consumed when deployed */
  rackUnits: number;
}

export interface ModuleDef {
  id: string;
  name: string;
  kind: ModuleKind;
  slotSize: SlotSize;
  cost: number;
  blurb: string;
  flopsPf?: number;
  vramGb?: number;
  systemRamGb?: number;
  mw?: number;
  /** Cooling capacity provided (MW) */
  coolingMw?: number;
  /** PSU capacity (MW) */
  psuMw?: number;
  /** Aggregate fabric bandwidth supplied by network modules. */
  networkGbps?: number;
  /** Relative host compute capacity for loaders, research, and prefill. */
  cpuScore?: number;
  tokPerSec?: number;
  color: string;
}

export interface PlacedModule {
  instanceId: string;
  moduleId: string;
  slotId: string;
}

export interface RackDesign {
  id: string;
  name: string;
  chassisId: string;
  placements: PlacedModule[];
}

/** Campaign-independent rack design stored in the player's profile library. */
export type RackBlueprint = RackDesign;

export interface DeployedRackGroup {
  designId: string;
  count: number;
}

export interface ModuleStock {
  moduleId: string;
  count: number;
}

/** Catalog product: a complete rack you order into a data hall. */
export interface RackSku {
  id: string;
  name: string;
  blurb: string;
  generation: number;
  /** DC bay slots consumed per unit */
  rackUnits: number;
  flopsPf: number;
  vramGb: number;
  /** Host system RAM (GB) — KV cache, host offload, data pipeline */
  systemRamGb?: number;
  /** Host CPU score (arbitrary units) — prefill, loaders, research workers */
  cpuScore?: number;
  /** Aggregate rack fabric bandwidth, snapshotted for custom designs. */
  networkGbps?: number;
  /** Power draw MW per rack (before PUE) */
  mw: number;
  tokPerSec: number;
  /** Physical accelerator description used by compute-v2 estimators. */
  accelerator?: AcceleratorProfile;
  price: number;
  leadTimeDays: number;
  /** Fraction of paid price recovered when sold */
  sellBackRate: number;
  unlockedByDefault?: boolean;
  requiresResearch?: string;
  custom?: boolean;
}

export interface AcceleratorProfile {
  deviceCount: number;
  generation: number;
  fp32TfPerDevice: number;
  fp16Bf16TfPerDevice: number;
  fp8TfPerDevice: number;
  fp4TfPerDevice: number;
  hbmGbPerDevice: number;
  hbmBandwidthTbPerSecPerDevice: number;
  interconnectGbps: number;
  idleMw: number;
  maxMw: number;
  hostOverheadMw: number;
  supportedTrainingFormats: TrainingComputeFormat[];
  supportedServePrecisions: ServePrecision[];
}

/** Racks ordered or live inside a specific player data hall. */
export interface RackInstall {
  id: string;
  skuId: string;
  /** Stable owning campus. Coordinates remain for old saves and map lookup. */
  facilityId?: string;
  x: number;
  y: number;
  count: number;
  status: "ordered" | "live";
  /** Days until delivery when status is ordered */
  daysLeft: number;
  /** Cash paid per unit (for sell-back) */
  paidEach: number;
  /** Bay slots per unit (cached so map tick need not resolve SKUs) */
  rackUnits: number;
  /** Start bay for each physical rack unit. Missing entries use deterministic first-fit migration. */
  bayStarts?: number[];
  /** Stable identity for every physical chassis in this order/install batch. */
  unitIds?: string[];
}

export type HallRotation = 0 | 90 | 180 | 270;
export type DataHallShellId = "hall-small-v1" | "hall-medium-v1" | "hall-large-v1";
export type DataHallObjectKind = "rack" | "cooling" | "power" | "network";
export type HallAutoLayoutStrategy = "density" | "efficiency" | "resilience";

export interface DataHallObjectPlacement {
  id: string;
  kind: DataHallObjectKind;
  catalogId: string;
  x: number;
  z: number;
  rotation: HallRotation;
  rackUnitId?: string;
  /** Persisted physical rack cabinet reserved for future delivered inventory. */
  reserved?: boolean;
  purchasePrice: number;
}

export interface DataHallWallSegment {
  id: string;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  purchasePrice: number;
}

export interface DataHallDoorPlacement {
  id: string;
  wallId: string;
  offset: number;
  width: number;
  purchasePrice: number;
}

export interface DataHallLayoutAnalysis {
  revision: number;
  valid: boolean;
  hardErrors: string[];
  warnings: string[];
  operationalRackUnitIds: string[];
  offlineRackUnitIds: string[];
  environmentScore: number;
  coolingScore: number;
  airflowScore: number;
  aisleScore: number;
  throughputMultiplier: number;
  pueMultiplier: number;
  incidentRiskMultiplier: number;
  powerRoutes: Array<{ rackUnitId: string; equipmentId: string; cells: number[] }>;
  networkRoutes: Array<{ rackUnitId: string; equipmentId: string; cells: number[] }>;
}

export interface DataHallLayout {
  version: 1;
  facilityId: string;
  shellId: DataHallShellId;
  revision: number;
  autoPlaceDeliveries: boolean;
  preferredStrategy: HallAutoLayoutStrategy;
  objects: DataHallObjectPlacement[];
  walls: DataHallWallSegment[];
  doors: DataHallDoorPlacement[];
  analysis: DataHallLayoutAnalysis;
}

export interface DataHallEditPlan {
  facilityId: string;
  expectedRevision: number;
  objects: DataHallObjectPlacement[];
  walls: DataHallWallSegment[];
  doors: DataHallDoorPlacement[];
  preferredStrategy?: HallAutoLayoutStrategy;
}

export interface RackDesignStats {
  flopsPf: number;
  vramGb: number;
  systemRamGb: number;
  cpuScore: number;
  networkGbps: number;
  mw: number;
  coolingMw: number;
  psuMw: number;
  tokPerSec: number;
  gpuCount: number;
  buildCost: number;
  valid: boolean;
  errors: string[];
}

export interface Allocation {
  training: number;
  inference: number;
  research: number;
}

export interface ResearchNodeDef {
  id: string;
  trunk: string;
  name: string;
  description: string;
  /** Base PF-days in catalog; actual target = costPfDays × ECONOMY.researchPfCostMult × config */
  costPfDays: number;
  daysMin: number;
  prereqs: string[];
  exclusiveWith?: string[];
  effects: ResearchEffects;
  /**
   * Optional extra cash multiplier on top of ECONOMY.researchCashPerPfDay
   * (e.g. hardware collab burns more money).
   */
  cashBurnMult?: number;
  /**
   * Minimum HQ researchers required to start / progress this node.
   * If omitted, derived from prereq depth (early = 1, deep = 20+).
   */
  minResearchers?: number;
  /** Experimental methods are visually flagged and can widen training outcome risk. */
  riskLevel?: "elevated" | "high";
}

export interface ResearchEffects {
  utilCap?: number;
  servingEfficiency?: number;
  trainEfficiency?: number;
  energyPue?: number;
  capabilityBonus?: number;
  moeInferMult?: number;
  denseInferMult?: number;
  safetyBonus?: number;
  rlhfQuality?: number;
  unlockFamily?: ModelFamily;
  chipDiscount?: number;
  fabSpeed?: number;
  talentAttract?: number;
  dataFlywheel?: number;
  /** Additive boosts to named benchmarks when unlocked */
  benchmarkBoost?: Partial<BenchmarkScores>;
  /** Unlock assigning specialist models per corpus domain at train time */
  unlockCorpusSpecialists?: boolean;
  /** Adds probability mass to breakthrough outcomes on completed training runs. */
  trainingBreakthroughBias?: number;
  /** Adds probability mass to stumble outcomes on completed training runs. */
  trainingStumbleRisk?: number;
  /** Direct safety-axis penalty applied to models trained with this method unlocked. */
  trainingSafetyPenalty?: number;
}

export interface ResearchProgress {
  nodeId: string;
  progressPfDays: number;
  daysSpent: number;
}

/** Public product vs internal checkpoint (distillation teachers, unreleased frontier). */
export type ModelRelease = "internal" | "released";

export type TrainMode = "pretrain" | "distill" | "continue";

/**
 * Training corpus domains. Collected from product usage, then processed
 * into train-ready packs the player mixes when starting a job.
 */
export type DataDomain =
  | "code"
  | "math"
  | "science"
  | "law"
  | "health"
  | "chat"
  | "image"
  | "video"
  | "audio";

export type DatasetRights = "owned" | "licensed" | "public" | "restricted";
export type DatasetSource =
  "web" | "user" | "expert" | "partner" | "synthetic" | "opensource";

export interface SyntheticProvenance {
  method?: "imitation" | "filtered" | "verifier" | "curriculum";
  teacherModelIds: string[];
  generationDepth: number;
  promptDiversity: number;
  verifierStrength: number;
  candidatesPerAccepted: number;
  humanAnchorShare: number;
}

/** Reusable, inspectable corpus lot. DomainStock remains a derived fast summary. */
export interface DatasetAsset {
  id: string;
  name: string;
  volumeMTok: number;
  domainWeights: Partial<Record<DataDomain, number>>;
  verticalTags: string[];
  quality: number;
  diversity: number;
  freshness: number;
  rights: DatasetRights;
  source: DatasetSource;
  exclusiveUntilDay: number | null;
  contaminationRisk: number;
  synthetic?: SyntheticProvenance;
  acquiredDay: number;
}

export interface DataManifest {
  id: string;
  assetIds: string[];
  domainWeights: Partial<Record<DataDomain, number>>;
  uniqueMTok: number;
  repeatedMTok: number;
  effectiveQuality: number;
  contaminationRisk: number;
  createdDay: number;
}

/** @deprecated use DataDomain + TrainingDataPlan */
export type DataMix = "web" | "code" | "math" | "curated" | "synthetic";

/**
 * Per-domain inventory in **MTok** (million tokens).
 * Source breakdown applies to processed stock (web crawl / user traffic / AI synth).
 */
export interface DomainStock {
  /** Unprocessed logs / crawls (MTok) */
  raw: number;
  /** Cleaned, train-ready (MTok) */
  processed: number;
  /** Quality of processed stock 0–100 (web/user blended) */
  quality: number;
  /** Processed MTok from web crawl / partnerships */
  fromWeb: number;
  /** Processed MTok from product users */
  fromUser: number;
  /** Processed MTok acquired from brokers, partners, rivals, or enterprise licenses. */
  fromBought: number;
  /**
   * Total synthetic MTok (HQ + LQ). Kept for totals / UI.
   * Prefer fromSynthHQ / fromSynthLQ for training recipes.
   */
  fromSynth: number;
  /** High-quality synthetic (filtered / strong teacher) */
  fromSynthHQ: number;
  /** Low-quality synthetic (noisy / weak teacher) — can regress models */
  fromSynthLQ: number;
}

export interface ProcessJob {
  id: string;
  domain: DataDomain;
  /** Raw MTok still to process */
  remaining: number;
  total: number;
  qualityTarget: number;
}

/** Research-assisted audit that permanently discards low-quality corpus. */
export interface DataPruneJob {
  id: string;
  domain: DataDomain;
  /** Raw and processed MTok still to inspect and discard. */
  rawRemaining: number;
  processedRemaining: number;
  rawTotal: number;
  processedTotal: number;
  /** Cash is charged per MTok actually removed. */
  cashPerMTok: number;
  /** PF-days required per MTok removed. */
  pfDaysPerMTok: number;
  researchersRequired: number;
  /** Share of the physical research pool reserved while this job is active. */
  researchShare: number;
  qualityBefore: number;
}

/** AI data generation job — burns research PF, fills synth tokens. */
export interface SynthGenJob {
  id: string;
  domain: DataDomain;
  modelId: string;
  modelName: string;
  /** Legacy finite target. New jobs run continuously until cancelled. */
  targetMTok: number;
  progressMTok: number;
  continuous?: boolean;
  /**
   * Share of research pool this job claims (0.05–0.85).
   * All synth jobs + research tech share the same pool.
   */
  researchShare: number;
  /**
   * Quality tier of generated tokens.
   * HQ needs a capable teacher; LQ is fast/noisy and can poison training.
   */
  qualityTier: "hq" | "lq";
  /** Automatic portfolio jobs spend a compute budget and route useful output themselves. */
  autoPortfolio?: boolean;
  /** Cumulative useful output split by generated quality. */
  hqMTok?: number;
  lqMTok?: number;
  /** Cumulative generated output rejected by the automatic verifier. */
  wastedMTok?: number;
}

export interface LabData {
  stocks: Record<DataDomain, DomainStock>;
  /** Canonical inspectable lots for v4 campaigns. */
  assets: DatasetAsset[];
  manifests: DataManifest[];
  processQueue: ProcessJob[];
  /** Active low-quality corpus audits. */
  pruneQueue: DataPruneJob[];
  /** Last paid corpus audit remains actionable through this game day. */
  pruneAuditValidUntilDay?: number;
  /** Active AI data-generation jobs */
  synthQueue: SynthGenJob[];
  autoProcess: boolean;
  collectionRate: number;
  lifetimeCollected: number;
  lifetimeProcessed: number;
  dayCollected: number;
  dayProcessed: number;
  daySynthMTok: number;
  dayCollectByDomain: Partial<Record<DataDomain, number>>;
  /**
   * Aggregate research-pool share reserved for data gen (0–0.85).
   * Tech research gets (1 − this) of the research PF pool.
   */
  dataGenResearchShare: number;
}

/** Seller type on the open data market. */
export type DataSellerKind =
  | "web_scrape"
  | "broker"
  | "rival"
  | "enterprise"
  | "research_lab"
  | "opensource";

export type DataQualityBand = "scrap" | "standard" | "premium" | "curated";

/** Live buyable data listing (scrapes, brokers, rivals, enterprise). */
export interface DataMarketOffer {
  id: string;
  domain: DataDomain;
  name: string;
  blurb: string;
  sellerKind: DataSellerKind;
  sellerName: string;
  qualityBand: DataQualityBand;
  quality: number;
  mTokLeft: number;
  mTokTotal: number;
  lotMTok: number;
  cash: number;
  daysLeft: number;
  source: "web" | "scrap" | "licensed";
}

export interface DataMarketState {
  offers: DataMarketOffer[];
  lastRefreshDay: number;
  nextRefreshDay: number;
}

/**
 * Train-time data recipe. Volumes are **MTok** (million tokens).
 * Min for a model: ~1 token per parameter (1B params → 1000 MTok).
 */
export interface TrainingDataPlan {
  /**
   * Total MTok to consume (train + verify).
   * @deprecated alias of totalMTok for older saves
   */
  totalUnits: number;
  /** Total MTok (preferred) */
  totalMTok?: number;
  /**
   * Fraction of volume used for training vs verification (0.4–0.95).
   * Higher train → capability; higher verify → safety/reliability.
   */
  trainShare?: number;
  weights: Partial<Record<DataDomain, number>>;
  /**
   * Master switch for synthetic fill when real packs run short.
   * Requires `data_synth` research for HQ; LQ may still bootstrap poorly.
   */
  allowSynthetic?: boolean;
  /** Include high-quality synthetic stock in the train mix (default true if allowSynthetic). */
  includeSynthHQ?: boolean;
  /**
   * Include low-quality synthetic stock. Default false — LQ volume can regress capability.
   */
  includeSynthLQ?: boolean;
  domainModels?: Partial<Record<DataDomain, string>>;
  /** Optional synthetic teacher override per domain. Missing entries use the best eligible model. */
  syntheticTeacherIds?: Partial<Record<DataDomain, string>>;
  /** Requested generated-token expansion relative to attributed real data (0–7×; 8× total). */
  syntheticMultiplier?: number;
  /** V3: unique/repeated exposure used for saturation and memorization risk. */
  uniqueMTok?: number;
  repeatedMTok?: number;
  /** Synthetic fill provenance for this recipe (teacher-generated in distill). */
  syntheticProvenance?: SyntheticFillRecord[];
}

export interface Model {
  id: string;
  name: string;
  family: ModelFamily;
  /** Total parameters in billions (0.007 = 7M, 1000 = 1T) */
  paramsB: number;
  /** MoE: parameters active per token (billions) */
  activeParamsB?: number;
  backbone?: ModelBackbone;
  productPreset?: ModelProductPreset;
  io?: ModelIO;
  capability: number;
  /** Authoritative domain vector for v4 models; legacy models derive it on read. */
  capabilities?: ModelCapabilities;
  modalities: Modality[];
  quality: QualityAxes;
  benchmarks: BenchmarkScores;
  /** Modality-aware evaluations; benchmarks remains the language compatibility view. */
  benchmarkSuites?: BenchmarkSuiteScores;
  evaluationProfile?: EvaluationProfile;
  reasoningEnabled?: boolean;
  revision?: number;
  safetyTraining?: SafetyTrainingRecord;
  postTrain: PostTrainStage;
  /** One-shot post-training stages completed anywhere in this model lineage. */
  completedPostTrainStages?: Exclude<PostTrainStage, "none">[];
  /** Effectiveness earned by each completed stage (0-1), preserved across continuation. */
  postTrainStageEffectiveness?: Partial<
    Record<Exclude<PostTrainStage, "none">, number>
  >;
  trainComputeSpent: number;
  /** Lifetime revenue/cost attribution for this model. */
  economics?: ModelEconomics;
  releaseDay: number;
  /** @deprecated use release === 'released' */
  shipped: boolean;
  release: ModelRelease;
  tokPerSecMult: number;
  inferCostMult: number;
  serviceProfile?: ServiceProfile;
  /**
   * Per-model API list ($/1M tokens). Each model has its own in/out rates.
   * null falls back to suggested → lab ProductPricing defaults.
   */
  /** Blended list price $/MTok (legacy + market score) */
  apiPricePerMTok: number | null;
  /** $/1M input tokens — model-specific */
  apiPriceInPerMTok: number | null;
  /** $/1M output tokens — model-specific */
  apiPriceOutPerMTok: number | null;
  /** Suggested blended list price at default markup */
  suggestedApiPrice: number;
  suggestedApiPriceIn: number;
  suggestedApiPriceOut: number;
  /** At-cost floor for this model (compute-based) */
  costApiPriceIn: number;
  costApiPriceOut: number;
  distilled: boolean;
  teacherId?: string;
  /** Distill mix used when this model was trained (teacher fraction 0–1) */
  distillTeacherShare?: number;
  trainMode: TrainMode;
  /** @deprecated use dataPlan */
  dataMix?: DataMix;
  /** Recipe used for this train */
  dataPlan?: TrainingDataPlan;
  /** MTok consumed by domain (last train) */
  dataConsumed?: Partial<Record<DataDomain, number>>;
  /** Lifetime MTok ever trained on this weights */
  dataTokensUsedMTok?: number;
  /**
   * Lab `lifetimeProcessed` (or total processed) watermark after last train.
   * Continue-train only uses corpus grown *after* this watermark.
   */
  dataWatermarkMTok?: number;
  /** MTok used for train vs verify on last job */
  dataTrainMTok?: number;
  dataVerifyMTok?: number;
  /** 0–1 coverage vs min 1:1 tokens:params (pretrain); softer for continue */
  dataCoverage?: number;
  dataQualityUsed?: number;
  /** Cumulative continued-pretrain PF-days after initial ship */
  continueCompute?: number;
  /** Quality-weighted unique tokens per total parameter. */
  effectiveDataRatio?: number;
  repeatedDataEpochs?: number;
  outcome?: TrainingOutcome;
  openWeights?: boolean;
  dataManifestId?: string;
  integratedMethods?: string[];
  /** Research-backed runtime and architecture modules integrated into this build. */
  modelStack?: string[];
  /** Quality and LQ share captured per corpus domain for reproducible evaluations. */
  dataQualityByDomain?: Partial<Record<DataDomain, number>>;
  lowQualityShareByDomain?: Partial<Record<DataDomain, number>>;
  syntheticProvenance?: SyntheticFillRecord[];
  /** Generated tokens divided by real tokens for the final recipe. */
  syntheticMultiplier?: number;
  /** Fraction of the final recipe generated by teacher models. */
  syntheticShare?: number;
  /** 0–1 gap between benchmark-shaped performance and field usefulness. */
  benchmarkOverfit?: number;
  /** Numerics and native topology used to produce this checkpoint. */
  trainingNumerics?: TrainingNumerics;
  /** Evaluated deployable artifacts derived from this checkpoint. */
  deploymentArtifacts?: DeploymentArtifact[];
  /** Version of the physical training-work formula used by this model. */
  trainingFormulaVersion?: 1 | 2;
}

export interface SyntheticFillRecord {
  domain: DataDomain;
  teacherModelId?: string;
  teacherName?: string;
  volumeMTok: number;
  quality: number;
  qualityTier: "hq" | "lq";
}

export interface SafetyTrainingRecord {
  campaigns: number;
  safetyDataMTok: number;
  safetyDataQuality: number;
  cashSpent: number;
  trainingPfSpent: number;
  researchPfSpent: number;
  lastCompletedDay?: number;
  revisions?: { revision: number; day: number; safety: number }[];
}

export type SafetyCampaignIntensity = "targeted" | "standard" | "frontier";

export interface SafetyCampaign {
  id: string;
  modelId: string;
  modelName: string;
  intensity: SafetyCampaignIntensity;
  assignedResearchers: number;
  minimumResearchers: number;
  targetTrainingPfDays: number;
  targetResearchPfDays: number;
  progressTrainingPfDays: number;
  progressResearchPfDays: number;
  cashBudget: number;
  cashSpent: number;
  safetyDataMTok: number;
  safetyDataQuality: number;
  startDay: number;
}

export type ResearchPodFocus =
  "exploration" | "scaling" | "data" | "posttrain" | "evals" | "systems";

export interface ResearchLead {
  id: string;
  name: string;
  skills: {
    algorithms: number;
    systems: number;
    dataEvals: number;
    leadership: number;
  };
  specialties: Partial<Record<CapabilityDomain, number>>;
  traits: string[];
  reputation: number;
  morale: number;
  salaryPerDay: number;
}

export interface ResearchPod {
  id: string;
  name: string;
  leadId: string;
  focus: ResearchPodFocus;
  researchers: number;
  engineers: number;
  dataStaff: number;
  assignmentId: string | null;
}

export type ResearchDisclosure = "secret" | "published" | "licensed";

export interface ResearchEvidence {
  id: string;
  domain?: CapabilityDomain;
  strength: number;
  source: "pilot" | "training" | "evaluation" | "field";
  day: number;
}

export interface ResearchProgram {
  id: string;
  methodId: string;
  podId: string;
  phase: "hypothesis" | "pilot" | "validation" | "integration" | "complete";
  evidence: ResearchEvidence[];
  insightProgress: number;
  engineeringProgress: number;
  computeShare: number;
  disclosure: ResearchDisclosure;
}

export interface ForecastBand {
  low: number;
  expected: number;
  high: number;
}

export interface ExperimentRun {
  id: string;
  kind: "pilot" | "ablation" | "scaling";
  domain: CapabilityDomain;
  computePfDays: number;
  progressPfDays: number;
  confidenceGain: number;
  completed: boolean;
}

export interface ModelCheckpoint {
  id: string;
  progress: number;
  day: number;
  stability: number;
  reusable: boolean;
  trainingNumerics?: TrainingNumerics;
  /** @deprecated temporary alias used by early compute-v2 previews. */
  numerics?: TrainingNumerics;
}

export interface TrainingProgram {
  id: string;
  objective: string;
  targetSegments: SegmentId[];
  assignedPodIds: string[];
  pilots: ExperimentRun[];
  checkpoints: ModelCheckpoint[];
  domainForecasts: Partial<Record<CapabilityDomain, ForecastBand>>;
  confidence: number;
  integratedMethods: string[];
  dataManifestId: string | null;
}

export interface TrainingJob {
  id: string;
  name: string;
  family: ModelFamily;
  backbone?: ModelBackbone;
  productPreset?: ModelProductPreset;
  io?: ModelIO;
  targetParamsB: number;
  activeParamsB?: number;
  targetPfDays: number;
  progressPfDays: number;
  /** Cumulative accelerator energy proxy: allocated PF × MW/PF × active days. */
  energyMwDays?: number;
  /** Cumulative accelerator energy in MWh (`energyMwDays × 24`). */
  energyMWh?: number;
  /** Live ETA: max(remaining PF/current effective PF, remaining calendar gate). */
  daysRemaining?: number;
  /** Integration/validation time gate, independent of allocated PF. */
  minCalendarDays?: number;
  /** Funded, unpaused active days accumulated toward the calendar gate. */
  daysElapsed?: number;
  postTrain: PostTrainStage;
  postTrainProgress: number;
  postTrainTarget: number;
  /** One-shot stages inherited from, or completed within, this lineage. */
  completedPostTrainStages?: Exclude<PostTrainStage, "none">[];
  /** Frozen result for completed stages so later research cannot rewrite history. */
  postTrainStageEffectiveness?: Partial<
    Record<Exclude<PostTrainStage, "none">, number>
  >;
  /** Funded active days spent in the current post-training stage. */
  postTrainDaysElapsed?: number;
  mode: TrainMode;
  teacherId?: string;
  /**
   * Distill only: fraction of training signal from the teacher (0–1).
   * Rest comes from your processed corpus. High teacher ≈ ~80% retention.
   */
  distillTeacherShare?: number;
  /** Continue-train from existing model weights */
  continueFromId?: string;
  /** @deprecated */
  dataMix: DataMix;
  dataPlan: TrainingDataPlan;
  dataConsumed: Partial<Record<DataDomain, number>>;
  dataCoverage: number;
  dataQualityUsed: number;
  /** MTok filled by synth/bootstrap (not real stock) */
  syntheticUnits: number;
  trainShare: number;
  trainMTok: number;
  verifyMTok: number;
  /** Prior model tokens (continue-train) */
  priorDataMTok?: number;
  cashBurnPerDay: number;
  cashSunk: number;
  /** 0–1 LQ synth fraction of recipe — regresses capability */
  synthLqShare?: number;
  /** Deterministic hidden roll; result is computed only when the model finalizes. */
  outcomeSeed?: number;
  outcomeRisk?: "low" | "medium" | "high";
  effectiveDataRatio?: number;
  repeatedDataEpochs?: number;
  modalityComputeMult?: number;
  /** Immutable v4 data snapshot captured before the run starts. */
  dataManifestId?: string;
  /** Integrated-method snapshot; later disclosure changes cannot rewrite this run. */
  integratedMethods?: string[];
  /** Player-selected model-specific research integrations. */
  modelStack?: string[];
  dataQualityByDomain?: Partial<Record<DataDomain, number>>;
  lowQualityShareByDomain?: Partial<Record<DataDomain, number>>;
  syntheticProvenance?: SyntheticFillRecord[];
  /** Existing v5 jobs remain v1; newly-created jobs use physical 6ND work. */
  trainingFormulaVersion?: 1 | 2;
  trainingNumerics?: TrainingNumerics;
  /** @deprecated temporary alias used by early compute-v2 previews. */
  numerics?: TrainingNumerics;
  /** Weighted fair-share scheduling priority (10-100). */
  computePriority?: number;
  /** Reservation requested before opportunistic backfill. */
  reservedPf?: number;
  minimumDevices?: number;
  paused?: boolean;
  preemptible?: boolean;
  stallReason?: string | null;
  /** Terminal stage failure. Failed runs consume no more compute and must be deleted. */
  failed?: boolean;
  failureStage?: "base" | Exclude<PostTrainStage, "none">;
  failureDay?: number;
  failureReason?: string;
  /** Persisted, bounded telemetry used by the training loss chart. */
  lossHistory?: Array<{
    day: number;
    stage: "base" | Exclude<PostTrainStage, "none">;
    progress: number;
    loss: number;
  }>;
  /** Fixed recommended PF-day target captured at job creation. */
  recommendedPfDays?: number;
  /** Extra calendar days purchased after the recommendation milestone. */
  extensionDays?: number;
  /** True when the recommended milestone is reached and the player must decide. */
  awaitingDecision?: boolean;
  /** Split training cost accounting for UI / P&L. */
  economics?: TrainingEconomics;
  /** Mid-run benchmark snapshots; progress-scaled and non-terminal. */
  benchmarkSnapshots?: TrainingBenchmarkSnapshot[];
  /** Day of the last mid-run benchmark attempt. */
  lastBenchmarkDay?: number;
}

/** Upfront / data / accrued daily training cost split. */
export interface TrainingEconomics {
  setupCost: number;
  dataCost: number;
  trainingCostAccrued: number;
}

/** Deterministic but deliberately uncertain progress-scaled mid-training evaluation. */
export interface TrainingBenchmarkSnapshot {
  day: number;
  progress: number;
  /** Noisy point estimates; checkpoint benchmarking cannot reveal terminal quality exactly. */
  capability: number;
  safety: number;
  suite?: number;
  /** Nominal confidence in the interval (0-1). */
  confidence?: number;
  /** Minimum proportional uncertainty applied around each point estimate. */
  inaccuracy?: number;
  capabilityLow?: number;
  capabilityHigh?: number;
  safetyLow?: number;
  safetyHigh?: number;
}

export interface ModelEconomics {
  lifetimeApiRevenue: number;
  lifetimeSubRevenue: number;
  lifetimeEnterpriseRevenue: number;
  lifetimeServingCost: number;
  lifetimeNet: number;
  trainingInitialCost: number;
  trainingDataCost: number;
  trainingDailyCost: number;
}

export interface DataSupplierContract {
  id: string;
  supplierId: string;
  supplierName: string;
  domainMix: Partial<Record<DataDomain, number>>;
  quality: number;
  dailyDeliveryMTok: number;
  dailyPrice: number;
  termDays: number;
  daysRemaining: number;
  acceptedDay: number;
  status: "offered" | "active" | "completed" | "cancelled";
}

export interface StartTrainingOpts {
  name: string;
  family: ModelFamily;
  backbone?: ModelBackbone;
  productPreset?: ModelProductPreset;
  io?: ModelIO;
  /** Total size in billions of params */
  paramsB: number;
  /** MoE active params in billions */
  activeParamsB?: number;
  mode?: TrainMode;
  teacherId?: string;
  /**
   * Distill: 0 = almost all your corpus, 1 = almost all teacher signal.
   * Default ~0.72 (classic distill → ~80% of teacher).
   */
  distillTeacherShare?: number;
  /** Continue training from this model id */
  continueFromId?: string;
  /** @deprecated prefer dataPlan */
  dataMix?: DataMix;
  /** Domain mix + volume of processed data to use */
  dataPlan?: TrainingDataPlan;
  /** Research-backed runtime and architecture modules to integrate. */
  modelStack?: string[];
  trainingNumerics?: TrainingNumerics;
  computePriority?: number;
  reservedPf?: number;
}

/**
 * Serving precision on a plan. Quant saves inference PF at the cost of
 * effective quality/benchmarks for that plan's traffic.
 * Requires research unlocks: int8 → sys_quant, int4 → sys_fp8.
 */
export type PlanServePrecision = ServePrecision;

export interface PlanModalityRoute {
  modality: ModelIOModality;
  primaryModelId: string | null;
  fallbackModelId: string | null;
  /** Share of eligible traffic sent to the primary/SOTA artifact. */
  premiumShare: number;
  precision: ServePrecision;
}

export interface PlanDemandShock {
  id: string;
  kind: "launch" | "upgrade" | "removal" | "quantization";
  modality: ModelIOModality;
  modelId: string | null;
  startedDay: number;
  amplitude: number;
  halfLifeDays: number;
}

/** Subscription / product tier the player designs. */
export interface SubPlan {
  id: string;
  name: string;
  /** Monthly price in $ — 0 = free (revenue $0; ops still pay power/wages/etc.) */
  pricePerMonth: number;
  /**
   * Allowance vs base (ECONOMY.basePlanUsageMTokPerDay). 0.1×–100×.
   * Actual tokens = base × mult × usageRate.
   */
  usageMultiplier: number;
  /** V3 authoritative allowance. Legacy usageMultiplier is migrated into this value. */
  includedMTokPerMonth?: number;
  /**
   * Legacy save/display field. V3 utilization is always endogenous from plan
   * value, model quality, and service health; player input is ignored.
   */
  usageRate: number | null;
  /** Models a subscriber on this plan may use */
  modelIds: string[];
  /** Relative share of the subscription PF pool under load (10–100). */
  computePriority?: number;
  /**
   * Serve precision for this plan's traffic.
   * Free tiers often run int8/int4 to save capacity; paid keep fp16.
   */
  servePrecision?: PlanServePrecision;
  /**
   * Compute-v2 serving format for each released model exposed by this plan.
   * `servePrecision` remains as the legacy/default value for older saves.
   */
  servePrecisionByModel?: Record<string, PlanServePrecision>;
  /** Compute-v2 primary/fallback routing by native product modality. */
  modalityRoutes?: Partial<Record<ModelIOModality, PlanModalityRoute>>;
  /** Persistent novelty/trust shocks; deterministic decay is evaluated by day. */
  demandShocks?: PlanDemandShock[];
  /** Stable fraction of allowance consumed after launch effects decay. */
  steadyUsageTarget?: number;
  enabled: boolean;
  subscriberCap?: number;
}

export interface PlanDayStats {
  planId: string;
  name: string;
  subscribers: number;
  /** Soft seat cap from inference capacity for this plan today */
  maxSeats?: number;
  /** Subscription revenue only (0 if free) — never compute list prices */
  dayRevenue: number;
  /**
   * Share of real ops (energy/amort) attributed to this plan's tokens for UI margin.
   * Does not invent product COGS from API list prices.
   */
  dayCogs: number;
  /** Fixed serving operations allocated by this plan's share of inference PF. */
  allocatedComputeCostDay: number;
  dayMTok: number;
  /** Inference PF burned by this plan's tokens */
  dayInferPf: number;
  /** Daily inference PF attributable to one served subscriber. */
  computePfPerSubscriber: number;
  /** Per-model token and compute attribution when a plan exposes multiple models. */
  modelUsage?: PlanModelUsage[];
  /** Configured weighted priority used for today's subscription allocation. */
  computePriority?: number;
  /** Fraction of unconstrained plan demand admitted to serving today. */
  serveFraction?: number;
  costPerSubDay: number;
  marginPerSubMonth: number;
  isFree: boolean;
  /** Effective utilization of allowance used today */
  usageRate: number;
  /** Monthly included MTok/user at full allowance */
  allowanceMTokMonth?: number;
  /** API-list $ value of included tokens (utilization-adjusted) */
  apiEquivalentValue?: number;
  /** apiEquivalent / price; >1 = subsidizing tokens */
  subsidyRatio?: number;
  /** 0–1 price-too-high vs tokens + model quality */
  priceTooHigh?: number;
  /** 0–1 customer dissatisfaction from stingy or economically unstable terms. */
  dissatisfaction?: number;
  allowanceDissatisfaction?: number;
  stabilityDissatisfaction?: number;
}

export interface PlanModelUsage {
  modelId: string;
  name: string;
  dayMTok: number;
  dayInferPf: number;
  /** Fraction of this plan's served tokens routed to this model. */
  share: number;
  /** Fully loaded serving cost after model intensity and plan precision. */
  costPerMTok: number;
}

export interface ProductPricing {
  /** Blended $/MTok for market scoring / rivals (from in+out mix) */
  apiPricePerMTok: number;
  /** $/1M input tokens */
  apiPriceInPerMTok: number;
  /** $/1M output tokens */
  apiPriceOutPerMTok: number;
  /** Default markup % applied when using "set to markup" (100 = 2× cost) */
  apiMarkupPct: number;
  /**
   * Under compute constraint, fraction of inference PF reserved for API vs subs.
   * 0 = all subs, 1 = all API. Default ~0.68 (API preferred).
   */
  apiVsSubPriority: number;
  /** Public models currently listed as simultaneous API endpoints. */
  apiModelIds?: string[];
  /** Per-endpoint API precision. Missing entries serve full precision. */
  apiServePrecisionByModel?: Record<string, PlanServePrecision>;
  activeModelId: string | null;
  enterpriseContractBonus: number;
  plans: SubPlan[];
  /** Rival-facing headline sub price (derived for rivals; player uses plans) */
  subPlusPrice: number;
  subProPrice: number;
  plusIncludedMTok: number;
  proIncludedMTok: number;
}

export interface SegmentState {
  id: SegmentId;
  size: number;
  usageIntensity: number;
  /**
   * Persistent share of this segment attached to each lab (plus `outside`).
   * Kept at provider rather than model granularity so publishing duplicate
   * endpoints cannot evade customer switching costs.
   */
  providerShares?: Record<string, number>;
}

export interface MarketOffer {
  labId: string;
  modelId: string;
  capability: number;
  reliability: number;
  safety: number;
  brandTrust: number;
  apiPrice: number;
  subPrice: number;
  latencyScore: number;
  /** Effective tokens/sec for speed factor */
  tokPerSec: number;
  modalities: Modality[];
  isOpenWeights: boolean;
  benchmarks: BenchmarkScores;
  /** API-specific effective quality after endpoint quantization. */
  apiCapability?: number;
  apiReliability?: number;
  apiTokPerSec?: number;
  apiBenchmarks?: BenchmarkScores;
  /** True for image/video generators that may serve creative demand only. */
  generationOnly?: boolean;
  /** False when this model is not currently listed as an API endpoint. */
  apiListed?: boolean;
  /** False when this model is not exposed by any enabled subscription plan. */
  subscriptionListed?: boolean;
}

/** Public API product offer emitted for every released model. */
export interface ApiOffer {
  labId: LabId;
  modelId: string;
  priceInPerMTok: number;
  priceOutPerMTok: number;
  marginalCostPerMTok: number;
  capability: number;
  features: Modality[];
  service: ServiceProfile;
}

/** Public subscription product offer emitted for every enabled plan. */
export interface SubscriptionOffer {
  labId: LabId;
  planId: string;
  pricePerMonth: number;
  includedMTokPerMonth: number;
  modelIds: string[];
  servePrecision: PlanServePrecision;
}

/** The six public endpoints a lab may promote at one time. */
export type ProductChannel =
  | "free_assistant"
  | "consumer_pro"
  | "creator_developer"
  | "payg_api"
  | "reserved_throughput_api"
  | "enterprise_dedicated";

export type ProductBillingModel =
  "free" | "subscription" | "usage" | "reserved" | "contract";

export interface ProductOfferPricing {
  billingModel: ProductBillingModel;
  monthlyUsd: number | null;
  includedMTokPerMonth: number | null;
  inputUsdPerMTok: number | null;
  outputUsdPerMTok: number | null;
  overageInputUsdPerMTok: number | null;
  overageOutputUsdPerMTok: number | null;
  minimumCommitmentUsd: number | null;
}

/** Canonical public product projection backed by existing model and plan state. */
export interface ProductOffer {
  id: string;
  labId: LabId;
  channel: ProductChannel;
  name: string;
  promoted: boolean;
  sourcePlanId: string | null;
  primaryModelId: string;
  modelIds: string[];
  targetSegments: SegmentId[];
  pricing: ProductOfferPricing;
  delivery: "shared" | "reserved" | "dedicated";
  capacityPriority: number;
  servePrecision: PlanServePrecision;
  capability: number;
  reliability: number;
  modalities: Modality[];
}

export type ProductQualityDimension =
  "factuality" | "steerability" | "robustness" | "safety" | "reliability";

export interface DemandSegment {
  id: SegmentId;
  name: string;
  currentUsers: number;
  baseUsers: number;
  usefulTaskDemandPerUserDay: number;
  /** Elasticity-like coefficient: larger means more price-sensitive. */
  priceSensitivity: number;
  /** 0 switches quickly; 1 has slow procurement and high switching costs. */
  switchingFriction: number;
  domainWeights: Partial<Record<CapabilityDomain, number>>;
  productQualityWeights: Partial<Record<ProductQualityDimension, number>>;
  benchmarkWeights: Partial<Record<BenchmarkId, number>>;
  preferredChannels: ProductChannel[];
  referencePrice: {
    value: number;
    unit: "monthly_usd" | "usd_per_mtok";
  };
  targetLatencyMs: number;
  outsideOptionUtility: number;
}

export interface MarketDayResult {
  labId: LabId;
  requestedMTok: number;
  servedMTok: number;
  unservedMTok: number;
  apiRevenue: number;
  subscriptionRevenue: number;
  servingCogs: number;
  marketShare: number;
  servicePain: number;
}

/** Post-release interactive benchmark beat */
export interface BenchmarkEvent {
  id: string;
  day: number;
  modelId: string;
  modelName: string;
  scores: BenchmarkScores;
  capability: number;
  rivalCompare: {
    benchmarkId: BenchmarkId;
    label: string;
    ours: number;
    bestRival: number;
    rivalName: string;
    win: boolean;
  }[];
  wins: number;
  losses: number;
  headline: string;
  dismissed: boolean;
}

export type EvaluationKind =
  "internal" | "public" | "blind_audit" | "real_world";
export type ReviewAudience =
  "consumer" | "developers" | "scientists" | "creators" | "enterprise";

export interface BenchmarkSeason {
  id: string;
  name: string;
  version: number;
  opensDay: number;
  closesDay: number;
  difficulty: number;
  hiddenTasks: boolean;
  active: boolean;
}

export interface EvaluationRun {
  id: string;
  labId?: LabId;
  modelId: string;
  seasonId: string;
  kind: EvaluationKind;
  scheduledDay: number;
  publishDay: number;
  scores: Partial<BenchmarkScores>;
  confidence: number;
  contaminationFlags: string[];
  published: boolean;
}

export interface ModelReview {
  id: string;
  labId?: LabId;
  modelId: string;
  audience: ReviewAudience;
  capability: number;
  value: number;
  productQuality: number;
  trust: number;
  publishedDay: number;
  phase: "launch" | "field_30" | "quarterly";
  headline: string;
}

/**
 * Daily & lifetime lab finances.
 * Product COGS = inference energy/amort/bandwidth charged to API+subs.
 * OpEx = wages, marketing, facilities, residual energy/amort.
 */
export interface LabFinance {
  cash: number;
  /** Total top-line revenue today */
  dayRevenue: number;
  /** Product COGS only (api + sub). Kept for valuation compatibility. */
  dayCogs: number;
  dayEnergyCost: number;
  dayWageCost: number;
  dayChipAmort: number;
  dayBuildingOpex: number;
  dayMarketing: number;
  /** Loan principal + interest paid today */
  dayLoanPayment: number;
  /** Energy charged to non-inference pools */
  dayEnergyOther: number;
  /** Chip amort charged to non-inference */
  dayChipAmortOther: number;
  apiRevenue: number;
  subRevenue: number;
  enterpriseRevenue: number;
  apiCogs: number;
  subCogs: number;
  /** dayRevenue - product COGS */
  dayGrossProfit: number;
  /** Full day net cash change from ops (matches cash delta) */
  dayNet: number;
  /** Sum of all cash outflows today (product cogs + opex + residual) */
  dayTotalOut: number;
  marginPerSub: number;
  marginPerMTok: number;
  totalShare: number;
  valuation: number;
  lifetimeRevenue: number;
  lifetimeNet: number;
  lifetimeProductCogs: number;
  peakCash: number;
  lowestCash: number;
  /** Days of cash left at current burn (∞ if profitable) */
  runwayDays: number;
  /** Outstanding loan balance (principal+interest still due) */
  debtOutstanding: number;
  /** Optional advanced-mode carbon, water, rights, and audit spend today. */
  dayExternalityCost?: number;
}

/** Fixed catalog of bank credit lines the player can draw. */
export interface LoanOffer {
  id: string;
  label: string;
  blurb: string;
  principal: number;
  termDays: number;
  /** Total interest as a fraction of principal over the full term */
  interestTotal: number;
}

/** An active credit drawdown with amortizing daily payments. */
export interface ActiveLoan {
  id: string;
  offerId: string;
  label: string;
  principal: number;
  /** Remaining amount still owed (principal + interest) */
  remaining: number;
  dailyPayment: number;
  daysLeft: number;
  termDays: number;
  takenDay: number;
  interestTotal: number;
}

export type DebtInstrumentKind =
  "revolver" | "equipment" | "project_finance" | "venture_debt" | "bond";

export interface DebtInstrument {
  id: string;
  kind: DebtInstrumentKind;
  label: string;
  principal: number;
  remaining: number;
  apr: number;
  termDays: number;
  daysLeft: number;
  dailyPayment: number;
  collateralValue: number;
  covenant: string;
  breached: boolean;
}

export interface EquityStake {
  holderId: string;
  holderName: string;
  ownership: number;
  votingPower: number;
  kind: "founder" | "investor" | "option_pool" | "public";
}

export interface FundingRound {
  id: string;
  label: string;
  day: number;
  preMoneyValuation: number;
  cashRaised: number;
  postMoneyValuation: number;
  dilution: number;
  investorName: string;
}

export interface EquityOffer {
  id: string;
  investorName: string;
  cashRaised: number;
  preMoneyValuation: number;
  postMoneyValuation: number;
  investorOwnership: number;
  optionPoolTopUp: number;
  confidenceRequired: number;
  expiresDay: number;
}

export type MarketingChannel =
  "web" | "billboards" | "restaurants" | "enterprise";

export type MarketingChannels = Record<MarketingChannel, number>;

export interface CapitalStack {
  capTable: EquityStake[];
  fundingRounds: FundingRound[];
  debt: DebtInstrument[];
  investorConfidence: number;
  boardPressure: number;
  founderControl: number;
  restructuring: {
    active: boolean;
    daysLeft: number;
    stage: "none" | "warning" | "refinance" | "asset_sale" | "bankruptcy";
  };
}

/** Compact ring-buffer sample for charts / trends. */
export interface FinanceDaySnapshot {
  day: number;
  cash: number;
  revenue: number;
  productCogs: number;
  opex: number;
  energy: number;
  net: number;
  share: number;
  servedMTok: number;
  demandMTok: number;
  effectivePf: number;
  valuation: number;
  /** Brand trust at close; optional for saves created before brand history existed. */
  brand?: number;
}

/** Monthly roll-up retained after detailed daily finance ages out. */
export interface FinanceMonthSnapshot {
  year: number;
  month: number;
  firstDay: number;
  lastDay: number;
  days: number;
  closingCash: number;
  revenue: number;
  productCogs: number;
  opex: number;
  energy: number;
  net: number;
  averageShare: number;
  servedMTok: number;
  demandMTok: number;
  averageEffectivePf: number;
  averageValuation: number;
}

/** Per-model income attribution for the stats panel. */
export interface ModelFinanceRow {
  modelId: string;
  name: string;
  family: string;
  release: string;
  isActive: boolean;
  isPublic: boolean;
  capability: number;
  apiPricePerMTok: number;
  dayApiRevenue: number;
  /** Token-normalized energy, hardware amortization, lease, and bandwidth. */
  dayApiDirectCogs: number;
  /** Campus and idle-capacity allocation retained for company accounting. */
  dayApiAllocatedOps: number;
  dayApiCogs: number;
  dayApiMTok: number;
  /** Revenue less direct token COGS, before company overhead. */
  dayApiContribution: number;
  /** Served tokens divided by normalized endpoint capacity. */
  apiCapacityUtilization: number;
  daySubRevenue: number;
  daySubCogs: number;
  dayEnterpriseShare: number;
  dayNet: number;
  note: string;
}

export type ComputeWorkKind =
  | "api_text"
  | "subscription_text"
  | "image_generation"
  | "audio"
  | "video_generation"
  | "training"
  | "research"
  | "evaluation"
  | "synthetic_data"
  | "data_processing";

export interface NativeWorkUnits {
  inputMTok?: number;
  outputMTok?: number;
  images?: number;
  megapixelSteps?: number;
  audioSeconds?: number;
  videoSeconds?: number;
}

/** One conserved unit of work from customer request through billing. */
export interface ComputeWorkItem {
  id: string;
  labId: LabId;
  kind: ComputeWorkKind;
  modelId?: string;
  planId?: string;
  requested: NativeWorkUnits;
  admitted: NativeWorkUnits;
  served: NativeWorkUnits;
  billed: NativeWorkUnits;
  requestedPfDays: number;
  servedPfDays: number;
  revenue: number;
  directCogs: number;
  rejectedReason?: "capacity" | "memory" | "latency" | "unsupported_precision";
}

export interface ComputeLedger {
  day: number;
  labId: LabId;
  items: ComputeWorkItem[];
  requestedPfDays: number;
  admittedPfDays: number;
  servedPfDays: number;
  billedPfDays: number;
  capacityPfDays: number;
  reservedPfDays: number;
  backfilledPfDays: number;
}

export type RivalGoalKind =
  | "survive"
  | "restore_service"
  | "ship_model"
  | "unlock_research"
  | "defend_segment"
  | "grow_share"
  | "improve_efficiency";

export interface RivalBeliefState {
  observedDay: number;
  frontierCapability: number;
  marketPricePerMTok: number;
  demandGrowth: number;
  confidence: number;
}

export interface RivalDecisionRecord {
  day: number;
  actionKind: string;
  expectedUtility: number;
  realizedUtility?: number;
  result: "planned" | "applied" | "failed";
}

export interface RivalControllerState {
  profileId: RivalArchetype;
  goal: RivalGoalKind;
  secondaryGoal?: RivalGoalKind;
  beliefs: RivalBeliefState;
  plan: string[];
  memory: RivalDecisionRecord[];
  cooldowns: Record<string, number>;
  decisionRevision: number;
  lastOperationalDay: number;
  lastTacticalDay: number;
  lastStrategicDay: number;
}

export type LabAction =
  | { kind: "set_allocation"; allocation: Allocation }
  | { kind: "queue_research"; nodeId: string }
  | { kind: "set_api_price"; modelId: string; input: number; output: number }
  | {
      kind: "set_api_precision";
      modelId: string;
      precision: PlanServePrecision;
    }
  | {
      kind: "set_training_priority";
      jobId: string;
      priority: number;
      reservedPf?: number;
    }
  | { kind: "pause_training"; jobId: string; paused: boolean }
  | { kind: "configure_plan_route"; planId: string; route: PlanModalityRoute };

export interface LabActionPreview {
  legal: boolean;
  reasons: string[];
  cashCost: number;
  expectedPfDays: number;
}

export interface RivalLab {
  id: string;
  name: string;
  archetype: RivalArchetype;
  cash: number;
  chips: number;
  flopsPf: number;
  utilCap: number;
  servingEfficiency: number;
  allocation: Allocation;
  researchUnlocked: string[];
  models: Model[];
  /**
   * Save-compatible record of distinct products shipped by this rival. The
   * serving fleet is intentionally bounded, so lifecycle policy must not use
   * `models` alone as its historical memory.
   */
  releaseMilestones?: RivalReleaseMilestone[];
  pricing: ProductPricing;
  brandTrust: number;
  activeResearch: string | null;
  researchProgress: number;
  /** Calendar days spent on activeResearch (same floor as player). */
  researchDaysSpent?: number;
  marketShare: number;
  regionId: string;
  color: number;
  /**
   * Rival corpus (MTok) — same 1:1-ish data constraints as the player.
   * Market share fuels user-token growth.
   */
  dataMTok: number;
  dataQuality: number;
  /** Optional per-domain MTok (for specialty releases) */
  domainMTok?: Partial<Record<DataDomain, number>>;
  /**
   * Full corpus inventory (same shape as player). Preferred over scalar dataMTok.
   * Starts at 500 MTok web crawl like the player.
   */
  data?: LabData;
  /** Active pretrain job — same scale/data rules as player */
  trainingJob?: RivalTrainJob | null;
  /** Canonical concurrent jobs used by compute-v2 rivals. */
  trainingJobs?: TrainingJob[];
  /** Research queue (node ids), same tree as player */
  researchQueue?: string[];
  /** 0–1 overload EMA (shared capacity economy) */
  servicePain?: number;
  /** Last-day abstract product revenue */
  dayRevenue?: number;
  /** Provider-neutral compute contract income accrued before market settlement. */
  computeLeaseIncomeToday?: number;
  /** Provider-neutral compute contract cost accrued before market settlement. */
  computeLeaseCostToday?: number;
  /** Inference PF demand / capacity last tick */
  lastDemandPf?: number;
  lastCapacityPf?: number;
  lastUnserved?: number;
  /** Train recipe preferences */
  trainPreferSynthHQ?: boolean;
  trainAllowSynthLQ?: boolean;
  /** Rival HQ employees (same roles as player) */
  staff?: StaffHeadcount;
  /** Canonical lab parity fields retained on the rival compatibility view. */
  controller?: LabController;
  loans?: ActiveLoan[];
  finance?: LabFinance;
  capital?: CapitalStack;
  computeContracts?: ComputeContract[];
  trainEfficiency?: number;
  pue?: number;
  researchLeads?: ResearchLead[];
  researchPods?: ResearchPod[];
  researchPrograms?: ResearchProgram[];
  trainingPrograms?: TrainingProgram[];
  rackFleet?: RackInstall[];
  rackDesigns?: RackDesign[];
  fab?: FabProject;
  marketingSpendPerDay?: number;
  /** Persistent growth allocation as a multiple of the lab's daily revenue basis. */
  marketingRevenueMultiple?: number;
  marketingChannels?: MarketingChannels;
  enterpriseContracts?: number;
  wagesPerDay?: number;
  powerExportEnabled?: boolean;
  publicEstimate?: RivalPublicEstimate;
  strategy?: RivalControllerState;
}

/**
 * Canonical v4 lab record. PlayerState and RivalLab remain compatibility views
 * while systems move to lab-id based actions.
 */
export interface LabState {
  id: LabId;
  name: string;
  controller: LabController;
  archetype: RivalArchetype | "player";
  regionId: string;
  color: number;
  cash: number;
  finance: LabFinance;
  loans: ActiveLoan[];
  capital?: CapitalStack;
  computeContracts?: ComputeContract[];
  allocation: Allocation;
  utilCap: number;
  servingEfficiency: number;
  trainEfficiency: number;
  pue: number;
  staff: StaffHeadcount;
  researchLeads?: ResearchLead[];
  researchPods?: ResearchPod[];
  researchPrograms?: ResearchProgram[];
  trainingPrograms?: TrainingProgram[];
  dataQuality: number;
  data: LabData;
  brandTrust: number;
  servicePain: number;
  researchUnlocked: string[];
  activeResearch: ResearchProgress | string | null;
  researchQueue: string[];
  models: Model[];
  trainingJob: TrainingJob | RivalTrainJob | null;
  pricing: ProductPricing;
  rackFleet: RackInstall[];
  rackDesigns: RackDesign[];
  fab: FabProject;
  marketingSpendPerDay: number;
  /** Persistent growth allocation as a multiple of the lab's daily revenue basis. */
  marketingRevenueMultiple?: number;
  marketingChannels?: MarketingChannels;
  enterpriseContracts: number;
  wagesPerDay: number;
  /** Compatibility bridge until every physical rival rack has been materialized. */
  abstractFlopsPf: number;
  abstractChipCount: number;
  marketShare: number;
  publicEstimate?: RivalPublicEstimate;
}

export type ResourceMarketKind = "accelerator" | "data" | "talent";

export interface ResourceOrder {
  id: string;
  labId: LabId;
  kind: ResourceMarketKind;
  resourceId: string;
  quantity: number;
  maxUnitPrice: number;
  quantityFilled: number;
  cashReserved: number;
  submittedDay: number;
  expiresDay: number;
  destination?: { x: number; y: number };
  metadata?: Record<string, string | number | boolean>;
}

export type LabIntent =
  | {
      id: string;
      labId: LabId;
      kind: "allocation";
      allocation: Allocation;
      submittedDay: number;
    }
  | {
      id: string;
      labId: LabId;
      kind: "resource_order";
      order: ResourceOrder;
      submittedDay: number;
    }
  | {
      id: string;
      labId: LabId;
      kind: "loan_application";
      application: LoanApplication;
      submittedDay: number;
    }
  | {
      id: string;
      labId: LabId;
      kind: "api_price";
      modelId: string;
      priceIn: number;
      priceOut: number;
      submittedDay: number;
    };

export interface MarketFill {
  id: string;
  orderId: string;
  labId: LabId;
  kind: ResourceMarketKind;
  resourceId: string;
  quantity: number;
  unitPrice: number;
  day: number;
}

export interface AcceleratorSupply {
  skuId: string;
  available: number;
  dailyReplenishment: number;
  reserveUnitPrice: number;
  backlog: number;
  leadTimeDays: number;
}

export interface CapitalConditions {
  cycle: number;
  baseRate: number;
  creditMult: number;
  rateSpread: number;
  industryDebt: number;
}

export interface LoanApplication {
  id: string;
  labId: LabId;
  principal: number;
  termDays: number;
  submittedDay: number;
  status: "pending" | "offered" | "rejected" | "accepted" | "expired";
  offerId?: string;
}

export interface FirmLoanOffer {
  id: string;
  applicationId: string;
  labId: LabId;
  principal: number;
  termDays: number;
  interestTotal: number;
  expiresDay: number;
}

export interface WorldMarkets {
  accelerators: Record<string, AcceleratorSupply>;
  cloudProviders: CloudProvider[];
  orders: ResourceOrder[];
  fills: MarketFill[];
  loanApplications: LoanApplication[];
  loanOffers: FirmLoanOffer[];
  capital: CapitalConditions;
  lastClearedDay: number;
  intents: LabIntent[];
}

export interface TrainingSpec {
  name: string;
  backbone: ModelBackbone;
  productPreset: ModelProductPreset;
  paramsB: number;
  activeParamsB?: number;
  io: ModelIO;
  dataPlan: TrainingDataPlan;
  mode: TrainMode;
  teacherId?: string;
  distillTeacherShare?: number;
  modelStack?: string[];
  trainingNumerics?: TrainingNumerics;
}

export interface TrainingForecast {
  targetPfDays: number;
  /** Physical fleet draw at the planned training allocation. */
  powerMw: number;
  etaDays: number;
  minCalendarDays: number;
  upfrontCash: number;
  cashBurnPerDay: number;
  weightedMTok: number;
  effectiveDataRatio: number;
  repeatedDataEpochs: number;
  modalityComputeMult: number;
  expectedCapability: number;
  interactiveTokPerSec: number;
  risk: "low" | "medium" | "high";
  warnings: string[];
  /** Composed precision assumptions for quote presentation. */
  precision?: {
    label: string;
    trainingWorkMultiplier: number;
    upfrontCashMultiplier: number;
    dailyCashMultiplier: number;
    qualityCeilingMultiplier: number;
    lossVolatilityMultiplier: number;
    inferenceCostMultiplier: number;
    stabilityRisk: number;
  };
}

export interface RivalPublicEstimate {
  labId: LabId;
  day: number;
  computePf: [number, number];
  dataMTok: [number, number];
  cash: [number, number];
  debt: [number, number];
  runwayDays: [number, number];
  announcedProject: string | null;
  /** Publicly inferable strategic posture; never exposes private recipes. */
  focus?: string;
  /** Product/backbone currently being trained or the next disclosed research bet. */
  currentBet?: string;
  /** Confidence in `currentBet`, separate from broad operating-range confidence. */
  currentBetConfidence?: number;
  /** Present only when the named research program was actually disclosed. */
  researchDisclosure?: Exclude<ResearchDisclosure, "secret">;
  confidence: number;
}

export interface RivalReleaseMilestone {
  productPreset: ModelProductPreset;
  backbone: ModelBackbone;
  modelId: string;
  releaseDay: number;
}

/** Rival multi-day pretrain — progresses with train-allocation PF. */
export interface RivalTrainJob {
  id: string;
  name: string;
  family: ModelFamily;
  backbone?: ModelBackbone;
  productPreset?: ModelProductPreset;
  io?: ModelIO;
  paramsB: number;
  activeParamsB?: number;
  targetPfDays: number;
  progressPfDays: number;
  /** Calendar integration/validation floor, independent of PF work. */
  minCalendarDays?: number;
  /** Funded, unpaused active days accrued toward the calendar floor. */
  daysElapsed?: number;
  modalities: Modality[];
  /** Planned volume vs min for size (can be &lt;1 if risking undertrain) */
  dataCoverage: number;
  /** Blended quality 0–100 after recipe (HQ/LQ synth) */
  dataQuality: number;
  includeSynthHQ: boolean;
  includeSynthLQ: boolean;
  /** Fraction of train tokens that were LQ synth (regression risk) */
  synthLqShare: number;
  trainShare: number;
  totalMTok: number;
  outcomeSeed?: number;
  outcomeRisk?: "low" | "medium" | "high";
  effectiveDataRatio?: number;
  repeatedDataEpochs?: number;
  modalityComputeMult?: number;
  cashBurnPerDay?: number;
  cashSunk?: number;
  /** Numerical recipe selected through the same research/hardware gates as player jobs. */
  trainingNumerics?: TrainingNumerics;
  /** Weighted scheduling controls retained while rivals use the legacy single-job view. */
  computePriority?: number;
  reservedPf?: number;
  paused?: boolean;
}

export interface MapRegion {
  id: string;
  name: string;
  originX: number;
  originY: number;
  width: number;
  height: number;
  energyPriceMult: number;
  latencyToMarket: number;
  regulationRisk: number;
}

/** Metro or derived settlement anchor with demand / power-service stats. */
export interface MapCity {
  id: string;
  name: string;
  cx: number;
  cy: number;
  radius: number;
  population: number;
  /** Chebyshev radius: tiles in zone can sell power to this city */
  powerRadius: number;
  /** MW the city will offtake from producers at buyback rates */
  powerBuyMw: number;
  /** Mult on wholesale for city offtake (usually < 1) */
  powerBuyPriceMult: number;
  industry: string;
  /** Generator-v3 settlement metadata; absent on legacy and v2 maps. */
  tier?: CityTier;
  parentCityIndex?: number;
  regionIndex?: number;
  palette?: CityPalette;
  growth?: CityGrowthMetadata;
  /**
   * Shared free talent pool (player + rivals hire from this).
   * Regenerates slowly toward capacity each day.
   */
  talentAvailable?: StaffHeadcount;
  /** Soft ceiling for free talent in this metro */
  talentCapacity?: StaffHeadcount;
  /** Local wage index (1 = baseline) */
  talentWageMult?: number;
}

export interface MapTile {
  x: number;
  y: number;
  regionId: string;
  kind: TileKind;
  owner: TileOwner;
  name: string;
  level: number;
  buildingProgress: number;
  buildingTarget: number;
  /** Player paid the one-time fast-track premium for this construction. */
  constructionExpedited?: boolean;
  rackCapacity: number;
  racksUsed: number;
  mwCapacity: number;
  mwGeneration: number;
  /** One-time capex sunk */
  capex: number;
  /** Daily operating cost when complete (player only) */
  opexPerDay: number;
  /** Optional flavor */
  note: string;
  /**
   * Purchase cost for empty parcels (proximity to cities).
   * Paid on top of building construction cost when placing.
   */
  landValue: number;
  /** Optional metro anchor id for land/value affinity */
  cityId?: string;
  /** Data halls: false = powered down (no compute / no draw) */
  powered?: boolean;
  /** Rival hall listed for acquisition */
  forSale?: boolean;
  listPrice?: number;
  /** Multi-tile campus id (shared across footprint) */
  campusId?: string;
  /** Anchor holds rack capacity; pads occupy land for footprint */
  campusRole?: "anchor" | "pad";
  /** Hall size class for UI / 3D kit */
  dcSize?: DcSize;
  /** HQ size class */
  hqSize?: HqSize;
}

export interface BuildDef {
  kind: BuildableKind;
  label: string;
  blurb: string;
  cash: number;
  days: number;
  rack?: number;
  mw?: number;
  gen?: number;
  opexPerDay: number;
  upgradeCash?: number;
  upgradeRack?: number;
  upgradeMw?: number;
  upgradeDays?: number;
  /** Extra tiles relative to click (0,0 = anchor). Default 1 tile. */
  footprint?: { dx: number; dy: number }[];
  dcSize?: DcSize;
  hqSize?: HqSize;
  /** Max staff seats for HQ buildings */
  staffCap?: number;
}

export interface FabProject {
  phase: FabPhase;
  daysInPhase: number;
  daysRequired: number;
  cashSunk: number;
  yieldRate: number;
  designPerfPerWatt: number;
  chipsProduced: number;
  failed: boolean;
  /** Architecture choices are editable between tape-outs and frozen during a run. */
  designFocus?: ChipDesignFocus;
  designTechIds?: ChipDesignTechId[];
}

export interface PlayerState {
  name: string;
  cash: number;
  /**
   * Legacy loose accelerators (fab output / older saves).
   * Prefer rackFleet for new gameplay — buy-GPU market is retired.
   */
  chips: ChipInventory[];
  /** Primary compute: racks installed (or on order) in data halls */
  rackFleet: RackInstall[];
  /** @deprecated designer mini-game — kept for save compat */
  rackDesigns: RackDesign[];
  /** @deprecated use rackFleet */
  deployedRacks: DeployedRackGroup[];
  /** @deprecated use rackFleet order flow */
  moduleStock: ModuleStock[];
  allocation: Allocation;
  utilCap: number;
  servingEfficiency: number;
  trainEfficiency: number;
  pue: number;
  /**
   * Legacy aggregate talent score — derived from HQ staff when present.
   * Prefer player.staff for gameplay.
   */
  talent: number;
  /**
   * Employees hired into HQs (researchers, data processors, engineers, ops).
   * Capacity comes from completed HQ buildings.
   */
  staff?: StaffHeadcount;
  /** Named senior staff plus aggregate pods for decade campaigns. */
  researchLeads?: ResearchLead[];
  researchPods?: ResearchPod[];
  researchPrograms?: ResearchProgram[];
  trainingPrograms?: TrainingProgram[];
  /** Cash spent on active research progress today (already deducted from cash) */
  researchCashBurnToday?: number;
  /** Sell surplus generation to cities / grid (default on) */
  powerExportEnabled?: boolean;
  computeLeaseIncomeToday?: number;
  computeLeaseCostToday?: number;
  computeContracts?: ComputeContract[];
  /** Promotional credits pay cloud invoices before cash. */
  cloudCredits?: number;
  /** Global data hygiene / partnership multiplier (legacy + still used) */
  dataQuality: number;
  /** Full corpus inventory + processing */
  data: LabData;
  brandTrust: number;
  /**
   * 0–1 EMA of capacity overload (demand ≫ inference).
   * Raises latency, drives gradual churn / complaints until compute catches up.
   */
  servicePain: number;
  researchUnlocked: string[];
  activeResearch: ResearchProgress | null;
  /** Ordered research queue (next starts when active completes) */
  researchQueue: string[];
  /** Named-pod method queue; kept separate from the legacy single-worker queue. */
  researchProgramQueue?: string[];
  models: Model[];
  /** Concurrent player training jobs. `trainingJob` mirrors the first entry for legacy saves. */
  trainingJobs?: TrainingJob[];
  trainingJob: TrainingJob | null;
  safetyCampaign: SafetyCampaign | null;
  /** Negotiated recurring data suppliers (3-company system). */
  dataSupplierContracts?: DataSupplierContract[];
  dataSupplierOffers?: DataSupplierContract[];
  pricing: ProductPricing;
  finance: LabFinance;
  wagesPerDay: number;
  fab: FabProject;
  marketingSpendPerDay: number;
  /** Persistent growth allocation as a multiple of the lab's daily revenue basis. */
  marketingRevenueMultiple?: number;
  marketingChannels?: MarketingChannels;
  enterpriseContracts: number;
  /** Active bank loans / credit lines */
  loans: ActiveLoan[];
  capital?: CapitalStack;
  /** Daily raw-PF-per-drawn-MW samples for the Power panel trend (newest last). */
  powerEfficiencyHistory?: PowerEfficiencySample[];
}

export interface WorldEvent {
  id: string;
  title: string;
  body: string;
  day: number;
  duration: number;
  /** Authored multi-stage industry storyline metadata. */
  chainId?: string;
  chainStage?: number;
  nextEventId?: string;
  effects: {
    energyPriceMult?: number;
    chipLeadMult?: number;
    segmentBoost?: Partial<Record<SegmentId, number>>;
    brandHit?: number;
    rivalBoost?: number;
    exportBanGen?: number;
  };
}

export interface SimAlert {
  id: string;
  day: number;
  severity: "info" | "warn" | "danger";
  message: string;
}

export interface VictoryState {
  outcome: GameOutcome;
  reason: string;
  goalShare: number;
  goalValuation: number;
  goalCapability: number;
  bankruptDay: number;
}

export type ExternalityMode = "standard" | "advanced";

export interface ExternalityAccount {
  labId: LabId;
  monthKey: string;
  energyMWh: number;
  carbonTons: number;
  waterM3: number;
  carbonBudgetTons: number;
  waterBudgetM3: number;
  complianceCost: number;
  rightsRisk: number;
  auditRisk: number;
  lastAuditDay: number | null;
  violations: number;
}

export interface ExternalityIncident {
  id: string;
  labId: LabId;
  day: number;
  kind: "data_rights" | "safety_audit" | "carbon_overage" | "water_overage";
  fine: number;
  trustLoss: number;
  description: string;
}

export interface ExternalityState {
  accounts: Record<LabId, ExternalityAccount>;
  incidents: ExternalityIncident[];
}
export type CampaignEra =
  | "cloud_startup"
  | "scaling_specialization"
  | "platform_competition"
  | "power_limited_frontier"
  | "frontier_abundance"
  | "endless";

export interface CampaignRules {
  contentPackId: string;
  startYear: number;
  reportYear: number;
  endless: boolean;
  externalityMode: ExternalityMode;
  /** Marks saves created after auto-pause became an explicit user preference. */
  autoPauseConfigured?: boolean;
  cadence: {
    marketDays: number;
    accountingDays: number;
    reviewDays: number;
    technologyDays: number;
  };
  autoPause: {
    projectComplete: boolean;
    majorEvent: boolean;
    quarterlyReport: boolean;
    runwayEmergency: boolean;
  };
}

export interface AutomationPolicies {
  overflowCloud: {
    enabled: boolean;
    targetUtilization: number;
    maxPf: number;
    maxDailySpend: number;
  };
  allocation: {
    enabled: boolean;
    inferenceHeadroom: number;
  };
  dataProcessing: {
    enabled: boolean;
  };
  fleetDeployment: {
    enabled: boolean;
    weeklyBudget: number;
  };
  productCapacity: {
    enabled: boolean;
  };
}

/** Versioned calibration boundary pinned by each campaign save. */
export interface IndustryDataPack {
  id: string;
  version: number;
  calibratedThroughYear: number;
  demand: {
    baselineUsefulTasks: number;
    reportYearMinMultiplier: number;
    reportYearMaxMultiplier: number;
  };
  compute: {
    cloudOwnedPremiumMin: number;
    cloudOwnedPremiumMax: number;
    emergencyPremium: number;
    /** Physical formula generation; v1 saves retain their embedded pack. */
    modelVersion?: 1 | 2;
    trainingTimeCompression?: number;
    onlineHeadroom?: number;
    baselineTrainingMfu?: number;
  };
  infrastructure: {
    colocationLeadDays: [number, number];
    ownedLeadDays: [number, number];
    ownedPaybackMonths: [number, number];
  };
  benchmarkFamilies: string[];
  speculativeAfterYear: number;
}

export interface CalendarState {
  year: number;
  month: number;
  dayOfMonth: number;
  dayOfYear: number;
  era: CampaignEra;
  isMarketDay: boolean;
  isAccountingDay: boolean;
  isReviewDay: boolean;
  isTechnologyDay: boolean;
}

export type MilestoneId =
  | "sustainable_launch"
  | "frontier_leader"
  | "abundance_leader"
  | "code_record"
  | "science_record"
  | "reliability_record"
  | "creator_record"
  | "energy_efficiency_record"
  | "open_research_record"
  | "adoption_record"
  | "company_value_record";

export interface MilestoneProgress {
  id: MilestoneId;
  label: string;
  qualifyingQuarters: number;
  requiredQuarters: number;
  achievedDay: number | null;
  firstLabId: LabId | null;
}

export interface DecadeReport {
  generatedDay: number;
  score: number;
  researchImpact: number;
  capability: number;
  affordability: number;
  adoption: number;
  reliability: number;
  profit: number;
  trust: number;
  founderOwnership: number;
}

export interface ProgressionState {
  era: CampaignEra;
  milestones: MilestoneProgress[];
  decadeReport: DecadeReport | null;
  reportAcknowledged: boolean;
  runPhase: "campaign" | "endless" | "restructuring" | "failed";
}

/**
 * Compact three-way-merge baseline for fields already owned by canonical v4
 * LabState while legacy systems continue to mutate PlayerState/RivalLab.
 */
export type CanonicalLabField =
  | "capital"
  | "computeContracts"
  | "researchLeads"
  | "researchPods"
  | "researchPrograms"
  | "trainingPrograms"
  | "data";

export interface LabSyncState {
  version: 1;
  canonicalFingerprints: Record<
    LabId,
    Partial<Record<CanonicalLabField, string>>
  >;
}

/** Snapshot of new-game settings applied to this run. */
export interface RunConfig {
  labName: string;
  /** Geometric company mark selected when this sandbox was created. */
  companyMark?: import("./balance/gameConfig").CompanyMarkId;
  difficulty: "easy" | "normal" | "hard";
  mapWidth: number;
  mapHeight: number;
  cityCount: number;
  rivalCount: number;
  economyMult: number;
  researchCostMult: number;
  startingCashMult: number;
  landValueBase: number;
  landValueCityPeak: number;
  drivingSide: import("./balance/gameConfig").DrivingSide;
  campaignRules: CampaignRules;
}

export interface TransportSegmentLoad {
  segmentId: number;
  flow: number;
  capacity: number;
  utilization: number;
  travelTimeMult: number;
}

export interface TransportJunctionLoad {
  junctionId: number;
  queuePressure: number;
}

export interface TransportRuntimeState {
  version: 1;
  day: number;
  networkRevision: number;
  segmentLoads: TransportSegmentLoad[];
  junctionLoads: TransportJunctionLoad[];
  regionCongestion: Record<string, number>;
  cityAccess: Record<string, number>;
  facilityAccess: Record<string, number>;
}

export interface SimState {
  seed: number;
  day: number;
  tick: number;
  speed: Speed;
  paused: boolean;
  /** Canonical daily road demand/congestion; visual cars are never persisted. */
  transport: TransportRuntimeState;
  /** Applied new-game config */
  config: RunConfig;
  /** Immutable calibration snapshot pinned into this campaign and its save. */
  industryDataPack: IndustryDataPack;
  calendar: CalendarState;
  progression: ProgressionState;
  automation: AutomationPolicies;
  /** Canonical v4 lab index; compatibility player/rivals views are synchronized daily. */
  playerLabId: LabId;
  labs: Record<LabId, LabState>;
  /** Last agreed canonical/compatibility values used for lossless merging. */
  labSync?: LabSyncState;
  player: PlayerState;
  rivals: RivalLab[];
  worldMarkets: WorldMarkets;
  /** Active + pending compute leases with rivals */
  computeLeases: ComputeLease[];
  /** Cloud, colocation, emergency, and provider-neutral rival contracts. */
  computeContracts: ComputeContract[];
  /** Player public buy/sell listing for PF */
  computeListing: ComputeListing | null;
  /** Firm power offtake deals with metros */
  cityPowerContracts: CityPowerContract[];
  /** Fixed-term contracts selling owned surplus generation to metros. */
  powerExportContracts: PowerExportContract[];
  /** Lab-neutral physical campus projects and commissioned site shells. */
  siteProjects: SiteProject[];
  siteCapacities: SiteCapacity[];
  /** Optional for save compatibility; normalized lazily by the market system. */
  facilityMarket?: FacilityMarketState;
  /** Facility-local free-placement rooms. Absent in v10 and older saves. */
  dataHallLayouts?: Record<string, DataHallLayout>;
  /** Long-term utility and PPA commitments settled take-or-pay. */
  energyContracts: EnergyContract[];
  /** Authoritative finite interconnection ledger by map region. */
  regionInterconnections: RegionInterconnection[];
  /** Open data market listings (refreshes over days) */
  dataMarket: DataMarketState;
  segments: SegmentState[];
  map: {
    width: number;
    height: number;
    /**
     * Compact worlds are authoritative for large maps. Legacy row-major tiles
     * remain only for the existing small-map UI/tests while those consumers
     * migrate to the world query API.
     */
    storage?: "legacy" | "compact";
    world?: DynamicWorld;
    /** Changes whenever a compact-world batch commits (for external stores). */
    worldRevision?: number;
    tiles: MapTile[];
    regions: MapRegion[];
    energyPricePerMWh: number;
    activeRegionId: string;
    /** Procedural city anchors for UI / land value */
    cities?: MapCity[];
  };
  alerts: SimAlert[];
  news: string[];
  onboardingStep: number;
  onboardingDismissed: boolean;
  activeEvents: WorldEvent[];
  eventCooldowns: Record<string, number>;
  victory: VictoryState;
  lastMarket: {
    /** Persisted demand model revision for one-time save normalization. */
    demandModelVersion?: number;
    sharesByLab: Record<string, number>;
    demandMTok: number;
    playerDemandMTok: number;
    servedMTok: number;
    unservedRatio: number;
    latencyScore: number;
    /** Effective latency after capacity pain (what buyers felt) */
    effectiveLatencyScore: number;
    /** 0–1 overload pressure used for churn/latency */
    servicePain: number;
    planStats: PlanDayStats[];
    apiSubscribers: number;
    /** Pre-serve API demand MTok (price-sensitive) */
    apiDemandMTok?: number;
    apiDayMTok: number;
    apiDayRevenue: number;
    /** Direct token cost used for pricing and contribution margin. */
    apiDayDirectCogs: number;
    /** Serving overhead allocated for reporting, never a list-price floor. */
    apiDayAllocatedOps: number;
    apiDayCogs: number;
    /** Per-model API tokens and PF for simultaneous public endpoints. */
    apiModelUsage?: PlanModelUsage[];
    /** Inference capacity MTok/day at tick (mix-weighted equivalent) */
    capacityMTok: number;
    /** Inference PF demand from all API + sub traffic */
    demandPf: number;
    /** PF actually admitted and served after capacity/churn gates. */
    servedPf?: number;
    /** Inference PF available (serve allocation × fleet) */
    capacityPf: number;
    /** $/MTok fully loaded product cost */
    marginalPerMTok: number;
    modelFinance: ModelFinanceRow[];
    /** Industry-wide demand / served (all labs) */
    industryDemandMTok?: number;
    industryServedMTok?: number;
    /** Secular adoption multiplier vs day-1 segment bases (approx) */
    marketAdoption?: number;
    /** Player capacity priority (API share of inference) */
    apiVsSubPriority?: number;
    apiServeFrac?: number;
    subServeFrac?: number;
    apiPoolPf?: number;
    subPoolPf?: number;
    /** Dominant lab admission control: sales cannot grow past physical serving capacity. */
    capacitySalesCapped?: boolean;
    /** API demand rejected today because the inference pool was full. */
    blockedApiMTok?: number;
    /** Paid/free plan seats not admitted today because the inference pool was full. */
    blockedSubscriptionSeats?: number;
    /** Product revenue at the current saturated capacity and channel mix. */
    capacityProductRevenueCeiling?: number;
    /** Compute-v2 reconciliation record for the player lab. */
    computeLedger?: ComputeLedger;
  };
  /** Rolling finance/compute history for trends (newest last). */
  financeHistory: FinanceDaySnapshot[];
  /** Older daily finance compacted into calendar-month summaries. */
  financeMonthlyHistory: FinanceMonthSnapshot[];
  /** Present in all saves; standard mode leaves it cost- and incident-free. */
  externalities?: ExternalityState;
  /** Active post-release benchmark showdown (null when dismissed / none) */
  lastBenchmarkEvent: BenchmarkEvent | null;
  benchmarkSeasons: BenchmarkSeason[];
  evaluations: EvaluationRun[];
  reviews: ModelReview[];
}

export interface TickResult {
  state: SimState;
  events: string[];
}

/** One daily power→compute efficiency sample (raw PF per drawn MW). */
export interface PowerEfficiencySample {
  day: number;
  pfPerMw: number;
}

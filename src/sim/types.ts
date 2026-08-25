import type { DynamicWorld } from "./world/dynamicWorld";
import type { BalanceTuning } from "./balance/tuning";
import type { CityGrowthMetadata, CityPalette, CityTier } from "./world/types";

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
  "fp32" | "fp16" | "bf16" | "fp8" | "int8" | "int4" | "nvfp4" | "ternary_1_58";

/**
 * Weight precision a released checkpoint natively carries out of training.
 * Serving defaults to this precision; quantization research can override it.
 * FP32 remains a valid native and deployable precision for labs willing to
 * pay its 4-byte residency and TF32-rate serving cost.
 */
export type NativeWeightPrecision =
  "fp32" | "fp16" | "bf16" | "fp8" | "nvfp4" | "ternary_1_58";

export interface TrainingNumerics {
  computeFormat: TrainingComputeFormat;
  nativeWeightFormat: NativeWeightFormat;
  recipeVersion: number;
}

export type TrainingComputeSource = "local" | "cloud" | "mixed";

export interface TrainingComputePlan {
  source: TrainingComputeSource;
  reservedPf: number;
  computePriority: number;
  activationCheckpointing: boolean;
  targetDurationDays?: number;
}

/**
 * Immutable copy of every training decision at the moment a run begins.
 * Later research, hardware, data, or teacher changes must not rewrite it.
 */
export interface TrainingPlan {
  id: string;
  companyId: LabId;
  name: string;
  productPreset: ModelProductPreset;
  backbone: ModelBackbone;
  totalParamsB: number;
  activeParamsB?: number;
  trainingNumerics: TrainingNumerics;
  dataRecipe: TrainingDataPlan;
  computePlan: TrainingComputePlan;
  teacherModelId?: string;
  distillationShare: number;
  integratedResearchIds: string[];
  outcomeSeed: number;
  createdDay: number;
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

export type TrainingOutcomeKind =
  | "stumble"
  | "normal"
  | "breakthrough"
  | "failure";

export interface TrainingOutcome {
  kind: TrainingOutcomeKind;
  yieldMultiplier: number;
  capabilityDelta: number;
  reliabilityDelta: number;
  revealedDay: number;
  explanation: string;
}

/**
 * Explainable, seeded incidents and discoveries surfaced during a training run.
 * These are operational decisions, not opaque final capability rolls.
 */
export type TrainingCampaignEventKind =
  | "loss_spike"
  | "data_anomaly"
  | "mixture_discovery"
  | "hardware_fault"
  | "routing_imbalance"
  | "modality_interference"
  | "recursive_research";

export interface TrainingCampaignModifiers {
  /** Additive points applied after the normal capability calculation. */
  capabilityDelta: number;
  reliabilityDelta: number;
  safetyDelta: number;
  /** Additive probability mass for the terminal seeded outcome. */
  breakthroughBias: number;
  stumbleRisk: number;
  /** Effective data-quality adjustment captured by campaign interventions. */
  dataQualityDelta: number;
  /** Omni-only, independently verified lift to the current blueprint wall. */
  verifiedRecursiveCapabilityBonus: number;
}

export interface TrainingCampaignChoiceEffects {
  cashCost?: number;
  /** Fraction of the original recommended PF-days added to the run. */
  extraComputeFraction?: number;
  /** Fraction of current base-training progress rolled back to a checkpoint. */
  progressRollbackFraction?: number;
  capabilityDelta?: number;
  reliabilityDelta?: number;
  safetyDelta?: number;
  breakthroughBias?: number;
  stumbleRisk?: number;
  dataQualityDelta?: number;
  verifiedRecursiveCapabilityBonus?: number;
  minResearchers?: number;
}

export interface TrainingCampaignChoice {
  id: string;
  label: string;
  description: string;
  /** AFK / duty-scientist recipe. Never shown as a live "recommended" badge. */
  recommended?: boolean;
  /** True when the player authored or retuned the recipe via the mixer. */
  playerAuthored?: boolean;
  effects: TrainingCampaignChoiceEffects;
}

export interface TrainingCampaignEvent {
  id: string;
  kind: TrainingCampaignEventKind;
  title: string;
  description: string;
  signal: string;
  /** Accuracy of completed checkpoint evidence available when this decision surfaced. */
  evidenceAccuracy?: number;
  day: number;
  milestone: number;
  decisionDeadlineDay: number;
  severity: "opportunity" | "warning" | "critical";
  choices: TrainingCampaignChoice[];
  selectedChoiceId?: string;
  resolvedDay?: number;
  autoResolved?: boolean;
}

export type Modality = "text" | "image" | "video" | "audio" | "tools";

export type PostTrainStage = "none" | "sft" | "rlhf" | "process" | "tools";

/** Product lifecycle after foundation pretrain. */
export type ModelLifecycle =
  | "foundation"
  | "specialized"
  | "aligned"
  | "reasoning";

export type FocusAxis =
  | "coding"
  | "science"
  | "research"
  | "personality"
  | "chat";

export interface SpecializationFocus {
  coding: number;
  science: number;
  research: number;
  personality: number;
  chat: number;
}

/** @deprecated Use EffortRecipe.id. Kept for save migration. */
export type ReasoningEffort = "low" | "medium" | "high";

export type EffortKind = "instant" | "trained";

/** @deprecated Use EffortRecipe. Kept for save migration. */
export interface ReasoningEffortPolicy {
  level: ReasoningEffort;
  trained: boolean;
  quality: number;
  outputTokenMult: number;
  hardTaskLift: number;
}

export interface EffortRecipe {
  id: string;
  name: string;
  kind: EffortKind;
  /** Serve-time thinking budget. Instant is 1. */
  thinkingTokenMult: number;
  trainPfDays: number;
  trainCash: number;
  trained: boolean;
  /** 0–1: how much of the thinking budget is useful work. */
  quality: number;
  served: boolean;
  /**
   * 0 = efficiency (cheaper tokens, less cap), 1 = capability (much costlier
   * tokens, more cap). Instant ignores this for serve cost.
   */
  capabilityBias?: number;
  /** Slice of the active job's Train PF allocated to this head (0–0.45). */
  trainComputeShare?: number;
  /** PF received by this head across continue/finetune passes. */
  progressPfDays?: number;
  /** PF target for the current training pass. */
  targetPfDays?: number;
  /** Live observed loss while this head is receiving compute. */
  loss?: number;
}

export interface EffortBoard {
  id: string;
  name: string;
  trained: boolean;
  served: boolean;
  capability: number;
  tokenMult: number;
  usdPerMTok: number | null;
  math: number;
  coding: number;
  science: number;
  agents: number;
}

export interface EffortTrainProgress {
  recipeId: string;
  name: string;
  thinkingTokenMult: number;
  progressPfDays: number;
  targetPfDays: number;
  cashSunk: number;
  loss?: number;
  capabilityBias?: number;
  trainComputeShare?: number;
}

export interface ModelProductProfile {
  lifecycle: ModelLifecycle;
  focus: SpecializationFocus;
  personality: number;
  tokenEfficiency: number;
  effortRecipes: EffortRecipe[];
  defaultEffortId: string;
  /** @deprecated Migrated into effortRecipes. */
  effortPolicies?: ReasoningEffortPolicy[];
  /** @deprecated Migrated into defaultEffortId. */
  defaultEffort?: ReasoningEffort;
  /** @deprecated Migrated into effortRecipes[].served. */
  servedEfforts?: ReasoningEffort[];
}

/** Player-funded post-training gyms that grade SFT / RLHF / process / tools. */
export type PostTrainGymKind =
  | "code"
  | "cyber"
  | "math"
  | "research"
  | "chat";

export interface PostTrainGym {
  readonly id: string;
  readonly kind: PostTrainGymKind;
  name: string;
  investedCash: number;
  /** Compute rented as cash (cluster-time), not live PF. */
  investedComputeCash: number;
  quality: number;
  /** Completed facility tier: 0 locked shell, 1 foundry, 2 cluster, 3 campus. */
  tier?: number;
  /** Upgrade currently being built. Cash is charged once when this is set. */
  activePackageId?: string | null;
  /** Live research PF-days completed toward activePackageId. */
  progressPfDays?: number;
  targetPfDays?: number;
  /** Fraction of the shared research pool reserved for this gym (0-0.75). */
  researchShare?: number;
  /** Real HQ researchers reserved for this gym and unavailable to pods. */
  assignedResearchers?: number;
  /** Recurring operation / experiment burn while the gym is staffed. */
  operatingCostPerDay?: number;
}

export type ToolSkillId = "json" | "grep" | "python" | "shell" | "web";

export interface ToolSkill {
  id: ToolSkillId;
  proficiency: number;
  investedCash: number;
  investedComputeCash?: number;
}

export type ModelRouterLane =
  | "default"
  | "chat"
  | "code"
  | "math"
  | "science"
  /** @deprecated Remapped to chat. */
  | "fast"
  /** @deprecated Remapped to default. */
  | "frontier";

export interface ModelRouter {
  id: string;
  name: string;
  lanes: Partial<Record<ModelRouterLane, string>>;
}

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
  /** First-seen baseline used as the campaign expansion origin when absent. */
  launchBaselinePf?: number;
  /** Day-scaled expansion ceiling; raised each tick, never a permanent 1.5× lock. */
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
  "pending" | "countered" | "accepted" | "rejected" | "withdrawn" | "expired";

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
  | "safety"
  | "personality";

export type BenchmarkScores = Record<BenchmarkId, number>;
export type DomainHeat = Partial<Record<BenchmarkId, number>>;

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

/** Player-selected private evaluation suites for an in-flight checkpoint. */
export interface TrainingBenchmarkRequest {
  suiteIds: BenchmarkSuiteId[];
  /** Uniform spend for every selected suite. Each suite validates its own bounds. */
  spendPerSuite: number;
}

/** A suite-level noisy estimate produced by a paid checkpoint evaluation. */
export interface TrainingBenchmarkSuiteResult {
  suiteId: BenchmarkSuiteId;
  spend: number;
  score: number;
  /** Estimated measurement accuracy (0-1), not the model's task score. */
  accuracy: number;
  /** Nominal confidence in the reported interval (0-1). */
  confidence: number;
  /** Proportional half-width of the interval around score. */
  inaccuracy: number;
  low: number;
  high: number;
}

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
export type DataHallShellId =
  | "hall-small-v1"
  | "hall-medium-v1"
  | "hall-large-v1"
  /** Pre-density-rebalance shells retained only for safe legacy save migration. */
  | "hall-small-v1-legacy"
  | "hall-medium-v1-legacy"
  | "hall-large-v1-legacy";
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
  /** Equipment undergoing repair is unavailable to utility routing until this reaches zero. */
  repairDaysRemaining?: number;
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
  /** Share of placed equipment/racks reachable from the exterior service entrance. */
  accessScore: number;
  /** Serviceability after access, aisle clearance, and repair state are considered. */
  maintenanceScore: number;
  /** Approximate N+1/path diversity score across all three required utilities. */
  redundancyScore: number;
  powerUtilization: number;
  coolingUtilization: number;
  networkUtilization: number;
  powerHeadroomMw: number;
  coolingHeadroomMw: number;
  networkHeadroomGbps: number;
  throughputMultiplier: number;
  pueMultiplier: number;
  incidentRiskMultiplier: number;
  powerRoutes: Array<{
    rackUnitId: string;
    equipmentId: string;
    cells: number[];
  }>;
  coolingRoutes: Array<{
    rackUnitId: string;
    equipmentId: string;
    cells: number[];
  }>;
  networkRoutes: Array<{
    rackUnitId: string;
    equipmentId: string;
    cells: number[];
  }>;
  serviceRoutes: Array<{ objectId: string; cells: number[] }>;
  inaccessibleObjectIds: string[];
  redundantRackUnitIds: string[];
  bottlenecks: Array<{
    kind:
      "power" | "cooling" | "network" | "access" | "airflow" | "maintenance";
    severity: "warning" | "critical";
    message: string;
    utilization?: number;
    objectId?: string;
  }>;
}

export type HallConstructionStage = "build" | "cabling" | "commissioning";

export interface DataHallConstructionProject {
  id: string;
  startedDay: number;
  totalDays: number;
  remainingDays: number;
  stage: HallConstructionStage;
  stageDays: { build: number; cabling: number; commissioning: number };
  targetRevision: number;
  targetObjects: DataHallObjectPlacement[];
  targetWalls: DataHallWallSegment[];
  targetDoors: DataHallDoorPlacement[];
  targetPreferredStrategy: HallAutoLayoutStrategy;
  infrastructureCost: number;
  rackPurchaseCost: number;
  totalCost: number;
}

export interface DataHallLayout {
  version: 2;
  facilityId: string;
  shellId: DataHallShellId;
  revision: number;
  autoPlaceDeliveries: boolean;
  /** Rival fit-out planning retry; avoids recomputing an unchanged blocked topology every day. */
  autoPlaceRetryDay?: number;
  preferredStrategy: HallAutoLayoutStrategy;
  objects: DataHallObjectPlacement[];
  walls: DataHallWallSegment[];
  doors: DataHallDoorPlacement[];
  analysis: DataHallLayoutAnalysis;
  constructionProject?: DataHallConstructionProject;
}

/**
 * Small, saveable office-fitout model for headquarters.  HQ furniture is
 * deliberately separate from data-hall equipment: it affects people
 * capacity and operating productivity, never compute or utility routing.
 */
export type HqOfficeObjectKind =
  "desk" | "plant" | "copier" | "meeting_room" | "whiteboard";

export interface HqOfficeObjectPlacement {
  id: string;
  kind: HqOfficeObjectKind;
  catalogId: string;
  x: number;
  z: number;
  rotation: HallRotation;
  purchasePrice: number;
}

export interface HqOfficeLayoutAnalysis {
  revision: number;
  valid: boolean;
  hardErrors: string[];
  warnings: string[];
  capacityBonus: number;
  productivityBonus: number;
  dailyOpex: number;
  objectCount: number;
}

export interface HqOfficeLayout {
  version: 1;
  facilityId: string;
  /** Grid dimensions are derived from HQ kind at creation and persisted so
   * legacy facilities retain their original fit-out after a balance change. */
  width: number;
  depth: number;
  revision: number;
  objects: HqOfficeObjectPlacement[];
  analysis: HqOfficeLayoutAnalysis;
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
  /**
   * Raises the hard cap on overtrain / compute-intensity capability points
   * (added to the early-game 1.5 base, clamped at 8 total).
   */
  overtrainCapBonus?: number;
  /** Unlocks omni-only closed-loop research campaigns; grants no passive gain. */
  unlockClosedLoopResearch?: boolean;
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
  /** Allocation-weighted within-asset diversity (0-1). Optional for legacy saves. */
  effectiveDiversity?: number;
  /** Allocation-weighted corpus freshness (0-1). Optional for legacy saves. */
  effectiveFreshness?: number;
  contaminationRisk: number;
  /** Share of attributed tokens generated by another model (0-1). */
  syntheticShare?: number;
  /** Synthetic-token-weighted recursion depth; zero when no synthetic data is used. */
  syntheticGenerationDepth?: number;
  /** Human-origin tokens plus the human-anchored share of synthetic tokens (0-1). */
  humanAnchorShare?: number;
  /** Allocation-weighted licensing/commercialization exposure (0-1). */
  rightsRisk?: number;
  /** Combined learnable value of one unique token after corpus-level penalties (0-1). */
  effectiveTrainingValue?: number;
  createdDay: number;
}

/** Compact immutable corpus evidence copied onto a training job at launch. */
export interface TrainingDataEvidence {
  effectiveQuality: number;
  effectiveDiversity: number;
  effectiveFreshness: number;
  contaminationRisk: number;
  syntheticShare: number;
  syntheticGenerationDepth: number;
  humanAnchorShare: number;
  rightsRisk: number;
  effectiveTrainingValue: number;
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
  /**
   * Provenance of a purchased raw market lot. When present, accepted tokens are
   * attributed to bought stock and recorded under the seller lineage asset.
   */
  purchaseLot?: {
    lineageId: string;
    name: string;
    sellerKind: string;
    sellerName?: string;
    qualityBand: DataQualityBand;
    offerSource: "web" | "scrap" | "licensed";
    /** Listed quality of the raw lot before cleaning. */
    purchaseQuality: number;
  };
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
  /** Data-engineer slots required while this audit is active. */
  engineersRequired?: number;
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
  /**
   * Teacher routing for automatic generation, keyed by target corpus. Missing
   * entries mean Auto. Invalid/deleted teachers also fall back to Auto without
   * rewriting the historical synthetic assets they produced.
   */
  teacherModelIds?: Partial<Record<DataDomain, string>>;
  /** Cumulative useful output split by generated quality. */
  hqMTok?: number;
  lqMTok?: number;
  /** Cumulative generated output rejected by the automatic verifier. */
  wastedMTok?: number;
  /**
   * Targeted jobs: how hard the output is filtered (0–1). Higher filtering
   * raises per-token quality but rejects more candidates (slower throughput).
   */
  filterIntensity?: number;
  /** Targeted jobs: total research PF-days this job may consume before stopping. */
  computeBudgetPfDays?: number;
  /** Research PF-days consumed so far (checked against computeBudgetPfDays). */
  pfDaysSpent?: number;
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
  /** Chat MTok collected today from free-plan served traffic. */
  dayCollectChatFree?: number;
  /** Chat MTok collected today from paid-plan served traffic (≤ $50 tiers). */
  dayCollectChatPaid?: number;
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
  /** Instruction mix reserved for alignment after the base run. */
  postTrainWeights?: Partial<Record<DataDomain, number>>;
  /** Extra MTok consumed when post-training starts. */
  postTrainMTok?: number;
  /** Share of the funded token budget reserved for post-train (0–1). */
  postTrainShare?: number;
}

export interface Model {
  id: string;
  /** Stable identifier shared by every checkpoint/version descended from one base model. */
  lineageId?: string;
  /** Immediate source checkpoint for a continued-training version. */
  parentModelId?: string;
  /** Stealth candidate that produced this retained checkpoint, when applicable. */
  checkpointCandidateId?: string;
  /** Training campaign that produced this checkpoint. */
  sourceTrainingJobId?: string;
  /** Base-training progress captured into this immutable checkpoint (0-1). */
  checkpointProgress?: number;
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
  /** Verified omni-only closed-loop gains banked on this immutable version. */
  verifiedRecursiveCapabilityBonus?: number;
  /** Authoritative domain vector for v4 models; legacy models derive it on read. */
  capabilities?: ModelCapabilities;
  /** Grouped product axes: lifecycle, personality, effort, token efficiency. */
  productProfile?: ModelProductProfile;
  modalities: Modality[];
  quality: QualityAxes;
  benchmarks: BenchmarkScores;
  /** Modality-aware evaluations; benchmarks remains the language compatibility view. */
  benchmarkSuites?: BenchmarkSuiteScores;
  evaluationProfile?: EvaluationProfile;
  reasoningEnabled?: boolean;
  revision?: number;
  /** Semantic display revision, e.g. `0.3`, stable across save/load. */
  versionLabel?: string;
  safetyTraining?: SafetyTrainingRecord;
  postTrain: PostTrainStage;
  /** Post-training stage kinds completed by this checkpoint or its ancestors. */
  completedPostTrainStages?: Exclude<PostTrainStage, "none">[];
  /** Effectiveness earned by each completed stage (0-1), preserved across continuation. */
  postTrainStageEffectiveness?: Partial<
    Record<Exclude<PostTrainStage, "none">, number>
  >;
  /** Number of completed passes per stage; repeat passes have diminishing returns. */
  postTrainStageRuns?: Partial<Record<Exclude<PostTrainStage, "none">, number>>;
  /** Immutable training curve retained after the source job is finalized. */
  trainingLossHistory?: NonNullable<TrainingJob["lossHistory"]>;
  /** Private checkpoint evaluations retained for later release comparison UI. */
  trainingBenchmarkSnapshots?: TrainingBenchmarkSnapshot[];
  /** Blind-panel reports produced while this exact checkpoint was in stealth. */
  checkpointEvaluations?: import("./balance/checkpointEvaluation").CheckpointEvaluationReport[];
  trainComputeSpent: number;
  /** Lifetime revenue/cost attribution for this model. */
  economics?: ModelEconomics;
  releaseDay: number;
  /** @deprecated use release === 'released' */
  shipped: boolean;
  release: ModelRelease;
  /**
   * Off the live serving fleet without deleting weights.
   * Train / distill remain available; restore returns it to public serving.
   */
  archived?: boolean;
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
  /** Native media list prices; absent models derive conservative defaults. */
  apiPricePerImage?: number | null;
  apiPricePerAudioMinute?: number | null;
  apiPricePerVideoSecond?: number | null;
  /** Suggested blended list price at default markup */
  suggestedApiPrice: number;
  suggestedApiPriceIn: number;
  suggestedApiPriceOut: number;
  /** Hosting-cost floor ($/MTok in) from campus ops, size, and token mix. */
  costApiPriceIn: number;
  /** Hosting-cost floor ($/MTok out); decode is more expensive than prefill. */
  costApiPriceOut: number;
  /**
   * Released models are public on evals. Demand only hits them when this is
   * true (API listed and/or attached to a plan).
   */
  commerciallyOffered?: boolean;
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
  /**
   * Native weight precision carried by this checkpoint. Default serving reads
   * it for weight bytes, HBM/host RAM, inference work and endpoint precision;
   * absent on legacy models (treated as fp16 by readers).
   */
  nativeWeightPrecision?: NativeWeightPrecision;
  /** Evaluated deployable artifacts derived from this checkpoint. */
  deploymentArtifacts?: DeploymentArtifact[];
  /** Version of the physical training-work formula used by this model. */
  trainingFormulaVersion?: 1 | 2;
  /**
   * Bounded daily capability drag from leaving contaminated corpus in flight.
   * This is operational state, not a rewrite of the immutable training
   * evidence captured by the checkpoint.
   */
  corpusDriftTotal?: number;
  corpusDriftLastDay?: number;
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
  /** Authoritative catalog-scaled PF-days completed by this program. */
  progressPfDays?: number;
  /** Funded active calendar days; stalled days do not satisfy the floor. */
  daysSpent?: number;
  /** Completion bookkeeping used to guarantee stored lab effects apply once. */
  effectsApplied?: boolean;
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

export type TrainingCheckpointStatus = "stealth" | "promoted" | "discarded";

export type TrainingCheckpointKind = "milestone" | "manual";

export type TrainingCheckpointBranchDirection =
  | "general"
  | "chat"
  | "code"
  | "cyber"
  | "agents"
  | "reasoning"
  | "safety"
  | "custom";

/** Immutable telemetry frozen when an in-flight campaign writes a checkpoint. */
export interface TrainingCheckpointTelemetry {
  progressPfDays: number;
  targetPfDays: number;
  progress: number;
  daysElapsed: number;
  stage: "base" | Exclude<PostTrainStage, "none">;
  stageProgress: number;
  loss: number | null;
  energyMWh: number;
  trainingNumerics?: TrainingNumerics;
}

/**
 * A private weight snapshot. Until promoted, `model` deliberately lives
 * outside `player.models`, so ordinary serving, teachers, continuation,
 * revenue, market-share and public-release systems cannot discover it.
 */
export interface TrainingCheckpointCandidate {
  id: string;
  sourceJobId: string;
  lineageId: string;
  sourceModelId?: string;
  /** Final model version produced by sourceJobId; canonical archive owner. */
  ownerModelId?: string;
  /**
   * The fleet entry for these exact weights was explicitly deleted. The
   * producing run/final base version may no longer keep this archive alive;
   * only re-retained exact weights or a concrete child branch may do so.
   */
  sourceOwnershipRevoked?: boolean;
  ordinal: number;
  /** How this snapshot entered the private checkpoint archive. */
  kind?: TrainingCheckpointKind;
  /** Optional player-facing release/branch label. */
  customLabel?: string;
  /** Product direction inherited by branches created from this snapshot. */
  branchDirection?: TrainingCheckpointBranchDirection;
  /** Immediate private checkpoint ancestor, when this is a branch. */
  parentCheckpointId?: string;
  /** Base-training milestone that earned this checkpoint (0-1). */
  milestone: number;
  capturedDay: number;
  stage: "base" | Exclude<PostTrainStage, "none">;
  status: TrainingCheckpointStatus;
  model: Model;
  telemetry: TrainingCheckpointTelemetry;
  /** Completed private benchmark/reviewer reports for this exact weight snapshot. */
  evaluations?: import("./balance/checkpointEvaluation").CheckpointEvaluationReport[];
  /** Evaluation currently in flight; the scheduler owns its cash and timing. */
  pendingEvaluation?: import("./balance/checkpointEvaluation").PendingCheckpointEvaluation;
  promotedModelId?: string;
  promotedDay?: number;
  discardedDay?: number;
}

/** Persisted payload for one paid mid-training benchmark run. */
export interface TrainingBenchmarkPending {
  id: string;
  startedDay: number;
  readyDay: number;
  /** Progress fraction (0-1) captured when the benchmark was scheduled. */
  progress: number;
  stage: "base" | Exclude<PostTrainStage, "none">;
  /** Paid, product-eligible suites captured at scheduling time. */
  suiteIds?: BenchmarkSuiteId[];
  /** Uniform spend applied to every selected suite. */
  spendPerSuite?: number;
  /** Cash deducted once when the run was scheduled. */
  totalCost?: number;
  /** Expected measurement accuracy at the selected spend (0-1). */
  accuracy?: number;
  /** Nominal interval confidence at the selected spend (0-1). */
  confidence?: number;
  /** Loss frozen with the evaluated weights; later training cannot rewrite it. */
  capturedLoss?: number;
}

/**
 * Unified, concurrent private-evaluation scheduler. Legacy subject-level pending
 * fields remain mirrors only and are migrated into this queue on load.
 */
export type PrivateEvaluationJob =
  | {
      id: string;
      kind: "training_benchmark";
      subjectId: string;
      scheduledDay: number;
      readyDay: number;
      pending: TrainingBenchmarkPending;
    }
  | {
      id: string;
      kind: "checkpoint_evaluation";
      subjectId: string;
      scheduledDay: number;
      readyDay: number;
      pending: import("./balance/checkpointEvaluation").PendingCheckpointEvaluation;
    }
  | {
      id: string;
      kind: "released_model_evaluation";
      subjectId: string;
      scheduledDay: number;
      readyDay: number;
      pending: import("./balance/checkpointEvaluation").PendingCheckpointEvaluation;
    };

export interface PostTrainRiskPlan {
  stage: Exclude<PostTrainStage, "none">;
  /** Frozen probability used for this attempt; later research cannot rewrite it. */
  probability: number;
  band: "low" | "guarded" | "high" | "critical";
  willFail: boolean;
  /** Hidden deterministic crossing in stage progress (0-1). */
  atFraction: number;
  /** Checkpoint progress already survived when this attempt began. */
  startFraction?: number;
  factors: string[];
  createdDay: number;
  seedVersion: 2;
}

export type TrainingFailureKind =
  | "numerical_divergence"
  | "supervision_collapse"
  | "preference_collapse"
  | "reward_model_collapse"
  | "tool_policy_collapse";

/** Persisted evidence for a destructive training failure and its recovery path. */
export interface TrainingFailureRecord {
  kind: TrainingFailureKind;
  stage: "base" | Exclude<PostTrainStage, "none">;
  day: number;
  /** Exact base-training PF position at the point of failure. */
  progressPfDays: number;
  /** Exact progress through the failed stage (0-1). */
  stageProgress: number;
  probability: number;
  riskBand: "low" | "guarded" | "high" | "critical";
  factors: string[];
  /** Only this immutable pre-failure snapshot is eligible for one-click recovery. */
  recoveryCheckpointId?: string;
}

export interface TrainingJob {
  id: string;
  name: string;
  /** Frozen copy of the start-time specification; never reconstructed from live state. */
  plan?: TrainingPlan;
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
  /** Live ETA from remaining PF divided by useful current effective PF. */
  daysRemaining?: number;
  /**
   * Minimum active base-training days. For trillion-scale jobs this paces useful
   * PF progress; it is not a separate release gate and paused days do not count.
   */
  minCalendarDays?: number;
  /** Active-day telemetry retained for charts and legacy saves. */
  daysElapsed?: number;
  postTrain: PostTrainStage;
  postTrainProgress: number;
  postTrainTarget: number;
  /** Stage kinds inherited from the source or completed in this version. */
  completedPostTrainStages?: Exclude<PostTrainStage, "none">[];
  /** Frozen result for completed stages so later research cannot rewrite history. */
  postTrainStageEffectiveness?: Partial<
    Record<Exclude<PostTrainStage, "none">, number>
  >;
  /** Completed stage-pass count inherited from the source plus this run. */
  postTrainStageRuns?: Partial<Record<Exclude<PostTrainStage, "none">, number>>;
  /** Stages already completed in this particular job (each may run once per version). */
  postTrainStagesCompletedThisRun?: Exclude<PostTrainStage, "none">[];
  /** Active-day telemetry for the current post-training stage. */
  postTrainDaysElapsed?: number;
  /** Frozen deterministic risk plan for the current post-training attempt. */
  postTrainRiskPlan?: PostTrainRiskPlan;
  /** Number of checkpoint-backed retries in this recovery lineage. */
  postTrainRecoveryAttempt?: number;
  /** Failed source run that this recovery branch replaces. */
  recoveredFromJobId?: string;
  /** Immutable source weights used for a recovery branch. */
  recoveryCheckpointId?: string;
  /** Child recovery job launched from this failed source, preventing rerolls. */
  recoveryChildJobId?: string;
  mode: TrainMode;
  teacherId?: string;
  /**
   * Distill only: fraction of training signal from the teacher (0–1).
   * Rest comes from your processed corpus. High teacher ≈ ~80% retention.
   */
  distillTeacherShare?: number;
  /** Continue-train from existing model weights */
  continueFromId?: string;
  /** Frozen lineage identity used to prevent concurrent continuation branches. */
  continueLineageId?: string;
  /** Frozen lineage for every checkpoint and final version produced by this run. */
  lineageId?: string;
  /** Private checkpoint used to start this branch, if any. */
  parentCheckpointId?: string;
  /** Product direction selected when this continuation branch was created. */
  branchDirection?: TrainingCheckpointBranchDirection;
  /** Foundation / specialized / aligned / reasoning. Pretrain starts as foundation. */
  lifecycle?: ModelLifecycle;
  /** Player-authored specialize sliders for this run. */
  specializationFocus?: SpecializationFocus;
  productProfile?: ModelProductProfile;
  /** In-flight named effort head (not Instant). */
  effortTrain?: EffortTrainProgress;
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
  /** Campaign milestones already surfaced for this run (fractions in 0–1). */
  campaignMilestonesReached?: number[];
  /** Current explainable incident/discovery awaiting a player decision. */
  pendingCampaignEvent?: TrainingCampaignEvent;
  /** @deprecated Alignment now starts from the recipe; kept for old saves. */
  pendingPostTrainPhase?: boolean;
  /** Alignment mix/gyms have been applied after the base run. */
  postTrainPhaseResolved?: boolean;
  /** Bounded resolved event history retained for the release review. */
  campaignEventHistory?: TrainingCampaignEvent[];
  /** Accumulated effects of player campaign decisions. */
  campaignModifiers?: TrainingCampaignModifiers;
  effectiveDataRatio?: number;
  repeatedDataEpochs?: number;
  modalityComputeMult?: number;
  /** Immutable v4 data snapshot captured before the run starts. */
  dataManifestId?: string;
  /** Immutable compact evidence for campaign weighting and live presentation. */
  dataEvidence?: TrainingDataEvidence;
  /** Integrated-method snapshot; later disclosure changes cannot rewrite this run. */
  integratedMethods?: string[];
  /** Player-selected model-specific research integrations. */
  modelStack?: string[];
  /**
   * Domain labs attached to this run. Research must unlock the lab kind;
   * funded gym quality then lifts that domain while the model trains.
   */
  attachedGymKinds?: PostTrainGymKind[];
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
  /** Structured failure evidence for run-card diagnostics and save-stable recovery. */
  failureRecord?: TrainingFailureRecord;
  /** Eligible immutable checkpoint selected when the failure occurred. */
  failureRecoveryCheckpointId?: string;
  /** Persisted, bounded telemetry used by the training loss chart. */
  lossHistory?: Array<{
    day: number;
    stage: "base" | Exclude<PostTrainStage, "none">;
    progress: number;
    loss: number;
  }>;
  /** Fixed recommended PF-day target captured at job creation. */
  recommendedPfDays?: number;
  /** @deprecated Calendar extensions no longer alter fixed PF targets. */
  extensionDays?: number;
  /** @deprecated Recommendation decisions no longer pause training. */
  awaitingDecision?: boolean;
  /** Split training cost accounting for UI / P&L. */
  economics?: TrainingEconomics;
  /** Mid-run benchmark snapshots; progress-scaled and non-terminal. */
  benchmarkSnapshots?: TrainingBenchmarkSnapshot[];
  /** Day of the last mid-run benchmark attempt. */
  lastBenchmarkDay?: number;
  /** Monotonic identity source for concurrent benchmark work. */
  benchmarkSequence?: number;
  /** Benchmark currently running; resolves into a snapshot at readyDay. */
  pendingBenchmark?: TrainingBenchmarkPending;
  /** @deprecated Fixed PF targets do not auto-extend. */
  autoExtend?: boolean;
  /** @deprecated Post-training stages never auto-chain. */
  autoChainPostTrain?: boolean;
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
  /** Paid evaluation metadata; absent on legacy snapshots. */
  suiteIds?: BenchmarkSuiteId[];
  spendPerSuite?: number;
  totalCost?: number;
  /** Aggregate measurement accuracy across selected suites (0-1). */
  accuracy?: number;
  /** Suite-specific score and uncertainty table. */
  suiteResults?: Partial<
    Record<BenchmarkSuiteId, TrainingBenchmarkSuiteResult>
  >;
  /** Capability at each trained reasoning effort. */
  effortCapabilities?: Partial<Record<string, number>>;
  effortBoards?: EffortBoard[];
}

export interface ModelEconomics {
  lifetimeApiRevenue: number;
  lifetimeSubRevenue: number;
  lifetimeEnterpriseRevenue: number;
  lifetimeServingCost: number;
  /** Commercial contribution after the model's own training bill. */
  lifetimeNet: number;
  trainingInitialCost: number;
  trainingDataCost: number;
  trainingDailyCost: number;
  /** First day cumulative commercial contribution repaid attributable training. */
  paybackDay?: number;
}

/**
 * Negotiable supplier contract terms. `dailyPrice` on the contract equals
 * `dailyDeliveryMTok × pricePerMTok` for the locked term.
 */
export interface DataSupplierTerms {
  /** MTok delivered each day, split across domainMix. */
  dailyDeliveryMTok: number;
  /** $ per MTok. */
  pricePerMTok: number;
  /** Minimum delivered quality the seller guarantees. */
  qualityFloor: number;
  /** Contract length in days. */
  termDays: number;
  /** Requested delivery mix (seller may adjust toward its own mix). */
  domainMix: Partial<Record<DataDomain, number>>;
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
  /**
   * Lifecycle: offered → countered → accepted → active → expired, with
   * countered → rejected, active → cancelled, and active → extended exits.
   * "completed" is the legacy terminal state of pre-negotiation saves.
   */
  status:
    | "offered"
    | "countered"
    | "accepted"
    | "active"
    | "completed"
    | "expired"
    | "rejected"
    | "cancelled"
    | "extended";
  /** Terms the buyer most recently put on the table (status offered/countered). */
  proposedTerms?: DataSupplierTerms;
  /** Terms the seller most recently countered with (status countered). */
  counterTerms?: DataSupplierTerms;
  /** Guaranteed quality floor locked at signing. */
  qualityFloor?: number;
  /** Day the buyer submitted the standing offer. */
  offeredDay?: number;
  /** Total MTok delivered so far; extensions never reset this. */
  deliveredMTok?: number;
  /** Cancellation fee already charged (the fee is charged exactly once). */
  cancellationFeeCharged?: number;
  /** Days added by accepted extensions. */
  extendedDays?: number;
  /** Number of accepted extensions. */
  extensionCount?: number;
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
  /** Private checkpoint source for an explicit branch continuation. */
  continueFromCheckpointId?: string;
  /** Branch direction used to bias the continuation recipe. */
  branchDirection?: TrainingCheckpointBranchDirection;
  lifecycle?: ModelLifecycle;
  specializationFocus?: SpecializationFocus;
  /** @deprecated prefer dataPlan */
  dataMix?: DataMix;
  /** Domain mix + volume of processed data to use */
  dataPlan?: TrainingDataPlan;
  /** Research-backed runtime and architecture modules to integrate. */
  modelStack?: string[];
  /** Domain labs to attach for this run (research-gated). */
  attachedGymKinds?: PostTrainGymKind[];
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

/** Plan-local enablement and quantization for one thinking head. */
export interface PlanEffortPolicy {
  enabled: boolean;
  /** Serving format for this head. Missing uses the model's plan precision. */
  precision?: PlanServePrecision;
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
   * Legacy advertised API-equivalent value. It is retained for save/UI
   * compatibility but never determines physical entitlement: changing an API
   * list price must not silently change subscription usage.
   */
  monthlyApiValueSubsidyGbp?: number;
  /**
   * Legacy save/display field. V3 utilization is always endogenous from plan
   * value, model quality, and service health; player input is ignored.
   */
  usageRate: number | null;
  /** Models a subscriber on this plan may use */
  modelIds: string[];
  /**
   * Serving routers this plan exposes as a mix. Optional on old saves.
   * Members do not need to be listed again in `modelIds`.
   */
  routerIds?: string[];
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
  /**
   * Per-model thinking heads this plan exposes. Missing model/effort entries
   * inherit globally served recipes at {@link servePrecisionByModel}.
   * Instant stays available when every explicit head is turned off.
   */
  effortPolicyByModel?: Record<string, Record<string, PlanEffortPolicy>>;
  /** Compute-v2 primary/fallback routing by native product modality. */
  modalityRoutes?: Partial<Record<ModelIOModality, PlanModalityRoute>>;
  /** Persistent novelty/trust shocks; deterministic decay is evaluated by day. */
  demandShocks?: PlanDemandShock[];
  /** Stable fraction of allowance consumed after launch effects decay. */
  steadyUsageTarget?: number;
  /**
   * Desired share of this plan's served traffic retained as training data (0–1).
   * Paid tiers are hard-capped by price (0 above $50/mo); see plan data-collection policy.
   */
  dataCollectionRate?: number;
  enabled: boolean;
  subscriberCap?: number;
  /**
   * When false, stop new enrollment and grandfather current subscribers.
   * Only meaningful while {@link ProductPricing.subsAcceptingNew} is on.
   * Default true (missing on older saves).
   */
  acceptingNew?: boolean;
}

export interface PlanDayStats {
  planId: string;
  name: string;
  /** Shaped demand after pricing, migration, and stickiness, before enrollment cap. */
  demandSubscribers?: number;
  /** Configured enrollment cap (0/open is represented as undefined). */
  configuredSubscriberCap?: number;
  /** Seats retained above a newly lowered cap under grandfathering. */
  grandfatheredSubscribers?: number;
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
  /** 0–1 dissatisfaction from throttled stream speed under overload. */
  slownessDissatisfaction?: number;
  /** Band-based expected allowance utilization used for today's demand. */
  expectedUtilization?: number;
  /** price − raw serving COGS − support/payment overhead, per subscriber month. */
  contributionMarginPerSubMonth?: number;
  /** Advertised monthly API-value subsidy for this plan (£/mo). */
  apiValueSubsidyGbp?: number;
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

/** One day's per-plan demand snapshot for UI trend graphs (newest last). */
export interface PlanStatsDaySnapshot {
  day: number;
  plans: {
    planId: string;
    name: string;
    pricePerMonth: number;
    demandSubscribers?: number;
    configuredSubscriberCap?: number;
    subscribers: number;
    dayRevenue: number;
    dayMTok: number;
  }[];
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
  /**
   * Legacy overload selector retained for save migration. New UI and market
   * settlement use serveSlowdownLimit + peakPricingPct instead.
   */
  serveThrottlePolicy?: ServeThrottlePolicy;
  /**
   * Fraction of the inference pool that may be consumed by slowed streams
   * once the pool is full, before the remaining excess is shed. A value of
   * 0 sheds immediately; 0.25 preserves the legacy balanced policy; 1.0
   * keeps all overload in the queue/slow-stream path.
   *
   * This is intentionally independent from {@link serveThrottlePolicy},
   * which remains only as a compatibility hint for pre-v15 saves.
   */
  serveSlowdownLimit?: number;
  /** Maximum temporary API peak-price uplift while the pool is overloaded. */
  peakPricingPct?: number;
  /**
   * When false, freeze new API adopter growth; existing API intensity remains.
   * Default true. Missing on older saves.
   */
  apiAcceptingNew?: boolean;
  /**
   * Master enrollment switch for every plan. Per-plan {@link SubPlan.acceptingNew}
   * only applies while this is on. Default true.
   */
  subsAcceptingNew?: boolean;
  /** Public models currently listed as simultaneous API endpoints. */
  apiModelIds?: string[];
  /**
   * Serving routers listed as API mixes. Optional on old saves.
   * When set, those mixes are sold as one endpoint each; members stay hidden.
   */
  apiRouterIds?: string[];
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

export type ServeThrottlePolicy = "shed" | "balanced" | "throttle" | "surge";

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
  /** 0–100 personality / steerability. Missing offers treat as chat-quality proxy. */
  personality?: number;
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
  /** Set when this offer is a live serving router mix, not a single model. */
  routerId?: string;
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
  /** Public-model hosting stack (endpoint replicas, KV pool, load infra). */
  dayHostingOpex?: number;
  dayMarketing: number;
  /** Loan principal + interest paid today */
  dayLoanPayment: number;
  /** Energy charged to non-inference pools */
  dayEnergyOther: number;
  /** Chip amort charged to non-inference */
  dayChipAmortOther: number;
  /** Data supplier contracts, buys, processing, prune audits */
  dayDataCost?: number;
  /** Training setup + daily cluster burn */
  dayTrainingCost?: number;
  /** Research node / program cash burn */
  dayResearchCost?: number;
  /** Hire / poach signing costs */
  dayHiringCost?: number;
  /** One-off capital spends booked through the ledger (optional) */
  dayCapexCost?: number;
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
  /** Optional model-backed origin for an investor pitch. */
  modelId?: string;
  /** Disclosed thinking head (`instant`, `medium` / Think, `high` / Deep, or a custom recipe id). */
  effortId?: string;
}

export type InvestorPitchOutcome = "funded" | "declined";

/** Select value for a model-backed pitch: weights plus disclosed thinking head. */
export interface InvestorPitchTarget {
  modelId: string;
  /** Effort recipe id. Instant is always `instant`. */
  effortId: string;
}

/** Persisted result of a model-backed investor conversation. */
export interface InvestorPitchRecord {
  id: string;
  modelId: string;
  /** Thinking head disclosed in this conversation. Missing in legacy saves → Instant. */
  effortId?: string;
  modelName: string;
  investorName: string;
  day: number;
  outcome: InvestorPitchOutcome;
  successChance: number;
  cashRaised: number;
  preMoneyValuation: number;
  postMoneyValuation: number;
  investorOwnership: number;
  cooldownUntilDay: number;
}

export type MarketingChannel =
  "web" | "billboards" | "restaurants" | "enterprise";

export type MarketingChannels = Record<MarketingChannel, number>;

/** Per-channel slice of the canonical daily marketing result. */
export interface MarketingChannelBreakdown {
  spend: number;
  /** Raw conversions at face value: spend / channel CAC */
  baseAcquisitions: number;
  /** After channel fit × model appeal × brand factor × saturation */
  effectiveAcquisitions: number;
  qualifiedLeads: number;
  enterpriseLeads: number;
  /** New addressable-market customers created (not share stolen) */
  marketExpansion: number;
  brandGain: number;
}

/**
 * Canonical daily marketing result, computed once per day by
 * systems/marketing. Market demand / brand settlement consume this instead of
 * re-deriving campaign effects from raw spend.
 */
export interface MarketingOutcome {
  day: number;
  spend: number;
  qualifiedLeads: number;
  acquiredCustomers: number;
  enterpriseLeads: number;
  /** TAM growth in customer-equivalents (grows the market, not just share) */
  marketExpansion: number;
  /** Campaign brand lift applied by the marketing system (single writer) */
  brandGain: number;
  channelBreakdown: Record<MarketingChannel, MarketingChannelBreakdown>;
  /** spend / acquiredCustomers (0 when nothing was acquired) */
  effectiveCac: number;
}

/** Cash-distress ladder surfaced to UI; bankruptcy ends the run. */
export type CashDistressStage =
  "stable" | "distressed" | "severe" | "final" | "bankrupt";

export interface CapitalStack {
  capTable: EquityStake[];
  fundingRounds: FundingRound[];
  debt: DebtInstrument[];
  investorConfidence: number;
  boardPressure: number;
  founderControl: number;
  /** Global and per-model cooldowns for the model-backed investor desk. */
  pitchCooldownUntilDay?: number;
  pitchModelCooldowns?: Record<string, number>;
  pitchHistory?: InvestorPitchRecord[];
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

/** Per-model income attribution for the public fleet. */
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
  /** Text prompt tokens actually presented to the model, in millions. */
  inputMTok?: number;
  /** Prefix/cache hits are tracked separately because they have different COGS. */
  cachedInputMTok?: number;
  /** Visible model output, in millions of tokens. */
  outputMTok?: number;
  /** Hidden chain-of-thought / reasoning work, in millions of tokens. */
  reasoningMTok?: number;
  /** External tools invoked by an agent workload. */
  toolCalls?: number;
  /** Completed image generations. */
  images?: number;
  /** Resolution x denoising-step work used by image generation. */
  megapixelSteps?: number;
  /** Native audio duration processed or generated. */
  audioSeconds?: number;
  /** Native video duration generated. */
  videoSeconds?: number;
}

/** One conserved unit of work from customer request through billing. */
export interface ComputeWorkItem {
  id: string;
  labId: LabId;
  /** Commercial channel is independent from the product-native work kind. */
  channel: "api" | "subscription" | "enterprise";
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
  /** 0–1 throttling EMA: streams slowed by overload under a throttle policy. */
  speedStrain?: number;
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
  /** Latest settled rival campaign result; absent on legacy saves. */
  marketingOutcome?: MarketingOutcome;
  enterpriseContracts?: number;
  wagesPerDay?: number;
  powerExportEnabled?: boolean;
  publicEstimate?: RivalPublicEstimate;
  strategy?: RivalControllerState;
  /**
   * Latest infrastructure build target derived from the scale-ladder decision.
   * Optional so old saves load unchanged; recomputed when stale or missing.
   */
  campusPlan?: RivalCampusPlan;
  /** Seeded, financially-accounted emergency backing and checkpoint comeback. */
  financialComeback?: RivalFinancialComeback;
}

export interface RivalFinancialComeback {
  /** Incremented only when this lab enters a fresh distress episode. */
  distressEpisode: number;
  /** Episode whose single backing roll was already consumed. */
  attemptedEpisode?: number;
  /** Backers will not reconsider until this day, even after a new distress episode. */
  cooldownUntilDay: number;
  status: "none" | "announced" | "released";
  announcedDay?: number;
  releaseDay?: number;
  completedDay?: number;
  backingCash?: number;
  acquisitionCost?: number;
  investorName?: string;
  modelId?: string;
  family?: ModelFamily;
  backbone?: ModelBackbone;
  productPreset?: ModelProductPreset;
  /** Acquired checkpoint scale snapshotted when the rescue is announced. */
  paramsB?: number;
  activeParamsRatio?: number;
  /** Research/process multiplier carried by the acquired checkpoint. */
  researchMultiplier?: number;
  /** Immutable technical snapshot disclosed with the acquired weights. */
  researchUnlocked?: string[];
  dataCoverage?: number;
  dataQuality?: number;
  modalityExperience?: Partial<Record<"image" | "audio" | "video", number>>;
  targetCapability?: number;
  referenceFrontierCapability?: number;
}

/**
 * Persisted rival infrastructure plan: the model the lab is building toward
 * and the capacity the campus must have ready before the campaign starts.
 */
export interface RivalCampusPlan {
  createdDay: number;
  /** Strategy revision the plan was computed from (replan on change). */
  decisionRevision: number;
  targetParamsB: number;
  targetActiveParamsB?: number;
  targetFamily: ModelFamily;
  targetBackbone: ModelBackbone;
  /** Hall size chosen from projected three-year rack demand. */
  dcSize: "dc" | "dc_m" | "dc_l";
  projectedRackDemand: number;
  projectedMwDemand: number;
  projectedHbmGb: number;
  projectedSystemRamGb: number;
  projectedDataMTok: number;
  triggers: string[];
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
  /** 0–1 throttling EMA: streams slowed by overload under a throttle policy. */
  speedStrain?: number;
  researchUnlocked: string[];
  activeResearch: ResearchProgress | string | null;
  researchQueue: string[];
  models: Model[];
  trainingJob: TrainingJob | RivalTrainJob | null;
  pricing: ProductPricing;
  /** Player serving routers; rivals omit this. */
  modelRouters?: ModelRouter[];
  activeModelRouterId?: string | null;
  rackFleet: RackInstall[];
  rackDesigns: RackDesign[];
  fab: FabProject;
  marketingSpendPerDay: number;
  /** Persistent growth allocation as a multiple of the lab's daily revenue basis. */
  marketingRevenueMultiple?: number;
  marketingChannels?: MarketingChannels;
  marketingOutcome?: MarketingOutcome;
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
  /** Useful training PF after the selected compute format's hardware multiplier. */
  usefulTrainPf?: number;
  etaDays: number;
  minCalendarDays: number;
  upfrontCash: number;
  cashBurnPerDay: number;
  weightedMTok: number;
  effectiveDataRatio: number;
  /** Raw-target progress and the reductions that produce effective training signal. */
  dataGuidance?: {
    rawStrongTargetMTok: number;
    rawStrongTargetMet: boolean;
    qualityRetention: number;
    diversityRetention: number;
    holdoutRetention: number;
    lowQualityRetention: number;
    provenanceRetention: number;
  };
  repeatedDataEpochs: number;
  modalityComputeMult: number;
  expectedCapability: number;
  interactiveTokPerSec: number;
  /** PF-days per MTok at the recipe's native serve precision. */
  servePfPerMTok?: number;
  servePrecision?: NativeWeightPrecision;
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
  /** Minimum active days used to pace useful PF for trillion-scale base training. */
  minCalendarDays?: number;
  /** Funded, unpaused active-day telemetry. */
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
  /** Align slice of the shared spider recipe (0.1–0.9). */
  postTrainShare?: number;
  /** Planned alignment tokens; consumed in a later pass for the player. */
  postTrainMTok?: number;
  totalMTok: number;
  outcomeSeed?: number;
  outcomeRisk?: "low" | "medium" | "high";
  effectiveDataRatio?: number;
  repeatedDataEpochs?: number;
  modalityComputeMult?: number;
  /** Immutable manifest identity and compact evidence retained for parity. */
  dataManifestId?: string;
  dataEvidence?: TrainingDataEvidence;
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

/** City-block parcel use: municipal utility, buildable commercial infill, protected park, or road/bridge infrastructure. */
export type UrbanUse =
  "municipal" | "commercial_infill" | "park" | "infrastructure";

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
  /** City-block parcel classification (compact worlds derive it in sim/world/urbanInfill). */
  urbanUse?: UrbanUse;
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
  /**
   * When true, the next small `hq` placement is free (build + land waived)
   * and completes instantly. Cleared after use.
   */
  starterHqGrant?: boolean;
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
  /** Headline throttling EMA: max of the two channel strains. */
  speedStrain?: number;
  /** 0–1 throttling EMA on the API channel (streams to API users). */
  apiSpeedStrain?: number;
  /** 0–1 throttling EMA on the subscription channel (plan streams). */
  subSpeedStrain?: number;
  /** 0–1 EMA of API unserved load used by the peak-pricing control. */
  apiSurgeLevel?: number;
  researchUnlocked: string[];
  activeResearch: ResearchProgress | null;
  /** Ordered research queue (next starts when active completes) */
  researchQueue: string[];
  /** Named-pod method queue; kept separate from the legacy single-worker queue. */
  researchProgramQueue?: string[];
  models: Model[];
  /** In-flight immutable weight snapshots undergoing private evaluation. */
  trainingCheckpoints?: TrainingCheckpointCandidate[];
  /** Concurrent paid benchmark/reviewer work across jobs and checkpoints. */
  privateEvaluationJobs?: PrivateEvaluationJob[];
  /** Concurrent player training jobs. `trainingJob` mirrors the first entry for legacy saves. */
  trainingJobs?: TrainingJob[];
  trainingJob: TrainingJob | null;
  safetyCampaign: SafetyCampaign | null;
  /** Code / math / research gyms that grade post-training. */
  postTrainGyms?: PostTrainGym[];
  /** Tool curricula taught into the tools post-train stage. */
  toolSkills?: ToolSkill[];
  /** Named serving routers over released (and internal) models. */
  modelRouters?: ModelRouter[];
  activeModelRouterId?: string | null;
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
  /** Latest settled daily marketing result (written once per day by systems/marketing). */
  marketingOutcome?: MarketingOutcome;
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

/**
 * Durable, typed intelligence entries for the World feed. `news` remains the
 * legacy wire for save compatibility; systems append meaningful transitions
 * here so the feed can filter model/research and rival/market activity without
 * parsing prose.
 */
export type WorldFeedCategory = "world" | "models" | "market" | "rivals";

export type WorldFeedTone = "neutral" | "positive" | "warning" | "danger" | "research";

export interface WorldFeedEvent {
  id: string;
  day: number;
  category: WorldFeedCategory;
  title: string;
  body: string;
  source?: string;
  tone?: WorldFeedTone;
  entityId?: LabId;
  kind?: string;
}

export interface VictoryState {
  outcome: GameOutcome;
  reason: string;
  goalShare: number;
  goalValuation: number;
  goalCapability: number;
  bankruptDay: number;
  /** Consecutive distinct days meeting fulfilled-share/SLO/headroom dominance. */
  dominanceQualifiedDays?: number;
  lastDominanceQualifiedDay?: number;
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
    /** Human/organization adoption grows slower than automated task volume. */
    reportYearUserMinMultiplier?: number;
    reportYearUserMaxMultiplier?: number;
    /** Legacy min/max fields are retained as task-intensity multipliers. */
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
  /** Procedural geometry selected for the company mark. */
  companyLogo?: import("./balance/gameConfig").CompanyLogoSpec;
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

export interface CatchUpCampaign {
  rivalId: LabId;
  armedDay: number;
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
  /** Per-campaign balance overrides (pause-menu Balance tab); absent = defaults. */
  balanceTuning?: Partial<BalanceTuning>;
  calendar: CalendarState;
  progression: ProgressionState;
  automation: AutomationPolicies;
  /** Canonical v4 lab index; compatibility player/rivals views are synchronized daily. */
  playerLabId: LabId;
  /**
   * Stage A canonical company records. `player` / `rivals` / `labs` remain
   * read-only compatibility projections rebuilt from this map after writes.
   */
  playerCompanyId?: LabId;
  companies?: Record<LabId, import("./company/types").CompanyState>;
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
  /** HQ furniture layouts. Missing on older saves and normalized on load. */
  hqOfficeLayouts?: Record<string, HqOfficeLayout>;
  /** Long-term utility and PPA commitments settled take-or-pay. */
  energyContracts: EnergyContract[];
  /** Authoritative finite interconnection ledger by map region. */
  regionInterconnections: RegionInterconnection[];
  /** Open data market listings (refreshes over days) */
  dataMarket: DataMarketState;
  segments: SegmentState[];
  /**
   * Market-facing domain heat (coding/agents/science pulse). Absent on old
   * saves; normalized to the 2026 baseline on load.
   */
  domainHeat?: DomainHeat;
  /**
   * Armed competitive-response campaign. Absent until a seeded daily roll
   * fires; persists through the challenger's training job.
   */
  catchUpCampaign?: CatchUpCampaign;
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
  /** Newest-first typed feed entries; optional for migration-safe old saves. */
  feedEvents?: WorldFeedEvent[];
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
    /** API channel demand ÷ its reserved capacity today (1 = saturated). */
    apiLoad?: number;
    /** Subscription channel demand ÷ its reserved capacity today. */
    subLoad?: number;
    /** Demand that could not be served or trickled down today (MTok). */
    overflowMTok?: number;
    /** Unserved API demand retried onto the lab's other models today (MTok). */
    trickledMTok?: number;
    /** 0–1 throttling EMA in effect during today's offers. */
    speedStrain?: number;
    /** API-channel throttle strain after today's settlement. */
    apiSpeedStrain?: number;
    /** Subscription-channel throttle strain after today's settlement. */
    subSpeedStrain?: number;
    /** Posted API surge EMA (0–1) after today's settlement. */
    apiSurgeLevel?: number;
    /** Effective API list-price multiplier from surge policy. */
    apiSurgeMultiplier?: number;
    /** Blended public list $/MTok before peak uplift. */
    apiListPricePerMTok?: number;
    /** Posted peak $/MTok (list × surge multiplier). */
    apiPeakPricePerMTok?: number;
    /** Settled API revenue above the list-price bill for today's tokens. */
    apiPeakExtraRevenue?: number;
    /** Inference pool is empty or coverage cannot admit demand. */
    serveOutage?: boolean;
    /** New API MTok refused today because pause-new is on. */
    pausedNewApiMTok?: number;
    /** New plan seats refused today because pause-new is on. */
    pausedNewSubscriptionSeats?: number;
    planStats: PlanDayStats[];
    /** Served subscription MTok today keyed by plan id. */
    servedMTokByPlanId?: Record<string, number>;
    /** Served MTok from free plans today. */
    servedFreeMTok?: number;
    /** Served MTok from paid plans today. */
    servedPaidMTok?: number;
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
    /** Tasks per adopter multiplier, separated from user adoption. */
    marketTaskIntensity?: number;
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
    /** Shaped subscription seats declined by configured enrollment caps. */
    capBlockedSubscriptionSeats?: number;
    /** Product revenue at the current saturated capacity and channel mix. */
    capacityProductRevenueCeiling?: number;
    /** Compute-v2 reconciliation record for the player lab. */
    computeLedger?: ComputeLedger;
  };
  /** Rolling finance/compute history for trends (newest last). */
  financeHistory: FinanceDaySnapshot[];
  /** Per-plan daily subscriber/revenue/token history for UI graphs (newest last). */
  planStatsHistory: PlanStatsDaySnapshot[];
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
  /** Local, grid-backed raw PF only. Cloud PF is not divided by MW. */
  pfPerMw: number;
  /** Local raw PF represented by this sample (after local derates/leases). */
  localPf?: number;
  /** Remote/cloud raw PF represented by this sample. */
  cloudPf?: number;
  /** Local MW draw used for the local PF/MW ratio. */
  localMw?: number;
  /** Combined effective PF across local and cloud pools. */
  combinedEffectivePf?: number;
  /** Effective PF attributable to the cloud pool (for the breakdown UI). */
  cloudEffectivePf?: number;
}

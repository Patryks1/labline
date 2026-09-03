import type {
  CapabilityDomain,
  DataDomain,
  LabId,
  ModelCapabilities,
  ModelIOModality,
  ModelProductPreset,
  ServePrecision,
  TrainingComputeFormat,
} from "../types";

export type ArchFamily = "dense" | "moe";
export type ModelGoal =
  | "specialist"
  | "flagship"
  | "distill"
  | "continue"
  | "multimodal"
  | "omni";
export type TrainPrecision = TrainingComputeFormat;
export type Modality = ModelIOModality;

export interface Architecture {
  backbone: ArchFamily;
  totalParamsB: number;
  /** Equal to `totalParamsB` for dense models. */
  activeParamsB: number;
  precision: TrainPrecision;
  preset: ModelProductPreset;
  inputs: Modality[];
  outputs: Modality[];
  contextK?: number;
}

export interface DataAllocation {
  domainMTok: Partial<Record<DataDomain, number>>;
  holdoutShare: number;
  /** Distill: 0–1 share of requested tokens generated from the teacher. */
  teacherSynthShare?: number;
}

export interface EffectiveDataBreakdown {
  rawMTok: number;
  uniqueMTok: number;
  effectiveMTok: number;
  qualityWeight: number;
  diversity: number;
  epochs: number;
  epochFactor: number;
  syntheticShare: number;
  syntheticDiscount: number;
  domainMix: Partial<Record<DataDomain, number>>;
  perDomain: Partial<
    Record<
      DataDomain,
      {
        rawMTok: number;
        effectiveMTok: number;
        quality: number;
        syntheticShare: number;
      }
    >
  >;
}

export type DesignMode =
  | { kind: "pretrain" }
  | { kind: "distill"; teacherCheckpointId: string }
  | { kind: "continue"; parentCheckpointId: string };

export type ComputeSource = "local" | "cloud" | "mixed";

export interface ModelDesign {
  id: string;
  name: string;
  goal: ModelGoal;
  arch: Architecture;
  data: DataAllocation;
  mode: DesignMode;
  compute: {
    pfPerDay: number;
    priority: number;
    source: ComputeSource;
  };
  createdDay: number;
}

export type TrainingUnlock =
  | "moe"
  | "omni"
  | "vision"
  | "audio"
  | "video"
  | "context_32k"
  | "long_context"
  | "context_1m"
  | "context_10m"
  | "context_100m"
  | "fp16_train"
  | "bf16_train"
  | "fp8_train"
  | "fp6_train"
  | "nvfp4_train"
  | "distill"
  | "merge"
  | "thinking_tiers"
  | "router_domain"
  | "router_cascade"
  | "continued_pretrain"
  | "verifier";

/**
 * Frozen research/lab modifiers applied to a design or run.
 *
 * - `paramEfficiency` / `dataEfficiency` multiply Kaplan A/B (1 = baseline, <1 better).
 * - `computeThroughput`, `stability`, `precisionPenaltyMult`, `postTrainEfficiency`,
 *   `syntheticQuality`, `distillEfficiency`, `serveEfficiency`, `hostingDiscount`,
 *   `quantPenaltyMult`, and `modalityBridge` multiply (1 = baseline).
 * - `ceilingLift` is additive capability points.
 * - `rlQuality`, `routerQuality`, and `verifierStrength` are 0–1.
 */
export interface TrainingModifiers {
  paramEfficiency: number;
  dataEfficiency: number;
  computeThroughput: number;
  stability: number;
  precisionPenaltyMult: number;
  ceilingLift: number;
  postTrainEfficiency: number;
  rlQuality: number;
  syntheticQuality: number;
  verifierStrength: number;
  distillEfficiency: number;
  routerQuality: number;
  serveEfficiency: number;
  hostingDiscount: number;
  quantPenaltyMult: number;
  modalityBridge: number;
  unlocks: TrainingUnlock[];
}

export interface LossBreakdown {
  nEff: number;
  dEff: number;
  paramTerm: number;
  dataTerm: number;
  loss: number;
  precisionPenalty: number;
  gap: number;
}

export interface ComputeBreakdown {
  trainPfDays: number;
  holdoutPfDays: number;
  totalPfDays: number;
  archCost: number;
  modalityCost: number;
  throughput: number;
  days: number;
  paceFloorDays: number;
  trainHbmGB: number;
  cashEstimate: number;
}

export interface ForecastBlocker {
  code: string;
  message: string;
}

export interface CapabilityBand {
  p10: number;
  p50: number;
  p90: number;
  ceiling: number;
  sigma: number;
}

export interface Forecast {
  compute: ComputeBreakdown;
  loss: LossBreakdown;
  effectiveData: EffectiveDataBreakdown;
  capability: CapabilityBand;
  domains: Record<CapabilityDomain, number>;
  blockers: ForecastBlocker[];
  warnings: string[];
}

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "awaiting_decision"
  | "completed"
  | "failed"
  | "cancelled";

export type IncidentKind =
  | "loss_spike"
  | "hardware_fault"
  | "data_contamination"
  | "divergence"
  | "eval_surprise"
  | "breakthrough";

export interface IncidentChoiceEffects {
  sigmaMult?: number;
  costMult?: number;
  rollbackProgress?: number;
  daysDelta?: number;
  gapDelta?: number;
}

export interface IncidentChoice {
  id: string;
  label: string;
  description: string;
  effects: IncidentChoiceEffects;
}

export interface RunIncident {
  id: string;
  kind: IncidentKind;
  day: number;
  title: string;
  body: string;
  choices: IncidentChoice[];
  resolvedChoiceId?: string;
  autoResolveDay: number;
}

export interface LossSample {
  progress: number;
  loss: number;
}

export interface TrainingRun {
  id: string;
  labId: LabId;
  design: ModelDesign;
  forecast: Forecast;
  modifiersFrozen: TrainingModifiers;
  seed: number;
  status: RunStatus;
  startDay: number;
  progress: number;
  pfDaysDone: number;
  pfDaysTotal: number;
  cashSpent: number;
  etaDays: number;
  incidents: RunIncident[];
  sigmaMult: number;
  costMult: number;
  gapDelta: number;
  checkpointIds: string[];
  /** Unused. Snapshots are manual; kept for save compatibility. */
  autoCheckpointEvery: number;
  lossCurve: LossSample[];
  finalCheckpointId?: string;
  parentCheckpointId?: string;
  teacherCheckpointId?: string;
  failureReason?: string;
}

export type CheckpointStage = "base" | "post";
export type CheckpointStatus =
  | "stealth"
  | "kept"
  | "released"
  | "retired"
  | "sold"
  | "discarded";

export interface TrainingSummary {
  pfDays: number;
  effectiveMTok: number;
  loss: number;
  gap: number;
  dataMix: Partial<Record<DataDomain, number>>;
  syntheticShare: number;
  distilledFrom?: string;
  mergedFrom?: string[];
}

export type PostTrainStageKind =
  | "instruct"
  | "preference"
  | "reasoning"
  | "agentic";

export interface PostTrainStageRecord {
  effect: number;
  runs: number;
  pfDays: number;
}

export interface PostTrainRecord {
  stages: Partial<Record<PostTrainStageKind, PostTrainStageRecord>>;
  safetyFocus?: number;
}

export type TierBudget = 1 | 2 | 4 | 8 | 12 | 20 | 100;

export interface ThinkingTier {
  budget: TierBudget;
  served: boolean;
}

export interface Checkpoint {
  id: string;
  labId: LabId;
  lineageId: string;
  parentId?: string;
  runId?: string;
  recipeId?: string;
  name: string;
  version: string;
  stage: CheckpointStage;
  status: CheckpointStatus;
  arch: Architecture;
  createdDay: number;
  progressAtSnapshot: number;
  /** Hidden capability truth. Never shown for unreleased checkpoints. */
  truth: ModelCapabilities;
  trainingSummary: TrainingSummary;
  postTrain: PostTrainRecord;
  tiers: ThinkingTier[];
  endpointIds: string[];
}

export interface PostTrainPools {
  instructionMTok: number;
  preferenceMTok: number;
  verifiableTasks: number;
  toolTrajectories: number;
}

export type PostTrainPoolKind = keyof PostTrainPools;

export type PostTrainForecastDelta = Partial<
  Record<
    | CapabilityDomain
    | "safety"
    | "steerability"
    | "reliability"
    | "factuality"
    | "robustness",
    number
  >
>;

export interface PostTrainForecast {
  pfDays: number;
  days: number;
  cash: number;
  deltas: PostTrainForecastDelta;
  unlocksTiers: boolean;
  adequacy: Partial<Record<PostTrainStageKind, number>>;
  warnings: string[];
}

export type RecipeStatus = "running" | "completed" | "cancelled";

export interface PostTrainRecipe {
  id: string;
  labId: LabId;
  checkpointId: string;
  stages: PostTrainStageKind[];
  safetyFocus: number;
  gymIds: string[];
  budgetPfDays: number;
  dataUse: PostTrainPools;
  /** Extra thinking budgets this recipe trains. Instant is implied. */
  thinkingBudgets?: TierBudget[];
  startDay: number;
  progress: number;
  pfDaysDone: number;
  status: RecipeStatus;
  forecast: PostTrainForecast;
  resultCheckpointId?: string;
  seed: number;
}

export type GymKind = "code" | "math" | "science" | "agentic" | "safety";

export interface Gym {
  id: string;
  labId: LabId;
  kind: GymKind;
  /** Gym campus tier, 0–3. */
  tier: number;
  /** Grader quality, 0–1. Live output grade, not a one-shot campus upgrade. */
  quality: number;
  tasksPerDay: number;
  researchers: number;
  /** Fraction of the shared research PF pool reserved by this gym. */
  researchShare: number;
  /** Daily operating cash. UI shows monthly = budgetPerDay × 30. */
  budgetPerDay: number;
  /** Kept/released checkpoint that grades tasks when synthetic data is unlocked. */
  teacherCheckpointId?: string;
  /** 0–1 share of yield spent filtering junk. Higher → fewer, cleaner tasks. */
  auditShare?: number;
  upgrade?: {
    toTier: number;
    completeDay: number;
    cashCost: number;
  };
}

export type EvalTier = "quick" | "suite" | "audit";
export type EvalMetric =
  | CapabilityDomain
  | "safety"
  | "steerability"
  | "reliability"
  | "overall";

export interface EvalMeasurement {
  mean: number;
  ci: number;
}

export interface EvalResult {
  measured: Partial<Record<EvalMetric, EvalMeasurement>>;
  season: number;
  leaked?: boolean;
}

export type EvalStatus = "running" | "complete";

export interface Eval {
  id: string;
  labId: LabId;
  checkpointId: string;
  tier: EvalTier;
  tierBudget: TierBudget;
  metrics: EvalMetric[];
  orderedDay: number;
  completeDay: number;
  cashCost: number;
  status: EvalStatus;
  result?: EvalResult;
  seed: number;
}

export interface PublicSeason {
  season: number;
  startDay: number;
  difficultyIndex: number;
  /** endpointId → flagged metrics */
  contamination: Record<string, EvalMetric[]>;
}

export type RouterPolicy = "single" | "domain" | "cascade" | "modality";
export type EndpointMemberRole = "primary" | "member" | "fallback";

export interface EndpointMember {
  checkpointId: string;
  role: EndpointMemberRole;
  domains?: CapabilityDomain[];
  modalities?: Modality[];
}

export type EndpointStatus = "live" | "sunset" | "retired";

export interface EndpointPricing {
  inPerMTok: number | null;
  outPerMTok: number | null;
}

export interface Endpoint {
  id: string;
  labId: LabId;
  name: string;
  members: EndpointMember[];
  policy: RouterPolicy;
  tiers: ThinkingTier[];
  precision: ServePrecision;
  status: EndpointStatus;
  releaseDay: number;
  sunset?: {
    startDay: number;
    drainDays: number;
  };
  pricing: EndpointPricing;
  openWeights: boolean;
  /**
   * Id of the projected legacy `Model` in `player.models`.
   * Equals the endpoint id.
   */
  modelId: string;
}

export interface TokenReservation {
  runId: string;
  domainMTok: Partial<Record<DataDomain, number>>;
}

export interface TrainingState {
  runs: TrainingRun[];
  checkpoints: Checkpoint[];
  recipes: PostTrainRecipe[];
  evals: Eval[];
  endpoints: Endpoint[];
  gyms: Gym[];
  pools: PostTrainPools;
  /** Running 0–1 grade of each post-train pool. Missing → treat as 1. */
  poolQuality?: PostTrainPools;
  reservations: TokenReservation[];
  seasons: PublicSeason[];
  biggestTrainedParamsB: number;
  moeRunsCompleted: number;
}

export type StartResult =
  | { ok: true; id: string }
  | { ok: false; reason: string };

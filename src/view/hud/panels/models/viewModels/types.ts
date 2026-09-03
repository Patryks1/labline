import type {
  CheckpointStage,
  CheckpointStatus,
  DesignMode,
  EndpointStatus,
  EvalMeasurement,
  EvalMetric,
  GymKind,
  LossSample,
  PostTrainPoolKind,
  ModelGoal,
  PostTrainPools,
  PostTrainStageKind,
  RecipeStatus,
  RouterPolicy,
  RunStatus,
  ThinkingTier,
} from "../../../../../sim/training/types";

export type ArchGlyphKind = "dense" | "moe" | "omni" | "specialist";

export interface CapBandVM {
  p10: number;
  p50: number;
  p90: number;
  ceiling: number;
}

export interface RunCardVM {
  id: string;
  name: string;
  glyph: ArchGlyphKind;
  sizeLabel: string;
  progress: number;
  etaDays: number;
  burnPerDay: number;
  band: CapBandVM;
  incidentCount: number;
  pendingDecision: boolean;
  status: RunStatus;
  mode: DesignMode["kind"];
  lastLoss: number | null;
  lossCurve: LossSample[];
  pfPerDay: number;
  pfAllocated: number;
  pfDaysDone: number;
  pfDaysTotal: number;
  priority: number;
  /** Checkpoint this continue/distill run hangs off, when present. */
  parentCheckpointId?: string;
}

export type CheckpointAction =
  | "continue"
  | "branch"
  | "distill"
  | "postTrain"
  | "evaluate"
  | "release"
  | "merge"
  | "keep"
  | "discard"
  | "openSource";

export interface CheckpointCardVM {
  id: string;
  name: string;
  version: string;
  glyph: ArchGlyphKind;
  sizeLabel: string;
  lineageId: string;
  stage: CheckpointStage;
  status: CheckpointStatus;
  /** Null when no eval has completed yet. */
  band: CapBandVM | null;
  measured: Partial<Record<EvalMetric, EvalMeasurement>>;
  tiers: ThinkingTier[];
  createdDay: number;
  lineageDepth: number;
  parentId?: string;
  childIds: string[];
  endpointIds: string[];
  lastLoss: number | null;
  pfDays: number;
  actions: CheckpointAction[];
  /** Why an action is shown but not usable. */
  actionLocks: Partial<Record<CheckpointAction, string>>;
  lossCurve: LossSample[];
  precision: string;
  backbone: string;
  preset: string;
  inputs: string[];
  outputs: string[];
  dataMix: Partial<Record<string, number>>;
  syntheticShare: number;
  postStages: {
    kind: PostTrainStageKind;
    runs: number;
    pfDays: number;
    effect: number;
  }[];
  safetyFocus?: number;
}

export interface RecipeCardVM {
  id: string;
  checkpointId: string;
  checkpointName: string;
  stages: PostTrainStageKind[];
  progress: number;
  etaDays: number;
  burnPerDay: number;
  pfAllocated: number;
  status: RecipeStatus;
}

export interface EndpointCardVM {
  id: string;
  name: string;
  policy: RouterPolicy;
  memberNames: string[];
  status: EndpointStatus;
  revenuePerDay: number;
  share: number;
  tokPerSec: number;
  /** 0–1 fleet irrelevance. 1 means too stale to copy into a new training run. */
  agingPct: number;
  tiers: ThinkingTier[];
  hbmGB: number;
  publicScores: Partial<Record<EvalMetric, number>>;
  sunsetDaysLeft?: number;
  openWeights: boolean;
}

export interface GymCardVM {
  id: string;
  kind: GymKind;
  tier: number;
  quality: number;
  tasksPerDay: number;
  researchers: number;
  /** HQ researchers not already reserved by pods, gyms, safety, or audits. */
  spareResearchers: number;
  /** Fraction of the research PF pool reserved by this gym. */
  researchShare: number;
  /** Additional research-pool share this gym can still claim. */
  spareResearchShare: number;
  /** Daily operating cash. */
  budgetPerDay: number;
  /** Effective graded yield after staffing, compute, and budget. */
  yieldPerDay: number;
  yieldUnit: "tasks" | "preferenceMTok";
  bottleneck: "researchers" | "compute" | "budget" | null;
  /** True when the allocated daily budget exceeds current cash. */
  pausedForCash: boolean;
  /** 0–1 share of yield spent auditing tasks. */
  auditShare: number;
  teacherCheckpointId?: string;
  synthUnlocked: boolean;
  teachers: { id: string; name: string }[];
  poolKind: PostTrainPoolKind;
  poolAmount: number;
  poolQuality: number;
  cleanCash: number;
  canClean: boolean;
  nextTierMonthly: number | null;
  needsGrader: boolean;
  upgrade?: {
    toTier: number;
    daysLeft: number;
    cashCost: number;
  };
}

export interface LineageNodeVM {
  id: string;
  name: string;
  version: string;
  stage: CheckpointStage;
  status: CheckpointStatus;
  depth: number;
  isSelected: boolean;
  /** True when this node is the selected checkpoint or an ancestor of it. */
  onPath: boolean;
  children: LineageNodeVM[];
}

export type PipelineForestNodeVM =
  | { kind: "checkpoint"; card: CheckpointCardVM; children: PipelineForestNodeVM[] }
  | { kind: "recipe"; card: RecipeCardVM; children: PipelineForestNodeVM[] }
  | { kind: "run"; card: RunCardVM; children: PipelineForestNodeVM[] };

export interface PipelineLineageVM {
  id: string;
  name: string;
  roots: PipelineForestNodeVM[];
}

export interface PipelineBoardVM {
  training: RunCardVM[];
  checkpoints: CheckpointCardVM[];
  postTraining: RecipeCardVM[];
  /** Kept, unreleased checkpoints waiting to ship. Released models live on Fleet. */
  ready: CheckpointCardVM[];
  /** Lineage trees for the Pipeline board. Roots are parentless visible checkpoints. */
  lineages: PipelineLineageVM[];
  /** In-flight runs that are not attached to a checkpoint in `lineages`. */
  unattachedTraining: RunCardVM[];
  /** In-flight recipes whose source checkpoint is not on the board. */
  unattachedRecipes: RecipeCardVM[];
  trainingPfPool: number;
  trainingPfAllocated: number;
}

export interface FleetVM {
  endpoints: EndpointCardVM[];
  totalRevenuePerDay: number;
  totalHbmGB: number;
}

export interface GymsVM {
  gyms: GymCardVM[];
  pools: PostTrainPools;
}

export type ModelsSelection =
  | { kind: "run"; id: string }
  | { kind: "checkpoint"; id: string }
  | { kind: "recipe"; id: string }
  | { kind: "endpoint"; id: string }
  | { kind: "gym"; id: string }
  | null;

export type ModelsDialog =
  | {
      kind: "design";
      goal?: ModelGoal;
      parentCheckpointId?: string;
      teacherCheckpointId?: string;
      copyFromEndpointId?: string;
    }
  | { kind: "postTrain"; checkpointId: string }
  | { kind: "distill"; teacherCheckpointId: string }
  | { kind: "evaluate"; checkpointId: string }
  | { kind: "release"; checkpointId: string }
  | { kind: "router"; endpointId?: string }
  | { kind: "sunset"; endpointId: string }
  | { kind: "merge"; aId: string; bId?: string }
  | null;

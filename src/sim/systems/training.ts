import { aggregateEffects } from "./research";
import type {
  BenchmarkScores,
  Model,
  PostTrainStage,
  QualityAxes,
  SimState,
  StartTrainingOpts,
  TrainingComputeFormat,
  TrainingJob,
  TrainingNumerics,
} from "../types";
import { computeSnapshot } from "./compute";
import type { ComputeSnapshot } from "./compute";
import { mwPerPf } from "./computeMarket";
import {
  normalizeDataQuality,
  scaleIntelligence,
  scoresFromScale,
} from "../balance/modelScaling";
import { getResearchNode } from "../balance/research";
import { attachModelToEmptyPlans } from "./plans";
import { scheduleReleaseEvaluations } from "./evaluations";
import { deriveModelCapabilities } from "../balance/modelCapabilities";
import {
  DATA_MIX_DEFS,
  clampDistillTeacherShare,
  distillFromTeacher,
  DISTILL_RETENTION,
  estimateTrainingEconomics,
  formatParams,
  sizeGate,
  suggestedApiPricePerMTok,
  trainCostPfDays,
} from "../balance/training";
import {
  allocateTrainingHardwarePools,
  allocateWeightedTrainingCompute,
  DEFAULT_TRAINING_NUMERICS,
  estimateTrainingMemoryGb,
  LEGACY_TRAINING_NUMERICS,
  trainingNumericsEconomicsProfile,
  validateTrainingNumerics,
} from "../balance/trainingPrecision";
import type { TrainingHardwarePool } from "../balance/trainingPrecision";
import {
  analyzeTrainingData,
  backboneFromFamily,
  ioForPreset,
  presetFromFamily,
  rollTrainingOutcome,
  serviceProfileForModel,
} from "../balance/trainingV3";
import { createRng, hashSeed, seededId } from "../rng";

export const TRAINING_EXTENSION_DAYS = 10;
export const TRAINING_BENCHMARK_MIN_PROGRESS = 0.1;
export const TRAINING_BENCHMARK_COOLDOWN_DAYS = 7;
import { suggestApiInOut } from "../balance/pricing";
import { DATA_DOMAIN_META, DATA_DOMAINS, normalizeDomainStock } from "../balance/data";
import { modelTrainVramGb } from "../balance/racks";
import { fleetStats, resolveRackSku } from "./racks";
import { modelCanCurateDataDomain } from "./modelEligibility";
import type { DataDomain, DataMix, LabData, SyntheticFillRecord, TrainingDataPlan } from "../types";
import {
  consumeForTraining,
  ensureLabData,
  formatMix,
  formatTokens,
  minDataMTokForParams,
  newDataSinceModel,
  recommendedDataMTok,
  specialistDomainBoost,
  totalProcessed,
} from "./data";
import type { ConsumeResult } from "./data";
import { lqSynthCapabilityMult, normalizeWeights } from "../balance/data";
import { createDataManifest } from "./dataAssets";
import { modelStackModifiers, sanitizeModelStack } from "../balance/modelStack";
import { normalizeModelEvaluations } from "../balance/evaluationSuites";
import {
  syntheticTrainingProfile,
  teacherSyntheticHeadroomMTok,
} from "../balance/syntheticTraining";
import {
  completedPostTrainStages,
  postTrainEffectProfile,
  postTrainMinimumDays,
  resolvedPostTrainStageEffectiveness,
  postTrainStageEffectiveness,
  postTrainTargetPfDays,
} from "../balance/postTraining";

const POST_TRAIN_ORDER: PostTrainStage[] = [
  "none",
  "sft",
  "rlhf",
  "process",
  "tools",
];

/** Read concurrent jobs while honoring direct legacy `trainingJob` mutations in old saves/tests. */
export function playerTrainingJobs(state: SimState): TrainingJob[] {
  const jobs = state.player.trainingJobs ?? [];
  const legacy = state.player.trainingJob;
  if (!legacy) return jobs;
  return [legacy, ...jobs.filter((job) => job.id !== legacy.id)];
}

export function withTrainingJobs(
  state: SimState,
  jobs: TrainingJob[],
): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      trainingJobs: jobs,
      trainingJob: jobs[0] ?? null,
    },
  };
}

function playerTrainingHardwareGeneration(
  state: SimState,
  format: TrainingComputeFormat,
): number {
  let generation = 0;
  for (const rack of state.player.rackFleet ?? []) {
    if (rack.status !== "live" || rack.count <= 0) continue;
    const accelerator = resolveRackSku(
      rack.skuId,
      state.player.rackDesigns ?? [],
    ).accelerator;
    if (accelerator && !accelerator.supportedTrainingFormats.includes(format))
      continue;
    generation = Math.max(generation, accelerator?.generation ?? 1);
  }
  for (const contract of state.computeContracts) {
    if (
      contract.buyerLabId !== state.playerLabId ||
      contract.status !== "active" ||
      contract.pf <= 0 ||
      (contract.availableDay != null && state.day < contract.availableDay)
    )
      continue;
    if (
      contract.supportedTrainingFormats &&
      !contract.supportedTrainingFormats.includes(format)
    )
      continue;
    generation = Math.max(generation, contract.acceleratorGeneration ?? 1);
  }
  return Math.max(generation, 1);
}

function playerTrainingHardwarePools(
  state: SimState,
  availableTrainingPf: number,
): TrainingHardwarePool[] {
  const capacityByGeneration = new Map<number, number>();
  let catalogLocalPf = 0;
  for (const rack of state.player.rackFleet ?? []) {
    if (rack.status !== "live" || rack.count <= 0) continue;
    const sku = resolveRackSku(rack.skuId, state.player.rackDesigns ?? []);
    const capacity = Math.max(0, sku.flopsPf * rack.count);
    const generation = sku.accelerator?.generation ?? 1;
    catalogLocalPf += capacity;
    capacityByGeneration.set(
      generation,
      (capacityByGeneration.get(generation) ?? 0) + capacity,
    );
  }

  // Include legacy blueprint deployments as conservative generation-1 PF.
  const aggregateLocalPf = Math.max(0, fleetStats(state).flopsPf);
  const legacyLocalPf = Math.max(0, aggregateLocalPf - catalogLocalPf);
  if (legacyLocalPf > 0) {
    capacityByGeneration.set(
      1,
      (capacityByGeneration.get(1) ?? 0) + legacyLocalPf,
    );
  }

  const remoteContracts = state.computeContracts.filter(
    (contract) =>
      contract.buyerLabId === state.playerLabId &&
      contract.status === "active" &&
      contract.pf > 0 &&
      (contract.availableDay == null || state.day >= contract.availableDay),
  );
  const bilateralInboundPf = state.computeLeases
    .filter((lease) => {
      if (lease.status !== "active" || lease.pf <= 0) return false;
      const buyerLabId =
        lease.buyerLabId ??
        (lease.playerSells ? lease.rivalId : state.playerLabId);
      return buyerLabId === state.playerLabId;
    })
    .reduce((sum, lease) => sum + lease.pf, 0);
  const localBasis = [...capacityByGeneration.values()].reduce(
    (sum, pf) => sum + pf,
    0,
  );
  const remoteBasis = remoteContracts.reduce(
    (sum, contract) => sum + contract.pf,
    0,
  );
  const basis = localBasis + remoteBasis + bilateralInboundPf;
  if (basis <= 0) {
    return [
      {
        id: "fallback-gen1",
        rawPf: Math.max(0, availableTrainingPf),
        hardwareGeneration: 1,
      },
    ];
  }
  return [
    ...[...capacityByGeneration.entries()].map(([generation, pf]) => ({
      id: `local-gen-${generation}`,
      rawPf: Math.max(0, availableTrainingPf) * (pf / basis),
      hardwareGeneration: generation,
    })),
    ...remoteContracts.map((contract) => ({
      id: `contract-${contract.id}`,
      rawPf: Math.max(0, availableTrainingPf) * (contract.pf / basis),
      hardwareGeneration: contract.acceleratorGeneration ?? 1,
      supportedTrainingFormats: contract.supportedTrainingFormats,
    })),
    ...(bilateralInboundPf > 0
      ? [
          {
            id: "bilateral-leases",
            rawPf:
              Math.max(0, availableTrainingPf) * (bilateralInboundPf / basis),
            hardwareGeneration: 1,
          },
        ]
      : []),
  ];
}

export interface TrainingResourceAllocation {
  rawPf: number;
  effectivePf: number;
  computeShare: number;
  ramAllocatedGb: number;
  ramRequiredGb: number;
  ramReady: boolean;
  systemRamAllocatedGb: number;
  systemRamRequiredGb: number;
  systemRamReady: boolean;
  bottleneck: "none" | "hbm" | "system_ram" | "both";
}

export interface PlayerTrainingResourcePlan {
  trainingRamGb: number;
  trainingSystemRamGb: number;
  trainingAllocationShare: number;
  jobs: Record<string, TrainingResourceAllocation>;
  safetyCampaign?: TrainingResourceAllocation;
}

function liveTrainingDaysRemaining(
  job: TrainingJob,
  effectivePf: number,
  progressPfDays = job.progressPfDays,
  daysElapsed = job.daysElapsed ?? 0,
): number {
  const remainingPfDays = Math.max(0, job.targetPfDays - progressPfDays);
  const computeDays =
    remainingPfDays <= 1e-9
      ? 0
      : effectivePf > 1e-9
        ? remainingPfDays / effectivePf
        : Number.POSITIVE_INFINITY;
  const calendarDays = Math.max(
    0,
    (job.minCalendarDays ?? 0) - daysElapsed,
  );
  return Math.max(computeDays, calendarDays);
}

function trainingStallReason(
  state: SimState,
  snap: ComputeSnapshot,
  resources: PlayerTrainingResourcePlan,
  resource: TrainingResourceAllocation | undefined,
): string {
  if (resource && resource.bottleneck !== "none") {
    if (resource.bottleneck === "system_ram") {
      return `Training system RAM blocked: ${resource.systemRamRequiredGb.toFixed(0)} GB needed, ${resource.systemRamAllocatedGb.toFixed(0)} GB assigned from the ${Math.round(resources.trainingAllocationShare * 100)}% Training allocation.`;
    }
    if (resource.bottleneck === "both") {
      return `Training memory blocked: ${resource.ramRequiredGb.toFixed(0)} GB HBM and ${resource.systemRamRequiredGb.toFixed(0)} GB system RAM needed; ${resource.ramAllocatedGb.toFixed(0)} GB HBM and ${resource.systemRamAllocatedGb.toFixed(0)} GB system RAM assigned.`;
    }
    return `Training HBM blocked: ${resource.ramRequiredGb.toFixed(0)} GB needed, ${resource.ramAllocatedGb.toFixed(0)} GB assigned from the ${Math.round(resources.trainingAllocationShare * 100)}% Training allocation.`;
  }
  if (state.player.allocation.training <= 1e-9) {
    return "Training compute blocked: zero PF is allocated to Training.";
  }
  if (snap.mwAvailable <= 1e-9 || snap.powerDerate <= 1e-9) {
    return "Training compute power-blocked: no powered PF is available.";
  }
  if (snap.pools.training <= 1e-9) {
    return "Training compute blocked: the Training pool has zero effective PF.";
  }
  if (resource && resource.rawPf <= 1e-9) {
    return "Training format blocked: no allocated accelerator supports this training format.";
  }
  return "Training compute blocked: zero effective PF was allocated to this run.";
}

/** The configured Training slice owns the same share of accelerator RAM as PF. */
export function trainingAllocationShare(state: SimState): number {
  const allocation = state.player.allocation;
  const total =
    Math.max(0, allocation.training) +
    Math.max(0, allocation.inference) +
    Math.max(0, allocation.research);
  return total > 1e-9 ? Math.max(0, allocation.training) / total : 0.34;
}

export function trainingRamBudgetGb(
  state: SimState,
  snap = computeSnapshot(state),
): number {
  return snap.trainingRamGb ?? snap.vramGb * trainingAllocationShare(state);
}

/** A distributed job must fit wholly in one low-latency execution domain. */
function trainingMemoryDomainFit(
  state: SimState,
  snap: ComputeSnapshot,
  hbmRequiredGb: number,
  systemRamRequiredGb: number,
): { hbmReady: boolean; systemRamReady: boolean; ready: boolean } {
  const share = trainingAllocationShare(state);
  const localHbm = snap.localVramGb * share;
  const remoteHbm = snap.remoteVramGb * share;
  const localSystemRam = snap.localSystemRamGb * share;
  const remoteSystemRam = snap.remoteSystemRamGb * share;
  const localHbmReady = localHbm + 1e-9 >= hbmRequiredGb;
  const remoteHbmReady = remoteHbm + 1e-9 >= hbmRequiredGb;
  const localSystemReady = localSystemRam + 1e-9 >= systemRamRequiredGb;
  const remoteSystemReady = remoteSystemRam + 1e-9 >= systemRamRequiredGb;
  return {
    hbmReady: localHbmReady || remoteHbmReady,
    systemRamReady: localSystemReady || remoteSystemReady,
    ready:
      (localHbmReady && localSystemReady) ||
      (remoteHbmReady && remoteSystemReady),
  };
}

function jobTrainingRamGb(state: SimState, job: TrainingJob): number {
  return modelTrainVramGb(
    job.targetParamsB,
    job.activeParamsB,
    job.family,
    job.trainingNumerics ?? job.numerics ?? LEGACY_TRAINING_NUMERICS,
    state.player.researchUnlocked.includes("opt_checkpoint"),
  );
}

function trainingMemoryForModel(
  state: SimState,
  model: { paramsB: number; activeParamsB?: number; family?: string; trainingNumerics?: TrainingNumerics },
) {
  return estimateTrainingMemoryGb({
    paramsB: model.paramsB,
    activeParamsB: model.activeParamsB,
    family: model.family,
    numerics: model.trainingNumerics ?? LEGACY_TRAINING_NUMERICS,
    activationCheckpointing: state.player.researchUnlocked.includes("opt_checkpoint"),
  });
}

function jobTrainingSystemRamGb(state: SimState, job: TrainingJob): number {
  return trainingMemoryForModel(state, {
    paramsB: job.targetParamsB,
    activeParamsB: job.activeParamsB,
    family: job.family,
    trainingNumerics: job.trainingNumerics ?? job.numerics,
  }).requiredSystemRamGb;
}

export interface ProspectiveTrainingRamFit {
  ready: boolean;
  trainingRamGb: number;
  candidateAllocatedGb: number;
  candidateRequiredGb: number;
  blockerName?: string;
  blockerAllocatedGb?: number;
  blockerRequiredGb?: number;
  candidateSystemRamAllocatedGb: number;
  candidateSystemRamRequiredGb: number;
  blockerResource?: "HBM" | "system RAM";
}

/** Check the post-launch priority split so a new run cannot evict another run. */
export function trainingRamFitForNewJob(
  state: SimState,
  candidateRequiredGb: number,
  candidatePriority: number,
  snap = computeSnapshot(state),
  candidateSystemRamRequiredGb = Math.max(16, candidateRequiredGb * 0.15),
): ProspectiveTrainingRamFit {
  const safetyModel = state.player.safetyCampaign
    ? state.player.models.find(
        (model) => model.id === state.player.safetyCampaign!.modelId,
      )
    : undefined;
  const requests = [
    ...playerTrainingJobs(state)
      .filter((job) => !job.paused && !job.failed)
      .map((job) => ({
        id: job.id,
        name: job.name,
        weight: job.computePriority ?? 50,
        requiredGb: jobTrainingRamGb(state, job),
        systemRamRequiredGb: jobTrainingSystemRamGb(state, job),
      })),
    ...(safetyModel
      ? [
          {
            id: "__safety_campaign__",
            name: `${safetyModel.name} safety`,
            weight: 50,
            requiredGb: modelTrainVramGb(
              safetyModel.paramsB,
              safetyModel.activeParamsB,
              safetyModel.family,
              safetyModel.trainingNumerics ?? LEGACY_TRAINING_NUMERICS,
              state.player.researchUnlocked.includes("opt_checkpoint"),
            ),
            systemRamRequiredGb: trainingMemoryForModel(state, safetyModel).requiredSystemRamGb,
          },
        ]
      : []),
    {
      id: "__candidate__",
      name: "New run",
      weight: Math.max(0, candidatePriority),
      requiredGb: Math.max(0, candidateRequiredGb),
      systemRamRequiredGb: Math.max(0, candidateSystemRamRequiredGb),
    },
  ];
  const trainingRamGb = trainingRamBudgetGb(state, snap);
  const allocations = allocateWeightedTrainingCompute(trainingRamGb, requests);
  const systemRamGb = snap.systemRamGb * trainingAllocationShare(state);
  const systemAllocations = allocateWeightedTrainingCompute(systemRamGb, requests);
  const hbmBlocker = requests.find(
    (request) =>
      (allocations[request.id]?.rawPf ?? 0) + 1e-9 < request.requiredGb,
  );
  const systemBlocker = requests.find(
    (request) =>
      (systemAllocations[request.id]?.rawPf ?? 0) + 1e-9 < request.systemRamRequiredGb,
  );
  const domainBlocker = requests.find(
    (request) =>
      !trainingMemoryDomainFit(
        state,
        snap,
        request.requiredGb,
        request.systemRamRequiredGb,
      ).ready,
  );
  const blocker = hbmBlocker ?? systemBlocker ?? domainBlocker;
  const domainFit = domainBlocker
    ? trainingMemoryDomainFit(
        state,
        snap,
        domainBlocker.requiredGb,
        domainBlocker.systemRamRequiredGb,
      )
    : undefined;
  return {
    ready: !hbmBlocker && !systemBlocker && !domainBlocker,
    trainingRamGb,
    candidateAllocatedGb: allocations.__candidate__?.rawPf ?? 0,
    candidateRequiredGb,
    blockerName: blocker?.name,
    blockerAllocatedGb: blocker
      ? (allocations[blocker.id]?.rawPf ?? 0)
      : undefined,
    blockerRequiredGb:
      hbmBlocker?.requiredGb ??
      systemBlocker?.systemRamRequiredGb ??
      (domainFit?.hbmReady
        ? domainBlocker?.systemRamRequiredGb
        : domainBlocker?.requiredGb),
    candidateSystemRamAllocatedGb: systemAllocations.__candidate__?.rawPf ?? 0,
    candidateSystemRamRequiredGb,
    blockerResource: hbmBlocker
      ? "HBM"
      : systemBlocker
        ? "system RAM"
        : domainBlocker
          ? domainFit?.hbmReady
            ? "system RAM"
            : "HBM"
          : undefined,
  };
}

/**
 * Divide both training PF and its reserved RAM with the same priority weights.
 * RAM is a hard gate; compatible compute is reallocated away from blocked jobs.
 */
export function playerTrainingResourcePlan(
  state: SimState,
  snap = computeSnapshot(state),
): PlayerTrainingResourcePlan {
  const jobs = playerTrainingJobs(state);
  const safetyModel = state.player.safetyCampaign
    ? state.player.models.find(
        (model) => model.id === state.player.safetyCampaign!.modelId,
      )
    : undefined;
  const requests = [
    ...jobs.map((job) => ({
      id: job.id,
      weight: job.computePriority ?? 50,
      eligible: !job.paused && !job.failed,
      numerics:
        job.trainingNumerics ?? job.numerics ?? LEGACY_TRAINING_NUMERICS,
      ramRequiredGb: jobTrainingRamGb(state, job),
      systemRamRequiredGb: jobTrainingSystemRamGb(state, job),
    })),
    ...(safetyModel
      ? [
          {
            id: "__safety_campaign__",
            weight: 50,
            eligible: true,
            numerics: safetyModel.trainingNumerics ?? LEGACY_TRAINING_NUMERICS,
            ramRequiredGb: modelTrainVramGb(
              safetyModel.paramsB,
              safetyModel.activeParamsB,
              safetyModel.family,
              safetyModel.trainingNumerics ?? LEGACY_TRAINING_NUMERICS,
              state.player.researchUnlocked.includes("opt_checkpoint"),
            ),
            systemRamRequiredGb: trainingMemoryForModel(state, safetyModel).requiredSystemRamGb,
          },
        ]
      : []),
  ];
  const trainingRamGb = trainingRamBudgetGb(state, snap);
  const ramAllocations = allocateWeightedTrainingCompute(
    trainingRamGb,
    requests,
  );
  const domainFits = Object.fromEntries(
    requests.map((request) => [
      request.id,
      trainingMemoryDomainFit(
        state,
        snap,
        request.ramRequiredGb,
        request.systemRamRequiredGb,
      ),
    ]),
  ) as Record<string, ReturnType<typeof trainingMemoryDomainFit>>;
  const ramReady = Object.fromEntries(
    requests.map((request) => [
      request.id,
      request.eligible !== false &&
        domainFits[request.id]!.hbmReady &&
        domainFits[request.id]!.ready &&
        (ramAllocations[request.id]?.rawPf ?? 0) + 1e-9 >=
          request.ramRequiredGb,
    ]),
  ) as Record<string, boolean>;
  const trainingSystemRamGb = snap.systemRamGb * trainingAllocationShare(state);
  const systemRamAllocations = allocateWeightedTrainingCompute(trainingSystemRamGb, requests);
  const systemRamReady = Object.fromEntries(
    requests.map((request) => [
      request.id,
      request.eligible !== false &&
        domainFits[request.id]!.systemRamReady &&
        domainFits[request.id]!.ready &&
        (systemRamAllocations[request.id]?.rawPf ?? 0) + 1e-9 >= request.systemRamRequiredGb,
    ]),
  ) as Record<string, boolean>;
  const computeAllocations = allocateTrainingHardwarePools(
    playerTrainingHardwarePools(state, snap.pools.training),
    requests.map((request) => ({
      id: request.id,
      weight: request.weight,
      eligible: request.eligible !== false && ramReady[request.id] && systemRamReady[request.id],
      numerics: request.numerics,
    })),
  );
  const allocationFor = (
    id: string,
    ramRequiredGb: number,
    systemRamRequiredGb: number,
  ): TrainingResourceAllocation => {
    const compute = computeAllocations[id];
    const ram = ramAllocations[id];
    const systemRam = systemRamAllocations[id];
    const hbmOk = ramReady[id] ?? false;
    const hostOk = systemRamReady[id] ?? false;
    return {
      rawPf: compute?.rawPf ?? 0,
      effectivePf: compute?.effectivePf ?? 0,
      computeShare: compute?.share ?? 0,
      ramAllocatedGb: ram?.rawPf ?? 0,
      ramRequiredGb,
      ramReady: ramReady[id] ?? false,
      systemRamAllocatedGb: systemRam?.rawPf ?? 0,
      systemRamRequiredGb,
      systemRamReady: hostOk,
      bottleneck: hbmOk ? (hostOk ? "none" : "system_ram") : (hostOk ? "hbm" : "both"),
    };
  };
  const safetyRequest = requests.find(
    (request) => request.id === "__safety_campaign__",
  );

  return {
    trainingRamGb,
    trainingSystemRamGb,
    trainingAllocationShare: trainingAllocationShare(state),
    jobs: Object.fromEntries(
      jobs.map((job) => {
        return [job.id, allocationFor(job.id, jobTrainingRamGb(state, job), jobTrainingSystemRamGb(state, job))];
      }),
    ),
    safetyCampaign: safetyRequest
      ? allocationFor(safetyRequest.id, safetyRequest.ramRequiredGb, safetyRequest.systemRamRequiredGb)
      : undefined,
  };
}

type TrainableStage = "base" | Exclude<PostTrainStage, "none">;

/**
 * Rare unrecoverable recipe failures. Routine hardware interruptions are
 * already absorbed by achieved utilization/checkpoint overhead and should not
 * destroy an otherwise healthy run.
 */
export function trainingStageFailurePlan(
  job: Pick<TrainingJob, "id" | "outcomeSeed" | "outcomeRisk">,
  stage: TrainableStage,
): { willFail: boolean; atFraction: number } {
  const rng = createRng(
    hashSeed(job.outcomeSeed ?? 0, job.id, stage, "stage-failure-v1"),
  );
  const baseRisk =
    job.outcomeRisk === "high"
      ? 0.1
      : job.outcomeRisk === "medium"
        ? 0.04
        : 0.015;
  const willFail = rng.next() < baseRisk * (stage === "base" ? 1 : 0.65);
  return { willFail, atFraction: 0.18 + rng.next() * 0.7 };
}

function estimateJobDailyThroughput(
  state: SimState,
  opts: {
    numerics: NonNullable<TrainingJob["trainingNumerics"]>;
    computePriority: number;
    reservedPf?: number;
    concurrentJobs: number;
  },
): number {
  const snap = computeSnapshot(state);
  const concurrent = Math.max(1, opts.concurrentJobs);
  const hardwarePools = playerTrainingHardwarePools(state, snap.pools.training);
  const allocations = allocateTrainingHardwarePools(hardwarePools, [
    {
      id: "__new_job__",
      weight: opts.computePriority,
      eligible: true,
      numerics: opts.numerics,
    },
    ...Array.from({ length: concurrent - 1 }, (_, index) => ({
      id: `__peer_${index}__`,
      weight: 50,
      eligible: true,
      numerics: DEFAULT_TRAINING_NUMERICS,
    })),
  ]);
  return Math.max(0, allocations.__new_job__?.effectivePf ?? 0);
}

/**
 * Observed training loss. The signal is intentionally less tidy than the
 * underlying learning curve: seeded jitter, two-sided spikes and short
 * divergence/recovery episodes sit on top of a long-run improving trend.
 * Deterministic per (job, stage, day) via seeded RNG — never Math.random.
 */
export function trainingLoss(
  job: Pick<TrainingJob, "id" | "outcomeSeed" | "targetParamsB"> &
    Partial<
      Pick<
        TrainingJob,
        | "trainingNumerics"
        | "numerics"
        | "dataPlan"
        | "dataQualityUsed"
        | "integratedMethods"
        | "outcomeRisk"
        | "effectiveDataRatio"
        | "repeatedDataEpochs"
      >
    >,
  stage: TrainableStage,
  progress: number,
  day: number,
  previousObservedLoss?: number,
): number {
  const precision = trainingNumericsEconomicsProfile(
    job.trainingNumerics ?? job.numerics ?? DEFAULT_TRAINING_NUMERICS,
  );
  const p = Math.max(0, Math.min(1, progress));

  const weights = Object.values(job.dataPlan?.weights ?? {}).filter(
    (weight): weight is number => Number.isFinite(weight) && weight > 0,
  );
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const diversity =
    weights.length <= 1 || weightTotal <= 0
      ? weights.length === 1
        ? 0
        : 0.65
      : -weights.reduce((entropy, weight) => {
          const share = weight / weightTotal;
          return entropy + share * Math.log(share);
        }, 0) / Math.log(weights.length);
  const quality = Math.max(
    0,
    Math.min(1, (job.dataQualityUsed ?? 70) / 100),
  );
  const repeatPressure = Math.max(0, (job.repeatedDataEpochs ?? 1) - 1);
  const dataRatio = job.effectiveDataRatio;
  const dataRatioRisk =
    dataRatio == null
      ? 0
      : Math.min(0.22, Math.max(0, 1 - dataRatio) * 0.18) +
        Math.min(0.18, Math.max(0, dataRatio - 8) * 0.018);
  const qualityGap = 0.7 - quality;
  const diversityGap = 0.65 - diversity;

  // This terminal band is derived from scale and the data recipe. Typical
  // jobs settle visibly in the high-threes/low-fours without a magic target.
  const baseBand =
    3.45 +
    Math.log10(Math.max(1, job.targetParamsB)) * 0.18 +
    qualityGap * 1.2 +
    diversityGap * 0.55 +
    Math.min(0.45, repeatPressure * 0.09);
  const baseStart =
    baseBand +
    5.15 +
    Math.log10(Math.max(1, job.targetParamsB)) * 0.28;
  const postStageAdjustment =
    stage === "rlhf" || stage === "process"
      ? -0.18
      : stage === "tools"
        ? 0.08
        : -0.08;
  const trend =
    stage === "base"
      ? baseBand +
        (baseStart - baseBand) * Math.exp(-3.7 * p - 0.8 * p * p) -
        0.12 * p
      : baseBand +
        postStageAdjustment -
        0.1 * p +
        (0.72 + baseBand * 0.08) * Math.exp(-7.5 * p);

  const stableOptimizationMethods = new Set([
    "opt_mixed",
    "opt_te_fp8",
    "opt_overlap_comm",
    "opt_grad_accum",
    "data_eval",
  ]);
  const stabilityResearch = (job.integratedMethods ?? []).filter((method) =>
    stableOptimizationMethods.has(method),
  ).length;
  const outcomeRisk =
    job.outcomeRisk === "high" ? 0.28 : job.outcomeRisk === "medium" ? 0.12 : 0;
  const volatility = Math.max(
    0.45,
    precision.lossVolatilityMultiplier *
      (1 +
        Math.max(0, qualityGap) * 0.55 +
        Math.max(0, 0.65 - diversity) * 0.45 +
        Math.max(0, diversity - 0.65) * 0.55 * Math.pow(1 - p, 1.5) +
        Math.min(0.35, repeatPressure * 0.07) +
        dataRatioRisk +
        Math.max(0, precision.stabilityRisk) +
        outcomeRisk) *
      Math.max(0.72, 1 - stabilityResearch * 0.055),
  );

  const rng = createRng(
    hashSeed(job.outcomeSeed ?? 0, job.id, stage, day, "loss-v3"),
  );
  const prev =
    previousObservedLoss == null || !Number.isFinite(previousObservedLoss)
      ? trend
      : previousObservedLoss;
  // Mean-revert toward today's trend; residual carries day-to-day wobble.
  const residual =
    (prev - trend) * 0.56 + rng.range(-0.032, 0.032) * volatility;
  let observed = trend + residual;

  // A block seed makes instability persist for several samples: the curve
  // first diverges, then recovers and can briefly undershoot its trend.
  const episodeLength = 9;
  const episodeIndex = Math.floor(day / episodeLength);
  const episodePhase = ((day % episodeLength) + episodeLength) % episodeLength;
  const episodeRng = createRng(
    hashSeed(
      job.outcomeSeed ?? 0,
      job.id,
      stage,
      episodeIndex,
      "loss-divergence-v1",
    ),
  );
  if (episodeRng.next() < Math.min(0.34, 0.1 * volatility)) {
    const amplitude = episodeRng.range(0.055, 0.14) * volatility;
    const episodeShape =
      episodePhase <= 3
        ? episodePhase / 3
        : episodePhase <= 6
          ? (6 - episodePhase) / 3
          : -(episodePhase - 6) / 6;
    observed *= 1 + amplitude * episodeShape;
  }

  // Optimizer shocks go both ways; negative spikes model lucky batches or a
  // recovered learning-rate step rather than forcing every wobble upward.
  if (rng.next() < Math.min(0.32, 0.16 * volatility)) {
    const direction = rng.next() < 0.58 ? 1 : -1;
    observed *= 1 + direction * rng.range(0.015, 0.055) * volatility;
  }
  const floor = baseBand * 0.82;
  return Math.max(floor, Math.round(observed * 1000) / 1000);
}

export function observedLoss(job: TrainingJob): number | null {
  const history = job.lossHistory ?? [];
  if (!history.length) return null;
  return history[history.length - 1]!.loss;
}

export const LOSS_PLATEAU_WINDOW = 6;
export const LOSS_PLATEAU_TOLERANCE = 0.04;

/**
 * Detect a flat recent loss curve without relying on wall-clock randomness.
 * A plateau needs a full same-stage window, little end-to-end improvement,
 * and no large excursion hidden inside that window.
 */
export function detectLossPlateau(
  job: Pick<TrainingJob, "lossHistory">,
  tolerance: number = LOSS_PLATEAU_TOLERANCE,
): boolean {
  const history = job.lossHistory ?? [];
  const stage = history.at(-1)?.stage;
  if (!stage) return false;
  const recent = history
    .filter((point) => point.stage === stage && Number.isFinite(point.loss))
    .slice(-LOSS_PLATEAU_WINDOW);
  if (recent.length < LOSS_PLATEAU_WINDOW) return false;
  const losses = recent.map((point) => point.loss);
  const improvement = losses[0]! - losses.at(-1)!;
  const excursion = Math.max(...losses) - Math.min(...losses);
  const allowed = Math.max(0, tolerance);
  return Math.abs(improvement) <= allowed && excursion <= allowed * 2.5;
}

export function trainingMinimumStatus(job: TrainingJob): {
  ok: boolean;
  reason?: string;
  computeReady: boolean;
  calendarReady: boolean;
  completeReady: boolean;
  plateaued: boolean;
  earlyReleaseReady: boolean;
} {
  if (job.failed)
    return {
      ok: false,
      reason: "This run failed and cannot be released.",
      computeReady: false,
      calendarReady: false,
      completeReady: false,
      plateaued: false,
      earlyReleaseReady: false,
    };
  const computeReady = job.progressPfDays + 1e-9 >= job.targetPfDays;
  const calendarRemaining = Math.max(
    0,
    (job.minCalendarDays ?? 0) - (job.daysElapsed ?? 0),
  );
  const calendarReady = calendarRemaining <= 0;
  const plateaued = detectLossPlateau(job);
  const completeReady = computeReady && calendarReady;
  const earlyReleaseReady = !computeReady && calendarReady && plateaued;
  if (calendarRemaining > 0) {
    return {
      ok: false,
      reason: `${calendarRemaining} funded active calendar day${calendarRemaining === 1 ? "" : "s"} remain for integration and validation.`,
      computeReady,
      calendarReady,
      completeReady,
      plateaued,
      earlyReleaseReady,
    };
  }
  if (!computeReady) {
    return {
      ok: false,
      reason: plateaued
        ? "Loss has plateaued; this checkpoint is eligible for a degraded early release."
        : "Complete the training compute target or wait for a sustained loss plateau.",
      computeReady,
      calendarReady,
      completeReady,
      plateaued,
      earlyReleaseReady,
    };
  }
  return {
    ok: true,
    computeReady,
    calendarReady,
    completeReady,
    plateaued,
    earlyReleaseReady,
  };
}

export function canReleaseTrainingJob(job: TrainingJob): {
  ok: boolean;
  reason?: string;
  releaseKind?: "complete" | "early";
} {
  const status = trainingMinimumStatus(job);
  if (status.completeReady) return { ok: true, releaseKind: "complete" };
  if (status.earlyReleaseReady) return { ok: true, releaseKind: "early" };
  return { ok: false, reason: status.reason };
}

export function earlyReleasePenalty(
  job: Pick<TrainingJob, "progressPfDays" | "targetPfDays">,
): {
  progress: number;
  capabilityMultiplier: number;
  benchmarkMultiplier: number;
  reliabilityMultiplier: number;
} {
  const progress = Math.max(
    0,
    Math.min(1, job.progressPfDays / Math.max(job.targetPfDays, 1e-9)),
  );
  const maturity = Math.sqrt(progress);
  return {
    progress,
    capabilityMultiplier: 0.45 + maturity * 0.55,
    benchmarkMultiplier: 0.35 + maturity * 0.65,
    reliabilityMultiplier: 0.3 + maturity * 0.7,
  };
}

export function extendTraining(
  state: SimState,
  jobId: string,
  days: number = TRAINING_EXTENSION_DAYS,
): SimState {
  const jobs = playerTrainingJobs(state);
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (!job || job.failed) return state;
  const recommended = job.recommendedPfDays ?? job.targetPfDays;
  if (job.progressPfDays + 1e-9 < recommended && !job.awaitingDecision) {
    return withAlert(
      state,
      "warn",
      "Reach the recommended compute target before extending.",
    );
  }
  const daily = estimateJobDailyThroughput(state, {
    numerics: job.trainingNumerics ?? job.numerics ?? DEFAULT_TRAINING_NUMERICS,
    computePriority: job.computePriority ?? 50,
    reservedPf: job.reservedPf ?? 0,
    concurrentJobs: Math.max(
      1,
      jobs.filter((candidate) => !candidate.paused && !candidate.failed).length,
    ),
  });
  const addPf = Math.max(daily, 1e-6) * Math.max(1, days);
  const updated: TrainingJob = {
    ...job,
    targetPfDays: Math.max(job.targetPfDays, recommended) + addPf,
    extensionDays: (job.extensionDays ?? 0) + Math.max(1, days),
    awaitingDecision: false,
    paused: false,
    stallReason: null,
  };
  return withAlert(
    withTrainingJobs(
      state,
      jobs.map((candidate) => (candidate.id === job.id ? updated : candidate)),
    ),
    "info",
    `${job.name} extended by ${Math.max(1, days)} days (+${addPf.toFixed(2)} PF-days).`,
  );
}

export function appendLossPoint(
  job: TrainingJob,
  stage: TrainableStage,
  progress: number,
  day: number,
): TrainingJob["lossHistory"] {
  const history = job.lossHistory ?? [];
  const previous = [...history]
    .reverse()
    .find((point) => point.stage === stage)?.loss;
  const next = [
    ...history,
    {
      day,
      stage,
      progress,
      loss: trainingLoss(job, stage, progress, day, previous),
    },
  ];
  return next.slice(-64);
}

function failedAtCrossing(
  job: TrainingJob,
  stage: TrainableStage,
  previous: number,
  next: number,
  target: number,
): boolean {
  if (job.failed || target <= 0) return false;
  const plan = trainingStageFailurePlan(job, stage);
  const failureAt = target * plan.atFraction;
  return plan.willFail && previous < failureAt && next >= failureAt;
}

function failTrainingJob(
  job: TrainingJob,
  stage: TrainableStage,
  day: number,
): TrainingJob {
  return {
    ...job,
    failed: true,
    failureStage: stage,
    failureDay: day,
    failureReason:
      stage === "base"
        ? "Loss diverged during base training. This checkpoint is unrecoverable."
        : `The ${stage.toUpperCase()} stage destabilized the checkpoint. This run is unrecoverable.`,
    paused: true,
    stallReason: "Training failed — delete this run.",
  };
}

/**
 * Hard per-domain cap (MTok) for training-data radar drags. Without synthetic
 * expansion the drag stops at the owned real corpus; with expansion the recipe
 * may oversubscribe real stock with generated tokens, hard-capped at 8× the
 * domain's real + synthetic (e.g. distill teacher) base.
 */
export function trainingDataDomainCapMTok(
  realAvailableMTok: number,
  syntheticAvailableMTok: number,
  syntheticMultiplier: number,
): number {
  const real = Math.max(0, realAvailableMTok);
  if (!(syntheticMultiplier > 0)) return real;
  const base = real + Math.max(0, syntheticAvailableMTok);
  return Math.min(base * (1 + syntheticMultiplier), base * 8);
}

/**
 * Distill: the selected teacher doubles as the synthetic generator, so the
 * recipe may oversubscribe the owned corpus even without Synthetic Generators
 * research. Top up per-domain shortfalls with teacher-generated tokens (bounded
 * by the shared radar cap against the teacher's corpus headroom) and record
 * provenance so finalize's syntheticTrainingProfile math keys off the teacher.
 */
function fillDistillTeacherSynthetic(
  consume: ConsumeResult,
  opts: {
    teacher: Model;
    labData: LabData;
    weights: Record<DataDomain, number>;
    requestedTotalMTok: number;
    syntheticMultiplier: number;
    frontierCapability: number;
    paramsB: number;
  },
): ConsumeResult {
  const { teacher } = opts;
  const multiplier = Math.max(0, opts.syntheticMultiplier);
  if (multiplier <= 0) return consume;
  const headroom = teacherSyntheticHeadroomMTok({
    teacher,
    frontierCapability: opts.frontierCapability,
  });
  const quality = Math.min(92, 48 + teacher.capability * 0.55);
  const qualityTier = quality >= 58 ? ("hq" as const) : ("lq" as const);
  const consumed = { ...consume.consumed };
  const domainQuality = { ...consume.domainQuality };
  const lowQualityShareByDomain = { ...consume.lowQualityShareByDomain };
  const provenance: SyntheticFillRecord[] = [];
  for (const domain of DATA_DOMAINS) {
    const want = Math.max(0, opts.requestedTotalMTok * opts.weights[domain]);
    const prior = consumed[domain] ?? 0;
    const short = want - prior;
    if (short <= 0.01) continue;
    const stock = normalizeDomainStock(opts.labData.stocks[domain]);
    const realAvailable = Math.max(
      0,
      stock.processed - stock.fromSynthHQ - stock.fromSynthLQ,
    );
    const cap = trainingDataDomainCapMTok(
      realAvailable,
      headroom[domain],
      multiplier,
    );
    const fill = Math.min(short, Math.max(0, cap - prior));
    if (fill <= 0.01) continue;
    consumed[domain] = prior + fill;
    domainQuality[domain] =
      ((domainQuality[domain] ?? consume.qualityUsed) * prior +
        quality * fill) /
      Math.max(0.01, prior + fill);
    lowQualityShareByDomain[domain] =
      qualityTier === "lq" ? fill / Math.max(0.01, prior + fill) : 0;
    provenance.push({
      domain,
      teacherModelId: teacher.id,
      teacherName: teacher.name,
      volumeMTok: fill,
      quality,
      qualityTier,
    });
  }
  if (!provenance.length) return consume;
  const actualVolume = Object.values(consumed).reduce(
    (sum, value) => sum + (value ?? 0),
    0,
  );
  let qualityAcc = 0;
  for (const domain of DATA_DOMAINS) {
    const volume = consumed[domain] ?? 0;
    if (volume > 0) {
      qualityAcc += (domainQuality[domain] ?? consume.qualityUsed) * volume;
    }
  }
  const trainShare = consume.plan.trainShare;
  const teacherSynthMTok = provenance.reduce(
    (sum, record) => sum + record.volumeMTok,
    0,
  );
  const synthHqUnits =
    (consume.synthHqUnits ?? 0) +
    (qualityTier === "hq" ? teacherSynthMTok : 0);
  const synthLqUnits =
    (consume.synthLqUnits ?? 0) +
    (qualityTier === "lq" ? teacherSynthMTok : 0);
  const syntheticProvenance = [
    ...(consume.syntheticProvenance ?? []),
    ...provenance,
  ];
  return {
    ...consume,
    plan: {
      ...consume.plan,
      totalMTok: actualVolume,
      totalUnits: actualVolume,
      syntheticProvenance,
    },
    consumed,
    coverage: Math.min(
      30,
      actualVolume / Math.max(1, minDataMTokForParams(opts.paramsB)),
    ),
    qualityUsed:
      actualVolume > 0 ? qualityAcc / actualVolume : consume.qualityUsed,
    syntheticUnits: consume.syntheticUnits + teacherSynthMTok,
    synthHqUnits,
    synthLqUnits,
    synthLqShare: actualVolume > 0 ? synthLqUnits / actualVolume : 0,
    cashCost: consume.cashCost + teacherSynthMTok * 250,
    trainMTok: actualVolume * trainShare,
    verifyMTok: actualVolume * (1 - trainShare),
    domainQuality,
    lowQualityShareByDomain,
    syntheticProvenance,
  };
}

export function estimateTrainingCost(
  state: SimState,
  opts: Pick<
    StartTrainingOpts,
    "paramsB" | "family" | "backbone" | "activeParamsB" | "mode" | "teacherId"
  >,
): number {
  const teacher = opts.teacherId
    ? state.player.models.find((m) => m.id === opts.teacherId)
    : undefined;
  const mode = opts.mode === "distill" ? "distill" : "pretrain";
  return trainCostPfDays({
    paramsB: opts.paramsB,
    family: opts.family,
    backbone: opts.backbone,
    trainEfficiency: state.player.trainEfficiency,
    activeParamsB: opts.activeParamsB,
    mode,
    teacherParamsB: teacher?.paramsB,
  });
}

export function startTraining(
  state: SimState,
  opts: StartTrainingOpts,
): SimState {
  const existingJobs = playerTrainingJobs(state);
  let numerics = opts.trainingNumerics ?? DEFAULT_TRAINING_NUMERICS;

  const mode = opts.mode ?? "pretrain";
  const dataMix: DataMix = opts.dataMix ?? "web";
  let family = opts.family;
  let backbone = opts.backbone ?? backboneFromFamily(family);
  let productPreset = opts.productPreset ?? presetFromFamily(family);
  let io = opts.io ?? ioForPreset(productPreset);
  let paramsB = opts.paramsB;
  let activeParamsB = opts.activeParamsB;
  let continueFromId: string | undefined;
  let baseContinueCap = 0;

  if (mode === "continue") {
    if (!opts.continueFromId) {
      return withAlert(state, "warn", "Pick a model to continue training.");
    }
    const base = state.player.models.find((m) => m.id === opts.continueFromId);
    if (!base) return withAlert(state, "warn", "Base model not found.");
    family = base.family;
    backbone = base.backbone ?? backboneFromFamily(base.family);
    productPreset = base.productPreset ?? presetFromFamily(base.family);
    io = base.io ?? ioForPreset(productPreset, base.capability);
    paramsB = base.paramsB;
    activeParamsB = base.activeParamsB;
    continueFromId = base.id;
    numerics =
      opts.trainingNumerics ??
      base.trainingNumerics ??
      DEFAULT_TRAINING_NUMERICS;
    if (
      existingJobs.some((candidate) => candidate.continueFromId === base.id)
    ) {
      return withAlert(
        state,
        "warn",
        `${base.name} already has a continuation run in progress.`,
      );
    }
    baseContinueCap = base.capability;
  }

  const numericsCheck = validateTrainingNumerics({
    hardwareGeneration: playerTrainingHardwareGeneration(
      state,
      numerics.computeFormat,
    ),
    numerics,
    researchUnlocked: state.player.researchUnlocked,
    family,
    enforceResearch: !(mode === "continue" && opts.trainingNumerics == null),
  });
  if (!numericsCheck.ok) return withAlert(state, "warn", numericsCheck.reason);

  const modelStack = sanitizeModelStack(
    opts.modelStack ?? [],
    state.player.researchUnlocked,
    family,
  );
  const stackModifiers = modelStackModifiers(modelStack, family);

  if (
    family === "diffusion" &&
    !state.player.researchUnlocked.includes("mm_diff")
  ) {
    return withAlert(state, "warn", "Unlock Latent Diffusion first.");
  }
  if (
    family === "video" &&
    !state.player.researchUnlocked.includes("mm_video")
  ) {
    return withAlert(state, "warn", "Unlock Video Temporal Models first.");
  }
  if (family === "omni" && !state.player.researchUnlocked.includes("mm_omni")) {
    return withAlert(state, "warn", "Unlock Omni Stack first.");
  }
  if (
    (productPreset === "vision_language" || productPreset === "audio") &&
    !state.player.researchUnlocked.includes("mm_vision")
  ) {
    return withAlert(
      state,
      "warn",
      "Unlock Vision Encoders before adding image or audio I/O.",
    );
  }

  if (mode !== "continue") {
    const gate = sizeGate(paramsB, family, state.player.researchUnlocked);
    if (!gate.ok)
      return withAlert(state, "warn", gate.reason ?? "Invalid size.");
  }

  // Dense is free at game start; other families need research unlocks
  // Family unlocks only (not size tiers) — size is free, limited by compute/time
  if (
    backbone === "moe" &&
    !state.player.researchUnlocked.includes("moe_basics")
  ) {
    return withAlert(
      state,
      "warn",
      "Unlock Sparse Basics before MoE training.",
    );
  }
  if (
    family === "dense" &&
    !state.player.researchUnlocked.includes("dense_basics")
  ) {
    // Should not happen — dense_basics is starter unlock; allow train anyway
  }

  if (backbone === "moe" && mode !== "continue") {
    if (activeParamsB == null || activeParamsB <= 0) {
      return withAlert(
        state,
        "warn",
        "MoE needs active parameters (e.g. 8B active of 120B total).",
      );
    }
    if (activeParamsB > paramsB) {
      return withAlert(
        state,
        "warn",
        "Active params cannot exceed total MoE size.",
      );
    }
    if (activeParamsB < paramsB * 0.02) {
      return withAlert(
        state,
        "warn",
        "Active fraction too small (<2%). Raise active params.",
      );
    }
  } else if (backbone !== "moe") {
    activeParamsB = undefined;
  }

  let teacherId: string | undefined;
  /** Distill: share of signal from teacher (rest = your processed corpus). */
  let distillTeacherShare = 0;
  if (mode === "distill") {
    if (!opts.teacherId) {
      return withAlert(state, "warn", "Pick a teacher model for distillation.");
    }
    const teacher = state.player.models.find((m) => m.id === opts.teacherId);
    if (!teacher) return withAlert(state, "warn", "Teacher model not found.");
    if (paramsB > teacher.paramsB * 1.15) {
      return withAlert(
        state,
        "warn",
        "Student should not greatly exceed teacher size. Use a larger teacher or smaller student.",
      );
    }
    teacherId = teacher.id;
    distillTeacherShare = clampDistillTeacherShare(opts.distillTeacherShare);
  }

  let target = 0;

  // Consume processed corpus according to player's domain mix + volume.
  // Distill: only the *own-corpus* share is drawn from stocks; teacher signal is free.
  const selfDataShare = mode === "distill" ? 1 - distillTeacherShare : 1;
  const mixUnlocked = state.player.researchUnlocked.includes("data_mix");
  const specialistsUnlocked =
    state.player.researchUnlocked.includes("data_specialists") ||
    !!aggregateEffects(state.player.researchUnlocked).unlockCorpusSpecialists;
  const minMTok = minDataMTokForParams(paramsB);
  const continueBaseModel =
    mode === "continue" && continueFromId
      ? state.player.models.find((m) => m.id === continueFromId)
      : undefined;
  const priorDataMTok = continueBaseModel?.dataTokensUsedMTok ?? 0;
  const priorWatermark =
    continueBaseModel?.dataWatermarkMTok ?? priorDataMTok ?? 0;
  const newSince = newDataSinceModel(state, continueBaseModel);

  const rawPlanTotal =
    opts.dataPlan?.totalMTok ??
    opts.dataPlan?.totalUnits ??
    (mode === "continue"
      ? Math.max(1, newSince) // continue defaults to new data only
      : recommendedDataMTok(paramsB, family));

  // Volume is player-chosen (MTok). Pretrain reuses full corpus; continue uses new delta.
  const volumeMTok = Math.max(
    1,
    rawPlanTotal * (mode === "distill" ? Math.max(0.15, selfDataShare) : 1),
  );
  void minMTok;

  const dataPlan: TrainingDataPlan = {
    totalUnits: volumeMTok,
    totalMTok: volumeMTok,
    trainShare:
      opts.dataPlan?.trainShare ?? (mode === "continue" ? 0.88 : 0.82),
    weights: mixUnlocked ? (opts.dataPlan?.weights ?? {}) : {},
    allowSynthetic: opts.dataPlan?.allowSynthetic ?? true,
    includeSynthHQ: opts.dataPlan?.includeSynthHQ ?? true,
    includeSynthLQ: opts.dataPlan?.includeSynthLQ ?? false,
    syntheticTeacherIds: opts.dataPlan?.syntheticTeacherIds,
    syntheticMultiplier: opts.dataPlan?.syntheticMultiplier,
    domainModels: specialistsUnlocked ? opts.dataPlan?.domainModels : undefined,
    syntheticTeacherIds: opts.dataPlan?.syntheticTeacherIds
      ? { ...opts.dataPlan.syntheticTeacherIds }
      : undefined,
    syntheticMultiplier: opts.dataPlan?.syntheticMultiplier,
  };
  let consume = consumeForTraining(
    state,
    dataPlan,
    paramsB,
    family,
    dataMix,
    {
      mode:
        mode === "continue"
          ? "continue"
          : mode === "distill"
            ? "distill"
            : "pretrain",
      priorWatermarkMTok: mode === "continue" ? priorWatermark : undefined,
    },
  );
  if (!consume.ok) {
    return withAlert(
      state,
      "warn",
      consume.reason ?? "Insufficient training data.",
    );
  }

  const planWeights = normalizeWeights(consume.plan.weights);
  if (mode === "distill" && teacherId && dataPlan.allowSynthetic) {
    const teacher = state.player.models.find((m) => m.id === teacherId);
    if (teacher) {
      consume = fillDistillTeacherSynthetic(consume, {
        teacher,
        labData: ensureLabData(state),
        weights: planWeights,
        requestedTotalMTok: volumeMTok,
        syntheticMultiplier: dataPlan.syntheticMultiplier ?? 0,
        frontierCapability: Math.max(
          teacher.capability,
          ...state.player.models
            .filter((model) => model.release === "released" || model.shipped)
            .map((model) => model.capability),
          ...state.rivals.flatMap((rival) =>
            rival.models
              .filter((model) => model.release === "released" || model.shipped)
              .map((model) => model.capability),
          ),
        ),
        paramsB,
      });
    }
  }
  // Multimodal families need matching data
  if (family === "diffusion" && planWeights.image < 0.15) {
    return withAlert(
      state,
      "warn",
      "Diffusion trains need ≥15% image data in the mix.",
    );
  }
  if (family === "video" && planWeights.video < 0.2) {
    return withAlert(
      state,
      "warn",
      "Video models need ≥20% video data in the mix.",
    );
  }
  if (productPreset === "vision_language" && planWeights.image < 0.1) {
    return withAlert(
      state,
      "warn",
      "Vision-language models need ≥10% image data in the mix.",
    );
  }
  if (productPreset === "audio" && planWeights.audio < 0.1) {
    return withAlert(
      state,
      "warn",
      "Audio models need ≥10% audio data in the mix.",
    );
  }
  if (
    productPreset === "omni" &&
    (planWeights.image < 0.08 ||
      planWeights.audio < 0.08 ||
      planWeights.video < 0.08)
  ) {
    return withAlert(
      state,
      "warn",
      "Omni training needs at least 8% each of image, audio, and video data.",
    );
  }

  const dataAnalysis = analyzeTrainingData({
    paramsB,
    family,
    backbone,
    productPreset,
    io,
    plan: { ...consume.plan, weights: planWeights },
    data: ensureLabData(state),
    actualMTok: consume.trainMTok + consume.verifyMTok,
    quality: consume.qualityUsed,
    lqShare: consume.synthLqShare,
  });
  // Formula v2 charges the actual train tokens at C≈6ND. Held-out verification
  // is forward-only (≈2ND), so data quality changes outcomes rather than making
  // physical work disappear. The earlier estimate only exists for preflight UI.
  const trainingEconomics = estimateTrainingEconomics({
    paramsB,
    family,
    backbone,
    trainEfficiency: state.player.trainEfficiency,
    activeParamsB,
    mode,
    teacherParamsB: teacherId
      ? state.player.models.find((model) => model.id === teacherId)?.paramsB
      : undefined,
    distillTeacherShare,
    trainingTokensMTok: consume.trainMTok,
    verificationTokensMTok: consume.verifyMTok,
    modalityComputeMult: dataAnalysis.modalityComputeMult,
    trainCostMult: stackModifiers.trainCostMult,
    dataCost: consume.cashCost,
    numerics,
  });
  target = trainingEconomics.targetPfDays;

  const needVram = modelTrainVramGb(
    paramsB,
    activeParamsB,
    backbone === "moe" ? "moe" : family,
    numerics,
    state.player.researchUnlocked.includes("opt_checkpoint"),
  );
  const requiredSystemRam = estimateTrainingMemoryGb({
    paramsB,
    activeParamsB,
    family: backbone === "moe" ? "moe" : family,
    numerics,
    activationCheckpointing: state.player.researchUnlocked.includes("opt_checkpoint"),
  }).requiredSystemRamGb;
  const placement = computeSnapshot(state);
  const haveVram = placement.vramGb;
  const trainingRam = trainingRamBudgetGb(state, placement);
  const computePriority = Math.max(
    10,
    Math.min(100, opts.computePriority ?? 50),
  );
  const ramFit = trainingRamFitForNewJob(
    state,
    needVram,
    computePriority,
    placement,
    requiredSystemRam,
  );
  if (!ramFit.ready) {
    return withAlert(
      state,
      "warn",
      `Training RAM is a hard limit (${ramFit.blockerResource ?? "memory"}): ${ramFit.blockerName ?? "New run"} needs ${(ramFit.blockerRequiredGb ?? needVram).toFixed(0)} GB after splitting the ${Math.round(trainingAllocationShare(state) * 100)}% Training allocation. Add memory, raise Training allocation, pause another run, or change priorities.`,
    );
  }

  const reservedPf = Math.max(0, opts.reservedPf ?? 0);
  const initialEffectivePf = estimateJobDailyThroughput(state, {
    numerics,
    computePriority,
    reservedPf,
    concurrentJobs:
      existingJobs.filter((candidate) => !candidate.paused && !candidate.failed)
        .length + 1,
  });

  // Even tiny runs incur cluster setup, checkpointing, orchestration and eval
  // overhead. Preserve physical PF scaling while preventing zero-cost jobs.
  const { setupCost, dataCost, cashBurnPerDay, upfrontCash: cashSunk } =
    trainingEconomics;
  if (state.player.cash < cashSunk) {
    return withAlert(
      state,
      "warn",
      `Need $${(cashSunk / 1e6).toFixed(1)}M upfront (cluster + synthetic fill).`,
    );
  }
  const recommendedPfDays = target;

  const jobId = seededId(
    "job",
    state.seed,
    state.day,
    state.player.models.length,
    opts.name,
    family,
  );
  const manifestSnapshot = createDataManifest({
    data: consume.nextData,
    consumed: consume.consumed,
    totalMTok: consume.trainMTok + consume.verifyMTok,
    day: state.day,
    seed: state.seed,
    runId: jobId,
  });
  const job: TrainingJob = {
    id: jobId,
    name: opts.name,
    family,
    backbone,
    productPreset,
    io,
    targetParamsB: paramsB,
    activeParamsB,
    targetPfDays: target,
    progressPfDays: 0,
    energyMwDays: 0,
    energyMWh: 0,
    daysRemaining: Math.max(
      initialEffectivePf > 1e-9
        ? target / initialEffectivePf
        : Number.POSITIVE_INFINITY,
      trainingEconomics.minCalendarDays,
    ),
    minCalendarDays: trainingEconomics.minCalendarDays,
    daysElapsed: 0,
    postTrain: "none",
    postTrainProgress: 0,
    postTrainTarget: 0,
    completedPostTrainStages: continueFromId
      ? [
          ...(state.player.models.find((model) => model.id === continueFromId)
            ?.completedPostTrainStages ?? []),
        ]
      : [],
    postTrainStageEffectiveness: continueFromId
      ? {
          ...(state.player.models.find((model) => model.id === continueFromId)
            ?.postTrainStageEffectiveness ?? {}),
        }
      : {},
    postTrainDaysElapsed: 0,
    mode,
    teacherId,
    distillTeacherShare: mode === "distill" ? distillTeacherShare : undefined,
    continueFromId,
    dataMix,
    dataPlan: {
      ...consume.plan,
      weights: planWeights,
      syntheticMultiplier: dataPlan.syntheticMultiplier,
      uniqueMTok: dataAnalysis.uniqueMTok,
      repeatedMTok: dataAnalysis.repeatedMTok,
    },
    dataConsumed: consume.consumed,
    dataCoverage: consume.coverage,
    dataQualityUsed: consume.qualityUsed,
    syntheticUnits: consume.syntheticUnits,
    synthLqShare: consume.synthLqShare ?? 0,
    trainShare: consume.plan.trainShare,
    trainMTok: consume.trainMTok,
    verifyMTok: consume.verifyMTok,
    priorDataMTok,
    cashBurnPerDay,
    cashSunk,
    recommendedPfDays,
    extensionDays: 0,
    awaitingDecision: false,
    economics: {
      setupCost,
      dataCost,
      trainingCostAccrued: 0,
    },
    benchmarkSnapshots: [],
    lastBenchmarkDay: undefined,
    outcomeSeed: hashSeed(
      state.seed,
      state.day,
      opts.name,
      paramsB,
      family,
      "train-outcome",
    ),
    outcomeRisk: dataAnalysis.risk,
    effectiveDataRatio: dataAnalysis.effectiveDataRatio,
    repeatedDataEpochs: dataAnalysis.repeatedEpochs,
    modalityComputeMult: dataAnalysis.modalityComputeMult,
    dataManifestId: manifestSnapshot.manifest.id,
    integratedMethods: [...state.player.researchUnlocked].sort(),
    modelStack,
    dataQualityByDomain: consume.domainQuality,
    lowQualityShareByDomain: consume.lowQualityShareByDomain,
    syntheticProvenance: consume.syntheticProvenance,
    trainingFormulaVersion: 2,
    trainingNumerics: numerics,
    computePriority,
    reservedPf,
    minimumDevices: Math.max(1, Math.ceil(needVram / 80)),
    preemptible: true,
    failed: false,
    lossHistory: [
      {
        day: state.day,
        stage: "base",
        progress: 0,
        loss: trainingLoss(
          {
            id: jobId,
            outcomeSeed: hashSeed(
              state.seed,
              state.day,
              opts.name,
              paramsB,
              family,
              "train-outcome",
            ),
            targetParamsB: paramsB,
            trainingNumerics: numerics,
          },
          "base",
          0,
          state.day,
        ),
      },
    ],
  };

  void baseContinueCap;

  const sizeLabel =
    backbone === "moe"
      ? `${formatParams(paramsB)} total / ${formatParams(activeParamsB ?? 0)} active`
      : formatParams(paramsB);

  const vramNote = ` · training RAM ${needVram.toFixed(0)}/${trainingRam.toFixed(0)} GB allocated`;

  const modeLabel =
    mode === "distill"
      ? "Distillation"
      : mode === "continue"
        ? "Continue-train"
        : "Training";

  const mixLabel = formatMix(consume.plan.weights);
  const synthNote =
    consume.syntheticUnits > 0.5
      ? ` · +${formatTokens(consume.syntheticUnits)} synth fill`
      : "";
  const dataNote = ` · ${formatTokens(consume.trainMTok + consume.verifyMTok)} data (train ${Math.round(consume.plan.trainShare * 100)}%/verify ${Math.round((1 - consume.plan.trainShare) * 100)}%)`;

  return {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash - cashSunk,
      data: manifestSnapshot.data,
      trainingJobs: [...existingJobs, job],
      trainingJob: existingJobs[0] ?? job,
    },
    alerts: [
      {
        id: `train-start-${job.id}`,
        day: state.day,
        severity: haveVram < needVram ? ("warn" as const) : ("info" as const),
        message: `${modeLabel}: ${opts.name} (${sizeLabel}${
          mode === "distill"
            ? `, teacher ${Math.round(distillTeacherShare * 100)}% / own ${Math.round((1 - distillTeacherShare) * 100)}%`
            : ""
        }${
          mode === "continue" && priorDataMTok > 0
            ? `, prior ${formatTokens(priorDataMTok)}`
            : ""
        }${dataNote} [${mixLabel}] Q${consume.qualityUsed.toFixed(0)}, ~${target.toFixed(0)} PF-d, $${(cashSunk / 1e6).toFixed(1)}M)${synthNote}${vramNote}`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

function withAlert(
  state: SimState,
  severity: "info" | "warn" | "danger",
  message: string,
): SimState {
  return {
    ...state,
    alerts: [
      {
        id: `a-${state.day}-${message.slice(0, 16)}`,
        day: state.day,
        severity,
        message,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

export function advancePostTrain(state: SimState, jobId?: string): SimState {
  const jobs = playerTrainingJobs(state);
  const job = jobId
    ? jobs.find((candidate) => candidate.id === jobId)
    : jobs[0];
  if (!job) return state;
  const idx = POST_TRAIN_ORDER.indexOf(job.postTrain);
  if (idx < 0 || idx >= POST_TRAIN_ORDER.length - 1) return state;
  if (!trainingMinimumStatus(job).ok) return state;
  if (job.postTrain !== "none" && job.postTrainProgress < job.postTrainTarget)
    return state;

  const nextStage = POST_TRAIN_ORDER[idx + 1]!;
  if (
    nextStage === "rlhf" &&
    !state.player.researchUnlocked.includes("align_rlhf")
  ) {
    return withAlert(
      state,
      "warn",
      "Unlock RLHF Pipeline for preference training.",
    );
  }
  if (
    nextStage === "process" &&
    !state.player.researchUnlocked.includes("align_process")
  ) {
    return withAlert(state, "warn", "Unlock Process Reward Models first.");
  }

  return selectPostTrain(
    state,
    job.id,
    nextStage as Exclude<PostTrainStage, "none">,
  );
}

/** Start a specific researched post-training stage from a completed checkpoint. */
export function selectPostTrain(
  state: SimState,
  jobId: string,
  nextStage: Exclude<PostTrainStage, "none">,
): SimState {
  const jobs = playerTrainingJobs(state);
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (!job || !trainingMinimumStatus(job).ok) return state;
  if (completedPostTrainStages(job).includes(nextStage)) {
    return withAlert(
      state,
      "warn",
      `${nextStage.toUpperCase()} has already been applied to this model lineage. Post-training stages are one-shot.`,
    );
  }
  if (job.postTrain !== "none" && job.postTrainProgress < job.postTrainTarget) {
    return withAlert(
      state,
      "warn",
      "Finish or cancel the current post-training stage first.",
    );
  }
  if (
    nextStage === "rlhf" &&
    !state.player.researchUnlocked.includes("align_rlhf")
  ) {
    return withAlert(
      state,
      "warn",
      "Unlock RLHF Pipeline for preference training.",
    );
  }
  if (
    nextStage === "process" &&
    !state.player.researchUnlocked.includes("align_process")
  ) {
    return withAlert(state, "warn", "Unlock Process Reward Models first.");
  }
  const updated: TrainingJob = {
    ...job,
    postTrain: nextStage,
    postTrainProgress: 0,
    postTrainTarget: postTrainTargetPfDays(job, nextStage),
    postTrainDaysElapsed: 0,
    paused: false,
    stallReason: null,
  };
  return withTrainingJobs(
    state,
    jobs.map((candidate) => (candidate.id === job.id ? updated : candidate)),
  );
}

/** Cancel an unfinished or failed run. Upfront costs and consumed data remain spent. */
export function cancelTraining(state: SimState, jobId: string): SimState {
  const jobs = playerTrainingJobs(state);
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (!job) return state;
  return withAlert(
    withTrainingJobs(
      state,
      jobs.filter((candidate) => candidate.id !== jobId),
    ),
    job.failed ? "info" : "warn",
    job.failed
      ? `Deleted failed ${job.name} run.`
      : `Cancelled ${job.name}. Consumed data and $${(job.cashSunk / 1e6).toFixed(2)}M upfront cost were not recovered.`,
  );
}

/** Finish job → internal (private) model. Not on the market until released. */
export function keepInternal(state: SimState, jobId?: string): SimState {
  return finalizeJob(state, "internal", jobId);
}

/** Finish job and release publicly (plans/API eligible). */
export function releaseFromJob(state: SimState, jobId?: string): SimState {
  return finalizeJob(state, "released", jobId, true);
}

/** Stop a plateaued run after its calendar gate and release its current checkpoint. */
export function releaseTrainingEarly(state: SimState, jobId: string): SimState {
  return finalizeJob(state, "released", jobId, true);
}

/** Cheat surface: finish compute and post-training while preserving the release decision. */
export function completeTrainingJobsNow(state: SimState): SimState {
  const jobs = playerTrainingJobs(state);
  const active = jobs.filter((job) => !job.failed);
  if (active.length === 0) return state;
  const completed = jobs.map((job) => {
    if (job.failed) return job;
    const completedJob: TrainingJob = {
          ...job,
          progressPfDays: Math.max(job.progressPfDays, job.targetPfDays, job.recommendedPfDays ?? 0),
          daysElapsed: Math.max(job.daysElapsed ?? 0, job.minCalendarDays ?? 0),
          postTrainProgress: Math.max(job.postTrainProgress, job.postTrainTarget),
          postTrainDaysElapsed:
            job.postTrain === "none"
              ? job.postTrainDaysElapsed
              : Math.max(
                  job.postTrainDaysElapsed ?? 0,
                  postTrainMinimumDays(job.postTrain),
                ),
          awaitingDecision: true,
          paused: false,
          stallReason: null,
        };
    const completedStages = completedPostTrainStages(completedJob);
    return {
      ...completedJob,
      completedPostTrainStages: completedStages,
      postTrainStageEffectiveness: resolvedPostTrainStageEffectiveness(
        completedJob,
        state.player.researchUnlocked,
        state.player.models,
      ),
    };
  });
  return withAlert(
    withTrainingJobs(state, completed),
    "info",
    `${active.length} training run${active.length === 1 ? "" : "s"} completed — choose release or keep internal.`,
  );
}

/** Materialize a private checkpoint and queue a non-public benchmark run. */
export function benchmarkTrainingJob(state: SimState, jobId: string): SimState {
  const jobs = playerTrainingJobs(state);
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (!job || job.failed) return state;
  const recommended = Math.max(1e-9, job.recommendedPfDays ?? job.targetPfDays);
  const progressFrac = job.progressPfDays / recommended;
  if (progressFrac < 0.1) {
    return withAlert(
      state,
      "warn",
      "Benchmarks unlock after 10% of recommended training.",
    );
  }
  const last = job.lastBenchmarkDay;
  if (last != null && state.day - last < 7) {
    return withAlert(
      state,
      "warn",
      `Next benchmark available in ${7 - (state.day - last)}d.`,
    );
  }
  const loss = observedLoss(job) ?? 8.4;
  const precision = trainingNumericsEconomicsProfile(
    job.trainingNumerics ?? job.numerics ?? DEFAULT_TRAINING_NUMERICS,
  );
  const latentCapability = Math.max(
    1,
    Math.min(
      100,
      (100 - loss * 8) *
        Math.min(1, 0.35 + progressFrac * 0.75) *
      precision.qualityCeilingMultiplier,
    ),
  );
  const latentSafety = Math.max(
    1,
    Math.min(100, latentCapability * 0.85 + progressFrac * 8),
  );
  // Checkpoint evaluations are directional, not an oracle for final quality.
  // The hidden roll is stable for a given job/day and deliberately misses the
  // latent point by 20-35%; the displayed interval is at least as wide.
  const benchmarkRng = createRng(
    hashSeed(job.outcomeSeed ?? 0, job.id, state.day, "benchmark-v2"),
  );
  const inaccuracy = 0.2 + benchmarkRng.next() * 0.15;
  const noisyScore = (latent: number, preferredSign: -1 | 1): number => {
    const positiveFits = latent * (1 + inaccuracy) <= 100;
    const negativeFits = latent * (1 - inaccuracy) >= 1;
    const sign =
      preferredSign > 0
        ? positiveFits
          ? 1
          : -1
        : negativeFits
          ? -1
          : 1;
    return latent * (1 + sign * inaccuracy);
  };
  const capability = noisyScore(
    latentCapability,
    benchmarkRng.next() < 0.5 ? -1 : 1,
  );
  const safety = noisyScore(
    latentSafety,
    benchmarkRng.next() < 0.5 ? -1 : 1,
  );
  const confidence = Math.round((0.72 - inaccuracy * 0.6) * 100) / 100;
  const interval = Math.max(0.2, inaccuracy);
  const snapshot = {
    day: state.day,
    progress: progressFrac,
    capability,
    safety,
    suite: Math.round((capability * 0.7 + safety * 0.3) * 10) / 10,
    confidence,
    inaccuracy: interval,
    capabilityLow: capability * (1 - interval),
    capabilityHigh: capability * (1 + interval),
    safetyLow: safety * (1 - interval),
    safetyHigh: safety * (1 + interval),
  };
  const updated: TrainingJob = {
    ...job,
    benchmarkSnapshots: [...(job.benchmarkSnapshots ?? []), snapshot].slice(
      -32,
    ),
    lastBenchmarkDay: state.day,
  };
  return withAlert(
    withTrainingJobs(
      state,
      jobs.map((candidate) => (candidate.id === job.id ? updated : candidate)),
    ),
    "info",
    `${job.name} checkpoint benchmark @ ${(progressFrac * 100).toFixed(0)}%: loss ${loss.toFixed(3)}, est. cap ${capability.toFixed(1)}.`,
  );
}

/** @deprecated use releaseFromJob / keepInternal */
export function shipModel(state: SimState): SimState {
  return releaseFromJob(state);
}

function finalizeJob(
  state: SimState,
  release: "internal" | "released",
  jobId?: string,
  allowEarlyRelease: boolean = false,
): SimState {
  const jobs = playerTrainingJobs(state);
  const job = jobId
    ? jobs.find((candidate) => candidate.id === jobId)
    : jobs[0];
  if (!job || job.failed) return state;
  const completion = trainingMinimumStatus(job);
  const releaseGate = canReleaseTrainingJob(job);
  const isEarlyRelease = release === "released" && releaseGate.releaseKind === "early";
  if (!completion.ok && !(allowEarlyRelease && isEarlyRelease)) {
    return withAlert(
      state,
      "warn",
      release === "released"
        ? (releaseGate.reason ?? "Cannot release yet.")
        : (completion.reason ?? "Training is not complete."),
    );
  }
  if (job.postTrain !== "none" && job.postTrainProgress < job.postTrainTarget) {
    // allow finish mid post-train with partial quality
  }

  const model = buildModelFromJob(state, job, release);
  let models = [...state.player.models];
  let pricing = { ...state.player.pricing };

  // Continue-train replaces the base model in-place (keep per-model API list)
  if (job.mode === "continue" && job.continueFromId) {
    const idx = models.findIndex((m) => m.id === job.continueFromId);
    if (idx >= 0) {
      const prev = models[idx]!;
      models[idx] = {
        ...model,
        id: prev.id,
        release: release === "released" ? "released" : prev.release,
        shipped: release === "released" ? true : prev.shipped,
        releaseDay: prev.releaseDay,
        apiPricePerMTok: prev.apiPricePerMTok ?? model.apiPricePerMTok,
        apiPriceInPerMTok: prev.apiPriceInPerMTok ?? model.apiPriceInPerMTok,
        apiPriceOutPerMTok: prev.apiPriceOutPerMTok ?? model.apiPriceOutPerMTok,
      };
    } else {
      models = [...models, model];
    }
  } else {
    models = [...models, model];
  }

  let brand = state.player.brandTrust;
  if (release === "released") {
    pricing = {
      ...pricing,
      activeModelId: pricing.activeModelId ?? model.id,
    };
    if (model.quality.reliability < 35 || model.capability < 25) {
      brand = Math.max(10, brand - 8);
    } else if (model.quality.reliability > 60 && model.capability > 40) {
      brand = Math.min(100, brand + 4);
    }
  }

  const newsLine =
    job.mode === "continue"
      ? `Day ${state.day}: Continued ${model.name} → cap ${model.capability.toFixed(0)}`
      : release === "released"
        ? `Day ${state.day}: Released ${model.name} (${formatParams(model.paramsB)}, cap ${model.capability.toFixed(0)})`
        : `Day ${state.day}: Internal checkpoint ${model.name} (${formatParams(model.paramsB)}) — private`;
  const outcomeLine = model.outcome
    ? `${model.outcome.kind === "breakthrough" ? "Breakthrough" : model.outcome.kind === "stumble" ? "Training stumble" : "Training result"}: ${(model.outcome.yieldMultiplier * 100).toFixed(1)}% optimization yield. ${model.outcome.explanation}`
    : "";

  let next: SimState = {
    ...state,
    player: {
      ...state.player,
      trainingJobs: jobs.filter((candidate) => candidate.id !== job.id),
      trainingJob: jobs.find((candidate) => candidate.id !== job.id) ?? null,
      models,
      pricing,
      brandTrust: brand,
    },
    news: [
      outcomeLine ? `Day ${state.day}: ${model.name} — ${outcomeLine}` : "",
      newsLine,
      ...state.news,
    ]
      .filter(Boolean)
      .slice(0, 20),
    alerts: [
      {
        id: `done-${model.id}-${state.day}`,
        day: state.day,
        severity:
          release === "released" && model.quality.reliability < 40
            ? ("warn" as const)
            : ("info" as const),
        message:
          job.mode === "continue"
            ? `${model.name} continue-train complete (cap ${model.capability.toFixed(0)}).`
            : release === "internal"
              ? `${model.name} kept internal. Use as distillation teacher or release later.`
              : isEarlyRelease
                ? `Released ${model.name} early at ${Math.round((job.progressPfDays / Math.max(job.targetPfDays, 1e-9)) * 100)}% compute — capability and benchmarks are degraded.`
              : model.quality.reliability < 40
                ? `Released ${model.name} — rough quality. Expect churn.`
                : `Released ${model.name}. ${outcomeLine} Set API price and assign to Plans.`,
      },
      ...state.alerts,
    ].slice(0, 40),
    onboardingStep: Math.max(
      state.onboardingStep,
      release === "released" ? 2 : 1,
    ),
  };

  if (release === "released" && job.mode !== "continue") {
    next = attachModelToEmptyPlans(next, model.id);
    next = scheduleReleaseEvaluations(next, model.id);
  }
  return next;
}

/** Release an existing internal model to the public product surface. */
export function releaseModel(state: SimState, modelId: string): SimState {
  const idx = state.player.models.findIndex((m) => m.id === modelId);
  if (idx < 0) return state;
  const m = state.player.models[idx]!;
  if (m.release === "released")
    return withAlert(state, "warn", "Already released.");

  // Ensure public models carry own in/out list (don't silently share lab default)
  let listIn = m.apiPriceInPerMTok;
  let listOut = m.apiPriceOutPerMTok;
  let listBlend = m.apiPricePerMTok;
  if (listIn == null || listOut == null) {
    listIn = m.suggestedApiPriceIn ?? m.costApiPriceIn;
    listOut = m.suggestedApiPriceOut ?? m.costApiPriceOut;
    listBlend = Math.round((listIn * 0.3 + listOut * 0.7) * 1000) / 1000;
  }

  const models = state.player.models.slice();
  models[idx] = {
    ...m,
    release: "released",
    shipped: true,
    releaseDay: state.day,
    apiPriceInPerMTok: listIn,
    apiPriceOutPerMTok: listOut,
    apiPricePerMTok: listBlend,
  };

  let brand = state.player.brandTrust;
  if (m.quality.reliability < 35) brand = Math.max(10, brand - 5);
  else if (m.capability > 40) brand = Math.min(100, brand + 3);

  let next: SimState = {
    ...state,
    player: {
      ...state.player,
      models,
      brandTrust: brand,
      pricing: {
        ...state.player.pricing,
        activeModelId: state.player.pricing.activeModelId ?? m.id,
      },
    },
    news: [
      `Day ${state.day}: Released ${m.name} to market.`,
      ...state.news,
    ].slice(0, 20),
    alerts: [
      {
        id: `rel-${m.id}`,
        day: state.day,
        severity: "info" as const,
        message: `${m.name} is public. Set per-model API price and plan access.`,
      },
      ...state.alerts,
    ].slice(0, 40),
    onboardingStep: Math.max(state.onboardingStep, 2),
  };
  next = attachModelToEmptyPlans(next, m.id);
  next = scheduleReleaseEvaluations(next, m.id);
  return next;
}

/** Delete a model checkpoint (cannot delete while training job targets it). */
export function deleteModel(state: SimState, modelId: string): SimState {
  const m = state.player.models.find((x) => x.id === modelId);
  if (!m) return withAlert(state, "warn", "Model not found.");
  const inUse = playerTrainingJobs(state).some(
    (job) =>
      job.continueFromId === modelId ||
      job.teacherId === modelId ||
      (job.dataPlan?.domainModels &&
        Object.values(job.dataPlan.domainModels).includes(modelId)) ||
      (job.dataPlan?.syntheticTeacherIds &&
        Object.values(job.dataPlan.syntheticTeacherIds).includes(modelId)),
  );
  if (inUse) {
    return withAlert(
      state,
      "warn",
      "Cannot delete — in use by the active training job.",
    );
  }

  const models = state.player.models.filter((x) => x.id !== modelId);
  let pricing = { ...state.player.pricing };
  if (pricing.activeModelId === modelId) {
    const nextActive =
      models.find((x) => x.release === "released" || x.shipped)?.id ??
      models[0]?.id ??
      null;
    pricing = { ...pricing, activeModelId: nextActive };
  }
  // Strip from plans
  const plans = pricing.plans.map((p) => ({
    ...p,
    modelIds: p.modelIds.filter((id) => id !== modelId),
  }));
  pricing = {
    ...pricing,
    apiModelIds: pricing.apiModelIds?.filter((id) => id !== modelId),
    apiServePrecisionByModel: Object.fromEntries(
      Object.entries(pricing.apiServePrecisionByModel ?? {}).filter(
        ([id]) => id !== modelId,
      ),
    ),
    plans,
  };

  return {
    ...state,
    player: {
      ...state.player,
      models,
      pricing,
    },
    alerts: [
      {
        id: `del-model-${modelId}-${state.day}`,
        day: state.day,
        severity: "info" as const,
        message: `Deleted model ${m.name}.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

export function setModelApiPrice(
  state: SimState,
  modelId: string,
  price: number | null,
): SimState {
  // Blended single price → split into in/out using same mix as global defaults
  const models = state.player.models.map((m) => {
    if (m.id !== modelId) return m;
    if (price === null) {
      return {
        ...m,
        apiPricePerMTok: null,
        apiPriceInPerMTok: null,
        apiPriceOutPerMTok: null,
      };
    }
    const p = Math.max(0, price);
    return {
      ...m,
      apiPricePerMTok: p,
      apiPriceInPerMTok: Math.round(p * 0.35 * 1000) / 1000,
      apiPriceOutPerMTok: Math.round(p * 1.25 * 1000) / 1000,
    };
  });
  return { ...state, player: { ...state.player, models } };
}

export function setModelApiInOut(
  state: SimState,
  modelId: string,
  priceIn: number | null,
  priceOut: number | null,
): SimState {
  const models = state.player.models.map((m) => {
    if (m.id !== modelId) return m;
    if (priceIn === null && priceOut === null) {
      return {
        ...m,
        apiPriceInPerMTok: null,
        apiPriceOutPerMTok: null,
        apiPricePerMTok: null,
      };
    }
    const pin = Math.max(0, priceIn ?? m.apiPriceInPerMTok ?? m.costApiPriceIn);
    const pout = Math.max(
      0,
      priceOut ?? m.apiPriceOutPerMTok ?? m.costApiPriceOut,
    );
    return {
      ...m,
      apiPriceInPerMTok: pin,
      apiPriceOutPerMTok: pout,
      apiPricePerMTok: Math.round((pin * 0.3 + pout * 0.7) * 1000) / 1000,
    };
  });
  return { ...state, player: { ...state.player, models } };
}

/** Apply markup % to model cost floors → list prices. */
export function applyModelApiMarkup(
  state: SimState,
  modelId: string,
  markupPct: number,
): SimState {
  const m = state.player.models.find((x) => x.id === modelId);
  if (!m) return state;
  const mult = 1 + Math.max(0, markupPct) / 100;
  const pin = Math.round(m.costApiPriceIn * mult * 1000) / 1000;
  const pout = Math.round(m.costApiPriceOut * mult * 1000) / 1000;
  return setModelApiInOut(state, modelId, pin, pout);
}

function buildModelFromJob(
  state: SimState,
  job: TrainingJob,
  release: "internal" | "released",
): Model {
  const effects = aggregateEffects(state.player.researchUnlocked);
  const family = job.family;
  const backbone = job.backbone ?? backboneFromFamily(family);
  const stackModifiers = modelStackModifiers(job.modelStack ?? [], family);
  const precision = trainingNumericsEconomicsProfile(
    job.trainingNumerics ?? job.numerics ?? DEFAULT_TRAINING_NUMERICS,
  );
  const paramsB = job.targetParamsB;
  const activeParamsB =
    backbone === "moe" ? (job.activeParamsB ?? paramsB * 0.1) : undefined;
  const teacher = job.teacherId
    ? state.player.models.find((m) => m.id === job.teacherId)
    : undefined;
  const continueBase = job.continueFromId
    ? state.player.models.find((m) => m.id === job.continueFromId)
    : undefined;
  const postProfile = postTrainEffectProfile(
    job,
    state.player.researchUnlocked,
    state.player.models,
  );
  const completedPostStages = completedPostTrainStages(job);
  const resolvedStageEffectiveness = resolvedPostTrainStageEffectiveness(
    job,
    state.player.researchUnlocked,
    state.player.models,
  );
  const reasoningTrained =
    stackModifiers.reasoningEnabled ||
    job.postTrain === "process" ||
    job.postTrain === "tools" ||
    completedPostStages.includes("process") ||
    completedPostStages.includes("tools");
  const legacyMix = DATA_MIX_DEFS[job.dataMix ?? "web"];
  // Domain recipe effects
  const weights = job.dataPlan?.weights ?? {};
  let domainCap = 0;
  let domainCoding = 0;
  let domainMath = 0;
  let domainScience = 0;
  let domainChat = 0;
  let domainSafety = 0;
  let domainLaw = 0;
  let domainHealth = 0;
  let domainVision = 0;
  let domainVideo = 0;
  let domainAudio = 0;
  for (const d of DATA_DOMAINS) {
    const w = weights[d] ?? 0;
    if (w <= 0) continue;
    const m = DATA_DOMAIN_META[d];
    domainCap += m.capability * w;
    domainCoding += m.coding * w;
    domainMath += m.math * w;
    domainScience += m.science * w;
    domainChat += m.chat * w;
    domainSafety += m.safety * w;
    domainLaw += m.law * w;
    domainHealth += m.health * w;
    domainVision += m.vision * w;
    domainVideo += m.video * w;
    domainAudio += m.audio * w;
  }
  const coverage = job.dataCoverage ?? 1;
  const dataQ = (job.dataQualityUsed ?? 50) / 100;
  const mix = {
    capability: domainCap + legacyMix.capability * 0.15,
    coding: domainCoding + legacyMix.coding * 0.2,
    chat: domainChat + legacyMix.chat * 0.2,
    safety: domainSafety + legacyMix.safety * 0.2,
    math: domainMath + legacyMix.math * 0.15,
    science: domainScience,
  };

  // ── Shared scale formula: params × data volume × quality × mix ──
  const dataQualityNorm = normalizeDataQuality({
    labDataQuality: state.player.dataQuality,
    jobQualityUsed: job.dataQualityUsed,
  });
  const researchMult =
    1 +
    Math.min(0.12, (effects.capabilityBonus ?? 0) * 0.015) +
    ((family === "moe" || job.backbone === "moe") && state.player.researchUnlocked.includes("moe_hier")
      ? 0.04
      : 0);
  const trainComplete = Math.min(
    1,
    job.progressPfDays / Math.max(1, job.targetPfDays),
  );

  let scale = scaleIntelligence({
    paramsB,
    activeParamsB,
    family,
    backbone,
    dataCoverage: coverage,
    dataQuality: dataQualityNorm,
    mixWeights: weights,
    researchMult:
      (family === "moe" || job.backbone === "moe") && !state.player.researchUnlocked.includes("moe_routing")
        ? researchMult * 0.55
        : researchMult,
    trainComplete,
    postTrainStrength: postProfile.scaleStrength,
    reasoningEnabled: reasoningTrained,
    teacherCapability: job.mode === "distill" ? teacher?.capability : undefined,
  });

  let capability = scale.capability + mix.capability * 0.35;

  // Continue-train: modest lift from prior, still gated by size×data scale
  if (job.mode === "continue" && continueBase) {
    const lift =
      1.2 +
      trainComplete * 2.5 +
      mix.capability * 0.35 +
      (coverage - 0.5) * 1.5;
    const maxLift = Math.max(2, scale.capability * 0.12);
    capability = clamp(
      Math.min(
        scale.capability + 2,
        continueBase.capability + Math.min(maxLift, lift),
      ),
    );
  }

  const postIdx = postProfile.alignmentEquivalent;
  const rlhfMult = 1 + (effects.rlhfQuality ?? 0);
  const safetyBase =
    14 +
    scale.intelligence * 35 +
    (effects.safetyBonus ?? 0) * 2 +
    postIdx * 6 * rlhfMult +
    mix.safety;
  const reliabilityBase =
    18 +
    scale.intelligence * 40 +
    postIdx * 9 * rlhfMult +
    (effects.safetyBonus ?? 0);
  let chat = Math.min(100, capability * 0.88 + postIdx * 4 + mix.chat);
  let coding = Math.min(
    100,
    capability * 0.9 +
      (state.player.researchUnlocked.includes("moe_special") ? 4 : 0) +
      mix.coding * 0.7,
  );
  let reasoning = Math.min(
    100,
    capability * 0.95 +
      (reasoningTrained ? 4 * Math.min(1, postProfile.alignmentEquivalent) : 0) +
      mix.math * 0.34 +
      mix.science * 0.18,
  );

  const quality: QualityAxes = {
    reasoning: clamp(reasoning),
    coding: clamp(coding),
    chat: clamp(chat),
    image: clamp(
      (family === "diffusion" || family === "omni" ? capability * 0.75 : 5) +
        domainVision * 0.5,
    ),
    video: clamp(
      (family === "video" || family === "omni"
        ? capability * 0.65
        : domainVideo * 0.35) +
        domainVideo * 0.4,
    ),
    safety: clamp(safetyBase + domainLaw * 0.12 + domainHealth * 0.1),
    reliability: clamp(reliabilityBase + dataQ * 6),
  };

  if (job.mode === "continue" && continueBase) {
    quality.reasoning = clamp(
      continueBase.quality.reasoning + mix.math * 0.35 + 1.5,
    );
    quality.coding = clamp(continueBase.quality.coding + mix.coding * 0.4 + 1);
    quality.chat = clamp(continueBase.quality.chat + mix.chat * 0.35 + 0.8);
    quality.safety = clamp(continueBase.quality.safety + mix.safety * 0.25);
    quality.reliability = clamp(continueBase.quality.reliability + 1.5);
    quality.image = continueBase.quality.image;
    quality.video = continueBase.quality.video;
  }

  if (job.postTrain === "none" && job.mode !== "continue") {
    quality.reliability = Math.min(quality.reliability, 26);
    quality.safety = Math.min(quality.safety, 20);
    quality.chat = quality.chat * 0.75;
  }

  // Distill path: blend your corpus (self scale) with teacher signal.
  // High teacher share → ~80% of teacher (DISTILL_RETENTION). High own data → more self scale.
  const distillTeacherShare =
    job.mode === "distill"
      ? clampDistillTeacherShare(job.distillTeacherShare)
      : 0;
  const distillSelfShare = 1 - distillTeacherShare;
  if (job.mode === "distill" && teacher) {
    const d = distillFromTeacher({
      teacherCapability: teacher.capability,
      teacherBenchmarks: teacher.benchmarks,
      studentScaleCap: Math.max(scale.capability, teacher.capability * 0.75),
      targetRetention: DISTILL_RETENTION,
    });
    // Self branch: size × your processed data only
    const selfCap = scale.capability + mix.capability * 0.35;
    // Teacher branch: classic ~80% retention (slightly soft-capped under teacher)
    const teacherCap = Math.min(teacher.capability * 0.9, d.capability);
    capability = clamp(
      selfCap * distillSelfShare + teacherCap * distillTeacherShare,
    );
    quality.safety = clamp(
      teacher.quality.safety * 0.75 * distillTeacherShare +
        quality.safety * distillSelfShare +
        mix.safety * 0.12,
    );
    quality.reliability = clamp(
      teacher.quality.reliability * 0.75 * distillTeacherShare +
        quality.reliability * distillSelfShare,
    );
    quality.reasoning = clamp(
      capability * 0.95 * distillTeacherShare +
        quality.reasoning * distillSelfShare +
        mix.math * 0.15,
    );
    quality.coding = clamp(
      capability * 0.9 * distillTeacherShare +
        quality.coding * distillSelfShare +
        mix.coding * 0.25,
    );
    quality.chat = clamp(
      capability * 0.85 * distillTeacherShare +
        quality.chat * distillSelfShare +
        mix.chat * 0.2,
    );
  }

  let inferCostMult = 1;
  let tokPerSecMult = 0.7;
  const sparseBackbone = backbone === "moe";
  if (sparseBackbone) {
    inferCostMult = (effects.moeInferMult as number | undefined) ?? 1.1;
    // active size drives serve cost
    const active = activeParamsB ?? paramsB * 0.1;
    inferCostMult *= Math.pow(active / Math.max(paramsB * 0.08, 0.1), 0.3);
    tokPerSecMult = (family === "omni" ? 0.35 : 0.85) * Math.pow(7 / Math.max(active, 0.5), 0.15);
    if (!state.player.researchUnlocked.includes("moe_serve")) {
      tokPerSecMult *= 0.55;
    }
  } else if (family === "dense") {
    inferCostMult = (effects.denseInferMult as number | undefined) ?? 1;
    tokPerSecMult = 0.75 * Math.pow(7 / Math.max(paramsB, 0.5), 0.12);
  } else if (family === "video") {
    inferCostMult = 2.5;
    tokPerSecMult = 0.25;
  } else if (family === "diffusion") {
    inferCostMult = 1.4;
    tokPerSecMult = 0.4;
  } else if (family === "omni") {
    inferCostMult = 1;
    tokPerSecMult = 0.35;
  }

  // Large dense models slower / costlier to serve
  if (!sparseBackbone && paramsB > 70) {
    inferCostMult *= 1 + Math.log10(paramsB / 70) * 0.35;
    tokPerSecMult *= 1 / (1 + Math.log10(paramsB / 70) * 0.4);
  }
  inferCostMult *= stackModifiers.hostingMult;
  tokPerSecMult *= stackModifiers.speedMult;

  const baseJobIo =
    job.io ?? ioForPreset(job.productPreset ?? presetFromFamily(family));
  const jobIo = postProfile.toolsEnabled
    ? { ...baseJobIo, tools: Math.max(1, baseJobIo.tools) }
    : baseJobIo;
  const modalities: Model["modalities"] = [];
  for (const modality of ["text", "image", "audio", "video"] as const) {
    if (
      (jobIo.inputs[modality] ?? 0) > 0 ||
      (jobIo.outputs[modality] ?? 0) > 0
    ) {
      modalities.push(modality);
    }
  }
  if (jobIo.tools > 0) modalities.push("tools");
  if (modalities.length === 0) modalities.push("text");

  // Research extras (small — cannot max small models)
  const extras: Partial<BenchmarkScores> = {};
  for (const id of state.player.researchUnlocked) {
    const b = getResearchNode(id).effects.benchmarkBoost;
    if (!b) continue;
    for (const [k, v] of Object.entries(b) as [
      keyof BenchmarkScores,
      number,
    ][]) {
      extras[k] = (extras[k] ?? 0) + Math.min(4, v * 0.45);
    }
  }
  // Domain mix extras (specialty, not free general scale)
  extras.coding =
    (extras.coding ?? 0) + Math.min(5, domainCoding * 0.35 + mix.coding * 0.25);
  extras.math =
    (extras.math ?? 0) + Math.min(6, domainMath * 0.42 + mix.math * 0.18);
  extras.science =
    (extras.science ?? 0) +
    Math.min(6, domainScience * 0.42 + domainMath * 0.08);
  extras.mmlu =
    (extras.mmlu ?? 0) + Math.min(3, mix.capability * 0.2 + domainChat * 0.08);
  extras.safety = (extras.safety ?? 0) + Math.min(4, mix.safety * 0.25);
  extras.law = (extras.law ?? 0) + Math.min(6, domainLaw * 0.4);
  extras.health = (extras.health ?? 0) + Math.min(6, domainHealth * 0.4);
  extras.vision = (extras.vision ?? 0) + Math.min(6, domainVision * 0.4);
  extras.agents =
    (extras.agents ?? 0) + Math.min(4, domainCoding * 0.12 + domainChat * 0.1);

  // Specialist curators: extra domain eval lift (research-gated)
  const spec = job.dataPlan?.domainModels;
  if (spec && state.player.researchUnlocked.includes("data_specialists")) {
    for (const d of DATA_DOMAINS) {
      const mid = spec[d];
      if (!mid) continue;
      const m = state.player.models.find((x) => x.id === mid);
      if (!m || !modelCanCurateDataDomain(m, d)) continue;
      const boost = specialistDomainBoost(m, d) / 22; // 0–1
      if (d === "code") {
        extras.coding = (extras.coding ?? 0) + Math.min(4, boost * 5);
        extras.agents = (extras.agents ?? 0) + Math.min(2, boost * 2);
      }
      if (d === "math")
        extras.math = (extras.math ?? 0) + Math.min(5, boost * 6);
      if (d === "science")
        extras.science = (extras.science ?? 0) + Math.min(5, boost * 6);
      if (d === "law") extras.law = (extras.law ?? 0) + Math.min(5, boost * 6);
      if (d === "health")
        extras.health = (extras.health ?? 0) + Math.min(5, boost * 6);
      if (d === "chat")
        extras.mmlu = (extras.mmlu ?? 0) + Math.min(2.5, boost * 3);
      if (d === "image" || d === "video")
        extras.vision = (extras.vision ?? 0) + Math.min(4, boost * 5);
    }
  }

  // Recompute scale at final capability-influencing state for benches
  scale = scaleIntelligence({
    paramsB,
    activeParamsB,
    family,
    backbone,
    dataCoverage: coverage,
    dataQuality: dataQualityNorm,
    mixWeights: weights,
    researchMult:
      (family === "moe" || job.backbone === "moe") && !state.player.researchUnlocked.includes("moe_routing")
        ? researchMult * 0.55
        : researchMult,
    trainComplete,
    postTrainStrength: postProfile.scaleStrength,
    reasoningEnabled: reasoningTrained,
    teacherCapability: job.mode === "distill" ? teacher?.capability : undefined,
  });

  let benchmarks = scoresFromScale({
    scale,
    quality,
    family,
    unlocked: state.player.researchUnlocked,
    postTrain: job.postTrain,
    extras,
    reasoningEnabled: reasoningTrained,
    toolsEnabled: postProfile.toolsEnabled || jobIo.tools > 0,
    imageDataQualityFactor:
      (job.dataQualityByDomain?.image ?? job.dataQualityUsed ?? 50) / 100,
    healthLowQualityShare:
      job.lowQualityShareByDomain?.health ?? job.synthLqShare ?? 0,
    scienceDataQuality: job.dataQualityByDomain?.science ?? job.dataQualityUsed,
    chatDataQuality: job.dataQualityByDomain?.chat ?? job.dataQualityUsed,
  });

  // Keep capability consistent with scale (domain mix only mild nudge)
  if (job.mode !== "distill" && job.mode !== "continue") {
    capability = clamp(scale.capability + mix.capability * 0.35);
  }

  // Low-quality synthetic pollution — same rule as rivals (shared scale path)
  const lqShare = job.synthLqShare ?? 0;
  if (lqShare > 0.02) {
    const mult = lqSynthCapabilityMult(lqShare);
    capability = clamp(capability * mult);
    quality.reliability = clamp(quality.reliability * (1 - lqShare * 0.25));
    quality.safety = clamp(quality.safety * (1 - lqShare * 0.2));
    for (const k of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      benchmarks = {
        ...benchmarks,
        [k]: clamp(benchmarks[k]! * (1 - lqShare * 0.15)),
      };
    }
  }

  if (stackModifiers.capabilityBonus > 0) {
    const bonus = stackModifiers.capabilityBonus;
    capability = clamp(capability + bonus);
    quality.reasoning = clamp(quality.reasoning + bonus * 0.9);
    quality.coding = clamp(quality.coding + bonus * 0.8);
    quality.chat = clamp(quality.chat + bonus * 0.5);
    for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      benchmarks = {
        ...benchmarks,
        [key]: clamp(benchmarks[key]! + bonus * 0.55),
      };
    }
  }

  // Train vs verify split: more train → smarter; more verify → safer/reliable
  const trainShare = job.trainShare ?? 0.82;
  const verifyShare = 1 - trainShare;
  const dataVol = Math.max(0.01, (job.trainMTok ?? 0) + (job.verifyMTok ?? 0));
  if (job.mode === "continue") {
    // Continue: no 1:1 requirement — new tokens give soft lift
    const soft = Math.min(1.4, Math.log10(1 + dataVol / 50) / 2);
    capability = clamp(capability + soft * trainShare * 4 + soft * 1.5);
    quality.safety = clamp(quality.safety + soft * verifyShare * 6);
    quality.reliability = clamp(
      quality.reliability + soft * verifyShare * 5 + soft * 2,
    );
    quality.reasoning = clamp(quality.reasoning + soft * trainShare * 3);
    quality.coding = clamp(quality.coding + soft * trainShare * 2.5);
  } else {
    const minNeed = minDataMTokForParams(paramsB);
    const volRatio = Math.min(2, dataVol / Math.max(1, minNeed));
    const overData = Math.max(0, volRatio - 1);
    capability = clamp(
      capability * (0.92 + trainShare * 0.1 + overData * trainShare * 0.06),
    );
    quality.safety = clamp(
      quality.safety + verifyShare * 12 + overData * verifyShare * 8,
    );
    quality.reliability = clamp(
      quality.reliability + verifyShare * 10 + overData * verifyShare * 6,
    );
    quality.reasoning = clamp(quality.reasoning + trainShare * overData * 4);
    quality.coding = clamp(quality.coding + trainShare * overData * 3);
  }

  if (job.mode === "distill" && teacher) {
    const d = distillFromTeacher({
      teacherCapability: teacher.capability,
      teacherBenchmarks: teacher.benchmarks,
      studentScaleCap: Math.max(scale.capability, teacher.capability * 0.75),
      targetRetention: DISTILL_RETENTION,
    });
    const tShare = distillTeacherShare;
    const sShare = distillSelfShare;
    for (const k of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      const fromTeacher = d.benchmarks[k];
      const fromSelf = benchmarks[k];
      const teacherV =
        fromTeacher != null
          ? Math.min((teacher.benchmarks[k] ?? fromTeacher) * 0.88, fromTeacher)
          : fromSelf;
      // Blend: teacher-heavy → near 80% teacher benches; corpus-heavy → your scale benches
      benchmarks = {
        ...benchmarks,
        [k]: clamp(fromSelf * sShare + teacherV * tShare),
      };
    }
  }

  const outcome = rollTrainingOutcome({
    seed: job.outcomeSeed ?? hashSeed(state.seed, job.id, "train-outcome"),
    quality: job.dataQualityUsed,
    verifyShare: 1 - (job.trainShare ?? 0.82),
    engineers: state.player.staff?.engineer ?? 0,
    researchCount: state.player.researchUnlocked.length,
    day: state.day,
    breakthroughBias: effects.trainingBreakthroughBias,
    stumbleRisk:
      (effects.trainingStumbleRisk ?? 0) +
      Math.max(0, precision.lossVolatilityMultiplier - 1) * 0.08,
  });
  capability = clamp(capability + outcome.capabilityDelta);
  capability = Math.min(
    capability,
    scale.capabilityCeiling * precision.qualityCeilingMultiplier,
  );
  quality.reliability = clamp(quality.reliability + outcome.reliabilityDelta);
  quality.safety = clamp(
    quality.safety +
      Math.min(2, outcome.reliabilityDelta * 0.25) -
      (effects.trainingSafetyPenalty ?? 0),
  );
  for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
    benchmarks = {
      ...benchmarks,
      [key]: clamp(benchmarks[key]! + outcome.capabilityDelta * 0.45),
    };
  }

  const syntheticTeacherWeights = new Map<string, number>();
  for (const item of job.syntheticProvenance ?? []) {
    if (!item.teacherModelId) continue;
    syntheticTeacherWeights.set(
      item.teacherModelId,
      (syntheticTeacherWeights.get(item.teacherModelId) ?? 0) + item.volumeMTok,
    );
  }
  const weightedTeacher = [...syntheticTeacherWeights.entries()].reduce(
    (acc, [modelId, volume]) => {
      const source = state.player.models.find((model) => model.id === modelId);
      return source
        ? {
            capability: acc.capability + source.capability * volume,
            reliability:
              acc.reliability + source.quality.reliability * volume,
            volume: acc.volume + volume,
          }
        : acc;
    },
    { capability: 0, reliability: 0, volume: 0 },
  );
  const syntheticTeacherCapability =
    weightedTeacher.volume > 0
      ? weightedTeacher.capability / weightedTeacher.volume
      : 0;
  const syntheticTeacherReliability =
    weightedTeacher.volume > 0
      ? weightedTeacher.reliability / weightedTeacher.volume
      : 0;
  const frontierCapability = Math.max(
    syntheticTeacherCapability,
    ...state.player.models
      .filter((model) => model.release === "released" || model.shipped)
      .map((model) => model.capability),
    ...state.rivals.flatMap((rival) =>
      rival.models
        .filter((model) => model.release === "released" || model.shipped)
        .map((model) => model.capability),
    ),
  );
  const syntheticProfile = syntheticTrainingProfile({
    realMTok: Math.max(0, dataVol - (job.syntheticUnits ?? 0)),
    syntheticMTok: job.syntheticUnits ?? 0,
    teacherCapability: syntheticTeacherCapability,
    frontierCapability,
    teacherReliability: syntheticTeacherReliability,
    dataQuality: job.dataQualityUsed ?? state.player.dataQuality,
    computePfDays: job.progressPfDays,
    seed: `${job.id}:${state.seed}`,
  });
  const effectiveSyntheticVolume =
    syntheticProfile.realMTok + syntheticProfile.effectiveSyntheticMTok;
  if (
    syntheticProfile.totalMTok > 0 &&
    effectiveSyntheticVolume + 1e-9 < syntheticProfile.totalMTok
  ) {
    const effectiveCoverage =
      coverage * (effectiveSyntheticVolume / syntheticProfile.totalMTok);
    const effectiveScale = scaleIntelligence({
      paramsB,
      activeParamsB,
      family,
      backbone,
      dataCoverage: effectiveCoverage,
      dataQuality: dataQualityNorm,
      mixWeights: weights,
      researchMult:
        (family === "moe" || job.backbone === "moe") &&
        !state.player.researchUnlocked.includes("moe_routing")
          ? researchMult * 0.55
          : researchMult,
      trainComplete,
      postTrainStrength: postProfile.scaleStrength,
      reasoningEnabled: reasoningTrained,
      teacherCapability:
        job.mode === "distill" ? teacher?.capability : undefined,
    });
    scale = effectiveScale;
    capability = Math.min(capability, effectiveScale.capability);
    for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      benchmarks = {
        ...benchmarks,
        [key]: Math.min(benchmarks[key]!, effectiveScale.benchCeilings[key]),
      };
    }
  }
  if (syntheticTeacherCapability > 0 && syntheticProfile.syntheticShare > 0) {
    const effectiveSyntheticShare =
      syntheticProfile.effectiveSyntheticMTok /
      Math.max(
        1e-9,
        syntheticProfile.realMTok + syntheticProfile.effectiveSyntheticMTok,
      );
    const imitationTarget =
      syntheticTeacherCapability * syntheticProfile.imitationRetention;
    capability = clamp(
      capability +
        Math.max(0, imitationTarget - capability) *
          effectiveSyntheticShare,
    );
    const benchmarkLift =
      effectiveSyntheticShare * 3 +
      syntheticProfile.benchmarkOverfit * 6;
    for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      benchmarks = {
        ...benchmarks,
        [key]: clamp(benchmarks[key]! + benchmarkLift),
      };
    }
    quality.reliability = clamp(
      quality.reliability - syntheticProfile.benchmarkOverfit * 18,
    );
    quality.chat = clamp(quality.chat - syntheticProfile.benchmarkOverfit * 10);
  }

  // Precision cannot invent parameter/data/architecture headroom. Apply this
  // after all stochastic and synthetic lifts so no later path bypasses it.
  capability = Math.min(
    capability,
    scale.capabilityCeiling * precision.qualityCeilingMultiplier,
  );
  for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
    benchmarks = {
      ...benchmarks,
      [key]: Math.min(
        benchmarks[key]!,
        scale.benchCeilings[key] * precision.qualityCeilingMultiplier,
      ),
    };
  }

  // A plateau permits stopping; it does not manufacture the work that was
  // skipped. This explicit maturity haircut compounds the scale formula's
  // progress ceiling and is exactly neutral for a completed run.
  const releasePenalty = earlyReleasePenalty(job);
  if (releasePenalty.progress < 1) {
    capability = clamp(
      capability * releasePenalty.capabilityMultiplier,
    );
    for (const key of Object.keys(quality) as (keyof QualityAxes)[]) {
      quality[key] = clamp(
        quality[key] *
          (key === "reliability"
            ? releasePenalty.reliabilityMultiplier
            : releasePenalty.capabilityMultiplier),
      );
    }
    for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      benchmarks = {
        ...benchmarks,
        [key]: clamp(
          benchmarks[key]! * releasePenalty.benchmarkMultiplier,
        ),
      };
    }
  }
  inferCostMult *= precision.inferenceCostMultiplier;

  const apiSug = suggestApiInOut({
    costPerMTokBase: 0.28,
    paramsB,
    activeParamsB,
    family,
    inferCostMult,
    capability,
    markupPct: state.player.pricing.apiMarkupPct ?? 120,
  });
  const suggested = suggestedApiPricePerMTok({
    paramsB,
    activeParamsB,
    family,
    inferCostMult,
    capability,
    costPerMTokBase: 0.28,
  });

  const continueCompute =
    (continueBase?.continueCompute ?? 0) +
    (job.mode === "continue" ? job.progressPfDays : 0);

  // Each model owns its own in/out list prices ($/MTok). Continue keeps prior
  // list; new weights seed from size/capability-based suggestions so models
  // don't all share the lab-wide default.
  const listIn = continueBase?.apiPriceInPerMTok ?? apiSug.priceIn;
  const listOut = continueBase?.apiPriceOutPerMTok ?? apiSug.priceOut;
  const listBlend =
    continueBase?.apiPricePerMTok ??
    Math.round((listIn * 0.3 + listOut * 0.7) * 1000) / 1000;

  const productPreset = job.productPreset ?? presetFromFamily(family);
  const serviceProfile = serviceProfileForModel({
    paramsB,
    activeParamsB,
    family,
    backbone,
    tokPerSecMult,
    capability,
  });
  const capabilities = deriveModelCapabilities({
    finalCapability: capability,
    trainComputePfDays: job.progressPfDays,
    effectiveDataRatio: job.effectiveDataRatio ?? job.dataCoverage ?? 0,
    dataQuality: job.dataQualityUsed ?? state.player.dataQuality,
    domainWeights: weights,
    io: jobIo,
    family,
    postTrain: job.postTrain,
    quality,
  });

  return normalizeModelEvaluations({
    id:
      job.mode === "continue" && continueBase
        ? continueBase.id
        : `model-${state.day}-${job.id}`,
    name: job.name,
    family,
    paramsB,
    activeParamsB,
    backbone,
    productPreset,
    io: {
      inputs: Object.fromEntries(
        Object.keys(jobIo.inputs).map((key) => [key, capability]),
      ),
      outputs: Object.fromEntries(
        Object.keys(jobIo.outputs).map((key) => [key, capability]),
      ),
      tools: postProfile.toolsEnabled
        ? capability * (0.45 + postProfile.scaleStrength * 0.4)
        : jobIo.tools > 0
          ? capability * 0.35
          : 0,
    },
    capability,
    capabilities,
    modalities,
    quality,
    benchmarks,
    postTrain: job.postTrain,
    completedPostTrainStages: completedPostStages,
    postTrainStageEffectiveness: {
      ...(continueBase?.postTrainStageEffectiveness ?? {}),
      ...resolvedStageEffectiveness,
    },
    trainComputeSpent:
      (continueBase?.trainComputeSpent ?? 0) + job.progressPfDays,
    releaseDay: continueBase?.releaseDay ?? state.day,
    shipped: release === "released" || continueBase?.shipped === true,
    release:
      release === "released" ? "released" : (continueBase?.release ?? release),
    tokPerSecMult,
    inferCostMult,
    serviceProfile,
    apiPricePerMTok: listBlend,
    apiPriceInPerMTok: listIn,
    apiPriceOutPerMTok: listOut,
    suggestedApiPrice: suggested,
    suggestedApiPriceIn: apiSug.priceIn,
    suggestedApiPriceOut: apiSug.priceOut,
    costApiPriceIn: apiSug.costIn,
    costApiPriceOut: apiSug.costOut,
    distilled: job.mode === "distill" || !!continueBase?.distilled,
    teacherId: job.teacherId ?? continueBase?.teacherId,
    distillTeacherShare:
      job.mode === "distill"
        ? distillTeacherShare
        : continueBase?.distillTeacherShare,
    trainMode: job.mode,
    dataMix: job.dataMix,
    dataPlan: job.dataPlan,
    dataConsumed: job.dataConsumed,
    dataCoverage: job.dataCoverage,
    dataQualityUsed: job.dataQualityUsed,
    dataTokensUsedMTok:
      (continueBase?.dataTokensUsedMTok ?? 0) +
      (job.trainMTok ?? 0) +
      (job.verifyMTok ?? 0),
    // Watermark at lab corpus size so continue only uses data collected after this train
    dataWatermarkMTok: totalProcessed(ensureLabData(state)),
    dataTrainMTok: job.trainMTok,
    dataVerifyMTok: job.verifyMTok,
    continueCompute,
    effectiveDataRatio: job.effectiveDataRatio ?? job.dataCoverage,
    repeatedDataEpochs: job.repeatedDataEpochs ?? 1,
    outcome,
    openWeights: false,
    dataManifestId: job.dataManifestId ?? continueBase?.dataManifestId,
    integratedMethods:
      job.integratedMethods ?? continueBase?.integratedMethods ?? [],
    modelStack: job.modelStack ?? continueBase?.modelStack ?? [],
    reasoningEnabled: reasoningTrained,
    revision: continueBase?.revision ?? 1,
    safetyTraining: continueBase?.safetyTraining,
    dataQualityByDomain:
      job.dataQualityByDomain ?? continueBase?.dataQualityByDomain,
    lowQualityShareByDomain:
      job.lowQualityShareByDomain ?? continueBase?.lowQualityShareByDomain,
    syntheticProvenance:
      job.syntheticProvenance ?? continueBase?.syntheticProvenance,
    syntheticMultiplier:
      job.syntheticUnits > 0
        ? syntheticProfile.syntheticMultiplier
        : (continueBase?.syntheticMultiplier ?? 0),
    syntheticShare:
      job.syntheticUnits > 0
        ? syntheticProfile.syntheticShare
        : (continueBase?.syntheticShare ?? 0),
    benchmarkOverfit: Math.max(
      continueBase?.benchmarkOverfit ?? 0,
      syntheticProfile.benchmarkOverfit,
    ),
    trainingNumerics:
      job.trainingNumerics ?? job.numerics ?? continueBase?.trainingNumerics,
    trainingFormulaVersion: job.trainingFormulaVersion ?? 2,
  });
}

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

export function tickTraining(state: SimState): SimState {
  const jobs = playerTrainingJobs(state);
  if (!jobs.length) return state;

  const snap = computeSnapshot(state);
  const resources = playerTrainingResourcePlan(state, snap);
  const isActive = (job: TrainingJob) =>
    !job.failed &&
    !job.paused &&
    !job.awaitingDecision &&
    (job.progressPfDays + 1e-9 < job.targetPfDays ||
      (job.daysElapsed ?? 0) < (job.minCalendarDays ?? 0) ||
      (job.postTrain !== "none" && job.postTrainProgress < job.postTrainTarget));
  const totalBurn = jobs.reduce(
    (sum, job) => sum + (isActive(job) ? (job.cashBurnPerDay ?? 0) : 0),
    0,
  );
  let cash = state.player.cash - totalBurn;
  if (cash < 0) {
    // Job stalls without cash — no progress, still opex
    return {
      ...state,
      player: { ...state.player, cash: Math.max(-5_000_000, cash) },
      alerts: [
        {
          id: `train-cash-${state.day}`,
          day: state.day,
          severity: "danger" as const,
          message:
            "Training stalled — payroll/cluster burn exceeded cash. Raise capital or pause job.",
        },
        ...state.alerts.filter((a) => !a.id.startsWith("train-cash-")),
      ].slice(0, 40),
    };
  }

  const nextJobs = jobs.map((job) => {
    if (job.failed) return job;
    const active = isActive(job);
    const daysElapsed = (job.daysElapsed ?? 0) + (active ? 1 : 0);
    const resource = resources.jobs[job.id];
    const trainPool = resource?.effectivePf ?? 0;
    const allocatedPf = active ? Math.max(0, trainPool) : 0;
    const energyMwDays = (job.energyMwDays ?? 0) + allocatedPf * mwPerPf();
    const energyMWh = energyMwDays * 24;
    const telemetry = (
      progressPfDays = job.progressPfDays,
      elapsed = daysElapsed,
    ) => ({
      energyMwDays,
      energyMWh,
      daysRemaining: liveTrainingDaysRemaining(
        job,
        allocatedPf,
        progressPfDays,
        elapsed,
      ),
    });
    const recommended = job.recommendedPfDays ?? job.targetPfDays;
    const economics = {
      setupCost: job.economics?.setupCost ?? 0,
      dataCost: job.economics?.dataCost ?? 0,
      trainingCostAccrued:
        (job.economics?.trainingCostAccrued ?? 0) +
        (active ? (job.cashBurnPerDay ?? 0) : 0),
    };
    // Pause for decision when recommended compute is first reached.
    if (
      !job.awaitingDecision &&
      !job.paused &&
      job.progressPfDays + Math.max(0, trainPool) + 1e-9 >= recommended &&
      daysElapsed >= (job.minCalendarDays ?? 0) &&
      (job.extensionDays ?? 0) === 0
    ) {
      const nextProgress = Math.min(job.targetPfDays, recommended);
      return {
        ...job,
        ...telemetry(nextProgress),
        economics,
        daysElapsed,
        progressPfDays: nextProgress,
        awaitingDecision: true,
        paused: true,
        stallReason:
          "Recommended compute reached — release, keep internal, or extend 10 days.",
        lossHistory: appendLossPoint(
          job,
          "base",
          nextProgress / Math.max(1e-9, job.targetPfDays),
          state.day,
        ),
      };
    }
    const stallReason =
      job.paused || job.awaitingDecision
        ? job.awaitingDecision
          ? "Recommended compute reached — release, keep internal, or extend 10 days."
          : "Paused"
        : trainPool <= 1e-9
          ? trainingStallReason(state, snap, resources, resource)
          : null;
    if (job.paused || job.awaitingDecision) {
      return {
        ...job,
        ...telemetry(),
        economics,
        daysElapsed,
        stallReason,
      };
    }
    if (resource && (!resource.ramReady || !resource.systemRamReady)) {
      return {
        ...job,
        ...telemetry(),
        economics,
        daysElapsed,
        stallReason,
      };
    }
    if (job.progressPfDays < job.targetPfDays) {
      const nextProgress = Math.min(
        job.targetPfDays,
        job.progressPfDays + Math.max(0, trainPool),
      );
      if (
        failedAtCrossing(
          job,
          "base",
          job.progressPfDays,
          nextProgress,
          job.targetPfDays,
        )
      ) {
        return failTrainingJob(
          {
            ...job,
            ...telemetry(nextProgress),
            economics,
            daysElapsed,
            progressPfDays: nextProgress,
            lossHistory: appendLossPoint(
              job,
              "base",
              nextProgress / Math.max(1e-9, job.targetPfDays),
              state.day,
            ),
          },
          "base",
          state.day,
        );
      }
      return {
        ...job,
        ...telemetry(nextProgress),
        economics,
        daysElapsed,
        stallReason,
        progressPfDays: nextProgress,
        lossHistory: appendLossPoint(
          job,
          "base",
          nextProgress / Math.max(1e-9, job.targetPfDays),
          state.day,
        ),
      };
    }
    if (
      job.postTrain !== "none" &&
      job.postTrainProgress < job.postTrainTarget
    ) {
      const postTrainDaysElapsed = (job.postTrainDaysElapsed ?? 0) + 1;
      const postPool =
        (snap.pools.inference * 0.35) / jobs.length + trainPool * 0.25;
      const scale = 1 + Math.log10(Math.max(1, job.targetParamsB)) * 0.25;
      const nextProgress = Math.min(
        job.postTrainTarget,
        job.postTrainProgress + (postPool * 0.15) / scale,
      );
      const stageCompleted = nextProgress + 1e-9 >= job.postTrainTarget;
      const effectiveness = stageCompleted
        ? postTrainStageEffectiveness({
            job: {
              ...job,
              postTrainProgress: nextProgress,
              postTrainDaysElapsed,
            },
            stage: job.postTrain,
            researchUnlocked: state.player.researchUnlocked,
            models: state.player.models,
            progress: nextProgress,
            daysElapsed: postTrainDaysElapsed,
          })
        : undefined;
      if (
        failedAtCrossing(
          job,
          job.postTrain,
          job.postTrainProgress,
          nextProgress,
          job.postTrainTarget,
        )
      ) {
        return failTrainingJob(
          {
            ...job,
            ...telemetry(),
            economics,
            daysElapsed,
            postTrainProgress: nextProgress,
            postTrainDaysElapsed,
            lossHistory: appendLossPoint(
              job,
              job.postTrain,
              nextProgress / Math.max(1e-9, job.postTrainTarget),
              state.day,
            ),
          },
          job.postTrain,
          state.day,
        );
      }
      return {
        ...job,
        ...telemetry(),
        economics,
        daysElapsed,
        postTrainProgress: nextProgress,
        postTrainDaysElapsed,
        completedPostTrainStages: stageCompleted
          ? completedPostTrainStages({
              ...job,
              postTrainProgress: nextProgress,
            })
          : job.completedPostTrainStages,
        postTrainStageEffectiveness:
          stageCompleted && effectiveness != null
            ? {
                ...(job.postTrainStageEffectiveness ?? {}),
                [job.postTrain]: effectiveness,
              }
            : job.postTrainStageEffectiveness,
        lossHistory: appendLossPoint(
          job,
          job.postTrain,
          nextProgress / Math.max(1e-9, job.postTrainTarget),
          state.day,
        ),
      };
    }
    return {
      ...job,
      ...telemetry(),
      economics,
      daysElapsed,
      stallReason,
    };
  });
  const next = withTrainingJobs(state, nextJobs);
  const newlyFailed = nextJobs.filter(
    (job) => job.failed && !jobs.find((before) => before.id === job.id)?.failed,
  );
  return {
    ...next,
    player: { ...next.player, cash },
    alerts: [
      ...newlyFailed.map((job) => ({
        id: `train-failed-${job.id}-${state.day}`,
        day: state.day,
        severity: "danger" as const,
        message: `${job.name} failed during ${job.failureStage === "base" ? "base training" : `${job.failureStage?.toUpperCase()} post-training`}. The run is unrecoverable and must be deleted.`,
      })),
      ...state.alerts,
    ].slice(0, 40),
  };
}

export { formatParams, trainCostPfDays };

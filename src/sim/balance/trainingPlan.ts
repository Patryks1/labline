import type {
  LabId,
  ModelBackbone,
  ModelFamily,
  ModelProductPreset,
  TrainingComputePlan,
  TrainingJob,
  TrainingNumerics,
  TrainingPlan,
} from "../types";
import { hashSeed } from "../rng";
import { DEFAULT_TRAINING_NUMERICS } from "./trainingPrecision";

const DEFAULT_COMPUTE_PLAN: TrainingComputePlan = {
  source: "mixed",
  reservedPf: 0,
  computePriority: 50,
  activationCheckpointing: false,
};

export function trainingOutcomeSeed(input: {
  worldSeed: number;
  companyId: LabId;
  planId: string;
  backbone: ModelBackbone;
  productPreset: ModelProductPreset;
  createdDay: number;
}): number {
  return hashSeed(
    input.worldSeed,
    input.companyId,
    input.planId,
    input.backbone,
    input.productPreset,
    input.createdDay,
  );
}

export function freezeTrainingPlan(input: {
  id: string;
  companyId: LabId;
  name: string;
  productPreset: ModelProductPreset;
  backbone: ModelBackbone;
  totalParamsB: number;
  activeParamsB?: number;
  trainingNumerics: TrainingNumerics;
  dataRecipe: TrainingJob["dataPlan"];
  computePlan: TrainingComputePlan;
  teacherModelId?: string;
  distillationShare: number;
  integratedResearchIds: readonly string[];
  outcomeSeed: number;
  createdDay: number;
}): TrainingPlan {
  return structuredClone({
    id: input.id,
    companyId: input.companyId,
    name: input.name,
    productPreset: input.productPreset,
    backbone: input.backbone,
    totalParamsB: input.totalParamsB,
    activeParamsB: input.activeParamsB,
    trainingNumerics: input.trainingNumerics,
    dataRecipe: input.dataRecipe,
    computePlan: input.computePlan,
    teacherModelId: input.teacherModelId,
    distillationShare: Math.max(0, Math.min(1, input.distillationShare)),
    integratedResearchIds: [...input.integratedResearchIds].sort(),
    outcomeSeed: input.outcomeSeed,
    createdDay: input.createdDay,
  });
}

export function inferComputeSource(opts: {
  localPf: number;
  remotePf: number;
}): TrainingComputePlan["source"] {
  const local = Math.max(0, opts.localPf);
  const remote = Math.max(0, opts.remotePf);
  if (local > 0.05 && remote > 0.05) return "mixed";
  if (remote > local) return "cloud";
  return "local";
}

/**
 * Reconstruct a frozen plan from an existing job without calling RNG.
 * Used by save migration so in-flight runs keep their original decisions.
 */
export function hydrateFrozenTrainingPlan(
  job: TrainingJob,
  companyId: LabId,
): TrainingPlan {
  if (job.plan) {
    return {
      ...job.plan,
      dataRecipe: job.plan.dataRecipe ?? job.dataPlan,
      trainingNumerics:
        job.plan.trainingNumerics ??
        job.trainingNumerics ??
        job.numerics ??
        DEFAULT_TRAINING_NUMERICS,
      integratedResearchIds: [
        ...(job.plan.integratedResearchIds ?? job.integratedMethods ?? []),
      ].sort(),
    };
  }
  return freezeTrainingPlan({
    id: `plan-${job.id}`,
    companyId,
    name: job.name,
    productPreset: job.productPreset ?? "language",
    backbone: job.backbone ?? "dense",
    totalParamsB: job.targetParamsB,
    activeParamsB: job.activeParamsB,
    trainingNumerics:
      job.trainingNumerics ?? job.numerics ?? DEFAULT_TRAINING_NUMERICS,
    dataRecipe: job.dataPlan,
    computePlan: {
      ...DEFAULT_COMPUTE_PLAN,
      reservedPf: job.reservedPf ?? 0,
      computePriority: job.computePriority ?? 50,
      activationCheckpointing:
        job.integratedMethods?.includes("opt_checkpoint") === true,
    },
    teacherModelId: job.teacherId,
    distillationShare: job.distillTeacherShare ?? 0,
    integratedResearchIds: job.integratedMethods ?? [],
    outcomeSeed: job.outcomeSeed ?? 0,
    createdDay: 0,
  });
}

export function frozenResearchIds(
  job: Pick<TrainingJob, "plan" | "integratedMethods">,
): string[] {
  return [
    ...(job.plan?.integratedResearchIds ?? job.integratedMethods ?? []),
  ].sort();
}

export function architectureWorkMultiplier(
  family: ModelFamily,
  backbone?: ModelBackbone,
): number {
  if (family === "video") return 2.4;
  if (family === "diffusion") return 1.25;
  if (family === "omni") return 1.45 * 1.35;
  if (backbone === "moe" || family === "moe") return 1.08;
  return 1;
}

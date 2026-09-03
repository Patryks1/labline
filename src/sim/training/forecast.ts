import type { LabId, SimState } from "../types";
import { CASH_PER_PF_DAY_ESTIMATE, contextUnlockFor, maxContextKForUnlocks, trainingCompute } from "./compute";
import { TRAINING_V4 } from "./constants";
import { effectiveDataFor } from "./dataBridge";
import { hasUnlock, modifiersForLab } from "./modifiers";
import { sigmaFor } from "./outcome";
import {
  archCeiling,
  capabilityFromGap,
  distillGap,
  domainVectorFor,
  gapFromCapability,
  lossFor,
  overallCapability,
} from "./scaling";
import { trainingStateOf } from "./state";
import type {
  Architecture,
  Checkpoint,
  DesignMode,
  EffectiveDataBreakdown,
  Forecast,
  ForecastBlocker,
  ModelDesign,
  TrainingModifiers,
  TrainingSummary,
  TrainingUnlock,
} from "./types";

/** z for a one-sided 10/90 normal quantile (P(|Z|<z) ≈ 80%). */
const BAND_Z = 1.2816;

export function engineerFactorFor(state: SimState, labId: LabId): number {
  if (labId !== state.playerLabId) return 1;
  const engineers = Math.max(0, state.player.staff?.engineer ?? 0);
  const raw = 1.3 - 0.12 * Math.log2(1 + engineers);
  return Math.min(1.3, Math.max(0.75, raw));
}

export function utilForLab(state: SimState, labId: LabId): number {
  if (labId !== state.playerLabId) return 0.9;
  const cap = state.player.utilCap;
  return typeof cap === "number" && cap > 0 ? cap : 0.9;
}

export function holdoutTokensFor(design: ModelDesign): number {
  let rawMTok = 0;
  for (const mtok of Object.values(design.data.domainMTok)) {
    if (typeof mtok === "number" && mtok > 0) rawMTok += mtok;
  }
  return rawMTok * Math.max(0, design.data.holdoutShare) * 1e6;
}

export function scaleJumpLog10For(totalParamsB: number, biggestPriorParamsB: number): number {
  return Math.log10(Math.max(0, totalParamsB) / Math.max(0.05, biggestPriorParamsB));
}

/** Full design forecast: data bridge + modifiers + `forecastFromInputs`. */
export function forecastDesign(
  state: SimState,
  labId: LabId,
  design: ModelDesign,
): Forecast {
  const modifiers = modifiersForLab(state, labId);
  const effectiveData = effectiveDataFor(
    state,
    labId,
    design.data,
    design.arch,
    modifiers,
  );
  const training = trainingStateOf(state, labId);
  let teacherGap: number | undefined;
  if (design.mode.kind === "distill") {
    teacherGap = teacherGapFromLab(training.checkpoints, design.mode.teacherCheckpointId);
  }
  let parentSummary: TrainingSummary | undefined;
  let parent: Checkpoint | undefined;
  if (design.mode.kind === "continue") {
    const parentId = design.mode.parentCheckpointId;
    parent = training.checkpoints.find((row) => row.id === parentId);
    parentSummary = parent?.trainingSummary;
  }
  const forecast = forecastFromInputs({
    arch: design.arch,
    effectiveData,
    holdoutTokens: holdoutTokensFor(design),
    modifiers,
    pfPerDay: design.compute.pfPerDay,
    util: utilForLab(state, labId),
    mode: design.mode,
    teacherGap,
    parentSummary,
    sigmaContext: {
      biggestPriorParamsB: training.biggestTrainedParamsB,
      firstMoe: design.arch.backbone === "moe" && training.moeRunsCompleted === 0,
      engineerFactor: engineerFactorFor(state, labId),
    },
  });
  if (parent?.stage === "post") {
    return {
      ...forecast,
      blockers: [
        ...forecast.blockers,
        {
          code: "post_no_pretrain",
          message: "Post-trained weights can only take more post-training.",
        },
      ],
    };
  }
  return forecast;
}

function teacherGapFromLab(
  checkpoints: Checkpoint[],
  teacherCheckpointId: string,
): number | undefined {
  const teacher = checkpoints.find((row) => row.id === teacherCheckpointId);
  if (!teacher) return undefined;
  return gapFromCapability(overallCapability(teacher.truth));
}

/**
 * Pure forecast from already-resolved inputs. Capability band is P10/P50/P90
 * of `100 · exp(−capK · g_forecast · (1+ε))` with ε ~ N(0, σ) clamped ±2.5σ.
 * Distill uses `distillGap`; continue inherits parent loss/data context.
 */
export function forecastFromInputs(input: {
  arch: Architecture;
  effectiveData: EffectiveDataBreakdown;
  holdoutTokens: number;
  modifiers: TrainingModifiers;
  pfPerDay: number;
  util: number;
  mode: DesignMode;
  teacherGap?: number;
  parentSummary?: TrainingSummary;
  sigmaContext: {
    biggestPriorParamsB: number;
    firstMoe: boolean;
    engineerFactor: number;
  };
}): Forecast {
  const { arch, modifiers, mode, sigmaContext } = input;
  const parentTokens =
    mode.kind === "continue" && input.parentSummary
      ? input.parentSummary.effectiveMTok * 1e6
      : 0;
  const dEff = input.effectiveData.effectiveMTok * 1e6 + parentTokens;
  const ownLoss = lossFor(arch, dEff, modifiers);
  let gap = ownLoss.gap;
  if (mode.kind === "distill" && input.teacherGap != null) {
    gap = distillGap(input.teacherGap, ownLoss.gap, modifiers);
  }
  const loss = { ...ownLoss, gap };

  let compute = trainingCompute(
    arch,
    input.effectiveData.rawMTok * 1e6,
    input.holdoutTokens,
    modifiers,
    input.pfPerDay,
    input.util,
  );
  if (mode.kind === "distill") {
    const trainPfDays = compute.trainPfDays * TRAINING_V4.distill.computeMult;
    const totalPfDays = trainPfDays + compute.holdoutPfDays;
    const denom = input.pfPerDay * input.util * compute.throughput;
    const days =
      input.pfPerDay <= 0 || !(denom > 0)
        ? Number.POSITIVE_INFINITY
        : Math.max(compute.paceFloorDays, totalPfDays / denom);
    compute = {
      ...compute,
      trainPfDays,
      totalPfDays,
      days,
      cashEstimate: totalPfDays * CASH_PER_PF_DAY_ESTIMATE,
    };
  }

  const sigma = sigmaFor({
    modifiers,
    precision: arch.precision,
    firstMoe: sigmaContext.firstMoe && arch.backbone === "moe",
    scaleJumpLog10: scaleJumpLog10For(
      arch.totalParamsB,
      sigmaContext.biggestPriorParamsB,
    ),
    engineerFactor: sigmaContext.engineerFactor,
  });
  const ceiling = archCeiling(arch, modifiers);
  const p50 = capabilityFromGap(gap, arch, modifiers);
  const p10 = capabilityFromGap(gap * (1 + BAND_Z * sigma), arch, modifiers);
  const p90 = capabilityFromGap(gap * (1 - BAND_Z * sigma), arch, modifiers);
  const truth = domainVectorFor(
    p50,
    arch,
    input.effectiveData.domainMix,
    modifiers,
  );

  return {
    compute,
    loss,
    effectiveData: input.effectiveData,
    capability: { p10, p50, p90, ceiling, sigma },
    domains: truth.domains,
    blockers: blockersFor(input),
    warnings: warningsFor(input, dEff, sigmaContext),
  };
}

function blockersFor(input: {
  arch: Architecture;
  effectiveData: EffectiveDataBreakdown;
  modifiers: TrainingModifiers;
  pfPerDay: number;
  mode: DesignMode;
}): ForecastBlocker[] {
  const { arch, modifiers } = input;
  const blockers: ForecastBlocker[] = [];
  const lock = (code: string, unlock: TrainingUnlock, message: string) => {
    if (!hasUnlock(modifiers, unlock)) blockers.push({ code, message });
  };

  if (!(input.effectiveData.effectiveMTok > 0)) {
    blockers.push({ code: "no_data", message: "No effective training tokens in this mix." });
  }
  if (!(input.pfPerDay > 0)) {
    blockers.push({ code: "no_compute", message: "Allocated petaflops per day is zero." });
  }
  if (arch.backbone === "moe") {
    lock("locked_moe", "moe", "Mixture-of-experts training is still locked.");
  }
  if (arch.precision === "fp16_mixed") {
    lock("locked_fp16", "fp16_train", "FP16 training is still locked.");
  }
  if (arch.precision === "bf16_mixed") {
    lock("locked_bf16", "bf16_train", "BF16 training is still locked.");
  }
  if (arch.precision === "fp8_hybrid") {
    lock("locked_fp8", "fp8_train", "FP8 training is still locked.");
  }
  if (arch.precision === "fp6") {
    lock("locked_fp6", "fp6_train", "FP6 training is still locked.");
  }
  if (arch.precision === "nvfp4") {
    lock("locked_nvfp4", "nvfp4_train", "NVFP4 training is still locked.");
  }
  if (arch.preset === "omni") {
    lock("locked_omni", "omni", "Omni architectures are still locked.");
  }
  if (needsVision(arch)) {
    lock("locked_vision", "vision", "Vision inputs or outputs require the vision unlock.");
  }
  if (needsAudio(arch)) {
    lock("locked_audio", "audio", "Audio inputs or outputs require the audio unlock.");
  }
  if (needsVideo(arch)) {
    lock("locked_video", "video", "Video inputs or outputs require the video unlock.");
  }
  if (input.mode.kind === "distill") {
    lock("locked_distill", "distill", "Distillation is still locked.");
  }
  if (input.mode.kind === "continue") {
    lock("locked_continued_pretrain", "continued_pretrain", "Continued pretraining is still locked.");
  }
  const contextK = arch.contextK ?? TRAINING_V4.context.baseK;
  if (contextK > maxContextKForUnlocks(modifiers.unlocks)) {
    const unlock = contextUnlockFor(contextK);
    if (unlock) {
      lock(
        `locked_${unlock}`,
        unlock,
        `Context above ${maxContextKForUnlocks(modifiers.unlocks)}k requires ${unlock.replaceAll("_", " ")} research.`,
      );
    }
  }
  return blockers;
}

function needsVision(arch: Architecture): boolean {
  return (
    arch.preset === "vision_language" ||
    arch.preset === "image_generation" ||
    arch.inputs.includes("image") ||
    arch.outputs.includes("image")
  );
}

function needsAudio(arch: Architecture): boolean {
  return (
    arch.preset === "audio" ||
    arch.inputs.includes("audio") ||
    arch.outputs.includes("audio")
  );
}

function needsVideo(arch: Architecture): boolean {
  return (
    arch.preset === "video_generation" ||
    arch.inputs.includes("video") ||
    arch.outputs.includes("video")
  );
}

function warningsFor(
  input: {
    arch: Architecture;
    effectiveData: EffectiveDataBreakdown;
    sigmaContext: { biggestPriorParamsB: number; firstMoe: boolean };
  },
  dEff: number,
  sigmaContext: { biggestPriorParamsB: number; firstMoe: boolean },
): string[] {
  const warnings: string[] = [];
  const nTotal = Math.max(0, input.arch.totalParamsB) * TRAINING_V4.compute.paramsPerBillion;
  const tokensPerParam = nTotal > 0 ? dEff / nTotal : 0;
  if (tokensPerParam > 0 && tokensPerParam < 5) {
    warnings.push("Undertrained: fewer than 5 tokens per parameter.");
  }
  if (tokensPerParam > 100) {
    warnings.push("Diminishing returns: more than 100 tokens per parameter.");
  }
  if (input.effectiveData.syntheticShare > 0.5) {
    warnings.push("Synthetic data is more than half of the mix.");
  }
  if (sigmaContext.firstMoe && input.arch.backbone === "moe") {
    warnings.push("First MoE run for this lab; outcome noise is higher.");
  }
  const jump = input.arch.totalParamsB / Math.max(0.05, sigmaContext.biggestPriorParamsB);
  if (jump > 10) {
    warnings.push("Scale jump exceeds 10× the lab's largest prior run.");
  }
  if (input.arch.precision === "fp8_hybrid") {
    warnings.push("FP8 trains faster and cheaper, but the capability gap is hard to close.");
  }
  if (input.arch.precision === "fp6") {
    warnings.push("FP6 is cheap to train and host, at a steep capability cost versus BF16.");
  }
  if (input.arch.precision === "nvfp4") {
    warnings.push("NVFP4 trains faster but pays a steep capability penalty.");
  }
  return warnings;
}

import { cloudListPriceEscalation } from "../balance/cloudPricing";
import { CONTEXT_UNLOCK_BANDS, TRAINING_V4 } from "./constants";
import type { Architecture, ComputeBreakdown, TrainingModifiers, TrainingUnlock } from "./types";

export { CONTEXT_STOPS, CONTEXT_UNLOCK_BANDS } from "./constants";

/**
 * Era-0 Northstar on-demand list price ($/PF-day). `cloudPricing.ts` only
 * exposes the secular escalation multiplier, not a base rate — the $120
 * launch contract / provider list is the planning prior.
 */
export const CASH_PER_PF_DAY_ESTIMATE = 120;

/** Cloud $/PF-day at a campaign day and industry demand pressure (0–1). */
export function cashPerPfDayEstimate(day = 0, demandPressure = 0): number {
  return CASH_PER_PF_DAY_ESTIMATE * cloudListPriceEscalation(day, demandPressure);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function contextScale(contextK: number | undefined, exponent: number): number {
  const base = TRAINING_V4.context.baseK;
  const k = Math.max(base, contextK ?? base);
  return (k / base) ** exponent;
}

/** Attention/sequence tax on train PF-days. 4k = 1. */
export function contextTrainCost(contextK?: number): number {
  return contextScale(contextK, TRAINING_V4.context.trainCostExp);
}

/** Extra train HBM from long activations. 4k = 1. */
export function contextTrainHbm(contextK?: number): number {
  return contextScale(contextK, TRAINING_V4.context.trainHbmExp);
}

/** Decode/prefill tax baked into hosted inferCostMult. 4k = 1. */
export function contextServeCost(contextK?: number): number {
  return contextScale(contextK, TRAINING_V4.context.serveCostExp);
}

export function contextUnlockFor(contextK: number | undefined): TrainingUnlock | null {
  const k = Math.max(0, contextK ?? TRAINING_V4.context.baseK);
  for (const band of CONTEXT_UNLOCK_BANDS) {
    if (k <= band.maxK) return band.unlock;
  }
  return CONTEXT_UNLOCK_BANDS[CONTEXT_UNLOCK_BANDS.length - 1]?.unlock ?? null;
}

export function maxContextKForUnlocks(unlocks: readonly TrainingUnlock[]): number {
  const set = new Set(unlocks);
  let max: number = TRAINING_V4.context.baseK;
  for (const band of CONTEXT_UNLOCK_BANDS) {
    if (band.unlock == null || set.has(band.unlock)) {
      max = band.maxK;
      continue;
    }
    break;
  }
  return max;
}

function activeParams(arch: Architecture): number {
  if (arch.backbone === "moe") {
    return Math.max(0, Math.min(arch.activeParamsB, arch.totalParamsB)) *
      TRAINING_V4.compute.paramsPerBillion;
  }
  return Math.max(0, arch.totalParamsB) * TRAINING_V4.compute.paramsPerBillion;
}

/**
 * PF-days from 6 · N_active · D / flopsPerPfDay · archCost · modalityCost,
 * plus holdout (holdoutMultiplier · N · D_holdout), then calendar days from
 * allocated PF, util, precision throughput, and research computeThroughput,
 * clamped to paceFloorDays(N_total).
 *
 * `trainTokens` / `holdoutTokens` are RAW token counts, not millions.
 */
export function trainingCompute(
  arch: Architecture,
  trainTokens: number,
  holdoutTokens: number,
  modifiers: TrainingModifiers,
  pfPerDay: number,
  util: number,
): ComputeBreakdown {
  const { flopFactor, flopsPerPfDay, holdoutMultiplier } = TRAINING_V4.compute;
  const nActive = activeParams(arch);
  const archCost = TRAINING_V4.archCost[arch.backbone];
  const modalityCost = TRAINING_V4.modalityCost[arch.preset];
  const contextCost = contextTrainCost(arch.contextK);
  const trainPfDays =
    (flopFactor * nActive * Math.max(0, trainTokens) / flopsPerPfDay) *
    archCost *
    modalityCost *
    contextCost;
  const holdoutPfDays =
    (holdoutMultiplier * nActive * Math.max(0, holdoutTokens)) / flopsPerPfDay;
  const totalPfDays = trainPfDays + holdoutPfDays;
  const throughput =
    TRAINING_V4.precision.throughput[arch.precision] * modifiers.computeThroughput;
  const floor = paceFloorDays(arch.totalParamsB);
  const denom = pfPerDay * util * throughput;
  const days =
    pfPerDay <= 0 || !(denom > 0)
      ? Number.POSITIVE_INFINITY
      : Math.max(floor, totalPfDays / denom);
  return {
    trainPfDays,
    holdoutPfDays,
    totalPfDays,
    archCost,
    modalityCost,
    throughput,
    days,
    paceFloorDays: floor,
    trainHbmGB: trainHbmGB(arch),
    cashEstimate: totalPfDays * CASH_PER_PF_DAY_ESTIMATE,
  };
}

/** clamp(8 · (N_total_B / 7)^0.3, 3, 120). */
export function paceFloorDays(totalParamsB: number): number {
  const { scale, exponent, minDays, maxDays, referenceParamsB } = TRAINING_V4.paceFloor;
  if (!(totalParamsB > 0)) return minDays;
  const raw = scale * (totalParamsB / referenceParamsB) ** exponent;
  return clamp(raw, minDays, maxDays);
}

/** Train HBM from total params × trainBytesPerParam (optimizer state included). */
export function trainHbmGB(arch: Architecture): number {
  const bytes = TRAINING_V4.precision.trainBytesPerParam[arch.precision];
  return Math.max(0, arch.totalParamsB) * bytes * contextTrainHbm(arch.contextK);
}

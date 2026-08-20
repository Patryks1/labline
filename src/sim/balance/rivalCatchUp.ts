/**
 * Competitive catch-up is a hazard, not a same-day lock. Player domination
 * raises the daily chance a challenger arms; once armed it persists through
 * that training campaign. Every curve is smooth with a nonzero floor while
 * pressure is present.
 */

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

function smootherstep(t: number): number {
  const x = clamp01(t)
  return x * x * x * (x * (x * 6 - 15) + 10)
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

export const CATCH_UP_HAZARD_MIN = 0.03
export const CATCH_UP_HAZARD_MAX = 0.08
/** Soft eligibility floor — below this the challenger will not newly arm. */
export const CATCH_UP_ELIGIBLE_PRESSURE = 0.12
/** Stale-flagship inflection (days). Hash jitter is applied by the caller. */
export const FRONTIER_STALE_INFLECTION_DAYS = 125
export const FRONTIER_STALE_WIDTH_DAYS = 28

export interface CatchUpPressureInput {
  playerShare: number
  shareGap: number
  capabilityGap: number
  frontierAgeDays: number
  /** Hash-jittered inflection; defaults to 125. */
  frontierStaleAfterDays?: number
}

export function frontierStaleWeight(
  ageDays: number,
  inflectionDays = FRONTIER_STALE_INFLECTION_DAYS,
): number {
  const width = FRONTIER_STALE_WIDTH_DAYS
  return sigmoid((ageDays - inflectionDays) / (width / 4))
}

/**
 * 0–1 pressure from share lead, capability lead, and a probability-shaped
 * stale flagship. None of the terms is a hard cutoff.
 */
export function catchUpPressure(input: CatchUpPressureInput): number {
  const shareTerm = smootherstep((input.playerShare - 0.38) / 0.34)
  const gapTerm = smootherstep((input.shareGap - 0.08) / 0.32)
  const capTerm = smootherstep((input.capabilityGap - 3) / 16)
  const domination = shareTerm * (0.5 + 0.5 * Math.max(gapTerm, capTerm))
  const stale = frontierStaleWeight(
    input.frontierAgeDays,
    input.frontierStaleAfterDays ?? FRONTIER_STALE_INFLECTION_DAYS,
  )
  return clamp01(Math.max(domination, stale * (0.55 + 0.45 * Math.max(shareTerm, 0.35))))
}

/** Daily arm chance while eligible. Scales 3–8% with pressure. */
export function catchUpHazard(pressure: number): number {
  const p = clamp01(pressure)
  return CATCH_UP_HAZARD_MIN + (CATCH_UP_HAZARD_MAX - CATCH_UP_HAZARD_MIN) * p
}

export function catchUpEligible(pressure: number): boolean {
  return pressure >= CATCH_UP_ELIGIBLE_PRESSURE
}

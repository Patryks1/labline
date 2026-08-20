/**
 * Interactive token-speed satisfaction. Users notice streams below ~30 tok/s
 * (a typical chat reply feels sluggish) but demand never cliffs to zero —
 * the knee is a sigmoid, not a cutoff. Dense multi-trillion models sit below
 * the knee unless served as MoE with a small active set.
 */

export const TOKEN_SPEED_KNEE = 30
/** Sigmoid width around the knee: ~10 tok/s is severe, ~45 is comfortable. */
export const TOKEN_SPEED_SIGMOID_WIDTH = 8
/** Brand pressure begins when a busy endpoint is this slow. */
export const TOKEN_SPEED_BRAND_THRESHOLD = 15

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** 0–1 satisfaction; 0.5 at the 30 tok/s knee. Always strictly between 0 and 1. */
export function tokenSpeedSatisfaction(tokPerSec: number): number {
  const t = Math.max(0, tokPerSec)
  return 1 / (1 + Math.exp(-(t - TOKEN_SPEED_KNEE) / TOKEN_SPEED_SIGMOID_WIDTH))
}

/**
 * Throughput contribution to the 0–50 tok score blended into offer speed.
 * The sigmoid carries the bulk; a diminishing log bonus rewards 60+ and
 * barely 120+, matching the previous 0–50 magnitude so segment weights stay
 * calibrated.
 */
export function tokenThroughputScore(tokPerSec: number): number {
  const t = Math.max(0, tokPerSec)
  const sat = tokenSpeedSatisfaction(t)
  const extra =
    t <= TOKEN_SPEED_KNEE ? 0 : Math.log10(1 + (t - TOKEN_SPEED_KNEE) / 30) * 8
  return Math.min(50, sat * 42 + extra)
}

/**
 * Smoothstep of the deficit below the knee. Zero at/above 30 tok/s; free
 * users are about half as sensitive as paid.
 */
export function planTokenSpeedDissatisfaction(
  tokPerSec: number,
  isFree: boolean,
): number {
  const t = Math.max(0, tokPerSec)
  const gap = clamp01((TOKEN_SPEED_KNEE - t) / TOKEN_SPEED_KNEE)
  const smooth = gap * gap * (3 - 2 * gap)
  return smooth * (isFree ? 0.28 : 0.55)
}

/**
 * Daily brand hit from a busy endpoint below ~15 tok/s. Smooth and small —
 * never a death spiral from speed alone.
 */
export function tokenSpeedBrandPressure(tokPerSec: number): number {
  const t = Math.max(0, tokPerSec)
  return 0.32 / (1 + Math.exp((t - 10) / 3.2))
}

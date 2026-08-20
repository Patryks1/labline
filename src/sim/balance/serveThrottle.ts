import type { ServeThrottlePolicy } from '../types'
import { planTokenSpeedDissatisfaction } from './tokenSpeed'

/**
 * Overload throttle math — the day-granularity interpretation:
 * capacity is physics (the ledger never serves more PF than exists), so the
 * policy decides what the UNSERVED fraction experienced:
 *
 * - 'shed': errors/timeouts. Full service pain, churn, and demand spillover.
 * - 'throttle': slow streams. Tokens eventually flow, so churn/pain/spillover
 *   are muted — but speedStrain rises and tomorrow's offers are slower
 *   (demand cools through the speed/latency utility terms instead).
 * - 'balanced': the first ~25 points of overload are throttled, the rest shed.
 * - 'surge': same absorb curve as balanced, plus a posted API price hike.
 */

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/**
 * Share of today's unserved demand that is absorbed as slowness rather than
 * rejected. Balanced absorbs up to 25% overload fully, then sheds the margin.
 */
export function throttleAbsorbShare(
  policy: ServeThrottlePolicy,
  unservedRatio: number,
): number {
  const u = clamp01(unservedRatio)
  if (u <= 1e-9) return 0
  switch (policy) {
    case 'shed':
      return 0
    case 'throttle':
      return 1
    case 'balanced':
    case 'surge':
    default:
      return Math.min(1, 0.25 / u)
  }
}

/** EMA of stream slowness. Rises with absorbed overload, heals with headroom. */
export function nextSpeedStrain(
  prevStrain: number,
  unservedRatio: number,
  absorbShare: number,
): number {
  const s = clamp01(prevStrain)
  const absorbed = clamp01(unservedRatio) * clamp01(absorbShare)
  if (absorbed > 0.02) return Math.min(1, s * 0.7 + absorbed * 0.9)
  return Math.max(0, s * 0.6 - 0.03)
}

/** tokPerSec multiplier from strain: full strain ≈ 40% of normal speed. */
export function strainSpeedFactor(strain: number): number {
  return 1 - 0.6 * clamp01(strain)
}

/** Latency-score multiplier from strain (0–100 latency score space). */
export function strainLatencyFactor(strain: number): number {
  return 1 - 0.35 * clamp01(strain)
}

/**
 * Churn damping while throttling: throttled demand churns at ~35% of the
 * shed rate (their tokens arrived, just slowly).
 */
export function throttleChurnScale(absorbShare: number): number {
  return 1 - 0.65 * clamp01(absorbShare)
}

/**
 * Pain damping while throttling: queueing instead of errors hurts ~quarter
 * as much per unserved token.
 */
export function throttlePainScale(absorbShare: number): number {
  return 1 - 0.75 * clamp01(absorbShare)
}

/**
 * Spillover damping while throttling: most throttled users wait rather than
 * walking to a rival — but ~40% still walk.
 */
export function throttleSpillScale(absorbShare: number): number {
  return 1 - 0.6 * clamp01(absorbShare)
}

/**
 * Peak-pricing EMA. Mirrors stream-strain: rises with unserved load, heals
 * when headroom returns. Only 'surge' policy accumulates; other policies decay.
 */
export function nextSurgeLevel(
  prev: number,
  unservedRatio: number,
  policy: ServeThrottlePolicy,
): number {
  if (policy !== 'surge') return Math.max(0, clamp01(prev) * 0.6 - 0.03)
  return nextSpeedStrain(prev, unservedRatio, throttleAbsorbShare('balanced', unservedRatio))
}

/** Posted API price multiplier: 1 + min(0.8, ema * 1.6). */
export function surgePriceMultiplier(level: number): number {
  return 1 + Math.min(0.8, Math.max(0, level) * 1.6)
}

/** Small gouging-perception brand hit while a posted surge is live. */
export function surgeBrandPressure(multiplier: number): number {
  return Math.max(0, multiplier - 1) * 0.15
}

/**
 * Plan dissatisfaction from slow streams. Strain is overload throttling;
 * optional tokPerSec adds the 30 tok/s knee (free users ~half as sensitive).
 * The two combine smoothly; omitting tokPerSec preserves the strain-only curve.
 */
export function planSlownessDissatisfaction(
  strain: number,
  isFree: boolean,
  tokPerSec?: number,
): number {
  const strainPart = Math.min(0.6, clamp01(strain) * (isFree ? 0.35 : 0.7))
  const speedPart =
    tokPerSec == null ? 0 : planTokenSpeedDissatisfaction(tokPerSec, isFree)
  return Math.min(0.85, 1 - (1 - strainPart) * (1 - speedPart))
}

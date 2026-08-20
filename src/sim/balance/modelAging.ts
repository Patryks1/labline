import { emptyBenchmarks } from './benchmarks'
import type { BenchmarkScores } from '../types'

/**
 * Market-facing model aging. The field moves on — customer prompts, tooling,
 * and eval distributions drift — so a shipped checkpoint slowly looks worse
 * without mutating the stored weights. Grace, then a smooth ramp, then a cap.
 */

export const MODEL_AGE_GRACE_DAYS = 45
/** Characteristic slope after the grace takeoff. */
export const MODEL_AGE_POINTS_PER_30_DAYS = 0.9
export const MODEL_AGE_PENALTY_CAP = 14
/** Benchmarks lose this fraction of (penalty / raw capability). */
export const MODEL_AGE_BENCHMARK_FRACTION = 0.85
/** Days of C2 takeoff so the grace edge has no kink. */
const MODEL_AGE_TAKEOFF_DAYS = 22

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

function smootherstep(t: number): number {
  const x = clamp01(t)
  return x * x * x * (x * (x * 6 - 15) + 10)
}

export function modelAgeDays(releaseDay: number | undefined, day: number): number {
  if (releaseDay == null || !Number.isFinite(releaseDay)) return 0
  return Math.max(0, day - releaseDay)
}

/**
 * Capability-point penalty. 0 through the grace window, then ~0.9 / 30 days,
 * capped at 14. The takeoff is a smootherstep so the first derivative is 0
 * at the grace boundary.
 */
export function modelAgePenalty(ageDays: number): number {
  const elapsed = Math.max(0, ageDays) - MODEL_AGE_GRACE_DAYS
  if (elapsed <= 0) return 0
  const linear = elapsed * (MODEL_AGE_POINTS_PER_30_DAYS / 30)
  const takeoff = smootherstep(elapsed / MODEL_AGE_TAKEOFF_DAYS)
  return Math.min(MODEL_AGE_PENALTY_CAP, linear * takeoff)
}

export function agedCapability(rawCapability: number, ageDays: number): number {
  return Math.max(0, rawCapability - modelAgePenalty(ageDays))
}

export function agedBenchmarks(
  raw: BenchmarkScores | undefined,
  rawCapability: number,
  ageDays: number,
): BenchmarkScores {
  const base = raw ?? emptyBenchmarks()
  const penalty = modelAgePenalty(ageDays)
  const frac =
    rawCapability > 1e-6
      ? Math.min(1, (penalty / rawCapability) * MODEL_AGE_BENCHMARK_FRACTION)
      : 0
  const keep = 1 - frac
  const next = { ...emptyBenchmarks() }
  for (const key of Object.keys(base) as (keyof BenchmarkScores)[]) {
    next[key] = Math.max(0, (base[key] ?? 0) * keep)
  }
  return next
}

export function agedMarketView(
  model: {
    capability: number
    benchmarks?: BenchmarkScores
    releaseDay?: number
  },
  day: number,
): { capability: number; benchmarks: BenchmarkScores; penalty: number; ageDays: number } {
  const ageDays = modelAgeDays(model.releaseDay, day)
  const penalty = modelAgePenalty(ageDays)
  return {
    capability: agedCapability(model.capability, ageDays),
    benchmarks: agedBenchmarks(model.benchmarks, model.capability, ageDays),
    penalty,
    ageDays,
  }
}

export function modelFreshnessLabel(ageDays: number): string | null {
  const penalty = modelAgePenalty(ageDays)
  if (penalty <= 0.05) return null
  if (penalty < 4) return 'Aging'
  if (penalty < 10) return 'Stale'
  return 'Dated'
}

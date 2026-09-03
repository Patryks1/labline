import { emptyBenchmarks } from './benchmarks'
import type { BenchmarkScores, SimState } from '../types'

/**
 * Market-facing model aging. The field moves on — customer prompts, tooling,
 * and eval distributions drift — so a shipped checkpoint slowly looks worse
 * without mutating the stored weights. Grace, then a smooth ramp, then a cap.
 */

export const MODEL_AGE_GRACE_DAYS = 45
/** Characteristic slope after the grace takeoff. */
export const MODEL_AGE_POINTS_PER_30_DAYS = 0.9
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
 * Capability-point penalty. 0 through the grace window, then ~0.9 / 30 days
 * with no ceiling: ancient models decay to zero capability procedurally
 * (via the max(0, …) clamp in agedCapability) instead of freezing at a
 * permanent 14-point discount. The takeoff is a smootherstep so the first
 * derivative is 0 at the grace boundary.
 */
export function modelAgePenalty(ageDays: number): number {
  const elapsed = Math.max(0, ageDays) - MODEL_AGE_GRACE_DAYS
  if (elapsed <= 0) return 0
  const linear = elapsed * (MODEL_AGE_POINTS_PER_30_DAYS / 30)
  const takeoff = smootherstep(elapsed / MODEL_AGE_TAKEOFF_DAYS)
  return linear * takeoff
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

/**
 * Fleet-card aging (0–1). Independent of the market capability penalty:
 * a live endpoint becomes irrelevant for copying a training formula after
 * ~360 days, and the clock runs a bit faster when competitors ship more
 * often than a 90-day cadence or leapfrog this endpoint's capability.
 */
export const FLEET_AGE_IRRELEVANT_DAYS = 360
/** Expected rival-ship interval used as the "normal" field pace. */
export const FLEET_AGE_RIVAL_CADENCE_DAYS = 90
/** Maximum extra clock speed from a hot rival cadence. */
export const FLEET_AGE_PACE_CAP = 0.35
/** Copy-formula lock once the endpoint is effectively stale. */
export const FLEET_AGE_COPY_LOCK = 0.95

export interface FleetRivalShip {
  day: number
  capability: number
}

function shipIsReleased(model: { shipped?: boolean; release?: string }): boolean {
  return Boolean(model.shipped) || model.release === 'released'
}

function checkpointCapability(
  training: NonNullable<SimState['rivals'][number]['training']> | undefined,
  checkpointId: string,
): number | undefined {
  const lang = training?.checkpoints.find((row) => row.id === checkpointId)?.truth.domains.language
  return typeof lang === 'number' && Number.isFinite(lang) ? lang : undefined
}

function endpointCapability(
  training: NonNullable<SimState['rivals'][number]['training']> | undefined,
  endpoint: { members: { checkpointId: string }[]; modelId?: string },
  models: { id: string; capability: number }[],
): number {
  const model = endpoint.modelId ? models.find((row) => row.id === endpoint.modelId) : undefined
  if (model && Number.isFinite(model.capability)) return model.capability
  let sum = 0
  let n = 0
  for (const member of endpoint.members) {
    const cap = checkpointCapability(training, member.checkpointId)
    if (cap == null) continue
    sum += cap
    n += 1
  }
  return n > 0 ? sum / n : 0
}

/** Competitor releases that can accelerate a player endpoint's fleet aging. */
export function competitorShips(state: SimState, exceptLabId: string): FleetRivalShip[] {
  const ships: FleetRivalShip[] = []
  const seen = new Set<string>()

  const push = (key: string, day: number, capability: number) => {
    if (!Number.isFinite(day) || day < 0) return
    if (seen.has(key)) return
    seen.add(key)
    ships.push({
      day,
      capability: Number.isFinite(capability) ? capability : 0,
    })
  }

  for (const rival of state.rivals ?? []) {
    if (rival.id === exceptLabId) continue
    const models = rival.models ?? []
    for (const model of models) {
      if (!shipIsReleased(model)) continue
      push(`m:${rival.id}:${model.id}`, model.releaseDay, model.capability)
    }
    for (const milestone of rival.releaseMilestones ?? []) {
      const model = models.find((row) => row.id === milestone.modelId)
      push(`m:${rival.id}:${milestone.modelId}`, milestone.releaseDay, model?.capability ?? 0)
    }
    const training = rival.training
    for (const endpoint of training?.endpoints ?? []) {
      if (endpoint.status === 'retired') continue
      const modelKey = endpoint.modelId ? `m:${rival.id}:${endpoint.modelId}` : null
      if (modelKey && seen.has(modelKey)) continue
      push(
        modelKey ?? `e:${rival.id}:${endpoint.id}`,
        endpoint.releaseDay,
        endpointCapability(training, endpoint, models),
      )
    }
  }

  return ships
}

function rivalPace(input: {
  ageDays: number
  releaseDay: number
  day: number
  rivalShips: readonly FleetRivalShip[]
  ownCapability: number
}): number {
  const shipsAfter = input.rivalShips.filter(
    (ship) => ship.day > input.releaseDay && ship.day <= input.day,
  )
  const expected = input.ageDays / FLEET_AGE_RIVAL_CADENCE_DAYS
  const surplus = Math.max(0, shipsAfter.length - expected)
  const leapCount = shipsAfter.filter((ship) => ship.capability > input.ownCapability + 0.5).length
  const heat = surplus + 0.45 * leapCount
  return 1 + FLEET_AGE_PACE_CAP * (1 - Math.exp(-heat / 2.2))
}

/** 0–1 fleet irrelevance. 1 means the recipe is too stale to copy into a new run. */
export function fleetAgingFraction(input: {
  releaseDay: number
  day: number
  rivalShips?: readonly FleetRivalShip[]
  ownCapability?: number
}): number {
  const ageDays = modelAgeDays(input.releaseDay, input.day)
  if (ageDays <= 0) return 0
  const pace = rivalPace({
    ageDays,
    releaseDay: input.releaseDay,
    day: input.day,
    rivalShips: input.rivalShips ?? [],
    ownCapability: input.ownCapability ?? 0,
  })
  return clamp01((ageDays * pace) / FLEET_AGE_IRRELEVANT_DAYS)
}

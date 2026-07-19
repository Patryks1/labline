import type { MilestoneId, RivalArchetype, SimState } from '../types'
import { runPlayBot } from './bot'

export type StrategyId = 'balanced_cloud' | RivalArchetype

export interface StrategyCalibrationSummary {
  seeds: number
  days: number
  successfulPrimaryTitles: number
  unresolvedPrimaryTitles: number
  reportsGenerated: number
  bankruptRuns: number
  shortestRunDay: number
  winnerCounts: Partial<Record<StrategyId, number>>
  titleWinnerCounts: Record<
    'frontier_leader' | 'abundance_leader',
    Partial<Record<StrategyId, number>>
  >
  winnerShares: Partial<Record<StrategyId, number>>
  dominantStrategy: StrategyId | null
  dominantShare: number
}

const PRIMARY_TITLES = new Set<MilestoneId>([
  'frontier_leader',
  'abundance_leader',
])

export function strategyForLab(state: SimState, labId: string): StrategyId | null {
  if (labId === state.playerLabId) return 'balanced_cloud'
  return state.rivals.find((rival) => rival.id === labId)?.archetype ?? null
}

/**
 * Opt-in decade balance harness. It counts first-to-title records rather than
 * short-run capability rank, matching the campaign's actual primary races.
 */
export function runStrategyCalibration(opts: {
  seeds?: number
  days?: number
  seedOffset?: number
} = {}): StrategyCalibrationSummary {
  const seeds = Math.max(1, Math.floor(opts.seeds ?? 50))
  const days = Math.max(1, Math.floor(opts.days ?? 4_017))
  const seedOffset = Math.floor(opts.seedOffset ?? 0)
  const winnerCounts: Partial<Record<StrategyId, number>> = {}
  const titleWinnerCounts: StrategyCalibrationSummary['titleWinnerCounts'] = {
    frontier_leader: {},
    abundance_leader: {},
  }
  let successfulPrimaryTitles = 0
  let unresolvedPrimaryTitles = 0
  let reportsGenerated = 0
  let bankruptRuns = 0
  let shortestRunDay = Number.POSITIVE_INFINITY

  for (let index = 0; index < seeds; index++) {
    const report = runPlayBot({
      seed: seedOffset + index + 1,
      maxDays: days,
      difficulty: 'normal',
    })
    const state = report.final
    if (report.bankrupt) bankruptRuns++
    shortestRunDay = Math.min(shortestRunDay, state.day)
    if (state.progression.decadeReport) reportsGenerated++
    for (const milestone of state.progression.milestones) {
      if (!PRIMARY_TITLES.has(milestone.id)) continue
      if (milestone.achievedDay == null || !milestone.firstLabId) {
        unresolvedPrimaryTitles++
        continue
      }
      const strategy = strategyForLab(state, milestone.firstLabId)
      if (!strategy) {
        unresolvedPrimaryTitles++
        continue
      }
      successfulPrimaryTitles++
      winnerCounts[strategy] = (winnerCounts[strategy] ?? 0) + 1
      if (milestone.id === 'frontier_leader' || milestone.id === 'abundance_leader') {
        const titleCounts = titleWinnerCounts[milestone.id]
        titleCounts[strategy] = (titleCounts[strategy] ?? 0) + 1
      }
    }
  }

  const winnerShares = Object.fromEntries(
    Object.entries(winnerCounts).map(([strategy, wins]) => [
      strategy,
      successfulPrimaryTitles > 0 ? (wins ?? 0) / successfulPrimaryTitles : 0,
    ]),
  ) as Partial<Record<StrategyId, number>>
  const dominant = (Object.entries(winnerShares) as [StrategyId, number][])
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]

  return {
    seeds,
    days,
    successfulPrimaryTitles,
    unresolvedPrimaryTitles,
    reportsGenerated,
    bankruptRuns,
    shortestRunDay: Number.isFinite(shortestRunDay) ? shortestRunDay : 0,
    winnerCounts,
    titleWinnerCounts,
    winnerShares,
    dominantStrategy: dominant?.[0] ?? null,
    dominantShare: dominant?.[1] ?? 0,
  }
}

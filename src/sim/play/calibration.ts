import type { DifficultyId } from '../balance/gameConfig'
import { runPlayBot } from './bot'

export interface CalibrationDistribution {
  p10: number
  p50: number
  p90: number
}

export interface CalibrationSummary {
  seeds: number
  days: number
  difficulty: DifficultyId
  medianRank: number
  withinTenRate: number
  firstPlaceRate: number
  bankruptRate: number
  hadRevenueRate: number
  profitableAtEndRate: number
  profitableDayRate: number
  rivalNegativeCashRate: number
  modelPaybackRate: number
  firstRevenueDay: CalibrationDistribution | null
  firstModelPaybackDay: CalibrationDistribution | null
  firstProfitableDay: CalibrationDistribution | null
  endCash: CalibrationDistribution
  apiContributionMargin: CalibrationDistribution | null
  unservedRatio: CalibrationDistribution
  playerMarketShare: CalibrationDistribution
  unexplainedAssetViolations: number
  medianPlayerCapability: number
  medianLeaderCapability: number
  rankDistribution: Record<number, number>
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const position = Math.max(0, Math.min(1, fraction)) * (sorted.length - 1)
  const low = Math.floor(position)
  const high = Math.ceil(position)
  if (low === high) return sorted[low]!
  const mix = position - low
  // Prefer delta form so equal endpoints stay exact (avoids 0.9x+0.1x float drift).
  return sorted[low]! + (sorted[high]! - sorted[low]!) * mix
}

function distribution(values: readonly number[]): CalibrationDistribution {
  return {
    p10: percentile(values, 0.1),
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
  }
}

function median(values: readonly number[]): number {
  return percentile(values, 0.5)
}

/** Deterministic multi-seed balance harness used outside the fast default suite. */
export function runCalibration(opts: {
  seeds?: number
  days?: number
  difficulty?: DifficultyId
  seedOffset?: number
} = {}): CalibrationSummary {
  const seeds = Math.max(1, Math.floor(opts.seeds ?? 200))
  const days = Math.max(1, Math.floor(opts.days ?? 180))
  const difficulty = opts.difficulty ?? 'normal'
  const seedOffset = Math.floor(opts.seedOffset ?? 0)
  const ranks: number[] = []
  const playerCapabilities: number[] = []
  const leaderCapabilities: number[] = []
  const firstRevenueDays: number[] = []
  const firstProfitableDays: number[] = []
  const firstModelPaybackDays: number[] = []
  const endCashValues: number[] = []
  const apiMargins: number[] = []
  const unservedRatios: number[] = []
  const playerShares: number[] = []
  let withinTen = 0
  let first = 0
  let bankrupt = 0
  let hadRevenue = 0
  let profitableAtEnd = 0
  let profitableDays = 0
  let totalDaysRun = 0
  let negativeCashRivals = 0
  let totalRivalRuns = 0
  let paidBackModels = 0
  let trackableModels = 0
  let unexplainedAssetViolations = 0

  for (let index = 0; index < seeds; index++) {
    const report = runPlayBot({
      seed: seedOffset + index + 1,
      maxDays: days,
      difficulty,
    })
    const state = report.final
    const playerCapability = Math.max(0, ...state.player.models.map((model) => model.capability))
    const rivalCapabilities = state.rivals.map((rival) =>
      Math.max(0, ...rival.models.map((model) => model.capability)),
    )
    const leader = Math.max(playerCapability, ...rivalCapabilities)
    const rank = 1 + rivalCapabilities.filter((capability) => capability > playerCapability).length
    ranks.push(rank)
    playerCapabilities.push(playerCapability)
    leaderCapabilities.push(leader)
    endCashValues.push(Math.round(state.player.cash))
    unservedRatios.push(Math.max(0, state.lastMarket.unservedRatio ?? 0))
    playerShares.push(Math.max(0, state.player.finance.totalShare ?? 0))
    if (report.firstRevenueDay != null) firstRevenueDays.push(report.firstRevenueDay)
    if (report.firstProfitableDay != null) {
      firstProfitableDays.push(report.firstProfitableDay)
    }
    if (state.player.finance.apiRevenue > 0) {
      apiMargins.push(
        (state.player.finance.apiRevenue - state.player.finance.apiCogs) /
          state.player.finance.apiRevenue,
      )
    }
    const paybackDays = state.player.models.flatMap((model) => {
      const economics = model.economics
      const attributableTrainingCost = economics
        ? economics.trainingInitialCost +
          economics.trainingDataCost +
          economics.trainingDailyCost
        : 0
      if (attributableTrainingCost <= 0) return []
      trackableModels++
      if (economics?.paybackDay == null) return []
      paidBackModels++
      return [economics.paybackDay]
    })
    if (paybackDays.length > 0) {
      firstModelPaybackDays.push(Math.min(...paybackDays))
    }
    if (leader - playerCapability <= 10) withinTen++
    if (rank === 1) first++
    if (report.bankrupt) bankrupt++
    if (report.hadRevenue) hadRevenue++
    if (state.player.finance.dayNet > 0) profitableAtEnd++
    profitableDays += report.profitableDays
    totalDaysRun += Math.max(1, report.daysRun)

    // Every post-start hardware increase must be represented by a market fill.
    for (const rival of state.rivals) {
      totalRivalRuns++
      if (rival.cash < 0) negativeCashRivals++
      if ((rival.rackFleet ?? []).some((rack) => !rack.id.startsWith('rack-fill-'))) {
        unexplainedAssetViolations++
      }
    }
  }

  return {
    seeds,
    days,
    difficulty,
    medianRank: median(ranks),
    withinTenRate: withinTen / seeds,
    firstPlaceRate: first / seeds,
    bankruptRate: bankrupt / seeds,
    hadRevenueRate: hadRevenue / seeds,
    profitableAtEndRate: profitableAtEnd / seeds,
    profitableDayRate: profitableDays / Math.max(1, totalDaysRun),
    rivalNegativeCashRate: negativeCashRivals / Math.max(1, totalRivalRuns),
    modelPaybackRate: paidBackModels / Math.max(1, trackableModels),
    firstRevenueDay:
      firstRevenueDays.length > 0 ? distribution(firstRevenueDays) : null,
    firstProfitableDay:
      firstProfitableDays.length > 0
        ? distribution(firstProfitableDays)
        : null,
    firstModelPaybackDay:
      firstModelPaybackDays.length > 0
        ? distribution(firstModelPaybackDays)
        : null,
    endCash: distribution(endCashValues),
    apiContributionMargin:
      apiMargins.length > 0 ? distribution(apiMargins) : null,
    unservedRatio: distribution(unservedRatios),
    playerMarketShare: distribution(playerShares),
    unexplainedAssetViolations,
    medianPlayerCapability: median(playerCapabilities),
    medianLeaderCapability: median(leaderCapabilities),
    rankDistribution: Object.fromEntries(
      [...new Set(ranks)].sort((a, b) => a - b).map((rank) => [rank, ranks.filter((value) => value === rank).length]),
    ),
  }
}

import type { DifficultyId } from '../balance/gameConfig'
import { runPlayBot } from './bot'

export interface CalibrationSummary {
  seeds: number
  days: number
  difficulty: DifficultyId
  medianRank: number
  withinTenRate: number
  firstPlaceRate: number
  bankruptRate: number
  unexplainedAssetViolations: number
  medianPlayerCapability: number
  medianLeaderCapability: number
  rankDistribution: Record<number, number>
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
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
  let withinTen = 0
  let first = 0
  let bankrupt = 0
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
    if (leader - playerCapability <= 10) withinTen++
    if (rank === 1) first++
    if (report.bankrupt) bankrupt++

    // Every post-start hardware increase must be represented by a market fill.
    for (const rival of state.rivals) {
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
    unexplainedAssetViolations,
    medianPlayerCapability: median(playerCapabilities),
    medianLeaderCapability: median(leaderCapabilities),
    rankDistribution: Object.fromEntries(
      [...new Set(ranks)].sort((a, b) => a - b).map((rank) => [rank, ranks.filter((value) => value === rank).length]),
    ),
  }
}

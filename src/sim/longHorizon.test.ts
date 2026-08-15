import { describe, expect, it } from 'vitest'
import { buildGameConfig } from './balance/gameConfig'
import { createGame } from './createGame'
import { tickMany } from './tick'
import type { SimState } from './types'

function spectatorSeed(): SimState {
  const state = createGame({
    config: buildGameConfig({
      seed: 20_261_236,
      advanced: { mapWidth: 20, mapHeight: 20, cityCount: 2, rivalCount: 5 },
    }),
  })
  return {
    ...state,
    computeContracts: [],
    player: {
      ...state.player,
      cash: 5_000_000_000,
      finance: { ...state.player.finance, valuation: 5_000_000_000 },
    },
  }
}

function deterministicProjection(state: ReturnType<typeof spectatorSeed>) {
  return {
    day: state.day,
    calendar: state.calendar,
    segments: state.segments,
    player: {
      cash: state.player.cash,
      valuation: state.player.finance.valuation,
      modelCount: state.player.models.length,
      assets: state.player.data.assets.length,
    },
    rivals: state.rivals.map((rival) => ({
      id: rival.id,
      cash: rival.cash,
      valuation: rival.finance?.valuation ?? 0,
      models: rival.models.map((model) => [model.id, model.capability, model.release]),
      debt: rival.finance?.debtOutstanding ?? 0,
      comeback: rival.financialComeback
        ? {
            episode: rival.financialComeback.distressEpisode,
            attempted: rival.financialComeback.attemptedEpisode,
            cooldown: rival.financialComeback.cooldownUntilDay,
            status: rival.financialComeback.status,
            modelId: rival.financialComeback.modelId,
            releaseDay: rival.financialComeback.releaseDay,
          }
        : null,
    })),
    market: state.lastMarket,
    progression: state.progression,
    historyLengths: {
      finance: state.financeHistory.length,
      alerts: state.alerts.length,
      news: state.news.length,
      fills: state.worldMarkets.fills.length,
      reviews: state.reviews.length,
      evaluations: state.evaluations.length,
    },
  }
}

describe('decade simulation replay', () => {
  it(
    'runs 4,000 no-action days deterministically with bounded adoption and histories',
    () => {
      const initial = spectatorSeed()
      const initialDemand = initial.segments.reduce((sum, segment) => sum + segment.size, 0)
      const first = tickMany(initial, 4_000)
      const second = tickMany(spectatorSeed(), 4_000)
      const finalDemand = first.segments.reduce((sum, segment) => sum + segment.size, 0)

      expect(deterministicProjection(first)).toEqual(deterministicProjection(second))
      expect(first.day).toBe(4_001)
      expect(first.rivals).toHaveLength(5)
      const userMin =
        initial.industryDataPack.demand.reportYearUserMinMultiplier ?? 1.5
      const userMax =
        initial.industryDataPack.demand.reportYearUserMaxMultiplier ?? 3
      const taskMax = initial.industryDataPack.demand.reportYearMaxMultiplier
      // People adopting the product and work per adopter are separate curves:
      // population never gets multiplied by the much larger task-growth rate.
      expect(finalDemand).toBeGreaterThanOrEqual(initialDemand * userMin - 1)
      expect(finalDemand).toBeLessThanOrEqual(initialDemand * userMax + 1)
      expect(first.lastMarket.marketTaskIntensity ?? 1).toBeGreaterThan(1)
      expect(first.lastMarket.marketTaskIntensity ?? 1).toBeLessThanOrEqual(taskMax)
      expect(first.financeHistory.length).toBeLessThanOrEqual(180)
      expect(first.alerts.length).toBeLessThanOrEqual(40)
      expect(first.news.length).toBeLessThanOrEqual(64)
      expect(first.worldMarkets.fills.length).toBeLessThanOrEqual(80)
      expect(first.reviews.length).toBeLessThanOrEqual(120)
      expect(first.evaluations.length).toBeLessThanOrEqual(240)
      expect(first.benchmarkSeasons.length).toBeLessThanOrEqual(64)
      expect(first.financeMonthlyHistory.length).toBeLessThanOrEqual(600)
      expect(first.externalities?.incidents.length ?? 0).toBeLessThanOrEqual(160)
      const comebackRounds = first.rivals.flatMap((rival) =>
        (rival.capital?.fundingRounds ?? []).filter(
          (round) => round.label === 'Emergency restructure',
        ),
      )
      expect(comebackRounds.length).toBeLessThanOrEqual(
        first.rivals.length * (1 + Math.ceil(4_000 / 720)),
      )
      for (const rival of first.rivals) {
        const comeback = rival.financialComeback
        if (!comeback) continue
        expect(comeback.attemptedEpisode ?? 0).toBeLessThanOrEqual(
          comeback.distressEpisode,
        )
        expect(Number.isFinite(comeback.cooldownUntilDay)).toBe(true)
        expect(
          comeback.releaseDay == null || Number.isFinite(comeback.releaseDay),
        ).toBe(true)
      }
      expect(
        first.rivals.reduce(
          (sum, rival) => sum + (rival.data?.assets.length ?? 0),
          0,
        ),
      ).toBeLessThanOrEqual(240)
      const financials = {
        playerCash: first.player.cash,
        playerValuation: first.player.finance.valuation,
        requested: first.lastMarket.demandMTok,
        served: first.lastMarket.servedMTok,
        ...Object.fromEntries(
          first.rivals.flatMap((rival) => [
            [`${rival.id}Cash`, rival.cash],
            [`${rival.id}Valuation`, rival.finance?.valuation ?? 0],
          ]),
        ),
      }
      expect(Object.entries(financials).filter(([, value]) => !Number.isFinite(value))).toEqual([])
    },
    120_000,
  )
})

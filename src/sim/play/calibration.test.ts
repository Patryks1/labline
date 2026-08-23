import { describe, expect, it } from 'vitest'
import { runCalibration, type CalibrationDistribution } from './calibration'

const calibrationEnv = (
  globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> }
  }
).process?.env ?? {}

function expectDistribution(distribution: CalibrationDistribution) {
  expect(Number.isFinite(distribution.p10)).toBe(true)
  expect(distribution.p10).toBeLessThanOrEqual(distribution.p50)
  expect(distribution.p50).toBeLessThanOrEqual(distribution.p90)
}

describe('calibration harness', () => {
  it(
    'is deterministic and reports economy distributions over a smoke cohort',
    () => {
      const first = runCalibration({ seeds: 2, days: 25 })
      const again = runCalibration({ seeds: 2, days: 25 })
      expect(first).toEqual(again)
      expectDistribution(first.endCash)
      expectDistribution(first.unservedRatio)
      expectDistribution(first.playerMarketShare)
      for (const rate of [
        first.bankruptRate,
        first.hadRevenueRate,
        first.profitableAtEndRate,
        first.profitableDayRate,
        first.rivalNegativeCashRate,
        first.modelPaybackRate,
      ]) {
        expect(rate).toBeGreaterThanOrEqual(0)
        expect(rate).toBeLessThanOrEqual(1)
      }
    },
    15_000,
  )

  it.runIf(calibrationEnv.LABLINE_CALIBRATE === '1')(
    'meets the 200-seed normal-difficulty capability and economy bands',
    () => {
      const result = runCalibration({
        seeds: Number(calibrationEnv.LABLINE_CALIBRATION_SEEDS ?? 200),
        days: Number(calibrationEnv.LABLINE_CALIBRATION_DAYS ?? 180),
        difficulty: 'normal',
      })
      console.log(JSON.stringify(result))
      expect(result.medianRank).toBeGreaterThanOrEqual(2)
      expect(result.medianRank).toBeLessThanOrEqual(4)
      expect(result.withinTenRate).toBeGreaterThanOrEqual(0.75)
      expect(result.firstPlaceRate).toBeGreaterThanOrEqual(0.2)
      expect(result.firstPlaceRate).toBeLessThanOrEqual(0.45)
      expect(result.bankruptRate).toBeLessThanOrEqual(0.5)
      expect(result.hadRevenueRate).toBeGreaterThanOrEqual(0.6)
      expect(result.profitableAtEndRate).toBeGreaterThanOrEqual(0.1)
      expect(result.profitableAtEndRate).toBeLessThanOrEqual(0.9)
      expect(result.rivalNegativeCashRate).toBeLessThanOrEqual(0.35)
      expect(result.modelPaybackRate).toBeGreaterThanOrEqual(0.03)
      expect(result.modelPaybackRate).toBeLessThanOrEqual(0.8)
      expect(result.firstRevenueDay?.p50 ?? Infinity).toBeLessThanOrEqual(165)
      if (result.apiContributionMargin) {
        expect(result.apiContributionMargin.p50).toBeGreaterThanOrEqual(-0.35)
        expect(result.apiContributionMargin.p50).toBeLessThanOrEqual(0.8)
      }
      expect(result.unservedRatio.p50).toBeLessThanOrEqual(0.4)
      expect(result.unexplainedAssetViolations).toBe(0)
    },
    // This is an opt-in balance sweep, not part of the fast default suite. Leave
    // enough headroom for shared/CI runners and for running difficulty sweeps in
    // parallel without converting completed statistical checks into timeouts.
    30 * 60_000,
  )

  it.runIf(calibrationEnv.LABLINE_DIFFICULTY_CALIBRATE === '1')(
    'changes first-place rate through rival policy quality',
    () => {
      const seeds = Number(calibrationEnv.LABLINE_CALIBRATION_SEEDS ?? 100)
      const days = Number(calibrationEnv.LABLINE_CALIBRATION_DAYS ?? 180)
      const easy = runCalibration({ seeds, days, difficulty: 'easy' })
      const normal = runCalibration({ seeds, days, difficulty: 'normal' })
      const hard = runCalibration({ seeds, days, difficulty: 'hard' })
      console.log(JSON.stringify({ easy, normal, hard }))
      expect(easy.firstPlaceRate).toBeGreaterThan(normal.firstPlaceRate)
      expect(normal.firstPlaceRate).toBeGreaterThan(hard.firstPlaceRate)
      expect(
        easy.unexplainedAssetViolations +
          normal.unexplainedAssetViolations +
          hard.unexplainedAssetViolations,
      ).toBe(0)
    },
    30 * 60_000,
  )
})

import { describe, expect, it } from 'vitest'
import { runCalibration } from './calibration'

const calibrationEnv = (
  globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> }
  }
).process?.env ?? {}

describe('calibration harness', () => {
  it(
    'is deterministic over a small smoke cohort',
    () => {
      expect(runCalibration({ seeds: 2, days: 25 })).toEqual(
        runCalibration({ seeds: 2, days: 25 }),
      )
    },
    15_000,
  )

  it.runIf(calibrationEnv.LABLINE_CALIBRATE === '1')(
    'meets the 200-seed normal-difficulty acceptance band',
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

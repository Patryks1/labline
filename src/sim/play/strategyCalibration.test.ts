import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { runStrategyCalibration, strategyForLab } from './strategyCalibration'

const env = (
  globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> }
  }
).process?.env ?? {}

describe('decade strategy calibration', () => {
  it('maps controller identities to stable strategy labels', () => {
    const state = createGame(901)
    expect(strategyForLab(state, state.playerLabId)).toBe('balanced_cloud')
    for (const rival of state.rivals) {
      expect(strategyForLab(state, rival.id)).toBe(rival.archetype)
    }
    expect(strategyForLab(state, 'missing-lab')).toBeNull()
  })

  it.runIf(env.LABLINE_DECADE_CALIBRATE === '1')(
    'keeps every strategy below 65% of successful primary titles over 50 seeds',
    () => {
      const result = runStrategyCalibration({
        seeds: Number(env.LABLINE_DECADE_CALIBRATION_SEEDS ?? 50),
        days: Number(env.LABLINE_DECADE_CALIBRATION_DAYS ?? 4_017),
      })
      console.log(JSON.stringify(result))
      expect(result.reportsGenerated).toBe(result.seeds)
      expect(result.successfulPrimaryTitles).toBeGreaterThan(0)
      expect(result.dominantShare).toBeLessThanOrEqual(0.65)
    },
    30 * 60_000,
  )
})

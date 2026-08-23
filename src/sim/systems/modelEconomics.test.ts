import { describe, expect, it } from 'vitest'
import type { ModelEconomics } from '../types'
import { advanceModelEconomics } from './market'

function economics(patch: Partial<ModelEconomics> = {}): ModelEconomics {
  return {
    lifetimeApiRevenue: 0,
    lifetimeSubRevenue: 0,
    lifetimeEnterpriseRevenue: 0,
    lifetimeServingCost: 0,
    lifetimeNet: -100,
    trainingInitialCost: 60,
    trainingDataCost: 20,
    trainingDailyCost: 20,
    ...patch,
  }
}

const contributionDay = {
  dayApiRevenue: 35,
  daySubRevenue: 15,
  dayEnterpriseShare: 0,
  dayApiCogs: 7,
  daySubCogs: 3,
}

describe('model commercial payback', () => {
  it('starts below zero and records the first day contribution repays training', () => {
    const day1 = advanceModelEconomics(
      { economics: economics() },
      contributionDay,
      10,
    )
    expect(day1.lifetimeNet).toBe(-60)
    expect(day1.paybackDay).toBeUndefined()

    const day2 = advanceModelEconomics({ economics: day1 }, contributionDay, 11)
    expect(day2.lifetimeNet).toBe(-20)
    expect(day2.paybackDay).toBeUndefined()

    const day3 = advanceModelEconomics({ economics: day2 }, contributionDay, 12)
    expect(day3.lifetimeNet).toBe(20)
    expect(day3.paybackDay).toBe(12)

    const day4 = advanceModelEconomics({ economics: day3 }, contributionDay, 13)
    expect(day4.paybackDay).toBe(12)
    expect(day4.lifetimeApiRevenue).toBe(140)
    expect(day4.lifetimeSubRevenue).toBe(60)
    expect(day4.lifetimeServingCost).toBe(40)
  })

  it('does not invent a payback milestone for migrated zero-cost models', () => {
    const migrated = advanceModelEconomics(
      {
        economics: economics({
          lifetimeNet: 0,
          trainingInitialCost: 0,
          trainingDataCost: 0,
          trainingDailyCost: 0,
        }),
      },
      contributionDay,
      20,
    )
    expect(migrated.lifetimeNet).toBe(40)
    expect(migrated.paybackDay).toBeUndefined()
  })
})

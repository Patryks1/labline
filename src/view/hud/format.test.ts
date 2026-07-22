import { describe, expect, it } from 'vitest'
import { ECONOMY } from '../../sim/balance/economy'
import {
  computeMw,
  mwToPf,
  pfToMw,
  pricePerMwDayFromPf,
} from './format'

describe('compute capacity display units', () => {
  it('round-trips the simulation PF value through the shared MW proxy', () => {
    const pf = 536
    expect(mwToPf(pfToMw(pf))).toBeCloseTo(pf, 10)
    expect(pfToMw(pf)).toBeCloseTo(pf * ECONOMY.mwPerPfProxy, 10)
  })

  it('uses the same proxy for capacity and per-day pricing', () => {
    const pricePerPfDay = 245
    expect(pricePerMwDayFromPf(pricePerPfDay)).toBeCloseTo(
      pricePerPfDay / ECONOMY.mwPerPfProxy,
      10,
    )
    expect(computeMw(1_250)).toBe('1.25 GW')
  })
})

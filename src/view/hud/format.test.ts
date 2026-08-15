import { describe, expect, it } from 'vitest'
import { ECONOMY } from '../../sim/balance/economy'
import {
  computeMw,
  mwToPf,
  pf,
  pfLong,
  pfToMw,
  pricePerMwDayFromPf,
} from './format'

describe('compute PF/EF display', () => {
  it('keeps PF below 1,000 and switches to EF at 1,000', () => {
    expect(pf(536)).toBe('536.0 PF')
    expect(pf(999.9)).toBe('999.9 PF')
    expect(pf(3600)).toBe('3.6 EF')
  })

  it('pfLong spells the PF amount out with thousands separators', () => {
    expect(pfLong(3600)).toBe('3,600 PF')
    expect(pfLong(3599.6)).toBe('3,600 PF')
    expect(pfLong(536)).toBe('536 PF')
  })

  it('handles non-finite input', () => {
    expect(pf(Number.NaN)).toBe('—')
    expect(pfLong(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

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

  it('formats PF values at the EF boundary', () => {
    expect(pf(0)).toBe('0.00 PF')
    expect(pf(10)).toBe('10.0 PF')
    expect(pf(999)).toBe('999.0 PF')
    expect(pf(1_000)).toBe('1.0 EF')
    expect(pf(1_300)).toBe('1.3 EF')
  })
})

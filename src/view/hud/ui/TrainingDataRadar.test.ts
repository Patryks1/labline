import { describe, expect, it } from 'vitest'
import { DATA_DOMAINS } from '../../../sim/balance/data'
import type { DataDomain } from '../../../sim/types'
import { normalizedRadarWeights, rebalanceRadarWeight } from './trainingDataRadarMath'

const even = Object.fromEntries(DATA_DOMAINS.map((domain) => [domain, 1])) as Record<DataDomain, number>

describe('training data radar', () => {
  it('normalizes corpus axes to a complete mix', () => {
    const result = normalizedRadarWeights({ ...even, code: 3 })
    expect(DATA_DOMAINS.reduce((sum, domain) => sum + result[domain], 0)).toBeCloseTo(1, 10)
    expect(result.code).toBeGreaterThan(result.math)
  })

  it('rebalances the other axes when one share changes', () => {
    const result = rebalanceRadarWeight(even, 'science', 0.4)
    expect(result.science).toBeCloseTo(0.4, 10)
    expect(DATA_DOMAINS.reduce((sum, domain) => sum + result[domain], 0)).toBeCloseTo(1, 10)
    expect(result.code).toBeCloseTo(result.health, 10)
  })

  it('keeps every axis usable and caps a single-domain corpus', () => {
    expect(rebalanceRadarWeight(even, 'code', 1).code).toBe(0.7)
    expect(rebalanceRadarWeight(even, 'code', -1).code).toBe(0.01)
  })
})

import { describe, expect, it } from 'vitest'
import { DATA_DOMAINS, defaultDataWeights } from '../../../sim/balance/data'
import { rebalanceTrainingDataDomain } from './trainingDataRadarMath'

describe('training data radar', () => {
  it('moves one domain while keeping the recipe normalized', () => {
    const initial = defaultDataWeights('dense')
    const next = rebalanceTrainingDataDomain(initial, 'code', initial.code + 0.12)

    expect(next.code).toBeGreaterThan(initial.code)
    expect(DATA_DOMAINS.reduce((sum, domain) => sum + next[domain], 0)).toBeCloseTo(1)
    expect(DATA_DOMAINS.every((domain) => next[domain] >= 0.01)).toBe(true)
  })
})

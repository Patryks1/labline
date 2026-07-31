import { describe, expect, it } from 'vitest'
import { DATA_DOMAINS } from '../../../sim/balance/data'
import { rebalanceTrainingDataDomain, trainingDataDomainCapMTok } from './trainingDataRadarMath'

describe('training data radar', () => {
  it('moves one domain without silently changing any other token allocation', () => {
    const initial = Object.fromEntries(DATA_DOMAINS.map((domain, index) => [domain, (index + 1) * 10])) as Record<(typeof DATA_DOMAINS)[number], number>
    const next = rebalanceTrainingDataDomain(initial, 'code', initial.code + 120, 500)

    expect(next.code).toBe(initial.code + 120)
    for (const domain of DATA_DOMAINS.filter((domain) => domain !== 'code')) {
      expect(next[domain]).toBe(initial[domain])
    }
    expect(rebalanceTrainingDataDomain(initial, 'code', 900, 500).code).toBe(500)
  })

  it('caps requested volume at real stock unless synthetic expansion is selected', () => {
    expect(trainingDataDomainCapMTok(100, 25, 0)).toBe(100)
    expect(trainingDataDomainCapMTok(100, 25, 2)).toBe(300)
    expect(trainingDataDomainCapMTok(100, 25, 99)).toBe(800)
    expect(trainingDataDomainCapMTok(100, 2_000, 7)).toBe(800)
    expect(trainingDataDomainCapMTok(0, 100, 7)).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { apiPriceRecommendation, suggestApiInOut } from './pricing'

describe('API unit economics policy', () => {
  it('keeps the 30/70 input-output mix equal to direct blended cost', () => {
    const suggestion = suggestApiInOut({
      costPerMTokBase: 0.038,
      paramsB: 0.4,
      family: 'dense',
      markupPct: 0,
    })
    expect(suggestion.costIn * 0.3 + suggestion.costOut * 0.7).toBeCloseTo(0.038, 10)
  })

  it('does not let capability alter cost', () => {
    const low = suggestApiInOut({ costPerMTokBase: 0.2, paramsB: 7, family: 'dense', capability: 20, markupPct: 0 })
    const high = suggestApiInOut({ costPerMTokBase: 0.2, paramsB: 7, family: 'dense', capability: 95, markupPct: 0 })
    expect(high.blendedCost).toBeCloseTo(low.blendedCost, 12)
  })

  it('lets market value reward an efficient model far above cost', () => {
    const result = apiPriceRecommendation({ directCost: 0.04, valueIndex: 58, peers: [] })
    expect(result.state).toBe('efficiency_premium')
    expect(result.recommendedPrice).toBeGreaterThan(0.04 * 1.8)
  })

  it('flags a cost base that customers will not support', () => {
    const result = apiPriceRecommendation({ directCost: 9, valueIndex: 24, peers: [] })
    expect(result.state).toBe('uncompetitive_cost')
    expect(result.recommendedPrice).toBeCloseTo(9 * 1.4, 10)
  })
})

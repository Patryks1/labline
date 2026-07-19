import { describe, expect, it } from 'vitest'
import {
  effectiveScaleParamsB,
  mixFit,
  scaleIntelligence,
} from './modelScaling'

describe('first-class math and science scaling', () => {
  it('counts math and science evidence in mix specialization', () => {
    const math = mixFit({ math: 1 })
    const science = mixFit({ science: 1 })

    expect(math.general).toBeCloseTo(0.72, 12)
    expect(math.domainBoost.math).toBe(1)
    expect(math.domainBoost.science).toBe(0)
    expect(science.domainBoost.science).toBe(1)
    expect(science.domainBoost.math).toBe(0)
  })

  it('makes narrow math and science corpora lead their own benchmark family', () => {
    const base = {
      paramsB: 20,
      dataCoverage: 6,
      dataQuality: 1,
      trainComplete: 1,
      postTrainStrength: 0.7,
    }
    const math = scaleIntelligence({
      ...base,
      mixWeights: { math: 0.8, chat: 0.2 },
    })
    const science = scaleIntelligence({
      ...base,
      mixWeights: { science: 0.8, chat: 0.2 },
    })

    expect(math.benchCeilings.math).toBeGreaterThan(
      science.benchCeilings.math,
    )
    expect(science.benchCeilings.science).toBeGreaterThan(
      math.benchCeilings.science,
    )
  })
})

describe('grounded sparse scaling', () => {
  it('values inactive experts partially rather than as dense-equivalent capacity', () => {
    const effective = effectiveScaleParamsB(10, 1, 'moe')

    expect(effective).toBeGreaterThan(1)
    expect(effective).toBeLessThan(10)
    expect(effective).toBeCloseTo(4.15, 12)
  })

  it('places MoE between same-active and same-total dense models', () => {
    const common = {
      dataCoverage: 6,
      dataQuality: 1,
      mixWeights: { code: 0.55, math: 0.25, chat: 0.2 },
      trainComplete: 1,
      postTrainStrength: 0.7,
    }
    const activeDense = scaleIntelligence({ ...common, paramsB: 1, family: 'dense' })
    const sparse = scaleIntelligence({
      ...common,
      paramsB: 10,
      activeParamsB: 1,
      family: 'moe',
    })
    const totalDense = scaleIntelligence({ ...common, paramsB: 10, family: 'dense' })

    expect(sparse.capability).toBeGreaterThan(activeDense.capability)
    expect(sparse.capability).toBeLessThan(totalDense.capability)
    expect(sparse.benchCeilings.coding).toBeGreaterThan(
      activeDense.benchCeilings.coding,
    )
    expect(sparse.benchCeilings.coding).toBeLessThan(
      totalDense.benchCeilings.coding,
    )
  })
})

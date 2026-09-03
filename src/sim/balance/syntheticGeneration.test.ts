import { describe, expect, it } from 'vitest'
import {
  SYNTH_GENERATION,
  synthAcceptanceChances,
  synthAttemptedMTokPerDay,
  synthTeacherSizeScale,
  syntheticQualityFor,
} from './syntheticGeneration'
import {
  setActiveBalanceTuning,
  DEFAULT_BALANCE_TUNING,
} from './tuning'

function attempted(overrides: Partial<Parameters<typeof synthAttemptedMTokPerDay>[0]> = {}) {
  return synthAttemptedMTokPerDay({
    domain: 'chat',
    domainSynthMTokPerPfDay: 18,
    teacherDomainCapability: 44,
    teacherReliability: 75,
    researchPf: 12.35 / 9,
    tier: 'lq',
    activeParamsB: 1,
    ...overrides,
  })
}

function chances(overrides: Partial<Parameters<typeof synthAcceptanceChances>[0]> = {}) {
  return synthAcceptanceChances({
    domain: 'chat',
    domainCapability: 44,
    overallFit: 0.3,
    modalityFit: 0.9,
    toolFit: 0,
    reliability: 75,
    researchPf: 12.35 / 9,
    ...overrides,
  })
}

describe('synthetic generation formula', () => {
  it('charges larger teachers more PF per attempted token', () => {
    const small = attempted({ activeParamsB: 1 })
    const ref = attempted({ activeParamsB: 7 })
    const huge = attempted({ activeParamsB: 120 })
    expect(synthTeacherSizeScale(120)).toBeGreaterThan(synthTeacherSizeScale(1) * 8)
    expect(small).toBeGreaterThan(ref * 2.2)
    expect(huge).toBeLessThan(small * 0.12)
    expect(huge).toBeLessThan(ref * 0.28)
  })

  it('keeps a 1B teacher on a mid research slice from flooding the corpus', () => {
    const domains = 9
    const pf = 12.35
    const rates = [12, 8, 7, 18, 6, 3, 10, 6, 4]
    const gross = rates.reduce(
      (sum, rate) =>
        sum +
        attempted({
          domainSynthMTokPerPfDay: rate,
          researchPf: pf / domains,
          activeParamsB: 1,
        }),
      0,
    )
    expect(gross).toBeGreaterThan(4)
    expect(gross).toBeLessThan(22)
  })

  it('mints mostly low-quality data until domain capability rises', () => {
    const weak = chances({ domainCapability: 40, overallFit: 0.28 })
    const strong = chances({ domainCapability: 82, overallFit: 0.72 })
    expect(weak.usefulChance).toBeLessThan(0.2)
    expect(weak.hqChance).toBeLessThan(0.22)
    expect(strong.usefulChance).toBeGreaterThan(weak.usefulChance * 1.35)
    expect(strong.hqChance).toBeGreaterThan(0.45)
    expect(strong.hqChance).toBeGreaterThan(weak.hqChance * 2.2)
  })

  it('lets extra PF raise volume, not magically clean the filter', () => {
    const smallPf = chances({ researchPf: 0.4 })
    const largePf = chances({ researchPf: 8 })
    const smallVol = attempted({ researchPf: 0.4 })
    const largeVol = attempted({ researchPf: 8 })
    expect(largeVol / smallVol).toBeGreaterThan(15)
    expect(largePf.usefulChance - smallPf.usefulChance).toBeLessThan(0.08)
    expect(largePf.hqChance - smallPf.hqChance).toBeLessThan(0.06)
  })

  it('makes video slower than chat at the same teacher', () => {
    expect(
      attempted({ domain: 'video', domainSynthMTokPerPfDay: 3 }),
    ).toBeLessThan(attempted() * 0.35)
  })

  it('exposes volume and HQ share as live balance sliders', () => {
    const baseVol = attempted()
    const baseHq = chances().hqChance
    setActiveBalanceTuning({ syntheticVolumeMult: 0.5, syntheticHqShareMult: 1.4 })
    try {
      expect(attempted()).toBeCloseTo(baseVol * 0.5, 8)
      expect(chances().hqChance).toBeGreaterThan(baseHq)
    } finally {
      setActiveBalanceTuning(DEFAULT_BALANCE_TUNING)
    }
  })

  it('keeps HQ jobs slower than LQ candidate generation', () => {
    expect(attempted({ tier: 'hq' })).toBeCloseTo(
      attempted({ tier: 'lq' }) * SYNTH_GENERATION.hqSpeed,
      8,
    )
  })

  it('uses one quality formula for teacher cap, method, filter, and depth', () => {
    const q = syntheticQualityFor({
      teacherDomainCap: 80,
      tierBudget: 8,
      verifierStrength: 0.2,
      depth: 1,
    })
    expect(q).toBeCloseTo((80 / 100) * 1 * (0.9 + 0.1 * 0.2) * 1, 8)
    const deep = syntheticQualityFor({
      teacherDomainCap: 80,
      tierBudget: 8,
      verifierStrength: 0.2,
      depth: 3,
    })
    expect(deep).toBeCloseTo(q * 0.92 ** 2, 8)
    const cheap = syntheticQualityFor({
      teacherDomainCap: 80,
      tierBudget: 1,
      verifierStrength: 0,
      depth: 1,
    })
    expect(cheap).toBeCloseTo((80 / 100) * 0.85 * 0.9, 8)
    expect(cheap).toBeLessThan(q)
  })
})

import { describe, expect, it } from 'vitest'
import { DATA_DOMAINS } from './data'
import {
  syntheticExpansionUnlocked,
  syntheticTrainingProfile,
  teacherSyntheticHeadroomMTok,
} from './syntheticTraining'

describe('synthetic training profile', () => {
  it('treats 2x as the broadly useful expansion and makes further gains conditional', () => {
    const medium = syntheticTrainingProfile({ realMTok: 1_000, syntheticMTok: 2_000, teacherCapability: 60, frontierCapability: 100 })
    const sota = syntheticTrainingProfile({ realMTok: 1_000, syntheticMTok: 3_000, teacherCapability: 95, frontierCapability: 100, teacherReliability: 96, dataQuality: 95, computePfDays: 300, seed: 'sota' })

    expect(medium.teacherTier).toBe('medium')
    expect(medium.idealMultiplier).toBe(2)
    expect(sota.teacherTier).toBe('sota')
    expect(sota.idealMultiplier).toBeGreaterThan(3)
    expect(sota.effectiveSyntheticMTok).toBeGreaterThan(2_000)
    expect(sota.effectiveSyntheticMTok).toBeLessThanOrEqual(3_000)
  })

  it('raises benchmark-overfit risk when expansion exceeds teacher quality', () => {
    const balanced = syntheticTrainingProfile({ realMTok: 1_000, syntheticMTok: 2_000, teacherCapability: 60, frontierCapability: 100 })
    const excessive = syntheticTrainingProfile({ realMTok: 1_000, syntheticMTok: 3_000, teacherCapability: 60, frontierCapability: 100 })

    expect(excessive.benchmarkOverfit).toBeGreaterThan(balanced.benchmarkOverfit)
    expect(excessive.syntheticShare).toBe(0.75)
  })

  it('requires teacher strength, quality, reliability, and compute beyond 2x', () => {
    const weakConditions = syntheticTrainingProfile({ realMTok: 1_000, syntheticMTok: 7_000, teacherCapability: 92, frontierCapability: 100, teacherReliability: 55, dataQuality: 55, computePfDays: 5, seed: 42 })
    const strongConditions = syntheticTrainingProfile({ realMTok: 1_000, syntheticMTok: 7_000, teacherCapability: 96, frontierCapability: 100, teacherReliability: 96, dataQuality: 96, computePfDays: 400, seed: 42 })

    expect(strongConditions.conditionalBeyond2).toBeGreaterThan(weakConditions.conditionalBeyond2)
    expect(strongConditions.effectiveSyntheticMTok).toBeGreaterThan(weakConditions.effectiveSyntheticMTok)
    expect(strongConditions.effectiveSyntheticMTok).toBeLessThan(7_000)
    expect(weakConditions.benchmarkOverfit).toBeGreaterThan(strongConditions.benchmarkOverfit)
    expect(strongConditions).toEqual(syntheticTrainingProfile({ realMTok: 1_000, syntheticMTok: 7_000, teacherCapability: 96, frontierCapability: 100, teacherReliability: 96, dataQuality: 96, computePfDays: 400, seed: 42 }))
  })

  it('bounds imitation effectiveness by teacher capability', () => {
    const weak = syntheticTrainingProfile({ realMTok: 1_000, syntheticMTok: 1_000, teacherCapability: 40, frontierCapability: 100 })
    const strong = syntheticTrainingProfile({ realMTok: 1_000, syntheticMTok: 1_000, teacherCapability: 90, frontierCapability: 100 })

    expect(weak.imitationRetention).toBeLessThanOrEqual(0.8)
    expect(strong.imitationRetention).toBeLessThanOrEqual(0.8)
    expect(40 * weak.imitationRetention).toBeLessThan(90 * strong.imitationRetention)
  })
})

describe('synthetic expansion gating', () => {
  it('works in every training mode once synthetic generation is unlocked', () => {
    for (const mode of ['pretrain', 'continue', 'distill'] as const) {
      expect(
        syntheticExpansionUnlocked({
          synthResearchUnlocked: true,
          mode,
          hasDistillTeacher: false,
        }),
      ).toBe(true)
    }
  })

  it('works in distill via the teacher even without the lab unlock', () => {
    expect(
      syntheticExpansionUnlocked({
        synthResearchUnlocked: false,
        mode: 'distill',
        hasDistillTeacher: true,
      }),
    ).toBe(true)
  })

  it('stays locked without the unlock and without a teacher', () => {
    for (const mode of ['pretrain', 'continue', 'distill'] as const) {
      expect(
        syntheticExpansionUnlocked({
          synthResearchUnlocked: false,
          mode,
          hasDistillTeacher: false,
        }),
      ).toBe(false)
    }
  })
})

describe('teacher synthetic headroom', () => {
  const persistedTeacher = (capability: number) => ({
    capability,
    family: 'dense' as const,
    dataConsumed: { code: 400, chat: 600 },
    dataTokensUsedMTok: 1_000,
  })

  it('uses the persisted teacher corpus per domain scaled by teacher tier', () => {
    const headroom = teacherSyntheticHeadroomMTok({
      teacher: persistedTeacher(95),
      frontierCapability: 100,
    })
    const tierShare =
      syntheticTrainingProfile({
        realMTok: 1,
        syntheticMTok: 0,
        teacherCapability: 95,
        frontierCapability: 100,
      }).idealMultiplier / 3

    expect(headroom.code).toBeCloseTo(400 * tierShare)
    expect(headroom.chat).toBeCloseTo(600 * tierShare)
    expect(headroom.video).toBe(0)
  })

  it('bounds headroom by teacher capability — weak teachers pass less', () => {
    const sota = teacherSyntheticHeadroomMTok({
      teacher: persistedTeacher(95),
      frontierCapability: 100,
    })
    const weak = teacherSyntheticHeadroomMTok({
      teacher: persistedTeacher(40),
      frontierCapability: 100,
    })
    const sotaShare =
      syntheticTrainingProfile({
        realMTok: 1,
        syntheticMTok: 0,
        teacherCapability: 95,
        frontierCapability: 100,
      }).idealMultiplier / 3

    expect(weak.code).toBeLessThan(sota.code)
    expect(weak.code).toBeCloseTo(400 / 3)
    expect(sota.code).toBeCloseTo(400 * sotaShare)
    expect(sota.code / weak.code).toBeCloseTo(sotaShare * 3)
  })

  it('falls back to a capability-scaled estimate when no corpus is persisted', () => {
    const headroom = teacherSyntheticHeadroomMTok({
      teacher: { capability: 60, family: 'dense' as const },
      frontierCapability: 100,
    })

    const total = DATA_DOMAINS.reduce((sum, domain) => sum + headroom[domain], 0)
    // Medium tier (60/100) → 2/3 of the 60 × 100 MTok estimate
    expect(total).toBeCloseTo(6_000 * (2 / 3))
  })

  it('spreads lifetime trained tokens over the teacher recipe mix', () => {
    const headroom = teacherSyntheticHeadroomMTok({
      teacher: {
        capability: 95,
        family: 'dense' as const,
        dataTokensUsedMTok: 9_000,
        dataPlan: {
          totalUnits: 9_000,
          weights: { code: 0.75, chat: 0.25 },
        },
      },
      frontierCapability: 100,
    })
    const tierShare =
      syntheticTrainingProfile({
        realMTok: 1,
        syntheticMTok: 0,
        teacherCapability: 95,
        frontierCapability: 100,
      }).idealMultiplier / 3

    expect(headroom.code).toBeCloseTo(6_750 * tierShare)
    expect(headroom.chat).toBeCloseTo(2_250 * tierShare)
    expect(headroom.law).toBe(0)
  })

  it('returns zero headroom without teacher capability', () => {
    const headroom = teacherSyntheticHeadroomMTok({
      teacher: { capability: 0, family: 'dense' as const },
      frontierCapability: 100,
    })

    expect(DATA_DOMAINS.every((domain) => headroom[domain] === 0)).toBe(true)
  })
})

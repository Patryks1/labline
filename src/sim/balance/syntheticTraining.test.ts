import { describe, expect, it } from 'vitest'
import { syntheticTrainingProfile } from './syntheticTraining'

describe('synthetic training profile', () => {
  it('recommends 2× expansion for a medium teacher and 3× for a SOTA teacher', () => {
    const medium = syntheticTrainingProfile({ realMTok: 1_000, syntheticMTok: 2_000, teacherCapability: 60, frontierCapability: 100 })
    const sota = syntheticTrainingProfile({ realMTok: 1_000, syntheticMTok: 3_000, teacherCapability: 95, frontierCapability: 100 })

    expect(medium.teacherTier).toBe('medium')
    expect(medium.idealMultiplier).toBe(2)
    expect(sota.teacherTier).toBe('sota')
    expect(sota.idealMultiplier).toBe(3)
    expect(sota.imitationRetention).toBeCloseTo(0.8)
  })

  it('raises benchmark-overfit risk when expansion exceeds teacher quality', () => {
    const balanced = syntheticTrainingProfile({ realMTok: 1_000, syntheticMTok: 2_000, teacherCapability: 60, frontierCapability: 100 })
    const excessive = syntheticTrainingProfile({ realMTok: 1_000, syntheticMTok: 3_000, teacherCapability: 60, frontierCapability: 100 })

    expect(excessive.benchmarkOverfit).toBeGreaterThan(balanced.benchmarkOverfit)
    expect(excessive.syntheticShare).toBe(0.75)
  })
})

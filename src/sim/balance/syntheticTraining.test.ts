import { describe, expect, it } from 'vitest'
import { syntheticTrainingProfile } from './syntheticTraining'

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
})

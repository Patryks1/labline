import { describe, expect, it } from 'vitest'
import {
  demandGrowthAtProgress,
  frontierEquivalentMarketPrice,
} from './demandGrowth'

describe('adoption and workload-intensity growth', () => {
  const input = {
    frontierCapability: 80,
    marketPricePerMTok: 2,
    userMinMultiplier: 1.5,
    userMaxMultiplier: 3,
    taskMinMultiplier: 4,
    taskMaxMultiplier: 12,
  }

  it('starts at the baseline without an instant demand jump', () => {
    expect(demandGrowthAtProgress({ ...input, progress: 0 })).toMatchObject({
      userAdoptionMultiplier: 1,
      taskIntensityMultiplier: 1,
    })
  })

  it('lets automated tasks grow much faster than adopter count', () => {
    const end = demandGrowthAtProgress({ ...input, progress: 1 })
    expect(end.userAdoptionMultiplier).toBeGreaterThanOrEqual(1.5)
    expect(end.userAdoptionMultiplier).toBeLessThanOrEqual(3)
    expect(end.taskIntensityMultiplier).toBeGreaterThanOrEqual(4)
    expect(end.taskIntensityMultiplier).toBeLessThanOrEqual(12)
    expect(end.taskIntensityMultiplier).toBeGreaterThan(
      end.userAdoptionMultiplier * 2,
    )
  })

  it('is monotonic in time and capability', () => {
    const early = demandGrowthAtProgress({ ...input, progress: 0.25 })
    const late = demandGrowthAtProgress({ ...input, progress: 0.75 })
    const weak = demandGrowthAtProgress({
      ...input,
      progress: 0.75,
      frontierCapability: 35,
    })
    expect(late.userAdoptionMultiplier).toBeGreaterThan(early.userAdoptionMultiplier)
    expect(late.taskIntensityMultiplier).toBeGreaterThan(early.taskIntensityMultiplier)
    expect(late.taskIntensityMultiplier).toBeGreaterThan(weak.taskIntensityMultiplier)
  })

  it('establishes meaningful early adoption without changing the bounded end state', () => {
    const firstMonth = demandGrowthAtProgress({
      ...input,
      progress: 30 / (4 * 365.25),
    })
    const end = demandGrowthAtProgress({ ...input, progress: 1 })

    expect(firstMonth.userAdoptionMultiplier).toBeGreaterThan(1.02)
    expect(firstMonth.taskIntensityMultiplier).toBeGreaterThan(
      firstMonth.userAdoptionMultiplier,
    )
    expect(end.userAdoptionMultiplier).toBeLessThanOrEqual(
      input.userMaxMultiplier,
    )
    expect(end.taskIntensityMultiplier).toBeLessThanOrEqual(
      input.taskMaxMultiplier,
    )
  })

  it('expands usage when capable intelligence becomes cheaper', () => {
    const expensive = demandGrowthAtProgress({
      ...input,
      progress: 1,
      frontierCapability: 85,
      marketPricePerMTok: 12,
    })
    const affordable = demandGrowthAtProgress({
      ...input,
      progress: 1,
      frontierCapability: 85,
      marketPricePerMTok: 0.75,
    })

    expect(affordable.smartAffordability).toBeGreaterThan(
      expensive.smartAffordability,
    )
    expect(affordable.userAdoptionMultiplier).toBeGreaterThan(
      expensive.userAdoptionMultiplier,
    )
    expect(affordable.taskIntensityMultiplier).toBeGreaterThan(
      expensive.taskIntensityMultiplier,
    )
  })

  it('does not let cheap but weak intelligence mimic a cheap frontier', () => {
    const weakCheap = demandGrowthAtProgress({
      ...input,
      progress: 1,
      frontierCapability: 35,
      marketPricePerMTok: 0.25,
    })
    const smartCheap = demandGrowthAtProgress({
      ...input,
      progress: 1,
      frontierCapability: 85,
      marketPricePerMTok: 0.25,
    })

    expect(smartCheap.smartAffordability).toBeGreaterThan(
      weakCheap.smartAffordability,
    )
    expect(smartCheap.taskIntensityMultiplier).toBeGreaterThan(
      weakCheap.taskIntensityMultiplier,
    )
  })

  it('normalizes price and capability on the same offer', () => {
    const splitSignals = frontierEquivalentMarketPrice([
      { capability: 35, pricePerMTok: 0.1 },
      { capability: 90, pricePerMTok: 12 },
    ])
    const cheapFrontier = frontierEquivalentMarketPrice([
      { capability: 35, pricePerMTok: 0.1 },
      { capability: 90, pricePerMTok: 0.75 },
    ])

    expect(splitSignals).toBeGreaterThan(cheapFrontier)
  })
})

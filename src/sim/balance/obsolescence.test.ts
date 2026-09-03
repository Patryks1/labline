import { describe, expect, it } from 'vitest'
import {
  OBSOLESCENCE_EPSILON,
  obsolescenceDiscount,
  obsolescenceHardness,
  obsolescenceUsage,
  relativeSota,
} from './obsolescence'

describe('relativeSota', () => {
  it('is 1 at/above frontier and 0.5 at half frontier', () => {
    expect(relativeSota(80, 80)).toBe(1)
    expect(relativeSota(90, 80)).toBe(1)
    expect(relativeSota(40, 80)).toBeCloseTo(0.5, 10)
    expect(relativeSota(0, 80)).toBe(0)
  })

  it('scales to massive frontiers without retuning', () => {
    // A 450-cap model at a 500 frontier is as relevant as 45 at 50.
    expect(relativeSota(450, 500)).toBeCloseTo(relativeSota(45, 50), 10)
    // Absolute-gap logic would call a 50-point lag obsolete; relative keeps it.
    expect(relativeSota(450, 500)).toBeGreaterThan(0.85)
  })

  it('gives young weak models real proximity instead of clamping to zero', () => {
    expect(relativeSota(30, 80)).toBeCloseTo(0.375, 10)
    expect(relativeSota(30, 80)).toBeGreaterThan(0)
  })
})

describe('obsolescenceDiscount', () => {
  it('is ~1 for viable co-frontier quality, epsilon-bound below', () => {
    const top = obsolescenceDiscount({
      quality: 60,
      frontierQuality: 60,
      qualityFloor: 24,
      segmentId: 'indie_api',
    })
    expect(top).toBeGreaterThan(0.95)
    expect(top).toBeLessThanOrEqual(1)
  })

  it('keeps a young weak model alive but far below near-frontier', () => {
    const near = obsolescenceDiscount({
      quality: 55,
      frontierQuality: 60,
      qualityFloor: 24,
      segmentId: 'indie_api',
    })
    const weak = obsolescenceDiscount({
      quality: 20,
      frontierQuality: 60,
      qualityFloor: 24,
      segmentId: 'indie_api',
    })
    expect(weak).toBeGreaterThan(OBSOLESCENCE_EPSILON)
    expect(weak).toBeLessThan(near * 0.5)
  })

  it('decays to epsilon — never a residual trickle — for far laggards', () => {
    const fossil = obsolescenceDiscount({
      quality: 5,
      frontierQuality: 90,
      qualityFloor: 30,
      segmentId: 'science',
    })
    expect(fossil).toBeLessThan(0.025)
    expect(fossil).toBeGreaterThanOrEqual(OBSOLESCENCE_EPSILON)
  })

  it('is harder on science than hobby at the same relative gap', () => {
    const strict = obsolescenceDiscount({
      quality: 40,
      frontierQuality: 60,
      qualityFloor: 24,
      segmentId: 'science',
    })
    const lenient = obsolescenceDiscount({
      quality: 40,
      frontierQuality: 60,
      qualityFloor: 24,
      segmentId: 'hobby',
    })
    expect(strict).toBeLessThan(lenient)
    expect(obsolescenceHardness('enterprise')).toBeGreaterThan(
      obsolescenceHardness('hobby'),
    )
  })
})

describe('obsolescenceUsage', () => {
  it('passes through the origin with legacy co-SOTA top ends', () => {
    expect(obsolescenceUsage(0, 'enterprise')).toBe(0)
    expect(obsolescenceUsage(0, 'hobby')).toBe(0)
    expect(obsolescenceUsage(1, 'enterprise')).toBeCloseTo(5.15, 10)
    expect(obsolescenceUsage(1, 'hobby')).toBeCloseTo(2.25, 10)
  })

  it('keeps frontier strongly ahead of mid-pack without a baseline', () => {
    expect(obsolescenceUsage(1, 'enterprise')).toBeGreaterThan(
      obsolescenceUsage(0.5, 'enterprise') * 1.5,
    )
    expect(obsolescenceUsage(0.375, 'indie_api')).toBeGreaterThan(0.5)
  })
})

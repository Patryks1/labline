import { describe, expect, it } from 'vitest'
import { LOD_THRESHOLDS, ScreenSpaceLod, selectLodTier } from './lod'
import { LodTier } from './types'

describe('screen-space LOD', () => {
  it('atomically swaps the default layer only after its target is ready', () => {
    let ready = false
    const lod = new ScreenSpaceLod(LodTier.mid)

    expect(lod.update(36, 0, () => ready).layers).toEqual([
      { tier: LodTier.mid, coverage: 1 },
    ])
    ready = true
    const swapped = lod.update(36, 1, () => ready)
    expect(lod.transitionMs).toBe(0)
    expect(swapped.transitioning).toBe(false)
    expect(swapped.layers).toEqual([{ tier: LodTier.near, coverage: 1 }])
  })

  it('reaches the same decisive tier regardless of zoom path', () => {
    const ready = () => true
    const fromFar = new ScreenSpaceLod(LodTier.mid, 0)
    fromFar.update(8, 0, ready)
    fromFar.update(34, 1, ready)

    const direct = new ScreenSpaceLod(LodTier.mid, 0)
    direct.update(34, 1, ready)

    expect(fromFar.active).toBe(LodTier.near)
    expect(direct.active).toBe(LodTier.near)
    expect(fromFar.snapshot(2, 34)).toEqual(direct.snapshot(2, 34))
  })

  it('uses the configured hysteresis bands without threshold thrashing', () => {
    expect(selectLodTier(LOD_THRESHOLDS.enterNear, LodTier.mid)).toBe(LodTier.near)
    expect(selectLodTier(LOD_THRESHOLDS.leaveNear, LodTier.near)).toBe(LodTier.near)
    expect(selectLodTier(LOD_THRESHOLDS.leaveNear - 0.1, LodTier.near)).toBe(LodTier.mid)
    expect(selectLodTier(LOD_THRESHOLDS.enterFar, LodTier.mid)).toBe(LodTier.far)
    expect(selectLodTier(LOD_THRESHOLDS.leaveFar, LodTier.far)).toBe(LodTier.far)
    expect(selectLodTier(LOD_THRESHOLDS.leaveFar + 0.1, LodTier.far)).toBe(LodTier.mid)
  })

  it('keeps the last complete layer visible while a close-up target is unready', () => {
    let nearReady = false
    const isReady = (tier: LodTier) => tier !== LodTier.near || nearReady
    const lod = new ScreenSpaceLod(LodTier.mid, 200)

    const waiting = lod.update(36, 0, isReady)
    expect(waiting.active).toBe(LodTier.mid)
    expect(waiting.desired).toBe(LodTier.near)
    expect(waiting.transitioning).toBe(false)
    expect(waiting.layers).toEqual([{ tier: LodTier.mid, coverage: 1 }])

    const stillWaiting = lod.update(36, 5_000, isReady)
    expect(stillWaiting.layers).toEqual([{ tier: LodTier.mid, coverage: 1 }])
    expect(stillWaiting.layers).not.toHaveLength(0)

    nearReady = true
    const transition = lod.update(36, 5_010, isReady)
    expect(transition.layers.map((layer) => layer.tier)).toEqual([LodTier.mid, LodTier.near])
    expect(transition.layers.reduce((sum, layer) => sum + layer.coverage, 0)).toBeCloseTo(1)

    const settled = lod.update(36, 5_211, isReady)
    expect(settled.active).toBe(LodTier.near)
    expect(settled.layers).toEqual([{ tier: LodTier.near, coverage: 1 }])
    expect(settled.layers.some((layer) => layer.tier !== LodTier.near)).toBe(false)
  })

  it('keeps outgoing and incoming screen-door coverage complementary throughout a crossfade', () => {
    const lod = new ScreenSpaceLod(LodTier.mid, 200)
    lod.update(36, 1_000, () => true)

    for (const [elapsed, expectedIncoming] of [
      [0, 0],
      [25, 0.125],
      [50, 0.25],
      [100, 0.5],
      [150, 0.75],
      [199, 0.995],
    ] as const) {
      const layers = lod.snapshot(1_000 + elapsed, 36).layers
      expect(layers).toHaveLength(2)
      expect(layers[0]).toMatchObject({ tier: LodTier.mid })
      expect(layers[1]).toMatchObject({ tier: LodTier.near })
      expect(layers[0]!.coverage + layers[1]!.coverage).toBeCloseTo(1, 10)
      expect(layers[0]!.coverage).toBeCloseTo(1 - expectedIncoming, 10)
      expect(layers[1]!.coverage).toBeCloseTo(expectedIncoming, 10)
    }
  })

  it('reverses a crossfade away from its midpoint without a per-tier coverage jump', () => {
    const lod = new ScreenSpaceLod(LodTier.mid, 200)
    lod.update(36, 1_000, () => true)
    const before = coverageByTier(lod.snapshot(1_070, 36).layers)

    expect(before.get(LodTier.mid)).toBeCloseTo(0.65, 10)
    expect(before.get(LodTier.near)).toBeCloseTo(0.35, 10)

    const reversed = lod.update(LOD_THRESHOLDS.leaveNear - 0.1, 1_070, () => true)
    const after = coverageByTier(reversed.layers)

    expect(reversed.desired).toBe(LodTier.mid)
    expect(reversed.transitioning).toBe(true)
    expect(after.get(LodTier.mid)).toBeCloseTo(before.get(LodTier.mid)!, 10)
    expect(after.get(LodTier.near)).toBeCloseTo(before.get(LodTier.near)!, 10)
    expect([...after.values()].reduce((sum, coverage) => sum + coverage, 0)).toBeCloseTo(1, 10)

    const continuing = coverageByTier(lod.snapshot(1_071, 18).layers)
    expect(continuing.get(LodTier.mid)).toBeGreaterThan(after.get(LodTier.mid)!)
    expect(continuing.get(LodTier.near)).toBeLessThan(after.get(LodTier.near)!)
  })
})

function coverageByTier(
  layers: ReturnType<ScreenSpaceLod['snapshot']>['layers'],
): Map<LodTier, number> {
  return new Map(layers.map((layer) => [layer.tier, layer.coverage]))
}

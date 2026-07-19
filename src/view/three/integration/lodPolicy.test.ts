import { describe, expect, it } from 'vitest'
import { DefaultArchetype, LodTier, type ViewportUpdateResult } from '../v2'
import { createArtDirectedArchetypeRegistry } from './artDirectedRegistry'
import { CLOSE_UP_NEAR_PIXELS, enforceCloseUpNearOnly } from './lodPolicy'

describe('close-up integration LOD policy', () => {
  it.each([CLOSE_UP_NEAR_PIXELS, CLOSE_UP_NEAR_PIXELS + 20])(
    'preserves the readiness-safe crossfade at %s pixels per tile',
    (pixelsPerTile) => {
      const registry = createArtDirectedArchetypeRegistry()
      registry.setTierCoverage(LodTier.mid, 0.8, 'outgoing')
      registry.setTierCoverage(LodTier.near, 0.2, 'incoming')
      const update = updateWithLayers([
        { tier: LodTier.mid, coverage: 0.8 },
        { tier: LodTier.near, coverage: 0.2 },
      ])
      const result = enforceCloseUpNearOnly(registry, update, pixelsPerTile)

      expect(result).toBe(update)
      expect(result.lod.layers).toEqual([
        { tier: LodTier.mid, coverage: 0.8 },
        { tier: LodTier.near, coverage: 0.2 },
      ])
      expect(
        registry.get(DefaultArchetype.facilitySmall).material.mid!.userData.lodCoverage,
      ).toMatchObject({
        value: 0.8,
        direction: -1,
      })
      expect(
        registry.get(DefaultArchetype.facilitySmall).material.near!.userData.lodCoverage,
      ).toMatchObject({
        value: 0.2,
        direction: 1,
      })
      registry.dispose()
    },
  )

  it('does not remove the sole complete layer when near detail is still unready', () => {
    const registry = createArtDirectedArchetypeRegistry()
    const update = updateWithLayers([{ tier: LodTier.mid, coverage: 1 }])
    update.lod.transitioning = false

    const result = enforceCloseUpNearOnly(registry, update, CLOSE_UP_NEAR_PIXELS + 20)

    expect(result).toBe(update)
    expect(result.lod.layers).toEqual([{ tier: LodTier.mid, coverage: 1 }])
    registry.dispose()
  })
})

function updateWithLayers(
  layers: ViewportUpdateResult['lod']['layers'],
): ViewportUpdateResult {
  return {
    chunks: {
      visible: new Set(),
      prefetch: new Set(),
      resident: new Set(),
      addedVisible: [],
      removedVisible: [],
      evicted: [],
    },
    lod: {
      active: LodTier.mid,
      desired: LodTier.near,
      transitioning: true,
      layers,
    },
    prewarming: false,
  }
}

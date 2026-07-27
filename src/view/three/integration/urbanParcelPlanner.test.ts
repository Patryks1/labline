import { describe, expect, it } from 'vitest'
import { TERRAIN_KIND, generateStaticWorldV5, type StaticWorld } from '../../../sim/world'
import { planUrbanParcels } from './urbanParcelPlanner'

const OPTIONS = { seed: 0x75bcd15, width: 128, height: 112, cityCount: 3, waterCoverage: 0.1 }

describe('render-time urban parcel planning', () => {
  it('partitions every eligible generated V5 urban tile exactly once', () => {
    const world = generateStaticWorldV5(OPTIONS)
    const plan = planUrbanParcels(world)
    const counts = new Uint8Array(world.kind.length)

    for (const parcel of plan.parcels) {
      expect(parcel.anchorTileId).toBe(Math.min(...parcel.footprintTileIds))
      expect(parcel.size).toBe(parcel.footprintTileIds.length)
      expect([1, 2, 4]).toContain(parcel.size)
      expect(parcel.width * parcel.height).toBe(parcel.size)
      if (parcel.class === 'skyscraper') {
        expect(parcel.style).toBe('core')
        expect(parcel.size).toBeGreaterThanOrEqual(2)
      } else {
        expect(parcel.size).toBe(1)
      }

      for (const id of parcel.footprintTileIds) {
        counts[id]++
        expect([TERRAIN_KIND.city, TERRAIN_KIND.house]).toContain(world.kind[id])
        expect(world.transport?.[id] ?? 0).toBe(0)
        expect(world.district?.[id] ?? 0).not.toBe(2)
        expect(world.feature[id]).toBe(parcel.featureId)
        expect(plan.parcelForTile(id)).toBe(parcel)
        expect(plan.footprintForTile(id)).toBe(parcel.footprintTileIds)
      }
    }

    let eligibleCount = 0
    for (let id = 0; id < world.kind.length; id++) {
      const eligible = (world.kind[id] === TERRAIN_KIND.city || world.kind[id] === TERRAIN_KIND.house) &&
        (world.transport?.[id] ?? 0) === 0 && world.district?.[id] !== 2 && world.feature[id] !== 0
      expect(counts[id]).toBe(eligible ? 1 : 0)
      if (eligible) eligibleCount++
    }
    expect(plan.parcelByTile.size).toBe(eligibleCount)
    expect(plan.parcels.some((parcel) => parcel.class === 'skyscraper')).toBe(true)
  })

  it('is independent of complete tile/chunk traversal order and stable by seed', () => {
    const world = generateStaticWorldV5(OPTIONS)
    const rowMajor = Array.from({ length: world.kind.length }, (_, id) => id)
    const chunkTraversal = tileIdsByReversedChunks(world, 16)
    const snapshot = (source: StaticWorld, tileIds: readonly number[]) => planUrbanParcels(source, { tileIds }).parcels
      .map((parcel) => ({
        id: parcel.id,
        footprint: [...parcel.footprintTileIds],
        class: parcel.class,
        style: parcel.style,
      }))

    expect(snapshot(world, chunkTraversal)).toEqual(snapshot(world, rowMajor))
    expect(snapshot(generateStaticWorldV5(OPTIONS), rowMajor)).toEqual(snapshot(world, rowMajor))
    expect(snapshot(generateStaticWorldV5({ ...OPTIONS, seed: OPTIONS.seed + 1 }), rowMajor))
      .not.toEqual(snapshot(world, rowMajor))
  })

  it('does not mutate persisted V5 layers or the static hash and honors facility exclusions', () => {
    const world = generateStaticWorldV5(OPTIONS)
    const hash = world.staticHash
    const before = persistedLayers(world).map((layer) => layer.slice())
    const excluded = world.kind.findIndex((kind, id) =>
      (kind === TERRAIN_KIND.city || kind === TERRAIN_KIND.house) &&
      (world.transport?.[id] ?? 0) === 0 && world.district?.[id] !== 2)

    const plan = planUrbanParcels(world, { excludedTileIds: [excluded] })

    expect(plan.parcelForTile(excluded)).toBeUndefined()
    expect(plan.footprintForTile(excluded)).toEqual([])
    expect(world.staticHash).toBe(hash)
    persistedLayers(world).forEach((layer, index) => expect(layer).toEqual(before[index]))
  })
})

function persistedLayers(world: StaticWorld): readonly (Uint8Array | Uint16Array | Int16Array)[] {
  return [
    world.kind,
    world.region,
    world.feature,
    world.variantMask,
    world.transport!,
    world.elevation!,
    world.biome!,
    world.district!,
  ]
}

function tileIdsByReversedChunks(world: StaticWorld, chunkSize: number): number[] {
  const chunksWide = Math.ceil(world.descriptor.width / chunkSize)
  const chunksHigh = Math.ceil(world.descriptor.height / chunkSize)
  const result: number[] = []
  for (let chunkId = chunksWide * chunksHigh - 1; chunkId >= 0; chunkId--) {
    const chunkX = chunkId % chunksWide
    const chunkY = Math.floor(chunkId / chunksWide)
    for (let y = chunkY * chunkSize; y < Math.min(world.descriptor.height, (chunkY + 1) * chunkSize); y++) {
      for (let x = chunkX * chunkSize; x < Math.min(world.descriptor.width, (chunkX + 1) * chunkSize); x++) {
        result.push(y * world.descriptor.width + x)
      }
    }
  }
  return result
}

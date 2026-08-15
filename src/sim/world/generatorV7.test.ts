import { describe, expect, it } from 'vitest'
import {
  TERRAIN_KIND,
  TERRAIN_VARIANT_RIVER,
  TRANSPORT_FLAGS,
  WORLD_GENERATOR_VERSION_V7,
  cityIndexFromFeature,
  createWorldDescriptorV7,
  generateStaticWorldV6,
  generateStaticWorldV7,
  getTileElevation,
  isRiverTile,
  regenerateStaticWorld,
  staticWorldByteLength,
  type StaticWorld,
} from '.'

const OPTIONS = { seed: 0x71a7, width: 160, height: 144, cityCount: 3, waterCoverage: 0.055 }

describe('world generator V7 rivers', () => {
  it('is deterministic and regenerates from its persisted descriptor', () => {
    const a = generateStaticWorldV7(OPTIONS)
    const b = generateStaticWorldV7(OPTIONS)
    expect(a.descriptor.generatorVersion).toBe(WORLD_GENERATOR_VERSION_V7)
    expect(a.descriptor).toMatchObject({ riverAlgorithmVersion: 1 })
    expect(b.staticHash).toBe(a.staticHash)
    expect(b.variantMask).toEqual(a.variantMask)
    expect(regenerateStaticWorld(a.descriptor)).toEqual(a)
  })

  it('uses the compact variant bit, stays within budget, and reaches an outlet', () => {
    const world = generateStaticWorldV7(OPTIONS)
    const { width, height } = world.descriptor
    const rivers = new Set<number>()
    for (let id = 0; id < world.kind.length; id++) if (isRiverTile(world, id)) rivers.add(id)
    expect(rivers.size).toBeGreaterThan(0)
    expect(rivers.size).toBeLessThanOrEqual(Math.floor(width * height * 0.0125))
    for (const id of rivers) {
      expect(world.kind[id]).toBe(TERRAIN_KIND.lake)
      expect(world.variantMask[id]! & TERRAIN_VARIANT_RIVER).toBe(TERRAIN_VARIANT_RIVER)
    }
    const elevations = [...rivers].map((id) =>
      getTileElevation(world, id % width, Math.floor(id / width)),
    )
    expect(Math.max(...elevations) - Math.min(...elevations)).toBeGreaterThan(0.2)
    for (const id of rivers) {
      const x = id % width
      const y = Math.floor(id / width)
      const current = getTileElevation(world, x, y)
      const downstream = [id - width, id + 1, id + width, id - 1].some((neighbor) => {
        if (neighbor < 0 || neighbor >= world.kind.length || Math.abs(neighbor % width - x) > 1) return false
        if (world.kind[neighbor] !== TERRAIN_KIND.lake) return false
        return getTileElevation(world, neighbor % width, Math.floor(neighbor / width)) <= current + 0.04
      })
      expect(downstream).toBe(true)
    }

    const visited = new Set<number>()
    const queue = [rivers.values().next().value as number]
    let hasOutlet = false
    while (queue.length > 0) {
      const id = queue.shift()!
      if (visited.has(id)) continue
      visited.add(id)
      const x = id % width
      const y = Math.floor(id / width)
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) hasOutlet = true
      for (const neighbor of [id - width, id + 1, id + width, id - 1]) {
        if (neighbor < 0 || neighbor >= world.kind.length || Math.abs(neighbor % width - x) > 1) continue
        if (world.kind[neighbor] !== TERRAIN_KIND.lake || visited.has(neighbor)) continue
        if (!rivers.has(neighbor)) hasOutlet = true
        queue.push(neighbor)
      }
    }
    expect(hasOutlet).toBe(true)
  })

  it('adds no persistent map-sized layer and bridges only road-water cells', () => {
    const world = generateStaticWorldV7(OPTIONS)
    const previous = generateStaticWorldV6(OPTIONS)
    expect(staticWorldByteLength(world)).toBe(staticWorldByteLength(previous))
    for (let id = 0; id < world.transport!.length; id++) {
      if ((world.transport![id]! & TRANSPORT_FLAGS.bridge) === 0) continue
      expect(world.kind[id]).toBe(TERRAIN_KIND.lake)
    }
  })

  it('keeps version-5 settlement descriptors byte-stable while version 6 carves roomier lots', () => {
    // Existing saves persist settlementAlgorithmVersion 5 descriptors; they
    // must regenerate the identical world (save hash check depends on it).
    const legacyDescriptor = { ...createWorldDescriptorV7(OPTIONS), settlementAlgorithmVersion: 5 as const }
    const legacyA = regenerateStaticWorld(legacyDescriptor)
    const legacyB = regenerateStaticWorld(legacyDescriptor)
    expect(legacyB.staticHash).toBe(legacyA.staticHash)

    // Fresh games emit version 6, which carves strictly more in-city empty
    // lots (same hash salt, so v6 is a superset of the v5 lots).
    const current = generateStaticWorldV7(OPTIONS)
    if (current.descriptor.generatorVersion !== WORLD_GENERATOR_VERSION_V7) {
      throw new Error('expected a V7 descriptor')
    }
    expect(current.descriptor.settlementAlgorithmVersion).toBe(6)
    expect(current.staticHash).not.toBe(legacyA.staticHash)

    const urbanEmptyCount = (world: StaticWorld): number => {
      let count = 0
      for (let id = 0; id < world.kind.length; id++) {
        if (world.kind[id] === TERRAIN_KIND.empty &&
            cityIndexFromFeature(world.feature[id]!) !== undefined) count++
      }
      return count
    }
    expect(urbanEmptyCount(current)).toBeGreaterThan(urbanEmptyCount(legacyA))
    for (let id = 0; id < current.kind.length; id++) {
      if (legacyA.kind[id] === TERRAIN_KIND.empty &&
          cityIndexFromFeature(legacyA.feature[id]!) !== undefined) {
        expect(current.kind[id]).toBe(TERRAIN_KIND.empty)
      }
    }
  })
})

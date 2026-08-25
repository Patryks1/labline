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

    // Version 6 remains a frozen superset of those v5 lots for in-progress saves.
    const roomierDescriptor = { ...createWorldDescriptorV7(OPTIONS), settlementAlgorithmVersion: 6 as const }
    const roomier = regenerateStaticWorld(roomierDescriptor)
    if (roomier.descriptor.generatorVersion !== WORLD_GENERATOR_VERSION_V7) {
      throw new Error('expected a V7 descriptor')
    }
    expect(roomier.descriptor.settlementAlgorithmVersion).toBe(6)
    expect(roomier.staticHash).not.toBe(legacyA.staticHash)

    const urbanEmptyCount = (world: StaticWorld): number => {
      let count = 0
      for (let id = 0; id < world.kind.length; id++) {
        if (world.kind[id] === TERRAIN_KIND.empty &&
            cityIndexFromFeature(world.feature[id]!) !== undefined) count++
      }
      return count
    }
    expect(urbanEmptyCount(roomier)).toBeGreaterThan(urbanEmptyCount(legacyA))
    for (let id = 0; id < roomier.kind.length; id++) {
      if (legacyA.kind[id] === TERRAIN_KIND.empty &&
          cityIndexFromFeature(legacyA.feature[id]!) !== undefined) {
        expect(roomier.kind[id]).toBe(TERRAIN_KIND.empty)
      }
    }

    const current = generateStaticWorldV7(OPTIONS)
    if (current.descriptor.generatorVersion !== WORLD_GENERATOR_VERSION_V7) {
      throw new Error('expected a V7 descriptor')
    }
    expect(current.descriptor.settlementAlgorithmVersion).toBe(7)
    expect(current.staticHash).not.toBe(roomier.staticHash)
  })
})

describe('world generator V7 city fabric', () => {
  it('breaks solid downtown fill with parks, street lots, and suburban gaps', () => {
    for (const seed of [17, 73, 0x71a7]) {
      const world = generateStaticWorldV7({ ...OPTIONS, seed })
      const { width } = world.descriptor
      let coreCity = 0
      let corePark = 0
      let coreRoadAdjacent = 0
      let suburbHouse = 0
      let suburbEmpty = 0
      let suburbPark = 0
      let urbanEmpty = 0
      for (const city of world.cities.filter((candidate) => candidate.tier !== 'village')) {
        const featureId = city.index + 1
        for (let id = 0; id < world.kind.length; id++) {
          if (world.feature[id] !== featureId) continue
          const x = id % width
          const inCore = world.district![id] === 3
          const kind = world.kind[id]!
          const roadNearby = [-width, 1, width, -1, -width - 1, -width + 1, width - 1, width + 1].some((delta) => {
            const neighbor = id + delta
            if (neighbor < 0 || neighbor >= world.kind.length) return false
            if (Math.abs((neighbor % width) - x) > 1) return false
            return (world.transport![neighbor] ?? 0) !== 0
          })
          if (kind === TERRAIN_KIND.empty) urbanEmpty++
          if (inCore && kind === TERRAIN_KIND.city) {
            coreCity++
            if (roadNearby) coreRoadAdjacent++
          }
          if (inCore && kind === TERRAIN_KIND.park) corePark++
          if (world.district![id] === 1 && kind === TERRAIN_KIND.house) suburbHouse++
          if (world.district![id] === 1 && kind === TERRAIN_KIND.empty) suburbEmpty++
          if (world.district![id] === 1 && kind === TERRAIN_KIND.park) suburbPark++
        }
      }
      expect(corePark, `seed ${seed}: downtown parks`).toBeGreaterThanOrEqual(4)
      expect(coreCity, `seed ${seed}: downtown fabric`).toBeGreaterThan(20)
      expect(corePark / (coreCity + corePark), `seed ${seed}: downtown park share`).toBeGreaterThan(0.04)
      expect(coreRoadAdjacent / coreCity, `seed ${seed}: street-served core`).toBeGreaterThan(0.72)
      expect(suburbPark, `seed ${seed}: neighborhood parks`).toBeGreaterThan(4)
      expect(suburbEmpty, `seed ${seed}: suburban yards`).toBeGreaterThan(4)
      expect(suburbHouse, `seed ${seed}: suburban homes`).toBeGreaterThan(suburbEmpty)
      expect(urbanEmpty, `seed ${seed}: in-city lots`).toBeGreaterThan(20)
    }
  }, 20_000)
})

import { describe, expect, it } from 'vitest'
import {
  generateStaticWorldV5,
  generateStaticWorldV6,
  getTileSlope,
  regenerateStaticWorld,
  staticWorldV6Hash,
} from './generator'
import {
  TERRAIN_KIND,
  WORLD_GENERATOR_VERSION_V6,
  type MunicipalPowerPlant,
  type TileId,
  type WorldDescriptorV6,
} from './types'

describe('world generator V6', () => {
  const options = { seed: 0x6ca1, width: 160, height: 144, cityCount: 3, waterCoverage: 0.08 }

  it('persists its algorithm boundaries and regenerates deterministically', () => {
    const a = generateStaticWorldV6(options)
    const b = generateStaticWorldV6(options)
    expect(a.descriptor).toMatchObject({
      generatorVersion: WORLD_GENERATOR_VERSION_V6,
      settlementAlgorithmVersion: 2,
      municipalCampusAlgorithmVersion: 2,
      cityStatsModelVersion: 1,
    })
    expect(a.staticHash).toBe(b.staticHash)
    expect(a.kind).toEqual(b.kind)
    expect(a.district).toEqual(b.district)
    expect(a.municipalPowerPlants).toEqual(b.municipalPowerPlants)
    expect(regenerateStaticWorld(a.descriptor)).toEqual(a)
  })

  it('does not alter the frozen V5 output path', () => {
    const before = generateStaticWorldV5(options)
    const after = generateStaticWorldV5(options)
    expect(before.staticHash).toBe('ccbf587e')
    expect(after.staticHash).toBe(before.staticHash)
    expect(after).toEqual(before)
    expect(after.municipalPowerPlants?.every((plant) => plant.layout === undefined)).toBe(true)
  })

  it('creates explicit road-served zones and keeps detached houses outside the buffer', () => {
    const world = generateStaticWorldV6(options)
    const districts = new Set(world.district)
    for (const code of [0, 1, 2, 3, 4, 5]) expect(districts.has(code)).toBe(true)
    for (let id = 0; id < world.kind.length; id++) {
      if (world.kind[id] !== TERRAIN_KIND.house) continue
      expect(world.district![id]).toBe(1)
      const x = id % world.descriptor.width
      const y = Math.floor(id / world.descriptor.width)
      const roadAccess = Array.from({ length: 5 }, (_, oy) => oy - 2).some((oy) =>
        Array.from({ length: 5 }, (_, ox) => ox - 2).some((ox) =>
          Math.abs(ox) + Math.abs(oy) <= 2 &&
          (world.transport![(y + oy) * world.descriptor.width + x + ox] ?? 0) !== 0,
        ),
      )
      expect(roadAccess).toBe(true)
    }
  })

  it('emits non-overlapping, connected, buildable campus layouts with road access', () => {
    const occupied = new Set<number>()
    let solarCount = 0
    for (const seed of [17, 73, 417, 9001]) {
      const world = generateStaticWorldV6({ ...options, seed })
      expect(world.municipalPowerPlants).toHaveLength(world.cities.length)
      for (const plant of world.municipalPowerPlants!) {
        const layout = plant.layout!
        expect(layout.version).toBe(1)
        expect(layout.orientationQuarterTurns).toBeGreaterThanOrEqual(0)
        expect(layout.orientationQuarterTurns).toBeLessThanOrEqual(3)
        expect(plant.footprint).toContain(layout.equipmentTileId)
        if (plant.kind === 'solar') {
          solarCount++
          expect(plant.footprint.length).toBeGreaterThanOrEqual(6)
          expect(plant.footprint.length).toBeLessThanOrEqual(12)
          expect(layout.panelTileIds.length).toBe(plant.footprint.length - 1)
        }
        const footprint = new Set<number>(plant.footprint)
        const queue = [plant.footprint[0]!]
        const visited = new Set<number>(queue)
        while (queue.length > 0) {
          const id = queue.pop()!
          const x = id % world.descriptor.width
          for (const neighbor of [id - world.descriptor.width, id + 1, id + world.descriptor.width, id - 1]) {
            if (Math.abs(neighbor % world.descriptor.width - x) > 1 || !footprint.has(neighbor) || visited.has(neighbor)) continue
            visited.add(neighbor)
            queue.push(neighbor as TileId)
          }
        }
        expect(visited.size).toBe(plant.footprint.length)
        let roadAccess = false
        for (const id of plant.footprint) {
          expect(occupied.has(seed * world.kind.length + id)).toBe(false)
          occupied.add(seed * world.kind.length + id)
          expect(world.district![id]).toBe(2)
          expect(world.transport![id]).toBe(0)
          const x = id % world.descriptor.width
          const y = Math.floor(id / world.descriptor.width)
          expect(getTileSlope(world, x, y)).toBeLessThanOrEqual(0.12)
          roadAccess ||= [id - world.descriptor.width, id + 1, id + world.descriptor.width, id - 1]
            .some((neighbor) => (world.transport![neighbor] ?? 0) !== 0)
        }
        expect(roadAccess).toBe(true)
      }
    }
    expect(solarCount).toBeGreaterThan(0)
  })

  it('fingerprints authoritative layout metadata', () => {
    const world = generateStaticWorldV6(options)
    const plants = world.municipalPowerPlants!.map((plant, index): MunicipalPowerPlant => index === 0
      ? { ...plant, layout: { ...plant.layout!, orientationQuarterTurns: ((plant.layout!.orientationQuarterTurns + 1) % 4) as 0 | 1 | 2 | 3 } }
      : plant)
    const descriptor = world.descriptor as WorldDescriptorV6
    const changed = staticWorldV6Hash(descriptor,
      [world.kind, world.region, world.feature, world.variantMask, world.transport!, world.elevation!, world.biome!, world.district!],
      world.cities, world.regions, world.lakes, world.starterPads, plants)
    expect(changed).not.toBe(world.staticHash)
  })
})

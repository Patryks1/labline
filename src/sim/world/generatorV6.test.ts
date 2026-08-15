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
  TRANSPORT_CLASS_MASK,
  TRANSPORT_CLASS_SHIFT,
  TRANSPORT_ROAD_CLASS,
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
      settlementAlgorithmVersion: 5,
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
    // Frozen hash. Last reviewed change: municipalCapacityMw now excludes the
    // utility's external contract MW from demand and adds a starter reserve,
    // so every starting city can sell spare power (hash moved ccbf587e →
    // a6021c6d). Bump only after reviewing the generator diff again.
    expect(before.staticHash).toBe('a6021c6d')
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

  it('opens short local-road loops instead of stamping neighborhood rings across streets', () => {
    for (const seed of [17, 73, 417, 9001]) {
      const world = generateStaticWorldV6({ ...options, seed })
      expect(hasShortLocalRoadCycle(world.transport!, world.descriptor.width, world.descriptor.height, 8),
        `seed ${seed}: short local-road cycle`).toBe(false)
      expect(hasAdjacentParallelLocalRoads(world.transport!, world.descriptor.width, world.descriptor.height),
        `seed ${seed}: adjacent parallel local roads`).toBe(false)
      const descriptor = world.descriptor as WorldDescriptorV6
      const legacy = regenerateStaticWorld({ ...descriptor, settlementAlgorithmVersion: 3 })
      let oneTileGaps = 0
      for (let id = 0; id < world.transport!.length; id++) {
        const wasLocal = ((legacy.transport![id]! & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT) ===
          TRANSPORT_ROAD_CLASS.local
        if (!wasLocal || world.transport![id] !== 0) continue
        const x = id % world.descriptor.width
        const neighbors = [id - world.descriptor.width, id + 1, id + world.descriptor.width, id - 1]
          .filter((neighbor) => neighbor >= 0 && neighbor < world.transport!.length &&
            Math.abs(neighbor % world.descriptor.width - x) <= 1 && world.transport![neighbor] !== 0)
        if (neighbors.length >= 2) oneTileGaps++
      }
      expect(oneTileGaps, `seed ${seed}: physical one-tile road gaps`).toBeGreaterThan(0)
    }
  }, 20_000)

  it('grows asymmetric streets with bends and suburban dead ends instead of uniform crosses', () => {
    for (const seed of [17, 73, 417, 9001]) {
      const world = generateStaticWorldV6({ ...options, seed })
      let settlementsWithTurns = 0
      let settlementsWithDeadEnds = 0
      let fourWayCentres = 0
      const developedSettlements = world.cities.filter((city) => city.tier !== 'village')
      const streetShapes: string[] = []
      for (const city of developedSettlements) {
        const centerId = city.cy * world.descriptor.width + city.cx
        if (cardinalRoadDegree(world.transport!, centerId) === 4) fourWayCentres++
        const extent = Math.ceil(city.radius * 1.55)
        let turns = 0
        let deadEnds = 0
        for (let y = Math.max(1, city.cy - extent); y <= Math.min(world.descriptor.height - 2, city.cy + extent); y++) {
          for (let x = Math.max(1, city.cx - extent); x <= Math.min(world.descriptor.width - 2, city.cx + extent); x++) {
            const id = y * world.descriptor.width + x
            const roadClass = (world.transport![id]! & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT
            if (roadClass === TRANSPORT_ROAD_CLASS.none) continue
            const mask = world.transport![id]! & 0x55
            const degree = cardinalRoadDegree(world.transport!, id)
            if (degree === 1) deadEnds++
            if (degree === 2 && mask !== 0x11 && mask !== 0x44) turns++
          }
        }
        if (turns >= 1) settlementsWithTurns++
        if (deadEnds >= 2) settlementsWithDeadEnds++
        streetShapes.push(`${city.tier}:${turns}/${deadEnds}`)
      }
      expect(settlementsWithTurns, `seed ${seed}: settlements with curved street paths (${streetShapes.join(', ')})`)
        .toBeGreaterThanOrEqual(Math.ceil(developedSettlements.length * 0.7))
      expect(settlementsWithDeadEnds, `seed ${seed}: settlements with suburban dead ends (${streetShapes.join(', ')})`)
        .toBeGreaterThanOrEqual(Math.ceil(developedSettlements.length * 0.7))
      expect(fourWayCentres, `seed ${seed}: uniform four-way civic centres`)
        .toBeLessThan(developedSettlements.length)
    }
  }, 20_000)

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

function hasShortLocalRoadCycle(
  transport: Uint16Array,
  width: number,
  height: number,
  maxCycleEdges: number,
): boolean {
  const cardinal = [[0, -1, 0], [1, 0, 2], [0, 1, 4], [-1, 0, 6]] as const
  const local = (id: number) =>
    ((transport[id]! & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT) === TRANSPORT_ROAD_CLASS.local
  const connected = (from: number, to: number, direction: number) =>
    (transport[from]! & (1 << direction)) !== 0 &&
    (transport[to]! & (1 << ((direction + 4) & 7))) !== 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x
      if (!local(start)) continue
      for (const [dx, dy, direction] of [[1, 0, 2], [0, 1, 4]] as const) {
        const nx = x + dx
        const ny = y + dy
        if (nx >= width || ny >= height) continue
        const goal = ny * width + nx
        if (!local(goal) || !connected(start, goal, direction)) continue
        const queue: Array<{ id: number; depth: number }> = [{ id: start, depth: 0 }]
        const seen = new Set<number>([start])
        for (let cursor = 0; cursor < queue.length; cursor++) {
          const current = queue[cursor]!
          if (current.depth >= maxCycleEdges - 1) continue
          const cx = current.id % width
          const cy = Math.floor(current.id / width)
          for (const [stepX, stepY, stepDirection] of cardinal) {
            const tx = cx + stepX
            const ty = cy + stepY
            if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue
            const next = ty * width + tx
            if ((current.id === start && next === goal) || !local(next) ||
                !connected(current.id, next, stepDirection) || seen.has(next)) continue
            if (next === goal && current.depth + 1 >= 2) return true
            seen.add(next)
            queue.push({ id: next, depth: current.depth + 1 })
          }
        }
      }
    }
  }
  return false
}

function hasAdjacentParallelLocalRoads(
  transport: Uint16Array,
  width: number,
  height: number,
): boolean {
  const local = (id: number) =>
    ((transport[id]! & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT) === TRANSPORT_ROAD_CLASS.local
  const connected = (from: number, to: number, direction: number) =>
    (transport[from]! & (1 << direction)) !== 0 &&
    (transport[to]! & (1 << ((direction + 4) & 7))) !== 0
  for (let y = 0; y + 1 < height; y++) {
    for (let x = 0; x + 1 < width; x++) {
      const nw = y * width + x
      const ne = nw + 1
      const sw = nw + width
      const se = sw + 1
      const includesLocal = [nw, ne, sw, se].some(local)
      if (!includesLocal) continue
      if (connected(nw, ne, 2) && connected(sw, se, 2)) return true
      if (connected(nw, sw, 4) && connected(ne, se, 4)) return true
    }
  }
  return false
}

function cardinalRoadDegree(transport: Uint16Array, id: number): number {
  const topology = transport[id]! & 0x55
  let degree = 0
  for (const direction of [0, 2, 4, 6]) {
    if ((topology & (1 << direction)) !== 0) degree++
  }
  return degree
}

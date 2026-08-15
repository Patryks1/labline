import { describe, expect, it } from 'vitest'
import {
  generateStaticWorldV4,
  generateStaticWorldV5,
  getTileSlope,
  staticWorldV5Hash,
} from './generator'
import {
  BIOME_KIND,
  TERRAIN_KIND,
  TRANSPORT_CLASS_MASK,
  TRANSPORT_CLASS_SHIFT,
  TRANSPORT_FLAGS,
  TRANSPORT_ROAD_CLASS,
  type StaticCity,
} from './types'

function landUseDistance(city: StaticCity, x: number, y: number): number {
  const angle = Math.atan2(city.growth?.directionY ?? 0, city.growth?.directionX ?? 1) * 0.45
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = x - city.cx
  const dy = y - city.cy
  const rx = dx * cos + dy * sin
  const ry = -dx * sin + dy * cos
  const aspect = city.tier === 'metro' ? 1.35 : city.tier === 'satellite' ? 1.55 : 1.25
  return (Math.abs(rx / (Math.max(1, city.radius) * aspect)) ** 2.6 +
    Math.abs(ry / Math.max(1, city.radius / Math.sqrt(aspect))) ** 2.6) ** (1 / 2.6)
}

function roadClass(value: number): number {
  return (value & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT
}

describe('V5 suburbs and municipal power', () => {
  it('is deterministic and creates one buildable connected campus per city', () => {
    const options = { seed: 0x51ab, width: 160, height: 144, cityCount: 3, waterCoverage: 0.12 }
    const a = generateStaticWorldV5(options)
    const b = generateStaticWorldV5(options)
    expect(a.staticHash).toBe(b.staticHash)
    expect([...a.district!]).toEqual([...b.district!])
    expect(a.municipalPowerPlants).toEqual(b.municipalPowerPlants)
    expect(a.municipalPowerPlants).toHaveLength(a.cities.length)
    expect(a.district!.some((value) => value === 1)).toBe(true)

    for (const plant of a.municipalPowerPlants!) {
      expect(plant.cityIndex).toBeGreaterThanOrEqual(0)
      expect(plant.capacityMw).toBeGreaterThan(0)
      expect(plant.footprint).toHaveLength(4)
      for (const id of plant.footprint) {
        const x = id % a.descriptor.width
        const y = Math.floor(id / a.descriptor.width)
        expect(a.kind[id]).not.toBe(TERRAIN_KIND.lake)
        expect(a.transport![id]).toBe(0)
        expect(a.district![id]).toBe(2)
        expect(getTileSlope(a, x, y)).toBeLessThanOrEqual(0.16)
      }
      const reachableSpur = plant.footprint.some((id) => {
        const x = id % a.descriptor.width
        const y = Math.floor(id / a.descriptor.width)
        return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) =>
          (a.transport![(y + dy!) * a.descriptor.width + x + dx!] ?? 0) !== 0)
      })
      expect(reachableSpur).toBe(true)
    }
  })

  it('includes district and campus metadata in only the V5 fingerprint', () => {
    const v4 = generateStaticWorldV4({ seed: 90210, width: 96, height: 96, cityCount: 2 })
    expect(v4.district).toBeUndefined()
    expect(v4.municipalPowerPlants).toBeUndefined()

    const world = generateStaticWorldV5({ seed: 90210, width: 96, height: 96, cityCount: 2 })
    const district = world.district!.slice()
    district[0] = district[0] === 1 ? 0 : 1
    const changed = staticWorldV5Hash(
      world.descriptor as Extract<typeof world.descriptor, { generatorVersion: 5 }>,
      [world.kind, world.region, world.feature, world.variantMask, world.transport!, world.elevation!, world.biome!, district],
      world.cities, world.regions, world.lakes, world.starterPads, world.municipalPowerPlants,
    )
    expect(changed).not.toBe(world.staticHash)
  })

  it('adds deterministic meadow, boreal, and scrubland regions without changing V4 biomes', () => {
    const options = { seed: 0x51ab, width: 160, height: 144, cityCount: 3, waterCoverage: 0.12 }
    const v4 = generateStaticWorldV4(options)
    const v5a = generateStaticWorldV5(options)
    const v5b = generateStaticWorldV5(options)
    const v4Kinds = new Set(v4.biome)
    const v5Kinds = new Set(v5a.biome)

    expect(v4Kinds.has(BIOME_KIND.meadow)).toBe(false)
    expect(v4Kinds.has(BIOME_KIND.boreal)).toBe(false)
    expect(v4Kinds.has(BIOME_KIND.scrubland)).toBe(false)
    expect(v5Kinds.has(BIOME_KIND.meadow)).toBe(true)
    expect(v5Kinds.has(BIOME_KIND.boreal)).toBe(true)
    expect(v5Kinds.has(BIOME_KIND.scrubland)).toBe(true)
    expect(v5a.biome).toEqual(v5b.biome)
  })

  it('forms a connected detached-house ring outside a dense and mixed-density centre', () => {
    for (const seed of [17, 73, 417, 9001]) {
      const world = generateStaticWorldV5({ seed, width: 128, height: 128, cityCount: 3 })
      const { width } = world.descriptor
      let allCoreCity = 0
      let allCoreLand = 0
      let allTransitionCity = 0
      let allTransitionHouse = 0
      for (const city of world.cities.filter((candidate) => candidate.tier === 'town')) {
        const featureId = city.index + 1
        const suburbs: number[] = []
        const connectedFabric = new Set<number>()
        let coreCity = 0
        let coreLand = 0
        let transitionCity = 0
        let transitionHouse = 0
        let residentialLand = 0
        let suburbDistance = 0
        let denseDistance = 0
        let denseCount = 0
        for (let id = 0; id < world.kind.length; id++) {
          if (world.feature[id] !== featureId) continue
          const x = id % width
          const y = Math.floor(id / width)
          const distance = landUseDistance(city, x, y)
          const kind = world.kind[id]!
          if (kind === TERRAIN_KIND.city || kind === TERRAIN_KIND.house || kind === TERRAIN_KIND.park) {
            residentialLand++
          }
          if (distance <= 0.52 && roadClass(world.transport![id]!) === 0) {
            coreLand++
            if (kind === TERRAIN_KIND.city) coreCity++
          }
          if (distance > 0.4 && distance <= 0.76 && roadClass(world.transport![id]!) === 0) {
            if (kind === TERRAIN_KIND.city) transitionCity++
            if (kind === TERRAIN_KIND.house) transitionHouse++
          }
          if (world.district![id] === 1) {
            suburbs.push(id)
            suburbDistance += distance
            connectedFabric.add(id)
          } else if (kind === TERRAIN_KIND.city) {
            denseDistance += distance
            denseCount++
          }
          if ((world.transport![id]! & TRANSPORT_FLAGS.settlement) !== 0) connectedFabric.add(id)
        }
        const fabricExtent = Math.ceil(city.radius * 2)
        for (let y = Math.max(0, city.cy - fabricExtent); y <= Math.min(world.descriptor.height - 1, city.cy + fabricExtent); y++) {
          for (let x = Math.max(0, city.cx - fabricExtent); x <= Math.min(width - 1, city.cx + fabricExtent); x++) {
            const id = y * width + x
            if ((world.transport![id]! & TRANSPORT_FLAGS.settlement) !== 0) connectedFabric.add(id)
          }
        }

        allCoreCity += coreCity
        allCoreLand += coreLand
        allTransitionCity += transitionCity
        allTransitionHouse += transitionHouse
        expect(suburbs.length / residentialLand, `seed ${seed}: ${city.id} suburban share`).toBeGreaterThan(0.18)
        expect(suburbDistance / suburbs.length, `seed ${seed}: ${city.id} suburban ring`)
          .toBeGreaterThan(denseDistance / denseCount)

        const remaining = new Set(connectedFabric)
        let largestSuburbCount = 0
        while (remaining.size > 0) {
          const first = remaining.values().next().value!
          remaining.delete(first)
          const queue = [first]
          let componentSuburbs = 0
          while (queue.length > 0) {
            const id = queue.pop()!
            if (world.district![id] === 1) componentSuburbs++
            const x = id % width
            for (const neighbor of [id - width, id + 1, id + width, id - 1]) {
              if (neighbor < 0 || neighbor >= world.kind.length || Math.abs(neighbor % width - x) > 1) continue
              if (remaining.delete(neighbor)) queue.push(neighbor)
            }
          }
          largestSuburbCount = Math.max(largestSuburbCount, componentSuburbs)
        }
        expect(largestSuburbCount / suburbs.length, `seed ${seed}: ${city.id} contiguous suburb`)
          .toBeGreaterThanOrEqual(0.65)
      }
      expect(allCoreLand, `seed ${seed}: town cores`).toBeGreaterThan(0)
      expect(allCoreCity / allCoreLand, `seed ${seed}: dense town cores`).toBeGreaterThanOrEqual(0.75)
      expect(allTransitionCity, `seed ${seed}: mid-density town blocks`).toBeGreaterThan(0)
      expect(allTransitionHouse, `seed ${seed}: mid-density town houses`).toBeGreaterThan(0)
    }
  })

  it('keeps suburban, park, and industrial land uses serviced and off water and roads', () => {
    for (const seed of [17, 73, 417, 9001]) {
      const world = generateStaticWorldV5({ seed, width: 128, height: 128, cityCount: 3 })
      const { width } = world.descriptor
      let parks = 0
      let industrial = 0
      for (let id = 0; id < world.kind.length; id++) {
        const cityIndex = world.feature[id]! - 1
        if (cityIndex < 0 || cityIndex >= world.cities.length) continue
        const kind = world.kind[id]!
        if (world.district![id] === 1) {
          const x = id % width
          const y = Math.floor(id / width)
          expect(kind, `seed ${seed}: suburb ${id} water`).not.toBe(TERRAIN_KIND.lake)
          expect(roadClass(world.transport![id]!), `seed ${seed}: suburb ${id} road conflict`).toBe(0)
          const roadAccess = Array.from({ length: 5 }, (_, oy) => oy - 2).some((oy) =>
            Array.from({ length: 5 }, (_, ox) => ox - 2).some((ox) =>
              Math.abs(ox) + Math.abs(oy) <= 2 &&
              roadClass(world.transport![(y + oy) * width + x + ox] ?? 0) > 0,
            ),
          )
          expect(roadAccess, `seed ${seed}: suburb ${id} access`).toBe(true)
          if (kind === TERRAIN_KIND.park) parks++
        }
        if (kind === TERRAIN_KIND.warehouse && world.district![id] !== 2) {
          industrial++
          const city = world.cities[cityIndex]!
          const x = id % width
          const y = Math.floor(id / width)
          expect(landUseDistance(city, x, y), `seed ${seed}: warehouse ${id} outside core`)
            .toBeGreaterThan(0.8)
          expect(roadClass(world.transport![id]!), `seed ${seed}: warehouse ${id} road conflict`).toBe(0)
          const serviced = [id - width, id + 1, id + width, id - 1].some((neighbor) =>
            roadClass(world.transport![neighbor] ?? 0) >= TRANSPORT_ROAD_CLASS.collector ||
            ((world.transport![neighbor] ?? 0) & TRANSPORT_FLAGS.regional) !== 0,
          )
          expect(serviced, `seed ${seed}: warehouse ${id} road access`).toBe(true)
        }
      }
      expect(parks, `seed ${seed}: neighborhood parks`).toBeGreaterThan(0)
      expect(industrial, `seed ${seed}: industrial area`).toBeGreaterThanOrEqual(world.cities.length)
    }
  }, 20_000)
})

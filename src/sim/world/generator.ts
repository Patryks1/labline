import { tileId } from './ids'
import {
  DISTRICT_KIND,
  TERRAIN_KIND,
  TRANSPORT_CLASS_MASK,
  TRANSPORT_CLASS_SHIFT,
  TRANSPORT_FLAGS,
  TRANSPORT_ROAD_CLASS,
  WORLD_FORMAT_VERSION,
  WORLD_GENERATOR_VERSION,
  WORLD_GENERATOR_VERSION_V3,
  WORLD_GENERATOR_VERSION_V4,
  WORLD_GENERATOR_VERSION_V5,
  WORLD_GENERATOR_VERSION_V6,
  BIOME_KIND,
  type CityGrowthMetadata,
  type CityIndustry,
  type CityPalette,
  type CityTier,
  type StaticCity,
  type StaticLake,
  type MunicipalPowerPlant,
  type MunicipalPowerCampusLayout,
  type MunicipalPowerPlantKind,
  type StaticRegion,
  type StaticWorld,
  type TerrainKind,
  type TransportRoadClass,
  type TileId,
  type WorldDescriptor,
  type WorldDescriptorV2,
  type WorldDescriptorV3,
  type WorldDescriptorV4,
  type WorldDescriptorV5,
  type WorldDescriptorV6,
  type BiomeKind,
} from './types'

const CITY_NAMES = [
  'Harborline',
  'Midridge',
  'Northfen',
  'Ashford',
  'Kelvin Bay',
  'Stonewell',
  'Westhaven',
  'Ironmere',
  'Cedar Point',
  'Brightwater',
  'Redwick',
  'Cloudrest',
  'Southbank',
  'Grayhaven',
  'Frostbridge',
  'New Carrow',
  'Goldfield',
  'Eastmere',
  'Pinegate',
  'Kingsport',
  'Rivermark',
  'Highplain',
  'Oakstrand',
  'Silvercross',
] as const

const INDUSTRIES: readonly CityIndustry[] = ['tech', 'industrial', 'port', 'finance', 'mixed']
const LAKE_FEATURE_BIT = 0x8000

export interface WorldGenerationOptions {
  readonly seed: number
  readonly width: number
  readonly height: number
  readonly cityCount?: number
  readonly chunkSize?: number
  readonly landValueBase?: number
  readonly landValueCityPeak?: number
  readonly energyPricePerMWh?: number
  readonly waterCoverage?: number
}

interface RandomSource {
  next(): number
  int(min: number, max: number): number
  range(min: number, max: number): number
}

interface LakeSeed {
  cx: number
  cy: number
  radiusX: number
  radiusY: number
  target: number
}

function createRandom(seed: number): RandomSource {
  let state = seed >>> 0
  return {
    next() {
      state += 0x6d2b79f5
      let value = Math.imul(state ^ (state >>> 15), 1 | state)
      value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    },
    int(min, max) {
      return Math.floor(min + this.next() * (max - min + 1))
    },
    range(min, max) {
      return min + this.next() * (max - min)
    },
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function coordinateHash(x: number, y: number, seed: number): number {
  let value = Math.imul(x ^ seed, 0x45d9f3b) ^ Math.imul(y + seed, 0x27d4eb2d)
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  return value >>> 0
}

export function encodeCityFeature(cityIndex: number): number {
  if (!Number.isInteger(cityIndex) || cityIndex < 0 || cityIndex >= 0x7fff) {
    throw new RangeError('city index cannot be encoded as a world feature')
  }
  return cityIndex + 1
}

export function encodeLakeFeature(lakeIndex: number): number {
  if (!Number.isInteger(lakeIndex) || lakeIndex < 0 || lakeIndex >= 0x7fff) {
    throw new RangeError('lake index cannot be encoded as a world feature')
  }
  return LAKE_FEATURE_BIT | (lakeIndex + 1)
}

export function cityIndexFromFeature(feature: number): number | undefined {
  return feature > 0 && (feature & LAKE_FEATURE_BIT) === 0 ? feature - 1 : undefined
}

export function lakeIndexFromFeature(feature: number): number | undefined {
  return (feature & LAKE_FEATURE_BIT) !== 0 ? (feature & ~LAKE_FEATURE_BIT) - 1 : undefined
}

export function deriveCityCount(width: number, height: number): number {
  return clamp(Math.round((width * height) / 80_000), 2, 16)
}

export function createWorldDescriptor(options: WorldGenerationOptions): WorldDescriptorV2 {
  const { width, height } = options
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 16 || height < 16) {
    throw new RangeError('world dimensions must be integers of at least 16 tiles')
  }
  if (width > 4096 || height > 4096 || width * height > 0xffff_ffff) {
    throw new RangeError('world dimensions exceed the numeric tile-id limit')
  }
  const cityCount = options.cityCount ?? deriveCityCount(width, height)
  if (!Number.isSafeInteger(cityCount) || cityCount < 2 || cityCount > 24) {
    throw new RangeError('cityCount must be an integer from 2 through 24')
  }
  const chunkSize = options.chunkSize ?? 32
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 8 || chunkSize > 128) {
    throw new RangeError('chunkSize must be an integer from 8 through 128')
  }
  const waterCoverage = options.waterCoverage ?? 0.055 + (coordinateHash(width, height, options.seed) % 1500) / 100_000
  if (!Number.isFinite(waterCoverage) || waterCoverage < 0.02 || waterCoverage > 0.12) {
    throw new RangeError('waterCoverage must be between 0.02 and 0.12')
  }
  return Object.freeze({
    formatVersion: WORLD_FORMAT_VERSION,
    generatorVersion: WORLD_GENERATOR_VERSION,
    seed: options.seed | 0,
    width,
    height,
    chunkSize,
    cityCount,
    landValueBase: options.landValueBase ?? 30_000,
    landValueCityPeak: options.landValueCityPeak ?? 270_000,
    energyPricePerMWh: options.energyPricePerMWh ?? 72,
    waterCoverage,
  })
}

export function createWorldDescriptorV3(options: WorldGenerationOptions): WorldDescriptorV3 {
  return Object.freeze({
    ...createWorldDescriptor(options),
    generatorVersion: WORLD_GENERATOR_VERSION_V3,
  })
}

export function createWorldDescriptorV4(options: WorldGenerationOptions): WorldDescriptorV4 {
  const base = createWorldDescriptor(options)
  return Object.freeze({
    ...base,
    generatorVersion: WORLD_GENERATOR_VERSION_V4,
    elevationScale: 0.04,
    seaLevel: 0,
    terrainAlgorithmVersion: 1,
    biomeVersion: 1,
  })
}

export function createWorldDescriptorV5(options: WorldGenerationOptions): WorldDescriptorV5 {
  const base = createWorldDescriptor(options)
  return Object.freeze({
    ...base,
    generatorVersion: WORLD_GENERATOR_VERSION_V5,
    elevationScale: 0.04,
    seaLevel: 0,
    terrainAlgorithmVersion: 1,
    biomeVersion: 1,
    transportAlgorithmVersion: 2,
  })
}

export function createWorldDescriptorV6(options: WorldGenerationOptions): WorldDescriptorV6 {
  const base = createWorldDescriptor(options)
  return Object.freeze({
    ...base,
    generatorVersion: WORLD_GENERATOR_VERSION_V6,
    elevationScale: 0.04,
    seaLevel: 0,
    terrainAlgorithmVersion: 1,
    biomeVersion: 1,
    transportAlgorithmVersion: 2,
    settlementAlgorithmVersion: 5,
    municipalCampusAlgorithmVersion: 2,
    cityStatsModelVersion: 1,
  })
}

type ReliefWorldDescriptor = WorldDescriptorV4 | WorldDescriptorV5 | WorldDescriptorV6
type HierarchicalWorldDescriptor = WorldDescriptorV5 | WorldDescriptorV6

function isReliefDescriptor(descriptor: WorldDescriptor): descriptor is ReliefWorldDescriptor {
  return descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V4 ||
    descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V5 ||
    descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V6
}

function lakeSeeds(descriptor: WorldDescriptor, rng: RandomSource): LakeSeed[] {
  const area = descriptor.width * descriptor.height
  const targetWater = Math.floor(area * descriptor.waterCoverage)
  const count = area >= 500_000 ? 4 : area >= 80_000 ? 3 : 2
  const targets: number[] = []
  let remaining = targetWater
  for (let i = 0; i < count; i++) {
    const target = i === count - 1 ? remaining : Math.floor(targetWater * (i === 0 ? 0.52 : 0.48 / (count - 1)))
    targets.push(target)
    remaining -= target
  }

  const result: LakeSeed[] = []
  for (const target of targets) {
    const aspect = rng.range(0.72, 1.42)
    const radiusX = Math.max(3, Math.round(Math.sqrt((target * aspect) / Math.PI)))
    const radiusY = Math.max(3, Math.round(Math.sqrt(target / (Math.PI * aspect))))
    const marginX = Math.min(radiusX + 3, Math.floor(descriptor.width / 2) - 1)
    const marginY = Math.min(radiusY + 3, Math.floor(descriptor.height / 2) - 1)
    let best: LakeSeed | undefined
    let bestClearance = -Infinity
    for (let attempt = 0; attempt < 80; attempt++) {
      const cx = rng.int(marginX, descriptor.width - marginX - 1)
      const cy = rng.int(marginY, descriptor.height - marginY - 1)
      let clearance = Infinity
      for (const other of result) {
        const distance = Math.hypot(cx - other.cx, cy - other.cy)
        clearance = Math.min(clearance, distance - Math.max(radiusX, radiusY) - Math.max(other.radiusX, other.radiusY))
      }
      if (result.length === 0) clearance = Infinity
      if (clearance > bestClearance) {
        bestClearance = clearance
        best = { cx, cy, radiusX, radiusY, target }
      }
      if (clearance > 12) break
    }
    if (best) result.push(best)
  }
  return result
}

function paintLakes(
  descriptor: WorldDescriptor,
  kind: Uint8Array,
  feature: Uint16Array,
  rng: RandomSource,
): StaticLake[] {
  const seeds = lakeSeeds(descriptor, rng)
  const lakes: StaticLake[] = []
  for (let index = 0; index < seeds.length; index++) {
    const lake = seeds[index]!
    const phaseA = rng.range(0, Math.PI * 2)
    const phaseB = rng.range(0, Math.PI * 2)
    let tileCount = 0
    const minX = Math.max(0, lake.cx - lake.radiusX - 2)
    const maxX = Math.min(descriptor.width - 1, lake.cx + lake.radiusX + 2)
    const minY = Math.max(0, lake.cy - lake.radiusY - 2)
    const maxY = Math.min(descriptor.height - 1, lake.cy + lake.radiusY + 2)
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const nx = (x - lake.cx) / lake.radiusX
        const ny = (y - lake.cy) / lake.radiusY
        const angle = Math.atan2(ny, nx)
        const boundary = 1 + Math.sin(angle * 3 + phaseA) * 0.055 + Math.sin(angle * 7 + phaseB) * 0.025
        if (Math.hypot(nx, ny) > boundary) continue
        const id = y * descriptor.width + x
        if (kind[id] === TERRAIN_KIND.lake) continue
        kind[id] = TERRAIN_KIND.lake
        feature[id] = encodeLakeFeature(index)
        tileCount++
      }
    }
    lakes.push(
      Object.freeze({
        index,
        id: `lake_${index}`,
        name: index === 0 ? 'Great Basin' : `Regional Lake ${index + 1}`,
        cx: lake.cx,
        cy: lake.cy,
        radiusX: lake.radiusX,
        radiusY: lake.radiusY,
        tileCount,
      }),
    )
  }
  return lakes
}

function cityRadiusRange(width: number, height: number): { min: number; max: number } {
  const scale = Math.min(width, height)
  if (scale >= 800) return { min: 18, max: 55 }
  return {
    min: clamp(Math.round(scale * 0.022), 4, 18),
    max: clamp(Math.round(scale * 0.06), 6, 55),
  }
}

function v4CityRadiusRange(width: number, height: number): { min: number; max: number } {
  const scale = Math.min(width, height)
  if (scale >= 64) return cityRadiusRange(width, height)

  // The V2/V3 minimum of four tiles predates 20x20 sandboxes. Two such metros,
  // their lake clearance, and a mountain belt cannot all fit coherently on the
  // smallest maps. Preserve the old range for compatibility generators while
  // scaling only V4 settlement footprints down to the available terrain.
  return {
    min: clamp(Math.round(scale * 0.1), 2, 4),
    max: clamp(Math.round((scale - 8) * 0.12), 2, 6),
  }
}

function diskIsClear(
  cx: number,
  cy: number,
  radius: number,
  width: number,
  height: number,
  kind: Uint8Array,
): boolean {
  const radius2 = radius * radius
  for (let y = cy - radius; y <= cy + radius; y++) {
    if (y < 0 || y >= height) return false
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || x >= width) return false
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= radius2 && kind[y * width + x] === TERRAIN_KIND.lake) return false
    }
  }
  return true
}

function rawTileSlope(descriptor: WorldDescriptor, elevation: Int16Array, x: number, y: number): number {
  const stride = descriptor.width + 1
  const nw = y * stride + x
  const a = elevation[nw]!
  const b = elevation[nw + 1]!
  const c = elevation[nw + stride]!
  const d = elevation[nw + stride + 1]!
  const scale = isReliefDescriptor(descriptor) ? descriptor.elevationScale : 0
  return Math.max(Math.abs(b - a), Math.abs(c - a), Math.abs(d - b), Math.abs(d - c),
    Math.abs(d - a) / Math.SQRT2, Math.abs(c - b) / Math.SQRT2) * scale
}

function terrainDiskIsBuildable(
  descriptor: WorldDescriptor,
  elevation: Int16Array,
  cx: number,
  cy: number,
  radius: number,
  maxSlope: number,
): boolean {
  const radius2 = radius * radius
  // Sampling every other tile keeps large-map placement bounded while still rejecting
  // ridges much narrower than any generated settlement footprint.
  for (let y = cy - radius; y <= cy + radius; y += 2) {
    for (let x = cx - radius; x <= cx + radius; x += 2) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy > radius2) continue
      if (rawTileSlope(descriptor, elevation, x, y) > maxSlope) return false
      // Gentle summit plateaus are still exposed alpine terrain. Settlement and
      // facility-pad searches must reject them even when their local slope is low.
      if (isReliefDescriptor(descriptor)) {
        const height = tileElevationSum(elevation, descriptor.width, x, y) * descriptor.elevationScale / 4
        if (height > descriptor.seaLevel + 3.4) return false
      }
    }
  }
  return true
}

function placeCities(
  descriptor: WorldDescriptor,
  kind: Uint8Array,
  rng: RandomSource,
  elevation?: Int16Array,
  biome?: Uint8Array,
): StaticCity[] {
  const range = isReliefDescriptor(descriptor)
    ? v4CityRadiusRange(descriptor.width, descriptor.height)
    : cityRadiusRange(descriptor.width, descriptor.height)
  const worldScale = Math.min(descriptor.width, descriptor.height)
  const minimumClearance = isReliefDescriptor(descriptor) && worldScale < 64
    ? clamp(Math.round(worldScale * 0.12), 2, 6)
    : Math.max(6, worldScale * 0.012)
  const radii: number[] = []
  for (let i = 0; i < descriptor.cityCount; i++) {
    if (i === 0 && descriptor.width * descriptor.height >= 500_000) {
      radii.push(Math.max(42, Math.round(range.max * 0.82)))
    } else if (i === 1 && range.max - range.min >= 10) {
      radii.push(range.min)
    } else {
      radii.push(rng.int(range.min, range.max))
    }
  }

  const placed: { cx: number; cy: number; radius: number }[] = []
  for (let i = 0; i < descriptor.cityCount; i++) {
    const radius = radii[i]!
    const margin = radius + 3
    let selected: { cx: number; cy: number; score: number } | undefined
    for (let attempt = 0; attempt < 240; attempt++) {
      const cx = rng.int(margin, descriptor.width - margin - 1)
      const cy = rng.int(margin, descriptor.height - margin - 1)
      if (!diskIsClear(cx, cy, radius + 2, descriptor.width, descriptor.height, kind)) continue
      if (elevation && !terrainDiskIsBuildable(descriptor, elevation, cx, cy, radius + 1, 0.12)) continue
      if (biome && !settlementBiomeIsFriendly(biome[cy * descriptor.width + cx]!)) continue
      let score = Infinity
      let valid = true
      for (const other of placed) {
        const clearance = Math.hypot(cx - other.cx, cy - other.cy) - radius - other.radius
        score = Math.min(score, clearance)
        if (clearance < minimumClearance) {
          valid = false
          break
        }
      }
      if (placed.length === 0) score = Infinity
      if (valid) {
        selected = { cx, cy, score }
        break
      }
      if (!selected || score > selected.score) selected = { cx, cy, score }
    }
    if (!selected) {
      throw new Error(`unable to place city ${i}; reduce cityCount or water coverage`)
    }
    placed.push({ cx: selected.cx, cy: selected.cy, radius })
  }

  return placed.map((position, index) => {
    const industry = INDUSTRIES[index % INDUSTRIES.length]!
    const population = Math.round(
      Math.PI * position.radius * position.radius * rng.range(1_050, 1_650) + rng.int(30_000, 180_000),
    )
    return Object.freeze({
      index,
      id: `city_${index}`,
      name: CITY_NAMES[index] ?? `City ${index + 1}`,
      cx: position.cx,
      cy: position.cy,
      radius: position.radius,
      population,
      powerRadius: position.radius + clamp(Math.round(position.radius * 0.3), 4, 14),
      powerBuyMw: Math.max(4, population / 70_000),
      powerBuyPriceMult: 0.7 + (index % 3) * 0.06 + rng.range(0, 0.04),
      industry,
      talentWageMult: industry === 'tech' ? 1.18 : industry === 'finance' ? 1.12 : 1,
    })
  })
}

function settlementBiomeIsFriendly(biome: number): boolean {
  return biome !== BIOME_KIND.alpine && biome !== BIOME_KIND.wetland && biome !== BIOME_KIND.coast
}

function stampCities(
  descriptor: WorldDescriptor,
  cities: readonly StaticCity[],
  kind: Uint8Array,
  feature: Uint16Array,
): void {
  for (const city of cities) {
    const featureId = encodeCityFeature(city.index)
    const radius2 = city.radius * city.radius
    const spacing = city.radius >= 28 ? 5 : city.radius >= 10 ? 4 : 3
    for (let y = city.cy - city.radius; y <= city.cy + city.radius; y++) {
      for (let x = city.cx - city.radius; x <= city.cx + city.radius; x++) {
        const dx = x - city.cx
        const dy = y - city.cy
        if (dx * dx + dy * dy > radius2) continue
        const id = y * descriptor.width + x
        if (kind[id] === TERRAIN_KIND.lake) continue
        feature[id] = featureId
        const gridRoad = Math.abs(dx) % spacing === 0 || Math.abs(dy) % spacing === 0
        if (gridRoad) {
          kind[id] = TERRAIN_KIND.road
        } else {
          const distanceRatio = Math.hypot(dx, dy) / city.radius
          const variant = coordinateHash(x, y, descriptor.seed + city.index * 101) % 100
          kind[id] =
            distanceRatio < 0.63
              ? TERRAIN_KIND.city
              : variant < 67
                ? TERRAIN_KIND.house
                : variant < 79
                  ? TERRAIN_KIND.park
                  : TERRAIN_KIND.city
        }
      }
    }

    const feederLength = clamp(Math.round(city.radius * 0.35), 5, 16)
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      for (let step = city.radius; step <= city.radius + feederLength; step++) {
        const x = city.cx + dx * step
        const y = city.cy + dy * step
        if (x < 0 || y < 0 || x >= descriptor.width || y >= descriptor.height) break
        const id = y * descriptor.width + x
        if (kind[id] === TERRAIN_KIND.lake) break
        kind[id] = TERRAIN_KIND.road
        feature[id] = featureId
      }
    }
  }
}

type Route = readonly number[]

function visitRoute(route: Route, visit: (x: number, y: number) => void): void {
  for (let point = 0; point + 3 < route.length; point += 2) {
    const x0 = route[point]!
    const y0 = route[point + 1]!
    const x1 = route[point + 2]!
    const y1 = route[point + 3]!
    const dx = Math.sign(x1 - x0)
    const dy = Math.sign(y1 - y0)
    const length = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    for (let step = point === 0 ? 0 : 1; step <= length; step++) {
      visit(x0 + dx * step, y0 + dy * step)
    }
  }
}

function chooseRoute(
  descriptor: WorldDescriptor,
  kind: Uint8Array,
  a: StaticCity,
  b: StaticCity,
): Route {
  const routes: number[][] = [
    [a.cx, a.cy, b.cx, a.cy, b.cx, b.cy],
    [a.cx, a.cy, a.cx, b.cy, b.cx, b.cy],
  ]
  for (let i = 1; i < 32; i++) {
    const x = Math.floor((descriptor.width * i) / 32)
    const y = Math.floor((descriptor.height * i) / 32)
    routes.push([a.cx, a.cy, x, a.cy, x, b.cy, b.cx, b.cy])
    routes.push([a.cx, a.cy, a.cx, y, b.cx, y, b.cx, b.cy])
  }
  let best = routes[0]!
  let bestScore = Infinity
  for (const route of routes) {
    let water = 0
    let length = 0
    visitRoute(route, (x, y) => {
      length++
      if (kind[y * descriptor.width + x] === TERRAIN_KIND.lake) water++
    })
    const score = water * descriptor.width * descriptor.height + length
    if (score < bestScore) {
      bestScore = score
      best = route
    }
  }
  return best
}

function cityRoadEdges(cities: readonly StaticCity[], seed: number): [number, number][] {
  const connected = new Set<number>([0])
  const edges: [number, number][] = []
  while (connected.size < cities.length) {
    let best: [number, number] | undefined
    let bestDistance = Infinity
    for (const from of connected) {
      for (let to = 0; to < cities.length; to++) {
        if (connected.has(to)) continue
        const a = cities[from]!
        const b = cities[to]!
        const distance = (a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2
        if (distance < bestDistance) {
          bestDistance = distance
          best = [from, to]
        }
      }
    }
    if (!best) break
    edges.push(best)
    connected.add(best[1])
  }
  const existing = new Set(edges.map(([a, b]) => `${Math.min(a, b)}:${Math.max(a, b)}`))
  const extras = Math.max(1, Math.floor(cities.length / 4))
  for (let i = 0; i < extras; i++) {
    const from = (i * 5 + seed) % cities.length
    const to = (from + 2 + (seed % Math.max(1, cities.length - 2))) % cities.length
    if (from === to) continue
    const key = `${Math.min(from, to)}:${Math.max(from, to)}`
    if (!existing.has(key)) {
      edges.push([from, to])
      existing.add(key)
    }
  }
  return edges
}

function paintRegionalRoads(
  descriptor: WorldDescriptor,
  cities: readonly StaticCity[],
  kind: Uint8Array,
): void {
  for (const [from, to] of cityRoadEdges(cities, descriptor.seed)) {
    const route = chooseRoute(descriptor, kind, cities[from]!, cities[to]!)
    visitRoute(route, (x, y) => {
      const id = y * descriptor.width + x
      if (kind[id] !== TERRAIN_KIND.lake) kind[id] = TERRAIN_KIND.road
    })
  }
}

function addRuralTerrain(descriptor: WorldDescriptor, kind: Uint8Array, feature: Uint16Array): void {
  const maxWarehouses = Math.max(8, Math.floor((descriptor.width * descriptor.height) / 2_500))
  let warehouses = 0
  for (let y = 1; y + 1 < descriptor.height; y++) {
    for (let x = 1; x + 1 < descriptor.width; x++) {
      const id = y * descriptor.width + x
      if (kind[id] !== TERRAIN_KIND.road || feature[id] !== 0 || warehouses >= maxWarehouses) continue
      if (coordinateHash(x, y, descriptor.seed + 301) % 173 !== 0) continue
      const neighbor = kind[id + 1] === TERRAIN_KIND.empty ? id + 1 : kind[id - 1] === TERRAIN_KIND.empty ? id - 1 : -1
      if (neighbor >= 0) {
        kind[neighbor] = TERRAIN_KIND.warehouse
        warehouses++
      }
    }
  }
  for (let y = 0; y < descriptor.height; y++) {
    for (let x = 0; x < descriptor.width; x++) {
      const id = y * descriptor.width + x
      if (kind[id] !== TERRAIN_KIND.empty) continue
      const coarse = coordinateHash(x >> 2, y >> 2, descriptor.seed + 911)
      const fine = coordinateHash(x, y, descriptor.seed + 1217)
      if (coarse % 11 < 3 && fine % 100 < 31) kind[id] = TERRAIN_KIND.forest
    }
  }
}

function assignRegions(
  descriptor: WorldDescriptor,
  cities: readonly StaticCity[],
  region: Uint8Array,
): StaticRegion[] {
  for (let y = 0; y < descriptor.height; y++) {
    for (let x = 0; x < descriptor.width; x++) {
      let nearest = 0
      let bestDistance = Infinity
      for (const city of cities) {
        const distance = (x - city.cx) ** 2 + (y - city.cy) ** 2
        if (distance < bestDistance) {
          bestDistance = distance
          nearest = city.index
        }
      }
      region[y * descriptor.width + x] = nearest
    }
  }
  return cities.map((city) => {
    const extent = Math.max(city.radius * 3, Math.floor(Math.min(descriptor.width, descriptor.height) / 5))
    const originX = Math.max(0, city.cx - extent)
    const originY = Math.max(0, city.cy - extent)
    const centerDistance = Math.hypot(city.cx - descriptor.width / 2, city.cy - descriptor.height / 2)
    return Object.freeze({
      index: city.index,
      id: city.id,
      name: city.name,
      originX,
      originY,
      width: Math.min(descriptor.width - originX, extent * 2 + 1),
      height: Math.min(descriptor.height - originY, extent * 2 + 1),
      energyPriceMult: 0.78 + (city.index % 5) * 0.075,
      latencyToMarket: clamp(centerDistance / Math.hypot(descriptor.width, descriptor.height), 0.1, 0.85),
      regulationRisk: 0.06 + (city.index % 7) * 0.025,
    })
  })
}

function collectStarterPads(
  descriptor: WorldDescriptor,
  city: StaticCity,
  kind: Uint8Array,
): TileId[] {
  const pads: TileId[] = []
  const width = descriptor.width
  for (let radius = city.radius + 1; radius <= city.radius + 18 && pads.length < 12; radius++) {
    for (let offset = -radius; offset <= radius && pads.length < 12; offset++) {
      for (const [x, y] of [
        [city.cx + offset, city.cy - radius],
        [city.cx + offset, city.cy + radius],
        [city.cx - radius, city.cy + offset],
        [city.cx + radius, city.cy + offset],
      ] as const) {
        if (x <= 0 || y <= 0 || x + 1 >= descriptor.width || y + 1 >= descriptor.height) continue
        const id = y * width + x
        if (kind[id] !== TERRAIN_KIND.empty && kind[id] !== TERRAIN_KIND.forest) continue
        if (
          kind[id - width] === TERRAIN_KIND.road ||
          kind[id + 1] === TERRAIN_KIND.road ||
          kind[id + width] === TERRAIN_KIND.road ||
          kind[id - 1] === TERRAIN_KIND.road
        ) {
          if (!pads.includes(id as TileId)) pads.push(id as TileId)
        }
      }
    }
  }
  return pads
}

function buildVariantMasks(
  descriptor: WorldDescriptor,
  kind: Uint8Array,
  variantMask: Uint8Array,
): void {
  const width = descriptor.width
  for (let y = 0; y < descriptor.height; y++) {
    for (let x = 0; x < width; x++) {
      const id = y * width + x
      const current = kind[id] as TerrainKind
      let mask = (coordinateHash(x, y, descriptor.seed + 1777) & 0xf) << 4
      if (current === TERRAIN_KIND.road || current === TERRAIN_KIND.lake) {
        if (y > 0 && kind[id - width] === current) mask |= 1
        if (x + 1 < width && kind[id + 1] === current) mask |= 2
        if (y + 1 < descriptor.height && kind[id + width] === current) mask |= 4
        if (x > 0 && kind[id - 1] === current) mask |= 8
      }
      variantMask[id] = mask
    }
  }
}

function hashNumber(hash: number, value: number): number {
  hash ^= value & 0xff
  hash = Math.imul(hash, 0x01000193)
  hash ^= (value >>> 8) & 0xff
  return Math.imul(hash, 0x01000193) >>> 0
}

function staticHash(descriptor: WorldDescriptor, layers: readonly ArrayLike<number>[]): string {
  let hash = 0x811c9dc5
  hash = hashNumber(hash, descriptor.seed)
  hash = hashNumber(hash, descriptor.width)
  hash = hashNumber(hash, descriptor.height)
  hash = hashNumber(hash, descriptor.cityCount)
  for (const layer of layers) {
    for (let i = 0; i < layer.length; i++) hash = hashNumber(hash, layer[i]!)
  }
  return hash.toString(16).padStart(8, '0')
}

const CITY_TIER_HASH_CODE: Readonly<Record<CityTier, number>> = {
  metro: 1,
  satellite: 2,
  town: 3,
  village: 4,
}
const V3_SETTLEMENT_HASH_SCHEMA = 0x0301

function hashFloat64(hash: number, value: number): number {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setFloat64(0, value, false)
  for (let offset = 0; offset < 8; offset += 2) {
    hash = hashNumber(hash, view.getUint16(offset, false))
  }
  return hash
}

/**
 * V3 extends the original layer hash with fixed-width settlement metadata.
 * Decimal metadata uses explicit big-endian IEEE-754 bytes, avoiding JSON
 * formatting, object-key ordering, and host-endianness differences.
 */
export function staticWorldV3Hash(
  descriptor: WorldDescriptor,
  layers: readonly ArrayLike<number>[],
  cities: readonly StaticCity[],
): string {
  let hash = Number.parseInt(staticHash(descriptor, layers), 16) >>> 0
  hash = hashNumber(hash, V3_SETTLEMENT_HASH_SCHEMA)
  hash = hashNumber(hash, cities.length)
  for (const city of cities) {
    hash = hashNumber(hash, city.index)
    hash = hashNumber(hash, city.tier ? CITY_TIER_HASH_CODE[city.tier] : 0)
    hash = hashNumber(hash, (city.parentCityIndex ?? -1) + 1)
    hash = hashNumber(hash, (city.regionIndex ?? -1) + 1)
    hash = hashNumber(hash, city.palette?.primary ?? 0xffff)
    hash = hashNumber(hash, city.palette?.secondary ?? 0xffff)
    hash = hashNumber(hash, city.palette?.accent ?? 0xffff)
    hash = hashFloat64(hash, city.growth?.rate ?? 0)
    hash = hashFloat64(hash, city.growth?.directionX ?? 0)
    hash = hashFloat64(hash, city.growth?.directionY ?? 0)
    hash = hashFloat64(hash, city.growth?.irregularity ?? 0)
  }
  return hash.toString(16).padStart(8, '0')
}

export function staticWorldByteLength(world: StaticWorld): number {
  return world.kind.byteLength + world.region.byteLength + world.feature.byteLength + world.variantMask.byteLength +
    (world.transport?.byteLength ?? 0) + (world.elevation?.byteLength ?? 0) +
    (world.biome?.byteLength ?? 0) + (world.district?.byteLength ?? 0)
}

export function generateStaticWorldV2(options: WorldGenerationOptions): StaticWorld {
  const descriptor = createWorldDescriptor(options)
  const size = descriptor.width * descriptor.height
  const kind = new Uint8Array(size)
  const region = new Uint8Array(size)
  const feature = new Uint16Array(size)
  const variantMask = new Uint8Array(size)
  const rng = createRandom(descriptor.seed + 9001)

  const lakes = paintLakes(descriptor, kind, feature, rng)
  const cities = placeCities(descriptor, kind, rng)
  stampCities(descriptor, cities, kind, feature)
  paintRegionalRoads(descriptor, cities, kind)
  const starterPads = collectStarterPads(descriptor, cities[0]!, kind)
  addRuralTerrain(descriptor, kind, feature)
  const regions = assignRegions(descriptor, cities, region)
  buildVariantMasks(descriptor, kind, variantMask)

  let water = 0
  let urban = 0
  let forest = 0
  for (let id = 0; id < size; id++) {
    if (kind[id] === TERRAIN_KIND.lake) water++
    if (cityIndexFromFeature(feature[id]!) !== undefined) urban++
    if (kind[id] === TERRAIN_KIND.forest) forest++
  }

  return {
    descriptor,
    kind,
    region,
    feature,
    variantMask,
    cities: Object.freeze(cities),
    regions: Object.freeze(regions),
    lakes: Object.freeze(lakes),
    starterPads: Object.freeze(starterPads),
    staticHash: staticHash(descriptor, [kind, region, feature, variantMask]),
    coverage: Object.freeze({ water: water / size, urban: urban / size, forest: forest / size }),
  }
}

type V3Settlement = StaticCity & {
  readonly tier: CityTier
  readonly regionIndex: number
  readonly palette: CityPalette
  readonly growth: CityGrowthMetadata
}

interface RoadEdge {
  readonly from: number
  readonly to: number
  readonly loop: boolean
}

interface RoutePoint {
  readonly x: number
  readonly y: number
}

const TIER_SCALE: Readonly<Record<CityTier, number>> = {
  metro: 1,
  satellite: 0.55,
  town: 0.42,
  village: 0.28,
}

function settlementPalette(regionIndex: number, tier: CityTier): CityPalette {
  const tierOffset = tier === 'metro' ? 0 : tier === 'satellite' ? 1 : tier === 'town' ? 2 : 3
  return Object.freeze({
    primary: (regionIndex * 3 + tierOffset) & 0xf,
    secondary: (regionIndex * 5 + tierOffset + 4) & 0xf,
    accent: (regionIndex * 7 + 11) & 0xf,
  })
}

function decorateSettlement(
  city: StaticCity,
  tier: CityTier,
  regionIndex: number,
  parentCityIndex: number | undefined,
  seed: number,
): V3Settlement {
  const angle = ((coordinateHash(city.cx, city.cy, seed + city.index * 43) % 360) * Math.PI) / 180
  return Object.freeze({
    ...city,
    tier,
    parentCityIndex,
    regionIndex,
    palette: settlementPalette(regionIndex, tier),
    growth: Object.freeze({
      rate: tier === 'metro' ? 1 : tier === 'satellite' ? 0.82 : tier === 'town' ? 0.58 : 0.34,
      directionX: Math.cos(angle),
      directionY: Math.sin(angle),
      irregularity: 0.2 + (coordinateHash(city.index, regionIndex, seed + 719) % 46) / 100,
    }),
  })
}

function settlementIsClear(
  cx: number,
  cy: number,
  radius: number,
  descriptor: WorldDescriptor,
  kind: Uint8Array,
  placed: readonly StaticCity[],
  elevation?: Int16Array,
  biome?: Uint8Array,
): boolean {
  if (!diskIsClear(cx, cy, radius + 1, descriptor.width, descriptor.height, kind)) return false
  if (elevation && !terrainDiskIsBuildable(descriptor, elevation, cx, cy, radius, 0.16)) return false
  if (biome && !settlementBiomeIsFriendly(biome[cy * descriptor.width + cx]!)) return false
  for (const other of placed) {
    if (Math.hypot(cx - other.cx, cy - other.cy) < radius + other.radius + 3) return false
  }
  return true
}

function deriveV3Settlements(
  descriptor: WorldDescriptor,
  metroBase: readonly StaticCity[],
  kind: Uint8Array,
  rng: RandomSource,
  elevation?: Int16Array,
  biome?: Uint8Array,
): V3Settlement[] {
  const settlements = metroBase.map((city) =>
    decorateSettlement(city, 'metro', city.index, undefined, descriptor.seed),
  )
  const areaPerMetro = (descriptor.width * descriptor.height) / descriptor.cityCount
  const tierPlan: readonly CityTier[] =
    areaPerMetro >= 12_000
      ? ['satellite', 'town', 'village', 'village']
      : areaPerMetro >= 5_000
        ? ['satellite', 'town', 'village']
        : ['town', 'village']

  for (const metro of settlements.slice(0, descriptor.cityCount)) {
    let townIndex: number | undefined
    for (let ordinal = 0; ordinal < tierPlan.length; ordinal++) {
      const tier = tierPlan[ordinal]!
      const radius = Math.max(2, Math.round(metro.radius * TIER_SCALE[tier]))
      let selected: RoutePoint | undefined
      let bestClearance = -Infinity
      for (let attempt = 0; attempt < 96; attempt++) {
        const phase = rng.range(0, Math.PI * 2)
        const distance = metro.radius + radius + rng.range(7, Math.max(9, metro.radius * 2.4))
        const cx = Math.round(metro.cx + Math.cos(phase) * distance)
        const cy = Math.round(metro.cy + Math.sin(phase) * distance)
        if (cx <= radius + 1 || cy <= radius + 1 || cx + radius + 1 >= descriptor.width || cy + radius + 1 >= descriptor.height) continue
        if (!diskIsClear(cx, cy, radius + 1, descriptor.width, descriptor.height, kind)) continue
        if (elevation && !terrainDiskIsBuildable(descriptor, elevation, cx, cy, radius, 0.16)) continue
        if (biome && !settlementBiomeIsFriendly(biome[cy * descriptor.width + cx]!)) continue
        let clearance = Infinity
        for (const other of settlements) {
          clearance = Math.min(clearance, Math.hypot(cx - other.cx, cy - other.cy) - radius - other.radius)
        }
        if (clearance > bestClearance) {
          bestClearance = clearance
          selected = { x: cx, y: cy }
        }
        if (clearance >= 4) break
      }
      if (!selected || !settlementIsClear(selected.x, selected.y, radius, descriptor, kind, settlements, elevation, biome)) continue

      const index = settlements.length
      const industry = INDUSTRIES[(metro.regionIndex + ordinal + 2) % INDUSTRIES.length]!
      const population = Math.round(
        Math.PI * radius * radius * rng.range(540, 1_020) +
          (tier === 'satellite' ? 18_000 : tier === 'town' ? 7_000 : 900),
      )
      const parentCityIndex = tier === 'village' ? (townIndex ?? metro.index) : metro.index
      const city: StaticCity = {
        index,
        id: `city_${index}`,
        name: `${CITY_NAMES[metro.regionIndex] ?? `Region ${metro.regionIndex + 1}`} ${tier === 'satellite' ? 'Heights' : tier === 'town' ? 'Cross' : `Village ${ordinal + 1}`}`,
        cx: selected.x,
        cy: selected.y,
        radius,
        population,
        powerRadius: radius + clamp(Math.round(radius * 0.35), 2, 8),
        powerBuyMw: Math.max(1, population / 90_000),
        powerBuyPriceMult: metro.powerBuyPriceMult * (tier === 'village' ? 0.86 : 0.94),
        industry,
        talentWageMult: industry === 'tech' ? 1.1 : industry === 'finance' ? 1.06 : 0.94,
      }
      settlements.push(decorateSettlement(city, tier, metro.regionIndex, parentCityIndex, descriptor.seed))
      if (tier === 'town') townIndex = index
    }
  }
  return settlements
}

function transportClass(value: number): number {
  return (value & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT
}

function roadGradeLimit(roadClass: number): number {
  return roadClass === TRANSPORT_ROAD_CLASS.highway ? 0.06 :
    roadClass === TRANSPORT_ROAD_CLASS.arterial ? 0.09 :
      roadClass === TRANSPORT_ROAD_CLASS.collector ? 0.12 : 0.18
}

function markRoad(
  transport: Uint16Array,
  id: number,
  roadClass: number,
  flags: number,
  kind: Uint8Array,
): void {
  const currentClass = transportClass(transport[id]!)
  const bridge = kind[id] === TERRAIN_KIND.lake ? TRANSPORT_FLAGS.bridge : 0
  transport[id] =
    (transport[id]! & 0xff) |
    (Math.max(currentClass, roadClass) << TRANSPORT_CLASS_SHIFT) |
    (transport[id]! & ~0x7ff) |
    flags |
    bridge
}

function connectRoadPoints(
  descriptor: WorldDescriptor,
  transport: Uint16Array,
  from: RoutePoint,
  to: RoutePoint,
): void {
  const dx = Math.sign(to.x - from.x)
  const dy = Math.sign(to.y - from.y)
  const direction = ROUTE_STEPS.findIndex(([stepX, stepY]) => stepX === dx && stepY === dy)
  if (direction < 0) return
  const opposite = (direction + 4) & 7
  transport[from.y * descriptor.width + from.x] |= 1 << direction
  transport[to.y * descriptor.width + to.x] |= 1 << opposite
}

/**
 * Open short all-local cycles without touching collectors or regional roads.
 * Dense inherited grids otherwise produce repeated one-block loops after V6
 * zoning. A safe degree-two road tile is removed from each cycle so the
 * renderer gets a real one-tile gap rather than two disconnected arms whose
 * asphalt caps still read as an almost-closed ring.
 */
function pruneSmallLocalRoadLoops(
  descriptor: WorldDescriptor,
  transport: Uint16Array,
  maxCycleEdges = 8,
  protectedRoadTiles: ReadonlySet<number> = new Set(),
  physicalTileGaps = true,
): void {
  const { width, height } = descriptor
  const cardinal = [
    [0, -1, 0], [1, 0, 2], [0, 1, 4], [-1, 0, 6],
  ] as const
  const local = (id: number) => transportClass(transport[id] ?? 0) === TRANSPORT_ROAD_CLASS.local
  const connected = (from: number, to: number, direction: number) =>
    (transport[from]! & (1 << direction)) !== 0
    && (transport[to]! & (1 << ((direction + 4) & 7))) !== 0

  const roadDegree = (id: number): number => {
    const x = id % width
    const y = Math.floor(id / width)
    let degree = 0
    for (let direction = 0; direction < ROUTE_STEPS.length; direction++) {
      const [dx, dy] = ROUTE_STEPS[direction]!
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const next = ny * width + nx
      if (transportClass(transport[next]!) === TRANSPORT_ROAD_CLASS.none) continue
      if ((transport[id]! & (1 << direction)) !== 0 &&
          (transport[next]! & (1 << ((direction + 4) & 7))) !== 0) degree++
    }
    return degree
  }

  const clearRoadTile = (id: number): void => {
    const x = id % width
    const y = Math.floor(id / width)
    for (let direction = 0; direction < ROUTE_STEPS.length; direction++) {
      if ((transport[id]! & (1 << direction)) === 0) continue
      const [dx, dy] = ROUTE_STEPS[direction]!
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      transport[ny * width + nx] &= ~(1 << ((direction + 4) & 7))
    }
    transport[id] = 0
  }

  const shortAlternatePath = (start: number, goal: number): number[] | undefined => {
    const queue: Array<{ id: number; depth: number }> = [{ id: start, depth: 0 }]
    const seen = new Set<number>([start])
    const parent = new Map<number, number>()
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor]!
      if (current.depth >= maxCycleEdges - 1) continue
      const x = current.id % width
      const y = Math.floor(current.id / width)
      for (const [dx, dy, direction] of cardinal) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const next = ny * width + nx
        if ((current.id === start && next === goal) || !local(next) ||
            !connected(current.id, next, direction) || seen.has(next)) continue
        if (next === goal && current.depth + 1 >= 2) {
          const path = [goal]
          let cursorId = current.id
          while (cursorId !== start) {
            path.push(cursorId)
            cursorId = parent.get(cursorId)!
          }
          path.push(start)
          return path.reverse()
        }
        seen.add(next)
        parent.set(next, current.id)
        queue.push({ id: next, depth: current.depth + 1 })
      }
    }
    return undefined
  }

  // East/south enumerate every cardinal edge exactly once.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = y * width + x
      if (!local(from)) continue
      for (const [dx, dy, direction] of [[1, 0, 2], [0, 1, 4]] as const) {
        const nx = x + dx
        const ny = y + dy
        if (nx >= width || ny >= height) continue
        const to = ny * width + nx
        if (!local(to) || !connected(from, to, direction)) continue
        const cyclePath = shortAlternatePath(from, to)
        if (!cyclePath) continue
        const removable = physicalTileGaps
          ? cyclePath.slice(1, -1).find((id) =>
            local(id) && roadDegree(id) === 2 && !protectedRoadTiles.has(id))
          : undefined
        if (removable !== undefined) {
          clearRoadTile(removable)
        } else {
          // Complex junctions keep their tile; opening one edge still avoids
          // changing collector access or disconnecting an attached branch.
          transport[from] &= ~(1 << direction)
          transport[to] &= ~(1 << ((direction + 4) & 7))
        }
      }
    }
  }
}

/**
 * Enforce a full tile between parallel road corridors. Final topology joins
 * adjacent settlement road tiles automatically, so two neighboring streets
 * otherwise become a dense 2x2 asphalt ladder even after cycle pruning.
 */
function pruneAdjacentParallelLocalRoads(
  descriptor: WorldDescriptor,
  transport: Uint16Array,
  protectedRoadTiles: ReadonlySet<number>,
): void {
  const { width, height } = descriptor
  const connected = (from: number, to: number, direction: number) =>
    (transport[from]! & (1 << direction)) !== 0 &&
    (transport[to]! & (1 << ((direction + 4) & 7))) !== 0
  const road = (id: number) => transportClass(transport[id] ?? 0) !== TRANSPORT_ROAD_CLASS.none
  const local = (id: number) => transportClass(transport[id] ?? 0) === TRANSPORT_ROAD_CLASS.local

  const neighbors = (id: number): number[] => {
    const x = id % width
    const y = Math.floor(id / width)
    const result: number[] = []
    for (let direction = 0; direction < ROUTE_STEPS.length; direction++) {
      if ((transport[id]! & (1 << direction)) === 0) continue
      const [dx, dy] = ROUTE_STEPS[direction]!
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const next = ny * width + nx
      if (road(next) && (transport[next]! & (1 << ((direction + 4) & 7))) !== 0) result.push(next)
    }
    return result
  }

  const removalKeepsNetwork = (removed: number): boolean => {
    const terminals = neighbors(removed)
    if (terminals.length < 2) return false
    const targets = new Set(terminals.slice(1))
    const seen = new Set<number>([removed, terminals[0]!])
    const queue: Array<{ id: number; depth: number }> = [{ id: terminals[0]!, depth: 0 }]
    for (let cursor = 0; cursor < queue.length && targets.size > 0; cursor++) {
      const current = queue[cursor]!
      if (current.depth >= 12) continue
      for (const next of neighbors(current.id)) {
        if (seen.has(next)) continue
        seen.add(next)
        targets.delete(next)
        queue.push({ id: next, depth: current.depth + 1 })
      }
    }
    return targets.size === 0
  }

  const clearRoadTile = (id: number): void => {
    const x = id % width
    const y = Math.floor(id / width)
    for (let direction = 0; direction < ROUTE_STEPS.length; direction++) {
      if ((transport[id]! & (1 << direction)) === 0) continue
      const [dx, dy] = ROUTE_STEPS[direction]!
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      transport[ny * width + nx] &= ~(1 << ((direction + 4) & 7))
    }
    transport[id] = 0
  }

  const tryOpen = (candidates: readonly number[]): boolean => {
    const removable = [...new Set(candidates)]
      .filter((id) => local(id) && !protectedRoadTiles.has(id))
      .sort((a, b) => neighbors(a).length - neighbors(b).length || a - b)
      .find(removalKeepsNetwork)
    if (removable === undefined) return false
    clearRoadTile(removable)
    return true
  }

  // Re-run a few bounded passes because opening one dense cell can expose the
  // neighboring cell's simpler, now-safe removal candidate.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false
    for (let y = 0; y + 1 < height; y++) {
      for (let x = 0; x + 1 < width; x++) {
        const nw = y * width + x
        const ne = nw + 1
        const sw = nw + width
        const se = sw + 1
        const horizontalPair = connected(nw, ne, 2) && connected(sw, se, 2)
        const verticalPair = connected(nw, sw, 4) && connected(ne, se, 4)
        if (horizontalPair) changed = tryOpen([sw, se, nw, ne]) || changed
        if (verticalPair && road(nw) && road(ne) && road(sw) && road(se)) {
          changed = tryOpen([ne, se, nw, sw]) || changed
        }
      }
    }
    if (!changed) break
  }
}

function insideSettlement(city: V3Settlement, x: number, y: number, seed: number): boolean {
  const growth = city.growth
  const angle = Math.atan2(growth.directionY, growth.directionX) * 0.45
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = x - city.cx
  const dy = y - city.cy
  const rx = dx * cos + dy * sin
  const ry = -dx * sin + dy * cos
  const aspect = city.tier === 'metro' ? 1.35 : city.tier === 'satellite' ? 1.55 : 1.25
  const nx = rx / (city.radius * aspect)
  const ny = ry / Math.max(1, city.radius / Math.sqrt(aspect))
  const edgeNoise = ((coordinateHash(x >> 1, y >> 1, seed + city.index * 131) & 0xff) / 255 - 0.5) * growth.irregularity
  return Math.abs(nx) ** 2.6 + Math.abs(ny) ** 2.6 <= 1 + edgeNoise
}

/** Elliptical distance shared by V5's concentric land-use bands. */
function settlementDistance(city: StaticCity, x: number, y: number): number {
  const growth = city.growth
  const angle = Math.atan2(growth?.directionY ?? 0, growth?.directionX ?? 1) * 0.45
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = x - city.cx
  const dy = y - city.cy
  const rx = dx * cos + dy * sin
  const ry = -dx * sin + dy * cos
  const aspect = city.tier === 'metro' ? 1.35 : city.tier === 'satellite' ? 1.55 : 1.25
  const nx = rx / (Math.max(1, city.radius) * aspect)
  const ny = ry / Math.max(1, city.radius / Math.sqrt(aspect))
  return (Math.abs(nx) ** 2.6 + Math.abs(ny) ** 2.6) ** (1 / 2.6)
}

function stampV3Settlements(
  descriptor: WorldDescriptor,
  cities: readonly V3Settlement[],
  kind: Uint8Array,
  feature: Uint16Array,
  transport: Uint16Array,
): void {
  for (const city of cities) {
    const featureId = encodeCityFeature(city.index)
    const extent = Math.ceil(city.radius * 1.65)
    const collectorSpacing = city.tier === 'metro' ? 5 : city.tier === 'satellite' ? 4 : 3

    // Roads are deliberately laid down first and live independently of terrain.
    for (let y = city.cy - extent; y <= city.cy + extent; y++) {
      if (y < 0 || y >= descriptor.height) continue
      for (let x = city.cx - extent; x <= city.cx + extent; x++) {
        if (x < 0 || x >= descriptor.width || !insideSettlement(city, x, y, descriptor.seed)) continue
        const dx = x - city.cx
        const dy = y - city.cy
        const arterial = dx === 0 || dy === 0
        const grid = Math.abs(dx) % collectorSpacing === 0 || Math.abs(dy) % collectorSpacing === 0
        if (arterial || grid) {
          markRoad(
            transport,
            y * descriptor.width + x,
            arterial ? TRANSPORT_ROAD_CLASS.collector : TRANSPORT_ROAD_CLASS.local,
            TRANSPORT_FLAGS.settlement,
            kind,
          )
        }
      }
    }

    for (let y = city.cy - extent; y <= city.cy + extent; y++) {
      if (y < 0 || y >= descriptor.height) continue
      for (let x = city.cx - extent; x <= city.cx + extent; x++) {
        if (x < 0 || x >= descriptor.width || !insideSettlement(city, x, y, descriptor.seed)) continue
        const id = y * descriptor.width + x
        if (kind[id] === TERRAIN_KIND.lake) continue
        feature[id] = featureId
        const distance = Math.hypot(x - city.cx, y - city.cy) / Math.max(1, city.radius)
        const variant = coordinateHash(x, y, descriptor.seed + city.index * 101) % 100
        kind[id] =
          distance < 0.58
            ? TERRAIN_KIND.city
            : variant < 61
              ? TERRAIN_KIND.house
              : variant < 76
                ? TERRAIN_KIND.park
                : TERRAIN_KIND.city
      }
    }
  }
}

/** Upgrade V5 settlement grids without changing the frozen V3/V4 stamping path. */
function upgradeV5SettlementRoadHierarchy(
  descriptor: HierarchicalWorldDescriptor,
  cities: readonly V3Settlement[],
  kind: Uint8Array,
  transport: Uint16Array,
): void {
  for (const city of cities) {
    const extent = Math.ceil(city.radius * 1.65)
    for (let y = Math.max(0, city.cy - extent); y <= Math.min(descriptor.height - 1, city.cy + extent); y++) {
      for (let x = Math.max(0, city.cx - extent); x <= Math.min(descriptor.width - 1, city.cx + extent); x++) {
        const id = y * descriptor.width + x
        if ((transport[id]! & TRANSPORT_FLAGS.settlement) === 0) continue
        const dx = Math.abs(x - city.cx)
        const dy = Math.abs(y - city.cy)
        const centralSpine = dx === 0 || dy === 0
        const target = centralSpine && (city.tier === 'metro' || city.tier === 'satellite')
          ? TRANSPORT_ROAD_CLASS.arterial
          : centralSpine || transportClass(transport[id]!) >= TRANSPORT_ROAD_CLASS.collector
            ? TRANSPORT_ROAD_CLASS.collector
            : TRANSPORT_ROAD_CLASS.local
        markRoad(transport, id, target, TRANSPORT_FLAGS.settlement, kind)
      }
    }
  }
}

class MinHeap {
  private readonly values: { id: number; score: number }[] = []

  get length(): number {
    return this.values.length
  }

  push(id: number, score: number): void {
    const value = { id, score }
    let index = this.values.length
    this.values.push(value)
    while (index > 0) {
      const parent = (index - 1) >>> 1
      const other = this.values[parent]!
      if (other.score < score || (other.score === score && other.id <= id)) break
      this.values[index] = other
      index = parent
    }
    this.values[index] = value
  }

  pop(): { id: number; score: number } | undefined {
    const first = this.values[0]
    const last = this.values.pop()
    if (!first || !last || this.values.length === 0) return first
    let index = 0
    while (true) {
      const left = index * 2 + 1
      if (left >= this.values.length) break
      const right = left + 1
      let child = left
      if (
        right < this.values.length &&
        (this.values[right]!.score < this.values[left]!.score ||
          (this.values[right]!.score === this.values[left]!.score && this.values[right]!.id < this.values[left]!.id))
      ) child = right
      const other = this.values[child]!
      if (last.score < other.score || (last.score === other.score && last.id <= other.id)) break
      this.values[index] = other
      index = child
    }
    this.values[index] = last
    return first
  }
}

const ROUTE_STEPS = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
] as const

function routeRoad(
  descriptor: WorldDescriptor,
  kind: Uint8Array,
  transport: Uint16Array,
  start: RoutePoint,
  goal: RoutePoint,
  avoidWater = false,
  elevation?: Int16Array,
  biome?: Uint8Array,
  roadClass: TransportRoadClass = TRANSPORT_ROAD_CLASS.arterial,
): RoutePoint[] | undefined {
  const direct = Math.hypot(goal.x - start.x, goal.y - start.y)
  const margin = elevation
    ? Math.max(16, Math.ceil(direct * 0.5))
    : Math.max(10, Math.ceil(direct * 0.24))
  const minX = Math.max(0, Math.min(start.x, goal.x) - margin)
  const minY = Math.max(0, Math.min(start.y, goal.y) - margin)
  const maxX = Math.min(descriptor.width - 1, Math.max(start.x, goal.x) + margin)
  const maxY = Math.min(descriptor.height - 1, Math.max(start.y, goal.y) + margin)
  const routeWidth = maxX - minX + 1
  const routeHeight = maxY - minY + 1
  const size = routeWidth * routeHeight
  const costs = new Float64Array(size)
  costs.fill(Infinity)
  const previous = new Int32Array(size)
  previous.fill(-1)
  const priorDirection = new Int8Array(size)
  priorDirection.fill(-1)
  const localId = (x: number, y: number) => (y - minY) * routeWidth + x - minX
  const startId = localId(start.x, start.y)
  const goalId = localId(goal.x, goal.y)
  const heap = new MinHeap()
  costs[startId] = 0
  heap.push(startId, direct)

  while (heap.length > 0) {
    const current = heap.pop()!
    const cx = (current.id % routeWidth) + minX
    const cy = Math.floor(current.id / routeWidth) + minY
    const expected = costs[current.id]! + Math.hypot(goal.x - cx, goal.y - cy)
    if (current.score > expected + 1e-9) continue
    if (current.id === goalId) break
    for (let direction = 0; direction < ROUTE_STEPS.length; direction++) {
      const [dx, dy] = ROUTE_STEPS[direction]!
      const nx = cx + dx
      const ny = cy + dy
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue
      const worldId = ny * descriptor.width + nx
      if (avoidWater && kind[worldId] === TERRAIN_KIND.lake) continue
      if (descriptor.generatorVersion >= WORLD_GENERATOR_VERSION_V5 && dx !== 0 && dy !== 0) {
        // A pair of opposite diagonals through the same 2x2 cell has no shared
        // tile at which to form a junction. Reject that move while routing so
        // the compiled surface can never contain an at-grade X overlap.
        const sideA = cy * descriptor.width + nx
        const sideB = ny * descriptor.width + cx
        const crossingDirection = ROUTE_STEPS.findIndex(([stepX, stepY]) =>
          stepX === -dx && stepY === dy)
        const crossingOpposite = (crossingDirection + 4) & 7
        if ((transport[sideA]! & (1 << crossingDirection)) !== 0 &&
            (transport[sideB]! & (1 << crossingOpposite)) !== 0) continue
      }
      if (elevation && isReliefDescriptor(descriptor)) {
        const currentHeight = tileElevationSum(elevation, descriptor.width, cx, cy) * descriptor.elevationScale / 4
        const nextHeight = tileElevationSum(elevation, descriptor.width, nx, ny) * descriptor.elevationScale / 4
        // Entering or leaving an existing higher-class road must satisfy that
        // road's stricter grade as well. Otherwise the final topology pass will
        // correctly remove the crossing and split an apparently valid route.
        const currentWorldId = cy * descriptor.width + cx
        const gradeLimit = roadGradeLimit(Math.max(
          roadClass,
          transportClass(transport[currentWorldId]!),
          transportClass(transport[worldId]!),
        ))
        if (Math.abs(nextHeight - currentHeight) / Math.hypot(dx, dy) > gradeLimit + 1e-9) continue
      }
      const nextId = localId(nx, ny)
      const biomeCost = biome
        ? biome[worldId] === BIOME_KIND.wetland ? 3.2
          : biome[worldId] === BIOME_KIND.alpine ? 4.4
            : biome[worldId] === BIOME_KIND.forest ? 1.8
              : biome[worldId] === BIOME_KIND.coast ? 2.1 : 1
        : 1
      const terrainCost = (
        kind[worldId] === TERRAIN_KIND.lake ? 26 :
          kind[worldId] === TERRAIN_KIND.forest ? 2.8 :
            kind[worldId] === TERRAIN_KIND.city || kind[worldId] === TERRAIN_KIND.house ? 1.35 : 1
      ) * biomeCost
      const reuseCost = transportClass(transport[worldId]!) > 0 ? 0.34 : 1
      const turnCost = priorDirection[current.id] >= 0 && priorDirection[current.id] !== direction ? 0.38 : 0
      const nextCost = costs[current.id]! + Math.hypot(dx, dy) * terrainCost * reuseCost + turnCost
      if (nextCost >= costs[nextId]! - 1e-9) continue
      costs[nextId] = nextCost
      previous[nextId] = current.id
      priorDirection[nextId] = direction
      heap.push(nextId, nextCost + Math.hypot(goal.x - nx, goal.y - ny))
    }
  }
  if (!Number.isFinite(costs[goalId]!)) return undefined
  const result: RoutePoint[] = []
  for (let current = goalId; current >= 0; current = previous[current]!) {
    result.push({ x: (current % routeWidth) + minX, y: Math.floor(current / routeWidth) + minY })
    if (current === startId) break
  }
  result.reverse()
  return result[0]?.x === start.x && result[0]?.y === start.y ? result : undefined
}

function settlementRoadEdges(cities: readonly V3Settlement[]): RoadEdge[] {
  const candidates = new Map<string, { from: number; to: number; distance: number }>()
  for (const city of cities) {
    const nearest = cities
      .filter((other) => other.index !== city.index)
      .map((other) => ({
        from: Math.min(city.index, other.index),
        to: Math.max(city.index, other.index),
        distance: Math.hypot(city.cx - other.cx, city.cy - other.cy),
      }))
      .sort((a, b) => a.distance - b.distance || a.to - b.to)
      .slice(0, 3)
    for (const edge of nearest) candidates.set(`${edge.from}:${edge.to}`, edge)
  }
  const sorted = [...candidates.values()].sort((a, b) => a.distance - b.distance || a.from - b.from || a.to - b.to)
  const parent = cities.map((_, index) => index)
  const find = (value: number): number => {
    let root = value
    while (parent[root] !== root) root = parent[root]!
    while (parent[value] !== value) {
      const next = parent[value]!
      parent[value] = root
      value = next
    }
    return root
  }
  const edges: RoadEdge[] = []
  const selected = new Set<string>()
  for (const edge of sorted) {
    const a = find(edge.from)
    const b = find(edge.to)
    if (a === b) continue
    parent[b] = a
    edges.push({ from: edge.from, to: edge.to, loop: false })
    selected.add(`${edge.from}:${edge.to}`)
  }
  // Nearest-neighbor candidates can form islands; deterministically join components.
  while (new Set(cities.map((city) => find(city.index))).size > 1) {
    let best: { from: number; to: number; distance: number } | undefined
    for (let from = 0; from < cities.length; from++) {
      for (let to = from + 1; to < cities.length; to++) {
        if (find(from) === find(to)) continue
        const distance = Math.hypot(cities[from]!.cx - cities[to]!.cx, cities[from]!.cy - cities[to]!.cy)
        if (!best || distance < best.distance || (distance === best.distance && (from < best.from || (from === best.from && to < best.to)))) {
          best = { from, to, distance }
        }
      }
    }
    if (!best) break
    parent[find(best.to)] = find(best.from)
    edges.push({ from: best.from, to: best.to, loop: false })
    selected.add(`${best.from}:${best.to}`)
  }
  const loopLimit = Math.max(1, Math.floor(cities.length / 4))
  for (const edge of sorted) {
    if (edges.length >= cities.length - 1 + loopLimit) break
    const key = `${edge.from}:${edge.to}`
    if (selected.has(key)) continue
    selected.add(key)
    edges.push({ from: edge.from, to: edge.to, loop: true })
  }
  return edges
}

function paintV3RegionalRoads(
  descriptor: WorldDescriptor,
  cities: readonly V3Settlement[],
  kind: Uint8Array,
  transport: Uint16Array,
  elevation?: Int16Array,
  biome?: Uint8Array,
): void {
  for (const edge of settlementRoadEdges(cities)) {
    const from = cities[edge.from]!
    const to = cities[edge.to]!
    const start = { x: from.cx, y: from.cy }
    const goal = { x: to.cx, y: to.cy }
    const preferredRoadClass: TransportRoadClass =
      from.tier === 'metro' && to.tier === 'metro' && !edge.loop
        ? TRANSPORT_ROAD_CLASS.highway
        : TRANSPORT_ROAD_CLASS.arterial
    const maxBridgeTiles = clamp(Math.round(Math.hypot(from.cx - to.cx, from.cy - to.cy) * 0.07), 3, 16)

    let roadClass: TransportRoadClass = preferredRoadClass
    let route: RoutePoint[] | undefined
    let bridgeFallback: { route: RoutePoint[]; roadClass: TransportRoadClass } | undefined
    const routeClasses: readonly TransportRoadClass[] = elevation
      ? preferredRoadClass === TRANSPORT_ROAD_CLASS.highway
        ? [
            TRANSPORT_ROAD_CLASS.highway,
            TRANSPORT_ROAD_CLASS.arterial,
            TRANSPORT_ROAD_CLASS.collector,
            TRANSPORT_ROAD_CLASS.local,
          ]
        : [
            TRANSPORT_ROAD_CLASS.arterial,
            TRANSPORT_ROAD_CLASS.collector,
            TRANSPORT_ROAD_CLASS.local,
          ]
      : [preferredRoadClass]

    // Mountain settlements can lack a legal arterial corridor. Deterministically
    // retry using the less restrictive road classes instead of dropping the edge
    // (and later stripping the settlement as a disconnected component).
    for (const candidateClass of routeClasses) {
      const candidate = routeRoad(descriptor, kind, transport, start, goal, false, elevation, biome, candidateClass)
      if (!candidate) continue
      const bridgeTiles = candidate.reduce(
        (count, point) => count + (kind[point.y * descriptor.width + point.x] === TERRAIN_KIND.lake ? 1 : 0),
        0,
      )
      if (bridgeTiles <= maxBridgeTiles) {
        route = candidate
        roadClass = candidateClass
        break
      }
      bridgeFallback ??= { route: candidate, roadClass: candidateClass }
      const dryCandidate = routeRoad(descriptor, kind, transport, start, goal, true, elevation, biome, candidateClass)
      if (dryCandidate) {
        route = dryCandidate
        roadClass = candidateClass
        break
      }
    }
    if (!route && bridgeFallback) ({ route, roadClass } = bridgeFallback)
    if (!route) continue
    for (let index = 0; index < route.length; index++) {
      const point = route[index]!
      markRoad(transport, point.y * descriptor.width + point.x, roadClass, TRANSPORT_FLAGS.regional, kind)
      if (index > 0) connectRoadPoints(descriptor, transport, route[index - 1]!, point)
    }
  }
}

function v5GatewayToward(
  descriptor: HierarchicalWorldDescriptor,
  city: V3Settlement,
  other: V3Settlement,
): RoutePoint {
  const dx = other.cx - city.cx
  const dy = other.cy - city.cy
  const length = Math.hypot(dx, dy) || 1
  const distance = Math.max(2, Math.round(city.radius * (city.tier === 'metro' ? 1.15 : 0.82)))
  return {
    x: clamp(Math.round(city.cx + dx / length * distance), 1, descriptor.width - 2),
    y: clamp(Math.round(city.cy + dy / length * distance), 1, descriptor.height - 2),
  }
}

function paintV5Route(
  descriptor: HierarchicalWorldDescriptor,
  kind: Uint8Array,
  transport: Uint16Array,
  elevation: Int16Array,
  biome: Uint8Array,
  start: RoutePoint,
  goal: RoutePoint,
  preferredClass: TransportRoadClass,
  flags: number,
): boolean {
  const classes: readonly TransportRoadClass[] = preferredClass === TRANSPORT_ROAD_CLASS.highway
    ? [TRANSPORT_ROAD_CLASS.highway, TRANSPORT_ROAD_CLASS.arterial, TRANSPORT_ROAD_CLASS.collector]
    : [TRANSPORT_ROAD_CLASS.arterial, TRANSPORT_ROAD_CLASS.collector, TRANSPORT_ROAD_CLASS.local]
  let route: RoutePoint[] | undefined
  let selectedClass = preferredClass
  for (const candidateClass of classes) {
    route = routeRoad(descriptor, kind, transport, start, goal, false, elevation, biome, candidateClass)
    if (route) { selectedClass = candidateClass; break }
  }
  if (!route) return false
  for (let index = 0; index < route.length; index++) {
    const point = route[index]!
    markRoad(transport, point.y * descriptor.width + point.x, selectedClass, flags, kind)
    if (index > 0) connectRoadPoints(descriptor, transport, route[index - 1]!, point)
  }
  return true
}

/** V5 terminates highways at metro perimeter gateways and uses arterial approaches. */
function paintV5RegionalRoads(
  descriptor: HierarchicalWorldDescriptor,
  cities: readonly V3Settlement[],
  kind: Uint8Array,
  transport: Uint16Array,
  elevation: Int16Array,
  biome: Uint8Array,
): void {
  const edges = settlementRoadEdges(cities)
  const selected = new Set(edges.map((edge) => `${Math.min(edge.from, edge.to)}:${Math.max(edge.from, edge.to)}`))
  const metros = cities.filter((city) => city.tier === 'metro').sort((a, b) => a.index - b.index)
  for (let index = 1; index < metros.length; index++) {
    const to = metros[index]!
    const from = metros.slice(0, index).sort((a, b) =>
      Math.hypot(a.cx - to.cx, a.cy - to.cy) - Math.hypot(b.cx - to.cx, b.cy - to.cy) || a.index - b.index)[0]!
    const key = `${Math.min(from.index, to.index)}:${Math.max(from.index, to.index)}`
    if (!selected.has(key)) { selected.add(key); edges.push({ from: from.index, to: to.index, loop: false }) }
  }
  for (const edge of edges) {
    const from = cities[edge.from]!
    const to = cities[edge.to]!
    const metroHighway = from.tier === 'metro' && to.tier === 'metro' && !edge.loop
    const fromGateway = v5GatewayToward(descriptor, from, to)
    const toGateway = v5GatewayToward(descriptor, to, from)

    // Paint the inter-city corridor first. If an urban approach cannot be
    // routed, the perimeter gateway remains a deliberate terminal rather than
    // leaving an orphan approach stub pointing at a corridor that never formed.
    const corridorPainted = paintV5Route(descriptor, kind, transport, elevation, biome,
      fromGateway, toGateway,
      metroHighway ? TRANSPORT_ROAD_CLASS.highway : TRANSPORT_ROAD_CLASS.arterial,
      TRANSPORT_FLAGS.regional)
    if (!corridorPainted) continue
    // Gateway approaches are always urban arterials. Highway paint begins at
    // the perimeter and therefore cannot widen a settlement's local grid.
    paintV5Route(descriptor, kind, transport, elevation, biome,
      { x: from.cx, y: from.cy }, fromGateway, TRANSPORT_ROAD_CLASS.arterial,
      TRANSPORT_FLAGS.regional | TRANSPORT_FLAGS.settlement)
    paintV5Route(descriptor, kind, transport, elevation, biome,
      { x: to.cx, y: to.cy }, toGateway, TRANSPORT_ROAD_CLASS.arterial,
      TRANSPORT_FLAGS.regional | TRANSPORT_FLAGS.settlement)
  }
  // Reused low-cost urban streets can tempt A* to cut a highway through a
  // settlement. Preserve the route but deterministically taper those cells to
  // arterial class; the highway resumes outside the perimeter gateway.
  for (const city of cities) {
    const radius = Math.max(1, city.radius * 0.9)
    for (let y = Math.max(0, Math.floor(city.cy - radius)); y <= Math.min(descriptor.height - 1, Math.ceil(city.cy + radius)); y++) {
      for (let x = Math.max(0, Math.floor(city.cx - radius)); x <= Math.min(descriptor.width - 1, Math.ceil(city.cx + radius)); x++) {
        if (Math.hypot(x - city.cx, y - city.cy) > radius) continue
        const id = y * descriptor.width + x
        if (transportClass(transport[id]!) !== TRANSPORT_ROAD_CLASS.highway) continue
        transport[id] = (transport[id]! & ~TRANSPORT_CLASS_MASK) |
          (TRANSPORT_ROAD_CLASS.arterial << TRANSPORT_CLASS_SHIFT)
      }
    }
  }
}

function municipalPlantKind(city: StaticCity, seed: number): MunicipalPowerPlantKind {
  const roll = coordinateHash(city.index, Math.round(city.population), seed ^ 0x50a7) % 100
  if (city.tier === 'metro') return roll < 28 ? 'nuclear' : roll < 61 ? 'coal' : roll < 82 ? 'wind' : 'solar'
  if (city.tier === 'satellite') return roll < 10 ? 'nuclear' : roll < 43 ? 'coal' : roll < 75 ? 'wind' : 'solar'
  return roll < 38 ? 'coal' : roll < 70 ? 'wind' : 'solar'
}

function municipalCapacityMw(city: StaticCity, kind: MunicipalPowerPlantKind): number {
  const tierDemand = city.tier === 'metro' ? 220 : city.tier === 'satellite' ? 105 : city.tier === 'town' ? 52 : 24
  const demand = Math.max(tierDemand, city.population / 1_500, city.powerBuyMw * 24)
  const factor = kind === 'nuclear' ? 2.4 : kind === 'coal' ? 1.55 : kind === 'wind' ? 1.05 : 0.78
  return Math.max(10, Math.round(demand * factor / 10) * 10)
}

function plantFootprintIds(descriptor: WorldDescriptorV5, cx: number, cy: number): TileId[] {
  return [
    tileId(cx, cy, descriptor.width), tileId(cx + 1, cy, descriptor.width),
    tileId(cx, cy + 1, descriptor.width), tileId(cx + 1, cy + 1, descriptor.width),
  ]
}

function footprintBuildable(
  descriptor: WorldDescriptorV5,
  kind: Uint8Array,
  feature: Uint16Array,
  transport: Uint16Array,
  elevation: Int16Array,
  cx: number,
  cy: number,
): boolean {
  if (cx < 1 || cy < 1 || cx + 2 >= descriptor.width || cy + 2 >= descriptor.height) return false
  let minHeight = Infinity
  let maxHeight = -Infinity
  for (let y = cy; y <= cy + 1; y++) {
    for (let x = cx; x <= cx + 1; x++) {
      const id = y * descriptor.width + x
      if (kind[id] === TERRAIN_KIND.lake || feature[id] !== 0 || transportClass(transport[id]!) !== 0) return false
      if (rawTileSlope(descriptor, elevation, x, y) > 0.12) return false
      const height = tileElevationSum(elevation, descriptor.width, x, y) * descriptor.elevationScale / 4
      minHeight = Math.min(minHeight, height)
      maxHeight = Math.max(maxHeight, height)
    }
  }
  return maxHeight - minHeight <= 0.18
}

/**
 * V5's low-density transition is generated separately from the frozen city
 * stamp. Short radial streets remain attached to the existing grid and homes
 * only occupy their shoulders, avoiding isolated loops and tangled layouts.
 */
function addV5SuburbsAndMunicipalPower(
  descriptor: WorldDescriptorV5,
  cities: readonly StaticCity[],
  kind: Uint8Array,
  feature: Uint16Array,
  transport: Uint16Array,
  elevation: Int16Array,
  biome: Uint8Array,
  district: Uint8Array,
): MunicipalPowerPlant[] {
  const plants: MunicipalPowerPlant[] = []
  for (const city of cities) {
    const inner = Math.max(3, Math.ceil(city.radius * 0.72))
    const outer = Math.max(inner + 2, Math.ceil(city.radius * 1.42))
    const roadLength = Math.max(2, outer - inner)
    const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const
    for (let directionIndex = 0; directionIndex < directions.length; directionIndex++) {
      if (coordinateHash(city.index, directionIndex, descriptor.seed ^ 0x71d3) % 5 === 0) continue
      const [dx, dy] = directions[directionIndex]!
      let previous: RoutePoint | undefined
      for (let step = 0; step <= roadLength; step++) {
        const distance = inner + step
        const x = city.cx + dx * distance
        const y = city.cy + dy * distance
        if (x <= 0 || y <= 0 || x + 1 >= descriptor.width || y + 1 >= descriptor.height) break
        const id = y * descriptor.width + x
        if (kind[id] === TERRAIN_KIND.lake || rawTileSlope(descriptor, elevation, x, y) > 0.18) break
        markRoad(transport, id, TRANSPORT_ROAD_CLASS.local, TRANSPORT_FLAGS.settlement, kind)
        if (previous) connectRoadPoints(descriptor, transport, previous, { x, y })
        previous = { x, y }
        for (const side of [-1, 1] as const) {
          const hx = x + (dy !== 0 ? side : 0)
          const hy = y + (dx !== 0 ? side : 0)
          const houseId = hy * descriptor.width + hx
          if (kind[houseId] === TERRAIN_KIND.lake || feature[houseId] !== 0 || transport[houseId] !== 0) continue
          if (rawTileSlope(descriptor, elevation, hx, hy) > 0.14) continue
          if (coordinateHash(hx, hy, descriptor.seed ^ (city.index * 0x193 + 0x921d)) % 100 >= 68) continue
          kind[houseId] = TERRAIN_KIND.house
          feature[houseId] = city.index + 1
          district[houseId] = 1
        }
      }
    }

    // Reclassify the inherited V3 stamp into concentric V5 land-use bands.
    // The transition is intentionally mixed rather than a hard visual seam;
    // coarse park noise makes occasional neighborhood-sized green pockets.
    const featureId = encodeCityFeature(city.index)
    const extent = Math.ceil(city.radius * 1.9)
    const coreEdge = city.tier === 'metro' ? 0.44
      : city.tier === 'satellite' ? 0.4
        : city.tier === 'town' ? 0.52 : 0.58
    const suburbEdge = city.tier === 'village' ? 0.68 : 0.76
    const outerEdge = city.tier === 'village' ? 1.12 : 1.24
    for (let y = Math.max(1, city.cy - extent); y <= Math.min(descriptor.height - 2, city.cy + extent); y++) {
      for (let x = Math.max(1, city.cx - extent); x <= Math.min(descriptor.width - 2, city.cx + extent); x++) {
        const id = y * descriptor.width + x
        const distance = settlementDistance(city, x, y)
        if (distance > outerEdge || kind[id] === TERRAIN_KIND.lake) continue
        if (feature[id] !== 0 && feature[id] !== featureId) continue
        if (transportClass(transport[id]!) !== TRANSPORT_ROAD_CLASS.none) continue
        if (!settlementBiomeIsFriendly(biome[id]!) || rawTileSlope(descriptor, elevation, x, y) > 0.16) continue

        if (distance <= coreEdge) {
          kind[id] = TERRAIN_KIND.city
          feature[id] = featureId
          district[id] = 0
          continue
        }

        if (distance <= suburbEdge) {
          const progress = (distance - coreEdge) / Math.max(0.01, suburbEdge - coreEdge)
          const roll = coordinateHash(x, y, descriptor.seed ^ (city.index * 0x10d + 0x4d21)) % 100
          kind[id] = roll < 78 - Math.round(progress * 42) ? TERRAIN_KIND.city : TERRAIN_KIND.house
          feature[id] = featureId
          district[id] = 0
          continue
        }

        // Detached homes stay within two tiles of a street. This preserves a
        // legible ring without filling inaccessible terrain between spokes.
        let roadDistance = 3
        for (let oy = -2; oy <= 2; oy++) {
          for (let ox = -2; ox <= 2; ox++) {
            if (Math.abs(ox) + Math.abs(oy) > 2) continue
            const neighbor = (y + oy) * descriptor.width + x + ox
            if (transportClass(transport[neighbor]!) !== TRANSPORT_ROAD_CLASS.none) {
              roadDistance = Math.min(roadDistance, Math.abs(ox) + Math.abs(oy))
            }
          }
        }
        if (roadDistance > 2) continue
        const parkPatch = coordinateHash(x >> 2, y >> 2, descriptor.seed ^ (city.index * 0x271 + 0x70b1)) % 100 < 11
        const parkDetail = coordinateHash(x, y, descriptor.seed ^ 0x39ad) % 100 < 72
        kind[id] = parkPatch && parkDetail ? TERRAIN_KIND.park : TERRAIN_KIND.house
        feature[id] = featureId
        district[id] = 1
      }
    }

    // Small warehouse clusters occupy serviced edge land. Candidate tiles
    // must border a collector-or-better route, remain outside the core, and
    // pass the same biome/slope constraints as homes.
    const industrialCandidates: { id: number; score: number }[] = []
    for (let y = Math.max(1, city.cy - extent); y <= Math.min(descriptor.height - 2, city.cy + extent); y++) {
      for (let x = Math.max(1, city.cx - extent); x <= Math.min(descriptor.width - 2, city.cx + extent); x++) {
        const id = y * descriptor.width + x
        const distance = settlementDistance(city, x, y)
        if (distance < 0.84 || distance > 1.42 || kind[id] === TERRAIN_KIND.lake) continue
        if (transportClass(transport[id]!) !== TRANSPORT_ROAD_CLASS.none) continue
        if (!settlementBiomeIsFriendly(biome[id]!) || rawTileSlope(descriptor, elevation, x, y) > 0.14) continue
        const serviced = [id - descriptor.width, id + 1, id + descriptor.width, id - 1].some((neighbor) => {
          const roadClass = transportClass(transport[neighbor]!)
          return roadClass >= TRANSPORT_ROAD_CLASS.collector ||
            (transport[neighbor]! & TRANSPORT_FLAGS.regional) !== 0
        })
        if (!serviced) continue
        industrialCandidates.push({
          id,
          score: Math.round(distance * 4096) +
            (coordinateHash(x, y, descriptor.seed ^ (city.index * 0x521 + 0x1d35)) & 0xfff),
        })
      }
    }
    industrialCandidates.sort((a, b) => a.score - b.score || a.id - b.id)
    const industrialTarget = city.tier === 'metro' ? 6 : city.tier === 'satellite' ? 4 : 3
    let industrialCount = 0
    const industrialAnchor = industrialCandidates[0]
    if (industrialAnchor) {
      const anchorX = industrialAnchor.id % descriptor.width
      const anchorY = Math.floor(industrialAnchor.id / descriptor.width)
      industrialCandidates.sort((a, b) => {
        const ax = a.id % descriptor.width
        const ay = Math.floor(a.id / descriptor.width)
        const bx = b.id % descriptor.width
        const by = Math.floor(b.id / descriptor.width)
        const aDistance = Math.abs(ax - anchorX) + Math.abs(ay - anchorY)
        const bDistance = Math.abs(bx - anchorX) + Math.abs(by - anchorY)
        return aDistance - bDistance || a.score - b.score || a.id - b.id
      })
      for (const candidate of industrialCandidates) {
        if (industrialCount >= industrialTarget) break
        const x = candidate.id % descriptor.width
        const y = Math.floor(candidate.id / descriptor.width)
        if (Math.abs(x - anchorX) + Math.abs(y - anchorY) > industrialTarget + 1) break
        kind[candidate.id] = TERRAIN_KIND.warehouse
        feature[candidate.id] = featureId
        district[candidate.id] = 0
        industrialCount++
      }
    }

    const searchRadius = Math.max(outer + 3, Math.ceil(city.radius * 1.8))
    const candidates: { x: number; y: number; score: number }[] = []
    for (let radius = outer + 2; radius <= searchRadius + 8; radius++) {
      for (let sample = 0; sample < 32; sample++) {
        const angleIndex = (sample + coordinateHash(city.index, radius, descriptor.seed ^ 0x6a09)) & 31
        const angle = angleIndex * Math.PI / 16
        const x = Math.round(city.cx + Math.cos(angle) * radius)
        const y = Math.round(city.cy + Math.sin(angle) * radius)
        if (!footprintBuildable(descriptor, kind, feature, transport, elevation, x, y)) continue
        const score = radius * 1024 + (coordinateHash(x, y, descriptor.seed ^ city.index) & 1023)
        candidates.push({ x, y, score })
      }
      if (candidates.length > 0) break
    }
    candidates.sort((a, b) => a.score - b.score || a.y - b.y || a.x - b.x)
    const site = candidates[0]
    if (!site) continue
    const plantKind = municipalPlantKind(city, descriptor.seed)
    const footprint = plantFootprintIds(descriptor, site.x, site.y)
    for (const id of footprint) {
      district[id] = 2
      // The industrial surface is deliberate; the renderer suppresses its
      // ordinary warehouse prop and owns one campus model at the centroid.
      kind[id] = TERRAIN_KIND.warehouse
    }
    const towardX = Math.sign(city.cx - site.x)
    const towardY = Math.sign(city.cy - site.y)
    const horizontalApproach = Math.abs(city.cx - site.x) >= Math.abs(city.cy - site.y)
    const spurStart = horizontalApproach
      ? {
          x: clamp(site.x + (towardX >= 0 ? 2 : -1), 0, descriptor.width - 1),
          y: clamp(site.y + (towardY > 0 ? 1 : 0), 0, descriptor.height - 1),
        }
      : {
          x: clamp(site.x + (towardX > 0 ? 1 : 0), 0, descriptor.width - 1),
          y: clamp(site.y + (towardY >= 0 ? 2 : -1), 0, descriptor.height - 1),
        }
    paintV5Route(descriptor, kind, transport, elevation, biome, spurStart,
      { x: city.cx, y: city.cy },
      city.tier === 'metro' ? TRANSPORT_ROAD_CLASS.arterial : TRANSPORT_ROAD_CLASS.collector,
      TRANSPORT_FLAGS.regional)
    plants.push(Object.freeze({
      index: plants.length,
      id: `municipal-power-${city.id}`,
      cityIndex: city.index,
      kind: plantKind,
      cx: site.x,
      cy: site.y,
      footprint: Object.freeze(footprint),
      capacityMw: municipalCapacityMw(city, plantKind),
      animationPhase: (coordinateHash(site.x, site.y, descriptor.seed ^ 0x8f31) & 0xffff) / 0xffff,
    }))
  }
  return plants
}

const V6_DISTRICT_SUBURB = DISTRICT_KIND.suburb
const V6_DISTRICT_UTILITY = DISTRICT_KIND.municipalCampus
const V6_DISTRICT_CORE = DISTRICT_KIND.core
const V6_DISTRICT_MIXED = DISTRICT_KIND.mixed
const V6_DISTRICT_GREEN_BUFFER = DISTRICT_KIND.greenBuffer

function v6Footprint(
  descriptor: WorldDescriptorV6,
  x: number,
  y: number,
  width: number,
  height: number,
): TileId[] {
  const result: TileId[] = []
  for (let oy = 0; oy < height; oy++) {
    for (let ox = 0; ox < width; ox++) result.push(tileId(x + ox, y + oy, descriptor.width))
  }
  return result
}

function v6CampusBuildable(
  descriptor: WorldDescriptorV6,
  kind: Uint8Array,
  feature: Uint16Array,
  transport: Uint16Array,
  elevation: Int16Array,
  reserved: ReadonlySet<number>,
  x: number,
  y: number,
  footprintWidth: number,
  footprintHeight: number,
): boolean {
  if (x < 1 || y < 1 || x + footprintWidth >= descriptor.width - 1 || y + footprintHeight >= descriptor.height - 1) return false
  let minHeight = Infinity
  let maxHeight = -Infinity
  for (let oy = 0; oy < footprintHeight; oy++) {
    for (let ox = 0; ox < footprintWidth; ox++) {
      const px = x + ox
      const py = y + oy
      const id = py * descriptor.width + px
      if (reserved.has(id) || kind[id] === TERRAIN_KIND.lake || feature[id] !== 0 ||
          transportClass(transport[id]!) !== TRANSPORT_ROAD_CLASS.none) return false
      if (rawTileSlope(descriptor, elevation, px, py) > 0.12 - 1e-9) return false
      const height = tileElevationSum(elevation, descriptor.width, px, py) * descriptor.elevationScale / 4
      minHeight = Math.min(minHeight, height)
      maxHeight = Math.max(maxHeight, height)
    }
  }
  if (maxHeight - minHeight > 0.18) return false
  // A campus is valid only when at least one perimeter tile has cardinal road access.
  for (let oy = 0; oy < footprintHeight; oy++) {
    for (let ox = 0; ox < footprintWidth; ox++) {
      if (ox > 0 && ox + 1 < footprintWidth && oy > 0 && oy + 1 < footprintHeight) continue
      const px = x + ox
      const py = y + oy
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
        const neighbor = (py + dy) * descriptor.width + px + dx
        if (transportClass(transport[neighbor] ?? 0) !== TRANSPORT_ROAD_CLASS.none) return true
      }
    }
  }
  return false
}

/**
 * Replace the inherited rectangular settlement grid with a sparse street tree.
 * V3/V4/V5 keep their frozen grid, while V6 settlements grow asymmetric
 * collector spines and short local side streets around the regional route.
 * Candidate tiles may only touch their parent road cardinally, preventing the
 * accidental 2x2 ladders and closed square blocks produced by adjacency-based
 * topology finalisation.
 */
function rebuildV6OrganicSettlementRoads(
  descriptor: WorldDescriptorV6,
  cities: readonly StaticCity[],
  kind: Uint8Array,
  feature: Uint16Array,
  transport: Uint16Array,
  elevation: Int16Array,
): void {
  const { width, height } = descriptor
  const cardinal = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const
  const road = (id: number) => transportClass(transport[id] ?? 0) !== TRANSPORT_ROAD_CLASS.none

  const clearRoadTile = (id: number): void => {
    const x = id % width
    const y = Math.floor(id / width)
    for (let direction = 0; direction < ROUTE_STEPS.length; direction++) {
      if ((transport[id]! & (1 << direction)) === 0) continue
      const [dx, dy] = ROUTE_STEPS[direction]!
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      transport[ny * width + nx] &= ~(1 << ((direction + 4) & 7))
    }
    transport[id] = 0
  }

  // Regional A* routes are authoritative. Everything inherited solely from
  // the old settlement grid is cleared before the new street fabric is grown.
  for (let id = 0; id < transport.length; id++) {
    if ((transport[id]! & TRANSPORT_FLAGS.settlement) === 0 ||
        (transport[id]! & TRANSPORT_FLAGS.regional) !== 0) continue
    clearRoadTile(id)
    if (kind[id] !== TERRAIN_KIND.lake) kind[id] = TERRAIN_KIND.empty
    feature[id] = 0
  }

  const canPlace = (x: number, y: number, parentId: number): boolean => {
    if (x <= 0 || y <= 0 || x >= width - 1 || y >= height - 1) return false
    const id = y * width + x
    if (road(id) || kind[id] === TERRAIN_KIND.lake || rawTileSlope(descriptor, elevation, x, y) > 0.18) return false
    for (const [dx, dy] of cardinal) {
      const neighbor = (y + dy) * width + x + dx
      if (neighbor !== parentId && road(neighbor)) return false
    }
    return true
  }

  for (const city of cities) {
    const centerId = city.cy * width + city.cx
    markRoad(transport, centerId, TRANSPORT_ROAD_CLASS.collector,
      TRANSPORT_FLAGS.settlement, kind)
    const cityRoads: number[] = [centerId]

    const growStreet = (
      anchorId: number,
      initialDirection: number,
      length: number,
      collectorSteps: number,
      salt: number,
    ): number[] => {
      const created: number[] = []
      let currentId = anchorId
      let direction = initialDirection & 3
      let segmentRemaining = 2 + coordinateHash(city.index, salt, descriptor.seed ^ 0x2f31) % 4
      for (let step = 0; step < length; step++) {
        const x = currentId % width
        const y = Math.floor(currentId / width)
        if (segmentRemaining-- <= 0) {
          const turn = coordinateHash(x, y, descriptor.seed ^ (city.index * 0x191 + salt + step)) % 5
          if (turn === 0) direction = (direction + 3) & 3
          else if (turn === 1) direction = (direction + 1) & 3
          segmentRemaining = 2 + coordinateHash(y, x, descriptor.seed ^ salt) % 5
        }

        const choices = [direction, (direction + 3) & 3, (direction + 1) & 3]
        let selected: { id: number; direction: number; existing: boolean } | undefined
        let selectedScore = -Infinity
        for (let order = 0; order < choices.length; order++) {
          const candidateDirection = choices[order]!
          const [dx, dy] = cardinal[candidateDirection]!
          const nx = x + dx
          const ny = y + dy
          if (nx <= 0 || ny <= 0 || nx >= width - 1 || ny >= height - 1) continue
          const candidateId = ny * width + nx
          const existing = road(candidateId)
          // Regional approaches often occupy the first tile beside the civic
          // centre. A new spine may follow that authoritative route briefly,
          // then grow away from it; other existing streets remain barriers.
          if (existing
            ? (transport[candidateId]! & TRANSPORT_FLAGS.regional) === 0
            : !canPlace(nx, ny, currentId)) continue
          const outward = Math.hypot(nx - city.cx, ny - city.cy) - Math.hypot(x - city.cx, y - city.cy)
          const jitter = (coordinateHash(nx, ny, descriptor.seed ^ (salt + step * 17)) & 31) / 128
          // Honour the current segment direction whenever it is buildable;
          // alternate directions are escape hatches for terrain and nearby
          // streets, not a reason to straighten every planned bend.
          const score = outward * 2.5 + jitter - order * 10
          if (score > selectedScore) {
            selected = { id: candidateId, direction: candidateDirection, existing }
            selectedScore = score
          }
        }
        if (!selected) break
        const nextX = selected.id % width
        const nextY = Math.floor(selected.id / width)
        if (!selected.existing) {
          markRoad(
            transport,
            selected.id,
            step < collectorSteps ? TRANSPORT_ROAD_CLASS.collector : TRANSPORT_ROAD_CLASS.local,
            TRANSPORT_FLAGS.settlement,
            kind,
          )
        }
        connectRoadPoints(descriptor, transport, { x, y }, { x: nextX, y: nextY })
        if (!selected.existing) {
          created.push(selected.id)
          cityRoads.push(selected.id)
        }
        currentId = selected.id
        direction = selected.direction
      }
      return created
    }

    // Three unequal centre spines create a recognisable town centre without
    // imposing the same four-way cross on every settlement.
    const orientation = coordinateHash(city.cx, city.cy, descriptor.seed ^ 0x73a9) & 3
    const omitted = coordinateHash(city.index, city.radius, descriptor.seed ^ 0x19d7) & 3
    const trunkDirections = [0, 1, 2, 3]
      .map((direction) => (direction + orientation) & 3)
      .filter((direction) => direction !== omitted)
    const trunkLength = Math.max(5, Math.round(city.radius * 1.25))
    const branchAnchors: number[] = []
    for (let trunk = 0; trunk < trunkDirections.length; trunk++) {
      const variance = coordinateHash(city.index, trunk, descriptor.seed ^ 0x51b3) % Math.max(2, Math.round(city.radius * 0.35))
      const created = growStreet(
        centerId,
        trunkDirections[trunk]!,
        trunkLength - Math.floor(city.radius * 0.12) + variance,
        Math.max(2, Math.round(city.radius * 0.42)),
        0x100 + trunk * 29,
      )
      for (let index = 3; index + 2 < created.length; index += 4 + (trunk & 1)) {
        branchAnchors.push(created[index]!)
      }
    }

    // Side streets are deliberately short, staggered and one-sided. They
    // create suburban fingers and cul-de-sacs instead of closing into blocks.
    const branchTarget = city.tier === 'metro' ? 11 : city.tier === 'satellite' ? 8 : city.tier === 'town' ? 6 : 4
    for (let branch = 0; branch < Math.min(branchTarget, branchAnchors.length); branch++) {
      const anchorId = branchAnchors[(branch * 3 + city.index) % branchAnchors.length]!
      const anchorX = anchorId % width
      const anchorY = Math.floor(anchorId / width)
      const awayX = anchorX - city.cx
      const awayY = anchorY - city.cy
      const dominantDirection = Math.abs(awayX) >= Math.abs(awayY)
        ? (awayX >= 0 ? 1 : 3)
        : (awayY >= 0 ? 2 : 0)
      const side = coordinateHash(anchorX, anchorY, descriptor.seed ^ (branch * 0x101 + city.index)) & 1
      const direction = (dominantDirection + (side === 0 ? 1 : 3)) & 3
      const length = Math.max(2, Math.round(city.radius * 0.22)) +
        coordinateHash(branch, city.index, descriptor.seed ^ 0x42d1) % Math.max(2, Math.round(city.radius * 0.28))
      growStreet(anchorId, direction, length, 0, 0x500 + branch * 37)
    }

    // A regional approach can occasionally occupy every immediate exit from
    // a compact satellite centre. Find a nearby road shoulder and seed one
    // proper local street so that the settlement never collapses to a bare
    // through-road.
    if (cityRoads.length === 1) {
      const searchRadius = Math.max(3, Math.round(city.radius * 0.5))
      outer: for (let radius = 1; radius <= searchRadius; radius++) {
        for (let oy = -radius; oy <= radius; oy++) {
          for (let ox = -radius; ox <= radius; ox++) {
            if (Math.max(Math.abs(ox), Math.abs(oy)) !== radius) continue
            const x = city.cx + ox
            const y = city.cy + oy
            if (x <= 0 || y <= 0 || x >= width - 1 || y >= height - 1) continue
            const anchorId = y * width + x
            if (!road(anchorId)) continue
            for (let direction = 0; direction < cardinal.length; direction++) {
              const [dx, dy] = cardinal[direction]!
              if (!canPlace(x + dx, y + dy, anchorId)) continue
              growStreet(anchorId, direction, Math.max(5, Math.round(city.radius * 0.55)), 0,
                0x780 + radius * 17 + direction)
              break outer
            }
          }
        }
      }
    }

    // A displaced fourth approach branches from an inner collector. This
    // improves access while keeping the civic centre a T-junction or bend.
    if (city.tier !== 'village' && cityRoads.length > 5) {
      const anchorId = cityRoads[Math.min(cityRoads.length - 1, 3 + (city.index % 3))]!
      growStreet(anchorId, omitted, Math.max(3, Math.round(city.radius * 0.48)), 2, 0x900 + city.index)
    }
  }
}

/** V6 compiles roads first, then assigns explicit concentric land-use zones. */
function addV6ZoningAndMunicipalPower(
  descriptor: WorldDescriptorV6,
  cities: readonly StaticCity[],
  kind: Uint8Array,
  feature: Uint16Array,
  transport: Uint16Array,
  elevation: Int16Array,
  biome: Uint8Array,
  district: Uint8Array,
): MunicipalPowerPlant[] {
  // Remove the inherited V3 land-use stamp while retaining its road skeleton.
  // This makes the following pass genuinely transport-first without changing
  // any of the compatibility generator functions.
  for (let id = 0; id < kind.length; id++) {
    if (cityIndexFromFeature(feature[id]!) === undefined) continue
    if (transportClass(transport[id]!) !== TRANSPORT_ROAD_CLASS.none) continue
    if (kind[id] !== TERRAIN_KIND.lake) kind[id] = TERRAIN_KIND.empty
    feature[id] = 0
  }

  if (descriptor.settlementAlgorithmVersion >= 5) {
    rebuildV6OrganicSettlementRoads(descriptor, cities, kind, feature, transport, elevation)
  }

  // Extend four legible local streets through the buffer and outer suburb.
  if (descriptor.settlementAlgorithmVersion < 5) for (const city of cities) {
    const start = Math.max(2, Math.ceil(city.radius * 0.68))
    const end = Math.max(start + 3, Math.ceil(city.radius * 1.38))
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      let previous: RoutePoint | undefined
      for (let distance = start; distance <= end; distance++) {
        const x = city.cx + dx * distance
        const y = city.cy + dy * distance
        if (x <= 0 || y <= 0 || x >= descriptor.width - 1 || y >= descriptor.height - 1) break
        const id = y * descriptor.width + x
        if (kind[id] === TERRAIN_KIND.lake || rawTileSlope(descriptor, elevation, x, y) > 0.18) break
        markRoad(transport, id, TRANSPORT_ROAD_CLASS.local, TRANSPORT_FLAGS.settlement, kind)
        if (previous) connectRoadPoints(descriptor, transport, previous, { x, y })
        previous = { x, y }
      }
    }

    // Tangential streets turn the four radial approaches into a connected
    // outer-neighborhood fabric. Each branch starts on a radial, so even a
    // slope-truncated branch cannot become an isolated road component.
    const branchRadius = Math.max(start + 1, Math.round(city.radius * 1.08))
    const branchLength = Math.max(2, Math.round(city.radius * 0.5))
    for (const [radialX, radialY] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      const anchor = { x: city.cx + radialX * branchRadius, y: city.cy + radialY * branchRadius }
      if (anchor.x <= 0 || anchor.y <= 0 || anchor.x >= descriptor.width - 1 || anchor.y >= descriptor.height - 1) continue
      for (const side of [-1, 1] as const) {
        let previous = anchor
        for (let step = 1; step <= branchLength; step++) {
          const x = anchor.x + -radialY * side * step
          const y = anchor.y + radialX * side * step
          if (x <= 0 || y <= 0 || x >= descriptor.width - 1 || y >= descriptor.height - 1) break
          const id = y * descriptor.width + x
          if (kind[id] === TERRAIN_KIND.lake || rawTileSlope(descriptor, elevation, x, y) > 0.18) break
          // The anchor is the only road this branch may reuse. Stop before a
          // pre-existing radial/grid street so the branch cannot close a loop
          // or stamp a second road through an occupied corridor.
          if (descriptor.settlementAlgorithmVersion >= 3 &&
              transportClass(transport[id]!) !== TRANSPORT_ROAD_CLASS.none) break
          markRoad(transport, id, TRANSPORT_ROAD_CLASS.local, TRANSPORT_FLAGS.settlement, kind)
          connectRoadPoints(descriptor, transport, previous, { x, y })
          previous = { x, y }
        }
      }
    }
  }

  // V6.5 makes the spaced street graph authoritative before any land use or
  // utility campus chooses road access. Removed road tiles can then be zoned
  // normally, and no later dependency forces a parallel pair to survive.
  if (descriptor.settlementAlgorithmVersion >= 5) {
    finalizeTransportTopology(descriptor, transport, { x: cities[0]!.cx, y: cities[0]!.cy }, elevation)
    pruneSmallLocalRoadLoops(descriptor, transport, 8, new Set(), true)
    pruneAdjacentParallelLocalRoads(descriptor, transport, new Set())
  }

  const plants: MunicipalPowerPlant[] = []
  const reserved = new Set<number>()
  for (const city of cities) {
    const plantKind = municipalPlantKind(city, descriptor.seed)
    const orientationQuarterTurns = (coordinateHash(city.index, city.cx + city.cy, descriptor.seed ^ 0x6ca1) & 3) as 0 | 1 | 2 | 3
    // Solar selects one of five compact array templates. Conventional plants keep the
    // established 2x2 footprint, while sharing the authoritative layout schema.
    const solar = plantKind === 'solar'
    const solarTemplates = [[2, 3], [2, 4], [3, 3], [2, 5], [3, 4]] as const
    const template = solarTemplates[coordinateHash(city.cx, city.cy, descriptor.seed ^ 0x501a) % solarTemplates.length]!
    let footprintWidth = solar ? (orientationQuarterTurns % 2 === 0 ? template[0] : template[1]) : 2
    let footprintHeight = solar ? (orientationQuarterTurns % 2 === 0 ? template[1] : template[0]) : 2
    const minRadius = Math.max(4, Math.ceil(city.radius * 1.42))
    const maxRadius = Math.max(minRadius + 12, Math.ceil(city.radius * 2.25))
    const findCandidates = (candidateWidth: number, candidateHeight: number) => {
      const candidates: { x: number; y: number; score: number }[] = []
      const minX = Math.max(1, city.cx - maxRadius)
      const maxX = Math.min(descriptor.width - candidateWidth - 2, city.cx + maxRadius)
      const minY = Math.max(1, city.cy - maxRadius)
      const maxY = Math.min(descriptor.height - candidateHeight - 2, city.cy + maxRadius)
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const centerX = x + (candidateWidth - 1) / 2
          const centerY = y + (candidateHeight - 1) / 2
          const distance = Math.hypot(centerX - city.cx, centerY - city.cy)
          if (distance < minRadius || distance > maxRadius) continue
          if (!v6CampusBuildable(descriptor, kind, feature, transport, elevation, reserved,
            x, y, candidateWidth, candidateHeight)) continue
          candidates.push({
            x,
            y,
            score: Math.round(distance * 4096) +
              (coordinateHash(x, y, descriptor.seed ^ (city.index * 0x41f + 0xa271)) & 0xfff),
          })
        }
      }
      candidates.sort((a, b) => a.score - b.score || a.y - b.y || a.x - b.x)
      return candidates
    }
    let candidates = findCandidates(footprintWidth, footprintHeight)
    if (solar && candidates.length === 0 && footprintWidth * footprintHeight > 6) {
      footprintWidth = orientationQuarterTurns % 2 === 0 ? 2 : 3
      footprintHeight = orientationQuarterTurns % 2 === 0 ? 3 : 2
      candidates = findCandidates(footprintWidth, footprintHeight)
    }
    const site = candidates[0]
    if (!site) continue
    const footprint = v6Footprint(descriptor, site.x, site.y, footprintWidth, footprintHeight)
    for (const id of footprint) {
      reserved.add(id)
      district[id] = V6_DISTRICT_UTILITY
      kind[id] = TERRAIN_KIND.warehouse
      feature[id] = 0
    }
    const equipmentTileId = footprint[orientationQuarterTurns % footprint.length]!
    const panelTileIds = solar ? footprint.filter((id) => id !== equipmentTileId) : []
    const layout: MunicipalPowerCampusLayout = Object.freeze({
      version: 1,
      orientationQuarterTurns,
      equipmentTileId,
      panelTileIds: Object.freeze(panelTileIds),
    })
    plants.push(Object.freeze({
      index: plants.length,
      id: `municipal-power-${city.id}`,
      cityIndex: city.index,
      kind: plantKind,
      cx: site.x,
      cy: site.y,
      footprint: Object.freeze(footprint),
      layout,
      capacityMw: municipalCapacityMw(city, plantKind),
      animationPhase: (coordinateHash(site.x, site.y, descriptor.seed ^ 0x8f31) & 0xffff) / 0xffff,
    }))
  }

  for (const city of cities) {
    const featureId = encodeCityFeature(city.index)
    const extent = Math.ceil(city.radius * 1.55)
    for (let y = Math.max(1, city.cy - extent); y <= Math.min(descriptor.height - 2, city.cy + extent); y++) {
      for (let x = Math.max(1, city.cx - extent); x <= Math.min(descriptor.width - 2, city.cx + extent); x++) {
        const id = y * descriptor.width + x
        if (district[id] === V6_DISTRICT_UTILITY || kind[id] === TERRAIN_KIND.lake ||
            transportClass(transport[id]!) !== TRANSPORT_ROAD_CLASS.none) continue
        if (feature[id] !== 0 && feature[id] !== featureId) continue
        if (!settlementBiomeIsFriendly(biome[id]!) || rawTileSlope(descriptor, elevation, x, y) > 0.16) continue
        const distance = settlementDistance(city, x, y)
        if (distance <= 0.44) {
          district[id] = V6_DISTRICT_CORE
          kind[id] = TERRAIN_KIND.city
        } else if (distance <= 0.72) {
          district[id] = V6_DISTRICT_MIXED
          kind[id] = coordinateHash(x, y, descriptor.seed ^ (city.index * 0x10d + 0x4d21)) % 100 < 86
            ? TERRAIN_KIND.city : TERRAIN_KIND.park
        } else if (distance <= 0.9) {
          district[id] = V6_DISTRICT_GREEN_BUFFER
          kind[id] = TERRAIN_KIND.park
        } else if (distance <= 1.38) {
          let serviced = false
          for (let oy = -2; oy <= 2 && !serviced; oy++) {
            for (let ox = -2; ox <= 2; ox++) {
              if (Math.abs(ox) + Math.abs(oy) > 2) continue
              if (transportClass(transport[(y + oy) * descriptor.width + x + ox] ?? 0) !== TRANSPORT_ROAD_CLASS.none) {
                serviced = true
                break
              }
            }
          }
          if (!serviced) continue
          district[id] = V6_DISTRICT_SUBURB
          kind[id] = TERRAIN_KIND.house
        } else continue
        feature[id] = featureId
      }
    }
  }
  return plants
}

/**
 * Keep the civic centre of every V5 town or larger settlement as a canonical
 * cardinal crossroads. Regional A* routes are allowed to approach diagonally,
 * but retaining that shortcut at the centre turns the intended cross street
 * into a five/six-way junction (and can participate in an X crossing). The
 * four local arms already provide the reciprocal route around each removed
 * diagonal, so this changes junction shape without disconnecting the network.
 */
function establishV5SettlementCrossroads(
  descriptor: HierarchicalWorldDescriptor,
  cities: readonly StaticCity[],
  kind: Uint8Array,
  transport: Uint16Array,
): void {
  const cardinalDirections = [0, 2, 4, 6] as const
  const diagonalDirections = [1, 3, 5, 7] as const
  for (const city of cities) {
    if (city.tier === 'village') continue
    const center = { x: city.cx, y: city.cy }
    const centerId = center.y * descriptor.width + center.x
    markRoad(transport, centerId, TRANSPORT_ROAD_CLASS.collector, TRANSPORT_FLAGS.settlement, kind)
    for (const direction of cardinalDirections) {
      const [dx, dy] = ROUTE_STEPS[direction]!
      const arm = { x: center.x + dx, y: center.y + dy }
      if (arm.x < 0 || arm.y < 0 || arm.x >= descriptor.width || arm.y >= descriptor.height) continue
      markRoad(
        transport,
        arm.y * descriptor.width + arm.x,
        TRANSPORT_ROAD_CLASS.collector,
        TRANSPORT_FLAGS.settlement,
        kind,
      )
      connectRoadPoints(descriptor, transport, center, arm)
    }
    for (const direction of diagonalDirections) {
      const [dx, dy] = ROUTE_STEPS[direction]!
      const nx = center.x + dx
      const ny = center.y + dy
      if (nx < 0 || ny < 0 || nx >= descriptor.width || ny >= descriptor.height) continue
      const neighbor = ny * descriptor.width + nx
      transport[centerId] &= ~(1 << direction)
      transport[neighbor] &= ~(1 << ((direction + 4) & 7))
    }
  }
}

function finalizeTransportTopology(
  descriptor: WorldDescriptor,
  transport: Uint16Array,
  preferredRoot: RoutePoint,
  elevation?: Int16Array,
): void {
  const cardinalDirections = [0, 2, 4, 6] as const
  for (let y = 0; y < descriptor.height; y++) {
    for (let x = 0; x < descriptor.width; x++) {
      const id = y * descriptor.width + x
      if (transportClass(transport[id]!) === 0) continue
      for (const direction of cardinalDirections) {
        const [dx, dy] = ROUTE_STEPS[direction]!
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= descriptor.width || ny >= descriptor.height) continue
        const neighbor = ny * descriptor.width + nx
        if (transportClass(transport[neighbor]!) === 0) continue
        if (elevation && isReliefDescriptor(descriptor)) {
          const height = tileElevationSum(elevation, descriptor.width, x, y) * descriptor.elevationScale / 4
          const neighborHeight = tileElevationSum(elevation, descriptor.width, nx, ny) * descriptor.elevationScale / 4
          const limit = roadGradeLimit(Math.max(transportClass(transport[id]!), transportClass(transport[neighbor]!)))
          if (Math.abs(neighborHeight - height) > limit + 1e-9) continue
        }
        // V5 routes write their own edges. Only the generated settlement grid
        // needs adjacency-derived topology; auto-joining nearby regional roads
        // creates parallel-road rungs and abrupt accidental intersections.
        const inferAdjacency = descriptor.generatorVersion < WORLD_GENERATOR_VERSION_V5 ||
          ((transport[id]! & TRANSPORT_FLAGS.settlement) !== 0 &&
            (transport[neighbor]! & TRANSPORT_FLAGS.settlement) !== 0)
        if (inferAdjacency) {
          transport[id] |= 1 << direction
          transport[neighbor] |= 1 << ((direction + 4) & 7)
        }
      }
    }
  }
  const rootId = preferredRoot.y * descriptor.width + preferredRoot.x
  let root = transportClass(transport[rootId]!) > 0 ? rootId : -1
  if (root < 0) {
    for (let id = 0; id < transport.length; id++) {
      if ((transport[id]! & TRANSPORT_FLAGS.regional) !== 0) {
        root = id
        break
      }
    }
  }

  const connected = new Uint8Array(transport.length)
  if (root >= 0) {
    const queue = new Int32Array(transport.length)
    let read = 0
    let write = 0
    connected[root] = 1
    queue[write++] = root
    while (read < write) {
      const id = queue[read++]!
      const x = id % descriptor.width
      const y = Math.floor(id / descriptor.width)
      const topology = transport[id]! & 0xff
      for (let direction = 0; direction < ROUTE_STEPS.length; direction++) {
        if ((topology & (1 << direction)) === 0) continue
        const [dx, dy] = ROUTE_STEPS[direction]!
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= descriptor.width || ny >= descriptor.height) continue
        const neighbor = ny * descriptor.width + nx
        if (connected[neighbor] || transportClass(transport[neighbor]!) === 0) continue
        if ((transport[neighbor]! & (1 << ((direction + 4) & 7))) === 0) continue
        connected[neighbor] = 1
        queue[write++] = neighbor
      }
    }
  }

  // Keep exactly the regional component and strip any stale edge bits.
  for (let id = 0; id < transport.length; id++) {
    if (!connected[id]) {
      transport[id] = 0
      continue
    }
    const x = id % descriptor.width
    const y = Math.floor(id / descriptor.width)
    let topology = transport[id]! & 0xff
    for (let direction = 0; direction < ROUTE_STEPS.length; direction++) {
      if ((topology & (1 << direction)) === 0) continue
      const [dx, dy] = ROUTE_STEPS[direction]!
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= descriptor.width || ny >= descriptor.height) {
        topology &= ~(1 << direction)
        continue
      }
      const neighbor = ny * descriptor.width + nx
      let invalidGrade = false
      if (elevation && isReliefDescriptor(descriptor)) {
        const height = tileElevationSum(elevation, descriptor.width, x, y) * descriptor.elevationScale / 4
        const neighborHeight = tileElevationSum(elevation, descriptor.width, nx, ny) * descriptor.elevationScale / 4
        const limit = roadGradeLimit(Math.max(transportClass(transport[id]!), transportClass(transport[neighbor]!)))
        invalidGrade = Math.abs(neighborHeight - height) / Math.hypot(dx, dy) > limit + 1e-9
      }
      if (!connected[neighbor] || invalidGrade || (transport[neighbor]! & (1 << ((direction + 4) & 7))) === 0) {
        topology &= ~(1 << direction)
      }
    }
    transport[id] = (transport[id]! & ~0xff) | topology
  }
}

function collectV3StarterPads(
  descriptor: WorldDescriptor,
  city: StaticCity,
  kind: Uint8Array,
  transport: Uint16Array,
  elevation?: Int16Array,
): TileId[] {
  const pads: TileId[] = []
  const extent = Math.ceil(city.radius * 1.7)
  for (let radius = extent; radius <= extent + 18 && pads.length < 12; radius++) {
    for (let offset = -radius; offset <= radius && pads.length < 12; offset++) {
      for (const [x, y] of [[city.cx + offset, city.cy - radius], [city.cx + offset, city.cy + radius], [city.cx - radius, city.cy + offset], [city.cx + radius, city.cy + offset]] as const) {
        if (x <= 0 || y <= 0 || x + 1 >= descriptor.width || y + 1 >= descriptor.height) continue
        const id = y * descriptor.width + x
        if (kind[id] !== TERRAIN_KIND.empty && kind[id] !== TERRAIN_KIND.forest) continue
        if (elevation && !terrainDiskIsBuildable(descriptor, elevation, x + 1, y + 1, 2, 0.08)) continue
        if ([id - descriptor.width, id + 1, id + descriptor.width, id - 1].some((neighbor) => transportClass(transport[neighbor]!) > 0)) {
          if (!pads.includes(id as TileId)) pads.push(id as TileId)
        }
      }
    }
  }
  return pads
}

/**
 * Version 3 keeps v2's compact terrain layers and adds an independent packed
 * transport layer. `cityCount` remains the number of metro/region anchors.
 */
export function generateStaticWorldV3(options: WorldGenerationOptions): StaticWorld {
  const descriptor = createWorldDescriptorV3(options)
  const size = descriptor.width * descriptor.height
  const kind = new Uint8Array(size)
  const region = new Uint8Array(size)
  const feature = new Uint16Array(size)
  const variantMask = new Uint8Array(size)
  const transport = new Uint16Array(size)
  const rng = createRandom(descriptor.seed + 9001)

  const lakes = paintLakes(descriptor, kind, feature, rng)
  const metroBase = placeCities(descriptor, kind, rng)
  const cities = deriveV3Settlements(descriptor, metroBase, kind, rng)
  stampV3Settlements(descriptor, cities, kind, feature, transport)
  paintV3RegionalRoads(descriptor, cities, kind, transport)
  finalizeTransportTopology(descriptor, transport, { x: cities[0]!.cx, y: cities[0]!.cy })
  const starterPads = collectV3StarterPads(descriptor, cities[0]!, kind, transport)
  addRuralTerrain(descriptor, kind, feature)
  const regions = assignRegions(descriptor, cities.slice(0, descriptor.cityCount), region)
  buildVariantMasks(descriptor, kind, variantMask)

  let water = 0
  let urban = 0
  let forest = 0
  for (let id = 0; id < size; id++) {
    if (kind[id] === TERRAIN_KIND.lake) water++
    if (cityIndexFromFeature(feature[id]!) !== undefined) urban++
    if (kind[id] === TERRAIN_KIND.forest) forest++
  }
  return {
    descriptor,
    kind,
    region,
    feature,
    variantMask,
    transport,
    cities: Object.freeze(cities),
    regions: Object.freeze(regions),
    lakes: Object.freeze(lakes),
    starterPads: Object.freeze(starterPads),
    staticHash: staticWorldV3Hash(descriptor, [kind, region, feature, variantMask, transport], cities),
    coverage: Object.freeze({ water: water / size, urban: urban / size, forest: forest / size }),
  }
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value)
}

/** Deterministic bilinear value noise. Inputs and output are platform-stable after quantization. */
function valueNoise(x: number, y: number, cellSize: number, seed: number): number {
  const gx = Math.floor(x / cellSize)
  const gy = Math.floor(y / cellSize)
  const tx = smoothstep((x - gx * cellSize) / cellSize)
  const ty = smoothstep((y - gy * cellSize) / cellSize)
  const sample = (sx: number, sy: number) =>
    (coordinateHash(sx, sy, seed) / 0xffff_ffff) * 2 - 1
  const north = sample(gx, gy) * (1 - tx) + sample(gx + 1, gy) * tx
  const south = sample(gx, gy + 1) * (1 - tx) + sample(gx + 1, gy + 1) * tx
  return north * (1 - ty) + south * ty
}

function perlinFade(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10)
}

function perlinGradient(hash: number, x: number, y: number): number {
  const diagonal = Math.SQRT1_2
  switch (hash & 7) {
    case 0: return x
    case 1: return -x
    case 2: return y
    case 3: return -y
    case 4: return (x + y) * diagonal
    case 5: return (x - y) * diagonal
    case 6: return (-x + y) * diagonal
    default: return (-x - y) * diagonal
  }
}

/** Deterministic 2D gradient noise with a quintic fade and continuous derivatives. */
function perlinNoise(x: number, y: number, cellSize: number, seed: number): number {
  const sampleX = x / cellSize
  const sampleY = y / cellSize
  const gridX = Math.floor(sampleX)
  const gridY = Math.floor(sampleY)
  const localX = sampleX - gridX
  const localY = sampleY - gridY
  const fadeX = perlinFade(localX)
  const fadeY = perlinFade(localY)
  const dot = (offsetX: number, offsetY: number) => perlinGradient(
    coordinateHash(gridX + offsetX, gridY + offsetY, seed),
    localX - offsetX,
    localY - offsetY,
  )
  const north = dot(0, 0) * (1 - fadeX) + dot(1, 0) * fadeX
  const south = dot(0, 1) * (1 - fadeX) + dot(1, 1) * fadeX
  // The theoretical gradient range is narrower than [-1, 1]; this factor
  // restores useful climate contrast before the final defensive clamp.
  return Math.max(-1, Math.min(1, (north * (1 - fadeY) + south * fadeY) * 1.52))
}

/** Broad domain-warped fBm used only by V5 climate generation. */
function regionalPerlinNoise(x: number, y: number, scale: number, seed: number): number {
  const warpScale = scale * 0.82
  const warpX = perlinNoise(x, y, warpScale, seed ^ 0x4d31) * scale * 0.24
  const warpY = perlinNoise(x, y, warpScale, seed ^ 0x9a67) * scale * 0.24
  const sampleX = x + warpX
  const sampleY = y + warpY
  const broad = perlinNoise(sampleX, sampleY, scale, seed ^ 0x1f27)
  const regional = perlinNoise(sampleX, sampleY, scale * 0.52, seed ^ 0x7351)
  const detail = perlinNoise(sampleX, sampleY, scale * 0.27, seed ^ 0xb529)
  return broad * 0.68 + regional * 0.24 + detail * 0.08
}

interface MountainChain {
  readonly cx: number
  readonly cy: number
  readonly axisX: number
  readonly axisY: number
  readonly halfLength: number
  readonly ridgeWidth: number
  readonly foothillWidth: number
  readonly peakHeight: number
  readonly bendLinear: number
  readonly bendQuadratic: number
  readonly passAlong: number
}

const MOUNTAIN_AXES = [
  [1, 0],
  [Math.SQRT1_2, Math.SQRT1_2],
  [0, 1],
  [-Math.SQRT1_2, Math.SQRT1_2],
] as const

/**
 * Builds a fixed, small set of regional mountain belts. Keeping these parameters
 * outside the corner loop is important on million-tile worlds; generation remains
 * O(tile count) and does not allocate a second full-world working layer.
 */
function mountainChains(descriptor: ReliefWorldDescriptor): readonly MountainChain[] {
  const scale = Math.min(descriptor.width, descriptor.height)
  const count = scale >= 384 ? 3 : scale >= 96 ? 2 : 1
  const compactRangeScale = clamp((scale - 16) / 80, 0, 1)
  const ridgeFloor = 1.4 + compactRangeScale * 2.1
  const foothillFloor = 3.5 + compactRangeScale * 5.5
  const peakScale = 0.55 + compactRangeScale * 0.45
  const chains: MountainChain[] = []
  for (let index = 0; index < count; index++) {
    const seed = descriptor.seed ^ (0x6d2b + index * 0x1937)
    const hashA = coordinateHash(index, descriptor.seed, seed)
    const hashB = coordinateHash(descriptor.seed, index, seed ^ 0x51e7)
    const axis = MOUNTAIN_AXES[(hashA >>> 29) & 3]!
    chains.push({
      cx: descriptor.width * (0.18 + ((hashA & 0xffff) / 0xffff) * 0.64),
      cy: descriptor.height * (0.18 + ((hashB & 0xffff) / 0xffff) * 0.64),
      axisX: axis[0],
      axisY: axis[1],
      halfLength: scale * (0.3 + ((hashA >>> 16 & 0xff) / 255) * 0.16),
      ridgeWidth: Math.max(ridgeFloor, scale * (0.027 + ((hashB >>> 16 & 0xff) / 255) * 0.018)),
      foothillWidth: Math.max(foothillFloor, scale * (0.09 + ((hashA >>> 24 & 0x1f) / 31) * 0.035)),
      peakHeight: (70 + ((hashB >>> 24) & 0x3f)) * peakScale,
      bendLinear: ((hashA >>> 8 & 0xff) / 255 - 0.5) * 1.2,
      bendQuadratic: ((hashB >>> 8 & 0xff) / 255 - 0.5) * 1.4,
      passAlong: ((hashA >>> 3 & 0x1f) / 31 - 0.5) * 0.8,
    })
  }
  return chains
}

function mountainHeight(x: number, y: number, chains: readonly MountainChain[], seed: number): number {
  let result = 0
  for (let index = 0; index < chains.length; index++) {
    const chain = chains[index]!
    const dx = x - chain.cx
    const dy = y - chain.cy
    const along = dx * chain.axisX + dy * chain.axisY
    const normalizedAlong = along / chain.halfLength
    if (Math.abs(normalizedAlong) >= 1) continue
    const across = -dx * chain.axisY + dy * chain.axisX
    // A low-order curve gives each range a coherent, non-mechanical arc without
    // evaluating trigonometry for every terrain corner.
    const bend = chain.ridgeWidth * (
      chain.bendLinear * normalizedAlong +
      chain.bendQuadratic * (normalizedAlong * normalizedAlong - 0.28)
    )
    const distance = Math.abs(across - bend)
    if (distance >= chain.foothillWidth) continue
    const lengthEnvelope = smoothstep(1 - Math.abs(normalizedAlong))
    const foothill = smoothstep(1 - distance / chain.foothillWidth) * lengthEnvelope
    const crest = distance < chain.ridgeWidth
      ? smoothstep(1 - distance / chain.ridgeWidth) * lengthEnvelope
      : 0
    // One broad saddle per range provides a believable low pass for regional roads.
    const passDistance = Math.abs(normalizedAlong - chain.passAlong) / 0.14
    const pass = passDistance < 1 ? 1 - 0.48 * (1 - passDistance) ** 2 : 1
    const roughness = valueNoise(x, y, Math.max(7, chain.ridgeWidth * 1.8), seed ^ (index * 0x2c53 + 0x71f9))
    result += foothill * 25 + crest * chain.peakHeight * pass * (0.9 + roughness * 0.1)
  }
  return result
}

function generateV4Elevation(descriptor: ReliefWorldDescriptor): Int16Array {
  const stride = descriptor.width + 1
  const mountains = mountainChains(descriptor)
  let elevation = new Int16Array(stride * (descriptor.height + 1))
  for (let y = 0; y <= descriptor.height; y++) {
    for (let x = 0; x <= descriptor.width; x++) {
      const scale = Math.max(32, Math.min(descriptor.width, descriptor.height))
      const continental = valueNoise(x, y, Math.max(72, Math.min(192, scale * 0.24)), descriptor.seed ^ 0x4a31)
      const rolling = valueNoise(x, y, Math.max(36, Math.min(84, scale * 0.1)), descriptor.seed ^ 0x1f27)
      const detail = valueNoise(x, y, Math.max(20, Math.min(36, scale * 0.045)), descriptor.seed ^ 0x7319)
      elevation[y * stride + x] = clamp(
        Math.round(20 + continental * 72 + rolling * 25 + detail * 5 +
          mountainHeight(x, y, mountains, descriptor.seed)),
        -120,
        180,
      )
    }
  }

  // Two immutable relaxation passes remove single-corner spikes but retain ridges.
  for (let pass = 0; pass < 2; pass++) {
    const next = elevation.slice()
    for (let y = 1; y < descriptor.height; y++) {
      for (let x = 1; x < descriptor.width; x++) {
        const id = y * stride + x
        next[id] = Math.round(
          elevation[id]! * 0.5 +
          (elevation[id - 1]! + elevation[id + 1]! + elevation[id - stride]! + elevation[id + stride]!) * 0.125,
        )
      }
    }
    elevation = next
  }

  return elevation
}

interface V4Hydrology {
  readonly kind: Uint8Array
  readonly feature: Uint16Array
  readonly lakes: readonly StaticLake[]
}

function tileElevationSum(elevation: Int16Array, width: number, x: number, y: number): number {
  const stride = width + 1
  const nw = y * stride + x
  return elevation[nw]! + elevation[nw + 1]! + elevation[nw + stride]! + elevation[nw + stride + 1]!
}

/** Select the lowest terrain cells with a bounded histogram, then name every connected basin. */
function deriveV4Hydrology(descriptor: ReliefWorldDescriptor, elevation: Int16Array): V4Hydrology {
  const size = descriptor.width * descriptor.height
  const target = clamp(Math.round(size * descriptor.waterCoverage), 1, size - 1)
  const sums = new Int16Array(size)
  let min = Infinity
  let max = -Infinity
  for (let y = 0; y < descriptor.height; y++) {
    for (let x = 0; x < descriptor.width; x++) {
      const id = y * descriptor.width + x
      const sum = tileElevationSum(elevation, descriptor.width, x, y)
      sums[id] = sum
      min = Math.min(min, sum)
      max = Math.max(max, sum)
    }
  }
  const histogram = new Uint32Array(max - min + 1)
  for (const sum of sums) histogram[sum - min]++
  let threshold = min
  let below = 0
  for (let offset = 0; offset < histogram.length; offset++) {
    const count = histogram[offset]!
    if (below + count >= target) {
      threshold = min + offset
      break
    }
    below += count
  }

  const kind = new Uint8Array(size)
  const feature = new Uint16Array(size)
  let tiesNeeded = target - below
  // Coordinate order plus a seed-dependent cyclic offset avoids a directional tie bias.
  const tieStart = coordinateHash(descriptor.width, descriptor.height, descriptor.seed ^ 0x7a19) % size
  for (let offset = 0; offset < size; offset++) {
    const id = (tieStart + offset) % size
    if (sums[id]! < threshold || (sums[id] === threshold && tiesNeeded-- > 0)) kind[id] = TERRAIN_KIND.lake
  }

  // Sea level is pinned at zero. Shift the selected quantile to it, then ensure every
  // water corner is a true basin below the independent water surface.
  const rawSeaLevel = Math.round(descriptor.seaLevel / descriptor.elevationScale)
  const cornerThreshold = Math.round(threshold / 4)
  for (let index = 0; index < elevation.length; index++) elevation[index] = elevation[index]! - cornerThreshold + rawSeaLevel
  const stride = descriptor.width + 1
  for (let y = 0; y < descriptor.height; y++) {
    for (let x = 0; x < descriptor.width; x++) {
      if (kind[y * descriptor.width + x] !== TERRAIN_KIND.lake) continue
      const nw = y * stride + x
      elevation[nw] = Math.min(elevation[nw]!, rawSeaLevel - 2)
      elevation[nw + 1] = Math.min(elevation[nw + 1]!, rawSeaLevel - 2)
      elevation[nw + stride] = Math.min(elevation[nw + stride]!, rawSeaLevel - 2)
      elevation[nw + stride + 1] = Math.min(elevation[nw + stride + 1]!, rawSeaLevel - 2)
    }
  }

  const visited = new Uint8Array(size)
  const queue = new Int32Array(size)
  const lakes: StaticLake[] = []
  for (let start = 0; start < size; start++) {
    if (kind[start] !== TERRAIN_KIND.lake || visited[start]) continue
    const lakeIndex = lakes.length
    if (lakeIndex >= 0x7fff) throw new Error('V4 hydrology produced too many connected lakes')
    let read = 0
    let write = 0
    let minX = descriptor.width
    let minY = descriptor.height
    let maxX = 0
    let maxY = 0
    let sumX = 0
    let sumY = 0
    visited[start] = 1
    queue[write++] = start
    while (read < write) {
      const id = queue[read++]!
      const x = id % descriptor.width
      const y = Math.floor(id / descriptor.width)
      feature[id] = encodeLakeFeature(lakeIndex)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
      sumX += x
      sumY += y
      for (const neighbor of [id - descriptor.width, id + 1, id + descriptor.width, id - 1]) {
        if (neighbor < 0 || neighbor >= size || visited[neighbor] || kind[neighbor] !== TERRAIN_KIND.lake) continue
        const nx = neighbor % descriptor.width
        if (Math.abs(nx - x) > 1) continue
        visited[neighbor] = 1
        queue[write++] = neighbor
      }
    }
    lakes.push(Object.freeze({
      index: lakeIndex,
      id: `lake_${lakeIndex}`,
      name: lakeIndex === 0 ? 'Great Basin' : `Regional Lake ${lakeIndex + 1}`,
      cx: Math.round(sumX / write),
      cy: Math.round(sumY / write),
      radiusX: Math.max(1, Math.ceil((maxX - minX + 1) / 2)),
      radiusY: Math.max(1, Math.ceil((maxY - minY + 1) / 2)),
      tileCount: write,
    }))
  }
  return { kind, feature, lakes: Object.freeze(lakes) }
}

function generateBiomes(
  descriptor: ReliefWorldDescriptor,
  base: Pick<StaticWorld, 'kind'>,
  elevation: Int16Array,
): Uint8Array {
  if (descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V5 ||
      descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V6) {
    return generateV5Biomes(descriptor, base, elevation)
  }
  const biome = new Uint8Array(descriptor.width * descriptor.height)
  const stride = descriptor.width + 1
  for (let y = 0; y < descriptor.height; y++) {
    for (let x = 0; x < descriptor.width; x++) {
      const id = y * descriptor.width + x
      const average = (elevation[y * stride + x]! + elevation[y * stride + x + 1]! +
        elevation[(y + 1) * stride + x]! + elevation[(y + 1) * stride + x + 1]!) / 4
      const lake = base.kind[id] === TERRAIN_KIND.lake
      const coast = lake ||
        (x > 0 && base.kind[id - 1] === TERRAIN_KIND.lake) ||
        (x + 1 < descriptor.width && base.kind[id + 1] === TERRAIN_KIND.lake) ||
        (y > 0 && base.kind[id - descriptor.width] === TERRAIN_KIND.lake) ||
        (y + 1 < descriptor.height && base.kind[id + descriptor.width] === TERRAIN_KIND.lake)
      const moisture = valueNoise(x, y, 86, descriptor.seed ^ 0x26ef)
      const heat = valueNoise(x, y, 140, descriptor.seed ^ 0x62d3)
      let value: BiomeKind = BIOME_KIND.plains
      if (coast) value = BIOME_KIND.coast
      // Elevation catches summit plateaus while slope extends the rocky biome down
      // steep range faces, yielding coherent alpine areas instead of isolated pixels.
      else if (average > 85 || rawTileSlope(descriptor, elevation, x, y) > 0.22) value = BIOME_KIND.alpine
      else if (average < 8 && moisture > 0.1) value = BIOME_KIND.wetland
      else if (base.kind[id] === TERRAIN_KIND.forest || moisture > 0.35) value = BIOME_KIND.forest
      else if (moisture < -0.35 && heat > -0.15) value = BIOME_KIND.arid
      biome[id] = value
    }
  }
  return biome
}

/**
 * V5 climate is deliberately regional: two broad, continuous fields combine
 * with latitude, elevation and shoreline exposure before categorical labels
 * are assigned. A conservative modal cleanup removes one-tile threshold
 * islands without ever interpolating or mutating the resulting gameplay IDs.
 */
function generateV5Biomes(
  descriptor: HierarchicalWorldDescriptor,
  base: Pick<StaticWorld, 'kind'>,
  elevation: Int16Array,
): Uint8Array {
  const { width, height } = descriptor
  const size = width * height
  const stride = width + 1
  const classified = new Uint8Array(size)
  const protectedCoast = new Uint8Array(size)
  // A region spans roughly half the map's shorter axis. Small octaves are
  // deliberately weak, preventing every local noise wiggle from becoming a
  // separate categorical biome island.
  const regionalScale = Math.max(52, Math.min(176, Math.min(width, height) * 0.62))

  for (let y = 0; y < height; y++) {
    const latitude = Math.abs(((y + 0.5) / height) * 2 - 1)
    for (let x = 0; x < width; x++) {
      const id = y * width + x
      const nw = y * stride + x
      const average = (elevation[nw]! + elevation[nw + 1]! +
        elevation[nw + stride]! + elevation[nw + stride + 1]!) * 0.25
      const lake = base.kind[id] === TERRAIN_KIND.lake
      const coast = lake ||
        (x > 0 && base.kind[id - 1] === TERRAIN_KIND.lake) ||
        (x + 1 < width && base.kind[id + 1] === TERRAIN_KIND.lake) ||
        (y > 0 && base.kind[id - width] === TERRAIN_KIND.lake) ||
        (y + 1 < height && base.kind[id + width] === TERRAIN_KIND.lake)
      if (coast) {
        classified[id] = BIOME_KIND.coast
        protectedCoast[id] = 1
        continue
      }

      // Independent warped Perlin fields create broad organic climate fronts.
      // Latitude supplies a stable pole/equator signal and elevation cools
      // mountain shoulders into boreal belts.
      const moisture = regionalPerlinNoise(x, y, regionalScale, descriptor.seed ^ 0x26ef)
      const continentalHeat = regionalPerlinNoise(
        x,
        y,
        regionalScale * 1.28,
        descriptor.seed ^ 0x62d3,
      ) * 0.42
      const heat = 0.54 - latitude * 0.92 + continentalHeat - Math.max(0, average - 20) * 0.005
      const slope = rawTileSlope(descriptor, elevation, x, y)

      let value: BiomeKind = BIOME_KIND.plains
      if (average > 80 || (average > 48 && slope > 0.2)) value = BIOME_KIND.alpine
      else if (average < 10 && moisture > 0.18) value = BIOME_KIND.wetland
      else if (heat < -0.12 && moisture > -0.18) value = BIOME_KIND.boreal
      else if (moisture > 0.32) value = BIOME_KIND.forest
      else if (moisture < -0.31 && heat > 0.02) value = BIOME_KIND.arid
      else if (moisture > 0.08 && heat > -0.2) value = BIOME_KIND.meadow
      else if (moisture < -0.1 && heat > -0.28) value = BIOME_KIND.scrubland
      classified[id] = value
    }
  }

  let current = classified
  for (let pass = 0; pass < 3; pass++) {
    const next = current.slice()
    const counts = new Uint8Array(9)
    for (let y = 1; y + 1 < height; y++) {
      for (let x = 1; x + 1 < width; x++) {
        const id = y * width + x
        if (protectedCoast[id]) continue
        counts.fill(0)
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue
            const neighbor = current[(y + oy) * width + x + ox]!
            if (neighbor !== BIOME_KIND.coast) counts[neighbor]++
          }
        }
        let modal = current[id]!
        let modalCount = counts[modal] ?? 0
        for (let biome = 0; biome < counts.length; biome++) {
          if (counts[biome]! > modalCount) {
            modal = biome
            modalCount = counts[biome]!
          }
        }
        if (modalCount >= 5) next[id] = modal
      }
    }
    current = next
  }
  return current
}

function addV4RuralTerrain(
  descriptor: ReliefWorldDescriptor,
  kind: Uint8Array,
  feature: Uint16Array,
  transport: Uint16Array,
  biome: Uint8Array,
): void {
  const maxWarehouses = Math.max(8, Math.floor((descriptor.width * descriptor.height) / 2_500))
  let warehouses = 0
  for (let y = 1; y + 1 < descriptor.height; y++) {
    for (let x = 1; x + 1 < descriptor.width; x++) {
      const id = y * descriptor.width + x
      if (transportClass(transport[id]!) === 0 || feature[id] !== 0 || warehouses >= maxWarehouses) continue
      if (coordinateHash(x, y, descriptor.seed + 301) % 173 !== 0) continue
      for (const neighbor of [id + 1, id - 1, id + descriptor.width, id - descriptor.width]) {
        if (kind[neighbor] === TERRAIN_KIND.empty) {
          kind[neighbor] = TERRAIN_KIND.warehouse
          warehouses++
          break
        }
      }
    }
  }
  for (let y = 0; y < descriptor.height; y++) {
    for (let x = 0; x < descriptor.width; x++) {
      const id = y * descriptor.width + x
      if (kind[id] !== TERRAIN_KIND.empty) continue
      // V4 is a frozen compatibility generator. V5 road surfaces are an
      // independent overlay, so never seed a grove beneath an occupied road.
      if (descriptor.generatorVersion >= WORLD_GENERATOR_VERSION_V5 &&
          transportClass(transport[id]!) !== TRANSPORT_ROAD_CLASS.none) continue
      const coarse = coordinateHash(x >> 2, y >> 2, descriptor.seed + 911)
      const fine = coordinateHash(x, y, descriptor.seed + 1217)
      const forestChance = biome[id] === BIOME_KIND.forest ? 72
        : biome[id] === BIOME_KIND.boreal ? 62
          : biome[id] === BIOME_KIND.wetland ? 34
            : biome[id] === BIOME_KIND.meadow ? 18 : 12
      if (coarse % 11 < 5 && fine % 100 < forestChance) kind[id] = TERRAIN_KIND.forest
    }
  }
}

/** Keep V5's transport-owned surface clear of every non-water land use. */
function clearV5RoadEnvironment(
  descriptor: HierarchicalWorldDescriptor,
  kind: Uint8Array,
  transport: Uint16Array,
  district: Uint8Array,
  feature?: Uint16Array,
): void {
  for (let id = 0; id < transport.length; id++) {
    if (transportClass(transport[id]!) === TRANSPORT_ROAD_CLASS.none) continue
    if (kind[id] !== TERRAIN_KIND.lake) kind[id] = TERRAIN_KIND.empty
    district[id] = 0
  }
  // Final topology cleanup can discard a steep/dead-end radial after zoning.
  // Do not retain a suburban classification when its street no longer exists.
  for (let id = 0; id < district.length; id++) {
    if (district[id] !== 1) continue
    const x = id % descriptor.width
    const y = Math.floor(id / descriptor.width)
    let serviced = false
    for (let oy = -2; oy <= 2 && !serviced; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        if (Math.abs(ox) + Math.abs(oy) > 2) continue
        const nx = x + ox
        const ny = y + oy
        if (nx < 0 || ny < 0 || nx >= descriptor.width || ny >= descriptor.height) continue
        if (transportClass(transport[ny * descriptor.width + nx]!) !== TRANSPORT_ROAD_CLASS.none) {
          serviced = true
          break
        }
      }
    }
    if (!serviced) {
      district[id] = 0
      if (descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V6) {
        if (kind[id] === TERRAIN_KIND.house) kind[id] = TERRAIN_KIND.empty
        if (feature) feature[id] = 0
      }
    }
  }
}

function hashString(hash: number, value: string): number {
  hash = hashUint32(hash, value.length)
  for (let index = 0; index < value.length; index++) hash = hashNumber(hash, value.charCodeAt(index))
  return hash
}

function hashUint32(hash: number, value: number): number {
  const normalized = value >>> 0
  return hashNumber(hashNumber(hash, normalized & 0xffff), normalized >>> 16)
}

/** Canonical V4 fingerprint: descriptor, all layers, and generated metadata. */
export function staticWorldV4Hash(
  descriptor: ReliefWorldDescriptor,
  layers: readonly ArrayLike<number>[],
  cities: readonly StaticCity[],
  regions: readonly StaticRegion[],
  lakes: readonly StaticLake[],
  starterPads: readonly TileId[],
): string {
  let hash = 0x811c9dc5
  hash = hashNumber(hash, 0x0401)
  for (const value of [
    descriptor.formatVersion, descriptor.generatorVersion, descriptor.seed,
    descriptor.width, descriptor.height, descriptor.chunkSize, descriptor.cityCount,
  ]) hash = hashUint32(hash, value)
  for (const value of [
    descriptor.landValueBase, descriptor.landValueCityPeak, descriptor.energyPricePerMWh,
    descriptor.waterCoverage, descriptor.elevationScale, descriptor.seaLevel,
    descriptor.terrainAlgorithmVersion, descriptor.biomeVersion,
  ]) hash = hashFloat64(hash, value)
  for (const layer of layers) {
    hash = hashUint32(hash, layer.length)
    for (let index = 0; index < layer.length; index++) hash = hashNumber(hash, layer[index]!)
  }
  hash = hashUint32(hash, cities.length)
  for (const city of cities) {
    hash = hashString(hash, city.id)
    hash = hashString(hash, city.name)
    hash = hashString(hash, city.industry)
    hash = hashString(hash, city.tier ?? '')
    for (const value of [city.index, city.cx, city.cy, city.radius, city.population, city.powerRadius,
      city.parentCityIndex ?? -1, city.regionIndex ?? -1, city.palette?.primary ?? -1,
      city.palette?.secondary ?? -1, city.palette?.accent ?? -1]) hash = hashUint32(hash, value)
    for (const value of [city.powerBuyMw, city.powerBuyPriceMult, city.talentWageMult,
      city.growth?.rate ?? 0, city.growth?.directionX ?? 0, city.growth?.directionY ?? 0,
      city.growth?.irregularity ?? 0]) hash = hashFloat64(hash, value)
  }
  hash = hashUint32(hash, regions.length)
  for (const region of regions) {
    hash = hashString(hash, region.id)
    hash = hashString(hash, region.name)
    for (const value of [region.index, region.originX, region.originY, region.width, region.height]) hash = hashUint32(hash, value)
    for (const value of [region.energyPriceMult, region.latencyToMarket, region.regulationRisk]) hash = hashFloat64(hash, value)
  }
  hash = hashUint32(hash, lakes.length)
  for (const lake of lakes) {
    hash = hashString(hash, lake.id)
    hash = hashString(hash, lake.name)
    for (const value of [lake.index, lake.cx, lake.cy, lake.radiusX, lake.radiusY, lake.tileCount]) hash = hashUint32(hash, value)
  }
  hash = hashUint32(hash, starterPads.length)
  for (const pad of starterPads) hash = hashUint32(hash, pad)
  return hash.toString(16).padStart(8, '0')
}

/** Canonical V5 fingerprint, including the persisted transport algorithm. */
export function staticWorldV5Hash(
  descriptor: WorldDescriptorV5,
  layers: readonly ArrayLike<number>[],
  cities: readonly StaticCity[],
  regions: readonly StaticRegion[],
  lakes: readonly StaticLake[],
  starterPads: readonly TileId[],
  municipalPowerPlants: readonly MunicipalPowerPlant[] = [],
): string {
  let hash = 0x811c9dc5
  hash = hashNumber(hash, 0x0501)
  for (const value of [descriptor.formatVersion, descriptor.generatorVersion, descriptor.seed,
    descriptor.width, descriptor.height, descriptor.chunkSize, descriptor.cityCount,
    descriptor.transportAlgorithmVersion]) hash = hashUint32(hash, value)
  for (const value of [descriptor.landValueBase, descriptor.landValueCityPeak,
    descriptor.energyPricePerMWh, descriptor.waterCoverage, descriptor.elevationScale,
    descriptor.seaLevel, descriptor.terrainAlgorithmVersion, descriptor.biomeVersion]) hash = hashFloat64(hash, value)
  for (const layer of layers) {
    hash = hashUint32(hash, layer.length)
    for (let index = 0; index < layer.length; index++) hash = hashNumber(hash, layer[index]!)
  }
  for (const city of cities) {
    hash = hashString(hash, city.id); hash = hashString(hash, city.name); hash = hashString(hash, city.industry); hash = hashString(hash, city.tier ?? '')
    for (const value of [city.index, city.cx, city.cy, city.radius, city.population, city.powerRadius,
      city.parentCityIndex ?? -1, city.regionIndex ?? -1, city.palette?.primary ?? -1,
      city.palette?.secondary ?? -1, city.palette?.accent ?? -1]) hash = hashUint32(hash, value)
  }
  for (const region of regions) { hash = hashString(hash, region.id); hash = hashString(hash, region.name); hash = hashUint32(hash, region.index) }
  for (const lake of lakes) { hash = hashString(hash, lake.id); hash = hashString(hash, lake.name); hash = hashUint32(hash, lake.index); hash = hashUint32(hash, lake.tileCount) }
  for (const pad of starterPads) hash = hashUint32(hash, pad)
  hash = hashUint32(hash, municipalPowerPlants.length)
  for (const plant of municipalPowerPlants) {
    hash = hashString(hash, plant.id)
    hash = hashString(hash, plant.kind)
    for (const value of [plant.index, plant.cityIndex, plant.cx, plant.cy, plant.capacityMw]) hash = hashUint32(hash, value)
    hash = hashFloat64(hash, plant.animationPhase)
    hash = hashUint32(hash, plant.footprint.length)
    for (const id of plant.footprint) hash = hashUint32(hash, id)
  }
  return hash.toString(16).padStart(8, '0')
}

/** Canonical V6 fingerprint, including zoning and authoritative campus layouts. */
export function staticWorldV6Hash(
  descriptor: WorldDescriptorV6,
  layers: readonly ArrayLike<number>[],
  cities: readonly StaticCity[],
  regions: readonly StaticRegion[],
  lakes: readonly StaticLake[],
  starterPads: readonly TileId[],
  municipalPowerPlants: readonly MunicipalPowerPlant[] = [],
): string {
  let hash = 0x811c9dc5
  hash = hashNumber(hash, 0x0601)
  for (const value of [descriptor.formatVersion, descriptor.generatorVersion, descriptor.seed,
    descriptor.width, descriptor.height, descriptor.chunkSize, descriptor.cityCount,
    descriptor.transportAlgorithmVersion, descriptor.settlementAlgorithmVersion,
    descriptor.municipalCampusAlgorithmVersion, descriptor.cityStatsModelVersion]) hash = hashUint32(hash, value)
  for (const value of [descriptor.landValueBase, descriptor.landValueCityPeak,
    descriptor.energyPricePerMWh, descriptor.waterCoverage, descriptor.elevationScale,
    descriptor.seaLevel, descriptor.terrainAlgorithmVersion, descriptor.biomeVersion]) hash = hashFloat64(hash, value)
  for (const layer of layers) {
    hash = hashUint32(hash, layer.length)
    for (let index = 0; index < layer.length; index++) hash = hashNumber(hash, layer[index]!)
  }
  hash = hashUint32(hash, cities.length)
  for (const city of cities) {
    hash = hashString(hash, city.id); hash = hashString(hash, city.name); hash = hashString(hash, city.industry); hash = hashString(hash, city.tier ?? '')
    for (const value of [city.index, city.cx, city.cy, city.radius, city.population, city.powerRadius,
      city.parentCityIndex ?? -1, city.regionIndex ?? -1, city.palette?.primary ?? -1,
      city.palette?.secondary ?? -1, city.palette?.accent ?? -1]) hash = hashUint32(hash, value)
    for (const value of [city.powerBuyMw, city.powerBuyPriceMult, city.talentWageMult,
      city.growth?.rate ?? 0, city.growth?.directionX ?? 0, city.growth?.directionY ?? 0,
      city.growth?.irregularity ?? 0]) hash = hashFloat64(hash, value)
  }
  hash = hashUint32(hash, regions.length)
  for (const region of regions) {
    hash = hashString(hash, region.id); hash = hashString(hash, region.name)
    for (const value of [region.index, region.originX, region.originY, region.width, region.height]) hash = hashUint32(hash, value)
    for (const value of [region.energyPriceMult, region.latencyToMarket, region.regulationRisk]) hash = hashFloat64(hash, value)
  }
  hash = hashUint32(hash, lakes.length)
  for (const lake of lakes) {
    hash = hashString(hash, lake.id); hash = hashString(hash, lake.name)
    for (const value of [lake.index, lake.cx, lake.cy, lake.radiusX, lake.radiusY, lake.tileCount]) hash = hashUint32(hash, value)
  }
  hash = hashUint32(hash, starterPads.length)
  for (const pad of starterPads) hash = hashUint32(hash, pad)
  hash = hashUint32(hash, municipalPowerPlants.length)
  for (const plant of municipalPowerPlants) {
    hash = hashString(hash, plant.id); hash = hashString(hash, plant.kind)
    for (const value of [plant.index, plant.cityIndex, plant.cx, plant.cy, plant.capacityMw]) hash = hashUint32(hash, value)
    hash = hashFloat64(hash, plant.animationPhase)
    hash = hashUint32(hash, plant.footprint.length)
    for (const id of plant.footprint) hash = hashUint32(hash, id)
    hash = hashUint32(hash, plant.layout?.version ?? 0)
    hash = hashUint32(hash, plant.layout?.orientationQuarterTurns ?? 0)
    hash = hashUint32(hash, plant.layout?.equipmentTileId ?? 0xffff_ffff)
    hash = hashUint32(hash, plant.layout?.panelTileIds.length ?? 0)
    for (const id of plant.layout?.panelTileIds ?? []) hash = hashUint32(hash, id)
  }
  return hash.toString(16).padStart(8, '0')
}

function generateStaticWorldV4FromDescriptor(descriptor: WorldDescriptorV4): StaticWorld {
  const elevation = generateV4Elevation(descriptor)
  const hydrology = deriveV4Hydrology(descriptor, elevation)
  const kind = hydrology.kind
  const feature = hydrology.feature
  const size = descriptor.width * descriptor.height
  const region = new Uint8Array(size)
  const variantMask = new Uint8Array(size)
  const transport = new Uint16Array(size)
  const biome = generateBiomes(descriptor, { kind }, elevation)
  const rng = createRandom(descriptor.seed + 9001)

  // V4 is intentionally terrain-first. Every later layer consumes elevation,
  // hydrology, or biome costs rather than being flattened after V3 generation.
  const metroBase = placeCities(descriptor, kind, rng, elevation)
  const cities = deriveV3Settlements(descriptor, metroBase, kind, rng, elevation)
  stampV3Settlements(descriptor, cities, kind, feature, transport)
  paintV3RegionalRoads(descriptor, cities, kind, transport, elevation, biome)
  finalizeTransportTopology(descriptor, transport, { x: cities[0]!.cx, y: cities[0]!.cy }, elevation)
  const starterPads = collectV3StarterPads(descriptor, cities[0]!, kind, transport, elevation)
  addV4RuralTerrain(descriptor, kind, feature, transport, biome)
  const regions = assignRegions(descriptor, cities.slice(0, descriptor.cityCount), region)
  buildVariantMasks(descriptor, kind, variantMask)

  let water = 0
  let urban = 0
  let forest = 0
  for (let id = 0; id < size; id++) {
    if (kind[id] === TERRAIN_KIND.lake) water++
    if (cityIndexFromFeature(feature[id]!) !== undefined) urban++
    if (kind[id] === TERRAIN_KIND.forest) forest++
  }
  const layers = [kind, region, feature, variantMask, transport, elevation, biome]
  return {
    descriptor,
    kind,
    region,
    feature,
    variantMask,
    transport,
    elevation,
    biome,
    cities: Object.freeze(cities),
    regions: Object.freeze(regions),
    lakes: hydrology.lakes,
    starterPads: Object.freeze(starterPads),
    staticHash: staticWorldV4Hash(descriptor, layers, cities, regions, hydrology.lakes, starterPads),
    coverage: Object.freeze({ water: water / size, urban: urban / size, forest: forest / size }),
  }
}

export function generateStaticWorldV4(options: WorldGenerationOptions): StaticWorld {
  return generateStaticWorldV4FromDescriptor(createWorldDescriptorV4(options))
}

function generateStaticWorldV5FromDescriptor(descriptor: WorldDescriptorV5): StaticWorld {
  const elevation = generateV4Elevation(descriptor)
  const hydrology = deriveV4Hydrology(descriptor, elevation)
  const kind = hydrology.kind
  const feature = hydrology.feature
  const size = descriptor.width * descriptor.height
  const region = new Uint8Array(size)
  const variantMask = new Uint8Array(size)
  const transport = new Uint16Array(size)
  const district = new Uint8Array(size)
  const biome = generateBiomes(descriptor, { kind }, elevation)
  const rng = createRandom(descriptor.seed + 9001)
  const metroBase = placeCities(descriptor, kind, rng, elevation, biome)
  const cities = deriveV3Settlements(descriptor, metroBase, kind, rng, elevation, biome)
  stampV3Settlements(descriptor, cities, kind, feature, transport)
  upgradeV5SettlementRoadHierarchy(descriptor, cities, kind, transport)
  paintV5RegionalRoads(descriptor, cities, kind, transport, elevation, biome)
  const municipalPowerPlants = addV5SuburbsAndMunicipalPower(
    descriptor, cities, kind, feature, transport, elevation, biome, district,
  )
  establishV5SettlementCrossroads(descriptor, cities, kind, transport)
  finalizeTransportTopology(descriptor, transport, { x: cities[0]!.cx, y: cities[0]!.cy }, elevation)
  const starterPads = collectV3StarterPads(descriptor, cities[0]!, kind, transport, elevation)
  addV4RuralTerrain(descriptor, kind, feature, transport, biome)
  clearV5RoadEnvironment(descriptor, kind, transport, district)
  const regions = assignRegions(descriptor, cities.slice(0, descriptor.cityCount), region)
  buildVariantMasks(descriptor, kind, variantMask)
  let water = 0
  let urban = 0
  let forest = 0
  for (let id = 0; id < size; id++) {
    if (kind[id] === TERRAIN_KIND.lake) water++
    if (cityIndexFromFeature(feature[id]!) !== undefined) urban++
    if (kind[id] === TERRAIN_KIND.forest) forest++
  }
  const layers = [kind, region, feature, variantMask, transport, elevation, biome, district]
  return {
    descriptor, kind, region, feature, variantMask, transport, elevation, biome, district,
    cities: Object.freeze(cities), regions: Object.freeze(regions), lakes: hydrology.lakes,
    municipalPowerPlants: Object.freeze(municipalPowerPlants),
    starterPads: Object.freeze(starterPads),
    staticHash: staticWorldV5Hash(descriptor, layers, cities, regions, hydrology.lakes, starterPads, municipalPowerPlants),
    coverage: Object.freeze({ water: water / size, urban: urban / size, forest: forest / size }),
  }
}

export function generateStaticWorldV5(options: WorldGenerationOptions): StaticWorld {
  return generateStaticWorldV5FromDescriptor(createWorldDescriptorV5(options))
}

function generateStaticWorldV6FromDescriptor(descriptor: WorldDescriptorV6): StaticWorld {
  const elevation = generateV4Elevation(descriptor)
  const hydrology = deriveV4Hydrology(descriptor, elevation)
  const kind = hydrology.kind
  const feature = hydrology.feature
  const size = descriptor.width * descriptor.height
  const region = new Uint8Array(size)
  const variantMask = new Uint8Array(size)
  const transport = new Uint16Array(size)
  const district = new Uint8Array(size)
  const biome = generateBiomes(descriptor, { kind }, elevation)
  const rng = createRandom(descriptor.seed + 9001)
  const metroBase = placeCities(descriptor, kind, rng, elevation, biome)
  const cities = deriveV3Settlements(descriptor, metroBase, kind, rng, elevation, biome)
  stampV3Settlements(descriptor, cities, kind, feature, transport)
  upgradeV5SettlementRoadHierarchy(descriptor, cities, kind, transport)
  paintV5RegionalRoads(descriptor, cities, kind, transport, elevation, biome)
  const municipalPowerPlants = addV6ZoningAndMunicipalPower(
    descriptor, cities, kind, feature, transport, elevation, biome, district,
  )
  if (descriptor.settlementAlgorithmVersion < 5) {
    establishV5SettlementCrossroads(descriptor, cities, kind, transport)
  }
  finalizeTransportTopology(descriptor, transport, { x: cities[0]!.cx, y: cities[0]!.cy }, elevation)
  if (descriptor.settlementAlgorithmVersion >= 3 && descriptor.settlementAlgorithmVersion < 5) {
    const protectedRoadTiles = new Set<number>()
    for (const plant of municipalPowerPlants) {
      for (const id of plant.footprint) {
        const x = id % descriptor.width
        for (const neighbor of [id - descriptor.width, id + 1, id + descriptor.width, id - 1]) {
          if (neighbor < 0 || neighbor >= transport.length ||
              Math.abs(neighbor % descriptor.width - x) > 1 || transportClass(transport[neighbor]!) === 0) continue
          protectedRoadTiles.add(neighbor)
        }
      }
    }
    pruneSmallLocalRoadLoops(
      descriptor,
      transport,
      8,
      protectedRoadTiles,
      descriptor.settlementAlgorithmVersion >= 4,
    )
  }
  if (descriptor.settlementAlgorithmVersion >= 5) {
    // Final topology may reconnect neighboring settlement tiles after the
    // physical spacing pass. Open only those rebuilt edges: the real tile gaps
    // were already established before zoning and campus placement.
    pruneSmallLocalRoadLoops(descriptor, transport, 8, new Set(), false)
  }
  const starterPads = collectV3StarterPads(descriptor, cities[0]!, kind, transport, elevation)
  addV4RuralTerrain(descriptor, kind, feature, transport, biome)
  clearV5RoadEnvironment(descriptor, kind, transport, district, feature)
  const regions = assignRegions(descriptor, cities.slice(0, descriptor.cityCount), region)
  buildVariantMasks(descriptor, kind, variantMask)
  let water = 0
  let urban = 0
  let forest = 0
  for (let id = 0; id < size; id++) {
    if (kind[id] === TERRAIN_KIND.lake) water++
    if (cityIndexFromFeature(feature[id]!) !== undefined) urban++
    if (kind[id] === TERRAIN_KIND.forest) forest++
  }
  const layers = [kind, region, feature, variantMask, transport, elevation, biome, district]
  return {
    descriptor, kind, region, feature, variantMask, transport, elevation, biome, district,
    cities: Object.freeze(cities), regions: Object.freeze(regions), lakes: hydrology.lakes,
    municipalPowerPlants: Object.freeze(municipalPowerPlants),
    starterPads: Object.freeze(starterPads),
    staticHash: staticWorldV6Hash(descriptor, layers, cities, regions, hydrology.lakes, starterPads, municipalPowerPlants),
    coverage: Object.freeze({ water: water / size, urban: urban / size, forest: forest / size }),
  }
}

export function generateStaticWorldV6(options: WorldGenerationOptions): StaticWorld {
  return generateStaticWorldV6FromDescriptor(createWorldDescriptorV6(options))
}

function descriptorElevationScale(world: StaticWorld): number {
  return isReliefDescriptor(world.descriptor) ? world.descriptor.elevationScale : 0
}

export function getCornerElevation(world: StaticWorld, x: number, y: number): number {
  if (!world.elevation || x < 0 || y < 0 || x > world.descriptor.width || y > world.descriptor.height) return 0
  return world.elevation[y * (world.descriptor.width + 1) + x]! * descriptorElevationScale(world)
}

export function getTileElevation(world: StaticWorld, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= world.descriptor.width || y >= world.descriptor.height) return 0
  return (getCornerElevation(world, x, y) + getCornerElevation(world, x + 1, y) +
    getCornerElevation(world, x, y + 1) + getCornerElevation(world, x + 1, y + 1)) / 4
}

export function getWaterElevation(world: StaticWorld, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= world.descriptor.width || y >= world.descriptor.height) return 0
  if (world.kind[y * world.descriptor.width + x] !== TERRAIN_KIND.lake) return getTileElevation(world, x, y)
  return isReliefDescriptor(world.descriptor) ? world.descriptor.seaLevel : 0
}

/** Maximum edge/diagonal grade as a rise/run ratio for one logical tile. */
export function getTileSlope(world: StaticWorld, x: number, y: number): number {
  const nw = getCornerElevation(world, x, y)
  const ne = getCornerElevation(world, x + 1, y)
  const sw = getCornerElevation(world, x, y + 1)
  const se = getCornerElevation(world, x + 1, y + 1)
  return Math.max(Math.abs(ne - nw), Math.abs(sw - nw), Math.abs(se - ne), Math.abs(se - sw),
    Math.abs(se - nw) / Math.SQRT2, Math.abs(sw - ne) / Math.SQRT2)
}

export function getBiome(world: StaticWorld, x: number, y: number): BiomeKind {
  if (!world.biome || x < 0 || y < 0 || x >= world.descriptor.width || y >= world.descriptor.height) return BIOME_KIND.plains
  return (world.biome[y * world.descriptor.width + x] ?? BIOME_KIND.plains) as BiomeKind
}

/** Regenerate the exact version recorded by a compact-world save descriptor. */
export function regenerateStaticWorld(descriptor: WorldDescriptor): StaticWorld {
  if (descriptor.formatVersion !== WORLD_FORMAT_VERSION) {
    throw new Error('unsupported compact world descriptor version')
  }
  if (descriptor.generatorVersion === WORLD_GENERATOR_VERSION) return generateStaticWorldV2(descriptor)
  if (descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V3) return generateStaticWorldV3(descriptor)
  if (descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V4) return generateStaticWorldV4FromDescriptor(descriptor)
  if (descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V5) return generateStaticWorldV5FromDescriptor(descriptor)
  if (descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V6) return generateStaticWorldV6FromDescriptor(descriptor)
  throw new Error('unsupported compact world descriptor version')
}

export function tileAt(world: StaticWorld, x: number, y: number): TileId {
  return tileId(x, y, world.descriptor.width, world.descriptor.height)
}

import { tileId } from './ids'
import {
  TERRAIN_KIND,
  WORLD_FORMAT_VERSION,
  WORLD_GENERATOR_VERSION,
  type CityIndustry,
  type StaticCity,
  type StaticLake,
  type StaticRegion,
  type StaticWorld,
  type TerrainKind,
  type TileId,
  type WorldDescriptor,
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

export function createWorldDescriptor(options: WorldGenerationOptions): WorldDescriptor {
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

function placeCities(
  descriptor: WorldDescriptor,
  kind: Uint8Array,
  rng: RandomSource,
): StaticCity[] {
  const range = cityRadiusRange(descriptor.width, descriptor.height)
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
      let score = Infinity
      let valid = true
      for (const other of placed) {
        const clearance = Math.hypot(cx - other.cx, cy - other.cy) - radius - other.radius
        score = Math.min(score, clearance)
        if (clearance < Math.max(6, Math.min(descriptor.width, descriptor.height) * 0.012)) {
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

export function staticWorldByteLength(world: StaticWorld): number {
  return world.kind.byteLength + world.region.byteLength + world.feature.byteLength + world.variantMask.byteLength
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

/** Convenience for adapters that already have a descriptor from a v2 save. */
export function regenerateStaticWorld(descriptor: WorldDescriptor): StaticWorld {
  if (descriptor.formatVersion !== WORLD_FORMAT_VERSION || descriptor.generatorVersion !== WORLD_GENERATOR_VERSION) {
    throw new Error('unsupported compact world descriptor version')
  }
  return generateStaticWorldV2(descriptor)
}

export function tileAt(world: StaticWorld, x: number, y: number): TileId {
  return tileId(x, y, world.descriptor.width, world.descriptor.height)
}


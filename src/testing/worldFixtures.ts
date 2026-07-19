/**
 * Compact, deterministic stress worlds used by renderer and simulation tests.
 *
 * These fixtures deliberately do not depend on the production world storage
 * shape.  A renderer can consume the typed layers directly, while simulation
 * tests can materialize only the small bounds they need.
 */

export const FIXTURE_TILE_KIND = {
  empty: 0,
  road: 1,
  city: 2,
  lake: 3,
  forest: 4,
  house: 5,
  park: 6,
  warehouse: 7,
  facility: 8,
} as const

export type FixtureTileKindName = keyof typeof FIXTURE_TILE_KIND
export type FixtureTileKind = (typeof FIXTURE_TILE_KIND)[FixtureTileKindName]

export const FIXTURE_OWNER = {
  neutral: 0,
  player: 1,
  rivalA: 2,
  rivalB: 3,
  rivalC: 4,
} as const

export type FixtureOwner = (typeof FIXTURE_OWNER)[keyof typeof FIXTURE_OWNER]

export type FixtureFacilityKind =
  | 'dc'
  | 'dc_m'
  | 'dc_l'
  | 'substation'
  | 'solar'
  | 'gas'
  | 'nuclear'
  | 'battery'
  | 'hq'
  | 'lab'
  | 'fab'
  | 'cooling'

export interface FixtureFacility {
  id: number
  kind: FixtureFacilityKind
  owner: FixtureOwner
  x: number
  y: number
  width: number
  height: number
  level: number
  racksUsed: number
  rackCapacity: number
  mwGeneration: number
  mwCapacity: number
}

export interface FixtureCity {
  id: number
  x: number
  y: number
  radius: number
  population: number
}

export type FixtureScenario = 'baseline' | 'dense-metro' | 'large-lake' | 'mixed' | 'developed'

export interface FixtureExpectations {
  minCityTiles?: number
  minLakeTiles?: number
  minFacilities?: number
  maxBaseLayerBytes: number
}

export interface WorldFixtureSpec {
  id: FixtureId
  scenario: FixtureScenario
  seed: number
  width: number
  height: number
  expected: FixtureExpectations
  heavy: boolean
}

export interface DeterministicWorldFixture {
  spec: WorldFixtureSpec
  /** Surface/scenery kind for each tile, indexed by y * width + x. */
  kinds: Uint8Array
  /** Stable palette/biome region, intentionally limited to one byte. */
  regions: Uint8Array
  /** Deterministic visual variant, safe to consume as a shader attribute. */
  variants: Uint8Array
  /** Neutral/player/rival ownership, independent of surface kind. */
  owners: Uint8Array
  facilities: FixtureFacility[]
  cities: FixtureCity[]
}

const SPECS = {
  'baseline-64': {
    id: 'baseline-64',
    scenario: 'baseline',
    seed: 6_401,
    width: 64,
    height: 64,
    expected: {
      minCityTiles: 350,
      minLakeTiles: 250,
      minFacilities: 48,
      maxBaseLayerBytes: 64 * 64 * 4,
    },
    heavy: false,
  },
  'dense-metro-256': {
    id: 'dense-metro-256',
    scenario: 'dense-metro',
    seed: 256_11,
    width: 256,
    height: 256,
    expected: {
      minCityTiles: 20_000,
      minFacilities: 2_000,
      maxBaseLayerBytes: 256 * 256 * 4,
    },
    heavy: false,
  },
  'large-lake-256': {
    id: 'large-lake-256',
    scenario: 'large-lake',
    seed: 256_29,
    width: 256,
    height: 256,
    expected: {
      minLakeTiles: 10_000,
      minFacilities: 256,
      maxBaseLayerBytes: 256 * 256 * 4,
    },
    heavy: false,
  },
  'mixed-1000': {
    id: 'mixed-1000',
    scenario: 'mixed',
    seed: 1_000_31,
    width: 1_000,
    height: 1_000,
    expected: {
      minCityTiles: 18_000,
      minLakeTiles: 20_000,
      minFacilities: 2_000,
      maxBaseLayerBytes: 1_000 * 1_000 * 4,
    },
    heavy: true,
  },
  'developed-1000': {
    id: 'developed-1000',
    scenario: 'developed',
    seed: 1_000_73,
    width: 1_000,
    height: 1_000,
    expected: {
      minCityTiles: 18_000,
      minLakeTiles: 20_000,
      minFacilities: 10_000,
      maxBaseLayerBytes: 1_000 * 1_000 * 4,
    },
    heavy: true,
  },
} as const satisfies Record<string, Omit<WorldFixtureSpec, 'id'> & { id: string }>

export type FixtureId = keyof typeof SPECS

export const WORLD_FIXTURE_SPECS: Readonly<Record<FixtureId, WorldFixtureSpec>> = SPECS

export function fixtureIndex(width: number, x: number, y: number): number {
  return y * width + x
}

export function getWorldFixtureSpec(id: FixtureId): WorldFixtureSpec {
  return WORLD_FIXTURE_SPECS[id]
}

function hash32(value: number): number {
  let x = value | 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  return (x ^ (x >>> 16)) >>> 0
}

function hashAt(seed: number, x: number, y: number): number {
  return hash32(seed ^ Math.imul(x + 1, 73_856_093) ^ Math.imul(y + 1, 19_349_663))
}

function createBase(spec: WorldFixtureSpec): DeterministicWorldFixture {
  const size = spec.width * spec.height
  const kinds = new Uint8Array(size)
  const regions = new Uint8Array(size)
  const variants = new Uint8Array(size)
  const owners = new Uint8Array(size)
  for (let y = 0; y < spec.height; y++) {
    for (let x = 0; x < spec.width; x++) {
      const index = fixtureIndex(spec.width, x, y)
      const regionX = Math.min(3, Math.floor((x * 4) / spec.width))
      const regionY = Math.min(3, Math.floor((y * 4) / spec.height))
      regions[index] = regionY * 4 + regionX
      variants[index] = hashAt(spec.seed, x, y) & 15
    }
  }
  return { spec, kinds, regions, variants, owners, facilities: [], cities: [] }
}

function setKind(world: DeterministicWorldFixture, x: number, y: number, kind: FixtureTileKind) {
  if (x < 0 || y < 0 || x >= world.spec.width || y >= world.spec.height) return
  world.kinds[fixtureIndex(world.spec.width, x, y)] = kind
}

function paintEllipse(
  world: DeterministicWorldFixture,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  kind: FixtureTileKind,
) {
  const x0 = Math.max(0, Math.floor(cx - rx))
  const x1 = Math.min(world.spec.width - 1, Math.ceil(cx + rx))
  const y0 = Math.max(0, Math.floor(cy - ry))
  const y1 = Math.min(world.spec.height - 1, Math.ceil(cy + ry))
  const rx2 = rx * rx
  const ry2 = ry * ry
  for (let y = y0; y <= y1; y++) {
    const dy2 = (y - cy) * (y - cy)
    for (let x = x0; x <= x1; x++) {
      const dx2 = (x - cx) * (x - cx)
      if (dx2 / rx2 + dy2 / ry2 <= 1) setKind(world, x, y, kind)
    }
  }
}

function paintRoadGrid(
  world: DeterministicWorldFixture,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  spacing: number,
) {
  for (let x = x0; x <= x1; x += spacing) {
    for (let y = y0; y <= y1; y++) setKind(world, x, y, FIXTURE_TILE_KIND.road)
  }
  for (let y = y0; y <= y1; y += spacing) {
    for (let x = x0; x <= x1; x++) setKind(world, x, y, FIXTURE_TILE_KIND.road)
  }
}

function addCity(
  world: DeterministicWorldFixture,
  id: number,
  x: number,
  y: number,
  radius: number,
) {
  paintEllipse(world, x, y, radius, Math.max(8, Math.round(radius * 0.78)), FIXTURE_TILE_KIND.city)
  paintRoadGrid(world, x - radius, y - radius, x + radius, y + radius, Math.max(4, Math.floor(radius / 8)))
  world.cities.push({
    id,
    x,
    y,
    radius,
    population: Math.round(180_000 + radius * radius * 5_800),
  })
}

const FACILITY_KINDS: readonly FixtureFacilityKind[] = [
  'dc',
  'dc_m',
  'dc_l',
  'substation',
  'solar',
  'gas',
  'battery',
  'hq',
  'lab',
  'fab',
  'cooling',
]

function facilityStats(kind: FixtureFacilityKind, variant: number) {
  if (kind === 'dc' || kind === 'dc_m' || kind === 'dc_l') {
    const capacity = kind === 'dc_l' ? 960 : kind === 'dc_m' ? 288 : 96
    return {
      width: kind === 'dc_l' ? 3 : kind === 'dc_m' ? 2 : 1,
      height: kind === 'dc_l' ? 2 : kind === 'dc_m' ? 2 : 1,
      rackCapacity: capacity,
      racksUsed: Math.floor(capacity * (0.35 + (variant % 50) / 100)),
      mwGeneration: 0,
      mwCapacity: 0,
    }
  }
  if (kind === 'solar') {
    return { width: 1, height: 1, rackCapacity: 0, racksUsed: 0, mwGeneration: 8, mwCapacity: 0 }
  }
  if (kind === 'gas') {
    return { width: 1, height: 1, rackCapacity: 0, racksUsed: 0, mwGeneration: 22, mwCapacity: 0 }
  }
  if (kind === 'nuclear') {
    return { width: 1, height: 1, rackCapacity: 0, racksUsed: 0, mwGeneration: 90, mwCapacity: 0 }
  }
  if (kind === 'substation' || kind === 'battery') {
    return { width: 1, height: 1, rackCapacity: 0, racksUsed: 0, mwGeneration: 0, mwCapacity: 24 }
  }
  return { width: 1, height: 1, rackCapacity: 0, racksUsed: 0, mwGeneration: 0, mwCapacity: 0 }
}

function placeFacilities(world: DeterministicWorldFixture, target: number) {
  const width = world.spec.width
  const height = world.spec.height
  const size = width * height
  const start = hash32(world.spec.seed + target) % size
  const stride = (hash32(world.spec.seed ^ 0xa11ce) | 1) % size || 1
  let cursor = start
  let attempts = 0
  while (world.facilities.length < target && attempts < size * 3) {
    attempts++
    cursor = (cursor + stride) % size
    const x = cursor % width
    const y = Math.floor(cursor / width)
    const currentKind = world.kinds[cursor]
    if (currentKind === FIXTURE_TILE_KIND.lake || currentKind === FIXTURE_TILE_KIND.facility) continue
    const h = hashAt(world.spec.seed + target, x, y)
    const kind = FACILITY_KINDS[h % FACILITY_KINDS.length]!
    const stats = facilityStats(kind, h & 255)
    if (x + stats.width > width || y + stats.height > height) continue
    let clear = true
    for (let dy = 0; dy < stats.height && clear; dy++) {
      for (let dx = 0; dx < stats.width; dx++) {
        const index = fixtureIndex(width, x + dx, y + dy)
        if (
          world.kinds[index] === FIXTURE_TILE_KIND.lake ||
          world.kinds[index] === FIXTURE_TILE_KIND.facility
        ) {
          clear = false
          break
        }
      }
    }
    if (!clear) continue
    const owner = (1 + (h % 4)) as FixtureOwner
    const id = world.facilities.length
    world.facilities.push({ id, kind, owner, x, y, level: 1 + ((h >>> 8) % 3), ...stats })
    for (let dy = 0; dy < stats.height; dy++) {
      for (let dx = 0; dx < stats.width; dx++) {
        const index = fixtureIndex(width, x + dx, y + dy)
        world.kinds[index] = FIXTURE_TILE_KIND.facility
        world.owners[index] = owner
      }
    }
  }
  if (world.facilities.length !== target) {
    throw new Error(`Fixture ${world.spec.id} placed ${world.facilities.length}/${target} facilities`)
  }
}

function buildBaseline(world: DeterministicWorldFixture) {
  addCity(world, 0, 20, 20, 14)
  addCity(world, 1, 47, 43, 11)
  paintEllipse(world, 43, 15, 12, 9, FIXTURE_TILE_KIND.lake)
  paintEllipse(world, 12, 49, 10, 8, FIXTURE_TILE_KIND.forest)
  placeFacilities(world, 64)
}

function buildDenseMetro(world: DeterministicWorldFixture) {
  paintEllipse(world, 128, 128, 108, 92, FIXTURE_TILE_KIND.city)
  paintRoadGrid(world, 18, 25, 238, 231, 6)
  paintEllipse(world, 55, 206, 22, 15, FIXTURE_TILE_KIND.park)
  world.cities.push({ id: 0, x: 128, y: 128, radius: 108, population: 7_800_000 })
  placeFacilities(world, 2_500)
}

function buildLargeLake(world: DeterministicWorldFixture) {
  paintEllipse(world, 126, 126, 82, 58, FIXTURE_TILE_KIND.lake)
  paintEllipse(world, 126, 126, 48, 31, FIXTURE_TILE_KIND.lake)
  addCity(world, 0, 47, 48, 24)
  addCity(world, 1, 209, 202, 22)
  paintEllipse(world, 208, 48, 25, 20, FIXTURE_TILE_KIND.forest)
  placeFacilities(world, 384)
}

function buildMixed(world: DeterministicWorldFixture) {
  paintEllipse(world, 745, 225, 118, 82, FIXTURE_TILE_KIND.lake)
  paintEllipse(world, 810, 690, 74, 112, FIXTURE_TILE_KIND.lake)
  paintEllipse(world, 182, 718, 105, 76, FIXTURE_TILE_KIND.forest)
  paintEllipse(world, 480, 510, 92, 64, FIXTURE_TILE_KIND.forest)
  const cityPoints = [
    [125, 140, 48],
    [360, 185, 56],
    [620, 510, 46],
    [180, 425, 42],
    [390, 815, 52],
    [725, 825, 55],
    [875, 475, 40],
    [530, 305, 44],
  ] as const
  for (let i = 0; i < cityPoints.length; i++) {
    const [x, y, radius] = cityPoints[i]!
    addCity(world, i, x, y, radius)
  }
  paintRoadGrid(world, 40, 40, 960, 960, 80)
}

export function createWorldFixture(id: FixtureId): DeterministicWorldFixture {
  const world = createBase(getWorldFixtureSpec(id))
  switch (world.spec.scenario) {
    case 'baseline':
      buildBaseline(world)
      break
    case 'dense-metro':
      buildDenseMetro(world)
      break
    case 'large-lake':
      buildLargeLake(world)
      break
    case 'mixed':
      buildMixed(world)
      placeFacilities(world, 2_500)
      break
    case 'developed':
      buildMixed(world)
      placeFacilities(world, 10_000)
      break
  }
  return world
}

export function countFixtureKinds(world: DeterministicWorldFixture): Uint32Array {
  const counts = new Uint32Array(Object.keys(FIXTURE_TILE_KIND).length)
  for (let i = 0; i < world.kinds.length; i++) counts[world.kinds[i]!]++
  return counts
}

export function estimateFixtureBaseLayerBytes(world: DeterministicWorldFixture): number {
  return (
    world.kinds.byteLength +
    world.regions.byteLength +
    world.variants.byteLength +
    world.owners.byteLength
  )
}

export function fixtureFingerprint(world: DeterministicWorldFixture): string {
  let hash = 0x811c9dc5
  const update = (value: number) => {
    hash ^= value & 255
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  for (const layer of [world.kinds, world.regions, world.variants, world.owners]) {
    for (let i = 0; i < layer.length; i++) update(layer[i]!)
  }
  update(world.facilities.length)
  for (const facility of world.facilities) {
    update(facility.id)
    update(facility.x)
    update(facility.y)
    update(facility.owner)
    update(facility.level)
  }
  return hash.toString(16).padStart(8, '0')
}

export interface FixtureTileView {
  x: number
  y: number
  kind: FixtureTileKind
  region: number
  variant: number
  owner: FixtureOwner
}

export function fixtureTileAt(
  world: DeterministicWorldFixture,
  x: number,
  y: number,
): FixtureTileView | undefined {
  if (x < 0 || y < 0 || x >= world.spec.width || y >= world.spec.height) return undefined
  const index = fixtureIndex(world.spec.width, x, y)
  return {
    x,
    y,
    kind: world.kinds[index] as FixtureTileKind,
    region: world.regions[index]!,
    variant: world.variants[index]!,
    owner: world.owners[index] as FixtureOwner,
  }
}

export function forEachFixtureTileInBounds(
  world: DeterministicWorldFixture,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  visit: (tile: FixtureTileView) => void,
) {
  const minX = Math.max(0, Math.floor(bounds.minX))
  const minY = Math.max(0, Math.floor(bounds.minY))
  const maxX = Math.min(world.spec.width - 1, Math.ceil(bounds.maxX))
  const maxY = Math.min(world.spec.height - 1, Math.ceil(bounds.maxY))
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const index = fixtureIndex(world.spec.width, x, y)
      visit({
        x,
        y,
        kind: world.kinds[index] as FixtureTileKind,
        region: world.regions[index]!,
        variant: world.variants[index]!,
        owner: world.owners[index] as FixtureOwner,
      })
    }
  }
}

/** Compact, renderer-friendly world model used by save format v2. */

declare const tileIdBrand: unique symbol
declare const chunkIdBrand: unique symbol

export type TileId = number & { readonly [tileIdBrand]: 'TileId' }
export type ChunkId = number & { readonly [chunkIdBrand]: 'ChunkId' }

/** Player and rivals deliberately share the same owner representation and APIs. */
export type WorldOwnerId = 'neutral' | 'player' | (string & {})

export const TERRAIN_KIND = {
  empty: 0,
  road: 1,
  city: 2,
  lake: 3,
  forest: 4,
  house: 5,
  park: 6,
  warehouse: 7,
} as const

export type TerrainKindName = keyof typeof TERRAIN_KIND
export type TerrainKind = (typeof TERRAIN_KIND)[TerrainKindName]

export const TERRAIN_KIND_NAME: readonly TerrainKindName[] = [
  'empty',
  'road',
  'city',
  'lake',
  'forest',
  'house',
  'park',
  'warehouse',
]

/** Clockwise topology bits stored in the low byte of a transport cell. */
export const TRANSPORT_DIRECTION = {
  north: 1 << 0,
  northEast: 1 << 1,
  east: 1 << 2,
  southEast: 1 << 3,
  south: 1 << 4,
  southWest: 1 << 5,
  west: 1 << 6,
  northWest: 1 << 7,
} as const

export const TRANSPORT_TOPOLOGY_MASK = 0x00ff
export const TRANSPORT_CLASS_SHIFT = 8
export const TRANSPORT_CLASS_MASK = 0x0700
export const TRANSPORT_ROAD_CLASS = {
  none: 0,
  local: 1,
  collector: 2,
  arterial: 3,
  highway: 4,
} as const
export type TransportRoadClass = (typeof TRANSPORT_ROAD_CLASS)[keyof typeof TRANSPORT_ROAD_CLASS]
export const TRANSPORT_FLAGS = {
  bridge: 1 << 11,
  settlement: 1 << 12,
  regional: 1 << 13,
} as const

export const WORLD_FORMAT_VERSION = 2 as const
/** The original generator version. Kept as the default for source/save compatibility. */
export const WORLD_GENERATOR_VERSION = 2 as const
export const WORLD_GENERATOR_VERSION_V3 = 3 as const
export const WORLD_GENERATOR_VERSION_V4 = 4 as const
export const WORLD_GENERATOR_VERSION_V5 = 5 as const
export const WORLD_GENERATOR_VERSION_V6 = 6 as const
export type WorldGeneratorVersion =
  | typeof WORLD_GENERATOR_VERSION
  | typeof WORLD_GENERATOR_VERSION_V3
  | typeof WORLD_GENERATOR_VERSION_V4
  | typeof WORLD_GENERATOR_VERSION_V5
  | typeof WORLD_GENERATOR_VERSION_V6

interface WorldDescriptorBase {
  readonly formatVersion: typeof WORLD_FORMAT_VERSION
  readonly seed: number
  readonly width: number
  readonly height: number
  readonly chunkSize: number
  /** Stored explicitly so regenerating a save cannot change when defaults evolve. */
  readonly cityCount: number
  readonly landValueBase: number
  readonly landValueCityPeak: number
  readonly energyPricePerMWh: number
  /** Generator target. The produced coverage is exposed on StaticWorld. */
  readonly waterCoverage: number
}

export interface WorldDescriptorV2 extends WorldDescriptorBase {
  readonly generatorVersion: typeof WORLD_GENERATOR_VERSION
}

export interface WorldDescriptorV3 extends WorldDescriptorBase {
  readonly generatorVersion: typeof WORLD_GENERATOR_VERSION_V3
}

/** All V4 generation constants are persisted so regeneration never follows changed defaults. */
export interface WorldDescriptorV4 extends WorldDescriptorBase {
  readonly generatorVersion: typeof WORLD_GENERATOR_VERSION_V4
  readonly elevationScale: number
  readonly seaLevel: number
  readonly terrainAlgorithmVersion: 1
  readonly biomeVersion: 1
}

/** V5 keeps V4 terrain stable while revising settlement and regional transport hierarchy. */
export interface WorldDescriptorV5 extends WorldDescriptorBase {
  readonly generatorVersion: typeof WORLD_GENERATOR_VERSION_V5
  readonly elevationScale: number
  readonly seaLevel: number
  readonly terrainAlgorithmVersion: 1
  readonly biomeVersion: 1
  readonly transportAlgorithmVersion: 2
}

/** V6 persists every algorithm boundary that can affect regenerated saves. */
export interface WorldDescriptorV6 extends WorldDescriptorBase {
  readonly generatorVersion: typeof WORLD_GENERATOR_VERSION_V6
  readonly elevationScale: number
  readonly seaLevel: number
  readonly terrainAlgorithmVersion: 1
  readonly biomeVersion: 1
  readonly transportAlgorithmVersion: 2
  readonly settlementAlgorithmVersion: 2
  readonly municipalCampusAlgorithmVersion: 2
  readonly cityStatsModelVersion: 1
}

export type WorldDescriptor = WorldDescriptorV2 | WorldDescriptorV3 | WorldDescriptorV4 | WorldDescriptorV5 | WorldDescriptorV6

export const BIOME_KIND = {
  plains: 0,
  forest: 1,
  arid: 2,
  wetland: 3,
  alpine: 4,
  coast: 5,
  meadow: 6,
  boreal: 7,
  scrubland: 8,
} as const
export type BiomeKindName = keyof typeof BIOME_KIND
export type BiomeKind = (typeof BIOME_KIND)[BiomeKindName]
export const BIOME_KIND_NAME: readonly BiomeKindName[] = [
  'plains', 'forest', 'arid', 'wetland', 'alpine', 'coast', 'meadow', 'boreal', 'scrubland',
]

export type CityIndustry = 'tech' | 'industrial' | 'port' | 'finance' | 'mixed'
export type CityTier = 'metro' | 'satellite' | 'town' | 'village'

export interface CityPalette {
  readonly primary: number
  readonly secondary: number
  readonly accent: number
}

export interface CityGrowthMetadata {
  /** Relative long-term population/footprint growth rate. */
  readonly rate: number
  /** Preferred expansion direction, expressed as a unit-ish vector. */
  readonly directionX: number
  readonly directionY: number
  /** Organic edge variation in the range 0..1. */
  readonly irregularity: number
}

export interface StaticCity {
  readonly index: number
  readonly id: string
  readonly name: string
  readonly cx: number
  readonly cy: number
  readonly radius: number
  readonly population: number
  readonly powerRadius: number
  readonly powerBuyMw: number
  readonly powerBuyPriceMult: number
  readonly industry: CityIndustry
  readonly talentWageMult: number
  /** V3 settlement metadata. Omitted by v2 worlds and old fixtures/saves. */
  readonly tier?: CityTier
  readonly parentCityIndex?: number
  readonly regionIndex?: number
  readonly palette?: CityPalette
  readonly growth?: CityGrowthMetadata
}

export interface StaticRegion {
  readonly index: number
  readonly id: string
  readonly name: string
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
  readonly energyPriceMult: number
  readonly latencyToMarket: number
  readonly regulationRisk: number
}

export interface StaticLake {
  readonly index: number
  readonly id: string
  readonly name: string
  readonly cx: number
  readonly cy: number
  readonly radiusX: number
  readonly radiusY: number
  readonly tileCount: number
}

export type MunicipalPowerPlantKind = 'coal' | 'wind' | 'solar' | 'nuclear'

/** Stable district codes shared by generation, rendering, and inspection. */
export const DISTRICT_KIND = {
  none: 0,
  suburb: 1,
  municipalCampus: 2,
  core: 3,
  mixed: 4,
  greenBuffer: 5,
} as const

/** Renderer-independent placement metadata for an authored municipal campus. */
export interface MunicipalPowerCampusLayout {
  readonly version: 1
  readonly orientationQuarterTurns: 0 | 1 | 2 | 3
  readonly equipmentTileId: TileId
  readonly panelTileIds: readonly TileId[]
}

/** Immutable, generator-owned utility campus serving one V5 settlement. */
export interface MunicipalPowerPlant {
  readonly index: number
  readonly id: string
  readonly cityIndex: number
  readonly kind: MunicipalPowerPlantKind
  readonly cx: number
  readonly cy: number
  readonly footprint: readonly TileId[]
  /** Present on V6 campuses; omitted by the frozen V5 generator. */
  readonly layout?: MunicipalPowerCampusLayout
  /** Nameplate output; nuclear > coal > wind > solar for equivalent demand. */
  readonly capacityMw: number
  readonly animationPhase: number
}

/**
 * Five bytes per logical tile. Coordinates are implicit: id = y * width + x.
 * feature uses 0 for none, 1..0x7fff for city index + 1, and bit 15 for lakes.
 * variantMask uses NESW in its low nibble and a deterministic variant in its high nibble.
 */
export interface StaticWorld {
  readonly descriptor: WorldDescriptor
  readonly kind: Uint8Array
  readonly region: Uint8Array
  readonly feature: Uint16Array
  readonly variantMask: Uint8Array
  /** V3 road layer. Low byte is 8-way topology; high byte is class/flags. */
  readonly transport?: Uint16Array
  /** V4 shared-corner height lattice, indexed as y * (width + 1) + x. */
  readonly elevation?: Int16Array
  /** V4 deterministic biome classification, one byte per logical tile. */
  readonly biome?: Uint8Array
  /** District layer: 0 none, 1 suburb, 2 utility, 3 core, 4 mixed, 5 green buffer. */
  readonly district?: Uint8Array
  readonly cities: readonly StaticCity[]
  readonly regions: readonly StaticRegion[]
  readonly lakes: readonly StaticLake[]
  /** V5-only immutable utility metadata. Empty/omitted for compatibility worlds. */
  readonly municipalPowerPlants?: readonly MunicipalPowerPlant[]
  readonly starterPads: readonly TileId[]
  readonly staticHash: string
  readonly coverage: {
    readonly water: number
    readonly urban: number
    readonly forest: number
  }
}

export interface TerrainOverride {
  readonly tileId: TileId
  /** Omitted values inherit the immutable base layer. */
  readonly kind?: TerrainKind
  readonly feature?: number
  readonly variantMask?: number
  readonly transport?: number
  readonly ownerId?: WorldOwnerId
}

export interface FacilityStats {
  readonly rackCapacity?: number
  readonly racksUsed?: number
  readonly mwCapacity?: number
  readonly mwGeneration?: number
  readonly capex?: number
  readonly opexPerDay?: number
}

/** One record per campus; its complete footprint is indexed separately. */
export interface Facility {
  readonly id: string
  readonly kind: string
  readonly ownerId: WorldOwnerId
  readonly anchor: TileId
  readonly footprint: readonly TileId[]
  readonly level: number
  readonly constructionProgress: number
  readonly constructionTarget: number
  readonly powered?: boolean
  readonly forSale?: boolean
  readonly listPrice?: number
  readonly stats?: FacilityStats
  /** Save-safe facility-specific state (rack installs, size class, etc.). */
  readonly data?: Readonly<Record<string, unknown>>
}

export interface CityRuntimeState {
  readonly cityIndex: number
  readonly population: number
  readonly growthEvents: number
  readonly lastGrowthDay: number
}

export interface FacilityAggregate {
  readonly count: number
  readonly occupiedTiles: number
  readonly underConstruction: number
  readonly rackCapacity: number
  readonly racksUsed: number
  readonly mwCapacity: number
  readonly mwGeneration: number
  readonly capex: number
  readonly opexPerDay: number
}

export interface WorldMetrics {
  readonly revision: number
  readonly terrainOverrideCount: number
  readonly facilities: FacilityAggregate
  readonly byOwner: ReadonlyMap<WorldOwnerId, FacilityAggregate>
  readonly byKind: ReadonlyMap<string, FacilityAggregate>
}

export const WORLD_CHANGE_FLAGS = {
  terrain: 1 << 0,
  facility: 1 << 1,
  occupancy: 1 << 2,
  city: 1 << 3,
  metrics: 1 << 4,
} as const

export type WorldChangeFlags = number

export interface WorldChange {
  readonly sequence: number
  readonly revision: number
  readonly flags: WorldChangeFlags
  /** Includes cardinal neighbors whose road/shore mask may have changed. */
  readonly tileIds: readonly TileId[]
  readonly chunkIds: readonly ChunkId[]
  readonly facilityIds: readonly string[]
  readonly cityIndexes: readonly number[]
}

export type WorldChangesSince =
  | {
      readonly kind: 'delta'
      readonly changes: readonly WorldChange[]
      readonly nextSequence: number
    }
  | {
      readonly kind: 'reset'
      readonly reason: 'history-evicted' | 'invalid-sequence'
      readonly nextSequence: number
    }

export interface TileView {
  readonly id: TileId
  readonly x: number
  readonly y: number
  readonly chunkId: ChunkId
  readonly baseKind: TerrainKind
  readonly kind: TerrainKind
  readonly regionIndex: number
  readonly feature: number
  readonly variantMask: number
  readonly transport: number
  readonly ownerId: WorldOwnerId
  readonly facility: Facility | undefined
}

export interface FacilityQuery {
  readonly ownerId?: WorldOwnerId
  readonly kind?: string
  readonly regionIndex?: number
  readonly chunkId?: ChunkId
  readonly underConstruction?: boolean
}

export interface DynamicWorldSnapshotV2 {
  readonly formatVersion: typeof WORLD_FORMAT_VERSION
  readonly descriptor: WorldDescriptor
  readonly staticHash: string
  readonly terrainOverrides: readonly TerrainOverride[]
  readonly facilities: readonly Facility[]
  readonly cities: readonly CityRuntimeState[]
}

export interface WorldBatchCommit {
  readonly committed: boolean
  readonly revision: number
  readonly change?: WorldChange
}

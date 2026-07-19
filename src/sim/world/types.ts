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

export const WORLD_FORMAT_VERSION = 2 as const
export const WORLD_GENERATOR_VERSION = 2 as const

export interface WorldDescriptor {
  readonly formatVersion: typeof WORLD_FORMAT_VERSION
  readonly generatorVersion: typeof WORLD_GENERATOR_VERSION
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

export type CityIndustry = 'tech' | 'industrial' | 'port' | 'finance' | 'mixed'

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
  readonly cities: readonly StaticCity[]
  readonly regions: readonly StaticRegion[]
  readonly lakes: readonly StaticLake[]
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


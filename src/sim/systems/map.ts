import type {
  BuildableKind,
  BuildDef,
  LabId,
  MapCity,
  MapRegion,
  MapTile,
  ScenicKind,
  SimState,
  TileKind,
  TileOwner,
} from '../types'
import type { GameConfig } from '../balance/gameConfig'
import { defaultGameConfig } from '../balance/gameConfig'
import { ECONOMY } from '../balance/economy'
import { getChassis } from '../balance/racks'
import { getRackSku } from '../balance/rackSkus'
import { generateProceduralMap } from './mapGen'
import {
  commitWorldBatch,
  compactCompletedFacilities,
  compactCompletedFacilitiesForOwner,
  compactFacilitiesForOwner,
  compactTileIdAt,
  compactUnderConstructionFacilities,
  facilityAnchorTiles,
  facilityDataPatch,
  mapTileAtAny,
  usesCompactWorld,
} from './worldAccess'
import { tileCoords, tileId } from '../world/ids'
import type { Facility } from '../world/types'
import type { DynamicWorld } from '../world/dynamicWorld'
import {
  WORLD_GENERATOR_VERSION_V4,
  WORLD_GENERATOR_VERSION_V5,
  WORLD_GENERATOR_VERSION_V6,
  WORLD_GENERATOR_VERSION_V7,
} from '../world/types'
import {
  facilityTransportAccess,
  transportLandValueMultiplier,
  transportLogisticsOpexSurcharge,
} from './transport'
import { energyContractCapacityMw } from './energyAccounting'

export const BUILDABLE_KINDS: BuildableKind[] = [
  'dc',
  'dc_m',
  'dc_l',
  'substation',
  'solar',
  'gas',
  'nuclear',
  'fab',
  'cooling',
  'battery',
  'hq',
  'hq_m',
  'hq_l',
  'office', // legacy alias
  'lab',
]

/** Any data-hall kind (small / medium / large). */
export function isDcKind(kind: string): boolean {
  return kind === 'dc' || kind === 'dc_m' || kind === 'dc_l'
}

/** Only the campus anchor holds bay capacity. */
export function isDcAnchor(t: { kind: string; campusRole?: string }): boolean {
  if (!isDcKind(t.kind)) return false
  return t.campusRole !== 'pad'
}

/** Medium and hyperscale campuses double rack PF through denser fabric and cooling. */
export function dataHallComputeMultiplier(t: {
  kind: string
  dcSize?: string
  campusRole?: string
}): number {
  if (!isDcAnchor(t)) return 1
  return t.kind === 'dc_m' || t.kind === 'dc_l' || t.dcSize === 'medium' || t.dcSize === 'large'
    ? 2
    : 1
}

type FacilityEnergyTotals = {
  mwInterconnect: number
  mwGeneration: number
  rackCap: number
  racksUsed: number
}

type CompactFacilityEnergyCache = {
  revision: number
  byLab: Map<LabId, FacilityEnergyTotals>
}

export type GridScarcitySnapshot = {
  industryDcCount: number
  gridCapMw: number
  gridDemandMw: number
  priceMult: number
  softCap: number
}

const compactFacilityEnergyCaches = new WeakMap<DynamicWorld, CompactFacilityEnergyCache>()
const compactGridScarcityCaches = new WeakMap<
  DynamicWorld,
  { revision: number; snapshot: GridScarcitySnapshot }
>()

/** HQ buildings (talent desks). Legacy `office` counts as small HQ. */
export function isHqKind(kind: string): boolean {
  return kind === 'hq' || kind === 'hq_m' || kind === 'hq_l' || kind === 'office'
}

export function isHqAnchor(t: { kind: string; campusRole?: string }): boolean {
  if (!isHqKind(t.kind)) return false
  return t.campusRole !== 'pad'
}

export function dcFootprint(kind: BuildableKind): { dx: number; dy: number }[] {
  const def = BUILD_DEFS.find((b) => b.kind === kind)
  if (def?.footprint?.length) return def.footprint
  return [{ dx: 0, dy: 0 }]
}

export const SCENIC_KINDS: ScenicKind[] = [
  'city',
  'lake',
  'forest',
  'house',
  'road',
  'park',
  'warehouse',
]

export function isScenicKind(kind: TileKind): kind is ScenicKind {
  return (SCENIC_KINDS as string[]).includes(kind)
}

export function isBuildableKind(kind: TileKind): kind is BuildableKind {
  return (BUILDABLE_KINDS as string[]).includes(kind)
}

/** O(1) coordinate lookup for the canonical row-major map representation. */
export function mapTileIndexAt(
  state: Pick<SimState, 'map'>,
  x: number,
  y: number,
): number {
  if (x < 0 || y < 0 || x >= state.map.width || y >= state.map.height) return -1
  const index = y * state.map.width + x
  const tile = state.map.tiles[index]
  // Retain a correctness fallback for older hand-authored/test fixtures.
  if (tile?.x === x && tile.y === y) return index
  return state.map.tiles.findIndex((candidate) => candidate.x === x && candidate.y === y)
}

export function mapTileAt(
  state: Pick<SimState, 'config' | 'map'>,
  x: number,
  y: number,
): MapTile | undefined {
  // `config` is only needed to derive compact empty-land value. SimState callers
  // always provide it; the fallback keeps the narrow historical signature valid.
  return mapTileAtAny(state, x, y)
}

const SCENIC_LABELS: Record<ScenicKind, string> = {
  city: 'Metro demand',
  lake: 'Water',
  forest: 'Forest',
  house: 'Housing',
  road: 'Road',
  park: 'Park',
  warehouse: 'Warehouse',
}

export function scenicLabel(kind: TileKind): string {
  if (isScenicKind(kind)) return SCENIC_LABELS[kind]
  if (kind === 'empty') return 'Open land'
  return kind
}

export const BUILD_DEFS: BuildDef[] = [
  {
    kind: 'dc',
    label: 'DC · Small',
    blurb: '1-tile edge hall · 96 bays. Compact shell — good first site or edge POP.',
    cash: 118_000_000,
    days: 180,
    rack: 96,
    opexPerDay: 125_000,
    upgradeCash: 68_000_000,
    upgradeRack: 48,
    upgradeDays: 90,
    footprint: [{ dx: 0, dy: 0 }],
    dcSize: 'small',
  },
  {
    kind: 'dc_m',
    label: 'DC · Medium',
    blurb: '4-tile campus (2×2) · 288 bays (3× small). Mid-game density without a mega shell.',
    cash: 340_000_000,
    days: 360,
    rack: 288,
    opexPerDay: 340_000,
    upgradeCash: 180_000_000,
    upgradeRack: 96,
    upgradeDays: 150,
    footprint: [
      { dx: 0, dy: 0 },
      { dx: 1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 1, dy: 1 },
    ],
    dcSize: 'medium',
  },
  {
    kind: 'dc_l',
    label: 'DC · Large',
    blurb: '6-tile mega campus (3×2) · 960 bays (10× small). Hyperscale shell — power hungry.',
    cash: 980_000_000,
    days: 720,
    rack: 960,
    opexPerDay: 920_000,
    upgradeCash: 420_000_000,
    upgradeRack: 192,
    upgradeDays: 240,
    footprint: [
      { dx: 0, dy: 0 },
      { dx: 1, dy: 0 },
      { dx: 2, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 1, dy: 1 },
      { dx: 2, dy: 1 },
    ],
    dcSize: 'large',
  },
  {
    kind: 'substation',
    label: 'Grid interconnect',
    blurb: 'Brings multi-megawatt utility power to the campus.',
    cash: 52_000_000,
    days: 9,
    mw: 14,
    opexPerDay: 48_000,
    upgradeCash: 34_000_000,
    upgradeMw: 12,
    upgradeDays: 7,
  },
  {
    kind: 'solar',
    label: 'Solar field',
    blurb: 'Cheap daytime generation. Pair with battery or grid for nights.',
    cash: 55_000_000,
    days: 11,
    gen: 8,
    opexPerDay: 16_000,
    upgradeCash: 42_000_000,
    upgradeDays: 6,
  },
  {
    kind: 'gas',
    label: 'Gas peaker',
    blurb: 'Dispatchable MW. Expensive fuel, reliable baseload bridge.',
    cash: 92_000_000,
    days: 13,
    gen: 24,
    opexPerDay: 78_000,
    upgradeCash: 26_000_000,
    upgradeDays: 8,
  },
  {
    kind: 'nuclear',
    label: 'SMR block',
    blurb: 'Late-game firm power. Billion-class project.',
    cash: 1_350_000_000,
    days: 65,
    gen: 160,
    opexPerDay: 320_000,
  },
  {
    kind: 'fab',
    label: 'Chip fab shell',
    blurb: 'Cleanroom campus for custom silicon. Build the shell early; tape-out requires Accelerator Architecture research.',
    cash: 820_000_000,
    days: 38,
    opexPerDay: 520_000,
  },
  {
    kind: 'cooling',
    label: 'Cooling plant',
    blurb: 'Lowers campus PUE — more usable FLOPS per watt. Stack with Nordic sites.',
    cash: 45_000_000,
    days: 10,
    opexPerDay: 48_000,
    upgradeCash: 16_000_000,
    upgradeDays: 7,
  },
  {
    kind: 'battery',
    label: 'Battery farm',
    blurb: 'Grid storage buffer. Smooths solar and buys peak headroom.',
    cash: 58_000_000,
    days: 11,
    mw: 6,
    opexPerDay: 32_000,
    upgradeCash: 20_000_000,
    upgradeMw: 5,
    upgradeDays: 7,
  },
  {
    kind: 'hq',
    label: 'HQ · Small',
    blurb: '1-tile headquarters · 12 desks. Hire researchers & data staff from the city pool.',
    cash: 42_000_000,
    days: 10,
    opexPerDay: 48_000,
    upgradeCash: 18_000_000,
    upgradeDays: 7,
    staffCap: 12,
    hqSize: 'small',
    footprint: [{ dx: 0, dy: 0 }],
  },
  {
    kind: 'hq_m',
    label: 'HQ · Medium',
    blurb: '4-tile HQ campus · 36 desks. Mid-scale talent footprint near a metro.',
    cash: 125_000_000,
    days: 18,
    opexPerDay: 125_000,
    upgradeCash: 48_000_000,
    upgradeDays: 12,
    staffCap: 36,
    hqSize: 'medium',
    footprint: [
      { dx: 0, dy: 0 },
      { dx: 1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 1, dy: 1 },
    ],
  },
  {
    kind: 'hq_l',
    label: 'HQ · Large',
    blurb: '6-tile HQ · 90 desks. Hyperscale people ops — dominate a city talent market.',
    cash: 320_000_000,
    days: 28,
    opexPerDay: 280_000,
    upgradeCash: 110_000_000,
    upgradeDays: 16,
    staffCap: 90,
    hqSize: 'large',
    footprint: [
      { dx: 0, dy: 0 },
      { dx: 1, dy: 0 },
      { dx: 2, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 1, dy: 1 },
      { dx: 2, dy: 1 },
    ],
  },
  {
    kind: 'lab',
    label: 'Research lab',
    blurb: 'Accelerates research PF throughput (still needs researchers in an HQ).',
    cash: 62_000_000,
    days: 12,
    opexPerDay: 88_000,
    upgradeCash: 22_000_000,
    upgradeDays: 8,
  },
]

/** Tiles that already have something on them (cannot place a new building). */
export const NON_BUILDABLE: TileKind[] = [
  ...SCENIC_KINDS,
  ...BUILDABLE_KINDS,
]

export function getBuildDef(kind: BuildableKind): BuildDef {
  const k = kind === 'office' ? 'hq' : kind
  const d = BUILD_DEFS.find((b) => b.kind === k)
  if (!d) throw new Error(`No build def ${kind}`)
  return d
}

/** @deprecated use BUILD_DEFS */
export const BUILD_COSTS = Object.fromEntries(
  BUILD_DEFS.map((b) => [
    b.kind,
    { cash: b.cash, days: b.days, rack: b.rack, mw: b.mw, gen: b.gen },
  ]),
) as Record<BuildableKind, { cash: number; days: number; rack?: number; mw?: number; gen?: number }>

function baseTile(
  x: number,
  y: number,
  regionId: string,
  partial: Partial<MapTile> & { kind: TileKind },
): MapTile {
  return {
    x,
    y,
    regionId,
    owner: 'neutral',
    name: '',
    level: 1,
    buildingProgress: 0,
    buildingTarget: 0,
    rackCapacity: 0,
    racksUsed: 0,
    mwCapacity: 0,
    mwGeneration: 0,
    capex: 0,
    opexPerDay: 0,
    note: '',
    landValue: 0,
    ...partial,
  }
}

function scenic(
  x: number,
  y: number,
  regionId: string,
  kind: TileKind,
  name: string,
  note = '',
): MapTile {
  return baseTile(x, y, regionId, {
    kind,
    owner: 'neutral',
    name,
    buildingProgress: 1,
    buildingTarget: 1,
    note,
  })
}

/** Procedural mega-map (seeded via config). */
export function createInitialMap(config?: GameConfig): {
  width: number
  height: number
  tiles: MapTile[]
  regions: MapRegion[]
  energyPricePerMWh: number
  activeRegionId: string
  cities?: MapCity[]
} {
  const cfg = config ?? defaultGameConfig()
  const gen = generateProceduralMap(cfg)
  return {
    width: gen.width,
    height: gen.height,
    tiles: gen.tiles,
    regions: gen.regions,
    energyPricePerMWh: gen.energyPricePerMWh,
    activeRegionId: gen.activeRegionId,
    cities: gen.cities,
  }
}

/** Legacy hand-authored mini-map (tests only if needed). Prefer createInitialMap. */
export function createLegacyHandMap(): {
  width: number
  height: number
  tiles: MapTile[]
  regions: MapRegion[]
  energyPricePerMWh: number
  activeRegionId: string
} {
  const regions: MapRegion[] = [
    {
      id: 'west',
      name: 'Coast Grid',
      originX: 0,
      originY: 0,
      width: 7,
      height: 6,
      energyPriceMult: 1.2,
      latencyToMarket: 0.22,
      regulationRisk: 0.12,
    },
    {
      id: 'heartland',
      name: 'Heartland Power',
      originX: 8,
      originY: 0,
      width: 7,
      height: 6,
      energyPriceMult: 0.68,
      latencyToMarket: 0.62,
      regulationRisk: 0.05,
    },
    {
      id: 'north',
      name: 'Nordic Cool',
      originX: 0,
      originY: 7,
      width: 7,
      height: 5,
      energyPriceMult: 0.52,
      latencyToMarket: 0.82,
      regulationRisk: 0.15,
    },
  ]

  const width = 15
  const height = 12
  const tiles: MapTile[] = []

  // Helper to set after base loop
  const overrides = new Map<string, MapTile>()
  const put = (t: MapTile) => overrides.set(`${t.x},${t.y}`, t)

  // ── Coastal lakes & beach parks ──
  put(scenic(0, 0, 'west', 'lake', 'Bay inlet', 'Cool seawater for future free cooling.'))
  put(scenic(1, 0, 'west', 'lake', 'Bay inlet', 'Cool seawater for future free cooling.'))
  put(scenic(0, 1, 'west', 'lake', 'Tide flats'))
  put(scenic(0, 4, 'west', 'forest', 'Coast scrub', 'Protected dunes — no build.'))
  put(scenic(1, 4, 'west', 'forest', 'Coast scrub'))
  put(scenic(0, 5, 'west', 'park', 'Seaside park'))
  put(scenic(4, 0, 'west', 'road', 'Coast highway'))
  put(scenic(4, 1, 'west', 'road', 'Coast highway'))
  put(scenic(4, 2, 'west', 'road', 'Coast highway'))
  put(scenic(4, 3, 'west', 'road', 'Coast highway'))
  put(scenic(5, 0, 'west', 'house', 'Pier district', 'Residential demand spillover.'))
  put(scenic(6, 0, 'west', 'house', 'Pier district'))
  put(scenic(6, 1, 'west', 'house', 'Pier district'))
  put(scenic(5, 2, 'west', 'warehouse', 'Port sheds', 'Logistics — not buildable campus.'))
  put(scenic(6, 2, 'west', 'warehouse', 'Port sheds'))
  put(scenic(1, 5, 'west', 'park', 'Promenade'))
  put(scenic(2, 5, 'west', 'house', 'Worker housing'))
  put(scenic(3, 5, 'west', 'house', 'Worker housing'))
  put(scenic(3, 4, 'west', 'road', 'Campus feeder'))
  put(scenic(2, 4, 'west', 'road', 'Campus feeder'))

  // Starter plots
  put(
    baseTile(2, 2, 'west', {
      kind: 'empty',
      name: 'Prime coastal plot',
      note: 'Good first data-hall site near metro demand.',
    }),
  )
  put(
    baseTile(3, 2, 'west', {
      kind: 'empty',
      name: 'Grid-ready parcel',
      note: 'Ideal for interconnect next to a data hall.',
    }),
  )
  put(
    baseTile(3, 3, 'west', {
      kind: 'empty',
      name: 'Expansion pad',
      note: 'Open land for a second hall.',
    }),
  )
  put(scenic(5, 1, 'west', 'city', 'Metro demand', 'Enterprise + consumer latency anchor.'))

  // NovaScale campus
  put(
    baseTile(5, 4, 'west', {
      kind: 'dc',
      owner: 'rival_nova',
      name: 'NovaScale West',
      buildingProgress: 1,
      buildingTarget: 1,
      rackCapacity: 400,
      racksUsed: 280,
      note: 'Rival hyperscale campus.',
    }),
  )
  put(
    baseTile(6, 4, 'west', {
      kind: 'substation',
      owner: 'rival_nova',
      name: 'Nova feed',
      buildingProgress: 1,
      buildingTarget: 1,
      mwCapacity: 40,
    }),
  )
  put(scenic(6, 5, 'west', 'warehouse', 'Nova logistics'))
  put(scenic(5, 5, 'west', 'road', 'Nova access'))

  // ── Heartland farms, lakes, towns ──
  put(scenic(8, 0, 'heartland', 'forest', 'Shelter belt'))
  put(scenic(8, 1, 'heartland', 'forest', 'Shelter belt'))
  put(scenic(8, 5, 'heartland', 'lake', 'Farm reservoir', 'Agricultural water rights.'))
  put(scenic(9, 5, 'heartland', 'lake', 'Farm reservoir'))
  put(scenic(10, 5, 'heartland', 'park', 'County fairgrounds'))
  put(scenic(11, 0, 'heartland', 'house', 'Farmstead'))
  put(scenic(12, 0, 'heartland', 'house', 'Farmstead'))
  put(scenic(13, 0, 'heartland', 'house', 'Grain elevators row'))
  put(scenic(14, 0, 'heartland', 'warehouse', 'Silo district'))
  put(scenic(14, 1, 'heartland', 'warehouse', 'Silo district'))
  put(scenic(11, 2, 'heartland', 'road', 'State route 9'))
  put(scenic(12, 2, 'heartland', 'road', 'State route 9'))
  put(scenic(13, 2, 'heartland', 'road', 'State route 9'))
  put(scenic(13, 3, 'heartland', 'road', 'State route 9'))
  put(scenic(13, 4, 'heartland', 'road', 'State route 9'))
  put(scenic(14, 4, 'heartland', 'house', 'Suburb'))
  put(scenic(14, 5, 'heartland', 'house', 'Suburb'))
  put(scenic(13, 5, 'heartland', 'park', 'Ball fields'))
  put(scenic(9, 0, 'heartland', 'forest', 'Windbreak'))
  put(scenic(10, 0, 'heartland', 'empty', 'Flat field'))

  put(
    baseTile(10, 2, 'heartland', {
      kind: 'substation',
      owner: 'neutral',
      name: 'Utility node H-2',
      buildingProgress: 1,
      buildingTarget: 1,
      mwCapacity: 15,
      note: 'Cheap power node. Build your DC adjacent and interconnect.',
    }),
  )
  put(
    baseTile(9, 3, 'heartland', {
      kind: 'dc',
      owner: 'rival_sparse',
      name: 'Sparseform Core',
      buildingProgress: 1,
      buildingTarget: 1,
      rackCapacity: 220,
      racksUsed: 150,
      note: 'Efficiency lab — MoE inference campus.',
    }),
  )
  put(
    baseTile(11, 4, 'heartland', {
      kind: 'dc',
      owner: 'rival_open',
      name: 'OpenLattice Cluster',
      buildingProgress: 1,
      buildingTarget: 1,
      rackCapacity: 120,
      racksUsed: 90,
      note: 'Open-weights training cluster.',
    }),
  )
  put(scenic(12, 1, 'heartland', 'city', 'Midwest hub'))
  put(scenic(9, 1, 'heartland', 'road', 'Service road'))
  put(scenic(10, 1, 'heartland', 'road', 'Service road'))
  put(scenic(10, 3, 'heartland', 'road', 'Campus loop'))
  put(scenic(11, 3, 'heartland', 'road', 'Campus loop'))
  put(
    baseTile(12, 3, 'heartland', {
      kind: 'empty',
      name: 'Heartland pad',
      note: 'Cheap land next to power.',
    }),
  )
  put(
    baseTile(12, 4, 'heartland', {
      kind: 'empty',
      name: 'Heartland pad B',
    }),
  )

  // ── Nordic lakes, pine forest, towns ──
  put(scenic(0, 7, 'north', 'lake', 'Fjellvatnet', 'Deep cold lake — free cooling dream.'))
  put(scenic(1, 7, 'north', 'lake', 'Fjellvatnet'))
  put(scenic(0, 8, 'north', 'lake', 'Fjellvatnet'))
  put(scenic(1, 8, 'north', 'forest', 'Pine belt'))
  put(scenic(0, 9, 'north', 'forest', 'Pine belt'))
  put(scenic(0, 10, 'north', 'forest', 'Pine belt'))
  put(scenic(1, 10, 'north', 'forest', 'Pine belt'))
  put(scenic(1, 11, 'north', 'forest', 'Pine belt'))
  put(scenic(2, 11, 'north', 'house', 'Fjord village'))
  put(scenic(3, 11, 'north', 'house', 'Fjord village'))
  put(scenic(4, 11, 'north', 'house', 'Fjord village'))
  put(scenic(5, 11, 'north', 'park', 'Lakeside trail'))
  put(scenic(6, 11, 'north', 'lake', 'Inlet'))
  put(scenic(6, 10, 'north', 'lake', 'Inlet'))
  put(scenic(6, 9, 'north', 'forest', 'Ridge trees'))
  put(scenic(6, 8, 'north', 'forest', 'Ridge trees'))
  put(scenic(6, 7, 'north', 'road', 'E16 corridor'))
  put(scenic(5, 7, 'north', 'road', 'E16 corridor'))
  put(scenic(4, 7, 'north', 'road', 'E16 corridor'))
  put(scenic(3, 7, 'north', 'road', 'E16 corridor'))
  put(scenic(3, 8, 'north', 'road', 'E16 corridor'))
  put(scenic(4, 8, 'north', 'warehouse', 'Cold storage'))
  put(scenic(2, 8, 'north', 'house', 'Ski cabins'))

  put(
    baseTile(2, 9, 'north', {
      kind: 'solar',
      owner: 'neutral',
      name: 'Nordic hydro-adjacent',
      buildingProgress: 1,
      buildingTarget: 1,
      mwGeneration: 4,
      note: 'Cold climate free cooling zone.',
    }),
  )
  put(
    baseTile(3, 9, 'north', {
      kind: 'dc',
      owner: 'rival_aegis',
      name: 'Aegis North',
      buildingProgress: 1,
      buildingTarget: 1,
      rackCapacity: 140,
      racksUsed: 100,
      note: 'Safety-first lab campus.',
    }),
  )
  put(
    baseTile(4, 10, 'north', {
      kind: 'dc',
      owner: 'rival_chroma',
      name: 'Chroma Render',
      buildingProgress: 1,
      buildingTarget: 1,
      rackCapacity: 100,
      racksUsed: 80,
      note: 'Multimodal / creative render farm.',
    }),
  )
  put(scenic(5, 8, 'north', 'city', 'EU market'))
  put(
    baseTile(2, 10, 'north', {
      kind: 'empty',
      name: 'Nordic plot',
      note: 'Cold + power-adjacent land.',
    }),
  )
  put(
    baseTile(4, 9, 'north', {
      kind: 'empty',
      name: 'Nordic plot B',
    }),
  )

  // Corridor void between regions — light scenery on seams
  put(scenic(7, 1, 'void', 'forest', 'Green belt'))
  put(scenic(7, 2, 'void', 'forest', 'Green belt'))
  put(scenic(7, 3, 'void', 'lake', 'Marsh'))
  put(scenic(7, 4, 'void', 'forest', 'Green belt'))
  put(scenic(1, 6, 'void', 'road', 'North link'))
  put(scenic(2, 6, 'void', 'road', 'North link'))
  put(scenic(3, 6, 'void', 'road', 'North link'))
  put(scenic(4, 6, 'void', 'forest', 'Pass'))
  put(scenic(5, 6, 'void', 'forest', 'Pass'))

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const region = regions.find(
        (r) =>
          x >= r.originX &&
          x < r.originX + r.width &&
          y >= r.originY &&
          y < r.originY + r.height,
      )
      const regionId = region?.id ?? 'void'
      const key = `${x},${y}`
      if (overrides.has(key)) {
        tiles.push(overrides.get(key)!)
        continue
      }
      // Procedural scenic fill for leftover empties (keep most plots buildable)
      const h = (x * 13 + y * 29) % 11
      if (regionId === 'west') {
        if (h === 0) tiles.push(scenic(x, y, regionId, 'park', 'Pocket green'))
        else if (h === 3) tiles.push(scenic(x, y, regionId, 'house', 'Side street homes'))
        else if (h === 7) tiles.push(scenic(x, y, regionId, 'forest', 'Coast copse'))
        else tiles.push(baseTile(x, y, regionId, { kind: 'empty' }))
      } else if (regionId === 'heartland') {
        if (h === 1) tiles.push(scenic(x, y, regionId, 'forest', 'Coppice'))
        else if (h === 4) tiles.push(scenic(x, y, regionId, 'house', 'Farm cottage'))
        else if (h === 8) tiles.push(scenic(x, y, regionId, 'park', 'Field margin'))
        else tiles.push(baseTile(x, y, regionId, { kind: 'empty' }))
      } else if (regionId === 'north') {
        if (h === 2) tiles.push(scenic(x, y, regionId, 'forest', 'Birch stand'))
        else if (h === 5) tiles.push(scenic(x, y, regionId, 'lake', 'Tarn'))
        else if (h === 9) tiles.push(scenic(x, y, regionId, 'house', 'Cabin plot'))
        else tiles.push(baseTile(x, y, regionId, { kind: 'empty' }))
      } else if (regionId === 'void' && h === 0) {
        tiles.push(scenic(x, y, regionId, 'forest', 'Wild scrub'))
      } else {
        tiles.push(baseTile(x, y, regionId, { kind: 'empty' }))
      }
    }
  }

  return {
    width,
    height,
    tiles,
    regions,
    energyPricePerMWh: ECONOMY.energyBasePrice,
    activeRegionId: 'west',
  }
}

export type PlaceCellCheck = { x: number; y: number; ok: boolean }
export type PlaceCheck = {
  ok: boolean
  reason?: string
  cells: PlaceCellCheck[]
  totalCash: number
  buildCash: number
  landCash: number
  gradingCash: number
  minElevation: number
  maxElevation: number
  maxGrade: number
  foundationHeight: number
}

/** Non-mutating placement check — used by ghost preview + placeBuilding. */
export function canPlaceBuilding(
  state: SimState,
  x: number,
  y: number,
  kind: BuildableKind,
): PlaceCheck {
  const def = getBuildDef(kind)
  const footprint = dcFootprint(kind)
  const cells: PlaceCellCheck[] = footprint.map(({ dx, dy }) => ({
    x: x + dx,
    y: y + dy,
    ok: false,
  }))
  const empty: PlaceCheck = {
    ok: false,
    cells,
    totalCash: 0,
    buildCash: 0,
    landCash: 0,
    gradingCash: 0,
    minElevation: 0,
    maxElevation: 0,
    maxGrade: 0,
    foundationHeight: 0,
  }

  if (kind === 'nuclear' && state.day < 70) {
    return { ...empty, reason: 'SMR permits open after day 70.' }
  }
  if (kind === 'lab') {
    const researchers = state.player.staff?.researcher ?? 0
    if (researchers < 1 && state.player.talent < 1.2) {
      return {
        ...empty,
        reason: 'Staff at least one researcher in an HQ before opening a research lab.',
      }
    }
  }
  if (isHqKind(kind)) {
    // always placeable — staffing is the talent gate now
  }
  if (kind === 'cooling') {
    const hasDc = facilityAnchorTiles(state, { ownerId: 'player' }).some(
      (t) =>
        isDcKind(t.kind) &&
        t.buildingProgress >= t.buildingTarget,
    )
    if (!hasDc) {
      return { ...empty, reason: 'Build a live data hall before a cooling plant.' }
    }
  }

  const resolved: { x: number; y: number; idx: number; tile: MapTile; ok: boolean }[] = []
  for (let i = 0; i < footprint.length; i++) {
    const { dx, dy } = footprint[i]!
    const cx = x + dx
    const cy = y + dy
    const ct = mapTileAt(state, cx, cy)
    if (!ct) {
      cells[i] = { x: cx, y: cy, ok: false }
      resolved.push({ x: cx, y: cy, idx: -1, tile: null as unknown as MapTile, ok: false })
      continue
    }
    const ci = usesCompactWorld(state)
      ? (compactTileIdAt(state, cx, cy) as number)
      : mapTileIndexAt(state, cx, cy)
    const cellOk =
      ct.kind === 'empty' &&
      (ct.owner === 'neutral' || ct.owner === 'player') &&
      ct.regionId !== 'void' &&
      state.map.regions.some((r) => r.id === ct.regionId)
    cells[i] = { x: cx, y: cy, ok: cellOk }
    resolved.push({ x: cx, y: cy, idx: ci, tile: ct, ok: cellOk })
  }

  const landOk = resolved.every((c) => c.ok)
  const econ = state.config?.economyMult ?? 1
  const buildCash = Math.floor(def.cash * econ)
  let landCash = 0
  for (const c of resolved) {
    if (c.ok) {
      const accessMultiplier = c.idx >= 0 ? transportLandValueMultiplier(state, c.idx) : 1
      landCash += Math.max(0, c.tile.landValue ?? 0) * accessMultiplier
    }
  }
  let minElevation = 0
  let maxElevation = 0
  let maxGrade = 0
  const compactWorld = state.map.world
  if ((compactWorld?.descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V4 ||
      compactWorld?.descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V5 ||
      compactWorld?.descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V6 ||
      compactWorld?.descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V7) && resolved.length > 0) {
    minElevation = Number.POSITIVE_INFINITY
    maxElevation = Number.NEGATIVE_INFINITY
    for (const cell of resolved) {
      if (cell.idx < 0) continue
      maxGrade = Math.max(maxGrade, compactWorld.getTileSlope(cell.x, cell.y))
      for (const [cornerX, cornerY] of [
        [cell.x, cell.y], [cell.x + 1, cell.y], [cell.x, cell.y + 1], [cell.x + 1, cell.y + 1],
      ] as const) {
        const elevation = compactWorld.getCornerElevation(cornerX, cornerY)
        minElevation = Math.min(minElevation, elevation)
        maxElevation = Math.max(maxElevation, elevation)
      }
    }
    if (!Number.isFinite(minElevation)) minElevation = 0
    if (!Number.isFinite(maxElevation)) maxElevation = 0
  }
  const foundationHeight = Math.max(0, maxElevation - minElevation)
  const gradingRate = maxGrade <= 0.08
    ? 0
    : 0.1 + Math.min(1, (maxGrade - 0.08) / 0.08) * 0.25
  const gradingCash = Math.floor(buildCash * gradingRate)
  const totalCash = buildCash + landCash + gradingCash
  const cashOk = state.player.cash >= totalCash

  if (!landOk) {
    const bad = resolved.find((c) => !c.ok)
    let reason = `${def.label} footprint blocked.`
    if (bad) {
      if (bad.idx < 0) reason = `${def.label} footprint leaves the map.`
      else if (bad.tile.kind !== 'empty') {
        const label = isScenicKind(bad.tile.kind)
          ? scenicLabel(bad.tile.kind).toLowerCase()
          : bad.tile.kind
        reason = `Cannot build on ${label} (${bad.x},${bad.y}).`
      } else if (bad.tile.owner !== 'neutral' && bad.tile.owner !== 'player') {
        reason = `Rival controls parcel (${bad.x},${bad.y}).`
      } else if (bad.tile.regionId === 'void') {
        reason = 'Footprint must stay inside a developable region.'
      }
    }
    return { ok: false, reason, cells, totalCash, buildCash, landCash, gradingCash,
      minElevation, maxElevation, maxGrade, foundationHeight }
  }
  if (maxGrade > 0.16) {
    return {
      ok: false,
      reason: `${def.label} footprint is too steep (${Math.round(maxGrade * 100)}% grade; maximum 16%).`,
      cells: cells.map((cell) => ({ ...cell, ok: false })),
      totalCash,
      buildCash,
      landCash,
      gradingCash,
      minElevation,
      maxElevation,
      maxGrade,
      foundationHeight,
    }
  }
  if (!cashOk) {
    return {
      ok: false,
      reason: `Need $${(totalCash / 1e6).toFixed(1)}M (build $${(buildCash / 1e6).toFixed(1)}M + land $${(landCash / 1e6).toFixed(1)}M).`,
      cells: cells.map((c) => ({ ...c, ok: false })),
      totalCash,
      buildCash,
      landCash,
      gradingCash,
      minElevation,
      maxElevation,
      maxGrade,
      foundationHeight,
    }
  }
  return { ok: true, cells, totalCash, buildCash, landCash, gradingCash,
    minElevation, maxElevation, maxGrade, foundationHeight }
}

export function placeBuilding(
  state: SimState,
  x: number,
  y: number,
  kind: BuildableKind,
): SimState {
  const check = canPlaceBuilding(state, x, y, kind)
  if (!check.ok) {
    return alert(state, 'warn', check.reason ?? 'Cannot place building here.')
  }

  const def = getBuildDef(kind)
  const footprint = dcFootprint(kind)
  const cells: { x: number; y: number; idx: number; tile: MapTile }[] = []
  for (const { dx, dy } of footprint) {
    const cx = x + dx
    const cy = y + dy
    const ci = usesCompactWorld(state)
      ? (compactTileIdAt(state, cx, cy) as number)
      : mapTileIndexAt(state, cx, cy)
    cells.push({ x: cx, y: cy, idx: ci, tile: mapTileAt(state, cx, cy)! })
  }

  const totalCash = check.totalCash
  const econ = state.config?.economyMult ?? 1

  const name = defaultName(state, kind)
  let note = def.blurb
  if (isDcKind(kind) || kind === 'solar' || kind === 'gas' || kind === 'substation') {
    let near: { city: MapCity; dist: number } | null = null
    for (const city of state.map.cities ?? []) {
      const dist = Math.max(Math.abs(city.cx - x), Math.abs(city.cy - y))
      if (near == null || dist < near.dist) near = { city, dist }
    }
    if (near && near.dist <= near.city.powerRadius) {
      note = `${def.blurb} · Inside ${near.city.name} power zone.`
    } else if (near) {
      note = `${def.blurb} · ${near.dist} tiles from ${near.city.name}.`
    }
  }

  const campusId =
    isDcKind(kind) || isHqKind(kind)
      ? `campus-${state.day}-${state.tick}-${x}-${y}`
      : `facility-${state.day}-${state.tick}-${kind}-${x}-${y}`

  if (usesCompactWorld(state)) {
    const world = state.map.world!
    const facility: Facility = {
      id: campusId,
      kind,
      ownerId: 'player',
      anchor: tileId(x, y, world.descriptor.width, world.descriptor.height),
      footprint: cells.map((cell) =>
        tileId(cell.x, cell.y, world.descriptor.width, world.descriptor.height),
      ),
      level: 1,
      constructionProgress: 0,
      constructionTarget: def.days,
      powered: isDcKind(kind) ? true : undefined,
      stats: {
        rackCapacity: def.rack ?? 0,
        racksUsed: 0,
        mwCapacity: def.mw ?? 0,
        mwGeneration: def.gen ?? 0,
        capex: totalCash,
        opexPerDay: Math.floor(def.opexPerDay * econ),
      },
      data: {
        name,
        note,
        dcSize: def.dcSize,
        hqSize: def.hqSize,
        foundationElevation: (check.minElevation + check.maxElevation) / 2,
        foundationHeight: check.foundationHeight,
        gradingCash: check.gradingCash,
      },
    }
    const batch = world.beginBatch().addFacility(facility)
    const committed = commitWorldBatch(state, batch)
    return {
      ...committed,
      map: { ...committed.map, activeRegionId: cells[0]!.tile.regionId },
      player: { ...committed.player, cash: committed.player.cash - totalCash },
      alerts: [
        {
          id: `build-${kind}-${x}-${y}-${state.day}`,
          day: state.day,
          severity: 'info' as const,
          message: `Breaking ground: ${def.label} (${name}${
            footprint.length > 1 ? ` · ${footprint.length} tiles` : ''
          }) — $${(totalCash / 1e6).toFixed(1)}M, ${def.days}d`,
        },
        ...state.alerts,
      ].slice(0, 40),
    }
  }

  const tiles = state.map.tiles.slice()
  for (const c of cells) {
    const isAnchor = c.x === x && c.y === y
    tiles[c.idx] = {
      ...c.tile,
      kind,
      owner: 'player',
      name: isAnchor ? name : `${name} pad`,
      level: 1,
      buildingProgress: 0,
      buildingTarget: def.days,
      rackCapacity: isAnchor ? (def.rack ?? 0) : 0,
      mwCapacity: isAnchor ? (def.mw ?? 0) : 0,
      mwGeneration: isAnchor ? (def.gen ?? 0) : 0,
      racksUsed: 0,
      capex: isAnchor ? totalCash : 0,
      opexPerDay: isAnchor ? Math.floor(def.opexPerDay * econ) : 0,
      note: isAnchor ? note : `Footprint pad for ${name}`,
      landValue: 0,
      powered: isDcKind(kind) ? true : c.tile.powered,
      campusId: isDcKind(kind) || isHqKind(kind) ? campusId : undefined,
      campusRole: isDcKind(kind) || isHqKind(kind) ? (isAnchor ? 'anchor' : 'pad') : undefined,
      dcSize: def.dcSize,
      hqSize: def.hqSize,
    }
  }

  const anchorTile = cells[0]!.tile
  return {
    ...state,
    map: { ...state.map, tiles, activeRegionId: anchorTile.regionId },
    player: { ...state.player, cash: state.player.cash - totalCash },
    alerts: [
      {
        id: `build-${kind}-${x}-${y}-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message: `Breaking ground: ${def.label} (${name}${
          footprint.length > 1 ? ` · ${footprint.length} tiles` : ''
        }) — $${(totalCash / 1e6).toFixed(1)}M, ${def.days}d`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

/** Land + construction total for UI (sums land under full footprint). */
export function buildingTotalCost(state: SimState, tile: MapTile, kind: BuildableKind): number {
  const exact = canPlaceBuilding(state, tile.x, tile.y, kind)
  if (usesCompactWorld(state) && exact.totalCash > 0) return exact.totalCash
  const def = getBuildDef(kind)
  const econ = state.config?.economyMult ?? 1
  let land = 0
  for (const { dx, dy } of dcFootprint(kind)) {
    const t = mapTileAt(state, tile.x + dx, tile.y + dy)
    land += Math.max(0, t?.landValue ?? 0)
  }
  return Math.floor(def.cash * econ) + land
}

export function upgradeBuilding(state: SimState, x: number, y: number): SimState {
  const tile = mapTileAt(state, x, y)
  if (!tile) return state
  if (tile.owner !== 'player') return alert(state, 'warn', 'Can only upgrade your buildings.')
  if (!isBuildableKind(tile.kind)) {
    return alert(state, 'warn', 'That parcel cannot be upgraded.')
  }
  if (isDcKind(tile.kind) && !isDcAnchor(tile)) {
    return alert(state, 'warn', 'Upgrade the campus anchor tile, not a footprint pad.')
  }
  if (tile.buildingProgress < tile.buildingTarget) {
    return alert(state, 'warn', 'Finish construction before upgrading.')
  }
  if (tile.level >= ECONOMY.maxBuildingLevel) {
    return alert(state, 'warn', `Max level L${ECONOMY.maxBuildingLevel} reached.`)
  }

  const def = getBuildDef(tile.kind)
  const cost = def.upgradeCash ?? def.cash * 0.45
  const days = def.upgradeDays ?? Math.max(5, Math.floor(def.days * 0.55))
  if (state.player.cash < cost) {
    return alert(state, 'warn', `Upgrade needs $${(cost / 1e6).toFixed(0)}M.`)
  }

  if (usesCompactWorld(state)) {
    const world = state.map.world!
    const id = compactTileIdAt(state, x, y)!
    const facility = world.getFacilityAt(id)
    if (!facility) return state
    const stats = facility.stats ?? {}
    const nextLevel = facility.level + 1
    const batch = world.beginBatch().updateFacility(facility.id, {
      level: nextLevel,
      constructionProgress: 0,
      constructionTarget: days,
      stats: {
        ...stats,
        rackCapacity:
          (stats.rackCapacity ?? 0) +
          (def.upgradeRack ?? Math.floor((def.rack ?? 0) * 0.5)),
        mwCapacity:
          (stats.mwCapacity ?? 0) +
          (def.upgradeMw ?? Math.floor((def.mw ?? 0) * 0.5)),
        mwGeneration:
          (stats.mwGeneration ?? 0) +
          (def.kind === 'solar' || def.kind === 'gas' || def.kind === 'nuclear'
            ? Math.floor((def.gen ?? 0) * 0.4)
            : 0),
        capex: (stats.capex ?? 0) + cost,
        opexPerDay: Math.floor((stats.opexPerDay ?? 0) * 1.25),
      },
      data: facilityDataPatch(facility, {
        note: `Level ${nextLevel} expansion in progress.`,
        constructionExpedited: false,
      }),
    })
    const committed = commitWorldBatch(state, batch)
    return {
      ...committed,
      player: { ...committed.player, cash: committed.player.cash - cost },
      alerts: [
        {
          id: `upg-${x}-${y}-${state.day}`,
          day: state.day,
          severity: 'info' as const,
          message: `Upgrading ${tile.name} → L${nextLevel} ($${(cost / 1e6).toFixed(0)}M)`,
        },
        ...state.alerts,
      ].slice(0, 40),
    }
  }

  const idx = mapTileIndexAt(state, x, y)
  const tiles = state.map.tiles.slice()
  tiles[idx] = {
    ...tile,
    level: tile.level + 1,
    buildingProgress: 0,
    buildingTarget: days,
    constructionExpedited: false,
    rackCapacity: tile.rackCapacity + (def.upgradeRack ?? Math.floor((def.rack ?? 0) * 0.5)),
    mwCapacity: tile.mwCapacity + (def.upgradeMw ?? Math.floor((def.mw ?? 0) * 0.5)),
    mwGeneration:
      tile.mwGeneration +
      (def.kind === 'solar' || def.kind === 'gas' || def.kind === 'nuclear'
        ? Math.floor((def.gen ?? 0) * 0.4)
        : 0),
    capex: tile.capex + cost,
    opexPerDay: Math.floor(tile.opexPerDay * 1.25),
    note: `Level ${tile.level + 1} expansion in progress.`,
  }

  return {
    ...state,
    map: { ...state.map, tiles },
    player: { ...state.player, cash: state.player.cash - cost },
    alerts: [
      {
        id: `upg-${x}-${y}-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message: `Upgrading ${tile.name} → L${tile.level + 1} ($${(cost / 1e6).toFixed(0)}M)`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

/** Flavor name pools per facility kind — assigned at place time, unique when possible. */
const NAME_POOLS: Partial<Record<TileKind, string[]>> = {
  dc: [
    'Edge POP',
    'Harbor Rack',
    'Volt Shed',
    'Copper Node',
    'Lattice Edge',
    'Relay Hall',
    'Packet Yard',
    'Signal Box',
  ],
  dc_m: [
    'Midspan Campus',
    'River Bend DC',
    'Atlas Halls',
    'Quorum Yard',
    'Helix Campus',
    'Northstack',
    'Gridforge M',
    'Meridian Halls',
  ],
  dc_l: [
    'Hyperscale One',
    'Aetherworks',
    'Titan Valley',
    'Foundry Mega',
    'Horizon Cluster',
    'Zenith Campus',
    'Ironcloud',
    'Supernova Halls',
  ],
  substation: ['Interconnect A', 'Grid Tap', 'Busbar Node', 'Feeder Yard', 'Switchyard'],
  solar: ['Sunfield', 'Photovoltaic Range', 'Daylight Array', 'Solstice Field', 'Photon Pasture'],
  gas: ['Peaker One', 'Turbine Yard', 'Combustion Row', 'Fast Peak', 'Gas Spin'],
  nuclear: ['SMR Core', 'Isotope Plant', 'Coolant Loop', 'Reactor Annex', 'Fission Pad'],
  fab: ['Foundry Line', 'Wafer Works', 'Tapeout Bay', 'Die Farm', 'Silicon Forge'],
  cooling: ['Chiller Plant', 'Thermal Loop', 'Cold Aisle Yard', 'Heat Sink', 'Cryo Annex'],
  battery: ['BESS Yard', 'Storage Block', 'Night Buffer', 'Megapack Row', 'Reserve Cell'],
  hq: ['Founders Desk', 'Ops Nest', 'Signal Office', 'Hive One', 'Relay HQ'],
  hq_m: ['Meridian HQ', 'Atlas Works', 'Northspan HQ', 'Quorum House', 'Campus People'],
  hq_l: ['Helix Tower', 'Sovereign HQ', 'Aether Offices', 'Summit Campus', 'Ironcloud HQ'],
  office: ['Founders Desk', 'Ops Nest', 'Signal Office'],
  lab: ['Research Lab', 'Eval Bay', 'Model Kitchen', 'Align Lab', 'Blue Room'],
}

const KIND_FALLBACK: Partial<Record<TileKind, string>> = {
  dc: 'Edge hall',
  dc_m: 'Campus M',
  dc_l: 'Mega hall',
  substation: 'Interconnect',
  solar: 'Solar field',
  gas: 'Peaker',
  nuclear: 'SMR',
  fab: 'Fab',
  cooling: 'Cooling plant',
  battery: 'Battery farm',
  hq: 'HQ',
  hq_m: 'HQ campus',
  hq_l: 'HQ tower',
  office: 'HQ',
  lab: 'Research lab',
}

function existingPlayerNames(state: SimState): Set<string> {
  const set = new Set<string>()
  for (const t of facilityAnchorTiles(state, { ownerId: 'player' })) {
    if (!t.name) continue
    const base = t.name.replace(/\s+pad$/i, '').trim().toLowerCase()
    if (base) set.add(base)
  }
  return set
}

function defaultName(state: SimState, kind: TileKind): string {
  const taken = existingPlayerNames(state)
  const pool = NAME_POOLS[kind] ?? []
  for (const candidate of pool) {
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  const base = KIND_FALLBACK[kind] ?? (isBuildableKind(kind) ? getBuildDef(kind).label : String(kind))
  if (!taken.has(base.toLowerCase())) return base
  let n = 2
  while (taken.has(`${base} ${n}`.toLowerCase())) n++
  return `${base} ${n}`
}

/** UI label for a building — strips legacy "x,y" suffixes from older saves. */
export function buildingDisplayName(
  tile: { name?: string; kind: string; campusRole?: string },
  fallback = 'Building',
): string {
  const raw = (tile.name || '').trim()
  if (!raw) {
    if (isBuildableKind(tile.kind as TileKind)) {
      return getBuildDef(tile.kind as BuildableKind).label
    }
    return fallback
  }
  // "Edge hall 12,34" / "Edge hall pad" keep pad; drop trailing coords
  let name = raw.replace(/\s+\d+\s*,\s*\d+\s*$/, '').trim()
  if (!name) name = fallback
  return name
}

const MAX_BUILDING_NAME = 40

/** Sanitize a player-chosen building name. */
export function sanitizeBuildingName(raw: string): string {
  return raw
    .split('')
    .filter((character) => character.charCodeAt(0) >= 0x20)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BUILDING_NAME)
}

/**
 * Rename a player building. For multi-tile DCs, renames the whole campus
 * (anchor + pads). Pads always show as "{name} pad".
 */
export function renameBuilding(
  state: SimState,
  x: number,
  y: number,
  rawName: string,
): SimState {
  const tile = mapTileAt(state, x, y)
  if (!tile) return state
  if (tile.owner !== 'player') {
    return alert(state, 'warn', 'You can only rename your own buildings.')
  }
  if (!isBuildableKind(tile.kind)) {
    return alert(state, 'warn', 'That parcel has no building to rename.')
  }
  // Renaming a pad → apply to campus anchor
  let target = tile
  let tx = x
  let ty = y
  if (tile.campusRole === 'pad' && tile.campusId) {
    const anchor = usesCompactWorld(state)
      ? (() => {
          const facility = state.map.world!.facilitiesById.get(tile.campusId!)
          if (!facility) return undefined
          const { x: ax, y: ay } = tileCoords(facility.anchor, state.map.width)
          return mapTileAt(state, ax, ay)
        })()
      : state.map.tiles.find(
          (t) => t.campusId === tile.campusId && t.campusRole === 'anchor',
        )
    if (anchor) {
      target = anchor
      tx = anchor.x
      ty = anchor.y
    }
  }

  const name = sanitizeBuildingName(rawName)
  if (!name) {
    return alert(state, 'warn', 'Name cannot be empty.')
  }
  if (name.toLowerCase().endsWith(' pad')) {
    return alert(state, 'warn', 'Leave off “pad” — footprint tiles are named automatically.')
  }

  if (usesCompactWorld(state)) {
    const id = compactTileIdAt(state, tx, ty)!
    const facility = state.map.world!.getFacilityAt(id)
    if (!facility) return state
    const batch = state.map.world!.beginBatch().updateFacility(facility.id, {
      data: facilityDataPatch(facility, { name }),
    })
    const committed = commitWorldBatch(state, batch)
    return {
      ...committed,
      alerts: [
        {
          id: `rename-${tx}-${ty}-${state.day}`,
          day: state.day,
          severity: 'info' as const,
          message: `Renamed to “${name}”.`,
        },
        ...state.alerts,
      ].slice(0, 40),
    }
  }

  const campusId = target.campusId
  const tiles = state.map.tiles.map((t) => {
    const match =
      (t.x === tx && t.y === ty) || (campusId && t.campusId === campusId && t.owner === 'player')
    if (!match) return t
    if (t.campusRole === 'pad') {
      return { ...t, name: `${name} pad` }
    }
    return { ...t, name }
  })

  return {
    ...state,
    map: { ...state.map, tiles },
    alerts: [
      {
        id: `rename-${tx}-${ty}-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message: `Renamed to “${name}”.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

function alert(state: SimState, severity: 'info' | 'warn' | 'danger', message: string): SimState {
  const id = `m-${state.day}-${message.slice(0, 16)}`
  return {
    ...state,
    alerts: [
      { id, day: state.day, severity, message },
      ...state.alerts.filter((candidate) => candidate.id !== id),
    ].slice(0, 40),
  }
}

/** Campus-only latency (region proximity). Does not include capacity queues. */
export function playerLatencyScore(state: SimState): number {
  let score = 0
  let weight = 0
  if (usesCompactWorld(state)) {
    const world = state.map.world!
    for (const facility of compactCompletedFacilitiesForOwner(state, 'player') ?? []) {
      if (!isDcKind(facility.kind)) continue
      const regionIndex = world.staticWorld.region[facility.anchor]
      const regionId =
        regionIndex === undefined ? undefined : world.staticWorld.regions[regionIndex]?.id
      const region = state.map.regions.find((candidate) => candidate.id === regionId)
      if (!region) continue
      const facilityWeight = Math.max(1, facility.stats?.racksUsed ?? 0)
      score += (1 - region.latencyToMarket) * 100 * facilityWeight
      weight += facilityWeight
    }
  } else {
    for (const t of facilityAnchorTiles(state, { ownerId: 'player' })) {
      if (!isDcKind(t.kind) || t.buildingProgress < t.buildingTarget) continue
      const region = state.map.regions.find((r) => r.id === t.regionId)
      if (!region) continue
      const facilityWeight = Math.max(1, t.racksUsed)
      score += (1 - region.latencyToMarket) * 100 * facilityWeight
      weight += facilityWeight
    }
  }
  if (weight === 0) return 55
  return Math.max(15, Math.min(95, score / weight))
}

/**
 * What buyers experience: campus latency crushed by inference overload / queueing.
 * Higher unserved + lingering servicePain → much worse (lower) score.
 */
export function playerServiceLatencyScore(
  state: SimState,
  opts?: { unservedRatio?: number; servicePain?: number },
): number {
  const base = playerLatencyScore(state)
  const unserved = opts?.unservedRatio ?? state.lastMarket?.unservedRatio ?? 0
  const pain = opts?.servicePain ?? state.player.servicePain ?? 0
  // Peak of recent overload drives queues (customers remember yesterday's outage)
  const load = Math.max(unserved, pain)
  if (load <= 0.01) return base
  // Soft start, then steep: 20% unserved ~ -18 pts, 50% ~ -45, 100% ~ -75
  const queuePenalty = 12 + Math.pow(load, 0.75) * 68
  const jitter = load > 0.35 ? 8 : load > 0.15 ? 4 : 0
  return Math.max(6, Math.min(95, base - queuePenalty - jitter))
}

/**
 * Shared-grid wholesale price: base × regional mult × scarcity.
 * Scarcity rises once industry live DCs exceed ~15 (grid soft cap).
 * Own generation does not remove you from scarcity entirely — grid congestion
 * is industry-wide — but you only *pay* grid $/MWh on net utility imports.
 */
export function energyPriceForState(state: SimState): number {
  const scarcity = gridScarcity(state)
  let mw = 0
  let weighted = 0
  if (usesCompactWorld(state)) {
    const world = state.map.world!
    for (const facility of compactCompletedFacilitiesForOwner(state, 'player') ?? []) {
      if (!isDcKind(facility.kind)) continue
      const draw = Math.max(
        0.5,
        (facility.stats?.racksUsed ?? 0) * 0.0075 * state.player.pue,
      )
      const regionIndex = world.staticWorld.region[facility.anchor]
      const regionId =
        regionIndex === undefined ? undefined : world.staticWorld.regions[regionIndex]?.id
      const region = state.map.regions.find((candidate) => candidate.id === regionId)
      const mult = region?.energyPriceMult ?? 1
      weighted += ECONOMY.energyBasePrice * mult * scarcity.priceMult * draw
      mw += draw
    }
  } else {
    for (const t of facilityAnchorTiles(state, { ownerId: 'player' })) {
      if (t.buildingProgress < t.buildingTarget) continue
      if (!isDcKind(t.kind) || !isDcAnchor(t)) continue
      const draw = Math.max(0.5, t.racksUsed * 0.0075 * state.player.pue)
      const region = state.map.regions.find((r) => r.id === t.regionId)
      const mult = region?.energyPriceMult ?? 1
      weighted += ECONOMY.energyBasePrice * mult * scarcity.priceMult * draw
      mw += draw
    }
  }
  const base =
    mw > 0
      ? weighted / mw
      : ECONOMY.energyBasePrice * scarcity.priceMult
  const eventMult = state.activeEvents.reduce(
    (m, e) => m * (e.effects.energyPriceMult ?? 1),
    1,
  )
  return base * eventMult
}

/** Industry DC count + grid congestion mult for UI / pricing. */
export function gridScarcity(state: SimState): GridScarcitySnapshot {
  const compactWorld = usesCompactWorld(state) ? state.map.world! : undefined
  if (compactWorld) {
    const cached = compactGridScarcityCaches.get(compactWorld)
    if (cached?.revision === compactWorld.revision) return cached.snapshot
  }
  const soft = ECONOMY.gridSoftDcCap ?? 15
  const gridCap = ECONOMY.gridBaseMw ?? 210
  const proxy = ECONOMY.gridMwPerDcProxy ?? 12
  let industryDcCount = 0
  let genMw = 0
  if (usesCompactWorld(state)) {
    for (const facility of compactCompletedFacilities(state) ?? []) {
      if (isDcKind(facility.kind) && facility.ownerId !== 'neutral') industryDcCount++
      if (
        (facility.kind === 'solar' || facility.kind === 'gas' || facility.kind === 'nuclear') &&
        facility.ownerId !== 'neutral'
      ) {
        genMw += facility.stats?.mwGeneration ?? 0
      }
    }
  } else {
    for (const t of facilityAnchorTiles(state)) {
      if (t.buildingProgress < t.buildingTarget && t.buildingTarget > 0) continue
      if (isDcKind(t.kind) && isDcAnchor(t) && t.owner !== 'neutral') {
        industryDcCount += 1
      }
      if (
        (t.kind === 'solar' || t.kind === 'gas' || t.kind === 'nuclear') &&
        t.owner !== 'neutral'
      ) {
        genMw += t.mwGeneration
      }
    }
  }
  // Gross industry draw ~ DCs; on-site gen reduces *net* grid demand
  const grossMw = industryDcCount * proxy
  const gridDemandMw = Math.max(0, grossMw - genMw * 0.85)
  const over = Math.max(0, industryDcCount - soft)
  const per = ECONOMY.energyScarcityPerDc ?? 14
  const base = ECONOMY.energyBasePrice ?? 98
  const priceMult = Math.min(
    ECONOMY.energyScarcityMaxMult ?? 5.5,
    1 + (over * per) / base + Math.max(0, gridDemandMw / gridCap - 1) * 0.85,
  )
  const snapshot = {
    industryDcCount,
    gridCapMw: gridCap,
    gridDemandMw,
    priceMult,
    softCap: soft,
  }
  if (compactWorld) {
    compactGridScarcityCaches.set(compactWorld, {
      revision: compactWorld.revision,
      snapshot,
    })
  }
  return snapshot
}

/**
 * Facility opex = completed building shells + live fleet load.
 * Empty halls stay cheap; full GPU halls cost real cooling/ops cash.
 */
export function playerBuildingOpex(state: SimState): number {
  let opex = 0
  let logistics = 0
  if (usesCompactWorld(state)) {
    for (const facility of compactCompletedFacilitiesForOwner(state, state.playerLabId) ?? []) {
      const shellOpex = facility.stats?.opexPerDay ?? 0
      opex += shellOpex
      logistics += transportLogisticsOpexSurcharge(
        shellOpex,
        facilityTransportAccess(state, facility.id),
      )
    }
  } else {
    for (const t of facilityAnchorTiles(state, { ownerId: state.playerLabId })) {
      if (t.buildingProgress < t.buildingTarget) continue
      if (t.kind === 'empty' || t.kind === 'city') continue
      opex += t.opexPerDay
    }
  }
  // Live racks/GPUs drive ops beyond flat DC opex (no fleetStats — avoid map↔racks cycle)
  let liveGpus = 0
  let liveMw = 0
  for (const r of state.player.rackFleet ?? []) {
    if (r.status !== 'live' || r.count <= 0) continue
    liveGpus += r.count
    try {
      const sku = getRackSku(r.skuId)
      liveMw += sku.mw * r.count
    } catch {
      liveMw += 0.007 * r.count
    }
  }
  for (const inv of state.player.chips) {
    liveGpus += inv.count
    liveMw += inv.count * 0.006
  }
  opex += liveGpus * (ECONOMY.rackOpexPerGpuDay ?? 420)
  opex += liveMw * (ECONOMY.rackOpexPerMwDay ?? 18_000)
  return opex * (ECONOMY.facilityOpexMultiplier ?? 1) + logistics
}

export function ownerLabel(owner: TileOwner, state: SimState): string {
  if (owner === 'player') return 'You'
  if (owner === 'neutral') return 'Neutral / utility'
  const r = state.rivals.find((x) => x.id === owner)
  return r?.name ?? owner
}

export function tickMap(state: SimState): SimState {
  if (usesCompactWorld(state)) {
    const world = state.map.world!
    const batch = world.beginBatch()
    const staged = new Map<string, Facility>()
    const currentFacility = (facility: Facility) => staged.get(facility.id) ?? facility
    const stage = (facility: Facility) => {
      staged.set(facility.id, facility)
      batch.replaceFacility(facility)
    }

    for (const original of compactUnderConstructionFacilities(state) ?? []) {
      const facility = currentFacility(original)
      const progress = Math.min(
        facility.constructionTarget,
        facility.constructionProgress + facilityTransportAccess(state, facility.id),
      )
      if (progress === facility.constructionProgress) continue
      const completed = progress >= facility.constructionTarget
      stage({
        ...facility,
        constructionProgress: progress,
        data:
          completed && facility.ownerId === 'player'
            ? facilityDataPatch(facility, {
                note: `${facilityDataPatch(facility, {}).name ?? facility.kind} online.`,
              })
            : facility.data,
      })
    }

    const usedByHall = new Map<string, number>()
    for (const install of state.player.rackFleet ?? []) {
      const key = `${install.x},${install.y}`
      usedByHall.set(key, (usedByHall.get(key) ?? 0) + (install.rackUnits || 1) * install.count)
    }
    const playerDcs: Facility[] = []
    for (const facility of compactFacilitiesForOwner(state, 'player') ?? []) {
      if (isDcKind(facility.kind)) playerDcs.push(facility)
    }
    for (const original of playerDcs) {
      const facility = currentFacility(original)
      const { x, y } = tileCoords(facility.anchor, world.descriptor.width)
      const stats = facility.stats ?? {}
      const used = Math.min(stats.rackCapacity ?? 0, usedByHall.get(`${x},${y}`) ?? 0)
      if (used === (stats.racksUsed ?? 0)) continue
      stage({ ...facility, stats: { ...stats, racksUsed: used } })
    }

    const legacyUnits =
      (state.player.chips ?? []).reduce((n, chip) => n + chip.count, 0) +
      (state.player.deployedRacks ?? []).reduce((n, deployed) => {
        const design = state.player.rackDesigns.find((entry) => entry.id === deployed.designId)
        if (!design) return n
        try {
          return n + getChassis(design.chassisId).rackUnits * deployed.count
        } catch {
          return n + deployed.count
        }
      }, 0)
    if (legacyUnits > 0) {
      let remaining = legacyUnits
      const completed = playerDcs
        .map(currentFacility)
        .filter((facility) => facility.constructionProgress >= facility.constructionTarget)
        .sort(
          (a, b) =>
            (a.stats?.racksUsed ?? 0) - (b.stats?.racksUsed ?? 0) ||
            a.id.localeCompare(b.id),
        )
      for (const original of completed) {
        if (remaining <= 0) break
        const facility = currentFacility(original)
        const stats = facility.stats ?? {}
        const free = Math.max(0, (stats.rackCapacity ?? 0) - (stats.racksUsed ?? 0))
        const add = Math.min(free, remaining)
        if (add > 0) stage({ ...facility, stats: { ...stats, racksUsed: (stats.racksUsed ?? 0) + add } })
        remaining -= add
      }
    }

    const committed = commitWorldBatch(state, batch)
    const scarcity = gridScarcity(committed)
    const price = ECONOMY.energyBasePrice * scarcity.priceMult
    const wave = Math.sin(state.day / 5) * 3
    const spot = Math.max(
      ECONOMY.energyBasePrice * 0.7,
      Math.min(ECONOMY.energyBasePrice * 6, price + wave),
    )
    return {
      ...committed,
      map: { ...committed.map, energyPricePerMWh: spot },
    }
  }

  // Advance construction; rack bay usage is driven by rackFleet (per hall)
  const tiles = state.map.tiles.slice()
  for (let i = 0; i < tiles.length; i++) {
    const current = tiles[i]!
    if (
      current.buildingTarget <= 0 ||
      current.buildingProgress >= current.buildingTarget
    ) {
      continue
    }
    const tile = { ...current }
    tile.buildingProgress = Math.min(tile.buildingTarget, tile.buildingProgress + 1)
    if (tile.buildingProgress >= tile.buildingTarget && tile.owner === 'player') {
      tile.note = tile.note.includes('progress') ? `${tile.name} online.` : tile.note
    }
    tiles[i] = tile
  }

  // Spot market: refresh map energy price from shared-grid scarcity
  const scarcity = gridScarcity({ ...state, map: { ...state.map, tiles } })
  const price = ECONOMY.energyBasePrice * scarcity.priceMult

  // Per-DC racksUsed from installs (ordered + live reserve bays)
  let s: SimState = {
    ...state,
    map: { ...state.map, tiles, energyPricePerMWh: price },
  }
  for (let i = 0; i < s.map.tiles.length; i++) {
    const current = s.map.tiles[i]!
    if (!isDcKind(current.kind) || !isDcAnchor(current) || current.owner !== 'player') {
      continue
    }
    // Copy only the sparse facility records that are actually updated. The
    // previous SimState must remain immutable even though the dense array is
    // shared by reference for all untouched terrain.
    const t = { ...current }
    s.map.tiles[i] = t
    let used = 0
    for (const r of s.player.rackFleet ?? []) {
      if (r.x !== t.x || r.y !== t.y) continue
      used += (r.rackUnits || 1) * r.count
    }
    t.racksUsed = Math.min(t.rackCapacity, used)
  }

  // Legacy global chips still need bay space: fill remaining DC capacity
  const legacyUnits =
    (s.player.chips ?? []).reduce((n, c) => n + c.count, 0) +
    (s.player.deployedRacks ?? []).reduce((n, d) => {
      const design = s.player.rackDesigns.find((x) => x.id === d.designId)
      if (!design) return n
      try {
        return n + getChassis(design.chassisId).rackUnits * d.count
      } catch {
        return n + d.count
      }
    }, 0)

  if (legacyUnits > 0) {
    let remaining = legacyUnits
    const dcs = s.map.tiles
      .filter(
        (t) => t.owner === 'player' && isDcKind(t.kind) && isDcAnchor(t) && t.buildingProgress >= t.buildingTarget,
      )
      .sort((a, b) => a.racksUsed - b.racksUsed)
    for (const dc of dcs) {
      if (remaining <= 0) break
      const free = Math.max(0, dc.rackCapacity - dc.racksUsed)
      const add = Math.min(free, remaining)
      dc.racksUsed += add
      remaining -= add
    }
  }

  // Mild day-to-day noise on top of scarcity spot
  const wave = Math.sin(state.day / 5) * 3
  const spot = Math.max(
    ECONOMY.energyBasePrice * 0.7,
    Math.min(ECONOMY.energyBasePrice * 6, price + wave),
  )

  return {
    ...s,
    map: { ...s.map, tiles: s.map.tiles, energyPricePerMWh: spot },
  }
}

export function labFacilityEnergyTotals(state: SimState, labId: LabId): {
  mwInterconnect: number
  mwGeneration: number
  rackCap: number
  racksUsed: number
} {
  let base: FacilityEnergyTotals = {
    mwInterconnect: 0,
    mwGeneration: 0,
    rackCap: 0,
    racksUsed: 0,
  }
  if (usesCompactWorld(state)) {
    const world = state.map.world!
    let cache = compactFacilityEnergyCaches.get(world)
    if (!cache || cache.revision !== world.revision) {
      cache = { revision: world.revision, byLab: new Map() }
      compactFacilityEnergyCaches.set(world, cache)
    }
    const cached = cache.byLab.get(labId)
    if (cached) {
      base = cached
    } else {
      for (const facility of compactCompletedFacilitiesForOwner(state, labId) ?? []) {
        base.mwInterconnect += facility.stats?.mwCapacity ?? 0
        base.mwGeneration += facility.stats?.mwGeneration ?? 0
        base.rackCap += facility.stats?.rackCapacity ?? 0
        base.racksUsed += facility.stats?.racksUsed ?? 0
      }
      cache.byLab.set(labId, base)
    }
  } else {
    for (const tile of facilityAnchorTiles(state, { ownerId: labId })) {
      if (tile.buildingProgress < tile.buildingTarget && tile.buildingTarget > 0) continue
      base.mwInterconnect += tile.mwCapacity
      base.mwGeneration += tile.mwGeneration
      base.rackCap += tile.rackCapacity
      base.racksUsed += tile.racksUsed
    }
  }

  // Commissioned colo/owned projects are firm interconnections just like a
  // completed substation. They contain no accelerator PF and therefore only
  // extend the import ceiling here.
  const siteInterconnect = (state.siteCapacities ?? [])
    .filter(
      (capacity) =>
        capacity.labId === labId && capacity.status === 'active',
    )
    .reduce((sum, capacity) => sum + Math.max(0, capacity.firmMw), 0)
  return {
    mwInterconnect: base.mwInterconnect + siteInterconnect,
    mwGeneration: base.mwGeneration,
    rackCap: base.rackCap,
    racksUsed: base.racksUsed,
  }
}

/**
 * Player power headroom: private generation is firm; grid import is shared and
 * capped by interconnect (substation/battery mwCapacity) *and* industry congestion.
 */
export function mapEnergy(state: SimState): {
  mwAvailable: number
  mwGeneration: number
  /** Grid interconnect capacity (substations + batteries) */
  mwInterconnect: number
  /** How much grid MW we can actually import after congestion */
  mwGridImport: number
  rackCap: number
  racksUsed: number
  industryDcCount: number
  gridPriceMult: number
} {
  const { mwInterconnect, mwGeneration, rackCap, racksUsed } =
    labFacilityEnergyTotals(state, state.playerLabId)

  const scarcity = gridScarcity(state)
  // Player fleet draw proxy (tiles + fleet); computeSnapshot uses real fleet.mw later
  // but for derate we need available power vs demand — see resolvePlayerPowerMw.
  const playerDrawProxy = Math.max(
    racksUsed * 0.0075 * Math.max(1.1, state.player.pue),
    0.01,
  )
  const gridNeed = Math.max(0, playerDrawProxy - mwGeneration)
  const interconnectCap = mwInterconnect
  // Pro-rata grid when industry demand exceeds capacity
  let gridFrac = 1
  if (scarcity.gridDemandMw > scarcity.gridCapMw && scarcity.gridDemandMw > 1e-6) {
    gridFrac = scarcity.gridCapMw / scarcity.gridDemandMw
  }
  const mwGridImport = Math.min(interconnectCap, gridNeed) * gridFrac
  // Available for derate: gen is always usable; grid import only if interconnected
  const mwAvailable = mwGeneration + mwGridImport
  // Also allow interconnect to provide headroom above current draw for growth
  // (so empty halls with interconnect still show capacity)
  const mwHeadroom = mwGeneration + interconnectCap * gridFrac

  return {
    mwAvailable: Math.max(mwAvailable, Math.min(mwHeadroom, mwGeneration + interconnectCap)),
    mwGeneration,
    mwInterconnect,
    mwGridImport,
    rackCap,
    racksUsed,
    industryDcCount: scarcity.industryDcCount,
    gridPriceMult: scarcity.priceMult,
  }
}

/**
 * Authoritative available MW given actual fleet demand (PUE already applied).
 * Order: own generation → firm contracts → spot grid, all through commissioned interconnects.
 */
export function resolveLabPowerMw(
  state: SimState,
  labId: LabId,
  mwDemand: number,
): {
  mwAvailable: number
  mwGeneration: number
  mwGridImport: number
  mwInterconnect: number
  mwContractImport: number
  mwCityContractImport: number
  mwEnergyContractImport: number
  gridPriceMult: number
  industryDcCount: number
  gridCapped: boolean
} {
  const { mwInterconnect, mwGeneration } = labFacilityEnergyTotals(state, labId)
  // Firm city import contracts (must apply to available power, not just billing)
  const mwCityContractCap =
    labId === state.playerLabId
      ? (state.cityPowerContracts ?? [])
          .filter((c) => c.daysLeft > 0)
          .reduce((s, c) => s + Math.max(0, c.mw), 0)
      : 0
  const mwEnergyContractCap = energyContractCapacityMw(state, labId)

  const scarcity = gridScarcity(state)
  let gridFrac = 1
  if (scarcity.gridDemandMw > scarcity.gridCapMw && scarcity.gridDemandMw > 1e-6) {
    gridFrac = Math.max(0.15, scarcity.gridCapMw / scarcity.gridDemandMw)
  }
  const needAfterGen = Math.max(0, mwDemand - mwGeneration)
  const mwCityContractImport = Math.min(mwCityContractCap, needAfterGen, mwInterconnect)
  const needAfterCityContract = Math.max(0, needAfterGen - mwCityContractImport)
  const interconnectAfterCity = Math.max(0, mwInterconnect - mwCityContractImport)
  const mwEnergyContractImport = Math.min(
    mwEnergyContractCap,
    needAfterCityContract,
    interconnectAfterCity,
  )
  const needAfterContract = Math.max(
    0,
    needAfterCityContract - mwEnergyContractImport,
  )
  const spotInterconnectMw = Math.max(
    0,
    interconnectAfterCity - mwEnergyContractImport,
  )
  // Only the uncontracted remainder is exposed to grid curtailment.
  const mwSpotImport = Math.min(spotInterconnectMw, needAfterContract) * gridFrac
  const mwContractImport = mwCityContractImport + mwEnergyContractImport
  const mwGridImport = mwContractImport + mwSpotImport
  const mwAvailable = mwGeneration + mwGridImport
  return {
    // Floor so a powered campus never fully dies — brownouts throttle, don't blackout
    mwAvailable: Math.max(0.05, mwAvailable),
    mwGeneration,
    mwGridImport,
    mwInterconnect,
    mwContractImport,
    mwCityContractImport,
    mwEnergyContractImport,
    gridPriceMult: scarcity.priceMult,
    industryDcCount: scarcity.industryDcCount,
    gridCapped:
      gridFrac < 0.999 || needAfterContract > spotInterconnectMw + 1e-6,
  }
}

/** Player compatibility wrapper around the controller-neutral resolver. */
export function resolvePlayerPowerMw(
  state: SimState,
  mwDemand: number,
): ReturnType<typeof resolveLabPowerMw> {
  return resolveLabPowerMw(state, state.playerLabId, mwDemand)
}

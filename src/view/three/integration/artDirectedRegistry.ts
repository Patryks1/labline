import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { MapTile } from '../../../sim/types'
import { createBuildingKit, type KitDetail } from '../buildingKits'
import type { Neighbors } from '../tileNeighbors'
import {
  MUNICIPAL_POWER_BY_KIND,
  type MunicipalCampusDescriptor,
  type MunicipalStructureDescriptor,
} from '../assets/municipalPowerLayouts'
import {
  ArchetypeRegistry,
  DefaultArchetype,
  LodTier,
  type ArchetypeDefinition,
} from '../v2'

type Rgb = readonly [number, number, number]

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}

const WHITE_HEX = 0xffffff
const WHITE: Rgb = [1, 1, 1]
const LIGHT_METAL: Rgb = [0.78, 0.86, 0.9]
const DARK_METAL: Rgb = [0.42, 0.5, 0.56]
const GLASS: Rgb = [0.55, 0.72, 0.82]
const ROOF: Rgb = [0.62, 0.68, 0.72]
const FOLIAGE: Rgb = [1, 1, 1]
const FOLIAGE_DARK: Rgb = [0.62, 0.78, 0.62]
const TRUNK: Rgb = [0.58, 0.38, 0.22]

export const IntegrationArchetype = {
  headquarters: 110,
  solar: 111,
  grid: 112,
  generation: 113,
  fabrication: 114,
  campusSupport: 115,
} as const

/** Facility IDs intentionally remain one-to-one with simulation kinds. */
export const FacilityArchetype = {
  gas: 116,
  battery: 117,
  office: 118,
  headquartersSmall: 119,
  headquartersMedium: 120,
  lab: 121,
} as const

/** Deterministic scenery variants keep dense regions from looking stamped. */
export const SceneryArchetype = {
  forestBroadleaf: 200,
  forestMixed: 201,
  houseDuplex: 202,
  houseTerrace: 203,
  cityDistrictC: 204,
  cityDistrictD: 205,
  warehouseContainers: 206,
  park: 207,
  lakeEdge: 208,
  lakeInterior: 209,
  roadLamp: 210,
  houseCourtyard: 211,
  houseGarden: 212,
  houseTownhome: 213,
  houseStilt: 214,
  houseRow: 215,
  houseCorner: 216,
  cityPodium: 217,
  cityArcade: 218,
  cityCivicHall: 219,
  cityLibrary: 220,
  cityMarket: 221,
  cityHotel: 222,
  cityTransitHub: 223,
  warehouseSawtooth: 224,
  warehouseColdStore: 225,
  warehouseDepot: 226,
  warehouseSilos: 227,
  warehouseFreight: 228,
  forestConiferTall: 229,
  forestAspen: 230,
  forestOak: 231,
  forestScrub: 232,
  forestDeadwood: 233,
  forestRocky: 234,
  groundScrub: 235,
  groundRock: 236,
  groundLog: 237,
  hillMound: 238,
} as const

/**
 * Stable IDs exported by the committed World V4 asset manifest. Keeping the
 * renderer projection on these IDs means an authored bundle can replace each
 * silhouette independently; their procedural definitions deliberately share
 * family geometry so loading failures and the pre-load frame remain batched.
 */
export const AuthoredSceneryArchetype = {
  grassTufts: 400,
  meadowFlowers: 401,
  dryScrub: 402,
  fernCluster: 403,
  pebbleGroup: 404,
  graniteOutcrop: 405,
  sandstoneOutcrop: 406,
  fallenPine: 407,
  fallenBirch: 408,
  shoreReeds: 409,
  cattailClump: 410,
  mushroomRing: 411,
  wildGrass: 412,
  hillBoulders: 413,
  scotsPine: 414,
  spruceTall: 415,
  firYoung: 416,
  cedarWide: 417,
  birchWhite: 418,
  aspenColumn: 419,
  mapleRed: 420,
  beechRound: 421,
  willowDroop: 422,
  poplarTall: 423,
  deadPine: 424,
  deadOak: 425,
  hawthornShrub: 426,
  floweringShrub: 427,
  juniperScrub: 428,
  mixedGrove: 429,
  pineGrove: 430,
  birchGrove: 431,
  houseDuplex: 432,
  houseTerrace: 433,
  houseTownhome: 434,
  houseRow: 435,
  houseCourtyard: 436,
  houseGarden: 437,
  houseStilt: 438,
  houseCorner: 439,
  houseCottage: 440,
  houseModern: 441,
  apartmentWalkup: 442,
  apartmentBrick: 443,
  apartmentCourtyard: 444,
  officeGlass: 445,
  officeStepped: 446,
  mixedUsePodium: 447,
  mixedUseCorner: 448,
  civicHall: 449,
  publicLibrary: 450,
  coveredMarket: 451,
  cityHotel: 452,
  shoppingArcade: 453,
  transitHub: 454,
  clockTower: 455,
  hospitalBlock: 456,
  universityHall: 457,
  broadcastTower: 458,
  warehouseSawtooth: 459,
  warehouseColdStore: 460,
  warehouseDepot: 461,
  warehouseFreight: 462,
  containerYard: 463,
  grainSilos: 464,
  tankYard: 465,
  lightIndustry: 466,
  railTerminal: 467,
  trainingCentre: 468,
  networkOperations: 469,
  constructionShell: 470,
  utilityPlant: 471,
  securityCentre: 472,
} as const

/** Stable authored road furniture IDs within the fixed 128-model catalog. */
export const RoadPropArchetype = {
  trafficLight: 490,
  pedestrianSignal: 491,
  roadSign: 492,
  highwayGuardrail: 497,
} as const

export const MunicipalPowerArchetype = {
  coal: MUNICIPAL_POWER_BY_KIND.coal.archetypeId,
  wind: MUNICIPAL_POWER_BY_KIND.wind.archetypeId,
  solar: MUNICIPAL_POWER_BY_KIND.solar.archetypeId,
  nuclear: MUNICIPAL_POWER_BY_KIND.nuclear.archetypeId,
} as const

/**
 * Stable, parcel-renderer-facing IDs for the deterministic one-building kits.
 * These live above the authored World V4 catalog (which ends at 499), so the
 * IDs can be persisted without colliding with streamed scenery assets.
 */
export const SingleBuildingArchetype = {
  detachedHouse: 500,
  smallShop: 501,
  rowhouse: 502,
  midRise: 503,
  officeTower: 504,
  skyscraper: 505,
} as const

export type SingleBuildingStyle = keyof typeof SingleBuildingArchetype
export type ParcelSpan = readonly [width: 1 | 2, depth: 1 | 2]

export interface SingleBuildingProfile {
  readonly id: (typeof SingleBuildingArchetype)[SingleBuildingStyle]
  /** Main building footprint inside the normalized one-tile lot. */
  readonly footprint: readonly [width: number, depth: number]
  readonly height: number
  readonly parcelSpans: readonly ParcelSpan[]
}

export const SINGLE_BUILDING_PROFILES: Readonly<Record<SingleBuildingStyle, SingleBuildingProfile>> = {
  detachedHouse: { id: 500, footprint: [0.52, 0.46], height: 0.53, parcelSpans: [[1, 1]] },
  smallShop: { id: 501, footprint: [0.68, 0.54], height: 0.41, parcelSpans: [[1, 1]] },
  rowhouse: { id: 502, footprint: [0.76, 0.48], height: 0.73, parcelSpans: [[1, 1]] },
  midRise: { id: 503, footprint: [0.68, 0.62], height: 1.12, parcelSpans: [[1, 1]] },
  officeTower: { id: 504, footprint: [0.62, 0.58], height: 1.61, parcelSpans: [[1, 1]] },
  skyscraper: {
    id: 505,
    footprint: [0.58, 0.54],
    height: 2.49,
    parcelSpans: [[1, 1], [2, 1], [1, 2], [2, 2]],
  },
} as const

export const SINGLE_BUILDING_ARCHETYPES = [
  SingleBuildingArchetype.detachedHouse,
  SingleBuildingArchetype.smallShop,
  SingleBuildingArchetype.rowhouse,
  SingleBuildingArchetype.midRise,
  SingleBuildingArchetype.officeTower,
  SingleBuildingArchetype.skyscraper,
] as const

export const AUTHORED_TERRAIN_ARCHETYPES = [
  SceneryArchetype.groundRock,
  SceneryArchetype.groundLog,
  ...range(400, 413),
] as const

export const AUTHORED_VEGETATION_ARCHETYPES = [
  DefaultArchetype.tree,
  SceneryArchetype.forestOak,
  ...range(414, 431),
] as const

export const AUTHORED_RESIDENTIAL_ARCHETYPES = [DefaultArchetype.house, ...range(432, 444)] as const
export const AUTHORED_URBAN_ARCHETYPES = [DefaultArchetype.cityTowerA, DefaultArchetype.cityTowerB, ...range(445, 458)] as const
export const AUTHORED_INDUSTRIAL_ARCHETYPES = [DefaultArchetype.warehouse, ...range(459, 467)] as const

/** World V4 additions, excluding the original one-house/two-tower catalog. */
export const ADDITIONAL_RESIDENTIAL_ARCHETYPES = range(432, 444) as readonly number[]
export const ADDITIONAL_URBAN_ARCHETYPES = range(445, 458) as readonly number[]

/**
 * Shared, close-up-readable archetypes. Near tiers use compound silhouettes
 * with baked brightness detail; instance color still supplies player/rival or
 * scenery tint. Mid/far remain intentionally cheap.
 */
export function createArtDirectedArchetypeRegistry(): ArchetypeRegistry {
  const registry = new ArchetypeRegistry()
  const nearMaterial = createTierMaterial(LodTier.near)
  const midMaterial = createTierMaterial(LodTier.mid)
  const farMaterial = createTierMaterial(LodTier.far)
  const materials = {
    near: nearMaterial,
    mid: midMaterial,
    far: farMaterial,
  } satisfies Record<LodTier, THREE.Material>

  const treePine = bakeLegacyKit('forest', 0.48, 0x2d6a3a, 2, 7, { stripBase: true })
  const treeBroadleaf = bakeLegacyKit('forest', 0.48, 0x3d7a42, 13, 5, { stripBase: true })
  const treeMixed = bakeLegacyKit('forest', 0.48, 0x357344, 29, 17, { stripBase: true })
  const warehouse = bakeLegacyKit('warehouse', 0.42, 0x6a7080, 7, 3, { stripBase: true })
  const warehouseContainers = bakeLegacyKit('warehouse', 0.42, 0x756b61, 17, 19, { stripBase: true })
  // At map scale, variants share family silhouettes. InstancedChunk can batch
  // records by this shared geometry/material identity, reducing far draw calls
  // without removing any building.
  const forestFar = treeFar(0)
  const industrialFar = warehouseFar(0)

  const singleBuildings = Object.entries(SingleBuildingArchetype) as Array<
    [SingleBuildingStyle, (typeof SingleBuildingArchetype)[SingleBuildingStyle]]
  >
  const singleBuildingGeometry = new Map<SingleBuildingStyle, Record<LodTier, THREE.BufferGeometry>>()
  for (const [style, id] of singleBuildings) {
    const geometry = {
      near: createSingleBuildingGeometry(style, LodTier.near),
      mid: createSingleBuildingGeometry(style, LodTier.mid),
      far: createSingleBuildingGeometry(style, LodTier.far),
    }
    singleBuildingGeometry.set(style, geometry)
    register(registry, materials, id, `single-building-${kebabCase(style)}`, geometry.near, geometry.mid, geometry.far)
  }

  const detached = singleBuildingGeometry.get('detachedHouse')!
  const rowhouse = singleBuildingGeometry.get('rowhouse')!
  const midRise = singleBuildingGeometry.get('midRise')!
  const officeTower = singleBuildingGeometry.get('officeTower')!
  const skyscraper = singleBuildingGeometry.get('skyscraper')!

  register(registry, materials, DefaultArchetype.tree, 'forest-pine', treePine, treePine, forestFar)
  register(registry, materials, SceneryArchetype.forestBroadleaf, 'forest-broadleaf', treeBroadleaf, treeBroadleaf, forestFar)
  register(registry, materials, SceneryArchetype.forestMixed, 'forest-mixed', treeMixed, treeMixed, forestFar)
  const forestBiomes = [
    [SceneryArchetype.forestConiferTall, 'forest-conifer-tall', forestBiomeGeometry('conifer')],
    [SceneryArchetype.forestAspen, 'forest-aspen', forestBiomeGeometry('aspen')],
    [SceneryArchetype.forestOak, 'forest-oak', forestBiomeGeometry('oak')],
    [SceneryArchetype.forestScrub, 'forest-scrub', forestBiomeGeometry('scrub')],
    [SceneryArchetype.forestDeadwood, 'forest-deadwood', forestBiomeGeometry('deadwood')],
    [SceneryArchetype.forestRocky, 'forest-rocky', forestBiomeGeometry('rocky')],
  ] as const
  for (const [id, name, geometry] of forestBiomes) {
    register(registry, materials, id, name, geometry, geometry, forestFar)
  }

  const scrub = groundScrubGeometry()
  const rock = groundRockGeometry()
  const log = groundLogGeometry()
  const mound = hillMoundGeometry()
  const groundFar = groundRockGeometry()
  register(registry, materials, SceneryArchetype.groundScrub, 'ground-scrub', scrub, scrub, groundFar)
  register(registry, materials, SceneryArchetype.groundRock, 'ground-rock', rock, rock, groundFar)
  register(registry, materials, SceneryArchetype.groundLog, 'ground-log', log, log, groundFar)
  register(registry, materials, SceneryArchetype.hillMound, 'hill-mound', mound, mound, groundFar)
  register(registry, materials, DefaultArchetype.house, 'house-single', detached.near, detached.mid, detached.far)
  register(registry, materials, SceneryArchetype.houseDuplex, 'house-duplex', rowhouse.near, rowhouse.mid, rowhouse.far)
  register(registry, materials, SceneryArchetype.houseTerrace, 'house-terrace', rowhouse.near, rowhouse.mid, rowhouse.far)
  register(
    registry,
    materials,
    DefaultArchetype.cityTowerA,
    'city-district-a',
    midRise.near,
    midRise.mid,
    midRise.far,
  )
  register(
    registry,
    materials,
    DefaultArchetype.cityTowerB,
    'city-district-b',
    officeTower.near,
    officeTower.mid,
    officeTower.far,
  )
  register(registry, materials, SceneryArchetype.cityDistrictC, 'city-district-c', skyscraper.near, skyscraper.mid, skyscraper.far)
  register(registry, materials, SceneryArchetype.cityDistrictD, 'city-district-d', midRise.near, midRise.mid, midRise.far)
  register(
    registry,
    materials,
    DefaultArchetype.warehouse,
    'warehouse',
    warehouse,
    warehouse,
    industrialFar,
  )
  register(registry, materials, SceneryArchetype.warehouseContainers, 'warehouse-containers', warehouseContainers, warehouseContainers, industrialFar)

  // Compatibility IDs now resolve to coherent single-building silhouettes.
  // The stable 500-series IDs above are the preferred API for new renderers.
  const residentialKits = [
    [SceneryArchetype.houseCourtyard, 'house-courtyard', 37, 41],
    [SceneryArchetype.houseGarden, 'house-garden', 43, 47],
    [SceneryArchetype.houseTownhome, 'house-townhome', 53, 59],
    [SceneryArchetype.houseStilt, 'house-stilt', 61, 67],
    [SceneryArchetype.houseRow, 'house-row', 71, 73],
    [SceneryArchetype.houseCorner, 'house-corner', 79, 83],
  ] as const
  for (const [id, name, seedA] of residentialKits) {
    const geometry = seedA % 2 === 0 ? detached : rowhouse
    register(registry, materials, id, name, geometry.near, geometry.mid, geometry.far)
  }

  const urbanKits = [
    [SceneryArchetype.cityPodium, 'city-podium', 'podium'] as const,
    [SceneryArchetype.cityArcade, 'city-arcade', 'arcade'] as const,
    [SceneryArchetype.cityCivicHall, 'city-civic-hall', 'civicHall'] as const,
    [SceneryArchetype.cityLibrary, 'city-library', 'library'] as const,
    [SceneryArchetype.cityMarket, 'city-market', 'market'] as const,
    [SceneryArchetype.cityHotel, 'city-hotel', 'hotel'] as const,
    [SceneryArchetype.cityTransitHub, 'city-transit-hub', 'transitHub'] as const,
  ]
  const urbanFar = {
    podium: officeTower.far,
    arcade: midRise.far,
    civicHall: midRise.far,
    library: midRise.far,
    market: midRise.far,
    hotel: officeTower.far,
    transitHub: skyscraper.far,
  } as const
  for (const [id, name, style] of urbanKits) {
    register(
      registry,
      materials,
      id,
      name,
      createDistrictBuildingGeometry(style, LodTier.near),
      createDistrictBuildingGeometry(style, LodTier.mid),
      urbanFar[style],
    )
  }

  const logisticsKits = [
    [SceneryArchetype.warehouseSawtooth, 'warehouse-sawtooth', 23, 31],
    [SceneryArchetype.warehouseColdStore, 'warehouse-cold-store', 37, 43],
    [SceneryArchetype.warehouseDepot, 'warehouse-depot', 47, 59],
    [SceneryArchetype.warehouseSilos, 'warehouse-silos', 61, 73],
    [SceneryArchetype.warehouseFreight, 'warehouse-freight', 79, 89],
  ] as const
  for (const [id, name, seedA, seedB] of logisticsKits) {
    const geometry = bakeLegacyKit('warehouse', 0.42, 0x6f747d, seedA, seedB, { stripBase: true })
    register(registry, materials, id, name, geometry, geometry, industrialFar)
  }

  const park = bakeLegacyKit('park', 0.22, 0x3d7a42, 7, 11, { stripBase: true })
  const lakeEdge = bakeLegacyKit('lake', 0.14, 0x1a7aad, 5, 13, {
    stripBase: true,
    skipWater: true,
    neighbors: { n: false, e: true, s: true, w: true, mask: 14, count: 3 },
  })
  const lakeInterior = bakeLegacyKit('lake', 0.14, 0x0f4e6e, 1, 7, {
    stripBase: true,
    skipWater: true,
    neighbors: { n: true, e: true, s: true, w: true, mask: 15, count: 4 },
  })
  const roadLamp = roadLampNear()
  register(registry, materials, SceneryArchetype.park, 'park-details', park, park, parkFar())
  register(registry, materials, SceneryArchetype.lakeEdge, 'lake-edge-details', lakeEdge, lakeEdge, lakeFar(false))
  register(registry, materials, SceneryArchetype.lakeInterior, 'lake-interior-details', lakeInterior, lakeInterior, lakeFar(true))
  register(registry, materials, SceneryArchetype.roadLamp, 'road-lamp', roadLamp, roadLamp, roadLampFar())

  const dcSmall = bakeLegacyKit('dc', 0.8, WHITE_HEX, 0, 0, { ownerTinted: true })
  const dcMedium = bakeLegacyKit('dc_m', 0.9, WHITE_HEX, 0, 0, { ownerTinted: true })
  const dcLarge = bakeLegacyKit('dc_l', 1, WHITE_HEX, 0, 0, { ownerTinted: true })
  register(
    registry,
    materials,
    DefaultArchetype.facilitySmall,
    'facility-small',
    dcSmall,
    dcSmall,
    facilityFar('dc'),
  )
  register(
    registry,
    materials,
    DefaultArchetype.facilityMedium,
    'facility-medium',
    dcMedium,
    dcMedium,
    facilityFar('dc_m'),
  )
  register(
    registry,
    materials,
    DefaultArchetype.facilityLarge,
    'facility-large',
    dcLarge,
    dcLarge,
    facilityFar('dc_l'),
  )

  const hqLarge = bakeLegacyKit('hq_l', 0.72, WHITE_HEX, 0, 0, { ownerTinted: true })
  const solar = bakeLegacyKit('solar', 0.24, WHITE_HEX, 0, 0, { ownerTinted: true })
  const substation = bakeLegacyKit('substation', 0.4, WHITE_HEX, 0, 0, { ownerTinted: true })
  const nuclear = bakeLegacyKit('nuclear', 0.58, WHITE_HEX, 0, 0, { ownerTinted: true })
  const fabrication = bakeLegacyKit('fab', 0.58, WHITE_HEX, 0, 0, { ownerTinted: true })
  const cooling = bakeLegacyKit('cooling', 0.42, WHITE_HEX, 0, 0, { ownerTinted: true })
  register(
    registry,
    materials,
    IntegrationArchetype.headquarters,
    'headquarters',
    hqLarge,
    hqLarge,
    facilityFar('hq_l'),
  )
  register(
    registry,
    materials,
    IntegrationArchetype.solar,
    'solar-field',
    solar,
    solar,
    facilityFar('solar'),
  )
  register(
    registry,
    materials,
    IntegrationArchetype.grid,
    'grid-infrastructure',
    substation,
    substation,
    facilityFar('substation'),
  )
  register(
    registry,
    materials,
    IntegrationArchetype.generation,
    'power-generation',
    nuclear,
    nuclear,
    facilityFar('nuclear'),
  )
  register(
    registry,
    materials,
    IntegrationArchetype.fabrication,
    'chip-fabrication',
    fabrication,
    fabrication,
    facilityFar('fab'),
  )
  register(
    registry,
    materials,
    IntegrationArchetype.campusSupport,
    'campus-support',
    cooling,
    cooling,
    facilityFar('cooling'),
  )

  const distinctFacilities: readonly [number, string, MapTile['kind'], number][] = [
    [FacilityArchetype.gas, 'gas-generation', 'gas', 0.4],
    [FacilityArchetype.battery, 'battery-yard', 'battery', 0.32],
    [FacilityArchetype.office, 'office', 'office', 0.5],
    [FacilityArchetype.headquartersSmall, 'headquarters-small', 'hq', 0.5],
    [FacilityArchetype.headquartersMedium, 'headquarters-medium', 'hq_m', 0.58],
    [FacilityArchetype.lab, 'research-lab', 'lab', 0.45],
  ]
  for (const [id, name, kind, height] of distinctFacilities) {
    const detailed = bakeLegacyKit(kind, height, WHITE_HEX, 0, 0, { ownerTinted: true })
    register(registry, materials, id, name, detailed, detailed, facilityFar(kind))
  }
  for (const campus of Object.values(MUNICIPAL_POWER_BY_KIND)) {
    register(
      registry,
      materials,
      campus.archetypeId,
      campus.key,
      municipalCampusGeometry(campus, LodTier.near),
      municipalCampusGeometry(campus, LodTier.mid),
      municipalCampusGeometry(campus, LodTier.far),
    )
  }
  registerWorldCatalogFallbacks(registry)
  return registry
}

function municipalCampusGeometry(campus: MunicipalCampusDescriptor, tier: LodTier): THREE.BufferGeometry {
  const parts = campus.structures.flatMap(structure => municipalStructureGeometry(structure, tier))
  const geometry = compound(parts)
  geometry.userData.municipalCampus = {
    kind: campus.kind,
    footprint: [2, 2],
    solarClusterMerged: campus.kind === 'solar',
  }
  return geometry
}

function municipalStructureGeometry(
  structure: MunicipalStructureDescriptor,
  tier: LodTier,
): THREE.BufferGeometry[] {
  const [x, y, z] = structure.position
  const [sx, sy, sz] = structure.scale
  const color = hexRgb(structure.color)
  const segments = tier === LodTier.near ? 16 : tier === LodTier.mid ? 10 : 7
  if (structure.shape === 'box') return [box(sx, sy, sz, x, y, z, color)]
  if (structure.shape === 'cylinder') return [cylinder(sx, sx * 0.84, sy, segments, x, y, z, color)]
  if (structure.shape === 'sphere') {
    const geometry = paint(new THREE.IcosahedronGeometry(0.5, tier === LodTier.near ? 1 : 0), color)
    geometry.scale(sx * 2, sy * 2, sz * 2)
    geometry.translate(x, y, z)
    return [geometry]
  }
  if (structure.shape === 'coolingTower') {
    const parts = [cylinder(sx * 0.72, sx, sy, segments, x, y, z, color)]
    if (tier === LodTier.near) parts.push(cylinder(sx, sx * 0.72, sy * 0.3, segments, x, y + sy * 0.36, z, color))
    return parts
  }
  const rows = tier === LodTier.near ? 4 : tier === LodTier.mid ? 3 : 2
  const columns = rows
  const panels: THREE.BufferGeometry[] = []
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const panel = box(
      sx / columns * 0.82, 0.025, sz / rows * 0.62,
      x + (column - (columns - 1) / 2) * sx / columns,
      y,
      z + (row - (rows - 1) / 2) * sz / rows,
      color,
    )
    panel.rotateX(-0.24)
    panels.push(panel)
  }
  return panels
}

function hexRgb(hex: number): Rgb {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]
}

function registerWorldCatalogFallbacks(registry: ArchetypeRegistry): void {
  const aliases: Array<readonly [number, number]> = []
  const add = (ids: readonly number[], fallbacks: readonly number[]) => {
    for (let index = 0; index < ids.length; index++) {
      aliases.push([ids[index]!, fallbacks[index % fallbacks.length]!])
    }
  }

  add(range(400, 413), [
    SceneryArchetype.groundScrub,
    SceneryArchetype.groundRock,
    SceneryArchetype.groundLog,
  ])
  add(range(414, 431), [
    DefaultArchetype.tree,
    SceneryArchetype.forestBroadleaf,
    SceneryArchetype.forestMixed,
    SceneryArchetype.forestConiferTall,
    SceneryArchetype.forestAspen,
    SceneryArchetype.forestOak,
    SceneryArchetype.forestScrub,
    SceneryArchetype.forestDeadwood,
  ])
  add(range(432, 444), [
    SceneryArchetype.houseDuplex,
    SceneryArchetype.houseTerrace,
    SceneryArchetype.houseTownhome,
    SceneryArchetype.houseRow,
    SceneryArchetype.houseCourtyard,
    SceneryArchetype.houseGarden,
    SceneryArchetype.houseStilt,
    SceneryArchetype.houseCorner,
    DefaultArchetype.house,
  ])
  add(range(445, 458), [
    DefaultArchetype.cityTowerA,
    DefaultArchetype.cityTowerB,
    SceneryArchetype.cityPodium,
    SceneryArchetype.cityArcade,
    SceneryArchetype.cityCivicHall,
    SceneryArchetype.cityLibrary,
    SceneryArchetype.cityMarket,
    SceneryArchetype.cityHotel,
    SceneryArchetype.cityTransitHub,
  ])
  add(range(459, 467), [
    SceneryArchetype.warehouseSawtooth,
    SceneryArchetype.warehouseColdStore,
    SceneryArchetype.warehouseDepot,
    SceneryArchetype.warehouseFreight,
    SceneryArchetype.warehouseContainers,
    SceneryArchetype.warehouseSilos,
    DefaultArchetype.warehouse,
  ])
  aliases.push(
    [AuthoredSceneryArchetype.trainingCentre, FacilityArchetype.lab],
    [AuthoredSceneryArchetype.networkOperations, IntegrationArchetype.grid],
    [AuthoredSceneryArchetype.constructionShell, DefaultArchetype.facilitySmall],
    [AuthoredSceneryArchetype.utilityPlant, IntegrationArchetype.campusSupport],
    [AuthoredSceneryArchetype.securityCentre, FacilityArchetype.office],
  )
  add([300, ...range(473, 483)], [DefaultArchetype.warehouse])
  add([301, ...range(484, 487)], [SceneryArchetype.lakeInterior])
  add([302, ...range(488, 489)], [DefaultArchetype.tree])
  // Prop catalog entries are streamed after the first render.  Their fallback
  // must preserve the semantic footprint of roadside furniture: using the
  // full park kit here made traffic lights, signs and guardrails appear as a
  // cluster of trees and benches directly on the road until the props bundle
  // arrived (and permanently when that bundle failed).
  add([303, ...range(490, 498)], [SceneryArchetype.roadLamp])

  for (const [id, fallbackId] of aliases) {
    if (registry.has(id)) continue
    const fallback = registry.get(fallbackId)
    registry.register({
      id,
      name: `world-v4-${id}`,
      geometry: fallback.geometry,
      material: fallback.material,
    })
  }
}

function register(
  registry: ArchetypeRegistry,
  materials: Readonly<Record<LodTier, THREE.Material>>,
  id: number,
  name: string,
  near: THREE.BufferGeometry,
  mid: THREE.BufferGeometry,
  far: THREE.BufferGeometry | null,
): void {
  const definition: ArchetypeDefinition = {
    id,
    name,
    geometry: { near, mid, far },
    material: {
      near: materials.near,
      mid: materials.mid,
      far: far ? materials.far : null,
    },
  }
  registry.register(definition)
}

function createTierMaterial(tier: LodTier): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    name: `art-directed-${tier}-instance-material`,
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.58,
    metalness: 0.22,
    flatShading: false,
    fog: true,
    transparent: false,
    depthWrite: true,
    // Three's display-space color dithering crawls across moving geometry.
    dithering: false,
  })
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float ownerMix;')
      .replace(
        '#include <color_vertex>',
        `#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
  vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR_ALPHA
  vColor *= color;
#elif defined( USE_COLOR )
  vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, ownerMix);
#endif
#ifdef USE_BATCHING_COLOR
  vColor *= getBatchingColor( getIndirectIndex( gl_DrawID ) );
#endif`,
      )
  }
  material.customProgramCacheKey = () => `labline-art-directed-owner-mask-v2-${tier}`
  return material
}

interface LegacyBakeOptions {
  readonly ownerTinted?: boolean
  readonly stripBase?: boolean
  readonly skipWater?: boolean
  readonly skipTraffic?: boolean
  readonly neighbors?: Neighbors
  readonly detail?: KitDetail
}

const NO_NEIGHBORS: Neighbors = {
  n: false,
  e: false,
  s: false,
  w: false,
  mask: 0,
  count: 0,
}

/**
 * Compile the preserved procedural kit once into one indexed-instancing-ready
 * archetype. Geometry detail is retained, while the original material roles
 * are encoded into vertex color plus an owner-tint mask.
 */
function bakeLegacyKit(
  kind: MapTile['kind'],
  height: number,
  color: number,
  seedX: number,
  seedY: number,
  options: LegacyBakeOptions = {},
): THREE.BufferGeometry {
  const group = createBuildingKit(
    kind,
    color,
    height,
    seedX,
    seedY,
    options.neighbors ?? NO_NEIGHBORS,
    options.detail ?? 'full',
  )
  group.updateMatrixWorld(true)
  const parts: THREE.BufferGeometry[] = []
  const sourceGeometries = new Set<THREE.BufferGeometry>()
  const sourceMaterials = new Set<THREE.Material>()
  const size = new THREE.Vector3()
  const worldPosition = new THREE.Vector3()

  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    const source = object.geometry
    const material = Array.isArray(object.material) ? object.material[0] : object.material
    if (!source || !material) return
    sourceGeometries.add(source)
    for (const entry of Array.isArray(object.material) ? object.material : [object.material]) {
      sourceMaterials.add(entry)
    }
    if (options.skipTraffic && object.userData.traffic) return
    if (options.skipWater && object.userData.water) return

    source.computeBoundingBox()
    source.boundingBox?.getSize(size)
    worldPosition.setFromMatrixPosition(object.matrixWorld)
    if (
      options.stripBase &&
      size.x > 0.82 &&
      size.z > 0.82 &&
      size.y <= 0.09 &&
      worldPosition.y <= 0.075
    ) {
      return
    }

    const geometry = source.index ? source.toNonIndexed() : source.clone()
    for (const attribute of Object.keys(geometry.attributes)) {
      if (attribute !== 'position' && attribute !== 'normal') geometry.deleteAttribute(attribute)
    }
    geometry.applyMatrix4(object.matrixWorld)
    const count = geometry.getAttribute('position').count
    const colors = new Float32Array(count * 3)
    const ownerMix = new Float32Array(count)
    const materialWithColor = material as THREE.Material & {
      color?: THREE.Color
      emissive?: THREE.Color
      emissiveIntensity?: number
    }
    const baked = materialWithColor.color?.clone() ?? new THREE.Color(WHITE_HEX)
    const isBrand = Boolean(object.userData.brand || material.userData.brand)
    const shellBase = object.userData.shellBase ?? material.userData.shellBase
    const isLocked = Boolean(object.userData.lockColor || material.userData.lockColor)
    let mix = 0
    if (options.ownerTinted) {
      if (isBrand) {
        baked.setHex(WHITE_HEX)
        mix = 1
      } else if (typeof shellBase === 'number') {
        baked.setHex(shellBase)
        mix = 0.24
      } else if (isLocked) {
        const ownerDrivenGlow = materialWithColor.emissive?.getHex() === WHITE_HEX
        mix = ownerDrivenGlow ? 0.2 : 0
      } else {
        mix = 1
      }
    }
    if (!isBrand && materialWithColor.emissive && (materialWithColor.emissiveIntensity ?? 0) > 0) {
      const strength = Math.min(0.32, (materialWithColor.emissiveIntensity ?? 0) * 0.24)
      baked.r = Math.min(1, baked.r + materialWithColor.emissive.r * strength)
      baked.g = Math.min(1, baked.g + materialWithColor.emissive.g * strength)
      baked.b = Math.min(1, baked.b + materialWithColor.emissive.b * strength)
    }
    for (let index = 0; index < count; index++) {
      colors[index * 3] = baked.r
      colors[index * 3 + 1] = baked.g
      colors[index * 3 + 2] = baked.b
      ownerMix[index] = mix
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geometry.setAttribute('ownerMix', new THREE.BufferAttribute(ownerMix, 1))
    parts.push(geometry)
  })

  for (const geometry of sourceGeometries) {
    if (!geometry.userData.shared) geometry.dispose()
  }
  for (const material of sourceMaterials) material.dispose()
  group.clear()
  if (parts.length === 0) throw new Error(`Legacy ${kind} kit produced no bakeable geometry`)
  return compound(parts)
}

function facilityFar(kind: MapTile['kind']): THREE.BufferGeometry {
  switch (kind) {
    case 'dc':
      return compound([
        box(0.76, 0.5, 0.52, 0, 0.25, 0, LIGHT_METAL),
        box(0.5, 0.08, 0.32, 0, 0.54, 0, DARK_METAL),
      ])
    case 'dc_m':
      return compound([
        box(0.4, 0.68, 0.78, -0.22, 0.34, 0, LIGHT_METAL),
        box(0.4, 0.58, 0.78, 0.22, 0.29, 0, LIGHT_METAL),
      ])
    case 'dc_l':
      return compound([
        box(0.9, 0.76, 0.58, -0.04, 0.38, -0.08, LIGHT_METAL),
        box(0.3, 1.12, 0.3, 0.28, 0.56, 0.2, DARK_METAL),
      ])
    case 'substation':
      return compound([
        box(0.82, 0.09, 0.76, 0, 0.045, 0, DARK_METAL),
        cylinder(0.035, 0.045, 0.62, 5, -0.24, 0.36, 0, LIGHT_METAL),
        cylinder(0.035, 0.045, 0.7, 5, 0, 0.4, 0, LIGHT_METAL),
        cylinder(0.035, 0.045, 0.78, 5, 0.24, 0.44, 0, LIGHT_METAL),
      ])
    case 'solar': {
      const panel = paint(new THREE.BoxGeometry(0.84, 0.055, 0.72), GLASS)
      panel.rotateX(-0.34)
      panel.translate(0, 0.18, 0)
      return compound([box(0.92, 0.05, 0.84, 0, 0.025, 0, DARK_METAL), panel])
    }
    case 'gas':
      return compound([
        cylinder(0.3, 0.32, 0.72, 8, 0, 0.36, 0, LIGHT_METAL),
        cylinder(0.035, 0.045, 0.72, 5, 0.3, 0.36, -0.28, DARK_METAL),
      ])
    case 'nuclear':
      return compound([
        cylinder(0.3, 0.34, 0.72, 8, 0.14, 0.36, 0.12, LIGHT_METAL),
        cone(0.3, 0.22, 8, 0.14, 0.83, 0.12, WHITE),
        cylinder(0.1, 0.17, 0.7, 7, -0.3, 0.35, -0.26, WHITE),
        cylinder(0.1, 0.17, 0.7, 7, -0.08, 0.35, -0.26, WHITE),
      ])
    case 'fab':
      return compound([
        box(0.96, 0.46, 0.82, 0, 0.23, 0, LIGHT_METAL),
        box(0.58, 0.32, 0.58, 0, 0.62, 0, GLASS),
      ])
    case 'cooling':
      return compound([
        cylinder(0.11, 0.16, 0.64, 7, -0.28, 0.32, 0, LIGHT_METAL),
        cylinder(0.11, 0.16, 0.64, 7, 0, 0.32, 0, LIGHT_METAL),
        cylinder(0.11, 0.16, 0.64, 7, 0.28, 0.32, 0, LIGHT_METAL),
      ])
    case 'battery':
      return compound([
        box(0.24, 0.34, 0.7, -0.28, 0.17, 0, LIGHT_METAL),
        box(0.24, 0.34, 0.7, 0, 0.17, 0, LIGHT_METAL),
        box(0.24, 0.34, 0.7, 0.28, 0.17, 0, LIGHT_METAL),
      ])
    case 'office':
      return compound([
        box(0.62, 0.88, 0.5, 0, 0.44, 0, LIGHT_METAL),
        box(0.5, 0.12, 0.03, 0, 0.5, 0.26, GLASS),
      ])
    case 'hq':
      return compound([
        box(0.62, 0.88, 0.5, 0, 0.44, 0, LIGHT_METAL),
        box(0.5, 0.12, 0.03, 0, 0.5, 0.26, GLASS),
      ])
    case 'hq_m':
      return compound([
        box(0.85, 0.55, 0.8, 0, 0.275, 0, DARK_METAL),
        box(0.42, 2.2, 0.42, -0.08, 1.1, -0.04, LIGHT_METAL),
      ])
    case 'hq_l':
      return compound([
        box(0.9, 0.55, 0.86, 0, 0.275, 0, DARK_METAL),
        box(0.36, 4.0, 0.36, 0, 2.0, 0, LIGHT_METAL),
        box(0.22, 0.35, 0.22, 0, 4.2, 0, DARK_METAL),
      ])
    case 'lab':
      return compound([
        box(0.84, 0.48, 0.72, 0, 0.24, 0, LIGHT_METAL),
        cone(0.18, 0.24, 8, 0.16, 0.6, -0.1, GLASS),
      ])
    default:
      return simpleBox(0.8, 0.6, 0.72)
  }
}

function treeFar(variant: number): THREE.BufferGeometry {
  const offset = variant === 1 ? 0.18 : 0.22
  return compound([
    cone(0.22, 0.7, 5, -offset, 0.35, -0.08, FOLIAGE_DARK),
    cone(0.28, 0.86, 5, 0.12, 0.43, 0.08, FOLIAGE),
    cone(0.18, 0.6, 5, 0.28, 0.3, -0.2, FOLIAGE_DARK),
  ])
}

function forestBiomeGeometry(
  biome: 'conifer' | 'aspen' | 'oak' | 'scrub' | 'deadwood' | 'rocky',
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const addTrunk = (x: number, z: number, height: number, pale = false) => {
    parts.push(cylinder(0.025, 0.035, height, 5, x, height / 2, z, pale ? [0.78, 0.76, 0.68] : TRUNK))
  }
  if (biome === 'conifer') {
    for (const [x, z, height] of [[-0.24, -0.12, 0.82], [0.12, 0.08, 1.08], [0.3, -0.2, 0.72]] as const) {
      addTrunk(x, z, height * 0.44)
      parts.push(cone(height * 0.2, height * 0.78, 6, x, height * 0.58, z, FOLIAGE_DARK))
    }
  } else if (biome === 'aspen') {
    for (const [x, z, height] of [[-0.28, 0.04, 0.74], [-0.02, -0.18, 0.9], [0.25, 0.12, 0.8]] as const) {
      addTrunk(x, z, height * 0.72, true)
      const crown = paint(new THREE.IcosahedronGeometry(height * 0.19, 0), [0.55, 0.72, 0.3], 0)
      crown.scale(0.8, 1.35, 0.8)
      crown.translate(x, height * 0.82, z)
      parts.push(crown)
    }
  } else if (biome === 'oak') {
    for (const [x, z, height] of [[-0.18, -0.08, 0.68], [0.22, 0.12, 0.78]] as const) {
      addTrunk(x, z, height * 0.58)
      const crown = paint(new THREE.DodecahedronGeometry(height * 0.3, 0), [0.24, 0.48, 0.18], 0)
      crown.scale(1.25, 0.8, 1.1)
      crown.translate(x, height * 0.72, z)
      parts.push(crown)
    }
  } else if (biome === 'scrub') {
    for (const [x, z, radius] of [[-0.3, -0.12, 0.18], [0.02, 0.18, 0.24], [0.3, -0.08, 0.15]] as const) {
      const shrub = paint(new THREE.IcosahedronGeometry(radius, 0), [0.3, 0.5, 0.2], 0)
      shrub.scale(1.3, 0.62, 1.1)
      shrub.translate(x, radius * 0.5, z)
      parts.push(shrub)
    }
  } else if (biome === 'deadwood') {
    const standing = cylinder(0.035, 0.055, 0.62, 5, -0.2, 0.31, -0.04, [0.42, 0.31, 0.2])
    const fallen = cylinder(0.04, 0.055, 0.72, 6, 0.12, 0.08, 0.12, [0.38, 0.28, 0.18])
    fallen.rotateZ(Math.PI / 2)
    parts.push(standing, fallen)
    parts.push(cone(0.2, 0.55, 5, 0.28, 0.275, -0.2, FOLIAGE_DARK))
  } else {
    parts.push(groundRockGeometry())
    addTrunk(0.24, 0.12, 0.46)
    parts.push(cone(0.18, 0.58, 5, 0.24, 0.35, 0.12, FOLIAGE_DARK))
  }
  return compound(parts)
}

function groundScrubGeometry(): THREE.BufferGeometry {
  return compound([
    cone(0.11, 0.18, 6, -0.16, 0.09, 0.03, [0.38, 0.5, 0.2]),
    cone(0.09, 0.14, 6, 0.08, 0.07, -0.09, [0.46, 0.55, 0.22]),
    cone(0.07, 0.11, 5, 0.22, 0.055, 0.11, [0.3, 0.43, 0.16]),
  ])
}

function groundRockGeometry(): THREE.BufferGeometry {
  const a = paint(new THREE.DodecahedronGeometry(0.13, 0), [0.43, 0.42, 0.38], 0)
  a.scale(1.4, 0.65, 1)
  a.translate(-0.11, 0.07, 0.02)
  const b = paint(new THREE.DodecahedronGeometry(0.08, 0), [0.52, 0.49, 0.42], 0)
  b.scale(1, 0.72, 1.2)
  b.translate(0.14, 0.045, -0.08)
  return compound([a, b])
}

function groundLogGeometry(): THREE.BufferGeometry {
  const log = cylinder(0.035, 0.045, 0.48, 6, 0, 0.055, 0, [0.38, 0.27, 0.17])
  log.rotateZ(Math.PI / 2)
  return compound([log, cone(0.07, 0.12, 5, -0.16, 0.06, 0.12, [0.34, 0.46, 0.18])])
}

function hillMoundGeometry(): THREE.BufferGeometry {
  const mound = paint(new THREE.SphereGeometry(0.5, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), [0.3, 0.45, 0.22], 0)
  mound.scale(1.9, 0.28, 1.5)
  return compound([mound])
}

type BuildingLod = typeof LodTier.near | typeof LodTier.mid | typeof LodTier.far

const BUILDING_PALETTE = {
  lawn: [0.26, 0.43, 0.22] as Rgb,
  paving: [0.55, 0.54, 0.5] as Rgb,
  cream: [0.82, 0.72, 0.58] as Rgb,
  brick: [0.58, 0.25, 0.18] as Rgb,
  stone: [0.62, 0.64, 0.64] as Rgb,
  concrete: [0.46, 0.5, 0.54] as Rgb,
  darkGlass: [0.12, 0.28, 0.38] as Rgb,
  blueGlass: [0.28, 0.55, 0.68] as Rgb,
  warmWindow: [0.95, 0.72, 0.35] as Rgb,
} as const

/** Build one connected architectural mass per lot; detail only decorates it. */
function createSingleBuildingGeometry(style: SingleBuildingStyle, lod: BuildingLod): THREE.BufferGeometry {
  const profile = SINGLE_BUILDING_PROFILES[style]
  const [width, depth] = profile.footprint
  const parts: THREE.BufferGeometry[] = []
  const detail = lod === LodTier.near ? 2 : lod === LodTier.mid ? 1 : 0
  const addLot = (surface: Rgb, depthSize = 0.9) => {
    if (detail === 0) return
    parts.push(tintedBox(0.94, 0.025, depthSize, 0, 0.0125, 0, surface, 0.08))
  }
  const addFacadeGrid = (
    columns: number,
    rows: number,
    facadeWidth: number,
    baseY: number,
    rowGap: number,
    z: number,
    color: Rgb,
  ) => {
    if (detail === 0) return
    const visibleRows = detail === 1 ? Math.ceil(rows / 2) : rows
    for (let row = 0; row < visibleRows; row++) {
      const sourceRow = detail === 1 ? row * 2 : row
      for (let column = 0; column < columns; column++) {
        const x = columns === 1 ? 0 : -facadeWidth / 2 + (facadeWidth * column) / (columns - 1)
        parts.push(tintedBox(0.075, 0.07, 0.012, x, baseY + sourceRow * rowGap, z, color, 0.12))
      }
    }
  }

  if (style === 'detachedHouse') {
    addLot(BUILDING_PALETTE.lawn)
    parts.push(tintedBox(width, 0.3, depth, 0, 0.175, 0.04, BUILDING_PALETTE.cream, 0.35))
    const roof = paint(new THREE.ConeGeometry(0.43, 0.2, 4), [0.36, 0.16, 0.12], 0.15)
    roof.scale(1, 1, 0.82)
    roof.rotateY(Math.PI / 4)
    roof.translate(0, 0.43, 0.04)
    parts.push(roof)
    if (detail > 0) {
      parts.push(tintedBox(0.1, 0.2, 0.015, 0, 0.15, 0.278, [0.29, 0.15, 0.08], 0.1))
      parts.push(tintedBox(0.13, 0.1, 0.014, -0.17, 0.22, 0.279, BUILDING_PALETTE.blueGlass, 0.1))
      parts.push(tintedBox(0.13, 0.1, 0.014, 0.17, 0.22, 0.279, BUILDING_PALETTE.blueGlass, 0.1))
    }
    if (detail === 2) {
      parts.push(tintedBox(0.12, 0.025, 0.24, 0, 0.025, 0.36, BUILDING_PALETTE.paving, 0.05))
      parts.push(cylinder(0.075, 0.085, 0.12, 7, -0.37, 0.075, -0.23, FOLIAGE_DARK))
    }
  } else if (style === 'smallShop') {
    addLot(BUILDING_PALETTE.paving, 0.82)
    parts.push(tintedBox(width, 0.33, depth, 0, 0.19, -0.04, BUILDING_PALETTE.brick, 0.3))
    parts.push(tintedBox(width + 0.04, 0.055, depth + 0.04, 0, 0.3825, -0.04, [0.22, 0.24, 0.25], 0.1))
    if (detail > 0) {
      parts.push(tintedBox(0.43, 0.16, 0.015, -0.07, 0.16, 0.238, BUILDING_PALETTE.darkGlass, 0.08))
      parts.push(tintedBox(0.12, 0.23, 0.016, 0.25, 0.125, 0.239, [0.18, 0.22, 0.24], 0.08))
      parts.push(tintedBox(0.56, 0.055, 0.16, -0.02, 0.29, 0.29, [0.75, 0.57, 0.22], 0.16))
    }
    if (detail === 2) parts.push(tintedBox(0.36, 0.06, 0.025, -0.06, 0.34, 0.247, BUILDING_PALETTE.cream, 0.08))
  } else if (style === 'rowhouse') {
    addLot(BUILDING_PALETTE.paving, 0.86)
    parts.push(tintedBox(width, 0.56, depth, 0, 0.305, -0.04, BUILDING_PALETTE.brick, 0.3))
    const roof = paint(new THREE.ConeGeometry(0.48, 0.15, 4), [0.3, 0.18, 0.14], 0.12)
    roof.scale(1.2, 1, 0.72)
    roof.rotateY(Math.PI / 4)
    roof.translate(0, 0.655, -0.04)
    parts.push(roof)
    addFacadeGrid(3, 2, 0.48, 0.27, 0.2, 0.207, BUILDING_PALETTE.warmWindow)
    if (detail > 0) parts.push(tintedBox(0.11, 0.22, 0.014, 0, 0.14, 0.208, [0.2, 0.25, 0.23], 0.1))
  } else if (style === 'midRise') {
    addLot(BUILDING_PALETTE.paving)
    parts.push(tintedBox(width, 0.92, depth, 0, 0.485, -0.02, BUILDING_PALETTE.stone, 0.3))
    parts.push(tintedBox(width * 0.72, 0.12, depth * 0.72, 0, 1.005, -0.02, BUILDING_PALETTE.concrete, 0.18))
    addFacadeGrid(4, 4, 0.48, 0.22, 0.18, 0.297, BUILDING_PALETTE.darkGlass)
    if (detail === 2) parts.push(tintedBox(0.2, 0.055, 0.18, 0.18, 1.0925, -0.03, DARK_METAL, 0.1))
  } else if (style === 'officeTower') {
    addLot(BUILDING_PALETTE.paving)
    parts.push(tintedBox(width + 0.14, 0.18, depth + 0.14, 0, 0.1025, 0, BUILDING_PALETTE.concrete, 0.2))
    parts.push(tintedBox(width, 1.3, depth, 0, 0.83, 0, BUILDING_PALETTE.blueGlass, 0.22))
    parts.push(tintedBox(width + 0.035, 0.055, depth + 0.035, 0, 1.5075, 0, LIGHT_METAL, 0.12))
    addFacadeGrid(4, 6, 0.43, 0.35, 0.19, depth / 2 + 0.007, [0.68, 0.82, 0.86])
    if (detail === 2) parts.push(tintedBox(0.12, 0.07, 0.2, -0.16, 1.57, 0, DARK_METAL, 0.08))
  } else {
    addLot(BUILDING_PALETTE.paving)
    // A centered podium, shaft and crown stay legible and proportionate when
    // the parcel renderer scales this archetype to 2x1, 1x2, or 2x2 lots.
    parts.push(tintedBox(width + 0.18, 0.2, depth + 0.18, 0, 0.1125, 0, BUILDING_PALETTE.concrete, 0.18))
    parts.push(tintedBox(width, 1.72, depth, 0, 1.075, 0, BUILDING_PALETTE.darkGlass, 0.2))
    parts.push(tintedBox(width * 0.72, 0.28, depth * 0.72, 0, 2.075, 0, BUILDING_PALETTE.blueGlass, 0.18))
    addFacadeGrid(4, 8, 0.39, 0.42, 0.2, depth / 2 + 0.007, [0.62, 0.78, 0.84])
    if (detail > 0) parts.push(tintedBox(0.035, 0.28, 0.035, 0, 2.35, 0, LIGHT_METAL, 0.08))
  }

  const geometry = compound(parts)
  geometry.userData.singleBuilding = {
    style,
    buildingCount: 1,
    footprint: [...profile.footprint],
    lotSize: [0.94, style === 'smallShop' ? 0.82 : style === 'rowhouse' ? 0.86 : 0.9],
    lod,
  }
  return geometry
}

type DistrictBuildingStyle =
  | 'podium'
  | 'arcade'
  | 'civicHall'
  | 'library'
  | 'market'
  | 'hotel'
  | 'transitHub'

function createDistrictBuildingGeometry(
  style: DistrictBuildingStyle,
  lod: BuildingLod,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const detail = lod === LodTier.near ? 2 : lod === LodTier.mid ? 1 : 0
  if (detail > 0) {
    parts.push(tintedBox(0.9, 0.022, 0.86, 0, 0.011, 0, BUILDING_PALETTE.paving, 0.08))
  }
  if (style === 'podium') {
    parts.push(tintedBox(0.82, 0.2, 0.74, 0, 0.12, 0, BUILDING_PALETTE.concrete, 0.2))
    parts.push(tintedBox(0.5, 0.78, 0.46, 0, 0.61, 0, BUILDING_PALETTE.blueGlass, 0.22))
    parts.push(tintedBox(0.54, 0.05, 0.5, 0, 1.025, 0, LIGHT_METAL, 0.1))
  } else if (style === 'arcade') {
    parts.push(tintedBox(0.8, 0.46, 0.58, 0, 0.25, -0.02, BUILDING_PALETTE.brick, 0.28))
    parts.push(tintedBox(0.84, 0.06, 0.62, 0, 0.51, -0.02, [0.22, 0.16, 0.12], 0.1))
    if (detail > 0) {
      parts.push(tintedBox(0.16, 0.2, 0.04, -0.22, 0.16, 0.28, BUILDING_PALETTE.darkGlass, 0.08))
      parts.push(tintedBox(0.16, 0.2, 0.04, 0, 0.16, 0.28, BUILDING_PALETTE.darkGlass, 0.08))
      parts.push(tintedBox(0.16, 0.2, 0.04, 0.22, 0.16, 0.28, BUILDING_PALETTE.darkGlass, 0.08))
    }
  } else if (style === 'civicHall') {
    parts.push(tintedBox(0.84, 0.42, 0.62, 0, 0.23, 0, BUILDING_PALETTE.stone, 0.28))
    const pediment = paint(new THREE.ConeGeometry(0.48, 0.16, 3), BUILDING_PALETTE.stone, 0.12)
    pediment.rotateY(Math.PI)
    pediment.translate(0, 0.52, 0)
    parts.push(pediment)
    if (detail > 0) {
      parts.push(cylinder(0.03, 0.035, 0.28, 6, -0.22, 0.16, 0.32, BUILDING_PALETTE.cream))
      parts.push(cylinder(0.03, 0.035, 0.28, 6, 0.22, 0.16, 0.32, BUILDING_PALETTE.cream))
    }
  } else if (style === 'library') {
    parts.push(tintedBox(0.78, 0.38, 0.56, 0, 0.21, 0.04, BUILDING_PALETTE.stone, 0.26))
    parts.push(tintedBox(0.52, 0.28, 0.4, 0.06, 0.54, -0.04, BUILDING_PALETTE.concrete, 0.18))
    if (detail > 0) {
      parts.push(tintedBox(0.36, 0.12, 0.02, -0.08, 0.22, 0.33, BUILDING_PALETTE.darkGlass, 0.08))
    }
  } else if (style === 'market') {
    parts.push(tintedBox(0.76, 0.28, 0.54, 0, 0.16, 0, BUILDING_PALETTE.brick, 0.24))
    parts.push(tintedBox(0.88, 0.05, 0.7, 0, 0.325, 0, [0.55, 0.38, 0.18], 0.12))
    if (detail === 2) {
      parts.push(tintedBox(0.2, 0.08, 0.16, -0.2, 0.12, 0.28, BUILDING_PALETTE.cream, 0.08))
      parts.push(tintedBox(0.2, 0.08, 0.16, 0.18, 0.12, 0.28, BUILDING_PALETTE.warmWindow, 0.08))
    }
  } else if (style === 'hotel') {
    parts.push(tintedBox(0.7, 0.16, 0.62, 0, 0.1, 0, BUILDING_PALETTE.concrete, 0.18))
    parts.push(tintedBox(0.46, 1.18, 0.42, 0, 0.77, 0, BUILDING_PALETTE.cream, 0.22))
    parts.push(tintedBox(0.38, 0.16, 0.34, 0, 1.44, 0, BUILDING_PALETTE.blueGlass, 0.16))
  } else {
    parts.push(tintedBox(0.86, 0.32, 0.52, 0, 0.18, 0, BUILDING_PALETTE.concrete, 0.2))
    parts.push(tintedBox(0.94, 0.05, 0.36, 0, 0.365, 0.08, LIGHT_METAL, 0.1))
    parts.push(tintedBox(0.28, 0.42, 0.28, 0.24, 0.42, -0.08, BUILDING_PALETTE.darkGlass, 0.16))
  }
  return compound(parts)
}

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function tintedBox(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  color: Rgb,
  mix: number,
): THREE.BufferGeometry {
  const geometry = paint(new THREE.BoxGeometry(width, height, depth), color, mix)
  geometry.translate(x, y, z)
  return geometry
}

function warehouseFar(variant: number): THREE.BufferGeometry {
  const parts = [
    box(0.9, 0.4, 0.72, 0, 0.2, 0, WHITE),
    box(0.96, 0.055, 0.78, 0, 0.43, 0, ROOF),
  ]
  if (variant === 1) parts.push(box(0.25, 0.2, 0.2, -0.32, 0.1, -0.32, DARK_METAL))
  return compound(parts)
}

function parkFar(): THREE.BufferGeometry {
  return compound([
    cylinder(0.025, 0.035, 0.24, 5, 0.24, 0.12, -0.18, TRUNK),
    cone(0.17, 0.34, 6, 0.24, 0.38, -0.18, FOLIAGE),
    box(0.28, 0.04, 0.09, -0.22, 0.1, 0.2, TRUNK),
  ])
}

function lakeFar(interior: boolean): THREE.BufferGeometry {
  if (interior) {
    return compound([
      cylinder(0.055, 0.055, 0.015, 6, -0.08, 0.008, 0.03, FOLIAGE),
      cylinder(0.045, 0.045, 0.015, 6, 0.08, 0.008, -0.04, FOLIAGE_DARK),
    ])
  }
  return compound([
    cylinder(0.008, 0.012, 0.16, 4, -0.16, 0.08, -0.3, FOLIAGE_DARK),
    cylinder(0.008, 0.012, 0.2, 4, 0, 0.1, -0.32, FOLIAGE),
    cylinder(0.008, 0.012, 0.14, 4, 0.15, 0.07, -0.28, FOLIAGE_DARK),
  ])
}

function roadLampNear(): THREE.BufferGeometry {
  return compound([
    cylinder(0.015, 0.02, 0.38, 6, 0, 0.19, 0, DARK_METAL),
    paint(new THREE.SphereGeometry(0.035, 6, 5), [1, 0.84, 0.45]),
  ].map((geometry, index) => {
    if (index === 1) geometry.translate(0, 0.42, 0)
    return geometry
  }))
}

function roadLampFar(): THREE.BufferGeometry {
  return compound([
    cylinder(0.014, 0.019, 0.38, 4, 0, 0.19, 0, DARK_METAL),
    box(0.055, 0.055, 0.055, 0, 0.415, 0, [1, 0.84, 0.45]),
  ])
}

function simpleBox(width: number, height: number, depth: number): THREE.BufferGeometry {
  return compound([box(width, height, depth, 0, height / 2, 0, WHITE)])
}

function box(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  color: Rgb,
): THREE.BufferGeometry {
  const geometry = paint(new THREE.BoxGeometry(width, height, depth), color)
  geometry.translate(x, y, z)
  return geometry
}

function cylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  segments: number,
  x: number,
  y: number,
  z: number,
  color: Rgb,
): THREE.BufferGeometry {
  const geometry = paint(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments),
    color,
  )
  geometry.translate(x, y, z)
  return geometry
}

function cone(
  radius: number,
  height: number,
  segments: number,
  x: number,
  y: number,
  z: number,
  color: Rgb,
): THREE.BufferGeometry {
  const geometry = paint(new THREE.ConeGeometry(radius, height, segments), color)
  geometry.translate(x, y, z)
  return geometry
}

function paint<T extends THREE.BufferGeometry>(geometry: T, color: Rgb, mix = 1): T {
  const count = geometry.getAttribute('position').count
  const values = new Float32Array(count * 3)
  const ownerMix = new Float32Array(count)
  for (let index = 0; index < count; index++) {
    values[index * 3] = color[0]
    values[index * 3 + 1] = color[1]
    values[index * 3 + 2] = color[2]
    ownerMix[index] = mix
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(values, 3))
  geometry.setAttribute('ownerMix', new THREE.BufferAttribute(ownerMix, 1))
  return geometry
}

function compound(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Three's primitive families disagree on index layout (polyhedra are flat,
  // boxes/cylinders are indexed). Normalize once so mixed natural props can be
  // merged into the same instancing-ready archetype.
  const normalized = parts.map((part) => {
    if (!part.index) return part
    const flat = part.toNonIndexed()
    part.dispose()
    return flat
  })
  const geometry = mergeGeometries(normalized, false)
  for (const part of normalized) part.dispose()
  if (!geometry) throw new Error('Unable to merge archetype geometry')
  geometry.computeBoundingBox()
  const minY = geometry.boundingBox?.min.y ?? 0
  if (minY !== 0) geometry.translate(0, -minY, 0)
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

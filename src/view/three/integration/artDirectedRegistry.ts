import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { MapTile } from '../../../sim/types'
import { createBuildingKit, type KitDetail } from '../buildingKits'
import type { Neighbors } from '../tileNeighbors'
import {
  ArchetypeRegistry,
  DefaultArchetype,
  LodTier,
  installDitherTransition,
  type ArchetypeDefinition,
} from '../v2'

type Rgb = readonly [number, number, number]

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
} as const

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
  const houseSingle = bakeLegacyKit('house', 0.36, 0xd4c4a8, 5, 11, { stripBase: true })
  const houseDuplex = bakeLegacyKit('house', 0.36, 0xc8b8a0, 19, 3, { stripBase: true })
  const houseTerrace = bakeLegacyKit('house', 0.36, 0xe8dcc8, 31, 23, { stripBase: true })
  const cityA = bakeLegacyKit('city', 0.72, 0x6b5b95, 3, 7, { stripBase: true })
  const cityB = bakeLegacyKit('city', 0.72, 0x52728a, 11, 13, { stripBase: true })
  const cityC = bakeLegacyKit('city', 0.72, 0x806b92, 17, 5, { stripBase: true })
  const cityD = bakeLegacyKit('city', 0.72, 0x65737e, 23, 29, { stripBase: true })
  const warehouse = bakeLegacyKit('warehouse', 0.42, 0x6a7080, 7, 3, { stripBase: true })
  const warehouseContainers = bakeLegacyKit('warehouse', 0.42, 0x756b61, 17, 19, { stripBase: true })
  // At map scale, variants share family silhouettes. InstancedChunk can batch
  // records by this shared geometry/material identity, reducing far draw calls
  // without removing any building.
  const forestFar = treeFar(0)
  const residentialFar = houseFar(1)
  const districtFar = cityFar(0)
  const industrialFar = warehouseFar(0)

  register(registry, materials, DefaultArchetype.tree, 'forest-pine', treePine, treePine, forestFar)
  register(registry, materials, SceneryArchetype.forestBroadleaf, 'forest-broadleaf', treeBroadleaf, treeBroadleaf, forestFar)
  register(registry, materials, SceneryArchetype.forestMixed, 'forest-mixed', treeMixed, treeMixed, forestFar)
  register(registry, materials, DefaultArchetype.house, 'house-single', houseSingle, houseSingle, residentialFar)
  register(registry, materials, SceneryArchetype.houseDuplex, 'house-duplex', houseDuplex, houseDuplex, residentialFar)
  register(registry, materials, SceneryArchetype.houseTerrace, 'house-terrace', houseTerrace, houseTerrace, residentialFar)
  register(
    registry,
    materials,
    DefaultArchetype.cityTowerA,
    'city-district-a',
    cityA,
    cityA,
    districtFar,
  )
  register(
    registry,
    materials,
    DefaultArchetype.cityTowerB,
    'city-district-b',
    cityB,
    cityB,
    districtFar,
  )
  register(registry, materials, SceneryArchetype.cityDistrictC, 'city-district-c', cityC, cityC, districtFar)
  register(registry, materials, SceneryArchetype.cityDistrictD, 'city-district-d', cityD, cityD, districtFar)
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
  return registry
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
    dithering: true,
  })
  installDitherTransition(material)
  const installDither = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    installDither(shader, renderer)
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
        box(0.74, 0.62, 0.58, 0, 0.31, 0, LIGHT_METAL),
        box(0.58, 0.18, 0.03, 0, 0.36, 0.305, GLASS),
      ])
    case 'hq':
      return compound([
        box(0.72, 0.62, 0.56, -0.08, 0.31, 0, LIGHT_METAL),
        box(0.24, 0.4, 0.42, 0.34, 0.2, 0.05, DARK_METAL),
      ])
    case 'hq_m':
      return compound([
        box(0.42, 0.78, 0.7, -0.22, 0.39, 0, LIGHT_METAL),
        box(0.42, 0.64, 0.7, 0.22, 0.32, 0, LIGHT_METAL),
      ])
    case 'hq_l':
      return compound([
        box(0.82, 0.58, 0.7, 0, 0.29, 0, LIGHT_METAL),
        box(0.32, 1.05, 0.34, 0.2, 0.525, -0.08, DARK_METAL),
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

function houseFar(variant: number): THREE.BufferGeometry {
  const bodies: THREE.BufferGeometry[] = []
  const count = variant + 1
  for (let index = 0; index < count; index++) {
    const x = (index - (count - 1) / 2) * 0.3
    bodies.push(box(0.3, 0.25, 0.28, x, 0.125, 0, WHITE))
    const roof = paint(new THREE.ConeGeometry(0.24, 0.18, 4), ROOF)
    roof.rotateY(Math.PI / 4)
    roof.translate(x, 0.34, 0)
    bodies.push(roof)
  }
  return compound(bodies)
}

function cityFar(variant: number): THREE.BufferGeometry {
  const heights = [0.58, 0.82, 1.06, 0.7]
  const parts: THREE.BufferGeometry[] = []
  for (let index = 0; index < 3; index++) {
    const height = heights[(index + variant) % heights.length]!
    const x = (index - 1) * 0.27
    const z = index === 1 ? -0.16 : 0.14
    parts.push(box(0.24, height, 0.26, x, height / 2, z, index % 2 ? LIGHT_METAL : WHITE))
  }
  return compound(parts)
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
  const geometry = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  if (!geometry) throw new Error('Unable to merge archetype geometry')
  geometry.computeBoundingBox()
  const minY = geometry.boundingBox?.min.y ?? 0
  if (minY !== 0) geometry.translate(0, -minY, 0)
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

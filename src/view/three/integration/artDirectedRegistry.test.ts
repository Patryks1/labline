import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  DefaultArchetype,
  InstancedChunk,
  LodTier,
  type RenderInstance,
} from '../v2'
import {
  AUTHORED_INDUSTRIAL_ARCHETYPES,
  AUTHORED_RESIDENTIAL_ARCHETYPES,
  AUTHORED_TERRAIN_ARCHETYPES,
  AUTHORED_URBAN_ARCHETYPES,
  AUTHORED_VEGETATION_ARCHETYPES,
  FacilityArchetype,
  IntegrationArchetype,
  MunicipalPowerArchetype,
  SINGLE_BUILDING_ARCHETYPES,
  SINGLE_BUILDING_PROFILES,
  SceneryArchetype,
  SingleBuildingArchetype,
  createArtDirectedArchetypeRegistry,
} from './artDirectedRegistry'
import { facilityArchetypeFor } from './simRenderSource'

describe('art-directed instanced archetypes', () => {
  it('keeps exact detailed geometry across the close near/mid transition', () => {
    const registry = createArtDirectedArchetypeRegistry()
    const facility = registry.get(DefaultArchetype.facilityLarge)
    const tree = registry.get(DefaultArchetype.tree)
    const nearFacility = facility.geometry.near!
    const midFacility = facility.geometry.mid!
    const farFacility = facility.geometry.far!

    expect(nearFacility).toBe(midFacility)
    expect(nearFacility.getAttribute('position').count).toBeGreaterThan(
      farFacility.getAttribute('position').count,
    )
    expect(nearFacility.getAttribute('color').count).toBe(
      nearFacility.getAttribute('position').count,
    )
    expect(tree.geometry.near).toBe(tree.geometry.mid)
    expect(tree.geometry.near!.getAttribute('position').count).toBeGreaterThan(
      tree.geometry.far!.getAttribute('position').count,
    )
    expect(facility.material.near).toBeInstanceOf(THREE.MeshStandardMaterial)
    registry.dispose()
  })

  it('keeps owner colors and exact instance capacity within a small near-tier budget', () => {
    const registry = createArtDirectedArchetypeRegistry()
    const records: RenderInstance[] = [
      facilityInstance(1, 0x3dffc0, 0),
      facilityInstance(2, 0xff6b4a, 2),
    ]
    const chunk = new InstancedChunk(0, LodTier.near, 1, records, registry)
    const meshes: THREE.InstancedMesh[] = []
    chunk.root.traverse((object) => {
      if (object instanceof THREE.InstancedMesh) meshes.push(object)
    })

    expect(chunk.stats).toMatchObject({ drawCalls: 1, instances: 2, capacity: 2 })
    expect(chunk.stats.triangles).toBeLessThan(2_000)
    expect(meshes).toHaveLength(1)
    expect(meshes[0]!.instanceMatrix.count).toBe(2)
    const player = new THREE.Color()
    const rival = new THREE.Color()
    meshes[0]!.getColorAt(0, player)
    meshes[0]!.getColorAt(1, rival)
    expect(player.equals(rival)).toBe(false)

    chunk.dispose()
    registry.dispose()
  })

  it('maps major facility families to a finite shared archetype set', () => {
    const registry = createArtDirectedArchetypeRegistry()
    expect(facilityArchetypeFor('dc_l', 'large')).toBe(DefaultArchetype.facilityLarge)
    expect(facilityArchetypeFor('hq_l', 'large')).toBe(IntegrationArchetype.headquarters)
    expect(facilityArchetypeFor('solar', 'small')).toBe(IntegrationArchetype.solar)
    expect(facilityArchetypeFor('substation', 'small')).toBe(IntegrationArchetype.grid)
    expect(facilityArchetypeFor('nuclear', 'small')).toBe(IntegrationArchetype.generation)
    expect(facilityArchetypeFor('fab', 'small')).toBe(IntegrationArchetype.fabrication)
    expect(facilityArchetypeFor('cooling', 'small')).toBe(IntegrationArchetype.campusSupport)
    expect(facilityArchetypeFor('gas', 'small')).toBe(FacilityArchetype.gas)
    expect(facilityArchetypeFor('battery', 'small')).toBe(FacilityArchetype.battery)
    expect(facilityArchetypeFor('office', 'small')).toBe(FacilityArchetype.office)
    expect(facilityArchetypeFor('hq', 'small')).toBe(FacilityArchetype.headquartersSmall)
    expect(facilityArchetypeFor('hq_m', 'medium')).toBe(
      FacilityArchetype.headquartersMedium,
    )
    expect(facilityArchetypeFor('lab', 'small')).toBe(FacilityArchetype.lab)
    for (const archetypeId of Object.values(IntegrationArchetype)) {
      expect(registry.has(archetypeId)).toBe(true)
    }
    for (const archetypeId of Object.values(FacilityArchetype)) {
      expect(registry.has(archetypeId)).toBe(true)
    }
    registry.dispose()
  })

  it('keeps every detailed scenery variant represented at far distance', () => {
    const registry = createArtDirectedArchetypeRegistry()
    const sceneryIds = [
      DefaultArchetype.tree,
      DefaultArchetype.house,
      DefaultArchetype.cityTowerA,
      DefaultArchetype.cityTowerB,
      DefaultArchetype.warehouse,
      ...Object.values(SceneryArchetype),
    ]
    for (const archetypeId of sceneryIds) {
      const definition = registry.get(archetypeId)
      expect(definition.geometry.near).not.toBeNull()
      expect(definition.geometry.mid).not.toBeNull()
      expect(definition.geometry.far).not.toBeNull()
      expect(definition.material.far).not.toBeNull()
    }
    registry.dispose()
  })

  it('registers every committed World V4 catalog archetype with a batched fallback', () => {
    const registry = createArtDirectedArchetypeRegistry()
    const catalogIds = [
      ...AUTHORED_TERRAIN_ARCHETYPES,
      ...AUTHORED_VEGETATION_ARCHETYPES,
      ...AUTHORED_RESIDENTIAL_ARCHETYPES,
      ...AUTHORED_URBAN_ARCHETYPES,
      ...AUTHORED_INDUSTRIAL_ARCHETYPES,
      ...[100, 101, 102, ...rangeForTest(110, 121), ...rangeForTest(468, 472)],
      ...[300, ...rangeForTest(473, 483)],
      ...[301, ...rangeForTest(484, 487)],
      ...[302, ...rangeForTest(488, 489)],
      ...[210, 207, 303, ...rangeForTest(490, 498)],
      ...Object.values(MunicipalPowerArchetype),
    ]

    expect(catalogIds).toHaveLength(132)
    expect(new Set(catalogIds).size).toBe(132)
    for (const id of catalogIds) {
      const definition = registry.get(id)
      expect(definition.geometry.near, `near geometry for ${id}`).not.toBeNull()
      expect(definition.geometry.mid, `mid geometry for ${id}`).not.toBeNull()
      expect(definition.geometry.far, `far geometry for ${id}`).not.toBeNull()
    }

    // Before authored GLBs arrive, aliases converge onto a small number of
    // family fallbacks instead of creating one draw call per catalog entry.
    const fallbackGeometries = new Set(catalogIds.map(id => registry.get(id).geometry.far))
    expect(fallbackGeometries.size).toBeLessThanOrEqual(30)
    registry.dispose()
  })

  it('registers four collision-free municipal campuses with distinct simplifying LODs', () => {
    const registry = createArtDirectedArchetypeRegistry()
    const ids = Object.values(MunicipalPowerArchetype)
    expect(ids).toEqual([506, 507, 508, 509])
    expect(new Set(ids).size).toBe(4)
    const signatures = new Set<string>()
    for (const id of ids) {
      const definition = registry.get(id)
      const tiers = [definition.geometry.near!, definition.geometry.mid!, definition.geometry.far!]
      expect(tiers.every(Boolean)).toBe(true)
      expect(tiers[0].getAttribute('position').count).toBeGreaterThanOrEqual(tiers[1].getAttribute('position').count)
      expect(tiers[1].getAttribute('position').count).toBeGreaterThanOrEqual(tiers[2].getAttribute('position').count)
      signatures.add(tiers.map(geometry => geometry.getAttribute('position').count).join(':'))
    }
    expect(signatures.size).toBeGreaterThan(1)
    expect(registry.get(MunicipalPowerArchetype.solar).geometry.near!.userData.municipalCampus)
      .toMatchObject({ footprint: [2, 2], solarClusterMerged: true })
    registry.dispose()
  })

  it('uses road-safe procedural fallbacks for streamed prop catalog entries', () => {
    const registry = createArtDirectedArchetypeRegistry()
    const parkGeometry = registry.get(SceneryArchetype.park).geometry
    const roadLampGeometry = registry.get(SceneryArchetype.roadLamp).geometry

    for (const id of [303, ...rangeForTest(490, 498)]) {
      const fallback = registry.get(id).geometry
      expect(fallback.near, `prop ${id} must not resolve to the park kit`).not.toBe(parkGeometry.near)
      expect(fallback.mid, `prop ${id} must not resolve to the park kit`).not.toBe(parkGeometry.mid)
      expect(fallback.far, `prop ${id} must not resolve to the park kit`).not.toBe(parkGeometry.far)
      expect(fallback.near).toBe(roadLampGeometry.near)
    }

    registry.dispose()
  })

  it('keeps 18 legacy scenery IDs on the bounded single-building/logistics set', () => {
    const registry = createArtDirectedArchetypeRegistry()
    const residential = [
      SceneryArchetype.houseCourtyard,
      SceneryArchetype.houseGarden,
      SceneryArchetype.houseTownhome,
      SceneryArchetype.houseStilt,
      SceneryArchetype.houseRow,
      SceneryArchetype.houseCorner,
    ]
    const urban = [
      SceneryArchetype.cityPodium,
      SceneryArchetype.cityArcade,
      SceneryArchetype.cityCivicHall,
      SceneryArchetype.cityLibrary,
      SceneryArchetype.cityMarket,
      SceneryArchetype.cityHotel,
      SceneryArchetype.cityTransitHub,
    ]
    const logistics = [
      SceneryArchetype.warehouseSawtooth,
      SceneryArchetype.warehouseColdStore,
      SceneryArchetype.warehouseDepot,
      SceneryArchetype.warehouseSilos,
      SceneryArchetype.warehouseFreight,
    ]
    const added = [...residential, ...urban, ...logistics]

    expect(added).toHaveLength(18)
    for (const id of added) expect(registry.has(id)).toBe(true)
    expect(new Set(added.map((id) => registry.get(id).geometry.near)).size).toBeGreaterThanOrEqual(8)
    for (const family of [residential, urban, logistics]) {
      expect(new Set(family.map((id) => registry.get(id).geometry.far)).size).toBeLessThanOrEqual(3)
      expect(new Set(family.map((id) => registry.get(id).material.far)).size).toBe(1)
    }

    registry.dispose()
  })

  it('registers clustered forest biomes and sparse ground-detail archetypes', () => {
    const registry = createArtDirectedArchetypeRegistry()
    const ids = [
      SceneryArchetype.forestConiferTall,
      SceneryArchetype.forestAspen,
      SceneryArchetype.forestOak,
      SceneryArchetype.forestScrub,
      SceneryArchetype.forestDeadwood,
      SceneryArchetype.forestRocky,
      SceneryArchetype.groundScrub,
      SceneryArchetype.groundRock,
      SceneryArchetype.groundLog,
      SceneryArchetype.hillMound,
    ]
    for (const id of ids) expect(registry.has(id)).toBe(true)
    expect(new Set(ids.map((id) => registry.get(id).geometry.near)).size).toBe(ids.length)
    registry.dispose()
  })

  it('keeps every persistent building represented in the far tier', () => {
    const registry = createArtDirectedArchetypeRegistry()
    const persistentBuildings = [
      DefaultArchetype.house,
      DefaultArchetype.cityTowerA,
      DefaultArchetype.cityTowerB,
      DefaultArchetype.warehouse,
      DefaultArchetype.facilitySmall,
      DefaultArchetype.facilityMedium,
      DefaultArchetype.facilityLarge,
      ...Object.values(IntegrationArchetype),
    ]

    const missingFarRepresentations = persistentBuildings
      .map((archetypeId) => registry.get(archetypeId))
      .filter((definition) => !definition.geometry.far || !definition.material.far)
      .map((definition) => definition.name)

    expect(missingFarRepresentations).toEqual([])
    registry.dispose()
  })

  it('batches far variants by shared family silhouette without dropping instances', () => {
    const registry = createArtDirectedArchetypeRegistry()
    const archetypes = [
      DefaultArchetype.tree,
      SceneryArchetype.forestBroadleaf,
      SceneryArchetype.forestMixed,
      DefaultArchetype.house,
      SceneryArchetype.houseDuplex,
      SceneryArchetype.houseTerrace,
      DefaultArchetype.cityTowerA,
      DefaultArchetype.cityTowerB,
      SceneryArchetype.cityDistrictC,
      SceneryArchetype.cityDistrictD,
      DefaultArchetype.warehouse,
      SceneryArchetype.warehouseContainers,
    ]
    const records = archetypes.map((archetypeId, index) => ({
      ...facilityInstance(index + 1, 0xffffff, index),
      archetypeId,
    }))
    const chunk = new InstancedChunk(0, LodTier.far, 1, records, registry)

    expect(chunk.stats).toMatchObject({
      instances: archetypes.length,
      capacity: archetypes.length,
      drawCalls: 7,
      missingInstances: 0,
    })
    for (const archetypeId of archetypes) expect(chunk.capacityFor(archetypeId)).toBe(1)

    chunk.dispose()
    registry.dispose()
  })

  it('batches a mixed facility chunk within the structural draw/triangle budget', () => {
    const registry = createArtDirectedArchetypeRegistry()
    const archetypes = [
      DefaultArchetype.facilityLarge,
      ...Object.values(IntegrationArchetype),
    ]
    const records = archetypes.map((archetypeId, index) => ({
      ...facilityInstance(index + 1, index % 2 === 0 ? 0x3dffc0 : 0xff6b4a, index),
      archetypeId,
    }))
    const chunk = new InstancedChunk(0, LodTier.near, 1, records, registry)

    expect(chunk.stats.instances).toBe(archetypes.length)
    expect(chunk.stats.capacity).toBe(archetypes.length)
    expect(chunk.stats.drawCalls).toBe(archetypes.length)
    expect(chunk.stats.drawCalls).toBeLessThanOrEqual(8)
    expect(chunk.stats.triangles).toBeLessThan(3_000)

    chunk.dispose()
    registry.dispose()
  })

  it('registers six stable single-building styles with complete, simplifying LODs', () => {
    const registry = createArtDirectedArchetypeRegistry()

    expect(SINGLE_BUILDING_ARCHETYPES).toEqual([500, 501, 502, 503, 504, 505])
    expect(new Set(SINGLE_BUILDING_ARCHETYPES).size).toBe(6)
    expect(new Set(SINGLE_BUILDING_ARCHETYPES.map((id) => registry.get(id).geometry.near)).size).toBe(6)
    for (const [style, profile] of Object.entries(SINGLE_BUILDING_PROFILES)) {
      expect(profile.id).toBe(SingleBuildingArchetype[style as keyof typeof SingleBuildingArchetype])
      const definition = registry.get(profile.id)
      const tiers = [definition.geometry.near!, definition.geometry.mid!, definition.geometry.far!]
      expect(tiers.every(Boolean)).toBe(true)
      expect(tiers[0]).not.toBe(tiers[1])
      expect(tiers[1]).not.toBe(tiers[2])
      expect(tiers[0].getAttribute('position').count).toBeGreaterThan(tiers[1].getAttribute('position').count)
      expect(tiers[1].getAttribute('position').count).toBeGreaterThan(tiers[2].getAttribute('position').count)

      for (const geometry of tiers) {
        const metadata = geometry.userData.singleBuilding
        expect(metadata).toMatchObject({ style, buildingCount: 1, footprint: [...profile.footprint] })
        geometry.computeBoundingBox()
        const size = geometry.boundingBox!.getSize(new THREE.Vector3())
        expect(size.x).toBeLessThanOrEqual(0.96)
        expect(size.z).toBeLessThanOrEqual(0.96)
        expect(size.y).toBeGreaterThan(0.3)
        expect(size.y).toBeLessThanOrEqual(profile.height + 0.01)
        expect(geometry.getAttribute('color').count).toBe(geometry.getAttribute('position').count)
        expect(uniqueVertexColors(geometry)).toBeGreaterThanOrEqual(2)
      }
    }

    registry.dispose()
  })

  it('keeps the skyscraper centered and proportional across supported parcel spans', () => {
    const registry = createArtDirectedArchetypeRegistry()
    const geometry = registry.get(SingleBuildingArchetype.skyscraper).geometry.near!
    const expectedSpans = [[1, 1], [2, 1], [1, 2], [2, 2]]
    expect(SINGLE_BUILDING_PROFILES.skyscraper.parcelSpans).toEqual(expectedSpans)

    for (const [width, depth] of expectedSpans) {
      const scaled = geometry.clone().scale(width, 1, depth)
      scaled.computeBoundingBox()
      const bounds = scaled.boundingBox!
      const size = bounds.getSize(new THREE.Vector3())
      expect(bounds.getCenter(new THREE.Vector3()).x).toBeCloseTo(0)
      expect(bounds.getCenter(new THREE.Vector3()).z).toBeCloseTo(0)
      expect(size.x).toBeLessThanOrEqual(width)
      expect(size.z).toBeLessThanOrEqual(depth)
      expect(size.y).toBeCloseTo(SINGLE_BUILDING_PROFILES.skyscraper.height, 2)
      scaled.dispose()
    }

    registry.dispose()
  })

  it('recreates the single-building geometry deterministically', () => {
    const first = createArtDirectedArchetypeRegistry()
    const second = createArtDirectedArchetypeRegistry()

    for (const id of SINGLE_BUILDING_ARCHETYPES) {
      for (const tier of [LodTier.near, LodTier.mid, LodTier.far]) {
        const firstPositions = first.get(id).geometry[tier]!.getAttribute('position').array
        const secondPositions = second.get(id).geometry[tier]!.getAttribute('position').array
        expect(Array.from(firstPositions)).toEqual(Array.from(secondPositions))
      }
    }

    first.dispose()
    second.dispose()
  })
})

function facilityInstance(entityId: number, color: number, x: number): RenderInstance {
  return {
    entityId,
    archetypeId: DefaultArchetype.facilityLarge,
    x,
    y: 0,
    z: 0,
    yaw: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    color,
  }
}

function rangeForTest(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}

function uniqueVertexColors(geometry: THREE.BufferGeometry): number {
  const color = geometry.getAttribute('color')
  const unique = new Set<string>()
  for (let index = 0; index < color.count; index++) {
    unique.add(`${color.getX(index).toFixed(3)}:${color.getY(index).toFixed(3)}:${color.getZ(index).toFixed(3)}`)
  }
  return unique.size
}

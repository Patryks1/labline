import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  DefaultArchetype,
  InstancedChunk,
  LodTier,
  type RenderInstance,
} from '../v2'
import {
  FacilityArchetype,
  IntegrationArchetype,
  SceneryArchetype,
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
      expect(definition.geometry.near).toBe(definition.geometry.mid)
      expect(definition.geometry.far).not.toBeNull()
      expect(definition.material.far).not.toBeNull()
    }
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
      drawCalls: 4,
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

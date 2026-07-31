import * as THREE from 'three'
import { LOD_TIERS, LodTier, type ArchetypeId, type ChunkId, type RenderInstance } from './types'

export const DefaultArchetype = {
  tree: 1,
  house: 2,
  cityTowerA: 3,
  cityTowerB: 4,
  warehouse: 5,
  facilitySmall: 100,
  facilityMedium: 101,
  facilityLarge: 102,
} as const

export interface ArchetypeDefinition {
  id: ArchetypeId
  name: string
  /** Null means this archetype is represented by the surface at that tier. */
  geometry: Readonly<Record<LodTier, THREE.BufferGeometry | null>>
  material: Readonly<Record<LodTier, THREE.Material | null>>
}

export class ArchetypeRegistry {
  private readonly definitions = new Map<ArchetypeId, ArchetypeDefinition>()
  // Definitions can be replaced while authored bundles stream in. Resident
  // chunks may still reference the previous geometry until their targeted
  // invalidation runs, so retain ownership and dispose every generation only
  // when the registry itself is retired.
  private readonly retiredDefinitions: ArchetypeDefinition[] = []

  register(definition: ArchetypeDefinition): void {
    if (!Number.isInteger(definition.id) || definition.id < 0) {
      throw new RangeError(`Invalid archetype ID ${definition.id}`)
    }
    if (this.definitions.has(definition.id)) {
      throw new Error(`Archetype ${definition.id} is already registered`)
    }
    this.definitions.set(definition.id, definition)
  }

  /** Replace an existing definition after an asynchronous authored asset load. */
  replace(definition: ArchetypeDefinition): void {
    const previous = this.definitions.get(definition.id)
    if (!previous) {
      throw new Error(`Cannot replace unknown archetype ${definition.id}`)
    }
    this.retiredDefinitions.push(previous)
    this.definitions.set(definition.id, definition)
  }

  get(id: ArchetypeId): ArchetypeDefinition {
    const definition = this.definitions.get(id)
    if (!definition) throw new Error(`Unknown archetype ${id}`)
    return definition
  }

  has(id: ArchetypeId): boolean {
    return this.definitions.has(id)
  }

  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    for (const definition of [...this.definitions.values(), ...this.retiredDefinitions]) {
      for (const tier of LOD_TIERS) {
        const geometry = definition.geometry[tier]
        const material = definition.material[tier]
        if (geometry) geometries.add(geometry)
        if (material) materials.add(material)
      }
    }
    for (const geometry of geometries) geometry.dispose()
    for (const material of materials) material.dispose()
    this.definitions.clear()
    this.retiredDefinitions.length = 0
  }
}

/**
 * A compact baseline registry. Integration may replace these with art-directed
 * recipes while preserving IDs and the chunk batching contract.
 */
export function createDefaultArchetypeRegistry(): ArchetypeRegistry {
  const registry = new ArchetypeRegistry()
  const nearMaterial = createTierMaterial('near', 0.72, 0.08)
  const midMaterial = createTierMaterial('mid', 0.82, 0.04)
  const farMaterial = createTierMaterial('far', 0.9, 0)

  const treeNear = ground(new THREE.ConeGeometry(0.34, 1, 6))
  const treeMid = ground(new THREE.ConeGeometry(0.34, 1, 4))
  const houseNear = ground(new THREE.BoxGeometry(0.72, 0.55, 0.62))
  const houseMid = ground(new THREE.BoxGeometry(0.72, 0.55, 0.62))
  const towerNear = ground(new THREE.BoxGeometry(0.7, 1, 0.7))
  const towerMid = ground(new THREE.BoxGeometry(0.7, 1, 0.7))
  const towerFar = ground(new THREE.BoxGeometry(0.7, 1, 0.7))
  const towerBNear = ground(new THREE.CylinderGeometry(0.4, 0.44, 1, 8))
  const towerBMid = ground(new THREE.CylinderGeometry(0.4, 0.44, 1, 5))
  const towerBFar = ground(new THREE.CylinderGeometry(0.4, 0.44, 1, 4))
  const warehouseNear = ground(new THREE.BoxGeometry(0.86, 0.42, 0.76))
  const warehouseMid = ground(new THREE.BoxGeometry(0.86, 0.42, 0.76))
  const facilitySmall = ground(new THREE.BoxGeometry(0.82, 0.62, 0.78))
  const facilityMedium = ground(new THREE.BoxGeometry(1, 0.8, 0.92))
  const facilityLarge = ground(new THREE.BoxGeometry(1.18, 1, 1.08))

  const materials = {
    near: nearMaterial,
    mid: midMaterial,
    far: farMaterial,
  } satisfies Record<LodTier, THREE.Material>
  const scenery = (
    id: ArchetypeId,
    name: string,
    near: THREE.BufferGeometry,
    mid: THREE.BufferGeometry,
    far: THREE.BufferGeometry | null,
  ) => registry.register({ id, name, geometry: { near, mid, far }, material: materials })

  scenery(DefaultArchetype.tree, 'tree', treeNear, treeMid, null)
  scenery(DefaultArchetype.house, 'house', houseNear, houseMid, null)
  scenery(DefaultArchetype.cityTowerA, 'city-tower-a', towerNear, towerMid, towerFar)
  scenery(DefaultArchetype.cityTowerB, 'city-tower-b', towerBNear, towerBMid, towerBFar)
  scenery(DefaultArchetype.warehouse, 'warehouse', warehouseNear, warehouseMid, null)
  scenery(
    DefaultArchetype.facilitySmall,
    'facility-small',
    facilitySmall,
    facilitySmall,
    facilitySmall,
  )
  scenery(
    DefaultArchetype.facilityMedium,
    'facility-medium',
    facilityMedium,
    facilityMedium,
    facilityMedium,
  )
  scenery(
    DefaultArchetype.facilityLarge,
    'facility-large',
    facilityLarge,
    facilityLarge,
    facilityLarge,
  )
  return registry
}

function createTierMaterial(name: LodTier, roughness: number, metalness: number) {
  const material = new THREE.MeshStandardMaterial({
    name: `shared-${name}-archetype-material`,
    color: 0xffffff,
    vertexColors: true,
    roughness,
    metalness,
    flatShading: name !== LodTier.near,
    transparent: false,
    depthWrite: true,
    dithering: false,
  })
  return material
}

function ground<T extends THREE.BufferGeometry>(geometry: T): T {
  geometry.computeBoundingBox()
  const minY = geometry.boundingBox?.min.y ?? 0
  geometry.translate(0, -minY, 0)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

export interface ChunkInstanceStats {
  drawCalls: number
  instances: number
  capacity: number
  triangles: number
  missingInstances: number
}

/** Per-chunk InstancedMesh batches whose capacities equal their actual contents. */
export class InstancedChunk {
  readonly chunkId: ChunkId
  readonly tier: LodTier
  readonly revision: number
  readonly root = new THREE.Group()
  readonly stats: ChunkInstanceStats

  private readonly meshes: THREE.InstancedMesh[] = []
  private readonly capacitiesByArchetype = new Map<ArchetypeId, number>()

  constructor(
    chunkId: ChunkId,
    tier: LodTier,
    revision: number,
    records: readonly RenderInstance[],
    registry: ArchetypeRegistry,
  ) {
    this.chunkId = chunkId
    this.tier = tier
    this.revision = revision
    this.root.name = `chunk-${chunkId}-${tier}`
    this.root.userData.chunkId = chunkId
    this.root.userData.lodTier = tier
    this.root.userData.revision = revision

    const batches = new Map<
      string,
      {
        geometry: THREE.BufferGeometry
        material: THREE.Material
        records: RenderInstance[]
        archetypeIds: Set<ArchetypeId>
      }
    >()
    let missingInstances = 0
    for (const record of records) {
      const definition = registry.get(record.archetypeId)
      const geometry = definition.geometry[tier]
      const material = definition.material[tier]
      if (!geometry || !material) {
        missingInstances++
        continue
      }
      this.capacitiesByArchetype.set(
        record.archetypeId,
        (this.capacitiesByArchetype.get(record.archetypeId) ?? 0) + 1,
      )
      const key = `${geometry.uuid}:${material.uuid}`
      const batch = batches.get(key)
      if (batch) {
        batch.records.push(record)
        batch.archetypeIds.add(record.archetypeId)
      } else {
        batches.set(key, {
          geometry,
          material,
          records: [record],
          archetypeIds: new Set([record.archetypeId]),
        })
      }
    }

    let instances = 0
    let triangles = 0
    for (const batch of batches.values()) {
      const mesh = buildInstanceMesh(
        chunkId,
        tier,
        [...batch.archetypeIds],
        batch.geometry,
        batch.material,
        batch.records,
      )
      this.meshes.push(mesh)
      this.root.add(mesh)
      instances += batch.records.length
      const primitiveCount = batch.geometry.index
        ? batch.geometry.index.count / 3
        : batch.geometry.getAttribute('position').count / 3
      triangles += primitiveCount * batch.records.length
    }
    this.stats = {
      drawCalls: this.meshes.length,
      instances,
      capacity: instances,
      triangles,
      missingInstances,
    }
  }

  capacityFor(archetypeId: ArchetypeId): number {
    return this.capacitiesByArchetype.get(archetypeId) ?? 0
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      this.root.remove(mesh)
      // InstancedMesh owns instance buffers, but not the shared geometry/material.
      mesh.dispose()
    }
    this.meshes.length = 0
    this.root.clear()
  }
}

function buildInstanceMesh(
  chunkId: ChunkId,
  tier: LodTier,
  archetypeIds: readonly ArchetypeId[],
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  records: readonly RenderInstance[],
): THREE.InstancedMesh {
  const capacity = records.length
  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.name = `chunk-${chunkId}-${tier}-archetypes-${archetypeIds.join('-')}`
  mesh.userData.chunkId = chunkId
  mesh.userData.lodTier = tier
  mesh.userData.archetypeId = archetypeIds[0]
  mesh.userData.archetypeIds = [...archetypeIds]
  // Instance order is stable within this immutable batch. Keep the logical
  // owner cell beside the GPU buffer so raycast instanceId can resolve a
  // visible prop without guessing from its overhanging world-space geometry.
  mesh.userData.pickTileIds = records.map((record) => record.pickTileId ?? null)
  mesh.count = capacity
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.frustumCulled = true
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)

  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const localBounds = geometry.boundingBox ?? new THREE.Box3()
  const worldBounds = new THREE.Box3()
  const transformedBounds = new THREE.Box3()
  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  const color = new THREE.Color()
  const yAxis = new THREE.Vector3(0, 1, 0)

  for (let index = 0; index < records.length; index++) {
    const record = records[index]!
    position.set(record.x, record.y, record.z)
    quaternion.setFromAxisAngle(yAxis, record.yaw)
    scale.set(record.scaleX, record.scaleY, record.scaleZ)
    matrix.compose(position, quaternion, scale)
    mesh.setMatrixAt(index, matrix)
    color.setHex(record.color)
    mesh.setColorAt(index, color)
    transformedBounds.copy(localBounds).applyMatrix4(matrix)
    worldBounds.union(transformedBounds)
  }

  mesh.instanceMatrix.addUpdateRange(0, capacity * 16)
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) {
    mesh.instanceColor.setUsage(THREE.StaticDrawUsage)
    mesh.instanceColor.addUpdateRange(0, capacity * 3)
    mesh.instanceColor.needsUpdate = true
  }
  // Bounds include every transformed archetype, so culling cannot clip tall props.
  mesh.boundingBox = worldBounds.clone()
  mesh.boundingSphere = worldBounds.getBoundingSphere(new THREE.Sphere())
  return mesh
}

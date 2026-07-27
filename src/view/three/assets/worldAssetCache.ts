import * as THREE from 'three'
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { LodTier, type ArchetypeRegistry } from '../v2'
import {
  WORLD_ASSET_MANIFEST_URL,
  parseWorldAssetManifest,
  type WorldAssetFamily,
  type WorldAssetManifest,
  type WorldModelEntry,
} from './worldAssetManifest'

export type AuthoredGeometrySet = Readonly<Record<LodTier, THREE.BufferGeometry>>

export interface WorldAssetSnapshot {
  readonly revision: number
  readonly geometryByArchetype: ReadonlyMap<number, AuthoredGeometrySet>
  readonly failedFamilies: ReadonlySet<WorldAssetFamily>
}

export interface WorldAssetFamilySnapshot {
  readonly family: WorldAssetFamily
  readonly archetypeIds: readonly number[]
  readonly snapshot: WorldAssetSnapshot
  readonly metrics?: WorldAssetFamilyMetrics
}

export interface WorldAssetFamilyMetrics {
  readonly bytes: number
  readonly models: number
  readonly fetchAndHashMs: number
  readonly decodeMs: number
  readonly extractMs: number
  readonly totalMs: number
}

type FetchLike = typeof fetch

/**
 * Streaming cache for committed GLBs. Requests are deduplicated per family;
 * failed bundles remain procedural fallbacks and never poison other families.
 */
export class WorldAssetCache {
  private manifestPromise: Promise<WorldAssetManifest> | null = null
  private readonly familyRequests = new Map<WorldAssetFamily, Promise<void>>()
  private readonly geometryByArchetype = new Map<number, AuthoredGeometrySet>()
  private readonly failedFamilies = new Set<WorldAssetFamily>()
  private readonly familyMetrics = new Map<WorldAssetFamily, WorldAssetFamilyMetrics>()
  private readonly controller = new AbortController()
  private loaderPromise: Promise<GLTFLoader> | null = null
  private revisionValue = 0
  private disposed = false
  private readonly fetcher: FetchLike
  private readonly manifestUrl: string

  constructor(
    fetcher: FetchLike = fetch,
    manifestUrl = WORLD_ASSET_MANIFEST_URL,
  ) {
    this.fetcher = fetcher
    this.manifestUrl = manifestUrl
  }

  get revision(): number { return this.revisionValue }

  async loadCritical(): Promise<WorldAssetSnapshot> {
    await this.loadFamilies(['residential', 'urban', 'industrial', 'facilities', 'municipal'])
    return this.snapshot()
  }

  async loadEnvironment(): Promise<WorldAssetSnapshot> {
    await this.loadFamilies(['terrain', 'vegetation', 'props'])
    return this.snapshot()
  }

  async loadLife(): Promise<WorldAssetSnapshot> {
    await this.loadFamilies(['vehicles', 'boats', 'ducks'])
    return this.snapshot()
  }

  async loadAll(): Promise<WorldAssetSnapshot> {
    const manifest = await this.manifest()
    // Parsing every GLB in one Promise.all burst creates a visible main-thread
    // hitch just after the map appears. Decode one family per task so input and
    // rendering get a chance to run between bundles, then publish one atomic
    // snapshot to the viewport when the complete pack is ready.
    for (const bundle of manifest.bundles) {
      await this.loadFamilies([bundle.family])
      await yieldToHost()
    }
    return this.snapshot()
  }

  /**
   * Stream one fully validated family at a time. Consumers can replace only
   * affected live batches instead of rebuilding the complete map projection
   * when the final bundle finishes.
   */
  async *streamAll(): AsyncGenerator<WorldAssetFamilySnapshot> {
    const manifest = await this.manifest()
    for (const bundle of manifest.bundles) {
      await this.loadFamilies([bundle.family])
      const archetypeIds = this.failedFamilies.has(bundle.family)
        ? []
        : manifest.models
          .filter(model => model.family === bundle.family)
          .map(model => model.archetypeId)
      yield {
        family: bundle.family,
        archetypeIds: Object.freeze(archetypeIds),
        snapshot: this.snapshot(),
        metrics: this.familyMetrics.get(bundle.family),
      }
      await yieldToHost()
    }
  }

  snapshot(): WorldAssetSnapshot {
    return {
      revision: this.revisionValue,
      geometryByArchetype: new Map(this.geometryByArchetype),
      failedFamilies: new Set(this.failedFamilies),
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.controller.abort()
    for (const tiers of this.geometryByArchetype.values()) {
      for (const tier of Object.values(tiers)) tier.dispose()
    }
    this.geometryByArchetype.clear()
    this.familyRequests.clear()
  }

  private async manifest(): Promise<WorldAssetManifest> {
    if (!this.manifestPromise) {
      this.manifestPromise = this.fetcher(this.manifestUrl, { signal: this.controller.signal })
        .then(assertResponse)
        .then(response => response.json())
        .then(parseWorldAssetManifest)
    }
    return this.manifestPromise
  }

  private async loadFamilies(families: readonly WorldAssetFamily[]): Promise<void> {
    if (this.disposed) throw new Error('World asset cache is disposed')
    const manifest = await this.manifest()
    await Promise.all(families.map(family => {
      let request = this.familyRequests.get(family)
      if (!request) {
        request = this.loadFamily(manifest, family).catch(error => {
          if (!this.controller.signal.aborted) this.failedFamilies.add(family)
          if (error instanceof DOMException && error.name === 'AbortError') return
          // Bundle failures intentionally resolve: the procedural registry is
          // the resilience path, while failedFamilies exposes diagnostics.
        })
        this.familyRequests.set(family, request)
      }
      return request
    }))
  }

  private async loadFamily(manifest: WorldAssetManifest, family: WorldAssetFamily): Promise<void> {
    const started = now()
    const bundle = manifest.bundles.find(candidate => candidate.family === family)
    if (!bundle) throw new Error(`Missing ${family} bundle`)
    const response = await this.fetcher(bundle.url, { signal: this.controller.signal }).then(assertResponse)
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength !== bundle.bytes) throw new Error(`${family} bundle length mismatch`)
    if (await sha256(bytes) !== bundle.sha256) throw new Error(`${family} bundle hash mismatch`)
    const validated = now()
    const loader = await this.loader()
    const gltf = await loader.parseAsync(bytes, bundle.url.slice(0, bundle.url.lastIndexOf('/') + 1))
    gltf.scene.updateMatrixWorld(true)
    const decoded = now()
    const staged = new Map<number, AuthoredGeometrySet>()
    for (const model of manifest.models.filter(candidate => candidate.family === family)) {
      staged.set(model.archetypeId, extractModel(gltf.scene, model))
    }
    for (const [id, geometry] of staged) this.geometryByArchetype.set(id, geometry)
    this.failedFamilies.delete(family)
    this.revisionValue++
    const completed = now()
    this.familyMetrics.set(family, {
      bytes: bundle.bytes,
      models: staged.size,
      fetchAndHashMs: validated - started,
      decodeMs: decoded - validated,
      extractMs: completed - decoded,
      totalMs: completed - started,
    })
  }

  private loader(): Promise<GLTFLoader> {
    if (!this.loaderPromise) {
      this.loaderPromise = Promise.all([
        import('three/examples/jsm/loaders/GLTFLoader.js'),
        import('three/examples/jsm/libs/meshopt_decoder.module.js'),
      ]).then(([{ GLTFLoader }, { MeshoptDecoder }]) =>
        new GLTFLoader().setMeshoptDecoder(MeshoptDecoder),
      )
    }
    return this.loaderPromise
  }
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

/** Swap authored LOD geometry into an existing procedural registry. */
export function applyWorldAssetSnapshot(
  registry: ArchetypeRegistry,
  snapshot: WorldAssetSnapshot,
  archetypeIds?: ReadonlySet<number>,
): number {
  let applied = 0
  for (const [archetypeId, geometry] of snapshot.geometryByArchetype) {
    if (archetypeIds && !archetypeIds.has(archetypeId)) continue
    if (!registry.has(archetypeId)) continue
    const previous = registry.get(archetypeId)
    // A registry owns and disposes its definitions, while the cache must stay
    // alive across projection rebuilds. Give each registry its own geometry
    // wrappers so disposing one viewport cannot invalidate the cached pack.
    registry.replace({
      ...previous,
      geometry: {
        near: geometry.near.clone(),
        mid: geometry.mid.clone(),
        far: geometry.far.clone(),
      },
    })
    applied++
  }
  return applied
}

function extractModel(scene: THREE.Object3D, model: WorldModelEntry): AuthoredGeometrySet {
  return {
    near: extractNode(scene, model.nodes.near, model.tintMode),
    mid: extractNode(scene, model.nodes.mid, model.tintMode),
    far: extractNode(scene, model.nodes.far, model.tintMode),
  }
}

function extractNode(scene: THREE.Object3D, nodeName: string, tintMode: WorldModelEntry['tintMode']): THREE.BufferGeometry {
  const node = scene.getObjectByName(nodeName)
  if (!node) throw new Error(`Authored GLB is missing node ${nodeName}`)
  node.updateWorldMatrix(true, true)
  const pieces: THREE.BufferGeometry[] = []
  node.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !(object.geometry instanceof THREE.BufferGeometry)) return
    // Preserve authored indices. Expanding every GLB mesh to non-indexed data
    // duplicated shared vertices (often 3x) before upload and defeated the
    // GPU post-transform vertex cache without changing the rendered model.
    const piece = object.geometry.clone()
    piece.applyMatrix4(object.matrixWorld)
    ensureColor(piece, object.material)
    const ownerMix = new Float32Array(piece.getAttribute('position').count)
    if (tintMode === 'owner') ownerMix.fill(1)
    piece.setAttribute('ownerMix', new THREE.BufferAttribute(ownerMix, 1))
    pieces.push(piece)
  })
  if (pieces.length === 0) throw new Error(`Authored node ${nodeName} has no mesh geometry`)
  const merged = mergeGeometries(pieces, false)
  for (const piece of pieces) piece.dispose()
  if (!merged) throw new Error(`Authored node ${nodeName} could not be merged`)
  merged.computeVertexNormals(); merged.computeBoundingBox(); merged.computeBoundingSphere()
  const minY = merged.boundingBox?.min.y ?? 0
  if (Math.abs(minY) > 1e-4) merged.translate(0, -minY, 0)
  merged.name = nodeName
  return merged
}

function ensureColor(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[]): void {
  if (geometry.hasAttribute('color')) return
  const source = Array.isArray(material) ? material[0] : material
  const color = source instanceof THREE.MeshStandardMaterial ? source.color : new THREE.Color(0xffffff)
  const values = new Float32Array(geometry.getAttribute('position').count * 3)
  for (let index = 0; index < values.length; index += 3) color.toArray(values, index)
  geometry.setAttribute('color', new THREE.BufferAttribute(values, 3))
}

function assertResponse(response: Response): Response {
  if (!response.ok) throw new Error(`Asset request failed (${response.status})`)
  return response
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}

function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

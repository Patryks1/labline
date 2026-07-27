import * as THREE from 'three'
import {
  ArchetypeRegistry,
  InstancedChunk,
  createDefaultArchetypeRegistry,
} from './archetypes'
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_RETAINED_CHUNKS,
  ViewportChunkManager,
  type ChunkSelection,
} from './chunks'
import { ScreenSpaceLod, type LodSnapshot } from './lod'
import { ViewportRendererMetrics } from './metrics'
import { CloudLayer } from './cloudLayer'
import { EnvironmentLifeLayer } from './environmentLifeLayer'
import { MunicipalPowerLayer } from './municipalPowerLayer'
import { MapSurfaceLayer } from './surfaceLayer'
import { TrafficLayer } from './trafficLayer'
import { WorldVoidLayer } from './worldVoidLayer'
import {
  LOD_TIERS,
  LodTier,
  type ChunkId,
  type RenderInstance,
  type SurfaceTexel,
  type TileBounds,
  type TileId,
  type ViewportRenderSource,
} from './types'

export interface ViewportMapRendererOptions {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  source: ViewportRenderSource
  registry?: ArchetypeRegistry
  chunkSize?: number
  maxRetainedChunks?: number
  initialLod?: LodTier
  lodTransitionMs?: number
  trafficLimits?: { logical?: number; visible?: number }
}

interface ChunkLayerRecord {
  chunk: InstancedChunk
  revision: number
}

export interface ViewportUpdateResult {
  chunks: ChunkSelection
  lod: LodSnapshot
  prewarming: boolean
}

export interface ViewportObjectPick {
  readonly point: THREE.Vector3
  readonly tileId: TileId
}

const PREWARM_BUILD_BUDGET_MS = 0.8

/**
 * Standalone WebGLRenderer foundation. It owns only render projections and
 * never mutates world/simulation state, keeping player and rivals on one shared
 * simulation path.
 */
export class ViewportMapRenderer {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly source: ViewportRenderSource
  readonly surface: MapSurfaceLayer
  readonly chunks: ViewportChunkManager
  readonly registry: ArchetypeRegistry
  readonly lod: ScreenSpaceLod
  readonly metrics: ViewportRendererMetrics
  readonly clouds: CloudLayer
  readonly traffic: TrafficLayer
  readonly environmentLife: EnvironmentLifeLayer
  readonly municipalPower: MunicipalPowerLayer
  readonly worldVoid: WorldVoidLayer
  readonly chunkRoot = new THREE.Group()

  private readonly ownsRegistry: boolean
  private readonly chunkLayers = new Map<string, ChunkLayerRecord>()
  private lastPixelsPerTile = 16
  private disposed = false

  constructor(options: ViewportMapRendererOptions) {
    this.renderer = options.renderer
    this.scene = options.scene
    this.source = options.source
    this.ownsRegistry = options.registry === undefined
    this.registry = options.registry ?? createDefaultArchetypeRegistry()
    this.clouds = new CloudLayer({
      width: this.source.width,
      height: this.source.height,
      tileSize: this.source.tileSize,
    })
    this.traffic = new TrafficLayer(this.registry, options.trafficLimits)
    this.environmentLife = new EnvironmentLifeLayer(this.registry)
    this.municipalPower = new MunicipalPowerLayer()
    this.worldVoid = new WorldVoidLayer({
      width: this.source.width,
      height: this.source.height,
      tileSize: this.source.tileSize,
    })
    const initialLod = options.initialLod ?? LodTier.mid
    this.lod = new ScreenSpaceLod(initialLod, options.lodTransitionMs ?? 200)
    this.metrics = new ViewportRendererMetrics(initialLod)
    this.chunks = new ViewportChunkManager(
      this.source.width,
      this.source.height,
      options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      options.maxRetainedChunks ?? DEFAULT_RETAINED_CHUNKS,
    )
    this.surface = new MapSurfaceLayer({
      width: this.source.width,
      height: this.source.height,
      tileSize: this.source.tileSize,
      source: this.source,
      chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
    })
    this.surface.data.fill((tileId, out) => this.source.readSurface(tileId, out))
    // Guarantee the complete initial image is resident before partial updates.
    this.renderer.initTexture(this.surface.data.texture)
    this.chunkRoot.name = 'viewport-prop-chunks'
    this.scene.add(this.worldVoid.mesh)
    this.scene.add(this.surface.mesh)
    this.scene.add(this.chunkRoot)
    this.scene.add(this.traffic.root)
    this.scene.add(this.environmentLife.root)
    this.scene.add(this.municipalPower.root)
    this.scene.add(this.clouds.root)
    this.metrics.addSurfaceUpload(this.surface.data.data.length, this.surface.data.tileCount)
  }

  /** Update changed surface cells and queue one contiguous upload span per row. */
  updateSurface(tileIds: Iterable<TileId>): void {
    this.assertLive()
    const out: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    for (const tileId of tileIds) {
      out.transport = undefined
      this.source.readSurface(tileId, out)
      this.surface.data.set(tileId, out)
    }
    const upload = this.surface.data.commitUpdates()
    this.metrics.addSurfaceUpload(upload.bytes, upload.tiles)
  }

  /** Re-read the full compact surface after loading or replacing a world. */
  updateEntireSurface(): void {
    this.assertLive()
    this.surface.data.fill((tileId, out) => this.source.readSurface(tileId, out))
    this.renderer.initTexture(this.surface.data.texture)
    this.metrics.addSurfaceUpload(this.surface.data.data.length, this.surface.data.tileCount)
  }

  /**
   * Reconcile viewport chunks and screen-space LOD. Call on a chunk-boundary,
   * LOD-threshold, or world-journal change rather than on every React render.
   */
  updateViewport(bounds: TileBounds, pixelsPerTile: number, nowMs: number): ViewportUpdateResult {
    this.assertLive()
    this.lastPixelsPerTile = Math.max(0, pixelsPerTile)
    const selection = this.chunks.update(bounds)
    // Surface chunks are immutable for a revision. Retain recently visible
    // buffers in the bounded resident cache so a short pan does not rebuild
    // terrain, roads, water, and bridges on the return trip.
    this.surface.updateVisibleChunks(
      selection.visible,
      (chunkId) => this.chunks.chunkBounds(chunkId),
      selection.resident,
    )
    const recordCache = new Map<string, readonly RenderInstance[] | null>()
    const recordsFor = (chunkId: ChunkId, tier: LodTier) => {
      const key = chunkLayerKey(chunkId, tier)
      if (recordCache.has(key)) return recordCache.get(key) ?? null
      const records = this.source.getChunkInstances(chunkId, tier)
      recordCache.set(key, records)
      return records
    }

    const isReady = (tier: LodTier) => {
      for (const chunkId of selection.visible) {
        if (recordsFor(chunkId, tier) === null) return false
      }
      return true
    }
    const lod = this.lod.update(this.lastPixelsPerTile, nowMs, isReady)
    const visibleKeys = new Set<string>()
    const retainedKeys = new Set<string>()
    const buildStarted = performance.now()
    let pendingChunks = 0
    let pendingPrewarm = 0

    const ensureLayer = (chunkId: ChunkId, tier: LodTier, visible: boolean) => {
      const key = chunkLayerKey(chunkId, tier)
      this.source.prepareChunk?.(chunkId, tier)
      const records = recordsFor(chunkId, tier)
      const existing = this.chunkLayers.get(key)
      if (records === null) {
        if (visible) pendingChunks++
        // A journal invalidation may make the replacement briefly pending.
        // Keep the last complete GPU layer instead of flashing the chunk out.
        if (existing) {
          existing.chunk.setVisible(visible)
          retainedKeys.add(key)
          if (visible) visibleKeys.add(key)
        }
        return false
      }

      retainedKeys.add(key)
      if (visible) visibleKeys.add(key)
      const revision = this.source.getChunkRevision(chunkId)
      if (existing && existing.revision === revision) {
        existing.chunk.setVisible(visible)
        return true
      }

      // Construct and attach the replacement before retiring the old buffers.
      // There is no render between these operations, so a failed build leaves
      // the last valid layer intact and a successful build swaps atomically.
      const replacement = new InstancedChunk(
        chunkId,
        tier,
        revision,
        records,
        this.registry,
      )
      replacement.setVisible(visible)
      this.chunkRoot.add(replacement.root)
      if (existing) {
        this.chunkRoot.remove(existing.chunk.root)
        existing.chunk.dispose()
      }
      this.chunkLayers.set(key, { chunk: replacement, revision })
      return true
    }

    for (const tier of LOD_TIERS) this.registry.setTierCoverage(tier, 0)
    for (let layerIndex = 0; layerIndex < lod.layers.length; layerIndex++) {
      const layer = lod.layers[layerIndex]!
      const direction = lod.layers.length === 2 && layerIndex === 0 ? 'outgoing' : 'incoming'
      this.registry.setTierCoverage(layer.tier, layer.coverage, direction)
      for (const chunkId of selection.visible) {
        ensureLayer(chunkId, layer.tier, true)
      }
    }

    // Materialize the one-chunk guard ring while it is hidden. Boundary pans
    // then toggle existing buffers instead of rebuilding or exposing a blank.
    // Keep only tiers participating in the current/next transition hot. The
    // old strategy retained near+mid+far for every guarded chunk, tripling GPU
    // instance buffers even though at most two tiers can be displayed.
    const retainedTiers = new Set<LodTier>([
      lod.active,
      lod.desired,
      ...lod.layers.map(layer => layer.tier),
    ])
    const prewarmCandidates: Array<readonly [ChunkId, LodTier]> = []
    for (const chunkId of selection.visible) {
      for (const tier of retainedTiers) {
        if (!visibleKeys.has(chunkLayerKey(chunkId, tier))) {
          prewarmCandidates.push([chunkId, tier])
        }
      }
    }
    for (const chunkId of selection.prefetch) {
      for (const tier of retainedTiers) prewarmCandidates.push([chunkId, tier])
    }
    for (const [chunkId, tier] of prewarmCandidates) {
      const key = chunkLayerKey(chunkId, tier)
      const existing = this.chunkLayers.get(key)
      const current = existing?.revision === this.source.getChunkRevision(chunkId)
      if (current) {
        existing.chunk.setVisible(false)
        retainedKeys.add(key)
        continue
      }
      if (performance.now() - buildStarted >= PREWARM_BUILD_BUDGET_MS) {
        if (existing) {
          existing.chunk.setVisible(false)
          retainedKeys.add(key)
        }
        pendingPrewarm++
        continue
      }
      if (!ensureLayer(chunkId, tier, false)) pendingPrewarm++
    }

    for (const [key, record] of this.chunkLayers) {
      if (visibleKeys.has(key)) continue
      if (retainedKeys.has(key)) record.chunk.setVisible(false)
      else this.removeChunkLayer(key, record)
    }
    this.traffic.update(selection.visible, this.chunks, this.source)
    this.environmentLife.update(selection.visible, this.chunks, this.source)
    this.municipalPower.update(selection.visible, this.chunks, this.source)
    this.updateMetrics(selection, lod, pendingChunks, performance.now() - buildStarted)
    return { chunks: selection, lod, prewarming: pendingPrewarm > 0 }
  }

  setFrame(timeSeconds: number, pixelsPerTile = this.lastPixelsPerTile): void {
    this.assertLive()
    this.lastPixelsPerTile = Math.max(0, pixelsPerTile)
    this.surface.setFrame(
      timeSeconds,
      this.lastPixelsPerTile,
      this.source.isSimulationPaused?.() ?? false,
    )
    this.setTrafficFrame(timeSeconds)
    this.environmentLife.setFrame(timeSeconds)
    this.municipalPower.setFrame(timeSeconds)
    this.worldVoid.setFrame(timeSeconds)
    this.clouds.setFrame(timeSeconds, this.source.isSimulationPaused?.() ?? false)
  }

  /** External UI integrations can toggle clouds without rebuilding the world. */
  setCloudsVisible(visible: boolean): void {
    this.assertLive()
    this.clouds.setVisible(visible)
  }

  /** Advance render-only lane traffic; gameplay congestion remains canonical. */
  setTrafficFrame(timeSeconds: number): void {
    this.assertLive()
    this.traffic.setFrame(timeSeconds)
  }

  render(camera: THREE.Camera, timeSeconds: number): void {
    this.setFrame(timeSeconds)
    this.renderer.render(this.scene, camera)
    this.metrics.captureRenderer(this.renderer)
  }

  /** Nearest true terrain/deck hit; water is intentionally not selectable. */
  raycastTerrain(raycaster: THREE.Raycaster): THREE.Intersection | null {
    this.assertLive()
    const hits = raycaster.intersectObjects(this.surface.pickObjects, true)
    return hits[0] ?? null
  }

  /** Resolve a rendered prop to its authoritative logical owner cell. */
  raycastSelectable(raycaster: THREE.Raycaster): ViewportObjectPick | null {
    this.assertLive()
    const hits = raycaster.intersectObject(this.chunkRoot, true)
    for (const hit of hits) {
      if (hit.instanceId === undefined) continue
      const ids = hit.object.userData.pickTileIds as readonly (TileId | null)[] | undefined
      const tileId = ids?.[hit.instanceId]
      if (tileId !== null && tileId !== undefined) return { point: hit.point, tileId }
    }
    return null
  }

  sampleTerrainHeight(worldX: number, worldZ: number): number {
    return this.surface.sampleHeight(worldX, worldZ)
  }

  /** Compile the finite surface/archetype shader set without a first-pan hitch. */
  async warmup(camera: THREE.Camera): Promise<void> {
    this.assertLive()
    await this.renderer.compileAsync(this.scene, camera)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [key, record] of this.chunkLayers) this.removeChunkLayer(key, record)
    this.scene.remove(this.chunkRoot)
    this.scene.remove(this.surface.mesh)
    this.scene.remove(this.traffic.root)
    this.scene.remove(this.environmentLife.root)
    this.scene.remove(this.municipalPower.root)
    this.scene.remove(this.worldVoid.mesh)
    this.scene.remove(this.clouds.root)
    this.chunkRoot.clear()
    this.surface.dispose()
    this.traffic.dispose()
    this.environmentLife.dispose()
    this.municipalPower.dispose()
    this.worldVoid.dispose()
    this.clouds.dispose()
    if (this.ownsRegistry) this.registry.dispose()
  }

  private removeChunkLayer(key: string, record: ChunkLayerRecord): void {
    this.chunkRoot.remove(record.chunk.root)
    record.chunk.dispose()
    this.chunkLayers.delete(key)
  }

  private updateMetrics(
    selection: ChunkSelection,
    lod: LodSnapshot,
    pendingChunks: number,
    chunkBuildMs: number,
  ): void {
    let instances = 0
    let capacity = 0
    let drawCalls = 0
    let triangles = 0
    drawCalls += 1
    triangles += 2
    for (const root of [
      this.surface.terrainRoot,
      this.surface.waterRoot,
      this.surface.foamRoot,
      this.surface.roadRoot,
      this.surface.bridgeRoot,
      this.surface.edgeRoot,
    ]) {
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || !object.visible) return
        const geometry = object.geometry
        const primitiveCount = geometry.index?.count
          ? geometry.index.count / 3
          : geometry.getAttribute('position').count / 3
        triangles += primitiveCount
        drawCalls += Array.isArray(object.material)
          ? Math.max(1, geometry.groups.length)
          : 1
      })
    }
    let missingInstances = 0
    for (const record of this.chunkLayers.values()) {
      if (!record.chunk.root.visible) continue
      instances += record.chunk.stats.instances
      capacity += record.chunk.stats.capacity
      drawCalls += record.chunk.stats.drawCalls
      triangles += record.chunk.stats.triangles
      missingInstances += record.chunk.stats.missingInstances
    }
    instances += this.traffic.stats.instances
    capacity += this.traffic.stats.instances
    drawCalls += this.traffic.stats.drawCalls
    triangles += this.traffic.stats.triangles
    instances += this.environmentLife.stats.instances
    capacity += this.environmentLife.stats.instances
    drawCalls += this.environmentLife.stats.drawCalls
    triangles += this.environmentLife.stats.triangles
    if (this.clouds.root.visible) {
      drawCalls += this.clouds.stats.drawCalls
      triangles += this.clouds.stats.triangles
    }
    this.metrics.set({
      visibleChunks: selection.visible.size,
      prefetchedChunks: selection.prefetch.size,
      residentChunks: selection.resident.size,
      gpuChunkLayers: this.chunkLayers.size,
      pendingChunks,
      missingInstances,
      instances,
      instanceCapacity: capacity,
      estimatedDrawCalls: drawCalls,
      estimatedTriangles: triangles,
      chunkBuildMs,
      lodActive: lod.active,
      lodDesired: lod.desired,
    })
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('ViewportMapRenderer has been disposed')
  }
}

function chunkLayerKey(chunkId: ChunkId, tier: LodTier): string {
  return `${chunkId}:${tier}`
}

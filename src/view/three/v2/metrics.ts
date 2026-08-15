import type * as THREE from 'three'
import type { LodTier } from './types'

export interface ViewportRendererMetricsSnapshot {
  visibleChunks: number
  prefetchedChunks: number
  residentChunks: number
  gpuChunkLayers: number
  pendingChunks: number
  missingInstances: number
  instances: number
  instanceCapacity: number
  estimatedDrawCalls: number
  estimatedTriangles: number
  rendererDrawCalls: number
  rendererTriangles: number
  surfaceUploadBytes: number
  surfaceUploadTiles: number
  trafficSteps: number
  trafficReconciles: number
  trafficRebuilds: number
  trafficUploadBytes: number
  municipalEffectInstances: number
  constructionInstances: number
  chunkBuildMs: number
  lodActive: LodTier
  lodDesired: LodTier
}

export class ViewportRendererMetrics {
  private state: ViewportRendererMetricsSnapshot

  constructor(initialTier: LodTier) {
    this.state = {
      visibleChunks: 0,
      prefetchedChunks: 0,
      residentChunks: 0,
      gpuChunkLayers: 0,
      pendingChunks: 0,
      missingInstances: 0,
      instances: 0,
      instanceCapacity: 0,
      estimatedDrawCalls: 1,
      estimatedTriangles: 2,
      rendererDrawCalls: 0,
      rendererTriangles: 0,
      surfaceUploadBytes: 0,
      surfaceUploadTiles: 0,
      trafficSteps: 0,
      trafficReconciles: 0,
      trafficRebuilds: 0,
      trafficUploadBytes: 0,
      municipalEffectInstances: 0,
      constructionInstances: 0,
      chunkBuildMs: 0,
      lodActive: initialTier,
      lodDesired: initialTier,
    }
  }

  set(values: Partial<ViewportRendererMetricsSnapshot>): void {
    Object.assign(this.state, values)
  }

  addSurfaceUpload(bytes: number, tiles: number): void {
    this.state.surfaceUploadBytes += bytes
    this.state.surfaceUploadTiles += tiles
  }

  captureRenderer(renderer: THREE.WebGLRenderer): void {
    this.state.rendererDrawCalls = renderer.info.render.calls
    this.state.rendererTriangles = renderer.info.render.triangles
  }

  resetCumulativeUploads(): void {
    this.state.surfaceUploadBytes = 0
    this.state.surfaceUploadTiles = 0
  }

  snapshot(): Readonly<ViewportRendererMetricsSnapshot> {
    return { ...this.state }
  }
}

import { summarizeSamples, type SampleStats } from './perfHarness'

export type CameraInteraction = 'idle' | 'pan' | 'zoom' | 'teleport'
export type RenderLod = 'near' | 'mid' | 'far'

export interface CameraPose {
  targetX: number
  targetY: number
  zoom: number
  rotation: number
  tilt: number
}

export interface CameraReplayFrame {
  index: number
  atMs: number
  interaction: CameraInteraction
  pose: CameraPose
}

export interface CameraReplay {
  id: string
  mapWidth: number
  mapHeight: number
  durationMs: number
  frames: CameraReplayFrame[]
}

export interface CameraReplayOptions {
  id?: string
  fps?: number
  nearZoom?: number
  farZoom?: number
}

export interface FrameMetricSample {
  timestampMs: number
  frameMs: number
  cpuMs?: number
  gpuMs?: number
  interaction: CameraInteraction
  lod: RenderLod
  drawCalls: number
  triangles: number
  visibleChunks: number
  residentCpuChunks: number
  gpuChunkLayers: number
  activeInstances: number
  uploadBytes: number
  trafficSteps?: number
  trafficReconciles?: number
  trafficRebuilds?: number
  trafficUploadBytes?: number
  municipalEffectInstances?: number
  chunkWorkMs: number
  journalBacklog: number
  missingTiles: number
  capacityRejects: number
  closeUpPlaceholders: number
}

export interface FrameStatsSummary {
  sampleCount: number
  frameMs: SampleStats
  cpuMs: SampleStats
  gpuMs: SampleStats
  idleFrameMs: SampleStats
  interactionFrameMs: SampleStats
  framesOver33MsRatio: number
  maxDrawCalls: Record<RenderLod, number>
  maxTriangles: Record<RenderLod, number>
  maxVisibleChunks: number
  maxResidentCpuChunks: number
  maxGpuChunkLayers: number
  maxActiveInstances: number
  maxUploadBytes: number
  maxChunkWorkMs: number
  maxJournalBacklog: number
  totalMissingTiles: number
  totalCapacityRejects: number
  totalCloseUpPlaceholders: number
}

export interface FrameStatsCollector {
  readonly capacity: number
  record(sample: FrameMetricSample): void
  reset(): void
  samples(): readonly FrameMetricSample[]
  summary(): FrameStatsSummary
}

export interface LablinePerfController {
  readonly replay: CameraReplay
  readonly collector: FrameStatsCollector
  nextFrame(): CameraReplayFrame | undefined
  record(sample: FrameMetricSample): void
  reset(): void
  report(): FrameStatsSummary
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function interpolatePose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  return {
    targetX: lerp(a.targetX, b.targetX, t),
    targetY: lerp(a.targetY, b.targetY, t),
    zoom: lerp(a.zoom, b.zoom, t),
    rotation: lerp(a.rotation, b.rotation, t),
    tilt: lerp(a.tilt, b.tilt, t),
  }
}

interface ReplaySegment {
  durationMs: number
  interaction: CameraInteraction
  from: CameraPose
  to: CameraPose
}

/**
 * Stable route covering idle, long pan, LOD zoom crossings, and a teleport.
 * The same normalized route works for 64×64 through 1000×1000 worlds.
 */
export function createStandardCameraReplay(
  mapWidth: number,
  mapHeight: number,
  options: CameraReplayOptions = {},
): CameraReplay {
  const fps = Math.max(1, Math.round(options.fps ?? 60))
  const nearZoom = options.nearZoom ?? 1
  const farZoom = options.farZoom ?? 0.22
  const pose = (
    targetX: number,
    targetY: number,
    zoom: number,
    rotation = Math.PI / 4,
  ): CameraPose => ({ targetX, targetY, zoom, rotation, tilt: Math.PI / 3 })
  const a = pose(mapWidth * 0.18, mapHeight * 0.2, nearZoom)
  const b = pose(mapWidth * 0.78, mapHeight * 0.72, nearZoom)
  const farB = pose(b.targetX, b.targetY, farZoom)
  const thresholdB = pose(b.targetX, b.targetY, (nearZoom + farZoom) * 0.5)
  const c = pose(mapWidth * 0.48, mapHeight * 0.42, nearZoom, Math.PI * 0.31)
  const segments: ReplaySegment[] = [
    { durationMs: 500, interaction: 'idle', from: a, to: a },
    { durationMs: 2_000, interaction: 'pan', from: a, to: b },
    { durationMs: 900, interaction: 'zoom', from: b, to: farB },
    { durationMs: 900, interaction: 'zoom', from: farB, to: thresholdB },
    { durationMs: 450, interaction: 'zoom', from: thresholdB, to: farB },
    { durationMs: 450, interaction: 'zoom', from: farB, to: thresholdB },
    { durationMs: 1, interaction: 'teleport', from: thresholdB, to: c },
    { durationMs: 500, interaction: 'idle', from: c, to: c },
  ]

  const frames: CameraReplayFrame[] = []
  let atMs = 0
  for (const segment of segments) {
    const count = Math.max(1, Math.round((segment.durationMs / 1_000) * fps))
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 1 : i / (count - 1)
      frames.push({
        index: frames.length,
        atMs,
        interaction: segment.interaction,
        pose: interpolatePose(segment.from, segment.to, t),
      })
      atMs += 1_000 / fps
    }
  }
  return {
    id: options.id ?? `standard-${mapWidth}x${mapHeight}`,
    mapWidth,
    mapHeight,
    durationMs: atMs,
    frames,
  }
}

function emptyLodRecord(): Record<RenderLod, number> {
  return { near: 0, mid: 0, far: 0 }
}

function maxOf(samples: readonly FrameMetricSample[], select: (sample: FrameMetricSample) => number) {
  let max = 0
  for (const sample of samples) max = Math.max(max, select(sample))
  return max
}

function sumOf(samples: readonly FrameMetricSample[], select: (sample: FrameMetricSample) => number) {
  let sum = 0
  for (const sample of samples) sum += select(sample)
  return sum
}

export function summarizeFrameMetrics(samples: readonly FrameMetricSample[]): FrameStatsSummary {
  const maxDrawCalls = emptyLodRecord()
  const maxTriangles = emptyLodRecord()
  for (const sample of samples) {
    maxDrawCalls[sample.lod] = Math.max(maxDrawCalls[sample.lod], sample.drawCalls)
    maxTriangles[sample.lod] = Math.max(maxTriangles[sample.lod], sample.triangles)
  }
  const frameValues = samples.map((sample) => sample.frameMs)
  const idleValues = samples
    .filter((sample) => sample.interaction === 'idle')
    .map((sample) => sample.frameMs)
  const interactionValues = samples
    .filter((sample) => sample.interaction !== 'idle')
    .map((sample) => sample.frameMs)
  const cpuValues = samples.flatMap((sample) => (sample.cpuMs == null ? [] : [sample.cpuMs]))
  const gpuValues = samples.flatMap((sample) => (sample.gpuMs == null ? [] : [sample.gpuMs]))
  return {
    sampleCount: samples.length,
    frameMs: summarizeSamples(frameValues),
    cpuMs: summarizeSamples(cpuValues),
    gpuMs: summarizeSamples(gpuValues),
    idleFrameMs: summarizeSamples(idleValues),
    interactionFrameMs: summarizeSamples(interactionValues),
    framesOver33MsRatio:
      samples.length === 0
        ? 0
        : samples.filter((sample) => sample.frameMs > 33.3).length / samples.length,
    maxDrawCalls,
    maxTriangles,
    maxVisibleChunks: maxOf(samples, (sample) => sample.visibleChunks),
    maxResidentCpuChunks: maxOf(samples, (sample) => sample.residentCpuChunks),
    maxGpuChunkLayers: maxOf(samples, (sample) => sample.gpuChunkLayers),
    maxActiveInstances: maxOf(samples, (sample) => sample.activeInstances),
    maxUploadBytes: maxOf(samples, (sample) => sample.uploadBytes),
    maxChunkWorkMs: maxOf(samples, (sample) => sample.chunkWorkMs),
    maxJournalBacklog: maxOf(samples, (sample) => sample.journalBacklog),
    totalMissingTiles: sumOf(samples, (sample) => sample.missingTiles),
    totalCapacityRejects: sumOf(samples, (sample) => sample.capacityRejects),
    totalCloseUpPlaceholders: sumOf(samples, (sample) => sample.closeUpPlaceholders),
  }
}

export function createFrameStatsCollector(capacity = 36_000): FrameStatsCollector {
  const retained: FrameMetricSample[] = []
  const safeCapacity = Math.max(1, Math.floor(capacity))
  return {
    capacity: safeCapacity,
    record(sample) {
      if (retained.length === safeCapacity) retained.shift()
      retained.push({ ...sample })
    },
    reset() {
      retained.length = 0
    },
    samples() {
      return retained
    },
    summary() {
      return summarizeFrameMetrics(retained)
    },
  }
}

export function createPerfController(
  replay: CameraReplay,
  collector: FrameStatsCollector = createFrameStatsCollector(),
): LablinePerfController {
  let cursor = 0
  return {
    replay,
    collector,
    nextFrame() {
      const frame = replay.frames[cursor]
      cursor++
      return frame
    },
    record(sample) {
      collector.record(sample)
    },
    reset() {
      cursor = 0
      collector.reset()
    },
    report() {
      return collector.summary()
    },
  }
}

/** Install hook for a production renderer gated behind its own `?perf=1` check. */
export function exposePerfController(
  controller: LablinePerfController,
  target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
) {
  target.__LABLINE_PERF__ = controller
  return () => {
    if (target.__LABLINE_PERF__ === controller) delete target.__LABLINE_PERF__
  }
}

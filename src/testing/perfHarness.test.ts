import { describe, expect, it } from 'vitest'
import {
  benchmarkAsync,
  benchmarkSync,
  memoryDelta,
  percentile,
  summarizeSamples,
  type MemorySnapshot,
} from './perfHarness'
import {
  createFrameStatsCollector,
  createPerfController,
  createStandardCameraReplay,
  exposePerfController,
  type FrameMetricSample,
} from './cameraReplay'
import { evaluateRendererBudget } from './rendererBudgets'

function passingFrame(overrides: Partial<FrameMetricSample> = {}): FrameMetricSample {
  return {
    timestampMs: 0,
    frameMs: 12,
    cpuMs: 8,
    gpuMs: 7,
    interaction: 'idle',
    lod: 'near',
    drawCalls: 120,
    triangles: 800_000,
    visibleChunks: 32,
    residentCpuChunks: 64,
    gpuChunkLayers: 96,
    activeInstances: 8_000,
    uploadBytes: 16_384,
    chunkWorkMs: 1.2,
    journalBacklog: 0,
    missingTiles: 0,
    capacityRejects: 0,
    closeUpPlaceholders: 0,
    ...overrides,
  }
}

describe('performance helpers', () => {
  it('reports stable percentile and summary statistics', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3)
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8)
    expect(summarizeSamples([2, 4, 6, 8])).toMatchObject({
      count: 4,
      min: 2,
      max: 8,
      mean: 5,
    })
  })

  it('benchmarks sync and async operations with an injectable clock', async () => {
    let syncTime = 0
    const sync = benchmarkSync('sync', () => 42, {
      warmupIterations: 0,
      iterations: 3,
      clock: () => {
        syncTime += 2
        return syncTime
      },
    })
    expect(sync.value).toBe(42)
    expect(sync.samplesMs).toEqual([2, 2, 2])

    let asyncTime = 0
    const asyncResult = await benchmarkAsync('async', async () => 'ok', {
      warmupIterations: 0,
      iterations: 2,
      clock: () => {
        asyncTime += 3
        return asyncTime
      },
    })
    expect(asyncResult.value).toBe('ok')
    expect(asyncResult.samplesMs).toEqual([3, 3])
  })

  it('computes optional memory deltas without inventing unavailable values', () => {
    const before: MemorySnapshot = { timestampMs: 0, heapUsedBytes: 100, rssBytes: 500 }
    const after: MemorySnapshot = { timestampMs: 1, heapUsedBytes: 160, rssBytes: 560 }
    expect(memoryDelta(before, after)).toEqual({
      heapUsedBytes: 60,
      heapTotalBytes: undefined,
      rssBytes: 60,
      externalBytes: undefined,
    })
  })
})

describe('camera replay and frame collection', () => {
  it('builds a deterministic route covering pan, zoom, teleport, and idle', () => {
    const first = createStandardCameraReplay(1_000, 1_000)
    const second = createStandardCameraReplay(1_000, 1_000)
    expect(first).toEqual(second)
    expect(new Set(first.frames.map((frame) => frame.interaction))).toEqual(
      new Set(['idle', 'pan', 'zoom', 'teleport']),
    )
    for (const frame of first.frames) {
      expect(frame.pose.targetX).toBeGreaterThanOrEqual(0)
      expect(frame.pose.targetX).toBeLessThanOrEqual(1_000)
      expect(frame.pose.targetY).toBeGreaterThanOrEqual(0)
      expect(frame.pose.targetY).toBeLessThanOrEqual(1_000)
    }
  })

  it('collects bounded frame metrics and exposes a removable integration hook', () => {
    const replay = createStandardCameraReplay(64, 64, { fps: 10 })
    const collector = createFrameStatsCollector(2)
    const controller = createPerfController(replay, collector)
    controller.record(passingFrame({ timestampMs: 1 }))
    controller.record(passingFrame({ timestampMs: 2, interaction: 'pan', frameMs: 15 }))
    controller.record(passingFrame({ timestampMs: 3, interaction: 'zoom', frameMs: 16 }))
    expect(collector.samples()).toHaveLength(2)
    expect(controller.report().sampleCount).toBe(2)
    expect(controller.nextFrame()?.index).toBe(0)

    const target: Record<string, unknown> = {}
    const remove = exposePerfController(controller, target)
    expect(target.__LABLINE_PERF__).toBe(controller)
    remove()
    expect(target.__LABLINE_PERF__).toBeUndefined()
  })
})

describe('renderer budgets', () => {
  it('passes samples inside the timing and structural envelope', () => {
    const samples = [
      passingFrame(),
      passingFrame({ interaction: 'pan', lod: 'mid', drawCalls: 150, triangles: 700_000 }),
      passingFrame({ interaction: 'zoom', lod: 'far', drawCalls: 90, triangles: 350_000 }),
    ]
    expect(evaluateRendererBudget(samples)).toMatchObject({ pass: true, violations: [] })
  })

  it('pinpoints draw-call, chunk-work, and close-up LOD regressions', () => {
    const result = evaluateRendererBudget([
      passingFrame({
        frameMs: 40,
        drawCalls: 251,
        chunkWorkMs: 3,
        closeUpPlaceholders: 1,
      }),
    ])
    expect(result.pass).toBe(false)
    expect(result.violations.map((violation) => violation.metric)).toEqual(
      expect.arrayContaining([
        'idle frame p95 ms',
        'overall frame p99 ms',
        'near draw calls',
        'chunk work ms',
        'close-up placeholders',
      ]),
    )
  })
})

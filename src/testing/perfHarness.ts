/** Small, dependency-free timing and memory helpers for tests and `?perf=1`. */

export const HEAVY_PERF_ENV = 'LABLINE_HEAVY_PERF'

export type Clock = () => number

export interface SampleStats {
  count: number
  min: number
  max: number
  mean: number
  p50: number
  p95: number
  p99: number
}

export interface BenchmarkOptions {
  iterations?: number
  warmupIterations?: number
  clock?: Clock
}

export interface BenchmarkResult<T> {
  label: string
  samplesMs: number[]
  stats: SampleStats
  value: T
}

export interface MemorySnapshot {
  timestampMs: number
  heapUsedBytes?: number
  heapTotalBytes?: number
  rssBytes?: number
  externalBytes?: number
}

export interface MemoryDelta {
  heapUsedBytes?: number
  heapTotalBytes?: number
  rssBytes?: number
  externalBytes?: number
}

type ProcessMemoryUsage = () => {
  heapUsed: number
  heapTotal: number
  rss: number
  external?: number
}

interface RuntimeWithProcess {
  process?: {
    env?: Record<string, string | undefined>
    memoryUsage?: ProcessMemoryUsage
  }
}

interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize: number
    totalJSHeapSize: number
  }
}

export const defaultClock: Clock = () => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

export function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const q = Math.max(0, Math.min(1, quantile))
  const rank = q * (sorted.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return sorted[lower]!
  const fraction = rank - lower
  return sorted[lower]! * (1 - fraction) + sorted[upper]! * fraction
}

export function summarizeSamples(values: readonly number[]): SampleStats {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 }
  }
  let min = Infinity
  let max = -Infinity
  let total = 0
  for (const value of values) {
    min = Math.min(min, value)
    max = Math.max(max, value)
    total += value
  }
  return {
    count: values.length,
    min,
    max,
    mean: total / values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  }
}

export function benchmarkSync<T>(
  label: string,
  operation: () => T,
  options: BenchmarkOptions = {},
): BenchmarkResult<T> {
  const iterations = Math.max(1, Math.floor(options.iterations ?? 5))
  const warmupIterations = Math.max(0, Math.floor(options.warmupIterations ?? 1))
  const clock = options.clock ?? defaultClock
  let value: T | undefined
  for (let i = 0; i < warmupIterations; i++) value = operation()
  const samplesMs: number[] = []
  for (let i = 0; i < iterations; i++) {
    const started = clock()
    value = operation()
    samplesMs.push(Math.max(0, clock() - started))
  }
  return {
    label,
    samplesMs,
    stats: summarizeSamples(samplesMs),
    value: value as T,
  }
}

export async function benchmarkAsync<T>(
  label: string,
  operation: () => Promise<T>,
  options: BenchmarkOptions = {},
): Promise<BenchmarkResult<T>> {
  const iterations = Math.max(1, Math.floor(options.iterations ?? 5))
  const warmupIterations = Math.max(0, Math.floor(options.warmupIterations ?? 1))
  const clock = options.clock ?? defaultClock
  let value: T | undefined
  for (let i = 0; i < warmupIterations; i++) value = await operation()
  const samplesMs: number[] = []
  for (let i = 0; i < iterations; i++) {
    const started = clock()
    value = await operation()
    samplesMs.push(Math.max(0, clock() - started))
  }
  return {
    label,
    samplesMs,
    stats: summarizeSamples(samplesMs),
    value: value as T,
  }
}

export function takeMemorySnapshot(clock: Clock = defaultClock): MemorySnapshot {
  const runtime = globalThis as typeof globalThis & RuntimeWithProcess
  const nodeMemory = runtime.process?.memoryUsage?.()
  if (nodeMemory) {
    return {
      timestampMs: clock(),
      heapUsedBytes: nodeMemory.heapUsed,
      heapTotalBytes: nodeMemory.heapTotal,
      rssBytes: nodeMemory.rss,
      externalBytes: nodeMemory.external,
    }
  }
  const browserMemory =
    typeof performance === 'undefined'
      ? undefined
      : (performance as PerformanceWithMemory).memory
  return {
    timestampMs: clock(),
    heapUsedBytes: browserMemory?.usedJSHeapSize,
    heapTotalBytes: browserMemory?.totalJSHeapSize,
  }
}

function optionalDelta(after: number | undefined, before: number | undefined): number | undefined {
  return after == null || before == null ? undefined : after - before
}

export function memoryDelta(before: MemorySnapshot, after: MemorySnapshot): MemoryDelta {
  return {
    heapUsedBytes: optionalDelta(after.heapUsedBytes, before.heapUsedBytes),
    heapTotalBytes: optionalDelta(after.heapTotalBytes, before.heapTotalBytes),
    rssBytes: optionalDelta(after.rssBytes, before.rssBytes),
    externalBytes: optionalDelta(after.externalBytes, before.externalBytes),
  }
}

export function measureMemory<T>(operation: () => T): {
  value: T
  before: MemorySnapshot
  after: MemorySnapshot
  delta: MemoryDelta
} {
  const before = takeMemorySnapshot()
  const value = operation()
  const after = takeMemorySnapshot()
  return { value, before, after, delta: memoryDelta(before, after) }
}

function envValue(name: string): string | undefined {
  const runtime = globalThis as typeof globalThis & RuntimeWithProcess
  const fromProcess = runtime.process?.env?.[name]
  if (fromProcess != null) return fromProcess
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
  return env?.[name]
}

export function isHeavyPerfEnabled(): boolean {
  const value = envValue(HEAVY_PERF_ENV)?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

export function bytesToMiB(bytes: number): number {
  return bytes / (1024 * 1024)
}

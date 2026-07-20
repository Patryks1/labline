/**
 * Physically grounded text-serving work.
 *
 * One PF-day is 10^15 FLOP/s sustained for one day. Text inference starts at
 * roughly two operations per active parameter and token, then adds explicit
 * architecture, context, numerical-format, and runtime factors. Capacity and
 * demand are therefore expressed in the same conserved work unit.
 */
import type { Model, ModelFamily, RackSku, ServePrecision } from '../types'
import type { ComputeSnapshot } from '../systems/compute'

export const FLOPS_PER_PF_DAY = 86_400 * 1e15
export const DEFAULT_SERVE_HEADROOM = 0.25
export const DEFAULT_INPUT_SHARE = 0.7
export const DEFAULT_AVG_INPUT_TOKENS = 1_024
export const DEFAULT_AVG_OUTPUT_TOKENS = 384

/** Retained for compatibility with old displays. It is not a capacity source. */
export const REF_PARAMS_B = 7

export type ServingPrecision = ServePrecision

export interface ServingWorkloadInput {
  model: Pick<Model, 'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult'>
  /** Daily input volume. */
  inputMTok: number
  /** Daily generated volume. */
  outputMTok: number
  precision?: ServingPrecision
  avgInputTokens?: number
  avgOutputTokens?: number
  concurrentRequests?: number
  batchSize?: number
  servingEfficiency?: number
  /** Effective PF available to this workload after fleet utilization/derates. */
  availablePfDays?: number
  /** Aggregate resident HBM and bandwidth, when the caller knows them. */
  hbmGb?: number
  hbmBandwidthTBps?: number
}

export interface ServingWorkloadEstimate {
  requestedMTok: number
  rawFlops: number
  physicalPfDays: number
  effectivePfDays: number
  inputPfDays: number
  outputPfDays: number
  weightMemoryGb: number
  kvCacheGb: number
  workspaceGb: number
  residentMemoryGb: number
  computeSeconds: number | null
  memorySeconds: number | null
  fitsHbm: boolean | null
  bottleneck: 'compute' | 'memory_bandwidth' | 'hbm_capacity' | 'unknown'
}

export type ServeModelPick = Pick<
  Model,
  'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult' | 'tokPerSecMult'
>

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min))
}

/** Runtime efficiency relative to the calibrated BF16 work estimate. */
export function serveEffFactor(servingEfficiency: number): number {
  return clamp(servingEfficiency, 0.22, 1.65)
}

/**
 * Architecture overhead after active-parameter FLOPs are counted. MoE compute
 * uses active experts and a small router/communication tax; total parameters
 * still determine resident weight memory.
 */
export function familyServeMult(family: ModelFamily | string | undefined): number {
  switch (family) {
    case 'moe':
      return 1.08
    case 'omni':
      return 1.5
    case 'video':
      return 1.9
    case 'diffusion':
      return 1.35
    case 'dense':
    default:
      return 1
  }
}

export function precisionComputeMult(precision: ServingPrecision | undefined): number {
  switch (precision) {
    case 'fp8':
      return 0.62
    case 'int8':
      return 0.68
    case 'int4':
      return 0.42
    case 'nvfp4':
      return 0.38
    case 'ternary_1_58':
      return 0.25
    case 'fp16':
    case 'bf16':
    default:
      return 1
  }
}

export function precisionBytesPerWeight(precision: ServingPrecision | undefined): number {
  switch (precision) {
    case 'fp8':
    case 'int8':
      return 1
    case 'int4':
    case 'nvfp4':
      return 0.5
    case 'ternary_1_58':
      return 0.25
    case 'fp16':
    case 'bf16':
    default:
      return 2
  }
}

/** Linear active-parameter throughput relative to the historical 7B display. */
export function sizeTokMult(model: Pick<Model, 'paramsB' | 'activeParamsB'>): number {
  const active = Math.max(0.05, model.activeParamsB ?? model.paramsB)
  return REF_PARAMS_B / active
}

/** Relative physical work per token versus a 7B dense BF16 model. */
export function modelServeCostMult(
  model: Pick<Model, 'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult'>,
): number {
  const active = Math.max(0.05, model.activeParamsB ?? model.paramsB)
  const infer = Math.max(0.05, model.inferCostMult ?? 1)
  return (active / REF_PARAMS_B) * familyServeMult(model.family) * infer
}

export const modelCostMult = modelServeCostMult

/**
 * Estimate daily text-serving work. Context overhead is deliberately modest:
 * the 2N approximation dominates normal chat, while long prompts increase
 * prefill work and KV residency rather than being free.
 */
export function estimateServingWorkload(
  input: ServingWorkloadInput,
): ServingWorkloadEstimate {
  const inputMTok = Math.max(0, input.inputMTok)
  const outputMTok = Math.max(0, input.outputMTok)
  const requestedMTok = inputMTok + outputMTok
  const activeParams = Math.max(
    0.05,
    input.model.activeParamsB ?? input.model.paramsB,
  ) * 1e9
  const totalParams = Math.max(activeParams, Math.max(0.05, input.model.paramsB) * 1e9)
  const avgInput = Math.max(1, input.avgInputTokens ?? DEFAULT_AVG_INPUT_TOKENS)
  const avgOutput = Math.max(1, input.avgOutputTokens ?? DEFAULT_AVG_OUTPUT_TOKENS)
  const contextOverhead = 1 + clamp(avgInput / 4_096, 0, 8) * 0.08
  const decodeOverhead = 1 + clamp((avgInput + avgOutput) / 8_192, 0, 8) * 0.05
  const architecture = familyServeMult(input.model.family)
  const precision = precisionComputeMult(input.precision)
  const modelRuntime = Math.max(0.05, input.model.inferCostMult ?? 1)
  const inputFlops =
    2 * activeParams * inputMTok * 1e6 * contextOverhead * architecture * precision * modelRuntime
  const outputFlops =
    2 * activeParams * outputMTok * 1e6 * decodeOverhead * architecture * precision * modelRuntime
  const rawFlops = inputFlops + outputFlops
  const physicalPfDays = rawFlops / FLOPS_PER_PF_DAY
  const efficiency = serveEffFactor(input.servingEfficiency ?? 1)
  const effectivePfDays = physicalPfDays / efficiency

  const bytesPerWeight = precisionBytesPerWeight(input.precision)
  const weightMemoryGb = (totalParams * bytesPerWeight) / 1e9
  const concurrency = Math.max(1, input.concurrentRequests ?? 1)
  // Approximate KV as a fraction of the model state scaled by live context.
  // This is intentionally reported separately from weights so paged attention
  // and KV precision research can modify it without altering token FLOPs.
  const kvCacheGb =
    weightMemoryGb *
    0.18 *
    concurrency *
    clamp((avgInput + avgOutput) / 4_096, 0.02, 8) /
    Math.max(1, input.batchSize ?? concurrency)
  const workspaceGb = Math.max(0.5, weightMemoryGb * 0.12)
  const residentMemoryGb = weightMemoryGb + kvCacheGb + workspaceGb
  const availablePfDays = input.availablePfDays
  const computeSeconds =
    availablePfDays != null && availablePfDays > 0
      ? (effectivePfDays / availablePfDays) * 86_400
      : null

  // Weight streaming is amortized by the live batch. This is a lower-bound
  // bandwidth diagnostic, not another hidden throughput multiplier.
  const batch = Math.max(1, input.batchSize ?? Math.min(32, concurrency))
  const requests = requestedMTok > 0
    ? (requestedMTok * 1e6) / Math.max(1, avgInput + avgOutput)
    : 0
  const streamedBytes = weightMemoryGb * 1e9 * requests / batch
  const memorySeconds =
    input.hbmBandwidthTBps != null && input.hbmBandwidthTBps > 0
      ? streamedBytes / (input.hbmBandwidthTBps * 1e12)
      : null
  const fitsHbm = input.hbmGb == null ? null : residentMemoryGb <= input.hbmGb
  const bottleneck =
    fitsHbm === false
      ? 'hbm_capacity'
      : memorySeconds != null && computeSeconds != null && memorySeconds > computeSeconds
        ? 'memory_bandwidth'
        : computeSeconds != null
          ? 'compute'
          : 'unknown'

  return {
    requestedMTok,
    rawFlops,
    physicalPfDays,
    effectivePfDays,
    inputPfDays: inputFlops / FLOPS_PER_PF_DAY / efficiency,
    outputPfDays: outputFlops / FLOPS_PER_PF_DAY / efficiency,
    weightMemoryGb,
    kvCacheGb,
    workspaceGb,
    residentMemoryGb,
    computeSeconds,
    memorySeconds,
    fitsHbm,
    bottleneck,
  }
}

/** Effective PF-days needed for one MTok using the normal 70/30 input/output mix. */
export function pfPerMTokForModel(
  model: Pick<Model, 'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult'>,
  servingEfficiency = 1,
  _legacyPfPerMTokAt7B?: number,
): number {
  const estimate = estimateServingWorkload({
    model,
    inputMTok: DEFAULT_INPUT_SHARE,
    outputMTok: 1 - DEFAULT_INPUT_SHARE,
    servingEfficiency,
  })
  return estimate.effectivePfDays
}

export function mtokPerDayFromTps(tps: number): number {
  return (Math.max(0, tps) * 86_400) / 1e6
}

/**
 * Compatibility display only. Runtime settlement no longer reads rack
 * tokPerSec, so changing this quote cannot mint serving capacity.
 */
export function tokensPerSecForSku(
  sku: Pick<RackSku, 'tokPerSec'>,
  model: ServeModelPick,
  servingEfficiency = 1,
): number {
  return Math.max(0, sku.tokPerSec) *
    sizeTokMult(model) *
    serveEffFactor(servingEfficiency) /
    Math.max(0.2, familyServeMult(model.family) * Math.max(0.05, model.inferCostMult ?? 1))
}

export interface TokenCapacityOpts {
  /** Preferred source: effective PF-days already available to serving. */
  effectivePfDays?: number
  /** Legacy display throughput; ignored when effectivePfDays is supplied. */
  hardwareTokPerSec?: number
  model: ServeModelPick | null
  servingEfficiency: number
  inferenceShare: number
  util?: number
  powerDerate?: number
  vramDerate?: number
  systemRamDerate?: number
  cpuDerate?: number
  engServe?: number
  headroom?: number
}

/** Convert conserved effective PF-day capacity into a model-specific token cap. */
export function tokensPerDayCapacity(opts: TokenCapacityOpts): number {
  if (!opts.model) return 0
  const inferShare = clamp(opts.inferenceShare, 0, 1)
  const util = clamp(opts.util ?? 1, 0, 1)
  const power = clamp(opts.powerDerate ?? 1, 0, 1)
  const vram = clamp(opts.vramDerate ?? 1, 0, 1)
  const ram = clamp(opts.systemRamDerate ?? 1, 0, 1)
  const cpu = clamp(opts.cpuDerate ?? 1, 0, 1)
  const secondary = 0.55 + 0.25 * ram + 0.2 * cpu
  const engineer = 1 + Math.max(0, opts.engServe ?? 0)
  let capacityPf = Math.max(0, opts.effectivePfDays ?? 0)
  if (opts.effectivePfDays == null) {
    // Compatibility bridge for old callers. This preserves their rack quote,
    // but all simulation capacity paths now provide effectivePfDays directly.
    const displayMTok = mtokPerDayFromTps(Math.max(0, opts.hardwareTokPerSec ?? 0))
    capacityPf = displayMTok * pfPerMTokForModel(opts.model, opts.servingEfficiency)
    capacityPf *= inferShare * util * power * vram * secondary * engineer
  }
  const usable = capacityPf / (1 + Math.max(0, opts.headroom ?? DEFAULT_SERVE_HEADROOM))
  const workPerMTok = pfPerMTokForModel(opts.model, opts.servingEfficiency)
  return workPerMTok > 0 ? usable / workPerMTok : 0
}

/** Legacy metric retained for panels; never used to calculate capacity. */
export function fleetHardwareTokPerSec(
  snap: Pick<ComputeSnapshot, 'chipCount' | 'avgTokPerSecPerChip'>,
): number {
  return Math.max(0, snap.chipCount) * Math.max(0, snap.avgTokPerSecPerChip)
}

export function tokensPerDayFromSnapshot(
  snap: ComputeSnapshot,
  model: ServeModelPick | null,
  servingEfficiency: number,
  _inferenceShare: number,
): number {
  if (!model || snap.vramDerateServe < 0.2) return 0
  return tokensPerDayCapacity({
    effectivePfDays: Math.max(0, snap.pools.inference),
    model,
    servingEfficiency,
    inferenceShare: 1,
  })
}

export function tokensPerDayFromSnapshotPrecise(
  snap: ComputeSnapshot,
  model: ServeModelPick | null,
  servingEfficiency: number,
  inferenceShare?: number,
  opts?: { engServe?: number; powerOnly?: number },
): number {
  if (!model || snap.vramDerateServe < 0.2) return 0
  let effectivePfDays = Math.max(0, snap.pools.inference)
  // Explicit overrides are useful for previews/tests. Normal simulation calls
  // consume the already-derated inference pool exactly once.
  if (opts?.powerOnly != null || inferenceShare != null) {
    const share = clamp(inferenceShare ?? 1, 0, 1)
    const power = clamp(opts?.powerOnly ?? snap.powerDerate, 0, 1)
    const secondary = 0.55 + 0.25 * snap.systemRamDerate + 0.2 * snap.cpuDerate
    effectivePfDays =
      Math.max(0, snap.rawFlopsPf) *
      clamp(snap.utilCap, 0, 1) *
      share *
      power *
      clamp(snap.vramDerateServe, 0, 1) *
      secondary *
      (1 + Math.max(0, opts?.engServe ?? snap.engineerServeBonus ?? 0))
  }
  return tokensPerDayCapacity({
    effectivePfDays,
    model,
    servingEfficiency,
    inferenceShare: 1,
  })
}

export function tokensPerDayFromFlops(opts: {
  flopsPf: number
  model: ServeModelPick | null
  servingEfficiency: number
  inferenceShare: number
  utilCap: number
  derate?: number
  headroom?: number
}): number {
  const effectivePfDays =
    Math.max(0, opts.flopsPf) *
    clamp(opts.utilCap, 0, 1) *
    clamp(opts.inferenceShare, 0, 1) *
    clamp(opts.derate ?? 1, 0, 1)
  return tokensPerDayCapacity({
    effectivePfDays,
    model: opts.model,
    servingEfficiency: opts.servingEfficiency,
    inferenceShare: 1,
    headroom: opts.headroom,
  })
}

export function serveAgainstTokenPool(
  demandMTok: number,
  capacityMTok: number,
): { serveFrac: number; unservedRatio: number; servedMTok: number } {
  const requested = Math.max(0, demandMTok)
  const servedMTok = Math.min(requested, Math.max(0, capacityMTok))
  const serveFrac = requested > 1e-9 ? servedMTok / requested : 1
  return { serveFrac, unservedRatio: 1 - serveFrac, servedMTok }
}

export function mtokPerDayForSku(
  sku: Pick<RackSku, 'tokPerSec'>,
  model: ServeModelPick,
  servingEfficiency: number,
  inferenceShare = 1,
  util = 1,
): number {
  return mtokPerDayFromTps(tokensPerSecForSku(sku, model, servingEfficiency)) *
    clamp(inferenceShare, 0, 1) *
    clamp(util, 0, 1)
}

export function suggestApiFromUnitCost(opts: {
  costPerMTok: number
  capability?: number
  markupPct?: number
}): {
  costIn: number
  costOut: number
  priceIn: number
  priceOut: number
  blendedCost: number
  blendedPrice: number
  markupPct: number
} {
  const unit = Math.max(0.005, opts.costPerMTok)
  const costIn = Math.max(0.005, unit * 0.65)
  const costOut = Math.max(0.01, unit * 1.15)
  const markupPct = opts.markupPct ?? 100
  const multiplier = 1 + Math.max(0, markupPct) / 100
  const priceIn = Math.round(costIn * multiplier * 1000) / 1000
  const priceOut = Math.round(costOut * multiplier * 1000) / 1000
  const blend = (a: number, b: number) => a * 0.3 + b * 0.7
  return {
    costIn: Math.round(costIn * 1000) / 1000,
    costOut: Math.round(costOut * 1000) / 1000,
    priceIn,
    priceOut,
    blendedCost: blend(costIn, costOut),
    blendedPrice: blend(priceIn, priceOut),
    markupPct,
  }
}

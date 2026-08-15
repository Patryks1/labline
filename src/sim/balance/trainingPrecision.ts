import type { NativeWeightPrecision, TrainingComputeFormat, TrainingNumerics } from '../types'

export type {
  NativeWeightFormat,
  NativeWeightPrecision,
  TrainingComputeFormat,
  TrainingNumerics,
} from '../types'

export interface TrainingPrecisionProfile {
  format: TrainingComputeFormat
  label: string
  minimumHardwareGeneration: number
  /** Achieved training work relative to the rack's advertised BF16 PF. */
  throughputByGeneration: Readonly<Partial<Record<number, number>>>
  /** Activation/workspace footprint relative to BF16. */
  activationMemoryMultiplier: number
  /** Useful optimizer work required relative to the default mixed-precision recipe. */
  trainingWorkMultiplier: number
  /** Cluster reservation / setup cash relative to the default recipe. */
  upfrontCashMultiplier: number
  /** Recurring training cash burn relative to the default recipe. */
  dailyCashMultiplier: number
  /** Maximum share of the parameter/data/architecture capability ceiling retained. */
  qualityCeilingMultiplier: number
  /** Day-to-day loss and terminal outcome spread relative to default mixed precision. */
  lossVolatilityMultiplier: number
  /** Ordinary inference cost inherited by the unquantized checkpoint. */
  inferenceCostMultiplier: number
  /** Relative numerical-instability pressure; not a deterministic quality loss. */
  stabilityRisk: number
}

/**
 * Conservative achieved-throughput calibration. Catalog rack PF is treated as
 * BF16-equivalent PF. Generation 1 is A100-class, 2 H100/H200-class, and 3+
 * Blackwell/custom-class. The fp32 profile is the starter recipe: FP32 master
 * weights with TF32 tensor operations on compatible accelerators, so it lands
 * near half of BF16 throughput rather than true IEEE FP32 (~7%).
 */
export const TRAINING_PRECISION_PROFILES: Readonly<
  Record<TrainingComputeFormat, TrainingPrecisionProfile>
> = {
  fp32: {
    format: 'fp32',
    label: 'FP32/TF32',
    minimumHardwareGeneration: 1,
    throughputByGeneration: { 1: 0.45, 2: 0.5, 3: 0.5, 4: 0.55, 5: 0.55 },
    activationMemoryMultiplier: 2,
    trainingWorkMultiplier: 1.16,
    upfrontCashMultiplier: 1.22,
    dailyCashMultiplier: 1.2,
    qualityCeilingMultiplier: 1,
    lossVolatilityMultiplier: 0.72,
    inferenceCostMultiplier: 1.18,
    stabilityRisk: -0.08,
  },
  fp16_mixed: {
    format: 'fp16_mixed',
    label: 'FP16',
    minimumHardwareGeneration: 1,
    throughputByGeneration: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 },
    activationMemoryMultiplier: 1,
    trainingWorkMultiplier: 1,
    upfrontCashMultiplier: 1,
    dailyCashMultiplier: 1,
    qualityCeilingMultiplier: 0.992,
    lossVolatilityMultiplier: 1,
    inferenceCostMultiplier: 1,
    stabilityRisk: 0.04,
  },
  bf16_mixed: {
    format: 'bf16_mixed',
    label: 'BF16',
    minimumHardwareGeneration: 1,
    throughputByGeneration: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 },
    activationMemoryMultiplier: 1,
    trainingWorkMultiplier: 1,
    upfrontCashMultiplier: 1,
    dailyCashMultiplier: 0.99,
    qualityCeilingMultiplier: 0.995,
    lossVolatilityMultiplier: 0.94,
    inferenceCostMultiplier: 1,
    stabilityRisk: 0,
  },
  fp8_hybrid: {
    format: 'fp8_hybrid',
    label: 'FP8 hybrid',
    minimumHardwareGeneration: 2,
    throughputByGeneration: { 2: 1.7, 3: 1.8, 4: 1.85, 5: 1.9 },
    // FP8 often retains BF16/FP32 master and optimizer copies. Most savings are
    // in activations and communication, not the entire training state.
    activationMemoryMultiplier: 0.88,
    trainingWorkMultiplier: 0.82,
    upfrontCashMultiplier: 0.82,
    dailyCashMultiplier: 0.84,
    qualityCeilingMultiplier: 0.965,
    lossVolatilityMultiplier: 1.35,
    inferenceCostMultiplier: 0.82,
    stabilityRisk: 0.04,
  },
  nvfp4: {
    format: 'nvfp4',
    label: 'NVFP4',
    minimumHardwareGeneration: 3,
    throughputByGeneration: { 3: 2.6, 4: 2.7, 5: 2.8 },
    activationMemoryMultiplier: 0.72,
    trainingWorkMultiplier: 0.64,
    upfrontCashMultiplier: 0.66,
    dailyCashMultiplier: 0.7,
    qualityCeilingMultiplier: 0.9,
    lossVolatilityMultiplier: 1.85,
    inferenceCostMultiplier: 0.62,
    stabilityRisk: 0.12,
  },
}

/** UI-safe, composed economics metadata for compute precision + native topology. */
export interface TrainingNumericsEconomicsProfile {
  label: string
  trainingWorkMultiplier: number
  upfrontCashMultiplier: number
  dailyCashMultiplier: number
  qualityCeilingMultiplier: number
  lossVolatilityMultiplier: number
  inferenceCostMultiplier: number
  stabilityRisk: number
}

export function trainingNumericsEconomicsProfile(
  numerics: TrainingNumerics = DEFAULT_TRAINING_NUMERICS,
): TrainingNumericsEconomicsProfile {
  const base = TRAINING_PRECISION_PROFILES[numerics.computeFormat]
  const ternary = numerics.nativeWeightFormat === 'ternary_1_58'
  // Later recipe generations recover part of low-precision quality/stability,
  // but never exceed the underlying parameter/data/architecture ceiling.
  const recipeAdvances = Math.max(0, Math.floor(numerics.recipeVersion) - 1)
  const recoveredCeiling = Math.min(
    1,
    base.qualityCeilingMultiplier +
      (1 - base.qualityCeilingMultiplier) * Math.min(0.8, recipeAdvances * 0.25),
  )
  const stabilizedVolatility = Math.max(
    0.7,
    base.lossVolatilityMultiplier * Math.pow(0.9, recipeAdvances),
  )
  return {
    label: ternary ? `${base.label} · ternary 1.58-bit weights` : base.label,
    trainingWorkMultiplier: base.trainingWorkMultiplier * (ternary ? 0.9 : 1),
    upfrontCashMultiplier: base.upfrontCashMultiplier * (ternary ? 0.88 : 1),
    dailyCashMultiplier: base.dailyCashMultiplier * (ternary ? 0.86 : 1),
    qualityCeilingMultiplier: Math.min(recoveredCeiling, ternary ? 0.92 : 1),
    lossVolatilityMultiplier: stabilizedVolatility * (ternary ? 1.55 : 1),
    inferenceCostMultiplier: base.inferenceCostMultiplier * (ternary ? 0.22 : 1),
    stabilityRisk: base.stabilityRisk + (ternary ? 0.1 : 0),
  }
}

export const DEFAULT_TRAINING_NUMERICS: TrainingNumerics = {
  computeFormat: 'fp32',
  nativeWeightFormat: 'float',
  recipeVersion: 1,
}

/** Save migration default for jobs created before numerical formats existed. */
export const LEGACY_TRAINING_NUMERICS: TrainingNumerics = {
  computeFormat: 'bf16_mixed',
  nativeWeightFormat: 'float',
  recipeVersion: 1,
}

/**
 * Weight precision a checkpoint natively carries out of training. Mixed-
 * precision recipes release weights in their tensor format; FP8/NVFP4 recipes
 * release scaled low-precision weights (training-time FP32 masters are not
 * part of the released artifact). Ternary overrides the compute format.
 */
export function nativeWeightPrecisionForNumerics(
  numerics: TrainingNumerics = DEFAULT_TRAINING_NUMERICS,
): NativeWeightPrecision {
  if (numerics.nativeWeightFormat === 'ternary_1_58') return 'ternary_1_58'
  switch (numerics.computeFormat) {
    case 'fp32':
      return 'fp32'
    case 'fp16_mixed':
      return 'fp16'
    case 'fp8_hybrid':
      return 'fp8'
    case 'nvfp4':
      return 'nvfp4'
    case 'bf16_mixed':
    default:
      return 'bf16'
  }
}

/** Packed weight bytes per parameter for a native precision (FP32=4 … NVFP4≈0.5). */
export function nativeWeightBytesPerParam(precision: NativeWeightPrecision): number {
  switch (precision) {
    case 'fp32':
      return 4
    case 'fp16':
    case 'bf16':
      return 2
    case 'fp8':
      return 1
    case 'nvfp4':
      return 0.5
    case 'ternary_1_58':
      return 0.25
  }
}

/** Packed scales, zero-points, and alignment kept beside low-precision weights. */
export function nativeWeightStorageOverhead(precision: NativeWeightPrecision): number {
  switch (precision) {
    case 'fp8':
      return 1.03
    case 'nvfp4':
      return 1.06
    case 'ternary_1_58':
      return 1.15
    default:
      return 1
  }
}

/** GB of packed native weights for `paramsB` billion parameters. */
export function nativeWeightMemoryGb(
  paramsB: number,
  precision: NativeWeightPrecision,
): number {
  return (
    Math.max(0, paramsB) *
    nativeWeightBytesPerParam(precision) *
    nativeWeightStorageOverhead(precision)
  )
}

export function supportsTrainingFormat(
  hardwareGeneration: number,
  format: TrainingComputeFormat,
): boolean {
  if (!Number.isFinite(hardwareGeneration)) return false
  return hardwareGeneration >= TRAINING_PRECISION_PROFILES[format].minimumHardwareGeneration
}

function nearestGenerationMultiplier(
  profile: TrainingPrecisionProfile,
  hardwareGeneration: number,
): number {
  if (!supportsTrainingFormat(hardwareGeneration, profile.format)) return 0
  const generation = Math.max(1, Math.floor(hardwareGeneration))
  for (let current = generation; current >= profile.minimumHardwareGeneration; current -= 1) {
    const multiplier = profile.throughputByGeneration[current]
    if (multiplier != null) return multiplier
  }
  return 0
}

/** Effective work completed per advertised BF16 PF on this hardware. */
export function trainingFormatThroughput(
  hardwareGeneration: number,
  numerics: TrainingNumerics,
): number {
  const base = nearestGenerationMultiplier(
    TRAINING_PRECISION_PROFILES[numerics.computeFormat],
    hardwareGeneration,
  )
  if (base <= 0) return 0
  // Native ternary training still retains BF16 master weights and currently has
  // a small straight-through-estimator/kernel overhead. Its large win is serve.
  return base * (numerics.nativeWeightFormat === 'ternary_1_58' ? 0.95 : 1)
}

export function validateTrainingNumerics(opts: {
  hardwareGeneration: number
  numerics: TrainingNumerics
  researchUnlocked?: readonly string[]
  family?: string
  /** Existing checkpoints may retain a once-valid recipe after tree migrations. */
  enforceResearch?: boolean
}): { ok: true } | { ok: false; reason: string } {
  const { hardwareGeneration, numerics } = opts
  if (!supportsTrainingFormat(hardwareGeneration, numerics.computeFormat)) {
    return {
      ok: false,
      reason: `${TRAINING_PRECISION_PROFILES[numerics.computeFormat].label} requires generation ${TRAINING_PRECISION_PROFILES[numerics.computeFormat].minimumHardwareGeneration}+ training hardware.`,
    }
  }
  const unlocked = new Set(opts.researchUnlocked ?? [])
  const enforceResearch = opts.enforceResearch ?? true
  if (
    enforceResearch &&
    numerics.computeFormat === 'fp16_mixed' &&
    !unlocked.has('opt_fp16')
  ) {
    return { ok: false, reason: 'FP16 training requires FP16 Mixed Precision research.' }
  }
  if (
    enforceResearch &&
    numerics.computeFormat === 'bf16_mixed' &&
    !unlocked.has('opt_mixed')
  ) {
    return { ok: false, reason: 'BF16 training requires Mixed Precision Training.' }
  }
  if (
    enforceResearch &&
    numerics.computeFormat === 'fp8_hybrid' &&
    !unlocked.has('opt_fp8_train')
  ) {
    return { ok: false, reason: 'FP8 training requires the FP8 Training Stack.' }
  }
  if (
    enforceResearch &&
    numerics.computeFormat === 'nvfp4' &&
    !unlocked.has('opt_nvfp4_train')
  ) {
    return { ok: false, reason: 'NVFP4 training requires Experimental NVFP4 Training.' }
  }
  if (
    enforceResearch &&
    numerics.nativeWeightFormat === 'ternary_1_58' &&
    !unlocked.has('dense_bitnet')
  ) {
    return { ok: false, reason: 'Native 1.58-bit training requires Ternary Architectures.' }
  }
  if (numerics.nativeWeightFormat === 'ternary_1_58' && opts.family && opts.family !== 'dense') {
    return { ok: false, reason: 'Native 1.58-bit weights currently require a dense backbone.' }
  }
  if (
    numerics.nativeWeightFormat === 'ternary_1_58' &&
    numerics.computeFormat !== 'bf16_mixed'
  ) {
    return {
      ok: false,
      reason: 'Native 1.58-bit training uses a BF16 master-weight recipe.',
    }
  }
  return { ok: true }
}

export interface TrainingMemoryEstimate {
  weightStateGb: number
  gradientStateGb: number
  optimizerStateGb: number
  persistentStateGb: number
  activationWorkspaceGb: number
  communicationBuffersGb: number
  /** Accelerator-resident live state required for useful training work. */
  requiredHbmGb: number
  /** Bounded host staging for checkpoints, optimizer paging, and activations. */
  requiredSystemRamGb: number
  /** @deprecated Alias of requiredHbmGb for save/UI compatibility. */
  totalGb: number
  /** Packed checkpoint weight footprint, not live training state. */
  packedCheckpointGb: number
}

/**
 * Aggregate cluster memory estimate. ZeRO/FSDP change per-device placement, but
 * do not make aggregate optimizer state disappear, so sharding is intentionally
 * not applied here. Activations use active MoE parameters while persistent
 * weights and optimizer state use total parameters.
 */
export function estimateTrainingMemoryGb(opts: {
  paramsB: number
  activeParamsB?: number
  family?: string
  numerics?: TrainingNumerics
  activationCheckpointing?: boolean
}): TrainingMemoryEstimate {
  const totalB = Math.max(0.001, opts.paramsB)
  const activeB =
    opts.family === 'moe'
      ? Math.max(0.001, Math.min(totalB, opts.activeParamsB ?? totalB * 0.1))
      : totalB
  const numerics = opts.numerics ?? DEFAULT_TRAINING_NUMERICS
  const precision = TRAINING_PRECISION_PROFILES[numerics.computeFormat]

  // Adam-style live state. Lower-precision recipes retain BF16 weights and
  // gradients plus an FP32 master copy; FP32 has no separate master copy.
  const fullFp32 = numerics.computeFormat === 'fp32'
  const weightStateGb = totalB * (fullFp32 ? 4 : 2) + (fullFp32 ? 0 : totalB * 4)
  const gradientStateGb = totalB * (fullFp32 ? 4 : 2)
  const optimizerStateGb = totalB * 8
  const persistentStateGb = weightStateGb + gradientStateGb + optimizerStateGb
  const checkpointingMult = opts.activationCheckpointing ? 0.45 : 1
  const activationWorkspaceGb =
    Math.max(4, activeB * 1.5) * precision.activationMemoryMultiplier * checkpointingMult
  const communicationBuffersGb = Math.max(2, activeB * (opts.family === 'moe' ? 0.35 : 0.2))
  const packedCheckpointGb = nativeWeightMemoryGb(
    totalB,
    nativeWeightPrecisionForNumerics(numerics),
  )

  const requiredHbmGb = persistentStateGb + activationWorkspaceGb + communicationBuffersGb
  // Host memory is staging, not a second complete copy of cluster state. Keep
  // it large enough for an atomic checkpoint plus bounded live-state paging.
  const requiredSystemRamGb = Math.max(
    16,
    packedCheckpointGb * 1.25 +
      optimizerStateGb * 0.08 +
      gradientStateGb * 0.05 +
      activationWorkspaceGb * 0.1,
  )

  return {
    weightStateGb,
    gradientStateGb,
    optimizerStateGb,
    persistentStateGb,
    activationWorkspaceGb,
    communicationBuffersGb,
    requiredHbmGb,
    requiredSystemRamGb,
    totalGb: requiredHbmGb,
    packedCheckpointGb,
  }
}

export interface TrainingAllocationRequest {
  id: string
  /** Zero pauses the consumer. Missing values retain equal-share behavior. */
  weight?: number
  /** Ineligible jobs receive no PF and do not dilute compatible jobs. */
  eligible?: boolean
  /** Precision/hardware work multiplier after raw PF has been conserved. */
  throughputMultiplier?: number
}

export interface TrainingComputeAllocation {
  rawPf: number
  effectivePf: number
  share: number
}

export interface TrainingHardwarePool {
  id: string
  /** BF16-equivalent PF available from this hardware group. */
  rawPf: number
  hardwareGeneration: number
  /** Optional provider/SKU capability list; generation is the fallback. */
  supportedTrainingFormats?: readonly TrainingComputeFormat[]
}

export interface NumericalTrainingAllocationRequest extends TrainingAllocationRequest {
  numerics: TrainingNumerics
}

/**
 * Conserve one physical compute pool, then convert each allocation into useful
 * work through its own precision/hardware multiplier.
 */
export function allocateWeightedTrainingCompute(
  totalRawPf: number,
  requests: readonly TrainingAllocationRequest[],
): Record<string, TrainingComputeAllocation> {
  const pool = Math.max(0, Number.isFinite(totalRawPf) ? totalRawPf : 0)
  const active = requests.map((request) => ({
    ...request,
    normalizedWeight:
      request.eligible === false
        ? 0
        : Math.max(0, Number.isFinite(request.weight) ? (request.weight ?? 1) : 1),
  }))
  const totalWeight = active.reduce((sum, request) => sum + request.normalizedWeight, 0)
  const result: Record<string, TrainingComputeAllocation> = {}
  for (const request of active) {
    const share = totalWeight > 0 ? request.normalizedWeight / totalWeight : 0
    const rawPf = pool * share
    result[request.id] = {
      rawPf,
      effectivePf: rawPf * Math.max(0, request.throughputMultiplier ?? 1),
      share,
    }
  }
  return result
}

/**
 * Allocate each hardware generation independently. Older racks can backfill a
 * BF16 job while FP8/NVFP4 jobs compete only for compatible accelerators.
 */
export function allocateTrainingHardwarePools(
  pools: readonly TrainingHardwarePool[],
  requests: readonly NumericalTrainingAllocationRequest[],
): Record<string, TrainingComputeAllocation> {
  const result = Object.fromEntries(
    requests.map((request) => [request.id, { rawPf: 0, effectivePf: 0, share: 0 }]),
  ) as Record<string, TrainingComputeAllocation>
  const totalPool = pools.reduce((sum, pool) => sum + Math.max(0, pool.rawPf), 0)

  for (const pool of pools) {
    const compatible = requests.map((request) => ({
      id: request.id,
      weight: request.weight,
      eligible:
        request.eligible !== false &&
        (pool.supportedTrainingFormats == null ||
          pool.supportedTrainingFormats.includes(request.numerics.computeFormat)) &&
        supportsTrainingFormat(pool.hardwareGeneration, request.numerics.computeFormat),
      throughputMultiplier:
        trainingFormatThroughput(pool.hardwareGeneration, request.numerics) *
        Math.max(0, request.throughputMultiplier ?? 1),
    }))
    const allocation = allocateWeightedTrainingCompute(pool.rawPf, compatible)
    for (const request of requests) {
      const row = allocation[request.id]
      if (!row) continue
      result[request.id]!.rawPf += row.rawPf
      result[request.id]!.effectivePf += row.effectivePf
    }
  }

  for (const allocation of Object.values(result)) {
    allocation.share = totalPool > 0 ? allocation.rawPf / totalPool : 0
  }
  return result
}

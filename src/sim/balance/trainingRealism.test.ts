import { describe, expect, it } from 'vitest'
import {
  COMPUTE_OPTIMAL_TOKENS_PER_PARAMETER,
  computeOptimalDensePfDays,
  computeOptimalTrainingTokensMTok,
  denseTrainingPfDays,
  estimateTrainingEconomics,
  FLOPS_PER_PF_DAY,
  moeTrainingComputeParamsB,
  trainCostPfDays,
  TRAINING_CALENDAR_COMPRESSION,
  trainingVolumeMultiplier,
  verificationPfDays,
} from './training'
import {
  allocateWeightedTrainingCompute,
  allocateTrainingHardwarePools,
  estimateTrainingMemoryGb,
  supportsTrainingFormat,
  trainingFormatThroughput,
  trainingNumericsEconomicsProfile,
  validateTrainingNumerics,
} from './trainingPrecision'
import { buildScaledModel } from './modelBuild'
import { ECONOMY } from './economy'
import { MODEL_SYSTEMS_WORK_MULTIPLIER } from './computeCalibration'

describe('training formula v2', () => {
  it('matches exact C≈6ND reference values before calendar compression', () => {
    expect(FLOPS_PER_PF_DAY).toBe(8.64e19)
    expect(COMPUTE_OPTIMAL_TOKENS_PER_PARAMETER).toBe(20)
    expect(denseTrainingPfDays(1, 20_000)).toBeCloseTo(1.3888888889, 9)
    expect(denseTrainingPfDays(7, 140_000)).toBeCloseTo(68.0555555556, 8)
    expect(denseTrainingPfDays(70, 1_400_000)).toBeCloseTo(6805.5555555556, 7)
  })

  it('provides golden 20N dense work without changing campaign recipe pacing', () => {
    expect(computeOptimalTrainingTokensMTok(70)).toBe(1_400_000)
    expect(computeOptimalTrainingTokensMTok(405)).toBe(8_100_000)
    expect(computeOptimalDensePfDays(1)).toBeCloseTo(1.3888888889, 9)
    expect(computeOptimalDensePfDays(7)).toBeCloseTo(68.0555555556, 8)
    expect(computeOptimalDensePfDays(70)).toBeCloseTo(6_805.5555555556, 7)
    expect(computeOptimalDensePfDays(405)).toBeCloseTo(227_812.5, 6)
  })

  it('applies two-times calendar compression after physical work', () => {
    const gamePfDays = trainCostPfDays({
      paramsB: 1,
      family: 'dense',
      trainEfficiency: 1,
      trainingTokensMTok: 20_000,
      formulaVersion: 2,
    })
    expect(TRAINING_CALENDAR_COMPRESSION).toBe(2)
    expect(gamePfDays).toBeCloseTo(
      (1.3888888889 * MODEL_SYSTEMS_WORK_MULTIPLIER) / 2,
      9,
    )
  })

  it('charges every additional token with no high-volume clamp', () => {
    expect(trainingVolumeMultiplier(40)).toBeCloseTo(2 * trainingVolumeMultiplier(20))
    const twenty = trainCostPfDays({
      paramsB: 1,
      family: 'dense',
      trainEfficiency: 1,
      dataRatio: 20,
    })
    const forty = trainCostPfDays({
      paramsB: 1,
      family: 'dense',
      trainEfficiency: 1,
      dataRatio: 40,
    })
    expect(forty).toBeCloseTo(twenty * 2, 10)
  })

  it('accounts for held-out verification as forward-only 2ND work', () => {
    expect(verificationPfDays(1, 2_000)).toBeCloseTo(0.0462962963, 9)
    const withoutVerify = trainCostPfDays({
      paramsB: 1,
      family: 'dense',
      trainEfficiency: 1,
      trainingTokensMTok: 20_000,
    })
    const withVerify = trainCostPfDays({
      paramsB: 1,
      family: 'dense',
      trainEfficiency: 1,
      trainingTokensMTok: 20_000,
      verificationTokensMTok: 2_000,
    })
    expect(withVerify - withoutVerify).toBeCloseTo(
      (verificationPfDays(1, 2_000) * MODEL_SYSTEMS_WORK_MULTIPLIER) / 2,
      9,
    )
  })

  it('uses active MoE work plus a small routing/communication overhead', () => {
    expect(moeTrainingComputeParamsB(1_000, 32)).toBeCloseTo(35.2, 10)
    const tokens = 1_000_000
    const moe = trainCostPfDays({
      paramsB: 1_000,
      activeParamsB: 32,
      family: 'moe',
      trainEfficiency: 1,
      trainingTokensMTok: tokens,
    })
    const dense = trainCostPfDays({
      paramsB: 35.2,
      family: 'dense',
      trainEfficiency: 1,
      trainingTokensMTok: tokens,
    })
    expect(moe).toBeCloseTo(dense, 8)
  })

  it('matches published Chinchilla and Llama 3 dense-work anchors', () => {
    expect(denseTrainingPfDays(70, 1_400_000)).toBeCloseTo(6.8055555556e3, 6)
    expect(denseTrainingPfDays(405, 15_600_000)).toBeCloseTo(438_750, 3)
  })

  it('bounds explicit MoE active-path overhead between five and twenty percent', () => {
    expect(moeTrainingComputeParamsB(671, 37, 0)).toBeCloseTo(38.85)
    expect(moeTrainingComputeParamsB(671, 37, 1)).toBeCloseTo(44.4)
  })

  it('combines sparse topology work with the omni architecture multiplier', () => {
    const common = {
      paramsB: 100,
      activeParamsB: 10,
      trainEfficiency: 1,
      trainingTokensMTok: 100_000,
    }
    const sparseLanguage = trainCostPfDays({
      ...common,
      family: 'moe',
      backbone: 'moe',
    })
    const sparseOmni = trainCostPfDays({
      ...common,
      family: 'omni',
      backbone: 'moe',
    })
    const denseOmni = trainCostPfDays({
      ...common,
      family: 'omni',
      backbone: 'dense',
    })

    expect(sparseOmni).toBeCloseTo(sparseLanguage * 1.45 * 1.35, 8)
    expect(sparseOmni).toBeLessThan(denseOmni)
  })

  it('keeps the flattened v1 curve available only by explicit version', () => {
    expect(trainCostPfDays({
      paramsB: 1,
      family: 'dense',
      trainEfficiency: 1,
      dataRatio: 6,
      formulaVersion: 1,
    })).toBeCloseTo(3.9, 10)
  })
})

describe('training numerical formats', () => {
  const numerics = (computeFormat: 'fp32' | 'fp16_mixed' | 'fp8_hybrid' | 'nvfp4') => ({
    computeFormat,
    nativeWeightFormat: 'float' as const,
    recipeVersion: 1,
  })

  it('prices setup at roughly twenty-five times the old upfront baseline', () => {
    const estimate = estimateTrainingEconomics({
      paramsB: 1,
      family: 'dense',
      trainEfficiency: 1,
      trainingTokensMTok: 140_000,
      verificationTokensMTok: 0,
      numerics: numerics('fp16_mixed'),
    })
    const oldSetupCost =
      estimate.targetPfDays *
      ECONOMY.trainUpfrontPerPfDay *
      0.08 *
      estimate.precision.upfrontCashMultiplier

    expect(oldSetupCost).toBeGreaterThan(12_000)
    expect(oldSetupCost).toBeLessThan(13_000)
    expect(estimate.setupCost / oldSetupCost).toBeCloseTo(25, 3)
    expect(estimate.setupCost).toBeGreaterThan(310_000)
    expect(estimate.setupCost).toBeLessThan(320_000)
  })

  it('makes FP32 the highest-cost, highest-ceiling training recipe', () => {
    const common = {
      paramsB: 70,
      family: 'dense' as const,
      trainEfficiency: 0.8,
      trainingTokensMTok: 1_400_000,
      verificationTokensMTok: 100_000,
    }
    const fp32 = estimateTrainingEconomics({ ...common, numerics: numerics('fp32') })
    const fp16 = estimateTrainingEconomics({ ...common, numerics: numerics('fp16_mixed') })
    const fp8 = estimateTrainingEconomics({ ...common, numerics: numerics('fp8_hybrid') })

    expect(fp32.targetPfDays).toBeGreaterThan(fp16.targetPfDays)
    expect(fp32.upfrontCash).toBeGreaterThan(fp16.upfrontCash)
    expect(fp32.cashBurnPerDay).toBeGreaterThan(fp16.cashBurnPerDay)
    expect(fp32.precision.qualityCeilingMultiplier).toBeGreaterThan(
      fp16.precision.qualityCeilingMultiplier,
    )
    expect(fp8.targetPfDays).toBeLessThan(fp16.targetPfDays)
    expect(fp8.upfrontCash).toBeLessThan(fp16.upfrontCash)
    expect(fp8.cashBurnPerDay).toBeLessThan(fp16.cashBurnPerDay)
  })

  it('trades lower-precision memory and compute for volatility and hard quality caps', () => {
    const fp16Memory = estimateTrainingMemoryGb({
      paramsB: 70,
      numerics: numerics('fp16_mixed'),
    })
    const nvfp4Memory = estimateTrainingMemoryGb({
      paramsB: 70,
      numerics: numerics('nvfp4'),
    })
    const common = {
      id: 'precision-model',
      name: 'Precision model',
      paramsB: 70,
      family: 'dense' as const,
      day: 1,
      dataCoverage: 20,
      dataQuality: 1.35,
      researchMult: 1.14,
      outcomeSeed: 9,
    }
    const fp32 = buildScaledModel({ ...common, trainingNumerics: numerics('fp32') })
    const fp16 = buildScaledModel({ ...common, trainingNumerics: numerics('fp16_mixed') })
    const nvfp4 = buildScaledModel({ ...common, trainingNumerics: numerics('nvfp4') })
    const fp16Precision = trainingNumericsEconomicsProfile(numerics('fp16_mixed'))
    const nvfp4Precision = trainingNumericsEconomicsProfile(numerics('nvfp4'))

    expect(nvfp4Memory.requiredHbmGb).toBeLessThan(fp16Memory.requiredHbmGb)
    expect(nvfp4Precision.lossVolatilityMultiplier).toBeGreaterThan(
      fp16Precision.lossVolatilityMultiplier,
    )
    expect(nvfp4.capability).toBeLessThan(fp16.capability)
    expect(fp16.capability).toBeLessThan(fp32.capability)
    expect(nvfp4.inferCostMult).toBeLessThan(fp16.inferCostMult)
    expect(nvfp4.capability).toBeLessThanOrEqual(fp32.capability * 0.9 + 1e-9)
    for (const score of Object.values(nvfp4.benchmarks)) {
      expect(score).toBeLessThan(100)
    }
  })

  it('gates FP8 and NVFP4 by hardware generation', () => {
    expect(supportsTrainingFormat(1, 'bf16_mixed')).toBe(true)
    expect(supportsTrainingFormat(1, 'fp8_hybrid')).toBe(false)
    expect(supportsTrainingFormat(2, 'fp8_hybrid')).toBe(true)
    expect(supportsTrainingFormat(2, 'nvfp4')).toBe(false)
    expect(supportsTrainingFormat(3, 'nvfp4')).toBe(true)
  })

  it('uses conservative achieved throughput rather than peak marketing FLOPS', () => {
    expect(trainingFormatThroughput(1, {
      computeFormat: 'fp32', nativeWeightFormat: 'float', recipeVersion: 1,
    })).toBeCloseTo(0.45)
    expect(trainingFormatThroughput(2, {
      computeFormat: 'fp8_hybrid', nativeWeightFormat: 'float', recipeVersion: 1,
    })).toBeCloseTo(1.7)
    expect(trainingFormatThroughput(3, {
      computeFormat: 'nvfp4', nativeWeightFormat: 'float', recipeVersion: 1,
    })).toBeCloseTo(2.6)
  })

  it('treats 1.58-bit as a native BF16-master architecture', () => {
    expect(validateTrainingNumerics({
      hardwareGeneration: 2,
      numerics: {
        computeFormat: 'fp8_hybrid', nativeWeightFormat: 'ternary_1_58', recipeVersion: 1,
      },
      researchUnlocked: ['opt_fp8_train', 'dense_bitnet'],
    })).toEqual({
      ok: false,
      reason: 'Native 1.58-bit training uses a BF16 master-weight recipe.',
    })
    expect(validateTrainingNumerics({
      hardwareGeneration: 1,
      numerics: {
        computeFormat: 'bf16_mixed', nativeWeightFormat: 'ternary_1_58', recipeVersion: 1,
      },
      researchUnlocked: ['opt_mixed', 'dense_bitnet'],
      family: 'dense',
    })).toEqual({ ok: true })
    expect(validateTrainingNumerics({
      hardwareGeneration: 1,
      numerics: {
        computeFormat: 'bf16_mixed', nativeWeightFormat: 'ternary_1_58', recipeVersion: 1,
      },
      researchUnlocked: ['opt_mixed', 'dense_bitnet'],
      family: 'moe',
    })).toEqual({
      ok: false,
      reason: 'Native 1.58-bit weights currently require a dense backbone.',
    })
  })

  it('does not pretend ternary checkpoints remove live optimizer memory', () => {
    const float = estimateTrainingMemoryGb({
      paramsB: 70,
      numerics: {
        computeFormat: 'bf16_mixed', nativeWeightFormat: 'float', recipeVersion: 1,
      },
    })
    const ternary = estimateTrainingMemoryGb({
      paramsB: 70,
      numerics: {
        computeFormat: 'bf16_mixed', nativeWeightFormat: 'ternary_1_58', recipeVersion: 1,
      },
    })
    expect(float.persistentStateGb).toBe(1_120)
    expect(ternary.persistentStateGb).toBe(float.persistentStateGb)
    expect(float.packedCheckpointGb).toBe(140)
    // 2-bit packing + 15% scale overhead — still ~7× smaller than BF16.
    expect(ternary.packedCheckpointGb).toBeCloseTo(20.125, 6)
  })

  it('conserves raw PF while weighting eligible concurrent jobs', () => {
    const allocations = allocateWeightedTrainingCompute(120, [
      { id: 'safe', weight: 1 },
      { id: 'fast', weight: 2, throughputMultiplier: 1.7 },
      { id: 'unsupported', weight: 9, eligible: false },
    ])
    expect(allocations.safe.rawPf).toBeCloseTo(40)
    expect(allocations.fast.rawPf).toBeCloseTo(80)
    expect(allocations.fast.effectivePf).toBeCloseTo(136)
    expect(allocations.unsupported.rawPf).toBe(0)
    expect(Object.values(allocations).reduce((sum, allocation) => sum + allocation.rawPf, 0))
      .toBeCloseTo(120)
  })

  it('allocates mixed hardware only to numerically compatible jobs', () => {
    const allocations = allocateTrainingHardwarePools(
      [
        { id: 'a100', rawPf: 60, hardwareGeneration: 1 },
        { id: 'h100', rawPf: 60, hardwareGeneration: 2 },
      ],
      [
        {
          id: 'bf16', weight: 1,
          numerics: {
            computeFormat: 'bf16_mixed', nativeWeightFormat: 'float', recipeVersion: 1,
          },
        },
        {
          id: 'fp8', weight: 1,
          numerics: {
            computeFormat: 'fp8_hybrid', nativeWeightFormat: 'float', recipeVersion: 1,
          },
        },
      ],
    )
    // A100 goes entirely to BF16. H100 is shared evenly.
    expect(allocations.bf16.rawPf).toBeCloseTo(90)
    expect(allocations.bf16.effectivePf).toBeCloseTo(90)
    expect(allocations.fp8.rawPf).toBeCloseTo(30)
    expect(allocations.fp8.effectivePf).toBeCloseTo(51)
    expect(Object.values(allocations).reduce((sum, allocation) => sum + allocation.rawPf, 0))
      .toBeCloseTo(120)
  })
})

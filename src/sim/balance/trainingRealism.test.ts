import { describe, expect, it } from 'vitest'
import {
  COMPUTE_OPTIMAL_TOKENS_PER_PARAMETER,
  denseTrainingPfDays,
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
  validateTrainingNumerics,
} from './trainingPrecision'

describe('training formula v2', () => {
  it('matches exact C≈6ND reference values before calendar compression', () => {
    expect(FLOPS_PER_PF_DAY).toBe(8.64e19)
    expect(COMPUTE_OPTIMAL_TOKENS_PER_PARAMETER).toBe(20)
    expect(denseTrainingPfDays(1, 20_000)).toBeCloseTo(1.3888888889, 9)
    expect(denseTrainingPfDays(7, 140_000)).toBeCloseTo(68.0555555556, 8)
    expect(denseTrainingPfDays(70, 1_400_000)).toBeCloseTo(6805.5555555556, 7)
  })

  it('applies four-times calendar compression after physical work', () => {
    const gamePfDays = trainCostPfDays({
      paramsB: 1,
      family: 'dense',
      trainEfficiency: 1,
      trainingTokensMTok: 20_000,
      formulaVersion: 2,
    })
    expect(TRAINING_CALENDAR_COMPRESSION).toBe(4)
    expect(gamePfDays).toBeCloseTo(1.3888888889 / 4, 9)
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
    expect(withVerify - withoutVerify).toBeCloseTo(verificationPfDays(1, 2_000) / 4, 9)
  })

  it('uses active MoE work plus a small routing/communication overhead', () => {
    expect(moeTrainingComputeParamsB(1_000, 32)).toBeCloseTo(80.4, 10)
    const tokens = 1_000_000
    const moe = trainCostPfDays({
      paramsB: 1_000,
      activeParamsB: 32,
      family: 'moe',
      trainEfficiency: 1,
      trainingTokensMTok: tokens,
    })
    const dense = trainCostPfDays({
      paramsB: 80.4,
      family: 'dense',
      trainEfficiency: 1,
      trainingTokensMTok: tokens,
    })
    expect(moe).toBeCloseTo(dense, 8)
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
    })).toBeCloseTo(0.065)
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
    expect(ternary.packedCheckpointGb).toBeCloseTo(13.825, 6)
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

import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { buildScaledModel } from '../balance/modelBuild'
import { forecastTrainingV3, ioForPreset } from '../balance/trainingV3'
import { createEmptyLabData } from '../balance/data'
import {
  defaultServePrecisionForModel,
  pfPerMTokForModel,
} from '../balance/tokenServe'
import { validateTrainingNumerics } from '../balance/trainingPrecision'
import type { SubPlan, TrainingNumerics } from '../types'
import { modelForServePrecision, planModelServePrecision } from './plans'
import { playerTrainingResourcePlan, startTraining } from './training'
import { modelHostNeed } from './hosting'

function numerics(
  computeFormat: TrainingNumerics['computeFormat'],
): TrainingNumerics {
  return { computeFormat, nativeWeightFormat: 'float', recipeVersion: 1 }
}

function richState(seed: number, extraUnlocks: string[] = []) {
  const state = createGame(seed)
  return {
    ...state,
    player: {
      ...state.player,
      cash: 5_000_000_000,
      allocation: { training: 0.9, inference: 0.05, research: 0.05 },
      researchUnlocked: [
        ...new Set([...state.player.researchUnlocked, ...extraUnlocks]),
      ],
    },
  }
}

describe('compute format training and serve speed', () => {
  it('FP16 jobs burn more useful PF and finish faster than FP32 on the same allocation', () => {
    const fp32State = startTraining(richState(4401), {
      name: 'FP32 run',
      family: 'dense',
      paramsB: 1,
      computePriority: 100,
      trainingNumerics: numerics('fp32'),
    })
    const fp16State = startTraining(richState(4401, ['opt_fp16']), {
      name: 'FP16 run',
      family: 'dense',
      paramsB: 1,
      computePriority: 100,
      trainingNumerics: numerics('fp16_mixed'),
    })
    const fp32Job = fp32State.player.trainingJob!
    const fp16Job = fp16State.player.trainingJob!
    const fp32Pf = playerTrainingResourcePlan(fp32State).jobs[fp32Job.id]!
      .effectivePf
    const fp16Pf = playerTrainingResourcePlan(fp16State).jobs[fp16Job.id]!
      .effectivePf

    expect(fp16Pf).toBeGreaterThan(fp32Pf)
    expect(fp16Job.targetPfDays).toBeLessThan(fp32Job.targetPfDays)
    expect(fp16Pf / fp16Job.targetPfDays).toBeGreaterThan(
      fp32Pf / fp32Job.targetPfDays,
    )
  })

  it('keeps BF16/FP8/NVFP4 locked until their training research exists', () => {
    expect(
      validateTrainingNumerics({
        hardwareGeneration: 3,
        numerics: numerics('bf16_mixed'),
        researchUnlocked: ['opt_fp16'],
      }).ok,
    ).toBe(false)
    expect(
      validateTrainingNumerics({
        hardwareGeneration: 3,
        numerics: numerics('fp8_hybrid'),
        researchUnlocked: ['opt_fp16', 'opt_mixed'],
      }).ok,
    ).toBe(false)
    expect(
      validateTrainingNumerics({
        hardwareGeneration: 3,
        numerics: numerics('nvfp4'),
        researchUnlocked: ['opt_fp16', 'opt_mixed', 'opt_fp8_train'],
      }).ok,
    ).toBe(false)

    const blocked = startTraining(richState(4402, ['opt_fp16']), {
      name: 'BF16 locked',
      family: 'dense',
      paramsB: 1,
      trainingNumerics: numerics('bf16_mixed'),
    })
    expect(blocked.player.trainingJob).toBeFalsy()
    expect(blocked.alerts[0]?.message).toMatch(/Mixed Precision Training/)
  })

  it('serves the trained format by default with faster host tok/s and cheaper PF/MTok', () => {
    const common = {
      id: 'speed-model',
      name: 'Speed model',
      paramsB: 8,
      family: 'dense' as const,
      day: 1,
      dataCoverage: 6,
      dataQuality: 1,
      outcomeSeed: 11,
    }
    const fp32 = buildScaledModel({
      ...common,
      id: 'fp32-model',
      trainingNumerics: numerics('fp32'),
    })
    const fp16 = buildScaledModel({
      ...common,
      id: 'fp16-model',
      trainingNumerics: numerics('fp16_mixed'),
    })
    const unlocks = ['opt_fp16']
    const emptyPlan = {
      servePrecision: 'fp32',
      servePrecisionByModel: {},
      modelIds: [fp16.id],
    } as SubPlan

    expect(defaultServePrecisionForModel(fp32)).toBe('fp32')
    expect(defaultServePrecisionForModel(fp16)).toBe('fp16')
    expect(planModelServePrecision(emptyPlan, fp16, unlocks)).toBe('fp16')

    expect(fp16.serviceProfile!.interactiveTokPerSec).toBeGreaterThan(
      fp32.serviceProfile!.interactiveTokPerSec,
    )
    const fp32Served = modelForServePrecision(
      fp32,
      defaultServePrecisionForModel(fp32),
      unlocks,
    )
    const fp16Served = modelForServePrecision(
      fp16,
      defaultServePrecisionForModel(fp16),
      unlocks,
    )
    expect(pfPerMTokForModel(fp16Served, 1)).toBeLessThan(
      pfPerMTokForModel(fp32Served, 1),
    )
    expect(modelHostNeed(fp16, { precision: 'fp16' }).hostPf).toBeLessThan(
      modelHostNeed(fp32, { precision: 'fp32' }).hostPf,
    )
  })
})

describe('compute format forecast preview', () => {
  const spec = {
    name: 'Preview',
    backbone: 'dense' as const,
    productPreset: 'language' as const,
    paramsB: 1,
    io: ioForPreset('language'),
    mode: 'pretrain' as const,
    dataPlan: {
      totalUnits: 6_000,
      totalMTok: 6_000,
      trainShare: 0.82,
      weights: { chat: 0.45, code: 0.35, math: 0.2 },
      allowSynthetic: true,
    },
  }

  function quote(computeFormat: TrainingNumerics['computeFormat']) {
    return forecastTrainingV3({
      spec: { ...spec, trainingNumerics: numerics(computeFormat) },
      labData: createEmptyLabData(),
      dataQuality: 1,
      trainEfficiency: 0.6,
      trainPoolPf: 4,
      hardwareGeneration: 1,
    })
  }

  it('shows FP16 finishing faster, hosting faster, and serving cheaper than FP32', () => {
    const fp32 = quote('fp32')
    const fp16 = quote('fp16_mixed')

    expect(fp16.etaDays).toBeLessThan(fp32.etaDays)
    expect(fp16.usefulTrainPf!).toBeGreaterThan(fp32.usefulTrainPf!)
    expect(fp16.interactiveTokPerSec).toBeGreaterThan(fp32.interactiveTokPerSec)
    expect(fp16.servePfPerMTok!).toBeLessThan(fp32.servePfPerMTok!)
    expect(fp16.servePrecision).toBe('fp16')
    expect(fp32.servePrecision).toBe('fp32')
  })
})

import { describe, expect, it } from 'vitest'
import type { TrainingJob } from '../types'
import {
  completedPostTrainStages,
  mergePostTrainStageEffectiveness,
  postTrainFailureRisk,
  postTrainStageEffectiveness,
  postTrainTargetPfDays,
} from './postTraining'

function job(trainMTok: number, quality = 70): TrainingJob {
  return {
    targetParamsB: 7,
    trainMTok,
    dataQualityUsed: quality,
    dataPlan: {
      totalUnits: trainMTok,
      totalMTok: trainMTok,
      trainShare: 0.82,
      weights: { chat: 0.5, code: 0.3, math: 0.2 },
      allowSynthetic: false,
    },
    postTrain: 'tools',
    postTrainProgress: 18,
    postTrainTarget: 18,
    postTrainDaysElapsed: 7,
  } as TrainingJob
}

describe('post-training realism', () => {
  it('scales expensive one-shot stage work sublinearly with relevant data volume', () => {
    const small = postTrainTargetPfDays(job(100), 'tools')
    const large = postTrainTargetPfDays(job(100_000), 'tools')
    expect(small).toBeGreaterThanOrEqual(18)
    expect(large).toBeGreaterThan(small * 1.5)
    expect(large).toBeLessThan(small * 6)
  })

  it('makes large models and repeated passes materially longer', () => {
    const recipe = job(20_000, 75)
    const oneB = postTrainTargetPfDays(recipe, 'process', 1)
    const hundredB = postTrainTargetPfDays(recipe, 'process', 100)
    const sparseHundredB = postTrainTargetPfDays(
      { ...recipe, activeParamsB: 10 },
      'process',
      100,
    )
    const activeOnly = postTrainTargetPfDays(recipe, 'process', 10)
    const repeat = postTrainTargetPfDays(
      { ...recipe, postTrainStageRuns: { process: 2 } },
      'process',
      100,
    )

    expect(oneB).toBeGreaterThan(150)
    expect(hundredB).toBeGreaterThan(oneB * 2)
    expect(sparseHundredB).toBeLessThan(hundredB)
    expect(sparseHundredB).toBeGreaterThan(activeOnly)
    expect(repeat).toBeGreaterThan(hundredB * 1.35)
  })

  it('derives explainable risk from stage, scale, data quality and research', () => {
    const mature = job(80_000, 92)
    mature.targetParamsB = 7
    mature.outcomeRisk = 'low'
    const fragile = job(80, 25)
    fragile.targetParamsB = 700
    fragile.outcomeRisk = 'high'
    fragile.synthLqShare = 0.7
    fragile.postTrainStageRuns = { process: 2 }

    const safeRisk = postTrainFailureRisk({
      job: mature,
      stage: 'sft',
      researchUnlocked: ['align_sft'],
      models: [],
    })
    const risky = postTrainFailureRisk({
      job: fragile,
      stage: 'process',
      researchUnlocked: [],
      models: [],
    })

    expect(safeRisk.probability).toBeLessThan(0.08)
    expect(risky.probability).toBeGreaterThan(safeRisk.probability * 3)
    expect(risky.band).toMatch(/high|critical/)
    expect(risky.factors).toContain('thin relevant dataset')
    expect(risky.factors).toContain('large-model optimization pressure')
  })

  it('makes conservative numerics and stabilizing campaign choices reduce failure risk', () => {
    const stable = job(20_000, 82)
    stable.trainingNumerics = {
      computeFormat: 'fp32',
      nativeWeightFormat: 'float',
      recipeVersion: 1,
    }
    stable.campaignModifiers = {
      capabilityDelta: 0,
      reliabilityDelta: 1,
      safetyDelta: 0,
      breakthroughBias: 0,
      stumbleRisk: -0.06,
      dataQualityDelta: 0,
      verifiedRecursiveCapabilityBonus: 0,
    }
    const aggressive: TrainingJob = {
      ...stable,
      trainingNumerics: {
        computeFormat: 'nvfp4',
        nativeWeightFormat: 'float',
        recipeVersion: 1,
      },
      campaignModifiers: {
        ...stable.campaignModifiers,
        stumbleRisk: 0.09,
      },
    }

    const stableRisk = postTrainFailureRisk({
      job: stable,
      stage: 'rlhf',
      researchUnlocked: ['align_rlhf', 'data_pref'],
      models: [],
    })
    const aggressiveRisk = postTrainFailureRisk({
      job: aggressive,
      stage: 'rlhf',
      researchUnlocked: ['align_rlhf', 'data_pref'],
      models: [],
    })

    expect(aggressiveRisk.probability).toBeGreaterThan(
      stableRisk.probability + 0.08,
    )
    expect(aggressiveRisk.factors).toContain('aggressive numerical precision')
    expect(aggressiveRisk.factors).toContain('unresolved campaign instability')
  })

  it('rewards relevant volume, quality, time and research without bypassing compute', () => {
    const weakJob = job(100, 30)
    weakJob.postTrainProgress = 4
    weakJob.postTrainDaysElapsed = 1
    const strongJob = job(20_000, 90)
    strongJob.postTrainTarget = postTrainTargetPfDays(strongJob, 'tools')
    strongJob.postTrainProgress = strongJob.postTrainTarget
    const weak = postTrainStageEffectiveness({
      job: weakJob,
      stage: 'tools',
      researchUnlocked: [],
      models: [],
    })
    const strong = postTrainStageEffectiveness({
      job: strongJob,
      stage: 'tools',
      researchUnlocked: ['domain_agents', 'domain_coding', 'align_process'],
      models: [],
    })
    expect(strong).toBeGreaterThan(weak * 2)
    expect(strong).toBeLessThanOrEqual(1)
  })

  it('uses the larger PF target as the sole completion gate', () => {
    const staged = job(5_000, 80)
    staged.postTrainTarget = postTrainTargetPfDays(staged, 'tools', staged.targetParamsB)
    staged.postTrainProgress = staged.postTrainTarget
    staged.postTrainDaysElapsed = 0
    expect(completedPostTrainStages(staged)).toContain('tools')
    expect(staged.postTrainTarget).toBeGreaterThan(65)
  })

  it('makes repeated stage passes improve only the remaining headroom', () => {
    const first = mergePostTrainStageEffectiveness(undefined, 0.8, 0)
    const second = mergePostTrainStageEffectiveness(first, 0.8, 1)
    const third = mergePostTrainStageEffectiveness(second, 0.8, 2)
    expect(first).toBeCloseTo(0.8)
    expect(second).toBeGreaterThan(first)
    expect(third).toBeGreaterThan(second)
    expect(third - second).toBeLessThan(second - first)
    expect(third).toBeLessThan(1)
  })
})

import { describe, expect, it } from 'vitest'
import type { TrainingJob } from '../types'
import {
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
    expect(large).toBeLessThan(small * 4)
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
})

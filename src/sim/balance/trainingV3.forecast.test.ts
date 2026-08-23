import { describe, expect, it } from 'vitest'
import type { TrainingSpec } from '../types'
import { createEmptyLabData } from './data'
import { forecastTrainingV3, ioForPreset } from './trainingV3'

const BASE_SPEC: TrainingSpec = {
  name: 'Student',
  backbone: 'dense',
  productPreset: 'language',
  paramsB: 1,
  io: ioForPreset('language'),
  mode: 'pretrain',
  dataPlan: {
    totalUnits: 6_000,
    totalMTok: 6_000,
    trainShare: 0.82,
    weights: { chat: 0.45, code: 0.35, math: 0.2 },
    allowSynthetic: true,
  },
}

function quote(
  spec: TrainingSpec,
  teacher?: { paramsB: number; capability: number },
) {
  return forecastTrainingV3({
    spec,
    labData: createEmptyLabData(),
    dataQuality: 1,
    trainEfficiency: 0.6,
    trainPoolPf: 24,
    teacherParamsB: teacher?.paramsB,
    teacherCapability: teacher?.capability,
  })
}

describe('teacher-aware training forecast', () => {
  it('projects size-gap transfer instead of only widening the student ceiling', () => {
    const pretrain = quote(BASE_SPEC)
    const withoutTeacherScore = quote({
      ...BASE_SPEC,
      mode: 'distill',
      teacherId: 'teacher',
      distillTeacherShare: 0.8,
    })
    const teacher = { paramsB: 70, capability: 82 }
    const distilled = quote(
      {
        ...BASE_SPEC,
        mode: 'distill',
        teacherId: 'teacher',
        distillTeacherShare: 0.8,
      },
      teacher,
    )

    expect(distilled.expectedCapability).toBeGreaterThan(
      withoutTeacherScore.expectedCapability + 10,
    )
    expect(distilled.expectedCapability).toBeGreaterThan(
      pretrain.expectedCapability + 10,
    )
    expect(distilled.expectedCapability).toBeLessThan(
      teacher.capability * 0.9,
    )
  })

  it('includes earned research headroom in the pre-run quote', () => {
    const baseline = quote(BASE_SPEC)
    const researched = forecastTrainingV3({
      spec: BASE_SPEC,
      labData: createEmptyLabData(),
      dataQuality: 1,
      trainEfficiency: 0.6,
      trainPoolPf: 24,
      researchMult: 1.12,
      overtrainCapBonus: 6,
    })

    expect(researched.expectedCapability).toBeGreaterThan(
      baseline.expectedCapability + 4,
    )
  })
})

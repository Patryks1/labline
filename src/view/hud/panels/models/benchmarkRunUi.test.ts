import { describe, expect, it } from 'vitest'
import type { TrainingJob } from '../../../../sim/types'
import {
  BENCHMARK_MAX_SPEND,
  BENCHMARK_MIN_SPEND,
  benchmarkRunTotalCost,
  eligibleBenchmarkSuitesForTraining,
  estimatedBenchmarkAccuracy,
} from './benchmarkRunUi'

function job(
  patch: Pick<TrainingJob, 'family' | 'productPreset' | 'io'>,
): Pick<TrainingJob, 'family' | 'productPreset' | 'io'> {
  return patch
}

describe('benchmark run UI policy', () => {
  it('does not offer language evaluations to image-only models', () => {
    expect(eligibleBenchmarkSuitesForTraining(job({
      family: 'diffusion',
      productPreset: 'image_generation',
      io: { inputs: { text: 60 }, outputs: { image: 60 }, tools: 0 },
    }))).toEqual(['image_generation'])
  })

  it('offers every produced modality plus integration to omni models', () => {
    expect(eligibleBenchmarkSuitesForTraining(job({
      family: 'omni',
      productPreset: 'omni',
      io: {
        inputs: { text: 70, image: 60, video: 50, audio: 55 },
        outputs: { text: 70, image: 55, video: 45, audio: 50 },
        tools: 60,
      },
    }))).toEqual([
      'omni_overview',
      'language',
      'image_generation',
      'video_generation',
      'audio_generation',
    ])
  })

  it('charges each selected suite and makes higher spend more accurate', () => {
    expect(benchmarkRunTotalCost(3, 100_000)).toBe(300_000)
    expect(estimatedBenchmarkAccuracy(BENCHMARK_MIN_SPEND)).toBeCloseTo(0.65)
    expect(estimatedBenchmarkAccuracy(BENCHMARK_MAX_SPEND)).toBeCloseTo(0.9)
  })
})

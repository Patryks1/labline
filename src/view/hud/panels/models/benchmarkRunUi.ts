import type { BenchmarkSuiteId, TrainingJob } from '../../../../sim/types'
import {
  TRAINING_BENCHMARK_MAX_SPEND,
  TRAINING_BENCHMARK_MIN_SPEND,
  eligibleTrainingBenchmarkSuites,
  trainingBenchmarkAccuracyForSpend,
} from '../../../../sim/systems/training'

export const BENCHMARK_MIN_SPEND = TRAINING_BENCHMARK_MIN_SPEND
export const BENCHMARK_MAX_SPEND = TRAINING_BENCHMARK_MAX_SPEND
export const BENCHMARK_SPEND_STEP = 10_000

export const BENCHMARK_SUITE_UI: Record<
  BenchmarkSuiteId,
  { label: string; short: string; description: string }
> = {
  language: {
    label: 'Language & reasoning',
    short: 'Language',
    description: 'Knowledge, code, math, science, agents, safety and multilingual capability.',
  },
  image_generation: {
    label: 'Image generation',
    short: 'Image',
    description: 'Prompt alignment, aesthetics, typography, consistency, editing and safety.',
  },
  video_generation: {
    label: 'Video generation',
    short: 'Video',
    description: 'Visual quality, temporal coherence, motion physics, control and safety.',
  },
  audio_generation: {
    label: 'Audio generation',
    short: 'Audio',
    description: 'Intelligibility, naturalness, consistency, music, realtime performance and safety.',
  },
  omni_overview: {
    label: 'Omni integration',
    short: 'Omni',
    description: 'Cross-modal language, reasoning, tool use, media generation and safety integration.',
  },
}

/** Only offer suites that match outputs the checkpoint can actually produce. */
export function eligibleBenchmarkSuitesForTraining(
  job: Pick<TrainingJob, 'family' | 'productPreset' | 'io'>,
): BenchmarkSuiteId[] {
  return eligibleTrainingBenchmarkSuites(job).map((option) => option.id)
}

export function clampBenchmarkSpend(spend: number): number {
  const finite = Number.isFinite(spend) ? spend : BENCHMARK_MIN_SPEND
  return Math.max(BENCHMARK_MIN_SPEND, Math.min(BENCHMARK_MAX_SPEND, finite))
}

/**
 * UI planning estimate. The simulator resolves the final noisy measurement;
 * this communicates how extra sampling and adjudication narrow uncertainty.
 */
export function estimatedBenchmarkAccuracy(spendPerSuite: number): number {
  return trainingBenchmarkAccuracyForSpend(clampBenchmarkSpend(spendPerSuite)).accuracy
}

export function benchmarkRunTotalCost(suiteCount: number, spendPerSuite: number): number {
  return Math.max(0, Math.floor(suiteCount)) * clampBenchmarkSpend(spendPerSuite)
}

export function benchmarkSuiteListLabel(suiteIds: readonly BenchmarkSuiteId[]): string {
  if (!suiteIds.length) return 'No suites'
  return suiteIds.map((id) => BENCHMARK_SUITE_UI[id].short).join(' · ')
}

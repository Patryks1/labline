import type { BenchmarkId, BenchmarkScores, Model, ModelBackbone, ModelFamily, QualityAxes } from '../types'
import {
  postTrainStrength,
  scaleIntelligence,
  scoresFromScale,
  type ScaleInputs,
} from './modelScaling'

export interface BenchmarkDef {
  id: BenchmarkId
  name: string
  short: string
  description: string
}

export const BENCHMARK_DEFS: BenchmarkDef[] = [
  {
    id: 'mmlu',
    name: 'General knowledge',
    short: 'MMLU',
    description: 'Broad academic and world knowledge.',
  },
  {
    id: 'coding',
    name: 'Coding',
    short: 'Code',
    description: 'HumanEval / SWE-bench style software tasks.',
  },
  {
    id: 'math',
    name: 'Math & reasoning',
    short: 'Math',
    description: 'Competition math and multi-step reasoning.',
  },
  {
    id: 'vision',
    name: 'Vision',
    short: 'Vision',
    description: 'Image understanding and visual Q&A.',
  },
  {
    id: 'law',
    name: 'Legal',
    short: 'Law',
    description: 'Contracts, statutes, professional legal reasoning.',
  },
  {
    id: 'health',
    name: 'Health',
    short: 'Health',
    description: 'Clinical knowledge and medical QA (high bar).',
  },
  {
    id: 'science',
    name: 'Science',
    short: 'Sci',
    description: 'STEM papers, lab protocols, scientific literacy.',
  },
  {
    id: 'multilingual',
    name: 'Multilingual',
    short: 'Multi',
    description: 'Non-English fluency and translation quality.',
  },
  {
    id: 'agents',
    name: 'Agents & tools',
    short: 'Agents',
    description: 'Tool use, browser/computer control, multi-step agents.',
  },
  {
    id: 'safety',
    name: 'Safety evals',
    short: 'Safe',
    description: 'Refusal quality, jailbreak resistance, harmlessness.',
  },
  {
    id: 'personality',
    name: 'Personality',
    short: 'Voice',
    description: 'Steerability, warmth, and how pleasant the assistant is to use.',
  },
]

export function emptyBenchmarks(): BenchmarkScores {
  return {
    mmlu: 0,
    coding: 0,
    math: 0,
    vision: 0,
    law: 0,
    health: 0,
    science: 0,
    multilingual: 0,
    agents: 0,
    safety: 0,
    personality: 0,
  }
}

export interface ComputeBenchmarksOpts {
  capability: number
  quality: QualityAxes
  family: ModelFamily
  unlocked: string[]
  postTrain: string
  dataQuality: number
  /** Preferred: full scale path (params × data × mix) */
  paramsB?: number
  activeParamsB?: number
  backbone?: ModelBackbone
  dataCoverage?: number
  mixWeights?: Partial<Record<string, number>>
  researchMult?: number
  trainComplete?: number
  extras?: Partial<Record<BenchmarkId, number>>
}

/**
 * Benchmark scores — shared formula for player + rivals.
 * Prefer passing paramsB + dataCoverage; capability-only path estimates size from capability.
 */
export function computeBenchmarks(opts: ComputeBenchmarksOpts): BenchmarkScores {
  const {
    quality,
    family,
    unlocked,
    postTrain,
    dataQuality,
    paramsB,
    activeParamsB,
    backbone,
    dataCoverage = 1,
    mixWeights,
    researchMult = 1,
    trainComplete = 1,
    extras = {},
  } = opts

  let scaleParams = paramsB
  if (scaleParams == null || scaleParams <= 0) {
    // Legacy path: invert rough capability→size for rivals that only pass capability
    // capability ≈ 9 + 85 * pot * 0.9 → pot ≈ (cap-9)/76
    const pot = Math.max(0.05, Math.min(0.9, (opts.capability - 9) / 76))
    // invert sigmoid-ish: pot = 1/(1+exp(-(u-4.5)/1.05)) → u = 4.5 - 1.05*ln(1/pot - 1)
    const inv = 1 / Math.max(0.05, pot) - 1
    const u = 4.5 - 1.05 * Math.log(Math.max(1e-6, inv))
    scaleParams = Math.pow(10, u) / 1000 // millions → billions
    scaleParams = Math.max(0.01, Math.min(2000, scaleParams))
  }

  const scaleIn: ScaleInputs = {
    paramsB: scaleParams,
    activeParamsB,
    family,
    backbone,
    dataCoverage,
    dataQuality: Math.max(0.3, Math.min(1.4, 0.4 + dataQuality * 0.45)),
    mixWeights,
    researchMult,
    trainComplete,
    postTrainStrength: postTrainStrength(postTrain),
  }
  const scale = scaleIntelligence(scaleIn)

  return scoresFromScale({
    scale,
    quality,
    family,
    unlocked,
    postTrain,
    extras,
  })
}

/** Weighted score for a market segment using benchmark mix. */
export function segmentBenchmarkFit(
  b: BenchmarkScores,
  weights: Partial<Record<BenchmarkId, number>>,
): number {
  let sum = 0
  let wsum = 0
  for (const [k, w] of Object.entries(weights) as [BenchmarkId, number][]) {
    sum += (b[k] ?? 0) * w
    wsum += w
  }
  return wsum > 0 ? sum / wsum : b.mmlu
}

export function leaderboardRow(model: Model): { id: BenchmarkId; score: number }[] {
  return BENCHMARK_DEFS.map((d) => ({ id: d.id, score: model.benchmarks[d.id] }))
}

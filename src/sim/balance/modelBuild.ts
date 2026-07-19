/**
 * Shared model construction from the scale formula.
 * Player finalize + rival training both call this so capability/data hits match.
 */
import type {
  BenchmarkScores,
  Model,
  ModelFamily,
  Modality,
  PostTrainStage,
  QualityAxes,
} from '../types'
import {
  postTrainStrength,
  scaleIntelligence,
  scoresFromScale,
  type ScaleInputs,
} from './modelScaling'
import { lqSynthCapabilityMult } from './data'
import { suggestApiInOut } from './pricing'
import {
  backboneFromFamily,
  ioForPreset,
  presetFromFamily,
  rollTrainingOutcome,
  serviceProfileForModel,
} from './trainingV3'

export interface BuildScaledModelOpts {
  id: string
  name: string
  paramsB: number
  activeParamsB?: number
  family: ModelFamily
  modalities?: Modality[]
  day: number
  /** 0–2+ coverage vs recommended volume */
  dataCoverage: number
  /**
   * Quality: pass 0–1.4 normalized (lab ~1.0) OR 0–100 job quality.
   * Values &gt; 3 are treated as 0–100 scale.
   */
  dataQuality: number
  researchUnlocked?: string[]
  researchMult?: number
  postTrain?: PostTrainStage
  trainComplete?: number
  mixWeights?: Partial<Record<string, number>>
  /** 0–1 fraction of train tokens that were low-quality synth */
  synthLqShare?: number
  shipped?: boolean
  release?: 'internal' | 'released'
  tokPerSecMult?: number
  inferCostMult?: number
  outcomeSeed?: number
  engineers?: number
  effectiveDataRatio?: number
  repeatedDataEpochs?: number
  openWeights?: boolean
}

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n))
}

function normalizeQuality(q: number): number {
  if (q > 3) return Math.max(0.25, Math.min(1.4, q / 70))
  return Math.max(0.25, Math.min(1.4, q))
}

/**
 * Build a Model using the same scaleIntelligence path as player training.
 * Under-data and LQ synth both reduce capability (risk training).
 */
export function buildScaledModel(opts: BuildScaledModelOpts): Model {
  const family = opts.family
  const activeParamsB =
    opts.activeParamsB ?? (family === 'moe' ? Math.max(0.1, opts.paramsB * 0.08) : undefined)
  const postTrain = opts.postTrain ?? 'rlhf'
  const unlocked = opts.researchUnlocked ?? []
  const researchMult = opts.researchMult ?? 1 + unlocked.length * 0.004
  const lqShare = Math.max(0, Math.min(1, opts.synthLqShare ?? 0))
  const lqMult = lqSynthCapabilityMult(lqShare)

  const scaleIn: ScaleInputs = {
    paramsB: opts.paramsB,
    activeParamsB,
    family,
    dataCoverage: Math.max(0.05, opts.dataCoverage),
    dataQuality: normalizeQuality(opts.dataQuality) * (0.85 + 0.15 * (1 - lqShare)),
    mixWeights: opts.mixWeights ?? {
      chat: 0.4,
      code: 0.25,
      law: 0.08,
      health: 0.07,
      image: 0.1,
      audio: 0.05,
      video: 0.05,
    },
    researchMult:
      family === 'moe' && !unlocked.includes('moe_routing')
        ? researchMult * 0.55
        : researchMult,
    trainComplete: opts.trainComplete ?? 1,
    postTrainStrength: postTrainStrength(postTrain),
  }

  const scale = scaleIntelligence(scaleIn)
  // LQ synth regression applied on top of scale
  let capability = clamp(scale.capability * lqMult)

  const modalities: Modality[] = opts.modalities ?? ['text']
  const quality: QualityAxes = {
    reasoning: capability * 0.92,
    coding: capability * 0.88,
    chat: capability * 0.85,
    image: modalities.includes('image') ? capability * 0.75 : 5,
    video: modalities.includes('video') ? capability * 0.6 : 0,
    safety: Math.min(100, 45 + scale.intelligence * 40 - lqShare * 18),
    reliability: Math.min(100, 40 + scale.intelligence * 45 - lqShare * 22),
  }

  let benchmarks: BenchmarkScores = scoresFromScale({
    scale: { ...scale, capability },
    quality,
    family,
    unlocked,
    postTrain,
  })
  // Soft bench hit from LQ pollution
  if (lqShare > 0.05) {
    const bHit = 1 - lqShare * 0.18
    benchmarks = Object.fromEntries(
      Object.entries(benchmarks).map(([k, v]) => [k, clamp((v as number) * bHit)]),
    ) as BenchmarkScores
  }

  const outcome =
    opts.outcomeSeed == null
      ? undefined
      : rollTrainingOutcome({
          seed: opts.outcomeSeed,
          quality: normalizeQuality(opts.dataQuality) * 70,
          verifyShare: 0.18,
          engineers: opts.engineers ?? 0,
          researchCount: unlocked.length,
          day: opts.day,
        })
  if (outcome) {
    capability = clamp(capability + outcome.capabilityDelta)
    quality.reliability = clamp(quality.reliability + outcome.reliabilityDelta)
    for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      benchmarks[key] = clamp(benchmarks[key] + outcome.capabilityDelta * 0.45)
    }
  }

  const moe = family === 'moe'
  const inferCostMult = opts.inferCostMult ?? (moe ? 0.75 : 1)
  // Each model gets its own in/out list from size/family/capability costs
  const apiSug = suggestApiInOut({
    costPerMTokBase: 0.28,
    paramsB: opts.paramsB,
    activeParamsB,
    family,
    inferCostMult,
    capability,
    markupPct: 120,
  })
  const preset = presetFromFamily(family)
  const serviceProfile = serviceProfileForModel({
    paramsB: opts.paramsB,
    activeParamsB,
    family,
    tokPerSecMult: opts.tokPerSecMult ?? (moe ? 0.9 : 0.7),
    capability,
  })

  return {
    id: opts.id,
    name: opts.name,
    family,
    paramsB: opts.paramsB,
    activeParamsB,
    backbone: backboneFromFamily(family),
    productPreset: preset,
    io: ioForPreset(preset, capability),
    capability,
    modalities,
    quality,
    benchmarks,
    postTrain,
    trainComputeSpent: 20 * (opts.trainComplete ?? 1),
    releaseDay: opts.day,
    shipped: opts.shipped ?? true,
    release: opts.release ?? 'released',
    tokPerSecMult: opts.tokPerSecMult ?? (moe ? 0.9 : 0.7),
    inferCostMult,
    serviceProfile,
    apiPricePerMTok: apiSug.blendedPrice,
    apiPriceInPerMTok: apiSug.priceIn,
    apiPriceOutPerMTok: apiSug.priceOut,
    suggestedApiPrice: apiSug.blendedPrice,
    suggestedApiPriceIn: apiSug.priceIn,
    suggestedApiPriceOut: apiSug.priceOut,
    costApiPriceIn: apiSug.costIn,
    costApiPriceOut: apiSug.costOut,
    distilled: false,
    trainMode: 'pretrain',
    dataTokensUsedMTok: opts.dataCoverage * opts.paramsB * 1000,
    dataQualityUsed: normalizeQuality(opts.dataQuality) * 70,
    dataCoverage: opts.dataCoverage,
    effectiveDataRatio: opts.effectiveDataRatio ?? opts.dataCoverage,
    repeatedDataEpochs: opts.repeatedDataEpochs ?? 1,
    outcome,
    openWeights: opts.openWeights ?? false,
  }
}

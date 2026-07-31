import type {
  DataDomain,
  LabData,
  Model,
  ModelBackbone,
  ModelFamily,
  ModelIO,
  ModelProductPreset,
  ServiceProfile,
  TrainingDataPlan,
  TrainingForecast,
  TrainingOutcome,
  TrainingOutcomeKind,
  TrainingSpec,
} from '../types'
import { createRng } from '../rng'
import { normalizeWeights, totalProcessed } from './data'
import { scaleIntelligence } from './modelScaling'
import {
  estimateTrainingEconomics,
  modalityComputeMultiplier,
} from './training'
import { modelStackModifiers } from './modelStack'

const DOMAIN_COUNT = 9

export interface TrainingDataAnalysis {
  uniqueMTok: number
  repeatedMTok: number
  repeatedEpochs: number
  qualityWeight: number
  diversity: number
  effectiveMTok: number
  effectiveDataRatio: number
  modalityComputeMult: number
  risk: 'low' | 'medium' | 'high'
  warnings: string[]
}

export function familyFromSpec(
  backbone: ModelBackbone,
  preset: ModelProductPreset,
): ModelFamily {
  if (preset === 'omni') return 'omni'
  if (preset === 'video_generation') return 'video'
  if (preset === 'image_generation') return 'diffusion'
  return backbone === 'moe' ? 'moe' : backbone === 'diffusion' ? 'diffusion' : 'dense'
}

export function backboneFromFamily(family: ModelFamily): ModelBackbone {
  if (family === 'moe') return 'moe'
  if (family === 'diffusion' || family === 'video') return 'diffusion'
  return 'dense'
}

export function presetFromFamily(family: ModelFamily): ModelProductPreset {
  if (family === 'omni') return 'omni'
  if (family === 'video') return 'video_generation'
  if (family === 'diffusion') return 'image_generation'
  return 'language'
}

export function ioForPreset(preset: ModelProductPreset, capability = 50): ModelIO {
  const cap = Math.max(0, Math.min(100, capability))
  switch (preset) {
    case 'vision_language':
      return { inputs: { text: cap, image: cap * 0.82 }, outputs: { text: cap }, tools: cap * 0.35 }
    case 'audio':
      return { inputs: { text: cap, audio: cap * 0.82 }, outputs: { text: cap, audio: cap * 0.72 }, tools: cap * 0.25 }
    case 'image_generation':
      return { inputs: { text: cap, image: cap * 0.45 }, outputs: { image: cap }, tools: 0 }
    case 'video_generation':
      return { inputs: { text: cap, image: cap * 0.55, video: cap * 0.4 }, outputs: { video: cap }, tools: 0 }
    case 'omni':
      return {
        inputs: { text: cap, image: cap * 0.9, audio: cap * 0.84, video: cap * 0.78 },
        outputs: { text: cap, image: cap * 0.74, audio: cap * 0.7, video: cap * 0.62 },
        tools: cap * 0.7,
      }
    default:
      return { inputs: { text: cap }, outputs: { text: cap }, tools: cap * 0.35 }
  }
}

function qualityWeight(quality: number): number {
  const q = Math.max(0, Math.min(100, quality))
  if (q <= 35) return 0.35
  if (q <= 55) return 0.35 + ((q - 35) / 20) * 0.3
  if (q <= 75) return 0.65 + ((q - 55) / 20) * 0.2
  return Math.min(1, 0.85 + ((q - 75) / 20) * 0.15)
}

function mixDiversity(weights: Record<DataDomain, number>): number {
  let entropy = 0
  for (const value of Object.values(weights)) {
    if (value > 1e-9) entropy -= value * Math.log(value)
  }
  const normalized = Math.max(0, Math.min(1, entropy / Math.log(DOMAIN_COUNT)))
  return 0.65 + normalized * 0.35
}

export function analyzeTrainingData(opts: {
  paramsB: number
  family: ModelFamily
  backbone?: ModelBackbone
  productPreset?: ModelProductPreset
  io?: ModelIO
  plan: TrainingDataPlan
  data?: LabData
  actualMTok?: number
  quality: number
  lqShare?: number
}): TrainingDataAnalysis {
  const weights = normalizeWeights(opts.plan.weights)
  const requested = Math.max(0, opts.actualMTok ?? opts.plan.totalMTok ?? opts.plan.totalUnits ?? 0)
  const available = opts.data ? totalProcessed(opts.data) : requested
  const uniqueMTok = Math.max(
    0,
    Math.min(requested, opts.plan.uniqueMTok ?? Math.min(requested, available)),
  )
  const repeatedMTok = Math.max(
    opts.plan.repeatedMTok ?? 0,
    requested - uniqueMTok,
  )
  const repeatedEpochs = uniqueMTok > 0 ? requested / uniqueMTok : requested > 0 ? 99 : 0
  const repeatUseful =
    repeatedMTok <= 0
      ? 0
      : Math.min(repeatedMTok, uniqueMTok * 3) * 0.5 +
        Math.max(0, repeatedMTok - uniqueMTok * 3) * 0.1
  const qWeight = qualityWeight(opts.quality)
  const diversity = mixDiversity(weights)
  const lqPenalty = 1 - Math.max(0, Math.min(1, opts.lqShare ?? 0)) * 0.65
  const effectiveMTok = (uniqueMTok + repeatUseful) * qWeight * diversity * lqPenalty
  const effectiveDataRatio = effectiveMTok / Math.max(1, opts.paramsB * 1000)
  const modalityComputeMult = modalityComputeMultiplier(weights)
  const warnings: string[] = []
  const isOmni = opts.family === 'omni' || opts.productPreset === 'omni'
  const minRatio = isOmni ? 10 : 1
  const strongRatio = isOmni ? 10 : 6
  if (effectiveDataRatio < minRatio) {
    warnings.push(
      isOmni
        ? 'Omni needs at least 10 quality-weighted tokens per parameter.'
        : 'Below the 1:1 viability floor; the model will be critically undertrained.',
    )
  } else if (effectiveDataRatio < strongRatio) {
    warnings.push('Viable but below the strong data target.')
  }
  if (repeatedEpochs > 8) warnings.push('More than eight corpus epochs creates severe memorization risk.')
  else if (repeatedEpochs > 4) warnings.push('Repeated data is past four useful epochs and has sharply diminishing value.')
  if ((opts.lqShare ?? 0) > 0.25) warnings.push('Low-quality synthetic data exceeds 25% of the train mix.')
  if ((opts.plan.trainShare ?? 0.82) > 0.9) warnings.push('Verification is below 10%; reliability and contamination risk rise.')
  if (diversity < 0.78) warnings.push('Narrow domain mix will reduce general capability.')
  const io = opts.io ?? ioForPreset(opts.productPreset ?? presetFromFamily(opts.family))
  for (const modality of ['image', 'audio', 'video'] as const) {
    const enabled = (io.inputs[modality] ?? 0) > 0 || (io.outputs[modality] ?? 0) > 0
    if (enabled && (weights[modality] ?? 0) < (isOmni ? 0.08 : 0.1)) {
      warnings.push(
        `${modality[0]!.toUpperCase()}${modality.slice(1)} I/O lacks enough matching ${modality} data.`,
      )
    }
  }
  const highRisk =
    effectiveDataRatio < minRatio * 0.6 || repeatedEpochs > 8 || (opts.lqShare ?? 0) > 0.4
  const mediumRisk = warnings.length > 0
  return {
    uniqueMTok,
    repeatedMTok,
    repeatedEpochs,
    qualityWeight: qWeight,
    diversity,
    effectiveMTok,
    effectiveDataRatio,
    modalityComputeMult,
    risk: highRisk ? 'high' : mediumRisk ? 'medium' : 'low',
    warnings,
  }
}

export function serviceProfileForModel(
  model: Pick<Model, 'paramsB' | 'activeParamsB' | 'family' | 'tokPerSecMult' | 'capability'> &
    Partial<Pick<Model, 'backbone'>>,
): ServiceProfile {
  const active =
    model.family === 'moe' || model.backbone === 'moe'
      ? Math.max(0.1, (model.activeParamsB ?? model.paramsB * 0.1) * 1.15)
      : Math.max(0.1, model.paramsB)
  const baseTps = 128 * Math.pow(7 / active, 0.34) * Math.max(0.2, model.tokPerSecMult)
  return {
    interactiveTokPerSec: Math.max(2, Math.min(420, baseTps)),
    timeToFirstTokenMs: Math.max(90, Math.min(6000, 180 + active * 12)),
    imageSeconds: model.family === 'diffusion' || model.family === 'omni' ? Math.max(1.2, active * 0.08) : null,
    audioRealtimeFactor: model.family === 'omni' ? Math.max(0.4, active / 80) : null,
    videoSecondsPerSecond:
      model.family === 'video' || model.family === 'omni' ? Math.max(2, active * 0.35) : null,
  }
}

export function rollTrainingOutcome(opts: {
  seed: number
  quality: number
  verifyShare: number
  engineers: number
  researchCount: number
  day: number
  /** Research can deliberately push more probability into the high-upside tail. */
  breakthroughBias?: number
  /** Risky methods can also widen the downside tail. */
  stumbleRisk?: number
}): TrainingOutcome {
  const rng = createRng(opts.seed)
  const competence = Math.max(
    -0.1,
    Math.min(0.1, (opts.quality - 60) / 400 + opts.verifyShare * 0.08 + opts.engineers * 0.004 + opts.researchCount * 0.001),
  )
  const stumbleP = Math.min(
    0.42,
    Math.max(0.1, 0.2 - competence + Math.max(0, opts.stumbleRisk ?? 0)),
  )
  const breakthroughP = Math.min(
    0.38,
    Math.max(0.04, 0.1 + competence * 0.55 + Math.max(0, opts.breakthroughBias ?? 0)),
  )
  const roll = rng.next()
  let kind: TrainingOutcomeKind
  let yieldMultiplier: number
  if (roll < stumbleP) {
    kind = 'stumble'
    yieldMultiplier = rng.range(0.84, 0.96)
  } else if (roll > 1 - breakthroughP) {
    kind = 'breakthrough'
    yieldMultiplier = rng.range(1.04, 1.12)
  } else {
    kind = 'normal'
    yieldMultiplier = rng.range(0.96, 1.04)
  }
  const capabilityDelta = (yieldMultiplier - 1) * 18
  const reliabilityDelta = kind === 'stumble' ? -rng.range(2, 8) : kind === 'breakthrough' ? rng.range(1, 5) : rng.range(-1, 2)
  return {
    kind,
    yieldMultiplier,
    capabilityDelta,
    reliabilityDelta,
    revealedDay: opts.day,
    explanation:
      kind === 'stumble'
        ? 'Optimization instability and weak generalization reduced the usable yield.'
        : kind === 'breakthrough'
          ? 'A stable run and unusually strong representation learning beat the baseline forecast.'
          : 'The run landed close to the lab forecast.',
  }
}

export function forecastTrainingV3(opts: {
  spec: TrainingSpec
  labData: LabData
  dataQuality: number
  trainEfficiency: number
  trainPoolPf: number
  trainPowerMw?: number
  teacherParamsB?: number
}): TrainingForecast {
  const family = familyFromSpec(opts.spec.backbone, opts.spec.productPreset)
  const stack = modelStackModifiers(opts.spec.modelStack ?? [], family)
  const requested = opts.spec.dataPlan.totalMTok ?? opts.spec.dataPlan.totalUnits
  const actualMTok = opts.spec.dataPlan.allowSynthetic
    ? requested
    : Math.min(requested, totalProcessed(opts.labData))
  const analysis = analyzeTrainingData({
    paramsB: opts.spec.paramsB,
    family,
    backbone: opts.spec.backbone,
    productPreset: opts.spec.productPreset,
    io: opts.spec.io,
    plan: opts.spec.dataPlan,
    data: opts.labData,
    actualMTok,
    quality: opts.dataQuality * 70,
  })
  const trainShare = Math.max(0, Math.min(1, opts.spec.dataPlan.trainShare ?? 0.82))
  const economics = estimateTrainingEconomics({
    paramsB: opts.spec.paramsB,
    activeParamsB: opts.spec.activeParamsB,
    family,
    backbone: opts.spec.backbone,
    trainEfficiency: opts.trainEfficiency,
    mode: opts.spec.mode,
    teacherParamsB: opts.teacherParamsB,
    distillTeacherShare: opts.spec.distillTeacherShare,
    trainingTokensMTok: actualMTok * trainShare,
    verificationTokensMTok: actualMTok * (1 - trainShare),
    modalityComputeMult: analysis.modalityComputeMult,
    trainCostMult: stack.trainCostMult,
    dataCost: actualMTok * 0.35,
  })
  const targetPfDays = economics.targetPfDays
  const scale = scaleIntelligence({
    paramsB: opts.spec.paramsB,
    activeParamsB: opts.spec.activeParamsB,
    family,
    backbone: opts.spec.backbone,
    dataCoverage: analysis.effectiveDataRatio,
    dataQuality: analysis.qualityWeight,
    mixWeights: opts.spec.dataPlan.weights,
  })
  const modelLike = {
    paramsB: opts.spec.paramsB,
    activeParamsB: opts.spec.activeParamsB,
    family,
    backbone: opts.spec.backbone,
    tokPerSecMult: family === 'moe' ? 0.85 : family === 'omni' ? 0.35 : 0.75,
    capability: scale.capability + stack.capabilityBonus,
  }
  return {
    targetPfDays,
    powerMw: Math.max(0, opts.trainPowerMw ?? 0),
    etaDays:
      opts.trainPoolPf > 0.001
        ? Math.max(economics.minCalendarDays, Math.ceil(targetPfDays / opts.trainPoolPf))
        : Number.POSITIVE_INFINITY,
    minCalendarDays: economics.minCalendarDays,
    upfrontCash: economics.upfrontCash,
    cashBurnPerDay: economics.cashBurnPerDay,
    weightedMTok: analysis.effectiveMTok,
    effectiveDataRatio: analysis.effectiveDataRatio,
    repeatedDataEpochs: analysis.repeatedEpochs,
    modalityComputeMult: analysis.modalityComputeMult,
    expectedCapability: scale.capability + stack.capabilityBonus,
    interactiveTokPerSec:
      serviceProfileForModel(modelLike).interactiveTokPerSec * stack.speedMult,
    risk: analysis.risk,
    warnings: analysis.warnings,
  }
}

/** Stable public name; V3 suffix remains as a compatibility export. */
export const forecastTraining = forecastTrainingV3

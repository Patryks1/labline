import type {
  DataDomain,
  DataManifest,
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
import {
  normalizeWeights,
  recommendedTrainingDataMTok,
  totalProcessed,
  trainingDataParameterBasisB,
} from './data'
import {
  scaleIntelligence,
  bentCapabilityCeiling,
  moeRoutingCapacityMultiplier,
} from './modelScaling'
import {
  DEFAULT_RECIPE_ALIGN_SHARE,
  recipeOutcomeSignals,
  type RecipeOutcomeSignals,
} from './trainingRecipe'
import {
  blendDistilledCapability,
  estimateTrainingEconomics,
  modalityComputeMultiplier,
} from './training'
import { modelStackModifiers } from './modelStack'
import {
  DEFAULT_INPUT_SHARE,
  estimateServingWorkload,
  precisionComputeMult,
} from './tokenServe'
import {
  DEFAULT_TRAINING_NUMERICS,
  nativeWeightPrecisionForNumerics,
  trainingFormatThroughput,
} from './trainingPrecision'
import { repeatEpochMultiplier } from './effectiveData'

const DOMAIN_COUNT = 9

export interface TrainingDataAnalysis {
  uniqueMTok: number
  repeatedMTok: number
  repeatedEpochs: number
  qualityWeight: number
  diversity: number
  effectiveMTok: number
  effectiveDataRatio: number
  rawStrongTargetMTok: number
  rawStrongTargetMet: boolean
  qualityRetention: number
  diversityRetention: number
  holdoutRetention: number
  lowQualityRetention: number
  provenanceRetention: number
  modalityComputeMult: number
  recipe: RecipeOutcomeSignals
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

/** Minimum share of the corpus actually attributed to a native media product. */
export function trainingDataModalityRequirements(
  family: ModelFamily,
  productPreset: ModelProductPreset,
): Partial<Record<DataDomain, number>> {
  // Omni is a joint text+media product. It does not inherit the native
  // image/video/audio floors that dedicated media models need to be valid.
  if (productPreset === 'omni' || family === 'omni') return {}
  if (productPreset === 'video_generation' || family === 'video') {
    return { video: 0.2 }
  }
  if (productPreset === 'image_generation' || family === 'diffusion') {
    return { image: 0.15 }
  }
  if (productPreset === 'audio') return { audio: 0.1 }
  return {}
}

/**
 * Legacy mapping for the removed vision-language preset. Old saves/jobs keep
 * the stored union member; new work routes it to omni when the stored I/O
 * goes beyond image-in/text-out, otherwise to a language product that keeps
 * its image input. Documented for the save-integration pass.
 */
export function migrateLegacyProductPreset(
  preset: ModelProductPreset,
  io?: ModelIO,
): ModelProductPreset {
  if (preset !== 'vision_language') return preset
  const inputs = io?.inputs ?? {}
  const outputs = io?.outputs ?? {}
  const beyondImageInTextOut =
    (inputs.audio ?? 0) > 0 ||
    (inputs.video ?? 0) > 0 ||
    (outputs.image ?? 0) > 0 ||
    (outputs.audio ?? 0) > 0 ||
    (outputs.video ?? 0) > 0
  return beyondImageInTextOut ? 'omni' : 'language'
}

export function ioForPreset(preset: ModelProductPreset, capability = 50): ModelIO {
  const cap = Math.max(0, Math.min(100, capability))
  switch (preset) {
    // Legacy preset, removed from selection — kept so old saves still render I/O.
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

function compactTokenVolume(mTok: number): string {
  if (mTok >= 1000) {
    const billions = mTok / 1000
    return `${billions >= 100 ? billions.toFixed(0) : billions.toFixed(2)}B tokens`
  }
  return `${Math.round(mTok)}M tokens`
}

export function analyzeTrainingData(opts: {
  paramsB: number
  activeParamsB?: number
  family: ModelFamily
  backbone?: ModelBackbone
  productPreset?: ModelProductPreset
  io?: ModelIO
  plan: TrainingDataPlan
  data?: LabData
  actualMTok?: number
  quality: number
  lqShare?: number
  /** Exact attributed corpus snapshot. Omit for legacy/preflight estimates. */
  manifest?: DataManifest
}): TrainingDataAnalysis {
  const weights = normalizeWeights(opts.manifest?.domainWeights ?? opts.plan.weights)
  const requested = Math.max(0, opts.actualMTok ?? opts.plan.totalMTok ?? opts.plan.totalUnits ?? 0)
  const available = opts.data ? totalProcessed(opts.data) : requested
  const uniqueMTok = Math.max(
    0,
    Math.min(
      requested,
      opts.manifest?.uniqueMTok ??
        opts.plan.uniqueMTok ??
        Math.min(requested, available),
    ),
  )
  const repeatedMTok = Math.max(
    opts.manifest?.repeatedMTok ?? opts.plan.repeatedMTok ?? 0,
    requested - uniqueMTok,
  )
  const repeatedEpochs = uniqueMTok > 0 ? requested / uniqueMTok : requested > 0 ? 99 : 0
  const manifestQuality = opts.manifest?.effectiveQuality
  const normalizedManifestQuality =
    manifestQuality == null
      ? opts.quality
      : manifestQuality <= 1
        ? manifestQuality * 100
        : manifestQuality
  const qWeight = qualityWeight(normalizedManifestQuality)
  const diversity = mixDiversity(weights)
  const lqPenalty = 1 - Math.max(0, Math.min(1, opts.lqShare ?? 0)) * 0.65
  const manifestValue = opts.manifest?.effectiveTrainingValue
  const provenanceMultiplier =
    manifestValue == null
      ? 1
      : Math.max(0, Math.min(1.05, manifestValue / Math.max(0.01, qWeight)))
  const effectiveMTok =
    uniqueMTok *
    repeatEpochMultiplier(Math.max(1, repeatedEpochs)) *
    qWeight *
    diversity *
    lqPenalty *
    provenanceMultiplier
  const trainShare = Math.max(0.4, Math.min(0.95, opts.plan.trainShare ?? 0.82))
  const dataParameterBasisB = trainingDataParameterBasisB({
    paramsB: opts.paramsB,
    activeParamsB: opts.activeParamsB,
    family: opts.family,
    backbone: opts.backbone,
  })
  const effectiveDataRatio =
    (effectiveMTok * trainShare) / Math.max(1, dataParameterBasisB * 1000)
  const modalityComputeMult = modalityComputeMultiplier(weights)
  const warnings: string[] = []
  const isOmni = opts.family === 'omni' || opts.productPreset === 'omni'
  const minRatio = isOmni ? 10 : 1
  const strongRatio = isOmni ? 10 : 6
  const rawStrongTargetMTok = recommendedTrainingDataMTok({
    paramsB: opts.paramsB,
    activeParamsB: opts.activeParamsB,
    family: opts.family,
    backbone: opts.backbone,
    trainShare,
  })
  const rawStrongTargetMet = requested + 1e-9 >= rawStrongTargetMTok
  if (effectiveDataRatio < minRatio) {
    warnings.push(
      isOmni
        ? 'Omni needs at least 10 quality-weighted tokens per parameter.'
        : opts.backbone === 'moe' || opts.family === 'moe'
          ? 'Below the 1:1 viability floor for routed MoE capacity; the model will be critically undertrained.'
          : 'Below the 1:1 viability floor; the model will be critically undertrained.',
    )
  } else if (effectiveDataRatio < strongRatio) {
    const rawStatus = rawStrongTargetMet
      ? `Raw volume meets the ${compactTokenVolume(rawStrongTargetMTok)} strong target`
      : `Raw volume is ${compactTokenVolume(requested)} / ${compactTokenVolume(rawStrongTargetMTok)} strong target`
    warnings.push(
      `${rawStatus}, but effective training signal is ${effectiveDataRatio.toFixed(2)}:1 after quality ×${qWeight.toFixed(2)}, diversity ×${diversity.toFixed(2)}, and ${Math.round((1 - trainShare) * 100)}% verification holdout (×${trainShare.toFixed(2)}).`,
    )
  }
  if (
    opts.backbone === 'moe' &&
    opts.activeParamsB != null &&
    opts.activeParamsB / Math.max(0.001, opts.paramsB) < 0.02
  ) {
    const activePct = (opts.activeParamsB / Math.max(0.001, opts.paramsB)) * 100
    const routingMultiplier = moeRoutingCapacityMultiplier(
      opts.paramsB,
      opts.activeParamsB,
    )
    warnings.push(
      `Extreme sparsity activates ${activePct.toFixed(2)}% of weights per token; routed capability is limited to ×${routingMultiplier.toFixed(2)} until the active path reaches 2%.`,
    )
  }
  if (repeatedEpochs > 8) warnings.push('More than eight corpus epochs creates severe memorization risk.')
  else if (repeatedEpochs > 4) warnings.push('Repeated data is past four useful epochs and has sharply diminishing value.')
  if ((opts.lqShare ?? 0) > 0.25) warnings.push('Low-quality synthetic data exceeds 25% of the train mix.')
  if ((opts.plan.trainShare ?? 0.82) > 0.9) warnings.push('Verification is below 10%; reliability and contamination risk rise.')
  if (diversity < 0.78) warnings.push('Narrow domain mix will reduce general capability.')
  if ((opts.manifest?.effectiveDiversity ?? 1) < 0.48) {
    warnings.push('The selected assets are internally repetitive even where the domain mix looks broad.')
  }
  if ((opts.manifest?.effectiveFreshness ?? 1) < 0.42) {
    warnings.push('Stale corpus coverage weakens current-world and product knowledge.')
  }
  if ((opts.manifest?.contaminationRisk ?? 0) >= 0.25) {
    warnings.push('Corpus contamination may inflate evaluations and reduce out-of-sample reliability.')
  }
  const syntheticShare = opts.manifest?.syntheticShare ?? 0
  const generationDepth = opts.manifest?.syntheticGenerationDepth ?? 0
  const humanAnchorShare = opts.manifest?.humanAnchorShare ?? 1
  if (syntheticShare >= 0.3 && generationDepth >= 2.5) {
    warnings.push('Deep synthetic lineage risks amplifying teacher errors across generations.')
  }
  if (syntheticShare >= 0.2 && humanAnchorShare < 0.55) {
    warnings.push('Synthetic-heavy data lacks enough human-origin anchoring.')
  }
  if ((opts.manifest?.rightsRisk ?? 0) >= 0.3) {
    warnings.push('Dataset rights exposure may restrict commercial release or trigger an audit.')
  }
  const io = opts.io ?? ioForPreset(opts.productPreset ?? presetFromFamily(opts.family))
  for (const modality of ['image', 'audio', 'video'] as const) {
    const enabled = (io.inputs[modality] ?? 0) > 0 || (io.outputs[modality] ?? 0) > 0
    if (enabled && (weights[modality] ?? 0) < (isOmni ? 0.08 : 0.1)) {
      warnings.push(
        `${modality[0]!.toUpperCase()}${modality.slice(1)} I/O lacks enough matching ${modality} data.`,
      )
    }
  }
  const recipe = recipeOutcomeSignals({
    totalMTok: requested + Math.max(0, opts.plan.postTrainMTok ?? 0),
    paramsB: opts.paramsB,
    family: opts.family,
    backbone: opts.backbone,
    activeParamsB: opts.activeParamsB,
    postTrainShare: opts.plan.postTrainShare ?? DEFAULT_RECIPE_ALIGN_SHARE,
    trainShare,
  })
  if (recipe.postTrainShare < 0.18) {
    warnings.push(
      'Alignment is below 18% of the recipe; chat and safety will stay closer to a raw base.',
    )
  } else if (recipe.baseShare < 0.2) {
    warnings.push(
      'Base is below 20% of the recipe; general capability is starved for optimization tokens.',
    )
  }
  const highRisk =
    effectiveDataRatio < minRatio * 0.6 ||
    repeatedEpochs > 8 ||
    (opts.lqShare ?? 0) > 0.4 ||
    (opts.manifest?.contaminationRisk ?? 0) >= 0.5 ||
    (opts.manifest?.rightsRisk ?? 0) >= 0.68 ||
    (syntheticShare >= 0.5 && generationDepth >= 4 && humanAnchorShare < 0.45)
  const mediumRisk = warnings.length > 0
  return {
    uniqueMTok,
    repeatedMTok,
    repeatedEpochs,
    qualityWeight: qWeight,
    diversity,
    effectiveMTok,
    effectiveDataRatio,
    rawStrongTargetMTok,
    rawStrongTargetMet,
    qualityRetention: qWeight,
    diversityRetention: diversity,
    holdoutRetention: trainShare,
    lowQualityRetention: lqPenalty,
    provenanceRetention: provenanceMultiplier,
    modalityComputeMult,
    recipe,
    risk: highRisk ? 'high' : mediumRisk ? 'medium' : 'low',
    warnings,
  }
}

export function serviceProfileForModel(
  model: Pick<Model, 'paramsB' | 'activeParamsB' | 'family' | 'tokPerSecMult' | 'capability'> &
    Partial<
      Pick<
        Model,
        | 'backbone'
        | 'productPreset'
        | 'io'
        | 'modalities'
        | 'nativeWeightPrecision'
        | 'trainingNumerics'
      >
    >,
): ServiceProfile {
  const active =
    model.family === 'moe' || model.backbone === 'moe'
      ? Math.max(0.1, (model.activeParamsB ?? model.paramsB * 0.1) * 1.15)
      : Math.max(0.1, model.paramsB)
  const nativePrecision =
    model.nativeWeightPrecision ??
    (model.trainingNumerics
      ? nativeWeightPrecisionForNumerics(model.trainingNumerics)
      : undefined)
  const formatSpeed = 1 / Math.max(0.2, precisionComputeMult(nativePrecision))
  const baseTps =
    128 *
    Math.pow(7 / active, 0.34) *
    Math.max(0.2, model.tokPerSecMult) *
    formatSpeed
  const preset = model.productPreset ?? presetFromFamily(model.family)
  const modalityEnabled = (modality: 'image' | 'audio' | 'video'): boolean =>
    model.modalities?.includes(modality) === true ||
    (model.io?.inputs[modality] ?? 0) > 0 ||
    (model.io?.outputs[modality] ?? 0) > 0 ||
    preset === 'omni' ||
    (modality === 'image' &&
      (preset === 'image_generation' || preset === 'video_generation')) ||
    (modality === 'audio' && preset === 'audio') ||
    (modality === 'video' && preset === 'video_generation')
  return {
    interactiveTokPerSec: Math.max(2, Math.min(420, baseTps)),
    timeToFirstTokenMs: Math.max(90, Math.min(6000, 180 + active * 12)),
    imageSeconds: modalityEnabled('image') ? Math.max(1.2, active * 0.08) : null,
    audioRealtimeFactor: modalityEnabled('audio') ? Math.max(0.4, active / 80) : null,
    videoSecondsPerSecond:
      modalityEnabled('video') ? Math.max(2, active * 0.35) : null,
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
    -0.08,
    Math.min(
      0.08,
      (opts.quality - 60) / 500 +
        opts.verifyShare * 0.06 +
        opts.engineers * 0.003 +
        opts.researchCount * 0.0008,
    ),
  )
  const stumbleP = Math.min(
    0.09,
    Math.max(0.05, 0.07 - competence * 0.4 + Math.max(0, opts.stumbleRisk ?? 0) * 0.35),
  )
  const failureP = Math.min(
    0.04,
    Math.max(0.01, 0.02 + Math.max(0, opts.stumbleRisk ?? 0) * 0.12 - competence * 0.15),
  )
  const breakthroughP = Math.min(
    0.09,
    Math.max(0.05, 0.07 + competence * 0.45 + Math.max(0, opts.breakthroughBias ?? 0) * 0.28),
  )
  const roll = rng.next()
  let kind: TrainingOutcomeKind
  let yieldMultiplier: number
  if (roll < failureP) {
    kind = 'failure'
    yieldMultiplier = rng.range(0.55, 0.78)
  } else if (roll < failureP + stumbleP) {
    kind = 'stumble'
    yieldMultiplier = rng.range(0.84, 0.96)
  } else if (roll > 1 - breakthroughP) {
    kind = 'breakthrough'
    yieldMultiplier = rng.range(1.04, 1.12)
  } else {
    kind = 'normal'
    yieldMultiplier = rng.range(0.96, 1.04)
  }
  const capabilityDelta =
    kind === 'failure' ? (yieldMultiplier - 1) * 28 : (yieldMultiplier - 1) * 18
  const reliabilityDelta =
    kind === 'failure'
      ? -rng.range(8, 18)
      : kind === 'stumble'
        ? -rng.range(2, 8)
        : kind === 'breakthrough'
          ? rng.range(1, 5)
          : rng.range(-1, 2)
  return {
    kind,
    yieldMultiplier,
    capabilityDelta,
    reliabilityDelta,
    revealedDay: opts.day,
    explanation:
      kind === 'failure'
        ? 'The run collapsed: unsupported numerics, data coverage, or routing instability destroyed most of the useful yield.'
        : kind === 'stumble'
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
  /** Actual teacher score used by the shared distillation projection. */
  teacherCapability?: number
  /** Frozen research/process multiplier used by the final scale path. */
  researchMult?: number
  /** Research-earned headroom for deliberate compute-intensity. */
  overtrainCapBonus?: number
  /** Advertised BF16-equivalent generation of the active training fleet. */
  hardwareGeneration?: number
  servingEfficiency?: number
}): TrainingForecast {
  const family = familyFromSpec(opts.spec.backbone, opts.spec.productPreset)
  const stack = modelStackModifiers(opts.spec.modelStack ?? [], family)
  const requested = opts.spec.dataPlan.totalMTok ?? opts.spec.dataPlan.totalUnits
  const actualMTok = opts.spec.dataPlan.allowSynthetic
    ? requested
    : Math.min(requested, totalProcessed(opts.labData))
  const analysis = analyzeTrainingData({
    paramsB: opts.spec.paramsB,
    activeParamsB: opts.spec.activeParamsB,
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
    numerics: opts.spec.trainingNumerics,
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
    reasoningEnabled: stack.reasoningEnabled,
    researchMult: opts.researchMult,
    overtrainCapBonus: opts.overtrainCapBonus,
    teacherCapability:
      opts.spec.mode === 'distill' ? opts.teacherCapability : undefined,
    teacherParamsB:
      opts.spec.mode === 'distill' ? opts.teacherParamsB : undefined,
  })
  const precisionCeiling =
    bentCapabilityCeiling(scale.capabilityCeiling) *
    economics.precision.qualityCeilingMultiplier
  const studentExpectedCapability = Math.min(
    scale.capability + stack.capabilityBonus,
    precisionCeiling,
  )
  const expectedCapability =
    opts.spec.mode === 'distill' &&
    opts.teacherCapability != null &&
    opts.teacherParamsB != null
      ? Math.min(
          blendDistilledCapability({
            studentCapability: studentExpectedCapability,
            studentScaleCap: Math.max(
              scale.capability,
              opts.teacherCapability * 0.75,
            ),
            studentParamsB: opts.spec.paramsB,
            teacherCapability: opts.teacherCapability,
            teacherParamsB: opts.teacherParamsB,
            teacherShare: opts.spec.distillTeacherShare,
            dataFactor: analysis.qualityWeight,
            rng01: 0.5,
          }).capability,
          precisionCeiling,
        )
      : studentExpectedCapability
  const numerics = opts.spec.trainingNumerics ?? DEFAULT_TRAINING_NUMERICS
  const nativePrecision = nativeWeightPrecisionForNumerics(numerics)
  const usefulTrainPf =
    Math.max(0, opts.trainPoolPf) *
    trainingFormatThroughput(opts.hardwareGeneration ?? 1, numerics)
  const paceFloor = opts.spec.paramsB >= 1_000 ? economics.minCalendarDays : 0
  const modelLike = {
    paramsB: opts.spec.paramsB,
    activeParamsB: opts.spec.activeParamsB,
    family,
    backbone: opts.spec.backbone,
    tokPerSecMult: family === 'moe' ? 0.85 : family === 'omni' ? 0.35 : 0.75,
    capability: expectedCapability,
    trainingNumerics: numerics,
    nativeWeightPrecision: nativePrecision,
  }
  const servePfPerMTok = estimateServingWorkload({
    model: {
      paramsB: opts.spec.paramsB,
      activeParamsB: opts.spec.activeParamsB,
      family,
      inferCostMult: economics.precision.inferenceCostMultiplier,
    },
    inputMTok: DEFAULT_INPUT_SHARE,
    outputMTok: 1 - DEFAULT_INPUT_SHARE,
    precision: nativePrecision,
    servingEfficiency: opts.servingEfficiency ?? 1,
  }).effectivePfDays
  return {
    targetPfDays,
    powerMw: Math.max(0, opts.trainPowerMw ?? 0),
    usefulTrainPf,
    etaDays:
      usefulTrainPf > 0.001
        ? Math.max(paceFloor, targetPfDays / usefulTrainPf)
        : Number.POSITIVE_INFINITY,
    minCalendarDays: economics.minCalendarDays,
    upfrontCash: economics.upfrontCash,
    cashBurnPerDay: economics.cashBurnPerDay,
    weightedMTok: analysis.effectiveMTok,
    effectiveDataRatio: analysis.effectiveDataRatio,
    dataGuidance: {
      rawStrongTargetMTok: analysis.rawStrongTargetMTok,
      rawStrongTargetMet: analysis.rawStrongTargetMet,
      qualityRetention: analysis.qualityRetention,
      diversityRetention: analysis.diversityRetention,
      holdoutRetention: analysis.holdoutRetention,
      lowQualityRetention: analysis.lowQualityRetention,
      provenanceRetention: analysis.provenanceRetention,
    },
    repeatedDataEpochs: analysis.repeatedEpochs,
    modalityComputeMult: analysis.modalityComputeMult,
    expectedCapability,
    interactiveTokPerSec:
      serviceProfileForModel(modelLike).interactiveTokPerSec * stack.speedMult,
    servePfPerMTok,
    servePrecision: nativePrecision,
    risk: analysis.risk,
    warnings: analysis.warnings,
    precision: economics.precision,
  }
}

/** Stable public name; V3 suffix remains as a compatibility export. */
export const forecastTraining = forecastTrainingV3

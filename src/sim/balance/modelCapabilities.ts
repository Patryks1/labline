import type {
  CapabilityDomain,
  DataDomain,
  ModelCapabilities,
  ModelFamily,
  ModelIO,
  Model,
  PostTrainStage,
  QualityAxes,
  SyntheticProvenance,
  TrainingForecast,
  TrainingOutcome,
} from '../types'

export const CAPABILITY_DOMAINS: CapabilityDomain[] = [
  'language',
  'reasoning',
  'code',
  'math',
  'science',
  'vision',
  'video',
  'audio',
  'tools',
]

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const clampScore = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))

const DOMAIN_AFFINITY: Record<CapabilityDomain, Partial<Record<DataDomain, number>>> = {
  language: { chat: 1, law: 0.12, health: 0.12, science: 0.08, audio: 0.08 },
  reasoning: { math: 0.45, science: 0.35, code: 0.15, chat: 0.05 },
  code: { code: 1 },
  math: { math: 1 },
  science: { science: 1, math: 0.15 },
  vision: { image: 1, video: 0.15, science: 0.08 },
  video: { video: 1, image: 0.2 },
  audio: { audio: 1 },
  tools: { code: 0.55, chat: 0.2, math: 0.1, science: 0.1, law: 0.025, health: 0.025 },
}

function postTrainSignal(stage: PostTrainStage): number {
  if (stage === 'none') return 0
  if (stage === 'sft') return 0.38
  if (stage === 'rlhf') return 0.68
  if (stage === 'process') return 0.85
  return 1
}

function modalityAvailable(io: ModelIO, modality: keyof ModelIO['inputs']): boolean {
  return (io.inputs[modality] ?? 0) > 0 || (io.outputs[modality] ?? 0) > 0
}

function saturate(value: number): number {
  const normalized = clamp01(value)
  return clampScore(
    (100 * (1 - Math.exp(-1.35 * normalized))) / (1 - Math.exp(-1.35)),
  )
}

function qualityAxis(domain: CapabilityDomain, quality: QualityAxes): number {
  if (domain === 'code' || domain === 'tools') return quality.coding
  if (domain === 'reasoning' || domain === 'math' || domain === 'science') return quality.reasoning
  if (domain === 'vision') return quality.image
  if (domain === 'video') return quality.video
  if (domain === 'audio') return quality.chat * 0.7 + quality.reliability * 0.3
  return quality.chat
}

export interface ModelCapabilityInputs {
  finalCapability: number
  trainComputePfDays: number
  effectiveDataRatio: number
  dataQuality: number
  domainWeights: Partial<Record<DataDomain, number>>
  io: ModelIO
  family: ModelFamily
  postTrain: PostTrainStage
  quality: QualityAxes
}

/** Domain vector derived from scale and evidence; no research node grants raw points. */
export function deriveModelCapabilities(input: ModelCapabilityInputs): ModelCapabilities {
  const computeSignal = 1 - Math.exp(-Math.log1p(Math.max(0, input.trainComputePfDays)) / 6)
  const dataSignal = 1 - Math.exp(-Math.max(0, input.effectiveDataRatio) / 6)
  const scaleSignal = clamp01(input.finalCapability / 100)
  const dataQuality = clamp01(input.dataQuality / 100)
  const generalSignal =
    0.55 * scaleSignal + 0.2 * computeSignal + 0.25 * dataSignal * dataQuality
  const domains = {} as Record<CapabilityDomain, number>

  for (const domain of CAPABILITY_DOMAINS) {
    const coefficients = DOMAIN_AFFINITY[domain]
    let affinity = 0
    for (const [dataDomain, coefficient] of Object.entries(coefficients) as [DataDomain, number][]) {
      affinity += Math.max(0, input.domainWeights[dataDomain] ?? 0) * coefficient
    }
    const domainEvidence =
      1 - Math.exp(-(Math.max(0, input.effectiveDataRatio) * clamp01(affinity)) / 2)
    const latent = 0.58 * generalSignal + 0.42 * domainEvidence * dataQuality
    domains[domain] = clampScore(saturate(latent) * 0.82 + qualityAxis(domain, input.quality) * 0.18)
  }

  if (!modalityAvailable(input.io, 'image')) domains.vision = Math.min(domains.vision, 12)
  if (!modalityAvailable(input.io, 'video')) domains.video = Math.min(domains.video, 8)
  if (!modalityAvailable(input.io, 'audio')) domains.audio = Math.min(domains.audio, 10)
  if (input.io.tools <= 0) domains.tools = Math.min(domains.tools, 15)

  const post = postTrainSignal(input.postTrain)
  const factuality = clampScore(
    domains.reasoning * 0.35 +
      domains.science * 0.25 +
      domains.math * 0.2 +
      input.quality.reliability * 0.2,
  )
  const steerability = clampScore(
    domains.language * 0.45 +
      input.quality.chat * 0.25 +
      input.quality.reliability * 0.15 +
      post * 15,
  )
  const robustness = clampScore(domains.reasoning * 0.45 + input.quality.reliability * 0.55)
  return {
    domains,
    factuality,
    steerability,
    robustness,
    safety: clampScore(input.quality.safety),
    reliability: clampScore(input.quality.reliability),
  }
}

export interface SyntheticQualityInputs {
  domain: DataDomain
  teacherDomainCapability: number
  provenance: SyntheticProvenance
}

/** Maps a dataset domain to the teacher skill that can actually supervise it. */
export function teacherCapabilityForDataDomain(
  model: Model,
  domain: DataDomain,
): number {
  const capabilities = model.capabilities
  if (capabilities) {
    if (domain === 'code') return capabilities.domains.code
    if (domain === 'math') return capabilities.domains.math
    if (domain === 'science') return capabilities.domains.science
    if (domain === 'image') return capabilities.domains.vision
    if (domain === 'video') return capabilities.domains.video
    if (domain === 'audio') return capabilities.domains.audio
    if (domain === 'law') {
      return capabilities.domains.language * 0.65 + capabilities.domains.reasoning * 0.35
    }
    if (domain === 'health') {
      return capabilities.domains.science * 0.55 + capabilities.domains.reasoning * 0.25 + capabilities.factuality * 0.2
    }
    return capabilities.domains.language
  }
  if (domain === 'code') return model.benchmarks.coding
  if (domain === 'math') return model.benchmarks.math
  if (domain === 'science') return model.benchmarks.science
  if (domain === 'image') return model.benchmarks.vision
  if (domain === 'video') return model.quality.video
  if (domain === 'audio') return model.quality.chat * 0.7 + model.quality.reliability * 0.3
  if (domain === 'law' || domain === 'health') {
    return model.capability * 0.55 + model.quality.reasoning * 0.3 + model.quality.reliability * 0.15
  }
  return model.quality.chat * 0.65 + model.capability * 0.35
}

export interface SyntheticQualityResult {
  quality: number
  imitationCeiling: number
  verifierLift: number
  lineagePenalty: number
  ceiling: number
}

/** Synthetic signal is teacher-bounded except when code/math can be objectively verified. */
export function estimateSyntheticQuality(input: SyntheticQualityInputs): SyntheticQualityResult {
  const provenance = input.provenance
  const promptDiversity = clamp01(provenance.promptDiversity)
  const humanAnchor = clamp01(provenance.humanAnchorShare)
  const verifier = clamp01(provenance.verifierStrength)
  const imitationCeiling = clampScore(input.teacherDomainCapability) *
    (0.92 + 0.06 * promptDiversity + 0.02 * humanAnchor)
  const selectionStrength = Math.min(
    1,
    Math.log2(Math.max(1, provenance.candidatesPerAccepted)) / 4,
  )
  const verifierLift =
    input.domain === 'math' || input.domain === 'code'
      ? 14 * verifier * selectionStrength * (0.55 + 0.45 * humanAnchor)
      : 0
  const lineagePenalty = Math.min(
    30,
    Math.max(0, provenance.generationDepth - 1) * 3.5 * (1 - 0.6 * humanAnchor) +
      (1 - promptDiversity) * 8,
  )
  const ceiling = Math.min(98, imitationCeiling + verifierLift)
  return {
    quality: clampScore(ceiling - lineagePenalty),
    imitationCeiling,
    verifierLift,
    lineagePenalty,
    ceiling,
  }
}

export interface TrainingResultDiagnosis {
  forecastDelta: number
  placement: 'above' | 'within' | 'below'
  topDomains: CapabilityDomain[]
  weakestDomains: CapabilityDomain[]
  headline: string
  explanations: string[]
}

export function diagnoseTrainingResult(input: {
  forecast: TrainingForecast
  outcome: TrainingOutcome
  actualCapability: number
  capabilities: ModelCapabilities
}): TrainingResultDiagnosis {
  const delta = input.actualCapability - input.forecast.expectedCapability
  const placement = delta > 2 ? 'above' : delta < -2 ? 'below' : 'within'
  const ordered = CAPABILITY_DOMAINS.toSorted(
    (a, b) => input.capabilities.domains[b] - input.capabilities.domains[a] || a.localeCompare(b),
  )
  const explanations = [
    `Capability ${input.actualCapability.toFixed(1)} versus ${input.forecast.expectedCapability.toFixed(1)} expected (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}).`,
    `${input.outcome.kind}: ${(input.outcome.yieldMultiplier * 100).toFixed(1)}% optimization yield. ${input.outcome.explanation}`,
    `${input.forecast.risk} forecast risk; effective data ratio ${input.forecast.effectiveDataRatio.toFixed(2)}× and ${input.forecast.repeatedDataEpochs.toFixed(1)} corpus epochs.`,
    ...input.forecast.warnings.slice(0, 3),
  ]
  return {
    forecastDelta: delta,
    placement,
    topDomains: ordered.slice(0, 2),
    weakestDomains: ordered.slice(-2).reverse(),
    headline:
      placement === 'above'
        ? 'The run beat its forecast.'
        : placement === 'below'
          ? 'The run finished below forecast.'
          : 'The run landed inside its forecast.',
    explanations,
  }
}

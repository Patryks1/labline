import type {
  BenchmarkId,
  BenchmarkMetricId,
  BenchmarkScores,
  BenchmarkSuiteId,
  BenchmarkSuiteScores,
  DataDomain,
  EvaluationProfile,
  Model,
  ModelFamily,
  ModelIOModality,
  PostTrainStage,
  QualityAxes,
} from '../types'

export interface BenchmarkPolicyInput {
  scores: BenchmarkScores
  intelligence: number
  capability: number
  family: ModelFamily
  quality: QualityAxes
  postTrain?: PostTrainStage | string
  reasoningEnabled?: boolean
  toolsEnabled?: boolean
  imageDataQualityFactor?: number
  healthLowQualityShare?: number
  scienceDataQuality?: number
  chatDataQuality?: number
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n))
const clamp01 = (n: number) => clamp(n, 0, 1)

export function inferReasoningEnabled(input: {
  reasoningEnabled?: boolean
  postTrain?: string
  integratedMethods?: readonly string[]
  modelStack?: readonly string[]
}): boolean {
  if (input.reasoningEnabled != null) return input.reasoningEnabled
  return (
    input.postTrain === 'process' ||
    input.postTrain === 'tools' ||
    input.integratedMethods?.includes('align_process') === true ||
    input.modelStack?.includes('align_process') === true
  )
}

/** Shared hard-cap and dependency policy for player, rival, preview, and migrated models. */
export function applyBenchmarkPolicy(input: BenchmarkPolicyInput): BenchmarkScores {
  const out = { ...input.scores }
  if (!Number.isFinite(out.personality)) out.personality = 0
  const reasoning = inferReasoningEnabled(input)
  const generationOnly = input.family === 'diffusion' || input.family === 'video'
  const nonReasoningCap = 40 + 20 * clamp01((input.intelligence - 0.35) / 0.45)

  if (!reasoning) {
    out.coding = Math.min(out.coding, nonReasoningCap)
    out.math = Math.min(out.math, nonReasoningCap)
    out.science = Math.min(out.science, 40)
  }

  const scienceEvidence = clamp(input.scienceDataQuality ?? input.capability)
  const scienceDependency =
    scienceEvidence * 0.35 + input.quality.reasoning * 0.25 + input.quality.coding * 0.2 + input.capability * 0.2
  out.science = Math.min(out.science, clamp(scienceDependency + (reasoning ? 4 : 0)))

  const healthLq = clamp01(input.healthLowQualityShare ?? 0)
  const healthPenalty = 1 - 0.45 * (Math.max(0, healthLq - 0.1) / 0.9)
  out.health = clamp(out.health * healthPenalty)

  if (input.family === 'dense') {
    out.vision = Math.min(out.vision, 40 + 10 * clamp01(input.imageDataQualityFactor ?? 0.5))
    if ((input.chatDataQuality ?? 50) >= 45) out.multilingual = clamp(out.multilingual + 8)
  } else if (input.family === 'moe' && (input.chatDataQuality ?? 50) >= 45) {
    out.multilingual = clamp(out.multilingual + 3)
  }

  if (generationOnly) out.agents = Math.min(out.agents, 25)
  else if (!input.toolsEnabled) out.agents = Math.min(out.agents, 35)
  else out.agents = Math.min(out.agents, reasoning ? 90 : 65)

  return Object.fromEntries(
    Object.entries(out).map(([id, value]) => [id, clamp(value)]),
  ) as BenchmarkScores
}

export interface BenchmarkMetricDef {
  id: BenchmarkMetricId
  label: string
  short: string
}

export type EvaluationMarket = 'language' | 'image' | 'video' | 'audio'

export const EVALUATION_MARKETS: ReadonlyArray<{
  id: EvaluationMarket
  label: string
  suite: BenchmarkSuiteId
}> = [
  { id: 'language', label: 'Language', suite: 'language' },
  { id: 'image', label: 'Image', suite: 'image_generation' },
  { id: 'video', label: 'Video', suite: 'video_generation' },
  { id: 'audio', label: 'Audio', suite: 'audio_generation' },
]

/** Public eval markets are based on products a checkpoint can actually output. */
export function evaluationMarketsForModel(model: Model): EvaluationMarket[] {
  const markets: EvaluationMarket[] = []
  if (model.family !== 'diffusion' && model.family !== 'video' && outputEnabled(model, 'text')) {
    markets.push('language')
  }
  if (outputEnabled(model, 'image')) markets.push('image')
  if (outputEnabled(model, 'video')) markets.push('video')
  if (outputEnabled(model, 'audio')) markets.push('audio')
  return markets
}

export function suiteForEvaluationMarket(market: EvaluationMarket): BenchmarkSuiteId {
  return EVALUATION_MARKETS.find((candidate) => candidate.id === market)!.suite
}

export const SUITE_METRICS: Record<BenchmarkSuiteId, readonly BenchmarkMetricDef[]> = {
  language: [
    ['mmlu', 'General knowledge', 'Knowledge'],
    ['coding', 'Coding', 'Code'],
    ['math', 'Math & reasoning', 'Reasoning'],
    ['vision', 'Vision understanding', 'Vision'],
    ['law', 'Legal', 'Legal'],
    ['health', 'Health', 'Health'],
    ['science', 'Science', 'Science'],
    ['multilingual', 'Multilingual', 'Languages'],
    ['agents', 'Agents & tools', 'Agents'],
    ['safety', 'Safety evals', 'Safety'],
    ['personality', 'Personality', 'Voice'],
  ].map(([id, label, short]) => ({ id: id as BenchmarkMetricId, label, short })),
  image_generation: [
    ['prompt_alignment', 'Prompt alignment', 'Prompt'],
    ['aesthetics', 'Aesthetics', 'Aesthetic'],
    ['typography', 'Typography', 'Type'],
    ['subject_consistency', 'Subject consistency', 'Consistency'],
    ['editing_control', 'Editing & control', 'Control'],
    ['image_safety', 'Image safety', 'Safety'],
  ].map(([id, label, short]) => ({ id: id as BenchmarkMetricId, label, short })),
  video_generation: [
    ['video_prompt_alignment', 'Prompt alignment', 'Prompt'],
    ['visual_quality', 'Visual quality', 'Quality'],
    ['temporal_coherence', 'Temporal coherence', 'Temporal'],
    ['motion_physics', 'Motion & physics', 'Motion'],
    ['video_control', 'Controllability', 'Control'],
    ['video_safety', 'Video safety', 'Safety'],
  ].map(([id, label, short]) => ({ id: id as BenchmarkMetricId, label, short })),
  audio_generation: [
    ['intelligibility', 'Intelligibility', 'Clarity'],
    ['naturalness', 'Naturalness', 'Natural'],
    ['voice_consistency', 'Voice consistency', 'Voice'],
    ['music_quality', 'Music & audio quality', 'Music'],
    ['realtime_performance', 'Realtime performance', 'Realtime'],
    ['audio_safety', 'Audio safety', 'Safety'],
  ].map(([id, label, short]) => ({ id: id as BenchmarkMetricId, label, short })),
  omni_overview: [
    ['omni_language', 'Language', 'Language'],
    ['omni_reasoning', 'Reasoning', 'Reasoning'],
    ['omni_tools', 'Tools', 'Tools'],
    ['omni_image', 'Image', 'Image'],
    ['omni_video', 'Video', 'Video'],
    ['omni_audio', 'Audio', 'Audio'],
    ['omni_safety', 'Safety', 'Safety'],
  ].map(([id, label, short]) => ({ id: id as BenchmarkMetricId, label, short })),
}

function outputEnabled(model: Model, modality: ModelIOModality): boolean {
  if ((model.io?.outputs[modality] ?? 0) > 0) return true
  if (modality === 'image') return model.family === 'diffusion' || model.family === 'omni'
  if (modality === 'video') return model.family === 'video' || model.family === 'omni'
  if (modality === 'audio') return model.productPreset === 'audio' || model.family === 'omni'
  return model.modalities.includes('text')
}

function domainQuality(model: Model, domain: DataDomain, fallback: number): number {
  return clamp(model.dataQualityByDomain?.[domain] ?? model.dataQualityUsed ?? fallback)
}

function metricProfile(model: Model): EvaluationProfile {
  const profile: EvaluationProfile = {}
  const ceiling = (id: BenchmarkMetricId, positive: string, penalty: string, value = 96) => {
    profile[id] = { ceiling: value, positive, penalty }
  }
  for (const id of Object.keys(model.benchmarks) as BenchmarkId[]) {
    ceiling(
      id,
      model.reasoningEnabled ? 'Reasoning training and high-quality domain data' : 'Model scale and domain data',
      !model.reasoningEnabled && ['coding', 'math', 'science'].includes(id)
        ? 'Non-reasoning architecture ceiling'
        : 'Data quality and scale ceiling',
      id === 'science' && !model.reasoningEnabled ? 40 : 96,
    )
  }
  const intelligence = clamp01((model.capability - 9) / 85)
  const reasoning = inferReasoningEnabled(model)
  if (!reasoning) {
    const ceiling = 40 + 20 * clamp01((intelligence - 0.35) / 0.45)
    profile.coding = { ...profile.coding!, ceiling }
    profile.math = { ...profile.math!, ceiling }
    profile.science = { ...profile.science!, ceiling: 40 }
  }
  if (model.family === 'dense') {
    profile.vision = {
      ...profile.vision!,
      ceiling: 40 + 10 * clamp01(domainQuality(model, 'image', model.quality.image) / 100),
      penalty: 'Dense vision-backbone ceiling and image-data quality',
    }
  }
  const generationOnly = model.family === 'diffusion' || model.family === 'video'
  const toolsEnabled = (model.io?.tools ?? 0) > 0 || model.modalities.includes('tools')
  profile.agents = {
    ...profile.agents!,
    ceiling: generationOnly ? 25 : !toolsEnabled ? 35 : reasoning ? 90 : 65,
    penalty: generationOnly ? 'Generation-only architecture' : !toolsEnabled ? 'Tools I/O is not enabled' : profile.agents!.penalty,
  }
  return profile
}

export function buildBenchmarkSuites(model: Model): {
  suites: BenchmarkSuiteScores
  profile: EvaluationProfile
} {
  const suites: BenchmarkSuiteScores = {}
  const profile = metricProfile(model)
  const capability = clamp(model.capability)
  const safety = clamp(model.capabilities?.safety ?? model.quality.safety)
  const reliability = clamp(model.capabilities?.reliability ?? model.quality.reliability)
  const reasoning = clamp(model.capabilities?.domains.reasoning ?? model.quality.reasoning)
  const tools = clamp(model.capabilities?.domains.tools ?? model.io?.tools ?? model.benchmarks.agents)
  const image = clamp(model.capabilities?.domains.vision ?? model.quality.image)
  const video = clamp(model.capabilities?.domains.video ?? model.quality.video)
  const audio = clamp(model.capabilities?.domains.audio ?? (model.productPreset === 'audio' ? capability * 0.72 : 0))

  if (model.family !== 'diffusion' && model.family !== 'video') {
    suites.language = { ...model.benchmarks }
  }

  if (outputEnabled(model, 'image')) {
    const q = domainQuality(model, 'image', image)
    suites.image_generation = {
      prompt_alignment: clamp(image * 0.55 + reasoning * 0.2 + q * 0.25),
      aesthetics: clamp(image * 0.62 + q * 0.28 + capability * 0.1),
      typography: clamp(image * 0.42 + model.quality.coding * 0.18 + q * 0.25 + reasoning * 0.15),
      subject_consistency: clamp(image * 0.5 + reliability * 0.3 + q * 0.2),
      editing_control: clamp(image * 0.42 + tools * 0.25 + reasoning * 0.2 + reliability * 0.13),
      image_safety: safety,
    }
  }

  if (outputEnabled(model, 'video')) {
    const q = domainQuality(model, 'video', video)
    suites.video_generation = {
      video_prompt_alignment: clamp(video * 0.5 + reasoning * 0.25 + q * 0.25),
      visual_quality: clamp(video * 0.55 + image * 0.25 + q * 0.2),
      temporal_coherence: clamp(video * 0.58 + reliability * 0.27 + reasoning * 0.15),
      motion_physics: clamp(video * 0.48 + reasoning * 0.34 + q * 0.18),
      video_control: clamp(video * 0.42 + tools * 0.24 + reasoning * 0.2 + reliability * 0.14),
      video_safety: safety,
    }
  }

  if (outputEnabled(model, 'audio')) {
    const q = domainQuality(model, 'audio', audio)
    const realtime = model.serviceProfile?.audioRealtimeFactor
      ? clamp(100 / Math.max(1, model.serviceProfile.audioRealtimeFactor))
      : audio * 0.75
    suites.audio_generation = {
      intelligibility: clamp(audio * 0.58 + q * 0.25 + reliability * 0.17),
      naturalness: clamp(audio * 0.62 + q * 0.28 + capability * 0.1),
      voice_consistency: clamp(audio * 0.5 + reliability * 0.32 + q * 0.18),
      music_quality: clamp(audio * 0.55 + q * 0.35 + capability * 0.1),
      realtime_performance: realtime,
      audio_safety: safety,
    }
  }

  if (model.family === 'omni' || model.productPreset === 'omni') {
    suites.omni_overview = {
      omni_language: suiteComposite(suites.language),
      omni_reasoning: reasoning,
      omni_tools: tools,
      omni_image: suiteComposite(suites.image_generation),
      omni_video: suiteComposite(suites.video_generation),
      omni_audio: suiteComposite(suites.audio_generation),
      omni_safety: safety,
    }
  }

  for (const [suiteId, scores] of Object.entries(suites) as [BenchmarkSuiteId, Partial<Record<BenchmarkMetricId, number>>][]) {
    for (const [id, score] of Object.entries(scores) as [BenchmarkMetricId, number][]) {
      if (!profile[id]) {
        profile[id] = {
          ceiling: 96,
          positive: `${SUITE_METRICS[suiteId].find((metric) => metric.id === id)?.label ?? id} data and model capability`,
          penalty: 'Insufficient matching data, reliability, or modality capacity',
        }
      }
      scores[id] = clamp(score)
    }
  }

  return { suites, profile }
}

export function suiteComposite(scores?: Partial<Record<BenchmarkMetricId, number>>): number {
  const values = Object.values(scores ?? {}).filter((value): value is number => Number.isFinite(value))
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

export function normalizeModelEvaluations(model: Model): Model {
  const reasoningEnabled = inferReasoningEnabled(model)
  const intelligence = clamp01((model.capability - 9) / 85)
  const benchmarks = applyBenchmarkPolicy({
    scores: {
      ...model.benchmarks,
      personality:
        model.benchmarks.personality ||
        model.productProfile?.personality ||
        0,
    },
    intelligence,
    capability: model.capability,
    family: model.family,
    quality: model.quality,
    postTrain: model.postTrain,
    reasoningEnabled,
    toolsEnabled: (model.io?.tools ?? 0) > 0 || model.modalities.includes('tools'),
    imageDataQualityFactor: domainQuality(model, 'image', model.quality.image) / 100,
    healthLowQualityShare: model.lowQualityShareByDomain?.health ?? 0,
    scienceDataQuality: domainQuality(model, 'science', model.capability),
    chatDataQuality: domainQuality(model, 'chat', model.quality.chat),
  })
  const base: Model = {
    ...model,
    benchmarks,
    reasoningEnabled,
    revision: model.revision ?? 1,
    safetyTraining: model.safetyTraining ?? {
      campaigns: 0,
      safetyDataMTok: model.dataVerifyMTok ?? 0,
      safetyDataQuality: model.dataQualityUsed ?? 50,
      cashSpent: 0,
      trainingPfSpent: 0,
      researchPfSpent: 0,
      revisions: [],
    },
  }
  const { suites, profile } = buildBenchmarkSuites(base)
  return { ...base, benchmarkSuites: suites, evaluationProfile: profile }
}

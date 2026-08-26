import type { BenchmarkMetricId, EffortRecipe, Model } from '../types'
import {
  INSTANT_EFFORT_ID,
  effortComputeIntensityForRecipe,
  migrateEffortRecipes,
  serveTokenMultiplierForRecipe,
} from './modelProduct'
import { estimateServingWorkload } from './tokenServe'
import { NATIVE_WORKLOAD_PROFILE } from './workload'

export type BenchmarkTaskWorkload =
  | 'language'
  | 'coding'
  | 'reasoning'
  | 'image'
  | 'video'
  | 'audio'

export interface BenchmarkTaskTokenProfile {
  workload: BenchmarkTaskWorkload
  inputTokens: number
  /** Visible output, hidden reasoning, or native token-equivalents at Instant. */
  generatedTokens: number
}

export interface BenchmarkTaskCostEstimate extends BenchmarkTaskTokenProfile {
  recipeId: string
  recipeName: string
  tokenMultiplier: number
  computeIntensityMultiplier: number
  billedGeneratedTokens: number
  billedTokens: number
  priceInPerMTok: number
  priceOutPerMTok: number
  billingBasis: 'tokens' | 'image' | 'video' | 'audio'
  cost: number
  inputPfDays: number
  generatedPfDays: number
  computePfDays: number
  estimatedTokensPerSecond: number
  timeToFirstTokenMs: number
  estimatedLatencyMs: number
}

export interface BenchmarkMetricRunEstimate extends BenchmarkTaskCostEstimate {
  metricId: BenchmarkMetricId
  taskCount: number
  totalBilledTokens: number
  totalComputePfDays: number
  totalTokenCost: number
}

/** Persisted physical and billing evidence for one concrete private run. */
export interface BenchmarkRunEstimate {
  recipeId: string
  recipeName: string
  tokenMultiplier: number
  computeIntensityMultiplier: number
  taskCount: number
  metricCount: number
  billedTokens: number
  tokenCost: number
  cashCostPerTask: number
  computePfDays: number
  estimatedTokensPerSecond: number
  averageLatencyMs: number
  averageTimeToFirstTokenMs: number
  serialDurationSeconds: number
  metrics: BenchmarkMetricRunEstimate[]
}

const CODING_METRICS = new Set<BenchmarkMetricId>([
  'coding',
  'agents',
  'omni_tools',
])
const REASONING_METRICS = new Set<BenchmarkMetricId>([
  'math',
  'law',
  'health',
  'science',
  'omni_reasoning',
])
const IMAGE_METRICS = new Set<BenchmarkMetricId>([
  'prompt_alignment',
  'aesthetics',
  'typography',
  'subject_consistency',
  'editing_control',
  'image_safety',
  'omni_image',
])
const VIDEO_METRICS = new Set<BenchmarkMetricId>([
  'video_prompt_alignment',
  'visual_quality',
  'temporal_coherence',
  'motion_physics',
  'video_control',
  'video_safety',
  'omni_video',
])
const AUDIO_METRICS = new Set<BenchmarkMetricId>([
  'intelligibility',
  'naturalness',
  'voice_consistency',
  'music_quality',
  'realtime_performance',
  'audio_safety',
  'omni_audio',
])

export function benchmarkTaskWorkload(
  metricId: BenchmarkMetricId,
): BenchmarkTaskWorkload {
  if (CODING_METRICS.has(metricId)) return 'coding'
  if (REASONING_METRICS.has(metricId)) return 'reasoning'
  if (IMAGE_METRICS.has(metricId)) return 'image'
  if (VIDEO_METRICS.has(metricId)) return 'video'
  if (AUDIO_METRICS.has(metricId)) return 'audio'
  return 'language'
}

/** One representative task using the same profiles as live API settlement. */
export function benchmarkTaskTokenProfile(
  metricId: BenchmarkMetricId,
): BenchmarkTaskTokenProfile {
  const workload = benchmarkTaskWorkload(metricId)
  if (workload === 'coding') {
    const profile = NATIVE_WORKLOAD_PROFILE.coding
    return {
      workload,
      inputTokens: Math.round(profile.tokensPerInteraction * profile.inputShare),
      generatedTokens: Math.round(profile.tokensPerInteraction * profile.outputShare),
    }
  }
  if (workload === 'reasoning') {
    const profile = NATIVE_WORKLOAD_PROFILE.reasoning
    return {
      workload,
      inputTokens: Math.round(profile.tokensPerInteraction * profile.inputShare),
      generatedTokens: Math.round(
        profile.tokensPerInteraction *
          (profile.outputShare + profile.reasoningShare),
      ),
    }
  }
  if (workload === 'image') {
    return {
      workload,
      inputTokens: 0,
      generatedTokens: NATIVE_WORKLOAD_PROFILE.image.equivalentTokensPerImage,
    }
  }
  if (workload === 'video') {
    return {
      workload,
      inputTokens: 0,
      generatedTokens: NATIVE_WORKLOAD_PROFILE.video.equivalentTokensPerClip,
    }
  }
  if (workload === 'audio') {
    return {
      workload,
      inputTokens: 0,
      generatedTokens:
        NATIVE_WORKLOAD_PROFILE.audio.equivalentTokensPerInteraction,
    }
  }
  const profile = NATIVE_WORKLOAD_PROFILE.language
  return {
    workload,
    inputTokens: Math.round(profile.tokensPerInteraction * profile.inputShare),
    generatedTokens: Math.round(profile.tokensPerInteraction * profile.outputShare),
  }
}

export function benchmarkEffortRecipes(
  model: Pick<Model, 'productProfile'>,
): EffortRecipe[] {
  return migrateEffortRecipes(model.productProfile).filter(
    (recipe) => recipe.trained || recipe.kind === 'instant',
  )
}

export function benchmarkEffortRecipe(
  model: Pick<Model, 'productProfile'>,
  recipeId?: string,
): EffortRecipe | null {
  const recipes = benchmarkEffortRecipes(model)
  return (
    recipes.find((recipe) => recipe.id === (recipeId ?? INSTANT_EFFORT_ID)) ??
    null
  )
}

/** Generated-token multiplier relative to this model's Instant recipe. */
export function benchmarkGeneratedTokenMultiplier(
  model: Pick<Model, 'productProfile'>,
  recipe: EffortRecipe,
): number {
  if (recipe.kind === 'instant') return 1
  const efficiency = model.productProfile?.tokenEfficiency ?? 50
  const instant = benchmarkEffortRecipe(model, INSTANT_EFFORT_ID)
  const instantMult = instant
    ? serveTokenMultiplierForRecipe(instant, efficiency)
    : 1
  return Math.max(
    1,
    serveTokenMultiplierForRecipe(recipe, efficiency) /
      Math.max(1e-9, instantMult),
  )
}

/** Input is fixed; generated/hidden-reasoning tokens scale with effort. */
export function estimateBenchmarkTaskCost(
  model: Model,
  metricId: BenchmarkMetricId,
  recipeId: string,
  prices: { priceIn: number; priceOut: number },
  servingEfficiency = 1,
): BenchmarkTaskCostEstimate {
  const profile = benchmarkTaskTokenProfile(metricId)
  const recipe = benchmarkEffortRecipe(model, recipeId)
  if (!recipe) {
    throw new RangeError(
      `Unknown or untrained benchmark effort recipe: ${recipeId}`,
    )
  }
  const textEffort =
    profile.workload === 'language' ||
    profile.workload === 'coding' ||
    profile.workload === 'reasoning'
  const tokenMultiplier = textEffort
    ? benchmarkGeneratedTokenMultiplier(model, recipe)
    : 1
  const computeIntensityMultiplier = textEffort
    ? effortComputeIntensityForRecipe(recipe)
    : 1
  const billedGeneratedTokens = profile.generatedTokens * tokenMultiplier
  const priceInPerMTok = Math.max(0, prices.priceIn)
  const priceOutPerMTok = Math.max(0, prices.priceOut)
  const servingWork = estimateServingWorkload({
    model,
    inputMTok: profile.inputTokens / 1_000_000,
    outputMTok: billedGeneratedTokens / 1_000_000,
    avgInputTokens: Math.max(1, profile.inputTokens),
    avgOutputTokens: Math.max(1, billedGeneratedTokens),
    servingEfficiency,
  })
  const inputPfDays = servingWork.inputPfDays
  const generatedPfDays = servingWork.outputPfDays * computeIntensityMultiplier
  const timeToFirstTokenMs = Math.max(
    0,
    model.serviceProfile?.timeToFirstTokenMs ?? 180,
  )
  const interactiveTokensPerSecond =
    (model.serviceProfile?.interactiveTokPerSec ??
      Math.max(
        2,
        52 * Math.max(0.05, model.tokPerSecMult ?? 1) * servingEfficiency,
      )) / computeIntensityMultiplier
  const nativeDurationSeconds =
    profile.workload === 'image'
      ? model.serviceProfile?.imageSeconds
      : profile.workload === 'video'
        ? (model.serviceProfile?.videoSecondsPerSecond ?? 0) *
          NATIVE_WORKLOAD_PROFILE.video.secondsPerClip
        : profile.workload === 'audio'
          ? (model.serviceProfile?.audioRealtimeFactor ?? 0) *
            NATIVE_WORKLOAD_PROFILE.audio.secondsPerInteraction
          : null
  const estimatedLatencyMs =
    nativeDurationSeconds != null && nativeDurationSeconds > 0
      ? nativeDurationSeconds * 1_000
      : timeToFirstTokenMs +
        (billedGeneratedTokens / Math.max(1, interactiveTokensPerSecond)) * 1_000
  const estimatedTokensPerSecond =
    nativeDurationSeconds != null && nativeDurationSeconds > 0
      ? profile.generatedTokens / nativeDurationSeconds
      : interactiveTokensPerSecond
  const tokenCost =
    (profile.inputTokens / 1_000_000) * priceInPerMTok +
    (billedGeneratedTokens / 1_000_000) * priceOutPerMTok
  const billingBasis =
    profile.workload === 'image' && model.apiPricePerImage != null
      ? 'image'
      : profile.workload === 'video' && model.apiPricePerVideoSecond != null
        ? 'video'
        : profile.workload === 'audio' && model.apiPricePerAudioMinute != null
          ? 'audio'
          : 'tokens'
  const cost =
    billingBasis === 'image'
      ? Math.max(0, model.apiPricePerImage ?? 0)
      : billingBasis === 'video'
        ? Math.max(0, model.apiPricePerVideoSecond ?? 0) *
          NATIVE_WORKLOAD_PROFILE.video.secondsPerClip
        : billingBasis === 'audio'
          ? Math.max(0, model.apiPricePerAudioMinute ?? 0) *
            (NATIVE_WORKLOAD_PROFILE.audio.secondsPerInteraction / 60)
          : tokenCost
  return {
    ...profile,
    recipeId: recipe.id,
    recipeName: recipe.name,
    tokenMultiplier,
    computeIntensityMultiplier,
    billedGeneratedTokens,
    billedTokens: profile.inputTokens + billedGeneratedTokens,
    priceInPerMTok,
    priceOutPerMTok,
    billingBasis,
    cost,
    inputPfDays,
    generatedPfDays,
    computePfDays: inputPfDays + generatedPfDays,
    estimatedTokensPerSecond,
    timeToFirstTokenMs,
    estimatedLatencyMs,
  }
}

export function estimateBenchmarkRun(
  model: Model,
  metricIds: readonly BenchmarkMetricId[],
  recipeId: string,
  prices: { priceIn: number; priceOut: number },
  tasksPerMetric: number,
  servingEfficiency = 1,
): BenchmarkRunEstimate {
  const recipe = benchmarkEffortRecipe(model, recipeId)
  if (!recipe) {
    throw new RangeError(
      `Unknown or untrained benchmark effort recipe: ${recipeId}`,
    )
  }
  const perMetric = Math.max(
    1,
    Math.floor(Number.isFinite(tasksPerMetric) ? tasksPerMetric : 1),
  )
  const metrics = metricIds.map((metricId): BenchmarkMetricRunEstimate => {
    const task = estimateBenchmarkTaskCost(
      model,
      metricId,
      recipeId,
      prices,
      servingEfficiency,
    )
    return {
      ...task,
      metricId,
      taskCount: perMetric,
      totalBilledTokens: task.billedTokens * perMetric,
      totalComputePfDays: task.computePfDays * perMetric,
      totalTokenCost: task.cost * perMetric,
    }
  })
  const taskCount = metrics.reduce((sum, metric) => sum + metric.taskCount, 0)
  const billedTokens = metrics.reduce(
    (sum, metric) => sum + metric.totalBilledTokens,
    0,
  )
  const tokenCost = metrics.reduce(
    (sum, metric) => sum + metric.totalTokenCost,
    0,
  )
  const computePfDays = metrics.reduce(
    (sum, metric) => sum + metric.totalComputePfDays,
    0,
  )
  const serialDurationSeconds = metrics.reduce(
    (sum, metric) =>
      sum + (metric.estimatedLatencyMs / 1_000) * metric.taskCount,
    0,
  )
  const weightedTokensPerSecond = metrics.reduce(
    (sum, metric) =>
      sum + metric.estimatedTokensPerSecond * metric.taskCount,
    0,
  )
  const weightedTtft = metrics.reduce(
    (sum, metric) => sum + metric.timeToFirstTokenMs * metric.taskCount,
    0,
  )
  return {
    recipeId: recipe.id,
    recipeName: recipe.name,
    tokenMultiplier: metrics[0]?.tokenMultiplier ?? 1,
    computeIntensityMultiplier:
      metrics[0]?.computeIntensityMultiplier ?? 1,
    taskCount,
    metricCount: metrics.length,
    billedTokens,
    tokenCost,
    cashCostPerTask: taskCount > 0 ? tokenCost / taskCount : 0,
    computePfDays,
    estimatedTokensPerSecond:
      taskCount > 0 ? weightedTokensPerSecond / taskCount : 0,
    averageLatencyMs:
      taskCount > 0 ? (serialDurationSeconds * 1_000) / taskCount : 0,
    averageTimeToFirstTokenMs: taskCount > 0 ? weightedTtft / taskCount : 0,
    serialDurationSeconds,
    metrics,
  }
}

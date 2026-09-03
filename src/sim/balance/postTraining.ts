import type { DataDomain, Model, PostTrainGym, PostTrainStage, ToolSkill, TrainingJob } from '../types'
import {
  gymQualityForStage,
  meanToolProficiency,
  postTrainGymWorkMult,
  postTrainStageCashCost,
} from './modelStudio'
import { trainingNumericsEconomicsProfile } from './trainingPrecision'
import { activeBalanceTuning } from './tuning'

// V4-DELETE: post-training recipes replaced by src/sim/training/postTrain.ts (WS-C).
export type TrainablePostStage = Exclude<PostTrainStage, 'none'>

export const POST_TRAIN_STAGES: readonly TrainablePostStage[] = [
  'sft',
  'rlhf',
  'process',
  'tools',
]

const STAGE_BASE_TARGET: Record<TrainablePostStage, number> = {
  sft: 55,
  rlhf: 105,
  process: 155,
  tools: 125,
}

const STAGE_MIN_DAYS: Record<TrainablePostStage, number> = {
  sft: 14,
  rlhf: 24,
  process: 32,
  tools: 28,
}

const STAGE_BASE_FAILURE_RISK: Record<TrainablePostStage, number> = {
  sft: 0.018,
  rlhf: 0.045,
  process: 0.07,
  tools: 0.055,
}

const RELEVANT_DATA: Record<
  TrainablePostStage,
  Partial<Record<DataDomain, number>>
> = {
  sft: { chat: 0.65, code: 0.15, law: 0.05, health: 0.05, math: 0.1 },
  rlhf: { chat: 0.5, law: 0.15, health: 0.15, code: 0.1, math: 0.1 },
  process: { math: 0.4, science: 0.25, code: 0.25, chat: 0.1 },
  tools: { code: 0.55, chat: 0.25, math: 0.15, science: 0.05 },
}

const clamp01 = (value: number) =>
  Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

/** Relevant token volume, rather than the whole pretraining corpus, drives stage scale. */
export function postTrainRelevantDataMTok(
  job: Pick<TrainingJob, 'trainMTok' | 'dataPlan'>,
  stage: TrainablePostStage,
): number {
  const alignVolume = Math.max(0, job.dataPlan?.postTrainMTok ?? 0)
  const weights =
    alignVolume > 1e-9 && job.dataPlan?.postTrainWeights
      ? job.dataPlan.postTrainWeights
      : (job.dataPlan?.weights ?? {})
  const affinity = RELEVANT_DATA[stage]
  let relevantShare = 0
  let specifiedShare = 0
  for (const [domain, weight] of Object.entries(weights) as [DataDomain, number][]) {
    const normalized = Math.max(0, weight ?? 0)
    specifiedShare += normalized
    relevantShare += normalized * (affinity[domain] ?? 0)
  }
  // Legacy/default recipes still contain general instruction material.
  const share = specifiedShare > 1e-9 ? relevantShare / specifiedShare : 0.22
  const volume = alignVolume > 1e-9 ? alignVolume : Math.max(0, job.trainMTok ?? 0)
  return volume * Math.max(0.04, share)
}

/**
 * PF-day work target. Post-training is a real campaign rather than a short
 * toggle: work grows sublinearly with the relevant instruction/preference
 * corpus, superlinearly across parameter decades, and on repeated passes.
 * `paramsB` defaults to 1 so legacy callers remain deterministic.
 */
export function postTrainTargetPfDays(
  job: Pick<TrainingJob, 'trainMTok' | 'dataPlan'> &
    Partial<Pick<TrainingJob, 'postTrainStageRuns' | 'activeParamsB'>>,
  stage: TrainablePostStage,
  paramsB = 1,
): number {
  const relevantMTok = postTrainRelevantDataMTok(job, stage)
  const volumeScale = 1 + 0.7 * Math.log10(1 + relevantMTok / 100)
  const earlyT = Math.max(0, Math.min(1, relevantMTok / 800))
  const earlyScale = 0.45 + 0.55 * (earlyT * earlyT * (3 - 2 * earlyT))
  const reasoningTax =
    stage === "process" || stage === "tools" ? 1.35 : 1
  // Sparse checkpoints train the active path plus a bounded share of the
  // inactive expert bank; treating the full bank as dense is too punitive.
  const activeParamsB = Math.max(0, Math.min(paramsB, job.activeParamsB ?? paramsB))
  const parameterBasisB = activeParamsB + (paramsB - activeParamsB) * 0.2
  const sizeScale = Math.pow(Math.max(1, parameterBasisB), 0.18)
  const repeatPasses = Math.max(0, job.postTrainStageRuns?.[stage] ?? 0)
  const repeatScale = 1 + Math.min(0.75, repeatPasses * 0.22)
  return (
    Math.round(
      STAGE_BASE_TARGET[stage] *
        Math.min(5, volumeScale) *
        Math.min(4.2, sizeScale) *
        repeatScale *
        earlyScale *
        reasoningTax *
        activeBalanceTuning().postTrainWorkMult *
        10,
    ) / 10
  )
}

/** Gym quality stretches PF-days; unfunded gyms waste cluster time. */
export function studioPostTrainTargetPfDays(
  job: Pick<TrainingJob, 'trainMTok' | 'dataPlan'> &
    Partial<Pick<TrainingJob, 'postTrainStageRuns' | 'activeParamsB' | 'targetParamsB'>>,
  stage: TrainablePostStage,
  paramsB = 1,
  gyms?: readonly PostTrainGym[],
  gymQualityBonus = 0,
): number {
  const quality = gymQualityForStage(stage, gyms, gymQualityBonus)
  return Math.round(postTrainTargetPfDays(job, stage, paramsB) * postTrainGymWorkMult(quality) * 10) / 10
}

export function postTrainStageQuote(
  job: Pick<TrainingJob, 'trainMTok' | 'dataPlan' | 'targetParamsB'> &
    Partial<Pick<TrainingJob, 'postTrainStageRuns' | 'activeParamsB'>>,
  stage: TrainablePostStage,
  gyms?: readonly PostTrainGym[],
  gymQualityBonus = 0,
): { pfDays: number; cash: number; gymQuality: number } {
  const paramsB = job.targetParamsB ?? 1
  const gymQuality = gymQualityForStage(stage, gyms, gymQualityBonus)
  return {
    pfDays: studioPostTrainTargetPfDays(job, stage, paramsB, gyms, gymQualityBonus),
    cash: postTrainStageCashCost(paramsB, stage, gymQuality),
    gymQuality,
  }
}

/** @deprecated Forecast-only duration hint; PF targets are the completion gate. */
export function postTrainMinimumDays(stage: TrainablePostStage, paramsB = 1): number {
  return Math.ceil(
    STAGE_MIN_DAYS[stage] * (1 + 0.4 * Math.log10(Math.max(1, paramsB))),
  )
}

export function completedPostTrainStages(
  job: Pick<
    TrainingJob,
    | 'completedPostTrainStages'
    | 'postTrain'
    | 'postTrainProgress'
    | 'postTrainTarget'
    | 'postTrainDaysElapsed'
    | 'targetParamsB'
  >,
): TrainablePostStage[] {
  const completed = new Set(job.completedPostTrainStages ?? [])
  if (
    job.postTrain !== 'none' &&
    job.postTrainTarget > 0 &&
    job.postTrainProgress + 1e-9 >= job.postTrainTarget
  ) {
    completed.add(job.postTrain)
  }
  return POST_TRAIN_STAGES.filter((stage) => completed.has(stage))
}

/**
 * A later model version may refresh a stage, but it cannot stack the full
 * first-pass benefit forever. Existing quality is never lost and each repeat
 * closes a progressively smaller share of the remaining headroom.
 */
export function mergePostTrainStageEffectiveness(
  previous: number | undefined,
  earned: number,
  previousRuns: number,
): number {
  const prior = clamp01(previous ?? 0)
  const next = clamp01(earned)
  if (previousRuns <= 0) return next
  const repeatWeight = Math.pow(0.55, Math.max(1, previousRuns))
  return clamp01(prior + (1 - prior) * next * repeatWeight)
}

function relevantDataQuality(
  job: Pick<TrainingJob, 'dataQualityUsed' | 'dataQualityByDomain'>,
  stage: TrainablePostStage,
): number {
  const affinity = RELEVANT_DATA[stage]
  let total = 0
  let weighted = 0
  for (const [domain, weight] of Object.entries(affinity) as [DataDomain, number][]) {
    total += weight
    weighted += (job.dataQualityByDomain?.[domain] ?? job.dataQualityUsed ?? 50) * weight
  }
  return clamp01(weighted / Math.max(1e-9, total) / 100)
}

function researchSignal(stage: TrainablePostStage, unlocked: readonly string[]): number {
  const has = (id: string) => unlocked.includes(id)
  if (stage === 'sft') return has('align_sft') ? 1 : 0.62
  if (stage === 'rlhf') {
    return clamp01(0.55 + (has('align_rlhf') ? 0.25 : 0) + (has('data_pref') ? 0.12 : 0) + (has('align_dpo') ? 0.08 : 0))
  }
  if (stage === 'process') {
    return clamp01(0.52 + (has('align_process') ? 0.32 : 0) + (has('align_grpo') ? 0.16 : 0))
  }
  return clamp01(0.5 + (has('domain_agents') ? 0.35 : 0) + (has('domain_coding') ? 0.1 : 0) + (has('align_process') ? 0.05 : 0))
}

function foundationSignal(job: TrainingJob, models: readonly Model[]): number {
  const foundation = job.teacherId
    ? models.find((model) => model.id === job.teacherId)
    : job.continueFromId
      ? models.find((model) => model.id === job.continueFromId)
      : undefined
  if (!foundation) return clamp01((job.dataQualityUsed ?? 50) / 100)
  return clamp01(
    (foundation.capability * 0.55 +
      foundation.quality.reliability * 0.25 +
      foundation.quality.reasoning * 0.2) /
      100,
  )
}

export type PostTrainRiskBand = 'low' | 'guarded' | 'high' | 'critical'

export interface PostTrainFailureRisk {
  probability: number
  band: PostTrainRiskBand
  dataAdequacy: number
  dataQuality: number
  researchReadiness: number
  foundationStability: number
  sizePressure: number
  computePressure: number
  numericalPressure: number
  dataIntegrityPressure: number
  campaignRiskShift: number
  repeatPressure: number
  factors: string[]
}

/**
 * Explainable risk of a destructive stage divergence. The random draw lives
 * in systems/training and is frozen when the stage starts; this function is a
 * pure assessment of the immutable recipe, data, model scale and research.
 */
export function postTrainFailureRisk(input: {
  job: TrainingJob
  stage: TrainablePostStage
  researchUnlocked: readonly string[]
  models: readonly Model[]
}): PostTrainFailureRisk {
  const { job, stage } = input
  const relevantMTok = postTrainRelevantDataMTok(job, stage)
  const totalParamsB = Math.max(0.01, job.targetParamsB ?? 1)
  const activeParamsB = Math.max(
    0.01,
    Math.min(totalParamsB, job.activeParamsB ?? totalParamsB),
  )
  const paramsB = activeParamsB + (totalParamsB - activeParamsB) * 0.2
  const dataAdequacy = clamp01(
    1 - Math.exp(-relevantMTok / Math.max(20, paramsB * 28)),
  )
  const dataQuality = relevantDataQuality(job, stage)
  const researchReadiness = researchSignal(stage, input.researchUnlocked)
  const foundationStability = foundationSignal(job, input.models)
  const sizePressure = clamp01(Math.log10(Math.max(1, paramsB)) / 3)
  const targetPfDays = postTrainTargetPfDays(job, stage, paramsB)
  const computePressure = clamp01(
    Math.log10(1 + targetPfDays / STAGE_BASE_TARGET[stage]) / 0.85,
  )
  const priorRuns = Math.max(0, job.postTrainStageRuns?.[stage] ?? 0)
  const epochPressure = clamp01((Math.max(1, job.repeatedDataEpochs ?? 1) - 2) / 8)
  const repeatPressure = Math.max(clamp01(priorRuns / 3), epochPressure)
  const syntheticRisk = clamp01(job.synthLqShare ?? 0)
  const evidence = job.dataEvidence
  const dataIntegrityPressure = clamp01(
    (evidence?.contaminationRisk ?? 0) * 0.65 +
      (1 - (evidence?.effectiveDiversity ?? 1)) * 0.2 +
      (1 - (evidence?.effectiveFreshness ?? 1)) * 0.15,
  )
  const numericalStability = trainingNumericsEconomicsProfile(
    job.trainingNumerics ?? job.numerics,
  ).stabilityRisk
  const numericalPressure = clamp01((numericalStability + 0.08) / 0.2)
  const campaignRiskShift = Math.max(
    -0.12,
    Math.min(0.2, job.campaignModifiers?.stumbleRisk ?? 0),
  )
  const recoveryAttempt = Math.max(0, job.postTrainRecoveryAttempt ?? 0)
  const recipeMultiplier =
    job.outcomeRisk === 'high' ? 1.65 : job.outcomeRisk === 'medium' ? 1.2 : 0.9
  const learnedRecoveryMultiplier = Math.max(0.68, 1 - recoveryAttempt * 0.08)
  const raw =
    STAGE_BASE_FAILURE_RISK[stage] +
    (1 - dataAdequacy) * 0.075 +
    (1 - dataQuality) * 0.04 +
    (1 - researchReadiness) * 0.055 +
    (1 - foundationStability) * 0.025 +
    sizePressure * 0.04 +
    computePressure * 0.035 +
    repeatPressure * 0.035 +
    syntheticRisk * 0.08 +
    dataIntegrityPressure * 0.055 +
    numericalStability * 0.12 +
    campaignRiskShift
  const probability = Math.max(
    0.012,
    Math.min(0.38, raw * recipeMultiplier * learnedRecoveryMultiplier),
  )
  const band: PostTrainRiskBand =
    probability < 0.055
      ? 'low'
      : probability < 0.12
        ? 'guarded'
        : probability < 0.22
          ? 'high'
          : 'critical'
  const factors: string[] = []
  if (dataAdequacy < 0.55) factors.push('thin relevant dataset')
  if (dataQuality < 0.6) factors.push('weak supervision quality')
  if (researchReadiness < 0.72) factors.push('immature stage research')
  if (foundationStability < 0.58) factors.push('fragile foundation checkpoint')
  if (sizePressure > 0.55) factors.push('large-model optimization pressure')
  if (computePressure > 0.65) factors.push('long optimization horizon')
  if (repeatPressure > 0) factors.push('repeat-pass interference')
  if (syntheticRisk > 0.2) factors.push('low-quality synthetic signal')
  if (dataIntegrityPressure > 0.25) factors.push('contaminated or narrow evidence')
  if (numericalPressure > 0.6) factors.push('aggressive numerical precision')
  if (campaignRiskShift > 0.01) factors.push('unresolved campaign instability')
  if (factors.length === 0) factors.push('normal optimizer variance')
  return {
    probability,
    band,
    dataAdequacy,
    dataQuality,
    researchReadiness,
    foundationStability,
    sizePressure,
    computePressure,
    numericalPressure,
    dataIntegrityPressure,
    campaignRiskShift,
    repeatPressure,
    factors,
  }
}

export interface PostTrainEffectivenessInput {
  job: TrainingJob
  stage: TrainablePostStage
  researchUnlocked: readonly string[]
  models: readonly Model[]
  progress?: number
  daysElapsed?: number
  gyms?: readonly PostTrainGym[]
  tools?: readonly ToolSkill[]
  gymQualityBonus?: number
}

/**
 * Earned stage quality. Compute is the gate; data, research and the
 * teacher/base checkpoint determine how much a completed decision is worth.
 */
export function postTrainStageEffectiveness(input: PostTrainEffectivenessInput): number {
  const historical = input.stage !== input.job.postTrain
  const paramsB = input.job.targetParamsB ?? 1
  const target = Math.max(
    1e-9,
    historical
      ? postTrainTargetPfDays(input.job, input.stage, paramsB)
      : input.job.postTrainTarget || postTrainTargetPfDays(input.job, input.stage, paramsB),
  )
  const compute = clamp01(
    (input.progress ?? (historical ? target : input.job.postTrainProgress)) / target,
  )
  const relevantMTok = postTrainRelevantDataMTok(input.job, input.stage)
  const data = 1 - Math.exp(-relevantMTok / Math.max(25, input.job.targetParamsB * 25))
  const quality = relevantDataQuality(input.job, input.stage)
  const research = researchSignal(input.stage, input.researchUnlocked)
  const foundation = foundationSignal(input.job, input.models)
  const evidence =
    0.22 * data +
    0.2 * quality +
    0.2 * research +
    0.14 * foundation +
    0.24 * compute
  const gymMult =
    input.gyms == null
      ? 1
      : 0.7 + 0.3 * gymQualityForStage(input.stage, input.gyms, input.gymQualityBonus ?? 0)
  const toolMult =
    input.tools == null || input.stage !== 'tools'
      ? 1
      : 0.42 + 0.58 * meanToolProficiency(input.tools)
  // A selected stage with no allocated work is neutral; partial PF exposes at
  // most that fraction of the stage evidence.
  return clamp01(evidence * compute * gymMult * toolMult)
}

/** Resolve and freeze every completed stage, including legacy/cheat completions. */
export function resolvedPostTrainStageEffectiveness(
  job: TrainingJob,
  researchUnlocked: readonly string[],
  models: readonly Model[],
  gyms?: readonly PostTrainGym[],
  tools?: readonly ToolSkill[],
  gymQualityBonus = 0,
): Partial<Record<TrainablePostStage, number>> {
  const resolved = { ...(job.postTrainStageEffectiveness ?? {}) }
  for (const stage of completedPostTrainStages(job)) {
    resolved[stage] ??= postTrainStageEffectiveness({
      job,
      stage,
      gymQualityBonus,
      researchUnlocked,
      models,
      gyms,
      tools,
    })
  }
  return resolved
}

export function postTrainEffectProfile(
  job: TrainingJob,
  researchUnlocked: readonly string[],
  models: readonly Model[],
  gyms?: readonly PostTrainGym[],
  toolSkills?: readonly ToolSkill[],
  gymQualityBonus = 0,
): {
  scaleStrength: number
  alignmentEquivalent: number
  toolsEnabled: boolean
  stageEffectiveness: Record<TrainablePostStage, number>
} {
  const completed = new Set(completedPostTrainStages(job))
  const effectiveness = (stage: TrainablePostStage) => {
    const frozen = job.postTrainStageEffectiveness?.[stage]
    if (
      frozen != null &&
      (job.postTrainStagesCompletedThisRun ?? []).includes(stage)
    ) {
      return clamp01(frozen)
    }
    if (
      stage === job.postTrain &&
      job.postTrainTarget > 0 &&
      job.postTrainProgress > 0
    ) {
      const current = postTrainStageEffectiveness({
        job,
        stage,
        researchUnlocked,
        models,
        gyms,
        tools: toolSkills,
        gymQualityBonus,
      })
      const priorRuns =
        job.postTrainStageRuns?.[stage] ?? (frozen != null ? 1 : 0)
      return mergePostTrainStageEffectiveness(frozen, current, priorRuns)
    }
    if (frozen != null) return clamp01(frozen)
    if (stage === job.postTrain || completed.has(stage)) {
      return postTrainStageEffectiveness({
        job,
        stage,
        researchUnlocked,
        models,
        gyms,
        tools: toolSkills,
        gymQualityBonus,
      })
    }
    return 0
  }
  const sft = effectiveness('sft')
  const rlhf = effectiveness('rlhf')
  const process = effectiveness('process')
  const tools = effectiveness('tools')
  return {
    scaleStrength: clamp01(sft * 0.35 + rlhf * 0.4 + process * 0.5 + tools * 0.4),
    alignmentEquivalent: Math.min(4, sft + rlhf * 1.45 + process * 1.85 + tools * 1.2),
    // Tool I/O is a completed-stage feature. Partial effectiveness still feeds
    // the continuous scale/alignment previews above, but cannot flip a binary
    // product capability on before both work gates complete.
    toolsEnabled: completed.has('tools') && tools > 0,
    stageEffectiveness: { sft, rlhf, process, tools },
  }
}

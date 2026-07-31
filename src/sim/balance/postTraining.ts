import type { DataDomain, Model, PostTrainStage, TrainingJob } from '../types'

export type TrainablePostStage = Exclude<PostTrainStage, 'none'>

export const POST_TRAIN_STAGES: readonly TrainablePostStage[] = [
  'sft',
  'rlhf',
  'process',
  'tools',
]

const STAGE_BASE_TARGET: Record<TrainablePostStage, number> = {
  sft: 8,
  rlhf: 14,
  process: 20,
  tools: 18,
}

const STAGE_MIN_DAYS: Record<TrainablePostStage, number> = {
  sft: 3,
  rlhf: 6,
  process: 8,
  tools: 7,
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
  const weights = job.dataPlan?.weights ?? {}
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
  return Math.max(0, job.trainMTok ?? 0) * Math.max(0.04, share)
}

/** PF-day work target: a meaningful fixed decision that grows sublinearly with data. */
export function postTrainTargetPfDays(
  job: Pick<TrainingJob, 'trainMTok' | 'dataPlan'>,
  stage: TrainablePostStage,
): number {
  const relevantMTok = postTrainRelevantDataMTok(job, stage)
  const volumeScale = 1 + 0.55 * Math.log10(1 + relevantMTok / 250)
  return Math.round(STAGE_BASE_TARGET[stage] * Math.min(4, volumeScale) * 10) / 10
}

export function postTrainMinimumDays(stage: TrainablePostStage): number {
  return STAGE_MIN_DAYS[stage]
}

export function completedPostTrainStages(
  job: Pick<
    TrainingJob,
    'completedPostTrainStages' | 'postTrain' | 'postTrainProgress' | 'postTrainTarget'
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

export interface PostTrainEffectivenessInput {
  job: TrainingJob
  stage: TrainablePostStage
  researchUnlocked: readonly string[]
  models: readonly Model[]
  progress?: number
  daysElapsed?: number
}

/**
 * Earned stage quality. Compute is a gate; data, time, research and the
 * teacher/base checkpoint determine how much a completed decision is worth.
 */
export function postTrainStageEffectiveness(input: PostTrainEffectivenessInput): number {
  const historical = input.stage !== input.job.postTrain
  const target = Math.max(
    1e-9,
    historical
      ? postTrainTargetPfDays(input.job, input.stage)
      : input.job.postTrainTarget || postTrainTargetPfDays(input.job, input.stage),
  )
  const compute = clamp01(
    (input.progress ?? (historical ? target : input.job.postTrainProgress)) / target,
  )
  const time = clamp01(
    (input.daysElapsed ??
      (historical ? postTrainMinimumDays(input.stage) : input.job.postTrainDaysElapsed ?? 0)) /
      postTrainMinimumDays(input.stage),
  )
  const relevantMTok = postTrainRelevantDataMTok(input.job, input.stage)
  const data = 1 - Math.exp(-relevantMTok / Math.max(25, input.job.targetParamsB * 25))
  const quality = relevantDataQuality(input.job, input.stage)
  const research = researchSignal(input.stage, input.researchUnlocked)
  const foundation = foundationSignal(input.job, input.models)
  const evidence =
    0.22 * data +
    0.2 * quality +
    0.18 * research +
    0.12 * foundation +
    0.18 * compute +
    0.1 * time
  return clamp01(evidence * (0.3 + 0.7 * compute) * (0.65 + 0.35 * time))
}

/** Resolve and freeze every completed stage, including legacy/cheat completions. */
export function resolvedPostTrainStageEffectiveness(
  job: TrainingJob,
  researchUnlocked: readonly string[],
  models: readonly Model[],
): Partial<Record<TrainablePostStage, number>> {
  const resolved = { ...(job.postTrainStageEffectiveness ?? {}) }
  for (const stage of completedPostTrainStages(job)) {
    resolved[stage] ??= postTrainStageEffectiveness({
      job,
      stage,
      researchUnlocked,
      models,
    })
  }
  return resolved
}

export function postTrainEffectProfile(
  job: TrainingJob,
  researchUnlocked: readonly string[],
  models: readonly Model[],
): { scaleStrength: number; alignmentEquivalent: number; toolsEnabled: boolean } {
  const completed = new Set(completedPostTrainStages(job))
  const effectiveness = (stage: TrainablePostStage) => {
    const frozen = job.postTrainStageEffectiveness?.[stage]
    if (frozen != null) return clamp01(frozen)
    if (stage === job.postTrain || completed.has(stage)) {
      return postTrainStageEffectiveness({ job, stage, researchUnlocked, models })
    }
    return 0
  }
  const sft = effectiveness('sft')
  const rlhf = effectiveness('rlhf')
  const process = effectiveness('process')
  const tools = effectiveness('tools')
  return {
    scaleStrength: clamp01(sft * 0.18 + rlhf * 0.28 + process * 0.34 + tools * 0.2),
    alignmentEquivalent: Math.min(4, sft + rlhf * 1.45 + process * 1.85 + tools * 1.2),
    toolsEnabled: job.postTrain === 'tools' || completed.has('tools'),
  }
}

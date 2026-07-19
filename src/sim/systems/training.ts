import { aggregateEffects } from './research'
import type {
  BenchmarkScores,
  Model,
  PostTrainStage,
  QualityAxes,
  SimState,
  StartTrainingOpts,
  TrainingJob,
} from '../types'
import { computeSnapshot } from './compute'
import {
  normalizeDataQuality,
  postTrainStrength,
  scaleIntelligence,
  scoresFromScale,
} from '../balance/modelScaling'
import { getResearchNode } from '../balance/research'
import { attachModelToEmptyPlans } from './plans'
import { scheduleReleaseEvaluations } from './evaluations'
import { deriveModelCapabilities } from '../balance/modelCapabilities'
import {
  DATA_MIX_DEFS,
  clampDistillTeacherShare,
  distillFromTeacher,
  DISTILL_RETENTION,
  formatParams,
  sizeGate,
  suggestedApiPricePerMTok,
  trainCostPfDays,
  trainingVolumeMultiplier,
} from '../balance/training'
import {
  analyzeTrainingData,
  backboneFromFamily,
  ioForPreset,
  presetFromFamily,
  rollTrainingOutcome,
  serviceProfileForModel,
} from '../balance/trainingV3'
import { hashSeed, seededId } from '../rng'
import { suggestApiInOut } from '../balance/pricing'
import { DATA_DOMAIN_META, DATA_DOMAINS } from '../balance/data'
import { ECONOMY } from '../balance/economy'
import { modelTrainVramGb } from '../balance/racks'
import { fleetStats } from './racks'
import { modelCanCurateDataDomain } from './modelEligibility'
import type { DataMix, TrainingDataPlan } from '../types'
import {
  consumeForTraining,
  ensureLabData,
  formatMix,
  formatTokens,
  minDataMTokForParams,
  newDataSinceModel,
  recommendedDataMTok,
  specialistDomainBoost,
  totalProcessed,
} from './data'
import { lqSynthCapabilityMult, normalizeWeights } from '../balance/data'
import { createDataManifest } from './dataAssets'
import { modelStackModifiers, sanitizeModelStack } from '../balance/modelStack'

const POST_TRAIN_ORDER: PostTrainStage[] = ['none', 'sft', 'rlhf', 'process', 'tools']

function postTrainTarget(stage: PostTrainStage): number {
  switch (stage) {
    case 'sft':
      return 4
    case 'rlhf':
      return 8
    case 'process':
      return 10
    case 'tools':
      return 6
    default:
      return 0
  }
}

export function estimateTrainingCost(
  state: SimState,
  opts: Pick<StartTrainingOpts, 'paramsB' | 'family' | 'activeParamsB' | 'mode' | 'teacherId'>,
): number {
  const teacher = opts.teacherId
    ? state.player.models.find((m) => m.id === opts.teacherId)
    : undefined
  const mode = opts.mode === 'distill' ? 'distill' : 'pretrain'
  return trainCostPfDays({
    paramsB: opts.paramsB,
    family: opts.family,
    trainEfficiency: state.player.trainEfficiency,
    activeParamsB: opts.activeParamsB,
    mode,
    teacherParamsB: teacher?.paramsB,
  })
}

export function startTraining(state: SimState, opts: StartTrainingOpts): SimState {
  if (state.player.trainingJob) {
    return withAlert(state, 'warn', 'A training job is already running.')
  }

  const mode = opts.mode ?? 'pretrain'
  const dataMix: DataMix = opts.dataMix ?? 'web'
  let family = opts.family
  let backbone = opts.backbone ?? backboneFromFamily(family)
  let productPreset = opts.productPreset ?? presetFromFamily(family)
  let io = opts.io ?? ioForPreset(productPreset)
  let paramsB = opts.paramsB
  let activeParamsB = opts.activeParamsB
  let continueFromId: string | undefined
  let baseContinueCap = 0

  if (mode === 'continue') {
    if (!opts.continueFromId) {
      return withAlert(state, 'warn', 'Pick a model to continue training.')
    }
    const base = state.player.models.find((m) => m.id === opts.continueFromId)
    if (!base) return withAlert(state, 'warn', 'Base model not found.')
    family = base.family
    backbone = base.backbone ?? backboneFromFamily(base.family)
    productPreset = base.productPreset ?? presetFromFamily(base.family)
    io = base.io ?? ioForPreset(productPreset, base.capability)
    paramsB = base.paramsB
    activeParamsB = base.activeParamsB
    continueFromId = base.id
    baseContinueCap = base.capability
  }

  const modelStack = sanitizeModelStack(
    opts.modelStack ?? [],
    state.player.researchUnlocked,
    family,
  )
  const stackModifiers = modelStackModifiers(modelStack, family)

  if (family === 'diffusion' && !state.player.researchUnlocked.includes('mm_diff')) {
    return withAlert(state, 'warn', 'Unlock Latent Diffusion first.')
  }
  if (family === 'video' && !state.player.researchUnlocked.includes('mm_video')) {
    return withAlert(state, 'warn', 'Unlock Video Temporal Models first.')
  }
  if (family === 'omni' && !state.player.researchUnlocked.includes('mm_omni')) {
    return withAlert(state, 'warn', 'Unlock Omni Stack first.')
  }
  if (
    (productPreset === 'vision_language' || productPreset === 'audio') &&
    !state.player.researchUnlocked.includes('mm_vision')
  ) {
    return withAlert(state, 'warn', 'Unlock Vision Encoders before adding image or audio I/O.')
  }

  if (mode !== 'continue') {
    const gate = sizeGate(paramsB, family, state.player.researchUnlocked)
    if (!gate.ok) return withAlert(state, 'warn', gate.reason ?? 'Invalid size.')
  }

  // Dense is free at game start; other families need research unlocks
  // Family unlocks only (not size tiers) — size is free, limited by compute/time
  if (family === 'moe' && !state.player.researchUnlocked.includes('moe_basics')) {
    return withAlert(state, 'warn', 'Unlock Sparse Basics before MoE training.')
  }
  if (
    family === 'dense' &&
    !state.player.researchUnlocked.includes('dense_basics')
  ) {
    // Should not happen — dense_basics is starter unlock; allow train anyway
  }

  if (family === 'moe' && mode !== 'continue') {
    if (activeParamsB == null || activeParamsB <= 0) {
      return withAlert(state, 'warn', 'MoE needs active parameters (e.g. 8B active of 120B total).')
    }
    if (activeParamsB > paramsB) {
      return withAlert(state, 'warn', 'Active params cannot exceed total MoE size.')
    }
    if (activeParamsB < paramsB * 0.02) {
      return withAlert(state, 'warn', 'Active fraction too small (<2%). Raise active params.')
    }
  } else if (family !== 'moe') {
    activeParamsB = undefined
  }

  let teacherId: string | undefined
  /** Distill: share of signal from teacher (rest = your processed corpus). */
  let distillTeacherShare = 0
  if (mode === 'distill') {
    if (!opts.teacherId) {
      return withAlert(state, 'warn', 'Pick a teacher model for distillation.')
    }
    const teacher = state.player.models.find((m) => m.id === opts.teacherId)
    if (!teacher) return withAlert(state, 'warn', 'Teacher model not found.')
    if (paramsB > teacher.paramsB * 1.15) {
      return withAlert(
        state,
        'warn',
        'Student should not greatly exceed teacher size. Use a larger teacher or smaller student.',
      )
    }
    teacherId = teacher.id
    distillTeacherShare = clampDistillTeacherShare(opts.distillTeacherShare)
  }

  let target = estimateTrainingCost(state, {
    paramsB,
    family,
    activeParamsB,
    mode: mode === 'continue' ? 'pretrain' : mode,
    teacherId,
  })
  if (mode === 'continue') {
    target = Math.max(4, target * 0.22)
  }
  // More own-corpus distill → slightly more PF (you actually train on packs);
  // teacher-heavy distill stays cheap.
  if (mode === 'distill') {
    const selfShare = 1 - distillTeacherShare
    target *= 0.82 + selfShare * 0.45
  }

  // Consume processed corpus according to player's domain mix + volume.
  // Distill: only the *own-corpus* share is drawn from stocks; teacher signal is free.
  const selfDataShare = mode === 'distill' ? 1 - distillTeacherShare : 1
  const mixUnlocked = state.player.researchUnlocked.includes('data_mix')
  const specialistsUnlocked =
    state.player.researchUnlocked.includes('data_specialists') ||
    !!(aggregateEffects(state.player.researchUnlocked).unlockCorpusSpecialists)
  const minMTok = minDataMTokForParams(paramsB)
  const continueBaseModel =
    mode === 'continue' && continueFromId
      ? state.player.models.find((m) => m.id === continueFromId)
      : undefined
  const priorDataMTok = continueBaseModel?.dataTokensUsedMTok ?? 0
  const priorWatermark =
    continueBaseModel?.dataWatermarkMTok ?? priorDataMTok ?? 0
  const newSince = newDataSinceModel(state, continueBaseModel)

  const rawPlanTotal =
    opts.dataPlan?.totalMTok ??
    opts.dataPlan?.totalUnits ??
    (mode === 'continue'
      ? Math.max(1, newSince) // continue defaults to new data only
      : recommendedDataMTok(paramsB, family))

  // Volume is player-chosen (MTok). Pretrain reuses full corpus; continue uses new delta.
  const volumeMTok = Math.max(
    1,
    rawPlanTotal * (mode === 'distill' ? Math.max(0.15, selfDataShare) : 1),
  )
  void minMTok

  const dataPlan: TrainingDataPlan = {
    totalUnits: volumeMTok,
    totalMTok: volumeMTok,
    trainShare: opts.dataPlan?.trainShare ?? (mode === 'continue' ? 0.88 : 0.82),
    weights: mixUnlocked ? opts.dataPlan?.weights ?? {} : {},
    allowSynthetic: opts.dataPlan?.allowSynthetic ?? true,
    includeSynthHQ: opts.dataPlan?.includeSynthHQ ?? true,
    includeSynthLQ: opts.dataPlan?.includeSynthLQ ?? false,
    domainModels: specialistsUnlocked ? opts.dataPlan?.domainModels : undefined,
  }
  const consume = consumeForTraining(state, dataPlan, paramsB, family, dataMix, {
    mode: mode === 'continue' ? 'continue' : mode === 'distill' ? 'distill' : 'pretrain',
    priorWatermarkMTok: mode === 'continue' ? priorWatermark : undefined,
  })
  if (!consume.ok) {
    return withAlert(state, 'warn', consume.reason ?? 'Insufficient training data.')
  }

  const planWeights = normalizeWeights(consume.plan.weights)
  // Multimodal families need matching data
  if (family === 'diffusion' && planWeights.image < 0.15) {
    return withAlert(state, 'warn', 'Diffusion trains need ≥15% image data in the mix.')
  }
  if (family === 'video' && planWeights.video < 0.2) {
    return withAlert(state, 'warn', 'Video models need ≥20% video data in the mix.')
  }
  if (productPreset === 'vision_language' && planWeights.image < 0.1) {
    return withAlert(state, 'warn', 'Vision-language models need ≥10% image data in the mix.')
  }
  if (productPreset === 'audio' && planWeights.audio < 0.1) {
    return withAlert(state, 'warn', 'Audio models need ≥10% audio data in the mix.')
  }
  if (
    productPreset === 'omni' &&
    (planWeights.image < 0.08 || planWeights.audio < 0.08 || planWeights.video < 0.08)
  ) {
    return withAlert(
      state,
      'warn',
      'Omni training needs at least 8% each of image, audio, and video data.',
    )
  }

  const dataAnalysis = analyzeTrainingData({
    paramsB,
    family,
    backbone,
    productPreset,
    io,
    plan: { ...consume.plan, weights: planWeights },
    data: ensureLabData(state),
    actualMTok: consume.trainMTok + consume.verifyMTok,
    quality: consume.qualityUsed,
    lqShare: consume.synthLqShare,
  })
  // Base cost is normalized to the strong 6:1 text run. Actual volume and
  // media density now scale PF-days directly.
  target *= trainingVolumeMultiplier(dataAnalysis.effectiveDataRatio)
  target *= dataAnalysis.modalityComputeMult
  target *= stackModifiers.trainCostMult

  const needVram = modelTrainVramGb(paramsB, activeParamsB, family)
  const haveVram = fleetStats(state).vramGb

  const cashSunk =
    Math.floor(target * ECONOMY.trainUpfrontPerPfDay) + Math.floor(consume.cashCost)
  const cashBurnPerDay = Math.floor(
    ECONOMY.trainCashBurnPerPfDay * Math.sqrt(Math.max(1, paramsB)),
  )
  if (state.player.cash < cashSunk) {
    return withAlert(
      state,
      'warn',
      `Need $${(cashSunk / 1e6).toFixed(1)}M upfront (cluster + synthetic fill).`,
    )
  }

  const jobId = seededId('job', state.seed, state.day, state.player.models.length, opts.name, family)
  const manifestSnapshot = createDataManifest({
    data: consume.nextData,
    consumed: consume.consumed,
    totalMTok: consume.trainMTok + consume.verifyMTok,
    day: state.day,
    seed: state.seed,
    runId: jobId,
  })
  const job: TrainingJob = {
    id: jobId,
    name: opts.name,
    family,
    backbone,
    productPreset,
    io,
    targetParamsB: paramsB,
    activeParamsB,
    targetPfDays: target,
    progressPfDays: 0,
    postTrain: 'none',
    postTrainProgress: 0,
    postTrainTarget: 0,
    mode,
    teacherId,
    distillTeacherShare: mode === 'distill' ? distillTeacherShare : undefined,
    continueFromId,
    dataMix,
    dataPlan: {
      ...consume.plan,
      weights: planWeights,
      uniqueMTok: dataAnalysis.uniqueMTok,
      repeatedMTok: dataAnalysis.repeatedMTok,
    },
    dataConsumed: consume.consumed,
    dataCoverage: consume.coverage,
    dataQualityUsed: consume.qualityUsed,
    syntheticUnits: consume.syntheticUnits,
    synthLqShare: consume.synthLqShare ?? 0,
    trainShare: consume.plan.trainShare,
    trainMTok: consume.trainMTok,
    verifyMTok: consume.verifyMTok,
    priorDataMTok,
    cashBurnPerDay,
    cashSunk,
    outcomeSeed: hashSeed(state.seed, state.day, opts.name, paramsB, family, 'train-outcome'),
    outcomeRisk: dataAnalysis.risk,
    effectiveDataRatio: dataAnalysis.effectiveDataRatio,
    repeatedDataEpochs: dataAnalysis.repeatedEpochs,
    modalityComputeMult: dataAnalysis.modalityComputeMult,
    dataManifestId: manifestSnapshot.manifest.id,
    integratedMethods: [...state.player.researchUnlocked].sort(),
    modelStack,
  }

  void baseContinueCap

  const sizeLabel =
    family === 'moe'
      ? `${formatParams(paramsB)} total / ${formatParams(activeParamsB ?? 0)} active`
      : formatParams(paramsB)

  const vramNote =
    haveVram < needVram
      ? ` · VRAM tight (${haveVram.toFixed(0)}/${needVram.toFixed(0)} GB)`
      : ` · VRAM ${needVram.toFixed(0)} GB`

  const modeLabel =
    mode === 'distill' ? 'Distillation' : mode === 'continue' ? 'Continue-train' : 'Training'

  const mixLabel = formatMix(consume.plan.weights)
  const synthNote =
    consume.syntheticUnits > 0.5
      ? ` · +${formatTokens(consume.syntheticUnits)} synth fill`
      : ''
  const dataNote = ` · ${formatTokens(consume.trainMTok + consume.verifyMTok)} data (train ${Math.round(consume.plan.trainShare * 100)}%/verify ${Math.round((1 - consume.plan.trainShare) * 100)}%)`

  return {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash - cashSunk,
      data: manifestSnapshot.data,
      trainingJob: job,
    },
    alerts: [
      {
        id: `train-start-${job.id}`,
        day: state.day,
        severity: haveVram < needVram ? ('warn' as const) : ('info' as const),
        message: `${modeLabel}: ${opts.name} (${sizeLabel}${
          mode === 'distill'
            ? `, teacher ${Math.round(distillTeacherShare * 100)}% / own ${Math.round((1 - distillTeacherShare) * 100)}%`
            : ''
        }${
          mode === 'continue' && priorDataMTok > 0
            ? `, prior ${formatTokens(priorDataMTok)}`
            : ''
        }${dataNote} [${mixLabel}] Q${consume.qualityUsed.toFixed(0)}, ~${target.toFixed(0)} PF-d, $${(cashSunk / 1e6).toFixed(1)}M)${synthNote}${vramNote}`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

function withAlert(state: SimState, severity: 'info' | 'warn' | 'danger', message: string): SimState {
  return {
    ...state,
    alerts: [
      { id: `a-${state.day}-${message.slice(0, 16)}`, day: state.day, severity, message },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function advancePostTrain(state: SimState): SimState {
  const job = state.player.trainingJob
  if (!job) return state
  const idx = POST_TRAIN_ORDER.indexOf(job.postTrain)
  if (idx < 0 || idx >= POST_TRAIN_ORDER.length - 1) return state
  if (job.progressPfDays < job.targetPfDays) return state
  if (job.postTrain !== 'none' && job.postTrainProgress < job.postTrainTarget) return state

  const nextStage = POST_TRAIN_ORDER[idx + 1]!
  if (nextStage === 'rlhf' && !state.player.researchUnlocked.includes('align_rlhf')) {
    return withAlert(state, 'warn', 'Unlock RLHF Pipeline for preference training.')
  }
  if (nextStage === 'process' && !state.player.researchUnlocked.includes('align_process')) {
    return withAlert(state, 'warn', 'Unlock Process Reward Models first.')
  }

  return {
    ...state,
    player: {
      ...state.player,
      trainingJob: {
        ...job,
        postTrain: nextStage,
        postTrainProgress: 0,
        postTrainTarget: postTrainTarget(nextStage),
      },
    },
  }
}

/** Finish job → internal (private) model. Not on the market until released. */
export function keepInternal(state: SimState): SimState {
  return finalizeJob(state, 'internal')
}

/** Finish job and release publicly (plans/API eligible). */
export function releaseFromJob(state: SimState): SimState {
  return finalizeJob(state, 'released')
}

/** @deprecated use releaseFromJob / keepInternal */
export function shipModel(state: SimState): SimState {
  return releaseFromJob(state)
}

function finalizeJob(state: SimState, release: 'internal' | 'released'): SimState {
  const job = state.player.trainingJob
  if (!job || job.progressPfDays < job.targetPfDays) return state
  if (job.postTrain !== 'none' && job.postTrainProgress < job.postTrainTarget) {
    // allow finish mid post-train with partial quality
  }

  const model = buildModelFromJob(state, job, release)
  let models = [...state.player.models]
  let pricing = { ...state.player.pricing }

  // Continue-train replaces the base model in-place (keep per-model API list)
  if (job.mode === 'continue' && job.continueFromId) {
    const idx = models.findIndex((m) => m.id === job.continueFromId)
    if (idx >= 0) {
      const prev = models[idx]!
      models[idx] = {
        ...model,
        id: prev.id,
        release: release === 'released' ? 'released' : prev.release,
        shipped: release === 'released' ? true : prev.shipped,
        releaseDay: prev.releaseDay,
        apiPricePerMTok: prev.apiPricePerMTok ?? model.apiPricePerMTok,
        apiPriceInPerMTok: prev.apiPriceInPerMTok ?? model.apiPriceInPerMTok,
        apiPriceOutPerMTok: prev.apiPriceOutPerMTok ?? model.apiPriceOutPerMTok,
      }
    } else {
      models = [...models, model]
    }
  } else {
    models = [...models, model]
  }

  let brand = state.player.brandTrust
  if (release === 'released') {
    pricing = {
      ...pricing,
      activeModelId: pricing.activeModelId ?? model.id,
    }
    if (model.quality.reliability < 35 || model.capability < 25) {
      brand = Math.max(10, brand - 8)
    } else if (model.quality.reliability > 60 && model.capability > 40) {
      brand = Math.min(100, brand + 4)
    }
  }

  const newsLine =
    job.mode === 'continue'
      ? `Day ${state.day}: Continued ${model.name} → cap ${model.capability.toFixed(0)}`
      : release === 'released'
        ? `Day ${state.day}: Released ${model.name} (${formatParams(model.paramsB)}, cap ${model.capability.toFixed(0)})`
        : `Day ${state.day}: Internal checkpoint ${model.name} (${formatParams(model.paramsB)}) — private`
  const outcomeLine = model.outcome
    ? `${model.outcome.kind === 'breakthrough' ? 'Breakthrough' : model.outcome.kind === 'stumble' ? 'Training stumble' : 'Training result'}: ${(model.outcome.yieldMultiplier * 100).toFixed(1)}% optimization yield. ${model.outcome.explanation}`
    : ''

  let next: SimState = {
    ...state,
    player: {
      ...state.player,
      trainingJob: null,
      models,
      pricing,
      brandTrust: brand,
    },
    news: [outcomeLine ? `Day ${state.day}: ${model.name} — ${outcomeLine}` : '', newsLine, ...state.news]
      .filter(Boolean)
      .slice(0, 20),
    alerts: [
      {
        id: `done-${model.id}-${state.day}`,
        day: state.day,
        severity:
          release === 'released' && model.quality.reliability < 40
            ? ('warn' as const)
            : ('info' as const),
        message:
          job.mode === 'continue'
            ? `${model.name} continue-train complete (cap ${model.capability.toFixed(0)}).`
            : release === 'internal'
              ? `${model.name} kept internal. Use as distillation teacher or release later.`
              : model.quality.reliability < 40
                ? `Released ${model.name} — rough quality. Expect churn.`
                : `Released ${model.name}. ${outcomeLine} Set API price and assign to Plans.`,
      },
      ...state.alerts,
    ].slice(0, 40),
    onboardingStep: Math.max(state.onboardingStep, release === 'released' ? 2 : 1),
  }

  if (release === 'released' && job.mode !== 'continue') {
    next = attachModelToEmptyPlans(next, model.id)
    next = scheduleReleaseEvaluations(next, model.id)
  }
  return next
}

/** Release an existing internal model to the public product surface. */
export function releaseModel(state: SimState, modelId: string): SimState {
  const idx = state.player.models.findIndex((m) => m.id === modelId)
  if (idx < 0) return state
  const m = state.player.models[idx]!
  if (m.release === 'released') return withAlert(state, 'warn', 'Already released.')

  // Ensure public models carry own in/out list (don't silently share lab default)
  let listIn = m.apiPriceInPerMTok
  let listOut = m.apiPriceOutPerMTok
  let listBlend = m.apiPricePerMTok
  if (listIn == null || listOut == null) {
    listIn = m.suggestedApiPriceIn ?? m.costApiPriceIn
    listOut = m.suggestedApiPriceOut ?? m.costApiPriceOut
    listBlend = Math.round((listIn * 0.3 + listOut * 0.7) * 1000) / 1000
  }

  const models = state.player.models.slice()
  models[idx] = {
    ...m,
    release: 'released',
    shipped: true,
    releaseDay: state.day,
    apiPriceInPerMTok: listIn,
    apiPriceOutPerMTok: listOut,
    apiPricePerMTok: listBlend,
  }

  let brand = state.player.brandTrust
  if (m.quality.reliability < 35) brand = Math.max(10, brand - 5)
  else if (m.capability > 40) brand = Math.min(100, brand + 3)

  let next: SimState = {
    ...state,
    player: {
      ...state.player,
      models,
      brandTrust: brand,
      pricing: {
        ...state.player.pricing,
        activeModelId: state.player.pricing.activeModelId ?? m.id,
      },
    },
    news: [`Day ${state.day}: Released ${m.name} to market.`, ...state.news].slice(0, 20),
    alerts: [
      {
        id: `rel-${m.id}`,
        day: state.day,
        severity: 'info' as const,
        message: `${m.name} is public. Set per-model API price and plan access.`,
      },
      ...state.alerts,
    ].slice(0, 40),
    onboardingStep: Math.max(state.onboardingStep, 2),
  }
  next = attachModelToEmptyPlans(next, m.id)
  next = scheduleReleaseEvaluations(next, m.id)
  return next
}

/** Delete a model checkpoint (cannot delete while training job targets it). */
export function deleteModel(state: SimState, modelId: string): SimState {
  const m = state.player.models.find((x) => x.id === modelId)
  if (!m) return withAlert(state, 'warn', 'Model not found.')
  const job = state.player.trainingJob
  if (
    job &&
    (job.continueFromId === modelId ||
      job.teacherId === modelId ||
      job.dataPlan?.domainModels &&
        Object.values(job.dataPlan.domainModels).includes(modelId))
  ) {
    return withAlert(state, 'warn', 'Cannot delete — in use by the active training job.')
  }

  const models = state.player.models.filter((x) => x.id !== modelId)
  let pricing = { ...state.player.pricing }
  if (pricing.activeModelId === modelId) {
    const nextActive =
      models.find((x) => x.release === 'released' || x.shipped)?.id ??
      models[0]?.id ??
      null
    pricing = { ...pricing, activeModelId: nextActive }
  }
  // Strip from plans
  const plans = pricing.plans.map((p) => ({
    ...p,
    modelIds: p.modelIds.filter((id) => id !== modelId),
  }))
  pricing = {
    ...pricing,
    apiModelIds: pricing.apiModelIds?.filter((id) => id !== modelId),
    apiServePrecisionByModel: Object.fromEntries(
      Object.entries(pricing.apiServePrecisionByModel ?? {}).filter(([id]) => id !== modelId),
    ),
    plans,
  }

  return {
    ...state,
    player: {
      ...state.player,
      models,
      pricing,
    },
    alerts: [
      {
        id: `del-model-${modelId}-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message: `Deleted model ${m.name}.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function setModelApiPrice(
  state: SimState,
  modelId: string,
  price: number | null,
): SimState {
  // Blended single price → split into in/out using same mix as global defaults
  const models = state.player.models.map((m) => {
    if (m.id !== modelId) return m
    if (price === null) {
      return { ...m, apiPricePerMTok: null, apiPriceInPerMTok: null, apiPriceOutPerMTok: null }
    }
    const p = Math.max(0, price)
    return {
      ...m,
      apiPricePerMTok: p,
      apiPriceInPerMTok: Math.round(p * 0.35 * 1000) / 1000,
      apiPriceOutPerMTok: Math.round(p * 1.25 * 1000) / 1000,
    }
  })
  return { ...state, player: { ...state.player, models } }
}

export function setModelApiInOut(
  state: SimState,
  modelId: string,
  priceIn: number | null,
  priceOut: number | null,
): SimState {
  const models = state.player.models.map((m) => {
    if (m.id !== modelId) return m
    if (priceIn === null && priceOut === null) {
      return { ...m, apiPriceInPerMTok: null, apiPriceOutPerMTok: null, apiPricePerMTok: null }
    }
    const pin = Math.max(0, priceIn ?? m.apiPriceInPerMTok ?? m.costApiPriceIn)
    const pout = Math.max(0, priceOut ?? m.apiPriceOutPerMTok ?? m.costApiPriceOut)
    return {
      ...m,
      apiPriceInPerMTok: pin,
      apiPriceOutPerMTok: pout,
      apiPricePerMTok: Math.round((pin * 0.3 + pout * 0.7) * 1000) / 1000,
    }
  })
  return { ...state, player: { ...state.player, models } }
}

/** Apply markup % to model cost floors → list prices. */
export function applyModelApiMarkup(
  state: SimState,
  modelId: string,
  markupPct: number,
): SimState {
  const m = state.player.models.find((x) => x.id === modelId)
  if (!m) return state
  const mult = 1 + Math.max(0, markupPct) / 100
  const pin = Math.round(m.costApiPriceIn * mult * 1000) / 1000
  const pout = Math.round(m.costApiPriceOut * mult * 1000) / 1000
  return setModelApiInOut(state, modelId, pin, pout)
}

function buildModelFromJob(
  state: SimState,
  job: TrainingJob,
  release: 'internal' | 'released',
): Model {
  const effects = aggregateEffects(state.player.researchUnlocked)
  const family = job.family
  const stackModifiers = modelStackModifiers(job.modelStack ?? [], family)
  const paramsB = job.targetParamsB
  const activeParamsB = family === 'moe' ? job.activeParamsB ?? paramsB * 0.1 : undefined
  const teacher = job.teacherId
    ? state.player.models.find((m) => m.id === job.teacherId)
    : undefined
  const continueBase = job.continueFromId
    ? state.player.models.find((m) => m.id === job.continueFromId)
    : undefined
  const legacyMix = DATA_MIX_DEFS[job.dataMix ?? 'web']
  // Domain recipe effects
  const weights = job.dataPlan?.weights ?? {}
  let domainCap = 0
  let domainCoding = 0
  let domainMath = 0
  let domainScience = 0
  let domainChat = 0
  let domainSafety = 0
  let domainLaw = 0
  let domainHealth = 0
  let domainVision = 0
  let domainVideo = 0
  let domainAudio = 0
  for (const d of DATA_DOMAINS) {
    const w = weights[d] ?? 0
    if (w <= 0) continue
    const m = DATA_DOMAIN_META[d]
    domainCap += m.capability * w
    domainCoding += m.coding * w
    domainMath += m.math * w
    domainScience += m.science * w
    domainChat += m.chat * w
    domainSafety += m.safety * w
    domainLaw += m.law * w
    domainHealth += m.health * w
    domainVision += m.vision * w
    domainVideo += m.video * w
    domainAudio += m.audio * w
  }
  const coverage = job.dataCoverage ?? 1
  const dataQ = (job.dataQualityUsed ?? 50) / 100
  const mix = {
    capability: domainCap + legacyMix.capability * 0.15,
    coding: domainCoding + legacyMix.coding * 0.2,
    chat: domainChat + legacyMix.chat * 0.2,
    safety: domainSafety + legacyMix.safety * 0.2,
    math: domainMath + legacyMix.math * 0.15,
    science: domainScience,
  }

  // ── Shared scale formula: params × data volume × quality × mix ──
  const dataQualityNorm = normalizeDataQuality({
    labDataQuality: state.player.dataQuality,
    jobQualityUsed: job.dataQualityUsed,
  })
  const researchMult =
    1 +
    Math.min(0.12, (effects.capabilityBonus ?? 0) * 0.015) +
    (family === 'moe' && state.player.researchUnlocked.includes('moe_hier') ? 0.04 : 0)
  const trainComplete = Math.min(
    1,
    job.progressPfDays / Math.max(1, job.targetPfDays),
  )

  let scale = scaleIntelligence({
    paramsB,
    activeParamsB,
    family,
    dataCoverage: coverage,
    dataQuality: dataQualityNorm,
    mixWeights: weights,
    researchMult:
      family === 'moe' && !state.player.researchUnlocked.includes('moe_routing')
        ? researchMult * 0.55
        : researchMult,
    trainComplete,
    postTrainStrength: postTrainStrength(job.postTrain),
  })

  let capability = scale.capability + mix.capability * 0.35

  // Continue-train: modest lift from prior, still gated by size×data scale
  if (job.mode === 'continue' && continueBase) {
    const lift =
      1.2 +
      trainComplete * 2.5 +
      mix.capability * 0.35 +
      (coverage - 0.5) * 1.5
    const maxLift = Math.max(2, scale.capability * 0.12)
    capability = clamp(
      Math.min(scale.capability + 2, continueBase.capability + Math.min(maxLift, lift)),
    )
  }

  const postIdx = POST_TRAIN_ORDER.indexOf(job.postTrain)
  const rlhfMult = 1 + (effects.rlhfQuality ?? 0)
  const safetyBase =
    14 + scale.intelligence * 35 + (effects.safetyBonus ?? 0) * 2 + postIdx * 6 * rlhfMult + mix.safety
  const reliabilityBase =
    18 + scale.intelligence * 40 + postIdx * 9 * rlhfMult + (effects.safetyBonus ?? 0)
  let chat = Math.min(100, capability * 0.88 + postIdx * 4 + mix.chat)
  let coding = Math.min(
    100,
    capability * 0.9 +
      (state.player.researchUnlocked.includes('moe_special') ? 4 : 0) +
      mix.coding * 0.7,
  )
  let reasoning = Math.min(
    100,
    capability * 0.95 + (postIdx >= 3 ? 4 : 0) + mix.math * 0.34 + mix.science * 0.18,
  )

  const quality: QualityAxes = {
    reasoning: clamp(reasoning),
    coding: clamp(coding),
    chat: clamp(chat),
    image: clamp(
      (family === 'diffusion' || family === 'omni' ? capability * 0.75 : 5) + domainVision * 0.5,
    ),
    video: clamp(
      (family === 'video' || family === 'omni' ? capability * 0.65 : domainVideo * 0.35) +
        domainVideo * 0.4,
    ),
    safety: clamp(safetyBase + domainLaw * 0.12 + domainHealth * 0.1),
    reliability: clamp(reliabilityBase + dataQ * 6),
  }

  if (job.mode === 'continue' && continueBase) {
    quality.reasoning = clamp(continueBase.quality.reasoning + mix.math * 0.35 + 1.5)
    quality.coding = clamp(continueBase.quality.coding + mix.coding * 0.4 + 1)
    quality.chat = clamp(continueBase.quality.chat + mix.chat * 0.35 + 0.8)
    quality.safety = clamp(continueBase.quality.safety + mix.safety * 0.25)
    quality.reliability = clamp(continueBase.quality.reliability + 1.5)
    quality.image = continueBase.quality.image
    quality.video = continueBase.quality.video
  }

  if (job.postTrain === 'none' && job.mode !== 'continue') {
    quality.reliability = Math.min(quality.reliability, 26)
    quality.safety = Math.min(quality.safety, 20)
    quality.chat = quality.chat * 0.75
  }

  // Distill path: blend your corpus (self scale) with teacher signal.
  // High teacher share → ~80% of teacher (DISTILL_RETENTION). High own data → more self scale.
  const distillTeacherShare =
    job.mode === 'distill' ? clampDistillTeacherShare(job.distillTeacherShare) : 0
  const distillSelfShare = 1 - distillTeacherShare
  if (job.mode === 'distill' && teacher) {
    const d = distillFromTeacher({
      teacherCapability: teacher.capability,
      teacherBenchmarks: teacher.benchmarks,
      studentScaleCap: Math.max(scale.capability, teacher.capability * 0.75),
      targetRetention: DISTILL_RETENTION,
    })
    // Self branch: size × your processed data only
    const selfCap = scale.capability + mix.capability * 0.35
    // Teacher branch: classic ~80% retention (slightly soft-capped under teacher)
    const teacherCap = Math.min(teacher.capability * 0.9, d.capability)
    capability = clamp(selfCap * distillSelfShare + teacherCap * distillTeacherShare)
    quality.safety = clamp(
      teacher.quality.safety * 0.75 * distillTeacherShare +
        quality.safety * distillSelfShare +
        mix.safety * 0.12,
    )
    quality.reliability = clamp(
      teacher.quality.reliability * 0.75 * distillTeacherShare +
        quality.reliability * distillSelfShare,
    )
    quality.reasoning = clamp(
      capability * 0.95 * distillTeacherShare +
        quality.reasoning * distillSelfShare +
        mix.math * 0.15,
    )
    quality.coding = clamp(
      capability * 0.9 * distillTeacherShare +
        quality.coding * distillSelfShare +
        mix.coding * 0.25,
    )
    quality.chat = clamp(
      capability * 0.85 * distillTeacherShare +
        quality.chat * distillSelfShare +
        mix.chat * 0.2,
    )
  }

  let inferCostMult = 1
  let tokPerSecMult = 0.7
  if (family === 'moe') {
    inferCostMult = (effects.moeInferMult as number | undefined) ?? 1.1
    // active size drives serve cost
    const active = activeParamsB ?? paramsB * 0.1
    inferCostMult *= Math.pow(active / Math.max(paramsB * 0.08, 0.1), 0.3)
    tokPerSecMult = 0.85 * Math.pow(7 / Math.max(active, 0.5), 0.15)
    if (!state.player.researchUnlocked.includes('moe_serve')) {
      tokPerSecMult *= 0.55
    }
  } else if (family === 'dense') {
    inferCostMult = (effects.denseInferMult as number | undefined) ?? 1
    tokPerSecMult = 0.75 * Math.pow(7 / Math.max(paramsB, 0.5), 0.12)
  } else if (family === 'video') {
    inferCostMult = 2.5
    tokPerSecMult = 0.25
  } else if (family === 'diffusion') {
    inferCostMult = 1.4
    tokPerSecMult = 0.4
  }

  // Large dense models slower / costlier to serve
  if (family !== 'moe' && paramsB > 70) {
    inferCostMult *= 1 + Math.log10(paramsB / 70) * 0.35
    tokPerSecMult *= 1 / (1 + Math.log10(paramsB / 70) * 0.4)
  }
  inferCostMult *= stackModifiers.hostingMult
  tokPerSecMult *= stackModifiers.speedMult

  const jobIo = job.io ?? ioForPreset(job.productPreset ?? presetFromFamily(family))
  const modalities: Model['modalities'] = []
  for (const modality of ['text', 'image', 'audio', 'video'] as const) {
    if ((jobIo.inputs[modality] ?? 0) > 0 || (jobIo.outputs[modality] ?? 0) > 0) {
      modalities.push(modality)
    }
  }
  if (jobIo.tools > 0) modalities.push('tools')
  if (modalities.length === 0) modalities.push('text')

  // Research extras (small — cannot max small models)
  const extras: Partial<BenchmarkScores> = {}
  for (const id of state.player.researchUnlocked) {
    const b = getResearchNode(id).effects.benchmarkBoost
    if (!b) continue
    for (const [k, v] of Object.entries(b) as [keyof BenchmarkScores, number][]) {
      extras[k] = (extras[k] ?? 0) + Math.min(4, v * 0.45)
    }
  }
  // Domain mix extras (specialty, not free general scale)
  extras.coding = (extras.coding ?? 0) + Math.min(5, domainCoding * 0.35 + mix.coding * 0.25)
  extras.math = (extras.math ?? 0) + Math.min(6, domainMath * 0.42 + mix.math * 0.18)
  extras.science = (extras.science ?? 0) + Math.min(6, domainScience * 0.42 + domainMath * 0.08)
  extras.mmlu = (extras.mmlu ?? 0) + Math.min(3, mix.capability * 0.2 + domainChat * 0.08)
  extras.safety = (extras.safety ?? 0) + Math.min(4, mix.safety * 0.25)
  extras.law = (extras.law ?? 0) + Math.min(6, domainLaw * 0.4)
  extras.health = (extras.health ?? 0) + Math.min(6, domainHealth * 0.4)
  extras.vision = (extras.vision ?? 0) + Math.min(6, domainVision * 0.4)
  extras.agents =
    (extras.agents ?? 0) + Math.min(4, domainCoding * 0.12 + domainChat * 0.1)

  // Specialist curators: extra domain eval lift (research-gated)
  const spec = job.dataPlan?.domainModels
  if (spec && state.player.researchUnlocked.includes('data_specialists')) {
    for (const d of DATA_DOMAINS) {
      const mid = spec[d]
      if (!mid) continue
      const m = state.player.models.find((x) => x.id === mid)
      if (!m || !modelCanCurateDataDomain(m, d)) continue
      const boost = specialistDomainBoost(m, d) / 22 // 0–1
      if (d === 'code') {
        extras.coding = (extras.coding ?? 0) + Math.min(4, boost * 5)
        extras.agents = (extras.agents ?? 0) + Math.min(2, boost * 2)
      }
      if (d === 'math') extras.math = (extras.math ?? 0) + Math.min(5, boost * 6)
      if (d === 'science') extras.science = (extras.science ?? 0) + Math.min(5, boost * 6)
      if (d === 'law') extras.law = (extras.law ?? 0) + Math.min(5, boost * 6)
      if (d === 'health') extras.health = (extras.health ?? 0) + Math.min(5, boost * 6)
      if (d === 'chat') extras.mmlu = (extras.mmlu ?? 0) + Math.min(2.5, boost * 3)
      if (d === 'image' || d === 'video')
        extras.vision = (extras.vision ?? 0) + Math.min(4, boost * 5)
    }
  }

  // Recompute scale at final capability-influencing state for benches
  scale = scaleIntelligence({
    paramsB,
    activeParamsB,
    family,
    dataCoverage: coverage,
    dataQuality: dataQualityNorm,
    mixWeights: weights,
    researchMult:
      family === 'moe' && !state.player.researchUnlocked.includes('moe_routing')
        ? researchMult * 0.55
        : researchMult,
    trainComplete,
    postTrainStrength: postTrainStrength(job.postTrain),
  })

  let benchmarks = scoresFromScale({
    scale,
    quality,
    family,
    unlocked: state.player.researchUnlocked,
    postTrain: job.postTrain,
    extras,
  })

  // Keep capability consistent with scale (domain mix only mild nudge)
  if (job.mode !== 'distill' && job.mode !== 'continue') {
    capability = clamp(scale.capability + mix.capability * 0.35)
  }

  // Low-quality synthetic pollution — same rule as rivals (shared scale path)
  const lqShare = job.synthLqShare ?? 0
  if (lqShare > 0.02) {
    const mult = lqSynthCapabilityMult(lqShare)
    capability = clamp(capability * mult)
    quality.reliability = clamp(quality.reliability * (1 - lqShare * 0.25))
    quality.safety = clamp(quality.safety * (1 - lqShare * 0.2))
    for (const k of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      benchmarks = { ...benchmarks, [k]: clamp(benchmarks[k]! * (1 - lqShare * 0.15)) }
    }
  }

  if (stackModifiers.capabilityBonus > 0) {
    const bonus = stackModifiers.capabilityBonus
    capability = clamp(capability + bonus)
    quality.reasoning = clamp(quality.reasoning + bonus * 0.9)
    quality.coding = clamp(quality.coding + bonus * 0.8)
    quality.chat = clamp(quality.chat + bonus * 0.5)
    for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      benchmarks = { ...benchmarks, [key]: clamp(benchmarks[key]! + bonus * 0.55) }
    }
  }

  // Train vs verify split: more train → smarter; more verify → safer/reliable
  const trainShare = job.trainShare ?? 0.82
  const verifyShare = 1 - trainShare
  const dataVol = Math.max(0.01, (job.trainMTok ?? 0) + (job.verifyMTok ?? 0))
  if (job.mode === 'continue') {
    // Continue: no 1:1 requirement — new tokens give soft lift
    const soft = Math.min(1.4, Math.log10(1 + dataVol / 50) / 2)
    capability = clamp(capability + soft * trainShare * 4 + soft * 1.5)
    quality.safety = clamp(quality.safety + soft * verifyShare * 6)
    quality.reliability = clamp(quality.reliability + soft * verifyShare * 5 + soft * 2)
    quality.reasoning = clamp(quality.reasoning + soft * trainShare * 3)
    quality.coding = clamp(quality.coding + soft * trainShare * 2.5)
  } else {
    const minNeed = minDataMTokForParams(paramsB)
    const volRatio = Math.min(2, dataVol / Math.max(1, minNeed))
    const overData = Math.max(0, volRatio - 1)
    capability = clamp(
      capability * (0.92 + trainShare * 0.1 + overData * trainShare * 0.06),
    )
    quality.safety = clamp(quality.safety + verifyShare * 12 + overData * verifyShare * 8)
    quality.reliability = clamp(
      quality.reliability + verifyShare * 10 + overData * verifyShare * 6,
    )
    quality.reasoning = clamp(quality.reasoning + trainShare * overData * 4)
    quality.coding = clamp(quality.coding + trainShare * overData * 3)
  }

  if (job.mode === 'distill' && teacher) {
    const d = distillFromTeacher({
      teacherCapability: teacher.capability,
      teacherBenchmarks: teacher.benchmarks,
      studentScaleCap: Math.max(scale.capability, teacher.capability * 0.75),
      targetRetention: DISTILL_RETENTION,
    })
    const tShare = distillTeacherShare
    const sShare = distillSelfShare
    for (const k of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      const fromTeacher = d.benchmarks[k]
      const fromSelf = benchmarks[k]
      const teacherV =
        fromTeacher != null
          ? Math.min((teacher.benchmarks[k] ?? fromTeacher) * 0.88, fromTeacher)
          : fromSelf
      // Blend: teacher-heavy → near 80% teacher benches; corpus-heavy → your scale benches
      benchmarks = {
        ...benchmarks,
        [k]: clamp(fromSelf * sShare + teacherV * tShare),
      }
    }
  }

  const outcome = rollTrainingOutcome({
    seed: job.outcomeSeed ?? hashSeed(state.seed, job.id, 'train-outcome'),
    quality: job.dataQualityUsed,
    verifyShare: 1 - (job.trainShare ?? 0.82),
    engineers: state.player.staff?.engineer ?? 0,
    researchCount: state.player.researchUnlocked.length,
    day: state.day,
    breakthroughBias: effects.trainingBreakthroughBias,
    stumbleRisk: effects.trainingStumbleRisk,
  })
  capability = clamp(capability + outcome.capabilityDelta)
  quality.reliability = clamp(quality.reliability + outcome.reliabilityDelta)
  quality.safety = clamp(
    quality.safety +
      Math.min(2, outcome.reliabilityDelta * 0.25) -
      (effects.trainingSafetyPenalty ?? 0),
  )
  for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
    benchmarks = {
      ...benchmarks,
      [key]: clamp(benchmarks[key]! + outcome.capabilityDelta * 0.45),
    }
  }

  const apiSug = suggestApiInOut({
    costPerMTokBase: 0.28,
    paramsB,
    activeParamsB,
    family,
    inferCostMult,
    capability,
    markupPct: state.player.pricing.apiMarkupPct ?? 120,
  })
  const suggested = suggestedApiPricePerMTok({
    paramsB,
    activeParamsB,
    family,
    inferCostMult,
    capability,
    costPerMTokBase: 0.28,
  })

  const continueCompute =
    (continueBase?.continueCompute ?? 0) +
    (job.mode === 'continue' ? job.progressPfDays : 0)

  // Each model owns its own in/out list prices ($/MTok). Continue keeps prior
  // list; new weights seed from size/capability-based suggestions so models
  // don't all share the lab-wide default.
  const listIn =
    continueBase?.apiPriceInPerMTok ?? apiSug.priceIn
  const listOut =
    continueBase?.apiPriceOutPerMTok ?? apiSug.priceOut
  const listBlend =
    continueBase?.apiPricePerMTok ??
    Math.round((listIn * 0.3 + listOut * 0.7) * 1000) / 1000

  const productPreset = job.productPreset ?? presetFromFamily(family)
  const serviceProfile = serviceProfileForModel({
    paramsB,
    activeParamsB,
    family,
    tokPerSecMult,
    capability,
  })
  const capabilities = deriveModelCapabilities({
    finalCapability: capability,
    trainComputePfDays: job.progressPfDays,
    effectiveDataRatio: job.effectiveDataRatio ?? job.dataCoverage ?? 0,
    dataQuality: job.dataQualityUsed ?? state.player.dataQuality,
    domainWeights: weights,
    io: jobIo,
    family,
    postTrain: job.postTrain,
    quality,
  })

  return {
    id:
      job.mode === 'continue' && continueBase
        ? continueBase.id
        : `model-${state.day}-${job.id}`,
    name: job.name,
    family,
    paramsB,
    activeParamsB,
    backbone: job.backbone ?? backboneFromFamily(family),
    productPreset,
    io: job.io
      ? {
          inputs: Object.fromEntries(
            Object.keys(job.io.inputs).map((key) => [key, capability]),
          ),
          outputs: Object.fromEntries(
            Object.keys(job.io.outputs).map((key) => [key, capability]),
          ),
          tools: job.io.tools > 0 ? capability * 0.7 : 0,
        }
      : ioForPreset(productPreset, capability),
    capability,
    capabilities,
    modalities,
    quality,
    benchmarks,
    postTrain: job.postTrain,
    trainComputeSpent:
      (continueBase?.trainComputeSpent ?? 0) + job.progressPfDays,
    releaseDay: continueBase?.releaseDay ?? state.day,
    shipped: release === 'released' || continueBase?.shipped === true,
    release:
      release === 'released'
        ? 'released'
        : continueBase?.release ?? release,
    tokPerSecMult,
    inferCostMult,
    serviceProfile,
    apiPricePerMTok: listBlend,
    apiPriceInPerMTok: listIn,
    apiPriceOutPerMTok: listOut,
    suggestedApiPrice: suggested,
    suggestedApiPriceIn: apiSug.priceIn,
    suggestedApiPriceOut: apiSug.priceOut,
    costApiPriceIn: apiSug.costIn,
    costApiPriceOut: apiSug.costOut,
    distilled: job.mode === 'distill' || !!continueBase?.distilled,
    teacherId: job.teacherId ?? continueBase?.teacherId,
    distillTeacherShare:
      job.mode === 'distill'
        ? distillTeacherShare
        : continueBase?.distillTeacherShare,
    trainMode: job.mode,
    dataMix: job.dataMix,
    dataPlan: job.dataPlan,
    dataConsumed: job.dataConsumed,
    dataCoverage: job.dataCoverage,
    dataQualityUsed: job.dataQualityUsed,
    dataTokensUsedMTok:
      (continueBase?.dataTokensUsedMTok ?? 0) +
      (job.trainMTok ?? 0) +
      (job.verifyMTok ?? 0),
    // Watermark at lab corpus size so continue only uses data collected after this train
    dataWatermarkMTok: totalProcessed(ensureLabData(state)),
    dataTrainMTok: job.trainMTok,
    dataVerifyMTok: job.verifyMTok,
    continueCompute,
    effectiveDataRatio: job.effectiveDataRatio ?? job.dataCoverage,
    repeatedDataEpochs: job.repeatedDataEpochs ?? 1,
    outcome,
    openWeights: false,
    dataManifestId: job.dataManifestId ?? continueBase?.dataManifestId,
    integratedMethods: job.integratedMethods ?? continueBase?.integratedMethods ?? [],
    modelStack: job.modelStack ?? continueBase?.modelStack ?? [],
  }
}

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n))
}

export function tickTraining(state: SimState): SimState {
  const job = state.player.trainingJob
  if (!job) return state

  const snap = computeSnapshot(state)
  const trainPool = snap.pools.training
  const burn = job.cashBurnPerDay ?? 0
  let cash = state.player.cash - burn
  if (cash < 0) {
    // Job stalls without cash — no progress, still opex
    return {
      ...state,
      player: { ...state.player, cash: Math.max(-5_000_000, cash) },
      alerts: [
        {
          id: `train-cash-${state.day}`,
          day: state.day,
          severity: 'danger' as const,
          message: 'Training stalled — payroll/cluster burn exceeded cash. Raise capital or pause job.',
        },
        ...state.alerts.filter((a) => !a.id.startsWith('train-cash-')),
      ].slice(0, 40),
    }
  }

  if (job.progressPfDays < job.targetPfDays) {
    // trainPool already includes trainEfficiency, allocation, power derate, leased PF
    const step = Math.max(0, trainPool)
    return {
      ...state,
      player: {
        ...state.player,
        cash,
        trainingJob: {
          ...job,
          progressPfDays: Math.min(job.targetPfDays, job.progressPfDays + step),
        },
      },
    }
  }

  if (job.postTrain !== 'none' && job.postTrainProgress < job.postTrainTarget) {
    const postPool = snap.pools.inference * 0.35 + trainPool * 0.25
    const scale = 1 + Math.log10(Math.max(1, job.targetParamsB)) * 0.25
    return {
      ...state,
      player: {
        ...state.player,
        cash,
        trainingJob: {
          ...job,
          postTrainProgress: Math.min(
            job.postTrainTarget,
            job.postTrainProgress + (postPool * 0.15) / scale,
          ),
        },
      },
    }
  }

  return {
    ...state,
    player: { ...state.player, cash },
  }
}

export { formatParams, trainCostPfDays }

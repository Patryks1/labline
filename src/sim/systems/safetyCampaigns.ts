import type { Model, SafetyCampaignIntensity, SimState } from '../types'
import { normalizeModelEvaluations } from '../balance/evaluationSuites'
import { computeSnapshot } from './compute'
import { playerTrainingResourcePlan } from './training'
import { playerStaff } from './staff'
import { availableHqStaff } from './staffReservations'
import { dataResearchReservationShare, reservedGymResearchShare } from './data'
import { createRng, hashSeed, seededId } from '../rng'
import { chargeExpense } from './financeLedger'

// V4-DELETE: safety campaigns fold into the preference stage's safetyFocus (WS-C).
const INTENSITY_MULT: Record<SafetyCampaignIntensity, number> = {
  targeted: 1,
  standard: 2,
  frontier: 4,
}

function withAlert(
  state: SimState,
  severity: 'info' | 'warn' | 'danger',
  message: string,
): SimState {
  return {
    ...state,
    alerts: [
      { id: `safety-${state.day}-${message.slice(0, 18)}`, day: state.day, severity, message },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function safetyCampaignEstimate(
  state: SimState,
  modelId: string,
  intensity: SafetyCampaignIntensity,
): {
  ok: boolean
  reason?: string
  minimumResearchers: number
  trainingPfDays: number
  researchPfDays: number
  cashBudget: number
  safetyDataMTok: number
  safetyDataQuality: number
} {
  const model = state.player.models.find((candidate) => candidate.id === modelId)
  if (!model) {
    return {
      ok: false,
      reason: 'Model not found.',
      minimumResearchers: 1,
      trainingPfDays: 0,
      researchPfDays: 0,
      cashBudget: 0,
      safetyDataMTok: 0,
      safetyDataQuality: 0,
    }
  }
  const mult = INTENSITY_MULT[intensity]
  // Monotonic scale with total params and prior data volume.
  const paramsB = Math.max(0.01, model.paramsB)
  const dataMTok = Math.max(1, model.dataTokensUsedMTok ?? model.dataTrainMTok ?? 1)
  const scale = Math.log10(paramsB + 1) + Math.log10(dataMTok + 10) * 0.35
  const totalPfDays = (6 + scale * 7) * mult
  const minimumResearchers = Math.max(1, Math.ceil(scale * 5 + paramsB * 0.02))
  const qualityInputs = ['chat', 'law', 'health'] as const
  const qualityValues = qualityInputs.map(
    (domain) => model.dataQualityByDomain?.[domain] ?? model.dataQualityUsed ?? 50,
  )
  const safetyDataQuality = qualityValues.reduce((sum, value) => sum + value, 0) / qualityValues.length
  const safetyDataMTok =
    (model.dataVerifyMTok ?? 0) + mult * Math.max(5, Math.log10(model.paramsB * 1000 + 10) * 20)
  const cashBudget = Math.round(totalPfDays * 95_000 + safetyDataMTok * 160 + paramsB * 25_000)
  const researchers = availableHqStaff(state).researchers
  const reservedResearchShare =
    dataResearchReservationShare(state.player.data) +
    reservedGymResearchShare(state)
  const reason =
    !state.player.researchUnlocked.includes('align_rlhf')
      ? 'Unlock RLHF Pipeline first.'
      : state.player.safetyCampaign
          ? 'A safety campaign is already running.'
          : researchers < minimumResearchers
            ? `Needs ${minimumResearchers} researchers (have ${researchers}).`
            : reservedResearchShare > 0.45 + 1e-9
              ? 'Needs 40% research compute; reduce synthetic-data or gym reservations first.'
            : state.player.cash < cashBudget
              ? `Needs $${(cashBudget / 1_000_000).toFixed(2)}M cash.`
              : undefined
  return {
    ok: !reason,
    reason,
    minimumResearchers,
    trainingPfDays: totalPfDays * 0.6,
    researchPfDays: totalPfDays * 0.4,
    cashBudget,
    safetyDataMTok,
    safetyDataQuality,
  }
}

export function startSafetyCampaign(
  state: SimState,
  opts: { modelId: string; intensity: SafetyCampaignIntensity; researchers: number },
): SimState {
  const model = state.player.models.find((candidate) => candidate.id === opts.modelId)
  const estimate = safetyCampaignEstimate(state, opts.modelId, opts.intensity)
  if (!model || !estimate.ok) return withAlert(state, 'warn', estimate.reason ?? 'Cannot start safety campaign.')
  const availableResearchers = availableHqStaff(state).researchers
  const assignedResearchers = Math.max(
    estimate.minimumResearchers,
    Math.min(availableResearchers, Math.floor(opts.researchers)),
  )
  const id = seededId('safe', state.seed, state.day, model.id, opts.intensity, model.revision ?? 1)
  const charged = chargeExpense(state, estimate.cashBudget, 'training')
  return {
    ...charged,
    player: {
      ...charged.player,
      safetyCampaign: {
        id,
        modelId: model.id,
        modelName: model.name,
        intensity: opts.intensity,
        assignedResearchers,
        minimumResearchers: estimate.minimumResearchers,
        targetTrainingPfDays: estimate.trainingPfDays,
        targetResearchPfDays: estimate.researchPfDays,
        progressTrainingPfDays: 0,
        progressResearchPfDays: 0,
        cashBudget: estimate.cashBudget,
        cashSpent: estimate.cashBudget,
        safetyDataMTok: estimate.safetyDataMTok,
        safetyDataQuality: estimate.safetyDataQuality,
        startDay: state.day,
      },
    },
    alerts: [
      {
        id: `safety-start-${id}`,
        day: state.day,
        severity: 'info' as const,
        message: `${opts.intensity} safety campaign started for ${model.name}. The deployed checkpoint remains live.`,
      },
      ...charged.alerts,
    ].slice(0, 40),
  }
}

export function cancelSafetyCampaign(state: SimState): SimState {
  const campaign = state.player.safetyCampaign
  if (!campaign) return state
  return withAlert(
    { ...state, player: { ...state.player, safetyCampaign: null } },
    'warn',
    `${campaign.modelName} safety campaign cancelled; spent cash is not refunded.`,
  )
}

export function tickSafetyCampaign(state: SimState): SimState {
  const campaign = state.player.safetyCampaign
  if (!campaign) return state
  const modelIndex = state.player.models.findIndex((model) => model.id === campaign.modelId)
  if (modelIndex < 0) {
    return withAlert(
      { ...state, player: { ...state.player, safetyCampaign: null } },
      'danger',
      'Safety campaign stopped because its model no longer exists.',
    )
  }
  const staff = playerStaff(state).researcher ?? 0
  if (staff < campaign.minimumResearchers || campaign.assignedResearchers < campaign.minimumResearchers) {
    if (state.day % 4 !== 0) return state
    return withAlert(
      state,
      'warn',
      `Safety campaign stalled — needs ${campaign.minimumResearchers} researchers.`,
    )
  }
  const snap = computeSnapshot(state)
  if (snap.pools.training <= 0.001 && snap.pools.research <= 0.001) {
    if (state.day % 4 !== 0) return state
    return withAlert(state, 'warn', 'Safety campaign stalled — allocate both training and research compute.')
  }
  const surplus = Math.max(0, Math.min(staff, campaign.assignedResearchers) - campaign.minimumResearchers)
  const staffMult = 1 + Math.min(0.5, surplus * 0.06)
  const safetyResources = playerTrainingResourcePlan(state, snap).safetyCampaign
  if (safetyResources && !safetyResources.ramReady) {
    if (state.day % 4 !== 0) return state
    return withAlert(
      state,
      'warn',
      `Safety campaign RAM blocked — needs ${safetyResources.ramRequiredGb.toFixed(0)} GB, but ${safetyResources.ramAllocatedGb.toFixed(0)} GB is assigned. Raise Training allocation, add memory, or pause another run.`,
    )
  }
  const sharedTrainingPool = safetyResources?.effectivePf ?? 0
  const nextCampaign = {
    ...campaign,
    progressTrainingPfDays: Math.min(
      campaign.targetTrainingPfDays,
      campaign.progressTrainingPfDays + sharedTrainingPool * 0.6 * staffMult,
    ),
    progressResearchPfDays: Math.min(
      campaign.targetResearchPfDays,
      campaign.progressResearchPfDays + snap.pools.research * 0.4 * staffMult,
    ),
  }
  if (
    nextCampaign.progressTrainingPfDays + 1e-9 < nextCampaign.targetTrainingPfDays ||
    nextCampaign.progressResearchPfDays + 1e-9 < nextCampaign.targetResearchPfDays
  ) {
    return { ...state, player: { ...state.player, safetyCampaign: nextCampaign } }
  }

  const model = state.player.models[modelIndex]!
  const previous = model.safetyTraining ?? {
    campaigns: 0,
    safetyDataMTok: model.dataVerifyMTok ?? 0,
    safetyDataQuality: model.dataQualityUsed ?? 50,
    cashSpent: 0,
    trainingPfSpent: 0,
    researchPfSpent: 0,
    revisions: [],
  }
  const researchBonus =
    (state.player.researchUnlocked.includes('align_redteam') ? 5 : 0) +
    (state.player.researchUnlocked.includes('align_const') ? 3 : 0)
  const ceiling = Math.min(96, 62 + nextCampaign.safetyDataQuality * 0.3 + researchBonus)
  const current = model.benchmarks.safety ?? model.quality.safety
  const intensityGain = { targeted: 0.2, standard: 0.34, frontier: 0.52 }[campaign.intensity]
  const diminishing = 1 / (1 + previous.campaigns * 0.75)
  // Adequacy: spent cash vs recommended budget for this intensity/params.
  const recommendedCash = Math.max(1, campaign.cashBudget)
  const adequacy = Math.min(1.35, campaign.cashSpent / recommendedCash)
  const underfunded = adequacy < 0.85
  const rng = createRng(hashSeed(state.seed, campaign.id, state.day, 'safety-outcome'))
  let gain = Math.max(0.25, (ceiling - current) * intensityGain * diminishing * Math.max(0.55, adequacy))
  if (underfunded && rng.next() < 0.45 + (0.85 - adequacy)) {
    // Seeded downside: underfunded campaigns can worsen safety.
    gain = -Math.max(0.4, (current - 20) * 0.08 * (1.1 - adequacy))
  }
  const benchmarks = { ...model.benchmarks, safety: Math.min(ceiling, current + gain) }
  const quality = { ...model.quality, safety: Math.min(ceiling, model.quality.safety + gain * 0.9) }
  const capabilities = model.capabilities
    ? { ...model.capabilities, safety: Math.min(ceiling, model.capabilities.safety + gain) }
    : model.capabilities
  const lineageId = model.lineageId ?? model.id
  const revision =
    Math.max(
      model.revision ?? 1,
      ...state.player.models
        .filter((candidate) => (candidate.lineageId ?? candidate.id) === lineageId)
        .map((candidate) => candidate.revision ?? 1),
    ) + 1
  const rootName = model.name
    .replace(/\s+(?:v\d+|0\.\d+)$/i, '')
    .replace(/\s+·\s+C\d+$/i, '')
    .trim()
  const versionLabel = `0.${revision}`
  const childId = seededId(
    'model-safety-child',
    state.seed,
    campaign.id,
    model.id,
    revision,
  )
  const upgraded: Model = normalizeModelEvaluations({
    ...model,
    id: childId,
    name: `${rootName} ${versionLabel}`,
    lineageId,
    parentModelId: model.id,
    checkpointCandidateId: undefined,
    sourceTrainingJobId: campaign.id,
    release: 'internal',
    shipped: false,
    releaseDay: state.day,
    benchmarks,
    quality,
    capabilities,
    revision,
    versionLabel,
    // Reports and public evaluations describe exact weights and must never be
    // inherited by a new safety-trained child.
    checkpointEvaluations: [],
    trainingBenchmarkSnapshots: [],
    economics: {
      lifetimeApiRevenue: 0,
      lifetimeSubRevenue: 0,
      lifetimeEnterpriseRevenue: 0,
      lifetimeServingCost: 0,
      lifetimeNet: 0,
      trainingInitialCost: nextCampaign.cashSpent,
      trainingDataCost: 0,
      trainingDailyCost: 0,
    },
    safetyTraining: {
      campaigns: previous.campaigns + 1,
      safetyDataMTok: previous.safetyDataMTok + nextCampaign.safetyDataMTok,
      safetyDataQuality:
        (previous.safetyDataQuality * previous.safetyDataMTok +
          nextCampaign.safetyDataQuality * nextCampaign.safetyDataMTok) /
        Math.max(1, previous.safetyDataMTok + nextCampaign.safetyDataMTok),
      cashSpent: previous.cashSpent + nextCampaign.cashSpent,
      trainingPfSpent: previous.trainingPfSpent + nextCampaign.targetTrainingPfDays,
      researchPfSpent: previous.researchPfSpent + nextCampaign.targetResearchPfDays,
      lastCompletedDay: state.day,
      revisions: [
        ...(previous.revisions ?? []),
        { revision, day: state.day, safety: benchmarks.safety },
      ],
    },
  })
  const models = [...state.player.models, upgraded]
  return {
    ...state,
    player: { ...state.player, models, safetyCampaign: null },
    news: [
      `Day ${state.day}: ${upgraded.name} safety revision completed (${gain >= 0 ? '+' : ''}${gain.toFixed(1)} safety).`,
      ...state.news,
    ].slice(0, 20),
    alerts: [
      {
        id: `safety-done-${campaign.id}`,
        day: state.day,
        severity: 'info' as const,
        message: `${upgraded.name} safety child completed and remains internal. Existing deployments still serve ${model.name}.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

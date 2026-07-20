import type {
  SafetyCampaignIntensity,
  SimState,
} from '../types'
import { normalizeModelEvaluations } from '../balance/evaluationSuites'
import { computeSnapshot } from './compute'
import { playerStaff } from './staff'
import { seededId } from '../rng'

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
  const scale = Math.log10(Math.max(1, model.paramsB) + 1)
  const totalPfDays = (4 + scale * 4) * mult
  const minimumResearchers = Math.max(1, Math.ceil(scale * 4))
  const qualityInputs = ['chat', 'law', 'health'] as const
  const qualityValues = qualityInputs.map(
    (domain) => model.dataQualityByDomain?.[domain] ?? model.dataQualityUsed ?? 50,
  )
  const safetyDataQuality = qualityValues.reduce((sum, value) => sum + value, 0) / qualityValues.length
  const safetyDataMTok =
    (model.dataVerifyMTok ?? 0) + mult * Math.max(5, Math.log10(model.paramsB * 1000 + 10) * 20)
  const cashBudget = Math.round(totalPfDays * 80_000 + safetyDataMTok * 120)
  const researchers = playerStaff(state).researcher ?? 0
  const reason =
    !state.player.researchUnlocked.includes('align_rlhf')
      ? 'Unlock RLHF Pipeline first.'
      : state.player.safetyCampaign
          ? 'A safety campaign is already running.'
          : researchers < minimumResearchers
            ? `Needs ${minimumResearchers} researchers (have ${researchers}).`
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
  const availableResearchers = playerStaff(state).researcher ?? 0
  const assignedResearchers = Math.max(
    estimate.minimumResearchers,
    Math.min(availableResearchers, Math.floor(opts.researchers)),
  )
  const id = seededId('safe', state.seed, state.day, model.id, opts.intensity, model.revision ?? 1)
  return {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash - estimate.cashBudget,
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
      ...state.alerts,
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
  if (snap.pools.training <= 0.001 || snap.pools.research <= 0.001) {
    if (state.day % 4 !== 0) return state
    return withAlert(state, 'warn', 'Safety campaign stalled — allocate both training and research compute.')
  }
  const surplus = Math.max(0, Math.min(staff, campaign.assignedResearchers) - campaign.minimumResearchers)
  const staffMult = 1 + Math.min(0.5, surplus * 0.06)
  const activeTrainingJobs = state.player.trainingJobs?.length ?? (state.player.trainingJob ? 1 : 0)
  const sharedTrainingPool = snap.pools.training / Math.max(1, activeTrainingJobs + 1)
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
  const gain = Math.max(0.25, (ceiling - current) * intensityGain * diminishing)
  const benchmarks = { ...model.benchmarks, safety: Math.min(ceiling, current + gain) }
  const quality = { ...model.quality, safety: Math.min(ceiling, model.quality.safety + gain * 0.9) }
  const capabilities = model.capabilities
    ? { ...model.capabilities, safety: Math.min(ceiling, model.capabilities.safety + gain) }
    : model.capabilities
  const upgraded = normalizeModelEvaluations({
    ...model,
    benchmarks,
    quality,
    capabilities,
    revision: (model.revision ?? 1) + 1,
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
        { revision: (model.revision ?? 1) + 1, day: state.day, safety: benchmarks.safety },
      ],
    },
  })
  const models = state.player.models.slice()
  models[modelIndex] = upgraded
  return {
    ...state,
    player: { ...state.player, models, safetyCampaign: null },
    news: [
      `Day ${state.day}: ${model.name} safety revision ${upgraded.revision} completed (+${gain.toFixed(1)} safety).`,
      ...state.news,
    ].slice(0, 20),
    alerts: [
      {
        id: `safety-done-${campaign.id}`,
        day: state.day,
        severity: 'info' as const,
        message: `${model.name} safety campaign complete. Plans now serve revision ${upgraded.revision}.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

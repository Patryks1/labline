/**
 * Token-based data flywheel (MTok = million tokens).
 * Sources: web · user · synth. AI gen burns research PF.
 */
import {
  DATA_DOMAINS,
  DATA_DOMAIN_META,
  DATA_ECONOMY,
  DOMAIN_DATA_CONTRACTS,
  DATA_SELLER_LABELS,
  DATA_QUALITY_LABELS,
  emptyDataMarket,
  generateDataMarketOffers,
  createEmptyLabData,
  formatTokens,
  minDataMTokForParams,
  normalizeDomainStock,
  normalizeWeights,
  recommendedDataMTok,
  recommendedDataUnits,
  resolveDataPlan,
  totalProcessed,
  totalRaw,
  totalSources,
  type DomainDataContract,
} from '../balance/data'
import { seededId } from '../rng'
import { queueDataOfferOrder } from './sharedMarkets'
import type {
  DataDomain,
  DataPruneJob,
  DataSellerKind,
  LabData,
  Model,
  ProcessJob,
  SimState,
  SyntheticFillRecord,
  SynthGenJob,
  TrainingDataPlan,
} from '../types'
import { computeSnapshot } from './compute'
import { campusBonuses } from './campus'
import { aggregateEffects } from './research'
import { modelCanCurateDataDomain } from './modelEligibility'
import {
  estimateSyntheticQuality,
  teacherCapabilityForDataDomain,
} from '../balance/modelCapabilities'
import {
  appendDatasetAsset,
  syntheticDatasetAsset,
} from './dataAssets'
import { playerStaff } from './staff'
import {
  cloneLabData,
  collectTrafficData,
  dataProcessingThroughput,
  enqueueAutomaticProcessing,
  processDataJobs,
  syntheticGenerationMTokPerDay,
  updateDataQualityIndex,
} from './dataRuntime'

export {
  DATA_DOMAINS,
  DATA_DOMAIN_META,
  DOMAIN_DATA_CONTRACTS,
  DATA_SELLER_LABELS,
  DATA_QUALITY_LABELS,
  emptyDataMarket,
  generateDataMarketOffers,
  formatTokens,
  minDataMTokForParams,
  recommendedDataMTok,
  recommendedDataUnits,
  resolveDataPlan,
  totalProcessed,
  totalRaw,
  totalSources,
  createEmptyLabData,
  type DomainDataContract,
}

export function ensureLabData(state: SimState): LabData {
  const raw = state.player.data
  if (!raw) return createEmptyLabData()
  return cloneLabData(raw)
}

/** Research PF fraction available for tech (1 − data gen). */
export function researchPoolForTech(state: SimState): number {
  const data = ensureLabData(state)
  const share = dataResearchReservationShare(data)
  const safetyShare = state.player.safetyCampaign ? 0.4 : 0
  return Math.max(0, 1 - share - safetyShare)
}

/** One physical research pool is shared by synthesis, pruning, and tech research. */
export function dataResearchReservationShare(data: LabData): number {
  const synthShare = (data.synthQueue ?? []).reduce((sum, job) => sum + job.researchShare, 0)
  const pruneShare = (data.pruneQueue ?? []).reduce((sum, job) => sum + job.researchShare, 0)
  return Math.max(0, Math.min(DATA_ECONOMY.maxDataGenResearchShare, synthShare + pruneShare))
}

/** Gross research PF before continuous data-generation reservations are removed. */
export function grossResearchPoolPf(state: SimState): number {
  const data = ensureLabData(state)
  const reserved = dataResearchReservationShare(data)
  const techPool = computeSnapshot(state).pools.research
  return techPool / Math.max(0.15, 1 - reserved)
}

export const DATA_PRUNE_QUALITY_FLOOR = 65
const DATA_PRUNE_RESEARCH_SHARE = 0.08
const DATA_PRUNE_MAX_JOBS = 9
const DATA_PRUNE_MIN_ACTIVE_PF = 0.05

export interface DataPruneEstimate {
  domain: DataDomain
  rawMTok: number
  processedMTok: number
  totalMTok: number
  cashCost: number
  pfDays: number
  researchersRequired: number
  researchShare: number
  availableResearchPf: number
  ok: boolean
  reason?: string
}

function lowQualityDataForDomain(data: LabData, domain: DataDomain): {
  rawMTok: number
  processedMTok: number
} {
  const stock = data.stocks[domain]
  // Raw stock has not passed the eval/cleaning pipeline; audit a conservative
  // slice for duplicates, corrupt records, and low-signal samples.
  const rawRate = Math.max(0.1, Math.min(0.45, 0.16 + (DATA_PRUNE_QUALITY_FLOOR - stock.quality) / 130))
  const rawMTok = stock.raw * rawRate
  const qualityInferred =
    stock.processed * Math.max(0, Math.min(0.55, (DATA_PRUNE_QUALITY_FLOOR - stock.quality) / 80))
  const processedMTok = Math.min(
    stock.processed,
    Math.max(stock.fromSynthLQ ?? 0, qualityInferred),
  )
  return { rawMTok, processedMTok }
}

export function estimateDataPrune(state: SimState, domain: DataDomain): DataPruneEstimate {
  const data = ensureLabData(state)
  const lowQuality = lowQualityDataForDomain(data, domain)
  const totalMTok = lowQuality.rawMTok + lowQuality.processedMTok
  const meta = DATA_DOMAIN_META[domain]
  const cashPerMTok = meta.processCostPerMTok * 2.5
  const pfDaysPerMTok = meta.processHard * 0.65
  const researchersRequired = Math.max(1, Math.min(4, Math.ceil(totalMTok / 250)))
  const existingShare = dataResearchReservationShare(data)
  const researchers = playerStaff(state).researcher ?? 0
  const availableResearchPf = grossResearchPoolPf(state) * DATA_PRUNE_RESEARCH_SHARE
  const alreadyQueued = data.pruneQueue.some((job) => job.domain === domain)
  let reason: string | undefined
  if (totalMTok < 0.5) reason = 'No low-quality stock detected'
  else if (alreadyQueued) reason = 'Audit already queued'
  else if (data.pruneQueue.length >= DATA_PRUNE_MAX_JOBS) reason = 'Pruning queue full'
  else if (researchers < researchersRequired) {
    reason = `Needs ${researchersRequired} researchers (have ${researchers})`
  } else if (state.player.cash + 1e-9 < totalMTok * cashPerMTok) {
    reason = `Needs ${formatMoneyShort(totalMTok * cashPerMTok)} cash`
  } else if (availableResearchPf < DATA_PRUNE_MIN_ACTIVE_PF) reason = 'No research compute available'
  else if (existingShare + DATA_PRUNE_RESEARCH_SHARE > DATA_ECONOMY.maxDataGenResearchShare + 1e-9) {
    reason = 'Research pool is fully reserved'
  }
  return {
    domain,
    ...lowQuality,
    totalMTok,
    cashCost: totalMTok * cashPerMTok,
    pfDays: totalMTok * pfDaysPerMTok,
    researchersRequired,
    researchShare: DATA_PRUNE_RESEARCH_SHARE,
    availableResearchPf,
    ok: reason == null,
    reason,
  }
}

function formatMoneyShort(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`
  return `$${value.toFixed(0)}`
}

export function enqueueDataPrune(state: SimState, domain: DataDomain): SimState {
  const estimate = estimateDataPrune(state, domain)
  if (!estimate.ok) return alert(state, 'warn', estimate.reason ?? 'Unable to prune data.')
  const data = cloneLabData(ensureLabData(state))
  const meta = DATA_DOMAIN_META[domain]
  const job: DataPruneJob = {
    id: seededId('prune', state.seed, state.day, domain, data.pruneQueue.length),
    domain,
    rawRemaining: estimate.rawMTok,
    processedRemaining: estimate.processedMTok,
    rawTotal: estimate.rawMTok,
    processedTotal: estimate.processedMTok,
    cashPerMTok: estimate.cashCost / Math.max(0.001, estimate.totalMTok),
    pfDaysPerMTok: estimate.pfDays / Math.max(0.001, estimate.totalMTok),
    researchersRequired: estimate.researchersRequired,
    researchShare: estimate.researchShare,
    qualityBefore: data.stocks[domain].quality,
  }
  data.pruneQueue.push(job)
  data.dataGenResearchShare = dataResearchReservationShare(data)
  return {
    ...state,
    player: { ...state.player, data },
    alerts: [
      {
        id: job.id,
        day: state.day,
        severity: 'info' as const,
        message: `Low-quality ${meta.label} audit queued: ${formatTokens(estimate.totalMTok)} · ${formatMoneyShort(estimate.cashCost)} · ${Math.ceil(estimate.pfDays)} PF-days.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export interface AllDataPruneEstimate {
  domains: DataDomain[]
  totalMTok: number
  cashCost: number
  pfDays: number
  researchersRequired: number
  ok: boolean
  reason?: string
}

export function estimateAllDataPrunes(state: SimState): AllDataPruneEstimate {
  const data = ensureLabData(state)
  const candidates = DATA_DOMAINS.map((domain) => estimateDataPrune(state, domain)).filter(
    (estimate) => estimate.totalMTok >= 0.5 && !data.pruneQueue.some((job) => job.domain === estimate.domain),
  )
  const cashCost = candidates.reduce((sum, estimate) => sum + estimate.cashCost, 0)
  const pfDays = candidates.reduce((sum, estimate) => sum + estimate.pfDays, 0)
  const totalMTok = candidates.reduce((sum, estimate) => sum + estimate.totalMTok, 0)
  const researchersRequired = candidates.length
    ? Math.max(...candidates.map((estimate) => estimate.researchersRequired))
    : 0
  const totalShare = dataResearchReservationShare(data) + candidates.length * DATA_PRUNE_RESEARCH_SHARE
  const researchers = playerStaff(state).researcher ?? 0
  let reason: string | undefined
  if (candidates.length === 0) reason = 'No low-quality stock detected'
  else if (data.pruneQueue.length + candidates.length > DATA_PRUNE_MAX_JOBS) reason = 'Pruning queue full'
  else if (researchers < researchersRequired) {
    reason = `Needs ${researchersRequired} researchers (have ${researchers})`
  } else if (state.player.cash + 1e-9 < cashCost) reason = `Needs ${formatMoneyShort(cashCost)} cash`
  else if (candidates.some((estimate) => estimate.availableResearchPf < DATA_PRUNE_MIN_ACTIVE_PF)) {
    reason = 'No research compute available'
  } else if (totalShare > DATA_ECONOMY.maxDataGenResearchShare + 1e-9) {
    reason = 'Needs more free research compute'
  }
  return {
    domains: candidates.map((estimate) => estimate.domain),
    totalMTok,
    cashCost,
    pfDays,
    researchersRequired,
    ok: reason == null,
    reason,
  }
}

export function enqueueAllDataPrunes(state: SimState): SimState {
  const estimate = estimateAllDataPrunes(state)
  if (!estimate.ok) return alert(state, 'warn', estimate.reason ?? 'Unable to prune all data.')
  let next = state
  for (const domain of estimate.domains) next = enqueueDataPrune(next, domain)
  return next
}

/** 1 = current frontier teacher; lower values warn that a running corpus is going stale. */
export function synthTeacherFreshness(
  state: SimState,
  model: Model,
  domain: DataDomain,
): { freshness: number; capabilityGap: number; frontierName: string } {
  const candidates = [
    ...state.player.models,
    ...state.rivals.flatMap((rival) => rival.models),
  ].filter((candidate) =>
    candidate.release === 'released' || candidate.shipped || candidate.release === 'internal',
  )
  let frontier = model
  let frontierCapability = teacherCapabilityForDataDomain(model, domain)
  for (const candidate of candidates) {
    const capability = teacherCapabilityForDataDomain(candidate, domain)
    if (capability > frontierCapability) {
      frontier = candidate
      frontierCapability = capability
    }
  }
  const teacherCapability = teacherCapabilityForDataDomain(model, domain)
  const capabilityGap = Math.max(0, frontierCapability - teacherCapability)
  return {
    freshness: Math.max(0.4, 1 - capabilityGap / 45),
    capabilityGap,
    frontierName: frontier.name,
  }
}

export function collectFromTraffic(state: SimState): SimState {
  const flywheel = aggregateEffects(state.player.researchUnlocked).dataFlywheel ?? 0
  const result = collectTrafficData({
    data: ensureLabData(state),
    servedMTok: state.lastMarket.servedMTok,
    demandMTok: state.lastMarket.playerDemandMTok,
    brandTrust: state.player.brandTrust,
    dataFlywheel: flywheel,
    segments: state.segments,
  })
  return {
    ...state,
    player: { ...state.player, data: result.data, brandTrust: result.brandTrust },
  }
}

export function setCollectionRate(state: SimState, rate: number): SimState {
  const data = cloneLabData(ensureLabData(state))
  data.collectionRate = Math.max(0, Math.min(1, rate))
  return { ...state, player: { ...state.player, data } }
}

export function setAutoProcess(state: SimState, on: boolean): SimState {
  const data = cloneLabData(ensureLabData(state))
  data.autoProcess = on
  return { ...state, player: { ...state.player, data } }
}

export function enqueueProcess(
  state: SimState,
  domain: DataDomain,
  amount: number,
  qualityTarget = 70,
): SimState {
  const data = cloneLabData(ensureLabData(state))
  const stock = data.stocks[domain]
  const take = Math.min(stock.raw, Math.max(0, amount))
  if (take < 0.5) {
    return alert(state, 'warn', `Not enough raw ${DATA_DOMAIN_META[domain].label} tokens to process.`)
  }
  if (data.processQueue.length >= DATA_ECONOMY.maxProcessJobs) {
    return alert(state, 'warn', 'Processing queue full.')
  }
  stock.raw -= take
  const job: ProcessJob = {
    id: seededId('proc', state.seed, state.day, domain, data.processQueue.length),
    domain,
    remaining: take,
    total: take,
    qualityTarget: Math.max(30, Math.min(95, qualityTarget)),
  }
  data.processQueue.push(job)
  return {
    ...state,
    player: { ...state.player, data },
    alerts: [
      {
        id: job.id,
        day: state.day,
        severity: 'info' as const,
        message: `Processing ${formatTokens(take)} ${DATA_DOMAIN_META[domain].label} (Q${job.qualityTarget}).`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function enqueueProcessAll(state: SimState): SimState {
  let s = state
  for (const d of DATA_DOMAINS) {
    const raw = ensureLabData(s).stocks[d].raw
    if (raw >= 1) s = enqueueProcess(s, d, raw, 68)
  }
  return s
}

/**
 * Start AI data generation for a domain using a player model.
 * Burns a share of the research PF pool (slows tech research).
 */
export function startSynthGen(
  state: SimState,
  opts: {
    domain: DataDomain
    modelId: string
    targetMTok?: number
    researchShare: number
    /** HQ needs data_synth + capable model; LQ is always noisier/faster */
    qualityTier?: 'hq' | 'lq'
  },
): SimState {
  if (!state.player.researchUnlocked.includes('data_synth')) {
    return alert(
      state,
      'warn',
      'Unlock Synthetic Generators (data tree: mix → clean → eval → synth) first.',
    )
  }
  const model = state.player.models.find((m) => m.id === opts.modelId)
  if (!model) return alert(state, 'warn', 'Pick a model to generate data.')
  if (!(model.release === 'released' || model.shipped || model.release === 'internal')) {
    return alert(state, 'warn', 'Model must be a finished checkpoint.')
  }

  let tier: 'hq' | 'lq' = opts.qualityTier ?? 'hq'
  // Weak teachers cannot produce true HQ — force LQ
  if (tier === 'hq' && model.capability < 38) {
    tier = 'lq'
  }

  const data = cloneLabData(ensureLabData(state))
  if ((data.synthQueue?.length ?? 0) >= DATA_ECONOMY.maxSynthJobs) {
    return alert(state, 'warn', 'Synth queue full — wait for jobs to finish.')
  }

  const share = Math.max(0.05, Math.min(0.5, opts.researchShare))
  const used = dataResearchReservationShare(data)
  if (used + share > DATA_ECONOMY.maxDataGenResearchShare + 0.001) {
    return alert(
      state,
      'warn',
      `Research pool for data gen is full (${Math.round(used * 100)}%). Lower share or wait.`,
    )
  }

  const continuous = opts.targetMTok == null
  const target = continuous ? 0 : Math.max(5, opts.targetMTok ?? 5)
  const job: SynthGenJob = {
    id: seededId('synth', state.seed, state.day, opts.domain, opts.modelId, data.synthQueue.length),
    domain: opts.domain,
    modelId: model.id,
    modelName: model.name,
    targetMTok: target,
    progressMTok: 0,
    continuous,
    researchShare: share,
    qualityTier: tier,
  }
  data.synthQueue = [...(data.synthQueue ?? []), job]
  data.dataGenResearchShare = dataResearchReservationShare(data)

  const pfDay = grossResearchPoolPf(state) * share
  const generatedPerDay = syntheticGenerationMTokPerDay({
    domain: opts.domain,
    teacherDomainCapability: teacherCapabilityForDataDomain(model, opts.domain),
    teacherReliability: model.quality.reliability,
    researchPf: pfDay,
    tier,
  })
  const estDays = generatedPerDay > 0.01 && !continuous ? Math.ceil(target / generatedPerDay) : null

  return {
    ...state,
    player: { ...state.player, data },
    alerts: [
      {
        id: job.id,
        day: state.day,
        severity: 'info' as const,
        message: `Continuous AI gen (${tier.toUpperCase()}): ${model.name} → ${DATA_DOMAIN_META[opts.domain].label} (~${Math.round(share * 100)}% research${estDays ? ` · ~${estDays}d` : ''}). Update the teacher when its frontier freshness falls.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function cancelSynthGen(state: SimState, jobId: string): SimState {
  const data = cloneLabData(ensureLabData(state))
  data.synthQueue = data.synthQueue.filter((j) => j.id !== jobId)
  data.dataGenResearchShare = dataResearchReservationShare(data)
  return { ...state, player: { ...state.player, data } }
}

/** Estimate MTok/day for a synth config (UI). */
export function estimateSynthMTokPerDay(
  state: SimState,
  model: Model,
  domain: DataDomain,
  researchShare: number,
): number {
  const pf = grossResearchPoolPf(state) * Math.max(0.05, Math.min(0.5, researchShare))
  return syntheticGenerationMTokPerDay({
    domain,
    teacherDomainCapability: teacherCapabilityForDataDomain(model, domain),
    teacherReliability: model.quality.reliability,
    researchPf: pf,
    tier: 'hq',
  })
}

function removeProcessedLowQuality(
  stock: LabData['stocks'][DataDomain],
  amount: number,
): void {
  const oldProcessed = stock.processed
  const removed = Math.min(oldProcessed, Math.max(0, amount))
  if (removed <= 0) return

  let sourceLeft = removed
  const takeLq = Math.min(stock.fromSynthLQ ?? 0, sourceLeft)
  stock.fromSynthLQ = Math.max(0, (stock.fromSynthLQ ?? 0) - takeLq)
  stock.fromSynth = Math.max(stock.fromSynthHQ ?? 0, (stock.fromSynth ?? 0) - takeLq)
  sourceLeft -= takeLq

  // Older saves only retain aggregate source counts. Remove remaining inferred
  // low-quality records proportionally so provenance remains conserved.
  const sourceKeys = ['fromWeb', 'fromUser', 'fromBought', 'fromSynth'] as const
  const sourceTotal = sourceKeys.reduce((sum, key) => sum + Math.max(0, stock[key] ?? 0), 0)
  if (sourceLeft > 0 && sourceTotal > 0) {
    const ratio = Math.min(1, sourceLeft / sourceTotal)
    for (const key of sourceKeys) stock[key] = Math.max(0, (stock[key] ?? 0) * (1 - ratio))
    const synthTotal = (stock.fromSynthHQ ?? 0) + (stock.fromSynthLQ ?? 0)
    stock.fromSynth = Math.max(synthTotal, stock.fromSynth ?? 0)
  }

  const nextProcessed = Math.max(0, oldProcessed - removed)
  // Audits target records around Q22. Removing them raises the surviving
  // corpus average without manufacturing any new high-quality tokens.
  stock.quality =
    nextProcessed > 0
      ? Math.max(stock.quality, Math.min(95, (stock.quality * oldProcessed - 22 * removed) / nextProcessed))
      : DATA_PRUNE_QUALITY_FLOOR
  stock.processed = nextProcessed
}

function processDataPruneJobs(
  state: SimState,
  dataInput: LabData,
  cashInput: number,
): { data: LabData; cash: number; alerts: SimState['alerts'] } {
  const data = cloneLabData(dataInput)
  let cash = cashInput
  let alerts = state.alerts
  const researchers = playerStaff(state).researcher ?? 0
  const grossResearchPf = grossResearchPoolPf({
    ...state,
    player: { ...state.player, data },
  })
  const queue: DataPruneJob[] = []

  for (const job of data.pruneQueue) {
    const totalLeft = job.rawRemaining + job.processedRemaining
    if (totalLeft <= 0.001) continue
    if (researchers < job.researchersRequired || grossResearchPf <= 0.001) {
      queue.push(job)
      if (state.day % 4 === 0) {
        alerts = [
          {
            id: `prune-stalled-${job.id}-${state.day}`,
            day: state.day,
            severity: 'warn' as const,
            message: `${DATA_DOMAIN_META[job.domain].label} pruning stalled — needs ${job.researchersRequired} researchers and research compute.`,
          },
          ...alerts,
        ].slice(0, 40)
      }
      continue
    }

    const byCompute = (grossResearchPf * job.researchShare) / Math.max(0.001, job.pfDaysPerMTok)
    const byCash = cash / Math.max(0.001, job.cashPerMTok)
    const step = Math.min(totalLeft, byCompute, byCash)
    if (step <= 0.001) {
      queue.push(job)
      if (state.day % 4 === 0) {
        alerts = [
          {
            id: `prune-cash-${job.id}-${state.day}`,
            day: state.day,
            severity: 'warn' as const,
            message: `${DATA_DOMAIN_META[job.domain].label} pruning paused — insufficient cash.`,
          },
          ...alerts,
        ].slice(0, 40)
      }
      continue
    }

    const rawStep = Math.min(job.rawRemaining, step * (job.rawRemaining / totalLeft))
    const processedStep = Math.min(job.processedRemaining, step - rawStep)
    const stock = data.stocks[job.domain]
    stock.raw = Math.max(0, stock.raw - rawStep)
    removeProcessedLowQuality(stock, processedStep)
    cash -= (rawStep + processedStep) * job.cashPerMTok
    const nextJob: DataPruneJob = {
      ...job,
      rawRemaining: Math.max(0, job.rawRemaining - rawStep),
      processedRemaining: Math.max(0, job.processedRemaining - processedStep),
    }
    if (nextJob.rawRemaining + nextJob.processedRemaining > 0.5) {
      queue.push(nextJob)
    } else {
      alerts = [
        {
          id: `prune-done-${job.id}`,
          day: state.day,
          severity: 'info' as const,
          message: `${DATA_DOMAIN_META[job.domain].label} audit complete — ${formatTokens(job.rawTotal + job.processedTotal)} low-quality tokens discarded; surviving corpus is Q${Math.round(stock.quality)}.`,
        },
        ...alerts,
      ].slice(0, 40)
    }
  }
  data.pruneQueue = queue
  data.dataGenResearchShare = dataResearchReservationShare(data)
  return { data, cash: Math.max(0, cash), alerts }
}

export function tickData(state: SimState): SimState {
  let data = cloneLabData(ensureLabData(state))
  data.dayProcessed = 0
  data.daySynthMTok = 0
  let cash = state.player.cash
  let alerts = state.alerts
  const snap = computeSnapshot(state)

  // ─── AI synth jobs (claim research PF first) ───
  const synthQueue: SynthGenJob[] = []
  for (const job of data.synthQueue ?? []) {
    const model = state.player.models.find((m) => m.id === job.modelId)
    if (!model) continue
    const tier = job.qualityTier ?? 'hq'
    const pf = grossResearchPoolPf({ ...state, player: { ...state.player, data } }) * job.researchShare
    const meta = DATA_DOMAIN_META[job.domain]
    const gen = syntheticGenerationMTokPerDay({
      domain: job.domain,
      teacherDomainCapability: teacherCapabilityForDataDomain(model, job.domain),
      teacherReliability: model.quality.reliability,
      researchPf: pf,
      tier,
    })
    const continuous = job.continuous === true
    const next = continuous
      ? job.progressMTok + gen
      : Math.min(job.targetMTok, job.progressMTok + gen)
    const step = next - job.progressMTok
    if (step > 0) {
      const stock = normalizeDomainStock(data.stocks[job.domain])
      const assetId = `dataset-${job.id}`
      const generationDepth =
        1 +
        (data.assets ?? []).filter(
          (asset) =>
            asset.id !== assetId &&
            asset.source === 'synthetic' &&
            asset.synthetic?.teacherModelIds.includes(model.id) &&
            (asset.domainWeights[job.domain] ?? 0) > 0,
        ).length
      const syntheticAsset = syntheticDatasetAsset({
        id: assetId,
        name: `${job.modelName} ${meta.label} synthetic curriculum`,
        domain: job.domain,
        volumeMTok: next,
        quality: 0,
        teacherModelId: job.modelId,
        tier,
        day: state.day,
        provenance: { generationDepth },
      })
      const baseQuality = estimateSyntheticQuality({
        domain: job.domain,
        teacherDomainCapability: teacherCapabilityForDataDomain(model, job.domain),
        provenance: syntheticAsset.synthetic!,
      }).quality
      const teacher = synthTeacherFreshness(state, model, job.domain)
      const qIn = Math.max(18, baseQuality - teacher.capabilityGap * 0.45)
      // Real packs keep quality; synth tracked separately for mix control
      const real = Math.max(0, stock.processed - stock.fromSynthHQ - stock.fromSynthLQ)
      stock.processed = stock.processed + step
      stock.fromSynth = (stock.fromSynth ?? 0) + step
      if (tier === 'hq') stock.fromSynthHQ = (stock.fromSynthHQ ?? 0) + step
      else stock.fromSynthLQ = (stock.fromSynthLQ ?? 0) + step
      // Blended stock quality for display (real-weighted)
      const np = stock.processed
      stock.quality =
        np > 0
          ? (stock.quality * real + qIn * step + stock.quality * (stock.processed - real - step)) /
            np
          : qIn
      // Simpler stable blend:
      stock.quality =
        np > 0
          ? (stock.quality * (np - step) + qIn * step) / np
          : qIn
      data.stocks[job.domain] = stock
      data = appendDatasetAsset(
        data,
        { ...syntheticAsset, quality: qIn, freshness: teacher.freshness },
      )
      data.daySynthMTok += step
      data.dayProcessed += step
      data.lifetimeProcessed += step
      data.lifetimeCollected += step
    }
    if (continuous || next < job.targetMTok - 0.1) {
      synthQueue.push({ ...job, progressMTok: next, qualityTier: tier })
    } else {
      alerts = [
        {
          id: `synth-done-${job.id}`,
          day: state.day,
          severity: 'info' as const,
          message: `Synth complete (${tier.toUpperCase()}): ${formatTokens(job.targetMTok)} ${meta.label} via ${job.modelName}.`,
        },
        ...alerts,
      ].slice(0, 40)
    }
  }
  data.synthQueue = synthQueue
  data.dataGenResearchShare = dataResearchReservationShare(data)

  const pruning = processDataPruneJobs(state, data, cash)
  data = pruning.data
  cash = pruning.cash
  alerts = pruning.alerts

  // Research left for processing assist
  const researchLeft = snap.pools.research * researchPoolForTech({ ...state, player: { ...state.player, data } })

  data = enqueueAutomaticProcessing({
    data,
    day: state.day,
    labId: state.playerLabId,
    dataQuality: state.player.dataQuality,
    staff: state.player.staff,
  })
  const effects = aggregateEffects(state.player.researchUnlocked)
  const processing = processDataJobs({
    data,
    cash,
    throughputMTok: dataProcessingThroughput({
      staff: state.player.staff,
      researchPf: researchLeft,
      labSites: campusBonuses(state).labSites,
      dataFlywheel: effects.dataFlywheel ?? 0,
    }),
    dataQuality: state.player.dataQuality,
    staff: state.player.staff,
    day: state.day,
  })
  data = processing.data
  cash = processing.cash
  if (processing.blockedForCash && !alerts.some((alertItem) => alertItem.id.startsWith('proc-cash-'))) {
    alerts = [
      {
        id: `proc-cash-${state.day}`,
        day: state.day,
        severity: 'warn' as const,
        message: 'Data processing paused — need cash for cleaning pipelines.',
      },
      ...alerts,
    ].slice(0, 40)
  }
  const dataQuality = updateDataQualityIndex(state.player.dataQuality, data)

  return {
    ...state,
    player: { ...state.player, cash, data, dataQuality },
    alerts,
  }
}

export interface ConsumeResult {
  ok: boolean
  reason?: string
  plan: TrainingDataPlan & { totalMTok: number; trainShare: number }
  consumed: Partial<Record<DataDomain, number>>
  coverage: number
  qualityUsed: number
  syntheticUnits: number
  synthHqUnits?: number
  synthLqUnits?: number
  /** 0–1 fraction of recipe that was low-quality synth */
  synthLqShare?: number
  cashCost: number
  nextData: LabData
  trainMTok: number
  verifyMTok: number
  domainQuality?: Partial<Record<DataDomain, number>>
  lowQualityShareByDomain?: Partial<Record<DataDomain, number>>
  syntheticProvenance?: SyntheticFillRecord[]
  specialistBoosts?: Partial<Record<DataDomain, number>>
}

export function hasCorpusSpecialists(state: SimState): boolean {
  return (
    state.player.researchUnlocked.includes('data_specialists') ||
    (aggregateEffects(state.player.researchUnlocked).unlockCorpusSpecialists ?? false)
  )
}

export function specialistDomainBoost(model: Model, domain: DataDomain): number {
  const b = model.benchmarks
  const q = model.quality
  let score = 0
  switch (domain) {
    case 'code':
      score = (b.coding ?? 0) * 0.7 + (b.agents ?? 0) * 0.15 + q.coding * 0.15
      break
    case 'law':
      score = (b.law ?? 0) * 0.75 + (b.safety ?? 0) * 0.15 + q.reasoning * 0.1
      break
    case 'health':
      score = (b.health ?? 0) * 0.75 + (b.science ?? 0) * 0.15 + q.safety * 0.1
      break
    case 'chat':
      score = q.chat * 0.45 + (b.mmlu ?? 0) * 0.35 + (b.multilingual ?? 0) * 0.2
      break
    case 'image':
      score = (b.vision ?? 0) * 0.8 + q.image * 0.2
      break
    case 'video':
      score = (b.vision ?? 0) * 0.45 + q.video * 0.4 + q.image * 0.15
      break
    case 'audio':
      score = q.chat * 0.4 + (b.multilingual ?? 0) * 0.35 + (b.mmlu ?? 0) * 0.25
      break
    default:
      score = model.capability * 0.5
  }
  const raw = (score / 100) * 16 + model.capability * 0.06
  return Math.max(0, Math.min(22, raw))
}

export function resolveDomainModel(
  state: SimState,
  modelId: string | undefined | null,
): Model | null {
  if (!modelId) return null
  return state.player.models.find((m) => m.id === modelId) ?? null
}

/**
 * Attribute training volume against the corpus.
 *
 * - **Pretrain / distill:** read-only — full collected corpus stays for future pretrains.
 * - **Continue:** only “new” tokens since the model’s watermark; still does not wipe stocks
 *   (watermark advances on the model so the same delta isn’t double-counted for continues).
 * - 1:1 min tokens:params applies to pretrain/distill only.
 */
/**
 * Lab-agnostic corpus recipe (player or rival).
 * Same HQ/LQ synth rules and 1:1 coverage math for every lab.
 */
export function consumeForLabData(
  dataIn: LabData,
  planIn: TrainingDataPlan | undefined,
  paramsB: number,
  family: string,
  opts?: {
    mode?: 'pretrain' | 'distill' | 'continue'
    priorWatermarkMTok?: number
    /** When true, HQ synth fill requires unlocked research (player). Rivals pass their unlocks. */
    hasSynthResearch?: boolean
    legacyMix?: string
  },
): ConsumeResult {
  const mode = opts?.mode ?? 'pretrain'
  const isContinue = mode === 'continue'
  const plan = resolveDataPlan(planIn, paramsB, family, opts?.legacyMix)
  if (planIn?.domainModels) plan.domainModels = { ...planIn.domainModels }

  const weights = normalizeWeights(plan.weights)
  // Read-only clone for quality — stocks are never permanently depleted by pretrain
  const data = cloneLabData(dataIn)
  const totalProcessedNow = totalProcessed(data)
  const watermark = Math.max(0, opts?.priorWatermarkMTok ?? 0)
  const newSinceTrain = isContinue
    ? Math.max(0, totalProcessedNow - watermark)
    : totalProcessedNow

  const minMTok = isContinue ? 0 : minDataMTokForParams(paramsB)
  // Continue: cap volume to new data (+ small synth if player asks for more)
  let total = Math.max(1, plan.totalMTok)
  if (isContinue) {
    total = Math.min(total, Math.max(1, newSinceTrain + (plan.allowSynthetic ? newSinceTrain * 0.25 : 0)))
    // Soft default: use whatever new data exists
    if (!planIn?.totalMTok && !planIn?.totalUnits) {
      total = Math.max(1, newSinceTrain)
    }
  }

  const trainShare = plan.trainShare

  const consumed: Partial<Record<DataDomain, number>> = {}
  let syntheticUnits = 0
  let synthHqUnits = 0
  let synthLqUnits = 0
  const cashCost = 0
  let qualityAcc = 0
  let qualityW = 0
  const domainQuality: Partial<Record<DataDomain, number>> = {}
  const lowQualityShareByDomain: Partial<Record<DataDomain, number>> = {}
  const specialistBoosts: Partial<Record<DataDomain, number>> = {}
  const hasSynthResearch = opts?.hasSynthResearch ?? false
  const useSynth = !!plan.allowSynthetic
  const useHQ = useSynth && (plan.includeSynthHQ !== false) && hasSynthResearch
  const useLQ = useSynth && !!plan.includeSynthLQ

  // For continue: only a fraction of each domain’s stock counts as “new”
  const newFrac =
    isContinue && totalProcessedNow > 0
      ? Math.min(1, newSinceTrain / totalProcessedNow)
      : 1

  for (const d of DATA_DOMAINS) {
    const need = total * weights[d]
    if (need <= 0.01) continue
    const stock = normalizeDomainStock(data.stocks[d])
    // Real packs (web + user) — always allowed
    const real = Math.max(0, stock.processed - (stock.fromSynthHQ + stock.fromSynthLQ))
    const hqAvail = useHQ ? stock.fromSynthHQ * newFrac : 0
    const lqAvail = useLQ ? stock.fromSynthLQ * newFrac : 0
    const realAvail = real * newFrac

    let remaining = need
    const takeReal = Math.min(realAvail, remaining)
    remaining -= takeReal
    const takeHQ = Math.min(hqAvail, remaining)
    remaining -= takeHQ
    const takeLQ = Math.min(lqAvail, remaining)
    remaining -= takeLQ
    const short = remaining
    const specBoost = 0

    const take = takeReal + takeHQ + takeLQ
    if (take > 0) {
      consumed[d] = take
      const qReal = Math.min(98, stock.quality + specBoost)
      const qHQ = Math.min(92, (DATA_ECONOMY.syntheticQualityHQ ?? 72) + specBoost * 0.5)
      const qLQ = Math.min(45, (DATA_ECONOMY.syntheticQualityLQ ?? 28) + specBoost * 0.2)
      const qBlend =
        (qReal * takeReal + qHQ * takeHQ + qLQ * takeLQ) / Math.max(0.01, take)
      domainQuality[d] = qBlend
      lowQualityShareByDomain[d] = take > 0 ? takeLQ / take : 0
      qualityAcc += qBlend * take
      qualityW += take
      synthHqUnits += takeHQ
      synthLqUnits += takeLQ
      syntheticUnits += takeHQ + takeLQ
    }
    // V3 never conjures a synthetic shortfall at train start. Labs must first
    // generate or buy those tokens, so player and rivals contest real stocks.
    void short
  }

  // Coverage from **actual attributed** volume (not wishful plan total)
  const actualVolume =
    Math.round(Object.values(consumed).reduce((s, v) => s + (v ?? 0), 0) * 1e9) / 1e9
  const coverage = isContinue
    ? Math.min(30, actualVolume / Math.max(1, newSinceTrain * 0.5 + 1))
    : Math.min(30, actualVolume / Math.max(1, minMTok))
  let qualityUsed = qualityW > 0 ? qualityAcc / qualityW : 40
  const synthLqShare = qualityW > 0 ? synthLqUnits / qualityW : 0
  if (synthLqShare > 0.08) {
    qualityUsed = Math.max(12, qualityUsed * (1 - synthLqShare * 0.35))
  }

  return {
    ok: true,
    plan: { ...plan, totalMTok: Math.max(actualVolume, 1), totalUnits: Math.max(actualVolume, 1) },
    consumed,
    coverage,
    qualityUsed,
    syntheticUnits,
    synthHqUnits,
    synthLqUnits,
    synthLqShare,
    cashCost,
    nextData: cloneLabData(dataIn),
    trainMTok: actualVolume * trainShare,
    verifyMTok: actualVolume * (1 - trainShare),
    domainQuality,
    lowQualityShareByDomain,
    specialistBoosts,
  }
}

/** Player wrapper — same recipe as rivals via consumeForLabData. */
export function consumeForTraining(
  state: SimState,
  planIn: TrainingDataPlan | undefined,
  paramsB: number,
  family: string,
  legacyMix?: string,
  opts?: {
    mode?: 'pretrain' | 'distill' | 'continue'
    priorWatermarkMTok?: number
  },
): ConsumeResult {
  // Specialist domain models still need full player resolve — re-run blend with boosts
  const base = consumeForLabData(ensureLabData(state), planIn, paramsB, family, {
    mode: opts?.mode,
    priorWatermarkMTok: opts?.priorWatermarkMTok,
    hasSynthResearch: state.player.researchUnlocked.includes('data_synth'),
    legacyMix,
  })
  const canAutoSynthesize =
    !!planIn?.allowSynthetic &&
    state.player.researchUnlocked.includes('data_synth') &&
    state.player.models.length > 0
  if (canAutoSynthesize) {
    const weights = normalizeWeights(base.plan.weights)
    const wanted = Math.max(1, planIn?.totalMTok ?? planIn?.totalUnits ?? base.plan.totalMTok)
    const consumed = { ...base.consumed }
    const domainQuality = { ...base.domainQuality }
    const lowQualityShareByDomain = { ...base.lowQualityShareByDomain }
    const syntheticProvenance: SyntheticFillRecord[] = []
    let syntheticAdded = 0
    let qualityAcc = 0
    let qualityVolume = 0
    const verifierBonus = hasCorpusSpecialists(state) ? 8 : 0
    for (const domain of DATA_DOMAINS) {
      const short = Math.max(0, wanted * weights[domain] - (consumed[domain] ?? 0))
      if (short <= 0.01) continue
      const teacher = state.player.models
        .filter((model) => modelCanCurateDataDomain(model, domain))
        .toSorted(
          (a, b) => specialistDomainBoost(b, domain) - specialistDomainBoost(a, domain),
        )[0]
      if (!teacher) continue
      const teacherSignal = specialistDomainBoost(teacher, domain)
      const quality = Math.min(92, 48 + teacherSignal * 1.8 + verifierBonus)
      const qualityTier = quality >= 58 ? 'hq' as const : 'lq' as const
      const prior = consumed[domain] ?? 0
      const priorQuality = domainQuality[domain] ?? base.qualityUsed
      consumed[domain] = prior + short
      domainQuality[domain] = (priorQuality * prior + quality * short) / Math.max(0.01, prior + short)
      lowQualityShareByDomain[domain] = qualityTier === 'lq' ? short / Math.max(0.01, prior + short) : 0
      syntheticAdded += short
      syntheticProvenance.push({
        domain,
        teacherModelId: teacher.id,
        teacherName: teacher.name,
        volumeMTok: short,
        quality,
        qualityTier,
      })
    }
    const actualVolume = Object.values(consumed).reduce((sum, value) => sum + (value ?? 0), 0)
    for (const domain of DATA_DOMAINS) {
      const volume = consumed[domain] ?? 0
      if (volume <= 0) continue
      qualityAcc += (domainQuality[domain] ?? base.qualityUsed) * volume
      qualityVolume += volume
    }
    const trainShare = base.plan.trainShare
    return {
      ...base,
      plan: { ...base.plan, totalMTok: actualVolume, totalUnits: actualVolume },
      consumed,
      coverage: Math.min(30, actualVolume / Math.max(1, minDataMTokForParams(paramsB))),
      qualityUsed: qualityVolume > 0 ? qualityAcc / qualityVolume : base.qualityUsed,
      syntheticUnits: base.syntheticUnits + syntheticAdded,
      synthHqUnits:
        (base.synthHqUnits ?? 0) + syntheticProvenance.filter((item) => item.qualityTier === 'hq').reduce((sum, item) => sum + item.volumeMTok, 0),
      synthLqUnits:
        (base.synthLqUnits ?? 0) + syntheticProvenance.filter((item) => item.qualityTier === 'lq').reduce((sum, item) => sum + item.volumeMTok, 0),
      synthLqShare:
        actualVolume > 0
          ? ((base.synthLqUnits ?? 0) + syntheticProvenance.filter((item) => item.qualityTier === 'lq').reduce((sum, item) => sum + item.volumeMTok, 0)) / actualVolume
          : 0,
      cashCost: base.cashCost + syntheticAdded * 250,
      trainMTok: actualVolume * trainShare,
      verifyMTok: actualVolume * (1 - trainShare),
      domainQuality,
      lowQualityShareByDomain,
      syntheticProvenance,
      nextData: cloneLabData(ensureLabData(state)),
    }
  }
  // Re-apply specialist boosts when unlocked (player-only feature)
  if (!hasCorpusSpecialists(state) || !planIn?.domainModels) {
    return { ...base, nextData: cloneLabData(ensureLabData(state)) }
  }
  // Rebuild with specialist quality bumps on domains that have models
  let qualityAcc = 0
  let qualityW = 0
  const domainQuality = { ...base.domainQuality }
  for (const d of DATA_DOMAINS) {
    const take = base.consumed[d] ?? 0
    if (take <= 0) continue
    const mid = planIn.domainModels[d]
    let boost = 0
    if (mid) {
      const m = resolveDomainModel(state, mid)
      if (m && modelCanCurateDataDomain(m, d)) boost = specialistDomainBoost(m, d)
    }
    const q = Math.min(98, (domainQuality[d] ?? base.qualityUsed) + boost)
    domainQuality[d] = q
    qualityAcc += q * take
    qualityW += take
  }
  return {
    ...base,
    domainQuality,
    qualityUsed: qualityW > 0 ? qualityAcc / qualityW : base.qualityUsed,
    nextData: cloneLabData(ensureLabData(state)),
  }
}

/** New MTok available for continue-train on a model (since its watermark). */
export function newDataSinceModel(
  state: SimState,
  model: { dataWatermarkMTok?: number } | null | undefined,
): number {
  const data = ensureLabData(state)
  const now = totalProcessed(data)
  const mark = model?.dataWatermarkMTok ?? 0
  return Math.max(0, now - mark)
}

export function grantPartnershipData(state: SimState): SimState {
  const data = cloneLabData(ensureLabData(state))
  for (const d of DATA_DOMAINS) {
    const add = DATA_ECONOMY.partnershipMTok[d] ?? 0
    if (add <= 0) continue
    const s = data.stocks[d]
    const q = DATA_ECONOMY.partnershipQuality
    const np = s.processed + add
    s.quality = np > 0 ? (s.quality * s.processed + q * add) / np : q
    s.processed = np
    s.fromBought = (s.fromBought ?? 0) + add
    data.lifetimeProcessed += add
    data.lifetimeCollected += add
  }
  return { ...state, player: { ...state.player, data } }
}

export function ensureDataMarket(state: SimState): SimState {
  if (state.dataMarket?.offers?.length) return state
  const rivals = state.rivals.map((r) => r.name)
  const offers = generateDataMarketOffers(state.seed, state.day, rivals, 11)
  return {
    ...state,
    dataMarket: {
      offers,
      lastRefreshDay: state.day,
      nextRefreshDay: state.day + 5,
    },
  }
}

/** Age listings, drop expired, periodic refresh of the open data market. */
export function tickDataMarket(state: SimState): SimState {
  let s = ensureDataMarket(state)
  const market = s.dataMarket!
  let offers = market.offers.map((o) => ({
    ...o,
    daysLeft: Math.max(0, o.daysLeft - 1),
  }))
  // Drop expired empty-ish listings; keep stocked ones a bit longer
  offers = offers.filter((o) => o.daysLeft > 0 || o.mTokLeft > 0)
  offers = offers.map((o) => (o.daysLeft <= 0 ? { ...o, mTokLeft: 0 } : o))

  let lastRefreshDay = market.lastRefreshDay
  let nextRefreshDay = market.nextRefreshDay
  if (s.day >= nextRefreshDay) {
    const rivals = s.rivals.map((r) => r.name)
    const fresh = generateDataMarketOffers(s.seed, s.day, rivals, 10 + (s.day % 4))
    // Keep remaining stock on still-active IDs if any; else full replace
    offers = fresh
    lastRefreshDay = s.day
    nextRefreshDay = s.day + 4 + (s.day % 5)
  }

  return {
    ...s,
    dataMarket: { offers, lastRefreshDay, nextRefreshDay },
  }
}

/**
 * Buy one lot from a market listing (or remaining MTok if smaller).
 * Scrap is cheap/low quality; curated is expensive/high quality.
 */
export function buyDomainContract(state: SimState, contractId: string): SimState {
  let s = ensureDataMarket(state)
  const market = s.dataMarket!
  const idx = market.offers.findIndex((x) => x.id === contractId)
  if (idx < 0) return alert(s, 'warn', 'That listing is no longer on the market.')
  const c = market.offers[idx]!
  if (c.mTokLeft <= 0) {
    return alert(s, 'warn', `${c.name} is sold out — wait for the next market refresh.`)
  }
  const buyMTok = Math.min(c.lotMTok, c.mTokLeft)
  const frac = buyMTok / Math.max(1, c.lotMTok)
  const cash = Math.max(50_000, Math.round(c.cash * frac))
  if (s.player.cash < cash) {
    return alert(s, 'warn', `Need $${(cash / 1e6).toFixed(2)}M for ${buyMTok} MTok.`)
  }
  return queueDataOfferOrder(s, s.playerLabId, contractId)
}

export type DataPortfolioChannel = 'open' | 'broker' | 'enterprise' | 'rival'

function portfolioChannel(seller: DataSellerKind): DataPortfolioChannel {
  if (seller === 'web_scrape' || seller === 'opensource') return 'open'
  if (seller === 'enterprise' || seller === 'research_lab') return 'enterprise'
  if (seller === 'rival') return 'rival'
  return 'broker'
}

/** Queue a diversified set of live market lots up to the player's chosen budget. */
export function buyDataPortfolio(
  state: SimState,
  budget: number,
  mix: Record<DataPortfolioChannel, number>,
): SimState {
  let next = ensureDataMarket(state)
  const cap = Math.max(250_000, Math.min(budget, state.player.cash))
  const existing = new Set(
    next.worldMarkets.orders
      .filter((order) => order.labId === state.playerLabId && order.kind === 'data')
      .map((order) => order.resourceId),
  )
  const candidates = next.dataMarket!.offers
    .filter(
      (offer) =>
        offer.mTokLeft > 0 &&
        !existing.has(offer.id) &&
        (mix[portfolioChannel(offer.sellerKind)] ?? 0) > 0,
    )
    .toSorted((left, right) => {
      const leftWeight = Math.max(0.01, mix[portfolioChannel(left.sellerKind)] ?? 0)
      const rightWeight = Math.max(0.01, mix[portfolioChannel(right.sellerKind)] ?? 0)
      const leftValue = leftWeight * left.quality * Math.min(left.lotMTok, left.mTokLeft) / left.cash
      const rightValue = rightWeight * right.quality * Math.min(right.lotMTok, right.mTokLeft) / right.cash
      return rightValue - leftValue
    })
  let committed = 0
  let volumeMTok = 0
  let lots = 0
  for (const offer of candidates) {
    if (committed + offer.cash > cap && lots > 0) continue
    const before = next.worldMarkets.orders.length
    next = queueDataOfferOrder(next, state.playerLabId, offer.id)
    if (next.worldMarkets.orders.length > before) {
      committed += offer.cash
      volumeMTok += Math.min(offer.lotMTok, offer.mTokLeft)
      lots += 1
    }
    if (committed >= cap * 0.92) break
  }
  if (lots === 0) return alert(next, 'warn', 'No live data lots fit this portfolio budget.')
  return alert(
    next,
    'info',
    `Portfolio submitted: ${lots} source lots · ${formatTokens(volumeMTok)} · up to $${(committed / 1e6).toFixed(2)}M reserved.`,
  )
}

export function listDomainContracts(state?: SimState): DomainDataContract[] {
  if (!state) return DOMAIN_DATA_CONTRACTS
  return ensureDataMarket(state).dataMarket?.offers ?? []
}

export function formatMix(weights: Partial<Record<DataDomain, number>>): string {
  const w = normalizeWeights(weights)
  return DATA_DOMAINS.filter((d) => w[d] >= 0.05)
    .map((d) => `${DATA_DOMAIN_META[d].label} ${Math.round(w[d] * 100)}%`)
    .join(' · ')
}

function alert(state: SimState, severity: 'info' | 'warn' | 'danger', message: string): SimState {
  return {
    ...state,
    alerts: [
      { id: `data-${state.day}-${message.slice(0, 14)}`, day: state.day, severity, message },
      ...state.alerts,
    ].slice(0, 40),
  }
}

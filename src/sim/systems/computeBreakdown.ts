/**
 * Live breakdown of where Train / Serve / Research PF goes and how full each pool is.
 * Pure read of SimState + computeSnapshot — for HUD tooltips and live fill bars.
 */
import { ECONOMY } from '../balance/economy'
import {
  familyServeMult,
  inferenceCapacityMTok,
  inferencePfDemand,
  pfPerMTokForModel,
  sizeTokMult,
} from '../balance/serveCompute'
import {
  planExposedModelIds,
  releasedRouterMemberIds,
  soldApiRouters,
} from '../balance/modelRouter'
import { gymResearchReservationShare } from '../balance/modelStudio'
import { getResearchNode } from '../balance/research'
import { formatParams } from '../balance/training'
import { defaultServePrecisionForModel } from '../balance/tokenServe'
import type {
  Model,
  PlanDayStats,
  PlanModelUsage,
  ServePrecision,
  SimState,
  SubPlan,
} from '../types'
import { isLivePublicModel } from '../modelRelease'
import { computeSnapshot, normalizeAllocation, type ComputeSnapshot } from './compute'
import { estimateResearchRate, researchPfTarget } from './research'
import {
  dataResearchReservationShare,
  ensureLabData,
  researchPoolForTech,
} from './data'
import { planComputePriority, planModelTrafficMix } from './plans'
import {
  hostedServingModels,
  servingPrecisionForModel,
} from './servingPlacement'
import { playerStaff } from './staff'
import { assignedResearchPrograms } from './researchPrograms'
import { playerTrainingJobs, playerTrainingResourcePlan } from './training'
import { serveInfraCost } from '../balance/pricing'
import { energyPriceForState } from './map'

export type PoolId = 'training' | 'inference' | 'research'

export interface BreakdownLine {
  label: string
  value: string
  /** 0–1 fill bar when meaningful */
  bar?: number
  warn?: boolean
  muted?: boolean
}

export interface PoolBreakdown {
  id: PoolId
  title: string
  /** Effective PF in this pool today */
  poolPf: number
  /** Incremental physical fleet draw attributed to this pool. */
  powerMw: number
  /** Share of allocation (0–1) */
  allocShare: number
  /**
   * How hard the pool is working:
   * - serve: used PF / allocated inference PF (can exceed 1)
   * - train: assigned train/safety occupancy / train pool (not format-derated burn)
   * - research: research consumers / research pool
   */
  utilization: number
  utilizationLabel: string
  summary: string
  lines: BreakdownLine[]
}

export interface ComputeBreakdown {
  snap: ComputeSnapshot
  rawPf: number
  effectivePf: number
  /** Product of derates after util (power, racks, mem, …) — rough fleet tax */
  fleetYield: number
  train: PoolBreakdown
  serve: PoolBreakdown
  research: PoolBreakdown
  /** Live allocated-vs-used fills for HUD bars (same tick as lastMarket). */
  load: ComputeLoadView
}

/** Channel that contributed used PF on a live listed model. */
export type ServeMixKind = 'api' | 'plan'

/** Hover-ready plan/API mix for one model's used (or allocated) sub/API PF. */
export interface ServePlanMixEntry {
  kind: ServeMixKind
  /** Plan id when kind is `plan`. */
  planId?: string
  name: string
  /** Current subscribers (plans only). */
  subscribers?: number
  /** Served API MTok today (API channel only). */
  apiMTok?: number
  usedPf: number
  /**
   * This plan's share of the model's subscription PF (0–1).
   * API rows use share of the model's used PF that is API.
   */
  shareOfModelSubPf: number
  precision: ServePrecision
}

export interface ServeModelLoadRow {
  modelId: string
  name: string
  /** This model's reserved share of the inference pool. */
  allocatedPf: number
  usedPf: number
  apiUsedPf: number
  subUsedPf: number
  idlePf: number
  /** used / allocated; can exceed 1 when traffic outruns the reservation. */
  fill: number
  warn: boolean
  unserved: boolean
  planMix: ServePlanMixEntry[]
}

export interface ServePoolLoad {
  /** Inference PF reserved today (`lastMarket.capacityPf`, else the serve pool). */
  allocatedPf: number
  /** PF actually served (`lastMarket.servedPf`, else MTok × pfPerMTok). */
  usedPf: number
  idlePf: number
  fill: number
  apiUsedPf: number
  subUsedPf: number
  warn: boolean
  models: ServeModelLoadRow[]
}

export type TrainLoadConsumerKind = 'train' | 'safety'

export interface TrainLoadConsumer {
  id: string
  name: string
  kind: TrainLoadConsumerKind
  /** Raw train-pool PF assigned to this job (occupancy). */
  usedPf: number
  /** Format/hardware-derated useful burn from that assignment. */
  usefulPf: number
  share: number
}

export interface TrainPoolLoad {
  poolPf: number
  /** Raw PF assigned to active train/safety jobs. */
  usedPf: number
  /** Useful PF after training-format throughput. */
  usefulPf: number
  idlePf: number
  fill: number
  jobs: TrainLoadConsumer[]
}

export interface ComputeLoadView {
  serve: ServePoolLoad
  train: TrainPoolLoad
  research: ResearchComputeUsage
}

/** Live consumers of the shared research PF pool (tree/pods, data, gyms, safety). */
export type ResearchComputeConsumer =
  | 'tree'
  | 'synthetic'
  | 'prune'
  | 'gyms'
  | 'safety'

export interface ResearchComputeSlice {
  id: ResearchComputeConsumer
  label: string
  short: string
  share: number
  pf: number
}

export interface ResearchComputeUsage {
  /** Allocated research pool PF. */
  poolPf: number
  /** PF actually reserved by active research-side work. */
  usedPf: number
  idlePf: number
  /** Physical campus draw attributed to the research pool. */
  powerMw: number
  slices: ResearchComputeSlice[]
  techAvailablePf: number
}

const RESEARCH_SLICE_META: Record<
  ResearchComputeConsumer,
  { label: string; short: string }
> = {
  tree: { label: 'Tech / pods', short: 'tree' },
  synthetic: { label: 'Synthetic data', short: 'synth' },
  prune: { label: 'Corpus audit', short: 'prune' },
  gyms: { label: 'Post-train gyms', short: 'gyms' },
  safety: { label: 'Safety campaign', short: 'safety' },
}

function treeResearchActive(state: SimState): boolean {
  return (
    Boolean(state.player.activeResearch) ||
    assignedResearchPrograms(state).length > 0
  )
}

/** Split the research pool across tree/pods, synthetic, prune, gyms, and safety. */
export function researchComputeUsage(
  state: SimState,
  snap: ComputeSnapshot = computeSnapshot(state),
): ResearchComputeUsage {
  const poolPf = Math.max(0, snap.pools.research)
  const data = ensureLabData(state)
  const synthRaw = (data.synthQueue ?? []).reduce(
    (sum, job) => sum + Math.max(0, job.researchShare),
    0,
  )
  const pruneRaw = (data.pruneQueue ?? []).reduce(
    (sum, job) => sum + Math.max(0, job.researchShare),
    0,
  )
  const dataRaw = synthRaw + pruneRaw
  const dataShare = dataResearchReservationShare(data)
  const synthShare = dataRaw > 1e-9 ? dataShare * (synthRaw / dataRaw) : 0
  const pruneShare = dataRaw > 1e-9 ? dataShare * (pruneRaw / dataRaw) : 0
  const gymShare = gymResearchReservationShare(state.player.postTrainGyms)
  const safetyShare = state.player.safetyCampaign ? 0.4 : 0
  const techAvailableShare = researchPoolForTech(state)
  const techUsedShare = treeResearchActive(state) ? techAvailableShare : 0

  const slices: ResearchComputeSlice[] = []
  const push = (id: ResearchComputeConsumer, share: number) => {
    if (share <= 0.001) return
    slices.push({
      id,
      ...RESEARCH_SLICE_META[id],
      share,
      pf: poolPf * share,
    })
  }
  push('tree', techUsedShare)
  push('synthetic', synthShare)
  push('prune', pruneShare)
  push('gyms', gymShare)
  push('safety', safetyShare)

  const usedShare = Math.min(
    1,
    slices.reduce((sum, slice) => sum + slice.share, 0),
  )
  const usedPf = poolPf * usedShare
  return {
    poolPf,
    usedPf,
    idlePf: Math.max(0, poolPf - usedPf),
    powerMw: snap.mwBreakdown.research,
    slices,
    techAvailablePf: poolPf * techAvailableShare,
  }
}

function finiteNonNeg(n: number | undefined): number {
  return Number.isFinite(n) ? Math.max(0, n as number) : 0
}

function fallbackServeModel(state: SimState): Model | undefined {
  const live = state.player.models.filter(isLivePublicModel)
  return (
    live.find((model) => model.id === state.player.pricing.activeModelId) ??
    [...live].sort((a, b) => b.capability - a.capability)[0]
  )
}

function listedApiModelIds(state: SimState): Set<string> {
  const publicIds = new Set(
    state.player.models.filter(isLivePublicModel).map((model) => model.id),
  )
  const fallback = fallbackServeModel(state)
  const apiIds = new Set(
    (
      state.player.pricing.apiModelIds ?? (fallback ? [fallback.id] : [])
    ).filter((id) => publicIds.has(id)),
  )
  for (const router of soldApiRouters({
    apiRouterIds: state.player.pricing.apiRouterIds,
    apiModelIds: state.player.pricing.apiModelIds,
    activeModelRouterId: state.player.activeModelRouterId,
    routers: state.player.modelRouters,
    models: state.player.models,
  })) {
    for (const id of releasedRouterMemberIds(router, state.player.models)) {
      if (publicIds.has(id)) apiIds.add(id)
    }
  }
  return apiIds
}

function listedSubscriptionModelIds(state: SimState): Set<string> {
  const publicIds = new Set(
    state.player.models.filter(isLivePublicModel).map((model) => model.id),
  )
  const ids = new Set<string>()
  for (const plan of state.player.pricing.plans) {
    if (!plan.enabled) continue
    for (const id of planExposedModelIds(
      plan,
      state.player.models,
      state.player.modelRouters,
    )) {
      if (publicIds.has(id)) ids.add(id)
    }
  }
  if (ids.size === 0) {
    const fallback = fallbackServeModel(state)
    if (fallback) ids.add(fallback.id)
  }
  return ids
}

function usagePf(
  usage: Pick<PlanModelUsage, 'dayInferPf' | 'dayMTok'> | undefined,
  model: Model | undefined,
  servingEfficiency: number,
): number {
  if (!usage) return 0
  if (finiteNonNeg(usage.dayInferPf) > 1e-12) return finiteNonNeg(usage.dayInferPf)
  if (finiteNonNeg(usage.dayMTok) > 1e-12 && model) {
    return inferencePfDemand(usage.dayMTok, model, servingEfficiency)
  }
  return finiteNonNeg(usage.dayInferPf)
}

function mtokToPf(
  mtok: number,
  model: Model | undefined,
  servingEfficiency: number,
): number {
  if (mtok <= 1e-12) return 0
  if (model) return inferencePfDemand(mtok, model, servingEfficiency)
  return (
    mtok *
    pfPerMTokForModel(
      { paramsB: 7, activeParamsB: 7, family: 'dense', inferCostMult: 1 },
      servingEfficiency,
    )
  )
}

function modelById(state: SimState, id: string): Model | undefined {
  return state.player.models.find((model) => model.id === id)
}

function planPrecision(plan: SubPlan, model: Model): ServePrecision {
  return (
    plan.servePrecisionByModel?.[model.id] ??
    defaultServePrecisionForModel(model)
  )
}

function addAlloc(target: Map<string, number>, id: string, pf: number) {
  if (pf <= 1e-15) return
  target.set(id, (target.get(id) ?? 0) + pf)
}

function splitPoolByPfWeights(
  poolPf: number,
  items: readonly { id: string; weight: number }[],
): Map<string, number> {
  const out = new Map<string, number>()
  const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0)
  if (poolPf <= 1e-15 || items.length === 0) return out
  if (total <= 1e-15) {
    const each = poolPf / items.length
    for (const item of items) addAlloc(out, item.id, each)
    return out
  }
  for (const item of items) {
    addAlloc(out, item.id, poolPf * (Math.max(0, item.weight) / total))
  }
  return out
}

function mergeAlloc(
  into: Map<string, number>,
  from: Map<string, number>,
) {
  for (const [id, pf] of from) addAlloc(into, id, pf)
}

/** Train/safety PF currently occupying the train pool (raw assigned, not format burn). */
export function trainPoolLoad(
  state: SimState,
  snap: ComputeSnapshot = computeSnapshot(state),
): TrainPoolLoad {
  const poolPf = Math.max(0, snap.pools.training)
  const resources = playerTrainingResourcePlan(state, snap)
  const jobs: TrainLoadConsumer[] = []
  for (const job of playerTrainingJobs(state)) {
    const active =
      !job.paused &&
      !job.failed &&
      !job.pendingCampaignEvent &&
      (job.computePriority ?? 50) > 0
    const allocation = resources.jobs[job.id]
    const usedPf = active ? finiteNonNeg(allocation?.rawPf) : 0
    const usefulPf = active ? finiteNonNeg(allocation?.effectivePf) : 0
    if (!active && usedPf <= 1e-12) continue
    jobs.push({
      id: job.id,
      name: job.name || `Training ${formatParams(job.targetParamsB)}`,
      kind: 'train',
      usedPf,
      usefulPf,
      share: 0,
    })
  }
  const campaign = state.player.safetyCampaign
  if (campaign) {
    jobs.push({
      id: campaign.id,
      name: `${campaign.modelName ?? campaign.modelId} safety`,
      kind: 'safety',
      usedPf: finiteNonNeg(resources.safetyCampaign?.rawPf),
      usefulPf: finiteNonNeg(resources.safetyCampaign?.effectivePf),
      share: 0,
    })
  }
  const usedPf = jobs.reduce((sum, job) => sum + job.usedPf, 0)
  const usefulPf = jobs.reduce((sum, job) => sum + job.usefulPf, 0)
  const shareDenom = usedPf > 1e-12 ? usedPf : poolPf
  for (const job of jobs) {
    job.share = shareDenom > 1e-12 ? job.usedPf / shareDenom : 0
  }
  return {
    poolPf,
    usedPf,
    usefulPf,
    idlePf: Math.max(0, poolPf - usedPf),
    fill: poolPf > 1e-9 ? usedPf / poolPf : usedPf > 1e-12 ? 1 : 0,
    jobs,
  }
}

/**
 * Serve allocated vs used, including per-model rows and hover mix.
 * Numbers come from lastMarket + placement/mix already computed this tick.
 */
export function servePoolLoad(
  state: SimState,
  snap: ComputeSnapshot = computeSnapshot(state),
): ServePoolLoad {
  const lm = state.lastMarket
  const serveEff = state.player.servingEfficiency
  const hosted = hostedServingModels({
    models: state.player.models,
    pricing: state.player.pricing,
    modelRouters: state.player.modelRouters,
    activeModelRouterId: state.player.activeModelRouterId,
  })
  const fallback = fallbackServeModel(state)
  const allocatedPf = (() => {
    const cap = finiteNonNeg(lm.capacityPf)
    if (cap > 1e-12) return cap
    const pool = Math.max(0, snap.pools.inference)
    if (pool > 1e-12) return pool
    return mtokToPf(finiteNonNeg(lm.capacityMTok), fallback, serveEff)
  })()

  const apiUsages = lm.apiModelUsage ?? []
  const planStats = lm.planStats ?? []
  const apiUsedFromUsage = apiUsages.reduce(
    (sum, usage) =>
      sum + usagePf(usage, modelById(state, usage.modelId), serveEff),
    0,
  )
  const subUsedFromUsage = planStats.reduce((sum, plan) => {
    const rows = plan.modelUsage ?? []
    if (rows.length > 0) {
      return (
        sum +
        rows.reduce(
          (inner, usage) =>
            inner + usagePf(usage, modelById(state, usage.modelId), serveEff),
          0,
        )
      )
    }
    return sum + usagePf(
      { dayInferPf: plan.dayInferPf, dayMTok: plan.dayMTok },
      fallback,
      serveEff,
    )
  }, 0)

  const usedPf = (() => {
    const served = lm.servedPf
    if (served != null && Number.isFinite(served) && served > 1e-12) return served
    if (apiUsedFromUsage + subUsedFromUsage > 1e-12) {
      return apiUsedFromUsage + subUsedFromUsage
    }
    return mtokToPf(finiteNonNeg(lm.servedMTok), fallback, serveEff)
  })()

  let apiUsedPf = apiUsedFromUsage
  let subUsedPf = subUsedFromUsage
  if (apiUsedPf + subUsedPf <= 1e-12 && usedPf > 1e-12) {
    const apiM = finiteNonNeg(lm.apiDayMTok)
    const subM = planStats.reduce((sum, plan) => sum + finiteNonNeg(plan.dayMTok), 0)
    const tokenTotal = apiM + subM
    if (tokenTotal > 1e-12) {
      apiUsedPf = usedPf * (apiM / tokenTotal)
      subUsedPf = usedPf * (subM / tokenTotal)
    } else {
      const apiPrio =
        lm.apiVsSubPriority ??
        state.player.pricing.apiVsSubPriority ??
        ECONOMY.defaultApiVsSubPriority
      apiUsedPf = usedPf * apiPrio
      subUsedPf = usedPf * (1 - apiPrio)
    }
  } else if (usedPf > 1e-12 && apiUsedPf + subUsedPf > 1e-12) {
    const raw = apiUsedPf + subUsedPf
    apiUsedPf = usedPf * (apiUsedPf / raw)
    subUsedPf = usedPf * (subUsedPf / raw)
  }

  const apiPrio = Math.max(
    0,
    Math.min(
      1,
      lm.apiVsSubPriority ??
        state.player.pricing.apiVsSubPriority ??
        ECONOMY.defaultApiVsSubPriority ??
        0.68,
    ),
  )
  const apiPoolPf = finiteNonNeg(lm.apiPoolPf) > 1e-12
    ? finiteNonNeg(lm.apiPoolPf)
    : allocatedPf * apiPrio
  const subPoolPf = finiteNonNeg(lm.subPoolPf) > 1e-12
    ? finiteNonNeg(lm.subPoolPf)
    : allocatedPf * (1 - apiPrio)

  const apiIds = listedApiModelIds(state)
  const subIds = listedSubscriptionModelIds(state)
  const allocatedByModel = new Map<string, number>()

  const apiHosted = hosted.filter((model) => apiIds.has(model.id))
  mergeAlloc(
    allocatedByModel,
    splitPoolByPfWeights(
      apiPoolPf,
      apiHosted.map((model) => ({
        id: model.id,
        weight: Math.max(1e-6, inferencePfDemand(1, model, serveEff)),
      })),
    ),
  )

  const enabledPlans = state.player.pricing.plans.filter((plan) => plan.enabled)
  const planLanes = enabledPlans.map((plan) => {
    const mix = planModelTrafficMix(state, plan)
    return {
      plan,
      mix,
      priority: mix.length > 0 ? planComputePriority(plan) : 0,
    }
  })
  const planPriorityTotal = planLanes.reduce((sum, lane) => sum + lane.priority, 0)
  if (planPriorityTotal > 1e-12 && subPoolPf > 1e-15) {
    for (const lane of planLanes) {
      if (lane.mix.length === 0 || lane.priority <= 0) continue
      const planShare = lane.priority / planPriorityTotal
      const weights = lane.mix.map((part) => ({
        id: part.model.id,
        weight: Math.max(
          1e-9,
          inferencePfDemand(part.share, part.model, serveEff),
        ),
      }))
      mergeAlloc(
        allocatedByModel,
        splitPoolByPfWeights(subPoolPf * planShare, weights),
      )
    }
  } else {
    const subHosted = hosted.filter((model) => subIds.has(model.id))
    mergeAlloc(
      allocatedByModel,
      splitPoolByPfWeights(
        subPoolPf,
        subHosted.map((model) => ({
          id: model.id,
          weight: Math.max(1e-6, inferencePfDemand(1, model, serveEff)),
        })),
      ),
    )
  }

  const models: ServeModelLoadRow[] = hosted.map((model) => {
    const apiUsage = apiUsages.find((usage) => usage.modelId === model.id)
    const apiUsed = usagePf(apiUsage, model, serveEff)
    const planUsedRows: {
      plan: PlanDayStats
      configured?: SubPlan
      usage?: PlanModelUsage
      usedPf: number
    }[] = []
    for (const plan of planStats) {
      const configured = enabledPlans.find((item) => item.id === plan.planId)
      const usage = plan.modelUsage?.find((row) => row.modelId === model.id)
      const used = usage
        ? usagePf(usage, model, serveEff)
        : plan.modelUsage == null &&
            (configured
              ? planExposedModelIds(
                  configured,
                  state.player.models,
                  state.player.modelRouters,
                ).includes(model.id)
              : false)
          ? usagePf(
              { dayInferPf: plan.dayInferPf, dayMTok: plan.dayMTok },
              model,
              serveEff,
            )
          : 0
      const mixHit = configured
        ? planModelTrafficMix(state, configured).some((part) => part.model.id === model.id)
        : false
      if (usage || used > 1e-12 || mixHit) {
        planUsedRows.push({ plan, configured, usage, usedPf: used })
      }
    }
    for (const plan of enabledPlans) {
      if (planUsedRows.some((row) => row.plan.planId === plan.id)) continue
      const mix = planModelTrafficMix(state, plan)
      if (!mix.some((part) => part.model.id === model.id)) continue
      planUsedRows.push({
        plan: {
          planId: plan.id,
          name: plan.name,
          subscribers: 0,
          dayRevenue: 0,
          dayCogs: 0,
          allocatedComputeCostDay: 0,
          dayMTok: 0,
          dayInferPf: 0,
          computePfPerSubscriber: 0,
          costPerSubDay: 0,
          marginPerSubMonth: 0,
          isFree: plan.pricePerMonth <= 0,
          usageRate: 0,
        },
        configured: plan,
        usedPf: 0,
      })
    }

    const subUsed = planUsedRows.reduce((sum, row) => sum + row.usedPf, 0)
    const used = apiUsed + subUsed
    const allocated = allocatedByModel.get(model.id) ?? 0
    const fill = allocated > 1e-9 ? used / allocated : used > 1e-12 ? 2 : 0
    const unserved = used > allocated + 1e-9 && (allocated > 1e-12 || used > 1e-12)

    const planMix: ServePlanMixEntry[] = []
    if (apiIds.has(model.id) || apiUsed > 1e-12) {
      planMix.push({
        kind: 'api',
        name: 'API',
        apiMTok: apiUsage?.dayMTok ?? 0,
        usedPf: apiUsed,
        shareOfModelSubPf: used > 1e-12 ? apiUsed / used : 0,
        precision:
          state.player.pricing.apiServePrecisionByModel?.[model.id] ??
          servingPrecisionForModel(
            state.player.pricing,
            model,
            true,
            state.player.modelRouters,
          ),
      })
    }
    const idleSubWeight = planUsedRows.reduce((sum, row) => {
      const mixShare = row.configured
        ? (planModelTrafficMix(state, row.configured).find(
            (part) => part.model.id === model.id,
          )?.share ?? 0)
        : 0
      return (
        sum +
        mixShare *
          planComputePriority(row.configured ?? { pricePerMonth: 0, computePriority: 50 })
      )
    }, 0)
    for (const row of planUsedRows) {
      const mixShare = row.configured
        ? (planModelTrafficMix(state, row.configured).find(
            (part) => part.model.id === model.id,
          )?.share ?? 0)
        : 0
      const shareOfModelSubPf =
        subUsed > 1e-12
          ? row.usedPf / subUsed
          : idleSubWeight > 1e-12
            ? (mixShare *
                planComputePriority(
                  row.configured ?? { pricePerMonth: 0, computePriority: 50 },
                )) /
              idleSubWeight
            : mixShare
      planMix.push({
        kind: 'plan',
        planId: row.plan.planId,
        name: row.plan.name,
        subscribers: row.plan.subscribers,
        usedPf: row.usedPf,
        shareOfModelSubPf,
        precision: row.configured
          ? planPrecision(row.configured, model)
          : defaultServePrecisionForModel(model),
      })
    }

    return {
      modelId: model.id,
      name: model.name,
      allocatedPf: allocated,
      usedPf: used,
      apiUsedPf: apiUsed,
      subUsedPf: subUsed,
      idlePf: Math.max(0, allocated - used),
      fill,
      warn: unserved,
      unserved,
      planMix,
    }
  })

  const fill = allocatedPf > 1e-9 ? usedPf / allocatedPf : usedPf > 1e-12 ? 2 : 0
  return {
    allocatedPf,
    usedPf,
    idlePf: Math.max(0, allocatedPf - usedPf),
    fill,
    apiUsedPf,
    subUsedPf,
    warn: fill > 1.02,
    models,
  }
}

export function computeLoadView(
  state: SimState,
  snap: ComputeSnapshot = computeSnapshot(state),
): ComputeLoadView {
  return {
    serve: servePoolLoad(state, snap),
    train: trainPoolLoad(state, snap),
    research: researchComputeUsage(state, snap),
  }
}

function fmtPf(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 100) return n.toFixed(0)
  if (Math.abs(n) >= 10) return n.toFixed(1)
  if (Math.abs(n) >= 1) return n.toFixed(2)
  return n.toFixed(3)
}

function fmtMTok(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`
  if (Math.abs(n) >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

function pct01(n: number): string {
  return `${Math.round(Math.max(0, n) * 100)}%`
}

export function buildComputeBreakdown(state: SimState): ComputeBreakdown {
  const snap = computeSnapshot(state)
  const alloc = normalizeAllocation(state.player.allocation)
  const rawPf = snap.rawFlopsPf
  const effectivePf = snap.effectiveFlopsPf
  const fleetYield = rawPf > 1e-9 ? effectivePf / rawPf : 0
  const load = computeLoadView(state, snap)

  const train = buildTrainBreakdown(state, snap, alloc.training, load.train)
  const serve = buildServeBreakdown(state, snap, alloc.inference, load.serve)
  const research = buildResearchBreakdown(state, alloc.research, load.research)

  return {
    snap,
    rawPf,
    effectivePf,
    fleetYield,
    train,
    serve,
    research,
    load,
  }
}

function buildTrainBreakdown(
  state: SimState,
  snap: ComputeSnapshot,
  allocShare: number,
  load: TrainPoolLoad,
): PoolBreakdown {
  const poolPf = snap.pools.training
  const powerMw = snap.mwBreakdown.training
  const listedJobs = state.player.trainingJobs ?? []
  const legacyJob = state.player.trainingJob
  const jobs = legacyJob
    ? [legacyJob, ...listedJobs.filter((entry) => entry.id !== legacyJob.id)]
    : listedJobs
  const activeJobs = jobs.filter(
    (entry) =>
      !entry.paused &&
      !entry.failed &&
      !entry.pendingCampaignEvent &&
      (entry.computePriority ?? 50) > 0,
  )
  const job = activeJobs[0] ?? legacyJob ?? listedJobs[0]
  const lines: BreakdownLine[] = [
    {
      label: 'Pool PF',
      value: `${fmtPf(poolPf)} PF`,
    },
    {
      label: 'In use',
      value: `${fmtPf(load.usedPf)} / ${fmtPf(poolPf)} PF`,
      bar: poolPf > 1e-9 ? Math.min(1, load.fill) : 0,
    },
    {
      label: 'Useful burn',
      value: `${fmtPf(load.usefulPf)} PF`,
      muted: load.usefulPf + 1e-9 < load.usedPf,
    },
    {
      label: 'Power draw',
      value:
        powerMw <= 1e-6 && load.usedPf > 1e-9
          ? 'Cloud-powered (0.000 MW campus)'
          : `${powerMw.toFixed(3)} MW`,
    },
    {
      label: 'Allocation',
      value: pct01(allocShare),
      bar: allocShare,
    },
    {
      label: 'Train efficiency',
      value: pct01(state.player.trainEfficiency),
    },
    {
      label: 'VRAM derate',
      value: pct01(snap.vramDerateTrain),
      warn: snap.vramDerateTrain < 0.9,
      bar: snap.vramDerateTrain,
    },
  ]

  let utilization = load.fill
  let utilizationLabel = 'Idle'
  let summary = 'No training job — train PF is idle.'

  if (activeJobs.length > 0 || state.player.safetyCampaign) {
    const totalRemaining = activeJobs.reduce(
      (sum, entry) => sum + Math.max(0, entry.targetPfDays - entry.progressPfDays),
      0,
    )
    const burn = load.usefulPf
    const daysLeft = burn > 1e-6 ? totalRemaining / burn : Infinity
    utilizationLabel =
      load.usedPf <= 1e-9
        ? 'Stalled'
        : activeJobs.length > 1
          ? `${activeJobs.length} jobs`
          : 'In use'
    const headline = job
      ? `Training ${formatParams(job.targetParamsB)}`
      : 'Safety campaign running'
    summary =
      activeJobs.length > 1
        ? `${headline} · ${activeJobs.length} active jobs share the train pool.`
        : `${headline} · ${pct01(job ? job.progressPfDays / Math.max(1e-6, job.targetPfDays) : 0)} complete.`
    if (job) {
      lines.push(
        {
          label: activeJobs.length > 1 ? 'Lead job' : 'Job',
          value: `${job.mode ?? 'pretrain'} · ${formatParams(job.targetParamsB)}`,
        },
        {
          label: 'Progress',
          value: `${fmtPf(job.progressPfDays)} / ${fmtPf(job.targetPfDays)} PF·d`,
          bar: Math.min(1, job.progressPfDays / Math.max(1e-6, job.targetPfDays)),
        },
      )
    }
    if (activeJobs.length > 1) {
      lines.push({
        label: 'Active jobs',
        value: String(activeJobs.length),
      })
    }
    if (state.player.safetyCampaign) {
      lines.push({
        label: 'Safety campaign',
        value: state.player.safetyCampaign.modelId,
        muted: true,
      })
    }
    if (load.jobs.length > 0) {
      for (const consumer of load.jobs) {
        lines.push({
          label: consumer.kind === 'safety' ? 'Safety' : consumer.name,
          value:
            consumer.usefulPf + 1e-9 < consumer.usedPf
              ? `${fmtPf(consumer.usedPf)} PF occ · ${fmtPf(consumer.usefulPf)} useful · ${pct01(consumer.share)}`
              : `${fmtPf(consumer.usedPf)} PF · ${pct01(consumer.share)}`,
          bar: Math.min(1, consumer.share),
        })
      }
    }
    if (load.idlePf > 0.001) {
      lines.push({
        label: 'Idle',
        value: `${fmtPf(load.idlePf)} PF`,
        muted: true,
      })
    }
    lines.push(
      {
        label: 'Burn today',
        value: `${fmtPf(burn)} PF (shared pool)`,
      },
      {
        label: 'ETA',
        value: Number.isFinite(daysLeft) ? `~${Math.ceil(daysLeft)}d` : '—',
      },
    )
  } else {
    lines.push({
      label: 'Status',
      value: 'Idle — start a train job in Lab → Models',
      muted: true,
    })
  }

  return {
    id: 'training',
    title: 'Train pool',
    poolPf,
    powerMw,
    allocShare,
    utilization,
    utilizationLabel,
    summary,
    lines,
  }
}

function buildServeBreakdown(
  state: SimState,
  snap: ComputeSnapshot,
  allocShare: number,
  load: ServePoolLoad,
): PoolBreakdown {
  const poolPf = snap.pools.inference
  const powerMw = snap.mwBreakdown.inference
  const lm = state.lastMarket
  const model = state.player.models.find(
    (m) =>
      m.id === state.player.pricing.activeModelId &&
      isLivePublicModel(m),
  )
  const liveCap =
    model != null
      ? inferenceCapacityMTok(snap, model, state.player.servingEfficiency, allocShare)
      : lm.capacityMTok ?? 0
  const demandM = lm.playerDemandMTok ?? 0
  const util = load.fill
  const utilClamped = Math.min(1, util)

  const pfPer =
    model != null
      ? pfPerMTokForModel(model, state.player.servingEfficiency)
      : pfPerMTokForModel(
          {
            paramsB: 7,
            activeParamsB: 7,
            family: 'dense',
            inferCostMult: 1,
          },
          state.player.servingEfficiency,
        )

  const apiDemand = lm.apiDemandMTok ?? 0
  const planDemand = Math.max(0, demandM - apiDemand)
  const apiPrio =
    lm.apiVsSubPriority ??
    state.player.pricing.apiVsSubPriority ??
    ECONOMY.defaultApiVsSubPriority
  const apiPoolM = liveCap * apiPrio
  const subPoolM = liveCap * (1 - apiPrio)

  let costPer = 0
  try {
    costPer = serveInfraCost(state, snap, energyPriceForState(state)).costPerMTok
  } catch {
    costPer = 0
  }

  const hwTps = snap.chipCount * snap.avgTokPerSecPerChip
  const lines: BreakdownLine[] = [
    {
      label: 'Used / allocated',
      value: `${fmtPf(load.usedPf)} / ${fmtPf(load.allocatedPf)} PF`,
      bar: utilClamped,
      warn: load.warn,
    },
    {
      label: 'API vs subs used',
      value: `${fmtPf(load.apiUsedPf)} · ${fmtPf(load.subUsedPf)} PF`,
    },
    {
      label: 'Token Cap',
      value: `${fmtMTok(liveCap)} MTok/d`,
    },
    {
      label: 'Power draw',
      value: `${powerMw.toFixed(3)} MW`,
    },
    {
      label: 'Demand / Cap',
      value: `${fmtMTok(demandM)} / ${fmtMTok(liveCap)} MTok`,
      bar: liveCap > 1e-9 ? Math.min(1, demandM / liveCap) : 0,
      warn: liveCap > 1e-9 ? demandM / liveCap > 1.02 : demandM > 0,
    },
    {
      label: 'Pool utilization',
      value: pct01(util),
      bar: utilClamped,
      warn: util > 0.95,
    },
    {
      label: 'Served',
      value: `${fmtMTok(lm.servedMTok ?? 0)} MTok`,
      warn: (lm.unservedRatio ?? 0) > 0.08,
    },
    {
      label: 'API vs plans dem',
      value: `${fmtMTok(apiDemand)} · ${fmtMTok(planDemand)} MTok`,
    },
    {
      label: 'Token split API/subs',
      value: `${fmtMTok(apiPoolM)} / ${fmtMTok(subPoolM)}`,
    },
    {
      label: 'Hardware t/s',
      value: `${fmtPf(hwTps)} raw rack t/s`,
    },
    {
      label: 'Allocation',
      value: pct01(allocShare),
      bar: allocShare,
    },
    {
      label: 'Serve efficiency',
      value: pct01(state.player.servingEfficiency),
    },
    {
      label: 'Unit cost',
      value: costPer > 0 ? `$${costPer.toFixed(3)}/MTok` : '—',
    },
    {
      label: 'Pool PF (train unit)',
      value: `${fmtPf(poolPf)} PF`,
      muted: true,
    },
  ]

  if (model) {
    const active = model.activeParamsB ?? model.paramsB
    lines.push({
      label: 'Active model',
      value: `${model.name || 'Model'} · ${formatParams(model.paramsB)}${
        Math.abs(active - model.paramsB) > 0.01 ? ` (${formatParams(active)} act)` : ''
      }`,
    })
    lines.push({
      label: 'Size / family mult',
      value: `×${sizeTokMult(model).toFixed(2)} tok · fam ${familyServeMult(model.family)} · ${fmtPf(pfPer)} PF/MTok`,
    })
  } else {
    lines.push({
      label: 'Active model',
      value: 'None released — Cap is 0',
      warn: true,
      muted: true,
    })
  }

  if (load.idlePf > 0.001 && !load.warn) {
    lines.push({
      label: 'Idle',
      value: `${fmtPf(load.idlePf)} PF`,
      muted: true,
    })
  }

  if ((lm.unservedRatio ?? 0) > 0.01) {
    lines.push({
      label: 'Unserved',
      value: pct01(lm.unservedRatio ?? 0),
      warn: true,
      bar: Math.min(1, lm.unservedRatio ?? 0),
    })
  }

  const utilizationLabel =
    util > 1.05 ? 'Overloaded' : util > 0.85 ? 'Busy' : util > 0.15 ? 'Partial' : 'Idle'
  const summary =
    util > 1.05
      ? `Served PF exceeds the inference pool by ${pct01(util - 1)} — unserved / queued traffic.`
      : util > 0.15
        ? `Serving uses ~${pct01(utilClamped)} of allocated inference PF.`
        : load.idlePf > 0.001
          ? `Idle ${fmtPf(load.idlePf)} PF — allocated serve headroom.`
          : 'Little traffic — inference PF is mostly headroom.'

  return {
    id: 'inference',
    title: 'Serve pool',
    poolPf,
    powerMw,
    allocShare,
    utilization: util,
    utilizationLabel,
    summary,
    lines,
  }
}

function buildResearchBreakdown(
  state: SimState,
  allocShare: number,
  usage: ResearchComputeUsage,
): PoolBreakdown {
  const poolPf = usage.poolPf
  const powerMw = usage.powerMw
  const job = state.player.activeResearch
  const programs = assignedResearchPrograms(state)
  const staff = playerStaff(state)
  const lines: BreakdownLine[] = [
    {
      label: 'Pool PF',
      value: `${fmtPf(poolPf)} PF`,
    },
    {
      label: 'In use',
      value: `${fmtPf(usage.usedPf)} PF`,
      bar: poolPf > 1e-9 ? Math.min(1, usage.usedPf / poolPf) : 0,
    },
    {
      label: 'Power draw',
      value: `${powerMw.toFixed(3)} MW`,
    },
    {
      label: 'Allocation',
      value: pct01(allocShare),
      bar: allocShare,
    },
  ]
  for (const slice of usage.slices) {
    lines.push({
      label: slice.label,
      value: `${pct01(slice.share)} · ${fmtPf(slice.pf)} PF`,
      bar: slice.share,
    })
  }
  if (usage.idlePf > 0.001 && usage.slices.length > 0) {
    lines.push({
      label: 'Idle',
      value: `${fmtPf(usage.idlePf)} PF`,
      muted: true,
    })
  }
  lines.push({
    label: 'Researchers',
    value: String(staff.researcher ?? 0),
    warn: (staff.researcher ?? 0) < 1,
  })

  let utilization = poolPf > 1e-9 ? Math.min(1, usage.usedPf / poolPf) : 0
  let utilizationLabel = usage.slices.length === 0 ? 'Idle' : usage.slices.length === 1 ? usage.slices[0]!.label : 'In use'
  let summary =
    usage.slices.length === 0
      ? 'No active research — research PF is idle.'
      : usage.slices.map((slice) => `${slice.label} ${fmtPf(slice.pf)} PF`).join(' · ') + '.'

  if (programs.length > 0) {
    lines.push({
      label: 'Programs',
      value: `${programs.length} active`,
    })
  }

  if (job) {
    const node = getResearchNode(job.nodeId)
    const target = researchPfTarget(state, node)
    const progress = job.progressPfDays / Math.max(1e-6, target)
    const rate = estimateResearchRate(state, job.nodeId)
    const daysLeft =
      rate.pfPerDay > 1e-6
        ? Math.max(0, target - job.progressPfDays) / rate.pfPerDay
        : Infinity
    if (rate.pfPerDay <= 0 && usage.slices.every((slice) => slice.id === 'tree')) {
      utilization = 0
      utilizationLabel = 'Stalled'
      summary = `Stalled on ${node.name} — need researchers or more research PF.`
    } else if (rate.pfPerDay > 0) {
      summary = `Researching ${node.name} · ${pct01(progress)} · ${fmtPf(rate.pfPerDay)} PF·d/day.`
    }
    lines.push(
      {
        label: 'Project',
        value: node.name,
      },
      {
        label: 'Progress',
        value: `${fmtPf(job.progressPfDays)} / ${fmtPf(target)} PF·d`,
        bar: Math.min(1, progress),
      },
      {
        label: 'Rate',
        value:
          rate.pfPerDay > 0
            ? `${fmtPf(rate.pfPerDay)} PF·d/day`
            : '0 — check staff / PF',
        warn: rate.pfPerDay <= 0,
      },
      {
        label: 'ETA',
        value: Number.isFinite(daysLeft) ? `~${Math.ceil(daysLeft)}d` : '—',
      },
    )
  } else if (programs.length > 0 && usage.slices.every((slice) => slice.id === 'tree')) {
    utilizationLabel = 'Programs'
    summary = `${programs.length} research program${programs.length === 1 ? '' : 's'} drawing from the research pool.`
  } else if (usage.slices.length === 0) {
    lines.push({
      label: 'Status',
      value: 'Idle — queue a node in Tech',
      muted: true,
    })
  }

  return {
    id: 'research',
    title: 'Research pool',
    poolPf,
    powerMw,
    allocShare,
    utilization,
    utilizationLabel,
    summary,
    lines,
  }
}

import type {
  BenchmarkId,
  BenchmarkScores,
  Model,
  ModelRouter,
  ModelRouterLane,
  QualityAxes,
  SubPlan,
} from '../types'
import { isLivePublicModel } from '../modelRelease'
import { emptyBenchmarks } from './benchmarks'
import { buildBenchmarkSuites } from './evaluationSuites'
import {
  ROUTER_LANES,
  normalizeModelRouters,
  remapLegacyRouterLanes,
} from './modelStudio'
import { inferencePfDemand } from './serveCompute'

export type RouterTaskBias = 'cheap' | 'balanced' | 'quality'

function emptyLaneWeights(): Record<ModelRouterLane, number> {
  return {
    default: 0,
    chat: 0,
    code: 0,
    math: 0,
    science: 0,
    fast: 0,
    frontier: 0,
  }
}

const METRIC_LANE_BIAS: Record<BenchmarkId, Record<ModelRouterLane, number>> = {
  mmlu: { default: 1.2, chat: 1.35, code: 0.8, math: 0.95, science: 1.05, fast: 0.7, frontier: 1.6 },
  coding: { default: 0.7, chat: 0.35, code: 2.6, math: 0.85, science: 0.45, fast: 0.35, frontier: 1.15 },
  math: { default: 0.65, chat: 0.3, code: 0.9, math: 2.6, science: 1.15, fast: 0.3, frontier: 2.5 },
  vision: { default: 1.1, chat: 0.7, code: 0.7, math: 0.5, science: 0.8, fast: 0.6, frontier: 1.5 },
  law: { default: 0.9, chat: 0.7, code: 0.7, math: 0.45, science: 0.55, fast: 0.4, frontier: 2.1 },
  health: { default: 0.9, chat: 0.65, code: 0.55, math: 0.4, science: 1.1, fast: 0.35, frontier: 2.2 },
  science: { default: 0.7, chat: 0.4, code: 0.7, math: 1.1, science: 2.55, fast: 0.3, frontier: 2.4 },
  multilingual: { default: 1.3, chat: 1.4, code: 0.5, math: 0.4, science: 0.45, fast: 1.1, frontier: 1.1 },
  agents: { default: 0.7, chat: 0.55, code: 2.2, math: 0.7, science: 0.6, fast: 0.4, frontier: 1.4 },
  safety: { default: 1.2, chat: 1.15, code: 0.9, math: 0.7, science: 0.85, fast: 0.8, frontier: 1.5 },
  personality: { default: 1.2, chat: 1.55, code: 0.35, math: 0.25, science: 0.3, fast: 1.2, frontier: 0.85 },
}

export function planTaskLaneDemand(
  plan: Pick<SubPlan, 'pricePerMonth'>,
): Record<ModelRouterLane, number> {
  if (plan.pricePerMonth <= 0) {
    return { chat: 0.46, default: 0.2, code: 0.16, math: 0.08, science: 0.06, fast: 0, frontier: 0 }
  }
  if (plan.pricePerMonth > 180) {
    return { default: 0.18, chat: 0.16, code: 0.2, math: 0.2, science: 0.26, fast: 0, frontier: 0 }
  }
  return { default: 0.22, chat: 0.28, code: 0.2, math: 0.16, science: 0.14, fast: 0, frontier: 0 }
}

export function apiTaskLaneDemand(apiPricePerMTok: number): Record<ModelRouterLane, number> {
  if (apiPricePerMTok <= 1.25) {
    return { chat: 0.42, default: 0.22, code: 0.16, math: 0.1, science: 0.1, fast: 0, frontier: 0 }
  }
  if (apiPricePerMTok >= 12) {
    return { default: 0.18, chat: 0.16, code: 0.22, math: 0.2, science: 0.24, fast: 0, frontier: 0 }
  }
  return { default: 0.22, chat: 0.26, code: 0.2, math: 0.16, science: 0.16, fast: 0, frontier: 0 }
}

export function publicTaskLaneDemand(): Record<ModelRouterLane, number> {
  return { default: 0.2, chat: 0.28, code: 0.2, math: 0.16, science: 0.16, fast: 0, frontier: 0 }
}

export function taskBiasForPlan(plan: Pick<SubPlan, 'pricePerMonth'>): RouterTaskBias {
  if (plan.pricePerMonth <= 0) return 'cheap'
  if (plan.pricePerMonth > 180) return 'quality'
  return 'balanced'
}

export function taskBiasForApiPrice(apiPricePerMTok: number): RouterTaskBias {
  if (apiPricePerMTok <= 1.25) return 'cheap'
  if (apiPricePerMTok >= 12) return 'quality'
  return 'balanced'
}

/** Bench the router uses when picking a specialist for a category. */
export function routerLaneScore(model: Model, lane: ModelRouterLane): number {
  const resolved =
    lane === 'fast' ? 'chat' : lane === 'frontier' ? 'default' : lane
  if (resolved === 'code') return model.benchmarks.coding ?? 0
  if (resolved === 'math') return model.benchmarks.math ?? 0
  if (resolved === 'science') return model.benchmarks.science ?? 0
  if (resolved === 'chat') {
    return Math.max(
      model.quality.chat ?? 0,
      model.benchmarks.personality ?? 0,
      model.benchmarks.multilingual ?? 0,
    )
  }
  return model.capability
}

export function strongestModelForLane(
  models: readonly Model[],
  lane: ModelRouterLane,
): Model | undefined {
  if (models.length === 0) return undefined
  return [...models].sort(
    (a, b) =>
      routerLaneScore(b, lane) - routerLaneScore(a, lane) ||
      b.capability - a.capability ||
      a.name.localeCompare(b.name),
  )[0]
}

export function resolveRouterLaneModels(
  router: ModelRouter,
  models: readonly Model[],
  opts?: { releasedOnly?: boolean },
): Partial<Record<ModelRouterLane, Model>> {
  const mapped = remapLegacyRouterLanes(router.lanes)
  const lanes: Partial<Record<ModelRouterLane, Model>> = {}
  for (const lane of ROUTER_LANES) {
    const modelId = mapped[lane]
    if (!modelId) continue
    const model = models.find((entry) => entry.id === modelId)
    if (!model) continue
    if (opts?.releasedOnly && !isLivePublicModel(model)) continue
    lanes[lane] = model
  }
  return lanes
}

export function routerLaneWeights(
  demand: Record<ModelRouterLane, number>,
  lanes: Partial<Record<ModelRouterLane, Model>>,
  bias: RouterTaskBias,
): Record<ModelRouterLane, number> {
  const assigned = ROUTER_LANES.filter((lane) => lanes[lane])
  const zero = emptyLaneWeights()
  if (assigned.length === 0) return zero

  let hardness = Object.fromEntries(
    assigned.map((lane) => [lane, Math.max(0, demand[lane] ?? 0)]),
  ) as Record<ModelRouterLane, number>
  const hardnessTotal = assigned.reduce((sum, lane) => sum + hardness[lane], 0)
  if (hardnessTotal <= 1e-9) {
    hardness = Object.fromEntries(
      assigned.map((lane) => [lane, 1 / assigned.length]),
    ) as Record<ModelRouterLane, number>
  }

  const pfCosts = assigned.map((lane) =>
    Math.max(1e-6, inferencePfDemand(1, lanes[lane]!)),
  )
  const cheapest = Math.min(...pfCosts)
  const maxCapability = Math.max(
    ...assigned.map((lane) => lanes[lane]!.capability),
    1,
  )

  const raw = assigned.map((lane, index) => {
    const model = lanes[lane]!
    // No 0.12 participation floors: zero capability/efficiency contributes
    // zero weight, so obsolete lanes drop out procedurally. Epsilon guards
    // only against exact-zero division, never grants share.
    const quality = Math.max(1e-9, model.capability / maxCapability)
    const efficiency = Math.max(1e-9, cheapest / pfCosts[index]!)
    const hardnessShare = hardness[lane]
    const gap = Math.max(0, maxCapability - model.capability)
    if (bias === 'cheap') {
      return hardnessShare * Math.pow(efficiency, 1.4) * (0.48 + quality * 0.52)
    }
    if (bias === 'quality') {
      return (
        hardnessShare *
        Math.pow(quality, 4.1) *
        Math.exp(-gap / 4.8) *
        (0.86 + efficiency * 0.14)
      )
    }
    return hardnessShare * Math.pow(quality, 2.4) * (0.74 + efficiency * 0.26)
  })
  const total = raw.reduce((sum, value) => sum + value, 0) || 1
  const weights = { ...zero }
  assigned.forEach((lane, index) => {
    weights[lane] = raw[index]! / total
  })
  return weights
}

export interface RouterLaneShare {
  lane: ModelRouterLane
  model: Model
  share: number
}

export function routerLaneShares(
  lanes: Partial<Record<ModelRouterLane, Model>>,
  weights: Record<ModelRouterLane, number>,
): RouterLaneShare[] {
  const parts: RouterLaneShare[] = []
  for (const lane of ROUTER_LANES) {
    const model = lanes[lane]
    const share = weights[lane] ?? 0
    if (!model || share <= 1e-9) continue
    parts.push({ lane, model, share })
  }
  const total = parts.reduce((sum, part) => sum + part.share, 0)
  if (total <= 1e-9) return []
  return parts.map((part) => ({ ...part, share: part.share / total }))
}

export function collapseRouterShares(
  parts: readonly RouterLaneShare[],
): { model: Model; share: number }[] {
  const byId = new Map<string, { model: Model; share: number }>()
  for (const part of parts) {
    const current = byId.get(part.model.id)
    if (current) current.share += part.share
    else byId.set(part.model.id, { model: part.model, share: part.share })
  }
  return [...byId.values()]
}

export function routerEffectiveCapability(
  parts: readonly { model: Model; share: number }[],
): number {
  if (parts.length === 0) return 0
  return parts.reduce((sum, part) => sum + part.share * part.model.capability, 0)
}

function blendQuality(parts: readonly RouterLaneShare[]): QualityAxes {
  const empty: QualityAxes = {
    reasoning: 0,
    coding: 0,
    chat: 0,
    image: 0,
    video: 0,
    safety: 0,
    reliability: 0,
  }
  if (parts.length === 0) return empty
  const keys = Object.keys(empty) as (keyof QualityAxes)[]
  const out = { ...empty }
  for (const key of keys) {
    out[key] = parts.reduce(
      (sum, part) => sum + part.share * (part.model.quality[key] ?? 0),
      0,
    )
  }
  return out
}

function blendBenchmarks(parts: readonly RouterLaneShare[]): BenchmarkScores {
  const out = emptyBenchmarks()
  if (parts.length === 0) return out
  for (const id of Object.keys(out) as BenchmarkId[]) {
    const bias = METRIC_LANE_BIAS[id]
    let weighted = 0
    let total = 0
    for (const part of parts) {
      const laneBias = bias[part.lane] ?? 1
      const weight = part.share * laneBias
      weighted += weight * (part.model.benchmarks[id] ?? 0)
      total += weight
    }
    out[id] = total <= 1e-9 ? 0 : weighted / total
  }
  return out
}

function weightedNumber(
  parts: readonly RouterLaneShare[],
  read: (model: Model) => number,
): number {
  return parts.reduce((sum, part) => sum + part.share * read(part.model), 0)
}

/** Synthetic public model representing a live router mix. Not persisted. */
export function composeRouterModel(
  router: ModelRouter,
  parts: readonly RouterLaneShare[],
): Model | null {
  if (parts.length === 0) return null
  const primary = [...parts].sort(
    (a, b) => b.share - a.share || b.model.capability - a.model.capability,
  )[0]!.model
  const capability = routerEffectiveCapability(parts)
  const benchmarks = blendBenchmarks(parts)
  const quality = blendQuality(parts)
  const modalities = [...new Set(parts.flatMap((part) => part.model.modalities))]
  const composed: Model = {
    ...primary,
    id: router.id,
    name: router.name,
    lineageId: router.id,
    capability,
    quality,
    benchmarks,
    paramsB: weightedNumber(parts, (model) => model.paramsB),
    activeParamsB: weightedNumber(
      parts,
      (model) => model.activeParamsB ?? model.paramsB,
    ),
    inferCostMult: weightedNumber(parts, (model) => model.inferCostMult),
    tokPerSecMult: weightedNumber(parts, (model) => model.tokPerSecMult),
    modalities,
    release: 'released',
    shipped: true,
    archived: false,
    apiPricePerMTok: weightedNumber(
      parts,
      (model) => model.apiPricePerMTok ?? model.suggestedApiPrice ?? 0,
    ),
    apiPriceInPerMTok: weightedNumber(
      parts,
      (model) =>
        model.apiPriceInPerMTok ??
        model.suggestedApiPriceIn ??
        model.costApiPriceIn ??
        0,
    ),
    apiPriceOutPerMTok: weightedNumber(
      parts,
      (model) =>
        model.apiPriceOutPerMTok ??
        model.suggestedApiPriceOut ??
        model.costApiPriceOut ??
        0,
    ),
    suggestedApiPriceIn: weightedNumber(
      parts,
      (model) => model.suggestedApiPriceIn ?? model.costApiPriceIn ?? 0.5,
    ),
    suggestedApiPriceOut: weightedNumber(
      parts,
      (model) => model.suggestedApiPriceOut ?? model.costApiPriceOut ?? 2,
    ),
    costApiPriceIn: weightedNumber(
      parts,
      (model) => model.costApiPriceIn ?? 0.5,
    ),
    costApiPriceOut: weightedNumber(
      parts,
      (model) => model.costApiPriceOut ?? 2,
    ),
    releaseDay: Math.max(...parts.map((part) => part.model.releaseDay)),
    trainComputeSpent: parts.reduce(
      (sum, part) => sum + part.model.trainComputeSpent,
      0,
    ),
  }
  const suites = buildBenchmarkSuites(composed)
  return {
    ...composed,
    benchmarkSuites: suites.suites,
    evaluationProfile: suites.profile,
  }
}

export function releasedRouterMemberIds(
  router: Pick<ModelRouter, 'lanes'>,
  models: readonly Model[],
): string[] {
  const publicIds = new Set(
    models.filter(isLivePublicModel).map((model) => model.id),
  )
  const ids: string[] = []
  for (const lane of ROUTER_LANES) {
    const id = router.lanes[lane]
    if (!id || !publicIds.has(id) || ids.includes(id)) continue
    ids.push(id)
  }
  return ids
}

export function planAssignedRouters(
  plan: Pick<SubPlan, 'routerIds'>,
  routers: readonly ModelRouter[] | undefined,
): ModelRouter[] {
  const wanted = new Set((plan.routerIds ?? []).filter((id) => id.length > 0))
  if (wanted.size === 0) return []
  return normalizeModelRouters(routers).filter((router) => wanted.has(router.id))
}

/** Released models this plan actually serves: listed models plus router members. */
// V4-DELETE: replace with V4 Endpoint routers; plan.endpointIds is the new roster.
export function planExposedModelIds(
  plan: Pick<SubPlan, 'modelIds' | 'routerIds'>,
  models: readonly Model[],
  routers?: readonly ModelRouter[],
): string[] {
  const publicIds = new Set(
    models.filter(isLivePublicModel).map((model) => model.id),
  )
  const ids: string[] = []
  const push = (id: string) => {
    if (!publicIds.has(id) || ids.includes(id)) return
    ids.push(id)
  }
  for (const id of plan.modelIds) push(id)
  for (const router of planAssignedRouters(plan, routers)) {
    for (const id of releasedRouterMemberIds(router, models)) push(id)
  }
  return ids
}

export function planExposesModel(
  plan: Pick<SubPlan, 'modelIds' | 'routerIds'>,
  modelId: string,
  models: readonly Model[],
  routers?: readonly ModelRouter[],
): boolean {
  return planExposedModelIds(plan, models, routers).includes(modelId)
}

/** Routers currently sold as API mixes. Empty `apiRouterIds` is explicit. */
export function soldApiRouters(input: {
  apiRouterIds?: readonly string[] | null
  apiModelIds?: readonly string[] | null
  activeModelRouterId?: string | null
  routers?: readonly ModelRouter[]
  models: readonly Model[]
}): ModelRouter[] {
  const all = normalizeModelRouters(input.routers)
  const withMembers = (router: ModelRouter) =>
    releasedRouterMemberIds(router, input.models).length > 0
  if (input.apiRouterIds != null) {
    const wanted = new Set(
      input.apiRouterIds.filter((id) => typeof id === 'string' && id.length > 0),
    )
    return all.filter((router) => wanted.has(router.id) && withMembers(router))
  }
  const live = all.find((router) => router.id === input.activeModelRouterId)
  if (!live || !withMembers(live)) return []
  const apiIds = new Set(input.apiModelIds ?? [])
  const membersListed = releasedRouterMemberIds(live, input.models).some((id) =>
    apiIds.has(id),
  )
  return membersListed ? [live] : []
}

export function soldApiRouterMemberIds(
  routers: readonly ModelRouter[],
  models: readonly Model[],
): string[] {
  const ids: string[] = []
  for (const router of routers) {
    for (const id of releasedRouterMemberIds(router, models)) {
      if (!ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

export function publicRouterParts(
  router: ModelRouter,
  models: readonly Model[],
): RouterLaneShare[] {
  const lanes = resolveRouterLaneModels(router, models, { releasedOnly: true })
  const weights = routerLaneWeights(publicTaskLaneDemand(), lanes, 'balanced')
  return routerLaneShares(lanes, weights)
}

export function planRouterParts(
  router: ModelRouter,
  models: readonly Model[],
  plan: Pick<SubPlan, 'pricePerMonth'>,
): RouterLaneShare[] {
  const lanes = resolveRouterLaneModels(router, models, { releasedOnly: true })
  const weights = routerLaneWeights(
    planTaskLaneDemand(plan),
    lanes,
    taskBiasForPlan(plan),
  )
  return routerLaneShares(lanes, weights)
}

export function apiRouterParts(
  router: ModelRouter,
  models: readonly Model[],
  apiPricePerMTok: number,
): RouterLaneShare[] {
  const lanes = resolveRouterLaneModels(router, models, { releasedOnly: true })
  const weights = routerLaneWeights(
    apiTaskLaneDemand(apiPricePerMTok),
    lanes,
    taskBiasForApiPrice(apiPricePerMTok),
  )
  return routerLaneShares(lanes, weights)
}

export function routerUnitCostPf(
  parts: readonly { model: Model; share: number }[],
  servingEfficiency = 1,
): number {
  return parts.reduce(
    (sum, part) =>
      sum + part.share * inferencePfDemand(1, part.model, servingEfficiency),
    0,
  )
}

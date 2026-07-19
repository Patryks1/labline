import { ECONOMY } from '../balance/economy'
import { blendApiPrice } from '../balance/pricing'
import type {
  BenchmarkId,
  Model,
  PlanDayStats,
  PlanServePrecision,
  SimState,
  SubPlan,
} from '../types'
import { inferencePfDemand, planActualMTokPerUser } from '../balance/serveCompute'
import { seededId } from '../rng'

export function defaultPlans(): SubPlan[] {
  return [
    {
      id: 'plan-free',
      name: 'Free',
      pricePerMonth: 0,
      usageMultiplier: 0.1,
      includedMTokPerMonth: ECONOMY.basePlanUsageMTokPerDay * 0.1 * ECONOMY.daysPerMonth,
      usageRate: null,
      modelIds: [],
      computePriority: 20,
      servePrecision: 'fp16',
      enabled: true,
    },
    {
      id: 'plan-plus',
      name: 'Plus',
      pricePerMonth: 20,
      usageMultiplier: 1,
      includedMTokPerMonth: ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth,
      usageRate: null,
      modelIds: [],
      computePriority: 55,
      servePrecision: 'fp16',
      enabled: true,
    },
    {
      id: 'plan-pro',
      name: 'Pro',
      pricePerMonth: 60,
      usageMultiplier: 5,
      includedMTokPerMonth: ECONOMY.basePlanUsageMTokPerDay * 5 * ECONOMY.daysPerMonth,
      usageRate: null,
      modelIds: [],
      computePriority: 75,
      servePrecision: 'fp16',
      enabled: true,
    },
  ]
}

/** Which quant levels the lab can assign on plans. */
export function unlockedPlanPrecisions(unlocked: string[]): PlanServePrecision[] {
  const out: PlanServePrecision[] = ['fp16']
  if (unlocked.includes('sys_quant')) out.push('int8')
  if (unlocked.includes('sys_fp8')) out.push('int4')
  return out
}

export function clampServePrecision(
  p: PlanServePrecision | undefined,
  unlocked: string[],
): PlanServePrecision {
  const allowed = unlockedPlanPrecisions(unlocked)
  const want = p ?? 'fp16'
  if (allowed.includes(want)) return want
  if (want === 'int4' && allowed.includes('int8')) return 'int8'
  return 'fp16'
}

/**
 * Quant trade-off: lower compute (inferCostMult) vs worse effective quality/cap.
 * int8 needs sys_quant; int4 needs sys_fp8.
 */
export function planServeModifiers(
  precision: PlanServePrecision | undefined,
  unlocked: string[],
): {
  precision: PlanServePrecision
  /** Multiplies model.inferCostMult for PF demand (lower = cheaper) */
  computeMult: number
  /** Multiplies perceived quality for demand */
  qualityMult: number
  /** Added to capability for plan scoring / SOTA */
  capabilityDelta: number
  /** Absolute score-point changes shown in plan eval previews. */
  benchmarkDeltas: Partial<Record<BenchmarkId, number>>
  /** Daily brand risk at meaningful traffic; market scales this by usage. */
  brandRisk: number
  label: string
} {
  const p = clampServePrecision(precision, unlocked)
  if (p === 'int4') {
    return {
      precision: p,
      computeMult: 0.42,
      qualityMult: 0.74,
      capabilityDelta: -14,
      benchmarkDeltas: {
        mmlu: -11,
        coding: -15,
        math: -14,
        vision: -9,
        law: -12,
        health: -11,
        science: -12,
        multilingual: -9,
        agents: -15,
        safety: -8,
      },
      brandRisk: 0.32,
      label: 'INT4 quant',
    }
  }
  if (p === 'int8') {
    return {
      precision: p,
      computeMult: 0.68,
      qualityMult: 0.94,
      capabilityDelta: -3,
      benchmarkDeltas: {
        mmlu: -2,
        coding: -4,
        math: -3,
        vision: -2,
        law: -2,
        health: -2,
        science: -2,
        multilingual: -2,
        agents: -4,
        safety: -1,
      },
      brandRisk: 0.035,
      label: 'INT8 quant',
    }
  }
  return {
    precision: 'fp16',
    computeMult: 1,
    qualityMult: 1,
    capabilityDelta: 0,
    benchmarkDeltas: {},
    brandRisk: 0,
    label: 'Full precision',
  }
}

/** Model shape after applying one serving precision policy. */
export function modelForServePrecision(
  model: Model,
  precision: PlanServePrecision | undefined,
  unlocked: string[],
): Model {
  const m = planServeModifiers(precision, unlocked)
  return {
    ...model,
    inferCostMult: (model.inferCostMult ?? 1) * m.computeMult,
    capability: Math.max(5, model.capability + m.capabilityDelta),
    quality: {
      ...model.quality,
      reasoning: model.quality.reasoning * m.qualityMult,
      coding: model.quality.coding * m.qualityMult,
      chat: model.quality.chat * m.qualityMult,
      reliability: model.quality.reliability * Math.min(1, m.qualityMult + 0.05),
    },
    benchmarks: Object.fromEntries(
      Object.entries(model.benchmarks).map(([id, score]) => [
        id,
        Math.max(0, score + (m.benchmarkDeltas[id as BenchmarkId] ?? 0)),
      ]),
    ) as Model['benchmarks'],
  }
}

/** Model shape for plan traffic after quant modifiers. */
export function modelForPlanServe(
  model: Model,
  plan: SubPlan,
  unlocked: string[],
): Model {
  return modelForServePrecision(model, plan.servePrecision, unlocked)
}

export interface PlanModelTraffic {
  model: Model
  share: number
}

export function defaultPlanComputePriority(
  plan: Pick<SubPlan, 'pricePerMonth'>,
): number {
  if (plan.pricePerMonth <= 0) return 20
  if (plan.pricePerMonth <= 25) return 55
  if (plan.pricePerMonth <= 100) return 75
  if (plan.pricePerMonth <= 180) return 85
  return 95
}

export function planComputePriority(
  plan: Pick<SubPlan, 'pricePerMonth' | 'computePriority'>,
): number {
  const value = plan.computePriority ?? defaultPlanComputePriority(plan)
  return Math.max(10, Math.min(100, Number.isFinite(value) ? value : 50))
}

/**
 * Weighted fair allocation inside the subscription PF pool. Plans receive
 * service in proportion to configured priority, with unused PF redistributed
 * when a smaller plan becomes fully served.
 */
export function allocatePlanCompute<T extends { plan: SubPlan; demandPf: number }>(
  buckets: readonly T[],
  capacityPf: number,
): Map<string, number> {
  const fractions = new Map<string, number>()
  const remaining = new Map<string, number>()
  for (const bucket of buckets) {
    const demand = Math.max(0, bucket.demandPf)
    remaining.set(bucket.plan.id, demand)
    fractions.set(bucket.plan.id, demand <= 1e-9 ? 1 : 0)
  }
  let pool = Math.max(0, capacityPf)
  const totalDemand = [...remaining.values()].reduce((sum, demand) => sum + demand, 0)
  if (totalDemand <= pool * 1.02) {
    for (const bucket of buckets) fractions.set(bucket.plan.id, 1)
    return fractions
  }

  for (let pass = 0; pass < buckets.length + 2 && pool > 1e-9; pass += 1) {
    const active = buckets.filter((bucket) => (remaining.get(bucket.plan.id) ?? 0) > 1e-9)
    if (active.length === 0) break
    const totalWeight = active.reduce(
      (sum, bucket) => sum + planComputePriority(bucket.plan),
      0,
    )
    if (totalWeight <= 0) break
    const passPool = pool
    let spent = 0
    for (const bucket of active) {
      const id = bucket.plan.id
      const need = remaining.get(id) ?? 0
      const share = passPool * (planComputePriority(bucket.plan) / totalWeight)
      const allocation = Math.min(need, share)
      remaining.set(id, Math.max(0, need - allocation))
      spent += allocation
    }
    if (spent <= 1e-12) break
    pool = Math.max(0, pool - spent)
  }

  for (const bucket of buckets) {
    const demand = Math.max(0, bucket.demandPf)
    const unserved = remaining.get(bucket.plan.id) ?? 0
    fractions.set(
      bucket.plan.id,
      demand <= 1e-9 ? 1 : Math.max(0, Math.min(1, (demand - unserved) / demand)),
    )
  }
  return fractions
}

/**
 * Token router for plans that expose more than one model. Free plans favor
 * efficient models; expensive plans route more traffic to higher capability.
 */
export function planModelTrafficMix(state: SimState, plan: SubPlan): PlanModelTraffic[] {
  const publicModel = (model: Model) => model.release === 'released' || model.shipped
  const selected = plan.modelIds
    .map((id) => state.player.models.find((model) => model.id === id && publicModel(model)))
    .filter((model): model is Model => Boolean(model))
  if (selected.length === 0) {
    const fallback = state.player.models.find(
      (model) => model.id === state.player.pricing.activeModelId && publicModel(model),
    ) ?? state.player.models.find(publicModel)
    if (fallback) selected.push(fallback)
  }
  if (selected.length === 0) return []

  const served = selected.map((model) =>
    modelForPlanServe(model, plan, state.player.researchUnlocked),
  )
  const maxCapability = Math.max(...served.map((model) => model.capability), 1)
  const pfPerMTok = served.map((model) => Math.max(1e-6, inferencePfDemand(1, model, 1)))
  const cheapest = Math.min(...pfPerMTok)
  const free = isFreePlan(plan)
  const premium = plan.pricePerMonth > 180
  const weights = served.map((model, index) => {
    const quality = Math.max(0.15, model.capability / maxCapability)
    const efficiency = Math.max(0.15, cheapest / pfPerMTok[index]!)
    if (free) return Math.pow(efficiency, 1.45) * (0.45 + quality * 0.55)
    const capabilityGap = Math.max(0, maxCapability - model.capability)
    const sotaBias = Math.exp(-capabilityGap / (premium ? 4.5 : 7))
    if (premium) return Math.pow(quality, 4.5) * sotaBias * (0.88 + efficiency * 0.12)
    return Math.pow(quality, 3.2) * sotaBias * (0.82 + efficiency * 0.18)
  })
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1
  return served.map((model, index) => ({ model, share: weights[index]! / total }))
}

export interface PremiumPlanScrutiny {
  applies: boolean
  entryPlanName: string | null
  expectedUsageRatio: number
  actualUsageRatio: number
  shortfall: number
}

/** Plans above $180/mo are judged against the company's cheapest paid tier. */
export function premiumPlanScrutiny(plan: SubPlan, allPlans: readonly SubPlan[]): PremiumPlanScrutiny {
  const entry = allPlans
    .filter((candidate) => candidate.enabled && candidate.pricePerMonth > 0 && candidate.id !== plan.id)
    .sort((a, b) => a.pricePerMonth - b.pricePerMonth)[0]
  if (plan.pricePerMonth <= 180 || !entry) {
    return { applies: false, entryPlanName: entry?.name ?? null, expectedUsageRatio: 20, actualUsageRatio: 0, shortfall: 0 }
  }
  const actualUsageRatio =
    planAllowanceMTokPerMonth(plan) / Math.max(0.001, planAllowanceMTokPerMonth(entry))
  return {
    applies: true,
    entryPlanName: entry.name,
    expectedUsageRatio: 20,
    actualUsageRatio,
    shortfall: Math.max(0, 1 - actualUsageRatio / 20),
  }
}

export function isFreePlan(plan: SubPlan): boolean {
  return plan.pricePerMonth <= 0
}

/** Plan usage mult: 0.1× (tiny free) → 500× (enterprise power seats). */
export function clampMultiplier(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.max(0.1, Math.min(500, n))
}

/** Soft max monthly price — higher only justified by token value + model quality. */
export function clampPlanPrice(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(ECONOMY.planMaxPricePerMonth ?? 25_000, n))
}

export function createPlan(
  state: SimState,
  input: { name: string; pricePerMonth: number; usageMultiplier: number; modelIds?: string[] },
): SimState {
  let modelIds = input.modelIds ? [...input.modelIds] : []
  if (modelIds.length === 0 && state.player.pricing.activeModelId) {
    modelIds = [state.player.pricing.activeModelId]
  }
  const plan: SubPlan = {
    id: seededId('plan', state.seed, state.day, input.name, state.player.pricing.plans.length),
    name: input.name.trim() || 'New plan',
    pricePerMonth: clampPlanPrice(input.pricePerMonth),
    usageMultiplier: clampMultiplier(input.usageMultiplier),
    includedMTokPerMonth:
      ECONOMY.basePlanUsageMTokPerDay *
      clampMultiplier(input.usageMultiplier) *
      ECONOMY.daysPerMonth,
    usageRate: null,
    modelIds,
    computePriority: defaultPlanComputePriority({ pricePerMonth: input.pricePerMonth }),
    servePrecision: isFreePlan({ pricePerMonth: input.pricePerMonth } as SubPlan)
      ? unlockedPlanPrecisions(state.player.researchUnlocked).includes('int8')
        ? 'int8'
        : 'fp16'
      : 'fp16',
    enabled: true,
  }

  return {
    ...state,
    player: {
      ...state.player,
      pricing: {
        ...state.player.pricing,
        plans: [...state.player.pricing.plans, plan],
      },
    },
    alerts: [
      {
        id: `plan-new-${plan.id}`,
        day: state.day,
        severity: 'info' as const,
        message: `Plan created: ${plan.name} ($${plan.pricePerMonth}/mo · ${plan.usageMultiplier}x · ${formatAllowance(plan)} tokens)`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function updatePlan(state: SimState, planId: string, patch: Partial<SubPlan>): SimState {
  const plans = state.player.pricing.plans.map((p) => {
    if (p.id !== planId) return p
    const usageMultiplier =
      patch.includedMTokPerMonth !== undefined
        ? clampMultiplier(
            Math.max(0.001, patch.includedMTokPerMonth) /
              (ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth),
          )
        : patch.usageMultiplier !== undefined
          ? clampMultiplier(patch.usageMultiplier)
          : p.usageMultiplier
    const includedMTokPerMonth =
      patch.includedMTokPerMonth !== undefined
        ? Math.max(
            ECONOMY.basePlanUsageMTokPerDay * 0.1 * ECONOMY.daysPerMonth,
            Math.min(
              ECONOMY.basePlanUsageMTokPerDay * 500 * ECONOMY.daysPerMonth,
              patch.includedMTokPerMonth,
            ),
          )
        : patch.usageMultiplier !== undefined
          ? ECONOMY.basePlanUsageMTokPerDay * usageMultiplier * ECONOMY.daysPerMonth
          : p.includedMTokPerMonth ??
            ECONOMY.basePlanUsageMTokPerDay * p.usageMultiplier * ECONOMY.daysPerMonth
    return {
      ...p,
      ...patch,
      id: p.id,
      pricePerMonth:
        patch.pricePerMonth !== undefined
          ? clampPlanPrice(patch.pricePerMonth)
          : p.pricePerMonth,
      usageMultiplier,
      includedMTokPerMonth,
      usageRate: null,
      computePriority:
        patch.computePriority !== undefined
          ? planComputePriority({
              pricePerMonth: patch.pricePerMonth ?? p.pricePerMonth,
              computePriority: patch.computePriority,
            })
          : p.computePriority ?? defaultPlanComputePriority(p),
      servePrecision:
        patch.servePrecision !== undefined
          ? clampServePrecision(patch.servePrecision, state.player.researchUnlocked)
          : p.servePrecision ?? 'fp16',
      name: patch.name !== undefined ? patch.name.trim() || p.name : p.name,
    }
  })
  return {
    ...state,
    player: {
      ...state.player,
      pricing: { ...state.player.pricing, plans },
    },
  }
}

export function deletePlan(state: SimState, planId: string): SimState {
  const plans = state.player.pricing.plans.filter((p) => p.id !== planId)
  if (plans.length === state.player.pricing.plans.length) return state
  if (plans.length === 0) {
    return {
      ...state,
      alerts: [
        {
          id: `plan-del-fail-${state.day}`,
          day: state.day,
          severity: 'warn' as const,
          message: 'Keep at least one plan.',
        },
        ...state.alerts,
      ].slice(0, 40),
    }
  }
  return {
    ...state,
    player: {
      ...state.player,
      pricing: { ...state.player.pricing, plans },
    },
  }
}

/** Attach newly shipped models to plans with empty model lists. */
export function attachModelToEmptyPlans(state: SimState, modelId: string): SimState {
  const plans = state.player.pricing.plans.map((p) => {
    if (p.modelIds.length > 0) return p
    return { ...p, modelIds: [modelId] }
  })
  return {
    ...state,
    player: {
      ...state.player,
      pricing: { ...state.player.pricing, plans },
    },
  }
}

/** Max allowance MTok/user/day (before utilization %). */
export function planAllowanceMTokPerDay(plan: SubPlan): number {
  return planAllowanceMTokPerMonth(plan) / ECONOMY.daysPerMonth
}

/** Monthly included token allowance (MTok/user/mo at full utilization). */
export function planAllowanceMTokPerMonth(plan: SubPlan): number {
  if (Number.isFinite(plan.includedMTokPerMonth) && (plan.includedMTokPerMonth ?? 0) > 0) {
    return plan.includedMTokPerMonth!
  }
  return ECONOMY.basePlanUsageMTokPerDay * plan.usageMultiplier * ECONOMY.daysPerMonth
}

export interface PlanAllowanceExpectation {
  minimumMTok: number
  recommendedMTok: number
  maximumMTok: number
  dissatisfaction: number
  label: string
}

/**
 * Customer allowance expectations scale roughly with monthly price. Free
 * products still need at least 1M tokens/month to feel like a real product;
 * paid tiers are judged at roughly 1–1.5M tokens per monthly dollar.
 */
export function planAllowanceExpectation(plan: SubPlan): PlanAllowanceExpectation {
  const allowance = planAllowanceMTokPerMonth(plan)
  const free = isFreePlan(plan)
  const minimumMTok = free ? 1 : Math.max(1, plan.pricePerMonth)
  const recommendedMTok = free ? 10 : Math.max(minimumMTok, plan.pricePerMonth * 1.25)
  const maximumMTok = free ? 25 : Math.max(recommendedMTok, plan.pricePerMonth * 1.5)
  const shortfall = Math.max(0, minimumMTok - allowance) / Math.max(1, minimumMTok)
  const dissatisfaction = shortfall <= 0 ? 0 : Math.min(1, 0.2 + shortfall * 0.8)
  return {
    minimumMTok,
    recommendedMTok,
    maximumMTok,
    dissatisfaction,
    label: free
      ? 'Free users expect at least 1M tokens/month.'
      : `$${plan.pricePerMonth.toFixed(0)} plans are judged against ${minimumMTok.toFixed(0)}–${maximumMTok.toFixed(0)}M tokens/month.`,
  }
}

/**
 * Loss-making plans feel unstable: users expect throttling, surprise limits, or
 * withdrawal. Free users tolerate subsidy, but a visibly unsustainable tier
 * still carries a large demand penalty.
 */
export function planStabilityDissatisfaction(
  isFree: boolean,
  marginPerSubMonth: number,
  pricePerMonth: number,
): number {
  const lossRatio = Math.max(0, -marginPerSubMonth) / Math.max(10, pricePerMonth || 20)
  if (lossRatio <= 0) return 0
  return isFree
    ? Math.min(0.75, 0.35 + lossRatio * 0.45)
    : Math.min(1, 0.15 + lossRatio * 1.1)
}

export type FreeTierDemandBand = 'popular' | 'semi_popular' | 'cost_constrained'

/**
 * Free-tier reach follows the allowance users actually experience. A message
 * is estimated at 2K tokens, matching the plan editor's friendly estimate.
 */
export function freeTierDemandProfile(plan: SubPlan): {
  band: FreeTierDemandBand
  messagesPerDay: number
  audienceMultiplier: number
  minimumAudienceShare: number
  utilityBonus: number
  paidPopularityLead: number
  label: string
} {
  const messagesPerDay =
    (planAllowanceMTokPerMonth(plan) * 1_000_000) /
    ECONOMY.daysPerMonth /
    2_000
  if (messagesPerDay > 10) {
    return {
      band: 'popular',
      messagesPerDay,
      audienceMultiplier: 2.4,
      minimumAudienceShare: 0.32,
      utilityBonus: 22,
      paidPopularityLead: 2.4,
      label: 'Mass-market reach',
    }
  }
  if (messagesPerDay >= 5) {
    return {
      band: 'semi_popular',
      messagesPerDay,
      audienceMultiplier: 0.9,
      minimumAudienceShare: 0.07,
      utilityBonus: 5,
      paidPopularityLead: 1.6,
      label: 'Semi-popular reach',
    }
  }
  return {
    band: 'cost_constrained',
    messagesPerDay,
    audienceMultiplier: 0.16,
    minimumAudienceShare: 0.02,
    utilityBonus: -18,
    paidPopularityLead: 1.12,
    label: 'Cost-constrained reach',
  }
}

export function formatAllowance(plan: SubPlan): string {
  const m = planAllowanceMTokPerMonth(plan)
  if (m >= 1000) return `${(m / 1000).toFixed(1)}B tok/mo`
  if (m >= 1) return `${m.toFixed(1)}M tok/mo`
  return `${(m * 1000).toFixed(0)}K tok/mo`
}

/** @deprecated use planAllowanceMTokPerDay × utilization */
export function planTokensPerDay(plan: SubPlan): number {
  return planAllowanceMTokPerDay(plan)
}

export function emptyPlanStats(): PlanDayStats[] {
  return []
}

/** Best model on a plan for quality scoring. */
export function bestModelOnPlan(state: SimState, plan: SubPlan) {
  const publicOk = (m: { shipped: boolean; release?: string }) =>
    m.release === 'released' || m.shipped
  const models = plan.modelIds
    .map((id) => state.player.models.find((m) => m.id === id && publicOk(m)))
    .filter(Boolean)
  if (models.length === 0) {
    const active = state.player.models.find(
      (m) => m.id === state.player.pricing.activeModelId && publicOk(m),
    )
    return active ?? null
  }
  return models.sort((a, b) => (b!.capability ?? 0) - (a!.capability ?? 0))[0] ?? null
}

function playerBlendedApi(state: SimState): number {
  const p = state.player.pricing
  if (p.apiPriceInPerMTok != null && p.apiPriceOutPerMTok != null) {
    return blendApiPrice(p.apiPriceInPerMTok, p.apiPriceOutPerMTok)
  }
  return Math.max(0.05, p.apiPricePerMTok)
}

/**
 * API-list value of included monthly tokens (what user would pay on API for same volume).
 * Used for subsidy display and "is $5k justified?" checks.
 */
export function planApiEquivalentValue(
  plan: SubPlan,
  apiPricePerMTok: number,
  utilization = 0.75,
): number {
  const mtokMo = planAllowanceMTokPerMonth(plan) * Math.max(0.1, Math.min(1, utilization))
  return mtokMo * Math.max(0.01, apiPricePerMTok)
}

/**
 * Subsidy ratio: apiEquivalent / price.
 * >1 = included tokens worth more than sub (you subsidize).
 * <1 = customer overpays vs API (price pressure).
 */
export function planSubsidyRatio(
  plan: SubPlan,
  apiPricePerMTok: number,
  utilization = 0.75,
): number {
  if (isFreePlan(plan)) return Number.POSITIVE_INFINITY
  const apiEq = planApiEquivalentValue(plan, apiPricePerMTok, utilization)
  return apiEq / Math.max(0.01, plan.pricePerMonth)
}

/**
 * 0 = fair/cheap, 1 = way too expensive vs included tokens + model quality.
 * High ARPU ($5k) is OK when token value + SOTA justify it.
 */
export function planPriceTooHighScore(
  plan: SubPlan,
  opts: {
    apiPricePerMTok: number
    modelCapability: number
    frontierCapability: number
    utilization?: number
  },
): number {
  if (isFreePlan(plan)) return 0
  const u = opts.utilization ?? 0.75
  const sota = Math.max(
    0,
    Math.min(1, 1 - Math.max(0, opts.frontierCapability - opts.modelCapability) / 32),
  )
  // Fair price ceiling — SOTA + included tokens justify higher ARPU
  const tokenValue =
    planApiEquivalentValue(plan, opts.apiPricePerMTok, u) * (0.85 + sota * 1.35)
  const brandPremium =
    (18 + opts.modelCapability * 1.6) * (1 + sota * 3.2) + (plan.pricePerMonth <= 25 ? 14 : 0)
  const fairCeiling = tokenValue + brandPremium
  const over = plan.pricePerMonth / Math.max(1, fairCeiling)
  // Softer curve so fair Plus/Pro sell; gouging still near 1.0
  return Math.max(0, Math.min(1, Math.pow(Math.max(0, over - 1.1), 1.0) / 1.85))
}

/** Headline rival sub price (cheapest paid rival tier as competitive anchor). */
export function rivalHeadlineSubPrice(state: SimState): number {
  const prices = state.rivals
    .filter((r) => r.models.some((m) => m.shipped || m.release === 'released'))
    .map((r) => r.pricing.subPlusPrice)
    .filter((p) => p > 0)
  if (prices.length === 0) return 20
  return Math.min(...prices)
}

export function rivalBestCapability(state: SimState): number {
  let best = 0
  for (const r of state.rivals) {
    for (const m of r.models) {
      if (m.shipped || m.release === 'released') best = Math.max(best, m.capability)
    }
  }
  return best
}

/**
 * Softmax-friendly score for plan demand.
 * More tokens + smarter model at same price beats stingy rivals.
 */
export function planAttractiveness(state: SimState, plan: SubPlan): number {
  if (!plan.enabled) return -50
  const baseModel = bestModelOnPlan(state, plan)
  if (!baseModel) return -40
  const model = modelForPlanServe(baseModel, plan, state.player.researchUnlocked)

  const frontier = Math.max(
    model.capability,
    ...state.player.models
      .filter((m) => m.release === 'released' || m.shipped)
      .map((m) => m.capability),
    rivalBestCapability(state),
    40,
  )
  const gap = Math.max(0, frontier - model.capability)
  const sota = Math.max(0, Math.min(1, 1 - gap / 28))
  const api = playerBlendedApi(state)
  const rivalSub = rivalHeadlineSubPrice(state)
  const rivalCap = rivalBestCapability(state) || frontier

  const quality =
    model.capability * 0.42 +
    model.quality.reliability * 0.22 +
    model.quality.chat * 0.12 +
    sota * 30

  // Explicit token offer (log of monthly MTok)
  const allowMo = planAllowanceMTokPerMonth(plan)
  const tokenOfferScore = Math.min(52, 8 + Math.log10(allowMo * 1000 + 10) * 12)

  // Price: free attractive for lagging; SOTA can charge more if tokens justify
  const priceScore =
    plan.pricePerMonth <= 0
      ? 48 + (1 - sota) * 16
      : Math.max(0, 72 - Math.log10(plan.pricePerMonth + 1) * 22)

  const tooHigh = planPriceTooHighScore(plan, {
    apiPricePerMTok: api,
    modelCapability: model.capability,
    frontierCapability: frontier,
  })

  // Value vs rival: more tokens @ same/lower price, or smarter model
  const tokenVsRival =
    plan.pricePerMonth <= 0
      ? 0
      : Math.min(
          24,
          Math.log2(1 + allowMo / Math.max(0.01, ECONOMY.basePlanUsageMTokPerDay * 30)) *
            (rivalSub / Math.max(1, plan.pricePerMonth)) *
            4,
        )
  const smarterAtPrice =
    plan.pricePerMonth > 0 && plan.pricePerMonth <= rivalSub * 1.15
      ? Math.max(0, model.capability - rivalCap) * 0.85
      : Math.max(0, model.capability - rivalCap) * 0.35

  const valueRatio =
    plan.pricePerMonth <= 0
      ? tokenOfferScore * 0.3 * (1.1 - sota * 0.35)
      : Math.min(
          32,
          ((quality + tokenOfferScore) / plan.pricePerMonth) * (1.8 + (1 - sota) * 2.5),
        )

  const sotaPull = Math.pow(sota, 1.35) * 20
  const pricePenalty = tooHigh * 38
  const premiumPenalty = premiumPlanScrutiny(plan, state.player.pricing.plans).shortfall * 52
  const allowancePenalty = planAllowanceExpectation(plan).dissatisfaction * 72
  const priorDissatisfaction =
    state.lastMarket.planStats.find((stat) => stat.planId === plan.id)?.dissatisfaction ?? 0
  const instabilityPenalty = priorDissatisfaction * (isFreePlan(plan) ? 34 : 58)

  return (
    quality * 0.34 +
    priceScore * (0.14 + (1 - sota) * 0.16) +
    tokenOfferScore * 0.22 +
    valueRatio * 0.1 +
    tokenVsRival * 0.12 +
    smarterAtPrice * 0.08 +
    sotaPull -
    pricePenalty -
    premiumPenalty -
    allowancePenalty -
    instabilityPenalty
  )
}

/**
 * How many concurrent subscribers a plan can support given inference PF headroom
 * and per-user token burn (compute seat cap).
 */
export function maxSeatsForPlan(
  plan: SubPlan,
  model: Pick<Model, 'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult'> | null,
  capacityUnits: number,
  serveEff: number,
  usageRate: number,
  opts?: {
    modelCapability?: number
    frontierCapability?: number
    /** Fraction of capacity reserved for subs (rest for API) */
    subPoolShare?: number
    /** When true, capacityUnits is MTok/day (token path); else inference PF */
    capacityIsMTok?: boolean
  },
): number {
  if (!model || capacityUnits <= 1e-9) return 0
  const sota = sotaProximityLocal(
    opts?.modelCapability ?? 40,
    opts?.frontierCapability ?? 50,
  )
  const free = isFreePlan(plan)
  const eng = free ? 0.4 + sota * 0.8 : 0.55 + Math.pow(sota, 1.3) * 2.2
  const perUserMTok =
    planActualMTokPerUser(plan, ECONOMY.basePlanUsageMTokPerDay, usageRate) * eng
  if (perUserMTok <= 1e-12) return 1e9
  const subShare = opts?.subPoolShare ?? 1 - (ECONOMY.defaultApiVsSubPriority ?? 0.68)
  const subPool = capacityUnits * Math.max(0.12, Math.min(1, subShare))
  if (opts?.capacityIsMTok) {
    return Math.max(0, Math.floor(subPool / perUserMTok))
  }
  const pfEach = inferencePfDemand(perUserMTok, model, serveEff)
  if (pfEach <= 1e-12) return 1e9
  return Math.max(0, Math.floor(subPool / pfEach))
}

function sotaProximityLocal(cap: number, frontier: number): number {
  const f = Math.max(18, frontier)
  return Math.max(0, Math.min(1, 1 - Math.max(0, f - cap) / 32))
}

/** Soft max total sub seats from whole inference pool (UI / market). */
export function maxTotalSubSeats(
  state: SimState,
  capacityPf: number,
  serveEff: number,
): number {
  const plans = state.player.pricing.plans.filter((p) => p.enabled)
  if (plans.length === 0) return 0
  // Weighted average per-user PF using plan attractiveness as weights
  let seats = 0
  for (const p of plans) {
    const m = bestModelOnPlan(state, p)
    const u = p.usageRate ?? 0.65
    seats += maxSeatsForPlan(p, m, capacityPf / Math.max(1, plans.length), serveEff, u)
  }
  return Math.max(0, seats)
}

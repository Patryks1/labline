/**
 * Shared serve math for API + subscriptions.
 * Capacity is **token-based** (racks × model) via tokenServe.
 * PF helpers remain for tooltips / train-adjacent reporting.
 */
import type { Model, SubPlan } from '../types'
import type { ComputeSnapshot } from '../systems/compute'
import { ECONOMY } from './economy'
import type { CommercialModelKind } from './pricing'
import {
  modelCostMult,
  pfPerMTokForModel as pfPerMTokPhysical,
  serveAgainstTokenPool,
  serveEffFactor,
  tokensPerDayFromSnapshotPrecise,
  type ServeModelPick,
} from './tokenServe'
export {
  ledgerRowsForChannel,
  settleComputeLedger,
  type ComputeLedger,
  type ComputeLedgerRow,
  type ComputeWorkItem,
} from './serveLedger'

export { serveEffFactor, modelCostMult, serveAgainstTokenPool }
export { sizeTokMult, familyServeMult, mtokPerDayForSku } from './tokenServe'

/**
 * How much inference PF one MTok burns for this model (derived / tooltip).
 */
export function pfPerMTokForModel(
  model: Pick<Model, 'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult'>,
  servingEfficiency = 1,
): number {
  return pfPerMTokPhysical(model, servingEfficiency)
}

/** Inference PF available today (pool already is train/serve/research split). */
export function inferencePfAvailable(snap: ComputeSnapshot): number {
  return Math.max(0, snap.pools.inference)
}

/**
 * Max MTok/day the fleet can push for this model — **token path**.
 */
export function inferenceCapacityMTok(
  snap: ComputeSnapshot,
  model: ServeModelPick | null,
  servingEfficiency = 1,
  inferenceShare?: number,
): number {
  if (!model) return 0
  // The snapshot pool already includes the configured allocation and all fleet
  // derates. Passing that share through the token path again used to tax serving
  // twice, so the explicit argument is retained only for API compatibility.
  void inferenceShare
  return tokensPerDayFromSnapshotPrecise(
    snap,
    model,
    servingEfficiency,
  )
}

/** PF demand to serve a token volume (legacy / seat scaling). */
export function inferencePfDemand(
  mtok: number,
  model: Pick<Model, 'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult'>,
  servingEfficiency = 1,
): number {
  return Math.max(0, mtok) * pfPerMTokForModel(model, servingEfficiency)
}

/**
 * Shared-pool serve accounting: many products, one inference budget (PF).
 * Prefer serveAgainstTokenPool for capacity decisions.
 */
export function serveAgainstInferencePool(
  demandPf: number,
  capacityPf: number,
): { serveFrac: number; unservedRatio: number; servedPf: number } {
  if (demandPf <= 1e-9) {
    return { serveFrac: 1, unservedRatio: 0, servedPf: 0 }
  }
  if (capacityPf <= 1e-12) {
    return { serveFrac: 0, unservedRatio: 1, servedPf: 0 }
  }
  const serveFrac = Math.min(1, capacityPf / demandPf)
  return {
    serveFrac: Math.min(1, serveFrac),
    unservedRatio: Math.max(0, 1 - Math.min(1, capacityPf / demandPf)),
    servedPf: demandPf * Math.min(1, capacityPf / demandPf),
  }
}

/**
 * Typical utilization of a plan's token *allowance* (not list price).
 */
export function planUsageUtilization(
  plan: SubPlan,
  allPlans: SubPlan[],
  opts?: {
    modelCapability?: number
    frontierCapability?: number
    demandShockMultiplier?: number
    /** Subsidy-derived effective allowance; falls back to the stored fields. */
    allowanceMTokPerMonth?: number
  },
): number {
  return planHeavyUserProfile(plan, allPlans, opts).blendedUtilization
}

export type CustomerBandId =
  | 'free'
  | 'entry'
  | 'value'
  | 'coder'
  | 'power'
  | 'enterprise'

export interface CustomerBand {
  id: CustomerBandId
  label: string
  /** Inclusive upper bound of the band's monthly price (£). */
  maxPrice: number
  /** Representative price used as the smooth-utilization anchor. */
  anchorPrice: number
  /** Expected allowance utilization range inside this band. */
  utilization: readonly [number, number]
  /** How strongly this band's customers care about each model workload. */
  relevance: Record<CommercialModelKind, number>
}

/**
 * Customer bands by monthly plan price. Utilization interpolates smoothly
 * between band anchors (log price) so there are no hard cliffs at £10/£40/
 * £120/£500; the spec'd ranges hold at each band's representative price.
 *
 * - free: hobby reach, modest allowance burn (8–20% of 4 MTok/mo ≈ 10–25k tok/day)
 * - £1–10 entry users: small allowance, nearly exhausted (75–95%)
 * - £10–40 value customers: pay for headroom (35–65%)
 * - £40–120 coders/workers: steady professional use (50–80%)
 * - £120–500 power users/teams: most of the allowance (75–95%)
 * - £500+ enterprise/near-unlimited: heavy but capped (65–95%)
 */
export const CUSTOMER_BANDS: readonly CustomerBand[] = [
  {
    id: 'free',
    label: 'Free users',
    maxPrice: 0,
    anchorPrice: 0,
    utilization: [0.08, 0.2],
    relevance: {
      language: 0.9,
      coding: 0.35,
      reasoning: 0.35,
      image: 0.6,
      video: 0.4,
      audio: 0.5,
      omni: 0.6,
    },
  },
  {
    id: 'entry',
    label: 'Entry users',
    maxPrice: 10,
    anchorPrice: 3,
    utilization: [0.75, 0.95],
    relevance: {
      language: 0.85,
      coding: 0.45,
      reasoning: 0.45,
      image: 0.75,
      video: 0.55,
      audio: 0.65,
      omni: 0.7,
    },
  },
  {
    id: 'value',
    label: 'Value customers',
    maxPrice: 40,
    anchorPrice: 20,
    utilization: [0.35, 0.65],
    relevance: {
      language: 0.9,
      coding: 0.6,
      reasoning: 0.6,
      image: 0.9,
      video: 0.8,
      audio: 0.8,
      omni: 0.85,
    },
  },
  {
    id: 'coder',
    label: 'Coders & workers',
    maxPrice: 120,
    anchorPrice: 70,
    utilization: [0.5, 0.8],
    relevance: {
      language: 0.7,
      coding: 1,
      reasoning: 0.95,
      image: 0.5,
      video: 0.35,
      audio: 0.5,
      omni: 0.85,
    },
  },
  {
    id: 'power',
    label: 'Power users & teams',
    maxPrice: 500,
    anchorPrice: 250,
    utilization: [0.75, 0.95],
    relevance: {
      language: 0.8,
      coding: 0.95,
      reasoning: 1,
      image: 0.85,
      video: 0.9,
      audio: 0.75,
      omni: 0.95,
    },
  },
  {
    id: 'enterprise',
    label: 'Enterprise',
    maxPrice: Number.POSITIVE_INFINITY,
    anchorPrice: 1_200,
    utilization: [0.65, 0.95],
    relevance: {
      language: 0.75,
      coding: 0.9,
      reasoning: 1,
      image: 0.6,
      video: 0.6,
      audio: 0.6,
      omni: 0.9,
    },
  },
]

export function customerBandForPrice(pricePerMonth: number): CustomerBand {
  const price = Math.max(0, Number.isFinite(pricePerMonth) ? pricePerMonth : 0)
  for (const band of CUSTOMER_BANDS) {
    if (price <= band.maxPrice) return band
  }
  return CUSTOMER_BANDS[CUSTOMER_BANDS.length - 1]!
}

/**
 * Smooth expected-utilization range for a monthly price. Log-price lerp
 * between band anchors; flat at the entry band below £3 and at the
 * enterprise band above £1,200. Free keeps its own light-usage range.
 */
export function expectedUtilizationRange(
  pricePerMonth: number,
): readonly [number, number] {
  const price = Number.isFinite(pricePerMonth) ? pricePerMonth : 0
  if (price <= 0) return CUSTOMER_BANDS[0]!.utilization
  const anchors = CUSTOMER_BANDS.filter((band) => band.anchorPrice > 0)
  if (price <= anchors[0]!.anchorPrice) return anchors[0]!.utilization
  for (let i = 1; i < anchors.length; i += 1) {
    const prev = anchors[i - 1]!
    const next = anchors[i]!
    if (price <= next.anchorPrice) {
      const t =
        Math.log(price / prev.anchorPrice) /
        Math.log(next.anchorPrice / prev.anchorPrice)
      return [
        prev.utilization[0] + (next.utilization[0] - prev.utilization[0]) * t,
        prev.utilization[1] + (next.utilization[1] - prev.utilization[1]) * t,
      ]
    }
  }
  return anchors[anchors.length - 1]!.utilization
}

/** Expected utilization at a price, positioned in its range by SOTA proximity. */
export function expectedPlanUtilization(
  pricePerMonth: number,
  sotaProximity = 0.5,
): number {
  const [low, high] = expectedUtilizationRange(pricePerMonth)
  const sota = Math.max(0, Math.min(1, sotaProximity))
  return low + (high - low) * sota
}

export interface PlanHeavyUserProfile {
  /** Share of seats that are attracted by the allowance and use nearly all of it. */
  heavyUserShare: number
  regularUtilization: number
  heavyUtilization: number
  blendedUtilization: number
}

/** Stored monthly allowance (MTok) before any subsidy-derived override. */
function storedAllowanceMTokPerMonth(plan: SubPlan): number {
  return Number.isFinite(plan.includedMTokPerMonth) &&
    (plan.includedMTokPerMonth ?? 0) > 0
    ? plan.includedMTokPerMonth!
    : ECONOMY.basePlanUsageMTokPerDay * plan.usageMultiplier * ECONOMY.daysPerMonth
}

/**
 * Shared player/rival allowance-abuse profile. Generous tiers attract a small
 * cohort of power users; frontier launches temporarily make that cohort larger.
 * Regular utilization comes from the smooth customer bands (no price cliffs).
 */
export function planHeavyUserProfile(
  plan: SubPlan,
  allPlans: SubPlan[],
  opts?: {
    modelCapability?: number
    frontierCapability?: number
    demandShockMultiplier?: number
    /** Subsidy-derived effective allowance; falls back to the stored fields. */
    allowanceMTokPerMonth?: number
  },
): PlanHeavyUserProfile {
  const cap = opts?.modelCapability ?? 50
  const frontier = Math.max(opts?.frontierCapability ?? cap, cap)
  const sota = Math.max(0, Math.min(1, (cap - 25) / Math.max(25, frontier - 25 + 1e-6)))
  // Steady-state allowance use is a tier promise, not a hidden multiplier over
  // entitlement. SOTA quality moves a plan within its band but never beyond it.
  const [low, high] = expectedUtilizationRange(plan.pricePerMonth)
  const endogenous = low + (high - low) * sota
  const configured = plan.steadyUsageTarget
  const regularUtilization = configured == null
    ? endogenous
    : Math.max(low, Math.min(high, configured * (0.9 + sota * 0.2)))
  const allowance = Math.max(
    0,
    opts?.allowanceMTokPerMonth ?? storedAllowanceMTokPerMonth(plan),
  )
  const peerAllowances = allPlans
    .filter((candidate) => candidate.id !== plan.id)
    .map((candidate) => storedAllowanceMTokPerMonth(candidate))
    .filter((value) => value > 0)
    .sort((a, b) => a - b)
  const peerMedian =
    peerAllowances.length > 0
      ? peerAllowances[Math.floor(peerAllowances.length / 2)]!
      : ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth
  const baseAllowance = Math.max(
    ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth,
    peerMedian,
  )
  const generositySteps = Math.max(0, Math.log2(Math.max(1, allowance / baseAllowance)))
  const launchLift = Math.max(0, (opts?.demandShockMultiplier ?? 1) - 1)
  const heavyUserShare = Math.max(
    0.008,
    Math.min(0.16, 0.008 + generositySteps * 0.014 + sota * 0.012 + launchLift * 0.05),
  )
  const heavyUtilization = Math.min(0.99, 0.9 + sota * 0.05 + Math.min(0.04, launchLift * 0.05))
  const blendedUtilization = Math.min(
    1,
    regularUtilization * (1 - heavyUserShare) + heavyUtilization * heavyUserShare,
  )
  return {
    heavyUserShare,
    regularUtilization,
    heavyUtilization,
    blendedUtilization,
  }
}

/** Allowance MTok/user/day × utilization = actual use. */
export function planActualMTokPerUser(
  plan: SubPlan,
  baseMTok: number,
  utilization: number,
  /** Subsidy-derived effective allowance; falls back to the stored fields. */
  allowanceMTokPerMonth?: number,
): number {
  const allowancePerDay =
    allowanceMTokPerMonth != null &&
    Number.isFinite(allowanceMTokPerMonth) &&
    allowanceMTokPerMonth > 0
      ? allowanceMTokPerMonth / ECONOMY.daysPerMonth
      : Number.isFinite(plan.includedMTokPerMonth) &&
          (plan.includedMTokPerMonth ?? 0) > 0
        ? plan.includedMTokPerMonth! / ECONOMY.daysPerMonth
        : baseMTok * plan.usageMultiplier
  return allowancePerDay * Math.max(0.05, Math.min(1, utilization))
}

/**
 * Shared serve math for API + subscriptions.
 * Capacity is **token-based** (racks × model) via tokenServe.
 * PF helpers remain for tooltips / train-adjacent reporting.
 */
import type { Model, SubPlan } from '../types'
import type { ComputeSnapshot } from '../systems/compute'
import { ECONOMY } from './economy'
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
  },
): number {
  return planHeavyUserProfile(plan, allPlans, opts).blendedUtilization
}

export interface PlanHeavyUserProfile {
  /** Share of seats that are attracted by the allowance and use nearly all of it. */
  heavyUserShare: number
  regularUtilization: number
  heavyUtilization: number
  blendedUtilization: number
}

/**
 * Shared player/rival allowance-abuse profile. Generous tiers attract a small
 * cohort of power users; frontier launches temporarily make that cohort larger.
 */
export function planHeavyUserProfile(
  plan: SubPlan,
  allPlans: SubPlan[],
  opts?: {
    modelCapability?: number
    frontierCapability?: number
    demandShockMultiplier?: number
  },
): PlanHeavyUserProfile {
  const cap = opts?.modelCapability ?? 50
  const frontier = Math.max(opts?.frontierCapability ?? cap, cap)
  const sota = Math.max(0, Math.min(1, (cap - 25) / Math.max(25, frontier - 25 + 1e-6)))
  // Steady-state allowance use is a tier promise, not a hidden multiplier over
  // entitlement. SOTA quality moves a plan within its band but never beyond it.
  const [low, high] =
    plan.pricePerMonth <= 0
      ? [0.05, 0.15]
      : plan.pricePerMonth <= 25
        ? [0.2, 0.4]
        : plan.pricePerMonth <= 180
          ? [0.35, 0.6]
          : [0.5, 0.8]
  const endogenous = low + (high - low) * sota
  const configured = plan.steadyUsageTarget
  const regularUtilization = configured == null
    ? endogenous
    : Math.max(low, Math.min(high, configured * (0.9 + sota * 0.2)))
  const allowance =
    Number.isFinite(plan.includedMTokPerMonth) && (plan.includedMTokPerMonth ?? 0) > 0
      ? plan.includedMTokPerMonth!
      : ECONOMY.basePlanUsageMTokPerDay * plan.usageMultiplier * ECONOMY.daysPerMonth
  const peerAllowances = allPlans
    .filter((candidate) => candidate.id !== plan.id)
    .map((candidate) =>
      Number.isFinite(candidate.includedMTokPerMonth) &&
      (candidate.includedMTokPerMonth ?? 0) > 0
        ? candidate.includedMTokPerMonth!
        : ECONOMY.basePlanUsageMTokPerDay *
          candidate.usageMultiplier *
          ECONOMY.daysPerMonth,
    )
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
): number {
  const allowancePerDay =
    Number.isFinite(plan.includedMTokPerMonth) && (plan.includedMTokPerMonth ?? 0) > 0
      ? plan.includedMTokPerMonth! / ECONOMY.daysPerMonth
      : baseMTok * plan.usageMultiplier
  return allowancePerDay * Math.max(0.05, Math.min(1, utilization))
}

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
  pfPerMTokForModel as pfPerMTokToken,
  serveAgainstTokenPool,
  serveEffFactor,
  tokensPerDayFromSnapshotPrecise,
  type ServeModelPick,
} from './tokenServe'

export { serveEffFactor, modelCostMult, serveAgainstTokenPool }
export { sizeTokMult, familyServeMult, mtokPerDayForSku } from './tokenServe'

/**
 * How much inference PF one MTok burns for this model (derived / tooltip).
 */
export function pfPerMTokForModel(
  model: Pick<Model, 'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult'>,
  servingEfficiency = 1,
): number {
  return pfPerMTokToken(model, servingEfficiency, ECONOMY.pfPerMTokAt7B)
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
  const share =
    inferenceShare ??
    // Fallback: assume snapshot pools already encode share — use 1 so we don't double-tax
    // when caller passes a snap whose pools.inference is already the serve slice.
    // Prefer explicit share from market.
    1
  // When share omitted, approximate from pool vs raw effective
  let inferShare = share
  if (inferenceShare == null) {
    const total =
      snap.pools.training + snap.pools.inference + snap.pools.research
    inferShare =
      total > 1e-9 ? snap.pools.inference / total : 0.35
  }
  return tokensPerDayFromSnapshotPrecise(
    snap,
    model,
    servingEfficiency,
    inferShare,
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
  const slack = 1.02
  const serveFrac = Math.min(1, (capacityPf * slack) / demandPf)
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
  opts?: { modelCapability?: number; frontierCapability?: number },
): number {
  const enabled = allPlans.filter((p) => p.enabled)
  const paid = enabled.filter((p) => p.pricePerMonth > 0)
  const cap = opts?.modelCapability ?? 50
  const frontier = Math.max(opts?.frontierCapability ?? cap, cap)
  const sota = Math.max(0, Math.min(1, (cap - 25) / Math.max(25, frontier - 25 + 1e-6)))

  if (plan.pricePerMonth <= 0) {
    return Math.min(0.55, 0.28 + sota * 0.18)
  }

  if (paid.length <= 1) {
    const p = plan.pricePerMonth
    let u = 0.52 + Math.min(0.45, Math.log10(p + 1) / 3.2)
    u = Math.min(1, u * (1 + sota * 0.18))
    return Math.max(0.15, Math.min(1, u))
  }

  const prices = paid.map((p) => p.pricePerMonth).sort((a, b) => a - b)
  const minP = prices[0]!
  const maxP = prices[prices.length - 1]!
  const rank =
    maxP <= minP ? 0.5 : (plan.pricePerMonth - minP) / (maxP - minP)

  let u = 0.5 + rank * 0.48
  u = Math.min(1, u * (1 + sota * 0.15))
  return Math.max(0.15, Math.min(1, u))
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

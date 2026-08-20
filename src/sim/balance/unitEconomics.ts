/**
 * Canonical API / plan unit economics.
 *
 * Settlement in market.ts remains the simulation truth for yesterday's ledgers.
 * This module is the single source for:
 *   - live unit cost (from settlement rows when the model served)
 *   - capacity-based estimates that use the SAME cost components as settlement
 *   - marginPct = (revenue − cost) / revenue
 *   - in/out cost split (input cheaper than output)
 */

import type { Model, SimState, SubPlan } from '../types'
import type { ComputeSnapshot } from '../systems/compute'
import { energyPriceForState, playerBuildingOpex } from '../systems/map'
import { ECONOMY } from './economy'
import {
  modelCostMult,
  tokensPerDayFromSnapshotPrecise,
} from './tokenServe'
import {
  CANONICAL_TEXT_INPUT_SHARE,
  CANONICAL_TEXT_OUTPUT_SHARE,
} from './workload'

/**
 * Cost split vs the canonical 70% input / 30% output workload. The weighted
 * average remains exactly one blended unit while decode stays materially more
 * expensive than prefill/cacheable input.
 */
export const API_COST_IN_MULT = 0.5
export const API_COST_OUT_MULT = 13 / 6

if (
  Math.abs(
    API_COST_IN_MULT * CANONICAL_TEXT_INPUT_SHARE +
      API_COST_OUT_MULT * CANONICAL_TEXT_OUTPUT_SHARE -
      1,
  ) > 1e-9
) {
  throw new Error('API input/output cost split must preserve blended unit cost')
}

/**
 * Degenerate-campus floor ($/MTok). Empty fleets still need a non-zero basis
 * so birth prices and UI don't collapse to bandwidth-only dust.
 */
export const API_UNIT_COST_FLOOR = 0.05

/**
 * Fallback when no SimState/snapshot is available (rival buildScaledModel,
 * offline helpers). Tuned ~5× the pre-rebalance 0.28 seed so early BF16
 * list prices stay under thin/negative margin pressure.
 */
export const FALLBACK_COST_PER_MTOK = 1.4

/**
 * Cloud-market launch basis when the current campus is absent, cannot fit the
 * model, or is too under-provisioned to produce a meaningful marginal quote.
 * Providers get sub-linear scale economies instead of charging the full
 * active-parameter ratio directly to one request.
 */
export function launchReferenceApiCostPerMTok(
  model: Pick<
    Model,
    'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult'
  >,
): number {
  const relativeWork = Math.max(0.05, modelCostMult(model))
  return Math.max(
    API_UNIT_COST_FLOOR,
    FALLBACK_COST_PER_MTOK * Math.pow(relativeWork, 0.65),
  )
}

/**
 * Commercial list-price basis for automatic suggestions. A provider may have
 * very high *realized* COGS while a campus is empty or badly under-utilized,
 * but dividing all fixed campus costs by a token trickle is not a credible
 * market quote. Keep the real unit cost visible separately and bound only the
 * automatic list-price basis to a conservative cloud/peer launch envelope.
 */
export function boundedApiListCostPerMTok(
  model: Pick<
    Model,
    'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult'
  >,
  observedUnitCost: number,
): number {
  const reference = launchReferenceApiCostPerMTok(model)
  const observed = Number.isFinite(observedUnitCost)
    ? Math.max(API_UNIT_COST_FLOOR, observedUnitCost)
    : reference
  return Math.min(observed, reference * 2)
}

export interface ServingOpsDayBreakdown {
  energyDay: number
  amortDay: number
  buildingOpexDay: number
  leaseDay: number
  /** Sum of the four components before inference share. */
  grossOpsDay: number
  inferenceShare: number
  /** Settlement-composition ops attributed to inference. */
  opsDay: number
}

export interface ApiUnitCost {
  blended: number
  costIn: number
  costOut: number
  source: 'live' | 'estimate'
  opsDay: number
  capacityMTok: number
  components: ServingOpsDayBreakdown
}

/** True margin: (revenue − cost) / revenue. Negative when losing money. */
export function marginPct(revenue: number, cost: number): number {
  if (!(revenue > 0)) {
    return cost > 0 ? -1 : 0
  }
  return (revenue - cost) / revenue
}

/** Markup ratio price/cost (1 = at cost, 2 = 100% markup). */
export function markupRatio(price: number, cost: number): number {
  return price / Math.max(0.001, cost)
}

/** Markup percent: (price/cost − 1) × 100. */
export function markupPct(price: number, cost: number): number {
  return (markupRatio(price, cost) - 1) * 100
}

export function splitInOutCost(blended: number): {
  costIn: number
  costOut: number
} {
  const unit = Math.max(0, blended)
  return {
    costIn: Math.max(0.005, unit * API_COST_IN_MULT),
    costOut: Math.max(0.01, unit * API_COST_OUT_MULT),
  }
}

export type ApiHostingCostSource = 'campus' | 'cloud_reference'

export interface ApiHostingCostFloor {
  blended: number
  costIn: number
  costOut: number
  source: ApiHostingCostSource
  opsDay: number
  capacityMTok: number
  components: ServingOpsDayBreakdown
  /** Campus ops (energy + amort + opex + lease) attributed per MTok. */
  campusPerMTok: number
  bandwidthPerMTok: number
}

/**
 * Listing floor for a public API ($/MTok).
 *
 * Real LLM APIs quote from GPU-hour economics at *target serving utilization*,
 * not from yesterday's token trickle:
 *   - Prefill (input) is compute-bound; decode (output) is memory-bound and
 *     typically 3–6× more expensive per token. The 0.5× / 13/6× split keeps a
 *     70/30 mix at one blended unit (~4.3× out/in).
 *   - Fully-loaded COGS = (energy + accelerator amort + hall opex + leases)
 *     × inference share ÷ this model's daily token capacity + egress.
 *   - Larger models (more active parameters, heavier families) produce fewer
 *     MTok per PF-day, so the same campus bills more per million tokens.
 *   - With no deployable replica, the floor is a cloud-rental launch quote
 *     instead of dividing fixed campus costs by a dust denominator.
 *
 * Training tokens are sunk and never enter this floor.
 */
export function apiHostingCostFloor(
  state: SimState,
  snap: ComputeSnapshot,
  model: Pick<
    Model,
    'id' | 'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult' | 'tokPerSecMult'
  >,
  opts?: { energyPricePerMWh?: number },
): ApiHostingCostFloor {
  const unit = apiUnitCostPerMTok(state, snap, model, {
    ...opts,
    forceEstimate: true,
  })
  const deployableCapacityMTok = tokensPerDayFromSnapshotPrecise(
    snap,
    model,
    state.player.servingEfficiency,
  )
  if (deployableCapacityMTok <= 1e-6) {
    const blended = launchReferenceApiCostPerMTok(model)
    const split = splitInOutCost(blended)
    return {
      blended,
      costIn: split.costIn,
      costOut: split.costOut,
      source: 'cloud_reference',
      opsDay: unit.opsDay,
      capacityMTok: 0,
      components: unit.components,
      campusPerMTok: 0,
      bandwidthPerMTok: ECONOMY.bandwidthPerMTok,
    }
  }
  return {
    blended: unit.blended,
    costIn: unit.costIn,
    costOut: unit.costOut,
    source: 'campus',
    opsDay: unit.opsDay,
    capacityMTok: unit.capacityMTok,
    components: unit.components,
    campusPerMTok: unit.opsDay / unit.capacityMTok,
    bandwidthPerMTok: ECONOMY.bandwidthPerMTok,
  }
}

/** Lift a public in/out list so neither side sits below the hosting floor. */
export function clampApiListToHostingFloor(
  priceIn: number,
  priceOut: number,
  floor: Pick<ApiHostingCostFloor, 'costIn' | 'costOut'>,
): { priceIn: number; priceOut: number } {
  const inPrice = Number.isFinite(priceIn) ? priceIn : floor.costIn
  const outPrice = Number.isFinite(priceOut) ? priceOut : floor.costOut
  return {
    priceIn: Math.max(floor.costIn, inPrice),
    priceOut: Math.max(floor.costOut, outPrice),
  }
}

/**
 * Settlement-composition serving ops for the player campus.
 * Components match `attributedServingFixedCost` in market.ts:
 * energy + chip amort (live racks) + building opex + leases, × inference share.
 *
 * Energy uses the capacity-estimate proxy (MW × 24 × $/MWh). Settlement uses
 * the reconciled import bill — same structure, bounded divergence allowed.
 */
export function servingOpsDayEstimate(
  state: SimState,
  snap: ComputeSnapshot,
  energyPricePerMWh: number,
): ServingOpsDayBreakdown {
  const inferenceShare = Math.max(0.08, state.player.allocation.inference)
  const energyDay = Math.max(0, snap.mwDemand) * 24 * Math.max(0, energyPricePerMWh)
  let rackCapital = 0
  for (const rack of state.player.rackFleet ?? []) {
    if (rack.status === 'live') {
      rackCapital += Math.max(0, rack.paidEach) * Math.max(0, rack.count)
    }
  }
  const amortDay = rackCapital / ECONOMY.chipAmortDays
  const buildingOpexDay = Math.max(0, playerBuildingOpex(state))
  const leaseDay = Math.max(0, state.player.computeLeaseCostToday ?? 0)
  const grossOpsDay = energyDay + amortDay + buildingOpexDay + leaseDay
  return {
    energyDay,
    amortDay,
    buildingOpexDay,
    leaseDay,
    grossOpsDay,
    inferenceShare,
    opsDay: grossOpsDay * inferenceShare,
  }
}

function resolveLiveUnitCost(
  state: SimState,
  modelId: string,
  dayCogs?: number,
  dayMTok?: number,
): number | null {
  let cogs = dayCogs
  let mtok = dayMTok
  if (cogs == null || mtok == null) {
    const row = state.lastMarket?.modelFinance?.find((r) => r.modelId === modelId)
    if (row) {
      cogs = row.dayApiCogs
      mtok = row.dayApiMTok
    }
  }
  if (
    Number.isFinite(cogs) &&
    Number.isFinite(mtok) &&
    (cogs ?? 0) > 0 &&
    (mtok ?? 0) > 0.001
  ) {
    return (cogs as number) / Math.max(0.001, mtok as number)
  }
  return null
}

/**
 * Canonical serve cost per MTok for a model.
 * Prefers yesterday's settlement-allocated COGS when the model served tokens;
 * otherwise a capacity-based estimate with settlement cost composition.
 */
export function apiUnitCostPerMTok(
  state: SimState,
  snap: ComputeSnapshot,
  model: Pick<
    Model,
    'id' | 'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult' | 'tokPerSecMult'
  >,
  opts?: {
    energyPricePerMWh?: number
    dayCogs?: number
    dayMTok?: number
    /** Force capacity estimate even when live rows exist. */
    forceEstimate?: boolean
  },
): ApiUnitCost {
  const energyPrice =
    opts?.energyPricePerMWh ?? energyPriceForState(state)
  const components = servingOpsDayEstimate(state, snap, energyPrice)
  // Snapshot inference pool already includes allocation — do not re-apply share.
  const capacityMTok = Math.max(
    0.25,
    tokensPerDayFromSnapshotPrecise(
      snap,
      model,
      state.player.servingEfficiency,
    ),
  )
  const estimateBlended = Math.max(
    API_UNIT_COST_FLOOR,
    components.opsDay / capacityMTok + ECONOMY.bandwidthPerMTok,
  )

  const live =
    opts?.forceEstimate === true
      ? null
      : resolveLiveUnitCost(state, model.id, opts?.dayCogs, opts?.dayMTok)

  const blended = live != null ? Math.max(API_UNIT_COST_FLOOR, live) : estimateBlended
  const { costIn, costOut } = splitInOutCost(blended)
  return {
    blended,
    costIn,
    costOut,
    source: live != null ? 'live' : 'estimate',
    opsDay: components.opsDay,
    capacityMTok,
    components,
  }
}

/**
 * Capacity-estimate unit cost for model birth (no live traffic yet).
 * Guards empty campuses with API_UNIT_COST_FLOOR / FALLBACK_COST_PER_MTOK.
 */
export function birthApiUnitCostPerMTok(
  state: SimState,
  snap: ComputeSnapshot,
  model: Pick<
    Model,
    'id' | 'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult' | 'tokPerSecMult'
  >,
  opts?: { energyPricePerMWh?: number },
): number {
  const referenceCost = launchReferenceApiCostPerMTok(model)
  const deployableCapacityMTok = tokensPerDayFromSnapshotPrecise(
    snap,
    model,
    state.player.servingEfficiency,
  )
  const unit = apiUnitCostPerMTok(state, snap, model, {
    ...opts,
    forceEstimate: true,
  })
  // No resident endpoint means there is no local marginal quote. Likewise, a
  // tiny launch fleet should surface its capacity warning rather than seed a
  // $9,000/M list price from fixed campus costs divided by near-zero tokens.
  if (deployableCapacityMTok <= 1e-6) return referenceCost
  return boundedApiListCostPerMTok(model, unit.blended)
}

/** Markup % implied by a blended list price over a unit cost. */
export function apiPriceMarkupPct(
  blendedPrice: number,
  unitCostBlended: number,
): number {
  return Math.max(
    0,
    Math.min(500, markupPct(blendedPrice, Math.max(0.001, unitCostBlended))),
  )
}

/**
 * Plan margin $/sub/month. Prefer settlement `marginPerSubMonth` when present;
 * otherwise estimate from allowance × unit cost (same COGS composition intent).
 */
export function planMarginPerSubMonth(input: {
  plan: Pick<SubPlan, 'pricePerMonth'>
  isFree: boolean
  unitCostPerMTok: number
  allowanceMTokPerDay: number
  settlementMarginPerSubMonth?: number
}): number {
  if (
    input.settlementMarginPerSubMonth != null &&
    Number.isFinite(input.settlementMarginPerSubMonth)
  ) {
    return input.settlementMarginPerSubMonth
  }
  const cogsMo =
    Math.max(0, input.allowanceMTokPerDay) *
    Math.max(0, input.unitCostPerMTok) *
    ECONOMY.daysPerMonth
  if (input.isFree) return -cogsMo
  return Math.max(0, input.plan.pricePerMonth) - cogsMo
}

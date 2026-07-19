import type { Model, ModelFamily, SimState } from '../types'
import type { ComputeSnapshot } from '../systems/compute'
import { ECONOMY } from './economy'
import {
  modelCostMult as tokenModelCostMult,
  suggestApiFromUnitCost,
  tokensPerDayFromSnapshotPrecise,
} from './tokenServe'

/** Share of total served MTok treated as input vs output (chat-like mix). */
export const API_IN_SHARE = 0.3
export const API_OUT_SHARE = 0.7

export interface FullyLoadedApiCostFloor {
  blended: number
  costIn: number
  costOut: number
  source: 'live' | 'marginal'
}

/**
 * Returns the authoritative cost floor for an API model. Once a model has live
 * traffic the ledger already knows its complete serving burden (hardware,
 * facilities, energy and leases), so pricing must use that figure rather than
 * the cheaper marginal electricity estimate shown before launch.
 */
export function fullyLoadedApiCostFloor(input: {
  dayCogs?: number
  dayMTok?: number
  marginalCostPerMTok: number
}): FullyLoadedApiCostFloor {
  const marginal = Math.max(0.005, input.marginalCostPerMTok)
  const hasLiveCost =
    Number.isFinite(input.dayCogs) &&
    Number.isFinite(input.dayMTok) &&
    (input.dayCogs ?? 0) > 0 &&
    (input.dayMTok ?? 0) > 0.001
  const live = hasLiveCost ? (input.dayCogs ?? 0) / Math.max(0.001, input.dayMTok ?? 0) : 0
  const blended = Math.max(marginal, live)

  // 30% input / 70% output mixes back to exactly the blended floor.
  return {
    blended,
    costIn: blended * 0.65,
    costOut: blended * 1.15,
    source: hasLiveCost && live >= marginal ? 'live' : 'marginal',
  }
}

export type PricingSignal =
  | 'fair'
  | 'below_cost'
  | 'undercutting'
  | 'expensive'
  | 'demand_collapse'
  | 'stingy_plan'
  | 'unsustainable_plan'

export interface PricingDiagnostic {
  primary: PricingSignal
  signals: PricingSignal[]
  severity: 'ok' | 'amber' | 'danger'
  peerMedian: number | null
  ratioToPeer: number | null
  marginRatio: number
  explanation: string
}

export interface ApiPeerPrice {
  price: number
  capability: number
  featureScore: number
  /** Effective endpoint throughput after serving precision. */
  tokPerSec?: number
}

/**
 * A single quality score for API demand comparisons. Capability leads, while
 * useful surface area and interactive speed let efficient models compete.
 */
export function apiDemandQuality(input: {
  capability: number
  featureScore: number
  tokPerSec?: number
}): number {
  const speedBonus = Math.log10(Math.max(1, input.tokPerSec ?? 1) + 9) * 4
  return Math.max(10, input.capability + input.featureScore * 0.22 + speedBonus)
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Shared API pricing status used by demand and UI. Peer prices are normalized
 * by capability and useful feature coverage before comparison.
 */
export function analyzeApiPricing(input: {
  price: number
  marginalCost: number
  capability: number
  featureScore: number
  tokPerSec?: number
  peers: ApiPeerPrice[]
}): PricingDiagnostic {
  const ownQuality = apiDemandQuality(input)
  const normalizedPeers = input.peers
    .filter((peer) => peer.price >= 0)
    .map((peer) => {
      const peerQuality = apiDemandQuality(peer)
      return peer.price * (ownQuality / peerQuality)
    })
  const peerMedian = median(normalizedPeers)
  const ratioToPeer = peerMedian != null ? input.price / Math.max(0.001, peerMedian) : null
  const marginRatio = input.price / Math.max(0.001, input.marginalCost)
  const capabilityLead =
    input.peers.length > 0
      ? input.capability - Math.max(...input.peers.map((peer) => peer.capability))
      : 0
  const featureLead =
    input.peers.length > 0
      ? input.featureScore - Math.max(...input.peers.map((peer) => peer.featureScore))
      : 0
  const signals: PricingSignal[] = []
  if (input.price < input.marginalCost * 1.1) signals.push('below_cost')
  if (ratioToPeer != null && ratioToPeer < 0.75 && marginRatio >= 1.1) {
    signals.push('undercutting')
  }
  if (
    ratioToPeer != null &&
    ratioToPeer > 1.5 &&
    capabilityLead < 5 &&
    featureLead < 15
  ) {
    signals.push('expensive')
  }
  if (ratioToPeer != null && ratioToPeer > 2.25) signals.push('demand_collapse')
  const primary: PricingSignal =
    signals.includes('demand_collapse')
      ? 'demand_collapse'
      : signals.includes('below_cost')
        ? 'below_cost'
        : signals.includes('expensive')
          ? 'expensive'
          : signals.includes('undercutting')
            ? 'undercutting'
            : 'fair'
  const severity =
    primary === 'below_cost' || primary === 'demand_collapse'
      ? 'danger'
      : primary === 'fair'
        ? 'ok'
        : 'amber'
  const explanation =
    primary === 'below_cost'
      ? 'Blended price is below 1.10× marginal serving cost.'
      : primary === 'undercutting'
        ? 'Profitable price is over 25% below the quality-adjusted peer median.'
        : primary === 'expensive'
          ? 'Price is over 1.50× peers without a clear capability or feature lead.'
          : primary === 'demand_collapse'
            ? 'Price is over 2.25× peer value; severe demand loss is likely.'
            : 'Price is within the sustainable competitive range.'
  return { primary, signals, severity, peerMedian, ratioToPeer, marginRatio, explanation }
}

export interface PlanPeerValue {
  price: number
  includedMTokPerMonth: number
  capability: number
  featureScore: number
}

export function analyzePlanPricing(input: {
  price: number
  includedMTokPerMonth: number
  expectedUtilization: number
  marginalCostPerMTok: number
  capability: number
  featureScore: number
  peers: PlanPeerValue[]
}): PricingDiagnostic {
  const ownQuality = Math.max(10, input.capability + input.featureScore * 0.22)
  const ownValuePerDollar =
    (input.includedMTokPerMonth * ownQuality) / Math.max(0.01, input.price || 0.01)
  const peerValues = input.peers
    .filter((peer) => peer.price > 0 && peer.includedMTokPerMonth > 0)
    .map(
      (peer) =>
        (peer.includedMTokPerMonth * Math.max(10, peer.capability + peer.featureScore * 0.22)) /
        peer.price,
    )
  const peerMedianValue = median(peerValues)
  const valueRatio =
    peerMedianValue != null ? ownValuePerDollar / Math.max(0.001, peerMedianValue) : null
  const expectedCogs =
    input.includedMTokPerMonth *
    Math.max(0.05, Math.min(1, input.expectedUtilization)) *
    Math.max(0, input.marginalCostPerMTok)
  const marginRatio = input.price > 0 ? (input.price - expectedCogs) / input.price : -expectedCogs
  const signals: PricingSignal[] = []
  if (valueRatio != null && valueRatio < 0.7) signals.push('stingy_plan')
  if (input.price <= 0 ? expectedCogs > 0 : expectedCogs > input.price * 0.9) {
    signals.push('unsustainable_plan')
  }
  const primary: PricingSignal = signals.includes('unsustainable_plan')
    ? 'unsustainable_plan'
    : signals.includes('stingy_plan')
      ? 'stingy_plan'
      : 'fair'
  const severity = primary === 'unsustainable_plan' ? 'danger' : primary === 'fair' ? 'ok' : 'amber'
  const explanation =
    primary === 'unsustainable_plan'
      ? 'Expected serving COGS exceeds 90% of monthly plan revenue.'
      : primary === 'stingy_plan'
        ? 'Included quality-adjusted value per dollar is below 70% of peers.'
        : 'Plan value and serving cost are in a sustainable range.'
  return {
    primary,
    signals,
    severity,
    peerMedian: peerMedianValue,
    ratioToPeer: valueRatio,
    marginRatio,
    explanation,
  }
}

/** Re-export token-based cost mult (active params + family). */
export function modelCostMult(
  model: Pick<Model, 'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult'>,
): number {
  return tokenModelCostMult(model)
}

/**
 * Infrastructure cost of serving — power + rack amort + bandwidth.
 * Capacity from **token path** (same as market Cap).
 */
export function serveInfraCost(
  state: SimState,
  snap: ComputeSnapshot,
  energyPricePerMWh: number,
): {
  energyDay: number
  amortDay: number
  fixedDay: number
  /** $/MTok at full inference capacity (variable-ish unit cost) */
  costPerMTok: number
  capacityMTok: number
} {
  const inferShare = Math.max(
    0.05,
    state.player.allocation.inference /
      Math.max(
        0.01,
        state.player.allocation.training +
          state.player.allocation.inference +
          state.player.allocation.research,
      ),
  )
  const energyDay = Math.max(0, snap.mwDemand) * 24 * energyPricePerMWh * inferShare

  let capital = 0
  for (const r of state.player.rackFleet ?? []) {
    if (r.status === 'live') capital += r.paidEach * r.count
  }
  for (const inv of state.player.chips) {
    capital += inv.count * 32_000
  }
  const amortDay = (capital / ECONOMY.chipAmortDays) * inferShare
  const fixedDay = energyDay + amortDay

  const active = state.player.models.find(
    (m) =>
      m.id === state.player.pricing.activeModelId &&
      (m.release === 'released' || m.shipped),
  )
  const capacityMTok = Math.max(
    0.25,
    active
      ? tokensPerDayFromSnapshotPrecise(
          snap,
          active,
          state.player.servingEfficiency,
          inferShare,
        )
      : 0.25,
  )
  // cost already model-specific via capacity (smaller models → more MTok → lower $/MTok)
  const costPerMTok = fixedDay / capacityMTok + ECONOMY.bandwidthPerMTok

  return { energyDay, amortDay, fixedDay, costPerMTok, capacityMTok }
}

export function blendApiPrice(priceIn: number, priceOut: number): number {
  return priceIn * API_IN_SHARE + priceOut * API_OUT_SHARE
}

/** Split total MTok into in/out buckets for billing. */
export function splitInOutMTok(totalMTok: number): { inMTok: number; outMTok: number } {
  return {
    inMTok: totalMTok * API_IN_SHARE,
    outMTok: totalMTok * API_OUT_SHARE,
  }
}

export function apiRevenueFromMTok(
  totalMTok: number,
  priceIn: number,
  priceOut: number,
): number {
  const { inMTok, outMTok } = splitInOutMTok(totalMTok)
  return inMTok * priceIn + outMTok * priceOut
}

/**
 * Cost-based suggested API prices ($ / 1M tokens in & out).
 * `markupPct` 0 = at cost, 100 = 2× cost, 200 = 3×, etc.
 */
/**
 * Cost-based suggested API prices.
 * `costPerMTokBase` should already be model-specific (from serveInfraCost on that Cap).
 * Does **not** re-apply modelCostMult (avoids double-tax on large models).
 */
export function suggestApiInOut(opts: {
  costPerMTokBase: number
  paramsB: number
  activeParamsB?: number
  family: ModelFamily
  inferCostMult?: number
  capability?: number
  markupPct?: number
  /** When true, scale base cost by this model's intensity vs a reference (legacy). Default false. */
  applyModelMult?: boolean
}): {
  costIn: number
  costOut: number
  priceIn: number
  priceOut: number
  blendedCost: number
  blendedPrice: number
  markupPct: number
} {
  let unit = Math.max(0.005, opts.costPerMTokBase)
  if (opts.applyModelMult) {
    unit *= modelCostMult({
      paramsB: opts.paramsB,
      activeParamsB: opts.activeParamsB,
      family: opts.family,
      inferCostMult: opts.inferCostMult ?? 1,
    })
  }
  const sug = suggestApiFromUnitCost({
    costPerMTok: unit,
    capability: opts.capability,
    markupPct: opts.markupPct,
  })
  return {
    ...sug,
    blendedCost: blendApiPrice(sug.costIn, sug.costOut),
    blendedPrice: blendApiPrice(sug.priceIn, sug.priceOut),
  }
}

/** Legacy single-price suggestion (blended out-heavy). */
export function suggestedApiPricePerMTok(opts: {
  paramsB: number
  activeParamsB?: number
  family: ModelFamily
  inferCostMult: number
  capability: number
  costPerMTokBase?: number
}): number {
  const s = suggestApiInOut({
    costPerMTokBase: opts.costPerMTokBase ?? 0.35,
    paramsB: opts.paramsB,
    activeParamsB: opts.activeParamsB,
    family: opts.family,
    inferCostMult: opts.inferCostMult,
    capability: opts.capability,
    markupPct: 120,
  })
  return Math.round(s.blendedPrice * 100) / 100
}

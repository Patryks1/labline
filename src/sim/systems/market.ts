import { DEMAND_MODEL_VERSION, ECONOMY, SEGMENTS, WORLD_POPULATION } from '../balance/economy'
import { emptyBenchmarks, segmentBenchmarkFit } from '../balance/benchmarks'
import type {
  FinanceDaySnapshot,
  MarketOffer,
  Model,
  ModelFinanceRow,
  PlanDayStats,
  ProductPricing,
  RivalLab,
  SegmentId,
  SimState,
  SubPlan,
  ComputeLedger as SimComputeLedger,
  ComputeWorkItem as SimComputeWorkItem,
} from '../types'
import { analyzeApiPricing, apiRevenueFromMTok, blendApiPrice } from '../balance/pricing'
import {
  inferenceCapacityMTok,
  inferencePfAvailable,
  inferencePfDemand,
  planActualMTokPerUser,
  planUsageUtilization,
  settleComputeLedger,
} from '../balance/serveCompute'
import { normalizeAllocation } from './compute'
import { computeSnapshot } from './compute'
import {
  compactCompletedFacilitiesForOwner,
  facilityAnchorTiles,
  usesCompactWorld,
} from './worldAccess'
import { cityPopulationDemandMultiplier } from './cityGrowth'
import {
  labFacilityEnergyTotals,
  resolvePlayerPowerMw,
  playerBuildingOpex,
  playerLatencyScore,
  playerServiceLatencyScore,
} from './map'
import {
  onsiteGenerationUpkeepDay,
  powerExportDayRevenue,
  powerImportBill,
} from './facilities'
import { labStaffWagePerDay, staffWagePerDay } from './staff'
import { computeLabSnapshot, getLab } from './labEngine'
import { marketingReach } from './org'
import {
  bestModelOnPlan,
  isFreePlan,
  maxSeatsForPlan,
  planAllowanceMTokPerMonth,
  planApiEquivalentValue,
  planAttractiveness,
  freeTierDemandProfile,
  planPriceTooHighScore,
  planModelTrafficMix,
  planModelServePrecision,
  planComputePriority,
  modelForServePrecision,
  planAllowanceExpectation,
  planStabilityDissatisfaction,
  planServeModifiers,
  planSubsidyRatio,
  planDemandShockMultiplier,
} from './plans'
import {
  offerUtility,
  segmentSoftmaxTemp,
  sotaProximity,
  sotaUsageMultiplier,
  softmaxShares,
} from './marketScore'
import { deriveDemandSegments } from './productPortfolio'
import {
  isGenerationOnlyModel,
  marketOfferCanCompeteForSegment,
} from './modelEligibility'

export { offerUtility, scoreOfferFactors, segmentShares } from './marketScore'

export const OUTSIDE_OPTION_PROVIDER_ID = 'outside'

export function attributedServingFixedCost(input: {
  energyCostDay: number
  chipAmortDay: number
  buildingOpexDay: number
  computeLeaseCostDay: number
  inferenceShare: number
}): number {
  const inferenceShare = Math.max(0, Math.min(1, input.inferenceShare))
  return (
    Math.max(0, input.energyCostDay) +
    Math.max(0, input.chipAmortDay) +
    Math.max(0, input.buildingOpexDay) +
    Math.max(0, input.computeLeaseCostDay)
  ) * inferenceShare
}

export const DOMINANT_MARKET_SHARE = 0.5

/**
 * @deprecated Capacity admission now applies continuously at every market
 * share through the compute ledger. Retained for old callers and saves.
 */
export function dominantCapacitySalesGate(
  _marketShare: number,
  _apiServeFrac: number,
  _subServeFrac: number,
): boolean {
  return false
}

/**
 * Market share represents customers actually served, not requests won before
 * capacity settlement. A provider with no available compute therefore cannot
 * retain a large headline share.
 */
export function capacityAdjustedMarketShare(rawShare: number, serveFrac: number): number {
  return (
    Math.max(0, rawShare) *
    Math.max(0, Math.min(1, Number.isFinite(serveFrac) ? serveFrac : 0))
  )
}

function marketOfferKey(labId: string, modelId: string): string {
  return `${labId}\u0000${modelId}`
}

function normalizedProviderShares(
  shares: Readonly<Record<string, number>>,
  keys: readonly string[],
): Record<string, number> {
  const result: Record<string, number> = {}
  let sum = 0
  for (const key of keys) {
    const value = Math.max(0, Number.isFinite(shares[key]) ? shares[key]! : 0)
    result[key] = value
    sum += value
  }
  if (sum <= 1e-12) {
    result[OUTSIDE_OPTION_PROVIDER_ID] = 1
    return result
  }
  for (const key of keys) result[key] = (result[key] ?? 0) / sum
  return result
}

/**
 * Apply a segment's switching inertia to a fresh provider-choice target.
 *
 * Shares are deliberately persisted only by lab plus the outside option. An
 * offer/model can therefore be replaced without pretending every customer is
 * a new acquisition. Providers that leave the market flow to the outside
 * option; all remaining shares are normalized exactly once for conservation.
 */
export function settleSegmentProviderShares(
  priorShares: Readonly<Record<string, number>> | undefined,
  targetShares: Readonly<Record<string, number>>,
  switchingFriction: number,
): Record<string, number> {
  const activeProviders = Object.keys(targetShares)
    .filter((key) => key !== OUTSIDE_OPTION_PROVIDER_ID)
    .sort((a, b) => a.localeCompare(b))
  const keys = [...activeProviders, OUTSIDE_OPTION_PROVIDER_ID]
  const target = normalizedProviderShares(targetShares, keys)

  const hasPrior = priorShares != null && Object.values(priorShares).some((value) => value > 0)
  if (!hasPrior) return target

  const active = new Set(activeProviders)
  const inactivePrior = Object.entries(priorShares!).reduce(
    (sum, [providerId, share]) =>
      providerId !== OUTSIDE_OPTION_PROVIDER_ID && !active.has(providerId)
        ? sum + Math.max(0, Number.isFinite(share) ? share : 0)
        : sum,
    0,
  )
  const priorInput: Record<string, number> = {
    ...priorShares,
    [OUTSIDE_OPTION_PROVIDER_ID]:
      Math.max(0, priorShares![OUTSIDE_OPTION_PROVIDER_ID] ?? 0) + inactivePrior,
  }
  const prior = normalizedProviderShares(priorInput, keys)
  const inertia = Math.max(0, Math.min(0.995, switchingFriction))
  const next: Record<string, number> = {}
  for (const key of keys) {
    next[key] =
      (prior[key] ?? 0) * inertia + (target[key] ?? 0) * (1 - inertia)
  }
  return normalizedProviderShares(next, keys)
}

function headlineSubPrice(state: SimState): number {
  const paid = state.player.pricing.plans.filter((p) => p.enabled && p.pricePerMonth > 0)
  if (paid.length === 0) {
    const free = state.player.pricing.plans.find((p) => p.enabled)
    return free ? 0 : 999
  }
  return Math.min(...paid.map((p) => p.pricePerMonth))
}

function isPublic(m: { shipped: boolean; release?: string }) {
  return m.release === 'released' || m.shipped
}

function bestPlayerModel(state: SimState) {
  const shipped = state.player.models.filter(isPublic)
  if (shipped.length === 0) return null
  const active = shipped.find((m) => m.id === state.player.pricing.activeModelId)
  if (active) return active
  return [...shipped].sort((a, b) => b.capability - a.capability)[0]!
}

/** Blended list price for market scoring (in/out weighted). Per-model first. */
function modelApiPrice(state: SimState, modelId: string | null): number {
  const { priceIn, priceOut } = modelApiInOut(state, modelId)
  return blendApiPrice(priceIn, priceOut)
}

/**
 * Resolve the public API offer attached to one model. An explicit model list
 * is authoritative. Otherwise the lab's current policy prices its active
 * endpoint before we fall back to a launch suggestion. Cost estimates remain
 * floors/fallbacks; they are never mistaken for the price customers pay.
 */
export function modelOfferApiInOut(
  pricing: ProductPricing,
  model: Model | null | undefined,
): { priceIn: number; priceOut: number } {
  const fallbackIn = pricing.apiPriceInPerMTok ?? pricing.apiPricePerMTok * 0.35
  const fallbackOut = pricing.apiPriceOutPerMTok ?? pricing.apiPricePerMTok * 1.25
  if (!model) return { priceIn: fallbackIn, priceOut: fallbackOut }

  if (model.apiPriceInPerMTok != null || model.apiPriceOutPerMTok != null) {
    return {
      priceIn: Math.max(
        0,
        model.apiPriceInPerMTok ??
          model.suggestedApiPriceIn ??
          model.costApiPriceIn ??
          fallbackIn,
      ),
      priceOut: Math.max(
        0,
        model.apiPriceOutPerMTok ??
          model.suggestedApiPriceOut ??
          model.costApiPriceOut ??
          fallbackOut,
      ),
    }
  }
  if (model.apiPricePerMTok != null) {
    const splitBlend = blendApiPrice(0.35, 1.25)
    return {
      priceIn: Math.max(0, (model.apiPricePerMTok * 0.35) / splitBlend),
      priceOut: Math.max(0, (model.apiPricePerMTok * 1.25) / splitBlend),
    }
  }
  if (model.id === pricing.activeModelId) {
    return {
      priceIn: Math.max(0, fallbackIn),
      priceOut: Math.max(0, fallbackOut),
    }
  }
  return {
    priceIn: Math.max(
      0,
      model.suggestedApiPriceIn ?? model.costApiPriceIn ?? fallbackIn,
    ),
    priceOut: Math.max(
      0,
      model.suggestedApiPriceOut ?? model.costApiPriceOut ?? fallbackOut,
    ),
  }
}

export function modelOfferApiPrice(
  pricing: ProductPricing,
  model: Model | null | undefined,
): number {
  const { priceIn, priceOut } = modelOfferApiInOut(pricing, model)
  return blendApiPrice(priceIn, priceOut)
}

/**
 * Resolve $/1M input & output for a model.
 * Priority: model list → model suggested → lab default.
 * Each model can (and should) have distinct in/out list prices.
 */
function modelApiInOut(
  state: SimState,
  modelId: string | null,
): { priceIn: number; priceOut: number } {
  const p = state.player.pricing
  return modelOfferApiInOut(
    p,
    modelId ? state.player.models.find((model) => model.id === modelId) : null,
  )
}

/** Reliability customers experience after queues, timeouts, and retries. */
export function perceivedServiceReliability(
  modelReliability: number,
  servicePain: number,
): number {
  const pain = Math.max(0, Math.min(1, servicePain))
  return Math.max(8, modelReliability * (1 - pain * 0.55) - pain * 12)
}

/** Paid acquisition affects subscription-oriented utility symmetrically. */
export function marketingUtilityBonus(
  marketingSpendPerDay: number,
  prefersSubscription: boolean,
): number {
  if (!prefersSubscription || marketingSpendPerDay <= 0) return 0
  const lift = 1 + Math.max(0, marketingSpendPerDay) / 550_000
  return Math.log(lift) * 1.4
}

/** Resolve a rival model's list price with the same model-first precedence as the player. */
function rivalModelApiPrice(rival: RivalLab, model: Model): number {
  return modelOfferApiPrice(rival.pricing, model)
}

export function collectOffers(state: SimState): MarketOffer[] {
  const offers: MarketOffer[] = []
  // Buyers price in recent overload (queues / timeouts), not just campus geography
  const pain = state.player.servicePain ?? 0
  const latency = playerServiceLatencyScore(state)
  const playerModels = state.player.models.filter(isPublic)
  const publicIds = new Set(playerModels.map((model) => model.id))
  const fallbackApiId =
    state.player.pricing.activeModelId && publicIds.has(state.player.pricing.activeModelId)
      ? state.player.pricing.activeModelId
      : [...playerModels].sort((a, b) => b.capability - a.capability)[0]?.id
  const apiIds = new Set(
    (state.player.pricing.apiModelIds ?? (fallbackApiId ? [fallbackApiId] : []))
      .filter((id) => publicIds.has(id)),
  )
  const subscriptionIds = new Set(
    state.player.pricing.plans
      .filter((plan) => plan.enabled)
      .flatMap((plan) => plan.modelIds)
      .filter((id) => publicIds.has(id)),
  )
  if (subscriptionIds.size === 0 && fallbackApiId) subscriptionIds.add(fallbackApiId)

  for (const playerModel of playerModels) {
    const apiListed = apiIds.has(playerModel.id)
    const subscriptionListed = subscriptionIds.has(playerModel.id)
    if (!apiListed && !subscriptionListed) continue
    const apiPrecision = state.player.pricing.apiServePrecisionByModel?.[playerModel.id]
    const apiModel = modelForServePrecision(
      playerModel,
      apiPrecision,
      state.player.researchUnlocked,
    )
    // Interactive speed is single-request latency. More racks increase fleet
    // throughput, not this number.
    const tokPerSec =
      (playerModel.serviceProfile?.interactiveTokPerSec ??
        Math.max(2, 52 * playerModel.tokPerSecMult * state.player.servingEfficiency)) *
      Math.max(0.25, 1 - pain * 0.55)
    // Chronic overload tanks perceived reliability (timeouts, 5xx)
    const reliability = perceivedServiceReliability(
      playerModel.quality.reliability,
      pain,
    )
    offers.push({
      labId: 'player',
      modelId: playerModel.id,
      capability: playerModel.capability,
      reliability,
      safety: playerModel.quality.safety,
      brandTrust: state.player.brandTrust,
      apiPrice: modelApiPrice(state, playerModel.id),
      subPrice: headlineSubPrice(state),
      latencyScore: latency,
      tokPerSec,
      modalities: playerModel.modalities,
      isOpenWeights: false,
      benchmarks: playerModel.benchmarks,
      apiCapability: apiModel.capability,
      apiReliability: perceivedServiceReliability(apiModel.quality.reliability, pain),
      apiTokPerSec: tokPerSec,
      apiBenchmarks: apiModel.benchmarks,
      generationOnly: isGenerationOnlyModel(playerModel),
      apiListed,
      subscriptionListed,
    })
  }

  for (const r of state.rivals) {
    const publicModels = r.models.filter(isPublic)
    for (const m of publicModels) {
      const rivalPain = r.servicePain ?? 0
      const region = state.map.regions.find((reg) => reg.id === r.regionId)
      const lat = region ? (1 - region.latencyToMarket) * 100 : 60
      const rivalTok =
        (m.serviceProfile?.interactiveTokPerSec ??
          Math.max(2, 52 * m.tokPerSecMult * r.servingEfficiency)) *
        Math.max(0.25, 1 - rivalPain * 0.55)
      offers.push({
        labId: r.id,
        modelId: m.id,
        capability: m.capability,
        reliability: perceivedServiceReliability(m.quality.reliability, rivalPain),
        safety: m.quality.safety,
        brandTrust: r.brandTrust,
        apiPrice: rivalModelApiPrice(r, m),
        subPrice: r.pricing.subPlusPrice,
        latencyScore: r.archetype === 'hyperscale' ? Math.max(lat, 80) : lat,
        tokPerSec: rivalTok,
        modalities: m.modalities,
        isOpenWeights: m.openWeights ?? r.archetype === 'open_weights',
        benchmarks: m.benchmarks ?? emptyBenchmarks(),
        generationOnly: isGenerationOnlyModel(m),
        apiListed: true,
        subscriptionListed: true,
      })
    }
  }

  return offers
}

/** Nested choice: first choose a lab, then a model inside that lab. */
export function nestedOfferShares(
  offers: MarketOffer[],
  utilities: number[],
  temperature: number,
  outsideUtility?: number,
): number[] {
  if (offers.length === 0) return []
  const byLab = new Map<string, number[]>()
  for (let i = 0; i < offers.length; i++) {
    const indexes = byLab.get(offers[i]!.labId)
    if (indexes) indexes.push(i)
    else byLab.set(offers[i]!.labId, [i])
  }
  const labs = [...byLab.keys()]
  const labUtilities = labs.map((labId) => {
    const indexes = byLab.get(labId)!
    const values = indexes.map((index) => utilities[index]!)
    const best = Math.max(...values)
    // Portfolio breadth is useful, but duplicate models cannot multiply share.
    const breadth = Math.min(1.5, Math.log1p(Math.max(0, indexes.length - 1)) * 0.65)
    return best + breadth
  })
  const labShares = softmaxShares(
    outsideUtility == null ? labUtilities : [...labUtilities, outsideUtility],
    temperature,
  ).slice(0, labs.length)
  const result = Array.from({ length: offers.length }, () => 0)
  for (let li = 0; li < labs.length; li++) {
    const indexes = byLab.get(labs[li]!)!
    const within = softmaxShares(
      indexes.map((index) => utilities[index]!),
      Math.max(0.8, temperature * 0.85),
    )
    for (let wi = 0; wi < indexes.length; wi++) {
      result[indexes[wi]!] = labShares[li]! * within[wi]!
    }
  }
  return result
}

/** EMA of capacity overload — rises when demand > inference, fades when healthy. */
export function nextServicePain(prevPain: number, unservedRatio: number): number {
  const p = Math.max(0, Math.min(1, prevPain))
  const u = Math.max(0, Math.min(1, unservedRatio))
  if (u > 0.05) {
    // Spike when truly overloaded (not float dust)
    return Math.min(1, p * 0.8 + u * 0.38 + (u > 0.4 ? 0.05 : 0))
  }
  // Heal fast when capacity covers demand — no lingering complaints at headroom
  return Math.max(0, p * 0.65 - 0.05)
}

export interface OfferDemandBucket {
  offer: MarketOffer
  model: Model
  apiMTok: number
  subscriptionMTok: number
  subscriptionUsers: number
}

export interface RivalOfferSettlement {
  demandMTok: number
  demandPf: number
  capacityServedMTok: number
  apiServedMTok: number
  subscriptionServedMTok: number
  keptSubscriptionUsers: number
  apiRevenue: number
  subscriptionRevenue: number
  serveFrac: number
  unservedRatio: number
}

/**
 * Settle the exact rival models that won demand. All model workloads share one
 * PF pool, so larger/less-efficient winners consume proportionally more of it.
 */
export function settleRivalOfferDemand(
  buckets: readonly OfferDemandBucket[],
  capacityPf: number,
  servingEfficiency: number,
  priorServicePain = 0,
): RivalOfferSettlement {
  const demandMTok = buckets.reduce(
    (sum, bucket) => sum + bucket.apiMTok + bucket.subscriptionMTok,
    0,
  )
  const demandPf = buckets.reduce(
    (sum, bucket) =>
      sum +
      inferencePfDemand(
        bucket.apiMTok + bucket.subscriptionMTok,
        bucket.model,
        servingEfficiency,
      ),
    0,
  )
  const workItems = buckets.flatMap((bucket, index) => {
    const apiWork = inferencePfDemand(bucket.apiMTok, bucket.model, servingEfficiency)
    const subscriptionWork = inferencePfDemand(
      bucket.subscriptionMTok,
      bucket.model,
      servingEfficiency,
    )
    return [
      ...(bucket.apiMTok > 0
        ? [{
            id: `api:${index}`,
            channel: 'api',
            requestedUnits: bucket.apiMTok,
            requestedWorkPfDays: apiWork,
            priority: 70,
          }]
        : []),
      ...(bucket.subscriptionMTok > 0
        ? [{
            id: `subscription:${index}`,
            channel: 'subscription',
            requestedUnits: bucket.subscriptionMTok,
            requestedWorkPfDays: subscriptionWork,
            priority: 60,
          }]
        : []),
    ]
  })
  const ledger = settleComputeLedger(workItems, {
    capacityPfDays: Math.max(0, capacityPf),
    reservations: { api: 0.68, subscription: 0.32 },
  })
  const serveFrac =
    ledger.requestedUnits > 1e-9 ? ledger.servedUnits / ledger.requestedUnits : 1
  const unservedRatio = ledger.unservedRatio
  const pain = Math.max(0, Math.min(1, priorServicePain))
  const baseChurn =
    unservedRatio <= 0.03
      ? pain * 0.04
      : Math.min(
          0.55,
          unservedRatio * 0.22 +
            pain * 0.28 +
            (unservedRatio > 0.5 ? 0.08 : 0),
        )
  const subChurn = Math.min(0.62, baseChurn * 0.9 + (1 - serveFrac) * 0.38)
  const subKeep = Math.max(0.08, 1 - subChurn * 1.05)

  let apiServedMTok = 0
  let subscriptionServedMTok = 0
  let keptSubscriptionUsers = 0
  let apiRevenue = 0
  let subscriptionRevenue = 0
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index]!
    const apiRow = ledger.rows.find((row) => row.id === `api:${index}`)
    const subscriptionRow = ledger.rows.find((row) => row.id === `subscription:${index}`)
    const apiServed = apiRow?.servedUnits ?? 0
    const subServed = subscriptionRow?.servedUnits ?? 0
    // Same addressable-seat conversion used by the player's plan funnel.
    const subDelivery = bucket.subscriptionMTok > 1e-9
      ? subServed / bucket.subscriptionMTok
      : 1
    const keptSeats = bucket.subscriptionUsers * 0.00075 * subKeep
    apiServedMTok += apiServed
    subscriptionServedMTok += subServed
    keptSubscriptionUsers += keptSeats
    apiRevenue += apiServed * Math.max(0, bucket.offer.apiPrice)
    subscriptionRevenue +=
      (keptSeats * Math.max(0, bucket.offer.subPrice) * (0.5 + 0.5 * subDelivery)) /
      ECONOMY.daysPerMonth
  }

  return {
    demandMTok,
    demandPf,
    capacityServedMTok: apiServedMTok + subscriptionServedMTok,
    apiServedMTok,
    subscriptionServedMTok,
    keptSubscriptionUsers,
    apiRevenue,
    subscriptionRevenue,
    serveFrac,
    unservedRatio,
  }
}

import { labInferCapacityWorkPf } from './labCompute'

/** Rival inference capacity — same abstractPools math as train/research (+ leases). */
export function rivalInferCapacityPf(
  r: RivalLab | {
    flopsPf: number
    utilCap: number
    servingEfficiency: number
    allocation: { training: number; inference: number; research: number }
    data?: { dataGenResearchShare?: number }
    id?: string
  },
  state?: SimState,
  resolvedPhysical?: ReturnType<typeof computeLabSnapshot>,
): number {
  if (state && r.id) {
    const physical =
      resolvedPhysical ?? computeLabSnapshot(state, r.id)
    const engineers = Math.max(0, (r as RivalLab).staff?.engineer ?? 0)
    return labInferCapacityWorkPf({
      flopsPf: physical.rawFlopsPf,
      hardwareTokPerSec: physical.hardwareTokPerSec,
      utilCap: r.utilCap,
      allocation: r.allocation,
      servingEfficiency: r.servingEfficiency,
      dataGenResearchShare: r.data?.dataGenResearchShare,
      engineerServeBonus: Math.min(0.2, engineers * 0.015),
    })
  }
  return labInferCapacityWorkPf({
    flopsPf: r.flopsPf,
    utilCap: r.utilCap,
    allocation: r.allocation,
    servingEfficiency: r.servingEfficiency,
    dataGenResearchShare: r.data?.dataGenResearchShare,
  })
}

export function tickMarket(state: SimState): SimState {
  const offers = collectOffers(state)
  const snap = computeSnapshot(state)
  const campusLatency = playerLatencyScore(state)
  const activeModel = bestPlayerModel(state)
  const serveEff = state.player.servingEfficiency
  const alloc = normalizeAllocation(state.player.allocation)
  // Token-based Cap (racks × model × serve share × derates) — single source of truth
  const capacityMTok = activeModel
    ? inferenceCapacityMTok(snap, activeModel, serveEff, alloc.inference)
    : 0
  // PF pool kept for tooltips / legacy fields
  const capacityPf = inferencePfAvailable(snap)
  const priorPain = state.player.servicePain ?? 0

  const sharesByLab: Record<string, number> = {
    player: 0,
    [OUTSIDE_OPTION_PROVIDER_ID]: 0,
  }
  for (const r of state.rivals) sharesByLab[r.id] = 0

  // Exact offer/model buckets are authoritative for shared-economy settlement.
  const demandByOffer = new Map(
    offers.map((offer) => [
      marketOfferKey(offer.labId, offer.modelId),
      {
        offer,
        apiMTok: 0,
        subscriptionMTok: 0,
        subscriptionUsers: 0,
      },
    ]),
  )

  let playerApiUsers = 0
  let playerApiMTok = 0
  let playerSubUsers = 0
  /** Hobby + light freemium well for plan funnel */
  let playerHobbyUsers = 0
  let playerIndieUsers = 0
  let totalDemandMTok = 0
  let enterpriseWeight = 0

  const segBoost = (id: SegmentId) =>
    state.activeEvents.reduce((m, e) => m * (e.effects.segmentBoost?.[id] ?? 1), 1)

  const generalOffers = offers.filter((offer) => offer.generationOnly !== true)
  const frontier = generalOffers.reduce((m, o) => Math.max(m, o.capability), 20)

  // Bounded diffusion replaces exponential daily growth. Capability and
  // affordability determine where 2036 lands inside the 4–12× range.
  const horizonDays = Math.max(
    365,
    (state.config.campaignRules.reportYear - state.config.campaignRules.startYear + 1) * 365.25,
  )
  const progress = Math.max(0, Math.min(1, (state.day - 1) / horizonDays))
  const capabilityAdoption = Math.max(0, Math.min(1, (frontier - 20) / 65))
  const marketPrice = generalOffers.length > 0
    ? Math.min(...generalOffers.map((offer) => Math.min(offer.apiPrice, offer.subPrice / 15)))
    : 100
  const affordability = 1 / (1 + Math.max(0.01, marketPrice) / 4)
  const adoptionMin = state.industryDataPack.demand.reportYearMinMultiplier
  const adoptionMax = Math.max(
    adoptionMin,
    state.industryDataPack.demand.reportYearMaxMultiplier,
  )
  const endMultiple = Math.max(
    adoptionMin,
    Math.min(
      adoptionMax,
      adoptionMin +
        (adoptionMax - adoptionMin) *
          (capabilityAdoption * 0.625 + affordability * 0.375),
    ),
  )
  const diffusion =
    progress <= 0
      ? 0
      : (1 - Math.exp(-3 * progress)) / (1 - Math.exp(-3))
  const adoptionMultiple = 1 + (endMultiple - 1) * diffusion
  const audienceCandidates = state.segments.map((seg) => {
    const base = SEGMENTS.find((s) => s.id === seg.id)?.baseSize ?? seg.size
    const next = Math.min(base * adoptionMax, Math.max(seg.size, base * adoptionMultiple))
    return { ...seg, size: next }
  })
  const candidateAudience = audienceCandidates.reduce((sum, segment) => sum + segment.size, 0)
  const audienceScale = candidateAudience > WORLD_POPULATION
    ? WORLD_POPULATION / candidateAudience
    : 1
  const grownSegments = audienceCandidates.map((segment) => ({
    ...segment,
    size: segment.size * audienceScale,
  }))
  const switchingBySegment = new Map(
    deriveDemandSegments(state).map((segment) => [segment.id, segment.switchingFriction]),
  )
  const nextProviderSharesBySegment = new Map<SegmentId, Record<string, number>>()

  const growth = 1 + frontier * ECONOMY.marketGrowthPerCapability
  const apiBase = ECONOMY.apiBaseMTokPerUserDay
  // Prior overload softens freeload / sticky traffic before we recompute pain
  const painDemandDamp = Math.max(0.35, 1 - priorPain * 0.55)
  const metroDemand = cityPopulationDemandMultiplier(state)

  for (const segState of grownSegments) {
    const segDef = SEGMENTS.find((s) => s.id === segState.id)!
    const segmentOffers = offers.filter((offer) =>
      marketOfferCanCompeteForSegment(offer, segState.id, segDef.prefersSub),
    )
    if (segmentOffers.length === 0) {
      nextProviderSharesBySegment.set(segState.id, {
        [OUTSIDE_OPTION_PROVIDER_ID]: 1,
      })
      continue
    }
    const effectiveOffer = (offer: MarketOffer) =>
      segDef.prefersSub
        ? offer
        : {
            ...offer,
            capability: offer.apiCapability ?? offer.capability,
            reliability: offer.apiReliability ?? offer.reliability,
            tokPerSec: offer.apiTokPerSec ?? offer.tokPerSec,
            benchmarks: offer.apiBenchmarks ?? offer.benchmarks,
          }
    const segmentFrontier = segmentOffers.reduce(
      (highest, offer) => Math.max(highest, effectiveOffer(offer).capability),
      20,
    )

    // Frontier-relative utilities: SOTA leads; mid-pack still gets real share.
    // Paid acquisition is available to every lab on subscription segments.
    const utils = segmentOffers.map((o) => {
      const scoredOffer = effectiveOffer(o)
      let u = offerUtility(scoredOffer, segState.id, { frontier: segmentFrontier })
      const pricingStatus = analyzeApiPricing({
        price: segDef.prefersSub ? o.subPrice : o.apiPrice,
        marginalCost: 0,
        capability: scoredOffer.capability,
        featureScore: scoredOffer.modalities.length * 18,
        tokPerSec: scoredOffer.tokPerSec,
        peers: segmentOffers
          .filter((peer) => peer.labId !== o.labId)
          .map((peer) => {
            const scoredPeer = effectiveOffer(peer)
            return {
              price: segDef.prefersSub ? peer.subPrice : peer.apiPrice,
              capability: scoredPeer.capability,
              featureScore: scoredPeer.modalities.length * 18,
              tokPerSec: scoredPeer.tokPerSec,
            }
          }),
      })
      if (pricingStatus.primary === 'demand_collapse') u -= 10
      else if (pricingStatus.primary === 'expensive') u -= 3.5
      else if (pricingStatus.primary === 'undercutting') u += 1
      const marketingSpend =
        o.labId === state.playerLabId
          ? marketingReach(state).demandEquivalentSpend
          : state.rivals.find((rival) => rival.id === o.labId)?.marketingSpendPerDay ?? 0
      u += marketingUtilityBonus(marketingSpend, segDef.prefersSub)
      return u
    })
    const outsideUtility = Math.max(
      -1,
      Math.min(5, 2.4 + (segDef.qualityFloor - frontier) * 0.035),
    )
    const targetOfferShares = nestedOfferShares(
      segmentOffers,
      utils,
      segmentSoftmaxTemp(segState.id),
      outsideUtility,
    )
    const targetProviderShares: Record<string, number> = {
      [OUTSIDE_OPTION_PROVIDER_ID]: Math.max(
        0,
        1 - targetOfferShares.reduce((sum, share) => sum + share, 0),
      ),
    }
    for (let i = 0; i < segmentOffers.length; i++) {
      const providerId = segmentOffers[i]!.labId
      targetProviderShares[providerId] =
        (targetProviderShares[providerId] ?? 0) + targetOfferShares[i]!
    }
    const providerShares = settleSegmentProviderShares(
      segState.providerShares,
      targetProviderShares,
      switchingBySegment.get(segState.id) ?? 0,
    )
    nextProviderSharesBySegment.set(segState.id, providerShares)

    // Provider choice changes with inertia; model choice within the selected
    // provider remains responsive. This preserves portfolio choice without
    // letting a lab reset switching friction by launching another model.
    const shares = targetOfferShares.map((targetShare, index) => {
      const providerId = segmentOffers[index]!.labId
      const targetProviderShare = targetProviderShares[providerId] ?? 0
      if (targetProviderShare <= 1e-12) return 0
      return (providerShares[providerId] ?? 0) * (targetShare / targetProviderShare)
    })
    const boost = segBoost(segState.id)
    const segSize = segState.size * growth * boost * metroDemand
    const usage = segState.usageIntensity

    sharesByLab[OUTSIDE_OPTION_PROVIDER_ID] =
      (sharesByLab[OUTSIDE_OPTION_PROVIDER_ID] ?? 0) +
      (providerShares[OUTSIDE_OPTION_PROVIDER_ID] ?? 0) * (segSize / 1e6)

    for (let i = 0; i < segmentOffers.length; i++) {
      const offer = segmentOffers[i]!
      const servedOffer = effectiveOffer(offer)
      const share = shares[i]!
      sharesByLab[offer.labId] = (sharesByLab[offer.labId] ?? 0) + share * (segSize / 1e6)

      const users = segSize * share
      const sota = sotaProximity(servedOffer.capability, segmentFrontier)
      // Demand = users × base × segment intensity × SOTA engagement
      let mtok =
        users *
        apiBase *
        usage *
        ECONOMY.marketDailyActiveUsageShare *
        sotaUsageMultiplier(sota, segState.id)

      const bench = segmentBenchmarkFit(servedOffer.benchmarks, segDef.benchmarkWeights)
      const qualityDamp = Math.min(
        1,
        (servedOffer.capability + servedOffer.reliability + bench) / 180,
      )
      mtok *= 0.55 + qualityDamp * 0.55

      // Free/hobby traffic backs off when the cluster has been on fire
      const offerPain =
        offer.labId === state.playerLabId
          ? priorPain
          : state.rivals.find((rival) => rival.id === offer.labId)?.servicePain ?? 0
      if (!segDef.prefersSub && offerPain > 0.08) {
        mtok *= Math.max(0.35, 1 - offerPain * 0.55)
      }
      if (!segDef.prefersSub) {
        const pricePressure = Math.max(
          0,
          Math.min(1, (Math.log10(Math.max(0, offer.apiPrice) + 1) - 0.6) / 1.8),
        )
        const sensitivity =
          segState.id === 'hobby' || segState.id === 'indie_api'
            ? 1.15
            : segState.id === 'startup_api'
              ? 0.9
              : 0.45
        mtok *= Math.max(0.12, 1 - pricePressure * sensitivity)
      }

      totalDemandMTok += mtok
      const wonDemand = demandByOffer.get(marketOfferKey(offer.labId, offer.modelId))
      if (wonDemand) {
        if (segDef.prefersSub) {
          wonDemand.subscriptionMTok += mtok
          wonDemand.subscriptionUsers += users
        } else {
          wonDemand.apiMTok += mtok
        }
      }

      if (offer.labId === 'player') {
        if (segDef.prefersSub) {
          playerSubUsers += users
        } else {
          // API product segments (indie/startup/creative/hobby)
          playerApiUsers += users
          playerApiMTok += mtok
          if (segState.id === 'hobby') playerHobbyUsers += users
          if (segState.id === 'indie_api') playerIndieUsers += users
        }
        if (
          segState.id === 'enterprise' ||
          segState.id === 'legal' ||
          segState.id === 'healthcare'
        ) {
          enterpriseWeight += users * share
        }
      }
    }
  }

  // Re-normalize weighted shares after marketing bias. The outside option is
  // retained, making player + rivals + manual/local/no-adoption conserve to 1.
  const shareSum = Object.values(sharesByLab).reduce((a, b) => a + b, 0) || 1
  for (const k of Object.keys(sharesByLab)) {
    sharesByLab[k] = (sharesByLab[k] ?? 0) / shareSum
  }

  // --- Split subscribers across custom plans ---
  const enabledPlans = state.player.pricing.plans.filter((p) => p.enabled)
  const freePlanOn = enabledPlans.some((p) => isFreePlan(p))
  // Freemium funnel: modest share of hobby → seats (most hobby stays API demand)
  // Closing free pushes more hobby into paid seats without starving API.
  const freemiumPool = freePlanOn
    ? playerHobbyUsers * 0.28 + playerIndieUsers * 0.06
    : playerHobbyUsers * 0.38 + playerIndieUsers * 0.14

  // Natural sub segments + freemium funnel into plan seat demand
  // Segment sizes are total category audience; only a small fraction converts
  // into an active paid/free seat in one lab's current acquisition window.
  const planAddressable = (playerSubUsers + freemiumPool) * 0.00075

  const planUtils = enabledPlans.map((p) => {
    let u = planAttractiveness(state, p)
    if (!isFreePlan(p) && !freePlanOn) u += 18 // paid more attractive when free closed
    if (!isFreePlan(p) && freePlanOn) u += 6 // free users still convert up
    if (isFreePlan(p) && freePlanOn) u += freeTierDemandProfile(p).utilityBonus
    return u
  })
  const planShares =
    enabledPlans.length > 0 ? softmaxShares(planUtils, 1.05) : ([] as number[])

  const frontierCap = Math.max(
    activeModel?.capability ?? 40,
    ...state.rivals.flatMap((r) => r.models.filter((m) => m.shipped).map((m) => m.capability)),
    40,
  )

  type PlanBucket = {
    plan: SubPlan
    subscribers: number
    maxSeats: number
    rawMTok: number
    usageRate: number
    model: ReturnType<typeof bestModelOnPlan>
    modelMix: ReturnType<typeof planModelTrafficMix>
    demandPf: number
    priceTooHigh: number
    allowanceMTokMonth: number
    apiEquivalentValue: number
    subsidyRatio: number
  }
  const playerApiBlend =
    state.player.pricing.apiPriceInPerMTok != null &&
    state.player.pricing.apiPriceOutPerMTok != null
      ? blendApiPrice(
          state.player.pricing.apiPriceInPerMTok,
          state.player.pricing.apiPriceOutPerMTok,
        )
      : state.player.pricing.apiPricePerMTok

  // API/subscription shares are reservations, not hard partitions. The unified
  // ledger backfills either reservation when its channel is quiet.
  const apiPrio = Math.max(
    0.12,
    Math.min(
      0.88,
      state.player.pricing.apiVsSubPriority ?? ECONOMY.defaultApiVsSubPriority ?? 0.68,
    ),
  )
  const subPoolShare = 1 - apiPrio
  const subPoolMTok = capacityMTok * subPoolShare
  const apiPoolPf = capacityPf * apiPrio
  const subPoolPf = capacityPf * subPoolShare

  // Build unconstrained plan demand first, then scale seats into sub PF pool
  const freeIdx = enabledPlans.findIndex((p) => isFreePlan(p))
  const freeDemandProfile = freeIdx >= 0
    ? freeTierDemandProfile(enabledPlans[freeIdx]!)
    : null
  const freeMassBase =
    freeIdx >= 0
      ? Math.max(
          planAddressable *
            (planShares[freeIdx] ?? 0) *
            (freeDemandProfile?.audienceMultiplier ?? 1),
          planAddressable * (freeDemandProfile?.minimumAudienceShare ?? 0),
        )
      : 0
  const paidShareSum = enabledPlans.reduce(
    (s, p, j) => (!isFreePlan(p) ? s + (planShares[j] ?? 0) : s),
    0,
  )

  const rawBuckets = enabledPlans.map((plan, i) => {
    let subscribers = planAddressable * (planShares[i] ?? 0)
    // Free→paid upgrade: paid plans convert a share of free-tier demand
    if (!isFreePlan(plan) && freePlanOn && freeMassBase > 0) {
      const myPaidFrac = paidShareSum > 1e-6 ? (planShares[i] ?? 0) / paidShareSum : 0
      subscribers += freeMassBase * 0.28 * myPaidFrac
    }
    // Free tier shrinks a bit as people upgrade
    if (isFreePlan(plan) && freePlanOn) {
      const profile = freeTierDemandProfile(plan)
      subscribers = Math.max(
        subscribers * 0.78 * profile.audienceMultiplier,
        planAddressable * profile.minimumAudienceShare,
      )
    }

    const modelMix = planModelTrafficMix(state, plan)
    const planModel = [...modelMix]
      .sort((a, b) => b.model.capability - a.model.capability)[0]?.model ?? null
    const cap = planModel?.capability ?? activeModel?.capability ?? 45
    const autoU = planUsageUtilization(plan, enabledPlans, {
      modelCapability: cap,
      frontierCapability: frontierCap,
    })
    const usageRate = autoU
    const sota = sotaProximity(cap, frontierCap)
    const free = isFreePlan(plan)
    // Capability moves use within the tier's steady-state band. It must never
    // multiply actual consumption beyond the configured entitlement.
    const qualityEngagement = free
      ? 0.7 + Math.pow(sota, 1.35) * 0.3
      : 0.85 + Math.pow(sota, 1.35) * 0.15
    const priceTooHigh = planPriceTooHighScore(plan, {
      apiPricePerMTok: playerApiBlend,
      modelCapability: cap,
      frontierCapability: frontierCap,
      utilization: usageRate,
    })
    // Softer price rejection — gouging still hurts, fair Plus/Pro still sell
    subscribers *= Math.max(0.08, Math.pow(Math.max(0.05, 1 - priceTooHigh), 1.55))
    // Closing free: paid take-rate bonus (conversion funnel)
    if (!free && !freePlanOn) subscribers *= 1.35
    const dailyAllowance = planAllowanceMTokPerMonth(plan) / ECONOMY.daysPerMonth
    let perUser = Math.min(
      dailyAllowance,
      planActualMTokPerUser(plan, ECONOMY.basePlanUsageMTokPerDay, usageRate) *
        qualityEngagement *
        planDemandShockMultiplier(plan, state.day),
    )
    if (free && priorPain > 0.08) perUser *= painDemandDamp
    const rawMTok = subscribers * perUser
    const demandPf = modelMix.reduce(
      (sum, item) => sum + inferencePfDemand(rawMTok * item.share, item.model, serveEff),
      0,
    )
    const planMax = maxSeatsForPlan(
      plan,
      planModel,
      subPoolMTok,
      serveEff,
      usageRate,
      {
        modelCapability: cap,
        frontierCapability: frontierCap,
        subPoolShare: 1,
        capacityIsMTok: true,
      },
    )
    return {
      plan,
      subscribers,
      planMax,
      rawMTok,
      usageRate,
      model: planModel,
      modelMix,
      demandPf,
      priceTooHigh,
      perUser,
      cap,
    }
  })

  // Free remains the widest funnel at every allowance band. Generous free
  // tiers lead by more; even a constrained free tier still beats any paid SKU.
  if (freeIdx >= 0 && rawBuckets[freeIdx]) {
    const largestPaid = rawBuckets.reduce(
      (largest, bucket) => isFreePlan(bucket.plan) ? largest : Math.max(largest, bucket.subscribers),
      0,
    )
    const profile = freeTierDemandProfile(rawBuckets[freeIdx]!.plan)
    rawBuckets[freeIdx]!.subscribers = Math.max(
      rawBuckets[freeIdx]!.subscribers,
      largestPaid * profile.paidPopularityLead,
    )
  }

  const buckets: PlanBucket[] = rawBuckets.map((b) => {
    // Demand is calculated before capacity. Shortage is visible as unserved
    // demand and only then feeds churn; it is never silently clipped here.
    const subscribers = b.subscribers
    const rawMTok = subscribers * b.perUser
    const demandPf = b.modelMix.reduce(
      (sum, item) => sum + inferencePfDemand(rawMTok * item.share, item.model, serveEff),
      0,
    )
    const allowanceMTokMonth = planAllowanceMTokPerMonth(b.plan)
    const apiEquivalentValue = planApiEquivalentValue(b.plan, playerApiBlend, b.usageRate)
    const subsidyRatio = planSubsidyRatio(b.plan, playerApiBlend, b.usageRate)
    return {
      plan: b.plan,
      subscribers,
      maxSeats: b.planMax,
      rawMTok,
      usageRate: b.usageRate,
      model: b.model,
      modelMix: b.modelMix,
      demandPf,
      priceTooHigh: b.priceTooHigh,
      allowanceMTokMonth,
      apiEquivalentValue,
      subsidyRatio,
    }
  })

  const playerApiBuckets = [...demandByOffer.values()].flatMap((demand) => {
    if (demand.offer.labId !== 'player' || demand.apiMTok <= 0) return []
    const model = state.player.models.find((candidate) => candidate.id === demand.offer.modelId)
    if (!model) return []
    const precision = state.player.pricing.apiServePrecisionByModel?.[model.id]
    const serveModel = modelForServePrecision(
      model,
      precision,
      state.player.researchUnlocked,
    )
    return [{ model, serveModel, precision, demandMTok: demand.apiMTok }]
  })
  const planDemandMTok = buckets.reduce((s, b) => s + b.rawMTok, 0)
  const apiDemandPf = playerApiBuckets.reduce(
    (sum, bucket) => sum + inferencePfDemand(bucket.demandMTok, bucket.serveModel, serveEff),
    0,
  )
  const planDemandPf = buckets.reduce((sum, bucket) => sum + bucket.demandPf, 0)
  const demandPf = apiDemandPf + planDemandPf
  const playerDemandMTok = playerApiMTok + planDemandMTok

  const computeLedger = settleComputeLedger(
    [
      ...playerApiBuckets.map((bucket, index) => ({
        id: `api:${index}`,
        channel: 'api',
        requestedUnits: bucket.demandMTok,
        requestedWorkPfDays: inferencePfDemand(
          bucket.demandMTok,
          bucket.serveModel,
          serveEff,
        ),
        priority: 70,
      })),
      ...buckets.map((bucket) => ({
        id: `plan:${bucket.plan.id}`,
        channel: 'subscription',
        requestedUnits: bucket.rawMTok,
        requestedWorkPfDays: bucket.demandPf,
        priority: planComputePriority(bucket.plan),
      })),
    ],
    {
      capacityPfDays: capacityPf,
      reservations: { api: apiPrio, subscription: 1 - apiPrio },
    },
  )
  const apiRows = computeLedger.rows.filter((row) => row.channel === 'api')
  const planServeFractions = new Map(
    buckets.map((bucket) => [
      bucket.plan.id,
      computeLedger.rows.find((row) => row.id === `plan:${bucket.plan.id}`)?.serveFraction ?? 1,
    ]),
  )
  const apiAdmittedMTok = apiRows.reduce((sum, row) => sum + row.servedUnits, 0)
  const serveFracApi = playerApiMTok > 1e-9 ? apiAdmittedMTok / playerApiMTok : 1
  const subServedDemandMTok = computeLedger.rows
    .filter((row) => row.channel === 'subscription')
    .reduce((sum, row) => sum + row.servedUnits, 0)
  const serveFracSub =
    planDemandMTok > 1e-9 ? Math.max(0, Math.min(1, subServedDemandMTok / planDemandMTok)) : 1
  const unservedRatio = computeLedger.unservedRatio
  const serveFrac =
    playerDemandMTok > 1e-9
      ? (playerApiMTok * serveFracApi + planDemandMTok * serveFracSub) /
        playerDemandMTok
      : 1
  const servedMTok = computeLedger.servedUnits
  const capacitySalesCapped = false

  const servicePain = nextServicePain(priorPain, unservedRatio)
  const effectiveLatencyScore = playerServiceLatencyScore(state, {
    unservedRatio,
    servicePain,
  })
  const baseChurn =
    unservedRatio <= 0.03
      ? servicePain * 0.04
      : Math.min(0.55, unservedRatio * 0.22 + servicePain * 0.28 + (unservedRatio > 0.5 ? 0.08 : 0))
  // Channel-specific churn: starved product loses users faster
  const churnFrac = baseChurn

  // ── Money: revenue = prices only; costs = real ops (not list COGS) ──
  // Pay grid $/MWh only on *imports*; on-site gen is covered by plant opex
  // City power contracts cover firm MW at locked rates; rest is spot
  const power = resolvePlayerPowerMw(state, snap.mwDemand)
  const gridMw = Math.max(0, power.mwGridImport)
  const importBill = powerImportBill(state, gridMw)
  const generationUsedMw = Math.min(snap.mwDemand, power.mwGeneration)
  const energyCostDay =
    importBill.totalCostDay +
    onsiteGenerationUpkeepDay(generationUsedMw, state.map.energyPricePerMWh)
  const buildingOpex = playerBuildingOpex(state)
  // Surplus generation sold to cities / grid (Fleet → Power)
  const powerExportRev = powerExportDayRevenue(state)
  let rackCapital = 0
  for (const r of state.player.rackFleet ?? []) {
    if (r.status === 'live') rackCapital += r.paidEach * r.count
  }
  const chipAmort = rackCapital / ECONOMY.chipAmortDays
  const denomMTok = Math.max(servedMTok, 0.0001)
  const opsServeShare = Math.max(0.08, state.player.allocation.inference)
  const leaseIn = state.player.computeLeaseIncomeToday ?? 0
  const leaseOut = state.player.computeLeaseCostToday ?? 0
  const attributedServeOps = attributedServingFixedCost({
    energyCostDay,
    chipAmortDay: chipAmort,
    buildingOpexDay: buildingOpex,
    computeLeaseCostDay: leaseOut,
    inferenceShare: opsServeShare,
  })
  const marginalPerMTok = attributedServeOps / denomMTok + ECONOMY.bandwidthPerMTok

  const apiModelSettlement = playerApiBuckets.map((bucket, index) => {
    const dayMTok = computeLedger.rows.find((row) => row.id === `api:${index}`)?.servedUnits ?? 0
    const dayInferPf = inferencePfDemand(dayMTok, bucket.serveModel, serveEff)
    const { priceIn, priceOut } = modelApiInOut(state, bucket.model.id)
    return {
      model: bucket.model,
      precision: bucket.precision,
      dayMTok,
      dayInferPf,
      dayRevenue: apiRevenueFromMTok(dayMTok, priceIn, priceOut),
    }
  })
  const apiServed = apiModelSettlement.reduce((sum, item) => sum + item.dayMTok, 0)
  const apiRevenue = apiModelSettlement.reduce((sum, item) => sum + item.dayRevenue, 0)
  const apiInferPf = apiModelSettlement.reduce((sum, item) => sum + item.dayInferPf, 0)

  let blockedSubscriptionSeats = 0
  const rawPlanStats = buckets.map((b) => {
    const free = isFreePlan(b.plan)
    const planServeFrac = planServeFractions.get(b.plan.id) ?? 1
    const planSubChurnFrac = Math.min(
      0.68,
      baseChurn * 0.9 + (1 - planServeFrac) * (free ? 0.48 : 0.4),
    )
    const retainedAfterChurn =
      b.subscribers * Math.max(0.08, 1 - planSubChurnFrac * (free ? 0.75 : 1.05))
    const kept = retainedAfterChurn
    blockedSubscriptionSeats += retainedAfterChurn * (1 - planServeFrac)
    const dayMTok =
      computeLedger.rows.find((row) => row.id === `plan:${b.plan.id}`)?.servedUnits ?? 0
    const modelUsage = b.modelMix.map((item) => {
      const modelMTok = dayMTok * item.share
      const modelPf = inferencePfDemand(modelMTok, item.model, serveEff)
      return {
        modelId: item.model.id,
        name: item.model.name,
        dayMTok: modelMTok,
        dayInferPf: modelPf,
        share: item.share,
        costPerMTok: 0,
      }
    })
    const dayInferPf = modelUsage.reduce((sum, usage) => sum + usage.dayInferPf, 0)
    // Subscription revenue accrues by seat; material outages issue automatic
    // service credits instead of pretending every token is usage-billed.
    const serviceCredit = planServeFrac >= 0.97 ? 1 : 0.5 + 0.5 * planServeFrac
    const dayRevenue = free
      ? 0
      : (kept * b.plan.pricePerMonth * serviceCredit) / ECONOMY.daysPerMonth
    return {
      planId: b.plan.id,
      name: b.plan.name,
      subscribers: kept,
      maxSeats: b.maxSeats,
      dayRevenue,
      dayMTok,
      dayInferPf,
      modelUsage,
      computePriority: planComputePriority(b.plan),
      serveFraction: planServeFrac,
      isFree: free,
      usageRate: b.usageRate,
      allowanceMTokMonth: b.allowanceMTokMonth,
      apiEquivalentValue: b.apiEquivalentValue,
      subsidyRatio: b.subsidyRatio,
      priceTooHigh: b.priceTooHigh,
      allowanceDissatisfaction: planAllowanceExpectation(b.plan).dissatisfaction,
    }
  })

  // Fixed serving operations are scarce-compute costs. Allocate them by actual
  // inference PF, not by raw token count: a plan routing to a larger/slower model
  // must carry more cost even when it serves the same number of tokens.
  const totalAllocatedInferPf =
    apiInferPf + rawPlanStats.reduce((sum, plan) => sum + plan.dayInferPf, 0)
  const fixedCostForPf = (pf: number) =>
    totalAllocatedInferPf > 1e-9
      ? attributedServeOps * Math.max(0, pf) / totalAllocatedInferPf
      : 0
  const apiCogs = fixedCostForPf(apiInferPf) + apiServed * ECONOMY.bandwidthPerMTok
  const apiModelUsage = apiModelSettlement.map((item) => {
    const modelCost =
      fixedCostForPf(item.dayInferPf) + item.dayMTok * ECONOMY.bandwidthPerMTok
    return {
      modelId: item.model.id,
      name: item.model.name,
      dayMTok: item.dayMTok,
      dayInferPf: item.dayInferPf,
      share: apiServed > 1e-9 ? item.dayMTok / apiServed : 0,
      costPerMTok: item.dayMTok > 1e-9 ? modelCost / item.dayMTok : 0,
    }
  })
  const planStats: PlanDayStats[] = rawPlanStats.map((plan) => {
    const allocatedComputeCostDay = fixedCostForPf(plan.dayInferPf)
    const bandwidthCostDay = plan.dayMTok * ECONOMY.bandwidthPerMTok
    const dayCogs = allocatedComputeCostDay + bandwidthCostDay
    const costPerSubDay = plan.subscribers > 0 ? dayCogs / plan.subscribers : 0
    const marginPerSubMonth = plan.isFree
      ? -costPerSubDay * ECONOMY.daysPerMonth
      : plan.subscribers > 0
        ? plan.dayRevenue * ECONOMY.daysPerMonth / plan.subscribers -
          costPerSubDay * ECONOMY.daysPerMonth
        : 0
    const configuredPlan = enabledPlans.find((candidate) => candidate.id === plan.planId)
    const stabilityDissatisfaction = planStabilityDissatisfaction(
      plan.isFree,
      marginPerSubMonth,
      configuredPlan?.pricePerMonth ?? 0,
    )
    const allowanceDissatisfaction = plan.allowanceDissatisfaction ?? 0
    const dissatisfaction = Math.min(
      1,
      1 - (1 - allowanceDissatisfaction) * (1 - stabilityDissatisfaction),
    )
    const modelUsage = plan.modelUsage.map((usage) => {
      const modelCost =
        fixedCostForPf(usage.dayInferPf) + usage.dayMTok * ECONOMY.bandwidthPerMTok
      return {
        ...usage,
        costPerMTok: usage.dayMTok > 1e-9 ? modelCost / usage.dayMTok : 0,
      }
    })
    return {
      ...plan,
      dayCogs,
      allocatedComputeCostDay,
      computePfPerSubscriber:
        plan.subscribers > 0 ? plan.dayInferPf / plan.subscribers : 0,
      modelUsage,
      costPerSubDay,
      marginPerSubMonth,
      allowanceDissatisfaction,
      stabilityDissatisfaction,
      dissatisfaction,
    }
  })

  const subRevenue = planStats.reduce((s, p) => s + p.dayRevenue, 0)
  const subCogs = planStats.reduce((s, p) => s + p.dayCogs, 0)
  const totalSubUsers = planStats.reduce((s, p) => s + p.subscribers, 0)
  const servedPf =
    apiInferPf + planStats.reduce((sum, plan) => sum + plan.dayInferPf, 0)

  const nativeTextUnits = (mtok: number) => ({
    inputMTok: Math.max(0, mtok) * 0.7,
    outputMTok: Math.max(0, mtok) * 0.3,
  })
  const reconciledWorkItems: SimComputeWorkItem[] = computeLedger.rows.map((row) => {
    const apiIndex = row.id.startsWith('api:') ? Number(row.id.slice(4)) : -1
    const planId = row.id.startsWith('plan:') ? row.id.slice(5) : undefined
    const apiSettlement = apiIndex >= 0 ? apiModelSettlement[apiIndex] : undefined
    const apiUsage = apiIndex >= 0 ? apiModelUsage[apiIndex] : undefined
    const planSettlement = planId
      ? planStats.find((plan) => plan.planId === planId)
      : undefined
    const directCogs = apiSettlement
      ? (apiUsage?.costPerMTok ?? 0) * apiSettlement.dayMTok
      : planSettlement?.dayCogs ?? 0
    return {
      id: `${state.day}:${row.id}`,
      labId: state.playerLabId,
      kind: row.channel === 'api' ? 'api_text' : 'subscription_text',
      modelId: apiSettlement?.model.id,
      planId,
      requested: nativeTextUnits(row.requestedUnits),
      admitted: nativeTextUnits(row.admittedUnits),
      served: nativeTextUnits(row.servedUnits),
      billed: nativeTextUnits(row.billedUnits),
      requestedPfDays: row.requestedWorkPfDays,
      servedPfDays: row.servedWorkPfDays,
      revenue: apiSettlement?.dayRevenue ?? planSettlement?.dayRevenue ?? 0,
      directCogs,
      ...(row.admitFraction < 0.999999 ? { rejectedReason: 'capacity' as const } : {}),
    }
  })
  const reconciledComputeLedger: SimComputeLedger = {
    day: state.day,
    labId: state.playerLabId,
    items: reconciledWorkItems,
    requestedPfDays: computeLedger.requestedWorkPfDays,
    admittedPfDays: computeLedger.admittedWorkPfDays,
    servedPfDays: computeLedger.servedWorkPfDays,
    billedPfDays: computeLedger.billedWorkPfDays,
    capacityPfDays: computeLedger.capacityPfDays,
    reservedPfDays: computeLedger.reservedWorkPfDays,
    backfilledPfDays: computeLedger.backfilledWorkPfDays,
  }

  // Enterprise peels off when SLA is bad
  let enterpriseContracts = state.player.enterpriseContracts
  if (servicePain > 0.25 && enterpriseContracts > 0) {
    const lose = servicePain > 0.55 ? 1 : servicePain > 0.4 && state.day % 3 === 0 ? 1 : 0
    enterpriseContracts = Math.max(0, enterpriseContracts - lose)
  }
  // Annuity only (no signing lump in tickOrg) + soft enterprise-segment ARPU
  const softArpu = ECONOMY.enterpriseSoftArpu ?? 0.008
  const enterpriseRevenueBeforeCapacity =
    (enterpriseContracts * ECONOMY.enterpriseContractValue) /
      ECONOMY.daysPerMonth *
      (1 + state.player.pricing.enterpriseContractBonus * 0.12) +
    enterpriseWeight * softArpu * serveFrac * Math.max(0.25, 1 - churnFrac)
  const enterpriseServiceCredit = serveFrac >= 0.97 ? 1 : 0.5 + 0.5 * serveFrac
  const enterpriseRevenue = enterpriseRevenueBeforeCapacity * enterpriseServiceCredit
  const capacityProductRevenueCeiling = apiRevenue + subRevenue + enterpriseRevenue

  // Staff wages (HQ employees) — replaces legacy talent×base wage
  const wage = staffWagePerDay(state)
  const mkt = state.player.marketingSpendPerDay
  // Money in: list prices. Money out: real ops only.
  // Chip amort is book (non-cash) — capex was paid at purchase; do not cash-deduct again.
  const dayRevenue =
    apiRevenue + subRevenue + enterpriseRevenue + powerExportRev + leaseIn
  const productCogs = apiCogs + subCogs // attributed serve ops for margin views
  const dayTotalOut = energyCostDay + wage + mkt + buildingOpex + leaseOut
  const net = dayRevenue - dayTotalOut
  const dayGrossProfit = dayRevenue - productCogs

  const marginPerSubMonthly =
    totalSubUsers > 0
      ? (subRevenue * ECONOMY.daysPerMonth - subCogs * ECONOMY.daysPerMonth) / totalSubUsers
      : 0
  const marginPerMTok = apiServed > 0 ? (apiRevenue - apiCogs) / apiServed : 0

  let brand = state.player.brandTrust
  // Capacity pain only when actually short — no brand death with spare headroom
  if (unservedRatio > 0.08) {
    const hit =
      unservedRatio * 1.5 +
      (unservedRatio > 0.35 ? servicePain * 1.1 : servicePain * 0.35) +
      (unservedRatio > 0.5 ? 0.6 : 0)
    brand = Math.max(8, brand - hit)
  } else if (servicePain > 0.2 && unservedRatio <= 0.05) {
    // Residual pain fades without hard brand slash
    brand = Math.max(8, brand - servicePain * 0.08)
  }
  const model = bestPlayerModel(state)
  if (model && model.quality.reliability < 35) brand = Math.max(8, brand - 0.15)
  if (model && model.capability < 22) brand = Math.max(8, brand - 0.1)
  // Quantized traffic exposes the lower eval profile to real customers. INT8
  // is usually tolerable; sustained INT4 on a material product creates a
  // visible trust cost proportional to that plan's share of served traffic.
  for (const stat of planStats) {
    const plan = enabledPlans.find((candidate) => candidate.id === stat.planId)
    if (!plan || stat.dayMTok <= 0) continue
    const weightedBrandRisk = (stat.modelUsage ?? []).reduce((sum, usage) => {
      const planModel = state.player.models.find((candidate) => candidate.id === usage.modelId)
      if (!planModel) return sum
      const precision = planModelServePrecision(
        plan,
        planModel,
        state.player.researchUnlocked,
      )
      return sum + planServeModifiers(precision, state.player.researchUnlocked).brandRisk * usage.share
    }, 0)
    const brandRisk = stat.modelUsage?.length
      ? weightedBrandRisk
      : planServeModifiers(plan.servePrecision, state.player.researchUnlocked).brandRisk
    const trafficShare = stat.dayMTok / Math.max(0.001, servedMTok)
    if (isFreePlan(plan)) continue
    brand = Math.max(5, brand - brandRisk * Math.min(1, trafficShare * 2.5) * 1.15)
  }
  // API customers pay per token and expect the advertised benchmark profile.
  // Quantized endpoints save PF, but sustained eval loss is visible and erodes
  // trust in proportion to that endpoint's real served traffic.
  for (const settlement of apiModelSettlement) {
    if (settlement.dayMTok <= 0) continue
    const quant = planServeModifiers(
      settlement.precision,
      state.player.researchUnlocked,
    )
    const trafficShare = settlement.dayMTok / Math.max(0.001, servedMTok)
    brand = Math.max(
      5,
      brand - quant.brandRisk * Math.min(1, trafficShare * 2.8) * 1.25,
    )
  }
  // Rebuild trust when capacity covers demand
  if (
    unservedRatio < 0.05 &&
    servicePain < 0.12 &&
    model &&
    model.quality.reliability > 55
  ) {
    brand = Math.min(100, brand + 0.12)
  }
  // Campus polish (office/lab) slowly lifts brand
  if (usesCompactWorld(state)) {
    for (const facility of
      compactCompletedFacilitiesForOwner(state, state.playerLabId) ?? []) {
      if (facility.kind === 'office') brand = Math.min(100, brand + 0.02)
      if (facility.kind === 'lab') brand = Math.min(100, brand + 0.01)
    }
  } else {
    for (const t of facilityAnchorTiles(state, { ownerId: 'player' })) {
      if (t.buildingProgress < t.buildingTarget) continue
      if (t.kind === 'office') brand = Math.min(100, brand + 0.02)
      if (t.kind === 'lab') brand = Math.min(100, brand + 0.01)
    }
  }

  // Stingy plans (low mult vs high price) hurt brand slightly if many free users leave
  for (const b of buckets) {
    if (b.plan.pricePerMonth > 40 && b.plan.usageMultiplier < 1 && b.subscribers > 1000) {
      brand = Math.max(5, brand - 0.02)
    }
  }

  // ── Shared economy: rivals settle the same capacity and operating inputs ──
  let industryServedMTok = servedMTok
  const rivals = state.rivals.map((r) => {
    const offerBuckets: OfferDemandBucket[] = []
    for (const demand of demandByOffer.values()) {
      if (demand.offer.labId !== r.id) continue
      const wonModel = r.models.find((candidate) => candidate.id === demand.offer.modelId)
      if (!wonModel) continue
      offerBuckets.push({ ...demand, model: wonModel })
    }
    const physical = computeLabSnapshot(state, r.id)
    const capPf = rivalInferCapacityPf(r, state, physical)
    const rivalSettlement = settleRivalOfferDemand(
      offerBuckets,
      capPf,
      r.servingEfficiency,
      r.servicePain ?? 0,
    )
    const rServe = rivalSettlement.serveFrac
    const rUnserved = rivalSettlement.unservedRatio
    const servedRival =
      rivalSettlement.apiServedMTok + rivalSettlement.subscriptionServedMTok
    const demPf = rivalSettlement.demandPf
    industryServedMTok += rivalSettlement.capacityServedMTok

    // The model and price that won each demand bucket are authoritative for
    // serving work and billing; no first-model or fixed API/sub approximation.
    // Compute contracts settle cash before this system and expose accruals so
    // finance includes them exactly once without charging cash a second time.
    const apiRevenueRival = rivalSettlement.apiRevenue
    const subRevenueRival = rivalSettlement.subscriptionRevenue
    const productRevenue = apiRevenueRival + subRevenueRival
    const leaseIn = r.computeLeaseIncomeToday ?? 0
    const leaseOut = r.computeLeaseCostToday ?? 0
    const dayRev = productRevenue + leaseIn

    // Identical operating inputs: physical power, staff wages, completed
    // facilities, and explicit marketing. No abstract compute growth or grants.
    // Long-term utility/PPAs are take-or-pay settled after the market. Their
    // covered MW must not also be bought on spot here.
    const rivalGenerationMw = Math.min(
      physical.powerMw,
      labFacilityEnergyTotals(state, r.id).mwGeneration,
    )
    const energyCost =
      physical.spotPowerMw * 24 * state.map.energyPricePerMWh +
      onsiteGenerationUpkeepDay(rivalGenerationMw, state.map.energyPricePerMWh)
    const wageCost = labStaffWagePerDay(state, r.id)
    let buildingCost = 0
    if (state.map.storage === 'compact' && state.map.world) {
      for (const facility of
        compactCompletedFacilitiesForOwner(state, r.id) ?? []) {
        buildingCost += facility.stats?.opexPerDay ?? 0
      }
    } else {
      buildingCost = facilityAnchorTiles(state, { ownerId: r.id }).reduce(
        (sum, facility) =>
          sum +
          (facility.buildingProgress >= facility.buildingTarget ? facility.opexPerDay : 0),
        0,
      )
    }
    buildingCost *= ECONOMY.facilityOpexMultiplier ?? 1
    const operatingOpex = energyCost + wageCost + buildingCost + (r.marketingSpendPerDay ?? 0)
    const dayOpex = operatingOpex + leaseOut
    const rackCapital = (r.rackFleet ?? []).reduce(
      (sum, rack) =>
        sum + (rack.status === 'live' ? rack.paidEach * rack.count : 0),
      0,
    )
    const chipAmort = rackCapital / ECONOMY.chipAmortDays
    const attributedServeOps = attributedServingFixedCost({
      energyCostDay: energyCost,
      chipAmortDay: chipAmort,
      buildingOpexDay: buildingCost,
      computeLeaseCostDay: leaseOut,
      inferenceShare: Math.max(0.08, r.allocation.inference),
    })
    const rivalProductCogs =
      attributedServeOps +
      servedRival * ECONOMY.bandwidthPerMTok
    const rivalApiCogs =
      servedRival > 0
        ? rivalProductCogs * (rivalSettlement.apiServedMTok / servedRival)
        : 0
    const rivalSubCogs = rivalProductCogs - rivalApiCogs
    const rivalGrossProfit = dayRev - rivalProductCogs
    const operatingNet = productRevenue - operatingOpex
    const rivalNet = operatingNet + leaseIn - leaseOut
    // Contract cash already moved in tickComputeContracts. Only product and
    // operating settlement remains to be applied here.
    const cash = r.cash + operatingNet
    const previousFinance = getLab(state, r.id).finance
    const valuation = Math.max(
      1,
      cash * 1.2 +
        Math.max(0, previousFinance.lifetimeRevenue + dayRev) * 4.5 +
        Math.max(0, rivalGrossProfit) * 120,
    )
    const finance = {
      ...previousFinance,
      cash,
      dayRevenue: dayRev,
      dayCogs: rivalProductCogs,
      dayEnergyCost: energyCost,
      dayWageCost: wageCost,
      dayChipAmort: chipAmort,
      dayBuildingOpex: buildingCost,
      dayMarketing: r.marketingSpendPerDay ?? 0,
      dayEnergyOther: energyCost * Math.max(0, 1 - r.allocation.inference),
      dayChipAmortOther:
        chipAmort * Math.max(0, 1 - r.allocation.inference),
      apiRevenue: apiRevenueRival,
      subRevenue: subRevenueRival,
      enterpriseRevenue: 0,
      apiCogs: rivalApiCogs,
      subCogs: rivalSubCogs,
      dayGrossProfit: rivalGrossProfit,
      dayNet: rivalNet,
      dayTotalOut: dayOpex,
      marginPerSub:
        rivalSettlement.keptSubscriptionUsers > 0
          ? ((subRevenueRival - rivalSubCogs) * ECONOMY.daysPerMonth) /
            rivalSettlement.keptSubscriptionUsers
          : 0,
      marginPerMTok:
        rivalSettlement.apiServedMTok > 0
          ? (apiRevenueRival - rivalApiCogs) / rivalSettlement.apiServedMTok
          : 0,
      totalShare: sharesByLab[r.id] ?? 0,
      valuation,
      lifetimeRevenue: previousFinance.lifetimeRevenue + dayRev,
      lifetimeNet: previousFinance.lifetimeNet + rivalNet,
      lifetimeProductCogs: previousFinance.lifetimeProductCogs + rivalProductCogs,
      peakCash: Math.max(previousFinance.peakCash, cash),
      lowestCash: Math.min(previousFinance.lowestCash, cash),
      runwayDays: rivalNet >= 0 ? Number.POSITIVE_INFINITY : cash / Math.max(1, -rivalNet),
      debtOutstanding:
        (r.loans ?? []).reduce((sum, loan) => sum + loan.remaining, 0) +
        (r.capital?.debt ?? []).reduce((sum, debt) => sum + debt.remaining, 0),
    }

    // Brand / pain from overload (same economy as player)
    let brandTrust = r.brandTrust
    let pain = r.servicePain ?? 0
    pain = nextServicePain(pain, rUnserved)
    if (rUnserved > 0.1) brandTrust = Math.max(12, brandTrust - rUnserved * 1.2)
    else if (pain < 0.1) brandTrust = Math.min(100, brandTrust + 0.04)

    // Capacity-limited share for display (overloaded labs lose weight)
    const rawShare = sharesByLab[r.id] ?? 0
    const effShare = capacityAdjustedMarketShare(rawShare, rServe)

    return {
      ...r,
      cash,
      brandTrust,
      marketShare: effShare,
      servicePain: pain,
      dayRevenue: dayRev,
      finance,
      lastDemandPf: demPf,
      lastCapacityPf: capPf,
      lastUnserved: rUnserved,
      servingEfficiency: Math.min(1.45, r.servingEfficiency + (rUnserved < 0.05 ? 0.0003 : 0)),
    }
  })

  // Renormalize rival+player shares after capacity weighting
  {
    const playerRaw = sharesByLab.player ?? 0
    const playerEff = capacityAdjustedMarketShare(playerRaw, serveFrac)
    sharesByLab.player = playerEff
    for (const r of rivals) sharesByLab[r.id] = r.marketShare
    const sum = Object.values(sharesByLab).reduce((a, b) => a + b, 0) || 1
    for (const k of Object.keys(sharesByLab)) {
      sharesByLab[k] = (sharesByLab[k] ?? 0) / sum
    }
    for (let i = 0; i < rivals.length; i++) {
      rivals[i] = {
        ...rivals[i]!,
        marketShare: sharesByLab[rivals[i]!.id] ?? rivals[i]!.marketShare,
        finance: rivals[i]!.finance
          ? {
              ...rivals[i]!.finance,
              totalShare: sharesByLab[rivals[i]!.id] ?? rivals[i]!.marketShare,
            }
          : rivals[i]!.finance,
      }
    }
  }

  const cash = state.player.cash + net
  const prev = state.player.finance
  const peakCash = Math.max(prev.peakCash ?? cash, cash)
  const lowestCash = Math.min(prev.lowestCash ?? cash, cash)
  const runwayDays =
    net >= 0 ? Number.POSITIVE_INFINITY : cash / Math.max(1, -net)

  // Attribute both channels to every model actually routed. The default model
  // remains the enterprise/headline endpoint, but it is no longer the only API
  // product that can earn revenue.
  const activeId = state.player.pricing.activeModelId
  const subscriptionByModel = new Map<string, { revenue: number; cogs: number; mtok: number }>()
  for (const stat of planStats) {
    for (const usage of stat.modelUsage ?? []) {
      const current = subscriptionByModel.get(usage.modelId) ?? { revenue: 0, cogs: 0, mtok: 0 }
      const share = stat.dayMTok > 0 ? usage.dayMTok / stat.dayMTok : 0
      current.revenue += stat.dayRevenue * share
      current.cogs += usage.dayMTok * usage.costPerMTok
      current.mtok += usage.dayMTok
      subscriptionByModel.set(usage.modelId, current)
    }
  }
  const modelFinance: ModelFinanceRow[] = state.player.models.map((m) => {
    const publicModel = m.release === 'released' || m.shipped
    const apiUsage = apiModelUsage.find((usage) => usage.modelId === m.id)
    const apiSettlement = apiModelSettlement.find((item) => item.model.id === m.id)
    const isApiActive = publicModel && (apiUsage?.dayMTok ?? 0) > 0
    const subscription = subscriptionByModel.get(m.id) ?? { revenue: 0, cogs: 0, mtok: 0 }
    const isActive = isApiActive || subscription.mtok > 0
    const { priceIn, priceOut } = modelApiInOut(state, m.id)
    const price = blendApiPrice(priceIn, priceOut)
    if (isActive) {
      const modelApiRevenue = apiSettlement?.dayRevenue ?? 0
      const modelApiCogs = (apiUsage?.dayMTok ?? 0) * (apiUsage?.costPerMTok ?? 0)
      const modelApiMTok = apiUsage?.dayMTok ?? 0
      return {
        modelId: m.id,
        name: m.name,
        family: m.family,
        release: m.release ?? (m.shipped ? 'released' : 'private'),
        isActive: true,
        isPublic: publicModel,
        capability: m.capability,
        apiPricePerMTok: price,
        dayApiRevenue: modelApiRevenue,
        dayApiDirectCogs: modelApiCogs,
        dayApiAllocatedOps: 0,
        dayApiCogs: modelApiCogs,
        dayApiMTok: modelApiMTok,
        dayApiContribution: modelApiRevenue - modelApiCogs,
        apiCapacityUtilization: capacityMTok > 0 ? modelApiMTok / capacityMTok : 0,
        daySubRevenue: subscription.revenue,
        daySubCogs: subscription.cogs,
        dayEnterpriseShare: m.id === activeId ? enterpriseRevenue : 0,
        dayNet:
          modelApiRevenue + subscription.revenue + (m.id === activeId ? enterpriseRevenue : 0) -
          modelApiCogs - subscription.cogs,
        note: unservedRatio > 0.15
          ? 'Capacity-constrained'
          : isApiActive && subscription.mtok > 0
            ? 'Serving API and subscription traffic'
            : isApiActive
              ? 'Serving API traffic'
              : 'Serving subscription traffic',
      }
    }
    return {
      modelId: m.id,
      name: m.name,
      family: m.family,
      release: m.release ?? (m.shipped ? 'released' : 'private'),
      isActive: false,
      isPublic: publicModel,
      capability: m.capability,
      apiPricePerMTok: price,
      dayApiRevenue: 0,
      dayApiDirectCogs: 0,
      dayApiAllocatedOps: 0,
      dayApiCogs: 0,
      dayApiMTok: 0,
      dayApiContribution: 0,
      apiCapacityUtilization: 0,
      daySubRevenue: 0,
      daySubCogs: 0,
      dayEnterpriseShare: 0,
      dayNet: 0,
      note: publicModel
        ? 'Not routed by API or a live subscription plan'
        : m.release === 'internal'
          ? 'Internal only — no market revenue'
          : 'Not public yet',
    }
  })

  let alerts = state.alerts
  let news = state.news
  // Only complain when demand actually exceeds inference PF (not residual pain with headroom)
  if (
    unservedRatio > 0.08 &&
    demandPf > computeLedger.usableCapacityPfDays &&
    playerDemandMTok > 0.05
  ) {
    const latDrop = Math.max(0, campusLatency - effectiveLatencyScore)
    const msg =
      unservedRatio > 0.4
        ? `Outage-level load: ${(unservedRatio * 100).toFixed(0)}% demand unserved · need ${demandPf.toFixed(1)} PF-d / have ${computeLedger.usableCapacityPfDays.toFixed(1)} after latency reserve · customers leaving.`
        : unservedRatio > 0.2
          ? `Service complaints: demand ${demandPf.toFixed(1)} PF-d vs pool ${computeLedger.usableCapacityPfDays.toFixed(1)} after reserve · churn ${(churnFrac * 100).toFixed(0)}%/d. Expand Serve or efficiency research.`
          : `Elevated load: ${(unservedRatio * 100).toFixed(0)}% unserved (latency −${latDrop.toFixed(0)}). Add inference or ship serving research.`
    alerts = [
      {
        id: `cap-${state.day}`,
        day: state.day,
        severity: unservedRatio > 0.25 ? ('danger' as const) : ('warn' as const),
        message: msg,
      },
      ...state.alerts.filter((a) => !a.id.startsWith('cap-')),
    ].slice(0, 40)
    if (unservedRatio > 0.2) {
      news = [
        `Day ${state.day}: Users complain about ${state.player.name} timeouts and slow replies.`,
        ...news,
      ].slice(0, 20)
    }
  } else if (servicePain > 0.15 && unservedRatio <= 0.05) {
    alerts = [
      {
        id: `cap-recover-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message: 'Capacity recovering — latency improving, but trust takes time to return.',
      },
      ...state.alerts.filter((a) => !a.id.startsWith('cap-')),
    ].slice(0, 40)
  }

  alerts = alerts.filter((alert) => !alert.id.startsWith('sales-cap-'))

  if (snap.throttled) {
    alerts = [
      {
        id: `power-${state.day}`,
        day: state.day,
        severity: 'danger' as const,
        message: 'Power / rack throttle — expand interconnects or free racks.',
      },
      ...alerts.filter((a) => !a.id.startsWith('power-')),
    ].slice(0, 40)
  }

  if (snap.chipCount === 0 && model) {
    alerts = [
      {
        id: `no-chips-${state.day}`,
        day: state.day,
        severity: 'warn' as const,
        message: 'Model ready but no live racks — order racks into a data hall.',
      },
      ...alerts.filter((a) => !a.id.startsWith('no-chips-')),
    ].slice(0, 40)
  }

  // Ops split for UI (serve vs other) — still one energy bill
  const energyOther = energyCostDay * (1 - opsServeShare)
  const chipAmortOther = chipAmort * (1 - opsServeShare)

  const finance = {
    cash,
    dayRevenue,
    dayCogs: productCogs,
    dayEnergyCost: energyCostDay,
    dayWageCost: wage,
    dayChipAmort: chipAmort,
    dayBuildingOpex: buildingOpex,
    dayMarketing: mkt,
    dayLoanPayment: 0, // filled by tickLoans after market
    dayEnergyOther: energyOther,
    dayChipAmortOther: chipAmortOther,
    apiRevenue,
    subRevenue,
    enterpriseRevenue,
    apiCogs,
    subCogs,
    dayGrossProfit,
    dayNet: net,
    dayTotalOut,
    marginPerSub: marginPerSubMonthly,
    marginPerMTok,
    totalShare: sharesByLab.player ?? 0,
    valuation: prev.valuation,
    lifetimeRevenue: (prev.lifetimeRevenue ?? 0) + dayRevenue,
    lifetimeNet: (prev.lifetimeNet ?? 0) + net,
    lifetimeProductCogs: (prev.lifetimeProductCogs ?? 0) + productCogs,
    peakCash,
    lowestCash,
    runwayDays,
    debtOutstanding: (state.player.loans ?? []).reduce((s, l) => s + l.remaining, 0),
  }

  const sample: FinanceDaySnapshot = {
    day: state.day,
    cash,
    revenue: dayRevenue,
    productCogs,
    opex: wage + mkt + buildingOpex,
    energy: energyCostDay,
    net,
    share: finance.totalShare,
    servedMTok,
    demandMTok: playerDemandMTok,
    effectivePf: snap.effectiveFlopsPf,
    valuation: prev.valuation,
    brand,
  }
  const financeHistory = [...state.financeHistory, sample].slice(-180)

  const baseTam = SEGMENTS.reduce((s, d) => s + d.baseSize, 0) || 1
  const settledSegments = grownSegments.map((segment) => ({
    ...segment,
    providerShares:
      nextProviderSharesBySegment.get(segment.id) ?? segment.providerShares ?? {
        [OUTSIDE_OPTION_PROVIDER_ID]: 1,
      },
  }))
  const liveTam = settledSegments.reduce((s, d) => s + d.size, 0)
  const marketAdoption = liveTam / baseTam

  return {
    ...state,
    segments: settledSegments,
    rivals,
    news,
    player: {
      ...state.player,
      cash,
      brandTrust: brand,
      servicePain,
      enterpriseContracts,
      finance,
    },
    lastMarket: {
      demandModelVersion: DEMAND_MODEL_VERSION,
      sharesByLab,
      demandMTok: totalDemandMTok,
      playerDemandMTok,
      servedMTok,
      unservedRatio,
      latencyScore: campusLatency,
      effectiveLatencyScore,
      servicePain,
      planStats,
      apiSubscribers: playerApiUsers * serveFracApi,
      apiDemandMTok: playerApiMTok,
      apiDayMTok: apiServed,
      apiDayRevenue: apiRevenue,
      apiDayDirectCogs: apiCogs,
      apiDayAllocatedOps: 0,
      apiDayCogs: apiCogs,
      apiModelUsage,
      capacityMTok,
      demandPf,
      servedPf,
      capacityPf,
      marginalPerMTok,
      modelFinance,
      industryDemandMTok: totalDemandMTok,
      industryServedMTok,
      marketAdoption,
      /** 0–1 inference reserved for API under constraint */
      apiVsSubPriority: apiPrio,
      apiServeFrac: serveFracApi,
      subServeFrac: serveFracSub,
      apiPoolPf,
      subPoolPf,
      capacitySalesCapped,
      blockedApiMTok: Math.max(0, playerApiMTok - apiServed),
      blockedSubscriptionSeats,
      capacityProductRevenueCeiling,
      computeLedger: reconciledComputeLedger,
    },
    financeHistory,
    alerts,
  }
}

import {
  DEMAND_MODEL_VERSION,
  ECONOMY,
  liftMarketTokenDemand,
  SEGMENTS,
  WORLD_POPULATION,
} from "../balance/economy";
import {
  demandGrowthAtProgress,
  frontierEquivalentMarketPrice,
} from "../balance/demandGrowth";
import { segmentBenchmarkFit } from "../balance/benchmarks";
import type {
  FinanceDaySnapshot,
  MarketOffer,
  MarketingOutcome,
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
} from "../types";
import { isCommerciallyOffered, isLivePublicModel } from "../modelRelease";
import { agedMarketView } from "../balance/modelAging";
import {
  peakServedCapability,
  personalityEngagement,
} from "../balance/modelProduct";
import {
  analyzeApiPricing,
  apiDemandElasticityMultiplier,
  apiDemandPricePenalty,
  apiPriceToleranceRatio,
  apiRevenueForCommercialWork,
  avgTokensPerInteraction,
  blendApiPrice,
  commercialApiListPricePerEquivalentMTok,
  commercialModelKind,
  DEFAULT_API_PRICE_ELASTICITY,
  SEGMENT_API_PRICE_ELASTICITY,
  splitBlendedApiPrice,
} from "../balance/pricing";
import {
  inferenceCapacityMTok,
  inferencePfAvailable,
  inferencePfDemand,
  pfPerMTokForModel,
  planActualMTokPerUser,
  planUsageUtilization,
  settleComputeLedger,
} from "../balance/serveCompute";
import {
  nextSpeedStrain,
  nextSurgeLevel,
  planSlownessDissatisfaction,
  strainLatencyFactor,
  strainSpeedFactor,
  surgeBrandPressure,
  peakPricingDemandMultiplier,
  surgePriceMultiplier,
  configuredAbsorbShare,
  serveControls,
  throttleAbsorbShare,
  throttleChurnScale,
  throttlePainScale,
  throttleSpillScale,
  isInferenceOutage,
} from "../balance/serveThrottle";
import {
  TOKEN_SPEED_BRAND_THRESHOLD,
  TOKEN_SPEED_KNEE,
  tokenSpeedBrandPressure,
} from "../balance/tokenSpeed";
import { normalizeAllocation } from "./compute";
import { computeSnapshot } from "./compute";
import {
  compactCompletedFacilitiesForOwner,
  facilityAnchorTiles,
  usesCompactWorld,
} from "./worldAccess";
import { cityPopulationDemandMultiplier } from "./cityGrowth";
import {
  labFacilityEnergyTotals,
  labBuildingOpex,
  resolvePlayerPowerMw,
  playerBuildingOpex,
  playerLatencyScore,
  playerServiceLatencyScore,
} from "./map";
import {
  onsiteGenerationUpkeepDay,
  powerExportDayRevenue,
  powerImportBill,
} from "./facilities";
import { labStaffWagePerDay, staffWagePerDay } from "./staff";
import { computeLabSnapshot, getLab } from "./labEngine";
import { hostedModelOpexDay } from "../balance/hostingOpex";
import { activeBalanceTuning } from "../balance/tuning";
import {
  computeWorkKindForProduct,
  nativeWorkFromEquivalentMTok,
  nativeWorkFromEquivalentMTokAtEffort,
} from "../balance/workload";
import {
  apiEffortChoice,
  planEffortMix,
  routedApiEffortChoices,
} from "../balance/effortEconomics";
import { currentMarketingOutcome } from "./marketing";
import {
  bestModelOnPlan,
  isFreePlan,
  maxSeatsForPlan,
  planAllowanceMTokPerMonth,
  planApiEquivalentValue,
  planAttractiveness,
  enforcePlanSubscriberPyramid,
  applyPlanUptierMigration,
  applyHighUsagePlanCohorts,
  blendPlanSeatStickiness,
  freeTierDemandProfile,
  modelCapabilityRank,
  planAdvertisedValueRatio,
  planPremiumReadiness,
  planEffectiveAllowanceMTokPerMonth,
  planMonthlyApiValueSubsidy,
  planPriceTooHighScore,
  planModelTrafficMix,
  planModelServePrecision,
  planComputePriority,
  modelForServePrecision,
  planAllowanceExpectation,
  planStabilityDissatisfaction,
  planServeModifiers,
  planSegmentPriceAffinity,
  planSegmentUsageAffinity,
  planSegmentUsageAffinityWeight,
  planSegmentAffinityWeight,
  planSubsidyRatio,
  planDemandShockMultiplier,
  planEnabledEffortRecipes,
  rivalNearestValueRatio,
  isApiAcceptingNew,
  isPlanAcceptingNew,
  apiWaitlistFeedEvent,
  subsClosedFeedEvent,
  planClosedFeedEvent,
} from "./plans";
import { appendFeedEvents, type FeedEventInput } from "./feed";
import {
  apiQualityCompetitivenessMultiplier,
  offerUtility,
  peersInPriceBand,
  segmentOfferQuality,
  segmentSoftmaxTemp,
  sotaProximity,
  sotaUsageMultiplier,
  softmaxShares,
} from "./marketScore";
import {
  segmentDomainHeatMultiplier,
} from "../balance/domainHeat";
import { deriveDemandSegments } from "./productPortfolio";
import {
  isGenerationOnlyModel,
  marketOfferCanCompeteForSegment,
} from "./modelEligibility";
import { normalizeModelRouters } from "../balance/modelStudio";
import {
  apiRouterParts,
  composeRouterModel,
  collapseRouterShares,
  planExposedModelIds,
  releasedRouterMemberIds,
  soldApiRouterMemberIds,
  soldApiRouters,
} from "../balance/modelRouter";

/** Fraction of a provider's reachable audience that converts into an active seat. */
export const PLAN_SEAT_CONVERSION = 0.034;

function playerOfferModel(state: SimState, offer: MarketOffer): Model | undefined {
  if (offer.routerId) {
    const router = normalizeModelRouters(state.player.modelRouters).find(
      (entry) => entry.id === offer.routerId,
    );
    if (!router) return undefined;
    return (
      composeRouterModel(
        router,
        apiRouterParts(router, state.player.models, offer.apiPrice),
      ) ?? undefined
    );
  }
  return state.player.models.find((model) => model.id === offer.modelId);
}

export { offerUtility, scoreOfferFactors, segmentShares } from "./marketScore";

export const OUTSIDE_OPTION_PROVIDER_ID = "outside";

export function attributedServingFixedCost(input: {
  energyCostDay: number;
  chipAmortDay: number;
  buildingOpexDay: number;
  computeLeaseCostDay: number;
  inferenceShare: number;
}): number {
  const inferenceShare = Math.max(0, Math.min(1, input.inferenceShare));
  return (
    (Math.max(0, input.energyCostDay) +
      Math.max(0, input.chipAmortDay) +
      Math.max(0, input.buildingOpexDay) +
      Math.max(0, input.computeLeaseCostDay)) *
    inferenceShare
  );
}

/**
 * Advance one model's commercial contribution ledger. Training starts the
 * ledger below zero; direct API/subscription/enterprise contribution repays it.
 */
export function advanceModelEconomics(
  model: Pick<Model, "economics">,
  row:
    | Pick<
        ModelFinanceRow,
        | "dayApiRevenue"
        | "daySubRevenue"
        | "dayEnterpriseShare"
        | "dayApiCogs"
        | "daySubCogs"
      >
    | undefined,
  day: number,
): NonNullable<Model["economics"]> {
  const prior = model.economics ?? {
    lifetimeApiRevenue: 0,
    lifetimeSubRevenue: 0,
    lifetimeEnterpriseRevenue: 0,
    lifetimeServingCost: 0,
    lifetimeNet: 0,
    trainingInitialCost: 0,
    trainingDataCost: 0,
    trainingDailyCost: 0,
  };
  const dayApiRevenue = row?.dayApiRevenue ?? 0;
  const daySubRevenue = row?.daySubRevenue ?? 0;
  const dayEnterpriseRevenue = row?.dayEnterpriseShare ?? 0;
  const dayServingCost = (row?.dayApiCogs ?? 0) + (row?.daySubCogs ?? 0);
  const lifetimeNet =
    prior.lifetimeNet +
    dayApiRevenue +
    daySubRevenue +
    dayEnterpriseRevenue -
    dayServingCost;
  const attributableTrainingCost =
    prior.trainingInitialCost +
    prior.trainingDataCost +
    prior.trainingDailyCost;
  return {
    ...prior,
    lifetimeApiRevenue: prior.lifetimeApiRevenue + dayApiRevenue,
    lifetimeSubRevenue: prior.lifetimeSubRevenue + daySubRevenue,
    lifetimeEnterpriseRevenue:
      prior.lifetimeEnterpriseRevenue + dayEnterpriseRevenue,
    lifetimeServingCost: prior.lifetimeServingCost + dayServingCost,
    lifetimeNet,
    paybackDay:
      prior.paybackDay ??
      (attributableTrainingCost > 0 && lifetimeNet >= 0 ? day : undefined),
  };
}

export const DOMINANT_MARKET_SHARE = 0.5;

/**
 * @deprecated Capacity admission now applies continuously at every market
 * share through the compute ledger. Retained for old callers and saves.
 */
export function dominantCapacitySalesGate(
  _marketShare: number,
  _apiServeFrac: number,
  _subServeFrac: number,
): boolean {
  return false;
}

/**
 * Market share represents customers actually served, not requests won before
 * capacity settlement. A provider with no available compute therefore cannot
 * retain a large headline share.
 */
export function capacityAdjustedMarketShare(
  rawShare: number,
  serveFrac: number,
): number {
  return (
    Math.max(0, rawShare) *
    Math.max(0, Math.min(1, Number.isFinite(serveFrac) ? serveFrac : 0))
  );
}

/**
 * Residual service pain cannot improve fulfilled share merely by suppressing
 * requests until today's smaller queue fits. It represents customers who have
 * already stopped relying on the endpoint and therefore remain outside.
 */
export function fulfilledServiceFraction(
  serveFraction: number,
  servicePain: number,
): number {
  const served = Math.max(0, Math.min(1, serveFraction));
  const pain = Math.max(0, Math.min(1, servicePain));
  return served * Math.max(0.2, 1 - pain * 0.6);
}

/**
 * Convert attached/preference share into fulfilled share after today's
 * capacity settlement. Unfulfilled customers remain in the market as an
 * outside/local/unserved option instead of being renormalized back onto
 * overloaded providers.
 */
export function settleFulfilledProviderShares(
  attachedShares: Readonly<Record<string, number>>,
  serveFractionByProvider: Readonly<Record<string, number>>,
): Record<string, number> {
  const next: Record<string, number> = {
    [OUTSIDE_OPTION_PROVIDER_ID]: Math.max(
      0,
      attachedShares[OUTSIDE_OPTION_PROVIDER_ID] ?? 0,
    ),
  };
  for (const [providerId, rawValue] of Object.entries(attachedShares)) {
    if (providerId === OUTSIDE_OPTION_PROVIDER_ID) continue;
    const attached = Math.max(0, Number.isFinite(rawValue) ? rawValue : 0);
    const served = Math.max(
      0,
      Math.min(
        1,
        Number.isFinite(serveFractionByProvider[providerId])
          ? serveFractionByProvider[providerId]!
          : 1,
      ),
    );
    const fulfilled = attached * served;
    next[providerId] = fulfilled;
    next[OUTSIDE_OPTION_PROVIDER_ID] =
      (next[OUTSIDE_OPTION_PROVIDER_ID] ?? 0) + attached - fulfilled;
  }
  const sourceTotal = Object.values(attachedShares).reduce(
    (sum, share) => sum + Math.max(0, Number.isFinite(share) ? share : 0),
    0,
  );
  const nextTotal = Object.values(next).reduce((sum, share) => sum + share, 0);
  if (sourceTotal > 1e-12 && nextTotal > 1e-12) {
    const correction = sourceTotal / nextTotal;
    for (const key of Object.keys(next))
      next[key] = (next[key] ?? 0) * correction;
  }
  return next;
}

function marketOfferKey(labId: string, modelId: string): string {
  return `${labId}\u0000${modelId}`;
}

function normalizedProviderShares(
  shares: Readonly<Record<string, number>>,
  keys: readonly string[],
): Record<string, number> {
  const result: Record<string, number> = {};
  let sum = 0;
  for (const key of keys) {
    const value = Math.max(0, Number.isFinite(shares[key]) ? shares[key]! : 0);
    result[key] = value;
    sum += value;
  }
  if (sum <= 1e-12) {
    result[OUTSIDE_OPTION_PROVIDER_ID] = 1;
    return result;
  }
  for (const key of keys) result[key] = (result[key] ?? 0) / sum;
  return result;
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
    .sort((a, b) => a.localeCompare(b));
  const keys = [...activeProviders, OUTSIDE_OPTION_PROVIDER_ID];
  const target = normalizedProviderShares(targetShares, keys);

  const hasPrior =
    priorShares != null &&
    Object.values(priorShares).some((value) => value > 0);
  if (!hasPrior) return target;

  const active = new Set(activeProviders);
  const inactivePrior = Object.entries(priorShares!).reduce(
    (sum, [providerId, share]) =>
      providerId !== OUTSIDE_OPTION_PROVIDER_ID && !active.has(providerId)
        ? sum + Math.max(0, Number.isFinite(share) ? share : 0)
        : sum,
    0,
  );
  const priorInput: Record<string, number> = {
    ...priorShares,
    [OUTSIDE_OPTION_PROVIDER_ID]:
      Math.max(0, priorShares![OUTSIDE_OPTION_PROVIDER_ID] ?? 0) +
      inactivePrior,
  };
  const prior = normalizedProviderShares(priorInput, keys);
  const inertia = Math.max(0, Math.min(0.995, switchingFriction));
  const next: Record<string, number> = {};
  for (const key of keys) {
    next[key] =
      (prior[key] ?? 0) * inertia + (target[key] ?? 0) * (1 - inertia);
  }
  return normalizedProviderShares(next, keys);
}

/**
 * Seat-weighted blend of enabled paid plan prices for stage-A offer scoring.
 * Falls back to inverse-price weights when yesterday's seats are unavailable.
 */
function headlineSubPrice(state: SimState): number {
  const paid = state.player.pricing.plans.filter(
    (p) => p.enabled && p.pricePerMonth > 0,
  );
  if (paid.length === 0) {
    const free = state.player.pricing.plans.find((p) => p.enabled);
    return free ? 0 : 999;
  }
  let weighted = 0;
  let weightTotal = 0;
  for (const plan of paid) {
    const prior = state.lastMarket.planStats.find(
      (stat) => stat.planId === plan.id,
    )?.subscribers;
    const weight =
      prior != null && prior > 0
        ? prior
        : Math.pow(Math.max(1, plan.pricePerMonth), -0.75);
    weighted += plan.pricePerMonth * weight;
    weightTotal += weight;
  }
  return weightTotal > 1e-9
    ? weighted / weightTotal
    : Math.min(...paid.map((p) => p.pricePerMonth));
}

function isPublic(m: {
  shipped: boolean;
  release?: string;
  archived?: boolean;
  commerciallyOffered?: boolean;
}) {
  return isCommerciallyOffered(m);
}

function hasServingModel(state: SimState): boolean {
  return state.player.models.some(isPublic);
}

function formatGb(gb: number): string {
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${Math.round(gb)} GB`;
}

function bestPlayerModel(state: SimState) {
  const shipped = state.player.models.filter(isPublic);
  if (shipped.length === 0) return null;
  const active = shipped.find(
    (m) => m.id === state.player.pricing.activeModelId,
  );
  if (active) return active;
  return [...shipped].sort((a, b) => b.capability - a.capability)[0]!;
}

function postedApiSurgeMultiplier(state: SimState): number {
  const controls = serveControls(state.player.pricing);
  if (controls.peakPricingPct <= 0) return 1;
  return surgePriceMultiplier(
    state.player.apiSurgeLevel ?? 0,
    controls.peakPricingPct,
  );
}

/** Blended list price for market scoring (in/out weighted). Per-model first. */
function modelApiPrice(state: SimState, modelId: string | null): number {
  const model = modelId
    ? state.player.models.find((candidate) => candidate.id === modelId)
    : undefined;
  return modelOfferApiPrice(state.player.pricing, model);
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
  const fallbackSplit = splitBlendedApiPrice(pricing.apiPricePerMTok);
  const fallbackIn = pricing.apiPriceInPerMTok ?? fallbackSplit.priceIn;
  const fallbackOut = pricing.apiPriceOutPerMTok ?? fallbackSplit.priceOut;
  if (!model) return { priceIn: fallbackIn, priceOut: fallbackOut };

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
    };
  }
  if (model.apiPricePerMTok != null) {
    const split = splitBlendedApiPrice(model.apiPricePerMTok);
    return {
      priceIn: split.priceIn,
      priceOut: split.priceOut,
    };
  }
  if (model.id === pricing.activeModelId) {
    return {
      priceIn: Math.max(0, fallbackIn),
      priceOut: Math.max(0, fallbackOut),
    };
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
  };
}

export function modelOfferApiPrice(
  pricing: ProductPricing,
  model: Model | null | undefined,
): number {
  const { priceIn, priceOut } = modelOfferApiInOut(pricing, model);
  if (!model) return blendApiPrice(priceIn, priceOut);
  return commercialApiListPricePerEquivalentMTok(
    commercialModelKind(model),
    priceIn,
    priceOut,
    {
      perImage: model.apiPricePerImage,
      perAudioMinute: model.apiPricePerAudioMinute,
      perVideoSecond: model.apiPricePerVideoSecond,
    },
  );
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
  const p = state.player.pricing;
  return modelOfferApiInOut(
    p,
    modelId ? state.player.models.find((model) => model.id === modelId) : null,
  );
}

/** Reliability customers experience after queues, timeouts, and retries. */
export function perceivedServiceReliability(
  modelReliability: number,
  servicePain: number,
): number {
  const pain = Math.max(0, Math.min(1, servicePain));
  return Math.max(8, modelReliability * (1 - pain * 0.55) - pain * 12);
}

/**
 * Paid acquisition lifts utility on both subscription and API-native segments
 * (hobby/indie/startup/science/creative) at similar strength.
 * Kept for rival labs that still settle from raw spend; the player path uses
 * {@link marketingOutcomeUtilityBonus} so demand reads canonical outcomes.
 */
export function marketingUtilityBonus(
  marketingSpendPerDay: number,
  prefersSubscription: boolean,
): number {
  if (marketingSpendPerDay <= 0) return 0;
  const lift = 1 + Math.max(0, marketingSpendPerDay) / 550_000;
  return Math.log(lift) * (prefersSubscription ? 1.4 : 1.3);
}

/**
 * Player demand utility from the canonical daily marketing outcome.
 * Uses acquired customers (share stealing) — not brandGain. Campaign brand is
 * written once by systems/marketing via tickOrg; offers already carry brandTrust.
 */
export function marketingOutcomeUtilityBonus(
  outcome: Pick<MarketingOutcome, "acquiredCustomers" | "enterpriseLeads">,
  prefersSubscription: boolean,
): number {
  const customers = Math.max(0, outcome.acquiredCustomers);
  if (customers <= 0) return 0;
  const enterpriseTilt = Math.min(
    0.25,
    Math.max(0, outcome.enterpriseLeads) / Math.max(1, customers),
  );
  // ~6k acquired customers ≈ the old log(1 + $550k/550k) utility scale.
  const lift = 1 + customers / 6_000;
  return (
    Math.log(lift) * (prefersSubscription ? 1.4 + enterpriseTilt * 0.4 : 1.3)
  );
}

/** Brand changes the premium customers will tolerate, without duplicating its
 * acquisition utility. Strong trust can defend a modest premium; weak trust
 * makes the same price feel riskier. */
export function brandPricingToleranceMultiplier(brandTrust: number): number {
  return Math.max(0.78, Math.min(1.24, 1 + (Math.max(0, Math.min(100, brandTrust)) - 50) / 420));
}

/** Resolve a rival model's list price with the same model-first precedence as the player. */
function rivalModelApiPrice(rival: RivalLab, model: Model): number {
  return modelOfferApiPrice(rival.pricing, model);
}

export function collectOffers(state: SimState): MarketOffer[] {
  const offers: MarketOffer[] = [];
  // Buyers price in recent overload (queues / timeouts), not just campus geography
  const pain = state.player.servicePain ?? 0;
  // Throttle strain slows streams independently of shed pain — per channel:
  // the API split can keep one channel fast while the other crawls.
  const strain = state.player.speedStrain ?? 0;
  const apiStrain = state.player.apiSpeedStrain ?? strain;
  const subStrain = state.player.subSpeedStrain ?? strain;
  const latency =
    playerServiceLatencyScore(state) * strainLatencyFactor(strain);
  const playerModels = state.player.models.filter(isPublic);
  const publicIds = new Set(playerModels.map((model) => model.id));
  const fallbackApiId =
    state.player.pricing.activeModelId &&
    publicIds.has(state.player.pricing.activeModelId)
      ? state.player.pricing.activeModelId
      : [...playerModels].sort((a, b) => b.capability - a.capability)[0]?.id;
  const apiIds = new Set(
    (
      state.player.pricing.apiModelIds ?? (fallbackApiId ? [fallbackApiId] : [])
    ).filter((id) => publicIds.has(id)),
  );
  const subscriptionIds = new Set(
    state.player.pricing.plans
      .filter((plan) => plan.enabled)
      .flatMap((plan) =>
        planExposedModelIds(
          plan,
          state.player.models,
          state.player.modelRouters,
        ),
      )
      .filter((id) => publicIds.has(id)),
  );
  if (subscriptionIds.size === 0 && fallbackApiId)
    subscriptionIds.add(fallbackApiId);

  const soldRouters = soldApiRouters({
    apiRouterIds: state.player.pricing.apiRouterIds,
    apiModelIds: state.player.pricing.apiModelIds,
    activeModelRouterId: state.player.activeModelRouterId,
    routers: state.player.modelRouters,
    models: playerModels,
  });
  const soldRouterMemberIds = new Set(
    soldApiRouterMemberIds(soldRouters, playerModels),
  );

  for (const playerModel of playerModels) {
    const apiListed =
      apiIds.has(playerModel.id) && !soldRouterMemberIds.has(playerModel.id);
    const subscriptionListed = subscriptionIds.has(playerModel.id);
    if (!apiListed && !subscriptionListed) continue;
    const apiPrecision =
      state.player.pricing.apiServePrecisionByModel?.[playerModel.id];
    const apiModel = modelForServePrecision(
      playerModel,
      apiPrecision,
      state.player.researchUnlocked,
    );
    // Interactive speed is single-request latency. More racks increase fleet
    // throughput, not this number.
    // Subscription-facing speed follows the sub channel's strain.
    const tokPerSec =
      (playerModel.serviceProfile?.interactiveTokPerSec ??
        Math.max(
          2,
          52 * playerModel.tokPerSecMult * state.player.servingEfficiency,
        )) *
      Math.max(0.25, 1 - pain * 0.55) *
      strainSpeedFactor(subStrain);
    const apiTokPerSec =
      (playerModel.serviceProfile?.interactiveTokPerSec ??
        Math.max(
          2,
          52 * playerModel.tokPerSecMult * state.player.servingEfficiency,
        )) *
      Math.max(0.25, 1 - pain * 0.55) *
      strainSpeedFactor(apiStrain);
    // Chronic overload tanks perceived reliability (timeouts, 5xx)
    const reliability = perceivedServiceReliability(
      playerModel.quality.reliability,
      pain,
    );
    const aged = agedMarketView(playerModel, state.day);
    const agedApi = agedMarketView(apiModel, state.day);
    offers.push({
      labId: "player",
      modelId: playerModel.id,
      capability: aged.capability,
      reliability,
      safety: playerModel.quality.safety,
      personality:
        playerModel.productProfile?.personality ??
        playerModel.benchmarks.personality ??
        playerModel.quality.chat,
      brandTrust: state.player.brandTrust,
      apiPrice:
        modelApiPrice(state, playerModel.id) * postedApiSurgeMultiplier(state),
      subPrice: headlineSubPrice(state),
      latencyScore: latency,
      tokPerSec,
      modalities: playerModel.modalities,
      isOpenWeights: false,
      benchmarks: aged.benchmarks,
      apiCapability: agedApi.capability,
      apiReliability: perceivedServiceReliability(
        apiModel.quality.reliability,
        pain,
      ),
      apiTokPerSec,
      apiBenchmarks: agedApi.benchmarks,
      generationOnly: isGenerationOnlyModel(playerModel),
      apiListed,
      subscriptionListed,
    });
  }

  for (const soldRouter of soldRouters) {
    const members = playerModels.filter((model) =>
      releasedRouterMemberIds(soldRouter, playerModels).includes(model.id),
    );
    if (members.length === 0) continue;
    const seedPrice =
      members.reduce((sum, model) => sum + modelApiPrice(state, model.id), 0) /
      members.length;
    const parts = apiRouterParts(soldRouter, playerModels, seedPrice);
    const composed = composeRouterModel(soldRouter, parts);
    if (!composed || parts.length === 0) continue;
    const apiPrice =
      parts.reduce(
        (sum, part) => sum + part.share * modelApiPrice(state, part.model.id),
        0,
      ) * postedApiSurgeMultiplier(state);
    const apiTokPerSec =
      parts.reduce((sum, part) => {
        const speed =
          part.model.serviceProfile?.interactiveTokPerSec ??
          Math.max(
            2,
            52 * part.model.tokPerSecMult * state.player.servingEfficiency,
          );
        return sum + part.share * speed;
      }, 0) *
      Math.max(0.25, 1 - pain * 0.55) *
      strainSpeedFactor(apiStrain);
    const reliability = perceivedServiceReliability(
      composed.quality.reliability,
      pain,
    );
    const agedRouter = agedMarketView(composed, state.day);
    offers.push({
      labId: "player",
      modelId: soldRouter.id,
      routerId: soldRouter.id,
      capability: agedRouter.capability,
      reliability,
      safety: composed.quality.safety,
      personality:
        composed.productProfile?.personality ??
        composed.benchmarks.personality ??
        composed.quality.chat,
      brandTrust: state.player.brandTrust,
      apiPrice,
      subPrice: headlineSubPrice(state),
      latencyScore: latency,
      tokPerSec: apiTokPerSec,
      modalities: composed.modalities,
      isOpenWeights: false,
      benchmarks: agedRouter.benchmarks,
      apiCapability: agedRouter.capability,
      apiReliability: reliability,
      apiTokPerSec,
      apiBenchmarks: agedRouter.benchmarks,
      generationOnly: parts.every((part) => isGenerationOnlyModel(part.model)),
      apiListed: true,
      subscriptionListed: false,
    });
  }

  for (const r of state.rivals) {
    const publicModels = r.models.filter(isPublic);
    for (const m of publicModels) {
      const rivalPain = r.servicePain ?? 0;
      const rivalStrain = r.speedStrain ?? 0;
      const region = state.map.regions.find((reg) => reg.id === r.regionId);
      const lat =
        (region ? (1 - region.latencyToMarket) * 100 : 60) *
        strainLatencyFactor(rivalStrain);
      const rivalTok =
        (m.serviceProfile?.interactiveTokPerSec ??
          Math.max(2, 52 * m.tokPerSecMult * r.servingEfficiency)) *
        Math.max(0.25, 1 - rivalPain * 0.55) *
        strainSpeedFactor(rivalStrain);
      const agedRival = agedMarketView(m, state.day);
      offers.push({
        labId: r.id,
        modelId: m.id,
        capability: agedRival.capability,
        reliability: perceivedServiceReliability(
          m.quality.reliability,
          rivalPain,
        ),
        safety: m.quality.safety,
        personality:
          m.productProfile?.personality ??
          m.benchmarks.personality ??
          m.quality.chat,
        brandTrust: r.brandTrust,
        apiPrice: rivalModelApiPrice(r, m),
        subPrice: r.pricing.subPlusPrice,
        latencyScore: r.archetype === "hyperscale" ? Math.max(lat, 80) : lat,
        tokPerSec: rivalTok,
        modalities: m.modalities,
        isOpenWeights: m.openWeights ?? r.archetype === "open_weights",
        benchmarks: agedRival.benchmarks,
        generationOnly: isGenerationOnlyModel(m),
        apiListed: true,
        subscriptionListed: true,
      });
    }
  }

  return offers;
}

function playerOfferTokPerSec(
  offers: MarketOffer[],
  modelId: string,
  channel: "api" | "subscription",
): number | undefined {
  const offer = offers.find(
    (candidate) => candidate.labId === "player" && candidate.modelId === modelId,
  );
  if (!offer) return undefined;
  return channel === "api"
    ? (offer.apiTokPerSec ?? offer.tokPerSec)
    : offer.tokPerSec;
}

function weightedPlayerOfferTokPerSec(
  offers: MarketOffer[],
  modelUsage: { modelId: string; share?: number; dayMTok?: number }[] | undefined,
  channel: "api" | "subscription",
): number | undefined {
  if (!modelUsage || modelUsage.length === 0) return undefined;
  let weighted = 0;
  let weight = 0;
  for (const usage of modelUsage) {
    const tok = playerOfferTokPerSec(offers, usage.modelId, channel);
    if (tok == null) continue;
    const w = (usage.share ?? 0) > 1e-12 ? usage.share! : (usage.dayMTok ?? 0);
    if (w <= 0) continue;
    weighted += tok * w;
    weight += w;
  }
  return weight > 1e-12 ? weighted / weight : undefined;
}

/**
 * Quality-normalized median blended API price across all OTHER labs' general
 * offers — the market's going rate for the player's quality level. Peer prices
 * are scaled by (playerQuality / peerQuality) where quality reuses the
 * successRate formula from marketScore (capability × 0.42 + consumer-weighted
 * benchmark fit × 0.38 + reliability × 0.2). Plan value perception is judged
 * against this reference so gouging your own API list price cannot inflate
 * how good your plans look. Falls back to the player's own blended price when
 * no rivals have public models.
 */
export function marketReferenceApiPrice(
  state: SimState,
  offers: MarketOffer[] = collectOffers(state),
): number {
  const consumerWeights =
    SEGMENTS.find((s) => s.id === "consumer")?.benchmarkWeights ?? {};
  const qualityOf = (offer: MarketOffer) =>
    Math.max(
      0.08,
      Math.min(
        1,
        (offer.capability * 0.42 +
          segmentBenchmarkFit(offer.benchmarks, consumerWeights) * 0.38 +
          offer.reliability * 0.2) /
          100,
      ),
    );
  const playerGeneral = offers.filter(
    (offer) =>
      offer.labId === state.playerLabId && offer.generationOnly !== true,
  );
  const playerQuality = playerGeneral.reduce(
    (best, offer) => Math.max(best, qualityOf(offer)),
    0,
  );
  const peerPrices = offers
    .filter(
      (offer) =>
        offer.labId !== state.playerLabId && offer.generationOnly !== true,
    )
    .map((offer) => ({ price: offer.apiPrice, quality: qualityOf(offer) }))
    .filter((peer) => peer.price > 0);
  const fallback = (() => {
    // No rival price signal: judge value at what the player's own models were
    // worth at launch (suggested list), never the current list price — else a
    // monopolist raising API prices would inflate plan attractiveness.
    const bestPlayer = playerGeneral.reduce<MarketOffer | null>(
      (best, offer) =>
        best == null || qualityOf(offer) > qualityOf(best) ? offer : best,
      null,
    );
    const model = bestPlayer
      ? state.player.models.find((m) => m.id === bestPlayer.modelId)
      : undefined;
    if (model) {
      return blendApiPrice(
        model.suggestedApiPriceIn ?? model.costApiPriceIn ?? 0.5,
        model.suggestedApiPriceOut ?? model.costApiPriceOut ?? 2,
      );
    }
    return state.player.pricing.apiPriceInPerMTok != null &&
      state.player.pricing.apiPriceOutPerMTok != null
      ? blendApiPrice(
          state.player.pricing.apiPriceInPerMTok,
          state.player.pricing.apiPriceOutPerMTok,
        )
      : Math.max(0.05, state.player.pricing.apiPricePerMTok);
  })();
  if (peerPrices.length === 0 || playerQuality <= 0) return fallback;
  const normalized = peerPrices
    .map((peer) => peer.price * (playerQuality / peer.quality))
    .sort((a, b) => a - b);
  const mid = Math.floor(normalized.length / 2);
  return normalized.length % 2 === 1
    ? normalized[mid]!
    : (normalized[mid - 1]! + normalized[mid]!) / 2;
}

/**
 * Expected monthly subscription price a segment sees from the player's plan
 * mix: affinity × inverse-price^0.5 weighted mean of enabled paid plans. The
 * affinity term lets enterprise audiences "see" the £200 tiers they shop for
 * while consumer audiences see the £20 tier; the inverse-price term keeps the
 * cheapest tier dominant without hard zeroing premium ones. Falls back to the
 * headline seat-weighted price when no paid plan is enabled.
 */
function expectedSubPriceForSegment(
  state: SimState,
  segmentId: SegmentId,
): number {
  const paid = state.player.pricing.plans.filter(
    (plan) => plan.enabled && plan.pricePerMonth > 0,
  );
  if (paid.length === 0) return headlineSubPrice(state);
  let weighted = 0;
  let weightTotal = 0;
  for (const plan of paid) {
    const affinity = planSegmentPriceAffinity(plan.pricePerMonth, segmentId);
    const weight = affinity * Math.pow(Math.max(1, plan.pricePerMonth), -0.5);
    weighted += plan.pricePerMonth * weight;
    weightTotal += weight;
  }
  return weightTotal > 1e-9 ? weighted / weightTotal : headlineSubPrice(state);
}

/**
 * Sub-price tolerance scales with the segment's ARPU anchor: a £100+/mo plan
 * mix is normal for enterprise/legal/healthcare buyers and gouging for
 * consumers. This is what lets an expensive plan mix cost consumer share
 * without costing enterprise share. API segments keep the base tolerance.
 */
function subSegmentPriceToleranceScale(segmentId: SegmentId): number {
  const anchor = SEGMENTS.find((s) => s.id === segmentId)?.arpuHint ?? 20;
  return Math.max(1, Math.min(12, anchor / 20));
}

/** Nested choice: first choose a lab, then a model inside that lab. */
export function nestedOfferShares(
  offers: MarketOffer[],
  utilities: number[],
  temperature: number,
  outsideUtility?: number,
): number[] {
  if (offers.length === 0) return [];
  const byLab = new Map<string, number[]>();
  for (let i = 0; i < offers.length; i++) {
    const indexes = byLab.get(offers[i]!.labId);
    if (indexes) indexes.push(i);
    else byLab.set(offers[i]!.labId, [i]);
  }
  const labs = [...byLab.keys()];
  const labUtilities = labs.map((labId) => {
    const indexes = byLab.get(labId)!;
    const values = indexes.map((index) => utilities[index]!);
    const best = Math.max(...values);
    // Portfolio breadth is useful, but duplicate models cannot multiply share.
    const breadth = Math.min(
      1.5,
      Math.log1p(Math.max(0, indexes.length - 1)) * 0.65,
    );
    return best + breadth;
  });
  const labShares = softmaxShares(
    outsideUtility == null ? labUtilities : [...labUtilities, outsideUtility],
    temperature,
  ).slice(0, labs.length);
  const result = Array.from({ length: offers.length }, () => 0);
  for (let li = 0; li < labs.length; li++) {
    const indexes = byLab.get(labs[li]!)!;
    const within = softmaxShares(
      indexes.map((index) => utilities[index]!),
      Math.max(0.8, temperature * 0.85),
    );
    for (let wi = 0; wi < indexes.length; wi++) {
      result[indexes[wi]!] = labShares[li]! * within[wi]!;
    }
  }
  return result;
}

/** EMA of capacity overload — rises when demand > inference, fades when healthy. */
export function nextServicePain(
  prevPain: number,
  unservedRatio: number,
): number {
  const p = Math.max(0, Math.min(1, prevPain));
  const u = Math.max(0, Math.min(1, unservedRatio));
  if (u > 0.05) {
    // Spike when truly overloaded (not float dust)
    return Math.min(1, p * 0.8 + u * 0.38 + (u > 0.4 ? 0.05 : 0));
  }
  // Heal fast when capacity covers demand — no lingering complaints at headroom
  return Math.max(0, p * 0.65 - 0.05);
}

export interface OfferDemandBucket {
  offer: MarketOffer;
  model: Model;
  /** Actual billable token volume after the selected effort mix. */
  apiMTok: number;
  /** Instant-equivalent customer work before generated-token expansion. */
  apiBaseMTok?: number;
  /** Base work multiplied by the effort mix's generated-token multiplier. */
  apiGeneratedMTok?: number;
  /** Base work multiplied by the effort mix's physical compute multiplier. */
  apiComputeMTok?: number;
  subscriptionMTok: number;
  /**
   * Active subscription seats already converted with {@link PLAN_SEAT_CONVERSION}.
   * Rival MTok and settleRivalOfferDemand both treat this as seats (not raw audience).
   */
  subscriptionUsers: number;
}

export interface RivalOfferSettlement {
  demandMTok: number;
  demandPf: number;
  capacityServedMTok: number;
  apiServedMTok: number;
  subscriptionServedMTok: number;
  keptSubscriptionUsers: number;
  apiRevenue: number;
  subscriptionRevenue: number;
  serveFrac: number;
  unservedRatio: number;
}

/**
 * Rivals use the same fixed physical entitlement rule as the player. Public
 * API list prices affect perceived value, never included subscription work.
 */
export function rivalPlanAllowanceMTokPerMonth(
  _rival: RivalLab,
  plan: SubPlan,
  _model: Model,
): number {
  return planAllowanceMTokPerMonth(plan);
}

export function rivalPlanDemandPerUser(
  rival: RivalLab,
  model: Model,
  frontierCapability: number,
  day: number,
): number {
  const enabled = (rival.pricing.plans ?? []).filter(
    (plan) =>
      plan.enabled &&
      (plan.modelIds.length === 0 || plan.modelIds.includes(model.id)),
  );
  const plans =
    enabled.length > 0
      ? enabled
      : (rival.pricing.plans ?? []).filter((plan) => plan.enabled);
  if (plans.length === 0) return ECONOMY.basePlanUsageMTokPerDay;
  const rawWeights = plans.map((plan) => {
    const allowance = rivalPlanAllowanceMTokPerMonth(rival, plan, model);
    // Match player pyramid: cheaper plans carry more of rival seat mass.
    return Math.max(
      0.05,
      Math.log1p(allowance) * 1.05 -
        Math.log1p(Math.max(0, plan.pricePerMonth)) * 0.55 +
        (plan.pricePerMonth <= 0 ? 1.8 : plan.pricePerMonth <= 40 ? 0.6 : 0),
    );
  });
  const weightTotal = rawWeights.reduce((sum, weight) => sum + weight, 0);
  const servedCapability = peakServedCapability(model);
  const sota = sotaProximity(servedCapability, frontierCapability);
  return plans.reduce((sum, plan, index) => {
    const allowance = rivalPlanAllowanceMTokPerMonth(rival, plan, model);
    const shock = planDemandShockMultiplier(plan, day);
    const utilization = planUsageUtilization(plan, plans, {
      modelCapability: servedCapability,
      frontierCapability,
      demandShockMultiplier: shock,
      allowanceMTokPerMonth: allowance,
    });
    const qualityEngagement =
      (0.85 + Math.pow(sota, 1.35) * 0.15) *
      personalityEngagement(
        model.productProfile?.personality ??
          model.benchmarks.personality ??
          model.quality.chat,
      );
    const launchEngagement = 1 + Math.max(0, shock - 1) * 0.15;
    const perUser = Math.min(
      allowance / ECONOMY.daysPerMonth,
      liftMarketTokenDemand(
        planActualMTokPerUser(
          plan,
          ECONOMY.basePlanUsageMTokPerDay,
          utilization,
          allowance,
        ) *
          qualityEngagement *
          launchEngagement,
      ),
    );
    return sum + perUser * (rawWeights[index]! / Math.max(1e-9, weightTotal));
  }, 0);
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
  );
  const demandPf = buckets
    .map((bucket) => {
      const apiComputeMTok = bucket.apiComputeMTok ?? bucket.apiMTok;
      return (
        apiComputeMTok *
          pfPerMTokForModel(bucket.model, servingEfficiency) +
        inferencePfDemand(
          bucket.subscriptionMTok,
          bucket.model,
          servingEfficiency,
        )
      );
    })
    .sort((a, b) => a - b)
    .reduce((sum, work) => sum + work, 0);
  const workItems = buckets.flatMap((bucket, index) => {
    const apiWork =
      (bucket.apiComputeMTok ?? bucket.apiMTok) *
      pfPerMTokForModel(bucket.model, servingEfficiency);
    const subscriptionWork = inferencePfDemand(
      bucket.subscriptionMTok,
      bucket.model,
      servingEfficiency,
    );
    return [
      ...(bucket.apiMTok > 0
        ? [
            {
              id: `api:${index}`,
              channel: "api",
              requestedUnits: bucket.apiMTok,
              requestedWorkPfDays: apiWork,
              priority: 70,
            },
          ]
        : []),
      ...(bucket.subscriptionMTok > 0
        ? [
            {
              id: `subscription:${index}`,
              channel: "subscription",
              requestedUnits: bucket.subscriptionMTok,
              requestedWorkPfDays: subscriptionWork,
              priority: 60,
            },
          ]
        : []),
    ];
  });
  const ledger = settleComputeLedger(workItems, {
    capacityPfDays: Math.max(0, capacityPf),
    reservations: { api: 0.68, subscription: 0.32 },
  });
  const serveFrac =
    ledger.requestedUnits > 1e-9
      ? ledger.servedUnits / ledger.requestedUnits
      : 1;
  const unservedRatio = ledger.unservedRatio;
  const pain = Math.max(0, Math.min(1, priorServicePain));
  const baseChurn =
    unservedRatio <= 0.03
      ? pain * 0.04
      : Math.min(
          0.55,
          unservedRatio * 0.22 + pain * 0.28 + (unservedRatio > 0.5 ? 0.08 : 0),
        );
  const subChurn = Math.min(0.62, baseChurn * 0.9 + (1 - serveFrac) * 0.38);
  const subKeep = Math.max(0.08, 1 - subChurn * 1.05);

  let apiServedMTok = 0;
  let subscriptionServedMTok = 0;
  let keptSubscriptionUsers = 0;
  let apiRevenue = 0;
  let subscriptionRevenue = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index]!;
    const apiRow = ledger.rows.find((row) => row.id === `api:${index}`);
    const subscriptionRow = ledger.rows.find(
      (row) => row.id === `subscription:${index}`,
    );
    const apiServed = apiRow?.servedUnits ?? 0;
    const subServed = subscriptionRow?.servedUnits ?? 0;
    // subscriptionUsers is already seat-converted upstream (once).
    const subDelivery =
      bucket.subscriptionMTok > 1e-9 ? subServed / bucket.subscriptionMTok : 1;
    const keptSeats = bucket.subscriptionUsers * subKeep;
    apiServedMTok += apiServed;
    subscriptionServedMTok += subServed;
    keptSubscriptionUsers += keptSeats;
    apiRevenue += apiServed * Math.max(0, bucket.offer.apiPrice);
    subscriptionRevenue +=
      (keptSeats *
        Math.max(0, bucket.offer.subPrice) *
        (0.5 + 0.5 * subDelivery)) /
      ECONOMY.daysPerMonth;
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
  };
}

import { labInferCapacityWorkPf } from "./labCompute";

/** Rival inference capacity — same abstractPools math as train/research (+ leases). */
export function rivalInferCapacityPf(
  r:
    | RivalLab
    | {
        flopsPf: number;
        utilCap: number;
        servingEfficiency: number;
        allocation: { training: number; inference: number; research: number };
        data?: { dataGenResearchShare?: number };
        id?: string;
      },
  state?: SimState,
  resolvedPhysical?: ReturnType<typeof computeLabSnapshot>,
): number {
  if (state && r.id) {
    const physical = resolvedPhysical ?? computeLabSnapshot(state, r.id);
    return physical.inferenceWorkPf;
  }
  return labInferCapacityWorkPf({
    flopsPf: r.flopsPf,
    utilCap: r.utilCap,
    allocation: r.allocation,
    servingEfficiency: r.servingEfficiency,
    dataGenResearchShare: r.data?.dataGenResearchShare,
  });
}

export function tickMarket(state: SimState): SimState {
  const offers = collectOffers(state);
  const snap = computeSnapshot(state);
  const campusLatency = playerLatencyScore(state);
  const activeModel = bestPlayerModel(state);
  const serveEff = state.player.servingEfficiency;
  const alloc = normalizeAllocation(state.player.allocation);
  // Token-based Cap (racks × model × serve share × derates) — single source of truth
  const capacityMTok = activeModel
    ? inferenceCapacityMTok(snap, activeModel, serveEff, alloc.inference)
    : 0;
  // PF pool kept for tooltips / legacy fields
  const capacityPf = inferencePfAvailable(snap);
  const priorPain = state.player.servicePain ?? 0;

  const sharesByLab: Record<string, number> = {
    player: 0,
    [OUTSIDE_OPTION_PROVIDER_ID]: 0,
  };
  for (const r of state.rivals) sharesByLab[r.id] = 0;

  // Exact offer/model buckets are authoritative for shared-economy settlement.
  const demandByOffer = new Map(
    offers.map((offer) => [
      marketOfferKey(offer.labId, offer.modelId),
      {
        offer,
        apiMTok: 0,
        apiBaseMTok: 0,
        apiGeneratedMTok: 0,
        apiComputeMTok: 0,
        apiRatioWeightedMTok: 0,
        apiElasticityWeightedMTok: 0,
        subscriptionMTok: 0,
        subscriptionUsers: 0,
      },
    ]),
  );

  let playerApiUsers = 0;
  let playerApiMTok = 0;
  /** Subscriber audience tracked per prefersSub segment (consumer/enterprise/legal/healthcare). */
  const playerSubUsersBySegment = new Map<SegmentId, number>();
  /** Hobby + light freemium well for plan funnel */
  let playerHobbyUsers = 0;
  let playerIndieUsers = 0;
  let totalDemandMTok = 0;
  let enterpriseWeight = 0;
  let playerPricingComplaintPressure = 0;

  const segBoost = (id: SegmentId) =>
    state.activeEvents.reduce(
      (m, e) => m * (e.effects.segmentBoost?.[id] ?? 1),
      1,
    );

  const generalOffers = offers.filter((offer) => offer.generationOnly !== true);
  const frontier = generalOffers.reduce(
    (m, o) => Math.max(m, o.capability),
    20,
  );

  // Adoption and automated-task growth diffuse separately: a 10x workload
  // boom no longer implies 10x as many people.
  const horizonDays = Math.max(
    365,
    (state.config.campaignRules.reportYear -
      state.config.campaignRules.startYear +
      1) *
      365.25,
  );
  const progress = Math.max(0, Math.min(1, (state.day - 1) / horizonDays));
  // Measure the cheapest frontier-equivalent work from one coherent offer.
  // This prevents a bargain weak endpoint and a separate expensive frontier
  // model from being combined into a fictitious cheap-and-smart market signal.
  const marketPrice = frontierEquivalentMarketPrice(
    generalOffers.map((offer) => ({
      capability: offer.capability,
      // API list price is the comparable marginal price of more intelligence.
      // Subscription seats have capped entitlements and are modeled separately;
      // treating a free seat as free marginal tokens would create infinite TAM.
      pricePerMTok: offer.apiPrice,
    })),
  );
  const adoptionMin =
    state.industryDataPack.demand.reportYearUserMinMultiplier ?? 1.5;
  const adoptionMax = Math.max(
    adoptionMin,
    state.industryDataPack.demand.reportYearUserMaxMultiplier ?? 3,
  );
  const taskMin = Math.max(
    1,
    state.industryDataPack.demand.reportYearMinMultiplier,
  );
  const taskMax = Math.max(
    taskMin,
    state.industryDataPack.demand.reportYearMaxMultiplier,
  );
  const demandGrowth = demandGrowthAtProgress({
    progress,
    frontierCapability: frontier,
    marketPricePerMTok: marketPrice,
    userMinMultiplier: adoptionMin,
    userMaxMultiplier: adoptionMax,
    taskMinMultiplier: taskMin,
    taskMaxMultiplier: taskMax,
  });
  const adoptionMultiple = demandGrowth.userAdoptionMultiplier;
  const taskIntensityMultiple = demandGrowth.taskIntensityMultiplier;
  const audienceCandidates = state.segments.map((seg) => {
    const base = SEGMENTS.find((s) => s.id === seg.id)?.baseSize ?? seg.size;
    const next = Math.min(
      base * adoptionMax,
      Math.max(seg.size, base * adoptionMultiple),
    );
    return { ...seg, size: next };
  });
  const candidateAudience = audienceCandidates.reduce(
    (sum, segment) => sum + segment.size,
    0,
  );
  const audienceScale =
    candidateAudience > WORLD_POPULATION
      ? WORLD_POPULATION / candidateAudience
      : 1;
  let grownSegments = audienceCandidates.map((segment) => ({
    ...segment,
    size: segment.size * audienceScale,
  }));
  if (audienceScale < 1 && grownSegments.length > 0) {
    const scaledAudience = grownSegments.reduce(
      (sum, segment) => sum + segment.size,
      0,
    );
    const populationRemainder = WORLD_POPULATION - scaledAudience;
    grownSegments = grownSegments.map((segment, index) =>
      index === grownSegments.length - 1 && populationRemainder !== 0
        ? { ...segment, size: segment.size + populationRemainder }
        : segment,
    );
  }
  // Marketing expands TAM (new addressable customers), separate from share
  // stealing via utility. Brand lift is NOT applied here — marketing.ts is the
  // single writer of campaign brandGain (settled later in tickOrg).
  const playerMarketingOutcome = currentMarketingOutcome(state);
  const expansionCustomers = Math.max(
    0,
    playerMarketingOutcome.marketExpansion,
  );
  if (expansionCustomers > 0) {
    const audience = grownSegments.reduce(
      (sum, segment) => sum + segment.size,
      0,
    );
    if (audience > 0) {
      grownSegments = grownSegments.map((segment) => ({
        ...segment,
        size: segment.size + expansionCustomers * (segment.size / audience),
      }));
      const expandedAudience = grownSegments.reduce(
        (sum, segment) => sum + segment.size,
        0,
      );
      if (expandedAudience > WORLD_POPULATION) {
        const capScale = WORLD_POPULATION / expandedAudience;
        grownSegments = grownSegments.map((segment) => ({
          ...segment,
          size: segment.size * capScale,
        }));
        const cappedAudience = grownSegments.reduce(
          (sum, segment) => sum + segment.size,
          0,
        );
        const populationRemainder = WORLD_POPULATION - cappedAudience;
        grownSegments = grownSegments.map((segment, index) =>
          index === grownSegments.length - 1 && populationRemainder !== 0
            ? { ...segment, size: segment.size + populationRemainder }
            : segment,
        );
      }
    }
  }
  const switchingBySegment = new Map(
    deriveDemandSegments(state).map((segment) => [
      segment.id,
      segment.switchingFriction,
    ]),
  );
  const nextProviderSharesBySegment = new Map<
    SegmentId,
    Record<string, number>
  >();

  const frontierTaskBoost =
    1 + Math.max(0, frontier - 20) * ECONOMY.marketGrowthPerCapability * 0.35;
  const apiBase = liftMarketTokenDemand(ECONOMY.apiBaseMTokPerUserDay);
  // Prior overload softens freeload / sticky traffic before we recompute pain
  const painDemandDamp = Math.max(0.35, 1 - priorPain * 0.55);
  const metroDemand = cityPopulationDemandMultiplier(state);

  for (const segState of grownSegments) {
    const segDef = SEGMENTS.find((s) => s.id === segState.id)!;
    const segmentOffers = offers
      .filter((offer) =>
        marketOfferCanCompeteForSegment(offer, segState.id, segDef.prefersSub),
      )
      .map((offer) =>
        // Subscription buyers see the player's plan mix through this segment's
        // willingness-to-pay, not one global headline price: an expensive plan
        // mix costs consumer share but not enterprise share. Rivals keep their
        // flat subPlusPrice.
        segDef.prefersSub && offer.labId === state.playerLabId
          ? {
              ...offer,
              subPrice: expectedSubPriceForSegment(state, segState.id),
            }
          : offer,
      );
    if (segmentOffers.length === 0) {
      nextProviderSharesBySegment.set(segState.id, {
        [OUTSIDE_OPTION_PROVIDER_ID]: 1,
      });
      continue;
    }
    const modelByOffer = new Map(
      segmentOffers.map((offer) => [
        marketOfferKey(offer.labId, offer.modelId),
        offer.labId === state.playerLabId
          ? playerOfferModel(state, offer)
          : state.rivals
              .find((rival) => rival.id === offer.labId)
              ?.models.find((model) => model.id === offer.modelId),
      ]),
    );
    const baseEffectiveOffer = (offer: MarketOffer) =>
      segDef.prefersSub
        ? offer
        : {
            ...offer,
            capability: offer.apiCapability ?? offer.capability,
            reliability: offer.apiReliability ?? offer.reliability,
            tokPerSec: offer.apiTokPerSec ?? offer.tokPerSec,
            benchmarks: offer.apiBenchmarks ?? offer.benchmarks,
          };
    const effortByOffer = new Map<
      string,
      ReturnType<typeof apiEffortChoice>
    >();
    if (!segDef.prefersSub) {
      for (const offer of segmentOffers) {
        const key = marketOfferKey(offer.labId, offer.modelId);
        const model = modelByOffer.get(key);
        if (!model) continue;
        const scoredOffer = baseEffectiveOffer(offer);
        const peerOffers = segmentOffers
          .filter(
            (peer) =>
              !(peer.labId === offer.labId && peer.modelId === offer.modelId),
          )
          .map(baseEffectiveOffer);
        const kind = commercialModelKind(model);
        const monopolyAnchor = blendApiPrice(
          model.suggestedApiPriceIn ?? model.costApiPriceIn ?? 0.5,
          model.suggestedApiPriceOut ?? model.costApiPriceOut ?? 2,
        );
        const initialPricing = analyzeApiPricing({
          price: offer.apiPrice,
          marginalCost: 0,
          capability: scoredOffer.capability,
          featureScore: scoredOffer.modalities.length * 18,
          tokPerSec: scoredOffer.tokPerSec,
          kind,
          peers:
            peerOffers.length > 0
              ? peerOffers.map((peer) => ({
                  price: peer.apiPrice,
                  capability: peer.capability,
                  featureScore: peer.modalities.length * 18,
                  tokPerSec: peer.tokPerSec,
                }))
              : [
                  {
                    price: monopolyAnchor,
                    capability: scoredOffer.capability,
                    featureScore: scoredOffer.modalities.length * 18,
                    tokPerSec: scoredOffer.tokPerSec,
                  },
                ],
        });
        const ownerPricing =
          offer.labId === state.playerLabId
            ? state.player.pricing
            : state.rivals.find((rival) => rival.id === offer.labId)?.pricing;
        const prices = modelOfferApiInOut(
          ownerPricing ?? state.player.pricing,
          model,
        );
        const surge =
          offer.labId === state.playerLabId
            ? postedApiSurgeMultiplier(state)
            : 1;
        effortByOffer.set(
          key,
          apiEffortChoice({
            model,
            kind,
            ratioToPeer: initialPricing.ratioToPeer ?? 1,
            priceElasticity:
              SEGMENT_API_PRICE_ELASTICITY[segState.id] ??
              DEFAULT_API_PRICE_ELASTICITY,
            priceIn: prices.priceIn * surge,
            priceOut: prices.priceOut * surge,
            baseCapability: scoredOffer.capability,
            baseBenchmarks: scoredOffer.benchmarks,
          }),
        );
      }
    }
    const effectiveOffer = (offer: MarketOffer): MarketOffer => {
      const base = baseEffectiveOffer(offer);
      const effort = effortByOffer.get(
        marketOfferKey(offer.labId, offer.modelId),
      );
      return effort
        ? {
            ...base,
            capability: effort.realizedCapability,
            benchmarks: effort.realizedBenchmarks,
            apiPrice: base.apiPrice * effort.effectiveTaskPriceMultiplier,
          }
        : base;
    };
    const segmentFrontier = segmentOffers.reduce(
      (highest, offer) => Math.max(highest, effectiveOffer(offer).capability),
      20,
    );
    const segmentQualityFrontier = segmentOffers.reduce(
      (highest, offer) =>
        Math.max(
          highest,
          segmentOfferQuality(effectiveOffer(offer), segState.id),
        ),
      0,
    );

    // Frontier-relative utilities: SOTA leads; mid-pack still gets real share.
    // Peer-relative pricing is judged against ALL other offers competing in the
    // segment, so an outlandishly priced offer still sees the whole market as
    // peers (the similar-price band is kept only for priceBandCompetitionBonus,
    // whose band semantics are correct there).
    const pricingByOffer = new Map<
      string,
      ReturnType<typeof analyzeApiPricing>
    >();
    const utils = segmentOffers.map((o) => {
      const scoredOffer = effectiveOffer(o);
      const bandPeers = peersInPriceBand(
        scoredOffer,
        segmentOffers.map(effectiveOffer),
        segDef.prefersSub,
      );
      let u = offerUtility(scoredOffer, segState.id, {
        frontier: segmentFrontier,
        qualityFrontier: segmentQualityFrontier,
        priceBandPeers: bandPeers,
        domainHeat: state.domainHeat,
      });
      const segmentPeers = segmentOffers
        .filter(
          (peer) => !(peer.labId === o.labId && peer.modelId === o.modelId),
        )
        .map((peer) => effectiveOffer(peer));
      const scoredModel = modelByOffer.get(
        marketOfferKey(o.labId, o.modelId),
      );
      const kind = scoredModel ? commercialModelKind(scoredModel) : "language";
      // Monopoly anchor: with no rival offers in the segment there is no peer
      // median, but demand must still respond to absolute price. Judge the
      // offer against its own suggested launch price (API) or the segment's
      // ARPU anchor (subscriptions) — a 1000× markup must collapse even when
      // the lab is the only seller.
      const monopolyAnchorPrice = segDef.prefersSub
        ? Math.max(1, segDef.arpuHint)
        : blendApiPrice(
            scoredModel?.suggestedApiPriceIn ??
              scoredModel?.costApiPriceIn ??
              0.5,
            scoredModel?.suggestedApiPriceOut ??
              scoredModel?.costApiPriceOut ??
              2,
          );
      const peerPrices =
        segmentPeers.length > 0
          ? segmentPeers.map((peer) => ({
              price: segDef.prefersSub ? peer.subPrice : peer.apiPrice,
              capability: peer.capability,
              featureScore: peer.modalities.length * 18,
              tokPerSec: peer.tokPerSec,
            }))
          : [
              {
                price: monopolyAnchorPrice,
                capability: scoredOffer.capability,
                featureScore: scoredOffer.modalities.length * 18,
                tokPerSec: scoredOffer.tokPerSec,
              },
            ];
      const pricingStatus = analyzeApiPricing({
        price: segDef.prefersSub
          ? scoredOffer.subPrice
          : scoredOffer.apiPrice,
        marginalCost: 0,
        capability: scoredOffer.capability,
        featureScore: scoredOffer.modalities.length * 18,
        tokPerSec: scoredOffer.tokPerSec,
        kind,
        peers: peerPrices,
      });
      pricingByOffer.set(marketOfferKey(o.labId, o.modelId), pricingStatus);
      const pricePenalty = apiDemandPricePenalty({
        ratioToPeer: pricingStatus.ratioToPeer,
        kind,
        capabilityLead: pricingStatus.capabilityLead,
        featureLead: pricingStatus.featureLead,
        toleranceScale: segDef.prefersSub
          ? subSegmentPriceToleranceScale(segState.id)
          : 1,
      });
      u -= pricePenalty;
      if (pricingStatus.primary === "undercutting") u += 1;
      if (o.labId === state.playerLabId) {
        // Acquired customers steal share; brandGain is already in brandTrust
        // on the offer and must not be added again here.
        u += marketingOutcomeUtilityBonus(
          playerMarketingOutcome,
          segDef.prefersSub,
        );
      } else {
        const rival = state.rivals.find((candidate) => candidate.id === o.labId);
        const outcome = rival?.marketingOutcome;
        u +=
          outcome && outcome.day === state.day
            ? marketingOutcomeUtilityBonus(outcome, segDef.prefersSub)
            : marketingUtilityBonus(rival?.marketingSpendPerDay ?? 0, segDef.prefersSub);
      }
      return u;
    });
    const outsideUtility = Math.max(
      -1,
      Math.min(5, 2.4 + (segDef.qualityFloor - frontier) * 0.035),
    );
    const targetOfferShares = nestedOfferShares(
      segmentOffers,
      utils,
      segmentSoftmaxTemp(segState.id),
      outsideUtility,
    );
    const targetProviderShares: Record<string, number> = {
      [OUTSIDE_OPTION_PROVIDER_ID]: Math.max(
        0,
        1 - targetOfferShares.reduce((sum, share) => sum + share, 0),
      ),
    };
    for (let i = 0; i < segmentOffers.length; i++) {
      const providerId = segmentOffers[i]!.labId;
      targetProviderShares[providerId] =
        (targetProviderShares[providerId] ?? 0) + targetOfferShares[i]!;
    }
    // Demand spillover: yesterday's rejected demand walks to competitors.
    // Overloaded labs bleed target share proportional to service pain (labs
    // running a throttle policy bleed less — their users wait, not walk).
    // Freed mass flows to the other labs ∝ their target shares — never to the
    // outside option — and settleSegmentProviderShares conserves the total.
    const playerSpillDamp = throttleSpillScale(
      configuredAbsorbShare(
        state.player.pricing,
        state.lastMarket.unservedRatio ?? 0,
      ),
    );
    let freedShare = 0;
    for (const key of Object.keys(targetProviderShares)) {
      if (key === OUTSIDE_OPTION_PROVIDER_ID) continue;
      const isPlayer = key === "player";
      const pain = isPlayer
        ? (state.player.servicePain ?? 0)
        : (state.rivals.find((rival) => rival.id === key)?.servicePain ?? 0);
      if (pain <= 0.01) continue;
      const damp = isPlayer
        ? playerSpillDamp
        : throttleSpillScale(throttleAbsorbShare("balanced", pain));
      const bleed = Math.min(0.5, Math.max(0, pain) * 0.35 * damp);
      const freed = (targetProviderShares[key] ?? 0) * bleed;
      targetProviderShares[key] = (targetProviderShares[key] ?? 0) - freed;
      freedShare += freed;
    }
    if (freedShare > 1e-12) {
      const recipientTotal = Object.entries(targetProviderShares)
        .filter(([key]) => key !== OUTSIDE_OPTION_PROVIDER_ID)
        .reduce((sum, [, share]) => sum + Math.max(0, share), 0);
      if (recipientTotal > 1e-12) {
        for (const key of Object.keys(targetProviderShares)) {
          if (key === OUTSIDE_OPTION_PROVIDER_ID) continue;
          targetProviderShares[key] =
            Math.max(0, targetProviderShares[key] ?? 0) +
            (freedShare * Math.max(0, targetProviderShares[key] ?? 0)) /
              recipientTotal;
        }
      }
    }
    const providerShares = settleSegmentProviderShares(
      segState.providerShares,
      targetProviderShares,
      switchingBySegment.get(segState.id) ?? 0,
    );
    nextProviderSharesBySegment.set(segState.id, providerShares);

    // Provider choice changes with inertia; model choice within the selected
    // provider remains responsive. This preserves portfolio choice without
    // letting a lab reset switching friction by launching another model.
    const shares = targetOfferShares.map((targetShare, index) => {
      const providerId = segmentOffers[index]!.labId;
      const targetProviderShare = targetProviderShares[providerId] ?? 0;
      if (targetProviderShare <= 1e-12) return 0;
      return (
        (providerShares[providerId] ?? 0) * (targetShare / targetProviderShare)
      );
    });
    const boost = segBoost(segState.id);
    const segSize = segState.size * boost * metroDemand;
    const taskGrowthExponent = segDef.prefersSub
      ? 0.72
      : segState.id === "science"
        ? 0.7
        : 0.68;
    const usage =
      segState.usageIntensity *
      Math.pow(taskIntensityMultiple, taskGrowthExponent) *
      frontierTaskBoost *
      segmentDomainHeatMultiplier(segDef.benchmarkWeights, state.domainHeat);

    sharesByLab[OUTSIDE_OPTION_PROVIDER_ID] =
      (sharesByLab[OUTSIDE_OPTION_PROVIDER_ID] ?? 0) +
      (providerShares[OUTSIDE_OPTION_PROVIDER_ID] ?? 0) * (segSize / 1e6);

    for (let i = 0; i < segmentOffers.length; i++) {
      const offer = segmentOffers[i]!;
      const servedOffer = effectiveOffer(offer);
      const share = shares[i]!;
      sharesByLab[offer.labId] =
        (sharesByLab[offer.labId] ?? 0) + share * (segSize / 1e6);

      const users = segSize * share;
      const sota = sotaProximity(servedOffer.capability, segmentFrontier);
      // Demand = users × base × segment intensity × SOTA engagement
      let mtok =
        users *
        apiBase *
        usage *
        ECONOMY.marketDailyActiveUsageShare *
        sotaUsageMultiplier(sota, segState.id);

      const bench = segmentBenchmarkFit(
        servedOffer.benchmarks,
        segDef.benchmarkWeights,
      );
      const qualityDamp = Math.min(
        1,
        (servedOffer.capability + servedOffer.reliability + bench) / 180,
      );
      mtok *= 0.55 + qualityDamp * 0.55;

      // Provider choice and usage intensity both respond to usable quality.
      // This is smooth (never a top-N cutoff): lagging endpoints keep budget
      // traffic, but cannot turn a very low list price into frontier workload.
      if (!segDef.prefersSub) {
        mtok *= apiQualityCompetitivenessMultiplier({
          quality: segmentOfferQuality(servedOffer, segState.id),
          frontierQuality: segmentQualityFrontier,
          qualityFloor: segDef.qualityFloor,
          segmentId: segState.id,
        });
      }

      // Free/hobby traffic backs off when the cluster has been on fire
      const offerPain =
        offer.labId === state.playerLabId
          ? priorPain
          : (state.rivals.find((rival) => rival.id === offer.labId)
              ?.servicePain ?? 0);
      if (!segDef.prefersSub && offerPain > 0.08) {
        mtok *= Math.max(0.35, 1 - offerPain * 0.55);
      }
      let apiBaseMTok = 0;
      let apiGeneratedTokenMultiplier = 1;
      let apiComputeTokenMultiplier = 1;
      let apiRatioToPeer = 1;
      let apiPriceElasticity = DEFAULT_API_PRICE_ELASTICITY;
      if (!segDef.prefersSub) {
        const key = marketOfferKey(offer.labId, offer.modelId);
        const model = modelByOffer.get(key);
        const kind = model ? commercialModelKind(model) : "language";
        const pricingStatus = pricingByOffer.get(key);
        apiPriceElasticity =
          SEGMENT_API_PRICE_ELASTICITY[segState.id] ??
          DEFAULT_API_PRICE_ELASTICITY;
        // Realized token demand responds to the peer-relative price with a
        // per-segment elasticity: premiums beyond the tolerated ratio collapse
        // MTok toward a 2% trickle; mild undercuts earn up to +15%.
        mtok *= apiDemandElasticityMultiplier({
          ratioToPeer:
            pricingStatus?.ratioToPeer == null
              ? null
              : pricingStatus.ratioToPeer /
                brandPricingToleranceMultiplier(offer.brandTrust),
          kind,
          capabilityLead: pricingStatus?.capabilityLead,
          featureLead: pricingStatus?.featureLead,
          elasticity: apiPriceElasticity,
        });
        // Peak pricing is an explicit demand control, not just a revenue
        // multiplier. At aggressive uplifts the API audience walks away even
        // when the lab is the only seller; this prevents a high posted price
        // from leaving the demand ledger falsely saturated.
        if (offer.labId === state.playerLabId) {
          mtok *= peakPricingDemandMultiplier(postedApiSurgeMultiplier(state));
        }
        apiBaseMTok = mtok;
        const effort = effortByOffer.get(key);
        apiRatioToPeer =
          (pricingStatus?.ratioToPeer ?? 1) /
          Math.max(1, effort?.effectiveTaskPriceMultiplier ?? 1);
        if (effort) {
          apiGeneratedTokenMultiplier = effort.generatedTokenMultiplier;
          apiComputeTokenMultiplier = effort.computeTokenMultiplier;
          mtok = apiBaseMTok * effort.billedTokenMultiplier;
          if (offer.labId === state.playerLabId) {
            playerPricingComplaintPressure = Math.max(
              playerPricingComplaintPressure,
              effort.complaintPressure,
            );
          }
        }
        if (
          offer.labId === state.playerLabId &&
          pricingStatus?.ratioToPeer != null
        ) {
          // Complaint pressure tracks how far past the tolerated ratio the
          // price sits (log scale, capped at 1 — same magnitude as the old
          // penalty/9 bookkeeping).
          const tolerated = apiPriceToleranceRatio(
            kind,
            pricingStatus.capabilityLead,
            pricingStatus.featureLead,
          );
          playerPricingComplaintPressure = Math.max(
            playerPricingComplaintPressure,
            Math.min(
              1,
              Math.max(0, Math.log(pricingStatus.ratioToPeer / tolerated)) *
                0.4,
            ),
          );
        }
      } else if (offer.labId !== state.playerLabId) {
        const rival = state.rivals.find(
          (candidate) => candidate.id === offer.labId,
        );
        const model = rival?.models.find(
          (candidate) => candidate.id === offer.modelId,
        );
        if (rival && model) {
          mtok =
            users *
            PLAN_SEAT_CONVERSION *
            rivalPlanDemandPerUser(rival, model, segmentFrontier, state.day);
        }
      }

      totalDemandMTok += mtok;
      const wonDemand = demandByOffer.get(
        marketOfferKey(offer.labId, offer.modelId),
      );
      if (wonDemand) {
        if (segDef.prefersSub) {
          wonDemand.subscriptionMTok += mtok;
          // Convert audience → seats exactly once here. Rival MTok already used
          // the same factor; settleRivalOfferDemand must not convert again.
          wonDemand.subscriptionUsers += users * PLAN_SEAT_CONVERSION;
        } else {
          wonDemand.apiMTok += mtok;
          wonDemand.apiBaseMTok += apiBaseMTok;
          wonDemand.apiGeneratedMTok +=
            apiBaseMTok * apiGeneratedTokenMultiplier;
          wonDemand.apiComputeMTok +=
            apiBaseMTok * apiComputeTokenMultiplier;
          wonDemand.apiRatioWeightedMTok += apiBaseMTok * apiRatioToPeer;
          wonDemand.apiElasticityWeightedMTok +=
            apiBaseMTok * apiPriceElasticity;
        }
      }

      if (offer.labId === "player") {
        if (segDef.prefersSub) {
          playerSubUsersBySegment.set(
            segState.id,
            (playerSubUsersBySegment.get(segState.id) ?? 0) + users,
          );
        } else {
          // API product segments (indie/startup/creative/hobby)
          playerApiUsers += users;
          playerApiMTok += mtok;
          if (segState.id === "hobby") playerHobbyUsers += users;
          if (segState.id === "indie_api") playerIndieUsers += users;
        }
        if (
          segState.id === "enterprise" ||
          segState.id === "legal" ||
          segState.id === "healthcare"
        ) {
          enterpriseWeight += users * share;
        }
      }
    }
  }

  // Re-normalize weighted shares after marketing bias. The outside option is
  // retained, making player + rivals + manual/local/no-adoption conserve to 1.
  const shareSum = Object.values(sharesByLab).reduce((a, b) => a + b, 0) || 1;
  for (const k of Object.keys(sharesByLab)) {
    sharesByLab[k] = (sharesByLab[k] ?? 0) / shareSum;
  }

  // Pause-new API: keep yesterday's intensity; refused demand stays off the
  // ledger so it cannot generate timeout/unserved pain.
  let pausedNewApiMTok = 0;
  if (!isApiAcceptingNew(state.player.pricing)) {
    const priorApi = Math.max(0, state.lastMarket.apiDemandMTok ?? 0);
    if (playerApiMTok > priorApi + 1e-12) {
      const scale = priorApi / playerApiMTok;
      pausedNewApiMTok = playerApiMTok - priorApi;
      playerApiMTok = priorApi;
      playerApiUsers *= scale;
      for (const demand of demandByOffer.values()) {
        if (demand.offer.labId !== "player") continue;
        demand.apiMTok *= scale;
        demand.apiBaseMTok *= scale;
        demand.apiGeneratedMTok *= scale;
        demand.apiComputeMTok *= scale;
        demand.apiRatioWeightedMTok *= scale;
        demand.apiElasticityWeightedMTok *= scale;
      }
    }
  }

  // --- Split subscribers across custom plans ---
  const enabledPlans = state.player.pricing.plans.filter((p) => p.enabled);
  const freePlanOn = enabledPlans.some((p) => isFreePlan(p));
  // Freemium funnel: modest share of hobby → seats (most hobby stays API demand)
  // Closing free pushes more hobby into paid seats without starving API.
  const freemiumPool = freePlanOn
    ? playerHobbyUsers * 0.28 + playerIndieUsers * 0.06
    : playerHobbyUsers * 0.38 + playerIndieUsers * 0.14;

  // Plan value PERCEPTION is judged at the market's going rate for the player's
  // quality level, never the player's own API list price — otherwise raising
  // your own API price would make your plans look like better deals. Finance
  // numbers below (apiEquivalentValue, subsidyRatio) keep the lab's own blend.
  const marketReferenceApi = marketReferenceApiPrice(state, offers);
  const planPerceptionOpts = {
    referenceApiPricePerMTok: marketReferenceApi,
    includeMassPrior: false,
  };

  const frontierCap = Math.max(
    activeModel?.capability ?? 40,
    ...state.rivals.flatMap((r) =>
      r.models.filter((m) => m.shipped).map((m) => m.capability),
    ),
    40,
  );

  const freePlanRankOpts = (plan: SubPlan) => {
    const model = bestModelOnPlan(state, plan);
    return {
      modelRank: model ? modelCapabilityRank(state, model.id) : null,
      tokensPerInteraction: model
        ? avgTokensPerInteraction(commercialModelKind(model))
        : undefined,
    };
  };

  // Natural sub segments + freemium funnel into plan seat demand.
  // Segment sizes are total category audience; only a small fraction converts
  // into an active paid/free seat in one lab's current acquisition window.
  // Absolute users = segment population × provider share × an explicit seat
  // conversion. 3.4% keeps billion-person audiences as tens of millions of
  // seats so subscriptions can rival API revenue without eating the TAM.
  //
  // Each subscription segment splits its OWN audience across the enabled paid
  // plans, with willingness-to-pay anchored at the segment's ARPU (log-normal
  // affinity): enterprise/legal/healthcare audiences genuinely buy £120–£250
  // tiers while consumer stays near £20. The freemium funnel (hobby/indie
  // converts) splits across paid + free with its own £4 (indie_api) anchor.
  const paidPlans = enabledPlans.filter((p) => !isFreePlan(p));
  const seatsByPlan = new Map<string, number>();
  const addSeats = (planId: string, seats: number) =>
    seatsByPlan.set(planId, (seatsByPlan.get(planId) ?? 0) + seats);
  // Cooler softmax keeps price-tier gaps from collapsing into a flat mix.
  const PLAN_SPLIT_SOFTMAX_TEMP = 1.05;

  for (const [segId, segUsers] of playerSubUsersBySegment) {
    if (segUsers <= 0 || paidPlans.length === 0) continue;
    const utils = paidPlans.map((p) => {
      const allowance = planEffectiveAllowanceMTokPerMonth(state, p);
      let u =
        planAttractiveness(state, p, segId, planPerceptionOpts) +
        Math.log(planSegmentPriceAffinity(p.pricePerMonth, segId)) *
          planSegmentAffinityWeight(segId) +
        Math.log(planSegmentUsageAffinity(allowance, segId)) *
          planSegmentUsageAffinityWeight(segId);
      if (!freePlanOn) u += 14; // paid more attractive when free closed
      return u;
    });
    const shares = softmaxShares(utils, PLAN_SPLIT_SOFTMAX_TEMP);
    paidPlans.forEach((p, j) =>
      addSeats(p.id, segUsers * PLAN_SEAT_CONVERSION * shares[j]!),
    );
  }

  // Freemium funnel audience: paid plans + the free plan (which keeps its
  // demand-profile utility bonus here), scored at the consumer-ish breadth
  // profile with the £4 indie_api price anchor.
  const freeIdx = enabledPlans.findIndex((p) => isFreePlan(p));
  const freeDemandProfile =
    freeIdx >= 0
      ? freeTierDemandProfile(
          enabledPlans[freeIdx]!,
          freePlanRankOpts(enabledPlans[freeIdx]!),
        )
      : null;
  let funnelPlanShares: number[] = [];
  if (enabledPlans.length > 0) {
    const utils = enabledPlans.map((p) => {
      let u =
        planAttractiveness(state, p, "consumer", planPerceptionOpts) +
        Math.log(planSegmentPriceAffinity(p.pricePerMonth, "indie_api")) *
          planSegmentAffinityWeight("indie_api");
      if (!isFreePlan(p) && !freePlanOn) u += 14;
      // With free live, paid conversion is earned via attractiveness/readiness —
      // do not give paid SKUs a flat utility bump that flattens the pyramid.
      if (isFreePlan(p) && freePlanOn) {
        u += freeTierDemandProfile(p, freePlanRankOpts(p)).utilityBonus;
      }
      return u;
    });
    funnelPlanShares = softmaxShares(utils, PLAN_SPLIT_SOFTMAX_TEMP);
    if (freemiumPool > 0) {
      enabledPlans.forEach((p, j) =>
        addSeats(
          p.id,
          freemiumPool * PLAN_SEAT_CONVERSION * funnelPlanShares[j]!,
        ),
      );
    }
  }

  type PlanBucket = {
    plan: SubPlan;
    /** Shaped/sticky demand before the configured enrollment cap. */
    demandSubscribers: number;
    /** Seats retained above a newly lowered cap. */
    grandfatheredSubscribers: number;
    subscribers: number;
    maxSeats: number;
    /** Instant-equivalent plan work before output/reasoning expansion. */
    baseRawMTok: number;
    rawMTok: number;
    usageRate: number;
    model: ReturnType<typeof bestModelOnPlan>;
    modelMix: ReturnType<typeof planModelTrafficMix>;
    effortByModelId: Record<string, ReturnType<typeof planEffortMix>>;
    demandPf: number;
    priceTooHigh: number;
    allowanceMTokMonth: number;
    apiEquivalentValue: number;
    subsidyRatio: number;
  };
  const playerApiBlend =
    state.player.pricing.apiPriceInPerMTok != null &&
    state.player.pricing.apiPriceOutPerMTok != null
      ? blendApiPrice(
          state.player.pricing.apiPriceInPerMTok,
          state.player.pricing.apiPriceOutPerMTok,
        )
      : state.player.pricing.apiPricePerMTok;

  // API/subscription shares are reservations, not hard partitions. The unified
  // ledger backfills either reservation when its channel is quiet.
  const apiPrio = Math.max(
    0.12,
    Math.min(
      0.88,
      state.player.pricing.apiVsSubPriority ??
        ECONOMY.defaultApiVsSubPriority ??
        0.68,
    ),
  );
  const subPoolShare = 1 - apiPrio;
  const subPoolMTok = capacityMTok * subPoolShare;
  const apiPoolPf = capacityPf * apiPrio;
  const subPoolPf = capacityPf * subPoolShare;

  // Build unconstrained plan demand first, then scale seats into sub PF pool.
  // The free plan's mass logic (audience multiplier, minimum share, upgrade
  // base) applies to the funnel + consumer audiences only — enterprise/legal/
  // healthcare audiences never see the free SKU.
  const freeAddressable =
    ((playerSubUsersBySegment.get("consumer") ?? 0) + freemiumPool) *
    PLAN_SEAT_CONVERSION;
  const freeMassBase =
    freeIdx >= 0
      ? Math.max(
          freeAddressable *
            (funnelPlanShares[freeIdx] ?? 0) *
            (freeDemandProfile?.audienceMultiplier ?? 1),
          freeAddressable * (freeDemandProfile?.minimumAudienceShare ?? 0),
        )
      : 0;
  // Free→paid conversion is a continuous product signal, not a softmax
  // winner-takes-all gate. A badly valued plan retains a small recovery path;
  // a strong plan earns a much higher conversion rate. This prevents prior
  // dissatisfaction from numerically erasing every paid tier forever.
  const paidUpgradeWeights = enabledPlans.map((plan) => {
    if (isFreePlan(plan) || !freePlanOn || freeMassBase <= 0) return 0;
    const price = Math.max(1, plan.pricePerMonth);
    const model = bestModelOnPlan(state, plan);
    if (!model) return 0;
    const facingCap = agedMarketView(model, state.day).capability;
    const readiness = planPremiumReadiness({
      pricePerMonth: plan.pricePerMonth,
      brandTrust: state.player.brandTrust,
      modelCapability: facingCap,
      frontierCapability: frontierCap,
      modelReliability: model.quality.reliability,
    });
    const allowance = planEffectiveAllowanceMTokPerMonth(state, plan);
    const valueRatio = planAdvertisedValueRatio(
      plan,
      marketReferenceApi,
      allowance,
    );
    const valueSignal =
      0.04 + 0.96 * (1 - Math.exp(-Math.max(0, valueRatio) / 0.8));
    const priorDissatisfaction =
      state.lastMarket.planStats.find((stat) => stat.planId === plan.id)
        ?.dissatisfaction ?? 0;
    const satisfactionSignal =
      0.08 +
      0.92 * Math.pow(Math.max(0, 1 - Math.min(1, priorDissatisfaction)), 1.2);
    const priceReachExp = 1.15 - 0.45 * readiness;
    const priceReach = 1 / (1 + Math.pow(price / 20, priceReachExp));
    const demandSignal =
      valueSignal * (0.3 + readiness * 0.7) * satisfactionSignal;
    return Math.max(1e-6, demandSignal * priceReach);
  });
  const paidUpgradeWeightSum = paidUpgradeWeights.reduce((s, w) => s + w, 0);
  let bestPaidUpgradeSignal = 0;
  let bestPaidReadiness = 0;
  for (const plan of enabledPlans) {
    if (isFreePlan(plan)) continue;
    const model = bestModelOnPlan(state, plan);
    if (!model) continue;
    const facingCap = agedMarketView(model, state.day).capability;
    const readiness = planPremiumReadiness({
      pricePerMonth: plan.pricePerMonth,
      brandTrust: state.player.brandTrust,
      modelCapability: facingCap,
      frontierCapability: frontierCap,
      modelReliability: model.quality.reliability,
    });
    const valueRatio = planAdvertisedValueRatio(
      plan,
      marketReferenceApi,
      planEffectiveAllowanceMTokPerMonth(state, plan),
    );
    const valueSignal =
      0.04 + 0.96 * (1 - Math.exp(-Math.max(0, valueRatio) / 0.8));
    const priorDissatisfaction =
      state.lastMarket.planStats.find((stat) => stat.planId === plan.id)
        ?.dissatisfaction ?? 0;
    const satisfactionSignal =
      0.08 +
      0.92 * Math.pow(Math.max(0, 1 - Math.min(1, priorDissatisfaction)), 1.2);
    bestPaidUpgradeSignal = Math.max(
      bestPaidUpgradeSignal,
      valueSignal * (0.3 + readiness * 0.7) * satisfactionSignal,
    );
    bestPaidReadiness = Math.max(bestPaidReadiness, readiness);
  }
  const paidUpgradeCap = 0.18 + 0.12 * bestPaidReadiness;
  const paidUpgradeRate = Math.min(
    paidUpgradeCap,
    0.0015 + bestPaidUpgradeSignal * 0.22,
  );

  const rawBuckets = enabledPlans.map((plan, i) => {
    let subscribers = seatsByPlan.get(plan.id) ?? 0;
    // Free→paid upgrade: smaller conversion, biased to cheaper paid tiers
    if (!isFreePlan(plan) && freePlanOn && freeMassBase > 0) {
      const myPaidFrac =
        paidUpgradeWeightSum > 1e-9
          ? paidUpgradeWeights[i]! / paidUpgradeWeightSum
          : 0;
      subscribers += freeMassBase * paidUpgradeRate * myPaidFrac;
    }
    // Free tier shrinks modestly as people upgrade — keep the wide funnel.
    if (isFreePlan(plan) && freePlanOn) {
      const profile = freeTierDemandProfile(plan, freePlanRankOpts(plan));
      subscribers = Math.max(
        subscribers * 0.88 * profile.audienceMultiplier,
        freeAddressable * profile.minimumAudienceShare,
      );
    }

    const modelMix = planModelTrafficMix(state, plan);
    const planModel =
      [...modelMix].sort((a, b) => b.model.capability - a.model.capability)[0]
        ?.model ?? activeModel ?? null;
    const cap =
      modelMix.length > 0
        ? modelMix.reduce(
            (sum, lane) => sum + lane.share * lane.model.capability,
            0,
          )
        : (planModel?.capability ?? 45);
    // Subsidy plans derive their effective allowance from per-model
    // entitlements; legacy token plans resolve to their stored allowance.
    const effectiveAllowanceMTok = planEffectiveAllowanceMTokPerMonth(
      state,
      plan,
    );
    const subsidyGbp = planMonthlyApiValueSubsidy(plan, playerApiBlend);
    const valueRatio = planAdvertisedValueRatio(
      plan,
      playerApiBlend,
      effectiveAllowanceMTok,
    );
    const autoU = planUsageUtilization(plan, enabledPlans, {
      modelCapability: cap,
      frontierCapability: frontierCap,
      demandShockMultiplier: planDemandShockMultiplier(plan, state.day),
      allowanceMTokPerMonth: effectiveAllowanceMTok,
    });
    const usageRate = autoU;
    const sota = sotaProximity(cap, frontierCap);
    const free = isFreePlan(plan);
    // Capability moves use within the tier's steady-state band. It must never
    // multiply actual consumption beyond the configured entitlement.
    const personalityScore =
      planModel?.productProfile?.personality ??
      planModel?.benchmarks.personality ??
      planModel?.quality.chat ??
      50;
    const qualityEngagement =
      (free
        ? 0.7 + Math.pow(sota, 1.35) * 0.3
        : 0.85 + Math.pow(sota, 1.35) * 0.15) *
      personalityEngagement(personalityScore, free);
    // Subscriber price rejection is judged at the market reference rate, not
    // the lab's own (possibly gouged) API list price.
    const priceTooHigh = planPriceTooHighScore(plan, {
      apiPricePerMTok: marketReferenceApi,
      modelCapability: cap,
      frontierCapability: frontierCap,
      utilization: usageRate,
    });
    const brandAdjustedPriceTooHigh =
      priceTooHigh / brandPricingToleranceMultiplier(state.player.brandTrust);
    // Softer price rejection — gouging still hurts, fair Plus/Pro still sell
    subscribers *= Math.max(
      0.14,
      Math.pow(Math.max(0.08, 1 - brandAdjustedPriceTooHigh), 1.3),
    );
    // Closing free: paid take-rate bonus (conversion funnel)
    if (!free && !freePlanOn) subscribers *= 1.35;
    const dailyAllowance = effectiveAllowanceMTok / ECONOMY.daysPerMonth;
    const effortByModelId = Object.fromEntries(
      modelMix.map((lane) => [
        lane.model.id,
        planEffortMix({
          model: lane.model,
          kind: commercialModelKind(lane.model),
          recipes: planEnabledEffortRecipes(plan, lane.model),
        }),
      ]),
    );
    const planBilledTokenMultiplier =
      modelMix.length > 0
        ? modelMix.reduce(
            (sum, lane) =>
              sum +
              lane.share *
                (effortByModelId[lane.model.id]?.billedTokenMultiplier ?? 1),
            0,
          )
        : 1;
    let basePerUser = Math.min(
      dailyAllowance / Math.max(1, planBilledTokenMultiplier),
      liftMarketTokenDemand(
        planActualMTokPerUser(
          plan,
          ECONOMY.basePlanUsageMTokPerDay,
          usageRate,
          effectiveAllowanceMTok,
        ) *
          qualityEngagement *
          (1 +
            Math.max(0, planDemandShockMultiplier(plan, state.day) - 1) *
              0.15),
      ),
    );
    if (free && priorPain > 0.08) basePerUser *= painDemandDamp;
    const perUser = basePerUser * planBilledTokenMultiplier;
    const baseRawMTok = subscribers * basePerUser;
    const rawMTok = subscribers * perUser;
    const demandPf = modelMix.reduce(
      (sum, item) =>
        sum +
        baseRawMTok *
          item.share *
          (effortByModelId[item.model.id]?.computeTokenMultiplier ?? 1) *
          pfPerMTokForModel(item.model, serveEff),
      0,
    );
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
        allowanceMTokPerMonth: effectiveAllowanceMTok,
      },
    );
    const readiness = planPremiumReadiness({
      pricePerMonth: plan.pricePerMonth,
      brandTrust: state.player.brandTrust,
      modelCapability: cap,
      frontierCapability: frontierCap,
      modelReliability: planModel?.quality.reliability ?? 50,
    });
    return {
      plan,
      subscribers,
      planMax,
      rawMTok,
      usageRate,
      valueRatio,
      readiness,
      frontierProximity: sota,
      model: planModel,
      modelMix,
      effortByModelId,
      demandPf,
      priceTooHigh,
      perUser,
      basePerUser,
      cap,
      effectiveAllowanceMTok,
      subsidyGbp,
    };
  });

  // Allowance-constrained seats climb when the next tier's value is decent.
  applyPlanUptierMigration(rawBuckets);

  // Keep meaningful high-usage cohorts on valuable Pro/Max-style tiers. The
  // cohort floor is earned by a real allowance step and acceptable value.
  applyHighUsagePlanCohorts(rawBuckets);

  // Soft paid pyramid (cheap > mid > expensive), then free leads every paid SKU.
  enforcePlanSubscriberPyramid(rawBuckets);
  if (freeIdx >= 0 && rawBuckets[freeIdx]) {
    const largestPaid = rawBuckets.reduce(
      (largest, bucket) =>
        isFreePlan(bucket.plan)
          ? largest
          : Math.max(largest, bucket.subscribers),
      0,
    );
    const profile = freeTierDemandProfile(
      rawBuckets[freeIdx]!.plan,
      freePlanRankOpts(rawBuckets[freeIdx]!.plan),
    );
    rawBuckets[freeIdx]!.subscribers = Math.max(
      rawBuckets[freeIdx]!.subscribers,
      largestPaid * profile.paidPopularityLead,
    );
  }

  // Plan-seat stickiness: blend yesterday's seats with today's target.
  for (const bucket of rawBuckets) {
    const prior = state.lastMarket.planStats.find(
      (stat) => stat.planId === bucket.plan.id,
    )?.subscribers;
    bucket.subscribers = blendPlanSeatStickiness(bucket.subscribers, prior);
  }

  const buckets: PlanBucket[] = rawBuckets.map((b) => {
    // Enrollment caps and pause-new are applied only after demand shaping,
    // plan migration, pyramid rules, and seat stickiness. A lowered cap does
    // not evict existing seats in one tick: the prior enrolled cohort is
    // grandfathered until natural demand/churn moves it below the cap. Pause-
    // new freezes at that retained cohort so refused signups never hit the
    // serving ledger.
    const demandSubscribers = Math.max(0, b.subscribers);
    const configuredCap =
      Number.isFinite(b.plan.subscriberCap) && (b.plan.subscriberCap ?? 0) > 0
        ? Math.max(1, Math.floor(b.plan.subscriberCap!))
        : undefined;
    const priorSubscribers =
      state.lastMarket.planStats.find((stat) => stat.planId === b.plan.id)
        ?.subscribers ?? 0;
    const acceptingNew = isPlanAcceptingNew(state.player.pricing, b.plan);
    let maxAdmitted = demandSubscribers;
    if (configuredCap != null) {
      maxAdmitted = Math.min(
        maxAdmitted,
        Math.max(configuredCap, Math.max(0, priorSubscribers)),
      );
    }
    if (!acceptingNew) {
      maxAdmitted = Math.min(maxAdmitted, Math.max(0, priorSubscribers));
    }
    const subscribers = maxAdmitted;
    const grandfatheredSubscribers =
      configuredCap == null
        ? 0
        : Math.max(
            0,
            subscribers - Math.min(demandSubscribers, configuredCap),
          );
    const baseRawMTok = subscribers * b.basePerUser;
    const rawMTok = subscribers * b.perUser;
    const demandPf = b.modelMix.reduce(
      (sum, item) =>
        sum +
        baseRawMTok *
          item.share *
          (b.effortByModelId[item.model.id]?.computeTokenMultiplier ?? 1) *
          pfPerMTokForModel(item.model, serveEff),
      0,
    );
    const allowanceMTokMonth = planAllowanceMTokPerMonth(b.plan);
    const apiEquivalentValue = planApiEquivalentValue(
      b.plan,
      playerApiBlend,
      b.usageRate,
    );
    const subsidyRatio = planSubsidyRatio(b.plan, playerApiBlend, b.usageRate);
    return {
      plan: b.plan,
      demandSubscribers,
      grandfatheredSubscribers,
      subscribers,
      maxSeats: b.planMax,
      baseRawMTok,
      rawMTok,
      usageRate: b.usageRate,
      model: b.model,
      modelMix: b.modelMix,
      effortByModelId: b.effortByModelId,
      demandPf,
      priceTooHigh: b.priceTooHigh,
      allowanceMTokMonth,
      apiEquivalentValue,
      subsidyRatio,
    };
  });

  const playerApiBucketsRaw = [...demandByOffer.values()].flatMap((demand) => {
    if (demand.offer.labId !== "player" || demand.apiMTok <= 0) return [];
    if (demand.offer.routerId) {
      const router = normalizeModelRouters(state.player.modelRouters).find(
        (entry) => entry.id === demand.offer.routerId,
      );
      if (!router) return [];
      const parts = collapseRouterShares(
        apiRouterParts(router, state.player.models, demand.offer.apiPrice),
      );
      const members = parts.flatMap((part) => {
        const model = state.player.models.find(
          (candidate) => candidate.id === part.model.id && isPublic(candidate),
        );
        if (!model) return [];
        const precision =
          state.player.pricing.apiServePrecisionByModel?.[model.id];
        const serveModel = modelForServePrecision(
          model,
          precision,
          state.player.researchUnlocked,
        );
        return [
          {
            partShare: part.share,
            model,
            serveModel,
            precision,
            kind: commercialModelKind(model),
            ...modelApiInOut(state, model.id),
          },
        ];
      });
      const ratioToPeer =
        demand.apiBaseMTok > 1e-12
          ? demand.apiRatioWeightedMTok / demand.apiBaseMTok
          : 1;
      const priceElasticity =
        demand.apiBaseMTok > 1e-12
          ? demand.apiElasticityWeightedMTok / demand.apiBaseMTok
          : DEFAULT_API_PRICE_ELASTICITY;
      const resolved = routedApiEffortChoices({
        members,
        ratioToPeer,
        priceElasticity,
      }).map((member) => {
        const baseDemandMTok = demand.apiBaseMTok * member.partShare;
        return {
          model: member.model,
          serveModel: member.serveModel,
          precision: member.precision,
          demandMTok:
            baseDemandMTok * member.effort.billedTokenMultiplier,
          baseDemandMTok,
          generatedTokenMultiplier:
            member.effort.generatedTokenMultiplier,
          computeDemandMTok:
            baseDemandMTok * member.effort.computeTokenMultiplier,
        };
      });
      demand.apiMTok = resolved.reduce(
        (sum, member) => sum + member.demandMTok,
        0,
      );
      demand.apiGeneratedMTok = resolved.reduce(
        (sum, member) =>
          sum +
          member.baseDemandMTok * member.generatedTokenMultiplier,
        0,
      );
      demand.apiComputeMTok = resolved.reduce(
        (sum, member) => sum + member.computeDemandMTok,
        0,
      );
      return resolved;
    }
    const model = state.player.models.find(
      (candidate) => candidate.id === demand.offer.modelId,
    );
    if (!model) return [];
    const precision = state.player.pricing.apiServePrecisionByModel?.[model.id];
    const serveModel = modelForServePrecision(
      model,
      precision,
      state.player.researchUnlocked,
    );
    return [
      {
        model,
        serveModel,
        precision,
        demandMTok: demand.apiMTok,
        baseDemandMTok: demand.apiBaseMTok,
        generatedTokenMultiplier:
          demand.apiBaseMTok > 1e-12
            ? demand.apiGeneratedMTok / demand.apiBaseMTok
            : 1,
        computeDemandMTok: demand.apiComputeMTok,
      },
    ];
  });
  const concretePlayerApiMTok = playerApiBucketsRaw.reduce(
    (sum, bucket) => sum + bucket.demandMTok,
    0,
  );
  totalDemandMTok += concretePlayerApiMTok - playerApiMTok;
  playerApiMTok = concretePlayerApiMTok;
  // Trickle-down: with the API channel saturated, half of each endpoint's
  // unserved demand retries on the lab's OTHER listed models — cheaper models
  // (more MTok per PF) catch more of the overflow. Capacity still binds in
  // the ledger; the served mix tilts toward cheaper models.
  let trickledMTok = 0;
  let overflowMTok = 0;
  const playerApiBuckets = (() => {
    if (playerApiBucketsRaw.length < 2) return playerApiBucketsRaw;
    const rates = playerApiBucketsRaw.map((bucket) => ({
      bucket,
      pfPerMTok: Math.max(
        1e-12,
        pfPerMTokForModel(bucket.serveModel, serveEff) *
          (bucket.computeDemandMTok / Math.max(1e-12, bucket.demandMTok)),
      ),
    }));
    const totalPf = rates.reduce(
      (sum, item) => sum + item.bucket.demandMTok * item.pfPerMTok,
      0,
    );
    const saturation =
      totalPf > 1e-9 ? Math.max(0, 1 - apiPoolPf / totalPf) : 0;
    if (saturation <= 0.02) return playerApiBucketsRaw;
    const moved = rates.map(
      (item) => item.bucket.demandMTok * saturation * 0.5,
    );
    const totalMoved = moved.reduce((sum, m) => sum + m, 0);
    trickledMTok = totalMoved;
    // The un-trickled half of unserved demand has nowhere to go today.
    overflowMTok = totalMoved;
    return rates.map((item, i) => {
      let gain = 0;
      for (let j = 0; j < rates.length; j++) {
        if (j === i) continue;
        const wTotal = rates.reduce(
          (sum, r, k) => (k === j ? sum : sum + 1 / r.pfPerMTok),
          0,
        );
        gain += (moved[j]! * (1 / item.pfPerMTok)) / Math.max(1e-12, wTotal);
      }
      const demandMTok = item.bucket.demandMTok - moved[i]! + gain;
      const demandScale =
        item.bucket.demandMTok > 1e-12
          ? demandMTok / item.bucket.demandMTok
          : 1;
      return {
        ...item.bucket,
        demandMTok,
        baseDemandMTok: item.bucket.baseDemandMTok * demandScale,
        computeDemandMTok: item.bucket.computeDemandMTok * demandScale,
      };
    });
  })();
  const planDemandMTok = buckets.reduce((s, b) => s + b.rawMTok, 0);
  const apiDemandPf = playerApiBuckets.reduce(
    (sum, bucket) =>
      sum +
      bucket.computeDemandMTok *
        pfPerMTokForModel(bucket.serveModel, serveEff),
    0,
  );
  const planDemandPf = buckets.reduce(
    (sum, bucket) => sum + bucket.demandPf,
    0,
  );
  const demandPf = apiDemandPf + planDemandPf;
  const playerDemandMTok = playerApiMTok + planDemandMTok;

  const apiLedgerItems = playerApiBuckets.map((bucket, index) => ({
    id: `api:${index}`,
    channel: "api",
    requestedUnits: bucket.demandMTok,
    requestedWorkPfDays:
      bucket.computeDemandMTok *
      pfPerMTokForModel(bucket.serveModel, serveEff),
    priority: 70,
  }));
  const planLedgerItems = buckets.flatMap((bucket) =>
    bucket.modelMix.map((lane) => {
      const effort = bucket.effortByModelId[lane.model.id];
      const baseRequestedMTok = bucket.baseRawMTok * lane.share;
      const requestedUnits =
        baseRequestedMTok * (effort?.billedTokenMultiplier ?? 1);
      const requestedWorkPfDays =
        baseRequestedMTok *
        (effort?.computeTokenMultiplier ?? 1) *
        pfPerMTokForModel(lane.model, serveEff);
      return {
        id: `plan:${bucket.plan.id}:${lane.model.id}`,
        channel: "subscription",
        requestedUnits,
        requestedWorkPfDays,
        // Lane priorities sum to the plan priority, preserving the old
        // inter-plan policy while letting each native model settle separately.
        priority: Math.max(1, planComputePriority(bucket.plan) * lane.share),
      };
    }),
  );
  const computeWorkMeta = new Map<
    string,
    {
      channel: "api" | "subscription";
      model: Model;
      apiIndex?: number;
      planId?: string;
      baseRequestedMTok?: number;
      generatedTokenMultiplier?: number;
      billedTokenMultiplier?: number;
    }
  >();
  playerApiBuckets.forEach((bucket, index) => {
    computeWorkMeta.set(`api:${index}`, {
      channel: "api",
      model: bucket.model,
      apiIndex: index,
    });
  });
  for (const bucket of buckets) {
    for (const lane of bucket.modelMix) {
      const effort = bucket.effortByModelId[lane.model.id];
      computeWorkMeta.set(`plan:${bucket.plan.id}:${lane.model.id}`, {
        channel: "subscription",
        model: lane.model,
        planId: bucket.plan.id,
        baseRequestedMTok: bucket.baseRawMTok * lane.share,
        generatedTokenMultiplier: effort?.generatedTokenMultiplier ?? 1,
        billedTokenMultiplier: effort?.billedTokenMultiplier ?? 1,
      });
    }
  }
  const computeLedger = settleComputeLedger(
    [...apiLedgerItems, ...planLedgerItems],
    {
      capacityPfDays: capacityPf,
      reservations: { api: apiPrio, subscription: 1 - apiPrio },
    },
  );
  const apiRows = computeLedger.rows.filter((row) => row.channel === "api");
  const planServeFractions = new Map(
    buckets.map((bucket) => [
      bucket.plan.id,
      (() => {
        const rows = computeLedger.rows.filter(
          (row) => computeWorkMeta.get(row.id)?.planId === bucket.plan.id,
        );
        const requested = rows.reduce(
          (sum, row) => sum + row.requestedUnits,
          0,
        );
        const served = rows.reduce((sum, row) => sum + row.servedUnits, 0);
        return requested > 1e-12 ? served / requested : 1;
      })(),
    ]),
  );
  const apiAdmittedMTok = apiRows.reduce(
    (sum, row) => sum + row.servedUnits,
    0,
  );
  const serveFracApi =
    playerApiMTok > 1e-9 ? apiAdmittedMTok / playerApiMTok : 1;
  const subServedDemandMTok = computeLedger.rows
    .filter((row) => row.channel === "subscription")
    .reduce((sum, row) => sum + row.servedUnits, 0);
  const serveFracSub =
    planDemandMTok > 1e-9
      ? Math.max(0, Math.min(1, subServedDemandMTok / planDemandMTok))
      : 1;
  const unservedRatio = computeLedger.unservedRatio;
  const serveFrac =
    playerDemandMTok > 1e-9
      ? (playerApiMTok * serveFracApi + planDemandMTok * serveFracSub) /
        playerDemandMTok
      : 1;
  const servedMTok = computeLedger.servedUnits;
  const capacitySalesCapped = false;

  // Throttle policy: shed rejects excess demand (full pain/churn); throttle
  // slows streams instead (per-channel strain EMA, muted pain/churn);
  // balanced mixes. Each channel's strain tracks ITS serve fraction, so the
  // API/sub split visibly moves speed between channels.
  const throttlePolicy = state.player.pricing.serveThrottlePolicy ?? "balanced";
  const servePolicyControls = serveControls(state.player.pricing);
  const absorbShare = configuredAbsorbShare(
    state.player.pricing,
    unservedRatio,
  );
  const prevApiStrain =
    state.player.apiSpeedStrain ?? state.player.speedStrain ?? 0;
  const prevSubStrain =
    state.player.subSpeedStrain ?? state.player.speedStrain ?? 0;
  const apiSpeedStrain = nextSpeedStrain(
    prevApiStrain,
    1 - serveFracApi,
    absorbShare,
  );
  const subSpeedStrain = nextSpeedStrain(
    prevSubStrain,
    1 - serveFracSub,
    absorbShare,
  );
  const speedStrain = Math.max(apiSpeedStrain, subSpeedStrain);
  const apiSurgeLevel = nextSurgeLevel(
    state.player.apiSurgeLevel ?? 0,
    1 - serveFracApi,
    throttlePolicy,
    servePolicyControls.peakPricingPct,
    servePolicyControls.slowdownLimit,
  );
  const apiSurgeMultiplier = surgePriceMultiplier(
    apiSurgeLevel,
    servePolicyControls.peakPricingPct,
  );
  const servicePain = nextServicePain(
    priorPain,
    unservedRatio * throttlePainScale(absorbShare),
  );
  const churnScale = throttleChurnScale(absorbShare);
  const effectiveLatencyScore = playerServiceLatencyScore(state, {
    unservedRatio,
    servicePain,
  });
  const baseChurn =
    (unservedRatio <= 0.03
      ? servicePain * 0.04
      : Math.min(
          0.55,
          unservedRatio * 0.22 +
            servicePain * 0.28 +
            (unservedRatio > 0.5 ? 0.08 : 0),
        )) * churnScale;
  // Channel-specific churn: starved product loses users faster
  const churnFrac = baseChurn;

  // Channel loads: demand against each channel's reserved token capacity.
  // >1 means overloaded (backfill may still mask it in the ledger when the
  // other channel is quiet — load is the honest signal).
  const apiLoad =
    capacityMTok * apiPrio > 1e-9
      ? playerApiMTok / (capacityMTok * apiPrio)
      : playerApiMTok > 1e-9
        ? 99
        : 0;
  const subLoad =
    capacityMTok * (1 - apiPrio) > 1e-9
      ? planDemandMTok / (capacityMTok * (1 - apiPrio))
      : planDemandMTok > 1e-9
        ? 99
        : 0;

  // ── Money: revenue = prices only; costs = real ops (not list COGS) ──
  // Pay grid $/MWh only on *imports*; on-site gen is covered by plant opex
  // City power contracts cover firm MW at locked rates; rest is spot
  const power = resolvePlayerPowerMw(state, snap.mwDemand);
  const gridMw = Math.max(0, power.mwGridImport);
  const importBill = powerImportBill(state, gridMw);
  const generationUsedMw = Math.min(snap.mwDemand, power.mwGeneration);
  const energyCostDay =
    importBill.totalCostDay +
    onsiteGenerationUpkeepDay(generationUsedMw, state.map.energyPricePerMWh);
  const buildingOpex = playerBuildingOpex(state);
  // Surplus generation sold to cities / grid (Fleet → Power)
  const powerExportRev = powerExportDayRevenue(state);
  let rackCapital = 0;
  for (const r of state.player.rackFleet ?? []) {
    if (r.status === "live") rackCapital += r.paidEach * r.count;
  }
  const chipAmort = rackCapital / ECONOMY.chipAmortDays;
  const denomMTok = Math.max(servedMTok, 0.0001);
  const opsServeShare = Math.max(0.08, state.player.allocation.inference);
  const leaseIn = state.player.computeLeaseIncomeToday ?? 0;
  const leaseOut = state.player.computeLeaseCostToday ?? 0;
  const attributedServeOps = attributedServingFixedCost({
    energyCostDay,
    chipAmortDay: chipAmort,
    buildingOpexDay: buildingOpex,
    computeLeaseCostDay: leaseOut,
    inferenceShare: opsServeShare,
  });
  const marginalPerMTok =
    attributedServeOps / denomMTok + ECONOMY.bandwidthPerMTok;

  const apiModelSettlement = playerApiBuckets.map((bucket, index) => {
    const row = computeLedger.rows.find((item) => item.id === `api:${index}`);
    const dayMTok = row?.servedUnits ?? 0;
    const servedFraction =
      bucket.demandMTok > 1e-12 ? dayMTok / bucket.demandMTok : 0;
    const dayBaseMTok = bucket.baseDemandMTok * servedFraction;
    const dayInferPf = row?.servedWorkPfDays ?? 0;
    const { priceIn, priceOut } = modelApiInOut(state, bucket.model.id);
    const surge = postedApiSurgeMultiplier(state);
    const productKind = commercialModelKind(bucket.model);
    return {
      model: bucket.model,
      precision: bucket.precision,
      dayMTok,
      dayBaseMTok,
      generatedTokenMultiplier: bucket.generatedTokenMultiplier,
      dayInferPf,
      dayRevenue: apiRevenueForCommercialWork(
        productKind,
        dayBaseMTok,
        priceIn * surge,
        priceOut * surge,
        {
          perImage: bucket.model.apiPricePerImage,
          perAudioMinute: bucket.model.apiPricePerAudioMinute,
          perVideoSecond: bucket.model.apiPricePerVideoSecond,
        },
        bucket.generatedTokenMultiplier,
      ),
    };
  });
  const apiServed = apiModelSettlement.reduce(
    (sum, item) => sum + item.dayMTok,
    0,
  );
  const apiRevenue = apiModelSettlement.reduce(
    (sum, item) => sum + item.dayRevenue,
    0,
  );
  const apiInferPf = apiModelSettlement.reduce(
    (sum, item) => sum + item.dayInferPf,
    0,
  );

  let blockedSubscriptionSeats = 0;
  let capBlockedSubscriptionSeats = 0;
  let pausedNewSubscriptionSeats = 0;
  const rawPlanStats = buckets.map((b) => {
    const free = isFreePlan(b.plan);
    const planServeFrac = planServeFractions.get(b.plan.id) ?? 1;
    const planSubChurnFrac = Math.min(
      0.68,
      baseChurn * 0.9 + (1 - planServeFrac) * (free ? 0.48 : 0.4),
    );
    const retainedAfterChurn =
      b.subscribers *
      Math.max(0.08, 1 - planSubChurnFrac * (free ? 0.75 : 1.05));
    const kept = retainedAfterChurn;
    blockedSubscriptionSeats += retainedAfterChurn * (1 - planServeFrac);
    capBlockedSubscriptionSeats += Math.max(0, b.demandSubscribers - b.subscribers);
    if (!isPlanAcceptingNew(state.player.pricing, b.plan)) {
      pausedNewSubscriptionSeats += Math.max(
        0,
        b.demandSubscribers - b.subscribers,
      );
    }
    const planRows = computeLedger.rows.filter(
      (row) => computeWorkMeta.get(row.id)?.planId === b.plan.id,
    );
    const dayMTok = planRows.reduce((sum, row) => sum + row.servedUnits, 0);
    const modelUsage = b.modelMix.map((item) => {
      const row = planRows.find(
        (candidate) =>
          computeWorkMeta.get(candidate.id)?.model.id === item.model.id,
      );
      const modelMTok = row?.servedUnits ?? 0;
      const modelPf = row?.servedWorkPfDays ?? 0;
      return {
        modelId: item.model.id,
        name: item.model.name,
        dayMTok: modelMTok,
        dayInferPf: modelPf,
        share: dayMTok > 1e-12 ? modelMTok / dayMTok : item.share,
        costPerMTok: 0,
      };
    });
    const dayInferPf = modelUsage.reduce(
      (sum, usage) => sum + usage.dayInferPf,
      0,
    );
    // Subscription revenue accrues by seat; material outages issue automatic
    // service credits instead of pretending every token is usage-billed.
    const serviceCredit = planServeFrac >= 0.97 ? 1 : 0.5 + 0.5 * planServeFrac;
    const dayRevenue = free
      ? 0
      : (kept * b.plan.pricePerMonth * serviceCredit) / ECONOMY.daysPerMonth;
    return {
      planId: b.plan.id,
      name: b.plan.name,
      demandSubscribers: b.demandSubscribers,
      configuredSubscriberCap:
        Number.isFinite(b.plan.subscriberCap) && (b.plan.subscriberCap ?? 0) > 0
          ? Math.max(1, Math.floor(b.plan.subscriberCap!))
          : undefined,
      grandfatheredSubscribers: b.grandfatheredSubscribers,
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
      allowanceDissatisfaction: planAllowanceExpectation(
        b.plan,
        b.allowanceMTokMonth,
        {
          tokensPerInteraction: b.model
            ? avgTokensPerInteraction(commercialModelKind(b.model))
            : undefined,
          valueRatio: planAdvertisedValueRatio(
            b.plan,
            playerApiBlend,
            b.allowanceMTokMonth,
          ),
          rivalValueRatio: rivalNearestValueRatio(
            state,
            b.plan.pricePerMonth,
            playerApiBlend,
          ),
        },
      ).dissatisfaction,
    };
  });

  // Fixed serving operations are scarce-compute costs. Allocate them by actual
  // inference PF, not by raw token count: a plan routing to a larger/slower model
  // must carry more cost even when it serves the same number of tokens.
  const totalAllocatedInferPf =
    apiInferPf + rawPlanStats.reduce((sum, plan) => sum + plan.dayInferPf, 0);
  const fixedCostForPf = (pf: number) =>
    totalAllocatedInferPf > 1e-9
      ? (attributedServeOps * Math.max(0, pf)) / totalAllocatedInferPf
      : 0;
  const apiCogs =
    fixedCostForPf(apiInferPf) + apiServed * ECONOMY.bandwidthPerMTok;
  const normalizedDirectApiCostPerMTok =
    attributedServeOps / Math.max(capacityMTok, 0.0001) +
    ECONOMY.bandwidthPerMTok;
  const apiDirectCogs = Math.min(
    apiCogs,
    apiServed * normalizedDirectApiCostPerMTok,
  );
  const apiAllocatedOps = Math.max(0, apiCogs - apiDirectCogs);
  const apiCapacityUtilization = Math.max(
    0,
    Math.min(1, apiServed / Math.max(capacityMTok, 0.0001)),
  );
  const apiModelUsage = apiModelSettlement.map((item) => {
    const modelCost =
      fixedCostForPf(item.dayInferPf) + item.dayMTok * ECONOMY.bandwidthPerMTok;
    return {
      modelId: item.model.id,
      name: item.model.name,
      dayMTok: item.dayMTok,
      dayInferPf: item.dayInferPf,
      share: apiServed > 1e-9 ? item.dayMTok / apiServed : 0,
      costPerMTok: item.dayMTok > 1e-9 ? modelCost / item.dayMTok : 0,
    };
  });
  const planStats: PlanDayStats[] = rawPlanStats.map((plan) => {
    const allocatedComputeCostDay = fixedCostForPf(plan.dayInferPf);
    const bandwidthCostDay = plan.dayMTok * ECONOMY.bandwidthPerMTok;
    const dayCogs = allocatedComputeCostDay + bandwidthCostDay;
    const costPerSubDay = plan.subscribers > 0 ? dayCogs / plan.subscribers : 0;
    const marginPerSubMonth = plan.isFree
      ? -costPerSubDay * ECONOMY.daysPerMonth
      : plan.subscribers > 0
        ? (plan.dayRevenue * ECONOMY.daysPerMonth) / plan.subscribers -
          costPerSubDay * ECONOMY.daysPerMonth
        : 0;
    const configuredPlan = enabledPlans.find(
      (candidate) => candidate.id === plan.planId,
    );
    const stabilityDissatisfaction = planStabilityDissatisfaction(
      plan.isFree,
      marginPerSubMonth,
      configuredPlan?.pricePerMonth ?? 0,
    );
    const allowanceDissatisfaction = plan.allowanceDissatisfaction ?? 0;
    const slownessDissatisfaction = planSlownessDissatisfaction(
      subSpeedStrain,
      plan.isFree,
      weightedPlayerOfferTokPerSec(offers, plan.modelUsage, "subscription"),
    );
    const operationalDissatisfaction = Math.min(
      1,
      1 -
        (1 - allowanceDissatisfaction) *
          (1 - stabilityDissatisfaction) *
          (1 - slownessDissatisfaction),
    );
    // Trusted brands retain a little more patience through ordinary pricing
    // and latency variance; weak brands lose the same cohort sooner.
    const brandDissatisfaction = Math.max(
      0,
      Math.min(0.3, (55 - state.player.brandTrust) / 120),
    );
    const dissatisfaction = Math.min(
      1,
      1 - (1 - operationalDissatisfaction) * (1 - brandDissatisfaction),
    );
    const modelUsage = plan.modelUsage.map((usage) => {
      const modelCost =
        fixedCostForPf(usage.dayInferPf) +
        usage.dayMTok * ECONOMY.bandwidthPerMTok;
      return {
        ...usage,
        costPerMTok: usage.dayMTok > 1e-9 ? modelCost / usage.dayMTok : 0,
      };
    });
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
      slownessDissatisfaction,
      dissatisfaction,
    };
  });

  const subRevenue = planStats.reduce((s, p) => s + p.dayRevenue, 0);
  const subCogs = planStats.reduce((s, p) => s + p.dayCogs, 0);
  const totalSubUsers = planStats.reduce((s, p) => s + p.subscribers, 0);
  const servedPf =
    apiInferPf + planStats.reduce((sum, plan) => sum + plan.dayInferPf, 0);
  // Public-model hosting stack: endpoint replicas, standing KV pool and the
  // load-following infra behind today's served compute. Charged in marketOpsOut.
  const hostingOpex = hostedModelOpexDay(state, servedPf);

  const reconciledWorkItems: SimComputeWorkItem[] = computeLedger.rows.map(
    (row) => {
      const meta = computeWorkMeta.get(row.id);
      const apiIndex = meta?.apiIndex ?? -1;
      const planId = meta?.planId;
      const apiSettlement =
        apiIndex >= 0 ? apiModelSettlement[apiIndex] : undefined;
      const apiBucket = apiIndex >= 0 ? playerApiBuckets[apiIndex] : undefined;
      const apiUsage = apiIndex >= 0 ? apiModelUsage[apiIndex] : undefined;
      const planSettlement = planId
        ? planStats.find((plan) => plan.planId === planId)
        : undefined;
      const planUsage = planSettlement?.modelUsage?.find(
        (usage) => usage.modelId === meta?.model.id,
      );
      const planRevenueShare =
        planSettlement && planSettlement.dayMTok > 1e-12
          ? (planUsage?.dayMTok ?? 0) / planSettlement.dayMTok
          : 0;
      const directCogs = apiSettlement
        ? (apiUsage?.costPerMTok ?? 0) * apiSettlement.dayMTok
        : (planUsage?.costPerMTok ?? 0) * (planUsage?.dayMTok ?? 0);
      const productKind = meta?.model
        ? commercialModelKind(meta.model)
        : "language";
      const channel =
        meta?.channel ?? (row.channel === "api" ? "api" : "subscription");
      const nativeWork = (units: number) =>
        apiBucket
          ? nativeWorkFromEquivalentMTokAtEffort(
              productKind,
              apiBucket.baseDemandMTok *
                (units / Math.max(1e-12, apiBucket.demandMTok)),
              apiBucket.generatedTokenMultiplier,
            )
          : meta?.baseRequestedMTok != null
            ? nativeWorkFromEquivalentMTokAtEffort(
                productKind,
                meta.baseRequestedMTok *
                  (units /
                    Math.max(
                      1e-12,
                      meta.baseRequestedMTok *
                        (meta.billedTokenMultiplier ?? 1),
                    )),
                meta.generatedTokenMultiplier ?? 1,
              )
          : nativeWorkFromEquivalentMTok(productKind, units);
      return {
        id: `${state.day}:${row.id}`,
        labId: state.playerLabId,
        channel,
        kind: computeWorkKindForProduct(channel, productKind),
        modelId: meta?.model.id ?? apiSettlement?.model.id,
        planId,
        requested: nativeWork(row.requestedUnits),
        admitted: nativeWork(row.admittedUnits),
        served: nativeWork(row.servedUnits),
        billed: nativeWork(row.billedUnits),
        requestedPfDays: row.requestedWorkPfDays,
        servedPfDays: row.servedWorkPfDays,
        revenue:
          apiSettlement?.dayRevenue ??
          (planSettlement?.dayRevenue ?? 0) * planRevenueShare,
        directCogs,
        ...(row.admitFraction < 0.999999
          ? { rejectedReason: "capacity" as const }
          : {}),
      };
    },
  );
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
  };

  // Enterprise peels off when SLA is bad
  let enterpriseContracts = state.player.enterpriseContracts;
  if (servicePain > 0.25 && enterpriseContracts > 0) {
    const lose =
      servicePain > 0.55 ? 1 : servicePain > 0.4 && state.day % 3 === 0 ? 1 : 0;
    enterpriseContracts = Math.max(0, enterpriseContracts - lose);
  }
  // Annuity only (no signing lump in tickOrg) + soft enterprise-segment ARPU
  const softArpu = ECONOMY.enterpriseSoftArpu ?? 0.008;
  const enterpriseRevenueBeforeCapacity =
    ((enterpriseContracts * ECONOMY.enterpriseContractValue) /
      ECONOMY.daysPerMonth) *
      (1 + state.player.pricing.enterpriseContractBonus * 0.12) +
    enterpriseWeight * softArpu * serveFrac * Math.max(0.25, 1 - churnFrac);
  const enterpriseServiceCredit = serveFrac >= 0.97 ? 1 : 0.5 + 0.5 * serveFrac;
  const enterpriseRevenue =
    enterpriseRevenueBeforeCapacity * enterpriseServiceCredit;
  const capacityProductRevenueCeiling =
    apiRevenue + subRevenue + enterpriseRevenue;

  // Staff wages (HQ employees) — replaces legacy talent×base wage
  const wage = staffWagePerDay(state);
  const mkt = state.player.marketingSpendPerDay;
  // Money in: list prices. Money out: real ops only.
  // Chip amort is book (non-cash) — capex was paid at purchase; do not cash-deduct again.
  // Ledger categories (data/train/research/hiring) were already deducted from cash
  // earlier today; include them in P&L / runway but not in the cash delta below.
  const prevFinance = state.player.finance;
  const dayDataCost = prevFinance.dayDataCost ?? 0;
  const dayTrainingCost = prevFinance.dayTrainingCost ?? 0;
  const dayResearchCost = prevFinance.dayResearchCost ?? 0;
  const dayHiringCost = prevFinance.dayHiringCost ?? 0;
  const dayCapexCost = prevFinance.dayCapexCost ?? 0;
  const ledgerOut =
    dayDataCost +
    dayTrainingCost +
    dayResearchCost +
    dayHiringCost +
    dayCapexCost;
  const dayRevenue =
    (apiRevenue + subRevenue + enterpriseRevenue) *
      activeBalanceTuning().incomeMult +
    powerExportRev +
    leaseIn;
  const productCogs = apiCogs + subCogs; // attributed serve ops for margin views
  const marketOpsOut =
    (energyCostDay + wage + buildingOpex) * activeBalanceTuning().expenseMult +
    hostingOpex.totalDay +
    mkt +
    leaseOut;
  const dayTotalOut = marketOpsOut + ledgerOut;
  const net = dayRevenue - dayTotalOut;
  const dayGrossProfit = dayRevenue - productCogs;

  const marginPerSubMonthly =
    totalSubUsers > 0
      ? (subRevenue * ECONOMY.daysPerMonth - subCogs * ECONOMY.daysPerMonth) /
        totalSubUsers
      : 0;
  const marginPerMTok = apiServed > 0 ? (apiRevenue - apiCogs) / apiServed : 0;

  let brand = state.player.brandTrust;
  // Operational brand only (capacity, quant, campus). Campaign brandGain is
  // applied once later by applyDailyMarketing in tickOrg — do not add it here.
  // Capacity pain only when actually short — no brand death with spare headroom
  if (unservedRatio > 0.08) {
    const hit =
      unservedRatio * 1.5 +
      (unservedRatio > 0.35 ? servicePain * 1.1 : servicePain * 0.35) +
      (unservedRatio > 0.5 ? 0.6 : 0);
    brand = Math.max(8, brand - hit);
  } else if (servicePain > 0.2 && unservedRatio <= 0.05) {
    // Residual pain fades without hard brand slash
    brand = Math.max(8, brand - servicePain * 0.08);
  }
  const model = bestPlayerModel(state);
  if (model && model.quality.reliability < 35)
    brand = Math.max(8, brand - 0.15);
  // Early millions-param models sit ~5–10; only below that is a sustained flop.
  if (model && model.capability < 5) brand = Math.max(8, brand - 0.1);
  if (playerPricingComplaintPressure > 0.2) {
    brand = Math.max(8, brand - (playerPricingComplaintPressure - 0.2) * 0.35);
  }
  // Interactive streams below ~15 tok/s feel broken even when tokens arrive.
  // Small, traffic-weighted brand pressure — never a speed-only death spiral.
  for (const demand of demandByOffer.values()) {
    if (demand.offer.labId !== "player") continue;
    const traffic = demand.apiMTok + demand.subscriptionMTok;
    if (traffic < 0.05) continue;
    const tok =
      demand.apiMTok >= demand.subscriptionMTok
        ? (demand.offer.apiTokPerSec ?? demand.offer.tokPerSec)
        : demand.offer.tokPerSec;
    if (tok < TOKEN_SPEED_BRAND_THRESHOLD) {
      const weight = Math.min(1, traffic / Math.max(0.05, playerDemandMTok));
      brand = Math.max(
        8,
        brand - tokenSpeedBrandPressure(tok) * (0.35 + 0.65 * weight),
      );
    }
  }
  brand = Math.max(
    8,
    brand - surgeBrandPressure(postedApiSurgeMultiplier(state)),
  );
  // Quantized traffic exposes the lower eval profile to real customers. INT8
  // is usually tolerable; sustained INT4 on a material product creates a
  // visible trust cost proportional to that plan's share of served traffic.
  for (const stat of planStats) {
    const plan = enabledPlans.find((candidate) => candidate.id === stat.planId);
    if (!plan || stat.dayMTok <= 0) continue;
    const weightedBrandRisk = (stat.modelUsage ?? []).reduce((sum, usage) => {
      const planModel = state.player.models.find(
        (candidate) => candidate.id === usage.modelId,
      );
      if (!planModel) return sum;
      const precision = planModelServePrecision(
        plan,
        planModel,
        state.player.researchUnlocked,
      );
      return (
        sum +
        planServeModifiers(precision, state.player.researchUnlocked).brandRisk *
          usage.share
      );
    }, 0);
    const brandRisk = stat.modelUsage?.length
      ? weightedBrandRisk
      : planServeModifiers(plan.servePrecision, state.player.researchUnlocked)
          .brandRisk;
    const trafficShare = stat.dayMTok / Math.max(0.001, servedMTok);
    if (isFreePlan(plan)) continue;
    brand = Math.max(
      5,
      brand - brandRisk * Math.min(1, trafficShare * 2.5) * 1.15,
    );
  }
  // API customers pay per token and expect the advertised benchmark profile.
  // Quantized endpoints save PF, but sustained eval loss is visible and erodes
  // trust in proportion to that endpoint's real served traffic.
  for (const settlement of apiModelSettlement) {
    if (settlement.dayMTok <= 0) continue;
    const quant = planServeModifiers(
      settlement.precision,
      state.player.researchUnlocked,
    );
    const trafficShare = settlement.dayMTok / Math.max(0.001, servedMTok);
    brand = Math.max(
      5,
      brand - quant.brandRisk * Math.min(1, trafficShare * 2.8) * 1.25,
    );
  }
  // Rebuild trust when capacity covers demand
  if (
    unservedRatio < 0.05 &&
    servicePain < 0.12 &&
    model &&
    model.quality.reliability > 55
  ) {
    brand = Math.min(100, brand + 0.12);
  }
  // Campus polish (office/lab) slowly lifts brand
  if (usesCompactWorld(state)) {
    for (const facility of compactCompletedFacilitiesForOwner(
      state,
      state.playerLabId,
    ) ?? []) {
      if (facility.kind === "office") brand = Math.min(100, brand + 0.02);
      if (facility.kind === "lab") brand = Math.min(100, brand + 0.01);
    }
  } else {
    for (const t of facilityAnchorTiles(state, { ownerId: "player" })) {
      if (t.buildingProgress < t.buildingTarget) continue;
      if (t.kind === "office") brand = Math.min(100, brand + 0.02);
      if (t.kind === "lab") brand = Math.min(100, brand + 0.01);
    }
  }

  // Stingy plans (low mult vs high price) hurt brand slightly if many free users leave
  for (const b of buckets) {
    if (
      b.plan.pricePerMonth > 40 &&
      b.plan.usageMultiplier < 1 &&
      b.subscribers > 1000
    ) {
      brand = Math.max(5, brand - 0.02);
    }
  }

  // ── Shared economy: rivals settle the same capacity and operating inputs ──
  let industryServedMTok = servedMTok;
  const rivals = state.rivals.map((r) => {
    const offerBuckets: OfferDemandBucket[] = [];
    for (const demand of demandByOffer.values()) {
      if (demand.offer.labId !== r.id) continue;
      const wonModel = r.models.find(
        (candidate) => candidate.id === demand.offer.modelId,
      );
      if (!wonModel) continue;
      offerBuckets.push({ ...demand, model: wonModel });
    }
    const physical = computeLabSnapshot(state, r.id);
    const capPf = rivalInferCapacityPf(r, state, physical);
    const rivalSettlement = settleRivalOfferDemand(
      offerBuckets,
      capPf,
      r.servingEfficiency,
      r.servicePain ?? 0,
    );
    const rServe = rivalSettlement.serveFrac;
    const rUnserved = rivalSettlement.unservedRatio;
    const servedRival =
      rivalSettlement.apiServedMTok + rivalSettlement.subscriptionServedMTok;
    const demPf = rivalSettlement.demandPf;
    industryServedMTok += rivalSettlement.capacityServedMTok;

    // The model and price that won each demand bucket are authoritative for
    // serving work and billing; no first-model or fixed API/sub approximation.
    // Compute contracts settle cash before this system and expose accruals so
    // finance includes them exactly once without charging cash a second time.
    const apiRevenueRival = rivalSettlement.apiRevenue;
    const subRevenueRival = rivalSettlement.subscriptionRevenue;
    const productRevenue = apiRevenueRival + subRevenueRival;
    const leaseIn = r.computeLeaseIncomeToday ?? 0;
    const leaseOut = r.computeLeaseCostToday ?? 0;
    const dayRev = productRevenue + leaseIn;

    // Identical operating inputs: physical power, staff wages, completed
    // facilities, and explicit marketing. No abstract compute growth or grants.
    // Long-term utility/PPAs are take-or-pay settled after the market. Their
    // covered MW must not also be bought on spot here.
    const rivalGenerationMw = Math.min(
      physical.powerMw,
      labFacilityEnergyTotals(state, r.id).mwGeneration,
    );
    const energyCost =
      physical.spotPowerMw * 24 * state.map.energyPricePerMWh +
      onsiteGenerationUpkeepDay(rivalGenerationMw, state.map.energyPricePerMWh);
    const wageCost = labStaffWagePerDay(state, r.id);
    const buildingCost = labBuildingOpex(state, r.id);
    const operatingOpex =
      energyCost + wageCost + buildingCost + (r.marketingSpendPerDay ?? 0);
    const dayOpex = operatingOpex + leaseOut;
    const rackCapital = (r.rackFleet ?? []).reduce(
      (sum, rack) =>
        sum + (rack.status === "live" ? rack.paidEach * rack.count : 0),
      0,
    );
    const chipAmort = rackCapital / ECONOMY.chipAmortDays;
    const attributedServeOps = attributedServingFixedCost({
      energyCostDay: energyCost,
      chipAmortDay: chipAmort,
      buildingOpexDay: buildingCost,
      computeLeaseCostDay: leaseOut,
      inferenceShare: Math.max(0.08, r.allocation.inference),
    });
    const rivalProductCogs =
      attributedServeOps + servedRival * ECONOMY.bandwidthPerMTok;
    const rivalApiCogs =
      servedRival > 0
        ? rivalProductCogs * (rivalSettlement.apiServedMTok / servedRival)
        : 0;
    const rivalSubCogs = rivalProductCogs - rivalApiCogs;
    const rivalGrossProfit = dayRev - rivalProductCogs;
    const operatingNet = productRevenue - operatingOpex;
    const rivalNet = operatingNet + leaseIn - leaseOut;
    // Contract cash already moved in tickComputeContracts. Only product and
    // operating settlement remains to be applied here.
    const cash = r.cash + operatingNet;
    const previousFinance = getLab(state, r.id).finance;
    const valuation = Math.max(
      1,
      cash * 1.2 +
        Math.max(0, previousFinance.lifetimeRevenue + dayRev) * 4.5 +
        Math.max(0, rivalGrossProfit) * 120,
    );
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
      dayChipAmortOther: chipAmort * Math.max(0, 1 - r.allocation.inference),
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
      lifetimeProductCogs:
        previousFinance.lifetimeProductCogs + rivalProductCogs,
      peakCash: Math.max(previousFinance.peakCash, cash),
      lowestCash: Math.min(previousFinance.lowestCash, cash),
      runwayDays:
        rivalNet >= 0
          ? Number.POSITIVE_INFINITY
          : cash / Math.max(1, -rivalNet),
      debtOutstanding:
        (r.loans ?? []).reduce((sum, loan) => sum + loan.remaining, 0) +
        (r.capital?.debt ?? []).reduce((sum, debt) => sum + debt.remaining, 0),
    };

    // Brand / pain from overload (same economy as player)
    let brandTrust = r.brandTrust;
    let pain = r.servicePain ?? 0;
    pain = nextServicePain(pain, rUnserved);
    // Rivals run the balanced throttle policy: part of their overload slows
    // streams instead of erroring.
    const strain = nextSpeedStrain(
      r.speedStrain ?? 0,
      rUnserved,
      throttleAbsorbShare("balanced", rUnserved),
    );
    if (rUnserved > 0.1)
      brandTrust = Math.max(12, brandTrust - rUnserved * 1.2);
    else if (pain < 0.1) brandTrust = Math.min(100, brandTrust + 0.04);

    // Capacity-limited share for display (overloaded labs lose weight)
    const rawShare = sharesByLab[r.id] ?? 0;
    const effShare = capacityAdjustedMarketShare(rawShare, rServe);

    return {
      ...r,
      cash,
      brandTrust,
      marketShare: effShare,
      servicePain: pain,
      speedStrain: strain,
      dayRevenue: dayRev,
      finance,
      lastDemandPf: demPf,
      lastCapacityPf: capPf,
      lastUnserved: rUnserved,
      servingEfficiency: Math.min(
        ECONOMY.maxServingEfficiency,
        r.servingEfficiency + (rUnserved < 0.05 ? 0.0003 : 0),
      ),
    };
  });

  // Fulfilled share remains capacity-bound. Lost work moves to the outside
  // option; it is never renormalized back onto providers that could not serve.
  // Customer memory from the opening of the day must survive settlement. A
  // lightly loaded recovery day can lower the stored pain for tomorrow, but it
  // cannot retroactively erase the degraded service customers experienced when
  // making today's provider choice.
  const serviceFractionByProvider: Record<string, number> = {
    player: fulfilledServiceFraction(
      // `serveFrac` uses the pain-suppressed request queue. Settle it against
      // the healthy counterfactual too, otherwise fewer requests can make a
      // damaged service appear more available and increase fulfilled share.
      serveFrac * painDemandDamp,
      Math.max(priorPain, servicePain),
    ),
    ...Object.fromEntries(
      rivals.map((rival) => [
        rival.id,
        fulfilledServiceFraction(
          Math.max(0, 1 - (rival.lastUnserved ?? 0)),
          rival.servicePain ?? 0,
        ),
      ]),
    ),
  };
  {
    const fulfilled = settleFulfilledProviderShares(
      sharesByLab,
      serviceFractionByProvider,
    );
    for (const key of Object.keys(sharesByLab)) delete sharesByLab[key];
    Object.assign(sharesByLab, fulfilled);
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
      };
    }
  }

  // Apply only unsettled market ops to cash; ledger spends already hit cash.
  const marketNet = dayRevenue - marketOpsOut;
  const cash = state.player.cash + marketNet;
  const prev = state.player.finance;
  const peakCash = Math.max(prev.peakCash ?? cash, cash);
  const lowestCash = Math.min(prev.lowestCash ?? cash, cash);
  const runwayDays =
    net >= 0 ? Number.POSITIVE_INFINITY : cash / Math.max(1, -net);

  // Attribute both channels to every model actually routed. The default model
  // remains the enterprise/headline endpoint, but it is no longer the only API
  // product that can earn revenue.
  const activeId = state.player.pricing.activeModelId;
  const subscriptionByModel = new Map<
    string,
    { revenue: number; cogs: number; mtok: number }
  >();
  for (const stat of planStats) {
    for (const usage of stat.modelUsage ?? []) {
      const current = subscriptionByModel.get(usage.modelId) ?? {
        revenue: 0,
        cogs: 0,
        mtok: 0,
      };
      const share = stat.dayMTok > 0 ? usage.dayMTok / stat.dayMTok : 0;
      current.revenue += stat.dayRevenue * share;
      current.cogs += usage.dayMTok * usage.costPerMTok;
      current.mtok += usage.dayMTok;
      subscriptionByModel.set(usage.modelId, current);
    }
  }
  const modelFinance: ModelFinanceRow[] = state.player.models.map((m) => {
    const publicModel = isLivePublicModel(m);
    const apiUsage = apiModelUsage.find((usage) => usage.modelId === m.id);
    const apiSettlement = apiModelSettlement.find(
      (item) => item.model.id === m.id,
    );
    const isApiActive = publicModel && (apiUsage?.dayMTok ?? 0) > 0;
    const subscription = subscriptionByModel.get(m.id) ?? {
      revenue: 0,
      cogs: 0,
      mtok: 0,
    };
    const isActive = isApiActive || subscription.mtok > 0;
    const price = modelApiPrice(state, m.id);
    if (isActive) {
      const modelApiRevenue = apiSettlement?.dayRevenue ?? 0;
      const modelApiCogs =
        (apiUsage?.dayMTok ?? 0) * (apiUsage?.costPerMTok ?? 0);
      const modelApiMTok = apiUsage?.dayMTok ?? 0;
      const directCostShare = apiCogs > 0 ? apiDirectCogs / apiCogs : 0;
      const modelApiDirectCogs = modelApiCogs * directCostShare;
      const modelApiAllocatedOps = Math.max(
        0,
        modelApiCogs - modelApiDirectCogs,
      );
      return {
        modelId: m.id,
        name: m.name,
        family: m.family,
        release: m.release ?? (m.shipped ? "released" : "private"),
        isActive: true,
        isPublic: publicModel,
        capability: m.capability,
        apiPricePerMTok: price,
        dayApiRevenue: modelApiRevenue,
        dayApiDirectCogs: modelApiDirectCogs,
        dayApiAllocatedOps: modelApiAllocatedOps,
        dayApiCogs: modelApiCogs,
        dayApiMTok: modelApiMTok,
        dayApiContribution: modelApiRevenue - modelApiDirectCogs,
        apiCapacityUtilization,
        daySubRevenue: subscription.revenue,
        daySubCogs: subscription.cogs,
        dayEnterpriseShare: m.id === activeId ? enterpriseRevenue : 0,
        dayNet:
          modelApiRevenue +
          subscription.revenue +
          (m.id === activeId ? enterpriseRevenue : 0) -
          modelApiCogs -
          subscription.cogs,
        note:
          unservedRatio > 0.15
            ? "Capacity-constrained"
            : isApiActive && subscription.mtok > 0
              ? "Serving API and subscription traffic"
              : isApiActive
                ? "Serving API traffic"
                : "Serving subscription traffic",
      };
    }
    return {
      modelId: m.id,
      name: m.name,
      family: m.family,
      release: m.release ?? (m.shipped ? "released" : "private"),
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
        ? "Not routed by API or a live subscription plan"
        : m.release === "internal"
          ? "Internal only — no market revenue"
          : "Not public yet",
    };
  });

  // Persist model-level contribution and payback. This intentionally tracks
  // direct product revenue minus attributed serving COGS and the model's own
  // training bill; shared company marketing, debt and campus capex remain in
  // the company ledger rather than being arbitrarily assigned to one model.
  const financeByModelId = new Map(
    modelFinance.map((row) => [row.modelId, row]),
  );
  const modelsWithEconomics = state.player.models.map((modelEntry) => ({
    ...modelEntry,
    economics: advanceModelEconomics(
      modelEntry,
      financeByModelId.get(modelEntry.id),
      state.day,
    ),
  }));

  let alerts = state.alerts;
  let news = state.news;
  // Only complain when demand actually exceeds inference PF (not residual pain with headroom)
  if (
    unservedRatio > 0.08 &&
    demandPf > computeLedger.usableCapacityPfDays &&
    playerDemandMTok > 0.05
  ) {
    const latDrop = Math.max(0, campusLatency - effectiveLatencyScore);
    const msg =
      unservedRatio > 0.4
        ? `Outage-level load: ${(unservedRatio * 100).toFixed(0)}% demand unserved · need ${demandPf.toFixed(1)} PF-d / have ${computeLedger.usableCapacityPfDays.toFixed(1)} after latency reserve · customers leaving.`
        : unservedRatio > 0.2
          ? `Service complaints: demand ${demandPf.toFixed(1)} PF-d vs pool ${computeLedger.usableCapacityPfDays.toFixed(1)} after reserve · churn ${(churnFrac * 100).toFixed(0)}%/d. Expand Serve or efficiency research.`
          : `Elevated load: ${(unservedRatio * 100).toFixed(0)}% unserved (latency −${latDrop.toFixed(0)}). Add inference or ship serving research.`;
    alerts = [
      {
        id: `cap-${state.day}`,
        day: state.day,
        severity:
          unservedRatio > 0.25 ? ("danger" as const) : ("warn" as const),
        message: msg,
      },
      ...state.alerts.filter((a) => !a.id.startsWith("cap-")),
    ].slice(0, 40);
    if (unservedRatio > 0.2) {
      news = [
        `Day ${state.day}: Users complain about ${state.player.name} timeouts and slow replies.`,
        ...news,
      ].slice(0, 20);
    }
  } else if (servicePain > 0.15 && unservedRatio <= 0.05) {
    alerts = [
      {
        id: `cap-recover-${state.day}`,
        day: state.day,
        severity: "info" as const,
        message:
          "Capacity recovering — latency improving, but trust takes time to return.",
      },
      ...state.alerts.filter((a) => !a.id.startsWith("cap-")),
    ].slice(0, 40);
  }

  // Token-speed complaints: listed endpoints with real traffic below 30 tok/s.
  // Demand is already softened by the speed knee; this is the flavor surface.
  const slowBusyOffers = [...demandByOffer.values()].filter((demand) => {
    if (demand.offer.labId !== "player") return false;
    const traffic = demand.apiMTok + demand.subscriptionMTok;
    if (traffic < 0.05) return false;
    const tok = Math.min(
      demand.offer.tokPerSec,
      demand.offer.apiTokPerSec ?? demand.offer.tokPerSec,
    );
    return tok < TOKEN_SPEED_KNEE;
  });
  if (slowBusyOffers.length > 0) {
    const slowest = slowBusyOffers.reduce(
      (best, demand) =>
        Math.min(
          best,
          demand.offer.tokPerSec,
          demand.offer.apiTokPerSec ?? demand.offer.tokPerSec,
        ),
      Infinity,
    );
    alerts = [
      {
        id: `tokspeed-${state.day}`,
        day: state.day,
        severity:
          slowest < TOKEN_SPEED_BRAND_THRESHOLD
            ? ("danger" as const)
            : ("warn" as const),
        message:
          slowest < TOKEN_SPEED_BRAND_THRESHOLD
            ? `Users complain about token speed: replies crawl at ~${slowest.toFixed(0)} tok/s. Serve a smaller active set (MoE) or a snappier checkpoint — demand is holding, patience is not.`
            : `Users complain about token speed (~${slowest.toFixed(0)} tok/s). Streams below ${TOKEN_SPEED_KNEE} tok/s feel sluggish; MoE or a lighter active set would help.`,
      },
      ...alerts.filter((a) => !a.id.startsWith("tokspeed-")),
    ].slice(0, 40);
    news = [
      `Day ${state.day}: Users complain about ${state.player.name} token speed.`,
      ...news,
    ].slice(0, 20);
  }

  alerts = alerts.filter((alert) => !alert.id.startsWith("sales-cap-"));

  if (snap.throttled) {
    alerts = [
      {
        id: `power-${state.day}`,
        day: state.day,
        severity: "danger" as const,
        message: "Power / rack throttle — expand interconnects or free racks.",
      },
      ...alerts.filter((a) => !a.id.startsWith("power-")),
    ].slice(0, 40);
  }

  if (snap.chipCount === 0 && model) {
    alerts = [
      {
        id: `no-chips-${state.day}`,
        day: state.day,
        severity: "warn" as const,
        message:
          "Model ready but no live racks — order racks into a data hall.",
      },
      ...alerts.filter((a) => !a.id.startsWith("no-chips-")),
    ].slice(0, 40);
  }

  // Hosted deployment does not fit fleet memory: serving runs degraded at the
  // oversubscription floor instead of stopping. Explain it once per day.
  const serveMemFit = snap.serveMemFit ?? 1;
  if (hasServingModel(state) && serveMemFit < 0.999) {
    const pct = Math.round(serveMemFit * 100);
    alerts = [
      {
        id: `serve-mem-${state.day}`,
        day: state.day,
        severity: serveMemFit < 0.5 ? ("danger" as const) : ("warn" as const),
        message: `Serving degraded: hosted model needs ${formatGb(snap.vramNeedServe)} HBM but the fleet fits ${pct}% — weights stream from slower tiers at reduced throughput. Add accelerator memory or serve a smaller deployment.`,
      },
      ...alerts.filter((a) => !a.id.startsWith("serve-mem-")),
    ].slice(0, 40);
  }

  // Ops split for UI (serve vs other) — still one energy bill
  const energyOther = energyCostDay * (1 - opsServeShare);
  const chipAmortOther = chipAmort * (1 - opsServeShare);

  const finance = {
    cash,
    dayRevenue,
    dayCogs: productCogs,
    dayEnergyCost: energyCostDay,
    dayWageCost: wage,
    dayChipAmort: chipAmort,
    dayBuildingOpex: buildingOpex,
    dayHostingOpex: hostingOpex.totalDay,
    dayMarketing: mkt,
    dayLoanPayment: 0, // filled by tickLoans after market
    dayEnergyOther: energyOther,
    dayChipAmortOther: chipAmortOther,
    dayDataCost,
    dayTrainingCost,
    dayResearchCost,
    dayHiringCost,
    dayCapexCost,
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
    // Ledger spends already reduced lifetimeNet via chargeExpense/recordCashSpend.
    lifetimeNet: (prev.lifetimeNet ?? 0) + marketNet,
    lifetimeProductCogs: (prev.lifetimeProductCogs ?? 0) + productCogs,
    peakCash,
    lowestCash,
    runwayDays,
    debtOutstanding: (state.player.loans ?? []).reduce(
      (s, l) => s + l.remaining,
      0,
    ),
  };

  const sample: FinanceDaySnapshot = {
    day: state.day,
    cash,
    revenue: dayRevenue,
    productCogs,
    opex: wage + mkt + buildingOpex + ledgerOut,
    energy: energyCostDay,
    net,
    share: finance.totalShare,
    servedMTok,
    demandMTok: playerDemandMTok,
    effectivePf: snap.effectiveFlopsPf,
    valuation: prev.valuation,
    brand,
  };
  const financeHistory = [...state.financeHistory, sample].slice(-180);
  // Per-plan demand series for UI graphs; boundHistories caps it at 180 days.
  const planStatsHistory = [
    ...(state.planStatsHistory ?? []),
    {
      day: state.day,
      plans: planStats.map((p) => ({
        planId: p.planId,
        name: p.name,
        pricePerMonth:
          enabledPlans.find((plan) => plan.id === p.planId)?.pricePerMonth ?? 0,
        demandSubscribers: p.demandSubscribers,
        configuredSubscriberCap: p.configuredSubscriberCap,
        subscribers: p.subscribers,
        dayRevenue: p.dayRevenue,
        dayMTok: p.dayMTok,
      })),
    },
  ];

  const baseTam = SEGMENTS.reduce((s, d) => s + d.baseSize, 0) || 1;
  const settledSegments = grownSegments.map((segment) => {
    const attached = nextProviderSharesBySegment.get(segment.id) ??
      segment.providerShares ?? {
        [OUTSIDE_OPTION_PROVIDER_ID]: 1,
      };
    return {
      ...segment,
      providerShares: settleFulfilledProviderShares(
        attached,
        serviceFractionByProvider,
      ),
    };
  });
  const liveTam = settledSegments.reduce((s, d) => s + d.size, 0);
  const marketAdoption = liveTam / baseTam;

  const apiListPricePerMTok = modelApiPrice(
    state,
    bestPlayerModel(state)?.id ?? null,
  );
  const postedSurge = postedApiSurgeMultiplier(state);
  const apiPeakPricePerMTok = apiListPricePerMTok * postedSurge;
  const apiPeakExtraRevenue =
    postedSurge > 1 + 1e-9
      ? Math.max(0, apiRevenue * (1 - 1 / postedSurge))
      : 0;
  const serveOutage =
    isInferenceOutage(capacityPf, unservedRatio) && playerDemandMTok > 0.05;

  const pauseFeed: FeedEventInput[] = [];
  if (serveOutage) {
    pauseFeed.push({
      id: "feed-serve-outage",
      day: state.day,
      category: "market",
      title:
        capacityPf <= 1e-6 ? "Inference outage" : "Coverage outage",
      body:
        capacityPf <= 1e-6
          ? `${state.player.name} has no inference PF on the floor; existing traffic is unserved until racks come back.`
          : `${state.player.name} cannot admit ${(unservedRatio * 100).toFixed(0)}% of demand; pause new traffic or expand Serve.`,
      source: state.player.name,
      tone: "danger",
      entityId: state.playerLabId,
      kind: "serve_outage",
    });
  }
  if (!isApiAcceptingNew(state.player.pricing)) {
    pauseFeed.push(apiWaitlistFeedEvent(state));
  }
  if (state.player.pricing.subsAcceptingNew === false) {
    pauseFeed.push(subsClosedFeedEvent(state));
  } else {
    for (const plan of enabledPlans) {
      if (plan.acceptingNew === false) {
        pauseFeed.push(planClosedFeedEvent(state, plan));
      }
    }
  }

  return appendFeedEvents(
    {
      ...state,
      segments: settledSegments,
      rivals,
      news,
      player: {
        ...state.player,
        models: modelsWithEconomics,
        cash,
        brandTrust: brand,
        servicePain,
        speedStrain,
        apiSpeedStrain,
        subSpeedStrain,
        apiSurgeLevel,
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
        speedStrain,
        apiSpeedStrain,
        subSpeedStrain,
        apiSurgeLevel,
        apiSurgeMultiplier,
        apiListPricePerMTok,
        apiPeakPricePerMTok,
        apiPeakExtraRevenue,
        serveOutage,
        pausedNewApiMTok,
        pausedNewSubscriptionSeats,
        apiLoad,
        subLoad,
        overflowMTok,
        trickledMTok,
        planStats,
        servedMTokByPlanId: Object.fromEntries(
          planStats.map((stat) => [stat.planId, stat.dayMTok]),
        ),
        servedFreeMTok: planStats
          .filter((stat) => stat.isFree)
          .reduce((sum, stat) => sum + stat.dayMTok, 0),
        servedPaidMTok: planStats
          .filter((stat) => !stat.isFree)
          .reduce((sum, stat) => sum + stat.dayMTok, 0),
        apiSubscribers: playerApiUsers * serveFracApi,
        apiDemandMTok: playerApiMTok,
        apiDayMTok: apiServed,
        apiDayRevenue: apiRevenue,
        apiDayDirectCogs: apiDirectCogs,
        apiDayAllocatedOps: apiAllocatedOps,
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
        marketTaskIntensity: taskIntensityMultiple,
        /** 0–1 inference reserved for API under constraint */
        apiVsSubPriority: apiPrio,
        apiServeFrac: serveFracApi,
        subServeFrac: serveFracSub,
        apiPoolPf,
        subPoolPf,
        capacitySalesCapped,
        blockedApiMTok: Math.max(0, playerApiMTok - apiServed),
        blockedSubscriptionSeats,
        capBlockedSubscriptionSeats,
        capacityProductRevenueCeiling,
        computeLedger: reconciledComputeLedger,
      },
      financeHistory,
      planStatsHistory,
      alerts,
    },
    pauseFeed,
  );
}

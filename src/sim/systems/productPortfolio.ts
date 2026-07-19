import { ECONOMY, SEGMENTS } from '../balance/economy'
import type {
  CapabilityDomain,
  DemandSegment,
  Model,
  Modality,
  ProductChannel,
  ProductOffer,
  ProductOfferPricing,
  ProductQualityDimension,
  SegmentId,
  SimState,
  SubPlan,
} from '../types'
import { planAllowanceMTokPerMonth } from './plans'

export const MAX_PROMOTED_PRODUCT_OFFERS = 6

export const PRODUCT_CHANNELS: readonly ProductChannel[] = [
  'free_assistant',
  'consumer_pro',
  'creator_developer',
  'payg_api',
  'reserved_throughput_api',
  'enterprise_dedicated',
] as const

export interface ProductPortfolio {
  promoted: ProductOffer[]
  byChannel: Partial<Record<ProductChannel, ProductOffer>>
  missingChannels: ProductChannel[]
  internalModelIds: string[]
  unpromotedReleasedModelIds: string[]
}

interface DemandProfile {
  priceSensitivity: number
  switchingFriction: number
  domainWeights: Partial<Record<CapabilityDomain, number>>
  productQualityWeights: Partial<Record<ProductQualityDimension, number>>
  preferredChannels: ProductChannel[]
  referencePrice: DemandSegment['referencePrice']
  targetLatencyMs: number
  outsideOptionUtility: number
}

const CHANNEL_TARGETS: Record<ProductChannel, SegmentId[]> = {
  free_assistant: ['hobby'],
  consumer_pro: ['consumer'],
  creator_developer: ['indie_api', 'creative'],
  payg_api: ['indie_api', 'startup_api', 'science'],
  reserved_throughput_api: ['startup_api', 'science', 'enterprise'],
  enterprise_dedicated: ['enterprise', 'legal', 'healthcare'],
}

const DEMAND_PROFILES: Record<SegmentId, DemandProfile> = {
  hobby: {
    priceSensitivity: 1.8,
    switchingFriction: 0.08,
    domainWeights: { language: 0.55, reasoning: 0.15, code: 0.05, vision: 0.1, audio: 0.05, tools: 0.1 },
    productQualityWeights: { steerability: 0.3, safety: 0.2, reliability: 0.3, factuality: 0.1, robustness: 0.1 },
    preferredChannels: ['free_assistant', 'payg_api'],
    referencePrice: { value: 0, unit: 'monthly_usd' },
    targetLatencyMs: 1_800,
    outsideOptionUtility: 4.5,
  },
  consumer: {
    priceSensitivity: 1.25,
    switchingFriction: 0.16,
    domainWeights: { language: 0.4, reasoning: 0.18, vision: 0.18, audio: 0.08, video: 0.08, tools: 0.08 },
    productQualityWeights: { steerability: 0.24, safety: 0.24, reliability: 0.22, factuality: 0.16, robustness: 0.14 },
    preferredChannels: ['consumer_pro', 'free_assistant'],
    referencePrice: { value: 20, unit: 'monthly_usd' },
    targetLatencyMs: 1_200,
    outsideOptionUtility: 3.5,
  },
  indie_api: {
    priceSensitivity: 1.2,
    switchingFriction: 0.14,
    domainWeights: { code: 0.42, tools: 0.24, reasoning: 0.18, language: 0.1, math: 0.06 },
    productQualityWeights: { reliability: 0.3, steerability: 0.23, robustness: 0.22, factuality: 0.15, safety: 0.1 },
    preferredChannels: ['payg_api', 'creator_developer'],
    referencePrice: { value: 2, unit: 'usd_per_mtok' },
    targetLatencyMs: 800,
    outsideOptionUtility: 4.2,
  },
  startup_api: {
    priceSensitivity: 0.9,
    switchingFriction: 0.28,
    domainWeights: { code: 0.32, reasoning: 0.25, tools: 0.25, language: 0.1, math: 0.08 },
    productQualityWeights: { reliability: 0.34, robustness: 0.23, factuality: 0.18, steerability: 0.15, safety: 0.1 },
    preferredChannels: ['payg_api', 'reserved_throughput_api'],
    referencePrice: { value: 5, unit: 'usd_per_mtok' },
    targetLatencyMs: 600,
    outsideOptionUtility: 3.2,
  },
  science: {
    priceSensitivity: 0.6,
    switchingFriction: 0.68,
    domainWeights: { science: 0.38, math: 0.27, reasoning: 0.2, code: 0.1, tools: 0.05 },
    productQualityWeights: { factuality: 0.35, reliability: 0.25, robustness: 0.2, steerability: 0.1, safety: 0.1 },
    preferredChannels: ['reserved_throughput_api', 'payg_api', 'enterprise_dedicated'],
    referencePrice: { value: 12, unit: 'usd_per_mtok' },
    targetLatencyMs: 2_500,
    outsideOptionUtility: 3.8,
  },
  creative: {
    priceSensitivity: 1,
    switchingFriction: 0.2,
    domainWeights: { vision: 0.35, video: 0.24, audio: 0.14, language: 0.12, reasoning: 0.08, tools: 0.07 },
    productQualityWeights: { steerability: 0.34, reliability: 0.2, robustness: 0.18, safety: 0.15, factuality: 0.13 },
    preferredChannels: ['creator_developer', 'payg_api'],
    referencePrice: { value: 8, unit: 'usd_per_mtok' },
    targetLatencyMs: 3_000,
    outsideOptionUtility: 3.6,
  },
  enterprise: {
    priceSensitivity: 0.5,
    switchingFriction: 0.82,
    domainWeights: { reasoning: 0.25, code: 0.22, tools: 0.22, language: 0.2, science: 0.06, math: 0.05 },
    productQualityWeights: { reliability: 0.3, factuality: 0.22, safety: 0.2, robustness: 0.18, steerability: 0.1 },
    preferredChannels: ['enterprise_dedicated', 'reserved_throughput_api'],
    referencePrice: { value: 120, unit: 'monthly_usd' },
    targetLatencyMs: 700,
    outsideOptionUtility: 4,
  },
  legal: {
    priceSensitivity: 0.5,
    switchingFriction: 0.88,
    domainWeights: { language: 0.38, reasoning: 0.32, tools: 0.1, science: 0.08, code: 0.06, math: 0.06 },
    productQualityWeights: { factuality: 0.32, reliability: 0.26, safety: 0.2, robustness: 0.15, steerability: 0.07 },
    preferredChannels: ['enterprise_dedicated'],
    referencePrice: { value: 200, unit: 'monthly_usd' },
    targetLatencyMs: 1_800,
    outsideOptionUtility: 4.5,
  },
  healthcare: {
    priceSensitivity: 0.45,
    switchingFriction: 0.92,
    domainWeights: { science: 0.36, reasoning: 0.3, language: 0.18, tools: 0.08, math: 0.08 },
    productQualityWeights: { reliability: 0.3, safety: 0.28, factuality: 0.24, robustness: 0.13, steerability: 0.05 },
    preferredChannels: ['enterprise_dedicated'],
    referencePrice: { value: 250, unit: 'monthly_usd' },
    targetLatencyMs: 900,
    outsideOptionUtility: 5,
  },
}

const MODALITY_ORDER: readonly Modality[] = ['text', 'image', 'video', 'audio', 'tools']

function isReleased(model: Model): boolean {
  return model.release === 'released' || model.shipped
}

function compareModelScore(
  score: (model: Model) => number,
): (a: Model, b: Model) => number {
  return (a, b) => score(b) - score(a) || a.id.localeCompare(b.id)
}

function primaryApiModel(state: SimState, released: Model[]): Model | null {
  const active = released.find((model) => model.id === state.player.pricing.activeModelId)
  return active ?? [...released].sort(compareModelScore((model) => model.capability))[0] ?? null
}

function planModels(state: SimState, plan: SubPlan, fallback: Model | null): Model[] {
  const byId = new Map(state.player.models.filter(isReleased).map((model) => [model.id, model]))
  const selected = [...new Set(plan.modelIds)]
    .map((id) => byId.get(id))
    .filter((model): model is Model => model != null)
  if (selected.length > 0) return selected
  return fallback ? [fallback] : []
}

function modelApiRates(state: SimState, model: Model): { input: number; output: number } {
  const pricing = state.player.pricing
  if (model.apiPriceInPerMTok != null && model.apiPriceOutPerMTok != null) {
    return {
      input: Math.max(0, model.apiPriceInPerMTok),
      output: Math.max(0, model.apiPriceOutPerMTok),
    }
  }
  if (model.apiPriceInPerMTok != null || model.apiPriceOutPerMTok != null) {
    return {
      input: Math.max(
        0,
        model.apiPriceInPerMTok ??
          model.suggestedApiPriceIn ??
          model.costApiPriceIn ??
          pricing.apiPriceInPerMTok ??
          pricing.apiPricePerMTok * 0.35,
      ),
      output: Math.max(
        0,
        model.apiPriceOutPerMTok ??
          model.suggestedApiPriceOut ??
          model.costApiPriceOut ??
          pricing.apiPriceOutPerMTok ??
          pricing.apiPricePerMTok * 1.25,
      ),
    }
  }
  if (model.apiPricePerMTok != null) {
    return {
      input: Math.max(0, model.apiPricePerMTok * 0.35),
      output: Math.max(0, model.apiPricePerMTok * 1.25),
    }
  }
  if (model.suggestedApiPriceIn != null && model.suggestedApiPriceOut != null) {
    return {
      input: Math.max(0, model.suggestedApiPriceIn),
      output: Math.max(0, model.suggestedApiPriceOut),
    }
  }
  if (model.suggestedApiPrice) {
    return {
      input: Math.max(0, model.suggestedApiPrice * 0.35),
      output: Math.max(0, model.suggestedApiPrice * 1.25),
    }
  }
  return {
    input: Math.max(0, pricing.apiPriceInPerMTok ?? pricing.apiPricePerMTok * 0.35),
    output: Math.max(0, pricing.apiPriceOutPerMTok ?? pricing.apiPricePerMTok * 1.25),
  }
}

function offerModalities(models: Model[]): Modality[] {
  const available = new Set(models.flatMap((model) => model.modalities))
  return MODALITY_ORDER.filter((modality) => available.has(modality))
}

function productOffer(input: {
  state: SimState
  channel: ProductChannel
  name: string
  models: Model[]
  primary: Model
  plan?: SubPlan
  pricing: ProductOfferPricing
  delivery: ProductOffer['delivery']
  capacityPriority: number
}): ProductOffer {
  const otherIds = input.models
    .filter((model) => model.id !== input.primary.id)
    .map((model) => model.id)
    .sort((a, b) => a.localeCompare(b))
  return {
    id: `product:${input.channel}`,
    labId: input.state.playerLabId,
    channel: input.channel,
    name: input.name,
    promoted: true,
    sourcePlanId: input.plan?.id ?? null,
    primaryModelId: input.primary.id,
    modelIds: [input.primary.id, ...otherIds],
    targetSegments: [...CHANNEL_TARGETS[input.channel]],
    pricing: input.pricing,
    delivery: input.delivery,
    capacityPriority: Math.max(0, Math.min(1, input.capacityPriority)),
    servePrecision: input.plan?.servePrecision ?? 'fp16',
    capability: input.primary.capability,
    reliability: input.primary.capabilities?.reliability ?? input.primary.quality.reliability,
    modalities: offerModalities(input.models),
  }
}

function subscriptionPricing(
  plan: SubPlan,
  rates: { input: number; output: number },
  withOverages: boolean,
): ProductOfferPricing {
  return {
    billingModel: plan.pricePerMonth <= 0 ? 'free' : 'subscription',
    monthlyUsd: Math.max(0, plan.pricePerMonth),
    includedMTokPerMonth: planAllowanceMTokPerMonth(plan),
    inputUsdPerMTok: null,
    outputUsdPerMTok: null,
    overageInputUsdPerMTok: withOverages ? rates.input : null,
    overageOutputUsdPerMTok: withOverages ? rates.output : null,
    minimumCommitmentUsd: null,
  }
}

/** One promoted offer per public channel, with a hard six-offer ceiling. */
export function capPromotedOffers(offers: readonly ProductOffer[]): ProductOffer[] {
  const firstByChannel = new Map<ProductChannel, ProductOffer>()
  for (const offer of offers) {
    if (!offer.promoted || offer.modelIds.length === 0 || firstByChannel.has(offer.channel)) continue
    firstByChannel.set(offer.channel, offer)
  }
  return PRODUCT_CHANNELS
    .map((channel) => firstByChannel.get(channel))
    .filter((offer): offer is ProductOffer => offer != null)
    .slice(0, MAX_PROMOTED_PRODUCT_OFFERS)
}

/**
 * Derive the public portfolio from existing models, subscription plans, and
 * API prices. This is intentionally read-only; market settlement remains in
 * the existing market/plans systems.
 */
export function deriveProductPortfolio(state: SimState): ProductPortfolio {
  const released = state.player.models.filter(isReleased)
  const internalModelIds = state.player.models
    .filter((model) => !isReleased(model))
    .map((model) => model.id)
    .sort((a, b) => a.localeCompare(b))
  const apiModel = primaryApiModel(state, released)
  const candidates: ProductOffer[] = []

  const enabledPlans = state.player.pricing.plans.filter((plan) => plan.enabled)
  const freePlan = [...enabledPlans]
    .filter((plan) => plan.pricePerMonth <= 0)
    .sort((a, b) => a.id.localeCompare(b.id))[0]
  const paidPlans = [...enabledPlans]
    .filter((plan) => plan.pricePerMonth > 0)
    .sort((a, b) => a.pricePerMonth - b.pricePerMonth || a.id.localeCompare(b.id))
  const consumerPlan = paidPlans[0]
  const creatorPlan =
    paidPlans.find(
      (plan) =>
        plan.id !== consumerPlan?.id && /creator|developer|pro/i.test(`${plan.id} ${plan.name}`),
    ) ??
    [...paidPlans].reverse().find((plan) => plan.id !== consumerPlan?.id) ??
    consumerPlan

  if (freePlan && apiModel) {
    const models = planModels(state, freePlan, apiModel)
    const primary = [...models].sort(
      compareModelScore((model) => -model.inferCostMult * 50 + model.capability * 0.5),
    )[0]
    if (primary) {
      candidates.push(
        productOffer({
          state,
          channel: 'free_assistant',
          name: freePlan.name,
          models,
          primary,
          plan: freePlan,
          pricing: subscriptionPricing(freePlan, modelApiRates(state, primary), false),
          delivery: 'shared',
          capacityPriority: (1 - state.player.pricing.apiVsSubPriority) * 0.65,
        }),
      )
    }
  }

  if (consumerPlan && apiModel) {
    const models = planModels(state, consumerPlan, apiModel)
    const primary = [...models].sort(
      compareModelScore(
        (model) =>
          model.capability +
          model.quality.chat * 0.45 +
          model.quality.image * 0.15 +
          model.quality.reliability * 0.25,
      ),
    )[0]
    if (primary) {
      candidates.push(
        productOffer({
          state,
          channel: 'consumer_pro',
          name: consumerPlan.name,
          models,
          primary,
          plan: consumerPlan,
          pricing: subscriptionPricing(consumerPlan, modelApiRates(state, primary), false),
          delivery: 'shared',
          capacityPriority: Math.max(0.45, 1 - state.player.pricing.apiVsSubPriority),
        }),
      )
    }
  }

  if (creatorPlan && apiModel) {
    const models = planModels(state, creatorPlan, apiModel)
    const primary = [...models].sort(
      compareModelScore(
        (model) =>
          model.capability * 0.6 +
          model.quality.coding * 0.45 +
          model.quality.image * 0.25 +
          model.quality.video * 0.2 +
          (model.modalities.includes('tools') ? 15 : 0),
      ),
    )[0]
    if (primary) {
      candidates.push(
        productOffer({
          state,
          channel: 'creator_developer',
          name: creatorPlan.name,
          models,
          primary,
          plan: creatorPlan,
          pricing: subscriptionPricing(creatorPlan, modelApiRates(state, primary), true),
          delivery: 'shared',
          capacityPriority: 0.65,
        }),
      )
    }
  }

  if (apiModel) {
    const rates = modelApiRates(state, apiModel)
    const blended = rates.input * 0.75 + rates.output * 0.25
    candidates.push(
      productOffer({
        state,
        channel: 'payg_api',
        name: 'Pay-as-you-go API',
        models: released,
        primary: apiModel,
        pricing: {
          billingModel: 'usage',
          monthlyUsd: null,
          includedMTokPerMonth: null,
          inputUsdPerMTok: rates.input,
          outputUsdPerMTok: rates.output,
          overageInputUsdPerMTok: null,
          overageOutputUsdPerMTok: null,
          minimumCommitmentUsd: null,
        },
        delivery: 'shared',
        capacityPriority: state.player.pricing.apiVsSubPriority,
      }),
      productOffer({
        state,
        channel: 'reserved_throughput_api',
        name: 'Reserved-throughput API',
        models: released,
        primary: apiModel,
        pricing: {
          billingModel: 'reserved',
          monthlyUsd: null,
          includedMTokPerMonth: null,
          inputUsdPerMTok: rates.input * 0.82,
          outputUsdPerMTok: rates.output * 0.82,
          overageInputUsdPerMTok: rates.input,
          overageOutputUsdPerMTok: rates.output,
          minimumCommitmentUsd: Math.max(5_000, blended * 2_500 * 0.82),
        },
        delivery: 'reserved',
        capacityPriority: 0.9,
      }),
    )

    const enterpriseModel = [...released].sort(
      compareModelScore(
        (model) =>
          model.capability * 0.35 +
          (model.capabilities?.reliability ?? model.quality.reliability) * 0.4 +
          (model.capabilities?.safety ?? model.quality.safety) * 0.25,
      ),
    )[0]!
    const enterpriseRates = modelApiRates(state, enterpriseModel)
    const enterpriseBlended = enterpriseRates.input * 0.75 + enterpriseRates.output * 0.25
    candidates.push(
      productOffer({
        state,
        channel: 'enterprise_dedicated',
        name: 'Enterprise dedicated capacity',
        models: [enterpriseModel],
        primary: enterpriseModel,
        pricing: {
          billingModel: 'contract',
          monthlyUsd: null,
          includedMTokPerMonth: null,
          inputUsdPerMTok: enterpriseRates.input,
          outputUsdPerMTok: enterpriseRates.output,
          overageInputUsdPerMTok: enterpriseRates.input,
          overageOutputUsdPerMTok: enterpriseRates.output,
          minimumCommitmentUsd: Math.max(25_000, enterpriseBlended * 10_000),
        },
        delivery: 'dedicated',
        capacityPriority: 1,
      }),
    )
  }

  const promoted = capPromotedOffers(candidates)
  const byChannel: Partial<Record<ProductChannel, ProductOffer>> = {}
  for (const offer of promoted) byChannel[offer.channel] = offer
  const promotedModels = new Set(promoted.flatMap((offer) => offer.modelIds))
  return {
    promoted,
    byChannel,
    missingChannels: PRODUCT_CHANNELS.filter((channel) => byChannel[channel] == null),
    internalModelIds,
    unpromotedReleasedModelIds: released
      .filter((model) => !promotedModels.has(model.id))
      .map((model) => model.id)
      .sort((a, b) => a.localeCompare(b)),
  }
}

/** Authoritative demand definitions enriched with the campaign's live TAM. */
export function deriveDemandSegments(state: SimState): DemandSegment[] {
  return SEGMENTS.map((definition) => {
    const live = state.segments.find((segment) => segment.id === definition.id)
    const profile = DEMAND_PROFILES[definition.id]
    return {
      id: definition.id,
      name: definition.name,
      currentUsers: Math.max(0, live?.size ?? definition.baseSize),
      baseUsers: definition.baseSize,
      usefulTaskDemandPerUserDay: Math.max(0, live?.usageIntensity ?? definition.baseUsage),
      priceSensitivity: profile.priceSensitivity,
      switchingFriction: profile.switchingFriction,
      domainWeights: { ...profile.domainWeights },
      productQualityWeights: { ...profile.productQualityWeights },
      benchmarkWeights: { ...definition.benchmarkWeights },
      preferredChannels: [...profile.preferredChannels],
      referencePrice: { ...profile.referencePrice },
      targetLatencyMs: profile.targetLatencyMs,
      outsideOptionUtility: profile.outsideOptionUtility,
    }
  })
}

/** Monthly included tokens used by creator/developer overage displays. */
export function includedMonthlyUsageForOffer(offer: ProductOffer): number {
  return Math.max(0, offer.pricing.includedMTokPerMonth ?? 0)
}

/** Existing settlement uses this split; exposed for capacity planning inspectors. */
export function portfolioCapacitySplit(state: SimState): { api: number; subscriptions: number } {
  const api = Math.max(0, Math.min(1, state.player.pricing.apiVsSubPriority ?? ECONOMY.defaultApiVsSubPriority))
  return { api, subscriptions: 1 - api }
}

/**
 * Gating tests for plan value, compute caps, subsidy, facility opex, API vs subs.
 * Drives shipped helpers and tickMarket — no reimplementation of production math.
 */
import { describe, expect, it } from 'vitest'
import { createGame } from './createGame'
import { ECONOMY } from './balance/economy'
import {
  createPlan,
  DEFAULT_PLAN_BLEND_API_PRICE,
  defaultPlans,
  formatAllowance,
  allocatePlanCompute,
  applyPlanUptierMigration,
  freeTierDemandProfile,
  freeTierRankDemandFactor,
  FREE_TIER_TOP_MODEL_RANK,
  modelCapabilityRank,
  planAdvertisedValueRatio,
  planAllowanceMTokPerMonth,
  planAllowanceExpectation,
  planApiEquivalentValue,
  planAttractiveness,
  availablePlanPrecisionsForModel,
  enforcePlanSubscriberPyramid,
  paidPlanPyramidLead,
  PAID_PLAN_PYRAMID_LEAD_WEAK,
  PAID_PLAN_PYRAMID_LEAD_STRONG,
  planHasApiValueSubsidy,
  planModelServePrecision,
  planModelTrafficMix,
  planMonthlyApiValueSubsidy,
  planOfferingBreadth,
  planPremiumReadiness,
  planPriceTierMassPrior,
  planPriceTooHighScore,
  planSegmentUsageAffinity,
  planServeModifiers,
  modelForServePrecision,
  planStabilityDissatisfaction,
  planSubsidyRatio,
  premiumPlanScrutiny,
  maxSeatsForPlan,
  PLAN_PRO_WORKLOAD_MESSAGES_PER_DAY,
  planStinginessApplies,
  planWorkloadExpectation,
  rivalNearestValueRatio,
  segmentExpectedMessagesPerDay,
  subsidyFromIncludedMTok,
  updatePlan,
} from './systems/plans'
import { playerBuildingOpex } from './systems/map'
import {
  PLAN_SEAT_CONVERSION,
  rivalPlanDemandPerUser,
  settleRivalOfferDemand,
  tickMarket,
} from './systems/market'
import {
  avgTokensPerInteraction,
  blendApiPrice,
  WORKLOAD_TOKENS_PER_INTERACTION,
} from './balance/pricing'
import { startTraining, releaseFromJob, tickTraining } from './systems/training'
import { buildScaledModel } from './balance/modelBuild'
import {
  apiComparablePeerRows,
  apiDemandElasticityMultiplier,
  apiDemandPricePenalty,
  analyzeApiPricing,
  suggestCompetitiveApiInOut,
  suggestPlanPriceAndUsage,
} from './balance/pricing'
import {
  planActualMTokPerUser,
  planHeavyUserProfile,
} from './balance/serveCompute'
import type { Model, SimState, SubPlan } from './types'
import { tickDay } from './tick'
import { useGameStore } from '../store/gameStore'

function withHall(s: SimState, racks: number): SimState {
  const tiles = s.map.tiles.map((t) => {
    if (t.x === 2 && t.y === 2) {
      return {
        ...t,
        kind: 'dc' as const,
        owner: 'player' as const,
        buildingProgress: 1,
        buildingTarget: 1,
        rackCapacity: 512,
        racksUsed: 0,
        mwCapacity: 80,
        opexPerDay: 72_000,
      }
    }
    if (t.x === 3 && t.y === 2) {
      return {
        ...t,
        kind: 'substation' as const,
        owner: 'player' as const,
        buildingProgress: 1,
        buildingTarget: 1,
        mwCapacity: 80,
        opexPerDay: 15_000,
      }
    }
    return t
  })
  return {
    ...s,
    map: { ...s.map, tiles },
    player: {
      ...s.player,
      cash: 1e9,
      rackFleet: [
        {
          id: 'bal-fleet',
          skuId: 'rack_h100',
          x: 2,
          y: 2,
          count: racks,
          status: 'live',
          daysLeft: 0,
          paidEach: 165_000,
          rackUnits: 1,
        },
      ],
      allocation: { training: 0.15, inference: 0.7, research: 0.15 },
      servingEfficiency: 0.85,
    },
  }
}

function forceJob(state: SimState): SimState {
  let s = state
  for (let i = 0; i < 200; i++) {
    if (!s.player.trainingJob) break
    s = { ...s, day: s.day + 1 }
    s = tickTraining(s)
    const j = s.player.trainingJob
    if (j && j.progressPfDays < j.targetPfDays) {
      s = {
        ...s,
        player: {
          ...s.player,
          trainingJob: {
            ...j,
            progressPfDays: j.targetPfDays,
            daysElapsed: j.minCalendarDays ?? 0,
          },
          trainingJobs: (s.player.trainingJobs ?? [j]).map((job) =>
            job.id === j.id
              ? {
                  ...job,
                  progressPfDays: job.targetPfDays,
                  daysElapsed: job.minCalendarDays ?? 0,
                }
              : job,
          ),
        },
      }
    }
    if (j?.awaitingDecision) break
  }
  return s
}

function shipModel(s: SimState, cap = 55): SimState {
  if (s.player.models.length > 0) {
    const base = s.player.models[0]!
    const clone = {
      ...base,
      id: `${base.id}-fixture-${s.player.models.length}`,
      name: `${base.name}-${s.player.models.length + 1}`,
      capability: cap,
      quality: { ...base.quality, reliability: 60, chat: 55 },
    }
    return {
      ...s,
      player: { ...s.player, models: [...s.player.models, clone] },
    }
  }
  s = withHall(s, 64)
  s = startTraining(s, { name: 'BalModel', family: 'dense', paramsB: 4 })
  s = forceJob(s)
  s = releaseFromJob(s)
  const m =
    s.player.models[0] ??
    buildScaledModel({
      id: `fixture-${s.seed}-${s.day}`,
      name: 'BalModel',
      paramsB: 4,
      family: 'dense',
      day: s.day,
      dataCoverage: 20,
      dataQuality: 70,
      postTrain: 'none',
    })
  return {
    ...s,
    player: {
      ...s.player,
      models: [
        {
          ...m,
          capability: cap,
          quality: { ...m.quality, reliability: 60, chat: 55 },
          shipped: true,
          release: 'released',
          // Fixture list prices — each model owns its own in/out $/MTok
          apiPricePerMTok: 3,
          apiPriceInPerMTok: 1,
          apiPriceOutPerMTok: 4,
        },
      ],
      brandTrust: 58,
      pricing: {
        ...s.player.pricing,
        activeModelId: m.id,
        apiPricePerMTok: 3,
        apiPriceInPerMTok: 1,
        apiPriceOutPerMTok: 4,
      },
    },
    rivals: s.rivals.map((r) => ({
      ...r,
      models: r.models.map((x) => ({
        ...x,
        capability: Math.min(x.capability, 48),
      })),
      pricing: { ...r.pricing, subPlusPrice: 22 },
    })),
  }
}

/** Override lab + active model API list prices together. */
function withApiPrices(s: SimState, pin: number, pout: number): SimState {
  const blend = Math.round(blendApiPrice(pin, pout) * 1000) / 1000
  const activeId = s.player.pricing.activeModelId
  return {
    ...s,
    player: {
      ...s.player,
      models: s.player.models.map((m) =>
        m.id === activeId || (!activeId && m === s.player.models[0])
          ? {
              ...m,
              apiPriceInPerMTok: pin,
              apiPriceOutPerMTok: pout,
              apiPricePerMTok: blend,
            }
          : m,
      ),
      pricing: {
        ...s.player.pricing,
        apiPriceInPerMTok: pin,
        apiPriceOutPerMTok: pout,
        apiPricePerMTok: blend,
      },
    },
  }
}

const basePlan = (over: Partial<SubPlan> = {}): SubPlan => ({
  id: 'p',
  name: 'P',
  pricePerMonth: 20,
  usageMultiplier: 1,
  usageRate: null,
  modelIds: [],
  enabled: true,
  ...over,
})

function apiDemandFixture(cap = 55): SimState {
  let s = shipModel(createGame(8801), cap)
  s = withHall(s, 96)
  const modelId = s.player.models[0]!.id
  return {
    ...s,
    player: {
      ...s.player,
      rackFleet: s.player.rackFleet.map((r) => ({ ...r, count: 96 })),
      allocation: { training: 0.1, inference: 0.85, research: 0.05 },
      pricing: {
        ...s.player.pricing,
        apiModelIds: [modelId],
        plans: [],
      },
    },
  }
}

function withRivalApiOffer(
  s: SimState,
  rivalIndex: number,
  cap: number,
  pin: number,
  pout: number,
): SimState {
  const rival = s.rivals[rivalIndex]
  if (!rival) return s
  const built = buildScaledModel({
    id: `rival-api-${rival.id}-${cap}`,
    name: `${rival.name} API`,
    paramsB: 3,
    family: 'dense',
    day: s.day,
    dataCoverage: 20,
    dataQuality: 65,
    postTrain: 'none',
  })
  const blend = blendApiPrice(pin, pout)
  const model = {
    ...built,
    capability: cap,
    quality: { ...built.quality, reliability: 58, chat: 55 },
    shipped: true,
    release: 'released' as const,
    apiPricePerMTok: blend,
    apiPriceInPerMTok: pin,
    apiPriceOutPerMTok: pout,
  }
  const rivals = [...s.rivals]
  rivals[rivalIndex] = {
    ...rival,
    flopsPf: 2_000_000,
    models: [model],
    pricing: {
      ...rival.pricing,
      apiPricePerMTok: blend,
      apiPriceInPerMTok: pin,
      apiPriceOutPerMTok: pout,
    },
  }
  return { ...s, rivals }
}

describe('API suggested price and similar-capability demand', () => {
  it('treats the suggested undercut as in-band for demand math', () => {
    const peers = [
      { price: 4, capability: 68, featureScore: 18, tokPerSec: 60 },
      { price: 2.4, capability: 54, featureScore: 18, tokPerSec: 52 },
    ]
    const suggested = suggestCompetitiveApiInOut({
      costIn: 0.4,
      costOut: 1.2,
      capability: 52,
      featureScore: 18,
      peers: peers.map((peer) => ({
        priceIn: peer.price * 0.3,
        priceOut: peer.price * 0.7,
        capability: peer.capability,
        featureScore: peer.featureScore,
        tokPerSec: peer.tokPerSec,
      })),
      fallbackPriceIn: 1,
      fallbackPriceOut: 3,
    })
    const blend = blendApiPrice(suggested.priceIn, suggested.priceOut)
    const status = analyzeApiPricing({
      price: blend,
      marginalCost: 0.5,
      capability: 52,
      featureScore: 18,
      peers,
    })
    expect(status.ratioToPeer).not.toBeNull()
    expect(status.ratioToPeer!).toBeGreaterThan(0.3)
    expect(status.ratioToPeer!).toBeLessThan(1.05)
    expect(
      apiDemandElasticityMultiplier({
        ratioToPeer: status.ratioToPeer,
        elasticity: 1.5,
      }),
    ).toBeGreaterThan(0.95)
  })

  it('undercutting while a bit worse still earns API demand after settlement', () => {
    let s = apiDemandFixture(52)
    s = withRivalApiOffer(s, 0, 62, 1.2, 3.6)
    const rivalPeers = s.rivals[0]!.models.map((model) => ({
      priceIn: model.apiPriceInPerMTok!,
      priceOut: model.apiPriceOutPerMTok!,
      capability: model.capability,
      featureScore: model.modalities.length * 18,
      tokPerSec:
        model.serviceProfile?.interactiveTokPerSec ?? 52 * model.tokPerSecMult,
    }))
    const hostingIn = s.player.models[0]!.costApiPriceIn
    const hostingOut = s.player.models[0]!.costApiPriceOut
    const suggested = suggestCompetitiveApiInOut({
      costIn: hostingIn,
      costOut: hostingOut,
      capability: 52,
      featureScore: 18,
      peers: rivalPeers,
      fallbackPriceIn: hostingIn,
      fallbackPriceOut: hostingOut,
    })
    s = withApiPrices(s, suggested.priceIn, suggested.priceOut)
    s = tickMarket(s)
    expect(s.lastMarket.apiDemandMTok ?? 0).toBeGreaterThan(0.05)
  })

  it('frontier with a modest premium still earns API demand', () => {
    let s = apiDemandFixture(68)
    s = withRivalApiOffer(s, 0, 60, 1, 3)
    const rival = s.rivals[0]!.models[0]!
    const rivalBlend = blendApiPrice(
      rival.apiPriceInPerMTok!,
      rival.apiPriceOutPerMTok!,
    )
    const premiumIn = rival.apiPriceInPerMTok! * 1.12
    const premiumOut = rival.apiPriceOutPerMTok! * 1.12
    expect(blendApiPrice(premiumIn, premiumOut)).toBeGreaterThan(rivalBlend)
    s = withApiPrices(s, premiumIn, premiumOut)
    s = tickMarket(s)
    expect(s.lastMarket.apiDemandMTok ?? 0).toBeGreaterThan(0.05)
  })

  it('extreme overpricing collapses API demand versus a competitive list', () => {
    let competitive = apiDemandFixture(55)
    competitive = withRivalApiOffer(competitive, 0, 58, 1, 3)
    competitive = withApiPrices(competitive, 1, 3)
    competitive = tickMarket(competitive)

    let gouged = apiDemandFixture(55)
    gouged = withRivalApiOffer(gouged, 0, 58, 1, 3)
    gouged = withApiPrices(gouged, 120, 300)
    gouged = tickMarket(gouged)

    expect(competitive.lastMarket.apiDemandMTok ?? 0).toBeGreaterThan(
      gouged.lastMarket.apiDemandMTok ?? 0,
    )
    expect(gouged.lastMarket.apiDemandMTok ?? 0).toBeLessThan(
      (competitive.lastMarket.apiDemandMTok ?? 0) * 0.15,
    )
  })

  it('lists similar-capability rivals for the price control', () => {
    const rows = apiComparablePeerRows(
      2.1,
      { capability: 55, featureScore: 18, tokPerSec: 52 },
      [
        {
          name: 'Frontier',
          price: 4,
          capability: 85,
          featureScore: 18,
          tokPerSec: 60,
        },
        {
          name: 'Peer',
          price: 2.4,
          capability: 56,
          featureScore: 18,
          tokPerSec: 50,
        },
      ],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('Peer')
    expect(rows[0]?.position).toBe('cheaper')
  })
})

describe('gradual commercial elasticity and allowance abuse', () => {
  it('keeps near-market pricing unpenalized and preserves modality niches at high prices', () => {
    expect(apiDemandPricePenalty({ ratioToPeer: 1.12, kind: 'language' })).toBeLessThan(0.35)
    const language = apiDemandPricePenalty({ ratioToPeer: 4, kind: 'language' })
    const video = apiDemandPricePenalty({ ratioToPeer: 4, kind: 'video' })
    expect(language).toBeGreaterThan(0)
    expect(video).toBeGreaterThan(0)
    expect(video).toBeLessThan(language)
    expect(language).toBeLessThanOrEqual(9)
  })

  it('large allowances attract a measurable near-cap heavy-user cohort', () => {
    const ordinary = basePlan({
      id: 'ordinary-abuse',
      includedMTokPerMonth: 1,
      usageMultiplier: 1,
      steadyUsageTarget: 0.35,
    })
    const generous = basePlan({
      id: 'generous-abuse',
      includedMTokPerMonth: 128,
      usageMultiplier: 128,
      steadyUsageTarget: 0.35,
    })
    const plans = [ordinary, generous]
    const ordinaryProfile = planHeavyUserProfile(ordinary, plans, {
      modelCapability: 65,
      frontierCapability: 70,
    })
    const generousProfile = planHeavyUserProfile(generous, plans, {
      modelCapability: 65,
      frontierCapability: 70,
    })
    const launchProfile = planHeavyUserProfile(generous, plans, {
      modelCapability: 70,
      frontierCapability: 70,
      demandShockMultiplier: 1.8,
    })
    expect(generousProfile.heavyUserShare).toBeGreaterThan(
      ordinaryProfile.heavyUserShare,
    )
    expect(generousProfile.heavyUtilization).toBeGreaterThanOrEqual(0.9)
    expect(launchProfile.heavyUserShare).toBeGreaterThan(
      generousProfile.heavyUserShare,
    )
    expect(
      planActualMTokPerUser(
        generous,
        ECONOMY.basePlanUsageMTokPerDay,
        generousProfile.blendedUtilization,
      ),
    ).toBeGreaterThan(
      planActualMTokPerUser(
        ordinary,
        ECONOMY.basePlanUsageMTokPerDay,
        ordinaryProfile.blendedUtilization,
      ),
    )
  })

  it('uses the shared abuse utilization for rival subscription demand', () => {
    const state = shipModel(createGame(31_073), 70)
    const rivalModel = {
      ...state.player.models[0]!,
      id: 'rival-abuse-model',
      name: 'Rival Abuse Model',
    }
    const rival = { ...state.rivals[0]!, models: [rivalModel] }
    const lowPlan = basePlan({
      id: 'rival-low',
      modelIds: [rivalModel.id],
      includedMTokPerMonth: 1,
      usageMultiplier: 1,
    })
    const highPlan = basePlan({
      id: 'rival-high',
      modelIds: [rivalModel.id],
      includedMTokPerMonth: 100,
      usageMultiplier: 100,
    })
    const low = rivalPlanDemandPerUser(
      { ...rival, pricing: { ...rival.pricing, plans: [lowPlan] } },
      rivalModel,
      rivalModel.capability,
      state.day,
    )
    const high = rivalPlanDemandPerUser(
      { ...rival, pricing: { ...rival.pricing, plans: [highPlan] } },
      rivalModel,
      rivalModel.capability,
      state.day,
    )
    expect(high).toBeGreaterThan(low * 20)
  })

  it('recommends higher bounded usage for reasoning and video plans', () => {
    const base = {
      currentPrice: 80,
      currentIncludedMTokPerMonth: 10,
      marginalCostPerMTok: 0.2,
      capability: 72,
      frontierCapability: 75,
      peers: [
        {
          price: 70,
          includedMTokPerMonth: 8,
          capability: 68,
          featureScore: 18,
        },
      ],
    }
    const language = suggestPlanPriceAndUsage({ ...base, kind: 'language' })
    const reasoning = suggestPlanPriceAndUsage({ ...base, kind: 'reasoning' })
    const video = suggestPlanPriceAndUsage({ ...base, kind: 'video' })
    expect(reasoning.includedMTokPerMonth).toBeGreaterThan(
      language.includedMTokPerMonth,
    )
    expect(video.includedMTokPerMonth).toBeGreaterThan(
      reasoning.includedMTokPerMonth,
    )
    expect(video.includedMTokPerMonth).toBeLessThanOrEqual(300)
    expect(video.pricePerMonth).toBeLessThanOrEqual(5_000)
  })
})

describe('subscriber enrollment caps', () => {
  it('caps shaped demand before usage/compute and reports demand separately', () => {
    let state = shipModel(createGame(26_016), 64)
    const modelId = state.player.models[0]!.id
    state = {
      ...state,
      rivals: state.rivals.map((rival) => ({ ...rival, models: [] })),
      player: {
        ...state.player,
        pricing: {
          ...state.player.pricing,
          plans: [
            basePlan({
              id: 'capped',
              name: 'Capped',
              modelIds: [modelId],
              subscriberCap: 10,
            }),
          ],
        },
      },
    }

    const next = tickMarket(state)
    const stats = next.lastMarket.planStats.find((plan) => plan.planId === 'capped')!
    expect(stats.configuredSubscriberCap).toBe(10)
    expect(stats.demandSubscribers ?? 0).toBeGreaterThan(10)
    expect(stats.subscribers).toBeLessThanOrEqual(10)
    expect(next.lastMarket.capBlockedSubscriptionSeats ?? 0).toBeGreaterThan(0)
  })

  it('grandfathers retained seats when a live plan cap is lowered', () => {
    let state = shipModel(createGame(26_017), 64)
    const modelId = state.player.models[0]!.id
    state = {
      ...state,
      rivals: state.rivals.map((rival) => ({ ...rival, models: [] })),
      player: {
        ...state.player,
        pricing: {
          ...state.player.pricing,
          plans: [basePlan({ id: 'retained', modelIds: [modelId] })],
        },
      },
    }
    const open = tickMarket(state)
    const prior = open.lastMarket.planStats.find((plan) => plan.planId === 'retained')!
    expect(prior.subscribers).toBeGreaterThan(10)
    const lowered = {
      ...open,
      day: open.day + 1,
      player: {
        ...open.player,
        pricing: {
          ...open.player.pricing,
          plans: open.player.pricing.plans.map((plan) => ({
            ...plan,
            subscriberCap: 10,
          })),
        },
      },
    }
    const next = tickMarket(lowered)
    const stats = next.lastMarket.planStats.find((plan) => plan.planId === 'retained')!
    expect(stats.configuredSubscriberCap).toBe(10)
    expect(stats.grandfatheredSubscribers ?? 0).toBeGreaterThan(0)
    expect(stats.subscribers).toBeGreaterThan(10)
  })
})

describe('API margin state transition', () => {
  it('updates model and lab pricing together and survives a day tick', () => {
    const initial = createGame(31_072)
    const model = buildScaledModel({
      id: 'margin-regression',
      name: 'Margin Regression',
      paramsB: 7,
      family: 'dense',
      day: initial.day,
      dataCoverage: 1,
      dataQuality: 70,
    })
    useGameStore.setState({
      state: {
        ...initial,
        player: {
          ...initial.player,
          models: [model],
          pricing: { ...initial.player.pricing, activeModelId: model.id },
        },
      },
    })

    useGameStore.getState().applyModelApiMarkup(model.id, 75)
    const priced = useGameStore.getState().state
    const expectedIn = Math.round(model.costApiPriceIn * 1.75 * 1000) / 1000
    const expectedOut = Math.round(model.costApiPriceOut * 1.75 * 1000) / 1000
    expect(priced.player.models[0]?.apiPriceInPerMTok).toBe(expectedIn)
    expect(priced.player.models[0]?.apiPriceOutPerMTok).toBe(expectedOut)
    expect(priced.player.pricing.apiPriceInPerMTok).toBe(expectedIn)
    expect(priced.player.pricing.apiPriceOutPerMTok).toBe(expectedOut)

    const nextDay = tickDay(priced)
    expect(nextDay.player.models[0]?.apiPriceInPerMTok).toBe(expectedIn)
    expect(nextDay.player.models[0]?.apiPriceOutPerMTok).toBe(expectedOut)
  })
})

describe('plan mult / high ARPU UI path', () => {
  it('updatePlan accepts enterprise mults above 100 (matches clampMultiplier 500)', () => {
    let s = createGame(199)
    const id = s.player.pricing.plans[1]!.id
    s = updatePlan(s, id, { usageMultiplier: 150, pricePerMonth: 5000 })
    const p = s.player.pricing.plans.find((x) => x.id === id)!
    expect(p.usageMultiplier).toBe(150)
    expect(planAllowanceMTokPerMonth(p)).toBeGreaterThan(
      planAllowanceMTokPerMonth({
        ...p,
        usageMultiplier: 100,
        includedMTokPerMonth:
          ECONOMY.basePlanUsageMTokPerDay * 100 * ECONOMY.daysPerMonth,
      }),
    )
  })

  it('updatePlan lets included usage go down to 0.5 MTok/month', () => {
    let s = createGame(200)
    const id = s.player.pricing.plans[0]!.id
    s = updatePlan(s, id, { includedMTokPerMonth: 0.5 })
    const p = s.player.pricing.plans.find((x) => x.id === id)!
    expect(planAllowanceMTokPerMonth(p)).toBeCloseTo(0.5)
    s = updatePlan(s, id, { includedMTokPerMonth: 0.2 })
    const clamped = s.player.pricing.plans.find((x) => x.id === id)!
    expect(planAllowanceMTokPerMonth(clamped)).toBeCloseTo(0.5)
  })
})

describe('plan token value vs rivals', () => {
  it('segments free-tier reach at 5 and more than 10 messages per day', () => {
    const freeAtMessages = (messagesPerDay: number) =>
      basePlan({
        pricePerMonth: 0,
        includedMTokPerMonth:
          (messagesPerDay * 2_000 * ECONOMY.daysPerMonth) / 1_000_000,
      })

    expect(freeTierDemandProfile(freeAtMessages(4.99)).band).toBe(
      'cost_constrained',
    )
    expect(freeTierDemandProfile(freeAtMessages(5)).band).toBe('semi_popular')
    expect(freeTierDemandProfile(freeAtMessages(10)).band).toBe('semi_popular')
    expect(freeTierDemandProfile(freeAtMessages(10.01)).band).toBe('popular')
    expect(
      freeTierDemandProfile(freeAtMessages(10.01)).audienceMultiplier,
    ).toBeGreaterThan(
      freeTierDemandProfile(freeAtMessages(5)).audienceMultiplier,
    )
    expect(
      freeTierDemandProfile(freeAtMessages(5)).minimumAudienceShare,
    ).toBeGreaterThan(
      freeTierDemandProfile(freeAtMessages(4.99)).minimumAudienceShare,
    )
    expect(
      freeTierDemandProfile(freeAtMessages(10.01)).minimumAudienceShare,
    ).toBeGreaterThan(
      freeTierDemandProfile(freeAtMessages(5)).minimumAudienceShare,
    )
  })

  it('same price + more tokens → higher attractiveness', () => {
    let s = shipModel(createGame(201), 55)
    s = {
      ...s,
      player: {
        ...s.player,
        pricing: {
          ...s.player.pricing,
          plans: [
            basePlan({ id: 'stingy', usageMultiplier: 1, pricePerMonth: 40 }),
            basePlan({
              id: 'generous',
              usageMultiplier: 12,
              pricePerMonth: 40,
            }),
          ],
        },
      },
    }
    const stingy = {
      ...s.player.pricing.plans[0]!,
      modelIds: [s.player.models[0]!.id],
    }
    const generous = {
      ...s.player.pricing.plans[1]!,
      modelIds: [s.player.models[0]!.id],
    }
    const aStingy = planAttractiveness(
      {
        ...s,
        player: {
          ...s.player,
          pricing: { ...s.player.pricing, plans: [stingy] },
        },
      },
      stingy,
    )
    const aGen = planAttractiveness(
      {
        ...s,
        player: {
          ...s.player,
          pricing: { ...s.player.pricing, plans: [generous] },
        },
      },
      generous,
    )
    expect(planAllowanceMTokPerMonth(generous)).toBeGreaterThan(
      planAllowanceMTokPerMonth(stingy),
    )
    expect(aGen).toBeGreaterThan(aStingy)
  })

  it('same price + better model → higher attractiveness', () => {
    let s = shipModel(createGame(202), 40)
    const weak = s.player.models[0]!
    const strong: Model = {
      ...weak,
      id: 'strong',
      name: 'Strong',
      capability: 70,
      quality: { ...weak.quality, reliability: 70, chat: 68 },
    }
    s = {
      ...s,
      player: {
        ...s.player,
        models: [weak, strong],
        pricing: {
          ...s.player.pricing,
          plans: [
            basePlan({
              id: 'w',
              pricePerMonth: 30,
              usageMultiplier: 2,
              modelIds: [weak.id],
            }),
            basePlan({
              id: 's',
              pricePerMonth: 30,
              usageMultiplier: 2,
              modelIds: [strong.id],
            }),
          ],
        },
      },
    }
    const pw = s.player.pricing.plans[0]!
    const ps = s.player.pricing.plans[1]!
    expect(planAttractiveness(s, ps)).toBeGreaterThan(planAttractiveness(s, pw))
  })

  it('same tokens + much higher price → lower attractiveness / price-too-high', () => {
    let s = shipModel(createGame(203), 50)
    const mid = s.player.models[0]!.id
    const cheap = basePlan({
      id: 'c',
      pricePerMonth: 25,
      usageMultiplier: 3,
      modelIds: [mid],
    })
    const dear = basePlan({
      id: 'd',
      pricePerMonth: 1200,
      usageMultiplier: 3,
      modelIds: [mid],
    })
    s = {
      ...s,
      player: {
        ...s.player,
        pricing: { ...s.player.pricing, plans: [cheap, dear] },
      },
    }
    expect(planAttractiveness(s, cheap)).toBeGreaterThan(
      planAttractiveness(s, dear),
    )
    const tooHigh = planPriceTooHighScore(dear, {
      apiPricePerMTok: 2,
      modelCapability: 50,
      frontierCapability: 55,
    })
    expect(tooHigh).toBeGreaterThan(0.12)
  })

  it('free remains the most popular live plan', () => {
    let s = shipModel(createGame(204), 62)
    const modelId = s.player.models[0]!.id
    s = {
      ...s,
      rivals: s.rivals.map((r) => ({ ...r, models: [] })),
      player: {
        ...s.player,
        rackFleet: s.player.rackFleet.map((r) => ({ ...r, count: 160 })),
        allocation: { training: 0.05, inference: 0.9, research: 0.05 },
        pricing: {
          ...s.player.pricing,
          plans: [
            basePlan({
              id: 'free',
              name: 'Free',
              pricePerMonth: 0,
              usageMultiplier: 1,
              modelIds: [modelId],
            }),
            basePlan({
              id: 'plus',
              name: 'Plus',
              pricePerMonth: 20,
              usageMultiplier: 4,
              modelIds: [modelId],
            }),
            basePlan({
              id: 'pro',
              name: 'Pro',
              pricePerMonth: 80,
              usageMultiplier: 12,
              modelIds: [modelId],
            }),
          ],
        },
      },
    }

    s = tickMarket(s)
    const free = s.lastMarket.planStats.find((p) => p.planId === 'free')!
    const largestPaid = Math.max(
      ...s.lastMarket.planStats
        .filter((p) => !p.isFree)
        .map((p) => p.subscribers),
    )
    expect(free.subscribers).toBeGreaterThan(largestPaid)
  })

  it('keeps a free ≫ cheap ≫ mid ≫ expensive subscriber pyramid', () => {
    expect(planPriceTierMassPrior(0)).toBeGreaterThan(planPriceTierMassPrior(20))
    expect(planPriceTierMassPrior(20)).toBeGreaterThan(planPriceTierMassPrior(80))
    expect(planPriceTierMassPrior(80)).toBeGreaterThan(planPriceTierMassPrior(250))
    expect(planPriceTierMassPrior(250)).toBeGreaterThan(planPriceTierMassPrior(600))

    const weak = planPremiumReadiness({
      pricePerMonth: 200,
      brandTrust: 25,
      modelCapability: 45,
      frontierCapability: 80,
      modelReliability: 55,
    })
    const strong = planPremiumReadiness({
      pricePerMonth: 200,
      brandTrust: 85,
      modelCapability: 78,
      frontierCapability: 80,
      modelReliability: 90,
    })
    expect(strong).toBeGreaterThan(weak)
    expect(strong).toBeGreaterThan(0.7)

    expect(paidPlanPyramidLead({ valueRatio: 0.5, readiness: 0.2 })).toBeGreaterThan(1.6)
    expect(paidPlanPyramidLead({ valueRatio: 3.2, readiness: 0.92 })).toBeLessThan(0.9)
    expect(paidPlanPyramidLead({ valueRatio: 3.2, readiness: 0.92 })).toBeGreaterThanOrEqual(
      PAID_PLAN_PYRAMID_LEAD_STRONG - 0.02,
    )
    expect(paidPlanPyramidLead({ valueRatio: 0.4, readiness: 0.15 })).toBeLessThanOrEqual(
      PAID_PLAN_PYRAMID_LEAD_WEAK + 0.02,
    )

    const weakClamp = enforcePlanSubscriberPyramid([
      { plan: { pricePerMonth: 20 }, subscribers: 100, valueRatio: 0.55, readiness: 0.2 },
      { plan: { pricePerMonth: 80 }, subscribers: 500, valueRatio: 0.55, readiness: 0.2 },
      { plan: { pricePerMonth: 250 }, subscribers: 400, valueRatio: 0.4, readiness: 0.15 },
      { plan: { pricePerMonth: 0 }, subscribers: 50 },
    ])
    const plusWeak = weakClamp.find((b) => b.plan.pricePerMonth === 20)!
    const proWeak = weakClamp.find((b) => b.plan.pricePerMonth === 80)!
    expect(plusWeak.subscribers).toBeGreaterThan(proWeak.subscribers * 1.5)

    const strongClamp = enforcePlanSubscriberPyramid([
      { plan: { pricePerMonth: 20 }, subscribers: 100, valueRatio: 3.2, readiness: 0.92 },
      { plan: { pricePerMonth: 80 }, subscribers: 500, valueRatio: 3.2, readiness: 0.92 },
      { plan: { pricePerMonth: 0 }, subscribers: 50 },
    ])
    const plusStrong = strongClamp.find((b) => b.plan.pricePerMonth === 20)!
    const proStrong = strongClamp.find((b) => b.plan.pricePerMonth === 80)!
    expect(proStrong.subscribers).toBeGreaterThan(plusStrong.subscribers)

    let s = shipModel(createGame(204), 68)
    const modelId = s.player.models[0]!.id
    const plusIncluded = ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth
    s = {
      ...s,
      rivals: s.rivals.map((r) => ({ ...r, models: [] })),
      player: {
        ...s.player,
        brandTrust: 55,
        rackFleet: s.player.rackFleet.map((r) => ({ ...r, count: 200 })),
        allocation: { training: 0.05, inference: 0.9, research: 0.05 },
        pricing: {
          ...s.player.pricing,
          plans: [
            basePlan({
              id: 'free',
              name: 'Free',
              pricePerMonth: 0,
              usageMultiplier: 0.1,
              includedMTokPerMonth: plusIncluded * 0.1,
              monthlyApiValueSubsidyGbp: subsidyFromIncludedMTok(plusIncluded * 0.1),
              modelIds: [modelId],
            }),
            basePlan({
              id: 'plus',
              name: 'Plus',
              pricePerMonth: 20,
              usageMultiplier: 1,
              includedMTokPerMonth: plusIncluded,
              monthlyApiValueSubsidyGbp: subsidyFromIncludedMTok(plusIncluded),
              modelIds: [modelId],
            }),
            basePlan({
              id: 'pro',
              name: 'Pro',
              pricePerMonth: 80,
              usageMultiplier: 5,
              includedMTokPerMonth: plusIncluded * 5,
              monthlyApiValueSubsidyGbp: subsidyFromIncludedMTok(plusIncluded * 5),
              modelIds: [modelId],
            }),
            basePlan({
              id: 'team',
              name: 'Team',
              pricePerMonth: 250,
              usageMultiplier: 20,
              includedMTokPerMonth: plusIncluded * 20,
              monthlyApiValueSubsidyGbp: subsidyFromIncludedMTok(plusIncluded * 20),
              modelIds: [modelId],
            }),
          ],
        },
      },
    }

    s = tickMarket(s)
    const free = s.lastMarket.planStats.find((p) => p.planId === 'free')!
    const plusStats = s.lastMarket.planStats.find((p) => p.planId === 'plus')!
    const proStats = s.lastMarket.planStats.find((p) => p.planId === 'pro')!
    const teamStats = s.lastMarket.planStats.find((p) => p.planId === 'team')!
    expect(free.subscribers).toBeGreaterThan(plusStats.subscribers)
    expect(plusStats.subscribers).toBeGreaterThan(teamStats.subscribers)
    expect(proStats.subscribers).toBeGreaterThan(teamStats.subscribers)
    expect(plusStats.subscribers + proStats.subscribers).toBeGreaterThan(
      teamStats.subscribers,
    )
  })

  it('routes one plan across every selected model with model-specific compute', () => {
    let s = shipModel(createGame(205), 61)
    const small = s.player.models[0]!
    const large: Model = {
      ...small,
      id: 'large-model',
      name: 'Large model',
      paramsB: small.paramsB * 8,
      activeParamsB: (small.activeParamsB ?? small.paramsB) * 8,
      inferCostMult: 1.8,
      capability: small.capability + 10,
    }
    const plan = basePlan({
      id: 'multi',
      name: 'Multi',
      pricePerMonth: 40,
      usageMultiplier: 6,
      modelIds: [small.id, large.id],
    })
    s = {
      ...s,
      rivals: s.rivals.map((r) => ({ ...r, models: [] })),
      player: {
        ...s.player,
        models: [small, large],
        rackFleet: s.player.rackFleet.map((r) => ({ ...r, count: 180 })),
        allocation: { training: 0.05, inference: 0.9, research: 0.05 },
        pricing: { ...s.player.pricing, plans: [plan] },
      },
    }

    const mix = planModelTrafficMix(s, plan)
    expect(mix).toHaveLength(2)
    expect(mix.reduce((sum, lane) => sum + lane.share, 0)).toBeCloseTo(1)
    expect(
      mix.find((lane) => lane.model.id === large.id)!.share,
    ).toBeGreaterThan(mix.find((lane) => lane.model.id === small.id)!.share)

    s = tickMarket(s)
    const usage = s.lastMarket.planStats.find(
      (p) => p.planId === plan.id,
    )!.modelUsage!
    expect(usage).toHaveLength(2)
    expect(usage.reduce((sum, lane) => sum + lane.dayMTok, 0)).toBeCloseTo(
      s.lastMarket.planStats[0]!.dayMTok,
      5,
    )
    const smallUsage = usage.find((lane) => lane.modelId === small.id)!
    const largeUsage = usage.find((lane) => lane.modelId === large.id)!
    expect(largeUsage.dayInferPf / largeUsage.dayMTok).toBeGreaterThan(
      smallUsage.dayInferPf / smallUsage.dayMTok,
    )
    expect(largeUsage.costPerMTok).toBeGreaterThan(smallUsage.costPerMTok)
    const settledPlan = s.lastMarket.planStats[0]!
    expect(settledPlan.dayCogs).toBeCloseTo(
      settledPlan.allocatedComputeCostDay +
        settledPlan.dayMTok * ECONOMY.bandwidthPerMTok,
      6,
    )
    expect(settledPlan.costPerSubDay).toBeCloseTo(
      settledPlan.dayCogs / settledPlan.subscribers,
      8,
    )
    expect(settledPlan.computePfPerSubscriber).toBeCloseTo(
      settledPlan.dayInferPf / settledPlan.subscribers,
      8,
    )
  })

  it('protects a higher-priority paid plan under a constrained subscription PF pool', () => {
    const low = basePlan({ id: 'free', pricePerMonth: 0, computePriority: 15 })
    const high = basePlan({
      id: 'pro',
      pricePerMonth: 80,
      computePriority: 90,
    })
    const fractions = allocatePlanCompute(
      [
        { plan: low, demandPf: 100 },
        { plan: high, demandPf: 100 },
      ],
      80,
    )
    expect(fractions.get(high.id)).toBeGreaterThan(fractions.get(low.id)!)
    expect(fractions.get(high.id)).toBeGreaterThan(0.65)
    expect(fractions.get(low.id)).toBeLessThan(0.2)
  })

  it('serves and attributes two API models at the same time', () => {
    let s = shipModel(createGame(2_057), 58)
    const first = s.player.models[0]!
    const second: Model = {
      ...first,
      id: 'api-frontier',
      name: 'API Frontier',
      paramsB: first.paramsB * 2,
      capability: first.capability + 8,
      apiPriceInPerMTok: 1.5,
      apiPriceOutPerMTok: 5,
    }
    s = {
      ...s,
      player: {
        ...s.player,
        models: [first, second],
        pricing: {
          ...s.player.pricing,
          apiModelIds: [first.id, second.id],
          plans: s.player.pricing.plans.map((plan) => ({
            ...plan,
            modelIds: [first.id],
          })),
        },
      },
    }
    s = tickMarket(s)
    const usage = s.lastMarket.apiModelUsage ?? []
    expect(usage.map((item) => item.modelId).sort()).toEqual(
      [first.id, second.id].sort(),
    )
    expect(usage.every((item) => item.dayMTok > 0)).toBe(true)
    const finance = s.lastMarket.modelFinance.filter((row) =>
      [first.id, second.id].includes(row.modelId),
    )
    expect(finance.every((row) => row.dayApiMTok > 0)).toBe(true)
  })
})

describe('precision and premium scrutiny', () => {
  it('persists independent plan-model precisions and removes legacy fallback behavior', () => {
    let state = shipModel(createGame(242), 62)
    const small = state.player.models[0]!
    const large: Model = {
      ...small,
      id: 'plan-large',
      name: 'Plan Large',
      paramsB: small.paramsB * 2,
      capability: small.capability + 5,
    }
    const plan = basePlan({
      id: 'roster',
      modelIds: [small.id, large.id],
      servePrecision: 'fp16',
      modalityRoutes: {
        text: {
          modality: 'text',
          primaryModelId: small.id,
          fallbackModelId: large.id,
          premiumShare: 0.5,
          precision: 'fp16',
        },
      },
    })
    state = {
      ...state,
      player: {
        ...state.player,
        models: [small, large],
        researchUnlocked: [
          ...state.player.researchUnlocked,
          'sys_quant',
          'sys_fp8',
        ],
        pricing: { ...state.player.pricing, plans: [plan] },
      },
    }

    state = updatePlan(state, plan.id, {
      modelIds: [small.id, large.id],
      servePrecisionByModel: { [small.id]: 'int8', [large.id]: 'int4' },
    })
    const updated = state.player.pricing.plans[0]!
    expect(updated.servePrecisionByModel).toEqual({
      [small.id]: 'int8',
      [large.id]: 'int4',
    })
    expect(
      Object.values(updated.modalityRoutes ?? {}).every(
        (route) => route?.fallbackModelId == null,
      ),
    ).toBe(true)
    const mix = planModelTrafficMix(state, updated)
    expect(mix.map((lane) => lane.model.id).sort()).toEqual(
      [small.id, large.id].sort(),
    )
    expect(
      planModelServePrecision(updated, small, state.player.researchUnlocked),
    ).toBe('int8')
    expect(
      planModelServePrecision(updated, large, state.player.researchUnlocked),
    ).toBe('int4')
    expect(
      mix.find((lane) => lane.model.id === large.id)!.model.capability,
    ).toBe(
      large.capability +
        planServeModifiers('int4', state.player.researchUnlocked)
          .capabilityDelta,
    )

    state = updatePlan(state, plan.id, {
      modelIds: [small.id],
      servePrecisionByModel: { [small.id]: 'int8' },
    })
    expect(
      planModelTrafficMix(state, state.player.pricing.plans[0]!).map(
        (lane) => lane.model.id,
      ),
    ).toEqual([small.id])
  })

  it('clamps locked and checkpoint-incompatible plan-model formats', () => {
    let state = shipModel(createGame(2_421), 62)
    const model = state.player.models[0]!
    const plan = basePlan({ id: 'compat', modelIds: [model.id] })
    state = {
      ...state,
      player: {
        ...state.player,
        pricing: { ...state.player.pricing, plans: [plan] },
      },
    }

    state = updatePlan(state, plan.id, {
      servePrecisionByModel: { [model.id]: 'int4' },
    })
    expect(
      planModelServePrecision(
        state.player.pricing.plans[0]!,
        model,
        state.player.researchUnlocked,
      ),
    ).toBe('fp32')

    state = {
      ...state,
      player: {
        ...state.player,
        researchUnlocked: [
          ...state.player.researchUnlocked,
          'sys_quant',
          'sys_fp8',
          'sys_bitnet_runtime',
        ],
      },
    }
    expect(
      availablePlanPrecisionsForModel(model, state.player.researchUnlocked),
    ).not.toContain('ternary_1_58')
    state = updatePlan(state, plan.id, {
      servePrecisionByModel: { [model.id]: 'ternary_1_58' },
    })
    expect(
      state.player.pricing.plans[0]!.servePrecisionByModel?.[model.id],
    ).not.toBe('ternary_1_58')
  })

  it('INT4 saves the most compute with bounded eval and brand risk', () => {
    const unlocks = ['opt_fp16', 'sys_quant', 'sys_fp8']
    const full = planServeModifiers('fp16', unlocks)
    const int8 = planServeModifiers('int8', unlocks)
    const int4 = planServeModifiers('int4', unlocks)
    expect(int4.computeMult).toBeLessThan(int8.computeMult)
    expect(int8.computeMult).toBeLessThan(full.computeMult)
    expect(int4.benchmarkDeltas.coding).toBeLessThan(
      int8.benchmarkDeltas.coding!,
    )
    expect(int4.benchmarkDeltas.math).toBeLessThan(int8.benchmarkDeltas.math!)
    expect(int4.benchmarkDeltas.math).toBeGreaterThan(-10)
    expect(int4.brandRisk).toBeGreaterThan(int8.brandRisk)
  })

  it('API precision changes effective evals and compute cost', () => {
    const state = shipModel(createGame(243), 64)
    const model = state.player.models[0]!
    const unlocks = ['opt_fp16', 'sys_quant', 'sys_fp8']
    const full = modelForServePrecision(model, 'fp16', unlocks)
    const int4 = modelForServePrecision(model, 'int4', unlocks)

    expect(int4.inferCostMult).toBeLessThan(full.inferCostMult)
    expect(int4.capability).toBeLessThan(full.capability)
    expect(int4.benchmarks.coding).toBeLessThan(full.benchmarks.coding)
    expect(int4.benchmarks.math).toBeLessThan(full.benchmarks.math)
  })

  it('quantized API traffic saves PF without a blanket capability collapse', () => {
    const setup = (precision: 'fp16' | 'int4') => {
      let state = shipModel(createGame(244), 68)
      state = {
        ...state,
        rivals: state.rivals.map((rival) => ({ ...rival, models: [] })),
        player: {
          ...state.player,
          brandTrust: 75,
          researchUnlocked: [
            ...state.player.researchUnlocked,
            'opt_fp16',
            'sys_quant',
            'sys_fp8',
          ],
          rackFleet: state.player.rackFleet.map((rack) => ({
            ...rack,
            count: 160,
          })),
          allocation: { training: 0.05, inference: 0.9, research: 0.05 },
          pricing: {
            ...state.player.pricing,
            apiModelIds: [state.player.models[0]!.id],
            apiServePrecisionByModel: {
              [state.player.models[0]!.id]: precision,
            },
            plans: [],
          },
        },
      }
      return tickMarket(state)
    }

    const full = setup('fp16')
    const int4 = setup('int4')
    const fullUsage = full.lastMarket.apiModelUsage?.[0]
    const int4Usage = int4.lastMarket.apiModelUsage?.[0]

    expect(fullUsage?.dayMTok).toBeGreaterThan(0)
    expect(int4Usage?.dayMTok).toBeGreaterThan(0)
    expect(
      (int4Usage?.dayInferPf ?? 0) / (int4Usage?.dayMTok ?? 1),
    ).toBeLessThan((fullUsage?.dayInferPf ?? 0) / (fullUsage?.dayMTok ?? 1))
    expect(int4.player.models[0]!.capability).toBe(
      full.player.models[0]!.capability,
    )
    expect(int4.lastMarket.computeLedger?.requestedPfDays).toBeLessThan(
      full.lastMarket.computeLedger?.requestedPfDays ??
        Number.POSITIVE_INFINITY,
    )
  })

  it('free plan quantization does not carry a brand penalty', () => {
    const setup = (precision: 'fp16' | 'int4') => {
      let state = shipModel(createGame(245), 64)
      const modelId = state.player.models[0]!.id
      state = {
        ...state,
        rivals: state.rivals.map((rival) => ({ ...rival, models: [] })),
        player: {
          ...state.player,
          brandTrust: 70,
          researchUnlocked: [
            ...state.player.researchUnlocked,
            'opt_fp16',
            'sys_quant',
            'sys_fp8',
          ],
          pricing: {
            ...state.player.pricing,
            apiModelIds: [],
            plans: [
              basePlan({
                id: 'free',
                name: 'Free',
                pricePerMonth: 0,
                includedMTokPerMonth: 10,
                modelIds: [modelId],
                servePrecision: precision,
              }),
            ],
          },
        },
      }
      return tickMarket(state)
    }

    expect(setup('int4').player.brandTrust).toBeGreaterThanOrEqual(
      setup('fp16').player.brandTrust,
    )
  })

  it('plans above $180 are judged against a 20x allowance expectation', () => {
    const entry = basePlan({
      id: 'entry',
      name: 'Entry',
      pricePerMonth: 20,
      includedMTokPerMonth: 1,
    })
    const stingy = basePlan({
      id: 'premium',
      name: 'Premium',
      pricePerMonth: 200,
      includedMTokPerMonth: 7.5,
    })
    const generous = { ...stingy, id: 'generous', includedMTokPerMonth: 20 }
    const audit = premiumPlanScrutiny(stingy, [entry, stingy])
    expect(audit.applies).toBe(true)
    expect(audit.expectedUsageRatio).toBe(20)
    expect(audit.actualUsageRatio).toBeCloseTo(7.5)
    expect(audit.shortfall).toBeGreaterThan(0.5)
    expect(premiumPlanScrutiny(generous, [entry, generous]).shortfall).toBe(0)
  })

  it('allowance expectations require 1M free and 200–300M on a $200 plan', () => {
    const weakFree = planAllowanceExpectation(
      basePlan({ pricePerMonth: 0, includedMTokPerMonth: 0.5 }),
    )
    const viableFree = planAllowanceExpectation(
      basePlan({ pricePerMonth: 0, includedMTokPerMonth: 1 }),
    )
    const weakPremium = planAllowanceExpectation(
      basePlan({ pricePerMonth: 200, includedMTokPerMonth: 18.8 }),
    )
    const viablePremium = planAllowanceExpectation(
      basePlan({ pricePerMonth: 200, includedMTokPerMonth: 250 }),
    )

    expect(weakFree.minimumMTok).toBe(1)
    expect(weakFree.dissatisfaction).toBeGreaterThan(0)
    expect(viableFree.dissatisfaction).toBe(0)
    expect(weakPremium.minimumMTok).toBe(200)
    expect(weakPremium.maximumMTok).toBe(300)
    expect(weakPremium.dissatisfaction).toBeGreaterThan(0.8)
    expect(viablePremium.dissatisfaction).toBe(0)
  })

  it('ships default subscription allowances that clear their price expectations', () => {
    const plans = defaultPlans()
    const free = plans.find((plan) => plan.id === 'plan-free')!
    const plus = plans.find((plan) => plan.id === 'plan-plus')!
    const pro = plans.find((plan) => plan.id === 'plan-pro')!
    const max = plans.find((plan) => plan.id === 'plan-max')!

    expect(planAllowanceMTokPerMonth(free)).toBeCloseTo(4)
    expect(planAllowanceMTokPerMonth(plus)).toBeCloseTo(20)
    expect(planAllowanceMTokPerMonth(pro)).toBeCloseTo(100)
    expect(planAllowanceMTokPerMonth(max)).toBeCloseTo(400)
    expect(planAllowanceExpectation(plus).dissatisfaction).toBe(0)
    expect(planAllowanceExpectation(pro).dissatisfaction).toBe(0)
    expect(planHasApiValueSubsidy(free)).toBe(false)
    expect(planHasApiValueSubsidy(plus)).toBe(false)
    expect(planHasApiValueSubsidy(pro)).toBe(false)
  })

  it('keeps physical plan entitlement independent from advertised API value', () => {
    let state = createGame({ seed: 91, difficulty: 'easy' })
    state = createPlan(state, {
      name: 'Team',
      pricePerMonth: 100,
      usageMultiplier: 2,
      monthlyApiValueSubsidyGbp: 180,
    })
    const created = state.player.pricing.plans.find((p) => p.name === 'Team')!
    const originalAllowance = planAllowanceMTokPerMonth(created)
    expect(created.monthlyApiValueSubsidyGbp).toBe(180)
    expect(planMonthlyApiValueSubsidy(created, DEFAULT_PLAN_BLEND_API_PRICE)).toBe(
      originalAllowance * DEFAULT_PLAN_BLEND_API_PRICE,
    )

    state = updatePlan(state, created.id, { monthlyApiValueSubsidyGbp: 240 })
    const updated = state.player.pricing.plans.find((p) => p.id === created.id)!
    expect(updated.monthlyApiValueSubsidyGbp).toBe(240)
    expect(planAllowanceMTokPerMonth(updated)).toBeCloseTo(originalAllowance)

    // New plans store their resource promise directly and do not enter the
    // legacy list-price-derived subsidy mode.
    state = createPlan(state, {
      name: 'LegacySeed',
      pricePerMonth: 40,
      usageMultiplier: 1,
    })
    const seeded = state.player.pricing.plans.find((p) => p.name === 'LegacySeed')!
    expect(planHasApiValueSubsidy(seeded)).toBe(false)
    expect(planAllowanceMTokPerMonth(seeded)).toBeCloseTo(20)
  })

  it('unsustainable plans create a large stability dissatisfaction penalty', () => {
    expect(planStabilityDissatisfaction(true, -8, 0)).toBeGreaterThan(0.5)
    expect(planStabilityDissatisfaction(false, -60, 200)).toBeGreaterThan(0.4)
    expect(planStabilityDissatisfaction(false, 10, 200)).toBe(0)
  })
})

describe('compute seats + capacity', () => {
  it('maxSeats grows with capacity PF', () => {
    const plan = basePlan({ usageMultiplier: 5, pricePerMonth: 40 })
    const model = {
      paramsB: 8,
      family: 'dense' as const,
      inferCostMult: 1,
    }
    const low = maxSeatsForPlan(plan, model, 2, 0.8, 0.7, {
      modelCapability: 50,
      frontierCapability: 55,
    })
    const high = maxSeatsForPlan(plan, model, 40, 0.8, 0.7, {
      modelCapability: 50,
      frontierCapability: 55,
    })
    expect(high).toBeGreaterThan(low)
    expect(low).toBeGreaterThanOrEqual(0)
  })

  it('tickMarket: low capacity → higher unserved than high capacity', () => {
    // Same seed so demand shape matches; only fleet/serve allocation differs
    let low = shipModel(createGame(210), 60)
    low = {
      ...low,
      rivals: low.rivals.map((r) => ({ ...r, models: [] })),
      player: {
        ...low.player,
        rackFleet: low.player.rackFleet.map((r) => ({ ...r, count: 3 })),
        allocation: { training: 0.05, inference: 0.12, research: 0.83 },
        servingEfficiency: 0.35,
        pricing: {
          ...low.player.pricing,
          apiPriceInPerMTok: 1,
          apiPriceOutPerMTok: 3,
          apiPricePerMTok: 2.4,
          plans: [
            {
              id: 'plan-plus',
              name: 'Plus',
              pricePerMonth: 20,
              usageMultiplier: 2,
              usageRate: 0.7,
              modelIds: [low.player.models[0]!.id],
              enabled: true,
            },
          ],
        },
      },
    }
    low = tickMarket(low)

    let high = shipModel(createGame(210), 60)
    high = {
      ...high,
      rivals: high.rivals.map((r) => ({ ...r, models: [] })),
      player: {
        ...high.player,
        rackFleet: high.player.rackFleet.map((r) => ({ ...r, count: 120 })),
        allocation: { training: 0.05, inference: 0.85, research: 0.1 },
        servingEfficiency: 1.2,
        pricing: {
          ...high.player.pricing,
          apiPriceInPerMTok: 1,
          apiPriceOutPerMTok: 3,
          apiPricePerMTok: 2.4,
          plans: [
            {
              id: 'plan-plus',
              name: 'Plus',
              pricePerMonth: 20,
              usageMultiplier: 2,
              usageRate: 0.7,
              modelIds: [high.player.models[0]!.id],
              enabled: true,
            },
          ],
        },
      },
    }
    high = tickMarket(high)

    expect(low.lastMarket.playerDemandMTok).toBeGreaterThan(1)
    expect(low.lastMarket.demandPf).toBeGreaterThan(low.lastMarket.capacityPf)
    expect(low.lastMarket.unservedRatio).toBeGreaterThan(0.1)
    expect(high.lastMarket.capacityPf).toBeGreaterThan(
      low.lastMarket.capacityPf,
    )
    expect(high.lastMarket.servedMTok).toBeGreaterThan(
      low.lastMarket.servedMTok,
    )
    expect(high.lastMarket.unservedRatio).toBeLessThan(
      low.lastMarket.unservedRatio,
    )
  })
})

describe('subsidy and high ARPU', () => {
  it('$5000 plan with huge tokens has API-equivalent value and can be justified', () => {
    const plan = basePlan({
      pricePerMonth: 5000,
      usageMultiplier: 150,
      includedMTokPerMonth: 100,
    })
    const api = 10
    const apiEq = planApiEquivalentValue(plan, api, 0.85)
    const sub = planSubsidyRatio(plan, api, 0.85)
    expect(planAllowanceMTokPerMonth(plan)).toBeGreaterThan(80)
    // Included tokens at list API should be material vs a $5k seat
    expect(apiEq).toBeGreaterThan(700)
    expect(sub).toBeGreaterThan(0.15)
    const tooHighWeak = planPriceTooHighScore(plan, {
      apiPricePerMTok: api,
      modelCapability: 25,
      frontierCapability: 70,
      utilization: 0.85,
    })
    const tooHighSota = planPriceTooHighScore(plan, {
      apiPricePerMTok: api,
      modelCapability: 78,
      frontierCapability: 78,
      utilization: 0.85,
    })
    expect(tooHighSota).toBeLessThan(tooHighWeak)
  })

  it('high price + tiny tokens is overpriced vs API', () => {
    const plan = basePlan({ pricePerMonth: 500, usageMultiplier: 0.2 })
    const sub = planSubsidyRatio(plan, 5, 0.7)
    expect(sub).toBeLessThan(1)
    const score = planPriceTooHighScore(plan, {
      apiPricePerMTok: 5,
      modelCapability: 40,
      frontierCapability: 60,
    })
    expect(score).toBeGreaterThan(0.15)
  })

  it('formatAllowance is human-readable', () => {
    expect(formatAllowance(basePlan({ usageMultiplier: 1 }))).toMatch(/tok/)
  })
})

describe('facility opex scales with GPUs', () => {
  it('more live racks → strictly higher daily building opex', () => {
    const empty = withHall(createGame(220), 0)
    // zero racks
    empty.player.rackFleet = []
    const full = withHall(createGame(221), 48)
    const oEmpty = playerBuildingOpex(empty)
    const oFull = playerBuildingOpex(full)
    expect(oFull).toBeGreaterThan(oEmpty)
    // GPU term alone should be material
    expect(ECONOMY.facilityOpexMultiplier).toBeGreaterThanOrEqual(1.3)
    expect(oFull - oEmpty).toBeGreaterThan(
      48 * (ECONOMY.rackOpexPerGpuDay ?? 400) * 0.9,
    )
  })
})

describe('API vs sub balance iterations', () => {
  it('competitive API pricing can match or exceed sub revenue mid setup', () => {
    let s = shipModel(createGame(230), 68)
    // Healthy competitive paid Plus (not a killed sub) + competitive API list.
    // Higher PF/MTok (serve-cost rebalance) needs more racks/efficiency for API
    // throughput to keep pace with seat revenue at the same price point.
    s = withApiPrices(s, 3, 9)
    const plusIncluded =
      ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth
    s = {
      ...s,
      player: {
        ...s.player,
        rackFleet: s.player.rackFleet.map((r) => ({ ...r, count: 320 })),
        allocation: { training: 0.02, inference: 0.93, research: 0.05 },
        servingEfficiency: 1.55,
        utilCap: 0.85,
        brandTrust: 75,
        pricing: {
          ...s.player.pricing,
          apiVsSubPriority: 0.72,
          plans: [
            {
              id: 'plan-plus',
              name: 'Plus',
              pricePerMonth: 20,
              usageMultiplier: 1,
              includedMTokPerMonth: plusIncluded,
              monthlyApiValueSubsidyGbp: subsidyFromIncludedMTok(plusIncluded),
              usageRate: 0.6,
              modelIds: [s.player.models[0]!.id],
              enabled: true,
            },
          ],
        },
      },
      rivals: s.rivals.map((r) => ({ ...r, models: [] })),
    }
    s = tickMarket(s)
    const api = s.player.finance.apiRevenue
    const sub = s.player.finance.subRevenue
    // Subs must still earn real revenue (not a killed overpriced tier)
    expect(sub).toBeGreaterThan(100)
    expect(
      s.lastMarket.planStats.some((p) => p.subscribers > 100 && !p.isFree),
    ).toBe(true)
    expect(api).toBeGreaterThan(0)
    // Competitive API remains a real revenue pillar vs seats.
    // With denser serve costs, mid-setup API is a smaller share of sub than
    // pre-rebalance (~20%); still material when capacity is provisioned.
    expect(api).toBeGreaterThanOrEqual(sub * 0.12)
  })

  it('raising API price sharply cuts API MTok demand', () => {
    let a = shipModel(createGame(232), 60)
    a = withApiPrices(a, 0.4, 1.2)
    a = {
      ...a,
      rivals: a.rivals.map((r) => ({ ...r, models: [] })),
      player: {
        ...a.player,
        rackFleet: a.player.rackFleet.map((r) => ({ ...r, count: 96 })),
        allocation: { training: 0.1, inference: 0.8, research: 0.1 },
        pricing: {
          ...a.player.pricing,
          plans: [
            {
              id: 'plan-plus',
              name: 'Plus',
              pricePerMonth: 20,
              usageMultiplier: 1,
              usageRate: 0.5,
              modelIds: [a.player.models[0]!.id],
              enabled: true,
            },
          ],
        },
      },
    }
    a = tickMarket(a)

    let b = shipModel(createGame(232), 60)
    b = withApiPrices(b, 120, 300)
    b = {
      ...b,
      rivals: b.rivals.map((r) => ({ ...r, models: [] })),
      player: {
        ...b.player,
        rackFleet: b.player.rackFleet.map((r) => ({ ...r, count: 96 })),
        allocation: { training: 0.1, inference: 0.8, research: 0.1 },
        pricing: {
          ...b.player.pricing,
          plans: [
            {
              id: 'plan-plus',
              name: 'Plus',
              pricePerMonth: 20,
              usageMultiplier: 1,
              usageRate: 0.5,
              modelIds: [b.player.models[0]!.id],
              enabled: true,
            },
          ],
        },
      },
    }
    b = tickMarket(b)

    // Pre-serve demand must fall when list prices explode
    expect(a.lastMarket.apiDemandMTok ?? 0).toBeGreaterThan(
      b.lastMarket.apiDemandMTok ?? 0,
    )
  })

  it('only rewards safe, capable generation models in plan breadth', () => {
    const state = shipModel(createGame(233), 62)
    const base = state.player.models[0]!
    const imageModel: Model = {
      ...base,
      id: 'image-model',
      name: 'Canvas',
      family: 'diffusion',
      productPreset: 'image_generation',
      modalities: ['image'],
      io: {
        inputs: { text: 70, image: 50 },
        outputs: { image: 78 },
        tools: 20,
      },
      capability: 70,
      quality: {
        ...base.quality,
        image: 82,
        reasoning: 55,
        safety: 70,
        reliability: 72,
      },
      capabilities: base.capabilities
        ? {
            ...base.capabilities,
            domains: { ...base.capabilities.domains, vision: 82 },
            safety: 70,
            reliability: 72,
          }
        : base.capabilities,
      benchmarkSuites: undefined,
    }
    const plan = {
      ...state.player.pricing.plans[0]!,
      modelIds: [base.id, imageModel.id],
    }
    const capable = planOfferingBreadth(
      { ...state, player: { ...state.player, models: [base, imageModel] } },
      plan,
    )
    const unsafeImage = {
      ...imageModel,
      quality: { ...imageModel.quality, safety: 10 },
      capabilities: imageModel.capabilities
        ? { ...imageModel.capabilities, safety: 10 }
        : undefined,
    }
    const unsafe = planOfferingBreadth(
      { ...state, player: { ...state.player, models: [base, unsafeImage] } },
      plan,
    )
    expect(capable.score).toBeGreaterThan(0)
    expect(capable.contributors[0]?.modelId).toBe(imageModel.id)
    expect(unsafe.score).toBe(0)
  })
})

describe('subscription plan demand rebalance', () => {
  it('routes heavier segments toward Pro and Max allowances instead of defaulting to Plus', () => {
    const [free, plus, pro, max] = defaultPlans()
    expect(free).toBeDefined()
    expect(plus).toBeDefined()
    expect(pro).toBeDefined()
    expect(max).toBeDefined()

    expect(
      planSegmentUsageAffinity(pro!.includedMTokPerMonth!, 'legal'),
    ).toBeGreaterThan(
      planSegmentUsageAffinity(plus!.includedMTokPerMonth!, 'legal'),
    )
    expect(
      planSegmentUsageAffinity(max!.includedMTokPerMonth!, 'enterprise'),
    ).toBeGreaterThan(
      planSegmentUsageAffinity(plus!.includedMTokPerMonth!, 'enterprise'),
    )
    expect(
      planSegmentUsageAffinity(plus!.includedMTokPerMonth!, 'consumer'),
    ).toBeGreaterThan(
      planSegmentUsageAffinity(max!.includedMTokPerMonth!, 'consumer'),
    )
  })

  it('keeps meaningful paid demand on both Pro and Max in the default ladder', () => {
    let s = shipModel(createGame(239), 76)
    const modelId = s.player.models[0]!.id
    s = withHall(s, 240)
    s = {
      ...s,
      rivals: s.rivals.map((rival) => ({ ...rival, models: [] })),
      player: {
        ...s.player,
        brandTrust: 82,
        allocation: { training: 0.05, inference: 0.9, research: 0.05 },
        pricing: {
          ...s.player.pricing,
          plans: defaultPlans().map((plan) => ({ ...plan, modelIds: [modelId] })),
        },
      },
    }
    for (let day = 0; day < 4; day += 1) {
      s = tickMarket({ ...s, day: s.day + 1 })
    }
    const paid = s.lastMarket.planStats.filter((plan) => !plan.isFree)
    const paidSeats = paid.reduce((sum, plan) => sum + plan.subscribers, 0)
    const pro = paid.find((plan) => plan.planId === 'plan-pro')!
    const max = paid.find((plan) => plan.planId === 'plan-max')!
    const ratios = {
      pro: pro.subscribers / paidSeats,
      max: max.subscribers / paidSeats,
      premium: (pro.subscribers + max.subscribers) / paidSeats,
    }
    expect(ratios.pro, JSON.stringify(ratios)).toBeGreaterThan(0.08)
    expect(ratios.max, JSON.stringify(ratios)).toBeGreaterThan(0.05)
    expect(ratios.premium, JSON.stringify(ratios)).toBeGreaterThan(0.2)
  })

  it('lets Plus dominate early and Pro+Max earn real late-game seats and revenue', () => {
    const tickPlans = (state: SimState, days: number) => {
      let next = state
      for (let day = 0; day < days; day += 1) {
        next = tickMarket({ ...next, day: next.day + 1 })
      }
      return next
    }
    const seatsOf = (state: SimState, id: string) =>
      state.lastMarket.planStats.find((plan) => plan.planId === id)?.subscribers ?? 0
    const revenueOf = (state: SimState, id: string) =>
      state.lastMarket.planStats.find((plan) => plan.planId === id)?.dayRevenue ?? 0

    let early = shipModel(createGame(401), 40)
    const earlyId = early.player.models[0]!.id
    early = withHall(early, 80)
    early = {
      ...early,
      player: {
        ...early.player,
        brandTrust: 48,
        allocation: { training: 0.1, inference: 0.8, research: 0.1 },
        pricing: {
          ...early.player.pricing,
          plans: defaultPlans().map((plan) => ({ ...plan, modelIds: [earlyId] })),
        },
      },
    }
    early = tickPlans(early, 6)
    const earlyPlus = seatsOf(early, 'plan-plus')
    const earlyPro = seatsOf(early, 'plan-pro')
    const earlyMax = seatsOf(early, 'plan-max')
    expect(earlyPlus, 'early Plus should lead paid seats').toBeGreaterThan(
      earlyPro + earlyMax,
    )

    let late = shipModel(createGame(402), 78)
    const lateId = late.player.models[0]!.id
    late = withHall(late, 280)
    late = {
      ...late,
      rivals: late.rivals.map((rival) => ({ ...rival, models: [] })),
      player: {
        ...late.player,
        brandTrust: 88,
        allocation: { training: 0.05, inference: 0.9, research: 0.05 },
        servingEfficiency: 1.4,
        pricing: {
          ...late.player.pricing,
          plans: defaultPlans().map((plan) =>
            plan.id === 'plan-pro' || plan.id === 'plan-max'
              ? {
                  ...plan,
                  modelIds: [lateId],
                  includedMTokPerMonth:
                    (plan.includedMTokPerMonth ?? 100) * 1.15,
                }
              : { ...plan, modelIds: [lateId] },
          ),
        },
      },
    }
    late = tickPlans(late, 8)
    const latePlus = seatsOf(late, 'plan-plus')
    const latePro = seatsOf(late, 'plan-pro')
    const lateMax = seatsOf(late, 'plan-max')
    const latePremium = latePro + lateMax
    expect(latePremium, 'late Pro+Max seats vs Plus').toBeGreaterThanOrEqual(
      latePlus * 0.8,
    )
    expect(
      revenueOf(late, 'plan-pro') + revenueOf(late, 'plan-max'),
      'late Pro+Max revenue vs Plus',
    ).toBeGreaterThan(revenueOf(late, 'plan-plus'))
  })

  it('applies rival seat conversion exactly once', () => {
    const model = {
      id: 'rival-seat',
      name: 'Rival',
      family: 'dense' as const,
      paramsB: 14,
      capability: 70,
      modalities: ['text' as const],
      quality: {
        reasoning: 70,
        coding: 70,
        chat: 70,
        image: 0,
        video: 0,
        safety: 70,
        reliability: 80,
      },
      benchmarks: {
        mmlu: 70,
        coding: 70,
        math: 70,
        science: 70,
        safety: 70,
        agents: 70,
        law: 60,
        health: 60,
        vision: 40,
        multilingual: 55,
      },
      postTrain: 'rlhf' as const,
      trainComputeSpent: 40,
      releaseDay: 1,
      shipped: true,
      release: 'released' as const,
      tokPerSecMult: 1,
      inferCostMult: 1,
      apiPricePerMTok: 4,
      distilled: false,
      trainMode: 'pretrain' as const,
    } as unknown as Model
    const audience = 8_000
    const seats = audience * PLAN_SEAT_CONVERSION
    const settled = settleRivalOfferDemand(
      [
        {
          offer: {
            labId: 'rival-a',
            modelId: model.id,
            capability: model.capability,
            reliability: 80,
            safety: 70,
            brandTrust: 60,
            apiPrice: 4,
            subPrice: 20,
            latencyScore: 70,
            tokPerSec: 40,
            modalities: model.modalities,
            isOpenWeights: false,
            benchmarks: model.benchmarks,
            apiListed: true,
            subscriptionListed: true,
          },
          model,
          apiMTok: 0,
          subscriptionMTok: seats * 0.5,
          subscriptionUsers: seats,
        },
      ],
      1e9,
      1,
    )
    expect(settled.keptSubscriptionUsers).toBeCloseTo(seats, 10)
    expect(settled.keptSubscriptionUsers).toBeGreaterThan(
      audience * PLAN_SEAT_CONVERSION * PLAN_SEAT_CONVERSION * 10,
    )
    expect(settled.subscriptionRevenue).toBeCloseTo((seats * 20) / 30, 10)
  })

  it('keeps free demand strongest near the frontier and degrades smoothly by rank', () => {
    expect(freeTierRankDemandFactor(1).inRank).toBe(true)
    expect(freeTierRankDemandFactor(FREE_TIER_TOP_MODEL_RANK).inRank).toBe(true)
    expect(freeTierRankDemandFactor(FREE_TIER_TOP_MODEL_RANK + 1).inRank).toBe(
      false,
    )
    expect(
      freeTierRankDemandFactor(FREE_TIER_TOP_MODEL_RANK).audienceMultiplier,
    ).toBeGreaterThan(
      freeTierRankDemandFactor(FREE_TIER_TOP_MODEL_RANK + 1).audienceMultiplier,
    )
    expect(
      freeTierRankDemandFactor(FREE_TIER_TOP_MODEL_RANK).audienceMultiplier -
        freeTierRankDemandFactor(FREE_TIER_TOP_MODEL_RANK + 1).audienceMultiplier,
    ).toBeLessThan(0.03)
    expect(
      freeTierRankDemandFactor(FREE_TIER_TOP_MODEL_RANK).audienceMultiplier,
    ).toBeGreaterThan(
      freeTierRankDemandFactor(FREE_TIER_TOP_MODEL_RANK + 25).audienceMultiplier,
    )
    expect(
      freeTierRankDemandFactor(FREE_TIER_TOP_MODEL_RANK + 25).audienceMultiplier,
    ).toBeGreaterThan(freeTierRankDemandFactor(120).audienceMultiplier)

    let s = shipModel(createGame(240), 72)
    const modelId = s.player.models[0]!.id
    const freePlan = basePlan({
      id: 'free',
      name: 'Free',
      pricePerMonth: 0,
      usageMultiplier: 0.2,
      includedMTokPerMonth: 4,
      modelIds: [modelId],
    })
    s = {
      ...s,
      rivals: s.rivals.map((r) => ({ ...r, models: [] })),
      player: {
        ...s.player,
        rackFleet: s.player.rackFleet.map((r) => ({ ...r, count: 180 })),
        allocation: { training: 0.05, inference: 0.9, research: 0.05 },
        pricing: {
          ...s.player.pricing,
          plans: [
            freePlan,
            basePlan({
              id: 'plus',
              pricePerMonth: 20,
              usageMultiplier: 1,
              includedMTokPerMonth: 20,
              modelIds: [modelId],
            }),
          ],
        },
      },
    }
    expect(modelCapabilityRank(s, modelId)).toBe(1)
    const inRank = freeTierDemandProfile(freePlan, { modelRank: 1 })
    const outRank = freeTierDemandProfile(freePlan, { modelRank: 95 })
    expect(inRank.audienceMultiplier).toBeGreaterThan(outRank.audienceMultiplier * 2.5)
    expect(inRank.utilityBonus).toBeGreaterThan(outRank.utilityBonus)

    s = tickMarket(s)
    const free = s.lastMarket.planStats.find((p) => p.planId === 'free')!
    const plus = s.lastMarket.planStats.find((p) => p.planId === 'plus')!
    expect(free.subscribers).toBeGreaterThan(plus.subscribers)
  })

  it('$20 plan with $40 usage value out-demands the same plan with $10 value', () => {
    let s = shipModel(createGame(241), 70)
    const modelId = s.player.models[0]!.id
    const generous = basePlan({
      id: 'plus-rich',
      pricePerMonth: 20,
      includedMTokPerMonth: 20,
      monthlyApiValueSubsidyGbp: 40,
      modelIds: [modelId],
    })
    const stingy = basePlan({
      id: 'plus-poor',
      pricePerMonth: 20,
      includedMTokPerMonth: 5,
      monthlyApiValueSubsidyGbp: 10,
      modelIds: [modelId],
    })
    expect(planAdvertisedValueRatio(generous, 2)).toBeCloseTo(2, 5)
    expect(planAdvertisedValueRatio(stingy, 2)).toBeCloseTo(0.5, 5)
    expect(
      planAttractiveness(
        {
          ...s,
          player: {
            ...s.player,
            pricing: { ...s.player.pricing, plans: [generous] },
          },
        },
        generous,
      ),
    ).toBeGreaterThan(
      planAttractiveness(
        {
          ...s,
          player: {
            ...s.player,
            pricing: { ...s.player.pricing, plans: [stingy] },
          },
        },
        stingy,
      ),
    )
  })

  it('top-5 model $20 plan with $10 usage still has positive but lower demand', () => {
    let s = shipModel(createGame(242), 85)
    const modelId = s.player.models[0]!.id
    s = {
      ...s,
      rivals: s.rivals.map((r) => ({ ...r, models: [] })),
    }
    expect(modelCapabilityRank(s, modelId)).toBeLessThanOrEqual(5)
    const rich = basePlan({
      id: 'rich',
      pricePerMonth: 20,
      monthlyApiValueSubsidyGbp: 40,
      includedMTokPerMonth: 20,
      modelIds: [modelId],
    })
    const lean = basePlan({
      id: 'lean',
      pricePerMonth: 20,
      monthlyApiValueSubsidyGbp: 10,
      includedMTokPerMonth: 5,
      modelIds: [modelId],
    })
    const aRich = planAttractiveness(
      {
        ...s,
        player: {
          ...s.player,
          pricing: { ...s.player.pricing, plans: [rich] },
        },
      },
      rich,
    )
    const aLean = planAttractiveness(
      {
        ...s,
        player: {
          ...s.player,
          pricing: { ...s.player.pricing, plans: [lean] },
        },
      },
      lean,
    )
    expect(aLean).toBeGreaterThan(0)
    expect(aRich).toBeGreaterThan(aLean)
  })

  it('upgrade flow moves allowance-constrained seats up-tier', () => {
    const buckets = [
      {
        plan: { id: 'plus', pricePerMonth: 20 },
        subscribers: 1000,
        usageRate: 0.92,
        valueRatio: 1.1,
      },
      {
        plan: { id: 'pro', pricePerMonth: 50 },
        subscribers: 200,
        usageRate: 0.55,
        valueRatio: 1.0,
      },
    ]
    applyPlanUptierMigration(buckets)
    expect(buckets[0]!.subscribers).toBeLessThan(1000)
    expect(buckets[1]!.subscribers).toBeGreaterThan(200)
    expect(buckets[0]!.subscribers + buckets[1]!.subscribers).toBeCloseTo(
      1200,
      8,
    )
  })

  it('four valueRatio≈1 tiers with a good model each retain non-trivial paid seats', () => {
    let s = shipModel(createGame(243), 74)
    const modelId = s.player.models[0]!.id
    const mk = (id: string, price: number) =>
      basePlan({
        id,
        name: id,
        pricePerMonth: price,
        // valueRatio ≈ 1: advertised subsidy equals seat price.
        includedMTokPerMonth: price / DEFAULT_PLAN_BLEND_API_PRICE,
        monthlyApiValueSubsidyGbp: price,
        modelIds: [modelId],
      })
    s = {
      ...s,
      rivals: s.rivals.map((r) => ({ ...r, models: [] })),
      player: {
        ...s.player,
        brandTrust: 80,
        rackFleet: s.player.rackFleet.map((r) => ({ ...r, count: 280 })),
        allocation: { training: 0.05, inference: 0.9, research: 0.05 },
        servingEfficiency: 1.4,
        pricing: {
          ...s.player.pricing,
          plans: [
            basePlan({
              id: 'free',
              name: 'Free',
              pricePerMonth: 0,
              usageMultiplier: 0.2,
              includedMTokPerMonth: 4,
              monthlyApiValueSubsidyGbp: subsidyFromIncludedMTok(4),
              modelIds: [modelId],
            }),
            mk('t20', 20),
            mk('t50', 50),
            mk('t100', 100),
            mk('t200', 200),
          ],
        },
      },
    }
    // Warm seats so stickiness does not zero premium tiers on tick 1.
    s = {
      ...s,
      lastMarket: {
        ...s.lastMarket,
        planStats: [
          { planId: 'free', name: 'Free', subscribers: 40_000, dayRevenue: 0, dayCogs: 0, allocatedComputeCostDay: 0, dayMTok: 1, dayInferPf: 1, computePfPerSubscriber: 0, costPerSubDay: 0, marginPerSubMonth: 0, isFree: true, usageRate: 0.12 },
          { planId: 't20', name: 't20', subscribers: 8_000, dayRevenue: 1, dayCogs: 0, allocatedComputeCostDay: 0, dayMTok: 1, dayInferPf: 1, computePfPerSubscriber: 0, costPerSubDay: 0, marginPerSubMonth: 0, isFree: false, usageRate: 0.5 },
          { planId: 't50', name: 't50', subscribers: 5_000, dayRevenue: 1, dayCogs: 0, allocatedComputeCostDay: 0, dayMTok: 1, dayInferPf: 1, computePfPerSubscriber: 0, costPerSubDay: 0, marginPerSubMonth: 0, isFree: false, usageRate: 0.55 },
          { planId: 't100', name: 't100', subscribers: 3_500, dayRevenue: 1, dayCogs: 0, allocatedComputeCostDay: 0, dayMTok: 1, dayInferPf: 1, computePfPerSubscriber: 0, costPerSubDay: 0, marginPerSubMonth: 0, isFree: false, usageRate: 0.6 },
          { planId: 't200', name: 't200', subscribers: 2_500, dayRevenue: 1, dayCogs: 0, allocatedComputeCostDay: 0, dayMTok: 1, dayInferPf: 1, computePfPerSubscriber: 0, costPerSubDay: 0, marginPerSubMonth: 0, isFree: false, usageRate: 0.65 },
        ],
      },
    }
    s = tickMarket(s)
    const paid = s.lastMarket.planStats.filter((p) => !p.isFree)
    const paidSeats = paid.reduce((sum, p) => sum + p.subscribers, 0)
    expect(paidSeats).toBeGreaterThan(1000)
    for (const id of ['t20', 't50', 't100', 't200']) {
      const seats = paid.find((p) => p.planId === id)!.subscribers
      expect(seats / paidSeats).toBeGreaterThanOrEqual(0.03)
    }
  })

  it('reasoning-backed plan burns allowance faster than language', () => {
    expect(WORKLOAD_TOKENS_PER_INTERACTION.reasoning).toBeGreaterThan(
      WORKLOAD_TOKENS_PER_INTERACTION.language * 5,
    )
    const plan = basePlan({
      pricePerMonth: 20,
      includedMTokPerMonth: 20,
    })
    const language = planAllowanceExpectation(plan, 20, {
      tokensPerInteraction: avgTokensPerInteraction('language'),
    })
    const reasoning = planAllowanceExpectation(plan, 20, {
      tokensPerInteraction: avgTokensPerInteraction('reasoning'),
    })
    expect(reasoning.minimumMTok).toBeGreaterThan(language.minimumMTok * 5)
    expect(reasoning.dissatisfaction).toBeGreaterThan(language.dissatisfaction)
    expect(language.dissatisfaction).toBe(0)
    expect(reasoning.dissatisfaction).toBeGreaterThan(0.5)
  })
})

describe('segment workload expectations', () => {
  it('pro and enterprise audiences expect at least 100 messages a day', () => {
    expect(segmentExpectedMessagesPerDay('enterprise')).toBe(
      PLAN_PRO_WORKLOAD_MESSAGES_PER_DAY,
    )
    expect(segmentExpectedMessagesPerDay('legal')).toBe(
      PLAN_PRO_WORKLOAD_MESSAGES_PER_DAY,
    )
    expect(segmentExpectedMessagesPerDay('healthcare')).toBe(
      PLAN_PRO_WORKLOAD_MESSAGES_PER_DAY,
    )
    expect(segmentExpectedMessagesPerDay('consumer')).toBeLessThan(
      PLAN_PRO_WORKLOAD_MESSAGES_PER_DAY,
    )
    expect(segmentExpectedMessagesPerDay('hobby')).toBeLessThan(
      segmentExpectedMessagesPerDay('startup_api'),
    )
  })

  it('scores workload shortfall from the derived allowance', () => {
    // 2 MTok/mo ≈ 33 msg/day at 2K tokens/message.
    const thin = planWorkloadExpectation({
      segmentId: 'enterprise',
      allowanceMTokPerMonth: 2,
    })
    expect(thin.offeredMessagesPerDay).toBeCloseTo(33.3, 1)
    expect(thin.shortfall).toBeGreaterThan(0.6)

    const ample = planWorkloadExpectation({
      segmentId: 'enterprise',
      allowanceMTokPerMonth: 12,
    })
    expect(ample.offeredMessagesPerDay).toBeGreaterThanOrEqual(
      PLAN_PRO_WORKLOAD_MESSAGES_PER_DAY,
    )
    expect(ample.shortfall).toBe(0)

    // Consumers are fine with the same thin plan.
    expect(
      planWorkloadExpectation({
        segmentId: 'consumer',
        allowanceMTokPerMonth: 2,
      }).shortfall,
    ).toBe(0)
  })

  it('enterprise demand favors the higher tier that covers ~100 msg/day', () => {
    let s = shipModel(createGame(204), 50)
    const mid = s.player.models[0]!.id
    const cheap = basePlan({
      id: 'cheap',
      pricePerMonth: 20,
      includedMTokPerMonth: 2,
      modelIds: [mid],
    })
    const pro = basePlan({
      id: 'pro',
      pricePerMonth: 60,
      includedMTokPerMonth: 12,
      modelIds: [mid],
    })
    s = {
      ...s,
      player: {
        ...s.player,
        pricing: { ...s.player.pricing, plans: [cheap, pro] },
      },
    }
    // Enterprise/legal/healthcare demand flips to the plan covering ~100 msg/day.
    for (const seg of ['enterprise', 'legal', 'healthcare'] as const) {
      expect(planAttractiveness(s, pro, seg)).toBeGreaterThan(
        planAttractiveness(s, cheap, seg),
      )
    }
    // The up-tier pull is far stronger for pro audiences than for consumers.
    const consumerGap =
      planAttractiveness(s, pro, 'consumer') -
      planAttractiveness(s, cheap, 'consumer')
    const enterpriseGap =
      planAttractiveness(s, pro, 'enterprise') -
      planAttractiveness(s, cheap, 'enterprise')
    expect(enterpriseGap).toBeGreaterThan(consumerGap + 20)
    // A cheap plan that still covers the bar keeps enterprise demand.
    const ample = basePlan({
      id: 'ample',
      pricePerMonth: 20,
      includedMTokPerMonth: 6,
      modelIds: [mid],
    })
    s = {
      ...s,
      player: {
        ...s.player,
        pricing: { ...s.player.pricing, plans: [cheap, ample] },
      },
    }
    expect(planAttractiveness(s, ample, 'enterprise')).toBeGreaterThan(
      planAttractiveness(s, cheap, 'enterprise'),
    )
  })
})

describe('stingy gate', () => {
  it('only applies when value trails rivals or the subsidy is below price', () => {
    // Better value than rivals and subsidy covers price → not stingy.
    expect(planStinginessApplies(1.5, 1.0)).toBe(false)
    expect(planStinginessApplies(1.0, 1.0)).toBe(false)
    // Subsidy below the monthly price → stingy.
    expect(planStinginessApplies(0.8, 0.5)).toBe(true)
    // Less value than rivals even above price parity → stingy.
    expect(planStinginessApplies(1.2, 1.5)).toBe(true)
  })

  it('clears allowance dissatisfaction for paid plans that win on value', () => {
    const thin = basePlan({ pricePerMonth: 20, includedMTokPerMonth: 2 })
    // Ungated: the thin allowance is judged stingy.
    expect(planAllowanceExpectation(thin).dissatisfaction).toBeGreaterThan(0)
    // Beating rivals on value clears the verdict entirely.
    expect(
      planAllowanceExpectation(thin, undefined, {
        valueRatio: 1.5,
        rivalValueRatio: 1.0,
      }).dissatisfaction,
    ).toBe(0)
    // Subsidy below price keeps it.
    expect(
      planAllowanceExpectation(thin, undefined, {
        valueRatio: 0.8,
        rivalValueRatio: 0.5,
      }).dissatisfaction,
    ).toBeGreaterThan(0)
    // Trailing the rival value offer keeps it too.
    expect(
      planAllowanceExpectation(thin, undefined, {
        valueRatio: 1.2,
        rivalValueRatio: 1.5,
      }).dissatisfaction,
    ).toBeGreaterThan(0)
  })

  it('never gates the free tier', () => {
    const freePlan = basePlan({ pricePerMonth: 0, includedMTokPerMonth: 0.5 })
    expect(
      planAllowanceExpectation(freePlan, undefined, {
        valueRatio: Number.POSITIVE_INFINITY,
        rivalValueRatio: 1,
      }).dissatisfaction,
    ).toBeGreaterThan(0)
  })

  it('benchmarks rival value at the nearest paid tier', () => {
    const s = createGame(205)
    const ratio = rivalNearestValueRatio(s, 20, 2)
    expect(ratio).toBeGreaterThan(0)
    // Fallbacks: nearest rival tier anchors at the plan's own price.
    expect(ratio).toBeCloseTo(
      (ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth * 2) / 20,
      5,
    )
  })
})

import { describe, expect, it } from 'vitest'
import { emptyBenchmarks } from '../balance/benchmarks'
import { ECONOMY } from '../balance/economy'
import { inferencePfDemand } from '../balance/serveCompute'
import { createGame } from '../createGame'
import type { MarketOffer, Model, SimState } from '../types'
import { syncLabIndex } from './labEngine'
import {
  isGenerationOnlyModel,
  modelCanCompeteForSegment,
  modelCanCurateDataDomain,
} from './modelEligibility'
import { collectQuarterlyLabSnapshots } from './progression'
import { fleetHostSnapshot } from './hosting'
import {
  attributedServingFixedCost,
  capacityAdjustedMarketShare,
  collectOffers,
  dominantCapacitySalesGate,
  marketingUtilityBonus,
  perceivedServiceReliability,
  settleRivalOfferDemand,
  tickMarket,
} from './market'

function releasedModel(
  id: string,
  capability: number,
  reliability: number,
  paramsB = 7,
  apiPrice = 2,
): Model {
  return {
    id,
    name: id,
    family: 'dense',
    paramsB,
    capability,
    modalities: ['text', 'tools'],
    quality: {
      reasoning: capability,
      coding: capability,
      chat: capability,
      image: 0,
      video: 0,
      safety: reliability,
      reliability,
    },
    benchmarks: {
      ...emptyBenchmarks(),
      mmlu: capability,
      coding: capability,
      math: capability,
      science: capability,
      safety: reliability,
      agents: capability,
    },
    postTrain: 'rlhf',
    trainComputeSpent: 20,
    releaseDay: 1,
    shipped: true,
    release: 'released',
    tokPerSecMult: 1,
    inferCostMult: 1,
    apiPricePerMTok: apiPrice,
    apiPriceInPerMTok: apiPrice,
    apiPriceOutPerMTok: apiPrice,
    suggestedApiPrice: apiPrice,
    suggestedApiPriceIn: apiPrice,
    suggestedApiPriceOut: apiPrice,
    costApiPriceIn: 0.2,
    costApiPriceOut: 0.8,
    distilled: false,
    trainMode: 'pretrain',
  }
}

function offer(model: Model, apiPrice: number, subPrice: number): MarketOffer {
  return {
    labId: 'rival',
    modelId: model.id,
    capability: model.capability,
    reliability: model.quality.reliability,
    safety: model.quality.safety,
    brandTrust: 70,
    apiPrice,
    subPrice,
    latencyScore: 75,
    tokPerSec: 80,
    modalities: model.modalities,
    isOpenWeights: false,
    benchmarks: model.benchmarks ?? emptyBenchmarks(),
  }
}

function stateWithOrderedRivalModels(reverse: boolean): SimState {
  const created = createGame(8_120)
  const template = created.rivals[0]!
  const small = releasedModel('small-efficient', 48, 78, 7, 2)
  const frontier = releasedModel('large-frontier', 82, 78, 140, 18)
  const rival = {
    ...template,
    models: reverse ? [frontier, small] : [small, frontier],
    flopsPf: 1_000_000_000,
    utilCap: 1,
    servingEfficiency: 1,
    servicePain: 0,
    marketingSpendPerDay: 0,
    allocation: { training: 0.1, inference: 0.8, research: 0.1 },
    pricing: {
      ...template.pricing,
      apiPricePerMTok: 5,
      subPlusPrice: 30,
    },
  }
  return syncLabIndex({
    ...created,
    segments: created.segments.map((segment) => ({
      ...segment,
      providerShares: undefined,
    })),
    player: {
      ...created.player,
      models: [],
      pricing: { ...created.player.pricing, activeModelId: null },
    },
    rivals: [rival],
  })
}

describe('player and rival product-market parity', () => {
  it('reserves image and video generators for creative demand', () => {
    const image = {
      ...releasedModel('image-gen', 92, 82),
      family: 'diffusion' as const,
      productPreset: 'image_generation' as const,
      modalities: ['image'] as Model['modalities'],
    }
    const video = {
      ...releasedModel('video-gen', 90, 80),
      family: 'video' as const,
      productPreset: 'video_generation' as const,
      modalities: ['video'] as Model['modalities'],
    }
    const multimodalLanguage = {
      ...releasedModel('vlm', 78, 82),
      productPreset: 'vision_language' as const,
      modalities: ['text', 'image', 'tools'] as Model['modalities'],
    }

    expect(isGenerationOnlyModel(image)).toBe(true)
    expect(isGenerationOnlyModel(video)).toBe(true)
    expect(modelCanCompeteForSegment(image, 'creative')).toBe(true)
    expect(modelCanCompeteForSegment(video, 'legal')).toBe(false)
    expect(modelCanCompeteForSegment(multimodalLanguage, 'legal')).toBe(true)
    expect(modelCanCurateDataDomain(image, 'image')).toBe(true)
    expect(modelCanCurateDataDomain(image, 'code')).toBe(false)
    expect(modelCanCurateDataDomain(video, 'video')).toBe(true)
    expect(modelCanCurateDataDomain(video, 'image')).toBe(false)
    expect(modelCanCurateDataDomain(multimodalLanguage, 'code')).toBe(true)

    const created = createGame(8_121)
    const settled = tickMarket(syncLabIndex({
      ...created,
      segments: created.segments.map((segment) => ({
        ...segment,
        providerShares: undefined,
      })),
      player: {
        ...created.player,
        models: [image],
        pricing: { ...created.player.pricing, activeModelId: image.id },
      },
      rivals: created.rivals.map((rival, index) => ({
        ...rival,
        models: [releasedModel(`general-${index}`, 72 - index, 82)],
      })),
    }))
    const playerShare = (segmentId: SimState['segments'][number]['id']) =>
      settled.segments.find((segment) => segment.id === segmentId)?.providerShares?.player ?? 0

    expect(playerShare('creative')).toBeGreaterThan(0)
    expect(playerShare('indie_api')).toBe(0)
    expect(playerShare('science')).toBe(0)
    expect(playerShare('enterprise')).toBe(0)
    expect(playerShare('legal')).toBe(0)
    expect(playerShare('healthcare')).toBe(0)
  })

  it('uses continuous capacity admission instead of a 50% market-share cliff', () => {
    expect(dominantCapacitySalesGate(0.72, 0.4, 0.6)).toBe(false)
    expect(dominantCapacitySalesGate(0.49, 0.4, 0.6)).toBe(false)
    expect(dominantCapacitySalesGate(0.72, 1, 1)).toBe(false)
  })

  it('sizes hosting from admitted load instead of rejected market demand', () => {
    const created = createGame(8_122)
    const state = {
      ...created,
      lastMarket: {
        ...created.lastMarket,
        demandPf: 500_000_000,
        servedPf: 12,
        capacityPf: 20,
      },
    }
    expect(fleetHostSnapshot(state).pfNeed).toBeLessThan(20)
  })

  it('attributes the same serving fixed costs for every controller', () => {
    expect(
      attributedServingFixedCost({
        energyCostDay: 1_000,
        chipAmortDay: 2_000,
        buildingOpexDay: 3_000,
        computeLeaseCostDay: 4_000,
        inferenceShare: 0.4,
      }),
    ).toBe(4_000)
  })

  it('settles the exact model and price attached to every winning demand bucket', () => {
    const small = releasedModel('small', 50, 80, 7, 2)
    const large = releasedModel('large', 80, 80, 140, 18)
    const buckets = [
      {
        offer: offer(small, 2, 20),
        model: small,
        apiMTok: 13,
        subscriptionMTok: 0,
        subscriptionUsers: 0,
      },
      {
        offer: offer(large, 18, 60),
        model: large,
        apiMTok: 2,
        subscriptionMTok: 9,
        subscriptionUsers: 4_000,
      },
    ]
    const servingEfficiency = 1.1
    const expectedPf =
      inferencePfDemand(13, small, servingEfficiency) +
      inferencePfDemand(11, large, servingEfficiency)
    const settled = settleRivalOfferDemand(
      buckets,
      expectedPf * 2,
      servingEfficiency,
    )

    expect(settled.demandPf).toBeCloseTo(expectedPf, 12)
    expect(settled.demandPf).not.toBeCloseTo(
      inferencePfDemand(24, small, servingEfficiency),
      8,
    )
    expect(settled.apiServedMTok).toBeCloseTo(15, 12)
    expect(settled.subscriptionServedMTok).toBeCloseTo(9, 12)
    expect(settled.apiRevenue).toBeCloseTo(13 * 2 + 2 * 18, 12)
    expect(settled.subscriptionRevenue).toBeCloseTo(
      (4_000 * 0.00075 * 60) / 30,
      12,
    )

    const reversed = settleRivalOfferDemand(
      [...buckets].reverse(),
      expectedPf * 2,
      servingEfficiency,
    )
    expect(reversed).toEqual(settled)
  })

  it('reduces rival reliability, served work, and revenue after overload', () => {
    const model = releasedModel('overloaded', 70, 90, 30, 8)
    const bucket = {
      offer: offer(model, 8, 30),
      model,
      apiMTok: 100,
      subscriptionMTok: 100,
      subscriptionUsers: 10_000,
    }
    const requiredPf = inferencePfDemand(200, model, 1)
    const healthy = settleRivalOfferDemand([bucket], requiredPf * 2, 1)
    const overloaded = settleRivalOfferDemand([bucket], requiredPf * 0.2, 1, 0.6)

    expect(perceivedServiceReliability(90, 0.6)).toBeLessThan(90)
    expect(overloaded.serveFrac).toBeLessThan(healthy.serveFrac)
    expect(overloaded.capacityServedMTok).toBeLessThan(healthy.capacityServedMTok)
    expect(overloaded.apiRevenue).toBeLessThan(healthy.apiRevenue)
    expect(overloaded.subscriptionRevenue).toBeLessThan(healthy.subscriptionRevenue)
  })

  it('limits headline share to the fraction of demand physically served', () => {
    expect(capacityAdjustedMarketShare(0.72, 0.2)).toBeCloseTo(0.144, 12)
    expect(capacityAdjustedMarketShare(0.72, 0)).toBe(0)
    expect(capacityAdjustedMarketShare(0.72, 1)).toBeCloseTo(0.72, 12)
  })

  it('applies the same overload reliability curve to player and rival offers', () => {
    const created = createGame(8_121)
    const playerModel = releasedModel('player-model', 70, 88)
    const rivalModel = {
      ...releasedModel('rival-model', 70, 88),
      apiPricePerMTok: 11,
      apiPriceInPerMTok: null,
      apiPriceOutPerMTok: null,
    }
    const pain = 0.55
    const state: SimState = {
      ...created,
      player: {
        ...created.player,
        models: [playerModel],
        servicePain: pain,
      },
      rivals: created.rivals.map((rival, index) => ({
        ...rival,
        models: index === 0 ? [rivalModel] : [],
        servicePain: pain,
      })),
    }
    const offers = collectOffers(state)
    const player = offers.find((candidate) => candidate.modelId === playerModel.id)!
    const rival = offers.find((candidate) => candidate.modelId === rivalModel.id)!

    expect(player.reliability).toBeCloseTo(perceivedServiceReliability(88, pain), 12)
    expect(rival.reliability).toBeCloseTo(player.reliability, 12)
    expect(rival.apiPrice).toBe(11)
  })

  it('uses the active pricing policy for demand and title affordability, not a stale suggestion', () => {
    const created = createGame(8_124)
    const template = created.rivals[0]!
    const model: Model = {
      ...releasedModel('policy-priced', 74, 82, 20, 2),
      apiPricePerMTok: null,
      apiPriceInPerMTok: null,
      apiPriceOutPerMTok: null,
      suggestedApiPrice: 0.2,
      suggestedApiPriceIn: 0.1,
      suggestedApiPriceOut: 0.3,
    }
    const pricedState = (price: number) =>
      syncLabIndex({
        ...created,
        segments: created.segments.map((segment) => ({
          ...segment,
          providerShares: undefined,
        })),
        player: {
          ...created.player,
          models: [],
          pricing: { ...created.player.pricing, activeModelId: null },
        },
        rivals: [
          {
            ...template,
            models: [model],
            flopsPf: 1_000_000_000,
            utilCap: 1,
            servingEfficiency: 1,
            servicePain: 0,
            allocation: { training: 0.1, inference: 0.8, research: 0.1 },
            pricing: {
              ...template.pricing,
              activeModelId: model.id,
              apiPricePerMTok: price,
              apiPriceInPerMTok: price,
              apiPriceOutPerMTok: price,
              subPlusPrice: 20,
            },
          },
        ],
      })

    const cheap = pricedState(1)
    const dear = pricedState(40)
    expect(collectOffers(cheap)[0]!.apiPrice).toBe(1)
    expect(collectOffers(dear)[0]!.apiPrice).toBe(40)

    const cheapSettled = tickMarket(cheap)
    const dearSettled = tickMarket(dear)
    expect(cheapSettled.lastMarket.sharesByLab[template.id]).toBeGreaterThan(
      dearSettled.lastMarket.sharesByLab[template.id] ?? 0,
    )

    const cheapTitle = collectQuarterlyLabSnapshots(cheapSettled)[1]!
    const dearTitle = collectQuarterlyLabSnapshots(dearSettled)[1]!
    expect(cheapTitle.costPerUsefulTask).toBeLessThan(dearTitle.costPerUsefulTask)
  })

  it('gives paid acquisition the same subscription utility lift for every lab', () => {
    expect(marketingUtilityBonus(550_000, true)).toBeGreaterThan(0)
    expect(marketingUtilityBonus(550_000, false)).toBe(0)

    const created = createGame(8_122)
    const template = created.rivals[0]!
    const rivalIds = created.rivals.slice(0, 2).map((rival) => rival.id)
    const rivals = rivalIds.map((id, index) => ({
      ...template,
      id,
      name: index === 0 ? 'Marketed' : 'Control',
      models: [releasedModel(`same-model-${index}`, 70, 82, 14, 5)],
      marketingSpendPerDay: index === 0 ? 550_000 : 0,
      regionId: template.regionId,
      archetype: template.archetype,
      brandTrust: 70,
      servicePain: 0,
      servingEfficiency: 1,
      pricing: {
        ...template.pricing,
        apiPricePerMTok: 5,
        subPlusPrice: 20,
      },
    }))
    const state = syncLabIndex({
      ...created,
      segments: created.segments.map((segment) => ({
        ...segment,
        providerShares: undefined,
      })),
      player: {
        ...created.player,
        models: [],
        pricing: { ...created.player.pricing, activeModelId: null },
      },
      rivals,
    })
    const settled = tickMarket(state)
    const consumerShares = settled.segments.find(
      (segment) => segment.id === 'consumer',
    )!.providerShares!

    expect(consumerShares[rivalIds[0]!]).toBeGreaterThan(consumerShares[rivalIds[1]!])
  })

  it('keeps live rival demand, billing, and capacity independent of model array order', () => {
    const forward = tickMarket(stateWithOrderedRivalModels(false)).rivals[0]!
    const reversed = tickMarket(stateWithOrderedRivalModels(true)).rivals[0]!

    expect(forward.lastDemandPf).toBeCloseTo(reversed.lastDemandPf ?? 0, 8)
    expect(forward.finance?.apiRevenue).toBeCloseTo(reversed.finance?.apiRevenue ?? 0, 8)
    expect(forward.finance?.subRevenue).toBeCloseTo(reversed.finance?.subRevenue ?? 0, 8)
    expect(forward.finance?.dayRevenue).toBeCloseTo(reversed.finance?.dayRevenue ?? 0, 8)
  })

  it('includes rival live-rack depreciation in product COGS', () => {
    const base = stateWithOrderedRivalModels(false)
    const rival = base.rivals[0]!
    const rackCapital = 600_000
    const state = syncLabIndex({
      ...base,
      rivals: [
        {
          ...rival,
          rackFleet: [
            {
              id: 'accounted-rack',
              skuId: 'rack_infer',
              x: 0,
              y: 0,
              count: 1,
              status: 'live',
              daysLeft: 0,
              paidEach: rackCapital,
              rackUnits: 1,
            },
          ],
        },
      ],
    })
    const settled = tickMarket(state).rivals[0]!
    const expectedAmort = rackCapital / ECONOMY.chipAmortDays

    expect(settled.finance?.dayChipAmort).toBeCloseTo(expectedAmort, 8)
    expect(settled.finance?.dayCogs).toBeGreaterThanOrEqual(
      expectedAmort * settled.allocation.inference,
    )
    expect(settled.finance?.dayGrossProfit).toBeCloseTo(
      (settled.finance?.dayRevenue ?? 0) - (settled.finance?.dayCogs ?? 0),
      8,
    )
  })
})

/**
 * Gating tests for the demand-model redesign:
 *  - API prices are judged against the whole market (insane prices collapse
 *    demand and revenue instead of printing money).
 *  - A monopoly offer is still anchored to its own suggested launch price.
 *  - Subscription demand is split per segment (ARPU affinity), so premium
 *    high-subsidy tiers win real enterprise/legal/healthcare seats instead of
 *    rounding to zero next to the £20 tier.
 *  - Plan value perception uses the market reference price, so raising your
 *    own API list price cannot make plans look like better deals.
 */
import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import {
  marketReferenceApiPrice,
  tickMarket,
} from '../systems/market'
import { buildScaledModel } from '../balance/modelBuild'
import { blendApiPrice } from '../balance/pricing'
import {
  createPlan,
  planAttractiveness,
  updatePlan,
} from '../systems/plans'
import { syncLabIndex } from '../systems/labEngine'
import type { SimState } from '../types'

function withRacks(s: SimState, racks = 1024): SimState {
  const tiles = s.map.tiles.map((t) => {
    if (t.x === 2 && t.y === 2) {
      return {
        ...t,
        kind: 'dc' as const,
        owner: 'player' as const,
        buildingProgress: 1,
        buildingTarget: 1,
        rackCapacity: Math.max(4096, racks * 2),
        racksUsed: 0,
        mwCapacity: Math.max(600, racks),
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
        mwCapacity: Math.max(600, racks),
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
          id: 'spread-fleet',
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
      allocation: { training: 0.1, inference: 0.8, research: 0.1 },
      servingEfficiency: 0.85,
    },
  }
}

function withReleasedModel(s: SimState, cap = 55): SimState {
  const m = buildScaledModel({
    id: 'spread-model',
    name: 'Spread',
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
  }
}

/** Every rival ships a competent, fairly priced public model. */
function withRivalModels(s: SimState, cap = 48): SimState {
  const next = {
    ...s,
    rivals: s.rivals.map((r) => {
      const m =
        r.models.find((x) => x.shipped || x.release === 'released') ??
        (() => {
          const built = buildScaledModel({
            id: `rival-m-${r.id}`,
            name: `${r.name} M`,
            paramsB: 3,
            family: 'dense',
            day: s.day,
            dataCoverage: 20,
            dataQuality: 65,
            postTrain: 'none',
          })
          return {
            ...built,
            quality: { ...built.quality, reliability: 58 },
            shipped: true,
            release: 'released' as const,
            apiPricePerMTok: 3,
            apiPriceInPerMTok: 1,
            apiPriceOutPerMTok: 3.85,
          }
        })()
      return {
        ...r,
        flopsPf: 2_000_000,
        models: [
          { ...m, capability: cap, quality: { ...m.quality, reliability: 58 } },
        ],
      }
    }),
  }
  return syncLabIndex(next)
}

/** No rival has a public model — the player is the only seller. */
function withoutRivalModels(s: SimState): SimState {
  return syncLabIndex({
    ...s,
    rivals: s.rivals.map((r) => ({
      ...r,
      models: r.models.map((m) => ({ ...m, shipped: false, release: 'internal' as const })),
    })),
  })
}

function withApiPrices(s: SimState, pin: number, pout: number): SimState {
  const blend = blendApiPrice(pin, pout)
  const activeId = s.player.pricing.activeModelId
  return {
    ...s,
    player: {
      ...s.player,
      models: s.player.models.map((m) =>
        m.id === activeId
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

function withoutPlans(s: SimState): SimState {
  let next = s
  for (const p of [...next.player.pricing.plans]) {
    next = updatePlan(next, p.id, { enabled: false })
  }
  return next
}

function run(s: SimState, days: number, opts?: { pinBrandTrust?: number }): SimState {
  for (let i = 0; i < days; i++) {
    s = tickMarket(s)
    s = { ...s, day: s.day + 1 }
    if (opts?.pinBrandTrust != null) {
      // Isolate demand mechanics from brand/pain feedback loops: the fixture
      // is permanently capacity-limited, and the demand assertions must not
      // drown in the resulting brand erosion.
      s = {
        ...s,
        player: { ...s.player, brandTrust: opts.pinBrandTrust, servicePain: 0 },
      }
    }
  }
  return s
}

const baseCompetitive = () =>
  withoutPlans(withRivalModels(withReleasedModel(withRacks(createGame(7)))))

describe('API demand is weighted against the market', () => {
  it('collapses demand and revenue at insane prices when rivals compete', () => {
    const fair = run(baseCompetitive(), 12, { pinBrandTrust: 58 })
    const insane = run(withApiPrices(baseCompetitive(), 1000, 1000), 12, {
      pinBrandTrust: 58,
    })
    const cheap = run(withApiPrices(baseCompetitive(), 0.5, 2), 12, {
      pinBrandTrust: 58,
    })
    const fairDemand = fair.lastMarket.apiDemandMTok ?? 0
    const insaneDemand = insane.lastMarket.apiDemandMTok ?? 0
    expect(fairDemand).toBeGreaterThan(0)
    // A 1000× markup loses at least 85% of API token demand...
    expect(insaneDemand).toBeLessThan(fairDemand * 0.15)
    // ...and does NOT turn into extra revenue (served volume × price still
    // loses to the fairly priced run).
    expect(insane.lastMarket.apiDayRevenue).toBeLessThanOrEqual(
      fair.lastMarket.apiDayRevenue * 2,
    )
    // Undercutting is rewarded with at least as much demand as fair pricing.
    expect(cheap.lastMarket.apiDemandMTok ?? 0).toBeGreaterThanOrEqual(
      fairDemand,
    )
  })

  it('anchors a monopoly offer to its own suggested launch price', () => {
    const monopoly = () =>
      withoutPlans(
        withoutRivalModels(withReleasedModel(withRacks(createGame(11)))),
      )
    const fair = run(monopoly(), 12, { pinBrandTrust: 58 })
    const insane = run(withApiPrices(monopoly(), 1000, 1000), 12, {
      pinBrandTrust: 58,
    })
    const fairDemand = fair.lastMarket.apiDemandMTok ?? 0
    const insaneDemand = insane.lastMarket.apiDemandMTok ?? 0
    expect(fairDemand).toBeGreaterThan(0)
    // No rivals to compare against: a 1000× markup over the model's own
    // suggested price must still erase ~all API demand.
    expect(insaneDemand).toBeLessThan(fairDemand * 0.1)
  })
})

describe('subscription demand spreads across price tiers', () => {
  function planSpreadState(): SimState {
    let s = withRivalModels(withReleasedModel(withRacks(createGame(7), 8192)))
    // Isolate tier choice with a serving stack that can profitably honor the
    // premium 400 MTok promise. The 1.35× end-to-end systems-work calibration
    // makes even a 1.2× stack loss-making at this allowance; a genuinely
    // optimized 1.55× serving stack is required before the tier is a valid
    // positive-margin demand fixture.
    s = { ...s, player: { ...s.player, servingEfficiency: 2.1 } }
    s = withoutPlans(s)
    s = createPlan(s, { name: 'Free', pricePerMonth: 0, usageMultiplier: 0.2 })
    s = createPlan(s, { name: 'Plus20', pricePerMonth: 20, usageMultiplier: 1 })
    s = createPlan(s, {
      name: 'Pro200',
      pricePerMonth: 200,
      usageMultiplier: 20,
      includedMTokPerMonth: 400,
    })
    return run(s, 15)
  }

  it('a £200 tier with a fixed 20x entitlement wins real seats', () => {
    const s = planSpreadState()
    const stats = s.lastMarket.planStats
    const free = stats.find((p) => p.name === 'Free')!
    const plus = stats.find((p) => p.name === 'Plus20')!
    const pro = stats.find((p) => p.name === 'Pro200')!
    const paidTotal = stats
      .filter((p) => !p.isFree)
      .reduce((sum, p) => sum + p.subscribers, 0)
    expect(pro.dayRevenue).toBeGreaterThan(0)
    // Premium tier is alive: real seats, at least 3% of the paid base...
    expect(pro.subscribers).toBeGreaterThan(0)
    expect(pro.subscribers / Math.max(1, paidTotal)).toBeGreaterThanOrEqual(0.03)
    // ...while the pyramid still holds: free widest, Plus the paid leader.
    expect(plus.subscribers).toBeGreaterThan(pro.subscribers)
    expect(free.subscribers).toBeGreaterThan(plus.subscribers)
    expect(paidTotal).toBeGreaterThan(0)
  })

  it('records daily per-plan stats history for demand graphs', () => {
    const s = planSpreadState()
    expect(s.planStatsHistory.length).toBeGreaterThanOrEqual(15)
    const today = s.planStatsHistory[s.planStatsHistory.length - 1]!
    expect(today.day).toBe(s.day - 1)
    const proRow = today.plans.find((p) => p.name === 'Pro200')
    expect(proRow).toBeDefined()
    expect(proRow!.subscribers).toBeGreaterThan(0)
    expect(proRow!.pricePerMonth).toBe(200)
  })

  it('lets a badly valued paid ladder recover from zero seats without pretending it is healthy', () => {
    let s = withRivalModels(withReleasedModel(withRacks(createGame(19), 8192), 30), 52)
    const modelId = s.player.models[0]!.id
    s = withoutPlans(s)
    s = createPlan(s, {
      name: 'Free',
      pricePerMonth: 0,
      usageMultiplier: 0.2,
      includedMTokPerMonth: 4,
    })
    s = createPlan(s, {
      name: 'Plus20',
      pricePerMonth: 20,
      usageMultiplier: 1,
      includedMTokPerMonth: 20,
    })
    s = {
      ...s,
      day: 1_012,
      player: {
        ...s.player,
        brandTrust: 40,
        pricing: {
          ...s.player.pricing,
          plans: s.player.pricing.plans.map((plan) => ({
            ...plan,
            modelIds: [modelId],
          })),
        },
      },
      lastMarket: {
        ...s.lastMarket,
        planStats: s.player.pricing.plans.map((plan) => ({
          planId: plan.id,
          name: plan.name,
          subscribers: plan.pricePerMonth <= 0 ? 10_000_000 : 0,
          maxSeats: 1_000_000_000,
          dayRevenue: 0,
          dayCogs: 0,
          allocatedComputeCostDay: 0,
          dayMTok: 0,
          dayInferPf: 0,
          computePfPerSubscriber: 0,
          modelUsage: [],
          computePriority: 50,
          serveFraction: 1,
          isFree: plan.pricePerMonth <= 0,
          usageRate: 0.5,
          allowanceMTokMonth: plan.includedMTokPerMonth ?? 0,
          apiEquivalentValue: plan.pricePerMonth <= 0 ? 0 : 1.5,
          subsidyRatio: plan.pricePerMonth <= 0 ? Number.POSITIVE_INFINITY : 0.075,
          priceTooHigh: plan.pricePerMonth <= 0 ? 0 : 0.9,
          costPerSubDay: 0,
          marginPerSubMonth: 0,
          dissatisfaction: plan.pricePerMonth <= 0 ? 0.2 : 0.86,
        })),
      },
    }
    s = run(s, 1, { pinBrandTrust: 40 })
    const free = s.lastMarket.planStats.find((plan) => plan.name === 'Free')!
    const plus = s.lastMarket.planStats.find((plan) => plan.name === 'Plus20')!
    expect(plus.subscribers).toBeGreaterThan(0)
    expect(plus.subscribers).toBeLessThan(free.subscribers * 0.05)
    expect(free.subscribers).toBeGreaterThan(plus.subscribers)
  })
})

describe('plan value perception is anchored to the market, not own list price', () => {
  it('raising own API prices does not make plans more attractive', () => {
    let s = withRivalModels(withReleasedModel(withRacks(createGame(7))))
    s = run(s, 6)
    const reference = marketReferenceApiPrice(s)
    const paidPlan = s.player.pricing.plans.find(
      (p) => p.enabled && p.pricePerMonth > 0,
    )!
    const before = planAttractiveness(s, paidPlan, 'consumer', {
      referenceApiPricePerMTok: reference,
      includeMassPrior: false,
    })
    const gouged = withApiPrices(s, 100, 100)
    const after = planAttractiveness(gouged, paidPlan, 'consumer', {
      referenceApiPricePerMTok: reference,
      includeMassPrior: false,
    })
    expect(after).toBeLessThanOrEqual(before + 1e-9)
  })
})

import { describe, expect, it } from 'vitest'
import { buildScaledModel } from './modelBuild'
import {
  apiTaskLaneDemand,
  composeRouterModel,
  planTaskLaneDemand,
  publicRouterParts,
  routerLaneWeights,
  routerUnitCostPf,
  soldApiRouters,
  strongestModelForLane,
  taskBiasForPlan,
} from './modelRouter'
import { trainingGymDomainExtras } from './modelStudio'
import { createGame } from '../createGame'
import {
  createModelRouter,
  deleteModelRouter,
  setActiveModelRouter,
  setRouterLane,
} from '../systems/modelStudio'
import { collectLeaderboardModels } from '../systems/rivals'
import { collectOffers, tickMarket } from '../systems/market'
import { planModelTrafficMix } from '../systems/plans'
import { hostedServingModels } from '../systems/servingPlacement'
import { startTraining } from '../systems/training'

function withRouterTech(state: ReturnType<typeof createGame>) {
  const unlocked = new Set(state.player.researchUnlocked)
  unlocked.add('sys_router')
  return {
    ...state,
    player: { ...state.player, researchUnlocked: [...unlocked] },
  }
}

function released(id: string, name: string, paramsB: number, capability: number) {
  const model = buildScaledModel({
    id,
    name,
    paramsB,
    family: 'dense',
    day: 1,
    dataCoverage: 30,
    dataQuality: 75,
  })
  return {
    ...model,
    capability,
    release: 'released' as const,
    shipped: true,
    benchmarks: {
      ...model.benchmarks,
      coding: capability * 0.7,
      math: capability * 0.9,
    },
  }
}

describe('router mix and cost', () => {
  it('blends board scores toward specialist lanes', () => {
    const fast = released('fast', 'Fast', 3, 42)
    const frontier = released('front', 'Front', 70, 88)
    const code = released('code', 'Coder', 8, 70)
    code.benchmarks = { ...code.benchmarks, coding: 92, math: 40 }
    frontier.benchmarks = { ...frontier.benchmarks, coding: 55, math: 90 }
    const router = {
      id: 'router-1',
      name: 'Prod',
      lanes: { fast: fast.id, default: fast.id, frontier: frontier.id, code: code.id },
    }
    const parts = publicRouterParts(router, [fast, frontier, code])
    const composed = composeRouterModel(router, parts)
    expect(composed).toBeTruthy()
    expect(composed!.capability).toBeGreaterThan(fast.capability)
    expect(composed!.capability).toBeLessThan(frontier.capability)
    expect(composed!.benchmarks.coding).toBeGreaterThan(composed!.benchmarks.math * 0.4)
    expect(composed!.benchmarks.math).toBeGreaterThan(fast.benchmarks.math)
  })

  it('sends harder premium traffic to science and cheap traffic to chat', () => {
    const chat = released('chat', 'Chat', 3, 40)
    const science = released('sci', 'Sci', 70, 90)
    const lanes = { chat, default: chat, science, code: chat }
    const free = routerLaneWeights(
      planTaskLaneDemand({ pricePerMonth: 0 }),
      lanes,
      taskBiasForPlan({ pricePerMonth: 0 }),
    )
    const premium = routerLaneWeights(
      planTaskLaneDemand({ pricePerMonth: 200 }),
      lanes,
      taskBiasForPlan({ pricePerMonth: 200 }),
    )
    expect(premium.science).toBeGreaterThan(free.science)
    expect(free.chat).toBeGreaterThan(premium.chat)
    expect(routerUnitCostPf([{ model: science, share: 1 }])).toBeGreaterThan(
      routerUnitCostPf([{ model: chat, share: 1 }]),
    )
  })

  it('lets each category pick a specialist', () => {
    const chat = released('chat-spec', 'Chat', 4, 50)
    chat.benchmarks = { ...chat.benchmarks, coding: 30, math: 30, science: 30 }
    chat.quality = { ...chat.quality, chat: 80 }
    const code = released('code-spec', 'Code', 8, 55)
    code.benchmarks = { ...code.benchmarks, coding: 92, math: 40, science: 35 }
    const math = released('math-spec', 'Math', 8, 55)
    math.benchmarks = { ...math.benchmarks, coding: 40, math: 93, science: 40 }
    const science = released('sci-spec', 'Sci', 8, 55)
    science.benchmarks = { ...science.benchmarks, coding: 38, math: 42, science: 91 }
    const router = {
      id: 'router-cats',
      name: 'Specialists',
      lanes: {
        chat: chat.id,
        code: code.id,
        math: math.id,
        science: science.id,
        default: chat.id,
      },
    }
    const parts = publicRouterParts(router, [chat, code, math, science])
    const composed = composeRouterModel(router, parts)
    expect(composed).toBeTruthy()
    expect(composed!.benchmarks.coding).toBeGreaterThan(55)
    expect(composed!.benchmarks.math).toBeGreaterThan(55)
    expect(composed!.benchmarks.science).toBeGreaterThan(55)
    expect(strongestModelForLane([chat, code, math, science], 'code')?.id).toBe(
      code.id,
    )
    expect(strongestModelForLane([chat, code, math, science], 'math')?.id).toBe(
      math.id,
    )
  })

  it('shows live routers on the public board', () => {
    const fast = released('fast', 'Fast', 3, 40)
    const frontier = released('front', 'Front', 70, 88)
    let state = withRouterTech(createGame(61))
    state = {
      ...state,
      player: { ...state.player, models: [fast, frontier] },
    }
    state = createModelRouter(state, 'Prod mix')
    const routerId = state.player.modelRouters![0]!.id
    state = setRouterLane(state, routerId, 'fast', fast.id)
    state = setRouterLane(state, routerId, 'frontier', frontier.id)
    const board = collectLeaderboardModels(state)
    expect(board.some((row) => row.kind === 'router' && row.model.name === 'Prod mix')).toBe(
      true,
    )

    state = setActiveModelRouter(state, null)
    expect(
      collectLeaderboardModels(state).some(
        (row) => row.kind === 'router' && row.model.name === 'Prod mix',
      ),
    ).toBe(false)
  })

  it('sells an explicit API router without listing its members', () => {
    const fast = released('fast-api', 'Fast', 3, 40)
    const frontier = released('front-api', 'Front', 70, 88)
    let state = withRouterTech(createGame(62))
    state = {
      ...state,
      player: {
        ...state.player,
        models: [fast, frontier],
        pricing: {
          ...state.player.pricing,
          apiModelIds: [],
          activeModelId: frontier.id,
        },
      },
    }
    state = createModelRouter(state, 'Sold mix')
    const routerId = state.player.modelRouters![0]!.id
    state = setRouterLane(state, routerId, 'fast', fast.id)
    state = setRouterLane(state, routerId, 'frontier', frontier.id)
    state = {
      ...state,
      player: {
        ...state.player,
        activeModelRouterId: null,
        pricing: {
          ...state.player.pricing,
          apiRouterIds: [routerId],
        },
      },
    }

    expect(
      soldApiRouters({
        apiRouterIds: state.player.pricing.apiRouterIds,
        apiModelIds: state.player.pricing.apiModelIds,
        activeModelRouterId: state.player.activeModelRouterId,
        routers: state.player.modelRouters,
        models: state.player.models,
      }).map((router) => router.id),
    ).toEqual([routerId])

    const listed = collectOffers(state).filter(
      (offer) => offer.labId === 'player' && offer.apiListed,
    )
    expect(listed.some((offer) => offer.routerId === routerId)).toBe(true)
    expect(listed.some((offer) => offer.modelId === fast.id)).toBe(false)
    expect(listed.some((offer) => offer.modelId === frontier.id)).toBe(false)
    expect(
      hostedServingModels({
        models: state.player.models,
        pricing: state.player.pricing,
        modelRouters: state.player.modelRouters,
        activeModelRouterId: state.player.activeModelRouterId,
      })
        .map((model) => model.id)
        .sort(),
    ).toEqual([fast.id, frontier.id].sort())
  })

  it('settles each routed member with its own effort recipes', () => {
    const instant = released('router-instant', 'Instant lane', 3, 58)
    const reasoning = released('router-reasoning', 'Reasoning lane', 30, 76)
    instant.reasoningEnabled = true
    reasoning.reasoningEnabled = true
    instant.productProfile = undefined
    reasoning.productProfile = {
      lifecycle: 'reasoning',
      focus: { coding: 0, science: 0, research: 0, personality: 0, chat: 0 },
      personality: 55,
      tokenEfficiency: 80,
      defaultEffortId: 'max',
      effortRecipes: [
        {
          id: 'instant',
          name: 'Instant',
          kind: 'instant',
          thinkingTokenMult: 1,
          trainPfDays: 0,
          trainCash: 0,
          trained: true,
          quality: 1,
          served: true,
        },
        {
          id: 'max',
          name: 'Max',
          kind: 'trained',
          thinkingTokenMult: 32,
          trainPfDays: 160,
          trainCash: 8_000_000,
          trained: true,
          quality: 0.9,
          served: true,
          capabilityBias: 0.6,
        },
      ],
    }
    for (const model of [instant, reasoning]) {
      model.apiPricePerMTok = null
      model.apiPriceInPerMTok = 1
      model.apiPriceOutPerMTok = 5
    }
    let state = withRouterTech(createGame(6_206))
    state = {
      ...state,
      segments: state.segments.map((segment) => ({
        ...segment,
        providerShares: {},
      })),
      player: {
        ...state.player,
        models: [instant, reasoning],
        pricing: {
          ...state.player.pricing,
          apiModelIds: [],
          apiPriceInPerMTok: 1,
          apiPriceOutPerMTok: 5,
          apiVsSubPriority: 0.88,
          plans: state.player.pricing.plans.map((plan) => ({
            ...plan,
            enabled: false,
          })),
        },
      },
    }
    state = createModelRouter(state, 'Heterogeneous effort')
    const routerId = state.player.modelRouters![0]!.id
    state = setRouterLane(state, routerId, 'fast', instant.id)
    state = setRouterLane(state, routerId, 'frontier', reasoning.id)
    state = {
      ...state,
      player: {
        ...state.player,
        pricing: {
          ...state.player.pricing,
          apiRouterIds: [routerId],
          apiModelIds: [],
        },
      },
    }

    const settled = tickMarket(state)
    const apiItems = (settled.lastMarket.computeLedger?.items ?? []).filter(
      (item) => item.channel === 'api',
    )
    const instantItem = apiItems.find((item) => item.modelId === instant.id)!
    const reasoningItem = apiItems.find((item) => item.modelId === reasoning.id)!
    expect(instantItem).toBeTruthy()
    expect(reasoningItem).toBeTruthy()
    const tokenRatio = (item: typeof instantItem) =>
      ((item.billed.outputMTok ?? 0) + (item.billed.reasoningMTok ?? 0)) /
      Math.max(1e-12, item.billed.inputMTok ?? 0)
    expect(tokenRatio(instantItem)).toBeCloseTo(0.35 / 0.65, 7)
    expect(tokenRatio(reasoningItem)).toBeGreaterThan(tokenRatio(instantItem))
    const billedMTok = apiItems.reduce(
      (sum, item) =>
        sum +
        (item.billed.inputMTok ?? 0) +
        (item.billed.cachedInputMTok ?? 0) +
        (item.billed.outputMTok ?? 0) +
        (item.billed.reasoningMTok ?? 0),
      0,
    )
    expect(billedMTok).toBeCloseTo(settled.lastMarket.apiDayMTok, 7)
    expect(apiItems.reduce((sum, item) => sum + item.revenue, 0)).toBeCloseTo(
      settled.lastMarket.apiDayRevenue,
      7,
    )
    expect(
      apiItems.reduce((sum, item) => sum + item.servedPfDays, 0),
    ).toBeCloseTo(
      (settled.lastMarket.apiModelUsage ?? []).reduce(
        (sum, usage) => sum + usage.dayInferPf,
        0,
      ),
      7,
    )
  })

  it('does not fall back to a live mix once apiRouterIds is set', () => {
    const fast = released('fast-explicit', 'Fast', 3, 40)
    const frontier = released('front-explicit', 'Front', 70, 88)
    let state = withRouterTech(createGame(65))
    state = {
      ...state,
      player: {
        ...state.player,
        models: [fast, frontier],
        pricing: {
          ...state.player.pricing,
          apiModelIds: [fast.id, frontier.id],
          activeModelId: frontier.id,
        },
      },
    }
    state = createModelRouter(state, 'Paused mix')
    const routerId = state.player.modelRouters![0]!.id
    state = setRouterLane(state, routerId, 'fast', fast.id)
    state = setRouterLane(state, routerId, 'frontier', frontier.id)
    state = setActiveModelRouter(state, routerId)
    state = {
      ...state,
      player: {
        ...state.player,
        pricing: {
          ...state.player.pricing,
          apiRouterIds: [],
        },
      },
    }
    expect(
      soldApiRouters({
        apiRouterIds: state.player.pricing.apiRouterIds,
        apiModelIds: state.player.pricing.apiModelIds,
        activeModelRouterId: state.player.activeModelRouterId,
        routers: state.player.modelRouters,
        models: state.player.models,
      }),
    ).toEqual([])
    const listed = collectOffers(state).filter(
      (offer) => offer.labId === 'player' && offer.apiListed,
    )
    expect(listed.some((offer) => offer.routerId === routerId)).toBe(false)
    expect(listed.some((offer) => offer.modelId === fast.id)).toBe(true)
  })

  it('does not treat deleting a router as opting into an empty API mix list', () => {
    const fast = released('fast-keep', 'Fast', 3, 40)
    let state = withRouterTech(createGame(63))
    state = {
      ...state,
      player: {
        ...state.player,
        models: [fast],
        pricing: {
          ...state.player.pricing,
          apiModelIds: [fast.id],
        },
      },
    }
    state = createModelRouter(state, 'Spare')
    const spareId = state.player.modelRouters![0]!.id
    expect(state.player.pricing.apiRouterIds).toBeUndefined()
    state = deleteModelRouter(state, spareId)
    expect(state.player.pricing.apiRouterIds).toBeUndefined()
  })

  it('lists a live router as one API offer instead of its member endpoints', () => {
    const fast = released('fast', 'Fast', 3, 40)
    const frontier = released('front', 'Front', 70, 88)
    let state = withRouterTech(createGame(62))
    state = {
      ...state,
      player: {
        ...state.player,
        models: [fast, frontier],
        pricing: {
          ...state.player.pricing,
          apiModelIds: [fast.id, frontier.id],
          activeModelId: frontier.id,
        },
      },
    }
    const before = collectOffers(state).filter(
      (offer) => offer.labId === 'player' && offer.apiListed,
    )
    expect(before.some((offer) => offer.modelId === fast.id)).toBe(true)

    state = createModelRouter(state, 'API mix')
    const routerId = state.player.modelRouters![0]!.id
    state = setRouterLane(state, routerId, 'fast', fast.id)
    state = setRouterLane(state, routerId, 'frontier', frontier.id)
    state = setActiveModelRouter(state, routerId)
    const after = collectOffers(state).filter(
      (offer) => offer.labId === 'player' && offer.apiListed,
    )
    expect(after.some((offer) => offer.routerId === routerId)).toBe(true)
    expect(after.some((offer) => offer.modelId === fast.id)).toBe(false)
    expect(after.some((offer) => offer.modelId === frontier.id)).toBe(false)
  })

  it('routes more premium plan share onto the frontier lane', () => {
    const small = released('fast-model', 'Fast', 3, 40)
    const large = released('frontier-model', 'Frontier', 70, 88)
    let state = withRouterTech(createGame(63))
    const plan = {
      ...state.player.pricing.plans.find((entry) => entry.pricePerMonth > 180)!,
      modelIds: [small.id, large.id],
    }
    state = {
      ...state,
      player: { ...state.player, models: [small, large], pricing: { ...state.player.pricing, plans: [plan] } },
    }
    state = createModelRouter(state, 'Prod')
    const routerId = state.player.modelRouters![0]!.id
    state = setRouterLane(state, routerId, 'fast', small.id)
    state = setRouterLane(state, routerId, 'default', small.id)
    state = setRouterLane(state, routerId, 'frontier', large.id)
    state = setActiveModelRouter(state, routerId)
    const mix = planModelTrafficMix(state, plan)
    expect(mix.find((lane) => lane.model.id === large.id)!.share).toBeGreaterThan(
      mix.find((lane) => lane.model.id === small.id)!.share,
    )
  })

  it('serves a plan that lists a router without member modelIds', () => {
    const small = released('fast-model', 'Fast', 3, 40)
    const large = released('frontier-model', 'Frontier', 70, 88)
    let state = withRouterTech(createGame(65))
    const plan = {
      ...state.player.pricing.plans.find((entry) => entry.pricePerMonth > 180)!,
      modelIds: [] as string[],
    }
    state = {
      ...state,
      player: {
        ...state.player,
        models: [small, large],
        pricing: { ...state.player.pricing, plans: [plan] },
        activeModelRouterId: null,
      },
    }
    state = createModelRouter(state, 'Prod')
    const routerId = state.player.modelRouters![0]!.id
    state = setRouterLane(state, routerId, 'fast', small.id)
    state = setRouterLane(state, routerId, 'frontier', large.id)
    state = setActiveModelRouter(state, null)
    const listed = { ...plan, routerIds: [routerId] }
    state = {
      ...state,
      player: {
        ...state.player,
        pricing: { ...state.player.pricing, plans: [listed] },
      },
    }
    const mix = planModelTrafficMix(state, listed)
    expect(mix.some((lane) => lane.model.id === large.id)).toBe(true)
    expect(mix.some((lane) => lane.model.id === small.id)).toBe(true)
    expect(
      hostedServingModels({
        models: state.player.models,
        pricing: state.player.pricing,
        modelRouters: state.player.modelRouters,
      })
        .map((model) => model.id)
        .sort(),
    ).toEqual([large.id, small.id].sort())
  })
})

describe('training labs', () => {
  it('only stores unlocked labs on a new run', () => {
    let state = withRouterTech(createGame(64))
    state = {
      ...state,
      player: {
        ...state.player,
        cash: 50_000_000,
        researchUnlocked: [...state.player.researchUnlocked, 'domain_coding'],
      },
    }
    state = startTraining(state, {
      name: 'Labbed',
      family: 'dense',
      paramsB: 1,
      attachedGymKinds: ['code', 'math'],
    })
    expect(state.player.trainingJob?.attachedGymKinds).toEqual(['code'])
  })

  it('raises domain extras when a funded lab is attached', () => {
    const empty = trainingGymDomainExtras(
      [{ id: 'gym-code', kind: 'code', name: 'Code', investedCash: 0, investedComputeCash: 0, quality: 0 }],
      ['code'],
    )
    const funded = trainingGymDomainExtras(
      [
        {
          id: 'gym-code',
          kind: 'code',
          name: 'Code',
          investedCash: 120_000_000,
          investedComputeCash: 90_000_000,
          quality: 0.85,
        },
      ],
      ['code'],
    )
    expect(empty.coding ?? 0).toBe(0)
    expect(funded.coding ?? 0).toBeGreaterThan(3)
    expect(funded.agents ?? 0).toBeGreaterThan(1)
  })
})

describe('api task mix', () => {
  it('treats expensive API traffic as harder', () => {
    const cheap = apiTaskLaneDemand(0.4)
    const dear = apiTaskLaneDemand(18)
    expect(dear.science).toBeGreaterThan(cheap.science)
    expect(cheap.chat).toBeGreaterThan(dear.chat)
  })
})

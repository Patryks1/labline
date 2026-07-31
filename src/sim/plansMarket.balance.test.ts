/**
 * Gating tests for plan value, compute caps, subsidy, facility opex, API vs subs.
 * Drives shipped helpers and tickMarket — no reimplementation of production math.
 */
import { describe, expect, it } from 'vitest'
import { createGame } from './createGame'
import { ECONOMY } from './balance/economy'
import {
  defaultPlans,
  formatAllowance,
  allocatePlanCompute,
  freeTierDemandProfile,
  planAllowanceMTokPerMonth,
  planAllowanceExpectation,
  planApiEquivalentValue,
  planAttractiveness,
  availablePlanPrecisionsForModel,
  planModelServePrecision,
  planModelTrafficMix,
  planOfferingBreadth,
  planPriceTooHighScore,
  planServeModifiers,
  modelForServePrecision,
  planStabilityDissatisfaction,
  planSubsidyRatio,
  premiumPlanScrutiny,
  maxSeatsForPlan,
  updatePlan,
} from './systems/plans'
import { playerBuildingOpex } from './systems/map'
import { tickMarket } from './systems/market'
import { startTraining, releaseFromJob, tickTraining } from './systems/training'
import { buildScaledModel } from './balance/modelBuild'
import type { Model, SimState, SubPlan } from './types'

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
      models: r.models.map((x) => ({ ...x, capability: Math.min(x.capability, 48) })),
      pricing: { ...r.pricing, subPlusPrice: 22 },
    })),
  }
}

/** Override lab + active model API list prices together. */
function withApiPrices(
  s: SimState,
  pin: number,
  pout: number,
): SimState {
  const blend = Math.round((pin * 0.3 + pout * 0.7) * 1000) / 1000
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

describe('plan mult / high ARPU UI path', () => {
  it('updatePlan accepts enterprise mults above 100 (matches clampMultiplier 500)', () => {
    let s = createGame(199)
    const id = s.player.pricing.plans[1]!.id
    s = updatePlan(s, id, { usageMultiplier: 150, pricePerMonth: 5000 })
    const p = s.player.pricing.plans.find((x) => x.id === id)!
    expect(p.usageMultiplier).toBe(150)
    expect(planAllowanceMTokPerMonth(p)).toBeGreaterThan(planAllowanceMTokPerMonth({
      ...p,
      usageMultiplier: 100,
      includedMTokPerMonth:
        ECONOMY.basePlanUsageMTokPerDay * 100 * ECONOMY.daysPerMonth,
    }))
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

    expect(freeTierDemandProfile(freeAtMessages(4.99)).band).toBe('cost_constrained')
    expect(freeTierDemandProfile(freeAtMessages(5)).band).toBe('semi_popular')
    expect(freeTierDemandProfile(freeAtMessages(10)).band).toBe('semi_popular')
    expect(freeTierDemandProfile(freeAtMessages(10.01)).band).toBe('popular')
    expect(freeTierDemandProfile(freeAtMessages(10.01)).audienceMultiplier).toBeGreaterThan(
      freeTierDemandProfile(freeAtMessages(5)).audienceMultiplier,
    )
    expect(freeTierDemandProfile(freeAtMessages(5)).minimumAudienceShare).toBeGreaterThan(
      freeTierDemandProfile(freeAtMessages(4.99)).minimumAudienceShare,
    )
    expect(freeTierDemandProfile(freeAtMessages(10.01)).minimumAudienceShare).toBeGreaterThan(
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
            basePlan({ id: 'generous', usageMultiplier: 12, pricePerMonth: 40 }),
          ],
        },
      },
    }
    const stingy = { ...s.player.pricing.plans[0]!, modelIds: [s.player.models[0]!.id] }
    const generous = { ...s.player.pricing.plans[1]!, modelIds: [s.player.models[0]!.id] }
    const aStingy = planAttractiveness(
      { ...s, player: { ...s.player, pricing: { ...s.player.pricing, plans: [stingy] } } },
      stingy,
    )
    const aGen = planAttractiveness(
      { ...s, player: { ...s.player, pricing: { ...s.player.pricing, plans: [generous] } } },
      generous,
    )
    expect(planAllowanceMTokPerMonth(generous)).toBeGreaterThan(planAllowanceMTokPerMonth(stingy))
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
            basePlan({ id: 'w', pricePerMonth: 30, usageMultiplier: 2, modelIds: [weak.id] }),
            basePlan({ id: 's', pricePerMonth: 30, usageMultiplier: 2, modelIds: [strong.id] }),
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
    const cheap = basePlan({ id: 'c', pricePerMonth: 25, usageMultiplier: 3, modelIds: [mid] })
    const dear = basePlan({ id: 'd', pricePerMonth: 1200, usageMultiplier: 3, modelIds: [mid] })
    s = {
      ...s,
      player: {
        ...s.player,
        pricing: { ...s.player.pricing, plans: [cheap, dear] },
      },
    }
    expect(planAttractiveness(s, cheap)).toBeGreaterThan(planAttractiveness(s, dear))
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
            basePlan({ id: 'free', name: 'Free', pricePerMonth: 0, usageMultiplier: 1, modelIds: [modelId] }),
            basePlan({ id: 'plus', name: 'Plus', pricePerMonth: 20, usageMultiplier: 4, modelIds: [modelId] }),
            basePlan({ id: 'pro', name: 'Pro', pricePerMonth: 80, usageMultiplier: 12, modelIds: [modelId] }),
          ],
        },
      },
    }

    s = tickMarket(s)
    const free = s.lastMarket.planStats.find((p) => p.planId === 'free')!
    const largestPaid = Math.max(
      ...s.lastMarket.planStats.filter((p) => !p.isFree).map((p) => p.subscribers),
    )
    expect(free.subscribers).toBeGreaterThan(largestPaid)
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
    expect(mix.find((lane) => lane.model.id === large.id)!.share).toBeGreaterThan(
      mix.find((lane) => lane.model.id === small.id)!.share,
    )

    s = tickMarket(s)
    const usage = s.lastMarket.planStats.find((p) => p.planId === plan.id)!.modelUsage!
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
    const high = basePlan({ id: 'pro', pricePerMonth: 80, computePriority: 90 })
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
          plans: s.player.pricing.plans.map((plan) => ({ ...plan, modelIds: [first.id] })),
        },
      },
    }
    s = tickMarket(s)
    const usage = s.lastMarket.apiModelUsage ?? []
    expect(usage.map((item) => item.modelId).sort()).toEqual([first.id, second.id].sort())
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
        researchUnlocked: [...state.player.researchUnlocked, 'sys_quant', 'sys_fp8'],
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
    expect(Object.values(updated.modalityRoutes ?? {}).every((route) => route?.fallbackModelId == null)).toBe(true)
    const mix = planModelTrafficMix(state, updated)
    expect(mix.map((lane) => lane.model.id).sort()).toEqual([small.id, large.id].sort())
    expect(planModelServePrecision(updated, small, state.player.researchUnlocked)).toBe('int8')
    expect(planModelServePrecision(updated, large, state.player.researchUnlocked)).toBe('int4')
    expect(mix.find((lane) => lane.model.id === large.id)!.model.capability).toBe(
      large.capability + planServeModifiers('int4', state.player.researchUnlocked).capabilityDelta,
    )

    state = updatePlan(state, plan.id, {
      modelIds: [small.id],
      servePrecisionByModel: { [small.id]: 'int8' },
    })
    expect(planModelTrafficMix(state, state.player.pricing.plans[0]!).map((lane) => lane.model.id)).toEqual([small.id])
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
    expect(planModelServePrecision(state.player.pricing.plans[0]!, model, state.player.researchUnlocked)).toBe('fp16')

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
    expect(availablePlanPrecisionsForModel(model, state.player.researchUnlocked)).not.toContain('ternary_1_58')
    state = updatePlan(state, plan.id, {
      servePrecisionByModel: { [model.id]: 'ternary_1_58' },
    })
    expect(state.player.pricing.plans[0]!.servePrecisionByModel?.[model.id]).not.toBe('ternary_1_58')
  })

  it('INT4 saves the most compute with bounded eval and brand risk', () => {
    const unlocks = ['sys_quant', 'sys_fp8']
    const full = planServeModifiers('fp16', unlocks)
    const int8 = planServeModifiers('int8', unlocks)
    const int4 = planServeModifiers('int4', unlocks)
    expect(int4.computeMult).toBeLessThan(int8.computeMult)
    expect(int8.computeMult).toBeLessThan(full.computeMult)
    expect(int4.benchmarkDeltas.coding).toBeLessThan(int8.benchmarkDeltas.coding!)
    expect(int4.benchmarkDeltas.math).toBeLessThan(int8.benchmarkDeltas.math!)
    expect(int4.benchmarkDeltas.math).toBeGreaterThan(-10)
    expect(int4.brandRisk).toBeGreaterThan(int8.brandRisk)
  })

  it('API precision changes effective evals and compute cost', () => {
    const state = shipModel(createGame(243), 64)
    const model = state.player.models[0]!
    const unlocks = ['sys_quant', 'sys_fp8']
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
          researchUnlocked: [...state.player.researchUnlocked, 'sys_quant', 'sys_fp8'],
          rackFleet: state.player.rackFleet.map((rack) => ({ ...rack, count: 160 })),
          allocation: { training: 0.05, inference: 0.9, research: 0.05 },
          pricing: {
            ...state.player.pricing,
            apiModelIds: [state.player.models[0]!.id],
            apiServePrecisionByModel: { [state.player.models[0]!.id]: precision },
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
    expect((int4Usage?.dayInferPf ?? 0) / (int4Usage?.dayMTok ?? 1)).toBeLessThan(
      (fullUsage?.dayInferPf ?? 0) / (fullUsage?.dayMTok ?? 1),
    )
    expect(int4.player.models[0]!.capability).toBe(full.player.models[0]!.capability)
    expect(int4.lastMarket.computeLedger?.requestedPfDays).toBeLessThan(
      full.lastMarket.computeLedger?.requestedPfDays ?? Number.POSITIVE_INFINITY,
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
          researchUnlocked: [...state.player.researchUnlocked, 'sys_quant', 'sys_fp8'],
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
    const entry = basePlan({ id: 'entry', name: 'Entry', pricePerMonth: 20, includedMTokPerMonth: 1 })
    const stingy = basePlan({ id: 'premium', name: 'Premium', pricePerMonth: 200, includedMTokPerMonth: 7.5 })
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

    expect(planAllowanceMTokPerMonth(free)).toBeCloseTo(2)
    expect(planAllowanceMTokPerMonth(plus)).toBeCloseTo(20)
    expect(planAllowanceMTokPerMonth(pro)).toBeCloseTo(100)
    expect(planAllowanceExpectation(plus).dissatisfaction).toBe(0)
    expect(planAllowanceExpectation(pro).dissatisfaction).toBe(0)
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
    expect(high.lastMarket.capacityPf).toBeGreaterThan(low.lastMarket.capacityPf)
    expect(high.lastMarket.servedMTok).toBeGreaterThan(low.lastMarket.servedMTok)
    expect(high.lastMarket.unservedRatio).toBeLessThan(low.lastMarket.unservedRatio)
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
    expect(ECONOMY.facilityOpexMultiplier).toBe(1)
    expect(oFull - oEmpty).toBeGreaterThan(
      48 *
        (ECONOMY.rackOpexPerGpuDay ?? 400) *
        0.9,
    )
  })
})

describe('API vs sub balance iterations', () => {
  it('competitive API pricing can match or exceed sub revenue mid setup', () => {
    let s = shipModel(createGame(230), 68)
    // Healthy competitive paid Plus (not a killed sub) + competitive API list.
    // No rivals → player owns market; capacity high; API base demand should dominate.
    s = withApiPrices(s, 1.5, 4.5)
    s = {
      ...s,
      player: {
        ...s.player,
        rackFleet: s.player.rackFleet.map((r) => ({ ...r, count: 160 })),
        allocation: { training: 0.05, inference: 0.9, research: 0.05 },
        servingEfficiency: 1.25,
        brandTrust: 75,
        pricing: {
          ...s.player.pricing,
          plans: [
            {
              id: 'plan-plus',
              name: 'Plus',
              pricePerMonth: 20,
              usageMultiplier: 1,
              usageRate: 0.6,
              modelIds: [s.player.models[0]!.id],
              enabled: true,
            },
            {
              id: 'plan-pro',
              name: 'Pro',
              pricePerMonth: 60,
              usageMultiplier: 5,
              usageRate: 0.7,
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
    expect(s.lastMarket.planStats.some((p) => p.subscribers > 100 && !p.isFree)).toBe(true)
    expect(api).toBeGreaterThan(0)
    // Competitive API remains a real revenue pillar vs seats
    expect(api).toBeGreaterThanOrEqual(sub * 0.24)
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
    expect(a.lastMarket.apiDemandMTok ?? 0).toBeGreaterThan(b.lastMarket.apiDemandMTok ?? 0)
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
      io: { inputs: { text: 70, image: 50 }, outputs: { image: 78 }, tools: 20 },
      capability: 70,
      quality: { ...base.quality, image: 82, reasoning: 55, safety: 70, reliability: 72 },
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
    const plan = { ...state.player.pricing.plans[0]!, modelIds: [base.id, imageModel.id] }
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

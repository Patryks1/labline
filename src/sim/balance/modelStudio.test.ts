import { describe, expect, it } from 'vitest'
import {
  GYM_PACKAGES,
  POST_TRAIN_GYM_KINDS,
  defaultPostTrainGyms,
  gymQualityForStage,
  gymQualityFromInvestment,
  meanToolProficiency,
  packageTotalCash,
  postTrainGymWorkMult,
  postTrainStageCashCost,
  trainingGymDomainExtras,
} from './modelStudio'
import { postTrainStageEffectiveness, postTrainStageQuote } from './postTraining'
import type { TrainingJob } from '../types'
import { buildScaledModel } from './modelBuild'
import { createGame } from '../createGame'
import {
  createModelRouter,
  investPostTrainGym,
  setActiveModelRouter,
  setRouterLane,
  teachToolSkill,
} from '../systems/modelStudio'
import { planModelTrafficMix } from '../systems/plans'
import { selectPostTrain, startTraining } from '../systems/training'

function withRouterTech(state: ReturnType<typeof createGame>) {
  const unlocked = new Set(state.player.researchUnlocked)
  unlocked.add('sys_router')
  return {
    ...state,
    player: { ...state.player, researchUnlocked: [...unlocked] },
  }
}

function job(trainMTok: number, quality = 70): TrainingJob {
  return {
    targetParamsB: 7,
    trainMTok,
    dataQualityUsed: quality,
    dataPlan: {
      totalUnits: trainMTok,
      totalMTok: trainMTok,
      trainShare: 0.82,
      weights: { chat: 0.5, code: 0.3, math: 0.2 },
      allowSynthetic: false,
    },
    postTrain: 'tools',
    postTrainProgress: 18,
    postTrainTarget: 18,
    postTrainDaysElapsed: 7,
  } as TrainingJob
}

describe('model studio gyms and tools', () => {
  it('raises gym quality with cash and rented compute', () => {
    const foundry = gymQualityFromInvestment(6_000_000, 2_000_000)
    const campus = gymQualityFromInvestment(120_000_000, 90_000_000)
    expect(foundry).toBeGreaterThan(0.1)
    expect(campus).toBeGreaterThan(foundry * 2)
    expect(campus).toBeLessThan(1)
  })

  it('adds a narrow cyber range without granting free general intelligence', () => {
    expect(POST_TRAIN_GYM_KINDS).toContain('cyber')
    const funded = defaultPostTrainGyms().map((gym) =>
      gym.kind === 'cyber'
        ? {
            ...gym,
            investedCash: 120_000_000,
            investedComputeCash: 90_000_000,
          }
        : gym,
    )
    const extras = trainingGymDomainExtras(funded, ['cyber'])
    expect(extras.agents).toBeGreaterThan(extras.coding ?? 0)
    expect(extras.safety).toBeGreaterThan(0)
    expect(extras.law).toBeGreaterThan(0)
    expect(extras.math ?? 0).toBe(0)
    expect(extras.mmlu ?? 0).toBe(0)
  })

  it('makes unfunded gyms waste post-train PF-days', () => {
    expect(postTrainGymWorkMult(0)).toBeGreaterThan(1.6)
    expect(postTrainGymWorkMult(1)).toBeLessThan(postTrainGymWorkMult(0))
  })

  it('charges a 1B SFT pass inside starter-cash range', () => {
    expect(postTrainStageCashCost(1, 'sft', 0)).toBeLessThan(5_000_000)
    expect(postTrainStageCashCost(70, 'rlhf', 0)).toBeGreaterThan(20_000_000)
  })

  it('rejects gym spend the lab cannot afford', () => {
    const broke = {
      ...createGame(44),
      player: {
        ...createGame(44).player,
        cash: 100,
        researchUnlocked: ['domain_coding'],
      },
    }
    const next = investPostTrainGym(broke, 'code', GYM_PACKAGES[0]!.id)
    expect(next.player.cash).toBe(100)
    expect(next.alerts[0]?.severity).toBe('warn')
  })

  it('blocks gym funding until the domain lab is researched', () => {
    let state = createGame(43)
    state = { ...state, player: { ...state.player, cash: 80_000_000 } }
    const next = investPostTrainGym(state, 'code', 'cluster')
    expect(next.player.cash).toBe(state.player.cash)
    expect(next.alerts[0]?.message).toMatch(/Research/i)
  })

  it('funds a gym and teaches a tool from cash', () => {
    let state = createGame(45)
    state = {
      ...state,
      player: {
        ...state.player,
        cash: 80_000_000,
        researchUnlocked: [...state.player.researchUnlocked, 'domain_coding'],
      },
    }
    const before = state.player.cash
    state = investPostTrainGym(state, 'code', 'cluster')
    const gym = state.player.postTrainGyms?.find((entry) => entry.kind === 'code')
    expect(gym?.quality).toBeGreaterThan(0.3)
    expect(state.player.cash).toBe(before - packageTotalCash(GYM_PACKAGES[1]!))
    state = teachToolSkill(state, 'json', 'drill')
    expect(
      state.player.toolSkills?.find((skill) => skill.id === 'json')?.proficiency,
    ).toBeGreaterThan(0.4)
  })
})

describe('post-train coupling', () => {
  it('leaves legacy effectiveness unchanged when gyms are omitted', () => {
    const recipe = job(20_000, 90)
    recipe.postTrainProgress = recipe.postTrainTarget
    const omitted = postTrainStageEffectiveness({
      job: recipe,
      stage: 'tools',
      researchUnlocked: ['domain_agents'],
      models: [],
    })
    const again = postTrainStageEffectiveness({
      job: recipe,
      stage: 'tools',
      researchUnlocked: ['domain_agents'],
      models: [],
    })
    expect(again).toBe(omitted)
  })

  it('rewards funded gyms and tool curricula when they are supplied', () => {
    const recipe = job(20_000, 90)
    recipe.postTrainTarget = 200
    recipe.postTrainProgress = 200
    const emptyGyms = defaultPostTrainGyms()
    const fundedGyms = emptyGyms.map((gym) => ({
      ...gym,
      investedCash: 120_000_000,
      investedComputeCash: 90_000_000,
      quality: gymQualityFromInvestment(120_000_000, 90_000_000),
    }))
    const emptyTools = [
      { id: 'json' as const, proficiency: 0, investedCash: 0, investedComputeCash: 0 },
    ]
    const taughtTools = [
      { id: 'json' as const, proficiency: 0.85, investedCash: 55_000_000, investedComputeCash: 40_000_000 },
    ]
    const weak = postTrainStageEffectiveness({
      job: recipe,
      stage: 'tools',
      researchUnlocked: ['domain_agents', 'domain_coding'],
      models: [],
      gyms: emptyGyms,
      tools: emptyTools,
    })
    const strong = postTrainStageEffectiveness({
      job: recipe,
      stage: 'tools',
      researchUnlocked: ['domain_agents', 'domain_coding'],
      models: [],
      gyms: fundedGyms,
      tools: taughtTools,
    })
    expect(gymQualityForStage('tools', fundedGyms)).toBeGreaterThan(
      gymQualityForStage('tools', emptyGyms),
    )
    expect(meanToolProficiency(taughtTools)).toBeGreaterThan(meanToolProficiency(emptyTools))
    expect(strong).toBeGreaterThan(weak)
  })

  it('charges cash and stretches PF when selecting a post-train stage', () => {
    let state = createGame(46)
    state = {
      ...state,
      player: { ...state.player, cash: 50_000_000 },
    }
    state = startTraining(state, { name: 'Studio', family: 'dense', paramsB: 1 })
    const started = state.player.trainingJob!
    const ready = {
      ...state,
      player: {
        ...state.player,
        trainingJob: {
          ...started,
          progressPfDays: started.targetPfDays,
          daysElapsed: started.minCalendarDays,
        },
        trainingJobs: [
          {
            ...started,
            progressPfDays: started.targetPfDays,
            daysElapsed: started.minCalendarDays,
          },
        ],
      },
    }
    const quote = postTrainStageQuote(started, 'sft', ready.player.postTrainGyms)
    const next = selectPostTrain(ready, started.id, 'sft')
    expect(next.player.trainingJob?.postTrain).toBe('sft')
    expect(next.player.trainingJob?.postTrainTarget).toBe(quote.pfDays)
    expect(next.player.cash).toBe(ready.player.cash - quote.cash)
  })
})

describe('serving routers', () => {
  it('refuses to create a router before Model Router research', () => {
    const locked = createGame(48)
    const next = createModelRouter(locked, 'Nope')
    expect(next.player.modelRouters ?? []).toHaveLength(0)
    expect(next.alerts[0]?.message).toMatch(/Research Model Router/)
  })

  it('keeps the automatic mix until a live router has released lanes', () => {
    const small = buildScaledModel({
      id: 'fast-model',
      name: 'Fast',
      paramsB: 3,
      family: 'dense',
      day: 1,
      dataCoverage: 20,
      dataQuality: 70,
    })
    const large = buildScaledModel({
      id: 'frontier-model',
      name: 'Frontier',
      paramsB: 70,
      family: 'dense',
      day: 1,
      dataCoverage: 40,
      dataQuality: 80,
    })
    let state = withRouterTech(createGame(48))
    const plan = {
      ...state.player.pricing.plans.find((entry) => entry.pricePerMonth > 180)!,
      modelIds: [small.id, large.id],
    }
    state = {
      ...state,
      player: {
        ...state.player,
        models: [
          { ...small, capability: 40 },
          { ...large, capability: 88 },
        ],
        pricing: { ...state.player.pricing, plans: [plan] },
      },
    }
    const automatic = planModelTrafficMix(state, plan)
    expect(automatic).toHaveLength(2)
    const idle = createModelRouter(state, 'Idle')
    expect(planModelTrafficMix(idle, plan)).toEqual(automatic)

    let routed = createModelRouter(state, 'Prod')
    const routerId = routed.player.modelRouters![0]!.id
    routed = setRouterLane(routed, routerId, 'fast', small.id)
    routed = setRouterLane(routed, routerId, 'default', small.id)
    routed = setRouterLane(routed, routerId, 'frontier', large.id)
    routed = setActiveModelRouter(routed, routerId)
    const mix = planModelTrafficMix(routed, plan)
    expect(mix.find((lane) => lane.model.id === large.id)!.share).toBeGreaterThan(
      mix.find((lane) => lane.model.id === small.id)!.share,
    )
    expect(mix.reduce((sum, lane) => sum + lane.share, 0)).toBeCloseTo(1)
  })
})

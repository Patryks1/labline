import { describe, expect, it } from 'vitest'
import { buildScaledModel } from '../balance/modelBuild'
import { buildGameConfig } from '../balance/gameConfig'
import { RESEARCH_NODES } from '../balance/research'
import { ioForPreset } from '../balance/trainingV3'
import { createGame } from '../createGame'
import type { Model, ResearchProgram, RivalLab, RivalTrainJob } from '../types'
import { tickDay } from '../tick'
import { buildRivalPublicEstimate, updateLab } from './labEngine'
import { minResearchersForNode } from './research'
import {
  rivalNextModelBet,
  rivalMediaDataShortfall,
  rivalRoutableModalities,
  synchronizeRivalPlanPrices,
  tickRivals,
} from './rivals'
import { planRivalResearchPath } from './rivalStrategy'
import { rivalResearcherHiringTarget } from './staff'

function released(productPreset: Model['productPreset'], backbone: Model['backbone']): Model {
  return buildScaledModel({
    id: `${productPreset}-${backbone}`,
    name: `${productPreset}-${backbone}`,
    paramsB: 8,
    activeParamsB: backbone === 'moe' ? 1 : undefined,
    family:
      productPreset === 'omni' ? 'omni' :
        productPreset === 'video_generation' ? 'video' :
          productPreset === 'image_generation' ? 'diffusion' : 'dense',
    backbone,
    productPreset,
    day: 10,
    dataCoverage: 1,
    dataQuality: 75,
    researchUnlocked: ['align_process', 'moe_routing'],
    shipped: true,
    release: 'released',
  })
}

describe('rival multimodal lifecycle', () => {
  it('ships every unlocked modality before dense omni and sparse omni', () => {
    const rival = {
      archetype: 'multimodal',
      researchUnlocked: ['mm_vision', 'mm_diff', 'mm_video', 'mm_omni', 'moe_basics'],
      models: [],
    } as Pick<RivalLab, 'archetype' | 'researchUnlocked' | 'models'>

    expect(rivalNextModelBet(rival).productPreset).toBe('audio')
    rival.models.unshift(released('audio', 'dense'))
    expect(rivalNextModelBet(rival).productPreset).toBe('image_generation')
    rival.models.unshift(released('image_generation', 'diffusion'))
    expect(rivalNextModelBet(rival).productPreset).toBe('video_generation')
    rival.models.unshift(released('video_generation', 'diffusion'))
    expect(rivalNextModelBet(rival)).toMatchObject({ productPreset: 'omni', backbone: 'dense' })
    rival.models.unshift(released('omni', 'dense'))
    expect(rivalNextModelBet(rival)).toMatchObject({ productPreset: 'omni', backbone: 'moe' })
  })

  it('plans the modality unlock ladder through the shared prerequisite planner', () => {
    const rival = {
      id: 'multimodal-rival',
      archetype: 'multimodal',
      researchUnlocked: [],
      activeResearch: null,
      researchQueue: [],
      staff: { researcher: 2, engineer: 4, data_processor: 2, ops: 2 },
    } as unknown as RivalLab
    const strategy = {
      goal: 'ship_model',
      decisionRevision: 0,
    } as Parameters<typeof planRivalResearchPath>[1]
    for (const milestone of ['mm_vision', 'mm_diff', 'mm_video', 'mm_omni']) {
      rival.staff!.researcher = minResearchersForNode(milestone)
      const path = planRivalResearchPath(rival, strategy, 7)
      expect(path.at(-1)).toBe(milestone)
      rival.researchUnlocked = [...new Set([...rival.researchUnlocked, ...path])]
    }

    rival.researchUnlocked = []
    expect(rivalResearcherHiringTarget(rival)).toBe(8)

    const stalled = {
      ...rival,
      researchUnlocked: ['dense_basics'],
      researchQueue: ['data_self_train'],
      staff: { ...rival.staff!, researcher: 2 },
    }
    expect(planRivalResearchPath(stalled, strategy, 7).at(-1)).toBe('mm_vision')
    expect(rivalResearcherHiringTarget(stalled)).toBe(12)

    const generalist = { ...rival, id: 'generalist', archetype: 'hyperscale' as const }
    generalist.researchUnlocked = []
    expect(rivalResearcherHiringTarget(generalist)).toBe(3)
    expect(planRivalResearchPath(generalist, strategy, 7).at(-1)).not.toBe('mm_vision')
  })

  it('persists the fifth product milestone when release evicts the first serving model', () => {
    const initial = createGame({ config: buildGameConfig({ seed: 403 }) })
    const sourceRival = initial.rivals.find((entry) => entry.archetype === 'multimodal')!
    const audio = released('audio', 'dense')
    const image = released('image_generation', 'diffusion')
    const video = released('video_generation', 'diffusion')
    const denseOmni = released('omni', 'dense')
    const trainingJob: RivalTrainJob = {
      id: 'fifth-product-run',
      name: 'Chroma sparse omni',
      family: 'omni',
      backbone: 'moe',
      productPreset: 'omni',
      io: ioForPreset('omni'),
      paramsB: 8,
      activeParamsB: 1,
      targetPfDays: 1,
      progressPfDays: 1,
      modalities: ['text', 'image', 'audio', 'video', 'tools'],
      dataCoverage: 1,
      dataQuality: 80,
      includeSynthHQ: false,
      includeSynthLQ: false,
      synthLqShare: 0,
      trainShare: 0.82,
      totalMTok: 8_000,
      effectiveDataRatio: 1,
      repeatedDataEpochs: 1,
      modalityComputeMult: 1,
      cashBurnPerDay: 0,
      trainingNumerics: {
        computeFormat: 'fp32',
        nativeWeightFormat: 'float',
        recipeVersion: 1,
      },
    }
    const rival: RivalLab = {
      ...sourceRival,
      researchUnlocked: ['mm_vision', 'mm_diff', 'mm_video', 'mm_omni', 'moe_basics'],
      models: [denseOmni, video, image, audio],
      trainingJob,
      // Legacy saves only have their four-model serving fleet. The next tick
      // must backfill these before the fifth release evicts audio.
      releaseMilestones: undefined,
    }
    const state = {
      ...initial,
      rivals: initial.rivals.map((entry) => entry.id === rival.id ? rival : entry),
    }
    const completed = tickRivals(state)
    const next = completed.rivals.find((entry) => entry.id === rival.id)!

    expect(next.models).toHaveLength(4)
    expect(next.models.some((model) => model.productPreset === 'audio')).toBe(false)
    expect(next.releaseMilestones).toHaveLength(5)
    expect(rivalNextModelBet(next)).toMatchObject({
      productPreset: 'omni',
      backbone: 'moe',
      label: 'sparse omni iteration',
    })
    const sparseOmni = next.models.find(
      (model) => model.productPreset === 'omni' && model.backbone === 'moe',
    )!
    expect(sparseOmni.trainingNumerics).toEqual(trainingJob.trainingNumerics)
    expect(sparseOmni.nativeWeightPrecision).toBe('fp32')
    expect((sparseOmni.io?.outputs.audio ?? 0) / sparseOmni.capability).toBeGreaterThan(0.4)

    const routed = tickRivals({ ...completed, day: completed.day + 1 })
      .rivals.find((entry) => entry.id === rival.id)!
    for (const plan of routed.pricing.plans) {
      for (const modality of ['text', 'image', 'audio', 'video'] as const) {
        const route = plan.modalityRoutes?.[modality]
        expect(route?.primaryModelId).toBeTruthy()
        const model = routed.models.find(
          (candidate) => candidate.id === route?.primaryModelId,
        )!
        expect(rivalRoutableModalities(model)).toContain(modality)
      }
    }
  })

  it('keeps advertised rival tier prices synchronized with enabled plan offers', () => {
    const initial = createGame({ config: buildGameConfig({ seed: 406 }) })
    for (const rival of initial.rivals) {
      const pricing = synchronizeRivalPlanPrices(rival.pricing)
      const enabled = pricing.plans.filter((plan) => plan.enabled)
      expect(enabled[0]?.pricePerMonth).toBe(pricing.subPlusPrice)
      expect(enabled[1]?.pricePerMonth).toBe(pricing.subProPrice)
    }
  })

  it('cannot start a media recipe on requested weights with zero actual media', () => {
    expect(
      rivalMediaDataShortfall({
        family: 'diffusion',
        productPreset: 'image_generation',
        consumed: { chat: 100, image: 0 },
      }),
    ).toMatchObject({ domain: 'image', requiredShare: 0.15, actualShare: 0 })
    expect(
      rivalMediaDataShortfall({
        family: 'video',
        productPreset: 'video_generation',
        consumed: { chat: 70, image: 10, video: 20 },
      }),
    ).toBeNull()
  })

  it('organically researches and ships every native media product in a seeded run', () => {
    let state = createGame({
      config: buildGameConfig({
        seed: 407,
        difficulty: 'easy',
        advanced: {
          researchCostMult: 0.4,
          startingCashMult: 3,
          economyMult: 0.4,
          rivalCount: 5,
        },
      }),
    })
    state = {
      ...state,
      rivals: state.rivals.map((rival) => {
        if (rival.archetype !== 'multimodal') return rival
        const data = rival.data!
        const stocks = { ...data.stocks }
        for (const domain of ['image', 'audio', 'video'] as const) {
          stocks[domain] = {
            ...stocks[domain],
            processed: 20_000,
            fromWeb: 20_000,
          }
        }
        return {
          ...rival,
          cash: 5_000_000_000,
          staff: {
            researcher: 12,
            engineer: 8,
            data_processor: 8,
            ops: 4,
          },
          data: {
            ...data,
            stocks,
            assets: [
              ...(data.assets ?? []),
              ...(['image', 'audio', 'video'] as const).map((domain) => ({
                ...data.assets[0]!,
                id: `seeded-${domain}-corpus`,
                name: `Seeded ${domain} corpus`,
                volumeMTok: 20_000,
                domainWeights: { [domain]: 1 },
                verticalTags: [domain, 'seeded-test-corpus'],
              })),
            ],
          },
          dataMTok: 60_500,
        }
      }),
    }

    // The organic controller must clear research, data, staffing, training,
    // and release gates without injected unlocks. Leave room for a complete
    // product cycle after the final omni research milestone lands.
    for (let day = 0; day < 320; day += 1) {
      state = tickDay(state)
      const rival = state.rivals.find(
        (candidate) => candidate.archetype === 'multimodal',
      )!
      const shipped = new Set(
        rival.releaseMilestones?.map((milestone) => milestone.productPreset),
      )
      if (
        ['audio', 'image_generation', 'video_generation', 'omni'].every(
          (preset) => shipped.has(preset as NonNullable<Model['productPreset']>),
        )
      ) {
        break
      }
    }

    const rival = state.rivals.find(
      (candidate) => candidate.archetype === 'multimodal',
    )!
    expect(rival.researchUnlocked).toEqual(
      expect.arrayContaining(['mm_vision', 'mm_diff', 'mm_video', 'mm_omni']),
    )
    expect(rival.releaseMilestones?.map((milestone) => milestone.productPreset)).toEqual(
      expect.arrayContaining(['audio', 'image_generation', 'video_generation', 'omni']),
    )
  })

  it('projects secret research generically and names only disclosed programs', () => {
    const initial = createGame({ config: buildGameConfig({ seed: 404 }) })
    const rival = initial.rivals.find((entry) => entry.archetype === 'multimodal')!
    const program: ResearchProgram = {
      id: 'program-secret-video',
      methodId: 'mm_video',
      podId: rival.researchPods![0]!.id,
      phase: 'validation',
      evidence: [{ id: 'evidence-video', strength: 0.91, source: 'pilot', day: 10 }],
      insightProgress: 0.8,
      engineeringProgress: 0.5,
      computeShare: 0.2,
      disclosure: 'secret',
    }
    const secretState = updateLab(initial, rival.id, (lab) => ({
      ...lab,
      activeResearch: 'mm_video',
      researchPrograms: [program],
    }))
    const secret = buildRivalPublicEstimate(secretState, rival.id)
    expect(secret.currentBet).toBe('Undisclosed research program')
    expect(secret.announcedProject).toBeNull()
    expect(secret.researchDisclosure).toBeUndefined()
    expect(secret.currentBetConfidence).toBeLessThan(secret.confidence)

    const disclosedState = updateLab(secretState, rival.id, (lab) => ({
      ...lab,
      researchPrograms: [{ ...program, disclosure: 'published' }],
    }))
    const disclosed = buildRivalPublicEstimate(disclosedState, rival.id)
    expect(disclosed.currentBet).toBe('Published: Video Temporal Models')
    expect(disclosed.announcedProject).toBe('Published research: Video Temporal Models')
    expect(disclosed.researchDisclosure).toBe('published')
    expect(disclosed.currentBetConfidence).toBeGreaterThanOrEqual(0.9)
  })

  it('keeps private training topology uncertain even when the inferred bet is specific', () => {
    const initial = createGame({ config: buildGameConfig({ seed: 405 }) })
    const rival = initial.rivals.find((entry) => entry.archetype === 'multimodal')!
    const job = {
      id: 'private-omni-run',
      family: 'omni',
      backbone: 'moe',
      productPreset: 'omni',
    } as RivalTrainJob
    const lowConfidenceState = updateLab(initial, rival.id, (lab) => ({
      ...lab,
      trainingJob: job,
    }))
    const lowConfidence = buildRivalPublicEstimate(lowConfidenceState, rival.id)
    expect(lowConfidence.currentBet).toContain('Likely')
    expect(lowConfidence.currentBet).not.toContain('MOE')

    const highConfidenceState = { ...lowConfidenceState, day: 1_000 }
    const highConfidence = buildRivalPublicEstimate(highConfidenceState, rival.id)
    expect(highConfidence.currentBet).toBe('Likely omni using a MOE backbone')
    expect(highConfidence.currentBetConfidence).toBeLessThan(0.9)
  })

  it('preserves omni product I/O on a MoE backbone through shared construction', () => {
    const model = released('omni', 'moe')
    expect(model.family).toBe('omni')
    expect(model.backbone).toBe('moe')
    expect(model.activeParamsB).toBe(1)
    expect(model.io?.outputs.audio).toBeGreaterThan(0)
    expect(model.io?.outputs.video).toBeGreaterThan(0)
    expect(model.benchmarkSuites?.omni_overview).toBeDefined()
    expect(model.serviceProfile?.audioRealtimeFactor).not.toBeNull()
  })

  it('keeps the expanded catalog unique and separates Medusa from training MTP', () => {
    const ids = RESEARCH_NODES.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(RESEARCH_NODES.length).toBeGreaterThanOrEqual(97)
    expect(RESEARCH_NODES.find((node) => node.id === 'sys_medusa')?.effects.servingEfficiency).toBeGreaterThan(0)
    expect(RESEARCH_NODES.find((node) => node.id === 'dense_mtp')?.effects.capabilityBonus).toBeGreaterThan(0)
  })
})

import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { RivalTrainJob } from '../types'
import { buildScaledModel } from '../balance/modelBuild'
import { analyzeTrainingData } from '../balance/trainingV3'
import { createDataManifest } from './dataAssets'
import {
  progressRivalTrainingJob,
  rivalListedApiPrice,
  tickRivals,
} from './rivals'
import { syncLabIndex } from './labEngine'

function activeJob(rivalId: string): RivalTrainJob {
  return {
    id: `job-${rivalId}`,
    name: 'Physical catch-up train',
    family: 'dense',
    paramsB: 1,
    targetPfDays: 100_000,
    progressPfDays: 10,
    modalities: ['text'],
    dataCoverage: 1,
    dataQuality: 70,
    includeSynthHQ: false,
    includeSynthLQ: false,
    synthLqShare: 0,
    trainShare: 0.82,
    totalMTok: 1_000,
    cashBurnPerDay: 0,
    cashSunk: 0,
  }
}

describe('rival compute parity', () => {
  it('anchors native media competitors at the same effective commercial price', () => {
    const state = createGame(730)
    const model = buildScaledModel({
      id: 'native-rival-peer',
      name: 'Native rival peer',
      paramsB: 2,
      family: 'diffusion',
      productPreset: 'image_generation',
      day: state.day,
      dataCoverage: 1,
      dataQuality: 70,
      shipped: true,
      release: 'released',
    })
    expect(
      rivalListedApiPrice(state.rivals[0]!.pricing, {
        ...model,
        apiPricePerMTok: 2,
        apiPriceInPerMTok: 1,
        apiPriceOutPerMTok: 3,
        apiPricePerImage: 0.04,
      }),
    ).toBeCloseTo(10, 12)
  })

  it('caps each job step at both available work and remaining work', () => {
    const job = activeJob('rival_test')
    expect(progressRivalTrainingJob(job, 2.5)).toMatchObject({
      workAppliedPfDays: 2.5,
      job: { progressPfDays: 12.5 },
    })
    const nearlyDone = { ...job, progressPfDays: 99_999.25 }
    expect(progressRivalTrainingJob(nearlyDone, 80)).toMatchObject({
      workAppliedPfDays: 0.75,
      job: { progressPfDays: 100_000 },
    })
    expect(progressRivalTrainingJob(job, Number.POSITIVE_INFINITY).workAppliedPfDays).toBe(0)
  })

  it('replays rival controller decisions deterministically from the same state', () => {
    const created = createGame(731)
    const state = {
      ...created,
      rivals: created.rivals.map((rival, index) =>
        index === 0 ? { ...rival, trainingJob: activeJob(rival.id) } : rival,
      ),
    }
    const first = tickRivals(state)
    const second = tickRivals(state)
    expect(
      first.rivals.map((rival) => ({
        id: rival.id,
        allocation: rival.allocation,
        researchQueue: rival.researchQueue,
        activeResearch: rival.activeResearch,
        trainingJob: rival.trainingJob,
        pricing: rival.pricing,
        strategy: rival.strategy,
      })),
    ).toEqual(
      second.rivals.map((rival) => ({
        id: rival.id,
        allocation: rival.allocation,
        researchQueue: rival.researchQueue,
        activeResearch: rival.activeResearch,
        trainingJob: rival.trainingJob,
        pricing: rival.pricing,
        strategy: rival.strategy,
      })),
    )
  })

  it('freezes researched and hardware-compatible numerics onto new rival jobs', () => {
    const created = createGame(731)
    const state = {
      ...created,
      rivals: created.rivals.map((rival) =>
        rival.archetype === 'efficiency'
          ? {
              ...rival,
              researchUnlocked: [
                ...rival.researchUnlocked,
                'opt_mixed',
                'opt_fp8_train',
              ],
            }
          : rival,
      ),
    }
    const next = tickRivals(state)
    const efficiency = next.rivals.find((rival) => rival.archetype === 'efficiency')
    expect(efficiency?.trainingJob?.trainingNumerics).toEqual({
      computeFormat: 'fp8_hybrid',
      nativeWeightFormat: 'float',
      recipeVersion: 1,
    })
  })

  it('converts conserved raw training PF through the frozen numerical format', () => {
    const created = createGame(732)
    const target = created.rivals[0]!
    const stateFor = (computeFormat: 'fp16_mixed' | 'fp8_hybrid') => ({
      ...created,
      rivals: created.rivals.map((rival) =>
        rival.id === target.id
          ? {
              ...rival,
              researchUnlocked: [
                ...rival.researchUnlocked,
                'opt_mixed',
                'opt_fp8_train',
              ],
              trainingJob: {
                ...activeJob(rival.id),
                trainingNumerics: {
                  computeFormat,
                  nativeWeightFormat: 'float' as const,
                  recipeVersion: 1,
                },
              },
            }
          : rival,
      ),
    })
    const fp16 = tickRivals(stateFor('fp16_mixed')).rivals.find(
      (rival) => rival.id === target.id,
    )!
    const fp8 = tickRivals(stateFor('fp8_hybrid')).rivals.find(
      (rival) => rival.id === target.id,
    )!
    const fp16Work = (fp16.trainingJob?.progressPfDays ?? 10) - 10
    const fp8Work = (fp8.trainingJob?.progressPfDays ?? 10) - 10
    expect(fp8Work).toBeGreaterThan(fp16Work)
  })

  it('uses the same hard HBM and host-RAM placement gate for rival training', () => {
    const created = createGame(733)
    const target = created.rivals[0]!
    const largeJob: RivalTrainJob = {
      ...activeJob(target.id),
      paramsB: 100,
      activeParamsB: 100,
      trainingNumerics: {
        computeFormat: 'fp16_mixed',
        nativeWeightFormat: 'float',
        recipeVersion: 1,
      },
    }
    const stateFor = (chips: number) =>
      syncLabIndex({
        ...created,
        rivals: created.rivals.map((rival) =>
          rival.id === target.id
            ? {
                ...rival,
                chips,
                flopsPf: chips * 0.7,
                trainingJob: largeJob,
              }
            : rival,
        ),
      })

    const blocked = tickRivals(stateFor(1)).rivals.find(
      (rival) => rival.id === target.id,
    )!
    const admitted = tickRivals(stateFor(100)).rivals.find(
      (rival) => rival.id === target.id,
    )!

    expect(blocked.trainingJob?.progressPfDays).toBe(largeJob.progressPfDays)
    expect(admitted.trainingJob?.progressPfDays).toBeGreaterThan(
      largeJob.progressPfDays,
    )
  })

  it('generates synthetic data every day once synthetic tech is unlocked', () => {
    const created = createGame(734)
    const target = created.rivals[0]!
    const teacher = {
      ...buildScaledModel({
        id: `teacher-${target.id}`,
        name: 'Teacher',
        paramsB: 8,
        family: 'dense' as const,
        backbone: 'dense' as const,
        productPreset: 'language' as const,
        day: 10,
        dataCoverage: 1,
        dataQuality: 75,
        researchUnlocked: [],
        shipped: true,
        release: 'released' as const,
      }),
      capability: 60,
    }
    const state = {
      ...created,
      rivals: created.rivals.map((rival) =>
        rival.id === target.id
          ? {
              ...rival,
              researchUnlocked: [...rival.researchUnlocked, 'data_synth'],
              models: [teacher],
            }
          : rival,
      ),
    }

    const first = tickRivals(state).rivals.find(
      (rival) => rival.id === target.id,
    )!
    const second = tickRivals({ ...state, day: state.day + 1 }).rivals.find(
      (rival) => rival.id === target.id,
    )!

    expect(first.data?.daySynthMTok ?? 0).toBeGreaterThan(0)
    expect(second.data?.daySynthMTok ?? 0).toBeGreaterThan(0)
  })

  it('rates rival jobs from the attributed manifest rather than requested stock totals', () => {
    const created = createGame(735)
    const target = created.rivals[0]!
    const foundation = target.data!.assets[0]!
    const data = {
      ...target.data!,
      stocks: {
        ...target.data!.stocks,
        code: {
          ...target.data!.stocks.code,
          processed: 0,
          fromWeb: 0,
          fromUser: 0,
          fromBought: 0,
          fromSynth: 0,
          fromSynthHQ: 0,
          fromSynthLQ: 0,
        },
      },
      assets: [
        {
          ...foundation,
          id: 'rival-small-chat',
          volumeMTok: 40,
          domainWeights: { chat: 1 },
          diversity: 0.3,
          freshness: 0.25,
          contaminationRisk: 0.55,
          rights: 'restricted' as const,
        },
      ],
    }
    const { manifest } = createDataManifest({
      data,
      consumed: { chat: 400, code: 600 },
      totalMTok: 1_000,
      day: created.day,
      seed: created.seed,
      runId: 'rival-attribution-regression',
    })
    const analysis = analyzeTrainingData({
      paramsB: 1,
      family: 'dense',
      plan: {
        totalUnits: 1_000,
        totalMTok: 1_000,
        trainShare: 0.82,
        weights: { chat: 0.4, code: 0.6 },
        allowSynthetic: false,
      },
      actualMTok: 1_000,
      quality: 80,
      manifest,
    })

    expect(manifest.domainWeights).toEqual({ chat: 1 })
    expect(analysis.uniqueMTok).toBe(40)
    expect(analysis.repeatedMTok).toBe(960)
    expect(analysis.risk).toBe('high')
    expect(analysis.warnings.join(' ')).toMatch(/contamination/i)
  })
})

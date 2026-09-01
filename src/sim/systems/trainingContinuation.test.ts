import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { Model, SimState, TrainingJob } from '../types'
import { ensureLabData } from './data'
import {
  completeTrainingJobsNow,
  keepInternal,
  releaseFromJob,
  selectPostTrain,
  startTraining,
} from './training'

function richState(seed: number): SimState {
  const state = createGame(seed)
  return {
    ...state,
    player: {
      ...state.player,
      cash: 10_000_000_000,
      allocation: { training: 0.9, inference: 0.05, research: 0.05 },
    },
  }
}

function addFreshTextData(state: SimState, volume = 2_000): SimState {
  const data = ensureLabData(state)
  const perDomain = volume / 2
  const stocks = { ...data.stocks }
  for (const domain of ['chat', 'code'] as const) {
    const stock = stocks[domain]
    stocks[domain] = {
      ...stock,
      processed: stock.processed + perDomain,
      fromWeb: stock.fromWeb + perDomain,
    }
  }
  return {
    ...state,
    day: state.day + 1,
    player: {
      ...state.player,
      data: {
        ...data,
        stocks,
        lifetimeProcessed: data.lifetimeProcessed + volume,
      },
    },
  }
}

function baseModel(
  seed: number,
  release: 'internal' | 'released',
  withSft = false,
): { state: SimState; model: Model } {
  let state = startTraining(richState(seed), {
    name: 'Atlas',
    family: 'dense',
    paramsB: 1,
    dataPlan: {
      totalUnits: 500,
      totalMTok: 500,
      weights: { chat: 0.6, code: 0.4 },
      allowSynthetic: true,
    },
  })
  expect(state.player.trainingJob, state.alerts[0]?.message).not.toBeNull()
  state = completeTrainingJobsNow(state)
  if (withSft) {
    state = selectPostTrain(state, state.player.trainingJob!.id, 'sft')
    state = completeTrainingJobsNow(state)
  }
  state =
    release === 'released'
      ? releaseFromJob(state)
      : keepInternal(state)
  return { state, model: state.player.models.at(-1)! }
}

function completedJobState(state: SimState): SimState {
  const job = state.player.trainingJob!
  const completed: TrainingJob = {
    ...job,
    progressPfDays: job.targetPfDays,
    daysElapsed: job.minCalendarDays ?? 0,
  }
  return {
    ...state,
    player: {
      ...state.player,
      trainingJob: completed,
      trainingJobs: [completed],
    },
  }
}

describe('continued-training model versions', () => {
  it.each(['internal', 'released'] as const)(
    'continues an %s checkpoint without changing its immutable architecture',
    (sourceRelease) => {
      const initial = baseModel(2101 + (sourceRelease === 'released' ? 1 : 0), sourceRelease)
      const source = initial.model
      let state = addFreshTextData(initial.state)

      state = startTraining(state, {
        name: source.name,
        family: 'diffusion',
        backbone: 'diffusion',
        productPreset: 'image_generation',
        paramsB: 999,
        activeParamsB: 3,
        mode: 'continue',
        continueFromId: source.id,
        modelStack: ['some_future_architecture'],
        trainingNumerics: {
          computeFormat: 'nvfp4',
          nativeWeightFormat: 'ternary_1_58',
          recipeVersion: 99,
        },
        dataPlan: {
          totalUnits: 600,
          totalMTok: 600,
          weights: { chat: 0.5, code: 0.5 },
          allowSynthetic: false,
        },
      })

      const job = state.player.trainingJob!
      expect(job, state.alerts[0]?.message).toBeTruthy()
      expect(job).toMatchObject({
        family: source.family,
        backbone: source.backbone,
        productPreset: source.productPreset,
        targetParamsB: source.paramsB,
        activeParamsB: source.activeParamsB,
        modelStack: source.modelStack ?? [],
        trainingNumerics: source.trainingNumerics,
        continueFromId: source.id,
        continueLineageId: source.lineageId ?? source.id,
      })

      state = releaseFromJob(completedJobState(state), job.id)
      const version = state.player.models.at(-1)!
      expect(version.id).not.toBe(source.id)
      expect(version.parentModelId).toBe(source.id)
      expect(version.lineageId).toBe(source.lineageId ?? source.id)
      expect(version.revision).toBe((source.revision ?? 1) + 1)
      expect(version.name).toMatch(/ 0\.2$/)
      expect(version).toMatchObject({
        family: source.family,
        backbone: source.backbone,
        productPreset: source.productPreset,
        paramsB: source.paramsB,
        activeParamsB: source.activeParamsB,
        modelStack: source.modelStack ?? [],
        trainingNumerics: source.trainingNumerics,
        release: 'released',
      })
      expect(state.player.models.find((model) => model.id === source.id)).toEqual(source)
    },
  )

  it('refreshes SFT and adds tools once per new version with diminishing returns', () => {
    const initial = baseModel(2110, 'released', true)
    const source = {
      ...initial.model,
      apiPricePerMTok: 9_000,
      apiPriceInPerMTok: 9_000,
      apiPriceOutPerMTok: 9_000,
    }
    let state: SimState = {
      ...initial.state,
      player: {
        ...initial.state.player,
        researchUnlocked: [
          ...initial.state.player.researchUnlocked,
          'domain_agents',
        ],
        models: initial.state.player.models.map((model) =>
          model.id === source.id ? source : model,
        ),
      },
    }
    state = addFreshTextData(state, 4_000)
    state = startTraining(state, {
      name: source.name,
      family: source.family,
      paramsB: source.paramsB,
      mode: 'continue',
      continueFromId: source.id,
      dataPlan: {
        totalUnits: 1_000,
        totalMTok: 1_000,
        weights: { chat: 0.5, code: 0.5 },
        allowSynthetic: false,
      },
    })
    state = completedJobState(state)
    const jobId = state.player.trainingJob!.id

    state = selectPostTrain(state, jobId, 'sft')
    expect(state.player.trainingJob?.postTrain).toBe('sft')
    state = completeTrainingJobsNow(state)
    state = selectPostTrain(state, jobId, 'tools')
    expect(state.player.trainingJob?.postTrain).toBe('tools')
    state = completeTrainingJobsNow(state)
    state = releaseFromJob(state, jobId)

    const version = state.player.models.at(-1)!
    expect(version.id).not.toBe(source.id)
    expect(version.postTrainStageRuns).toMatchObject({ sft: 2, tools: 1 })
    expect(version.postTrainStageEffectiveness?.sft).toBeGreaterThan(
      source.postTrainStageEffectiveness?.sft ?? 0,
    )
    expect(version.postTrainStageEffectiveness?.sft).toBeLessThanOrEqual(1)
    expect(version.completedPostTrainStages).toEqual(
      expect.arrayContaining(['sft', 'tools']),
    )
    expect(version.apiPriceInPerMTok).toBeLessThan(1_000)
    expect(version.apiPriceOutPerMTok).toBeLessThan(1_000)
    expect(state.player.models.find((model) => model.id === source.id)).toEqual(source)
  })

  it('blocks concurrent branches anywhere in the same lineage but ignores failed jobs', () => {
    const initial = baseModel(2120, 'released')
    let state = addFreshTextData(initial.state, 4_000)
    const common = {
      family: initial.model.family,
      paramsB: initial.model.paramsB,
      mode: 'continue' as const,
      continueFromId: initial.model.id,
      dataPlan: {
        totalUnits: 500,
        totalMTok: 500,
        weights: { chat: 0.5, code: 0.5 },
        allowSynthetic: false,
      },
    }
    state = startTraining(state, { ...common, name: 'Branch A' })
    const active = state.player.trainingJob!
    const blocked = startTraining(state, { ...common, name: 'Branch B' })
    expect(blocked.player.trainingJobs).toHaveLength(1)
    expect(blocked.alerts[0]?.message).toContain('continuation run in progress')

    const failedState: SimState = {
      ...state,
      player: {
        ...state.player,
        trainingJob: { ...active, failed: true },
        trainingJobs: [{ ...active, failed: true }],
      },
    }
    const retried = startTraining(failedState, { ...common, name: 'Retry' })
    expect(retried.player.trainingJobs).toHaveLength(2)
  })

  it('turns extra funded compute into bounded capability and benchmark gains', () => {
    let state = startTraining(richState(2130), {
      name: 'Extended',
      family: 'dense',
      paramsB: 1,
      dataPlan: {
        totalUnits: 500,
        totalMTok: 500,
        weights: { chat: 0.6, code: 0.4 },
        allowSynthetic: true,
      },
    })
    const job = state.player.trainingJob!
    const recommended = job.recommendedPfDays ?? job.targetPfDays
    const completed = {
      ...job,
      progressPfDays: recommended,
      targetPfDays: recommended,
      daysElapsed: job.minCalendarDays ?? 0,
    }
    const extended = {
      ...job,
      progressPfDays: recommended * 2,
      targetPfDays: recommended * 2,
      recommendedPfDays: recommended,
      extensionDays: 30,
      daysElapsed: (job.minCalendarDays ?? 0) + 30,
    }
    const withJob = (candidate: TrainingJob): SimState => ({
      ...state,
      player: {
        ...state.player,
        trainingJob: candidate,
        trainingJobs: [candidate],
      },
    })

    const baseline = keepInternal(withJob(completed), job.id).player.models.at(-1)!
    const overtrained = keepInternal(withJob(extended), job.id).player.models.at(-1)!
    expect(overtrained.capability).toBeGreaterThan(baseline.capability + 1)
    expect(overtrained.benchmarks.mmlu).toBeGreaterThan(baseline.benchmarks.mmlu)
    expect(overtrained.capability - baseline.capability).toBeLessThan(6)
  })
})

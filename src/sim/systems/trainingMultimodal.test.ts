import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { DataDomain, SimState } from '../types'
import { ensureLabData } from './data'
import { trainingDataModalityRequirements } from '../balance/trainingV3'
import {
  completeTrainingJobsNow,
  defaultTrainingDataWeights,
  keepInternal,
  startTraining,
  trainingUnlockEligibility,
} from './training'

function withMediaStock(
  state: SimState,
  volumes: Partial<Record<DataDomain, number>>,
): SimState {
  const data = ensureLabData(state)
  const stocks = { ...data.stocks }
  for (const [domain, volume] of Object.entries(volumes) as [DataDomain, number][]) {
    stocks[domain] = {
      ...stocks[domain],
      processed: volume,
      fromWeb: volume,
      fromUser: 0,
      fromBought: 0,
      fromSynthHQ: 0,
      fromSynthLQ: 0,
    }
  }
  return {
    ...state,
    player: {
      ...state.player,
      cash: Math.max(state.player.cash, 1_000_000_000),
      data: { ...data, stocks },
    },
  }
}

function withResearch(state: SimState, ...nodeIds: string[]): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      researchUnlocked: [
        ...new Set([...state.player.researchUnlocked, ...nodeIds]),
      ],
    },
  }
}

describe('player multimodal training gates', () => {
  it('uses one unlock policy for native products and sparse topology', () => {
    const base = ['dense_basics']
    expect(
      trainingUnlockEligibility({
        family: 'dense',
        backbone: 'dense',
        productPreset: 'audio',
        researchUnlocked: base,
      }),
    ).toMatchObject({ ok: false, researchNodeId: 'mm_vision' })
    expect(
      trainingUnlockEligibility({
        family: 'diffusion',
        backbone: 'diffusion',
        productPreset: 'image_generation',
        researchUnlocked: [...base, 'mm_diff'],
      }).ok,
    ).toBe(true)
    expect(
      trainingUnlockEligibility({
        family: 'omni',
        backbone: 'moe',
        productPreset: 'omni',
        researchUnlocked: [...base, 'mm_omni'],
      }),
    ).toMatchObject({ ok: false, researchNodeId: 'moe_basics' })
  })

  it('uses product-aware family defaults while custom data mix is locked', () => {
    let state = withMediaStock(createGame(981), { image: 500 })
    state = withResearch(state, 'mm_vision', 'mm_diff')
    state = startTraining(state, {
      name: 'Locked image defaults',
      family: 'diffusion',
      backbone: 'diffusion',
      productPreset: 'image_generation',
      paramsB: 0.01,
    })

    expect(state.player.trainingJob, state.alerts[0]?.message).not.toBeNull()
    expect(state.player.trainingJob?.dataPlan.weights.image).toBeGreaterThanOrEqual(0.15)
    expect(state.player.trainingJob?.dataConsumed.image).toBeGreaterThan(0)
  })

  it('aligns the locked audio recipe with the authoritative ten-percent floor', () => {
    const defaults = defaultTrainingDataWeights('dense', 'audio')
    expect(defaults.audio).toBeCloseTo(0.1, 8)

    let state = withMediaStock(createGame(982), { audio: 500 })
    state = withResearch(state, 'mm_vision')
    state = startTraining(state, {
      name: 'Native audio',
      family: 'dense',
      backbone: 'dense',
      productPreset: 'audio',
      paramsB: 0.01,
    })
    expect(state.player.trainingJob, state.alerts[0]?.message).not.toBeNull()

    state = keepInternal(completeTrainingJobsNow(state))
    const model = state.player.models.find((candidate) => candidate.name === 'Native audio')
    expect(model?.productPreset).toBe('audio')
    expect(model?.serviceProfile?.audioRealtimeFactor).not.toBeNull()
  })

  it('rejects requested media weights when no matching media was consumed', () => {
    let state = withMediaStock(createGame(983), { image: 0 })
    state = withResearch(state, 'mm_vision', 'mm_diff', 'data_mix')
    state = startTraining(state, {
      name: 'Imaginary image data',
      family: 'diffusion',
      backbone: 'diffusion',
      productPreset: 'image_generation',
      paramsB: 0.01,
      dataPlan: {
        totalUnits: 100,
        totalMTok: 100,
        weights: { image: 1 },
        allowSynthetic: false,
      },
    })

    expect(state.player.trainingJob).toBeNull()
    expect(state.alerts[0]?.message).toContain('0%')
    expect(state.alerts[0]?.message).toContain('actual image data')
  })

  it('checks the actual consumed share after per-domain stock shortages', () => {
    let state = withMediaStock(createGame(984), {
      chat: 100,
      image: 1,
      code: 0,
      math: 0,
      science: 0,
      law: 0,
      health: 0,
      audio: 0,
      video: 0,
    })
    state = withResearch(state, 'mm_vision', 'mm_diff', 'data_mix')
    state = startTraining(state, {
      name: 'Thin actual image data',
      family: 'diffusion',
      backbone: 'diffusion',
      productPreset: 'image_generation',
      paramsB: 0.01,
      dataPlan: {
        totalUnits: 100,
        totalMTok: 100,
        weights: { chat: 0.8, image: 0.2 },
        allowSynthetic: false,
      },
    })

    expect(state.player.trainingJob).toBeNull()
    expect(state.alerts[0]?.message).toContain('actual image data')
    const share = Number(
      state.alerts[0]?.message.match(/attribute ([\d.]+)%/)?.[1],
    )
    expect(share).toBeGreaterThan(0)
    expect(share).toBeLessThan(15)
  })

  it('does not apply native image floors to omni runs', () => {
    expect(trainingDataModalityRequirements('omni', 'omni')).toEqual({})
    expect(trainingDataModalityRequirements('dense', 'omni')).toEqual({})

    let state = withMediaStock(createGame(985), {
      chat: 3000,
      image: 290,
      code: 0,
      math: 0,
      science: 0,
      law: 0,
      health: 0,
      audio: 0,
      video: 0,
    })
    state = withResearch(
      state,
      'mm_vision',
      'mm_diff',
      'mm_video',
      'mm_omni',
      'data_mix',
    )
    state = startTraining(state, {
      name: 'Omni without image floor',
      family: 'omni',
      backbone: 'dense',
      productPreset: 'omni',
      paramsB: 0.01,
      dataPlan: {
        totalUnits: 3290,
        totalMTok: 3290,
        weights: { chat: 0.912, image: 0.088 },
        allowSynthetic: false,
      },
    })

    expect(state.player.trainingJob, state.alerts[0]?.message).not.toBeNull()
    expect(state.alerts[0]?.message ?? '').not.toContain('actual image data')
  })
})

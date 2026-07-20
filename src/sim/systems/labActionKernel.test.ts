import { describe, expect, it } from 'vitest'
import { buildScaledModel } from '../balance/modelBuild'
import { createGame } from '../createGame'
import type { LabAction } from '../types'
import {
  applyLabAction,
  previewLabAction,
} from './labActionKernel'

describe('shared lab action kernel', () => {
  it('normalizes the same allocation action for player and rival labs', () => {
    const state = createGame(711)
    const rival = state.rivals[0]!
    const action: LabAction = {
      kind: 'set_allocation',
      allocation: { training: 6, inference: 3, research: 1 },
    }

    const playerApplied = applyLabAction(state, state.playerLabId, action)
    const rivalApplied = applyLabAction(state, rival.id, action)

    expect(playerApplied.player.allocation).toEqual({
      training: 0.6,
      inference: 0.3,
      research: 0.1,
    })
    expect(rivalApplied.rivals.find((candidate) => candidate.id === rival.id)?.allocation)
      .toEqual(playerApplied.player.allocation)
  })

  it('queues a complete prerequisite path through one shared action', () => {
    const state = createGame(712)
    const action: LabAction = { kind: 'queue_research', nodeId: 'sys_fp8' }
    const preview = previewLabAction(state, state.playerLabId, action)
    expect(preview.legal).toBe(true)
    expect(preview.expectedPfDays).toBeGreaterThan(0)

    const applied = applyLabAction(state, state.playerLabId, action)
    expect(applied.player.researchQueue).toEqual([
      'sys_batching',
      'sys_quant',
      'sys_fp8',
    ])
  })

  it('applies API pricing identically to a lab default and its model endpoint', () => {
    const state = createGame(713)
    const model = buildScaledModel({
      id: 'priced-model',
      name: 'Priced model',
      paramsB: 1,
      family: 'dense',
      day: state.day,
      dataCoverage: 1,
      dataQuality: 70,
      shipped: true,
      release: 'released',
    })
    const withModel = {
      ...state,
      player: { ...state.player, models: [model] },
    }
    const action: LabAction = {
      kind: 'set_api_price',
      modelId: model.id,
      input: 1.5,
      output: 4.5,
    }
    const applied = applyLabAction(withModel, withModel.playerLabId, action)
    const priced = applied.player.models.find((candidate) => candidate.id === model.id)
    expect(applied.player.pricing.apiPriceInPerMTok).toBe(1.5)
    expect(applied.player.pricing.apiPriceOutPerMTok).toBe(4.5)
    expect(priced?.apiPriceInPerMTok).toBe(1.5)
    expect(priced?.apiPriceOutPerMTok).toBe(4.5)
  })

  it('rejects a quantized route until its research is unlocked', () => {
    const state = createGame(714)
    const model = buildScaledModel({
      id: 'route-model',
      name: 'Route model',
      paramsB: 1,
      family: 'dense',
      day: state.day,
      dataCoverage: 1,
      dataQuality: 70,
      shipped: true,
      release: 'released',
    })
    const template = state.rivals[0]!
    const rival = { ...template, models: [model] }
    const withModel = {
      ...state,
      rivals: state.rivals.map((candidate) =>
        candidate.id === rival.id ? rival : candidate,
      ),
    }
    const plan = rival.pricing.plans[0]!
    const action: LabAction = {
      kind: 'configure_plan_route',
      planId: plan.id,
      route: {
        modality: 'text',
        primaryModelId: model.id,
        fallbackModelId: null,
        premiumShare: 1,
        precision: 'int8',
      },
    }
    expect(previewLabAction(withModel, rival.id, action)).toMatchObject({ legal: false })

    const unlocked = {
      ...withModel,
      rivals: withModel.rivals.map((candidate) =>
        candidate.id === rival.id
          ? {
              ...candidate,
              researchUnlocked: [...candidate.researchUnlocked, 'sys_batching', 'sys_quant'],
            }
          : candidate,
      ),
    }
    const applied = applyLabAction(unlocked, rival.id, action)
    expect(
      applied.rivals.find((candidate) => candidate.id === rival.id)?.pricing.plans[0]
        ?.servePrecision,
    ).toBe('int8')
    expect(
      applied.rivals.find((candidate) => candidate.id === rival.id)?.pricing.plans[0]
        ?.servePrecisionByModel?.[model.id],
    ).toBe('int8')
  })

  it('uses one researched API-precision action for player and rival endpoints', () => {
    const state = createGame(715)
    const model = buildScaledModel({
      id: 'quant-api-model',
      name: 'Quant API model',
      paramsB: 1,
      family: 'dense',
      day: state.day,
      dataCoverage: 1,
      dataQuality: 70,
      shipped: true,
      release: 'released',
    })
    const rival = state.rivals[0]!
    const ready = {
      ...state,
      player: {
        ...state.player,
        models: [model],
        researchUnlocked: [...state.player.researchUnlocked, 'sys_batching', 'sys_quant'],
      },
      rivals: state.rivals.map((candidate) =>
        candidate.id === rival.id
          ? {
              ...candidate,
              models: [model],
              researchUnlocked: [...candidate.researchUnlocked, 'sys_batching', 'sys_quant'],
            }
          : candidate,
      ),
    }
    const action: LabAction = {
      kind: 'set_api_precision',
      modelId: model.id,
      precision: 'int8',
    }
    const playerApplied = applyLabAction(ready, ready.playerLabId, action)
    const rivalApplied = applyLabAction(ready, rival.id, action)
    expect(playerApplied.player.pricing.apiServePrecisionByModel?.[model.id]).toBe('int8')
    expect(
      rivalApplied.rivals.find((candidate) => candidate.id === rival.id)?.pricing
        .apiServePrecisionByModel?.[model.id],
    ).toBe('int8')
  })
})

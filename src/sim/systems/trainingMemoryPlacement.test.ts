import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { computeSnapshot } from './compute'
import { vramPressure } from './racks'
import { startTraining } from './training'

function richState(seed: number) {
  const state = createGame(seed)
  return { ...state, player: { ...state.player, cash: 1_000_000_000 } }
}

describe('concurrent training memory placement', () => {
  it('sums every resident job exactly once and exposes it through compute placement', () => {
    const solo = startTraining(richState(901), {
      name: 'Alpha', family: 'dense', paramsB: 1,
    })
    const soloPressure = vramPressure(solo, 'train')
    const concurrent = startTraining(solo, {
      name: 'Beta', family: 'dense', paramsB: 1,
    })
    const concurrentPressure = vramPressure(concurrent, 'train')

    expect(soloPressure.needGb).toBeCloseTo(22)
    expect(concurrentPressure.needGb).toBeCloseTo(soloPressure.needGb * 2)
    expect(concurrentPressure.modelName).toBe('Alpha + 1 more')
    expect(computeSnapshot(concurrent).vramNeedTrain).toBeCloseTo(concurrentPressure.needGb)
    expect(computeSnapshot(concurrent).systemRamNeed)
      .toBeGreaterThan(computeSnapshot(solo).systemRamNeed)
  })

  it('does not keep paused checkpoints resident in accelerator memory', () => {
    let state = startTraining(richState(902), {
      name: 'Alpha', family: 'dense', paramsB: 1,
    })
    state = startTraining(state, {
      name: 'Beta', family: 'dense', paramsB: 1,
    })
    const both = vramPressure(state, 'train').needGb
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJobs: state.player.trainingJobs?.map((job) =>
          job.name === 'Beta' ? { ...job, paused: true } : job,
        ),
      },
    }
    expect(vramPressure(state, 'train').needGb).toBeCloseTo(both / 2)
  })

  it('accounts for FP32 activation workspace without claiming optimizer savings', () => {
    const fp16 = startTraining(richState(903), {
      name: 'Mixed', family: 'dense', paramsB: 1,
    })
    const fp32 = startTraining(richState(904), {
      name: 'Full', family: 'dense', paramsB: 1,
      trainingNumerics: {
        computeFormat: 'fp32', nativeWeightFormat: 'float', recipeVersion: 1,
      },
    })
    expect(vramPressure(fp32, 'train').needGb).toBeGreaterThan(
      vramPressure(fp16, 'train').needGb,
    )
  })
})

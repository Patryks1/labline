import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { computeSnapshot } from './compute'
import { vramPressure } from './racks'
import {
  playerTrainingResourcePlan,
  startTraining,
  tickTraining,
} from './training'

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

  it('treats the Training allocation RAM slice as a hard start limit', () => {
    const base = richState(905)
    const constrained = {
      ...base,
      player: {
        ...base.player,
        allocation: { training: 0.001, inference: 0.749, research: 0.25 },
      },
    }
    const next = startTraining(constrained, {
      name: 'TooWide', family: 'dense', paramsB: 1,
    })

    expect(next.player.trainingJob).toBeNull()
    expect(next.alerts[0]?.message).toContain('Training RAM is a hard limit')
    expect(next.alerts[0]?.message).toContain('Training allocation')
  })

  it('splits training RAM by compute priority and stalls only the run that does not fit', () => {
    let state = richState(906)
    state = {
      ...state,
      player: {
        ...state.player,
        allocation: { training: 1, inference: 0, research: 0 },
      },
    }
    state = startTraining(state, {
      name: 'Priority', family: 'dense', paramsB: 1, computePriority: 90,
    })
    state = startTraining(state, {
      name: 'Background', family: 'dense', paramsB: 1, computePriority: 10,
    })
    state = {
      ...state,
      player: {
        ...state.player,
        allocation: { training: 0.05, inference: 0.95, research: 0 },
      },
    }

    const plan = playerTrainingResourcePlan(state)
    const priority = state.player.trainingJobs!.find((job) => job.name === 'Priority')!
    const background = state.player.trainingJobs!.find((job) => job.name === 'Background')!
    expect(plan.jobs[priority.id]?.ramReady).toBe(true)
    expect(plan.jobs[background.id]?.ramReady).toBe(false)

    const next = tickTraining(state)
    const nextPriority = next.player.trainingJobs!.find((job) => job.id === priority.id)!
    const nextBackground = next.player.trainingJobs!.find((job) => job.id === background.id)!
    expect(nextPriority.progressPfDays).toBeGreaterThan(priority.progressPfDays)
    expect(nextBackground.progressPfDays).toBe(background.progressPfDays)
    expect(nextBackground.stallReason).toContain('Training HBM blocked')
  })

  it('shares limited compute across RAM-ready jobs instead of blocking them', () => {
    const base = {
      ...richState(907),
      player: {
        ...richState(907).player,
        allocation: { training: 1, inference: 0, research: 0 },
      },
    }
    const soloStarted = startTraining(base, {
      name: 'Solo', family: 'dense', paramsB: 1, computePriority: 50,
    })
    const solo = {
      ...soloStarted,
      player: {
        ...soloStarted.player,
        trainingJob: { ...soloStarted.player.trainingJob!, targetPfDays: 1_000 },
        trainingJobs: soloStarted.player.trainingJobs!.map((job) => ({ ...job, targetPfDays: 1_000 })),
      },
    }
    const soloNext = tickTraining(solo)
    const soloProgress = soloNext.player.trainingJob!.progressPfDays

    let shared = startTraining(base, {
      name: 'One', family: 'dense', paramsB: 1, computePriority: 50,
    })
    shared = startTraining(shared, {
      name: 'Two', family: 'dense', paramsB: 1, computePriority: 50,
    })
    shared = {
      ...shared,
      player: {
        ...shared.player,
        trainingJob: { ...shared.player.trainingJob!, targetPfDays: 1_000 },
        trainingJobs: shared.player.trainingJobs!.map((job) => ({ ...job, targetPfDays: 1_000 })),
      },
    }
    const sharedNext = tickTraining(shared)
    for (const job of sharedNext.player.trainingJobs ?? []) {
      expect(job.progressPfDays).toBeGreaterThan(0)
      expect(job.progressPfDays).toBeLessThan(soloProgress)
      expect(job.stallReason).toBeNull()
    }
  })
})

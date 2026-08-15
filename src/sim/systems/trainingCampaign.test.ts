import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { roundTripState } from '../save'
import { createTrainingCampaignEvent } from '../balance/trainingCampaign'
import type { SimState, TrainingJob } from '../types'
import {
  playerTrainingResourcePlan,
  playerTrainingJobs,
  resolveTrainingCampaignEvent,
  startTraining,
  tickTraining,
} from './training'

function richState(seed: number): SimState {
  const state = createGame(seed)
  return {
    ...state,
    player: {
      ...state.player,
      cash: 5_000_000_000,
      allocation: { training: 0.9, inference: 0.05, research: 0.05 },
    },
  }
}

function campaignAtTenPercent(seed: number): SimState {
  let state = startTraining(richState(seed), {
    name: 'Campaign Lab',
    family: 'dense',
    paramsB: 1,
    computePriority: 100,
  })
  const job = state.player.trainingJob!
  const dailyPf = playerTrainingResourcePlan(state).jobs[job.id]!.effectivePf
  const targetPfDays = dailyPf * 20
  const campaignJob: TrainingJob = {
    ...job,
    targetPfDays,
    recommendedPfDays: targetPfDays,
    progressPfDays: targetPfDays * 0.1,
    minCalendarDays: 30,
    daysElapsed: 0,
    campaignMilestonesReached: [],
    pendingCampaignEvent: undefined,
  }
  state = {
    ...state,
    player: {
      ...state.player,
      trainingJob: campaignJob,
      trainingJobs: [campaignJob],
    },
  }
  return state
}

describe('training campaign integration', () => {
  it('halts only the affected run at a crossed checkpoint until a choice is made', () => {
    const state = campaignAtTenPercent(6501)
    const withDecision = tickTraining(state)
    const eventJob = withDecision.player.trainingJob!
    expect(eventJob.pendingCampaignEvent).toBeDefined()
    expect(eventJob.campaignMilestonesReached).toEqual([0.12])
    expect(eventJob.progressPfDays / eventJob.targetPfDays).toBeCloseTo(0.12, 10)

    const progressAtDecision = eventJob.progressPfDays
    const energyAtDecision = eventJob.energyMwDays
    const nextDay = tickTraining({ ...withDecision, day: withDecision.day + 1 })
    expect(nextDay.player.trainingJob!.progressPfDays).toBe(progressAtDecision)
    expect(nextDay.player.trainingJob!.energyMwDays).toBe(energyAtDecision)
    expect(nextDay.player.trainingJob!.stallReason).toContain('Campaign decision')
  })

  it('does not skip campaign checkpoints when one daily allocation can finish the run', () => {
    let state = startTraining(richState(6500), {
      name: 'One-day giant allocation',
      family: 'dense',
      paramsB: 1,
      computePriority: 100,
    })
    const job = state.player.trainingJob!
    const dailyPf = playerTrainingResourcePlan(state).jobs[job.id]!.effectivePf
    const targetPfDays = dailyPf * 0.5
    const oneDayJob: TrainingJob = {
      ...job,
      targetPfDays,
      recommendedPfDays: targetPfDays,
      minCalendarDays: 1,
      daysElapsed: 0,
      progressPfDays: 0,
      campaignMilestonesReached: [],
    }
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: oneDayJob,
        trainingJobs: [oneDayJob],
      },
    }

    const ticked = tickTraining(state)
    expect(ticked.player.trainingJob!.pendingCampaignEvent?.milestone).toBe(0.12)
    expect(ticked.player.trainingJob!.awaitingDecision).not.toBe(true)
  })

  it('charges a selected intervention once and persists its evidence in the campaign log', () => {
    const withDecision = tickTraining(campaignAtTenPercent(6502))
    const event = withDecision.player.trainingJob!.pendingCampaignEvent!
    const paidChoice = event.choices.find((choice) => (choice.effects.cashCost ?? 0) > 0)!
    const cashBefore = withDecision.player.cash

    const resolved = resolveTrainingCampaignEvent(
      withDecision,
      withDecision.player.trainingJob!.id,
      paidChoice.id,
    )
    expect(resolved.player.cash).toBeCloseTo(
      cashBefore - (paidChoice.effects.cashCost ?? 0),
    )
    expect(resolved.player.trainingJob!.pendingCampaignEvent).toBeUndefined()
    expect(resolved.player.trainingJob!.campaignEventHistory?.at(-1)?.selectedChoiceId).toBe(
      paidChoice.id,
    )

    const repeated = resolveTrainingCampaignEvent(
      resolved,
      resolved.player.trainingJob!.id,
      paidChoice.id,
    )
    expect(repeated.player.cash).toBe(resolved.player.cash)
  })

  it('auto-resolves an ignored checkpoint against the same seeded event', () => {
    const withDecision = tickTraining(campaignAtTenPercent(6503))
    const job = withDecision.player.trainingJob!
    const dueJob: TrainingJob = {
      ...job,
      pendingCampaignEvent: {
        ...job.pendingCampaignEvent!,
        decisionDeadlineDay: withDecision.day + 1,
      },
    }
    const dueState: SimState = {
      ...withDecision,
      day: withDecision.day + 1,
      player: {
        ...withDecision.player,
        trainingJob: dueJob,
        trainingJobs: [dueJob],
      },
    }

    const resolved = tickTraining(dueState)
    expect(resolved.player.trainingJob!.pendingCampaignEvent).toBeUndefined()
    expect(resolved.player.trainingJob!.campaignEventHistory?.at(-1)?.autoResolved).toBe(true)
  })

  it('closes an unaffordable ignored decision and resumes allocated PF next tick', () => {
    const withDecision = tickTraining(campaignAtTenPercent(6510))
    const job = withDecision.player.trainingJob!
    const blockedEvent = {
      ...job.pendingCampaignEvent!,
      decisionDeadlineDay: withDecision.day + 1,
      choices: job.pendingCampaignEvent!.choices.map((choice) => ({
        ...choice,
        effects: { ...choice.effects, cashCost: 1_000_000, minResearchers: 999 },
      })),
    }
    const dueJob = { ...job, pendingCampaignEvent: blockedEvent }
    const due = tickTraining({
      ...withDecision,
      day: withDecision.day + 1,
      player: {
        ...withDecision.player,
        cash: -5_000_000,
        staff: { researcher: 0, data_processor: 0, engineer: 0, ops: 0 },
        trainingJob: dueJob,
        trainingJobs: [dueJob],
      },
    })
    expect(due.player.trainingJob!.pendingCampaignEvent).toBeUndefined()
    expect(due.player.trainingJob!.campaignEventHistory?.at(-1)).toMatchObject({
      selectedChoiceId: 'stay-planned',
      autoResolved: true,
    })
    const progress = due.player.trainingJob!.progressPfDays
    const resumed = tickTraining({ ...due, day: due.day + 1 })
    expect(resumed.player.trainingJob!.progressPfDays).toBeGreaterThan(progress)
    expect(resumed.player.cash).toBeLessThan(due.player.cash)
  })

  it('round-trips the unresolved decision and its eventual result without rerolling', () => {
    const withDecision = tickTraining(campaignAtTenPercent(6504))
    const savedDecision = roundTripState(withDecision)
    expect(savedDecision.player.trainingJob!.pendingCampaignEvent).toEqual(
      withDecision.player.trainingJob!.pendingCampaignEvent,
    )

    const choice = savedDecision.player.trainingJob!.pendingCampaignEvent!.choices.at(-1)!
    const resolved = resolveTrainingCampaignEvent(
      savedDecision,
      savedDecision.player.trainingJob!.id,
      choice.id,
    )
    const savedResult = roundTripState(resolved)
    expect(savedResult.player.trainingJob!.pendingCampaignEvent).toBeUndefined()
    expect(savedResult.player.trainingJob!.campaignEventHistory?.at(-1)?.selectedChoiceId).toBe(
      choice.id,
    )
  })

  it('reallocates compute and training memory away from a run awaiting intervention', () => {
    let state = startTraining(richState(6505), {
      name: 'Paused science run',
      family: 'dense',
      paramsB: 1,
      computePriority: 50,
    })
    state = startTraining(state, {
      name: 'Active science run',
      family: 'dense',
      paramsB: 1,
      computePriority: 50,
    })
    const [paused, active] = playerTrainingJobs(state)
    expect(paused).toBeDefined()
    expect(active).toBeDefined()
    const pending: TrainingJob = {
      ...paused!,
      pendingCampaignEvent: createTrainingCampaignEvent(paused!, 0.12, 0, state.day),
    }
    const pendingState: SimState = {
      ...state,
      player: {
        ...state.player,
        trainingJob: pending,
        trainingJobs: [pending, active!],
      },
    }

    const allocation = playerTrainingResourcePlan(pendingState)
    expect(allocation.jobs[pending.id]!.effectivePf).toBe(0)
    expect(allocation.jobs[active!.id]!.effectivePf).toBeGreaterThan(0)
  })
})

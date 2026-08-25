import { describe, expect, it } from 'vitest'
import { defaultPostTrainGyms } from '../balance/modelStudio'
import { createGame } from '../createGame'
import type { DataPruneJob, SimState, SynthGenJob } from '../types'
import { computeSnapshot } from './compute'
import {
  buildComputeBreakdown,
  researchComputeUsage,
} from './computeBreakdown'

function withSynth(state: SimState, share: number): SimState {
  const job: SynthGenJob = {
    id: 'synth-test',
    domain: 'chat',
    modelId: 'teacher',
    modelName: 'Teacher',
    targetMTok: 0,
    progressMTok: 0,
    continuous: true,
    researchShare: share,
    qualityTier: 'lq',
  }
  return {
    ...state,
    player: {
      ...state.player,
      data: { ...state.player.data, synthQueue: [job] },
    },
  }
}

function withPrune(state: SimState, share: number): SimState {
  const job: DataPruneJob = {
    id: 'prune-test',
    domain: 'chat',
    rawRemaining: 10,
    processedRemaining: 10,
    rawTotal: 10,
    processedTotal: 10,
    cashPerMTok: 1,
    pfDaysPerMTok: 0.1,
    researchersRequired: 1,
    engineersRequired: 1,
    researchShare: share,
    qualityBefore: 40,
  }
  return {
    ...state,
    player: {
      ...state.player,
      data: { ...state.player.data, pruneQueue: [job] },
    },
  }
}

function withGymDraw(state: SimState, share: number): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      postTrainGyms: defaultPostTrainGyms().map((gym) =>
        gym.kind === 'code'
          ? {
              ...gym,
              tier: 1,
              assignedResearchers: 2,
              researchShare: share,
            }
          : gym,
      ),
    },
  }
}

describe('researchComputeUsage', () => {
  it('treats an idle lab as unused research PF', () => {
    const state = createGame(8_401)
    const usage = researchComputeUsage(state)

    expect(usage.usedPf).toBe(0)
    expect(usage.slices).toEqual([])
    expect(usage.poolPf).toBeGreaterThan(0)
    expect(usage.powerMw).toBe(0)
  })

  it('counts synthetic generation as research-pool use', () => {
    const idle = createGame(8_402)
    const active = withSynth(idle, 0.25)
    const idleUsage = researchComputeUsage(idle)
    const usage = researchComputeUsage(active)

    expect(usage.usedPf).toBeGreaterThan(idleUsage.usedPf)
    expect(usage.usedPf).toBeCloseTo(usage.poolPf * 0.25, 8)
    expect(usage.slices).toEqual([
      expect.objectContaining({ id: 'synthetic', short: 'synth', share: 0.25 }),
    ])
    expect(buildComputeBreakdown(active).research.utilizationLabel).toBe(
      'Synthetic data',
    )
    expect(buildComputeBreakdown(active).research.summary).toMatch(/Synthetic data/)
    expect(buildComputeBreakdown(idle).research.utilizationLabel).toBe('Idle')
  })

  it('counts corpus audits, gyms, and safety alongside tech/pods', () => {
    let state = withPrune(createGame(8_403), 0.08)
    state = withGymDraw(state, 0.2)
    state = {
      ...state,
      player: {
        ...state.player,
        staff: { researcher: 4, engineer: 2, data_processor: 2, ops: 0 },
        safetyCampaign: {
          id: 'safety-test',
          modelId: 'm1',
          modelName: 'Pilot',
          intensity: 'standard',
          assignedResearchers: 2,
          minimumResearchers: 2,
          targetTrainingPfDays: 10,
          targetResearchPfDays: 8,
          progressTrainingPfDays: 0,
          progressResearchPfDays: 0,
          cashBudget: 1_000_000,
          cashSpent: 0,
          safetyDataMTok: 0,
          safetyDataQuality: 70,
          startDay: 1,
        },
        activeResearch: {
          nodeId: 'dense_basics',
          progressPfDays: 1,
          daysSpent: 1,
        },
      },
    }
    const usage = researchComputeUsage(state)
    const ids = usage.slices.map((slice) => slice.id)

    expect(ids).toContain('tree')
    expect(ids).toContain('prune')
    expect(ids).toContain('gyms')
    expect(ids).toContain('safety')
    expect(usage.usedPf).toBeGreaterThan(0)
    expect(usage.usedPf).toBeLessThanOrEqual(usage.poolPf + 1e-9)
    expect(buildComputeBreakdown(state).research.utilization).toBeGreaterThan(0)
  })

  it('does not treat leftover tech capacity as used while only synth is running', () => {
    const usage = researchComputeUsage(withSynth(createGame(8_404), 0.3))
    expect(usage.slices.map((slice) => slice.id)).toEqual(['synthetic'])
    expect(usage.idlePf).toBeGreaterThan(0)
    expect(usage.techAvailablePf).toBeGreaterThan(usage.usedPf)
  })
})

describe('research duty vs usage', () => {
  it('engages research MW when synthetic work is queued', () => {
    const idle = createGame(8_405)
    const active = withSynth(idle, 0.4)
    expect(computeSnapshot(idle).mwBreakdown.research).toBe(0)
    expect(researchComputeUsage(active).usedPf).toBeGreaterThan(0)
    expect(researchComputeUsage(idle).usedPf).toBe(0)
  })
})

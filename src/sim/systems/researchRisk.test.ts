import { describe, expect, it } from 'vitest'
import { rollTrainingOutcome } from '../balance/trainingV3'
import { enqueueResearch, aggregateEffects } from './research'
import { createGame } from '../createGame'

describe('research paths and high-risk methods', () => {
  it('legacy research also auto-queues a locked prerequisite chain', () => {
    const state = enqueueResearch(createGame(705), 'sys_tensor_rt')
    expect([
      ...(state.player.activeResearch ? [state.player.activeResearch.nodeId] : []),
      ...state.player.researchQueue,
    ]).toEqual([
      'sys_batching',
      'sys_kernels',
      'sys_compile',
      'sys_tensor_rt',
    ])
  })

  it('risky methods provide upside while carrying explicit safety and failure costs', () => {
    const effects = aggregateEffects(['data_self_train', 'align_agent_redteam'])
    expect(effects.capabilityBonus).toBe(13)
    expect(effects.trainEfficiency).toBeCloseTo(0.2)
    expect(effects.trainingBreakthroughBias).toBeCloseTo(0.23)
    expect(effects.trainingStumbleRisk).toBeCloseTo(0.18)
    expect(effects.trainingSafetyPenalty).toBe(13)
    expect(effects.safetyBonus).toBe(-3)
  })

  it('risk research widens both breakthrough and stumble tails deterministically', () => {
    let baselineBreakthroughs = 0
    let baselineStumbles = 0
    let baselineExtremes = 0
    let riskyBreakthroughs = 0
    let riskyStumbles = 0
    let riskyExtremes = 0

    for (let seed = 1; seed <= 1_000; seed += 1) {
      const common = {
        seed,
        quality: 68,
        verifyShare: 0.18,
        engineers: 8,
        researchCount: 18,
        day: 120,
      }
      const baseline = rollTrainingOutcome(common)
      const risky = rollTrainingOutcome({
        ...common,
        breakthroughBias: 0.23,
        stumbleRisk: 0.18,
      })
      baselineBreakthroughs += Number(baseline.kind === 'breakthrough')
      baselineStumbles += Number(baseline.kind === 'stumble')
      baselineExtremes += Number(
        baseline.kind === 'breakthrough' || baseline.kind === 'failure',
      )
      riskyBreakthroughs += Number(risky.kind === 'breakthrough')
      riskyStumbles += Number(risky.kind === 'stumble')
      riskyExtremes += Number(
        risky.kind === 'breakthrough' || risky.kind === 'failure',
      )
    }

    // Failure now shares probability mass with breakthroughs; require a wider
    // stumble tail, and either at least as many breakthroughs or more extremes.
    expect(riskyStumbles).toBeGreaterThan(baselineStumbles)
    expect(
      riskyBreakthroughs >= baselineBreakthroughs ||
        riskyExtremes > baselineExtremes,
    ).toBe(true)
  })
})

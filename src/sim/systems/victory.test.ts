import { describe, expect, it } from 'vitest'
import { ECONOMY } from '../balance/economy'
import { createGame } from '../createGame'
import type { SimState } from '../types'
import { defaultArchitecture, emptyTrainingState, withTrainingState } from '../training/state'
import { tickLoans } from './loans'
import {
  cashDistressStage,
  playerSotaProximity,
  resumeInsolvency,
  tickVictory,
} from './victory'

function withCash(state: SimState, cash: number): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      cash,
      finance: { ...state.player.finance, cash },
    },
  }
}

describe('cash distress ladder', () => {
  it('maps cash to warning stages', () => {
    expect(cashDistressStage(1)).toBe('stable')
    expect(cashDistressStage(0)).toBe('stable')
    expect(cashDistressStage(-1)).toBe('distressed')
    expect(cashDistressStage(-100_000_000)).toBe('distressed')
    expect(cashDistressStage(-100_000_001)).toBe('severe')
    expect(cashDistressStage(-250_000_000)).toBe('severe')
    expect(cashDistressStage(-250_000_001)).toBe('final')
    expect(cashDistressStage(-499_999_999)).toBe('final')
    expect(cashDistressStage(-500_000_000)).toBe('bankrupt')
    expect(cashDistressStage(-900_000_000)).toBe('bankrupt')
  })

  it('keeps playing between $0 and -$500M while surfacing stage alerts', () => {
    const severe = tickVictory(withCash(createGame(720), -150_000_000))
    expect(severe.victory.outcome).toBe('playing')
    expect(
      severe.alerts.some((a) => a.id.startsWith('cash-distress-severe-')),
    ).toBe(true)

    const final = tickVictory(withCash(createGame(721), -300_000_000))
    expect(final.victory.outcome).toBe('playing')
    expect(
      final.alerts.some((a) => a.id.startsWith('cash-distress-final-')),
    ).toBe(true)

    const distressed = tickVictory(withCash(createGame(722), -5_000_000))
    expect(distressed.victory.outcome).toBe('playing')
  })

  it('keeps playing at the -$500M floor so credit and equity stay usable', () => {
    const floor = ECONOMY.victory.bankruptCash
    expect(floor).toBe(-500_000_000)

    const atFloor = tickVictory(withCash(createGame(723), floor))
    expect(atFloor.victory.outcome).toBe('playing')
    expect(
      atFloor.alerts.some((a) => a.id.startsWith('cash-distress-bankrupt-')),
    ).toBe(true)

    const belowFloor = tickVictory(withCash(createGame(724), floor - 1))
    expect(belowFloor.victory.outcome).toBe('playing')

    const justAbove = tickVictory(withCash(createGame(725), floor + 1))
    expect(justAbove.victory.outcome).toBe('playing')
  })

  it('does not end the run when daily financing settlement crosses the floor', () => {
    const base = withCash(createGame(726), -498_000_000)
    const state: SimState = {
      ...base,
      player: {
        ...base.player,
        loans: [
          {
            id: 'loan-floor',
            offerId: 'growth',
            label: 'Growth facility',
            principal: 40_000_000,
            remaining: 60_000_000,
            dailyPayment: 3_000_000,
            daysLeft: 20,
            termDays: 30,
            takenDay: 1,
            interestTotal: 0.1,
          },
        ],
      },
    }
    const settled = tickLoans(state)
    expect(settled.player.cash).toBeLessThanOrEqual(-500_000_000)
    const next = tickVictory(settled)
    expect(next.victory.outcome).toBe('playing')
  })

  it('ends the run only after the recovery window expires', () => {
    const floor = ECONOMY.victory.bankruptCash
    const insolvent = withCash(createGame(727), floor)
    const reviewing: SimState = {
      ...insolvent,
      player: {
        ...insolvent.player,
        capital: {
          ...insolvent.player.capital!,
          restructuring: { active: true, daysLeft: 0, stage: 'bankruptcy' },
        },
      },
    }
    const next = tickVictory(reviewing)
    expect(next.victory.outcome).toBe('lost')
    expect(next.paused).toBe(true)
    expect(next.victory.reason).toContain('bankruptcy')
  })

  it('reopens a recovery window so the board review is not a dead end', () => {
    const base = withCash(createGame(728), ECONOMY.victory.bankruptCash)
    const lost = tickVictory({
      ...base,
      player: {
        ...base.player,
        capital: {
          ...base.player.capital!,
          restructuring: { active: true, daysLeft: 0, stage: 'bankruptcy' },
        },
      },
    })
    expect(lost.victory.outcome).toBe('lost')
    const resumed = resumeInsolvency(lost)
    expect(resumed.victory.outcome).toBe('playing')
    expect(resumed.player.capital?.restructuring).toEqual({
      active: true,
      daysLeft: 30,
      stage: 'asset_sale',
    })
    expect(tickVictory(resumed).victory.outcome).toBe('playing')
  })
})

describe('capacity-backed market dominance', () => {
  function dominantState(seed: number): SimState {
    const base = createGame(seed)
    return {
      ...base,
      day: 200,
      player: {
        ...base.player,
        finance: {
          ...base.player.finance,
          totalShare: 0.65,
          dayRevenue: 1_000_000,
          dayGrossProfit: 250_000,
        },
      },
      lastMarket: {
        ...base.lastMarket,
        sharesByLab: { ...base.lastMarket.sharesByLab, player: 0.65 },
        unservedRatio: 0.005,
        apiServeFrac: 0.998,
        subServeFrac: 0.998,
        demandPf: 70,
        capacityPf: 100,
      },
    }
  }

  it('tracks qualified days but does not award a one-day share spike', () => {
    const next = tickVictory(dominantState(730))
    expect(next.victory.outcome).toBe('playing')
    expect(next.victory.dominanceQualifiedDays).toBe(1)
  })

  it('resets the streak when demand cannot be served with headroom', () => {
    const base = dominantState(731)
    const overloaded: SimState = {
      ...base,
      victory: {
        ...base.victory,
        dominanceQualifiedDays: 179,
        lastDominanceQualifiedDay: 199,
      },
      lastMarket: {
        ...base.lastMarket,
        unservedRatio: 0.2,
        apiServeFrac: 0.75,
        subServeFrac: 0.85,
        demandPf: 120,
        capacityPf: 100,
      },
    }
    expect(tickVictory(overloaded).victory.dominanceQualifiedDays).toBe(0)
  })

  it('requires the full 180-day fulfilled-share streak for classic victory', () => {
    const base = dominantState(732)
    const classic = {
      ...base,
      config: undefined,
      victory: {
        ...base.victory,
        dominanceQualifiedDays: 179,
        lastDominanceQualifiedDay: 199,
      },
    } as unknown as SimState
    const next = tickVictory(classic)
    expect(next.victory.dominanceQualifiedDays).toBe(180)
    expect(next.victory.outcome).toBe('won')
  })
})

describe('V4 public capability and live endpoints', () => {
  it('scores SOTA from the public leaderboard and treats live endpoints as released', () => {
    const base = createGame(8901)
    const quiet: SimState = {
      ...base,
      rivals: base.rivals.map((rival) => ({ ...rival, models: [], training: emptyTrainingState() })),
    }
    const checkpoint = {
      id: 'cp-win',
      labId: quiet.playerLabId,
      lineageId: 'cp-win',
      name: 'Win',
      version: '1.0',
      stage: 'post' as const,
      status: 'released' as const,
      arch: defaultArchitecture(),
      createdDay: 1,
      progressAtSnapshot: 1,
      truth: {
        domains: {
          language: 70, reasoning: 70, code: 70, math: 70, science: 70,
          vision: 0, video: 0, audio: 0, tools: 70,
        },
        factuality: 70, steerability: 70, robustness: 70, safety: 70, reliability: 70,
      },
      trainingSummary: {
        pfDays: 10, effectiveMTok: 80, loss: 2, gap: 0.3, dataMix: {}, syntheticShare: 0,
      },
      postTrain: { stages: {} },
      tiers: [{ budget: 1 as const, served: true }],
      endpointIds: ['ep-win'],
    }
    const endpoint = {
      id: 'ep-win',
      labId: quiet.playerLabId,
      name: 'Win Live',
      members: [{ checkpointId: 'cp-win', role: 'primary' as const }],
      policy: 'single' as const,
      tiers: [{ budget: 1 as const, served: true }],
      precision: 'bf16' as const,
      status: 'live' as const,
      releaseDay: 4,
      pricing: { inPerMTok: 1, outPerMTok: 2 },
      openWeights: false,
      modelId: 'ep-win',
    }
    const state = withTrainingState(quiet, quiet.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [checkpoint],
      endpoints: [endpoint],
    })
    const prox = playerSotaProximity(state)
    expect(prox.bestCap).toBeGreaterThan(0)
    expect(prox.frontier).toBeGreaterThanOrEqual(prox.bestCap)
    expect(tickVictory(state).victory.outcome).toBe('playing')
  })

  it('still scores SOTA from live shipped models when the public board is empty', () => {
    const base = createGame(8902)
    const state: SimState = {
      ...base,
      player: {
        ...base.player,
        models: [
          {
            id: 'flagship',
            name: 'Flagship',
            family: 'dense',
            paramsB: 10,
            capability: 95,
            release: 'released',
            shipped: true,
          } as SimState['player']['models'][number],
        ],
        training: emptyTrainingState(),
      },
      rivals: base.rivals.map((rival) => ({
        ...rival,
        models: [],
        training: emptyTrainingState(),
      })),
    }
    const prox = playerSotaProximity(state)
    expect(prox.bestCap).toBe(95)
    expect(prox.sota).toBe(1)
  })
})

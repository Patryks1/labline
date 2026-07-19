import { describe, expect, it } from 'vitest'
import { calendarForDay, createInitialProgression, defaultCampaignRules } from '../campaign'
import { createGame } from '../createGame'
import type { SimState } from '../types'
import {
  continueEndless,
  evaluateMilestones,
  tickProgression,
  type QuarterlyLabSnapshot,
} from './progression'

const rules = defaultCampaignRules()

function campaignState(day: number): SimState {
  const state = createGame({
    seed: 7,
    difficulty: 'easy',
    advanced: { mapWidth: 20, mapHeight: 20, cityCount: 2, rivalCount: 1 },
  })
  return {
    ...state,
    day,
    paused: false,
    config: { ...state.config, campaignRules: rules },
    calendar: calendarForDay(day, rules),
    progression: createInitialProgression(),
  }
}

function row(
  labId: string,
  patch: Partial<QuarterlyLabSnapshot> = {},
): QuarterlyLabSnapshot {
  return {
    labId,
    capability: 60,
    code: 60,
    science: 60,
    otherDomain: 60,
    reliability: 70,
    costPerUsefulTask: 5,
    servedDemandShare: 0.1,
    grossMargin: 0.2,
    solvent: true,
    hasReleasedModel: true,
    firstReleaseDay: 30,
    ...patch,
  }
}

function onReviewDay(state: SimState, day: number): SimState {
  return { ...state, day, calendar: calendarForDay(day, rules) }
}

describe('quarterly campaign progression', () => {
  it('awards Frontier Leader after four consecutive qualifying quarters', () => {
    const snapshots = [
      row('player', {
        capability: 90,
        code: 92,
        science: 86,
        otherDomain: 94,
        reliability: 90,
      }),
      row('rival', { capability: 80, code: 80, science: 84, otherDomain: 82 }),
    ]
    let state = campaignState(90)
    for (const [index, day] of [90, 181, 273, 365].entries()) {
      state = evaluateMilestones(onReviewDay(state, day), snapshots)
      const milestone = state.progression.milestones.find(
        (candidate) => candidate.id === 'frontier_leader',
      )!
      expect(milestone.qualifyingQuarters).toBe(index + 1)
      expect(milestone.achievedDay).toBe(index === 3 ? 365 : null)
    }
    expect(
      state.progression.milestones.find((candidate) => candidate.id === 'frontier_leader'),
    ).toMatchObject({ firstLabId: 'player', achievedDay: 365 })
    expect(state.victory.outcome).toBe('playing')
    expect(state.paused).toBe(false)
  })

  it('resets a title streak when leadership changes or no lab qualifies', () => {
    const playerLead = [
      row('player', { capability: 90, code: 95, otherDomain: 94 }),
      row('rival', { capability: 80, code: 80, science: 80, otherDomain: 80 }),
    ]
    const rivalLead = [
      row('player', { capability: 82, code: 82, science: 82, otherDomain: 82 }),
      row('rival', { capability: 94, science: 96, otherDomain: 95 }),
    ]
    const noQualifier = [
      row('player', { capability: 95, code: 70, science: 70, otherDomain: 70 }),
      row('rival', { capability: 90, code: 98, science: 98, otherDomain: 99 }),
    ]

    let state = evaluateMilestones(campaignState(90), playerLead)
    state = evaluateMilestones(onReviewDay(state, 181), rivalLead)
    expect(
      state.progression.milestones.find((candidate) => candidate.id === 'frontier_leader'),
    ).toMatchObject({ firstLabId: 'rival', qualifyingQuarters: 1, achievedDay: null })

    state = evaluateMilestones(onReviewDay(state, 273), noQualifier)
    expect(
      state.progression.milestones.find((candidate) => candidate.id === 'frontier_leader'),
    ).toMatchObject({ firstLabId: null, qualifyingQuarters: 0, achievedDay: null })
  })

  it('does not advance title streaks outside a quarter close', () => {
    const snapshots = [row('player', { capability: 90, code: 92, otherDomain: 94 })]
    const state = evaluateMilestones(campaignState(91), snapshots)
    expect(
      state.progression.milestones.find((candidate) => candidate.id === 'frontier_leader')
        ?.qualifyingQuarters,
    ).toBe(0)
  })
})

describe('decade report and endless continuation', () => {
  it('generates the report once on day 4018 and continues nonterminal play', () => {
    let state = tickProgression(campaignState(4018), [row('player')])
    const report = state.progression.decadeReport
    expect(report).not.toBeNull()
    expect(report?.generatedDay).toBe(4018)
    expect(report?.researchImpact).toBeGreaterThanOrEqual(0)
    expect(state.paused).toBe(true)
    expect(state.victory.outcome).toBe('playing')

    state = tickProgression({
      ...state,
      player: { ...state.player, brandTrust: 1 },
    }, [row('player')])
    expect(state.progression.decadeReport).toEqual(report)

    state = continueEndless(state)
    expect(state.progression).toMatchObject({
      runPhase: 'endless',
      era: 'endless',
      reportAcknowledged: true,
    })
    expect(state.paused).toBe(false)
    expect(state.victory.outcome).toBe('playing')

    state = tickProgression(onReviewDay(state, 4019), [row('player')])
    expect(state.progression.decadeReport).toEqual(report)
  })
})

import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { AUTHORED_EVENT_COUNT, spawnWorldEvent, tickEvents } from './events'
import { syncLabIndex } from './labEngine'

describe('authored industry event chains', () => {
  it('ships ten three-stage chains', () => {
    expect(AUTHORED_EVENT_COUNT).toBe(30)
  })

  it('advances an expired stage into its deterministic follow-up', () => {
    let state = createGame({ seed: 501 })
    state = spawnWorldEvent(state, 'heatwave')
    state = {
      ...state,
      activeEvents: state.activeEvents.map((event) => ({ ...event, duration: 1 })),
    }
    const next = tickEvents(state)
    expect(next.activeEvents.some((event) => event.id === 'heatwave')).toBe(false)
    expect(next.activeEvents.some((event) => event.id === 'transformer_backlog')).toBe(true)
  })

  it('applies instant shocks symmetrically and honors each lab resistance', () => {
    const base = createGame({ seed: 502 })
    const rivalId = base.rivals[0]!.id
    const state = {
      ...base,
      player: { ...base.player, brandTrust: 70, researchUnlocked: ['dense_basics', 'org_talent'] },
      rivals: base.rivals.map((rival) => ({
        ...rival,
        brandTrust: 70,
        researchUnlocked: rival.id === rivalId ? ['dense_basics'] : rival.researchUnlocked,
      })),
    }
    const next = spawnWorldEvent(syncLabIndex(state), 'talent_war')
    expect(next.player.brandTrust).toBeCloseTo(68.4)
    expect(next.rivals.find((rival) => rival.id === rivalId)?.brandTrust).toBeCloseTo(66)
  })

  it('replays identical chains identically', () => {
    const state = spawnWorldEvent(createGame({ seed: 503 }), 'discovery_challenge')
    expect(tickEvents(state)).toEqual(tickEvents(state))
  })

  it('repairs legacy runaway usage and decays toward the immutable baseline', () => {
    const state = createGame({ seed: 504 })
    const inflated = {
      ...state,
      day: 2,
      activeEvents: [],
      segments: state.segments.map((segment) => ({
        ...segment,
        usageIntensity: segment.usageIntensity * 100_000,
      })),
    }
    const next = tickEvents(inflated)
    for (let index = 0; index < next.segments.length; index++) {
      const baseline = state.segments[index]!.usageIntensity
      expect(next.segments[index]!.usageIntensity).toBeLessThanOrEqual(baseline * 3)
      expect(next.segments[index]!.usageIntensity).toBeGreaterThanOrEqual(baseline)
    }
  })
})

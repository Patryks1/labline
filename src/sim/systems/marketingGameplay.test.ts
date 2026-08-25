import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { applyRivalDailyMarketing, computeRivalMarketingOutcome, tickMarketing } from './marketing'
import { rivalMarketingChannels } from './rivals'

describe('marketing gameplay boundary', () => {
  it('settles the player campaign before market demand and only once per day', () => {
    const state = createGame(810)
    const configured = {
      ...state,
      player: {
        ...state.player,
        marketingSpendPerDay: 400_000,
        marketingChannels: {
          web: 180_000,
          billboards: 140_000,
          restaurants: 40_000,
          enterprise: 40_000,
        },
      },
    }
    const settled = tickMarketing(configured)
    expect(settled.player.marketingOutcome?.day).toBe(configured.day)
    expect(settled.player.brandTrust).toBeGreaterThan(configured.player.brandTrust)
    const again = tickMarketing(settled)
    expect(again.player.brandTrust).toBeCloseTo(settled.player.brandTrust, 10)
  })

  it('gives rivals archetype-led channels and a persisted deterministic outcome', () => {
    const state = createGame(811)
    const rival = state.rivals[0]!
    const channels = rivalMarketingChannels(rival, 500_000, 300_000)
    expect(channels.web + channels.billboards + channels.restaurants + channels.enterprise).toBeCloseTo(500_000, 6)
    const configured = {
      ...rival,
      marketingSpendPerDay: 500_000,
      marketingChannels: channels,
    }
    const projected = computeRivalMarketingOutcome(state, configured)
    const settled = applyRivalDailyMarketing(state, configured)
    expect(settled.marketingOutcome).toEqual(projected)
    expect(settled.brandTrust).toBeCloseTo(rival.brandTrust + projected.brandGain, 10)
  })
})


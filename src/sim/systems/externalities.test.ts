import { describe, expect, it } from 'vitest'
import { defaultCampaignRules } from '../campaign'
import { createGame } from '../createGame'
import { tickExternalities } from './externalities'

describe('optional advanced externalities', () => {
  it('is an exact no-op in standard mode', () => {
    const state = createGame({ seed: 410 })
    expect(tickExternalities(state)).toBe(state)
    expect(state.externalities?.incidents).toEqual([])
  })

  it('meters and charges every lab with the same advanced rules', () => {
    const base = createGame({ seed: 411 })
    const state = {
      ...base,
      config: {
        ...base.config,
        campaignRules: defaultCampaignRules({ externalityMode: 'advanced' }),
      },
    }
    const cash = Object.fromEntries([
      ['player', state.player.cash],
      ...state.rivals.map((rival) => [rival.id, rival.cash] as const),
    ])
    const next = tickExternalities(state)

    expect(Object.keys(next.externalities?.accounts ?? {})).toHaveLength(6)
    expect(next.player.cash).toBeLessThan(cash.player!)
    for (const rival of next.rivals) {
      expect(rival.cash).toBeLessThan(cash[rival.id]!)
      expect(next.externalities?.accounts[rival.id]?.energyMWh).toBeGreaterThan(0)
    }
  })

  it('is deterministic for identical advanced audit states', () => {
    const base = createGame({ seed: 412 })
    const state = {
      ...base,
      config: {
        ...base.config,
        campaignRules: defaultCampaignRules({ externalityMode: 'advanced' }),
      },
      calendar: { ...base.calendar, isAccountingDay: true },
    }
    expect(tickExternalities(state)).toEqual(tickExternalities(state))
  })
})

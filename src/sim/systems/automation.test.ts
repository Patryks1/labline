import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { setAutomationPolicies, tickAutomation } from './automation'

describe('automation policies', () => {
  it('does nothing when every policy is disabled', () => {
    const state = createGame({ seed: 601 })
    expect(tickAutomation(state)).toBe(state)
  })

  it('leases a single budget-capped emergency overflow contract', () => {
    const base = createGame({ seed: 602 })
    const state = setAutomationPolicies(
      {
        ...base,
        lastMarket: { ...base.lastMarket, demandPf: 40, capacityPf: 8 },
      },
      {
        overflowCloud: {
          ...base.automation.overflowCloud,
          enabled: true,
          maxPf: 64,
          maxDailySpend: 1_000_000,
        },
      },
    )
    const once = tickAutomation(state)
    const twice = tickAutomation(once)
    expect(
      once.computeContracts.filter((contract) => contract.kind === 'emergency'),
    ).toHaveLength(1)
    expect(
      twice.computeContracts.filter((contract) => contract.kind === 'emergency'),
    ).toHaveLength(1)
  })

  it('raises inference allocation under pressure and keeps shares conserved', () => {
    const base = createGame({ seed: 603 })
    const state = setAutomationPolicies(
      {
        ...base,
        lastMarket: { ...base.lastMarket, demandPf: 20, capacityPf: 4 },
      },
      { allocation: { ...base.automation.allocation, enabled: true } },
    )
    const next = tickAutomation(state)
    const allocation = next.player.allocation
    expect(allocation.inference).toBeGreaterThan(base.player.allocation.inference)
    expect(allocation.training + allocation.inference + allocation.research).toBeCloseTo(1)
  })

  it('persists automatic data processing into the canonical corpus policy', () => {
    const base = createGame({ seed: 604 })
    const state = setAutomationPolicies(base, {
      dataProcessing: { enabled: true },
    })
    expect(tickAutomation(state).player.data.autoProcess).toBe(true)
  })
})

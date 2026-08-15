import { describe, expect, it } from 'vitest'
import { NAV_GROUPS } from './navConfig'
import {
  COMPUTE_ALLOCATION_MIN,
  MOBILE_MORE_SECTIONS,
  MOBILE_MORE_UTILITIES,
  MOBILE_PRIMARY_TABS,
  rebalanceComputeAllocation,
} from './mobileShellContracts'

describe('mobile command shell contracts', () => {
  it('has one unique five-command primary navigation contract', () => {
    const commands = [...MOBILE_PRIMARY_TABS.map((tab) => tab.label), 'More']

    expect(commands).toEqual(['Build', 'Models', 'Plans', 'Data', 'More'])
    expect(new Set(commands).size).toBe(commands.length)
  })

  it('keeps Objectives and every secondary workspace in More', () => {
    expect(MOBILE_MORE_UTILITIES.some((utility) => utility.id === 'objectives')).toBe(true)

    const primaryIds = new Set(MOBILE_PRIMARY_TABS.map((tab) => tab.id))
    const expectedSecondaryIds = NAV_GROUPS
      .flatMap((group) => group.items.map((item) => item.id))
      .filter((id) => !primaryIds.has(id))
      .toSorted()
    const actualSecondaryIds = MOBILE_MORE_SECTIONS
      .flatMap((section) => section.tabs.map((tab) => tab.id))
      .toSorted()

    expect(actualSecondaryIds).toEqual(expectedSecondaryIds)
  })

  it('allows an allocation queue to reach exactly zero', () => {
    expect(COMPUTE_ALLOCATION_MIN).toBe(0)
    expect(
      rebalanceComputeAllocation(
        { training: 0.4, inference: 0.4, research: 0.2 },
        'training',
        0,
      ),
    ).toEqual({ training: 0, inference: 2 / 3, research: 1 / 3 })
    expect(
      rebalanceComputeAllocation(
        { training: 0, inference: 0, research: 0 },
        'research',
        0,
      ),
    ).toEqual({ training: 0, inference: 0, research: 0 })
  })
})

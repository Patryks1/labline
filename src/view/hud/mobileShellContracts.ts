import type { Allocation, PanelId } from '../../sim/types'
import { SHELL_NAV_GROUPS, type ShellNavGroupId } from './navConfig'

export interface MobileNavTab {
  id: PanelId
  label: string
  hint: string
  group: ShellNavGroupId
}

/** The commercial core loop stays one tap away on compact screens. */
export const MOBILE_PRIMARY_TABS: readonly MobileNavTab[] = [
  { id: 'build', label: 'Build', hint: 'Place and expand', group: 'build' },
  { id: 'models', label: 'Models', hint: 'Train and release', group: 'products' },
  { id: 'plans', label: 'Plans', hint: 'Price and sell', group: 'products' },
  { id: 'data', label: 'Data', hint: 'Prepare corpora', group: 'products' },
] as const

const primaryIds = new Set<PanelId>(MOBILE_PRIMARY_TABS.map((tab) => tab.id))

/** Everything outside the primary loop remains available in the More sheet. */
export const MOBILE_MORE_SECTIONS = SHELL_NAV_GROUPS.map((group) => ({
  group: group.id,
  label: group.label,
  tabs: group.items
    .filter((item) => !primaryIds.has(item.id))
    .map((item) => ({
      id: item.id,
      label: item.label,
      hint: item.hint,
      group: group.id,
    } satisfies MobileNavTab)),
})).filter((section) => section.tabs.length > 0)

export const MOBILE_MORE_UTILITIES = [
  { id: 'intel', label: 'Intel', hint: 'P&L, rivals and world feed' },
  { id: 'objectives', label: 'Objectives', hint: 'Risks and next decisions' },
  { id: 'destroy', label: 'Destroy', hint: 'Sell or cancel map assets' },
] as const

export const COMPUTE_ALLOCATION_MIN = 0

/**
 * Preserve a proportional three-way split while allowing any individual queue
 * to be paused at exactly zero. A fully idle allocation remains all-zero.
 */
export function rebalanceComputeAllocation(
  allocation: Allocation,
  key: keyof Allocation,
  value: number,
): Allocation {
  const next = {
    ...allocation,
    [key]: Math.max(COMPUTE_ALLOCATION_MIN, value),
  }
  const sum = next.training + next.inference + next.research
  if (sum <= 0) return { training: 0, inference: 0, research: 0 }
  return {
    training: next.training / sum,
    inference: next.inference / sum,
    research: next.research / sum,
  }
}

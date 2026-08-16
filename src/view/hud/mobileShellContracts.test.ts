import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SHELL_NAV_GROUPS } from './navConfig'
import {
  COMPUTE_ALLOCATION_MIN,
  MOBILE_MORE_SECTIONS,
  MOBILE_MORE_UTILITIES,
  MOBILE_PRIMARY_TABS,
  rebalanceComputeAllocation,
} from './mobileShellContracts'

describe('mobile command shell contracts', () => {
  it('raises the More sheet stacking context above the training strip', () => {
    const css = readFileSync(
      fileURLToPath(new URL('../../index.css', import.meta.url)),
      'utf8',
    )
    const selector = '.workspace-shell:has(.mobile-more-layer)'
    const start = css.indexOf(selector)
    const end = start < 0 ? -1 : css.indexOf('}', start)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(css.slice(start, end + 1)).toContain('z-index: var(--hud-z-map)')
  })

  it('reserves the fixed training and operations stack below desktop workspaces', () => {
    const css = readFileSync(
      fileURLToPath(new URL('../../index.css', import.meta.url)),
      'utf8',
    )
    const selector = '.workspace-drawer--reserve-operations'
    const start = css.indexOf(selector)
    const end = start < 0 ? -1 : css.indexOf('}', start)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(css.slice(start, end + 1)).toContain(
      'margin-bottom: calc(var(--hud-ops) + var(--hud-training-height, 0px) + var(--hud-space-2))',
    )
  })

  it('keeps the mobile workspace tail above the fixed training strip', () => {
    const css = readFileSync(
      fileURLToPath(new URL('../../index.css', import.meta.url)),
      'utf8',
    )

    const drawerSelector = '  .workspace-drawer {\n    position: fixed;'
    const drawerStart = css.indexOf(drawerSelector)
    const drawerEnd = drawerStart < 0 ? -1 : css.indexOf('  }', drawerStart)

    expect(drawerStart).toBeGreaterThanOrEqual(0)
    expect(drawerEnd).toBeGreaterThan(drawerStart)
    expect(css.slice(drawerStart, drawerEnd)).toContain(
      'calc(var(--mobile-nav-height) + var(--hud-training-height) + var(--hud-space-2))',
    )
    expect(css).toContain(
      ".game-shell[data-workspace-open='true'] .workspace-drawer.workspace-drawer--reserve-operations > .workspace-drawer__body",
    )
    expect(css).toContain('padding-bottom: 5rem')
  })

  it('keeps every Build category label readable in a narrow drawer', () => {
    const css = readFileSync(
      fileURLToPath(new URL('../../index.css', import.meta.url)),
      'utf8',
    )
    const selector = '.build-category-tabs .seg-tabs__tab > span'
    const start = css.indexOf(selector)
    const end = start < 0 ? -1 : css.indexOf('}', start)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(css.slice(start, end + 1)).toContain('overflow: visible')
    expect(css.slice(start, end + 1)).toContain('white-space: nowrap')
  })

  it('has one unique five-command primary navigation contract', () => {
    const commands = [...MOBILE_PRIMARY_TABS.map((tab) => tab.label), 'More']

    expect(commands).toEqual(['Build', 'Models', 'Plans', 'Data', 'More'])
    expect(new Set(commands).size).toBe(commands.length)
  })

  it('keeps Objectives and every secondary workspace in More', () => {
    expect(MOBILE_MORE_UTILITIES.some((utility) => utility.id === 'objectives')).toBe(true)

    const primaryIds = new Set(MOBILE_PRIMARY_TABS.map((tab) => tab.id))
    const expectedSecondaryIds = SHELL_NAV_GROUPS
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

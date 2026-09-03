import { describe, expect, it } from 'vitest'
import {
  FUNCTION_PANEL_SHORTCUTS,
  SHELL_NAV_GROUPS,
  panelForFunctionKey,
  shellGroupForPanel,
  shellPanelForPanel,
} from './navConfig'

describe('panel function-key shortcuts', () => {
  it('maps every F1–F12 key to the visible panel order', () => {
    expect(FUNCTION_PANEL_SHORTCUTS.map((shortcut) => shortcut.key)).toEqual(
      Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
    )
    expect(FUNCTION_PANEL_SHORTCUTS.map((shortcut) => shortcut.panel)).toEqual([
      'stats', 'rivals', 'models', 'data', 'research', 'benchmarks',
      'map', 'computeMarket', 'racks', 'power', 'plans', 'market',
    ])
  })

  it('does not treat Q or E as panel shortcuts', () => {
    expect(panelForFunctionKey('q')).toBeNull()
    expect(panelForFunctionKey('e')).toBeNull()
    expect(panelForFunctionKey('F1')).toBe('stats')
    expect(panelForFunctionKey('F12')).toBe('market')
  })

  it('uses four one-level visual shell groups without changing shortcut groups', () => {
    expect(SHELL_NAV_GROUPS.map((group) => group.id)).toEqual([
      'operate',
      'build',
      'products',
      'company',
    ])
    const ids = SHELL_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(shellGroupForPanel('models').label).toBe('Products')
    expect(shellGroupForPanel('rivals').label).toBe('Operate')
    expect(
      SHELL_NAV_GROUPS[0]!.items.find((item) => item.id === 'rivals')?.label,
    ).toBe('Companies')
    expect(
      SHELL_NAV_GROUPS.find((group) => group.id === 'products')?.items.find((item) => item.id === 'models')
        ?.hint,
    ).toBe('Design, train and release models; manage endpoints and gyms')
    expect(
      SHELL_NAV_GROUPS.find((group) => group.id === 'products')?.items.find(
        (item) => item.id === 'benchmarks',
      )?.hint,
    ).toBe('Seasons, tiers, audits and public boards')
  })

  it('maps the legacy chips route to the visible Build > Hardware destination', () => {
    expect(shellPanelForPanel('chips')).toBe('racks')
    const build = shellGroupForPanel('chips')
    expect(build.id).toBe('build')
    expect(build.items.find((item) => item.id === 'racks')?.label).toBe('Hardware')
  })
})

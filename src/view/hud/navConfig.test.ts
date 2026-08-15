import { describe, expect, it } from 'vitest'
import { FUNCTION_PANEL_SHORTCUTS, panelForFunctionKey } from './navConfig'

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
})

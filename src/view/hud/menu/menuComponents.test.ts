import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CAMPAIGN_RULES } from '../../../sim/campaign'
import { LablineMenuShell } from './LablineMenuShell'
import { parseCheatMoneyAmount } from './cheatMoney'
import { SettingsPanel } from './SettingsPanel'
import { HOTKEY_ROWS } from '../HotkeyHelp'

describe('LablineMenuShell', () => {
  it('renders the centered title identity and an external utility navigation', () => {
    const markup = renderToStaticMarkup(createElement(LablineMenuShell, {
      variant: 'title',
      titleId: 'title-test',
      utilityNav: createElement('button', null, 'News'),
    }, createElement('h2', null, 'Command')))
    expect(markup).toContain('id="title-test"')
    expect(markup).toContain('>LABLINE</h1>')
    expect(markup).toContain('labline-emblem-v2.png')
    expect(markup).toContain('aria-label="Menu utilities"')
    expect(markup.indexOf('labline-menu-utility')).toBeLessThan(markup.indexOf('labline-menu-console'))
  })

  it('exposes pause mode as a labelled modal dialog', () => {
    const markup = renderToStaticMarkup(createElement(LablineMenuShell, {
      variant: 'pause',
      titleId: 'pause-test',
      onRequestClose: () => undefined,
    }, createElement('button', null, 'Resume')))
    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('aria-labelledby="pause-test"')
    expect(markup).toContain('>Resume</button>')
    expect(markup).not.toContain('aria-label="Close pause menu"')
  })
})

describe('SettingsPanel', () => {
  it('shares Interface, Video, and Audio categories outside a campaign', () => {
    const markup = renderToStaticMarkup(createElement(SettingsPanel))
    expect(markup).toContain('>Interface</button>')
    expect(markup).toContain('>Video</button>')
    expect(markup).toContain('>Audio</button>')
    expect(markup).toContain('settings-section-nav')
    expect(markup).toContain('aria-current="page"')
    expect(markup).toContain('role="region"')
    expect(markup).toContain('aria-labelledby="settings-tab-interface"')
    expect(markup).not.toContain('aria-controls=')
    expect(markup).not.toContain('role="tablist"')
    expect(markup).not.toContain('>Gameplay</button>')
    expect(markup).not.toContain('>Cheats</button>')
  })

  it('adds Gameplay only when campaign actions are available', () => {
    const markup = renderToStaticMarkup(createElement(SettingsPanel, {
      gameplay: {
        autoPause: DEFAULT_CAMPAIGN_RULES.autoPause,
        setAutoPause: () => undefined,
        onboardingDismissed: false,
        setOnboardingDismissed: () => undefined,
      },
    }))
    expect(markup).toContain('>Gameplay</button>')
    expect(markup).not.toContain('>Cheats</button>')
  })

  it('exposes Cheats only when active-campaign cheat actions are available', () => {
    const markup = renderToStaticMarkup(createElement(SettingsPanel, {
      cheats: { cash: 1_000_000, adjustMoney: () => true, runInstantAction: () => 0 },
    }))
    expect(markup).toContain('>Cheats</button>')
  })

  it('accepts only positive, finite cheat money amounts', () => {
    expect(parseCheatMoneyAmount('2500000.50')).toBe(2_500_000.5)
    expect(parseCheatMoneyAmount('')).toBeNull()
    expect(parseCheatMoneyAmount('0')).toBeNull()
    expect(parseCheatMoneyAmount('-10')).toBeNull()
    expect(parseCheatMoneyAmount('Infinity')).toBeNull()
    expect(parseCheatMoneyAmount('not money')).toBeNull()
  })
})

describe('menu action contracts', () => {
  it('keeps the save, transport, navigation, and help shortcuts visible', () => {
    const actions = HOTKEY_ROWS.map((row) => row.action)
    expect(actions).toEqual(expect.arrayContaining([
      'Pause / resume',
      'Quick save (autosave)',
      'Same workspaces',
      'Sub-tabs in current workspace',
      'Toggle this help',
    ]))
    expect(HOTKEY_ROWS).toHaveLength(12)
  })
})

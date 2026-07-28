import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CAMPAIGN_RULES } from '../../../sim/campaign'
import { LablineMenuShell } from './LablineMenuShell'
import { SettingsPanel } from './SettingsPanel'

describe('LablineMenuShell', () => {
  it('renders the centered title identity and an external utility navigation', () => {
    const markup = renderToStaticMarkup(createElement(LablineMenuShell, {
      variant: 'title',
      titleId: 'title-test',
      utilityNav: createElement('button', null, 'News'),
    }, createElement('h2', null, 'Command')))
    expect(markup).toContain('id="title-test"')
    expect(markup).toContain('>LABLINE</h1>')
    expect(markup).toContain('src="/assets/labline-emblem-v2.png"')
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
    expect(markup).toContain('aria-label="Close pause menu"')
  })
})

describe('SettingsPanel', () => {
  it('shares Interface, Video, and Audio categories outside a campaign', () => {
    const markup = renderToStaticMarkup(createElement(SettingsPanel))
    expect(markup).toContain('>Interface</button>')
    expect(markup).toContain('>Video</button>')
    expect(markup).toContain('>Audio</button>')
    expect(markup).not.toContain('>Gameplay</button>')
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
  })
})

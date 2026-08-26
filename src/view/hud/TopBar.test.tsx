import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TopBar } from './TopBar'

describe('TopBar shell semantics', () => {
  it('exposes a compact brand and pressed transport state', () => {
    const markup = renderToStaticMarkup(createElement(TopBar))

    expect(markup).toContain('aria-label="Labline"')
    expect(markup).toContain('>Labline</span>')
    expect(markup).not.toContain('days since start')
    expect(markup).toContain('aria-label="Game speed"')
    expect(markup).toContain('aria-label="Resume simulation"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('aria-label="1 times speed"')
    expect(markup).toContain('aria-label="Open hotkey help"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('aria-controls="kpi-history-popover"')
    expect(markup).not.toContain('50.00/100')
    expect(markup).toContain('/100')
    expect(markup.match(/data-mobile-priority="primary"/g)?.length).toBeGreaterThanOrEqual(3)
    expect(markup).toContain('data-mobile-priority="secondary"')
    expect(markup).toContain('data-mobile-priority="tertiary"')
  })

})

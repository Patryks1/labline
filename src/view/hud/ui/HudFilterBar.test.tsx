import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { HudFilterBar } from './HudFilterBar'

describe('HudFilterBar', () => {
  it('keeps filter groups semantic and exposes active state/counts', () => {
    const markup = renderToStaticMarkup(
      createElement(HudFilterBar, {
        ariaLabel: 'Benchmark filters',
        activeCount: 2,
        onClear: vi.fn(),
        groups: [
          {
            id: 'modality',
            label: 'Modality',
            options: [
              { id: 'language', label: 'Language', active: true, onSelect: vi.fn(), count: 4 },
              { id: 'image', label: 'Image', active: false, onSelect: vi.fn(), count: 1 },
            ],
          },
        ],
      }),
    )

    expect(markup).toContain('aria-label="Benchmark filters"')
    expect(markup).toContain('2 active')
    expect(markup).toContain('role="group" aria-label="Modality filters"')
    expect(markup).toContain('data-filter-option="language"')
    expect(markup).toContain('data-filter-active="true"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('min-h-11')
    expect(markup).toContain('aria-controls="hud-filter-content-')
    expect(markup).toContain('Clear')
  })

  it('does not render a misleading clear action when no non-default filters are active', () => {
    const markup = renderToStaticMarkup(
      createElement(HudFilterBar, {
        activeCount: 0,
        onClear: vi.fn(),
        groups: [
          {
            id: 'market',
            label: 'Market',
            options: [{ id: 'language', label: 'Language', active: true, onSelect: vi.fn() }],
          },
        ],
      }),
    )

    expect(markup).toContain('>All</span>')
    expect(markup).not.toContain('>Clear</span>')
  })
})

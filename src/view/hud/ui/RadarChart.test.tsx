import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RadarChart } from './RadarChart'

describe('RadarChart interaction contract', () => {
  it('keeps the legacy comparison prop and renders multiple comparison series', () => {
    const markup = renderToStaticMarkup(
      createElement(RadarChart, {
        suiteId: 'language',
        scores: { mmlu: 80, coding: 75 },
        comparison: { mmlu: 70 },
        comparisons: [
          { id: 'frontier', label: 'Frontier', scores: { mmlu: 90 }, color: 'var(--color-mint)' },
          { id: 'peer', label: 'Peer', scores: { mmlu: 82 }, color: 'var(--color-research)' },
        ],
      }),
    )

    expect(markup).toContain('Frontier')
    expect(markup).toContain('Peer')
    expect(markup).toContain('role="button"')
    expect(markup).not.toContain("<button")
    expect((markup.match(/role="button"/g) ?? []).length).toBe(10)
    expect(markup).toContain('aria-live="polite"')
  })
})

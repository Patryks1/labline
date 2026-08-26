import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LineChart } from './LineChart'

describe('LineChart interaction contract', () => {
  it('renders point controls and an accessible selected-point readout', () => {
    const markup = renderToStaticMarkup(
      createElement(LineChart, {
        series: [
          {
            id: 'loss',
            label: 'Loss',
            color: 'var(--color-mint)',
            points: [
              { x: 30, y: 0.2 },
              { x: 10, y: 0.8 },
            ],
          },
        ],
        ariaLabel: 'Validation loss',
      }),
    )

    expect(markup).toContain('aria-label="Validation loss"')
    expect(markup).toContain('role="button"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('Validation loss. No point selected.')
    expect(markup).toContain('class="hud-chart-frame relative w-full"')
    expect(markup).toContain('data-mobile-chart="true"')
    expect(markup).toContain('data-swipe-ignore="true"')
    expect(markup).toContain('class="block touch-pan-y"')
    expect(markup).not.toContain('touch-none')
  })

  it('uses per-point radius and detail in the accessible label', () => {
    const markup = renderToStaticMarkup(
      createElement(LineChart, {
        series: [
          {
            id: 'frontier',
            label: 'Labline',
            color: 'var(--color-mint)',
            points: [
              { x: 1, y: 40, r: 3.25, detail: 'think —' },
              { x: 12, y: 72, r: 6.5, detail: 'think 4.0× Think' },
            ],
          },
        ],
        ariaLabel: 'Frontier progress: capability and thinking by release day',
      }),
    )

    expect(markup).toContain('r="3.25"')
    expect(markup).toContain('r="6.5"')
    expect(markup).toContain('data-point-detail="think —"')
    expect(markup).toContain('data-point-detail="think 4.0× Think"')
    expect(markup).toContain('aria-label="Labline, 12, 72, think 4.0× Think"')
  })
})

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
  })
})

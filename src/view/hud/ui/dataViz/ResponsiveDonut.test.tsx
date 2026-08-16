import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ResponsiveDonut } from './ResponsiveDonut'

describe('ResponsiveDonut', () => {
  it('renders the responsive surfaces and an accessible interactive legend', () => {
    const markup = renderToStaticMarkup(
      createElement(ResponsiveDonut, {
        slices: [
          { id: 'owned', label: 'Owned', value: 18, color: '#56e1dc' },
          { id: 'rented', label: 'Rented', value: 6, color: '#7aa2ff' },
        ],
        centerLabel: '24 PF',
        caption: '≈ 12 MW electrical',
        ariaLabel: 'Capacity mix',
        valueFormatter: (value: number) => `${value} PF`,
      }),
    )

    expect(markup).toContain('aria-roledescription="donut chart"')
    expect(markup).toContain('aria-label="Capacity mix legend"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('Owned: 18 PF')
    expect(markup).toContain('Rented: 6 PF')
    expect(markup).toContain('min-[400px]:block')
    expect(markup).toContain('min-[400px]:hidden')
  })
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Sparkline } from './Sparkline'

describe('Sparkline', () => {
  it('renders compact responsive chart semantics for touch and keyboard users', () => {
    const markup = renderToStaticMarkup(
      createElement(Sparkline, {
        values: [1, 2, 3],
        days: [4, 5, 6],
        format: (value: number) => String(value),
        label: 'Cash',
      }),
    )

    expect(markup).toContain('aria-label="Cash sparkline"')
    expect(markup).toContain('class="block touch-pan-y"')
    expect(markup).toContain('Cash sparkline. No point selected.')
  })
})

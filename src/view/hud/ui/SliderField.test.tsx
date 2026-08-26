import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SliderField } from './SliderField'

describe('SliderField mobile disclosure', () => {
  it('makes dense help tappable while keeping the range explicitly labelled', () => {
    const markup = renderToStaticMarkup(createElement(SliderField, {
      label: 'Thinking budget',
      value: 2,
      min: 1,
      max: 100,
      hint: true,
      hoverContent: createElement('p', null, 'Higher effort uses more tokens and compute.'),
      onChange: vi.fn(),
    }))

    expect(markup).toContain('class="slider-field group/slider')
    expect(markup).toContain('data-swipe-ignore="true"')
    expect(markup).toContain('slider-field__hint')
    expect(markup).toContain('data-mobile-disclosure="true"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toMatch(/aria-controls="slider-field-tooltip-[^"]+"/)
    expect(markup).toMatch(/aria-labelledby="slider-field-label-[^"]+"/)
    expect(markup).toContain('role="tooltip"')
  })
})

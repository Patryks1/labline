import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { parseParamsBox } from './modelSize'
import { PARAM_PRESETS } from '../../../sim/balance/training'
import { SizeSlider } from './SizeSlider'

describe('model-size suffix parsing', () => {
  it('accepts explicit M, B, and T suffixes', () => {
    expect(parseParamsBox('400M')).toBe(0.4)
    expect(parseParamsBox('7B')).toBe(7)
    expect(parseParamsBox('1.8T')).toBe(1800)
  })

  it('uses the selected visible suffix and rejects invalid values', () => {
    expect(parseParamsBox('125', 'M')).toBe(0.125)
    expect(parseParamsBox('3', 'T')).toBe(3000)
    expect(parseParamsBox('large')).toBeNull()
    expect(parseParamsBox('-7B')).toBeNull()
  })

  it('exposes the full technology timeline checkpoint set', () => {
    expect(PARAM_PRESETS.map((preset) => preset.label)).toEqual([
      '7M', '70M', '125M', '400M', '1B', '1.5B', '3B', '7B', '13B', '22B',
      '34B', '70B', '110B', '180B', '235B', '405B', '671B', '1T', '1.8T',
      '3T', '5T', '7T', '10T', '13T', '20T', '30T',
    ])
  })

  it('uses shared, touch-sized controls for exact and timeline editing', () => {
    const markup = renderToStaticMarkup(createElement(SizeSlider, {
      label: 'Model size',
      value: 7,
      onChange: vi.fn(),
    }))

    expect(markup).toContain('class="hud-input')
    expect(markup).toContain('class="hud-select')
    expect(markup).toContain('class="hud-range')
    expect(markup).toContain('overflow-x-hidden')
    expect(markup).toContain('bg-panel/95')
    expect(markup).toContain('translate-x-0')
    expect(markup).toContain('-translate-x-full')
    expect(markup).toContain('aria-label="Model size exact"')
    expect(markup).toContain('aria-label="Model size unit"')
  })
})

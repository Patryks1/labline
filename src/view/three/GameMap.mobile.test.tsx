import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GameMap } from './GameMap'

describe('GameMap mobile interaction surface', () => {
  it('owns map gestures and explains tap, one-finger pan, and pinch zoom', () => {
    const markup = renderToStaticMarkup(createElement(GameMap))

    expect(markup).toContain('role="application"')
    expect(markup).toContain('aria-label="Interactive world map"')
    expect(markup).toContain('aria-describedby="world-map-gesture-help"')
    expect(markup).toContain('touch-none select-none overscroll-none')
    expect(markup).toContain('Tap a parcel to select it')
    expect(markup).toContain('pinch with two fingers to zoom')
  })

  it('keeps placement essentials visible while hiding dense site context on phones', () => {
    const markup = renderToStaticMarkup(createElement(GameMap))

    expect(markup).toContain('build-placement-tooltip')
    expect(markup).toContain('hidden text-[0.5625rem] text-bone/70 min-[901px]:block')
    expect(markup).toContain('hidden truncate text-[0.5625rem] text-muted min-[901px]:block')
    expect(markup).toContain('build-placement-status')
    expect(markup).toContain('build-placement-total')
  })
})

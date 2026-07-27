import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  CloudVisibilityButton,
  MapViewportOverlay,
} from './MapNavigator'

describe('CloudVisibilityButton', () => {
  it('exposes its visible state and hide action accessibly', () => {
    const markup = renderToStaticMarkup(createElement(CloudVisibilityButton, {
      cloudsVisible: true,
      onToggle: () => undefined,
    }))

    expect(markup).toContain('aria-label="Show clouds"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('title="Hide clouds"')
  })

  it('exposes its hidden state and show action accessibly', () => {
    const markup = renderToStaticMarkup(createElement(CloudVisibilityButton, {
      cloudsVisible: false,
      onToggle: () => undefined,
    }))

    expect(markup).toContain('aria-pressed="false"')
    expect(markup).toContain('title="Show clouds"')
  })
})

describe('minimap camera footprint', () => {
  it('renders exact ordered corners and retains rectangle compatibility', () => {
    const exact = renderToStaticMarkup(createElement(MapViewportOverlay, {
      worldPerPixel: 1,
      viewport: {
      x: 1,
      y: 2,
      w: 8,
      h: 6,
      corners: [
        { x: 2, y: 7 },
        { x: 8, y: 5 },
        { x: 7, y: 1 },
        { x: 1, y: 3 },
      ],
      },
    }))
    const compatible = renderToStaticMarkup(createElement(MapViewportOverlay, {
      worldPerPixel: 1,
      viewport: { x: 1, y: 2, w: 8, h: 6 },
    }))
    expect(exact).toContain('points="2,7 8,5 7,1 1,3"')
    expect(compatible).toContain('points="1,8 9,8 9,2 1,2"')
  })

  it('points the heading marker outward through the footprint front edge', () => {
    const markup = renderToStaticMarkup(createElement(MapViewportOverlay, {
      worldPerPixel: 0.4,
      viewport: {
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        corners: [
          { x: 0, y: 10 },
          { x: 10, y: 10 },
          { x: 10, y: 0 },
          { x: 0, y: 0 },
        ],
      },
    }))
    expect(markup).toContain('data-map-viewport-heading="true"')
    expect(markup).toContain('x1="5" y1="0" x2="5" y2="-2"')
  })
})

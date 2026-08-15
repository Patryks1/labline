import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createGame } from '../../sim/createGame'
import { buildMapNavigatorData, navigatorCitySummary, type NavigatorCityLabel } from './mapNavigatorData'
import {
  CloudVisibilityButton,
  NavigatorCityLabelLayer,
  NavigatorCompass,
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

describe('NavigatorCompass', () => {
  it('identifies the navigator as north up', () => {
    const markup = renderToStaticMarkup(createElement(NavigatorCompass))
    expect(markup).toContain('role="img"')
    expect(markup).toContain('aria-label="North up"')
    expect(markup).toContain('>N</div>')
  })
})

describe('NavigatorCityLabelLayer', () => {
  const data = buildMapNavigatorData(createGame({ seed: 82, difficulty: 'normal' }))
  const metro = { ...data.cities[0]!, id: 'metro-label', tier: 'metro' as const }
  const settlement = { ...data.cities[1]!, id: 'town-label', tier: 'town' as const }
  const labels: NavigatorCityLabel[] = [
    { id: metro.id, text: metro.name, left: 10, top: 12, width: 70, height: 13 },
    { id: settlement.id, text: settlement.name, left: 90, top: 30, width: 80, height: 13 },
  ]

  it('renders native screen-space buttons with loaded metro and settlement weights', () => {
    const markup = renderToStaticMarkup(createElement(NavigatorCityLabelLayer, {
      labels,
      cities: [metro, settlement],
      onPan: () => undefined,
    }))

    expect(markup.match(/<button/g)).toHaveLength(2)
    expect(markup).not.toContain('<text')
    expect(markup).toContain('font-weight:600')
    expect(markup).toContain('font-weight:500')
    expect(markup).toContain('font-size:11px')
  })

  it('retains detailed accessible names and pans to the activated city', () => {
    const calls: Array<[number, number]> = []
    const layer = NavigatorCityLabelLayer({
      labels,
      cities: [metro, settlement],
      onPan: (x, y) => calls.push([x, y]),
    }) as ReactElement<{ children: ReactElement<{ onClick: (event: { stopPropagation: () => void }) => void }>[] }>
    const markup = renderToStaticMarkup(layer)

    expect(markup).toContain(`aria-label="Pan to ${navigatorCitySummary(metro)}`)
    expect(markup).toContain(`title="${navigatorCitySummary(metro)}"`)
    layer.props.children[0]!.props.onClick({ stopPropagation: () => undefined })
    expect(calls).toEqual([[metro.cx, metro.cy]])
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

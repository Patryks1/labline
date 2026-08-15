import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createGame } from '../../../sim/createGame'
import { PowerEfficiencyCard, PowerMixDonut } from './PowerPanel'

describe('PowerMixDonut', () => {
  it('renders slices with the demand coverage in the center', () => {
    const markup = renderToStaticMarkup(
      createElement(PowerMixDonut, {
        slices: [
          { id: 'solar', label: 'Solar', mw: 6, color: '#ffd166' },
          { id: 'spot', label: 'Spot import', mw: 4, color: '#8babb1' },
        ],
        coveredPct: 0.8,
        demandMw: 10,
      }),
    )
    expect(markup).toContain('Power supply mix')
    expect(markup).toContain('80%')
    expect(markup).toContain('10.0 MW')
    expect(markup).toContain('#ffd166')
    expect(markup).toContain('#8babb1')
  })

  it('renders an empty track without slices', () => {
    const markup = renderToStaticMarkup(
      createElement(PowerMixDonut, {
        slices: [],
        coveredPct: 1,
        demandMw: 0,
      }),
    )
    expect(markup).toContain('Power supply mix')
    expect(markup).toContain('100%')
  })

  it('caps the svg and keeps long values out of the absolute overlay', () => {
    const markup = renderToStaticMarkup(
      createElement(PowerMixDonut, {
        slices: [
          { id: 'solar', label: 'Solar', mw: 6, color: '#ffd166' },
          { id: 'spot', label: 'Spot import', mw: 4, color: '#8babb1' },
        ],
        coveredPct: 0.8,
        demandMw: 1234,
      }),
    )
    // The svg is hard-capped so it can never outgrow its 96px box.
    expect(markup).toContain('width="88"')
    expect(markup).toContain('height="88"')
    expect(markup).toContain('max-w-full')
    // Only the compact coverage value stays in the absolute overlay.
    const overlay = markup.match(
      /<div class="pointer-events-none absolute[^"]*"[^>]*>(.*?)<\/div>/s,
    )
    expect(overlay).not.toBeNull()
    expect(overlay![1]).toContain('80%')
    expect(overlay![1]).not.toContain('GW')
    expect(overlay![1]).not.toContain('demand')
    // The long demand value moved below the chart as truncated flow text.
    const caption = markup.match(
      /<p class="([^"]*)"[^>]*>of 1.23 GW demand<\/p>/,
    )
    expect(caption).not.toBeNull()
    expect(caption![1]).toContain('truncate')
    expect(caption![1]).not.toContain('absolute')
  })

  it('swaps to a horizontal capacity bar below the narrow breakpoint', () => {
    const markup = renderToStaticMarkup(
      createElement(PowerMixDonut, {
        slices: [
          { id: 'solar', label: 'Solar', mw: 6, color: '#ffd166' },
          { id: 'spot', label: 'Spot import', mw: 4, color: '#8babb1' },
        ],
        coveredPct: 0.8,
        demandMw: 10,
      }),
    )
    // Donut only at/above the breakpoint, bar only below it.
    expect(markup).toContain('min-[400px]:block')
    expect(markup).toContain('min-[400px]:hidden')
    // The wrapper can shrink inside the grid cell.
    expect(markup).toContain('min-w-0')
  })
})

describe('PowerEfficiencyCard', () => {
  it('chains power into raw and effective compute', () => {
    const state = createGame(6_402)
    const markup = renderToStaticMarkup(
      createElement(PowerEfficiencyCard, { state }),
    )
    expect(markup).toContain('Compute efficiency')
    expect(markup).toContain('raw')
    expect(markup).toContain('effective')
    expect(markup).toContain('PUE')
    expect(markup).toContain('PF per MW')
    expect(markup).toContain('Trend builds')
  })

  it('shows the PF/MW trend once history accumulates', () => {
    const state = createGame(6_403)
    const withHistory = {
      ...state,
      player: {
        ...state.player,
        powerEfficiencyHistory: [
          { day: 1, pfPerMw: 40 },
          { day: 2, pfPerMw: 42 },
          { day: 3, pfPerMw: 46 },
        ],
      },
    }
    const markup = renderToStaticMarkup(
      createElement(PowerEfficiencyCard, { state: withHistory }),
    )
    expect(markup).toContain('PF per MW trend')
    expect(markup).toContain('up 15.0%')
    expect(markup).toContain('over 3d')
  })
})

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

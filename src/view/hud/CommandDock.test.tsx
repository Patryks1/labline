import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { useGameStore } from '../../store/gameStore'
import { createGame } from '../../sim/createGame'
import { CommandDock, FeedView, sumChannelRows } from './CommandDock'
import { FacilitiesIntelView } from './panels/command/FacilitiesIntelView'

describe('CommandDock disclosure semantics', () => {
  it('exposes a labelled region and controls for the expanded dock and channels', () => {
    const previous = {
      commandDockOpen: useGameStore.getState().commandDockOpen,
      commandView: useGameStore.getState().commandView,
    }
    useGameStore.setState({ commandDockOpen: true, commandView: 'pnl' })

    try {
      const markup = renderToStaticMarkup(createElement(CommandDock))

      expect(markup).toContain('id="command-dock-panel"')
      expect(markup).toContain('role="region"')
      expect(markup).toContain('aria-label="Intel dock"')
      expect(markup).toContain('aria-expanded="true"')
      expect(markup).toContain('aria-controls="command-dock-panel"')
      expect(markup).toContain('aria-controls="command-channel-api"')
      expect(markup).toContain('aria-label="API breakdown"')
      expect(markup).toContain('>Sites<')
    } finally {
      useGameStore.setState(previous)
    }
  })
})

describe('World feed filters and ordering', () => {
  it('renders category filters, sorts typed cards by day, and hides duplicate legacy fallbacks', () => {
    const base = createGame(921)
    const markup = renderToStaticMarkup(createElement(FeedView, {
      stateOverride: {
        ...base,
        day: 7,
        feedEvents: [
          {
            id: 'feed-newer',
            day: 7,
            category: 'models',
            title: 'Model checkpoint reached',
            body: 'Training crossed a deterministic milestone.',
            source: 'Model Desk',
            kind: 'training_milestone',
          },
          {
            id: 'feed-older',
            day: 5,
            category: 'market',
            title: 'Compute quote moved',
            body: 'The provider repriced finite capacity.',
            source: 'Compute Desk',
            kind: 'compute_quote_changed',
          },
        ],
        news: [
          'Day 7: Model checkpoint reached — Training crossed a deterministic milestone.',
          'Day 4: Legacy wire story remains visible.',
        ],
        alerts: [
          {
            id: 'feed-alert',
            day: 7,
            severity: 'info' as const,
            message: 'A separate market alert.',
          },
        ],
      },
    }))
    expect(markup).toContain('Models / Research')
    expect(markup).toContain('Market / Pricing')
    expect(markup).toContain('Rivals / Company')
    expect(markup).toContain('role="checkbox"')
    expect(markup.indexOf('Model checkpoint reached')).toBeLessThan(markup.indexOf('Compute quote moved'))
    expect(markup.match(/Model checkpoint reached/g)).toHaveLength(1)
    expect(markup).toContain('Legacy wire story remains visible.')
  })
})

describe('command dock sites channel', () => {
  it('renders campus intel for the sites view', () => {
    const markup = renderToStaticMarkup(createElement(FacilitiesIntelView))
    expect(markup).toContain('Campus')
    expect(markup).toContain('No facilities yet')
  })
})

describe('command dock channel ledger', () => {
  it('header totals equal the listed rows, including plans past the first four', () => {
    const rows = [
      { revenue: 0, cogs: 39_000, mtok: 0.72, users: 8_777_940 },
      { revenue: 2_090_000, cogs: 330_000, mtok: 3.93, users: 3_136_045 },
      { revenue: 4_810_000, cogs: 1_350_000, mtok: 15.86, users: 1_442_818 },
      { revenue: 4_620_000, cogs: 2_250_000, mtok: 17.49, users: 693_065 },
      { revenue: 98_000_000, cogs: 14_050_000, mtok: 109, users: 590_000 },
    ]
    const firstFour = sumChannelRows(rows.slice(0, 4))
    const all = sumChannelRows(rows)
    expect(all.revenue).toBeCloseTo(rows.reduce((sum, row) => sum + row.revenue, 0))
    expect(all.cogs).toBeCloseTo(rows.reduce((sum, row) => sum + row.cogs, 0))
    expect(all.mtok).toBeGreaterThan(firstFour.mtok)
    expect(all.users).toBeGreaterThan(firstFour.users)
    expect(all.revenue - all.cogs).toBeCloseTo(
      rows.reduce((sum, row) => sum + row.revenue - row.cogs, 0),
    )
  })
})

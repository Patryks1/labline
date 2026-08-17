import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { useGameStore } from '../../store/gameStore'
import { CommandDock, sumChannelRows } from './CommandDock'

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
    } finally {
      useGameStore.setState(previous)
    }
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

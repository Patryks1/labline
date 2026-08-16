import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { useGameStore } from '../../store/gameStore'
import { CommandDock } from './CommandDock'

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

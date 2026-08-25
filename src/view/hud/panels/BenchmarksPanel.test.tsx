import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createGame } from '../../../sim/createGame'
import { useGameStore } from '../../../store/gameStore'
import { BenchmarksPanel } from './BenchmarksPanel'

describe('BenchmarksPanel leaderboard rows', () => {
  it('encodes thinking in rows instead of Instant/Think/Deep column triplets', () => {
    useGameStore.setState({ state: createGame(64_221) })
    const markup = renderToStaticMarkup(createElement(BenchmarksPanel))

    expect(markup).toContain('title="Thinking recipe for this row"')
    expect(markup).toContain('$/MTok')
    expect(markup).toContain('One row per thinking level')
    expect(markup).toContain('same $/MTok list price')
    expect(markup).not.toContain('Instant $')
    expect(markup).not.toContain('Think $')
    expect(markup).not.toContain('Deep $')
  })
})

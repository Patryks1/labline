import { describe, expect, it } from 'vitest'
import { buildGameConfig, defaultGameConfig } from './gameConfig'

describe('new game configuration', () => {
  it('uses the large frontier world defaults', () => {
    expect(defaultGameConfig()).toMatchObject({
      mapWidth: 300,
      mapHeight: 300,
      cityCount: 4,
      rivalCount: 5,
    })
  })

  it('keeps explicit custom scenario controls authoritative', () => {
    expect(
      buildGameConfig({
        difficulty: 'normal',
        advanced: {
          mapWidth: 180,
          mapHeight: 140,
          cityCount: 6,
          rivalCount: 3,
          startingCashMult: 2.5,
        },
      }),
    ).toMatchObject({
      mapWidth: 180,
      mapHeight: 140,
      cityCount: 6,
      rivalCount: 3,
      startingCashMult: 2.5,
    })
  })

  it('does not resize explicit maps when defaults change', () => {
    expect(
      buildGameConfig({
        difficulty: 'hard',
        advanced: { mapWidth: 150, mapHeight: 120 },
      }),
    ).toMatchObject({
      mapWidth: 150,
      mapHeight: 120,
    })
  })
})

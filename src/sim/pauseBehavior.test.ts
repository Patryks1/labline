import { describe, expect, it } from 'vitest'
import { createGame } from './createGame'
import { tickMany } from './tick'

describe('simulation pause behavior', () => {
  it('continues advancing across ordinary days by default', () => {
    const state = {
      ...createGame({
        seed: 7712,
        difficulty: 'normal',
        advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 2 },
      }),
      paused: false,
    }
    const next = tickMany(state, 15)
    expect(next.day).toBe(state.day + 15)
    expect(next.paused).toBe(false)
  })
})

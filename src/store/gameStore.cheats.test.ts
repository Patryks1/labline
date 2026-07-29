import { beforeEach, describe, expect, it } from 'vitest'
import { createGame } from '../sim/createGame'
import { useGameStore } from './gameStore'

describe('game store cheat money adjustment', () => {
  beforeEach(() => {
    useGameStore.setState({
      phase: 'playing',
      state: createGame({ seed: 917, difficulty: 'easy' }),
    })
  })

  it('adds money across the player and lab finance views', () => {
    const before = useGameStore.getState().state.player.cash

    expect(useGameStore.getState().adjustCheatMoney(2_500_000)).toBe(true)

    const state = useGameStore.getState().state
    expect(state.player.cash).toBe(before + 2_500_000)
    expect(state.player.finance.cash).toBe(state.player.cash)
    expect(state.labs[state.playerLabId]?.cash).toBe(state.player.cash)
    expect(state.labs[state.playerLabId]?.finance.cash).toBe(state.player.cash)
  })

  it('removes money and clamps the balance at zero', () => {
    expect(useGameStore.getState().adjustCheatMoney(-Number.MAX_SAFE_INTEGER)).toBe(true)

    const state = useGameStore.getState().state
    expect(state.player.cash).toBe(0)
    expect(state.player.finance.cash).toBe(0)
    expect(state.labs[state.playerLabId]?.cash).toBe(0)
    expect(state.labs[state.playerLabId]?.finance.cash).toBe(0)
  })

  it('rejects zero and non-finite adjustments without changing state', () => {
    const before = useGameStore.getState().state

    expect(useGameStore.getState().adjustCheatMoney(0)).toBe(false)
    expect(useGameStore.getState().adjustCheatMoney(Number.NaN)).toBe(false)
    expect(useGameStore.getState().adjustCheatMoney(Number.POSITIVE_INFINITY)).toBe(false)
    expect(useGameStore.getState().state).toBe(before)
  })
})

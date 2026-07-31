import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSaveMeta, clearAllSaves, SAVE_VERSION } from '../sim/save'
import { setGameSaveWriterForTests, useGameStore } from './gameStore'
import { useUiStore } from './uiStore'

describe('async game save lifecycle', () => {
  beforeEach(async () => {
    await clearAllSaves()
    useGameStore.setState({
      phase: 'menu',
      loading: null,
      lifecycleError: null,
      saveSlots: [],
      storageReady: false,
      saveStatus: 'idle',
      pauseMenuOpen: false,
    })
  })

  afterEach(() => {
    setGameSaveWriterForTests()
  })

  it('publishes a loading phase before generating a world', async () => {
    const pending = useGameStore.getState().startGame({
      seed: 401,
      difficulty: 'easy',
      advanced: { mapWidth: 128, mapHeight: 128, cityCount: 3, rivalCount: 1 },
    })
    expect(useGameStore.getState()).toMatchObject({
      phase: 'loading',
      loading: { operation: 'new-game' },
    })
    expect(await pending).toEqual({ ok: true })
    expect(useGameStore.getState()).toMatchObject({
      phase: 'playing',
      loading: null,
    })
    expect(useGameStore.getState().state.map.storage).toBe('compact')
  })

  it('saves and loads compact campaigns asynchronously', async () => {
    await useGameStore.getState().startGame({
      seed: 402,
      difficulty: 'easy',
      advanced: { mapWidth: 128, mapHeight: 128, cityCount: 3, rivalCount: 1 },
    })
    useGameStore.setState((store) => ({ state: { ...store.state, day: 23 } }))
    const saved = await useGameStore.getState().saveGame('1')
    expect(saved.ok).toBe(true)
    expect(useGameStore.getState().saveSlots[0]).toMatchObject({ slotId: '1', day: 23 })

    useGameStore.setState((store) => ({ state: { ...store.state, day: 99 } }))
    const pending = useGameStore.getState().loadGame('1')
    expect(useGameStore.getState().phase).toBe('loading')
    expect(await pending).toEqual({ ok: true })
    expect(useGameStore.getState().state.day).toBe(23)
    expect(useGameStore.getState().state.map.world).toBeDefined()
  })

  it('retains the current run negotiation state when loading fails', async () => {
    useUiStore.getState().updateComputeNegotiation('provider-a', (current) => ({
      ...current,
      status: 'countered',
      transcript: [{ side: 'provider', text: 'Counter offer', day: 4, sequence: 0 }],
    }))

    const result = await useGameStore.getState().loadGame('8')

    expect(result.ok).toBe(false)
    expect(useUiStore.getState().computeNegotiations['provider-a']).toMatchObject({
      status: 'countered',
      transcript: [{ text: 'Counter offer' }],
    })
  })

  it('debounces day autosaves and flushes immediately on pause', async () => {
    await useGameStore.getState().startGame({ seed: 403, difficulty: 'easy' })
    for (let day = 0; day < 4; day++) useGameStore.getState().stepDay()
    await useGameStore.getState().refreshSaves()
    expect(useGameStore.getState().saveSlots).toEqual([])

    useGameStore.getState().setPaused(true)
    await useGameStore.getState().flushAutosave()
    await useGameStore.getState().refreshSaves()
    expect(useGameStore.getState().saveSlots.find((meta) => meta.slotId === 'auto')).toMatchObject({
      day: useGameStore.getState().state.day,
      version: SAVE_VERSION,
    })
  })

  it('chains a forced follow-up when state changes during an in-flight autosave', async () => {
    await useGameStore.getState().startGame({ seed: 404, difficulty: 'easy' })
    const writes: {
      day: number
      cash: number
      release: () => void
    }[] = []
    let activeWrites = 0
    let maxActiveWrites = 0
    setGameSaveWriterForTests(async (slotId, state) => {
      activeWrites++
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
      let release: () => void = () => undefined
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      writes.push({ day: state.day, cash: state.player.cash, release })
      try {
        await barrier
        return buildSaveMeta(state, slotId, `2026-01-01T00:00:0${writes.length}.000Z`)
      } finally {
        activeWrites--
      }
    })

    const firstFlush = useGameStore.getState().flushAutosave()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ day: 1 })

    useGameStore.setState((store) => ({
      state: {
        ...store.state,
        day: 2,
        player: { ...store.state.player, cash: 987_654_321 },
      },
    }))
    let forcedResolved = false
    const forcedFlush = useGameStore
      .getState()
      .flushAutosave()
      .then((result) => {
        forcedResolved = true
        return result
      })

    writes[0]!.release()
    await vi.waitFor(() => expect(writes).toHaveLength(2))
    expect(forcedResolved).toBe(false)
    expect(maxActiveWrites).toBe(1)
    expect(writes[1]).toMatchObject({ day: 2, cash: 987_654_321 })

    writes[1]!.release()
    const [firstResult, forcedResult] = await Promise.all([firstFlush, forcedFlush])
    expect(firstResult).toMatchObject({ ok: true, meta: { day: 2 } })
    expect(forcedResult).toMatchObject({ ok: true, meta: { day: 2 } })
    expect(maxActiveWrites).toBe(1)
  })
})

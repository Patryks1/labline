import { beforeEach, describe, expect, it } from 'vitest'
import { useGameStore, type MapViewport } from './gameStore'

describe('map navigation requests', () => {
  beforeEach(() => {
    useGameStore.setState({
      selectedTile: { x: 3, y: 4 },
      buildMode: 'dc',
      mapFocusRequest: null,
    })
  })

  it('pans without changing selection or build mode and preserves zoom', () => {
    useGameStore.getState().panMapToTile(21, 34)
    expect(useGameStore.getState()).toMatchObject({
      selectedTile: { x: 3, y: 4 },
      buildMode: 'dc',
      mapFocusRequest: { x: 21, y: 34, sequence: 1, preserveZoom: true },
    })
  })

  it('keeps focus-and-select behavior and requests the standard zoom', () => {
    useGameStore.getState().focusMapTile(8, 13)
    expect(useGameStore.getState()).toMatchObject({
      selectedTile: { x: 8, y: 13 },
      buildMode: null,
      mapFocusRequest: { x: 8, y: 13, sequence: 1, preserveZoom: false },
    })
  })

  it('uses one monotonic request sequence for focus and pan', () => {
    useGameStore.getState().panMapToTile(1, 2)
    useGameStore.getState().focusMapTile(2, 3)
    useGameStore.getState().panMapToTile(3, 4)
    expect(useGameStore.getState().mapFocusRequest?.sequence).toBe(3)
  })

  it('publishes the exact minimap footprint without changing compatible bounds', () => {
    const viewport: MapViewport = {
      x: 4,
      y: 5,
      w: 12,
      h: 9,
      corners: [
        { x: 5, y: 13 },
        { x: 16, y: 11 },
        { x: 15, y: 4 },
        { x: 4, y: 6 },
      ],
    }
    useGameStore.getState().setMapViewport(viewport)
    expect(useGameStore.getState().mapViewport).toEqual(viewport)
  })
})

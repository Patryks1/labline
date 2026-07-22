import { describe, expect, it } from 'vitest'
import { createGame } from '../../sim/createGame'
import {
  buildMinimapTerrain,
  buildMapNavigatorData,
  numberColor,
  regionOverlayFill,
} from './mapNavigatorData'

describe('world navigator data', () => {
  it('indexes cities, rival facilities, and every company into bounded navigation targets', () => {
    const state = createGame({ seed: 73, difficulty: 'normal' })
    const data = buildMapNavigatorData(state)

    expect(data.cities.length).toBeGreaterThan(0)
    expect(data.terrain.length).toBeGreaterThan(0)
    expect(data.terrain[0]?.size).toBeGreaterThan(0)
    expect(data.companies).toHaveLength(state.rivals.length + 1)
    expect(data.sites.some((site) => site.ownerType === 'rival')).toBe(true)
    for (const company of data.companies) {
      expect(company.x).toBeGreaterThanOrEqual(0)
      expect(company.x).toBeLessThan(data.width)
      expect(company.y).toBeGreaterThanOrEqual(0)
      expect(company.y).toBeLessThan(data.height)
    }
  })

  it('projects authoritative compact-world terrain instead of an empty legacy tile array', () => {
    const base = createGame({ seed: 75, difficulty: 'normal' })
    const compact = createGame({
      config: {
        ...base.config,
        seed: 75,
        mapWidth: 1_000,
        mapHeight: 1_000,
        cityCount: 12,
      },
    })

    expect(compact.map.storage).toBe('compact')
    expect(compact.map.tiles).toHaveLength(0)
    const terrain = buildMinimapTerrain(compact)
    expect(terrain.length).toBeLessThanOrEqual(2_500)
    expect(terrain.some((cell) => cell.kind !== 'empty')).toBe(true)
    expect(terrain.some((cell) => cell.kind === 'road' || cell.kind === 'city')).toBe(true)
  })

  it('produces stable company colors and distinct regional heatmap modes', () => {
    const state = createGame({ seed: 74, difficulty: 'normal' })
    const region = state.map.regions[0]!

    expect(numberColor(0x48d7d1)).toBe('#48d7d1')
    expect(regionOverlayFill(region, state.map.regions, 'zones', 0)).toMatch(/^#/)
    expect(regionOverlayFill(region, state.map.regions, 'power', 0)).toContain('hsl(')
    expect(regionOverlayFill(region, state.map.regions, 'latency', 0)).toContain('hsl(')
    expect(regionOverlayFill(region, state.map.regions, 'risk', 0)).toContain('hsl(')
  })
})

import { describe, expect, it } from 'vitest'
import { createGame } from '../../sim/createGame'
import {
  buildMapNavigatorData,
  numberColor,
  regionOverlayFill,
} from './mapNavigatorData'

describe('world navigator data', () => {
  it('indexes cities, rival facilities, and every company into bounded navigation targets', () => {
    const state = createGame({ seed: 73, difficulty: 'normal' })
    const data = buildMapNavigatorData(state)

    expect(data.cities.length).toBeGreaterThan(0)
    expect(data.companies).toHaveLength(state.rivals.length + 1)
    expect(data.sites.some((site) => site.ownerType === 'rival')).toBe(true)
    for (const company of data.companies) {
      expect(company.x).toBeGreaterThanOrEqual(0)
      expect(company.x).toBeLessThan(data.width)
      expect(company.y).toBeGreaterThanOrEqual(0)
      expect(company.y).toBeLessThan(data.height)
    }
  })

  it('produces stable company colors and distinct regional heatmap modes', () => {
    const state = createGame({ seed: 74, difficulty: 'normal' })
    const region = state.map.regions[0]!

    expect(numberColor(0x48d7d1)).toBe('#48d7d1')
    expect(regionOverlayFill(region, state.map.regions, 'zones', 0)).toMatch(/^#/)
    expect(regionOverlayFill(region, state.map.regions, 'energy', 0)).toContain('hsl(')
    expect(regionOverlayFill(region, state.map.regions, 'latency', 0)).toContain('hsl(')
    expect(regionOverlayFill(region, state.map.regions, 'risk', 0)).toContain('hsl(')
  })
})

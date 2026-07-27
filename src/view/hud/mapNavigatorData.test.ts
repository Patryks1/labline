import { describe, expect, it } from 'vitest'
import { createGame } from '../../sim/createGame'
import {
  buildMinimapTerrain,
  buildMinimapRoads,
  buildMapNavigatorData,
  layoutNavigatorCityLabels,
  minimapTerrainColor,
  navigatorPointToWorld,
  navigatorView,
  navigatorZoomAround,
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
    expect(new Set(terrain.map((cell) => cell.biome)).size).toBeGreaterThan(1)
    expect(Math.max(...terrain.map((cell) => cell.elevation))).toBeGreaterThan(0.4)
    expect(terrain.some((cell) => cell.relief > 0)).toBe(true)
    expect(terrain.some((cell) => cell.waterCoverage > 0)).toBe(true)
    expect(terrain.some((cell) => cell.urbanCoverage > 0)).toBe(true)
    expect(terrain.some((cell) => cell.roadClass >= 3)).toBe(true)
    expect(buildMinimapTerrain(compact)).toBe(terrain)
  })

  it('uses world-relative relief and biome colors rather than legacy tile paint alone', () => {
    const low = {
      x: 0,
      y: 0,
      size: 8,
      kind: 'empty' as const,
      biome: 'plains' as const,
      elevation: 0.1,
      relief: 0,
      waterCoverage: 0,
      urbanCoverage: 0,
      roadCoverage: 0,
      roadClass: 0,
      roadAngle: 0 as const,
      roadJunction: false,
    }
    const ridge = { ...low, biome: 'alpine' as const, elevation: 0.9, relief: 0.2 }

    expect(minimapTerrainColor(low)).not.toBe(minimapTerrainColor(ridge))
    expect(minimapTerrainColor(ridge)).toMatch(/^#[0-9a-f]{6}$/)
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

  it('keeps an equal world scale and cursor anchor across navigator zooms', () => {
    const fit = navigatorView(1_000, 500, 1, 500, 250, 1)
    expect(fit).toEqual({ x: 0, y: -250, width: 1_000, height: 1_000, zoom: 1 })
    const anchor = navigatorPointToWorld(fit, 75, 50, 100, 100)
    const zoomed = navigatorZoomAround(1_000, 500, fit, 2, anchor.x, anchor.y, 1)
    const after = navigatorPointToWorld(zoomed, 75, 50, 100, 100)
    expect(after.x).toBeCloseTo(anchor.x)
    expect(after.y).toBeCloseTo(anchor.y)
    expect(zoomed.width).toBe(500)
    expect(zoomed.height).toBe(500)
  })

  it('extracts exact topology edges and reuses the revision projection', () => {
    const state = createGame({ seed: 78, difficulty: 'normal' })
    const roads = buildMinimapRoads(state)
    expect(roads.length).toBeGreaterThan(0)
    expect(roads.every((edge) => edge.roadClass >= 1 && edge.roadClass <= 4)).toBe(true)
    expect(buildMinimapRoads(state)).toBe(roads)
  })

  it('reveals settlement tiers by zoom and resolves labels deterministically', () => {
    const state = createGame({ seed: 79, difficulty: 'normal' })
    const cities = state.map.cities ?? []
    const view = navigatorView(state.map.width, state.map.height, 1, state.map.width / 2, state.map.height / 2, 2)
    const fitLabels = layoutNavigatorCityLabels(cities, 1, view, 280, 140)
    expect(fitLabels.every((label) => cities.find((city) => city.id === label.id)?.tier === 'metro')).toBe(true)
    expect(layoutNavigatorCityLabels(cities, 1, view, 280, 140)).toEqual(fitLabels)
    const detailView = { ...view, zoom: 4 as const }
    const detailLabels = layoutNavigatorCityLabels(cities, 4, detailView, 280, 140)
    expect(detailLabels.length).toBeGreaterThanOrEqual(fitLabels.length)
  })
})

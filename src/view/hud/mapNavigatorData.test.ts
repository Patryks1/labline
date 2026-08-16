import { describe, expect, it } from 'vitest'
import { createGame } from '../../sim/createGame'
import type { MapCity } from '../../sim/types'
import {
  buildMinimapTerrain,
  buildMinimapRoads,
  buildMapNavigatorData,
  layoutNavigatorCityLabels,
  minimapTerrainColor,
  navigatorPointToWorld,
  navigatorView,
  navigatorZoomAround,
  navigatorCitySummary,
  numberColor,
  regionOverlayFill,
} from './mapNavigatorData'

describe('world navigator data', () => {
  it('indexes cities, rival facilities, and every company into bounded navigation targets', () => {
    const state = createGame({ seed: 73, difficulty: 'normal' })
    const data = buildMapNavigatorData(state)

    expect(data.cities.length).toBeGreaterThan(0)
    expect(data.cities[0]?.stats.cityId).toBe(data.cities[0]?.id)
    expect(navigatorCitySummary(data.cities[0]!)).toContain('municipal capacity')
    expect(navigatorCitySummary(data.cities[0]!)).toContain('reserve margin')
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

  it('uses the canonical finance readout for the player company share', () => {
    const state = createGame({ seed: 76, difficulty: 'normal' })
    state.player.finance = {
      ...state.player.finance,
      totalShare: 0.37,
    }

    const player = buildMapNavigatorData(state).companies.find(
      (company) => company.id === 'player',
    )

    expect(player?.marketShare).toBe(0.37)
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
    expect(fit).toEqual({ x: 250, y: 0, width: 500, height: 500, zoom: 1 })
    const anchor = navigatorPointToWorld(fit, 75, 50, 100, 100)
    const zoomed = navigatorZoomAround(1_000, 500, fit, 2, anchor.x, anchor.y, 1)
    const after = navigatorPointToWorld(zoomed, 75, 50, 100, 100)
    expect(after.x).toBeCloseTo(anchor.x)
    expect(after.y).toBeCloseTo(anchor.y)
    expect(zoomed.width).toBe(250)
    expect(zoomed.height).toBe(250)
  })

  it('covers wide and tall navigator frames without exposing out-of-world bars', () => {
    const cases = [
      { worldWidth: 1_000, worldHeight: 500, view: navigatorView(1_000, 500, 1, 500, 250, 1) },
      { worldWidth: 1_000, worldHeight: 500, view: navigatorView(1_000, 500, 1, 500, 250, 2.4) },
      { worldWidth: 500, worldHeight: 1_000, view: navigatorView(500, 1_000, 1, 250, 500, 0.65) },
    ]
    for (const { view, worldWidth, worldHeight } of cases) {
      expect(view.x).toBeGreaterThanOrEqual(0)
      expect(view.y).toBeGreaterThanOrEqual(0)
      expect(view.x + view.width).toBeLessThanOrEqual(worldWidth)
      expect(view.y + view.height).toBeLessThanOrEqual(worldHeight)
    }
  })

  it('extracts exact topology edges and reuses the revision projection', () => {
    const state = createGame({ seed: 78, difficulty: 'normal' })
    const roads = buildMinimapRoads(state)
    expect(roads.length).toBeGreaterThan(0)
    expect(roads.every((edge) => edge.roadClass >= 1 && edge.roadClass <= 4)).toBe(true)
    expect(buildMinimapRoads(state)).toBe(roads)
  })

  it('reveals settlement tiers by zoom and resolves screen-space boxes deterministically', () => {
    const state = createGame({ seed: 79, difficulty: 'normal' })
    const source = state.map.cities![0]!
    const city = (id: string, name: string, tier: MapCity['tier'], cx: number): MapCity => ({
      ...source,
      id,
      name,
      tier,
      cx,
      cy: 40,
      population: 1_000,
    })
    const cities = [
      city('metro', 'Metro', 'metro', 20),
      city('satellite', 'Orbit', 'satellite', 40),
      city('town', 'Town', 'town', 60),
      city('village', 'Village', 'village', 80),
    ]
    const view = { x: 0, y: 0, width: 100, height: 100, zoom: 1 as const }
    const labelsAt = (zoom: 1 | 2 | 4) => layoutNavigatorCityLabels(cities, zoom, { ...view, zoom }, 400, 200)

    expect(labelsAt(1).map((label) => label.id)).toEqual(['metro'])
    expect(labelsAt(2).map((label) => label.id)).toEqual(['metro', 'satellite', 'town'])
    expect(labelsAt(4).map((label) => label.id)).toEqual(['metro', 'satellite', 'town', 'village'])
    expect(labelsAt(4)).toEqual(labelsAt(4))
  })

  it('keeps label boxes in bounds and clear of labels and reserved controls', () => {
    const state = createGame({ seed: 80, difficulty: 'normal' })
    const cities = state.map.cities ?? []
    const view = navigatorView(state.map.width, state.map.height, 4, state.map.width / 2, state.map.height / 2, 2)
    const reserved = { x: 48, y: 100, width: 184, height: 38 }
    const labels = layoutNavigatorCityLabels(cities, 4, view, 280, 140, [reserved])
    const intersects = (
      a: { left: number; top: number; width: number; height: number },
      b: { left: number; top: number; width: number; height: number },
    ) => a.left < b.left + b.width && a.left + a.width > b.left &&
      a.top < b.top + b.height && a.top + a.height > b.top
    const reservedBox = { left: reserved.x, top: reserved.y, width: reserved.width, height: reserved.height }

    for (const [index, label] of labels.entries()) {
      expect(label.left).toBeGreaterThanOrEqual(2)
      expect(label.top).toBeGreaterThanOrEqual(2)
      expect(label.left + label.width).toBeLessThanOrEqual(278)
      expect(label.top + label.height).toBeLessThanOrEqual(138)
      expect(intersects(label, reservedBox)).toBe(false)
      for (const other of labels.slice(index + 1)) expect(intersects(label, other)).toBe(false)
    }
  })

  it('allocates wider screen-space boxes to longer city names', () => {
    const state = createGame({ seed: 81, difficulty: 'normal' })
    const source = state.map.cities![0]!
    const cities: MapCity[] = [
      { ...source, id: 'short', name: 'Ion', tier: 'metro', cx: 25, cy: 50 },
      { ...source, id: 'long', name: 'Long Junction', tier: 'metro', cx: 75, cy: 50 },
    ]
    const labels = layoutNavigatorCityLabels(
      cities,
      1,
      { x: 0, y: 0, width: 100, height: 100, zoom: 1 },
      400,
      200,
    )
    const short = labels.find((label) => label.id === 'short')!
    const long = labels.find((label) => label.id === 'long')!

    expect(short.height).toBe(13)
    expect(long.width).toBeCloseTo('Long Junction'.length * 6.6 + 4)
    expect(long.width).toBeGreaterThan(short.width)
  })
})

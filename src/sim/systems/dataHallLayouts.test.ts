import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { DataHallObjectPlacement } from '../types'
import { tileCoords } from '../world'
import { fleetStats } from './racks'
import {
  analyzeHallLayout,
  applyHallPlan,
  autoPlanHall,
  createDefaultHallLayout,
  createWall,
  migrateDataHallLayouts,
  playerHallPueMultiplier,
  previewHallObjectPlacement,
  rackUnitsForFacility,
} from './dataHallLayouts'

const rack = (id: string, x: number, z: number): DataHallObjectPlacement => ({
  id: `rack:${id}`, kind: 'rack', catalogId: 'rack_h100', rackUnitId: id,
  x, z, rotation: 0, purchasePrice: 0,
})

describe('free-placement data hall layouts', () => {
  it('hard-blocks overlaps and exterior door clearance', () => {
    const inventory = [
      { unitId: 'u1', skuId: 'rack_h100', mw: 0.01, networkGbps: 400, delivered: true },
      { unitId: 'u2', skuId: 'rack_h100', mw: 0.01, networkGbps: 400, delivered: true },
    ]
    const base = createDefaultHallLayout('hall', 'hall-small-v1', [], 96)
    const overlap = analyzeHallLayout({ ...base, objects: [...base.objects, rack('u1', 20, 20), rack('u2', 21, 21)] }, inventory, 96)
    expect(overlap.valid).toBe(false)
    expect(overlap.hardErrors.some((error) => error.includes('overlaps'))).toBe(true)
    const door = analyzeHallLayout({ ...base, objects: [...base.objects, rack('u1', 46, 0)] }, inventory, 96)
    expect(door.hardErrors.some((error) => error.includes('door clearance'))).toBe(true)
  })

  it('uses lightweight collision checks for placement ghosts', () => {
    const base = createDefaultHallLayout('hall', 'hall-small-v1', [], 96)
    const existing = rack('u1', 20, 20)
    const layout = { ...base, objects: [...base.objects, existing] }
    expect(previewHallObjectPlacement(layout, rack('u2', 21, 21), 96)).toBe('invalid')
    expect(previewHallObjectPlacement(layout, rack('u2', 27, 20), 96)).toBe('warning')
    expect(previewHallObjectPlacement(layout, rack('u2', 60, 40), 96)).toBe('valid')
  })

  it('rejects duplicate persisted object IDs', () => {
    const inventory = [
      { unitId: 'u1', skuId: 'rack_h100', mw: 0.01, networkGbps: 400, delivered: true },
      { unitId: 'u2', skuId: 'rack_h100', mw: 0.01, networkGbps: 400, delivered: true },
    ]
    const base = createDefaultHallLayout('hall', 'hall-small-v1', [], 96)
    const result = analyzeHallLayout({ ...base, objects: [...base.objects, rack('u1', 20, 20), { ...rack('u2', 40, 40), id: 'rack:u1' }] }, inventory, 96)
    expect(result.valid).toBe(false)
    expect(result.hardErrors.some((error) => error.includes('used more than once'))).toBe(true)
  })

  it('routes utilities deterministically and applies spatial performance penalties', () => {
    const inventory = [{ unitId: 'u1', skuId: 'rack_h100', mw: 0.25, networkGbps: 400, delivered: true }]
    const layout = createDefaultHallLayout('hall', 'hall-small-v1', inventory, 96)
    const first = analyzeHallLayout(layout, inventory, 96)
    const second = analyzeHallLayout(layout, inventory, 96)
    expect(first).toEqual(second)
    expect(first.operationalRackUnitIds).toContain('u1')
    expect(first.throughputMultiplier).toBeGreaterThanOrEqual(0.65)
    expect(first.throughputMultiplier).toBeLessThanOrEqual(1)
    expect(first.pueMultiplier).toBeGreaterThanOrEqual(1)
  })

  it('generates distinct deterministic auto-layout strategies without committing', () => {
    const inventory = Array.from({ length: 12 }, (_, index) => ({ unitId: `u${index}`, skuId: 'rack_h100', mw: 0.01, networkGbps: 100, delivered: true }))
    const base = createDefaultHallLayout('hall', 'hall-small-v1', [], 96)
    const density = autoPlanHall(base, inventory, 'density', 96)
    const efficiency = autoPlanHall(base, inventory, 'efficiency', 96)
    expect(density.objects.filter((entry) => entry.kind === 'rack')).toHaveLength(12)
    expect(efficiency.objects.filter((entry) => entry.kind === 'rack')).toHaveLength(12)
    expect(density.objects).not.toEqual(efficiency.objects)
    expect(base.objects.some((entry) => entry.kind === 'rack')).toBe(false)
  })

  it('provisions visible power, cooling, and network capacity for editor previews', () => {
    const inventory = Array.from({ length: 24 }, (_, index) => ({ unitId: `preview-${index}`, skuId: 'rack_h100', mw: 0.012, networkGbps: 400, delivered: true }))
    const base = createDefaultHallLayout('preview-hall', 'hall-small-v1', [], 96)
    const planned = autoPlanHall(base, inventory, 'resilience', 96, { provisionUtilities: true })
    expect(planned.objects.filter((entry) => entry.kind === 'power').length).toBeGreaterThanOrEqual(3)
    expect(planned.objects.filter((entry) => entry.kind === 'cooling').length).toBeGreaterThanOrEqual(3)
    expect(planned.objects.filter((entry) => entry.kind === 'network').length).toBeGreaterThanOrEqual(4)
    expect(planned.objects.some((entry) => entry.id.includes(':auto-plan:') && entry.purchasePrice > 0)).toBe(true)
    const analysis = analyzeHallLayout(planned, inventory, 96)
    expect(analysis.valid).toBe(true)
    expect(analysis.operationalRackUnitIds).toHaveLength(24)
  })

  it('places a rated 96-rack small hall with the efficiency strategy', () => {
    const inventory = Array.from({ length: 96 }, (_, index) => ({ unitId: `u${index}`, skuId: 'rack_h100', mw: 0.01, networkGbps: 100, delivered: true }))
    const base = createDefaultHallLayout('hall', 'hall-small-v1', [], 96)
    const planned = autoPlanHall(base, inventory, 'efficiency', 96)
    expect(planned.objects.filter((entry) => entry.kind === 'rack')).toHaveLength(96)
  })

  it('fills every rated rack space even when utility equipment consumes preferred rows', () => {
    const inventory = Array.from({ length: 96 }, (_, index) => ({ unitId: `full-${index}`, skuId: 'rack_h100', mw: 0.012, networkGbps: 400, delivered: true }))
    const base = createDefaultHallLayout('full-preview', 'hall-small-v1', [], 96)
    const planned = autoPlanHall(base, inventory, 'resilience', 96, { provisionUtilities: true })
    expect(planned.objects.filter((entry) => entry.kind === 'rack')).toHaveLength(96)
    const analysis = analyzeHallLayout(planned, inventory, 96)
    expect(analysis.valid).toBe(true)
    expect(analysis.operationalRackUnitIds).toHaveLength(96)
  })

  it('validates a 960-rack large hall without dropping rack identity', () => {
    const inventory = Array.from({ length: 960 }, (_, index) => ({ unitId: `u${String(index).padStart(4, '0')}`, skuId: 'rack_h100', mw: 0.01, networkGbps: 100, delivered: true }))
    const layout = createDefaultHallLayout('hall', 'hall-large-v1', inventory, 960)
    expect(layout.objects.filter((entry) => entry.kind === 'rack')).toHaveLength(960)
    expect(layout.analysis.valid).toBe(true)
    expect(layout.analysis.operationalRackUnitIds).toHaveLength(960)
  })

  it('weights player PUE from player-owned halls only', () => {
    let state = createGame({ seed: 812, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const facility = [...state.map.world!.facilitiesById.values()].find((entry) => entry.kind === 'dc')!
    state.map.world!.beginBatch().updateFacility(facility.id, { ownerId: state.playerLabId }).commit()
    const playerLayout = createDefaultHallLayout(facility.id, 'hall-small-v1', [], 96)
    playerLayout.analysis = { ...playerLayout.analysis, operationalRackUnitIds: ['player-rack'], pueMultiplier: 1.2 }
    const rivalLayout = createDefaultHallLayout('rival-or-orphan-hall', 'hall-small-v1', [], 96)
    rivalLayout.analysis = { ...rivalLayout.analysis, operationalRackUnitIds: ['rival-rack'], pueMultiplier: 2 }
    state = { ...state, dataHallLayouts: { [facility.id]: playerLayout, [rivalLayout.facilityId]: rivalLayout } }
    expect(playerHallPueMultiplier(state)).toBeCloseTo(1.2)
  })

  it('migrates stable rack-unit IDs and layouts into a new campaign', () => {
    const original = createGame({ seed: 81, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const withoutLayouts = { ...original, dataHallLayouts: undefined }
    const migrated = migrateDataHallLayouts(withoutLayouts)
    expect(Object.keys(migrated.dataHallLayouts ?? {}).length).toBeGreaterThan(0)
    expect(migrated.rivals.every((rival) => (rival.rackFleet ?? []).every((install) => install.unitIds?.length === install.count))).toBe(true)
  })

  it('applies an affordable revision-matched plan atomically', () => {
    let state = createGame({ seed: 82, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const facility = [...state.map.world!.facilitiesById.values()].find((entry) => entry.kind === 'dc')!
    state.map.world!.beginBatch().updateFacility(facility.id, { ownerId: state.playerLabId }).commit()
    state = migrateDataHallLayouts({ ...state, dataHallLayouts: undefined, player: { ...state.player, cash: 50_000_000 } })
    const layout = state.dataHallLayouts![facility.id]!
    const inventory = rackUnitsForFacility(state, facility.id, state.playerLabId)
    expect(inventory).toHaveLength(0)
    const wall = createWall('new-wall', 10, 10, 30, 10)
    const result = applyHallPlan(state, {
      facilityId: facility.id,
      expectedRevision: layout.revision,
      objects: layout.objects.filter((entry) => entry.kind !== 'rack'),
      walls: [wall],
      doors: [],
    })
    expect(result.ok).toBe(true)
    expect(result.state.dataHallLayouts![facility.id]!.revision).toBe(layout.revision + 1)
    expect(result.state.player.cash).toBe(state.player.cash - wall.purchasePrice)
  })

  it('returns half the purchase price when applied infrastructure is removed', () => {
    let state = createGame({ seed: 820, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const facility = [...state.map.world!.facilitiesById.values()].find((entry) => entry.kind === 'dc')!
    state.map.world!.beginBatch().updateFacility(facility.id, { ownerId: state.playerLabId }).commit()
    state = migrateDataHallLayouts({ ...state, dataHallLayouts: undefined, player: { ...state.player, cash: 50_000_000 } })
    const layout = state.dataHallLayouts![facility.id]!
    const wall = createWall('refundable-wall', 20, 20, 30, 20)
    const built = applyHallPlan(state, {
      facilityId: facility.id,
      expectedRevision: layout.revision,
      objects: layout.objects,
      walls: [...layout.walls, wall],
      doors: layout.doors,
    })
    expect(built.ok).toBe(true)
    const result = applyHallPlan(built.state, {
      facilityId: facility.id,
      expectedRevision: layout.revision + 1,
      objects: layout.objects,
      walls: layout.walls,
      doors: layout.doors,
    })
    expect(result.ok).toBe(true)
    expect(result.netCost).toBe(-Math.floor(wall.purchasePrice * 0.5))
    expect(result.state.player.cash).toBe(state.player.cash - wall.purchasePrice + Math.floor(wall.purchasePrice * 0.5))
  })

  it('excludes staged and disconnected rack units from player compute', () => {
    let state = createGame({ seed: 83, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const facility = [...state.map.world!.facilitiesById.values()].find((entry) => entry.kind === 'dc')!
    const { x, y } = tileCoords(facility.anchor, state.map.width)
    state.map.world!.beginBatch().updateFacility(facility.id, { ownerId: state.playerLabId }).commit()
    state = migrateDataHallLayouts({
      ...state,
      dataHallLayouts: undefined,
      player: {
        ...state.player,
        rackFleet: [{
          id: 'spatial-rack', skuId: 'rack_h100', facilityId: facility.id,
          x, y, count: 1, unitIds: ['spatial-rack-unit'], rackUnits: 1,
          status: 'live', daysLeft: 0, paidEach: 1,
        }],
      },
    })
    expect(fleetStats(state).designs.find((entry) => entry.designId === 'rack_h100')?.count).toBe(1)
    const layout = state.dataHallLayouts![facility.id]!
    state = {
      ...state,
      dataHallLayouts: {
        ...state.dataHallLayouts,
        [facility.id]: {
          ...layout,
          revision: layout.revision + 1,
          objects: layout.objects.filter((object) => object.kind !== 'rack'),
          analysis: analyzeHallLayout({ ...layout, revision: layout.revision + 1, objects: layout.objects.filter((object) => object.kind !== 'rack') }, rackUnitsForFacility(state, facility.id, state.playerLabId), facility.stats?.rackCapacity ?? 96),
        },
      },
    }
    expect(fleetStats(state).designs.find((entry) => entry.designId === 'rack_h100')).toBeUndefined()
  })
})

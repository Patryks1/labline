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
  quoteHallPlanNetCost,
  rackUnitsForFacility,
} from './dataHallLayouts'

const rack = (id: string, x: number, z: number): DataHallObjectPlacement => ({
  id: `rack:${id}`, kind: 'rack', catalogId: 'rack_h100', rackUnitId: id,
  x, z, rotation: 0, purchasePrice: 0,
})

const reservedRack = (id: string, x: number, z: number): DataHallObjectPlacement => ({
  id: `reserved:${id}`, kind: 'rack', catalogId: 'rack_h100', reserved: true,
  x, z, rotation: 0, purchasePrice: 0,
})

describe('free-placement data hall layouts', () => {
  it('quotes infrastructure additions and half-value removals', () => {
    const base = createDefaultHallLayout('quote-hall', 'hall-small-v1', [], 96)
    const wall = createWall('quoted-wall', 12, 12, 20, 12)
    expect(quoteHallPlanNetCost(base, { ...base, walls: [wall] })).toBe(wall.purchasePrice)
    expect(quoteHallPlanNetCost(base, { ...base, walls: [{ ...wall, purchasePrice: 0 }] })).toBe(wall.purchasePrice)
    expect(quoteHallPlanNetCost({ ...base, walls: [wall] }, base)).toBe(-Math.floor(wall.purchasePrice * 0.5))
  })

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

  it('accepts reserved cabinets without inventory identity and gives them no operational contribution', () => {
    const base = createDefaultHallLayout('reserved-hall', 'hall-small-v1', [], 96)
    const result = analyzeHallLayout({ ...base, objects: [...base.objects, reservedRack('future-1', 20, 20)] }, [], 96)

    expect(result.valid).toBe(true)
    expect(result.hardErrors.some((error) => error.includes('owned rack unit'))).toBe(false)
    expect(result.operationalRackUnitIds).toEqual([])
    expect(result.offlineRackUnitIds).toEqual([])
    expect(result.powerRoutes).toEqual([])
    expect(result.networkRoutes).toEqual([])
  })

  it('rejects a reserved cabinet that also claims an inventory rack unit', () => {
    const inventory = [{ unitId: 'owned-1', skuId: 'rack_h100', mw: 0.01, networkGbps: 100, delivered: true }]
    const base = createDefaultHallLayout('reserved-identity', 'hall-small-v1', [], 96)
    const contradictory = { ...reservedRack('future-1', 20, 20), rackUnitId: 'owned-1' }
    const result = analyzeHallLayout({ ...base, objects: [...base.objects, contradictory] }, inventory, 96)

    expect(result.valid).toBe(false)
    expect(result.hardErrors).toContain('reserved:future-1 cannot be both reserved and assigned to rack unit owned-1.')
    expect(result.operationalRackUnitIds).toEqual([])
    expect(result.powerRoutes).toEqual([])
    expect(result.networkRoutes).toEqual([])
  })

  it('counts reserved cabinets against physical hall capacity', () => {
    const base = createDefaultHallLayout('reserved-capacity', 'hall-small-v1', [], 1)
    const result = analyzeHallLayout({
      ...base,
      objects: [...base.objects, reservedRack('future-1', 20, 20), reservedRack('future-2', 40, 20)],
    }, [], 1)

    expect(result.valid).toBe(false)
    expect(result.hardErrors).toContain('Layout has 2 racks but this shell is rated for 1.')
  })

  it('applies physical collision rules to reserved cabinets', () => {
    const base = createDefaultHallLayout('reserved-collision', 'hall-small-v1', [], 2)
    const result = analyzeHallLayout({
      ...base,
      objects: [...base.objects, reservedRack('future-1', 20, 20), reservedRack('future-2', 21, 21)],
    }, [], 2)

    expect(result.valid).toBe(false)
    expect(result.hardErrors.some((error) => error.includes('overlaps'))).toBe(true)
  })

  it('replaces a matching reserved cabinet on delivery while preserving unused planned cabinets', () => {
    const base = createDefaultHallLayout('delivery-hall', 'hall-small-v1', [], 3)
    const placeholders = Array.from({ length: 3 }, (_, index) => ({
      unitId: `placeholder-${index + 1}`, skuId: 'rack_h100', mw: 0.01, networkGbps: 100, delivered: true,
    }))
    const capacityPlan = autoPlanHall(base, placeholders, 'efficiency', 3)
    const plannedCabinets = capacityPlan.objects.filter((object) => object.kind === 'rack').map((object, index) => ({
      ...object,
      id: `saved-reservation-${index + 1}`,
      rackUnitId: undefined,
      reserved: true,
    }))
    const saved = { ...capacityPlan, objects: [...capacityPlan.objects.filter((object) => object.kind !== 'rack'), ...plannedCabinets] }
    const delivered = [{ unitId: 'delivered-1', skuId: 'rack_h100', mw: 0.01, networkGbps: 100, delivered: true }]

    const replanned = autoPlanHall(saved, delivered, 'efficiency', 3)
    const actual = replanned.objects.find((object) => object.rackUnitId === 'delivered-1')!
    const reservations = replanned.objects.filter((object) => object.kind === 'rack' && object.reserved)

    expect({ x: actual.x, z: actual.z, rotation: actual.rotation }).toEqual({
      x: plannedCabinets[0]!.x,
      z: plannedCabinets[0]!.z,
      rotation: plannedCabinets[0]!.rotation,
    })
    expect(reservations.map((object) => object.id)).toEqual(plannedCabinets.slice(1).map((object) => object.id))
    expect(replanned.objects.filter((object) => object.kind === 'rack')).toHaveLength(3)
    expect(analyzeHallLayout(replanned, delivered, 3).valid).toBe(true)
  })

  it('preserves a moved installed rack while assigning a delivery to the next reservation', () => {
    const base = createDefaultHallLayout('moved-delivery-hall', 'hall-small-v1', [], 3)
    const seedInventory = Array.from({ length: 3 }, (_, index) => ({
      unitId: `seed-${index + 1}`, skuId: 'rack_h100', mw: 0.01, networkGbps: 100, delivered: true,
    }))
    const capacityPlan = autoPlanHall(base, seedInventory, 'efficiency', 3)
    const plannedCabinets = capacityPlan.objects.filter((object) => object.kind === 'rack')
    const movedInstalled: DataHallObjectPlacement = {
      ...plannedCabinets[0]!,
      id: 'rack:installed-1',
      rackUnitId: 'installed-1',
      x: 60,
      z: 40,
      rotation: 90,
    }
    const reservations = plannedCabinets.slice(1).map((object, index) => ({
      ...object,
      id: `moved-saved-reservation-${index + 1}`,
      rackUnitId: undefined,
      reserved: true,
    }))
    const saved = {
      ...capacityPlan,
      objects: [...capacityPlan.objects.filter((object) => object.kind !== 'rack'), movedInstalled, ...reservations],
    }
    const delivered = [
      { unitId: 'installed-1', skuId: 'rack_h100', mw: 0.01, networkGbps: 100, delivered: true },
      { unitId: 'new-delivery', skuId: 'rack_h100', mw: 0.01, networkGbps: 100, delivered: true },
    ]

    const replanned = autoPlanHall(saved, delivered, 'efficiency', 3)
    const installed = replanned.objects.find((object) => object.rackUnitId === 'installed-1')
    const added = replanned.objects.find((object) => object.rackUnitId === 'new-delivery')

    expect(installed).toEqual(movedInstalled)
    expect({ x: added?.x, z: added?.z, rotation: added?.rotation }).toEqual({
      x: reservations[0]!.x,
      z: reservations[0]!.z,
      rotation: reservations[0]!.rotation,
    })
    expect(replanned.objects.filter((object) => object.reserved).map((object) => object.id)).toEqual([reservations[1]!.id])
    expect(analyzeHallLayout(replanned, delivered, 3).valid).toBe(true)

    const preview = autoPlanHall(saved, delivered, 'efficiency', 3, { provisionUtilities: true })
    const previewInstalled = preview.objects.find((object) => object.rackUnitId === 'installed-1')
    expect({ x: previewInstalled?.x, z: previewInstalled?.z, rotation: previewInstalled?.rotation }).not.toEqual({
      x: movedInstalled.x,
      z: movedInstalled.z,
      rotation: movedInstalled.rotation,
    })
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

  it.each(['density', 'efficiency', 'resilience'] as const)('plans a valid %s layout around an interior wall', (strategy) => {
    const inventory = Array.from({ length: 24 }, (_, index) => ({ unitId: `wall-${index}`, skuId: 'rack_h100', mw: 0.01, networkGbps: 100, delivered: true }))
    const base = createDefaultHallLayout('wall-hall', 'hall-small-v1', [], 96)
    const wall = createWall('interior-wall', 10, 7, 10, 65)
    const planned = autoPlanHall({ ...base, walls: [wall] }, inventory, strategy, 96)
    const plannedRacks = planned.objects.filter((entry) => entry.kind === 'rack')

    expect(plannedRacks).toHaveLength(inventory.length)
    expect(plannedRacks.every((entry) => !(entry.x < wall.x1 && entry.x + 3 > wall.x1))).toBe(true)
    const analysis = analyzeHallLayout(planned, inventory, 96)
    expect(analysis.valid).toBe(true)
    expect(analysis.hardErrors.some((error) => error.includes(`wall ${wall.id}`))).toBe(false)
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
    expect(result.state.labs[state.playerLabId]!.cash).toBe(result.state.player.cash)
    expect(result.state.labs[state.playerLabId]!.finance.cash).toBe(result.state.player.cash)
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

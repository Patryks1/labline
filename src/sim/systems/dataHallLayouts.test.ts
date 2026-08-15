import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { DataHallObjectPlacement, HallAutoLayoutStrategy, RackSku, SimState } from '../types'
import { tileCoords } from '../world'
import { fleetStats, resolveRackSku } from './racks'
import { computeLabSnapshot, syncLabIndex } from './labEngine'
import { fullOrderCatalog, strategyRackSku, tickRackDeliveries } from './dcRacks'
import {
  analyzeHallLayout,
  applyHallPlan,
  autoPlanHall,
  createDefaultHallLayout,
  createEmptyHallLayout,
  createWall,
  migrateDataHallLayouts,
  playerHallPueMultiplier,
  previewHallObjectPlacement,
  provisionHallUtilities,
  quoteHallPlanNetCost,
  quoteHallRackPurchases,
  rackUnitsForFacility,
  repairHallLayouts,
  tickDataHallLayouts,
  type HallRackUnit,
} from './dataHallLayouts'

const rack = (id: string, x: number, z: number): DataHallObjectPlacement => ({
  id: `rack:${id}`, kind: 'rack', catalogId: 'rack_h100', rackUnitId: id,
  x, z, rotation: 0, purchasePrice: 0,
})

const reservedRack = (id: string, x: number, z: number): DataHallObjectPlacement => ({
  id: `reserved:${id}`, kind: 'rack', catalogId: 'rack_h100', reserved: true,
  x, z, rotation: 0, purchasePrice: 0,
})

const equipment = (
  id: string,
  kind: 'power' | 'cooling' | 'network',
  catalogId: string,
  x: number,
  z: number,
): DataHallObjectPlacement => ({ id, kind, catalogId, x, z, rotation: 0, purchasePrice: 0 })

function finishHallProject(state: SimState, facilityId: string): SimState {
  let next = state
  const days = next.dataHallLayouts?.[facilityId]?.constructionProject?.totalDays ?? 0
  for (let day = 0; day < days; day += 1) next = tickDataHallLayouts(next)
  return next
}

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
    const door = analyzeHallLayout({ ...base, objects: [...base.objects, rack('u1', 34, 0)] }, inventory, 96)
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

  it('blocks utility routes at walls and restores them only through a door', () => {
    const inventory = [{ unitId: 'topology-rack', skuId: 'rack_h100', mw: 0.25, networkGbps: 400, delivered: true }]
    const base = createDefaultHallLayout('topology-hall', 'hall-small-v1', [], 96)
    const objects = [
      equipment('power-left', 'power', 'pdu-2mw', 4, 18),
      equipment('cooling-left', 'cooling', 'crac-2mw', 12, 18),
      equipment('network-left', 'network', 'core-6t', 22, 18),
      rack('topology-rack', 50, 18),
    ]
    const divider = createWall('sealed-divider', 30, 0, 30, 52)
    const sealed = analyzeHallLayout({ ...base, objects, walls: [divider], doors: [] }, inventory, 96)
    expect(sealed.operationalRackUnitIds).toEqual([])
    expect(sealed.offlineRackUnitIds).toEqual(['topology-rack'])
    expect(sealed.inaccessibleObjectIds).toEqual(expect.arrayContaining(['power-left', 'cooling-left', 'network-left']))

    const opened = analyzeHallLayout({
      ...base,
      objects,
      walls: [divider],
      doors: [{ id: 'service-door', wallId: divider.id, offset: 0.5, width: 4, purchasePrice: 0 }],
    }, inventory, 96)
    expect(opened.operationalRackUnitIds).toEqual(['topology-rack'])
    expect(opened.powerRoutes[0]!.cells.length).toBeGreaterThan(1)
    expect(opened.coolingRoutes[0]!.cells.length).toBeGreaterThan(1)
    expect(opened.networkRoutes[0]!.cells.length).toBeGreaterThan(1)
    expect(opened.inaccessibleObjectIds).toEqual([])
  })

  it('requires spatially local cooling rather than pooling all hall cooling', () => {
    const inventory = [{ unitId: 'hot-rack', skuId: 'rack_h100', mw: 0.25, networkGbps: 400, delivered: true }]
    const base = createDefaultHallLayout('thermal-hall', 'hall-small-v1', [], 96)
    const common = [
      equipment('power-near', 'power', 'pdu-2mw', 50, 32),
      equipment('network-near', 'network', 'core-6t', 46, 40),
      rack('hot-rack', 60, 42),
    ]
    const distantInRow = analyzeHallLayout({
      ...base,
      objects: [equipment('cooling-far', 'cooling', 'inrow-350kw', 2, 8), ...common],
    }, inventory, 96)
    expect(distantInRow.coolingHeadroomMw).toBeCloseTo(0.1)
    expect(distantInRow.coolingRoutes).toEqual([])
    expect(distantInRow.operationalRackUnitIds).toEqual([])
    expect(distantInRow.coolingScore).toBe(0)

    const distantCrac = analyzeHallLayout({
      ...base,
      objects: [equipment('cooling-far', 'cooling', 'crac-2mw', 2, 8), ...common],
    }, inventory, 96)
    expect(distantCrac.coolingRoutes).toHaveLength(1)
    expect(distantCrac.operationalRackUnitIds).toEqual(['hot-rack'])
  })

  it('hard-disables inaccessible and repairing equipment while reporting service health', () => {
    const inventory = [{ unitId: 'service-rack', skuId: 'rack_h100', mw: 0.25, networkGbps: 400, delivered: true }]
    const base = createDefaultHallLayout('service-hall', 'hall-small-v1', [], 96)
    const failedPower = { ...equipment('power-repair', 'power', 'pdu-2mw', 8, 18), repairDaysRemaining: 2 }
    const objects = [
      failedPower,
      equipment('cooling-live', 'cooling', 'crac-2mw', 18, 18),
      equipment('network-live', 'network', 'core-6t', 30, 18),
      rack('service-rack', 56, 18),
    ]
    const result = analyzeHallLayout({ ...base, objects }, inventory, 96)
    expect(result.operationalRackUnitIds).toEqual([])
    expect(result.powerRoutes).toEqual([])
    expect(result.maintenanceScore).toBeLessThan(1)
    expect(result.bottlenecks.some((entry) => entry.kind === 'maintenance')).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('during repair'))).toBe(true)
  })

  it('scores N+1 utility headroom and alternate reachable sources', () => {
    const inventory = [{ unitId: 'redundant-rack', skuId: 'rack_h100', mw: 0.25, networkGbps: 400, delivered: true }]
    const base = createDefaultHallLayout('redundant-hall', 'hall-small-v1', [], 96)
    const objects = [
      equipment('power-a', 'power', 'pdu-2mw', 8, 12), equipment('power-b', 'power', 'pdu-2mw', 8, 28),
      equipment('cool-a', 'cooling', 'inrow-350kw', 22, 12), equipment('cool-b', 'cooling', 'inrow-350kw', 22, 28),
      equipment('network-a', 'network', 'core-6t', 34, 12), equipment('network-b', 'network', 'core-6t', 34, 28),
      rack('redundant-rack', 52, 20),
    ]
    const result = analyzeHallLayout({ ...base, objects }, inventory, 96)
    expect(result.operationalRackUnitIds).toEqual(['redundant-rack'])
    expect(result.redundantRackUnitIds).toEqual(['redundant-rack'])
    expect(result.redundancyScore).toBe(1)
    expect(result.powerHeadroomMw).toBeCloseTo(3.75)
    expect(result.coolingHeadroomMw).toBeCloseTo(0.45)
    expect(result.networkHeadroomGbps).toBe(12_400)
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

  it('ignores the legacy bay rating when non-overlapping cabinets physically fit', () => {
    const base = createDefaultHallLayout('reserved-capacity', 'hall-small-v1', [], 1)
    const result = analyzeHallLayout({
      ...base,
      objects: [...base.objects, reservedRack('future-1', 20, 20), reservedRack('future-2', 40, 20)],
    }, [], 1)

    expect(result.valid).toBe(true)
    expect(result.hardErrors.some((error) => error.includes('shell is rated'))).toBe(false)
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
    const wall = createWall('interior-wall', 10, 7, 10, 45)
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
    expect(planned.objects.filter((entry) => entry.kind === 'power').length).toBeGreaterThanOrEqual(2)
    expect(planned.objects.filter((entry) => entry.kind === 'cooling').length).toBeGreaterThanOrEqual(2)
    expect(planned.objects.filter((entry) => entry.kind === 'network').length).toBeGreaterThanOrEqual(2)
    expect(planned.objects.some((entry) => entry.id.includes(':auto-plan:') && entry.purchasePrice > 0)).toBe(true)
    const analysis = analyzeHallLayout(planned, inventory, 96)
    expect(analysis.valid).toBe(true)
    expect(analysis.operationalRackUnitIds).toHaveLength(24)
  })

  it.each([
    ['small', 'hall-small-v1', 120],
    ['medium', 'hall-medium-v1', 220],
    ['large', 'hall-large-v1', 400],
  ] as const)('provisions spatial cooling and only promises operational racks in a full %s shell', (_label, shellId, capacity) => {
    const inventory = Array.from({ length: capacity }, (_, index) => ({
      unitId: `full-${shellId}-${index}`,
      skuId: 'rack_h100',
      mw: 0.0143,
      networkGbps: 400,
      delivered: true,
      flopsPf: 1,
      rackUnits: 1,
      price: 1,
    }))
    const base = createEmptyHallLayout(`coverage-${shellId}`, shellId, capacity)
    const planned = autoPlanHall(base, inventory, 'efficiency', capacity, { provisionUtilities: true })
    const racks = planned.objects.filter((entry) => entry.kind === 'rack' && !entry.reserved)
    const cooling = planned.objects.filter((entry) => entry.kind === 'cooling')
    const analysis = analyzeHallLayout(planned, inventory, capacity)

    expect(racks.length).toBeGreaterThan(0)
    expect(analysis.offlineRackUnitIds).toEqual([])
    expect(analysis.operationalRackUnitIds).toHaveLength(racks.length)
    expect(new Set(cooling.map((entry) => entry.x)).size).toBeGreaterThan(1)
    expect(new Set(cooling.map((entry) => `${entry.x},${entry.z}`)).size).toBe(cooling.length)
    if (shellId === 'hall-large-v1') expect(racks).toHaveLength(400)
  })

  it('places a rated 96-rack small hall with the efficiency strategy', () => {
    const inventory = Array.from({ length: 96 }, (_, index) => ({ unitId: `u${index}`, skuId: 'rack_h100', mw: 0.01, networkGbps: 100, delivered: true }))
    const base = createDefaultHallLayout('hall', 'hall-small-v1', [], 96)
    const planned = autoPlanHall(base, inventory, 'efficiency', 96)
    expect(planned.objects.filter((entry) => entry.kind === 'rack')).toHaveLength(96)
  })

  it('limits a resilience plan by utility footprints rather than a legacy bay rating', () => {
    const inventory = Array.from({ length: 96 }, (_, index) => ({ unitId: `full-${index}`, skuId: 'rack_h100', mw: 0.012, networkGbps: 400, delivered: true }))
    const base = createDefaultHallLayout('full-preview', 'hall-small-v1', [], 96)
    const planned = autoPlanHall(base, inventory, 'resilience', 96, { provisionUtilities: true })
    expect(planned.objects.filter((entry) => entry.kind === 'rack')).toHaveLength(69)
    const analysis = analyzeHallLayout(planned, inventory, 96)
    expect(analysis.valid).toBe(true)
    expect(analysis.operationalRackUnitIds).toHaveLength(69)
  })

  it.each([
    ['small', 'hall-small-v1', 95],
    ['medium', 'hall-medium-v1', 312],
    ['large', 'hall-large-v1', 796],
  ] as const)('derives the dense %s hall limit from floor and utility geometry', (_label, shellId, maximum) => {
    const inventory = Array.from({ length: maximum + 1 }, (_, index) => ({
      unitId: `dense-${shellId}-${String(index).padStart(4, '0')}`,
      skuId: 'rack_h100',
      mw: 0.0102,
      networkGbps: 900,
      delivered: true,
      flopsPf: 7.912,
      rackUnits: 1,
      price: 180_500,
    }))
    const fitting = autoPlanHall(
      createEmptyHallLayout(`dense-fit-${shellId}`, shellId),
      inventory.slice(0, maximum),
      'density',
      1,
      { provisionUtilities: true },
    )
    const overflow = autoPlanHall(
      createEmptyHallLayout(`dense-overflow-${shellId}`, shellId),
      inventory,
      'density',
      Number.MAX_SAFE_INTEGER,
      { provisionUtilities: true },
    )
    const analysis = analyzeHallLayout(fitting, inventory.slice(0, maximum), 1)

    expect(fitting.objects.filter((entry) => entry.kind === 'rack')).toHaveLength(maximum)
    expect(analysis.operationalRackUnitIds).toHaveLength(maximum)
    expect(analysis.offlineRackUnitIds).toEqual([])
    expect(overflow.objects.filter((entry) => entry.kind === 'rack').length).toBeLessThan(maximum + 1)
  })

  it('uses more physical cooling and power plant for higher-draw racks', () => {
    const units = (mw: number) => Array.from({ length: 24 }, (_, index) => ({
      unitId: `draw-${mw}-${index}`,
      skuId: 'rack_h100',
      mw,
      networkGbps: 100,
      delivered: true,
      flopsPf: 1,
      rackUnits: 1,
      price: 1,
    }))
    const low = autoPlanHall(createEmptyHallLayout('low-draw', 'hall-small-v1'), units(0.01), 'density', 1, { provisionUtilities: true })
    const high = autoPlanHall(createEmptyHallLayout('high-draw', 'hall-small-v1'), units(0.35), 'density', 1, { provisionUtilities: true })
    const count = (layout: typeof low, kind: 'power' | 'cooling') => layout.objects.filter((object) => object.kind === kind).length

    expect(count(high, 'power')).toBeGreaterThan(count(low, 'power'))
    expect(count(high, 'cooling')).toBeGreaterThan(count(low, 'cooling'))
    expect(analyzeHallLayout(high, units(0.35), 1).offlineRackUnitIds).toEqual([])
  })

  it('grandfathers an old out-of-bounds layout without moving or deleting objects', () => {
    const state = createGame({ seed: 892, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const legacyObject = reservedRack('legacy-edge', 84, 60)
    const oldLayout = {
      ...createEmptyHallLayout('legacy-overflow', 'hall-small-v1'),
      objects: [legacyObject],
    }
    const migrated = migrateDataHallLayouts({
      ...state,
      dataHallLayouts: { ...(state.dataHallLayouts ?? {}), [oldLayout.facilityId]: oldLayout },
    })
    const preserved = migrated.dataHallLayouts![oldLayout.facilityId]!

    expect(preserved.shellId).toBe('hall-small-v1-legacy')
    expect(preserved.objects).toEqual([legacyObject])
    expect(analyzeHallLayout(preserved, [], 1).valid).toBe(true)
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

  it('pays for and queues an affordable revision-matched ghost plan', () => {
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
    const queued = result.state.dataHallLayouts![facility.id]!
    expect(queued.revision).toBe(layout.revision)
    expect(queued.walls).not.toContainEqual(wall)
    expect(queued.constructionProject?.targetRevision).toBe(layout.revision + 1)
    expect(queued.constructionProject?.targetWalls).toContainEqual(wall)
    expect(queued.constructionProject?.totalDays).toBeGreaterThanOrEqual(3)
    expect(queued.constructionProject?.totalDays).toBeLessThanOrEqual(14)
    expect(result.state.player.cash).toBe(state.player.cash - wall.purchasePrice)
    expect(result.state.labs[state.playerLabId]!.cash).toBe(result.state.player.cash)
    expect(result.state.labs[state.playerLabId]!.finance.cash).toBe(result.state.player.cash)
  })

  it('defers demolition salvage until the removal project commissions', () => {
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
    const liveBuilt = finishHallProject(built.state, facility.id)
    expect(liveBuilt.dataHallLayouts![facility.id]!.walls).toContainEqual(wall)
    const result = applyHallPlan(liveBuilt, {
      facilityId: facility.id,
      expectedRevision: layout.revision + 1,
      objects: layout.objects,
      walls: layout.walls,
      doors: layout.doors,
    })
    expect(result.ok).toBe(true)
    expect(result.netCost).toBe(-Math.floor(wall.purchasePrice * 0.5))
    expect(result.state.player.cash).toBe(state.player.cash - wall.purchasePrice)
    const demolished = finishHallProject(result.state, facility.id)
    expect(demolished.player.cash).toBe(state.player.cash - wall.purchasePrice + Math.floor(wall.purchasePrice * 0.5))
    expect(demolished.dataHallLayouts![facility.id]!.walls).not.toContainEqual(wall)
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

describe('rack purchase drafts and provisioning', () => {
  const draftRack = (id: string, x: number, z: number): DataHallObjectPlacement => ({
    id: `draft:${id}`, kind: 'rack', catalogId: 'rack_h100',
    x, z, rotation: 0, purchasePrice: 165_000,
  })

  const withInboundRackReservation = (seed: number, count = 160) => {
    let state = createGame({ seed, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const facility = [...state.map.world!.facilitiesById.values()].find((entry) => entry.kind === 'dc')!
    const { x, y } = tileCoords(facility.anchor, state.map.width)
    state.map.world!.beginBatch().updateFacility(facility.id, { ownerId: state.playerLabId }).commit()
    state = migrateDataHallLayouts({
      ...state,
      dataHallLayouts: undefined,
      player: { ...state.player, cash: 500_000_000, rackFleet: [] },
    })
    const installId = 'inbound-capacity-order'
    state = {
      ...state,
      player: {
        ...state.player,
        rackFleet: [{
          id: installId, skuId: 'rack_h100', facilityId: facility.id,
          x, y, count, status: 'ordered', daysLeft: 5, paidEach: 165_000,
          rackUnits: 1,
          unitIds: Array.from({ length: count }, (_, index) => `${installId}:unit:${String(index + 1).padStart(4, '0')}`),
        }],
      },
    }
    return {
      state,
      facility,
      layout: state.dataHallLayouts![facility.id]!,
      rackCapacity: facility.stats?.rackCapacity ?? 160,
      representedUnitId: state.player.rackFleet[0]!.unitIds![0]!,
    }
  }

  it('accepts purchase drafts without inventory identity', () => {
    const base = createDefaultHallLayout('draft-hall', 'hall-small-v1', [], 96)
    const result = analyzeHallLayout({ ...base, objects: [...base.objects, draftRack('new-1', 20, 20)] }, [], 96)
    expect(result.valid).toBe(true)
    expect(result.operationalRackUnitIds).toEqual([])
    expect(result.offlineRackUnitIds).toEqual([])
  })

  it('provisions utilities append-only without moving existing objects', () => {
    const placed = { ...rack('u1', 20, 20) }
    const inventory = [{ unitId: 'u1', skuId: 'rack_h100', mw: 0.25, networkGbps: 400, delivered: true }]
    const base = { ...createDefaultHallLayout('provision-hall', 'hall-small-v1', [], 96), objects: [placed] }
    const provisioned = provisionHallUtilities(base, inventory, 96)
    expect(provisioned.added.length).toBeGreaterThan(0)
    expect(provisioned.cost).toBeGreaterThan(0)
    expect(provisioned.added.every((object) => object.kind !== 'rack')).toBe(true)
    // Existing object untouched.
    const stillThere = provisioned.layout.objects.find((object) => object.id === placed.id)!
    expect({ x: stillThere.x, z: stillThere.z }).toEqual({ x: 20, z: 20 })
    const analysis = analyzeHallLayout(provisioned.layout, inventory, 96)
    expect(analysis.valid).toBe(true)
    expect(analysis.operationalRackUnitIds).toContain('u1')
  })

  it('lets inbound hardware remain staged while a new physical purchase draft is placed', () => {
    const { state, facility, layout, rackCapacity } = withInboundRackReservation(87)
    expect(rackCapacity).toBe(160)
    const planObjects = [
      ...layout.objects.filter((entry) => entry.kind !== 'rack'),
      draftRack('overbooked', 20, 20),
    ]
    const quote = quoteHallRackPurchases(
      state,
      { facilityId: facility.id, shellId: layout.shellId, objects: planObjects, walls: layout.walls, doors: layout.doors },
      { rackCapacity },
    )
    expect(quote).toMatchObject({
      drafts: 1,
      targetRackCabinets: 1,
      targetRackBays: 1,
      stagedFleetRackBays: 160,
    })

    const result = applyHallPlan(state, {
      facilityId: facility.id,
      expectedRevision: layout.revision,
      objects: planObjects,
      walls: layout.walls,
      doors: layout.doors,
    })
    expect(result.ok).toBe(true)
    expect(result.state.player.rackFleet.reduce((sum, install) => sum + install.count, 0)).toBe(161)
  })

  it('does not double count an inbound rack that is represented in the target', () => {
    const { state, facility, layout, rackCapacity, representedUnitId } = withInboundRackReservation(88)
    const representedRack: DataHallObjectPlacement = {
      ...draftRack('represented', 20, 20),
      rackUnitId: representedUnitId,
    }
    const planObjects = [
      ...layout.objects.filter((entry) => entry.kind !== 'rack'),
      representedRack,
    ]
    const quote = quoteHallRackPurchases(
      state,
      { facilityId: facility.id, shellId: layout.shellId, objects: planObjects, walls: layout.walls, doors: layout.doors },
      { rackCapacity },
    )
    expect(quote).toMatchObject({
      drafts: 0,
      targetRackCabinets: 1,
      targetRackBays: 1,
      stagedFleetRackBays: 159,
    })

    const result = applyHallPlan(state, {
      facilityId: facility.id,
      expectedRevision: layout.revision,
      objects: planObjects,
      walls: layout.walls,
      doors: layout.doors,
    })
    expect(result.ok).toBe(true)
    expect(result.state.player.rackFleet.reduce((sum, install) => sum + install.count, 0)).toBe(160)
    expect(result.state.dataHallLayouts![facility.id]!.constructionProject?.targetObjects).toContainEqual(representedRack)
  })

  it('buys purchase drafts on apply but keeps them ghosted until commissioning', () => {
    let state = createGame({ seed: 84, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const facility = [...state.map.world!.facilitiesById.values()].find((entry) => entry.kind === 'dc')!
    state.map.world!.beginBatch().updateFacility(facility.id, { ownerId: state.playerLabId }).commit()
    state = migrateDataHallLayouts({ ...state, dataHallLayouts: undefined, player: { ...state.player, cash: 500_000_000 } })
    const layout = state.dataHallLayouts![facility.id]!
    const rackCapacity = facility.stats?.rackCapacity ?? 96
    const planObjects = [
      ...layout.objects.filter((entry) => entry.kind !== 'rack'),
      draftRack('buy-1', 20, 20),
      draftRack('buy-2', 27, 20),
    ]
    const quote = quoteHallRackPurchases(
      state,
      { facilityId: facility.id, shellId: layout.shellId, objects: planObjects, walls: layout.walls, doors: layout.doors },
      { rackCapacity },
    )
    expect(quote.drafts).toBe(2)
    expect(quote.total).toBeGreaterThan(0)

    const cashBefore = state.player.cash
    const result = applyHallPlan(state, {
      facilityId: facility.id,
      expectedRevision: layout.revision,
      objects: planObjects,
      walls: layout.walls,
      doors: layout.doors,
    })
    expect(result.ok).toBe(true)
    expect(result.netCost).toBe(quote.total)
    expect(result.state.player.cash).toBe(cashBefore - quote.total)

    // Drafts became ordered fleet units linked into the layout.
    const ordered = result.state.player.rackFleet.filter((install) => install.status === 'ordered')
    expect(ordered.reduce((sum, install) => sum + install.count, 0)).toBe(2)
    const liveRacks = result.state.dataHallLayouts![facility.id]!.objects.filter((object) => object.kind === 'rack' && !object.reserved)
    expect(liveRacks).toHaveLength(0)
    const targetRacks = result.state.dataHallLayouts![facility.id]!.constructionProject!.targetObjects.filter((object) => object.kind === 'rack' && !object.reserved)
    expect(targetRacks).toHaveLength(2)
    expect(targetRacks.every((object) => Boolean(object.rackUnitId))).toBe(true)
    // Utilities cover the new racks (default hall gear is enough for two).
    // Commission one day, then the units are online in the analysis.
    let commissioned = tickRackDeliveries(result.state)
    expect(commissioned.player.rackFleet.some((install) => install.status === 'live' && install.count === 2)).toBe(true)
    commissioned = finishHallProject(commissioned, facility.id)
    const analysis = commissioned.dataHallLayouts![facility.id]!.analysis
    expect(analysis.operationalRackUnitIds.length).toBe(2)
    expect(analysis.offlineRackUnitIds.length).toBe(0)
  })

  it('counts commissioned racks as owned compute without a manual analysis refresh', () => {
    let state = createGame({ seed: 86, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const facility = [...state.map.world!.facilitiesById.values()].find((entry) => entry.kind === 'dc')!
    state.map.world!.beginBatch().updateFacility(facility.id, { ownerId: state.playerLabId }).commit()
    state = migrateDataHallLayouts({ ...state, dataHallLayouts: undefined, player: { ...state.player, cash: 500_000_000 } })
    const layout = state.dataHallLayouts![facility.id]!
    const applied = applyHallPlan(state, {
      facilityId: facility.id,
      expectedRevision: layout.revision,
      objects: [...layout.objects.filter((entry) => entry.kind !== 'rack'), draftRack('auto-1', 20, 20)],
      walls: layout.walls,
      doors: layout.doors,
    })
    expect(applied.ok).toBe(true)
    const before = computeLabSnapshot(syncLabIndex(applied.state), applied.state.playerLabId).installedLocalPf

    // Rack delivery alone is staged; the hall project must also commission.
    const commissioned = syncLabIndex(finishHallProject(tickRackDeliveries(applied.state), facility.id))
    const analysis = commissioned.dataHallLayouts![facility.id]!.analysis
    expect(analysis.operationalRackUnitIds).toHaveLength(1)
    const after = computeLabSnapshot(commissioned, commissioned.playerLabId).installedLocalPf
    const sku = resolveRackSku('rack_h100', [])
    expect(after - before).toBeGreaterThan(sku.flopsPf * 0.5)
  })

  it('does not generate free racks or utility equipment when reopening a layout', () => {
    let state = createGame({ seed: 85, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const facility = [...state.map.world!.facilitiesById.values()].find((entry) => entry.kind === 'dc')!
    const { x, y } = tileCoords(facility.anchor, state.map.width)
    state.map.world!.beginBatch().updateFacility(facility.id, { ownerId: state.playerLabId }).commit()
    // Legacy save shape: live racks in the fleet, but a layout with no rack
    // objects and no utility equipment.
    state = migrateDataHallLayouts({
      ...state,
      dataHallLayouts: undefined,
      player: {
        ...state.player,
        rackFleet: [{
          id: 'legacy-rack', skuId: 'rack_h100', facilityId: facility.id,
          x, y, count: 2, unitIds: ['legacy-rack-unit-1', 'legacy-rack-unit-2'], rackUnits: 1,
          status: 'live', daysLeft: 0, paidEach: 165_000,
        }],
      },
    })
    // Simulate a hand-emptied legacy layout: racks live in the fleet but
    // nothing is placed or wired in the hall.
    state = {
      ...state,
      dataHallLayouts: {
        ...state.dataHallLayouts,
        [facility.id]: { ...state.dataHallLayouts![facility.id]!, objects: [] },
      },
    }

    const repaired = repairHallLayouts(state)
    const inventory = rackUnitsForFacility(repaired, facility.id, repaired.playerLabId)
    expect(inventory).toHaveLength(2)
    expect(repaired.dataHallLayouts![facility.id]!.objects).toEqual([])
  })
})

describe('strategy-aware rack selection', () => {
  // A wins on flops per rack-unit, B wins on flops per MW and per dollar.
  const unitA: HallRackUnit = { unitId: 'unit-a', skuId: 'sku-a', mw: 1, networkGbps: 400, delivered: true, flopsPf: 10, rackUnits: 1, price: 100 }
  const unitB: HallRackUnit = { unitId: 'unit-b', skuId: 'sku-b', mw: 0.4, networkGbps: 400, delivered: true, flopsPf: 8, rackUnits: 2, price: 40 }
  const placedUnitIds = (inventory: readonly HallRackUnit[], strategy: HallAutoLayoutStrategy, capacity: number) =>
    autoPlanHall(createDefaultHallLayout('plan-hall', 'hall-small-v1', [], 96), inventory, strategy, capacity)
      .objects.filter((object) => object.kind === 'rack')
      .map((object) => object.rackUnitId)

  it('ranks every physically fitting owned rack by strategy instead of truncating at a bay quota', () => {
    expect(placedUnitIds([unitB, unitA], 'density', 1)).toEqual(['unit-a', 'unit-b'])
    expect(placedUnitIds([unitA, unitB], 'efficiency', 1)).toEqual(['unit-b', 'unit-a'])
    expect(placedUnitIds([unitA, unitB], 'resilience', 1)).toEqual(['unit-b', 'unit-a'])
  })

  it('does not use the legacy capacity argument as a selection limit', () => {
    const second: HallRackUnit = { unitId: 'owned-2', skuId: 'rack_h100', mw: 0.012, networkGbps: 400, delivered: true, flopsPf: 0 }
    const legacy: HallRackUnit = { unitId: 'legacy-1', skuId: 'sku-old', mw: 0.01, networkGbps: 400, delivered: true }
    for (const strategy of ['density', 'efficiency', 'resilience'] as const) {
      expect(placedUnitIds([second, legacy], strategy, 1)).toHaveLength(2)
    }
  })

  it('strategyRackSku picks the order catalog entry that best fits the strategy', () => {
    const state = createGame({ seed: 90, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const catalog = fullOrderCatalog(state)
    expect(catalog.length).toBeGreaterThan(0)
    const ratio: Record<HallAutoLayoutStrategy, (sku: RackSku) => number> = {
      density: (sku) => sku.flopsPf / Math.max(1, sku.rackUnits),
      efficiency: (sku) => sku.flopsPf / Math.max(1e-9, sku.mw),
      resilience: (sku) => sku.flopsPf / Math.max(1, sku.price),
    }
    for (const strategy of ['density', 'efficiency', 'resilience'] as const) {
      const pick = strategyRackSku(state, strategy)
      expect(pick).toBeDefined()
      const best = Math.max(...catalog.map(ratio[strategy]))
      expect(ratio[strategy](pick!)).toBeCloseTo(best, 9)
      expect(strategyRackSku(state, strategy)?.id).toBe(pick!.id)
    }
  })
})

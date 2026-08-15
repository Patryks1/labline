import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { DataHallObjectPlacement } from '../types'
import { tileCoords } from '../world'
import { canPlaceBuilding, placeBuilding } from './map'
import {
  advanceHallConstructionProject,
  createHallConstructionProject,
  hallConstructionStage,
  hallInstalledEquipmentOpexDay,
  labHallEquipmentOpexDay,
  normalizeHallConstructionProject,
  scheduleHallConstruction,
} from './dataHallConstruction'
import {
  createDefaultHallLayout,
  migrateDataHallLayouts,
  tickDataHallLayouts,
} from './dataHallLayouts'

describe('data hall construction lifecycle', () => {
  it('schedules every physical edit through build, cabling, and commissioning in 3–14 days', () => {
    const current = createDefaultHallLayout('schedule-hall', 'hall-small-v1', [], 96)
    const target = {
      ...current,
      walls: [{ id: 'partition', x1: 10, z1: 10, x2: 70, z2: 10, purchasePrice: 1_080_000 }],
      objects: [
        ...current.objects,
        { id: 'extra-ups', kind: 'power' as const, catalogId: 'ups-5mw', x: 30, z: 30, rotation: 0 as const, purchasePrice: 5_800_000 },
      ],
    }
    const schedule = scheduleHallConstruction(current, target)
    expect(schedule.totalDays).toBeGreaterThanOrEqual(3)
    expect(schedule.totalDays).toBeLessThanOrEqual(14)
    expect(schedule.stageDays.build).toBeGreaterThan(0)
    expect(schedule.stageDays.cabling).toBeGreaterThan(0)
    expect(schedule.stageDays.commissioning).toBeGreaterThan(0)
    expect(schedule.stageDays.build + schedule.stageDays.cabling + schedule.stageDays.commissioning).toBe(schedule.totalDays)

    const project = createHallConstructionProject({
      id: 'project-1',
      startedDay: 10,
      current,
      target,
      targetRevision: 1,
      infrastructureCost: 6_880_000,
      rackPurchaseCost: 0,
    })
    expect(project.stage).toBe('build')
    let active = project
    const seen = new Set([active.stage])
    while (active.remainingDays > 1) {
      const advanced = advanceHallConstructionProject(active)
      expect(advanced.complete).toBe(false)
      active = advanced.project!
      seen.add(active.stage)
    }
    expect(advanceHallConstructionProject(active)).toEqual({ complete: true })
    expect(seen).toEqual(new Set(['build', 'cabling', 'commissioning']))
    expect(hallConstructionStage(project.totalDays, 1, project.stageDays)).toBe('commissioning')
  })

  it('normalizes a persisted project and drops malformed partial targets', () => {
    const current = createDefaultHallLayout('saved-hall', 'hall-small-v1', [], 96)
    const project = createHallConstructionProject({
      id: 'saved-project', startedDay: 2, current, target: current,
      targetRevision: 1, infrastructureCost: 0, rackPurchaseCost: 0,
    })
    expect(normalizeHallConstructionProject(JSON.parse(JSON.stringify(project)))).toMatchObject({
      id: 'saved-project',
      remainingDays: project.remainingDays,
      targetPreferredStrategy: current.preferredStrategy,
    })
    expect(normalizeHallConstructionProject({ id: 'broken' })).toBeUndefined()
  })

  it('queues auto-placement as an install project without spending cash or activating staged racks', () => {
    let state = createGame({ seed: 9_521, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const facility = [...state.map.world!.facilitiesById.values()].find((entry) => entry.kind === 'dc')!
    const { x, y } = tileCoords(facility.anchor, state.map.width)
    state.map.world!.beginBatch().updateFacility(facility.id, { ownerId: state.playerLabId }).commit()
    state = migrateDataHallLayouts({ ...state, dataHallLayouts: undefined })
    const before = state.dataHallLayouts![facility.id]!
    const cashBefore = state.player.cash
    state = {
      ...state,
      player: {
        ...state.player,
        rackFleet: [{
          id: 'delivered-install', skuId: 'rack_h100', x, y, count: 1,
          status: 'live', daysLeft: 0, paidEach: 313_500, rackUnits: 1,
          facilityId: facility.id, unitIds: ['delivered-unit'],
        }],
      },
    }

    const queued = tickDataHallLayouts(state)
    const live = queued.dataHallLayouts![facility.id]!
    expect(queued.player.cash).toBe(cashBefore)
    expect(live.objects).toEqual(before.objects)
    expect(live.analysis.operationalRackUnitIds).not.toContain('delivered-unit')
    expect(live.constructionProject?.targetObjects.some((object) => object.rackUnitId === 'delivered-unit')).toBe(true)
    expect(live.constructionProject?.totalCost).toBe(0)
  })

  it('claims a future player hall as empty before completion instead of granting baseline utilities', () => {
    let state = createGame({ seed: 9_523, legacyMapFixture: true })
    state = { ...state, player: { ...state.player, cash: 2_000_000_000 } }
    const spot = state.map.tiles.find(
      (tile) => tile.kind === 'empty' && canPlaceBuilding(state, tile.x, tile.y, 'dc').ok,
    )!
    state = placeBuilding(state, spot.x, spot.y, 'dc')
    const hall = state.map.tiles.find((tile) => tile.x === spot.x && tile.y === spot.y)!
    const facilityId = hall.campusId!
    const cashAfterShellPurchase = state.player.cash

    expect(state.dataHallLayouts?.[facilityId]).toBeUndefined()
    state = migrateDataHallLayouts(state)
    expect(state.dataHallLayouts![facilityId]).toMatchObject({ version: 2, objects: [] })
    expect(state.player.cash).toBe(cashAfterShellPurchase)

    state = {
      ...state,
      map: {
        ...state.map,
        tiles: state.map.tiles.map((tile) =>
          tile.campusId === facilityId
            ? { ...tile, buildingProgress: tile.buildingTarget }
            : tile,
        ),
      },
    }
    state = migrateDataHallLayouts(state)
    expect(state.dataHallLayouts![facilityId]!.objects).toEqual([])

    state = {
      ...state,
      player: {
        ...state.player,
        rackFleet: [{
          id: 'future-player-rack',
          skuId: 'rack_h100',
          x: spot.x,
          y: spot.y,
          count: 1,
          status: 'live',
          daysLeft: 0,
          paidEach: 313_500,
          rackUnits: 1,
          facilityId,
          unitIds: ['future-player-unit'],
        }],
      },
    }
    const cashBeforeInstall = state.player.cash
    state = tickDataHallLayouts(state)
    const target = state.dataHallLayouts![facilityId]!.constructionProject!.targetObjects
    expect(state.player.cash).toBe(cashBeforeInstall)
    expect(target.some((object) => object.rackUnitId === 'future-player-unit')).toBe(true)
    expect(target.some((object) => object.kind !== 'rack')).toBe(false)
  })

  it('keeps the utility baseline only for a completed missing legacy layout', () => {
    let state = createGame({ seed: 9_524, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const rival = state.rivals[0]!
    const facility = state.map.world!.queryFacilities({ ownerId: rival.id }).find((entry) => entry.kind === 'dc')!
    state = {
      ...state,
      dataHallLayouts: Object.fromEntries(
        Object.entries(state.dataHallLayouts ?? {}).filter(([facilityId]) => facilityId !== facility.id),
      ),
    }

    state = migrateDataHallLayouts(state)
    const kinds = new Set(state.dataHallLayouts![facility.id]!.objects.map((object) => object.kind))
    expect(kinds).toEqual(new Set(['power', 'cooling', 'network']))
  })

  function futureRivalHall(seed: number, cash: number) {
    let state = createGame({ seed, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const rival = state.rivals[0]!
    const world = state.map.world!
    const anchor = world.staticWorld.starterPads.find((tile) => world.getFacilityAt(tile) === undefined)!
    const facilityId = `future-rival-hall-${seed}`
    world.beginBatch().addFacility({
      id: facilityId,
      kind: 'dc',
      ownerId: rival.id,
      anchor,
      footprint: [anchor],
      level: 1,
      constructionProgress: 0,
      constructionTarget: 10,
      powered: true,
      stats: { rackCapacity: 96, racksUsed: 0, opexPerDay: 125_000 },
      data: { name: 'Future rival hall', dcSize: 'small' },
    }).commit()
    state = {
      ...state,
      map: { ...state.map, worldRevision: world.revision },
      rivals: state.rivals.map((candidate) => candidate.id === rival.id
        ? { ...candidate, cash, rackFleet: [] }
        : candidate),
    }
    state = migrateDataHallLayouts(state)
    expect(state.dataHallLayouts![facilityId]!.objects).toEqual([])

    world.beginBatch().updateFacility(facilityId, { constructionProgress: 10 }).commit()
    const x = anchor % state.map.width
    const y = Math.floor(anchor / state.map.width)
    state = {
      ...state,
      map: { ...state.map, worldRevision: world.revision },
      rivals: state.rivals.map((candidate) => candidate.id === rival.id
        ? {
            ...candidate,
            rackFleet: [{
              id: `future-rival-rack-${seed}`,
              skuId: 'rack_h100',
              x,
              y,
              count: 1,
              status: 'live' as const,
              daysLeft: 0,
              paidEach: 313_500,
              rackUnits: 1,
              facilityId,
              unitIds: [`future-rival-unit-${seed}`],
            }],
          }
        : candidate),
    }
    return { state, rivalId: rival.id, facilityId }
  }

  it('charges a rival for explicit utility fitout and queues it as a ghost project', () => {
    const setup = futureRivalHall(9_525, 100_000_000)
    const cashBefore = setup.state.rivals.find((rival) => rival.id === setup.rivalId)!.cash
    const queued = tickDataHallLayouts(setup.state)
    const layout = queued.dataHallLayouts![setup.facilityId]!
    const project = layout.constructionProject!

    expect(layout.objects).toEqual([])
    expect(project).toBeDefined()
    expect(project.infrastructureCost).toBeGreaterThan(0)
    expect(project.targetObjects.some((object) => object.kind !== 'rack' && object.purchasePrice > 0)).toBe(true)
    expect(project.targetObjects.some((object) => object.kind === 'rack')).toBe(true)
    expect(queued.rivals.find((rival) => rival.id === setup.rivalId)!.cash).toBe(
      cashBefore - project.infrastructureCost,
    )
    expect(queued.labs[setup.rivalId]!.cash).toBe(cashBefore - project.infrastructureCost)
    expect(queued.labs[setup.rivalId]!.finance.cash).toBe(cashBefore - project.infrastructureCost)
    expect(layout.analysis.operationalRackUnitIds).toEqual([])
  })

  it('leaves rival racks staged when the lab cannot afford the utility fitout', () => {
    const setup = futureRivalHall(9_526, 1_000_000)
    const queued = tickDataHallLayouts(setup.state)
    const layout = queued.dataHallLayouts![setup.facilityId]!

    expect(layout.objects).toEqual([])
    expect(layout.constructionProject).toBeUndefined()
    expect(layout.autoPlaceRetryDay).toBe(queued.day + 30)
    expect(queued.rivals.find((rival) => rival.id === setup.rivalId)!.cash).toBe(1_000_000)

    const nextDay = tickDataHallLayouts({ ...queued, day: queued.day + 1 })
    expect(nextDay.dataHallLayouts![setup.facilityId]!.constructionProject).toBeUndefined()
    expect(nextDay.dataHallLayouts![setup.facilityId]!.autoPlaceRetryDay).toBe(queued.day + 30)
  })
})

describe('installed hall equipment operating costs', () => {
  it('charges 4–7% annual maintenance plus overhead only on commissioned objects', () => {
    const live = createDefaultHallLayout('opex-hall', 'hall-small-v1', [], 96)
    const extra: DataHallObjectPlacement = {
      id: 'ghost-cooler', kind: 'cooling', catalogId: 'inrow-350kw',
      x: 40, z: 40, rotation: 0, purchasePrice: 720_000,
    }
    const target = { ...live, objects: [...live.objects, extra] }
    const liveCost = hallInstalledEquipmentOpexDay(live)
    const project = createHallConstructionProject({
      id: 'ghost-project', startedDay: 1, current: live, target,
      targetRevision: 1, infrastructureCost: 720_000, rackPurchaseCost: 0,
    })
    expect(hallInstalledEquipmentOpexDay({ ...live, constructionProject: project })).toBeCloseTo(liveCost, 8)
    expect(hallInstalledEquipmentOpexDay(target)).toBeGreaterThan(liveCost)
    expect(hallInstalledEquipmentOpexDay({
      ...live,
      objects: [{ id: 'ups', kind: 'power', catalogId: 'ups-5mw', x: 2, z: 2, rotation: 0, purchasePrice: 5_800_000 }],
    })).toBeGreaterThan(5_800_000 * 0.04 / 365)
  })

  it('is owner-neutral and does not charge equipment inside an unfinished shell', () => {
    const state = createGame({ seed: 9_522, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const rival = state.rivals[0]!
    const facility = state.map.world!.queryFacilities({ ownerId: rival.id }).find((entry) => entry.kind === 'dc')!
    const rivalCost = labHallEquipmentOpexDay(state, rival.id)
    expect(rivalCost).toBeGreaterThan(0)

    state.map.world!.beginBatch().replaceFacility({ ...facility, ownerId: state.playerLabId }).commit()
    expect(labHallEquipmentOpexDay(state, state.playerLabId)).toBeCloseTo(rivalCost, 8)

    state.map.world!.beginBatch().replaceFacility({
      ...facility,
      ownerId: state.playerLabId,
      constructionProgress: 0,
      constructionTarget: 10,
    }).commit()
    expect(labHallEquipmentOpexDay(state, state.playerLabId)).toBe(0)
  })
})

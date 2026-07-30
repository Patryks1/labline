import { beforeEach, describe, expect, it } from 'vitest'
import { createGame } from '../sim/createGame'
import { createWall } from '../sim/systems/dataHallLayouts'
import { facilityAnchorTiles } from '../sim/systems/worldAccess'
import { useGameStore } from './gameStore'

describe('data hall editor store integration', () => {
  beforeEach(() => {
    const state = createGame({ seed: 515, difficulty: 'easy', advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 } })
    const facility = [...state.map.world!.facilitiesById.values()].find((entry) => entry.kind === 'dc')!
    state.map.world!.beginBatch().updateFacility(facility.id, { ownerId: state.playerLabId }).commit()
    state.dataHallLayouts = undefined
    useGameStore.setState({ phase: 'playing', state, hallEditorFacilityId: null })
  })

  it('opens with a migrated layout and closes without changing the simulation', () => {
    const state = useGameStore.getState().state
    const facility = [...state.map.world!.facilitiesById.values()].find((entry) => entry.kind === 'dc')!
    useGameStore.getState().openHallEditor(facility.id)
    expect(useGameStore.getState().hallEditorFacilityId).toBe(facility.id)
    expect(useGameStore.getState().state.dataHallLayouts?.[facility.id]).toBeDefined()
    useGameStore.getState().closeHallEditor()
    expect(useGameStore.getState().hallEditorFacilityId).toBeNull()
  })

  it('opens the rack designer for the current hall and closes the floor editor', () => {
    const facility = [...useGameStore.getState().state.map.world!.facilitiesById.values()].find((entry) => entry.kind === 'dc')!
    const hall = facilityAnchorTiles(useGameStore.getState().state).find((entry) => entry.campusId === facility.id)!
    useGameStore.getState().openHallEditor(facility.id)
    useGameStore.getState().openRackDesigner(facility.id)
    const store = useGameStore.getState()
    expect(store.hallEditorFacilityId).toBeNull()
    expect(store.activePanel).toBe('racks')
    expect(store.rackWorkspaceTab).toBe('blueprints')
    expect(store.selectedTile).toEqual({ x: hall.x, y: hall.y })
    expect(store.leftRailOpen).toBe(true)
  })

  it('commits only revision-matched valid drafts', () => {
    const facility = [...useGameStore.getState().state.map.world!.facilitiesById.values()].find((entry) => entry.kind === 'dc')!
    useGameStore.getState().openHallEditor(facility.id)
    const layout = useGameStore.getState().state.dataHallLayouts![facility.id]!
    const wall = createWall('store-applied-wall', 40, 40, 48, 40)
    const result = useGameStore.getState().applyHallEditorPlan({
      facilityId: facility.id,
      expectedRevision: layout.revision,
      objects: layout.objects,
      walls: [...layout.walls, wall],
      doors: layout.doors,
    })
    expect(result.ok).toBe(true)
    expect(useGameStore.getState().state.dataHallLayouts![facility.id]!.revision).toBe(layout.revision + 1)
    expect(useGameStore.getState().state.dataHallLayouts![facility.id]!.walls).toContainEqual(wall)
    expect(useGameStore.getState().hallEditorFacilityId).toBe(facility.id)
    expect(useGameStore.getState().applyHallEditorPlan({
      facilityId: facility.id,
      expectedRevision: layout.revision,
      objects: layout.objects,
      walls: layout.walls,
      doors: layout.doors,
    }).ok).toBe(false)
  })

  it('commits a visible staged rack placement as the live hall layout', () => {
    const initial = useGameStore.getState().state
    const facility = [...initial.map.world!.facilitiesById.values()].find((entry) => entry.kind === 'dc')!
    const hall = facilityAnchorTiles(initial).find((entry) => entry.campusId === facility.id)!
    useGameStore.getState().openHallEditor(facility.id)
    useGameStore.setState((store) => ({
      state: {
        ...store.state,
        player: {
          ...store.state.player,
          rackFleet: [{
            id: 'staged-install', skuId: 'rack_h100', facilityId: facility.id,
            x: hall.x, y: hall.y, count: 1, rackUnits: 1, status: 'live',
            paidEach: 1, daysLeft: 0, unitIds: ['staged-unit-1'],
          }],
        },
      },
    }))
    const layout = useGameStore.getState().state.dataHallLayouts![facility.id]!
    const placedRack = {
      id: 'visible-rack', kind: 'rack' as const, catalogId: 'rack_h100', rackUnitId: 'staged-unit-1',
      x: 20, z: 20, rotation: 0 as const, purchasePrice: 0,
    }
    const result = useGameStore.getState().applyHallEditorPlan({
      facilityId: facility.id,
      expectedRevision: layout.revision,
      objects: [placedRack],
      walls: layout.walls,
      doors: layout.doors,
    })
    expect(result.ok).toBe(true)
    expect(useGameStore.getState().state.dataHallLayouts![facility.id]!.objects).toContainEqual(placedRack)
  })

  it('persists planned rack cabinets so capacity-plan models remain visible after Apply', () => {
    const facility = [...useGameStore.getState().state.map.world!.facilitiesById.values()].find((entry) => entry.kind === 'dc')!
    useGameStore.getState().openHallEditor(facility.id)
    const layout = useGameStore.getState().state.dataHallLayouts![facility.id]!
    const plannedCabinet = {
      id: `${facility.id}:reserved:0001`, kind: 'rack' as const, catalogId: 'rack_h100',
      reserved: true, x: 24, z: 24, rotation: 0 as const, purchasePrice: 0,
    }
    const result = useGameStore.getState().applyHallEditorPlan({
      facilityId: facility.id,
      expectedRevision: layout.revision,
      objects: [...layout.objects, plannedCabinet],
      walls: layout.walls,
      doors: layout.doors,
    })
    expect(result.ok).toBe(true)
    expect(useGameStore.getState().state.dataHallLayouts![facility.id]!.objects).toContainEqual(plannedCabinet)
  })
})

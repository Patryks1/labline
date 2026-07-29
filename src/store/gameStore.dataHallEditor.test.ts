import { beforeEach, describe, expect, it } from 'vitest'
import { createGame } from '../sim/createGame'
import { createWall } from '../sim/systems/dataHallLayouts'
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
})

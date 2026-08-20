import { describe, expect, it } from 'vitest'
import { createGame } from '../../../../sim/createGame'
import { emptyStaff } from '../../../../sim/balance/staff'
import type { MapTile } from '../../../../sim/types'
import {
  facilityEditorAction,
  facilityIdForTile,
  facilityStaffLines,
  isPlayerFacility,
} from './facilityIntel'

function tile(patch: Partial<MapTile> = {}): MapTile {
  return {
    x: 4,
    y: 7,
    kind: 'hq',
    owner: 'player',
    campusRole: 'anchor',
    campusId: 'campus-hq',
    buildingProgress: 10,
    buildingTarget: 10,
    level: 1,
    name: 'HQ',
    racksUsed: 0,
    rackCapacity: 0,
    mwCapacity: 0,
    mwGeneration: 0,
    opexPerDay: 0,
    capex: 0,
    powered: true,
    ...patch,
  } as MapTile
}

describe('facility intel helpers', () => {
  it('treats completed player anchors as facilities and skips pads', () => {
    expect(isPlayerFacility(tile())).toBe(true)
    expect(isPlayerFacility(tile({ campusRole: 'pad' }))).toBe(false)
    expect(isPlayerFacility(tile({ owner: 'rival-a' }))).toBe(false)
  })

  it('routes hall and office editors from the same facility identity', () => {
    expect(facilityIdForTile(tile())).toBe('campus-hq')
    expect(facilityIdForTile(tile({ campusId: undefined, x: 2, y: 3 }))).toBe('facility:2,3')
    expect(facilityEditorAction(tile({ kind: 'dc' }))).toEqual({ kind: 'data-hall', label: 'Hall editor' })
    expect(facilityEditorAction(tile({ kind: 'hq' }))).toEqual({ kind: 'hq-office', label: 'Office editor' })
    expect(facilityEditorAction(tile({ kind: 'lab' }))).toBeNull()
  })

  it('lists HQ roster seats and lab pod headcount', () => {
    const state = createGame({ seed: 81, difficulty: 'easy' })
    state.player.staff = { ...emptyStaff(), researcher: 3, engineer: 2, ops: 1 }
    state.player.researchPods = [
      {
        id: 'pod-1',
        name: 'Core',
        leadId: 'lead',
        focus: 'systems',
        researchers: 4,
        engineers: 1,
        dataStaff: 1,
        assignmentId: 'job',
      },
    ]

    const hqLines = facilityStaffLines(state, tile({ kind: 'hq' }))
    expect(hqLines.find((line) => line.label === 'Researchers')?.value).toBe('3')
    expect(hqLines.find((line) => line.label === 'Engineers')?.value).toBe('2')
    expect(hqLines.some((line) => line.label === 'Desks')).toBe(true)

    const labLines = facilityStaffLines(state, tile({ kind: 'lab' }))
    expect(labLines).toEqual([
      { label: 'Researchers', value: '4' },
      { label: 'Engineers', value: '1' },
      { label: 'Data staff', value: '1' },
    ])
  })
})

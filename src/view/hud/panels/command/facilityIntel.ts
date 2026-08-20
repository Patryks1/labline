import { STAFF_LABELS, STAFF_ROLES } from '../../../../sim/balance/staff'
import { dcBayUsage } from '../../../../sim/systems/dcRacks'
import {
  getBuildDef,
  isBuildableKind,
  isDcAnchor,
  isDcKind,
  isHqKind,
  isScenicKind,
} from '../../../../sim/systems/map'
import { playerHqStaffCap, playerStaff, staffTotal } from '../../../../sim/systems/staff'
import { facilityAnchorTiles } from '../../../../sim/systems/worldAccess'
import type { MapTile, SimState } from '../../../../sim/types'
import { facilityEditorKindForTile } from '../../tileInspectorFacilityAction'

export function isPlayerFacility(tile: MapTile): boolean {
  return (
    tile.owner === 'player' &&
    tile.kind !== 'empty' &&
    !isScenicKind(tile.kind) &&
    tile.campusRole !== 'pad' &&
    isBuildableKind(tile.kind)
  )
}

export function playerFacilities(state: SimState): MapTile[] {
  return facilityAnchorTiles(state, { ownerId: 'player' }).filter(isPlayerFacility)
}

export function facilityTypeLabel(tile: MapTile): string {
  try {
    return getBuildDef(tile.kind as never).label
  } catch {
    return tile.kind
  }
}

export function facilityIdForTile(tile: MapTile): string {
  return tile.campusId ?? `facility:${tile.x},${tile.y}`
}

export type FacilityStaffLine = { label: string; value: string }

export function facilityStaffLines(state: SimState, tile: MapTile): FacilityStaffLine[] {
  if (isHqKind(tile.kind)) {
    const staff = playerStaff(state)
    const cap = playerHqStaffCap(state)
    return [
      ...STAFF_ROLES.map((role) => ({
        label: STAFF_LABELS[role],
        value: String(staff[role] ?? 0),
      })),
      { label: 'Desks', value: `${staffTotal(staff)}/${cap}` },
    ]
  }
  if (tile.kind === 'lab') {
    const pods = state.player.researchPods ?? []
    return [
      { label: 'Researchers', value: String(pods.reduce((n, pod) => n + (pod.researchers ?? 0), 0)) },
      { label: 'Engineers', value: String(pods.reduce((n, pod) => n + (pod.engineers ?? 0), 0)) },
      { label: 'Data staff', value: String(pods.reduce((n, pod) => n + (pod.dataStaff ?? 0), 0)) },
    ]
  }
  return []
}

export function facilityRackSummary(state: SimState, tile: MapTile): string | null {
  if (!isDcKind(tile.kind) || !isDcAnchor(tile)) return null
  if (tile.buildingTarget > 0 && tile.buildingProgress < tile.buildingTarget) return null
  const usage = dcBayUsage(state, tile.x, tile.y)
  const staged = usage.staged > 0 ? ` · ${usage.staged} staged` : ''
  return `${usage.used} placed · ${usage.live} online${staged}`
}

export function facilityEditorAction(tile: MapTile): { kind: 'data-hall' | 'hq-office'; label: string } | null {
  const kind = facilityEditorKindForTile(tile)
  if (kind === 'data-hall') return { kind, label: 'Hall editor' }
  if (kind === 'hq-office') return { kind, label: 'Office editor' }
  return null
}

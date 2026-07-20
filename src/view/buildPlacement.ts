import { BUILDABLE_KINDS, buildingTotalCost, getBuildDef } from '../sim/systems/map'
import { mapTileAtAny } from '../sim/systems/worldAccess'
import type { BuildableKind, SimState } from '../sim/types'

export const BUILD_BLUEPRINT_DRAG_MIME = 'application/x-labline-blueprint'

const BUILDABLE_KIND_SET = new Set<string>(BUILDABLE_KINDS)

export interface PlacementCost {
  buildCash: number
  landCash: number
  totalCash: number
}

/** Add a validated blueprint payload to a native HTML drag operation. */
export function writeBuildBlueprintDrag(
  transfer: DataTransfer,
  kind: BuildableKind,
): void {
  transfer.effectAllowed = 'copy'
  transfer.setData(BUILD_BLUEPRINT_DRAG_MIME, kind)
  transfer.setData('text/plain', kind)
}

/** Native drag data is protected until drop in some browsers, so types are checked separately. */
export function hasBuildBlueprintDrag(transfer: DataTransfer | null): boolean {
  if (!transfer) return false
  return Array.from(transfer.types).includes(BUILD_BLUEPRINT_DRAG_MIME)
}

export function readBuildBlueprintDrag(
  transfer: DataTransfer | null,
): BuildableKind | null {
  if (!transfer) return null
  const value =
    transfer.getData(BUILD_BLUEPRINT_DRAG_MIME) || transfer.getData('text/plain')
  return BUILDABLE_KIND_SET.has(value) ? (value as BuildableKind) : null
}

/** Full-footprint land and construction cost for the parcel under the cursor. */
export function placementCostAt(
  state: SimState,
  x: number,
  y: number,
  kind: BuildableKind,
): PlacementCost | null {
  const tile = mapTileAtAny(state, x, y)
  if (!tile) return null
  const buildCash = Math.floor(
    getBuildDef(kind).cash * (state.config?.economyMult ?? 1),
  )
  const totalCash = buildingTotalCost(state, tile, kind)
  return {
    buildCash,
    landCash: Math.max(0, totalCash - buildCash),
    totalCash,
  }
}

export function placementTooltipPosition(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  tooltipWidth = 176,
  tooltipHeight = 54,
): { left: number; top: number } {
  const localX = clientX - bounds.left
  const localY = clientY - bounds.top
  const left =
    localX + 16 + tooltipWidth <= bounds.width
      ? localX + 16
      : localX - tooltipWidth - 16
  const top =
    localY + 16 + tooltipHeight <= bounds.height
      ? localY + 16
      : localY - tooltipHeight - 16
  return {
    left: Math.max(8, Math.min(left, Math.max(8, bounds.width - tooltipWidth - 8))),
    top: Math.max(8, Math.min(top, Math.max(8, bounds.height - tooltipHeight - 8))),
  }
}

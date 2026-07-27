import { describe, expect, it } from 'vitest'
import { createGame } from '../sim/createGame'
import { getBuildDef } from '../sim/systems/map'
import {
  BUILD_BLUEPRINT_DRAG_MIME,
  hasBuildBlueprintDrag,
  placementCostAt,
  placementTooltipPosition,
  readBuildBlueprintDrag,
  writeBuildBlueprintDrag,
} from './buildPlacement'

class TestDataTransfer {
  effectAllowed = 'none'
  dropEffect = 'none'
  private readonly values = new Map<string, string>()

  get types(): string[] {
    return [...this.values.keys()]
  }

  setData(type: string, value: string): void {
    this.values.set(type, value)
  }

  getData(type: string): string {
    return this.values.get(type) ?? ''
  }
}

describe('build blueprint placement helpers', () => {
  it('writes and validates a native blueprint drag payload', () => {
    const transfer = new TestDataTransfer() as unknown as DataTransfer
    writeBuildBlueprintDrag(transfer, 'dc_m')

    expect(transfer.effectAllowed).toBe('copy')
    expect(Array.from(transfer.types)).toContain(BUILD_BLUEPRINT_DRAG_MIME)
    expect(hasBuildBlueprintDrag(transfer)).toBe(true)
    expect(readBuildBlueprintDrag(transfer)).toBe('dc_m')
  })

  it('rejects unknown external drag payloads', () => {
    const transfer = new TestDataTransfer() as unknown as DataTransfer
    transfer.setData(BUILD_BLUEPRINT_DRAG_MIME, 'delete-everything')
    expect(readBuildBlueprintDrag(transfer)).toBeNull()
  })

  it('reports hovered land separately from construction cost', () => {
    const state = createGame({
      seed: 812,
      difficulty: 'easy',
      advanced: { mapWidth: 60, mapHeight: 60, cityCount: 3, rivalCount: 1 },
    })
    const tile = state.map.tiles.find(
      (candidate) =>
        candidate.kind === 'empty' &&
        candidate.owner === 'neutral' &&
        candidate.regionId !== 'void',
    )
    expect(tile).toBeDefined()
    if (!tile) return

    const cost = placementCostAt(state, tile.x, tile.y, 'solar')
    const buildCash = Math.floor(
      getBuildDef('solar').cash * (state.config?.economyMult ?? 1),
    )
    expect(cost).toEqual({
      buildCash,
      landCash: tile.landValue,
      gradingCash: 0,
      totalCash: buildCash + tile.landValue,
    })
  })

  it('keeps the cursor tooltip inside the visible map', () => {
    const bounds = { left: 100, top: 50, width: 800, height: 600 }
    expect(placementTooltipPosition(120, 70, bounds)).toEqual({ left: 36, top: 36 })

    const nearEdge = placementTooltipPosition(895, 645, bounds)
    expect(nearEdge.left).toBeGreaterThanOrEqual(8)
    expect(nearEdge.left + 176).toBeLessThanOrEqual(bounds.width - 8)
    expect(nearEdge.top).toBeGreaterThanOrEqual(8)
    expect(nearEdge.top + 54).toBeLessThanOrEqual(bounds.height - 8)
  })
})

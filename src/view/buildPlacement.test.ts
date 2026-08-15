import { describe, expect, it } from 'vitest'
import { createGame } from '../sim/createGame'
import { getBuildDef } from '../sim/systems/map'
import { transportLandValueMultiplier } from '../sim/systems/transport'
import { compactTileIdAt, mapTileAtAny, usesCompactWorld } from '../sim/systems/worldAccess'
import { tileCoords } from '../sim/world/ids'
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
    let tile = state.map.tiles.find(
      (candidate) =>
        candidate.kind === 'empty' &&
        candidate.owner === 'neutral' &&
        candidate.regionId !== 'void',
    )
    if (!tile && usesCompactWorld(state) && state.map.world) {
      const pad = state.map.world.staticWorld.starterPads[0]!
      const { x, y } = tileCoords(pad, state.map.world.descriptor.width)
      tile = mapTileAtAny(state, x, y)
    }
    expect(tile).toBeDefined()
    if (!tile) return

    const cost = placementCostAt(state, tile.x, tile.y, 'solar')
    expect(cost).not.toBeNull()
    if (!cost) return
    const buildCash = Math.floor(
      getBuildDef('solar').cash * (state.config?.economyMult ?? 1),
    )
    expect(cost.buildCash).toBe(buildCash)
    // Land cost is the tile's land value scaled by the transport-access
    // multiplier (0.88–1.04), exactly as canPlaceBuilding computes it.
    const idx = usesCompactWorld(state) ? compactTileIdAt(state, tile.x, tile.y) : undefined
    const accessMultiplier = idx !== undefined && idx >= 0
      ? transportLandValueMultiplier(state, idx)
      : 1
    const expectedLandCash = Math.max(0, tile.landValue ?? 0) * accessMultiplier
    expect(cost.landCash).toBe(expectedLandCash)
    expect(cost.totalCash).toBe(buildCash + cost.landCash + cost.gradingCash)
    expect(cost.gradingCash).toBeGreaterThanOrEqual(0)
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

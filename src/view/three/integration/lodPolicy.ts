import {
  ArchetypeRegistry,
  type ViewportUpdateResult,
} from '../v2'

export const CLOSE_UP_NEAR_PIXELS = 28

/**
 * Compatibility seam for the close-up policy. The renderer owns readiness and
 * atomic tier swaps, so this layer must never suppress the last complete tier.
 */
export function enforceCloseUpNearOnly(
  _registry: ArchetypeRegistry,
  update: ViewportUpdateResult,
  _pixelsPerTile: number,
): ViewportUpdateResult {
  // ScreenSpaceLod requests near before this band and retains the active tier
  // until every visible near chunk is ready. Keep this seam for callers/tests.
  return update
}

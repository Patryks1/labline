import {
  ArchetypeRegistry,
  type ViewportUpdateResult,
} from '../v2'

export const CLOSE_UP_NEAR_PIXELS = 28

/**
 * Compatibility seam for the close-up policy. The renderer owns readiness and
 * complementary coverage so this layer must never suppress the last complete
 * representation.
 */
export function enforceCloseUpNearOnly(
  _registry: ArchetypeRegistry,
  update: ViewportUpdateResult,
  _pixelsPerTile: number,
): ViewportUpdateResult {
  // ScreenSpaceLod starts the near transition before this band and retains the
  // outgoing tier until every visible near chunk is ready. Snapping coverage
  // here used to create both a visible pop and an all-props-missing frame.
  // Keep this integration seam for callers/tests, but never override the
  // renderer's readiness-safe complementary layers.
  return update
}

export const DRAG_START_DISTANCE_PX = 5

/**
 * Pull an orthographic camera back as its visible frustum grows. Distance does
 * not change orthographic scale, but it keeps every screen ray above the map's
 * ground plane at wide zoom levels.
 */
export function mapCameraDistanceScale(
  frustum: number,
  defaultFrustum: number,
): number {
  if (!Number.isFinite(frustum) || !Number.isFinite(defaultFrustum) || defaultFrustum <= 0) {
    return 1
  }
  return Math.max(1, frustum / defaultFrustum)
}

export function grabbedWorldPanDelta(
  anchorX: number,
  anchorZ: number,
  pointerWorldX: number,
  pointerWorldZ: number,
): { x: number; z: number } {
  return {
    x: anchorX - pointerWorldX,
    z: anchorZ - pointerWorldZ,
  }
}

export function hasPointerDragged(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
): boolean {
  return Math.hypot(currentX - startX, currentY - startY) >= DRAG_START_DISTANCE_PX
}

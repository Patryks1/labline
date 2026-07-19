export const DRAG_START_DISTANCE_PX = 5

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

export interface GesturePoint {
  x: number
  y: number
}

/** A deliberate right swipe from the left edge dismisses a full-screen menu. */
export function isMenuDismissSwipe(start: GesturePoint, end: GesturePoint): boolean {
  const dx = end.x - start.x
  const dy = Math.abs(end.y - start.y)
  return start.x <= 36 && dx >= 72 && dy <= Math.max(48, dx * 0.55)
}

/** Bottom sheets dismiss only for a predominantly downward gesture. */
export function isSheetDismissSwipe(start: GesturePoint, end: GesturePoint): boolean {
  const dy = end.y - start.y
  const dx = Math.abs(end.x - start.x)
  return dy >= 72 && dx <= Math.max(48, dy * 0.6)
}

/** Tap tolerance used to distinguish selection from orbiting a 3D floor. */
export function isOfficeTapGesture(
  start: GesturePoint,
  end: GesturePoint,
  threshold = 8,
): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) <= threshold
}

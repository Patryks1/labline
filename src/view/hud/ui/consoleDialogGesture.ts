export interface ConsoleDialogSwipeVector {
  deltaX: number
  deltaY: number
  elapsedMs: number
}

/**
 * A deliberate downward drag closes a compact dialog. The short-distance
 * velocity path keeps a quick flick feeling responsive while directional
 * gating prevents horizontal rails and incidental taps from dismissing it.
 */
export function shouldDismissConsoleDialogSwipe({
  deltaX,
  deltaY,
  elapsedMs,
}: ConsoleDialogSwipeVector) {
  if (elapsedMs < 0 || elapsedMs > 900) return false
  if (deltaY <= 0 || deltaY <= Math.abs(deltaX) * 1.15) return false
  if (deltaY >= 72) return true
  return deltaY >= 32 && deltaY / Math.max(1, elapsedMs) >= 0.55
}

export interface ChartKeyboardEventLike {
  key: string
  preventDefault: () => void
  stopPropagation: () => void
}

/**
 * Chart-level Escape clears chart selection without falling through to the
 * global game hotkey stack (where Escape opens the pause menu).
 */
export function consumeChartEscape(
  event: ChartKeyboardEventLike,
  clear: () => void,
): boolean {
  if (event.key !== 'Escape') return false
  event.preventDefault()
  event.stopPropagation()
  clear()
  return true
}

export type HardwareView = 'racks' | 'silicon'
export type HallMobileWorkspace = 'palette' | 'floor' | 'inspect'
export type HallEditorTabTarget = 'first' | 'last' | null

const MOBILE_SWIPE_THRESHOLD_PX = 56

function isDeliberateHorizontalSwipe(deltaX: number, deltaY: number) {
  return (
    Math.abs(deltaX) >= MOBILE_SWIPE_THRESHOLD_PX &&
    Math.abs(deltaX) > Math.abs(deltaY) * 1.2
  )
}

export function hardwareViewAfterSwipe(
  view: HardwareView,
  deltaX: number,
  deltaY: number,
): HardwareView {
  if (!isDeliberateHorizontalSwipe(deltaX, deltaY)) return view
  if (deltaX < 0) return 'silicon'
  return 'racks'
}

const HALL_MOBILE_WORKSPACES: readonly HallMobileWorkspace[] = [
  'palette',
  'floor',
  'inspect',
]

export function hallMobileWorkspaceAfterSwipe(
  active: HallMobileWorkspace,
  deltaX: number,
  deltaY: number,
): HallMobileWorkspace {
  if (!isDeliberateHorizontalSwipe(deltaX, deltaY)) return active
  const activeIndex = HALL_MOBILE_WORKSPACES.indexOf(active)
  const direction = deltaX < 0 ? 1 : -1
  const nextIndex = Math.max(
    0,
    Math.min(HALL_MOBILE_WORKSPACES.length - 1, activeIndex + direction),
  )
  return HALL_MOBILE_WORKSPACES[nextIndex] ?? active
}

/** Resolve only the focus-wrap cases; ordinary Tab movement stays native. */
export function hallEditorTabTarget({
  shiftKey,
  atFirst,
  atLast,
  activeOnDialog,
  activeInside,
}: {
  shiftKey: boolean
  atFirst: boolean
  atLast: boolean
  activeOnDialog: boolean
  activeInside: boolean
}): HallEditorTabTarget {
  if (!activeInside && !activeOnDialog) return shiftKey ? 'last' : 'first'
  if (shiftKey && (atFirst || activeOnDialog)) return 'last'
  if (!shiftKey && atLast) return 'first'
  return null
}

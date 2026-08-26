import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { Allocation, PanelId } from '../../sim/types'
import { SHELL_NAV_GROUPS, type ShellNavGroupId } from './navConfig'

export interface MobileNavTab {
  id: PanelId
  label: string
  hint: string
  group: ShellNavGroupId
}

/** The commercial core loop stays one tap away on compact screens. */
export const MOBILE_PRIMARY_TABS: readonly MobileNavTab[] = [
  { id: 'build', label: 'Build', hint: 'Place and expand', group: 'build' },
  { id: 'models', label: 'Models', hint: 'Train and release', group: 'products' },
  { id: 'plans', label: 'Plans', hint: 'Price and sell', group: 'products' },
  { id: 'data', label: 'Data', hint: 'Prepare corpora', group: 'products' },
] as const

const primaryIds = new Set<PanelId>(MOBILE_PRIMARY_TABS.map((tab) => tab.id))

/** Everything outside the primary loop remains available in the More sheet. */
export const MOBILE_MORE_SECTIONS = SHELL_NAV_GROUPS.map((group) => ({
  group: group.id,
  label: group.label,
  tabs: group.items
    .filter((item) => !primaryIds.has(item.id))
    .map((item) => ({
      id: item.id,
      label: item.label,
      hint: item.hint,
      group: group.id,
    } satisfies MobileNavTab)),
})).filter((section) => section.tabs.length > 0)

export const MOBILE_MORE_UTILITIES = [
  { id: 'intel', label: 'Intel', hint: 'P&L, rivals and world feed' },
  { id: 'objectives', label: 'Objectives', hint: 'Risks and next decisions' },
  { id: 'destroy', label: 'Destroy', hint: 'Sell or cancel map assets' },
] as const

export const COMPUTE_ALLOCATION_MIN = 0

export type ShellSwipeDirection = 'down' | 'left' | 'right'

export interface ShellGesturePoint {
  x: number
  y: number
  timeMs: number
}

export interface ShellGestureOptions {
  /** Minimum travel keeps taps and ordinary thumb jitter from navigating. */
  minimumDistance?: number
  /** A gesture must clearly favour one axis before the shell responds. */
  axisDominance?: number
  /** Long presses followed by a drag should remain inert. */
  maximumDurationMs?: number
}

const DEFAULT_GESTURE_OPTIONS: Required<ShellGestureOptions> = {
  minimumDistance: 52,
  axisDominance: 1.2,
  maximumDurationMs: 900,
}

/**
 * Resolve the three shell gestures we intentionally support. Upward drags are
 * left to native scrolling and ambiguous diagonal movement is ignored.
 */
export function classifyShellSwipe(
  start: ShellGesturePoint,
  end: ShellGesturePoint,
  options: ShellGestureOptions = {},
): ShellSwipeDirection | null {
  const resolved = { ...DEFAULT_GESTURE_OPTIONS, ...options }
  const elapsed = end.timeMs - start.timeMs
  if (elapsed < 0 || elapsed > resolved.maximumDurationMs) return null

  const dx = end.x - start.x
  const dy = end.y - start.y
  const absX = Math.abs(dx)
  const absY = Math.abs(dy)

  if (
    dy > 0 &&
    absY >= resolved.minimumDistance &&
    absY >= absX * resolved.axisDominance
  ) {
    return 'down'
  }
  if (
    absX >= resolved.minimumDistance &&
    absX >= absY * resolved.axisDominance
  ) {
    return dx < 0 ? 'left' : 'right'
  }
  return null
}

/** Mouse drags retain normal selection behaviour; touch and pen use gestures. */
export function isShellGesturePointer(pointerType: string, button: number): boolean {
  return (pointerType === 'touch' || pointerType === 'pen') && button === 0
}

const SHELL_GESTURE_BLOCKER = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  'label',
  'table',
  'details',
  'summary',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="slider"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="grid"]',
  '[role="table"]',
  '.panel-scroll',
  '.overflow-auto',
  '.overflow-x-auto',
  '.overflow-y-auto',
  '[data-swipe-ignore="true"]',
  '[data-mobile-scroll="true"]',
  '[data-shell-scroll-container="true"]',
  '[data-shell-gesture-ignore="true"]',
].join(',')

/**
 * Gesture capture is deliberately conservative. This prevents a shell swipe
 * from hijacking controls, tables, or a user's native scroll inside a panel.
 */
export function isShellGestureSafeTarget(target: EventTarget | null): boolean {
  const candidate = target as { closest?: (selector: string) => unknown } | null
  if (typeof candidate?.closest !== 'function') return false
  if (!candidate.closest('[data-shell-gesture-surface="true"]')) return false
  return !candidate.closest(SHELL_GESTURE_BLOCKER)
}

/** Adjacent primary destination for a horizontal handle swipe; edges do not wrap. */
export function mobilePrimaryPanelForSwipe(
  panel: PanelId,
  direction: Extract<ShellSwipeDirection, 'left' | 'right'>,
): PanelId | null {
  const index = MOBILE_PRIMARY_TABS.findIndex((tab) => tab.id === panel)
  if (index < 0) return null
  const next = index + (direction === 'left' ? 1 : -1)
  return MOBILE_PRIMARY_TABS[next]?.id ?? null
}

export interface ShellSwipeHandlers {
  onDown?: () => void
  onLeft?: () => void
  onRight?: () => void
}

/**
 * Pointer-event hook for a dedicated, non-interactive shell handle. It only
 * prevents the completed pointer event when a supported gesture wins.
 */
export function useShellSwipeGesture<T extends HTMLElement>(
  handlers: ShellSwipeHandlers,
  options: ShellGestureOptions = {},
) {
  const startRef = useRef<(ShellGesturePoint & { pointerId: number }) | null>(null)
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  const onPointerDown = (event: ReactPointerEvent<T>) => {
    if (
      !isShellGesturePointer(event.pointerType, event.button) ||
      !isShellGestureSafeTarget(event.target)
    ) {
      startRef.current = null
      return
    }
    startRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      timeMs: event.timeStamp,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerUp = (event: ReactPointerEvent<T>) => {
    const start = startRef.current
    startRef.current = null
    if (!start || start.pointerId !== event.pointerId) return
    const direction = classifyShellSwipe(
      start,
      { x: event.clientX, y: event.clientY, timeMs: event.timeStamp },
      options,
    )
    const actionKey = direction === 'down'
      ? 'onDown'
      : direction === 'left'
        ? 'onLeft'
        : direction === 'right'
          ? 'onRight'
          : null
    const action = actionKey ? handlersRef.current[actionKey] : undefined
    if (!action) return
    event.preventDefault()
    action()
  }

  const cancel = () => {
    startRef.current = null
  }

  return {
    onPointerDown,
    onPointerUp,
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
  }
}

/**
 * Preserve a proportional three-way split while allowing any individual queue
 * to be paused at exactly zero. A fully idle allocation remains all-zero.
 */
export function rebalanceComputeAllocation(
  allocation: Allocation,
  key: keyof Allocation,
  value: number,
): Allocation {
  const next = {
    ...allocation,
    [key]: Math.max(COMPUTE_ALLOCATION_MIN, value),
  }
  const sum = next.training + next.inference + next.research
  if (sum <= 0) return { training: 0, inference: 0, research: 0 }
  return {
    training: next.training / sum,
    inference: next.inference / sum,
    research: next.research / sum,
  }
}

import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { shouldDismissConsoleDialogSwipe } from './consoleDialogGesture'
import { HudButton } from './HudPrimitives'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const SWIPE_DISMISS_START = '.hud-dialog-grabber, .hud-dialog-header'
const SWIPE_DISMISS_EXCLUDED = [
  '[data-swipe-ignore="true"]',
  'a[href]',
  'button',
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
  '[data-mobile-scroll="true"]',
  '[data-shell-scroll-container="true"]',
  '[data-shell-gesture-ignore="true"]',
].join(',')

function canStartSwipeDismiss(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  if (target.closest(SWIPE_DISMISS_EXCLUDED)) return false
  return target.closest(SWIPE_DISMISS_START) != null
}

/**
 * Shared, viewport-level dialog for decision-heavy HUD flows. It deliberately
 * owns Escape and focus while open so map/game hotkeys cannot fire behind it.
 */
export function ConsoleDialog({
  open,
  titleId,
  eyebrow,
  title,
  description,
  mobileDescription,
  onClose,
  children,
  footer,
  maxWidthClass = 'max-w-3xl',
  closeLabel = 'Close dialog',
  canClose = true,
}: {
  open: boolean
  titleId: string
  eyebrow?: ReactNode
  title: ReactNode
  description?: ReactNode
  /** Optional concise replacement for `description` on compact screens. */
  mobileDescription?: ReactNode
  onClose: () => void
  children?: ReactNode
  footer?: ReactNode
  maxWidthClass?: string
  closeLabel?: string
  /** Some terminal game states must be resolved with an explicit action. */
  canClose?: boolean
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const swipeRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    startTime: number
  } | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const descriptionIds = [
    description ? `${titleId}-description` : '',
    mobileDescription ? `${titleId}-mobile-description` : '',
  ].filter(Boolean).join(' ') || undefined

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const frame = window.requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? dialogRef.current)?.focus()
    })
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (canClose) closeRef.current()
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', closeOnEscape, true)
      swipeRef.current = null
      previous?.focus()
    }
  }, [canClose, open])

  if (!open) return null

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keep ordinary game shortcuts from observing keys typed in the dialog.
    event.stopPropagation()
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter((element) => !element.hasAttribute('disabled'))
    if (!focusable.length) {
      event.preventDefault()
      dialogRef.current?.focus()
      return
    }
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const resetSwipe = (shell: HTMLDivElement) => {
    swipeRef.current = null
    shell.dataset.swipeState = 'idle'
    shell.style.setProperty('--hud-dialog-swipe-y', '0px')
  }

  const beginSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      !canClose ||
      !event.isPrimary ||
      event.pointerType === 'mouse' ||
      event.button !== 0 ||
      !canStartSwipeDismiss(event.target)
    ) return
    swipeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: event.timeStamp,
    }
    event.currentTarget.dataset.swipeState = 'dragging'
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const moveSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    const swipe = swipeRef.current
    if (!swipe || swipe.pointerId !== event.pointerId) return
    const deltaX = event.clientX - swipe.startX
    const deltaY = Math.max(0, event.clientY - swipe.startY)
    const mostlyVertical = deltaY > Math.abs(deltaX)
    event.currentTarget.style.setProperty('--hud-dialog-swipe-y', `${mostlyVertical ? deltaY : 0}px`)
    if (mostlyVertical && deltaY > 0 && event.cancelable) event.preventDefault()
  }

  const finishSwipe = (event: ReactPointerEvent<HTMLDivElement>, allowDismiss: boolean) => {
    const swipe = swipeRef.current
    if (!swipe || swipe.pointerId !== event.pointerId) return
    const shouldDismiss = allowDismiss && shouldDismissConsoleDialogSwipe({
      deltaX: event.clientX - swipe.startX,
      deltaY: event.clientY - swipe.startY,
      elapsedMs: event.timeStamp - swipe.startTime,
    })
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    resetSwipe(event.currentTarget)
    if (shouldDismiss) closeRef.current()
  }

  const dialog = (
    <div
      className="hud-dialog-backdrop pointer-events-auto fixed inset-0 z-[110] flex items-stretch justify-center bg-void/80 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        if (canClose && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionIds}
        tabIndex={-1}
        data-swipe-dismiss={canClose ? 'true' : 'false'}
        data-swipe-state="idle"
        onKeyDown={trapFocus}
        onPointerDown={beginSwipe}
        onPointerMove={moveSwipe}
        onPointerUp={(event) => finishSwipe(event, true)}
        onPointerCancel={(event) => finishSwipe(event, false)}
        onLostPointerCapture={(event) => {
          if (swipeRef.current?.pointerId === event.pointerId) resetSwipe(event.currentTarget)
        }}
        className={`hud-dialog-shell relative flex h-[100dvh] max-h-[100dvh] w-full ${maxWidthClass} flex-col overflow-hidden border-y-0 border-mint/25 bg-panel shadow-[0_30px_110px_rgba(0,7,11,0.78)] outline-none ring-1 ring-white/5 sm:h-auto sm:max-h-[92dvh] sm:rounded-xl sm:border`}
      >
        {canClose ? (
          <div className="hud-dialog-grabber" aria-hidden="true">
            <span />
          </div>
        ) : null}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-mint/80 to-transparent" />
        <header className="hud-dialog-header relative flex items-start justify-between gap-3 border-b border-line/70 bg-panel-2/70 px-3 pb-3 pt-[max(0.875rem,env(safe-area-inset-top))] sm:gap-5 sm:px-5 sm:py-4">
          <div className="min-w-0">
            {eyebrow ? (
              <p className="font-mono text-[0.625rem] uppercase tracking-[0.2em] text-mint">
                {eyebrow}
              </p>
            ) : null}
            <h2 id={titleId} className="mt-1 text-xl font-semibold tracking-tight text-bone sm:text-2xl">
              {title}
            </h2>
            {description ? (
              <p
                id={`${titleId}-description`}
                className={`mt-1 max-w-3xl text-[0.8125rem] leading-relaxed text-muted${mobileDescription ? ' hud-mobile-detail' : ''}`}
              >
                {description}
              </p>
            ) : null}
            {mobileDescription ? (
              <p
                id={`${titleId}-mobile-description`}
                className="hud-mobile-summary mt-1 max-w-3xl text-[0.8125rem] leading-relaxed text-muted"
              >
                {mobileDescription}
              </p>
            ) : null}
          </div>
          {canClose ? (
            <HudButton
              type="button"
              variant="ghost"
              aria-label={closeLabel}
              onClick={onClose}
              className="flex h-11 shrink-0 items-center justify-center rounded-md border border-line/70 bg-void/50 px-3 text-[0.6875rem] font-semibold text-muted transition hover:border-mint/40 hover:text-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50 sm:h-9"
            >
              Done
            </HudButton>
          ) : null}
        </header>
        <div
          className="hud-dialog-content panel-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5 sm:py-4"
          data-swipe-ignore="true"
        >
          {children}
        </div>
        {footer ? (
          <footer
            className="hud-dialog-footer border-t border-line/70 bg-void/35 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-5 sm:py-3"
            data-swipe-ignore="true"
          >
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  )

  if (typeof document === 'undefined') return dialog
  const hudRoot = document.querySelector<HTMLElement>('.ui-scale-root')
  return createPortal(dialog, hudRoot ?? document.body)
}

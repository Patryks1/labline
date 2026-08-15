import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from '@phosphor-icons/react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

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
  onClose: () => void
  children?: ReactNode
  footer?: ReactNode
  maxWidthClass?: string
  closeLabel?: string
  /** Some terminal game states must be resolved with an explicit action. */
  canClose?: boolean
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

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

  const dialog = (
    <div
      className="pointer-events-auto fixed inset-0 z-[110] flex items-stretch justify-center bg-void/80 p-0 backdrop-blur-sm sm:items-center sm:p-6"
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
        tabIndex={-1}
        onKeyDown={trapFocus}
        className={`relative flex h-[100dvh] max-h-[100dvh] w-full ${maxWidthClass} flex-col overflow-hidden border-y-0 border-mint/25 bg-panel shadow-[0_30px_110px_rgba(0,7,11,0.78)] outline-none ring-1 ring-white/5 sm:h-auto sm:max-h-[92dvh] sm:rounded-xl sm:border`}
      >
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-mint/80 to-transparent" />
        <header className="relative flex items-start justify-between gap-3 border-b border-line/70 bg-panel-2/70 px-3 pb-3 pt-[max(0.875rem,env(safe-area-inset-top))] sm:gap-5 sm:px-5 sm:py-4">
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
              <p className="mt-1 max-w-3xl text-[0.8125rem] leading-relaxed text-muted">
                {description}
              </p>
            ) : null}
          </div>
          {canClose ? (
            <button
              type="button"
              aria-label={closeLabel}
              onClick={onClose}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-line/70 bg-void/50 text-muted transition hover:border-mint/40 hover:text-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50 sm:h-9 sm:w-9"
            >
              <X size="1rem" />
            </button>
          ) : null}
        </header>
        <div className="panel-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5 sm:py-4">
          {children}
        </div>
        {footer ? (
          <footer className="border-t border-line/70 bg-void/35 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-5 sm:py-3">
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

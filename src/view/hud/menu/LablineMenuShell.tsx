import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { HudButton } from '../ui/HudPrimitives'
import { isMenuDismissSwipe, type GesturePoint } from './mobileOverlayGestures'

interface LablineMenuShellProps {
  variant: 'title' | 'pause'
  titleId: string
  onRequestClose?: () => void
  utilityNav?: ReactNode
  children?: ReactNode
  contentClassName?: string
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function LablineMenuShell({
  variant,
  titleId,
  onRequestClose,
  utilityNav,
  children,
  contentClassName = '',
}: LablineMenuShellProps) {
  const shellRef = useRef<HTMLDivElement>(null)
  const dismissSwipe = useRef<(GesturePoint & { pointerId: number }) | null>(null)

  useEffect(() => {
    if (variant !== 'pause') return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const first = shellRef.current
      ?.querySelector<HTMLElement>('.labline-menu-console')
      ?.querySelector<HTMLElement>(FOCUSABLE)
    window.requestAnimationFrame(() => (first ?? shellRef.current)?.focus())
    return () => previous?.focus()
  }, [variant])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (variant !== 'pause') return
    if (event.key === 'Escape' && onRequestClose) {
      event.preventDefault()
      event.stopPropagation()
      onRequestClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(shellRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter((element) => element.offsetParent !== null)
    if (focusable.length === 0) {
      event.preventDefault()
      shellRef.current?.focus()
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

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      variant !== 'pause' ||
      !onRequestClose ||
      event.pointerType !== 'touch' ||
      event.clientX > 36
    ) return
    dismissSwipe.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dismissSwipe.current
    dismissSwipe.current = null
    if (
      !start ||
      start.pointerId !== event.pointerId ||
      !onRequestClose ||
      !isMenuDismissSwipe(start, { x: event.clientX, y: event.clientY })
    ) return
    event.preventDefault()
    onRequestClose()
  }

  return (
    <div
      ref={shellRef}
      role={variant === 'pause' ? 'dialog' : 'main'}
      aria-modal={variant === 'pause' ? true : undefined}
      aria-labelledby={titleId}
      tabIndex={variant === 'pause' ? -1 : undefined}
      data-menu-variant={variant}
      data-has-utility={utilityNav ? 'true' : undefined}
      className={`labline-menu-shell main-menu-shell pointer-events-auto absolute inset-0 z-50 overflow-hidden bg-void text-bone ${variant === 'pause' ? 'labline-menu-shell--pause' : 'labline-menu-shell--title'}`}
      data-swipe-dismiss={variant === 'pause' && onRequestClose ? 'edge-right' : undefined}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { dismissSwipe.current = null }}
      onClick={variant === 'pause' && onRequestClose ? (event) => {
        const target = event.target as Element
        if (!target.closest('.labline-menu-console') && !target.closest('.labline-menu-logo')) {
          onRequestClose()
        }
      } : undefined}
    >
      {variant === 'title' ? (
        <>
          <img
            src="/assets/labline-menu-campus.png"
            alt=""
            aria-hidden="true"
            fetchPriority="high"
            decoding="async"
            className="main-menu-art absolute inset-0 h-full w-full object-cover"
          />
          <img
            src="/assets/labline-menu-campus.png"
            alt=""
            aria-hidden="true"
            decoding="async"
            className="main-menu-art main-menu-art--lights pointer-events-none absolute inset-0 h-full w-full object-cover"
          />
        </>
      ) : null}
      <div className="main-menu-shade pointer-events-none absolute inset-0" />
      <div className="main-menu-grid pointer-events-none absolute inset-0" />

      <header className={`labline-menu-logo pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-16 text-center ${variant === 'pause' ? '[@media(max-height:540px)]:hidden' : ''}`}>
        <div className="labline-menu-brand flex flex-col items-center">
          <img
            src="/assets/labline-emblem-v2.png?v=2"
            alt=""
            aria-hidden="true"
            className="labline-menu-emblem object-contain"
          />
          <h1 id={titleId} className="labline-menu-wordmark font-semibold uppercase text-bone">
            LABLINE
          </h1>
          <p className="labline-menu-tagline font-mono uppercase text-mint">Frontier operations</p>
        </div>
      </header>

      {variant === 'pause' && onRequestClose ? (
        <HudButton
          type="button"
          variant="ghost"
          onClick={onRequestClose}
          className="absolute right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] z-20 flex min-h-11 items-center justify-center border border-line bg-void/70 px-3 text-[0.6875rem] font-semibold text-muted backdrop-blur hover:border-mint/40 hover:text-bone max-sm:hidden [@media(max-height:540px)]:hidden"
        >
          Resume
        </HudButton>
      ) : null}

      <div className={`labline-menu-stage relative z-[1] h-full min-h-0 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:px-8 ${variant === 'pause' ? '[@media(max-height:540px)]:!pt-[max(0.5rem,env(safe-area-inset-top))] [@media(max-height:540px)]:!pb-[max(0.5rem,env(safe-area-inset-bottom))]' : ''} ${utilityNav ? 'labline-menu-stage--with-utility' : 'flex items-center justify-center'}`}>
        {utilityNav ? (
          <nav aria-label="Menu utilities" className="labline-menu-utility min-w-0 max-sm:hidden [@media(max-height:540px)]:hidden">
            {utilityNav}
          </nav>
        ) : null}
        <section
          className={`labline-menu-console panel-scroll relative min-w-0 w-full justify-self-center overflow-x-hidden overflow-y-auto overscroll-contain touch-pan-y border border-line/80 bg-panel/94 shadow-[0_30px_100px_rgba(0,8,12,.62)] backdrop-blur-xl ${contentClassName}`}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-mint/80 via-mint/20 to-transparent" />
          {children}
        </section>
      </div>

    </div>
  )
}

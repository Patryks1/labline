import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { X } from '@phosphor-icons/react'

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
      onKeyDown={onKeyDown}
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

      <header className="labline-menu-logo pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-16 text-center">
        <div className="labline-menu-brand flex flex-col items-center">
          <img
            src="/assets/labline-emblem-v2.png"
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
        <button
          type="button"
          onClick={onRequestClose}
          aria-label="Close pause menu"
          className="absolute right-4 top-4 z-20 flex min-h-11 min-w-11 items-center justify-center border border-line bg-void/70 text-muted backdrop-blur hover:border-mint/40 hover:text-bone"
        >
          <X size="1.1rem" />
        </button>
      ) : null}

      <div className={`labline-menu-stage relative z-[1] h-full min-h-0 px-4 pb-5 sm:px-8 ${utilityNav ? 'labline-menu-stage--with-utility' : 'flex items-center justify-center'}`}>
        {utilityNav ? (
          <nav aria-label="Menu utilities" className="labline-menu-utility min-w-0">
            {utilityNav}
          </nav>
        ) : null}
        <section
          className={`labline-menu-console panel-scroll relative w-full justify-self-center overflow-y-auto border border-line/80 bg-panel/94 shadow-[0_30px_100px_rgba(0,8,12,.62)] backdrop-blur-xl ${contentClassName}`}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-mint/80 via-mint/20 to-transparent" />
          {children}
        </section>
      </div>

    </div>
  )
}

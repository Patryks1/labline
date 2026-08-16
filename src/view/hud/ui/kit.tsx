import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { HudMeter } from './HudPrimitives'

/**
 * UI Revamp kit - the shared building blocks for the gamified HUD.
 * See docs/ui-revamp-design-system.md. Prefer these over ad-hoc markup.
 */

/* ── GameCard: the ONE card primitive ─────────────────────────────── */

export function GameCard({
  eyebrow,
  title,
  actions,
  tone,
  live,
  pad = true,
  interactive = false,
  selected,
  ariaLabel,
  onActivate,
  className = '',
  children,
}: {
  eyebrow?: string
  title?: ReactNode
  actions?: ReactNode
  /** One accent per card. */
  tone?: 'mint' | 'train' | 'infer' | 'research' | 'danger' | 'gold'
  /** Pulsing border for in-progress work. */
  live?: boolean
  pad?: boolean
  /** Opt into keyboard/click semantics when an activation callback is supplied. */
  interactive?: boolean
  /** Selected state for a card used as a single-level choice. */
  selected?: boolean
  ariaLabel?: string
  onActivate?: () => void
  className?: string
  children: ReactNode
}) {
  const headingId = `hud-card-title-${useId().replace(/:/g, '')}`
  const toneColor = tone
    ? ({ '--live-glow-color': `var(--color-${tone})` } as React.CSSProperties)
    : undefined
  const isInteractive = interactive && onActivate != null
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!isInteractive || !onActivate || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    onActivate()
  }
  return (
    <section
      style={toneColor}
      aria-labelledby={title ? headingId : undefined}
      aria-label={title ? undefined : ariaLabel}
      aria-current={selected ? 'true' : undefined}
      aria-pressed={isInteractive && selected !== undefined ? selected : undefined}
      data-interactive={interactive ? 'true' : undefined}
      data-selected={selected !== undefined ? String(selected) : undefined}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      onClick={isInteractive ? onActivate : undefined}
      onKeyDown={onKeyDown}
      className={`hud-card rounded-lg border bg-panel-2/70 ${
        live ? 'live-glow border-transparent' : 'border-line/70'
      } ${interactive ? 'hud-card--interactive' : ''} ${selected ? 'hud-card--selected' : ''} ${className}`}
    >
      {title || actions ? (
        <header className="flex items-start justify-between gap-2 border-b border-line/50 px-3 pb-2 pt-2.5">
          <div className="min-w-0">
            {eyebrow ? <p className="hud-eyebrow">{eyebrow}</p> : null}
            {title ? (
              <h3 id={headingId} className="mt-0.5 truncate text-sm font-semibold text-bone">
                {title}
              </h3>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}
      <div className={pad ? 'p-3' : ''}>{children}</div>
    </section>
  )
}

/* ── SegmentedTabs: fixed-height animated tab strip ───────────────── */

export interface SegmentedTabItem {
  id: string
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
  title?: string
  /** Optional spoken label when the visible label includes state-only adornments. */
  ariaLabel?: string
  /** Optional ID of the panel controlled by this single-level tab. */
  panelId?: string
}

export function SegmentedTabs({
  items,
  active,
  onChange,
  ariaLabel,
  idPrefix,
}: {
  items: SegmentedTabItem[]
  active: string
  onChange: (id: string) => void
  ariaLabel?: string
  idPrefix?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)
  const generatedId = useId().replace(/:/g, '')
  const resolvedIdPrefix = idPrefix ?? `hud-tabs-${generatedId}`

  const moveFocus = (nextId: string) => {
    onChange(nextId)
    const focus = () => tabRefs.current[nextId]?.focus()
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus)
    else focus()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, itemIndex: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowDown' && event.key !== 'ArrowLeft' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    const enabledItems = items.filter((item) => !item.disabled)
    const currentEnabledIndex = enabledItems.findIndex((item) => item.id === items[itemIndex]?.id)
    if (currentEnabledIndex < 0 || enabledItems.length === 0) return
    const offset = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? enabledItems.length - 1 : (currentEnabledIndex + offset + enabledItems.length) % enabledItems.length
    const nextItem = enabledItems[nextIndex]
    if (!nextItem) return
    event.preventDefault()
    moveFocus(nextItem.id)
  }

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const update = () => {
      const activeEl = root.querySelector<HTMLElement>('[aria-selected="true"]')
      if (!activeEl) {
        setIndicator(null)
        return
      }
      const rootBox = root.getBoundingClientRect()
      const box = activeEl.getBoundingClientRect()
      setIndicator({ left: box.left - rootBox.left, width: box.width })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(root)
    return () => observer.disconnect()
  }, [active, items])

  return (
    <div
      ref={rootRef}
      role="tablist"
      aria-label={ariaLabel}
      className="seg-tabs"
      style={{ gridTemplateColumns: `repeat(${Math.max(1, items.length)}, minmax(0, 1fr))` }}
    >
      {indicator ? (
        <span
          aria-hidden
          className="seg-tabs__indicator"
          style={{ left: indicator.left, width: indicator.width }}
        />
      ) : null}
      {items.map((item, index) => {
        const on = item.id === active
        return (
          <button
            key={item.id}
            id={`${resolvedIdPrefix}-${item.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
            ref={(element) => {
              tabRefs.current[item.id] = element
            }}
            type="button"
            role="tab"
            aria-selected={on}
            aria-label={item.ariaLabel}
            aria-controls={item.panelId}
            tabIndex={on ? 0 : -1}
            disabled={item.disabled}
            title={item.title}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className="seg-tabs__tab disabled:opacity-40"
          >
            {item.icon}
            <span className="truncate">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/* ── StatRow: ledger-style label/value line ───────────────────────── */

export function StatRow({
  label,
  value,
  hint,
  tone = 'neutral',
  strong,
}: {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  tone?: 'neutral' | 'positive' | 'warning' | 'danger' | 'serve' | 'research' | 'train' | 'gold'
  strong?: boolean
}) {
  const valueTone = {
    neutral: 'text-bone',
    positive: 'text-mint',
    warning: 'text-amber',
    danger: 'text-danger',
    serve: 'text-infer',
    research: 'text-research',
    train: 'text-train',
    gold: 'text-gold',
  }[tone]
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 py-1">
      <span className="min-w-0 truncate text-[0.8125rem] text-muted" title={typeof hint === 'string' ? hint : undefined}>
        {label}
      </span>
      <span
        className={`shrink-0 font-mono text-[0.8125rem] tabular-nums ${valueTone} ${
          strong ? 'font-semibold' : ''
        }`}
      >
        {value}
      </span>
    </div>
  )
}

/* ── MeterBar: labeled progress with tone + live shimmer ──────────── */

export function MeterBar({
  label,
  value,
  detail,
  tone = 'positive',
  live = false,
}: {
  label?: ReactNode
  /** 0..1 */
  value: number
  detail?: ReactNode
  tone?: 'positive' | 'warning' | 'danger' | 'serve' | 'research' | 'train'
  live?: boolean
}) {
  return <HudMeter value={value} label={label} detail={detail} tone={tone} live={live} />
}

/* ── BlockerList: why an action is unavailable ────────────────────── */

export interface Blocker {
  icon?: ReactNode
  text: ReactNode
  tone?: 'danger' | 'warning'
}

export function BlockerList({ items, live = false }: { items: Blocker[]; live?: boolean }) {
  if (items.length === 0) return null
  return (
    <ul
      className="space-y-1 rounded-md border border-danger/25 bg-danger/5 px-2.5 py-2"
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
      aria-atomic={live ? 'true' : undefined}
    >
      {items.map((item, i) => (
        <li
          key={i}
          className={`flex items-center gap-2 text-[0.75rem] ${
            item.tone === 'warning' ? 'text-amber' : 'text-danger'
          }`}
        >
          {item.icon ?? <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-current" />}
          <span className="min-w-0">{item.text}</span>
        </li>
      ))}
    </ul>
  )
}

/* ── LiveDot: pulsing activity dot ────────────────────────────────── */

export function LiveDot({ className = 'text-mint' }: { className?: string }) {
  return <span aria-hidden className={`live-dot ${className}`} />
}

/* ── CardGrid: responsive grid for repeated cards ─────────────────── */

export function CardGrid({
  min = '13rem',
  className = '',
  children,
}: {
  min?: string
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={`grid gap-2.5 ${className}`}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}, 1fr))` }}
    >
      {children}
    </div>
  )
}

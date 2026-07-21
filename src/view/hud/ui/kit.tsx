import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

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
  className?: string
  children: ReactNode
}) {
  const toneColor = tone
    ? ({ '--live-glow-color': `var(--color-${tone})` } as React.CSSProperties)
    : undefined
  return (
    <section
      style={toneColor}
      className={`rounded-lg border bg-panel-2/70 ${
        live ? 'live-glow border-transparent' : 'border-line/70'
      } ${className}`}
    >
      {title || actions ? (
        <header className="flex items-start justify-between gap-2 border-b border-line/50 px-3 pb-2 pt-2.5">
          <div className="min-w-0">
            {eyebrow ? <p className="hud-eyebrow">{eyebrow}</p> : null}
            {title ? (
              <h3 className="mt-0.5 truncate text-sm font-semibold text-bone">{title}</h3>
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
}

export function SegmentedTabs({
  items,
  active,
  onChange,
  ariaLabel,
}: {
  items: SegmentedTabItem[]
  active: string
  onChange: (id: string) => void
  ariaLabel?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)

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
      {items.map((item) => {
        const on = item.id === active
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={on}
            disabled={item.disabled}
            title={item.title}
            onClick={() => onChange(item.id)}
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
  tone?: 'neutral' | 'positive' | 'warning' | 'danger' | 'serve' | 'research'
  strong?: boolean
}) {
  const valueTone =
    tone === 'positive'
      ? 'text-mint'
      : tone === 'warning'
        ? 'text-amber'
        : tone === 'danger'
          ? 'text-danger'
          : tone === 'serve'
            ? 'text-infer'
            : tone === 'research'
              ? 'text-research'
              : 'text-bone'
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
  const clamped = Math.max(0, Math.min(1, value))
  const fill =
    tone === 'positive'
      ? 'bg-mint'
      : tone === 'warning'
        ? 'bg-amber'
        : tone === 'danger'
          ? 'bg-danger'
          : tone === 'serve'
            ? 'bg-infer'
            : tone === 'train'
              ? 'bg-train'
              : 'bg-research'
  return (
    <div className="min-w-0">
      {label || detail ? (
        <div className="mb-1 flex items-baseline justify-between gap-2 text-[0.6875rem]">
          <span className="min-w-0 truncate text-muted">{label}</span>
          <span className="shrink-0 font-mono tabular-nums text-bone">{detail}</span>
        </div>
      ) : null}
      <div className="h-1.5 overflow-hidden rounded-full bg-void/80">
        <div
          className={`h-full rounded-full ${fill} ${live ? 'meter-live' : ''} transition-[width] duration-300 ease-out`}
          style={{ width: `${clamped * 100}%` }}
        />
      </div>
    </div>
  )
}

/* ── BlockerList: why an action is unavailable ────────────────────── */

export interface Blocker {
  icon?: ReactNode
  text: ReactNode
  tone?: 'danger' | 'warning'
}

export function BlockerList({ items }: { items: Blocker[] }) {
  if (items.length === 0) return null
  return (
    <ul className="space-y-1 rounded-md border border-danger/25 bg-danger/5 px-2.5 py-2">
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

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { consumeChartEscape } from './chartInteraction'

export interface DonutSlice {
  id: string
  label: string
  value: number
  color: string
}

export interface ResponsiveDonutProps {
  slices: DonutSlice[]
  centerLabel: ReactNode
  caption?: ReactNode
  ariaLabel: string
  valueFormatter?: (value: number) => string
  className?: string
  breakpoint?: string
}

const RADIUS = 34
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function sliceLabel(slice: DonutSlice, format: (value: number) => string): string {
  return `${slice.label}: ${format(Math.max(0, slice.value))}`
}

/**
 * Shared responsive capacity/power mix chart. Desktop gets a compact donut;
 * narrow layouts get a tappable stacked bar. Both surfaces share the same
 * keyboard, hover, pin, and accessible legend behavior.
 */
export function ResponsiveDonut({
  slices,
  centerLabel,
  caption,
  ariaLabel,
  valueFormatter = (value) => String(value),
  className,
  breakpoint = 'min-[400px]',
}: ResponsiveDonutProps) {
  const readoutId = useId()
  const sliceButtons = useRef<Array<SVGCircleElement | null>>([])
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const safeSlices = slices.map((slice) => ({ ...slice, value: Math.max(0, slice.value) }))
  const total = safeSlices.reduce((sum, slice) => sum + slice.value, 0)
  const drawableSlices = safeSlices.filter((slice) => slice.value > 0)
  const activeId = pinnedId ?? hoveredId
  const activeSlice = safeSlices.find((slice) => slice.id === activeId)
  const arcs = drawableSlices.map((slice) => {
    const length = total > 0 ? (slice.value / total) * CIRCUMFERENCE : 0
    return { ...slice, length, sourceIndex: safeSlices.findIndex((entry) => entry.id === slice.id) }
  })
  let offset = 0

  const togglePin = (id: string) => {
    setPinnedId((current) => (current === id ? null : id))
  }

  const moveFocus = (event: KeyboardEvent<Element>, currentIndex: number) => {
    const key = event.key
    if (key === 'Enter' || key === ' ') {
      event.preventDefault()
      const slice = safeSlices[currentIndex]
      if (slice) togglePin(slice.id)
      return
    }
    if (key === 'Escape') {
      consumeChartEscape(event, () => setPinnedId(null))
      return
    }
    let nextIndex: number | null = null
    if (key === 'ArrowRight' || key === 'ArrowDown') nextIndex = Math.min(safeSlices.length - 1, currentIndex + 1)
    else if (key === 'ArrowLeft' || key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1)
    else if (key === 'Home') nextIndex = 0
    else if (key === 'End') nextIndex = Math.max(0, safeSlices.length - 1)
    if (nextIndex == null) return
    event.preventDefault()
    const next = safeSlices[nextIndex]
    if (!next) return
    setHoveredId(next.id)
    sliceButtons.current[nextIndex]?.focus()
  }

  const sliceEvents = (slice: DonutSlice, index: number) => ({
    onPointerEnter: () => setHoveredId(slice.id),
    onPointerLeave: () => setHoveredId(null),
    onFocus: () => setHoveredId(slice.id),
    onBlur: () => setHoveredId(null),
    onClick: () => togglePin(slice.id),
    onKeyDown: (event: KeyboardEvent<Element>) => moveFocus(event, index),
  })

  return (
    <div
      className={`hud-chart-frame w-full min-w-0 ${breakpoint}:w-24 ${breakpoint}:shrink-0 ${className ?? ''}`}
      data-mobile-chart="true"
      data-chart-kind="donut"
      data-swipe-ignore="true"
    >
      <div className={`relative hidden h-24 w-24 max-w-full ${breakpoint}:block`}>
        <svg
          viewBox="0 0 88 88"
          width="88"
          height="88"
          className="h-24 w-24 max-w-full touch-pan-y"
          role="group"
          aria-roledescription="donut chart"
          aria-label={ariaLabel}
          aria-describedby={readoutId}
        >
          <circle
            cx="44"
            cy="44"
            r={RADIUS}
            fill="none"
            stroke="rgba(139,171,181,.22)"
            strokeWidth="10"
          />
          {arcs.map((arc) => {
            const start = offset
            offset += arc.length
            const active = activeId === arc.id
            return (
              <circle
                key={arc.id}
                ref={(element) => {
                  sliceButtons.current[arc.sourceIndex] = element
                }}
                cx="44"
                cy="44"
                r={RADIUS}
                fill="none"
                stroke={arc.color}
                strokeWidth={active ? '12' : '10'}
                strokeDasharray={`${arc.length} ${CIRCUMFERENCE - arc.length}`}
                strokeDashoffset={CIRCUMFERENCE * 0.25 - start}
                strokeLinecap="butt"
                tabIndex={0}
                role="button"
                aria-label={sliceLabel(arc, valueFormatter)}
                aria-pressed={pinnedId === arc.id}
                {...sliceEvents(arc, arc.sourceIndex)}
              />
            )
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <strong className="max-w-[4.5rem] truncate font-mono text-sm font-semibold tabular-nums text-bone">
            {centerLabel}
          </strong>
        </div>
      </div>

      <div className={`${breakpoint}:hidden`} role="group" aria-label={ariaLabel} aria-describedby={readoutId}>
        <div
          className="relative flex h-11 w-full items-center overflow-x-auto"
          data-mobile-scroll="true"
          data-swipe-ignore="true"
        >
          <span
            className="pointer-events-none absolute inset-x-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-void/80"
            aria-hidden="true"
          />
          {arcs.map((arc, index) => (
            <button
              key={arc.id}
              type="button"
              className="relative z-10 flex h-11 min-w-11 shrink-0 items-center p-0 transition-opacity"
              style={{ width: `${total > 0 ? (arc.value / total) * 100 : 0}%` }}
              aria-label={sliceLabel(arc, valueFormatter)}
              aria-pressed={pinnedId === arc.id}
              {...sliceEvents(arc, arc.sourceIndex)}
            >
              <span
                className={`block h-2.5 w-full ${index === 0 ? 'rounded-l-full' : ''} ${index === arcs.length - 1 ? 'rounded-r-full' : ''}`}
                style={{ background: arc.color }}
                aria-hidden="true"
              />
            </button>
          ))}
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-2 font-mono text-[0.625rem] tabular-nums text-muted">
          {safeSlices.map((slice) => (
            <span key={slice.id} className="min-w-0 truncate">
              {slice.label} {valueFormatter(slice.value)}
            </span>
          ))}
        </div>
      </div>

      <div className="sr-only" aria-label={`${ariaLabel} legend`}>
        {safeSlices.map((slice, index) => (
          <button
            key={slice.id}
            type="button"
            aria-pressed={pinnedId === slice.id}
            {...sliceEvents(slice, index)}
          >
            {sliceLabel(slice, valueFormatter)}
          </button>
        ))}
      </div>

      <div id={readoutId} className="sr-only" aria-live="polite">
        {activeSlice
          ? `${sliceLabel(activeSlice, valueFormatter)}${pinnedId === activeSlice.id ? ', pinned' : ''}`
          : `${ariaLabel}. No slice selected.`}
      </div>

      {caption != null ? (
        <p className="mt-1 truncate text-center text-[0.625rem] uppercase tracking-[0.12em] text-muted">
          {caption}
        </p>
      ) : null}
    </div>
  )
}

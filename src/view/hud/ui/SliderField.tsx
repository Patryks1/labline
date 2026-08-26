/**
 * Compact dual control: range + numeric readout for 0–1 fractions or free ranges.
 * Optional hover panel for dense breakdowns (compute pools).
 */
import { useId, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import { HudRange } from './HudPrimitives'

export function SliderField({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  format = (v) => `${Math.round(v * 100)}%`,
  colorClass = 'bg-mint',
  accentClass = 'text-bone',
  hoverContent,
  hint = Boolean(hoverContent),
  sublabel,
  ariaValueText,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  format?: (v: number) => string
  colorClass?: string
  accentClass?: string
  /** Rich panel shown above the slider on hover/focus */
  hoverContent?: ReactNode
  /** Info mark without rendering an inline tooltip (host can lift the flyout). */
  hint?: boolean
  /** Secondary line under the label — live PF bar or mono stats */
  sublabel?: ReactNode
  /** Accessible value when the physical range uses a transformed scale. */
  ariaValueText?: string
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  const generatedId = useId().replace(/:/g, '')
  const labelId = `slider-field-label-${generatedId}`
  const tooltipId = `slider-field-tooltip-${generatedId}`
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const closeTooltipOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    setTooltipOpen(false)
  }
  const closeTooltipOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !tooltipOpen) return
    event.preventDefault()
    event.stopPropagation()
    setTooltipOpen(false)
  }

  return (
    <div
      className="slider-field group/slider relative block min-w-0"
      data-tooltip-open={tooltipOpen ? 'true' : 'false'}
      data-swipe-ignore="true"
      onPointerEnter={hoverContent ? (event) => {
        if (event.pointerType === 'mouse') setTooltipOpen(true)
      } : undefined}
      onPointerLeave={hoverContent ? (event) => {
        if (event.pointerType !== 'mouse') return
        if (
          document.activeElement instanceof Node &&
          event.currentTarget.contains(document.activeElement)
        ) return
        setTooltipOpen(false)
      } : undefined}
      onBlurCapture={closeTooltipOnBlur}
      onKeyDown={closeTooltipOnEscape}
    >
      {hoverContent && (
        <div
          id={tooltipId}
          className={`${tooltipOpen ? 'pointer-events-auto block' : 'pointer-events-none hidden'} slider-field__tooltip absolute bottom-[calc(100%+0.4rem)] left-1/2 z-50 w-[min(18.5rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-line bg-panel/98 p-2.5 shadow-2xl shadow-black/50 backdrop-blur-md`}
          role="tooltip"
        >
          {hoverContent}
        </div>
      )}
      <div className="mb-0.5 flex min-w-0 items-baseline justify-between gap-2 text-[0.75rem]">
        <span className="flex min-w-0 items-center text-muted">
          <span id={labelId} className="min-w-0 truncate">{label}</span>
          {hint && (
            <button
              type="button"
              className="slider-field__hint ml-1 shrink-0 text-[0.6875rem] text-muted/70"
              aria-label={`${hoverContent ? (tooltipOpen ? 'Hide' : 'Show') : 'Open'} ${label} breakdown`}
              aria-expanded={hoverContent ? tooltipOpen : undefined}
              aria-controls={hoverContent ? tooltipId : undefined}
              title={`${hoverContent ? (tooltipOpen ? 'Hide' : 'Show') : 'Open'} ${label} breakdown`}
              data-mobile-disclosure="true"
              onClick={hoverContent ? () => setTooltipOpen((open) => !open) : undefined}
            >
              ⓘ
            </button>
          )}
        </span>
        <span className={`shrink-0 font-mono ${accentClass}`}>{format(value)}</span>
      </div>
      {sublabel != null ? (
        <div className="mb-0.5 min-w-0">{sublabel}</div>
      ) : null}
      <div className="relative h-1.5 overflow-hidden rounded-full bg-void">
        <div
          className={`absolute inset-y-0 left-0 ${colorClass} opacity-90`}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
        <HudRange
          min={min}
          max={max}
          step={step}
          value={value}
          aria-labelledby={labelId}
          aria-describedby={hoverContent ? tooltipId : undefined}
          aria-valuetext={ariaValueText}
          onFocus={hoverContent ? () => setTooltipOpen(true) : undefined}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-x-0 top-1/2 h-11 w-full -translate-y-1/2 cursor-pointer opacity-0"
        />
      </div>
    </div>
  )
}

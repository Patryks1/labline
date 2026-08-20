/**
 * Compact dual control: range + numeric readout for 0–1 fractions or free ranges.
 * Optional hover panel for dense breakdowns (compute pools).
 */
import type { ReactNode } from 'react'
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
  /** Secondary mono line under the label (e.g. PF · util) */
  sublabel?: string
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <label className="group/slider relative block min-w-0">
      {hoverContent && (
        <div
          className="pointer-events-none absolute bottom-[calc(100%+0.4rem)] left-1/2 z-50 hidden w-[min(18.5rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-line bg-panel/98 p-2.5 shadow-2xl shadow-black/50 backdrop-blur-md group-hover/slider:block group-focus-within/slider:block"
          role="tooltip"
        >
          {hoverContent}
        </div>
      )}
      <div className="mb-0.5 flex min-w-0 items-baseline justify-between gap-2 text-[0.75rem]">
        <span className="min-w-0 truncate text-muted">
          {label}
          {hint && (
            <span className="ml-1 text-[0.6875rem] text-muted/70" title="Hover for breakdown">
              ⓘ
            </span>
          )}
        </span>
        <span className={`shrink-0 font-mono ${accentClass}`}>{format(value)}</span>
      </div>
      {sublabel && (
        <div
          className="mb-0.5 truncate font-mono text-[0.6875rem] leading-tight text-muted/90"
          title={sublabel}
        >
          {sublabel}
        </div>
      )}
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
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-x-0 top-1/2 h-11 w-full -translate-y-1/2 cursor-pointer opacity-0"
        />
      </div>
    </label>
  )
}

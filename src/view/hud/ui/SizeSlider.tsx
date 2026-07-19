import { useEffect, useMemo, useState } from 'react'
import { formatParams, PARAM_PRESETS } from '../../../sim/balance/training'

/**
 * Discrete model-size control: range snaps to common stops + free numeric box.
 * Value is always params in billions.
 */
export function SizeSlider({
  label,
  value,
  onChange,
  min = 0.007,
  max = 30_000,
  stops,
}: {
  label: string
  value: number
  onChange: (paramsB: number) => void
  min?: number
  max?: number
  /** Defaults to PARAM_PRESETS in range */
  stops?: { label: string; paramsB: number }[]
}) {
  const marks = useMemo(() => {
    const base =
      stops ??
      PARAM_PRESETS.filter((p) => p.paramsB >= min && p.paramsB <= max).map((p) => ({
        label: p.label,
        paramsB: p.paramsB,
      }))
    return base.length > 0 ? base : [{ label: formatParams(min), paramsB: min }]
  }, [stops, min, max])

  const idx = nearestIndex(marks, value)
  const [box, setBox] = useState(() => formatBox(value))
  useEffect(() => {
    setBox(formatBox(value))
  }, [value])

  const commitBox = () => {
    const parsed = parseParamsBox(box)
    if (parsed != null) onChange(clamp(parsed, min, max))
    else setBox(formatBox(value))
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[0.8125rem] text-muted">{label}</span>
        <input
          type="text"
          inputMode="decimal"
          value={box}
          onChange={(event) => setBox(event.target.value)}
          onBlur={commitBox}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          }}
          className="w-24 rounded-md border border-line bg-void px-2 py-1 text-right font-mono text-xs text-bone outline-none focus:border-mint/50"
          aria-label={`${label} exact`}
        />
      </div>

      <div className="relative pt-0.5">
        <input
          type="range"
          min={0}
          max={marks.length - 1}
          step={1}
          value={idx}
          onChange={(e) => {
            const m = marks[Number(e.target.value)]
            if (m) onChange(m.paramsB)
          }}
          className="slider-track w-full"
          aria-label={label}
          aria-valuetext={formatParams(value)}
        />
      </div>

      <div className="flex items-center justify-between font-mono text-[0.6875rem] text-muted">
        <span>{marks[0]?.label}</span>
        <span className="text-mint">{marks[idx]?.label} · {idx + 1}/{marks.length}</span>
        <span>{marks.at(-1)?.label}</span>
      </div>
    </div>
  )
}

function nearestIndex(marks: { paramsB: number }[], value: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < marks.length; i++) {
    const d = Math.abs(Math.log(marks[i]!.paramsB + 1e-9) - Math.log(value + 1e-9))
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

/** Accept "7", "7B", "70M", "1.8T" */
function parseParamsBox(raw: string): number | null {
  const s = raw.trim().toUpperCase().replace(/\s/g, '')
  if (!s) return null
  const m = s.match(/^([0-9]*\.?[0-9]+)([KMBT])?$/)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const u = m[2] ?? 'B'
  if (u === 'T') return n * 1000
  if (u === 'M') return n / 1000
  if (u === 'K') return n / 1e6
  return n
}

function formatBox(paramsB: number): string {
  if (paramsB >= 1000) return `${paramsB / 1000}T`
  if (paramsB >= 1) return String(paramsB)
  if (paramsB >= 0.001) return `${paramsB * 1000}M`
  return `${paramsB * 1e6}K`
}

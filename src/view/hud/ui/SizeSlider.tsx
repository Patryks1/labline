import { useEffect, useMemo, useState } from 'react'
import { formatParams, PARAM_PRESETS } from '../../../sim/balance/training'
import { parseParamsBox, type SizeUnit } from './modelSize'
import { HudInput, HudRange, HudSelect } from './HudPrimitives'

const MAJOR_MODEL_MARKS = new Set([
  '7M',
  '400M',
  '1B',
  '7B',
  '70B',
  '405B',
  '1T',
  '7T',
  '30T',
])

/** Log-shaped model-scale timeline with common checkpoints and an exact M/B/T editor. */
export function SizeSlider({
  label,
  value,
  onChange,
  min = 0.007,
  max = 30_000,
  stops,
  disabled = false,
  disabledReason,
}: {
  label: string
  value: number
  onChange: (paramsB: number) => void
  min?: number
  max?: number
  stops?: { label: string; paramsB: number }[]
  disabled?: boolean
  disabledReason?: string
}) {
  const marks = useMemo(() => {
    const base =
      stops ??
      PARAM_PRESETS.filter((preset) => preset.paramsB >= min && preset.paramsB <= max).map(
        (preset) => ({ label: preset.label, paramsB: preset.paramsB }),
      )
    return base.length > 0 ? base : [{ label: formatParams(min), paramsB: min }]
  }, [stops, min, max])
  const idx = nearestIndex(marks, value)
  const initial = formatParts(value)
  const [box, setBox] = useState(initial.value)
  const [unit, setUnit] = useState<SizeUnit>(initial.unit)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    const next = formatParts(value)
    setBox(next.value)
    setUnit(next.unit)
    setInvalid(false)
  }, [value])

  const commit = (raw = box, selectedUnit = unit) => {
    const parsed = parseParamsBox(raw, selectedUnit)
    if (parsed == null) {
      const next = formatParts(value)
      setBox(next.value)
      setUnit(next.unit)
      setInvalid(true)
      return
    }
    setInvalid(false)
    onChange(clamp(parsed, min, max))
  }

  const logMin = Math.log10(marks[0]?.paramsB ?? min)
  const logMax = Math.log10(marks[marks.length - 1]?.paramsB ?? max)
  const currentLog = Math.log10(marks[idx]?.paramsB ?? value)
  const fillPct =
    logMax === logMin ? 0 : ((currentLog - logMin) / (logMax - logMin)) * 100

  return (
    <div
      className={`model-size-control ${disabled ? 'opacity-70' : ''}`}
      data-model-size="true"
    >
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[0.6875rem] text-muted">{label}</p>
          <p className="mt-0.5 font-mono text-lg font-medium tabular-nums tracking-tight text-bone">
            {formatParams(value)}
          </p>
        </div>
        <div
          className={`flex overflow-hidden rounded-md border bg-void ${
            invalid
              ? 'border-danger'
              : 'border-line focus-within:border-mint/50'
          }`}
        >
          <HudInput
            type="text"
            inputMode="decimal"
            value={box}
            disabled={disabled}
            onChange={(event) => {
              setBox(event.target.value)
              setInvalid(false)
            }}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData('text')
              const parsed = parseParamsBox(pasted, unit)
              if (parsed == null) return
              event.preventDefault()
              const next = formatParts(clamp(parsed, min, max))
              setBox(next.value)
              setUnit(next.unit)
              onChange(clamp(parsed, min, max))
            }}
            onBlur={() => commit()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
            }}
            className="w-20 border-0 bg-transparent px-2 py-1 text-right font-mono text-xs outline-none"
            aria-label={`${label} exact`}
            aria-invalid={invalid}
          />
          <HudSelect
            value={unit}
            disabled={disabled}
            onChange={(event) => {
              const nextUnit = event.target.value as SizeUnit
              setUnit(nextUnit)
              commit(box, nextUnit)
            }}
            className="rounded-none border-0 border-l border-line bg-panel-2 px-1.5 font-mono text-[0.6875rem] text-mint outline-none disabled:cursor-not-allowed"
            aria-label={`${label} unit`}
          >
            <option value="M">M</option>
            <option value="B">B</option>
            <option value="T">T</option>
          </HudSelect>
        </div>
      </div>

      <div className="relative min-w-0 overflow-x-hidden px-1 pt-1 pb-2">
        <div
          className="pointer-events-none absolute inset-x-2 top-[1.15rem] h-px bg-line/90"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute left-2 top-[1.1rem] h-0.5 rounded-full bg-mint"
          style={{ width: `calc((100% - 1rem) * ${fillPct / 100})` }}
          aria-hidden
        />
        <HudRange
          type="range"
          min={logMin}
          max={logMax}
          step={0.001}
          value={currentLog}
          disabled={disabled}
          onChange={(event) => {
            const target = 10 ** Number(event.target.value)
            const mark = marks[nearestIndex(marks, target)]
            if (mark) onChange(mark.paramsB)
          }}
          className="model-size-timeline disabled:cursor-not-allowed"
          aria-label={label}
          aria-valuetext={formatParams(value)}
        />
        <div className="relative mt-1 h-7">
          {marks.map((mark, index) => {
            const major = MAJOR_MODEL_MARKS.has(mark.label) || marks.length <= 8
            const selected = index === idx
            if (!major && !selected) return null
            const edgePosition =
              index === 0
                ? 'translate-x-0'
                : index === marks.length - 1
                  ? '-translate-x-full'
                  : '-translate-x-1/2'
            const position =
              logMax === logMin
                ? 0
                : ((Math.log10(mark.paramsB) - logMin) / (logMax - logMin)) * 100
            return (
              <button
                key={mark.label}
                type="button"
                title={mark.label}
                disabled={disabled}
                onClick={() => onChange(mark.paramsB)}
                className={`absolute top-0 z-10 ${edgePosition} appearance-none border-0 bg-transparent p-0 font-mono text-[0.625rem] leading-7 whitespace-nowrap transition-colors disabled:cursor-not-allowed ${
                  selected ? 'text-mint' : 'text-muted hover:text-bone'
                }`}
                style={{ left: `${position}%` }}
              >
                {mark.label}
              </button>
            )
          })}
        </div>
      </div>
      {invalid && (
        <p className="text-[0.6875rem] text-danger">
          Enter a positive size using M, B, or T.
        </p>
      )}
      {disabled && disabledReason ? (
        <p className="rounded-md border border-amber/30 bg-amber/8 px-2 py-1.5 text-[0.75rem] text-amber">
          {disabledReason}
        </p>
      ) : null}
    </div>
  )
}

function nearestIndex(marks: { paramsB: number }[], value: number): number {
  let best = 0
  let bestDistance = Infinity
  for (let index = 0; index < marks.length; index += 1) {
    const distance = Math.abs(
      Math.log(marks[index]!.paramsB + 1e-9) - Math.log(value + 1e-9),
    )
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  }
  return best
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

function formatParts(paramsB: number): { value: string; unit: SizeUnit } {
  if (paramsB >= 1000) return { value: String(paramsB / 1000), unit: 'T' }
  if (paramsB >= 1) return { value: String(paramsB), unit: 'B' }
  return { value: String(paramsB * 1000), unit: 'M' }
}

import { useEffect, useState } from 'react'
import type { ApiUnitEconomics } from '../../../sim/balance/pricing'
import { blendApiPrice } from '../../../sim/balance/pricing'

function rate(value: number): string {
  if (!Number.isFinite(value)) return '$0.00'
  if (value > 0 && value < 0.01) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

const STATE_LABEL: Record<ApiUnitEconomics['state'], string> = {
  efficiency_premium: 'Efficiency premium',
  healthy: 'Healthy',
  uncompetitive_cost: 'Uncompetitive cost base',
  overbuilt_capacity: 'Overbuilt capacity',
}

function PriceField({
  label,
  value,
  onCommit,
}: {
  label: string
  value: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(value.toFixed(2))
  useEffect(() => setDraft(value.toFixed(2)), [value])
  const commit = () => {
    const parsed = Number(draft)
    const next = Number.isFinite(parsed) ? Math.max(0, parsed) : value
    setDraft(next.toFixed(2))
    onCommit(next)
  }
  return (
    <label className="text-[0.6875rem] text-muted">
      {label}
      <input
        type="number"
        min={0}
        step={0.01}
        inputMode="decimal"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setDraft(value.toFixed(2))
        }}
        className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-xs text-bone outline-none focus:border-mint/55"
      />
    </label>
  )
}

export function ApiEconomicsControl({
  modelName,
  priceIn,
  priceOut,
  economics,
  onChange,
}: {
  modelName: string
  priceIn: number
  priceOut: number
  economics: ApiUnitEconomics
  onChange: (priceIn: number, priceOut: number) => void
}) {
  const blended = blendApiPrice(priceIn, priceOut)
  const markup = (blended / Math.max(0.001, economics.directBlended) - 1) * 100
  const contributionMargin = blended > 0
    ? ((blended - economics.directBlended) / blended) * 100
    : -100
  const [marginDraft, setMarginDraft] = useState(markup.toFixed(2))
  useEffect(() => setMarginDraft(markup.toFixed(2)), [markup])

  const applyMarkup = (percent: number) => {
    const multiplier = Math.max(0, 1 + percent / 100)
    onChange(economics.directIn * multiplier, economics.directOut * multiplier)
  }
  const applyRecommended = () => {
    const multiplier = economics.recommendedPrice / Math.max(0.001, economics.directBlended)
    onChange(economics.directIn * multiplier, economics.directOut * multiplier)
  }

  return (
    <section className="mt-2 rounded-xl border border-line/70 bg-void/40 p-2.5" aria-label={`${modelName} API economics`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[0.6875rem] font-medium uppercase tracking-[0.13em] text-muted">Unit economics</div>
          <div className="mt-0.5 font-mono text-[0.6875rem] text-bone">
            direct {rate(economics.directBlended)}/MTok · value {rate(economics.valueBand.low)}–{rate(economics.valueBand.high)}
          </div>
        </div>
        <span className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase ${economics.state === 'uncompetitive_cost' ? 'bg-danger/15 text-danger' : economics.state === 'overbuilt_capacity' ? 'bg-amber/15 text-amber' : 'bg-mint/15 text-mint'}`}>
          {STATE_LABEL[economics.state]}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1.5 font-mono text-[0.625rem] sm:grid-cols-4">
        <Metric label="List price" value={`${rate(blended)}/M`} />
        <Metric label="Actual markup" value={`${markup.toFixed(2)}%`} tone={markup >= 40 && markup <= 80 ? 'text-mint' : 'text-bone'} />
        <Metric label="Contribution" value={`${contributionMargin.toFixed(2)}%`} tone={contributionMargin < 0 ? 'text-danger' : 'text-mint'} />
        <Metric label="Fleet use" value={`${(economics.utilization * 100).toFixed(2)}%`} />
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5 font-mono text-[0.625rem]">
        <Metric label="Allocated campus overhead" value={`${rate(economics.allocatedOverheadPerMTok)}/M`} tone={economics.allocatedOverheadPerMTok > economics.directBlended * 8 ? 'text-amber' : 'text-muted'} />
        <Metric label="Recommended" value={`${rate(economics.recommendedBand.low)}–${rate(economics.recommendedBand.high)}/M`} />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <PriceField label="Input $/1M tok" value={priceIn} onCommit={(next) => onChange(next, Math.max(next, priceOut))} />
        <PriceField label="Output $/1M tok" value={priceOut} onCommit={(next) => onChange(priceIn, Math.max(priceIn, next))} />
      </div>

      <div className="mt-2 rounded-lg border border-line/60 bg-panel-2/65 p-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[0.6875rem] font-medium text-bone">Markup over direct cost</div>
            <div className="text-[0.625rem] text-muted">Normal operating band: 40–80%</div>
          </div>
          <label className="flex items-center gap-1 text-[0.6875rem] text-muted">
            <input
              aria-label={`${modelName} markup over direct cost`}
              type="number"
              step={0.01}
              inputMode="decimal"
              value={marginDraft}
              onChange={(event) => setMarginDraft(event.target.value)}
              onBlur={() => {
                const parsed = Number(marginDraft)
                if (Number.isFinite(parsed)) applyMarkup(parsed)
                else setMarginDraft(markup.toFixed(2))
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') setMarginDraft(markup.toFixed(2))
              }}
              className="w-20 rounded-md border border-mint/35 bg-void px-2 py-1 font-mono text-xs text-bone outline-none focus:border-mint"
            />
            <span className="font-mono text-bone">%</span>
          </label>
        </div>
        <div className="relative mt-2 h-1.5 overflow-hidden rounded-sm bg-line/50" aria-hidden="true">
          <div className="absolute inset-y-0 left-[23.33%] w-[6.67%] bg-mint/75" />
          <div className="absolute inset-y-[-2px] w-0.5 bg-bone" style={{ left: `${Math.max(0, Math.min(100, (markup + 100) / 6))}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" onClick={() => applyMarkup(0)} className="rounded-sm bg-panel px-2 py-1 text-[0.625rem] text-muted hover:text-bone">At direct cost</button>
          <button type="button" onClick={() => applyMarkup(60)} className="rounded-sm bg-mint/10 px-2 py-1 text-[0.625rem] text-mint hover:bg-mint/20">60% markup</button>
          <button type="button" onClick={applyRecommended} className="rounded-sm bg-infer/10 px-2 py-1 text-[0.625rem] text-infer hover:bg-infer/20">Use market recommendation</button>
        </div>
      </div>
    </section>
  )
}

function Metric({ label, value, tone = 'text-bone' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-line/45 bg-void/50 px-1.5 py-1">
      <div className="uppercase tracking-wider text-muted">{label}</div>
      <div className={tone}>{value}</div>
    </div>
  )
}

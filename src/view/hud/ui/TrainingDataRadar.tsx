import { useMemo, useState } from 'react'
import { DATA_DOMAIN_META, DATA_DOMAINS, formatTokens } from '../../../sim/balance/data'
import type { DataDomain } from '../../../sim/types'
import { normalizedRadarWeights, rebalanceRadarWeight } from './trainingDataRadarMath'

const AXIS_SHORT: Record<DataDomain, string> = {
  code: 'Code',
  math: 'Math',
  science: 'Sci',
  law: 'Law',
  health: 'Health',
  chat: 'Chat',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

function point(index: number, total: number, value: number, radius = 98, cx = 150, cy = 132) {
  const angle = -Math.PI / 2 + (index / total) * Math.PI * 2
  return {
    x: cx + Math.cos(angle) * radius * clamp01(value),
    y: cy + Math.sin(angle) * radius * clamp01(value),
  }
}

function polygon(values: number[]): string {
  return values.map((value, index) => {
    const p = point(index, values.length, value)
    return `${p.x.toFixed(2)},${p.y.toFixed(2)}`
  }).join(' ')
}

export function TrainingDataRadar({
  weights,
  dataMTok,
  available,
  syntheticEnabled,
  includeSynthHQ,
  includeSynthLQ,
  outcome,
  disabled,
  onChange,
}: {
  weights: Record<DataDomain, number>
  dataMTok: number
  available: Record<DataDomain, number>
  syntheticEnabled: boolean
  includeSynthHQ: boolean
  includeSynthLQ: boolean
  outcome: Record<DataDomain, number>
  disabled?: boolean
  onChange: (weights: Record<DataDomain, number>) => void
}) {
  const [tab, setTab] = useState<'corpus' | 'outcome'>('corpus')
  const [selected, setSelected] = useState<DataDomain>('code')
  const normalized = useMemo(() => normalizedRadarWeights(weights), [weights])
  const maxShare = Math.max(0.12, ...DATA_DOMAINS.map((domain) => normalized[domain]))
  const data = DATA_DOMAINS.map((domain) => {
    const target = dataMTok * normalized[domain]
    const real = Math.min(target, Math.max(0, available[domain] ?? 0))
    const missing = Math.max(0, target - real)
    const synthetic = syntheticEnabled && (includeSynthHQ || includeSynthLQ) ? missing : 0
    const syntheticQuality = includeSynthHQ && includeSynthLQ ? 0.68 : includeSynthHQ ? 0.86 : 0.46
    const qualitySignal = target > 0
      ? ((real + synthetic * syntheticQuality) / target) * 100
      : 0
    return { domain, target, real, missing, synthetic, qualitySignal }
  })
  const targetValues = data.map((item) => item.target / Math.max(1, dataMTok * maxShare))
  const realValues = data.map((item, index) => targetValues[index]! * (item.target > 0 ? item.real / item.target : 0))
  const filledValues = data.map((item, index) => targetValues[index]! * (item.target > 0 ? (item.real + item.synthetic) / item.target : 0))
  const signalValues = data.map((item) => item.qualitySignal / 100)
  const outcomeValues = DATA_DOMAINS.map((domain) => clamp01(outcome[domain] / 100))
  const selectedData = data.find((item) => item.domain === selected)!

  const adjustDomain = (domain: DataDomain, delta: number) => {
    if (disabled) return
    onChange(rebalanceRadarWeight(normalized, domain, normalized[domain] + delta))
  }
  const adjust = (delta: number) => adjustDomain(selected, delta)

  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-line/70 bg-void/45">
      <div className="grid grid-cols-2 border-b border-line/65" role="tablist" aria-label="Training data analysis">
        <button type="button" role="tab" aria-selected={tab === 'corpus'} onClick={() => setTab('corpus')} className={`px-2 py-1.5 text-[0.6875rem] ${tab === 'corpus' ? 'bg-mint/10 text-mint' : 'text-muted hover:text-bone'}`}>Corpus design</button>
        <button type="button" role="tab" aria-selected={tab === 'outcome'} onClick={() => setTab('outcome')} className={`px-2 py-1.5 text-[0.6875rem] ${tab === 'outcome' ? 'bg-infer/10 text-infer' : 'text-muted hover:text-bone'}`}>Outcome comparison</button>
      </div>
      <div className="grid gap-2 p-2 md:grid-cols-[minmax(0,1fr)_11rem]">
        <figure className="min-w-0" aria-label={tab === 'corpus' ? 'Corpus allocation radar' : 'Corpus signal compared with forecast outcome'}>
          <svg viewBox="0 0 300 270" className="mx-auto block h-auto w-full max-w-[28rem]" role="img">
            <title>{tab === 'corpus' ? 'Real and synthetic training corpus by domain' : 'Corpus signal and expected model outcome by domain'}</title>
            {[0.25, 0.5, 0.75, 1].map((ring) => (
              <polygon key={ring} points={polygon(DATA_DOMAINS.map(() => ring))} fill="none" stroke="currentColor" className="text-line/75" strokeWidth="0.8" />
            ))}
            {DATA_DOMAINS.map((domain, index) => {
              const axis = point(index, DATA_DOMAINS.length, 1)
              const label = point(index, DATA_DOMAINS.length, 1.17)
              return (
                <g key={domain}>
                  <line x1="150" y1="132" x2={axis.x} y2={axis.y} stroke="currentColor" className="text-line/65" strokeWidth="0.7" />
                  <text x={label.x} y={label.y} textAnchor={label.x < 135 ? 'end' : label.x > 165 ? 'start' : 'middle'} dominantBaseline="middle" className={domain === selected ? 'fill-mint text-[10px] font-semibold' : 'fill-muted text-[9px]'}>{AXIS_SHORT[domain]}</text>
                </g>
              )
            })}
            {tab === 'corpus' ? (
              <>
                <polygon points={polygon(targetValues)} fill="none" stroke="currentColor" className="text-bone/75" strokeDasharray="4 3" strokeWidth="1.2" />
                <polygon points={polygon(filledValues)} fill="currentColor" stroke="currentColor" className="fill-amber/15 text-amber" strokeWidth="1.2" />
                <polygon points={polygon(realValues)} fill="currentColor" stroke="currentColor" className="fill-mint/20 text-mint" strokeWidth="1.5" />
              </>
            ) : (
              <>
                <polygon points={polygon(signalValues)} fill="currentColor" stroke="currentColor" className="fill-amber/10 text-amber" strokeDasharray="4 3" strokeWidth="1.2" />
                <polygon points={polygon(outcomeValues)} fill="currentColor" stroke="currentColor" className="fill-infer/20 text-infer" strokeWidth="1.5" />
              </>
            )}
            {DATA_DOMAINS.map((domain, index) => {
              const values = tab === 'corpus' ? targetValues : outcomeValues
              const p = point(index, DATA_DOMAINS.length, values[index]!)
              return <circle key={domain} cx={p.x} cy={p.y} r={domain === selected ? 3.8 : 2.3} fill="currentColor" className={domain === selected ? 'text-bone' : tab === 'corpus' ? 'text-mint' : 'text-infer'} />
            })}
          </svg>
          <figcaption className="sr-only">
            {data.map((item) => `${DATA_DOMAIN_META[item.domain].label}: ${(normalized[item.domain] * 100).toFixed(1)} percent, ${formatTokens(item.real)} real, ${formatTokens(item.synthetic)} synthetic, forecast ${outcome[item.domain].toFixed(1)}.`).join(' ')}
          </figcaption>
          <div className="flex flex-wrap justify-center gap-2 font-mono text-[0.5625rem] text-muted">
            {tab === 'corpus' ? <><Legend tone="bg-mint" label="real" /><Legend tone="bg-amber" label="synthetic fill" /><Legend tone="border border-bone border-dashed" label="target" /></> : <><Legend tone="border border-amber border-dashed" label="corpus signal" /><Legend tone="bg-infer" label="forecast outcome" /></>}
          </div>
        </figure>

        <div className="rounded-lg border border-line/55 bg-panel-2/70 p-2">
          <div className="text-[0.625rem] uppercase tracking-[0.14em] text-muted">Axis readout</div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <strong className="text-xs text-bone">{DATA_DOMAIN_META[selected].label}</strong>
            <span className="font-mono text-xs text-mint">{(normalized[selected] * 100).toFixed(1)}%</span>
          </div>
          <dl className="mt-2 space-y-1 font-mono text-[0.625rem]">
            <Readout label="Target" value={formatTokens(selectedData.target)} />
            <Readout label="Owned corpus" value={formatTokens(selectedData.real)} />
            <Readout label="Synthetic" value={formatTokens(selectedData.synthetic)} tone={selectedData.synthetic > 0 ? 'text-amber' : 'text-muted'} />
            <Readout label="Data signal" value={selectedData.qualitySignal.toFixed(1)} />
            <Readout label="Outcome" value={outcome[selected].toFixed(1)} tone="text-infer" />
          </dl>
          <div className="mt-2 grid grid-cols-2 gap-1">
            <button type="button" disabled={disabled} onClick={() => adjust(-0.01)} className="rounded-sm bg-void px-2 py-1 text-xs text-muted hover:text-bone disabled:opacity-40" aria-label={`Reduce ${DATA_DOMAIN_META[selected].label} share`}>−1%</button>
            <button type="button" disabled={disabled} onClick={() => adjust(0.01)} className="rounded-sm bg-mint/10 px-2 py-1 text-xs text-mint hover:bg-mint/20 disabled:opacity-40" aria-label={`Increase ${DATA_DOMAIN_META[selected].label} share`}>+1%</button>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-px border-t border-line/65 bg-line/65 sm:grid-cols-5">
        {DATA_DOMAINS.map((domain) => {
          const item = data.find((candidate) => candidate.domain === domain)!
          return (
            <button
              key={domain}
              type="button"
              aria-pressed={selected === domain}
              onClick={() => setSelected(domain)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowRight') { event.preventDefault(); setSelected(domain); adjustDomain(domain, event.shiftKey ? 0.05 : 0.01) }
                if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') { event.preventDefault(); setSelected(domain); adjustDomain(domain, event.shiftKey ? -0.05 : -0.01) }
              }}
              className={`min-w-0 bg-void px-1.5 py-1.5 text-left ${selected === domain ? 'text-mint' : 'text-muted hover:text-bone'}`}
            >
              <span className="block truncate text-[0.625rem]">{AXIS_SHORT[domain]}</span>
              <span className="font-mono text-[0.5625rem]">{(normalized[domain] * 100).toFixed(1)}%{item.synthetic > 0 ? ' · S' : ''}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Legend({ tone, label }: { tone: string; label: string }) {
  return <span className="inline-flex items-center gap-1"><span className={`h-1.5 w-3 rounded-sm ${tone}`} />{label}</span>
}

function Readout({ label, value, tone = 'text-bone' }: { label: string; value: string; tone?: string }) {
  return <div className="flex justify-between gap-2"><dt className="text-muted">{label}</dt><dd className={tone}>{value}</dd></div>
}

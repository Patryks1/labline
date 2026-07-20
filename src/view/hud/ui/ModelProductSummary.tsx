import type { ReactNode } from 'react'
import type { Model } from '../../../sim/types'
import { formatParams } from '../../../sim/balance/training'

export function ModelProductSummary({
  model,
  badge,
  badgeTone = 'mint',
  score,
  metrics,
  children,
}: {
  model: Model
  badge: string
  badgeTone?: 'mint' | 'amber' | 'research' | 'muted'
  score?: string
  metrics: { label: string; value: string; tone?: string }[]
  children?: ReactNode
}) {
  const badgeClass = badgeTone === 'amber' ? 'bg-amber/15 text-amber' : badgeTone === 'research' ? 'bg-research/15 text-research' : badgeTone === 'muted' ? 'bg-void text-muted' : 'bg-mint/15 text-mint'
  return <div className="min-w-0">
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5"><strong className="truncate text-[0.8125rem] text-bone">{model.name}</strong><span className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase ${badgeClass}`}>{badge}</span></div>
        <p className="mt-0.5 truncate font-mono text-[0.625rem] text-muted">{model.backbone ?? model.family} · {formatParams(model.paramsB)} · r{model.revision ?? 1}</p>
      </div>
      {score ? <strong className="shrink-0 font-mono text-sm font-medium text-mint">{score}</strong> : null}
    </div>
    <div className={`mt-2 grid gap-1 font-mono text-[0.625rem] ${metrics.length >= 4 ? 'grid-cols-4' : 'grid-cols-3'}`}>
      {metrics.slice(0, 4).map((metric) => <span key={metric.label} className="min-w-0 rounded-sm bg-void/55 px-1.5 py-1"><span className="block truncate uppercase tracking-wider text-muted">{metric.label}</span><strong className={`block truncate font-medium ${metric.tone ?? 'text-bone'}`} title={metric.value}>{metric.value}</strong></span>)}
    </div>
    {children}
  </div>
}

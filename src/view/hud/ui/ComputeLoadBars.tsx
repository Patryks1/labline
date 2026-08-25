/**
 * Live PF load bars shared by BottomBar, Plans, and model serving cards.
 * All numbers come from {@link buildComputeBreakdown} — no second ledger.
 */
import { useMemo, useState, type ReactNode } from 'react'
import type { SimState } from '../../../sim/types'
import { isInferenceOutage } from '../../../sim/balance/serveThrottle'
import {
  buildComputeBreakdown,
  type ResearchComputeSlice,
  type ServeModelLoadRow,
  type ServePlanMixEntry,
  type ServePoolLoad,
  type TrainLoadConsumer,
} from '../../../sim/systems/computeBreakdown'
import {
  isApiAcceptingNew,
  isSubsAcceptingNew,
} from '../../../sim/systems/plans'
import { money, num, pct, pf } from '../format'
import { HudButton } from './HudPrimitives'
import type { HudMeterTone } from './HudPrimitives'

export function useComputeLoad(state: SimState) {
  return useMemo(() => buildComputeBreakdown(state).load, [state])
}

export function channelLoadsFromServePool(
  load: ServePoolLoad,
  apiPoolPf: number,
  subPoolPf: number,
): { apiLoad: number; subLoad: number } {
  return {
    apiLoad: apiPoolPf > 1e-9 ? load.apiUsedPf / apiPoolPf : load.usedPf > 1e-12 ? 1 : 0,
    subLoad: subPoolPf > 1e-9 ? load.subUsedPf / subPoolPf : load.usedPf > 1e-12 ? 1 : 0,
  }
}

export function serveOutageActive(state: SimState): boolean {
  const lm = state.lastMarket
  return (
    lm.serveOutage === true ||
    isInferenceOutage(lm.capacityPf ?? 0, lm.unservedRatio ?? 0)
  )
}

function loadTone(fill: number, warn: boolean, pool: 'train' | 'serve' | 'research'): HudMeterTone {
  if (warn || fill > 1.02) return 'danger'
  if (fill > 0.9) return 'warning'
  if (pool === 'serve') return 'serve'
  if (pool === 'research') return 'research'
  return 'train'
}

function mixDetail(entry: ServePlanMixEntry): string {
  if (entry.kind === 'api') {
    return entry.apiMTok != null && entry.apiMTok > 0
      ? `${num(entry.apiMTok, 2)} MTok · ${pf(entry.usedPf)}`
      : pf(entry.usedPf)
  }
  const subs =
    entry.subscribers != null && entry.subscribers > 0
      ? `${num(entry.subscribers, 0)} subs · `
      : ''
  return `${subs}${pf(entry.usedPf)} · ${pct(entry.shareOfModelSubPf)} of model sub PF · ${entry.precision}`
}

function StackedUsedFill({
  fill,
  warn,
  apiShare,
  poolTone,
  live,
  compact,
}: {
  fill: number
  warn: boolean
  apiShare: number
  poolTone: HudMeterTone
  live?: boolean
  compact?: boolean
}) {
  const overflow = fill > 1.02
  const usedWidth = overflow ? 100 : Math.min(100, Math.max(0, fill * 100))
  const apiWidth = usedWidth * Math.max(0, Math.min(1, apiShare))
  const subWidth = Math.max(0, usedWidth - apiWidth)
  const tone = warn || overflow ? 'danger' : poolTone

  return (
    <div
      className={`hud-progress hud-progress--stacked ${compact ? 'hud-progress--compact' : ''} ${
        overflow ? 'hud-progress--overflow' : ''
      }`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(1.5, fill) * 100)}
    >
      {apiWidth > 0.05 ? (
        <span
          className={`hud-progress__fill hud-progress__fill--serve absolute inset-y-0 left-0 ${
            live ? 'meter-live' : ''
          }`}
          style={{ width: `${apiWidth}%` }}
        />
      ) : null}
      {subWidth > 0.05 ? (
        <span
          className={`hud-progress__fill hud-progress__fill--positive absolute inset-y-0 ${
            live ? 'meter-live' : ''
          }`}
          style={{ left: `${apiWidth}%`, width: `${subWidth}%` }}
        />
      ) : null}
      {!overflow && fill < 0.995 ? (
        <span
          className={`hud-progress__fill hud-progress__fill--${tone} absolute inset-y-0 left-0 opacity-0`}
          style={{ width: `${usedWidth}%` }}
          aria-hidden
        />
      ) : null}
    </div>
  )
}

/** Compact pool bar for BottomBar allocation slots. */
export function PoolLoadBar({
  fill,
  warn = false,
  apiShare,
  pool = 'serve',
  powerMw,
  idlePf,
  usedPf,
  poolPf,
  live = false,
  detail,
}: {
  fill: number
  warn?: boolean
  /** When set, stacks API (infer) vs subs (mint) inside the used portion. */
  apiShare?: number
  pool?: 'train' | 'serve' | 'research'
  powerMw?: number
  idlePf?: number
  usedPf?: number
  poolPf?: number
  live?: boolean
  detail?: ReactNode
}) {
  const tone = loadTone(fill, warn, pool)
  const powerLabel =
    powerMw == null
      ? null
      : live && powerMw <= 1e-6
        ? 'cloud'
        : `${num(powerMw, 3)} MW`
  const labelDetail =
    detail ??
    (warn
      ? 'Unserved / queued'
      : usedPf != null && poolPf != null && usedPf > 1e-9
        ? `In use ${pf(usedPf)} / ${pf(poolPf)}`
        : idlePf != null && idlePf > 0.001
          ? `Idle ${pf(idlePf)}`
          : pct(Math.min(1, fill)))

  return (
    <div className="compute-pool-load min-w-0 space-y-0.5" data-testid={`pool-load-${pool}`}>
      <div className="flex items-baseline justify-between gap-2 font-mono text-[0.6875rem] leading-tight text-muted/90">
        <span className="truncate">
          {pct(Math.min(1.5, fill))}
          {powerLabel != null ? ` · ${powerLabel}` : null}
        </span>
        <span className={`shrink-0 ${warn ? 'text-amber' : 'text-muted'}`}>{labelDetail}</span>
      </div>
      {apiShare != null ? (
        <StackedUsedFill
          fill={fill}
          warn={warn}
          apiShare={apiShare}
          poolTone={tone}
          live={live}
          compact
        />
      ) : (
        <div
          className="hud-progress hud-progress--compact"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(Math.min(1, fill) * 100)}
        >
          <span
            className={`hud-progress__fill hud-progress__fill--${tone} ${live ? 'meter-live' : ''}`}
            style={{ width: `${Math.min(100, Math.max(0, fill * 100))}%` }}
          />
        </div>
      )}
    </div>
  )
}

export function ServeModelLoadBar({
  row,
  live = false,
  defaultExpanded = false,
}: {
  row: ServeModelLoadRow
  live?: boolean
  defaultExpanded?: boolean
}) {
  const [open, setOpen] = useState(defaultExpanded)
  const apiShare = row.usedPf > 1e-12 ? row.apiUsedPf / row.usedPf : 0
  const tone = row.warn ? 'danger' : row.fill > 0.85 ? 'warning' : 'serve'

  return (
    <div
      className="serve-model-load rounded-md border border-line/50 bg-void/35 px-2 py-1.5"
      data-testid={`serve-model-load-${row.modelId}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false)
        }
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 text-left text-[0.75rem] font-medium text-bone"
          onClick={() => setOpen((value) => !value)}
        >
          {row.name}
        </button>
        <span className={`shrink-0 font-mono text-[0.6875rem] tabular-nums ${row.warn ? 'text-danger' : 'text-muted'}`}>
          {pf(row.usedPf)} / {pf(row.allocatedPf)}
        </span>
      </div>
      <div className="mt-1">
        <StackedUsedFill
          fill={row.fill}
          warn={row.warn}
          apiShare={apiShare}
          poolTone={tone}
          live={live}
          compact
        />
      </div>
      <div className="mt-0.5 flex justify-between gap-2 font-mono text-[0.625rem] text-muted">
        <span>
          API {pf(row.apiUsedPf)} · subs {pf(row.subUsedPf)}
        </span>
        {row.idlePf > 0.001 && !row.warn ? (
          <span>Idle {pf(row.idlePf)}</span>
        ) : row.unserved ? (
          <span className="text-amber">Queued</span>
        ) : null}
      </div>
      {open && row.planMix.length > 0 ? (
        <ul className="mt-1.5 space-y-1 border-t border-line/40 pt-1.5" role="list">
          {row.planMix.map((entry) => (
            <li
              key={entry.kind === 'api' ? 'api' : entry.planId ?? entry.name}
              className="text-[0.6875rem] leading-snug text-muted"
            >
              <span className="font-medium text-bone">{entry.name}</span>
              <span className="ml-1 font-mono text-[0.625rem]">{mixDetail(entry)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function ServeModelLoadList({
  models,
  live = false,
}: {
  models: ServeModelLoadRow[]
  live?: boolean
}) {
  const rows = models.filter(
    (row) => row.allocatedPf > 1e-9 || row.usedPf > 1e-12,
  )
  if (rows.length === 0) {
    return (
      <p className="text-[0.6875rem] leading-snug text-muted">
        No live models on the inference pool.
      </p>
    )
  }
  return (
    <div className="space-y-1.5" data-testid="serve-model-load-list">
      {rows.map((row) => (
        <ServeModelLoadBar key={row.modelId} row={row} live={live} />
      ))}
    </div>
  )
}

export function TrainLoadConsumerList({ jobs }: { jobs: TrainLoadConsumer[] }) {
  if (jobs.length === 0) {
    return (
      <p className="text-[0.6875rem] leading-snug text-muted">
        No active train or safety jobs — pool is idle.
      </p>
    )
  }
  return (
    <ul className="space-y-1" data-testid="train-load-consumers">
      {jobs.map((job) => (
        <li
          key={job.id}
          className="flex items-baseline justify-between gap-2 font-mono text-[0.6875rem]"
        >
          <span className="min-w-0 truncate text-bone">
            {job.kind === 'safety' ? 'Safety' : job.name}
          </span>
          <span className="shrink-0 text-muted">
            {job.usefulPf + 1e-9 < job.usedPf
              ? `${pf(job.usedPf)} occ · ${pf(job.usefulPf)} useful · ${pct(job.share)}`
              : `${pf(job.usedPf)} · ${pct(job.share)}`}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function ResearchLoadConsumerList({ slices }: { slices: ResearchComputeSlice[] }) {
  if (slices.length === 0) {
    return (
      <p className="text-[0.6875rem] leading-snug text-muted">
        No research consumers — pool is idle.
      </p>
    )
  }
  return (
    <ul className="space-y-1" data-testid="research-load-consumers">
      {slices.map((slice) => (
        <li
          key={slice.id}
          className="flex items-baseline justify-between gap-2 font-mono text-[0.6875rem]"
        >
          <span className="min-w-0 truncate text-bone">{slice.label}</span>
          <span className="shrink-0 text-muted">
            {pf(slice.pf)} · {pct(slice.share)}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function ServeOutageBanner({
  state,
  onPauseApi,
  onPauseSubs,
  className = '',
}: {
  state: SimState
  onPauseApi: () => void
  onPauseSubs: () => void
  className?: string
}) {
  if (!serveOutageActive(state)) return null
  const lm = state.lastMarket
  const capacityPf = lm.capacityPf ?? 0
  const unserved = lm.unservedRatio ?? 0
  const apiOpen = isApiAcceptingNew(state.player.pricing)
  const subsOpen = isSubsAcceptingNew(state.player.pricing)

  return (
    <div
      className={`serve-outage-banner rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-2 ${className}`}
      data-testid="serve-outage-banner"
      role="status"
    >
      <p className="text-[0.75rem] font-semibold text-danger">
        {capacityPf <= 1e-6 ? 'Inference outage' : 'Coverage outage'}
      </p>
      <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted">
        {capacityPf <= 1e-6
          ? 'Serve PF is ~0 — pause new traffic or restore racks before brand damage stacks.'
          : `${pct(unserved)} of demand cannot be admitted — pause new signups to stop taking traffic you cannot serve.`}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <HudButton
          type="button"
          variant={apiOpen ? 'danger' : 'secondary'}
          className="min-h-8 px-2.5 text-[0.6875rem]"
          onClick={onPauseApi}
          data-testid="pause-new-api"
        >
          {apiOpen ? 'Pause new API' : 'Resume new API'}
        </HudButton>
        <HudButton
          type="button"
          variant={subsOpen ? 'danger' : 'secondary'}
          className="min-h-8 px-2.5 text-[0.6875rem]"
          onClick={onPauseSubs}
          data-testid="pause-new-subs"
        >
          {subsOpen ? 'Pause new subs' : 'Resume new subs'}
        </HudButton>
      </div>
    </div>
  )
}

export function PeakPricingStrip({
  listPrice,
  peakPrice,
  extraRevenue,
  className = '',
}: {
  listPrice?: number
  peakPrice?: number
  extraRevenue?: number
  className?: string
}) {
  if (listPrice == null || peakPrice == null || peakPrice <= listPrice + 1e-9) {
    return null
  }
  const upliftPct = listPrice > 1e-9 ? ((peakPrice / listPrice - 1) * 100).toFixed(0) : '0'
  return (
    <p
      className={`font-mono text-[0.6875rem] leading-snug text-muted ${className}`}
      data-testid="peak-pricing-strip"
    >
      List {money(listPrice)}/M · peak {money(peakPrice)}/M (+{upliftPct}%)
      {extraRevenue != null && extraRevenue > 0.01
        ? ` · extra ${money(extraRevenue)} today`
        : null}
    </p>
  )
}

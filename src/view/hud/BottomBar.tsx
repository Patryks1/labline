import { useMemo, useState, type ReactNode } from 'react'
import { CaretDown, CaretUp } from '@phosphor-icons/react'
import { gridScarcity } from '../../sim/systems/map'
import {
  buildComputeBreakdown,
  type PoolBreakdown,
} from '../../sim/systems/computeBreakdown'
import { useGameStore } from '../../store/gameStore'
import { computeSnapshot, inferenceTokensPerDay } from '../../sim/tick'
import { mw, num, pct, pf } from './format'
import { SliderField } from './ui/SliderField'

/**
 * Floating ops strip over the full-bleed map — allocation + live capacity.
 * Hover Train / Serve / Research for the three key facts only.
 */
export function BottomBar() {
  const state = useGameStore((s) => s.state)
  const setAllocation = useGameStore((s) => s.setAllocation)
  const autoBalanceHosting = useGameStore((s) => s.autoBalanceHosting)
  const setPanel = useGameStore((s) => s.setPanel)
  const snap = computeSnapshot(state)
  const cap = inferenceTokensPerDay(state, snap)
  const a = state.player.allocation
  const unserved = state.lastMarket.unservedRatio ?? 0
  const grid = gridScarcity(state)
  const [expanded, setExpanded] = useState(false)

  const breakdown = useMemo(() => buildComputeBreakdown(state), [state])

  const setSplit = (key: 'training' | 'inference' | 'research', v: number) => {
    const next = { ...a, [key]: Math.max(0.05, v) }
    const sum = next.training + next.inference + next.research
    setAllocation({
      training: next.training / sum,
      inference: next.inference / sum,
      research: next.research / sum,
    })
  }

  const poolSub = (p: PoolBreakdown) =>
    `${pf(p.poolPf)} · ${mw(p.powerMw)} · ${p.utilizationLabel} ${pct(Math.min(1, p.utilization), 0)}`

  const servedRatio = state.lastMarket.playerDemandMTok > 0
    ? Math.min(1, state.lastMarket.servedMTok / state.lastMarket.playerDemandMTok)
    : 1
  const racksTight = snap.rackCap > 0 && snap.racksUsed / snap.rackCap >= 0.95
  const powerTight = snap.mwAvailable > 0 && snap.mwDemand / snap.mwAvailable >= 0.9

  return (
    <footer
      className="operations-shell pointer-events-none"
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div className="hud-surface pointer-events-auto absolute inset-x-2 bottom-2 rounded-lg px-3 py-2">
        <div className="relative z-10 mb-1.5 flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap font-mono text-[0.75rem]">
          <Stat
            label="Compute"
            value={pf(snap.effectiveFlopsPf)}
            className="hidden sm:inline-flex"
            title={`Effective compute ${pf(snap.effectiveFlopsPf)} · yield ${pct(breakdown.fleetYield, 0)}`}
          />
          <Stat
            label="Power"
            value={`${mw(snap.mwDemand)}`}
            sub={`/ ${mw(snap.mwAvailable)}`}
            danger={snap.throttled || powerTight}
            className="hidden md:inline-flex"
          />
          <Stat
            label="Demand served"
            value={pct(servedRatio, 0)}
            danger={unserved > 0.08}
            title={`${num(state.lastMarket.servedMTok, 1)} of ${num(state.lastMarket.playerDemandMTok, 1)} MTok · max ${num(cap, 1)} MTok/day`}
          />
          {snap.throttled && <StatusChip tone="danger">Power throttled</StatusChip>}
          {unserved > 0.08 && (
            <StatusChip tone="warning">Plans/API short {pct(unserved, 0)}</StatusChip>
          )}
          {!snap.throttled && powerTight && (
            <StatusChip tone="warning">Power headroom low</StatusChip>
          )}
          {racksTight && <StatusChip tone="warning">Racks nearly full</StatusChip>}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              title="Auto-balance hosting ~80%"
              onClick={() => autoBalanceHosting()}
              className="min-h-7 rounded-md bg-mint/15 px-2 text-[0.6875rem] font-medium text-mint hover:bg-mint/25"
            >
              Auto-bal
            </button>
            <button
              type="button"
              onClick={() => setPanel('stats')}
              className="hidden min-h-7 rounded-md px-2 text-[0.6875rem] text-muted hover:bg-panel-2 hover:text-bone sm:inline-flex sm:items-center"
            >
              Intel
            </button>
            <button
              type="button"
              aria-expanded={expanded}
              title={expanded ? 'Collapse operations details' : 'Expand operations details'}
              onClick={() => setExpanded((value) => !value)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-bone"
            >
              {expanded ? <CaretDown size="0.9rem" /> : <CaretUp size="0.9rem" />}
            </button>
          </div>
        </div>

        <div className="relative z-10 grid grid-cols-3 gap-3">
          <SliderField
            label="Train"
            value={a.training}
            onChange={(v) => setSplit('training', v)}
            min={0.05}
            max={0.9}
            colorClass="bg-train"
            accentClass="text-train"
            format={(v) => pct(v, 0)}
            sublabel={poolSub(breakdown.train)}
            hoverContent={<PoolTooltip pool={breakdown.train} accent="text-train" />}
          />
          <SliderField
            label="Serve"
            value={a.inference}
            onChange={(v) => setSplit('inference', v)}
            min={0.05}
            max={0.9}
            colorClass="bg-infer"
            accentClass="text-infer"
            format={(v) => pct(v, 0)}
            sublabel={poolSub(breakdown.serve)}
            hoverContent={<PoolTooltip pool={breakdown.serve} accent="text-infer" />}
          />
          <SliderField
            label="Research"
            value={a.research}
            onChange={(v) => setSplit('research', v)}
            min={0.05}
            max={0.9}
            colorClass="bg-research"
            accentClass="text-research"
            format={(v) => pct(v, 0)}
            sublabel={poolSub(breakdown.research)}
            hoverContent={<PoolTooltip pool={breakdown.research} accent="text-research" />}
          />
        </div>

        {expanded ? (
          <div className="relative z-10 mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line/50 pt-2 font-mono text-[0.6875rem] text-muted">
            <span>
              Util cap <strong className="text-bone">{pct(state.player.utilCap, 0)}</strong>
            </span>
            <span>
              Serve{' '}
              <strong className="text-infer">{pct(state.player.servingEfficiency, 0)}</strong>
            </span>
            <span>
              Train{' '}
              <strong className="text-train">{pct(state.player.trainEfficiency, 0)}</strong>
            </span>
            <span>
              Fleet yield{' '}
              <strong className="text-mint">
                {pct(snap.rawFlopsPf > 0 ? snap.effectiveFlopsPf / snap.rawFlopsPf : 0, 0)}
              </strong>{' '}
              of raw compute
            </span>
            <span>
              Shared grid{' '}
              <strong className={grid.priceMult > 1.35 ? 'text-amber' : 'text-bone'}>
                {num(grid.gridDemandMw, 0)}/{num(grid.gridCapMw, 0)} MW
              </strong>
              {' · '}
              <strong className={grid.industryDcCount > grid.softCap ? 'text-amber' : 'text-bone'}>
                {grid.industryDcCount}
              </strong>{' '}
              live DCs (soft cap {grid.softCap})
            </span>
          </div>
        ) : null}
      </div>
    </footer>
  )
}

function PoolTooltip({ pool, accent }: { pool: PoolBreakdown; accent: string }) {
  const blocker =
    pool.lines.find((line) => line.warn)?.value ??
    (pool.utilizationLabel === 'Idle' || pool.utilizationLabel === 'Stalled'
      ? pool.summary
      : null)

  return (
    <div className="space-y-1.5 text-left">
      <div className={`text-[0.8125rem] font-semibold ${accent}`}>{pool.title}</div>
      <div className="flex items-baseline justify-between gap-3 font-mono text-[0.75rem]">
        <span className="text-muted">Allocation</span>
        <span className="text-bone">{pct(pool.allocShare, 0)}</span>
      </div>
      <div className="flex items-baseline justify-between gap-3 font-mono text-[0.75rem]">
        <span className="text-muted">Effective work</span>
        <span className="text-bone">{pf(pool.poolPf)} · {pool.utilizationLabel}</span>
      </div>
      <div className="flex items-baseline justify-between gap-3 font-mono text-[0.75rem]">
        <span className="text-muted">Power draw</span>
        <span className="text-bone">{mw(pool.powerMw)}</span>
      </div>
      {blocker ? (
        <p className="rounded-md border border-amber/30 bg-amber/10 px-2 py-1 text-[0.6875rem] leading-snug text-amber">
          {blocker}
        </p>
      ) : (
        <p className="text-[0.6875rem] leading-snug text-muted">No blockers.</p>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  danger,
  className = '',
  title,
}: {
  label: string
  value: string
  sub?: string
  danger?: boolean
  className?: string
  title?: string
}) {
  return (
    <span className={`inline-flex items-baseline gap-1 text-muted ${className}`} title={title}>
      <span className="text-[0.625rem] uppercase tracking-wide opacity-80">{label}</span>
      <strong className={`text-bone ${danger ? 'text-danger' : ''}`}>{value}</strong>
      {sub && <span className="text-muted/80">{sub}</span>}
    </span>
  )
}

function StatusChip({
  children,
  tone,
}: {
  children: ReactNode
  tone: 'danger' | 'warning'
}) {
  return (
    <span
      className={`hidden shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium sm:inline-flex ${
        tone === 'danger' ? 'bg-danger/15 text-danger' : 'bg-amber/15 text-amber'
      }`}
    >
      {children}
    </span>
  )
}

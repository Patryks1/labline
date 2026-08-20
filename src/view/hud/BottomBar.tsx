import { useMemo, useState, type FocusEvent, type ReactNode } from 'react'
import { CaretDown, CaretUp } from '@phosphor-icons/react'
import { gridScarcity, resolvePlayerPowerMw } from '../../sim/systems/map'
import {
  buildComputeBreakdown,
  type PoolBreakdown,
} from '../../sim/systems/computeBreakdown'
import { useGameStore } from '../../store/gameStore'
import { computeSnapshot, inferenceTokensPerDay } from '../../sim/tick'
import { mw, num, pct, pf, pfLong } from './format'
import { SliderField } from './ui/SliderField'
import {
  COMPUTE_ALLOCATION_MIN,
  rebalanceComputeAllocation,
} from './mobileShellContracts'

/**
 * Floating ops strip over the full-bleed map — allocation + live capacity.
 * Hover Train / Serve / Research for the three key facts only.
 */
type HoveredPool = 'train' | 'serve' | 'research'

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
  const [hoveredPool, setHoveredPool] = useState<HoveredPool | null>(null)

  const breakdown = useMemo(() => buildComputeBreakdown(state), [state])
  const hoveredBreakdown =
    hoveredPool === 'train'
      ? breakdown.train
      : hoveredPool === 'serve'
        ? breakdown.serve
        : hoveredPool === 'research'
          ? breakdown.research
          : null

  const setSplit = (key: 'training' | 'inference' | 'research', v: number) => {
    setAllocation(rebalanceComputeAllocation(a, key, v))
  }

  const poolSub = (p: PoolBreakdown) =>
    `${pf(p.poolPf)} · ${mw(p.powerMw)} · ${p.utilizationLabel} ${pct(Math.min(1, p.utilization))}`

  const servedRatio = state.lastMarket.playerDemandMTok > 0
    ? Math.min(1, state.lastMarket.servedMTok / state.lastMarket.playerDemandMTok)
    : 1
  const powerTight = snap.mwAvailable > 0 && snap.mwDemand / snap.mwAvailable >= 0.9
  const resolved = resolvePlayerPowerMw(state, snap.mwDemand)
  const demandTitle = `${num(state.lastMarket.servedMTok)} of ${num(state.lastMarket.playerDemandMTok)} MTok · max ${num(cap)} MTok/day`

  const hoverPool = (pool: HoveredPool) => setHoveredPool(pool)
  const leaveAllocation = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    setHoveredPool(null)
  }

  return (
    <footer
      className="operations-shell pointer-events-none"
      data-expanded={expanded ? 'true' : 'false'}
      data-pool-flyout={hoveredPool ?? 'false'}
      aria-label="Live operations"
    >
      {expanded ? (
        <button
          type="button"
          className="operations-backdrop"
          aria-label="Close compute allocation"
          onClick={() => setExpanded(false)}
        />
      ) : null}
      {hoveredBreakdown && hoveredPool ? (
        <div
          className="operations-pool-flyout hud-surface"
          data-align={hoveredPool}
          role="tooltip"
        >
          <PoolTooltip
            pool={hoveredBreakdown}
            accent={
              hoveredPool === 'train'
                ? 'text-train'
                : hoveredPool === 'serve'
                  ? 'text-infer'
                  : 'text-research'
            }
          />
        </div>
      ) : null}
      <div className="operations-panel pointer-events-auto absolute inset-x-2 bottom-2 rounded-lg px-3 py-2">
        <div className="operations-panel__surface hud-surface rounded-lg" aria-hidden="true" />
        <div className="operations-telemetry relative z-10 mb-1.5 flex min-w-0 items-center gap-2 font-mono text-[0.75rem]">
          <div className="operations-telemetry__facts flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <Stat
              label="Compute"
              value={pf(snap.effectiveFlopsPf)}
              sub={
                snap.effectiveFlopsPf >= 1000
                  ? `· ${pfLong(snap.effectiveFlopsPf)}`
                  : `raw ${pf(snap.rawFlopsPf)}`
              }
              danger={snap.effectiveFlopsPf < 0.05 && snap.rawFlopsPf > 0.05}
              className="min-w-0 max-xl:hidden"
              title={`Effective ${pf(snap.effectiveFlopsPf)} · raw ${pf(snap.rawFlopsPf)} · train ${pf(snap.pools.training)} · serve ${pf(snap.pools.inference)} · research ${pf(snap.pools.research)} · yield ${pct(breakdown.fleetYield)}${snap.stallMessage ? ` · ${snap.stallMessage}` : ''} · 1 EF = 1,000 PF`}
            />
            <Stat
              label="Power"
              value={`${mw(snap.mwDemand)}`}
              sub={`/ ${mw(snap.mwAvailable)}`}
              danger={snap.throttled || powerTight}
              className="min-w-0 max-xl:hidden"
              title={`Fleet draw ${mw(snap.mwDemand)} of ${mw(resolved.mwGeneration + resolved.mwInterconnect)} available (${mw(resolved.mwGeneration)} on-site + ${mw(resolved.mwInterconnect)} interconnect) — you only draw what the fleet consumes; contract headroom isn't usage. Rented compute is powered by the provider.`}
            />
            <Stat
              label="Demand served"
              value={pct(servedRatio)}
              danger={unserved > 0.08}
              className="operations-telemetry__served min-w-0 shrink-0"
              title={demandTitle}
            />
            {snap.throttled && <StatusChip tone="danger">Power throttled</StatusChip>}
            {unserved > 0.08 && (
              <StatusChip
                tone="warning"
                title={`Plans/API short ${pct(unserved)} · ${demandTitle}`}
              >
                Unserved {pct(unserved)}
              </StatusChip>
            )}
            {!snap.throttled && powerTight && (
              <StatusChip tone="warning">Power tight</StatusChip>
            )}
          </div>
          <div className="operations-telemetry__actions flex shrink-0 items-center gap-1">
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
              className="hidden min-h-7 rounded-md px-2 text-[0.6875rem] text-muted hover:bg-panel-2 hover:text-bone lg:inline-flex lg:items-center"
            >
              Intel
            </button>
            <button
              type="button"
              aria-expanded={expanded}
              title={expanded ? 'Collapse operations details' : 'Expand operations details'}
              onClick={() => setExpanded((value) => !value)}
              className="operations-toggle flex min-h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1 text-muted hover:bg-panel-2 hover:text-bone"
            >
              <span className="operations-toggle-label">{expanded ? 'Done' : 'Allocate'}</span>
              {expanded ? <CaretDown size="0.9rem" /> : <CaretUp size="0.9rem" />}
            </button>
          </div>
        </div>

        <div
          className="operations-allocation-grid relative z-10 grid grid-cols-3 gap-3"
          onMouseLeave={() => setHoveredPool(null)}
          onBlurCapture={leaveAllocation}
        >
          <AllocationSlot pool="train" onHover={hoverPool}>
            <SliderField
              label="Train"
              value={a.training}
              onChange={(v) => setSplit('training', v)}
              min={COMPUTE_ALLOCATION_MIN}
              max={0.9}
              colorClass="bg-train"
              accentClass="text-train"
              format={(v) => pct(v)}
              sublabel={poolSub(breakdown.train)}
              hint
            />
          </AllocationSlot>
          <AllocationSlot pool="serve" onHover={hoverPool}>
            <SliderField
              label="Serve"
              value={a.inference}
              onChange={(v) => setSplit('inference', v)}
              min={COMPUTE_ALLOCATION_MIN}
              max={0.9}
              colorClass="bg-infer"
              accentClass="text-infer"
              format={(v) => pct(v)}
              sublabel={poolSub(breakdown.serve)}
              hint
            />
          </AllocationSlot>
          <AllocationSlot pool="research" onHover={hoverPool}>
            <SliderField
              label="Research"
              value={a.research}
              onChange={(v) => setSplit('research', v)}
              min={COMPUTE_ALLOCATION_MIN}
              max={0.9}
              colorClass="bg-research"
              accentClass="text-research"
              format={(v) => pct(v)}
              sublabel={poolSub(breakdown.research)}
              hint
            />
          </AllocationSlot>
        </div>

        {(a.training <= 0 || a.inference <= 0 || a.research <= 0) ? (
          <p className="operations-zero-note relative z-10 mt-2 text-[0.6875rem] leading-snug text-amber">
            Zero allocation pauses that queue. Restore compute whenever you want work to resume.
          </p>
        ) : null}

        {expanded ? (
          <div className="operations-expanded-meta relative z-10 mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line/50 pt-2 font-mono text-[0.6875rem] text-muted">
            <span>
              Util cap <strong className="text-bone">{pct(state.player.utilCap)}</strong>
            </span>
            <span>
              Serve{' '}
              <strong className="text-infer">{pct(state.player.servingEfficiency)}</strong>
            </span>
            <span>
              Train{' '}
              <strong className="text-train">{pct(state.player.trainEfficiency)}</strong>
            </span>
            <span>
              Fleet yield{' '}
              <strong className="text-mint">
                {pct(snap.rawFlopsPf > 0 ? snap.effectiveFlopsPf / snap.rawFlopsPf : 0)}
              </strong>{' '}
              of raw compute
            </span>
            <span>
              Shared grid{' '}
              <strong className={grid.priceMult > 1.35 ? 'text-amber' : 'text-bone'}>
                {num(grid.gridDemandMw)}/{num(grid.gridCapMw)} MW
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

function AllocationSlot({
  pool,
  onHover,
  children,
}: {
  pool: HoveredPool
  onHover: (pool: HoveredPool) => void
  children: ReactNode
}) {
  return (
    <div
      className="min-w-0"
      data-pool={pool}
      onMouseEnter={() => onHover(pool)}
      onFocusCapture={() => onHover(pool)}
    >
      {children}
    </div>
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
        <span className="text-bone">{pct(pool.allocShare)}</span>
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
    <span
      className={`operations-stat inline-flex max-w-full items-baseline gap-1 overflow-hidden whitespace-nowrap text-muted ${className}`}
      title={title}
    >
      <span className="shrink-0 text-[0.625rem] uppercase tracking-wide opacity-80">{label}</span>
      <strong className={`min-w-0 truncate text-bone ${danger ? 'text-danger' : ''}`}>{value}</strong>
      {sub && <span className="hidden min-w-0 truncate text-muted/80 2xl:inline">{sub}</span>}
    </span>
  )
}

function StatusChip({
  children,
  tone,
  title,
}: {
  children: ReactNode
  tone: 'danger' | 'warning'
  title?: string
}) {
  return (
    <span
      title={title}
      className={`operations-status-chip hidden shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium sm:inline-flex ${
        tone === 'danger' ? 'bg-danger/15 text-danger' : 'bg-amber/15 text-amber'
      }`}
    >
      {children}
    </span>
  )
}

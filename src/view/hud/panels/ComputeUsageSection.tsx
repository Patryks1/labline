import type { PanelId } from '../../../sim/types'
import { buildLabStats } from '../../../sim/systems/stats'
import { money, num, pct } from '../format'
import { GameCard, MeterBar, StatRow } from '../ui/kit'
import { HudButton, MetricTile } from '../ui/HudPrimitives'
import { HudDesktopDefaultDetails } from '../ui/HudDesktopDefaultDetails'
import { SparkTrendCard } from './command/SparkTrendCard'
import type { FinanceDashboardModel } from '../data/financeDashboardModel'

export function ComputeUsageSection({
  stats,
  financeModel,
  setPanel,
}: {
  stats: ReturnType<typeof buildLabStats>
  financeModel: FinanceDashboardModel
  setPanel: (panel: PanelId) => void
}) {
  const c = stats.compute
  return (
    <div className="space-y-3" data-compute-usage="true">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricTile label="Compute online" value={`${num(c.effectiveFlopsPf, 1)} PF`} />
        <MetricTile
          label="In use"
          value={pct(c.pfUtilization, 0)}
          tone={c.pfUtilization > 0.9 ? 'warning' : 'neutral'}
        />
        <MetricTile
          label="Demand served"
          value={pct(1 - c.unservedRatio, 0)}
          tone={c.unservedRatio > 0.1 ? 'danger' : c.unservedRatio <= 0.05 ? 'positive' : 'neutral'}
        />
        <MetricTile label="Cost / MTok" value={money(c.costPerMTokServed)} />
      </div>

      <GameCard eyebrow="Capacity" title="What limits you">
        <div className="space-y-3">
          <MeterBar
            label="Compute utilization"
            value={c.pfUtilization}
            detail={`${num(c.effectiveFlopsPf, 1)} effective PF`}
            tone={c.pfUtilization > 0.9 ? 'warning' : 'positive'}
          />
          <MeterBar
            label="Demand served"
            value={1 - c.unservedRatio}
            detail={`${num(c.servedMTok, 1)} / ${num(c.demandMTok, 1)} MTok`}
            tone={c.unservedRatio > 0.1 ? 'danger' : 'positive'}
          />
          <MeterBar
            label="Power headroom"
            value={c.mwAvailable > 0 ? 1 - c.mwDemand / c.mwAvailable : 0}
            detail={`${num(c.mwDemand, 2)} / ${num(c.mwAvailable, 2)} MW`}
            tone="warning"
          />
          <StatRow
            label="Operational rack footprint"
            value={`${c.racksUsed} rack-width`}
            hint="Admitted by physical layout, utilities, and access"
          />
        </div>
      </GameCard>

      <HudDesktopDefaultDetails className="group overflow-hidden rounded-lg border border-line bg-panel-2/60">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 marker:hidden lg:min-h-0">
          <span className="text-[0.8125rem] font-semibold text-bone">Serving history</span>
          <span className="font-mono text-[0.75rem] tabular-nums text-muted">
            {num(c.servedMTok, 1)} MTok/d
          </span>
        </summary>
        <div className="border-t border-line/50 p-2.5">
          <SparkTrendCard
            label="Serving demand"
            values={financeModel.trends.servedMTok}
            secondaryValues={financeModel.trends.effectivePf}
            days={financeModel.trends.days}
            format={(value) => `${num(value, 1)} MTok`}
            secondaryLabel="Effective PF"
            secondaryFormat={(value) => `${num(value, 1)} PF`}
            tall
          />
        </div>
      </HudDesktopDefaultDetails>

      <HudDesktopDefaultDetails className="group overflow-hidden rounded-lg border border-line bg-panel-2/60">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 marker:hidden lg:min-h-0">
          <span className="text-[0.8125rem] font-semibold text-bone">Compute cost centers</span>
          <span className="font-mono text-[0.75rem] tabular-nums text-danger">
            {money(-(c.trainCostDay + c.inferCostDay + c.researchCostDay))}
          </span>
        </summary>
        <div className="border-t border-line/50 p-2.5">
          <StatRow
            label={`Training (${pct(c.trainShare, 0)})`}
            value={money(-c.trainCostDay)}
            hint={`${num(c.pools.training, 2)} PF effective`}
            tone="danger"
          />
          <StatRow
            label={`Inference (${pct(c.inferShare, 0)})`}
            value={money(-c.inferCostDay)}
            hint={`${num(c.pools.inference, 2)} PF · product COGS`}
            tone="danger"
          />
          <StatRow
            label={`Research (${pct(c.researchShare, 0)})`}
            value={money(-c.researchCostDay)}
            hint={`${num(c.pools.research, 2)} PF effective`}
            tone="danger"
          />
        </div>
      </HudDesktopDefaultDetails>

      <HudDesktopDefaultDetails className="group rounded-lg border border-line bg-panel-2/70">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-[0.8125rem] font-semibold text-bone marker:hidden lg:min-h-0">
          <span>Chip fleet details</span>
          <span className="font-mono text-[0.75rem] font-normal text-muted">
            {money(stats.chipTotals.bookValue)} book ·{' '}
            <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-180">
              ⌄
            </span>
          </span>
        </summary>
        <div className="anim-stagger space-y-2 border-t border-line/50 px-3 py-3">
          {stats.chips.length === 0 ? (
            <p className="text-[0.8125rem] text-muted">No silicon online.</p>
          ) : (
            stats.chips.map((ch) => (
              <div key={ch.defId} className="rounded-md border border-line/70 px-2.5 py-2">
                <div className="flex justify-between gap-2 text-[0.8125rem] text-bone">
                  <span className="truncate">{ch.name}</span>
                  <span className="shrink-0 font-mono tabular-nums">×{ch.count}</span>
                </div>
                <div className="mt-1 flex justify-between gap-2 font-mono text-[0.6875rem] tabular-nums text-muted">
                  <span>{num(ch.flopsPf, 1)} PF</span>
                  <span>{num(ch.mw, 2)} MW</span>
                  <span>{money(ch.bookValue)} book</span>
                </div>
                {ch.arriving > 0 ? (
                  <div className="mt-1 text-[0.8125rem] text-amber">+{ch.arriving} arriving</div>
                ) : null}
              </div>
            ))
          )}
          <StatRow label="Fleet book value" value={money(stats.chipTotals.bookValue)} />
          <StatRow label="Fleet amort / day" value={money(-stats.chipTotals.amortPerDay)} tone="danger" />
        </div>
      </HudDesktopDefaultDetails>

      <div className="flex flex-wrap gap-2">
        <HudButton variant="ghost" className="!px-0 text-[0.8125rem]" onClick={() => setPanel('racks')}>
          Racks →
        </HudButton>
        <HudButton variant="ghost" className="!px-0 text-[0.8125rem]" onClick={() => setPanel('chips')}>
          Fab →
        </HudButton>
      </div>
    </div>
  )
}

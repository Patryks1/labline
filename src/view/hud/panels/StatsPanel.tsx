import { type ReactNode, useMemo, useState } from 'react'
import { buildLabStats, type StatsSectionId } from '../../../sim/systems/stats'
import type { PanelId } from '../../../sim/types'
import { useGameStore } from '../../../store/gameStore'
import { selectPlayerCompany } from '../../../sim/company'
import { money, num, pct } from '../format'
import { GameCard, MeterBar, SegmentedTabs, StatRow } from '../ui/kit'
import {
  HudButton,
  MetricTile,
  PanelScaffold,
  type HudTone,
} from '../ui/HudPrimitives'
import { buildFinanceDashboardModel, type FinanceDashboardModel } from '../data/financeDashboardModel'
import { capitalSnapshot } from '../../../sim/systems/capital'
import { SparkTrendCard } from './command/SparkTrendCard'
import { OrgPanel } from './OrgPanel'

const SECTIONS: { id: StatsSectionId; label: string }[] = [
  { id: 'pnl', label: 'P&L' },
  { id: 'capital', label: 'Capital' },
  { id: 'compute', label: 'Compute' },
]

function FinanceDisclosure({
  label,
  value,
  tone = 'text-muted',
  children,
}: {
  label: string
  value?: string
  tone?: string
  children: ReactNode
}) {
  return (
    <details className="group overflow-hidden rounded-lg border border-line bg-panel-2/60">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 marker:hidden lg:min-h-0">
        <span className="text-[0.8125rem] font-semibold text-bone">{label}</span>
        <span className="flex shrink-0 items-center gap-2">
          {value ? (
            <span className={`font-mono text-[0.75rem] tabular-nums ${tone}`}>
              {value}
            </span>
          ) : null}
          <span aria-hidden="true" className="inline-block text-muted transition-transform group-open:rotate-180">⌄</span>
        </span>
      </summary>
      <div className="border-t border-line/50 p-2.5">{children}</div>
    </details>
  )
}

function FinanceReadoutCell({
  label,
  value,
  tone = 'neutral',
  emphasis = false,
  onActivate,
  actionLabel,
}: {
  label: string
  value: string
  tone?: Extract<HudTone, 'neutral' | 'positive' | 'warning' | 'danger'>
  emphasis?: boolean
  onActivate?: () => void
  actionLabel?: string
}) {
  const className = `finance-readout__cell${emphasis ? ' finance-readout__cell--hero' : ''}${
    onActivate ? ' finance-readout__cell--action' : ''
  }`
  const body = (
    <>
      <span className="finance-readout__label">{label}</span>
      <strong className={`finance-readout__value finance-readout__value--${tone}`}>{value}</strong>
    </>
  )

  if (onActivate) {
    return (
      <button
        type="button"
        className={className}
        onClick={onActivate}
        title={actionLabel}
        aria-label={actionLabel ? `${label}: ${value}. ${actionLabel}` : undefined}
      >
        {body}
      </button>
    )
  }

  return <div className={className}>{body}</div>
}

export function StatsPanel() {
  const state = useGameStore((s) => s.state)
  const playerCompany = selectPlayerCompany(state)
  const setPanel = useGameStore((s) => s.setPanel)
  const setCommandView = useGameStore((s) => s.setCommandView)
  const [section, setSection] = useState<StatsSectionId>('pnl')
  const dashboard = useMemo(() => buildFinanceDashboardModel(state), [state])
  const capital = useMemo(() => capitalSnapshot(state), [state])
  const stats = dashboard.stats
  const runwayLabel =
    Number.isFinite(dashboard.current.runwayDays) && dashboard.current.runwayDays < 9000
      ? `${Math.floor(dashboard.current.runwayDays)}d`
      : '∞'

  return (
    <PanelScaffold
      eyebrow={`Day ${stats.day}`}
      title="Finances"
      description="P&L, capital, and compute."
      mobileDescription="Cash, runway, and daily profit."
      actions={
        <HudButton
          variant="ghost"
          className="!px-2.5 !py-1 text-[0.75rem]"
          onClick={() => setCommandView('pnl')}
          title="Open dock P&L"
        >
          Dock
        </HudButton>
      }
    >
      <div className="finance-readout" role="group" aria-label="Company position">
        <div className="finance-readout__grid">
          <FinanceReadoutCell
            label="Cash"
            value={money(playerCompany.finance.cash)}
            tone={playerCompany.finance.cash < 2e6 ? 'danger' : 'neutral'}
            emphasis
          />
          <FinanceReadoutCell
            label="Net / day"
            value={money(dashboard.current.net)}
            tone={
              dashboard.current.net < 0
                ? 'danger'
                : dashboard.current.net > 0
                  ? 'positive'
                  : 'neutral'
            }
            emphasis
          />
          <FinanceReadoutCell
            label="Runway"
            value={runwayLabel}
            tone={
              dashboard.current.runwayDays < 30
                ? 'danger'
                : dashboard.current.runwayDays < 90
                  ? 'warning'
                  : 'neutral'
            }
            emphasis
          />
          <FinanceReadoutCell label="Share" value={pct(dashboard.current.share, 1)} />
          <FinanceReadoutCell label="Valuation" value={money(dashboard.current.valuation)} />
          <FinanceReadoutCell
            label="Ownership"
            value={pct(capital.founderOwnership, 1)}
            tone={capital.founderOwnership < 0.1 ? 'danger' : 'neutral'}
            onActivate={() => setSection('capital')}
            actionLabel="Open Capital"
          />
        </div>
      </div>

      <div className="mt-3">
        <SegmentedTabs
          ariaLabel="Command sections"
          items={SECTIONS}
          active={section}
          onChange={(id) => setSection(id as StatsSectionId)}
        />
      </div>

      <div key={section} className="panel-swap mt-3">
        {section === 'pnl' && <PnlSection stats={stats} financeModel={dashboard} setPanel={setPanel} />}
        {section === 'capital' && <OrgPanel workspace="capital" embedded />}
        {section === 'compute' && <ComputeSection stats={stats} financeModel={dashboard} setPanel={setPanel} />}
      </div>
    </PanelScaffold>
  )
}

function PnlSection({
  stats,
  financeModel,
  setPanel,
}: {
  stats: ReturnType<typeof buildLabStats>
  financeModel: FinanceDashboardModel
  setPanel: (p: PanelId) => void
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2" data-mobile-summary="daily-pnl">
        <MetricTile label="Revenue / day" value={money(financeModel.revenue.total)} tone="positive" />
        <MetricTile label="Cash out / day" value={money(-financeModel.costs.totalCashOut)} tone="danger" />
      </div>

      <FinanceDisclosure
        label="Money history"
        value={money(financeModel.current.net)}
        tone={financeModel.current.net < 0 ? 'text-danger' : 'text-mint'}
      >
        <SparkTrendCard
          label="Money over time"
          values={financeModel.trends.net}
          secondaryValues={financeModel.trends.revenue}
          days={financeModel.trends.days}
          format={money}
          secondaryLabel="Revenue"
          tall
        />
      </FinanceDisclosure>

      <FinanceDisclosure label="Revenue ledger" value={money(financeModel.revenue.total)} tone="text-mint">
        <StatRow label="Total" value={money(financeModel.revenue.total)} tone="positive" strong />
        <div className="anim-stagger mt-1 border-t border-line/50 pt-1">
          {stats.income.map((line) => (
            <div key={line.id}>
              <StatRow label={line.label} value={money(line.amount)} hint={line.hint} tone="positive" />
              {line.id === 'api' ? (
                <div className="mb-1 ml-2 space-y-0.5 border-l border-line/40 pl-2">
                  {stats.models
                    .filter((m) => m.dayApiRevenue > 0)
                    .map((m) => (
                      <StatRow
                        key={`api-${m.modelId}`}
                        label={m.name}
                        value={money(m.dayApiRevenue)}
                        hint={`${num(m.dayApiMTok, 2)} MTok`}
                        tone="positive"
                      />
                    ))}
                </div>
              ) : null}
              {line.id === 'sub' ? (
                <div className="mb-1 ml-2 space-y-0.5 border-l border-line/40 pl-2">
                  {stats.plans
                    .filter((p) => p.dayRevenue > 0)
                    .map((p) => (
                      <StatRow
                        key={`sub-${p.planId}`}
                        label={p.name}
                        value={money(p.dayRevenue)}
                        hint={`${Math.round(p.subscribers).toLocaleString()} subs`}
                        tone="positive"
                      />
                    ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </FinanceDisclosure>

      <FinanceDisclosure label="Cost ledger" value={money(-financeModel.costs.totalCashOut)} tone="text-danger">
        <StatRow label="Product COGS" value={money(-financeModel.costs.productCogs)} tone="danger" strong />
        <div className="anim-stagger mt-1 border-t border-line/50 pt-1">
          {stats.productCosts.map((line) => (
            <StatRow key={line.id} label={line.label} value={money(line.amount)} hint={line.hint} tone="danger" />
          ))}
        </div>
        <div className="mt-2 border-t border-line/50 pt-2">
          <StatRow
            label="Operations (cash)"
            value={money(-financeModel.costs.operatingCashOut)}
            tone="danger"
            strong
          />
          <div className="anim-stagger mt-1">
            {stats.operatingCosts
              .filter((line) => !line.id.includes('of which') || Math.abs(line.amount) > 1)
              .map((line) => (
                <StatRow
                  key={line.id}
                  label={line.label}
                  value={money(line.amount)}
                  hint={line.hint}
                  tone="danger"
                />
              ))}
          </div>
        </div>
        <div className="mt-2 border-t border-line/50 pt-2">
          <StatRow label="Total cash out / day" value={money(-financeModel.costs.totalCashOut)} tone="danger" strong />
          <StatRow
            label="Net / day"
            value={money(financeModel.current.net)}
            tone={financeModel.current.net < 0 ? 'danger' : 'positive'}
            strong
          />
        </div>
      </FinanceDisclosure>

      <FinanceDisclosure
        label="Unit economics"
        value={`${money(stats.unitEconomics.marginPerMTok)}/MTok`}
        tone={stats.unitEconomics.marginPerMTok < 0 ? 'text-danger' : 'text-mint'}
      >
        <StatRow label="Revenue per MTok" value={money(stats.unitEconomics.revenuePerMTok)} />
        <StatRow label="Cost per MTok" value={money(stats.unitEconomics.costPerMTok)} tone="danger" />
        <StatRow
          label="Profit per MTok"
          value={money(stats.unitEconomics.marginPerMTok)}
          tone={stats.unitEconomics.marginPerMTok < 0 ? 'danger' : 'positive'}
          strong
        />
        <StatRow label="Gross margin" value={pct(stats.unitEconomics.grossMarginPct, 0)} />
      </FinanceDisclosure>

      {stats.plans.length > 0 ? (
        <FinanceDisclosure label="Plan breakdown" value={`${stats.plans.length} plans`}>
          <GameCard
            eyebrow="Plans"
            title="Breakdown"
            actions={
              <HudButton variant="ghost" className="!px-2 !py-1 text-[0.75rem]" onClick={() => setPanel('plans')}>
                Edit →
              </HudButton>
            }
          >
            <div className="anim-stagger space-y-2">
              {stats.plans.map((p) => (
                <div key={p.planId} className="rounded-md border border-line/70 bg-void/30 px-2.5 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[0.8125rem] font-medium text-bone">{p.name}</span>
                    <span className="shrink-0 font-mono text-[0.8125rem] tabular-nums text-muted">
                      {Math.round(p.subscribers).toLocaleString()} subs
                    </span>
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-2 font-mono text-[0.8125rem] tabular-nums sm:grid-cols-3">
                    <span className="text-mint">{money(p.dayRevenue)}</span>
                    <span className="text-right text-danger sm:text-center">{money(-p.dayCogs)}</span>
                    <span className={`col-span-2 text-center sm:col-span-1 sm:text-right ${p.marginPerSubMonth < 0 ? 'text-danger' : 'text-mint'}`}>
                      {money(p.marginPerSubMonth)}/sub
                    </span>
                  </div>
                  <div className="mt-0.5 font-mono text-[0.6875rem] tabular-nums text-muted">
                    {num(p.dayMTok, 2)} MTok/d
                  </div>
                </div>
              ))}
            </div>
          </GameCard>
        </FinanceDisclosure>
      ) : null}
    </div>
  )
}

function ComputeSection({
  stats,
  financeModel,
  setPanel,
}: {
  stats: ReturnType<typeof buildLabStats>
  financeModel: FinanceDashboardModel
  setPanel: (p: PanelId) => void
}) {
  const c = stats.compute
  return (
    <div className="space-y-3">
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

      <FinanceDisclosure label="Serving history" value={`${num(c.servedMTok, 1)} MTok/d`}>
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
      </FinanceDisclosure>

      <FinanceDisclosure
        label="Compute cost centers"
        value={money(-(c.trainCostDay + c.inferCostDay + c.researchCostDay))}
        tone="text-danger"
      >
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
      </FinanceDisclosure>

      <details className="group rounded-lg border border-line bg-panel-2/70">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-[0.8125rem] font-semibold text-bone marker:hidden lg:min-h-0">
          <span>Chip fleet details</span>
          <span className="font-mono text-[0.75rem] font-normal text-muted">
            {money(stats.chipTotals.bookValue)} book · <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-180">⌄</span>
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
                {ch.arriving > 0 ? <div className="mt-1 text-[0.8125rem] text-amber">+{ch.arriving} arriving</div> : null}
              </div>
            ))
          )}
          <StatRow label="Fleet book value" value={money(stats.chipTotals.bookValue)} />
          <StatRow label="Fleet amort / day" value={money(-stats.chipTotals.amortPerDay)} tone="danger" />
        </div>
      </details>

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

import { useMemo, useState } from 'react'
import { buildLabStats, sparkPath, type StatsSectionId } from '../../../sim/systems/stats'
import type { Model, PanelId } from '../../../sim/types'
import { useGameStore } from '../../../store/gameStore'
import { money, num, pct } from '../format'
import { GameCard, MeterBar, SegmentedTabs, StatRow } from '../ui/kit'
import {
  EmptyState,
  HudButton,
  MetricTile,
  PanelScaffold,
  StatusChip,
} from '../ui/HudPrimitives'
import { SparkTrendCard } from './command/SparkTrendCard'

const SECTIONS: { id: StatsSectionId; label: string }[] = [
  { id: 'pnl', label: 'P&L' },
  { id: 'models', label: 'Models' },
  { id: 'compute', label: 'Compute' },
  { id: 'facilities', label: 'Sites' },
]

export function StatsPanel() {
  const state = useGameStore((s) => s.state)
  const setPanel = useGameStore((s) => s.setPanel)
  const setCommandView = useGameStore((s) => s.setCommandView)
  const [section, setSection] = useState<StatsSectionId>('pnl')
  const stats = useMemo(() => buildLabStats(state), [state])
  const runwayLabel =
    Number.isFinite(stats.kpis.runwayDays) && stats.kpis.runwayDays < 9000
      ? `${Math.floor(stats.kpis.runwayDays)}d`
      : '∞'

  return (
    <PanelScaffold
      eyebrow={`Day ${stats.day}`}
      title="Command"
      description="Decisions, performance, and operational risk."
      actions={
        <HudButton
          variant="ghost"
          className="!px-2.5 !py-1 text-[0.75rem]"
          onClick={() => setCommandView('pnl')}
          title="Open dock P&L (F1)"
        >
          Dock
        </HudButton>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        <MetricTile
          label="Cash"
          value={money(stats.kpis.cash)}
          tone={stats.kpis.cash < 2e6 ? 'danger' : 'neutral'}
        />
        <MetricTile
          label="Net / day"
          value={money(stats.kpis.dayNet)}
          tone={stats.kpis.dayNet < 0 ? 'danger' : stats.kpis.dayNet > 0 ? 'positive' : 'neutral'}
        />
        <MetricTile label="Market share" value={pct(stats.kpis.share, 1)} tone="serve" />
        <MetricTile label="Valuation" value={money(stats.kpis.valuation)} />
        <MetricTile
          label="Runway"
          value={runwayLabel}
          tone={stats.kpis.runwayDays < 30 ? 'danger' : stats.kpis.runwayDays < 90 ? 'warning' : 'neutral'}
        />
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
        {section === 'pnl' && <PnlSection stats={stats} setPanel={setPanel} />}
        {section === 'models' && <ModelsSection stats={stats} setPanel={setPanel} />}
        {section === 'compute' && <ComputeSection stats={stats} setPanel={setPanel} />}
        {section === 'facilities' && <FacilitiesSection stats={stats} />}
      </div>
    </PanelScaffold>
  )
}

function PnlSection({
  stats,
  setPanel,
}: {
  stats: ReturnType<typeof buildLabStats>
  setPanel: (p: PanelId) => void
}) {
  const dayCosts = Math.abs(
    stats.finance.dayCogs + stats.operatingCosts.reduce((sum, line) => sum + Math.abs(line.amount), 0),
  )

  return (
    <div className="space-y-3">
      <SparkTrendCard
        label="Money over time"
        values={stats.trends.net}
        secondaryValues={stats.trends.revenue}
        days={stats.trends.days}
        format={money}
        secondaryLabel="Revenue"
        tall
      />

      <GameCard eyebrow="Ledger" title="Money in" tone="mint">
        <StatRow label="Total" value={money(stats.finance.dayRevenue)} tone="positive" strong />
        <div className="anim-stagger mt-1 border-t border-line/50 pt-1">
          {stats.income.map((line) => (
            <StatRow key={line.id} label={line.label} value={money(line.amount)} hint={line.hint} tone="positive" />
          ))}
        </div>
      </GameCard>

      <GameCard
        eyebrow="Ledger"
        title="Costs"
        tone={(stats.finance.dayGrossProfit ?? 0) < 0 ? 'danger' : 'train'}
      >
        <StatRow label="Product COGS" value={money(-Math.abs(stats.finance.dayCogs))} tone="danger" strong />
        <div className="anim-stagger mt-1 border-t border-line/50 pt-1">
          {stats.productCosts.map((line) => (
            <StatRow key={line.id} label={line.label} value={money(line.amount)} hint={line.hint} tone="danger" />
          ))}
        </div>
        <div className="mt-2 border-t border-line/50 pt-2">
          <StatRow
            label="Operations"
            value={money(-stats.operatingCosts.reduce((sum, line) => sum + Math.abs(line.amount), 0))}
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
          <StatRow label="Total costs / day" value={money(-dayCosts)} tone="danger" strong />
          <StatRow
            label="Net / day"
            value={money(stats.kpis.dayNet)}
            tone={stats.kpis.dayNet < 0 ? 'danger' : 'positive'}
            strong
          />
        </div>
      </GameCard>

      <GameCard eyebrow="Unit economics" title="Per MTok">
        <StatRow label="Revenue per MTok" value={money(stats.unitEconomics.revenuePerMTok)} />
        <StatRow label="Cost per MTok" value={money(stats.unitEconomics.costPerMTok)} tone="danger" />
        <StatRow
          label="Profit per MTok"
          value={money(stats.unitEconomics.marginPerMTok)}
          tone={stats.unitEconomics.marginPerMTok < 0 ? 'danger' : 'positive'}
          strong
        />
        <StatRow label="Gross margin" value={pct(stats.unitEconomics.grossMarginPct, 0)} />
      </GameCard>

      {stats.plans.length > 0 ? (
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
                <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[0.8125rem] tabular-nums">
                  <span className="text-mint">{money(p.dayRevenue)}</span>
                  <span className="text-center text-danger">{money(-p.dayCogs)}</span>
                  <span className={`text-right ${p.marginPerSubMonth < 0 ? 'text-danger' : 'text-mint'}`}>
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
      ) : null}
    </div>
  )
}

function ModelsSection({
  stats,
  setPanel,
}: {
  stats: ReturnType<typeof buildLabStats>
  setPanel: (p: PanelId) => void
}) {
  if (stats.models.length === 0) {
    return (
      <EmptyState
        title="No models yet"
        description="Train and ship to see income attribution."
        action={
          <HudButton variant="primary" onClick={() => setPanel('models')}>
            Open models
          </HudButton>
        }
      />
    )
  }

  const earning = stats.models.filter((m) => m.dayNet !== 0 || m.isActive)
  const idle = stats.models.filter((m) => m.dayNet === 0 && !m.isActive)

  return (
    <div className="space-y-3">
      <p className="text-[0.8125rem] text-muted">
        Production traffic attributes to the <strong className="text-bone">active</strong> public model.
      </p>

      <div className="anim-stagger space-y-2.5">
        {earning.map((m) => (
          <ModelCard key={m.modelId} m={m} />
        ))}
      </div>

      {idle.length > 0 ? (
        <GameCard eyebrow="Fleet" title={`Idle / non-serving (${idle.length})`}>
          <div className="anim-stagger space-y-2">
            {idle.map((m) => (
              <div
                key={m.modelId}
                className="flex items-start justify-between gap-2 rounded-md border border-line/60 px-2.5 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-[0.8125rem] text-bone">{m.name}</div>
                  <div className="mt-0.5 font-mono text-[0.6875rem] tabular-nums text-muted">
                    {m.family} · cap {m.capability.toFixed(0)} · {m.release}
                  </div>
                  <div className="mt-0.5 text-[0.8125rem] text-muted">{m.note}</div>
                </div>
                <span className="shrink-0 font-mono text-[0.8125rem] tabular-nums text-muted">{money(0)}</span>
              </div>
            ))}
          </div>
        </GameCard>
      ) : null}

      <HudButton variant="ghost" className="!px-0 text-[0.8125rem]" onClick={() => setPanel('models')}>
        Manage models →
      </HudButton>
    </div>
  )
}

function ModelCard({ m }: { m: ReturnType<typeof buildLabStats>['models'][0] }) {
  const model = useGameStore((store) => store.state.player.models.find((candidate) => candidate.id === m.modelId))
  return (
    <GameCard
      eyebrow={m.family}
      title={
        <span className="inline-flex items-center gap-2">
          <span className="truncate">{m.name}</span>
          {m.isActive ? <StatusChip tone="positive">ACTIVE</StatusChip> : null}
        </span>
      }
      tone={m.isActive ? 'mint' : undefined}
      actions={
        <span
          className={`font-mono text-sm font-semibold tabular-nums ${
            m.dayNet < 0 ? 'text-danger' : m.dayNet > 0 ? 'text-mint' : 'text-muted'
          }`}
        >
          {money(m.dayNet)}
        </span>
      }
    >
      <div className="font-mono text-[0.6875rem] tabular-nums text-muted">
        cap {m.capability.toFixed(0)} · ${m.apiPricePerMTok.toFixed(2)}/MTok
      </div>
      <div className="mt-2 space-y-0.5">
        <StatRow label="API rev" value={money(m.dayApiRevenue)} />
        <StatRow label="API COGS" value={money(-m.dayApiCogs)} tone="danger" />
        <StatRow label="API MTok" value={num(m.dayApiMTok, 2)} />
        <StatRow label="Sub rev" value={money(m.daySubRevenue)} />
        <StatRow label="Sub COGS" value={money(-m.daySubCogs)} tone="danger" />
        <StatRow label="Enterprise" value={money(m.dayEnterpriseShare)} />
      </div>
      {model ? <MiniCapabilityRadar model={model} /> : null}
      <p className="mt-2 text-[0.8125rem] leading-snug text-muted">{m.note}</p>
    </GameCard>
  )
}

function MiniCapabilityRadar({ model }: { model: Model }) {
  const axes = [
    ['Knowledge', model.benchmarks.mmlu ?? 0],
    ['Code', model.benchmarks.coding ?? 0],
    ['Reason', model.benchmarks.math ?? 0],
    ['Safety', model.benchmarks.safety ?? model.quality.safety],
    ['Speed', Math.min(100, (model.serviceProfile?.interactiveTokPerSec ?? 0) / 3)],
  ] as const
  const center = 55
  const radius = 38
  const points = axes
    .map(([, value], index) => {
      const angle = -Math.PI / 2 + (index / axes.length) * Math.PI * 2
      const r = radius * Math.max(0, Math.min(1, value / 100))
      return `${center + Math.cos(angle) * r},${center + Math.sin(angle) * r}`
    })
    .join(' ')

  return (
    <div className="mt-2 grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2 rounded-md border border-line/60 bg-void/30 p-2">
      <svg viewBox="0 0 110 110" className="h-24 w-24" role="img" aria-label={`${model.name} evaluation radar`}>
        {[0.33, 0.66, 1].map((ring) => (
          <circle key={ring} cx={center} cy={center} r={radius * ring} fill="none" stroke="rgba(139,171,181,.2)" />
        ))}
        <polygon points={points} fill="rgba(86,225,220,.2)" stroke="#56e1dc" strokeWidth="1.5" />
      </svg>
      <div className="grid grid-cols-2 gap-1">
        {axes.map(([label, value]) => (
          <div key={label} className="rounded-md bg-panel-2 px-1.5 py-1">
            <span className="block text-[0.6875rem] uppercase tracking-[0.12em] text-muted">{label}</span>
            <strong className="font-mono text-[0.8125rem] tabular-nums text-bone">{value.toFixed(0)}</strong>
          </div>
        ))}
      </div>
    </div>
  )
}

function ComputeSection({
  stats,
  setPanel,
}: {
  stats: ReturnType<typeof buildLabStats>
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

      <SparkTrendCard
        label="Serving demand"
        values={stats.trends.servedMTok}
        secondaryValues={stats.trends.effectivePf}
        days={stats.trends.days}
        format={(value) => `${num(value, 1)} MTok`}
        secondaryLabel="Effective PF"
        secondaryFormat={(value) => `${num(value, 1)} PF`}
        tall
      />

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
          <MeterBar
            label="Rack space"
            value={c.rackCap > 0 ? c.racksUsed / c.rackCap : 0}
            detail={`${c.racksUsed} / ${c.rackCap} racks`}
            tone="serve"
          />
        </div>
      </GameCard>

      <GameCard eyebrow="Pools" title="Cost centers" tone="train">
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
      </GameCard>

      <details className="rounded-lg border border-line bg-panel-2/70">
        <summary className="cursor-pointer px-3 py-2.5 text-[0.8125rem] font-semibold text-bone">
          Chip fleet details
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
        <HudButton
          variant="ghost"
          className="!px-0 text-[0.8125rem]"
          onClick={() => useGameStore.getState().openSites()}
        >
          Sites →
        </HudButton>
      </div>
    </div>
  )
}

function FacilitiesSection({ stats }: { stats: ReturnType<typeof buildLabStats> }) {
  const t = stats.facilityTotals
  return (
    <div className="space-y-3">
      <GameCard eyebrow="Campus" title="Totals">
        <StatRow label="Facility opex / day" value={money(t.opex)} tone="danger" />
        <StatRow label="Capex sunk" value={money(t.capex)} />
        <StatRow label="Rack slots" value={`${t.racksUsed} / ${t.rackCap}`} />
        <StatRow label="Grid MW" value={num(t.mwGrid, 1)} />
        <StatRow label="Generation MW" value={num(t.mwGen, 1)} />
      </GameCard>

      {stats.facilities.length === 0 ? (
        <EmptyState title="No buildings yet" description="Construct sites to expand rack and power capacity." />
      ) : (
        <GameCard eyebrow="Sites" title="Buildings">
          <div className="anim-stagger space-y-2">
            {stats.facilities.map((f) => (
              <div key={f.key} className="rounded-md border border-line/70 bg-void/25 px-2.5 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[0.8125rem] font-medium text-bone">{f.name}</span>
                  <span className="shrink-0 font-mono text-[0.8125rem] tabular-nums text-muted">L{f.level}</span>
                </div>
                <div className="mt-0.5 font-mono text-[0.6875rem] tabular-nums text-muted">
                  {f.kind} · {f.region}
                  {!f.complete ? ' · building…' : ''}
                </div>
                <div className="mt-1 space-y-0.5">
                  <StatRow label="Opex" value={`${money(f.opexPerDay)}/d`} tone="danger" />
                  <StatRow label="Capex" value={money(f.capex)} />
                  {f.rackCapacity > 0 ? (
                    <StatRow label="Racks" value={`${f.racksUsed}/${f.rackCapacity}`} />
                  ) : null}
                  {f.mwCapacity > 0 || f.mwGeneration > 0 ? (
                    <StatRow
                      label="Power"
                      value={[
                        f.mwCapacity > 0 ? `${num(f.mwCapacity, 1)} grid` : '',
                        f.mwGeneration > 0 ? `${num(f.mwGeneration, 1)} gen` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    />
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </GameCard>
      )}
    </div>
  )
}

// Keep sparkPath import live for typecheck of shared trend helper usage site.
void sparkPath

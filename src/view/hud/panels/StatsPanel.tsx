import { useMemo, useState, type ReactNode } from 'react'
import { buildLabStats, sparkPath, type StatsSectionId } from '../../../sim/systems/stats'
import type { PanelId } from '../../../sim/types'
import { useGameStore } from '../../../store/gameStore'
import { money, num, pct } from '../format'

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

  return (
    <div className="space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="hud-panel-title">Command</h2>
          <p className="hud-panel-sub">Day {stats.day} · decisions, performance, and operational risk</p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-full bg-void px-2 py-0.5 font-mono text-[0.6875rem] text-muted hover:text-mint"
          onClick={() => setCommandView('pnl')}
          title="Open dock P&L (F1)"
        >
          Dock
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1">
        <Kpi label="Cash" value={money(stats.kpis.cash)} danger={stats.kpis.cash < 2e6} />
        <Kpi
          label="Net"
          value={money(stats.kpis.dayNet)}
          danger={stats.kpis.dayNet < 0}
          mint={stats.kpis.dayNet > 0}
        />
        <Kpi label="Share" value={pct(stats.kpis.share, 1)} />
        <Kpi label="Rev" value={money(stats.kpis.dayRevenue)} />
        <Kpi label="Value" value={money(stats.kpis.valuation)} />
        <Kpi
          label="Runway"
          value={
            Number.isFinite(stats.kpis.runwayDays) && stats.kpis.runwayDays < 9000
              ? `${Math.floor(stats.kpis.runwayDays)}d`
              : '∞'
          }
          danger={stats.kpis.runwayDays < 30}
        />
      </div>

      <nav className="flex gap-0.5 rounded-xl bg-void/50 p-0.5">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSection(s.id)}
            className={`min-w-0 flex-1 rounded-lg px-1 py-1.5 text-center text-[0.75rem] font-medium transition ${
              section === s.id ? 'bg-bone text-void shadow-sm' : 'text-muted hover:text-bone'
            }`}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {section === 'pnl' && <PnlSection stats={stats} setPanel={setPanel} />}
      {section === 'models' && <ModelsSection stats={stats} setPanel={setPanel} />}
      {section === 'compute' && (
        <ComputeSection
          stats={stats}
          setPanel={setPanel}
        />
      )}
      {section === 'facilities' && <FacilitiesSection stats={stats} />}
    </div>
  )
}

function PnlSection({
  stats,
  setPanel,
}: {
  stats: ReturnType<typeof buildLabStats>
  setPanel: (p: PanelId) => void
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <Kpi label="Revenue / day" value={money(stats.kpis.dayRevenue)} mint />
        <Kpi label="Costs / day" value={money(-Math.abs(stats.finance.dayCogs + stats.operatingCosts.reduce((sum, line) => sum + Math.abs(line.amount), 0)))} danger />
        <Kpi label="Net / day" value={money(stats.kpis.dayNet)} danger={stats.kpis.dayNet < 0} mint={stats.kpis.dayNet >= 0} />
        <Kpi label="Cash" value={money(stats.kpis.cash)} danger={stats.kpis.cash < 2e6} />
      </div>
      <SparkCard label="Money over time" values={stats.trends.net} secondaryValues={stats.trends.revenue} days={stats.trends.days} format={money} secondaryLabel="Revenue" />

      <FinanceDisclosure title="Money in" total={stats.finance.dayRevenue} tone="mint" summary="API, subscriptions, and contracts">
        {stats.income.map((line) => <Line key={line.id} label={line.label} value={money(line.amount)} hint={line.hint} positive />)}
      </FinanceDisclosure>
      <FinanceDisclosure title="Product costs" total={-Math.abs(stats.finance.dayCogs)} tone={(stats.finance.dayGrossProfit ?? 0) < 0 ? 'danger' : 'neutral'} summary="Compute used to serve customers">
        {stats.productCosts.map((line) => <Line key={line.id} label={line.label} value={money(line.amount)} hint={line.hint} danger />)}
      </FinanceDisclosure>
      <FinanceDisclosure title="Operations" total={-stats.operatingCosts.reduce((sum, line) => sum + Math.abs(line.amount), 0)} tone="danger" summary="People, sites, marketing, and financing">
        {stats.operatingCosts.filter((line) => !line.id.includes('of which') || Math.abs(line.amount) > 1).map((line) => <Line key={line.id} label={line.label} value={money(line.amount)} hint={line.hint} danger muted={line.id.includes('of which')} />)}
      </FinanceDisclosure>

      <Section title="Simple unit economics">
        <Line label="You earn per MTok" value={money(stats.unitEconomics.revenuePerMTok)} />
        <Line label="It costs per MTok" value={money(stats.unitEconomics.costPerMTok)} danger />
        <Line label="Profit per MTok" value={money(stats.unitEconomics.marginPerMTok)} danger={stats.unitEconomics.marginPerMTok < 0} mint={stats.unitEconomics.marginPerMTok > 0} strong />
        <Line label="Gross margin" value={pct(stats.unitEconomics.grossMarginPct, 0)} />
      </Section>

      {stats.plans.length > 0 && (
        <Section title="Plans breakdown">
          <div className="space-y-1.5">
            {stats.plans.map((p) => (
              <div
                key={p.planId}
                className="rounded-lg border border-line/80 bg-void/30 px-2 py-1.5 font-mono text-[0.75rem]"
              >
                <div className="flex justify-between text-bone">
                  <span>{p.name}</span>
                  <span>{Math.round(p.subscribers).toLocaleString()} subs</span>
                </div>
                <div className="mt-0.5 flex justify-between text-muted">
                  <span>{money(p.dayRevenue)} in</span>
                  <span className="text-danger">{money(-p.dayCogs)} cogs</span>
                  <span className={p.marginPerSubMonth < 0 ? 'text-danger' : 'text-mint'}>
                    {money(p.marginPerSubMonth)}/sub mo
                  </span>
                </div>
                <div className="mt-0.5 text-muted">{num(p.dayMTok, 2)} MTok/d</div>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="mt-2 text-[0.8125rem] text-mint hover:underline"
            onClick={() => setPanel('plans')}
          >
            Edit plans →
          </button>
        </Section>
      )}
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
      <Empty
        text="No models yet — train and ship to see income attribution."
        action="Open models"
        onClick={() => setPanel('models')}
      />
    )
  }

  const earning = stats.models.filter((m) => m.dayNet !== 0 || m.isActive)
  const idle = stats.models.filter((m) => m.dayNet === 0 && !m.isActive)

  return (
    <div className="space-y-3">
      <p className="text-[0.8125rem] text-muted">
        Production traffic attributes to the <strong className="text-bone">active</strong> public
        model. Switch active model under Models / pricing.
      </p>

      {earning.map((m) => (
        <ModelCard key={m.modelId} m={m} />
      ))}
      {idle.length > 0 && (
        <Section title={`Idle / non-serving (${idle.length})`}>
          <div className="space-y-1.5">
            {idle.map((m) => (
              <div
                key={m.modelId}
                className="flex items-start justify-between gap-2 rounded-lg border border-line/60 px-2 py-1.5 text-[0.8125rem]"
              >
                <div>
                  <div className="text-bone">{m.name}</div>
                  <div className="font-mono text-[0.75rem] text-muted">
                    {m.family} · cap {m.capability.toFixed(0)} · {m.release}
                  </div>
                  <div className="mt-0.5 text-[0.75rem] text-muted">{m.note}</div>
                </div>
                <span className="shrink-0 font-mono text-muted">{money(0)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <button
        type="button"
        className="text-[0.8125rem] text-mint hover:underline"
        onClick={() => setPanel('models')}
      >
        Manage models →
      </button>
    </div>
  )
}

function ModelCard({ m }: { m: ReturnType<typeof buildLabStats>['models'][0] }) {
  const model = useGameStore((store) => store.state.player.models.find((candidate) => candidate.id === m.modelId))
  return (
    <div
      className={`rounded-xl border p-3 ${
        m.isActive ? 'border-mint/40 bg-mint/5' : 'border-line bg-panel-2'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-bone">{m.name}</span>
            {m.isActive && (
              <span className="rounded-full bg-mint/20 px-1.5 py-0.5 font-mono text-[0.6875rem] text-mint">
                ACTIVE
              </span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-[0.75rem] text-muted">
            {m.family} · cap {m.capability.toFixed(0)} · ${m.apiPricePerMTok.toFixed(2)}/MTok
          </div>
        </div>
        <div
          className={`font-mono text-sm font-medium ${
            m.dayNet < 0 ? 'text-danger' : m.dayNet > 0 ? 'text-mint' : 'text-muted'
          }`}
        >
          {money(m.dayNet)}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[0.75rem] text-muted">
        <span>API rev</span>
        <span className="text-right text-bone">{money(m.dayApiRevenue)}</span>
        <span>API COGS</span>
        <span className="text-right text-danger">{money(-m.dayApiCogs)}</span>
        <span>API MTok</span>
        <span className="text-right text-bone">{num(m.dayApiMTok, 2)}</span>
        <span>Sub rev</span>
        <span className="text-right text-bone">{money(m.daySubRevenue)}</span>
        <span>Sub COGS</span>
        <span className="text-right text-danger">{money(-m.daySubCogs)}</span>
        <span>Enterprise</span>
        <span className="text-right text-bone">{money(m.dayEnterpriseShare)}</span>
      </div>
      {model ? <MiniCapabilityRadar model={model} /> : null}
      <p className="mt-2 text-[0.75rem] leading-snug text-muted">{m.note}</p>
    </div>
  )
}

function MiniCapabilityRadar({ model }: { model: import('../../../sim/types').Model }) {
  const axes = [
    ['Knowledge', model.benchmarks.mmlu ?? 0],
    ['Code', model.benchmarks.coding ?? 0],
    ['Reason', model.benchmarks.math ?? 0],
    ['Safety', model.benchmarks.safety ?? model.quality.safety],
    ['Speed', Math.min(100, (model.serviceProfile?.interactiveTokPerSec ?? 0) / 3)],
  ] as const
  const center = 55
  const radius = 38
  const points = axes.map(([, value], index) => {
    const angle = -Math.PI / 2 + index / axes.length * Math.PI * 2
    const r = radius * Math.max(0, Math.min(1, value / 100))
    return `${center + Math.cos(angle) * r},${center + Math.sin(angle) * r}`
  }).join(' ')
  return <div className="mt-2 grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2 rounded-lg border border-line/60 bg-void/30 p-2">
    <svg viewBox="0 0 110 110" className="h-24 w-24" role="img" aria-label={`${model.name} evaluation radar`}>
      {[.33, .66, 1].map((ring) => <circle key={ring} cx={center} cy={center} r={radius * ring} fill="none" stroke="rgba(139,171,181,.2)" />)}
      <polygon points={points} fill="rgba(86,225,220,.2)" stroke="#56e1dc" strokeWidth="1.5" />
    </svg>
    <div className="grid grid-cols-2 gap-1">{axes.map(([label, value]) => <div key={label} className="rounded bg-panel-2 px-1.5 py-1"><span className="block text-[0.5625rem] uppercase text-muted">{label}</span><strong className="font-mono text-[0.6875rem] text-bone">{value.toFixed(0)}</strong></div>)}</div>
  </div>
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
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <Kpi label="Compute online" value={`${num(c.effectiveFlopsPf, 1)} PF`} />
        <Kpi label="In use" value={pct(c.pfUtilization, 0)} danger={c.pfUtilization > .9} />
        <Kpi label="Demand served" value={pct(1 - c.unservedRatio, 0)} danger={c.unservedRatio > .1} mint={c.unservedRatio <= .05} />
        <Kpi label="Cost / MTok" value={money(c.costPerMTokServed)} />
      </div>
      <SparkCard label="Serving demand" values={stats.trends.servedMTok} secondaryValues={stats.trends.effectivePf} days={stats.trends.days} format={(value) => `${num(value, 1)} MTok`} secondaryLabel="Effective PF" secondaryFormat={(value) => `${num(value, 1)} PF`} />
      <Section title="What limits you">
        <MetricRail label="Compute utilization" value={c.pfUtilization} detail={`${num(c.effectiveFlopsPf, 1)} effective PF`} title="Share of effective compute currently doing useful work." />
        <MetricRail label="Demand served" value={1 - c.unservedRatio} detail={`${num(c.servedMTok, 1)} / ${num(c.demandMTok, 1)} MTok`} title="Customer tokens served compared with requested tokens." />
        <MetricRail label="Power headroom" value={c.mwAvailable > 0 ? 1 - c.mwDemand / c.mwAvailable : 0} detail={`${num(c.mwDemand, 2)} / ${num(c.mwAvailable, 2)} MW`} title="Power left before racks throttle." />
        <MetricRail label="Rack space" value={c.rackCap > 0 ? c.racksUsed / c.rackCap : 0} detail={`${c.racksUsed} / ${c.rackCap} racks`} title="Physical rack bays occupied." />
      </Section>

      <Section title="Pool cost centers">
        <Line
          label={`Training (${pct(c.trainShare, 0)})`}
          value={money(-c.trainCostDay)}
          danger
          hint={`${num(c.pools.training, 2)} PF effective`}
        />
        <Line
          label={`Inference (${pct(c.inferShare, 0)})`}
          value={money(-c.inferCostDay)}
          danger
          hint={`${num(c.pools.inference, 2)} PF · product COGS source`}
        />
        <Line
          label={`Research (${pct(c.researchShare, 0)})`}
          value={money(-c.researchCostDay)}
          danger
          hint={`${num(c.pools.research, 2)} PF effective`}
        />
      </Section>

      <details className="rounded-xl border border-line bg-panel-2 p-3">
        <summary className="cursor-pointer text-[0.8125rem] font-medium uppercase tracking-wider text-muted">Chip fleet details</summary>
        <div className="mt-2">
        {stats.chips.length === 0 ? (
          <p className="text-[0.8125rem] text-muted">No silicon online.</p>
        ) : (
          stats.chips.map((ch) => (
            <div
              key={ch.defId}
              className="mb-1.5 rounded-lg border border-line/70 px-2 py-1.5 font-mono text-[0.75rem]"
            >
              <div className="flex justify-between text-bone">
                <span>{ch.name}</span>
                <span>×{ch.count}</span>
              </div>
              <div className="mt-0.5 flex justify-between text-muted">
                <span>{num(ch.flopsPf, 1)} PF</span>
                <span>{num(ch.mw, 2)} MW</span>
                <span>{money(ch.bookValue)} book</span>
              </div>
              {ch.arriving > 0 && (
                <div className="mt-0.5 text-amber">+{ch.arriving} arriving</div>
              )}
            </div>
          ))
        )}
        <Line label="Fleet book value" value={money(stats.chipTotals.bookValue)} />
        <Line label="Fleet amort / day" value={money(-stats.chipTotals.amortPerDay)} danger />
        </div>
      </details>

      <div className="flex flex-wrap gap-2 text-[0.8125rem]">
        <button type="button" className="text-mint hover:underline" onClick={() => setPanel('racks')}>
          Racks →
        </button>
        <button type="button" className="text-mint hover:underline" onClick={() => setPanel('chips')}>
          Fab →
        </button>
        <button type="button" className="text-mint hover:underline" onClick={() => useGameStore.getState().openSites()}>
          Sites →
        </button>
      </div>
    </div>
  )
}

function FacilitiesSection({ stats }: { stats: ReturnType<typeof buildLabStats> }) {
  const t = stats.facilityTotals
  return (
    <div className="space-y-3">
      <Section title="Campus totals">
        <Line label="Facility opex / day" value={money(t.opex)} danger />
        <Line label="Capex sunk" value={money(t.capex)} />
        <Line label="Rack slots" value={`${t.racksUsed} / ${t.rackCap}`} />
        <Line label="Grid MW" value={num(t.mwGrid, 1)} />
        <Line label="Generation MW" value={num(t.mwGen, 1)} />
      </Section>

      {stats.facilities.length === 0 ? (
        <p className="rounded-xl border border-line bg-panel-2 p-3 text-xs text-muted">No player buildings yet.</p>
      ) : (
        <Section title="Buildings">
          <div className="space-y-1.5">
            {stats.facilities.map((f) => (
              <div
                key={f.key}
                className="rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-[0.8125rem]"
              >
                <div className="flex justify-between gap-2">
                  <span className="font-medium text-bone">{f.name}</span>
                  <span className="font-mono text-muted">L{f.level}</span>
                </div>
                <div className="mt-0.5 font-mono text-[0.75rem] text-muted">
                  {f.kind} · {f.region}
                  {!f.complete ? ' · building…' : ''}
                </div>
                <div className="mt-1 grid grid-cols-2 gap-x-2 font-mono text-[0.75rem] text-muted">
                  <span>Opex</span>
                  <span className="text-right text-danger">{money(f.opexPerDay)}/d</span>
                  <span>Capex</span>
                  <span className="text-right text-bone">{money(f.capex)}</span>
                  {f.rackCapacity > 0 && (
                    <>
                      <span>Racks</span>
                      <span className="text-right text-bone">
                        {f.racksUsed}/{f.rackCapacity}
                      </span>
                    </>
                  )}
                  {(f.mwCapacity > 0 || f.mwGeneration > 0) && (
                    <>
                      <span>Power</span>
                      <span className="text-right text-bone">
                        {f.mwCapacity > 0 ? `${num(f.mwCapacity, 1)} grid` : ''}
                        {f.mwCapacity > 0 && f.mwGeneration > 0 ? ' · ' : ''}
                        {f.mwGeneration > 0 ? `${num(f.mwGeneration, 1)} gen` : ''}
                      </span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}

function SparkCard({
  label,
  values,
  secondaryValues,
  days,
  format,
  secondaryLabel,
  secondaryFormat,
}: {
  label: string
  values: number[]
  secondaryValues?: number[]
  days?: number[]
  format: (n: number) => string
  secondaryLabel?: string
  secondaryFormat?: (n: number) => string
}) {
  const [hovered, setHovered] = useState<number | null>(null)
  const last = values[values.length - 1] ?? 0
  const first = values[0] ?? 0
  const delta = last - first
  const path = sparkPath(values, 200, 36)
  const secondaryPath = secondaryValues ? sparkPath(secondaryValues, 200, 36) : ''
  const positive = last >= 0
  const pointIndex = hovered == null ? values.length - 1 : Math.max(0, Math.min(values.length - 1, hovered))
  return (
    <div className="rounded-xl border border-line bg-panel-2 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.8125rem] text-muted">{label}</span>
        <div className="text-right">
          <div className={`font-mono text-xs ${positive ? 'text-bone' : 'text-danger'}`}>
            {format(last)}
          </div>
          <div className={`font-mono text-[0.75rem] ${delta >= 0 ? 'text-mint' : 'text-danger'}`}>
            {delta >= 0 ? '+' : ''}
            {format(delta)} window
          </div>
        </div>
      </div>
      <svg
        viewBox="0 0 200 36"
        className="mt-1.5 h-14 w-full cursor-crosshair"
        preserveAspectRatio="none"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setHovered(Math.round(((event.clientX - rect.left) / Math.max(1, rect.width)) * Math.max(0, values.length - 1)))
        }}
        onPointerLeave={() => setHovered(null)}
      >
        {secondaryPath ? <path d={secondaryPath} fill="none" stroke="currentColor" strokeWidth="1" className="text-research/70" /> : null}
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-mint/80" />
        {hovered != null && values.length > 1 ? <line x1={(pointIndex / (values.length - 1)) * 200} x2={(pointIndex / (values.length - 1)) * 200} y1="0" y2="36" stroke="rgba(240,246,245,.45)" strokeWidth=".8" /> : null}
      </svg>
      <div className="mt-1 flex items-center justify-between gap-2 font-mono text-[0.625rem] text-muted">
        <span>D{days?.[pointIndex] ?? pointIndex + 1}</span>
        <span className="text-mint">{label}: {format(values[pointIndex] ?? 0)}</span>
        {secondaryValues ? <span className="text-research">{secondaryLabel}: {(secondaryFormat ?? format)(secondaryValues[pointIndex] ?? 0)}</span> : null}
      </div>
    </div>
  )
}

function FinanceDisclosure({ title, total, tone, summary, children }: { title: string; total: number; tone: 'mint' | 'danger' | 'neutral'; summary: string; children: ReactNode }) {
  return <details className="group rounded-xl border border-line bg-panel-2 p-3">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
      <span><strong className="block text-[0.8125rem] text-bone">{title}</strong><span className="text-[0.6875rem] text-muted">{summary}</span></span>
      <span className={`font-mono text-sm ${tone === 'mint' ? 'text-mint' : tone === 'danger' ? 'text-danger' : 'text-bone'}`}>{money(total)}</span>
    </summary>
    <div className="mt-3 border-t border-line/60 pt-2">{children}</div>
  </details>
}

function MetricRail({ label, value, detail, title }: { label: string; value: number; detail: string; title: string }) {
  const clamped = Math.max(0, Math.min(1, value))
  return <div className="mb-2 last:mb-0" title={title}>
    <div className="flex justify-between gap-2 text-[0.75rem]"><span className="text-muted">{label} <span aria-hidden>ⓘ</span></span><span className="font-mono text-bone">{detail}</span></div>
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-void"><div className={clamped > .9 ? 'h-full bg-amber' : 'h-full bg-mint'} style={{ width: `${clamped * 100}%` }} /></div>
  </div>
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-panel-2 p-3">
      <h3 className="mb-2 text-[0.8125rem] font-medium uppercase tracking-wider text-muted">{title}</h3>
      <div className="space-y-1 font-mono text-[0.8125rem]">{children}</div>
    </div>
  )
}

function Line({
  label,
  value,
  hint,
  strong,
  danger,
  mint,
  positive,
  muted,
}: {
  label: string
  value: string
  hint?: string
  strong?: boolean
  danger?: boolean
  mint?: boolean
  positive?: boolean
  muted?: boolean
}) {
  return (
    <div className={muted ? 'opacity-70' : ''}>
      <div className="flex justify-between gap-2">
        <span className={strong ? 'font-medium text-bone' : 'text-muted'}>{label}</span>
        <span
          className={`${strong ? 'font-medium' : ''} ${
            danger ? 'text-danger' : mint || positive ? 'text-mint' : 'text-bone'
          }`}
        >
          {value}
        </span>
      </div>
      {hint && <div className="text-[0.75rem] text-muted/80">{hint}</div>}
    </div>
  )
}

function Kpi({
  label,
  value,
  danger,
  mint,
}: {
  label: string
  value: string
  danger?: boolean
  mint?: boolean
}) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
      <div className="text-[0.6875rem] uppercase tracking-wider text-muted">{label}</div>
      <div
        className={`mt-0.5 truncate font-mono text-xs font-medium ${
          danger ? 'text-danger' : mint ? 'text-mint' : 'text-bone'
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function Empty({
  text,
  action,
  onClick,
}: {
  text: string
  action: string
  onClick: () => void
}) {
  return (
    <div className="rounded-xl border border-line bg-panel-2 p-3 text-xs text-muted">
      <p>{text}</p>
      <button type="button" className="mt-2 text-mint hover:underline" onClick={onClick}>
        {action} →
      </button>
    </div>
  )
}

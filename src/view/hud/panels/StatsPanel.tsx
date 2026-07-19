import { useMemo, useState, type ReactNode } from 'react'
import { buildLabStats, sparkPath, type StatsSectionId } from '../../../sim/systems/stats'
import type { PanelId } from '../../../sim/types'
import { useGameStore } from '../../../store/gameStore'
import { money, num, pct } from '../format'
import { buildObjectives } from '../objectives'
import { WarningCircle } from '@phosphor-icons/react'

const SECTIONS: { id: StatsSectionId; label: string }[] = [
  { id: 'pnl', label: 'P&L' },
  { id: 'models', label: 'Models' },
  { id: 'compute', label: 'Compute' },
  { id: 'facilities', label: 'Sites' },
  { id: 'trends', label: 'Trends' },
]

export function StatsPanel() {
  const state = useGameStore((s) => s.state)
  const setPanel = useGameStore((s) => s.setPanel)
  const autoBalanceHosting = useGameStore((s) => s.autoBalanceHosting)
  const setCommandView = useGameStore((s) => s.setCommandView)
  const [section, setSection] = useState<StatsSectionId>('pnl')
  const stats = useMemo(() => buildLabStats(state), [state])
  const objectives = useMemo(
    () => buildObjectives(state, !state.onboardingDismissed),
    [state],
  )

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

      {objectives.length > 0 ? (
        <section className="rounded-xl border border-line/70 bg-void/35 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-[0.8125rem] font-semibold text-bone">Priority decisions</h3>
            <span className="font-mono text-[0.6875rem] text-muted">{objectives.length} active</span>
          </div>
          <div className="grid gap-2 lg:grid-cols-3">
            {objectives.map((objective) => (
              <button
                key={objective.id}
                type="button"
                onClick={() => {
                  if (objective.buildKind) useGameStore.getState().setBuildMode(objective.buildKind)
                  else setPanel(objective.panel)
                }}
                className="rounded-lg border border-line/70 bg-panel-2/75 p-2.5 text-left hover:border-mint/35"
              >
                <span className="flex items-start gap-2">
                  <WarningCircle size="1rem" className={objective.severity === 'danger' ? 'text-danger' : objective.severity === 'warning' ? 'text-amber' : 'text-mint'} />
                  <span className="min-w-0">
                    <span className="block text-[0.75rem] font-semibold text-bone">{objective.title}</span>
                    <span className="mt-1 block text-[0.6875rem] leading-snug text-muted">{objective.progress}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

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
          onAutoBalance={() => autoBalanceHosting()}
        />
      )}
      {section === 'facilities' && <FacilitiesSection stats={stats} />}
      {section === 'trends' && <TrendsSection stats={stats} />}
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
      <Section title="Income">
        {stats.income.map((l) => (
          <Line key={l.id} label={l.label} value={money(l.amount)} hint={l.hint} positive />
        ))}
        <Line label="Total revenue" value={money(stats.finance.dayRevenue)} strong />
      </Section>

      <Section title="Product COGS">
        {stats.productCosts.map((l) => (
          <Line key={l.id} label={l.label} value={money(l.amount)} hint={l.hint} danger />
        ))}
        <Line
          label="Gross profit"
          value={money(stats.finance.dayGrossProfit ?? stats.finance.dayRevenue - stats.finance.dayCogs)}
          strong
          danger={(stats.finance.dayGrossProfit ?? 0) < 0}
          mint={(stats.finance.dayGrossProfit ?? 0) > 0}
        />
      </Section>

      <Section title="Operating costs">
        {stats.operatingCosts
          .filter((l) => !l.id.includes('of which') || Math.abs(l.amount) > 1)
          .map((l) => (
            <Line
              key={l.id}
              label={l.label}
              value={money(l.amount)}
              hint={l.hint}
              danger
              muted={l.id.includes('of which')}
            />
          ))}
      </Section>

      <Section title="Bottom line">
        <Line
          label="Day net P&L"
          value={money(stats.kpis.dayNet)}
          strong
          danger={stats.kpis.dayNet < 0}
          mint={stats.kpis.dayNet > 0}
          hint="Matches cash ops delta"
        />
        <Line label="Lifetime revenue" value={money(stats.kpis.lifetimeRevenue)} />
        <Line
          label="Lifetime net"
          value={money(stats.kpis.lifetimeNet)}
          danger={stats.kpis.lifetimeNet < 0}
          mint={stats.kpis.lifetimeNet > 0}
        />
        <Line label="Peak cash" value={money(stats.finance.peakCash ?? stats.kpis.cash)} />
        <Line label="Lowest cash" value={money(stats.finance.lowestCash ?? stats.kpis.cash)} />
      </Section>

      <Section title="Unit economics">
        <Line
          label="Margin / MTok"
          value={money(stats.unitEconomics.marginPerMTok)}
          danger={stats.unitEconomics.marginPerMTok < 0}
          mint={stats.unitEconomics.marginPerMTok > 0}
        />
        <Line
          label="Margin / sub (mo)"
          value={money(stats.unitEconomics.marginPerSubMonth)}
          danger={stats.unitEconomics.marginPerSubMonth < 0}
          mint={stats.unitEconomics.marginPerSubMonth > 0}
        />
        <Line label="Rev / MTok served" value={money(stats.unitEconomics.revenuePerMTok)} />
        <Line label="Cost / MTok served" value={money(stats.unitEconomics.costPerMTok)} />
        <Line label="Gross margin" value={pct(stats.unitEconomics.grossMarginPct, 0)} />
        <Line label="Net margin" value={pct(stats.unitEconomics.netMarginPct, 0)} />
        <Line
          label="API users (served)"
          value={Math.round(stats.unitEconomics.apiUsers).toLocaleString()}
        />
        <Line
          label="Plan subscribers"
          value={Math.round(stats.unitEconomics.planSubscribers).toLocaleString()}
        />
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
      <p className="mt-2 text-[0.75rem] leading-snug text-muted">{m.note}</p>
    </div>
  )
}

function ComputeSection({
  stats,
  setPanel,
  onAutoBalance,
}: {
  stats: ReturnType<typeof buildLabStats>
  setPanel: (p: PanelId) => void
  onAutoBalance?: () => void
}) {
  const c = stats.compute
  return (
    <div className="space-y-2.5">
      <div className="rounded-xl border border-mint/20 bg-mint/5 px-2.5 py-2 text-[0.75rem] leading-snug text-muted">
        Pool split lives on the <strong className="text-bone">bottom bar</strong> (Train / Serve /
        Research). Use Auto-bal to target ~80% serve headroom.
        {onAutoBalance && (
          <button
            type="button"
            onClick={onAutoBalance}
            className="ml-1.5 rounded-full bg-mint/20 px-2 py-0.5 font-medium text-mint"
          >
            Auto-bal
          </button>
        )}
      </div>
      <Section title="Capacity">
        <Line label="Raw PF" value={num(c.rawFlopsPf, 2)} />
        <Line label="Effective PF" value={num(c.effectiveFlopsPf, 2)} />
        <Line label="PF utilization" value={pct(c.pfUtilization, 0)} />
        <Line label="Util cap" value={pct(c.utilCap, 0)} />
        <Line
          label="Power"
          value={`${num(c.mwDemand, 2)} / ${num(c.mwAvailable, 2)} MW`}
          danger={c.throttled}
        />
        <Line label="Racks" value={`${c.racksUsed} / ${c.rackCap}`} />
        <Line
          label="VRAM"
          value={`${num(c.vramGb, 0)} GB`}
          danger={c.vramDerateServe < 0.95 || c.vramDerateTrain < 0.95}
        />
        <Line label="Train VRAM derate" value={pct(c.vramDerateTrain, 0)} />
        <Line label="Serve VRAM derate" value={pct(c.vramDerateServe, 0)} />
      </Section>

      <Section title="Tokens">
        <Line label="Serve capacity" value={`${num(c.capacityMTok, 1)} MTok/d`} />
        <Line label="Demand" value={`${num(c.demandMTok, 1)} MTok/d`} />
        <Line label="Served" value={`${num(c.servedMTok, 1)} MTok/d`} />
        <Line
          label="Unserved"
          value={pct(c.unservedRatio, 0)}
          danger={c.unservedRatio > 0.1}
        />
        <Line label="Energy price" value={`$${num(c.energyPrice, 0)}/MWh`} />
        <Line label="Energy cost / day" value={money(c.energyCostDay)} danger />
        <Line label="Fully loaded $/MTok" value={money(c.costPerMTokServed)} />
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

      <Section title="Chip fleet">
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
      </Section>

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
        <Empty text="No player buildings yet." action="Open build map" onClick={() => useGameStore.getState().openSites()} />
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

      <button type="button" className="text-[0.8125rem] text-mint hover:underline" onClick={() => useGameStore.getState().openSites()}>
        Campus map →
      </button>
    </div>
  )
}

function TrendsSection({ stats }: { stats: ReturnType<typeof buildLabStats> }) {
  const t = stats.trends
  if (t.days.length < 2) {
    return (
      <p className="rounded-xl border border-line bg-panel-2 p-3 text-xs text-muted">
        Trends fill as days advance (up to 90 samples). Step time or unpause to collect data.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <SparkCard label="Revenue / day" values={t.revenue} format={money} />
      <SparkCard label="Net P&L / day" values={t.net} format={money} />
      <SparkCard label="Cash" values={t.cash} format={money} />
      <SparkCard label="Market share" values={t.share} format={(v) => pct(v, 1)} />
      <SparkCard label="Served MTok" values={t.servedMTok} format={(v) => num(v, 1)} />
      <SparkCard label="Effective PF" values={t.effectivePf} format={(v) => num(v, 2)} />
      <SparkCard label="Valuation" values={t.valuation} format={money} />
      <p className="font-mono text-[0.75rem] text-muted">
        {t.days.length} days · day {t.days[0]} → {t.days[t.days.length - 1]}
      </p>
    </div>
  )
}

function SparkCard({
  label,
  values,
  format,
}: {
  label: string
  values: number[]
  format: (n: number) => string
}) {
  const last = values[values.length - 1] ?? 0
  const first = values[0] ?? 0
  const delta = last - first
  const path = sparkPath(values, 200, 36)
  const positive = last >= 0
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
      <svg viewBox="0 0 200 36" className="mt-1.5 h-9 w-full" preserveAspectRatio="none">
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-mint/80" />
      </svg>
    </div>
  )
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

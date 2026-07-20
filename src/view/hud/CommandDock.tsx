import { useState, type ReactNode } from 'react'
import {
  BellRinging,
  CaretLeft,
  CaretRight,
  ChartLine,
  UsersThree,
} from '@phosphor-icons/react'
import { competitiveCatchUpSnapshot } from '../../sim/systems/sharedMarkets'
import { useGameStore } from '../../store/gameStore'
import { money, num, pct } from './format'
import { COMMAND_VIEWS, type CommandViewId } from './navConfig'

/**
 * Floating right intelligence dock over the map.
 * Clickable, icon-led tabs switch P&L / Trends / Rivals / Feed without a second full panel.
 */
export function CommandDock({ forceCollapsed = false }: { forceCollapsed?: boolean }) {
  const open = useGameStore((s) => s.commandDockOpen)
  const view = useGameStore((s) => s.commandView)
  const setView = useGameStore((s) => s.setCommandView)
  const setOpen = useGameStore((s) => s.setCommandDockOpen)
  const setPanel = useGameStore((s) => s.setPanel)
  const state = useGameStore((s) => s.state)
  const expanded = open && !forceCollapsed

  return (
    <div className="intel-shell pointer-events-none">
      {!expanded ? (
        <aside className="hud-surface pointer-events-auto relative m-2 ml-1 flex h-[calc(100%-1rem)] flex-col items-center gap-1 rounded-xl py-2">
          <button
            type="button"
            title="Open intel dock (])"
            onClick={() => setOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-panel-2 hover:text-bone"
          >
            <CaretLeft size="1rem" />
          </button>
          {COMMAND_VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-label={v.label}
              title={`${v.label} (${v.key})`}
              onClick={() => setView(v.id)}
              className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                view === v.id ? 'bg-mint/15 text-mint' : 'text-muted hover:bg-panel-2 hover:text-bone'
              }`}
            >
              <CommandIcon id={v.id} />
            </button>
          ))}
        </aside>
      ) : (
        <aside className="hud-surface pointer-events-auto relative m-2 ml-1 flex h-[calc(100%-1rem)] min-w-0 flex-col overflow-hidden rounded-xl">
          <div className="relative z-10 flex items-center gap-1 border-b border-line/60 px-2 py-2">
            <div
              className="grid min-w-0 flex-1 gap-0.5 rounded-lg bg-void/55 p-0.5"
              style={{ gridTemplateColumns: `repeat(${COMMAND_VIEWS.length}, minmax(0, 1fr))` }}
            >
              {COMMAND_VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  aria-label={`${v.label} (${v.key})`}
                  aria-pressed={view === v.id}
                  title={`${v.label} (${v.key})`}
                  onClick={() => setView(v.id)}
                  className={`flex min-h-8 min-w-0 items-center justify-center rounded-md px-1 py-1.5 transition ${
                    view === v.id
                      ? 'bg-bone text-void shadow-sm'
                      : 'text-muted hover:bg-panel-2 hover:text-bone'
                  }`}
                >
                  <CommandIcon id={v.id} />
                </button>
              ))}
            </div>
            <button
              type="button"
              title="Collapse (])"
              onClick={() => setOpen(false)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-bone"
            >
              <CaretRight size="1rem" />
            </button>
          </div>

          <div className="panel-scroll relative z-10 min-h-0 flex-1 overflow-y-auto p-3">
            {view === 'pnl' && <PnlView onOpenStats={() => setPanel('stats')} />}
            {view === 'rivals' && (
              <RivalsView
                onOpenMarket={() => setPanel('market')}
                onInspect={() => setPanel('rivals')}
              />
            )}
            {view === 'feed' && <FeedView />}
          </div>

          <div className="relative z-10 border-t border-line/60 px-2.5 py-1.5 font-mono text-[0.625rem] text-muted">
            D{state.day}
            {state.paused ? ' · paused' : ` · ${state.speed}×`}
            <span className="float-right opacity-60">Tab · F1–4</span>
          </div>
        </aside>
      )}
    </div>
  )
}

function CommandIcon({ id }: { id: CommandViewId }) {
  const Icon = id === 'pnl' ? ChartLine : id === 'rivals' ? UsersThree : BellRinging
  return <Icon size="1.05rem" weight="duotone" aria-hidden />
}

function PnlView({ onOpenStats }: { onOpenStats: () => void }) {
  const f = useGameStore((s) => s.state.player.finance)
  const market = useGameStore((s) => s.state.lastMarket)
  const planStats = market.planStats
  const apiModels = market.modelFinance.filter(
    (model) => model.dayApiRevenue > 0 || model.dayApiCogs > 0 || model.dayApiMTok > 0,
  )
  const subMTok = planStats.reduce((sum, plan) => sum + plan.dayMTok, 0)
  const subUsers = planStats.reduce((sum, plan) => sum + plan.subscribers, 0)
  const enterpriseApiRevenue = f.enterpriseRevenue * 0.5
  const enterpriseSubRevenue = f.enterpriseRevenue - enterpriseApiRevenue
  const dayNet =
    typeof f.dayNet === 'number' ? f.dayNet : f.dayRevenue - f.dayCogs - f.dayEnergyCost

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted">Today</h2>
        <button type="button" onClick={onOpenStats} className="text-[0.75rem] text-mint hover:underline">
          Full intel
        </button>
      </div>
      <div className="space-y-1 font-mono text-[0.8125rem]">
        <ChannelBreakdown
          label="API"
          revenue={f.apiRevenue + enterpriseApiRevenue}
          cogs={f.apiCogs}
          usage={`${num(market.apiDayMTok, 2)} MTok`}
        >
          {apiModels.length > 0 ? apiModels.slice(0, 4).map((model) => (
            <BreakdownItem
              key={model.modelId}
              label={model.name}
              value={money(model.dayApiRevenue - model.dayApiCogs)}
              sub={`${num(model.dayApiMTok, 2)} MTok · ${money(model.dayApiCogs)} compute`}
              danger={model.dayApiRevenue - model.dayApiCogs < 0}
            />
          )) : (
            <p className="px-1 py-0.5 text-[0.6875rem] text-muted">No API model traffic today.</p>
          )}
          {enterpriseApiRevenue > 0 ? (
            <BreakdownItem
              label="Enterprise API"
              value={money(enterpriseApiRevenue)}
              sub="Contract endpoints"
            />
          ) : null}
        </ChannelBreakdown>
        <ChannelBreakdown
          label="Subs"
          revenue={f.subRevenue + enterpriseSubRevenue}
          cogs={f.subCogs}
          usage={`${num(subMTok, 2)} MTok · ${compactPeople(subUsers)} users`}
        >
          {planStats.length > 0 ? planStats.slice(0, 5).map((plan) => (
            <BreakdownItem
              key={plan.planId}
              label={plan.name}
              value={money(plan.dayRevenue - plan.dayCogs)}
              sub={`${compactPeople(plan.subscribers)} users · ${num(plan.dayMTok, 2)} MTok · ${money(plan.dayCogs)} compute`}
              danger={plan.dayRevenue - plan.dayCogs < 0}
            />
          )) : (
            <p className="px-1 py-0.5 text-[0.6875rem] text-muted">No live plan traffic today.</p>
          )}
          {enterpriseSubRevenue > 0 ? (
            <BreakdownItem
              label="Enterprise seats"
              value={money(enterpriseSubRevenue)}
              sub="Dedicated subscriptions"
            />
          ) : null}
        </ChannelBreakdown>
        <Row label="Product COGS" value={money(-(f.apiCogs + f.subCogs))} danger />
        <Row label="Energy" value={money(-f.dayEnergyCost)} danger />
        <Row label="Facility" value={money(-f.dayBuildingOpex)} danger />
        <Row label="Wages" value={money(-f.dayWageCost)} danger />
        <Row label="Marketing" value={money(-(f.dayMarketing ?? 0))} danger />
        <Row label="Amort" value={money(-f.dayChipAmort)} danger />
        <div className="my-1 h-px bg-line" />
        <Row label="Day net" value={money(dayNet)} danger={dayNet < 0} strong />
        <Row
          label="Margin/MTok"
          value={money(f.marginPerMTok)}
          danger={f.marginPerMTok < 0}
        />
        <Row label="Valuation" value={money(f.valuation)} strong />
        {Number.isFinite(f.runwayDays) && f.runwayDays < 9000 && (
          <Row label="Runway" value={`${Math.floor(f.runwayDays)}d`} danger={f.runwayDays < 30} />
        )}
      </div>

    </div>
  )
}

function ChannelBreakdown({
  label,
  revenue,
  cogs,
  usage,
  children,
}: {
  label: string
  revenue: number
  cogs: number
  usage: string
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(true)
  const net = revenue - cogs
  return (
    <div className="overflow-hidden rounded-lg border border-line/80 bg-panel-2/70">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-void/30"
      >
        <CaretRight
          size="0.75rem"
          className={`shrink-0 text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="min-w-0 flex-1 font-medium text-bone">{label}</span>
        <span className="text-bone">{money(revenue)}</span>
      </button>
      {expanded ? (
        <div className="space-y-1 border-t border-line/60 px-2 py-1.5">
          <div className="grid grid-cols-3 gap-1 text-[0.6875rem]">
            <BreakdownMetric label="Revenue" value={money(revenue)} />
            <BreakdownMetric label="Compute" value={money(-cogs)} danger />
            <BreakdownMetric label="Net" value={money(net)} danger={net < 0} />
          </div>
          <div className="truncate px-1 text-[0.625rem] text-muted" title={usage}>{usage}</div>
          <div className="space-y-1 border-t border-line/50 pt-1">{children}</div>
        </div>
      ) : null}
    </div>
  )
}

function BreakdownMetric({
  label,
  value,
  danger = false,
}: {
  label: string
  value: string
  danger?: boolean
}) {
  return (
    <div className="rounded-md bg-void/45 px-1.5 py-1">
      <div className="uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-0.5 truncate tabular-nums ${danger ? 'text-danger' : 'text-bone'}`} title={value}>{value}</div>
    </div>
  )
}

function BreakdownItem({
  label,
  value,
  sub,
  danger = false,
}: {
  label: string
  value: string
  sub: string
  danger?: boolean
}) {
  return (
    <div className="rounded-md bg-void/35 px-1.5 py-1">
      <div className="flex items-center justify-between gap-2 text-[0.6875rem]">
        <span className="min-w-0 truncate text-bone">{label}</span>
        <span className={`shrink-0 ${danger ? 'text-danger' : 'text-mint'}`}>{value} net</span>
      </div>
      <div className="mt-0.5 truncate text-[0.625rem] text-muted" title={sub}>{sub}</div>
    </div>
  )
}

function compactPeople(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return Math.round(value).toLocaleString()
}

function RivalsView({
  onOpenMarket,
  onInspect,
}: {
  onOpenMarket: () => void
  onInspect: () => void
}) {
  const state = useGameStore((s) => s.state)
  const share = state.player.finance.totalShare
  const competitiveResponse = competitiveCatchUpSnapshot(state)

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h2 className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted">
          Field · you {pct(share, 0)}
        </h2>
        <button type="button" onClick={onOpenMarket} className="text-[0.75rem] text-mint hover:underline">
          Market
        </button>
      </div>
      {state.rivals.map((r) => {
        const m = r.models[0]
        const overloaded = (r.lastUnserved ?? 0) > 0.12
        return (
          <div key={r.id} className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[0.8125rem] font-medium text-bone">{r.name}</span>
              <div className="flex items-center gap-1.5">
                {competitiveResponse.active && competitiveResponse.rivalId === r.id && (
                  <span className="rounded border border-mint/35 bg-mint/10 px-1 py-0.5 font-mono text-[0.5625rem] uppercase tracking-wide text-mint">
                    funded challenger
                  </span>
                )}
                <span className="font-mono text-[0.75rem] text-muted">
                  {(r.marketShare * 100).toFixed(0)}%
                </span>
              </div>
            </div>
            <div className="mt-0.5 font-mono text-[0.6875rem] leading-snug text-muted">
              {m ? `${m.name} · cap ${m.capability.toFixed(0)}` : 'quiet'} · $
              {r.pricing.apiPricePerMTok.toFixed(1)}/M
            </div>
            <div className="mt-0.5 font-mono text-[0.6875rem] text-muted">
              {num(r.flopsPf, 0)} PF ·{' '}
              <span className={overloaded ? 'text-danger' : 'text-mint'}>
                {overloaded ? `${((r.lastUnserved ?? 0) * 100).toFixed(0)}% short` : 'ok'}
              </span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-void">
              <div
                className="h-full bg-infer/80"
                style={{ width: `${Math.min(100, r.marketShare * 100)}%` }}
              />
            </div>
            <button
              type="button"
              onClick={onInspect}
              className="mt-1.5 w-full rounded-md border border-line/70 py-1 text-[0.6875rem] text-muted hover:border-mint/35 hover:text-mint"
            >
              Inspect public intelligence
            </button>
          </div>
        )
      })}
    </div>
  )
}

function FeedView() {
  const state = useGameStore((s) => s.state)
  const alerts = state.alerts.slice(0, 8)

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h2 className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted">World wire</h2>
        <span className="font-mono text-[0.625rem] text-muted">D{state.day}</span>
      </div>
      {state.activeEvents[0] && (
        <div className="rounded-xl border border-amber/30 bg-amber/5 px-2.5 py-2 text-[0.8125rem] text-amber">
          <div className="flex gap-2"><div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber/20 font-mono text-[0.625rem]">WI</div><div className="min-w-0"><div className="text-[0.6875rem] text-muted"><strong className="text-bone">World Intelligence</strong> @worldwire · D{state.day}</div><div className="mt-1 text-[0.75rem] leading-snug text-bone">{state.activeEvents[0].title}</div><div className="mt-1 text-[0.6875rem] text-amber">{state.activeEvents[0].duration}d remaining</div></div></div>
        </div>
      )}
      {alerts.map((a) => (
        <article
          key={a.id}
          className={`rounded-lg border px-2 py-1.5 text-[0.75rem] leading-snug ${
            a.severity === 'danger'
              ? 'border-danger/30 bg-danger/10 text-danger'
              : a.severity === 'warn'
                ? 'border-amber/30 bg-amber/10 text-amber'
                : 'border-line bg-panel-2 text-muted'
          }`}
        >
          <div className="flex gap-2"><div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-void font-mono text-[0.625rem]">OPS</div><div className="min-w-0"><div className="mb-1 text-[0.625rem] text-muted"><strong className="text-bone">Labline Ops</strong> @operations · D{a.day}</div>{a.message}<div className="mt-1.5 flex gap-4 font-mono text-[0.625rem] opacity-60"><span>↗ signal</span><span>◇ watch</span></div></div></div>
        </article>
      ))}
      {state.news.slice(0, 4).map((n, i) => (
        <article key={i} className="rounded-xl border border-line/50 px-2.5 py-2 text-[0.75rem] text-muted"><div className="flex gap-2"><div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-mint/10 font-mono text-[0.625rem] text-mint">NW</div><div><div className="mb-1 text-[0.625rem]"><strong className="text-bone">Frontier News</strong> @frontier · D{Math.max(0, state.day - i)}</div>{n}<div className="mt-1.5 flex gap-4 font-mono text-[0.625rem] opacity-60"><span>↗ share</span><span>◇ save</span></div></div></div></article>
      ))}
      {alerts.length === 0 && state.news.length === 0 && (
        <p className="text-[0.8125rem] text-muted">Quiet wire.</p>
      )}
    </div>
  )
}

function Row({
  label,
  value,
  danger,
  strong,
}: {
  label: string
  value: string
  danger?: boolean
  strong?: boolean
}) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className={`${strong ? 'font-medium' : ''} ${danger ? 'text-danger' : 'text-bone'}`}>
        {value}
      </span>
    </div>
  )
}

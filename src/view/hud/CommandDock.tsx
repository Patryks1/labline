import { useEffect, useState, type ReactNode } from 'react'
import {
  BellRinging,
  Buildings,
  CaretLeft,
  CaretRight,
  ChartLine,
  UsersThree,
} from '@phosphor-icons/react'
import { competitiveCatchUpSnapshot } from '../../sim/systems/sharedMarkets'
import { useGameStore } from '../../store/gameStore'
import { money, num, pct } from './format'
import { COMMAND_VIEWS, type CommandViewId } from './navConfig'
import { MeterBar, SegmentedTabs, StatRow } from './ui/kit'
import { EmptyState, HudButton, StatusChip } from './ui/HudPrimitives'
import { classifyFeedLine, FeedPost, type FeedTone } from './ui/FeedPost'
import type { SimState, WorldFeedCategory } from '../../sim/types'
import { useUiStore } from '../../store/uiStore'
import { selectFinanceDashboardReadouts } from './data/financeDashboardModel'
import { FacilitiesIntelView } from './panels/command/FacilitiesIntelView'
import { hudDesktopDefaultDisclosureOpen } from './ui/hudDesktopDisclosure'

/** Totals for a command-dock channel must come from the same rows the list shows. */
export function sumChannelRows(
  rows: ReadonlyArray<{
    revenue: number
    cogs: number
    mtok?: number
    users?: number
  }>,
): { revenue: number; cogs: number; mtok: number; users: number } {
  return rows.reduce<{ revenue: number; cogs: number; mtok: number; users: number }>(
    (acc, row) => ({
      revenue: acc.revenue + row.revenue,
      cogs: acc.cogs + row.cogs,
      mtok: acc.mtok + (row.mtok ?? 0),
      users: acc.users + (row.users ?? 0),
    }),
    { revenue: 0, cogs: 0, mtok: 0, users: 0 },
  )
}

/**
 * Floating right intelligence dock over the map.
 * Clickable, icon-led tabs switch P&L / Sites / Rivals / World without a second full panel.
 */
export function CommandDock({ forceCollapsed = false }: { forceCollapsed?: boolean }) {
  const open = useGameStore((s) => s.commandDockOpen)
  const view = useGameStore((s) => s.commandView)
  const setView = useGameStore((s) => s.setCommandView)
  const setOpen = useGameStore((s) => s.setCommandDockOpen)
  const setPanel = useGameStore((s) => s.setPanel)
  const expanded = open && !forceCollapsed

  return (
    <div
      id="command-dock-panel"
      className="intel-shell pointer-events-none"
      role="region"
      aria-label="Intel dock"
    >
      {!expanded ? (
        <aside className="command-dock command-dock--collapsed hud-surface pointer-events-auto relative m-2 ml-1 flex h-[calc(100%-1rem)] flex-col items-center gap-1 rounded-lg py-2">
          <button
            type="button"
            aria-label="Open intel dock"
            aria-expanded={false}
            aria-controls="command-dock-panel"
            title="Open intel dock"
            onClick={() => setOpen(true)}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted transition hover:bg-panel-2 hover:text-bone"
          >
            <CaretLeft size="1rem" />
          </button>
          {COMMAND_VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-label={v.label}
              aria-pressed={view === v.id}
              title={v.label}
              onClick={() => setView(v.id)}
              className={`flex min-h-11 min-w-11 items-center justify-center rounded-md transition ${
                view === v.id ? 'bg-mint/15 text-mint' : 'text-muted hover:bg-panel-2 hover:text-bone'
              }`}
            >
              <CommandIcon id={v.id} />
            </button>
          ))}
        </aside>
      ) : (
        <aside
          className="command-dock command-dock--expanded hud-surface pointer-events-auto relative m-2 ml-1 flex h-[calc(100%-1rem)] min-w-0 flex-col overflow-hidden rounded-lg"
          data-mobile-sheet="intel"
        >
          <div className="relative z-10 flex items-center gap-1.5 border-b border-line/60 px-2 py-2">
            <div className="min-w-0 flex-1">
              <SegmentedTabs
                ariaLabel="Command dock views"
                active={view}
                onChange={(id) => setView(id as CommandViewId)}
                items={COMMAND_VIEWS.map((v) => ({
                  id: v.id,
                  label: v.label,
                  ariaLabel: v.label,
                  title: v.label,
                  icon: <CommandIcon id={v.id} />,
                }))}
              />
            </div>
            <button
              type="button"
              aria-label="Collapse intel dock"
              aria-expanded={true}
              aria-controls="command-dock-panel"
              title="Collapse"
              onClick={() => setOpen(false)}
              className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-panel-2 hover:text-bone"
            >
              <CaretRight size="1rem" />
            </button>
          </div>

          <div
            className="panel-scroll relative z-10 min-h-0 flex-1 overflow-y-auto p-3"
            data-shell-scroll-container="true"
          >
            <div key={view} className="panel-swap">
              {view === 'pnl' && <PnlView onOpenStats={() => setPanel('stats')} />}
              {view === 'sites' && <FacilitiesIntelView />}
              {view === 'rivals' && (
                <RivalsView
                  onOpenMarket={() => setPanel('market')}
                  onInspect={(rivalId) => {
                    useUiStore.getState().setSelectedRivalId(rivalId)
                    setPanel('rivals')
                  }}
                />
              )}
              {view === 'feed' && <FeedView />}
            </div>
          </div>
        </aside>
      )}
    </div>
  )
}

function CommandIcon({ id }: { id: CommandViewId }) {
  const Icon =
    id === 'pnl' ? ChartLine : id === 'sites' ? Buildings : id === 'rivals' ? UsersThree : BellRinging
  return <Icon size="1.05rem" weight="duotone" aria-hidden />
}

function PnlView({ onOpenStats }: { onOpenStats: () => void }) {
  const state = useGameStore((s) => s.state)
  const { current, revenue, costs } = selectFinanceDashboardReadouts(state)
  const market = state.lastMarket
  const planStats = market.planStats
  const apiModels = market.modelFinance.filter(
    (model) => model.dayApiRevenue > 0 || model.dayApiCogs > 0 || model.dayApiMTok > 0,
  )
  const apiLedger = sumChannelRows(
    apiModels.map((model) => ({
      revenue: model.dayApiRevenue,
      cogs: model.dayApiCogs,
      mtok: model.dayApiMTok,
    })),
  )
  const subLedger = sumChannelRows(
    planStats.map((plan) => ({
      revenue: plan.dayRevenue,
      cogs: plan.dayCogs,
      mtok: plan.dayMTok,
      users: plan.subscribers,
    })),
  )
  const enterpriseApiRevenue = revenue.enterprise * 0.5
  const enterpriseSubRevenue = revenue.enterprise - enterpriseApiRevenue
  const dayNet = current.net

  return (
    <div className="space-y-3" data-mobile-density="summary-first">
      <div className="flex items-start justify-between gap-2" data-mobile-priority="primary">
        <div className="min-w-0">
          <p className="hud-eyebrow">Today</p>
          <div
            className={`mt-1 font-mono text-xl font-semibold tabular-nums ${
              dayNet < 0 ? 'text-danger' : 'text-mint'
            }`}
          >
            {money(dayNet)}
          </div>
        </div>
        <HudButton
          type="button"
          variant="ghost"
          onClick={onOpenStats}
          className="shrink-0"
          data-mobile-priority="tertiary"
        >
          Full intel
        </HudButton>
      </div>

      <div className="space-y-1" data-mobile-priority="primary">
        <StatRow label="Revenue" value={money(revenue.total)} tone="positive" />
        <StatRow label="Product COGS" value={money(-costs.productCogs)} tone="danger" />
        <StatRow label="Operations" value={money(-costs.operatingCashOut)} tone="danger" />
        <StatRow label="Net / day" value={money(dayNet)} tone={dayNet < 0 ? 'danger' : 'positive'} strong />
        <StatRow label="Cash" value={money(current.cash)} tone={current.cash < 2e6 ? 'danger' : 'neutral'} />
      </div>

      <div className="anim-stagger space-y-2" data-mobile-priority="secondary">
        <ChannelBreakdown
          label="API"
          revenue={apiLedger.revenue + enterpriseApiRevenue}
          cogs={apiLedger.cogs}
          usage={`${num(apiLedger.mtok, 2)} MTok`}
        >
          {apiModels.length > 0 ? (
            apiModels.map((model) => (
              <BreakdownItem
                key={model.modelId}
                label={model.name}
                value={money(model.dayApiRevenue - model.dayApiCogs)}
                sub={`${num(model.dayApiMTok, 2)} MTok · ${money(model.dayApiCogs)} compute`}
                danger={model.dayApiRevenue - model.dayApiCogs < 0}
              />
            ))
          ) : (
            <p className="px-1 py-0.5 text-[0.8125rem] text-muted">No API model traffic today.</p>
          )}
          {enterpriseApiRevenue > 0 ? (
            <BreakdownItem label="Enterprise API" value={money(enterpriseApiRevenue)} sub="Contract endpoints" />
          ) : null}
        </ChannelBreakdown>

        <ChannelBreakdown
          label="Subs"
          revenue={subLedger.revenue + enterpriseSubRevenue}
          cogs={subLedger.cogs}
          usage={`${num(subLedger.mtok, 2)} MTok · ${compactPeople(subLedger.users)} users`}
        >
          {planStats.length > 0 ? (
            planStats.map((plan) => (
              <BreakdownItem
                key={plan.planId}
                label={plan.name}
                value={money(plan.dayRevenue - plan.dayCogs)}
                sub={`${Math.round(plan.subscribers).toLocaleString()} subs · ${num(plan.dayMTok, 2)} MTok`}
                danger={plan.dayRevenue - plan.dayCogs < 0}
              />
            ))
          ) : (
            <p className="px-1 py-0.5 text-[0.8125rem] text-muted">No subscription traffic today.</p>
          )}
          {enterpriseSubRevenue > 0 ? (
            <BreakdownItem label="Enterprise seats" value={money(enterpriseSubRevenue)} sub="Contract seats" />
          ) : null}
        </ChannelBreakdown>
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
  const [expanded, setExpanded] = useState(hudDesktopDefaultDisclosureOpen)
  const net = revenue - cogs
  const panelId = `command-channel-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <div className="rounded-lg border border-line/70 bg-panel-2/70">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition hover:bg-void/30"
      >
        <CaretRight
          size="0.75rem"
          className={`shrink-0 text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="min-w-0 flex-1 text-[0.8125rem] font-medium text-bone">{label}</span>
        <span className={`shrink-0 font-mono text-[0.8125rem] tabular-nums ${net < 0 ? 'text-danger' : 'text-mint'}`}>
          {money(net)}
        </span>
      </button>
      <div
        id={panelId}
        role="region"
        aria-label={`${label} breakdown`}
        hidden={!expanded}
        className="space-y-1.5 border-t border-line/60 px-2.5 py-2"
      >
        {expanded ? (
          <>
            <div className="grid grid-cols-3 gap-1.5">
              <BreakdownMetric label="Revenue" value={money(revenue)} />
              <BreakdownMetric label="Compute" value={money(-cogs)} danger />
              <BreakdownMetric label="Net" value={money(net)} danger={net < 0} />
            </div>
            <div className="truncate text-[0.6875rem] text-muted" title={usage}>
              {usage}
            </div>
            <div className="space-y-1 border-t border-line/50 pt-1.5">{children}</div>
          </>
        ) : null}
      </div>
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
      <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className={`mt-0.5 truncate font-mono text-[0.8125rem] tabular-nums ${danger ? 'text-danger' : 'text-bone'}`} title={value}>
        {value}
      </div>
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
    <div className="rounded-md bg-void/35 px-1.5 py-1.5">
      <div className="flex items-center justify-between gap-2 text-[0.8125rem]">
        <span className="min-w-0 truncate text-bone">{label}</span>
        <span className={`shrink-0 font-mono tabular-nums ${danger ? 'text-danger' : 'text-mint'}`}>{value}</span>
      </div>
      <div className="mt-0.5 truncate text-[0.6875rem] text-muted" title={sub}>
        {sub}
      </div>
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
  onInspect: (rivalId: string) => void
}) {
  const state = useGameStore((s) => s.state)
  const share = selectFinanceDashboardReadouts(state).current.share
  const competitiveResponse = competitiveCatchUpSnapshot(state)
  const rows = [
    { id: 'player', name: 'You', share, flopsPf: null as number | null, short: 0, model: null as string | null, isPlayer: true },
    ...state.rivals.map((r) => ({
      id: r.id,
      name: r.name,
      share: r.marketShare,
      flopsPf: r.flopsPf,
      short: r.lastUnserved ?? 0,
      model: r.models[0] ? `${r.models[0].name} · cap ${r.models[0].capability.toFixed(0)}` : null,
      isPlayer: false,
    })),
  ].toSorted((a, b) => b.share - a.share)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="hud-eyebrow">Field</p>
          <div className="mt-0.5 text-sm font-semibold text-bone">You hold {pct(share, 0)}</div>
        </div>
        <HudButton type="button" variant="ghost" onClick={onOpenMarket}>
          Market
        </HudButton>
      </div>

      <div className="anim-stagger space-y-2">
        {rows.map((row) => {
          const overloaded = row.short > 0.12
          const challenger = competitiveResponse.active && competitiveResponse.rivalId === row.id
          return (
            <div
              key={row.id}
              className={`rounded-lg border px-3 py-2.5 ${
                row.isPlayer ? 'border-mint/35 bg-mint/5' : 'border-line/70 bg-panel-2/70'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className={`truncate text-[0.8125rem] font-semibold ${row.isPlayer ? 'text-mint' : 'text-bone'}`}>
                    {row.name}
                  </div>
                  <div className="mt-0.5 truncate text-[0.6875rem] text-muted">
                    {row.model ?? (row.isPlayer ? 'Your lab' : 'Quiet')}
                    {row.flopsPf != null ? ` · ${num(row.flopsPf, 0)} PF` : ''}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className={`font-mono text-base font-semibold tabular-nums ${row.isPlayer ? 'text-mint' : 'text-bone'}`}>
                    {pct(row.share, 0)}
                  </div>
                  {!row.isPlayer ? (
                    <StatusChip tone={overloaded ? 'danger' : 'positive'}>
                      {overloaded ? `${pct(row.short, 0)} short` : 'ok'}
                    </StatusChip>
                  ) : null}
                </div>
              </div>
              <div className="mt-2">
                <MeterBar value={row.share} tone={row.isPlayer ? 'positive' : overloaded ? 'danger' : 'serve'} />
              </div>
              {challenger ? (
                <div className="mt-2">
                  <StatusChip tone="positive">Funded challenger</StatusChip>
                </div>
              ) : null}
              {!row.isPlayer ? (
                <HudButton type="button" variant="secondary" className="mt-2 w-full" onClick={() => onInspect(row.id)}>
                  Inspect
                </HudButton>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function FeedView({ stateOverride }: { stateOverride?: SimState }) {
  const liveState = useGameStore((s) => s.state)
  const state = stateOverride ?? liveState
  const campaignEpoch = useUiStore((store) => store.campaignEpoch)
  const [selectedFilters, setSelectedFilters] = useState<Set<'all' | WorldFeedCategory>>(
    () => new Set(['all']),
  )
  useEffect(() => {
    setSelectedFilters(new Set(['all']))
  }, [campaignEpoch])
  const alerts = state.alerts.slice(0, 12)
  const news = state.news.slice(0, 12)
  const typedEvents = state.feedEvents ?? []
  const announcements = state.rivals
    .filter((rival) => rival.publicEstimate?.announcedProject)
    .slice(0, 3)
    .map((rival) => ({
      id: rival.id,
      name: rival.name,
      project: rival.publicEstimate!.announcedProject!,
    }))
  const profile = (kind: 'event' | 'ops' | 'wire' | 'rival', seed: number, name?: string) => {
    if (kind === 'event') return { source: 'World Desk', handle: 'worlddesk', mark: 'WD', verified: true }
    if (kind === 'ops') return { source: 'GridWatch', handle: 'gridwatch', mark: 'GW', verified: true }
    if (kind === 'rival') return { source: name ?? 'Lab Dispatch', handle: (name ?? 'labdispatch').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15), mark: (name ?? 'LD').split(/\s+/).map((part) => part[0]).join('').slice(0, 2), verified: true }
    const wires = [
      { source: 'Compute Ledger', handle: 'computeledger', mark: 'CL', verified: true },
      { source: 'Silicon Valley Post', handle: 'svpost', mark: 'SV', verified: true },
      { source: 'Model Citizen', handle: 'modelcitizen', mark: 'MC', verified: false },
    ]
    return wires[Math.abs(seed) % wires.length]!
  }
  const newsDayLabel = (line: string) => {
    const match = /^Day\s+(\d+):/i.exec(line)
    return match ? `D${match[1]}` : undefined
  }
  const categoryForLegacyLine = (line: string): WorldFeedCategory => {
    const kind = classifyFeedLine(line).kind
    if (kind === 'rival') return 'rivals'
    if (kind === 'you' || kind === 'bench' || kind === 'changelog') return 'models'
    if (kind === 'ops') return 'market'
    return 'world'
  }
  const visible = (category: WorldFeedCategory) =>
    selectedFilters.has('all') || selectedFilters.has(category)
  const toggleFilter = (filter: 'all' | WorldFeedCategory) => {
    setSelectedFilters((current) => {
      if (filter === 'all') return new Set(['all'])
      const next = new Set(current)
      next.delete('all')
      if (next.has(filter)) next.delete(filter)
      else next.add(filter)
      return next.size > 0 ? next : new Set(['all'])
    })
  }
  const toneForEvent = (tone?: string): FeedTone => {
    if (tone === 'positive' || tone === 'warning' || tone === 'danger' || tone === 'research') return tone
    return 'neutral'
  }
  type FeedCard = { id: string; category: WorldFeedCategory; day: number; order: number; content: ReactNode }
  const cards: FeedCard[] = []
  const seenCardKeys = new Set<string>()
  const normalized = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim()
  const pushCard = (card: FeedCard, key = card.id) => {
    if (seenCardKeys.has(key)) return
    seenCardKeys.add(key)
    cards.push(card)
  }
  const typedTransition = (line: string) => {
    const text = normalized(line)
    return typedEvents.some((event) => {
      const title = normalized(event.title)
      const body = normalized(event.body)
      return text.includes(title) || (body.length > 20 && text.includes(body))
    })
  }
  const activeTransition = (line: string) => {
    const text = normalized(line)
    return state.activeEvents.some((event) => text.includes(normalized(event.title)) || text.includes(normalized(event.body)))
  }
  let order = 0
  for (const [index, event] of state.activeEvents.entries()) {
    const hasTypedTwin = typedEvents.some(
      (candidate) =>
        candidate.category === 'world' &&
        candidate.day === event.day &&
        (candidate.title === event.title || candidate.body === event.body),
    )
    if (!hasTypedTwin) {
      pushCard({
        id: `active-${event.id}-${event.day}`,
        category: 'world',
        day: event.day,
        order: order++,
        content: (
          <FeedPost
            {...profile('event', index)}
            dayLabel={`D${event.day}`}
            timeLabel={`${event.duration}d left`}
            tone="warning"
            pinned
            body={
              <>
                <strong className="text-bone">{event.title}</strong>
                <span className="mt-1 block text-muted">{event.body}</span>
              </>
            }
          />
        ),
      }, `world-event-${event.id}-${event.day}`)
    }
  }
  for (const event of typedEvents) {
    pushCard({
      id: event.id,
      category: event.category,
      day: event.day,
      order: order++,
      content: (
        <FeedPost
          source={event.source ?? (event.category === 'models' ? 'Model Desk' : event.category === 'rivals' ? 'Company Watch' : event.category === 'market' ? 'Market Ledger' : 'World Desk')}
          handle={event.source ? event.source.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15) : undefined}
          mark={event.category === 'models' ? 'MR' : event.category === 'rivals' ? 'RC' : event.category === 'market' ? 'MP' : 'WD'}
          verified
          dayLabel={`D${event.day}`}
          tone={toneForEvent(event.tone)}
          body={
            <>
              <strong className="text-bone">{event.title}</strong>
              <span className="mt-1 block text-muted">{event.body}</span>
            </>
          }
        />
      ),
    }, `typed-${event.id}`)
  }
  for (const entry of announcements) {
      pushCard({
        id: `announcement-${entry.id}`,
        category: 'rivals',
        day: state.day,
        order: order++,
        content: (
          <FeedPost
            key={entry.id}
            {...profile('rival', entry.id.length, entry.name)}
            timeLabel="Announcement"
            tone="research"
            body={
              <>
                <strong className="text-bone">{entry.project}</strong>
                <span className="mt-1 block text-muted">Publicly disclosed project from rival intelligence.</span>
              </>
            }
          />
        ),
      }, `rival-announcement-${entry.id}`)
  }
  for (const [index, alert] of alerts.entries()) {
      const hasTypedTwin = typedTransition(alert.message)
      if (hasTypedTwin) continue
      pushCard({
        id: `alert-${alert.id}`,
        category: 'market',
        day: alert.day,
        order: order++,
        content: (
          <FeedPost
            {...profile('ops', index)}
            dayLabel={`D${alert.day}`}
            tone={alert.severity === 'danger' ? 'danger' : alert.severity === 'warn' ? 'warning' : 'neutral'}
            body={alert.message}
          />
        ),
      }, `alert-${normalized(alert.message)}`)
  }
  for (const [index, line] of news.entries()) {
    const category = categoryForLegacyLine(line)
    if (typedTransition(line) || activeTransition(line) || alerts.some((alert) => normalized(line).includes(normalized(alert.message)))) continue
    const label = newsDayLabel(line)
    pushCard({
      id: `news-${line}-${index}`,
      category,
      day: label ? Number(label.slice(1)) : state.day,
      order: order++,
      content: (
        <FeedPost
          {...profile('wire', index)}
          dayLabel={label}
          tone="neutral"
          body={line}
        />
      ),
    }, `news-${category}-${normalized(line)}`)
  }
  const allCards = cards.sort((a, b) => b.day - a.day || a.order - b.order || a.id.localeCompare(b.id))
  const counts: Record<WorldFeedCategory, number> = allCards.reduce(
    (result, card) => ({ ...result, [card.category]: result[card.category] + 1 }),
    { world: 0, models: 0, market: 0, rivals: 0 },
  )
  const filterItems: Array<{ id: 'all' | WorldFeedCategory; label: string; count: number }> = [
    { id: 'all', label: 'All', count: allCards.length },
    { id: 'world', label: 'World', count: counts.world },
    { id: 'models', label: 'Models / Research', count: counts.models },
    { id: 'market', label: 'Market / Pricing', count: counts.market },
    { id: 'rivals', label: 'Rivals / Company', count: counts.rivals },
  ]
  const sortedCards = allCards.filter((card) => visible(card.category))

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="hud-eyebrow">World feed</p>
          <div className="mt-0.5 text-sm font-semibold text-bone">Day {state.day}</div>
        </div>
        <StatusChip tone="serve">Live</StatusChip>
      </div>

      <div className="space-y-1.5" role="group" aria-label="World feed filters">
        <p className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">Filter feed</p>
        <div className="flex flex-wrap gap-1.5">
          {filterItems.map((filter) => {
            const checked = selectedFilters.has(filter.id)
            return (
              <button
                key={filter.id}
                type="button"
                role="checkbox"
                aria-checked={checked}
                onClick={() => toggleFilter(filter.id)}
                className={`min-h-9 rounded-md border px-2 py-1 text-left text-[0.6875rem] transition ${
                  checked
                    ? 'border-mint/50 bg-mint/10 text-mint'
                    : 'border-line/70 bg-panel-2/60 text-muted hover:border-line hover:text-bone'
                }`}
              >
                <span>{filter.label}</span>
                <span className="ml-1 font-mono tabular-nums opacity-75">{filter.count}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="anim-stagger space-y-2">
        {sortedCards.map((card) => (
          <div key={card.id}>{card.content}</div>
        ))}
      </div>

      {sortedCards.length === 0 ? (
        <EmptyState
          title={selectedFilters.has('all') ? 'Quiet wire' : 'No matching stories'}
          description={selectedFilters.has('all') ? 'Training, pricing, and world transitions will land here.' : 'Try All or another filter to widen the feed.'}
        />
      ) : null}
    </div>
  )
}

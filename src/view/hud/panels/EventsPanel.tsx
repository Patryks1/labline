import { useState } from 'react'
import { useGameStore } from '../../../store/gameStore'
import {
  EmptyState,
  HudButton,
  PanelScaffold,
  StatusChip,
} from '../ui/HudPrimitives'
import { GameCard, SegmentedTabs } from '../ui/kit'

function classifyNews(line: string): {
  kind: 'rival' | 'bench' | 'you' | 'world' | 'ops'
  label: string
  tone: 'neutral' | 'positive' | 'warning' | 'danger' | 'serve' | 'research'
} {
  const l = line.toLowerCase()
  if (
    l.includes('overtakes') ||
    l.includes('leaderboard') ||
    l.includes('tops the board') ||
    l.includes('edges') ||
    l.includes('reclaiming')
  ) {
    return { kind: 'bench', label: 'Evals', tone: 'warning' }
  }
  if (l.includes('ships') || l.includes('releases') || l.includes('dropped') || l.includes('publishes')) {
    return { kind: 'rival', label: 'Rival', tone: 'serve' }
  }
  if (l.includes('unlocked') || l.includes('released') || l.includes('benchmark day')) {
    return { kind: 'you', label: 'You', tone: 'positive' }
  }
  if (l.includes('complain') || l.includes('capacity') || l.includes('throttle') || l.includes('timeout')) {
    return { kind: 'ops', label: 'Ops', tone: 'danger' }
  }
  return { kind: 'world', label: 'World', tone: 'neutral' }
}

type FeedTab = 'alerts' | 'events' | 'wire'

export function EventsPanel() {
  const state = useGameStore((s) => s.state)
  const setPanel = useGameStore((s) => s.setPanel)
  const [tab, setTab] = useState<FeedTab>('alerts')

  return (
    <PanelScaffold
      eyebrow="Intelligence"
      title="World"
      description="Alerts, live events, and the wire."
      actions={
        <HudButton type="button" variant="ghost" onClick={() => setPanel('benchmarks')}>
          Open evals
        </HudButton>
      }
    >
      <div className="space-y-3">
        <SegmentedTabs
          ariaLabel="World feed sections"
          active={tab}
          onChange={(id) => setTab(id as FeedTab)}
          items={[
            { id: 'alerts', label: `Alerts (${state.alerts.length})` },
            { id: 'events', label: `Events (${state.activeEvents.length})` },
            { id: 'wire', label: `Wire (${state.news.length})` },
          ]}
        />

        <div key={tab} className="panel-swap">
          {tab === 'alerts' && <AlertsView />}
          {tab === 'events' && <EventsView />}
          {tab === 'wire' && <WireView />}
        </div>
      </div>
    </PanelScaffold>
  )
}

function AlertsView() {
  const alerts = useGameStore((s) => s.state.alerts)
  if (alerts.length === 0) {
    return <EmptyState title="No alerts" description="Operational warnings will land here." />
  }
  return (
    <div className="anim-stagger space-y-2">
      {alerts.slice(0, 12).map((alert) => (
        <GameCard
          key={alert.id}
          tone={alert.severity === 'danger' ? 'danger' : alert.severity === 'warn' ? 'train' : undefined}
          title={
            <span className="flex items-center gap-2">
              <span className="font-mono text-[0.6875rem] text-muted">D{alert.day}</span>
              <StatusChip
                tone={
                  alert.severity === 'danger' ? 'danger' : alert.severity === 'warn' ? 'warning' : 'neutral'
                }
              >
                {alert.severity}
              </StatusChip>
            </span>
          }
        >
          <p className="text-[0.8125rem] leading-snug text-bone">{alert.message}</p>
        </GameCard>
      ))}
    </div>
  )
}

function EventsView() {
  const events = useGameStore((s) => s.state.activeEvents)
  if (events.length === 0) {
    return <EmptyState title="Quiet markets" description="World events fire roughly every week." />
  }
  return (
    <div className="anim-stagger space-y-2">
      {events.map((e) => (
        <GameCard
          key={`${e.id}-${e.day}`}
          tone="train"
          eyebrow="Active event"
          title={e.title}
          actions={<StatusChip tone="warning">{e.duration}d left</StatusChip>}
        >
          <p className="text-[0.8125rem] leading-snug text-muted">{e.body}</p>
        </GameCard>
      ))}
    </div>
  )
}

function WireView() {
  const news = useGameStore((s) => s.state.news)
  if (news.length === 0) {
    return <EmptyState title="No headlines" description="Wire items appear as the campaign progresses." />
  }
  return (
    <div className="anim-stagger max-h-[55vh] space-y-2 overflow-y-auto">
      {news.slice(0, 40).map((n, i) => {
        const c = classifyNews(n)
        return (
          <GameCard
            key={i}
            title={
              <span className="flex items-center gap-2">
                <StatusChip tone={c.tone}>{c.label}</StatusChip>
              </span>
            }
          >
            <p className="text-[0.8125rem] leading-snug text-bone">{n}</p>
          </GameCard>
        )
      })}
    </div>
  )
}

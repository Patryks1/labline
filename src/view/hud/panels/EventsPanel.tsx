import { useGameStore } from '../../../store/gameStore'

function classifyNews(line: string): {
  kind: 'rival' | 'bench' | 'you' | 'world' | 'ops'
  label: string
} {
  const l = line.toLowerCase()
  if (
    l.includes('overtakes') ||
    l.includes('leaderboard') ||
    l.includes('tops the board') ||
    l.includes('edges') ||
    l.includes('reclaiming')
  ) {
    return { kind: 'bench', label: 'Evals' }
  }
  if (l.includes('ships') || l.includes('releases') || l.includes('dropped') || l.includes('publishes')) {
    return { kind: 'rival', label: 'Rival' }
  }
  if (l.includes('unlocked') || l.includes('released') || l.includes('benchmark day')) {
    return { kind: 'you', label: 'You' }
  }
  if (l.includes('complain') || l.includes('capacity') || l.includes('throttle') || l.includes('timeout')) {
    return { kind: 'ops', label: 'Ops' }
  }
  return { kind: 'world', label: 'World' }
}

const KIND_STYLE: Record<string, string> = {
  rival: 'border-infer/40 bg-infer/5 text-infer',
  bench: 'border-amber/40 bg-amber/5 text-amber',
  you: 'border-mint/40 bg-mint/5 text-mint',
  ops: 'border-danger/40 bg-danger/5 text-danger',
  world: 'border-line bg-panel-2 text-muted',
}

export function EventsPanel() {
  const state = useGameStore((s) => s.state)
  const setPanel = useGameStore((s) => s.setPanel)

  return (
    <div className="space-y-4">
      <div>
        <h2 className="hud-panel-title">World</h2>
        <p className="hud-panel-sub">Events & wire. Live feed also on dock F4.</p>
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-[0.8125rem] font-medium text-bone">Operational alerts</h3>
          <span className="font-mono text-[0.6875rem] text-muted">{state.alerts.length} logged</span>
        </div>
        <div className="space-y-1.5">
          {state.alerts.slice(0, 8).map((alert) => (
            <div
              key={alert.id}
              className={`rounded-lg border px-2.5 py-2 text-[0.75rem] leading-snug ${
                alert.severity === 'danger'
                  ? 'border-danger/35 bg-danger/8 text-danger'
                  : alert.severity === 'warn'
                    ? 'border-amber/35 bg-amber/8 text-amber'
                    : 'border-line/70 bg-panel-2/70 text-muted'
              }`}
            >
              <span className="mr-2 font-mono text-[0.625rem] opacity-75">D{alert.day}</span>
              {alert.message}
            </div>
          ))}
        </div>
      </section>

      <div>
        <h3 className="mb-2 text-[0.8125rem] font-medium uppercase tracking-wider text-muted">
          Active events
        </h3>
        {state.activeEvents.length === 0 && (
          <p className="rounded-xl border border-line bg-panel-2 px-3 py-4 text-xs text-muted">
            Quiet markets. World events fire roughly every week.
          </p>
        )}
        <div className="space-y-2">
          {state.activeEvents.map((e) => (
            <div
              key={`${e.id}-${e.day}`}
              className="rounded-2xl border border-amber/30 bg-amber/5 px-3 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-bone">{e.title}</span>
                <span className="font-mono text-[0.75rem] text-amber">{e.duration}d left</span>
              </div>
              <p className="mt-1 text-[0.8125rem] leading-snug text-muted">{e.body}</p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[0.8125rem] font-medium uppercase tracking-wider text-muted">Wire</h3>
          <button
            type="button"
            className="text-[0.75rem] text-mint hover:underline"
            onClick={() => setPanel('benchmarks')}
          >
            Open evals →
          </button>
        </div>
        <div className="max-h-[50vh] space-y-1.5 overflow-y-auto">
          {state.news.length === 0 && (
            <p className="text-xs text-muted">No headlines yet.</p>
          )}
          {state.news.slice(0, 40).map((n, i) => {
            const c = classifyNews(n)
            return (
              <div
                key={i}
                className={`rounded-xl border px-2.5 py-2 text-[0.8125rem] leading-snug ${KIND_STYLE[c.kind]}`}
              >
                <span className="mr-1.5 font-mono text-[0.6875rem] uppercase opacity-80">{c.label}</span>
                <span className="text-bone/90">{n}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

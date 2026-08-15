import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { useGameStore } from '../../store/gameStore'
import { dismissBenchmarkEvent } from '../../sim/systems/benchmarkEvent'
import { num } from './format'

export function BenchmarkOverlay() {
  const ev = useGameStore((s) => s.state.lastBenchmarkEvent)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ev || ev.dismissed || !ref.current) return
    gsap.fromTo(
      ref.current,
      { opacity: 0, y: 28, scale: 0.97 },
      { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: 'power3.out' },
    )
  }, [ev])

  if (!ev || ev.dismissed) return null

  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-void/75 p-4 backdrop-blur-sm">
      <div
        ref={ref}
        className="glass max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg p-6 shadow-2xl shadow-void/50"
      >
        <p className="font-mono text-[0.75rem] uppercase tracking-[0.12em] text-research">
          Benchmark day · day {ev.day}
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-bone">{ev.modelName}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">{ev.headline}</p>

        <div className="mt-4 flex gap-3 font-mono text-xs">
          <div className="flex-1 rounded-md border border-mint/30 bg-mint/10 px-3 py-2 text-center">
            <div className="text-muted">Wins</div>
            <div className="text-lg text-mint">{ev.wins}</div>
          </div>
          <div className="flex-1 rounded-md border border-line bg-panel-2 px-3 py-2 text-center">
            <div className="text-muted">Capability</div>
            <div className="text-lg text-bone">{num(ev.capability, 0)}</div>
          </div>
          <div className="flex-1 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-center">
            <div className="text-muted">Trails</div>
            <div className="text-lg text-danger">{ev.losses}</div>
          </div>
        </div>

        <div className="mt-5 space-y-2">
          {ev.rivalCompare.map((row) => (
            <div key={row.benchmarkId} className="rounded-md border border-line bg-panel-2 px-3 py-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-bone">{row.label}</span>
                <span className={row.win ? 'text-mint' : 'text-amber'}>
                  {row.win ? 'LEAD' : `vs ${row.rivalName}`}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-2 font-mono text-[0.75rem]">
                <span className="w-8 text-muted">You</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-void">
                  <div
                    className={`h-full ${row.win ? 'bg-mint' : 'bg-infer'}`}
                    style={{ width: `${Math.min(100, row.ours)}%` }}
                  />
                </div>
                <span className="w-8 text-right text-bone">{row.ours.toFixed(0)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 font-mono text-[0.75rem]">
                <span className="w-8 text-muted">Rival</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-void">
                  <div
                    className="h-full bg-line"
                    style={{ width: `${Math.min(100, row.bestRival)}%` }}
                  />
                </div>
                <span className="w-8 text-right text-muted">{row.bestRival.toFixed(0)}</span>
              </div>
            </div>
          ))}
        </div>

        <p className="mt-4 text-[0.8125rem] leading-relaxed text-muted">
          Demand weights intelligence, price, speed, and tooling. Win evals — or undercut and distill
          a faster student at ~80% IQ.
        </p>

        <button
          type="button"
          className="btn-primary mt-5 w-full py-2.5"
          onClick={() => {
            const st = useGameStore.getState().state
            useGameStore.setState({ state: dismissBenchmarkEvent(st) })
          }}
        >
          Continue ops
        </button>
      </div>
    </div>
  )
}

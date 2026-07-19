import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { useGameStore } from '../../store/gameStore'
import { money, pct } from './format'
import { continueEndless } from '../../sim/systems/progression'

export function VictoryOverlay() {
  const victory = useGameStore((s) => s.state.victory)
  const state = useGameStore((s) => s.state)
  const newGame = useGameStore((s) => s.newGame)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if ((victory.outcome === 'playing' && (!state.progression.decadeReport || state.progression.reportAcknowledged)) || !ref.current) return
    gsap.fromTo(
      ref.current,
      { opacity: 0, scale: 0.96 },
      { opacity: 1, scale: 1, duration: 0.5, ease: 'power3.out' },
    )
  }, [victory.outcome, state.progression.decadeReport, state.progression.reportAcknowledged])

  const report = state.progression.decadeReport
  const showReport = report != null && !state.progression.reportAcknowledged
  if (victory.outcome === 'playing' && !showReport) return null

  const won = victory.outcome === 'won'

  return (
    <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-void/80 p-6 backdrop-blur-md">
      <div ref={ref} className="glass max-w-lg rounded-3xl p-10 text-center">
        <p
          className={`font-mono text-[0.8125rem] uppercase tracking-[0.25em] ${won ? 'text-mint' : 'text-danger'}`}
        >
          {showReport ? '2036 decade report' : won ? 'Scenario complete' : 'Run over'}
        </p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-bone">
          {showReport ? `${report!.score.toFixed(0)} / 100` : won ? 'You scaled the lab' : 'Out of the race'}
        </h1>
        <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-muted">
          {showReport
            ? 'The first decade is complete. Titles remain on the record; the same deterministic market can continue into an endless speculative era.'
            : victory.reason}
        </p>
        {showReport ? (
          <div className="mt-8 grid grid-cols-4 gap-2 text-left">
            <Stat label="Research" value={report!.researchImpact.toFixed(0)} />
            <Stat label="Capability" value={report!.capability.toFixed(0)} />
            <Stat label="Affordability" value={report!.affordability.toFixed(0)} />
            <Stat label="Adoption" value={report!.adoption.toFixed(0)} />
            <Stat label="Reliability" value={report!.reliability.toFixed(0)} />
            <Stat label="Profit" value={report!.profit.toFixed(0)} />
            <Stat label="Trust" value={report!.trust.toFixed(0)} />
            <Stat label="Ownership" value={`${report!.founderOwnership.toFixed(0)}%`} />
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-3 gap-3 text-left">
            <Stat label="Day" value={String(state.day)} />
            <Stat label="Share" value={pct(state.player.finance.totalShare, 1)} />
            <Stat label="Valuation" value={money(state.player.finance.valuation)} />
          </div>
        )}
        {showReport ? (
          <button
            type="button"
            className="btn-primary mt-10 px-8 py-3"
            onClick={() => useGameStore.setState({ state: continueEndless(state) })}
          >
            Continue endlessly
          </button>
        ) : (
          <button type="button" className="btn-primary mt-10 px-8 py-3" onClick={() => void newGame()}>
            New run
          </button>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-line bg-panel-2 px-3 py-3">
      <div className="text-[0.75rem] uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 font-mono text-sm text-bone">{value}</div>
    </div>
  )
}

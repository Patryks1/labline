import { useEffect, useMemo, useRef } from 'react'
import gsap from 'gsap'
import { useGameStore } from '../../store/gameStore'
import { money, pct } from './format'
import { continueEndless } from '../../sim/systems/progression'
import { ConsoleDialog } from './ui/ConsoleDialog'
import { HudButton } from './ui/HudPrimitives'
import { buildFinanceDashboardModel } from './data/financeDashboardModel'

export function VictoryOverlay() {
  const victory = useGameStore((s) => s.state.victory)
  const state = useGameStore((s) => s.state)
  const financeModel = useMemo(() => buildFinanceDashboardModel(state), [state])
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
  const eyebrow = showReport ? '2036 decade report' : won ? 'Scenario complete' : 'Run over'
  const title = showReport
    ? `${report!.score.toFixed(0)} / 100`
    : won
      ? 'You scaled the lab'
      : 'Out of the race'
  const description = showReport
    ? 'The first decade is complete. Titles remain on the record; the same deterministic market can continue into an endless speculative era.'
    : victory.reason

  return (
    <ConsoleDialog
      open
      titleId="victory-dialog-title"
      eyebrow={<span className={won || showReport ? 'text-mint' : 'text-danger'}>{eyebrow}</span>}
      title={title}
      description={description}
      onClose={() => undefined}
      canClose={false}
      maxWidthClass="max-w-2xl"
      footer={(
        <div className="flex justify-end">
          {showReport ? (
            <HudButton
              type="button"
              variant="primary"
              className="w-full px-8 py-3 sm:w-auto"
              onClick={() => useGameStore.setState({ state: continueEndless(state) })}
            >
              Continue endlessly
            </HudButton>
          ) : (
            <HudButton type="button" variant="primary" className="w-full px-8 py-3 sm:w-auto" onClick={() => void newGame()}>
              New run
            </HudButton>
          )}
        </div>
      )}
    >
      <div ref={ref}>
        {showReport ? (
          <div className="grid grid-cols-2 gap-2 text-left sm:grid-cols-4">
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
          <div className="grid grid-cols-3 gap-2 text-left sm:gap-3">
            <Stat label="Day" value={String(state.day)} />
            <Stat label="Share" value={pct(financeModel.current.share, 1)} />
            <Stat label="Valuation" value={money(financeModel.current.valuation)} />
          </div>
        )}
      </div>
    </ConsoleDialog>
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

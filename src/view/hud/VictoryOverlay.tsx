import { useEffect, useMemo, useRef } from 'react'
import gsap from 'gsap'
import { useGameStore } from '../../store/gameStore'
import { money, pct } from './format'
import { continueEndless } from '../../sim/systems/progression'
import {
  acceptEquityOffer,
  requestEquityOffers,
} from '../../sim/systems/capital'
import { isBailoutEligible } from '../../sim/systems/loans'
import { sellModelIp } from '../../sim/systems/training'
import {
  isInsolvencyLoss,
  resumeInsolvency,
  sellableModelQuotes,
} from '../../sim/systems/victory'
import { ConsoleDialog } from './ui/ConsoleDialog'
import { HudButton } from './ui/HudPrimitives'
import { buildFinanceDashboardModel } from './data/financeDashboardModel'

export function VictoryOverlay() {
  const victory = useGameStore((s) => s.state.victory)
  const state = useGameStore((s) => s.state)
  const financeModel = useMemo(() => buildFinanceDashboardModel(state), [state])
  const newGame = useGameStore((s) => s.newGame)
  const continueGame = useGameStore((s) => s.continueGame)
  const takeLoan = useGameStore((s) => s.takeLoan)
  const setPanel = useGameStore((s) => s.setPanel)
  const saveSlots = useGameStore((s) => s.saveSlots)
  const refreshSaves = useGameStore((s) => s.refreshSaves)
  const ref = useRef<HTMLDivElement>(null)
  const insolvencyLoss = victory.outcome === 'lost' && isInsolvencyLoss(victory.reason)
  const hasSave = saveSlots.length > 0

  useEffect(() => {
    if (victory.outcome === 'lost' || victory.outcome === 'won') {
      void refreshSaves()
    }
  }, [refreshSaves, victory.outcome])

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
  const eyebrow = showReport ? '2036 decade report' : won ? 'Scenario complete' : insolvencyLoss ? 'Board review' : 'Run over'
  const title = showReport
    ? `${report!.score.toFixed(0)} / 100`
    : won
      ? 'You scaled the lab'
      : insolvencyLoss
        ? 'Bankruptcy review'
        : 'Out of the race'
  const description = showReport
    ? (
        <>
          <span className="sm:hidden">Your first decade is complete. Continue with the same market.</span>
          <span className="hidden sm:inline">The first decade is complete. Titles remain on the record; the same deterministic market can continue into an endless speculative era.</span>
        </>
      )
    : insolvencyLoss
      ? `${victory.reason} Take credit, sell equity, or sell models — or load a save. The run does not have to end here.`
      : victory.reason

  const resumePlay = (next = state) => {
    useGameStore.setState({ state: resumeInsolvency(next) })
    setPanel('stats')
  }

  const afterRecovery = (next: typeof state) => {
    if (next.player.cash >= 0) resumePlay(next)
    else useGameStore.setState({ state: next })
  }

  const bailoutOk = insolvencyLoss && isBailoutEligible(state)
  const equityOffers = insolvencyLoss ? requestEquityOffers(state).slice(0, 2) : []
  const modelSales = insolvencyLoss ? sellableModelQuotes(state).slice(0, 3) : []

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
      shellClassName={insolvencyLoss ? 'sm:h-[92dvh]' : undefined}
      footer={(
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
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
            <>
              {insolvencyLoss ? (
                <HudButton
                  type="button"
                  variant="primary"
                  className="w-full px-8 py-3 sm:w-auto"
                  onClick={() => resumePlay()}
                >
                  Keep operating
                </HudButton>
              ) : null}
              {hasSave ? (
                <HudButton
                  type="button"
                  variant="secondary"
                  className="w-full px-8 py-3 sm:w-auto"
                  onClick={() => void continueGame()}
                >
                  Load last save
                </HudButton>
              ) : null}
              <HudButton
                type="button"
                variant="ghost"
                className="w-full px-8 py-3 sm:w-auto"
                onClick={() => void newGame()}
              >
                Main menu
              </HudButton>
              <HudButton
                type="button"
                variant={insolvencyLoss || hasSave ? 'ghost' : 'primary'}
                className="w-full px-8 py-3 sm:w-auto"
                onClick={() => void newGame()}
              >
                New run
              </HudButton>
            </>
          )}
        </div>
      )}
    >
      <div ref={ref} className="space-y-3">
        {showReport ? (
          <div className="grid grid-cols-2 gap-2 text-left sm:grid-cols-4">
            <Stat label="Research" value={report!.researchImpact.toFixed(0)} secondary />
            <Stat label="Capability" value={report!.capability.toFixed(0)} />
            <Stat label="Affordability" value={report!.affordability.toFixed(0)} secondary />
            <Stat label="Adoption" value={report!.adoption.toFixed(0)} secondary />
            <Stat label="Reliability" value={report!.reliability.toFixed(0)} secondary />
            <Stat label="Profit" value={report!.profit.toFixed(0)} />
            <Stat label="Trust" value={report!.trust.toFixed(0)} />
            <Stat label="Ownership" value={`${report!.founderOwnership.toFixed(0)}%`} />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 text-left sm:gap-3">
            <Stat label="Day" value={String(state.day)} />
            <Stat label="Share" value={pct(financeModel.current.share, 1)} />
            <Stat label="Cash" value={money(financeModel.current.cash)} />
          </div>
        )}
        {insolvencyLoss ? (
          <div
            data-testid="victory-recovery"
            className="space-y-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[0.75rem] leading-snug text-danger"
          >
            <p>
              Raise cash before the next review. Emergency credit, equity, and
              model sales apply immediately.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {bailoutOk ? (
                <HudButton
                  type="button"
                  variant="danger"
                  className="min-h-11 rounded-lg px-2 py-1 text-[0.6875rem] lg:min-h-0"
                  onClick={() => {
                    takeLoan('bailout')
                    const next = useGameStore.getState().state
                    if (next.player.cash >= 0) resumePlay(next)
                  }}
                >
                  Take emergency credit
                </HudButton>
              ) : null}
            </div>
            {equityOffers.map((offer) => {
              const blocked =
                (state.player.capital?.investorConfidence ?? 0) <
                offer.confidenceRequired
              return (
                <HudButton
                  key={offer.id}
                  type="button"
                  variant="ghost"
                  disabled={blocked}
                  className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-line/70 px-2 py-1 text-left text-[0.6875rem] text-bone lg:min-h-0"
                  onClick={() => afterRecovery(acceptEquityOffer(state, offer))}
                >
                  <span className="truncate">{offer.investorName}</span>
                  <span className="shrink-0 font-mono text-mint">
                    Raise {money(offer.cashRaised)}
                  </span>
                </HudButton>
              )
            })}
            {modelSales.map(({ model, cash }) => (
              <HudButton
                key={model.id}
                type="button"
                variant="ghost"
                className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-line/70 px-2 py-1 text-left text-[0.6875rem] text-bone lg:min-h-0"
                onClick={() => afterRecovery(sellModelIp(state, model.id))}
              >
                <span className="truncate">Sell {model.name}</span>
                <span className="shrink-0 font-mono text-mint">{money(cash)}</span>
              </HudButton>
            ))}
            {modelSales.length === 0 ? (
              <p className="text-[0.6875rem] text-muted">
                No model IP to sell. Keep operating to train or load a save
                that still has a fleet.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </ConsoleDialog>
  )
}

function Stat({ label, value, secondary = false }: { label: string; value: string; secondary?: boolean }) {
  return (
    <div className={`rounded-xl border border-line bg-panel-2 px-2.5 py-2.5 sm:rounded-2xl sm:px-3 sm:py-3 ${secondary ? 'max-sm:hidden [@media(max-height:540px)]:hidden' : ''}`}>
      <div className="text-[0.6875rem] uppercase tracking-wider text-muted sm:text-[0.75rem]">{label}</div>
      <div className="mt-1 font-mono text-sm text-bone">{value}</div>
    </div>
  )
}

import { useMemo, useState } from 'react'
import { Handshake, PaperPlaneTilt } from '@phosphor-icons/react'
import {
  acceptComputeOffer,
  activeLeases,
  cancelComputeLease,
  openOffers,
  rejectComputeOffer,
  rivalHostingBalance,
} from '../../../sim/systems/computeMarket'
import { useGameStore } from '../../../store/gameStore'
import { useUiStore } from '../../../store/uiStore'
import { money, num } from '../format'
import {
  quoteComputeContract,
  signComputeContract,
  terminateComputeContract,
} from '../../../sim/systems/computeContracts'
import { computeLabSnapshot } from '../../../sim/systems/labEngine'
import { CapacitySalesCeilingCard } from '../ui/CapacitySalesCeilingCard'
import {
  NegotiationHeader,
  NegotiationMessage,
  NegotiationMetric,
  NegotiationMood,
  NegotiationSlider,
  type NegotiationStatus,
} from '../ui/NegotiationRoom'

type ProviderEvent = {
  title: string
  body: string
  priceMultiplier: number
  capacityMultiplier: number
  riskDelta: number
  satisfactionDelta: number
}

const PROVIDER_EVENTS: ProviderEvent[] = [
  {
    title: 'Clean capacity window',
    body: 'The provider has an unusually quiet reservation window. Standard terms apply.',
    priceMultiplier: 1,
    capacityMultiplier: 1,
    riskDelta: 0,
    satisfactionDelta: 3,
  },
  {
    title: 'Metering correction',
    body: 'Their forecast overstated another customer. They can include 10% more PF in this deal.',
    priceMultiplier: 1,
    capacityMultiplier: 1.1,
    riskDelta: 0,
    satisfactionDelta: 8,
  },
  {
    title: 'Service-credit window',
    body: 'A prior billing miss unlocks an 8% service credit on the negotiated rate.',
    priceMultiplier: 0.92,
    capacityMultiplier: 1,
    riskDelta: 0,
    satisfactionDelta: 6,
  },
  {
    title: 'Outage watch',
    body: 'Maintenance risk is elevated. The provider is flexible on price, but interruption risk rises.',
    priceMultiplier: 0.9,
    capacityMultiplier: 1,
    riskDelta: 0.05,
    satisfactionDelta: -10,
  },
]

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value))
}

function providerEvent(day: number, providerId: string): ProviderEvent {
  const hash = [...providerId].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  return PROVIDER_EVENTS[Math.abs(hash + Math.floor(day / 5)) % PROVIDER_EVENTS.length]
}

/**
 * Wholesale compute leases — advertise, accept rival offers, manage contracts.
 */
export function ComputeMarketPanel() {
  const state = useGameStore((s) => s.state)
  const setState = (next: typeof state) => useGameStore.setState({ state: next })
  const requestConfirm = useUiStore((s) => s.requestConfirm)

  const offers = openOffers(state).filter((offer) => offer.from === 'rival')
  const active = activeLeases(state)

  const [cloudProviderId, setCloudProviderId] = useState(
    state.worldMarkets.cloudProviders.find((provider) => provider.availablePf >= 1)?.id ??
      state.worldMarkets.cloudProviders[0]?.id ??
      '',
  )
  const [cloudPf, setCloudPf] = useState(24)
  const [cloudTerm, setCloudTerm] = useState(90)
  const [offerPercent, setOfferPercent] = useState(95)
  const [negotiationStatus, setNegotiationStatus] = useState<NegotiationStatus>('idle')
  const [negotiationMessage, setNegotiationMessage] = useState('')
  const resetNegotiation = () => {
    setNegotiationStatus('idle')
    setNegotiationMessage('')
  }
  const cloudQuote = useMemo(
    () =>
      quoteComputeContract(state, {
        providerId: cloudProviderId,
        buyerLabId: state.playerLabId,
        kind: 'on_demand',
        pf: cloudPf,
        termDays: cloudTerm,
      }),
    [state, cloudProviderId, cloudPf, cloudTerm],
  )
  const selectedProvider = state.worldMarkets.cloudProviders.find(
    (provider) => provider.id === cloudProviderId,
  )
  const dealEvent = providerEvent(state.day, cloudProviderId)
  const providerSatisfaction = clamp(
    0,
    100,
    42 +
      ((selectedProvider?.reliability ?? 0.9) - 0.88) * 100 +
      Math.min(12, cloudTerm / 30) +
      (offerPercent - 90) * 0.9 -
      (cloudPf / Math.max(1, selectedProvider?.availablePf ?? 1)) * 25 +
      dealEvent.satisfactionDelta,
  )
  const negotiatedQuote = useMemo(() => {
    const bonusPf = Math.max(
      1,
      Math.floor(cloudQuote.contract.pf * dealEvent.capacityMultiplier),
    )
    const pfAvailable = selectedProvider?.availablePf ?? 0
    const negotiatedPf = Math.min(bonusPf, Math.floor(pfAvailable))
    const pricePerPfDay =
      cloudQuote.contract.pricePerPfDay * (offerPercent / 100) * dealEvent.priceMultiplier
    const dailyCost = negotiatedPf * pricePerPfDay
    const terminationFee =
      cloudQuote.contract.kind === 'reserved'
        ? dailyCost * cloudQuote.contract.daysTotal * 0.2
        : cloudQuote.contract.kind === 'colocation'
          ? dailyCost * cloudQuote.contract.daysTotal * 0.25
          : 0
    return {
      ...cloudQuote,
      canSign: cloudQuote.canSign && negotiatedPf >= cloudQuote.contract.pf,
      reason:
        negotiatedPf < cloudQuote.contract.pf
          ? `${selectedProvider?.name ?? 'Provider'} no longer has enough capacity for this package.`
          : cloudQuote.reason,
      dailyCost,
      contract: {
        ...cloudQuote.contract,
        pf: negotiatedPf,
        pricePerPfDay,
        terminationFee,
        interruptionRisk: clamp(
          0,
          0.95,
          cloudQuote.contract.interruptionRisk + dealEvent.riskDelta,
        ),
      },
    }
  }, [cloudQuote, dealEvent, offerPercent, selectedProvider])
  const providerContracts = state.computeContracts.filter(
    (contract) => contract.buyerLabId === state.playerLabId && contract.status !== 'expired',
  )
  const capacitySnapshot = computeLabSnapshot(state, state.playerLabId)
  const providerBoughtPf = state.computeContracts
    .filter(
      (contract) =>
        contract.status === 'active' &&
        contract.buyerLabId === state.playerLabId &&
        !contract.sellerLabId &&
        (contract.availableDay == null || contract.availableDay <= state.day),
    )
    .reduce((sum, contract) => sum + contract.pf, 0)
  const rivalBoughtPf =
    state.computeContracts
      .filter(
        (contract) =>
          contract.status === 'active' &&
          contract.buyerLabId === state.playerLabId &&
          Boolean(contract.sellerLabId) &&
          (contract.availableDay == null || contract.availableDay <= state.day),
      )
      .reduce((sum, contract) => sum + contract.pf, 0) +
    active.filter((lease) => !lease.playerSells).reduce((sum, lease) => sum + lease.pf, 0)
  const capacityMix = [
    {
      id: 'owned',
      label: 'Self-hosted',
      value: capacitySnapshot.availableLocalPf,
      color: '#3dffc0',
      detail: `${capacitySnapshot.installedLocalPf.toFixed(1)} PF installed · ${capacitySnapshot.outboundCommittedPf.toFixed(1)} PF sold`,
    },
    {
      id: 'provider',
      label: 'Provider contracts',
      value: providerBoughtPf,
      color: '#61a7ff',
      detail: `${providerContracts.length} provider contract${providerContracts.length === 1 ? '' : 's'} · includes cloud and colocation`,
    },
    {
      id: 'rival',
      label: 'Rival capacity',
      value: rivalBoughtPf,
      color: '#c884ff',
      detail: `${active.filter((lease) => !lease.playerSells).length} live rival lease${active.filter((lease) => !lease.playerSells).length === 1 ? '' : 's'}`,
    },
  ]
  return (
    <div className="space-y-3">
      <div>
        <h2 className="hud-panel-title">Compute market</h2>
        <p className="hud-panel-sub">
          Cloud, reserved, spot, colocation, emergency, and rival capacity all draw from the same finite pools.
        </p>
      </div>

      <ComputeCapacityPie entries={capacityMix} />

      <CapacitySalesCeilingCard state={state} />

      <section className="overflow-hidden rounded-2xl border border-mint/25 bg-panel-2/90">
        <NegotiationHeader
          title="Provider desk"
          subtitle="Live capacity negotiation"
          status={negotiationStatus}
        />

        <div className="space-y-2 p-2.5">
          <label className="flex items-center gap-2 rounded-lg border border-line/70 bg-void/55 px-2 py-1.5">
            <span className="shrink-0 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
              Chat with
            </span>
            <select
              value={cloudProviderId}
              onChange={(event) => {
                setCloudProviderId(event.target.value)
                resetNegotiation()
              }}
              className="min-w-0 flex-1 bg-transparent text-right text-[0.75rem] font-medium text-bone outline-none"
              aria-label="Compute provider"
            >
              {state.worldMarkets.cloudProviders.map((provider) => (
                <option key={provider.id} value={provider.id} className="bg-void">
                  {provider.name} · {provider.availablePf.toFixed(0)} PF open
                </option>
              ))}
            </select>
          </label>

          <div className="space-y-2 rounded-xl border border-line/60 bg-void/35 p-2">
            <NegotiationMessage side="provider" name={selectedProvider?.name ?? 'Provider'}>
              <span className="font-medium text-bone">{dealEvent.title}</span>
              <span className="mt-0.5 block text-muted">{dealEvent.body}</span>
              <span className="mt-1.5 flex flex-wrap gap-1 font-mono text-[0.625rem] text-muted">
                <span className="rounded-full bg-void/70 px-1.5 py-0.5">
                  {selectedProvider?.availablePf.toFixed(0) ?? 0} PF open
                </span>
                <span className="rounded-full bg-void/70 px-1.5 py-0.5">
                  {((selectedProvider?.reliability ?? 0) * 100).toFixed(1)}% uptime
                </span>
              </span>
            </NegotiationMessage>

            <NegotiationMessage side="player" name="You">
              <span className="font-medium text-bone">Here’s my proposal.</span>
              <span className="mt-0.5 block text-muted">
                {cloudPf.toFixed(0)} PF for {cloudTerm} days at {offerPercent}% of list.
              </span>
            </NegotiationMessage>

            {negotiationMessage && (
              <NegotiationMessage
                side="provider"
                name={selectedProvider?.name ?? 'Provider'}
                status={negotiationStatus}
              >
                {negotiationMessage}
              </NegotiationMessage>
            )}
          </div>

          {negotiationStatus !== 'signed' && (
            <>
              <div className="rounded-xl border border-line/70 bg-void/45 p-2">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted">
                    Your offer
                  </span>
                  <span className="text-[0.6875rem] text-muted">Drag to negotiate</span>
                </div>
                <div className="space-y-1.5">
                  <NegotiationSlider
                    label="Compute"
                    value={cloudPf}
                    min={1}
                    max={Math.max(
                      1,
                      Math.min(1000, Math.floor(selectedProvider?.availablePf ?? 1)),
                    )}
                    suffix=" PF"
                    onChange={(value) => {
                      setCloudPf(value)
                      resetNegotiation()
                    }}
                  />
                  <NegotiationSlider
                    label="Term"
                    value={cloudTerm}
                    min={1}
                    max={720}
                    suffix=" days"
                    onChange={(value) => {
                      setCloudTerm(value)
                      resetNegotiation()
                    }}
                  />
                  <NegotiationSlider
                    label="Offer"
                    value={offerPercent}
                    min={70}
                    max={115}
                    suffix="% list"
                    onChange={(value) => {
                      setOfferPercent(value)
                      resetNegotiation()
                    }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-4 gap-1 font-mono text-[0.6875rem]">
                <NegotiationMetric label="Capacity" value={`${negotiatedQuote.contract.pf.toFixed(0)} PF`} />
                <NegotiationMetric label="Daily" value={money(negotiatedQuote.dailyCost)} />
                <NegotiationMetric label="Term" value={`${negotiatedQuote.contract.daysTotal}d`} />
                <NegotiationMetric
                  label="Risk"
                  value={`${(negotiatedQuote.contract.interruptionRisk * 100).toFixed(1)}%`}
                />
              </div>

              <NegotiationMood score={providerSatisfaction} />

              {!negotiatedQuote.canSign && (
                <p className="rounded-lg border border-amber/30 bg-amber/5 px-2 py-1.5 text-[0.75rem] text-amber">
                  {negotiatedQuote.reason}
                </p>
              )}
            </>
          )}

          {(negotiationStatus === 'idle' || negotiationStatus === 'countered') && (
            <button
              type="button"
              disabled={!negotiatedQuote.canSign}
              className="btn-primary flex w-full items-center justify-center gap-1.5 py-1.5 text-[0.8125rem] disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => {
                if (providerSatisfaction >= 58) {
                  const signed = signComputeContract(state, negotiatedQuote)
                  setState({
                    ...signed,
                    news: [
                      `Day ${state.day}: ${selectedProvider?.name ?? 'Provider'} accepts and activates a negotiated ${negotiatedQuote.contract.pf.toFixed(0)} PF package after ${dealEvent.title.toLowerCase()}.`,
                      ...signed.news,
                    ].slice(0, 48),
                  })
                  setNegotiationStatus('signed')
                  setNegotiationMessage(
                    `Deal accepted. ${negotiatedQuote.contract.pf.toFixed(0)} PF is live now; billing starts today.`,
                  )
                  return
                }
                if (providerSatisfaction < 30) {
                  setNegotiationStatus('declined')
                  setNegotiationMessage(
                    'We can’t approve that package. Reduce the capacity or improve the price.',
                  )
                  return
                }
                const counter = Math.min(
                  115,
                  offerPercent + Math.max(2, Math.ceil((58 - providerSatisfaction) / 2)),
                )
                setOfferPercent(counter)
                setNegotiationStatus('countered')
                setNegotiationMessage(
                  `We can do ${counter}% of list. Send that offer or adjust the package.`,
                )
              }}
            >
              <PaperPlaneTilt size={15} weight="fill" />
              {negotiationStatus === 'countered' ? 'Send counter-offer' : 'Send proposal'}
            </button>
          )}
          {negotiationStatus === 'signed' && (
            <div className="flex items-center justify-center gap-1.5 rounded-lg border border-mint/35 bg-mint/10 px-2 py-1.5 text-[0.8125rem] font-medium text-mint">
              <Handshake size={16} weight="duotone" />
              Contract active · compute online
            </div>
          )}
          {negotiationStatus === 'declined' && (
            <button
              type="button"
              className="btn-ghost flex w-full items-center justify-center gap-1.5 py-1.5 text-[0.8125rem]"
              onClick={resetNegotiation}
            >
              <Handshake size={15} />
              Edit proposal
            </button>
          )}
        </div>

        {providerContracts.length > 0 && (
          <div className="space-y-1 border-t border-line/70 bg-void/25 px-2.5 py-2">
            <div className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted">
              Active contracts
            </div>
            {providerContracts.map((contract) => (
              <div key={contract.id} className="flex items-center justify-between gap-2 rounded-lg border border-line/70 bg-void/45 px-2 py-1.5">
                <div className="min-w-0">
                  <div className="truncate text-[0.75rem] text-bone">
                    {contract.providerName} · {contract.pf.toFixed(0)} PF
                  </div>
                  <div className="font-mono text-[0.6875rem] text-muted">
                    {money(contract.pf * contract.pricePerPfDay)}/day · {contract.daysLeft}d left ·{' '}
                    {contract.availableDay != null && contract.availableDay > state.day
                      ? `provisions D${contract.availableDay}`
                      : contract.status}
                  </div>
                </div>
                <button
                  type="button"
                  className="shrink-0 text-[0.6875rem] text-danger hover:underline"
                  onClick={() => setState(terminateComputeContract(state, contract.id))}
                >
                  End
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Incoming offers */}
      <div>
        <h3 className="mb-1.5 text-[0.8125rem] font-semibold text-bone">
          Offers ({offers.length})
        </h3>
        {offers.length === 0 ? (
          <p className="text-[0.8125rem] text-muted">
            No open offers. Rivals send offers when they have spare compute and need cash.
          </p>
        ) : (
          <div className="space-y-1.5">
            {offers.map((o) => {
              const rival = state.rivals.find((r) => r.id === o.rivalId)
              return (
                <div
                  key={o.id}
                  className="rounded-xl border border-line bg-panel-2 px-2.5 py-2"
                >
                  <div className="text-[0.8125rem] font-medium text-bone">
                    {rival?.name ?? o.rivalId} · approached you
                  </div>
                  <div className="mt-0.5 font-mono text-[0.75rem] text-muted">
                    {o.playerSells ? 'You sell' : 'You buy'} {num(o.pf, 0)} PF · $
                    {o.pricePerPfDay.toFixed(0)}/PF-day · {o.daysTotal}d
                  </div>
                  {o.note && <p className="mt-0.5 text-[0.75rem] text-muted">{o.note}</p>}
                  <div className="mt-1.5 flex gap-1.5">
                    <button
                      type="button"
                      className="btn-primary py-1 text-[0.75rem]"
                      onClick={() => setState(acceptComputeOffer(state, o.id))}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="btn-ghost py-1 text-[0.75rem]"
                      onClick={() => setState(rejectComputeOffer(state, o.id))}
                    >
                      Decline
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Active contracts */}
      <div>
        <h3 className="mb-1.5 text-[0.8125rem] font-semibold text-bone">
          Active leases ({active.length})
        </h3>
        {active.length === 0 ? (
          <p className="text-[0.8125rem] text-muted">No live contracts.</p>
        ) : (
          <div className="space-y-1">
            {active.map((c) => {
              const rival = state.rivals.find((r) => r.id === c.rivalId)
              return (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-line bg-panel-2 px-2 py-1.5 font-mono text-[0.75rem]"
                >
                  <span className="text-bone">
                    {c.playerSells ? '→' : '←'} {rival?.name} · {num(c.pf, 0)} PF · $
                    {c.pricePerPfDay.toFixed(0)}/d · {c.daysLeft}d left
                  </span>
                  <button
                    type="button"
                    className="text-danger hover:underline"
                    onClick={() => {
                      const fee = money(c.pf * c.pricePerPfDay * 3)
                      requestConfirm({
                        title: 'Cancel this compute lease?',
                        body: `Ending the contract early incurs an estimated ${fee} break fee.`,
                        actionLabel: 'Cancel lease',
                        tone: 'danger',
                        onConfirm: () => setState(cancelComputeLease(state, c.id)),
                      })
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Rival load table */}
      <div>
        <h3 className="mb-1 text-[0.8125rem] font-semibold text-bone">Rival host load</h3>
        <div className="space-y-0.5 font-mono text-[0.6875rem] text-muted">
          {state.rivals.map((r) => {
            const b = rivalHostingBalance(state, r)
            return (
              <div key={r.id} className="flex justify-between border-b border-line/40 py-0.5">
                <span>{r.name}</span>
                <span>
                  need {num(b.needPf, 0)} / have {num(b.totalPf, 0)} · spare {num(b.sparePf, 0)}
                  {b.sellingLocked ? ' · LOCKED' : ''}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

type ComputeCapacityEntry = {
  id: string
  label: string
  value: number
  color: string
  detail: string
}

function piePoint(fraction: number): { x: number; y: number } {
  const angle = fraction * Math.PI * 2 - Math.PI / 2
  return { x: 50 + Math.cos(angle) * 43, y: 50 + Math.sin(angle) * 43 }
}

function piePath(start: number, end: number): string {
  if (end - start >= 0.9999) {
    return 'M 50 7 A 43 43 0 1 1 49.99 7 Z'
  }
  const first = piePoint(start)
  const last = piePoint(end)
  return `M 50 50 L ${first.x.toFixed(3)} ${first.y.toFixed(3)} A 43 43 0 ${end - start > 0.5 ? 1 : 0} 1 ${last.x.toFixed(3)} ${last.y.toFixed(3)} Z`
}

function ComputeCapacityPie({ entries }: { entries: ComputeCapacityEntry[] }) {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.value), 0)
  const fallback = entries.find((entry) => entry.value > 0) ?? entries[0]
  const [pinnedId, setPinnedId] = useState(fallback?.id ?? '')
  const active = entries.find((entry) => entry.id === pinnedId) ?? fallback
  let cursor = 0
  const slices = entries.flatMap((entry) => {
    const share = total > 0 ? Math.max(0, entry.value) / total : 0
    if (share <= 0) return []
    const start = cursor
    cursor += share
    return [{ entry, start, end: cursor }]
  })

  return (
    <section className="rounded-xl border border-line bg-panel-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[0.8125rem] font-semibold text-bone">Available compute mix</h3>
          <p className="mt-0.5 text-[0.6875rem] text-muted">Select a source to inspect owned and purchased PF available today.</p>
        </div>
        <span className="shrink-0 font-mono text-[0.75rem] text-bone">{num(total, 1)} PF</span>
      </div>
      <div className="mt-2 grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-3">
        <svg viewBox="0 0 100 100" className="h-[7.5rem] w-[7.5rem]" aria-label="Available compute by source">
          {total <= 0 ? (
            <circle cx="50" cy="50" r="43" fill="#26303a" />
          ) : (
            slices.map(({ entry, start, end }) => (
              <path
                key={entry.id}
                d={piePath(start, end)}
                fill={entry.color}
                stroke="#081016"
                strokeWidth={entry.id === pinnedId ? 2.5 : 1.2}
                className="cursor-pointer transition-opacity hover:opacity-85 focus:outline-none"
                tabIndex={0}
                role="button"
                aria-label={`${entry.label}: ${entry.value.toFixed(1)} PF`}
                onClick={() => setPinnedId(entry.id)}
              >
                <title>{entry.label}: {entry.value.toFixed(1)} PF</title>
              </path>
            ))
          )}
        </svg>
        <div className="min-w-0">
          {active && (
            <div className="rounded-lg border border-line/70 bg-void/45 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[0.75rem] font-medium text-bone">{active.label}</span>
                <span className="font-mono text-[0.75rem]" style={{ color: active.color }}>{num(active.value, 1)} PF · {total > 0 ? ((active.value / total) * 100).toFixed(0) : 0}%</span>
              </div>
              <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted">{active.detail}</p>
            </div>
          )}
          <div className="mt-1.5 space-y-1">
            {entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-0.5 text-[0.6875rem] text-muted hover:bg-void/60 hover:text-bone"
                onClick={() => setPinnedId(entry.id)}
              >
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />{entry.label}</span>
                <span className="font-mono text-bone">{num(entry.value, 1)} PF</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

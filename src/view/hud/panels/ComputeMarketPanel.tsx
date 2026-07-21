import { useMemo, useState } from 'react'
import { Handshake, PaperPlaneTilt } from '@phosphor-icons/react'
import {
  acceptComputeOffer,
  activeLeases,
  cancelComputeLease,
  openOffers,
  rejectComputeOffer,
} from '../../../sim/systems/computeMarket'
import { useGameStore } from '../../../store/gameStore'
import { useUiStore } from '../../../store/uiStore'
import { money, num, pct, pf } from '../format'
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
import { EmptyState, HudButton, MetricTile, PanelScaffold, StatusChip } from '../ui/HudPrimitives'
import { BlockerList, GameCard, SegmentedTabs, StatRow } from '../ui/kit'

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
  return PROVIDER_EVENTS[Math.abs(hash + Math.floor(day / 5)) % PROVIDER_EVENTS.length]!
}

type MarketTab = 'negotiate' | 'offers' | 'leases'

/**
 * Wholesale compute leases — advertise, accept rival offers, manage contracts.
 */
export function ComputeMarketPanel() {
  const state = useGameStore((s) => s.state)
  const setState = (next: typeof state) => useGameStore.setState({ state: next })
  const requestConfirm = useUiStore((s) => s.requestConfirm)
  const [tab, setTab] = useState<MarketTab>('negotiate')

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

  const rentedPf = providerBoughtPf + rivalBoughtPf
  const ownedPf = capacitySnapshot.availableLocalPf
  const dailyRent =
    providerContracts.reduce((sum, c) => sum + c.pf * c.pricePerPfDay, 0) +
    active.reduce((sum, l) => sum + (l.playerSells ? 0 : l.pf * l.pricePerPfDay), 0)
  const pricePerPfDay = rentedPf > 0 ? dailyRent / rentedPf : 0
  const util =
    capacitySnapshot.installedLocalPf > 0
      ? Math.min(1, (capacitySnapshot.installedLocalPf - capacitySnapshot.availableLocalPf) / capacitySnapshot.installedLocalPf)
      : 0

  const blockers = !negotiatedQuote.canSign && negotiatedQuote.reason
    ? [{ text: negotiatedQuote.reason, tone: 'warning' as const }]
    : []

  return (
    <PanelScaffold
      eyebrow="Compute"
      title="Compute market"
      description="Cloud, reserved, spot & rival PF."
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricTile label="Owned PF" value={pf(ownedPf)} tone="positive" />
          <MetricTile label="Rented PF" value={pf(rentedPf)} tone="serve" />
          <MetricTile
            label="$/PF-day"
            value={pricePerPfDay > 0 ? money(pricePerPfDay) : '—'}
            tone="train"
          />
          <MetricTile label="Local util" value={pct(util, 0)} />
        </div>

        <CapacitySalesCeilingCard state={state} />

        <SegmentedTabs
          ariaLabel="Compute market views"
          active={tab}
          onChange={(id) => setTab(id as MarketTab)}
          items={[
            { id: 'negotiate', label: 'Provider desk' },
            { id: 'offers', label: `Offers (${offers.length})` },
            { id: 'leases', label: `Leases (${active.length + providerContracts.length})` },
          ]}
        />

        <div key={tab} className="panel-swap">
          {tab === 'negotiate' ? (
            <section className="overflow-hidden rounded-lg border border-mint/25 bg-panel-2/90">
              <NegotiationHeader
                title="Provider desk"
                subtitle="Live capacity negotiation"
                status={negotiationStatus}
              />

              <div className="space-y-2 p-2.5">
                <label className="flex items-center gap-2 rounded-md border border-line/70 bg-void/55 px-2 py-1.5">
                  <span className="shrink-0 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                    Chat with
                  </span>
                  <select
                    value={cloudProviderId}
                    onChange={(event) => {
                      setCloudProviderId(event.target.value)
                      resetNegotiation()
                    }}
                    className="min-w-0 flex-1 bg-transparent text-right text-[0.8125rem] font-medium text-bone outline-none"
                    aria-label="Compute provider"
                  >
                    {state.worldMarkets.cloudProviders.map((provider) => (
                      <option key={provider.id} value={provider.id} className="bg-void">
                        {provider.name} · {provider.availablePf.toFixed(0)} PF open
                      </option>
                    ))}
                  </select>
                </label>

                <div className="space-y-2 rounded-lg border border-line/60 bg-void/35 p-2">
                  <NegotiationMessage side="provider" name={selectedProvider?.name ?? 'Provider'}>
                    <span className="font-medium text-bone">{dealEvent.title}</span>
                    <span className="mt-0.5 block text-muted">{dealEvent.body}</span>
                  </NegotiationMessage>

                  <NegotiationMessage side="player" name="You">
                    <span className="font-medium text-bone">Here&apos;s my proposal.</span>
                    <span className="mt-0.5 block text-muted">
                      {cloudPf.toFixed(0)} PF for {cloudTerm} days at {offerPercent}% of list.
                    </span>
                  </NegotiationMessage>

                  {negotiationMessage ? (
                    <NegotiationMessage
                      side="provider"
                      name={selectedProvider?.name ?? 'Provider'}
                      status={negotiationStatus}
                    >
                      {negotiationMessage}
                    </NegotiationMessage>
                  ) : null}
                </div>

                {negotiationStatus !== 'signed' ? (
                  <>
                    <div className="rounded-lg border border-line/70 bg-void/45 p-2">
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
                    <BlockerList items={blockers} />
                  </>
                ) : null}

                {(negotiationStatus === 'idle' || negotiationStatus === 'countered') && (
                  <HudButton
                    type="button"
                    variant="primary"
                    disabled={!negotiatedQuote.canSign}
                    title={!negotiatedQuote.canSign ? negotiatedQuote.reason : undefined}
                    className="flex w-full items-center justify-center gap-1.5"
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
                          'We can\'t approve that package. Reduce the capacity or improve the price.',
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
                  </HudButton>
                )}
                {negotiationStatus === 'signed' && (
                  <div className="flex items-center justify-center gap-1.5 rounded-md border border-mint/35 bg-mint/10 px-2 py-1.5 text-[0.8125rem] font-medium text-mint">
                    <Handshake size={16} weight="duotone" />
                    Contract active · compute online
                  </div>
                )}
                {negotiationStatus === 'declined' && (
                  <HudButton
                    type="button"
                    variant="ghost"
                    className="flex w-full items-center justify-center gap-1.5"
                    onClick={resetNegotiation}
                  >
                    <Handshake size={15} />
                    Edit proposal
                  </HudButton>
                )}
              </div>
            </section>
          ) : null}

          {tab === 'offers' ? (
            offers.length === 0 ? (
              <EmptyState
                title="No open offers"
                description="Rivals send offers when they have spare compute and need cash."
              />
            ) : (
              <div className="anim-stagger space-y-2">
                {offers.map((o) => {
                  const rival = state.rivals.find((r) => r.id === o.rivalId)
                  return (
                    <GameCard
                      key={o.id}
                      tone="infer"
                      eyebrow={rival?.name ?? o.rivalId}
                      title={`${o.playerSells ? 'You sell' : 'You buy'} ${num(o.pf, 0)} PF`}
                      actions={
                        <StatusChip tone="serve">
                          ${o.pricePerPfDay.toFixed(0)}/PF-day
                        </StatusChip>
                      }
                    >
                      <StatRow label="Term" value={`${o.daysTotal}d`} />
                      {o.note ? <p className="mt-1 text-[0.75rem] text-muted">{o.note}</p> : null}
                      <div className="mt-2 flex gap-1.5">
                        <HudButton
                          type="button"
                          variant="primary"
                          onClick={() => setState(acceptComputeOffer(state, o.id))}
                        >
                          Accept
                        </HudButton>
                        <HudButton
                          type="button"
                          variant="ghost"
                          onClick={() => setState(rejectComputeOffer(state, o.id))}
                        >
                          Decline
                        </HudButton>
                      </div>
                    </GameCard>
                  )
                })}
              </div>
            )
          ) : null}

          {tab === 'leases' ? (
            <div className="anim-stagger space-y-2">
              {providerContracts.map((contract) => (
                <GameCard
                  key={contract.id}
                  tone="mint"
                  eyebrow="Provider"
                  title={`${contract.providerName} · ${contract.pf.toFixed(0)} PF`}
                  actions={
                    <HudButton
                      type="button"
                      variant="danger"
                      onClick={() =>
                        requestConfirm({
                          title: 'End this contract?',
                          body: `Terminate ${contract.providerName} ${contract.pf.toFixed(0)} PF. Termination fee may apply.`,
                          actionLabel: 'End contract',
                          tone: 'danger',
                          onConfirm: () => setState(terminateComputeContract(state, contract.id)),
                        })
                      }
                    >
                      End
                    </HudButton>
                  }
                >
                  <StatRow
                    label="Daily"
                    value={money(contract.pf * contract.pricePerPfDay)}
                    tone="warning"
                  />
                  <StatRow label="Left" value={`${contract.daysLeft}d`} />
                  <StatRow
                    label="Status"
                    value={
                      contract.availableDay != null && contract.availableDay > state.day
                        ? `provisions D${contract.availableDay}`
                        : contract.status
                    }
                  />
                </GameCard>
              ))}
              {active.map((lease) => {
                const rival = state.rivals.find((r) => r.id === lease.rivalId)
                return (
                  <GameCard
                    key={lease.id}
                    tone="infer"
                    eyebrow={lease.playerSells ? 'You sell' : 'You buy'}
                    title={`${rival?.name ?? lease.rivalId} · ${num(lease.pf, 0)} PF`}
                    actions={
                      <HudButton
                        type="button"
                        variant="danger"
                        onClick={() => setState(cancelComputeLease(state, lease.id))}
                      >
                        Cancel
                      </HudButton>
                    }
                  >
                    <StatRow label="Rate" value={`${money(lease.pricePerPfDay)}/PF-day`} />
                    <StatRow label="Left" value={`${lease.daysLeft}d`} />
                  </GameCard>
                )
              })}
              {providerContracts.length === 0 && active.length === 0 ? (
                <EmptyState title="No live contracts" description="Signed provider and rival leases appear here." />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </PanelScaffold>
  )
}

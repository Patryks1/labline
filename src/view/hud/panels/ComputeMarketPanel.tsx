import { useMemo, useState } from 'react'
import {
  acceptComputeOffer,
  activeLeases,
  cancelComputeLease,
  minComputeLeasePricePerPfDay,
  openOffers,
  playerSparePf,
  rejectComputeOffer,
  rivalHostingBalance,
  signPlayerComputeSale,
} from '../../../sim/systems/computeMarket'
import { useGameStore } from '../../../store/gameStore'
import { useUiStore } from '../../../store/uiStore'
import { money, num } from '../format'
import {
  quoteComputeContract,
  signComputeContract,
  terminateComputeContract,
} from '../../../sim/systems/computeContracts'
import type { ComputeContractKind } from '../../../sim/types'
import { computeLabSnapshot } from '../../../sim/systems/labEngine'
import { CapacitySalesCeilingCard } from '../ui/CapacitySalesCeilingCard'

type NegotiationStatus = 'idle' | 'countered' | 'accepted'

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

const BUYER_EVENTS: ProviderEvent[] = [
  {
    title: 'Training deadline',
    body: 'The lab needs a short burst of capacity before a training checkpoint closes.',
    priceMultiplier: 1.12,
    capacityMultiplier: 1.25,
    riskDelta: 0,
    satisfactionDelta: 10,
  },
  {
    title: 'Capacity shortfall',
    body: 'A delayed hall leaves the buyer exposed. They will pay a premium for a dependable block.',
    priceMultiplier: 1.08,
    capacityMultiplier: 1.35,
    riskDelta: 0,
    satisfactionDelta: 8,
  },
  {
    title: 'Expansion window',
    body: 'Product demand is rising and procurement has room for one additional capacity partner.',
    priceMultiplier: 1.05,
    capacityMultiplier: 1.1,
    riskDelta: 0,
    satisfactionDelta: 5,
  },
  {
    title: 'Procurement review',
    body: 'Finance is challenging every infrastructure contract. A leaner ask will close faster.',
    priceMultiplier: 0.93,
    capacityMultiplier: 0.8,
    riskDelta: 0,
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

function buyerEvent(day: number, rivalId: string): ProviderEvent {
  const hash = [...rivalId].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  return BUYER_EVENTS[Math.abs(hash + Math.floor(day / 4)) % BUYER_EVENTS.length]
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
  const [cloudKind, setCloudKind] = useState<ComputeContractKind>('on_demand')
  const [cloudPf, setCloudPf] = useState(24)
  const [cloudTerm, setCloudTerm] = useState(90)
  const [offerPercent, setOfferPercent] = useState(95)
  const [negotiationStatus, setNegotiationStatus] = useState<NegotiationStatus>('idle')
  const [negotiationMessage, setNegotiationMessage] = useState('')
  const [saleRivalId, setSaleRivalId] = useState(state.rivals[0]?.id ?? '')
  const [salePf, setSalePf] = useState(24)
  const [saleTerm, setSaleTerm] = useState(90)
  const [askPercent, setAskPercent] = useState(110)
  const [saleNegotiationStatus, setSaleNegotiationStatus] =
    useState<NegotiationStatus>('idle')
  const [saleNegotiationMessage, setSaleNegotiationMessage] = useState('')
  const resetNegotiation = () => {
    setNegotiationStatus('idle')
    setNegotiationMessage('')
  }
  const cloudQuote = useMemo(
    () =>
      quoteComputeContract(state, {
        providerId: cloudProviderId,
        buyerLabId: state.playerLabId,
        kind: cloudKind,
        pf: cloudPf,
        termDays: cloudTerm,
      }),
    [state, cloudProviderId, cloudKind, cloudPf, cloudTerm],
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
  const selectedBuyer = state.rivals.find((rival) => rival.id === saleRivalId)
  const selectedBuyerBalance = selectedBuyer
    ? rivalHostingBalance(state, selectedBuyer)
    : null
  const sparePf = playerSparePf(state)
  const saleEvent = buyerEvent(state.day, saleRivalId)
  const saleFloor = minComputeLeasePricePerPfDay(state)
  const buyerNeedPf = selectedBuyerBalance
    ? Math.max(0, selectedBuyerBalance.needPf - selectedBuyerBalance.totalPf)
    : 0
  const baseBuyerAppetite = selectedBuyerBalance
    ? buyerNeedPf + Math.max(8, selectedBuyerBalance.totalPf * 0.12)
    : 0
  const buyerAppetitePf = Math.max(
    0,
    Math.min(
      sparePf,
      400,
      Math.floor(baseBuyerAppetite * saleEvent.capacityMultiplier),
    ),
  )
  const salePricePerPfDay = Math.max(
    saleFloor,
    saleFloor * (askPercent / 100) * saleEvent.priceMultiplier,
  )
  const saleDailyRevenue = salePf * salePricePerPfDay
  const existingSale = active.some(
    (lease) => lease.playerSells && lease.rivalId === saleRivalId,
  )
  const saleSatisfaction = clamp(
    0,
    100,
    58 +
      Math.min(14, buyerNeedPf / 8) +
      Math.min(10, saleTerm / 45) -
      Math.max(0, askPercent - 105) * 0.85 -
      (salePf / Math.max(1, buyerAppetitePf)) * 18 +
      saleEvent.satisfactionDelta,
  )
  const saleCanNegotiate =
    Boolean(selectedBuyer) &&
    sparePf >= 2 &&
    salePf >= 2 &&
    salePf <= buyerAppetitePf &&
    salePf <= sparePf &&
    !existingSale
  const saleReason = existingSale
    ? `${selectedBuyer?.name ?? 'This lab'} already has a live capacity contract.`
    : sparePf < 2
      ? 'No spare compute is available to sell.'
      : salePf > buyerAppetitePf
        ? `${selectedBuyer?.name ?? 'Buyer'} will currently take up to ${buyerAppetitePf.toFixed(0)} PF.`
        : salePf > sparePf
          ? `Only ${sparePf.toFixed(0)} PF is spare.`
          : ''
  const resetSaleNegotiation = () => {
    setSaleNegotiationStatus('idle')
    setSaleNegotiationMessage('')
  }

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

      <section className="space-y-2 rounded-xl border border-mint/25 bg-mint/5 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[0.8125rem] font-semibold text-bone">Provider deal room</h3>
            <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted">
              Build a package, make an offer, and protect the relationship. Remote PF includes power, memory, and hosting.
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-mint/25 bg-void/60 px-2 py-0.5 font-mono text-[0.6875rem] text-mint">
            {Math.round(providerSatisfaction)} satisfaction
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-void">
          <div
            className={`h-full transition-[width] ${providerSatisfaction >= 58 ? 'bg-mint' : providerSatisfaction >= 40 ? 'bg-amber' : 'bg-danger'}`}
            style={{ width: `${providerSatisfaction}%` }}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[0.6875rem] text-muted">
            Provider
            <select
              value={cloudProviderId}
              onChange={(event) => {
                setCloudProviderId(event.target.value)
                resetNegotiation()
              }}
              className="mt-0.5 w-full rounded border border-line bg-void px-1.5 py-1 text-[0.75rem] text-bone"
            >
              {state.worldMarkets.cloudProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} · {provider.availablePf.toFixed(0)} PF
                </option>
              ))}
            </select>
          </label>
          <label className="text-[0.6875rem] text-muted">
            Route
            <select
              value={cloudKind}
              onChange={(event) => {
                setCloudKind(event.target.value as ComputeContractKind)
                resetNegotiation()
              }}
              className="mt-0.5 w-full rounded border border-line bg-void px-1.5 py-1 text-[0.75rem] text-bone"
            >
              <option value="on_demand">On-demand</option>
              <option value="reserved">Reserved</option>
              <option value="spot">Spot</option>
              <option value="colocation">Colocation</option>
              <option value="emergency">Emergency</option>
            </select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Capacity PF"
            value={cloudPf}
            set={(value) => {
              setCloudPf(value)
              resetNegotiation()
            }}
            min={1}
            max={1000}
            step={1}
          />
          <Field
            label="Term days"
            value={cloudTerm}
            set={(value) => {
              setCloudTerm(value)
              resetNegotiation()
            }}
            min={1}
            max={720}
            step={1}
          />
        </div>
        <div className="rounded-lg border border-violet/25 bg-violet/5 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[0.75rem] font-medium text-bone">{dealEvent.title}</span>
            <span className="font-mono text-[0.6875rem] text-violet">D{state.day} market event</span>
          </div>
          <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted">{dealEvent.body}</p>
        </div>
        <label className="block rounded-lg border border-line/70 bg-void/45 px-2.5 py-2 text-[0.6875rem] text-muted">
          <span className="flex items-center justify-between gap-2">
            <span>Your offer</span>
            <span className="font-mono text-bone">{offerPercent}% of list</span>
          </span>
          <input
            type="range"
            min={70}
            max={115}
            step={1}
            value={offerPercent}
            onChange={(event) => {
              setOfferPercent(Number(event.target.value))
              resetNegotiation()
            }}
            className="mt-1 w-full accent-mint"
            aria-label="Provider offer percent of list price"
          />
        </label>
        <div className="grid grid-cols-3 gap-1 font-mono text-[0.6875rem]">
          <Quote label="Daily" value={money(negotiatedQuote.dailyCost)} />
          <Quote label="$/PF-day" value={money(negotiatedQuote.contract.pricePerPfDay)} />
          <Quote
            label="Interrupt"
            value={`${(negotiatedQuote.contract.interruptionRisk * 100).toFixed(1)}%`}
          />
        </div>
        {!negotiatedQuote.canSign && <p className="text-[0.75rem] text-amber">{negotiatedQuote.reason}</p>}
        {negotiationMessage && (
          <p className={`rounded-lg border px-2 py-1.5 text-[0.75rem] ${negotiationStatus === 'accepted' ? 'border-mint/30 bg-mint/5 text-mint' : 'border-amber/30 bg-amber/5 text-amber'}`}>
            {negotiationMessage}
          </p>
        )}
        {negotiationStatus !== 'accepted' ? (
          <button
            type="button"
            disabled={!negotiatedQuote.canSign}
            className="btn-primary w-full py-1.5 text-[0.8125rem] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => {
              if (providerSatisfaction >= 58) {
                setNegotiationStatus('accepted')
                setNegotiationMessage(`${selectedProvider?.name ?? 'Provider'} accepts. Lock the package before the window moves.`)
                return
              }
              const counter = Math.min(115, offerPercent + Math.max(2, Math.ceil((58 - providerSatisfaction) / 2)))
              setOfferPercent(counter)
              setNegotiationStatus('countered')
              setNegotiationMessage(`${selectedProvider?.name ?? 'Provider'} counters at ${counter}% of list. Longer terms or a stronger offer improve satisfaction.`)
            }}
          >
            Negotiate {negotiatedQuote.contract.pf.toFixed(0)} PF package
          </button>
        ) : (
          <button
            type="button"
            disabled={!negotiatedQuote.canSign}
            className="btn-primary w-full py-1.5 text-[0.8125rem] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => {
              const signed = signComputeContract(state, negotiatedQuote)
              setState({
                ...signed,
                news: [
                  `Day ${state.day}: ${selectedProvider?.name ?? 'Provider'} closes a negotiated ${negotiatedQuote.contract.pf.toFixed(0)} PF package after ${dealEvent.title.toLowerCase()}.`,
                  ...signed.news,
                ].slice(0, 48),
              })
              resetNegotiation()
            }}
          >
            Sign deal · {negotiatedQuote.contract.daysTotal} days
          </button>
        )}

        {providerContracts.length > 0 && (
          <div className="space-y-1 border-t border-mint/15 pt-2">
            {providerContracts.map((contract) => (
              <div key={contract.id} className="flex items-center justify-between gap-2 rounded-lg border border-line/70 bg-void/45 px-2 py-1.5">
                <div className="min-w-0">
                  <div className="truncate text-[0.75rem] text-bone">
                    {contract.providerName} · {contract.kind.replaceAll('_', ' ')}
                  </div>
                  <div className="font-mono text-[0.6875rem] text-muted">
                    {contract.pf.toFixed(0)} PF · {money(contract.pf * contract.pricePerPfDay)}/d · {contract.daysLeft}d ·{' '}
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

      <section className="space-y-2 rounded-xl border border-violet/30 bg-violet/5 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[0.8125rem] font-semibold text-bone">Capacity sales desk</h3>
            <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted">
              Package spare PF, negotiate with a rival, and earn daily contract revenue.
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-violet/30 bg-void/60 px-2 py-0.5 font-mono text-[0.6875rem] text-violet">
            {Math.round(saleSatisfaction)} satisfaction
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-void">
          <div
            className={`h-full transition-[width] ${saleSatisfaction >= 58 ? 'bg-violet' : saleSatisfaction >= 40 ? 'bg-amber' : 'bg-danger'}`}
            style={{ width: `${saleSatisfaction}%` }}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[0.6875rem] text-muted">
            Buyer
            <select
              value={saleRivalId}
              onChange={(event) => {
                setSaleRivalId(event.target.value)
                resetSaleNegotiation()
              }}
              className="mt-0.5 w-full rounded border border-line bg-void px-1.5 py-1 text-[0.75rem] text-bone"
            >
              {state.rivals.map((rival) => (
                <option key={rival.id} value={rival.id}>
                  {rival.name}
                </option>
              ))}
            </select>
          </label>
          <div className="rounded border border-line bg-void px-1.5 py-1">
            <span className="block text-[0.6875rem] text-muted">Available package</span>
            <span className="font-mono text-[0.75rem] text-bone">
              {num(sparePf, 0)} PF spare · {num(buyerAppetitePf, 0)} PF wanted
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Capacity PF"
            value={salePf}
            set={(value) => {
              setSalePf(value)
              resetSaleNegotiation()
            }}
            min={2}
            max={400}
            step={1}
          />
          <Field
            label="Term days"
            value={saleTerm}
            set={(value) => {
              setSaleTerm(value)
              resetSaleNegotiation()
            }}
            min={7}
            max={720}
            step={1}
          />
        </div>
        <div className="rounded-lg border border-violet/25 bg-void/45 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[0.75rem] font-medium text-bone">{saleEvent.title}</span>
            <span className="font-mono text-[0.6875rem] text-violet">D{state.day} buyer event</span>
          </div>
          <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted">{saleEvent.body}</p>
        </div>
        <label className="block rounded-lg border border-line/70 bg-void/45 px-2.5 py-2 text-[0.6875rem] text-muted">
          <span className="flex items-center justify-between gap-2">
            <span>Your ask</span>
            <span className="font-mono text-bone">{askPercent}% of market floor</span>
          </span>
          <input
            type="range"
            min={90}
            max={160}
            step={1}
            value={askPercent}
            onChange={(event) => {
              setAskPercent(Number(event.target.value))
              resetSaleNegotiation()
            }}
            className="mt-1 w-full accent-violet"
            aria-label="Compute sale ask percent of market floor"
          />
        </label>
        <div className="grid grid-cols-3 gap-1 font-mono text-[0.6875rem]">
          <Quote label="Daily revenue" value={money(saleDailyRevenue)} />
          <Quote label="$/PF-day" value={money(salePricePerPfDay)} />
          <Quote label="Contract" value={money(saleDailyRevenue * saleTerm)} />
        </div>
        {saleReason && <p className="text-[0.75rem] text-amber">{saleReason}</p>}
        {saleNegotiationMessage && (
          <p className={`rounded-lg border px-2 py-1.5 text-[0.75rem] ${saleNegotiationStatus === 'accepted' ? 'border-mint/30 bg-mint/5 text-mint' : 'border-amber/30 bg-amber/5 text-amber'}`}>
            {saleNegotiationMessage}
          </p>
        )}
        {saleNegotiationStatus !== 'accepted' ? (
          <button
            type="button"
            disabled={!saleCanNegotiate}
            className="btn-primary w-full py-1.5 text-[0.8125rem] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => {
              if (saleSatisfaction >= 58) {
                setSaleNegotiationStatus('accepted')
                setSaleNegotiationMessage(`${selectedBuyer?.name ?? 'Buyer'} accepts the package. Commit the spare PF to start daily settlement.`)
                return
              }
              const counter = Math.max(90, askPercent - Math.max(2, Math.ceil((58 - saleSatisfaction) / 2)))
              setAskPercent(counter)
              setSaleNegotiationStatus('countered')
              setSaleNegotiationMessage(`${selectedBuyer?.name ?? 'Buyer'} counters at ${counter}% of market floor. A smaller block or longer term improves satisfaction.`)
            }}
          >
            Negotiate sale · {salePf.toFixed(0)} PF
          </button>
        ) : (
          <button
            type="button"
            disabled={!saleCanNegotiate}
            className="btn-primary w-full py-1.5 text-[0.8125rem] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => {
              setState(
                signPlayerComputeSale(state, {
                  rivalId: saleRivalId,
                  pf: salePf,
                  pricePerPfDay: salePricePerPfDay,
                  termDays: saleTerm,
                  note: `${saleEvent.title}: negotiated at ${askPercent}% of market floor.`,
                }),
              )
              resetSaleNegotiation()
            }}
          >
            Sign sale · {saleTerm} days
          </button>
        )}
      </section>

      {/* Incoming offers */}
      <div>
        <h3 className="mb-1.5 text-[0.8125rem] font-semibold text-bone">
          Offers ({offers.length})
        </h3>
        {offers.length === 0 ? (
          <p className="text-[0.8125rem] text-muted">
            No open offers. Rivals approach when they have unused capacity or need your listing.
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

function Field({
  label,
  value,
  set,
  min,
  max,
  step,
}: {
  label: string
  value: number
  set: (n: number) => void
  min: number
  max: number
  step: number
}) {
  return (
    <label className="text-[0.6875rem] text-muted">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => set(Number(e.target.value) || min)}
        className="mt-0.5 w-full rounded border border-line bg-void px-1.5 py-1 font-mono text-[0.8125rem] text-bone"
      />
    </label>
  )
}

function Quote({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-line/60 bg-void/40 px-1.5 py-1">
      <span className="block text-muted">{label}</span>
      <span className="text-bone">{value}</span>
    </div>
  )
}

import { createRng, hashSeed, seededId } from '../rng'
import { cloudListPriceEscalation } from '../balance/cloudPricing'
import type {
  CloudProvider,
  ComputeContract,
  ComputeContractKind,
  LabId,
  SimState,
} from '../types'
import { computeLabSnapshot, updateLab } from './labEngine'
import { formatComputeMw } from './computeMarket'
import { appendFeedEvents, type FeedEventInput } from './feed'

const MIN_PF = 1
/** ~2 GW at mwPerPfProxy 0.001 — large enough for late-game hyperscaler leases. */
const MAX_PF = 2_000_000
const PROVIDER_DAILY_GROWTH_RATE = 0.004
const PROVIDER_EXPANSION_HORIZON_DAYS = 60
const PROVIDER_EXPANSION_EXPONENT = 2.4
const PROVIDER_CATCH_UP_RATE = 0.06
const RIVAL_CLOUD_RESERVE_FRAC = 0.12
const RIVAL_CLOUD_MAX_TAKE_FRAC = 0.25
/**
 * Wholesale provider rate multiplier (balance pass). Applied once where quotes
 * are generated, so on-demand daily rates, spot scarcity pricing, reserved and
 * colocation capacity, emergency premiums, rival resale, renewals, and the UI
 * forecast all move together for player and rival buyers. Signed contracts
 * keep the pricePerPfDay locked at signing.
 */
export const PROVIDER_RATE_MULTIPLIER = 2

export interface ComputeContractRequest {
  providerId: string
  buyerLabId: LabId
  kind: ComputeContractKind
  pf: number
  termDays: number
  sellerLabId?: LabId
  regionId?: string
}

export interface ComputeContractQuote {
  contract: ComputeContract
  canSign: boolean
  reason?: string
  dailyCost: number
  providerAvailablePf: number
}

export interface LabContractCapacity {
  inboundPf: number
  outboundPf: number
  netPf: number
}

function isComputeContractQuote(
  value: ComputeContractQuote | ComputeContract,
): value is ComputeContractQuote {
  return 'contract' in value
}

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value))
}

/** Campaign-day inventory target for one provider, from its launch baseline. */
export function cloudProviderTargetBaselinePf(launchBaselinePf: number, day: number): number {
  const progress = Math.max(0, day) / PROVIDER_EXPANSION_HORIZON_DAYS
  return Math.max(0, launchBaselinePf) * Math.pow(1 + progress, PROVIDER_EXPANSION_EXPONENT)
}

function providerReservesCapacity(kind: ComputeContractKind): boolean {
  return kind !== 'emergency' && kind !== 'rival_resale'
}

function providerFor(state: SimState, providerId: string): CloudProvider | undefined {
  return state.worldMarkets.cloudProviders.find((provider) => provider.id === providerId)
}

function labExists(state: SimState, labId: LabId | undefined): labId is LabId {
  return (
    labId != null &&
    (labId === state.playerLabId || state.rivals.some((rival) => rival.id === labId))
  )
}

function resaleSellerCapacityPf(state: SimState, sellerLabId: LabId | undefined): number {
  if (!labExists(state, sellerLabId)) return 0
  return computeLabSnapshot(state, sellerLabId).rawFlopsPf
}

function normalizedTerm(kind: ComputeContractKind, days: number): number {
  const requested = Math.max(1, Math.floor(days) || 1)
  switch (kind) {
    case 'reserved':
      return clamp(90, 720, requested)
    case 'colocation':
      return clamp(60, 720, requested)
    case 'on_demand':
      return clamp(1, 720, requested)
    case 'spot':
      return clamp(1, 90, requested)
    case 'emergency':
      return clamp(1, 30, requested)
    case 'rival_resale':
      return clamp(7, 180, requested)
  }
}

function quotedPrice(
  state: SimState,
  provider: CloudProvider,
  kind: ComputeContractKind,
  requestedPf: number,
): number {
  const baseline = Math.max(1, provider.baselinePf)
  const available = Math.max(0, provider.availablePf)
  const committed = Math.max(0, baseline - available)
  const demand = Math.max(1, committed + requestedPf)
  const supply = Math.max(1, available)
  const spotScarcity = clamp(0.65, 2.5, Math.pow(demand / supply, 1.6))
  const multiplier =
    kind === 'reserved'
      ? 0.78
      : kind === 'spot'
        ? spotScarcity
        : kind === 'colocation'
          ? 0.66
          : kind === 'emergency'
            ? 1 + state.industryDataPack.compute.emergencyPremium
            : kind === 'rival_resale'
              ? 1.08
              : 1
  const industry = state.worldMarkets.cloudProviders
  const industryBaseline = industry.reduce((sum, p) => sum + Math.max(0, p.baselinePf), 0)
  const industryCommitted = industry.reduce(
    (sum, p) => sum + Math.max(0, p.baselinePf - p.availablePf),
    0,
  )
  const demandPressure =
    industryBaseline > 1e-9 ? industryCommitted / industryBaseline : 0
  const escalation = cloudListPriceEscalation(state.day, demandPressure)
  return Math.max(
    1,
    provider.basePricePerPfDay * PROVIDER_RATE_MULTIPLIER * multiplier * escalation,
  )
}

function quotedInterruptionRisk(
  provider: CloudProvider,
  kind: ComputeContractKind,
): number {
  if (kind !== 'spot') return Math.max(0, 1 - provider.reliability)
  const utilization = 1 - provider.availablePf / Math.max(1, provider.baselinePf)
  return clamp(0.01, 0.75, provider.spotVolatility * (0.35 + Math.max(0, utilization) * 1.5))
}

function withAlert(
  state: SimState,
  severity: 'info' | 'warn' | 'danger',
  message: string,
): SimState {
  return {
    ...state,
    alerts: [
      {
        id: seededId('compute-contract-alert', state.seed, state.day, severity, message),
        day: state.day,
        severity,
        message,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

/** Quote provider capacity without reserving it or mutating the simulation. */
export function quoteComputeContract(
  state: SimState,
  request: ComputeContractRequest,
): ComputeContractQuote {
  const provider = providerFor(state, request.providerId)
  const pf = clamp(MIN_PF, MAX_PF, Math.floor(request.pf) || MIN_PF)
  const termDays = normalizedTerm(request.kind, request.termDays)
  const fallbackProvider: CloudProvider = {
    id: request.providerId,
    name: 'Unknown provider',
    regionId: request.regionId ?? 'global-cloud',
    baselinePf: 0,
    availablePf: 0,
    basePricePerPfDay: 0,
    reliability: 0,
    spotVolatility: 0,
  }
  const source = provider ?? fallbackProvider
  const pricePerPfDay = quotedPrice(state, source, request.kind, pf)
  const dailyCost = pf * pricePerPfDay
  const terminationFee =
    request.kind === 'reserved'
      ? dailyCost * termDays * 0.2
      : request.kind === 'colocation'
        ? dailyCost * termDays * 0.25
        : 0
  const capacityAvailable =
    request.kind === 'emergency' ||
    (request.kind === 'rival_resale'
      ? resaleSellerCapacityPf(state, request.sellerLabId) + 1e-9 >= pf
      : source.availablePf + 1e-9 >= pf)
  const providerKnown = provider != null
  const sellerKnown =
    request.kind !== 'rival_resale' ||
    (labExists(state, request.sellerLabId) && request.sellerLabId !== request.buyerLabId)
  const canSign = providerKnown && capacityAvailable && sellerKnown
  const reason = !providerKnown
    ? 'Provider is no longer available.'
    : !sellerKnown
      ? 'Rival resale needs an existing, distinct seller lab.'
      : !capacityAvailable
        ? request.kind === 'rival_resale'
          ? `The seller only has ${formatComputeMw(resaleSellerCapacityPf(state, request.sellerLabId))} of uncommitted compute.`
          : `${provider.name} only has ${formatComputeMw(provider.availablePf)} available.`
        : undefined
  const contract: ComputeContract = {
    id: seededId(
      'compute-contract',
      state.seed,
      state.day,
      request.providerId,
      request.buyerLabId,
      request.sellerLabId,
      request.kind,
      pf,
      termDays,
      state.computeContracts.length,
    ),
    providerId: source.id,
    providerName: source.name,
    buyerLabId: request.buyerLabId,
    sellerLabId: request.sellerLabId,
    kind: request.kind,
    regionId: request.regionId ?? source.regionId,
    pf,
    pricePerPfDay,
    daysLeft: termDays,
    daysTotal: termDays,
    interruptionRisk: quotedInterruptionRisk(source, request.kind),
    terminationFee,
    status: 'offered',
    acceleratorGeneration:
      request.kind === 'rival_resale' ? undefined : source.acceleratorGeneration,
    supportedTrainingFormats:
      request.kind === 'rival_resale'
        ? undefined
        : source.supportedTrainingFormats
          ? [...source.supportedTrainingFormats]
          : undefined,
    supportedServePrecisions:
      request.kind === 'rival_resale'
        ? undefined
        : source.supportedServePrecisions
          ? [...source.supportedServePrecisions]
          : undefined,
    availableDay:
      request.kind === 'colocation'
        ? state.day + 90 + (Math.abs(hashSeed(state.seed, state.day, request.providerId, pf, 'colo-lead')) % 91)
        : state.day,
  }
  return {
    contract,
    canSign,
    reason,
    dailyCost,
    providerAvailablePf: source.availablePf,
  }
}

/** Seller floor for negotiated provider offers, as % of the quoted list rate. */
export const PROVIDER_MIN_OFFER_PERCENT = 80

export interface ComputeProviderOfferInput {
  reliability: number
  pf: number
  availablePf: number
  termDays: number
  /** Player offer as % of the quoted list rate. */
  offerPercent: number
  /** Deterministic event flavor adjustment applied by the desk. */
  satisfactionDelta?: number
}

export interface ComputeProviderOfferEvaluation {
  outcome: 'agreed' | 'countered' | 'declined'
  satisfaction: number
  /** The seller never signs below this % of list. */
  floorOfferPercent: number
  belowFloor: boolean
  /** Counter terms the seller commits to when the offer is close. */
  counter?: { pf: number; termDays: number; offerPercent: number }
}

/**
 * Contract-action kernel seam for the provider desk: deterministic seller
 * evaluation for one offer. The shared lab action kernel (labActionKernel.ts)
 * has no contract actions, so negotiation lives here next to quoting while
 * acceptance stays with signComputeContract.
 */
export function evaluateComputeProviderOffer(
  input: ComputeProviderOfferInput,
): ComputeProviderOfferEvaluation {
  const satisfaction = clamp(
    0,
    100,
    42 +
      (Math.max(0, input.reliability) - 0.88) * 100 +
      Math.min(12, Math.max(1, input.termDays) / 30) +
      (input.offerPercent - 90) * 0.9 -
      (Math.max(1, input.pf) / Math.max(1, input.availablePf)) * 25 +
      (input.satisfactionDelta ?? 0),
  )
  const belowFloor = input.offerPercent < PROVIDER_MIN_OFFER_PERCENT
  if (belowFloor || satisfaction < 30) {
    return {
      outcome: 'declined',
      satisfaction,
      floorOfferPercent: PROVIDER_MIN_OFFER_PERCENT,
      belowFloor,
    }
  }
  if (satisfaction >= 58) {
    return {
      outcome: 'agreed',
      satisfaction,
      floorOfferPercent: PROVIDER_MIN_OFFER_PERCENT,
      belowFloor,
    }
  }
  return {
    outcome: 'countered',
    satisfaction,
    floorOfferPercent: PROVIDER_MIN_OFFER_PERCENT,
    belowFloor,
    counter: {
      pf: Math.max(1, Math.floor(input.pf * 0.9)),
      termDays: clamp(30, 720, Math.max(1, input.termDays) + 30),
      offerPercent: Math.min(
        115,
        input.offerPercent + Math.max(2, Math.ceil((58 - satisfaction) / 2)),
      ),
    },
  }
}

/**
 * Cash the buyer should hold before signing: the full term value, capped at
 * 30 days of billing — the same cover signPlayerComputeSale asks of rivals.
 */
export function computeContractCashReserve(
  contract: Pick<ComputeContract, 'pf' | 'pricePerPfDay' | 'daysTotal'>,
): number {
  const daily = Math.max(0, contract.pf) * Math.max(0, contract.pricePerPfDay)
  return Math.min(daily * Math.max(1, contract.daysTotal), daily * 30)
}

/** True while the buyer already holds a live (non-expired) contract with this provider. */
export function providerContractActiveForLab(
  state: SimState,
  providerId: string,
  labId: LabId,
): boolean {
  return state.computeContracts.some(
    (contract) =>
      contract.providerId === providerId &&
      contract.buyerLabId === labId &&
      contract.status !== 'expired' &&
      contract.daysLeft > 0,
  )
}

/** Activate a still-valid quote and reserve finite provider capacity exactly once. */
export function signComputeContract(
  state: SimState,
  quoteOrContract: ComputeContractQuote | ComputeContract,
): SimState {
  let quoted: ComputeContractQuote | undefined
  let contract: ComputeContract
  if (isComputeContractQuote(quoteOrContract)) {
    quoted = quoteOrContract
    contract = quoteOrContract.contract
  } else {
    contract = quoteOrContract
  }
  if (quoted && !quoted.canSign) {
    return withAlert(state, 'warn', quoted.reason ?? 'This compute quote cannot be signed.')
  }
  if (state.computeContracts.some((entry) => entry.id === contract.id)) {
    return withAlert(state, 'warn', 'That compute contract is already on the books.')
  }
  const provider = providerFor(state, contract.providerId)
  if (!provider) return withAlert(state, 'warn', 'Compute provider no longer exists.')
  if (contract.buyerLabId !== state.playerLabId && !state.rivals.some((r) => r.id === contract.buyerLabId)) {
    return withAlert(state, 'warn', 'Compute buyer no longer exists.')
  }
  if (contract.kind === 'rival_resale') {
    if (
      !labExists(state, contract.sellerLabId) ||
      contract.sellerLabId === contract.buyerLabId
    ) {
      return withAlert(
        state,
        'warn',
        'Rival resale needs an existing, distinct seller lab.',
      )
    }
    const availablePf = resaleSellerCapacityPf(state, contract.sellerLabId)
    if (availablePf + 1e-9 < contract.pf) {
      return withAlert(
        state,
        'warn',
        `The seller only has ${formatComputeMw(availablePf)} of uncommitted compute; request a fresh quote.`,
      )
    }
  }
  if (
    providerReservesCapacity(contract.kind) &&
    provider.availablePf + 1e-9 < contract.pf
  ) {
    return withAlert(
      state,
      'warn',
      `${provider.name} only has ${formatComputeMw(provider.availablePf)} left; request a fresh quote.`,
    )
  }
  const providers = state.worldMarkets.cloudProviders.map((entry) =>
    entry.id === provider.id && providerReservesCapacity(contract.kind)
      ? { ...entry, availablePf: Math.max(0, entry.availablePf - contract.pf) }
      : entry,
  )
  const active: ComputeContract = {
    ...contract,
    status: 'active',
    signedDay: state.day,
    daysLeft: contract.daysTotal,
    interruptionDaysLeft: undefined,
  }
  const signed = {
    ...state,
    computeContracts: [...state.computeContracts, active],
    worldMarkets: { ...state.worldMarkets, cloudProviders: providers },
    news: [
      active.availableDay != null && active.availableDay > state.day
        ? `Day ${state.day}: ${active.providerName} reserves ${formatComputeMw(active.pf)} of ${active.kind.replace('_', ' ')} capacity for delivery on day ${active.availableDay}.`
        : `Day ${state.day}: ${active.providerName} supplies ${formatComputeMw(active.pf)} to ${buyerLabel(state, active.buyerLabId)} on ${active.kind.replace('_', ' ')} terms.`,
      ...state.news,
    ].slice(0, 48),
  }
  return appendFeedEvents(signed, [
    {
      id: `feed-compute-contract-signed-${active.id}`,
      day: state.day,
      category: 'market',
      title: `${active.providerName} quote accepted`,
      body: `${formatComputeMw(active.pf)} ${active.kind.replace('_', ' ')} capacity at $${active.pricePerPfDay.toFixed(2)}/PF-day for ${active.daysTotal} days; ${buyerLabel(state, active.buyerLabId)} now has a live compute contract.`,
      source: 'Compute Desk',
      tone: 'positive',
      entityId: active.buyerLabId,
      kind: 'compute_contract_signed',
    },
  ])
}

function releaseProviderCapacity(
  providers: CloudProvider[],
  contract: ComputeContract,
): CloudProvider[] {
  if (!providerReservesCapacity(contract.kind)) return providers
  return providers.map((provider) =>
    provider.id === contract.providerId
      ? {
          ...provider,
          availablePf: Math.min(provider.baselinePf, provider.availablePf + contract.pf),
        }
      : provider,
  )
}

function buyerLabel(state: SimState, labId: LabId): string {
  if (labId === state.playerLabId) return state.player.name
  return state.rivals.find((rival) => rival.id === labId)?.name ?? labId
}

/** Expand free inventory without changing the capacity already leased to customers. */
function growProviderCapacity(provider: CloudProvider, day: number): CloudProvider {
  const launchBaselinePf = provider.launchBaselinePf ?? provider.baselinePf
  const maxBaselinePf = Math.max(
    provider.baselinePf,
    cloudProviderTargetBaselinePf(launchBaselinePf, day),
  )
  const gap = Math.max(0, maxBaselinePf - provider.baselinePf)
  const growthPf = Math.min(
    gap,
    Math.max(provider.baselinePf * PROVIDER_DAILY_GROWTH_RATE, gap * PROVIDER_CATCH_UP_RATE),
  )
  if (growthPf <= 0) {
    return provider.launchBaselinePf !== launchBaselinePf || provider.maxBaselinePf !== maxBaselinePf
      ? { ...provider, launchBaselinePf, maxBaselinePf }
      : provider
  }
  const baselinePf = provider.baselinePf + growthPf
  return {
    ...provider,
    launchBaselinePf,
    baselinePf,
    maxBaselinePf,
    availablePf: Math.min(baselinePf, provider.availablePf + growthPf),
  }
}

function rivalCloudShare(archetype: string): number {
  if (archetype === 'hyperscale') return 0.2
  if (archetype === 'efficiency') return 0.12
  return 0.09
}

function rivalCloudBuyInterval(state: SimState, rivalId: LabId, urgent: boolean): number {
  if (urgent) return 3
  return 5 + (hashSeed(state.seed, rivalId, 'cloud-buy-cadence') % 7)
}

function rivalDesiredCloudPf(state: SimState, rivalId: LabId): number {
  const rival = state.rivals.find((entry) => entry.id === rivalId)
  if (!rival) return 0
  const industryBaseline = state.worldMarkets.cloudProviders.reduce(
    (sum, provider) => sum + Math.max(0, provider.baselinePf),
    0,
  )
  const pressure =
    0.4 +
    Math.min(0.6, (rival.lastUnserved ?? 0) * 2) +
    (rival.trainingJob ? 0.25 : 0) +
    Math.min(0.35, state.day / 400)
  return Math.max(24, industryBaseline * rivalCloudShare(rival.archetype) * pressure)
}

function maybeSignRivalCloudContract(state: SimState, rivalId: LabId): SimState {
  const rival = state.rivals.find((entry) => entry.id === rivalId)
  if (!rival || state.day < 3) return state
  const inboundPf = labContractCapacityPf(state, rivalId).inboundPf
  const desiredPf = rivalDesiredCloudPf(state, rivalId)
  const shortfall = desiredPf - inboundPf
  if (shortfall < 8) return state
  const urgent =
    (rival.lastUnserved ?? 0) > 0.12 ||
    (Boolean(rival.trainingJob) && inboundPf < desiredPf * 0.5)
  const interval = rivalCloudBuyInterval(state, rivalId, urgent)
  if ((state.day + (hashSeed(state.seed, rivalId, 'cloud-buy-phase') % interval)) % interval !== 0) {
    return state
  }
  const recentlySigned = state.computeContracts.some(
    (contract) =>
      contract.buyerLabId === rivalId &&
      !contract.sellerLabId &&
      contract.status !== 'expired' &&
      contract.signedDay != null &&
      state.day - contract.signedDay < interval,
  )
  if (recentlySigned) return state

  const providers = [...state.worldMarkets.cloudProviders].sort(
    (a, b) => a.basePricePerPfDay - b.basePricePerPfDay || a.id.localeCompare(b.id),
  )
  const provider = providers.find((entry) => {
    const reserve = Math.max(24, Math.floor(entry.baselinePf * RIVAL_CLOUD_RESERVE_FRAC))
    return entry.availablePf - reserve >= 8
  })
  if (!provider) return state
  const reserve = Math.max(24, Math.floor(provider.baselinePf * RIVAL_CLOUD_RESERVE_FRAC))
  const takeCap = Math.floor(provider.availablePf * RIVAL_CLOUD_MAX_TAKE_FRAC)
  const pf = Math.max(
    8,
    Math.min(Math.ceil(shortfall), takeCap, Math.floor(provider.availablePf - reserve)),
  )
  if (pf < 8) return state
  const quote = quoteComputeContract(state, {
    providerId: provider.id,
    buyerLabId: rivalId,
    kind: 'on_demand',
    pf,
    termDays: urgent ? 90 : 180,
  })
  if (!quote.canSign) return state
  if (rival.cash < computeContractCashReserve(quote.contract) * 1.25) return state
  return signComputeContract(state, quote)
}

/**
 * Rivals rent finite provider inventory on a staggered cadence so the player
 * still sees open MW, but the cloud desk is a shared market.
 */
export function tickRivalCloudPurchases(state: SimState): SimState {
  const ordered = [...state.rivals].sort((a, b) => {
    const rank =
      hashSeed(state.seed, state.day, a.id, 'cloud-buy-order') -
      hashSeed(state.seed, state.day, b.id, 'cloud-buy-order')
    return rank !== 0 ? rank : a.id.localeCompare(b.id)
  })
  let next = state
  for (const rival of ordered) {
    next = maybeSignRivalCloudContract(next, rival.id)
  }
  return next
}

function chargeLabCash(state: SimState, labId: LabId, amount: number): SimState {
  if (amount <= 0) return state
  return updateLab(state, labId, (lab) => ({
    ...lab,
    cash: lab.cash - amount,
    finance: { ...lab.finance, cash: lab.cash - amount },
  }))
}

function creditLabCash(state: SimState, labId: LabId, amount: number): SimState {
  if (amount <= 0) return state
  return updateLab(state, labId, (lab) => ({
    ...lab,
    cash: lab.cash + amount,
    finance: { ...lab.finance, cash: lab.cash + amount },
  }))
}

function accrueRivalContractCash(
  state: SimState,
  labId: LabId,
  amount: number,
  kind: 'income' | 'cost',
): SimState {
  if (amount <= 0 || labId === state.playerLabId) return state
  const withCash =
    kind === 'income'
      ? creditLabCash(state, labId, amount)
      : chargeLabCash(state, labId, amount)
  return {
    ...withCash,
    rivals: withCash.rivals.map((rival) =>
      rival.id === labId
        ? {
            ...rival,
            computeLeaseIncomeToday:
              (rival.computeLeaseIncomeToday ?? 0) + (kind === 'income' ? amount : 0),
            computeLeaseCostToday:
              (rival.computeLeaseCostToday ?? 0) + (kind === 'cost' ? amount : 0),
          }
        : rival,
    ),
  }
}

/** End an offered/active contract. Capacity is returned once and active break fees are cash-only. */
export function terminateComputeContract(state: SimState, contractId: string): SimState {
  const contract = state.computeContracts.find((entry) => entry.id === contractId)
  if (!contract || contract.status === 'expired') return state
  const active = contract.status === 'active' || contract.status === 'interrupted'
  const fee = active ? Math.max(0, contract.terminationFee) : 0
  let next = state
  if (fee > 0) next = chargeLabCash(next, contract.buyerLabId, fee)
  const providers = active
    ? releaseProviderCapacity(next.worldMarkets.cloudProviders, contract)
    : next.worldMarkets.cloudProviders
  const ended = {
    ...next,
    computeContracts: next.computeContracts.map((entry) =>
      entry.id === contractId
        ? { ...entry, status: 'expired' as const, daysLeft: 0, interruptionDaysLeft: undefined }
        : entry,
    ),
    worldMarkets: { ...next.worldMarkets, cloudProviders: providers },
    news: [
      `Day ${state.day}: ${contract.providerName} contract ended${fee > 0 ? ` with a $${fee.toFixed(0)} break fee` : ''}.`,
      ...next.news,
    ].slice(0, 48),
  }
  return appendFeedEvents(ended, [
    {
      id: `feed-compute-contract-ended-${contract.id}-${state.day}`,
      day: state.day,
      category: 'market',
      title: `${contract.providerName} contract ended`,
      body: `${formatComputeMw(contract.pf)} of ${contract.kind.replace('_', ' ')} capacity returned${fee > 0 ? ` after a $${fee.toFixed(0)} break fee` : ''}.`,
      source: 'Compute Desk',
      tone: fee > 0 ? 'warning' : 'neutral',
      entityId: contract.buyerLabId,
      kind: 'compute_contract_ended',
    },
  ])
}

/** Capacity visible to a lab today. Interrupted and expired contracts contribute zero capacity. */
export function labContractCapacityPf(state: SimState, labId: LabId): LabContractCapacity {
  let inboundPf = 0
  let outboundPf = 0
  for (const contract of state.computeContracts) {
    if (contract.status !== 'active') continue
    if (contract.availableDay != null && state.day < contract.availableDay) continue
    if (contract.buyerLabId === labId) inboundPf += contract.pf
    if (contract.sellerLabId === labId) outboundPf += contract.pf
  }
  return { inboundPf, outboundPf, netPf: inboundPf - outboundPf }
}

function settleInvoice(
  state: SimState,
  contract: ComputeContract,
  invoice: number,
): SimState {
  let next = state
  if (contract.buyerLabId === state.playerLabId) {
    const credits = Math.max(0, state.player.cloudCredits ?? 0)
    const creditsUsed = Math.min(credits, invoice)
    const cashCost = Math.max(0, invoice - creditsUsed)
    next = {
      ...next,
      player: {
        ...next.player,
        cloudCredits: credits - creditsUsed,
        computeLeaseCostToday: (next.player.computeLeaseCostToday ?? 0) + cashCost,
      },
    }
  } else {
    next = accrueRivalContractCash(next, contract.buyerLabId, invoice, 'cost')
  }
  if (contract.sellerLabId) {
    if (contract.sellerLabId === state.playerLabId) {
      next = {
        ...next,
        player: {
          ...next.player,
          computeLeaseIncomeToday:
            (next.player.computeLeaseIncomeToday ?? 0) + invoice,
        },
      }
    } else {
      next = accrueRivalContractCash(next, contract.sellerLabId, invoice, 'income')
    }
  }
  return next
}

/**
 * Daily provider settlement and deterministic spot availability.
 * Credits reduce the player's cash invoice; they never touch revenue fields.
 */
export function tickComputeContracts(state: SimState): SimState {
  let next: SimState = {
    ...state,
    rivals: state.rivals.map((rival) => ({
      ...rival,
      computeLeaseIncomeToday: 0,
      computeLeaseCostToday: 0,
    })),
  }
  let providers = [...state.worldMarkets.cloudProviders]
  const contracts: ComputeContract[] = []
  const news: string[] = []
  const feedEvents: FeedEventInput[] = []

  for (const original of state.computeContracts) {
    if (original.status === 'offered' || original.status === 'expired') {
      contracts.push(original)
      continue
    }

    let contract = { ...original }
    const provisioned = contract.availableDay == null || state.day >= contract.availableDay
    let availableToday = provisioned

    if (!provisioned) {
      contracts.push(contract)
      continue
    }

    if (contract.status === 'interrupted') {
      const remaining = Math.max(0, (contract.interruptionDaysLeft ?? 1) - 1)
      if (remaining > 0) {
        contract.interruptionDaysLeft = remaining
        availableToday = false
      } else {
        contract.status = 'active'
        contract.interruptionDaysLeft = undefined
      }
    }

    if (contract.status === 'active' && contract.kind === 'spot') {
      const rng = createRng(hashSeed(state.seed, state.day, contract.id, 'spot-interruption'))
      if (rng.next() < clamp(0, 1, contract.interruptionRisk)) {
        contract.status = 'interrupted'
        contract.interruptionDaysLeft = 1
        availableToday = false
        news.push(
          `Day ${state.day}: ${contract.providerName} spot capacity interrupted (${formatComputeMw(contract.pf)}).`,
        )
        feedEvents.push({
          id: `feed-compute-contract-interrupted-${contract.id}-${state.day}`,
          day: state.day,
          category: 'market',
          title: `${contract.providerName} spot capacity interrupted`,
          body: `${formatComputeMw(contract.pf)} of spot capacity is temporarily unavailable; the contract will retry after the interruption window.`,
          source: 'Compute Desk',
          tone: 'warning',
          entityId: contract.buyerLabId,
          kind: 'compute_contract_interrupted',
        })
      }
    }

    if (availableToday && contract.status === 'active') {
      next = settleInvoice(next, contract, contract.pf * contract.pricePerPfDay)
    }

    contract.daysLeft = Math.max(0, contract.daysLeft - 1)
    if (contract.daysLeft <= 0) {
      providers = releaseProviderCapacity(providers, contract)
      contract = {
        ...contract,
        status: 'expired',
        daysLeft: 0,
        interruptionDaysLeft: undefined,
      }
      news.push(
        `Day ${state.day}: ${contract.providerName} compute contract expired; ${formatComputeMw(contract.pf)} returned.`,
      )
      feedEvents.push({
        id: `feed-compute-contract-expired-${contract.id}-${state.day}`,
        day: state.day,
        category: 'market',
        title: `${contract.providerName} compute contract expired`,
        body: `${formatComputeMw(contract.pf)} of ${contract.kind.replace('_', ' ')} capacity returned to the provider pool.`,
        source: 'Compute Desk',
        tone: 'neutral',
        entityId: contract.buyerLabId,
        kind: 'compute_contract_expired',
      })
    }
    contracts.push(contract)
  }

  providers = providers.map((provider) => growProviderCapacity(provider, state.day))

  const settled = {
    ...next,
    computeContracts: contracts,
    worldMarkets: { ...next.worldMarkets, cloudProviders: providers },
    news: [...news, ...next.news].slice(0, 48),
  }
  return appendFeedEvents(settled, feedEvents)
}

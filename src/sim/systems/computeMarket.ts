/**
 * Wholesale compute leases between player and rivals.
 * Leased PF is deducted from the seller's global capacity and added to the buyer.
 * Floor price = energy cost of that PF × ECONOMY.computeLeaseEnergyMarkup (≥1.5×).
 */
import { ECONOMY } from '../balance/economy'
import type { ComputeLease, ComputeListing, LabId, RivalLab, SimState } from '../types'
import { createRng, seededId } from '../rng'
import { energyPriceForState } from './map'
import { fleetStats } from './racks'
import { computeLabSnapshot, getLab, updateLab } from './labEngine'

const MIN_PF = 2
const MAX_PF = 400

/** Energy $/day to run 1 PF (proxy MW × PUE × 24 × $/MWh). */
export function computeEnergyCostPerPfDay(state: SimState): number {
  const price = energyPriceForState(state)
  const pue = Math.max(1.05, state.player.pue ?? 1.35)
  const mwPerPf = ECONOMY.mwPerPfProxy ?? 0.011
  return mwPerPf * pue * 24 * price
}

/** Minimum lease $/PF-day so seller covers energy × markup (default 1.5×). */
export function minComputeLeasePricePerPfDay(state: SimState): number {
  const markup = ECONOMY.computeLeaseEnergyMarkup ?? 1.5
  return Math.max(80, computeEnergyCostPerPfDay(state) * markup)
}

export function clampLeasePricePerPfDay(state: SimState, price: number): number {
  const floor = minComputeLeasePricePerPfDay(state)
  return Math.max(floor, Math.max(0, price))
}

function alert(
  state: SimState,
  severity: 'info' | 'warn' | 'danger',
  message: string,
): SimState {
  return {
    ...state,
    alerts: [
      {
        id: seededId('cm', state.seed, state.day, message),
        day: state.day,
        severity,
        message,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function activeLeases(state: SimState): ComputeLease[] {
  return (state.computeLeases ?? []).filter((c) => c.status === 'active')
}

export function openOffers(state: SimState): ComputeLease[] {
  return (state.computeLeases ?? []).filter((c) => c.status === 'offer')
}

function leaseSeller(state: SimState, lease: ComputeLease): LabId {
  return lease.sellerLabId ?? (lease.playerSells ? state.playerLabId : lease.rivalId)
}

function leaseBuyer(state: SimState, lease: ComputeLease): LabId {
  return lease.buyerLabId ?? (lease.playerSells ? lease.rivalId : state.playerLabId)
}

/** Net PF added to player (positive = rented in). */
export function playerLeaseNetPf(state: SimState): number {
  let net = 0
  for (const c of activeLeases(state)) {
    if (leaseSeller(state, c) === state.playerLabId) net -= c.pf
    if (leaseBuyer(state, c) === state.playerLabId) net += c.pf
  }
  return net
}

/** Net PF added to a rival. */
export function rivalLeaseNetPf(state: SimState, rivalId: string): number {
  let net = 0
  for (const c of activeLeases(state)) {
    if (leaseSeller(state, c) === rivalId) net -= c.pf
    if (leaseBuyer(state, c) === rivalId) net += c.pf
  }
  return net
}

export function rivalEffectiveFlops(state: SimState, r: RivalLab): number {
  // The canonical snapshot includes physical racks plus provider-neutral and
  // legacy bilateral capacity. Keeping a second additive legacy path here
  // would double-count leases in training, research, and serving.
  return Math.max(0, computeLabSnapshot(state, r.id).rawFlopsPf)
}

/**
 * How much PF a rival needs to host public models + train vs spare capacity.
 * Rivals only offer to *sell* when spare is clearly unused.
 */
export function rivalHostingBalance(
  state: SimState,
  r: RivalLab,
): {
  totalPf: number
  needPf: number
  sparePf: number
  canSell: boolean
  needsMore: boolean
  sellingLocked: boolean
} {
  const totalPf = rivalEffectiveFlops(state, r)
  const publicModels = r.models.filter((m) => m.shipped || m.release === 'released')
  const best = publicModels.sort((a, b) => b.capability - a.capability)[0]
  // Hosting load: share × model size proxy × serve allocation
  const share = state.lastMarket.sharesByLab[r.id] ?? r.marketShare
  const size = best ? Math.pow(Math.max(0.5, best.activeParamsB ?? best.paramsB), 0.45) : 0
  const hostNeed =
    publicModels.length === 0
      ? 0
      : (8 + share * 120) * size * (0.55 + r.allocation.inference * 0.9)
  const trainNeed = r.trainingJob
    ? Math.max(12, r.trainingJob.targetPfDays * 0.08)
    : publicModels.length === 0
      ? totalPf * r.allocation.training * 0.25
      : totalPf * r.allocation.training * 0.15
  const researchNeed = totalPf * r.allocation.research * 0.2
  const needPf = hostNeed + trainNeed + researchNeed
  const sparePf = Math.max(0, totalPf - needPf * 1.12)
  // playerSells false means player buys = rival sells
  const rivalSelling = activeLeases(state).some(
    (c) => c.rivalId === r.id && !c.playerSells && c.status === 'active',
  )
  const needsMore = needPf > totalPf * 0.92
  return {
    totalPf,
    needPf,
    sparePf,
    canSell: sparePf >= MIN_PF * 1.5 && !needsMore,
    needsMore,
    sellingLocked: rivalSelling && needsMore,
  }
}

export function playerSparePf(state: SimState): number {
  const fleet = fleetStats(state)
  const net = playerLeaseNetPf(state)
  const total = Math.max(0, fleet.flopsPf + net)
  const alloc = state.player.allocation
  // Used: rough util of train+serve based on jobs / market
  const training = !!state.player.trainingJob
  const serving = state.player.models.some(
    (m) => m.release === 'released' || m.shipped,
  )
  const usedFrac =
    (training ? alloc.training * 0.95 : alloc.training * 0.2) +
    (serving ? alloc.inference * 0.75 : alloc.inference * 0.15) +
    alloc.research * 0.35
  const spare = total * Math.max(0.05, 1 - Math.min(0.95, usedFrac))
  return Math.max(0, spare)
}

export function setComputeListing(
  state: SimState,
  listing: ComputeListing | null,
): SimState {
  if (!listing) {
    return { ...state, computeListing: null }
  }
  const pf = Math.max(MIN_PF, Math.min(MAX_PF, listing.pf))
  if (listing.side === 'sell' && pf > playerSparePf(state) + 1) {
    return alert(
      state,
      'warn',
      `Only ~${playerSparePf(state).toFixed(0)} PF spare to lease out (need headroom).`,
    )
  }
  const pricePerPfDay = clampLeasePricePerPfDay(state, listing.pricePerPfDay)
  const floor = minComputeLeasePricePerPfDay(state)
  return {
    ...state,
    computeListing: {
      side: listing.side,
      pf,
      pricePerPfDay,
      termDays: Math.max(7, Math.min(120, listing.termDays)),
    },
    alerts: [
      {
        id: `list-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message:
          listing.side === 'sell'
            ? `Listing ${pf.toFixed(0)} PF for lease @ $${pricePerPfDay.toFixed(0)}/PF-day (floor $${floor.toFixed(0)} = energy×${ECONOMY.computeLeaseEnergyMarkup ?? 1.5}) · ${listing.termDays}d`
            : `Seeking ${pf.toFixed(0)} PF lease @ ≥$${pricePerPfDay.toFixed(0)}/PF-day · ${listing.termDays}d`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function acceptComputeOffer(state: SimState, leaseId: string): SimState {
  const leases = (state.computeLeases ?? []).map((c) => ({ ...c }))
  const i = leases.findIndex((c) => c.id === leaseId && c.status === 'offer')
  if (i < 0) return alert(state, 'warn', 'Offer not found.')
  let c = leases[i]!
  const floor = minComputeLeasePricePerPfDay(state)
  if (c.pricePerPfDay < floor - 0.5) {
    // Renegotiate up to energy floor so neither side sells below cost×1.5
    c = { ...c, pricePerPfDay: floor }
  }
  if (c.playerSells && c.pf > playerSparePf(state) + 2) {
    return alert(state, 'warn', 'You no longer have spare PF for this deal.')
  }
  if (!c.playerSells) {
    const rival = state.rivals.find((r) => r.id === c.rivalId)
    if (rival) {
      const bal = rivalHostingBalance(state, rival)
      if (bal.sparePf < c.pf * 0.85) {
        return alert(
          state,
          'warn',
          `${rival.name} pulled capacity — deal no longer available.`,
        )
      }
    }
  }
  leases[i] = {
    ...c,
    status: 'active',
    daysLeft: c.daysTotal,
    dayStarted: state.day,
  }
  const rival = state.rivals.find((r) => r.id === c.rivalId)
  return {
    ...state,
    computeLeases: leases,
    computeListing: null,
    news: [
      `Day ${state.day}: Compute deal live with ${rival?.name ?? c.rivalId} — ${c.pf.toFixed(0)} PF ${
        c.playerSells ? 'sold' : 'bought'
      } @ $${c.pricePerPfDay.toFixed(0)}/PF-day (${c.daysTotal}d).`,
      ...state.news,
    ].slice(0, 20),
    alerts: [
      {
        id: `acc-${leaseId}`,
        day: state.day,
        severity: 'info' as const,
        message: `Lease active: ${c.pf.toFixed(0)} PF ${c.playerSells ? 'to' : 'from'} ${
          rival?.name ?? 'rival'
        }.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function rejectComputeOffer(state: SimState, leaseId: string): SimState {
  const leases = (state.computeLeases ?? []).filter((c) => c.id !== leaseId)
  return {
    ...state,
    computeLeases: leases,
    alerts: [
      {
        id: `rej-${leaseId}`,
        day: state.day,
        severity: 'info' as const,
        message: 'Compute offer declined.',
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export type PlayerComputeSaleInput = {
  rivalId: string
  pf: number
  pricePerPfDay: number
  termDays: number
  note?: string
}

/**
 * Signs an outbound bilateral lease immediately after the player and rival have
 * completed the UI negotiation. The lease ledger is authoritative for both
 * capacity and daily settlement, so sold PF disappears from the player's
 * available pool as soon as this returns.
 */
export function signPlayerComputeSale(
  state: SimState,
  input: PlayerComputeSaleInput,
): SimState {
  const rival = state.rivals.find((candidate) => candidate.id === input.rivalId)
  if (!rival) return alert(state, 'warn', 'Compute buyer not found.')

  const sparePf = playerSparePf(state)
  const pf = Math.max(MIN_PF, Math.min(MAX_PF, Math.floor(input.pf)))
  if (pf > sparePf + 1) {
    return alert(
      state,
      'warn',
      `Only ~${sparePf.toFixed(0)} PF is spare. Reduce the package before signing.`,
    )
  }
  if (activeLeases(state).some((lease) => lease.rivalId === rival.id && lease.playerSells)) {
    return alert(state, 'warn', `${rival.name} already has a live outbound lease.`)
  }

  const termDays = Math.max(7, Math.min(720, Math.floor(input.termDays)))
  const pricePerPfDay = clampLeasePricePerPfDay(state, input.pricePerPfDay)
  const committedValue = pf * pricePerPfDay * termDays
  if (rival.cash < Math.min(committedValue, pf * pricePerPfDay * 30)) {
    return alert(state, 'warn', `${rival.name} cannot support this contract size.`)
  }

  const lease: ComputeLease = {
    id: seededId('sale', state.seed, state.day, rival.id, pf, pricePerPfDay, termDays),
    rivalId: rival.id,
    playerSells: true,
    sellerLabId: state.playerLabId,
    buyerLabId: rival.id,
    pf,
    pricePerPfDay,
    daysLeft: termDays,
    daysTotal: termDays,
    status: 'active',
    from: 'player',
    dayStarted: state.day,
    note: input.note,
  }

  return {
    ...state,
    computeLeases: [...(state.computeLeases ?? []), lease],
    computeListing: null,
    news: [
      `Day ${state.day}: ${rival.name} signs for ${pf.toFixed(0)} PF from ${state.player.name} @ $${pricePerPfDay.toFixed(0)}/PF-day (${termDays}d).`,
      ...state.news,
    ].slice(0, 24),
    alerts: [
      {
        id: `sale-${lease.id}`,
        day: state.day,
        severity: 'info' as const,
        message: `Capacity sale live: ${pf.toFixed(0)} PF to ${rival.name} · $${(pf * pricePerPfDay).toFixed(0)}/day.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

/** Player cancels active lease (small break fee). */
export function cancelComputeLease(state: SimState, leaseId: string): SimState {
  const leases = (state.computeLeases ?? []).map((c) => ({ ...c }))
  const i = leases.findIndex((c) => c.id === leaseId && c.status === 'active')
  if (i < 0) return alert(state, 'warn', 'No active lease.')
  const c = leases[i]!
  const fee = Math.floor(c.pf * c.pricePerPfDay * 3)
  if (state.player.cash < fee) {
    return alert(state, 'warn', `Need $${(fee / 1e3).toFixed(0)}k break fee to cancel.`)
  }
  leases.splice(i, 1)
  const rival = state.rivals.find((r) => r.id === c.rivalId)
  return {
    ...state,
    computeLeases: leases,
    player: {
      ...state.player,
      cash: state.player.cash - fee,
    },
    news: [
      `Day ${state.day}: ${state.player.name} cancels compute deal with ${
        rival?.name ?? 'rival'
      } (fee $${(fee / 1e3).toFixed(0)}k).`,
      ...state.news,
    ].slice(0, 20),
    alerts: [
      {
        id: `can-${leaseId}`,
        day: state.day,
        severity: 'warn' as const,
        message: `Lease cancelled — break fee $${(fee / 1e3).toFixed(0)}k. Capacity returns immediately.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

/** Rivals monetize spare compute only when their operating cash is under pressure. */
export function rivalNeedsLeaseRevenue(rival: RivalLab): boolean {
  const finance = rival.finance
  const dayNet = finance?.dayNet ?? 0
  const dayOut = finance?.dayTotalOut ?? 0
  const cash = Math.max(0, rival.cash)
  const runwayDays =
    finance && Number.isFinite(finance.runwayDays)
      ? finance.runwayDays
      : dayNet < 0
        ? cash / Math.max(1, -dayNet)
        : Number.POSITIVE_INFINITY
  const reserveDays = dayOut > 0 ? cash / dayOut : Number.POSITIVE_INFINITY
  return rival.cash > -20_000_000 && (runwayDays <= 120 || reserveDays <= 45)
}

/** Stable 3–7 day cadence so rival approaches feel periodic, not spammy or random. */
function isRivalLeaseContactDay(state: SimState, rivalIndex: number): boolean {
  const interval = 3 + Math.abs((state.seed + rivalIndex * 7) % 5)
  return (state.day + rivalIndex * 2) % interval === 0
}

export function tickComputeMarket(state: SimState): SimState {
  let s = state
  // Player-authored offers were removed from the market UI. Drop any legacy
  // pending proposals from older saves while preserving active contracts.
  let leases = (s.computeLeases ?? []).filter(
    (lease) => lease.status !== 'offer' || lease.from === 'rival',
  )
  let dayLeaseIncome = 0
  let dayLeaseCost = 0
  const news: string[] = []

  // ── Bill / age active leases (cash settled in tickMarket via day fields) ──
  const nextLeases: ComputeLease[] = []
  for (const c of leases) {
    if (c.status !== 'active') {
      nextLeases.push(c)
      continue
    }
    const dayCash = c.pf * c.pricePerPfDay
    const sellerLabId = leaseSeller(s, c)
    const buyerLabId = leaseBuyer(s, c)
    const buyer = getLab(s, buyerLabId)
    if (buyer.cash < dayCash) {
      news.push(
        `Day ${s.day}: Compute lease (${c.pf.toFixed(0)} PF) lapsed — buyer could not settle.`,
      )
      continue
    }
    if (sellerLabId === s.playerLabId) {
      dayLeaseIncome += dayCash
    } else {
      s = updateLab(s, sellerLabId, (lab) => ({ ...lab, cash: lab.cash + dayCash }))
    }
    if (buyerLabId === s.playerLabId) {
      dayLeaseCost += dayCash
    } else {
      s = updateLab(s, buyerLabId, (lab) => ({ ...lab, cash: lab.cash - dayCash }))
    }
    const daysLeft = c.daysLeft - 1
    if (daysLeft <= 0) {
      news.push(
        `Day ${s.day}: Compute lease (${c.pf.toFixed(0)} PF) with ${
          s.rivals.find((r) => r.id === c.rivalId)?.name ?? 'rival'
        } expired.`,
      )
      continue
    }
    nextLeases.push({ ...c, daysLeft })
  }
  leases = nextLeases
  s = {
    ...s,
    computeLeases: leases,
    player: {
      ...s.player,
      computeLeaseIncomeToday: dayLeaseIncome,
      computeLeaseCostToday: dayLeaseCost,
    },
    news: [...news, ...s.news].slice(0, 24),
  }

  // ── Rival AI: only sell spare; if SOTA need more, expand or wait for cancel ──
  for (let ri = 0; ri < s.rivals.length; ri++) {
    const r = s.rivals[ri]!
    const bal = rivalHostingBalance(s, r)
    const rngR = createRng(s.seed + s.day * 17 + ri * 91)

    // If selling to player and now need capacity — wait (do not cancel); push campus expand flag
    if (bal.sellingLocked && s.day % 5 === ri % 5) {
      s = {
        ...s,
        news: [
          `Day ${s.day}: ${r.name} needs more compute for SOTA hosting — locked in a lease to you until it ends or you cancel; expanding campus.`,
          ...s.news,
        ].slice(0, 24),
      }
    }

    // Cash-stressed rivals periodically approach the player with spare PF.
    if (
      rivalNeedsLeaseRevenue(r) &&
      isRivalLeaseContactDay(s, ri) &&
      bal.canSell &&
      bal.sparePf >= MIN_PF * 2 &&
      !activeLeases(s).some((lease) => lease.rivalId === r.id && !lease.playerSells) &&
      !openOffers(s).some((o) => o.rivalId === r.id && o.from === 'rival')
    ) {
      const pf = Math.min(
        MAX_PF,
        Math.max(MIN_PF, Math.floor(bal.sparePf * (0.25 + rngR.range(0, 0.35)))),
      )
      const floor = minComputeLeasePricePerPfDay(s)
      const urgent = (r.finance?.runwayDays ?? Number.POSITIVE_INFINITY) <= 30
      const price = floor * (urgent ? 1 + rngR.range(0, 0.08) : 1.05 + rngR.range(0, 0.22))
      const term = rngR.pick([14, 21, 30, 45])
      const offer: ComputeLease = {
        id: `offer-${s.day}-${r.id}`,
        rivalId: r.id,
        playerSells: false, // rival sells → player buys
        sellerLabId: r.id,
        buyerLabId: s.playerLabId,
        pf,
        pricePerPfDay: price,
        daysLeft: term,
        daysTotal: term,
        status: 'offer',
        from: 'rival',
        dayStarted: s.day,
        note: `${r.name} is raising cash from spare compute — offering ${pf} PF`,
      }
      leases = [...(s.computeLeases ?? []), offer]
      s = {
        ...s,
        computeLeases: leases,
        alerts: [
          {
            id: `r-offer-${offer.id}`,
            day: s.day,
            severity: 'info' as const,
            message: `${r.name} offers to lease you ${pf} PF @ $${price.toFixed(0)}/PF-day (${term}d).`,
          },
          ...s.alerts,
        ].slice(0, 40),
      }
    }

    // Rival wants to buy if overloaded and player is listing sell
    const listing = s.computeListing
    if (
      listing?.side === 'sell' &&
      bal.needsMore &&
      rngR.range(0, 1) < 0.12 &&
      !activeLeases(s).some((c) => c.rivalId === r.id && c.playerSells)
    ) {
      const pf = Math.min(listing.pf, Math.max(MIN_PF, bal.needPf - bal.totalPf + 8))
      const floor = minComputeLeasePricePerPfDay(s)
      const bid = Math.max(floor, listing.pricePerPfDay * (0.98 + rngR.range(0, 0.12)))
      if (pf >= MIN_PF && r.cash > pf * bid * 10) {
        const offer: ComputeLease = {
          id: `want-${s.day}-${r.id}`,
          rivalId: r.id,
          playerSells: true,
          sellerLabId: s.playerLabId,
          buyerLabId: r.id,
          pf,
          pricePerPfDay: bid,
          daysLeft: listing.termDays,
          daysTotal: listing.termDays,
          status: 'offer',
          from: 'rival',
          note: `${r.name} needs PF for hosting — wants your listing`,
        }
        s = {
          ...s,
          computeLeases: [...(s.computeLeases ?? []), offer],
          alerts: [
            {
              id: `r-buy-${offer.id}`,
              day: s.day,
              severity: 'info' as const,
              message: `${r.name} wants to lease ${pf.toFixed(0)} PF from your listing @ $${offer.pricePerPfDay.toFixed(0)}/PF-day.`,
            },
            ...s.alerts,
          ].slice(0, 40),
        }
      }
    }

  }

  // Expire old rival offers after ~8 days
  s = {
    ...s,
    computeLeases: (s.computeLeases ?? []).filter((c) => {
      if (c.status !== 'offer') return true
      // offers use daysLeft as term; count age via id day parse soft
      return true
    }),
  }

  return s
}

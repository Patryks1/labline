import { DATA_DOMAIN_META, normalizeDomainStock } from '../balance/data'
import { ECONOMY } from '../balance/economy'
import { RACK_SKU_CATALOG } from '../balance/rackSkus'
import { getChassis } from '../balance/racks'
import { createRng, hashSeed, seededId } from '../rng'
import type {
  ActiveLoan,
  DataDomain,
  FirmLoanOffer,
  LabId,
  LoanApplication,
  MarketFill,
  ResourceOrder,
  SimState,
  StaffRole,
} from '../types'
import { creditLimitForValuation, totalDebt } from './loans'
import {
  acceptEquityOffer,
  applyForLabDebt,
  requestEquityOffers,
} from './capital'
import { facilityAnchorTiles } from './worldAccess'
import { getLab, syncLabIndex, updateLab } from './labEngine'
import { STAFF_HIRE_COST } from '../balance/staff'
import { labStaffOpenSeats } from './staff'
import {
  appendDatasetAsset,
  marketDatasetAsset,
  marketDatasetLineageId,
  mergeRecurringDatasetAsset,
} from './dataAssets'

function addAlert(state: SimState, message: string, severity: 'info' | 'warn' | 'danger' = 'info'): SimState {
  return {
    ...state,
    alerts: [
      { id: seededId('market-alert', state.seed, state.day, message), day: state.day, severity, message },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function queueResourceOrder(
  state: SimState,
  input: Omit<ResourceOrder, 'id' | 'quantityFilled' | 'cashReserved' | 'submittedDay' | 'expiresDay'> & {
    expiresInDays?: number
  },
): SimState {
  const lab = getLab(state, input.labId)
  const quantity = Math.max(0, Math.floor(input.quantity * 1000) / 1000)
  const maxUnitPrice = Math.max(0, input.maxUnitPrice)
  const cashReserved = quantity * maxUnitPrice
  if (quantity <= 0) return state
  if (lab.cash < cashReserved) {
    return input.labId === state.playerLabId
      ? addAlert(state, `Need $${(cashReserved / 1e6).toFixed(2)}M available to reserve this bid.`, 'warn')
      : state
  }
  const order: ResourceOrder = {
    ...input,
    id: seededId(
      'order',
      state.seed,
      state.day,
      input.labId,
      input.kind,
      input.resourceId,
      state.worldMarkets.orders.length,
    ),
    quantity,
    maxUnitPrice,
    quantityFilled: 0,
    cashReserved,
    submittedDay: state.day,
    expiresDay: state.day + Math.max(1, input.expiresInDays ?? 7),
  }
  let next = updateLab(state, input.labId, (entry) => ({ ...entry, cash: entry.cash - cashReserved }))
  next = {
    ...next,
    worldMarkets: {
      ...next.worldMarkets,
      orders: [...next.worldMarkets.orders, order],
    },
  }
  return input.labId === state.playerLabId
    ? addAlert(
        next,
        `Bid queued: ${quantity.toFixed(quantity < 10 ? 1 : 0)} ${input.resourceId} @ up to $${maxUnitPrice.toLocaleString()}/unit. Clears next day.`,
      )
    : next
}

function clearingPrice(orders: ResourceOrder[], supply: number, reserve: number): number {
  let remaining = supply
  let highestRejected = reserve
  for (const order of orders) {
    const need = order.quantity - order.quantityFilled
    if (remaining <= 1e-9) {
      highestRejected = Math.max(highestRejected, order.maxUnitPrice)
      break
    }
    remaining -= Math.min(remaining, need)
  }
  return Math.max(reserve, highestRejected)
}

function rankedOrders(state: SimState, orders: ResourceOrder[]): ResourceOrder[] {
  return [...orders].sort((a, b) => {
    if (b.maxUnitPrice !== a.maxUnitPrice) return b.maxUnitPrice - a.maxUnitPrice
    return (
      hashSeed(state.seed, state.day, a.labId, a.id, 'tie') -
      hashSeed(state.seed, state.day, b.labId, b.id, 'tie')
    )
  })
}

function destinationForLab(state: SimState, labId: LabId): { x: number; y: number } | null {
  const hall = facilityAnchorTiles(state, { ownerId: labId }).find(
    (tile) =>
      (tile.kind === 'dc' || tile.kind === 'dc_m' || tile.kind === 'dc_l') &&
      tile.buildingProgress >= tile.buildingTarget,
  )
  return hall ? { x: hall.x, y: hall.y } : null
}

/** Remaining physical bay units after live and in-flight inventory. */
export function labFreeRackUnits(state: SimState, labId: LabId): number {
  const capacity = facilityAnchorTiles(state, { ownerId: labId })
    .filter(
      (tile) =>
        (tile.kind === 'dc' || tile.kind === 'dc_m' || tile.kind === 'dc_l') &&
        tile.buildingProgress >= tile.buildingTarget,
    )
    .reduce((sum, tile) => sum + Math.max(0, tile.rackCapacity), 0)
  const lab = getLab(state, labId)
  let committed = lab.rackFleet.reduce(
    (sum, install) =>
      sum + Math.max(0, install.count) * Math.max(1, install.rackUnits || 1),
    0,
  )
  if (labId === state.playerLabId) {
    committed += (state.player.chips ?? []).reduce(
      (sum, inventory) => sum + Math.max(0, inventory.count),
      0,
    )
    committed += (state.player.deployedRacks ?? []).reduce((sum, deployed) => {
      const design = state.player.rackDesigns.find((entry) => entry.id === deployed.designId)
      if (!design) return sum + Math.max(0, deployed.count)
      try {
        return sum + Math.max(0, deployed.count) * getChassis(design.chassisId).rackUnits
      } catch {
        return sum + Math.max(0, deployed.count)
      }
    }, 0)
  }
  return Math.max(0, capacity - committed)
}

function applyAcceleratorFill(
  state: SimState,
  order: ResourceOrder,
  quantity: number,
  unitPrice: number,
): SimState {
  const supply = state.worldMarkets.accelerators[order.resourceId]
  const sku = RACK_SKU_CATALOG.find((candidate) => candidate.id === order.resourceId)
  if (!supply || !sku || quantity <= 0) return state
  const destination = order.destination ?? destinationForLab(state, order.labId)
  if (!destination) return state
  const lead = Math.max(1, supply.leadTimeDays + Math.ceil(supply.backlog / Math.max(1, supply.dailyReplenishment * 3)))
  return updateLab(state, order.labId, (lab) => ({
    ...lab,
    rackFleet: [
      ...lab.rackFleet,
      {
        id: seededId('rack-fill', state.seed, state.day, order.id, quantity),
        skuId: sku.id,
        x: destination.x,
        y: destination.y,
        count: Math.max(1, Math.floor(quantity)),
        status: 'ordered',
        daysLeft: lead,
        paidEach: unitPrice,
        rackUnits: sku.rackUnits,
      },
    ],
  }))
}

function applyDataFill(
  state: SimState,
  order: ResourceOrder,
  quantity: number,
): SimState {
  const offer = state.dataMarket.offers.find((candidate) => candidate.id === order.resourceId)
  if (!offer || quantity <= 0) return state
  const domain = offer.domain as DataDomain
  return updateLab(state, order.labId, (lab) => {
    const stock = normalizeDomainStock(lab.data.stocks[domain])
    const nextProcessed = stock.processed + quantity
    stock.quality =
      nextProcessed > 0
        ? (stock.quality * stock.processed + offer.quality * quantity) / nextProcessed
        : offer.quality
    stock.processed = nextProcessed
    stock.fromBought += quantity
    let data = {
      ...lab.data,
      stocks: { ...lab.data.stocks, [domain]: stock },
      lifetimeCollected: lab.data.lifetimeCollected + quantity,
      lifetimeProcessed: lab.data.lifetimeProcessed + quantity,
    }
    const assetId = marketDatasetLineageId({
      labId: order.labId,
      domain,
      name: offer.name,
      sellerKind: offer.sellerKind,
      sellerName: offer.sellerName,
      qualityBand: offer.qualityBand,
      offerSource: offer.source,
    })
    const asset = marketDatasetAsset({
        id: assetId,
        name: offer.name,
        domain,
        quantityMTok: quantity,
        quality: offer.quality,
        qualityBand: offer.qualityBand,
        sellerKind: offer.sellerKind,
        sellerName: offer.sellerName,
        offerSource: offer.source,
        day: state.day,
      })
    data = appendDatasetAsset(
      data,
      mergeRecurringDatasetAsset(
        data.assets.find((candidate) => candidate.id === assetId),
        asset,
      ),
    )
    return { ...lab, data }
  })
}

function applyTalentFill(state: SimState, order: ResourceOrder, quantity: number): SimState {
  const role = order.metadata?.role as StaffRole | undefined
  if (!role || quantity <= 0) return state
  return updateLab(state, order.labId, (lab) => ({
    ...lab,
    staff: { ...lab.staff, [role]: (lab.staff[role] ?? 0) + Math.floor(quantity) },
  }))
}

function settleOrderRefund(state: SimState, order: ResourceOrder, spent: number): SimState {
  const refund = Math.max(0, order.cashReserved - spent)
  return refund > 0
    ? updateLab(state, order.labId, (lab) => ({ ...lab, cash: lab.cash + refund }))
    : state
}

function clearAccelerators(state: SimState): SimState {
  let next = state
  const accelerators = { ...next.worldMarkets.accelerators }
  const fills: MarketFill[] = []
  const remainingOrders: ResourceOrder[] = []
  for (const [skuId, previous] of Object.entries(accelerators)) {
    const supply = {
      ...previous,
      available: previous.available + previous.dailyReplenishment,
    }
    const orders = rankedOrders(
      next,
      next.worldMarkets.orders.filter((order) => order.kind === 'accelerator' && order.resourceId === skuId),
    )
    const price = clearingPrice(orders, supply.available, supply.reserveUnitPrice)
    let available = supply.available
    const sku = RACK_SKU_CATALOG.find((candidate) => candidate.id === skuId)
    for (const order of orders) {
      const wanted = Math.max(0, order.quantity - order.quantityFilled)
      // Re-check bay capacity at clearing time. Multiple bids can be queued
      // against the same free space, and another delivery may land first.
      const capacityQty = sku
        ? Math.floor(labFreeRackUnits(next, order.labId) / Math.max(1, sku.rackUnits))
        : 0
      const filled =
        order.maxUnitPrice >= price
          ? Math.max(0, Math.floor(Math.min(wanted, available, capacityQty)))
          : 0
      available -= filled
      const spent = filled * price
      if (filled > 0) {
        next = applyAcceleratorFill(next, order, filled, price)
        fills.push({
          id: seededId('fill', next.seed, next.day, order.id),
          orderId: order.id,
          labId: order.labId,
          kind: 'accelerator',
          resourceId: skuId,
          quantity: filled,
          unitPrice: price,
          day: next.day,
        })
      }
      next = settleOrderRefund(next, order, spent)
      if (filled + order.quantityFilled < order.quantity && order.expiresDay > next.day) {
        // Unfilled quantities must be explicitly re-bid; never keep cash silently locked.
      }
    }
    supply.available = Math.max(0, available)
    supply.backlog = Math.max(0, orders.reduce((sum, order) => sum + order.quantity, 0) - supply.available)
    accelerators[skuId] = supply
  }
  remainingOrders.push(
    ...next.worldMarkets.orders.filter((order) => order.kind !== 'accelerator'),
  )
  return {
    ...next,
    worldMarkets: {
      ...next.worldMarkets,
      accelerators,
      orders: remainingOrders,
      fills: [...fills, ...next.worldMarkets.fills].slice(0, 80),
    },
  }
}

function clearData(state: SimState): SimState {
  let next = state
  const offers = state.dataMarket.offers.map((offer) => ({ ...offer }))
  const untouched = next.worldMarkets.orders.filter((order) => order.kind !== 'data')
  const fills: MarketFill[] = []
  for (const offer of offers) {
    const orders = rankedOrders(
      next,
      next.worldMarkets.orders.filter((order) => order.kind === 'data' && order.resourceId === offer.id),
    )
    const reserve = offer.cash / Math.max(1, offer.lotMTok)
    const price = clearingPrice(orders, offer.mTokLeft, reserve)
    let available = offer.mTokLeft
    for (const order of orders) {
      const filled = order.maxUnitPrice >= price ? Math.min(order.quantity, available) : 0
      available -= filled
      const spent = filled * price
      if (filled > 0) {
        next = applyDataFill(next, order, filled)
        fills.push({
          id: seededId('fill', next.seed, next.day, order.id),
          orderId: order.id,
          labId: order.labId,
          kind: 'data',
          resourceId: offer.id,
          quantity: filled,
          unitPrice: price,
          day: next.day,
        })
      }
      next = settleOrderRefund(next, order, spent)
    }
    offer.mTokLeft = Math.max(0, available)
  }
  return {
    ...next,
    dataMarket: { ...next.dataMarket, offers },
    worldMarkets: {
      ...next.worldMarkets,
      orders: untouched,
      fills: [...fills, ...next.worldMarkets.fills].slice(0, 80),
    },
  }
}

function clearTalent(state: SimState): SimState {
  let next = state
  const untouched = next.worldMarkets.orders.filter((order) => order.kind !== 'talent')
  const cities = (next.map.cities ?? []).map((city) => ({
    ...city,
    talentAvailable: city.talentAvailable ? { ...city.talentAvailable } : undefined,
  }))
  const fills: MarketFill[] = []
  const talentOrders = next.worldMarkets.orders.filter((order) => order.kind === 'talent')
  const resources = [...new Set(talentOrders.map((order) => order.resourceId))]
  for (const resourceId of resources) {
    const group = talentOrders.filter((order) => order.resourceId === resourceId)
    const role = group[0]?.metadata?.role as StaffRole | undefined
    const cityId = String(group[0]?.metadata?.cityId ?? resourceId.split(':')[0] ?? '')
    const city = cities.find((candidate) => candidate.id === cityId)
    if (!role || !city?.talentAvailable) continue
    let available = city.talentAvailable[role] ?? 0
    const ranked = [...group].sort((a, b) => {
      const labA = getLab(next, a.labId)
      const labB = getLab(next, b.labId)
      const fitA =
        role === 'researcher' && labA.archetype === 'safety'
          ? 0.08
          : role === 'engineer' && labA.archetype === 'efficiency'
            ? 0.08
            : 0
      const fitB =
        role === 'researcher' && labB.archetype === 'safety'
          ? 0.08
          : role === 'engineer' && labB.archetype === 'efficiency'
            ? 0.08
            : 0
      const scoreA = a.maxUnitPrice * (0.82 + labA.brandTrust * 0.003 + fitA)
      const scoreB = b.maxUnitPrice * (0.82 + labB.brandTrust * 0.003 + fitB)
      if (scoreB !== scoreA) return scoreB - scoreA
      return hashSeed(next.seed, next.day, a.id, 'talent-tie') - hashSeed(next.seed, next.day, b.id, 'talent-tie')
    })
    let units = available
    const provisional: { order: ResourceOrder; quantity: number }[] = []
    let highestRejected = STAFF_HIRE_COST[role]
    for (const order of ranked) {
      const deskRoom = labStaffOpenSeats(next, order.labId)
      const quantity = Math.min(order.quantity, units, deskRoom)
      if (quantity > 0) {
        provisional.push({ order, quantity })
        units -= quantity
      }
      if (quantity < order.quantity) highestRejected = Math.max(highestRejected, order.maxUnitPrice)
    }
    const lowestWinnerMax =
      provisional.length > 0
        ? Math.min(...provisional.map((winner) => winner.order.maxUnitPrice))
        : STAFF_HIRE_COST[role]
    const uniformPrice = Math.min(lowestWinnerMax, Math.max(STAFF_HIRE_COST[role], highestRejected))
    for (const order of ranked) {
      const winner = provisional.find((entry) => entry.order.id === order.id)
      const filled = winner?.quantity ?? 0
      const spent = filled * uniformPrice
      if (filled > 0) {
        available -= filled
        next = applyTalentFill(next, order, filled)
        fills.push({
          id: seededId('fill', next.seed, next.day, order.id),
          orderId: order.id,
          labId: order.labId,
          kind: 'talent',
          resourceId: order.resourceId,
          quantity: filled,
          unitPrice: uniformPrice,
          day: next.day,
        })
      }
      next = settleOrderRefund(next, order, spent)
    }
    city.talentAvailable[role] = Math.max(0, available)
  }
  return {
    ...next,
    map: { ...next.map, cities },
    worldMarkets: {
      ...next.worldMarkets,
      orders: untouched,
      fills: [...fills, ...next.worldMarkets.fills].slice(0, 80),
    },
  }
}

function refreshCapitalConditions(state: SimState): SimState {
  const cycle = Math.floor(state.day / 7)
  if (cycle === state.worldMarkets.capital.cycle) return state
  const rng = createRng(hashSeed(state.seed, cycle, 'capital-cycle'))
  const industryDebt = Object.values(state.labs).reduce(
    (sum, lab) => sum + totalDebt(lab.loans),
    0,
  )
  const industryValue = Object.values(state.labs).reduce(
    (sum, lab) => sum + Math.max(1, lab.finance.valuation),
    0,
  )
  const leverage = industryDebt / Math.max(1, industryValue)
  return {
    ...state,
    worldMarkets: {
      ...state.worldMarkets,
      capital: {
        cycle,
        baseRate: (ECONOMY.loans.baseInterest ?? 0.08) + leverage * 0.08,
        creditMult: rng.range(0.9, 1.1),
        rateSpread: rng.range(-0.02, 0.02),
        industryDebt,
      },
    },
  }
}

export function submitLoanApplication(
  state: SimState,
  labId: LabId,
  principal: number,
  termDays: number,
): SimState {
  const hasPendingApplication = state.worldMarkets.loanApplications.some(
    (application) => application.labId === labId && application.status === 'pending',
  )
  const hasActiveOffer = state.worldMarkets.loanOffers.some(
    (offer) => offer.labId === labId && offer.expiresDay >= state.day,
  )
  if (hasPendingApplication || hasActiveOffer) {
    return labId === state.playerLabId
      ? addAlert(state, 'Resolve the current credit request before applying again.', 'warn')
      : state
  }
  const application: LoanApplication = {
    id: seededId('loan-app', state.seed, state.day, labId, principal, termDays),
    labId,
    principal: Math.max(0, Math.floor(principal)),
    termDays: Math.max(14, Math.min(180, Math.floor(termDays))),
    submittedDay: state.day,
    status: 'pending',
  }
  return {
    ...state,
    worldMarkets: {
      ...state.worldMarkets,
      loanApplications: [...state.worldMarkets.loanApplications, application],
    },
  }
}

function resolveLoanApplications(state: SimState): SimState {
  let next = refreshCapitalConditions(state)
  const applications: LoanApplication[] = []
  const offers = [...next.worldMarkets.loanOffers].filter((offer) => offer.expiresDay >= next.day)
  const labsWithOffer = new Set(offers.map((offer) => offer.labId))
  for (const application of next.worldMarkets.loanApplications) {
    if (application.status !== 'pending' || application.submittedDay >= next.day) {
      applications.push(application)
      continue
    }
    if (labsWithOffer.has(application.labId)) {
      applications.push({ ...application, status: 'rejected' })
      continue
    }
    const lab = getLab(next, application.labId)
    const debt = totalDebt(lab.loans)
    const frontier = Math.max(20, ...Object.values(next.labs).flatMap((entry) => entry.models.map((m) => m.capability)))
    const best = lab.models.reduce((score, model) => Math.max(score, model.capability), 0)
    const sota = best / frontier
    const limit =
      creditLimitForValuation(lab.finance.valuation, lab.brandTrust, sota) *
      next.worldMarkets.capital.creditMult
    const available = Math.max(0, (limit - debt) / 1.15)
    const principal = Math.min(application.principal, available)
    if (principal < (ECONOMY.loans.minDraw ?? 5_000_000)) {
      applications.push({ ...application, status: 'rejected' })
      continue
    }
    const leverage = (debt + principal) / Math.max(1, lab.finance.valuation)
    const interestTotal = Math.min(
      0.85,
      Math.max(
        0.02,
        next.worldMarkets.capital.baseRate +
        next.worldMarkets.capital.rateSpread +
        leverage * 0.18 +
        (application.termDays / 180) * 0.035 +
        Math.max(0, 55 - lab.brandTrust) * 0.001,
      ),
    )
    const offer: FirmLoanOffer = {
      id: seededId('loan-offer', next.seed, next.day, application.id),
      applicationId: application.id,
      labId: application.labId,
      principal: Math.floor(principal),
      termDays: application.termDays,
      interestTotal,
      expiresDay: next.day + 7,
    }
    offers.push(offer)
    labsWithOffer.add(application.labId)
    applications.push({ ...application, status: 'offered', offerId: offer.id })
    if (application.labId === next.playerLabId) {
      next = addAlert(
        next,
        `Credit review complete: $${(offer.principal / 1e6).toFixed(1)}M for ${offer.termDays}d at ${(offer.interestTotal * 100).toFixed(1)}% total interest.`,
      )
    }
  }
  return {
    ...next,
    worldMarkets: { ...next.worldMarkets, loanApplications: applications, loanOffers: offers },
  }
}

export function acceptFirmLoanOffer(state: SimState, offerId: string): SimState {
  const offer = state.worldMarkets.loanOffers.find((candidate) => candidate.id === offerId)
  if (!offer || offer.expiresDay < state.day) return state
  const borrowingLab = getLab(state, offer.labId)
  if (borrowingLab.loans.length >= (ECONOMY.loans.maxActive ?? 4)) {
    return offer.labId === state.playerLabId
      ? addAlert(state, 'Credit facility limit reached. Repay an open facility before accepting.', 'warn')
      : state
  }
  const totalDue = offer.principal * (1 + offer.interestTotal)
  const loan: ActiveLoan = {
    id: seededId('loan', state.seed, state.day, offer.labId, offer.id),
    offerId: offer.id,
    label: `Valuation facility ${(offer.principal / 1e6).toFixed(1)}M`,
    principal: offer.principal,
    remaining: totalDue,
    dailyPayment: totalDue / offer.termDays,
    daysLeft: offer.termDays,
    termDays: offer.termDays,
    takenDay: state.day,
    interestTotal: offer.interestTotal,
  }
  let next = updateLab(state, offer.labId, (lab) => ({
    ...lab,
    cash: lab.cash + offer.principal,
    loans: [...lab.loans, loan],
    finance: {
      ...lab.finance,
      cash: lab.cash + offer.principal,
      debtOutstanding: totalDebt([...lab.loans, loan]),
    },
  }))
  next = {
    ...next,
    worldMarkets: {
      ...next.worldMarkets,
      loanOffers: next.worldMarkets.loanOffers.filter((candidate) => candidate.labId !== offer.labId),
      loanApplications: next.worldMarkets.loanApplications.map((application) =>
        application.offerId === offerId
          ? { ...application, status: 'accepted' }
          : application.labId === offer.labId && (application.status === 'pending' || application.status === 'offered')
            ? { ...application, status: 'rejected' }
            : application,
      ),
    },
  }
  return next
}

export function declineFirmLoanOffer(state: SimState, offerId: string): SimState {
  const offer = state.worldMarkets.loanOffers.find((candidate) => candidate.id === offerId)
  if (!offer) return state
  const next = {
    ...state,
    worldMarkets: {
      ...state.worldMarkets,
      loanOffers: state.worldMarkets.loanOffers.filter(
        (candidate) => candidate.labId !== offer.labId,
      ),
      loanApplications: state.worldMarkets.loanApplications.map((application) =>
        application.labId === offer.labId &&
        (application.status === 'pending' || application.status === 'offered')
          ? { ...application, status: 'rejected' as const }
          : application,
      ),
    },
  }
  return offer.labId === state.playerLabId
    ? addAlert(next, 'Credit offer declined. You can submit a new request.', 'info')
    : next
}

export function tickRivalDebt(state: SimState): SimState {
  let next = state
  for (const rival of state.rivals) {
    next = updateLab(next, rival.id, (lab) => {
      let payment = 0
      const loans: ActiveLoan[] = []
      for (const loan of lab.loans) {
        const due = Math.min(loan.remaining, loan.dailyPayment)
        payment += due
        const remaining = Math.max(0, loan.remaining - due)
        const daysLeft = Math.max(0, loan.daysLeft - 1)
        if (remaining > 1 && daysLeft > 0) {
          loans.push({ ...loan, remaining, daysLeft, dailyPayment: remaining / daysLeft })
        }
      }
      const cash = lab.cash - payment
      return {
        ...lab,
        cash,
        loans,
        finance: {
          ...lab.finance,
          cash,
          dayLoanPayment: payment,
          debtOutstanding: totalDebt(loans),
        },
      }
    })
  }
  return next
}

function tickRivalRackDeliveries(state: SimState): SimState {
  let next = state
  for (const rival of state.rivals) {
    next = updateLab(next, rival.id, (lab) => {
      const fleet = lab.rackFleet.map((install) =>
        install.status === 'ordered' && install.daysLeft <= 1
          ? { ...install, status: 'live' as const, daysLeft: 0 }
          : install.status === 'ordered'
            ? { ...install, daysLeft: install.daysLeft - 1 }
            : install,
      )
      return {
        ...lab,
        rackFleet: fleet,
      }
    })
  }
  return next
}

export function tickSharedMarkets(state: SimState): SimState {
  let next = syncLabIndex(state)
  next = tickRivalRackDeliveries(next)
  next = clearAccelerators(next)
  next = clearData(next)
  next = clearTalent(next)
  next = resolveLoanApplications(next)
  next = tickRivalDebt(next)
  return {
    ...next,
    worldMarkets: { ...next.worldMarkets, lastClearedDay: next.day },
  }
}

export function queueDataOfferOrder(state: SimState, labId: LabId, offerId: string): SimState {
  const offer = state.dataMarket.offers.find((candidate) => candidate.id === offerId)
  if (!offer || offer.mTokLeft <= 0) return state
  const quantity = Math.min(offer.lotMTok, offer.mTokLeft)
  const unit = offer.cash / Math.max(1, offer.lotMTok)
  return queueResourceOrder(state, {
    labId,
    kind: 'data',
    resourceId: offerId,
    quantity,
    maxUnitPrice: unit,
    metadata: { domain: offer.domain, quality: offer.quality },
  })
}

export function queueTalentOrder(
  state: SimState,
  labId: LabId,
  cityId: string,
  role: StaffRole,
  count: number,
  signingCostPerHire: number,
): SimState {
  return queueResourceOrder(state, {
    labId,
    kind: 'talent',
    resourceId: `${cityId}:${role}`,
    quantity: count,
    maxUnitPrice: signingCostPerHire,
    metadata: { cityId, role },
  })
}

export function queueAcceleratorBid(
  state: SimState,
  labId: LabId,
  skuId: string,
  count: number,
  maxUnitPrice: number,
  destination?: { x: number; y: number },
): SimState {
  return queueResourceOrder(state, {
    labId,
    kind: 'accelerator',
    resourceId: skuId,
    quantity: count,
    maxUnitPrice,
    destination,
  })
}

export function dataOfferUnitPrice(state: SimState, offerId: string): number {
  const offer = state.dataMarket.offers.find((candidate) => candidate.id === offerId)
  return offer ? offer.cash / Math.max(1, offer.lotMTok) : 0
}

export function domainProcessingCost(domain: DataDomain, quantity: number): number {
  return DATA_DOMAIN_META[domain].processCostPerMTok * Math.max(0, quantity)
}

export interface CompetitiveCatchUpSnapshot {
  active: boolean
  rivalId: LabId | null
  playerShare: number
  rivalShare: number
  shareGap: number
  capabilityGap: number
  frontierStale: boolean
  frontierAgeDays: number
  frontierStaleAfterDays: number
}

/** Select exactly one credible challenger when the player becomes dominant. */
export function competitiveCatchUpSnapshot(state: SimState): CompetitiveCatchUpSnapshot {
  const playerShare =
    state.lastMarket.sharesByLab[state.playerLabId] ?? state.player.finance.totalShare ?? 0
  const playerFrontier = state.player.models
    .filter((model) => model.release === 'released' || model.shipped)
    .toSorted(
      (a, b) =>
        b.capability - a.capability || b.releaseDay - a.releaseDay || a.id.localeCompare(b.id),
    )[0]
  const playerCapability = playerFrontier?.capability ?? 0
  const frontierStaleAfterDays = playerFrontier
    ? 100 + (hashSeed(state.seed, playerFrontier.id, 'frontier-stale-window') % 51)
    : 150
  const frontierAgeDays = playerFrontier
    ? Math.max(0, state.day - playerFrontier.releaseDay)
    : 0
  const frontierStale =
    Boolean(playerFrontier) && frontierAgeDays >= frontierStaleAfterDays
  let target = state.rivals[0]
  let targetScore = Number.NEGATIVE_INFINITY
  let targetCapability = 0
  for (const rival of state.rivals) {
    const capability = rival.models.reduce(
      (best, model) =>
        Math.max(best, model.release === 'released' || model.shipped ? model.capability : 0),
      0,
    )
    const share = state.lastMarket.sharesByLab[rival.id] ?? rival.marketShare ?? 0
    const score = capability * 0.72 + share * 100 * 0.28
    if (score > targetScore) {
      target = rival
      targetScore = score
      targetCapability = capability
    }
  }
  const rivalShare = target
    ? state.lastMarket.sharesByLab[target.id] ?? target.marketShare ?? 0
    : 0
  const shareGap = Math.max(0, playerShare - rivalShare)
  const capabilityGap = Math.max(0, playerCapability - targetCapability)
  return {
    active:
      Boolean(target) &&
      ((playerShare >= 0.5 && (shareGap >= 0.25 || capabilityGap >= 8)) ||
        (frontierStale && targetCapability <= playerCapability)),
    rivalId: target?.id ?? null,
    playerShare,
    rivalShare,
    shareGap,
    capabilityGap,
    frontierStale,
    frontierAgeDays,
    frontierStaleAfterDays,
  }
}

/** Rival controllers express strategy only through the same public market actions. */
export function queueRivalMarketOrders(state: SimState): SimState {
  let next = state
  const competitiveResponse = competitiveCatchUpSnapshot(state)
  for (let index = 0; index < state.rivals.length; index++) {
    const rivalId = state.rivals[index]!.id
    let lab = getLab(next, rivalId)
    const rng = createRng(hashSeed(next.seed, next.day, rivalId, 'market-policy'))
    const weekly = next.day % 7 === index % 7
    const isCatchUpChallenger =
      competitiveResponse.active && competitiveResponse.rivalId === rivalId

    const hasTypedDebt = (lab.capital?.debt ?? []).length > 0
    const lastRoundDay = Math.max(
      -Infinity,
      ...(lab.capital?.fundingRounds ?? []).map((round) => round.day),
    )
    if (
      weekly &&
      next.day >= 30 &&
      (lab.cash < 15_000_000 ||
        (isCatchUpChallenger &&
          lab.cash < Math.max(60_000_000, lab.finance.valuation * 0.12))) &&
      next.day - lastRoundDay >= (isCatchUpChallenger ? 75 : 120) &&
      (lab.capital?.investorConfidence ?? 0) >= 0.35
    ) {
      const offer = requestEquityOffers(next, rivalId)
        .filter(
          (candidate) =>
            candidate.confidenceRequired <= (lab.capital?.investorConfidence ?? 0),
        )
        .toSorted(
          (a, b) =>
            b.cashRaised - a.cashRaised ||
            a.investorOwnership - b.investorOwnership,
        )[0]
      if (offer) {
        next = acceptEquityOffer(next, offer, rivalId)
        lab = getLab(next, rivalId)
      }
    }
    if (
      weekly &&
      !hasTypedDebt &&
      lab.finance.valuation > 60_000_000 &&
      (lab.cash < 25_000_000 || isCatchUpChallenger)
    ) {
      const debtBefore = (lab.capital?.debt ?? []).length
      next = applyForLabDebt(
        next,
        rivalId,
        isCatchUpChallenger
          ? 'venture_debt'
          : lab.finance.dayRevenue > 0
            ? 'revolver'
            : 'venture_debt',
        Math.min(
          lab.finance.valuation * (isCatchUpChallenger ? 0.12 : 0.1),
          isCatchUpChallenger ? 120_000_000 : 40_000_000,
        ),
      )
      lab = getLab(next, rivalId)
      if (isCatchUpChallenger && (lab.capital?.debt ?? []).length > debtBefore) {
        next = addAlert(
          next,
          competitiveResponse.frontierStale
            ? `Frontier response: ${lab.name} secured growth debt for a catch-up train after ${competitiveResponse.frontierAgeDays} days without a new player frontier.`
            : `Competitive response: ${lab.name} secured growth debt and is prioritizing accelerator purchases to close a ${(competitiveResponse.shareGap * 100).toFixed(0)}-point share gap.`,
        )
        next = {
          ...next,
          news: [
            `Day ${next.day}: lenders back ${lab.name} as the lead challenger to ${state.player.name}.`,
            ...next.news,
          ].slice(0, 48),
        }
      }
    }

    const hasRackBid = next.worldMarkets.orders.some(
      (order) => order.labId === rivalId && order.kind === 'accelerator',
    )
    if (
      weekly &&
      !hasRackBid &&
      (lab.servicePain > 0.08 || lab.trainingJob || isCatchUpChallenger) &&
      lab.cash > 12_000_000
    ) {
      const skuId =
        lab.archetype === 'efficiency' || lab.servicePain > 0.2 ? 'rack_infer' : 'rack_h100'
      const supply = next.worldMarkets.accelerators[skuId]
      if (supply) {
        const destination = destinationForLab(next, rivalId) ?? undefined
        const count = Math.max(
          2,
          Math.min(
            isCatchUpChallenger ? 36 : 16,
            Math.floor(lab.cash / supply.reserveUnitPrice / (isCatchUpChallenger ? 5 : 8)),
          ),
        )
        next = queueAcceleratorBid(
          next,
          rivalId,
          skuId,
          count,
          supply.reserveUnitPrice * rng.range(1.01, 1.18),
          destination,
        )
      }
    }

    const processed = Object.values(lab.data.stocks).reduce((sum, stock) => sum + stock.processed, 0)
    const comfortableNeed = Math.max(1, (lab.models[0]?.paramsB ?? 1) * 6000)
    const hasDataBid = next.worldMarkets.orders.some(
      (order) => order.labId === rivalId && order.kind === 'data',
    )
    if (weekly && !hasDataBid && processed < comfortableNeed && lab.cash > 5_000_000) {
      const domain =
        lab.archetype === 'multimodal'
          ? 'image'
          : lab.archetype === 'safety'
            ? 'law'
            : lab.archetype === 'open_weights'
              ? 'code'
              : 'chat'
      const candidate = next.dataMarket.offers
        .filter((offer) => offer.mTokLeft > 0 && (offer.domain === domain || offer.quality >= 70))
        .sort(
          (a, b) =>
            b.quality / Math.max(1, b.cash / b.lotMTok) -
            a.quality / Math.max(1, a.cash / a.lotMTok),
        )[0]
      if (candidate) next = queueDataOfferOrder(next, rivalId, candidate.id)
    }
  }
  return next
}

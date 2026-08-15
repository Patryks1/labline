import type {
  FacilityAcquisitionOffer,
  FacilityMarketState,
  FacilityNavBreakdown,
  LabId,
  MapTile,
  RackDesign,
  RackInstall,
  SimState,
} from '../types'
import type { Facility } from '../world'
import { tileCoords } from '../world'
import { seededId } from '../rng'
import { isDcAnchor, isDcKind } from './map'
import { resolveRackSku } from './racks'
import { commitWorldBatch, facilityAnchorTiles, usesCompactWorld } from './worldAccess'
import {
  analyzeHallLayout,
  autoPlanHall,
  hallInfrastructureValue,
  rackUnitsForFacility,
  removeDataHallLayout,
  tickDataHallLayouts,
} from './dataHallLayouts'

export const TRANSFERABLE_SITE_POWER_VALUE_PER_MW = 30_000_000
export const FACILITY_OFFER_EXPIRY_DAYS = 7
export const UNSOLICITED_FACILITY_COUNTER_NAV_MULTIPLE = 1.5
export const UNSOLICITED_FACILITY_ACCEPT_NAV_MULTIPLE = 2.25

type Asset = {
  id: string
  ownerId: LabId
  x: number
  y: number
  tile: MapTile
  compact?: Facility
}

function market(state: SimState): FacilityMarketState {
  return state.facilityMarket ?? { offers: [] }
}

function facilityIdForLegacy(tile: MapTile): string {
  return tile.campusId ?? `facility:${tile.x},${tile.y}`
}

function findAsset(state: SimState, facilityId: string): Asset | undefined {
  if (usesCompactWorld(state)) {
    const facility = state.map.world!.facilitiesById.get(facilityId)
    if (!facility || !isDcKind(facility.kind)) return undefined
    const { x, y } = tileCoords(facility.anchor, state.map.world!.descriptor.width)
    const tile = facilityAnchorTiles(state).find((candidate) => candidate.campusId === facilityId)
    return tile ? { id: facilityId, ownerId: facility.ownerId, x, y, tile, compact: facility } : undefined
  }
  const tile = facilityAnchorTiles(state).find(
    (candidate) => facilityIdForLegacy(candidate) === facilityId,
  )
  if (!tile || !isDcKind(tile.kind) || !isDcAnchor(tile)) return undefined
  return { id: facilityId, ownerId: tile.owner, x: tile.x, y: tile.y, tile }
}

export function dataCenterFacilityIds(state: SimState, ownerId?: LabId): string[] {
  return facilityAnchorTiles(state, ownerId ? { ownerId } : {})
    .filter((tile) => isDcKind(tile.kind) && isDcAnchor(tile))
    .map((tile) => facilityIdForLegacy(tile))
    .sort()
}

function labFleet(state: SimState, labId: LabId): RackInstall[] {
  if (labId === state.playerLabId) return state.player.rackFleet ?? []
  return state.rivals.find((rival) => rival.id === labId)?.rackFleet ?? state.labs[labId]?.rackFleet ?? []
}

function labDesigns(state: SimState, labId: LabId): RackDesign[] {
  if (labId === state.playerLabId) return state.player.rackDesigns ?? []
  return state.rivals.find((rival) => rival.id === labId)?.rackDesigns ?? state.labs[labId]?.rackDesigns ?? []
}

function rackMarketValue(state: SimState, asset: Asset): number {
  const designs = labDesigns(state, asset.ownerId)
  return labFleet(state, asset.ownerId)
    .filter((rack) => rack.status === 'live' && rack.x === asset.x && rack.y === asset.y)
    .reduce((sum, rack) => {
      let rate = 0.58
      try { rate = resolveRackSku(rack.skuId, designs).sellBackRate } catch { /* old/custom SKU */ }
      return sum + Math.max(0, rack.paidEach) * Math.max(0, rack.count) * rate
    }, 0)
}

function attachedPowerMw(state: SimState, facilityId: string): number {
  return (state.siteCapacities ?? []).reduce(
    (sum, site) => sum + (site.facilityId === facilityId && site.status === 'active' ? Math.max(0, site.firmMw) : 0),
    0,
  )
}

function committedRackPowerMw(state: SimState, asset: Asset): number {
  const designs = labDesigns(state, asset.ownerId)
  const itDraw = labFleet(state, asset.ownerId)
    .filter((rack) => rack.status === 'live' && rack.x === asset.x && rack.y === asset.y)
    .reduce((sum, rack) => {
      try {
        return sum + resolveRackSku(rack.skuId, designs).mw * Math.max(0, rack.count)
      } catch {
        return sum
      }
    }, 0)
  const pue = asset.ownerId === state.playerLabId
    ? state.player.pue
    : state.rivals.find((rival) => rival.id === asset.ownerId)?.pue ?? state.labs[asset.ownerId]?.pue ?? 1
  return itDraw * Math.max(1, pue || 1)
}

/** Neutral infrastructure NAV. Racks are physical live installs, never inferred PF. */
export function facilityNav(state: SimState, facilityId: string): FacilityNavBreakdown {
  const asset = findAsset(state, facilityId)
  if (!asset) return { land: 0, shell: 0, racks: 0, sitePower: 0, total: 0 }
  const compactData = (asset.compact?.data ?? {}) as Record<string, unknown>
  let land = 0
  if (asset.compact) {
    land = Math.max(0, Number(compactData.landValue) || 0)
    if (land === 0) land = Math.max(0, asset.tile.capex) * 0.12
  } else {
    const footprint = asset.tile.campusId
      ? state.map.tiles.filter((tile) => tile.campusId === asset.tile.campusId)
      : [asset.tile]
    land = footprint.reduce((sum, tile) => sum + Math.max(0, tile.landValue ?? 0), 0)
    if (land === 0) land = Math.max(0, asset.tile.capex) * 0.12
  }
  const rawCommissionedDay = Number(compactData.commissionedDay)
  const commissionedDay = Number.isFinite(rawCommissionedDay)
    ? Math.max(0, rawCommissionedDay)
    : state.day
  const ageDays = Math.max(0, state.day - commissionedDay)
  const shellFactor = Math.max(0.35, 0.72 - ageDays * (0.37 / (12 * 365)))
  const shell = Math.max(0, asset.tile.capex) * shellFactor + hallInfrastructureValue(state.dataHallLayouts?.[facilityId])
  const racks = rackMarketValue(state, asset)
  const linkedPowerMw = attachedPowerMw(state, facilityId)
  const sitePower = (linkedPowerMw > 0 ? linkedPowerMw : committedRackPowerMw(state, asset)) * TRANSFERABLE_SITE_POWER_VALUE_PER_MW
  const rounded = { land, shell, racks, sitePower }
  return { ...rounded, total: land + shell + racks + sitePower }
}

/** Stable public ask in the deliberately expensive 1.5–1.9x NAV band. */
export function publicFacilityAsk(state: SimState, facilityId: string): number {
  const nav = facilityNav(state, facilityId).total
  const seed = [...facilityId].reduce((sum, char) => (sum * 33 + char.charCodeAt(0)) >>> 0, state.seed >>> 0)
  return Math.round(nav * (1.5 + (seed % 401) / 1000))
}

function cashOf(state: SimState, labId: LabId): number {
  if (labId === state.playerLabId) return state.player.cash
  return state.rivals.find((rival) => rival.id === labId)?.cash ?? state.labs[labId]?.cash ?? 0
}

function withLabCash(state: SimState, labId: LabId, cash: number): SimState {
  const labs = state.labs[labId]
    ? { ...state.labs, [labId]: { ...state.labs[labId]!, cash, finance: { ...state.labs[labId]!.finance, cash } } }
    : state.labs
  if (labId === state.playerLabId) return { ...state, labs, player: { ...state.player, cash, finance: { ...state.player.finance, cash } } }
  return {
    ...state,
    labs,
    rivals: state.rivals.map((rival) => rival.id === labId
      ? { ...rival, cash, finance: rival.finance ? { ...rival.finance, cash } : rival.finance }
      : rival),
  }
}

function responseDelay(state: SimState, offerId: string): number {
  let hash = state.seed ^ state.day
  for (const char of offerId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return 1 + (Math.abs(hash) % 3)
}

/** Submit an unsolicited or listed offer; the entire price enters escrow. */
export function submitFacilityOffer(
  state: SimState,
  facilityId: string,
  buyerLabId: LabId,
  amount: number,
): SimState {
  const asset = findAsset(state, facilityId)
  const price = Math.floor(amount)
  if (!asset || asset.ownerId === buyerLabId || price <= 0 || cashOf(state, buyerLabId) < price) return state
  if (market(state).offers.some((offer) => offer.facilityId === facilityId && offer.buyerLabId === buyerLabId && (offer.status === 'pending' || offer.status === 'countered'))) return state
  const id = seededId('facility-offer', state.seed, state.day, facilityId, buyerLabId, price)
  const offer: FacilityAcquisitionOffer = {
    id,
    facilityId,
    buyerLabId,
    sellerLabId: asset.ownerId,
    amount: price,
    escrow: price,
    submittedDay: state.day,
    respondDay: state.day + responseDelay(state, id),
    expiresDay: state.day + FACILITY_OFFER_EXPIRY_DAYS,
    status: 'pending',
  }
  const next = withLabCash(state, buyerLabId, cashOf(state, buyerLabId) - price)
  const submitted = { ...next, facilityMarket: { offers: [...market(state).offers, offer] } }
  return asset.tile.forSale && (asset.tile.listPrice ?? 0) > 0 && price >= asset.tile.listPrice!
    ? acceptFacilityOffer(submitted, id)
    : submitted
}

function releaseEscrow(state: SimState, offer: FacilityAcquisitionOffer): SimState {
  return offer.escrow > 0
    ? withLabCash(state, offer.buyerLabId, cashOf(state, offer.buyerLabId) + offer.escrow)
    : state
}

function resolveOffer(state: SimState, offerId: string, status: 'rejected' | 'withdrawn'): SimState {
  const offer = market(state).offers.find((candidate) => candidate.id === offerId)
  if (!offer || (offer.status !== 'pending' && offer.status !== 'countered')) return state
  const refunded = releaseEscrow(state, offer)
  return { ...refunded, facilityMarket: { offers: market(refunded).offers.map((candidate) => candidate.id === offerId ? { ...candidate, status, escrow: 0, resolvedDay: state.day } : candidate) } }
}

export const rejectFacilityOffer = (state: SimState, offerId: string) => resolveOffer(state, offerId, 'rejected')
export const withdrawFacilityOffer = (state: SimState, offerId: string) => resolveOffer(state, offerId, 'withdrawn')

export function counterFacilityOffer(state: SimState, offerId: string, amount: number): SimState {
  const price = Math.floor(amount)
  if (price <= 0) return state
  return { ...state, facilityMarket: { offers: market(state).offers.map((offer) => offer.id === offerId && offer.status === 'pending' ? { ...offer, status: 'countered', counterAmount: price } : offer) } }
}

function cancelledOrders(state: SimState, labId: LabId, x: number, y: number): SimState {
  const pending = labFleet(state, labId).filter((rack) => rack.status === 'ordered' && rack.x === x && rack.y === y)
  const refund = pending.reduce((sum, rack) => sum + rack.paidEach * rack.count * 0.85, 0)
  let next = setFleet(state, labId, labFleet(state, labId).filter((rack) => !(rack.status === 'ordered' && rack.x === x && rack.y === y)))
  if (refund > 0) next = withLabCash(next, labId, cashOf(next, labId) + refund)
  const cancelledMarketOrders = next.worldMarkets.orders.filter(
    (order) =>
      order.kind === 'accelerator' &&
      order.labId === labId &&
      order.destination?.x === x &&
      order.destination?.y === y,
  )
  const reservedRefund = cancelledMarketOrders.reduce(
    (sum, order) => sum + Math.max(0, order.cashReserved),
    0,
  )
  if (reservedRefund > 0) next = withLabCash(next, labId, cashOf(next, labId) + reservedRefund)
  const cancelledIds = new Set(cancelledMarketOrders.map((order) => order.id))
  return {
    ...next,
    worldMarkets: {
      ...next.worldMarkets,
      orders: next.worldMarkets.orders.filter((order) => !cancelledIds.has(order.id)),
    },
  }
}

function setFleet(state: SimState, labId: LabId, rackFleet: RackInstall[], rackDesigns?: RackDesign[]): SimState {
  const labs = state.labs[labId]
    ? { ...state.labs, [labId]: { ...state.labs[labId]!, rackFleet, ...(rackDesigns ? { rackDesigns } : {}) } }
    : state.labs
  if (labId === state.playerLabId) return { ...state, labs, player: { ...state.player, rackFleet, ...(rackDesigns ? { rackDesigns } : {}) } }
  return { ...state, labs, rivals: state.rivals.map((rival) => rival.id === labId ? { ...rival, rackFleet, ...(rackDesigns ? { rackDesigns } : {}) } : rival) }
}

function transferredRackAssets(
  buyerDesigns: RackDesign[],
  sourceDesigns: RackDesign[],
  racks: RackInstall[],
  sellerLabId: LabId,
  facilityId: string,
): { racks: RackInstall[]; designs: RackDesign[] } {
  const designs = [...buyerDesigns]
  const remappedIds = new Map<string, string>()
  for (const source of sourceDesigns) {
    const sourceSkuId = `design:${source.id}`
    if (!racks.some((rack) => rack.skuId === sourceSkuId)) continue
    const existing = designs.find((design) => design.id === source.id)
    if (!existing) {
      designs.push(source)
      continue
    }
    if (JSON.stringify(existing) === JSON.stringify(source)) continue

    const base = `${source.id}-${sellerLabId}-${facilityId}`.replace(/[^a-zA-Z0-9_-]/g, '-')
    let id = base
    let suffix = 2
    while (designs.some((design) => design.id === id)) id = `${base}-${suffix++}`
    remappedIds.set(sourceSkuId, `design:${id}`)
    designs.push({ ...source, id })
  }
  return {
    racks: racks.map((rack) => {
      const skuId = remappedIds.get(rack.skuId)
      return skuId ? { ...rack, skuId } : rack
    }),
    designs,
  }
}

function reconcileTransferredHallRacks(
  state: SimState,
  facilityId: string,
  buyerLabId: LabId,
  rackCapacity: number,
): SimState {
  const layout = state.dataHallLayouts?.[facilityId]
  if (!layout || layout.constructionProject) return state
  const inventory = rackUnitsForFacility(state, facilityId, buyerLabId)
  const planned = autoPlanHall(
    layout,
    inventory,
    layout.preferredStrategy,
    rackCapacity,
    { provisionUtilities: false },
  )
  const reconciled = { ...planned, revision: layout.revision + 1 }
  reconciled.analysis = analyzeHallLayout(reconciled, inventory, rackCapacity)
  return {
    ...state,
    dataHallLayouts: {
      ...(state.dataHallLayouts ?? {}),
      [facilityId]: reconciled,
    },
  }
}

function transferAsset(state: SimState, offer: FacilityAcquisitionOffer, price: number): SimState {
  const asset = findAsset(state, offer.facilityId)
  if (!asset || asset.ownerId !== offer.sellerLabId) return releaseEscrow(state, offer)
  let next = cancelledOrders(state, offer.sellerLabId, asset.x, asset.y)
  const sourceFleet = labFleet(next, offer.sellerLabId)
  const physical = sourceFleet.filter((rack) => rack.status === 'live' && rack.x === asset.x && rack.y === asset.y)
  next = setFleet(next, offer.sellerLabId, sourceFleet.filter((rack) => !physical.includes(rack)))
  const transferred = transferredRackAssets(
    labDesigns(next, offer.buyerLabId),
    labDesigns(next, offer.sellerLabId),
    physical,
    offer.sellerLabId,
    offer.facilityId,
  )
  next = setFleet(
    next,
    offer.buyerLabId,
    [
      ...labFleet(next, offer.buyerLabId),
      ...transferred.racks.map((rack) => ({ ...rack, facilityId: offer.facilityId })),
    ],
    transferred.designs,
  )
  if (usesCompactWorld(next)) {
    next = commitWorldBatch(next, next.map.world!.beginBatch().updateFacility(asset.id, { ownerId: offer.buyerLabId, forSale: false, listPrice: undefined }))
  } else {
    const tiles = next.map.tiles.map((tile) => facilityIdForLegacy(tile) === asset.id ? { ...tile, owner: offer.buyerLabId, forSale: false, listPrice: undefined } : tile)
    next = { ...next, map: { ...next.map, tiles } }
  }
  next = { ...next, siteCapacities: next.siteCapacities.map((site) => site.facilityId === asset.id ? { ...site, labId: offer.buyerLabId } : site) }
  // The racks sold with the hall are already installed physical assets, not a
  // new fit-out. Rebind their identities to the transferred live layout while
  // preserving its existing utility equipment; never synthesize a free top-up.
  next = reconcileTransferredHallRacks(
    next,
    asset.id,
    offer.buyerLabId,
    asset.tile.rackCapacity,
  )
  next = withLabCash(next, offer.sellerLabId, cashOf(next, offer.sellerLabId) + price)
  return tickDataHallLayouts(next)
}

export function acceptFacilityOffer(state: SimState, offerId: string): SimState {
  const offer = market(state).offers.find((candidate) => candidate.id === offerId)
  if (!offer || (offer.status !== 'pending' && offer.status !== 'countered')) return state
  const asset = findAsset(state, offer.facilityId)
  if (!asset || asset.ownerId !== offer.sellerLabId) return rejectFacilityOffer(state, offer.id)
  const price = offer.counterAmount ?? offer.amount
  const extra = price - offer.escrow
  if (extra > 0 && cashOf(state, offer.buyerLabId) < extra) return state
  let funded = extra > 0 ? withLabCash(state, offer.buyerLabId, cashOf(state, offer.buyerLabId) - extra) : state
  if (extra < 0) funded = withLabCash(funded, offer.buyerLabId, cashOf(funded, offer.buyerLabId) - extra)
  const paid = transferAsset(funded, { ...offer, escrow: price }, price)
  return { ...paid, facilityMarket: { offers: market(paid).offers.map((candidate) => candidate.id === offerId ? { ...candidate, amount: price, escrow: 0, status: 'accepted', resolvedDay: state.day } : candidate) } }
}

export function tickFacilityMarket(state: SimState): SimState {
  let next = state
  for (const snapshot of market(next).offers) {
    const offer = market(next).offers.find((candidate) => candidate.id === snapshot.id)!
    if (offer.status !== 'pending' && offer.status !== 'countered') continue
    if (next.day >= offer.expiresDay) {
      const refunded = releaseEscrow(next, offer)
      next = { ...refunded, facilityMarket: { offers: market(refunded).offers.map((candidate) => candidate.id === offer.id ? { ...candidate, status: 'expired', escrow: 0, resolvedDay: next.day } : candidate) } }
      continue
    }
    if (offer.status === 'pending' && next.day >= offer.respondDay) {
      const asset = findAsset(next, offer.facilityId)
      if (!asset || asset.ownerId !== offer.sellerLabId) next = rejectFacilityOffer(next, offer.id)
      else {
        const nav = facilityNav(next, offer.facilityId).total
        if (asset.tile.forSale && (asset.tile.listPrice ?? 0) > 0) {
          if (offer.amount >= asset.tile.listPrice!) next = acceptFacilityOffer(next, offer.id)
          else next = counterFacilityOffer(next, offer.id, Math.floor(asset.tile.listPrice!))
        } else {
          const acceptAt = Math.round(nav * UNSOLICITED_FACILITY_ACCEPT_NAV_MULTIPLE)
          if (offer.amount >= acceptAt) next = acceptFacilityOffer(next, offer.id)
          else if (offer.amount >= nav * UNSOLICITED_FACILITY_COUNTER_NAV_MULTIPLE) {
            next = counterFacilityOffer(next, offer.id, acceptAt)
          } else next = rejectFacilityOffer(next, offer.id)
        }
      }
    }
  }
  return next
}

export function listFacilityForSale(state: SimState, facilityId: string): SimState {
  const asset = findAsset(state, facilityId)
  if (!asset) return state
  const listPrice = publicFacilityAsk(state, facilityId)
  if (usesCompactWorld(state)) return commitWorldBatch(state, state.map.world!.beginBatch().updateFacility(facilityId, { forSale: true, listPrice }))
  return { ...state, map: { ...state.map, tiles: state.map.tiles.map((tile) => facilityIdForLegacy(tile) === facilityId ? { ...tile, forSale: true, listPrice } : tile) } }
}

export function quoteFacilitySale(state: SimState, facilityId: string): number {
  return Math.floor(facilityNav(state, facilityId).total * 0.9)
}

export function quoteFacilityDemolition(state: SimState, facilityId: string): number {
  const asset = findAsset(state, facilityId)
  return asset ? Math.floor(Math.max(250_000, asset.tile.capex * 0.025)) : 0
}

/** Demolition is intentionally distinct from a sale: it costs cash and yields no NAV. */
export function demolishFacility(state: SimState, facilityId: string, ownerLabId: LabId): SimState {
  const asset = findAsset(state, facilityId)
  const cost = quoteFacilityDemolition(state, facilityId)
  if (!asset || asset.ownerId !== ownerLabId || cashOf(state, ownerLabId) < cost) return state
  let next = cancelledOrders(state, ownerLabId, asset.x, asset.y)
  next = setFleet(next, ownerLabId, labFleet(next, ownerLabId).filter((rack) => !(rack.x === asset.x && rack.y === asset.y)))
  next = withLabCash(next, ownerLabId, cashOf(next, ownerLabId) - cost)
  if (usesCompactWorld(next)) next = commitWorldBatch(next, next.map.world!.beginBatch().removeFacility(facilityId))
  else next = { ...next, map: { ...next.map, tiles: next.map.tiles.map((tile) => facilityIdForLegacy(tile) === facilityId ? { ...tile, kind: 'empty', owner: 'neutral', campusId: undefined, campusRole: undefined, rackCapacity: 0, racksUsed: 0, mwCapacity: 0, mwGeneration: 0, capex: 0, opexPerDay: 0, buildingProgress: 0, buildingTarget: 0, name: '', note: '' } : tile) } }
  return removeDataHallLayout({ ...next, siteCapacities: next.siteCapacities.filter((site) => site.facilityId !== facilityId) }, facilityId)
}

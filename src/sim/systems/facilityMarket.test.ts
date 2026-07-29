import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { RackDesign, RackInstall, SimState } from '../types'
import { tileCoords } from '../world'
import {
  buyRivalDataCenter,
  estimateBuildingSaleValue,
  sellPlayerBuilding,
} from './facilities'
import { resolveRackSku } from './racks'
import {
  FACILITY_OFFER_EXPIRY_DAYS,
  TRANSFERABLE_SITE_POWER_VALUE_PER_MW,
  UNSOLICITED_FACILITY_ACCEPT_NAV_MULTIPLE,
  UNSOLICITED_FACILITY_COUNTER_NAV_MULTIPLE,
  acceptFacilityOffer,
  facilityNav,
  publicFacilityAsk,
  quoteFacilitySale,
  submitFacilityOffer,
  tickFacilityMarket,
  withdrawFacilityOffer,
} from './facilityMarket'

function game(legacyMapFixture = false): SimState {
  return createGame({
    seed: 811,
    labName: 'Buyer',
    difficulty: 'easy',
    legacyMapFixture,
    advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
  })
}

function rack(x: number, y: number): RackInstall {
  return { id: 'physical-rack', skuId: 'rack_h100', x, y, count: 4, rackUnits: 1, status: 'live', daysLeft: 0, paidEach: 1_000_000 }
}

describe('facility market', () => {
  it('values compact infrastructure and transfers its exact physical contents atomically', () => {
    let state = game()
    const rival = state.rivals[0]!
    const facility = state.map.world!.queryFacilities({ ownerId: rival.id, kind: 'dc' })[0]!
    const { x, y } = tileCoords(facility.anchor, state.map.width)
    state = {
      ...state,
      rivals: state.rivals.map((entry) => entry.id === rival.id ? { ...entry, rackFleet: [rack(x, y)] } : entry),
      labs: { ...state.labs, [rival.id]: { ...state.labs[rival.id]!, rackFleet: [rack(x, y)] } },
      siteCapacities: [{ id: 'power', projectId: 'power', labId: rival.id, route: 'owned', regionId: rival.regionId, siteMw: 3, firmMw: 3, commissionedDay: 1, status: 'active', facilityId: facility.id }],
    }
    state.map.world!.beginBatch().updateFacility(facility.id, {
      stats: { ...facility.stats, capex: 100_000_000 },
      data: { ...facility.data, landValue: 20_000_000, commissionedDay: state.day },
    }).commit()

    const nav = facilityNav(state, facility.id)
    expect(nav.land).toBe(20_000_000)
    expect(nav.shell).toBe(72_000_000)
    expect(nav.racks).toBeGreaterThan(0)
    expect(nav.sitePower).toBe(3 * TRANSFERABLE_SITE_POWER_VALUE_PER_MW)
    expect(publicFacilityAsk(state, facility.id) / nav.total).toBeGreaterThanOrEqual(1.5)
    expect(publicFacilityAsk(state, facility.id) / nav.total).toBeLessThanOrEqual(1.9)

    const price = Math.ceil(nav.total * UNSOLICITED_FACILITY_ACCEPT_NAV_MULTIPLE)
    state = {
      ...state,
      player: { ...state.player, cash: price + 50_000_000 },
      labs: { ...state.labs, [state.playerLabId]: { ...state.labs[state.playerLabId]!, cash: price + 50_000_000 } },
    }
    const totalCash = state.player.cash + rival.cash
    const buyerCash = state.player.cash
    state = submitFacilityOffer(state, facility.id, state.playerLabId, price)
    const offer = state.facilityMarket!.offers[0]!
    expect(state.player.cash).toBe(buyerCash - price)
    state = tickFacilityMarket({ ...state, day: offer.respondDay })
    expect(state.facilityMarket!.offers[0]!.status).toBe('accepted')
    expect(state.map.world!.facilitiesById.get(facility.id)!.ownerId).toBe(state.playerLabId)
    expect(state.player.rackFleet).toContainEqual(expect.objectContaining(rack(x, y)))
    expect(state.player.rackFleet[0]!.unitIds).toHaveLength(4)
    expect(state.dataHallLayouts?.[facility.id]?.objects.filter((object) => object.kind === 'rack')).toHaveLength(4)
    expect(state.rivals[0]!.rackFleet).toEqual([])
    expect(state.siteCapacities[0]!.labId).toBe(state.playerLabId)
    expect(state.player.cash + state.rivals[0]!.cash).toBe(totalCash)
  })

  it('keeps legacy campus IDs, NAV, escrow withdrawal, and expiry save-compatible', () => {
    let state = game(true)
    const rival = state.rivals[0]!
    const base = state.map.tiles.find((tile) => tile.kind === 'empty')!
    const id = 'neutral-campus-id'
    state = {
      ...state,
      map: { ...state.map, tiles: state.map.tiles.map((tile) => tile === base ? { ...tile, kind: 'dc', owner: rival.id, campusId: id, campusRole: 'anchor', buildingProgress: 1, buildingTarget: 1, capex: 100_000_000, landValue: 20_000_000, rackCapacity: 16, racksUsed: 4 } : tile) },
      rivals: state.rivals.map((entry) => entry.id === rival.id ? { ...entry, rackFleet: [rack(base.x, base.y)] } : entry),
      siteCapacities: [{ id: 'power', projectId: 'power', labId: rival.id, route: 'owned', regionId: rival.regionId, siteMw: 3, firmMw: 3, commissionedDay: 1, status: 'active', facilityId: id }],
    }
    const nav = facilityNav(state, id)
    expect(nav.land).toBe(20_000_000)
    expect(nav.shell).toBe(72_000_000)
    expect(nav.sitePower).toBe(90_000_000)

    const before = state.player.cash
    const totalBefore = state.player.cash + rival.cash
    state = submitFacilityOffer(state, id, state.playerLabId, 10_000_000)
    const offer = state.facilityMarket!.offers[0]!
    expect(state.player.cash + rival.cash + offer.escrow).toBe(totalBefore)
    expect(offer.expiresDay - offer.submittedDay).toBe(FACILITY_OFFER_EXPIRY_DAYS)
    state = withdrawFacilityOffer(state, offer.id)
    expect(state.player.cash).toBe(before)
    expect(state.player.cash + state.rivals[0]!.cash).toBe(totalBefore)
    expect(state.facilityMarket!.offers[0]!.status).toBe('withdrawn')

    state = submitFacilityOffer(state, id, state.playerLabId, 11_000_000)
    const expiring = state.facilityMarket!.offers.at(-1)!
    state = tickFacilityMarket({ ...state, day: expiring.expiresDay })
    expect(state.facilityMarket!.offers.at(-1)!.status).toBe('expired')
    expect(state.player.cash).toBe(before)
  })

  it('requires full funding for a counter before accepting it', () => {
    let state = game()
    const rival = state.rivals[0]!
    const facility = state.map.world!.queryFacilities({ ownerId: rival.id, kind: 'dc' })[0]!
    state = submitFacilityOffer(state, facility.id, state.playerLabId, 1_000_000)
    const offer = state.facilityMarket!.offers[0]!
    state.facilityMarket!.offers[0] = { ...offer, status: 'countered', counterAmount: state.player.cash + offer.escrow + 1 }
    expect(acceptFacilityOffer(state, offer.id)).toBe(state)
  })

  it('settles a publicly listed hall immediately at its exact list price', () => {
    let state = game()
    const rival = state.rivals[0]!
    const facility = state.map.world!.queryFacilities({ ownerId: rival.id, kind: 'dc' })[0]!
    const { x, y } = tileCoords(facility.anchor, state.map.width)
    const listPrice = 12_345_678
    state.map.world!.beginBatch().updateFacility(facility.id, { forSale: true, listPrice }).commit()
    state = {
      ...state,
      player: { ...state.player, cash: listPrice + 1_000_000 },
      labs: { ...state.labs, [state.playerLabId]: { ...state.labs[state.playerLabId]!, cash: listPrice + 1_000_000 } },
    }

    state = buyRivalDataCenter(state, x, y)

    expect(state.map.world!.facilitiesById.get(facility.id)!.ownerId).toBe(state.playerLabId)
    expect(state.facilityMarket!.offers.at(-1)).toMatchObject({
      amount: listPrice,
      escrow: 0,
      status: 'accepted',
    })
    expect(state.player.cash).toBe(1_000_000)
  })

  it('settles a direct listed-price submission synchronously', () => {
    let state = game()
    const rival = state.rivals[0]!
    const facility = state.map.world!.queryFacilities({ ownerId: rival.id, kind: 'dc' })[0]!
    const listPrice = 14_000_000
    state.map.world!.beginBatch().updateFacility(facility.id, { forSale: true, listPrice }).commit()
    state = {
      ...state,
      player: { ...state.player, cash: listPrice + 5 },
      labs: { ...state.labs, [state.playerLabId]: { ...state.labs[state.playerLabId]!, cash: listPrice + 5 } },
    }

    state = submitFacilityOffer(state, facility.id, state.playerLabId, listPrice)

    expect(state.facilityMarket!.offers.at(-1)).toMatchObject({ status: 'accepted', escrow: 0 })
    expect(state.map.world!.facilitiesById.get(facility.id)!.ownerId).toBe(state.playerLabId)
    expect(state.player.cash).toBe(5)
  })

  it('rejects, counters, and accepts unsolicited bids at the NAV premium boundaries', () => {
    const setup = () => {
      let state = game()
      const rival = state.rivals[0]!
      const facility = state.map.world!.queryFacilities({ ownerId: rival.id, kind: 'dc' })[0]!
      state.map.world!.beginBatch().updateFacility(facility.id, {
        forSale: false,
        listPrice: undefined,
        stats: { ...facility.stats, capex: 100_000_000 },
        data: { ...facility.data, landValue: 20_000_000, commissionedDay: state.day },
      }).commit()
      state = {
        ...state,
        player: { ...state.player, cash: 1_000_000_000 },
        labs: {
          ...state.labs,
          [state.playerLabId]: { ...state.labs[state.playerLabId]!, cash: 1_000_000_000 },
        },
      }
      return { state, facility }
    }

    let low = setup()
    const lowNav = facilityNav(low.state, low.facility.id).total
    low.state = submitFacilityOffer(
      low.state,
      low.facility.id,
      low.state.playerLabId,
      Math.floor(lowNav * (UNSOLICITED_FACILITY_COUNTER_NAV_MULTIPLE - 0.01)),
    )
    low.state = tickFacilityMarket({ ...low.state, day: low.state.facilityMarket!.offers.at(-1)!.respondDay })
    expect(low.state.facilityMarket!.offers.at(-1)!.status).toBe('rejected')

    let middle = setup()
    const middleNav = facilityNav(middle.state, middle.facility.id).total
    middle.state = submitFacilityOffer(
      middle.state,
      middle.facility.id,
      middle.state.playerLabId,
      Math.ceil(middleNav * (UNSOLICITED_FACILITY_COUNTER_NAV_MULTIPLE + 0.01)),
    )
    middle.state = tickFacilityMarket({ ...middle.state, day: middle.state.facilityMarket!.offers.at(-1)!.respondDay })
    const responseDayNav = facilityNav(middle.state, middle.facility.id).total
    expect(middle.state.facilityMarket!.offers.at(-1)).toMatchObject({
      status: 'countered',
      counterAmount: Math.round(responseDayNav * UNSOLICITED_FACILITY_ACCEPT_NAV_MULTIPLE),
    })

    let high = setup()
    const highNav = facilityNav(high.state, high.facility.id).total
    high.state = submitFacilityOffer(
      high.state,
      high.facility.id,
      high.state.playerLabId,
      Math.ceil(highNav * (UNSOLICITED_FACILITY_ACCEPT_NAV_MULTIPLE + 0.01)),
    )
    high.state = tickFacilityMarket({ ...high.state, day: high.state.facilityMarket!.offers.at(-1)!.respondDay })
    expect(high.state.facilityMarket!.offers.at(-1)!.status).toBe('accepted')
  })

  it('treats commissioned day zero as a real age anchor', () => {
    let state = { ...game(), day: 365 }
    const rival = state.rivals[0]!
    const facility = state.map.world!.queryFacilities({ ownerId: rival.id, kind: 'dc' })[0]!
    state.map.world!.beginBatch().updateFacility(facility.id, {
      stats: { ...facility.stats, capex: 100_000_000 },
      data: { ...facility.data, commissionedDay: 0 },
    }).commit()

    const expectedFactor = 0.72 - 365 * (0.37 / (12 * 365))
    expect(facilityNav(state, facility.id).shell).toBeCloseTo(100_000_000 * expectedFactor)
  })

  it('uses the completed DC NAV sale quote for both preview and settlement', () => {
    let state = game()
    const rival = state.rivals[0]!
    const facility = state.map.world!.queryFacilities({ ownerId: rival.id, kind: 'dc' })[0]!
    const { x, y } = tileCoords(facility.anchor, state.map.width)
    state.map.world!.beginBatch().updateFacility(facility.id, {
      ownerId: state.playerLabId,
      stats: { ...facility.stats, capex: 100_000_000 },
      data: { ...facility.data, landValue: 20_000_000, commissionedDay: state.day },
    }).commit()
    state = {
      ...state,
      player: { ...state.player, rackFleet: [rack(x, y)] },
      labs: { ...state.labs, [state.playerLabId]: { ...state.labs[state.playerLabId]!, rackFleet: [rack(x, y)] } },
      siteCapacities: [{
        id: 'sale-power',
        projectId: 'sale-power',
        labId: state.playerLabId,
        route: 'owned',
        regionId: state.labs[state.playerLabId]!.regionId,
        siteMw: 2,
        firmMw: 2,
        commissionedDay: state.day,
        status: 'active',
        facilityId: facility.id,
      }],
    }
    const quote = quoteFacilitySale(state, facility.id)
    const cashBefore = state.player.cash

    expect(estimateBuildingSaleValue(state, x, y)).toBe(quote)
    state = sellPlayerBuilding(state, x, y)
    expect(state.player.cash).toBe(cashBefore + quote)
    expect(state.map.world!.facilitiesById.has(facility.id)).toBe(false)
    expect(state.siteCapacities).toEqual([])
    expect(state.dataHallLayouts?.[facility.id]).toBeUndefined()
  })

  it('remaps a transferred custom SKU when buyer and seller design IDs collide', () => {
    let state = game()
    const rival = state.rivals[0]!
    const facility = state.map.world!.queryFacilities({ ownerId: rival.id, kind: 'dc' })[0]!
    const { x, y } = tileCoords(facility.anchor, state.map.width)
    const buyerDesign: RackDesign = { id: 'shared', name: 'Buyer node', chassisId: 'case_8u', placements: [] }
    const sellerDesign: RackDesign = { id: 'shared', name: 'Seller node', chassisId: 'case_12u', placements: [] }
    const physical = { ...rack(x, y), skuId: 'design:shared' }
    state = {
      ...state,
      player: { ...state.player, rackDesigns: [buyerDesign] },
      rivals: state.rivals.map((entry) => entry.id === rival.id
        ? { ...entry, rackFleet: [physical], rackDesigns: [sellerDesign] }
        : entry),
      labs: {
        ...state.labs,
        [state.playerLabId]: { ...state.labs[state.playerLabId]!, rackDesigns: [buyerDesign] },
        [rival.id]: { ...state.labs[rival.id]!, rackFleet: [physical], rackDesigns: [sellerDesign] },
      },
    }

    state = submitFacilityOffer(state, facility.id, state.playerLabId, 1)
    state = acceptFacilityOffer(state, state.facilityMarket!.offers.at(-1)!.id)

    expect(state.player.rackDesigns).toHaveLength(2)
    const transferred = state.player.rackDesigns.find((design) => design.name === 'Seller node')!
    expect(transferred.id).not.toBe('shared')
    expect(state.player.rackFleet.find((entry) => entry.id === physical.id)?.skuId).toBe(`design:${transferred.id}`)
  })

  it('refunds a seller accelerator reservation when acquisition cancels its destination order', () => {
    let state = game()
    const rival = state.rivals[0]!
    const facility = state.map.world!.queryFacilities({ ownerId: rival.id, kind: 'dc' })[0]!
    const { x, y } = tileCoords(facility.anchor, state.map.width)
    const sellerCash = rival.cash
    const buyerCash = state.player.cash
    const reserved = 5_000_000
    state = {
      ...state,
      rivals: state.rivals.map((entry) => entry.id === rival.id ? { ...entry, cash: entry.cash - reserved } : entry),
      labs: { ...state.labs, [rival.id]: { ...state.labs[rival.id]!, cash: state.labs[rival.id]!.cash - reserved } },
      worldMarkets: {
        ...state.worldMarkets,
        orders: [{
          id: 'reserved-racks',
          labId: rival.id,
          kind: 'accelerator',
          resourceId: 'rack_h100',
          quantity: 4,
          maxUnitPrice: 1_250_000,
          quantityFilled: 0,
          cashReserved: reserved,
          submittedDay: state.day,
          expiresDay: state.day + 1,
          destination: { x, y },
        }],
      },
    }

    expect(state.player.cash + state.rivals[0]!.cash + reserved).toBe(buyerCash + sellerCash)

    state = submitFacilityOffer(state, facility.id, state.playerLabId, 1)
    state = acceptFacilityOffer(state, state.facilityMarket!.offers.at(-1)!.id)

    expect(state.worldMarkets.orders).toEqual([])
    expect(state.rivals[0]!.cash).toBe(sellerCash + 1)
    expect(state.player.cash + state.rivals[0]!.cash).toBe(buyerCash + sellerCash)
  })

  it('rejects and refunds an offer if ownership changes before counter acceptance', () => {
    let state = game()
    const rival = state.rivals[0]!
    const facility = state.map.world!.queryFacilities({ ownerId: rival.id, kind: 'dc' })[0]!
    const before = state.player.cash
    state = submitFacilityOffer(state, facility.id, state.playerLabId, 1_000_000)
    const offer = state.facilityMarket!.offers.at(-1)!
    state.facilityMarket!.offers[state.facilityMarket!.offers.length - 1] = {
      ...offer,
      status: 'countered',
      counterAmount: 2_000_000,
    }
    state.map.world!.beginBatch().updateFacility(facility.id, { ownerId: 'neutral' }).commit()

    state = acceptFacilityOffer(state, offer.id)

    expect(state.player.cash).toBe(before)
    expect(state.facilityMarket!.offers.at(-1)).toMatchObject({ status: 'rejected', escrow: 0 })
    expect(state.map.world!.facilitiesById.get(facility.id)!.ownerId).toBe('neutral')
  })

  it('values committed rack power through PUE when no linked site capacity exists', () => {
    let state = game()
    const rival = state.rivals[0]!
    const facility = state.map.world!.queryFacilities({ ownerId: rival.id, kind: 'dc' })[0]!
    const { x, y } = tileCoords(facility.anchor, state.map.width)
    const physical = rack(x, y)
    const pue = 1.4
    state = {
      ...state,
      rivals: state.rivals.map((entry) => entry.id === rival.id ? { ...entry, rackFleet: [physical], pue } : entry),
      labs: { ...state.labs, [rival.id]: { ...state.labs[rival.id]!, rackFleet: [physical], pue } },
      siteCapacities: [],
    }
    const expectedMw = resolveRackSku(physical.skuId).mw * physical.count * pue

    expect(facilityNav(state, facility.id).sitePower).toBeCloseTo(
      expectedMw * TRANSFERABLE_SITE_POWER_VALUE_PER_MW,
    )
  })
})

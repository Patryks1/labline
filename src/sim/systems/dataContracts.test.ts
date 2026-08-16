import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { roundTripState } from '../save'
import type { DataMarketOffer, SimState } from '../types'
import { generateDataMarketOffers } from '../balance/data'
import {
  acceptDataSupplierCounter,
  acceptDataSupplierOffer,
  buyAllFilteredDataLots,
  buyDataLotAmount,
  buyEntireDataLot,
  cancelDataSupplierContract,
  DATA_BULK_BUY_PREMIUM,
  DATA_CONCURRENT_CONTRACT_PREMIUM,
  DATA_MAX_CONTRACTS_PER_SUPPLIER,
  dataCancellationFee,
  dataOfferDelivery,
  dataSupplierContractPremium,
  evaluateSupplierOffer,
  listDataSupplierOffers,
  previewDataPurchase,
  proposeDataSupplierTerms,
  rejectDataSupplierCounter,
  supplierTermsFromOffer,
  tickDataSupplierContracts,
} from './dataContracts'
import { ensureLabData } from './data'

function game(seed = 881): SimState {
  const state = createGame({
    seed,
    labName: 'Contracts Lab',
    difficulty: 'easy',
    advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
  })
  return {
    ...state,
    player: { ...state.player, cash: 200_000_000 },
  }
}

function offer(
  partial: Partial<DataMarketOffer> &
    Pick<DataMarketOffer, 'id' | 'domain' | 'source'>,
): DataMarketOffer {
  return {
    name: partial.id,
    blurb: '',
    sellerKind: 'broker',
    sellerName: 'TokenBazaar',
    qualityBand: 'standard',
    quality: 55,
    mTokLeft: 100,
    mTokTotal: 100,
    lotMTok: 100,
    cash: 1_000_000,
    daysLeft: 5,
    ...partial,
  }
}

function withMarket(state: SimState, offers: DataMarketOffer[]): SimState {
  return {
    ...state,
    dataMarket: { offers, lastRefreshDay: state.day, nextRefreshDay: 999 },
  }
}

describe('data marketplace delivery states', () => {
  it('distinguishes instantly usable processed lots from raw scrape lots', () => {
    expect(dataOfferDelivery(offer({ id: 'a', domain: 'code', source: 'licensed' }))).toBe('processed')
    expect(dataOfferDelivery(offer({ id: 'b', domain: 'chat', source: 'web' }))).toBe('processed')
    expect(dataOfferDelivery(offer({ id: 'c', domain: 'chat', source: 'scrap' }))).toBe('raw')
  })

  it('processed purchases are immediately trainable and settle at once', () => {
    let state = withMarket(game(), [
      offer({ id: 'lot-code', domain: 'code', source: 'licensed' }),
    ])
    const before = ensureLabData(state).stocks.code
    const cashBefore = state.player.cash

    state = buyEntireDataLot(state, 'lot-code')
    const stock = ensureLabData(state).stocks.code

    expect(state.player.cash).toBeCloseTo(cashBefore - 1_000_000, 5)
    expect(stock.processed).toBeCloseTo(before.processed + 100, 8)
    expect(stock.fromBought).toBeCloseTo((before.fromBought ?? 0) + 100, 8)
    expect(state.dataMarket!.offers[0]!.mTokLeft).toBe(0)
    expect(
      state.player.data.assets.some(
        (asset) => asset.name === 'lot-code' && asset.rights === 'licensed',
      ),
    ).toBe(true)
  })

  it('raw purchases are owned but remain visibly queued for cleaning', () => {
    let state = withMarket(game(), [
      offer({
        id: 'lot-scrape',
        domain: 'chat',
        source: 'scrap',
        sellerKind: 'web_scrape',
        qualityBand: 'scrap',
        quality: 34,
        cash: 300_000,
      }),
    ])
    const rawBefore = ensureLabData(state).stocks.chat.raw

    state = buyEntireDataLot(state, 'lot-scrape')
    const data = ensureLabData(state)
    const job = data.processQueue.find(
      (candidate) => candidate.purchaseLot?.name === 'lot-scrape',
    )

    expect(job).toBeDefined()
    expect(job!.domain).toBe('chat')
    expect(job!.remaining).toBeCloseTo(100, 8)
    // The lot left raw stock only because it is queued — not train-ready yet.
    expect(data.stocks.chat.raw).toBeCloseTo(rawBefore, 8)
    expect(data.stocks.chat.fromBought ?? 0).toBe(0)
    expect(state.alerts[0]?.message).toContain('queued for cleaning')
  })

  it('buys a selected amount at the listing unit price', () => {
    let state = withMarket(game(), [
      offer({ id: 'lot-part', domain: 'math', source: 'licensed' }),
    ])
    const cashBefore = state.player.cash

    state = buyDataLotAmount(state, 'lot-part', 40)

    expect(state.player.cash).toBeCloseTo(cashBefore - 400_000, 5)
    expect(ensureLabData(state).stocks.math.fromBought).toBeCloseTo(40, 8)
    expect(state.dataMarket!.offers[0]!.mTokLeft).toBe(60)
  })

  it('handles zero, partial, full, and sold-out quantity actions exactly once', () => {
    let state = withMarket(game(), [
      offer({
        id: 'lot-quantity',
        domain: 'math',
        source: 'licensed',
        cash: 1_000_000,
        lotMTok: 100,
        mTokTotal: 100,
        mTokLeft: 80,
      }),
    ])
    const initialCash = state.player.cash

    state = buyDataLotAmount(state, 'lot-quantity', 0)
    expect(state.player.cash).toBe(initialCash)
    expect(state.dataMarket!.offers[0]!.mTokLeft).toBe(80)

    state = buyDataLotAmount(state, 'lot-quantity', 30)
    expect(state.player.cash).toBeCloseTo(initialCash - 300_000, 5)
    expect(state.dataMarket!.offers[0]!.mTokLeft).toBe(50)

    state = buyDataLotAmount(state, 'lot-quantity', 50)
    expect(state.player.cash).toBeCloseTo(initialCash - 800_000, 5)
    expect(state.dataMarket!.offers[0]!.mTokLeft).toBe(0)

    const soldOutCash = state.player.cash
    state = buyDataLotAmount(state, 'lot-quantity', 50)
    expect(state.player.cash).toBe(soldOutCash)
    expect(state.dataMarket!.offers[0]!.mTokLeft).toBe(0)
  })
})

describe('bulk buy-all', () => {
  const LOTS = [
    offer({ id: 'bulk-a', domain: 'code', source: 'licensed', cash: 1_000_000 }),
    offer({ id: 'bulk-b', domain: 'chat', source: 'web', sellerKind: 'opensource', cash: 600_000 }),
    offer({ id: 'bulk-c', domain: 'law', source: 'licensed', cash: 400_000, mTokLeft: 0 }),
  ]

  it('previews cost, volume, quality, licenses, contamination, and the premium', () => {
    const state = withMarket(game(), LOTS)
    const preview = previewDataPurchase(state, ['bulk-a', 'bulk-b', 'bulk-c'], { bulk: true })

    expect(preview.ok).toBe(true)
    expect(preview.lots).toBe(2)
    expect(preview.baseCost).toBe(1_600_000)
    expect(preview.bulkPremium).toBe(Math.round(1_600_000 * DATA_BULK_BUY_PREMIUM))
    expect(preview.totalCost).toBe(preview.baseCost + preview.bulkPremium)
    expect(preview.processedMTok).toBeCloseTo(200, 8)
    expect(preview.rawMTok).toBe(0)
    expect(preview.tokensByDomain).toMatchObject({ code: 100, chat: 100 })
    expect(preview.weightedQuality).toBeCloseTo(55, 8)
    expect(preview.contaminationRisk).toBeGreaterThan(0)
    expect(preview.licensedMTok).toBeCloseTo(100, 8)
    expect(preview.publicMTok).toBeCloseTo(100, 8)
    expect(preview.restrictedMTok).toBe(0)
  })

  it('applies the 15% premium exactly once across all filtered lots', () => {
    let state = withMarket(game(), LOTS)
    const preview = previewDataPurchase(state, ['bulk-a', 'bulk-b', 'bulk-c'], { bulk: true })
    const cashBefore = state.player.cash

    state = buyAllFilteredDataLots(state, ['bulk-a', 'bulk-b', 'bulk-c'])

    expect(state.player.cash).toBeCloseTo(cashBefore - preview.totalCost, 5)
    expect(state.player.cash).toBeCloseTo(cashBefore - 1_840_000, 5)
    const data = ensureLabData(state)
    expect(data.stocks.code.fromBought).toBeCloseTo(100, 8)
    expect(data.stocks.chat.fromBought).toBeCloseTo(100, 8)

    // A second bulk buy finds nothing live and charges nothing more.
    const cashAfter = state.player.cash
    state = buyAllFilteredDataLots(state, ['bulk-a', 'bulk-b', 'bulk-c'])
    expect(state.player.cash).toBe(cashAfter)
  })
})

describe('supplier negotiation lifecycle', () => {
  it('scores total contract economics, not only price', () => {
    const state = game()
    const desk = listDataSupplierOffers(state)[0]!
    const base = supplierTermsFromOffer(desk)
    const fullPrice = evaluateSupplierOffer({
      offer: desk,
      terms: base,
      buyerCash: state.player.cash,
    })
    const lowball = evaluateSupplierOffer({
      offer: desk,
      terms: { ...base, pricePerMTok: base.pricePerMTok * 0.55 },
      buyerCash: state.player.cash,
    })
    const qualityHeavy = evaluateSupplierOffer({
      offer: desk,
      terms: { ...base, qualityFloor: base.qualityFloor + 12 },
      buyerCash: state.player.cash,
    })

    expect(fullPrice.verdict).toBe('accept')
    expect(lowball.verdict).toBe('reject')
    expect(lowball.score).toBeLessThan(fullPrice.score)
    expect(qualityHeavy.qualityGuaranteeCost).toBeGreaterThan(0)
    expect(qualityHeavy.score).toBeLessThan(fullPrice.score)
  })

  it('walks offered → countered → accepted → active with persisted counter terms', () => {
    let state = game()
    const desk = listDataSupplierOffers(state)[0]!
    const base = supplierTermsFromOffer(desk)
    const asked = { ...base, pricePerMTok: base.pricePerMTok * 0.75 }

    state = proposeDataSupplierTerms(state, desk.id, asked)
    let contract = state.player.dataSupplierContracts![0]!
    expect(contract.status).toBe('offered')
    expect(contract.proposedTerms?.pricePerMTok).toBeCloseTo(asked.pricePerMTok, 8)

    state = tickDataSupplierContracts({ ...state, day: state.day + 1 })
    contract = state.player.dataSupplierContracts![0]!
    expect(contract.status).toBe('countered')
    expect(contract.counterTerms).toBeDefined()
    // The seller's counter changes the terms the buyer asked for.
    expect(contract.counterTerms!.pricePerMTok).toBeGreaterThan(asked.pricePerMTok)

    const cashBefore = state.player.cash
    const signedTerms = contract.counterTerms!
    state = acceptDataSupplierCounter(state, contract.id)
    contract = state.player.dataSupplierContracts![0]!
    expect(contract.status).toBe('accepted')
    // Accept folds counter terms into the live contract and clears the counter.
    expect(contract.counterTerms).toBeUndefined()
    expect(contract.dailyDeliveryMTok).toBe(signedTerms.dailyDeliveryMTok)
    expect(contract.dailyPrice).toBeCloseTo(
      Math.round(signedTerms.dailyDeliveryMTok * signedTerms.pricePerMTok),
      5,
    )
    expect(contract.proposedTerms?.pricePerMTok).toBeCloseTo(
      signedTerms.pricePerMTok,
      8,
    )
    // Negotiated price differs from the desk's list price.
    expect(contract.dailyPrice).not.toBe(desk.dailyPrice)

    state = tickDataSupplierContracts({ ...state, day: state.day + 1 })
    contract = state.player.dataSupplierContracts![0]!
    expect(contract.status).toBe('active')
    expect(contract.deliveredMTok).toBeCloseTo(contract.dailyDeliveryMTok, 8)
    expect(state.player.cash).toBeCloseTo(cashBefore - contract.dailyPrice, 5)
  })

  it('lets the buyer pick delivery domains; the seller bends the mix and delivers it', () => {
    let state = game()
    const desk = listDataSupplierOffers(state)[0]!
    const base = supplierTermsFromOffer(desk)
    // Ask for an AV-only mix at 75% of list price to force a counter.
    const asked = {
      ...base,
      pricePerMTok: base.pricePerMTok * 0.75,
      domainMix: { video: 0.5, audio: 0.5 },
    }

    state = proposeDataSupplierTerms(state, desk.id, asked)
    let contract = state.player.dataSupplierContracts![0]!
    expect(contract.status).toBe('offered')
    // The requested domains ride on the contract from day one.
    expect(contract.domainMix).toMatchObject({ video: 0.5, audio: 0.5 })
    expect(contract.proposedTerms?.domainMix).toMatchObject({
      video: 0.5,
      audio: 0.5,
    })

    state = tickDataSupplierContracts({ ...state, day: state.day + 1 })
    contract = state.player.dataSupplierContracts![0]!
    expect(contract.status).toBe('countered')
    const counterMix = contract.counterTerms!.domainMix
    // Buyer preference bends the supplier's mix toward the requested AV…
    expect(counterMix.video ?? 0).toBeGreaterThan(desk.domainMix.video ?? 0)
    expect(counterMix.audio ?? 0).toBeGreaterThan(desk.domainMix.audio ?? 0)
    // …but the seller keeps its own staples in the counter.
    expect(counterMix.chat ?? 0).toBeGreaterThan(0)
    const mixSum = Object.values(counterMix).reduce(
      (sum, weight) => sum + (weight ?? 0),
      0,
    )
    expect(mixSum).toBeCloseTo(1, 8)

    state = acceptDataSupplierCounter(state, contract.id)
    contract = state.player.dataSupplierContracts![0]!
    expect(contract.status).toBe('accepted')
    expect(contract.domainMix).toMatchObject(counterMix)

    // The negotiated mix drives what actually lands in raw stock.
    const videoBefore = ensureLabData(state).stocks.video.raw
    const audioBefore = ensureLabData(state).stocks.audio.raw
    state = tickDataSupplierContracts({ ...state, day: state.day + 1 })
    const data = ensureLabData(state)
    expect(data.stocks.video.raw).toBeGreaterThan(videoBefore)
    expect(data.stocks.audio.raw).toBeGreaterThan(audioBefore)
  })

  it('rejects insulting offers and lets the buyer walk away from counters', () => {
    let state = game()
    const desk = listDataSupplierOffers(state)[1]!
    const base = supplierTermsFromOffer(desk)

    state = proposeDataSupplierTerms(state, desk.id, {
      ...base,
      pricePerMTok: base.pricePerMTok * 0.5,
    })
    state = tickDataSupplierContracts({ ...state, day: state.day + 1 })
    expect(state.player.dataSupplierContracts![0]!.status).toBe('rejected')

    let walkAway = game()
    walkAway = proposeDataSupplierTerms(walkAway, desk.id, {
      ...base,
      pricePerMTok: base.pricePerMTok * 0.75,
    })
    walkAway = tickDataSupplierContracts({ ...walkAway, day: walkAway.day + 1 })
    const contract = walkAway.player.dataSupplierContracts![0]!
    expect(contract.status).toBe('countered')
    walkAway = rejectDataSupplierCounter(walkAway, contract.id)
    expect(walkAway.player.dataSupplierContracts![0]!.status).toBe('rejected')
  })

  it('expires contracts at the end of the term and stops charging', () => {
    let state = game()
    const desk = listDataSupplierOffers(state)[0]!
    state = {
      ...state,
      player: {
        ...state.player,
        dataSupplierContracts: [
          {
            id: 'dsc-expiry',
            supplierId: desk.id,
            supplierName: desk.name,
            domainMix: desk.domainMix,
            quality: desk.quality,
            dailyDeliveryMTok: desk.dailyDeliveryMTok,
            dailyPrice: desk.dailyPrice,
            termDays: 30,
            daysRemaining: 1,
            acceptedDay: state.day - 29,
            status: 'active' as const,
            deliveredMTok: desk.dailyDeliveryMTok * 29,
          },
        ],
      },
    }
    state = tickDataSupplierContracts({ ...state, day: state.day + 1 })
    const contract = state.player.dataSupplierContracts![0]!
    expect(contract.status).toBe('expired')
    expect(contract.daysRemaining).toBe(0)

    const cashBefore = state.player.cash
    state = tickDataSupplierContracts({ ...state, day: state.day + 1 })
    expect(state.player.cash).toBe(cashBefore)
  })
})

describe('cancellation', () => {
  function liveContract(state: SimState, daysRemaining: number): SimState {
    const desk = listDataSupplierOffers(state)[0]!
    return {
      ...state,
      player: {
        ...state.player,
        dataSupplierContracts: [
          {
            id: 'dsc-live',
            supplierId: desk.id,
            supplierName: desk.name,
            domainMix: desk.domainMix,
            quality: desk.quality,
            dailyDeliveryMTok: desk.dailyDeliveryMTok,
            dailyPrice: desk.dailyPrice,
            termDays: 30,
            daysRemaining,
            acceptedDay: state.day - (30 - daysRemaining),
            status: 'active' as const,
            deliveredMTok: desk.dailyDeliveryMTok * (30 - daysRemaining),
          },
        ],
      },
    }
  }

  it('computes the fee band: 10–30% of remaining value, floored at 3 days of spend', () => {
    const dailyPrice = 100_000
    expect(
      dataCancellationFee({ dailyPrice, daysRemaining: 20 }),
    ).toBe(300_000) // min(30%=6d, max(10%=2d, 3d)) = 3d
    expect(
      dataCancellationFee({ dailyPrice, daysRemaining: 100 }),
    ).toBe(1_000_000) // min(30%=30d, max(10%=10d, 3d)) = 10d
    expect(
      dataCancellationFee({ dailyPrice, daysRemaining: 5 }),
    ).toBe(150_000) // min(30%=1.5d, max(10%=0.5d, 3d)) = 1.5d
    expect(
      dataCancellationFee({ dailyPrice, daysRemaining: 20, cancellationFeeCharged: 1 }),
    ).toBe(0)
  })

  it('charges the cancellation fee exactly once', () => {
    let state = liveContract(game(), 20)
    const contract = state.player.dataSupplierContracts![0]!
    const fee = dataCancellationFee(contract)
    const cashBefore = state.player.cash

    state = cancelDataSupplierContract(state, contract.id)
    expect(state.player.cash).toBeCloseTo(cashBefore - fee, 5)
    const cancelled = state.player.dataSupplierContracts![0]!
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancellationFeeCharged).toBe(fee)

    // Cancelling again warns and does not charge a second time.
    const cashAfter = state.player.cash
    state = cancelDataSupplierContract(state, contract.id)
    expect(state.player.cash).toBe(cashAfter)

    // A cancelled contract stops daily settlement.
    state = tickDataSupplierContracts({ ...state, day: state.day + 1 })
    expect(state.player.cash).toBe(cashAfter)
  })

  it('legacy extended contracts keep delivering and expire normally', () => {
    let state = liveContract(game(), 2)
    state = {
      ...state,
      player: {
        ...state.player,
        dataSupplierContracts: state.player.dataSupplierContracts!.map(
          (contract) => ({ ...contract, status: 'extended' as const }),
        ),
      },
    }
    const cashBefore = state.player.cash
    const deliveredBefore =
      state.player.dataSupplierContracts![0]!.deliveredMTok ?? 0

    state = tickDataSupplierContracts({ ...state, day: state.day + 1 })
    let contract = state.player.dataSupplierContracts![0]!
    expect(contract.status).toBe('extended')
    expect(contract.daysRemaining).toBe(1)
    expect(contract.deliveredMTok).toBeCloseTo(
      deliveredBefore + contract.dailyDeliveryMTok,
      8,
    )
    expect(state.player.cash).toBeCloseTo(cashBefore - contract.dailyPrice, 5)

    state = tickDataSupplierContracts({ ...state, day: state.day + 1 })
    contract = state.player.dataSupplierContracts![0]!
    expect(contract.status).toBe('expired')
    expect(contract.daysRemaining).toBe(0)
  })

  it('survives a save round-trip with negotiation state intact', () => {
    let state = game()
    const desk = listDataSupplierOffers(state)[0]!
    const base = supplierTermsFromOffer(desk)
    state = proposeDataSupplierTerms(state, desk.id, {
      ...base,
      pricePerMTok: base.pricePerMTok * 0.75,
    })
    state = tickDataSupplierContracts({ ...state, day: state.day + 1 })

    const restored = roundTripState(state)
    const contract = restored.player.dataSupplierContracts![0]!
    expect(contract.status).toBe('countered')
    expect(contract.proposedTerms?.pricePerMTok).toBeCloseTo(
      base.pricePerMTok * 0.75,
      8,
    )
    expect(contract.counterTerms?.qualityFloor).toBeDefined()
    expect(contract.counterTerms?.termDays).toBeGreaterThan(0)
    expect(contract.counterTerms?.domainMix.chat).toBeGreaterThan(0)
  })
})

describe('concurrent supplier contracts', () => {
  it('defaults to 180-day terms', () => {
    const offers = listDataSupplierOffers(game())
    expect(offers.length).toBeGreaterThan(0)
    for (const offer of offers) {
      expect(offer.termDays).toBe(180)
    }
  })

  it('allows up to 3 contracts per supplier with an escalating surcharge', () => {
    let state = game()
    const desk = listDataSupplierOffers(state)[0]!

    expect(dataSupplierContractPremium(state, desk.id)).toMatchObject({
      count: 0,
      multiplier: 1,
      atCap: false,
    })

    state = acceptDataSupplierOffer(state, desk.id)
    state = acceptDataSupplierOffer(state, desk.id)
    state = acceptDataSupplierOffer(state, desk.id)
    const contracts = state.player.dataSupplierContracts!
    expect(contracts).toHaveLength(3)
    expect(contracts[0]!.dailyPrice).toBe(desk.dailyPrice)
    expect(contracts[1]!.dailyPrice).toBe(
      Math.round(desk.dailyPrice * (1 + DATA_CONCURRENT_CONTRACT_PREMIUM)),
    )
    expect(contracts[2]!.dailyPrice).toBe(
      Math.round(desk.dailyPrice * (1 + 2 * DATA_CONCURRENT_CONTRACT_PREMIUM)),
    )

    const premium = dataSupplierContractPremium(state, desk.id)
    expect(premium.count).toBe(DATA_MAX_CONTRACTS_PER_SUPPLIER)
    expect(premium.atCap).toBe(true)

    // The 4th contract is blocked at the cap.
    state = acceptDataSupplierOffer(state, desk.id)
    expect(state.player.dataSupplierContracts).toHaveLength(3)
    expect(state.alerts[0]?.message).toContain('limit')

    // ... and a fresh negotiation is blocked too.
    const base = supplierTermsFromOffer(desk)
    state = proposeDataSupplierTerms(state, desk.id, base)
    expect(state.player.dataSupplierContracts).toHaveLength(3)
    expect(state.alerts[0]?.message).toContain('limit')
  })

  it('frees capacity for a new contract after a cancellation', () => {
    let state = game()
    const desk = listDataSupplierOffers(state)[0]!
    state = acceptDataSupplierOffer(state, desk.id)
    const first = state.player.dataSupplierContracts![0]!
    state = cancelDataSupplierContract(state, first.id)

    expect(dataSupplierContractPremium(state, desk.id).count).toBe(0)
    state = acceptDataSupplierOffer(state, desk.id)
    const contracts = state.player.dataSupplierContracts!.filter(
      (contract) => contract.status === 'accepted',
    )
    expect(contracts).toHaveLength(1)
    expect(contracts[0]!.dailyPrice).toBe(desk.dailyPrice)
  })

  it('applies the surcharge when the seller accepts standing terms', () => {
    let state = game()
    const desk = listDataSupplierOffers(state)[0]!
    state = acceptDataSupplierOffer(state, desk.id)

    const base = supplierTermsFromOffer(desk)
    state = proposeDataSupplierTerms(state, desk.id, {
      ...base,
      pricePerMTok: base.pricePerMTok,
    })
    state = tickDataSupplierContracts({ ...state, day: state.day + 1 })

    // The negotiated contract is accepted and settles day one in the same tick.
    const instant = state.player.dataSupplierContracts![0]!
    const negotiated = state.player.dataSupplierContracts!.find(
      (contract) => contract.id !== instant.id,
    )
    expect(negotiated).toBeDefined()
    expect(negotiated!.dailyPrice).toBe(
      Math.round(
        Math.round(base.dailyDeliveryMTok * base.pricePerMTok) *
          (1 + DATA_CONCURRENT_CONTRACT_PREMIUM),
      ),
    )
  })
})

describe('shared market scaling', () => {
  it('lists much bigger lots at higher unit prices as the game progresses', () => {
    const median = (values: number[]): number =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
    const unitPrice = (offer: DataMarketOffer): number =>
      offer.cash / Math.max(1, Math.min(offer.lotMTok, offer.mTokLeft || offer.lotMTok))

    const early = generateDataMarketOffers(42, 5, [], 11)
    const late = generateDataMarketOffers(42, 2500, [], 11)

    expect(median(late.map((offer) => offer.lotMTok))).toBeGreaterThan(
      median(early.map((offer) => offer.lotMTok)) * 3,
    )
    expect(
      median(late.filter((offer) => offer.mTokLeft > 0).map(unitPrice)),
    ).toBeGreaterThan(
      median(early.filter((offer) => offer.mTokLeft > 0).map(unitPrice)) * 2,
    )
  })
})

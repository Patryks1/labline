import { describe, expect, it } from 'vitest'
import type { FacilityAcquisitionOffer } from '../../../sim/types'
import { facilityAcquisitionPresentation } from './hardware/facilityMarketPresentation'

const pending: FacilityAcquisitionOffer = {
  id: 'offer',
  facilityId: 'hall',
  buyerLabId: 'player',
  sellerLabId: 'rival',
  amount: 10_000_000,
  escrow: 10_000_000,
  submittedDay: 1,
  respondDay: 2,
  expiresDay: 8,
  status: 'pending',
}

describe('rival hall acquisition controls', () => {
  it('distinguishes listed buy-now halls from unlisted bid halls', () => {
    expect(facilityAcquisitionPresentation({ forSale: true, listPrice: 25_000_000 })).toEqual({
      mode: 'listed',
      amount: 25_000_000,
    })
    expect(facilityAcquisitionPresentation({ forSale: false })).toEqual({ mode: 'bid' })
  })

  it('surfaces pending and countered negotiation status ahead of listing state', () => {
    expect(facilityAcquisitionPresentation({ forSale: true, listPrice: 25_000_000 }, pending)).toEqual({
      mode: 'pending',
      amount: 10_000_000,
    })
    expect(facilityAcquisitionPresentation({}, { ...pending, status: 'countered', counterAmount: 12_000_000 })).toEqual({
      mode: 'countered',
      amount: 12_000_000,
    })
  })
})

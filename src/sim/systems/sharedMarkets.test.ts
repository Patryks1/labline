import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import {
  declineFirmLoanOffer,
  submitLoanApplication,
  tickSharedMarkets,
} from './sharedMarkets'

function smallState() {
  return createGame({
    seed: 7_401,
    difficulty: 'normal',
    advanced: { mapWidth: 20, mapHeight: 20, cityCount: 2, rivalCount: 1 },
  })
}

describe('firm credit request lifecycle', () => {
  it('allows only one active application and one firm offer per lab', () => {
    const initial = smallState()
    const requested = submitLoanApplication(initial, initial.playerLabId, 10_000_000, 60)
    const duplicate = submitLoanApplication(requested, initial.playerLabId, 12_000_000, 90)

    expect(
      duplicate.worldMarkets.loanApplications.filter(
        (application) =>
          application.labId === initial.playerLabId && application.status === 'pending',
      ),
    ).toHaveLength(1)

    const reviewed = tickSharedMarkets({ ...duplicate, day: duplicate.day + 1 })
    const offers = reviewed.worldMarkets.loanOffers.filter(
      (offer) => offer.labId === initial.playerLabId,
    )
    expect(offers).toHaveLength(1)

    const declined = declineFirmLoanOffer(reviewed, offers[0]!.id)
    expect(
      declined.worldMarkets.loanOffers.filter(
        (offer) => offer.labId === initial.playerLabId,
      ),
    ).toHaveLength(0)
    expect(
      declined.worldMarkets.loanApplications.some(
        (application) =>
          application.labId === initial.playerLabId &&
          (application.status === 'pending' || application.status === 'offered'),
      ),
    ).toBe(false)
  })
})

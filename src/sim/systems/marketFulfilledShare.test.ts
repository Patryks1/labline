import { describe, expect, it } from 'vitest'
import {
  fulfilledServiceFraction,
  OUTSIDE_OPTION_PROVIDER_ID,
  settleFulfilledProviderShares,
} from './market'

describe('fulfilled provider share', () => {
  it('does not reward an endpoint when pain suppresses its request queue', () => {
    expect(fulfilledServiceFraction(1, 0.9)).toBeLessThan(
      fulfilledServiceFraction(0.7, 0),
    )
  })

  it('moves capacity-rejected share to the outside option without renormalizing it away', () => {
    const settled = settleFulfilledProviderShares(
      { player: 0.7, rival: 0.2, [OUTSIDE_OPTION_PROVIDER_ID]: 0.1 },
      { player: 0.5, rival: 0.75 },
    )
    expect(settled.player).toBeCloseTo(0.35)
    expect(settled.rival).toBeCloseTo(0.15)
    expect(settled[OUTSIDE_OPTION_PROVIDER_ID]).toBeCloseTo(0.5)
    expect(Object.values(settled).reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  it('leaves providers without a capacity result fully served for compatibility', () => {
    const settled = settleFulfilledProviderShares(
      { player: 0.4, [OUTSIDE_OPTION_PROVIDER_ID]: 0.6 },
      {},
    )
    expect(settled.player).toBeCloseTo(0.4)
    expect(settled[OUTSIDE_OPTION_PROVIDER_ID]).toBeCloseTo(0.6)
  })
})

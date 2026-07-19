import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createGame } from '../../../sim/createGame'
import { CapacitySalesCeilingCard } from './CapacitySalesCeilingCard'

describe('CapacitySalesCeilingCard', () => {
  it('renders the blocked sales detail only while the compute ceiling is active', () => {
    const state = createGame(6_401)
    const inactive = renderToStaticMarkup(
      createElement(CapacitySalesCeilingCard, { state }),
    )
    expect(inactive).toBe('')

    const constrained = {
      ...state,
      lastMarket: {
        ...state.lastMarket,
        capacitySalesCapped: true,
        capacityProductRevenueCeiling: 938_200,
        blockedApiMTok: 6.4,
        blockedSubscriptionSeats: 125_000,
      },
    }
    const active = renderToStaticMarkup(
      createElement(CapacitySalesCeilingCard, { state: constrained }),
    )

    expect(active).toContain('Compute sales ceiling active')
    expect(active).toContain('API blocked')
    expect(active).toContain('Seats blocked')
  })
})

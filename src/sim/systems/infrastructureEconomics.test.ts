import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { quoteCapacityEconomics } from './infrastructureEconomics'

describe('cloud versus owned capacity economics', () => {
  it('keeps cloud ahead below 50% utilization', () => {
    const state = createGame(811)
    const quote = quoteCapacityEconomics(state, {
      utilization: 0.49,
      cloudPricePerPfDay: 480,
    })
    expect(quote.route).toBe('cloud')
    expect(quote.paybackMonths).toBeGreaterThan(30)
    expect(quote.paybackMonths).toBeLessThan(60)
  })

  it('makes doubled-PF owned racks attractive at healthy load', () => {
    const state = createGame(812)
    for (const utilization of [0.7, 0.75, 0.8]) {
      const quote = quoteCapacityEconomics(state, {
        utilization,
        cloudPricePerPfDay: 480,
      })
      expect(quote.paybackMonths).toBeGreaterThan(0)
      expect(quote.paybackMonths).toBeLessThan(60)
      expect(quote.route).toBe('owned')
    }
  })
})

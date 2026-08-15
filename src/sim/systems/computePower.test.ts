import { describe, expect, it } from 'vitest'
import {
  fleetPowerDraw,
  powerDerateForSupply,
  workloadPowerMw,
} from './computePower'

describe('dual PF/MW compute accounting', () => {
  it('draws more MW for more PF work at the same fleet efficiency', () => {
    const common = {
      fleetPf: 100,
      fullLoadMw: 10,
      idleMw: 2,
      pue: 1.2,
    }
    const light = workloadPowerMw({ ...common, workPf: 25 })
    const heavy = workloadPowerMw({ ...common, workPf: 75 })

    expect(heavy).toBeGreaterThan(light)
  })

  it('uses less MW for the same PF work on a better performance-per-watt fleet', () => {
    const common = { workPf: 60, fleetPf: 100, pue: 1.2 }
    const inefficient = workloadPowerMw({
      ...common,
      fullLoadMw: 12,
      idleMw: 3,
    })
    const efficient = workloadPowerMw({
      ...common,
      fullLoadMw: 7,
      idleMw: 1.5,
    })

    expect(efficient).toBeLessThan(inefficient)
  })

  it('derates PF throughput when available MW is short', () => {
    const full = powerDerateForSupply(10, 10)
    const short = powerDerateForSupply(10, 4)

    expect(full.derate).toBe(1)
    expect(short.derate).toBeCloseTo(0.4, 10)
    expect(short.throttled).toBe(true)
  })

  it('uses the same physical conversion for player and rival fleets', () => {
    const physicalFleet = {
      fullLoadMw: 8,
      idleMw: 2,
      dutyCycle: 0.7,
      pue: 1.18,
    }
    const player = fleetPowerDraw(physicalFleet)
    const rival = fleetPowerDraw(physicalFleet)

    expect(rival).toEqual(player)
  })
})

import { describe, expect, it } from 'vitest'
import {
  rivalArchetypeCeilingMult,
  rivalBaseEraCeilingB,
  rivalEraParamCeilingB,
  rivalMoeAdoptionChance,
  applyRivalReleaseLuck,
  rivalReleaseLuckBonus,
  RIVAL_ERA_CEILING_Y8_B,
} from './rivalScale'
import { emptyBenchmarks } from './benchmarks'
import { RIVAL_SCALE_LADDER_PARAMS_B } from '../systems/rivalStrategy'

describe('rival era param ceiling', () => {
  it('reaches the 2–5T band by year 6 and stays inside the 8-year cap', () => {
    const y0 = rivalBaseEraCeilingB(1)
    const y2 = rivalBaseEraCeilingB(1 + 365 * 2)
    const y4 = rivalBaseEraCeilingB(1 + 365 * 4)
    const y6 = rivalBaseEraCeilingB(1 + 365 * 6)
    const y8 = rivalBaseEraCeilingB(1 + 365 * 8)
    expect(y0).toBeCloseTo(120, 0)
    expect(y2).toBeCloseTo(400, 0)
    expect(y4).toBeCloseTo(1_200, 0)
    expect(y6).toBeGreaterThanOrEqual(2_000)
    expect(y6).toBeLessThanOrEqual(3_200)
    expect(y8).toBeCloseTo(5_000, 0)

    let sawMultiT = false
    for (let day = 1; day <= 2200; day += 40) {
      const hyperscale = rivalEraParamCeilingB({
        day,
        archetype: 'hyperscale',
        publicFrontierParamsB: 0,
      })
      const open = rivalEraParamCeilingB({
        day,
        archetype: 'open_weights',
        publicFrontierParamsB: 0,
      })
      expect(hyperscale).toBeGreaterThan(open)
      expect(hyperscale).toBeLessThanOrEqual(
        RIVAL_ERA_CEILING_Y8_B * rivalArchetypeCeilingMult('hyperscale'),
      )
      if (hyperscale >= 2_000) sawMultiT = true
    }
    expect(sawMultiT).toBe(true)
    expect(RIVAL_SCALE_LADDER_PARAMS_B[RIVAL_SCALE_LADDER_PARAMS_B.length - 1]).toBe(
      5_000,
    )
  })

  it('follows a public frontier without jumping the era band', () => {
    const early = rivalEraParamCeilingB({
      day: 40,
      archetype: 'hyperscale',
      publicFrontierParamsB: 2_000,
    })
    expect(early).toBeGreaterThan(120)
    expect(early).toBeLessThan(2_200)
  })

  it('adopts MoE more readily for efficiency labs past 200B', () => {
    expect(rivalMoeAdoptionChance('efficiency', 80, true)).toBe(1)
    expect(rivalMoeAdoptionChance('safety', 80, true)).toBe(0)
    expect(rivalMoeAdoptionChance('hyperscale', 400, true)).toBeGreaterThan(
      rivalMoeAdoptionChance('safety', 400, true),
    )
    expect(rivalMoeAdoptionChance('hyperscale', 400, false)).toBe(0)
  })

  it('rolls a bounded luck bonus about 8% of the time', () => {
    expect(rivalReleaseLuckBonus(0.5, 0.5)).toBe(0)
    expect(rivalReleaseLuckBonus(0.05, 0)).toBeCloseTo(0.7)
    expect(rivalReleaseLuckBonus(0.05, 1)).toBeCloseTo(2.2)
  })

  it('never applies release luck to personality', () => {
    const model = applyRivalReleaseLuck(
      {
        capability: 40,
        benchmarks: { ...emptyBenchmarks(), coding: 40, personality: 22 },
      },
      2,
    )
    expect(model.capability).toBe(42)
    expect(model.benchmarks.coding).toBeCloseTo(40.9)
    expect(model.benchmarks.personality).toBe(22)
  })
})

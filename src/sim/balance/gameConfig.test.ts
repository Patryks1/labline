import { describe, expect, it } from 'vitest'
import { buildGameConfig, defaultGameConfig } from './gameConfig'

describe('new game configuration', () => {
  it('uses the large frontier world defaults', () => {
    expect(defaultGameConfig()).toMatchObject({
      mapWidth: 300,
      mapHeight: 300,
      cityCount: 4,
      rivalCount: 5,
    })
  })

  it('keeps explicit custom scenario controls authoritative', () => {
    expect(
      buildGameConfig({
        difficulty: 'normal',
        advanced: {
          mapWidth: 180,
          mapHeight: 140,
          cityCount: 6,
          rivalCount: 3,
          startingCashMult: 2.5,
        },
      }),
    ).toMatchObject({
      mapWidth: 180,
      mapHeight: 140,
      cityCount: 6,
      rivalCount: 3,
      startingCashMult: 2.5,
    })
  })

  it('makes difficulty change real opening resources and operating pressure', () => {
    const easy = buildGameConfig({ difficulty: 'easy' })
    const normal = buildGameConfig({ difficulty: 'normal' })
    const hard = buildGameConfig({ difficulty: 'hard' })

    expect(easy.startingCashMult).toBeGreaterThan(normal.startingCashMult)
    expect(easy.economyMult).toBeLessThan(normal.economyMult)
    expect(easy.researchCostMult).toBeLessThan(normal.researchCostMult)
    expect(easy.rivalCount).toBeLessThan(normal.rivalCount)
    expect(hard.startingCashMult).toBeLessThan(normal.startingCashMult)
    expect(hard.economyMult).toBeGreaterThan(normal.economyMult)
    expect(hard.researchCostMult).toBeGreaterThan(normal.researchCostMult)
  })

  it('lets advanced controls override difficulty resources', () => {
    expect(
      buildGameConfig({
        difficulty: 'hard',
        advanced: {
          economyMult: 0.7,
          researchCostMult: 0.8,
          startingCashMult: 2,
          rivalCount: 2,
        },
      }),
    ).toMatchObject({
      economyMult: 0.7,
      researchCostMult: 0.8,
      startingCashMult: 2,
      rivalCount: 2,
    })
  })

  it('does not resize explicit maps when defaults change', () => {
    expect(
      buildGameConfig({
        difficulty: 'hard',
        advanced: { mapWidth: 150, mapHeight: 120 },
      }),
    ).toMatchObject({
      mapWidth: 150,
      mapHeight: 120,
    })
  })
})

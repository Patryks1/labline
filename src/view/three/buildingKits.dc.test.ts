import { describe, expect, it } from 'vitest'
import { createBuildingKit, dataCenterStyleVariant } from './buildingKits'

describe('data-center procedural silhouettes', () => {
  it('selects only stable finite variants', () => {
    const variants = new Set<number>()
    for (let x = 0; x < 20; x += 1) for (let y = 0; y < 20; y += 1) variants.add(dataCenterStyleVariant(x, y))
    expect([...variants].toSorted()).toEqual([0, 1, 2])
  })

  it('keeps small, medium and large silhouettes progressively distinct', () => {
    const small = createBuildingKit('dc', 0x61f2bd, 0.4, 1, 1)
    const medium = createBuildingKit('dc_m', 0x61f2bd, 0.4, 1, 1)
    const large = createBuildingKit('dc_l', 0x61f2bd, 0.4, 1, 1)
    expect(small.children.length).toBeLessThan(medium.children.length)
    expect(medium.children.length).toBeLessThan(large.children.length)
  })
})

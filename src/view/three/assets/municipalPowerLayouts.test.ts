import { describe, expect, it } from 'vitest'
import rawLayouts from './municipalPowerLayouts.json'
import {
  MUNICIPAL_POWER_LAYOUTS,
  parseMunicipalPowerLayouts,
  transformMunicipalAnchor,
} from './municipalPowerLayouts'

describe('municipal power layout descriptor', () => {
  it('reserves four unique IDs and contains every structure/anchor in the 2x2 campus', () => {
    expect(MUNICIPAL_POWER_LAYOUTS.campuses.map(campus => campus.archetypeId)).toEqual([
      506, 507, 508, 509,
    ])
    expect(() => parseMunicipalPowerLayouts(structuredClone(rawLayouts))).not.toThrow()
    for (const campus of MUNICIPAL_POWER_LAYOUTS.campuses) {
      for (const structure of campus.structures) {
        expect(Math.abs(structure.position[0]) + structure.scale[0] / 2).toBeLessThanOrEqual(1)
        expect(Math.abs(structure.position[2]) + structure.scale[2] / 2).toBeLessThanOrEqual(1)
      }
      for (const effect of campus.effects) {
        expect(Math.abs(effect.position[0])).toBeLessThanOrEqual(1)
        expect(Math.abs(effect.position[2])).toBeLessThanOrEqual(1)
      }
    }
  })

  it('rejects ID collisions and out-of-footprint structures', () => {
    const collision = structuredClone(rawLayouts)
    collision.campuses[1]!.archetypeId = collision.campuses[0]!.archetypeId
    expect(() => parseMunicipalPowerLayouts(collision)).toThrow(/Duplicate/)

    const overflow = structuredClone(rawLayouts)
    overflow.campuses[0]!.structures[0]!.position[0] = 0.9
    expect(() => parseMunicipalPowerLayouts(overflow)).toThrow(/exceeds its 2x2 footprint/)
  })

  it('rotates local anchors around the shared campus centre', () => {
    expect(transformMunicipalAnchor([10, 2, 20], Math.PI / 2, [0.5, 1, -0.25]))
      .toEqual(expect.arrayContaining([
        expect.closeTo(9.75, 8),
        3,
        expect.closeTo(19.5, 8),
      ]))
  })
})

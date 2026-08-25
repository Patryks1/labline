import { describe, expect, it } from 'vitest'
import type { Mesh } from 'three'
import {
  createBuildingKit,
  hqStoreyCount,
  hqStyleVariant,
  hqTowerHeight,
  HQ_STOREY_HEIGHT,
} from './buildingKits'

function kitHeight(kind: 'hq' | 'hq_m' | 'hq_l', x = 3, y = 5): number {
  const kit = createBuildingKit(kind, 0xc0c8d0, 0.5, x, y)
  const stored = kit.userData.kitHeight
  if (typeof stored === 'number' && stored > 0) return stored
  let maxY = 0
  kit.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.geometry) return
    mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox
    if (!box) return
    maxY = Math.max(maxY, obj.position.y + box.max.y)
  })
  return maxY
}

describe('HQ civic kits', () => {
  it('increases storey count and height by tier without becoming towers', () => {
    expect(hqStoreyCount('hq')).toBe(1)
    expect(hqStoreyCount('hq_m')).toBe(2)
    expect(hqStoreyCount('hq_l')).toBe(3)

    const small = hqTowerHeight('hq')
    const medium = hqTowerHeight('hq_m')
    const large = hqTowerHeight('hq_l')
    expect(medium).toBeGreaterThan(small)
    expect(large).toBeGreaterThan(medium)
    expect(small).toBe(1 * HQ_STOREY_HEIGHT)
    expect(large).toBeLessThan(1.3)
  })

  it('builds kits whose measured height increases by tier', () => {
    const smallH = kitHeight('hq')
    const mediumH = kitHeight('hq_m')
    const largeH = kitHeight('hq_l')
    expect(mediumH).toBeGreaterThan(smallH)
    expect(largeH).toBeGreaterThan(mediumH)
    expect(smallH).toBeGreaterThan(0.35)
    expect(largeH).toBeLessThan(2.2)
  })

  it('selects finite façade variants and keeps upgrades from being scaled copies', () => {
    const variants = new Set<number>()
    for (let x = 0; x < 12; x++) for (let y = 0; y < 12; y++) variants.add(hqStyleVariant(x, y))
    expect([...variants].toSorted()).toEqual([0, 1, 2])

    const kits = [0, 1, 2].map((v) => {
      for (let x = 0; x < 40; x++) {
        for (let y = 0; y < 40; y++) {
          if (hqStyleVariant(x, y) === v) return createBuildingKit('hq_l', 0xa0a8bc, 0.5, x, y)
        }
      }
      throw new Error(`missing HQ variant ${v}`)
    })
    const signatures = kits.map((kit) => `${kit.userData.hqVariant}:${kit.children.length}`)
    expect(new Set(signatures).size).toBe(3)
    const small = createBuildingKit('hq', 0xc0c8d0, 0.5, 4, 4)
    const medium = createBuildingKit('hq_m', 0xb0b8c8, 0.5, 4, 4)
    expect(medium.children.length).not.toBe(small.children.length)
  })
})

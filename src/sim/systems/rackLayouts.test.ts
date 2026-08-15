import { describe, expect, it } from 'vitest'
import {
  applyRackLayoutToInstalls,
  commitAutoPlace,
  createRackLayout,
  formatRackAddress,
  getRackHallTemplate,
  layoutRackInstalls,
  moveRack,
  parseRackAddress,
  placeRack,
  previewAutoPlace,
  rackAddressAt,
  rackUnitIndex,
  recommendRackDesigns,
  removeRack,
  validateRackLayout,
} from './rackLayouts'

describe('physical rack layouts', () => {
  it('defines exact 96/288/960 unit hall templates', () => {
    for (const capacity of [96, 288, 960] as const) {
      const template = getRackHallTemplate(capacity)
      expect(template.rows * template.baysPerRow).toBe(capacity)
      expect(rackUnitIndex(rackAddressAt('dc:west/1', capacity, capacity - 1), capacity)).toBe(capacity - 1)
    }
  })

  it('addresses every bay in arbitrary upgraded hall capacities', () => {
    for (const capacity of [144, 384, 1152]) {
      const template = getRackHallTemplate(capacity)
      expect(template.capacity).toBe(capacity)
      expect(template.rows * template.baysPerRow).toBeGreaterThanOrEqual(capacity)
      const last = rackAddressAt('upgraded-hall', capacity, capacity - 1)
      expect(rackUnitIndex(last, capacity)).toBe(capacity - 1)
      expect(rackUnitIndex({ ...last, bay: last.bay + 1 }, capacity)).toBe(-1)
    }
  })

  it('round trips stable facility addresses', () => {
    const address = { facilityId: 'dc:west/1', row: 2, bay: 11 }
    const encoded = formatRackAddress(address)
    expect(encoded).toBe('rack:v1:dc%3Awest%2F1:r03:b012')
    expect(parseRackAddress(encoded)).toEqual(address)
    expect(parseRackAddress('bad')).toBeNull()
  })

  it('places, moves, and removes exact contiguous rack units immutably', () => {
    const empty = createRackLayout('dc-1', 96)
    const first = placeRack(empty, {
      id: 'rack-a', skuId: 'sku-a', rackUnits: 2,
      address: { facilityId: 'dc-1', row: 0, bay: 0 },
    })
    expect(first.errors).toEqual([])
    expect(empty.placements).toEqual([])

    const overlap = placeRack(first.layout, {
      id: 'rack-b', skuId: 'sku-b', rackUnits: 1,
      address: { facilityId: 'dc-1', row: 0, bay: 1 },
    })
    expect(overlap.layout).toBe(first.layout)
    expect(overlap.errors[0]).toContain('overlaps rack-a')

    const moved = moveRack(first.layout, 'rack-a', { facilityId: 'dc-1', row: 1, bay: 4 })
    expect(moved.errors).toEqual([])
    expect(removeRack(moved.layout, 'rack-a').placements).toEqual([])
  })

  it('rejects row wrapping and emits deterministic validation errors', () => {
    const layout = createRackLayout('dc-1', 96, [{
      id: 'wide', skuId: 'sku', rackUnits: 2,
      address: { facilityId: 'dc-1', row: 0, bay: 15 },
    }])
    expect(validateRackLayout(layout)).toMatchObject({
      valid: false,
      errors: ['Rack wide crosses the end of row 1.'],
    })
  })

  it('rejects multi-unit racks that exceed a custom hall partial row', () => {
    const layout = createRackLayout('dc-custom', 100, [{
      id: 'wide', skuId: 'sku', rackUnits: 2,
      address: { facilityId: 'dc-custom', row: 6, bay: 3 },
    }])
    expect(validateRackLayout(layout).errors).toContain('Rack wide exceeds 100 available rack units.')
  })

  it('rejects cross-facility addresses instead of silently rewriting them', () => {
    const result = placeRack(createRackLayout('dc-1', 96), {
      id: 'foreign', skuId: 'sku', rackUnits: 1,
      address: { facilityId: 'dc-2', row: 0, bay: 0 },
    })
    expect(result.errors).toContain('Rack foreign belongs to a different facility.')
  })

  it('previews and commits the same deterministic first-fit layout', () => {
    const requests = [
      { id: 'z', skuId: 'two-u', rackUnits: 2, count: 2 },
      { id: 'a', skuId: 'one-u', rackUnits: 1 },
    ]
    const a = previewAutoPlace(createRackLayout('dc-1', 96), requests)
    const b = previewAutoPlace(createRackLayout('dc-1', 96), [...requests].reverse())
    expect(a).toEqual(b)
    expect(a.placed.map((entry) => [entry.id, entry.address.row, entry.address.bay])).toEqual([
      ['a', 0, 0],
      ['z:001', 0, 1],
      ['z:002', 0, 3],
    ])
    expect(commitAutoPlace(a)).toEqual(a.layout)
    expect(validateRackLayout(a.layout)).toMatchObject({ valid: true, used: 5, free: 91 })
  })

  it('projects aggregate legacy installs into stable physical identities', () => {
    const preview = layoutRackInstalls(4, 9, 96, [{
      id: 'install-z', skuId: 'rack-l2', x: 4, y: 9, count: 2,
      status: 'live', daysLeft: 0, paidEach: 1, rackUnits: 2,
    }])
    expect(preview.placed.map((entry) => [entry.id, entry.address.facilityId, entry.address.bay])).toEqual([
      ['install-z:rack:0001', 'map-hall:4,9', 0],
      ['install-z:rack:0002', 'map-hall:4,9', 2],
    ])
  })

  it('persists manual bay moves on grouped rack installs', () => {
    const installs = [{
      id: 'install-z', skuId: 'rack-l2', x: 4, y: 9, count: 2,
      status: 'live' as const, daysLeft: 0, paidEach: 1, rackUnits: 2,
    }]
    const preview = layoutRackInstalls(4, 9, 96, installs)
    const moved = moveRack(preview.layout, 'install-z:rack:0002', {
      facilityId: 'map-hall:4,9', row: 2, bay: 4,
    })
    expect(moved.errors).toEqual([])
    const persisted = applyRackLayoutToInstalls(installs, 4, 9, moved.layout)
    expect(persisted[0]!.facilityId).toBe('map-hall:4,9')
    expect(persisted[0]!.bayStarts).toEqual([0, 36])
    expect(layoutRackInstalls(4, 9, 96, persisted).layout).toEqual(moved.layout)
  })
})

describe('rack auto design', () => {
  it('returns stable catalog-valid recommendations for every goal', () => {
    for (const goal of ['balanced', 'training', 'inference', 'memory'] as const) {
      const first = recommendRackDesigns({ goal, limit: 2 })
      const second = recommendRackDesigns({ goal, limit: 2 })
      expect(first).toEqual(second)
      expect(first.length).toBeGreaterThan(0)
      expect(first.every((entry) => entry.stats.valid)).toBe(true)
      expect(first.every((entry) => entry.stats.cpuScore > 0 && entry.stats.networkGbps >= 400)).toBe(true)
    }
  })
})

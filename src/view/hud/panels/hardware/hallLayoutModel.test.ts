import { describe, expect, it } from 'vitest'
import type { RackInstall, RackSku } from '../../../../sim/types'
import {
  buildHallRackSlots,
  captureHallClock,
  nextHallSlotIndex,
  rackVisualKind,
  restoreHallClock,
  semanticGridWindow,
  summarizeHallRackCapacity,
} from './hallLayoutModel'

const sku = (id: string, name: string) => ({ id, name, rackUnits: 1 } as RackSku)

describe('hall layout projection', () => {
  it('expands installs into stable physical bays and keeps empty capacity', () => {
    const installs = [{ id: 'i1', skuId: 'gpu', x: 1, y: 2, count: 2, rackUnits: 1, status: 'live', paidEach: 1, daysLeft: 0 }] as RackInstall[]
    const slots = buildHallRackSlots(4, installs, (id) => sku(id, 'H100 GPU rack'), 2)
    expect(slots.map((slot) => slot.kind)).toEqual(['gpu', 'gpu', 'empty', 'empty'])
    expect(slots[2]?.bayLabel).toBe('R02–B01')
  })

  it('classifies readable front-panel patterns', () => {
    expect(rackVisualKind(sku('a', 'CPU dense node'))).toBe('cpu')
    expect(rackVisualKind(sku('b', 'Liquid cooling CDU'))).toBe('cooling')
    expect(rackVisualKind(sku('c', 'RAM memory shelf'))).toBe('memory')
  })

  it('separates installed rack resources from planned cabinet potential', () => {
    const objects = [
      { id: 'installed', kind: 'rack', catalogId: 'gpu', rackUnitId: 'unit-1', x: 0, z: 0, rotation: 0, purchasePrice: 0 },
      { id: 'planned', kind: 'rack', catalogId: 'gpu', reserved: true, x: 4, z: 0, rotation: 0, purchasePrice: 0 },
      { id: 'utility', kind: 'power', catalogId: 'pdu-2mw', x: 8, z: 0, rotation: 0, purchasePrice: 1 },
    ] as const
    const impact = summarizeHallRackCapacity(objects, () => ({ flopsPf: 8, vramGb: 640, mw: 0.008, tokPerSec: 96_000 }))
    expect(impact.installed).toEqual({ cabinets: 1, flopsPf: 8, vramGb: 640, mw: 0.008, tokPerSec: 96_000 })
    expect(impact.planned).toEqual({ cabinets: 1, flopsPf: 8, vramGb: 640, mw: 0.008, tokPerSec: 96_000 })
  })

  it('moves within grid bounds for keyboard navigation', () => {
    expect(nextHallSlotIndex(4, 'ArrowDown', 7, 3)).toBe(6)
    expect(nextHallSlotIndex(4, 'Home', 7, 3)).toBe(0)
    expect(nextHallSlotIndex(0, 'ArrowLeft', 7, 3)).toBe(0)
    expect(nextHallSlotIndex(2, 'ArrowRight', 7, 3)).toBe(2)
  })

  it('virtualizes a large semantic grid around the selected row', () => {
    expect(semanticGridWindow(24, 12)).toEqual({ firstRow: 10, lastRowExclusive: 14 })
    expect(semanticGridWindow(24, 23)).toEqual({ firstRow: 20, lastRowExclusive: 24 })
    expect((semanticGridWindow(24, 12).lastRowExclusive - semanticGridWindow(24, 12).firstRow) * 40).toBe(160)
  })

  it('restores the prior clock only within the same campaign', () => {
    const prior = captureHallClock({ seed: 7, speed: 5, paused: false })
    expect(restoreHallClock({ seed: 7, speed: 5 as const, paused: true, day: 4 }, prior)).toMatchObject({ speed: 5, paused: false })
    expect(restoreHallClock({ seed: 8, speed: 1 as const, paused: true }, prior)).toEqual({ seed: 8, speed: 1, paused: true })
  })

  it('honours persisted multi-unit starts before filling remaining bays', () => {
    const installs = [
      { id: 'later', skuId: 'gpu', x: 1, y: 2, count: 1, rackUnits: 2, bayStarts: [4], status: 'live', paidEach: 1, daysLeft: 0 },
      { id: 'first', skuId: 'cpu', x: 1, y: 2, count: 1, rackUnits: 1, status: 'live', paidEach: 1, daysLeft: 0 },
    ] as RackInstall[]
    const slots = buildHallRackSlots(8, installs, (id) => sku(id, id === 'cpu' ? 'CPU rack' : 'GPU rack'), 4)
    expect(slots[4]?.placementId).toContain('later')
    expect(slots[5]?.placementId).toBe(slots[4]?.placementId)
    expect(slots[0]?.kind).toBe('cpu')
  })
})

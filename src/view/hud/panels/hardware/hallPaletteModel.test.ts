import { describe, expect, it } from 'vitest'
import type { HallRackUnit } from '../../../../sim/systems/dataHallLayouts'
import {
  HALL_PALETTE_DATA_MIME,
  groupHallRackPaletteUnits,
  nextAvailableHallRackUnit,
  parseHallPalettePayload,
  serializeHallEquipmentPayload,
  serializeHallRackSkuPayload,
} from './hallPaletteModel'

const unit = (unitId: string, skuId: string, delivered = true): HallRackUnit => ({
  unitId,
  skuId,
  delivered,
  mw: 0.01,
  networkGbps: 400,
})

describe('hall rack palette inventory', () => {
  it('groups only delivered, unplaced units in deterministic order', () => {
    const inventory = [
      unit('z-2', 'zeta'),
      unit('a-2', 'alpha'),
      unit('a-pending', 'alpha', false),
      unit('a-1', 'alpha'),
      unit('z-1', 'zeta'),
    ]

    expect(groupHallRackPaletteUnits(inventory, new Set(['z-1']))).toEqual([
      { skuId: 'alpha', unitIds: ['a-1', 'a-2'], availableCount: 2 },
      { skuId: 'zeta', unitIds: ['z-2'], availableCount: 1 },
    ])
  })

  it('deduplicates inventory IDs and deterministically selects the next unit', () => {
    const groups = groupHallRackPaletteUnits([
      unit('rack-10', 'gpu'),
      unit('rack-02', 'gpu'),
      unit('rack-02', 'gpu'),
    ])

    expect(groups[0]).toEqual({ skuId: 'gpu', unitIds: ['rack-02', 'rack-10'], availableCount: 2 })
    expect(nextAvailableHallRackUnit({ unitIds: ['rack-10', 'rack-02'] })).toBe('rack-02')
    expect(nextAvailableHallRackUnit({ unitIds: [] })).toBeNull()
  })
})

describe('hall palette drag payloads', () => {
  it('uses a namespaced JSON MIME type', () => {
    expect(HALL_PALETTE_DATA_MIME).toBe('application/vnd.labline.hall-palette+json')
  })

  it('round-trips rack SKU and equipment catalog payloads', () => {
    expect(parseHallPalettePayload(serializeHallRackSkuPayload('gpu-h100'))).toEqual({
      version: 1,
      kind: 'rack-sku',
      skuId: 'gpu-h100',
    })
    expect(parseHallPalettePayload(serializeHallEquipmentPayload('crac-2mw'))).toEqual({
      version: 1,
      kind: 'equipment-catalog',
      catalogId: 'crac-2mw',
    })
  })

  it.each([
    '',
    'not json',
    'null',
    '[]',
    '{}',
    '{"version":2,"kind":"rack-sku","skuId":"gpu"}',
    '{"version":1,"kind":"rack-sku","skuId":"  "}',
    '{"version":1,"kind":"equipment-catalog","catalogId":7}',
    '{"version":1,"kind":"unknown","skuId":"gpu"}',
  ])('returns null for invalid payload %j', (value) => {
    expect(parseHallPalettePayload(value)).toBeNull()
  })
})

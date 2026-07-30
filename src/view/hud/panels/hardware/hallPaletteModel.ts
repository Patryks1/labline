import type { HallRackUnit } from '../../../../sim/systems/dataHallLayouts'

/** Custom drag type used for data-hall palette entries. */
export const HALL_PALETTE_DATA_MIME = 'application/vnd.labline.hall-palette+json'

export interface HallRackPaletteGroup {
  skuId: string
  unitIds: string[]
  availableCount: number
}

const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

/**
 * Projects delivered rack inventory that is not already placed into stable
 * SKU groups. Both groups and unit IDs have an explicit lexical ordering.
 */
export function groupHallRackPaletteUnits(
  inventory: readonly HallRackUnit[],
  placedUnitIds: Iterable<string> = [],
): HallRackPaletteGroup[] {
  const placed = new Set(placedUnitIds)
  const bySku = new Map<string, Set<string>>()

  for (const unit of inventory) {
    if (!unit.delivered || placed.has(unit.unitId)) continue
    const unitIds = bySku.get(unit.skuId) ?? new Set<string>()
    unitIds.add(unit.unitId)
    bySku.set(unit.skuId, unitIds)
  }

  return [...bySku.entries()]
    .sort(([a], [b]) => compareIds(a, b))
    .map(([skuId, ids]) => {
      const unitIds = [...ids].sort(compareIds)
      return { skuId, unitIds, availableCount: unitIds.length }
    })
}

/** Selects the same first available physical unit regardless of input order. */
export function nextAvailableHallRackUnit(group: Pick<HallRackPaletteGroup, 'unitIds'>): string | null {
  let next: string | undefined
  for (const unitId of group.unitIds) {
    if (next === undefined || compareIds(unitId, next) < 0) next = unitId
  }
  return next ?? null
}

export type HallPaletteDragPayload =
  | { version: 1; kind: 'rack-sku'; skuId: string }
  | { version: 1; kind: 'equipment-catalog'; catalogId: string }

export function serializeHallRackSkuPayload(skuId: string): string {
  return JSON.stringify({ version: 1, kind: 'rack-sku', skuId } satisfies HallPaletteDragPayload)
}

export function serializeHallEquipmentPayload(catalogId: string): string {
  return JSON.stringify({ version: 1, kind: 'equipment-catalog', catalogId } satisfies HallPaletteDragPayload)
}

/** Parses untrusted drag data without requiring DataTransfer or another DOM API. */
export function parseHallPalettePayload(value: string): HallPaletteDragPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.version !== 1) return null
  if (parsed.kind === 'rack-sku' && isNonEmptyString(parsed.skuId)) {
    return { version: 1, kind: 'rack-sku', skuId: parsed.skuId }
  }
  if (parsed.kind === 'equipment-catalog' && isNonEmptyString(parsed.catalogId)) {
    return { version: 1, kind: 'equipment-catalog', catalogId: parsed.catalogId }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

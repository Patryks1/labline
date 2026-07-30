import type { DataHallObjectPlacement, RackInstall, RackSku, Speed } from '../../../../sim/types'
import { rackInstallPlacementId } from '../../../../sim/systems/rackLayouts'

export type RackVisualKind = 'gpu' | 'cpu' | 'memory' | 'cooling' | 'empty' | 'unknown'

export interface HallRackCapacityTotals {
  cabinets: number
  flopsPf: number
  vramGb: number
  mw: number
  tokPerSec: number
}

export interface HallRackCapacityImpact {
  installed: HallRackCapacityTotals
  planned: HallRackCapacityTotals
}

const emptyCapacityTotals = (): HallRackCapacityTotals => ({ cabinets: 0, flopsPf: 0, vramGb: 0, mw: 0, tokPerSec: 0 })

/** Installed hardware versus the potential hardware represented by empty planned cabinets. */
export function summarizeHallRackCapacity(
  objects: readonly DataHallObjectPlacement[],
  resolveSku: (skuId: string) => Pick<RackSku, 'flopsPf' | 'vramGb' | 'mw' | 'tokPerSec'> | undefined,
): HallRackCapacityImpact {
  const impact = { installed: emptyCapacityTotals(), planned: emptyCapacityTotals() }
  for (const object of objects) {
    if (object.kind !== 'rack') continue
    const sku = resolveSku(object.catalogId)
    if (!sku) continue
    const totals = object.reserved ? impact.planned : impact.installed
    totals.cabinets += 1
    totals.flopsPf += sku.flopsPf
    totals.vramGb += sku.vramGb
    totals.mw += sku.mw
    totals.tokPerSec += sku.tokPerSec
  }
  return impact
}

export interface HallRackSlot {
  index: number
  row: number
  column: number
  bayLabel: string
  installId?: string
  placementId?: string
  skuId?: string
  status?: RackInstall['status']
  kind: RackVisualKind
}

export function rackVisualKind(sku?: Pick<RackSku, 'name'> & { id?: string }): RackVisualKind {
  if (!sku) return 'unknown'
  const value = `${sku.id ?? ''} ${sku.name}`.toLowerCase()
  if (/cool|crac|liquid/.test(value)) return 'cooling'
  if (/ram|memory|vram/.test(value)) return 'memory'
  if (/cpu|xeon|epyc/.test(value)) return 'cpu'
  return 'gpu'
}

/** Stable row-major projection shared by WebGL picking and the semantic grid. */
export function buildHallRackSlots(
  capacity: number,
  installs: readonly RackInstall[],
  resolveSku: (skuId: string) => RackSku | undefined,
  columns = capacity > 192 ? 12 : capacity > 96 ? 10 : 8,
): HallRackSlot[] {
  const count = Math.max(0, Math.floor(capacity))
  const occupied: Array<Omit<HallRackSlot, 'index' | 'row' | 'column' | 'bayLabel'> | undefined> = Array.from({ length: count })
  const firstFit = (units: number) => {
    for (let start = 0; start + units <= count; start += 1) {
      if (Math.floor(start / columns) !== Math.floor((start + units - 1) / columns)) continue
      if (Array.from({ length: units }, (_, offset) => occupied[start + offset]).every((entry) => entry === undefined)) return start
    }
    return -1
  }
  for (const install of [...installs].sort((a, b) => a.id.localeCompare(b.id))) {
    const sku = resolveSku(install.skuId)
    const units = Math.max(1, install.rackUnits || sku?.rackUnits || 1)
    for (let copy = 0; copy < Math.max(0, install.count); copy += 1) {
      const requested = install.bayStarts?.[copy]
      const persisted = Number.isSafeInteger(requested) && requested! >= 0 && requested! + units <= count &&
        Math.floor(requested! / columns) === Math.floor((requested! + units - 1) / columns) &&
        Array.from({ length: units }, (_, offset) => occupied[requested! + offset]).every((entry) => entry === undefined)
      const start = persisted ? requested! : firstFit(units)
      if (start < 0) continue
      const placementId = rackInstallPlacementId(install.id, copy)
      for (let unit = 0; unit < units; unit += 1) {
        occupied[start + unit] = {
          installId: install.id,
          placementId,
          skuId: install.skuId,
          status: install.status,
          kind: rackVisualKind(sku),
        }
      }
    }
  }
  return Array.from({ length: count }, (_, index) => ({
    index,
    row: Math.floor(index / columns),
    column: index % columns,
    bayLabel: `R${String(Math.floor(index / columns) + 1).padStart(2, '0')}–B${String((index % columns) + 1).padStart(2, '0')}`,
    ...(occupied[index] ?? { kind: 'empty' as const }),
  }))
}

export function nextHallSlotIndex(
  current: number,
  key: string,
  slotCount: number,
  columns: number,
): number {
  if (slotCount <= 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return slotCount - 1
  const safeCurrent = Math.max(0, Math.min(slotCount - 1, current))
  const rowStart = Math.floor(safeCurrent / columns) * columns
  const rowEnd = Math.min(slotCount - 1, rowStart + columns - 1)
  if (key === 'ArrowLeft') return Math.max(rowStart, safeCurrent - 1)
  if (key === 'ArrowRight') return Math.min(rowEnd, safeCurrent + 1)
  if (key === 'ArrowUp') return Math.max(safeCurrent % columns, safeCurrent - columns)
  if (key === 'ArrowDown') return Math.min(slotCount - 1, safeCurrent + columns)
  return safeCurrent
}

/** Row window for an aria-rowindexed virtual grid (large halls avoid 960 DOM buttons). */
export function semanticGridWindow(
  totalRows: number,
  selectedRow: number,
  visibleRows = 4,
): { firstRow: number; lastRowExclusive: number } {
  const total = Math.max(0, Math.floor(totalRows))
  const count = Math.max(1, Math.min(total, Math.floor(visibleRows)))
  if (total === 0) return { firstRow: 0, lastRowExclusive: 0 }
  const selected = Math.max(0, Math.min(total - 1, Math.floor(selectedRow)))
  const firstRow = Math.max(0, Math.min(total - count, selected - Math.floor(count / 2)))
  return { firstRow, lastRowExclusive: firstRow + count }
}

export interface HallClockSnapshot {
  seed: number
  speed: Speed
  paused: boolean
}

export function captureHallClock(state: HallClockSnapshot): HallClockSnapshot {
  return { seed: state.seed, speed: state.speed, paused: state.paused }
}

/** Do not leak an old task's clock state over a newly loaded campaign. */
export function restoreHallClock<T extends HallClockSnapshot>(current: T, prior: HallClockSnapshot): T {
  return current.seed === prior.seed
    ? { ...current, speed: prior.speed, paused: prior.paused }
    : current
}

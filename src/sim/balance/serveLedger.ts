import { DEFAULT_SERVE_HEADROOM } from './tokenServe'

export type ComputeWorkChannel = 'api' | 'subscription' | 'enterprise' | string

/** One independently routable serving workload in native product units. */
export interface ComputeWorkItem {
  id: string
  channel: ComputeWorkChannel
  requestedUnits: number
  requestedWorkPfDays: number
  priority?: number
  /** Runtime success after admission, e.g. failures/timeouts. */
  serviceFactor?: number
  /** Fraction of successful native units eligible for usage billing. */
  billingFactor?: number
}

export interface ComputeLedgerRow extends ComputeWorkItem {
  admittedUnits: number
  admittedWorkPfDays: number
  servedUnits: number
  servedWorkPfDays: number
  billedUnits: number
  billedWorkPfDays: number
  admitFraction: number
  serveFraction: number
}

export interface ComputeLedger {
  capacityPfDays: number
  usableCapacityPfDays: number
  headroomPfDays: number
  requestedUnits: number
  admittedUnits: number
  servedUnits: number
  billedUnits: number
  requestedWorkPfDays: number
  admittedWorkPfDays: number
  servedWorkPfDays: number
  billedWorkPfDays: number
  reservedWorkPfDays: number
  backfilledWorkPfDays: number
  unservedRatio: number
  rows: ComputeLedgerRow[]
}

export interface SettleComputeLedgerOptions {
  capacityPfDays: number
  headroom?: number
  /** Guaranteed channel shares; unused reservations automatically backfill. */
  reservations?: Readonly<Record<string, number>>
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function allocateWeighted(
  items: readonly ComputeWorkItem[],
  capacity: number,
  allocations: Map<string, number>,
): number {
  let pool = finiteNonNegative(capacity)
  for (let pass = 0; pass < items.length + 2 && pool > 1e-12; pass += 1) {
    const active = items.filter((item) => {
      const allocated = allocations.get(item.id) ?? 0
      return finiteNonNegative(item.requestedWorkPfDays) - allocated > 1e-12
    })
    if (active.length === 0) break
    const totalWeight = active.reduce(
      (sum, item) => sum + Math.max(1, finiteNonNegative(item.priority ?? 50)),
      0,
    )
    const passPool = pool
    let spent = 0
    for (const item of active) {
      const already = allocations.get(item.id) ?? 0
      const need = Math.max(0, finiteNonNegative(item.requestedWorkPfDays) - already)
      const share =
        passPool * (Math.max(1, finiteNonNegative(item.priority ?? 50)) / totalWeight)
      const allocation = Math.min(need, share)
      allocations.set(item.id, already + allocation)
      spent += allocation
    }
    if (spent <= 1e-12) break
    pool = Math.max(0, pool - spent)
  }
  return pool
}

/**
 * Settle requested → admitted → served → billed work without creating or
 * double-counting either native units or PF-days. Reservations are guarantees,
 * not hard partitions: every unused channel slice is backfilled in the same tick.
 */
export function settleComputeLedger(
  items: readonly ComputeWorkItem[],
  options: SettleComputeLedgerOptions,
): ComputeLedger {
  const ids = new Set<string>()
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Duplicate compute work id: ${item.id}`)
    ids.add(item.id)
  }

  const capacityPfDays = finiteNonNegative(options.capacityPfDays)
  const headroom = Math.max(0, Number.isFinite(options.headroom ?? DEFAULT_SERVE_HEADROOM)
    ? options.headroom ?? DEFAULT_SERVE_HEADROOM
    : DEFAULT_SERVE_HEADROOM)
  const usableCapacityPfDays = capacityPfDays / (1 + headroom)
  const allocations = new Map(items.map((item) => [item.id, 0]))
  const reservations = options.reservations ?? {}
  const reservationTotal = Object.values(reservations).reduce(
    (sum, share) => sum + finiteNonNegative(share),
    0,
  )
  const reservationScale = reservationTotal > 1 ? 1 / reservationTotal : 1

  for (const [channel, rawShare] of Object.entries(reservations)) {
    const channelItems = items.filter((item) => item.channel === channel)
    if (channelItems.length === 0) continue
    allocateWeighted(
      channelItems,
      usableCapacityPfDays * finiteNonNegative(rawShare) * reservationScale,
      allocations,
    )
  }

  const allocatedAfterReservations = [...allocations.values()].reduce(
    (sum, work) => sum + work,
    0,
  )
  allocateWeighted(
    items,
    Math.max(0, usableCapacityPfDays - allocatedAfterReservations),
    allocations,
  )

  const rows = items.map((item): ComputeLedgerRow => {
    const requestedUnits = finiteNonNegative(item.requestedUnits)
    const requestedWorkPfDays = finiteNonNegative(item.requestedWorkPfDays)
    const admittedWorkPfDays = Math.min(
      requestedWorkPfDays,
      finiteNonNegative(allocations.get(item.id) ?? 0),
    )
    const admitFraction =
      requestedWorkPfDays > 1e-12 ? admittedWorkPfDays / requestedWorkPfDays : 1
    const admittedUnits = requestedUnits * admitFraction
    const serviceFactor = Math.min(1, finiteNonNegative(item.serviceFactor ?? 1))
    const billingFactor = Math.min(1, finiteNonNegative(item.billingFactor ?? 1))
    const servedUnits = admittedUnits * serviceFactor
    const servedWorkPfDays = admittedWorkPfDays * serviceFactor
    const billedUnits = servedUnits * billingFactor
    const billedWorkPfDays = servedWorkPfDays * billingFactor
    return {
      ...item,
      requestedUnits,
      requestedWorkPfDays,
      admittedUnits,
      admittedWorkPfDays,
      servedUnits,
      servedWorkPfDays,
      billedUnits,
      billedWorkPfDays,
      admitFraction,
      serveFraction: requestedUnits > 1e-12 ? servedUnits / requestedUnits : 1,
    }
  })

  const sum = (key: keyof ComputeLedgerRow) => rows.reduce((total, row) => {
    const value = row[key]
    return total + (typeof value === 'number' ? value : 0)
  }, 0)
  const requestedUnits = sum('requestedUnits')
  const servedUnits = sum('servedUnits')
  const requestedWorkPfDays = sum('requestedWorkPfDays')
  const admittedWorkPfDays = sum('admittedWorkPfDays')

  return {
    capacityPfDays,
    usableCapacityPfDays,
    headroomPfDays: capacityPfDays - usableCapacityPfDays,
    requestedUnits,
    admittedUnits: sum('admittedUnits'),
    servedUnits,
    billedUnits: sum('billedUnits'),
    requestedWorkPfDays,
    admittedWorkPfDays,
    servedWorkPfDays: sum('servedWorkPfDays'),
    billedWorkPfDays: sum('billedWorkPfDays'),
    reservedWorkPfDays: Math.min(usableCapacityPfDays, allocatedAfterReservations),
    backfilledWorkPfDays: Math.max(0, admittedWorkPfDays - allocatedAfterReservations),
    unservedRatio: requestedUnits > 1e-12
      ? Math.max(0, 1 - servedUnits / requestedUnits)
      : requestedWorkPfDays > 1e-12
        ? Math.max(0, 1 - admittedWorkPfDays / requestedWorkPfDays)
        : 0,
    rows,
  }
}

export function ledgerRowsForChannel(
  ledger: ComputeLedger,
  channel: ComputeWorkChannel,
): ComputeLedgerRow[] {
  return ledger.rows.filter((row) => row.channel === channel)
}

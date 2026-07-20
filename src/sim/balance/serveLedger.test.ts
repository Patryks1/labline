import { describe, expect, it } from 'vitest'
import { settleComputeLedger } from './serveLedger'

describe('serving compute ledger', () => {
  it('conserves requested, admitted, served, and billed units and work', () => {
    const ledger = settleComputeLedger(
      [
        {
          id: 'api-a',
          channel: 'api',
          requestedUnits: 100,
          requestedWorkPfDays: 10,
          priority: 70,
        },
        {
          id: 'plan-a',
          channel: 'subscription',
          requestedUnits: 200,
          requestedWorkPfDays: 20,
          priority: 50,
          serviceFactor: 0.9,
          billingFactor: 0.8,
        },
      ],
      { capacityPfDays: 12.5, headroom: 0.25 },
    )

    expect(ledger.usableCapacityPfDays).toBe(10)
    expect(ledger.admittedWorkPfDays).toBeCloseTo(10, 12)
    expect(ledger.servedWorkPfDays).toBeLessThanOrEqual(ledger.admittedWorkPfDays)
    expect(ledger.billedWorkPfDays).toBeLessThanOrEqual(ledger.servedWorkPfDays)
    expect(ledger.servedUnits).toBeLessThanOrEqual(ledger.admittedUnits)
    expect(ledger.admittedUnits).toBeLessThanOrEqual(ledger.requestedUnits)
  })

  it('backfills unused channel reservations', () => {
    const ledger = settleComputeLedger(
      [
        {
          id: 'api-small',
          channel: 'api',
          requestedUnits: 10,
          requestedWorkPfDays: 1,
        },
        {
          id: 'plan-large',
          channel: 'subscription',
          requestedUnits: 100,
          requestedWorkPfDays: 10,
        },
      ],
      {
        capacityPfDays: 10,
        headroom: 0,
        reservations: { api: 0.8, subscription: 0.2 },
      },
    )

    expect(ledger.rows.find((row) => row.id === 'api-small')?.serveFraction).toBe(1)
    expect(ledger.rows.find((row) => row.id === 'plan-large')?.servedWorkPfDays).toBeCloseTo(9, 12)
    expect(ledger.admittedWorkPfDays).toBeCloseTo(10, 12)
  })

  it('rejects duplicate identities so work cannot be billed twice', () => {
    expect(() => settleComputeLedger(
      [
        { id: 'same', channel: 'api', requestedUnits: 1, requestedWorkPfDays: 1 },
        { id: 'same', channel: 'api', requestedUnits: 1, requestedWorkPfDays: 1 },
      ],
      { capacityPfDays: 2 },
    )).toThrow(/Duplicate compute work id/)
  })
})

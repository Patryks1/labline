import { describe, expect, it } from 'vitest'
import { createGame } from '../../../sim/createGame'
import type { FinanceDaySnapshot } from '../../../sim/types'
import {
  buildFinanceDashboardModel,
  mergeCurrentFinanceHistory,
  selectFinanceDashboardReadouts,
} from './financeDashboardModel'

function snapshot(day: number, net: number): FinanceDaySnapshot {
  return {
    day,
    cash: 1_000,
    revenue: 100,
    productCogs: 20,
    opex: 80,
    energy: 10,
    net,
    share: 0.2,
    servedMTok: 2,
    demandMTok: 3,
    effectivePf: 4,
    valuation: 5_000,
    brand: 50,
  }
}

describe('buildFinanceDashboardModel', () => {
  it('merges the authoritative current day without double-counting display rows', () => {
    const initial = createGame(8_210)
    const state = {
      ...initial,
      day: 4,
      financeHistory: [snapshot(4, -999)],
      player: {
        ...initial.player,
        cash: 9_000,
        brandTrust: 61,
        finance: {
          ...initial.player.finance,
          cash: 9_000,
          dayRevenue: 100,
          dayCogs: 20,
          dayTotalOut: 92.5,
          dayNet: 7.5,
          debtOutstanding: 1_250,
          apiRevenue: 40,
          subRevenue: 30,
          enterpriseRevenue: 10,
          valuation: 5_000,
        },
      },
    }

    const model = buildFinanceDashboardModel(state)

    expect(model.current.net).toBe(7.5)
    expect(model.current.share).toBe(0)
    expect(model.current.valuation).toBe(5_000)
    expect(model.current.debtOutstanding).toBe(1_250)
    expect(model.costs.totalCashOut).toBe(92.5)
    expect(model.costs.operatingCashOut).toBe(72.5)
    expect(model.costs.productCogs).toBe(20)
    expect(model.revenue.total).toBe(100)
    expect(model.revenue.other).toBe(20)
    expect(model.current.runwayDays).toBe(Infinity)
    expect(model.history).toHaveLength(1)
    expect(model.history[0]?.net).toBe(7.5)
    expect(model.history[0]?.cash).toBe(9_000)
  })

  it('does not invent a history point before the simulation has recorded one', () => {
    const initial = createGame(8_211)
    const model = buildFinanceDashboardModel(initial)
    expect(model.history).toEqual([])
  })

  it('normalizes legacy finance rows when day net or total outflow is absent', () => {
    const initial = createGame(8_212)
    const state = {
      ...initial,
      player: {
        ...initial.player,
        finance: {
          ...initial.player.finance,
          dayRevenue: 100,
          dayCogs: 20,
          dayEnergyCost: 10,
          dayNet: undefined as unknown as number,
          dayTotalOut: undefined as unknown as number,
        },
      },
    }

    const model = buildFinanceDashboardModel(state)

    expect(model.current.net).toBe(70)
    expect(model.costs.totalCashOut).toBe(30)
    expect(model.costs.operatingCashOut).toBe(10)
    expect(model.current.runwayDays).toBe(Infinity)
  })

  it('derives missing total outflow from an authoritative net value', () => {
    const initial = createGame(8_213)
    const state = {
      ...initial,
      player: {
        ...initial.player,
        finance: {
          ...initial.player.finance,
          dayRevenue: 100,
          dayNet: 35,
          dayTotalOut: undefined as unknown as number,
        },
      },
    }

    const model = buildFinanceDashboardModel(state)

    expect(model.current.net).toBe(35)
    expect(model.costs.totalCashOut).toBe(65)
  })

  it('keeps current finance readouts and plan history on the same simulation day', () => {
    const initial = createGame(8_214)
    const state = {
      ...initial,
      day: 6,
      financeHistory: [snapshot(6, -40)],
      planStatsHistory: [{ day: 6, plans: [] }],
      player: {
        ...initial.player,
        cash: 12_000,
        finance: {
          ...initial.player.finance,
          cash: 12_000,
          totalShare: 0.37,
          valuation: 8_500,
          dayRevenue: 120,
          dayNet: 15,
          dayTotalOut: 105,
        },
      },
    }

    const readouts = selectFinanceDashboardReadouts(state)
    const model = buildFinanceDashboardModel(state)

    expect(readouts.current.cash).toBe(12_000)
    expect(readouts.current.share).toBe(0.37)
    expect(readouts.current.valuation).toBe(8_500)
    expect(readouts.current.debtOutstanding).toBe(0)
    expect(model.history).toHaveLength(1)
    expect(model.history[0]?.net).toBe(15)
    expect(model.planHistory).toHaveLength(1)
    expect(model.planHistory[0]?.day).toBe(6)
  })
})

describe('mergeCurrentFinanceHistory', () => {
  it('replaces the latest same-day row and bounds appended history', () => {
    const history = Array.from({ length: 181 }, (_, index) => snapshot(index + 1, index))
    const merged = mergeCurrentFinanceHistory(history, snapshot(181, 999))
    expect(merged).toHaveLength(180)
    expect(merged.at(-1)?.day).toBe(181)
    expect(merged.at(-1)?.net).toBe(999)
  })
})

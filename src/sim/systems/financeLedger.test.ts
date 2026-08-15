import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { tickDay } from '../tick'
import {
  acceptDataSupplierOffer,
  listDataSupplierOffers,
  tickDataSupplierContracts,
} from './data'
import {
  chargeExpense,
  recordCashSpend,
  resetDayLedgerCosts,
} from './financeLedger'
import { tickMarket } from './market'

describe('finance ledger', () => {
  it('records data supplier spend in dayTotalOut and dayNet', () => {
    let state = createGame(9_101)
    state = resetDayLedgerCosts(state)
    const offer = listDataSupplierOffers(state)[0]
    expect(offer).toBeTruthy()
    const price = offer!.dailyPrice
    const cashBefore = state.player.cash
    const netBefore = state.player.finance.dayNet
    const outBefore = state.player.finance.dayTotalOut

    state = acceptDataSupplierOffer(state, offer!.id)
    // Signing reserves the desk; first-day spend settles on the next tick.
    expect(state.player.cash).toBeCloseTo(cashBefore, 5)
    expect(state.player.dataSupplierContracts?.some((c) => c.status === 'accepted')).toBe(true)

    state = tickDataSupplierContracts({ ...state, day: state.day + 1 })
    expect(state.player.cash).toBeCloseTo(cashBefore - price, 5)
    expect(state.player.finance.dayDataCost).toBeCloseTo(price, 5)
    expect(state.player.finance.dayTotalOut).toBeCloseTo(outBefore + price, 5)
    expect(state.player.finance.dayNet).toBeCloseTo(netBefore - price, 5)
  })

  it('folds training burn into market dayTotalOut / dayNet / runway', () => {
    let state = createGame(9_102)
    state = resetDayLedgerCosts(state)
    const burn = 250_000
    state = chargeExpense(state, burn, 'training')
    expect(state.player.finance.dayTrainingCost).toBeCloseTo(burn, 5)
    expect(state.player.finance.dayTotalOut).toBeGreaterThanOrEqual(burn)

    const settled = tickMarket(state)
    expect(settled.player.finance.dayTrainingCost).toBeCloseTo(burn, 5)
    expect(settled.player.finance.dayTotalOut).toBeGreaterThanOrEqual(burn)
    expect(settled.player.finance.dayNet).toBeLessThanOrEqual(
      settled.player.finance.dayRevenue - burn,
    )
    if (settled.player.finance.dayNet < 0) {
      expect(settled.player.finance.runwayDays).toBeCloseTo(
        settled.player.cash / Math.max(1, -settled.player.finance.dayNet),
        5,
      )
    }
  })

  it('does not double-count ledger spends when market settles cash', () => {
    let state = createGame(9_103)
    state = resetDayLedgerCosts(state)
    const amount = 100_000
    state = chargeExpense(state, amount, 'data')
    const cashAfterSpend = state.player.cash

    const settled = tickMarket(state)
    const marketOnlyDelta =
      settled.player.finance.dayRevenue -
      (settled.player.finance.dayEnergyCost +
        settled.player.finance.dayWageCost +
        settled.player.finance.dayMarketing +
        settled.player.finance.dayBuildingOpex +
        (settled.player.computeLeaseCostToday ?? 0))
    expect(settled.player.cash).toBeCloseTo(cashAfterSpend + marketOnlyDelta, 0)
    expect(settled.player.finance.dayDataCost).toBeCloseTo(amount, 5)
    expect(settled.player.finance.dayTotalOut).toBeGreaterThanOrEqual(amount)
  })

  it('keeps day ledger categories across a full tickDay', () => {
    let state = createGame(9_104)
    const offer = listDataSupplierOffers(state)[0]
    expect(offer).toBeTruthy()
    state = acceptDataSupplierOffer(state, offer!.id)
    state = {
      ...state,
      player: {
        ...state.player,
        cash: Math.max(state.player.cash, offer!.dailyPrice * 5),
        dataSupplierContracts: (state.player.dataSupplierContracts ?? []).map(
          (contract) => ({
            ...contract,
            status: 'active' as const,
            daysRemaining: Math.max(2, contract.daysRemaining),
          }),
        ),
      },
    }

    const before = state.player.cash
    state = tickDay(state)
    const dataCost = state.player.finance.dayDataCost ?? 0
    expect(dataCost).toBeGreaterThan(0)
    expect(state.player.finance.dayTotalOut).toBeGreaterThanOrEqual(dataCost)
    expect(state.player.cash).toBeLessThan(before)
    expect(state.player.finance.dayNet).toBeLessThanOrEqual(
      state.player.finance.dayRevenue - dataCost,
    )
  })

  it('recordCashSpend updates ledger without a second cash deduction', () => {
    let state = createGame(9_105)
    state = resetDayLedgerCosts(state)
    const cash = state.player.cash - 50_000
    state = {
      ...state,
      player: { ...state.player, cash },
    }
    state = recordCashSpend(state, 50_000, 'training')
    expect(state.player.cash).toBe(cash)
    expect(state.player.finance.dayTrainingCost).toBe(50_000)
    expect(state.player.finance.dayTotalOut).toBe(50_000)
    expect(state.player.finance.dayNet).toBe(-50_000)
  })
})

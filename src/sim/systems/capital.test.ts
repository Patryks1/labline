import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import {
  acceptEquityOffer,
  applyForDebt,
  applyForLabDebt,
  capitalSnapshot,
  repayDebt,
  requestEquityOffers,
  tickCapital,
} from './capital'

describe('capital stack', () => {
  it('calculates exact post-money ownership', () => {
    const state = createGame(31)
    const beforeRevenue = state.player.finance.lifetimeRevenue
    const next = acceptEquityOffer(state, {
      id: 'test-round',
      investorName: 'Test Capital',
      cashRaised: 10_000_000,
      preMoneyValuation: 40_000_000,
      postMoneyValuation: 50_000_000,
      investorOwnership: 0.2,
      optionPoolTopUp: 0,
      confidenceRequired: 0,
      expiresDay: 30,
    })
    const stake = next.player.capital!.capTable.find((item) => item.holderId === 'test-round')
    expect(stake?.ownership).toBeCloseTo(0.2, 12)
    expect(next.player.capital!.capTable.reduce((sum, item) => sum + item.ownership, 0)).toBeCloseTo(1, 12)
    expect(next.player.finance.lifetimeRevenue).toBe(beforeRevenue)
    expect(next.player.cash).toBe(state.player.cash + 10_000_000)
  })

  it('keeps seed ownership normalized', () => {
    const state = createGame(32)
    const snapshot = capitalSnapshot(state)
    expect(snapshot.founderOwnership).toBeCloseTo(0.675)
    expect(snapshot.investorOwnership).toBeCloseTo(0.25)
    expect(snapshot.optionPool).toBeCloseTo(0.075)
  })

  it('venture debt adds cash but never revenue', () => {
    const state = createGame(33)
    const next = applyForDebt(state, 'venture_debt', 2_000_000)
    expect(next.player.cash).toBe(state.player.cash + 2_000_000)
    expect(next.player.finance.dayRevenue).toBe(state.player.finance.dayRevenue)
    expect(next.player.finance.lifetimeRevenue).toBe(state.player.finance.lifetimeRevenue)
    expect(next.player.capital?.debt[0]?.kind).toBe('venture_debt')
  })

  it('uses the same typed debt and recovery ledger for rivals', () => {
    const state = createGame(331)
    const rival = state.rivals[0]!
    const funded = applyForLabDebt(state, rival.id, 'venture_debt', 2_000_000)
    const afterFunding = funded.rivals.find((candidate) => candidate.id === rival.id)!
    expect(afterFunding.cash).toBeGreaterThan(rival.cash)
    expect(afterFunding.finance?.lifetimeRevenue).toBe(rival.finance?.lifetimeRevenue)
    expect(afterFunding.capital?.debt[0]?.kind).toBe('venture_debt')

    const ticked = tickCapital(funded)
    const afterTick = ticked.rivals.find((candidate) => candidate.id === rival.id)!
    expect(afterTick.capital?.debt[0]?.remaining).toBeLessThan(
      afterFunding.capital!.debt[0]!.remaining,
    )
    expect(afterTick.finance?.cash).toBeCloseTo(afterTick.cash)
  })

  it('raises and dilutes rival equity through the same exact cap-table path', () => {
    const state = createGame(332)
    const rival = state.rivals[0]!
    const beforeRevenue = rival.finance!.lifetimeRevenue
    const offer = requestEquityOffers(state, rival.id)[0]!
    const funded = acceptEquityOffer(state, offer, rival.id)
    const after = funded.rivals.find((candidate) => candidate.id === rival.id)!
    const investor = after.capital!.capTable.find(
      (stake) => stake.holderId === offer.id,
    )!
    expect(investor.ownership).toBeCloseTo(
      offer.cashRaised / (offer.preMoneyValuation + offer.cashRaised),
      12,
    )
    expect(after.capital!.capTable.reduce((sum, stake) => sum + stake.ownership, 0)).toBeCloseTo(1, 12)
    expect(after.cash).toBeCloseTo(rival.cash + offer.cashRaised)
    expect(after.finance!.lifetimeRevenue).toBe(beforeRevenue)
    expect(after.capital!.fundingRounds).toHaveLength(1)
  })

  it('amortizes and can repay typed debt', () => {
    const funded = applyForDebt(createGame(34), 'venture_debt', 1_000_000)
    const debt = funded.player.capital!.debt[0]!
    const ticked = tickCapital(funded)
    expect(ticked.player.capital!.debt[0]!.remaining).toBeLessThan(debt.remaining)
    const repaid = repayDebt(ticked, debt.id)
    expect(repaid.player.capital!.debt).toHaveLength(0)
  })

  it('rejects collateralized instruments without collateral', () => {
    const state = createGame(35)
    const next = applyForDebt(state, 'equipment', 3_000_000)
    expect(next.player.cash).toBe(state.player.cash)
    expect(next.player.capital?.debt).toHaveLength(0)
  })

  it('advances the recovery ladder before bankruptcy and clears it when stabilized', () => {
    let state = createGame(36)
    state = {
      ...state,
      player: {
        ...state.player,
        cash: -1,
        finance: { ...state.player.finance, runwayDays: 0 },
      },
    }
    state = tickCapital(state)
    expect(state.player.capital?.restructuring.stage).toBe('warning')

    for (const expected of ['refinance', 'asset_sale', 'bankruptcy'] as const) {
      state = {
        ...state,
        player: {
          ...state.player,
          capital: {
            ...state.player.capital!,
            restructuring: { ...state.player.capital!.restructuring, daysLeft: 1 },
          },
        },
      }
      state = tickCapital(state)
      expect(state.player.capital?.restructuring.stage).toBe(expected)
    }

    const warning = tickCapital({
      ...createGame(37),
      player: {
        ...createGame(37).player,
        cash: -1,
        finance: { ...createGame(37).player.finance, runwayDays: 0 },
      },
    })
    const recovered = tickCapital({
      ...warning,
      player: {
        ...warning.player,
        cash: 5_000_000,
        finance: { ...warning.player.finance, runwayDays: 365 },
      },
    })
    expect(recovered.player.capital?.restructuring).toEqual({
      active: false,
      daysLeft: 0,
      stage: 'none',
    })
  })

  it('does not start the player recovery ladder from runway alone', () => {
    const base = createGame(38)
    const next = tickCapital({
      ...base,
      player: {
        ...base.player,
        cash: 1_000_000,
        finance: { ...base.player.finance, cash: 1_000_000, runwayDays: 10 },
      },
    })
    expect(next.player.capital?.restructuring).toEqual({
      active: false,
      daysLeft: 0,
      stage: 'none',
    })
    expect(next.alerts.some((a) => a.message.startsWith('Cash negative'))).toBe(false)
  })
})

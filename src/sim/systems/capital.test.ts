import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { emptyBenchmarks } from '../balance/benchmarks'
import {
  INSTANT_EFFORT_ID,
  emptySpecializationFocus,
  instantRecipe,
} from '../balance/modelProduct'
import type { EffortRecipe, Model, ModelProductProfile } from '../types'
import {
  acceptInvestorPitch,
  acceptEquityOffer,
  applyForDebt,
  applyForLabDebt,
  bankingProducts,
  capitalSnapshot,
  encodeInvestorPitchOptionId,
  investorPitchOptions,
  investorPitchPreview,
  fundRivalForCampus,
  repayDebt,
  requestEquityOffers,
  tickCapital,
} from './capital'
import { updateLab } from './labEngine'

function pitchModel(
  id: string,
  capability: number,
  repeatedDataEpochs = 1,
): Model {
  return {
    id,
    name: id,
    family: 'dense',
    paramsB: 7,
    capability,
    modalities: ['text'],
    quality: {
      reasoning: capability,
      coding: capability,
      chat: capability,
      image: 0,
      video: 0,
      safety: capability,
      reliability: capability,
    },
    benchmarks: emptyBenchmarks(),
    postTrain: 'rlhf',
    trainComputeSpent: 20,
    releaseDay: 1,
    shipped: false,
    release: 'internal',
    tokPerSecMult: 1,
    inferCostMult: 1,
    apiPricePerMTok: null,
    apiPriceInPerMTok: null,
    apiPriceOutPerMTok: null,
    suggestedApiPrice: 2,
    suggestedApiPriceIn: 0.7,
    suggestedApiPriceOut: 3,
    costApiPriceIn: 0.2,
    costApiPriceOut: 0.8,
    distilled: false,
    trainMode: 'pretrain',
    repeatedDataEpochs,
  }
}

function trainedHead(
  id: string,
  name: string,
  thinkingTokenMult: number,
): EffortRecipe {
  return {
    id,
    name,
    kind: 'trained',
    thinkingTokenMult,
    trainPfDays: 20,
    trainCash: 1,
    trained: true,
    quality: 1,
    served: true,
  }
}

function profileWithHeads(...heads: EffortRecipe[]): ModelProductProfile {
  return {
    lifecycle: 'reasoning',
    focus: emptySpecializationFocus(),
    personality: 40,
    tokenEfficiency: 50,
    effortRecipes: [instantRecipe(), ...heads],
    defaultEffortId: INSTANT_EFFORT_ID,
  }
}

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

  it('compounds founder voting dilution across repeated funding rounds', () => {
    const state = createGame(311)
    const initialControl = state.player.capital!.founderControl
    const first = acceptEquityOffer(state, {
      id: 'round-one',
      investorName: 'First Capital',
      cashRaised: 20_000_000,
      preMoneyValuation: 80_000_000,
      postMoneyValuation: 100_000_000,
      investorOwnership: 0.2,
      optionPoolTopUp: 0,
      confidenceRequired: 0,
      expiresDay: 30,
    })
    const second = acceptEquityOffer(first, {
      id: 'round-two',
      investorName: 'Second Capital',
      cashRaised: 20_000_000,
      preMoneyValuation: 80_000_000,
      postMoneyValuation: 100_000_000,
      investorOwnership: 0.2,
      optionPoolTopUp: 0,
      confidenceRequired: 0,
      expiresDay: 30,
    })

    expect(second.player.capital!.founderControl).toBeCloseTo(
      initialControl * 0.8 * 0.8,
      12,
    )
    expect(
      second.player.capital!.capTable
        .filter((stake) => stake.kind === 'founder')
        .reduce((sum, stake) => sum + stake.votingPower, 0),
    ).toBeCloseTo(initialControl * 0.8 * 0.8, 12)
  })

  it('keeps seed ownership normalized', () => {
    const state = createGame(32)
    const snapshot = capitalSnapshot(state)
    expect(snapshot.founderOwnership).toBeCloseTo(0.675)
    expect(snapshot.investorOwnership).toBeCloseTo(0.25)
    expect(snapshot.optionPool).toBeCloseTo(0.075)
  })

  it('previews model-backed terms and penalizes weak, overused weights', () => {
    const state = createGame(3201)
    const strong = pitchModel('frontier-internal', 92)
    const weak = pitchModel('overused-small', 24, 7)
    const prepared = updateLab(state, state.playerLabId, (lab) => ({
      ...lab,
      models: [strong, weak],
    }))
    const strongPreview = investorPitchPreview(prepared, strong.id)
    const weakPreview = investorPitchPreview(prepared, weak.id)
    expect(strongPreview.eligible).toBe(true)
    expect(strongPreview.successChance).toBeGreaterThan(weakPreview.successChance)
    expect(strongPreview.cashRaised).toBeGreaterThan(weakPreview.cashRaised)
    expect(strongPreview.investorOwnership).toBeLessThan(weakPreview.investorOwnership)
    expect(weakPreview.overusePenalty).toBeGreaterThan(0.5)
  })

  it('recalculates model-pitch chance, dilution, and data drag for a custom ask', () => {
    const state = createGame(32011)
    const model = pitchModel('negotiable-frontier', 92, 2)
    const prepared = updateLab(state, state.playerLabId, (lab) => ({
      ...lab,
      models: [model],
    }))
    const suggested = investorPitchPreview(prepared, model.id)
    const low = investorPitchPreview(
      prepared,
      model.id,
      prepared.playerLabId,
      suggested.minimumCashRaised,
    )
    const high = investorPitchPreview(
      prepared,
      model.id,
      prepared.playerLabId,
      suggested.maximumCashRaised,
    )

    expect(low.cashRaised).toBe(suggested.minimumCashRaised)
    expect(high.cashRaised).toBe(suggested.maximumCashRaised)
    expect(high.postMoneyValuation).toBe(
      high.preMoneyValuation + high.cashRaised,
    )
    expect(high.investorOwnership).toBeGreaterThan(low.investorOwnership)
    expect(high.successChance).toBeLessThan(low.successChance)
    expect(high.dataDrag).toBeGreaterThan(low.dataDrag)
  })

  it('settles and records the exact custom model-pitch amount', () => {
    const model = pitchModel('custom-pitchable', 94)
    let funded: ReturnType<typeof createGame> | undefined
    for (let seed = 32_020; seed < 32_100 && !funded; seed += 1) {
      const state = createGame(seed)
      const prepared = updateLab(state, state.playerLabId, (lab) => ({
        ...lab,
        models: [model],
      }))
      const suggested = investorPitchPreview(prepared, model.id)
      const amount = suggested.minimumCashRaised + 123_456
      const quote = investorPitchPreview(
        prepared,
        model.id,
        prepared.playerLabId,
        amount,
      )
      const resolved = acceptInvestorPitch(
        prepared,
        model.id,
        prepared.playerLabId,
        amount,
      )
      const record = resolved.player.capital?.pitchHistory?.[0]
      if (record?.outcome === 'funded') {
        funded = resolved
        const round = resolved.player.capital?.fundingRounds.at(-1)
        const stake = resolved.player.capital?.capTable.find(
          (item) => item.holderId === record.id,
        )
        expect(resolved.player.cash).toBe(prepared.player.cash + amount)
        expect(record.requestedCashRaised).toBe(amount)
        expect(record.cashRaised).toBe(amount)
        expect(record.dataDrag).toBe(quote.dataDrag)
        expect(round?.cashRaised).toBe(amount)
        expect(round?.postMoneyValuation).toBe(
          quote.preMoneyValuation + amount,
        )
        expect(stake?.ownership).toBeCloseTo(quote.investorOwnership, 12)
      }
    }
    expect(funded).toBeDefined()
  })

  it('rejects an out-of-range model-pitch amount before consuming the pitch', () => {
    const state = createGame(32012)
    const model = pitchModel('bounded-pitch', 92)
    const prepared = updateLab(state, state.playerLabId, (lab) => ({
      ...lab,
      models: [model],
    }))
    const preview = investorPitchPreview(prepared, model.id)
    const resolved = acceptInvestorPitch(
      prepared,
      model.id,
      prepared.playerLabId,
      preview.maximumCashRaised + 1,
    )

    expect(resolved.player.cash).toBe(prepared.player.cash)
    expect(resolved.player.capital?.pitchHistory).toEqual([])
    expect(resolved.alerts[0]?.message).toContain('Choose a raise between')
  })

  it('lists Instant-only models as a single pitch option', () => {
    const state = createGame(3202)
    const model = {
      ...pitchModel('solace-instant', 26),
      name: 'Solace',
      release: 'released' as const,
      shipped: true,
    }
    const prepared = updateLab(state, state.playerLabId, (lab) => ({
      ...lab,
      models: [model],
    }))
    const options = investorPitchOptions(prepared)
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      modelId: model.id,
      effortId: INSTANT_EFFORT_ID,
      effortName: 'Instant',
      name: 'Solace',
      label: 'Solace · cap 26 · released',
    })
    expect(options[0]?.label).not.toContain('Instant')
  })

  it('expands named thinking heads and prices Think/Deep above Instant', () => {
    const state = createGame(3203)
    const model = {
      ...pitchModel('solace', 40),
      name: 'Solace',
      release: 'released' as const,
      shipped: true,
      productProfile: profileWithHeads(
        trainedHead('medium', 'Think', 2.2),
        trainedHead('high', 'Deep', 4.5),
      ),
    }
    const prepared = updateLab(state, state.playerLabId, (lab) => ({
      ...lab,
      models: [model],
    }))
    const options = investorPitchOptions(prepared)
    expect(options.map((option) => option.label)).toEqual([
      expect.stringMatching(/^Solace-Deep · cap \d+ · released$/),
      expect.stringMatching(/^Solace-Think · cap \d+ · released$/),
      'Solace-Instant · cap 40 · released',
    ])
    const instant = options.find((option) => option.effortId === INSTANT_EFFORT_ID)!
    const think = options.find((option) => option.effortName === 'Think')!
    const deep = options.find((option) => option.effortName === 'Deep')!
    expect(think.capability).toBeGreaterThan(instant.capability)
    expect(deep.capability).toBeGreaterThan(think.capability)

    const instantPreview = investorPitchPreview(prepared, instant.id)
    const thinkPreview = investorPitchPreview(prepared, think.id)
    const deepPreview = investorPitchPreview(prepared, deep.id)
    expect(instantPreview.effortId).toBe(INSTANT_EFFORT_ID)
    expect(thinkPreview.effortId).toBe('medium')
    expect(thinkPreview.capability).toBeGreaterThan(instantPreview.capability)
    expect(thinkPreview.successChance).toBeGreaterThan(instantPreview.successChance)
    expect(thinkPreview.cashRaised).toBeGreaterThan(instantPreview.cashRaised)
    expect(deepPreview.successChance).toBeGreaterThan(thinkPreview.successChance)
    expect(deepPreview.cashRaised).toBeGreaterThan(thinkPreview.cashRaised)
    expect(investorPitchPreview(prepared, model.id).id).toBe(
      encodeInvestorPitchOptionId(model.id, INSTANT_EFFORT_ID),
    )
  })

  it('persists the disclosed thinking head on a resolved pitch', () => {
    const model = {
      ...pitchModel('solace-think-pitch', 88),
      name: 'Solace',
      productProfile: profileWithHeads(trainedHead('medium', 'Think', 2.2)),
    }
    const optionId = encodeInvestorPitchOptionId(model.id, 'medium')
    let funded: ReturnType<typeof createGame> | undefined
    for (let seed = 3_280; seed < 3_360 && !funded; seed += 1) {
      const state = createGame(seed)
      const prepared = updateLab(state, state.playerLabId, (lab) => ({
        ...lab,
        models: [model],
      }))
      const resolved = acceptInvestorPitch(prepared, optionId)
      const record = resolved.player.capital?.pitchHistory?.[0]
      if (record?.outcome === 'funded') {
        funded = resolved
        expect(record.effortId).toBe('medium')
        expect(record.modelName).toBe('Solace-Think')
        expect(record.modelId).toBe(model.id)
      }
    }
    expect(funded).toBeDefined()
  })

  it('resolves a seeded pitch into cash, cap-table dilution, and a cooldown', () => {
    const model = pitchModel('pitchable', 88)
    let funded: ReturnType<typeof createGame> | undefined
    for (let seed = 3_210; seed < 3_260 && !funded; seed += 1) {
      const state = createGame(seed)
      const prepared = updateLab(state, state.playerLabId, (lab) => ({
        ...lab,
        models: [model],
      }))
      const preview = investorPitchPreview(prepared, model.id)
      const resolved = acceptInvestorPitch(prepared, model.id)
      if (
        resolved.player.capital?.pitchHistory?.[0]?.outcome === 'funded'
      ) {
        funded = resolved
        expect(resolved.player.cash).toBe(prepared.player.cash + preview.cashRaised)
        expect(resolved.player.capital?.fundingRounds.at(-1)?.id).toBe(
          `pitch-${model.id}-1`,
        )
        expect(resolved.player.capital?.pitchCooldownUntilDay).toBe(31)
        expect(resolved.player.capital?.capTable.some((stake) => stake.holderId === `pitch-${model.id}-1`)).toBe(true)
      }
    }
    expect(funded).toBeDefined()
  })

  it('does not allow a second pitch during the desk cooldown', () => {
    const model = pitchModel('cooldown-model', 82)
    const state = createGame(3_270)
    const prepared = updateLab(state, state.playerLabId, (lab) => ({
      ...lab,
      models: [model],
    }))
    const first = acceptInvestorPitch(prepared, model.id)
    const second = acceptInvestorPitch(first, model.id)
    expect(second.player.capital?.pitchHistory).toHaveLength(1)
    expect(second.alerts[0]?.message).toContain('cooling down')
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

  it('recognizes compact-world data centers as project-finance collateral', () => {
    const state = createGame(351)
    const rivalHall = state.map.world!.queryFacilities({ kind: 'dc' })[0]!
    state.map.world!.beginBatch().updateFacility(rivalHall.id, {
      ownerId: state.playerLabId,
    }).commit()

    const projectFinance = bankingProducts(state).find(
      (product) => product.kind === 'project_finance',
    )!
    expect(projectFinance.max).toBeGreaterThan(0)
    expect(projectFinance.collateral).toBeGreaterThan(0)
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

  it('opens a 30-day asset-sale window at the insolvency floor instead of ending the run', () => {
    const base = createGame(39)
    const insolvent = {
      ...base,
      player: {
        ...base.player,
        cash: -500_000_000,
        finance: { ...base.player.finance, cash: -500_000_000, runwayDays: 0 },
      },
    }
    const next = tickCapital(insolvent)
    expect(next.player.capital?.restructuring).toEqual({
      active: true,
      daysLeft: 30,
      stage: 'asset_sale',
    })
    expect(next.victory.outcome).toBe('playing')

    const lastDay = tickCapital({
      ...next,
      player: {
        ...next.player,
        cash: -500_000_000,
        capital: {
          ...next.player.capital!,
          restructuring: { active: true, daysLeft: 1, stage: 'asset_sale' },
        },
      },
    })
    expect(lastDay.player.capital?.restructuring.stage).toBe('bankruptcy')
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

  it('scales equity cheques with valuation so a hall is fundable', () => {
    const state = createGame(410)
    const rival = state.rivals[0]!
    const offers = requestEquityOffers(state, rival.id)
    expect(offers[0]!.cashRaised).toBeGreaterThanOrEqual(12_000_000)
    expect(offers[2]!.cashRaised).toBeGreaterThanOrEqual(55_000_000)
    expect(offers[2]!.cashRaised).toBeGreaterThan(offers[0]!.cashRaised)
  })

  it('funds a cash-poor rival with equity or campus debt before a hall', () => {
    const state = createGame(411)
    const rival = state.rivals[0]!
    const broke = updateLab(state, rival.id, (lab) => ({
      ...lab,
      cash: 1_000_000,
      finance: { ...lab.finance, cash: 1_000_000 },
    }))
    const funded = fundRivalForCampus(broke, rival.id, 128_000_000)
    const after = funded.rivals.find((candidate) => candidate.id === rival.id)!
    expect(after.cash).toBeGreaterThanOrEqual(128_000_000)
    const raised =
      (after.capital?.fundingRounds.length ?? 0) + (after.capital?.debt.length ?? 0)
    expect(raised).toBeGreaterThan(0)
  })
})

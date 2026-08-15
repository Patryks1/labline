import { describe, expect, it } from 'vitest'
import { architecturePretrainingCapabilityCap } from '../balance/architectureFrontiers'
import { buildScaledModel } from '../balance/modelBuild'
import { bentCapabilityCeiling } from '../balance/modelScaling'
import { blendApiPrice } from '../balance/pricing'
import { createGame } from '../createGame'
import { createRng, hashSeed } from '../rng'
import { roundTripState } from '../save'
import type { RivalFinancialComeback, SimState } from '../types'
import {
  rivalDistressRunwayThreshold,
  rivalRestructuringStageDays,
  tickCapital,
} from './capital'
import { updateLab } from './labEngine'
import {
  RIVAL_COMEBACK_CHANCE,
  RIVAL_COMEBACK_COOLDOWN_DAYS,
  RIVAL_COMEBACK_FAILED_COOLDOWN_DAYS,
  maybeStartRivalFinancialComeback,
  releaseDueRivalComebacks,
  rivalComebackProductScore,
} from './rivalComeback'
import { tickRivals } from './rivals'

function seedForBacking(result: 'success' | 'failure'): number {
  for (let seed = 1; seed < 10_000; seed++) {
    const roll = createRng(
      hashSeed(seed, 'rival_nova', 1, 'rival-emergency-backing-v1'),
    ).next()
    if ((roll < RIVAL_COMEBACK_CHANCE) === (result === 'success')) return seed
  }
  throw new Error(`No ${result} seed found`)
}

function publicReference(day: number) {
  return buildScaledModel({
    id: 'public-reference',
    name: 'Public Reference',
    paramsB: 22,
    family: 'dense',
    backbone: 'dense',
    productPreset: 'language',
    day,
    dataCoverage: 8,
    dataQuality: 88,
    researchUnlocked: ['dense_basics', 'align_process'],
    researchMult: 1.16,
    outcomeSeed: 41,
    engineers: 20,
    shipped: true,
    release: 'released',
  })
}

function distressedState(seed: number): SimState {
  let state = createGame(seed)
  const day = 1_000
  const reference = publicReference(day - 30)
  state = {
    ...state,
    day,
    player: { ...state.player, models: [reference] },
  }
  const rival = state.rivals[0]!
  state = updateLab(state, rival.id, (lab) => ({
    ...lab,
    cash: -20_000_000,
    finance: {
      ...lab.finance,
      cash: -20_000_000,
      dayNet: -2_000_000,
      runwayDays: 0,
      lowestCash: Math.min(lab.finance.lowestCash, -20_000_000),
    },
    capital: {
      ...lab.capital!,
      restructuring: { active: true, daysLeft: 20, stage: 'refinance' },
    },
  }))
  const financialComeback: RivalFinancialComeback = {
    distressEpisode: 1,
    cooldownUntilDay: 0,
    status: 'none',
  }
  return {
    ...state,
    rivals: state.rivals.map((candidate) =>
      candidate.id === rival.id
        ? { ...candidate, financialComeback }
        : candidate,
    ),
  }
}

describe('rival emergency backing and comeback release', () => {
  it('rejects a backing roll without a genuine negative-cash or negative-burn crisis', () => {
    let state = createGame(seedForBacking('success'))
    const rival = state.rivals[0]!
    state = updateLab(state, rival.id, (lab) => ({
      ...lab,
      cash: 50_000_000,
      finance: {
        ...lab.finance,
        cash: 50_000_000,
        dayNet: 1_000_000,
        runwayDays: 10,
      },
      capital: {
        ...lab.capital!,
        restructuring: { active: true, daysLeft: 10, stage: 'refinance' },
      },
    }))
    state = {
      ...state,
      rivals: state.rivals.map((candidate) =>
        candidate.id === rival.id
          ? {
              ...candidate,
              financialComeback: {
                distressEpisode: 1,
                cooldownUntilDay: 0,
                status: 'none',
              },
            }
          : candidate,
      ),
    }
    const next = maybeStartRivalFinancialComeback(state, rival.id)
    expect(next).toBe(state)
    expect(next.rivals[0]!.capital!.fundingRounds).toHaveLength(0)
  })

  it('desynchronizes shared distress shocks with deterministic bounded board clocks', () => {
    const seed = 2_026
    const thresholds = [
      'rival_nova',
      'rival_open',
      'rival_sparse',
      'rival_chroma',
      'rival_aegis',
    ].map((id) => rivalDistressRunwayThreshold(seed, id))
    expect(new Set(thresholds).size).toBeGreaterThan(1)
    expect(Math.min(...thresholds)).toBeGreaterThanOrEqual(72)
    expect(Math.max(...thresholds)).toBeLessThanOrEqual(108)

    const warningDays = [
      'rival_nova',
      'rival_open',
      'rival_sparse',
      'rival_chroma',
      'rival_aegis',
    ].map((id) => rivalRestructuringStageDays(seed, id, 'warning', 1))
    expect(new Set(warningDays).size).toBeGreaterThan(1)
    expect(Math.min(...warningDays)).toBeGreaterThanOrEqual(50)
    expect(Math.max(...warningDays)).toBeLessThanOrEqual(75)
    expect(rivalRestructuringStageDays(seed, 'rival_nova', 'refinance', 1)).toBeGreaterThanOrEqual(35)
    expect(rivalRestructuringStageDays(seed, 'rival_nova', 'refinance', 1)).toBeLessThanOrEqual(55)
    expect(rivalRestructuringStageDays(seed, 'rival_nova', 'asset_sale', 1)).toBeGreaterThanOrEqual(22)
    expect(rivalRestructuringStageDays(seed, 'rival_nova', 'asset_sale', 1)).toBeLessThanOrEqual(40)
    expect(rivalRestructuringStageDays(seed, 'rival_nova', 'bankruptcy', 1)).toBe(0)

    let state = createGame(seed)
    for (const rival of state.rivals) {
      state = updateLab(state, rival.id, (lab) => ({
        ...lab,
        cash: -1,
        finance: { ...lab.finance, cash: -1, dayNet: -1, runwayDays: 0 },
      }))
    }
    state = {
      ...state,
      rivals: state.rivals.map((rival) => ({
        ...rival,
        financialComeback: {
          distressEpisode: 0,
          cooldownUntilDay: 10_000,
          status: 'none',
        },
      })),
    }
    const refinanceAt = new Map<string, number>()
    const bankruptcyAt = new Map<string, number>()
    for (let elapsed = 1; elapsed <= 200; elapsed++) {
      state = tickCapital(state)
      for (const rival of state.rivals) {
        const stage = rival.capital?.restructuring.stage
        if (stage === 'refinance' && !refinanceAt.has(rival.id)) {
          refinanceAt.set(rival.id, elapsed)
        }
        if (stage === 'bankruptcy' && !bankruptcyAt.has(rival.id)) {
          bankruptcyAt.set(rival.id, elapsed)
        }
      }
    }
    expect(refinanceAt.size).toBe(state.rivals.length)
    expect(bankruptcyAt.size).toBe(state.rivals.length)
    expect(new Set(refinanceAt.values()).size).toBeGreaterThan(1)
    expect(new Set(bankruptcyAt.values()).size).toBeGreaterThan(1)
  })

  it('books an exact dilutive funding and checkpoint-acquisition ledger', () => {
    const before = distressedState(seedForBacking('success'))
    const rivalBefore = before.rivals[0]!
    const financeBefore = rivalBefore.finance!
    const next = maybeStartRivalFinancialComeback(before, rivalBefore.id)
    const rival = next.rivals[0]!
    const plan = rival.financialComeback!

    expect(plan.status).toBe('announced')
    expect(plan.attemptedEpisode).toBe(1)
    expect(plan.cooldownUntilDay).toBe(before.day + RIVAL_COMEBACK_COOLDOWN_DAYS)
    expect(plan.releaseDay).toBeGreaterThanOrEqual(before.day + 21)
    expect(plan.releaseDay).toBeLessThanOrEqual(before.day + 35)
    expect(plan.targetCapability!).toBeGreaterThanOrEqual(
      plan.referenceFrontierCapability! - 6,
    )
    expect(plan.targetCapability!).toBeLessThanOrEqual(
      plan.referenceFrontierCapability! + 6,
    )

    expect(rival.cash).toBeCloseTo(
      rivalBefore.cash + plan.backingCash! - plan.acquisitionCost!,
      6,
    )
    expect(rival.finance!.cash).toBeCloseTo(rival.cash, 6)
    expect(rival.finance!.dayRevenue).toBe(financeBefore.dayRevenue)
    expect(rival.finance!.lifetimeRevenue).toBe(financeBefore.lifetimeRevenue)
    expect(rival.finance!.dayCapexCost).toBeCloseTo(
      (financeBefore.dayCapexCost ?? 0) + plan.acquisitionCost!,
      6,
    )
    expect(rival.finance!.dayTotalOut).toBeCloseTo(
      financeBefore.dayTotalOut + plan.acquisitionCost!,
      6,
    )
    expect(rival.finance!.dayNet).toBeCloseTo(
      financeBefore.dayNet - plan.acquisitionCost!,
      6,
    )
    expect(rival.finance!.lifetimeNet).toBeCloseTo(
      financeBefore.lifetimeNet - plan.acquisitionCost!,
      6,
    )
    expect(rival.capital!.restructuring).toEqual({
      active: false,
      daysLeft: 0,
      stage: 'none',
    })
    const round = rival.capital!.fundingRounds.at(-1)!
    expect(round.cashRaised).toBe(plan.backingCash)
    expect(round.dilution).toBeCloseTo(
      plan.backingCash! / round.postMoneyValuation,
      12,
    )
    expect(
      rival.capital!.capTable.reduce((sum, stake) => sum + stake.ownership, 0),
    ).toBeCloseTo(1, 12)
    expect(next.news[0]).toContain('commits $')
    expect(next.news[0]).toContain('booked now')
    expect(next.news[0]).toContain(`release due day ${plan.releaseDay}`)

    let repeatCrisis = { ...next, day: before.day + 90 }
    repeatCrisis = updateLab(repeatCrisis, rival.id, (lab) => ({
      ...lab,
      cash: -1,
      finance: { ...lab.finance, cash: -1, dayNet: -1, runwayDays: 0 },
      capital: {
        ...lab.capital!,
        restructuring: { active: true, daysLeft: 10, stage: 'refinance' },
      },
    }))
    repeatCrisis = {
      ...repeatCrisis,
      rivals: repeatCrisis.rivals.map((candidate) =>
        candidate.id === rival.id
          ? {
              ...candidate,
              financialComeback: {
                ...plan,
                distressEpisode: 2,
                status: 'released',
              },
            }
          : candidate,
      ),
    }
    const blockedRepeat = maybeStartRivalFinancialComeback(
      repeatCrisis,
      rival.id,
    )
    expect(blockedRepeat.rivals[0]!.capital!.fundingRounds).toHaveLength(1)
    expect(blockedRepeat.rivals[0]!.financialComeback?.attemptedEpisode).toBe(1)
  })

  it('persists a failed episode roll so waiting or reloading cannot reroll it', () => {
    const before = distressedState(seedForBacking('failure'))
    const first = maybeStartRivalFinancialComeback(before, before.rivals[0]!.id)
    const second = maybeStartRivalFinancialComeback(first, first.rivals[0]!.id)
    const firstRival = first.rivals[0]!
    const secondRival = second.rivals[0]!

    expect(firstRival.financialComeback).toMatchObject({
      distressEpisode: 1,
      attemptedEpisode: 1,
      cooldownUntilDay: before.day + RIVAL_COMEBACK_FAILED_COOLDOWN_DAYS,
      status: 'none',
    })
    expect(secondRival.financialComeback).toEqual(firstRival.financialComeback)
    expect(secondRival.cash).toBe(firstRival.cash)
    expect(secondRival.capital!.fundingRounds).toEqual(
      firstRival.capital!.fundingRounds,
    )
    expect(second.news).toEqual(first.news)
  })

  it('round-trips an announced rescue without changing its immutable release plan', () => {
    const legacyMissingField = roundTripState(createGame(9_901))
    expect(legacyMissingField.rivals[0]!.financialComeback).toEqual({
      distressEpisode: 0,
      attemptedEpisode: undefined,
      cooldownUntilDay: 0,
      status: 'none',
      announcedDay: undefined,
      releaseDay: undefined,
      completedDay: undefined,
      backingCash: undefined,
      acquisitionCost: undefined,
      investorName: undefined,
      modelId: undefined,
      family: undefined,
      backbone: undefined,
      productPreset: undefined,
      paramsB: undefined,
      activeParamsRatio: undefined,
      researchMultiplier: undefined,
      researchUnlocked: undefined,
      dataCoverage: undefined,
      dataQuality: undefined,
      modalityExperience: undefined,
      targetCapability: undefined,
      referenceFrontierCapability: undefined,
    })
    const before = distressedState(seedForBacking('success'))
    const announced = maybeStartRivalFinancialComeback(before, before.rivals[0]!.id)
    const restored = roundTripState(announced)
    expect(restored.rivals[0]!.financialComeback).toEqual(
      announced.rivals[0]!.financialComeback,
    )
  })

  it('ships a compatible near-frontier model with sustainable pricing and fresh routes', () => {
    const before = distressedState(seedForBacking('success'))
    const announced = maybeStartRivalFinancialComeback(before, before.rivals[0]!.id)
    const plan = announced.rivals[0]!.financialComeback!
    const due = { ...announced, day: plan.releaseDay! }
    const released = releaseDueRivalComebacks(due)
    const rival = released.rivals[0]!
    const model = rival.models.find((candidate) => candidate.id === plan.modelId)!

    expect(rival.financialComeback).toMatchObject({
      status: 'released',
      completedDay: due.day,
    })
    expect(model.release).toBe('released')
    expect(model.shipped).toBe(true)
    expect(model.productPreset).toBe(plan.productPreset)
    expect(rivalComebackProductScore(model)).toBeCloseTo(
      plan.targetCapability!,
      8,
    )
    expect(model.capability).toBeLessThanOrEqual(
      bentCapabilityCeiling(
        architecturePretrainingCapabilityCap({
          family: model.family,
          backbone: model.backbone,
        }),
      ) + 1e-7,
    )
    expect(model.apiPriceInPerMTok!).toBeGreaterThanOrEqual(
      model.costApiPriceIn * 1.18 - 1e-9,
    )
    expect(model.apiPriceOutPerMTok!).toBeGreaterThanOrEqual(
      model.costApiPriceOut * 1.18 - 1e-9,
    )
    const reference = due.player.models[0]!
    const costBackedCanUndercut =
      blendApiPrice(model.costApiPriceIn, model.costApiPriceOut) * 1.18 <
      (reference.apiPricePerMTok ?? reference.suggestedApiPrice)
    if (costBackedCanUndercut) {
      expect(model.apiPricePerMTok!).toBeLessThan(reference.apiPricePerMTok!)
    }
    expect(rival.pricing.activeModelId).toBe(model.id)
    expect(rival.pricing.apiModelIds).toContain(model.id)
    expect(rival.publicEstimate?.announcedProject ?? null).toBeNull()
    for (const product of rival.pricing.plans) {
      expect(product.modelIds).toContain(model.id)
      expect(product.modalityRoutes?.text?.primaryModelId).toBe(model.id)
      expect(product.modalityRoutes?.image?.primaryModelId).not.toBe(model.id)
      expect(product.modalityRoutes?.audio?.primaryModelId).not.toBe(model.id)
      expect(product.modalityRoutes?.video?.primaryModelId).not.toBe(model.id)
    }
    expect(model.economics?.trainingInitialCost).toBe(plan.acquisitionCost)
    expect(released.news[0]).toContain('cost-backed API list')
  })

  it('enters the normal public evaluation lifecycle on release', () => {
    const before = distressedState(seedForBacking('success'))
    const announced = maybeStartRivalFinancialComeback(before, before.rivals[0]!.id)
    const plan = announced.rivals[0]!.financialComeback!
    const released = tickRivals({ ...announced, day: plan.releaseDay! })
    const evaluations = released.evaluations.filter(
      (evaluation) =>
        evaluation.labId === announced.rivals[0]!.id &&
        evaluation.modelId === plan.modelId,
    )
    expect(evaluations.map((evaluation) => evaluation.kind).sort()).toEqual([
      'blind_audit',
      'internal',
      'public',
      'real_world',
    ])
  })
})

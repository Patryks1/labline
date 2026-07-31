/**
 * Shared simulation path — player and rivals use the same compute/data/research cores.
 */
import { describe, expect, it } from 'vitest'
import { createEmptyLabData } from './balance/data'
import { abstractPools, labInferCapacityMTok, labTrainPf } from './systems/labCompute'
import { consumeForLabData, consumeForTraining } from './systems/data'
import { applyResearchEffectsToLab } from './systems/research'
import { createRivals } from './systems/rivals'
import { createGame } from './createGame'
import { buildScaledModel } from './balance/modelBuild'
import { tickDay } from './tick'

describe('shared lab compute pools', () => {
  it('difficulty changes rival pressure while preserving shared incumbent endowments', () => {
    const easy = createGame({ seed: 902, difficulty: 'easy' })
    const hard = createGame({ seed: 902, difficulty: 'hard' })
    const resources = (state: ReturnType<typeof createGame>) =>
      state.rivals.map((rival) => ({
        id: rival.id,
        cash: rival.cash,
        chips: rival.chips,
        flopsPf: rival.flopsPf,
        dataMTok: rival.dataMTok,
      }))
    expect(hard.rivals.length).toBeGreaterThan(easy.rivals.length)
    const hardById = new Map(resources(hard).map((rival) => [rival.id, rival]))
    for (const rival of resources(easy)) {
      expect(hardById.get(rival.id)).toEqual(rival)
    }
  })

  it('settles rival operating cash into the same reconciled finance shape', () => {
    const next = tickDay(createGame({ seed: 903, difficulty: 'normal' }))
    for (const rival of next.rivals) {
      expect(rival.finance).toBeDefined()
      expect(rival.finance?.cash).toBeCloseTo(rival.cash)
      expect(rival.finance?.dayTotalOut).toBeGreaterThanOrEqual(0)
      expect(rival.finance?.dayRevenue).toBe(rival.dayRevenue)
      expect(Number.isFinite(rival.finance?.valuation ?? Number.NaN)).toBe(true)
    }
  })

  it('train + infer + research partition the same flops for any lab', () => {
    const pools = abstractPools({
      flopsPf: 100,
      utilCap: 0.5,
      allocation: { training: 0.4, inference: 0.4, research: 0.2 },
      servingEfficiency: 1,
    })
    // 100 * 0.5 = 50 base; 0.4/0.4/0.2 → 20/20/10
    expect(pools.training).toBeCloseTo(20, 5)
    expect(pools.inference).toBeCloseTo(20, 5)
    expect(pools.research).toBeCloseTo(10, 5)
    expect(pools.inferenceEffective).toBeCloseTo(20, 5)
  })

  it('servingEfficiency scales token Cap once (not train PF)', () => {
    const base = {
      flopsPf: 100,
      utilCap: 0.5,
      allocation: { training: 0.2, inference: 0.6, research: 0.2 },
    }
    const model = {
      paramsB: 7,
      activeParamsB: 7,
      family: 'dense' as const,
      inferCostMult: 1,
      tokPerSecMult: 1,
    }
    const low = labInferCapacityMTok({ ...base, servingEfficiency: 0.3 }, model)
    const high = labInferCapacityMTok({ ...base, servingEfficiency: 1.2 }, model)
    expect(high).toBeGreaterThan(low * 2)
    expect(labTrainPf({ ...base, servingEfficiency: 0.3 })).toBeCloseTo(
      labTrainPf({ ...base, servingEfficiency: 1.2 }),
      5,
    )
  })
})

describe('shared data recipe (player + rival)', () => {
  it('consumeForLabData under-data coverage matches for any LabData', () => {
    const data = createEmptyLabData() // 500 MTok
    const paramsB = 2
    const need = paramsB * 1000
    const recipe = consumeForLabData(
      data,
      {
        totalMTok: need,
        totalUnits: need,
        trainShare: 0.82,
        weights: { chat: 0.5, code: 0.5 },
        allowSynthetic: false,
        includeSynthHQ: false,
        includeSynthLQ: false,
      },
      paramsB,
      'dense',
      { hasSynthResearch: false },
    )
    // 500 vs 2000 need → coverage 0.25
    expect(recipe.coverage).toBeLessThan(0.4)
    expect(recipe.coverage).toBeGreaterThan(0.1)
  })

  it('player consumeForTraining wraps the same lab recipe', () => {
    const s = createGame(42)
    const r = consumeForTraining(s, undefined, 1, 'dense')
    const lab = consumeForLabData(s.player.data, undefined, 1, 'dense', {
      hasSynthResearch: false,
    })
    // Same default plan → same coverage band
    expect(Math.abs(r.coverage - lab.coverage)).toBeLessThan(0.05)
  })

  it('rivals start with same 500 MTok starter as player LabData', () => {
    const rivals = createRivals(1)
    const player = createGame(1).player.data
    const pTok = Object.values(player.stocks).reduce((s, x) => s + x.processed, 0)
    for (const r of rivals) {
      expect(r.dataMTok).toBeCloseTo(pTok, 0)
      expect(r.data).toBeTruthy()
    }
  })
})

describe('shared research effects', () => {
  it('applyResearchEffectsToLab raises util and serving for any lab shape', () => {
    const before = { utilCap: 0.4, servingEfficiency: 0.3, brandTrust: 50, dataQuality: 1 }
    const after = applyResearchEffectsToLab(before, {
      utilCap: 0.08,
      servingEfficiency: 0.15,
      dataFlywheel: 0.1,
    })
    expect(after.utilCap).toBeGreaterThan(before.utilCap)
    expect(after.servingEfficiency).toBeGreaterThan(before.servingEfficiency)
    expect(after.dataQuality ?? 0).toBeGreaterThan(before.dataQuality ?? 0)
  })
})

describe('shared model scale', () => {
  it('buildScaledModel under-data hit is the shared capability path', () => {
    const full = buildScaledModel({
      id: 'a',
      name: 'A',
      paramsB: 1,
      family: 'dense',
      day: 1,
      dataCoverage: 1,
      dataQuality: 70,
    })
    const thin = buildScaledModel({
      id: 'b',
      name: 'B',
      paramsB: 1,
      family: 'dense',
      day: 1,
      dataCoverage: 0.3,
      dataQuality: 70,
    })
    expect(thin.capability).toBeLessThan(full.capability)
  })

  it('each model gets its own API in/out list prices ($/MTok)', () => {
    const small = buildScaledModel({
      id: 's',
      name: 'Small',
      paramsB: 2,
      family: 'dense',
      day: 1,
      dataCoverage: 1,
      dataQuality: 70,
    })
    const large = buildScaledModel({
      id: 'l',
      name: 'Large',
      paramsB: 70,
      family: 'dense',
      day: 1,
      dataCoverage: 1,
      dataQuality: 70,
    })
    // List prices are set (not null lab fallback)
    expect(small.apiPriceInPerMTok).not.toBeNull()
    expect(small.apiPriceOutPerMTok).not.toBeNull()
    expect(large.apiPriceInPerMTok).not.toBeNull()
    expect(large.apiPriceOutPerMTok).not.toBeNull()
    // Output costs more than input
    expect(small.apiPriceOutPerMTok!).toBeGreaterThan(small.apiPriceInPerMTok!)
    expect(large.apiPriceOutPerMTok!).toBeGreaterThan(large.apiPriceInPerMTok!)
    // Bigger model is more expensive to serve → higher list
    expect(large.apiPriceInPerMTok!).toBeGreaterThan(small.apiPriceInPerMTok!)
    expect(large.apiPriceOutPerMTok!).toBeGreaterThan(small.apiPriceOutPerMTok!)
  })
})

import { describe, expect, it } from 'vitest'
import { defaultDataWeights } from '../../../../sim/balance/data'
import { DEFAULT_POST_TRAIN_SHARE } from '../../../../sim/balance/modelProduct'
import type { Model } from '../../../../sim/types'
import {
  DEFAULT_RECIPE_ALIGN_SHARE,
  allocationsFromMix,
  clampEnvelopeSplit,
  clampRecipeToUsable,
  defaultRecipeVolumeMTok,
  formatRecipeTokDraft,
  listRecipePlans,
  mixFromAllocations,
  parseRecipeTokInput,
  postTrainShareFromVolumes,
  focusZoomForVolume,
  invertTokenRadius,
  recipeAxisMaxMTok,
  recipePlanFromModel,
  recipeScaleCeiling,
  recipeZoneCapMTok,
  seedRecipeVolumes,
  splitOwnedAndSynth,
  stackRadiiFromTokens,
  tokenRadius,
  volumesFromRecipe,
  scaleEnvelope,
  spacedStackRadii,
  splitEnvelope,
  splitStackedDrag,
  stackedSpoke,
  verifyTokens,
} from './recipePlan'

function model(partial: Partial<Model> & Pick<Model, 'id' | 'name'>): Model {
  return {
    family: 'dense',
    paramsB: 7,
    capability: 50,
    modalities: ['text'],
    quality: {
      reasoning: 40,
      coding: 40,
      chat: 40,
      image: 10,
      video: 5,
      safety: 40,
      reliability: 40,
    },
    benchmarks: {
      mmlu: 40,
      coding: 40,
      math: 40,
      vision: 10,
      law: 20,
      health: 20,
      science: 30,
      multilingual: 30,
      agents: 20,
      safety: 40,
      personality: 20,
    },
    postTrain: 'none',
    trainMode: 'pretrain',
    release: 'internal',
    shipped: false,
    archived: false,
    inferCostMult: 1,
    tokPerSecMult: 1,
    ...partial,
  } as Model
}

describe('recipe plans', () => {
  it('defaults a new recipe to 1x params or owned stock, whichever is lower', () => {
    expect(DEFAULT_RECIPE_ALIGN_SHARE).toBe(0.5)
    expect(defaultRecipeVolumeMTok(500, 1)).toBe(500)
    expect(defaultRecipeVolumeMTok(5_000, 1)).toBe(1_000)
    expect(defaultRecipeVolumeMTok(0, 7)).toBe(0)
  })

  it('never seeds a domain above its usable stock', () => {
    const usable = {
      code: 180,
      math: 90,
      science: 80,
      law: 15,
      health: 15,
      chat: 80,
      image: 40,
      video: 0,
      audio: 0,
    }
    const seeded = seedRecipeVolumes({
      weights: { chat: 0.32, code: 0.22, math: 0.12, science: 0.1, image: 0.08, audio: 0.05, law: 0.04, health: 0.04, video: 0.03 },
      paramsB: 1,
      usableByDomain: usable,
    })
    for (const domain of Object.keys(usable) as (keyof typeof usable)[]) {
      expect(
        (seeded.base[domain] ?? 0) + (seeded.align[domain] ?? 0),
      ).toBeLessThanOrEqual(usable[domain] + 1e-9)
    }
    expect(seeded.totalMTok).toBeLessThanOrEqual(500 + 1e-9)
    expect(seeded.base.chat).toBeCloseTo(usable.chat * 0.5)
    expect(seeded.align.chat).toBeCloseTo(usable.chat * 0.5)
  })

  it('uses 1x params across the mix when the pile is larger', () => {
    const usable = {
      code: 4_000,
      math: 2_000,
      science: 2_000,
      law: 500,
      health: 500,
      chat: 4_000,
      image: 1_000,
      video: 500,
      audio: 500,
    }
    const seeded = seedRecipeVolumes({
      weights: { code: 1 },
      paramsB: 1,
      usableByDomain: usable,
    })
    expect(seeded.totalMTok).toBeCloseTo(1_000)
    expect(seeded.base.code + seeded.align.code).toBeCloseTo(1_000)
    expect(seeded.base.code).toBeCloseTo(500)
  })

  it('reads a previous model mix as a starting plan', () => {
    const weights = defaultDataWeights('dense')
    const plan = recipePlanFromModel(
      model({
        id: 'm1',
        name: 'Aster',
        dataPlan: {
          totalMTok: 400,
          totalUnits: 400,
          trainShare: 0.82,
          weights,
          postTrainShare: 0.3,
        },
        dataQualityUsed: 71,
      }),
    )
    expect(plan?.name).toBe('Aster')
    expect(plan?.postTrainShare).toBe(0.3)
    expect(plan?.quality).toBe(71)
    expect(plan?.weights.code).toBeGreaterThan(0)
    expect(recipePlanFromModel(model({ id: 'empty', name: 'Empty' }))).toBeNull()
  })

  it('lists only models that actually have a mix', () => {
    const plans = listRecipePlans([
      model({ id: 'a', name: 'A' }),
      model({
        id: 'b',
        name: 'B',
        dataPlan: {
          totalMTok: 100,
          totalUnits: 100,
          trainShare: 0.8,
          weights: { code: 1 },
          postTrainShare: DEFAULT_POST_TRAIN_SHARE,
        },
      }),
    ])
    expect(plans).toHaveLength(1)
    expect(plans[0]?.id).toBe('b')
  })

  it('turns dragged volumes into a post-train share without dropping siblings', () => {
    const mix = mixFromAllocations({
      code: 40,
      math: 10,
      science: 0,
      law: 0,
      health: 0,
      chat: 0,
      image: 0,
      video: 0,
      audio: 0,
    })
    expect(mix.totalMTok).toBe(50)
    expect(mix.weights.code).toBeCloseTo(0.8)
    expect(mix.weights.math).toBeCloseTo(0.2)
    expect(postTrainShareFromVolumes(78, 22)).toBeCloseTo(0.22)
    expect(postTrainShareFromVolumes(10, 90)).toBe(0.9)
    expect(postTrainShareFromVolumes(5, 95)).toBe(0.9)
    expect(postTrainShareFromVolumes(100, 1)).toBe(0.1)
  })

  it('stacks alignment as overflow and synthetic at the end', () => {
    const spoke = stackedSpoke(40, 12, 8)
    expect(spoke.inner).toBe(40)
    expect(spoke.mid).toBe(52)
    expect(spoke.outer).toBe(60)
    expect(splitStackedDrag('base', 30, spoke)).toBe(30)
    expect(splitStackedDrag('post', 50, spoke)).toBe(50)
    expect(splitStackedDrag('synth', 70, spoke)).toBe(18)
    const spaced = spacedStackRadii(0.02, 0.03, 0.04)
    expect(spaced.verify).toBeLessThan(spaced.inner)
    expect(spaced.owned).toBeGreaterThan(spaced.inner)
    expect(spaced.outer).toBeGreaterThan(spaced.owned)
    expect(verifyTokens(100, 0.82)).toBeCloseTo(18)
    const fitted = recipeAxisMaxMTok({ code: 78 }, 1)
    const zoomed = recipeAxisMaxMTok({ code: 78 }, 1.6)
    expect(zoomed).toBeLessThan(fitted)
    const ceiling = 400
    const fat = stackRadiiFromTokens(80, 100, 100, ceiling, 1, 0.82)
    const thin = stackRadiiFromTokens(8, 10, 10, ceiling, 1, 0.82)
    expect(fat.owned).toBeGreaterThan(thin.owned)
    expect(fat.verify).toBeCloseTo(fat.owned * 0.18)
    expect(thin.verify).toBeCloseTo(thin.owned * 0.18)
    expect(fat.inner).toBeCloseTo(fat.owned * 0.8)
    expect(fat.verify).toBeLessThan(fat.inner)
    expect(invertTokenRadius(tokenRadius(120, ceiling), ceiling)).toBeCloseTo(
      120,
      4,
    )
    expect(recipeScaleCeiling({ code: 80, math: 20 })).toBe(80)
    expect(focusZoomForVolume(20, 400)).toBeGreaterThan(1)
  })

  it('round-trips per-domain volumes without rescaling siblings', () => {
    const base = {
      code: 80,
      math: 10,
      science: 0,
      law: 0,
      health: 0,
      chat: 0,
      image: 0,
      video: 0,
      audio: 0,
    }
    const align = { ...base, code: 5, math: 40 }
    const rebuiltBase = mixFromAllocations(base)
    const rebuiltAlign = mixFromAllocations(align)
    expect(allocationsFromMix(rebuiltBase.weights, rebuiltBase.totalMTok).code).toBeCloseTo(80)
    expect(allocationsFromMix(rebuiltBase.weights, rebuiltBase.totalMTok).math).toBeCloseTo(10)
    expect(allocationsFromMix(rebuiltAlign.weights, rebuiltAlign.totalMTok).math).toBeCloseTo(40)
    const seeded = volumesFromRecipe({
      weights: rebuiltBase.weights,
      postTrainWeights: rebuiltAlign.weights,
      totalMTok: 135,
      postTrainShare: 45 / 135,
    })
    expect(seeded.base.code + seeded.align.code).toBeCloseTo(85, 0)
  })

  it('resets the base handle to half the envelope on resize', () => {
    const grown = scaleEnvelope(80, 20, 150)
    expect(grown.base).toBeCloseTo(75)
    expect(grown.align).toBeCloseTo(75)
    expect(grown.base + grown.align).toBeCloseTo(150)
    const split = splitEnvelope(100, 70)
    expect(split.base).toBe(70)
    expect(split.align).toBe(30)
    expect(splitEnvelope(40, 90).base).toBeCloseTo(36)
    expect(splitEnvelope(40, 90).align).toBeCloseTo(4)
    expect(splitEnvelope(100, 99).align / 100).toBeCloseTo(0.1)
    expect(splitEnvelope(100, 10).base).toBeCloseTo(10)
    expect(splitEnvelope(100, 5).base).toBeCloseTo(10)
    expect(splitEnvelope(100, 50).base).toBeCloseTo(50)
    expect(clampEnvelopeSplit(5, 95).base / 100).toBeCloseTo(0.1)
    expect(clampEnvelopeSplit(95, 5).align / 100).toBeCloseTo(0.1)
    const capped = clampRecipeToUsable(
      { code: 200, math: 10, science: 0, law: 0, health: 0, chat: 0, image: 0, video: 0, audio: 0 },
      { code: 50, math: 10, science: 0, law: 0, health: 0, chat: 0, image: 0, video: 0, audio: 0 },
      { code: 100, math: 40 },
    )
    expect(capped.base.code + capped.align.code).toBeCloseTo(100)
    expect(capped.base.code).toBeCloseTo(50)
    expect(capped.base.math + capped.align.math).toBeCloseTo(20)
  })

  it('caps all-data at owned stock unless synthetic expansion is available', () => {
    const stock = { usableMTok: 100, capMTok: 100, syntheticHeadroomMTok: 0 }
    expect(
      recipeZoneCapMTok('post', stock, {
        syntheticUnlocked: false,
        expansionEnabled: false,
      }),
    ).toBe(100)
    expect(
      recipeZoneCapMTok('base', stock, {
        syntheticUnlocked: false,
        expansionEnabled: false,
      }),
    ).toBe(100)
    expect(
      recipeZoneCapMTok('post', stock, {
        syntheticUnlocked: true,
        expansionEnabled: false,
      }),
    ).toBe(100)
    expect(
      recipeZoneCapMTok('synth', stock, {
        syntheticUnlocked: false,
        expansionEnabled: false,
      }),
    ).toBe(0)
    expect(
      recipeZoneCapMTok('post', stock, {
        syntheticUnlocked: true,
        expansionEnabled: true,
      }),
    ).toBe(800)
    expect(
      recipeZoneCapMTok(
        'synth',
        { usableMTok: 100, capMTok: 100, syntheticHeadroomMTok: 0 },
        { syntheticUnlocked: true, expansionEnabled: true },
      ),
    ).toBe(700)
    expect(splitOwnedAndSynth(80, 100)).toEqual({ owned: 80, synth: 0 })
    expect(splitOwnedAndSynth(150, 100)).toEqual({ owned: 100, synth: 50 })
  })

  it('parses typed recipe volumes as MTok with optional suffixes', () => {
    expect(parseRecipeTokInput('61')).toBe(61)
    expect(parseRecipeTokInput('1.5B')).toBe(1500)
    expect(parseRecipeTokInput('400K')).toBeCloseTo(0.4)
    expect(parseRecipeTokInput('12 M tok')).toBe(12)
    expect(parseRecipeTokInput('nope')).toBeNull()
    expect(formatRecipeTokDraft(61)).toBe('61')
    expect(formatRecipeTokDraft(1500)).toBe('1.5B')
  })
})

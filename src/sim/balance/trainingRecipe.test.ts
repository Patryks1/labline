import { describe, expect, it } from 'vitest'
import { createRng } from '../rng'
import { defaultDataWeights } from './data'
import {
  applyRecipeOutcome,
  chooseRivalTrainingRecipeKnobs,
  expectedRivalTrainingRecipeKnobs,
  planTrainingRecipe,
  recipeOutcomeSignals,
  seedRecipeVolumes,
} from './trainingRecipe'
import type { QualityAxes } from '../types'

const starter = {
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

function quality(cap = 50): QualityAxes {
  return {
    reasoning: cap,
    coding: cap,
    chat: cap,
    image: 5,
    video: 0,
    safety: cap,
    reliability: cap,
  }
}

describe('training recipe planner', () => {
  it('defaults a 1B model on the starter pile to all owned stock at 50/50', () => {
    const planned = planTrainingRecipe({
      paramsB: 1,
      family: 'dense',
      weights: defaultDataWeights('dense'),
      usableByDomain: starter,
    })
    expect(planned.totalMTok).toBeLessThanOrEqual(500 + 1e-9)
    expect(planned.postTrainShare).toBeCloseTo(0.5)
    expect(planned.baseMTok).toBeCloseTo(planned.alignMTok, 5)
    expect(planned.trainShare).toBeCloseTo(0.82)
    for (const domain of Object.keys(starter) as (keyof typeof starter)[]) {
      expect(
        (planned.base[domain] ?? 0) + (planned.align[domain] ?? 0),
      ).toBeLessThanOrEqual(starter[domain] + 1e-9)
    }
  })

  it('uses 1x params when the pile is larger', () => {
    const fat = {
      code: 8_000,
      math: 4_000,
      science: 4_000,
      law: 1_000,
      health: 1_000,
      chat: 8_000,
      image: 2_000,
      video: 1_000,
      audio: 1_000,
    }
    const planned = planTrainingRecipe({
      paramsB: 1,
      family: 'dense',
      weights: { code: 1 },
      usableByDomain: fat,
    })
    expect(planned.totalMTok).toBeCloseTo(1_000)
    expect(planned.base.code + planned.align.code).toBeCloseTo(1_000)
  })

  it('lets rivals call the same planner with rolled knobs', () => {
    const rng = createRng(42)
    const knobs = chooseRivalTrainingRecipeKnobs('safety', rng)
    expect(knobs.postTrainShare).toBeGreaterThanOrEqual(0.1)
    expect(knobs.postTrainShare).toBeLessThanOrEqual(0.9)
    expect(knobs.trainShare).toBeGreaterThanOrEqual(0.4)
    expect(knobs.trainShare).toBeLessThanOrEqual(0.95)
    const planned = planTrainingRecipe({
      paramsB: 1,
      family: 'dense',
      weights: defaultDataWeights('dense'),
      usableByDomain: starter,
      postTrainShare: knobs.postTrainShare,
      trainShare: knobs.trainShare,
      volumePolicy: knobs.volumePolicy,
    })
    expect(planned.postTrainShare).toBeCloseTo(knobs.postTrainShare)
    expect(planned.trainShare).toBeCloseTo(knobs.trainShare)
    expect(planned.dataPlan.postTrainShare).toBeCloseTo(knobs.postTrainShare)
    expect(planned.dataPlan.totalMTok).toBeCloseTo(planned.baseMTok)
  })

  it('keeps expected rival knobs deterministic and in range', () => {
    const a = expectedRivalTrainingRecipeKnobs('hyperscale')
    const b = expectedRivalTrainingRecipeKnobs('hyperscale')
    expect(a).toEqual(b)
    expect(a.postTrainShare).toBeGreaterThanOrEqual(0.1)
    expect(a.postTrainShare).toBeLessThanOrEqual(0.9)
  })
})

describe('recipe outcome signals', () => {
  it('raises capability when the mix is base-heavy and quality when it is align/verify-heavy', () => {
    const baseHeavy = recipeOutcomeSignals({
      totalMTok: 1_000,
      paramsB: 1,
      postTrainShare: 0.1,
      trainShare: 0.9,
    })
    const alignHeavy = recipeOutcomeSignals({
      totalMTok: 1_000,
      paramsB: 1,
      postTrainShare: 0.9,
      trainShare: 0.7,
    })
    expect(baseHeavy.capabilityVolumeRatio).toBeGreaterThan(
      alignHeavy.capabilityVolumeRatio,
    )
    expect(alignHeavy.alignmentVolumeRatio).toBeGreaterThan(
      baseHeavy.alignmentVolumeRatio,
    )
    expect(alignHeavy.verifyShare).toBeGreaterThan(baseHeavy.verifyShare)

    const fromBase = applyRecipeOutcome({
      capability: 60,
      quality: quality(50),
      signals: baseHeavy,
    })
    const fromAlign = applyRecipeOutcome({
      capability: 60,
      quality: quality(50),
      signals: alignHeavy,
    })
    expect(fromBase.capability).toBeGreaterThan(fromAlign.capability)
    expect(fromAlign.quality.chat).toBeGreaterThan(fromBase.quality.chat)
    expect(fromAlign.quality.safety).toBeGreaterThan(fromBase.quality.safety)
    expect(fromAlign.quality.reliability).toBeGreaterThan(
      fromBase.quality.reliability,
    )
  })

  it('seeds 10–90% splits without exceeding stock', () => {
    const seeded = seedRecipeVolumes({
      weights: { chat: 1 },
      paramsB: 1,
      usableByDomain: starter,
      postTrainShare: 0.9,
    })
    expect(seeded.align.chat / (seeded.base.chat + seeded.align.chat)).toBeCloseTo(
      0.9,
    )
    expect(seeded.base.chat + seeded.align.chat).toBeLessThanOrEqual(
      starter.chat + 1e-9,
    )
  })
})

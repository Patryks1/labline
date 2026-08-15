import { describe, expect, it } from 'vitest'
import { DATA_DOMAINS } from '../balance/data'
import { analyzeTrainingData, ioForPreset } from '../balance/trainingV3'
import { createGame } from '../createGame'
import { ensureLabData } from './data'
import {
  defaultTrainingDataWeights,
  startTraining,
  trainingArchitectureValidation,
} from './training'

const TOTAL_DATA_MTOK = 21_430

function sparseRecipeState() {
  const state = createGame(13_070)
  const data = ensureLabData(state)
  const weights = defaultTrainingDataWeights('moe', 'language')
  const stocks = Object.fromEntries(
    DATA_DOMAINS.map((domain) => {
      const volume = TOTAL_DATA_MTOK * weights[domain]
      return [
        domain,
        {
          ...data.stocks[domain],
          processed: volume,
          quality: 100,
          fromWeb: volume,
          fromUser: 0,
          fromBought: 0,
          fromSynth: 0,
          fromSynthHQ: 0,
          fromSynthLQ: 0,
        },
      ]
    }),
  ) as typeof data.stocks
  return {
    ...state,
    player: {
      ...state.player,
      cash: 1_000_000_000_000,
      researchUnlocked: [
        ...new Set([...state.player.researchUnlocked, 'moe_basics', 'data_mix']),
      ],
      data: {
        ...data,
        stocks,
        // Exercise legacy aggregate attribution rather than fabricating assets.
        assets: [],
      },
    },
  }
}

describe('sparse MoE training start regression', () => {
  it('allows 13B total / 70M active and starts the selected 21.43B-token recipe', () => {
    const weights = defaultTrainingDataWeights('moe', 'language')
    const next = startTraining(sparseRecipeState(), {
      name: 'Sparse 13B',
      family: 'moe',
      backbone: 'moe',
      productPreset: 'language',
      io: ioForPreset('language'),
      paramsB: 13,
      activeParamsB: 0.07,
      dataPlan: {
        totalUnits: TOTAL_DATA_MTOK,
        totalMTok: TOTAL_DATA_MTOK,
        trainShare: 0.8,
        weights,
        allowSynthetic: false,
      },
      // A queued run may intentionally start dormant; placement is separate.
      computePriority: 0,
    })

    expect(next.player.trainingJob, next.alerts[0]?.message).toMatchObject({
      name: 'Sparse 13B',
      targetParamsB: 13,
      activeParamsB: 0.07,
      trainShare: 0.8,
      computePriority: 0,
    })
    expect(next.player.trainingJob!.trainMTok).toBeCloseTo(17_144, 3)
    expect(next.player.trainingJob!.verifyMTok).toBeCloseTo(4_286, 3)
  })

  it('keeps only genuinely invalid active sizes as hard failures', () => {
    expect(
      trainingArchitectureValidation({
        backbone: 'moe',
        paramsB: 13,
        activeParamsB: 0.07,
      }),
    ).toEqual({ ok: true })
    expect(
      trainingArchitectureValidation({
        backbone: 'moe',
        paramsB: 13,
        activeParamsB: 14,
      }).reason,
    ).toContain('cannot exceed')
  })

  it('explains the verifier-adjusted target and extreme-routing penalty as advisory', () => {
    const weights = defaultTrainingDataWeights('moe', 'language')
    const analysis = analyzeTrainingData({
      paramsB: 13,
      activeParamsB: 0.07,
      family: 'moe',
      backbone: 'moe',
      productPreset: 'language',
      plan: {
        totalUnits: TOTAL_DATA_MTOK,
        totalMTok: TOTAL_DATA_MTOK,
        trainShare: 0.8,
        weights,
      },
      actualMTok: TOTAL_DATA_MTOK,
      quality: 100,
    })

    expect(analysis.effectiveDataRatio).toBeGreaterThan(6)
    expect(analysis.warnings).not.toContain(
      expect.stringContaining('below the strong'),
    )
    expect(analysis.warnings).toContainEqual(
      expect.stringContaining('Extreme sparsity activates 0.54%'),
    )
  })

  it('explains when raw volume passes but effective quality and diversity do not', () => {
    const weights = defaultTrainingDataWeights('moe', 'language')
    const analysis = analyzeTrainingData({
      paramsB: 13,
      activeParamsB: 0.07,
      family: 'moe',
      backbone: 'moe',
      productPreset: 'language',
      plan: {
        totalUnits: TOTAL_DATA_MTOK,
        totalMTok: TOTAL_DATA_MTOK,
        trainShare: 0.8,
        weights,
      },
      actualMTok: TOTAL_DATA_MTOK,
      quality: 70,
    })

    expect(analysis.rawStrongTargetMet).toBe(true)
    expect(analysis.rawStrongTargetMTok).toBe(19_920)
    expect(analysis.effectiveDataRatio).toBeLessThan(6)
    expect(analysis.warnings).toContainEqual(
      expect.stringMatching(
        /Raw volume meets the 19\.92B tokens strong target, but effective training signal is \d+\.\d{2}:1 after quality ×0\.80, diversity ×\d+\.\d{2}, and 20% verification holdout \(×0\.80\)\./,
      ),
    )
  })
})

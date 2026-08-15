import { describe, expect, it } from 'vitest'
import { inferencePfDemand } from './serveCompute'
import { MODEL_SYSTEMS_WORK_MULTIPLIER } from './computeCalibration'
import { getRackSku } from './rackSkus'
import {
  denseTrainingPfDays,
  estimateTrainingEconomics,
  estimateTrainingRun,
} from './training'
import { pfPerMTokForModel, tokensPerDayFromFlops } from './tokenServe'
import { workloadPowerMw } from '../systems/computePower'
import { runPlayBot } from '../play/bot'

const MODELS = [
  ['dense 8B', { paramsB: 8, activeParamsB: 8, family: 'dense' as const, inferCostMult: 1, tokPerSecMult: 1 }, 0.000551053125, 0.2802238584],
  ['dense 70B', { paramsB: 70, activeParamsB: 70, family: 'dense' as const, inferCostMult: 1, tokPerSecMult: 1 }, 0.00482171484375, 0.7831169931],
  ['MoE 70B/8B active', { paramsB: 70, activeParamsB: 8, family: 'moe' as const, inferCostMult: 1, tokPerSecMult: 1 }, 0.000595137375, 0.2841156045],
  ['image 8B', { paramsB: 8, activeParamsB: 8, family: 'diffusion' as const, inferCostMult: 1, tokPerSecMult: 1 }, 0.00074392171875, 0.2976612761],
  ['video 8B', { paramsB: 8, activeParamsB: 8, family: 'video' as const, inferCostMult: 1, tokPerSecMult: 1 }, 0.0010470009375, 0.3268936517],
] as const

describe('end-to-end model compute calibration', () => {
  it('keeps representative PF/MTok and H100-fleet MW on golden values', () => {
    const h100 = getRackSku('rack_h100')
    const rackCount = 100
    for (const [label, model, expectedPfPerMTok, expectedMw] of MODELS) {
      const pfPerMTok = pfPerMTokForModel(model, 1)
      const workPf = pfPerMTok * 100_000
      const mw = workloadPowerMw({
        workPf,
        fleetPf: h100.flopsPf * rackCount,
        fullLoadMw: h100.mw * rackCount,
        idleMw:
          (h100.accelerator?.idleMw ?? h100.mw * 0.3) * rackCount,
        pue: 1.2,
      })

      expect(pfPerMTok, label).toBeCloseTo(expectedPfPerMTok, 12)
      expect(mw, label).toBeCloseTo(expectedMw, 9)
    }
  })

  it('uses the same calibrated work in settlement demand and capacity forecasts', () => {
    const model = MODELS[1][1]
    const requestedMTok = 25_000
    const demandPf = inferencePfDemand(requestedMTok, model, 1)
    const forecastMTok = tokensPerDayFromFlops({
      flopsPf: demandPf,
      model,
      servingEfficiency: 1,
      inferenceShare: 1,
      utilCap: 1,
      headroom: 0,
    })

    expect(demandPf).toBeCloseTo(
      requestedMTok * pfPerMTokForModel(model, 1),
      12,
    )
    expect(forecastMTok).toBeCloseTo(requestedMTok, 9)
  })

  it('adds systems work once after raw 6ND for representative dense training', () => {
    const eightRaw = denseTrainingPfDays(8, 160_000)
    const seventyRaw = denseTrainingPfDays(70, 1_400_000)
    const eight = estimateTrainingRun({
      paramsB: 8,
      family: 'dense',
      trainEfficiency: 1,
      trainingTokensMTok: 160_000,
    })
    const seventy = estimateTrainingRun({
      paramsB: 70,
      family: 'dense',
      trainEfficiency: 1,
      trainingTokensMTok: 1_400_000,
    })

    expect(MODEL_SYSTEMS_WORK_MULTIPLIER).toBe(1.35)
    expect(eight.trainingPfDays).toBeCloseTo(
      eightRaw * MODEL_SYSTEMS_WORK_MULTIPLIER,
      10,
    )
    expect(seventy.trainingPfDays).toBeCloseTo(
      seventyRaw * MODEL_SYSTEMS_WORK_MULTIPLIER,
      8,
    )
    expect(eight.gamePfDays).toBeCloseTo(60, 10)
    expect(seventy.gamePfDays).toBeCloseTo(4_593.75, 8)

    const economics = estimateTrainingEconomics({
      paramsB: 8,
      family: 'dense',
      trainEfficiency: 1,
      trainingTokensMTok: 160_000,
      verificationTokensMTok: 0,
      numerics: {
        computeFormat: 'fp16_mixed',
        nativeWeightFormat: 'float',
        recipeVersion: 1,
      },
    })
    expect(economics.targetPfDays).toBeCloseTo(eight.gamePfDays, 10)
  })

  it(
    'keeps a representative 180-day cloud-first run affordable',
    () => {
      const report = runPlayBot({ seed: 42, maxDays: 180 })
      expect(report.bankrupt).toBe(false)
      expect(report.minCash).toBeGreaterThan(-20_000_000)
      expect(report.final.player.cash).toBeGreaterThan(-25_000_000)
      expect(
        report.releasedModel ||
          report.final.player.trainingJob != null ||
          report.final.player.models.length > 0,
      ).toBe(true)
    },
    30_000,
  )
})

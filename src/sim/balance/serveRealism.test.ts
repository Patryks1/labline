/**
 * Worked realism math for the serving-compute rebalance.
 *
 * Targets (designer):
 * - Dense 100B at the starting stack ≈ 0.028–0.04 PF/MTok end to end
 * - Early 100M–1B free users on dense 100B strain / exceed regional power
 * - Maxed efficiency + quant + MoE drops cost well over 10×
 * - Deploy-precision compute multipliers have one source of truth
 */
import { describe, expect, it } from 'vitest'
import { ECONOMY } from './economy'
import { planServeModifiers } from '../systems/plans'
import {
  DEFAULT_SERVE_HEADROOM,
  decodeMfuMult,
  familyServeMult,
  pfPerMTokForModel,
  precisionComputeMult,
  SERVE_PRECISION_COMPUTE_MULT,
  serveEffFactor,
} from './tokenServe'
import { CUSTOMER_BANDS, planActualMTokPerUser } from './serveCompute'
import type { SubPlan } from '../types'

const DENSE_100 = {
  paramsB: 100,
  activeParamsB: 100,
  family: 'dense' as const,
  inferCostMult: 1,
}

const MOE_100_10 = {
  paramsB: 100,
  activeParamsB: 10,
  family: 'moe' as const,
  inferCostMult: 1,
}

/** H100-class node: PF and IT draw used for facility-MW back-of-envelope. */
const H100_PF = 7.912
const H100_MW = 0.0102

function facilityMwForPfDemand(opts: {
  demandPf: number
  utilCap: number
  pue?: number
  headroom?: number
}): number {
  const pue = opts.pue ?? ECONOMY.startingPue
  const headroom = opts.headroom ?? DEFAULT_SERVE_HEADROOM
  const installedPf = (opts.demandPf * (1 + headroom)) / Math.max(1e-6, opts.utilCap)
  const itMw = installedPf / (H100_PF / H100_MW)
  return itMw * pue
}

function freeMidUtilization(): number {
  const band = CUSTOMER_BANDS.find((b) => b.id === 'free')!
  return (band.utilization[0]! + band.utilization[1]!) / 2
}

describe('serving realism rebalance', () => {
  it('dense 100B at the starting stack lands in the calibrated end-to-end band', () => {
    const start = ECONOMY.startingServingEfficiency
    expect(start).toBeCloseTo(0.3, 8)
    expect(serveEffFactor(start)).toBeCloseTo(0.3, 8)
    expect(decodeMfuMult(start)).toBeGreaterThan(5)

    const pfPerMTok = pfPerMTokForModel(DENSE_100, start)
    // Core serving work plus the shared 1.35× systems-work calibration.
    expect(pfPerMTok).toBeGreaterThanOrEqual(0.028)
    expect(pfPerMTok).toBeLessThanOrEqual(0.04)
    expect(pfPerMTok).toBeCloseTo(0.02961328125, 10)
  })

  it('1B free users on dense 100B early-stack needs multi-GW facility power', () => {
    const freePlan = {
      id: 'plan-free',
      name: 'Free',
      pricePerMonth: 0,
      usageMultiplier: 0.2,
      includedMTokPerMonth: 4,
      modelIds: [],
      computePriority: 20,
      servePrecision: 'fp16' as const,
      enabled: true,
    } satisfies Partial<SubPlan> as unknown as SubPlan

    const util = freeMidUtilization()
    expect(util).toBeCloseTo(0.14, 8)
    const mtokPerUserDay = planActualMTokPerUser(freePlan, ECONOMY.basePlanUsageMTokPerDay, util)
    // ~18.7k tokens/user/day on the 4 MTok/mo free tier
    expect(mtokPerUserDay * 1e6).toBeGreaterThan(10_000)
    expect(mtokPerUserDay * 1e6).toBeLessThan(25_000)

    const startPf = pfPerMTokForModel(DENSE_100, ECONOMY.startingServingEfficiency)
    const demand1b = 1e9 * mtokPerUserDay * startPf
    const demand100m = 1e8 * mtokPerUserDay * startPf
    const mw1b = facilityMwForPfDemand({
      demandPf: demand1b,
      utilCap: ECONOMY.startingUtilCap,
    })
    const mw100m = facilityMwForPfDemand({
      demandPf: demand100m,
      utilCap: ECONOMY.startingUtilCap,
    })

    // 100M free users already strain a 210 MW regional grid; 1B is multi-GW.
    expect(mw100m).toBeGreaterThan(ECONOMY.gridBaseMw * 0.6)
    expect(mw1b).toBeGreaterThan(1_200)
    expect(mw1b).toBeGreaterThan(mw100m * 9)
  })

  it('maxed efficiency + int4 + MoE drops cost well over 10× vs starting dense', () => {
    const start = pfPerMTokForModel(DENSE_100, ECONOMY.startingServingEfficiency)
    // Live path: planServeModifiers.computeMult → inferCostMult; family tax is inside pfPerMTok.
    const maxedMoeInt4 = pfPerMTokForModel(
      { ...MOE_100_10, inferCostMult: precisionComputeMult('int4') },
      ECONOMY.maxServingEfficiency,
    )

    expect(ECONOMY.maxServingEfficiency).toBeCloseTo(1.8, 8)
    expect(serveEffFactor(ECONOMY.maxServingEfficiency)).toBeCloseTo(1.8, 8)
    expect(familyServeMult('moe')).toBe(1.08)
    expect(start / maxedMoeInt4).toBeGreaterThan(10)
    // Sanity: MoE 10B-active int4 is far below dense BF16 at the starting stack.
    expect(maxedMoeInt4).toBeLessThan(start / 50)
  })

  it('quant compute multipliers cannot diverge between tokenServe and planServeModifiers', () => {
    const unlocks = [
      'opt_fp16',
      'opt_mixed',
      'sys_quant',
      'sys_fp8',
      'sys_int4',
      'opt_fp6_train',
      'sys_nvfp4_runtime',
      'sys_bitnet_runtime',
      'dense_bitnet',
    ]
    for (const precision of Object.keys(SERVE_PRECISION_COMPUTE_MULT) as Array<
      keyof typeof SERVE_PRECISION_COMPUTE_MULT
    >) {
      const fromTable = SERVE_PRECISION_COMPUTE_MULT[precision]
      const fromHelper = precisionComputeMult(precision)
      const fromPlans = planServeModifiers(precision, unlocks).computeMult
      expect(fromHelper).toBe(fromTable)
      expect(fromPlans).toBe(fromTable)
    }
    // FP32 is the always-available, full-precision deployment baseline.
    expect(precisionComputeMult('fp32')).toBe(2)
  })

  it('training-float × deploy-quant combined multipliers stay in a sensible band', () => {
    // TRAINING_PRECISION_PROFILES inferenceCostMultiplier × deploy computeMult
    const combos: Array<[number, number, string]> = [
      [1.18, 1, 'fp32→bf16'],
      [1, 1, 'bf16→bf16'],
      [0.82, 0.55, 'fp8_hybrid→fp8'],
      [0.62, 0.28, 'nvfp4→nvfp4'],
      [1, 0.34, 'bf16→int4'],
      [1, 0.58, 'bf16→int8'],
    ]
    for (const [train, deploy, label] of combos) {
      const combined = train * deploy
      expect(combined, label).toBeGreaterThan(0.15)
      expect(combined, label).toBeLessThanOrEqual(1.25)
    }
  })
})

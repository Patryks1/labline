import { describe, expect, it } from 'vitest'
import { inferenceCapacityMTok, inferencePfDemand } from '../balance/serveCompute'
import { createGame } from '../createGame'
import type { ComputeContract, RackInstall } from '../types'
import { computeSnapshot } from './compute'
import { labInferCapacityWorkPf } from './labCompute'
import { computeLabSnapshot, syncLabIndex } from './labEngine'
import { rivalInferCapacityPf } from './market'

const REFERENCE_MODEL = {
  paramsB: 7,
  activeParamsB: 7,
  family: 'dense' as const,
  inferCostMult: 1,
  tokPerSecMult: 1,
}

describe('controller-neutral compute yield', () => {
  it('uses one token-calibrated work unit for player and abstract serving', () => {
    const state = createGame(9_101)
    const snapshot = computeSnapshot(state)
    const sharedWorkPf = labInferCapacityWorkPf({
      flopsPf: snapshot.rawFlopsPf,
      hardwareTokPerSec:
        snapshot.chipCount * snapshot.avgTokPerSecPerChip,
      utilCap: snapshot.utilCap,
      allocation: state.player.allocation,
      servingEfficiency: state.player.servingEfficiency,
      derate: snapshot.powerDerate,
      engineerServeBonus: snapshot.engineerServeBonus,
    })
    const playerMTok = inferenceCapacityMTok(
      {
        ...snapshot,
        pools: { ...snapshot.pools, inference: sharedWorkPf },
        vramDerateServe: 1,
      },
      REFERENCE_MODEL,
      state.player.servingEfficiency,
      state.player.allocation.inference,
    )
    const playerWorkPf = inferencePfDemand(
      playerMTok,
      REFERENCE_MODEL,
      state.player.servingEfficiency,
    )

    // The token-facing path holds 25% installed headroom; raw shared work is
    // settled before that reserve is applied.
    expect(playerWorkPf).toBeCloseTo(sharedWorkPf / 1.25, 8)
    expect(sharedWorkPf).toBeLessThanOrEqual(snapshot.rawFlopsPf)
  })

  it('applies snapshot power/rack throttling on the precise player token path', () => {
    const state = createGame(9_102)
    const snapshot = computeSnapshot(state)
    const full = inferenceCapacityMTok(
      { ...snapshot, powerDerate: 1, engineerServeBonus: 0 },
      REFERENCE_MODEL,
      1,
      0.8,
    )
    const throttled = inferenceCapacityMTok(
      { ...snapshot, powerDerate: 0.25, engineerServeBonus: 0 },
      REFERENCE_MODEL,
      1,
      0.8,
    )
    expect(throttled).toBeCloseTo(full * 0.25, 8)
  })

  it('conserves an outbound contract under brownout and keeps seller power hosted', () => {
    let state = createGame(9_103)
    const sellerId = state.rivals[0]!.id
    const buyerId = state.rivals[1]!.id
    state = syncLabIndex({
      ...state,
      rivals: state.rivals.map((rival) =>
        rival.id === sellerId
          ? { ...rival, flopsPf: 100_000, chips: 100_000 }
          : rival,
      ),
    })
    const sellerBefore = computeLabSnapshot(state, sellerId)
    const buyerBefore = computeLabSnapshot(state, buyerId)
    expect(sellerBefore.powerDerate).toBeLessThan(0.99)
    const pf = Math.min(100, sellerBefore.availableLocalPf * 0.1)
    const contract: ComputeContract = {
      id: 'brownout-conservation',
      providerId: 'cloud-northstar',
      providerName: 'Northstar Compute',
      buyerLabId: buyerId,
      sellerLabId: sellerId,
      kind: 'rival_resale',
      regionId: state.rivals[0]!.regionId,
      pf,
      pricePerPfDay: 500,
      daysLeft: 30,
      daysTotal: 30,
      interruptionRisk: 0,
      terminationFee: 0,
      status: 'active',
      signedDay: state.day,
    }
    state = { ...state, computeContracts: [...state.computeContracts, contract] }

    const sellerAfter = computeLabSnapshot(state, sellerId)
    const buyerAfter = computeLabSnapshot(state, buyerId)
    expect(sellerBefore.rawFlopsPf - sellerAfter.rawFlopsPf).toBeCloseTo(pf, 8)
    expect(buyerAfter.rawFlopsPf - buyerBefore.rawFlopsPf).toBeCloseTo(pf, 8)
    expect(sellerAfter.rawFlopsPf + buyerAfter.rawFlopsPf).toBeCloseTo(
      sellerBefore.rawFlopsPf + buyerBefore.rawFlopsPf,
      8,
    )
    expect(sellerAfter.powerMw).toBeCloseTo(sellerBefore.powerMw, 8)
  })

  it('does not give inference-labelled racks a hidden controller yield bonus', () => {
    let state = createGame(9_104)
    const [denseRival, inferRival] = state.rivals
    const install = (
      id: string,
      skuId: string,
      x: number,
      y: number,
    ): RackInstall => ({
      id,
      skuId,
      x,
      y,
      count: 1,
      status: 'live',
      daysLeft: 0,
      paidEach: 1,
      rackUnits: 1,
    })
    state = syncLabIndex({
      ...state,
      rivals: state.rivals.map((rival) => {
        if (rival.id === denseRival!.id) {
          return {
            ...rival,
            flopsPf: 0,
            chips: 0,
            utilCap: 0.5,
            servingEfficiency: 1,
            pue: 1.2,
            allocation: { training: 0.1, inference: 0.8, research: 0.1 },
            staff: { researcher: 0, data_processor: 0, engineer: 0, ops: 0 },
            rackFleet: [
              install('dense-rack', 'rack_h100', 0, 0),
            ],
          }
        }
        if (rival.id === inferRival!.id) {
          return {
            ...rival,
            flopsPf: 0,
            chips: 0,
            utilCap: 0.5,
            servingEfficiency: 1,
            pue: 1.2,
            allocation: { training: 0.1, inference: 0.8, research: 0.1 },
            staff: { researcher: 0, data_processor: 0, engineer: 0, ops: 0 },
            rackFleet: [
              install('infer-rack', 'rack_infer', 0, 0),
            ],
          }
        }
        return rival
      }),
    })

    const dense = state.rivals.find((rival) => rival.id === denseRival!.id)!
    const infer = state.rivals.find((rival) => rival.id === inferRival!.id)!
    const denseSnapshot = computeLabSnapshot(state, dense.id)
    const inferSnapshot = computeLabSnapshot(state, infer.id)
    const denseWorkPerPf = rivalInferCapacityPf(dense, state) / denseSnapshot.rawFlopsPf
    const inferWorkPerPf = rivalInferCapacityPf(infer, state) / inferSnapshot.rawFlopsPf

    expect(inferSnapshot.hardwareTokPerSec).toBeGreaterThan(0)
    expect(inferSnapshot.rawFlopsPf).toBeLessThan(denseSnapshot.rawFlopsPf)
    expect(inferWorkPerPf).toBeCloseTo(denseWorkPerPf, 8)
  })
})

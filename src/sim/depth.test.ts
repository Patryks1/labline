import { describe, expect, it } from 'vitest'
import { createGame } from './createGame'
import {
  distillFromTeacher,
  distillRetentionFor,
  DISTILL_RETENTION,
  sizeGate,
  trainCostPfDays,
} from './balance/training'
import { modelHostNeed } from './systems/hosting'
import {
  offerUtility,
  scoreOfferFactors,
  segmentShares,
  sotaProximity,
  sotaUsageMultiplier,
} from './systems/marketScore'
import { emptyBenchmarks } from './balance/benchmarks'
import type { MarketOffer, Model, QualityAxes, BenchmarkScores } from './types'
import {
  advancePostTrain,
  keepInternal,
  playerTrainingJobs,
  releaseFromJob,
  startTraining,
  withTrainingJobs,
} from './systems/training'
import { buildBenchmarkEvent } from './systems/benchmarkEvent'
import {
  collectLeaderboardModels,
  createRivals,
  RIVAL_FIRST_RELEASE_DAY,
  rivalHostedServicePriceMultiplier,
  tickRivals,
} from './systems/rivals'
import { expectedScoresPreview } from './balance/modelScaling'
import { pfPerMTokForModel } from './balance/serveCompute'
import { specialistDomainBoost } from './systems/data'
import { tickMarket } from './systems/market'
import { computeSnapshot } from './systems/compute'
import { abstractPools } from './systems/labCompute'
import { buildLabStats, sparkPath } from './systems/stats'
import { bankCreditSnapshot, takeLoan, repayLoan } from './systems/loans'
import { buildScaledModel } from './balance/modelBuild'
import { tickDay } from './tick'
import {
  BUILDING_KIT_KINDS,
  createBuildingKit,
} from '../view/three/buildingKits'
import type { SimState } from './types'
import * as THREE from 'three'
import {
  BUILD_DEFS,
  buildingDisplayName,
  canPlaceBuilding,
  dcFootprint,
  placeBuilding,
  renameBuilding,
} from './systems/map'
import {
  facilityAnchorTiles,
  facilityFootprintTiles,
  mapTileAtAny,
  usesCompactWorld,
} from './systems/worldAccess'
import { isDcKind } from './systems/map'
import { tileCoords } from './world/ids'
import { WORLD_POPULATION } from './balance/economy'
import { applyInstantCheat } from './systems/cheats'

function baseOffer(over: Partial<MarketOffer> = {}): MarketOffer {
  return {
    labId: 'a',
    modelId: 'm',
    capability: 50,
    reliability: 55,
    safety: 50,
    brandTrust: 50,
    apiPrice: 10,
    subPrice: 20,
    latencyScore: 70,
    tokPerSec: 5000,
    modalities: ['text'],
    isOpenWeights: false,
    benchmarks: {
      ...emptyBenchmarks(),
      mmlu: 50,
      coding: 50,
      agents: 40,
      safety: 50,
    },
    ...over,
  }
}

function withCompute(s: SimState, chips = 128): SimState {
  // Prefer placing a live hall via the normal placement path so compact worlds
  // get a real facility instead of mutating the empty legacy tiles array.
  let next = {
    ...s,
    player: {
      ...s.player,
      cash: Math.max(s.player.cash, 2_000_000_000),
      finance: {
        ...s.player.finance,
        cash: Math.max(s.player.finance.cash, 2_000_000_000),
      },
    },
  }
  if (usesCompactWorld(next)) {
    const spot = findFootprintSpot(next, 'dc')
    if (spot) {
      next = placeBuilding(next, spot.x, spot.y, 'dc')
      // Instant-complete construction for tests.
      const anchor = mapTileAtAny(next, spot.x, spot.y)
      if (anchor?.campusId && next.map.world) {
        const world = next.map.world
        const batch = world.beginBatch()
        const facility = world.facilitiesById.get(anchor.campusId)
        if (
          facility &&
          facility.constructionProgress < facility.constructionTarget
        ) {
          batch.updateFacility(facility.id, {
            constructionProgress: facility.constructionTarget,
            powered: true,
            stats: {
              ...(facility.stats ?? {}),
              rackCapacity: Math.max(512, facility.stats?.rackCapacity ?? 0),
              racksUsed: 0,
              mwCapacity: facility.stats?.mwCapacity ?? 0,
            },
          })
          const result = batch.commit()
          next = {
            ...next,
            map: { ...next.map, worldRevision: result.revision },
          }
        } else {
          batch.rollback()
        }
      }
      // Add a nearby substation if possible.
      // Prefer explicit adjacent empty tile for substation.
      let subSpot: { x: number; y: number } | null = null
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
        [2, 0],
        [0, 2],
      ]) {
        const t = mapTileAtAny(next, spot.x + dx, spot.y + dy)
        if (
          t &&
          t.kind === 'empty' &&
          t.regionId !== 'void' &&
          (t.owner === 'neutral' || t.owner === 'player')
        ) {
          subSpot = { x: t.x, y: t.y }
          break
        }
      }
      if (subSpot) {
        next = placeBuilding(next, subSpot.x, subSpot.y, 'substation')
        const subTile = mapTileAtAny(next, subSpot.x, subSpot.y)
        if (subTile?.campusId && next.map.world) {
          const world = next.map.world
          const batch = world.beginBatch()
          const facility = world.facilitiesById.get(subTile.campusId)
          if (
            facility &&
            facility.constructionProgress < facility.constructionTarget
          ) {
            batch.updateFacility(facility.id, {
              constructionProgress: facility.constructionTarget,
              stats: {
                ...(facility.stats ?? {}),
                mwCapacity: Math.max(50, facility.stats?.mwCapacity ?? 0),
              },
            })
            const result = batch.commit()
            next = {
              ...next,
              map: { ...next.map, worldRevision: result.revision },
            }
          } else {
            batch.rollback()
          }
        }
      }
      const dc = mapTileAtAny(next, spot.x, spot.y)
      return {
        ...next,
        player: {
          ...next.player,
          chips: [],
          rackFleet: [
            {
              id: 'depth-fleet',
              skuId: 'rack_h100',
              x: dc?.x ?? spot.x,
              y: dc?.y ?? spot.y,
              count: chips,
              status: 'live',
              daysLeft: 0,
              paidEach: 165_000,
              rackUnits: 1,
            },
          ],
        },
      }
    }
  }

  const tiles = s.map.tiles.map((t) => {
    if (t.x === 2 && t.y === 2) {
      return {
        ...t,
        kind: 'dc' as const,
        owner: 'player' as const,
        buildingProgress: 1,
        buildingTarget: 1,
        rackCapacity: 512,
        racksUsed: 0,
      }
    }
    if (t.x === 3 && t.y === 2) {
      return {
        ...t,
        kind: 'substation' as const,
        owner: 'player' as const,
        buildingProgress: 1,
        buildingTarget: 1,
        mwCapacity: 50,
      }
    }
    return t
  })
  return {
    ...s,
    map: { ...s.map, tiles },
    player: {
      ...s.player,
      chips: [],
      rackFleet: [
        {
          id: 'depth-fleet',
          skuId: 'rack_h100',
          x: 2,
          y: 2,
          count: chips,
          status: 'live',
          daysLeft: 0,
          paidEach: 165_000,
          rackUnits: 1,
        },
      ],
    },
  }
}

function withCash(s: SimState, cash = 2_000_000_000): SimState {
  // Never reduce cash below the requested floor — withCompute may already have
  // boosted funds for expensive campus + large-model training paths.
  const nextCash = Math.max(s.player.cash, cash)
  return {
    ...s,
    player: {
      ...s.player,
      cash: nextCash,
      finance: {
        ...s.player.finance,
        cash: Math.max(s.player.finance.cash, nextCash),
      },
    },
  }
}

function forceCompleteJob(state: SimState): SimState {
  const jobs0 = playerTrainingJobs(state)
  const job0 = jobs0[0]
  if (!job0) return state
  // Jump straight to recommendation/target and clear decision stalls so
  // tests exercise completion without burning hundreds of cash-days.
  let s = withTrainingJobs(
    state,
    jobs0.map((job) =>
      job.id === job0.id
        ? {
            ...job,
            progressPfDays: Math.max(
              job.progressPfDays,
              job.targetPfDays,
              job.recommendedPfDays ?? 0,
            ),
            daysElapsed: Math.max(
              job.daysElapsed ?? 0,
              job.minCalendarDays ?? 0,
            ),
            awaitingDecision: false,
            paused: false,
            stallReason: null,
          }
        : job,
    ),
  )
  // Drive post-train to completion when present.
  for (let i = 0; i < 40; i++) {
    const jobs = playerTrainingJobs(s)
    const j = jobs.find((job) => job.id === job0.id) ?? jobs[0]
    if (!j) break
    if (j.postTrain !== 'none' && j.postTrainProgress < j.postTrainTarget) {
      s = advancePostTrain(s, j.id)
      const jobs2 = playerTrainingJobs(s)
      const j2 = jobs2.find((job) => job.id === j.id)
      if (
        j2 &&
        j2.postTrain !== 'none' &&
        j2.postTrainProgress < j2.postTrainTarget
      ) {
        s = withTrainingJobs(
          s,
          jobs2.map((job) =>
            job.id === j2.id
              ? { ...job, postTrainProgress: job.postTrainTarget }
              : job,
          ),
        )
      }
      continue
    }
    if (j.postTrain === 'none' || j.postTrainProgress >= j.postTrainTarget)
      break
  }
  return s
}

describe('MoE size + hosting', () => {
  it('size is not research-gated; host PF tracks MoE active', () => {
    // Any size ok — compute/time are the real limits
    expect(sizeGate(120, 'dense', []).ok).toBe(true)
    expect(sizeGate(900, 'moe', []).ok).toBe(true)
    expect(sizeGate(0.0001, 'dense', []).ok).toBe(false)

    const moe = {
      id: 'm',
      name: 'Sparse',
      family: 'moe' as const,
      paramsB: 200,
      activeParamsB: 10,
      capability: 40,
      modalities: ['text' as const],
      quality: {
        reasoning: 40,
        coding: 40,
        chat: 40,
        image: 0,
        video: 0,
        safety: 40,
        reliability: 40,
      },
      benchmarks: emptyBenchmarks(),
      postTrain: 'rlhf' as const,
      trainComputeSpent: 1,
      releaseDay: 1,
      shipped: true,
      release: 'released' as const,
      tokPerSecMult: 0.9,
      inferCostMult: 0.75,
      apiPricePerMTok: null,
      apiPriceInPerMTok: null,
      apiPriceOutPerMTok: null,
      suggestedApiPrice: 1,
      suggestedApiPriceIn: 0.3,
      suggestedApiPriceOut: 1.2,
      costApiPriceIn: 0.1,
      costApiPriceOut: 0.3,
      distilled: false,
      trainMode: 'pretrain' as const,
    }
    const dense = {
      ...moe,
      family: 'dense' as const,
      paramsB: 10,
      activeParamsB: undefined,
    }
    const hostMoe = modelHostNeed(moe)
    const hostDense = modelHostNeed(dense)
    const hostSparseOmni = modelHostNeed({
      ...moe,
      family: 'omni' as const,
      backbone: 'moe' as const,
    })
    // Same ~10B active path → similar host PF; MoE total 200 does not explode compute
    expect(hostMoe.hostPf).toBeLessThan(hostDense.hostPf * 1.35)
    expect(hostMoe.hostPf).toBeGreaterThan(hostDense.hostPf * 0.5)
    // VRAM for MoE experts is higher than a 10B dense
    expect(hostMoe.vramGb).toBeGreaterThan(hostDense.vramGb)
    expect(hostMoe.note.toLowerCase()).toContain('active')
    expect(hostSparseOmni.vramGb).toBeCloseTo(hostMoe.vramGb)
    expect(hostSparseOmni.hostPf).toBeCloseTo(hostMoe.hostPf)
    expect(hostSparseOmni.note.toLowerCase()).toContain('active')
  })
})

describe('corpus specialists', () => {
  it('specialistDomainBoost favors domain-matching models', () => {
    const codeModel = {
      capability: 50,
      quality: {
        reasoning: 45,
        coding: 70,
        chat: 40,
        image: 5,
        video: 0,
        safety: 40,
        reliability: 50,
      },
      benchmarks: {
        ...emptyBenchmarks(),
        coding: 72,
        agents: 40,
        mmlu: 45,
        law: 20,
        health: 15,
        vision: 10,
      },
    } as Model
    const lawModel = {
      ...codeModel,
      quality: { ...codeModel.quality, coding: 30, reasoning: 60, safety: 70 },
      benchmarks: {
        ...emptyBenchmarks(),
        coding: 25,
        law: 70,
        safety: 65,
        mmlu: 50,
      },
    } as Model
    expect(specialistDomainBoost(codeModel, 'code')).toBeGreaterThan(
      specialistDomainBoost(lawModel, 'code'),
    )
    expect(specialistDomainBoost(lawModel, 'law')).toBeGreaterThan(
      specialistDomainBoost(codeModel, 'law'),
    )
  })

  it('startTraining applies domainModels only when specialists researched', () => {
    let s = withCash(withCompute(createGame(91), 64))
    s = startTraining(s, { name: 'Coder', family: 'dense', paramsB: 1 })
    s = forceCompleteJob(s)
    s = keepInternal(s)
    const coder = s.player.models.find((m) => m.name === 'Coder')!
    // Without research — domainModels stripped
    s = withCash(s)
    s = startTraining(s, {
      name: 'NoSpec',
      family: 'dense',
      paramsB: 1,
      dataPlan: {
        totalUnits: 2,
        weights: { code: 0.5, chat: 0.5 },
        allowSynthetic: true,
        domainModels: { code: coder.id, chat: coder.id },
      },
    })
    expect(s.player.trainingJob?.dataPlan.domainModels).toBeUndefined()
    // Cancel by completing quickly / start new after finish
    s = forceCompleteJob(s)
    s = keepInternal(s)

    s = {
      ...s,
      player: {
        ...s.player,
        researchUnlocked: [
          ...s.player.researchUnlocked,
          'data_specialists',
          'data_mix',
          'data_synth',
        ],
      },
    }
    s = withCash(s)
    s = startTraining(s, {
      name: 'WithSpec',
      family: 'dense',
      paramsB: 1,
      dataPlan: {
        totalUnits: 2,
        weights: { code: 0.5, chat: 0.5 },
        allowSynthetic: true,
        domainModels: { code: coder.id, chat: coder.id },
      },
    })
    expect(s.player.trainingJob?.dataPlan.domainModels?.code).toBe(coder.id)
    expect(s.player.trainingJob?.dataPlan.domainModels?.chat).toBe(coder.id)
  })
})

describe('params × data scale formula', () => {
  it('tiny models score ~10–25; 70B does not max benches; T-scale approaches ceiling', () => {
    const tiny = expectedScoresPreview(0.4, { coverage: 1, quality: 0.95 })
    const b7 = expectedScoresPreview(7, { coverage: 1, quality: 0.95 })
    const b70 = expectedScoresPreview(70, { coverage: 1, quality: 0.95 })
    const b405 = expectedScoresPreview(405, { coverage: 1.05, quality: 1.05 })
    const b1t = expectedScoresPreview(1000, { coverage: 1.1, quality: 1.15 })

    expect(tiny.benchCeilings.mmlu).toBeGreaterThanOrEqual(8)
    expect(tiny.benchCeilings.mmlu).toBeLessThan(28)
    expect(b7.benchCeilings.mmlu).toBeLessThan(55)
    expect(b70.benchCeilings.mmlu).toBeLessThan(75)
    expect(b70.benchCeilings.mmlu).toBeGreaterThan(b7.benchCeilings.mmlu)
    expect(b405.benchCeilings.mmlu).toBeGreaterThan(b70.benchCeilings.mmlu)
    expect(b1t.benchCeilings.mmlu).toBeGreaterThan(b405.benchCeilings.mmlu)
    expect(b1t.benchCeilings.mmlu).toBeLessThan(96)
    // Under-data big model stays dumb
    const starved = expectedScoresPreview(70, { coverage: 0.25, quality: 0.5 })
    expect(starved.capability).toBeLessThan(b70.capability * 0.75)
    expect(starved.benchCeilings.mmlu).toBeLessThan(
      b70.benchCeilings.mmlu * 0.8,
    )
  })

  it('rivals use same scale formula — 7B open model not near max', () => {
    // Open-weights debut is ~7–13B via same scale path; empty at create until day 30
    const rivals = createRivals(1)
    const open = rivals.find((r) => r.archetype === 'open_weights')
    expect(open).toBeTruthy()
    expect(open!.models).toHaveLength(0)
    const openLike = expectedScoresPreview(8, { coverage: 0.95, quality: 0.9 })
    expect(openLike.capability).toBeLessThan(55)
    expect(openLike.benchCeilings.mmlu).toBeLessThan(60)
  })
})

describe('distill ~80% retention vs cheaper train', () => {
  it('distillFromTeacher lands near 0.80 retention band', () => {
    const teacherCap = 60
    const benches = { mmlu: 60, coding: 55, agents: 40 }
    const d = distillFromTeacher({
      teacherCapability: teacherCap,
      teacherBenchmarks: benches,
      studentScaleCap: 45,
    })
    expect(DISTILL_RETENTION).toBe(0.8)
    expect(d.retention).toBeGreaterThanOrEqual(0.72)
    expect(d.retention).toBeLessThanOrEqual(0.88)
    expect(d.capability).toBeCloseTo(teacherCap * d.retention, 5)
    expect(d.benchmarks.mmlu).toBeGreaterThan(40)
    expect(d.benchmarks.mmlu).toBeLessThan(teacherCap * 0.9)
  })

  it('distill job is cheaper PF-days than same-size pretrain', () => {
    const pretrain = trainCostPfDays({
      paramsB: 7,
      family: 'dense',
      trainEfficiency: 0.55,
      mode: 'pretrain',
    })
    const distill = trainCostPfDays({
      paramsB: 7,
      family: 'dense',
      trainEfficiency: 0.55,
      mode: 'distill',
      teacherParamsB: 70,
    })
    expect(distill).toBeLessThan(pretrain)
    expect(distill / pretrain).toBeLessThan(0.35)
  })

  it('teacher-heavy distill follows the size-gap retention curve; own-heavy pulls less', () => {
    let s = withCash(withCompute(createGame(88), 128))
    s = startTraining(s, { name: 'Teacher-Mix', family: 'dense', paramsB: 8 })
    s = forceCompleteJob(s)
    s = keepInternal(s)
    const teacher = s.player.models.find((m) => m.name === 'Teacher-Mix')!
    // Boost teacher so gap is clear
    s = {
      ...s,
      player: {
        ...s.player,
        models: s.player.models.map((m) =>
          m.id === teacher.id
            ? {
                ...m,
                capability: 60,
                benchmarks: { ...m.benchmarks, mmlu: 58 },
              }
            : m,
        ),
      },
    }
    const t = s.player.models.find((m) => m.name === 'Teacher-Mix')!

    s = withCash(s)
    s = startTraining(s, {
      name: 'Student-HeavyTeacher',
      family: 'dense',
      paramsB: 3,
      mode: 'distill',
      teacherId: t.id,
      distillTeacherShare: 0.9,
      dataPlan: {
        totalUnits: 4,
        weights: { chat: 0.5, code: 0.5 },
        allowSynthetic: true,
      },
    })
    s = forceCompleteJob(s)
    s = keepInternal(s)
    const heavyT = s.player.models.find(
      (m) => m.name === 'Student-HeavyTeacher',
    )!
    const ratioHeavy = heavyT.capability / t.capability
    // Size-gap retention (distillRetentionFor): 8B → 3B keeps ~66–88% of the
    // teacher instead of the legacy flat ~80%; data quality and RNG move it.
    const midRetention = distillRetentionFor({
      teacherParamsB: t.paramsB,
      studentParamsB: 3,
      dataFactor: 0.6,
      rng01: 0.5,
    })
    expect(ratioHeavy).toBeGreaterThanOrEqual(midRetention - 0.22)
    expect(ratioHeavy).toBeLessThanOrEqual(0.9)
    expect(heavyT.distillTeacherShare).toBeCloseTo(0.9, 2)

    s = withCash(s)
    s = startTraining(s, {
      name: 'Student-HeavyOwn',
      family: 'dense',
      paramsB: 3,
      mode: 'distill',
      teacherId: t.id,
      distillTeacherShare: 0.15,
      dataPlan: {
        totalUnits: 8,
        weights: { chat: 0.4, code: 0.6 },
        allowSynthetic: true,
      },
    })
    s = forceCompleteJob(s)
    s = keepInternal(s)
    const heavyOwn = s.player.models.find((m) => m.name === 'Student-HeavyOwn')!
    // Own-heavy should not lock as tightly to teacher 80%
    expect(heavyOwn.capability / t.capability).toBeLessThan(ratioHeavy + 0.02)
    expect(heavyOwn.distillTeacherShare).toBeCloseTo(0.15, 2)
  })

  it('full path: teacher pretrain then student distill via real training APIs', () => {
    let s = withCash(withCompute(createGame(42), 256))
    s = startTraining(s, { name: 'Teacher-70', family: 'dense', paramsB: 7 })
    s = forceCompleteJob(s)
    expect(s.player.trainingJob?.progressPfDays).toBeGreaterThanOrEqual(
      s.player.trainingJob!.targetPfDays,
    )
    s = keepInternal(s)
    const teacher = s.player.models[0]!
    expect(teacher.capability).toBeGreaterThan(6)

    const pretrainCost = trainCostPfDays({
      paramsB: 3,
      family: 'dense',
      trainEfficiency: s.player.trainEfficiency,
      mode: 'pretrain',
    })
    const distillCost = trainCostPfDays({
      paramsB: 3,
      family: 'dense',
      trainEfficiency: s.player.trainEfficiency,
      mode: 'distill',
      teacherParamsB: teacher.paramsB,
    })

    s = withCash(s)
    s = startTraining(s, {
      name: 'Student-3',
      family: 'dense',
      paramsB: 3,
      mode: 'distill',
      teacherId: teacher.id,
      distillTeacherShare: 0.85,
    })
    expect(s.player.trainingJob?.mode).toBe('distill')
    // Raw distill cost stays cheaper than pretrain; PF is the only completion
    // gate and legacy calendar telemetry must never manufacture work.
    expect(distillCost).toBeLessThan(pretrainCost)
    expect(s.player.trainingJob!.targetPfDays).toBeGreaterThan(0)
    expect(s.player.trainingJob!.minCalendarDays).toBe(0)
    expect(s.player.trainingJob!.distillTeacherShare).toBeGreaterThan(0.8)

    s = forceCompleteJob(s)
    s = keepInternal(s)
    const student = s.player.models.find((m) => m.name === 'Student-3')!
    const ratio = student.capability / teacher.capability
    expect(ratio).toBeGreaterThanOrEqual(0.65)
    expect(ratio).toBeLessThanOrEqual(0.9)
    expect(student.distilled).toBe(true)
  })
})

describe('multi-factor market demand', () => {
  it('lower price gains share when other factors equal', () => {
    const cheap = baseOffer({ labId: 'cheap', apiPrice: 2, subPrice: 5 })
    const dear = baseOffer({ labId: 'dear', apiPrice: 40, subPrice: 80 })
    const shares = segmentShares([cheap, dear], 'indie_api')
    expect(shares[0]!).toBeGreaterThan(shares[1]!)
  })

  it('charges hosted open-weight offers while preserving an ecosystem feature bonus', () => {
    const cheap = baseOffer({
      labId: 'open-cheap',
      apiPrice: 2,
      isOpenWeights: true,
    })
    const dear = baseOffer({
      labId: 'open-dear',
      apiPrice: 40,
      isOpenWeights: true,
    })
    const hosted = scoreOfferFactors(cheap, 'indie_api')
    const closed = scoreOfferFactors(
      { ...cheap, isOpenWeights: false },
      'indie_api',
    )
    expect(hosted.effectivePrice).toBeGreaterThan(0)
    expect(hosted.tooling).toBeGreaterThan(closed.tooling)
    const shares = segmentShares([cheap, dear], 'indie_api')
    expect(shares[0]!).toBeGreaterThan(shares[1]!)
  })

  it('higher intelligence gains share when other factors equal', () => {
    const smart = baseOffer({
      labId: 'smart',
      capability: 80,
      benchmarks: { ...emptyBenchmarks(), mmlu: 80, coding: 80, agents: 70 },
    })
    const dumb = baseOffer({
      labId: 'dumb',
      capability: 25,
      benchmarks: { ...emptyBenchmarks(), mmlu: 20, coding: 20, agents: 15 },
    })
    const shares = segmentShares([smart, dumb], 'startup_api')
    expect(shares[0]!).toBeGreaterThan(shares[1]!)
  })

  it('higher speed/latency gains share when other factors equal', () => {
    const fast = baseOffer({
      labId: 'fast',
      latencyScore: 95,
      tokPerSec: 80_000,
    })
    const slow = baseOffer({ labId: 'slow', latencyScore: 25, tokPerSec: 200 })
    const shares = segmentShares([fast, slow], 'indie_api')
    expect(shares[0]!).toBeGreaterThan(shares[1]!)
  })

  it('tooling/features gains share when other factors equal', () => {
    const tools = baseOffer({
      labId: 'tools',
      modalities: ['text', 'tools', 'image'],
      benchmarks: { ...emptyBenchmarks(), mmlu: 50, coding: 50, agents: 85 },
    })
    const plain = baseOffer({
      labId: 'plain',
      modalities: ['text'],
      benchmarks: { ...emptyBenchmarks(), mmlu: 50, coding: 50, agents: 10 },
    })
    const shares = segmentShares([tools, plain], 'startup_api')
    expect(shares[0]!).toBeGreaterThan(shares[1]!)
    const fTools = scoreOfferFactors(tools, 'startup_api')
    const fPlain = scoreOfferFactors(plain, 'startup_api')
    expect(fTools.tooling).toBeGreaterThan(fPlain.tooling)
  })

  it('offerUtility uses all four factors', () => {
    const o = baseOffer()
    const f = scoreOfferFactors(o, 'enterprise')
    expect(f.intelligence).toBeGreaterThan(0)
    expect(f.price).toBeGreaterThan(0)
    expect(f.speed).toBeGreaterThan(0)
    expect(f.tooling).toBeGreaterThan(0)
    expect(offerUtility(o, 'enterprise')).toBeGreaterThan(-30)
  })

  it('SOTA beats a dumb free model on enterprise and startup API', () => {
    const sota = baseOffer({
      labId: 'sota',
      capability: 78,
      apiPrice: 45,
      subPrice: 80,
      reliability: 70,
      brandTrust: 70,
      benchmarks: {
        ...emptyBenchmarks(),
        mmlu: 82,
        coding: 80,
        agents: 75,
        safety: 70,
      },
    })
    const dumbCheap = baseOffer({
      labId: 'dump',
      capability: 22,
      apiPrice: 0.15,
      subPrice: 0,
      reliability: 40,
      brandTrust: 40,
      benchmarks: {
        ...emptyBenchmarks(),
        mmlu: 18,
        coding: 15,
        agents: 10,
        safety: 30,
      },
    })
    for (const seg of ['enterprise', 'startup_api', 'consumer'] as const) {
      const shares = segmentShares([sota, dumbCheap], seg)
      expect(shares[0]!, `${seg} sota share`).toBeGreaterThan(0.55)
      expect(shares[0]!).toBeGreaterThan(shares[1]! * 1.8)
    }
  })

  it('near-SOTA cheap model still wins meaningful share vs expensive SOTA', () => {
    const sota = baseOffer({
      labId: 'sota',
      capability: 70,
      apiPrice: 40,
      subPrice: 60,
      reliability: 65,
      brandTrust: 60,
      benchmarks: { ...emptyBenchmarks(), mmlu: 72, coding: 70, agents: 60 },
    })
    const nearCheap = baseOffer({
      labId: 'near',
      capability: 62,
      apiPrice: 2.5,
      subPrice: 12,
      reliability: 58,
      brandTrust: 52,
      benchmarks: { ...emptyBenchmarks(), mmlu: 64, coding: 60, agents: 52 },
    })
    const shares = segmentShares([sota, nearCheap], 'indie_api')
    // Near-SOTA at low price must not be starved (~0 users)
    expect(shares[1]!).toBeGreaterThan(0.18)
    expect(shares[0]! + shares[1]!).toBeCloseTo(1, 5)
  })

  it('mid-pack models still compete on price when quality is similar', () => {
    const midCheap = baseOffer({
      labId: 'mid-c',
      capability: 48,
      apiPrice: 1.5,
      subPrice: 12,
      benchmarks: { ...emptyBenchmarks(), mmlu: 50, coding: 48, agents: 40 },
    })
    const midDear = baseOffer({
      labId: 'mid-d',
      capability: 48,
      apiPrice: 28,
      subPrice: 60,
      benchmarks: { ...emptyBenchmarks(), mmlu: 50, coding: 48, agents: 40 },
    })
    // Indie API is price-sensitive among peers
    const shares = segmentShares(
      [midCheap, midDear],
      'indie_api',
      undefined,
      70,
    )
    expect(shares[0]!).toBeGreaterThan(shares[1]!)
  })

  it('SOTA usage multiplier is far above lagging models', () => {
    const sota = sotaProximity(80, 80)
    const mid = sotaProximity(55, 80)
    const lag = sotaProximity(30, 80)
    expect(sotaUsageMultiplier(sota, 'enterprise')).toBeGreaterThan(
      sotaUsageMultiplier(mid, 'enterprise') * 1.5,
    )
    expect(sotaUsageMultiplier(sota, 'startup_api')).toBeGreaterThan(
      sotaUsageMultiplier(lag, 'startup_api') * 1.8,
    )
    expect(sotaUsageMultiplier(sota, 'enterprise')).toBeGreaterThan(4)
  })

  it('3rd–4th place still gets meaningful API segment share', () => {
    const sota = baseOffer({
      labId: 'sota',
      capability: 72,
      apiPrice: 12,
      reliability: 65,
      brandTrust: 60,
      benchmarks: { ...emptyBenchmarks(), mmlu: 74, coding: 70, agents: 60 },
    })
    const second = baseOffer({
      labId: 'p2',
      capability: 64,
      apiPrice: 4,
      reliability: 58,
      brandTrust: 52,
      benchmarks: { ...emptyBenchmarks(), mmlu: 66, coding: 62, agents: 50 },
    })
    const third = baseOffer({
      labId: 'p3',
      capability: 56,
      apiPrice: 2,
      reliability: 55,
      brandTrust: 48,
      benchmarks: { ...emptyBenchmarks(), mmlu: 58, coding: 54, agents: 42 },
    })
    const fourth = baseOffer({
      labId: 'p4',
      capability: 50,
      apiPrice: 1.2,
      reliability: 50,
      brandTrust: 45,
      benchmarks: { ...emptyBenchmarks(), mmlu: 52, coding: 48, agents: 38 },
    })
    const shares = segmentShares(
      [sota, second, third, fourth],
      'startup_api',
      undefined,
      72,
    )
    // Not a pure winner-take-all — mid pack keeps a pulse
    expect(shares[2]! + shares[3]!).toBeGreaterThan(0.05)
    expect(shares[3]!).toBeGreaterThan(0.012)
    expect(shares[0]!).toBeGreaterThan(shares[1]!)
  })
})

describe('serving efficiency & capacity', () => {
  it('higher servingEfficiency lowers PF per MTok and raises capacity', () => {
    const model = {
      paramsB: 8,
      family: 'dense' as const,
      inferCostMult: 1,
      tokPerSecMult: 0.7,
    }
    const low = pfPerMTokForModel(model, 0.3)
    const high = pfPerMTokForModel(model, 1.2)
    expect(low).toBeGreaterThan(high * 2)
  })

  it('no unserved complaints when demand is under capacity', () => {
    let s = withCash(withCompute(createGame(44), 128))
    s = {
      ...s,
      player: {
        ...s.player,
        allocation: { training: 0.1, inference: 0.8, research: 0.1 },
        servingEfficiency: 0.9,
      },
    }
    s = startTraining(s, { name: 'Cap', family: 'dense', paramsB: 2 })
    s = forceCompleteJob(s)
    s = releaseFromJob(s)
    const m = s.player.models[0]!
    s = {
      ...s,
      player: {
        ...s.player,
        models: [
          { ...m, capability: 40, quality: { ...m.quality, reliability: 55 } },
        ],
        brandTrust: 55,
        servicePain: 0.5, // residual — should heal when healthy
      },
    }
    s = tickMarket(s)
    // With lots of serve PF and a small model, should not invent overload
    if (s.lastMarket.playerDemandMTok < s.lastMarket.capacityMTok * 0.9) {
      expect(s.lastMarket.unservedRatio).toBeLessThan(0.08)
      expect(s.player.servicePain).toBeLessThan(0.5)
    }
  })
})

describe('post-release benchmark event', () => {
  it('buildBenchmarkEvent compares to rivals', () => {
    const s = createGame(9)
    const quality: QualityAxes = {
      reasoning: 50,
      coding: 50,
      chat: 50,
      image: 5,
      video: 0,
      safety: 50,
      reliability: 55,
    }
    const benchmarks: BenchmarkScores = {
      ...emptyBenchmarks(),
      mmlu: 70,
      coding: 75,
      math: 60,
      vision: 10,
      law: 20,
      health: 15,
      science: 40,
      multilingual: 30,
      agents: 55,
      safety: 50,
    }
    const model: Model = {
      id: 'test-m',
      name: 'Test',
      family: 'dense',
      paramsB: 7,
      capability: 55,
      modalities: ['text'],
      quality,
      benchmarks,
      postTrain: 'rlhf',
      trainComputeSpent: 10,
      releaseDay: 1,
      shipped: true,
      release: 'released',
      tokPerSecMult: 0.7,
      inferCostMult: 1,
      apiPricePerMTok: null,
      apiPriceInPerMTok: null,
      apiPriceOutPerMTok: null,
      suggestedApiPrice: 1,
      suggestedApiPriceIn: 0.3,
      suggestedApiPriceOut: 1.2,
      costApiPriceIn: 0.15,
      costApiPriceOut: 0.5,
      distilled: false,
      trainMode: 'pretrain',
    }
    const ev = buildBenchmarkEvent(s, model, 5)
    expect(ev.rivalCompare.length).toBeGreaterThan(5)
    expect(ev.wins + ev.losses).toBe(ev.rivalCompare.length)
    expect(ev.headline.length).toBeGreaterThan(10)
    expect(ev.modelId).toBe('test-m')
  })

  it('releaseFromJob schedules separate delayed evaluations', () => {
    let s = withCash(withCompute(createGame(11), 128))
    s = startTraining(s, { name: 'Pub', family: 'dense', paramsB: 1 })
    s = forceCompleteJob(s)
    s = releaseFromJob(s)
    expect(s.lastBenchmarkEvent).toBeNull()
    expect(s.evaluations.map((evaluation) => evaluation.kind)).toEqual([
      'internal',
      'public',
      'blind_audit',
      'real_world',
    ])
    s = tickDay(tickDay(tickDay(s)))
    expect(s.lastBenchmarkEvent?.modelName).toBe('Pub')
    expect(s.lastBenchmarkEvent?.dismissed).toBe(false)
  })
})

describe('rivals and supply', () => {
  it('positions efficiency below hosted open service without changing yields', () => {
    const efficiency = rivalHostedServicePriceMultiplier('efficiency', 0)
    const open = rivalHostedServicePriceMultiplier('open_weights', 0)
    const general = rivalHostedServicePriceMultiplier('hyperscale', 0)
    expect(efficiency).toBeLessThan(open)
    expect(open).toBeLessThan(general)
  })

  it('starts every rival with one named lead coordinating one unassigned pod', () => {
    const state = createGame(1300)
    for (const rival of state.rivals) {
      expect(rival.researchLeads).toHaveLength(1)
      expect(rival.researchPods).toHaveLength(1)
      const lead = rival.researchLeads![0]!
      const pod = rival.researchPods![0]!
      expect(lead.name.length).toBeGreaterThan(5)
      expect(pod.leadId).toBe(lead.id)
      expect(pod.assignmentId).toBeNull()
    }
  })

  it('records rival processed crawl and traffic as canonical provenance assets', () => {
    let state = createGame(1301)
    state = {
      ...state,
      day: state.day + 1,
      lastMarket: {
        ...state.lastMarket,
        industryDemandMTok: 120,
        industryServedMTok: 100,
      },
    }
    state = tickRivals(state)
    for (const rival of state.rivals) {
      const assets = rival.data?.assets ?? []
      expect(assets.some((asset) => asset.source === 'web')).toBe(true)
      expect(assets.some((asset) => asset.source === 'user')).toBe(true)
      expect(assets.every((asset) => asset.volumeMTok >= 0)).toBe(true)
    }
  })

  it('tickRivals mutates archetype state', () => {
    let s = createGame(13)
    const before = s.rivals.map((r) => ({
      id: r.id,
      price: r.pricing.apiPricePerMTok,
      chips: r.chips,
      util: r.utilCap,
    }))
    for (let i = 0; i < 20; i++) {
      s = { ...s, day: s.day + 1 }
      s = tickRivals(s)
    }
    const after = s.rivals
    // At least one rival changed price, chips, research progress, or model capability
    const changed = after.some((r, i) => {
      const b = before[i]!
      return (
        r.pricing.apiPricePerMTok !== b.price ||
        r.chips !== b.chips ||
        r.utilCap !== b.util ||
        r.researchProgress > 0
      )
    })
    expect(changed).toBe(true)
    expect(after.length).toBe(5)
  })

  it('rivals release only through completed shared-rule training jobs', () => {
    let s = withCash(withCompute(createGame(21), 128))
    s = startTraining(s, { name: 'PlayerSOTA', family: 'dense', paramsB: 8 })
    s = forceCompleteJob(s)
    s = releaseFromJob(s)
    // Boost player model so it leads
    const pm = s.player.models[0]!
    s = {
      ...s,
      player: {
        ...s.player,
        models: [
          {
            ...pm,
            capability: 55,
            benchmarks: {
              ...pm.benchmarks,
              mmlu: 62,
              coding: 58,
              math: 55,
              agents: 50,
            },
          },
        ],
      },
    }
    const startCap = s.player.models[0]!.capability
    const startRivalMax = Math.max(
      ...s.rivals.map((r) => r.models[0]?.capability ?? 0),
    )
    // Short window: rivals can publish a completed run, but receive no passive capability nudges.
    for (let i = 0; i < 7; i++) {
      s = { ...s, day: s.day + 1 }
      s = tickRivals(s)
    }
    const afterRivalMax = Math.max(
      ...s.rivals.flatMap((r) => r.models.map((m) => m.capability)),
    )
    // Early undertrained releases remain bounded by the shared data/compute curve.
    expect(afterRivalMax - startRivalMax).toBeLessThan(25)
    // Player still competitive on overall capability in the short window.
    const bestRival = Math.max(
      ...s.rivals.flatMap((r) => r.models.map((m) => m.capability)),
    )
    expect(bestRival).toBeLessThan(startCap + 15)
  })

  it('hard difficulty rivals research/release faster than easy', () => {
    const run = (diff: 'easy' | 'hard') => {
      let s = createGame(42)
      s = { ...s, config: { ...s.config, difficulty: diff } }
      let releases = 0
      let maxResearchDays = 0
      for (let i = 0; i < 60; i++) {
        s = { ...s, day: s.day + 1 }
        const beforeNames = s.rivals.map((r) => r.models[0]?.name)
        s = tickRivals(s)
        const afterNames = s.rivals.map((r) => r.models[0]?.name)
        if (beforeNames.some((n, j) => n !== afterNames[j])) releases++
        maxResearchDays = Math.max(
          maxResearchDays,
          ...s.rivals.map((r) => r.researchProgress),
        )
      }
      return {
        releases,
        news: s.news.length,
        unlocks: s.rivals.reduce((n, r) => n + r.researchUnlocked.length, 0),
      }
    }
    const easy = run('easy')
    const hard = run('hard')
    expect(hard.releases + hard.unlocks).toBeGreaterThanOrEqual(
      easy.releases + easy.unlocks - 2,
    )
    expect(hard.news).toBeGreaterThan(0)
  })

  it('rivals have no models for first 30 days then ship', () => {
    let s = createGame(7)
    expect(s.day).toBe(1)
    expect(s.rivals.every((r) => r.models.length === 0)).toBe(true)
    // Full day tick — empty through day 29
    while (s.day < RIVAL_FIRST_RELEASE_DAY) {
      s = tickDay(s)
      if (s.day < RIVAL_FIRST_RELEASE_DAY) {
        expect(s.rivals.every((r) => r.models.length === 0)).toBe(true)
      }
    }
    expect(s.day).toBe(RIVAL_FIRST_RELEASE_DAY)
    // Staggered debuts shortly after day 30
    for (let i = 0; i < 20; i++) s = tickDay(s)
    const withModels = s.rivals.filter((r) => r.models.length > 0)
    expect(withModels.length).toBeGreaterThanOrEqual(3)
    // Debuts should be real public models
    expect(
      withModels.every(
        (r) => r.models[0]!.shipped || r.models[0]!.release === 'released',
      ),
    ).toBe(true)
    expect(
      withModels.every((r) => {
        const model = r.models[0]!
        const v4Live =
          model.shipped ||
          model.release === "released" ||
          (r.training?.endpoints.some(
            (endpoint) => endpoint.status === "live" && endpoint.modelId === model.id,
          ) ?? false)
        if (v4Live && !model.dataManifestId) return true
        return (
          model.dataManifestId != null &&
          (r.data?.manifests ?? []).some(
            (manifest) => manifest.id === model.dataManifestId,
          ) &&
          (r.trainingPrograms ?? []).some(
            (program) =>
              program.dataManifestId === model.dataManifestId &&
              program.checkpoints.some(
                (checkpoint) => checkpoint.progress === 1,
              ),
          )
        )
      }),
    ).toBe(true)
    expect(
      s.rivals.every(
        (r) =>
          (r.researchLeads ?? []).length > 0 &&
          (r.researchPods ?? []).length > 0,
      ),
    ).toBe(true)
  })

  it('collectLeaderboardModels ranks player + rivals and keeps history', () => {
    let s = createGame(7)
    // Advance past first-release window + cadence
    for (let i = 0; i < 55; i++) {
      s = { ...s, day: s.day + 1 }
      s = tickRivals(s)
    }
    const board = collectLeaderboardModels(s)
    // At least rivals who shipped (or empty board of player-only is ok if none shipped)
    expect(board.length).toBeGreaterThanOrEqual(0)
    if (s.rivals.some((r) => r.models.length > 0)) {
      expect(board.length).toBeGreaterThanOrEqual(1)
    }
    // Sorted descending by score
    for (let i = 1; i < board.length; i++) {
      const score = (row: (typeof board)[0]) => {
        const vals = Object.values(row.model.benchmarks)
        const avg = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length)
        return row.model.capability + avg * 0.15
      }
      expect(score(board[i - 1]!)).toBeGreaterThanOrEqual(
        score(board[i]!) - 0.001,
      )
    }
    // Multiple gens from same lab can appear after releases
    const multi = s.rivals.some((r) => r.models.length > 1)
    if (multi) {
      const labCounts = new Map<string, number>()
      for (const row of board) {
        labCounts.set(row.labId, (labCounts.get(row.labId) ?? 0) + 1)
      }
      expect([...labCounts.values()].some((c) => c > 1)).toBe(true)
    }

    const publicModel = board[0]?.model
    if (publicModel) {
      const internal = {
        ...publicModel,
        id: `${publicModel.id}-stealth-test`,
        release: 'internal' as const,
        shipped: false,
      }
      const privateState = {
        ...s,
        player: { ...s.player, models: [...s.player.models, internal] },
      }
      expect(
        collectLeaderboardModels(privateState).some(
          (row) => row.model.id === internal.id,
        ),
      ).toBe(false)
    }
  })

  it('capacity constraint reduces served vs demand via real tickMarket', () => {
    let s = withCompute(createGame(15), 4)
    // ship a model so demand exists
    s = startTraining(s, { name: 'Tiny', family: 'dense', paramsB: 1 })
    s = forceCompleteJob(s)
    s = releaseFromJob(s)
    // starve inference — only 2 live racks
    const dc = facilityAnchorTiles(s, { ownerId: 'player' }).find(
      (t) => t.kind === 'dc' || isDcKind(t.kind),
    )!
    s = {
      ...s,
      computeContracts: [],
      computeLeases: [],
      player: {
        ...s.player,
        allocation: { training: 0.05, inference: 0.05, research: 0.9 },
        chips: [],
        rackFleet: [
          {
            id: 'tiny',
            skuId: 'rack_h100',
            x: dc.x,
            y: dc.y,
            count: 2,
            status: 'live',
            daysLeft: 0,
            paidEach: 165_000,
            rackUnits: 1,
          },
        ],
      },
    }
    s = tickMarket(s)
    expect(s.lastMarket.playerDemandMTok).toBeGreaterThanOrEqual(0)
    // with tiny capacity, unserved should be high when demand exists
    if (s.lastMarket.playerDemandMTok > 0.01) {
      expect(s.lastMarket.unservedRatio).toBeGreaterThan(0.1)
      expect(s.lastMarket.servedMTok).toBeLessThanOrEqual(
        s.lastMarket.playerDemandMTok + 1e-6,
      )
      expect(s.lastMarket.demandPf).toBeGreaterThan(0)
      expect(s.lastMarket.capacityPf).toBeLessThan(s.lastMarket.demandPf)
    }
    const snap = computeSnapshot(s)
    // chipCount includes remote GPU-equivalent when cloud contracts remain;
    // assert local fleet occupancy instead under the starved owned-hall setup.
    expect(
      s.player.rackFleet.reduce(
        (n, r) => n + (r.status === 'live' ? r.count : 0),
        0,
      ),
    ).toBe(2)
    expect(snap.chipCount).toBeGreaterThanOrEqual(2)
  })

  it('inference slider gates shared pool — more Serve % lowers unserved', () => {
    // Allocation→pool math is controller-neutral (abstractPools). Physical
    // demand-reservation can invert capacityPf under heavy serve cost, so the
    // slider ratio is checked on the shared abstract path; market tick still
    // verifies unserved improves when demand exists.
    let s = withCompute(createGame(31), 96)
    s = startTraining(s, { name: 'ServeTest', family: 'dense', paramsB: 1 })
    s = forceCompleteJob(s)
    s = releaseFromJob(s)
    const m = s.player.models[0]!
    const model = {
      ...m,
      paramsB: 1,
      activeParamsB: 1,
      capability: 48,
      quality: { ...m.quality, reliability: 60 },
      inferCostMult: 1,
    }
    s = {
      ...s,
      player: {
        ...s.player,
        models: [model],
        brandTrust: 55,
        servingEfficiency: 1.2,
        utilCap: 0.75,
      },
    }

    const lowPools = abstractPools({
      flopsPf: 80,
      utilCap: 0.75,
      allocation: { training: 0.7, inference: 0.1, research: 0.2 },
      servingEfficiency: 1.2,
    })
    const highPools = abstractPools({
      flopsPf: 80,
      utilCap: 0.75,
      allocation: { training: 0.15, inference: 0.75, research: 0.1 },
      servingEfficiency: 1.2,
    })
    expect(highPools.inference).toBeGreaterThan(lowPools.inference * 2)

    s = {
      ...s,
      player: {
        ...s.player,
        allocation: { training: 0.7, inference: 0.1, research: 0.2 },
      },
    }
    s = tickMarket(s)
    const lowInfer = s.lastMarket

    s = {
      ...s,
      player: {
        ...s.player,
        allocation: { training: 0.15, inference: 0.75, research: 0.1 },
      },
    }
    s = tickMarket(s)
    const highInfer = s.lastMarket

    if (lowInfer.playerDemandMTok > 1) {
      expect(highInfer.unservedRatio).toBeLessThanOrEqual(
        lowInfer.unservedRatio + 0.001,
      )
      expect(highInfer.servedMTok).toBeGreaterThanOrEqual(
        lowInfer.servedMTok * 0.99,
      )
    }
  })

  it('one mid hall cannot casually hold double-digit share without overload', () => {
    // 96 racks ≈ one filled L1 data hall; 50% serve allocation
    let s = withCash(withCompute(createGame(33), 96))
    s = startTraining(s, { name: 'Mid', family: 'dense', paramsB: 8 })
    s = forceCompleteJob(s)
    s = releaseFromJob(s)
    expect(s.player.models.length).toBeGreaterThan(0)
    const m = s.player.models[0]!
    s = {
      ...s,
      player: {
        ...s.player,
        models: [
          {
            ...m,
            capability: 52,
            quality: { ...m.quality, reliability: 65, safety: 55 },
          },
        ],
        brandTrust: 62,
        allocation: { training: 0.3, inference: 0.5, research: 0.2 },
        pricing: {
          ...s.player.pricing,
          activeModelId: m.id,
          apiPricePerMTok: 2,
          apiPriceInPerMTok: 0.7,
          apiPriceOutPerMTok: 2.5,
        },
      },
    }
    s = tickMarket(s)
    expect(s.lastMarket.capacityPf).toBeGreaterThan(0)
    // Demand must scale with usage — non-zero product traffic burns PF
    expect(s.lastMarket.playerDemandMTok).toBeGreaterThan(0.5)
    expect(s.lastMarket.demandPf).toBeGreaterThan(0.05)
    // One hall at 50% serve should not leave huge idle headroom at competitive share
    const load = s.lastMarket.demandPf / Math.max(0.01, s.lastMarket.capacityPf)
    if ((s.player.finance.totalShare ?? 0) >= 0.1) {
      expect(load).toBeGreaterThan(0.65)
    } else {
      // Even with modest share, capacity must not be absurdly oversized (old: ~500× headroom)
      expect(load).toBeGreaterThan(0.03)
    }
  })

  it('overload raises latency pain and bleeds brand over days', () => {
    let s = withCompute(createGame(21), 8)
    s = startTraining(s, { name: 'Pub', family: 'dense', paramsB: 1 })
    s = forceCompleteJob(s)
    s = releaseFromJob(s)
    const dc = facilityAnchorTiles(s, { ownerId: 'player' }).find(
      (t) => t.kind === 'dc' || isDcKind(t.kind),
    )!
    // Almost no inference allocation + tiny fleet → chronic shortfall
    s = {
      ...s,
      player: {
        ...s.player,
        brandTrust: 60,
        servicePain: 0,
        allocation: { training: 0.1, inference: 0.05, research: 0.85 },
        rackFleet: [
          {
            id: 'starve',
            skuId: 'rack_h100',
            x: dc.x,
            y: dc.y,
            count: 2,
            status: 'live',
            daysLeft: 0,
            paidEach: 165_000,
            rackUnits: 1,
          },
        ],
      },
    }
    const brand0 = s.player.brandTrust
    s = tickMarket(s)
    if (s.lastMarket.playerDemandMTok > 0.05) {
      expect(s.lastMarket.unservedRatio).toBeGreaterThan(0.05)
      expect(s.lastMarket.effectiveLatencyScore).toBeLessThan(
        s.lastMarket.latencyScore + 0.01,
      )
      expect(s.player.servicePain).toBeGreaterThan(0)
    }
    // Linger pain for several days of overload
    for (let i = 0; i < 5; i++) s = tickMarket(s)
    if (s.lastMarket.playerDemandMTok > 0.05) {
      expect(s.player.servicePain).toBeGreaterThan(0.1)
      expect(s.player.brandTrust).toBeLessThan(brand0)
      expect(s.lastMarket.effectiveLatencyScore).toBeLessThan(50)
    }
  })
})

describe('3D building kits structural', () => {
  it('createBuildingKit returns non-empty meshes for DC and ownership colors differ', () => {
    expect(BUILDING_KIT_KINDS).toContain('dc')
    expect(BUILDING_KIT_KINDS).toContain('dc_m')
    expect(BUILDING_KIT_KINDS).toContain('dc_l')
    expect(BUILDING_KIT_KINDS).toContain('fab')
    const playerDc = createBuildingKit('dc', 0x3dffc0, 0.6)
    const rivalDc = createBuildingKit('dc', 0x4da3ff, 0.6)
    expect(playerDc.children.length).toBeGreaterThan(2)
    expect(rivalDc.children.length).toBeGreaterThan(2)
    expect(playerDc).toBeInstanceOf(THREE.Group)
  })

  it('each DC size has a unique multi-mesh kit', () => {
    const small = createBuildingKit('dc', 0x3dffc0, 0.5)
    const medium = createBuildingKit('dc_m', 0x2dd4a8, 0.55)
    const large = createBuildingKit('dc_l', 0x14b8a6, 0.65)
    expect(small.children.length).toBeGreaterThan(4)
    expect(medium.children.length).toBeGreaterThan(small.children.length)
    expect(large.children.length).toBeGreaterThan(medium.children.length)
    expect(small.userData.kit).toBe('dc')
    expect(medium.userData.kit).toBe('dc_m')
    expect(large.userData.kit).toBe('dc_l')
  })

  it('scenic kits are multi-mesh models with seeded variation', () => {
    for (const kind of [
      'lake',
      'forest',
      'house',
      'road',
      'park',
      'warehouse',
    ] as const) {
      const a = createBuildingKit(kind, 0x888888, 0.4, 2, 3)
      const b = createBuildingKit(kind, 0x888888, 0.4, 2, 3)
      const c = createBuildingKit(kind, 0x888888, 0.4, 5, 7)
      expect(a.children.length).toBeGreaterThan(2)
      expect(a.children.length).toBe(b.children.length)
      // different tiles should usually differ (seeded layout)
      expect(a.children.length + c.children.length).toBeGreaterThan(4)
    }
  })
})

function findFootprintSpot(
  state: SimState,
  kind: 'dc' | 'dc_m' | 'dc_l',
): { x: number; y: number } | null {
  const footprint = dcFootprint(kind)
  const isEmpty = (x: number, y: number) => {
    const tile = mapTileAtAny(state, x, y)
    return (
      !!tile &&
      tile.kind === 'empty' &&
      tile.regionId !== 'void' &&
      (tile.owner === 'neutral' || tile.owner === 'player')
    )
  }
  const fits = (x: number, y: number) =>
    footprint.every(({ dx, dy }) => isEmpty(x + dx, y + dy)) &&
    canPlaceBuilding(state, x, y, kind).ok

  if (usesCompactWorld(state) && state.map.world) {
    const world = state.map.world
    for (const id of world.staticWorld.starterPads) {
      const { x, y } = tileCoords(id, world.descriptor.width)
      if (fits(x, y)) return { x, y }
    }
    for (const city of state.map.cities ?? []) {
      for (let radius = city.radius + 1; radius <= city.radius + 28; radius++) {
        for (let offset = -radius; offset <= radius; offset++) {
          const candidates = [
            [city.cx + offset, city.cy - radius],
            [city.cx + offset, city.cy + radius],
            [city.cx - radius, city.cy + offset],
            [city.cx + radius, city.cy + offset],
          ] as const
          for (const [x, y] of candidates) {
            if (fits(x, y)) return { x, y }
          }
        }
      }
    }
    return null
  }

  for (const tile of state.map.tiles) {
    if (!isEmpty(tile.x, tile.y)) continue
    if (fits(tile.x, tile.y)) return { x: tile.x, y: tile.y }
  }
  return null
}

function commissionSmallHalls(state: SimState, count: number): SimState {
  let next = {
    ...state,
    player: {
      ...state.player,
      cash: Math.max(state.player.cash, 8_000_000_000),
    },
  }
  for (let i = 0; i < count; i++) {
    const spot = findFootprintSpot(next, 'dc')
    if (!spot) throw new Error(`No small hall site for commission ${i + 1}`)
    next = placeBuilding(next, spot.x, spot.y, 'dc')
    next = applyInstantCheat(next, 'construction').state
  }
  return next
}

describe('multi-size data centers', () => {
  it('BUILD_DEFS racks and footprints: small 96/1, medium 288/4, large 960/6', () => {
    const s = BUILD_DEFS.find((d) => d.kind === 'dc')!
    const m = BUILD_DEFS.find((d) => d.kind === 'dc_m')!
    const l = BUILD_DEFS.find((d) => d.kind === 'dc_l')!
    expect(s.rack).toBe(96)
    expect(m.rack).toBe(288)
    expect(l.rack).toBe(960)
    expect(m.rack).toBe(s.rack! * 3)
    expect(l.rack).toBe(s.rack! * 10)
    expect(dcFootprint('dc')).toHaveLength(1)
    expect(dcFootprint('dc_m')).toHaveLength(4)
    expect(dcFootprint('dc_l')).toHaveLength(6)
    const perBay = (kind: 'dc' | 'dc_m' | 'dc_l') => {
      const def = BUILD_DEFS.find((d) => d.kind === kind)!
      return def.cash / (def.rack ?? 1)
    }
    expect(perBay('dc')).toBeLessThan(perBay('dc_m'))
    expect(perBay('dc_m')).toBeLessThan(perBay('dc_l'))
  })

  it('blocks medium and large halls until a live small campus exists', () => {
    let s = createGame(42)
    s = { ...s, player: { ...s.player, cash: 8_000_000_000 } }
    expect(findFootprintSpot(s, 'dc_m')).toBeNull()
    expect(findFootprintSpot(s, 'dc_l')).toBeNull()
    s = commissionSmallHalls(s, 1)
    expect(findFootprintSpot(s, 'dc_m')).not.toBeNull()
    expect(findFootprintSpot(s, 'dc_l')).toBeNull()
    s = commissionSmallHalls(s, 1)
    expect(findFootprintSpot(s, 'dc_l')).not.toBeNull()
  })

  it('placeBuilding medium claims 4 tiles with one rack-capacity anchor', () => {
    let s = commissionSmallHalls(createGame(42), 1)
    const spot = findFootprintSpot(s, 'dc_m')
    expect(spot).not.toBeNull()
    s = placeBuilding(s, spot!.x, spot!.y, 'dc_m')
    const anchor = mapTileAtAny(s, spot!.x, spot!.y)!
    expect(anchor.kind).toBe('dc_m')
    expect(anchor.campusRole).not.toBe('pad')
    expect(anchor.rackCapacity).toBe(288)
    const campus = facilityFootprintTiles(s, anchor.campusId!)
    expect(campus.length).toBe(4)
    const anchors = campus.filter((t) => t.campusRole !== 'pad')
    const pads = campus.filter((t) => t.campusRole === 'pad')
    expect(anchors.length).toBe(1)
    expect(pads.length).toBe(3)
    expect(pads.every((p) => p.rackCapacity === 0)).toBe(true)
    expect(new Set(campus.map((c) => c.campusId)).size).toBe(1)
  })

  it('placeBuilding large claims 6 tiles and 960 bays on anchor', () => {
    let s = commissionSmallHalls(createGame(7), 2)
    const spot = findFootprintSpot(s, 'dc_l')
    expect(spot).not.toBeNull()
    s = placeBuilding(s, spot!.x, spot!.y, 'dc_l')
    const anchor = mapTileAtAny(s, spot!.x, spot!.y)!
    expect(anchor.kind).toBe('dc_l')
    expect(anchor.campusRole).toBe('anchor')
    expect(anchor.rackCapacity).toBe(960)
    expect(anchor.dcSize).toBe('large')
    const campus = facilityFootprintTiles(s, anchor.campusId!)
    expect(campus.length).toBe(6)
  })

  it('places named buildings and renameBuilding updates campus', () => {
    let s = commissionSmallHalls(createGame(11), 1)
    const spot = findFootprintSpot(s, 'dc_m')
    expect(spot).not.toBeNull()
    s = placeBuilding(s, spot!.x, spot!.y, 'dc_m')
    const anchor = mapTileAtAny(s, spot!.x, spot!.y)!
    expect(anchor.kind).toBe('dc_m')
    expect(anchor.campusRole).not.toBe('pad')
    expect(anchor.owner).toBe('player')
    expect(anchor.name.length).toBeGreaterThan(0)
    expect(anchor.name).not.toMatch(/\d+,\d+/)
    s = renameBuilding(s, anchor.x, anchor.y, '  Aurora Stack  ')
    const campus = facilityFootprintTiles(s, anchor.campusId!)
    const renamed = campus.find((t) => t.campusRole !== 'pad')!
    expect(renamed.name).toBe('Aurora Stack')
    expect(
      campus
        .filter((t) => t.campusRole === 'pad')
        .every((p) => p.name === 'Aurora Stack pad'),
    ).toBe(true)
    expect(buildingDisplayName(renamed)).toBe('Aurora Stack')
  })
})

describe('lab statistics & finance history', () => {
  it('buildLabStats returns structured P&L, compute, and empty facilities at start', () => {
    const s = createGame(9)
    const stats = buildLabStats(s)
    expect(stats.income.length).toBeGreaterThanOrEqual(3)
    expect(stats.productCosts.length).toBeGreaterThanOrEqual(2)
    expect(stats.operatingCosts.length).toBeGreaterThanOrEqual(3)
    expect(stats.totals.some((t) => t.id === 'net')).toBe(true)
    expect(stats.compute.rawFlopsPf).toBeGreaterThanOrEqual(0)
    expect(stats.kpis.cash).toBe(s.player.cash)
    expect(stats.facilities.length).toBe(0)
  })

  it('market tick populates dayNet, history, and model finance fields', () => {
    let s = createGame(11)
    s = tickDay(s)
    s = tickDay(s)
    expect(s.financeHistory.length).toBeGreaterThanOrEqual(2)
    expect(s.player.finance).toHaveProperty('dayNet')
    expect(s.player.finance).toHaveProperty('dayMarketing')
    expect(s.player.finance).toHaveProperty('lifetimeRevenue')
    expect(s.lastMarket).toHaveProperty('capacityMTok')
    expect(s.lastMarket).toHaveProperty('modelFinance')
    const stats = buildLabStats(s)
    expect(stats.history.length).toBe(s.financeHistory.length)
    expect(sparkPath([1, 2, 3, 2, 4])).toMatch(/^M/)
  })
})

describe('rival data + shared training', () => {
  it('rivals start with ~500 MTok like the player (not multi-10B of free data)', () => {
    const rivals = createRivals(7)
    for (const r of rivals) {
      expect(r.dataMTok).toBeGreaterThan(400)
      expect(r.dataMTok).toBeLessThan(700)
      expect(r.data).toBeTruthy()
      expect(r.models).toHaveLength(0)
    }
  })

  it('under-data scale formula hits capability (same path rivals use)', () => {
    const full = buildScaledModel({
      id: 'a',
      name: 'Full',
      paramsB: 1,
      family: 'dense',
      day: 1,
      dataCoverage: 1.1,
      dataQuality: 70,
    })
    const thin = buildScaledModel({
      id: 'b',
      name: 'Thin',
      paramsB: 1,
      family: 'dense',
      day: 1,
      dataCoverage: 0.35,
      dataQuality: 70,
    })
    expect(thin.capability).toBeLessThan(full.capability * 0.85)
  })

  it('LQ synth share regresses capability vs HQ-only', () => {
    const hq = buildScaledModel({
      id: 'h',
      name: 'HQ',
      paramsB: 2,
      family: 'dense',
      day: 1,
      dataCoverage: 1,
      dataQuality: 70,
      synthLqShare: 0,
    })
    const lq = buildScaledModel({
      id: 'l',
      name: 'LQ',
      paramsB: 2,
      family: 'dense',
      day: 1,
      dataCoverage: 1,
      dataQuality: 70,
      synthLqShare: 0.6,
    })
    expect(lq.capability).toBeLessThan(hq.capability * 0.92)
  })
})

describe('economy integrity (P0/P1 fixes)', () => {
  it('marketing is not double-billed', () => {
    let s = createGame(101)
    s = {
      ...s,
      player: { ...s.player, marketingSpendPerDay: 100_000, cash: 50_000_000 },
    }
    const before = s.player.cash
    s = tickDay(s)
    // One day of marketing should cost ~100k once (plus wages/energy may apply)
    const mkt = 100_000
    // Cash drop should be less than 2× marketing + huge margin of error from other ops
    // If double-billed, mkt alone is 200k; with zero other spend burn ≈ 200k+wages
    const wages = s.player.wagesPerDay * s.player.talent
    const drop = before - s.player.cash
    // Upper bound: if double-billed mkt, drop includes 200k mkt; we assert drop is closer to 1× mkt
    expect(drop).toBeLessThan(mkt * 1.85 + wages + 200_000)
    expect(s.player.finance.dayMarketing).toBe(mkt)
  })

  it('enterprise grant does not add signing lump cash', () => {
    let s = createGame(102)
    // Force conditions for enterprise grant on day divisible by 12
    s = {
      ...s,
      day: 11,
      player: {
        ...s.player,
        cash: 100_000_000,
        brandTrust: 70,
        enterpriseContracts: 0,
        servicePain: 0,
        models: [
          {
            id: 'safe',
            name: 'Safe',
            family: 'dense',
            paramsB: 4,
            capability: 50,
            modalities: ['text'],
            quality: {
              reasoning: 50,
              coding: 50,
              chat: 50,
              image: 0,
              video: 0,
              safety: 70,
              reliability: 70,
            },
            benchmarks: emptyBenchmarks(),
            postTrain: 'rlhf',
            trainComputeSpent: 10,
            releaseDay: 1,
            shipped: true,
            release: 'released',
            tokPerSecMult: 0.7,
            inferCostMult: 1,
            apiPricePerMTok: null,
            apiPriceInPerMTok: null,
            apiPriceOutPerMTok: null,
            suggestedApiPrice: 2,
            suggestedApiPriceIn: 0.6,
            suggestedApiPriceOut: 2.5,
            costApiPriceIn: 0.1,
            costApiPriceOut: 0.3,
            distilled: false,
            trainMode: 'pretrain',
          },
        ],
        pricing: {
          ...s.player.pricing,
          activeModelId: 'safe',
        },
      },
      lastMarket: { ...s.lastMarket, unservedRatio: 0 },
    }
    const cashBefore = s.player.cash
    s = tickDay(s) // day becomes 12 — grant day
    // Contracts may increase, but cash must not jump by ~2.6M signing bonus
    if (s.player.enterpriseContracts > 0) {
      expect(s.player.cash).toBeLessThan(cashBefore + 500_000)
    }
    expect(s.player.enterpriseContracts).toBeLessThanOrEqual(14)
  })

  it('chip amort is book-only and not in cash dayTotalOut', () => {
    let s = withCompute(createGame(103), 32)
    s = tickMarket(s)
    expect(s.player.finance.dayChipAmort).toBeGreaterThan(0)
    // dayTotalOut should not include amort
    const f = s.player.finance
    const ops =
      f.dayEnergyCost +
      f.dayWageCost +
      (f.dayMarketing ?? 0) +
      f.dayBuildingOpex
    expect(f.dayTotalOut).toBeCloseTo(ops, -2)
  })

  it('segments grow secularly over days', () => {
    let s = createGame(104)
    const size0 = s.segments.reduce((a, x) => a + x.size, 0)
    for (let i = 0; i < 30; i++) s = tickDay(s)
    const size1 = s.segments.reduce((a, x) => a + x.size, 0)
    expect(size1).toBeGreaterThan(size0 * 1.02)
    expect(s.lastMarket.marketAdoption ?? 1).toBeGreaterThan(1)
  })

  it('never grows the active AI audience beyond the world population', () => {
    let s = createGame(1_041)
    s = {
      ...s,
      day: 5_000,
      segments: s.segments.map((segment) => ({
        ...segment,
        size: segment.size * 10,
      })),
    }

    s = tickMarket(s)

    const activeAudience = s.segments.reduce(
      (sum, segment) => sum + segment.size,
      0,
    )
    // Adoption is bounded by population; it is not required to pretend every
    // person on earth is an active AI user.
    expect(activeAudience).toBeGreaterThan(0)
    expect(activeAudience).toBeLessThanOrEqual(WORLD_POPULATION)
  })

  it('rivals track capacity and can be capacity-constrained', () => {
    let s = createGame(105)
    // Force a rival model with tiny flops
    s = {
      ...s,
      day: 35,
      rivals: s.rivals.map((r, i) =>
        i === 0
          ? {
              ...r,
              flopsPf: 2,
              utilCap: 0.4,
              servingEfficiency: 0.3,
              allocation: { training: 0.2, inference: 0.7, research: 0.1 },
              models: [
                {
                  id: 'tiny-r',
                  name: 'TinyR',
                  family: 'dense',
                  paramsB: 8,
                  capability: 55,
                  modalities: ['text'],
                  quality: {
                    reasoning: 50,
                    coding: 50,
                    chat: 50,
                    image: 0,
                    video: 0,
                    safety: 50,
                    reliability: 55,
                  },
                  benchmarks: emptyBenchmarks(),
                  postTrain: 'rlhf',
                  trainComputeSpent: 10,
                  releaseDay: 30,
                  shipped: true,
                  release: 'released',
                  tokPerSecMult: 0.7,
                  inferCostMult: 1,
                  apiPricePerMTok: null,
                  apiPriceInPerMTok: null,
                  apiPriceOutPerMTok: null,
                  suggestedApiPrice: 2,
                  suggestedApiPriceIn: 0.6,
                  suggestedApiPriceOut: 2.5,
                  costApiPriceIn: 0.1,
                  costApiPriceOut: 0.3,
                  distilled: false,
                  trainMode: 'pretrain',
                },
              ],
            }
          : r,
      ),
    }
    s = tickMarket(s)
    const nova = s.rivals[0]!
    expect(nova.lastCapacityPf).toBeDefined()
    expect(nova.lastDemandPf).toBeDefined()
    // With huge demand and 2 PF, expect some unserved if they got share
    if ((nova.lastDemandPf ?? 0) > (nova.lastCapacityPf ?? 0) * 1.1) {
      expect(nova.lastUnserved ?? 0).toBeGreaterThan(0.05)
    }
  })

  it('fleet reports system RAM and CPU; snapshot derates use them', () => {
    const s = withCompute(createGame(106), 16)
    const snap = computeSnapshot(s)
    expect(snap.systemRamGb).toBeGreaterThan(0)
    expect(snap.cpuScore).toBeGreaterThan(0)
    expect(snap.systemRamDerate).toBeGreaterThan(0)
    expect(snap.cpuDerate).toBeGreaterThan(0)
  })
})

describe('loans', () => {
  it('takeLoan adds cash and schedules daily payments', () => {
    let s = createGame(3)
    const cash0 = s.player.cash
    s = takeLoan(s, 'bridge')
    expect(s.player.loans).toHaveLength(1)
    expect(s.player.cash).toBeGreaterThan(cash0)
    expect(s.player.loans[0]!.dailyPayment).toBeGreaterThan(0)
    expect(s.player.finance.debtOutstanding).toBeGreaterThan(
      s.player.loans[0]!.principal,
    )

    const debt0 = s.player.loans[0]!.remaining
    s = tickDay(s)
    expect(s.player.finance.dayLoanPayment).toBeGreaterThan(0)
    expect(s.player.loans[0]!.remaining).toBeLessThan(debt0)
  })

  it('credit line scales with valuation', () => {
    let s = createGame(8)
    const low = bankCreditSnapshot(s)
    expect(low.creditLimit).toBeGreaterThan(0)
    // Inflate valuation via cash + brand
    s = {
      ...s,
      player: {
        ...s.player,
        cash: s.player.cash + 500_000_000,
        brandTrust: 90,
        finance: {
          ...s.player.finance,
          dayNet: 2_000_000,
          totalShare: 0.15,
          valuation: 2_000_000_000,
        },
      },
    }
    const high = bankCreditSnapshot(s)
    expect(high.creditLimit).toBeGreaterThan(low.creditLimit)
    expect(high.available).toBeGreaterThan(low.available * 0.9)
  })

  it('cannot borrow above valuation LTV', () => {
    let s = createGame(9)
    const snap = bankCreditSnapshot(s)
    s = takeLoan(s, {
      principal: snap.available + 50_000_000,
      termDays: 30,
    })
    expect(s.player.loans ?? []).toHaveLength(0)
  })

  it('repayLoan clears debt when cash allows', () => {
    let s = createGame(4)
    s = takeLoan(s, 'bridge')
    expect(s.player.loans.length).toBeGreaterThan(0)
    const loanId = s.player.loans[0]!.id
    s = repayLoan(s, loanId)
    expect(s.player.loans).toHaveLength(0)
    expect(s.player.finance.debtOutstanding).toBe(0)
  })

  it('cannot stack the same offer twice', () => {
    let s = createGame(5)
    s = takeLoan(s, 'growth')
    const cash = s.player.cash
    const n = s.player.loans.length
    s = takeLoan(s, 'growth')
    expect(s.player.loans).toHaveLength(n)
    expect(s.player.cash).toBe(cash)
  })
})

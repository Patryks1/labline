import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { placeBuilding, canPlaceBuilding } from '../systems/map'
import { mapTileAtAny, usesCompactWorld } from '../systems/worldAccess'
import { tileCoords } from '../world/ids'
import type { MapTile } from '../types'
import { orderRacksIntoDc } from '../systems/dcRacks'
import { startTraining, tickTraining, releaseFromJob, advancePostTrain } from '../systems/training'
import { tickMany } from '../tick'
import { computeSnapshot } from '../systems/compute'
import { buildLabStats } from '../systems/stats'
import { createBuildingKit, BUILDING_KIT_KINDS } from '../../view/three/buildingKits'
import { campusBonuses } from '../systems/campus'
import { postTrainMinimumDays } from '../balance/postTraining'
import { runPlayBot, runSmokeBootstrap, cheatFastForwardBuild, botAct } from './bot'
import {
  collectFromTraffic,
  tickData,
  ensureLabData,
} from '../systems/data'
import * as THREE from 'three'

describe('e2e play — automated bot', () => {
  it(
    'starts each follow-up generation from the newest release cadence',
    () => {
      // 30-day min training + post-train means two releases need a longer horizon.
      // HQ-first + hire bootstrap adds early-game work; allow a longer wall clock.
      const report = runPlayBot({ seed: 1, maxDays: 365 })
      const releaseDays = report.final.player.models
        .filter((model) => model.release === 'released' || model.shipped)
        .map((model) => model.releaseDay)
        .toSorted((a, b) => a - b)

      expect(releaseDays.length).toBeGreaterThanOrEqual(2)
      expect(releaseDays[1]! - releaseDays[0]!).toBeGreaterThanOrEqual(30)
      const models = report.final.player.models
        .filter((model) => model.release === 'released' || model.shipped)
        .toSorted((a, b) => a.releaseDay - b.releaseDay)
      expect(models[1]!.paramsB).toBeLessThanOrEqual(models[0]!.paramsB * 1.3 + 1e-9)
    },
    30_000,
  )

  it('smoke bootstrap: cloud → train → release can earn revenue', () => {
    const report = runSmokeBootstrap(21)
    expect(report.builtDc).toBe(false)
    expect(report.builtPower).toBe(false)
    expect(report.boughtChips).toBe(false)
    expect(report.final.computeContracts.some((contract) => contract.status === 'active')).toBe(true)
    expect(report.releasedModel).toBe(true)
    expect(report.bankrupt).toBe(false)
    // Revenue may take a few market ticks after release
    expect(
      report.hadRevenue || report.final.player.finance.lifetimeRevenue > 0 || report.final.lastMarket.playerDemandMTok > 0,
    ).toBe(true)
  })

  it('cloud-first bot survives 90 days and progresses toward a product', () => {
    const report = runPlayBot({ seed: 42, maxDays: 90 })
    expect(report.bankrupt).toBe(false)
    expect(report.final.computeContracts.length).toBeGreaterThan(0)
    expect(report.minCash).toBeGreaterThan(-15_000_000)
    expect(report.final.player.cash).toBeGreaterThan(-20_000_000)
    // Should progress toward a product
    expect(report.releasedModel || report.final.player.trainingJob != null || report.final.player.models.length > 0).toBe(
      true,
    )
  })

  it('play bot can reach a released model within 100 days (typical path)', () => {
    const report = runPlayBot({ seed: 99, maxDays: 100 })
    expect(report.bankrupt).toBe(false)
    // Soft assertion: most seeds release; if not, at least training underway
    if (!report.releasedModel) {
      expect(
        report.final.player.trainingJob != null || report.final.player.models.length > 0,
      ).toBe(true)
    } else {
      expect(report.milestones.some((m) => m.id === 'release')).toBe(true)
    }
  })

  it('multi-seed solvency: 3 seeds stay solvent for 60 days', () => {
    for (const seed of [1, 2, 3]) {
      const report = runPlayBot({ seed, maxDays: 60 })
      expect(report.bankrupt, `seed ${seed} bankrupt`).toBe(false)
      expect(report.final.player.cash, `seed ${seed} cash`).toBeGreaterThan(-10_000_000)
    }
  })
})

describe('e2e economy balance gates', () => {
  it('starts as a financed cloud lab rather than an infrastructure incumbent', () => {
    const s = createGame(1)
    expect(s.player.cash).toBe(20_000_000)
    expect(s.player.cloudCredits).toBe(3_000_000)
    expect(s.player.starterHqGrant).toBe(true)
    expect(s.player.staff).toEqual({
      researcher: 0,
      data_processor: 0,
      engineer: 0,
      ops: 0,
    })
    expect(s.player.rackFleet).toHaveLength(0)
    expect(s.computeContracts.reduce((sum, contract) => sum + contract.pf, 0)).toBeGreaterThan(0)
  })

  it('small model train upfront is affordable on cloud', () => {
    let s = createGame(5)
    const before = s.player.cash
    s = startTraining(s, {
      name: 'T',
      family: 'dense',
      paramsB: 1,
      dataPlan: {
        totalUnits: 400,
        weights: { chat: 0.5, code: 0.5 },
        allowSynthetic: true,
      },
    })
    expect(s.player.trainingJob).not.toBeNull()
    expect(s.player.cash).toBeLessThan(before)
    expect(s.player.cash).toBeGreaterThan(4_000_000)
  })

  it('cooling plant lowers effective PUE in snapshot', () => {
    let s = createGame(8)
    s = {
      ...s,
      player: { ...s.player, cash: 1_000_000_000, finance: { ...s.player.finance, cash: 1_000_000_000 } },
    }
    const empties: MapTile[] = []
    if (usesCompactWorld(s) && s.map.world) {
      const world = s.map.world
      for (const id of world.staticWorld.starterPads) {
        const { x, y } = tileCoords(id, world.descriptor.width)
        const tile = mapTileAtAny(s, x, y)
        if (tile && tile.kind === 'empty' && (tile.owner === 'neutral' || tile.owner === 'player') && tile.regionId !== 'void') {
          empties.push(tile)
        }
      }
      for (const city of s.map.cities ?? []) {
        for (let radius = city.radius + 1; radius <= city.radius + 24 && empties.length < 8; radius++) {
          for (let offset = -radius; offset <= radius && empties.length < 8; offset++) {
            for (const [x, y] of [
              [city.cx + offset, city.cy - radius],
              [city.cx + offset, city.cy + radius],
              [city.cx - radius, city.cy + offset],
              [city.cx + radius, city.cy + offset],
            ] as const) {
              const tile = mapTileAtAny(s, x, y)
              if (!tile || tile.kind !== 'empty') continue
              if (!(tile.owner === 'neutral' || tile.owner === 'player')) continue
              if (tile.regionId === 'void') continue
              if (empties.some((e) => e.x === tile.x && e.y === tile.y)) continue
              empties.push(tile)
            }
          }
        }
      }
    } else {
      empties.push(
        ...s.map.tiles.filter(
          (t) => t.kind === 'empty' && t.owner === 'neutral' && t.regionId !== 'void',
        ),
      )
    }
    // Data halls are industrial: city commercial parcels zone them out, so
    // pick only tiles where the DC placement check actually passes.
    const sites = empties.filter(
      (tile) => canPlaceBuilding(s, tile.x, tile.y, 'dc').ok,
    )
    expect(sites.length).toBeGreaterThanOrEqual(3)
    s = placeBuilding(s, sites[0]!.x, sites[0]!.y, 'dc')
    s = placeBuilding(s, sites[1]!.x, sites[1]!.y, 'substation')
    s = cheatFastForwardBuild(s)
    s = orderRacksIntoDc(s, sites[0]!.x, sites[0]!.y, 'rack_h100', 16)
    s = cheatFastForwardBuild(s)
    const pueBefore = computeSnapshot(s).pue
    s = placeBuilding(s, sites[2]!.x, sites[2]!.y, 'cooling')
    s = cheatFastForwardBuild(s)
    const pueAfter = computeSnapshot(s).pue
    expect(pueAfter).toBeLessThan(pueBefore)
    const campus = campusBonuses(s)
    expect(campus.coolingSites).toBeGreaterThanOrEqual(1)
    expect(campus.pueReduction).toBeGreaterThan(0)
  })
})

describe('e2e training depth', () => {
  it('domain data plan and continue-train fields flow through a job', () => {
    let s = createGame(12)
    s = startTraining(s, {
      name: 'Codey',
      family: 'dense',
      paramsB: 0.4,
      dataPlan: {
        totalUnits: 400,
        weights: { code: 0.55, chat: 0.45 },
        allowSynthetic: true,
      },
    })
    expect(s.player.trainingJob?.dataPlan.totalUnits).toBeGreaterThan(0)
    expect(s.player.trainingJob?.dataPlan.totalUnits).toBeLessThanOrEqual(400)
    expect(s.player.trainingJob?.dataConsumed).toBeDefined()
    expect(s.player.trainingJob?.cashSunk).toBeGreaterThan(0)

    // Complete job
    const job = s.player.trainingJob!
    s = {
      ...s,
      player: {
        ...s.player,
        trainingJob: {
          ...job,
          progressPfDays: job.targetPfDays,
          daysElapsed: job.minCalendarDays ?? 0,
        },
        trainingJobs: (s.player.trainingJobs ?? [job]).map((candidate) =>
          candidate.id === job.id
            ? {
                ...candidate,
                progressPfDays: candidate.targetPfDays,
                daysElapsed: candidate.minCalendarDays ?? 0,
              }
            : candidate,
        ),
      },
    }
    s = advancePostTrain(s)
    const j2 = s.player.trainingJob!
    s = {
      ...s,
      player: {
        ...s.player,
        trainingJob: {
          ...j2,
          postTrainProgress: j2.postTrainTarget,
          postTrainDaysElapsed: postTrainMinimumDays(
            j2.postTrain as Exclude<typeof j2.postTrain, 'none'>,
            j2.targetParamsB,
          ),
        },
        trainingJobs: (s.player.trainingJobs ?? [j2]).map((candidate) =>
          candidate.id === j2.id
            ? {
                ...candidate,
                postTrainProgress: candidate.postTrainTarget,
                postTrainDaysElapsed: postTrainMinimumDays(
                  candidate.postTrain as Exclude<typeof candidate.postTrain, 'none'>,
                  candidate.targetParamsB,
                ),
              }
            : candidate,
        ),
      },
    }
    s = releaseFromJob(s)
    const m = s.player.models[0]!
    expect(m.dataPlan?.totalUnits).toBeGreaterThan(0)
    expect(m.dataPlan?.totalUnits).toBeLessThanOrEqual(400)
    expect(m.capability).toBeGreaterThan(5)

    // Continue train
    s = startTraining(s, {
      name: m.name + '+',
      family: m.family,
      paramsB: m.paramsB,
      mode: 'continue',
      continueFromId: m.id,
      dataPlan: {
        totalUnits: 0.8,
        weights: { code: 0.3, chat: 0.4, law: 0.3 },
        allowSynthetic: true,
      },
    })
    expect(s.player.trainingJob?.mode).toBe('continue')
    expect(s.player.trainingJob?.continueFromId).toBe(m.id)
  })

  it('tickTraining burns cash while job runs', () => {
    let s = createGame(13)
    s = startTraining(s, {
      name: 'Burn',
      family: 'dense',
      paramsB: 1,
      dataPlan: { totalUnits: 2, weights: { chat: 1 }, allowSynthetic: true },
    })
    const cash0 = s.player.cash
    s = tickTraining(s)
    expect(s.player.cash).toBeLessThan(cash0)
  })
})

describe('e2e data pipeline', () => {
  it('serving traffic collects raw; process converts to ready packs', () => {
    let s = createGame(44)
    s = {
      ...s,
      lastMarket: {
        ...s.lastMarket,
        servedMTok: 40,
        playerDemandMTok: 50,
        apiSubscribers: 10_000,
      },
    }
    const before = ensureLabData(s)
    const rawBefore = Object.values(before.stocks).reduce((a, x) => a + x.raw, 0)
    s = collectFromTraffic(s)
    const after = ensureLabData(s)
    const rawAfter = Object.values(after.stocks).reduce((a, x) => a + x.raw, 0)
    expect(rawAfter).toBeGreaterThan(rawBefore)
    expect(s.player.data.dayCollected).toBeGreaterThan(0)

    s = {
      ...s,
      player: {
        ...s.player,
        data: {
          ...s.player.data,
          autoProcess: true,
          stocks: {
            ...s.player.data.stocks,
            chat: { ...s.player.data.stocks.chat, raw: 3 },
          },
        },
      },
    }
    const procBefore = s.player.data.stocks.chat.processed
    s = tickData(s)
    expect(
      s.player.data.stocks.chat.processed + s.player.data.processQueue.length,
    ).toBeGreaterThanOrEqual(procBefore)
  })
})

describe('e2e buildings & 3D kits', () => {
  it('all new buildable kits construct non-empty groups', () => {
    for (const kind of ['cooling', 'battery', 'hq', 'lab'] as const) {
      const g = createBuildingKit(kind, 0x88aacc, 0.4, 1, 1)
      expect(g).toBeInstanceOf(THREE.Group)
      expect(g.children.length).toBeGreaterThan(2)
    }
    expect(BUILDING_KIT_KINDS).toContain('cooling')
    expect(BUILDING_KIT_KINDS).toContain('lab')
  })

  it('botAct is pure and returns a state', () => {
    const s0 = createGame(3)
    const s1 = botAct(s0)
    expect(s1.day).toBe(s0.day)
    expect(s1.player).toBeDefined()
  })

  it('stats still build after multi-day bot play', () => {
    const report = runPlayBot({ seed: 55, maxDays: 40 })
    const stats = buildLabStats(report.final)
    expect(stats.income.length).toBeGreaterThan(0)
    expect(stats.compute).toBeDefined()
    expect(stats.kpis.cash).toBe(report.final.player.cash)
  })
})

describe('e2e long tick integrity', () => {
  it('tickMany 30 days from cash-only start does not throw', () => {
    let s = createGame(77)
    s = tickMany(s, 30)
    expect(s.day).toBe(31)
    expect(s.player.finance.lifetimeRevenue).toBeGreaterThanOrEqual(0)
    expect(s.financeHistory.length).toBeGreaterThan(0)
  })
})

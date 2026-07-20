import { beforeEach, describe, expect, it } from 'vitest'
import { createGame } from './createGame'
import { calendarForDay } from './campaign'
import { DEMAND_MODEL_VERSION, ECONOMY, WORLD_POPULATION } from './balance/economy'
import { TERRAIN_KIND, tileId } from './world'
import {
  SAVE_FORMAT,
  SAVE_VERSION,
  V1_INCOMPATIBILITY_REASON,
  V3_INCOMPATIBILITY_REASON,
  buildSaveFile,
  buildSaveMeta,
  clearAllSaves,
  deleteSaveSlot,
  extractV3RackBlueprints,
  inspectSaveCompatibility,
  listSaveSlots,
  MANUAL_SLOTS,
  mostRecentSlotId,
  parseSave,
  readSaveSlot,
  roundTripState,
  sanitizeState,
  serializeSave,
  writeSaveSlot,
} from './save'

describe('save / load v4', () => {
  beforeEach(async () => {
    await clearAllSaves()
  })

  it('round-trips a legacy-rendered small map inside a v4 save', () => {
    const state = createGame({
      seed: 42,
      labName: 'TestLab',
      difficulty: 'normal',
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 2 },
    })
    state.day = 17
    state.player.cash = 123_456_789
    state.map.energyPricePerMWh = 100

    const back = roundTripState(state)
    expect(back.seed).toBe(42)
    expect(back.day).toBe(17)
    expect(back.player.cash).toBe(123_456_789)
    expect(back.map.storage).toBe('legacy')
    expect(back.map.tiles.length).toBe(state.map.tiles.length)
    expect(back.map.energyPricePerMWh).toBe(ECONOMY.energyBasePrice * 0.7)
    expect(back.config.difficulty).toBe('normal')
  })

  it('migrates implicit legacy auto-pause rules to opt-in settings', () => {
    const state = createGame({ seed: 420, difficulty: 'normal' })
    const file = buildSaveFile(state, 'auto')
    file.state.config.campaignRules.autoPauseConfigured = undefined
    file.state.config.campaignRules.autoPause = {
      projectComplete: true,
      majorEvent: true,
      quarterlyReport: true,
      runwayEmergency: true,
    }
    const loaded = parseSave(serializeSave(file)).state
    expect(loaded.config.campaignRules.autoPauseConfigured).toBe(true)
    expect(loaded.config.campaignRules.autoPause).toEqual({
      projectComplete: false,
      majorEvent: false,
      quarterlyReport: false,
      runwayEmergency: false,
    })
  })

  it('rebuilds compact static data and derived indexes from sparse world state', () => {
    const state = createGame({
      seed: 73,
      labName: 'Compact Lab',
      difficulty: 'normal',
      advanced: { mapWidth: 128, mapHeight: 128, cityCount: 3, rivalCount: 2 },
    })
    const world = state.map.world
    expect(state.map.storage).toBe('compact')
    expect(world).toBeDefined()
    const x = 1
    const y = 1
    const id = tileId(x, y, world!.descriptor.width, world!.descriptor.height)
    const city = world!.cityRuntime.get(0)!
    world!
      .beginBatch()
      .setTerrain({ tileId: id, kind: TERRAIN_KIND.park, ownerId: 'player' })
      .updateCity(0, {
        population: city.population + 12_345,
        growthEvents: city.growthEvents + 1,
        lastGrowthDay: 14,
      })
      .commit()
    const originalHash = world!.staticWorld.staticHash
    const originalFacilityCount = world!.metrics.facilities.count
    state.map.cities![0]!.talentAvailable!.researcher = 7

    const back = roundTripState(state)
    expect(back.map.storage).toBe('compact')
    expect(back.map.tiles).toEqual([])
    expect(back.map.world).toBeDefined()
    expect(back.map.world).not.toBe(world)
    expect(back.map.world?.staticWorld.staticHash).toBe(originalHash)
    expect(back.map.world?.getKind(id)).toBe(TERRAIN_KIND.park)
    expect(back.map.world?.getOwner(id)).toBe('player')
    expect(back.map.world?.cityRuntime.get(0)).toMatchObject({
      population: city.population + 12_345,
      growthEvents: city.growthEvents + 1,
      lastGrowthDay: 14,
    })
    expect(back.map.world?.metrics.facilities.count).toBe(originalFacilityCount)
    expect(back.map.cities?.[0]?.talentAvailable?.researcher).toBe(7)
  })

  it('never serializes million-tile static buffers or runtime indexes', () => {
    const state = createGame({
      seed: 1_001,
      labName: 'Million',
      difficulty: 'normal',
      advanced: { mapWidth: 1_000, mapHeight: 1_000, rivalCount: 5 },
    })
    const file = buildSaveFile(state, 'auto')
    const json = serializeSave(file)
    expect(file.state.map.storage).toBe('compact')
    expect(file.state.map).not.toHaveProperty('tiles')
    expect(file.state.map).not.toHaveProperty('world')
    expect(json).not.toContain('staticWorld')
    expect(json).not.toContain('facilitiesById')
    expect(json).not.toContain('terrainOverrides":{}')
    expect(new TextEncoder().encode(json).byteLength).toBeLessThan(1_000_000)
  })

  it('preserves Infinity runwayDays through sanitize and restore', () => {
    const state = createGame({
      seed: 1,
      labName: 'Inf',
      difficulty: 'easy',
      advanced: { mapWidth: 20, mapHeight: 20, cityCount: 2, rivalCount: 1 },
    })
    state.player.finance.runwayDays = Infinity
    const clean = sanitizeState(state)
    expect(clean.player.finance.runwayDays).toBeNull()
    expect(roundTripState(state).player.finance.runwayDays).toBe(Infinity)
  })

  it('normalizes legacy audience demand exactly once on restore', () => {
    const state = createGame({ seed: 8, difficulty: 'easy' })
    state.lastMarket.demandModelVersion = undefined
    state.lastMarket.demandMTok = 1_000
    state.lastMarket.industryDemandMTok = 1_000
    state.lastMarket.playerDemandMTok = 100
    state.lastMarket.apiDemandMTok = 100
    state.lastMarket.servedMTok = 50
    state.lastMarket.capacityMTok = 100
    state.lastMarket.demandPf = 100
    state.lastMarket.capacityPf = 100

    const restored = roundTripState(state)
    expect(restored.lastMarket.demandModelVersion).toBe(DEMAND_MODEL_VERSION)
    expect(restored.lastMarket.playerDemandMTok).toBe(
      100 * ECONOMY.marketDailyActiveUsageShare,
    )
    expect(restored.lastMarket.demandMTok).toBe(
      1_000 * ECONOMY.marketDailyActiveUsageShare,
    )
    expect(roundTripState(restored).lastMarket.playerDemandMTok).toBe(
      restored.lastMarket.playerDemandMTok,
    )
  })

  it('migrates untouched legacy plan allowances to the 20M monthly baseline', () => {
    const state = createGame({ seed: 82, difficulty: 'easy' })
    state.player.pricing.plans = state.player.pricing.plans.map((plan) => ({
      ...plan,
      includedMTokPerMonth:
        plan.id === 'plan-plus' ? 0.65 : 0.6 * plan.usageMultiplier,
    }))

    const restored = roundTripState(state)
    const free = restored.player.pricing.plans.find((plan) => plan.id === 'plan-free')!
    const plus = restored.player.pricing.plans.find((plan) => plan.id === 'plan-plus')!
    const pro = restored.player.pricing.plans.find((plan) => plan.id === 'plan-pro')!

    expect(free.includedMTokPerMonth).toBeCloseTo(2)
    expect(plus.includedMTokPerMonth).toBeCloseTo(20)
    expect(pro.includedMTokPerMonth).toBeCloseTo(100)
  })

  it('preserves deliberately customized subscription allowances on restore', () => {
    const state = createGame({ seed: 82, difficulty: 'easy' })
    const plus = state.player.pricing.plans.find((plan) => plan.id === 'plan-plus')!
    plus.includedMTokPerMonth = 12

    const restored = roundTripState(state)
    expect(
      restored.player.pricing.plans.find((plan) => plan.id === 'plan-plus')!
        .includedMTokPerMonth,
    ).toBe(12)
  })

  it('round-trips per-model plan serving precision while legacy precision remains optional', () => {
    const state = createGame({ seed: 425, difficulty: 'normal' })
    const plan = state.player.pricing.plans[1]!
    plan.servePrecisionByModel = { 'released-model': 'int8' }
    const restored = roundTripState(state)
    expect(
      restored.player.pricing.plans.find((candidate) => candidate.id === plan.id)
        ?.servePrecisionByModel,
    ).toEqual({ 'released-model': 'int8' })
  })

  it('caps oversized legacy audiences at the world population on restore', () => {
    const state = createGame({ seed: 81, difficulty: 'easy' })
    state.segments = state.segments.map((segment) => ({
      ...segment,
      size: segment.size * 10,
    }))

    const restored = roundTripState(state)
    const restoredAudience = restored.segments.reduce(
      (sum, segment) => sum + segment.size,
      0,
    )

    expect(restoredAudience).toBeCloseTo(WORLD_POPULATION, -1)
  })

  it('rejects v1 explicitly without attempting migration', () => {
    const legacy = JSON.stringify({
      format: SAVE_FORMAT,
      version: 1,
      meta: {},
      state: {},
    })
    expect(() => parseSave(legacy)).toThrow(V1_INCOMPATIBILITY_REASON)
  })

  it('rejects v3 economies explicitly without attempting migration', () => {
    expect(() =>
      parseSave(JSON.stringify({ format: SAVE_FORMAT, version: 3, meta: {}, state: {} })),
    ).toThrow(V3_INCOMPATIBILITY_REASON)
  })

  it('rejects bad and newer formats', () => {
    expect(() => parseSave(JSON.stringify({ format: 'nope', version: 2 }))).toThrow(
      /Labline save/i,
    )
    expect(() =>
      parseSave(JSON.stringify({ format: SAVE_FORMAT, version: SAVE_VERSION + 1 })),
    ).toThrow(/newer than this build/i)
  })

  it('writes, lists, reads, and deletes an async slot', async () => {
    const state = createGame({
      seed: 9,
      labName: 'Slotty',
      difficulty: 'hard',
      advanced: { mapWidth: 20, mapHeight: 20, cityCount: 2, rivalCount: 1 },
    })
    state.day = 5
    const meta = await writeSaveSlot('1', state)
    expect(meta).toMatchObject({ labName: 'Slotty', day: 5, slotId: '1', version: SAVE_VERSION })
    expect((await listSaveSlots()).some((candidate) => candidate.slotId === '1')).toBe(true)

    const loaded = await readSaveSlot('1')
    expect(loaded.day).toBe(5)
    expect(loaded.seed).toBe(9)

    await deleteSaveSlot('1')
    expect((await listSaveSlots()).some((candidate) => candidate.slotId === '1')).toBe(false)
  })

  it('offers eight manual sandbox slots', () => {
    expect(MANUAL_SLOTS).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
  })

  it('reports actionable validation problems before a damaged save is loaded', () => {
    const state = createGame({ seed: 29, labName: 'Recovery Lab', difficulty: 'easy' })
    const file = buildSaveFile(state, '4')
    file.state.day = Number.NaN
    expect(inspectSaveCompatibility(file)).toEqual({
      compatible: false,
      reason: 'Simulation state is incomplete (day, company, or world data is missing).',
    })
  })

  it('persists the sandbox date and selected company mark in save metadata', () => {
    const state = createGame({
      seed: 30,
      labName: 'Prism Works',
      companyMark: 'prism',
      difficulty: 'normal',
    })
    state.day = 400
    state.calendar = calendarForDay(state.day, state.config.campaignRules)
    expect(buildSaveMeta(state, '5', '2026-07-18T12:00:00.000Z')).toMatchObject({
      companyMark: 'prism',
      campaignDate: '2027-02-04',
      savedAt: '2026-07-18T12:00:00.000Z',
    })
  })

  it('continues from the newest compatible save instead of always preferring autosave', async () => {
    const state = createGame({ seed: 91, difficulty: 'normal' })
    await writeSaveSlot('auto', state)
    await new Promise((resolve) => setTimeout(resolve, 2))
    state.day += 1
    await writeSaveSlot('1', state)

    expect(await mostRecentSlotId()).toBe('1')
  })

  it('serializeSave pins the v4 format and content pack', () => {
    const state = createGame({ seed: 2, difficulty: 'easy' })
    const parsed = JSON.parse(serializeSave(buildSaveFile(state, 'auto')))
    expect(parsed.format).toBe(SAVE_FORMAT)
    expect(parsed.version).toBe(SAVE_VERSION)
    expect(parsed.contentPackId).toBe(state.config.campaignRules.contentPackId)
    expect(parsed.state.industryDataPack.id).toBe(parsed.contentPackId)
  })

  it('restores the embedded calibration snapshot instead of consulting live balance data', () => {
    const state = createGame({ seed: 22, difficulty: 'easy' })
    state.industryDataPack = {
      ...state.industryDataPack,
      demand: {
        ...state.industryDataPack.demand,
        reportYearMinMultiplier: 5.25,
      },
    }
    const restored = roundTripState(state)
    expect(restored.industryDataPack.demand.reportYearMinMultiplier).toBe(5.25)
  })

  it('does not import malformed v3 rack blueprints', () => {
    const json = JSON.stringify({
      format: SAVE_FORMAT,
      version: 3,
      state: {
        player: {
          rackDesigns: [
            { id: 'bad', name: 'Bad rack', chassisId: 'missing', placements: [] },
            { id: 2, name: 'Wrong shape' },
          ],
        },
      },
    })
    expect(extractV3RackBlueprints(json)).toEqual([])
  })

  it('imports a valid v3 rack blueprint without migrating its live economy', () => {
    const blueprint = {
      id: 'v3-balanced-node',
      name: 'V3 balanced node',
      chassisId: 'case_8u',
      placements: [
        { instanceId: 'nic', moduleId: 'nic_400', slotId: 'm4' },
        { instanceId: 'gpu', moduleId: 'gpu_h100', slotId: 'g1' },
        { instanceId: 'psu', moduleId: 'psu_3k', slotId: 'm3' },
        { instanceId: 'cpu', moduleId: 'cpu_std', slotId: 'm1' },
        { instanceId: 'cool', moduleId: 'cool_liquid', slotId: 'm2' },
      ],
    }
    const json = JSON.stringify({
      format: SAVE_FORMAT,
      version: 3,
      state: {
        day: 90,
        player: { cash: 999_000_000, rackDesigns: [blueprint] },
      },
    })

    expect(extractV3RackBlueprints(json)).toEqual([blueprint])
    expect(() => parseSave(json)).toThrowError(V3_INCOMPATIBILITY_REASON)
  })
})

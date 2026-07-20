import { DEMAND_MODEL_VERSION, ECONOMY, SEGMENTS } from './balance/economy'
import { createEmptyLabData, emptyDataMarket, generateDataMarketOffers } from './balance/data'
import { calendarForDay, createInitialProgression, defaultCampaignRules } from './campaign'
import {
  buildGameConfig,
  defaultGameConfig,
  type AdvancedOverrides,
  type CompanyMarkId,
  type DifficultyId,
  type GameConfig,
} from './balance/gameConfig'
import { createRivals } from './systems/rivals'
import { createWorldMarkets, refreshPublicEstimates, syncLabIndex } from './systems/labEngine'
import { createInitialMap } from './systems/map'
import { defaultPlans } from './systems/plans'
import {
  createRegionInterconnections,
  normalizeSiteEnergyState,
} from './systems/siteEnergy'
import type {
  MapCity,
  MapRegion,
  RivalLab,
  RunConfig,
  SimState,
  SiteCapacity,
} from './types'
import { cityTalentCapacity, cityTalentInitial } from './balance/staff'
import {
  getIndustryDataPack,
  GROUNDED_2026_COMPUTE_V2_PACK,
} from './balance/industryDataPack'
import {
  TERRAIN_KIND,
  createDynamicWorld,
  generateStaticWorldV2,
  tileId,
  type DynamicWorld,
  type Facility,
  type StaticWorld,
  type TileId,
} from './world'

export type { GameConfig, DifficultyId, AdvancedOverrides }
export { buildGameConfig, defaultGameConfig }

export interface CreateGameOpts {
  seed?: number
  labName?: string
  companyMark?: CompanyMarkId
  difficulty?: DifficultyId
  advanced?: AdvancedOverrides
  /** Full config wins over difficulty/advanced when provided */
  config?: GameConfig
}

/** Legacy tiles stay available for established small-map consumers/tests. */
export const COMPACT_WORLD_MIN_TILES = 128 * 128

function compactCities(world: StaticWorld): MapCity[] {
  return world.cities.map((city) => {
    const talentCapacity = cityTalentCapacity(city.population, city.industry)
    return {
      id: city.id,
      name: city.name,
      cx: city.cx,
      cy: city.cy,
      radius: city.radius,
      population: city.population,
      powerRadius: city.powerRadius,
      powerBuyMw: city.powerBuyMw,
      powerBuyPriceMult: city.powerBuyPriceMult,
      industry: city.industry,
      talentCapacity,
      talentAvailable: cityTalentInitial(talentCapacity, 0.36),
      talentWageMult: city.talentWageMult,
    }
  })
}

function compactRegions(world: StaticWorld): MapRegion[] {
  return world.regions.map((region) => ({
    id: region.id,
    name: region.name,
    originX: region.originX,
    originY: region.originY,
    width: region.width,
    height: region.height,
    energyPriceMult: region.energyPriceMult,
    latencyToMarket: region.latencyToMarket,
    regulationRisk: region.regulationRisk,
  }))
}

function findRivalStart(world: DynamicWorld, rivalIndex: number): TileId | undefined {
  const city = world.staticWorld.cities[(rivalIndex + 1) % world.staticWorld.cities.length]
  if (!city) return world.staticWorld.starterPads[rivalIndex]
  for (let radius = city.radius + 2; radius <= city.radius + 24; radius++) {
    const perimeter = radius * 8
    for (let step = 0; step < perimeter; step++) {
      const side = Math.floor((step * 4) / perimeter)
      const offset = (step + rivalIndex * 7) % (radius * 2 + 1) - radius
      const x = side === 0 ? city.cx + offset : side === 1 ? city.cx + radius : side === 2 ? city.cx - offset : city.cx - radius
      const y = side === 0 ? city.cy - radius : side === 1 ? city.cy + offset : side === 2 ? city.cy + radius : city.cy - offset
      if (x < 0 || y < 0 || x >= world.descriptor.width || y >= world.descriptor.height) continue
      const id = tileId(x, y, world.descriptor.width, world.descriptor.height)
      if (world.getFacilityAt(id) || world.getOwner(id) !== 'neutral') continue
      const kind = world.getKind(id)
      if (kind === TERRAIN_KIND.empty || kind === TERRAIN_KIND.forest) return id
    }
  }
  return world.staticWorld.starterPads[rivalIndex]
}

function seedCompactRivalFacilities(world: DynamicWorld, rivals: RivalLab[]): void {
  const batch = world.beginBatch()
  let added = 0
  for (let index = 0; index < rivals.length; index++) {
    const rival = rivals[index]!
    const anchor = findRivalStart(world, index)
    if (anchor === undefined || world.getFacilityAt(anchor)) continue
    const facility: Facility = {
      id: `rival-start-${rival.id}`,
      kind: 'dc',
      ownerId: rival.id,
      anchor,
      footprint: [anchor],
      level: 1,
      constructionProgress: 1,
      constructionTarget: 1,
      powered: true,
      stats: {
        rackCapacity: 160,
        racksUsed: 90,
        opexPerDay: 95_000,
      },
      data: {
        name: `${rival.name} Hall`,
        note: 'Rival campus — shares the scarce regional grid.',
        dcSize: 'small',
      },
    }
    batch.addFacility(facility)
    added++
  }
  if (added > 0) batch.commit()
  else batch.rollback()
}

function toRunConfig(cfg: GameConfig): RunConfig {
  return {
    labName: cfg.labName,
    companyMark: cfg.companyMark,
    difficulty: cfg.difficulty,
    mapWidth: cfg.mapWidth,
    mapHeight: cfg.mapHeight,
    cityCount: cfg.cityCount,
    rivalCount: cfg.rivalCount,
    economyMult: cfg.economyMult,
    researchCostMult: cfg.researchCostMult,
    startingCashMult: cfg.startingCashMult,
    landValueBase: cfg.landValueBase,
    landValueCityPeak: cfg.landValueCityPeak,
    campaignRules: cfg.campaignRules ?? defaultCampaignRules(),
  }
}

export function createGame(seedOrOpts: number | CreateGameOpts = 42): SimState {
  const opts: CreateGameOpts =
    typeof seedOrOpts === 'number' ? { seed: seedOrOpts } : seedOrOpts

  const cfg =
    opts.config ??
    buildGameConfig({
      labName: opts.labName,
      companyMark: opts.companyMark,
      difficulty: opts.difficulty,
      seed: opts.seed ?? 42,
      advanced: opts.advanced,
    })

  const seed = cfg.seed
  const startingCash = Math.floor(ECONOMY.startingCash * cfg.startingCashMult)
  const compact = cfg.mapWidth * cfg.mapHeight >= COMPACT_WORLD_MIN_TILES
  const staticWorld = compact
    ? generateStaticWorldV2({
        seed,
        width: cfg.mapWidth,
        height: cfg.mapHeight,
        cityCount: cfg.cityCount,
        landValueBase: cfg.landValueBase,
        landValueCityPeak: cfg.landValueCityPeak,
        energyPricePerMWh: ECONOMY.energyBasePrice,
      })
    : undefined
  const legacyMap = compact ? undefined : createInitialMap(cfg)
  const regions = staticWorld ? compactRegions(staticWorld) : legacyMap!.regions
  const cities = staticWorld ? compactCities(staticWorld) : (legacyMap!.cities ?? [])
  const rivals = createRivals(
    seed,
    cfg.rivalCount,
    regions.map((region) => region.id),
    300_000_000,
    cfg.difficulty,
  )
  const compactWorld = staticWorld ? createDynamicWorld(staticWorld) : undefined
  if (compactWorld) seedCompactRivalFacilities(compactWorld, rivals)
  const map = staticWorld
    ? {
        width: staticWorld.descriptor.width,
        height: staticWorld.descriptor.height,
        tiles: [],
        regions,
        energyPricePerMWh: staticWorld.descriptor.energyPricePerMWh,
        activeRegionId: regions[0]?.id ?? 'city_0',
        cities,
        storage: 'compact' as const,
        world: compactWorld,
        worldRevision: compactWorld?.revision ?? 0,
      }
    : {
        ...legacyMap!,
        storage: 'legacy' as const,
      }

  const sharesByLab: Record<string, number> = { player: 0, outside: 0.15 }
  const baseShare = 0.85 / Math.max(1, rivals.length)
  for (const r of rivals) sharesByLab[r.id] = baseShare

  const campaignRules = cfg.campaignRules ?? defaultCampaignRules()
  const industryDataPack =
    getIndustryDataPack(campaignRules.contentPackId) ?? GROUNDED_2026_COMPUTE_V2_PACK
  const calendar = calendarForDay(1, campaignRules)
  const initialSiteCapacities: SiteCapacity[] = rivals.map((rival) => {
    const firmMw = Math.max(0.25, rival.flopsPf * 0.011 * (rival.pue ?? 1.42) * 1.12)
    return {
      id: `starting-site-${rival.id}`,
      projectId: `starting-site-${rival.id}`,
      labId: rival.id,
      route: 'owned',
      regionId: rival.regionId,
      siteMw: firmMw,
      firmMw,
      commissionedDay: 1,
      status: 'active',
    }
  })
  const state: SimState = {
    seed,
    day: 1,
    tick: 0,
    speed: 1,
    paused: true,
    config: toRunConfig(cfg),
    industryDataPack,
    calendar,
    progression: { ...createInitialProgression(), era: calendar.era },
    automation: {
      overflowCloud: {
        enabled: false,
        targetUtilization: 0.78,
        maxPf: 96,
        maxDailySpend: 180_000,
      },
      allocation: { enabled: false, inferenceHeadroom: 0.2 },
      dataProcessing: { enabled: false },
      fleetDeployment: { enabled: false, weeklyBudget: 2_500_000 },
      productCapacity: { enabled: false },
    },
    playerLabId: 'player',
    labs: {},
    player: {
      name: cfg.labName,
      cash: startingCash,
      chips: [],
      rackFleet: [],
      rackDesigns: [],
      deployedRacks: [],
      moduleStock: [],
      allocation: { training: 0.4, inference: 0.35, research: 0.25 },
      utilCap: ECONOMY.startingUtilCap,
      servingEfficiency: ECONOMY.startingServingEfficiency,
      // dense_basics starter unlock includes +0.05 trainEfficiency
      trainEfficiency: ECONOMY.startingTrainEfficiency + 0.05,
      pue: ECONOMY.startingPue,
      talent: ECONOMY.startingTalent,
      staff: { researcher: 3, data_processor: 1, engineer: 3, ops: 1 },
      researchLeads: [
        {
          id: 'lead-mira-chen',
          name: 'Dr. Mira Chen',
          skills: { algorithms: 0.82, systems: 0.66, dataEvals: 0.72, leadership: 0.78 },
          specialties: { reasoning: 0.88, math: 0.8, science: 0.72 },
          traits: ['scaling intuition', 'patient mentor'],
          reputation: 62,
          morale: 78,
          salaryPerDay: 3_400,
        },
        {
          id: 'lead-jonah-reyes',
          name: 'Jonah Reyes',
          skills: { algorithms: 0.68, systems: 0.9, dataEvals: 0.7, leadership: 0.74 },
          specialties: { code: 0.86, tools: 0.84, reasoning: 0.65 },
          traits: ['systems optimizer', 'fast integrator'],
          reputation: 59,
          morale: 80,
          salaryPerDay: 3_100,
        },
      ],
      researchPods: [
        {
          id: 'pod-foundations',
          name: 'Foundations Pod',
          leadId: 'lead-mira-chen',
          focus: 'scaling',
          researchers: 3,
          engineers: 1,
          dataStaff: 1,
          assignmentId: null,
        },
        {
          id: 'pod-systems',
          name: 'Systems Pod',
          leadId: 'lead-jonah-reyes',
          focus: 'systems',
          researchers: 0,
          engineers: 2,
          dataStaff: 0,
          assignmentId: null,
        },
      ],
      researchPrograms: [],
      trainingPrograms: [],
      cloudCredits: 3_000_000,
      dataQuality: ECONOMY.startingDataQuality,
      data: createEmptyLabData(),
      brandTrust: ECONOMY.startingBrand,
      servicePain: 0,
      // Dense transformers unlocked at start (same for player + rivals)
      researchUnlocked: ['dense_basics'],
      activeResearch: null,
      researchQueue: [],
      models: [],
      trainingJobs: [],
      trainingJob: null,
      safetyCampaign: null,
      pricing: {
        apiPricePerMTok: 2.4,
        apiPriceInPerMTok: 0.8,
        apiPriceOutPerMTok: 3.2,
        apiMarkupPct: 120,
        apiVsSubPriority: ECONOMY.defaultApiVsSubPriority,
        activeModelId: null,
        enterpriseContractBonus: 0,
        plans: defaultPlans(),
        subPlusPrice: 20,
        subProPrice: 60,
        plusIncludedMTok: 0,
        proIncludedMTok: 0,
      },
      finance: {
        cash: startingCash,
        dayRevenue: 0,
        dayCogs: 0,
        dayEnergyCost: 0,
        dayWageCost: 0,
        dayChipAmort: 0,
        dayBuildingOpex: 0,
        dayMarketing: 0,
        dayLoanPayment: 0,
        dayEnergyOther: 0,
        dayChipAmortOther: 0,
        apiRevenue: 0,
        subRevenue: 0,
        enterpriseRevenue: 0,
        apiCogs: 0,
        subCogs: 0,
        dayGrossProfit: 0,
        dayNet: 0,
        dayTotalOut: 0,
        marginPerSub: 0,
        marginPerMTok: 0,
        totalShare: 0,
        valuation: 80_000_000,
        lifetimeRevenue: 0,
        lifetimeNet: 0,
        lifetimeProductCogs: 0,
        peakCash: startingCash,
        lowestCash: startingCash,
        runwayDays: Infinity,
        debtOutstanding: 0,
      },
      wagesPerDay: ECONOMY.wagePerTalentPerDay,
      fab: {
        phase: 'idle',
        daysInPhase: 0,
        daysRequired: 0,
        cashSunk: 0,
        yieldRate: 0.35,
        designPerfPerWatt: 2.2,
        chipsProduced: 0,
        failed: false,
        designFocus: 'balanced',
        designTechIds: [],
      },
      marketingSpendPerDay: 0,
      marketingRevenueMultiple: 0,
      enterpriseContracts: 0,
      loans: [],
      capital: {
        capTable: [
          { holderId: 'founders', holderName: 'Founders', ownership: 0.675, votingPower: 0.78, kind: 'founder' },
          { holderId: 'seed-fund', holderName: 'Northstar Seed', ownership: 0.25, votingPower: 0.2, kind: 'investor' },
          { holderId: 'option-pool', holderName: 'Team option pool', ownership: 0.075, votingPower: 0.02, kind: 'option_pool' },
        ],
        fundingRounds: [
          { id: 'round-seed', label: 'Seed', day: 1, preMoneyValuation: 60_000_000, cashRaised: startingCash, postMoneyValuation: 80_000_000, dilution: 0.25, investorName: 'Northstar Seed' },
        ],
        debt: [],
        investorConfidence: 0.68,
        boardPressure: 0.18,
        founderControl: 0.78,
        restructuring: { active: false, daysLeft: 0, stage: 'none' },
      },
    },
    rivals,
    worldMarkets: createWorldMarkets(),
    computeLeases: [],
    computeContracts: [
      {
        id: 'cloud-launch-contract',
        providerId: 'cloud-northstar',
        providerName: 'Northstar Compute',
        buyerLabId: 'player',
        kind: 'on_demand',
        regionId: 'global-cloud',
        pf: 24,
        pricePerPfDay: 480,
        daysLeft: 180,
        daysTotal: 180,
        interruptionRisk: 0.002,
        terminationFee: 0,
        status: 'active',
        signedDay: 1,
        acceleratorGeneration: 2,
        supportedTrainingFormats: ['fp32', 'fp16_mixed', 'bf16_mixed', 'fp8_hybrid'],
        supportedServePrecisions: ['fp16', 'bf16', 'fp8', 'int8', 'int4', 'ternary_1_58'],
      },
    ],
    computeListing: null,
    cityPowerContracts: [],
    powerExportContracts: [],
    siteProjects: [],
    siteCapacities: initialSiteCapacities,
    energyContracts: [],
    regionInterconnections: createRegionInterconnections(regions),
    dataMarket: {
      ...emptyDataMarket(),
      offers: generateDataMarketOffers(
        seed,
        1,
        rivals.map((r) => r.name),
        11,
      ),
      lastRefreshDay: 1,
      nextRefreshDay: 6,
    },
    segments: SEGMENTS.map((s) => ({
      id: s.id,
      size: s.baseSize,
      usageIntensity: s.baseUsage,
    })),
    map: {
      width: map.width,
      height: map.height,
      tiles: map.tiles,
      storage: map.storage,
      world: map.world,
      worldRevision: map.worldRevision,
      regions: map.regions,
      energyPricePerMWh: map.energyPricePerMWh,
      activeRegionId: map.activeRegionId,
      cities: map.cities,
    },
    alerts: [
      {
        id: 'welcome',
        day: 1,
        severity: 'info' as const,
        message: `${cfg.labName} opens in January 2026 with $3M in cloud credits, 24 PF online, two technical leads, and 8 supporting staff. Ship before the runway closes.`,
      },
    ],
    news: [
      `Market open across ${map.cities?.length ?? 0} metros. ${rivals.length} rivals already have footholds.`,
    ],
    onboardingStep: 0,
    onboardingDismissed: false,
    activeEvents: [],
    eventCooldowns: {},
    victory: {
      outcome: 'playing',
      reason: '',
      goalShare: ECONOMY.victory.share,
      goalValuation: ECONOMY.victory.valuation,
      goalCapability: ECONOMY.victory.capability,
      bankruptDay: 0,
    },
    lastMarket: {
      demandModelVersion: DEMAND_MODEL_VERSION,
      sharesByLab,
      demandMTok: 0,
      playerDemandMTok: 0,
      servedMTok: 0,
      unservedRatio: 0,
      latencyScore: 55,
      effectiveLatencyScore: 55,
      servicePain: 0,
      planStats: [],
      apiSubscribers: 0,
      apiDemandMTok: 0,
      apiDayMTok: 0,
      apiDayRevenue: 0,
      apiDayDirectCogs: 0,
      apiDayAllocatedOps: 0,
      apiDayCogs: 0,
      capacityMTok: 0,
      demandPf: 0,
      servedPf: 0,
      capacityPf: 0,
      marginalPerMTok: 0,
      modelFinance: [],
      capacitySalesCapped: false,
      blockedApiMTok: 0,
      blockedSubscriptionSeats: 0,
      capacityProductRevenueCeiling: 0,
    },
    financeHistory: [],
    financeMonthlyHistory: [],
    externalities: { accounts: {}, incidents: [] },
    lastBenchmarkEvent: null,
    benchmarkSeasons: [
      {
        id: 'season-2026-foundations',
        name: 'Foundations 2026',
        version: 1,
        opensDay: 1,
        closesDay: 365,
        difficulty: 0.42,
        hiddenTasks: true,
        active: true,
      },
    ],
    evaluations: [],
    reviews: [],
  }
  return refreshPublicEstimates(syncLabIndex(normalizeSiteEnergyState(state)))
}

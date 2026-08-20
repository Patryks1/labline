import type { BenchmarkId, SegmentId } from '../types'

export interface SegmentDef {
  id: SegmentId
  name: string
  baseSize: number
  baseUsage: number
  weights: {
    quality: number
    price: number
    latency: number
    trust: number
    safety: number
    features: number
  }
  benchmarkWeights: Partial<Record<BenchmarkId, number>>
  prefersSub: boolean
  qualityFloor: number
  arpuHint: number
}

/**
 * Market segments — sizes tuned so a mid-tier lab can reach profitable scale
 * with ~1–7B models + reasonable capacity before day 80, while frontier +
 * enterprise still rewards late-game investment.
 */
/** Eight billion people exist, but only two billion start as active AI users. */
export const WORLD_POPULATION = 8_000_000_000
export const INITIAL_AI_USERS = 2_000_000_000

/**
 * Initial AI audience. Player and rivals compete for these people via market
 * share softmax; diffusion converts the remaining six billion over time.
 */
export const SEGMENTS: SegmentDef[] = [
  {
    id: 'hobby',
    name: 'Hobby / free chat',
    baseSize: 600_000_000,
    baseUsage: 0.14,
    // Price-led freemium / light API — huge pool, light tokens
    weights: { quality: 0.32, price: 0.4, latency: 0.18, trust: 0.05, safety: 0.05, features: 0.1 },
    benchmarkWeights: { mmlu: 0.28, coding: 0.16, multilingual: 0.16, safety: 0.1, math: 0.12, personality: 0.18 },
    prefersSub: false,
    qualityFloor: 16,
    arpuHint: 0,
  },
  {
    id: 'consumer',
    name: 'Consumer Sub',
    baseSize: 780_000_000,
    baseUsage: 0.28,
    weights: { quality: 0.48, price: 0.18, latency: 0.1, trust: 0.12, safety: 0.12, features: 0.1 },
    benchmarkWeights: { mmlu: 0.18, coding: 0.1, math: 0.08, multilingual: 0.12, safety: 0.16, vision: 0.12, personality: 0.24 },
    prefersSub: true,
    qualityFloor: 30,
    arpuHint: 20,
  },
  {
    id: 'indie_api',
    name: 'Indie API',
    baseSize: 160_000_000,
    baseUsage: 0.85,
    weights: { quality: 0.38, price: 0.34, latency: 0.14, trust: 0.05, safety: 0.04, features: 0.1 },
    benchmarkWeights: { coding: 0.45, mmlu: 0.25, math: 0.15, agents: 0.15 },
    prefersSub: false,
    qualityFloor: 24,
    arpuHint: 4,
  },
  {
    id: 'startup_api',
    name: 'Startup API',
    baseSize: 100_000_000,
    baseUsage: 1.8,
    weights: { quality: 0.55, price: 0.18, latency: 0.1, trust: 0.07, safety: 0.05, features: 0.12 },
    benchmarkWeights: { coding: 0.5, agents: 0.2, math: 0.15, mmlu: 0.15 },
    prefersSub: false,
    qualityFloor: 34,
    arpuHint: 18,
  },
  {
    id: 'science',
    name: 'Science & research',
    baseSize: 30_000_000,
    baseUsage: 6.2,
    weights: { quality: 0.5, price: 0.06, latency: 0.06, trust: 0.18, safety: 0.12, features: 0.1 },
    benchmarkWeights: { science: 0.42, math: 0.28, mmlu: 0.1, coding: 0.08, safety: 0.07, agents: 0.05 },
    prefersSub: false,
    qualityFloor: 50,
    arpuHint: 180,
  },
  {
    id: 'enterprise',
    name: 'Enterprise GenAI',
    baseSize: 100_000_000,
    baseUsage: 4.5,
    weights: { quality: 0.42, price: 0.06, latency: 0.08, trust: 0.22, safety: 0.22, features: 0.1 },
    benchmarkWeights: { mmlu: 0.16, coding: 0.22, safety: 0.22, agents: 0.12, multilingual: 0.12, personality: 0.16 },
    prefersSub: true,
    qualityFloor: 44,
    arpuHint: 120,
  },
  {
    id: 'creative',
    name: 'Creative B2B API',
    baseSize: 130_000_000,
    baseUsage: 1.5,
    weights: { quality: 0.42, price: 0.2, latency: 0.1, trust: 0.1, safety: 0.05, features: 0.28 },
    benchmarkWeights: { vision: 0.55, mmlu: 0.15, multilingual: 0.1, safety: 0.1, agents: 0.1 },
    prefersSub: false,
    qualityFloor: 28,
    arpuHint: 25,
  },
  {
    id: 'legal',
    name: 'Legal & compliance',
    baseSize: 50_000_000,
    baseUsage: 3.2,
    weights: { quality: 0.38, price: 0.08, latency: 0.06, trust: 0.24, safety: 0.26, features: 0.08 },
    benchmarkWeights: { law: 0.55, mmlu: 0.15, safety: 0.2, science: 0.1 },
    prefersSub: true,
    qualityFloor: 48,
    arpuHint: 200,
  },
  {
    id: 'healthcare',
    name: 'Healthcare AI',
    baseSize: 50_000_000,
    baseUsage: 2.8,
    weights: { quality: 0.36, price: 0.06, latency: 0.08, trust: 0.24, safety: 0.28, features: 0.08 },
    benchmarkWeights: { health: 0.55, science: 0.15, safety: 0.25, mmlu: 0.05 },
    prefersSub: true,
    qualityFloor: 52,
    arpuHint: 250,
  },
]

/** Bump when persisted market demand needs a one-time normalization on load. */
export const DEMAND_MODEL_VERSION = 5

export const ECONOMY = {
  daysPerMonth: 30,
  /** Base wholesale $/MWh before regional mult & grid scarcity */
  // Compute campuses face industrial firm-power pricing, not household power.
  energyBasePrice: 115,
  /** Variable upkeep for owned generation as a share of equivalent grid MWh. */
  onsiteGenerationCostShare: 0.6,
  /**
   * Shared regional grid capacity (MW) for all labs' utility draws.
   * ~15 data-hall interconnects × ~14 MW before scarcity pricing bites.
   */
  gridBaseMw: 210,
  /** Soft cap: # of live data halls (any owner) before $/MWh ramps hard */
  gridSoftDcCap: 15,
  /** Extra $/MWh per live DC above soft cap (compounded with event mults) */
  energyScarcityPerDc: 14,
  /** MW proxy per live DC when estimating industry grid load */
  gridMwPerDcProxy: 12,
  /** Max scarcity mult on energy price */
  energyScarcityMaxMult: 5.5,
  /**
   * Proxy MW draw per PF of wholesale compute (≈ H-class rack density).
   * Lease floor = this × PUE × 24h × $/MWh × computeLeaseEnergyMarkup.
   */
  mwPerPfProxy: 0.001,
  /** Seller must clear ≥ this × energy cost of the leased PF */
  computeLeaseEnergyMarkup: 1.5,
  chipAmortDays: 900,
  /** Network/egress-ish variable $/MTok (small vs power) */
  bandwidthPerMTok: 0.025,
  softmaxTemp: 1.4,
  churnBase: 0.009,
  brandDecayBadModel: 0.75,
  brandGainGoodShip: 1.6,

  /**
   * Cash-only start. Tuned so DC + interconnect + ~64 GPUs + small train
   * leaves runway for opex while revenue ramps (~day 40–60 break-even path).
   */
  startingCash: 20_000_000,
  startingChips: 0,
  /**
   * Established rivals enter as funded incumbents, not copies of the player's
   * seed-stage lab. Their policies differ, but all operating costs and physical
   * work still settle through the same market, compute, data and research rules.
   */
  incumbentStartingEnterpriseValue: 300_000_000,
  /**
   * Sub allowance MTok/user/day at usageMultiplier = 1.
   * The baseline Plus plan includes 20M tokens/month. A 1B dense model is
   * efficient enough that an early H100-class rack can sustain thousands of
   * full-allowance users, while larger models still require real fleet scale.
   */
  basePlanUsageMTokPerDay: 20 / 30,
  /**
   * API users: MTok/user/day at usageIntensity = 1.
   * Kept below subscription conversion so token API cannot print late-game
   * cash while seats stay a rounding error.
   */
  apiBaseMTokPerUserDay: 0.03,
  /**
   * Fraction of the addressable audience generating a useful AI workload on
   * an average day. Adoption is not the same thing as daily compute activity.
   */
  marketDailyActiveUsageShare: 0.22,
  /**
   * @deprecated Legacy constant. Prefer `pfPerMTokForModel` on a 7B dense
   * reference. Retained for old saves/tests; not used by settlement.
   */
  pfPerMTokAt7B: 0.007,
  /** Soft ceiling for plan price/mo — higher needs token value + SOTA to justify */
  planMaxPricePerMonth: 25_000,
  /**
   * Legacy fixed sub share — preferred path is ProductPricing.apiVsSubPriority.
   * Kept for tests / maxSeats fallbacks.
   */
  subCapacityShare: 0.38,
  /** Default API share of inference under constraint (0–1). Seats take the larger share. */
  defaultApiVsSubPriority: 0.46,
  /** Live 8-accelerator node opex/day beyond power and amortization. */
  rackOpexPerGpuDay: 210,
  /** Extra $/day per MW of live fleet draw beyond energy bill */
  rackOpexPerMwDay: 7_200,
  /** Facility shells, cooling, fleet operations, security, and maintenance. */
  facilityOpexMultiplier: 1.35,
  /** Early util floor before software research — serving starts power-hungry */
  startingUtilCap: 0.38,
  /**
   * Early serving stack. Decode MFU + this floor make dense 100B ~0.02 PF/MTok;
   * research pushes toward {@link maxServingEfficiency}.
   */
  startingServingEfficiency: 0.3,
  /** Soft cap applied in applyResearchEffectsToLab (late ASIC/fusion nodes). */
  maxServingEfficiency: 1.8,
  startingTrainEfficiency: 0.55,
  startingPue: 1.45,
  startingTalent: 1.15,
  startingDataQuality: 1,
  startingBrand: 50,

  wagePerTalentPerDay: 22_000,
  /** Soft demand scale with frontier capability (instant, not cumulative). */
  marketGrowthPerCapability: 0.0055,
  /**
   * Secular AI adoption — multiplies segment sizes each day (compounding).
   * ~0.12%/day ≈ +50% TAM over a year before frontier effects.
   */
  marketAdoptionPerDay: 0.00115,
  /** Extra daily adoption from public frontier capability. */
  marketAdoptionPerFrontier: 0.000012,
  hireTalentCost: 10_000_000,
  hireTalentWageBump: 0.35,
  dataPartnershipCost: 7_500_000,
  dataPartnershipBoost: 0.15,
  /** Daily enterprise seat value per contract (annuity only — no double lump). */
  enterpriseContractValue: 2_600_000,
  /** Max concurrent enterprise contracts (was unbounded free money). */
  maxEnterpriseContracts: 14,
  /** Soft enterprise revenue per attributed enterprise-segment user-day. */
  enterpriseSoftArpu: 0.008,

  /** Training job overhead as fraction of remaining cash burn while job runs */
  trainCashBurnPerPfDay: 8_500,
  trainUpfrontPerPfDay: 24_000,
  /**
   * Research burns research-pool PF *and* cash. Catalog PF-days are multiplied
   * by researchPfCostMult so most projects need a real cluster allocation.
   */
  researchPfCostMult: 2.6,
  /** Calendar floor mult on daysMin */
  researchDaysMult: 1.35,
  /** Cash spent per research PF-day of progress (~lab + cloud + talent) */
  researchCashPerPfDay: 22_000,
  /** Minimum cash buffer required to *start* a project (one day at mid progress) */
  researchStartCashFloor: 250_000,
  dataMixCostMult: {
    web: 1,
    code: 1.15,
    math: 1.2,
    curated: 1.45,
    synthetic: 0.75,
  } as Record<string, number>,

  buildingOpex: {
    dc: 148_000,
    substation: 28_000,
    solar: 16_000,
    gas: 78_000,
    nuclear: 320_000,
    fab: 520_000,
    cooling: 48_000,
    battery: 32_000,
    office: 55_000,
    lab: 88_000,
  } as Record<string, number>,

  fabPhases: {
    architecture: { days: 22, cash: 40_000_000 },
    tapeout: { days: 18, cash: 88_000_000 },
    fab_queue: { days: 50, cash: 380_000_000 },
    yield_ramp: { days: 28, cash: 78_000_000 },
    volume: { days: 0, cash: 0 },
  },

  victory: {
    share: 0.6,
    valuation: 42_000_000_000,
    capability: 76,
    minDay: 180,
    sustainDays: 180,
    minServeRate: 0.99,
    minPaidServeRate: 0.995,
    minHeadroom: 0.25,
    bankruptCash: -500_000_000,
  },

  /** Max facility upgrade level */
  maxBuildingLevel: 5,

  /**
   * Bank credit secured on lab valuation (LTV).
   * Draw size scales with company value; rates rise with leverage / risk.
   */
  loans: {
    maxActive: 4,
    /** Max debt / valuation (loan-to-value) — SOTA labs unlock more of this via higher valuation */
    maxLtv: 0.42,
    /** Even tiny early labs can get a small line */
    minCreditFloor: 55_000_000,
    /** Hard ceiling regardless of valuation */
    maxCreditCap: 4_500_000_000,
    minDraw: 5_000_000,
    baseInterest: 0.07,
    minInterest: 0.045,
    maxInterest: 0.28,
    /** Extra interest per ~90 days of term */
    termInterestPerQuarter: 0.045,
    /** Extra interest as post-draw LTV rises */
    leverageInterestMult: 0.4,
    /**
     * Facilities as fractions of the valuation credit line.
     * Principal = min(available, creditLimit × frac).
     */
    terms: [
      {
        id: 'bridge',
        label: 'Bridge note',
        blurb: 'Short runway for racks or a train job.',
        termDays: 30,
        fracOfLimit: 0.22,
      },
      {
        id: 'growth',
        label: 'Growth facility',
        blurb: 'Mid-term capital for halls, talent, data.',
        termDays: 60,
        fracOfLimit: 0.48,
      },
      {
        id: 'expansion',
        label: 'Expansion credit',
        blurb: 'Large draw against full credit line.',
        termDays: 90,
        fracOfLimit: 0.9,
      },
    ],
  },
}

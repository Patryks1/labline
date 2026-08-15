/**
 * Canonical daily marketing result.
 *
 * One computation per day turns channel spend into measurable outcomes:
 * qualified leads, acquired customers, enterprise leads, market expansion,
 * and campaign brand gain. Market demand / brand settlement consume this
 * outcome instead of re-deriving campaign effects from raw spend.
 *
 * Cash is NOT charged here — marketing spend is billed exactly once per day
 * by the market settlement (finance.dayMarketing). This module only measures
 * the campaign and applies its brand gain; it is the single writer of
 * campaign-driven brand lift.
 */
import type {
  MarketingChannel,
  MarketingChannelBreakdown,
  MarketingChannels,
  MarketingOutcome,
  SimState,
} from '../types'
import { playerSotaProximity } from './victory'

export interface MarketingChannelConfig {
  /** $ per face-value conversion before fit/appeal/brand/saturation */
  cac: number
  /** Channel-to-market fit for an AI lab's products */
  fit: number
  /** Brand-building quality of the channel */
  quality: number
  /** Spend per day at which the channel audience saturates */
  capacity: number
  /** Share of the channel's conversions that are enterprise-grade */
  enterpriseShare: number
  /** TAM growth (new addressable customers) per $ spent */
  expansion: number
}

/**
 * Channel behavior:
 * - web: value / general customers, plus the developer & community crowd
 *   (coding and API users discover the lab online)
 * - billboards: broad brand awareness — weak direct conversion, strongest
 *   market expansion
 * - restaurants: consumer presence — general consumer trials and reach
 * - enterprise: high-value plans and contracts — few, expensive leads
 */
export const MARKETING_CHANNEL_CONFIG: Record<MarketingChannel, MarketingChannelConfig> = {
  web: { cac: 45, fit: 1.15, quality: 0.55, capacity: 2_000_000, enterpriseShare: 0.02, expansion: 0.0002 },
  billboards: { cac: 140, fit: 0.7, quality: 1.2, capacity: 6_000_000, enterpriseShare: 0.005, expansion: 0.0015 },
  restaurants: { cac: 95, fit: 0.95, quality: 0.8, capacity: 1_500_000, enterpriseShare: 0.002, expansion: 0.0006 },
  enterprise: { cac: 5_200, fit: 1.3, quality: 0.9, capacity: 800_000, enterpriseShare: 0.85, expansion: 0.00005 },
}

export const MARKETING_CHANNELS: MarketingChannel[] = [
  'web',
  'billboards',
  'restaurants',
  'enterprise',
]

/** Normal campaigns land under ~1 brand/day; exceptional global campaigns cap at 2–3. */
export const BRAND_GAIN_DAILY_CAP = 2.5

/**
 * Diminishing marginal returns on spend within a channel audience.
 * (1 - exp(-x)) / max(x, ε), x = spend / marketCapacity — equals 1 for tiny
 * spend, decays monotonically as the audience saturates. Total effective
 * acquisitions still rise with spend (spend × saturation = capacity ×
 * (1 - exp(-x)) × …), but bounded by the audience size.
 */
export function spendSaturation(spend: number, marketCapacity: number): number {
  if (spend <= 0) return 1
  const x = spend / Math.max(1, marketCapacity)
  return (1 - Math.exp(-x)) / Math.max(x, 1e-9)
}

/** SOTA models make campaigns convert better; no public model is a weak generic pitch. */
export function marketingModelAppeal(state: SimState): number {
  const { sota, bestCap } = playerSotaProximity(state)
  return 0.7 + sota * 0.5 + Math.min(0.15, bestCap / 400)
}

/** Established brand makes every campaign cheaper to convert (same curve as org.marketingReach). */
export function marketingBrandFactor(state: SimState): number {
  return 0.65 + state.player.brandTrust / 140
}

/**
 * Channel mix for the day. Mirrors org.marketingChannels (same zero-floor and
 * default proportions) without an import cycle — org is the writer of
 * player.marketingChannels, marketing only reads it.
 */
export function marketingChannelSpend(state: SimState): MarketingChannels {
  const existing = state.player.marketingChannels
  if (existing) {
    return {
      web: Math.max(0, existing.web ?? 0),
      billboards: Math.max(0, existing.billboards ?? 0),
      restaurants: Math.max(0, existing.restaurants ?? 0),
      enterprise: Math.max(0, existing.enterprise ?? 0),
    }
  }
  const total = Math.max(0, state.player.marketingSpendPerDay)
  return {
    web: total * 0.38,
    billboards: total * 0.2,
    restaurants: total * 0.24,
    enterprise: total * 0.18,
  }
}

/** The canonical daily marketing result — pure, deterministic in state. */
export function computeMarketingOutcome(state: SimState): MarketingOutcome {
  const channels = marketingChannelSpend(state)
  const spend = Math.max(0, state.player.marketingSpendPerDay)
  const appeal = marketingModelAppeal(state)
  const brandFactor = marketingBrandFactor(state)
  const brand = state.player.brandTrust
  // Service failures offset the campaign story — ads can't outrun outages.
  const pain = state.player.servicePain ?? 0
  const unserved = state.lastMarket.unservedRatio ?? 0
  const deliveryFactor = Math.max(0.15, 1 - pain * 1.2 - unserved * 0.8)

  const channelBreakdown = {} as Record<MarketingChannel, MarketingChannelBreakdown>
  let qualifiedLeads = 0
  let acquiredCustomers = 0
  let enterpriseLeads = 0
  let marketExpansion = 0
  let rawBrandGain = 0

  for (const channel of MARKETING_CHANNELS) {
    const cfg = MARKETING_CHANNEL_CONFIG[channel]
    const channelSpend = Math.max(0, channels[channel] ?? 0)
    const base = channelSpend / cfg.cac
    const effective =
      base * cfg.fit * appeal * brandFactor * spendSaturation(channelSpend, cfg.capacity)
    const gain = cfg.quality * Math.log1p(channelSpend / 100_000) * Math.max(0, 1 - brand / 100)
    channelBreakdown[channel] = {
      spend: channelSpend,
      baseAcquisitions: base,
      effectiveAcquisitions: effective,
      qualifiedLeads: base,
      enterpriseLeads: effective * cfg.enterpriseShare,
      marketExpansion: channelSpend * cfg.expansion,
      brandGain: gain * deliveryFactor,
    }
    qualifiedLeads += base
    acquiredCustomers += effective
    enterpriseLeads += effective * cfg.enterpriseShare
    marketExpansion += channelSpend * cfg.expansion
    rawBrandGain += gain
  }

  return {
    day: state.day,
    spend,
    qualifiedLeads,
    acquiredCustomers,
    enterpriseLeads,
    marketExpansion,
    brandGain: Math.min(BRAND_GAIN_DAILY_CAP, rawBrandGain * deliveryFactor),
    channelBreakdown,
    effectiveCac: acquiredCustomers > 0 ? spend / acquiredCustomers : 0,
  }
}

/**
 * Today's canonical outcome for consumers (market demand, UI): the settled
 * result when already computed for this day, otherwise a live projection of
 * the current channel mix.
 */
export function currentMarketingOutcome(state: SimState): MarketingOutcome {
  const stored = state.player.marketingOutcome
  if (stored && stored.day === state.day) return stored
  return computeMarketingOutcome(state)
}

/**
 * Settle the daily campaign: store the canonical outcome and apply its brand
 * gain. Never touches cash — spend is billed once in tickMarket. Called from
 * tickOrg (end of day); the integration pass may move this to an explicit
 * tickMarketing step in tick.ts after tickMarket.
 */
export function applyDailyMarketing(state: SimState): SimState {
  const outcome = computeMarketingOutcome(state)
  if (outcome.spend <= 0) {
    if (!state.player.marketingOutcome) return state
    return {
      ...state,
      player: { ...state.player, marketingOutcome: outcome },
    }
  }
  return {
    ...state,
    player: {
      ...state.player,
      brandTrust: Math.min(100, state.player.brandTrust + outcome.brandGain),
      marketingOutcome: outcome,
    },
  }
}

/** Alias for the daily tick wiring (tick.ts integration point). */
export const tickMarketing = applyDailyMarketing

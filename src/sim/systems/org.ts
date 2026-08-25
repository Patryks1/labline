import { ECONOMY } from '../balance/economy'
import { aggregateEffects } from './research'
import type { MarketingChannel, MarketingChannels, SimState } from '../types'
import { isLivePublicModel } from '../modelRelease'
import { grantPartnershipData } from './data'
import { applyDailyMarketing } from './marketing'
// hireTalent deprecated — use systems/staff hireStaff via HQs

/**
 * @deprecated Global hire removed — use hireStaff() from systems/staff via HQs.
 * Kept as no-op redirect so old saves/hotkeys don't crash.
 */
export function hireTalent(state: SimState): SimState {
  return {
    ...state,
    alerts: [
      {
        id: `hire-moved-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message:
          'Hiring moved to HQs — build an HQ near a city and hire researchers / data staff there.',
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function buyDataPartnership(state: SimState): SimState {
  const cost = ECONOMY.dataPartnershipCost
  if (state.player.cash < cost) {
    return {
      ...state,
      alerts: [
        {
          id: `data-fail-${state.day}`,
          day: state.day,
          severity: 'warn' as const,
          message: `Data partnership costs ${formatM(cost)}.`,
        },
        ...state.alerts,
      ].slice(0, 40),
    }
  }
  let next = {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash - cost,
      dataQuality: Math.min(2.8, state.player.dataQuality + ECONOMY.dataPartnershipBoost),
    },
    alerts: [
      {
        id: `data-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message:
          'Data partnership signed — processed packs (chat/code/law/…) added to corpus.',
      },
      ...state.alerts,
    ].slice(0, 40),
  }
  next = grantPartnershipData(next)
  return next
}

export function setMarketing(state: SimState, perDay: number): SimState {
  const total = Math.max(0, Math.min(marketingBudgetCeiling(state), perDay))
  const revenueMultiple = total / marketingRevenueBasis(state)
  const prior = marketingChannels(state)
  const priorTotal = Object.values(prior).reduce((sum, value) => sum + value, 0)
  const channels = priorTotal > 0
    ? Object.fromEntries(
        Object.entries(prior).map(([channel, value]) => [channel, total * value / priorTotal]),
      ) as MarketingChannels
    : defaultMarketingChannels(total)
  return {
    ...state,
    player: {
      ...state.player,
      marketingSpendPerDay: total,
      marketingRevenueMultiple: revenueMultiple,
      marketingChannels: channels,
    },
  }
}

export const MARKETING_MAX_REVENUE_MULTIPLE = 5
const MARKETING_LAUNCH_REVENUE_FLOOR = 100_000

/** Revenue scale used by the growth allocation. The launch floor prevents a
 * pre-revenue company from being locked out of acquiring its first customers. */
export function marketingRevenueBasis(state: SimState): number {
  return Math.max(
    MARKETING_LAUNCH_REVENUE_FLOOR,
    state.player.finance.dayRevenue ?? 0,
  )
}

/** The player's persistent growth choice, inferred for legacy saves. */
export function marketingRevenueMultiple(state: SimState): number {
  const stored = state.player.marketingRevenueMultiple
  const inferred = state.player.marketingSpendPerDay / marketingRevenueBasis(state)
  const selected = typeof stored === 'number' && Number.isFinite(stored) ? stored : inferred
  return Math.max(
    0,
    Math.min(MARKETING_MAX_REVENUE_MULTIPLE, selected),
  )
}

/** Dynamic UI limit. There is no fixed dollar ceiling: it follows revenue. */
export function marketingBudgetCeiling(state: SimState): number {
  return marketingRevenueBasis(state) * MARKETING_MAX_REVENUE_MULTIPLE
}

export function defaultMarketingChannels(total: number): MarketingChannels {
  return {
    web: total * 0.38,
    billboards: total * 0.2,
    restaurants: total * 0.24,
    enterprise: total * 0.18,
  }
}

export function marketingChannels(state: SimState): MarketingChannels {
  const existing = state.player.marketingChannels
  if (existing) {
    return {
      web: Math.max(0, existing.web ?? 0),
      billboards: Math.max(0, existing.billboards ?? 0),
      restaurants: Math.max(0, existing.restaurants ?? 0),
      enterprise: Math.max(0, existing.enterprise ?? 0),
    }
  }
  return defaultMarketingChannels(state.player.marketingSpendPerDay)
}

export function setMarketingChannel(
  state: SimState,
  channel: MarketingChannel,
  perDay: number,
): SimState {
  const channels = marketingChannels(state)
  const otherSpend = Object.entries(channels).reduce(
    (sum, [key, value]) => sum + (key === channel ? 0 : value),
    0,
  )
  const nextValue = Math.max(0, Math.min(perDay, marketingBudgetCeiling(state) - otherSpend))
  const nextChannels = { ...channels, [channel]: nextValue }
  const total = Object.values(nextChannels).reduce((sum, value) => sum + value, 0)
  return {
    ...state,
    player: {
      ...state.player,
      marketingSpendPerDay: total,
      marketingRevenueMultiple: total / marketingRevenueBasis(state),
      marketingChannels: nextChannels,
    },
  }
}

export interface MarketingReach {
  webVisits: number
  billboardImpressions: number
  restaurantTrials: number
  enterpriseLeads: number
  demandEquivalentSpend: number
}

export function marketingReach(state: SimState): MarketingReach {
  const channels = marketingChannels(state)
  const brand = 0.65 + state.player.brandTrust / 140
  return {
    webVisits: channels.web * 7.5 * brand,
    billboardImpressions: channels.billboards * 34,
    restaurantTrials: channels.restaurants * 0.46 * brand,
    enterpriseLeads: channels.enterprise * 0.0025 * (0.8 + state.player.brandTrust / 200),
    demandEquivalentSpend:
      channels.web * 1.2 +
      channels.billboards * 0.78 +
      channels.restaurants * 1.08 +
      channels.enterprise * 0.7,
  }
}

export function tickOrg(state: SimState): SimState {
  const selectedMultiple = marketingRevenueMultiple(state)
  const rebasedSpend = marketingRevenueBasis(state) * selectedMultiple
  if (
    state.player.marketingRevenueMultiple == null ||
    Math.abs(rebasedSpend - state.player.marketingSpendPerDay) >= 1
  ) {
    const priorChannels = marketingChannels(state)
    const priorTotal = Object.values(priorChannels).reduce((sum, value) => sum + value, 0)
    state = {
      ...state,
      player: {
        ...state.player,
        marketingSpendPerDay: rebasedSpend,
        marketingRevenueMultiple: selectedMultiple,
        marketingChannels: priorTotal > 0
          ? Object.fromEntries(
              Object.entries(priorChannels).map(([channel, value]) => [
                channel,
                rebasedSpend * value / priorTotal,
              ]),
            ) as MarketingChannels
          : defaultMarketingChannels(rebasedSpend),
      },
    }
  }
  const effects = aggregateEffects(state.player.researchUnlocked)
  let dataQuality = state.player.dataQuality
  const brandTrust = state.player.brandTrust

  // Hygiene drift from flywheel research (collection itself is in tickData/collect)
  if (state.lastMarket.servedMTok > 1 && effects.dataFlywheel) {
    dataQuality = Math.min(
      2.8,
      dataQuality + Math.min(0.008, state.lastMarket.servedMTok * 0.0002 * effects.dataFlywheel),
    )
  }

  // Marketing cash is billed once in tickMarket; campaign brand lift is
  // written once per day by systems/marketing (applied below, after org ops).

  // Enterprise contracts: grant seats (annuity only in tickMarket — no signing lump)
  let enterpriseContracts = state.player.enterpriseContracts
  const model = state.player.models.find(
    (m) =>
      m.id === state.player.pricing.activeModelId &&
      isLivePublicModel(m),
  )
  const pain = state.player.servicePain ?? 0
  const unserved = state.lastMarket.unservedRatio ?? 0
  const slaOk = pain < 0.18 && unserved < 0.12
  const maxEnt = ECONOMY.maxEnterpriseContracts ?? 14
  if (
    model &&
    model.quality.safety > 55 &&
    model.quality.reliability > 55 &&
    brandTrust > 55 &&
    slaOk &&
    enterpriseContracts < maxEnt &&
    state.day % 12 === 0
  ) {
    enterpriseContracts += 1
  }

  // The normal daily pipeline settles marketing before tickMarket. Keep this
  // compatibility fallback for direct callers and older integrations, while
  // never applying the same day's campaign twice.
  const settled = state.player.marketingOutcome?.day === state.day
  const nextOrgState = {
    ...state,
    player: {
      ...state.player,
      dataQuality,
      brandTrust,
      enterpriseContracts,
    },
  }
  return settled ? nextOrgState : applyDailyMarketing(nextOrgState)
}

function formatM(n: number) {
  return `$${(n / 1e6).toFixed(1)}M`
}

import type { SimState } from './types'
import {
  collectFromTraffic,
  tickData,
  tickDataMarket,
  tickDataSupplierContracts,
} from './systems/data'

import { tickRivals } from './systems/rivals'
import { tickResearch } from './systems/research'
import { tickTraining } from './systems/training'
import { tickChipDeliveries } from './systems/chips'
import { tickRackDeliveries } from './systems/dcRacks'
import { tickMap } from './systems/map'
import {
  maybeListRivalHalls,
  tickCityPowerContracts,
  tickPowerExportContracts,
} from './systems/facilities'
import { tickComputeMarket } from './systems/computeMarket'
import { tickComputeContracts } from './systems/computeContracts'
import { tickMarket } from './systems/market'
import { tickEvents } from './systems/events'
import { tickFab } from './systems/silicon'
import { tickOrg } from './systems/org'
import { tickStaff } from './systems/staff'
import { tickLoans } from './systems/loans'
import { tickVictory } from './systems/victory'
import { computeSnapshot, inferenceTokensPerDay } from './systems/compute'
import { tickCityGrowth } from './systems/cityGrowth'
import { labIds, refreshPublicEstimates, syncLabIndex, tickLab } from './systems/labEngine'
import { queueRivalMarketOrders, tickSharedMarkets } from './systems/sharedMarkets'
import { calendarForDay } from './campaign'
import { tickCapital } from './systems/capital'
import { tickEvaluations } from './systems/evaluations'
import { tickProgression } from './systems/progression'
import { boundHistories } from './systems/history'
import { tickResearchPrograms } from './systems/researchPrograms'
import { tickSafetyCampaign } from './systems/safetyCampaigns'
import { tickExternalities } from './systems/externalities'
import { tickAutomation } from './systems/automation'
import { tickEnergyContracts, tickSiteProjects } from './systems/siteEnergy'

/**
 * Stable count of player-visible work that has crossed its completion
 * boundary.  Auto-pause compares this before/after the daily pipeline instead
 * of depending on alert wording, so new project types can opt in simply by
 * exposing a completed state here.
 */
function completedProjectCount(state: SimState): number {
  const completedBuildings = state.map.tiles.filter(
    (tile) =>
      tile.owner === 'player' &&
      tile.buildingTarget > 0 &&
      tile.buildingProgress >= tile.buildingTarget &&
      tile.campusRole !== 'pad',
  ).length
  const completedPrograms = (state.player.researchPrograms ?? []).filter(
    (program) => program.phase === 'complete',
  ).length
  const completedSites = state.siteProjects.filter(
    (project) => project.labId === state.playerLabId && project.status === 'complete',
  ).length

  return (
    completedBuildings +
    completedPrograms +
    completedSites +
    state.player.researchUnlocked.length +
    state.player.models.length
  )
}

export function tickDay(state: SimState): SimState {
  if (state.victory.outcome === 'lost' || state.progression.runPhase === 'failed') return state

  const completedBefore = completedProjectCount(state)
  const day = state.day + 1
  let s: SimState = {
    ...state,
    day,
    tick: state.tick + 1,
    calendar: calendarForDay(day, state.config.campaignRules),
  }

  // Reconcile canonical v4 edits and compatibility actions before any daily
  // system can observe or project a stale duplicate.
  s = syncLabIndex(s)

  // 1. World events and finite market replenishment.
  s = tickEvents(s)
  const majorEventStarted = s.activeEvents.some((event) => event.day === s.day)
  s = tickDataMarket(s)

  // 2–3. Controllers submit market policy, then shared books clear once.
  s = syncLabIndex(s)
  s = queueRivalMarketOrders(s)
  s = tickSharedMarkets(s)
  s = tickComputeMarket(s)
  s = tickComputeContracts(s)

  // 4–5. Deliveries and construction resolve before compute is observed.
  s = tickChipDeliveries(s)
  s = tickRackDeliveries(s)
  s = tickFab(s)
  s = tickMap(s)
  s = tickCityGrowth(s)
  s = maybeListRivalHalls(s)
  s = tickCityPowerContracts(s)
  s = tickPowerExportContracts(s)
  s = tickSiteProjects(s)

  // 6. Both controller types advance data, research, and training from the
  // same day's settled physical resources.
  s = tickData(s)
  s = tickDataSupplierContracts(s)
  s = tickRivals(s)
  s = tickResearch(s)
  s = tickResearchPrograms(s)
  s = tickTraining(s)
  s = tickSafetyCampaign(s)

  // 7–8. Resolve unconstrained demand, capacity shortages, and settlement.
  s = tickMarket(s)
  s = tickEnergyContracts(s)
  s = tickLoans(s)
  s = tickCapital(s)
  s = tickEvaluations(s)
  s = tickAutomation(s)

  // 9. Usage becomes tomorrow's corpus; staffing and org policies queue
  // their next-day intents before public estimates and victory checks.
  s = collectFromTraffic(s)
  s = tickStaff(s)
  s = tickOrg(s)
  s = syncLabIndex(s)
  for (const labId of labIds(s)) s = tickLab(s, labId)
  s = tickExternalities(s)
  s = refreshPublicEstimates(s)
  s = tickVictory(s)
  s = tickProgression(s)

  if (s.player.models.some((m) => m.shipped) && s.onboardingStep < 2) {
    s = { ...s, onboardingStep: 2 }
  }
  if (s.player.researchUnlocked.includes('sys_batching') && s.onboardingStep < 3) {
    s = { ...s, onboardingStep: 3 }
  }
  if (s.player.finance.totalShare > 0.05 && s.onboardingStep < 4) {
    s = { ...s, onboardingStep: 4 }
  }

  if (
    s.config.campaignRules.autoPause.projectComplete &&
    completedProjectCount(s) > completedBefore
  ) {
    s = withAutoPauseReason(
      s,
      'project',
      'Auto-pause: a construction, research, or model project completed.',
    )
  }
  if (
    s.config.campaignRules.autoPause.majorEvent &&
    majorEventStarted
  ) {
    s = withAutoPauseReason(
      s,
      'event',
      'Auto-pause: a major world event started.',
    )
  }
  if (
    s.config.campaignRules.autoPause.quarterlyReport &&
    s.calendar.isReviewDay
  ) {
    s = withAutoPauseReason(
      s,
      'review',
      `Auto-pause: the ${s.calendar.year} Q${Math.ceil(s.calendar.month / 3)} review is ready.`,
    )
  }
  if (
    s.config.campaignRules.autoPause.runwayEmergency &&
    s.player.finance.runwayDays < 60 &&
    !s.alerts.some((alert) => alert.id === `runway-${s.calendar.year}-${s.calendar.month}`)
  ) {
    s = {
      ...s,
      paused: true,
      alerts: [
        {
          id: `runway-${s.calendar.year}-${s.calendar.month}`,
          day: s.day,
          severity: 'danger',
          message: `Runway warning: ${Math.max(0, Math.floor(s.player.finance.runwayDays))} days at the current burn. Cut cloud capacity, refinance, or raise equity.`,
        },
        ...s.alerts,
      ],
    }
  }


  return boundHistories(s)
}

export function tickMany(state: SimState, days: number): SimState {
  let s = state
  for (let i = 0; i < days; i++) s = tickDay(s)
  return s
}

function withAutoPauseReason(
  state: SimState,
  kind: 'project' | 'event' | 'review',
  message: string,
): SimState {
  return {
    ...state,
    paused: true,
    alerts: [
      {
        id: `auto-pause-${kind}-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message,
      },
      ...state.alerts,
    ].slice(0, 80),
  }
}

export { computeSnapshot, inferenceTokensPerDay }

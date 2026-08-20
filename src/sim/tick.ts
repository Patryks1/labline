import type { SimState } from "./types";
import { setActiveBalanceTuning } from "./balance/tuning";
import {
  collectFromTraffic,
  tickData,
  tickDataMarket,
  tickDataSupplierContracts,
} from "./systems/data";

import { tickRivals } from "./systems/rivals";
import { tickResearch } from "./systems/research";
import {
  playerHasPendingTrainingDecision,
  tickTraining,
} from "./systems/training";
import { tickChipDeliveries } from "./systems/chips";
import { tickRackDeliveries } from "./systems/dcRacks";
import { tickMap } from "./systems/map";
import {
  maybeListRivalHalls,
  recordPowerEfficiencyDay,
  tickCityPowerContracts,
  tickPowerExportContracts,
} from "./systems/facilities";
import { tickComputeMarket } from "./systems/computeMarket";
import { tickComputeContracts, tickRivalCloudPurchases } from "./systems/computeContracts";
import { tickMarket } from "./systems/market";
import { nextDomainHeat } from "./balance/domainHeat";
import { tickEvents } from "./systems/events";
import { tickFab } from "./systems/silicon";
import { tickOrg } from "./systems/org";
import { tickStaff } from "./systems/staff";
import { tickLoans } from "./systems/loans";
import { tickVictory } from "./systems/victory";
import { computeSnapshot, inferenceTokensPerDay } from "./systems/compute";
import { tickCityGrowth } from "./systems/cityGrowth";
import {
  labIds,
  refreshPublicEstimates,
  syncLabIndex,
  tickLab,
} from "./systems/labEngine";
import {
  queueRivalMarketOrders,
  tickSharedMarkets,
} from "./systems/sharedMarkets";
import { calendarForDay } from "./campaign";
import { tickCapital } from "./systems/capital";
import { tickEvaluations } from "./systems/evaluations";
import { tickProgression } from "./systems/progression";
import { boundHistories } from "./systems/history";
import { tickResearchPrograms } from "./systems/researchPrograms";
import { tickSafetyCampaign } from "./systems/safetyCampaigns";
import { tickExternalities } from "./systems/externalities";
import { tickTransport } from "./systems/transport";
import { tickAutomation } from "./systems/automation";
import { tickEnergyContracts, tickSiteProjects } from "./systems/siteEnergy";
import { tickFacilityMarket } from "./systems/facilityMarket";
import { tickDataHallLayouts } from "./systems/dataHallLayouts";
import { resetDayLedgerCosts } from "./systems/financeLedger";
import { tickCheckpointEvaluations } from "./systems/checkpointEvaluations";

/**
 * Stable count of player-visible work that has crossed its completion
 * boundary.  Auto-pause compares this before/after the daily pipeline instead
 * of depending on alert wording, so new project types can opt in simply by
 * exposing a completed state here.
 */
function completedProjectCount(state: SimState): number {
  const completedBuildings = state.map.tiles.filter(
    (tile) =>
      tile.owner === "player" &&
      tile.buildingTarget > 0 &&
      tile.buildingProgress >= tile.buildingTarget &&
      tile.campusRole !== "pad",
  ).length;
  const completedPrograms = (state.player.researchPrograms ?? []).filter(
    (program) => program.phase === "complete",
  ).length;
  const completedSites = state.siteProjects.filter(
    (project) =>
      project.labId === state.playerLabId && project.status === "complete",
  ).length;

  return (
    completedBuildings +
    completedPrograms +
    completedSites +
    state.player.researchUnlocked.length +
    state.player.models.length
  );
}

/**
 * Run one daily system, isolating failures: a throwing system logs an error
 * and surfaces one sticky in-game alert, but can no longer silently freeze
 * the whole campaign. (Previously a single bad state field stalled every
 * later system — racks never commissioned, negotiations never resolved —
 * while the day counter kept moving.)
 */
export function runTickSystem(
  s: SimState,
  name: string,
  fn: (state: SimState) => SimState,
): SimState {
  try {
    return fn(s);
  } catch (error) {
    console.error(`[tickDay] ${name} failed on day ${s.day}:`, error);
    const id = `sysfail-${name}`;
    if (s.alerts.some((a) => a.id === id)) return s;
    return {
      ...s,
      alerts: [
        {
          id,
          day: s.day,
          severity: "danger" as const,
          message: `Daily system "${name}" hit an error and was skipped today — the rest of the game keeps running. Please report this.`,
        },
        ...s.alerts,
      ].slice(0, 40),
    };
  }
}

export function tickDay(state: SimState): SimState {
  if (
    state.victory.outcome === "lost" ||
    state.progression.runPhase === "failed"
  )
    return state;
  if (playerHasPendingTrainingDecision(state)) return state;

  // Balance knobs travel with the run; sync them so every balance function
  // below observes this campaign's tuning (and tests observe their own).
  setActiveBalanceTuning(state.balanceTuning);

  const completedBefore = completedProjectCount(state);
  const day = state.day + 1;
  let s: SimState = {
    ...state,
    day,
    tick: state.tick + 1,
    calendar: calendarForDay(day, state.config.campaignRules),
  };

  // Reconcile canonical v4 edits and compatibility actions before any daily
  // system can observe or project a stale duplicate.
  s = syncLabIndex(s);
  // Fresh day line-items before data / train / research burns accrue.
  s = resetDayLedgerCosts(s);

  // 1. World events and finite market replenishment.
  s = runTickSystem(s, "tickEvents", tickEvents);
  const majorEventStarted = s.activeEvents.some((event) => event.day === s.day);
  s = runTickSystem(s, "tickDataMarket", tickDataMarket);

  // Commission hall refits before any controller or market observes compute.
  // Newly delivered racks can enter an install queue on the following day;
  // ghost targets never contribute capacity before this boundary.
  s = runTickSystem(s, "tickDataHallLayouts", tickDataHallLayouts);

  // 2–3. Controllers submit market policy, then shared books clear once.
  s = syncLabIndex(s);
  s = runTickSystem(s, "queueRivalMarketOrders", queueRivalMarketOrders);
  s = runTickSystem(s, "tickSharedMarkets", tickSharedMarkets);
  s = runTickSystem(s, "tickComputeMarket", tickComputeMarket);
  s = runTickSystem(s, "tickComputeContracts", tickComputeContracts);

  // 4. Growth settles first, then the canonical transport assignment is
  // available to every delivery and construction consumer below.
  s = runTickSystem(s, "tickCityGrowth", tickCityGrowth);
  s = runTickSystem(s, "tickTransport", tickTransport);

  // 5. Deliveries and construction resolve before compute is observed.
  s = runTickSystem(s, "tickChipDeliveries", tickChipDeliveries);
  s = runTickSystem(s, "tickRackDeliveries", tickRackDeliveries);
  s = runTickSystem(s, "tickFab", tickFab);
  s = runTickSystem(s, "tickMap", tickMap);
  s = runTickSystem(s, "maybeListRivalHalls", maybeListRivalHalls);
  s = runTickSystem(s, "tickFacilityMarket", tickFacilityMarket);
  s = runTickSystem(s, "tickCityPowerContracts", tickCityPowerContracts);
  s = runTickSystem(s, "tickPowerExportContracts", tickPowerExportContracts);
  s = runTickSystem(s, "tickSiteProjects", tickSiteProjects);

  // 6. Both controller types advance data, research, and training from the
  // same day's settled physical resources.
  s = runTickSystem(s, "tickData", tickData);
  s = runTickSystem(s, "tickDataSupplierContracts", tickDataSupplierContracts);
  s = runTickSystem(s, "tickRivals", tickRivals);
  s = runTickSystem(s, "tickRivalCloudPurchases", tickRivalCloudPurchases);
  // One player-research authority per day. Preserve an in-flight legacy
  // project from older saves; otherwise named pods own both queued and active
  // program progression. The system-level guards enforce the same invariant
  // for direct callers.
  const podResearchAuthority =
    !s.player.activeResearch &&
    ((s.player.researchPods?.length ?? 0) > 0 ||
      (s.player.researchPrograms?.some(
        (program) => program.phase !== "complete",
      ) ??
        false) ||
      (s.player.researchProgramQueue?.length ?? 0) > 0);
  s = podResearchAuthority
    ? runTickSystem(s, "tickResearchPrograms", tickResearchPrograms)
    : runTickSystem(s, "tickResearch", tickResearch);
  s = runTickSystem(s, "tickTraining", tickTraining);
  s = runTickSystem(
    s,
    "tickCheckpointEvaluations",
    tickCheckpointEvaluations,
  );
  s = runTickSystem(s, "tickSafetyCampaign", tickSafetyCampaign);

  s = {
    ...s,
    domainHeat: nextDomainHeat(
      s.domainHeat,
      s.day,
      s.seed,
      s.calendar.era,
    ),
  };

  // 7–8. Resolve unconstrained demand, capacity shortages, and settlement.
  s = runTickSystem(s, "tickMarket", tickMarket);
  s = runTickSystem(s, "tickEnergyContracts", tickEnergyContracts);
  s = runTickSystem(s, "tickLoans", tickLoans);
  s = runTickSystem(s, "tickCapital", tickCapital);
  s = runTickSystem(s, "tickEvaluations", tickEvaluations);
  s = runTickSystem(s, "tickAutomation", tickAutomation);

  // 9. Usage becomes tomorrow's corpus; staffing and org policies queue
  // their next-day intents before public estimates and victory checks.
  s = runTickSystem(s, "collectFromTraffic", collectFromTraffic);
  s = runTickSystem(s, "tickStaff", tickStaff);
  s = runTickSystem(s, "tickOrg", tickOrg);
  s = syncLabIndex(s);
  for (const labId of labIds(s)) {
    s = runTickSystem(s, `tickLab:${labId}`, (prev) => tickLab(prev, labId));
  }
  s = runTickSystem(s, "tickExternalities", tickExternalities);
  s = runTickSystem(s, "refreshPublicEstimates", refreshPublicEstimates);
  s = runTickSystem(s, "tickVictory", tickVictory);
  s = runTickSystem(s, "tickProgression", tickProgression);
  // Daily power→compute efficiency sample for the Power panel trend.
  s = runTickSystem(s, "recordPowerEfficiencyDay", recordPowerEfficiencyDay);

  if (s.player.models.some((m) => m.shipped) && s.onboardingStep < 2) {
    s = { ...s, onboardingStep: 2 };
  }
  if (
    s.player.researchUnlocked.includes("sys_batching") &&
    s.onboardingStep < 3
  ) {
    s = { ...s, onboardingStep: 3 };
  }
  if (s.player.finance.totalShare > 0.05 && s.onboardingStep < 4) {
    s = { ...s, onboardingStep: 4 };
  }

  if (
    s.config.campaignRules.autoPause.projectComplete &&
    completedProjectCount(s) > completedBefore
  ) {
    s = withAutoPauseReason(
      s,
      "project",
      "Auto-pause: a construction, research, or model project completed.",
    );
  }
  if (s.config.campaignRules.autoPause.majorEvent && majorEventStarted) {
    s = withAutoPauseReason(
      s,
      "event",
      "Auto-pause: a major world event started.",
    );
  }
  if (
    s.config.campaignRules.autoPause.quarterlyReport &&
    s.calendar.isReviewDay
  ) {
    s = withAutoPauseReason(
      s,
      "review",
      `Auto-pause: the ${s.calendar.year} Q${Math.ceil(s.calendar.month / 3)} review is ready.`,
    );
  }
  if (
    s.config.campaignRules.autoPause.runwayEmergency &&
    s.player.finance.runwayDays < 60 &&
    !s.alerts.some(
      (alert) => alert.id === `runway-${s.calendar.year}-${s.calendar.month}`,
    )
  ) {
    s = {
      ...s,
      paused: true,
      alerts: [
        {
          id: `runway-${s.calendar.year}-${s.calendar.month}`,
          day: s.day,
          severity: "danger",
          message: `Runway warning: ${Math.max(0, Math.floor(s.player.finance.runwayDays))} days at the current burn. Cut cloud capacity, refinance, or raise equity.`,
        },
        ...s.alerts,
      ],
    };
  }

  return boundHistories(s);
}

export function tickMany(state: SimState, days: number): SimState {
  let s = state;
  for (let i = 0; i < days; i++) s = tickDay(s);
  return s;
}

function withAutoPauseReason(
  state: SimState,
  kind: "project" | "event" | "review",
  message: string,
): SimState {
  return {
    ...state,
    paused: true,
    alerts: [
      {
        id: `auto-pause-${kind}-${state.day}`,
        day: state.day,
        severity: "info" as const,
        message,
      },
      ...state.alerts,
    ].slice(0, 80),
  };
}

export { computeSnapshot, inferenceTokensPerDay };

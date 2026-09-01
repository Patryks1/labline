import type {
  PostTrainGymKind,
  ResearchPod,
  SimState,
  StaffHeadcount,
} from "../types";
import { playerStaff } from "./staff";

export interface HqStaffReservation {
  researchers: number;
  engineers: number;
  dataStaff: number;
}

const emptyReservation = (): HqStaffReservation => ({
  researchers: 0,
  engineers: 0,
  dataStaff: 0,
});

export function podStaffReservation(
  pods: readonly ResearchPod[],
  exceptPodId?: string,
): HqStaffReservation {
  return pods.reduce<HqStaffReservation>((total, pod) => {
    if (pod.id === exceptPodId) return total;
    total.researchers += Math.max(0, pod.researchers);
    total.engineers += Math.max(0, pod.engineers);
    total.dataStaff += Math.max(0, pod.dataStaff);
    return total;
  }, emptyReservation());
}

export interface StaffReservationOptions {
  exceptPodId?: string;
  exceptGymKind?: PostTrainGymKind;
  /** Ignore every gym reservation (used when reallocating gym crews). */
  exceptAllGyms?: boolean;
  /** Data prune jobs are excluded while their own scheduler assigns slots. */
  includeDataJobs?: boolean;
}

/**
 * One authoritative reservation ledger for every gameplay system that draws
 * real employees from HQ headcount. This prevents pods, gyms, safety work and
 * corpus audits from silently reusing the same person.
 */
export function reservedHqStaff(
  state: SimState,
  options: StaffReservationOptions = {},
): HqStaffReservation {
  const reserved = podStaffReservation(
    state.player.researchPods ?? [],
    options.exceptPodId,
  );
  if (!options.exceptAllGyms) {
    for (const gym of state.player.postTrainGyms ?? []) {
      if (gym.kind === options.exceptGymKind) continue;
      reserved.researchers += Math.max(0, gym.assignedResearchers ?? 0);
      reserved.engineers += Math.max(0, gym.assignedEngineers ?? 0);
      reserved.dataStaff += Math.max(0, gym.assignedDataStaff ?? 0);
    }
  }
  if (state.player.safetyCampaign) {
    reserved.researchers += Math.max(
      0,
      state.player.safetyCampaign.assignedResearchers ?? 0,
    );
  }
  if (options.includeDataJobs !== false) {
    for (const job of state.player.data.pruneQueue ?? []) {
      reserved.researchers += Math.max(0, job.researchersRequired ?? 0);
      reserved.engineers += Math.max(0, job.engineersRequired ?? 0);
    }
  }
  return reserved;
}

export function availableHqStaff(
  state: SimState,
  options: StaffReservationOptions = {},
): HqStaffReservation {
  const employed = playerStaff(state);
  const reserved = reservedHqStaff(state, options);
  return {
    researchers: Math.max(0, (employed.researcher ?? 0) - reserved.researchers),
    engineers: Math.max(0, (employed.engineer ?? 0) - reserved.engineers),
    dataStaff: Math.max(0, (employed.data_processor ?? 0) - reserved.dataStaff),
  };
}

/** Staff view safe to pass into runtime throughput functions. */
export function unreservedStaffHeadcount(state: SimState): StaffHeadcount {
  const employed = playerStaff(state);
  const reserved = reservedHqStaff(state);
  return {
    researcher: Math.max(0, (employed.researcher ?? 0) - reserved.researchers),
    engineer: Math.max(0, (employed.engineer ?? 0) - reserved.engineers),
    data_processor: Math.max(0, (employed.data_processor ?? 0) - reserved.dataStaff),
    ops: Math.max(0, employed.ops ?? 0),
  };
}

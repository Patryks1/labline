import { getResearchNode, researchBranchForNode } from "../balance/research";
import {
  RESEARCH_POD_TEMPLATES,
  researchPodFromTemplate,
  type ResearchPodTemplate,
} from "../balance/researchPods";
import { ECONOMY } from "../balance/economy";
import type {
  ResearchEvidence,
  ResearchNodeDef,
  ResearchPod,
  ResearchProgram,
  SimState,
} from "../types";
import { computeSnapshot } from "./compute";
import { researchPoolForTech } from "./data";
import { chargeExpense } from "./financeLedger";
import {
  applyResearchEffectsToPlayer,
  labResearchDayProgress,
  minResearchersForNode,
  nextAutoQueueResearchId,
  planResearchPath,
  researchCashPerPf,
  researchDaysTarget,
  researchFullyDone,
  researchLabMultiplier,
  researchMaxRanks,
  researchPfTarget,
} from "./research";
import { playerStaff } from "./staff";
import {
  availableHqStaff,
  podStaffReservation,
  reservedHqStaff,
} from "./staffReservations";
import { appendFeedEvents } from "./feed";

function withAlert(
  state: SimState,
  severity: "info" | "warn" | "danger",
  message: string,
): SimState {
  const published = {
    ...state,
    alerts: [
      {
        id: `research-program-${state.day}-${message}`,
        day: state.day,
        severity,
        message,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
  return published;
}

export interface ResearchPodStaffRequirements {
  researchers: number;
  engineers: number;
  dataStaff: number;
}

/** Minimum real HQ staff reserved by a pod for one catalog method. */
export function researchPodStaffRequirements(
  methodId: string,
): ResearchPodStaffRequirements {
  const researchers = minResearchersForNode(methodId);
  return {
    researchers,
    engineers: Math.max(1, Math.ceil(researchers / 8)),
    dataStaff: Math.max(1, Math.ceil(researchers / 12)),
  };
}

/**
 * Aggregate staff already reserved by research pods.  Manual pod staffing is
 * a reservation even when a pod has not yet been assigned a program; this is
 * what prevents the UI from allocating the same HQ employee to two pods.
 */
export function assignedPodStaff(
  pods: readonly ResearchPod[],
  exceptPodId?: string,
): ResearchPodStaffRequirements {
  return podStaffReservation(pods, exceptPodId);
}

export interface ResearchPodStaffAvailability {
  employed: ResearchPodStaffRequirements;
  reserved: ResearchPodStaffRequirements;
  available: ResearchPodStaffRequirements;
}

/**
 * Return aggregate HQ headcount and the seats available to a particular pod.
 * The values are intentionally aggregate because legacy saves do not carry a
 * per-HQ source on ResearchPod yet; the UI labels this as the HQ team pool.
 */
export function researchPodStaffAvailability(
  state: SimState,
  exceptPodId?: string,
): ResearchPodStaffAvailability {
  const staff = playerStaff(state);
  const employed = {
    researchers: Math.max(0, staff.researcher ?? 0),
    engineers: Math.max(0, staff.engineer ?? 0),
    dataStaff: Math.max(0, staff.data_processor ?? 0),
  };
  const reserved = reservedHqStaff(state, { exceptPodId });
  return {
    employed,
    reserved,
    available: {
      researchers: Math.max(0, employed.researchers - reserved.researchers),
      engineers: Math.max(0, employed.engineers - reserved.engineers),
      dataStaff: Math.max(0, employed.dataStaff - reserved.dataStaff),
    },
  };
}

export type ResearchPodStaffRole = keyof ResearchPodStaffRequirements;

/**
 * Seats this pod can actually work with: its roster, capped by HQ leftover
 * after other pods. Gym/audit reservations must not zero an in-flight team,
 * but a pod cannot mint people HQ no longer employs (poach, fire, over-assign).
 */
export function effectiveResearchPodStaff(
  state: SimState,
  pod: ResearchPod,
): ResearchPodStaffRequirements {
  const employed = playerStaff(state);
  const others = podStaffReservation(state.player.researchPods ?? [], pod.id);
  return {
    researchers: Math.min(
      Math.max(0, pod.researchers),
      Math.max(0, (employed.researcher ?? 0) - others.researchers),
    ),
    engineers: Math.min(
      Math.max(0, pod.engineers),
      Math.max(0, (employed.engineer ?? 0) - others.engineers),
    ),
    dataStaff: Math.min(
      Math.max(0, pod.dataStaff),
      Math.max(0, (employed.data_processor ?? 0) - others.dataStaff),
    ),
  };
}

/** Drop imaginary roster seats when HQ headcount shrinks. Active pods keep first claim. */
export function clampResearchPodsToHqStaff(state: SimState): SimState {
  const pods = state.player.researchPods ?? [];
  if (pods.length === 0) return state;
  const employed = playerStaff(state);
  let remaining: ResearchPodStaffRequirements = {
    researchers: Math.max(0, employed.researcher ?? 0),
    engineers: Math.max(0, employed.engineer ?? 0),
    dataStaff: Math.max(0, employed.data_processor ?? 0),
  };
  const ranked = [
    ...pods.filter((pod) => pod.assignmentId),
    ...pods.filter((pod) => !pod.assignmentId),
  ];
  const nextById = new Map<string, ResearchPod>();
  let changed = false;
  for (const pod of ranked) {
    const researchers = Math.min(Math.max(0, pod.researchers), remaining.researchers);
    const engineers = Math.min(Math.max(0, pod.engineers), remaining.engineers);
    const dataStaff = Math.min(Math.max(0, pod.dataStaff), remaining.dataStaff);
    if (
      researchers !== pod.researchers ||
      engineers !== pod.engineers ||
      dataStaff !== pod.dataStaff
    ) {
      changed = true;
    }
    remaining = {
      researchers: remaining.researchers - researchers,
      engineers: remaining.engineers - engineers,
      dataStaff: remaining.dataStaff - dataStaff,
    };
    nextById.set(pod.id, { ...pod, researchers, engineers, dataStaff });
  }
  if (!changed) return state;
  return {
    ...state,
    player: {
      ...state.player,
      researchPods: pods.map((pod) => nextById.get(pod.id) ?? pod),
    },
  };
}

/** Why an in-flight program is not ticking — same gates as the daily tick. */
export function researchProgramBlockReason(
  state: SimState,
  program: ResearchProgram,
): string | undefined {
  if (program.phase === "complete") return undefined;
  if (state.player.activeResearch) {
    return "Finish the legacy research project before this pod can continue.";
  }
  const pod = (state.player.researchPods ?? []).find(
    (candidate) => candidate.id === program.podId,
  );
  const lead = (state.player.researchLeads ?? []).find(
    (candidate) => candidate.id === pod?.leadId,
  );
  let method: ResearchNodeDef;
  try {
    method = getResearchNode(program.methodId);
  } catch {
    return "Unknown research method.";
  }
  if (!pod || !lead) return `${method.name} has no pod lead.`;
  if (pod.assignmentId !== program.id) {
    return `${pod.name} is not assigned to ${method.name}.`;
  }
  const missing = method.prereqs.filter(
    (id) => !state.player.researchUnlocked.includes(id),
  );
  if (missing.length > 0) {
    return `Waiting on ${getResearchNode(missing[0]!).name}.`;
  }
  const exclusiveConflict = state.player.researchUnlocked.some((otherId) => {
    if (otherId === method.id) return false;
    const other = getResearchNode(otherId);
    return (
      method.exclusiveWith?.includes(otherId) === true ||
      other.exclusiveWith?.includes(method.id) === true
    );
  });
  if (exclusiveConflict) {
    return `${method.name} conflicts with an integrated method.`;
  }
  const seated = effectiveResearchPodStaff(state, pod);
  const need = researchPodStaffRequirements(program.methodId);
  if (
    seated.researchers < need.researchers ||
    seated.engineers < need.engineers ||
    seated.dataStaff < need.dataStaff
  ) {
    return `${method.name} needs ${need.researchers}/${need.engineers}/${need.dataStaff} HQ staff (working ${seated.researchers}/${seated.engineers}/${seated.dataStaff}).`;
  }
  if (state.player.cash <= 0) return `${method.name} needs cash runway.`;
  const active = assignedResearchPrograms(state);
  const researchPool =
    computeSnapshot(state).pools.research * researchPoolForTech(state);
  const totalComputeShare = active.reduce(
    (sum, candidate) =>
      sum + Math.max(0.05, Math.min(0.8, candidate.computeShare)),
    0,
  );
  const share = Math.max(0.05, Math.min(0.8, program.computeShare));
  const compute = (researchPool * share) / Math.max(1, totalComputeShare);
  if (compute <= 0) {
    return `${method.name} has no research PF — raise Research allocation or free the pool.`;
  }
  return undefined;
}

export interface ResearchPodOpenStatus {
  template: ResearchPodTemplate;
  opened: boolean;
  prerequisiteMet: boolean;
  affordable: boolean;
}

export function researchPodOpenStatus(
  state: SimState,
  templateId: string,
): ResearchPodOpenStatus | undefined {
  const template = RESEARCH_POD_TEMPLATES.find(
    (candidate) => candidate.id === templateId,
  );
  if (!template) return undefined;
  return {
    template,
    opened: (state.player.researchPods ?? []).some(
      (pod) => pod.id === template.id,
    ),
    prerequisiteMet:
      !template.requiresResearch ||
      state.player.researchUnlocked.includes(template.requiresResearch),
    affordable: state.player.cash >= template.openCost,
  };
}

/** Open a named pod and recruit its lead; HQ staff remain a finite shared pool. */
export function openResearchPod(
  state: SimState,
  templateId: string,
): SimState {
  const status = researchPodOpenStatus(state, templateId);
  if (!status) return withAlert(state, "warn", "Research pod template not found.");
  const { template } = status;
  if (status.opened) return state;
  if (!status.prerequisiteMet && template.requiresResearch) {
    return withAlert(
      state,
      "warn",
      `Integrate ${getResearchNode(template.requiresResearch).name} before opening ${template.podName}.`,
    );
  }
  if (!status.affordable) {
    return withAlert(
      state,
      "warn",
      `Need $${Math.ceil((template.openCost - state.player.cash) / 1_000)}k more to open ${template.podName}.`,
    );
  }

  const charged = chargeExpense(state, template.openCost, "research");
  const opened = {
    ...charged,
    player: {
      ...charged.player,
      researchLeads: [
        ...(charged.player.researchLeads ?? []),
        { ...template.lead },
      ],
      researchPods: [
        ...(charged.player.researchPods ?? []),
        researchPodFromTemplate(template),
      ],
    },
    alerts: [
      {
        id: `research-pod-open-${template.id}-${state.day}`,
        day: state.day,
        severity: "info" as const,
        message: `${template.podName} is open. Assign free HQ staff or let it pick up eligible queued work.`,
      },
      ...charged.alerts,
    ].slice(0, 40),
    news: [
      `Day ${state.day}: ${template.lead.name} joins to lead ${template.podName}.`,
      ...charged.news,
    ].slice(0, 64),
  };
  return assignQueuedPrograms(
    appendFeedEvents(opened, [
      {
        id: `feed-research-pod-open-${template.id}-${state.day}`,
        day: state.day,
        category: "models",
        title: `${template.podName} opens`,
        body: `${template.lead.name} joins the lab. The pod can reserve researchers, engineers and data specialists from the shared HQ team pool.`,
        source: state.player.name,
        tone: "research",
        entityId: template.id,
        kind: "research_pod_opened",
      },
    ]),
    { announceBlocks: true },
  );
}

/**
 * Adjust one pod's manual role reservation while respecting total employed
 * headcount and the minimum staff required by its active program.  The action
 * is idempotent at the boundaries and returns an alert rather than producing
 * an invalid over-allocated save.
 */
export function setResearchPodStaff(
  state: SimState,
  podId: string,
  role: ResearchPodStaffRole,
  delta: number,
): SimState {
  const pod = (state.player.researchPods ?? []).find((candidate) => candidate.id === podId);
  if (!pod) return withAlert(state, "warn", "Research pod not found.");
  if (!Number.isFinite(delta) || delta === 0) return state;

  const availability = researchPodStaffAvailability(state, podId);
  const current = Math.max(0, pod[role]);
  const activeProgram = pod.assignmentId
    ? (state.player.researchPrograms ?? []).find(
        (program) => program.id === pod.assignmentId && program.phase !== "complete",
      )
    : undefined;
  const required = activeProgram
    ? researchPodStaffRequirements(activeProgram.methodId)[role]
    : 0;
  const minimum = Math.max(0, required);
  // Availability excludes this pod from reservations, so it is already the
  // selected pod's absolute capacity. Adding `current` here double-counted the
  // same employee and allowed cross-pod over-allocation.
  const maximum = availability.available[role];
  const requested = Math.round(current + delta);
  const nextValue = Math.max(minimum, Math.min(maximum, requested));
  if (nextValue === current) {
    const reason = requested < minimum
      ? `${pod.name} needs at least ${minimum} ${role === "researchers" ? "researcher" : role === "engineers" ? "engineer" : "data specialist"}${minimum === 1 ? "" : "s"} for its active program.`
      : `No ${role === "researchers" ? "researchers" : role === "engineers" ? "engineers" : "data specialists"} available in the HQ team pool.`;
    return withAlert(state, "warn", reason);
  }
  const updated = {
    ...state,
    player: {
      ...state.player,
      researchPods: (state.player.researchPods ?? []).map((candidate) =>
        candidate.id === podId ? { ...candidate, [role]: nextValue } : candidate,
      ),
    },
  };
  // Staff changes can make an existing queue item viable. Dispatch now so the
  // player does not need to wait for another day tick or re-queue the method.
  return assignQueuedPrograms(updated, { announceBlocks: true });
}

function allocatePodForMethod(
  state: SimState,
  pod: ResearchPod,
  methodId: string,
): { pod?: ResearchPod; reason?: string } {
  const need = researchPodStaffRequirements(methodId);
  // Leftover HQ already subtracts this pod's roster. Credit seated staff on
  // top so gyms/audits cannot freeze a team that is already sitting here —
  // without double-counting those same people as "available" again.
  const available = availableHqStaff(state);
  const seated = {
    researchers: Math.max(0, pod.researchers),
    engineers: Math.max(0, pod.engineers),
    dataStaff: Math.max(0, pod.dataStaff),
  };
  const canSeat = {
    researchers: seated.researchers + available.researchers,
    engineers: seated.engineers + available.engineers,
    dataStaff: seated.dataStaff + available.dataStaff,
  };
  if (canSeat.researchers < need.researchers) {
    return {
      reason: `Needs ${need.researchers} available researchers (have ${canSeat.researchers}).`,
    };
  }
  if (canSeat.engineers < need.engineers) {
    return {
      reason: `Needs ${need.engineers} available engineer${need.engineers === 1 ? "" : "s"} (have ${canSeat.engineers}).`,
    };
  }
  if (canSeat.dataStaff < need.dataStaff) {
    return {
      reason: `Needs ${need.dataStaff} available data specialist${need.dataStaff === 1 ? "" : "s"} (have ${canSeat.dataStaff}).`,
    };
  }
  // Existing allocations are preferences, never imaginary headcount. Preserve
  // valid surplus staff but cap every role at seated + truly free HQ seats.
  return {
    pod: {
      ...pod,
      researchers: Math.min(
        canSeat.researchers,
        Math.max(need.researchers, seated.researchers),
      ),
      engineers: Math.min(
        canSeat.engineers,
        Math.max(need.engineers, seated.engineers),
      ),
      dataStaff: Math.min(
        canSeat.dataStaff,
        Math.max(need.dataStaff, seated.dataStaff),
      ),
    },
  };
}

export function isResearchProgramAssigned(
  state: SimState,
  program: ResearchProgram,
): boolean {
  if (program.phase === "complete") return false;
  const pod = (state.player.researchPods ?? []).find(
    (candidate) => candidate.id === program.podId,
  );
  return pod?.assignmentId === program.id;
}

export function assignedResearchPrograms(state: SimState): ResearchProgram[] {
  return (state.player.researchPrograms ?? []).filter((program) =>
    isResearchProgramAssigned(state, program),
  );
}

function moveMethodToQueueFront(
  queue: readonly string[],
  methodId: string,
): string[] {
  return [methodId, ...queue.filter((candidate) => candidate !== methodId)];
}

function ensureMethodQueued(
  queue: readonly string[],
  methodId: string,
): string[] {
  if (queue.includes(methodId)) return [...queue];
  return [methodId, ...queue];
}

/**
 * Staff, unlocks, and exclusive gates that make a method impossible for this
 * pod right now. Cash, compute, and a legacy in-flight project are omitted —
 * those are temporary and should not auto-skip the queue.
 */
export function researchMethodRunnableOnPod(
  state: SimState,
  pod: ResearchPod,
  methodId: string,
): { ok: true } | { ok: false; reason: string } {
  let method: ResearchNodeDef;
  try {
    method = getResearchNode(methodId);
  } catch {
    return { ok: false, reason: "Unknown research method." };
  }
  if (researchFullyDone(state, methodId)) {
    return { ok: false, reason: `${method.name} is already integrated.` };
  }
  const lead = (state.player.researchLeads ?? []).find(
    (candidate) => candidate.id === pod.leadId,
  );
  if (!lead) return { ok: false, reason: `${pod.name} needs a named lead.` };
  const missing = method.prereqs.filter(
    (id) => !state.player.researchUnlocked.includes(id),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Waiting on ${getResearchNode(missing[0]!).name}.`,
    };
  }
  const conflict = methodConflictReason(state, method);
  if (conflict) return { ok: false, reason: conflict };
  const allocation = allocatePodForMethod(state, pod, methodId);
  if (!allocation.pod) {
    return {
      ok: false,
      reason: allocation.reason ?? `${pod.name} lacks staff.`,
    };
  }
  return { ok: true };
}

function researchProgramHardBlockReason(
  state: SimState,
  program: ResearchProgram,
): string | undefined {
  if (program.phase === "complete") return undefined;
  const runnable = (() => {
    let method: ResearchNodeDef;
    try {
      method = getResearchNode(program.methodId);
    } catch {
      return "Unknown research method.";
    }
    const pod = (state.player.researchPods ?? []).find(
      (candidate) => candidate.id === program.podId,
    );
    const lead = (state.player.researchLeads ?? []).find(
      (candidate) => candidate.id === pod?.leadId,
    );
    if (!pod || !lead) return undefined;
    const missing = method.prereqs.filter(
      (id) => !state.player.researchUnlocked.includes(id),
    );
    if (missing.length > 0) {
      return `Waiting on ${getResearchNode(missing[0]!).name}.`;
    }
    const exclusiveConflict = state.player.researchUnlocked.some((otherId) => {
      if (otherId === method.id) return false;
      const other = getResearchNode(otherId);
      return (
        method.exclusiveWith?.includes(otherId) === true ||
        other.exclusiveWith?.includes(method.id) === true
      );
    });
    if (exclusiveConflict) {
      return `${method.name} conflicts with an integrated method.`;
    }
    const allocation = allocatePodForMethod(state, pod, program.methodId);
    if (!allocation.pod) {
      return allocation.reason ?? `${pod.name} lacks staff.`;
    }
    return undefined;
  })();
  return runnable;
}

function parkProgramToQueue(
  state: SimState,
  program: ResearchProgram,
): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      researchPods: (state.player.researchPods ?? []).map((pod) =>
        pod.assignmentId === program.id ? { ...pod, assignmentId: null } : pod,
      ),
      researchProgramQueue: ensureMethodQueued(
        state.player.researchProgramQueue ?? [],
        program.methodId,
      ),
    },
  };
}

function nextRunnableQueuedMethod(
  state: SimState,
  pod: ResearchPod,
  exceptMethodId?: string,
): string | undefined {
  return (state.player.researchProgramQueue ?? []).find((methodId) => {
    if (methodId === exceptMethodId) return false;
    return researchMethodRunnableOnPod(state, pod, methodId).ok;
  });
}

/** Idle pod with queued work none of the current HQ roster can run. */
export function researchPodQueueStallReason(
  state: SimState,
  pod: ResearchPod,
): string | undefined {
  if (pod.assignmentId) return undefined;
  const queue = state.player.researchProgramQueue ?? [];
  if (queue.length === 0) return undefined;
  if (nextRunnableQueuedMethod(state, pod)) return undefined;
  const first = queue[0];
  if (!first) return undefined;
  const blocked = researchMethodRunnableOnPod(state, pod, first);
  if (!blocked.ok) {
    return `No queued method this roster can run. ${blocked.reason}`;
  }
  return "No queued method this roster can run.";
}

function reconcileAssignedPodStaff(state: SimState): SimState {
  let next = state;
  let changed = false;
  const pods = [...(next.player.researchPods ?? [])];
  for (let index = 0; index < pods.length; index++) {
    const pod = pods[index];
    if (!pod?.assignmentId) continue;
    const program = (next.player.researchPrograms ?? []).find(
      (candidate) =>
        candidate.id === pod.assignmentId && candidate.phase !== "complete",
    );
    if (!program) continue;
    if (researchProgramHardBlockReason(next, program)) continue;
    const allocation = allocatePodForMethod(next, pod, program.methodId);
    if (!allocation.pod) continue;
    if (
      allocation.pod.researchers === pod.researchers &&
      allocation.pod.engineers === pod.engineers &&
      allocation.pod.dataStaff === pod.dataStaff
    ) {
      continue;
    }
    pods[index] = allocation.pod;
    changed = true;
    next = {
      ...next,
      player: { ...next.player, researchPods: pods },
    };
  }
  return changed ? next : state;
}

function skipBlockedPodAssignments(state: SimState): SimState {
  let next = reconcileAssignedPodStaff(state);
  for (const pod of next.player.researchPods ?? []) {
    if (!pod.assignmentId) continue;
    const program = (next.player.researchPrograms ?? []).find(
      (candidate) =>
        candidate.id === pod.assignmentId && candidate.phase !== "complete",
    );
    if (!program) continue;
    const hardBlock = researchProgramHardBlockReason(next, program);
    if (!hardBlock) continue;
    const fallback = nextRunnableQueuedMethod(next, pod, program.methodId);
    if (!fallback) continue;
    next = parkProgramToQueue(next, program);
    next = {
      ...next,
      player: {
        ...next.player,
        researchProgramQueue: moveMethodToQueueFront(
          next.player.researchProgramQueue ?? [],
          fallback,
        ),
      },
      alerts: [
        {
          id: `research-program-skip-${program.id}-${next.day}`,
          day: next.day,
          severity: "info" as const,
          message: `${getResearchNode(program.methodId).name} is blocked (${hardBlock.replace(/\.$/, "")}). ${pod.name} picks up ${getResearchNode(fallback).name}.`,
        },
        ...next.alerts,
      ].slice(0, 40),
    };
  }
  return next;
}

function methodConflictReason(
  state: SimState,
  method: ResearchNodeDef,
): string | undefined {
  const scheduled = new Set([
    ...state.player.researchUnlocked,
    ...state.player.researchQueue,
    ...(state.player.activeResearch
      ? [state.player.activeResearch.nodeId]
      : []),
    ...(state.player.researchProgramQueue ?? []),
    ...(state.player.researchPrograms ?? [])
      .filter((program) => program.phase !== "complete")
      .map((program) => program.methodId),
  ]);
  scheduled.delete(method.id);
  for (const otherId of scheduled) {
    const other = getResearchNode(otherId);
    if (
      method.exclusiveWith?.includes(otherId) ||
      other.exclusiveWith?.includes(method.id)
    ) {
      return `Conflicts with ${other.name}.`;
    }
  }
  return undefined;
}

export function startResearchProgram(
  state: SimState,
  methodId: string,
  podId: string,
  computeShare = 0.25,
): SimState {
  let method;
  try {
    method = getResearchNode(methodId);
  } catch {
    return withAlert(state, "warn", "Unknown research method.");
  }
  if (researchFullyDone(state, methodId)) {
    return withAlert(state, "warn", `${method.name} is already integrated.`);
  }
  const parked = (state.player.researchPrograms ?? []).find(
    (program) =>
      program.methodId === methodId && program.phase !== "complete",
  );
  if (parked && isResearchProgramAssigned(state, parked)) {
    return withAlert(
      state,
      "warn",
      `${method.name} already has an active program.`,
    );
  }
  if (state.player.activeResearch) {
    return withAlert(
      state,
      "warn",
      `Finish the active legacy project before assigning ${method.name} to a pod.`,
    );
  }
  const pod = (state.player.researchPods ?? []).find(
    (candidate) => candidate.id === podId,
  );
  if (!pod) return withAlert(state, "warn", "Research pod not found.");
  if (pod.assignmentId)
    return withAlert(state, "warn", `${pod.name} already has an assignment.`);
  const lead = (state.player.researchLeads ?? []).find(
    (candidate) => candidate.id === pod.leadId,
  );
  if (!lead) return withAlert(state, "warn", `${pod.name} needs a named lead.`);
  const missing = method.prereqs.filter(
    (id) => !state.player.researchUnlocked.includes(id),
  );
  if (missing.length > 0)
    return withAlert(
      state,
      "warn",
      `Missing prerequisite: ${getResearchNode(missing[0]!).name}.`,
    );
  const conflict = methodConflictReason(state, method);
  if (conflict) return withAlert(state, "warn", conflict);
  const allocation = allocatePodForMethod(state, pod, methodId);
  if (!allocation.pod) {
    return withAlert(
      state,
      "warn",
      allocation.reason ?? `${pod.name} lacks staff.`,
    );
  }
  const cashFloor = ECONOMY.researchStartCashFloor ?? 250_000;
  if (state.player.cash < cashFloor) {
    return withAlert(
      state,
      "warn",
      `Need ~$${Math.round(cashFloor / 1_000)}k cash runway to open ${method.name}.`,
    );
  }
  const researchPf =
    computeSnapshot(state).pools.research *
    researchPoolForTech(state, { reserveTree: true });
  if (researchPf < 0.05) {
    return withAlert(
      state,
      "warn",
      "Raise Research allocation — the pod needs real PF in the research pool.",
    );
  }

  const program: ResearchProgram = parked
    ? { ...parked, podId }
    : {
        id: `program-${methodId}-${state.day}`,
        methodId,
        podId,
        phase: "hypothesis",
        evidence: [],
        insightProgress: 0,
        engineeringProgress: 0,
        progressPfDays: 0,
        daysSpent: 0,
        effectsApplied: false,
        computeShare: Math.max(0.05, Math.min(0.8, computeShare)),
        disclosure: "secret",
      };
  const started = {
    ...state,
    player: {
      ...state.player,
      researchPrograms: parked
        ? (state.player.researchPrograms ?? []).map((candidate) =>
            candidate.id === program.id ? program : candidate,
          )
        : [...(state.player.researchPrograms ?? []), program],
      researchPods: (state.player.researchPods ?? []).map((candidate) =>
        candidate.id === podId
          ? { ...allocation.pod!, assignmentId: program.id }
          : candidate,
      ),
    },
    news: [
      `Day ${state.day}: ${lead.name} opens ${method.name} in ${pod.name} (${researchBranchForNode(methodId)}).`,
      ...state.news,
    ].slice(0, 64),
  };
  return appendFeedEvents(started, [
    {
      id: `feed-research-program-start-${program.id}`,
      day: state.day,
      category: "models",
      title: `${pod.name} starts ${method.name}`,
      body: `${lead.name} opened a ${researchBranchForNode(methodId)} program with ${Math.round(program.computeShare * 100)}% of the research pool. Evidence and integration gates are now active.`,
      source: state.player.name,
      tone: "research",
      entityId: program.id,
      kind: "research_program_started",
    },
  ]);
}

export function queueResearchProgram(
  state: SimState,
  methodId: string,
): SimState {
  let method;
  try {
    method = getResearchNode(methodId);
  } catch {
    return withAlert(state, "warn", "Unknown research method.");
  }
  if (researchFullyDone(state, methodId)) return state;
  const programQueue = state.player.researchProgramQueue ?? [];
  if (programQueue.includes(methodId)) return state;
  const activeMethods = (state.player.researchPrograms ?? [])
    .filter((program) => isResearchProgramAssigned(state, program))
    .map((program) => program.methodId);
  if (activeMethods.includes(methodId)) return state;
  const conflict = methodConflictReason(state, method);
  if (conflict) return withAlert(state, "warn", conflict);
  const path = planResearchPath(
    state.player.researchUnlocked,
    [...activeMethods, ...programQueue],
    methodId,
    state.player.researchRanks,
  );
  if (path.reason) return withAlert(state, "warn", path.reason);
  if (programQueue.length + path.nodeIds.length > 12) {
    return withAlert(
      state,
      "warn",
      `Research path needs ${path.nodeIds.length} queue slots (12 max).`,
    );
  }
  const queued = {
    ...state,
    player: {
      ...state.player,
      researchProgramQueue: [...programQueue, ...path.nodeIds],
    },
    alerts:
      path.nodeIds.length > 1
        ? [
            {
              id: `research-path-${state.day}-${methodId}`,
              day: state.day,
              severity: "info" as const,
              message: `Queued ${path.nodeIds.length}-method path to ${method.name}.`,
            },
            ...state.alerts,
          ].slice(0, 40)
        : state.alerts,
  };
  return assignQueuedPrograms(queued, { announceBlocks: true });
}

export function dequeueResearchProgram(
  state: SimState,
  methodId: string,
): SimState {
  const program = (state.player.researchPrograms ?? []).find(
    (candidate) =>
      candidate.methodId === methodId && candidate.phase !== "complete",
  );
  const next = {
    ...state,
    player: {
      ...state.player,
      researchProgramQueue: (state.player.researchProgramQueue ?? []).filter(
        (candidate) => candidate !== methodId,
      ),
      researchPrograms: program
        ? (state.player.researchPrograms ?? []).filter(
            (candidate) => candidate.id !== program.id,
          )
        : state.player.researchPrograms,
      researchPods: program
        ? (state.player.researchPods ?? []).map((pod) =>
            pod.assignmentId === program.id
              ? { ...pod, assignmentId: null }
              : pod,
          )
        : state.player.researchPods,
    },
  };
  if (!program) return next;
  return assignQueuedPrograms(next, { announceBlocks: true });
}

/**
 * Make a queued (or parked) method the active assignment on a pod.
 * The previous in-flight method is parked back onto the queue, not deleted.
 */
export function setActiveResearchProgram(
  state: SimState,
  methodId: string,
  podId?: string,
): SimState {
  let method: ResearchNodeDef;
  try {
    method = getResearchNode(methodId);
  } catch {
    return withAlert(state, "warn", "Unknown research method.");
  }
  const pods = state.player.researchPods ?? [];
  const pod =
    (podId ? pods.find((candidate) => candidate.id === podId) : undefined) ??
    pods.find((candidate) => candidate.assignmentId) ??
    pods[0];
  if (!pod) return withAlert(state, "warn", "Research pod not found.");

  const current = pod.assignmentId
    ? (state.player.researchPrograms ?? []).find(
        (program) => program.id === pod.assignmentId,
      )
    : undefined;
  if (current?.methodId === methodId) return state;

  const queued = (state.player.researchProgramQueue ?? []).includes(methodId);
  const parked = (state.player.researchPrograms ?? []).find(
    (program) =>
      program.methodId === methodId &&
      program.phase !== "complete" &&
      !isResearchProgramAssigned(state, program),
  );
  if (!queued && !parked) {
    return withAlert(
      state,
      "warn",
      `${method.name} is not in the research queue.`,
    );
  }

  const runnable = researchMethodRunnableOnPod(state, pod, methodId);
  if (!runnable.ok) {
    return withAlert(state, "warn", runnable.reason);
  }

  let next = current ? parkProgramToQueue(state, current) : state;
  if (parked && !queued) {
    next = {
      ...next,
      player: {
        ...next.player,
        researchProgramQueue: ensureMethodQueued(
          next.player.researchProgramQueue ?? [],
          methodId,
        ),
      },
    };
  }
  next = {
    ...next,
    player: {
      ...next.player,
      researchProgramQueue: moveMethodToQueueFront(
        next.player.researchProgramQueue ?? [],
        methodId,
      ),
    },
  };
  return assignQueuedPrograms(next, { announceBlocks: true });
}

function assignQueuedPrograms(
  state: SimState,
  options?: { announceBlocks?: boolean },
): SimState {
  let next = skipBlockedPodAssignments(state);
  let changed = next !== state;
  let lastBlocked: SimState | undefined;
  while (true) {
    const pods = (next.player.researchPods ?? []).filter(
      (candidate) => !candidate.assignmentId,
    );
    const readyMethods = (next.player.researchProgramQueue ?? []).filter(
      (candidate) => {
        try {
          const method = getResearchNode(candidate);
          return (
            !researchFullyDone(next, candidate) &&
            method.prereqs.every((prerequisite) =>
              next.player.researchUnlocked.includes(prerequisite),
            )
          );
        } catch {
          return false;
        }
      },
    );
    let assignment:
      | { state: SimState; methodId: string }
      | undefined;
    for (const pod of pods) {
      for (const methodId of readyMethods) {
        const attempted = startResearchProgram(next, methodId, pod.id);
        const assigned = attempted.player.researchPods?.find(
          (candidate) => candidate.id === pod.id,
        )?.assignmentId;
        if (assigned) {
          assignment = { state: attempted, methodId };
          break;
        }
        lastBlocked = attempted;
      }
      if (assignment) break;
    }
    if (!assignment) break;
    next = {
      ...assignment.state,
      player: {
        ...assignment.state.player,
        researchProgramQueue: (
          assignment.state.player.researchProgramQueue ?? []
        ).filter((candidate) => candidate !== assignment.methodId),
      },
    };
    changed = true;
  }
  if (changed) return next;
  if (
    options?.announceBlocks &&
    lastBlocked &&
    lastBlocked.alerts !== state.alerts
  ) {
    return lastBlocked;
  }
  return state;
}

function hasNewActiveProgram(before: SimState, after: SimState): boolean {
  const previous = new Set(
    assignedResearchPrograms(before).map((program) => program.id),
  );
  return assignedResearchPrograms(after).some(
    (program) => !previous.has(program.id),
  );
}

function addEvidence(
  evidence: ResearchEvidence[],
  program: ResearchProgram,
  day: number,
  source: ResearchEvidence["source"],
  strength: number,
): ResearchEvidence[] {
  if (evidence.some((item) => item.source === source)) return evidence;
  return [
    ...evidence,
    {
      id: `evidence-${program.id}-${source}`,
      strength,
      source,
      day,
    },
  ];
}

function maybeAutoQueueResearchProgram(
  state: SimState,
  lastCompletedNodeId?: string,
): SimState {
  const id = nextAutoQueueResearchId(state, lastCompletedNodeId);
  if (!id) return state;
  return queueResearchProgram(state, id);
}

export function tickResearchPrograms(state: SimState): SimState {
  // An in-flight legacy project retains authority until it completes. This
  // guard also protects direct system callers outside the daily tick.
  if (state.player.activeResearch) return state;
  const opened = state.player.autoQueueResearch
    ? maybeAutoQueueResearchProgram(state)
    : state;
  const assigned = assignQueuedPrograms(opened, {
    announceBlocks: state.day % 4 === 0,
  });
  const scheduled = clampResearchPodsToHqStaff(assigned);
  if (hasNewActiveProgram(state, scheduled)) {
    return tickResearchPrograms(scheduled);
  }
  const active = assignedResearchPrograms(scheduled);
  if (active.length === 0) {
    return (scheduled.player.researchCashBurnToday ?? 0) === 0
      ? scheduled
      : {
          ...scheduled,
          player: { ...scheduled.player, researchCashBurnToday: 0 },
        };
  }
  const snapshot = computeSnapshot(scheduled);
  const researchPool =
    snapshot.pools.research * researchPoolForTech(scheduled);
  const totalComputeShare = active.reduce(
    (sum, program) => sum + Math.max(0.05, Math.min(0.8, program.computeShare)),
    0,
  );
  let cash = scheduled.player.cash;
  let unlocked = [...scheduled.player.researchUnlocked];
  let ranks = { ...(scheduled.player.researchRanks ?? {}) };
  let pods = [...(scheduled.player.researchPods ?? [])];
  const completed: Array<{
    id: string;
    name: string;
    methodId: string;
    rank: number;
    maxRanks: number;
    firstRank: boolean;
  }> = [];
  const effectsToApply: ResearchNodeDef[] = [];
  let stallMessage: string | undefined;
  const programs = (scheduled.player.researchPrograms ?? []).map(
    (program): ResearchProgram => {
      if (program.phase === "complete") return program;
      const pod = pods.find((candidate) => candidate.id === program.podId);
      const lead = (scheduled.player.researchLeads ?? []).find(
        (candidate) => candidate.id === pod?.leadId,
      );
      if (!pod || !lead) {
        stallMessage = stallMessage ?? "Research pod lost its lead — reassign the program.";
        return program;
      }
      if (pod.assignmentId !== program.id) {
        return program;
      }
      const method = getResearchNode(program.methodId);
      const need = researchPodStaffRequirements(program.methodId);
      const prerequisitesMet = method.prereqs.every((id) =>
        unlocked.includes(id),
      );
      const exclusiveConflict = unlocked.some((otherId) => {
        if (otherId === method.id) return false;
        const other = getResearchNode(otherId);
        return (
          method.exclusiveWith?.includes(otherId) === true ||
          other.exclusiveWith?.includes(method.id) === true
        );
      });
      // Gyms, safety, and corpus audits must not freeze an in-flight team.
      // Imaginary roster seats above current HQ (poach, fire) also must not:
      // work with the people HQ still employs, as long as that meets the method.
      const seated = effectiveResearchPodStaff(
        { ...scheduled, player: { ...scheduled.player, researchPods: pods } },
        pod,
      );
      const allocationBacked =
        pod.assignmentId === program.id &&
        seated.researchers >= need.researchers &&
        seated.engineers >= need.engineers &&
        seated.dataStaff >= need.dataStaff;
      const headcount = seated.researchers + seated.engineers + seated.dataStaff;
      const coordinationCap = 3 + lead.skills.leadership * 8;
      const coordination = Math.min(
        1,
        coordinationCap / Math.max(1, headcount),
      );
      const leadSkill =
        lead.skills.algorithms * 0.35 +
        lead.skills.systems * 0.25 +
        lead.skills.dataEvals * 0.2 +
        lead.skills.leadership * 0.2;
      const share = Math.max(0.05, Math.min(0.8, program.computeShare));
      const compute = (researchPool * share) / Math.max(1, totalComputeShare);
      const target = researchPfTarget(state, method);
      const legacyProgress =
        program.phase === "integration"
          ? target * (0.68 + Math.max(0, program.engineeringProgress) * 0.32)
          : target *
            Math.min(0.68, Math.max(0, program.insightProgress) * 0.68);
      const currentProgress = Math.max(
        0,
        program.progressPfDays ?? legacyProgress,
      );
      const currentDays = Math.max(0, program.daysSpent ?? 0);
      const cashBefore = cash;
      let progress = 0;
      if (
        allocationBacked &&
        prerequisitesMet &&
        !exclusiveConflict &&
        compute > 0 &&
        cashBefore > 0
      ) {
        progress = labResearchDayProgress({
          researchers: seated.researchers,
          engineers: seated.engineers,
          researchPf: compute,
          nodeId: program.methodId,
          labResearchMult:
            researchLabMultiplier(scheduled) *
            (0.8 + leadSkill * 0.35) *
            coordination,
        });
        progress = Math.min(progress, Math.max(0, target - currentProgress));
        const cashRate = researchCashPerPf(method);
        if (cashRate > 0) progress = Math.min(progress, cashBefore / cashRate);
        cash -= progress * cashRate;
      }
      const nextProgress = Math.min(target, currentProgress + progress);
      const reachedPfTarget = nextProgress + 1e-9 >= target;
      const fundedCalendarDay =
        allocationBacked &&
        prerequisitesMet &&
        !exclusiveConflict &&
        cashBefore > 0 &&
        (progress > 0 || reachedPfTarget);
      const daysSpent = currentDays + (fundedCalendarDay ? 1 : 0);
      const fraction = Math.min(1, nextProgress / Math.max(1e-9, target));
      const insightProgress = Math.min(1, fraction / 0.68);
      const engineeringProgress = Math.max(
        0,
        Math.min(1, (fraction - 0.68) / 0.32),
      );
      let evidence = program.evidence;

      if (fraction >= 0.43) {
        evidence = addEvidence(
          evidence,
          program,
          scheduled.day,
          "pilot",
          0.45 + leadSkill * 0.3,
        );
      }
      if (fraction >= 0.68) {
        evidence = addEvidence(
          evidence,
          program,
          scheduled.day,
          "training",
          0.5 + leadSkill * 0.35,
        );
      }
      const daysTarget = researchDaysTarget(method, seated.researchers);
      const complete =
        nextProgress + 1e-9 >= target &&
        daysSpent >= daysTarget &&
        evidence.length >= 2;
      let phase: ResearchProgram["phase"] =
        fraction >= 0.68
          ? "integration"
          : fraction >= 0.43
            ? "validation"
            : fraction >= 0.22
              ? "pilot"
              : "hypothesis";
      let effectsApplied = program.effectsApplied ?? false;
      if (complete) {
        phase = "complete";
        const maxRanks = researchMaxRanks(method);
        const prevRank =
          ranks[program.methodId] ??
          (unlocked.includes(program.methodId) ? 1 : 0);
        const alreadyDone = prevRank >= maxRanks;
        const nextRank = alreadyDone ? prevRank : prevRank + 1;
        if (!alreadyDone) {
          ranks[program.methodId] = nextRank;
          if (!unlocked.includes(program.methodId)) {
            unlocked.push(program.methodId);
          }
          effectsToApply.push(method);
        }
        effectsApplied = true;
        // Free the assignment so the same staffed pod can pick up the queue.
        // Do not zero the team — sequential work on Foundations depends on it.
        pods = pods.map((candidate) =>
          candidate.id === pod.id
            ? { ...candidate, assignmentId: null }
            : candidate,
        );
        completed.push({
          id: program.id,
          name: method.name,
          methodId: method.id,
          rank: nextRank,
          maxRanks,
          firstRank: prevRank === 0,
        });
      } else if (progress <= 0 && !fundedCalendarDay) {
        const reason = !prerequisitesMet
          ? `waiting on a prerequisite for ${method.name}`
          : exclusiveConflict
            ? `${method.name} conflicts with an integrated method`
            : !allocationBacked
              ? `${method.name} needs ${need.researchers}/${need.engineers}/${need.dataStaff} HQ staff (working ${seated.researchers}/${seated.engineers}/${seated.dataStaff})`
              : cashBefore <= 0
                ? `${method.name} needs cash runway`
                : compute <= 0
                  ? `${method.name} has no research PF — data, gyms, or safety work is using the pool`
                  : `${method.name} is not making progress`;
        stallMessage = stallMessage ?? reason;
      }
      return {
        ...program,
        phase,
        evidence,
        insightProgress,
        engineeringProgress,
        progressPfDays: nextProgress,
        daysSpent,
        effectsApplied,
      };
    },
  );

  const spent = Math.max(0, scheduled.player.cash - cash);
  let next: SimState = {
    ...scheduled,
    player: {
      ...scheduled.player,
      researchPrograms: programs,
      researchPods: pods,
      researchUnlocked: unlocked,
      researchRanks: ranks,
      researchCashBurnToday: spent,
    },
  };
  if (spent > 0) next = chargeExpense(next, spent, "research");
  for (const method of effectsToApply) {
    next = applyResearchEffectsToPlayer(next, method.effects);
  }
  for (const completion of completed) {
    next = {
      ...next,
      news: [
        completion.firstRank
          ? `Day ${scheduled.day}: ${completion.name} integrated by a research pod.`
          : `Day ${scheduled.day}: Rank ${completion.rank}/${completion.maxRanks} complete: ${completion.name}`,
        ...next.news,
      ].slice(0, 64),
    };
    next = withAlert(
      next,
      "info",
      completion.firstRank
        ? `${completion.name} integrated. Choose secrecy, publication, or licensing.`
        : `${completion.name} rank ${completion.rank}/${completion.maxRanks} complete.`,
    );
  }
  if (stallMessage && scheduled.day % 4 === 0) {
    next = withAlert(next, "warn", stallMessage);
  }
  next = appendFeedEvents(
    next,
    completed.map((completion) => ({
      id: `feed-research-program-complete-${completion.id}-${scheduled.day}`,
      day: scheduled.day,
      category: "models" as const,
      title: completion.firstRank
        ? `${completion.name} integrated by a research pod`
        : `Rank ${completion.rank}/${completion.maxRanks} complete: ${completion.name}`,
      body: completion.firstRank
        ? "The method cleared its evidence and engineering gates. Choose whether to keep it secret, publish it, or license it."
        : `Rank ${completion.rank}/${completion.maxRanks} complete`,
      source: scheduled.player.name,
      tone: "positive" as const,
      entityId: completion.id,
      kind: "research_program_completed",
    })),
  );
  next = assignQueuedPrograms(next, {
    announceBlocks: completed.length > 0 || scheduled.day % 4 === 0,
  });
  if (next.player.autoQueueResearch) {
    const lastCompleted = completed.at(-1)?.methodId;
    next = maybeAutoQueueResearchProgram(next, lastCompleted);
    next = assignQueuedPrograms(next, {
      announceBlocks: completed.length > 0 || scheduled.day % 4 === 0,
    });
  }
  return next;
}

export function publishMethod(state: SimState, programId: string): SimState {
  const program = (state.player.researchPrograms ?? []).find(
    (item) => item.id === programId,
  );
  if (!program || program.phase !== "complete")
    return withAlert(state, "warn", "Only completed methods can be published.");
  if (program.disclosure === "published") return state;
  const published = {
    ...state,
    player: {
      ...state.player,
      brandTrust: Math.min(100, state.player.brandTrust + 2.5),
      researchPrograms: (state.player.researchPrograms ?? []).map((item) =>
        item.id === programId
          ? { ...item, disclosure: "published" as const }
          : item,
      ),
      researchLeads: (state.player.researchLeads ?? []).map((lead) => {
        const pod = (state.player.researchPods ?? []).find(
          (item) => item.id === program.podId,
        );
        return lead.id === pod?.leadId
          ? { ...lead, reputation: Math.min(100, lead.reputation + 4) }
          : lead;
      }),
    },
    news: [
      `Day ${state.day}: Published ${getResearchNode(program.methodId).name}; recruiting reputation rises and rival diffusion begins.`,
      ...state.news,
    ].slice(0, 64),
  };
  return appendFeedEvents(published, [
    {
      id: `feed-research-program-publish-${program.id}-${state.day}`,
      day: state.day,
      category: "models",
      title: `${getResearchNode(program.methodId).name} published`,
      body: "The research method is public, improving brand trust and recruiting reputation while rivals can study the disclosure.",
      source: state.player.name,
      tone: "positive",
      entityId: program.id,
      kind: "research_program_published",
    },
  ]);
}

export function licenseMethod(state: SimState, programId: string): SimState {
  const program = (state.player.researchPrograms ?? []).find(
    (item) => item.id === programId,
  );
  if (!program || program.phase !== "complete")
    return withAlert(state, "warn", "Only completed methods can be licensed.");
  if (program.disclosure === "licensed") return state;
  const method = getResearchNode(program.methodId);
  const revenue = Math.round(1_000_000 + method.costPfDays * 85_000);
  const licensed = {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash + revenue,
      researchPrograms: (state.player.researchPrograms ?? []).map((item) =>
        item.id === programId
          ? { ...item, disclosure: "licensed" as const }
          : item,
      ),
    },
    news: [
      `Day ${state.day}: Licensed ${method.name} for $${(revenue / 1_000_000).toFixed(1)}M. Rival labs can still unlock it, but workaround and negotiation raise their research requirement by 45%.`,
      ...state.news,
    ].slice(0, 64),
  };
  return appendFeedEvents(licensed, [
    {
      id: `feed-research-program-license-${program.id}-${state.day}`,
      day: state.day,
      category: "models",
      title: `${method.name} licensed`,
      body: `The method generated $${(revenue / 1_000_000).toFixed(1)}M in licensing revenue; rivals face a higher research requirement to reproduce it.`,
      source: state.player.name,
      tone: "positive",
      entityId: program.id,
      kind: "research_program_licensed",
    },
  ]);
}

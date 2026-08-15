import { getResearchNode, researchBranchForNode } from "../balance/research";
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
  planResearchPath,
  researchCashPerPf,
  researchDaysTarget,
  researchLabMultiplier,
  researchPfTarget,
} from "./research";
import { playerStaff } from "./staff";

function withAlert(
  state: SimState,
  severity: "info" | "warn" | "danger",
  message: string,
): SimState {
  return {
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

function assignedPodStaff(
  pods: readonly ResearchPod[],
  exceptPodId?: string,
): ResearchPodStaffRequirements {
  return pods.reduce<ResearchPodStaffRequirements>(
    (total, pod) => {
      if (!pod.assignmentId || pod.id === exceptPodId) return total;
      total.researchers += Math.max(0, pod.researchers);
      total.engineers += Math.max(0, pod.engineers);
      total.dataStaff += Math.max(0, pod.dataStaff);
      return total;
    },
    { researchers: 0, engineers: 0, dataStaff: 0 },
  );
}

function allocatePodForMethod(
  state: SimState,
  pod: ResearchPod,
  methodId: string,
): { pod?: ResearchPod; reason?: string } {
  const need = researchPodStaffRequirements(methodId);
  const employed = playerStaff(state);
  const reserved = assignedPodStaff(state.player.researchPods ?? [], pod.id);
  const available = {
    researchers: Math.max(0, (employed.researcher ?? 0) - reserved.researchers),
    engineers: Math.max(0, (employed.engineer ?? 0) - reserved.engineers),
    dataStaff: Math.max(0, (employed.data_processor ?? 0) - reserved.dataStaff),
  };
  if (available.researchers < need.researchers) {
    return {
      reason: `Needs ${need.researchers} available researchers (have ${available.researchers}).`,
    };
  }
  if (available.engineers < need.engineers) {
    return {
      reason: `Needs ${need.engineers} available engineer${need.engineers === 1 ? "" : "s"} (have ${available.engineers}).`,
    };
  }
  if (available.dataStaff < need.dataStaff) {
    return {
      reason: `Needs ${need.dataStaff} available data specialist${need.dataStaff === 1 ? "" : "s"} (have ${available.dataStaff}).`,
    };
  }
  // Existing allocations are preferences, never imaginary headcount. Preserve
  // valid surplus staff but cap every role at what the lab actually employs.
  return {
    pod: {
      ...pod,
      researchers: Math.min(
        available.researchers,
        Math.max(need.researchers, pod.researchers),
      ),
      engineers: Math.min(
        available.engineers,
        Math.max(need.engineers, pod.engineers),
      ),
      dataStaff: Math.min(
        available.dataStaff,
        Math.max(need.dataStaff, pod.dataStaff),
      ),
    },
  };
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
  if (state.player.researchUnlocked.includes(methodId)) {
    return withAlert(state, "warn", `${method.name} is already integrated.`);
  }
  if (
    (state.player.researchPrograms ?? []).some(
      (program) =>
        program.methodId === methodId && program.phase !== "complete",
    )
  ) {
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
    computeSnapshot(state).pools.research * researchPoolForTech(state);
  if (researchPf < 0.05) {
    return withAlert(
      state,
      "warn",
      "Raise Research allocation — the pod needs real PF in the research pool.",
    );
  }

  const program: ResearchProgram = {
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
  return {
    ...state,
    player: {
      ...state.player,
      researchPrograms: [...(state.player.researchPrograms ?? []), program],
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
  if (state.player.researchUnlocked.includes(methodId)) return state;
  const programQueue = state.player.researchProgramQueue ?? [];
  if (programQueue.includes(methodId)) return state;
  const activeMethods = (state.player.researchPrograms ?? [])
    .filter((program) => program.phase !== "complete")
    .map((program) => program.methodId);
  if (activeMethods.includes(methodId)) return state;
  const conflict = methodConflictReason(state, method);
  if (conflict) return withAlert(state, "warn", conflict);
  const path = planResearchPath(
    state.player.researchUnlocked,
    [...activeMethods, ...programQueue],
    methodId,
  );
  if (path.reason) return withAlert(state, "warn", path.reason);
  if (programQueue.length + path.nodeIds.length > 12) {
    return withAlert(
      state,
      "warn",
      `Research path needs ${path.nodeIds.length} queue slots (12 max).`,
    );
  }
  return {
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
}

export function dequeueResearchProgram(
  state: SimState,
  methodId: string,
): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      researchProgramQueue: (state.player.researchProgramQueue ?? []).filter(
        (candidate) => candidate !== methodId,
      ),
    },
  };
}

function assignQueuedPrograms(state: SimState): SimState {
  let next = state;
  let changed = false;
  while (true) {
    const pod = (next.player.researchPods ?? []).find(
      (candidate) => !candidate.assignmentId,
    );
    if (!pod) break;
    const methodId = (next.player.researchProgramQueue ?? []).find(
      (candidate) => {
        const method = getResearchNode(candidate);
        return method.prereqs.every((prerequisite) =>
          next.player.researchUnlocked.includes(prerequisite),
        );
      },
    );
    if (!methodId) break;
    const before = (next.player.researchPrograms ?? []).length;
    next = startResearchProgram(next, methodId, pod.id);
    if ((next.player.researchPrograms ?? []).length === before) break;
    next = {
      ...next,
      player: {
        ...next.player,
        researchProgramQueue: (next.player.researchProgramQueue ?? []).filter(
          (candidate) => candidate !== methodId,
        ),
      },
    };
    changed = true;
  }
  return changed ? next : state;
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

export function tickResearchPrograms(state: SimState): SimState {
  // An in-flight legacy project retains authority until it completes. This
  // guard also protects direct system callers outside the daily tick.
  if (state.player.activeResearch) return state;
  const scheduled = assignQueuedPrograms(state);
  if (scheduled !== state) return tickResearchPrograms(scheduled);
  const active = (state.player.researchPrograms ?? []).filter(
    (program) => program.phase !== "complete",
  );
  if (active.length === 0) {
    return (state.player.researchCashBurnToday ?? 0) === 0
      ? state
      : {
          ...state,
          player: { ...state.player, researchCashBurnToday: 0 },
        };
  }
  const snapshot = computeSnapshot(state);
  const researchPool = snapshot.pools.research * researchPoolForTech(state);
  const totalComputeShare = active.reduce(
    (sum, program) => sum + Math.max(0.05, Math.min(0.8, program.computeShare)),
    0,
  );
  let cash = state.player.cash;
  let unlocked = [...state.player.researchUnlocked];
  let pods = [...(state.player.researchPods ?? [])];
  const completed: Array<{ name: string; methodId: string }> = [];
  const effectsToApply: ResearchNodeDef[] = [];
  const employed = playerStaff(state);
  const assigned = assignedPodStaff(pods);
  const allAllocationsBacked =
    assigned.researchers <= (employed.researcher ?? 0) &&
    assigned.engineers <= (employed.engineer ?? 0) &&
    assigned.dataStaff <= (employed.data_processor ?? 0);
  const programs = (state.player.researchPrograms ?? []).map(
    (program): ResearchProgram => {
      if (program.phase === "complete") return program;
      const pod = pods.find((candidate) => candidate.id === program.podId);
      const lead = (state.player.researchLeads ?? []).find(
        (candidate) => candidate.id === pod?.leadId,
      );
      if (!pod || !lead) return program;
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
      const allocationBacked =
        allAllocationsBacked &&
        pod.assignmentId === program.id &&
        pod.researchers >= need.researchers &&
        pod.engineers >= need.engineers &&
        pod.dataStaff >= need.dataStaff;
      const headcount = pod.researchers + pod.engineers + pod.dataStaff;
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
          researchers: pod.researchers,
          engineers: pod.engineers,
          researchPf: compute,
          nodeId: program.methodId,
          labResearchMult:
            researchLabMultiplier(state) *
            (0.8 + leadSkill * 0.35) *
            coordination,
        });
        progress = Math.min(progress, Math.max(0, target - currentProgress));
        const cashRate = researchCashPerPf(method);
        if (cashRate > 0) progress = Math.min(progress, cashBefore / cashRate);
        cash -= progress * cashRate;
      }
      const nextProgress = Math.min(target, currentProgress + progress);
      const fundedCalendarDay =
        allocationBacked &&
        prerequisitesMet &&
        !exclusiveConflict &&
        compute > 0 &&
        cashBefore > 0 &&
        (progress > 0 || currentProgress + 1e-9 >= target);
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
          state.day,
          "pilot",
          0.45 + leadSkill * 0.3,
        );
      }
      if (fraction >= 0.68) {
        evidence = addEvidence(
          evidence,
          program,
          state.day,
          "training",
          0.5 + leadSkill * 0.35,
        );
      }
      const daysTarget = researchDaysTarget(method, pod.researchers);
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
        const newlyUnlocked = !unlocked.includes(program.methodId);
        if (newlyUnlocked) {
          unlocked.push(program.methodId);
          effectsToApply.push(method);
        }
        effectsApplied = true;
        pods = pods.map((candidate) =>
          candidate.id === pod.id
            ? {
                ...candidate,
                researchers: 0,
                engineers: 0,
                dataStaff: 0,
                assignmentId: null,
              }
            : candidate,
        );
        completed.push({ name: method.name, methodId: method.id });
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

  const spent = Math.max(0, state.player.cash - cash);
  let next: SimState = {
    ...state,
    player: {
      ...state.player,
      researchPrograms: programs,
      researchPods: pods,
      researchUnlocked: unlocked,
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
        `Day ${state.day}: ${completion.name} integrated by a research pod.`,
        ...next.news,
      ].slice(0, 64),
    };
    next = withAlert(
      next,
      "info",
      `${completion.name} integrated. Choose secrecy, publication, or licensing.`,
    );
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
  return {
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
  return {
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
}

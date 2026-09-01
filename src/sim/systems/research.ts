import { ECONOMY } from "../balance/economy";
import { getResearchNode, RESEARCH_NODES } from "../balance/research";
import type { ResearchEffects, ResearchNodeDef, SimState } from "../types";
import { computeSnapshot } from "./compute";
import { researchPoolForTech } from "./data";
import { chargeExpense } from "./financeLedger";
import { playerStaff, researchTalentMultFromCount } from "./staff";
import { facilityAnchorTiles } from "./worldAccess";
import { appendFeedEvents } from "./feed";

/** Longest prereq chain length (0 = root). */
export function nodePrereqDepth(
  nodeId: string,
  seen = new Set<string>(),
): number {
  if (seen.has(nodeId)) return 0;
  seen.add(nodeId);
  const node = getResearchNode(nodeId);
  if (!node.prereqs.length) return 0;
  return 1 + Math.max(...node.prereqs.map((p) => nodePrereqDepth(p, seen)));
}

/**
 * Researchers required to start / progress a node.
 * Early tree = 1; deep frontier often 12–24+.
 */
export function minResearchersForNode(nodeId: string): number {
  const node = getResearchNode(nodeId);
  if (node.minResearchers != null) return Math.max(1, node.minResearchers);
  const depth = nodePrereqDepth(nodeId);
  // depth 0→1, 1→2, 2→3, 3→5, 4→8, 5→12, 6→16, 7→20, 8→24
  const table = [1, 2, 3, 5, 8, 12, 16, 20, 24, 28, 32];
  return table[Math.min(depth, table.length - 1)]!;
}

/** Pure PF-day target (player + rival). */
export function researchPfTargetForNode(
  node: ResearchNodeDef,
  researchCostMult = 1,
): number {
  const mult =
    (ECONOMY.researchPfCostMult ?? 2.6) * Math.max(0.4, researchCostMult);
  const depth = nodePrereqDepth(node.id);
  // Late tree is much harder (depth 0 = 1×, depth 5 ≈ 2.1×, depth 8 ≈ 2.76×)
  const depthMult = 1 + depth * 0.22;
  return node.costPfDays * mult * depthMult;
}

/** Omit or 1 = one-shot. */
export function researchMaxRanks(node: ResearchNodeDef): number {
  return Math.max(1, node.maxRanks ?? 1);
}

/** Completed ranks. Missing ranks + unlocked id is treated as 1. */
export function researchRank(state: SimState, id: string): number {
  const recorded = state.player.researchRanks?.[id];
  if (recorded != null && Number.isFinite(recorded)) return recorded;
  return state.player.researchUnlocked.includes(id) ? 1 : 0;
}

export function researchFullyDone(state: SimState, id: string): boolean {
  return researchRank(state, id) >= researchMaxRanks(getResearchNode(id));
}

function rankFromUnlocks(
  unlocked: readonly string[],
  ranks: Record<string, number> | undefined,
  id: string,
): number {
  const recorded = ranks?.[id];
  if (recorded != null && Number.isFinite(recorded)) return recorded;
  return unlocked.includes(id) ? 1 : 0;
}

function nodeIsFullyDone(
  unlocked: readonly string[],
  ranks: Record<string, number> | undefined,
  id: string,
): boolean {
  return rankFromUnlocks(unlocked, ranks, id) >= researchMaxRanks(getResearchNode(id));
}

function hasAssignedInFlightProgram(state: SimState): boolean {
  return (state.player.researchPrograms ?? []).some((program) => {
    if (program.phase === "complete") return false;
    const pod = (state.player.researchPods ?? []).find(
      (candidate) => candidate.id === program.podId,
    );
    return pod?.assignmentId === program.id;
  });
}

/**
 * Next catalog id to auto-queue, or null when auto-queue is off / busy / empty.
 * Never returns a locked deep target — only currently available methods.
 */
export function nextAutoQueueResearchId(
  state: SimState,
  lastCompletedNodeId?: string,
): string | null {
  if (!state.player.autoQueueResearch) return null;
  if (state.player.activeResearch) return null;
  if (hasAssignedInFlightProgram(state)) return null;
  if (state.player.researchQueue.length > 0) return null;
  if ((state.player.researchProgramQueue ?? []).length > 0) return null;

  const available = RESEARCH_NODES.filter((node) => {
    if (researchFullyDone(state, node.id)) return false;
    if (
      !node.prereqs.every((prereq) =>
        state.player.researchUnlocked.includes(prereq),
      )
    ) {
      return false;
    }
    if (
      node.exclusiveWith?.some((other) =>
        state.player.researchUnlocked.includes(other),
      )
    ) {
      return false;
    }
    return true;
  });

  let candidates = available.filter((node) => researchMaxRanks(node) === 1);
  if (candidates.length === 0) {
    candidates = available.filter(
      (node) => researchRank(state, node.id) < researchMaxRanks(node),
    );
  }
  if (candidates.length === 0) return null;

  if (lastCompletedNodeId) {
    try {
      const trunk = getResearchNode(lastCompletedNodeId).trunk;
      const sameTrunk = candidates.filter((node) => node.trunk === trunk);
      if (sameTrunk.length > 0) candidates = sameTrunk;
    } catch {
      // Unknown last node — keep the full candidate set.
    }
  }

  candidates.sort((a, b) => {
    const pfDelta = researchPfTarget(state, a) - researchPfTarget(state, b);
    if (pfDelta !== 0) return pfDelta;
    return a.id.localeCompare(b.id);
  });
  return candidates[0]?.id ?? null;
}

/** Enqueue at most one available method onto the legacy research queue. */
export function maybeAutoQueueResearch(
  state: SimState,
  lastCompletedNodeId?: string,
): SimState {
  const id = nextAutoQueueResearchId(state, lastCompletedNodeId);
  if (!id) return state;
  return enqueueResearch(state, id);
}

/** Effective PF-days target for a node (catalog × economy × config × depth). */
export function researchPfTarget(
  state: SimState,
  node: ResearchNodeDef,
): number {
  const base = researchPfTargetForNode(node, state.config?.researchCostMult ?? 1);
  if (researchMaxRanks(node) <= 1) return base;
  return base * (1 + 0.2 * researchRank(state, node.id));
}

/**
 * Calendar floor days for a node.
 * Deeper nodes take longer; extra researchers beyond the minimum compress the floor
 * so staffing + compute both make research finish sooner.
 */
export function researchDaysTarget(
  node: ResearchNodeDef,
  researchers = 0,
): number {
  const depth = nodePrereqDepth(node.id);
  const depthDays = 1 + depth * 0.12;
  let days = node.daysMin * (ECONOMY.researchDaysMult ?? 1.35) * depthDays;
  const need = minResearchersForNode(node.id);
  const surplus = Math.max(0, researchers - need);
  // Each surplus researcher shaves ~6% of calendar (cap 50% cut)
  const compress = Math.min(0.5, surplus * 0.06);
  days *= 1 - compress;
  return Math.max(1, Math.ceil(days));
}

/**
 * Shared daily research progress for any lab (player or rival).
 *
 *   progress = researchPf × researcherMult × engineerMult × labMult
 *
 * - researchPf scales with fleet flops × research allocation (linear)
 * - researcherMult scales strongly with headcount (0 if none)
 * - engineers / labs give smaller bonuses
 *
 * Returns 0 if researchers < 1 or below node requirement.
 */
export function labResearchDayProgress(opts: {
  researchers: number;
  engineers?: number;
  researchPf: number;
  nodeId: string;
  labResearchMult?: number;
}): number {
  const need = minResearchersForNode(opts.nodeId);
  const researchers = opts.researchers ?? 0;
  if (researchers < 1 || researchers < need) return 0;
  const pf = Math.max(0, opts.researchPf);
  if (pf <= 0) return 0;
  const talentMult = researchTalentMultFromCount(researchers);
  const eng = opts.engineers ?? 0;
  // Engineers help execution; soft cap so researchers/compute stay primary levers
  const engMult = 1 + Math.min(0.25, eng * 0.015);
  const labMult = Math.min(2.4, Math.max(0.5, opts.labResearchMult ?? 1));
  return pf * talentMult * engMult * labMult;
}

/** Estimated PF-days of progress per day for UI (player snapshot). */
export function estimateResearchRate(
  state: SimState,
  nodeId: string,
): { pfPerDay: number; researchers: number; researchPf: number } {
  const staff = playerStaff(state);
  const researchers = staff.researcher ?? 0;
  const engineers = staff.engineer ?? 0;
  const snap = computeSnapshot(state);
  const techShare = researchPoolForTech(state);
  const labMult = researchLabMultiplier(state);
  const researchPf = snap.pools.research * techShare;
  const pfPerDay = labResearchDayProgress({
    researchers,
    engineers,
    researchPf,
    nodeId,
    labResearchMult: labMult,
  });
  return { pfPerDay, researchers, researchPf };
}

/** Completed research facilities multiply effective PF for either player controller. */
export function researchLabMultiplier(state: SimState): number {
  let labMult = 1;
  for (const t of facilityAnchorTiles(state, { ownerId: "player" })) {
    if (t.kind === "lab" && t.buildingProgress >= t.buildingTarget) {
      labMult += 0.11 * Math.max(1, t.level);
    }
  }
  return labMult;
}

/** Can this lab start/progress a node given unlocks + researchers? */
export function canLabResearchNode(
  unlocked: string[],
  researchers: number,
  nodeId: string,
  ranks?: Record<string, number>,
): { ok: boolean; reason?: string } {
  const node = getResearchNode(nodeId);
  const done =
    ranks != null
      ? nodeIsFullyDone(unlocked, ranks, nodeId)
      : unlocked.includes(nodeId);
  if (done) return { ok: false, reason: "Already unlocked" };
  if (researchers < 1) {
    return { ok: false, reason: "Need at least 1 researcher" };
  }
  for (const p of node.prereqs) {
    if (!unlocked.includes(p)) {
      return { ok: false, reason: `Requires ${getResearchNode(p).name}` };
    }
  }
  if (node.exclusiveWith) {
    for (const e of node.exclusiveWith) {
      if (unlocked.includes(e)) {
        return {
          ok: false,
          reason: `Conflicts with ${getResearchNode(e).name}`,
        };
      }
    }
  }
  const need = minResearchersForNode(nodeId);
  if (researchers < need) {
    return {
      ok: false,
      reason: `Needs ${need} researchers (have ${researchers})`,
    };
  }
  return { ok: true };
}

/** Dense transformers are always available (starter unlock). */
export const STARTER_RESEARCH: string[] = ["dense_basics"];

/** Cash per research PF-day of progress for this node. */
export function researchCashPerPf(node: ResearchNodeDef): number {
  return (ECONOMY.researchCashPerPfDay ?? 22_000) * (node.cashBurnMult ?? 1);
}

/** Rough total cash if completed at catalog PF target. */
export function researchCashEstimate(
  state: SimState,
  node: ResearchNodeDef,
): number {
  return researchPfTarget(state, node) * researchCashPerPf(node);
}

const MAX_QUEUE = 12;

export interface ResearchPathPlan {
  nodeIds: string[];
  reason?: string;
}

/**
 * Return the minimal topological path needed to reach a research target.
 * Already unlocked or scheduled nodes satisfy dependencies, so selecting a
 * deep locked method never duplicates work already owned by a pod or queue.
 */
export function planResearchPath(
  unlocked: readonly string[],
  scheduled: readonly string[],
  targetId: string,
  ranks?: Record<string, number>,
): ResearchPathPlan {
  const unlockedSet = new Set(unlocked);
  const scheduledSet = new Set(scheduled);
  const visiting = new Set<string>();
  const additions: string[] = [];

  const visit = (nodeId: string, asPrereq: boolean): string | undefined => {
    if (scheduledSet.has(nodeId)) return undefined;
    if (asPrereq && unlockedSet.has(nodeId)) return undefined;
    if (!asPrereq && nodeIsFullyDone(unlocked, ranks, nodeId)) return undefined;
    if (visiting.has(nodeId)) return `Research dependency cycle at ${nodeId}`;

    let node: ResearchNodeDef;
    try {
      node = getResearchNode(nodeId);
    } catch {
      return `Unknown research method: ${nodeId}`;
    }

    const conflict = node.exclusiveWith?.find(
      (id) => unlockedSet.has(id) || scheduledSet.has(id),
    );
    if (conflict) return `Conflicts with ${getResearchNode(conflict).name}`;

    visiting.add(nodeId);
    for (const prerequisite of node.prereqs) {
      const reason = visit(prerequisite, true);
      if (reason) return reason;
    }
    visiting.delete(nodeId);
    scheduledSet.add(nodeId);
    additions.push(nodeId);
    return undefined;
  };

  const reason = visit(targetId, false);
  return reason ? { nodeIds: [], reason } : { nodeIds: additions };
}

export type NodeVisualStatus =
  "done" | "active" | "queued" | "available" | "locked" | "blocked";

export function nodeVisualStatus(
  state: SimState,
  nodeId: string,
): NodeVisualStatus {
  if (state.player.activeResearch?.nodeId === nodeId) return "active";
  if (state.player.researchQueue.includes(nodeId)) return "queued";
  if ((state.player.researchProgramQueue ?? []).includes(nodeId)) return "queued";
  if (researchFullyDone(state, nodeId)) return "done";
  if (researchRank(state, nodeId) > 0) return "available";
  const gate = prereqGate(state, nodeId);
  if (!gate.ok) return gate.blocked ? "blocked" : "locked";
  return "available";
}

function prereqGate(
  state: SimState,
  nodeId: string,
): { ok: boolean; reason?: string; blocked?: boolean } {
  const node = getResearchNode(nodeId);
  for (const p of node.prereqs) {
    if (!state.player.researchUnlocked.includes(p)) {
      return { ok: false, reason: `Requires ${getResearchNode(p).name}` };
    }
  }
  if (node.exclusiveWith) {
    for (const e of node.exclusiveWith) {
      if (state.player.researchUnlocked.includes(e)) {
        return {
          ok: false,
          reason: `Conflicts with ${getResearchNode(e).name}`,
          blocked: true,
        };
      }
    }
  }
  const need = minResearchersForNode(nodeId);
  const have = playerStaff(state).researcher ?? 0;
  if (have < need) {
    return {
      ok: false,
      reason: `Needs ${need} researcher${need === 1 ? "" : "s"} (you have ${have})`,
    };
  }
  return { ok: true };
}

/** Can this node be researched eventually / enqueued? */
export function canEnqueue(
  state: SimState,
  nodeId: string,
): { ok: boolean; reason?: string } {
  if (researchFullyDone(state, nodeId)) {
    return { ok: false, reason: "Already unlocked" };
  }
  if (state.player.activeResearch?.nodeId === nodeId) {
    return { ok: false, reason: "Already in progress" };
  }
  if (state.player.researchQueue.includes(nodeId)) {
    return { ok: false, reason: "Already queued" };
  }
  if (state.player.researchQueue.length >= MAX_QUEUE) {
    return { ok: false, reason: `Queue full (${MAX_QUEUE})` };
  }
  const node = getResearchNode(nodeId);
  if (node.exclusiveWith) {
    for (const e of node.exclusiveWith) {
      if (
        state.player.researchUnlocked.includes(e) ||
        state.player.researchQueue.includes(e) ||
        state.player.activeResearch?.nodeId === e
      ) {
        return {
          ok: false,
          reason: `Conflicts with ${getResearchNode(e).name}`,
        };
      }
    }
  }
  // Allow queue even if prereqs not met yet (will wait)
  return { ok: true };
}

export function canStartNow(
  state: SimState,
  nodeId: string,
): { ok: boolean; reason?: string } {
  if (researchFullyDone(state, nodeId)) {
    return { ok: false, reason: "Already unlocked" };
  }
  if (state.player.activeResearch) {
    return { ok: false, reason: "Research already in progress" };
  }
  if (
    (state.player.researchPrograms ?? []).some((program) => {
      if (program.phase === "complete") return false;
      const pod = (state.player.researchPods ?? []).find(
        (candidate) => candidate.id === program.podId,
      );
      return pod?.assignmentId === program.id;
    })
  ) {
    return {
      ok: false,
      reason: "A research pod program already has authority",
    };
  }
  const researchers = playerStaff(state).researcher ?? 0;
  if (researchers < 1) {
    return {
      ok: false,
      reason: "Hire at least 1 researcher at an HQ before starting research",
    };
  }
  const gate = prereqGate(state, nodeId);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const floor = ECONOMY.researchStartCashFloor ?? 250_000;
  if (state.player.cash < floor) {
    return {
      ok: false,
      reason: `Need ~$${Math.round(floor / 1000)}k cash runway to open a research project`,
    };
  }
  // Need research pool PF or the project starves immediately
  const snap = computeSnapshot(state);
  if (snap.pools.research < 0.05) {
    return {
      ok: false,
      reason: "Raise Research allocation — need compute in the research pool",
    };
  }
  return { ok: true };
}

/** Start immediately if free, otherwise enqueue. */
export function startResearch(state: SimState, nodeId: string): SimState {
  if (researchFullyDone(state, nodeId)) return state;

  // If idle and prereqs met → start now
  if (!state.player.activeResearch) {
    const start = canStartNow(state, nodeId);
    if (start.ok) {
      return beginActive(state, nodeId);
    }
  }

  return enqueueResearch(state, nodeId);
}

export function enqueueResearch(state: SimState, nodeId: string): SimState {
  const check = canEnqueue(state, nodeId);
  if (!check.ok) {
    return {
      ...state,
      alerts: [
        {
          id: `q-fail-${state.day}-${nodeId}`,
          day: state.day,
          severity: "warn" as const,
          message: check.reason ?? "Cannot queue",
        },
        ...state.alerts,
      ].slice(0, 40),
    };
  }

  const scheduled = [
    ...state.player.researchQueue,
    ...(state.player.activeResearch
      ? [state.player.activeResearch.nodeId]
      : []),
  ];
  const plan = planResearchPath(
    state.player.researchUnlocked,
    scheduled,
    nodeId,
    state.player.researchRanks,
  );
  if (plan.reason) {
    return {
      ...state,
      alerts: [
        {
          id: `q-path-fail-${state.day}-${nodeId}`,
          day: state.day,
          severity: "warn" as const,
          message: plan.reason,
        },
        ...state.alerts,
      ].slice(0, 40),
    };
  }

  let next = state;
  let remaining = plan.nodeIds;
  const first = remaining[0];
  if (!state.player.activeResearch && first && canStartNow(state, first).ok) {
    next = beginActive(state, first);
    remaining = remaining.slice(1);
  }
  if (next.player.researchQueue.length + remaining.length > MAX_QUEUE) {
    return {
      ...state,
      alerts: [
        {
          id: `q-path-full-${state.day}-${nodeId}`,
          day: state.day,
          severity: "warn" as const,
          message: `Research path needs ${remaining.length} queue slots (${MAX_QUEUE} max)`,
        },
        ...state.alerts,
      ].slice(0, 40),
    };
  }

  return {
    ...next,
    player: {
      ...next.player,
      researchQueue: [...next.player.researchQueue, ...remaining],
    },
    alerts: [
      {
        id: `q-add-${state.day}-${nodeId}`,
        day: state.day,
        severity: "info" as const,
        message:
          plan.nodeIds.length > 1
            ? `Queued ${plan.nodeIds.length}-method path to ${getResearchNode(nodeId).name}`
            : `Queued: ${getResearchNode(nodeId).name}`,
      },
      ...next.alerts,
    ].slice(0, 40),
  };
}

export function dequeueResearch(state: SimState, nodeId: string): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      researchQueue: state.player.researchQueue.filter((id) => id !== nodeId),
    },
  };
}

export function moveQueue(
  state: SimState,
  nodeId: string,
  dir: -1 | 1,
): SimState {
  const q = [...state.player.researchQueue];
  const i = q.indexOf(nodeId);
  if (i < 0) return state;
  const j = i + dir;
  if (j < 0 || j >= q.length) return state;
  [q[i], q[j]] = [q[j]!, q[i]!];
  return { ...state, player: { ...state.player, researchQueue: q } };
}

export function cancelActiveResearch(state: SimState): SimState {
  if (!state.player.activeResearch) return state;
  const name = getResearchNode(state.player.activeResearch.nodeId).name;
  let s: SimState = {
    ...state,
    player: { ...state.player, activeResearch: null },
    alerts: [
      {
        id: `res-cancel-${state.day}`,
        day: state.day,
        severity: "warn" as const,
        message: `Cancelled research: ${name} (progress lost)`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
  s = tryStartFromQueue(s);
  return s;
}

function beginActive(state: SimState, nodeId: string): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      activeResearch: { nodeId, progressPfDays: 0, daysSpent: 0 },
      researchQueue: state.player.researchQueue.filter((id) => id !== nodeId),
    },
    alerts: [
      {
        id: `res-start-${state.day}-${nodeId}`,
        day: state.day,
        severity: "info" as const,
        message: `Research started: ${getResearchNode(nodeId).name}`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

function tryStartFromQueue(state: SimState): SimState {
  if (state.player.activeResearch) return state;
  const q = [...state.player.researchQueue];
  if (q.length === 0) return state;

  // Find first queue item whose prereqs are met
  for (let i = 0; i < q.length; i++) {
    const id = q[i]!;
    const gate = prereqGate(state, id);
    if (gate.blocked) {
      // drop permanently blocked
      q.splice(i, 1);
      i--;
      continue;
    }
    if (gate.ok) {
      return beginActive(
        { ...state, player: { ...state.player, researchQueue: q } },
        id,
      );
    }
  }
  return { ...state, player: { ...state.player, researchQueue: q } };
}

/**
 * Apply research unlock effects to any lab-like stats (player or rival).
 * Shared so rivals get the same util/serve/train/data lifts as the player.
 */
export function applyResearchEffectsToLab<
  T extends {
    utilCap: number;
    servingEfficiency: number;
    brandTrust: number;
    dataQuality?: number;
    trainEfficiency?: number;
    pue?: number;
  },
>(lab: T, effects: ResearchEffects): T {
  const p = { ...lab };
  if (effects.utilCap) p.utilCap = Math.min(0.98, p.utilCap + effects.utilCap);
  if (effects.servingEfficiency)
    p.servingEfficiency = Math.min(
      ECONOMY.maxServingEfficiency,
      p.servingEfficiency + effects.servingEfficiency,
    );
  if (effects.trainEfficiency != null && p.trainEfficiency != null) {
    p.trainEfficiency = Math.min(
      1.5,
      p.trainEfficiency + effects.trainEfficiency,
    );
  }
  if (effects.energyPue != null && p.pue != null) {
    p.pue = Math.max(1.05, p.pue + effects.energyPue);
  }
  if (effects.safetyBonus) {
    p.brandTrust = Math.min(100, p.brandTrust + effects.safetyBonus * 0.3);
  }
  if (p.dataQuality != null) {
    if (effects.rlhfQuality) {
      p.dataQuality = Math.min(2.8, p.dataQuality + effects.rlhfQuality);
    }
    if (effects.dataFlywheel) {
      p.dataQuality = Math.min(
        2.8,
        p.dataQuality + effects.dataFlywheel * 0.15,
      );
    }
  }
  return p;
}

/** Apply stored lab-stat effects through the single legacy/pod completion path. */
export function applyResearchEffectsToPlayer(
  state: SimState,
  effects: ResearchEffects,
): SimState {
  const p = applyResearchEffectsToLab(
    {
      ...state.player,
      trainEfficiency: state.player.trainEfficiency,
      pue: state.player.pue,
      dataQuality: state.player.dataQuality,
    },
    effects,
  );
  return { ...state, player: { ...state.player, ...p } };
}

function accumulateEffects(acc: ResearchEffects, e: ResearchEffects): void {
  if (e.utilCap) acc.utilCap = (acc.utilCap ?? 0) + e.utilCap;
  if (e.servingEfficiency)
    acc.servingEfficiency = (acc.servingEfficiency ?? 0) + e.servingEfficiency;
  if (e.trainEfficiency)
    acc.trainEfficiency = (acc.trainEfficiency ?? 0) + e.trainEfficiency;
  if (e.energyPue) acc.energyPue = (acc.energyPue ?? 0) + e.energyPue;
  if (e.capabilityBonus)
    acc.capabilityBonus = (acc.capabilityBonus ?? 0) + e.capabilityBonus;
  if (e.moeInferMult)
    acc.moeInferMult = (acc.moeInferMult ?? 1) * e.moeInferMult;
  if (e.denseInferMult)
    acc.denseInferMult = (acc.denseInferMult ?? 1) * e.denseInferMult;
  if (e.safetyBonus) acc.safetyBonus = (acc.safetyBonus ?? 0) + e.safetyBonus;
  if (e.rlhfQuality) acc.rlhfQuality = (acc.rlhfQuality ?? 0) + e.rlhfQuality;
  if (e.chipDiscount) acc.chipDiscount = (acc.chipDiscount ?? 0) + e.chipDiscount;
  if (e.fabSpeed) acc.fabSpeed = (acc.fabSpeed ?? 0) + e.fabSpeed;
  if (e.talentAttract)
    acc.talentAttract = (acc.talentAttract ?? 0) + e.talentAttract;
  if (e.dataFlywheel) acc.dataFlywheel = (acc.dataFlywheel ?? 0) + e.dataFlywheel;
  if (e.unlockFamily) acc.unlockFamily = e.unlockFamily;
  if (e.trainingBreakthroughBias)
    acc.trainingBreakthroughBias =
      (acc.trainingBreakthroughBias ?? 0) + e.trainingBreakthroughBias;
  if (e.trainingStumbleRisk)
    acc.trainingStumbleRisk =
      (acc.trainingStumbleRisk ?? 0) + e.trainingStumbleRisk;
  if (e.trainingSafetyPenalty)
    acc.trainingSafetyPenalty =
      (acc.trainingSafetyPenalty ?? 0) + e.trainingSafetyPenalty;
  if (e.overtrainCapBonus)
    acc.overtrainCapBonus =
      (acc.overtrainCapBonus ?? 0) + e.overtrainCapBonus;
  if (e.unlockClosedLoopResearch) acc.unlockClosedLoopResearch = true;
  if (e.gymQualityBonus)
    acc.gymQualityBonus = (acc.gymQualityBonus ?? 0) + e.gymQualityBonus;
  if (e.hostingOpexDiscount)
    acc.hostingOpexDiscount =
      (acc.hostingOpexDiscount ?? 0) + e.hostingOpexDiscount;
}

export function aggregateEffects(
  unlocked: string[],
  ranks?: Record<string, number>,
): ResearchEffects {
  const acc: ResearchEffects = {};
  for (const id of unlocked) {
    const e = getResearchNode(id).effects;
    const times = Math.max(0, Math.floor(ranks?.[id] ?? 1));
    for (let i = 0; i < times; i++) accumulateEffects(acc, e);
  }
  return acc;
}

export function tickResearch(state: SimState): SimState {
  // Pod programs and the legacy single-worker controller are mutually
  // exclusive authorities. Direct callers get the same protection as tickDay.
  if (
    !state.player.activeResearch &&
    (state.player.researchPrograms ?? []).some((program) => {
      if (program.phase === "complete") return false;
      const pod = (state.player.researchPods ?? []).find(
        (candidate) => candidate.id === program.podId,
      );
      return pod?.assignmentId === program.id;
    })
  ) {
    return state;
  }
  let s = state;

  // If idle, pull from queue, then auto-queue one available method.
  if (!s.player.activeResearch) {
    s = tryStartFromQueue(s);
  }
  if (!s.player.activeResearch && s.player.autoQueueResearch) {
    s = maybeAutoQueueResearch(s);
    if (!s.player.activeResearch) s = tryStartFromQueue(s);
  }

  const job = s.player.activeResearch;
  if (!job) {
    return {
      ...s,
      player: { ...s.player, researchCashBurnToday: 0 },
    };
  }

  const snap = computeSnapshot(s);
  const node = getResearchNode(job.nodeId);
  const costTarget = researchPfTarget(s, node);
  // Researchers + engineers + research PF (shared formula with rivals)
  const researchers = playerStaff(s).researcher ?? 0;
  const engineers = playerStaff(s).engineer ?? 0;
  const needR = minResearchersForNode(job.nodeId);
  // Research labs accelerate PF progress (campus bonus)
  const labMult = researchLabMultiplier(s);
  // Data-gen jobs reserve a share of research PF — tech research slows when synthesizing
  const techShare = researchPoolForTech(s);
  let progress = labResearchDayProgress({
    researchers,
    engineers,
    researchPf: snap.pools.research * techShare,
    nodeId: job.nodeId,
    labResearchMult: labMult,
  });
  // Fast fleets can satisfy the PF requirement before the calendar floor.
  // Never burn cash for progress beyond the work the project still needs.
  progress = Math.min(progress, Math.max(0, costTarget - job.progressPfDays));

  // Hard stall messaging
  if (
    progress <= 0 &&
    (researchers < 1 || researchers < needR) &&
    s.day % 4 === 0
  ) {
    s = {
      ...s,
      alerts: [
        {
          id: `res-staff-${s.day}`,
          day: s.day,
          severity: "warn" as const,
          message:
            researchers < 1
              ? `Research stalled on ${node.name} — hire researchers at an HQ.`
              : `Research stalled on ${node.name} — needs ${needR} researchers (you have ${researchers}).`,
        },
        ...s.alerts,
      ].slice(0, 40),
    };
  }

  // Cash gate: research burns $ per PF-day of progress. No cash → stall.
  const cashRate = researchCashPerPf(node);
  let cashBurn = progress * cashRate;
  if (cashBurn > s.player.cash && cashRate > 0) {
    const affordable = s.player.cash / cashRate;
    progress = Math.max(0, affordable);
    cashBurn = progress * cashRate;
    if (progress < 1e-6) {
      return {
        ...s,
        player: {
          ...s.player,
          activeResearch: { ...job, daysSpent: job.daysSpent + 1 },
        },
        alerts: [
          {
            id: `res-cash-${s.day}`,
            day: s.day,
            severity: "warn" as const,
            message: `Research stalled on ${node.name} — need cash (~$${Math.round(cashRate / 1000)}k per PF-day) and Research PF.`,
          },
          ...s.alerts,
        ].slice(0, 40),
      };
    }
  }

  const next = {
    ...job,
    progressPfDays: job.progressPfDays + progress,
    daysSpent: job.daysSpent + 1,
  };

  const daysTarget = researchDaysTarget(node, researchers);
  s = chargeExpense(s, cashBurn, "research");
  s = {
    ...s,
    player: {
      ...s.player,
      activeResearch: next,
      /** Today’s research $ burn (already on the ledger + deducted from cash) */
      researchCashBurnToday: cashBurn,
    },
  };

  const complete =
    next.progressPfDays >= costTarget && next.daysSpent >= daysTarget;
  if (!complete) return s;
  return completeResearchNode(s, node);
}

export function completeResearchNode(
  state: SimState,
  node: ResearchNodeDef,
): SimState {
  const maxRanks = researchMaxRanks(node);
  const prevRank = researchRank(state, node.id);
  const alreadyDone = prevRank >= maxRanks;
  const nextRank = alreadyDone ? prevRank : prevRank + 1;
  const firstRank = prevRank === 0;
  const newlyUnlocked = !state.player.researchUnlocked.includes(node.id);
  let s: SimState = {
    ...state,
    player: {
      ...state.player,
      activeResearch: null,
      researchUnlocked: newlyUnlocked
        ? [...state.player.researchUnlocked, node.id]
        : state.player.researchUnlocked,
      researchRanks: alreadyDone
        ? state.player.researchRanks
        : { ...state.player.researchRanks, [node.id]: nextRank },
    },
    news: [
      firstRank
        ? `Day ${state.day}: Unlocked ${node.name}`
        : `Day ${state.day}: Rank ${nextRank}/${maxRanks} complete: ${node.name}`,
      ...state.news,
    ].slice(0, 20),
    alerts: [
      {
        id: `res-done-${state.day}-${node.id}-${nextRank}`,
        day: state.day,
        severity: "info" as const,
        message: firstRank
          ? `Research complete: ${node.name}`
          : `Research complete: ${node.name} (rank ${nextRank}/${maxRanks})`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
  if (!alreadyDone) s = applyResearchEffectsToPlayer(s, node.effects);
  s = tryStartFromQueue(s);
  s = maybeAutoQueueResearch(s, node.id);
  return appendFeedEvents(s, [
    {
      id: `feed-research-complete-${node.id}-${state.day}-${nextRank}`,
      day: state.day,
      category: "models",
      title: firstRank
        ? `Research unlocked: ${node.name}`
        : `Rank ${nextRank}/${maxRanks} complete: ${node.name}`,
      body: firstRank
        ? "The method is now available to training, serving, or data workflows."
        : `Rank ${nextRank}/${maxRanks} complete`,
      source: state.player.name,
      tone: "research",
      entityId: node.id,
      kind: "research_unlocked",
    },
  ]);
}

/** Cheat surface: finish the active project through the normal unlock/effects path. */
export function completeActiveResearchNow(state: SimState): SimState {
  const started = state.player.activeResearch
    ? state
    : tryStartFromQueue(state);
  const active = started.player.activeResearch;
  if (!active) return state;
  return completeResearchNode(started, getResearchNode(active.nodeId));
}

export function availableResearch(state: SimState) {
  return RESEARCH_NODES.filter((n) => {
    if (researchFullyDone(state, n.id)) return false;
    return prereqGate(state, n.id).ok;
  });
}

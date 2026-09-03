import type { LabId, ServePrecision, SimState } from "../types";
import { isCommerciallyOffered } from "../modelRelease";
import { seededId } from "../rng";
import { attachModelToEmptyPlans } from "../systems/plans";
import { findCheckpoint } from "./checkpoints";
import { pushTrainingFeed } from "./feed";
import { hasUnlock } from "./modifiers";
import { overallCapability } from "./scaling";
import { canonicalizeTierBudget } from "./thinking";
import {
  hasTextIo,
  labModelsOf,
  modalitySetOf,
  projectEndpointsToModels,
  safeModifiers,
  servePrecisionFromArch,
  unionTiers,
  withEndpoint,
  findEndpoint,
} from "./projection";
import { trainingStateOf, withTrainingState } from "./state";
import type {
  Checkpoint,
  Endpoint,
  EndpointMember,
  EndpointPricing,
  RouterPolicy,
  StartResult,
  TierBudget,
} from "./types";

export {
  bytesPerServeParam,
  compositeCapabilities,
  compositeCapabilitiesWithQuality,
  endpointCostMultiplier,
  endpointHbmGB,
  misrouteFraction,
  modelFromCheckpoint,
  projectEndpointsToModels,
  sunsetDemandMultiplier,
} from "./projection";

function fail(state: SimState, reason: string): { state: SimState; result: StartResult } {
  return { state, result: { ok: false, reason } };
}

function duplicateName(
  training: { endpoints: Endpoint[] },
  name: string,
  exceptId?: string,
): boolean {
  const trimmed = name.trim();
  return training.endpoints.some(
    (endpoint) =>
      endpoint.id !== exceptId &&
      endpoint.status !== "retired" &&
      endpoint.name.trim() === trimmed,
  );
}

function checkpointReady(checkpoint: Checkpoint): boolean {
  return (
    checkpoint.status === "kept" ||
    checkpoint.status === "stealth" ||
    checkpoint.status === "released"
  );
}

function primaryCheckpointOf(state: SimState, endpoint: Endpoint): Checkpoint | undefined {
  const training = trainingStateOf(state, endpoint.labId);
  const primary =
    endpoint.members.find((member) => member.role === "primary") ?? endpoint.members[0];
  return primary
    ? training.checkpoints.find((row) => row.id === primary.checkpointId)
    : undefined;
}

/** Brand-trust points granted when the player first open-sources an endpoint. */
export function openSourceBrandLift(capability: number): number {
  return Math.max(2, Math.min(5.5, 1.8 + Math.max(0, capability) * 0.035));
}

function grantOpenSourceReputation(
  state: SimState,
  labId: LabId,
  endpoint: Endpoint,
): SimState {
  if (labId !== state.playerLabId) return state;
  const checkpoint = primaryCheckpointOf(state, endpoint);
  const capability = checkpoint ? overallCapability(checkpoint.truth) : 40;
  const lift = openSourceBrandLift(capability);
  const next: SimState = {
    ...state,
    player: {
      ...state.player,
      brandTrust: Math.min(100, state.player.brandTrust + lift),
    },
  };
  return pushTrainingFeed(next, {
    title: `Open-sourced ${endpoint.name}`,
    body: "Public weights leak some hosted plan and API demand while brand reputation rises.",
    labId,
    kind: "endpoint_open_sourced",
    entityId: endpoint.id,
    tone: "positive",
    alert: {
      severity: "info",
      message: `${endpoint.name} is open source. Hosted demand eases; brand trust +${lift.toFixed(1)}.`,
    },
  });
}

function markEndpointOpenWeights(
  state: SimState,
  endpointId: string,
): { state: SimState; opened: Endpoint | null } {
  const found = findEndpoint(state, endpointId);
  if (!found) return { state, opened: null };
  const { endpoint, labId } = found;
  if (endpoint.openWeights || endpoint.status === "retired") {
    return { state, opened: null };
  }
  const opened: Endpoint = { ...endpoint, openWeights: true };
  return { state: withEndpoint(state, labId, endpointId, () => opened), opened };
}

function listLiveEndpoint(
  state: SimState,
  labId: LabId,
  modelId: string,
  opts?: { catalog?: boolean },
): SimState {
  if (labId !== state.playerLabId) return state;
  const model = labModelsOf(state, labId).find((entry) => entry.id === modelId);
  if (!model || !isCommerciallyOffered(model)) return state;
  let next = state;
  if (!state.player.pricing.activeModelId) {
    next = {
      ...next,
      player: {
        ...next.player,
        pricing: { ...next.player.pricing, activeModelId: modelId },
      },
    };
  }
  if (opts?.catalog === false) return next;
  const listed = next.player.pricing.apiModelIds;
  if (listed && !listed.includes(modelId)) {
    next = {
      ...next,
      player: {
        ...next.player,
        pricing: { ...next.player.pricing, apiModelIds: [...listed, modelId] },
      },
    };
  }
  return attachModelToEmptyPlans(next, modelId);
}

/** Live single-checkpoint endpoint. `modelId` equals endpoint id for the market projection. */
export function createEndpoint(
  state: SimState,
  labId: LabId,
  input: {
    name: string;
    checkpointId: string;
    precision?: ServePrecision;
    pricing?: EndpointPricing;
    openWeights?: boolean;
  },
): { state: SimState; result: StartResult } {
  const training = trainingStateOf(state, labId);
  const checkpoint = training.checkpoints.find((c) => c.id === input.checkpointId);
  if (!checkpoint) return fail(state, "checkpoint missing");
  if (checkpoint.labId !== labId) return fail(state, "checkpoint not in lab");
  if (!checkpointReady(checkpoint)) return fail(state, "checkpoint status");
  const name = input.name.trim();
  if (!name || duplicateName(training, name)) return fail(state, "duplicate name");

  const id = seededId("endpoint", labId, state.day, input.checkpointId, name);
  const endpoint: Endpoint = {
    id,
    labId,
    name,
    members: [{ checkpointId: checkpoint.id, role: "primary" }],
    policy: "single",
    tiers: checkpoint.tiers.map((tier) => ({ ...tier })),
    precision: input.precision ?? servePrecisionFromArch(checkpoint.arch.precision),
    status: "live",
    releaseDay: state.day,
    pricing: input.pricing ?? { inPerMTok: null, outPerMTok: null },
    openWeights: input.openWeights ?? false,
    modelId: id,
  };
  const nextTraining = {
    ...training,
    checkpoints: training.checkpoints.map((c) =>
      c.id === checkpoint.id
        ? {
            ...c,
            status: "released" as const,
            endpointIds: c.endpointIds.includes(id)
              ? c.endpointIds
              : [...c.endpointIds, id],
          }
        : c,
    ),
    endpoints: [...training.endpoints, endpoint],
  };
  let next = projectEndpointsToModels(withTrainingState(state, labId, nextTraining), labId);
  next = listLiveEndpoint(next, labId, id, { catalog: false });
  if (endpoint.openWeights) {
    next = grantOpenSourceReputation(next, labId, endpoint);
  }
  return { state: next, result: { ok: true, id } };
}

export function createRouter(
  state: SimState,
  labId: LabId,
  input: {
    name: string;
    members: EndpointMember[];
    policy: RouterPolicy;
    precision?: ServePrecision;
    pricing?: EndpointPricing;
  },
): { state: SimState; result: StartResult } {
  if (input.policy === "single") return fail(state, "single invalid for routers");
  if (input.members.length < 2) return fail(state, "need at least 2 members");
  const training = trainingStateOf(state, labId);
  const name = input.name.trim();
  if (!name || duplicateName(training, name)) return fail(state, "duplicate name");

  const mods = safeModifiers(state, labId);
  if (input.policy === "domain" && !hasUnlock(mods, "router_domain")) {
    return fail(state, "unlock required: router_domain");
  }
  if (input.policy === "cascade" && !hasUnlock(mods, "router_cascade")) {
    return fail(state, "unlock required: router_cascade");
  }

  const resolved: Checkpoint[] = [];
  for (const member of input.members) {
    const checkpoint = training.checkpoints.find((c) => c.id === member.checkpointId);
    if (!checkpoint) return fail(state, "checkpoint missing");
    if (checkpoint.labId !== labId) return fail(state, "checkpoint not in lab");
    if (checkpoint.status !== "kept" && checkpoint.status !== "released") {
      return fail(state, "checkpoint status");
    }
    resolved.push(checkpoint);
  }

  if (input.policy === "domain" || input.policy === "cascade") {
    if (!resolved.every((checkpoint) => hasTextIo(checkpoint.arch))) {
      return fail(state, "members must share text IO");
    }
  }
  if (input.policy === "modality") {
    const sets = new Set(resolved.map((checkpoint) => modalitySetOf(checkpoint.arch)));
    if (sets.size < 2) return fail(state, "modality router needs distinct modality sets");
  }

  const primary = resolved[0]!;
  const hasPrimary = input.members.some((member) => member.role === "primary");
  const members = input.members.map((member, index) =>
    index === 0 && !hasPrimary ? { ...member, role: "primary" as const } : member,
  );
  const id = seededId(
    "endpoint",
    labId,
    state.day,
    members.map((member) => member.checkpointId).join(","),
    name,
  );
  const endpoint: Endpoint = {
    id,
    labId,
    name,
    members,
    policy: input.policy,
    tiers: unionTiers(resolved.map((checkpoint) => checkpoint.tiers)),
    precision: input.precision ?? servePrecisionFromArch(primary.arch.precision),
    status: "live",
    releaseDay: state.day,
    pricing: input.pricing ?? { inPerMTok: null, outPerMTok: null },
    openWeights: false,
    modelId: id,
  };
  const used = new Set(members.map((member) => member.checkpointId));
  const nextTraining = {
    ...training,
    checkpoints: training.checkpoints.map((c) =>
      used.has(c.id)
        ? {
            ...c,
            status: "released" as const,
            endpointIds: c.endpointIds.includes(id)
              ? c.endpointIds
              : [...c.endpointIds, id],
          }
        : c,
    ),
    endpoints: [...training.endpoints, endpoint],
  };
  let next = projectEndpointsToModels(withTrainingState(state, labId, nextTraining), labId);
  next = listLiveEndpoint(next, labId, id);
  return { state: next, result: { ok: true, id } };
}

export function updateEndpoint(
  state: SimState,
  endpointId: string,
  patch: Partial<
    Pick<Endpoint, "name" | "members" | "policy" | "precision" | "pricing" | "openWeights">
  >,
): SimState {
  const found = findEndpoint(state, endpointId);
  if (!found) return state;
  const training = trainingStateOf(state, found.labId);
  let name = found.endpoint.name;
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed || duplicateName(training, trimmed, found.endpoint.id)) return state;
    name = trimmed;
  }
  return withEndpoint(state, found.labId, endpointId, (current) => ({
    ...current,
    name,
    members: patch.members ?? current.members,
    policy: patch.policy ?? current.policy,
    precision: patch.precision ?? current.precision,
    pricing: patch.pricing ?? current.pricing,
    openWeights: current.openWeights ? true : (patch.openWeights ?? current.openWeights),
  }));
}

/** One-way: publish weights for a live or sunset endpoint. Raises brand, cuts hosted demand. */
export function openSourceEndpoint(state: SimState, endpointId: string): SimState {
  const found = findEndpoint(state, endpointId);
  if (!found) return state;
  const marked = markEndpointOpenWeights(state, endpointId);
  if (!marked.opened) return marked.state;
  return grantOpenSourceReputation(marked.state, found.labId, marked.opened);
}

/** Open-source every live/sunset endpoint that serves this checkpoint. Brand lifts once. */
export function openSourceCheckpoint(state: SimState, checkpointId: string): SimState {
  const found = findCheckpoint(state, checkpointId);
  if (!found) return state;
  let next = state;
  let opened: Endpoint | null = null;
  for (const endpointId of found.checkpoint.endpointIds) {
    const marked = markEndpointOpenWeights(next, endpointId);
    next = marked.state;
    if (marked.opened) opened = marked.opened;
  }
  if (!opened) return next;
  return grantOpenSourceReputation(next, found.labId, opened);
}

export function setEndpointTier(
  state: SimState,
  endpointId: string,
  budget: TierBudget,
  served: boolean,
): SimState {
  const found = findEndpoint(state, endpointId);
  if (!found) return state;
  const target = canonicalizeTierBudget(budget);
  if (!found.endpoint.tiers.some((tier) => canonicalizeTierBudget(tier.budget) === target)) {
    return state;
  }
  return withEndpoint(state, found.labId, endpointId, (endpoint) => ({
    ...endpoint,
    tiers: endpoint.tiers.map((tier) =>
      canonicalizeTierBudget(tier.budget) === target ? { ...tier, served, budget: target } : tier,
    ),
  }));
}

export function sunsetEndpoint(
  state: SimState,
  endpointId: string,
  drainDays: number,
): SimState {
  const found = findEndpoint(state, endpointId);
  if (!found || found.endpoint.status === "retired") return state;
  return withEndpoint(state, found.labId, endpointId, (endpoint) => ({
    ...endpoint,
    status: "sunset",
    sunset: { startDay: state.day, drainDays: Math.max(0, drainDays) },
  }));
}

export function retireEndpoint(state: SimState, endpointId: string): SimState {
  const found = findEndpoint(state, endpointId);
  if (!found) return state;
  return withEndpoint(state, found.labId, endpointId, (endpoint) => ({
    ...endpoint,
    status: "retired",
  }));
}

export function tickEndpoints(state: SimState): SimState {
  const labs: LabId[] = [state.playerLabId, ...state.rivals.map((rival) => rival.id)];
  let next = state;
  for (const labId of labs) {
    const training = trainingStateOf(next, labId);
    if (training.endpoints.length === 0) continue;
    const endpoints = training.endpoints.map((endpoint) => {
      if (endpoint.status !== "sunset" || !endpoint.sunset) return endpoint;
      if (next.day >= endpoint.sunset.startDay + endpoint.sunset.drainDays) {
        return { ...endpoint, status: "retired" as const };
      }
      return endpoint;
    });
    next = projectEndpointsToModels(
      withTrainingState(next, labId, { ...training, endpoints }),
      labId,
    );
  }
  return next;
}

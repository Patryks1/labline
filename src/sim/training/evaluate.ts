import type { CapabilityDomain, LabId, ModelCapabilities, SimState } from "../types";
import { createRng, hashSeed, seededId } from "../rng";
import { appendFeedEvents, type FeedEventInput } from "../systems/feed";
import { TRAINING_V4 } from "./constants";
import { trainingStateOf, withTrainingState } from "./state";
import {
  canonicalizeTierBudget,
  scaleEvalCost,
  thinkingUnlocked,
} from "./thinking";
import type {
  Checkpoint,
  Endpoint,
  Eval,
  EvalMeasurement,
  EvalMetric,
  EvalResult,
  EvalTier,
  PublicSeason,
  StartResult,
  ThinkingTier,
  TierBudget,
} from "./types";

/** Domain weights for overall; vision/audio/video share 0.1 among those > 0. */
const CORE_OVERALL_WEIGHTS: Partial<Record<CapabilityDomain, number>> = {
  language: 0.25,
  reasoning: 0.2,
  code: 0.15,
  math: 0.1,
  science: 0.1,
  tools: 0.1,
};

const MULTIMODAL_DOMAINS: readonly CapabilityDomain[] = ["vision", "audio", "video"];
const MULTIMODAL_WEIGHT = 0.1;
const DOMAIN_LIST: readonly CapabilityDomain[] = [
  "language",
  "reasoning",
  "code",
  "math",
  "science",
  "vision",
  "video",
  "audio",
  "tools",
];

export const EVAL_METRICS: readonly EvalMetric[] = [
  ...DOMAIN_LIST,
  "safety",
  "steerability",
  "reliability",
  "overall",
];

const SYNTHETIC_FLAG_METRICS: readonly EvalMetric[] = ["reasoning", "math", "code"];
const SYNTHETIC_SHARE_FLAG = 0.6;
const SEASON_LENGTH_DAYS = 365;
const SEASON_DIFFICULTY_STEP = 0.15;
const SEASON_DIFFICULTY_CAP = 2.5;
const PUBLIC_LATENT_SIGMA = 2;
const CI_Z = 1.64;
const DEFLATION_KNEE = 85;
const DEFLATION_RATE = 0.5;
const LATENT_CLAMP = 3;
const ALERT_CAP = 40;
const SUITE_SIGMA_SPAN_METRICS = 8;

function notFinite(n: number): boolean {
  return !Number.isFinite(n);
}

export function clampScore(value: number): number {
  const n = notFinite(value) ? 0 : value;
  return Math.max(0, Math.min(100, n));
}

export function roundScore(value: number): number {
  return Math.round(clampScore(value) * 10) / 10;
}

function isDomain(metric: EvalMetric): metric is CapabilityDomain {
  return (DOMAIN_LIST as readonly string[]).includes(metric);
}

function labIds(state: SimState): LabId[] {
  return [state.playerLabId, ...state.rivals.map((rival) => rival.id)];
}

/** Inclusion-weighted domain mix; zeros are dropped and the rest renormalized. */
export function domainOverallWeights(
  domains: Partial<Record<CapabilityDomain, number>>,
): Partial<Record<CapabilityDomain, number>> {
  const raw: Partial<Record<CapabilityDomain, number>> = {};
  for (const [domain, weight] of Object.entries(CORE_OVERALL_WEIGHTS) as [
    CapabilityDomain,
    number,
  ][]) {
    if ((domains[domain] ?? 0) > 0) raw[domain] = weight;
  }
  const presentMm = MULTIMODAL_DOMAINS.filter((domain) => (domains[domain] ?? 0) > 0);
  if (presentMm.length > 0) {
    const share = MULTIMODAL_WEIGHT / presentMm.length;
    for (const domain of presentMm) raw[domain] = share;
  }
  const denom = Object.values(raw).reduce((sum, weight) => sum + weight, 0);
  if (denom <= 0) return {};
  const out: Partial<Record<CapabilityDomain, number>> = {};
  for (const domain of DOMAIN_LIST) {
    const weight = raw[domain];
    if (weight != null) out[domain] = weight / denom;
  }
  return out;
}

export function overallFromDomainScores(
  domains: Partial<Record<CapabilityDomain, number>>,
): number {
  const weights = domainOverallWeights(domains);
  let sum = 0;
  for (const domain of DOMAIN_LIST) {
    const weight = weights[domain];
    if (weight == null) continue;
    sum += (domains[domain] ?? 0) * weight;
  }
  return sum;
}

export function truthForMetric(truth: ModelCapabilities, metric: EvalMetric): number {
  if (metric === "overall") return overallFromDomainScores(truth.domains);
  if (metric === "safety") return truth.safety;
  if (metric === "steerability") return truth.steerability;
  if (metric === "reliability") return truth.reliability;
  return truth.domains[metric] ?? 0;
}

function listedTier(checkpoint: Checkpoint, budget: TierBudget): ThinkingTier | undefined {
  return checkpoint.tiers.find(
    (tier) => canonicalizeTierBudget(tier.budget) === canonicalizeTierBudget(budget),
  );
}

/** Lift when the eval budget is a trained thinking head. Serving is hosting, not training. */
function tierLiftApplies(checkpoint: Checkpoint, tierBudget: TierBudget): boolean {
  if (tierBudget <= 1) return false;
  return listedTier(checkpoint, tierBudget) != null;
}

/**
 * Recipe stores the realized RL effect on `postTrain.stages.reasoning.effect`.
 * That proxy scales thinking-budget lift; missing reasoning work → no lift.
 */
function rlQualityProxy(checkpoint: Checkpoint): number {
  return checkpoint.postTrain.stages.reasoning?.effect ?? 0;
}

function domainLift(checkpoint: Checkpoint, domain: CapabilityDomain, tierBudget: TierBudget): number {
  const rl = rlQualityProxy(checkpoint);
  const k = TRAINING_V4.postTrain.tierLiftK;
  const maxLift = TRAINING_V4.maxLiftByDomain[domain];
  return rl * (1 - Math.exp(-(tierBudget - 1) / k)) * maxLift;
}

export function metricLift(
  checkpoint: Checkpoint,
  metric: EvalMetric,
  tierBudget: TierBudget,
): number {
  if (metric === "overall") return overallLift(checkpoint, tierBudget);
  if (!tierLiftApplies(checkpoint, tierBudget) || !isDomain(metric)) return 0;
  return domainLift(checkpoint, metric, tierBudget);
}

function overallLift(checkpoint: Checkpoint, tierBudget: TierBudget): number {
  if (!tierLiftApplies(checkpoint, tierBudget)) return 0;
  const weights = domainOverallWeights(checkpoint.truth.domains);
  let sum = 0;
  for (const domain of DOMAIN_LIST) {
    const weight = weights[domain];
    if (weight == null) continue;
    sum += domainLift(checkpoint, domain, tierBudget) * weight;
  }
  return sum;
}

/** Season public-board deflation: high scores compress as difficulty rises. */
export function deflatePublicScore(score: number, difficultyIndex: number): number {
  const excess = Math.max(0, score - DEFLATION_KNEE);
  return score - (difficultyIndex - 1) * excess * DEFLATION_RATE;
}

function maxServedBudget(tiers: ThinkingTier[]): TierBudget {
  const served = tiers.filter((tier) => tier.served).map((tier) => canonicalizeTierBudget(tier.budget));
  if (served.length === 0) return 1;
  return Math.max(...served) as TierBudget;
}

function primaryMember(endpoint: Endpoint) {
  return endpoint.members.find((member) => member.role === "primary") ?? endpoint.members[0];
}

function findEndpoint(
  state: SimState,
  endpointId: string,
): { labId: LabId; endpoint: Endpoint } | undefined {
  for (const labId of labIds(state)) {
    const endpoint = trainingStateOf(state, labId).endpoints.find((item) => item.id === endpointId);
    if (endpoint) return { labId, endpoint };
  }
  return undefined;
}

function primaryCheckpoint(state: SimState, labId: LabId, endpoint: Endpoint): Checkpoint | undefined {
  const member = primaryMember(endpoint);
  if (!member) return undefined;
  return trainingStateOf(state, labId).checkpoints.find((item) => item.id === member.checkpointId);
}

function publicVector(
  state: SimState,
  checkpoint: Checkpoint,
  liftBudget: TierBudget,
): Partial<Record<EvalMetric, number>> {
  const season = currentSeason(state);
  const publicSeed = hashSeed(state.seed, "public", season.season);
  const out: Partial<Record<EvalMetric, number>> = {};
  for (const metric of EVAL_METRICS) {
    const truth = truthForMetric(checkpoint.truth, metric);
    const lift = metricLift(checkpoint, metric, liftBudget);
    const noisy = truth + lift + PUBLIC_LATENT_SIGMA * latentDraw(publicSeed, checkpoint.id, metric);
    out[metric] = roundScore(deflatePublicScore(noisy, season.difficultyIndex));
  }
  return out;
}

function leakRiskFor(tier: EvalTier): number {
  if (tier === "quick") return TRAINING_V4.evals.quick.leakRisk;
  if (tier === "suite") return TRAINING_V4.evals.suite.leakRisk;
  return TRAINING_V4.evals.audit.leakRisk;
}

function seasonDifficulty(seasonNumber: number): number {
  return Math.min(SEASON_DIFFICULTY_CAP, 1 + SEASON_DIFFICULTY_STEP * (seasonNumber - 1));
}

function leakedCheckpointIds(state: SimState): Set<string> {
  const ids = new Set<string>();
  for (const labId of labIds(state)) {
    for (const item of trainingStateOf(state, labId).evals) {
      if (item.result?.leaked) ids.add(item.checkpointId);
    }
  }
  return ids;
}

function seasonContamination(state: SimState): Record<string, EvalMetric[]> {
  const leaked = leakedCheckpointIds(state);
  const contamination: Record<string, EvalMetric[]> = {};
  for (const labId of labIds(state)) {
    const slice = trainingStateOf(state, labId);
    for (const endpoint of slice.endpoints) {
      const checkpoint = primaryCheckpoint(state, labId, endpoint);
      if (!checkpoint) continue;
      const flags = new Set<EvalMetric>();
      if (checkpoint.trainingSummary.syntheticShare > SYNTHETIC_SHARE_FLAG) {
        for (const metric of SYNTHETIC_FLAG_METRICS) flags.add(metric);
      }
      if (leaked.has(checkpoint.id)) {
        for (const metric of EVAL_METRICS) flags.add(metric);
      }
      if (flags.size > 0) contamination[endpoint.id] = [...flags];
    }
  }
  return contamination;
}

function makeSeason(season: number, startDay: number, state: SimState): PublicSeason {
  return {
    season,
    startDay,
    difficultyIndex: seasonDifficulty(season),
    contamination: seasonContamination(state),
  };
}

function completeEval(state: SimState, item: Eval, checkpoint: Checkpoint | undefined): Eval {
  const season = currentSeason(state).season;
  if (!checkpoint) {
    return {
      ...item,
      status: "complete",
      result: { measured: {}, season },
    };
  }
  const { sigma } = evalCost(item.tier, item.metrics, item.tierBudget);
  const evalSeedBase = hashSeed(state.seed, checkpoint.id);
  const measured: Partial<Record<EvalMetric, EvalMeasurement>> = {};
  for (const metric of item.metrics) {
    const truth = truthForMetric(checkpoint.truth, metric);
    const lift = metricLift(checkpoint, metric, item.tierBudget);
    const z = latentDraw(evalSeedBase, checkpoint.id, metric);
    measured[metric] = {
      mean: roundScore(truth + lift + sigma * z),
      ci: CI_Z * sigma,
    };
  }
  const risk = leakRiskFor(item.tier);
  const leaked = risk > 0 && createRng(hashSeed(item.seed, "leak")).next() < risk;
  const result: EvalResult = leaked ? { measured, season, leaked: true } : { measured, season };
  return { ...item, status: "complete", result };
}

function requestedBudgets(input: {
  tierBudget?: TierBudget;
  tierBudgets?: TierBudget[];
}): TierBudget[] {
  const raw =
    input.tierBudgets && input.tierBudgets.length > 0
      ? input.tierBudgets
      : [input.tierBudget ?? 1];
  const unique: TierBudget[] = [];
  for (const budget of raw) {
    const next = canonicalizeTierBudget(budget);
    if (!unique.includes(next)) unique.push(next);
  }
  unique.sort((a, b) => a - b);
  return unique;
}

function evalIdFor(
  labId: LabId,
  day: number,
  checkpointId: string,
  tier: EvalTier,
  tierBudget: TierBudget,
): string {
  return seededId("eval", labId, day, checkpointId, tier, tierBudget);
}

/**
 * Queue a private measurement. Latent draw per (seed, checkpointId, metric) is
 * immutable — paying again never rerolls. Hidden truth stays fogged until release.
 * Pass `tierBudgets` to bench several thinking levels in one order.
 */
export function orderEval(
  state: SimState,
  labId: LabId,
  input: {
    checkpointId: string;
    tier: EvalTier;
    tierBudget?: TierBudget;
    tierBudgets?: TierBudget[];
    metrics: EvalMetric[];
  },
): { state: SimState; result: StartResult } {
  const slice = trainingStateOf(state, labId);
  const checkpoint = slice.checkpoints.find((item) => item.id === input.checkpointId);
  if (!checkpoint) return { state, result: { ok: false, reason: "checkpoint not found" } };
  if (input.metrics.length === 0) {
    return { state, result: { ok: false, reason: "metrics required" } };
  }
  const budgets = requestedBudgets(input);
  if (budgets.length === 0) {
    return { state, result: { ok: false, reason: "thinking budget required" } };
  }
  for (const budget of budgets) {
    if (!thinkingUnlocked(checkpoint, budget)) {
      return { state, result: { ok: false, reason: "tier not available" } };
    }
  }
  const pending = budgets.filter((budget) => {
    const id = evalIdFor(labId, state.day, input.checkpointId, input.tier, budget);
    return !slice.evals.some((item) => item.id === id);
  });
  if (pending.length === 0) {
    return { state, result: { ok: false, reason: "eval already queued" } };
  }
  const quotes = pending.map((budget) => ({
    budget,
    cost: evalCost(input.tier, input.metrics, budget),
  }));
  const cash = quotes.reduce((sum, row) => sum + row.cost.cash, 0);
  const playerOrder = labId === state.playerLabId;
  if (playerOrder && state.player.cash < cash) {
    return { state, result: { ok: false, reason: "insufficient cash" } };
  }
  const nextEvals: Eval[] = quotes.map((row) => {
    const id = evalIdFor(labId, state.day, input.checkpointId, input.tier, row.budget);
    return {
      id,
      labId,
      checkpointId: input.checkpointId,
      tier: input.tier,
      tierBudget: row.budget,
      metrics: [...input.metrics],
      orderedDay: state.day,
      completeDay: state.day + row.cost.days,
      cashCost: row.cost.cash,
      status: "running",
      seed: hashSeed(state.seed, id),
    };
  });
  let next = state;
  if (playerOrder && cash > 0) {
    next = {
      ...next,
      player: { ...next.player, cash: next.player.cash - cash },
    };
  }
  const nextSlice = trainingStateOf(next, labId);
  next = withTrainingState(next, labId, {
    ...nextSlice,
    evals: [...nextSlice.evals, ...nextEvals],
  });
  return { state: next, result: { ok: true, id: nextEvals[0]!.id } };
}

export function tickEvals(state: SimState): SimState {
  let next = state;
  const leakEvents: FeedEventInput[] = [];
  const leakAlerts: SimState["alerts"] = [];
  for (const labId of labIds(next)) {
    const slice = trainingStateOf(next, labId);
    let changed = false;
    const evals = slice.evals.map((item) => {
      if (item.status !== "running" || item.completeDay > next.day) return item;
      changed = true;
      const checkpoint = slice.checkpoints.find((row) => row.id === item.checkpointId);
      const completed = completeEval(next, item, checkpoint);
      if (completed.result?.leaked) {
        const name = checkpoint?.name ?? item.checkpointId;
        leakEvents.push({
          id: seededId("eval-leak", item.id, next.day),
          day: next.day,
          category: "models",
          title: "Audit leaked",
          body: `Independent audit measurements for ${name} leaked before publication.`,
          source: "Eval Desk",
          tone: "warning",
          entityId: labId,
          kind: "eval_leak",
        });
        leakAlerts.push({
          id: seededId("alert-eval-leak", item.id, next.day),
          day: next.day,
          severity: "warn",
          message: `Audit of ${name} leaked.`,
        });
      }
      return completed;
    });
    if (changed) {
      next = withTrainingState(next, labId, { ...slice, evals });
    }
  }
  if (leakEvents.length > 0) next = appendFeedEvents(next, leakEvents);
  if (leakAlerts.length > 0) {
    next = { ...next, alerts: [...leakAlerts, ...next.alerts].slice(0, ALERT_CAP) };
  }
  return next;
}

export function evalCost(
  tier: EvalTier,
  metrics: EvalMetric[],
  tierBudget: TierBudget = 1,
): { cash: number; days: number; sigma: number } {
  let base: { cash: number; days: number; sigma: number };
  if (tier === "quick") {
    const spec = TRAINING_V4.evals.quick;
    base = { cash: spec.cash, days: spec.days, sigma: spec.sigma };
  } else if (tier === "audit") {
    const spec = TRAINING_V4.evals.audit;
    base = { cash: spec.cash, days: spec.days, sigma: spec.sigma };
  } else {
    const spec = TRAINING_V4.evals.suite;
    const n = metrics.length;
    const cashPerMetric = (spec.cashMax - spec.cashMin) / SUITE_SIGMA_SPAN_METRICS;
    const cash = Math.max(spec.cashMin, Math.min(spec.cashMax, spec.cashMin + cashPerMetric * n));
    const days = Math.max(spec.daysMin, Math.min(spec.daysMax, spec.daysMin + Math.floor(n / 3)));
    const tighter = Math.min(1, (n - 1) / SUITE_SIGMA_SPAN_METRICS);
    const sigma = Math.max(
      spec.sigmaEnd,
      spec.sigmaStart - (spec.sigmaStart - spec.sigmaEnd) * tighter,
    );
    base = { cash, days, sigma };
  }
  return scaleEvalCost(base, tierBudget);
}

/** Deterministic latent residual for this (seed, checkpoint, metric) triple. */
export function latentDraw(
  seed: number,
  checkpointId: string,
  metric: EvalMetric,
): number {
  const rng = createRng(hashSeed(seed, checkpointId, metric));
  let u1 = rng.next();
  while (u1 <= 0) u1 = rng.next();
  const u2 = rng.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(-LATENT_CLAMP, Math.min(LATENT_CLAMP, z));
}

function scoresIfLiveReleased(
  state: SimState,
  endpointId: string,
  liftBudget: TierBudget,
): Partial<Record<EvalMetric, number>> {
  const found = findEndpoint(state, endpointId);
  if (!found || found.endpoint.status !== "live") return {};
  const checkpoint = primaryCheckpoint(state, found.labId, found.endpoint);
  if (!checkpoint || checkpoint.status !== "released") return {};
  return publicVector(state, checkpoint, liftBudget);
}

export function publicScores(
  state: SimState,
  endpointId: string,
): Partial<Record<EvalMetric, number>> {
  const found = findEndpoint(state, endpointId);
  if (!found || found.endpoint.status !== "live") return {};
  const checkpoint = primaryCheckpoint(state, found.labId, found.endpoint);
  if (!checkpoint || checkpoint.status !== "released") return {};
  const liftBudget = maxServedBudget(
    found.endpoint.tiers.length > 0 ? found.endpoint.tiers : checkpoint.tiers,
  );
  return publicVector(state, checkpoint, liftBudget);
}

/** Public board scores at a requested thinking budget (no lift unless that tier is served). */
export function publicScoresForBudget(
  state: SimState,
  endpointId: string,
  tierBudget: TierBudget,
): Partial<Record<EvalMetric, number>> {
  return scoresIfLiveReleased(state, endpointId, tierBudget);
}

export function currentSeason(state: SimState): PublicSeason {
  const seasons = trainingStateOf(state, state.playerLabId).seasons;
  const last = seasons[seasons.length - 1];
  if (last) return last;
  return { season: 1, startDay: 0, difficultyIndex: 1, contamination: {} };
}

export function tickSeasons(state: SimState): SimState {
  const slice = trainingStateOf(state, state.playerLabId);
  const seasons =
    slice.seasons.length === 0 ? [makeSeason(1, 0, state)] : [...slice.seasons];
  while (state.day >= (seasons[seasons.length - 1]?.startDay ?? 0) + SEASON_LENGTH_DAYS) {
    const last = seasons[seasons.length - 1]!;
    seasons.push(makeSeason(last.season + 1, last.startDay + SEASON_LENGTH_DAYS, state));
  }
  const current = seasons[seasons.length - 1]!;
  const contamination = seasonContamination(state);
  seasons[seasons.length - 1] = { ...current, contamination };

  const unchanged =
    seasons.length === slice.seasons.length &&
    seasons.every((season, index) => {
      const prev = slice.seasons[index];
      return (
        prev != null &&
        season.season === prev.season &&
        season.startDay === prev.startDay &&
        season.difficultyIndex === prev.difficultyIndex &&
        JSON.stringify(season.contamination) === JSON.stringify(prev.contamination)
      );
    });
  if (unchanged) return state;
  return withTrainingState(state, state.playerLabId, { ...slice, seasons });
}

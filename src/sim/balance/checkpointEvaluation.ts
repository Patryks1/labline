// V4-DELETE: superseded by src/sim/training/evaluate.ts (Phase 2 cutover).
import { createRng, hashSeed, seededId } from "../rng";
import type { BenchmarkMetricId, BenchmarkSuiteId, Model } from "../types";
import {
  benchmarkEffortRecipes,
  benchmarkTaskWorkload,
  estimateBenchmarkRun,
  type BenchmarkRunEstimate,
} from "./benchmarkCost";
import { INSTANT_EFFORT_ID, effortViewForRecipe } from "./modelProduct";
import {
  buildBenchmarkSuites,
  evaluationMarketsForModel,
  suiteComposite,
  suiteForEvaluationMarket,
  SUITE_METRICS,
} from "./evaluationSuites";

export type CheckpointEvaluationMode =
  "internal" | "nda_external" | "partner_pilot";

export type CheckpointEvaluationBudgetTier = "lean" | "standard" | "rigorous";

export interface CheckpointEvaluationRequest {
  suiteIds: BenchmarkSuiteId[];
  budgetTier: CheckpointEvaluationBudgetTier;
  mode: CheckpointEvaluationMode;
  /** Trained inference recipe used for text/reasoning tasks. Legacy means Instant. */
  effortRecipeId?: string;
}

export interface CheckpointEvaluationQuote {
  suiteIds: BenchmarkSuiteId[];
  budgetTier: CheckpointEvaluationBudgetTier;
  mode: CheckpointEvaluationMode;
  /** Sample and task-construction spend for each selected suite. */
  spendPerSuite: number;
  suiteCost: number;
  /** Recruiting, honoraria, secure lab, and pilot-operation cost. */
  panelCost: number;
  /** API-equivalent inference value for every task in this concrete run. */
  inferenceCost?: number;
  totalCost: number;
  effortRecipeId?: string;
  taskCount?: number;
  costPerTask?: number;
  computePfDays?: number;
  averageLatencyMs?: number;
  estimatedTokensPerSecond?: number;
  billedTokens?: number;
  workload?: BenchmarkRunEstimate;
  durationDays: number;
  reviewerCount: number;
  /** Expected measurement accuracy, not model capability. */
  accuracy: number;
  confidence: number;
  /** Probability of pre-release information escaping the panel. */
  leakRisk: number;
  /** Residual chance that benchmark familiarity distorts the report. */
  contaminationRisk: number;
}

export interface PendingCheckpointEvaluation {
  id: string;
  modelId: string;
  /** Monotonic per-checkpoint study sequence; identity only, never evidence noise. */
  sequence: number;
  request: CheckpointEvaluationRequest;
  quote: CheckpointEvaluationQuote;
  scheduledDay: number;
  readyDay: number;
  /** Training-pool PF completed. Missing preserves legacy calendar-only work. */
  computeProgressPfDays?: number;
}

export interface CheckpointRivalComparison {
  modelId: string;
  modelName: string;
  labName?: string;
  score: number;
  /** Target observed score minus this leader's observed score. */
  delta: number;
  rank: number;
  fieldSize: number;
}

export interface CheckpointMetricEvaluation {
  metricId: BenchmarkMetricId;
  label: string;
  score: number;
  low: number;
  high: number;
  /** 0-1 warning signal. This never modifies the underlying model. */
  contaminationSignal: number;
  rival: CheckpointRivalComparison | null;
}

export interface CheckpointSuiteEvaluation {
  suiteId: BenchmarkSuiteId;
  label: string;
  score: number;
  low: number;
  high: number;
  accuracy: number;
  confidence: number;
  metrics: CheckpointMetricEvaluation[];
}

export type CheckpointReviewerFocus =
  | "generalist"
  | "safety"
  | "enterprise"
  | "developer_tools"
  | "science_reasoning"
  | "image_creator"
  | "video_creator"
  | "audio_creator"
  | "production_reliability";

export interface CheckpointPanelReview {
  reviewerId: string;
  panel: "internal" | "external" | "partner";
  focus: CheckpointReviewerFocus;
  /** Reviewers never receive the checkpoint or lab identity. */
  identityBlind: true;
  score: number;
  confidence: number;
  /** Stable reviewer tendency in score points. */
  bias: number;
  /** Realized sample noise in score points. */
  noise: number;
  verdict: "do_not_advance" | "mixed" | "promising" | "exceptional";
  strengths: string[];
  concerns: string[];
}

export interface CheckpointEvaluationReport {
  id: string;
  modelId: string;
  modelName: string;
  scheduledDay: number;
  completedDay: number;
  request: CheckpointEvaluationRequest;
  quote: CheckpointEvaluationQuote;
  overallScore: number;
  confidence: number;
  contaminationRisk: number;
  leakRisk: number;
  leakOutcome: "none" | "rumor" | "identity_leak";
  flags: string[];
  suites: CheckpointSuiteEvaluation[];
  reviews: CheckpointPanelReview[];
}

export interface CheckpointEvaluationRival {
  model: Model;
  labName?: string;
}

export interface ResolveCheckpointEvaluationInput {
  model: Model;
  rivals?: readonly CheckpointEvaluationRival[];
  request: CheckpointEvaluationRequest;
  /** Monotonic per-checkpoint study sequence; used only for report identity/panel sampling. */
  reportSequence?: number;
  seed: number;
  scheduledDay: number;
  completedDay?: number;
}

const BUDGETS: Record<
  CheckpointEvaluationBudgetTier,
  {
    spend: number;
    accuracy: number;
    confidence: number;
    days: number;
    tasksPerMetric: number;
  }
> = {
  lean: {
    spend: 50_000,
    accuracy: 0.65,
    confidence: 0.72,
    days: 0,
    tasksPerMetric: 200,
  },
  standard: {
    spend: 100_000,
    accuracy: 0.775,
    confidence: 0.84,
    days: 2,
    tasksPerMetric: 500,
  },
  rigorous: {
    spend: 150_000,
    accuracy: 0.9,
    confidence: 0.96,
    days: 5,
    tasksPerMetric: 1_200,
  },
};

const MODES: Record<
  CheckpointEvaluationMode,
  {
    panel: CheckpointPanelReview["panel"];
    panelCost: number;
    days: number;
    reviewers: [number, number, number];
    accuracy: number;
    confidence: number;
    baseLeak: number;
    contaminationMultiplier: number;
  }
> = {
  internal: {
    panel: "internal",
    panelCost: 25_000,
    days: 2,
    reviewers: [3, 4, 6],
    accuracy: -0.035,
    confidence: -0.04,
    baseLeak: 0,
    contaminationMultiplier: 1,
  },
  nda_external: {
    panel: "external",
    panelCost: 95_000,
    days: 6,
    reviewers: [4, 6, 8],
    accuracy: 0.015,
    confidence: 0.01,
    baseLeak: 0.018,
    contaminationMultiplier: 0.68,
  },
  partner_pilot: {
    panel: "partner",
    panelCost: 240_000,
    days: 12,
    reviewers: [5, 7, 9],
    accuracy: 0.035,
    confidence: 0.02,
    baseLeak: 0.065,
    contaminationMultiplier: 0.42,
  },
};

const clamp = (value: number, low = 0, high = 100) =>
  Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
const clamp01 = (value: number) => clamp(value, 0, 1);
const round1 = (value: number) => Math.round(value * 10) / 10;

/** Native suite first, then every other suite supported by actual outputs. */
export function eligibleCheckpointEvaluationSuites(
  model: Model,
): BenchmarkSuiteId[] {
  const result: BenchmarkSuiteId[] = [];
  const add = (suite: BenchmarkSuiteId) => {
    if (!result.includes(suite)) result.push(suite);
  };
  if (model.productPreset === "omni" || model.family === "omni")
    add("omni_overview");
  else if (
    model.productPreset === "video_generation" ||
    model.family === "video"
  )
    add("video_generation");
  else if (
    model.productPreset === "image_generation" ||
    model.family === "diffusion"
  )
    add("image_generation");
  else if (model.productPreset === "audio") add("audio_generation");
  for (const market of evaluationMarketsForModel(model))
    add(suiteForEvaluationMarket(market));
  return result;
}

export function validateCheckpointEvaluationRequest(
  model: Model,
  request: CheckpointEvaluationRequest,
): string[] {
  const errors: string[] = [];
  const eligible = new Set(eligibleCheckpointEvaluationSuites(model));
  if (!request.suiteIds.length)
    errors.push("Select at least one evaluation suite.");
  if (new Set(request.suiteIds).size !== request.suiteIds.length)
    errors.push("Evaluation suites cannot be repeated.");
  for (const suite of request.suiteIds) {
    if (!eligible.has(suite))
      errors.push(`${suite} is not supported by this checkpoint.`);
  }
  if (!(request.budgetTier in BUDGETS))
    errors.push("Unknown evaluation budget tier.");
  if (!(request.mode in MODES)) errors.push("Unknown evaluation panel mode.");
  const requestedRecipe = request.effortRecipeId ?? INSTANT_EFFORT_ID;
  if (!benchmarkEffortRecipes(model).some((recipe) => recipe.id === requestedRecipe)) {
    errors.push(`The ${requestedRecipe} effort recipe is not trained.`);
  }
  return errors;
}

function rawContaminationRisk(model: Model): number {
  const lowQualityValues = Object.values(model.lowQualityShareByDomain ?? {});
  const lowQuality = lowQualityValues.length
    ? lowQualityValues.reduce((sum, value) => sum + value, 0) /
      lowQualityValues.length
    : 0;
  const repetition = clamp01(((model.repeatedDataEpochs ?? 1) - 1) / 5);
  return clamp01(
    0.025 +
      (model.benchmarkOverfit ?? 0) * 0.58 +
      repetition * 0.14 +
      (model.syntheticShare ?? 0) * 0.12 +
      lowQuality * 0.16,
  );
}

export function quoteCheckpointEvaluation(
  model: Model,
  request: CheckpointEvaluationRequest,
): CheckpointEvaluationQuote {
  const errors = validateCheckpointEvaluationRequest(model, request);
  if (errors.length) throw new Error(errors.join(" "));
  const budget = BUDGETS[request.budgetTier];
  const mode = MODES[request.mode];
  const tierIndex =
    request.budgetTier === "lean"
      ? 0
      : request.budgetTier === "standard"
        ? 1
        : 2;
  const reviewerCount = mode.reviewers[tierIndex];
  const suiteCost = budget.spend * request.suiteIds.length;
  const reviewerHonorarium =
    request.mode === "internal"
      ? 8_000
      : request.mode === "nda_external"
        ? 20_000
        : 35_000;
  const panelCost = mode.panelCost + reviewerCount * reviewerHonorarium;
  const effortRecipeId = request.effortRecipeId ?? INSTANT_EFFORT_ID;
  const priceIn = Math.max(
    0,
    model.apiPriceInPerMTok ??
      model.suggestedApiPriceIn ??
      model.apiPricePerMTok ??
      model.suggestedApiPrice ??
      0,
  );
  const priceOut = Math.max(
    0,
    model.apiPriceOutPerMTok ??
      model.suggestedApiPriceOut ??
      model.apiPricePerMTok ??
      model.suggestedApiPrice ??
      0,
  );
  const workload = estimateBenchmarkRun(
    model,
    request.suiteIds.flatMap((suiteId) =>
      SUITE_METRICS[suiteId].map((metric) => metric.id),
    ),
    effortRecipeId,
    { priceIn, priceOut },
    budget.tasksPerMetric,
  );
  const inferenceCost = workload.tokenCost;
  // More reviewers and more outside organizations increase the operational surface.
  const leakRisk =
    request.mode === "internal"
      ? 0
      : clamp01(
          mode.baseLeak +
            reviewerCount * (request.mode === "partner_pilot" ? 0.007 : 0.003) +
            request.suiteIds.length * 0.003,
        );
  return {
    suiteIds: [...request.suiteIds],
    budgetTier: request.budgetTier,
    mode: request.mode,
    spendPerSuite: budget.spend,
    suiteCost,
    panelCost,
    inferenceCost,
    totalCost: suiteCost + panelCost + inferenceCost,
    effortRecipeId,
    taskCount: workload.taskCount,
    costPerTask:
      workload.taskCount > 0
        ? (suiteCost + panelCost + inferenceCost) / workload.taskCount
        : 0,
    computePfDays: workload.computePfDays,
    averageLatencyMs: workload.averageLatencyMs,
    estimatedTokensPerSecond: workload.estimatedTokensPerSecond,
    billedTokens: workload.billedTokens,
    workload,
    durationDays:
      mode.days + budget.days + Math.max(0, request.suiteIds.length - 1),
    reviewerCount,
    accuracy: clamp01(budget.accuracy + mode.accuracy),
    confidence: clamp01(budget.confidence + mode.confidence),
    leakRisk,
    contaminationRisk: clamp01(
      rawContaminationRisk(model) * mode.contaminationMultiplier,
    ),
  };
}

export function createPendingCheckpointEvaluation(
  model: Model,
  request: CheckpointEvaluationRequest,
  seed: number,
  scheduledDay: number,
  sequence = 0,
): PendingCheckpointEvaluation {
  const quote = quoteCheckpointEvaluation(model, request);
  return {
    id: seededId(
      "checkpoint-eval",
      seed,
      model.id,
      sequence,
      scheduledDay,
      request.mode,
      request.budgetTier,
      request.suiteIds.join(","),
    ),
    modelId: model.id,
    sequence,
    request: { ...request, suiteIds: [...request.suiteIds] },
    quote,
    scheduledDay,
    readyDay: scheduledDay + quote.durationDays,
    computeProgressPfDays: 0,
  };
}

function suiteScores(
  model: Model,
  suiteId: BenchmarkSuiteId,
): Partial<Record<BenchmarkMetricId, number>> {
  return (
    model.benchmarkSuites?.[suiteId] ??
    buildBenchmarkSuites(model).suites[suiteId] ??
    {}
  );
}

/**
 * Private effort runs project the selected checkpoint only. Public rival
 * evidence and official rankings stay on persisted Instant scores.
 */
function effortAdjustedMetricScore(
  model: Model,
  metricId: BenchmarkMetricId,
  latent: number,
  effortRecipeId: string,
): number {
  const workload = benchmarkTaskWorkload(metricId);
  if (
    effortRecipeId === INSTANT_EFFORT_ID ||
    (workload !== "language" &&
      workload !== "coding" &&
      workload !== "reasoning")
  ) {
    return clamp(latent);
  }
  const view = effortViewForRecipe(model, effortRecipeId);
  const lift = Math.max(0, (view?.capability ?? model.capability) - model.capability);
  return clamp(latent + lift);
}

function measuredScore(
  latent: number,
  seed: number,
  modelId: string,
  mode: CheckpointEvaluationMode,
  suiteId: BenchmarkSuiteId,
  metricId: BenchmarkMetricId,
  accuracy: number,
  contamination: number,
): { score: number; low: number; high: number } {
  // The immutable checkpoint + metric owns one latent evidence draw. Day,
  // report sequence, mode and budget are deliberately absent: another paid
  // study can narrow uncertainty or change a declared method bias, but cannot
  // sell the player a fresh random direction to cherry-pick.
  const rng = createRng(
    hashSeed(seed, modelId, suiteId, metricId, "stealth-evidence-v2"),
  );
  const halfWidth = 1.8 + (1 - accuracy) * 18;
  const latentDraw = rng.range(-1, 1);
  const randomError = latentDraw * halfWidth;
  const contaminationLift =
    contamination *
    (mode === "internal" ? 5.5 : mode === "nda_external" ? 2 : 0.5);
  const methodBias =
    mode === "internal" ? 0.35 : mode === "partner_pilot" ? -0.2 : 0;
  const combinedError = randomError + contaminationLift + methodBias;
  // A methodology can move the estimate toward/away from truth, but it cannot
  // reverse the checkpoint's stable random tendency and create a reroll farm.
  const error =
    latentDraw < 0
      ? Math.min(-0.05, combinedError)
      : Math.max(0.05, combinedError);
  const score = clamp(latent + error);
  return {
    score: round1(score),
    low: round1(clamp(score - halfWidth)),
    high: round1(clamp(score + halfWidth)),
  };
}

function suiteLabel(suiteId: BenchmarkSuiteId): string {
  if (suiteId === "image_generation") return "Image generation";
  if (suiteId === "video_generation") return "Video generation";
  if (suiteId === "audio_generation") return "Audio generation";
  if (suiteId === "omni_overview") return "Omni integration";
  return "Language and reasoning";
}

function reviewerFocuses(model: Model): CheckpointReviewerFocus[] {
  const eligible = new Set(eligibleCheckpointEvaluationSuites(model));
  const focuses: CheckpointReviewerFocus[] = [
    "generalist",
    "safety",
    "enterprise",
    "production_reliability",
  ];
  const tools =
    (model.io?.tools ?? 0) > 0 || model.modalities.includes("tools");
  if (tools || (eligible.has("language") && model.benchmarks.coding > 35)) {
    focuses.push("developer_tools");
  }
  if (eligible.has("language")) focuses.push("science_reasoning");
  if (eligible.has("image_generation")) focuses.push("image_creator");
  if (eligible.has("video_generation")) focuses.push("video_creator");
  if (eligible.has("audio_generation")) focuses.push("audio_creator");
  return focuses;
}

function focusSuite(
  focus: CheckpointReviewerFocus,
  suites: CheckpointSuiteEvaluation[],
): CheckpointSuiteEvaluation | undefined {
  const id =
    focus === "image_creator"
      ? "image_generation"
      : focus === "video_creator"
        ? "video_generation"
        : focus === "audio_creator"
          ? "audio_generation"
          : focus === "developer_tools" || focus === "science_reasoning"
            ? "language"
            : undefined;
  return id ? suites.find((suite) => suite.suiteId === id) : undefined;
}

function makeReviews(
  model: Model,
  suites: CheckpointSuiteEvaluation[],
  quote: CheckpointEvaluationQuote,
  seed: number,
): CheckpointPanelReview[] {
  const focuses = reviewerFocuses(model);
  const allMetrics = suites.flatMap((suite) => suite.metrics);
  const strengths = [...allMetrics]
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((metric) => metric.label);
  const concerns = [...allMetrics]
    .sort((a, b) => a.score - b.score)
    .slice(0, 2)
    .map((metric) => metric.label);
  const overall = suites.length
    ? suites.reduce((sum, suite) => sum + suite.score, 0) / suites.length
    : 0;
  return Array.from({ length: quote.reviewerCount }, (_, index) => {
    const focus = focuses[index % focuses.length]!;
    // Recommissioning the same kind of panel must not buy a fresh reviewer
    // roll. A deeper study retains each panelist's tendency while reducing
    // its magnitude and may add more reviewers at higher tiers.
    const rng = createRng(
      hashSeed(
        seed,
        model.id,
        quote.mode,
        focus,
        index,
        "blind-review-evidence-v2",
      ),
    );
    const bias = round1(rng.range(-4.2, 4.2));
    const maxNoise = 1.2 + (1 - quote.accuracy) * 10;
    const noise = round1(rng.range(-maxNoise, maxNoise));
    const focused = focusSuite(focus, suites)?.score ?? overall;
    const reliability = model.quality.reliability;
    const safety = model.quality.safety;
    const productionAdjustment =
      focus === "production_reliability" || focus === "enterprise"
        ? (reliability - 50) * 0.16
        : focus === "safety"
          ? (safety - 50) * 0.18
          : 0;
    const score = round1(clamp(focused + bias + noise + productionAdjustment));
    const verdict =
      score >= 82
        ? "exceptional"
        : score >= 68
          ? "promising"
          : score >= 52
            ? "mixed"
            : "do_not_advance";
    return {
      reviewerId: seededId("reviewer", model.id, quote.mode, focus, index),
      panel: MODES[quote.mode].panel,
      focus,
      identityBlind: true as const,
      score,
      confidence: round1(quote.confidence * 100) / 100,
      bias,
      noise,
      verdict,
      strengths,
      concerns,
    };
  });
}

export function resolveCheckpointEvaluation(
  input: ResolveCheckpointEvaluationInput,
): CheckpointEvaluationReport {
  const quote = quoteCheckpointEvaluation(input.model, input.request);
  const effortRecipeId = input.request.effortRecipeId ?? INSTANT_EFFORT_ID;
  const completedDay =
    input.completedDay ?? input.scheduledDay + quote.durationDays;
  const contamination = quote.contaminationRisk;
  const rivalFields = input.rivals ?? [];
  const suites: CheckpointSuiteEvaluation[] = input.request.suiteIds.map(
    (suiteId) => {
      const targetScores = suiteScores(input.model, suiteId);
      const metrics = SUITE_METRICS[suiteId].map((definition) => {
        const target = measuredScore(
          effortAdjustedMetricScore(
            input.model,
            definition.id,
            targetScores[definition.id] ?? 0,
            effortRecipeId,
          ),
          input.seed,
          input.model.id,
          input.request.mode,
          suiteId,
          definition.id,
          quote.accuracy,
          contamination,
        );
        const field = rivalFields
          .map((rival) => {
            const latent = suiteScores(rival.model, suiteId)[definition.id];
            if (latent == null) return null;
            const measured = measuredScore(
              latent,
              input.seed,
              rival.model.id,
              input.request.mode,
              suiteId,
              definition.id,
              quote.accuracy,
              clamp01(
                rawContaminationRisk(rival.model) *
                  MODES[input.request.mode].contaminationMultiplier,
              ),
            );
            return { rival, score: measured.score };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry != null)
          .sort((a, b) => b.score - a.score);
        const leader = field[0];
        const rank =
          1 + field.filter((entry) => entry.score > target.score).length;
        return {
          metricId: definition.id,
          label: definition.label,
          score: target.score,
          low: target.low,
          high: target.high,
          contaminationSignal: round1(contamination * 100) / 100,
          rival: leader
            ? {
                modelId: leader.rival.model.id,
                modelName: leader.rival.model.name,
                labName: leader.rival.labName,
                score: leader.score,
                delta: round1(target.score - leader.score),
                rank,
                fieldSize: field.length + 1,
              }
            : null,
        };
      });
      const score = suiteComposite(
        Object.fromEntries(
          metrics.map((metric) => [metric.metricId, metric.score]),
        ),
      );
      const low = suiteComposite(
        Object.fromEntries(
          metrics.map((metric) => [metric.metricId, metric.low]),
        ),
      );
      const high = suiteComposite(
        Object.fromEntries(
          metrics.map((metric) => [metric.metricId, metric.high]),
        ),
      );
      return {
        suiteId,
        label: suiteLabel(suiteId),
        score: round1(score),
        low: round1(low),
        high: round1(high),
        accuracy: quote.accuracy,
        confidence: quote.confidence,
        metrics,
      };
    },
  );
  const leakDraw = createRng(
    hashSeed(
      input.seed,
      input.model.id,
      input.scheduledDay,
      input.request.mode,
      "leak-v1",
    ),
  ).next();
  const leakOutcome =
    quote.leakRisk === 0 || leakDraw >= quote.leakRisk
      ? "none"
      : leakDraw < quote.leakRisk * 0.18
        ? "identity_leak"
        : "rumor";
  const flags: string[] = [];
  if (contamination >= 0.12) flags.push("possible_eval_contamination");
  if ((input.model.benchmarkOverfit ?? 0) >= 0.2)
    flags.push("benchmark_field_gap");
  if ((input.model.syntheticShare ?? 0) >= 0.45)
    flags.push("synthetic_feedback_risk");
  if (quote.accuracy < 0.75) flags.push("wide_confidence_intervals");
  if (leakOutcome === "rumor") flags.push("stealth_rumor");
  if (leakOutcome === "identity_leak") flags.push("checkpoint_identity_leaked");
  const reviews = makeReviews(input.model, suites, quote, input.seed);
  return {
    id: seededId(
      "checkpoint-report",
      input.seed,
      input.model.id,
      input.reportSequence ?? 0,
      input.scheduledDay,
      completedDay,
      input.request.mode,
      input.request.budgetTier,
      effortRecipeId,
      input.request.suiteIds.join(","),
    ),
    modelId: input.model.id,
    modelName: input.model.name,
    scheduledDay: input.scheduledDay,
    completedDay,
    request: { ...input.request, suiteIds: [...input.request.suiteIds] },
    quote,
    overallScore: round1(
      suites.length
        ? suites.reduce((sum, suite) => sum + suite.score, 0) / suites.length
        : 0,
    ),
    confidence: quote.confidence,
    contaminationRisk: contamination,
    leakRisk: quote.leakRisk,
    leakOutcome,
    flags,
    suites,
    reviews,
  };
}

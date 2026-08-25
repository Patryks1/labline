import { ECONOMY, SEGMENTS } from "../balance/economy";
import {
  API_PRICE_EPSILON,
  avgTokensPerInteraction,
  blendApiPrice,
  commercialModelKind,
  modelBlendedPublicApiPrice,
  type CommercialModelKind,
} from "../balance/pricing";
import { precisionComputeMult } from "../balance/tokenServe";
import type {
  BenchmarkId,
  Model,
  ModelIOModality,
  PlanDemandShock,
  PlanDayStats,
  PlanModalityRoute,
  PlanServePrecision,
  SegmentId,
  SimState,
  SubPlan,
} from "../types";
import { isCommerciallyOffered, isLivePublicModel } from "../modelRelease";
import { agedMarketView } from "../balance/modelAging";
import { planPersonalityDissatisfaction } from "../balance/modelProduct";
import {
  customerBandForPrice,
  expectedUtilizationRange,
  inferencePfDemand,
  planActualMTokPerUser,
} from "../balance/serveCompute";
import { seededId } from "../rng";
import {
  collapseRouterShares,
  planAssignedRouters,
  planExposedModelIds,
  planRouterParts,
} from "../balance/modelRouter";
import {
  normalizeModelEvaluations,
  suiteComposite,
} from "../balance/evaluationSuites";
import { appendFeedEvents, type FeedEventInput } from "./feed";

/** Paid plans above this monthly price cannot retain product traffic as training data. */
export const PAID_DATA_COLLECTION_PRICE_CAP = 50;

/** Maximum number of subscription tiers a player can operate at once. */
export const MAX_PLANS = 8;

/**
 * Hard cap on the share of a plan's served traffic that may be collected.
 * Free: up to 100%. Paid ≤ $50: lerp(20% → 10%) by price/50. Above $50: 0%.
 */
export function maxPlanDataCollectionShare(pricePerMonth: number): number {
  const price = Math.max(0, Number.isFinite(pricePerMonth) ? pricePerMonth : 0);
  if (price <= 0) return 1;
  if (price > PAID_DATA_COLLECTION_PRICE_CAP) return 0;
  const t = price / PAID_DATA_COLLECTION_PRICE_CAP;
  return 0.2 + (0.1 - 0.2) * t;
}

/** Effective collect share = min(setting, price cap); forced 0 above $50. */
export function effectivePlanDataCollectionRate(
  pricePerMonth: number,
  setting: number,
): number {
  const cap = maxPlanDataCollectionShare(pricePerMonth);
  if (cap <= 0) return 0;
  const desired = Math.max(
    0,
    Math.min(1, Number.isFinite(setting) ? setting : 0),
  );
  return Math.min(desired, cap);
}

/** Defaults: Free on; paid ≤ $50 request the full allowed cap; > $50 locked off. */
export function defaultPlanDataCollectionRate(pricePerMonth: number): number {
  const cap = maxPlanDataCollectionShare(pricePerMonth);
  return cap <= 0 ? 0 : 1;
}

/** Persist a 0–1 setting, forced to 0 when the plan price forbids collection. */
export function clampPlanDataCollectionRate(
  pricePerMonth: number,
  rate: number | undefined,
): number {
  if (maxPlanDataCollectionShare(pricePerMonth) <= 0) return 0;
  if (rate !== undefined && Number.isFinite(rate)) {
    return Math.max(0, Math.min(1, rate));
  }
  return defaultPlanDataCollectionRate(pricePerMonth);
}

/**
 * Starter blended public API list price (£/MTok) matching createGame defaults
 * (in $0.80 / out $3.20). Used to seed advertised API-value subsidies on
 * default and freshly created plans before any models are released.
 */
export const DEFAULT_PLAN_BLEND_API_PRICE = blendApiPrice(0.8, 3.2);

/** Derive an advertised monthly subsidy from a legacy included-MTok allowance. */
export function subsidyFromIncludedMTok(
  includedMTokPerMonth: number,
  blendedApiPricePerMTok = DEFAULT_PLAN_BLEND_API_PRICE,
): number {
  return (
    Math.max(0, includedMTokPerMonth) *
    Math.max(API_PRICE_EPSILON, blendedApiPricePerMTok)
  );
}

export function defaultPlans(): SubPlan[] {
  // Public-market ladder: mainstream $20, 5x power $100, 20x max $200.
  // Entitlements are fixed native capacity promises, never API-price-derived.
  const freeIncluded =
    ECONOMY.basePlanUsageMTokPerDay * 0.2 * ECONOMY.daysPerMonth;
  const plusIncluded = ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth;
  const proIncluded =
    ECONOMY.basePlanUsageMTokPerDay * 5 * ECONOMY.daysPerMonth;
  const maxIncluded =
    ECONOMY.basePlanUsageMTokPerDay * 20 * ECONOMY.daysPerMonth;
  return [
    {
      id: "plan-free",
      name: "Free",
      pricePerMonth: 0,
      usageMultiplier: 0.2,
      includedMTokPerMonth: freeIncluded,
      usageRate: null,
      modelIds: [],
      computePriority: 20,
      servePrecision: "fp32",
      servePrecisionByModel: {},
      steadyUsageTarget: defaultSteadyPlanUsage(0),
      dataCollectionRate: defaultPlanDataCollectionRate(0),
      modalityRoutes: {},
      demandShocks: [],
      enabled: true,
    },
    {
      id: "plan-plus",
      name: "Plus",
      pricePerMonth: 20,
      usageMultiplier: 1,
      includedMTokPerMonth: plusIncluded,
      usageRate: null,
      modelIds: [],
      computePriority: 55,
      servePrecision: "fp32",
      servePrecisionByModel: {},
      steadyUsageTarget: defaultSteadyPlanUsage(20),
      dataCollectionRate: defaultPlanDataCollectionRate(20),
      modalityRoutes: {},
      demandShocks: [],
      enabled: true,
    },
    {
      id: "plan-pro",
      name: "Pro",
      pricePerMonth: 100,
      usageMultiplier: 5,
      includedMTokPerMonth: proIncluded,
      usageRate: null,
      modelIds: [],
      computePriority: 85,
      servePrecision: "fp32",
      servePrecisionByModel: {},
      steadyUsageTarget: defaultSteadyPlanUsage(100),
      dataCollectionRate: defaultPlanDataCollectionRate(100),
      modalityRoutes: {},
      demandShocks: [],
      enabled: true,
    },
    {
      id: "plan-max",
      name: "Max",
      pricePerMonth: 200,
      usageMultiplier: 20,
      includedMTokPerMonth: maxIncluded,
      usageRate: null,
      modelIds: [],
      computePriority: 95,
      servePrecision: "fp32",
      servePrecisionByModel: {},
      steadyUsageTarget: defaultSteadyPlanUsage(200),
      dataCollectionRate: defaultPlanDataCollectionRate(200),
      modalityRoutes: {},
      demandShocks: [],
      enabled: true,
    },
  ];
}

const MODALITY_TRAFFIC_SHARE: Record<ModelIOModality, number> = {
  text: 0.78,
  image: 0.1,
  audio: 0.05,
  video: 0.07,
};

export function defaultPremiumRouteShare(pricePerMonth: number): number {
  if (pricePerMonth <= 0) return 0.05;
  if (pricePerMonth <= 30) return 0.3;
  if (pricePerMonth <= 100) return 0.65;
  return 0.9;
}

export function defaultSteadyPlanUsage(pricePerMonth: number): number {
  if (pricePerMonth <= 0) return 0.1;
  // Mid-band steady target from the smooth customer bands.
  const [low, high] = expectedUtilizationRange(pricePerMonth);
  return Math.round(((low + high) / 2) * 100) / 100;
}

function modelSupportsOutput(model: Model, modality: ModelIOModality): boolean {
  if ((model.io?.outputs[modality] ?? 0) > 0) return true;
  if (modality === "text") return model.modalities.includes("text");
  return model.modalities.includes(modality);
}

/**
 * Derive legacy modality routes without changing the authoritative model
 * roster. New routes intentionally have no fallback: model selection and
 * precision now live on the plan's compact model roster.
 */
export function normalizedPlanRoutes(
  state: SimState,
  plan: SubPlan,
): Partial<Record<ModelIOModality, PlanModalityRoute>> {
  const routes: Partial<Record<ModelIOModality, PlanModalityRoute>> = {};
  const servingIds = new Set(planServingModelIds(state, plan));
  const released = state.player.models.filter(
    (model) => isCommerciallyOffered(model) && servingIds.has(model.id),
  );
  for (const modality of Object.keys(
    MODALITY_TRAFFIC_SHARE,
  ) as ModelIOModality[]) {
    const eligible = released
      .filter((model) => modelSupportsOutput(model, modality))
      .toSorted((a, b) => b.capability - a.capability);
    if (eligible.length === 0) continue;
    routes[modality] = {
      modality,
      primaryModelId: eligible[0]?.id ?? null,
      fallbackModelId: null,
      premiumShare: defaultPremiumRouteShare(plan.pricePerMonth),
      precision: planModelServePrecision(
        plan,
        eligible[0]!,
        state.player.researchUnlocked,
      ),
    };
  }
  return routes;
}

export function planDemandShockMultiplier(plan: SubPlan, day: number): number {
  let multiplier = 1;
  for (const shock of plan.demandShocks ?? []) {
    const age = Math.max(0, day - shock.startedDay);
    multiplier +=
      shock.amplitude * Math.pow(0.5, age / Math.max(1, shock.halfLifeDays));
  }
  return Math.max(0.5, Math.min(2.25, multiplier));
}

function appendPlanShock(
  shocks: readonly PlanDemandShock[] | undefined,
  shock: PlanDemandShock,
): PlanDemandShock[] {
  return [
    ...(shocks ?? []).filter(
      (item) => shock.startedDay - item.startedDay <= 84,
    ),
    shock,
  ].slice(-12);
}

/** Which serving formats the lab can assign on plans. */
export function unlockedPlanPrecisions(
  unlocked: string[],
): PlanServePrecision[] {
  const out: PlanServePrecision[] = ["fp32"];
  if (unlocked.includes("opt_fp16")) out.push("fp16");
  if (unlocked.includes("opt_mixed")) out.push("bf16");
  if (unlocked.includes("sys_quant")) out.push("int8");
  if (unlocked.includes("sys_fp8")) out.push("fp8");
  if (unlocked.includes("sys_int4") || unlocked.includes("sys_fp8"))
    out.push("int4");
  if (unlocked.includes("sys_nvfp4_runtime")) out.push("nvfp4");
  if (unlocked.includes("sys_bitnet_runtime")) out.push("ternary_1_58");
  return out;
}

export function clampServePrecision(
  p: PlanServePrecision | undefined,
  unlocked: string[],
): PlanServePrecision {
  const allowed = unlockedPlanPrecisions(unlocked);
  const want = p ?? "fp32";
  if (allowed.includes(want)) return want;
  if ((want === "int4" || want === "nvfp4") && allowed.includes("int8"))
    return "int8";
  if (want === "fp8" && allowed.includes("bf16")) return "bf16";
  if (want === "bf16" && allowed.includes("fp16")) return "fp16";
  return "fp32";
}

/** Research- and checkpoint-compatible formats shown for one plan model. */
export function availablePlanPrecisionsForModel(
  model: Model,
  unlocked: string[],
): PlanServePrecision[] {
  return unlockedPlanPrecisions(unlocked).filter(
    (precision) =>
      precision !== "ternary_1_58" ||
      model.trainingNumerics?.nativeWeightFormat === "ternary_1_58",
  );
}

export function clampModelServePrecision(
  model: Model,
  precision: PlanServePrecision | undefined,
  unlocked: string[],
): PlanServePrecision {
  const available = availablePlanPrecisionsForModel(model, unlocked);
  const clamped = clampServePrecision(precision, unlocked);
  if (available.includes(clamped)) return clamped;
  return available.includes("bf16")
    ? "bf16"
    : available.includes("fp16")
      ? "fp16"
      : "fp32";
}

/** Resolve an individual roster model's format with legacy-save fallbacks. */
export function planModelServePrecision(
  plan: SubPlan,
  model: Model,
  unlocked: string[],
): PlanServePrecision {
  const legacyRoute = Object.values(plan.modalityRoutes ?? {}).find(
    (route) => route?.primaryModelId === model.id,
  );
  return clampModelServePrecision(
    model,
    plan.servePrecisionByModel?.[model.id] ??
      legacyRoute?.precision ??
      plan.servePrecision,
    unlocked,
  );
}

function normalizedPlanModelPrecisions(
  state: SimState,
  plan: SubPlan,
): Record<string, PlanServePrecision> {
  return Object.fromEntries(
    planServingModelIds(state, plan).flatMap((modelId) => {
      const model = state.player.models.find(
        (candidate) => candidate.id === modelId,
      );
      return model
        ? [
            [
              modelId,
              planModelServePrecision(
                plan,
                model,
                state.player.researchUnlocked,
              ),
            ] as const,
          ]
        : [];
    }),
  );
}

/**
 * Quant trade-off: lower compute (inferCostMult) vs worse effective quality/cap.
 * int8 needs sys_quant; int4 needs sys_fp8.
 */
export function planServeModifiers(
  precision: PlanServePrecision | undefined,
  unlocked: string[],
): {
  precision: PlanServePrecision;
  /** Multiplies model.inferCostMult for PF demand (lower = cheaper) */
  computeMult: number;
  /** Multiplies perceived quality for demand */
  qualityMult: number;
  /** Added to capability for plan scoring / SOTA */
  capabilityDelta: number;
  /** Absolute score-point changes shown in plan eval previews. */
  benchmarkDeltas: Partial<Record<BenchmarkId, number>>;
  /** Daily brand risk at meaningful traffic; market scales this by usage. */
  brandRisk: number;
  label: string;
} {
  const p = clampServePrecision(precision, unlocked);
  // computeMult: single source of truth in SERVE_PRECISION_COMPUTE_MULT / precisionComputeMult.
  if (p === "ternary_1_58") {
    return {
      precision: p,
      computeMult: precisionComputeMult(p),
      qualityMult: 0.995,
      capabilityDelta: 0,
      benchmarkDeltas: {},
      brandRisk: 0.006,
      label: "Native 1.58-bit",
    };
  }
  if (p === "nvfp4") {
    return {
      precision: p,
      computeMult: precisionComputeMult(p),
      qualityMult: 0.985,
      capabilityDelta: -0.5,
      benchmarkDeltas: {},
      brandRisk: 0.018,
      label: "NVFP4 artifact",
    };
  }
  if (p === "int4") {
    return {
      precision: p,
      computeMult: precisionComputeMult(p),
      qualityMult: 0.93,
      capabilityDelta: -3,
      benchmarkDeltas: {
        mmlu: -2,
        coding: -4,
        math: -4,
        vision: -2,
        law: -3,
        health: -3,
        science: -3,
        multilingual: -2,
        agents: -4,
        safety: -1,
      },
      brandRisk: 0.08,
      label: "INT4 quant",
    };
  }
  if (p === "int8") {
    return {
      precision: p,
      computeMult: precisionComputeMult(p),
      qualityMult: 0.99,
      capabilityDelta: -0.5,
      benchmarkDeltas: {
        coding: -1,
        math: -1,
        agents: -1,
      },
      brandRisk: 0.012,
      label: "INT8 quant",
    };
  }
  if (p === "fp8") {
    return {
      precision: p,
      computeMult: precisionComputeMult(p),
      qualityMult: 0.995,
      capabilityDelta: 0,
      benchmarkDeltas: {},
      brandRisk: 0.004,
      label: "FP8 runtime",
    };
  }
  return {
    precision: p === "fp32" ? "fp32" : p === "bf16" ? "bf16" : "fp16",
    computeMult: precisionComputeMult(p),
    qualityMult: 1,
    capabilityDelta: 0,
    benchmarkDeltas: {},
    brandRisk: 0,
    label: p === "fp32" ? "FP32 full precision" : p === "bf16" ? "BF16 runtime" : "FP16 runtime",
  };
}

/** Model shape after applying one serving precision policy. */
export function modelForServePrecision(
  model: Model,
  precision: PlanServePrecision | undefined,
  unlocked: string[],
): Model {
  const requested =
    precision === "ternary_1_58" &&
    model.trainingNumerics?.nativeWeightFormat !== "ternary_1_58"
      ? "fp16"
      : precision;
  const m = planServeModifiers(requested, unlocked);
  return {
    ...model,
    inferCostMult: (model.inferCostMult ?? 1) * m.computeMult,
    capability: Math.max(5, model.capability + m.capabilityDelta),
    quality: {
      ...model.quality,
      reasoning: model.quality.reasoning * m.qualityMult,
      coding: model.quality.coding * m.qualityMult,
      chat: model.quality.chat * m.qualityMult,
      reliability:
        model.quality.reliability * Math.min(1, m.qualityMult + 0.05),
    },
    benchmarks: Object.fromEntries(
      Object.entries(model.benchmarks).map(([id, score]) => [
        id,
        Math.max(0, score + (m.benchmarkDeltas[id as BenchmarkId] ?? 0)),
      ]),
    ) as Model["benchmarks"],
  };
}

/** Model shape for plan traffic after quant modifiers. */
export function modelForPlanServe(
  model: Model,
  plan: SubPlan,
  unlocked: string[],
): Model {
  return modelForServePrecision(
    model,
    planModelServePrecision(plan, model, unlocked),
    unlocked,
  );
}

export interface PlanModelTraffic {
  model: Model;
  share: number;
}

export function defaultPlanComputePriority(
  plan: Pick<SubPlan, "pricePerMonth">,
): number {
  if (plan.pricePerMonth <= 0) return 20;
  if (plan.pricePerMonth <= 25) return 55;
  if (plan.pricePerMonth <= 100) return 75;
  if (plan.pricePerMonth <= 180) return 85;
  return 95;
}

export function planComputePriority(
  plan: Pick<SubPlan, "pricePerMonth" | "computePriority">,
): number {
  const value = plan.computePriority ?? defaultPlanComputePriority(plan);
  return Math.max(10, Math.min(100, Number.isFinite(value) ? value : 50));
}

/**
 * Weighted fair allocation inside the subscription PF pool. Plans receive
 * service in proportion to configured priority, with unused PF redistributed
 * when a smaller plan becomes fully served.
 */
export function allocatePlanCompute<
  T extends { plan: SubPlan; demandPf: number },
>(buckets: readonly T[], capacityPf: number): Map<string, number> {
  const fractions = new Map<string, number>();
  const remaining = new Map<string, number>();
  for (const bucket of buckets) {
    const demand = Math.max(0, bucket.demandPf);
    remaining.set(bucket.plan.id, demand);
    fractions.set(bucket.plan.id, demand <= 1e-9 ? 1 : 0);
  }
  let pool = Math.max(0, capacityPf);
  const totalDemand = [...remaining.values()].reduce(
    (sum, demand) => sum + demand,
    0,
  );
  if (totalDemand <= pool * 1.02) {
    for (const bucket of buckets) fractions.set(bucket.plan.id, 1);
    return fractions;
  }

  for (let pass = 0; pass < buckets.length + 2 && pool > 1e-9; pass += 1) {
    const active = buckets.filter(
      (bucket) => (remaining.get(bucket.plan.id) ?? 0) > 1e-9,
    );
    if (active.length === 0) break;
    const totalWeight = active.reduce(
      (sum, bucket) => sum + planComputePriority(bucket.plan),
      0,
    );
    if (totalWeight <= 0) break;
    const passPool = pool;
    let spent = 0;
    for (const bucket of active) {
      const id = bucket.plan.id;
      const need = remaining.get(id) ?? 0;
      const share = passPool * (planComputePriority(bucket.plan) / totalWeight);
      const allocation = Math.min(need, share);
      remaining.set(id, Math.max(0, need - allocation));
      spent += allocation;
    }
    if (spent <= 1e-12) break;
    pool = Math.max(0, pool - spent);
  }

  for (const bucket of buckets) {
    const demand = Math.max(0, bucket.demandPf);
    const unserved = remaining.get(bucket.plan.id) ?? 0;
    fractions.set(
      bucket.plan.id,
      demand <= 1e-9
        ? 1
        : Math.max(0, Math.min(1, (demand - unserved) / demand)),
    );
  }
  return fractions;
}

export function planServingModelIds(state: SimState, plan: SubPlan): string[] {
  return planExposedModelIds(
    plan,
    state.player.models,
    state.player.modelRouters,
  );
}

function livePlanModels(state: SimState, ids: readonly string[]): Model[] {
  return ids
    .map((id) =>
      state.player.models.find(
        (model) => model.id === id && isCommerciallyOffered(model),
      ),
    )
    .filter((model): model is Model => Boolean(model));
}

function qualityEfficiencyMix(
  state: SimState,
  plan: SubPlan,
  selected: readonly Model[],
): PlanModelTraffic[] {
  if (selected.length === 0) return [];
  const served = selected.map((model) =>
    modelForPlanServe(model, plan, state.player.researchUnlocked),
  );
  const facingCaps = served.map(
    (model) => agedMarketView(model, state.day).capability,
  );
  const maxCapability = Math.max(...facingCaps, 1);
  const pfPerMTok = served.map((model) =>
    Math.max(1e-6, inferencePfDemand(1, model, 1)),
  );
  const cheapest = Math.min(...pfPerMTok);
  const free = isFreePlan(plan);
  const premium = plan.pricePerMonth > 180;
  const weights = served.map((_model, index) => {
    const quality = Math.max(0.15, facingCaps[index]! / maxCapability);
    const efficiency = Math.max(0.15, cheapest / pfPerMTok[index]!);
    if (free) return Math.pow(efficiency, 1.45) * (0.45 + quality * 0.55);
    const capabilityGap = Math.max(0, maxCapability - facingCaps[index]!);
    const sotaBias = Math.exp(-capabilityGap / (premium ? 4.5 : 7));
    if (premium)
      return Math.pow(quality, 4.5) * sotaBias * (0.88 + efficiency * 0.12);
    return Math.pow(quality, 3.2) * sotaBias * (0.82 + efficiency * 0.18);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  return served.map((model, index) => ({
    model,
    share: weights[index]! / total,
  }));
}

function routerPartsToTraffic(
  state: SimState,
  plan: SubPlan,
  parts: readonly { model: Model; share: number }[],
): PlanModelTraffic[] {
  const total = parts.reduce((sum, part) => sum + part.share, 0);
  if (total <= 1e-9) return [];
  return parts.map((part) => ({
    model: modelForPlanServe(part.model, plan, state.player.researchUnlocked),
    share: part.share / total,
  }));
}

/**
 * Token router for the plan's released-model roster. Free plans favor
 * efficient models; expensive plans route more traffic to higher capability.
 * Legacy primary/fallback fields are intentionally ignored here so a removed
 * model can never continue receiving hidden fallback traffic.
 */
export function planModelTrafficMix(
  state: SimState,
  plan: SubPlan,
): PlanModelTraffic[] {
  const routed = planRouterTrafficMix(state, plan);
  if (routed) return routed;
  return qualityEfficiencyMix(
    state,
    plan,
    livePlanModels(state, planServingModelIds(state, plan)),
  );
}

function planRouterTrafficMix(
  state: SimState,
  plan: SubPlan,
): PlanModelTraffic[] | null {
  const assigned = planAssignedRouters(plan, state.player.modelRouters);
  const usingPlanRouters = assigned.length > 0;
  const routers = usingPlanRouters
    ? assigned
    : (() => {
        const routerId = state.player.activeModelRouterId;
        if (!routerId) return [];
        return planAssignedRouters(
          { routerIds: [routerId] },
          state.player.modelRouters,
        );
      })();
  if (routers.length === 0) return null;

  const roster = new Set(plan.modelIds);
  const memberIds = new Set(
    routers.flatMap((router) =>
      planExposedModelIds(
        { modelIds: [], routerIds: [router.id] },
        state.player.models,
        [router],
      ),
    ),
  );
  const eligible = state.player.models.filter((model) => {
    if (!isCommerciallyOffered(model)) return false;
    if (usingPlanRouters) return memberIds.has(model.id);
    return roster.size === 0 || roster.has(model.id);
  });
  const perRouter = routers
    .map((router) =>
      collapseRouterShares(planRouterParts(router, eligible, plan)),
    )
    .filter((parts) => parts.length > 0);
  if (perRouter.length === 0) return null;
  const merged = collapseRouterShares(
    perRouter.flatMap((parts) =>
      parts.map((part) => ({
        lane: "default" as const,
        model: part.model,
        share: part.share / perRouter.length,
      })),
    ),
  );
  const routed = routerPartsToTraffic(state, plan, merged);
  if (routed.length === 0) return null;

  if (!usingPlanRouters) return routed;

  const extra = livePlanModels(
    state,
    plan.modelIds.filter((id) => !memberIds.has(id)),
  );
  if (extra.length === 0) return routed;
  const extraMix = qualityEfficiencyMix(state, plan, extra);
  const routerWeight =
    memberIds.size / Math.max(1, memberIds.size + extra.length);
  const extraWeight = 1 - routerWeight;
  return [
    ...routed.map((lane) => ({ ...lane, share: lane.share * routerWeight })),
    ...extraMix.map((lane) => ({ ...lane, share: lane.share * extraWeight })),
  ];
}

export interface PremiumPlanScrutiny {
  applies: boolean;
  entryPlanName: string | null;
  expectedUsageRatio: number;
  actualUsageRatio: number;
  shortfall: number;
}

/** Plans above $180/mo are judged against the company's cheapest paid tier. */
export function premiumPlanScrutiny(
  plan: SubPlan,
  allPlans: readonly SubPlan[],
  /** Subsidy-aware allowance resolver; falls back to the stored fields. */
  allowanceFor?: (candidate: SubPlan) => number,
): PremiumPlanScrutiny {
  const allowanceOf = allowanceFor ?? planAllowanceMTokPerMonth;
  const entry = allPlans
    .filter(
      (candidate) =>
        candidate.enabled &&
        candidate.pricePerMonth > 0 &&
        candidate.id !== plan.id,
    )
    .sort((a, b) => a.pricePerMonth - b.pricePerMonth)[0];
  if (plan.pricePerMonth <= 180 || !entry) {
    return {
      applies: false,
      entryPlanName: entry?.name ?? null,
      expectedUsageRatio: 20,
      actualUsageRatio: 0,
      shortfall: 0,
    };
  }
  const actualUsageRatio =
    allowanceOf(plan) / Math.max(0.001, allowanceOf(entry));
  return {
    applies: true,
    entryPlanName: entry.name,
    expectedUsageRatio: 20,
    actualUsageRatio,
    shortfall: Math.max(0, 1 - actualUsageRatio / 20),
  };
}

export function isFreePlan(plan: SubPlan): boolean {
  return plan.pricePerMonth <= 0;
}

/** Plan usage mult: 0.025× (0.5 MTok/mo floor) → 500× (enterprise power seats). */
export function clampMultiplier(n: number): number {
  if (!Number.isFinite(n)) return 1;
  const min =
    MIN_PLAN_ALLOWANCE_MTOK_PER_MONTH /
    (ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth);
  return Math.max(min, Math.min(500, n));
}

/** Soft max monthly price — higher only justified by token value + model quality. */
export function clampPlanPrice(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(ECONOMY.planMaxPricePerMonth ?? 25_000, n));
}

export function createPlan(
  state: SimState,
  input: {
    name: string;
    pricePerMonth: number;
    usageMultiplier: number;
    modelIds?: string[];
    /** Authoritative fixed monthly allowance. */
    includedMTokPerMonth?: number;
    /** Legacy/display-only API-equivalent value. */
    monthlyApiValueSubsidyGbp?: number;
  },
): SimState {
  if (state.player.pricing.plans.length >= MAX_PLANS) {
    return {
      ...state,
      alerts: [
        {
          id: `plan-new-blocked-${state.day}-${state.player.pricing.plans.length}`,
          day: state.day,
          severity: "warn" as const,
          message: `Plan limit reached (${MAX_PLANS}). Delete a plan before creating another.`,
        },
        ...state.alerts,
      ].slice(0, 40),
    };
  }
  let modelIds = input.modelIds ? [...input.modelIds] : [];
  if (modelIds.length === 0 && state.player.pricing.activeModelId) {
    modelIds = [state.player.pricing.activeModelId];
  }
  const usageMultiplier = clampMultiplier(input.usageMultiplier);
  const includedMTokPerMonth = clampAllowanceMTokPerMonth(
    input.includedMTokPerMonth ??
      ECONOMY.basePlanUsageMTokPerDay * usageMultiplier * ECONOMY.daysPerMonth,
  );
  const plan: SubPlan = {
    id: seededId(
      "plan",
      state.seed,
      state.day,
      input.name,
      state.player.pricing.plans.length,
    ),
    name: input.name.trim() || "New plan",
    pricePerMonth: clampPlanPrice(input.pricePerMonth),
    usageMultiplier,
    includedMTokPerMonth,
    monthlyApiValueSubsidyGbp: sanitizeSubsidyGbp(
      input.monthlyApiValueSubsidyGbp,
    ),
    usageRate: null,
    modelIds,
    computePriority: defaultPlanComputePriority({
      pricePerMonth: input.pricePerMonth,
    }),
    servePrecision: isFreePlan({
      pricePerMonth: input.pricePerMonth,
    } as SubPlan) && unlockedPlanPrecisions(state.player.researchUnlocked).includes("int8")
      ? "int8"
      : clampServePrecision("fp16", state.player.researchUnlocked),
    servePrecisionByModel: {},
    steadyUsageTarget: defaultSteadyPlanUsage(input.pricePerMonth),
    dataCollectionRate: defaultPlanDataCollectionRate(input.pricePerMonth),
    modalityRoutes: {},
    demandShocks: [],
    enabled: true,
  };
  plan.servePrecisionByModel = normalizedPlanModelPrecisions(state, plan);
  plan.modalityRoutes = normalizedPlanRoutes(state, plan);
  for (const route of Object.values(plan.modalityRoutes)) {
    if (!route?.primaryModelId) continue;
    plan.demandShocks = appendPlanShock(plan.demandShocks, {
      id: seededId(
        "plan-shock",
        state.seed,
        state.day,
        plan.id,
        route.modality,
      ),
      kind: "launch",
      modality: route.modality,
      modelId: route.primaryModelId,
      startedDay: state.day,
      amplitude: 0.35,
      halfLifeDays: 14,
    });
  }

  return {
    ...state,
    player: {
      ...state.player,
      pricing: {
        ...state.player.pricing,
        plans: [...state.player.pricing.plans, plan],
      },
    },
    alerts: [
      {
        id: `plan-new-${plan.id}`,
        day: state.day,
        severity: "info" as const,
        message: `Plan created: ${plan.name} ($${plan.pricePerMonth}/mo · ${plan.usageMultiplier}x · ${formatAllowance(plan)} tokens)`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

export function updatePlan(
  state: SimState,
  planId: string,
  patch: Partial<SubPlan>,
): SimState {
  const pricingEvents: FeedEventInput[] = [];
  const plans = state.player.pricing.plans.map((p) => {
    if (p.id !== planId) return p;
    // The legacy advertised value is presentation only. It never derives or
    // mutates the physical allowance.
    const subsidy =
      patch.monthlyApiValueSubsidyGbp !== undefined
        ? sanitizeSubsidyGbp(patch.monthlyApiValueSubsidyGbp)
        : p.monthlyApiValueSubsidyGbp;
    const usageMultiplier =
      patch.includedMTokPerMonth !== undefined
        ? clampMultiplier(
            Math.max(0.001, patch.includedMTokPerMonth) /
              (ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth),
          )
        : patch.usageMultiplier !== undefined
          ? clampMultiplier(patch.usageMultiplier)
          : p.usageMultiplier;
    const includedMTokPerMonth =
      patch.includedMTokPerMonth !== undefined
        ? clampAllowanceMTokPerMonth(patch.includedMTokPerMonth)
        : patch.usageMultiplier !== undefined
          ? ECONOMY.basePlanUsageMTokPerDay *
            usageMultiplier *
            ECONOMY.daysPerMonth
          : (p.includedMTokPerMonth ??
            ECONOMY.basePlanUsageMTokPerDay *
              p.usageMultiplier *
              ECONOMY.daysPerMonth);
    const next: SubPlan = {
      ...p,
      ...patch,
      id: p.id,
      pricePerMonth:
        patch.pricePerMonth !== undefined
          ? clampPlanPrice(patch.pricePerMonth)
          : p.pricePerMonth,
      usageMultiplier,
      includedMTokPerMonth,
      monthlyApiValueSubsidyGbp: subsidy,
      usageRate: null,
      computePriority:
        patch.computePriority !== undefined
          ? planComputePriority({
              pricePerMonth: patch.pricePerMonth ?? p.pricePerMonth,
              computePriority: patch.computePriority,
            })
          : (p.computePriority ?? defaultPlanComputePriority(p)),
      servePrecision:
        patch.servePrecision !== undefined
          ? clampServePrecision(
              patch.servePrecision,
              state.player.researchUnlocked,
            )
          : clampServePrecision(p.servePrecision, state.player.researchUnlocked),
      steadyUsageTarget:
        patch.steadyUsageTarget !== undefined
          ? Math.max(0.02, Math.min(0.9, patch.steadyUsageTarget))
          : (p.steadyUsageTarget ??
            defaultSteadyPlanUsage(patch.pricePerMonth ?? p.pricePerMonth)),
      name: patch.name !== undefined ? patch.name.trim() || p.name : p.name,
    };
    const nextPrice = next.pricePerMonth;
    const prevCap = maxPlanDataCollectionShare(p.pricePerMonth);
    const nextCap = maxPlanDataCollectionShare(nextPrice);
    next.dataCollectionRate = clampPlanDataCollectionRate(
      nextPrice,
      patch.dataCollectionRate !== undefined
        ? patch.dataCollectionRate
        : nextCap <= 0
          ? 0
          : prevCap <= 0 && patch.pricePerMonth !== undefined
            ? defaultPlanDataCollectionRate(nextPrice)
            : (p.dataCollectionRate ??
              defaultPlanDataCollectionRate(nextPrice)),
    );
    const requestedPrecisions =
      patch.servePrecisionByModel !== undefined
        ? patch.servePrecisionByModel
        : patch.servePrecision !== undefined
          ? Object.fromEntries(
              planServingModelIds(state, next).map((modelId) => [
                modelId,
                patch.servePrecision!,
              ]),
            )
          : p.servePrecisionByModel;
    next.servePrecisionByModel = normalizedPlanModelPrecisions(state, {
      ...next,
      servePrecisionByModel: requestedPrecisions,
    });
    const servingIds = planServingModelIds(state, next);
    const firstModelPrecision = servingIds[0]
      ? next.servePrecisionByModel[servingIds[0]]
      : undefined;
    if (firstModelPrecision) next.servePrecision = firstModelPrecision;
    // The model roster is authoritative after any edit. Rebuild compatibility
    // routes without hidden fallback assignments.
    next.modalityRoutes = normalizedPlanRoutes(state, {
      ...next,
      modalityRoutes: {},
    });
    let shocks = next.demandShocks ?? [];
    const oldIds = new Set(planServingModelIds(state, p));
    const newIds = new Set(servingIds);
    for (const modelId of newIds) {
      if (oldIds.has(modelId)) continue;
      const model = state.player.models.find(
        (candidate) => candidate.id === modelId,
      );
      const modality =
        (["text", "image", "audio", "video"] as ModelIOModality[]).find(
          (candidate) => model && modelSupportsOutput(model, candidate),
        ) ?? "text";
      shocks = appendPlanShock(shocks, {
        id: seededId("plan-shock", state.seed, state.day, p.id, modelId, "add"),
        kind: "launch",
        modality,
        modelId,
        startedDay: state.day,
        amplitude: 0.35,
        halfLifeDays: 14,
      });
    }
    for (const modelId of oldIds) {
      if (newIds.has(modelId)) continue;
      shocks = appendPlanShock(shocks, {
        id: seededId(
          "plan-shock",
          state.seed,
          state.day,
          p.id,
          modelId,
          "remove",
        ),
        kind: "removal",
        modality: "text",
        modelId,
        startedDay: state.day,
        amplitude: servingIds.length > 0 ? -0.15 : -0.4,
        halfLifeDays: 21,
      });
    }
    for (const modelId of servingIds) {
      if (!oldIds.has(modelId)) continue;
      const model = state.player.models.find(
        (candidate) => candidate.id === modelId,
      );
      if (!model) continue;
      const before = planModelServePrecision(
        p,
        model,
        state.player.researchUnlocked,
      );
      const after = planModelServePrecision(
        next,
        model,
        state.player.researchUnlocked,
      );
      if (before === after) continue;
      const modality =
        (["text", "image", "audio", "video"] as ModelIOModality[]).find(
          (candidate) => modelSupportsOutput(model, candidate),
        ) ?? "text";
      shocks = appendPlanShock(shocks, {
        id: seededId("plan-shock", state.seed, state.day, p.id, modelId, after),
        kind: "quantization",
        modality,
        modelId,
        startedDay: state.day,
        amplitude: -0.1,
        halfLifeDays: 21,
      });
    }
    next.demandShocks = shocks;
    if (
      patch.pricePerMonth !== undefined &&
      Math.abs(next.pricePerMonth - p.pricePerMonth) > 1e-9
    ) {
      const direction = next.pricePerMonth > p.pricePerMonth ? "raises" : "cuts";
      pricingEvents.push({
        id: `feed-plan-price-${p.id}-${state.day}-${Math.round(next.pricePerMonth * 100)}`,
        day: state.day,
        category: "market",
        title: `${state.player.name} ${direction} ${next.name} pricing`,
        body: `${next.name} moved from $${p.pricePerMonth.toFixed(2)}/month to $${next.pricePerMonth.toFixed(2)}/month; subscriber demand and retention will re-price on the next market settlement.`,
        source: state.player.name,
        tone: next.pricePerMonth < p.pricePerMonth ? "positive" : "warning",
        entityId: state.playerLabId,
        kind: "player_plan_price_change",
      });
    }
    return next;
  });
  const nextState = {
    ...state,
    player: {
      ...state.player,
      pricing: { ...state.player.pricing, plans },
    },
  };
  return appendFeedEvents(nextState, pricingEvents);
}

export function deletePlan(state: SimState, planId: string): SimState {
  const plans = state.player.pricing.plans.filter((p) => p.id !== planId);
  if (plans.length === state.player.pricing.plans.length) return state;
  if (plans.length === 0) {
    return {
      ...state,
      alerts: [
        {
          id: `plan-del-fail-${state.day}`,
          day: state.day,
          severity: "warn" as const,
          message: "Keep at least one plan.",
        },
        ...state.alerts,
      ].slice(0, 40),
    };
  }
  return {
    ...state,
    player: {
      ...state.player,
      pricing: { ...state.player.pricing, plans },
    },
  };
}

/** Attach newly shipped models to plans with empty model lists. */
export function attachModelToEmptyPlans(
  state: SimState,
  modelId: string,
): SimState {
  const plans = state.player.pricing.plans.map((p) => {
    if (p.modelIds.length > 0 || (p.routerIds?.length ?? 0) > 0) return p;
    const model = state.player.models.find(
      (candidate) => candidate.id === modelId,
    );
    const precision = model
      ? clampModelServePrecision(
          model,
          p.servePrecision,
          state.player.researchUnlocked,
        )
      : clampServePrecision(p.servePrecision, state.player.researchUnlocked);
    const next = {
      ...p,
      modelIds: [modelId],
      servePrecisionByModel: { [modelId]: precision },
    };
    const routes = normalizedPlanRoutes(state, next);
    const modality = (Object.keys(routes) as ModelIOModality[])[0] ?? "text";
    return {
      ...next,
      modalityRoutes: routes,
      demandShocks: appendPlanShock(p.demandShocks, {
        id: seededId("plan-shock", state.seed, state.day, p.id, modelId),
        kind: "launch",
        modality,
        modelId,
        startedDay: state.day,
        amplitude: 0.35,
        halfLifeDays: 14,
      }),
    };
  });
  return {
    ...state,
    player: {
      ...state.player,
      pricing: { ...state.player.pricing, plans },
    },
  };
}

/** Max allowance MTok/user/day (before utilization %). */
export function planAllowanceMTokPerDay(plan: SubPlan): number {
  return planAllowanceMTokPerMonth(plan) / ECONOMY.daysPerMonth;
}

/** Monthly included token allowance (MTok/user/mo at full utilization). */
export function planAllowanceMTokPerMonth(plan: SubPlan): number {
  if (
    Number.isFinite(plan.includedMTokPerMonth) &&
    (plan.includedMTokPerMonth ?? 0) > 0
  ) {
    return plan.includedMTokPerMonth!;
  }
  return (
    ECONOMY.basePlanUsageMTokPerDay *
    plan.usageMultiplier *
    ECONOMY.daysPerMonth
  );
}

/** Lowest included usage the editor will accept (~16k tokens/day). */
export const MIN_PLAN_ALLOWANCE_MTOK_PER_MONTH = 0.5;

/** Bounds for the plan's physical monthly text entitlement. */
export function clampAllowanceMTokPerMonth(value: number): number {
  const min = MIN_PLAN_ALLOWANCE_MTOK_PER_MONTH;
  const max = ECONOMY.basePlanUsageMTokPerDay * 500 * ECONOMY.daysPerMonth;
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/** True when a legacy plan retains an advertised API-equivalent value. */
export function planHasApiValueSubsidy(plan: SubPlan): boolean {
  return (
    Number.isFinite(plan.monthlyApiValueSubsidyGbp) &&
    (plan.monthlyApiValueSubsidyGbp ?? 0) > 0
  );
}

function sanitizeSubsidyGbp(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(250_000, value);
}

/**
 * Current API-equivalent customer value. It is always derived from the fixed
 * physical allowance and the supplied market reference price; a stale legacy
 * subsidy field cannot manufacture entitlement or attractiveness.
 */
export function planMonthlyApiValueSubsidy(
  plan: SubPlan,
  fallbackBlendedApiPrice: number,
): number {
  return (
    planAllowanceMTokPerMonth(plan) *
    Math.max(API_PRICE_EPSILON, fallbackBlendedApiPrice)
  );
}

/**
 * Fixed plan allowance. The price argument remains for source compatibility,
 * but changing an API list price intentionally cannot change subscription use.
 */
export function planModelEntitlementMTok(
  plan: SubPlan,
  _blendedApiPricePerMTok: number,
): number {
  return planAllowanceMTokPerMonth(plan);
}

/**
 * Effective plan-level allowance is the configured resource promise. Model
 * routing changes its PF cost and attainable service, not the advertised use.
 */
export function planEffectiveAllowanceMTokPerMonth(
  _state: SimState,
  plan: SubPlan,
): number {
  return planAllowanceMTokPerMonth(plan);
}

export interface PlanModelEntitlement {
  modelId: string;
  name: string;
  kind: CommercialModelKind;
  /** Share of the plan's traffic routed to this model. */
  trafficShare: number;
  /** Blended public API list price: input × expected input share + output × expected output share. */
  blendedApiPricePerMTok: number;
  /** Fixed plan MTok allocated to this model by its routing share. */
  includedMTokPerMonth: number;
  /** Expected tokens per interaction for this model's workload. */
  tokensPerInteraction: number;
  /** Approximate daily interactions = included tokens ÷ interaction size ÷ 30. */
  interactionsPerDay: number;
  /** Band-based expected allowance utilization for the plan. */
  expectedUtilization: number;
  /** API-equivalent value of traffic routed to this model (£/mo, full use). */
  apiEquivalentValuePerMonth: number;
  /** Raw serving cost of traffic routed to this model (£/mo, expected use). */
  rawServingCostPerMonth: number | null;
}

/**
 * Per-model allocation table for a plan. A fixed plan entitlement is divided
 * by the actual routing mix; expensive models consume more PF but cannot make
 * the allowance disappear when their public API price changes.
 */
export function planModelEntitlements(
  state: SimState,
  plan: SubPlan,
  opts?: {
    modelCapability?: number;
    frontierCapability?: number;
    /** Raw serving £/MTok for a precision-adjusted model; enables cost rows. */
    rawCostPerMTok?: (model: Model) => number;
  },
): PlanModelEntitlement[] {
  const mix = planModelTrafficMix(state, plan);
  const sota = sotaProximityLocal(
    opts?.modelCapability ?? 40,
    opts?.frontierCapability ?? 50,
  );
  const [low, high] = expectedUtilizationRange(plan.pricePerMonth);
  const expectedUtilization = low + (high - low) * sota;
  return mix.map((lane) => {
    const blended = modelBlendedPublicApiPrice(
      state.player.pricing,
      lane.model,
    );
    const included = planModelEntitlementMTok(plan, blended) * lane.share;
    const kind = commercialModelKind(lane.model);
    const tokensPerInteraction = avgTokensPerInteraction(kind);
    const rawCostPerMTok = opts?.rawCostPerMTok?.(lane.model);
    return {
      modelId: lane.model.id,
      name: lane.model.name,
      kind,
      trafficShare: lane.share,
      blendedApiPricePerMTok: blended,
      includedMTokPerMonth: included,
      tokensPerInteraction,
      interactionsPerDay:
        (included * 1_000_000) / tokensPerInteraction / ECONOMY.daysPerMonth,
      expectedUtilization,
      apiEquivalentValuePerMonth: included * blended,
      rawServingCostPerMonth:
        rawCostPerMTok != null
          ? included * expectedUtilization * Math.max(0, rawCostPerMTok)
          : null,
    };
  });
}

/** £500+ tiers must advertise at least this multiple of price in API value. */
export const ENTERPRISE_PLAN_MIN_PRICE = 500;
export const ENTERPRISE_SUBSIDY_PRICE_MULTIPLE = 5;

export interface EnterpriseSubsidyExpectation {
  applies: boolean;
  requiredSubsidyGbp: number;
  subsidyGbp: number;
  /** 0 = clears the 5× rule; 1 = no meaningful advertised subsidy at all. */
  shortfall: number;
}

/**
 * Enterprise/near-unlimited tiers (£500+/mo) are judged on advertised value:
 * monthly API-value subsidy ≥ 5× price. Configured lower, customers see a bad
 * deal (value warning) and enterprise demand falls.
 */
export function enterpriseSubsidyExpectation(
  plan: SubPlan,
  subsidyGbp: number,
): EnterpriseSubsidyExpectation {
  if (plan.pricePerMonth < ENTERPRISE_PLAN_MIN_PRICE) {
    return {
      applies: false,
      requiredSubsidyGbp: 0,
      subsidyGbp: Math.max(0, subsidyGbp),
      shortfall: 0,
    };
  }
  const requiredSubsidyGbp =
    plan.pricePerMonth * ENTERPRISE_SUBSIDY_PRICE_MULTIPLE;
  const actual = Math.max(0, subsidyGbp);
  return {
    applies: true,
    requiredSubsidyGbp,
    subsidyGbp: actual,
    shortfall: Math.max(
      0,
      Math.min(1, 1 - actual / Math.max(1, requiredSubsidyGbp)),
    ),
  };
}

export interface PlanUpgradePressure {
  /** 0–1: how close the plan's model is to the public frontier. */
  sotaLead: number;
  /** 0–1: how much the plan's customer band cares about the model's workload. */
  relevance: number;
  /** 0–1: entitlement improvement over the lab's cheaper paid tiers. */
  entitlementImprovement: number;
  /** 0–1: how reachable the price is from the next cheaper paid tier. */
  affordability: number;
  /** 0–1: model reliability gate. */
  reliability: number;
  /** Final upgrade pressure: product of the five factors (0–1). */
  pressure: number;
}

/**
 * SOTA-driven upgrade pressure for one plan: SOTA lead × relevance to the
 * customer band × entitlement improvement × affordability × reliability.
 * Coders move for coding/reasoning models, creative users for image/video,
 * power users toward high-subsidy tiers; value customers stay unless the
 * value difference is large — so SOTA never pushes everyone into the top tier.
 */
export function planUpgradePressure(input: {
  pricePerMonth: number;
  subsidyGbp: number;
  modelCapability: number;
  modelReliability: number;
  kind: CommercialModelKind;
  frontierCapability: number;
  cheaperPlans: readonly { pricePerMonth: number; subsidyGbp: number }[];
}): PlanUpgradePressure {
  const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
  const band = customerBandForPrice(input.pricePerMonth);
  const sotaLead = sotaProximityLocal(
    input.modelCapability,
    input.frontierCapability,
  );
  const relevance = clamp01(band.relevance[input.kind] ?? 0.7);
  const price = Math.max(1, input.pricePerMonth);
  const ownValue = Math.max(0, input.subsidyGbp) / price;
  const cheaperPaid = input.cheaperPlans.filter(
    (candidate) =>
      candidate.pricePerMonth > 0 &&
      candidate.pricePerMonth < input.pricePerMonth,
  );
  const cheaperBestValue = cheaperPaid.reduce(
    (best, candidate) =>
      Math.max(
        best,
        Math.max(0, candidate.subsidyGbp) /
          Math.max(1, candidate.pricePerMonth),
      ),
    0,
  );
  // Value-conscious customers need a clearly better deal to move upward.
  const valueRatio =
    cheaperBestValue > 0 ? ownValue / cheaperBestValue : 1 + ownValue;
  const threshold = input.pricePerMonth > 40 ? 1.25 : 1;
  const entitlementImprovement =
    valueRatio >= threshold
      ? clamp01(Math.log2(Math.max(1, valueRatio / threshold)) / 2 + 0.3)
      : 0;
  const cheaperMaxPrice = cheaperPaid.reduce(
    (max, candidate) => Math.max(max, candidate.pricePerMonth),
    0,
  );
  const affordability =
    cheaperMaxPrice > 0
      ? clamp01(
          Math.pow(3 / Math.max(1, input.pricePerMonth / cheaperMaxPrice), 1.1),
        )
      : clamp01(Math.pow(40 / Math.max(10, input.pricePerMonth), 0.8));
  const reliability = clamp01(input.modelReliability / 100);
  const pressure = clamp01(
    sotaLead * relevance * entitlementImprovement * affordability * reliability,
  );
  return {
    sotaLead,
    relevance,
    entitlementImprovement,
    affordability,
    reliability,
    pressure,
  };
}

export interface PlanAllowanceExpectation {
  minimumMTok: number;
  recommendedMTok: number;
  maximumMTok: number;
  dissatisfaction: number;
  label: string;
}

/**
 * Customer allowance expectations scale roughly with monthly price. Free
 * products still need at least 1M tokens/month to feel like a real product;
 * paid tiers are judged at roughly 1–1.5M tokens per monthly dollar.
 *
 * Heavy workloads (reasoning ≈ 5.7× language tokens/interaction) raise the
 * MTok bar so the same allowance feels stingier when interactions burn faster.
 *
 * Stingy gate (opts.valueRatio / opts.rivalValueRatio): a paid plan is only
 * judged stingy when it actually loses on value — less advertised API value
 * than the nearest rival tier, or a subsidy below its own monthly price.
 * Plans that beat rivals on value never accrue allowance dissatisfaction.
 */
export function planAllowanceExpectation(
  plan: SubPlan,
  /** Subsidy-derived effective allowance; falls back to the stored fields. */
  allowanceMTokOverride?: number,
  opts?: {
    /** Avg tokens per interaction for the plan's backing model. */
    tokensPerInteraction?: number;
    /** Our advertised API value ÷ monthly price (stingy gate). */
    valueRatio?: number;
    /** Rival nearest tier advertised API value ÷ price (stingy gate). */
    rivalValueRatio?: number;
  },
): PlanAllowanceExpectation {
  const allowance = allowanceMTokOverride ?? planAllowanceMTokPerMonth(plan);
  const free = isFreePlan(plan);
  const languageTokens = avgTokensPerInteraction("language");
  const burnMult = Math.max(
    1,
    (opts?.tokensPerInteraction ?? languageTokens) / languageTokens,
  );
  const minimumMTok = (free ? 1 : Math.max(1, plan.pricePerMonth)) * burnMult;
  const recommendedMTok =
    (free ? 10 : Math.max(plan.pricePerMonth, plan.pricePerMonth * 1.25)) *
    burnMult;
  const maximumMTok =
    (free
      ? 25
      : Math.max(plan.pricePerMonth * 1.25, plan.pricePerMonth * 1.5)) *
    burnMult;
  const shortfall =
    Math.max(0, minimumMTok - allowance) / Math.max(1, minimumMTok);
  let dissatisfaction =
    shortfall <= 1e-9 ? 0 : Math.min(1, 0.2 + shortfall * 0.8);
  // Stingy gate — only judge paid plans that lose the value comparison.
  if (
    !free &&
    opts?.valueRatio != null &&
    opts?.rivalValueRatio != null &&
    !planStinginessApplies(opts.valueRatio, opts.rivalValueRatio)
  ) {
    dissatisfaction = 0;
  }
  return {
    minimumMTok,
    recommendedMTok,
    maximumMTok,
    dissatisfaction,
    label: free
      ? `Free users expect at least ${minimumMTok.toFixed(0)}M tokens/month.`
      : `$${plan.pricePerMonth.toFixed(0)} plans are judged against ${minimumMTok.toFixed(0)}–${maximumMTok.toFixed(0)}M tokens/month.`,
  };
}

/**
 * Loss-making plans feel unstable: users expect throttling, surprise limits, or
 * withdrawal. Free users tolerate subsidy, but a visibly unsustainable tier
 * still carries a large demand penalty.
 */
export function planStabilityDissatisfaction(
  isFree: boolean,
  marginPerSubMonth: number,
  pricePerMonth: number,
): number {
  const lossRatio =
    Math.max(0, -marginPerSubMonth) / Math.max(10, pricePerMonth || 20);
  if (lossRatio <= 0) return 0;
  return isFree
    ? Math.min(0.75, 0.35 + lossRatio * 0.45)
    : Math.min(1, 0.15 + lossRatio * 1.1);
}

export type FreeTierDemandBand =
  "popular" | "semi_popular" | "cost_constrained";

/** Legacy display band; demand itself is continuous across this rank. */
export const FREE_TIER_TOP_MODEL_RANK = 40;

/**
 * Rank every released model across player + rivals by capability (1 = best).
 * Ties break by model id for stable ordering.
 */
export function releasedModelCapabilityRanks(
  state: SimState,
): Map<string, number> {
  const released: { id: string; capability: number }[] = [];
  for (const model of state.player.models) {
    if (isLivePublicModel(model)) {
      released.push({
        id: model.id,
        capability: agedMarketView(model, state.day).capability,
      });
    }
  }
  for (const rival of state.rivals) {
    for (const model of rival.models) {
      if (isLivePublicModel(model)) {
        released.push({
          id: model.id,
          capability: agedMarketView(model, state.day).capability,
        });
      }
    }
  }
  released.sort(
    (a, b) =>
      b.capability - a.capability || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const ranks = new Map<string, number>();
  for (let i = 0; i < released.length; i += 1) {
    ranks.set(released[i]!.id, i + 1);
  }
  return ranks;
}

/** 1-based capability rank for a model, or null if not released. */
export function modelCapabilityRank(
  state: SimState,
  modelId: string,
): number | null {
  return releasedModelCapabilityRanks(state).get(modelId) ?? null;
}

/**
 * Smooth free-tier audience factor from global model rank. Rank is a readable
 * summary, never an admission gate: every adjacent rank changes demand by a
 * small amount and there is no top-N cliff.
 */
export function freeTierRankDemandFactor(rank: number | null): {
  audienceMultiplier: number;
  utilityBonus: number;
  minimumAudienceShareScale: number;
  paidPopularityLeadScale: number;
  inRank: boolean;
} {
  if (rank == null || !Number.isFinite(rank) || rank <= 0) {
    return {
      audienceMultiplier: 0.12,
      utilityBonus: -22,
      minimumAudienceShareScale: 0.15,
      paidPopularityLeadScale: 0.45,
      inRank: false,
    };
  }
  const distance = Math.max(0, rank - 1);
  const decay = 1 / (1 + Math.pow(distance / 55, 1.7));
  return {
    audienceMultiplier: 0.1 + 0.9 * decay,
    utilityBonus: -24 * (1 - decay),
    minimumAudienceShareScale: 0.12 + 0.88 * decay,
    paidPopularityLeadScale: 0.4 + 0.6 * decay,
    inRank: rank <= FREE_TIER_TOP_MODEL_RANK,
  };
}

/**
 * Free-tier reach follows the allowance users actually experience. A message
 * is estimated at 2K tokens, matching the plan editor's friendly estimate.
 * Pass {@link modelRank} to gate mass-market reach on global capability rank.
 */
export function freeTierDemandProfile(
  plan: SubPlan,
  opts?: { modelRank?: number | null; tokensPerInteraction?: number },
): {
  band: FreeTierDemandBand;
  messagesPerDay: number;
  audienceMultiplier: number;
  minimumAudienceShare: number;
  utilityBonus: number;
  paidPopularityLead: number;
  label: string;
  modelRank: number | null;
  rankInTop: boolean;
} {
  const tokensPerMsg = Math.max(500, opts?.tokensPerInteraction ?? 2_000);
  const messagesPerDay =
    (planAllowanceMTokPerMonth(plan) * 1_000_000) /
    ECONOMY.daysPerMonth /
    tokensPerMsg;
  const base =
    messagesPerDay > 10
      ? {
          band: "popular" as const,
          messagesPerDay,
          audienceMultiplier: 2.6,
          minimumAudienceShare: 0.38,
          utilityBonus: 28,
          paidPopularityLead: 2.8,
          label: "Mass-market reach",
        }
      : messagesPerDay >= 5
        ? {
            band: "semi_popular" as const,
            messagesPerDay,
            audienceMultiplier: 1.05,
            minimumAudienceShare: 0.12,
            utilityBonus: 10,
            paidPopularityLead: 1.9,
            label: "Semi-popular reach",
          }
        : {
            band: "cost_constrained" as const,
            messagesPerDay,
            audienceMultiplier: 0.22,
            minimumAudienceShare: 0.04,
            utilityBonus: -12,
            paidPopularityLead: 1.25,
            label: "Cost-constrained reach",
          };
  // Rank gating is opt-in: omit modelRank to keep message-band reach unchanged.
  const rankProvided = opts != null && "modelRank" in opts;
  const rank = rankProvided ? (opts!.modelRank ?? null) : null;
  const rankFactor = rankProvided
    ? freeTierRankDemandFactor(rank)
    : {
        audienceMultiplier: 1,
        utilityBonus: 0,
        minimumAudienceShareScale: 1,
        paidPopularityLeadScale: 1,
        inRank: true,
      };
  return {
    ...base,
    audienceMultiplier: base.audienceMultiplier * rankFactor.audienceMultiplier,
    minimumAudienceShare:
      base.minimumAudienceShare * rankFactor.minimumAudienceShareScale,
    utilityBonus: base.utilityBonus + rankFactor.utilityBonus,
    paidPopularityLead:
      base.paidPopularityLead * rankFactor.paidPopularityLeadScale,
    label:
      rankProvided && !rankFactor.inRank
        ? `${base.label} (model outside top ${FREE_TIER_TOP_MODEL_RANK})`
        : base.label,
    modelRank: rankProvided ? rank : null,
    rankInTop: rankFactor.inRank,
  };
}

export function formatAllowance(plan: SubPlan): string {
  const m = planAllowanceMTokPerMonth(plan);
  if (m >= 1000) return `${(m / 1000).toFixed(2)}B tok/mo`;
  if (m >= 1) return `${m.toFixed(2)}M tok/mo`;
  return `${(m * 1000).toFixed(2)}K tok/mo`;
}

/** @deprecated use planAllowanceMTokPerDay × utilization */
export function planTokensPerDay(plan: SubPlan): number {
  return planAllowanceMTokPerDay(plan);
}

export function emptyPlanStats(): PlanDayStats[] {
  return [];
}

/** Best model on a plan for quality scoring. */
export function bestModelOnPlan(state: SimState, plan: SubPlan) {
  const models = livePlanModels(state, planServingModelIds(state, plan));
  if (models.length === 0) return null;
  return (
    models.sort(
      (a, b) =>
        agedMarketView(b, state.day).capability -
        agedMarketView(a, state.day).capability,
    )[0] ?? null
  );
}

export interface PlanOfferingBreadth {
  score: number;
  contributors: {
    modality: "image" | "video" | "audio";
    modelId: string;
    modelName: string;
    composite: number;
    points: number;
  }[];
}

export function offeringBreadthMultiplier(segmentId: SegmentId): number {
  if (segmentId === "creative") return 1;
  if (segmentId === "consumer") return 0.8;
  if (segmentId === "hobby") return 0.6;
  if (segmentId === "indie_api" || segmentId === "startup_api") return 0.4;
  if (segmentId === "enterprise") return 0.2;
  return 0.1;
}

/**
 * How consumer-style price-sensitive a segment is when judging plans (0–1).
 * High-ARPU segments (enterprise/legal/healthcare/science) weigh a £200 tier
 * against their own willingness-to-pay and organizational needs; the consumer
 * instincts (cheaper-is-better scoring, premium-tier value scrutiny,
 * tokens-per-pound allowance expectations) apply at full strength only to
 * consumer/hobby audiences. This is what lets enterprise demand reach £100+
 * tiers instead of every segment collapsing onto the £20 SKU.
 */
export function planSegmentPriceSensitivity(segmentId: SegmentId): number {
  const anchor = SEGMENTS.find((s) => s.id === segmentId)?.arpuHint ?? 20;
  return Math.max(0.15, Math.min(1, 20 / Math.max(20, anchor)));
}

/**
 * Daily message volume a segment's subscribers expect their plan to cover
 * (≈2K tokens/message, matching the plan editor's friendly estimate).
 * Pro and enterprise workloads are heavy: those users need ≥100 msg/day, so
 * they skip cheap low-allowance tiers in favor of higher paid plans.
 */
export const PLAN_PRO_WORKLOAD_MESSAGES_PER_DAY = 100;

export function segmentExpectedMessagesPerDay(segmentId: SegmentId): number {
  switch (segmentId) {
    case "enterprise":
    case "legal":
    case "healthcare":
      return PLAN_PRO_WORKLOAD_MESSAGES_PER_DAY;
    case "science":
      return 80;
    case "startup_api":
      return 60;
    case "creative":
      return 40;
    case "indie_api":
      return 25;
    case "consumer":
      return 15;
    default:
      return 5; // hobby
  }
}

export interface PlanWorkloadExpectation {
  expectedMessagesPerDay: number;
  offeredMessagesPerDay: number;
  /** 0 = plan covers the segment's workload; 1 = plan covers none of it. */
  shortfall: number;
  label: string;
}

/** Segment workload fit for a plan's derived monthly allowance. */
export function planWorkloadExpectation(input: {
  segmentId: SegmentId;
  allowanceMTokPerMonth: number;
  /** Avg tokens per interaction for the plan's backing model (default 2K). */
  tokensPerInteraction?: number;
}): PlanWorkloadExpectation {
  const expected = segmentExpectedMessagesPerDay(input.segmentId);
  const tokens = Math.max(500, input.tokensPerInteraction ?? 2_000);
  const offered =
    (Math.max(0, input.allowanceMTokPerMonth) * 1_000_000) /
    ECONOMY.daysPerMonth /
    tokens;
  const shortfall =
    expected <= 0
      ? 0
      : Math.max(0, Math.min(1, (expected - offered) / expected));
  return {
    expectedMessagesPerDay: expected,
    offeredMessagesPerDay: offered,
    shortfall,
    label:
      shortfall <= 0
        ? `Covers the ~${expected} msg/day this audience expects.`
        : `Below the ~${expected} msg/day this audience expects — those users pick higher tiers.`,
  };
}

/** Quality-gated portfolio value from generation models included in a plan. */
export function planOfferingBreadth(
  state: SimState,
  plan: SubPlan,
): PlanOfferingBreadth {
  const models = livePlanModels(state, planServingModelIds(state, plan)).map(
    normalizeModelEvaluations,
  );
  const definitions = [
    { modality: "image" as const, suite: "image_generation" as const, max: 7 },
    { modality: "video" as const, suite: "video_generation" as const, max: 6 },
    { modality: "audio" as const, suite: "audio_generation" as const, max: 5 },
  ];
  const contributors: PlanOfferingBreadth["contributors"] = [];
  for (const definition of definitions) {
    const candidates = models
      .map((model) => ({
        model,
        composite: suiteComposite(model.benchmarkSuites?.[definition.suite]),
        safety: model.capabilities?.safety ?? model.quality.safety,
      }))
      .filter(
        (candidate) => candidate.composite >= 35 && candidate.safety >= 30,
      )
      .toSorted((a, b) => b.composite - a.composite);
    const best = candidates[0];
    if (!best) continue;
    const points =
      definition.max * Math.max(0, Math.min(1, (best.composite - 35) / 65));
    contributors.push({
      modality: definition.modality,
      modelId: best.model.id,
      modelName: best.model.name,
      composite: best.composite,
      points,
    });
  }
  return {
    score: contributors.reduce((sum, item) => sum + item.points, 0),
    contributors,
  };
}

function playerBlendedApi(state: SimState): number {
  const p = state.player.pricing;
  if (p.apiPriceInPerMTok != null && p.apiPriceOutPerMTok != null) {
    return blendApiPrice(p.apiPriceInPerMTok, p.apiPriceOutPerMTok);
  }
  return Math.max(0, p.apiPricePerMTok);
}

/**
 * API-list value of included monthly tokens (what user would pay on API for same volume).
 * Used for subsidy display and "is $5k justified?" checks.
 */
export function planApiEquivalentValue(
  plan: SubPlan,
  apiPricePerMTok: number,
  utilization = 0.75,
): number {
  const mtokMo =
    planAllowanceMTokPerMonth(plan) * Math.max(0.1, Math.min(1, utilization));
  return mtokMo * Math.max(API_PRICE_EPSILON, apiPricePerMTok);
}

/**
 * Subsidy ratio: apiEquivalent / price.
 * >1 = included tokens worth more than sub (you subsidize).
 * <1 = customer overpays vs API (price pressure).
 */
export function planSubsidyRatio(
  plan: SubPlan,
  apiPricePerMTok: number,
  utilization = 0.75,
): number {
  if (isFreePlan(plan)) return Number.POSITIVE_INFINITY;
  const apiEq = planApiEquivalentValue(plan, apiPricePerMTok, utilization);
  return apiEq / Math.max(0.01, plan.pricePerMonth);
}

/**
 * 0 = fair/cheap, 1 = way too expensive vs included tokens + model quality.
 * High ARPU ($5k) is OK when token value + SOTA justify it.
 */
export function planPriceTooHighScore(
  plan: SubPlan,
  opts: {
    apiPricePerMTok: number;
    modelCapability: number;
    frontierCapability: number;
    utilization?: number;
  },
): number {
  if (isFreePlan(plan)) return 0;
  const u = opts.utilization ?? 0.75;
  const sota = Math.max(
    0,
    Math.min(
      1,
      1 - Math.max(0, opts.frontierCapability - opts.modelCapability) / 32,
    ),
  );
  // Fair price ceiling — SOTA + included tokens justify higher ARPU
  const tokenValue =
    planApiEquivalentValue(plan, opts.apiPricePerMTok, u) *
    (0.85 + sota * 1.35);
  const brandPremium =
    (18 + opts.modelCapability * 1.6) * (1 + sota * 3.2) +
    (plan.pricePerMonth <= 25 ? 14 : 0);
  const fairCeiling = tokenValue + brandPremium;
  const over = plan.pricePerMonth / Math.max(1, fairCeiling);
  // Softer curve so fair Plus/Pro sell; gouging still near 1.0
  return Math.max(
    0,
    Math.min(1, Math.pow(Math.max(0, over - 1.1), 1.0) / 1.85),
  );
}

/** Paid rival SKU prices from live labs (plans first, then Plus/Pro fallbacks). */
export function rivalPaidTierPrices(state: SimState): number[] {
  const prices: number[] = [];
  for (const rival of state.rivals) {
    if (!rival.models.some((m) => m.shipped || m.release === "released")) {
      continue;
    }
    const planPrices = (rival.pricing.plans ?? [])
      .filter((plan) => plan.enabled && plan.pricePerMonth > 0)
      .map((plan) => plan.pricePerMonth);
    if (planPrices.length > 0) {
      prices.push(...planPrices);
      continue;
    }
    if (rival.pricing.subPlusPrice > 0) prices.push(rival.pricing.subPlusPrice);
    if (rival.pricing.subProPrice > 0) prices.push(rival.pricing.subProPrice);
  }
  return prices;
}

/**
 * Nearest rival paid tier to {@link planPrice}. Prefer tier-vs-tier anchors
 * over the global cheapest Plus price.
 */
export function rivalNearestSubPrice(
  state: SimState,
  planPrice: number,
): number {
  const prices = rivalPaidTierPrices(state);
  if (prices.length === 0) return Math.max(1, planPrice > 0 ? planPrice : 20);
  let best = prices[0]!;
  let bestDist = Math.abs(best - planPrice);
  for (let i = 1; i < prices.length; i += 1) {
    const price = prices[i]!;
    const dist = Math.abs(price - planPrice);
    if (dist < bestDist) {
      best = price;
      bestDist = dist;
    }
  }
  return best;
}

/** @deprecated Prefer {@link rivalNearestSubPrice} for tier-vs-tier scoring. */
export function rivalHeadlineSubPrice(state: SimState): number {
  const prices = rivalPaidTierPrices(state);
  if (prices.length === 0) return 20;
  return Math.min(...prices);
}

/** Rival allowance (MTok/mo) at the nearest paid SKU to {@link planPrice}. */
export function rivalNearestAllowanceMTok(
  state: SimState,
  planPrice: number,
): number {
  let bestAllowance = ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const rival of state.rivals) {
    if (!rival.models.some((m) => m.shipped || m.release === "released")) {
      continue;
    }
    const plans = (rival.pricing.plans ?? []).filter(
      (plan) => plan.enabled && plan.pricePerMonth > 0,
    );
    if (plans.length > 0) {
      for (const plan of plans) {
        const dist = Math.abs(plan.pricePerMonth - planPrice);
        if (dist < bestDist) {
          bestDist = dist;
          bestAllowance = planAllowanceMTokPerMonth(plan);
        }
      }
      continue;
    }
    const plus = rival.pricing.subPlusPrice;
    const pro = rival.pricing.subProPrice;
    if (plus > 0) {
      const dist = Math.abs(plus - planPrice);
      if (dist < bestDist) {
        bestDist = dist;
        bestAllowance =
          rival.pricing.plusIncludedMTok ??
          ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth;
      }
    }
    if (pro > 0) {
      const dist = Math.abs(pro - planPrice);
      if (dist < bestDist) {
        bestDist = dist;
        bestAllowance =
          rival.pricing.proIncludedMTok ??
          ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth * 5;
      }
    }
  }
  return bestAllowance;
}

/**
 * Advertised value ÷ price of the rival SKU nearest to {@link planPrice} —
 * the value-for-money benchmark a player plan is judged against.
 */
export function rivalNearestValueRatio(
  state: SimState,
  planPrice: number,
  apiPricePerMTok: number,
): number {
  const rivalPrice = rivalNearestSubPrice(state, planPrice);
  const rivalAllowance = rivalNearestAllowanceMTok(state, planPrice);
  return (
    (rivalAllowance * Math.max(API_PRICE_EPSILON, apiPricePerMTok)) /
    Math.max(1, rivalPrice)
  );
}

/**
 * Stingy gate: a paid plan only counts as stingy when it genuinely loses on
 * value — its advertised API value is below the nearest rival tier's, or its
 * subsidy doesn't even cover the monthly price (valueRatio < 1). Plans that
 * beat rivals on value and give back at least their price are never stingy.
 */
export function planStinginessApplies(
  valueRatio: number,
  rivalValueRatio: number,
): boolean {
  return valueRatio < 1 || valueRatio + 1e-9 < rivalValueRatio;
}

export function rivalBestCapability(state: SimState): number {
  let best = 0;
  for (const r of state.rivals) {
    for (const m of r.models) {
      if (m.shipped || m.release === "released")
        best = Math.max(best, agedMarketView(m, state.day).capability);
    }
  }
  return best;
}

/**
 * Soft audience mass by price band. Remnant prior so cheaper tiers stay
 * slightly larger; quality/value carry most of the demand signal.
 */
export function planPriceTierMassPrior(pricePerMonth: number): number {
  if (pricePerMonth <= 0) return 18;
  if (pricePerMonth <= 10) return 12;
  if (pricePerMonth <= 40) return 6;
  if (pricePerMonth <= 120) return 1;
  if (pricePerMonth <= 500) return -6;
  return -12;
}

/**
 * Log-normal affinity of a segment's willingness-to-pay around its ARPU anchor
 * (consumer ≈ £20, enterprise ≈ £120, legal ≈ £200, healthcare ≈ £250). The
 * freemium funnel audience is scored with the indie_api profile (anchor £4,
 * σ 1.2). Returns 1 at the anchor, clamped to [0.02, 1] so far-off tiers keep
 * a trickle of demand instead of rounding to zero.
 */
export function planSegmentPriceAffinity(
  pricePerMonth: number,
  segmentId: SegmentId,
): number {
  const anchor = SEGMENTS.find((s) => s.id === segmentId)?.arpuHint ?? 20;
  const sigma =
      segmentId === "consumer"
      ? 1.2
      : segmentId === "enterprise" ||
          segmentId === "legal" ||
          segmentId === "healthcare"
        ? 1.3
        : 1.2;
  const z =
    (Math.log(Math.max(0, pricePerMonth) + 1) - Math.log(anchor + 1)) / sigma;
  return Math.max(0.02, Math.min(1, Math.exp(-0.5 * z * z)));
}

/**
 * Match plan allowance to the segment's real monthly workload, including a
 * heavy-user tail. Price affinity answers what a buyer can pay; this answers
 * whether the tier can actually carry their usage. The asymmetric curve is
 * intentionally harsher on an undersized plan than on spare headroom.
 */
export function planSegmentUsageAffinity(
  allowanceMTokPerMonth: number,
  segmentId: SegmentId,
): number {
  const segment = SEGMENTS.find((candidate) => candidate.id === segmentId);
  const coreTarget = Math.max(
    0.5,
    (segment?.baseUsage ?? ECONOMY.basePlanUsageMTokPerDay) *
      ECONOMY.daysPerMonth,
  );
  const allowance = Math.max(0.01, allowanceMTokPerMonth);
  const affinityFor = (target: number) => {
    const logRatio = Math.log(allowance / Math.max(0.01, target));
    const sigma = logRatio < 0 ? 0.72 : 1.35;
    const z = logRatio / sigma;
    return Math.exp(-0.5 * z * z);
  };
  const heavyShare = Math.max(
    0.12,
    Math.min(0.42, 0.12 + (segment?.baseUsage ?? 0) * 0.065),
  );
  const affinity =
    affinityFor(coreTarget) * (1 - heavyShare) +
    affinityFor(coreTarget * 3) * heavyShare;
  return Math.max(0.02, Math.min(1, affinity));
}

export function planSegmentUsageAffinityWeight(segmentId: SegmentId): number {
  const usage = SEGMENTS.find((segment) => segment.id === segmentId)?.baseUsage ?? 0.28;
  const base = 6 + Math.min(6, Math.log1p(Math.max(0, usage)) * 3.2);
  if (
    segmentId === "enterprise" ||
    segmentId === "legal" ||
    segmentId === "healthcare"
  ) {
    return base * 1.7;
  }
  return base;
}

/**
 * Softmax weight of the ARPU affinity term in the per-segment plan split.
 * High-ARPU segments need the affinity to dominate the consumer-tuned
 * cheap-favoring base terms (an enterprise buyer must actually end up on the
 * £120–£500 tiers); at the £20 consumer anchor it stays at the base weight.
 */
export function planSegmentAffinityWeight(segmentId: SegmentId): number {
  const anchor = SEGMENTS.find((s) => s.id === segmentId)?.arpuHint ?? 20;
  return 7 * (1 + Math.max(0, Math.log(anchor / 20)));
}

/**
 * How ready a paid tier is to convert: brand, model quality vs frontier, and
 * reliability. Entry/value tiers convert without much brand; £40+ needs it.
 */
export function planPremiumReadiness(input: {
  pricePerMonth: number;
  brandTrust: number;
  modelCapability: number;
  frontierCapability: number;
  modelReliability: number;
}): number {
  if (input.pricePerMonth <= 0) return 1;
  const brand = Math.max(0, Math.min(1, input.brandTrust / 100));
  const sota = sotaProximityLocal(
    input.modelCapability,
    input.frontierCapability,
  );
  const reliability = Math.max(0, Math.min(1, input.modelReliability / 100));
  const readiness = brand * 0.45 + sota * 0.4 + reliability * 0.15;
  if (input.pricePerMonth <= 10) return 0.55 + readiness * 0.45;
  if (input.pricePerMonth <= 40) return 0.35 + readiness * 0.65;
  if (input.pricePerMonth <= 120) return readiness;
  if (input.pricePerMonth <= 500) return Math.pow(readiness, 1.15);
  return Math.pow(readiness, 1.35);
}

/**
 * Paid-pyramid lead of the cheaper SKU over the next dearer one.
 * Weak value/readiness → ~1.9 (cheap stays clearly larger). Exceptional
 * premium readiness → ~0.75 (inversion: the dearer tier may outgrow the
 * cheaper one). Lead drops below 1 only at high strength.
 */
export const PAID_PLAN_PYRAMID_LEAD_WEAK = 1.9;
export const PAID_PLAN_PYRAMID_LEAD_STRONG = 0.75;
/** Mid-strength fallback used when a caller omits value/readiness. */
export const PAID_PLAN_PYRAMID_LEAD = 1.25;

function pyramidSmootherstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export function paidPlanPyramidLead(input?: {
  valueRatio?: number;
  readiness?: number;
}): number {
  const value = Math.max(0, input?.valueRatio ?? 1);
  const ready = Math.max(0, Math.min(1, input?.readiness ?? 0.42));
  const valueSignal = 1 - Math.exp(-value / 1.15);
  const strength = Math.max(
    0,
    Math.min(1, valueSignal * 0.55 + ready * 0.45),
  );
  return (
    PAID_PLAN_PYRAMID_LEAD_WEAK +
    (PAID_PLAN_PYRAMID_LEAD_STRONG - PAID_PLAN_PYRAMID_LEAD_WEAK) *
      pyramidSmootherstep(strength)
  );
}

/** EMA blend of yesterday's seats vs today's target (stickiness / teleporting). */
export const PLAN_SEAT_STICKINESS = 0.6;

/** Utilization at/above which seats try to migrate to the next paid tier. */
export const PLAN_UPTIER_UTILIZATION = 0.8;

/** Fraction of allowance-constrained seats that attempt an up-tier each tick. */
export const PLAN_UPTIER_MIGRATE_FRAC = 0.15;

/** Next-tier valueRatio must clear this floor to accept up-tier migrants. */
export const PLAN_UPTIER_VALUE_FLOOR = 0.7;

/**
 * Preserve a visible heavy-usage cohort on progressively larger paid tiers.
 * This is a floor, not a quota: organic demand can exceed it, while a tier
 * earns no floor if its allowance barely improves on the tier below or its
 * advertised value is unacceptable.
 */
export function applyHighUsagePlanCohorts<
  T extends {
    plan: Pick<SubPlan, "pricePerMonth">;
    subscribers: number;
    valueRatio: number;
    effectiveAllowanceMTok: number;
    readiness?: number;
  },
>(buckets: T[]): T[] {
  const paid = buckets
    .filter((bucket) => bucket.plan.pricePerMonth > 0)
    .sort((a, b) => a.plan.pricePerMonth - b.plan.pricePerMonth);
  if (paid.length < 2) return buckets;
  const total = paid.reduce(
    (sum, bucket) => sum + Math.max(0, bucket.subscribers),
    0,
  );
  if (total <= 1e-9) return buckets;

  for (let index = paid.length - 1; index >= 1; index -= 1) {
    const tier = paid[index]!;
    const below = paid[index - 1]!;
    if (tier.valueRatio + 1e-9 < PLAN_UPTIER_VALUE_FLOOR) continue;
    if (
      tier.effectiveAllowanceMTok <
      below.effectiveAllowanceMTok * 1.5
    ) continue;
    const ready = Math.max(0, Math.min(1, tier.readiness ?? 0.4));
    const cohortShare = Math.max(
      0.05,
      (0.14 + 0.22 * ready) / 2 ** (index - 1),
    );
    const deficit = total * cohortShare - tier.subscribers;
    if (deficit <= 1e-9) continue;

    let remaining = deficit;
    for (let donorIndex = 0; donorIndex < index && remaining > 1e-9; donorIndex += 1) {
      const donor = paid[donorIndex]!;
      const moved = Math.min(remaining, Math.max(0, donor.subscribers));
      donor.subscribers -= moved;
      tier.subscribers += moved;
      remaining -= moved;
    }
  }
  return buckets;
}

/**
 * Enforce a value-aware cheap→dear lead. Each dearer SKU is capped by
 * cheaper / lead(value, readiness). Weak premiums stay smaller; exceptional
 * Pro/Max offerings may invert (lead < 1). Mutates in place.
 */
export function enforcePlanSubscriberPyramid<
  T extends {
    plan: Pick<SubPlan, "pricePerMonth">;
    subscribers: number;
    valueRatio?: number;
    readiness?: number;
  },
>(buckets: T[]): T[] {
  const paid = buckets
    .filter((bucket) => bucket.plan.pricePerMonth > 0)
    .sort((a, b) => a.plan.pricePerMonth - b.plan.pricePerMonth);
  for (let i = 1; i < paid.length; i += 1) {
    const dearer = paid[i]!;
    const cheaper = paid[i - 1]!;
    const lead = paidPlanPyramidLead({
      valueRatio: dearer.valueRatio,
      readiness: dearer.readiness,
    });
    const maxDearer = cheaper.subscribers / Math.max(0.2, lead);
    if (dearer.subscribers > maxDearer) {
      dearer.subscribers = Math.max(0, maxDearer);
    }
  }
  return buckets;
}

/**
 * Move a fraction of high-utilization seats up one paid tier when the next
 * tier's valueRatio is acceptable. Pressure scales with utilization and
 * optional frontier proximity so a SOTA lab converts more heavy users.
 * Mutates subscriber counts in place.
 */
export function applyPlanUptierMigration<
  T extends {
    plan: Pick<SubPlan, "pricePerMonth" | "id">;
    subscribers: number;
    usageRate: number;
    valueRatio: number;
    frontierProximity?: number;
  },
>(buckets: T[]): T[] {
  const paid = buckets
    .filter((bucket) => bucket.plan.pricePerMonth > 0)
    .sort((a, b) => a.plan.pricePerMonth - b.plan.pricePerMonth);
  for (let i = 0; i < paid.length - 1; i += 1) {
    const from = paid[i]!;
    const to = paid[i + 1]!;
    if (from.usageRate + 1e-9 < PLAN_UPTIER_UTILIZATION) continue;
    if (to.valueRatio + 1e-9 < PLAN_UPTIER_VALUE_FLOOR) continue;
    const utilPressure = Math.min(
      1,
      (from.usageRate - PLAN_UPTIER_UTILIZATION) /
        Math.max(1e-6, 1 - PLAN_UPTIER_UTILIZATION),
    );
    const frontier =
      to.frontierProximity ?? from.frontierProximity ?? 0.55;
    const migrate =
      from.subscribers *
      PLAN_UPTIER_MIGRATE_FRAC *
      (0.35 + 0.65 * utilPressure) *
      (0.7 + 0.75 * Math.max(0, Math.min(1, frontier)));
    if (migrate <= 1e-9) continue;
    from.subscribers = Math.max(0, from.subscribers - migrate);
    to.subscribers += migrate;
  }
  return buckets;
}

/**
 * Blend today's unconstrained seat target with yesterday's seats so demand
 * does not teleport between ticks.
 */
export function blendPlanSeatStickiness(
  targetSubscribers: number,
  priorSubscribers: number | undefined,
  stickiness = PLAN_SEAT_STICKINESS,
): number {
  const inertia = Math.max(0, Math.min(0.95, stickiness));
  if (priorSubscribers == null || !Number.isFinite(priorSubscribers)) {
    return Math.max(0, targetSubscribers);
  }
  return Math.max(
    0,
    priorSubscribers * inertia + targetSubscribers * (1 - inertia),
  );
}

/**
 * Advertised usage value ÷ price. Canonical value-for-money for paid tiers:
 * allowance MTok/mo × blended API list (or the stored subsidy).
 */
export function planAdvertisedValueRatio(
  plan: SubPlan,
  blendedApiPrice: number,
  allowanceMTokOverride?: number,
): number {
  if (plan.pricePerMonth <= 0) return Number.POSITIVE_INFINITY;
  const subsidy = planMonthlyApiValueSubsidy(plan, blendedApiPrice);
  // When an explicit allowance override is supplied (traffic-weighted
  // entitlement), rebuild advertised value from that allowance × API list.
  const advertised =
    allowanceMTokOverride != null && Number.isFinite(allowanceMTokOverride)
      ? Math.max(0, allowanceMTokOverride) *
        Math.max(API_PRICE_EPSILON, blendedApiPrice)
      : subsidy;
  return advertised / Math.max(0.01, plan.pricePerMonth);
}

/**
 * Softmax-friendly score for plan demand.
 * Quality + advertised valueRatio dominate; a soft mass prior and priceScore
 * keep cheaper tiers naturally larger without freezing the pyramid.
 *
 * `opts.referenceApiPricePerMTok` swaps the lab's own blended list price for a
 * market reference when judging value PERCEPTION (too-high score, advertised
 * value ratio, subsidy-driven upgrade/enterprise expectations) so raising your
 * own API price cannot make your plans look like better deals. Entitlement
 * mechanics (how many tokens a subsidy buys) still settle at the lab's own
 * list price. `opts.includeMassPrior === false` drops the global price-tier
 * mass prior (per-segment ARPU affinity replaces it in the market split).
 * Without opts the behavior is exactly the legacy one.
 */
export function planAttractiveness(
  state: SimState,
  plan: SubPlan,
  segmentId: SegmentId = "consumer",
  opts?: { referenceApiPricePerMTok?: number; includeMassPrior?: boolean },
): number {
  if (!plan.enabled) return -50;
  const baseModel = bestModelOnPlan(state, plan);
  if (!baseModel) return -40;
  const model = modelForPlanServe(
    baseModel,
    plan,
    state.player.researchUnlocked,
  );
  const facing = agedMarketView(model, state.day);
  const cap = facing.capability;

  const frontier = Math.max(
    cap,
    ...state.player.models
      .filter(isLivePublicModel)
      .map((m) => agedMarketView(m, state.day).capability),
    rivalBestCapability(state),
    40,
  );
  const gap = Math.max(0, frontier - cap);
  const sota = Math.max(0, Math.min(1, 1 - gap / 28));
  // Value perception is judged at the market reference API price when the
  // caller provides one; entitlement mechanics below keep the lab's own list.
  const api = opts?.referenceApiPricePerMTok ?? playerBlendedApi(state);
  const rivalSub = rivalNearestSubPrice(state, plan.pricePerMonth);
  const rivalAllow = rivalNearestAllowanceMTok(state, plan.pricePerMonth);
  const rivalCap = rivalBestCapability(state) || frontier;
  const modelRank = modelCapabilityRank(state, baseModel.id);
  // Smooth prestige premium: rank 5 is not a magic eligibility boundary.
  const rankStrength =
    modelRank == null ? 0 : 1 / (1 + Math.max(0, modelRank - 1) / 4);
  const readiness = planPremiumReadiness({
    pricePerMonth: plan.pricePerMonth,
    brandTrust: state.player.brandTrust,
    modelCapability: cap,
    frontierCapability: frontier,
    modelReliability: model.quality.reliability,
  });

  const personality =
    model.productProfile?.personality ??
    model.benchmarks.personality ??
    model.quality.chat;
  const quality =
    cap * 0.42 +
    model.quality.reliability * 0.22 +
    personality * 0.12 +
    sota * 30;
  const personalityPenalty = planPersonalityDissatisfaction(personality) * 28;

  // Explicit token offer (log of monthly MTok). Subsidy plans derive their
  // effective allowance from the per-model entitlements. The 72 cap leaves
  // headroom differentiation between a 20 MTok Plus and a 200 MTok premium
  // tier — saturating at 52 made every allowance above ~25 MTok identical.
  const allowMo = planEffectiveAllowanceMTokPerMonth(state, plan);
  const tokenOfferScore = Math.min(
    72,
    8 + Math.log10(allowMo * 1000 + 10) * 12,
  );

  // Price score: cheaper tiers attract more seats; free stays mass-market.
  const priceScore =
    plan.pricePerMonth <= 0
      ? 56 + (1 - sota) * 18
      : Math.max(0, 88 - Math.log10(plan.pricePerMonth + 1) * 34);

  const tooHigh = planPriceTooHighScore(plan, {
    apiPricePerMTok: api,
    modelCapability: cap,
    frontierCapability: frontier,
  });

  // Tier-vs-nearest-rival-tier: tokens and price relative to that SKU.
  const tokenVsRival =
    plan.pricePerMonth <= 0
      ? 0
      : Math.min(
          28,
          Math.log2(1 + allowMo / Math.max(0.01, rivalAllow)) *
            (rivalSub / Math.max(1, plan.pricePerMonth)) *
            5.5,
        );
  const smarterAtPrice =
    plan.pricePerMonth > 0 && plan.pricePerMonth <= rivalSub * 1.25
      ? Math.max(0, cap - rivalCap) * 0.95
      : Math.max(0, cap - rivalCap) * 0.4;

  // Canonical value-for-money: advertised API-value subsidy ÷ seat price.
  const rawValueRatio = planAdvertisedValueRatio(plan, api, allowMo);
  // Frontier-ranked models can sell below value=1; weaker models need clearer
  // value, with no hard rank cutoff.
  const valueScore =
    plan.pricePerMonth <= 0
      ? tokenOfferScore * 0.3 * (1.1 - sota * 0.35)
      : (() => {
          const softFloor = 0.7 - rankStrength * 0.25;
          const excess = Math.max(0, rawValueRatio - softFloor);
          const base =
            4 +
            rankStrength * 6 +
            Math.min(36, Math.log2(1 + excess * 2.4) * 14) +
            Math.min(10, Math.max(0, rawValueRatio) * 3.5);
          return base * (0.85 + readiness * 0.25 + sota * 0.15);
        })();
  const valueFloor = 0.7 - rankStrength * 0.25;
  const valueDeficit =
    plan.pricePerMonth <= 0
      ? 0
      : Math.max(0, valueFloor - rawValueRatio) / Math.max(0.1, valueFloor);

  // SOTA pulls suitable customers toward ready premium SKUs. Cheap tiers
  // still get a launch bump when readiness is weak (early game).
  const sotaBand =
    plan.pricePerMonth <= 0
      ? 8
      : plan.pricePerMonth <= 40
        ? 8 + (1 - readiness) * 6
        : plan.pricePerMonth <= 120
          ? 10 + readiness * 8
          : 8 + readiness * 10;
  const sotaPull = Math.pow(sota, 1.35) * sotaBand * Math.max(0.35, readiness);
  const pricePenalty = tooHigh * 38;
  const premiumPenalty =
    premiumPlanScrutiny(plan, state.player.pricing.plans, (candidate) =>
      planEffectiveAllowanceMTokPerMonth(state, candidate),
    ).shortfall * 52;
  const tokensPerInteraction = avgTokensPerInteraction(
    commercialModelKind(model),
  );
  const allowancePenalty =
    planAllowanceExpectation(plan, allowMo, {
      tokensPerInteraction,
      valueRatio: rawValueRatio,
      rivalValueRatio:
        (rivalAllow * Math.max(API_PRICE_EPSILON, api)) / Math.max(1, rivalSub),
    }).dissatisfaction * 72;
  // SOTA launches move suitable customers upward; enterprise tiers must
  // advertise ≥5× price in API value or lose enterprise demand.
  const subsidyGbp = planMonthlyApiValueSubsidy(plan, api);
  const upgrade = planUpgradePressure({
    pricePerMonth: plan.pricePerMonth,
    subsidyGbp,
    modelCapability: cap,
    modelReliability: model.quality.reliability,
    kind: commercialModelKind(model),
    frontierCapability: frontier,
    cheaperPlans: state.player.pricing.plans
      .filter((candidate) => candidate.id !== plan.id && candidate.enabled)
      .map((candidate) => ({
        pricePerMonth: candidate.pricePerMonth,
        subsidyGbp: planMonthlyApiValueSubsidy(candidate, api),
      })),
  });
  const upgradePull = upgrade.pressure * 12 * readiness;
  const enterprisePenalty =
    enterpriseSubsidyExpectation(plan, subsidyGbp).shortfall * 46;
  const priorDissatisfaction =
    state.lastMarket.planStats.find((stat) => stat.planId === plan.id)
      ?.dissatisfaction ?? 0;
  // Dissatisfaction should cause churn and aversion, not an irreversible
  // 50-point softmax underflow. The bounded curve still punishes a bad product
  // while letting a repriced/reworked tier recover on subsequent days.
  const instabilityCeiling = isFreePlan(plan) ? 10 : 14;
  const instabilityPenalty =
    instabilityCeiling *
    ((1 - Math.exp(-Math.min(1, priorDissatisfaction) * 2.2)) /
      (1 - Math.exp(-2.2)));
  const breadth =
    planOfferingBreadth(state, plan).score *
    offeringBreadthMultiplier(segmentId);
  const massPrior =
    opts?.includeMassPrior === false
      ? 0
      : planPriceTierMassPrior(plan.pricePerMonth);
  const priceSensitivity = planSegmentPriceSensitivity(segmentId);
  // Workload fit: pro/enterprise users expect ≥100 msg/day from a paid plan.
  // Low-allowance cheap tiers miss that bar and lose those audiences to
  // higher paid plans; the miss hurts more the heavier the segment's ARPU.
  const workload = planWorkloadExpectation({
    segmentId,
    allowanceMTokPerMonth: allowMo,
    tokensPerInteraction,
  });
  const workloadPenalty = workload.shortfall * 48 * (2 - priceSensitivity);
  // Brand/marketing unlock for mid/premium conversion. The negative premium
  // skepticism is a consumer instinct — high-ARPU segments weigh value and
  // entitlement over brand polish, so the whole term scales with the
  // segment's price sensitivity.
  const brand = Math.max(0, Math.min(1, state.player.brandTrust / 100));
  const readinessUnlockRaw =
    plan.pricePerMonth <= 0
      ? 0
      : plan.pricePerMonth <= 40
        ? readiness * 8 + brand * 4
        : readiness * 24 - (1 - readiness) * 14 + brand * 8;
  const readinessUnlock = readinessUnlockRaw * priceSensitivity;

  // Quality + value dominate; mass prior is a soft remnant. Consumer-style
  // price sensitivity (cheap-is-better scoring, premium-tier value scrutiny,
  // tokens-per-pound allowance expectations) scales with the segment's ARPU —
  // enterprise/legal/healthcare judge tiers against their own willingness-to-pay.
  const qualityWeight =
    plan.pricePerMonth <= 0 ? 0.28 : 0.32 + readiness * 0.14;
  const valueDeficitPenalty = valueDeficit * 18 * priceSensitivity;

  return (
    quality * qualityWeight +
    priceScore * (0.2 + (1 - sota) * 0.08) * priceSensitivity +
    tokenOfferScore * 0.14 +
    valueScore * 0.24 +
    tokenVsRival * 0.12 +
    smarterAtPrice * 0.07 +
    breadth +
    massPrior +
    readinessUnlock +
    sotaPull +
    upgradePull -
    valueDeficitPenalty -
    pricePenalty -
    premiumPenalty * priceSensitivity -
    allowancePenalty * priceSensitivity -
    enterprisePenalty -
    workloadPenalty -
    instabilityPenalty -
    personalityPenalty *
      (segmentId === "consumer" || segmentId === "enterprise" ? 1 : 0.35)
  );
}

/**
 * How many concurrent subscribers a plan can support given inference PF headroom
 * and per-user token burn (compute seat cap).
 */
export function maxSeatsForPlan(
  plan: SubPlan,
  model: Pick<
    Model,
    "paramsB" | "activeParamsB" | "family" | "inferCostMult"
  > | null,
  capacityUnits: number,
  serveEff: number,
  usageRate: number,
  opts?: {
    modelCapability?: number;
    frontierCapability?: number;
    /** Fraction of capacity reserved for subs (rest for API) */
    subPoolShare?: number;
    /** When true, capacityUnits is MTok/day (token path); else inference PF */
    capacityIsMTok?: boolean;
    /** Subsidy-derived effective allowance; falls back to the stored fields. */
    allowanceMTokPerMonth?: number;
  },
): number {
  if (!model || capacityUnits <= 1e-9) return 0;
  const sota = sotaProximityLocal(
    opts?.modelCapability ?? 40,
    opts?.frontierCapability ?? 50,
  );
  const free = isFreePlan(plan);
  const eng = free ? 0.4 + sota * 0.8 : 0.55 + Math.pow(sota, 1.3) * 2.2;
  const perUserMTok =
    planActualMTokPerUser(
      plan,
      ECONOMY.basePlanUsageMTokPerDay,
      usageRate,
      opts?.allowanceMTokPerMonth,
    ) * eng;
  if (perUserMTok <= 1e-12) return plan.subscriberCap ?? 1e9;
  const subShare =
    opts?.subPoolShare ?? 1 - (ECONOMY.defaultApiVsSubPriority ?? 0.68);
  const subPool = capacityUnits * Math.max(0.12, Math.min(1, subShare));
  if (opts?.capacityIsMTok) {
    return Math.min(
      plan.subscriberCap ?? Number.POSITIVE_INFINITY,
      Math.max(0, Math.floor(subPool / perUserMTok)),
    );
  }
  const pfEach = inferencePfDemand(perUserMTok, model, serveEff);
  if (pfEach <= 1e-12) return 1e9;
  return Math.min(
    plan.subscriberCap ?? Number.POSITIVE_INFINITY,
    Math.max(0, Math.floor(subPool / pfEach)),
  );
}

function sotaProximityLocal(cap: number, frontier: number): number {
  const f = Math.max(18, frontier);
  return Math.max(0, Math.min(1, 1 - Math.max(0, f - cap) / 32));
}

/** Soft max total sub seats from whole inference pool (UI / market). */
export function maxTotalSubSeats(
  state: SimState,
  capacityPf: number,
  serveEff: number,
): number {
  const plans = state.player.pricing.plans.filter((p) => p.enabled);
  if (plans.length === 0) return 0;
  // Weighted average per-user PF using plan attractiveness as weights
  let seats = 0;
  for (const p of plans) {
    const m = bestModelOnPlan(state, p);
    const u = p.usageRate ?? 0.65;
    seats += maxSeatsForPlan(
      p,
      m,
      capacityPf / Math.max(1, plans.length),
      serveEff,
      u,
    );
  }
  return Math.max(0, seats);
}

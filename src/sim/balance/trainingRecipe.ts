import type {
  DataDomain,
  DomainStock,
  ModelBackbone,
  ModelFamily,
  QualityAxes,
  RivalArchetype,
  TrainingDataPlan,
} from "../types";
import type { Rng } from "../rng";
import {
  DATA_DOMAINS,
  minDataMTokForParams,
  normalizeWeights,
  recommendedTrainingDataMTok,
  trainingDataParameterBasisB,
} from "./data";
import {
  alignmentDataWeights,
  MAX_POST_TRAIN_SHARE,
  MIN_POST_TRAIN_SHARE,
} from "./modelProduct";

/** Default align slice of a domain envelope. Base sits at the other half. */
export const DEFAULT_RECIPE_ALIGN_SHARE = 0.5;
export const DEFAULT_RECIPE_TRAIN_SHARE = 0.82;

export type RecipeVolumePolicy = "floor" | "strong" | "all";

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function emptyDomainVolumes(): Record<DataDomain, number> {
  return Object.fromEntries(DATA_DOMAINS.map((domain) => [domain, 0])) as Record<
    DataDomain,
    number
  >;
}

function sumVolumes(volumes: Partial<Record<DataDomain, number>>): number {
  return DATA_DOMAINS.reduce(
    (sum, domain) => sum + Math.max(0, volumes[domain] ?? 0),
    0,
  );
}

/** 1 token per parameter, never above owned processed stock. */
export function defaultRecipeVolumeMTok(
  processedAvail: number,
  paramsB: number,
): number {
  return Math.min(minDataMTokForParams(paramsB), Math.max(0, processedAvail));
}

export function usableStockByDomain(
  stocks: Partial<Record<DataDomain, Pick<DomainStock, "processed">>>,
): Record<DataDomain, number> {
  return Object.fromEntries(
    DATA_DOMAINS.map((domain) => [
      domain,
      Math.max(0, stocks[domain]?.processed ?? 0),
    ]),
  ) as Record<DataDomain, number>;
}

export function clampEnvelopeSplit(
  base: number,
  align: number,
): { base: number; align: number } {
  const owned = Math.max(0, base) + Math.max(0, align);
  if (owned <= 1e-9) return { base: 0, align: 0 };
  const share = clamp(
    Math.max(0, align) / owned,
    MIN_POST_TRAIN_SHARE,
    MAX_POST_TRAIN_SHARE,
  );
  return { base: owned * (1 - share), align: owned * share };
}

/**
 * Grow or shrink owned data and snap the base handle back to half the
 * envelope so stacked handles stay easy to grab after a resize.
 */
export function scaleEnvelope(
  _base: number,
  _align: number,
  nextEnvelope: number,
  fallbackAlignShare = DEFAULT_RECIPE_ALIGN_SHARE,
): { base: number; align: number } {
  const envelope = Math.max(0, nextEnvelope);
  const share = clamp(
    fallbackAlignShare,
    MIN_POST_TRAIN_SHARE,
    MAX_POST_TRAIN_SHARE,
  );
  return clampEnvelopeSplit(envelope * (1 - share), envelope * share);
}

export function clampRecipeToUsable(
  base: Record<DataDomain, number>,
  align: Record<DataDomain, number>,
  usableByDomain: Partial<Record<DataDomain, number>>,
): { base: Record<DataDomain, number>; align: Record<DataDomain, number> } {
  const nextBase = { ...base };
  const nextAlign = { ...align };
  for (const domain of DATA_DOMAINS) {
    const usable = Math.max(0, usableByDomain[domain] ?? 0);
    const envelope =
      Math.max(0, nextBase[domain] ?? 0) + Math.max(0, nextAlign[domain] ?? 0);
    if (envelope > usable + 1e-9) {
      const scaled = scaleEnvelope(
        nextBase[domain] ?? 0,
        nextAlign[domain] ?? 0,
        usable,
      );
      nextBase[domain] = scaled.base;
      nextAlign[domain] = scaled.align;
    }
  }
  return { base: nextBase, align: nextAlign };
}

export function recipeVolumeTargetMTok(opts: {
  paramsB: number;
  family?: ModelFamily;
  backbone?: ModelBackbone;
  activeParamsB?: number;
  trainShare?: number;
  usableTotal: number;
  volumePolicy?: RecipeVolumePolicy;
  totalCapMTok?: number;
}): number {
  const usable = Math.max(0, opts.usableTotal);
  const cap = Math.max(0, opts.totalCapMTok ?? Number.POSITIVE_INFINITY);
  if (opts.volumePolicy === "all") return Math.min(usable, cap);
  if (opts.volumePolicy === "strong") {
    const family = opts.family ?? "dense";
    return Math.min(
      recommendedTrainingDataMTok({
        paramsB: opts.paramsB,
        activeParamsB: opts.activeParamsB,
        family,
        backbone: opts.backbone,
        trainShare: opts.trainShare ?? DEFAULT_RECIPE_TRAIN_SHARE,
      }),
      usable,
      cap,
    );
  }
  return Math.min(minDataMTokForParams(opts.paramsB), usable, cap);
}

/** Seed a mix at 1× params or owned stock, unless a target/policy overrides. */
export function seedRecipeVolumes(opts: {
  weights: Partial<Record<DataDomain, number>>;
  postTrainWeights?: Partial<Record<DataDomain, number>>;
  paramsB: number;
  usableByDomain: Partial<Record<DataDomain, number>>;
  postTrainShare?: number;
  totalCapMTok?: number;
  targetMTok?: number;
  family?: ModelFamily;
  backbone?: ModelBackbone;
  activeParamsB?: number;
  trainShare?: number;
  volumePolicy?: RecipeVolumePolicy;
}): {
  base: Record<DataDomain, number>;
  align: Record<DataDomain, number>;
  totalMTok: number;
} {
  void opts.postTrainWeights;
  const usable = Object.fromEntries(
    DATA_DOMAINS.map((domain) => [
      domain,
      Math.max(0, opts.usableByDomain[domain] ?? 0),
    ]),
  ) as Record<DataDomain, number>;
  const usableTotal = sumVolumes(usable);
  const target = Math.max(
    0,
    opts.targetMTok ??
      recipeVolumeTargetMTok({
        paramsB: opts.paramsB,
        family: opts.family,
        backbone: opts.backbone,
        activeParamsB: opts.activeParamsB,
        trainShare: opts.trainShare,
        usableTotal,
        volumePolicy: opts.volumePolicy,
        totalCapMTok: opts.totalCapMTok,
      }),
  );
  const share = opts.postTrainShare ?? DEFAULT_RECIPE_ALIGN_SHARE;
  const empty = emptyDomainVolumes();
  if (target <= 1e-9) {
    return { base: empty, align: { ...empty }, totalMTok: 0 };
  }

  const base = { ...empty };
  const align = { ...empty };
  const useAllStock = target + 1e-9 >= usableTotal;
  const weights = normalizeWeights(opts.weights);
  for (const domain of DATA_DOMAINS) {
    const envelope = useAllStock
      ? usable[domain]
      : Math.min(target * (weights[domain] ?? 0), usable[domain]);
    const split = scaleEnvelope(0, 0, envelope, share);
    base[domain] = split.base;
    align[domain] = split.align;
  }
  return {
    base,
    align,
    totalMTok: sumVolumes(base) + sumVolumes(align),
  };
}

export interface RecipeOutcomeSignals {
  postTrainShare: number;
  trainShare: number;
  verifyShare: number;
  baseShare: number;
  oneXMTok: number;
  totalMTok: number;
  /** Base × train tokens relative to 1 token/parameter. */
  capabilityVolumeRatio: number;
  /** Align tokens relative to 1 token/parameter. */
  alignmentVolumeRatio: number;
  /** Verify holdout relative to 1 token/parameter. */
  verifyVolumeRatio: number;
}

export function recipeOutcomeSignals(opts: {
  totalMTok: number;
  paramsB: number;
  family?: ModelFamily;
  backbone?: ModelBackbone;
  activeParamsB?: number;
  postTrainShare?: number;
  trainShare?: number;
}): RecipeOutcomeSignals {
  const postTrainShare = clamp(
    opts.postTrainShare ?? DEFAULT_RECIPE_ALIGN_SHARE,
    MIN_POST_TRAIN_SHARE,
    MAX_POST_TRAIN_SHARE,
  );
  const trainShare = clamp(
    opts.trainShare ?? DEFAULT_RECIPE_TRAIN_SHARE,
    0.4,
    0.95,
  );
  const verifyShare = 1 - trainShare;
  const baseShare = 1 - postTrainShare;
  const oneXMTok = Math.max(
    1,
    trainingDataParameterBasisB({
      paramsB: opts.paramsB,
      activeParamsB: opts.activeParamsB,
      family: opts.family ?? "dense",
      backbone: opts.backbone,
    }) * 1000,
  );
  const totalMTok = Math.max(0, opts.totalMTok);
  return {
    postTrainShare,
    trainShare,
    verifyShare,
    baseShare,
    oneXMTok,
    totalMTok,
    capabilityVolumeRatio: (totalMTok * baseShare * trainShare) / oneXMTok,
    alignmentVolumeRatio: (totalMTok * postTrainShare) / oneXMTok,
    verifyVolumeRatio: (totalMTok * verifyShare) / oneXMTok,
  };
}

function clampAxis(n: number) {
  return clamp(n, 0, 100);
}

/**
 * Shared capability/quality consequences of the spider recipe.
 * Player finalize and rival buildScaledModel both call this.
 */
export function applyRecipeOutcome(opts: {
  capability: number;
  quality: QualityAxes;
  signals: RecipeOutcomeSignals;
  continueMode?: boolean;
}): { capability: number; quality: QualityAxes } {
  const {
    trainShare,
    verifyShare,
    baseShare,
    postTrainShare,
    totalMTok,
    oneXMTok,
  } = opts.signals;
  const quality = { ...opts.quality };
  let capability = opts.capability;
  if (opts.continueMode) {
    const soft = Math.min(1.4, Math.log10(1 + totalMTok / 50) / 2);
    capability = clampAxis(capability + soft * trainShare * 4 + soft * 1.5);
    quality.safety = clampAxis(quality.safety + soft * verifyShare * 6);
    quality.reliability = clampAxis(
      quality.reliability + soft * verifyShare * 5 + soft * 2,
    );
    quality.reasoning = clampAxis(quality.reasoning + soft * trainShare * 3);
    quality.coding = clampAxis(quality.coding + soft * trainShare * 2.5);
    quality.chat = clampAxis(
      quality.chat + soft * postTrainShare * 3 - Math.max(0, 0.22 - postTrainShare) * 4,
    );
    return { capability, quality };
  }
  const volRatio = Math.min(2, totalMTok / Math.max(1, oneXMTok));
  const overData = Math.max(0, volRatio - 1);
  capability = clampAxis(
    capability *
      (0.88 +
        trainShare * 0.06 +
        baseShare * 0.08 +
        overData * trainShare * baseShare * 0.06),
  );
  quality.safety = clampAxis(
    quality.safety +
      verifyShare * 12 +
      overData * verifyShare * 8 +
      postTrainShare * 4,
  );
  quality.reliability = clampAxis(
    quality.reliability + verifyShare * 10 + overData * verifyShare * 6,
  );
  quality.chat = clampAxis(
    quality.chat +
      postTrainShare * 10 -
      Math.max(0, 0.22 - postTrainShare) * 18,
  );
  quality.reasoning = clampAxis(
    quality.reasoning + trainShare * baseShare * overData * 4,
  );
  quality.coding = clampAxis(
    quality.coding + trainShare * baseShare * overData * 3,
  );
  return { capability, quality };
}

export interface PlannedTrainingRecipe {
  base: Record<DataDomain, number>;
  align: Record<DataDomain, number>;
  totalMTok: number;
  baseMTok: number;
  alignMTok: number;
  trainShare: number;
  postTrainShare: number;
  trainMTok: number;
  verifyMTok: number;
  signals: RecipeOutcomeSignals;
  dataPlan: TrainingDataPlan;
}

/** Canonical recipe for player UI and rival AI. */
export function planTrainingRecipe(opts: {
  paramsB: number;
  family: ModelFamily;
  backbone?: ModelBackbone;
  activeParamsB?: number;
  weights: Partial<Record<DataDomain, number>>;
  postTrainWeights?: Partial<Record<DataDomain, number>>;
  usableByDomain: Partial<Record<DataDomain, number>>;
  postTrainShare?: number;
  trainShare?: number;
  volumePolicy?: RecipeVolumePolicy;
  totalCapMTok?: number;
  allowSynthetic?: boolean;
  includeSynthHQ?: boolean;
  includeSynthLQ?: boolean;
}): PlannedTrainingRecipe {
  const trainShare = clamp(
    opts.trainShare ?? DEFAULT_RECIPE_TRAIN_SHARE,
    0.4,
    0.95,
  );
  const postTrainShare = clamp(
    opts.postTrainShare ?? DEFAULT_RECIPE_ALIGN_SHARE,
    MIN_POST_TRAIN_SHARE,
    MAX_POST_TRAIN_SHARE,
  );
  const seeded = seedRecipeVolumes({
    weights: opts.weights,
    postTrainWeights: opts.postTrainWeights,
    paramsB: opts.paramsB,
    usableByDomain: opts.usableByDomain,
    postTrainShare,
    totalCapMTok: opts.totalCapMTok,
    family: opts.family,
    backbone: opts.backbone,
    activeParamsB: opts.activeParamsB,
    trainShare,
    volumePolicy: opts.volumePolicy,
  });
  const baseMTok = sumVolumes(seeded.base);
  const alignMTok = sumVolumes(seeded.align);
  const weights =
    baseMTok > 1e-9 ? normalizeWeights(seeded.base) : normalizeWeights(opts.weights);
  const postTrainWeights =
    alignMTok > 1e-9
      ? normalizeWeights(seeded.align)
      : normalizeWeights(
          opts.postTrainWeights ?? alignmentDataWeights(opts.weights),
        );
  const signals = recipeOutcomeSignals({
    totalMTok: seeded.totalMTok,
    paramsB: opts.paramsB,
    family: opts.family,
    backbone: opts.backbone,
    activeParamsB: opts.activeParamsB,
    postTrainShare,
    trainShare,
  });
  return {
    ...seeded,
    baseMTok,
    alignMTok,
    trainShare,
    postTrainShare,
    trainMTok: seeded.totalMTok * trainShare,
    verifyMTok: seeded.totalMTok * (1 - trainShare),
    signals,
    dataPlan: {
      totalUnits: baseMTok,
      totalMTok: baseMTok,
      trainShare,
      weights,
      postTrainWeights,
      postTrainShare,
      postTrainMTok: alignMTok,
      allowSynthetic: opts.allowSynthetic,
      includeSynthHQ: opts.includeSynthHQ,
      includeSynthLQ: opts.includeSynthLQ,
    },
  };
}

export interface RivalRecipeKnobs {
  volumePolicy: RecipeVolumePolicy;
  postTrainShare: number;
  trainShare: number;
}

/** Mid-point knobs for planning (no roll). Still the same function. */
export function expectedRivalTrainingRecipeKnobs(
  archetype: RivalArchetype,
  opts?: { isCatchUp?: boolean },
): RivalRecipeKnobs {
  return chooseRivalTrainingRecipeKnobs(
    archetype,
    {
      next: () => 0.5,
      range: (lo, hi) => (lo + hi) / 2,
    },
    opts,
  );
}

/**
 * Simulated rival call into the shared recipe planner. Archetype biases the
 * knobs; the actual mix/caps still go through `planTrainingRecipe`.
 */
export function chooseRivalTrainingRecipeKnobs(
  archetype: RivalArchetype,
  rng: Pick<Rng, "next" | "range">,
  opts?: { isCatchUp?: boolean },
): RivalRecipeKnobs {
  const roll = rng.next();
  let volumePolicy: RecipeVolumePolicy = "floor";
  let alignLo = 0.42;
  let alignHi = 0.58;
  let trainLo = 0.78;
  let trainHi = 0.86;

  if (archetype === "hyperscale") {
    volumePolicy = roll < 0.12 ? "floor" : roll < 0.78 ? "strong" : "all";
    alignLo = 0.32;
    alignHi = 0.52;
    trainLo = 0.8;
    trainHi = 0.9;
  } else if (archetype === "open_weights") {
    volumePolicy = roll < 0.4 ? "floor" : roll < 0.88 ? "strong" : "all";
    alignLo = 0.4;
    alignHi = 0.58;
  } else if (archetype === "efficiency") {
    volumePolicy = roll < 0.72 ? "floor" : "strong";
    alignLo = 0.45;
    alignHi = 0.55;
    trainLo = 0.8;
    trainHi = 0.86;
  } else if (archetype === "multimodal") {
    volumePolicy = roll < 0.22 ? "floor" : roll < 0.82 ? "strong" : "all";
    alignLo = 0.42;
    alignHi = 0.58;
  } else if (archetype === "safety") {
    volumePolicy = roll < 0.42 ? "floor" : roll < 0.9 ? "strong" : "all";
    alignLo = 0.55;
    alignHi = 0.78;
    trainLo = 0.68;
    trainHi = 0.8;
  }

  if (opts?.isCatchUp && volumePolicy === "floor" && rng.next() < 0.65) {
    volumePolicy = "strong";
  }

  return {
    volumePolicy,
    postTrainShare: clamp(rng.range(alignLo, alignHi), MIN_POST_TRAIN_SHARE, MAX_POST_TRAIN_SHARE),
    trainShare: clamp(rng.range(trainLo, trainHi), 0.4, 0.95),
  };
}

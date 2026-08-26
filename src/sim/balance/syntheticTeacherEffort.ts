import type { DataDomain, EffortRecipe, Model } from "../types";
import {
  effortComputeIntensityForRecipe,
  effortViewForRecipe,
  INSTANT_EFFORT_ID,
  instantRecipe,
  migrateEffortRecipes,
  serveTokenMultiplierForRecipe,
} from "./modelProduct";
import { teacherCapabilityForDataDomain } from "./modelCapabilities";
import { pfPerMTokForModel } from "./serveCompute";

/** Internal corpus-factory charge per generated/billed MTok. */
export const SYNTHETIC_GENERATION_CASH_PER_BILLED_MTOK = 250;

/** Text reasoning recipes do not apply to image/video/audio-only generators. */
export function modelSupportsSyntheticTeacherEffort(
  model: Pick<Model, "family" | "productPreset" | "io">,
): boolean {
  if (model.io) return (model.io.outputs.text ?? 0) > 0;
  if (
    model.productPreset === "image_generation" ||
    model.productPreset === "video_generation"
  ) {
    return false;
  }
  return model.family !== "diffusion" && model.family !== "video";
}

/** Instant plus every actually trained model-owned thinking recipe. */
export function availableSyntheticTeacherRecipes(model: Model): EffortRecipe[] {
  const recipes = migrateEffortRecipes(model.productProfile);
  const instant =
    recipes.find(
      (recipe) =>
        recipe.id === INSTANT_EFFORT_ID || recipe.kind === "instant",
    ) ?? instantRecipe();
  if (!modelSupportsSyntheticTeacherEffort(model)) return [instant];
  return [
    instant,
    ...recipes.filter(
      (recipe) =>
        recipe.id !== instant.id &&
        recipe.kind === "trained" &&
        recipe.trained,
    ),
  ];
}

/** Invalid, unavailable and legacy-missing selections safely become Instant. */
export function resolveSyntheticTeacherRecipe(
  model: Model,
  requestedRecipeId: string | undefined,
): EffortRecipe {
  const recipes = availableSyntheticTeacherRecipes(model);
  return (
    recipes.find((recipe) => recipe.id === requestedRecipeId) ?? recipes[0]!
  );
}

function hardBenchLiftForDomain(
  model: Model,
  recipeId: string,
  domain: DataDomain,
): number {
  const view = effortViewForRecipe(model, recipeId);
  if (!view) return 0;
  if (domain === "code") {
    return Math.max(0, view.benchmarks.coding - model.benchmarks.coding);
  }
  if (domain === "math") {
    return Math.max(0, view.benchmarks.math - model.benchmarks.math);
  }
  if (domain === "science") {
    return Math.max(0, view.benchmarks.science - model.benchmarks.science);
  }
  if (domain === "law") {
    return Math.max(
      0,
      (view.benchmarks.law - model.benchmarks.law) * 0.65 +
        (view.capability - model.capability) * 0.35,
    );
  }
  if (domain === "health") {
    return Math.max(
      0,
      (view.benchmarks.health - model.benchmarks.health) * 0.55 +
        (view.benchmarks.science - model.benchmarks.science) * 0.25 +
        (view.capability - model.capability) * 0.2,
    );
  }
  if (domain === "chat") {
    return Math.max(0, view.capability - model.capability) * 0.55;
  }
  // Thinking heads do not manufacture a missing media skill.
  return 0;
}

/** Domain skill after the selected recipe's realized, quality-gated lift. */
export function syntheticTeacherDomainCapability(
  model: Model,
  domain: DataDomain,
  requestedRecipeId?: string,
): number {
  const recipe = resolveSyntheticTeacherRecipe(model, requestedRecipeId);
  return Math.min(
    100,
    teacherCapabilityForDataDomain(model, domain) +
      hardBenchLiftForDomain(model, recipe.id, domain),
  );
}

export function peakSyntheticTeacherDomainCapability(
  model: Model,
  domain: DataDomain,
): number {
  return Math.max(
    ...availableSyntheticTeacherRecipes(model).map((recipe) =>
      syntheticTeacherDomainCapability(model, domain, recipe.id),
    ),
  );
}

export interface SyntheticTeacherGenerationEconomics {
  effortId: string;
  effortName: string;
  effortQuality: number;
  thinkingTokenMultiplier: number;
  effectiveCapability: number;
  effectiveDomainCapability: number;
  /** Generated/billed tokens per accepted dataset token. */
  billedTokenMultiplier: number;
  computeIntensityMultiplier: number;
  generatedTokenMTok: number;
  computePfDays: number;
  cashCost: number;
  computePfDaysPerAcceptedMTok: number;
  cashPerAcceptedMTok: number;
}

/**
 * Forecast and frozen accounting for one accepted synthetic corpus slice.
 * Every hidden reasoning token is billed and burns physical inference PF.
 */
export function syntheticTeacherGenerationEconomics(input: {
  model: Model;
  domain: DataDomain;
  effortId?: string;
  acceptedMTok: number;
}): SyntheticTeacherGenerationEconomics {
  const acceptedMTok = Math.max(0, input.acceptedMTok);
  const recipe = resolveSyntheticTeacherRecipe(input.model, input.effortId);
  const view = effortViewForRecipe(input.model, recipe.id);
  const billedTokenMultiplier = serveTokenMultiplierForRecipe(
    recipe,
    input.model.productProfile?.tokenEfficiency ?? 100,
  );
  const generatedTokenMTok = acceptedMTok * billedTokenMultiplier;
  const computeIntensityMultiplier =
    effortComputeIntensityForRecipe(recipe);
  const computePfDaysPerAcceptedMTok =
    pfPerMTokForModel(input.model, 1) *
    billedTokenMultiplier *
    computeIntensityMultiplier;
  const cashPerAcceptedMTok =
    SYNTHETIC_GENERATION_CASH_PER_BILLED_MTOK * billedTokenMultiplier;
  return {
    effortId: recipe.id,
    effortName: recipe.name,
    effortQuality: recipe.quality,
    thinkingTokenMultiplier: recipe.thinkingTokenMult,
    effectiveCapability: view?.capability ?? input.model.capability,
    effectiveDomainCapability: syntheticTeacherDomainCapability(
      input.model,
      input.domain,
      recipe.id,
    ),
    billedTokenMultiplier,
    computeIntensityMultiplier,
    generatedTokenMTok,
    computePfDays: acceptedMTok * computePfDaysPerAcceptedMTok,
    cashCost: acceptedMTok * cashPerAcceptedMTok,
    computePfDaysPerAcceptedMTok,
    cashPerAcceptedMTok,
  };
}

import type { ModelBackbone, ModelFamily } from "../types";

/**
 * Coarse architecture families used by the capability-frontier simulation.
 *
 * These are gameplay blueprints, not scientific claims that a real-world
 * architecture has a universal benchmark score. The caps create durable
 * strategic trade-offs after ordinary scaling, data, and recipe gains saturate.
 */
export type ArchitectureBlueprintId = "dense" | "moe" | "omni" | "specialist";

export type ArchitectureActivationPattern =
  | "all-parameters"
  | "routed-experts"
  | "backbone-dependent"
  | "task-specialist";

export interface ArchitectureBlueprintProfile {
  id: ArchitectureBlueprintId;
  label: string;
  /** Fixed pretraining wall in Labline capability units, before distillation. */
  pretrainingCapabilityCap: number;
  /** Omni-only ceiling after independently verified recursive breakthroughs. */
  verifiedRecursiveCapabilityCap: number;
  /** Relative effective-data breadth needed to approach the blueprint wall. */
  dataDemandMultiplier: number;
  /** Relative generated-token / agent-work burden at frontier use. */
  outputTokenDemandMultiplier: number;
  trainingStability: "high" | "medium" | "low";
  activationPattern: ArchitectureActivationPattern;
  advantages: readonly string[];
  constraints: readonly string[];
}

const BLUEPRINTS: Record<
  ArchitectureBlueprintId,
  Omit<ArchitectureBlueprintProfile, "activationPattern">
> = {
  dense: {
    id: "dense",
    label: "Dense transformer",
    pretrainingCapabilityCap: 82,
    verifiedRecursiveCapabilityCap: 82,
    dataDemandMultiplier: 1,
    outputTokenDemandMultiplier: 1,
    trainingStability: "high",
    advantages: [
      "Every parameter learns on every token",
      "Predictable optimization and deployment",
      "Strong quality at small and medium scale",
    ],
    constraints: [
      "Every parameter is active for every token",
      "Training and serving cost grow with the full model",
      "Fixed blueprint frontier requires distillation or a new architecture to cross",
    ],
  },
  moe: {
    id: "moe",
    label: "Mixture of experts",
    pretrainingCapabilityCap: 89,
    verifiedRecursiveCapabilityCap: 89,
    dataDemandMultiplier: 1.2,
    outputTokenDemandMultiplier: 1.08,
    trainingStability: "medium",
    advantages: [
      "More learned capacity than the active compute path",
      "Experts can specialize by domain and token",
      "Higher blueprint frontier than a pure dense stack",
    ],
    constraints: [
      "Routing and load balance can starve or collapse experts",
      "The full expert bank still consumes memory and network bandwidth",
      "Small-batch serving needs expert-aware kernels and caching",
    ],
  },
  omni: {
    id: "omni",
    label: "Omni model",
    pretrainingCapabilityCap: 94,
    verifiedRecursiveCapabilityCap: 97,
    dataDemandMultiplier: 1.8,
    outputTokenDemandMultiplier: 1.75,
    trainingStability: "low",
    advantages: [
      "Cross-modal transfer and a shared world representation",
      "Tools, agents, and media can reinforce one product frontier",
      "Only blueprint that can bank verified recursive breakthroughs",
    ],
    constraints: [
      "Needs scarce aligned text, image, audio, video, and tool traces",
      "Modalities can interfere or regress without careful curricula",
      "Long agent traces and media outputs multiply training and serving compute",
    ],
  },
  specialist: {
    id: "specialist",
    label: "Specialist generator",
    pretrainingCapabilityCap: 90,
    verifiedRecursiveCapabilityCap: 90,
    dataDemandMultiplier: 1.35,
    outputTokenDemandMultiplier: 1.4,
    trainingStability: "medium",
    advantages: ["High task-specific quality within its native modality"],
    constraints: [
      "Specialist gains do not become general reasoning for free",
      "Requires modality-specific data, evaluation, and serving infrastructure",
    ],
  },
};

export interface ArchitectureBlueprintInput {
  family?: ModelFamily;
  backbone?: ModelBackbone;
  /**
   * Capability points retained from completed, independently verified closed
   * loops. A campaign system must earn this value; unlocking research alone
   * must never grant it.
   */
  verifiedRecursiveCapabilityBonus?: number;
}

export function architectureBlueprintId(
  input: ArchitectureBlueprintInput,
): ArchitectureBlueprintId {
  if (input.family === "omni") return "omni";
  if (input.backbone === "moe" || input.family === "moe") return "moe";
  if (
    input.backbone === "diffusion" ||
    input.family === "diffusion" ||
    input.family === "video"
  ) {
    return "specialist";
  }
  return "dense";
}

/** Pure, UI-safe description of an architecture's strategic profile. */
export function architectureBlueprintProfile(
  input: ArchitectureBlueprintInput,
): ArchitectureBlueprintProfile {
  const id = architectureBlueprintId(input);
  const base = BLUEPRINTS[id];
  const activationPattern: ArchitectureActivationPattern =
    id === "omni"
      ? input.backbone === "moe"
        ? "routed-experts"
        : input.backbone === "dense"
          ? "all-parameters"
          : "backbone-dependent"
      : id === "moe"
        ? "routed-experts"
        : id === "specialist"
          ? "task-specialist"
          : "all-parameters";
  return { ...base, activationPattern };
}

/**
 * Gameplay pretraining wall for a concrete architecture choice.
 *
 * Only omni can extend its blueprint wall with verified closed-loop gains, and
 * even that extension is bounded. Distillation is deliberately applied later
 * by modelScaling and may transfer capability across this pretraining wall.
 */
export function architecturePretrainingCapabilityCap(
  input: ArchitectureBlueprintInput,
): number {
  const profile = architectureBlueprintProfile(input);
  if (profile.id !== "omni") return profile.pretrainingCapabilityCap;
  const verifiedBonus = Math.max(
    0,
    input.verifiedRecursiveCapabilityBonus ?? 0,
  );
  return Math.min(
    profile.verifiedRecursiveCapabilityCap,
    profile.pretrainingCapabilityCap + verifiedBonus,
  );
}

/**
 * Raw quality-weighted tokens per parameter translated into the coverage this
 * blueprint can actually exploit. The caller retains the raw ratio for player
 * decisions and gates; this adjusted value is only for capability scaling.
 */
export function architectureAdjustedDataCoverage(
  input: ArchitectureBlueprintInput & { dataCoverage: number },
): number {
  const profile = architectureBlueprintProfile(input);
  return (
    Math.max(0, input.dataCoverage) /
    Math.max(0.01, profile.dataDemandMultiplier)
  );
}

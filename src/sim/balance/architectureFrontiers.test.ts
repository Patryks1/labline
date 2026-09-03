import { describe, expect, it } from "vitest";
import { aggregateEffects } from "../systems/research";
import { getResearchNode } from "./research";
import {
  architectureBlueprintProfile,
  architecturePretrainingCapabilityCap,
} from "./architectureFrontiers";
import { capabilityCeiling } from "./modelScaling";

describe("gameplay architecture blueprint profiles", () => {
  it("makes the architecture trade-offs explicit and ordered", () => {
    const dense = architectureBlueprintProfile({ family: "dense" });
    const moe = architectureBlueprintProfile({
      family: "moe",
      backbone: "moe",
    });
    const omni = architectureBlueprintProfile({
      family: "omni",
      backbone: "moe",
    });

    expect(dense.activationPattern).toBe("all-parameters");
    expect(dense.trainingStability).toBe("high");
    expect(moe.activationPattern).toBe("routed-experts");
    expect(moe.constraints.join(" ")).toMatch(/routing|expert bank/i);
    expect(omni.dataDemandMultiplier).toBeGreaterThan(moe.dataDemandMultiplier);
    expect(omni.outputTokenDemandMultiplier).toBeGreaterThan(
      moe.outputTokenDemandMultiplier,
    );
    expect(dense.pretrainingCapabilityCap).toBeLessThan(
      moe.pretrainingCapabilityCap,
    );
    expect(moe.pretrainingCapabilityCap).toBeLessThan(
      omni.pretrainingCapabilityCap,
    );
  });

  it("resolves sparse omni as omni rather than losing its product frontier", () => {
    const sparseOmni = architectureBlueprintProfile({
      family: "omni",
      backbone: "moe",
    });

    expect(sparseOmni.id).toBe("omni");
    expect(sparseOmni.activationPattern).toBe("routed-experts");
  });
});

describe("architecture pretraining walls", () => {
  const saturatedRecipe = {
    paramsB: 10_000,
    dataCoverage: 200,
    dataQuality: 1.4,
    researchMult: 1.14,
    reasoningEnabled: true,
    overtrainCapBonus: 99,
  };

  it("hard-caps ordinary pretraining at each blueprint frontier", () => {
    const dense = capabilityCeiling({
      ...saturatedRecipe,
      family: "dense",
      backbone: "dense",
    });
    const moe = capabilityCeiling({
      ...saturatedRecipe,
      family: "moe",
      backbone: "moe",
      activeParamsB: 1_000,
    });
    const omni = capabilityCeiling({
      ...saturatedRecipe,
      family: "omni",
      backbone: "dense",
    });

    expect(dense.capability).toBe(dense.blueprintCap);
    expect(moe.capability).toBe(moe.blueprintCap);
    expect(omni.capability).toBe(omni.blueprintCap);
    expect(dense.limitingFactor).toBe("architecture blueprint");
    expect(dense.blueprintCap).toBe(82);
    expect(moe.blueprintCap).toBe(89);
    expect(omni.blueprintCap).toBe(94);
  });

  it("keeps distillation as a separate path across a dense pretraining wall", () => {
    const pretrain = capabilityCeiling({
      ...saturatedRecipe,
      family: "dense",
    });
    const distilled = capabilityCeiling({
      ...saturatedRecipe,
      family: "dense",
      teacherCapability: 100,
    });

    expect(pretrain.capability).toBe(82);
    expect(distilled.capability).toBe(88);
    expect(distilled.capability).toBeGreaterThan(pretrain.blueprintCap);
    expect(distilled.distillationBonus).toBe(6);
    expect(distilled.limitingFactor).toBe("teacher");
  });

  it("accepts bounded verified recursive gains for omni only", () => {
    expect(
      architecturePretrainingCapabilityCap({
        family: "dense",
        verifiedRecursiveCapabilityBonus: 100,
      }),
    ).toBe(82);
    expect(
      architecturePretrainingCapabilityCap({
        family: "moe",
        verifiedRecursiveCapabilityBonus: 100,
      }),
    ).toBe(89);
    expect(
      architecturePretrainingCapabilityCap({
        family: "omni",
        verifiedRecursiveCapabilityBonus: 100,
      }),
    ).toBe(97);

    const recursiveOmni = capabilityCeiling({
      ...saturatedRecipe,
      family: "omni",
      verifiedRecursiveCapabilityBonus: 100,
    });
    expect(recursiveOmni.capability).toBe(97);
  });
});

describe("closed-loop autonomous research unlock", () => {
  it("is a late omni gate with no passive capability grant", () => {
    const node = getResearchNode("mm_closed_loop_research");

    expect(node.name).toBe("Closed-Loop Autonomous Research");
    expect(node.prereqs).toEqual(
      expect.arrayContaining([
        "mm_omni",
        "align_agent_redteam",
        "data_self_train",
        "domain_agents",
        "opt_compute_sched",
        "sys_kernel_fusion_v2",
      ]),
    );
    expect(node.description).toMatch(/verif/i);
    expect(node.description).toMatch(/fresh real data/i);
    expect(node.description).toMatch(/agent/i);
    expect(node.description).toMatch(/compute/i);
    expect(node.effects).toMatchObject({ unlockClosedLoopResearch: true });
    expect(aggregateEffects([node.id]).unlockClosedLoopResearch).toBe(true);
  });
});

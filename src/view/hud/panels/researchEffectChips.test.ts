import { describe, expect, it } from "vitest";
import { getResearchNode } from "../../../sim/balance/research";
import { effectChips } from "./researchEffectChips";

describe("effectChips", () => {
  it("prints exact V4 multipliers and unlock labels", () => {
    const distill = effectChips(getResearchNode("opt_distill_stack"));
    expect(distill).toContainEqual({
      label: "Distill ×1.15",
      tone: "good",
    });
    expect(distill).toContainEqual({
      label: "Unlock: Distill",
      tone: "unlock",
    });

    const moe = effectChips(getResearchNode("moe_basics"));
    expect(moe).toContainEqual({ label: "A ×0.98", tone: "good" });
    expect(moe).toContainEqual({ label: "Unlock: MoE", tone: "unlock" });

    const flash = effectChips(getResearchNode("opt_flash"));
    expect(flash).toContainEqual({
      label: "Throughput ×1.1",
      tone: "good",
    });

    const nvfp4 = effectChips(getResearchNode("opt_nvfp4_train"));
    expect(nvfp4.some((chip) => chip.label.startsWith("σ ×"))).toBe(true);
    expect(nvfp4).toContainEqual({
      label: "Unlock: NVFP4 train",
      tone: "unlock",
    });
  });

  it("does not emit legacy capability or training-speed copy", () => {
    for (const id of ["dense_opt", "moe_basics", "opt_checkpoint", "mm_omni"]) {
      const labels = effectChips(getResearchNode(id)).map((chip) => chip.label);
      expect(labels.join(" ")).not.toMatch(/capability \+/i);
      expect(labels.join(" ")).not.toMatch(/training speed/i);
    }
  });
});

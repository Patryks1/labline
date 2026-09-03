import { describe, expect, it } from "vitest";
import { defaultArchitecture } from "../../../../../sim/training/state";
import { glyphFor, sizeLabel } from "../viewModels/selectors";

describe("architecture view labels", () => {
  it("formats dense, trillion, and MoE size labels", () => {
    expect(sizeLabel(defaultArchitecture())).toBe("7B");
    expect(
      sizeLabel({ ...defaultArchitecture(), totalParamsB: 70, activeParamsB: 70 }),
    ).toBe("70B");
    expect(
      sizeLabel({ ...defaultArchitecture(), totalParamsB: 1200, activeParamsB: 1200 }),
    ).toBe("1.2T");
    expect(
      sizeLabel({
        ...defaultArchitecture(),
        backbone: "moe",
        totalParamsB: 400,
        activeParamsB: 40,
      }),
    ).toBe("400B/40B active");
  });

  it("picks omni, moe, specialist, and dense glyphs", () => {
    expect(glyphFor({ ...defaultArchitecture(), preset: "omni" })).toBe("omni");
    expect(glyphFor({ ...defaultArchitecture(), backbone: "moe" })).toBe("moe");
    expect(glyphFor({ ...defaultArchitecture(), preset: "vision_language" })).toBe(
      "specialist",
    );
    expect(glyphFor(defaultArchitecture())).toBe("dense");
  });
});

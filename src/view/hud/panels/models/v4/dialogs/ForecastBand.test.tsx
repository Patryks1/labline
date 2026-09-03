import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Forecast } from "../../../../../../sim/training/types";
import { ForecastBand } from "./ForecastBand";

const forecast: Forecast = {
  compute: {
    trainPfDays: 10,
    holdoutPfDays: 1,
    totalPfDays: 11,
    archCost: 1,
    modalityCost: 1,
    throughput: 1,
    days: 8,
    paceFloorDays: 3,
    trainHbmGB: 84,
    cashEstimate: 1320,
  },
  loss: {
    nEff: 7e9,
    dEff: 1e11,
    paramTerm: 1,
    dataTerm: 1,
    loss: 2,
    precisionPenalty: 0,
    gap: 0.3,
  },
  effectiveData: {
    rawMTok: 100,
    uniqueMTok: 100,
    effectiveMTok: 100,
    qualityWeight: 1,
    diversity: 1,
    epochs: 1,
    epochFactor: 1,
    syntheticShare: 0,
    syntheticDiscount: 1,
    domainMix: {},
    perDomain: {},
  },
  capability: { p10: 40, p50: 48, p90: 55, ceiling: 82, sigma: 0.06 },
  domains: {
    language: 48,
    reasoning: 40,
    code: 50,
    math: 44,
    science: 42,
    vision: 10,
    video: 5,
    audio: 8,
    tools: 20,
  },
  blockers: [{ code: "locked_moe", message: "MoE is locked" }],
  warnings: ["Scale jump"],
};

describe("ForecastBand", () => {
  it("renders P10/P50/P90, ceiling, and blockers", () => {
    const markup = renderToStaticMarkup(
      createElement(ForecastBand, { forecast, error: null }),
    );
    expect(markup).toContain("data-forecast-band");
    expect(markup).toContain("data-p10");
    expect(markup).toContain("P10 40");
    expect(markup).toContain("P50 48");
    expect(markup).toContain("P90 55");
    expect(markup).toContain("data-ceiling");
    expect(markup).toContain("ceil 82");
    expect(markup).toContain("data-forecast-blockers");
    expect(markup).toContain("MoE is locked");
    expect(markup).toContain("Scale jump");
  });

  it("renders the unavailable band when forecast is missing", () => {
    const markup = renderToStaticMarkup(
      createElement(ForecastBand, { forecast: null, error: "not implemented" }),
    );
    expect(markup).toContain("data-forecast-unavailable");
    expect(markup).toContain("Forecast unavailable");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CapabilityBandChip, formatCapScore, OverallScoreStat } from "./CapabilityBandChip";

describe("CapabilityBandChip", () => {
  it("renders overall mean ± half-band", () => {
    const markup = renderToStaticMarkup(
      createElement(CapabilityBandChip, {
        band: { p10: 41.2, p50: 47.8, p90: 52.4, ceiling: 82 },
        label: "Eval",
      }),
    );

    expect(markup).toContain("status-chip");
    expect(markup).toContain("status-chip--train");
    expect(markup).toContain("font-mono");
    expect(markup).toContain("Eval 47.8 ±5.6");
    expect(markup).toContain("data-cap-band=\"true\"");
    expect(markup).not.toContain("41-52 · 48");
  });

  it("renders Unmeasured when no eval exists", () => {
    const markup = renderToStaticMarkup(createElement(CapabilityBandChip, { band: null }));
    expect(markup).toContain("Unmeasured");
    expect(markup).toContain("data-cap-band=\"empty\"");
  });

  it("formats a forecast band as score ± spread", () => {
    expect(formatCapScore({ p10: 7, p50: 9, p90: 10, ceiling: 82 })).toBe("9.0 ±1.5");
  });

  it("renders Overall as a metric tile", () => {
    const markup = renderToStaticMarkup(
      createElement(OverallScoreStat, {
        band: { p10: 7.2, p50: 8.8, p90: 10.4, ceiling: 82 },
      }),
    );
    expect(markup).toContain("Overall");
    expect(markup).toContain("8.8 ±1.6");
    expect(markup).toContain("metric-tile");
  });
});

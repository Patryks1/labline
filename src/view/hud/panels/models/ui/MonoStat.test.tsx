import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MonoStat } from "./MonoStat";

describe("MonoStat", () => {
  it("renders a metric tile with optional hint and tone", () => {
    const markup = renderToStaticMarkup(
      createElement(MonoStat, {
        label: "HBM",
        value: "48 GB",
        hint: "resident",
        tone: "warn",
      }),
    );

    expect(markup).toContain("metric-tile");
    expect(markup).toContain("metric-tile--warning");
    expect(markup).toContain("metric-tile__label");
    expect(markup).toContain("HBM");
    expect(markup).toContain("48 GB");
    expect(markup).toContain("resident");
  });
});

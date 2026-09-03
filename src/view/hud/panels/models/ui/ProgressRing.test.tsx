import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgressRing } from "./ProgressRing";

describe("ProgressRing", () => {
  it("renders an SVG progress ring clamped to 0–100", () => {
    const markup = renderToStaticMarkup(
      createElement(ProgressRing, { value: 0.42, label: "Run progress" }),
    );

    expect(markup).toContain("<svg");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="Run progress"');
    expect(markup).toContain('aria-valuenow="42"');
    expect(markup).toContain("stroke-dasharray");
  });
});

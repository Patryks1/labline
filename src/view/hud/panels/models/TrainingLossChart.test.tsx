import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TrainingLossChart } from "./TrainingLossChart";

describe("TrainingLossChart checkpoints", () => {
  it("renders saved weights on the loss timeline with release identity", () => {
    const markup = renderToStaticMarkup(
      createElement(TrainingLossChart, {
        history: [
          { day: 20, stage: "base" as const, progress: 0.4, loss: 4.2 },
          { day: 30, stage: "base" as const, progress: 0.8, loss: 3.7 },
        ],
        failed: false,
        checkpoints: [
          {
            id: "cp-12",
            day: 10,
            progress: 0.12,
            loss: 4.8,
            label: "C12",
            detail: "stealth weights",
            kind: "milestone" as const,
            visibility: "stealth" as const,
          },
          {
            id: "cp-manual",
            day: 25,
            progress: 0.63,
            loss: 3.9,
            label: "Code branch candidate",
            detail: "released as Aster 0.2-code",
            kind: "manual" as const,
            visibility: "released" as const,
          },
        ],
      }),
    );

    expect(markup).toContain(
      "Training loss over time with 2 saved checkpoints",
    );
    expect(markup).toContain("C12 · stealth weights");
    expect(markup).toContain(
      "Code branch candidate · released as Aster 0.2-code",
    );
    expect(markup).toContain("D10");
    expect(markup).toContain("milestone");
    expect(markup).toContain("manual");
    expect(markup).toContain('aria-describedby="');
    expect(markup).toContain('role="button"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('data-training-chart-plot="true"');
    expect(markup).toContain('relative h-32 w-full overflow-visible sm:h-40');
    expect(markup).toContain('touch-pan-y');
    expect(markup).not.toContain('touch-none');
    expect(markup).toContain('observed min 3.70');
    expect(markup).not.toContain('observed min 3.700');
  });
});

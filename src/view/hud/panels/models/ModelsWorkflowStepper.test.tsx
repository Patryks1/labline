import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelsWorkflowStepper } from "./ModelsWorkflowStepper";

describe("ModelsWorkflowStepper", () => {
  it("renders the canonical model progression as one non-nested navigation", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelsWorkflowStepper, {
        activeStep: "compute",
        completedThrough: "data",
        onStepChange: () => undefined,
      }),
    );

    expect(markup).toContain('data-model-workflow="true"');
    expect(markup).toContain('aria-label="Model workflow"');
    expect(markup).toContain('data-step="product"');
    expect(markup).toContain('data-step="architecture"');
    expect(markup).toContain('data-step="data"');
    expect(markup).toContain('data-step="compute"');
    expect(markup).toContain('data-step="review"');
    expect(markup).toContain('aria-label="Compute"');
    expect(markup).toContain("Recipe");
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("← Back");
    expect(markup).toContain("Continue →");
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).not.toContain("truncate");
    expect(markup).not.toContain('role="tablist"');
  });
});

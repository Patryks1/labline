import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  MODELS_CONTINUE_STEPS,
  ModelsWorkflowStepper,
} from "./ModelsWorkflowStepper";

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
    expect(markup).toContain('data-mobile-layout="compact-steps"');
    expect(markup).toContain('aria-label="Model workflow"');
    expect(markup).toContain('data-step="product"');
    expect(markup).toContain('data-step="architecture"');
    expect(markup).toContain('data-step="data"');
    expect(markup).toContain('data-step="compute"');
    expect(markup).toContain('data-step="review"');
    expect(markup).toContain('aria-label="Compute"');
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain(">Back</button>");
    expect(markup).toContain(">Continue</button>");
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain("hidden min-w-0 whitespace-nowrap xl:inline");
    expect(markup).not.toContain("[@media(max-height:600px)]:hidden");
    expect(markup).not.toContain("truncate");
    expect(markup).not.toContain('role="tablist"');
    expect(markup).toContain("grid-cols-5");
  });

  it("renders continue-train extras without goal or topology steps", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelsWorkflowStepper, {
        activeStep: "data",
        steps: MODELS_CONTINUE_STEPS,
        onStepChange: () => undefined,
      }),
    );

    expect(markup).toContain('data-step="data"');
    expect(markup).toContain('data-step="compute"');
    expect(markup).toContain('data-step="review"');
    expect(markup).toContain('aria-label="Data extras"');
    expect(markup).toContain("grid-cols-3");
    expect(markup).not.toContain('data-step="product"');
    expect(markup).not.toContain('data-step="architecture"');
    expect(markup).not.toContain("grid-cols-2");
    expect(markup).not.toContain("grid-cols-5");
  });
});

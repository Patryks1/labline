import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelsTrainingModal } from "./ModelsTrainingModal";
import { MODELS_CONTINUE_STEPS } from "./ModelsWorkflowStepper";

describe("ModelsTrainingModal", () => {
  it("renders a labelled accessible dialog with the workflow in its footer", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ModelsTrainingModal,
        {
          open: true,
          activeStep: "compute",
          completedThrough: "data",
          onStepChange: () => undefined,
          onCancel: () => undefined,
          footerAction: createElement("button", { type: "button" }, "Start"),
        },
        createElement("p", null, "Workflow body"),
      ),
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-labelledby="models-training-workflow"');
    expect(markup).toContain('data-model-workflow="true"');
    expect(markup).toContain("Workflow body");
    expect(markup).toContain(">Done</button>");
    expect(markup).toContain(">Cancel</button>");
    expect(markup).toContain("hud-button--danger");
    expect(markup).toContain("hud-button--primary");
    expect(markup).not.toContain("×");
  });

  it("does not render anything when closed, leaving form state owned by the panel", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelsTrainingModal, {
        open: false,
        activeStep: "product",
        onStepChange: () => undefined,
        onCancel: () => undefined,
      }),
    );

    expect(markup).toBe("");
  });

  it("renders continue training copy without a product step in the footer", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelsTrainingModal, {
        open: true,
        activeStep: "data",
        onStepChange: () => undefined,
        onCancel: () => undefined,
        title: "Continue training",
        description:
          "Add extra data and compute priority. Mix and topology stay inherited.",
        mobileDescription: "Data extras → launch",
        steps: MODELS_CONTINUE_STEPS,
      }),
    );

    expect(markup).toContain("Continue training");
    expect(markup).toContain("Data extras → launch");
    expect(markup).toContain('data-step="data"');
    expect(markup).toContain('data-step="compute"');
    expect(markup).toContain('data-step="review"');
    expect(markup).not.toContain('data-step="product"');
    expect(markup).not.toContain('data-step="architecture"');
  });
});

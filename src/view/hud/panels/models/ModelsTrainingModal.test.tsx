import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelsTrainingModal } from "./ModelsTrainingModal";

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
    expect(markup).not.toContain("×");
  });

  it("does not render anything when closed, leaving form state owned by the panel", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelsTrainingModal, {
        open: false,
        activeStep: "define",
        onStepChange: () => undefined,
        onCancel: () => undefined,
      }),
    );

    expect(markup).toBe("");
  });
});

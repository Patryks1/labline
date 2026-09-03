import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelsWorkbench } from "./ModelsWorkbench";
import { resetModelsUi } from "./modelsUiStore";

describe("ModelsWorkbench", () => {
  it("renders the Models shell, tabs, stats, and New model CTA", () => {
    resetModelsUi();
    const markup = renderToStaticMarkup(createElement(ModelsWorkbench));
    expect(markup).toContain("Models");
    expect(markup).toContain("Pipeline");
    expect(markup).toContain("Fleet");
    expect(markup).toContain("Gyms");
    expect(markup).toContain("New model");
    expect(markup).toContain('data-action="models-new-model"');
    expect(markup).toContain("Runs in flight");
    expect(markup).toContain("Checkpoints kept");
    expect(markup).toContain("Endpoints live");
    expect(markup).toContain("data-pipeline-board");
    expect(markup).not.toContain('data-inspector="true"');
    expect(markup).not.toContain("Select a Run, Checkpoint, or Recipe.");
    expect(markup).toContain("models-v4-layout");
  });
});

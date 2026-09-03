import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelsPanel } from "./ModelsPanel";
import { resetModelsUi } from "./models/v4/modelsUiStore";

describe("ModelsPanel V4 workbench", () => {
  it("renders the V4 Models shell instead of the legacy campaign IA", () => {
    resetModelsUi();
    const markup = renderToStaticMarkup(createElement(ModelsPanel));

    expect(markup.match(/<h2[^>]*>Models<\/h2>/g)).toHaveLength(1);
    expect(markup).toContain("data-models-v4");
    expect(markup).toContain("Pipeline");
    expect(markup).toContain("Fleet");
    expect(markup).toContain("Gyms");
    expect(markup).toContain("New model");
    expect(markup).toContain('data-action="models-new-model"');
    expect(markup).toContain("data-pipeline-board");
    expect(markup).not.toContain("Start campaign");
    expect(markup).not.toContain("Train model");
    expect(markup).not.toContain('data-view="runs"');
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TrainingJob } from "../../../sim/types";
import { ModelsPanel } from "./ModelsPanel";
import { resolveModelsFocusJobId } from "./models/modelsFocus";
import { modelsWorkbenchLayoutForViewport } from "./models/modelsResponsiveLayout";

describe("ModelsPanel workbench IA", () => {
  it("keeps one Models heading and exposes one accessible workspace tablist", () => {
    const markup = renderToStaticMarkup(createElement(ModelsPanel));

    expect(markup.match(/<h2[^>]*>Models<\/h2>/g)).toHaveLength(1);
    expect(markup).toContain('data-models-view-nav="true"');
    expect(markup).toContain('data-view="runs"');
    expect(markup).toContain('data-view="checkpoints"');
    expect(markup).toContain('data-view="labs"');
    expect(markup).toContain('aria-label="Gyms, 0 unlocked"');
    expect(markup).toContain('data-view="routers"');
    expect(markup).toContain('data-view="fleet"');
    expect(markup).toContain("Train model");
    expect(markup.match(/Train model/g)).toHaveLength(1);
    expect(markup).not.toContain("+ Train model");
    expect(markup).not.toContain('data-action="empty-train-model"');
    expect(markup).not.toContain('data-action="new-model"');
    expect(markup).not.toContain("Pretraining is the cheap part");
    expect(markup).toContain("data-models-empty-workbench");
    expect(markup).toContain("data-empty-campaign-pipeline");
    expect(markup).toContain("Start campaign");
    expect(markup).toContain("No campaign yet");
    expect(markup).not.toContain("Train another");
    expect(markup).not.toContain('data-model-workflow="true"');
    expect(markup).not.toContain('data-model-new-workflow="true"');
    expect(markup).not.toContain("Raw strong target");
    expect(markup).not.toContain("Quality ×");
    expect(markup).not.toContain("verification holdout");
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Models workspace tabs"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).not.toContain("Runs · Checkpoints · Fleet");
  });

  it("stacks the queue above the work surface at compact desktop widths", () => {
    const markup = renderToStaticMarkup(createElement(ModelsPanel));

    expect(modelsWorkbenchLayoutForViewport(1024)).toBe("stacked");
    expect(modelsWorkbenchLayoutForViewport(1280)).toBe("stacked");
    expect(modelsWorkbenchLayoutForViewport(1440)).toBe("columns");
    expect(markup).toContain('data-models-workbench-layout="responsive"');
    expect(markup).toContain('data-models-short-landscape="stacked"');
    expect(markup).toContain("max-[1360px]:!grid-cols-1");
    expect(markup).toContain("models-workbench-layout");
    expect(markup).toContain('data-models-swipe-surface="workspace-tabs"');
    expect(markup).toContain('data-mobile-orientations="portrait landscape"');
    expect(markup).toContain('data-shell-gesture-surface="true"');
    expect(markup).not.toContain("sm:!min-h-0");
  });

  it("resolves an explicit concurrent run while preserving missing-run fallback", () => {
    const jobs = [{ id: "run-a" }, { id: "run-b" }] as TrainingJob[];

    expect(resolveModelsFocusJobId(jobs, "run-b")).toBe("run-b");
    expect(resolveModelsFocusJobId(jobs, "missing-run")).toBeNull();
    expect(resolveModelsFocusJobId(jobs, null)).toBeNull();
  });
});

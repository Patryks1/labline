import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PipelineBoard } from "./PipelineBoard";
import { pipelineFixture } from "../viewModels/testFixtures";
import { selectPipelineBoard } from "../viewModels/selectors";
import { resetModelsUi } from "./modelsUiStore";

describe("PipelineBoard", () => {
  it("renders stage columns as a kanban board", () => {
    resetModelsUi();
    const board = selectPipelineBoard(pipelineFixture());
    const markup = renderToStaticMarkup(createElement(PipelineBoard, { board }));
    expect(markup).toContain('data-pipeline-column="training"');
    expect(markup).toContain('data-pipeline-column="checkpoints"');
    expect(markup).toContain('data-pipeline-column="postTraining"');
    expect(markup).toContain('data-pipeline-column="ready"');
    expect(markup).toContain("Training");
    expect(markup).toContain("Checkpoints");
    expect(markup).toContain("Post-training");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Helix · Instruct");
    expect(markup).toContain("data-compute-split");
    expect(markup).toContain("Recipes draw from the training pool");
    expect(markup).toContain('data-card-id="run-1"');
    expect(markup).toContain('data-card-id="cp-stealth"');
    expect(markup).toContain('data-card-id="recipe-1"');
    expect(markup).not.toContain('data-card-id="cp-kept"');
    expect(markup).toContain('data-card-id="cp-post"');
    expect(markup).toContain("Discard");
    expect(markup).not.toContain("data-pipeline-forest");
    expect(markup).not.toContain("data-forest-id");
  });

  it("puts the stealth checkpoint in Checkpoints and the post tip in Ready", () => {
    resetModelsUi();
    const board = selectPipelineBoard(pipelineFixture());
    const markup = renderToStaticMarkup(createElement(PipelineBoard, { board }));
    const checkpointsAt = markup.indexOf('data-pipeline-column="checkpoints"');
    const postAt = markup.indexOf('data-pipeline-column="postTraining"');
    const readyAt = markup.indexOf('data-pipeline-column="ready"');
    const stealth = markup.indexOf('data-card-id="cp-stealth"');
    const recipe = markup.indexOf('data-card-id="recipe-1"');
    const kept = markup.indexOf('data-card-id="cp-kept"');
    const post = markup.indexOf('data-card-id="cp-post"');
    expect(stealth).toBeGreaterThan(checkpointsAt);
    expect(stealth).toBeLessThan(postAt);
    expect(recipe).toBeGreaterThan(postAt);
    expect(recipe).toBeLessThan(readyAt);
    expect(kept).toBe(-1);
    expect(post).toBeGreaterThan(readyAt);
  });

  it("keeps empty columns visible when a lane has no cards", () => {
    resetModelsUi();
    const board = {
      ...selectPipelineBoard(pipelineFixture()),
      training: [],
      unattachedTraining: [],
      unattachedRecipes: [],
    };
    const markup = renderToStaticMarkup(createElement(PipelineBoard, { board }));
    expect(markup).toContain('data-pipeline-column="training"');
    expect(markup).toContain("Drop a base checkpoint here to continue training");
    expect(markup).toContain('data-pipeline-column="ready"');
    expect(markup).toContain('data-card-id="cp-post"');
  });

  it("keeps the training-pool footer on an empty Post-training column", () => {
    resetModelsUi();
    const board = {
      ...selectPipelineBoard(pipelineFixture()),
      postTraining: [],
      unattachedRecipes: [],
    };
    const markup = renderToStaticMarkup(createElement(PipelineBoard, { board }));
    expect(markup).toContain('data-pipeline-column="postTraining"');
    expect(markup).toContain("Drop a checkpoint here to start a recipe");
    expect(markup).toContain("Recipes draw from the training pool");
    expect(markup).toContain("data-compute-split");
  });
});

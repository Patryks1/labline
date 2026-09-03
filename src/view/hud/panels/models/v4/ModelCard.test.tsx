import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelCard } from "./ModelCard";
import { pipelineFixture } from "../viewModels/testFixtures";
import {
  selectCheckpointCard,
  selectPipelineBoard,
  selectRunCard,
} from "../viewModels/selectors";

describe("ModelCard", () => {
  const state = pipelineFixture();
  const board = selectPipelineBoard(state);
  const run = selectRunCard(state, "run-1")!;
  const checkpoint = selectCheckpointCard(state, "cp-post")!;
  const recipe = board.postTraining[0]!;

  it("renders the run variant with progress, ETA, burn, and decision tone", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelCard, { variant: "run", card: run, selected: true }),
    );
    expect(markup).toContain('data-model-card="run"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("Helix");
    expect(markup).toContain("42%");
    expect(markup).toContain("7.0d");
    expect(markup).toContain("$10.00K/d");
    expect(markup).toContain("Decision needed");
    expect(markup).toContain('data-loss-spark="compact"');
    expect(markup).toContain("P1");
    expect(markup).toContain('draggable="true"');
    expect(markup).toContain("models-v4-card-stats");
    expect(markup).not.toContain("sm:grid-cols-4");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain("min-h-11");
  });

  it("renders the checkpoint variant with version, tiers, and endpoints", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelCard, { variant: "checkpoint", card: checkpoint }),
    );
    expect(markup).toContain('data-model-card="checkpoint"');
    expect(markup).toContain("Helix · Instruct");
    expect(markup).toContain("0.3");
    expect(markup).toContain("Instant ×1");
    expect(markup).toContain("Low ×2");
    expect(markup).not.toContain("High ×8");
    expect(markup).not.toContain("Max ×20");
    expect(markup).toContain("Endpoints");
    expect(markup).toContain("Overall");
    expect(markup).toContain("models-v4-card-stats");
    expect(markup).toContain("models-v4-card-title");
    expect(markup).toContain('data-loss-spark="compact"');
    expect(markup).toContain("Discard");
    expect(markup).toContain('data-action="discard"');
    expect(markup).toContain('data-locked="true"');
    expect(markup).not.toContain("sm:grid-cols-4");
    expect(markup).not.toContain("truncate text-sm");
    expect(markup).not.toContain("line-clamp-2");
  });

  it("offers an unlocked discard on a stealth checkpoint", () => {
    const stealth = selectCheckpointCard(state, "cp-stealth")!;
    const markup = renderToStaticMarkup(
      createElement(ModelCard, { variant: "checkpoint", card: stealth }),
    );
    expect(markup).toContain("Discard");
    expect(markup).toContain('data-action="discard"');
    expect(markup).not.toContain('data-locked="true"');
  });

  it("renders the recipe variant with stage chips and burn", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelCard, { variant: "recipe", card: recipe }),
    );
    expect(markup).toContain('data-model-card="recipe"');
    expect(markup).toContain("Helix");
    expect(markup).toContain("Instruct");
    expect(markup).toContain("Preference");
    expect(markup).toContain("35%");
    expect(markup).toContain("$10.00K/d");
    expect(markup).toContain("PF");
    expect(markup).toContain("models-v4-card-stats");
    expect(markup).not.toContain("sm:grid-cols-4");
  });
});

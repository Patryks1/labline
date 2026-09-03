import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Inspector, TwoStepAction } from "./Inspector";
import { pipelineFixture } from "../viewModels/testFixtures";
import { trainingStateOf, withTrainingState } from "../../../../../sim/training/state";

describe("Inspector", () => {
  it("renders nothing when nothing is selected", () => {
    const markup = renderToStaticMarkup(
      createElement(Inspector, {
        state: pipelineFixture(),
        selection: null,
      }),
    );
    expect(markup).toBe("");
  });

  it("shows the action row for a kept checkpoint", () => {
    const markup = renderToStaticMarkup(
      createElement(Inspector, {
        state: pipelineFixture(),
        selection: { kind: "checkpoint", id: "cp-kept" },
      }),
    );
    expect(markup).toContain('data-inspector-actions="checkpoint"');
    expect(markup).toContain("Continue");
    expect(markup).toContain("Branch");
    expect(markup).toContain("Distill");
    expect(markup).toContain("Post-train");
    expect(markup).toContain("Eval");
    expect(markup).toContain("Release");
    expect(markup).toContain("Discard");
    expect(markup).not.toContain("Sell IP");
    expect(markup).toContain("Merge");
    expect(markup).toContain("Measured scores");
    expect(markup).toContain('data-eval-chart="radar"');
    expect(markup).toContain("Overall");
    expect(markup).toContain("48.0 ±4.0");
    expect(markup).toContain("Lineage");
    expect(markup).toContain("data-lineage-tree");
    expect(markup).toContain("data-action-lock");
    expect(markup).toContain('data-inspector-options="true"');
    expect(markup).toContain('data-inspector-post="true"');
    expect(markup).toContain("No post-training yet.");
    expect(markup).toContain("models-v4-inspector__close");
    expect(markup).toContain("models-v4-inspector__scroll");
    expect(markup).not.toContain("models-v4-action__lock");
  });

  it("offers open-source on a released checkpoint with a live endpoint", () => {
    const base = pipelineFixture();
    const training = trainingStateOf(base, base.playerLabId);
    const released = withTrainingState(base, base.playerLabId, {
      ...training,
      checkpoints: training.checkpoints.map((row) =>
        row.id === "cp-post" ? { ...row, status: "released" as const } : row,
      ),
    });
    const markup = renderToStaticMarkup(
      createElement(Inspector, {
        state: released,
        selection: { kind: "checkpoint", id: "cp-post" },
      }),
    );
    expect(markup).toContain("Open source");
    expect(markup).toContain("Hosted plan and API demand ease");
    expect(markup).not.toContain("Sell IP");
  });

  it("hides continue on a post-trained checkpoint and shows recipe history", () => {
    const markup = renderToStaticMarkup(
      createElement(Inspector, {
        state: pipelineFixture(),
        selection: { kind: "checkpoint", id: "cp-post" },
      }),
    );
    expect(markup).not.toContain('data-action="continue"');
    expect(markup).not.toContain('data-action="branch"');
    expect(markup).toContain("Instruct");
    expect(markup).toContain("Post-training");
    expect(markup).toContain("Helix · Instruct");
  });

  it("locks discard on a ready checkpoint that still has a live endpoint", () => {
    const markup = renderToStaticMarkup(
      createElement(Inspector, {
        state: pipelineFixture(),
        selection: { kind: "checkpoint", id: "cp-post" },
      }),
    );
    expect(markup).toContain('data-action="discard"');
    expect(markup).toContain('data-locked="true"');
    expect(markup).toMatch(/Sunset or retire/i);
  });

  it("uses a two-step confirm for discard", () => {
    const markup = renderToStaticMarkup(
      createElement(TwoStepAction, {
        label: "Discard",
        confirmLabel: "Confirm discard",
        confirming: true,
        onConfirm: () => undefined,
      }),
    );
    expect(markup).toContain('data-confirm-step="discard"');
    expect(markup).toContain("Confirm discard");
    expect(markup).toContain("Cancel");
  });
});

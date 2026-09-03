import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createGame } from "../../../../../../sim/createGame";
import { emptyTrainingState, withTrainingState } from "../../../../../../sim/training/state";
import { useGameStore } from "../../../../../../store/gameStore";
import { DesignModelDialog } from "./DesignModelDialog";
import { DistillDialog } from "./DistillDialog";
import { EvaluateDialog } from "./EvaluateDialog";
import { MergeDialog } from "./MergeDialog";
import { ModelsDialogs } from "./ModelsDialogs";
import { PostTrainDialog } from "./PostTrainDialog";
import { ReleaseDialog } from "./ReleaseDialog";
import { initialDesignState } from "./designState";
import { makeCheckpoint } from "./fixtures";

function seedStore() {
  const base = createGame(8_801);
  const training = {
    ...emptyTrainingState(),
    checkpoints: [
      makeCheckpoint({ id: "cp-a", name: "Atlas", status: "kept" }),
      makeCheckpoint({ id: "cp-b", name: "Bolt", status: "released" }),
    ],
    gyms: [
      {
        id: "gym-math",
        labId: base.playerLabId,
        kind: "math" as const,
        tier: 1,
        quality: 0.45,
        tasksPerDay: 40,
        researchers: 0,
        researchShare: 0,
        budgetPerDay: 0,
      },
    ],
    pools: {
      instructionMTok: 12,
      preferenceMTok: 4,
      verifiableTasks: 80,
      toolTrajectories: 9,
    },
  };
  const patched = withTrainingState(base, base.playerLabId, training);
  useGameStore.setState({ state: patched });
  const current = useGameStore.getState().state;
  if ((current.player.training?.checkpoints.length ?? 0) === 0) {
    useGameStore.setState({
      state: { ...current, player: { ...current.player, training } },
    });
  }
  return useGameStore.getState().state;
}

describe("v4 dialogs open and closed", () => {
  it("DesignModelDialog renders goal cards when open and nothing when closed", () => {
    seedStore();
    const open = renderToStaticMarkup(
      createElement(DesignModelDialog, { open: true, onClose: () => undefined }),
    );
    expect(open).toContain("Specialist");
    expect(open).toContain("Broad");
    expect(open).toContain("LLM");
    expect(open).toContain("Image generation");
    expect(open).toContain("Music generation");
    expect(open).toContain("Run name");
    expect(open).toContain("Randomize run name");
    expect(open).not.toContain('value="Untitled"');
    expect(open).not.toContain("Flagship");
    expect(open).not.toContain("Small specialist");
    expect(open).not.toContain("Dense 7B");
    expect(open).not.toContain("Dense 70B");
    expect(open).toContain('data-lock-reason="distill"');
    expect(open).toContain('data-lock-reason="omni"');
    expect(open).toContain('data-ai-type="language"');
    expect(open).toContain('data-model-workflow="true"');
    expect(open).toContain("Launch");
    expect(open).toContain("data-forecast-band");
    expect(open).toContain('data-selected="true"');
    expect(open).toContain("hud-card--selected");
    expect(open).toContain("border-mint/70");

    const closed = renderToStaticMarkup(
      createElement(DesignModelDialog, { open: false, onClose: () => undefined }),
    );
    expect(closed).toBe("");
  });

  it("continue-from-checkpoint offers more data and domain fixes instead of types", () => {
    const state = seedStore();
    expect(
      initialDesignState(state, "continue", { parentCheckpointId: "cp-a" }).design.name,
    ).toBe("Atlas v2");
    const open = renderToStaticMarkup(
      createElement(DesignModelDialog, {
        open: true,
        onClose: () => undefined,
        goal: "continue",
        parentCheckpointId: "cp-a",
      }),
    );
    expect(open).toContain("Run name");
    expect(open).toContain("Randomize run name");
    expect(open).toContain("Keep mix");
    expect(open).not.toContain(" continued");
    expect(open).toContain("Continue training");
    expect(open).toContain('data-continue-intent="code"');
    expect(open).toContain("data-domain-radar");
    expect(open).not.toContain("Specialist");
    expect(open).not.toContain("Flagship");
    expect(open).not.toContain("Choose a different type");
  });

  it("PostTrainDialog renders stage toggles when open", () => {
    seedStore();
    const open = renderToStaticMarkup(
      createElement(PostTrainDialog, {
        open: true,
        onClose: () => undefined,
        checkpointId: "cp-a",
      }),
    );
    expect(open).toContain("data-stage-toggles");
    expect(open).toContain("Instruct");
    expect(open).toContain("Preference");
    expect(open).toContain("writes a new checkpoint");
    expect(open).toContain("Start");
    expect(renderToStaticMarkup(
      createElement(PostTrainDialog, {
        open: false,
        onClose: () => undefined,
        checkpointId: "cp-a",
      }),
    )).toBe("");
  });

  it("DistillDialog renders student architecture controls when open", () => {
    seedStore();
    const open = renderToStaticMarkup(
      createElement(DistillDialog, {
        open: true,
        onClose: () => undefined,
        teacherCheckpointId: "cp-b",
      }),
    );
    expect(open).toContain("data-teacher-summary");
    expect(open).toContain("Student parameters");
    expect(open).toContain("Dense");
    expect(open).toContain("data-precision-chips");
    expect(open).toContain("data-tok-max");
    expect(renderToStaticMarkup(
      createElement(DistillDialog, {
        open: false,
        onClose: () => undefined,
        teacherCheckpointId: "cp-b",
      }),
    )).toBe("");
  });

  it("EvaluateDialog renders tier cards when open", () => {
    seedStore();
    const open = renderToStaticMarkup(
      createElement(EvaluateDialog, {
        open: true,
        onClose: () => undefined,
        checkpointId: "cp-a",
      }),
    );
    expect(open).toContain('data-eval-tier="quick"');
    expect(open).toContain('data-eval-tier="suite"');
    expect(open).toContain('data-eval-tier="audit"');
    expect(open).toContain("data-eval-metrics");
    expect(open).toContain("data-eval-metrics-all");
    expect(open).toContain("data-eval-metrics-core");
    expect(open).toContain("data-tier-budget");
    expect(open).toContain("data-eval-thinking-all");
    expect(open).toContain("Instant ×1");
    expect(open).toContain("Ultra ×100");
    expect(open).toContain("All trained");
    expect(open).toContain("Needs Thinking-Tier RL and a reasoning post-train");
    expect(open).toContain("Leak risk");
    expect(open).toContain("No complete eval yet");
    expect(renderToStaticMarkup(
      createElement(EvaluateDialog, {
        open: false,
        onClose: () => undefined,
        checkpointId: "cp-a",
      }),
    )).toBe("");
  });

  it("ReleaseDialog renders name, precision, and HBM when open", () => {
    seedStore();
    const open = renderToStaticMarkup(
      createElement(ReleaseDialog, {
        open: true,
        onClose: () => undefined,
        checkpointId: "cp-a",
      }),
    );
    expect(open).toContain("Endpoint name");
    expect(open).toContain("data-serve-precision");
    expect(open).toContain("data-release-plans");
    expect(open).toContain("API listing");
    expect(open).toContain("data-hbm-estimate");
    expect(open).toContain("Open weights off");
    expect(open).not.toContain("Prices can be changed later in Plans");
    expect(renderToStaticMarkup(
      createElement(ReleaseDialog, {
        open: false,
        onClose: () => undefined,
        checkpointId: "cp-a",
      }),
    )).toBe("");
  });

  it("MergeDialog renders the second-checkpoint picker when open", () => {
    seedStore();
    const open = renderToStaticMarkup(
      createElement(MergeDialog, {
        open: true,
        onClose: () => undefined,
        aId: "cp-a",
      }),
    );
    expect(open).toContain("data-merge-picker");
    expect(open).toContain("Second checkpoint");
    expect(open).toContain("data-merge-reason");
    expect(renderToStaticMarkup(
      createElement(MergeDialog, {
        open: false,
        onClose: () => undefined,
        aId: "cp-a",
      }),
    )).toBe("");
  });
});

describe("ModelsDialogs host", () => {
  it("switches on dialog.kind", () => {
    seedStore();
    const design = renderToStaticMarkup(
      createElement(ModelsDialogs, {
        dialog: { kind: "design" },
        onClose: () => undefined,
      }),
    );
    expect(design).toContain("Specialist");

    const post = renderToStaticMarkup(
      createElement(ModelsDialogs, {
        dialog: { kind: "postTrain", checkpointId: "cp-a" },
        onClose: () => undefined,
      }),
    );
    expect(post).toContain("data-stage-toggles");

    const distill = renderToStaticMarkup(
      createElement(ModelsDialogs, {
        dialog: { kind: "distill", teacherCheckpointId: "cp-b" },
        onClose: () => undefined,
      }),
    );
    expect(distill).toContain("data-teacher-summary");

    const evaluate = renderToStaticMarkup(
      createElement(ModelsDialogs, {
        dialog: { kind: "evaluate", checkpointId: "cp-a" },
        onClose: () => undefined,
      }),
    );
    expect(evaluate).toContain('data-eval-tier="quick"');

    const release = renderToStaticMarkup(
      createElement(ModelsDialogs, {
        dialog: { kind: "release", checkpointId: "cp-a" },
        onClose: () => undefined,
      }),
    );
    expect(release).toContain("data-serve-precision");

    const merge = renderToStaticMarkup(
      createElement(ModelsDialogs, {
        dialog: { kind: "merge", aId: "cp-a", bId: "cp-b" },
        onClose: () => undefined,
      }),
    );
    expect(merge).toContain("data-merge-picker");

    expect(
      renderToStaticMarkup(
        createElement(ModelsDialogs, { dialog: null, onClose: () => undefined }),
      ),
    ).toBe("");
  });

  it("opens copy formula as a pretrain review", () => {
    seedStore();
    const markup = renderToStaticMarkup(
      createElement(ModelsDialogs, {
        dialog: { kind: "design", copyFromEndpointId: "ep-atlas" },
        onClose: () => undefined,
      }),
    );
    expect(markup).toContain("Copy formula");
    expect(markup).toContain("Architecture and data mix copied from the live base");
  });
});

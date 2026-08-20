import { describe, expect, it } from "vitest";
import { buildScaledModel } from "../balance/modelBuild";
import { createGame } from "../createGame";
import {
  scheduleReleasedModelEvaluation,
  tickCheckpointEvaluations,
} from "./checkpointEvaluations";

describe("released model evaluation", () => {
  it("queues a paid study of a fleet model and attaches the report when due", () => {
    const base = createGame(8_801);
    const model = buildScaledModel({
      id: "release-eval",
      name: "Spark",
      paramsB: 1,
      family: "dense",
      day: base.day,
      dataCoverage: 8,
      dataQuality: 70,
      shipped: true,
      release: "released",
    });
    const state = {
      ...base,
      player: {
        ...base.player,
        cash: 5_000_000,
        models: [model],
      },
    };

    const scheduled = scheduleReleasedModelEvaluation(state, model.id, {
      suiteIds: ["language"],
      budgetTier: "standard",
      mode: "nda_external",
    });
    const job = scheduled.player.privateEvaluationJobs?.find(
      (entry) =>
        entry.kind === "released_model_evaluation" &&
        entry.subjectId === model.id,
    );
    expect(job).toBeTruthy();
    expect(scheduled.player.cash).toBeLessThan(state.player.cash);
    expect(
      scheduled.player.models.find((candidate) => candidate.id === model.id)
        ?.checkpointEvaluations ?? [],
    ).toHaveLength(0);

    const due = tickCheckpointEvaluations({
      ...scheduled,
      day: job!.readyDay,
    });
    const reports =
      due.player.models.find((candidate) => candidate.id === model.id)
        ?.checkpointEvaluations ?? [];
    expect(reports).toHaveLength(1);
    expect(reports[0]?.modelId).toBe(model.id);
    expect(reports[0]?.suites[0]?.suiteId).toBe("language");
    expect(
      due.player.privateEvaluationJobs?.some(
        (entry) => entry.id === job!.id,
      ),
    ).toBe(false);
  });

  it("refuses a suite the model cannot produce", () => {
    const base = createGame(8_802);
    const model = buildScaledModel({
      id: "text-only",
      name: "Text only",
      paramsB: 1,
      family: "dense",
      day: base.day,
      dataCoverage: 4,
      dataQuality: 60,
      shipped: true,
      release: "released",
    });
    const refused = scheduleReleasedModelEvaluation(
      {
        ...base,
        player: { ...base.player, cash: 5_000_000, models: [model] },
      },
      model.id,
      {
        suiteIds: ["video_generation"],
        budgetTier: "lean",
        mode: "internal",
      },
    );
    expect(refused.player.privateEvaluationJobs ?? []).toHaveLength(0);
    expect(refused.alerts[0]?.message).toMatch(/not supported/i);
  });
});

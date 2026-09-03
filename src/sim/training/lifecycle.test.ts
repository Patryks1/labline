import { afterEach, describe, expect, it, vi } from "vitest";
import { createGame } from "../createGame";
import * as computeMod from "../systems/compute";
import type { DatasetAsset, SimState } from "../types";
import { reservedTokensFor } from "./dataBridge";
import { forecastDesign } from "./forecast";
import * as outcome from "./outcome";
import {
  cancelRun,
  hasPendingDecision,
  pauseRun,
  resolveIncident,
  resumeRun,
  startRun,
  tickRuns,
} from "./run";
import { snapshotCheckpoint } from "./checkpoints";
import { defaultArchitecture, trainingStateOf } from "./state";
import type { ModelDesign, TrainingRun } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

function ampleAsset(): DatasetAsset {
  return {
    id: "v4-ample-chat",
    name: "Ample Chat",
    volumeMTok: 200_000,
    domainWeights: { chat: 1 },
    verticalTags: ["general"],
    quality: 80,
    diversity: 0.7,
    freshness: 1,
    rights: "owned",
    source: "web",
    exclusiveUntilDay: null,
    contaminationRisk: 0,
    acquiredDay: 1,
  };
}

function prepare(seed = 101): SimState {
  vi.spyOn(computeMod, "computeSnapshot").mockReturnValue({
    pools: { training: 8_000, inference: 1, research: 1 },
  } as computeMod.ComputeSnapshot);
  const game = createGame(seed);
  const data = game.player.data;
  return {
    ...game,
    player: {
      ...game.player,
      data: { ...data, assets: [...(data.assets ?? []), ampleAsset()] },
      cash: Math.max(game.player.cash, 80_000_000),
      training: game.player.training,
    },
  };
}

function pretrain(state: SimState, over: Partial<ModelDesign> = {}): ModelDesign {
  return {
    id: "design-7b",
    name: "Atlas-7B",
    goal: "flagship",
    arch: defaultArchitecture(),
    data: { domainMTok: { chat: 140_000 }, holdoutShare: 0.05 },
    mode: { kind: "pretrain" },
    compute: { pfPerDay: 200, priority: 3, source: "local" },
    createdDay: state.day,
    ...over,
  };
}

function playerRun(state: SimState): TrainingRun | undefined {
  return trainingStateOf(state, state.playerLabId).runs[0];
}

describe("training run lifecycle", () => {
  it("starts a 7B pretrain, completes near forecast days, and only snapshots on finish", () => {
    vi.spyOn(outcome, "rollIncident").mockReturnValue(null);
    let state = prepare(404);
    const design = pretrain(state);
    const forecast = forecastDesign(state, state.playerLabId, design);
    expect(forecast.blockers).toEqual([]);
    const started = startRun(state, state.playerLabId, design);
    expect(started.result.ok).toBe(true);
    if (!started.result.ok) return;
    state = started.state;
    expect(playerRun(state)?.status).toBe("running");
    const target = forecast.compute.days;
    let ticks = 0;
    while (ticks < 40) {
      const run = playerRun(state);
      if (!run || run.status === "completed" || run.status === "failed") break;
      state = { ...state, day: state.day + 1 };
      state = tickRuns(state);
      ticks += 1;
    }
    const done = playerRun(state)!;
    expect(done.status).toBe("completed");
    expect(ticks).toBeGreaterThan(target * 0.8 - 1);
    expect(ticks).toBeLessThan(target * 1.2 + 1);
    const training = trainingStateOf(state, state.playerLabId);
    const midRun = training.checkpoints.filter(
      (row) => row.runId === done.id && row.progressAtSnapshot < 1,
    );
    expect(midRun).toEqual([]);
    const final = training.checkpoints.find((row) => row.id === done.finalCheckpointId);
    expect(final?.status).toBe("stealth");
    expect(final?.progressAtSnapshot).toBe(1);
    expect(final?.name).toBe("Atlas-7B · Base");
    const realized = final!.truth.domains.language;
    expect(realized).toBeGreaterThanOrEqual(forecast.capability.p10 - 1);
    expect(realized).toBeLessThanOrEqual(forecast.capability.p90 + 1);
    expect(reservedTokensFor(state, state.playerLabId)["chat"] ?? 0).toBe(0);
    expect(training.biggestTrainedParamsB).toBe(7);
  });

  it("rejects blockers for no data and no PF", () => {
    const state = prepare(3);
    const noData = startRun(state, state.playerLabId, pretrain(state, { data: { domainMTok: {}, holdoutShare: 0 } }));
    expect(noData.result.ok).toBe(false);
    const noPf = startRun(
      state,
      state.playerLabId,
      pretrain(state, { compute: { pfPerDay: 0, priority: 1, source: "local" } }),
    );
    expect(noPf.result.ok).toBe(false);
  });

  it("pauses progress, cancel releases the reservation, incidents wait for a decision", () => {
    vi.spyOn(outcome, "rollIncident").mockReturnValue(null);
    let state = prepare(9);
    const started = startRun(state, state.playerLabId, pretrain(state));
    expect(started.result.ok).toBe(true);
    if (!started.result.ok) return;
    state = started.state;
    state = { ...state, day: state.day + 1 };
    state = tickRuns(state);
    const mid = playerRun(state)!.progress;
    state = pauseRun(state, playerRun(state)!.id);
    const pausedDay = state.day;
    state = { ...state, day: pausedDay + 1 };
    state = tickRuns(state);
    expect(playerRun(state)?.progress).toBeCloseTo(mid, 8);
    state = resumeRun(state, playerRun(state)!.id);

    const cancelled = cancelRun(state, playerRun(state)!.id);
    expect(trainingStateOf(cancelled, cancelled.playerLabId).runs[0]?.status).toBe("cancelled");
    expect(reservedTokensFor(cancelled, cancelled.playerLabId)["chat"] ?? 0).toBe(0);
  });

  it("forces an incident then resolves it, and catastrophe keeps checkpoints", () => {
    let incidentState: SimState | null = null;
    let incidentRun: TrainingRun | null = null;
    for (let seed = 1; seed < 80 && !incidentState; seed++) {
      vi.restoreAllMocks();
      vi.spyOn(computeMod, "computeSnapshot").mockReturnValue({
        pools: { training: 8_000, inference: 1, research: 1 },
      } as computeMod.ComputeSnapshot);
      let state = prepare(seed);
      const started = startRun(state, state.playerLabId, pretrain(state));
      if (!started.result.ok) continue;
      state = started.state;
      for (let i = 0; i < 12; i++) {
        state = { ...state, day: state.day + 1 };
        state = tickRuns(state);
        const run = playerRun(state);
        if (run?.status === "awaiting_decision") {
          incidentState = state;
          incidentRun = run;
          break;
        }
        if (run?.status === "completed" || run?.status === "failed") break;
      }
    }
    expect(incidentState).toBeTruthy();
    expect(hasPendingDecision(incidentState!)).toBe(true);
    const pending = incidentRun!.incidents.find((row) => row.resolvedChoiceId == null)!;
    let resolved = resolveIncident(
      incidentState!,
      incidentRun!.id,
      pending.id,
      pending.choices[0]!.id,
    );
    expect(playerRun(resolved)?.status).toBe("running");
    expect(hasPendingDecision(resolved)).toBe(false);

    vi.spyOn(outcome, "isCatastrophic").mockReturnValue(true);
    vi.spyOn(outcome, "rollIncident").mockReturnValue(null);
    let state = prepare(21);
    const started = startRun(state, state.playerLabId, pretrain(state));
    expect(started.result.ok).toBe(true);
    if (!started.result.ok) return;
    state = started.state;
    state = { ...state, day: state.day + 1 };
    state = tickRuns(state);
    const snap = snapshotCheckpoint(state, started.result.id);
    expect(snap.checkpointId).toBeTruthy();
    state = snap.state;
    for (let i = 0; i < 20; i++) {
      state = { ...state, day: state.day + 1 };
      state = tickRuns(state);
      if (playerRun(state)?.status === "failed") break;
    }
    const failed = playerRun(state)!;
    expect(failed.status).toBe("failed");
    expect(failed.checkpointIds.length).toBeGreaterThan(0);
    expect(trainingStateOf(state, state.playerLabId).checkpoints.length).toBeGreaterThan(0);
  });
});

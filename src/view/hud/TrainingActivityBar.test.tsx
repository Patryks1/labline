import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGame } from "../../sim/createGame";
import * as computeMod from "../../sim/systems/compute";
import { baselineModifiers } from "../../sim/training/modifiers";
import { defaultDesign, emptyTrainingState, withTrainingState } from "../../sim/training/state";
import type { Forecast, TrainingRun } from "../../sim/training/types";
import { useGameStore } from "../../store/gameStore";
import {
  desktopTrainingActivityRect,
  mobileTrainingActivityRect,
  shouldSuppressTrainingSummary,
  TrainingActivityBar,
} from "./TrainingActivityBar";

afterEach(() => {
  vi.restoreAllMocks();
});

function stubForecast(p50 = 54): Forecast {
  return {
    compute: {
      trainPfDays: 8,
      holdoutPfDays: 0,
      totalPfDays: 8,
      archCost: 1,
      modalityCost: 1,
      throughput: 1,
      days: 10,
      paceFloorDays: 8,
      trainHbmGB: 24,
      cashEstimate: 1,
    },
    loss: {
      nEff: 1,
      dEff: 1,
      paramTerm: 1,
      dataTerm: 1,
      loss: 2,
      precisionPenalty: 0,
      gap: 0.4,
    },
    effectiveData: {
      rawMTok: 40,
      uniqueMTok: 40,
      effectiveMTok: 36,
      qualityWeight: 1,
      diversity: 1,
      epochs: 1,
      epochFactor: 1,
      syntheticShare: 0,
      syntheticDiscount: 1,
      domainMix: {},
      perDomain: {},
    },
    capability: { p10: p50 - 6, p50, p90: p50 + 6, ceiling: 82, sigma: 0.06 },
    domains: {
      language: p50,
      reasoning: p50,
      code: p50,
      math: p50,
      science: p50,
      vision: 0,
      video: 0,
      audio: 0,
      tools: p50,
    },
    blockers: [],
    warnings: [],
  };
}

function makeRun(overrides: Partial<TrainingRun> & Pick<TrainingRun, "id">): TrainingRun {
  const design = { ...defaultDesign(1), id: overrides.id, name: "Helios" };
  return {
    labId: "player",
    design,
    forecast: stubForecast(),
    modifiersFrozen: baselineModifiers(),
    seed: 1,
    status: "running",
    startDay: 1,
    progress: 0.42,
    pfDaysDone: 3,
    pfDaysTotal: 8,
    cashSpent: 1,
    etaDays: 5,
    incidents: [],
    sigmaMult: 1,
    costMult: 1,
    gapDelta: 0,
    checkpointIds: [],
    autoCheckpointEvery: 0.25,
    lossCurve: [],
    ...overrides,
  };
}

describe("TrainingActivityBar", () => {
  it("keeps a live, navigable activity surface mounted when the queue is empty", () => {
    useGameStore.setState({ state: withTrainingState(createGame(5101), "player", emptyTrainingState()) });
    const markup = renderToStaticMarkup(createElement(TrainingActivityBar));

    expect(markup).toContain('aria-label="Training activity"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('data-job-count="0"');
    expect(markup).toContain(">Idle</span>");
    expect(markup).toContain('data-open-models="true"');
    expect(markup).toContain('data-mobile-summary="training"');
    expect(markup).not.toContain("training-activity-bar__surface hud-surface pointer-events-auto");
  });

  it("renders a V4 run with P50 and opens Models as a pointer", () => {
    const state = withTrainingState(createGame(5102), "player", {
      ...emptyTrainingState(),
      runs: [makeRun({ id: "run-live", progress: 0.42, etaDays: 5 })],
    });
    useGameStore.setState({ state });
    const markup = renderToStaticMarkup(createElement(TrainingActivityBar, { state }));

    expect(markup).toContain("Helios");
    expect(markup).toContain("7B");
    expect(markup).toContain("P50 54");
    expect(markup).toContain('data-run-id="run-live"');
    expect(markup).toContain('data-pending-decision="false"');
    expect(markup).not.toContain("Decision needed");
  });

  it("shows Stalled when a post-train recipe has no training PF", () => {
    vi.spyOn(computeMod, "computeSnapshot").mockReturnValue({
      pools: { training: 0, inference: 1, research: 1 },
    } as computeMod.ComputeSnapshot);
    const game = createGame(5104);
    const state = withTrainingState(game, game.playerLabId,
      {
        ...emptyTrainingState(),
        recipes: [
          {
            id: "recipe-stall",
            labId: game.playerLabId,
            checkpointId: "cp-1",
            stages: ["instruct"],
            safetyFocus: 0,
            gymIds: [],
            budgetPfDays: 3,
            dataUse: {
              instructionMTok: 1,
              preferenceMTok: 0,
              verifiableTasks: 0,
              toolTrajectories: 0,
            },
            startDay: 1,
            progress: 0.2,
            pfDaysDone: 0.5,
            status: "running",
            forecast: {
              pfDays: 3,
              days: 4,
              cash: 10_000,
              deltas: {},
              unlocksTiers: false,
              adequacy: {},
              warnings: [],
            },
            seed: 1,
          },
        ],
      },
    );
    useGameStore.setState({ state });
    const markup = renderToStaticMarkup(createElement(TrainingActivityBar, { state }));
    expect(markup).toContain("Stalled");
    expect(markup).not.toContain("Infinity");
  });

  it("shows Decision needed for an awaiting_decision run and +N more", () => {
    const state = withTrainingState(createGame(5103), "player", {
      ...emptyTrainingState(),
      runs: [
        makeRun({
          id: "run-decide",
          status: "awaiting_decision",
          progress: 0.5,
          design: { ...defaultDesign(1), id: "run-decide", name: "Call site" },
        }),
        makeRun({ id: "run-other", progress: 0.8 }),
      ],
    });
    useGameStore.setState({ state });
    const markup = renderToStaticMarkup(createElement(TrainingActivityBar, { state }));

    expect(markup).toContain("Decision needed");
    expect(markup).toContain('data-decision-needed="true"');
    expect(markup).toContain("Call site");
    expect(markup).toContain("+1 more");
  });

  it("keeps the mobile strip inside the viewport above the bottom nav", () => {
    const rect = mobileTrainingActivityRect({
      viewportWidth: 390,
      viewportHeight: 844,
      mobileNavHeight: 64,
      stripHeight: 63,
    });

    expect(rect).toEqual({ left: 0, right: 390, top: 717, bottom: 780, width: 390, height: 63 });
  });

  it("spans the desktop operational shell between rail and intel", () => {
    const rect = desktopTrainingActivityRect({
      viewportWidth: 1440,
      railWidth: 200,
      intelWidth: 300,
    });

    expect(rect.left).toBe(200);
    expect(rect.right).toBe(1140);
    expect(rect.width).toBe(940);
  });

  it("keeps spanning rail to intel when a workbench is open", () => {
    const rect = desktopTrainingActivityRect({
      viewportWidth: 1920,
      railWidth: 200,
      intelWidth: 48,
    });

    expect(rect.left).toBe(200);
    expect(rect.right).toBe(1872);
    expect(rect.width).toBe(1672);
  });

  it("suppresses only the duplicate summary while the Models workspace is open", () => {
    expect(shouldSuppressTrainingSummary(true, "models")).toBe(true);
    expect(shouldSuppressTrainingSummary(false, "models")).toBe(false);
    expect(shouldSuppressTrainingSummary(true, "plans")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { TRAINING_V4 } from "./constants";
import { baselineModifiers } from "./modifiers";
import {
  drawEpsilon,
  incidentCatalog,
  isCatastrophic,
  realizeGap,
  rollIncident,
  sigmaFor,
} from "./outcome";
import { defaultArchitecture, defaultDesign } from "./state";
import type { Forecast, TrainingRun } from "./types";

const mods = baselineModifiers();

function band(): Forecast["capability"] {
  return { p10: 40, p50: 48, p90: 56, ceiling: 82, sigma: TRAINING_V4.rng.sigmaBase };
}

function fakeForecast(): Forecast {
  return {
    compute: {
      trainPfDays: 10,
      holdoutPfDays: 0,
      totalPfDays: 10,
      archCost: 1,
      modalityCost: 1,
      throughput: 1,
      days: 12,
      paceFloorDays: 8,
      trainHbmGB: 84,
      cashEstimate: 1200,
    },
    loss: {
      nEff: 7e9,
      dEff: 140e9,
      paramTerm: 0.18,
      dataTerm: 0.31,
      loss: 2.18,
      precisionPenalty: 0,
      gap: 0.49,
    },
    effectiveData: {
      rawMTok: 140_000,
      uniqueMTok: 140_000,
      effectiveMTok: 140_000,
      qualityWeight: 1,
      diversity: 1,
      epochs: 1,
      epochFactor: 1,
      syntheticShare: 0,
      syntheticDiscount: 1,
      domainMix: { chat: 1 },
      perDomain: {},
    },
    capability: band(),
    domains: {
      language: 48,
      reasoning: 48,
      code: 48,
      math: 48,
      science: 48,
      vision: 0,
      audio: 0,
      video: 0,
      tools: 24,
    },
    blockers: [],
    warnings: [],
  };
}

function fakeRun(over: Partial<TrainingRun> = {}): TrainingRun {
  return {
    id: "run-1",
    labId: "player",
    design: defaultDesign(1),
    forecast: fakeForecast(),
    modifiersFrozen: mods,
    seed: 42,
    status: "running",
    startDay: 1,
    progress: 0.4,
    pfDaysDone: 4,
    pfDaysTotal: 10,
    cashSpent: 0,
    etaDays: 12,
    incidents: [],
    sigmaMult: 1,
    costMult: 1,
    gapDelta: 0,
    checkpointIds: [],
    autoCheckpointEvery: 0.25,
    lossCurve: [],
    ...over,
  };
}

describe("sigmaFor / drawEpsilon / realizeGap", () => {
  it("composes the contracted sigma multipliers", () => {
    const baseline = sigmaFor({
      modifiers: mods,
      precision: "bf16_mixed",
      firstMoe: false,
      scaleJumpLog10: 0,
      engineerFactor: 1,
    });
    expect(baseline).toBeCloseTo(TRAINING_V4.rng.sigmaBase, 8);

    const stressed = sigmaFor({
      modifiers: { ...mods, stability: 1.2 },
      precision: "nvfp4",
      firstMoe: true,
      scaleJumpLog10: 1,
      engineerFactor: 1.1,
    });
    expect(stressed).toBeCloseTo(
      TRAINING_V4.rng.sigmaBase *
        1.2 *
        TRAINING_V4.precision.sigmaMult.nvfp4 *
        TRAINING_V4.rng.moeUntested *
        (1 + TRAINING_V4.rng.scaleJump * 1) *
        1.1,
      8,
    );
  });

  it("is deterministic, clamped, and Box–Muller centered", () => {
    const sigma = 0.06;
    expect(drawEpsilon(99, sigma)).toBe(drawEpsilon(99, sigma));
    expect(drawEpsilon(99, sigma)).not.toBe(drawEpsilon(100, sigma));
    for (let seed = 0; seed < 200; seed += 1) {
      expect(Math.abs(drawEpsilon(seed, sigma))).toBeLessThanOrEqual(
        TRAINING_V4.rng.clampSigmas * sigma + 1e-12,
      );
    }
  });

  it("floors realized gap at 0.005", () => {
    expect(realizeGap(0.01, -0.9, 0)).toBe(0.005);
    expect(realizeGap(0.4, 0.1, 0.02)).toBeCloseTo(0.4 * 1.1 + 0.02, 8);
  });
});

describe("isCatastrophic", () => {
  it("is deterministic and capped", () => {
    const run = fakeRun({ seed: 7 });
    expect(isCatastrophic(7, run)).toBe(isCatastrophic(7, run));
    let hits = 0;
    for (let seed = 0; seed < 2000; seed += 1) {
      if (isCatastrophic(seed, run)) hits += 1;
    }
    expect(hits / 2000).toBeLessThanOrEqual(TRAINING_V4.rng.catastrophicMax + 0.02);
  });
});

describe("rollIncident", () => {
  it("never exceeds maxPerRun and is deterministic for the same seed+day", () => {
    let run = fakeRun({ seed: 11, progress: 0.4, etaDays: 10 });
    const first = rollIncident(run, 20);
    const again = rollIncident(run, 20);
    expect(first).toEqual(again);

    const collected = [];
    for (let day = 1; day <= 400 && collected.length < 5; day += 1) {
      const incident = rollIncident(run, day);
      if (!incident) continue;
      collected.push(incident);
      run = { ...run, incidents: [...run.incidents, incident] };
    }
    expect(collected.length).toBeLessThanOrEqual(TRAINING_V4.incidents.maxPerRun);
    expect(run.incidents.length).toBeLessThanOrEqual(TRAINING_V4.incidents.maxPerRun);
  });

  it("skips while an incident is unresolved or progress is outside the window", () => {
    const open = fakeRun({
      incidents: [
        {
          id: "open",
          kind: "loss_spike",
          day: 3,
          title: "x",
          body: "y",
          choices: incidentCatalog()[0]!.choices,
          autoResolveDay: 8,
        },
      ],
    });
    expect(rollIncident(open, 10)).toBeNull();
    expect(rollIncident(fakeRun({ progress: 0.05 }), 10)).toBeNull();
    expect(rollIncident(fakeRun({ progress: 0.95 }), 10)).toBeNull();
  });

  it("gives every catalog choice non-empty effects and breakthrough a negative gapDelta option", () => {
    for (const row of incidentCatalog()) {
      expect(row.choices).toHaveLength(3);
      for (const choice of row.choices) {
        expect(Object.keys(choice.effects).length).toBeGreaterThan(0);
      }
    }
    const breakthrough = incidentCatalog().find((row) => row.kind === "breakthrough")!;
    expect(breakthrough.choices.some((choice) => (choice.effects.gapDelta ?? 0) <= -0.02)).toBe(
      true,
    );
  });
});

describe("defaultArchitecture sanity", () => {
  it("stays on the dense language prior", () => {
    expect(defaultArchitecture().backbone).toBe("dense");
  });
});

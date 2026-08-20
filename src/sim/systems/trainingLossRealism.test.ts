import { describe, expect, it } from "vitest";

import { trainingLoss } from "./training";

type LossJob = Parameters<typeof trainingLoss>[0];

const baseJob: LossJob = {
  id: "loss-realism",
  outcomeSeed: 7021,
  targetParamsB: 12,
  dataQualityUsed: 70,
  effectiveDataRatio: 6,
  repeatedDataEpochs: 1,
};

function series(job: LossJob, progress: (day: number) => number, days = 72) {
  let previous: number | undefined;
  return Array.from({ length: days }, (_, index) => {
    const day = index + 1;
    previous = trainingLoss(job, "base", progress(day), day, previous);
    return previous;
  });
}

function standardDeviation(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      values.length,
  );
}

describe("training loss realism", () => {
  it("is deterministic, improves over the long run, and has two-sided excursions", () => {
    const a = series(baseJob, (day) => day / 72);
    const b = series(baseJob, (day) => day / 72);
    expect(a).toEqual(b);

    const deltas = a.slice(1).map((loss, index) => loss - a[index]!);
    expect(deltas.some((delta) => delta > 0)).toBe(true);
    expect(deltas.some((delta) => delta < 0)).toBe(true);
    const earlyMean = a.slice(0, 12).reduce((sum, loss) => sum + loss, 0) / 12;
    const lateMean = a.slice(-12).reduce((sum, loss) => sum + loss, 0) / 12;
    expect(lateMean).toBeLessThan(earlyMean);
  });

  it("makes broad recipes volatile early while narrow recipes remain unstable", () => {
    const plan = (weights: Record<string, number>) => ({
      totalUnits: 1_000,
      weights,
    });
    const broad = series(
      {
        ...baseJob,
        dataPlan: plan({ code: 1, math: 1, science: 1, chat: 1 }),
      },
      () => 0.08,
      180,
    );
    const middle = series(
      { ...baseJob, dataPlan: plan({ code: 0.83, chat: 0.17 }) },
      () => 0.08,
      180,
    );
    const narrow = series(
      { ...baseJob, dataPlan: plan({ code: 1 }) },
      () => 0.08,
      180,
    );

    expect(standardDeviation(broad)).toBeGreaterThan(
      standardDeviation(middle),
    );
    expect(standardDeviation(narrow)).toBeGreaterThan(
      standardDeviation(middle),
    );
  });

  it("penalizes weak, repeated data and lets post-training recover from its spike", () => {
    const strong = {
      ...baseJob,
      dataQualityUsed: 92,
      dataPlan: { totalUnits: 1_000, weights: { code: 1, math: 1, science: 1 } },
    };
    const weak = {
      ...baseJob,
      dataQualityUsed: 38,
      effectiveDataRatio: 0.45,
      repeatedDataEpochs: 7,
      dataPlan: { totalUnits: 1_000, weights: { code: 1 } },
    };
    const strongLate = trainingLoss(strong, "base", 1, 90);
    const weakLate = trainingLoss(weak, "base", 1, 90);
    expect(weakLate).toBeGreaterThan(strongLate);

    const postSpike = trainingLoss(strong, "sft", 0, 100);
    const postRecovered = trainingLoss(strong, "sft", 1, 120);
    expect(postSpike).toBeGreaterThan(postRecovered);
    expect(postRecovered).toBeGreaterThan(2.5);
    expect(postRecovered).toBeLessThan(5);
  });
});

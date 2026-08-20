import { describe, expect, it } from "vitest";
import { buildScaledModel } from "../balance/modelBuild";
import { createGame } from "../createGame";
import { collectQuarterlyLabSnapshots } from "../systems/progression";
import {
  createRivals,
  RIVAL_STARTING_CASH_RESERVE,
  rivalAllocationPolicy,
  rivalDenseScaleTarget,
  rivalResearchTrainingModifiers,
  rivalTrainingWeights,
} from "../systems/rivals";
import { tickDay } from "../tick";
import { runPlayBot } from "./bot";

const env =
  (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env ?? {};

describe("frontier strategy balance", () => {
  it("gives every rival a $100M liquid reserve after buying its starting fleet", () => {
    const rivals = createRivals(400, 5, ["west"], 300_000_000);
    expect(rivals).toHaveLength(5);
    for (const rival of rivals) {
      expect(rival.cash).toBeGreaterThan(RIVAL_STARTING_CASH_RESERVE);
    }
  });

  it("gives every rival the same raw PF yield per accelerator", () => {
    const rivals = createRivals(401, 5, ["west"], 1_000_000_000);
    const yields = rivals.map((rival) => rival.flopsPf / rival.chips);
    expect(yields).toHaveLength(5);
    for (const perChip of yields) expect(perChip).toBeCloseTo(yields[0]!, 12);
  });

  it("expresses rival specialization through normalized training evidence", () => {
    const efficiency = rivalTrainingWeights("efficiency");
    const frontier = rivalTrainingWeights("hyperscale");
    const multimodal = rivalTrainingWeights("multimodal");
    const sum = (weights: Partial<Record<string, number>>) =>
      Object.values(weights).reduce<number>(
        (total, value) => total + (value ?? 0),
        0,
      );

    expect(sum(efficiency)).toBeCloseTo(1, 12);
    expect(sum(frontier)).toBeCloseTo(1, 12);
    expect(sum(multimodal)).toBeCloseTo(1, 12);
    expect(efficiency.code).toBeGreaterThan(frontier.code!);
    expect(frontier.science).toBeGreaterThan(efficiency.science!);
    expect(multimodal.image).toBeGreaterThan(frontier.image!);
  });

  it("makes the frontier controller spend its finite pool on training", () => {
    const frontier = rivalAllocationPolicy("hyperscale", {
      training: false,
      hasModel: true,
      overload: false,
    });
    const efficiency = rivalAllocationPolicy("efficiency", {
      training: false,
      hasModel: true,
      overload: false,
    });

    expect(frontier.training).toBeGreaterThan(efficiency.training);
    expect(
      frontier.training + frontier.inference + frontier.research,
    ).toBeCloseTo(1, 12);
    expect(rivalDenseScaleTarget("hyperscale", 0.5, 0.5)).toBeGreaterThan(
      rivalDenseScaleTarget("safety", 0.5, 0.5),
    );
  });

  it("applies integrated research to rival training on the player formula", () => {
    const baseline = rivalResearchTrainingModifiers(["dense_basics"], "dense");
    const integrated = rivalResearchTrainingModifiers(
      ["dense_basics", "dense_opt"],
      "dense",
    );

    expect(integrated.trainEfficiency).toBeGreaterThan(
      baseline.trainEfficiency,
    );
    expect(integrated.researchMult).toBeGreaterThan(baseline.researchMult);
  });

  it("uses canonical domain capabilities for frontier domain leadership", () => {
    const state = createGame(402);
    const model = buildScaledModel({
      id: "domain-vector-model",
      name: "Domain Vector",
      paramsB: 7,
      family: "dense",
      day: 10,
      dataCoverage: 1,
      dataQuality: 70,
      shipped: true,
      release: "released",
    });
    model.benchmarks.coding = 99;
    model.benchmarks.science = 98;
    model.capabilities = {
      domains: {
        language: 30,
        reasoning: 31,
        code: 41,
        math: 42,
        science: 43,
        vision: 10,
        video: 8,
        audio: 9,
        tools: 15,
      },
      factuality: 35,
      steerability: 34,
      robustness: 33,
      safety: 50,
      reliability: 50,
    };
    const next = {
      ...state,
      player: { ...state.player, models: [model] },
    };
    const player = collectQuarterlyLabSnapshots(next).find(
      (row) => row.labId === state.playerLabId,
    );

    expect(player).toMatchObject({ code: 41, science: 43, otherDomain: 42 });
  });

  it("finalizes rival runs with an attributable manifest recipe and domain vector", () => {
    let state = createGame(403);
    for (let day = 0; day < 30; day++) state = tickDay(state);
    const released = state.rivals.filter((rival) => rival.models.length > 0);

    expect(released.length).toBeGreaterThanOrEqual(3);
    for (const rival of released) {
      const model = rival.models[0]!;
      const manifest = rival.data?.manifests?.find(
        (candidate) => candidate.id === model.dataManifestId,
      );
      expect(model.capabilities).toBeDefined();
      expect(manifest).toBeDefined();
      const requested = rivalTrainingWeights(rival.archetype);
      const attributedWeights = Object.entries(manifest!.domainWeights).filter(
        ([, weight]) => (weight ?? 0) >= 0.04,
      );
      expect(
        attributedWeights.reduce(
          (total, [, weight]) => total + (weight ?? 0),
          0,
        ),
      ).toBeGreaterThan(0.7);
      for (const [domain] of attributedWeights) {
        expect(
          requested[domain as keyof typeof requested] ?? 0,
        ).toBeGreaterThan(0);
      }
      expect(manifest!.uniqueMTok + manifest!.repeatedMTok).toBeGreaterThan(0);
      expect(model.trainComputeSpent).toBeGreaterThan(0);
    }
  });

  it.runIf(env.LABLINE_FRONTIER_DIAGNOSTIC === "1")(
    "prints comparable end-state frontier metrics",
    () => {
      const report = runPlayBot({
        seed: Number(env.LABLINE_FRONTIER_SEED ?? 1),
        maxDays: 4_017,
        difficulty: "normal",
      });
      const rows = collectQuarterlyLabSnapshots(report.final).map((row) => {
        const rival = report.final.rivals.find(
          (candidate) => candidate.id === row.labId,
        );
        const models =
          row.labId === report.final.playerLabId
            ? report.final.player.models
            : (rival?.models ?? []);
        const flagship = models.toSorted(
          (a, b) => b.capability - a.capability || a.id.localeCompare(b.id),
        )[0];
        const data = rival?.data ?? report.final.player.data;
        const audits = report.final.evaluations.filter(
          (evaluation) =>
            evaluation.published &&
            evaluation.kind === "blind_audit" &&
            (evaluation.labId ?? report.final.playerLabId) === row.labId,
        );
        return {
          labId: row.labId,
          strategy: rival?.archetype ?? "balanced_cloud",
          capability: row.capability,
          independent: row.independentCapability,
          code: row.code,
          science: row.science,
          other: row.otherDomain,
          reliability: row.reliability,
          paramsB: flagship?.paramsB,
          activeParamsB: flagship?.activeParamsB,
          family: flagship?.family,
          coverage: flagship?.dataCoverage,
          dataQuality: flagship?.dataQualityUsed,
          releaseDay: flagship?.releaseDay,
          models: models.length,
          research:
            rival?.researchUnlocked.length ??
            report.final.player.researchUnlocked.length,
          cash: rival?.cash ?? report.final.player.cash,
          share: row.servedDemandShare,
          grossMargin: row.grossMargin,
          price:
            rival?.pricing.apiPricePerMTok ??
            report.final.player.pricing.apiPricePerMTok,
          trainingJob: rival?.trainingJob
            ? {
                paramsB: rival.trainingJob.paramsB,
                progress: rival.trainingJob.progressPfDays,
                target: rival.trainingJob.targetPfDays,
                cashBurn: rival.trainingJob.cashBurnPerDay,
              }
            : null,
          processed: Object.values(data.stocks).reduce(
            (sum, stock) => sum + stock.processed,
            0,
          ),
          domainStocks: Object.fromEntries(
            Object.entries(data.stocks).map(([domain, stock]) => [
              domain,
              Math.round(stock.processed),
            ]),
          ),
          latestAudit: audits.toSorted((a, b) => b.publishDay - a.publishDay)[0]
            ?.scores,
        };
      });
      console.log(
        JSON.stringify({
          frontier: report.final.progression.milestones.find(
            (milestone) => milestone.id === "frontier_leader",
          ),
          rows,
        }),
      );
      expect(report.final.progression.decadeReport).not.toBeNull();
    },
    120_000,
  );
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyBenchmarks } from "../../../sim/balance/benchmarks";
import { createGame } from "../../../sim/createGame";
import { investorPitchPreview } from "../../../sim/systems/capital";
import { updateLab } from "../../../sim/systems/labEngine";
import type { Model } from "../../../sim/types";
import { money } from "../format";
import { InvestorPitchAmountCard } from "./OrgPanel";

function pitchableModel(): Model {
  return {
    id: "rendered-pitch-model",
    name: "Cobalt Frontier",
    family: "dense",
    paramsB: 70,
    capability: 92,
    modalities: ["text"],
    quality: {
      reasoning: 92,
      coding: 90,
      chat: 91,
      image: 0,
      video: 0,
      safety: 88,
      reliability: 90,
    },
    benchmarks: emptyBenchmarks(),
    postTrain: "rlhf",
    trainComputeSpent: 120,
    releaseDay: 1,
    shipped: false,
    release: "internal",
    tokPerSecMult: 1,
    inferCostMult: 1,
    apiPricePerMTok: null,
    apiPriceInPerMTok: null,
    apiPriceOutPerMTok: null,
    suggestedApiPrice: 2,
    suggestedApiPriceIn: 0.7,
    suggestedApiPriceOut: 3,
    costApiPriceIn: 0.2,
    costApiPriceOut: 0.8,
    distilled: false,
    trainMode: "pretrain",
    repeatedDataEpochs: 1,
  };
}

describe("OrgPanel investor pitch amount", () => {
  it("renders accessible bounds and carries the selected quote into preview and action", () => {
    const initial = createGame(64_230);
    const model = pitchableModel();
    const state = updateLab(initial, initial.playerLabId, (lab) => ({
      ...lab,
      models: [model],
    }));
    const suggested = investorPitchPreview(state, model.id);
    const selectedAmount = Math.min(
      suggested.maximumCashRaised,
      suggested.minimumCashRaised + suggested.cashRaisedStep,
    );
    const preview = investorPitchPreview(
      state,
      model.id,
      state.playerLabId,
      selectedAmount,
    );

    const markup = renderToStaticMarkup(
      createElement(InvestorPitchAmountCard, {
        preview,
        onAmountChange: () => undefined,
        onPitch: () => undefined,
      }),
    );
    const numericInput = markup.match(
      /<input[^>]+aria-label="Model pitch raise amount in millions"[^>]*>/,
    )?.[0];

    expect(numericInput).toBeDefined();
    expect(numericInput).toContain(
      `min="${preview.minimumCashRaised / 1_000_000}"`,
    );
    expect(numericInput).toContain(
      `max="${preview.maximumCashRaised / 1_000_000}"`,
    );
    expect(numericInput).toContain(
      `step="${preview.cashRaisedStep / 1_000_000}"`,
    );
    expect(numericInput).toContain(
      `value="${preview.cashRaised / 1_000_000}"`,
    );
    expect(numericInput).toContain("min-h-11");
    expect(numericInput).not.toContain("sm:min-h-0");
    expect(numericInput).not.toContain("sm:h-8");
    expect(markup).toContain(
      `data-pitch-raise-amount="${preview.cashRaised}"`,
    );
    expect(markup).toContain(
      `Pitch ${preview.modelName} for ${money(preview.cashRaised)}`,
    );
    expect(markup.split(money(preview.cashRaised)).length - 1).toBeGreaterThanOrEqual(
      3,
    );
  });
});

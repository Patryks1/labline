import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import type { SimState, TrainingCampaignEvent, TrainingJob } from "../types";
import {
  keepInternal,
  resolveTrainingCampaignEvent,
  withTrainingJobs,
} from "../systems/training";
import { capabilityCeiling } from "./modelScaling";
import {
  applyTrainingCampaignChoice,
  boundedVerifiedRecursiveCapabilityBonus,
  campaignDecisionOptions,
  canSurfaceRecursiveResearchEvent,
  CLOSED_LOOP_MIN_EFFECTIVE_DATA_RATIO,
  createTrainingCampaignEvent,
  crossedTrainingCampaignMilestone,
  emptyTrainingCampaignModifiers,
} from "./trainingCampaign";

function job(overrides: Partial<TrainingJob> = {}): TrainingJob {
  return {
    id: "campaign-job",
    name: "Campaign",
    family: "dense",
    backbone: "dense",
    productPreset: "language",
    io: { inputs: { text: 50 }, outputs: { text: 50 }, tools: 20 },
    targetParamsB: 8,
    targetPfDays: 100,
    recommendedPfDays: 100,
    progressPfDays: 0,
    postTrain: "none",
    postTrainProgress: 0,
    postTrainTarget: 0,
    mode: "pretrain",
    dataMix: "web",
    dataPlan: {
      totalUnits: 48_000,
      totalMTok: 48_000,
      trainShare: 0.82,
      weights: { chat: 0.45, code: 0.3, math: 0.15, science: 0.1 },
    },
    dataConsumed: { chat: 21_600, code: 14_400, math: 7_200, science: 4_800 },
    dataCoverage: 6,
    dataQualityUsed: 72,
    syntheticUnits: 0,
    trainShare: 0.82,
    trainMTok: 39_360,
    verifyMTok: 8_640,
    cashBurnPerDay: 0,
    cashSunk: 0,
    outcomeSeed: 7712,
    outcomeRisk: "medium",
    campaignMilestonesReached: [],
    campaignModifiers: emptyTrainingCampaignModifiers(),
    ...overrides,
  };
}

function recursiveEvent(
  cashCost = 1_000_000,
  verifiedGain = 0.6,
  id = "recursive-event",
): TrainingCampaignEvent {
  return {
    id,
    kind: "recursive_research",
    title: "Autonomous research proposals",
    description: "Verify a candidate closed-loop gain.",
    signal: "hidden tests and fresh observations ready",
    day: 20,
    milestone: 0.58,
    decisionDeadlineDay: 25,
    severity: "opportunity",
    choices: [
      {
        id: "independent-verification",
        label: "Fund independent verification",
        description: "Use separate agents and hidden tests.",
        recommended: true,
        effects: {
          cashCost,
          minResearchers: 32,
          verifiedRecursiveCapabilityBonus: verifiedGain,
          reliabilityDelta: 2,
        },
      },
      {
        id: "reject-unverified",
        label: "Reject the proposals",
        description: "Bank no gain.",
        effects: { reliabilityDelta: 1 },
      },
    ],
  };
}

function stateWithJob(
  candidate: TrainingJob,
  cash: number,
  researchers: number,
): SimState {
  const state = createGame(8177);
  return withTrainingJobs(
    {
      ...state,
      day: 21,
      player: {
        ...state.player,
        cash,
        staff: {
          researcher: researchers,
          data_processor: state.player.staff?.data_processor ?? 0,
          engineer: state.player.staff?.engineer ?? 0,
          ops: state.player.staff?.ops ?? 0,
        },
      },
    },
    [candidate],
  );
}

describe("training campaign events", () => {
  it("crosses each milestone once", () => {
    const first = crossedTrainingCampaignMilestone(job(), 0.4, 0.55);
    expect(first).toEqual({ milestone: 0.5, index: 0 });
    expect(
      crossedTrainingCampaignMilestone(
        job({ campaignMilestonesReached: [0.5] }),
        0.4,
        0.55,
      ),
    ).toBeNull();
  });

  it("creates deterministic architecture-aware choices", () => {
    const dense = createTrainingCampaignEvent(job(), 0.12, 0, 20);
    const repeat = createTrainingCampaignEvent(job(), 0.12, 0, 20);
    expect(repeat).toEqual(dense);
    expect(dense.choices.length).toBeGreaterThanOrEqual(6);
    expect(dense.choices.some((choice) => choice.recommended)).toBe(true);

    const moeKinds = Array.from(
      { length: 4 },
      (_, index) =>
        createTrainingCampaignEvent(
          job({
            id: `moe-${index}`,
            family: "moe",
            backbone: "moe",
            activeParamsB: 8,
          }),
          0.32,
          index,
          30,
        ).kind,
    );
    expect(moeKinds.some((kind) => kind === "routing_imbalance")).toBe(true);
  });

  it("turns frozen corpus evidence into explainable data-risk events", () => {
    const cleanEvidence = {
      effectiveQuality: 0.9,
      effectiveDiversity: 0.92,
      effectiveFreshness: 0.9,
      contaminationRisk: 0.02,
      syntheticShare: 0.05,
      syntheticGenerationDepth: 1,
      humanAnchorShare: 0.96,
      rightsRisk: 0.04,
      effectiveTrainingValue: 0.82,
    };
    const riskyEvidence = {
      ...cleanEvidence,
      effectiveDiversity: 0.22,
      effectiveFreshness: 0.18,
      contaminationRisk: 0.68,
      syntheticShare: 0.72,
      syntheticGenerationDepth: 5,
      humanAnchorShare: 0.15,
      effectiveTrainingValue: 0.18,
    };
    const dataAnomalies = (evidence: typeof cleanEvidence) =>
      Array.from({ length: 160 }, (_, index) =>
        createTrainingCampaignEvent(
          job({
            id: `evidence-${index}`,
            outcomeSeed: index * 103 + 7,
            dataEvidence: evidence,
            repeatedDataEpochs: evidence === riskyEvidence ? 9 : 1,
          }),
          0.32,
          1,
          30,
        ),
      ).filter((event) => event.kind === "data_anomaly").length;

    expect(dataAnomalies(riskyEvidence)).toBeGreaterThan(
      dataAnomalies(cleanEvidence),
    );
  });

  it("uses benchmark spend as decision evidence without rerolling the latent event", () => {
    const baseline = createTrainingCampaignEvent(job(), 0.32, 1, 30);
    const measured = createTrainingCampaignEvent(
      job({
        benchmarkSnapshots: [
          {
            day: 28,
            progress: 0.25,
            capability: 50,
            safety: 50,
            accuracy: 0.95,
          },
        ],
      }),
      0.32,
      1,
      30,
    );
    expect(measured.kind).toBe(baseline.kind);
    expect(measured.title).toBe(baseline.title);
    expect(measured.evidenceAccuracy).toBe(0.95);
    const paidId = baseline.choices.find(
      (choice) => (choice.effects.cashCost ?? 0) > 0,
    )!.id;
    const baselineResolved = applyTrainingCampaignChoice(
      job({ progressPfDays: 32, pendingCampaignEvent: baseline }),
      paidId,
      31,
    )!;
    const measuredResolved = applyTrainingCampaignChoice(
      job({ progressPfDays: 32, pendingCampaignEvent: measured }),
      paidId,
      31,
    )!;
    expect(measuredResolved.campaignModifiers!.reliabilityDelta).toBeGreaterThan(
      baselineResolved.campaignModifiers!.reliabilityDelta,
    );
    expect(measuredResolved.campaignModifiers!.stumbleRisk).toBeLessThan(
      baselineResolved.campaignModifiers!.stumbleRisk,
    );
  });

  it("applies costs separately while accumulating bounded campaign effects", () => {
    const pendingCampaignEvent = createTrainingCampaignEvent(
      job(),
      0.12,
      0,
      20,
    );
    const source = job({ progressPfDays: 20, pendingCampaignEvent });
    const choice = pendingCampaignEvent.choices.find(
      (candidate) => candidate.effects.extraComputeFraction,
    )!;
    const resolved = applyTrainingCampaignChoice(source, choice.id, 21)!;
    expect(resolved.pendingCampaignEvent).toBeUndefined();
    expect(resolved.campaignEventHistory).toHaveLength(1);
    expect(resolved.targetPfDays).toBeGreaterThanOrEqual(source.targetPfDays);
    expect(resolved.campaignModifiers).not.toEqual(
      emptyTrainingCampaignModifiers(),
    );
    expect(source.pendingCampaignEvent).toBe(pendingCampaignEvent);
  });

  it("authors a custom intervention on the same effect ledger", () => {
    const pendingCampaignEvent = createTrainingCampaignEvent(
      job(),
      0.12,
      0,
      20,
    );
    const source = job({ progressPfDays: 20, pendingCampaignEvent });
    const resolved = applyTrainingCampaignChoice(
      source,
      "custom",
      21,
      false,
      {
        cashCost: 120_000,
        extraComputeFraction: 0.04,
        progressRollbackFraction: 0.02,
        reliabilityDelta: 1.5,
      },
    )!;
    expect(resolved.pendingCampaignEvent).toBeUndefined();
    expect(resolved.recommendedPfDays).toBeCloseTo(104, 8);
    expect(resolved.progressPfDays).toBeCloseTo(19.6, 8);
    expect(resolved.campaignModifiers?.reliabilityDelta).toBeGreaterThan(1.5);
    expect(resolved.campaignEventHistory?.at(-1)?.selectedChoiceId).toBe(
      "custom",
    );
  });

  it("surfaces four live decision options from a larger tactic catalog", () => {
    const spike = createTrainingCampaignEvent(
      job({ id: "spike-job", outcomeRisk: "high" }),
      0.12,
      0,
      20,
    );
    expect(spike.choices.length).toBeGreaterThan(4);
    expect(campaignDecisionOptions(spike)).toHaveLength(4);
    expect(campaignDecisionOptions(spike)[0]?.recommended).toBe(true);
  });

  it("offers more than three tactics for loss spikes and data anomalies", () => {
    const spike = createTrainingCampaignEvent(
      job({ id: "spike-job", outcomeRisk: "high" }),
      0.12,
      0,
      20,
    );
    const anomalies = Array.from({ length: 24 }, (_, index) =>
      createTrainingCampaignEvent(
        job({
          id: `anom-${index}`,
          outcomeSeed: index * 17 + 3,
          synthLqShare: 0.8,
          repeatedDataEpochs: 9,
        }),
        0.32,
        1,
        30,
      ),
    );
    const anomaly = anomalies.find((event) => event.kind === "data_anomaly");
    expect(spike.choices.length).toBeGreaterThan(3);
    expect(anomaly?.choices.length ?? 0).toBeGreaterThan(3);
  });
});

describe("architecture frontier campaign integration", () => {
  const saturatedRecipe = {
    paramsB: 10_000,
    dataCoverage: 200,
    dataQuality: 1.4,
    researchMult: 1.14,
    reasoningEnabled: true,
    overtrainCapBonus: 99,
  };

  it("applies the architecture wall before teacher transfer", () => {
    const pretrain = capabilityCeiling({
      ...saturatedRecipe,
      family: "dense",
    });
    const distilled = capabilityCeiling({
      ...saturatedRecipe,
      family: "dense",
      teacherCapability: 100,
    });

    expect(pretrain.capability).toBe(82);
    expect(pretrain.limitingFactor).toBe("architecture blueprint");
    expect(distilled.capability).toBe(88);
    expect(distilled.capability).toBeGreaterThan(pretrain.blueprintCap);
    expect(distilled.limitingFactor).toBe("teacher");
  });

  it("surfaces closed-loop research only for an omni campaign that integrated the unlock", () => {
    const denseWithMethod = job({
      family: "dense",
      integratedMethods: ["mm_closed_loop_research"],
    });
    const omniWithoutMethod = job({
      family: "omni",
      productPreset: "omni",
      integratedMethods: [],
    });
    const eligible = job({
      family: "omni",
      productPreset: "omni",
      integratedMethods: ["mm_closed_loop_research"],
      effectiveDataRatio: CLOSED_LOOP_MIN_EFFECTIVE_DATA_RATIO,
    });

    expect(canSurfaceRecursiveResearchEvent(denseWithMethod)).toBe(false);
    expect(canSurfaceRecursiveResearchEvent(omniWithoutMethod)).toBe(false);
    expect(canSurfaceRecursiveResearchEvent(eligible)).toBe(true);
    expect(
      canSurfaceRecursiveResearchEvent({
        ...eligible,
        effectiveDataRatio: CLOSED_LOOP_MIN_EFFECTIVE_DATA_RATIO - 0.01,
      }),
    ).toBe(false);

    const ineligibleKinds = Array.from(
      { length: 128 },
      (_, index) =>
        createTrainingCampaignEvent(
          { ...omniWithoutMethod, id: `locked-${index}` },
          0.58,
          index % 4,
          30,
        ).kind,
    );
    const eligibleEvents = Array.from({ length: 128 }, (_, index) =>
      createTrainingCampaignEvent(
        { ...eligible, id: `eligible-${index}` },
        0.58,
        index % 4,
        30,
      ),
    );
    expect(ineligibleKinds).not.toContain("recursive_research");
    expect(
      eligibleEvents.some((event) => event.kind === "recursive_research"),
    ).toBe(true);
    expect(createTrainingCampaignEvent(eligible, 0.5, 0, 30).kind).toBe(
      "recursive_research",
    );
    expect(crossedTrainingCampaignMilestone(eligible, 0, 1)).toEqual({
      milestone: 0.5,
      index: 0,
    });
    for (const event of eligibleEvents.filter(
      (candidate) => candidate.kind === "recursive_research",
    )) {
      expect(
        event.choices.find((choice) => choice.id === "rapid-recursion")?.effects
          .verifiedRecursiveCapabilityBonus,
      ).toBeUndefined();
    }
  });

  it("ignores forged verified gains for non-omni and non-integrated campaigns", () => {
    const pendingCampaignEvent = recursiveEvent(0, 1.2);
    const dense = applyTrainingCampaignChoice(
      job({
        family: "dense",
        integratedMethods: ["mm_closed_loop_research"],
        pendingCampaignEvent,
      }),
      "independent-verification",
      21,
    )!;
    const lockedOmni = applyTrainingCampaignChoice(
      job({
        family: "omni",
        integratedMethods: [],
        pendingCampaignEvent,
      }),
      "independent-verification",
      21,
    )!;
    const eligibleOmni = applyTrainingCampaignChoice(
      job({
        family: "omni",
        integratedMethods: ["mm_closed_loop_research"],
        effectiveDataRatio: CLOSED_LOOP_MIN_EFFECTIVE_DATA_RATIO,
        pendingCampaignEvent,
      }),
      "independent-verification",
      21,
    )!;
    const forgedRapidEvent: TrainingCampaignEvent = {
      ...pendingCampaignEvent,
      id: "forged-rapid-event",
      choices: [
        {
          ...pendingCampaignEvent.choices[0]!,
          id: "rapid-recursion",
        },
      ],
    };
    const forgedRapid = applyTrainingCampaignChoice(
      job({
        family: "omni",
        integratedMethods: ["mm_closed_loop_research"],
        effectiveDataRatio: CLOSED_LOOP_MIN_EFFECTIVE_DATA_RATIO,
        pendingCampaignEvent: forgedRapidEvent,
      }),
      "rapid-recursion",
      21,
    )!;

    expect(dense.campaignModifiers?.verifiedRecursiveCapabilityBonus).toBe(0);
    expect(lockedOmni.campaignModifiers?.verifiedRecursiveCapabilityBonus).toBe(
      0,
    );
    expect(
      eligibleOmni.campaignModifiers?.verifiedRecursiveCapabilityBonus,
    ).toBeCloseTo(1.2, 12);
    expect(
      forgedRapid.campaignModifiers?.verifiedRecursiveCapabilityBonus,
    ).toBe(0);
    expect(boundedVerifiedRecursiveCapabilityBonus("dense", 99)).toBe(0);
    expect(boundedVerifiedRecursiveCapabilityBonus("omni", 99)).toBe(3);
  });

  it("enforces researcher and cash gates before charging or banking a gain", () => {
    const event = recursiveEvent(1_000_000, 0.6);
    const candidate = job({
      family: "omni",
      integratedMethods: ["mm_closed_loop_research"],
      effectiveDataRatio: CLOSED_LOOP_MIN_EFFECTIVE_DATA_RATIO,
      pendingCampaignEvent: event,
    });

    const understaffed = stateWithJob(candidate, 5_000_000, 31);
    const blockedByStaff = resolveTrainingCampaignEvent(
      understaffed,
      candidate.id,
      "independent-verification",
    );
    expect(blockedByStaff.player.cash).toBe(understaffed.player.cash);
    expect(blockedByStaff.player.trainingJob?.pendingCampaignEvent).toBe(event);
    expect(
      blockedByStaff.player.trainingJob?.campaignModifiers
        ?.verifiedRecursiveCapabilityBonus,
    ).toBe(0);

    const underfunded = stateWithJob(candidate, 999_999, 32);
    const blockedByCash = resolveTrainingCampaignEvent(
      underfunded,
      candidate.id,
      "independent-verification",
    );
    expect(blockedByCash.player.cash).toBe(underfunded.player.cash);
    expect(blockedByCash.player.trainingJob?.pendingCampaignEvent).toBe(event);

    const funded = stateWithJob(candidate, 5_000_000, 32);
    const resolved = resolveTrainingCampaignEvent(
      funded,
      candidate.id,
      "independent-verification",
    );
    expect(resolved.player.cash).toBe(4_000_000);
    expect(resolved.player.trainingJob?.pendingCampaignEvent).toBeUndefined();
    expect(
      resolved.player.trainingJob?.campaignModifiers
        ?.verifiedRecursiveCapabilityBonus,
    ).toBeCloseTo(0.6, 12);

    const duplicate = resolveTrainingCampaignEvent(
      resolved,
      candidate.id,
      "independent-verification",
    );
    expect(duplicate.player.cash).toBe(resolved.player.cash);
    expect(
      duplicate.player.trainingJob?.campaignModifiers
        ?.verifiedRecursiveCapabilityBonus,
    ).toBeCloseTo(0.6, 12);
  });

  it("persists each verified gain once through finalization and continuation", () => {
    const sourceEvent = recursiveEvent(0, 0.6, "source-recursive-event");
    const sourceJob = job({
      family: "omni",
      productPreset: "omni",
      io: {
        inputs: { text: 50, image: 50, audio: 50, video: 50 },
        outputs: { text: 50, image: 50, audio: 50, video: 50 },
        tools: 50,
      },
      targetParamsB: 0.1,
      targetPfDays: 20,
      recommendedPfDays: 20,
      progressPfDays: 20,
      integratedMethods: ["mm_closed_loop_research"],
      effectiveDataRatio: CLOSED_LOOP_MIN_EFFECTIVE_DATA_RATIO,
      pendingCampaignEvent: sourceEvent,
    });
    let state = resolveTrainingCampaignEvent(
      stateWithJob(sourceJob, 1_000_000_000, 32),
      sourceJob.id,
      "independent-verification",
    );
    state = keepInternal(state, sourceJob.id);
    const source = state.player.models.at(-1)!;
    expect(source.verifiedRecursiveCapabilityBonus).toBeCloseTo(0.6, 12);

    state = {
      ...state,
      player: {
        ...state.player,
        cash: 1_000_000_000,
        researchUnlocked: [
          ...new Set([
            ...state.player.researchUnlocked,
            "data_mix",
            "mm_omni",
            "mm_closed_loop_research",
          ]),
        ],
      },
    };
    const continuation: TrainingJob = {
      ...sourceJob,
      id: "continuation-job",
      name: source.name,
      mode: "continue",
      continueFromId: source.id,
      continueLineageId: source.lineageId ?? source.id,
      campaignEventHistory: [],
      pendingCampaignEvent: undefined,
      campaignModifiers: {
        ...emptyTrainingCampaignModifiers(),
        verifiedRecursiveCapabilityBonus:
          source.verifiedRecursiveCapabilityBonus ?? 0,
      },
      integratedMethods: [
        ...new Set([
          ...(source.integratedMethods ?? []),
          ...state.player.researchUnlocked,
        ]),
      ].sort(),
    };
    state = withTrainingJobs(state, [continuation]);
    expect(continuation.family).toBe("omni");
    expect(continuation.integratedMethods).toContain("mm_closed_loop_research");
    expect(
      continuation.campaignModifiers?.verifiedRecursiveCapabilityBonus,
    ).toBeCloseTo(0.6, 12);

    const continuationEvent = recursiveEvent(
      0,
      0.4,
      "continuation-recursive-event",
    );
    state = withTrainingJobs(
      {
        ...state,
        player: {
          ...state.player,
          staff: {
            researcher: 32,
            data_processor: state.player.staff?.data_processor ?? 0,
            engineer: state.player.staff?.engineer ?? 0,
            ops: state.player.staff?.ops ?? 0,
          },
        },
      },
      [{ ...continuation, pendingCampaignEvent: continuationEvent }],
    );
    state = resolveTrainingCampaignEvent(
      state,
      continuation.id,
      "independent-verification",
    );
    const once = state.player.trainingJob!;
    expect(
      once.campaignModifiers?.verifiedRecursiveCapabilityBonus,
    ).toBeCloseTo(1, 12);
    state = resolveTrainingCampaignEvent(
      state,
      continuation.id,
      "independent-verification",
    );
    expect(
      state.player.trainingJob?.campaignModifiers
        ?.verifiedRecursiveCapabilityBonus,
    ).toBeCloseTo(1, 12);

    const ready = {
      ...state.player.trainingJob!,
      progressPfDays: Math.max(
        state.player.trainingJob!.targetPfDays,
        state.player.trainingJob!.recommendedPfDays ?? 0,
      ),
      daysElapsed: state.player.trainingJob!.minCalendarDays ?? 0,
    };
    state = keepInternal(withTrainingJobs(state, [ready]), ready.id);
    const version = state.player.models.at(-1)!;
    expect(version.parentModelId).toBe(source.id);
    expect(version.verifiedRecursiveCapabilityBonus).toBeCloseTo(1, 12);
    expect(
      state.player.models.find((model) => model.id === source.id)
        ?.verifiedRecursiveCapabilityBonus,
    ).toBeCloseTo(0.6, 12);
  });
});

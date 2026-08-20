import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import { roundTripState } from "../save";
import type { SimState, TrainingJob } from "../types";
import {
  captureTrainingCheckpoint,
  benchmarkTrainingJob,
  cancelTraining,
  createManualTrainingCheckpoint,
  currentManualTrainingCheckpointId,
  discardTrainingCheckpoint,
  playerTrainingResourcePlan,
  promoteTrainingCheckpoint,
  deleteModel,
  forkTrainingCheckpoint,
  keepInternal,
  releaseFromJob,
  releaseModel,
  rollbackTrainingJobToCheckpoint,
  startTraining,
  tickTraining,
} from "./training";
import {
  MAX_CHECKPOINT_EVALUATIONS,
  scheduleCheckpointEvaluation,
  tickCheckpointEvaluations,
} from "./checkpointEvaluations";

function campaignAtTenPercent(seed: number): SimState {
  const base = createGame(seed);
  let state = startTraining(
    {
      ...base,
      player: {
        ...base.player,
        cash: 5_000_000_000,
        allocation: { training: 0.9, inference: 0.05, research: 0.05 },
      },
    },
    {
      name: "Stealth Atlas",
      family: "dense",
      paramsB: 1,
      computePriority: 100,
    },
  );
  const job = state.player.trainingJob!;
  const dailyPf = playerTrainingResourcePlan(state).jobs[job.id]!.effectivePf;
  const targetPfDays = dailyPf * 20;
  const prepared: TrainingJob = {
    ...job,
    targetPfDays,
    recommendedPfDays: targetPfDays,
    progressPfDays: targetPfDays * 0.49,
    minCalendarDays: 30,
    daysElapsed: 0,
    campaignMilestonesReached: [],
    pendingCampaignEvent: undefined,
  };
  state = {
    ...state,
    player: {
      ...state.player,
      trainingJob: prepared,
      trainingJobs: [prepared],
    },
  };
  return state;
}

function captureAfterFirstMilestone(seed: number): SimState {
  const crossed = tickTraining(campaignAtTenPercent(seed));
  return captureTrainingCheckpoint(crossed, crossed.player.trainingJob!.id);
}

describe("stealth training checkpoint lifecycle", () => {
  it("does not write a weight file when a milestone incident opens", () => {
    const before = campaignAtTenPercent(7101);
    const sourceSeed = before.player.trainingJob!.outcomeSeed;
    const next = tickTraining(before);
    const job = next.player.trainingJob!;

    expect(next.player.trainingCheckpoints ?? []).toEqual([]);
    expect(job.pendingCampaignEvent).toBeDefined();
    expect(job.campaignMilestonesReached).toEqual([0.5]);
    expect(job.outcomeSeed).toBe(sourceSeed);
    expect(next.player.trainingJobs).toHaveLength(1);
  });

  it("captures a milestone file only when the player saves it", () => {
    const next = captureAfterFirstMilestone(7101);
    const job = next.player.trainingJob!;
    const checkpoint = next.player.trainingCheckpoints?.[0];

    expect(checkpoint).toMatchObject({
      sourceJobId: job.id,
      milestone: 0.5,
      ordinal: 1,
      status: "stealth",
      stage: "base",
      telemetry: { progress: 0.5, stage: "base" },
    });
    expect(checkpoint!.model).toMatchObject({
      release: "internal",
      shipped: false,
      checkpointCandidateId: checkpoint!.id,
      sourceTrainingJobId: job.id,
      checkpointProgress: 0.5,
    });
    expect(checkpoint!.lineageId).toBe(job.lineageId);
    expect(next.player.models).not.toContainEqual(
      expect.objectContaining({ id: checkpoint!.model.id }),
    );
  });

  it("supports manual stealth capture for an earned milestone and deduplicates it", () => {
    const crossed = tickTraining(campaignAtTenPercent(7102));
    const legacyLike = {
      ...crossed,
      player: { ...crossed.player, trainingCheckpoints: [] },
    };
    const captured = captureTrainingCheckpoint(
      legacyLike,
      legacyLike.player.trainingJob!.id,
    );
    const repeated = captureTrainingCheckpoint(
      captured,
      captured.player.trainingJob!.id,
    );

    expect(captured.player.trainingCheckpoints).toHaveLength(1);
    expect(repeated.player.trainingCheckpoints).toHaveLength(1);
    expect(repeated.alerts[0]!.message).toContain("already in stealth review");
  });

  it("backfills every missing legacy milestone from latest to earliest", () => {
    const base = campaignAtTenPercent(7114);
    const source = base.player.trainingJob!;
    const legacyJob: TrainingJob = {
      ...source,
      progressPfDays: source.targetPfDays * 0.9,
      campaignMilestonesReached: [0.5],
      pendingCampaignEvent: undefined,
      daysElapsed: 20,
    };
    let state: SimState = {
      ...base,
      player: {
        ...base.player,
        trainingJob: legacyJob,
        trainingJobs: [legacyJob],
        trainingCheckpoints: [],
      },
    };

    for (let index = 0; index < 4; index += 1) {
      state = captureTrainingCheckpoint(state, legacyJob.id);
    }
    const checkpoints = state.player.trainingCheckpoints!;
    expect(checkpoints.map((checkpoint) => checkpoint.milestone)).toEqual([
      0.5,
    ]);
    expect(new Set(checkpoints.map((checkpoint) => checkpoint.id)).size).toBe(
      1,
    );
    expect(
      checkpoints.map((checkpoint) => checkpoint.telemetry.progress),
    ).toEqual([0.5]);

    const repeated = captureTrainingCheckpoint(state, legacyJob.id);
    expect(repeated.player.trainingCheckpoints).toEqual(checkpoints);
    expect(repeated.alerts[0]!.message).toContain("already in stealth review");
  });

  it("promotes to retained internal, then uses the existing public release path", () => {
    const captured = captureAfterFirstMilestone(7103);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const sourceJob = captured.player.trainingJob!;
    const cash = captured.player.cash;
    const brand = captured.player.brandTrust;
    const activeModelId = captured.player.pricing.activeModelId;

    const promoted = promoteTrainingCheckpoint(captured, candidate.id);
    const retained = promoted.player.models.find(
      (model) => model.id === candidate.model.id,
    )!;
    expect(retained).toMatchObject({ release: "internal", shipped: false });
    expect(promoted.player.trainingCheckpoints![0]).toMatchObject({
      status: "promoted",
      promotedModelId: retained.id,
    });
    expect(promoted.player.trainingJob).toEqual(sourceJob);
    expect(promoted.player.cash).toBe(cash);
    expect(promoted.player.brandTrust).toBe(brand);
    expect(promoted.player.pricing.activeModelId).toBe(activeModelId);

    const released = releaseModel(promoted, retained.id);
    expect(
      released.player.models.find((model) => model.id === retained.id),
    ).toMatchObject({ release: "released", shipped: true });
    expect(released.player.trainingJob).toEqual(sourceJob);
  });

  it("deletes only unpromoted stealth weights from the archive", () => {
    const captured = captureAfterFirstMilestone(7104);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const discarded = discardTrainingCheckpoint(captured, candidate.id);
    expect(discarded.player.trainingCheckpoints).toEqual([]);
    expect(
      promoteTrainingCheckpoint(discarded, candidate.id).player.models,
    ).toHaveLength(0);
    expect(discarded.alerts[0]!.message).toContain("checkpoint deleted");

    const promoted = promoteTrainingCheckpoint(captured, candidate.id);
    const refused = discardTrainingCheckpoint(promoted, candidate.id);
    expect(refused.player.trainingCheckpoints![0]!.status).toBe("promoted");
  });

  it("round-trips the candidate, embedded model and lineage without promoting it", () => {
    const captured = captureAfterFirstMilestone(7105);
    const restored = roundTripState(captured);
    const candidate = restored.player.trainingCheckpoints![0]!;

    expect(candidate.status).toBe("stealth");
    expect(candidate.model.release).toBe("internal");
    expect(candidate.model.shipped).toBe(false);
    expect(candidate.model.lineageId).toBe(candidate.lineageId);
    expect(candidate.telemetry.progress).toBeCloseTo(0.5);
    expect(restored.player.models).toHaveLength(0);
    expect(restored.player.trainingJobs).toHaveLength(1);
  });

  it("queues concurrent evaluations, charges each once, and preserves public economics", () => {
    const captured = captureAfterFirstMilestone(7106);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const request = {
      suiteIds: ["language"] as const,
      budgetTier: "standard" as const,
      mode: "internal" as const,
    };
    const cashBefore = captured.player.cash;
    const brandBefore = captured.player.brandTrust;
    const modelsBefore = captured.player.models;
    const scheduled = scheduleCheckpointEvaluation(captured, candidate.id, {
      ...request,
      suiteIds: [...request.suiteIds],
    });
    const pending =
      scheduled.player.trainingCheckpoints![0]!.pendingEvaluation!;
    expect(scheduled.player.cash).toBeCloseTo(
      cashBefore - pending.quote.totalCost,
    );
    const concurrent = scheduleCheckpointEvaluation(scheduled, candidate.id, {
      suiteIds: ["language"],
      budgetTier: "rigorous",
      mode: "nda_external",
    });
    expect(concurrent.player.privateEvaluationJobs).toHaveLength(2);
    expect(
      new Set(concurrent.player.privateEvaluationJobs!.map((job) => job.id))
        .size,
    ).toBe(2);
    expect(concurrent.player.cash).toBeLessThan(scheduled.player.cash);

    const resolved = tickCheckpointEvaluations({
      ...concurrent,
      day: Math.max(
        ...concurrent.player.privateEvaluationJobs!.map((job) => job.readyDay),
      ),
    });
    const checkpoint = resolved.player.trainingCheckpoints![0]!;
    expect(checkpoint.pendingEvaluation).toBeUndefined();
    expect(checkpoint.evaluations).toHaveLength(2);
    expect(checkpoint.evaluations![0]).toMatchObject({
      modelId: candidate.model.id,
      request: { budgetTier: "standard", mode: "internal" },
      leakOutcome: "none",
    });
    expect(resolved.player.models).toEqual(modelsBefore);
    expect(resolved.player.brandTrust).toBe(brandBefore);
    expect(resolved.player.finance.lifetimeRevenue).toBe(
      captured.player.finance.lifetimeRevenue,
    );
    expect(resolved.player.privateEvaluationJobs).toEqual([]);
  });

  it("captures arbitrary current weights with a stable fingerprint", () => {
    const base = campaignAtTenPercent(7120);
    const source = base.player.trainingJob!;
    const job: TrainingJob = {
      ...source,
      progressPfDays: source.targetPfDays * 0.271,
      campaignMilestonesReached: [],
    };
    const prepared = {
      ...base,
      player: { ...base.player, trainingJob: job, trainingJobs: [job] },
    };
    const captured = createManualTrainingCheckpoint(prepared, {
      sourceJobId: job.id,
      label: "Reasoning branch alpha",
      branchDirection: "reasoning",
    });
    const candidate = captured.player.trainingCheckpoints![0]!;
    expect(currentManualTrainingCheckpointId(prepared, job.id)).toBe(
      candidate.id,
    );
    expect(candidate).toMatchObject({
      kind: "manual",
      customLabel: "Reasoning branch alpha",
      branchDirection: "reasoning",
      telemetry: { progress: 0.271 },
    });
    const repeated = createManualTrainingCheckpoint(captured, {
      sourceJobId: job.id,
      label: "Renamed duplicate",
      branchDirection: "code",
    });
    expect(repeated.player.trainingCheckpoints).toHaveLength(1);
    expect(repeated.alerts[0]!.message).toContain("exact weights");
  });

  it("implements rollback as a new data-consuming branch and preserves source history", () => {
    const captured = captureAfterFirstMilestone(7121);
    const checkpoint = captured.player.trainingCheckpoints![0]!;
    const source = captured.player.trainingJob!;
    const checkpointWithOldWatermark = {
      ...checkpoint,
      model: { ...checkpoint.model, dataWatermarkMTok: 0 },
    };
    const prepared = {
      ...captured,
      player: {
        ...captured.player,
        trainingCheckpoints: [checkpointWithOldWatermark],
      },
    };
    const branched = rollbackTrainingJobToCheckpoint(prepared, {
      jobId: source.id,
      checkpointId: checkpoint.id,
    });
    const child = branched.player.trainingJobs!.find(
      (job) => job.id !== source.id,
    );
    expect(child).toMatchObject({
      mode: "continue",
      continueFromId: checkpoint.model.id,
      parentCheckpointId: checkpoint.id,
      progressPfDays: 0,
    });
    expect(
      branched.player.trainingJobs!.find((job) => job.id === source.id),
    ).toMatchObject({ paused: true });
    expect(source.progressPfDays).toBe(
      captured.player.trainingJob!.progressPfDays,
    );
    expect(branched.player.models).toHaveLength(0);
  });

  it("runs code and chat branches concurrently from the same private checkpoint", () => {
    const captured = captureAfterFirstMilestone(7122);
    const checkpoint = captured.player.trainingCheckpoints![0]!;
    const source = captured.player.trainingJob!;
    const prepared: SimState = {
      ...captured,
      player: {
        ...captured.player,
        trainingCheckpoints: [
          {
            ...checkpoint,
            model: { ...checkpoint.model, dataWatermarkMTok: 0 },
          },
        ],
      },
    };
    const code = forkTrainingCheckpoint(prepared, {
      checkpointId: checkpoint.id,
      direction: "code",
    });
    const chat = forkTrainingCheckpoint(code, {
      checkpointId: checkpoint.id,
      direction: "chat",
    });
    expect(chat.player.trainingJobs).toHaveLength(3);
    const children = chat.player.trainingJobs!.filter(
      (job) => job.id !== source.id,
    );
    expect(new Set(children.map((job) => job.id)).size).toBe(2);
    expect(children.map((job) => job.parentCheckpointId)).toEqual([
      checkpoint.id,
      checkpoint.id,
    ]);
    expect(new Set(children.map((job) => job.branchDirection))).toEqual(
      new Set(["code", "chat"]),
    );
    const refusedDiscard = discardTrainingCheckpoint(chat, checkpoint.id);
    expect(refusedDiscard.player.trainingCheckpoints).toHaveLength(1);
    expect(refusedDiscard.player.trainingJobs).toHaveLength(3);
    expect(refusedDiscard.alerts[0]!.message).toContain("depends on them");

    const advanced = tickTraining(refusedDiscard);
    for (const child of children) {
      expect(
        advanced.player.trainingJobs!.find((job) => job.id === child.id)!
          .progressPfDays,
      ).toBeGreaterThan(0);
    }
  });

  it("starts a cyber-specialised child while the source run continues", () => {
    const captured = captureAfterFirstMilestone(7123);
    const checkpoint = captured.player.trainingCheckpoints![0]!;
    const source = captured.player.trainingJob!;
    const prepared: SimState = {
      ...captured,
      player: {
        ...captured.player,
        trainingCheckpoints: [
          {
            ...checkpoint,
            model: { ...checkpoint.model, dataWatermarkMTok: 0 },
          },
        ],
      },
    };

    const branched = forkTrainingCheckpoint(prepared, {
      checkpointId: checkpoint.id,
      direction: "cyber",
      label: "Aster Cyber",
    });
    const child = branched.player.trainingJobs!.find(
      (job) => job.id !== source.id,
    )!;
    const unchangedParent = branched.player.trainingJobs!.find(
      (job) => job.id === source.id,
    )!;

    expect(child).toMatchObject({
      name: "Aster Cyber",
      mode: "continue",
      parentCheckpointId: checkpoint.id,
      branchDirection: "cyber",
      progressPfDays: 0,
    });
    expect(child.specializationFocus?.coding).toBeGreaterThan(0.5);
    expect(child.dataPlan.weights.code ?? 0).toBeGreaterThan(
      checkpoint.model.dataPlan!.weights.code ?? 0,
    );
    expect(child.dataPlan.weights.law ?? 0).toBeGreaterThan(
      checkpoint.model.dataPlan!.weights.law ?? 0,
    );
    expect(unchangedParent.paused).not.toBe(true);
    expect(unchangedParent.progressPfDays).toBe(source.progressPfDays);
  });

  it("applies an explicit specialization focus mix when forking", () => {
    const captured = captureAfterFirstMilestone(7124);
    const checkpoint = captured.player.trainingCheckpoints![0]!;
    const prepared: SimState = {
      ...captured,
      player: {
        ...captured.player,
        trainingCheckpoints: [
          {
            ...checkpoint,
            model: { ...checkpoint.model, dataWatermarkMTok: 0 },
          },
        ],
      },
    };
    const branched = forkTrainingCheckpoint(prepared, {
      checkpointId: checkpoint.id,
      direction: "code",
      specializationFocus: {
        coding: 0.9,
        science: 0,
        research: 0.2,
        personality: 0,
        chat: 0.1,
      },
    });
    const child = branched.player.trainingJobs!.find(
      (job) => job.id !== captured.player.trainingJob!.id,
    )!;
    expect(child.specializationFocus?.coding).toBeCloseTo(0.9);
    expect(child.lifecycle).toBe("specialized");
    expect(child.dataPlan.weights.code ?? 0).toBeGreaterThan(
      checkpoint.model.dataPlan!.weights.code ?? 0,
    );
  });

  it("blocks promotion but discard cancels an in-flight private evaluation", () => {
    const captured = captureAfterFirstMilestone(7107);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const scheduled = scheduleCheckpointEvaluation(captured, candidate.id, {
      suiteIds: ["language"],
      budgetTier: "lean",
      mode: "internal",
    });

    expect(
      promoteTrainingCheckpoint(scheduled, candidate.id).player.models,
    ).toHaveLength(0);
    const cash = scheduled.player.cash;
    const discarded = discardTrainingCheckpoint(scheduled, candidate.id);
    expect(discarded.player.trainingCheckpoints).toEqual([]);
    expect(discarded.player.privateEvaluationJobs).toEqual([]);
    expect(discarded.player.cash).toBe(cash);
    expect(discarded.alerts[0]!.message).toContain("without refund");
  });

  it("deletes completed reports and every queued study across save/load", () => {
    const captured = captureAfterFirstMilestone(7136);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const first = scheduleCheckpointEvaluation(captured, candidate.id, {
      suiteIds: ["language"],
      budgetTier: "lean",
      mode: "internal",
    });
    const resolved = tickCheckpointEvaluations({
      ...first,
      day: first.player.privateEvaluationJobs![0]!.readyDay,
    });
    expect(resolved.player.trainingCheckpoints![0]!.evaluations).toHaveLength(
      1,
    );
    expect(
      resolved.player.trainingCheckpoints![0]!.evaluations![0]!.reviews,
    ).not.toHaveLength(0);

    const second = scheduleCheckpointEvaluation(resolved, candidate.id, {
      suiteIds: ["language"],
      budgetTier: "standard",
      mode: "internal",
    });
    const queued = scheduleCheckpointEvaluation(second, candidate.id, {
      suiteIds: ["language"],
      budgetTier: "rigorous",
      mode: "nda_external",
    });
    expect(queued.player.privateEvaluationJobs).toHaveLength(2);
    const chargedCash = queued.player.cash;

    const deleted = discardTrainingCheckpoint(queued, candidate.id);
    expect(deleted.player.cash).toBe(chargedCash);
    expect(
      deleted.player.trainingCheckpoints?.some(
        (checkpoint) => checkpoint.id === candidate.id,
      ),
    ).toBe(false);
    expect(
      deleted.player.privateEvaluationJobs?.some(
        (job) =>
          job.kind === "checkpoint_evaluation" &&
          job.subjectId === candidate.id,
      ),
    ).toBe(false);
    expect(deleted.alerts[0]!.message).toContain("Cancelled 2 queued");

    const restored = roundTripState(deleted);
    expect(restored.player.trainingCheckpoints).toEqual([]);
    expect(restored.player.privateEvaluationJobs).toEqual([]);
  });

  it("migrates legacy discarded tombstones and their queued studies away", () => {
    const captured = captureAfterFirstMilestone(7137);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const scheduled = scheduleCheckpointEvaluation(captured, candidate.id, {
      suiteIds: ["language"],
      budgetTier: "lean",
      mode: "internal",
    });
    const legacy: SimState = {
      ...scheduled,
      player: {
        ...scheduled.player,
        trainingCheckpoints: [
          {
            ...scheduled.player.trainingCheckpoints![0]!,
            status: "discarded",
            discardedDay: scheduled.day,
          },
        ],
      },
    };

    const restored = roundTripState(legacy);
    expect(restored.player.trainingCheckpoints).toEqual([]);
    expect(restored.player.privateEvaluationJobs).toEqual([]);
  });

  it("evaluates a promoted checkpoint and copies the report onto its retained model", () => {
    const captured = captureAfterFirstMilestone(7108);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const promoted = promoteTrainingCheckpoint(captured, candidate.id);
    const scheduled = scheduleCheckpointEvaluation(promoted, candidate.id, {
      suiteIds: ["language"],
      budgetTier: "lean",
      mode: "internal",
    });
    const pending =
      scheduled.player.trainingCheckpoints![0]!.pendingEvaluation!;
    const resolved = tickCheckpointEvaluations({
      ...scheduled,
      day: pending.readyDay,
    });
    const retained = resolved.player.models.find(
      (model) => model.id === candidate.model.id,
    )!;

    expect(resolved.player.trainingCheckpoints![0]!.evaluations).toHaveLength(
      1,
    );
    expect(retained.checkpointEvaluations).toHaveLength(1);
    expect(retained.checkpointEvaluations![0]!.modelId).toBe(retained.id);
  });

  it("deleting retained checkpoint weights cascades its archive and queued study", () => {
    const captured = captureAfterFirstMilestone(7111);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const promoted = promoteTrainingCheckpoint(captured, candidate.id);
    const scheduled = scheduleCheckpointEvaluation(promoted, candidate.id, {
      suiteIds: ["language"],
      budgetTier: "lean",
      mode: "internal",
    });
    const cash = scheduled.player.cash;
    const deleted = deleteModel(scheduled, candidate.model.id);

    expect(
      deleted.player.models.some((model) => model.id === candidate.model.id),
    ).toBe(false);
    expect(deleted.player.trainingCheckpoints).toEqual([]);
    expect(deleted.player.privateEvaluationJobs).toEqual([]);
    expect(deleted.player.cash).toBe(cash);
    expect(deleted.alerts[0]!.message).toContain(
      "Removed 1 unowned checkpoint",
    );
  });

  it("keeps deleted exact weights when a distinct child becomes their concrete owner", () => {
    const captured = captureAfterFirstMilestone(7135);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const sourceJob = captured.player.trainingJob!;
    const promoted = promoteTrainingCheckpoint(captured, candidate.id);
    const prepared: SimState = {
      ...promoted,
      player: {
        ...promoted.player,
        trainingCheckpoints: [
          {
            ...promoted.player.trainingCheckpoints![0]!,
            model: { ...candidate.model, dataWatermarkMTok: 0 },
          },
        ],
      },
    };
    const forked = forkTrainingCheckpoint(prepared, {
      checkpointId: candidate.id,
      direction: "reasoning",
    });
    const child = forked.player.trainingJobs!.find(
      (job) => job.id !== sourceJob.id,
    )!;

    const withoutExact = deleteModel(forked, candidate.model.id);
    expect(withoutExact.player.trainingCheckpoints).toHaveLength(1);
    expect(withoutExact.player.trainingCheckpoints![0]).toMatchObject({
      id: candidate.id,
      status: "stealth",
      promotedModelId: undefined,
      sourceOwnershipRevoked: true,
    });

    const restored = roundTripState(withoutExact);
    expect(restored.player.trainingCheckpoints![0]).toMatchObject({
      sourceOwnershipRevoked: true,
    });
    const completedChild = {
      ...restored.player.trainingJobs!.find((job) => job.id === child.id)!,
      progressPfDays: child.targetPfDays,
      pendingCampaignEvent: undefined,
    };
    const ready: SimState = {
      ...restored,
      player: {
        ...restored.player,
        trainingJobs: restored.player.trainingJobs!.map((job) =>
          job.id === child.id ? completedChild : job,
        ),
      },
    };
    const finalizedChild = keepInternal(ready, child.id);
    const childModel = finalizedChild.player.models.find(
      (model) =>
        model.sourceTrainingJobId === child.id &&
        model.parentModelId === candidate.model.id,
    )!;
    expect(childModel).toBeDefined();
    expect(finalizedChild.player.trainingCheckpoints).toHaveLength(1);

    const refusedDiscard = discardTrainingCheckpoint(
      finalizedChild,
      candidate.id,
    );
    expect(refusedDiscard.player.trainingCheckpoints).toHaveLength(1);
    expect(refusedDiscard.alerts[0]!.message).toContain("depends on them");

    const withoutLastChild = deleteModel(refusedDiscard, childModel.id);
    expect(withoutLastChild.player.trainingCheckpoints).toEqual([]);
  });

  it("cascades finalized base-model checkpoints, reports, and pending studies", () => {
    const captured = captureAfterFirstMilestone(7130);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const first = scheduleCheckpointEvaluation(captured, candidate.id, {
      suiteIds: ["language"],
      budgetTier: "lean",
      mode: "internal",
    });
    const firstDue = first.player.privateEvaluationJobs![0]!.readyDay;
    const resolved = tickCheckpointEvaluations({ ...first, day: firstDue });
    const second = scheduleCheckpointEvaluation(resolved, candidate.id, {
      suiteIds: ["language"],
      budgetTier: "rigorous",
      mode: "nda_external",
    });
    const job = {
      ...second.player.trainingJob!,
      pendingCampaignEvent: undefined,
    };
    const releasable: SimState = {
      ...second,
      player: {
        ...second.player,
        trainingJob: job,
        trainingJobs: [job],
      },
    };
    const released = releaseFromJob(releasable, job.id);
    const sourceModel = released.player.models.find(
      (model) => model.sourceTrainingJobId === job.id,
    )!;
    expect(sourceModel.release).toBe("released");
    expect(released.player.trainingCheckpoints![0]!.evaluations).toHaveLength(
      1,
    );
    expect(released.player.privateEvaluationJobs).toHaveLength(1);
    expect(
      released.evaluations.filter(
        (evaluation) =>
          evaluation.modelId === sourceModel.id && !evaluation.published,
      ),
    ).not.toHaveLength(0);
    // A duplicated historical sourceTrainingJobId is not ownership of these
    // weights and must not defeat deletion of the canonical owner.
    const staleHistoryModel = {
      ...sourceModel,
      id: "stale-history-model",
      name: "Stale history row",
    };
    const publishedEvaluationId = released.evaluations.find(
      (evaluation) => evaluation.modelId === sourceModel.id,
    )!.id;
    const withStaleHistory: SimState = {
      ...released,
      evaluations: released.evaluations.map((evaluation) =>
        evaluation.id === publishedEvaluationId
          ? { ...evaluation, published: true }
          : evaluation,
      ),
      player: {
        ...released.player,
        models: [...released.player.models, staleHistoryModel],
      },
    };
    const cash = withStaleHistory.player.cash;

    const deleted = deleteModel(withStaleHistory, sourceModel.id);
    expect(deleted.player.cash).toBe(cash);
    expect(
      deleted.player.models.some((model) => model.id === staleHistoryModel.id),
    ).toBe(true);
    expect(deleted.player.trainingCheckpoints).toEqual([]);
    expect(deleted.player.privateEvaluationJobs).toEqual([]);
    expect(
      deleted.evaluations.some(
        (evaluation) =>
          evaluation.modelId === sourceModel.id && !evaluation.published,
      ),
    ).toBe(false);
    expect(
      deleted.evaluations.some(
        (evaluation) => evaluation.id === publishedEvaluationId,
      ),
    ).toBe(true);
    expect(deleted.alerts[0]!.message).toContain("Removed 1 unowned checkpoint");

    const restored = roundTripState(deleted);
    expect(restored.player.trainingCheckpoints).toEqual([]);
    expect(restored.player.privateEvaluationJobs).toEqual([]);
    expect(
      restored.evaluations.some(
        (evaluation) => evaluation.id === publishedEvaluationId,
      ),
    ).toBe(true);
  });

  it("preserves a checkpoint while a retained exact version owns it", () => {
    const captured = captureAfterFirstMilestone(7131);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const promoted = promoteTrainingCheckpoint(captured, candidate.id);
    const publicPromoted = releaseModel(promoted, candidate.model.id);
    const job = {
      ...publicPromoted.player.trainingJob!,
      pendingCampaignEvent: undefined,
    };
    const finalized = keepInternal(
      {
        ...publicPromoted,
        player: {
          ...publicPromoted.player,
          trainingJob: job,
          trainingJobs: [job],
        },
      },
      job.id,
    );
    const finalModel = finalized.player.models.find(
      (model) =>
        model.sourceTrainingJobId === job.id && model.id !== candidate.model.id,
    )!;
    const retained = finalized.player.models.find(
      (model) => model.id === candidate.model.id,
    )!;
    expect(retained.release).toBe("released");
    const restoredFinalized = roundTripState(finalized);
    expect(restoredFinalized.player.trainingCheckpoints![0]!.ownerModelId).toBe(
      finalModel.id,
    );

    const withoutBase = deleteModel(restoredFinalized, finalModel.id);
    expect(withoutBase.player.trainingCheckpoints).toHaveLength(1);
    expect(withoutBase.player.trainingCheckpoints![0]).toMatchObject({
      status: "promoted",
      promotedModelId: retained.id,
    });

    const withoutLastOwner = deleteModel(withoutBase, retained.id);
    expect(withoutLastOwner.player.trainingCheckpoints).toEqual([]);
  });

  it("cancelling a run removes unowned checkpoints and every queued study", () => {
    const captured = captureAfterFirstMilestone(7132);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const withCheckpointStudy = scheduleCheckpointEvaluation(
      captured,
      candidate.id,
      {
        suiteIds: ["language"],
        budgetTier: "lean",
        mode: "internal",
      },
    );
    const scheduled = benchmarkTrainingJob(
      withCheckpointStudy,
      withCheckpointStudy.player.trainingJob!.id,
      { suiteIds: ["language"], spendPerSuite: 50_000 },
    );
    expect(scheduled.player.privateEvaluationJobs).toHaveLength(2);
    const cash = scheduled.player.cash;

    const cancelled = cancelTraining(
      scheduled,
      scheduled.player.trainingJob!.id,
    );
    expect(cancelled.player.cash).toBe(cash);
    expect(cancelled.player.trainingJobs).toEqual([]);
    expect(cancelled.player.trainingCheckpoints).toEqual([]);
    expect(cancelled.player.privateEvaluationJobs).toEqual([]);
  });

  it("keeps a promoted exact checkpoint when its source run is cancelled", () => {
    const captured = captureAfterFirstMilestone(7134);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const promoted = promoteTrainingCheckpoint(captured, candidate.id);
    const cancelled = cancelTraining(
      promoted,
      promoted.player.trainingJob!.id,
    );

    expect(cancelled.player.trainingJobs).toEqual([]);
    expect(cancelled.player.trainingCheckpoints).toHaveLength(1);
    expect(cancelled.player.trainingCheckpoints![0]).toMatchObject({
      id: candidate.id,
      status: "promoted",
      promotedModelId: candidate.model.id,
    });
    expect(
      cancelled.player.models.some((model) => model.id === candidate.model.id),
    ).toBe(true);
  });

  it("keeps a checkpoint through source cancellation while a child branch needs it", () => {
    const captured = captureAfterFirstMilestone(7133);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const sourceJob = captured.player.trainingJob!;
    const prepared: SimState = {
      ...captured,
      player: {
        ...captured.player,
        trainingCheckpoints: [
          {
            ...candidate,
            model: { ...candidate.model, dataWatermarkMTok: 0 },
          },
        ],
      },
    };
    const forked = forkTrainingCheckpoint(prepared, {
      checkpointId: candidate.id,
      direction: "code",
    });
    const child = forked.player.trainingJobs!.find(
      (job) => job.id !== sourceJob.id,
    )!;
    const sourceCancelled = cancelTraining(forked, sourceJob.id);
    expect(sourceCancelled.player.trainingCheckpoints).toHaveLength(1);
    expect(sourceCancelled.player.trainingJobs!.map((job) => job.id)).toEqual([
      child.id,
    ]);

    const childCancelled = cancelTraining(sourceCancelled, child.id);
    expect(childCancelled.player.trainingCheckpoints).toEqual([]);
  });

  it("refuses to evaluate weights after their checkpoint record is deleted", () => {
    const captured = captureAfterFirstMilestone(7109);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const discarded = discardTrainingCheckpoint(captured, candidate.id);
    const scheduled = scheduleCheckpointEvaluation(discarded, candidate.id, {
      suiteIds: ["language"],
      budgetTier: "lean",
      mode: "internal",
    });

    expect(scheduled.player.trainingCheckpoints).toEqual([]);
    expect(scheduled.player.privateEvaluationJobs).toEqual([]);
    expect(scheduled.alerts[0]!.message).toContain("not found");
  });

  it("round-trips pending and completed evaluation evidence with nested arrays", () => {
    const captured = captureAfterFirstMilestone(7110);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const first = scheduleCheckpointEvaluation(captured, candidate.id, {
      suiteIds: ["language"],
      budgetTier: "lean",
      mode: "internal",
    });
    const due =
      first.player.trainingCheckpoints![0]!.pendingEvaluation!.readyDay;
    const resolved = tickCheckpointEvaluations({ ...first, day: due });
    const second = scheduleCheckpointEvaluation(resolved, candidate.id, {
      suiteIds: ["language"],
      budgetTier: "rigorous",
      mode: "nda_external",
    });
    const restored = roundTripState(second);
    const checkpoint = restored.player.trainingCheckpoints![0]!;

    expect(checkpoint.evaluations).toHaveLength(1);
    expect(
      checkpoint.evaluations![0]!.suites[0]!.metrics.length,
    ).toBeGreaterThan(0);
    expect(checkpoint.evaluations![0]!.reviews.length).toBeGreaterThan(0);
    expect(checkpoint.pendingEvaluation).toMatchObject({
      request: { suiteIds: ["language"], mode: "nda_external" },
      quote: { suiteIds: ["language"], budgetTier: "rigorous" },
    });
    expect(restored.player.privateEvaluationJobs).toHaveLength(1);
    expect(restored.player.privateEvaluationJobs![0]).toMatchObject({
      kind: "checkpoint_evaluation",
      subjectId: candidate.id,
    });
  });

  it("keeps sequential studies independently identified without rerolling evidence direction", () => {
    const captured = captureAfterFirstMilestone(7112);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const firstScheduled = scheduleCheckpointEvaluation(
      captured,
      candidate.id,
      {
        suiteIds: ["language"],
        budgetTier: "lean",
        mode: "internal",
      },
    );
    const firstDue =
      firstScheduled.player.trainingCheckpoints![0]!.pendingEvaluation!
        .readyDay;
    const firstResolved = tickCheckpointEvaluations({
      ...firstScheduled,
      day: firstDue,
    });
    const secondScheduled = scheduleCheckpointEvaluation(
      firstResolved,
      candidate.id,
      {
        suiteIds: ["language"],
        budgetTier: "rigorous",
        mode: "nda_external",
      },
    );
    const secondDue =
      secondScheduled.player.trainingCheckpoints![0]!.pendingEvaluation!
        .readyDay;
    const secondResolved = tickCheckpointEvaluations({
      ...secondScheduled,
      day: secondDue,
    });
    const reports = secondResolved.player.trainingCheckpoints![0]!.evaluations!;
    const latent = candidate.model.benchmarks.mmlu;
    const directions = reports.map((report) =>
      Math.sign(report.suites[0]!.metrics[0]!.score - latent),
    );

    expect(reports).toHaveLength(2);
    expect(new Set(reports.map((report) => report.id)).size).toBe(2);
    expect(new Set(directions).size).toBe(1);
    expect(
      reports[1]!.suites[0]!.metrics[0]!.high -
        reports[1]!.suites[0]!.metrics[0]!.low,
    ).toBeLessThan(
      reports[0]!.suites[0]!.metrics[0]!.high -
        reports[0]!.suites[0]!.metrics[0]!.low,
    );
  });

  it("refuses a seventeenth study without charging cash or laundering the archive", () => {
    const captured = captureAfterFirstMilestone(7113);
    const candidate = captured.player.trainingCheckpoints![0]!;
    const scheduled = scheduleCheckpointEvaluation(captured, candidate.id, {
      suiteIds: ["language"],
      budgetTier: "lean",
      mode: "internal",
    });
    const due =
      scheduled.player.trainingCheckpoints![0]!.pendingEvaluation!.readyDay;
    const resolved = tickCheckpointEvaluations({ ...scheduled, day: due });
    const report = resolved.player.trainingCheckpoints![0]!.evaluations![0]!;
    const archive = Array.from(
      { length: MAX_CHECKPOINT_EVALUATIONS },
      (_, index) => ({ ...report, id: `${report.id}-${index}` }),
    );
    const capped = {
      ...resolved,
      player: {
        ...resolved.player,
        trainingCheckpoints: resolved.player.trainingCheckpoints!.map(
          (checkpoint) =>
            checkpoint.id === candidate.id
              ? { ...checkpoint, evaluations: archive }
              : checkpoint,
        ),
      },
    };
    const cash = capped.player.cash;
    const refused = scheduleCheckpointEvaluation(capped, candidate.id, {
      suiteIds: ["language"],
      budgetTier: "rigorous",
      mode: "partner_pilot",
    });
    const checkpoint = refused.player.trainingCheckpoints![0]!;

    expect(refused.player.cash).toBe(cash);
    expect(checkpoint.pendingEvaluation).toBeUndefined();
    expect(checkpoint.evaluations).toEqual(archive);
    expect(checkpoint.evaluations).toHaveLength(MAX_CHECKPOINT_EVALUATIONS);
    expect(refused.alerts[0]!.message).toContain("maximum 16");
  });
});

import { createRng, hashSeed, seededId } from "../rng";
import type {
  DataDomain,
  TrainingCampaignChoice,
  TrainingCampaignEvent,
  TrainingCampaignEventKind,
  TrainingCampaignModifiers,
  TrainingJob,
} from "../types";
import { architectureBlueprintProfile } from "./architectureFrontiers";

export const TRAINING_CAMPAIGN_MILESTONES = [0.12, 0.32, 0.58, 0.82] as const;
/** Omni needs roughly 1.8× the ordinary strong 7.5N breadth target. */
export const CLOSED_LOOP_MIN_EFFECTIVE_DATA_RATIO = 13.5;

export function emptyTrainingCampaignModifiers(): TrainingCampaignModifiers {
  return {
    capabilityDelta: 0,
    reliabilityDelta: 0,
    safetyDelta: 0,
    breakthroughBias: 0,
    stumbleRisk: 0,
    dataQualityDelta: 0,
    verifiedRecursiveCapabilityBonus: 0,
  };
}

/**
 * Normalize a persisted recursive gain at the campaign boundary. Only an omni
 * blueprint can retain it, and the architecture profile owns the total bound.
 */
export function boundedVerifiedRecursiveCapabilityBonus(
  family: TrainingJob["family"],
  value: number | undefined,
): number {
  const profile = architectureBlueprintProfile({ family });
  if (profile.id !== "omni") return 0;
  const maxBonus = Math.max(
    0,
    profile.verifiedRecursiveCapabilityCap - profile.pretrainingCapabilityCap,
  );
  return Math.min(maxBonus, Math.max(0, value ?? 0));
}

/** A closed-loop event is earned by the immutable campaign snapshot. */
export function canSurfaceRecursiveResearchEvent(
  job: Pick<TrainingJob, "family" | "integratedMethods" | "effectiveDataRatio">,
): boolean {
  return (
    job.family === "omni" &&
    (job.integratedMethods ?? []).includes("mm_closed_loop_research") &&
    (job.effectiveDataRatio ?? 0) >= CLOSED_LOOP_MIN_EFFECTIVE_DATA_RATIO
  );
}

function roundedInterventionCost(job: TrainingJob, multiplier: number): number {
  const raw =
    (75_000 +
      Math.sqrt(Math.max(0.01, job.targetParamsB)) * 125_000 +
      Math.sqrt(Math.max(0, job.recommendedPfDays ?? job.targetPfDays)) *
        35_000) *
    multiplier;
  return Math.min(
    12_000_000,
    Math.max(50_000, Math.round(raw / 10_000) * 10_000),
  );
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function money(value: number): string {
  return value >= 1_000_000
    ? `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
    : `$${Math.round(value / 1_000)}k`;
}

function mixEntropy(job: TrainingJob): number {
  const values = Object.values(job.dataPlan?.weights ?? {}).filter(
    (value): value is number => Number.isFinite(value) && value > 0,
  );
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.length <= 1 || total <= 0) return 0;
  const entropy = -values.reduce((sum, value) => {
    const share = value / total;
    return sum + share * Math.log(share);
  }, 0);
  return Math.max(0, Math.min(1, entropy / Math.log(values.length)));
}

function dataEvidenceRisk(job: TrainingJob): number {
  const evidence = job.dataEvidence;
  if (!evidence) return 0;
  const repetition = Math.max(0, (job.repeatedDataEpochs ?? 1) - 4) / 8;
  const syntheticLineage =
    evidence.syntheticShare *
    Math.max(0, evidence.syntheticGenerationDepth - 1) *
    (1 - evidence.humanAnchorShare);
  return Math.max(
    0,
    Math.min(
      1.5,
      evidence.contaminationRisk * 0.9 +
        (1 - evidence.effectiveDiversity) * 0.45 +
        (1 - evidence.effectiveFreshness) * 0.25 +
        syntheticLineage * 0.5 +
        repetition * 0.25,
    ),
  );
}

function modalityBalance(job: TrainingJob): number {
  const weights = job.dataPlan?.weights ?? {};
  const enabled: DataDomain[] = [];
  if ((job.io?.inputs.image ?? 0) > 0 || (job.io?.outputs.image ?? 0) > 0)
    enabled.push("image");
  if ((job.io?.inputs.audio ?? 0) > 0 || (job.io?.outputs.audio ?? 0) > 0)
    enabled.push("audio");
  if ((job.io?.inputs.video ?? 0) > 0 || (job.io?.outputs.video ?? 0) > 0)
    enabled.push("video");
  if (!enabled.length) return 1;
  const shares = enabled.map((domain) => Math.max(0, weights[domain] ?? 0));
  const max = Math.max(...shares, 0.01);
  return Math.max(0, Math.min(1, Math.min(...shares) / max));
}

function weightedKind(
  job: TrainingJob,
  milestoneIndex: number,
): TrainingCampaignEventKind {
  const methods = new Set(job.integratedMethods ?? []);
  const risk =
    job.outcomeRisk === "high" ? 1 : job.outcomeRisk === "medium" ? 0.5 : 0;
  const evidenceRisk = dataEvidenceRisk(job);
  const lq = Math.max(0, Math.min(1, job.synthLqShare ?? 0));
  const repeat = Math.max(1, job.repeatedDataEpochs ?? 1);
  const entropy = mixEntropy(job);
  const largeRun = Math.min(
    1.5,
    Math.log10(Math.max(1, job.targetParamsB)) / 2.4,
  );
  // The final 82% checkpoint is the earned proposal opportunity. Earlier
  // milestones can still roll it as an unusual discovery, but a qualified
  // player is never denied the late-game loop by RNG alone.
  if (
    milestoneIndex === TRAINING_CAMPAIGN_MILESTONES.length - 1 &&
    canSurfaceRecursiveResearchEvent(job)
  ) {
    return "recursive_research";
  }
  const candidates: Array<[TrainingCampaignEventKind, number]> = [
    ["loss_spike", 1.1 + risk * 1.5 + (methods.has("data_eval") ? -0.2 : 0.2)],
    [
      "data_anomaly",
      0.75 +
        lq * 2 +
        evidenceRisk * 1.5 +
        Math.max(0, repeat - 4) * 0.12 +
        (methods.has("data_clean") ? -0.25 : 0.3),
    ],
    [
      "mixture_discovery",
      0.65 +
        entropy * 0.85 +
        (job.dataEvidence?.effectiveDiversity ?? 0.5) * 0.35 +
        (methods.has("data_mix") ? 0.35 : 0),
    ],
    [
      "hardware_fault",
      0.45 + largeRun * 0.7 + (methods.has("hw_storage") ? -0.2 : 0.2),
    ],
  ];
  if (job.backbone === "moe" || job.family === "moe") {
    candidates.push([
      "routing_imbalance",
      methods.has("moe_balance")
        ? 0.45
        : methods.has("moe_routing")
          ? 1.2
          : 2.4,
    ]);
  }
  if (job.productPreset === "omni" || job.family === "omni") {
    candidates.push([
      "modality_interference",
      0.7 + (1 - modalityBalance(job)) * 2.2,
    ]);
    if (canSurfaceRecursiveResearchEvent(job)) {
      candidates.push([
        "recursive_research",
        Math.max(0.2, 0.65 + Math.min(1.2, (job.effectiveDataRatio ?? 0) / 12)),
      ]);
    }
  }
  const rng = createRng(
    hashSeed(job.outcomeSeed ?? 0, job.id, milestoneIndex, "campaign-kind-v1"),
  );
  const total = candidates.reduce(
    (sum, [, weight]) => sum + Math.max(0.01, weight),
    0,
  );
  let roll = rng.next() * total;
  for (const [kind, weight] of candidates) {
    roll -= Math.max(0.01, weight);
    if (roll <= 0) return kind;
  }
  return candidates.at(-1)?.[0] ?? "loss_spike";
}

function choice(
  id: string,
  label: string,
  description: string,
  effects: TrainingCampaignChoice["effects"],
  recommended = false,
): TrainingCampaignChoice {
  return { id, label, description, effects, recommended };
}

function eventContent(
  job: TrainingJob,
  kind: TrainingCampaignEventKind,
  milestoneIndex: number,
): Pick<
  TrainingCampaignEvent,
  "title" | "description" | "signal" | "severity" | "choices"
> {
  const standardCost = roundedInterventionCost(job, 1);
  const highCost = roundedInterventionCost(job, 1.75);
  const rng = createRng(
    hashSeed(
      job.outcomeSeed ?? 0,
      job.id,
      milestoneIndex,
      kind,
      "campaign-content-v1",
    ),
  );
  const pushDelta = rng.range(-0.85, 1.25);
  switch (kind) {
    case "data_anomaly":
      return {
        title: "Suspicious training shard",
        description:
          "A domain shard is learning unusually fast. It may be high-signal data, duplication, or benchmark leakage.",
        signal: `${(job.dataQualityUsed ?? 0).toFixed(0)}/100 source quality · ${Math.max(1, job.repeatedDataEpochs ?? 1).toFixed(1)} corpus epochs`,
        severity: "warning",
        choices: [
          choice(
            "quarantine",
            "Quarantine and replay",
            `Drop the shard and replay ${pct(0.025)} of progress from a clean checkpoint. Lowest contamination risk.`,
            {
              progressRollbackFraction: 0.025,
              dataQualityDelta: 3,
              reliabilityDelta: 2.5,
              stumbleRisk: -0.045,
            },
            true,
          ),
          choice(
            "audit",
            "Fund a forensic audit",
            `${money(standardCost)} for deduplication, provenance checks, and a shadow holdout; adds ${pct(0.015)} compute.`,
            {
              cashCost: standardCost,
              extraComputeFraction: 0.015,
              dataQualityDelta: 2,
              reliabilityDelta: 3.5,
              safetyDelta: 1,
              breakthroughBias: 0.012,
            },
          ),
          choice(
            "trust-shard",
            "Trust the signal",
            "Keep the apparent gain. Cheap, but a contaminated shard can inflate public scores and hurt transfer.",
            {
              capabilityDelta: pushDelta * 0.55,
              reliabilityDelta: -3,
              stumbleRisk: 0.045,
            },
          ),
        ],
      };
    case "mixture_discovery":
      return {
        title: "Unexpected transfer signal",
        description:
          "A minority data domain is improving several validation slices. The effect is promising but still uncertain at full scale.",
        signal: `${Math.round(mixEntropy(job) * 100)}% mixture diversity · checkpoint ${Math.round(TRAINING_CAMPAIGN_MILESTONES[milestoneIndex]! * 100)}%`,
        severity: "opportunity",
        choices: [
          choice(
            "validate-transfer",
            "Validate with a proxy branch",
            `${money(standardCost)} and ${pct(0.02)} extra compute to test whether the transfer survives a clean holdout.`,
            {
              cashCost: standardCost,
              extraComputeFraction: 0.02,
              capabilityDelta: 0.65,
              reliabilityDelta: 1.5,
              breakthroughBias: 0.025,
            },
            true,
          ),
          choice(
            "exploit-transfer",
            "Lean into the curriculum",
            `Spend ${pct(0.045)} more compute on the promising mix. Higher upside, wider generalization risk.`,
            {
              extraComputeFraction: 0.045,
              capabilityDelta: Math.max(0.35, pushDelta + 0.35),
              breakthroughBias: 0.045,
              stumbleRisk: 0.025,
            },
          ),
          choice(
            "stay-course",
            "Stay on the planned mix",
            "Preserve the original forecast and give up the possible transfer gain.",
            { reliabilityDelta: 0.5 },
          ),
        ],
      };
    case "hardware_fault":
      return {
        title: "Cluster fault during checkpoint",
        description:
          "A worker group dropped during a distributed save. The last checkpoint is intact, but optimizer state needs verification.",
        signal: `${job.targetParamsB.toFixed(job.targetParamsB < 10 ? 1 : 0)}B parameters · ${Math.round(job.targetPfDays)} PF-day campaign`,
        severity: "warning",
        choices: [
          choice(
            "rollback-checkpoint",
            "Rollback and verify",
            `Replay ${pct(0.018)} of progress from the last verified checkpoint.`,
            {
              progressRollbackFraction: 0.018,
              reliabilityDelta: 2,
              stumbleRisk: -0.035,
            },
            true,
          ),
          choice(
            "replace-workers",
            "Replace the worker group",
            `${money(highCost)} for spare capacity and state validation; avoids the rollback.`,
            {
              cashCost: highCost,
              reliabilityDelta: 2.5,
              stumbleRisk: -0.025,
            },
          ),
          choice(
            "resume-degraded",
            "Resume from partial state",
            "No immediate cost. Silent optimizer corruption remains possible.",
            { reliabilityDelta: -2.5, stumbleRisk: 0.055 },
          ),
        ],
      };
    case "routing_imbalance":
      return {
        title: "Expert routing is concentrating",
        description:
          "A small set of experts is receiving most tokens. Specialization may be emerging, or the router may be collapsing.",
        signal: `${(((job.activeParamsB ?? job.targetParamsB) / Math.max(0.01, job.targetParamsB)) * 100).toFixed(1)}% active parameters · ${job.integratedMethods?.includes("moe_balance") ? "load balancing integrated" : "no mature load balancer"}`,
        severity: job.integratedMethods?.includes("moe_balance")
          ? "warning"
          : "critical",
        choices: [
          choice(
            "rebalance-router",
            "Rebalance and replay",
            `Add ${pct(0.04)} compute for router warmup and overflow replay. Safer, but it delays expert specialization.`,
            {
              extraComputeFraction: 0.04,
              capabilityDelta: 0.55,
              reliabilityDelta: 2.5,
              stumbleRisk: -0.06,
            },
            true,
          ),
          choice(
            "overprovision-routing",
            "Overprovision expert capacity",
            `${money(highCost)} for spare expert capacity and communication headroom.`,
            {
              cashCost: highCost,
              reliabilityDelta: 3,
              breakthroughBias: 0.018,
              stumbleRisk: -0.035,
            },
          ),
          choice(
            "allow-specialization",
            "Allow hard specialization",
            "Preserve the emerging experts. Potential capability upside, but overloaded and dead experts remain a serving risk.",
            {
              capabilityDelta: pushDelta,
              reliabilityDelta: -3.5,
              breakthroughBias: 0.04,
              stumbleRisk: 0.07,
            },
          ),
        ],
      };
    case "modality_interference":
      return {
        title: "Modalities are competing",
        description:
          "Text validation is improving while one media domain regresses. Shared capacity has not formed a stable cross-modal bridge.",
        signal: `${Math.round(modalityBalance(job) * 100)}% modality balance · ${(job.modalityComputeMult ?? 1).toFixed(2)}× modality compute`,
        severity: modalityBalance(job) < 0.5 ? "critical" : "warning",
        choices: [
          choice(
            "bridge-curriculum",
            "Run a bridge curriculum",
            `Add ${pct(0.055)} compute for paired text↔media and observation↔outcome batches.`,
            {
              extraComputeFraction: 0.055,
              capabilityDelta: 0.7,
              reliabilityDelta: 2,
              dataQualityDelta: 2,
              stumbleRisk: -0.04,
            },
            true,
          ),
          choice(
            "specialize-modality",
            "Protect the strongest modality",
            "Improve the strongest product surface now, accepting a weaker unified omni model.",
            {
              capabilityDelta: Math.max(0.2, pushDelta * 0.5),
              reliabilityDelta: -1.5,
              stumbleRisk: 0.025,
            },
          ),
          choice(
            "collect-paired-data",
            "Commission paired data",
            `${money(highCost)} for aligned media and tool trajectories, plus ${pct(0.025)} integration compute.`,
            {
              cashCost: highCost,
              extraComputeFraction: 0.025,
              capabilityDelta: 0.9,
              dataQualityDelta: 4,
              reliabilityDelta: 2,
              breakthroughBias: 0.025,
            },
          ),
        ],
      };
    case "recursive_research": {
      const verifiedRoll = rng.next();
      const verifiedGain =
        verifiedRoll < 0.24
          ? 0
          : verifiedRoll < 0.78
            ? rng.range(0.25, 0.7)
            : rng.range(0.7, 1.15);
      return {
        title: "Autonomous research proposals",
        description:
          "Omni agent teams produced candidate training and serving improvements. Only reproducible gains should enter this checkpoint; recursive synthetic evidence can fool the same agents that generated it.",
        signal: `${(job.effectiveDataRatio ?? 0).toFixed(1)} effective tokens/parameter · ${Math.round((1 - (job.synthLqShare ?? 0)) * 100)}% non-LQ corpus · verifier frontier active`,
        severity: "opportunity",
        choices: [
          choice(
            "independent-verification",
            "Fund independent verification",
            `${money(highCost * 2)} and ${pct(0.12)} extra compute for separate agent teams, hidden tests, fresh observations, and replication. A null result is possible.`,
            {
              cashCost: highCost * 2,
              extraComputeFraction: 0.12,
              verifiedRecursiveCapabilityBonus: verifiedGain,
              capabilityDelta: verifiedGain > 0 ? 0.35 : 0,
              reliabilityDelta: 3,
              safetyDelta: 1,
              stumbleRisk: -0.045,
              minResearchers: 32,
            },
            true,
          ),
          choice(
            "rapid-recursion",
            "Run a rapid self-improvement loop",
            `${money(highCost)} and ${pct(0.075)} extra compute. Reuse the proposing agents as judges: cheaper and faster, but it cannot bank a verified blueprint gain and is much easier to reward-hack.`,
            {
              cashCost: highCost,
              extraComputeFraction: 0.075,
              capabilityDelta: rng.next() < 0.38 ? -0.45 : 0.55,
              reliabilityDelta: -2.5,
              safetyDelta: -1.5,
              breakthroughBias: 0.04,
              stumbleRisk: 0.09,
              minResearchers: 24,
            },
          ),
          choice(
            "reject-unverified",
            "Reject the proposals",
            "Bank no gain. Preserve the real-data anchor and wait for stronger verifiers or a fresher experiment set.",
            { reliabilityDelta: 1, stumbleRisk: -0.015 },
          ),
        ],
      };
    }
    case "loss_spike":
    default:
      return {
        title: "Loss spike at scale",
        description:
          "The observed loss moved outside the expected recovery band. The run may recover, but the recipe has not been validated at this scale.",
        signal: `${job.lossHistory?.at(-1)?.loss.toFixed(3) ?? "unmeasured"} observed loss · ${job.outcomeRisk ?? "unknown"} recipe risk`,
        severity: job.outcomeRisk === "high" ? "critical" : "warning",
        choices: [
          choice(
            "stabilize-recipe",
            "Lower the learning rate",
            `Add ${pct(0.04)} compute for a slower schedule and replay from the stable optimizer state.`,
            {
              extraComputeFraction: 0.04,
              reliabilityDelta: 2.5,
              stumbleRisk: -0.055,
            },
            true,
          ),
          choice(
            "diagnostic-sweep",
            "Run a diagnostic sweep",
            `${money(standardCost)} for proxy branches and gradient diagnostics; adds ${pct(0.018)} compute.`,
            {
              cashCost: standardCost,
              extraComputeFraction: 0.018,
              capabilityDelta: 0.35,
              reliabilityDelta: 2,
              breakthroughBias: 0.018,
              stumbleRisk: -0.035,
            },
          ),
          choice(
            "push-through",
            "Push through the spike",
            "Keep the schedule. A recovery can beat forecast; divergence can permanently reduce usable yield.",
            {
              capabilityDelta: pushDelta,
              reliabilityDelta: pushDelta >= 0 ? 0.5 : -3,
              breakthroughBias: 0.05,
              stumbleRisk: 0.075,
            },
          ),
        ],
      };
  }
}

export function crossedTrainingCampaignMilestone(
  job: TrainingJob,
  previousProgress: number,
  nextProgress: number,
): { milestone: number; index: number } | null {
  if (job.pendingCampaignEvent || job.failed || job.postTrain !== "none")
    return null;
  const reached = new Set(job.campaignMilestonesReached ?? []);
  const finalIndex = TRAINING_CAMPAIGN_MILESTONES.length - 1;
  const finalMilestone = TRAINING_CAMPAIGN_MILESTONES[finalIndex]!;
  // A very fast run can cross several checkpoints in one tick. Preserve the
  // earned omni proposal by prioritizing its final gate instead of allowing an
  // earlier generic incident to consume the only at-frontier crossing.
  if (
    canSurfaceRecursiveResearchEvent(job) &&
    !reached.has(finalMilestone) &&
    previousProgress + 1e-9 < finalMilestone &&
    nextProgress + 1e-9 >= finalMilestone
  ) {
    return { milestone: finalMilestone, index: finalIndex };
  }
  for (let index = 0; index < TRAINING_CAMPAIGN_MILESTONES.length; index += 1) {
    const milestone = TRAINING_CAMPAIGN_MILESTONES[index]!;
    if (
      !reached.has(milestone) &&
      previousProgress + 1e-9 < milestone &&
      nextProgress + 1e-9 >= milestone
    ) {
      return { milestone, index };
    }
  }
  return null;
}

export function createTrainingCampaignEvent(
  job: TrainingJob,
  milestone: number,
  milestoneIndex: number,
  day: number,
): TrainingCampaignEvent {
  const kind = weightedKind(job, milestoneIndex);
  const content = eventContent(job, kind, milestoneIndex);
  const latestEvidence = job.benchmarkSnapshots?.at(-1);
  const evidenceAccuracy = Math.max(
    0.25,
    Math.min(
      0.98,
      latestEvidence?.accuracy ?? latestEvidence?.confidence ?? 0.35,
    ),
  );
  // Benchmarks do not reroll the event or improve the model. Better paid
  // evidence makes funded interventions more precisely targeted, producing a
  // modest reliability/risk benefit while the seeded latent event stays fixed.
  const choices = content.choices.map((candidate) =>
    (candidate.effects.cashCost ?? 0) > 0
      ? {
          ...candidate,
          effects: {
            ...candidate.effects,
            reliabilityDelta:
              (candidate.effects.reliabilityDelta ?? 0) +
              evidenceAccuracy * 0.8,
            stumbleRisk:
              (candidate.effects.stumbleRisk ?? 0) - evidenceAccuracy * 0.012,
          },
        }
      : candidate,
  );
  return {
    id: seededId("training-event", job.id, milestoneIndex, kind),
    kind,
    day,
    milestone,
    decisionDeadlineDay: day + 5,
    ...content,
    choices,
    evidenceAccuracy,
  };
}

export function applyTrainingCampaignChoice(
  job: TrainingJob,
  choiceId: string,
  day: number,
  autoResolved = false,
): TrainingJob | null {
  const event = job.pendingCampaignEvent;
  const selected = event?.choices.find(
    (candidate) => candidate.id === choiceId,
  );
  if (!event || !selected) return null;
  if (
    (job.campaignEventHistory ?? []).some(
      (resolved) => resolved.id === event.id && resolved.selectedChoiceId,
    )
  ) {
    return null;
  }
  const effects = selected.effects;
  const before = job.campaignModifiers ?? emptyTrainingCampaignModifiers();
  const recommended = Math.max(1e-9, job.recommendedPfDays ?? job.targetPfDays);
  const extraCompute =
    recommended * Math.max(0, effects.extraComputeFraction ?? 0);
  const rollback = Math.max(
    0,
    Math.min(0.5, effects.progressRollbackFraction ?? 0),
  );
  const resolvedEvent: TrainingCampaignEvent = {
    ...event,
    selectedChoiceId: selected.id,
    resolvedDay: day,
    autoResolved,
  };
  const inheritedVerifiedBonus = boundedVerifiedRecursiveCapabilityBonus(
    job.family,
    before.verifiedRecursiveCapabilityBonus,
  );
  // Only an eligible recursive event may mint new blueprint headroom. This is
  // defensive as well as a generation rule: crafted/stale non-omni events and
  // ordinary campaign choices cannot smuggle the field into a model.
  const earnedVerifiedBonus =
    event.kind === "recursive_research" &&
    selected.id === "independent-verification" &&
    canSurfaceRecursiveResearchEvent(job)
      ? Math.max(0, effects.verifiedRecursiveCapabilityBonus ?? 0)
      : 0;
  return {
    ...job,
    targetPfDays: job.targetPfDays + extraCompute,
    recommendedPfDays: recommended + extraCompute,
    progressPfDays: Math.max(0, job.progressPfDays * (1 - rollback)),
    pendingCampaignEvent: undefined,
    campaignEventHistory: [
      ...(job.campaignEventHistory ?? []),
      resolvedEvent,
    ].slice(-12),
    campaignModifiers: {
      capabilityDelta: before.capabilityDelta + (effects.capabilityDelta ?? 0),
      reliabilityDelta:
        before.reliabilityDelta + (effects.reliabilityDelta ?? 0),
      safetyDelta: before.safetyDelta + (effects.safetyDelta ?? 0),
      breakthroughBias:
        before.breakthroughBias + (effects.breakthroughBias ?? 0),
      stumbleRisk: before.stumbleRisk + (effects.stumbleRisk ?? 0),
      dataQualityDelta:
        before.dataQualityDelta + (effects.dataQualityDelta ?? 0),
      verifiedRecursiveCapabilityBonus: boundedVerifiedRecursiveCapabilityBonus(
        job.family,
        inheritedVerifiedBonus + earnedVerifiedBonus,
      ),
    },
    paused: false,
    stallReason: null,
    awaitingDecision: false,
  };
}

export function recommendedTrainingCampaignChoice(
  event: TrainingCampaignEvent,
): TrainingCampaignChoice {
  return (
    event.choices.find((choice) => choice.recommended) ?? event.choices[0]!
  );
}

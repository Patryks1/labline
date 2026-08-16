import { useState } from "react";
import { useGameStore } from "../../../../store/gameStore";
import type { PostTrainStage, TrainingJob } from "../../../../sim/types";
import {
  canReleaseTrainingJob,
  earlyReleasePenalty,
  trainingMinimumStatus,
  type TrainingResourceAllocation,
} from "../../../../sim/systems/training";
import {
  formatParams,
  fundedTrainingMaturity,
} from "../../../../sim/balance/training";
import { postTrainTargetPfDays } from "../../../../sim/balance/postTraining";
import {
  formatTokens,
  DATA_DOMAINS,
  DATA_DOMAIN_META,
} from "../../../../sim/balance/data";
import { money, num } from "../../format";
import { GameCard, LiveDot, MeterBar, StatRow } from "../../ui/kit";
import { HudButton, HudRange, StatusChip } from "../../ui/HudPrimitives";
import { ResearchUnlockLink } from "../../ui/ResearchUnlockLink";
import {
  TrainingLossChart,
  type TrainingLossCheckpointMarker,
} from "./TrainingLossChart";
import { BenchmarkEntryPoint } from "./BenchmarkEntryPoint";
import { TrainingEvidencePanel } from "./TrainingEvidencePanel";
import type { CheckpointUiRecord } from "./checkpointUi";
import { architectureBlueprintProfile } from "../../../../sim/balance/architectureFrontiers";
import {
  classifyTrainingStatus,
  trainingReleaseDisabledReason,
  trainingRemainingTime,
} from "./trainingPresentation";

type TrainStage = Exclude<PostTrainStage, "none">;

const POST_TRAIN_META: Record<
  TrainStage,
  { feature: string; research?: string; data: string; spike: string }
> = {
  sft: {
    feature: "Instruction following",
    data: "Curated instruction data",
    spike: "+0.2–0.5, then recovery",
  },
  rlhf: {
    feature: "Preference alignment",
    research: "align_rlhf",
    data: "Preference comparisons",
    spike: "+0.3–0.7, then recovery",
  },
  process: {
    feature: "Process reward",
    research: "align_process",
    data: "Step-level judgments",
    spike: "+0.4–0.8, then recovery",
  },
  tools: {
    feature: "Tool use in benchmarks",
    data: "Tool-call trajectories",
    spike: "+0.2–0.6, then recovery",
  },
};

export function ActiveTrainingCard({
  job,
  trainingPoolPf,
  resources,
  jobs,
  unlocked,
  day,
  cash,
  onPriority,
  onPause,
  onCancel,
  onRelease,
  onKeepInternal,
  onBenchmark,
  onSaveCheckpoint,
  onBranchCheckpoint,
  onRecoverFromCheckpoint,
  onSelectPostTrain,
  checkpointMarkers = [],
  checkpointEvidence = [],
  onOpenCheckpointHistory,
}: {
  job: TrainingJob;
  trainingPoolPf: number;
  resources?: TrainingResourceAllocation;
  jobs: TrainingJob[];
  unlocked: string[];
  day: number;
  cash: number;
  onPriority: (jobId: string, priority: number, reservedPf?: number) => void;
  onPause: (jobId: string, paused: boolean) => void;
  onCancel: (jobId: string) => void;
  onRelease: (jobId: string) => void;
  onKeepInternal: (jobId: string) => void;
  onBenchmark: (jobId: string) => void;
  onSaveCheckpoint: (jobId: string) => void;
  onBranchCheckpoint: (jobId: string) => void;
  onRecoverFromCheckpoint: (jobId: string, checkpointId: string) => void;
  checkpointMarkers?: TrainingLossCheckpointMarker[];
  checkpointEvidence?: CheckpointUiRecord[];
  onOpenCheckpointHistory?: () => void;
  onSelectPostTrain: (
    jobId: string,
    stage: Exclude<PostTrainStage, "none">,
  ) => void;
}) {
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [launchConfirm, setLaunchConfirm] = useState(false);
  const resolveTrainingCampaignEvent = useGameStore(
    (s) => s.resolveTrainingCampaignEvent,
  );
  const researcherCount = useGameStore(
    (s) => s.state.player.staff?.researcher ?? 0,
  );
  const dataManifest = useGameStore((s) =>
    s.state.player.data.manifests?.find(
      (manifest) => manifest.id === job.dataManifestId,
    ),
  );
  const dataEvidence = job.dataEvidence ?? dataManifest;
  const blueprint = architectureBlueprintProfile({
    family: job.family,
    backbone: job.backbone,
    verifiedRecursiveCapabilityBonus:
      job.campaignModifiers?.verifiedRecursiveCapabilityBonus,
  });
  const progress =
    job.targetPfDays > 0 ? job.progressPfDays / job.targetPfDays : 0;
  const pct = (Math.max(0, Math.min(1, progress)) * 100).toFixed(2);
  const prioritySum = Math.max(
    1,
    jobs.reduce(
      (sum, candidate) =>
        sum +
        (candidate.paused || candidate.failed
          ? 0
          : (candidate.computePriority ?? 50)),
      0,
    ),
  );
  const allocatedPf = resources
    ? resources.effectivePf
    : job.failed || job.paused
      ? 0
      : trainingPoolPf * ((job.computePriority ?? 50) / prioritySum);
  const { computeDone, etaDays, paceLimited } = trainingRemainingTime({
    targetPfDays: job.targetPfDays,
    progressPfDays: job.progressPfDays,
    allocatedPf,
    minCalendarDays: job.minCalendarDays,
  });
  const currentLoss = job.lossHistory?.at(-1)?.loss;
  const recommended = job.recommendedPfDays ?? job.targetPfDays;
  const recommendedProgress =
    recommended > 0 ? job.progressPfDays / recommended : progress;
  const releaseGate = canReleaseTrainingJob(job);
  const releaseDisabledReason = trainingReleaseDisabledReason(releaseGate);
  const minimum = trainingMinimumStatus(job);
  const earlyPenalty = earlyReleasePenalty(job);
  const economics = job.economics;
  const snapshots = job.benchmarkSnapshots ?? [];
  const done = minimum.completeReady;
  const launchable = minimum.launchReady;
  const checkpointEligible =
    job.progressPfDays > 1e-9 || job.postTrainProgress > 1e-9;
  const recoveryMarker = checkpointMarkers.find(
    (marker) => marker.id === job.failureRecoveryCheckpointId,
  );
  const postTrainingActive =
    job.postTrain !== "none" &&
    job.postTrainProgress + 1e-9 < job.postTrainTarget;
  const investmentMaturity = fundedTrainingMaturity(job);
  const haircutCopy = `Expected haircut at ${pct}% compute: capability ×${earlyPenalty.capabilityMultiplier.toFixed(2)}, benchmarks ×${earlyPenalty.benchmarkMultiplier.toFixed(2)}, reliability ×${earlyPenalty.reliabilityMultiplier.toFixed(2)}.`;
  const {
    diagnosticStall,
    incompatible,
    memoryBlocked,
    powerBlocked,
    ramBlocked,
    statusLabel,
    unstable,
    visuallyBlocked,
  } = classifyTrainingStatus({
    failed: job.failed,
    paused: job.paused,
    stallReason: job.stallReason,
    resources,
    completeReady: minimum.completeReady,
    plateaued: minimum.plateaued,
    launchReady: launchable,
  });
  const statusTone =
    job.failed || memoryBlocked || powerBlocked || incompatible || unstable
      ? "danger"
      : job.paused
        ? "warning"
        : minimum.completeReady
          ? "positive"
          : "warning";
  const optimizing =
    done &&
    !postTrainingActive &&
    !job.paused &&
    !job.pendingCampaignEvent &&
    (job.computePriority ?? 50) > 0 &&
    allocatedPf > 0.05 &&
    !visuallyBlocked;
  const postTrainingLive =
    done &&
    postTrainingActive &&
    !job.paused &&
    !job.pendingCampaignEvent &&
    (job.computePriority ?? 50) > 0 &&
    allocatedPf > 0.05 &&
    !visuallyBlocked;
  const targetCompleteIdle =
    done &&
    !postTrainingActive &&
    !optimizing &&
    !job.failed &&
    !visuallyBlocked &&
    !job.paused &&
    !job.pendingCampaignEvent &&
    ((job.computePriority ?? 50) <= 0 || allocatedPf <= 0.05);
  const fundedContinuationLabel =
    investmentMaturity.fundedRatio < 10
      ? `${investmentMaturity.fundedRatio.toFixed(2)}× funded`
      : `${num(job.progressPfDays)} PF invested · ${
          investmentMaturity.extraSignal >= 0.995
            ? "maturity saturated"
            : `maturity ${(investmentMaturity.extraSignal * 100).toFixed(2)}%`
        }`;
  const displayedStatusLabel = optimizing
    ? `Optimizing · ${fundedContinuationLabel}`
    : targetCompleteIdle
      ? "Target complete · idle"
      : postTrainingLive
        ? `Post-training · ${job.postTrain.toUpperCase()}`
        : postTrainingActive && !job.paused && !visuallyBlocked
          ? "Post-training · idle"
          : statusLabel;
  const etaDetail =
    etaDays === Infinity
      ? "stalled"
      : computeDone
        ? optimizing
          ? `${fundedContinuationLabel} · optimizing`
          : postTrainingLive
            ? "base target complete · post-training active"
            : postTrainingActive && !job.paused
              ? "base target complete · post-training idle"
              : targetCompleteIdle
                ? "target complete · idle"
                : job.paused
                  ? "target complete · paused"
                  : "target complete"
        : `~${etaDays.toFixed(0)}d left${paceLimited ? " · data pipeline capped" : ""}`;
  const modeLabel =
    job.mode === "distill"
      ? `Distill · teacher ${((job.distillTeacherShare ?? 0.72) * 100).toFixed(2)}%`
      : job.mode === "continue"
        ? "Continuation"
        : "Pretrain";
  const jobWithEnergy = job as TrainingJob & {
    energyMWh?: number;
    cumulativeMWh?: number;
    energyMwDays?: number;
    mwDays?: number;
    powerMw?: number;
    trainingPowerMw?: number;
  };
  const directMWh = jobWithEnergy.energyMWh ?? jobWithEnergy.cumulativeMWh;
  const directMwDays = jobWithEnergy.energyMwDays ?? jobWithEnergy.mwDays;
  const powerMw = jobWithEnergy.trainingPowerMw ?? jobWithEnergy.powerMw;
  const estimatedMwDays =
    powerMw != null
      ? Math.max(0, powerMw) * Math.max(0, job.daysElapsed ?? 0)
      : undefined;
  const chartMwDays =
    directMwDays ?? (directMWh != null ? directMWh / 24 : estimatedMwDays);
  const chartMWh =
    directMWh ?? (chartMwDays != null ? chartMwDays * 24 : undefined);
  const energyEstimated =
    directMWh == null && directMwDays == null && chartMWh != null;
  const stageHistory = new Set(
    (job.lossHistory ?? [])
      .filter((point) => point.stage !== "base")
      .map((point) => point.stage as TrainStage),
  );

  return (
    <GameCard
      eyebrow="Live training"
      title={
        <span className="flex items-center gap-2">
          <LiveDot
            className={
              job.failed || visuallyBlocked
                ? "text-danger"
                : job.paused
                  ? "text-amber"
                  : "text-train"
            }
          />
          <span className="truncate">{job.name}</span>
        </span>
      }
      tone={job.failed || visuallyBlocked ? "danger" : "train"}
      /* The live dot and progress meter already communicate activity. Keep the
         card boundary static so pointer hover/inspection never appears to
         expand and contract with the old pulsing box shadow. */
      live={false}
      className="models-active-training-card"
      actions={
        <div className="flex items-center gap-1.5">
          <StatusChip tone={statusTone}>{displayedStatusLabel}</StatusChip>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[0.8125rem] text-muted">
            {modeLabel} · {job.family}
            {job.family === "moe"
              ? ` · ${formatParams(job.targetParamsB)} / ${formatParams(job.activeParamsB ?? 0)} active`
              : ` · ${formatParams(job.targetParamsB)}`}
          </p>
          <div className="text-right font-mono text-[0.75rem] tabular-nums">
            <p className="text-train">
              {num(allocatedPf)} PF/d · priority {job.computePriority ?? 50}
            </p>
            {resources ? (
              <>
                <p
                  className={
                    resources.bottleneck === "none"
                      ? "text-muted"
                      : "text-danger"
                  }
                >
                  HBM {num(resources.ramAllocatedGb)} /{" "}
                  {num(resources.ramRequiredGb)} GB · host RAM{" "}
                  {num(resources.systemRamAllocatedGb)} /{" "}
                  {num(resources.systemRamRequiredGb)} GB
                </p>
                <p
                  className={
                    resources.bottleneck === "none"
                      ? "text-muted"
                      : "text-danger"
                  }
                >
                  Bottleneck:{" "}
                  {resources.bottleneck === "none"
                    ? "none"
                    : resources.bottleneck.replace("_", " ")}
                </p>
              </>
            ) : null}
          </div>
        </div>

        <MeterBar
          label="Progress"
          value={progress}
          detail={
            done
              ? `${etaDetail} · ${num(job.progressPfDays)} / ${num(job.recommendedPfDays ?? job.targetPfDays)} PF funded`
              : `${pct}% · ${etaDetail} · ${num(Math.max(0, job.targetPfDays - job.progressPfDays))} PF remaining`
          }
          tone="train"
          live={
            !job.failed &&
            !job.paused &&
            (!done || optimizing || postTrainingLive) &&
            !ramBlocked
          }
        />

        <div className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-3">
          <StatRow
            label="Loss"
            value={currentLoss == null ? "—" : currentLoss.toFixed(2)}
            strong
          />
          <StatRow
            label="Data"
            value={formatTokens(
              job.trainMTok + job.verifyMTok ||
                job.dataPlan?.totalMTok ||
                job.dataPlan?.totalUnits ||
                0,
            )}
          />
          <StatRow
            label="Burn"
            value={job.cashBurnPerDay ? `${money(job.cashBurnPerDay)}/d` : "—"}
            tone="warning"
          />
        </div>

        <details className="group rounded-md border border-line/50 bg-void/25">
          <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-2.5 py-2 marker:hidden">
            <span className="hud-eyebrow">{blueprint.label} frontier</span>
            <span className="inline-flex items-center gap-2 font-mono text-[0.6875rem] tabular-nums text-bone">
              cap {blueprint.pretrainingCapabilityCap}
              <span
                aria-hidden="true"
                className="text-muted transition-transform group-open:rotate-180"
              >
                ⌄
              </span>
            </span>
          </summary>
          <div className="border-t border-line/40 px-2.5 pb-2.5 pt-2">
            {blueprint.id === "omni" ? (
              <p className="font-mono text-[0.625rem] text-research">
                Verified recursive ceiling{" "}
                {blueprint.verifiedRecursiveCapabilityCap}
              </p>
            ) : null}
            <p className="mt-1 text-[0.6875rem] leading-5 text-muted">
              {blueprint.advantages[0]} · {blueprint.constraints[0]}
            </p>
            <p className="font-mono text-[0.625rem] leading-5 text-muted">
              {blueprint.dataDemandMultiplier.toFixed(2)}× data breadth ·{" "}
              {blueprint.outputTokenDemandMultiplier.toFixed(2)}× frontier
              output burden · {blueprint.trainingStability} stability
            </p>
          </div>
        </details>

        {job.failed ? (
          <div className="rounded-md border border-danger/35 bg-danger/10 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <strong className="text-[0.8125rem] text-danger">
                {job.failureStage === "base"
                  ? "Base training failed"
                  : `${job.failureStage?.toUpperCase()} failed`}
              </strong>
              <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
                Day {job.failureDay ?? day}
              </span>
            </div>
            <p className="mt-1 text-[0.75rem] text-muted">
              {job.failureReason}
            </p>
            {job.failureRecord ? (
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatRow
                  label="Frozen risk"
                  value={`${(job.failureRecord.probability * 100).toFixed(2)}% · ${job.failureRecord.riskBand}`}
                />
                <StatRow
                  label="Failed at"
                  value={`${(job.failureRecord.stageProgress * 100).toFixed(2)}%`}
                />
                <StatRow
                  label="Recovery"
                  value={recoveryMarker?.label ?? "No checkpoint"}
                />
                <StatRow label="Refund" value="None" />
              </div>
            ) : null}
            {(job.failureRecord?.factors.length ?? 0) > 0 ? (
              <p className="mt-2 font-mono text-[0.625rem] leading-5 text-danger/80">
                Factors · {job.failureRecord!.factors.join(" · ")}
              </p>
            ) : null}
          </div>
        ) : null}

        {job.pendingCampaignEvent ? (
          <div
            className={`rounded-md border p-3 ${
              job.pendingCampaignEvent.severity === "opportunity"
                ? "border-research/45 bg-research/10"
                : job.pendingCampaignEvent.severity === "critical"
                  ? "border-danger/45 bg-danger/10"
                  : "border-amber/45 bg-amber/10"
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="hud-eyebrow">
                  Campaign decision ·{" "}
                  {(job.pendingCampaignEvent.milestone * 100).toFixed(2)}%
                  checkpoint
                </p>
                <strong className="mt-1 block text-[0.875rem] text-bone">
                  {job.pendingCampaignEvent.title}
                </strong>
              </div>
              <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
                Auto-resolves D{job.pendingCampaignEvent.decisionDeadlineDay}
              </span>
            </div>
            <p className="mt-1.5 text-[0.75rem] leading-5 text-bone">
              {job.pendingCampaignEvent.description}
            </p>
            <p className="mt-1 font-mono text-[0.6875rem] leading-5 text-muted">
              Signal: {job.pendingCampaignEvent.signal}
            </p>
            <p className="mt-1 font-mono text-[0.625rem] leading-5 text-muted">
              Decision evidence{" "}
              {(
                (job.pendingCampaignEvent.evidenceAccuracy ?? 0.35) * 100
              ).toFixed(2)}
              %
              {job.benchmarkSnapshots?.length
                ? " · paid checkpoint measurements improve interventions without rerolling the run"
                : " · evaluate a retained checkpoint to improve intervention precision"}
            </p>
            <div className="mt-2.5 grid grid-cols-1 gap-2 lg:grid-cols-3">
              {job.pendingCampaignEvent.choices.map((choice) => {
                const cost = choice.effects.cashCost ?? 0;
                const researchersRequired = choice.effects.minResearchers ?? 0;
                const disabled =
                  cash + 1e-9 < cost || researcherCount < researchersRequired;
                return (
                  <button
                    key={choice.id}
                    type="button"
                    disabled={disabled}
                    title={
                      cash + 1e-9 < cost
                        ? `Need ${money(cost)}.`
                        : researcherCount < researchersRequired
                          ? `Need ${researchersRequired} researchers.`
                          : undefined
                    }
                    onClick={() =>
                      resolveTrainingCampaignEvent(job.id, choice.id)
                    }
                    className="rounded-md border border-line/60 bg-void/35 p-2.5 text-left transition hover:border-train/60 hover:bg-train/5 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <strong className="text-[0.75rem] text-bone">
                        {choice.label}
                      </strong>
                      {choice.recommended ? (
                        <span className="font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-train">
                          recommended
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-1 block text-[0.6875rem] leading-5 text-muted">
                      {choice.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {(job.campaignEventHistory?.length ?? 0) > 0 ? (
          <details className="group rounded-md border border-line/50 bg-void/25">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 marker:hidden">
              <span className="hud-eyebrow">Campaign log</span>
              <span className="font-mono text-[0.625rem] text-muted">
                {job.campaignEventHistory!.length} decisions · details
              </span>
            </summary>
            <div className="space-y-1 border-t border-line/40 px-2.5 pb-2.5 pt-2">
              {job.campaignEventHistory!.slice(-3).map((event) => {
                const selected = event.choices.find(
                  (choice) => choice.id === event.selectedChoiceId,
                );
                return (
                  <div
                    key={event.id}
                    className="flex items-start justify-between gap-3 text-[0.6875rem] leading-5"
                  >
                    <span className="text-muted">
                      D{event.day} · {event.title}
                    </span>
                    <span className="text-right text-bone">
                      {selected?.label ?? "Resolved"}
                      {event.autoResolved ? " · auto" : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </details>
        ) : null}

        <TrainingEvidencePanel
          job={job}
          checkpoints={checkpointEvidence}
          onOpenCheckpointHistory={onOpenCheckpointHistory}
        />

        {diagnosticStall ? (
          <p className="text-[0.75rem] text-amber">{diagnosticStall}</p>
        ) : null}
        {ramBlocked && !job.stallReason ? (
          <p className="text-[0.75rem] text-danger">
            Training RAM is a hard limit. Raise Training allocation, add memory,
            or pause another run.
          </p>
        ) : null}

        {job.dataPlan ? (
          <p className="truncate text-[0.75rem] text-muted">
            Mix:{" "}
            {DATA_DOMAINS.filter((d) => (job.dataPlan!.weights[d] ?? 0) >= 0.05)
              .map(
                (d) =>
                  `${DATA_DOMAIN_META[d].label} ${((job.dataPlan!.weights[d] ?? 0) * 100).toFixed(2)}%`,
              )
              .join(" · ")}
          </p>
        ) : null}

        {dataEvidence ? (
          <details className="group rounded-md border border-line/50 bg-void/25">
            <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-2.5 py-2 marker:hidden">
              <span className="hud-eyebrow">Frozen corpus evidence</span>
              <span className="font-mono text-[0.625rem] text-muted">
                {dataManifest
                  ? `${dataManifest.assetIds.length} source asset${dataManifest.assetIds.length === 1 ? "" : "s"}`
                  : "immutable run snapshot"}
              </span>
            </summary>
            <div className="border-t border-line/40 px-2.5 pb-2.5 pt-2">
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
                <StatRow
                  label="Unique"
                  value={formatTokens(
                    dataManifest?.uniqueMTok ?? job.trainMTok,
                  )}
                />
                <StatRow
                  label="Repeated"
                  value={formatTokens(dataManifest?.repeatedMTok ?? 0)}
                />
                <StatRow
                  label="Learnable value"
                  value={`${((dataEvidence.effectiveTrainingValue ?? 0) * 100).toFixed(2)}%`}
                />
                <StatRow
                  label="Diversity"
                  value={`${((dataEvidence.effectiveDiversity ?? 0) * 100).toFixed(2)}%`}
                />
                <StatRow
                  label="Freshness"
                  value={`${((dataEvidence.effectiveFreshness ?? 0) * 100).toFixed(2)}%`}
                />
                <StatRow
                  label="Human anchor"
                  value={`${((dataEvidence.humanAnchorShare ?? 1) * 100).toFixed(2)}%`}
                />
              </div>
              <p className="mt-2 font-mono text-[0.625rem] leading-5 text-muted">
                Contamination{" "}
                {(dataEvidence.contaminationRisk * 100).toFixed(2)}% · rights
                exposure {((dataEvidence.rightsRisk ?? 0) * 100).toFixed(2)}% ·
                synthetic{" "}
                {((dataEvidence.syntheticShare ?? 0) * 100).toFixed(2)}%
                {(dataEvidence.syntheticGenerationDepth ?? 0) > 0
                  ? ` at ${dataEvidence.syntheticGenerationDepth!.toFixed(2)} generation depth`
                  : ""}
              </p>
            </div>
          </details>
        ) : null}

        {job.postTrain !== "none" ? (
          <MeterBar
            label={`Post-train: ${job.postTrain}`}
            value={
              job.postTrainTarget > 0
                ? job.postTrainProgress / job.postTrainTarget
                : 0
            }
            detail={`${num(job.postTrainProgress)} / ${num(job.postTrainTarget)} PF`}
            tone="research"
          />
        ) : null}

        {economics || snapshots.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {economics ? (
              <>
                <StatRow label="Setup" value={money(economics.setupCost)} />
                <StatRow label="Data" value={money(economics.dataCost)} />
                <StatRow
                  label="Training"
                  value={money(economics.trainingCostAccrued)}
                  tone="warning"
                />
              </>
            ) : null}
            <StatRow
              label="Recommended"
              value={`${Math.min(100, recommendedProgress * 100).toFixed(2)}%`}
            />
          </div>
        ) : null}

        <TrainingLossChart
          history={job.lossHistory ?? []}
          failed={job.failed ?? false}
          energyMWh={chartMWh}
          mwDays={chartMwDays}
          energyEstimated={energyEstimated}
          benchmarks={snapshots}
          checkpoints={checkpointMarkers}
        />

        {!job.failed ? (
          <label className="block text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
            Compute priority · {job.computePriority ?? 50}/100
            <HudRange
              type="range"
              min={0}
              max={100}
              step={5}
              value={job.computePriority ?? 50}
              onChange={(event) =>
                onPriority(job.id, Number(event.target.value), job.reservedPf)
              }
              className="mt-1"
            />
          </label>
        ) : null}

        <div className="sticky bottom-0 z-20 -mx-3 grid grid-cols-2 gap-2 border-y border-line/60 bg-panel-2/95 px-3 py-2 shadow-[0_-0.5rem_1.5rem_rgba(0,0,0,0.25)] backdrop-blur-md sm:static sm:z-auto sm:mx-0 sm:flex sm:flex-wrap sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none sm:backdrop-blur-none">
          {job.failed ? (
            <>
              {job.failureRecoveryCheckpointId ? (
                <HudButton
                  variant="primary"
                  onClick={() =>
                    onRecoverFromCheckpoint(
                      job.id,
                      job.failureRecoveryCheckpointId!,
                    )
                  }
                >
                  Recover from {recoveryMarker?.label ?? "checkpoint"}
                </HudButton>
              ) : null}
              <HudButton variant="danger" onClick={() => onCancel(job.id)}>
                Delete failed run
              </HudButton>
            </>
          ) : done ? (
            <>
              {minimum.completeReady ? (
                <HudButton
                  variant="primary"
                  disabled={!releaseGate.ok}
                  title={releaseDisabledReason}
                  onClick={() => onRelease(job.id)}
                >
                  Release
                </HudButton>
              ) : (
                <HudButton
                  variant="primary"
                  disabled={!releaseGate.ok}
                  title={releaseDisabledReason ?? haircutCopy}
                  onClick={() => {
                    if (!launchConfirm) {
                      setLaunchConfirm(true);
                      return;
                    }
                    setLaunchConfirm(false);
                    onRelease(job.id);
                  }}
                >
                  {launchConfirm ? "Confirm launch" : "Launch now"}
                </HudButton>
              )}
              <HudButton onClick={() => onKeepInternal(job.id)}>
                Keep internal
              </HudButton>
              <BenchmarkEntryPoint
                context={{ kind: "training-run", id: job.id }}
                icon={false}
                disabled={!checkpointEligible}
                title={
                  checkpointEligible
                    ? "Capture these exact weights, then choose benchmark suites and measurement spend."
                    : "Allocate compute before benchmarking current weights."
                }
                onOpen={() => onBenchmark(job.id)}
              >
                Benchmark
              </BenchmarkEntryPoint>
              <HudButton
                disabled={!checkpointEligible}
                title={
                  checkpointEligible
                    ? "Save immutable current weights without stopping training."
                    : "Allocate compute before saving a checkpoint."
                }
                onClick={() => onSaveCheckpoint(job.id)}
              >
                Save checkpoint
              </HudButton>
              <HudButton
                variant="secondary"
                disabled={!checkpointEligible}
                title={
                  checkpointEligible
                    ? "Save these exact weights and configure a separate child model while this run continues."
                    : "Allocate compute before branching from the current weights."
                }
                onClick={() => onBranchCheckpoint(job.id)}
              >
                Branch model
              </HudButton>
              <HudButton
                variant="danger"
                onClick={() => {
                  if (cancelConfirm) onCancel(job.id);
                  else setCancelConfirm(true);
                }}
              >
                {cancelConfirm ? "Confirm delete" : "Delete run"}
              </HudButton>
              {!minimum.completeReady && launchable ? (
                <p className="col-span-2 basis-full text-[0.75rem] text-amber">
                  {haircutCopy}
                </p>
              ) : releaseDisabledReason ? (
                <p className="col-span-2 basis-full text-[0.75rem] text-amber">
                  {releaseDisabledReason}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <HudButton onClick={() => onPause(job.id, !job.paused)}>
                {job.paused ? "Resume" : "Pause"}
              </HudButton>
              <BenchmarkEntryPoint
                context={{ kind: "training-run", id: job.id }}
                icon={false}
                disabled={!checkpointEligible}
                title={
                  checkpointEligible
                    ? "Capture these exact weights, then choose benchmark suites and measurement spend."
                    : "Allocate compute before benchmarking current weights."
                }
                onOpen={() => onBenchmark(job.id)}
              >
                Benchmark
              </BenchmarkEntryPoint>
              <HudButton
                disabled={!checkpointEligible}
                title={
                  checkpointEligible
                    ? "Save immutable current weights without stopping training."
                    : "Allocate compute before saving a checkpoint."
                }
                onClick={() => onSaveCheckpoint(job.id)}
              >
                Save checkpoint
              </HudButton>
              <HudButton
                variant="secondary"
                disabled={!checkpointEligible}
                title={
                  checkpointEligible
                    ? "Save these exact weights and configure a separate child model while this run continues."
                    : "Allocate compute before branching from the current weights."
                }
                onClick={() => onBranchCheckpoint(job.id)}
              >
                Branch model
              </HudButton>
              <HudButton
                variant="primary"
                disabled={
                  !launchable ||
                  !releaseGate.ok ||
                  job.pendingCampaignEvent != null
                }
                title={
                  !launchable
                    ? (releaseDisabledReason ??
                      "Train at least 5% before launching.")
                    : haircutCopy
                }
                onClick={() => {
                  if (!launchConfirm) {
                    setLaunchConfirm(true);
                    return;
                  }
                  setLaunchConfirm(false);
                  onRelease(job.id);
                }}
              >
                {launchConfirm ? "Confirm launch" : "Launch now"}
              </HudButton>
              <HudButton
                variant="danger"
                onClick={() => {
                  if (cancelConfirm) onCancel(job.id);
                  else setCancelConfirm(true);
                }}
              >
                {cancelConfirm ? "Confirm cancel" : "Cancel"}
              </HudButton>
              {launchable ? (
                <p className="col-span-2 basis-full text-[0.75rem] text-amber">
                  {haircutCopy}
                </p>
              ) : releaseDisabledReason ? (
                <p className="col-span-2 basis-full text-[0.75rem] text-muted">
                  Launch locked: {releaseDisabledReason}
                </p>
              ) : null}
            </>
          )}
        </div>

        {done ? (
          <div className="rounded-md border border-research/25 bg-research/5 p-2.5">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[0.8125rem] font-semibold text-bone">
                Optional post-training
              </span>
              <span className="font-mono text-[0.6875rem] text-muted">
                choose next stage
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(Object.keys(POST_TRAIN_META) as TrainStage[]).map((stage) => {
                const meta = POST_TRAIN_META[stage];
                const locked = Boolean(
                  meta.research && !unlocked.includes(meta.research),
                );
                const currentStageIncomplete =
                  job.postTrain !== "none" &&
                  job.postTrainProgress < job.postTrainTarget;
                const busy = currentStageIncomplete;
                const applied =
                  (stageHistory.has(stage) && job.postTrain !== stage) ||
                  (job.postTrainStagesCompletedThisRun ?? []).includes(stage) ||
                  (job.postTrain === stage && !currentStageIncomplete);
                const stageTarget = postTrainTargetPfDays(
                  job,
                  stage,
                  job.targetParamsB,
                );
                const lockReason = applied
                  ? "Already applied in this version. Continue-train a new version to refresh it with diminishing returns."
                  : locked
                    ? `Research ${meta.research} required.`
                    : busy
                      ? `${job.postTrain.toUpperCase()} is already in progress.`
                      : undefined;
                const stateLabel = applied
                  ? "done"
                  : locked
                    ? "locked"
                    : busy
                      ? "busy"
                      : "available";
                return (
                  <button
                    key={stage}
                    type="button"
                    disabled={applied || locked || busy}
                    title={lockReason}
                    onClick={() => onSelectPostTrain(job.id, stage)}
                    className={`rounded-md border p-2.5 text-left disabled:cursor-not-allowed disabled:opacity-55 ${
                      job.postTrain === stage
                        ? "border-research bg-research/20 text-research"
                        : "border-line text-muted"
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <strong className="text-[0.75rem] uppercase tracking-[0.12em] text-bone">
                        {stage}
                      </strong>
                      <span className="font-mono text-[0.625rem] uppercase tracking-[0.1em]">
                        {stateLabel}
                      </span>
                    </span>
                    <span className="mt-1 block text-[0.75rem] text-bone">
                      Gains: {meta.feature}
                    </span>
                    <span className="mt-1 block font-mono text-[0.6875rem] leading-5">
                      {meta.data} · {num(stageTarget, 0)} PF target
                    </span>
                    <span className="block text-[0.6875rem]">
                      Expected loss spike {meta.spike}
                    </span>
                    {lockReason ? (
                      <span className="mt-1 block text-[0.6875rem] text-amber">
                        {lockReason}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {job.postTrain === "sft" && !unlocked.includes("align_rlhf") ? (
              <ResearchUnlockLink
                className="mt-2"
                nodeId="align_rlhf"
                label="Unlock RLHF Pipeline for the next post-train stage"
              />
            ) : null}
            {job.postTrain === "rlhf" && !unlocked.includes("align_process") ? (
              <ResearchUnlockLink
                className="mt-2"
                nodeId="align_process"
                label="Unlock Process Reward Models for the next stage"
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </GameCard>
  );
}

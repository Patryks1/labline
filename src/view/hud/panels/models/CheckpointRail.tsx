import { useEffect, useRef, useState } from "react";
import {
  ArrowCircleUp,
  ArrowCounterClockwise,
  EyeSlash,
  GitFork,
  ShieldCheck,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import {
  EmptyState,
  HudButton,
  StatusChip,
} from "../../ui/HudPrimitives";
import { money } from "../../format";
import { BenchmarkEntryPoint } from "./BenchmarkEntryPoint";
import {
  checkpointRivalDelta,
  checkpointReviewModeLabel,
  checkpointStatusLabel,
  checkpointStatusTone,
  confidenceLabel,
  formatBenchmarkInterval,
  visibilityLabel,
  type CheckpointActionGate,
  type CheckpointBranchDirection,
  type CheckpointUiRecord,
} from "./checkpointUi";
import { checkpointBranchDirectionLabel } from "./checkpointBranching";

import { HudDesktopDefaultDetails } from "../../ui/HudDesktopDefaultDetails";

function clampedPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

function actionTitle(gate: CheckpointActionGate): string | undefined {
  return gate.enabled ? undefined : gate.reason;
}

export function CheckpointRail({
  checkpoints,
  selectedId,
  onSelect,
  onBenchmark,
  onReview,
  onPromote,
  onDiscard,
  onBranch,
  onRollback,
  jobs = [],
  title = "Weight files",
  className = "",
}: {
  checkpoints: CheckpointUiRecord[];
  selectedId?: string;
  onSelect?: (checkpointId: string) => void;
  onBenchmark?: (checkpointId: string) => void;
  onReview?: (checkpointId: string) => void;
  onPromote?: (checkpointId: string) => void;
  onDiscard?: (checkpointId: string) => void;
  onBranch?: (checkpointId: string) => void;
  onRollback?: (request: { jobId: string; checkpointId: string }) => void;
  jobs?: Array<{
    id: string;
    name: string;
    progressPfDays: number;
    targetPfDays: number;
    parentCheckpointId?: string;
    branchDirection?: CheckpointBranchDirection;
    paused?: boolean;
    failed?: boolean;
  }>;
  title?: string;
  className?: string;
}) {
  const [localSelectedId, setLocalSelectedId] = useState(
    () => selectedId ?? checkpoints.at(-1)?.id,
  );
  const [discardConfirmId, setDiscardConfirmId] = useState<string | null>(null);
  const [rollbackConfirmId, setRollbackConfirmId] = useState<string | null>(null);
  const historyRef = useRef<HTMLOListElement>(null);
  const activeId = selectedId ?? localSelectedId;
  const selected =
    checkpoints.find((checkpoint) => checkpoint.id === activeId) ??
    checkpoints.at(-1);

  useEffect(() => {
    const history = historyRef.current;
    const active = history?.querySelector<HTMLElement>(
      '[aria-pressed="true"]',
    );
    const item = active?.closest<HTMLElement>("li");
    if (!history || !item) return;
    const left = item.offsetLeft;
    const right = left + item.offsetWidth;
    const visibleLeft = history.scrollLeft;
    const visibleRight = visibleLeft + history.clientWidth;
    const nextLeft =
      left < visibleLeft
        ? Math.max(0, left - 8)
        : right > visibleRight
          ? right - history.clientWidth + 8
          : visibleLeft;
    if (nextLeft !== visibleLeft) {
      history.scrollTo?.({ left: nextLeft, behavior: "smooth" });
    }
  }, [activeId]);

  if (!selected) {
    return (
      <EmptyState
        title="No retained checkpoints"
        description="Training milestones will appear here when a reusable checkpoint is saved."
      />
    );
  }

  const confidencePct = clampedPercent(selected.confidence);
  const evaluationEstimate = selected.evaluationScore.estimate;
  const evaluationLow = selected.evaluationScore.low ?? evaluationEstimate;
  const evaluationHigh = selected.evaluationScore.high ?? evaluationEstimate;
  const rivalDelta = selected.benchmark
    ? checkpointRivalDelta(selected.benchmark)
    : null;
  const review = selected.review;
  const externalReview = review?.mode != null && review.mode !== "internal";
  const leakRisk = clampedPercent(review?.leakRisk ?? 0);
  const choose = (checkpointId: string) => {
    setLocalSelectedId(checkpointId);
    setDiscardConfirmId(null);
    setRollbackConfirmId(null);
    onSelect?.(checkpointId);
  };
  const branchJobs = jobs.filter(
    (job) => job.parentCheckpointId === selected.id,
  );

  return (
    <section
      aria-labelledby={`checkpoint-rail-${selected.id}`}
      className={`rounded-lg border border-line/70 bg-panel-2/55 p-3 ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="hud-eyebrow">Training branches</p>
          <h3
            id={`checkpoint-rail-${selected.id}`}
            className="mt-1 text-sm font-semibold text-bone"
          >
            {title}
          </h3>
          <p className="hud-mobile-detail mt-1 text-[0.6875rem] leading-5 text-muted">
            A checkpoint is a saved copy of one run at a specific moment. Pick
            one to compare, keep in Fleet, or use as the start of a separate
            child model.
          </p>
        </div>
        <StatusChip
          tone={selected.visibility === "public" ? "positive" : "neutral"}
        >
          {visibilityLabel(selected.visibility)}
        </StatusChip>
      </div>

      <ol
        ref={historyRef}
        aria-label="Checkpoint history"
        className="panel-scroll relative mt-3 flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain pb-1 touch-auto before:absolute before:left-4 before:right-4 before:top-4 before:h-px before:bg-line/70"
        data-mobile-scroll="horizontal"
      >
        {checkpoints.map((checkpoint, index) => {
          const active = checkpoint.id === selected.id;
          const progress = clampedPercent(checkpoint.progress);
          return (
            <li
              key={checkpoint.id}
              className="relative min-w-[10.5rem] flex-1 snap-start pt-3"
            >
              <HudButton
                type="button"
                variant="ghost"
                aria-pressed={active}
                aria-label={`Select ${checkpoint.label}, ${checkpointStatusLabel(checkpoint.status)}`}
                onClick={() => choose(checkpoint.id)}
                className={`!h-full !min-h-11 !w-full !justify-start !rounded-md !border !p-2.5 !text-left !font-normal !normal-case !tracking-normal !text-bone transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/45 ${
                  active
                    ? "!border-mint/55 !bg-mint/10"
                    : "!border-line/60 !bg-void/30 hover:!border-line hover:!bg-panel-2"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`absolute left-3 top-1.5 h-2.5 w-2.5 rounded-full border-2 ${
                    active
                      ? "border-mint bg-mint"
                      : "border-line bg-panel-2"
                  }`}
                />
                <span className="flex items-start justify-between gap-2">
                  <span className="font-mono text-[0.625rem] uppercase tracking-[0.11em] text-muted">
                    CP-{String(index + 1).padStart(2, "0")} · D{checkpoint.day}
                  </span>
                  <span
                    aria-hidden
                    className={`mt-1 h-1.5 w-1.5 rounded-full ${
                      checkpoint.status === "discarded"
                        ? "bg-danger"
                        : checkpoint.status === "promoted"
                          ? "bg-mint"
                          : checkpoint.status === "evaluating"
                            ? "bg-research"
                            : "bg-train"
                    }`}
                  />
                </span>
                <strong className="mt-1 block truncate text-[0.75rem] text-bone">
                  {checkpoint.label}
                </strong>
                <span className="mt-0.5 block truncate font-mono text-[0.5625rem] uppercase tracking-[0.09em] text-muted">
                  {checkpoint.kind}
                  {checkpoint.branchDirection
                    ? ` · ${checkpoint.branchDirection}`
                    : ""}
                </span>
                <span className="mt-1 flex items-center justify-between gap-2 font-mono text-[0.625rem] tabular-nums text-muted">
                  <span>{checkpointStatusLabel(checkpoint.status)}</span>
                  <span>{progress}%</span>
                </span>
                <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-line/45">
                  <span
                    className="block h-full rounded-full bg-train"
                    style={{ width: `${progress}%` }}
                  />
                </span>
              </HudButton>
            </li>
          );
        })}
      </ol>

      <section
        aria-label={`Branches from ${selected.label}`}
        className="mt-3 rounded-md border border-research/30 bg-research/5 p-2.5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="hud-eyebrow text-research">Model branches</p>
            <p className="mt-0.5 text-[0.6875rem] leading-5 text-muted">
              Each child starts from these weights while the source run keeps
              training on its original path.
            </p>
          </div>
          <HudButton
            type="button"
            variant="primary"
            disabled={!selected.actions.fork.enabled}
            title={actionTitle(selected.actions.fork)}
            aria-label={`Branch a new model from ${selected.label}`}
            onClick={() => onBranch?.(selected.id)}
          >
            <GitFork size="0.875rem" weight="bold" />
            Branch new model
          </HudButton>
        </div>
        {branchJobs.length > 0 ? (
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
            {branchJobs.map((job) => {
              const progress = Math.round(
                Math.max(
                  0,
                  Math.min(
                    1,
                    job.progressPfDays / Math.max(1e-9, job.targetPfDays),
                  ),
                ) * 100,
              );
              const status = job.failed
                ? "Failed"
                : job.paused
                  ? "Paused"
                  : "Training";
              return (
                <li
                  key={job.id}
                  className="rounded-md border border-line/55 bg-void/30 p-2"
                >
                  <span className="flex items-center justify-between gap-2">
                    <strong className="min-w-0 truncate text-[0.75rem] text-bone">
                      {job.name}
                    </strong>
                    <span className="font-mono text-[0.5625rem] uppercase text-research">
                      {checkpointBranchDirectionLabel(
                        job.branchDirection ?? "general",
                      )}
                    </span>
                  </span>
                  <span className="mt-1 flex items-center justify-between gap-2 font-mono text-[0.625rem] tabular-nums text-muted">
                    <span>{status}</span>
                    <span>{progress}%</span>
                  </span>
                  <span className="mt-1 block h-1 overflow-hidden rounded-full bg-line/45">
                    <span
                      className="block h-full rounded-full bg-research"
                      style={{ width: `${progress}%` }}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-[0.625rem] leading-4 text-muted">
            No child models yet. Branching keeps this checkpoint immutable and
            adds a separate run to Training Activity.
          </p>
        )}
      </section>

      <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,0.9fr)_minmax(19rem,1.1fr)]">
        <div className="space-y-3 rounded-md border border-line/60 bg-void/30 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="hud-eyebrow">Selected checkpoint</p>
              <strong className="mt-1 block text-[0.875rem] text-bone">
                {selected.label}
              </strong>
              <p className="mt-1 font-mono text-[0.625rem] uppercase tracking-[0.11em] text-muted">
                {selected.stage} · day {selected.day} ·{" "}
                {clampedPercent(selected.progress)}% run progress
              </p>
            </div>
            <StatusChip tone={checkpointStatusTone(selected.status)}>
              {checkpointStatusLabel(selected.status)}
            </StatusChip>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div>
              <span className="block text-[0.625rem] uppercase tracking-[0.11em] text-muted">
                Evaluation score
              </span>
              <strong className="font-mono text-base tabular-nums text-bone">
                {evaluationEstimate == null
                  ? "Unknown"
                  : evaluationEstimate.toFixed(1)}
              </strong>
              <span className="block font-mono text-[0.625rem] tabular-nums text-muted">
                {evaluationLow == null || evaluationHigh == null
                  ? "private eval required"
                  : `${evaluationLow.toFixed(1)}–${evaluationHigh.toFixed(1)}`}
              </span>
              {selected.evaluationScore.label ? (
                <span className="block truncate text-[0.625rem] text-muted">
                  {selected.evaluationScore.label}
                </span>
              ) : null}
            </div>
            <div>
              <span className="block text-[0.625rem] uppercase tracking-[0.11em] text-muted">
                Confidence
              </span>
              <strong className="font-mono text-base tabular-nums text-mint">
                {confidencePct}%
              </strong>
              <span className="block text-[0.625rem] text-muted">
                {confidenceLabel(selected.confidence)}
              </span>
            </div>
            <div>
              <span className="block text-[0.625rem] uppercase tracking-[0.11em] text-muted">
                Reports
              </span>
              <strong className="font-mono text-base tabular-nums text-bone">
                {selected.reportCount}
              </strong>
              <span className="block text-[0.625rem] text-muted">
                persisted studies
              </span>
            </div>
          </div>
          <div
            role="meter"
            aria-label={`${selected.label} evidence confidence`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={confidencePct}
            className="h-1.5 overflow-hidden rounded-full bg-line/45"
          >
            <span
              className="block h-full rounded-full bg-mint"
              style={{ width: `${confidencePct}%` }}
            />
          </div>

          {selected.visibility === "stealth" ? (
            <div className="flex gap-2 rounded-md border border-line/60 bg-panel/30 p-2.5">
              <EyeSlash className="mt-0.5 shrink-0 text-muted" size="1rem" />
              <p className="text-[0.6875rem] leading-5 text-muted">
                Private weights and results. This checkpoint generates no
                demand, customers, market share, or revenue while it remains
                stealth.
              </p>
            </div>
          ) : null}
          {selected.retainedModel ? (
            <div className="rounded-md border border-mint/25 bg-mint/5 p-2.5">
              <p className="hud-eyebrow">Released model</p>
              <p className="mt-1 text-[0.75rem] text-bone">
                {selected.retainedModel.name}
              </p>
              <p className="mt-0.5 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-muted">
                {selected.retainedModel.status} · {selected.retainedModel.id}
              </p>
            </div>
          ) : null}
          {selected.pendingEvaluations.length > 0 ? (
            <div className="rounded-md border border-research/30 bg-research/5 p-2.5">
              <p className="hud-eyebrow text-research">
                {selected.pendingEvaluations.length} concurrent evaluation
                {selected.pendingEvaluations.length === 1 ? "" : "s"}
              </p>
              <div className="mt-1.5 space-y-1">
                {selected.pendingEvaluations.map((evaluation) => (
                  <div
                    key={evaluation.id}
                    className="flex items-center justify-between gap-2 font-mono text-[0.625rem] tabular-nums text-muted"
                  >
                    <span>{checkpointReviewModeLabel(evaluation.mode)}</span>
                    <span>
                      due D{evaluation.readyDay} · {money(evaluation.totalCost)} ·{" "}
                      {clampedPercent(evaluation.accuracy)}% accuracy
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <HudDesktopDefaultDetails className="group rounded-md border border-line/60 bg-void/20" data-checkpoint-evidence-disclosure="true">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint/60 [&::-webkit-details-marker]:hidden">
            <span>
              <span className="hud-eyebrow block">Evidence &amp; review</span>
              <span className="mt-0.5 block text-[0.6875rem] text-bone">
                {evaluationEstimate == null ? "Not measured" : `${evaluationEstimate.toFixed(1)} score`} · {review?.verdict ?? "no verdict"}
              </span>
            </span>
            <span className="font-mono text-[0.625rem] text-muted"><span className="group-open:hidden">Open</span><span className="hidden group-open:inline">Hide</span> <span aria-hidden>⌄</span></span>
          </summary>
        <div className="space-y-3 border-t border-line/40 p-3">
          <section
            aria-label={`${selected.label} benchmark evidence`}
            className="rounded-md border border-line/60 bg-void/30 p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="hud-eyebrow">Benchmark evidence</p>
                <strong className="mt-1 block text-[0.8125rem] text-bone">
                  {selected.benchmark
                    ? `${selected.benchmark.suiteLabel} · ${selected.benchmark.metricLabel}`
                    : "Not measured"}
                </strong>
              </div>
              {selected.benchmark ? (
                <StatusChip tone="research">
                  {clampedPercent(selected.benchmark.confidence)}% conf.
                </StatusChip>
              ) : null}
            </div>
            {selected.benchmark ? (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <span className="text-[0.625rem] uppercase tracking-[0.11em] text-muted">
                    Score · interval
                  </span>
                  <strong className="mt-0.5 block font-mono text-sm tabular-nums text-bone">
                    {formatBenchmarkInterval(selected.benchmark)}
                  </strong>
                </div>
                <div className="text-right">
                  <span className="text-[0.625rem] uppercase tracking-[0.11em] text-muted">
                    Rival delta
                  </span>
                  <strong
                    className={`mt-0.5 block font-mono text-sm tabular-nums ${
                      rivalDelta == null
                        ? "text-muted"
                        : rivalDelta >= 0
                          ? "text-mint"
                          : "text-amber"
                    }`}
                  >
                    {rivalDelta == null
                      ? "No peer"
                      : `${rivalDelta >= 0 ? "+" : ""}${rivalDelta.toFixed(1)} vs ${selected.benchmark.rivalName ?? "best rival"}`}
                  </strong>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-[0.6875rem] leading-5 text-muted">
                Run a private benchmark to narrow evaluation uncertainty and
                compare this checkpoint with current rivals.
              </p>
            )}
          </section>

          <section
            aria-label={`${selected.label} review summary`}
            className="rounded-md border border-line/60 bg-void/30 p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="hud-eyebrow">Review desk</p>
                <strong className="mt-1 block text-[0.8125rem] text-bone">
                  {review?.headline ?? "No review commissioned"}
                </strong>
              </div>
              {review?.status && review.status !== "none" ? (
                <StatusChip
                  tone={review.status === "complete" ? "positive" : "warning"}
                >
                  {review.status}
                </StatusChip>
              ) : null}
            </div>
            {review?.summary ? (
              <p className="mt-2 text-[0.6875rem] leading-5 text-muted">
                {review.summary}
              </p>
            ) : null}
            {review?.verdict ? (
              <p className="mt-2 font-mono text-[0.625rem] uppercase tracking-[0.11em] text-bone">
                Verdict · {review.verdict}
              </p>
            ) : null}
            {review?.mode ? (
              <p className="mt-1 font-mono text-[0.625rem] uppercase tracking-[0.11em] text-muted">
                Panel · {checkpointReviewModeLabel(review.mode)}
              </p>
            ) : null}
            {review?.strengths?.length || review?.risks?.length ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div>
                  <span className="text-[0.625rem] uppercase tracking-[0.11em] text-muted">
                    Strengths
                  </span>
                  <p className="mt-0.5 text-[0.6875rem] leading-5 text-bone">
                    {review?.strengths?.slice(0, 2).join(" · ") || "Unresolved"}
                  </p>
                </div>
                <div>
                  <span className="text-[0.625rem] uppercase tracking-[0.11em] text-muted">
                    Risks
                  </span>
                  <p className="mt-0.5 text-[0.6875rem] leading-5 text-amber">
                    {review?.risks?.slice(0, 2).join(" · ") ||
                      "No material issue found"}
                  </p>
                </div>
              </div>
            ) : null}
            {externalReview ? (
              <div className="mt-2 flex gap-2 rounded-md border border-amber/35 bg-amber/10 p-2.5">
                <Warning
                  className="mt-0.5 shrink-0 text-amber"
                  size="1rem"
                  weight="fill"
                />
                <p className="text-[0.6875rem] leading-5 text-amber">
                  External review can leak architecture, benchmark position, or
                  launch timing. Estimated leak risk {leakRisk}%.
                </p>
              </div>
            ) : null}
          </section>
        </div>
        </HudDesktopDefaultDetails>
      </div>

      {selected.evidenceReports.length > 0 ? (
        <HudDesktopDefaultDetails className="mt-3 rounded-md border border-line/60 bg-void/30">
          <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 py-2.5 text-[0.75rem] font-semibold text-bone transition hover:bg-panel-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-mint/45">
            Evidence ledger · {selected.evidenceReports.length} report
            {selected.evidenceReports.length === 1 ? "" : "s"} · consensus
          </summary>
          <div className="space-y-2 border-t border-line/50 p-3">
            <p className="max-w-3xl text-[0.6875rem] leading-5 text-muted">
              Consensus weights the same metric across retained studies by
              measurement accuracy and confidence. Re-running an evaluation
              adds evidence; it does not replace an inconvenient result.
            </p>
            {selected.evidenceReports.map((report) => (
              <HudDesktopDefaultDetails
                key={report.id}
                className="rounded-md border border-line/50 bg-panel/25"
              >
                <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 py-2 font-mono text-[0.6875rem] tabular-nums text-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-mint/45">
                  Day {report.day} · {checkpointReviewModeLabel(report.mode)} ·{" "}
                  {money(report.totalCost)} · {clampedPercent(report.confidence)}%
                  conf. · {clampedPercent(report.leakRisk)}% leak
                </summary>
                <div className="space-y-3 border-t border-line/40 p-3">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[0.625rem] uppercase tracking-[0.09em] text-muted">
                    <span>Accuracy {clampedPercent(report.accuracy)}%</span>
                    <span>
                      Contamination {clampedPercent(report.contaminationRisk)}%
                    </span>
                    <span>Leak outcome {report.leakOutcome.replaceAll("_", " ")}</span>
                  </div>
                  {report.flags.length > 0 ? (
                    <p className="rounded-md border border-amber/25 bg-amber/5 p-2 text-[0.6875rem] leading-5 text-amber">
                      Flags · {report.flags.join(" · ")}
                    </p>
                  ) : null}
                  {report.suites.map((suite) => (
                    <div key={suite.id} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <strong className="text-[0.75rem] text-bone">
                          {suite.label}
                        </strong>
                        <span className="font-mono text-[0.625rem] tabular-nums text-muted">
                          {clampedPercent(suite.accuracy)}% accuracy ·{" "}
                          {clampedPercent(suite.confidence)}% confidence
                        </span>
                      </div>
                      <div className="grid gap-2 xl:hidden" aria-label={`${suite.label} metric results`}>
                        {suite.metrics.map((metric) => (
                          <div key={metric.id} className="rounded-md border border-line/45 bg-void/25 p-2.5">
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-[0.6875rem] font-semibold text-bone">{metric.label}</span>
                              <span className="shrink-0 font-mono text-[0.6875rem] tabular-nums text-bone">{metric.score.toFixed(1)}</span>
                            </div>
                            <p className="mt-1 font-mono text-[0.625rem] tabular-nums text-muted">
                              interval {metric.low.toFixed(1)}–{metric.high.toFixed(1)}
                            </p>
                            <p className="mt-1 text-[0.625rem] leading-4 text-muted">
                              {metric.rival
                                ? `${metric.rival.delta >= 0 ? "+" : ""}${metric.rival.delta.toFixed(1)} vs ${metric.rival.name} · rank ${metric.rival.rank}/${metric.rival.fieldSize}`
                                : "No same-metric peer"}
                              {` · contamination ${clampedPercent(metric.contaminationSignal)}%`}
                            </p>
                          </div>
                        ))}
                      </div>
                      <div className="panel-scroll hidden overflow-x-auto xl:block" role="region" aria-label={`${suite.label} metric table`} tabIndex={0}>
                        <table className="w-full min-w-[39rem] border-collapse text-left text-[0.6875rem]">
                          <thead className="font-mono text-[0.625rem] uppercase tracking-[0.09em] text-muted">
                            <tr className="border-b border-line/50">
                              <th scope="col" className="py-1.5 pr-3 font-normal">Metric</th>
                              <th scope="col" className="px-2 py-1.5 font-normal">Score · interval</th>
                              <th scope="col" className="px-2 py-1.5 font-normal">Rival comparison</th>
                              <th scope="col" className="py-1.5 pl-2 text-right font-normal">Contam.</th>
                            </tr>
                          </thead>
                          <tbody>
                            {suite.metrics.map((metric) => (
                              <tr key={metric.id} className="border-b border-line/25 last:border-0">
                                <th scope="row" className="py-1.5 pr-3 font-medium text-bone">
                                  {metric.label}
                                </th>
                                <td className="px-2 py-1.5 font-mono tabular-nums text-bone">
                                  {metric.score.toFixed(1)} · {metric.low.toFixed(1)}–{metric.high.toFixed(1)}
                                </td>
                                <td className="px-2 py-1.5 font-mono tabular-nums text-muted">
                                  {metric.rival
                                    ? `${metric.rival.delta >= 0 ? "+" : ""}${metric.rival.delta.toFixed(1)} vs ${metric.rival.name} · rank ${metric.rival.rank}/${metric.rival.fieldSize}`
                                    : "No same-metric peer"}
                                </td>
                                <td className="py-1.5 pl-2 text-right font-mono tabular-nums text-muted">
                                  {clampedPercent(metric.contaminationSignal)}%
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                  <div>
                    <p className="hud-eyebrow">Blind reviewer notes</p>
                    <div className="mt-1.5 grid gap-2 lg:grid-cols-2">
                      {report.reviews.map((reviewer) => (
                        <article
                          key={reviewer.id}
                          className="rounded-md border border-line/45 bg-void/25 p-2.5"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <strong className="text-[0.6875rem] text-bone">
                              {reviewer.focus.replaceAll("_", " ")}
                            </strong>
                            <span className="font-mono text-[0.625rem] uppercase text-muted">
                              {reviewer.verdict.replaceAll("_", " ")}
                            </span>
                          </div>
                          <p className="mt-1 font-mono text-[0.625rem] tabular-nums text-muted">
                            Score {reviewer.score.toFixed(1)} · conf. {clampedPercent(reviewer.confidence)}% · reviewer calibration {reviewer.calibration >= 0 ? "+" : ""}{reviewer.calibration.toFixed(1)}
                          </p>
                          <p className="mt-1.5 text-[0.6875rem] leading-5 text-bone">
                            Strengths · {reviewer.strengths.join(" · ") || "None recorded"}
                          </p>
                          <p className="text-[0.6875rem] leading-5 text-amber">
                            Concerns · {reviewer.concerns.join(" · ") || "None recorded"}
                          </p>
                        </article>
                      ))}
                    </div>
                  </div>
                </div>
              </HudDesktopDefaultDetails>
            ))}
          </div>
        </HudDesktopDefaultDetails>
      ) : null}

      <div
        role="group"
        aria-label={`Actions for ${selected.label}`}
        className="mt-3 grid grid-cols-2 gap-2 border-t border-line/50 pt-3 [&_.hud-button]:!min-h-11 [&_.hud-button]:!w-full xl:flex xl:flex-wrap xl:[&_.hud-button]:!w-auto"
      >
        <BenchmarkEntryPoint
          context={{ kind: "checkpoint", id: selected.id }}
          type="button"
          disabled={!selected.actions.benchmark.enabled}
          title={actionTitle(selected.actions.benchmark)}
          aria-label={`Benchmark ${selected.label}`}
          onOpen={() => onBenchmark?.(selected.id)}
        >
          {selected.actions.benchmark.label ?? "Run benchmark"}
        </BenchmarkEntryPoint>
        <HudButton
          type="button"
          variant="secondary"
          disabled={!selected.actions.review.enabled}
          title={actionTitle(selected.actions.review)}
          aria-label={`Review ${selected.label}`}
          onClick={() => onReview?.(selected.id)}
        >
          <ShieldCheck size="0.875rem" />
          {selected.actions.review.label ?? "Commission review"}
        </HudButton>
        <HudButton
          type="button"
          variant="secondary"
          disabled={!selected.actions.promote.enabled}
          title={actionTitle(selected.actions.promote)}
          aria-label={`Promote ${selected.label}`}
          onClick={() => onPromote?.(selected.id)}
        >
          <ArrowCircleUp size="0.875rem" />
          {selected.actions.promote.label ?? "Keep weights in Fleet"}
        </HudButton>
        <HudButton
          type="button"
          variant={rollbackConfirmId === selected.id ? "danger" : "ghost"}
          disabled={!selected.actions.rollback.enabled}
          title={actionTitle(selected.actions.rollback)}
          aria-label={`${rollbackConfirmId === selected.id ? "Confirm restart source here" : "Restart source here"} ${selected.label}`}
          onClick={() => {
            if (rollbackConfirmId === selected.id) {
              onRollback?.({
                jobId: selected.sourceJobId,
                checkpointId: selected.id,
              });
              setRollbackConfirmId(null);
            } else {
              setRollbackConfirmId(selected.id);
            }
          }}
        >
          <ArrowCounterClockwise size="0.875rem" />
          {rollbackConfirmId === selected.id
            ? "Confirm restart source"
            : selected.actions.rollback.label ?? "Restart source here"}
        </HudButton>
        <HudButton
          type="button"
          variant="danger"
          disabled={!selected.actions.discard.enabled}
          title={actionTitle(selected.actions.discard)}
          aria-label={`${discardConfirmId === selected.id ? "Confirm discard" : "Discard"} ${selected.label}`}
          onClick={() => {
            if (discardConfirmId === selected.id) {
              onDiscard?.(selected.id);
              setDiscardConfirmId(null);
            } else {
              setDiscardConfirmId(selected.id);
            }
          }}
          className="xl:ml-auto"
        >
          <Trash size="0.875rem" />
          {discardConfirmId === selected.id ? "Confirm discard" : "Discard"}
        </HudButton>
      </div>

    </section>
  );
}

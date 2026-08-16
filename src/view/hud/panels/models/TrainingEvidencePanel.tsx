import type { TrainingJob } from "../../../../sim/types";
import { money } from "../../format";
import { HudButton, StatusChip } from "../../ui/HudPrimitives";
import type { CheckpointUiRecord } from "./checkpointUi";

const verdictLabel = (
  verdict: NonNullable<CheckpointUiRecord["review"]>["verdict"],
): string => {
  if (verdict === "advance") return "Advance";
  if (verdict === "hold") return "Hold";
  if (verdict === "reject") return "Reject";
  return "Inconclusive";
};

const verdictTone = (
  verdict: NonNullable<CheckpointUiRecord["review"]>["verdict"],
): "positive" | "warning" | "danger" | "neutral" => {
  if (verdict === "advance") return "positive";
  if (verdict === "reject") return "danger";
  if (verdict === "hold") return "warning";
  return "neutral";
};

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;

export function TrainingEvidencePanel({
  job,
  checkpoints,
  onOpenCheckpointHistory,
}: {
  job: Pick<
    TrainingJob,
    "id" | "name" | "benchmarkSnapshots" | "pendingBenchmark"
  >;
  checkpoints: CheckpointUiRecord[];
  onOpenCheckpointHistory?: () => void;
}) {
  const snapshots = job.benchmarkSnapshots ?? [];
  const latestSnapshot = snapshots.at(-1);
  const evidenceCheckpoints = [...checkpoints]
    .filter(
      (checkpoint) =>
        checkpoint.reportCount > 0 || checkpoint.pendingEvaluations.length > 0,
    )
    .sort((a, b) => b.day - a.day || b.progress - a.progress)
    .slice(0, 3);
  const pendingReviews = checkpoints.reduce(
    (count, checkpoint) => count + checkpoint.pendingEvaluations.length,
    0,
  );
  const completedReviews = checkpoints.reduce(
    (count, checkpoint) => count + checkpoint.reportCount,
    0,
  );
  const hasEvidence =
    latestSnapshot != null ||
    job.pendingBenchmark != null ||
    evidenceCheckpoints.length > 0;

  return (
    <section
      className="rounded-lg border border-research/35 bg-research/5 p-3"
      aria-label={`${job.name} benchmark results and reviews`}
      data-training-evidence="true"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="hud-eyebrow text-research">Checkpoint evidence</p>
          <h4 className="mt-1 text-[0.875rem] font-semibold text-bone">
            Benchmarks &amp; reviews
          </h4>
          <p className="mt-1 text-[0.6875rem] leading-5 text-muted">
            Benchmark saves these exact weights first; the source run keeps
            training while its suites and blind review complete.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5 font-mono text-[0.625rem] tabular-nums text-muted">
          <span>{checkpoints.length} checkpoints</span>
          <span aria-hidden="true">·</span>
          <span>{snapshots.length + completedReviews} results</span>
          {pendingReviews > 0 ? (
            <StatusChip tone="warning">{pendingReviews} in review</StatusChip>
          ) : null}
        </div>
      </div>

      {job.pendingBenchmark ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber/35 bg-amber/8 px-2.5 py-2 text-[0.6875rem]">
          <span className="text-bone">Run benchmark in progress</span>
          <span className="font-mono tabular-nums text-amber">
            {(job.pendingBenchmark.suiteIds ?? []).length} suites · due D
            {job.pendingBenchmark.readyDay}
          </span>
        </div>
      ) : null}

      {latestSnapshot ? (
        <div className="mt-2 rounded-md border border-line/60 bg-void/35 p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="text-[0.75rem] text-bone">
              Latest run benchmark · D{latestSnapshot.day}
            </strong>
            <span className="font-mono text-[0.625rem] tabular-nums text-muted">
              {pct(latestSnapshot.progress)} trained · {pct(latestSnapshot.accuracy ?? 0)} accuracy
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <EvidenceMetric
              label="Capability"
              value={latestSnapshot.capability.toFixed(2)}
              detail={`${(latestSnapshot.capabilityLow ?? latestSnapshot.capability).toFixed(2)}–${(latestSnapshot.capabilityHigh ?? latestSnapshot.capability).toFixed(2)}`}
            />
            <EvidenceMetric
              label="Safety"
              value={latestSnapshot.safety.toFixed(2)}
              detail={`${(latestSnapshot.safetyLow ?? latestSnapshot.safety).toFixed(2)}–${(latestSnapshot.safetyHigh ?? latestSnapshot.safety).toFixed(2)}`}
            />
            <EvidenceMetric
              label="Suite score"
              value={(latestSnapshot.suite ?? latestSnapshot.capability).toFixed(2)}
              detail={`${latestSnapshot.suiteIds?.length ?? 1} suite${(latestSnapshot.suiteIds?.length ?? 1) === 1 ? "" : "s"}`}
            />
            <EvidenceMetric
              label="Spend"
              value={money(latestSnapshot.totalCost ?? 0)}
              detail={`${pct(latestSnapshot.confidence ?? 0)} confidence`}
            />
          </div>
        </div>
      ) : null}

      {evidenceCheckpoints.length > 0 ? (
        <div className="mt-2 space-y-2">
          {evidenceCheckpoints.map((checkpoint) => {
            const pending = checkpoint.pendingEvaluations[0];
            const review = checkpoint.review;
            return (
              <article
                key={checkpoint.id}
                className="rounded-md border border-line/60 bg-void/35 px-2.5 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <strong className="block truncate text-[0.75rem] text-bone">
                      {checkpoint.label}
                    </strong>
                    <span className="font-mono text-[0.625rem] tabular-nums text-muted">
                      D{checkpoint.day} · {pct(checkpoint.progress)} weights
                    </span>
                  </div>
                  {pending ? (
                    <StatusChip tone="warning">Review due D{pending.readyDay}</StatusChip>
                  ) : review?.status === "complete" ? (
                    <StatusChip tone={verdictTone(review.verdict)}>
                      {verdictLabel(review.verdict)}
                    </StatusChip>
                  ) : (
                    <StatusChip tone="neutral">Checkpoint saved</StatusChip>
                  )}
                </div>

                {pending ? (
                  <p className="mt-1.5 text-[0.6875rem] leading-5 text-muted">
                    {pct(pending.accuracy)} expected accuracy · {money(pending.totalCost)} · {pending.mode.replaceAll("_", " ")}
                  </p>
                ) : null}

                {checkpoint.benchmark ? (
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[0.6875rem] tabular-nums">
                    <span className="text-bone">
                      {checkpoint.benchmark.metricLabel} {checkpoint.benchmark.score.toFixed(2)}
                    </span>
                    <span className="text-muted">
                      interval {checkpoint.benchmark.low.toFixed(2)}–{checkpoint.benchmark.high.toFixed(2)}
                    </span>
                    <span className="text-muted">
                      {pct(checkpoint.benchmark.confidence)} confidence
                    </span>
                  </div>
                ) : null}

                {review?.summary ? (
                  <p className="mt-1.5 text-[0.6875rem] leading-5 text-muted">
                    {review.summary}
                  </p>
                ) : null}
                {review?.strengths?.[0] || review?.risks?.[0] ? (
                  <div className="mt-1.5 grid gap-1 text-[0.625rem] leading-5 sm:grid-cols-2">
                    {review.strengths?.[0] ? (
                      <span className="text-mint">Strength · {review.strengths[0]}</span>
                    ) : null}
                    {review.risks?.[0] ? (
                      <span className="text-amber">Risk · {review.risks[0]}</span>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}

      {!hasEvidence ? (
        <p className="mt-2 rounded-md border border-dashed border-line/60 bg-void/25 px-2.5 py-2 text-[0.6875rem] leading-5 text-muted">
          No benchmark evidence yet. Use Benchmark to capture a checkpoint and
          commission the first suites and review panel.
        </p>
      ) : null}

      {checkpoints.length > 0 && onOpenCheckpointHistory ? (
        <div className="mt-2 flex justify-end">
          <HudButton
            type="button"
            variant="ghost"
            className="min-h-8 px-2 text-[0.6875rem] text-research"
            onClick={onOpenCheckpointHistory}
          >
            Open checkpoint history
          </HudButton>
        </div>
      ) : null}
    </section>
  );
}

function EvidenceMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="min-w-0 rounded-md border border-line/50 bg-panel-2/45 px-2 py-1.5">
      <span className="block text-[0.625rem] uppercase tracking-[0.1em] text-muted">
        {label}
      </span>
      <strong className="mt-0.5 block truncate font-mono text-[0.75rem] tabular-nums text-bone">
        {value}
      </strong>
      <span className="mt-0.5 block truncate font-mono text-[0.5625rem] tabular-nums text-muted">
        {detail}
      </span>
    </div>
  );
}

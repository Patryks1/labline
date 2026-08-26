import { useEffect, useMemo, useState } from "react";
import { Camera, GitFork } from "@phosphor-icons/react";
import type { TrainingJob } from "../../../../sim/types";
import {
  EmptyState,
  HudButton,
  HudInput,
  HudSelect,
} from "../../ui/HudPrimitives";
import { CheckpointRail } from "./CheckpointRail";
import type {
  CheckpointBranchDirection,
  CheckpointUiRecord,
} from "./checkpointUi";

export interface CheckpointWorkspaceEntry {
  sourceJobId: string;
  checkpoint: CheckpointUiRecord;
}

export function CheckpointWorkspace({
  entries,
  jobs,
  onCreateManual,
  onBenchmark,
  onReview,
  onPromote,
  onDiscard,
  onBranch,
  onRollback,
}: {
  entries: CheckpointWorkspaceEntry[];
  jobs: Pick<
    TrainingJob,
    | "id"
    | "name"
    | "progressPfDays"
    | "targetPfDays"
    | "parentCheckpointId"
    | "branchDirection"
    | "paused"
    | "failed"
  >[];
  onCreateManual?: (request: {
    sourceJobId: string;
    label?: string;
    branchDirection?: CheckpointBranchDirection;
  }) => void;
  onBenchmark?: (checkpointId: string) => void;
  onReview?: (checkpointId: string) => void;
  onPromote?: (checkpointId: string) => void;
  onDiscard?: (checkpointId: string) => void;
  onBranch?: (checkpointId: string) => void;
  onRollback?: (request: { jobId: string; checkpointId: string }) => void;
}) {
  const [sourceJobId, setSourceJobId] = useState(() => jobs[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const selectedJob =
    jobs.find((job) => job.id === sourceJobId) ?? jobs[0];
  const grouped = useMemo(() => {
    const result = new Map<string, CheckpointUiRecord[]>();
    for (const entry of entries) {
      const current = result.get(entry.sourceJobId) ?? [];
      current.push(entry.checkpoint);
      result.set(entry.sourceJobId, current);
    }
    return [...result.entries()].map(([jobId, checkpoints]) => ({
      jobId,
      name:
        jobs.find((job) => job.id === jobId)?.name ??
        checkpoints[0]?.label.split(" · ")[0] ??
        "Archived run",
      checkpoints: [...checkpoints].sort(
        (a, b) => a.progress - b.progress || a.day - b.day,
      ),
    }));
  }, [entries, jobs]);
  const [selectedHistoryJobId, setSelectedHistoryJobId] = useState(
    () => entries[0]?.sourceJobId ?? "",
  );
  useEffect(() => {
    if (grouped.some((group) => group.jobId === selectedHistoryJobId)) return;
    setSelectedHistoryJobId(grouped[0]?.jobId ?? "");
  }, [grouped, selectedHistoryJobId]);
  const selectedGroup =
    grouped.find((group) => group.jobId === selectedHistoryJobId) ?? grouped[0];

  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-mint/35 bg-mint/5 p-3">
        <div className="flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <p className="hud-eyebrow">Checkpoint purpose</p>
            <h3 className="mt-1 text-sm font-semibold text-bone">
              Fork this snapshot onto a new data mix
            </h3>
            <p className="hud-mobile-detail mt-1 max-w-3xl text-[0.6875rem] leading-5 text-muted">
              A checkpoint is a frozen weight file, not a save slot. Branch it
              into Code, Cyber, Chat, Agents, Reasoning, or Safety with
              independent data, compute, and post-training. The parent run keeps
              going.
            </p>
          </div>
          <HudButton
            type="button"
            variant="primary"
            disabled={!onBranch || entries.length === 0}
            onClick={() => {
              const latest = selectedGroup?.checkpoints.at(-1);
              if (latest) onBranch?.(latest.id);
            }}
            className="min-h-11 w-full sm:w-auto"
          >
            <GitFork size="0.875rem" />
            Branch from latest
          </HudButton>
        </div>
      </section>

      <details className="group rounded-lg border border-line/65 bg-panel-2/45" data-manual-checkpoint-disclosure="true">
        <summary className="flex min-h-11 cursor-pointer list-none items-start justify-between gap-3 rounded-lg p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint/60 [&::-webkit-details-marker]:hidden">
          <div>
            <p className="hud-eyebrow">Manual checkpoint</p>
            <h3 className="mt-1 text-sm font-semibold text-bone">
              Save the current weights without stopping the run
            </h3>
          </div>
          <span className="font-mono text-[0.625rem] text-muted"><span className="group-open:hidden">Configure</span><span className="hidden group-open:inline">Hide</span> <span aria-hidden>⌄</span></span>
        </summary>
        <div className="border-t border-line/40 p-3">
        <p className="hud-mobile-detail max-w-3xl text-[0.6875rem] leading-5 text-muted">
          Save exact current weights while the source run keeps going, then
          use the snapshot for a branch or evaluation.
        </p>
        {jobs.length > 0 ? (
          <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(12rem,0.8fr)_minmax(18rem,1.4fr)_auto] lg:items-end">
            <label className="text-[0.6875rem] text-muted">
              Active run
              <HudSelect
                value={selectedJob?.id ?? ""}
                onChange={(event) => setSourceJobId(event.target.value)}
                className="mt-1 min-h-11 w-full text-[0.75rem]"
              >
                {jobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.name} · {Math.round((job.progressPfDays / Math.max(1e-9, job.targetPfDays)) * 100)}%
                  </option>
                ))}
              </HudSelect>
            </label>
            <label className="text-[0.6875rem] text-muted">
              Checkpoint label (optional)
              <HudInput
                type="text"
                maxLength={48}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={`${selectedJob?.name ?? "Run"} · current weights`}
                className="mt-1 min-h-11 w-full text-[0.75rem]"
              />
            </label>
            <HudButton
              type="button"
              variant="primary"
              disabled={!selectedJob || !onCreateManual}
              title={
                onCreateManual
                  ? "Save immutable weights; the training campaign continues."
                  : "Manual checkpoint support is unavailable in this save."
              }
              onClick={() => {
                if (!selectedJob || !onCreateManual) return;
                onCreateManual({
                  sourceJobId: selectedJob.id,
                  label: label.trim() || undefined,
                });
                setLabel("");
              }}
              className="w-full lg:w-auto"
            >
              <Camera size="0.875rem" />
              Save current weights
            </HudButton>
          </div>
        ) : (
          <p className="mt-3 rounded-md border border-line/55 bg-void/30 p-2.5 text-[0.6875rem] leading-5 text-muted">
            Start or continue a training run to create a new manual checkpoint.
            Existing checkpoints remain available below.
          </p>
        )}
        </div>
      </details>

      {selectedGroup ? (
        <>
          <nav
            aria-label="Checkpoint run histories"
            className="rounded-lg border border-line/65 bg-panel-2/45 p-2"
          >
            <p className="hud-eyebrow px-1 pb-1.5">Run histories</p>
            <ul className="panel-scroll grid gap-1 max-xl:flex max-xl:snap-x max-xl:overflow-x-auto max-xl:overscroll-x-contain sm:grid-cols-2 xl:grid-cols-3" data-mobile-scroll="horizontal">
              {grouped.map((group) => {
                const active = group.jobId === selectedGroup.jobId;
                const latest = group.checkpoints.at(-1);
                return (
                  <li key={group.jobId} className="max-xl:min-w-[12rem] max-xl:snap-start">
                    <HudButton
                      type="button"
                      variant="ghost"
                      aria-current={active ? "page" : undefined}
                      onClick={() => setSelectedHistoryJobId(group.jobId)}
                      className={`!min-h-11 !w-full !justify-between !rounded-md !border !px-2.5 !text-left !normal-case !tracking-normal ${
                        active
                          ? "!border-mint/55 !bg-mint/10 !text-bone"
                          : "!border-line/55 !bg-void/25 !text-muted hover:!border-line hover:!text-bone"
                      }`}
                    >
                      <span className="min-w-0">
                        <strong className="block truncate text-[0.75rem]">
                          {group.name}
                        </strong>
                        <span className="mt-0.5 block font-mono text-[0.5625rem] uppercase tracking-[0.09em] text-muted">
                          {group.checkpoints.length} checkpoint
                          {group.checkpoints.length === 1 ? "" : "s"}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-[0.6875rem] tabular-nums text-mint">
                        {Math.round((latest?.progress ?? 0) * 100)}%
                      </span>
                    </HudButton>
                  </li>
                );
              })}
            </ul>
          </nav>
          <CheckpointRail
            key={selectedGroup.jobId}
            checkpoints={selectedGroup.checkpoints}
            title={`${selectedGroup.name} · checkpoints`}
            onBenchmark={onBenchmark}
            onReview={onReview}
            onPromote={onPromote}
            onDiscard={onDiscard}
            onBranch={onBranch}
            onRollback={onRollback}
            jobs={jobs}
          />
        </>
      ) : (
        <EmptyState
          title="No checkpoints yet"
          description="Weight files are created when you save, branch, measure, or roll back. Incidents do not write files by themselves."
        />
      )}
    </div>
  );
}

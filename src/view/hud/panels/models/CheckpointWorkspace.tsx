import { useMemo, useState } from "react";
import { Camera, GitFork } from "@phosphor-icons/react";
import type { TrainingJob } from "../../../../sim/types";
import { EmptyState, HudButton } from "../../ui/HudPrimitives";
import { CheckpointRail } from "./CheckpointRail";
import type {
  CheckpointBranchDirection,
  CheckpointUiRecord,
} from "./checkpointUi";

const DIRECTIONS: ReadonlyArray<{
  id: CheckpointBranchDirection;
  label: string;
}> = [
  { id: "general", label: "General" },
  { id: "chat", label: "Chat" },
  { id: "code", label: "Code" },
  { id: "agents", label: "Agents" },
  { id: "reasoning", label: "Reasoning" },
  { id: "safety", label: "Safety" },
  { id: "custom", label: "Custom" },
];

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
  onFork,
  onRollback,
}: {
  entries: CheckpointWorkspaceEntry[];
  jobs: Pick<TrainingJob, "id" | "name" | "progressPfDays" | "targetPfDays">[];
  onCreateManual?: (request: {
    sourceJobId: string;
    label?: string;
    branchDirection?: CheckpointBranchDirection;
  }) => void;
  onBenchmark?: (checkpointId: string) => void;
  onReview?: (checkpointId: string) => void;
  onPromote?: (checkpointId: string) => void;
  onDiscard?: (checkpointId: string) => void;
  onFork?: (request: {
    checkpointId: string;
    direction: CheckpointBranchDirection;
    label?: string;
  }) => void;
  onRollback?: (request: { jobId: string; checkpointId: string }) => void;
}) {
  const [sourceJobId, setSourceJobId] = useState(() => jobs[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [direction, setDirection] =
    useState<CheckpointBranchDirection>("general");
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
      checkpoints: [...checkpoints].sort(
        (a, b) => a.progress - b.progress || a.day - b.day,
      ),
    }));
  }, [entries]);

  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-line/65 bg-panel-2/45 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="hud-eyebrow">Manual checkpoint</p>
            <h3 className="mt-1 text-sm font-semibold text-bone">
              Save the current weights without stopping the run
            </h3>
            <p className="mt-1 hidden max-w-3xl text-[0.6875rem] leading-5 text-muted sm:block">
              Creates an immutable stealth checkpoint at the run’s current
              position, even between automatic milestones. Use labels and directions to keep parallel code, chat,
              agent, reasoning, and safety experiments legible.
            </p>
          </div>
          <GitFork size="1.25rem" className="text-research" weight="duotone" />
        </div>
        {jobs.length > 0 ? (
          <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(11rem,0.7fr)_minmax(12rem,1fr)_minmax(16rem,1.3fr)_auto] lg:items-end">
            <label className="text-[0.6875rem] text-muted">
              Active run
              <select
                value={selectedJob?.id ?? ""}
                onChange={(event) => setSourceJobId(event.target.value)}
                className="mt-1 min-h-11 w-full rounded-md border border-line bg-void px-2.5 py-1.5 text-[0.75rem] text-bone outline-none focus:border-mint/50"
              >
                {jobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.name} · {Math.round((job.progressPfDays / Math.max(1e-9, job.targetPfDays)) * 100)}%
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[0.6875rem] text-muted">
              Direction
              <select
                value={direction}
                onChange={(event) =>
                  setDirection(event.target.value as CheckpointBranchDirection)
                }
                className="mt-1 min-h-11 w-full rounded-md border border-line bg-void px-2.5 py-1.5 text-[0.75rem] text-bone outline-none focus:border-mint/50"
              >
                {DIRECTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[0.6875rem] text-muted">
              Checkpoint label (optional)
              <input
                type="text"
                maxLength={48}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={`${selectedJob?.name ?? "Run"} · ${direction}`}
                className="mt-1 min-h-11 w-full rounded-md border border-line bg-void px-2.5 py-1.5 text-[0.75rem] text-bone outline-none focus:border-mint/50"
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
                  branchDirection: direction,
                });
                setLabel("");
              }}
              className="w-full lg:w-auto"
            >
              <Camera size="0.875rem" />
              Create checkpoint
            </HudButton>
          </div>
        ) : (
          <p className="mt-3 rounded-md border border-line/55 bg-void/30 p-2.5 text-[0.6875rem] leading-5 text-muted">
            Start or continue a training run to create a new manual checkpoint.
            Existing checkpoints remain available below.
          </p>
        )}
      </section>

      {grouped.length > 0 ? (
        grouped.map((group) => {
          const job = jobs.find((candidate) => candidate.id === group.jobId);
          const fallbackName = group.checkpoints[0]?.label ?? "Archived run";
          return (
            <CheckpointRail
              key={group.jobId}
              checkpoints={group.checkpoints}
              title={`${job?.name ?? fallbackName} · checkpoint graph`}
              onBenchmark={onBenchmark}
              onReview={onReview}
              onPromote={onPromote}
              onDiscard={onDiscard}
              onFork={onFork}
              onRollback={onRollback}
            />
          );
        })
      ) : (
        <EmptyState
          title="No checkpoints yet"
          description="Milestone checkpoints appear automatically. You can also save the current weights manually from any active run."
        />
      )}
    </div>
  );
}

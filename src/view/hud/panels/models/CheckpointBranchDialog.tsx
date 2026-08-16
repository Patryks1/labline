import { useEffect, useState } from "react";
import { GitFork } from "@phosphor-icons/react";
import type {
  TrainingCheckpointBranchDirection,
  TrainingCheckpointCandidate,
} from "../../../../sim/types";
import { formatParams } from "../../../../sim/balance/training";
import { ConsoleDialog } from "../../ui/ConsoleDialog";
import {
  HudButton,
  HudInput,
  StatusChip,
} from "../../ui/HudPrimitives";
import {
  CHECKPOINT_BRANCH_DIRECTIONS,
  suggestedCheckpointBranchName,
} from "./checkpointBranching";

export interface CheckpointBranchRequest {
  checkpointId: string;
  direction: TrainingCheckpointBranchDirection;
  label: string;
}

export function CheckpointBranchDialog({
  open,
  checkpoint,
  sourceRunName,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  checkpoint?: TrainingCheckpointCandidate;
  sourceRunName: string;
  error?: string | null;
  onClose: () => void;
  onSubmit: (request: CheckpointBranchRequest) => void;
}) {
  const initialDirection = checkpoint?.branchDirection ?? "general";
  const [direction, setDirection] =
    useState<TrainingCheckpointBranchDirection>(initialDirection);
  const [name, setName] = useState(() =>
    suggestedCheckpointBranchName(sourceRunName, initialDirection),
  );

  useEffect(() => {
    if (!open || !checkpoint) return;
    const nextDirection = checkpoint.branchDirection ?? "general";
    setDirection(nextDirection);
    setName(suggestedCheckpointBranchName(sourceRunName, nextDirection));
  }, [checkpoint, open, sourceRunName]);

  if (!checkpoint) return null;

  const progress = Math.round(
    Math.max(0, Math.min(1, checkpoint.telemetry.progress)) * 100,
  );
  const trimmedName = name.trim();

  return (
    <ConsoleDialog
      open={open}
      titleId="checkpoint-branch-dialog-title"
      eyebrow="Checkpoint branch"
      title="Train a new model from these weights"
      description="The source run keeps training. This creates a separate child model with independent data, compute, progress, and release decisions."
      onClose={onClose}
      closeLabel="Close checkpoint branch"
      maxWidthClass="max-w-4xl"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <HudButton type="button" variant="ghost" onClick={onClose}>
            Cancel
          </HudButton>
          <div className="flex min-w-0 flex-col items-stretch gap-1 sm:items-end">
            <span className="text-[0.625rem] leading-4 text-muted">
              Parent continues · child starts at 0% from the saved weights
            </span>
            <HudButton
              type="button"
              variant="primary"
              disabled={!trimmedName}
              onClick={() =>
                onSubmit({
                  checkpointId: checkpoint.id,
                  direction,
                  label: trimmedName,
                })
              }
            >
              <GitFork aria-hidden="true" size="0.875rem" weight="bold" />
              Start branch
            </HudButton>
          </div>
        </div>
      }
    >
      <div className="space-y-4" data-checkpoint-branch-workflow="true">
        <section className="rounded-lg border border-mint/30 bg-mint/5 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="hud-eyebrow text-mint">Branch point</p>
              <strong className="mt-1 block truncate text-sm text-bone">
                {checkpoint.customLabel || checkpoint.model.name}
              </strong>
              <p className="mt-1 text-[0.6875rem] leading-5 text-muted">
                {sourceRunName} at {progress}% · day {checkpoint.capturedDay} ·{" "}
                {checkpoint.stage} weights
              </p>
            </div>
            <StatusChip tone="positive">Weights inherited</StatusChip>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div>
              <dt className="text-[0.5625rem] uppercase tracking-[0.12em] text-muted">
                Parameters
              </dt>
              <dd className="mt-0.5 font-mono text-[0.75rem] text-bone">
                {formatParams(checkpoint.model.paramsB)}
              </dd>
            </div>
            <div>
              <dt className="text-[0.5625rem] uppercase tracking-[0.12em] text-muted">
                Saved progress
              </dt>
              <dd className="mt-0.5 font-mono text-[0.75rem] text-mint">
                {progress}%
              </dd>
            </div>
            <div>
              <dt className="text-[0.5625rem] uppercase tracking-[0.12em] text-muted">
                Source run
              </dt>
              <dd className="mt-0.5 truncate text-[0.75rem] text-bone">
                Continues
              </dd>
            </div>
            <div>
              <dt className="text-[0.5625rem] uppercase tracking-[0.12em] text-muted">
                Child run
              </dt>
              <dd className="mt-0.5 truncate text-[0.75rem] text-bone">
                Independent
              </dd>
            </div>
          </dl>
        </section>

        <fieldset>
          <legend className="text-[0.75rem] font-semibold text-bone">
            Choose a specialisation
          </legend>
          <p className="mt-0.5 text-[0.6875rem] leading-5 text-muted">
            This biases the fresh training data used by the child. It does not
            alter the saved checkpoint or the parent run.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {CHECKPOINT_BRANCH_DIRECTIONS.map((option) => {
              const selected = direction === option.id;
              return (
                <label
                  key={option.id}
                  className={`cursor-pointer rounded-md border p-2.5 transition focus-within:ring-2 focus-within:ring-mint/45 ${
                    selected
                      ? "border-mint/60 bg-mint/10"
                      : "border-line/60 bg-void/30 hover:border-line hover:bg-panel-2"
                  }`}
                >
                  <input
                    type="radio"
                    name="checkpoint-branch-direction"
                    value={option.id}
                    checked={selected}
                    onChange={() => {
                      setName((current) =>
                        current ===
                        suggestedCheckpointBranchName(sourceRunName, direction)
                          ? suggestedCheckpointBranchName(
                              sourceRunName,
                              option.id,
                            )
                          : current,
                      );
                      setDirection(option.id);
                    }}
                    className="sr-only"
                  />
                  <span className="flex items-center justify-between gap-2">
                    <strong className="text-[0.75rem] text-bone">
                      {option.label}
                    </strong>
                    <span className="font-mono text-[0.5625rem] uppercase text-muted">
                      {option.dataHint}
                    </span>
                  </span>
                  <span className="mt-1 block text-[0.625rem] leading-4 text-muted">
                    {option.description}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <label className="block text-[0.75rem] font-semibold text-bone">
          New model name
          <HudInput
            type="text"
            value={name}
            maxLength={64}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 min-h-11 w-full text-sm"
            aria-invalid={!trimmedName}
          />
          <span className="mt-1 block text-[0.625rem] font-normal leading-4 text-muted">
            This appears as a separate run in Training Activity and retains a
            link back to this checkpoint.
          </span>
        </label>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-danger/45 bg-danger/10 p-2.5 text-[0.6875rem] leading-5 text-danger"
          >
            {error}
          </p>
        ) : null}
      </div>
    </ConsoleDialog>
  );
}

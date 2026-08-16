import type { TrainingJob } from "../../../../sim/types";
import type { TrainingResourceAllocation } from "../../../../sim/systems/training";
import {
  buildTrainingJobViewModel,
  sortTrainingJobViewModels,
  type TrainingActivityTone,
} from "../../trainingJobViewModel";
import { HudButton, HudMeter, StatusChip } from "../../ui/HudPrimitives";
import { checkpointBranchDirectionLabel } from "./checkpointBranching";

export type ModelsWorkspaceView = "runs" | "checkpoints" | "fleet";

function toneForStatus(tone: TrainingActivityTone): "neutral" | "positive" | "warning" | "danger" {
  return tone;
}

/**
 * Compact, single-level run navigator for the Models workbench. The queue
 * deliberately consumes the shared training view model so its stage, issue,
 * ETA and urgency never drift from the global activity bar.
 */
export function ModelsTrainingQueue({
  jobs,
  resources,
  selectedJobId,
  activeView,
  viewCounts,
  onSelect,
  onViewChange,
  onNewModel,
  onResume,
  onRecover,
}: {
  jobs: TrainingJob[];
  resources?: Record<string, TrainingResourceAllocation | undefined>;
  selectedJobId: string | null;
  activeView: ModelsWorkspaceView;
  viewCounts: Record<ModelsWorkspaceView, number>;
  onSelect: (jobId: string) => void;
  onViewChange: (view: ModelsWorkspaceView) => void;
  onNewModel: () => void;
  onResume?: (jobId: string) => void;
  onRecover?: (jobId: string, checkpointId: string) => void;
}) {
  const viewModels = sortTrainingJobViewModels(
    jobs.map((job) =>
      buildTrainingJobViewModel(job, {
        resource: resources?.[job.id],
      }),
    ),
  );

  return (
    <aside
      aria-label="Training activity"
      data-model-training-queue="true"
      className="models-training-queue rounded-lg border border-line/70 bg-panel-2/55 p-2.5"
    >
      <header className="flex items-center justify-between gap-2 px-0.5 pb-2">
        <div className="min-w-0">
          <p className="hud-eyebrow">Training activity</p>
          <p className="mt-0.5 truncate text-[0.6875rem] text-muted">
            {viewModels.length === 0
              ? "Start a run or open a saved version."
              : `${viewModels.length} run${viewModels.length === 1 ? "" : "s"} · select one to inspect`}
          </p>
        </div>
        <HudButton
          type="button"
          variant="secondary"
          className="min-h-11 shrink-0 px-2.5 text-[0.6875rem]"
          data-action="new-model"
          onClick={onNewModel}
        >
          + Train model
        </HudButton>
      </header>

      <nav
        aria-label="Models workspace views"
        data-models-view-nav="true"
        className="mb-2 rounded-md border border-line/55 bg-void/20 p-1"
      >
        <p className="px-2 py-1 text-[0.5625rem] font-semibold uppercase tracking-[0.16em] text-muted">
          Views
        </p>
        <ul className="grid gap-px" aria-label="Model workspace views">
          {([
            ["runs", "Runs"],
            ["checkpoints", "Checkpoints"],
            ["fleet", "Fleet"],
          ] as const).map(([view, label]) => {
            const active = activeView === view;
            return (
              <li key={view}>
                <HudButton
                  type="button"
                  variant="ghost"
                  aria-current={active ? "page" : undefined}
                  aria-label={`${label}, ${viewCounts[view]} ${view === "runs" ? "runs" : view === "checkpoints" ? "checkpoints" : "models"}`}
                  data-view={view}
                  data-selected={active ? "true" : "false"}
                  onClick={() => onViewChange(view)}
                  className={`!flex !min-h-9 !w-full !items-center !justify-between !rounded-sm !border-0 !border-l-2 !px-2 !text-left !text-[0.6875rem] !font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/45 ${
                    active
                      ? "!border-mint !bg-mint/8 !text-mint"
                      : "!border-transparent !bg-transparent !text-muted hover:!bg-panel-2 hover:!text-bone"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        active ? "bg-mint" : "bg-line"
                      }`}
                    />
                    <span>{label}</span>
                  </span>
                  <span className="font-mono text-[0.625rem] tabular-nums text-muted">
                    {viewCounts[view]}
                  </span>
                </HudButton>
              </li>
            );
          })}
        </ul>
      </nav>

      {viewModels.length > 0 ? (
        <div role="list" className="grid gap-1.5">
          {viewModels.map((viewModel) => {
            const selected = viewModel.id === selectedJobId;
            const action = viewModel.primaryAction;
            const canDirectAction =
              (action.kind === "resume" && onResume) ||
              (action.kind === "recover" && onRecover);
            return (
              <div
                key={viewModel.id}
                role="listitem"
                data-job-id={viewModel.id}
                data-selected={selected ? "true" : "false"}
                className={`rounded-md border transition ${
                  selected
                    ? "border-mint/55 bg-mint/10"
                    : "border-line/60 bg-void/30 hover:border-line"
                }`}
              >
                <div className="flex items-stretch gap-1">
                  <HudButton
                    type="button"
                    variant="ghost"
                    aria-current={selected ? "true" : undefined}
                    aria-label={`${viewModel.name}, ${viewModel.stageLabel} ${Math.round(viewModel.stageProgress * 100)}%, ${viewModel.statusLabel}${viewModel.issueLabel ? `, ${viewModel.issueLabel}` : ""}`}
                    onClick={() => onSelect(viewModel.id)}
                    className="!min-h-11 !min-w-0 !flex-1 !justify-start !rounded-md !border-0 !bg-transparent !px-2.5 !py-2 !text-left !text-bone hover:!bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/45"
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate text-[0.8125rem] font-semibold text-bone">
                        {viewModel.name}
                      </span>
                      <StatusChip tone={toneForStatus(viewModel.statusTone)}>
                        {viewModel.statusLabel}
                      </StatusChip>
                    </span>
                    {viewModel.job.parentCheckpointId ? (
                      <span className="mt-1 flex items-center gap-1.5 text-[0.625rem] text-research">
                        <span aria-hidden="true">↳</span>
                        {checkpointBranchDirectionLabel(
                          viewModel.job.branchDirection ?? "general",
                        )}{" "}
                        branch · checkpoint lineage
                      </span>
                    ) : null}
                    <HudMeter
                      value={viewModel.stageProgress}
                      tone={viewModel.statusTone === "danger" ? "danger" : "train"}
                      label={`${viewModel.stageLabel} · ${viewModel.etaLabel}`}
                      detail={`${Math.round(viewModel.stageProgress * 100)}%`}
                      live={!viewModel.job.failed && !viewModel.job.paused}
                    />
                    {viewModel.issueLabel ? (
                      <span className="mt-1 block truncate text-[0.625rem] text-amber">
                        {viewModel.issueLabel}
                      </span>
                    ) : null}
                  </HudButton>
                  {canDirectAction ? (
                    <HudButton
                      type="button"
                      variant="ghost"
                      className="my-1 mr-1 min-h-11 self-start px-2 text-[0.625rem] sm:min-h-9"
                      title={
                        action.kind === "recover"
                          ? "Recover this failed post-training run from its eligible checkpoint."
                          : "Resume this paused run."
                      }
                      onClick={() => {
                        if (action.kind === "recover") {
                          onRecover?.(action.jobId, action.checkpointId);
                        } else {
                          onResume?.(action.jobId);
                        }
                      }}
                    >
                      {action.label}
                    </HudButton>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div
          className="rounded-md border border-dashed border-line/70 bg-void/25 px-2.5 py-2.5"
          data-model-training-empty="true"
          role="status"
        >
          <p className="text-[0.6875rem] font-semibold text-bone">No training runs</p>
          <p className="mt-0.5 text-[0.625rem] leading-relaxed text-muted">
            Start one with Train model above.
          </p>
        </div>
      )}
    </aside>
  );
}

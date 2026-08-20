import type { TrainingJob } from "../../../../sim/types";
import type { TrainingResourceAllocation } from "../../../../sim/systems/training";
import {
  buildTrainingJobViewModel,
  sortTrainingJobViewModels,
  type TrainingActivityTone,
} from "../../trainingJobViewModel";
import { formatParams } from "../../../../sim/balance/training";
import { HudButton, HudMeter, StatusChip } from "../../ui/HudPrimitives";
import { checkpointBranchDirectionLabel } from "./checkpointBranching";

export type ModelsWorkspaceView =
  | "runs"
  | "checkpoints"
  | "labs"
  | "routers"
  | "fleet";

const VIEW_ITEMS: ReadonlyArray<{
  view: ModelsWorkspaceView;
  label: string;
  unit: string;
}> = [
  { view: "runs", label: "Runs", unit: "in flight" },
  { view: "checkpoints", label: "Checkpoints", unit: "checkpoints" },
  { view: "labs", label: "Gyms", unit: "gyms" },
  { view: "routers", label: "Routers", unit: "routers" },
  { view: "fleet", label: "Fleet", unit: "models" },
];

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
      <header className="px-0.5 pb-2">
        <p className="hud-eyebrow">Campaign</p>
      </header>

      <nav
        aria-label="Models workspace views"
        data-models-view-nav="true"
        className="models-view-nav mb-2 space-y-1.5"
      >
        {VIEW_ITEMS.filter((item) => item.view === "runs").map(
          ({ view, label, unit }) => {
            const active = activeView === view;
            const count = viewCounts[view];
            return (
              <HudButton
                key={view}
                type="button"
                variant="ghost"
                aria-current={active ? "page" : undefined}
                aria-pressed={active}
                aria-label={`${label}, ${count} ${unit}`}
                data-view={view}
                data-selected={active ? "true" : "false"}
                onClick={() => onViewChange(view)}
                className={`!flex min-h-12 !w-full !flex-col !items-start !justify-center !gap-0.5 !rounded-md !border !px-2.5 !py-2 !text-left ${
                  active
                    ? "!border-mint/50 !bg-mint/10 !text-mint"
                    : "!border-line/60 !bg-void/30 !text-muted hover:!border-line hover:!text-bone"
                }`}
              >
                <span className="text-[0.75rem] font-semibold leading-none">
                  {label}
                </span>
                <span className="font-mono text-[0.6875rem] tabular-nums leading-none text-bone">
                  {count} {unit}
                </span>
              </HudButton>
            );
          },
        )}
        <p className="px-0.5 pt-1 font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-muted">
          Catalogs
        </p>
        <div className="flex flex-wrap gap-1 rounded-lg bg-void/50 p-1">
          {VIEW_ITEMS.filter((item) => item.view !== "runs").map(
            ({ view, label, unit }) => {
              const active = activeView === view;
              const count = viewCounts[view];
              return (
                <HudButton
                  key={view}
                  type="button"
                  variant="ghost"
                  aria-current={active ? "page" : undefined}
                  aria-pressed={active}
                  aria-label={`${label}, ${count} ${unit}`}
                  data-view={view}
                  data-selected={active ? "true" : "false"}
                  onClick={() => onViewChange(view)}
                  className={`!flex min-h-11 min-w-[4.5rem] flex-1 !flex-col !items-start !justify-center !gap-0.5 !rounded-md !border-0 !px-2 !py-1.5 !text-left ${
                    active
                      ? "!bg-panel-2 !text-mint"
                      : "!bg-transparent !text-muted hover:!bg-panel-2/80 hover:!text-bone"
                  }`}
                >
                  <span className="text-[0.625rem] font-semibold leading-none">
                    {label}
                  </span>
                  <span className="font-mono text-[0.6875rem] tabular-nums leading-none text-bone">
                    {count}
                  </span>
                </HudButton>
              );
            },
          )}
        </div>
      </nav>

      {viewModels.length > 0 ? (
        <div
          role="list"
          className="grid max-h-[28rem] gap-1.5 overflow-y-auto panel-scroll"
          data-run-count={viewModels.length}
        >
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
                    <span className="mt-0.5 block font-mono text-[0.625rem] tabular-nums text-muted">
                      {viewModel.job.targetParamsB
                        ? `${formatParams(viewModel.job.targetParamsB)} · `
                        : ""}
                      {viewModel.allocatedPf.toFixed(2)} PF/d
                      {" · "}
                      {viewModel.etaLabel}
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
                      label={`${viewModel.stageLabel} · ${Math.round(viewModel.stageProgress * 100)}%`}
                      detail={viewModel.etaLabel}
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
          <p className="text-[0.6875rem] font-semibold text-bone">No runs</p>
        </div>
      )}
    </aside>
  );
}

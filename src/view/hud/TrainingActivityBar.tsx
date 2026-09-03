import { Brain, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { useMemo } from "react";
import type { SimState } from "../../sim/types";
import { useGameStore } from "../../store/gameStore";
import { runActivityViewModel } from "./runViewModel";
import { MeterBar } from "./ui/kit";
import { StatusChip } from "./ui/HudPrimitives";

/** Responsive strip contract mirrored by the mobile shell CSS. */
// oxlint-disable-next-line react/only-export-components
export function mobileTrainingActivityRect({
  viewportWidth,
  viewportHeight,
  mobileNavHeight,
  stripHeight,
  safeLeft = 0,
  safeRight = 0,
}: {
  viewportWidth: number;
  viewportHeight: number;
  mobileNavHeight: number;
  stripHeight: number;
  safeLeft?: number;
  safeRight?: number;
}) {
  const left = safeLeft;
  const right = viewportWidth - safeRight;
  const bottom = viewportHeight - mobileNavHeight;
  const top = bottom - stripHeight;
  return {
    left,
    right,
    top,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** Desktop strip contract: span the operational shell from the rail to the intel dock. */
// oxlint-disable-next-line react/only-export-components
export function desktopTrainingActivityRect({
  viewportWidth,
  railWidth,
  intelWidth,
}: {
  viewportWidth: number;
  railWidth: number;
  intelWidth: number;
}) {
  const left = Math.max(0, railWidth);
  const right = Math.max(left, viewportWidth - Math.max(0, intelWidth));
  return {
    left,
    right,
    top: 0,
    bottom: 0,
    width: Math.max(0, right - left),
    height: 0,
  };
}

/** The global summary yields to the Models panel while its detailed queue is visible. */
// oxlint-disable-next-line react/only-export-components
export function shouldSuppressTrainingSummary(
  workspaceOpen: boolean,
  activePanel: string,
): boolean {
  return workspaceOpen && activePanel === "models";
}

/**
 * Pointer into the Models workspace. The strip is not a control surface:
 * every activation opens Models.
 */
interface TrainingActivityBarProps {
  onOpenModels?: () => void;
  /** @deprecated V4 activity strip is a pointer; run targeting lives in Models. */
  onOpenModelsRun?: (jobId: string) => void;
  /** Test seam — production reads the game store. */
  state?: SimState;
}

export function TrainingActivityBar({
  onOpenModels,
  state: stateOverride,
}: TrainingActivityBarProps) {
  const storeState = useGameStore((s) => s.state);
  const state = stateOverride ?? storeState;
  const activePanel = useGameStore((s) => s.activePanel);
  const workspaceOpen = useGameStore((s) => s.leftRailOpen);
  const setPanel = useGameStore((s) => s.setPanel);
  const activity = useMemo(() => runActivityViewModel(state), [state]);
  const suppressSummary = shouldSuppressTrainingSummary(workspaceOpen, activePanel);

  const openModels = () => {
    if (onOpenModels) {
      onOpenModels();
      return;
    }
    setPanel("models");
  };

  const pct = activity ? Math.round(activity.progress * 100) : 0;
  const etaLabel =
    activity == null
      ? ""
      : activity.pendingDecision
        ? "Decision needed"
        : Number.isFinite(activity.etaDays)
          ? `~${Math.max(0, Math.ceil(activity.etaDays))}d`
          : "Stalled";

  return (
    <aside
      className="training-activity-bar pointer-events-none absolute px-2"
      data-job-count={activity ? 1 + activity.secondaryCount : 0}
      data-active-count={activity ? 1 + activity.secondaryCount : 0}
      data-issue-count={activity?.pendingDecision ? 1 : 0}
      data-ready-count={0}
      data-summary-suppressed={suppressSummary ? "true" : "false"}
      aria-label="Training activity"
    >
      <div
        className="training-activity-bar__surface hud-surface flex min-h-12 w-full min-w-0 cursor-pointer flex-col gap-1.5 rounded-lg px-2.5 py-1.5"
        data-open-models="true"
        data-mobile-summary="training"
        onClick={openModels}
      >
        {activity?.pendingDecision ? (
          <div
            data-decision-needed="true"
            className="pointer-events-none flex min-h-11 w-full items-center justify-between gap-2 rounded-md border border-amber/50 bg-amber/15 px-2.5 text-left"
          >
            <span className="min-w-0">
              <span className="block font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-amber">
                Decision needed
              </span>
              <span className="block truncate text-[0.8125rem] font-semibold text-bone">
                {activity.name}
              </span>
            </span>
            <StatusChip tone="warning">Open Models</StatusChip>
          </div>
        ) : null}
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex shrink-0 items-center gap-2 border-r border-line/60 pr-2.5">
            <Brain size="1rem" weight="duotone" className="text-train" aria-hidden />
            {activity ? (
              <div
                className={`training-activity-bar__summary hidden min-w-0 sm:block ${suppressSummary ? "training-activity-bar__summary--suppressed" : ""}`}
                data-mobile-detail="secondary"
              >
                <p className="hud-eyebrow">Training activity</p>
                <p className="truncate text-[0.75rem] text-bone">
                  {activity.name}
                  {activity.secondaryCount > 0 ? ` · +${activity.secondaryCount} more` : ""}
                </p>
              </div>
            ) : (
              <span
                className={`text-[0.6875rem] font-medium text-muted ${suppressSummary ? "training-activity-bar__summary--suppressed" : ""}`}
              >
                Idle
              </span>
            )}
            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {activity
                ? `${activity.name}: ${pct}%, P50 ${activity.band.p50.toFixed(0)}, ${etaLabel}`
                : "No model training runs are active."}
            </span>
          </div>

          <div
            className="training-activity-bar__list flex min-w-0 flex-1 flex-wrap content-start items-stretch gap-1.5 overflow-y-auto panel-scroll"
            data-empty={activity ? "false" : "true"}
            data-job-count={activity ? 1 : 0}
            aria-label="Training runs"
          >
            {activity ? (
              <article
                className="training-activity-bar__item flex min-w-[11rem] max-w-[18rem] flex-[1_1_11rem] items-center gap-1.5 rounded-md border border-line/70 bg-panel-2/75 px-2 py-1.5"
                data-run-id={activity.runId}
                data-kind={activity.kind}
                data-pending-decision={activity.pendingDecision ? "true" : "false"}
                title={`${activity.name} · ${activity.sizeLabel} · P50 ${activity.band.p50.toFixed(0)} · ${etaLabel}`}
              >
                <span className={activity.pendingDecision ? "text-amber" : "text-train"}>
                  {activity.pendingDecision ? (
                    <WarningCircle size="1rem" weight="fill" aria-hidden />
                  ) : (
                    <Brain size="1rem" weight="duotone" aria-hidden />
                  )}
                </span>
                <div className="min-w-0 flex-1 text-left">
                  <span className="flex min-w-0 items-center justify-between gap-1">
                    <span className="min-w-0 truncate text-[0.75rem] font-semibold text-bone">
                      {activity.name}
                    </span>
                    <StatusChip tone={activity.pendingDecision ? "warning" : "train"}>
                      {activity.sizeLabel}
                    </StatusChip>
                  </span>
                  <div className="training-activity-bar__meter mt-1" data-mobile-detail="progress">
                    <MeterBar
                      label={`${pct}%`}
                      value={activity.progress}
                      detail={
                        activity.pendingDecision
                          ? "Decision needed"
                          : `P50 ${activity.band.p50.toFixed(0)} · ${etaLabel}`
                      }
                      tone={activity.pendingDecision ? "warning" : "train"}
                      live={!activity.pendingDecision}
                    />
                  </div>
                </div>
                {activity.secondaryCount > 0 ? (
                  <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-muted">
                    +{activity.secondaryCount} more
                  </span>
                ) : null}
              </article>
            ) : (
              <div
                className="flex min-w-0 flex-1 items-center gap-2 px-2 text-[0.75rem] text-muted"
                aria-hidden="true"
              >
                <CheckCircle size="1rem" className="text-mint" aria-hidden />
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

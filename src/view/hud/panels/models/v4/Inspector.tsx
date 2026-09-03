import { useMemo, useState } from "react";
import type { SimState } from "../../../../../sim/types";
import { useGameStore } from "../../../../../store/gameStore";
import { trainingStateOf } from "../../../../../sim/training/state";
import { computeSnapshot } from "../../../../../sim/systems/compute";
import type { CheckpointAction, ModelsSelection } from "../viewModels/types";
import {
  selectCheckpointCard,
  selectLineage,
  selectRecipeCard,
  selectRunCard,
} from "../viewModels/selectors";
import { ArchGlyph } from "../ui/ArchGlyph";
import { OverallScoreStat } from "../ui/CapabilityBandChip";
import { MonoStat } from "../ui/MonoStat";
import { HudButton, HudCloseButton, StatusChip } from "../../../ui/HudPrimitives";
import { SliderField } from "../../../ui/SliderField";
import { money } from "../../../format";
import { LineageStrip } from "./LineageStrip";
import { IncidentModal } from "./IncidentModal";
import { EvalRadar, LossSpark } from "./EvalCharts";
import { useModelsUi } from "./modelsUiStore";
import { postStageLabel } from "../../../../../sim/training/naming";

const ACTION_LABEL: Record<CheckpointAction, string> = {
  continue: "Continue",
  branch: "Branch",
  distill: "Distill",
  postTrain: "Post-train",
  evaluate: "Eval",
  release: "Release",
  merge: "Merge",
  keep: "Keep",
  discard: "Discard",
  openSource: "Open source",
};

const LINEAGE_ACTIONS = new Set<CheckpointAction>(["continue", "branch", "distill", "merge"]);
const IMPROVE_ACTIONS = new Set<CheckpointAction>([
  "postTrain",
  "evaluate",
  "release",
  "keep",
  "openSource",
]);

function groupCheckpointActions(actions: CheckpointAction[]) {
  return {
    lineage: actions.filter((action) => LINEAGE_ACTIONS.has(action)),
    improve: actions.filter((action) => IMPROVE_ACTIONS.has(action)),
    danger: actions.filter((action) => action === "discard"),
  };
}

export function TwoStepAction({
  label,
  confirmLabel,
  confirming,
  onArm,
  onConfirm,
  onCancel,
  variant = "danger",
}: {
  label: string;
  confirmLabel: string;
  confirming?: boolean;
  onArm?: () => void;
  onConfirm: () => void;
  onCancel?: () => void;
  variant?: "danger" | "secondary";
}) {
  const [armed, setArmed] = useState(false);
  const open = confirming ?? armed;
  if (open) {
    return (
      <div className="flex flex-wrap gap-1.5" data-confirm-step={label.toLowerCase()}>
        <HudButton variant={variant} className="min-h-11" onClick={onConfirm}>
          {confirmLabel}
        </HudButton>
        <HudButton
          variant="ghost"
          className="min-h-11"
          onClick={() => {
            setArmed(false);
            onCancel?.();
          }}
        >
          Cancel
        </HudButton>
      </div>
    );
  }
  return (
    <HudButton
      variant={variant}
      className="min-h-11"
      data-action={label.toLowerCase()}
      onClick={() => {
        setArmed(true);
        onArm?.();
      }}
    >
      {label}
    </HudButton>
  );
}

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function mixRows(mix: Partial<Record<string, number>>): string[] {
  return Object.entries(mix)
    .filter(([, value]) => (value ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([domain, value]) => `${titleCase(domain)} ${Math.round((value ?? 0) * 100)}%`);
}

export function Inspector({
  state: stateProp,
  selection: selectionProp,
}: {
  state?: SimState;
  selection?: ModelsSelection;
}) {
  const hookedState = useGameStore((store) => store.state);
  const pauseRun = useGameStore((store) => store.pauseRun);
  const resumeRun = useGameStore((store) => store.resumeRun);
  const cancelRun = useGameStore((store) => store.cancelRun);
  const snapshotCheckpoint = useGameStore((store) => store.snapshotCheckpoint);
  const setRunPriority = useGameStore((store) => store.setRunPriority);
  const setRunPfPerDay = useGameStore((store) => store.setRunPfPerDay);
  const keepCheckpoint = useGameStore((store) => store.keepCheckpoint);
  const discardCheckpoint = useGameStore((store) => store.discardCheckpoint);
  const openSourceCheckpoint = useGameStore((store) => store.openSourceCheckpoint);
  const cancelRecipe = useGameStore((store) => store.cancelRecipe);

  const hookedSelection = useModelsUi((store) => store.selection);
  const select = useModelsUi((store) => store.select);
  const openDialog = useModelsUi((store) => store.openDialog);
  const state = stateProp ?? hookedState;
  const selection = selectionProp !== undefined ? selectionProp : hookedSelection;

  const [incidentOpen, setIncidentOpen] = useState(false);
  const [confirming, setConfirming] = useState<null | "discard" | "openSource">(null);

  const training = trainingStateOf(state, state.playerLabId);
  const trainingPf = useMemo(() => {
    try {
      return Math.max(0, computeSnapshot(state).pools.training);
    } catch {
      return 0;
    }
  }, [state]);
  const run = selection?.kind === "run" ? training.runs.find((entry) => entry.id === selection.id) : undefined;
  const runCard = selection?.kind === "run" ? selectRunCard(state, selection.id) : null;
  const checkpointCard =
    selection?.kind === "checkpoint" ? selectCheckpointCard(state, selection.id) : null;
  const recipeCard = selection?.kind === "recipe" ? selectRecipeCard(state, selection.id) : null;
  const lineage = useMemo(
    () => (checkpointCard ? selectLineage(state, checkpointCard.id) : []),
    [state, checkpointCard],
  );

  const pendingIncident = run?.incidents.find((incident) => incident.resolvedChoiceId == null);
  const empty = selection == null || (runCard == null && checkpointCard == null && recipeCard == null);

  const fireCheckpointAction = (action: CheckpointAction) => {
    if (!checkpointCard) return;
    const id = checkpointCard.id;
    if (action === "continue") {
      openDialog({ kind: "design", goal: "continue", parentCheckpointId: id });
      return;
    }
    if (action === "branch") {
      openDialog({ kind: "design", goal: "continue", parentCheckpointId: id });
      return;
    }
    if (action === "distill") {
      openDialog({ kind: "distill", teacherCheckpointId: id });
      return;
    }
    if (action === "postTrain") {
      openDialog({ kind: "postTrain", checkpointId: id });
      return;
    }
    if (action === "evaluate") {
      openDialog({ kind: "evaluate", checkpointId: id });
      return;
    }
    if (action === "release") {
      openDialog({ kind: "release", checkpointId: id });
      return;
    }
    if (action === "merge") {
      openDialog({ kind: "merge", aId: id });
      return;
    }
    if (action === "keep") {
      keepCheckpoint(id);
      return;
    }
    if (action === "discard") {
      discardCheckpoint(id);
      setConfirming(null);
      select(null);
      return;
    }
    if (action === "openSource") {
      openSourceCheckpoint(id);
      setConfirming(null);
    }
  };

  if (empty) return null;

  return (
    <aside
      className="models-v4-inspector models-v4-inspector--sheet"
      data-inspector="true"
      aria-label="Inspector"
    >
      <HudCloseButton
        label="Close inspector"
        className="models-v4-inspector__close min-h-11 min-w-11"
        onClick={() => select(null)}
      />
      <div className="models-v4-inspector__scroll">
      <h3 className="mb-3 pr-12 text-sm font-semibold text-bone">Inspector</h3>

      {runCard && run ? (
        <div className="space-y-3" data-inspector-kind="run">
          <header className="flex min-w-0 items-center gap-2">
            <ArchGlyph kind={runCard.glyph} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-bone">{runCard.name}</p>
              <p className="font-mono text-[0.625rem] text-muted">{runCard.sizeLabel}</p>
            </div>
            <StatusChip tone={runCard.pendingDecision ? "danger" : "train"}>
              {runCard.pendingDecision ? "Decision needed" : titleCase(runCard.status)}
            </StatusChip>
          </header>
          <div className="grid grid-cols-2 gap-1.5">
            <OverallScoreStat band={runCard.band} />
            <MonoStat
              label="Loss"
              value={runCard.lastLoss != null ? runCard.lastLoss.toFixed(3) : "-"}
            />
            <MonoStat label="Progress" value={`${Math.round(runCard.progress * 100)}%`} />
            <MonoStat label="ETA" value={`${runCard.etaDays.toFixed(1)}d`} />
            <MonoStat label="Burn" value={`${money(runCard.burnPerDay)}/d`} tone="warn" />
            <MonoStat
              label="Allocated PF"
              value={runCard.pfAllocated.toFixed(2)}
              hint={`${runCard.pfDaysDone.toFixed(1)} / ${runCard.pfDaysTotal.toFixed(1)} PF-d`}
            />
          </div>
          <LossSpark samples={runCard.lossCurve} />
          <SliderField
            label="Priority"
            value={run.design.compute.priority}
            min={1}
            max={5}
            step={1}
            format={(value) => String(value)}
            colorClass="bg-train"
            onChange={(value) => setRunPriority(run.id, value)}
          />
          <SliderField
            label="Requested PF / day"
            value={run.design.compute.pfPerDay}
            min={0}
            max={Math.max(trainingPf, run.design.compute.pfPerDay, 0.01)}
            step={0.01}
            format={(value) => `${value.toFixed(2)} PF`}
            colorClass="bg-train"
            onChange={(value) => setRunPfPerDay(run.id, value)}
            sublabel={
              <span className="font-mono text-[0.625rem] text-muted">
                Getting {runCard.pfAllocated.toFixed(2)} PF today among running jobs
              </span>
            }
          />
          <div className="models-v4-inspector-actions" data-inspector-actions="run">
            {run.status === "paused" ? (
              <HudButton variant="primary" className="min-h-11" onClick={() => resumeRun(run.id)}>
                Resume
              </HudButton>
            ) : (
              <HudButton
                variant="secondary"
                className="min-h-11"
                disabled={run.status === "awaiting_decision"}
                disabledReason="Resolve the incident first."
                onClick={() => pauseRun(run.id)}
              >
                Pause
              </HudButton>
            )}
            <HudButton variant="secondary" className="min-h-11" onClick={() => snapshotCheckpoint(run.id)}>
              Checkpoint
            </HudButton>
            <HudButton variant="danger" className="min-h-11" onClick={() => cancelRun(run.id)}>
              Cancel
            </HudButton>
            {pendingIncident ? (
              <HudButton variant="primary" className="min-h-11" onClick={() => setIncidentOpen(true)}>
                Decision needed
              </HudButton>
            ) : null}
          </div>
          <IncidentModal
            open={incidentOpen}
            runId={run.id}
            incident={pendingIncident ?? null}
            onClose={() => setIncidentOpen(false)}
          />
        </div>
      ) : null}

      {checkpointCard ? (
        <div className="space-y-3" data-inspector-kind="checkpoint">
          <header className="flex min-w-0 items-center gap-2">
            <ArchGlyph kind={checkpointCard.glyph} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-bone">
                {checkpointCard.name} {checkpointCard.version}
              </p>
              <p className="font-mono text-[0.625rem] text-muted">{checkpointCard.sizeLabel}</p>
            </div>
            <StatusChip>{titleCase(checkpointCard.status)}</StatusChip>
          </header>
          <LineageStrip
            roots={lineage}
            onSelect={(id) => select({ kind: "checkpoint", id })}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <OverallScoreStat band={checkpointCard.band} />
            <MonoStat
              label="Loss"
              value={checkpointCard.lastLoss != null ? checkpointCard.lastLoss.toFixed(3) : "-"}
            />
            <MonoStat label="Created" value={`D${checkpointCard.createdDay}`} />
            <MonoStat label="Depth" value={String(checkpointCard.lineageDepth)} />
            <MonoStat
              label="Train PF-d"
              value={checkpointCard.pfDays.toFixed(1)}
            />
            <MonoStat label="Endpoints" value={String(checkpointCard.endpointIds.length)} />
          </div>
          <LossSpark samples={checkpointCard.lossCurve} />
          <div className="space-y-1.5" data-inspector-options="true">
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">Options</p>
            <p className="font-mono text-[0.6875rem] leading-4 text-bone">
              {checkpointCard.sizeLabel} · {titleCase(checkpointCard.backbone)} · {checkpointCard.precision.replace(/_/g, " ").toUpperCase()} · {titleCase(checkpointCard.preset)}
            </p>
            <p className="font-mono text-[0.625rem] text-muted">
              in {checkpointCard.inputs.join("/")} · out {checkpointCard.outputs.join("/")}
            </p>
            <p className="font-mono text-[0.625rem] text-muted">
              {mixRows(checkpointCard.dataMix).join(" · ") || "No mix recorded"}
              {checkpointCard.syntheticShare > 0
                ? ` · synth ${Math.round(checkpointCard.syntheticShare * 100)}%`
                : ""}
            </p>
          </div>
          <div className="space-y-1.5" data-inspector-post="true">
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">Post-training</p>
            {checkpointCard.postStages.length === 0 ? (
              <p className="font-mono text-[0.6875rem] text-muted">
                {checkpointCard.stage === "post"
                  ? "Post-trained. More recipes still allowed."
                  : "No post-training yet."}
              </p>
            ) : (
              <ul className="space-y-1">
                {checkpointCard.postStages.map((row) => (
                  <li
                    key={row.kind}
                    className="flex min-w-0 items-baseline justify-between gap-2 font-mono text-[0.6875rem]"
                  >
                    <span className="truncate text-bone">{postStageLabel(row.kind)}</span>
                    <span className="shrink-0 tabular-nums text-muted">
                      {row.runs}× · {row.pfDays.toFixed(1)} PF-d · +{row.effect.toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {checkpointCard.safetyFocus != null ? (
              <p className="font-mono text-[0.625rem] text-muted">
                Safety focus {Math.round(checkpointCard.safetyFocus * 100)}%
              </p>
            ) : null}
          </div>
          {Object.keys(checkpointCard.measured).length > 0 ? (
            <div className="space-y-3" data-eval-table="true">
              <EvalRadar measured={checkpointCard.measured} />
            </div>
          ) : (
            <p className="font-mono text-[0.6875rem] text-muted">Unmeasured. Order an Eval to get a band.</p>
          )}
          {(() => {
            const groups = groupCheckpointActions(checkpointCard.actions);
            const renderAction = (action: CheckpointAction) => {
              const lock = checkpointCard.actionLocks[action];
              if (action === "discard") {
                if (lock) {
                  return (
                    <div key={action} className="models-v4-action">
                      <HudButton
                        variant="ghost"
                        className="min-h-11 min-w-0 models-v4-action--locked"
                        title={lock}
                        disabledReason={lock}
                        disabled
                        data-action="discard"
                        data-action-lock="discard"
                        data-locked="true"
                      >
                        Discard
                      </HudButton>
                    </div>
                  );
                }
                return (
                  <div key={action} className="models-v4-action">
                    <TwoStepAction
                      label={ACTION_LABEL[action]}
                      confirmLabel="Confirm discard"
                      confirming={confirming === "discard"}
                      onArm={() => setConfirming("discard")}
                      onCancel={() => setConfirming(null)}
                      onConfirm={() => fireCheckpointAction("discard")}
                    />
                  </div>
                );
              }
              if (action === "openSource") {
                return (
                  <div key={action} className="models-v4-action">
                    <TwoStepAction
                      label={ACTION_LABEL[action]}
                      confirmLabel="Confirm open source"
                      confirming={confirming === "openSource"}
                      variant="secondary"
                      onArm={() => setConfirming("openSource")}
                      onCancel={() => setConfirming(null)}
                      onConfirm={() => fireCheckpointAction("openSource")}
                    />
                    <p className="font-mono text-[0.625rem] text-muted">
                      Hosted plan and API demand ease. Brand reputation rises.
                    </p>
                  </div>
                );
              }
              return (
                <div key={action} className="models-v4-action">
                  <HudButton
                    variant={lock ? "ghost" : action === "release" ? "primary" : "secondary"}
                    className={`min-h-11 min-w-0 ${lock ? "models-v4-action--locked" : ""}`}
                    title={
                      lock ??
                      (action === "branch"
                        ? "Opens a continue Model design from this Checkpoint."
                        : undefined)
                    }
                    disabled={Boolean(lock)}
                    disabledReason={lock}
                    data-action={action}
                    data-action-lock={lock ? action : undefined}
                    data-locked={lock ? "true" : undefined}
                    onClick={() => {
                      if (lock) return;
                      fireCheckpointAction(action);
                    }}
                  >
                    {ACTION_LABEL[action]}
                  </HudButton>
                </div>
              );
            };
            return (
              <div className="space-y-3" data-inspector-actions="checkpoint">
                {groups.lineage.length > 0 ? (
                  <div>
                    <p className="mb-1.5 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
                      Lineage
                    </p>
                    <div className="models-v4-inspector-actions">{groups.lineage.map(renderAction)}</div>
                  </div>
                ) : null}
                {groups.improve.length > 0 ? (
                  <div>
                    <p className="mb-1.5 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
                      Improve
                    </p>
                    <div className="models-v4-inspector-actions">{groups.improve.map(renderAction)}</div>
                  </div>
                ) : null}
                {groups.danger.length > 0 ? (
                  <div>
                    <p className="mb-1.5 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
                      Remove
                    </p>
                    <div className="models-v4-inspector-actions">{groups.danger.map(renderAction)}</div>
                  </div>
                ) : null}
              </div>
            );
          })()}
        </div>
      ) : null}

      {recipeCard ? (
        <div className="space-y-3" data-inspector-kind="recipe">
          <header className="min-w-0">
            <p className="truncate text-sm font-semibold text-bone">{recipeCard.checkpointName}</p>
            <p className="font-mono text-[0.625rem] text-muted">{titleCase(recipeCard.status)}</p>
          </header>
          <div className="grid grid-cols-2 gap-1.5">
            <MonoStat label="Progress" value={`${Math.round(recipeCard.progress * 100)}%`} />
            <MonoStat
              label="ETA"
              value={Number.isFinite(recipeCard.etaDays) ? `${recipeCard.etaDays.toFixed(1)}d` : "—"}
            />
            <MonoStat label="Burn" value={`${money(recipeCard.burnPerDay)}/d`} tone="warn" />
            <MonoStat label="PF today" value={`${recipeCard.pfAllocated.toFixed(2)}`} />
          </div>
          <HudButton variant="danger" className="min-h-11" onClick={() => cancelRecipe(recipeCard.id)}>
            Cancel
          </HudButton>
        </div>
      ) : null}
      </div>
    </aside>
  );
}

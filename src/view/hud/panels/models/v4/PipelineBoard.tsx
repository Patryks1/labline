import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { useGameStore } from "../../../../../store/gameStore";
import { ModelCard } from "./ModelCard";
import { useModelsUi } from "./modelsUiStore";
import {
  dropActionFor,
  dropStateFor,
  PIPELINE_DRAG_MIME,
  type PipelineColumnId,
  type PipelineDragPayload,
} from "./pipelineDrag";
import { selectPipelineBoard } from "../viewModels/selectors";
import type {
  CheckpointCardVM,
  ModelsSelection,
  PipelineBoardVM,
  RecipeCardVM,
  RunCardVM,
} from "../viewModels/types";

const EMPTY_COPY: Record<PipelineColumnId, string> = {
  training: "Drop a base checkpoint here to continue training",
  checkpoints: "Drop a running job here to snapshot",
  postTraining: "Drop a checkpoint here to start a recipe",
  ready: "Nothing ready to release",
};

function TrainingComputeNote({
  allocated,
  pool,
  hint,
}: {
  allocated: number;
  pool: number;
  hint: string;
}) {
  return (
    <div className="models-v4-compute" data-compute-split="true">
      <p className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
        Compute {allocated.toFixed(1)} / {pool.toFixed(1)} PF
      </p>
      <p className="mt-1 font-mono text-[0.625rem] leading-4 text-muted">{hint}</p>
    </div>
  );
}

function isSelected(
  selection: ModelsSelection,
  kind: NonNullable<ModelsSelection>["kind"],
  id: string,
): boolean {
  return selection?.kind === kind && selection.id === id;
}

function PipelineColumn({
  id,
  label,
  count,
  children,
  footer,
  dropState,
  onDragOver,
  onDrop,
}: {
  id: PipelineColumnId;
  label: string;
  count: number;
  children: ReactNode;
  footer?: ReactNode;
  dropState: "ok" | "blocked" | null;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}) {
  return (
    <section
      className="models-v4-column"
      data-pipeline-column={id}
      data-drop-state={dropState ?? undefined}
      aria-label={label}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <header className="models-v4-column__head">
        <h3 className="text-sm font-semibold text-bone">{label}</h3>
        <span className="font-mono text-[0.6875rem] tabular-nums text-muted" data-column-count={id}>
          {count}
        </span>
      </header>
      {footer}
      <div className="models-v4-column__cards">
        {count === 0 ? (
          <p className="font-mono text-[0.6875rem] text-muted">{EMPTY_COPY[id]}</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

export function PipelineBoard({ board }: { board?: PipelineBoardVM }) {
  const state = useGameStore((store) => store.state);
  const snapshotCheckpoint = useGameStore((store) => store.snapshotCheckpoint);
  const discardCheckpoint = useGameStore((store) => store.discardCheckpoint);
  const selection = useModelsUi((store) => store.selection);
  const select = useModelsUi((store) => store.select);
  const openDialog = useModelsUi((store) => store.openDialog);
  const resolved = board ?? selectPipelineBoard(state);
  const pool = resolved.trainingPfPool ?? 0;
  const recipeAllocated = resolved.postTraining.reduce((sum, card) => sum + card.pfAllocated, 0);
  const [payload, setPayload] = useState<PipelineDragPayload | null>(null);
  const payloadRef = useRef<PipelineDragPayload | null>(null);
  const [hover, setHover] = useState<PipelineColumnId | null>(null);

  const checkpointMeta = (id: string) => {
    const card =
      resolved.checkpoints.find((row) => row.id === id) ??
      resolved.ready.find((row) => row.id === id);
    return card ? { stage: card.stage } : undefined;
  };

  const currentPayload = () => payloadRef.current ?? payload;

  const beginDrag = (next: PipelineDragPayload) => (event: DragEvent<HTMLButtonElement>) => {
    event.dataTransfer.setData(PIPELINE_DRAG_MIME, JSON.stringify(next));
    event.dataTransfer.setData("text/plain", next.id);
    event.dataTransfer.effectAllowed = "move";
    payloadRef.current = next;
    setPayload(next);
  };

  const endDrag = () => {
    payloadRef.current = null;
    setPayload(null);
    setHover(null);
  };

  const dragMeta = () => {
    const current = currentPayload();
    return current?.kind === "checkpoint" ? checkpointMeta(current.id) : undefined;
  };

  const discardCard = (id: string) => {
    discardCheckpoint(id);
    if (selection?.kind === "checkpoint" && selection.id === id) {
      select(null);
    }
  };

  const onColumnDragOver = (column: PipelineColumnId) => (event: DragEvent<HTMLElement>) => {
    const current = currentPayload();
    if (!current) return;
    const action = dropActionFor(current, column, dragMeta());
    setHover(column);
    if (action.type === "none") {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const onColumnDrop = (column: PipelineColumnId) => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const current = currentPayload();
    payloadRef.current = null;
    setPayload(null);
    setHover(null);
    if (!current) return;
    const action = dropActionFor(
      current,
      column,
      current.kind === "checkpoint" ? checkpointMeta(current.id) : undefined,
    );
    if (action.type === "continue") {
      select({ kind: "checkpoint", id: action.checkpointId });
      openDialog({ kind: "design", goal: "continue", parentCheckpointId: action.checkpointId });
      return;
    }
    if (action.type === "postTrain") {
      select({ kind: "checkpoint", id: action.checkpointId });
      openDialog({ kind: "postTrain", checkpointId: action.checkpointId });
      return;
    }
    if (action.type === "snapshot") {
      snapshotCheckpoint(action.runId);
      select({ kind: "run", id: action.runId });
    }
  };

  return (
    <div className="models-v4-pipeline" data-pipeline-board="true">
      <PipelineColumn
        id="training"
        label="Training"
        count={resolved.training.length}
        dropState={dropStateFor(payload, "training", hover, dragMeta())}
        onDragOver={onColumnDragOver("training")}
        onDrop={onColumnDrop("training")}
        footer={
          <TrainingComputeNote
            allocated={resolved.trainingPfAllocated ?? 0}
            pool={pool}
            hint="Split by priority among runs and post-train recipes. Cap a run's requested PF/day in the inspector to leave more for the rest. Drop a base checkpoint here to continue training."
          />
        }
      >
        {resolved.training.map((card: RunCardVM) => (
          <ModelCard
            key={card.id}
            variant="run"
            card={card}
            selected={isSelected(selection, "run", card.id)}
            onSelect={() => select({ kind: "run", id: card.id })}
            onDragStart={beginDrag({ kind: "run", id: card.id })}
            onDragEnd={endDrag}
          />
        ))}
      </PipelineColumn>
      <PipelineColumn
        id="checkpoints"
        label="Checkpoints"
        count={resolved.checkpoints.length}
        dropState={dropStateFor(payload, "checkpoints", hover, dragMeta())}
        onDragOver={onColumnDragOver("checkpoints")}
        onDrop={onColumnDrop("checkpoints")}
      >
        {resolved.checkpoints.map((card: CheckpointCardVM) => (
          <ModelCard
            key={card.id}
            variant="checkpoint"
            card={card}
            selected={isSelected(selection, "checkpoint", card.id)}
            onSelect={() => select({ kind: "checkpoint", id: card.id })}
            onDragStart={beginDrag({ kind: "checkpoint", id: card.id })}
            onDragEnd={endDrag}
            onDiscard={() => discardCard(card.id)}
          />
        ))}
      </PipelineColumn>
      <PipelineColumn
        id="postTraining"
        label="Post-training"
        count={resolved.postTraining.length}
        dropState={dropStateFor(payload, "postTraining", hover, dragMeta())}
        onDragOver={onColumnDragOver("postTraining")}
        onDrop={onColumnDrop("postTraining")}
        footer={
          <TrainingComputeNote
            allocated={recipeAllocated}
            pool={pool}
            hint="Recipes draw from the training pool and stall when that pool is empty. Drop a checkpoint here to choose recipe settings."
          />
        }
      >
        {resolved.postTraining.map((card: RecipeCardVM) => (
          <ModelCard
            key={card.id}
            variant="recipe"
            card={card}
            selected={isSelected(selection, "recipe", card.id)}
            onSelect={() => select({ kind: "recipe", id: card.id })}
          />
        ))}
      </PipelineColumn>
      <PipelineColumn
        id="ready"
        label="Ready"
        count={resolved.ready.length}
        dropState={dropStateFor(payload, "ready", hover, dragMeta())}
        onDragOver={onColumnDragOver("ready")}
        onDrop={onColumnDrop("ready")}
      >
        {resolved.ready.map((card: CheckpointCardVM) => (
          <ModelCard
            key={card.id}
            variant="checkpoint"
            card={card}
            selected={isSelected(selection, "checkpoint", card.id)}
            onSelect={() => select({ kind: "checkpoint", id: card.id })}
            onDragStart={beginDrag({ kind: "checkpoint", id: card.id })}
            onDragEnd={endDrag}
            onDiscard={() => discardCard(card.id)}
          />
        ))}
      </PipelineColumn>
    </div>
  );
}

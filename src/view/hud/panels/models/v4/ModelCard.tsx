import type { DragEvent, ReactNode } from "react";
import { useState } from "react";
import { ArchGlyph } from "../ui/ArchGlyph";
import { OverallScoreStat } from "../ui/CapabilityBandChip";
import { MonoStat } from "../ui/MonoStat";
import { ProgressRing } from "../ui/ProgressRing";
import { GameCard } from "../../../ui/kit";
import { HudButton, StatusChip } from "../../../ui/HudPrimitives";
import { money } from "../../../format";
import { tierLabel } from "./fleet/fleetModel";
import { LossSpark } from "./EvalCharts";
import type {
  CheckpointCardVM,
  RecipeCardVM,
  RunCardVM,
} from "../viewModels/types";

export type ModelCardProps =
  | {
      variant: "run";
      card: RunCardVM;
      selected?: boolean;
      onSelect?: () => void;
      onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
      onDragEnd?: (event: DragEvent<HTMLButtonElement>) => void;
    }
  | {
      variant: "checkpoint";
      card: CheckpointCardVM;
      selected?: boolean;
      onSelect?: () => void;
      onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
      onDragEnd?: (event: DragEvent<HTMLButtonElement>) => void;
      onDiscard?: () => void;
    }
  | {
      variant: "recipe";
      card: RecipeCardVM;
      selected?: boolean;
      onSelect?: () => void;
    };

function daysLabel(days: number): string {
  if (!Number.isFinite(days)) return "-";
  const rounded = Math.max(0, days);
  return rounded < 10 ? `${rounded.toFixed(1)}d` : `${Math.round(rounded)}d`;
}

function runStatusTone(status: RunCardVM["status"]): "neutral" | "positive" | "warning" | "danger" | "train" {
  if (status === "running") return "train";
  if (status === "paused") return "warning";
  if (status === "awaiting_decision" || status === "failed") return "danger";
  if (status === "completed") return "positive";
  return "neutral";
}

function runStatusLabel(status: RunCardVM["status"]): string {
  if (status === "awaiting_decision") return "Decision needed";
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "paused") return "Paused";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  return "Cancelled";
}

function checkpointStatusTone(
  status: CheckpointCardVM["status"],
): "neutral" | "positive" | "warning" | "danger" | "train" {
  if (status === "released") return "positive";
  if (status === "kept") return "train";
  if (status === "stealth") return "warning";
  if (status === "sold" || status === "discarded") return "danger";
  return "neutral";
}

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function CardDiscard({
  name,
  lock,
  onDiscard,
}: {
  name: string;
  lock?: string;
  onDiscard?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (lock) {
    return (
      <HudButton
        variant="ghost"
        className="min-h-11 w-full min-w-0 models-v4-action--locked"
        disabled
        title={lock}
        disabledReason={lock}
        data-action="discard"
        data-locked="true"
      >
        Discard
      </HudButton>
    );
  }
  if (confirming) {
    return (
      <div className="flex min-w-0 flex-wrap gap-1.5" data-confirm-step="discard">
        <HudButton
          variant="danger"
          className="min-h-11 min-w-0 flex-1"
          onClick={() => {
            setConfirming(false);
            onDiscard?.();
          }}
        >
          Confirm discard
        </HudButton>
        <HudButton variant="ghost" className="min-h-11" onClick={() => setConfirming(false)}>
          Cancel
        </HudButton>
      </div>
    );
  }
  return (
    <HudButton
      variant="danger"
      className="min-h-11 w-full min-w-0"
      data-action="discard"
      aria-label={`Discard ${name}`}
      onClick={() => setConfirming(true)}
    >
      Discard
    </HudButton>
  );
}

function CardButton({
  selected,
  label,
  onSelect,
  draggable,
  onDragStart,
  onDragEnd,
  children,
}: {
  selected: boolean;
  label: string;
  onSelect?: () => void;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: (event: DragEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      onClick={onSelect}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`flex min-h-11 w-full min-w-0 flex-col gap-2 text-left ${draggable ? "models-v4-card-drag" : ""}`}
    >
      {children}
    </button>
  );
}

function CardTitle({ name, meta }: { name: string; meta: string }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="models-v4-card-title" title={name}>
        {name}
      </p>
      <p className="font-mono text-[0.625rem] text-muted">{meta}</p>
    </div>
  );
}

function RunBody({ card }: { card: RunCardVM }) {
  return (
    <>
      <div className="flex min-w-0 items-start gap-2">
        <span className="shrink-0">
          <ArchGlyph kind={card.glyph} />
        </span>
        <CardTitle name={card.name} meta={card.sizeLabel} />
        <span className="shrink-0">
          <ProgressRing value={card.progress} label={`${card.name} progress`} />
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <StatusChip tone={runStatusTone(card.status)}>{runStatusLabel(card.status)}</StatusChip>
        {card.incidentCount > 0 ? (
          <StatusChip tone={card.pendingDecision ? "danger" : "warning"}>
            {card.pendingDecision ? `Decision needed · ${card.incidentCount}` : `${card.incidentCount} incident${card.incidentCount === 1 ? "" : "s"}`}
          </StatusChip>
        ) : null}
      </div>
      <div className="models-v4-card-stats">
        <OverallScoreStat band={card.band} />
        <MonoStat
          label="Loss"
          value={card.lastLoss != null ? card.lastLoss.toFixed(2) : "-"}
        />
        <MonoStat label="Progress" value={`${Math.round(card.progress * 100)}%`} />
        <MonoStat label="ETA" value={daysLabel(card.etaDays)} />
        <MonoStat label="Burn" value={`${money(card.burnPerDay)}/d`} tone="warn" />
        <MonoStat label="PF" value={`${card.pfAllocated.toFixed(1)} · P${card.priority}`} />
      </div>
      <LossSpark samples={card.lossCurve} compact />
    </>
  );
}

function CheckpointBody({ card }: { card: CheckpointCardVM }) {
  return (
    <>
      <div className="flex min-w-0 items-start gap-2">
        <span className="shrink-0">
          <ArchGlyph kind={card.glyph} />
        </span>
        <CardTitle name={card.name} meta={`${card.sizeLabel} · ${card.version}`} />
        <span className="shrink-0">
          <StatusChip tone={card.stage === "post" ? "train" : "neutral"}>{card.stage === "post" ? "Post" : "Base"}</StatusChip>
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <StatusChip tone={checkpointStatusTone(card.status)}>{titleCase(card.status)}</StatusChip>
        {card.tiers
          .filter((tier) => tier.served)
          .map((tier) => (
            <span
              key={tier.budget}
              className="status-chip status-chip--positive max-w-full truncate font-mono"
            >
              {tierLabel(tier.budget)}
            </span>
          ))}
      </div>
      <div className="models-v4-card-stats">
        <OverallScoreStat band={card.band} />
        <MonoStat
          label="Loss"
          value={card.lastLoss != null ? card.lastLoss.toFixed(2) : "-"}
        />
        <MonoStat label="Created" value={`D${card.createdDay}`} />
        <MonoStat label="Endpoints" value={String(card.endpointIds.length)} />
      </div>
      <LossSpark samples={card.lossCurve} compact />
    </>
  );
}

function RecipeBody({ card }: { card: RecipeCardVM }) {
  return (
    <>
      <div className="flex min-w-0 items-start gap-2">
        <span className="shrink-0">
          <ProgressRing value={card.progress} label={`${card.checkpointName} recipe progress`} />
        </span>
        <CardTitle name={card.checkpointName} meta={titleCase(card.status)} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {card.stages.map((stage) => (
          <StatusChip key={stage} tone="train">
            {titleCase(stage)}
          </StatusChip>
        ))}
      </div>
      <div className="models-v4-card-stats">
        <MonoStat label="Progress" value={`${Math.round(card.progress * 100)}%`} />
        <MonoStat label="ETA" value={daysLabel(card.etaDays)} />
        <MonoStat label="Burn" value={`${money(card.burnPerDay)}/d`} tone="warn" />
        <MonoStat label="PF" value={card.pfAllocated.toFixed(1)} />
      </div>
    </>
  );
}

export function ModelCard(props: ModelCardProps) {
  const selected = props.selected === true;
  const name =
    props.variant === "run"
      ? props.card.name
      : props.variant === "checkpoint"
        ? `${props.card.name} ${props.card.version}`
        : props.card.checkpointName;
  const tone = props.variant === "run" ? "train" : props.variant === "recipe" ? "research" : undefined;
  const live = props.variant === "run" && (props.card.status === "running" || props.card.pendingDecision);

  const draggable = props.variant !== "recipe";
  const dragStart = props.variant === "recipe" ? undefined : props.onDragStart;
  const dragEnd = props.variant === "recipe" ? undefined : props.onDragEnd;
  const discardable =
    props.variant === "checkpoint" && props.card.actions.includes("discard");
  const discardLock =
    props.variant === "checkpoint" ? props.card.actionLocks.discard : undefined;

  return (
    <GameCard
      pad={false}
      selected={selected}
      tone={tone}
      live={live}
      className="min-w-0"
    >
      <CardButton
        selected={selected}
        label={name}
        onSelect={props.onSelect}
        draggable={draggable}
        onDragStart={dragStart}
        onDragEnd={dragEnd}
      >
        <div
          className="flex min-w-0 flex-col gap-1.5 p-2.5"
          data-model-card={props.variant}
          data-pipeline-drag={props.variant === "recipe" ? undefined : props.variant}
          data-card-id={
            props.variant === "run" || props.variant === "checkpoint" || props.variant === "recipe"
              ? props.card.id
              : undefined
          }
        >
          {props.variant === "run" ? <RunBody card={props.card} /> : null}
          {props.variant === "checkpoint" ? <CheckpointBody card={props.card} /> : null}
          {props.variant === "recipe" ? <RecipeBody card={props.card} /> : null}
        </div>
      </CardButton>
      {discardable ? (
        <div
          className="models-v4-card-discard"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <CardDiscard
            name={name}
            lock={discardLock}
            onDiscard={props.variant === "checkpoint" ? props.onDiscard : undefined}
          />
        </div>
      ) : null}
    </GameCard>
  );
}

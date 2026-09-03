import { useEffect, useMemo, useState } from "react";
import { TRAINING_V4 } from "../../../../../../sim/training/constants";
import { trainingStateOf } from "../../../../../../sim/training/state";
import {
  extraThinkingBudgetsToTrain,
  TIER_BUDGETS,
  THINKING_UNLOCK_REASON,
  thinkingTrainPfMult,
  trainedThinkingBudgets,
  tierLabel,
} from "../../../../../../sim/training/thinking";
import type { GymKind, PostTrainStageKind, TierBudget } from "../../../../../../sim/training/types";
import { useGameStore } from "../../../../../../store/gameStore";
import { HudButton } from "../../../../ui/HudPrimitives";
import { ConsoleDialog } from "../../../../ui/ConsoleDialog";
import { SliderField } from "../../../../ui/SliderField";
import { MeterBar } from "../../../../ui/kit";
import { DialogFooter } from "./DialogStepper";
import { PostTrainForecastPanel } from "./ForecastBand";
import { actionError, checkpointById, hasTrainingUnlock } from "./designState";
import { LockedChoice } from "./LockedChoice";
import { useSafeForecast } from "./useSafeForecast";
import { GYM_COPY } from "../gyms/gymModel";

const STAGES: ReadonlyArray<{
  id: PostTrainStageKind;
  label: string;
  blurb: string;
  pool: "instructionMTok" | "preferenceMTok" | "verifiableTasks" | "toolTrajectories";
  gymKinds: GymKind[];
}> = [
  {
    id: "instruct",
    label: "Instruct",
    blurb: "Supervised fine-tune on instruction tokens. Teaches the model to follow prompts.",
    pool: "instructionMTok",
    gymKinds: [],
  },
  {
    id: "preference",
    label: "Preference",
    blurb: "Ranked pairs from the preference pool. Optional safety gym. Unlocks thinking-tier heads later.",
    pool: "preferenceMTok",
    gymKinds: ["safety"],
  },
  {
    id: "reasoning",
    label: "Reasoning",
    blurb: "Verifiable tasks from math, science, and code gyms. Pick thinking budgets to train — each extra rung costs compute.",
    pool: "verifiableTasks",
    gymKinds: ["math", "science", "code"],
  },
  {
    id: "agentic",
    label: "Agentic",
    blurb: "Tool-use trajectories. Needs an agentic gym producing traces.",
    pool: "toolTrajectories",
    gymKinds: ["agentic"],
  },
];

function defaultBudget(activeParamsB: number, stages: PostTrainStageKind[]): number {
  const scale = (Math.max(0.1, activeParamsB) / TRAINING_V4.postTrain.referenceParamsB)
    ** TRAINING_V4.postTrain.sizeExponent;
  return stages.reduce(
    (sum, stage) => sum + TRAINING_V4.postTrain.baseStagePfDays[stage] * scale,
    0,
  );
}

export function PostTrainDialog({
  open,
  onClose,
  checkpointId,
}: {
  open: boolean;
  onClose: () => void;
  checkpointId: string;
}) {
  const sim = useGameStore((s) => s.state);
  const forecastRecipe = useGameStore((s) => s.forecastRecipe);
  const startRecipe = useGameStore((s) => s.startRecipe);
  const training = trainingStateOf(sim, sim.playerLabId);
  const checkpoint = checkpointById(sim, checkpointId);
  const pools = training.pools;

  const [stages, setStages] = useState<PostTrainStageKind[]>(["instruct"]);
  const [safetyFocus, setSafetyFocus] = useState(0.5);
  const [gymIds, setGymIds] = useState<string[]>([]);
  const [thinkingBudgets, setThinkingBudgets] = useState<TierBudget[]>([1]);
  const [budgetPfDays, setBudgetPfDays] = useState(() =>
    defaultBudget(checkpoint?.arch.activeParamsB ?? 7, ["instruct"]),
  );
  const [actionErr, setActionErr] = useState<string | null>(null);

  const trainedHeads = checkpoint ? trainedThinkingBudgets(checkpoint) : ([1] as TierBudget[]);
  const canTrainThinking = hasTrainingUnlock(sim, "thinking_tiers");

  useEffect(() => {
    if (!open) return;
    setStages(["instruct"]);
    setSafetyFocus(0.5);
    setGymIds([]);
    setThinkingBudgets(checkpoint ? trainedThinkingBudgets(checkpoint) : [1]);
    setBudgetPfDays(defaultBudget(checkpoint?.arch.activeParamsB ?? 7, ["instruct"]));
    setActionErr(null);
  }, [open, checkpointId, checkpoint?.arch.activeParamsB]);

  const dataUse = useMemo(
    () => ({
      instructionMTok: stages.includes("instruct") ? pools.instructionMTok : 0,
      preferenceMTok: stages.includes("preference") ? pools.preferenceMTok : 0,
      verifiableTasks: stages.includes("reasoning") ? pools.verifiableTasks : 0,
      toolTrajectories: stages.includes("agentic") ? pools.toolTrajectories : 0,
    }),
    [
      pools.instructionMTok,
      pools.preferenceMTok,
      pools.toolTrajectories,
      pools.verifiableTasks,
      stages,
    ],
  );

  const recipeInput = useMemo(
    () => ({
      checkpointId,
      stages,
      safetyFocus: stages.includes("preference") ? safetyFocus : 0,
      gymIds,
      budgetPfDays,
      dataUse,
      thinkingBudgets: stages.includes("reasoning") ? thinkingBudgets : undefined,
    }),
    [budgetPfDays, checkpointId, dataUse, gymIds, safetyFocus, stages, thinkingBudgets],
  );

  const { forecast, error } = useSafeForecast(
    () => forecastRecipe(recipeInput),
    [forecastRecipe, recipeInput],
  );

  const updatesInPlace = checkpoint?.stage === "post";
  const liveBudget = forecast?.pfDays ?? budgetPfDays;
  const kinds = new Set(STAGES.filter((stage) => stages.includes(stage.id)).flatMap((stage) => stage.gymKinds));
  const gyms = training.gyms.filter((gym) => kinds.size === 0 || kinds.has(gym.kind));
  const thinkingExtras = extraThinkingBudgetsToTrain(
    checkpoint ?? { tiers: [{ budget: 1, served: true }] },
    thinkingBudgets,
  );
  const thinkingMult = thinkingTrainPfMult(thinkingExtras);

  const toggleStage = (id: PostTrainStageKind) => {
    setStages((current) => {
      const next = current.includes(id) ? current.filter((row) => row !== id) : [...current, id];
      return next.length > 0 ? next : current;
    });
  };

  const start = () => {
    if (error || !forecast) return;
    try {
      const result = startRecipe({
        ...recipeInput,
        budgetPfDays: budgetPfDays || liveBudget,
      });
      if (result.ok) {
        setActionErr(null);
        onClose();
        return;
      }
      setActionErr(result.reason);
    } catch (cause) {
      setActionErr(actionError(cause));
    }
  };

  return (
    <ConsoleDialog
      open={open}
      titleId="v4-post-train"
      eyebrow="Post-training"
      title={checkpoint ? `Recipe on ${checkpoint.name}` : "Post-train recipe"}
      description={
        updatesInPlace
          ? "A recipe spends post-train pools and gym tasks, then updates this checkpoint. Keep a separate snapshot first if you want to preserve the current weights."
          : "A recipe spends post-train pools and gym tasks, then writes a new checkpoint. The base weights stay. Stack stages in one pass."
      }
      mobileDescription="Stages, gyms, budget."
      onClose={onClose}
      closeLabel="Close post-training"
      maxWidthClass="max-w-4xl"
      footer={
        <DialogFooter
          onCancel={onClose}
          primaryLabel="Start"
          onPrimary={start}
          disabled={Boolean(error) || !forecast || stages.length === 0}
          disabledReason={error ?? "Forecast unavailable"}
        />
      }
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-4">
          <p className="rounded-md border border-line/70 bg-void/35 px-3 py-2 text-[0.75rem] leading-5 text-muted">
            Instruct is SFT. Preference is ranking. Reasoning grades gym tasks. Agentic trains on tool traces.
            {updatesInPlace
              ? " Extra stages update this Ready card in place."
              : " When the recipe finishes you get a new post-train checkpoint you can eval or release."}
          </p>
          <div className="grid gap-2 sm:grid-cols-2" data-stage-toggles="true">
            {STAGES.map((stage) => {
              const on = stages.includes(stage.id);
              const poolValue = pools[stage.pool];
              const poolLabel = stage.pool.includes("MTok")
                ? `${poolValue.toFixed(1)} MTok`
                : `${Math.round(poolValue)} tasks`;
              return (
                <HudButton
                  key={stage.id}
                  type="button"
                  variant={on ? "primary" : "ghost"}
                  className="!min-h-11 !h-auto !flex-col !items-start !gap-1 !px-3 !py-2 !text-left"
                  aria-pressed={on}
                  onClick={() => toggleStage(stage.id)}
                >
                  <span className="flex w-full min-w-0 items-center justify-between gap-2">
                    <span className="truncate">{stage.label}</span>
                    <span className={`shrink-0 font-mono text-[0.625rem] ${on ? "text-void/70" : "text-muted"}`}>
                      {poolLabel}
                    </span>
                  </span>
                  <span className={`text-[0.6875rem] font-normal leading-4 ${on ? "text-void/80" : "text-muted"}`}>
                    {stage.blurb}
                  </span>
                </HudButton>
              );
            })}
          </div>
          <div className="space-y-2" data-pool-meters="true">
            {STAGES.map((stage) => (
              <MeterBar
                key={stage.pool}
                label={stage.label}
                value={pools[stage.pool] > 0 ? 1 : 0}
                detail={
                  stage.pool.includes("MTok")
                    ? `${pools[stage.pool].toFixed(1)} MTok`
                    : `${Math.round(pools[stage.pool])} tasks`
                }
                tone={stages.includes(stage.id) ? "train" : "positive"}
              />
            ))}
          </div>
          {stages.includes("preference") ? (
            <SliderField
              label="Safety focus"
              min={0}
              max={1}
              step={0.01}
              value={safetyFocus}
              onChange={setSafetyFocus}
            />
          ) : null}
          {stages.includes("reasoning") ? (
            <div data-thinking-train="true">
              <p className="mb-2 text-[0.75rem] text-muted">Thinking budgets to train</p>
              <p className="mb-2 text-[0.6875rem] leading-4 text-muted">
                Instant is already trained. Each extra rung needs its own compute. Hosting a
                trained head is a separate toggle after release.
              </p>
              <div className="flex flex-wrap gap-2">
                {TIER_BUDGETS.map((budget) => {
                  const already = trainedHeads.includes(budget);
                  const selected = thinkingBudgets.includes(budget) || already;
                  if (already) {
                    return (
                      <HudButton
                        key={budget}
                        type="button"
                        variant="primary"
                        className="!min-h-11"
                        disabled
                        disabledReason="Already trained on this checkpoint"
                        aria-pressed
                      >
                        {tierLabel(budget)}
                      </HudButton>
                    );
                  }
                  return (
                    <LockedChoice
                      key={budget}
                      selected={selected}
                      locked={!canTrainThinking}
                      reason={THINKING_UNLOCK_REASON}
                      onClick={() =>
                        setThinkingBudgets((current) =>
                          current.includes(budget)
                            ? current.filter((row) => row !== budget)
                            : [...current, budget],
                        )
                      }
                    >
                      {tierLabel(budget)}
                    </LockedChoice>
                  );
                })}
              </div>
              {thinkingExtras.length > 0 ? (
                <p className="mt-2 font-mono text-[0.6875rem] text-muted">
                  Training {thinkingExtras.map((budget) => tierLabel(budget)).join(", ")} · reasoning
                  PF ×{thinkingMult.toFixed(1)}
                </p>
              ) : null}
            </div>
          ) : null}
          <div data-gym-picker="true">
            <p className="mb-2 text-[0.75rem] text-muted">Gyms</p>
            {gyms.length === 0 ? (
              <p className="text-[0.75rem] text-muted">No matching gyms on campus.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {gyms.map((gym) => {
                  const on = gymIds.includes(gym.id);
                  return (
                    <HudButton
                      key={gym.id}
                      type="button"
                      variant={on ? "primary" : "ghost"}
                      className="!min-h-11 capitalize"
                      aria-pressed={on}
                      onClick={() =>
                        setGymIds((current) =>
                          on ? current.filter((id) => id !== gym.id) : [...current, gym.id],
                        )
                      }
                    >
                      {GYM_COPY[gym.kind].title} · tier {gym.tier}
                    </HudButton>
                  );
                })}
              </div>
            )}
          </div>
          <SliderField
            label="Budget PF-days"
            min={0}
            max={Math.max(liveBudget * 2, 1)}
            step={0.1}
            value={budgetPfDays}
            format={(value) => value.toFixed(1)}
            onChange={setBudgetPfDays}
            sublabel={
              <span className="font-mono text-[0.625rem] text-muted">
                Forecast {liveBudget.toFixed(1)} PF-d
              </span>
            }
          />
          {actionErr ? (
            <p role="alert" className="text-[0.75rem] text-danger">
              {actionErr}
            </p>
          ) : null}
        </div>
        <PostTrainForecastPanel forecast={forecast} error={error} />
      </div>
    </ConsoleDialog>
  );
}

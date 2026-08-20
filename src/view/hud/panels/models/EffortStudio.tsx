import { useMemo, useState } from "react";
import type { ModelProductProfile } from "../../../../sim/types";
import {
  EFFORT_UNLOCK_RESEARCH,
  MAX_TRAINED_EFFORTS,
  THINKING_TOKEN_MAX,
  THINKING_TOKEN_MIN,
  applyEffortLiftFromRecipe,
  defaultEffortIdOf,
  effortReasoningUnlocked,
  gymQualityByKind,
  migrateEffortRecipes,
  quoteEffortTraining,
  serveTokenMultiplierForRecipe,
  trainedEffortCount,
} from "../../../../sim/balance/modelProduct";
import { useGameStore } from "../../../../store/gameStore";
import { money } from "../../format";
import { HudButton, HudInput, StatusChip } from "../../ui/HudPrimitives";
import { ResearchUnlockLink } from "../../ui/ResearchUnlockLink";
import { SliderField } from "../../ui/SliderField";

export function EffortStudio({
  subjectId,
  profile,
  capability,
  paramsB = 1,
  onDefault,
  onToggleServe,
}: {
  subjectId: string;
  profile: ModelProductProfile;
  capability?: number;
  paramsB?: number;
  onDefault?: (recipeId: string) => void;
  onToggleServe?: (recipeId: string, served: boolean) => void;
}) {
  const researchUnlocked = useGameStore((s) => s.state.player.researchUnlocked);
  const gyms = useGameStore((s) => s.state.player.postTrainGyms);
  const startEffort = useGameStore((s) => s.startEffortTraining);
  const setDefault = useGameStore((s) => s.setDefaultEffort);
  const setServed = useGameStore((s) => s.setServedEffort);
  const recipes = migrateEffortRecipes(profile);
  const defaultId = defaultEffortIdOf(profile);
  const unlocked = effortReasoningUnlocked(researchUnlocked);
  const trainedCount = trainedEffortCount(recipes);
  const baseCap = capability ?? 0;
  const [name, setName] = useState("Think");
  const [thinking, setThinking] = useState(2.2);
  const [trainPf, setTrainPf] = useState<number | null>(null);

  const quote = useMemo(
    () =>
      quoteEffortTraining({
        paramsB,
        thinkingTokenMult: thinking,
        trainPfDays: trainPf ?? undefined,
        gymQuality: gymQualityByKind(gyms, "math"),
        researchUnlocked,
      }),
    [gyms, paramsB, researchUnlocked, thinking, trainPf],
  );

  return (
    <div
      className="rounded-md border border-line/60 bg-void/30 p-2.5"
      data-effort-studio="true"
    >
      <p className="hud-eyebrow">Effort heads</p>
      <p className="mt-1 text-[0.6875rem] leading-5 text-muted">
        Instant is always free. Train named heads with a thinking budget and
        the compute that makes those tokens worth it.
      </p>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {recipes.map((recipe) => {
          const tokens = serveTokenMultiplierForRecipe(
            recipe,
            profile.tokenEfficiency,
          );
          const lifted =
            baseCap > 0
              ? applyEffortLiftFromRecipe(
                  baseCap,
                  {
                    mmlu: baseCap,
                    coding: baseCap,
                    math: baseCap,
                    vision: 0,
                    law: 0,
                    health: 0,
                    science: baseCap,
                    multilingual: 0,
                    agents: baseCap,
                    safety: 0,
                    personality: profile.personality,
                  },
                  recipe,
                )
              : null;
          const isDefault = defaultId === recipe.id;
          return (
            <div
              key={recipe.id}
              className={`rounded-md border p-2 ${
                recipe.served
                  ? "border-mint/50 bg-mint/10"
                  : "border-line/60 bg-void/40"
              }`}
            >
              <span className="flex items-center justify-between gap-1">
                <strong className="truncate text-[0.75rem] text-bone">
                  {recipe.name}
                </strong>
                {isDefault ? (
                  <StatusChip tone="positive">default</StatusChip>
                ) : recipe.served ? (
                  <StatusChip tone="research">serving</StatusChip>
                ) : recipe.kind === "instant" ? (
                  <StatusChip tone="neutral">instant</StatusChip>
                ) : null}
              </span>
              <p className="mt-1 font-mono text-[0.625rem] text-muted">
                {lifted && baseCap > 0
                  ? `cap ${Math.round(lifted.capability)} · `
                  : null}
                {tokens.toFixed(1)}× tokens
              </p>
              <div className="mt-1.5 flex flex-col gap-1">
                <HudButton
                  type="button"
                  variant="ghost"
                  className="!min-h-8 !px-2 !text-[0.625rem]"
                  disabled={!recipe.trained}
                  onClick={() =>
                    onToggleServe
                      ? onToggleServe(recipe.id, !recipe.served)
                      : setServed(subjectId, recipe.id, !recipe.served)
                  }
                >
                  {recipe.served ? "Stop serving" : "Serve"}
                </HudButton>
                {recipe.served && !isDefault ? (
                  <HudButton
                    type="button"
                    variant="ghost"
                    className="!min-h-8 !px-2 !text-[0.625rem]"
                    onClick={() =>
                      onDefault
                        ? onDefault(recipe.id)
                        : setDefault(subjectId, recipe.id)
                    }
                  >
                    Make default
                  </HudButton>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 rounded-md border border-line/50 bg-void/40 p-2">
        <p className="text-[0.75rem] font-semibold text-bone">Train a head</p>
        {!unlocked ? (
          <ResearchUnlockLink
            className="mt-1.5"
            compact
            nodeId={EFFORT_UNLOCK_RESEARCH}
            label="Unlock with Process Reward"
          />
        ) : trainedCount >= MAX_TRAINED_EFFORTS ? (
          <p className="mt-1 text-[0.6875rem] text-muted">
            Cap is Instant plus {MAX_TRAINED_EFFORTS} trained heads.
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            <label className="block text-[0.6875rem] text-muted">
              Name
              <HudInput
                className="mt-1 w-full"
                maxLength={24}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Think"
              />
            </label>
            <SliderField
              label="Thinking budget"
              value={thinking}
              min={THINKING_TOKEN_MIN}
              max={THINKING_TOKEN_MAX}
              step={0.1}
              format={(value) => `${value.toFixed(1)}× tokens`}
              onChange={setThinking}
            />
            <SliderField
              label="Train compute"
              value={trainPf ?? quote.requiredPfDays}
              min={1}
              max={Math.max(8, quote.requiredPfDays * 1.4)}
              step={0.5}
              format={(value) => `${value.toFixed(1)} PF-days`}
              sublabel={`${(quote.quality * 100).toFixed(0)}% quality · ${money(quote.cash)}`}
              onChange={setTrainPf}
            />
            <p className="font-mono text-[0.625rem] text-muted">
              Underfunding still spends the thinking tokens at serve time.
            </p>
            <HudButton
              type="button"
              variant="primary"
              className="!min-h-9 w-full !text-[0.75rem]"
              onClick={() =>
                startEffort({
                  id: subjectId,
                  name,
                  thinkingTokenMult: thinking,
                  trainPfDays: trainPf ?? quote.requiredPfDays,
                })
              }
            >
              Train {name.trim() || "head"} · {money(quote.cash)}
            </HudButton>
          </div>
        )}
      </div>
    </div>
  );
}

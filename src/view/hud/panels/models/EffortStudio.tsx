import { useMemo, useState } from "react";
import type { EffortRecipe, ModelProductProfile } from "../../../../sim/types";
import {
  DEFAULT_EFFORT_HEAD_SHARE,
  EFFORT_HEAD_SHARE_MAX,
  EFFORT_UNLOCK_RESEARCH,
  MAX_TRAINED_EFFORTS,
  THINKING_TOKEN_MAX,
  THINKING_TOKEN_MIN,
  applyEffortLiftFromRecipe,
  defaultEffortIdOf,
  effortReasoningUnlocked,
  effortRequestMultipliers,
  gymQualityByKind,
  migrateEffortRecipes,
  previewEffortRecipe,
  quoteEffortTraining,
  serveTokenMultiplierForRecipe,
  trainedEffortCount,
} from "../../../../sim/balance/modelProduct";
import { useGameStore } from "../../../../store/gameStore";
import { money } from "../../format";
import { HudButton, HudInput, StatusChip } from "../../ui/HudPrimitives";
import { ResearchUnlockLink } from "../../ui/ResearchUnlockLink";
import { SliderField } from "../../ui/SliderField";

function biasLabel(bias: number): string {
  if (bias < 0.35) return "efficient";
  if (bias > 0.65) return "capable";
  return "balanced";
}

function dummyBenches(baseCap: number, personality: number) {
  return {
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
    personality,
  };
}

export function EffortStudio({
  subjectId,
  profile,
  capability,
  paramsB = 1,
  live = false,
  onDefault,
  onToggleServe,
}: {
  subjectId: string;
  profile: ModelProductProfile;
  capability?: number;
  paramsB?: number;
  live?: boolean;
  onDefault?: (recipeId: string) => void;
  onToggleServe?: (recipeId: string, served: boolean) => void;
}) {
  const researchUnlocked = useGameStore((s) => s.state.player.researchUnlocked);
  const gyms = useGameStore((s) => s.state.player.postTrainGyms);
  const startEffort = useGameStore((s) => s.startEffortTraining);
  const setDefault = useGameStore((s) => s.setDefaultEffort);
  const setServed = useGameStore((s) => s.setServedEffort);
  const setShare = useGameStore((s) => s.setEffortHeadComputeShare);
  const setBias = useGameStore((s) => s.setEffortHeadCapabilityBias);
  const recipes = migrateEffortRecipes(profile);
  const defaultId = defaultEffortIdOf(profile);
  const unlocked = effortReasoningUnlocked(researchUnlocked);
  const trainedCount = trainedEffortCount(recipes);
  const baseCap = capability ?? 0;
  const [name, setName] = useState("Think");
  const [thinking, setThinking] = useState(2.2);
  const [trainPf, setTrainPf] = useState<number | null>(null);
  const [newBias, setNewBias] = useState(0.5);

  const quote = useMemo(
    () =>
      quoteEffortTraining({
        paramsB,
        thinkingTokenMult: thinking,
        trainPfDays: trainPf ?? undefined,
        gymQuality: gymQualityByKind(gyms, "math"),
        researchUnlocked,
        capabilityBias: newBias,
        kind: "trained",
      }),
    [gyms, newBias, paramsB, researchUnlocked, thinking, trainPf],
  );
  const newPreview = useMemo(
    () =>
      previewEffortRecipe({
        recipe: {
          kind: "trained",
          trained: true,
          thinkingTokenMult: thinking,
          quality: quote.quality,
          capabilityBias: newBias,
        },
        tokenEfficiency: profile.tokenEfficiency,
        baseCapability: baseCap,
        benches: dummyBenches(baseCap, profile.personality),
      }),
    [baseCap, newBias, profile.personality, profile.tokenEfficiency, quote.quality, thinking],
  );
  const newRequest = useMemo(
    () =>
      effortRequestMultipliers(
        {
          kind: "trained",
          thinkingTokenMult: thinking,
          capabilityBias: newBias,
        },
        profile.tokenEfficiency,
      ),
    [newBias, profile.tokenEfficiency, thinking],
  );
  const activeCount = recipes.filter(
    (recipe) =>
      (recipe.progressPfDays ?? 0) + 1e-9 < (recipe.targetPfDays ?? 0),
  ).length;

  return (
    <details
      className="group rounded-md border border-line/60 bg-void/30 p-2.5"
      data-effort-studio="true"
    >
      <summary className="min-h-11 cursor-pointer list-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-mint/70">
        <span className="flex items-center justify-between gap-2">
          <span>
            <span className="hud-eyebrow block">Effort heads</span>
            <span className="mt-0.5 block text-[0.6875rem] text-muted">
              Configure generated / reasoning budgets · {trainedCount} trained · up to {THINKING_TOKEN_MAX}× generated
              {activeCount > 0 ? ` · ${activeCount} fitting` : ""}
            </span>
          </span>
          <span className="text-[0.6875rem] text-mint">
            <span className="group-open:hidden">Show</span>
            <span className="hidden group-open:inline">Hide</span>
          </span>
        </span>
      </summary>
      <div className="mt-2 border-t border-line/50 pt-2">
        <p className="hud-mobile-detail text-[0.6875rem] leading-5 text-muted">
          Instant is always free to serve. Split Train PF across heads, watch
          loss, and slide each toward capability (costly) or efficiency (cheaper
          tokens). Prompt tokens stay fixed; generated and hidden-reasoning
          tokens are billed at the output rate and count toward total billed
          tokens.
        </p>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {recipes.map((recipe) => (
          <EffortHeadCard
            key={recipe.id}
            recipe={recipe}
            profile={profile}
            baseCap={baseCap}
            paramsB={paramsB}
            isDefault={defaultId === recipe.id}
            live={live}
            unlocked={unlocked || recipe.kind === "instant"}
            onToggleServe={() =>
              onToggleServe
                ? onToggleServe(recipe.id, !recipe.served)
                : setServed(subjectId, recipe.id, !recipe.served)
            }
            onDefault={() =>
              onDefault
                ? onDefault(recipe.id)
                : setDefault(subjectId, recipe.id)
            }
            onShare={(share) => setShare(subjectId, recipe.id, share)}
            onBias={(bias) => setBias(subjectId, recipe.id, bias)}
            onContinue={() =>
              startEffort({
                id: subjectId,
                recipeId: recipe.id,
                name: recipe.name,
                thinkingTokenMult: recipe.thinkingTokenMult,
                capabilityBias: recipe.capabilityBias,
                trainComputeShare: Math.max(
                  recipe.trainComputeShare ?? 0,
                  DEFAULT_EFFORT_HEAD_SHARE,
                ),
              })
            }
          />
        ))}
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
            <LogThinkingBudgetField
              value={thinking}
              billedMultiplier={newRequest.billedTokenMultiplier}
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
            <SliderField
              label="Efficiency vs capability"
              value={newBias}
              min={0}
              max={1}
              step={0.05}
              format={biasLabel}
              sublabel={`${newPreview.tokenMult.toFixed(1)}× generated · ${newRequest.billedTokenMultiplier.toFixed(1)}× billed · cap ${
                baseCap > 0
                  ? `${Math.round(newPreview.capability)} (${newPreview.capDelta >= 0 ? "+" : ""}${Math.round(newPreview.capDelta)})`
                  : "—"
              }`}
              onChange={setNewBias}
            />
            <p className="font-mono text-[0.625rem] text-muted">
              Capability multiplies serve cost. Efficiency cheapens tokens for
              less lift. Instant stays free.
            </p>
            <HudButton
              type="button"
              variant="primary"
              className="!min-h-11 w-full !text-[0.75rem]"
              onClick={() =>
                startEffort({
                  id: subjectId,
                  name,
                  thinkingTokenMult: thinking,
                  trainPfDays: trainPf ?? quote.requiredPfDays,
                  capabilityBias: newBias,
                  trainComputeShare: DEFAULT_EFFORT_HEAD_SHARE,
                })
              }
            >
              Train {name.trim() || "head"} · {money(quote.cash)}
            </HudButton>
          </div>
        )}
      </div>
      </div>
    </details>
  );
}

export function LogThinkingBudgetField({
  value,
  billedMultiplier,
  onChange,
}: {
  value: number;
  billedMultiplier: number;
  onChange: (value: number) => void;
}) {
  const position =
    Math.log(Math.max(THINKING_TOKEN_MIN, value) / THINKING_TOKEN_MIN) /
    Math.log(THINKING_TOKEN_MAX / THINKING_TOKEN_MIN);
  return (
    <SliderField
      label="Generated / reasoning budget"
      value={position}
      min={0}
      max={1}
      step={0.001}
      format={() => `${value.toFixed(1)}× generated`}
      ariaValueText={`${value.toFixed(1)}× generated; ${billedMultiplier.toFixed(1)}× total billed`}
      sublabel={
        <span className="font-mono text-[0.625rem] text-muted">
          Prompt fixed · {billedMultiplier.toFixed(1)}× total billed
        </span>
      }
      onChange={(nextPosition) => {
        const raw =
          THINKING_TOKEN_MIN *
          Math.pow(
            THINKING_TOKEN_MAX / THINKING_TOKEN_MIN,
            nextPosition,
          );
        onChange(Math.round(raw * 10) / 10);
      }}
    />
  );
}

function EffortHeadCard({
  recipe,
  profile,
  baseCap,
  paramsB,
  isDefault,
  live,
  unlocked,
  onToggleServe,
  onDefault,
  onShare,
  onBias,
  onContinue,
}: {
  recipe: EffortRecipe;
  profile: ModelProductProfile;
  baseCap: number;
  paramsB: number;
  isDefault: boolean;
  live: boolean;
  unlocked: boolean;
  onToggleServe: () => void;
  onDefault: () => void;
  onShare: (share: number) => void;
  onBias: (bias: number) => void;
  onContinue: () => void;
}) {
  const gyms = useGameStore((s) => s.state.player.postTrainGyms);
  const researchUnlocked = useGameStore((s) => s.state.player.researchUnlocked);
  const tokens = serveTokenMultiplierForRecipe(recipe, profile.tokenEfficiency);
  const request = effortRequestMultipliers(recipe, profile.tokenEfficiency);
  const benches = dummyBenches(baseCap, profile.personality);
  const lifted =
    baseCap > 0
      ? applyEffortLiftFromRecipe(baseCap, benches, recipe)
      : null;
  const bias = recipe.capabilityBias ?? 0.5;
  const share = recipe.trainComputeShare ?? 0;
  const preview = previewEffortRecipe({
    recipe: { ...recipe, capabilityBias: bias },
    tokenEfficiency: profile.tokenEfficiency,
    baseCapability: baseCap,
    benches,
  });
  const continueQuote = quoteEffortTraining({
    paramsB,
    thinkingTokenMult: recipe.kind === "instant" ? 1.4 : recipe.thinkingTokenMult,
    gymQuality: gymQualityByKind(gyms, "math"),
    researchUnlocked,
    capabilityBias: bias,
    kind: recipe.kind,
  });
  const training =
    share > 0 && (recipe.progressPfDays ?? 0) < (recipe.targetPfDays ?? 0);
  const freeServe = recipe.kind === "instant";

  return (
    <div
      className={`rounded-md border p-2 ${
        recipe.served
          ? "border-mint/50 bg-mint/10"
          : "border-line/60 bg-void/40"
      }`}
      data-effort-head={recipe.id}
    >
      <span className="flex items-center justify-between gap-1">
        <strong className="truncate text-[0.75rem] text-bone">
          {recipe.name}
        </strong>
        {isDefault ? (
          <StatusChip tone="positive">default</StatusChip>
        ) : recipe.served ? (
          <StatusChip tone="research">serving</StatusChip>
        ) : training ? (
          <StatusChip tone="neutral">training</StatusChip>
        ) : recipe.kind === "instant" ? (
          <StatusChip tone="neutral">instant</StatusChip>
        ) : null}
      </span>
      <p
        className="mt-1 font-mono text-[0.625rem] text-muted"
        data-effort-stats="true"
      >
        {lifted && baseCap > 0 ? `cap ${Math.round(lifted.capability)} · ` : null}
        {freeServe ? "free · " : null}
        {tokens.toFixed(1)}× generated · {request.billedTokenMultiplier.toFixed(1)}× billed
        {recipe.loss != null ? ` · loss ${recipe.loss.toFixed(2)}` : null}
      </p>
      {training || (recipe.progressPfDays ?? 0) > 0 ? (
        <p className="font-mono text-[0.625rem] text-muted" data-effort-progress="true">
          {(recipe.progressPfDays ?? 0).toFixed(1)} /{" "}
          {Math.max(0.1, recipe.targetPfDays ?? 0).toFixed(1)} PF
          {live ? " of Train pool" : ""}
        </p>
      ) : null}
      {unlocked ? (
        <div className="mt-1.5 space-y-1.5">
          <SliderField
            label="Train PF share"
            value={share}
            min={0}
            max={EFFORT_HEAD_SHARE_MAX}
            step={0.01}
            format={(value) => `${Math.round(value * 100)}%`}
            sublabel={
              live
                ? "Slice of this job's Train PF"
                : "Applies on the next training run"
            }
            onChange={onShare}
          />
          <SliderField
            label="Efficiency vs capability"
            value={bias}
            min={0}
            max={1}
            step={0.05}
            format={biasLabel}
            sublabel={
              freeServe
                ? `free to serve · cap ${
                    baseCap > 0
                      ? `${Math.round(preview.capability)} (${preview.capDelta >= 0 ? "+" : ""}${Math.round(preview.capDelta)})`
                      : "—"
                  }`
                : `${preview.tokenMult.toFixed(1)}× generated · ${request.billedTokenMultiplier.toFixed(1)}× billed · cap ${
                    baseCap > 0
                      ? `${Math.round(preview.capability)} (${preview.capDelta >= 0 ? "+" : ""}${Math.round(preview.capDelta)})`
                      : "—"
                  }`
            }
            onChange={onBias}
          />
        </div>
      ) : recipe.kind !== "instant" ? (
        <ResearchUnlockLink
          className="mt-1.5"
          compact
          nodeId={EFFORT_UNLOCK_RESEARCH}
          label="Unlock training"
        />
      ) : null}
      <div className="mt-1.5 flex flex-col gap-1">
        <HudButton
          type="button"
          variant="ghost"
          className="!min-h-11 !px-2 !text-[0.625rem] xl:!min-h-9"
          disabled={!recipe.trained}
          onClick={onToggleServe}
        >
          {recipe.served ? "Stop serving" : "Serve"}
        </HudButton>
        {recipe.served && !isDefault ? (
          <HudButton
            type="button"
            variant="ghost"
            className="!min-h-11 !px-2 !text-[0.625rem] xl:!min-h-9"
            onClick={onDefault}
          >
            Make default
          </HudButton>
        ) : null}
        {unlocked ? (
          <HudButton
            type="button"
            variant="ghost"
            className="!min-h-11 !px-2 !text-[0.625rem] xl:!min-h-9"
            data-effort-continue={recipe.id}
            onClick={onContinue}
          >
            Continue train · {money(continueQuote.cash)}
          </HudButton>
        ) : null}
      </div>
    </div>
  );
}

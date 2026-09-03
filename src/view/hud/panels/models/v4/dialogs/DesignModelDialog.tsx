import { useEffect, useMemo, useReducer } from "react";
import { DiceFive } from "@phosphor-icons/react";
import { DATA_DOMAINS, DATA_DOMAIN_META } from "../../../../../../sim/balance/data";
import { TRAINING_V4 } from "../../../../../../sim/training/constants";
import { trainingStateOf } from "../../../../../../sim/training/state";
import type { ModelGoal, StartResult } from "../../../../../../sim/training/types";
import type { ModelProductPreset } from "../../../../../../sim/types";
import { computeSnapshot } from "../../../../../../sim/systems/compute";
import { useGameStore } from "../../../../../../store/gameStore";
import { money } from "../../../../format";
import { generateUniqueModelName } from "../../../../modelNaming";
import { HudButton, HudInput, StatusChip } from "../../../../ui/HudPrimitives";
import { ConsoleDialog } from "../../../../ui/ConsoleDialog";
import { SizeSlider } from "../../../../ui/SizeSlider";
import { SliderField } from "../../../../ui/SliderField";
import { CardGrid, GameCard } from "../../../../ui/kit";
import { ArchGlyph } from "../../ui/ArchGlyph";
import { MonoStat } from "../../ui/MonoStat";
import { glyphFor } from "../../viewModels/selectors";
import { DialogStepper } from "./DialogStepper";
import { DomainRadar } from "./DomainRadar";
import { ForecastBand } from "./ForecastBand";
import { LockedChoice } from "./LockedChoice";
import {
  AI_TYPE_CARDS,
  CONTEXT_STOPS,
  GOAL_CARDS,
  LLM_INPUT_EXTRAS,
  PRECISION_CHIPS,
  SIZE_MAX,
  SIZE_MIN,
  SIZE_SLIDER_STOPS,
  TOKENS_PER_PARAM_PRESETS,
  actionError,
  activeFractionOf,
  aiTypeLockReason,
  aiTypeOf,
  availableTokensOf,
  checkpointById,
  clampTokPerParam,
  continueParentsFor,
  contextLockReason,
  formatContextK,
  maxUnlockedContextK,
  snapContextK,
  distillTeachers,
  epochsFor,
  extraDataForContinue,
  formatMTok,
  formatTokPerParam,
  goalLockReason,
  initialDesignState,
  isMaxTokPerParamSelected,
  launchDisabled,
  llmInputEnabled,
  maxTokensPerParam,
  occupiedRunNames,
  optionLockReason,
  presetFor,
  reduceDesign,
  specialistDomainOf,
  tokPerParamLockReason,
  tokPerParamMaxLockReason,
  totalUniqueMTok,
  trainedDomainMTok,
  workflowSteps,
  type ContinueFocus,
} from "./designState";
import { useSafeForecast } from "./useSafeForecast";

function RunNameField({
  name,
  onChange,
  onRandomize,
}: {
  name: string;
  onChange: (name: string) => void;
  onRandomize: () => void;
}) {
  return (
    <label className="block">
      <span className="text-[0.75rem] text-muted">Run name</span>
      <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] items-stretch gap-2">
        <HudInput
          className="min-h-11 w-full"
          value={name}
          onChange={(event) => onChange(event.target.value)}
          aria-label="Run name"
        />
        <HudButton
          type="button"
          variant="ghost"
          onClick={onRandomize}
          aria-label="Randomize run name"
          title="Randomize run name"
          className="flex min-h-11 items-center gap-2 border border-line bg-panel-2 px-3 font-mono text-[0.625rem] uppercase tracking-[0.08em] text-muted transition-colors hover:border-mint/45 hover:text-mint max-sm:!min-w-11 max-sm:!px-0"
        >
          <DiceFive size="1rem" weight="duotone" />
          <span className="max-sm:hidden">Random</span>
        </HudButton>
      </div>
    </label>
  );
}

export function DesignModelDialog({
  open,
  onClose,
  goal,
  parentCheckpointId,
  teacherCheckpointId,
  copyFromEndpointId,
}: {
  open: boolean;
  onClose: () => void;
  goal?: ModelGoal;
  parentCheckpointId?: string;
  teacherCheckpointId?: string;
  copyFromEndpointId?: string;
}) {
  const sim = useGameStore((s) => s.state);
  const forecastDesign = useGameStore((s) => s.forecastDesign);
  const startRun = useGameStore((s) => s.startRun);
  const startDistill = useGameStore((s) => s.startDistill);
  const startContinue = useGameStore((s) => s.startContinue);

  const seed = useMemo(
    () =>
      initialDesignState(sim, goal, {
        parentCheckpointId,
        teacherCheckpointId,
        copyFromEndpointId,
      }),
    // Re-seed when the dialog opens or the inbound goal/lineage changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, goal, parentCheckpointId, teacherCheckpointId, copyFromEndpointId],
  );
  const [ui, dispatch] = useReducer(reduceDesign, seed);
  useEffect(() => {
    if (!open) return;
    dispatch({
      type: "hydrate",
      design: seed.design,
      tokensPerParam: seed.tokensPerParam,
      step: seed.step,
      nameDirty: seed.nameDirty,
      continueFocus: seed.continueFocus,
    });
  }, [open, seed]);
  const design = ui.design;
  const step = ui.step;

  const available = useMemo(() => availableTokensOf(sim), [sim]);
  const uniqueMTok = useMemo(() => totalUniqueMTok(available), [available]);
  const maxTokPerParam = maxTokensPerParam(uniqueMTok, design.arch.totalParamsB);
  const maxTokLocked = tokPerParamMaxLockReason(uniqueMTok);

  useEffect(() => {
    if (!open) return;
    const next = clampTokPerParam(ui.tokensPerParam, uniqueMTok, design.arch.totalParamsB);
    if (Math.abs(next - ui.tokensPerParam) > 1e-9) {
      dispatch({ type: "setTokensPerParam", tokensPerParam: next });
    }
  }, [open, uniqueMTok, design.arch.totalParamsB, ui.tokensPerParam]);
  const trainingPf = useMemo(() => {
    try {
      return Math.max(0, computeSnapshot(sim).pools.training);
    } catch {
      return 0;
    }
  }, [sim]);

  const { forecast, error } = useSafeForecast(() => forecastDesign(design), [forecastDesign, design]);
  const blocked = launchDisabled(forecast, error);

  const goalLocks = useMemo(() => {
    const locks: Partial<Record<ModelGoal, string>> = {};
    for (const card of GOAL_CARDS) {
      const reason = goalLockReason(card.id, sim, {
        parentCheckpointId,
        teacherCheckpointId,
        keepArch: design.arch,
      });
      if (reason) locks[card.id] = reason;
    }
    return locks;
  }, [design.arch, parentCheckpointId, sim, teacherCheckpointId]);
  const aiTypeLocks = useMemo(() => {
    const locks: Partial<Record<ModelProductPreset, string>> = {};
    for (const card of AI_TYPE_CARDS) {
      const reason = aiTypeLockReason(card.id, sim);
      if (reason) locks[card.id] = reason;
    }
    return locks;
  }, [sim]);
  const checkpoints = useMemo(
    () => trainingStateOf(sim, sim.playerLabId).checkpoints,
    [sim],
  );
  const teachers = useMemo(() => distillTeachers(checkpoints), [checkpoints]);
  const continueParents = useMemo(
    () => continueParentsFor(checkpoints, design.arch),
    [checkpoints, design.arch],
  );
  const moeLocked = optionLockReason("moe", sim);
  const contextCap = maxUnlockedContextK(sim);
  const contextK = snapContextK(design.arch.contextK ?? 4);
  const contextIdx = Math.max(0, CONTEXT_STOPS.indexOf(contextK as (typeof CONTEXT_STOPS)[number]));
  const nextContextUnlock = CONTEXT_STOPS.find((stop) => stop > contextCap);
  const nextContextLock = nextContextUnlock
    ? contextLockReason(nextContextUnlock, sim)
    : null;

  useEffect(() => {
    if (!open || step !== "launch") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || blocked) return;
      const target = event.target;
      if (target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      launch();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // launch is recreated each render; bind to the latest blocked/design via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, blocked, design]);

  const launch = () => {
    if (blocked) return;
    let result: StartResult;
    try {
      if (design.mode.kind === "distill") {
        result = startDistill({
          teacherCheckpointId: design.mode.teacherCheckpointId,
          studentArch: design.arch,
          data: design.data,
          name: design.name,
          compute: design.compute,
        });
      } else if (design.mode.kind === "continue") {
        result = startContinue({
          parentCheckpointId: design.mode.parentCheckpointId,
          extraData: design.data,
          name: design.name,
          compute: design.compute,
        });
      } else {
        result = startRun(design);
      }
    } catch (cause) {
      dispatch({ type: "setLaunchError", error: actionError(cause) });
      return;
    }
    if (result.ok) {
      dispatch({ type: "setLaunchError", error: null });
      onClose();
      return;
    }
    dispatch({ type: "setLaunchError", error: result.reason });
  };

  const breakdown = forecast?.effectiveData;
  const continueMode = design.goal === "continue" || design.mode.kind === "continue";
  const inboundContinue = Boolean(parentCheckpointId);
  const parent = checkpointById(
    sim,
    parentCheckpointId
      ?? (design.mode.kind === "continue" ? design.mode.parentCheckpointId : undefined),
  );
  const steps = workflowSteps(design);

  useEffect(() => {
    if (continueMode && step === "architecture") {
      dispatch({ type: "setStep", step: "goal" });
    }
  }, [continueMode, step]);

  const applyType = (nextGoal: ModelGoal) => {
    dispatch({
      type: "applyPreset",
      design: presetFor(nextGoal, sim, {
        parentCheckpointId,
        teacherCheckpointId,
        continueFocus: nextGoal === "continue" ? ui.continueFocus : undefined,
        keepArch: design.arch,
        teacherSynthShare: design.data.teacherSynthShare,
      }),
    });
  };

  const applyAiType = (preset: ModelProductPreset) => {
    dispatch({ type: "setAiType", preset });
  };

  const applyContinueFocus = (focus: ContinueFocus) => {
    dispatch({
      type: "setContinueFocus",
      focus,
      domainMTok: extraDataForContinue(available, design.arch, parent, focus),
    });
  };

  const applyContinueParent = (parentId: string) => {
    dispatch({
      type: "applyPreset",
      design: presetFor("continue", sim, {
        parentCheckpointId: parentId,
        continueFocus: ui.continueFocus,
        keepArch: design.arch,
      }),
    });
  };

  const randomizeRunName = () => {
    dispatch({
      type: "setName",
      name: generateUniqueModelName(
        { playerModels: occupiedRunNames(sim) },
        { avoid: design.name },
      ),
    });
  };

  const selectedAiType = aiTypeOf(design.arch);
  const distillMode = design.goal === "distill" || design.mode.kind === "distill";
  const specialistMode = design.goal === "specialist";
  const teacherId =
    design.mode.kind === "distill" ? design.mode.teacherCheckpointId : teacherCheckpointId;
  const parentId =
    parentCheckpointId
    ?? (design.mode.kind === "continue" ? design.mode.parentCheckpointId : undefined);

  return (
    <ConsoleDialog
      open={open}
      titleId="v4-design-model"
      eyebrow="Model training"
      title={
        copyFromEndpointId
          ? "Copy formula"
          : continueMode
            ? "Continue training"
            : "New training run"
      }
      description={
        copyFromEndpointId
          ? "Architecture and data mix copied from the live base. Launch starts a fresh pretrain."
          : continueMode
            ? "Name the run, then add more data or fix a domain. Architecture stays with the checkpoint."
            : "Name the product, then pick a training path. Size and mix come after."
      }
      mobileDescription={
        copyFromEndpointId
          ? "Copied formula → review → launch a new pretrain."
          : continueMode
            ? "Name → more data or a domain → launch."
            : "Name → type → path → architecture → data → launch."
      }
      onClose={onClose}
      closeLabel="Close training workflow"
      maxWidthClass="max-w-5xl"
      footer={
        <DialogStepper
          steps={steps}
          activeStep={step}
          onStepChange={(next) => dispatch({ type: "setStep", step: next })}
          onCancel={onClose}
          primaryAction={
            <HudButton
              type="button"
              variant="primary"
              className="!min-h-11 !rounded-md !px-3 !text-[0.6875rem] !font-semibold"
              disabled={blocked}
              disabledReason={error ?? "Resolve blockers before launch."}
              data-launch="true"
              onClick={launch}
            >
              Launch
            </HudButton>
          }
        />
      }
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]" data-design-step={step}>
        <div className="min-w-0 space-y-4">
          {step === "goal" ? (
            <div className="space-y-4">
              <RunNameField
                name={design.name}
                onChange={(name) => dispatch({ type: "setName", name })}
                onRandomize={randomizeRunName}
              />
              {inboundContinue ? (
                <div className="space-y-3">
                  {parent ? (
                    <p className="text-[0.75rem] text-muted">
                      Continuing {parent.name}
                      {parent.stage === "base" ? " from the base checkpoint." : "."}
                    </p>
                  ) : null}
                  <HudButton
                    type="button"
                    variant={ui.continueFocus === "more_data" ? "primary" : "ghost"}
                    className="!min-h-11"
                    data-continue-intent="more_data"
                    aria-pressed={ui.continueFocus === "more_data"}
                    onClick={() => applyContinueFocus("more_data")}
                  >
                    Keep mix
                  </HudButton>
                  <DomainRadar
                    requested={design.data.domainMTok}
                    available={available}
                    trained={trainedDomainMTok(parent)}
                    selectedDomain={
                      ui.continueFocus === "more_data" ? undefined : ui.continueFocus
                    }
                    onSelectDomain={(domain) => applyContinueFocus(domain)}
                  />
                </div>
              ) : (
                <div className="space-y-4">
                  {continueMode ? (
                    <HudButton
                      type="button"
                      variant="ghost"
                      className="!min-h-11"
                      onClick={() => applyType("flagship")}
                    >
                      Choose a different path
                    </HudButton>
                  ) : null}
                  {!continueMode ? (
                    <>
                      <div className="space-y-2">
                        <p className="text-[0.75rem] text-muted">AI type</p>
                        <CardGrid min="11rem">
                          {AI_TYPE_CARDS.map((card) => {
                            const locked = aiTypeLocks[card.id];
                            const selected = selectedAiType === card.id;
                            return (
                              <GameCard
                                key={card.id}
                                title={card.label}
                                interactive={!locked}
                                selected={selected}
                                ariaLabel={locked ? `${card.label} (locked)` : card.label}
                                onActivate={locked ? undefined : () => applyAiType(card.id)}
                                className={locked ? "models-v4-locked-card" : ""}
                              >
                                <p data-ai-type={card.id} className="text-[0.75rem] leading-5 text-muted">
                                  {card.blurb}
                                </p>
                                {locked ? (
                                  <p className="mt-2 text-[0.6875rem] text-amber" data-lock-reason={card.id}>
                                    Locked: {locked}
                                  </p>
                                ) : null}
                              </GameCard>
                            );
                          })}
                        </CardGrid>
                      </div>
                      {selectedAiType === "language" ? (
                        <div className="space-y-2">
                          <p className="text-[0.75rem] text-muted">LLM inputs</p>
                          <div className="flex flex-wrap gap-2">
                            {LLM_INPUT_EXTRAS.map((extra) => {
                              const locked = optionLockReason(extra.unlock, sim);
                              const selected = llmInputEnabled(design.arch, extra.id);
                              return (
                                <LockedChoice
                                  key={extra.id}
                                  selected={selected}
                                  locked={Boolean(locked)}
                                  reason={locked}
                                  onClick={() =>
                                    dispatch({
                                      type: "setLlmInput",
                                      extra: extra.id,
                                      enabled: !selected,
                                    })
                                  }
                                >
                                  <span data-llm-input={extra.id}>{extra.label}</span>
                                </LockedChoice>
                              );
                            })}
                          </div>
                          <p className="text-[0.6875rem] text-muted">
                            Still writes text. Image or video in stays on language demand and evals.
                          </p>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  <div className="space-y-2">
                    <p className="text-[0.75rem] text-muted">Training path</p>
                    <CardGrid min="11rem">
                      {GOAL_CARDS.map((card) => {
                        const locked = goalLocks[card.id];
                        const selected = design.goal === card.id;
                        return (
                          <GameCard
                            key={card.id}
                            title={card.label}
                            interactive={!locked}
                            selected={selected}
                            ariaLabel={locked ? `${card.label} (locked)` : card.label}
                            onActivate={locked ? undefined : () => applyType(card.id)}
                            className={locked ? "models-v4-locked-card" : ""}
                          >
                            <p data-goal-card={card.id} className="text-[0.75rem] leading-5 text-muted">
                              {card.blurb}
                            </p>
                            {locked ? (
                              <p className="mt-2 text-[0.6875rem] text-amber" data-lock-reason={card.id}>
                                Locked: {locked}
                              </p>
                            ) : null}
                          </GameCard>
                        );
                      })}
                    </CardGrid>
                  </div>
                  {specialistMode ? (
                    <DomainRadar
                      requested={design.data.domainMTok}
                      available={available}
                      selectedDomain={specialistDomainOf(design.data.domainMTok)}
                      onSelectDomain={(domain) =>
                        dispatch({ type: "setFocusDomain", domain })
                      }
                    />
                  ) : null}
                  {continueMode ? (
                    <div className="space-y-3">
                      {continueParents.length > 0 ? (
                        <CardGrid min="11rem">
                          {continueParents.map((row) => (
                            <GameCard
                              key={row.id}
                              title={row.name}
                              interactive
                              selected={parentId === row.id}
                              ariaLabel={row.name}
                              onActivate={() => applyContinueParent(row.id)}
                            >
                              <p className="text-[0.75rem] leading-5 text-muted">
                                {row.arch.preset.replaceAll("_", " ")} · {row.arch.totalParamsB}B
                              </p>
                            </GameCard>
                          ))}
                        </CardGrid>
                      ) : null}
                      <HudButton
                        type="button"
                        variant={ui.continueFocus === "more_data" ? "primary" : "ghost"}
                        className="!min-h-11"
                        data-continue-intent="more_data"
                        aria-pressed={ui.continueFocus === "more_data"}
                        onClick={() => applyContinueFocus("more_data")}
                      >
                        Keep mix
                      </HudButton>
                      <DomainRadar
                        requested={design.data.domainMTok}
                        available={available}
                        trained={trainedDomainMTok(parent)}
                        selectedDomain={
                          ui.continueFocus === "more_data" ? undefined : ui.continueFocus
                        }
                        onSelectDomain={(domain) => applyContinueFocus(domain)}
                      />
                    </div>
                  ) : null}
                  {distillMode ? (
                    <div className="space-y-3">
                      {teachers.length > 0 ? (
                        <CardGrid min="11rem">
                          {teachers.map((row) => (
                            <GameCard
                              key={row.id}
                              title={row.name}
                              interactive
                              selected={teacherId === row.id}
                              ariaLabel={row.name}
                              onActivate={() =>
                                dispatch({
                                  type: "setTeacher",
                                  teacherCheckpointId: row.id,
                                  name: `${row.name} student`,
                                })
                              }
                            >
                              <p className="text-[0.75rem] leading-5 text-muted">
                                {row.status} · {row.arch.totalParamsB}B
                              </p>
                            </GameCard>
                          ))}
                        </CardGrid>
                      ) : null}
                      <SliderField
                        label="Teacher data share"
                        min={0}
                        max={1}
                        step={0.05}
                        value={design.data.teacherSynthShare ?? 0.5}
                        format={(value) => `${Math.round(value * 100)}% from teacher`}
                        onChange={(share) =>
                          dispatch({ type: "setTeacherSynthShare", share })
                        }
                      />
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {step === "architecture" ? (
            <div className="space-y-4">
              <SizeSlider
                label="Parameters"
                value={design.arch.totalParamsB}
                min={SIZE_MIN}
                max={SIZE_MAX}
                stops={[...SIZE_SLIDER_STOPS]}
                onChange={(paramsB) => dispatch({ type: "setSize", totalParamsB: paramsB })}
              />
              {design.goal === "flagship" && design.arch.totalParamsB < 70 ? (
                <p className="text-[0.6875rem] text-muted">
                  Broad snaps to the biggest size your unique tokens can feed at 20 tok/param.
                  Thin data lands below 70B.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <LockedChoice
                  selected={design.arch.backbone === "dense"}
                  locked={false}
                  onClick={() => dispatch({ type: "setBackbone", backbone: "dense" })}
                >
                  Dense
                </LockedChoice>
                <LockedChoice
                  selected={design.arch.backbone === "moe"}
                  locked={Boolean(moeLocked)}
                  reason={moeLocked}
                  onClick={() => dispatch({ type: "setBackbone", backbone: "moe" })}
                >
                  MoE
                </LockedChoice>
              </div>
              {design.arch.backbone === "moe" ? (
                <SliderField
                  label="Active fraction"
                  min={0.05}
                  max={0.35}
                  step={0.01}
                  value={activeFractionOf(design.arch)}
                  format={(value) => `${Math.round(value * 100)}% active`}
                  onChange={(fraction) => dispatch({ type: "setActiveFraction", fraction })}
                />
              ) : null}
              <div className="flex flex-wrap gap-2" data-precision-chips="true">
                {PRECISION_CHIPS.map((chip) => {
                  const locked = optionLockReason(chip.unlock, sim);
                  const selected = design.arch.precision === chip.id;
                  const thru = TRAINING_V4.precision.throughput[chip.id];
                  const gap = TRAINING_V4.precision.penalty[chip.id];
                  return (
                    <LockedChoice
                      key={chip.id}
                      selected={selected}
                      locked={Boolean(locked)}
                      reason={locked}
                      className="!flex-col !items-start !px-3 !py-1.5"
                      onClick={() => dispatch({ type: "setPrecision", precision: chip.id })}
                    >
                      <span>{chip.label}</span>
                      <span className="font-mono text-[0.625rem] text-muted">
                        ×{thru.toFixed(1)} thru · gap {gap === 0 ? "0" : gap > 0 ? `+${gap}` : `${gap}`}
                      </span>
                    </LockedChoice>
                  );
                })}
              </div>
              <p className="text-[0.6875rem] text-muted">
                In {design.arch.inputs.join(", ")} → out {design.arch.outputs.join(", ")}
              </p>
              <div data-context-slider="true">
                <SliderField
                  label="Context"
                  min={0}
                  max={CONTEXT_STOPS.length - 1}
                  step={1}
                  value={contextIdx}
                  format={(index) => formatContextK(CONTEXT_STOPS[Math.round(index)] ?? 4)}
                  onChange={(index) => {
                    const stop = CONTEXT_STOPS[Math.round(index)] ?? 4;
                    dispatch({ type: "setContext", contextK: Math.min(stop, contextCap) });
                  }}
                  sublabel={
                    <span className="font-mono text-[0.625rem] text-muted">
                      Unlocked to {formatContextK(contextCap)}
                      {nextContextLock ? ` · ${nextContextLock}` : ""}
                    </span>
                  }
                />
                <div className="mt-1 flex flex-wrap gap-1">
                  {CONTEXT_STOPS.filter((stop) =>
                    stop === 4 || stop === 32 || stop === 128 || stop === 1024 || stop === 10240 || stop === 102400,
                  ).map((stop) => {
                    const locked = stop > contextCap;
                    return (
                      <button
                        key={stop}
                        type="button"
                        disabled={locked}
                        className={`rounded px-1.5 py-0.5 font-mono text-[0.625rem] ${
                          contextK === stop
                            ? "bg-mint/20 text-mint"
                            : locked
                              ? "text-muted/50"
                              : "text-muted hover:text-bone"
                        }`}
                        onClick={() => dispatch({ type: "setContext", contextK: stop })}
                      >
                        {formatContextK(stop)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : null}

          {step === "data" ? (
            <div className="space-y-4">
              <DomainRadar requested={design.data.domainMTok} available={available} />
              <div className="flex flex-wrap gap-2" data-tok-per-param="true">
                {TOKENS_PER_PARAM_PRESETS.map((value) => {
                  const locked = tokPerParamLockReason(value, uniqueMTok, design.arch.totalParamsB);
                  return (
                    <LockedChoice
                      key={value}
                      selected={ui.tokensPerParam === value}
                      locked={Boolean(locked)}
                      reason={locked}
                      onClick={() => dispatch({ type: "setTokensPerParam", tokensPerParam: value })}
                    >
                      {value} tok/param
                    </LockedChoice>
                  );
                })}
                <LockedChoice
                  selected={isMaxTokPerParamSelected(ui.tokensPerParam, maxTokPerParam)}
                  locked={Boolean(maxTokLocked)}
                  reason={maxTokLocked}
                  onClick={() =>
                    dispatch({ type: "setTokensPerParam", tokensPerParam: maxTokPerParam })
                  }
                >
                  <span data-tok-max="true">Max {formatTokPerParam(maxTokPerParam)}</span>
                </LockedChoice>
              </div>
              <p className="text-[0.6875rem] text-muted">
                Unique data covers {formatTokPerParam(maxTokPerParam)} tok/param at this size
                {uniqueMTok > 0 ? ` · ${formatMTok(uniqueMTok)} unique` : ""}.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {DATA_DOMAINS.map((domain) => {
                  const requested = design.data.domainMTok[domain] ?? 0;
                  const unique = available[domain]?.uniqueMTok ?? 0;
                  const epochs = epochsFor(requested, unique);
                  const synthetic = breakdown?.perDomain?.[domain]?.syntheticShare
                    ?? available[domain]?.syntheticShare
                    ?? 0;
                  return (
                    <div key={domain}>
                      <SliderField
                        label={DATA_DOMAIN_META[domain].label}
                        min={0}
                        max={Math.max(unique * 3, requested, 1)}
                        step={1}
                        value={requested}
                        format={(value) => `${formatMTok(value)}Tok`}
                        onChange={(mtok) => dispatch({ type: "setDomain", domain, mtok })}
                        sublabel={
                          <span className="font-mono text-[0.625rem] text-muted">
                            {formatMTok(unique)} unique
                            {synthetic > 0 ? ` · ${Math.round(synthetic * 100)}% synth` : ""}
                          </span>
                        }
                      />
                      {epochs > 1.05 ? (
                        <p className="mt-1 text-[0.6875rem] text-amber">
                          {epochs.toFixed(1)} epochs - diminishing returns
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <SliderField
                label="Holdout share"
                min={0.01}
                max={0.1}
                step={0.01}
                value={design.data.holdoutShare}
                onChange={(share) => dispatch({ type: "setHoldout", share })}
              />
            </div>
          ) : null}

          {step === "launch" ? (
            <div className="space-y-4">
              <RunNameField
                name={design.name}
                onChange={(name) => dispatch({ type: "setName", name })}
                onRandomize={randomizeRunName}
              />
              <SliderField
                label="Priority"
                min={1}
                max={5}
                step={1}
                value={design.compute.priority}
                format={(value) => String(Math.round(value))}
                onChange={(priority) => dispatch({ type: "setPriority", priority })}
              />
              <div className="flex flex-wrap gap-2" data-compute-source="true">
                {(["local", "cloud", "mixed"] as const).map((source) => (
                  <HudButton
                    key={source}
                    type="button"
                    variant={design.compute.source === source ? "primary" : "ghost"}
                    className="!min-h-11 capitalize"
                    aria-pressed={design.compute.source === source}
                    onClick={() => dispatch({ type: "setSource", source })}
                  >
                    {source}
                  </HudButton>
                ))}
              </div>
              <SliderField
                label="Training PF / day"
                min={0}
                max={Math.max(trainingPf, design.compute.pfPerDay, 0.01)}
                step={0.01}
                value={design.compute.pfPerDay}
                format={(value) => `${value.toFixed(2)} PF`}
                onChange={(pfPerDay) => dispatch({ type: "setPfPerDay", pfPerDay })}
                sublabel={
                  <span className="font-mono text-[0.625rem] text-muted">
                    {trainingPf.toFixed(2)} PF training available
                  </span>
                }
              />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <MonoStat
                  label="P50"
                  value={forecast ? String(Math.round(forecast.capability.p50)) : "n/a"}
                />
                <MonoStat
                  label="Days"
                  value={forecast ? String(Math.round(forecast.compute.days)) : "n/a"}
                />
                <MonoStat
                  label="Cash"
                  value={forecast ? money(forecast.compute.cashEstimate) : "n/a"}
                />
                <MonoStat
                  label="HBM"
                  value={forecast ? `${forecast.compute.trainHbmGB.toFixed(0)} GB` : "n/a"}
                />
              </div>
              <div className="flex items-center gap-2 text-[0.75rem] text-muted">
                <ArchGlyph kind={glyphFor(design.arch)} size="sm" />
                <span>{design.arch.preset.replaceAll("_", " ")}</span>
              </div>
              {ui.launchError ? (
                <p role="alert" className="text-[0.75rem] text-danger">
                  {ui.launchError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="min-w-0 xl:sticky xl:top-0">
          <ForecastBand forecast={forecast} error={error} />
          {step === "architecture" ? (
            <p className="mt-2">
              <StatusChip tone="train">{design.arch.backbone}</StatusChip>
            </p>
          ) : null}
        </div>
      </div>
    </ConsoleDialog>
  );
}

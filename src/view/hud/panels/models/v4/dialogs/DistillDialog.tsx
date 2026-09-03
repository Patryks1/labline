import { useEffect, useMemo, useState } from "react";
import { DATA_DOMAINS } from "../../../../../../sim/balance/data";
import { defaultDesign, trainingStateOf } from "../../../../../../sim/training/state";
import type { Architecture } from "../../../../../../sim/training/types";
import { computeSnapshot } from "../../../../../../sim/systems/compute";
import { useGameStore } from "../../../../../../store/gameStore";
import { HudInput } from "../../../../ui/HudPrimitives";
import { ConsoleDialog } from "../../../../ui/ConsoleDialog";
import { SizeSlider } from "../../../../ui/SizeSlider";
import { CapabilityBandChip } from "../../ui/CapabilityBandChip";
import { DialogFooter } from "./DialogStepper";
import { ForecastBand } from "./ForecastBand";
import {
  PRECISION_CHIPS,
  SIZE_MAX,
  SIZE_MIN,
  SIZE_SLIDER_STOPS,
  TOKENS_PER_PARAM_PRESETS,
  actionError,
  activeFractionOf,
  availableTokensOf,
  checkpointById,
  clampTokPerParam,
  formatTokPerParam,
  isMaxTokPerParamSelected,
  maxTokensPerParam,
  optionLockReason,
  presetFor,
  scaleDomainMix,
  tokPerParamLockReason,
  tokPerParamMaxLockReason,
  totalUniqueMTok,
  withBackbone,
  withSize,
} from "./designState";
import { LockedChoice } from "./LockedChoice";
import { useSafeForecast } from "./useSafeForecast";

export function DistillDialog({
  open,
  onClose,
  teacherCheckpointId,
}: {
  open: boolean;
  onClose: () => void;
  teacherCheckpointId: string;
}) {
  const sim = useGameStore((s) => s.state);
  const forecastDesign = useGameStore((s) => s.forecastDesign);
  const startDistill = useGameStore((s) => s.startDistill);
  const teacher = checkpointById(sim, teacherCheckpointId);
  const training = trainingStateOf(sim, sim.playerLabId);
  const trainingPf = useMemo(() => {
    try {
      return Math.max(0, computeSnapshot(sim).pools.training);
    } catch {
      return 0;
    }
  }, [sim]);

  const seed = useMemo(
    () => presetFor("distill", sim, { teacherCheckpointId }),
    [sim, teacherCheckpointId],
  );
  const [arch, setArch] = useState<Architecture>(seed.arch);
  const [tokensPerParam, setTokensPerParam] = useState(20);
  const [name, setName] = useState(seed.name);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const uniqueMTok = useMemo(() => totalUniqueMTok(availableTokensOf(sim)), [sim]);
  const maxTokPerParam = maxTokensPerParam(uniqueMTok, arch.totalParamsB);
  const maxTokLocked = tokPerParamMaxLockReason(uniqueMTok);

  useEffect(() => {
    if (!open) return;
    const next = clampTokPerParam(tokensPerParam, uniqueMTok, arch.totalParamsB);
    if (Math.abs(next - tokensPerParam) > 1e-9) setTokensPerParam(next);
  }, [open, uniqueMTok, arch.totalParamsB, tokensPerParam]);

  const data = useMemo(
    () => ({
      domainMTok: scaleDomainMix(seed.data.domainMTok, tokensPerParam, arch.totalParamsB),
      holdoutShare: seed.data.holdoutShare,
    }),
    [arch.totalParamsB, seed.data.domainMTok, seed.data.holdoutShare, tokensPerParam],
  );

  const design = useMemo(
    () => ({
      ...defaultDesign(sim.day),
      ...seed,
      name,
      arch,
      data,
      mode: { kind: "distill" as const, teacherCheckpointId },
    }),
    [arch, data, name, seed, sim.day, teacherCheckpointId],
  );

  const { forecast, error } = useSafeForecast(() => forecastDesign(design), [forecastDesign, design]);

  const teacherBand = useMemo(() => {
    const evals = training.evals.filter(
      (row) => row.checkpointId === teacherCheckpointId && row.status === "complete" && row.result,
    );
    const overall = evals[0]?.result?.measured.overall as { mean: number; ci: number } | undefined;
    if (!overall) return null;
    return {
      p10: overall.mean - overall.ci,
      p50: overall.mean,
      p90: overall.mean + overall.ci,
      ceiling: 100,
    };
  }, [teacherCheckpointId, training.evals]);

  const start = () => {
    if (error || !forecast) return;
    try {
      const result = startDistill({
        teacherCheckpointId,
        studentArch: arch,
        data,
        name,
        compute: design.compute,
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
      titleId="v4-distill"
      eyebrow="Distill"
      title={teacher ? `Student of ${teacher.name}` : "Distill student"}
      description="Shrink a teacher checkpoint into a cheaper student. Compute is discounted; the architecture wall still holds."
      mobileDescription="Student size, mix, launch."
      onClose={onClose}
      closeLabel="Close distill"
      maxWidthClass="max-w-4xl"
      footer={
        <DialogFooter
          onCancel={onClose}
          primaryLabel="Start"
          onPrimary={start}
          disabled={Boolean(error) || !forecast}
          disabledReason={error ?? "Forecast unavailable"}
        />
      }
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-4">
          <div data-teacher-summary="true" className="rounded-lg border border-line/70 bg-void/35 p-3">
            <p className="hud-eyebrow">Teacher</p>
            <p className="mt-1 text-sm font-semibold text-bone">{teacher?.name ?? teacherCheckpointId}</p>
            <p className="font-mono text-[0.75rem] text-muted">
              {teacher ? `${teacher.arch.totalParamsB}B ${teacher.arch.backbone}` : "Missing checkpoint"}
            </p>
            <div className="mt-2">
              <CapabilityBandChip band={teacherBand} label="Eval" />
            </div>
          </div>
          <SizeSlider
            label="Student parameters"
            value={arch.totalParamsB}
            min={SIZE_MIN}
            max={SIZE_MAX}
            stops={[...SIZE_SLIDER_STOPS]}
            onChange={(paramsB) => setArch((current) => withSize(current, paramsB))}
          />
          <div className="flex flex-wrap gap-2">
            <LockedChoice
              selected={arch.backbone === "dense"}
              locked={false}
              onClick={() => setArch((current) => withBackbone(current, "dense"))}
            >
              Dense
            </LockedChoice>
            <LockedChoice
              selected={arch.backbone === "moe"}
              locked={Boolean(optionLockReason("moe", sim))}
              reason={optionLockReason("moe", sim)}
              onClick={() =>
                setArch((current) => withBackbone(current, "moe", activeFractionOf(current)))
              }
            >
              MoE
            </LockedChoice>
          </div>
          <div className="flex flex-wrap gap-2" data-precision-chips="true">
            {PRECISION_CHIPS.map((chip) => {
              const locked = optionLockReason(chip.unlock, sim);
              return (
                <LockedChoice
                  key={chip.id}
                  selected={arch.precision === chip.id}
                  locked={Boolean(locked)}
                  reason={locked}
                  onClick={() => setArch((current) => ({ ...current, precision: chip.id }))}
                >
                  {chip.label}
                </LockedChoice>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2" data-tok-per-param="true">
            {TOKENS_PER_PARAM_PRESETS.map((value) => {
              const locked = tokPerParamLockReason(value, uniqueMTok, arch.totalParamsB);
              return (
                <LockedChoice
                  key={value}
                  selected={tokensPerParam === value}
                  locked={Boolean(locked)}
                  reason={locked}
                  onClick={() => setTokensPerParam(value)}
                >
                  {value} tok/param
                </LockedChoice>
              );
            })}
            <LockedChoice
              selected={isMaxTokPerParamSelected(tokensPerParam, maxTokPerParam)}
              locked={Boolean(maxTokLocked)}
              reason={maxTokLocked}
              onClick={() => setTokensPerParam(maxTokPerParam)}
            >
              <span data-tok-max="true">Max {formatTokPerParam(maxTokPerParam)}</span>
            </LockedChoice>
          </div>
          <label className="block">
            <span className="text-[0.75rem] text-muted">Student name</span>
            <HudInput
              className="mt-1 min-h-11 w-full"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="Student name"
            />
          </label>
          <p className="font-mono text-[0.625rem] text-muted">
            {DATA_DOMAINS.filter((domain) => (data.domainMTok[domain] ?? 0) > 0).length} domains
            · {trainingPf.toFixed(2)} PF training
          </p>
          {actionErr ? (
            <p role="alert" className="text-[0.75rem] text-danger">
              {actionErr}
            </p>
          ) : null}
        </div>
        <ForecastBand forecast={forecast} error={error} />
      </div>
    </ConsoleDialog>
  );
}

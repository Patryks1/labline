import type { TrainingJob } from "../../../../sim/types";
import { pacedTrainingPfPerDay } from "../../../../sim/balance/training";
import type { TrainingResourceAllocation } from "../../../../sim/systems/training";
import { num } from "../../format";

type ReleaseGate = {
  ok: boolean;
  reason?: string;
};

export function trainingRemainingTime({
  targetPfDays,
  progressPfDays,
  allocatedPf,
  minCalendarDays,
}: Pick<TrainingJob, "targetPfDays" | "progressPfDays"> & {
  minCalendarDays?: number;
  allocatedPf: number;
}) {
  const remainingPf = Math.max(0, targetPfDays - progressPfDays);
  const computeDone = remainingPf <= 1e-9;
  const usefulPfLimit = pacedTrainingPfPerDay(targetPfDays, minCalendarDays);
  const usefulAllocatedPf = Math.min(Math.max(0, allocatedPf), usefulPfLimit);
  const computeEta = computeDone
    ? 0
    : usefulAllocatedPf > 0.05
      ? remainingPf / usefulAllocatedPf
      : Infinity;

  return {
    computeDone,
    computeEta,
    paceLimited: allocatedPf > usefulPfLimit + 1e-9,
    usefulAllocatedPf,
    etaDays: computeEta,
  };
}

export function trainingReleaseDisabledReason(
  gate: ReleaseGate,
): string | undefined {
  return gate.ok ? undefined : gate.reason;
}

export function hardwareDiagnostic(
  resources: TrainingResourceAllocation | undefined,
): string {
  if (!resources)
    return "No compatible training hardware is available; allocation diagnostics are unavailable.";
  const issues: string[] = [];
  const hbmShort = Math.max(
    0,
    resources.ramRequiredGb - resources.ramAllocatedGb,
  );
  const ramShort = Math.max(
    0,
    resources.systemRamRequiredGb - resources.systemRamAllocatedGb,
  );
  if (hbmShort > 1e-9) issues.push(`HBM short by ${num(hbmShort)} GB`);
  if (ramShort > 1e-9) issues.push(`system RAM short by ${num(ramShort)} GB`);
  if (resources.effectivePf <= 0.05)
    issues.push(`${num(resources.effectivePf)} PF/d allocated`);
  if (resources.bottleneck !== "none")
    issues.push(`bottleneck: ${resources.bottleneck.replace("_", " ")}`);
  return issues.length
    ? `No compatible training hardware: ${issues.join(" · ")}.`
    : "No compatible training hardware is available; check accelerator generation and training allocation.";
}

export function classifyTrainingStatus({
  failed = false,
  paused = false,
  stallReason = "",
  resources,
  completeReady,
  plateaued,
  launchReady = false,
}: {
  failed?: boolean;
  paused?: boolean;
  stallReason?: string | null;
  resources?: TrainingResourceAllocation;
  completeReady: boolean;
  plateaued: boolean;
  launchReady?: boolean;
}) {
  const ramBlocked = Boolean(
    resources &&
    (!resources.ramReady || !resources.systemRamReady) &&
    !failed &&
    !paused &&
    !completeReady,
  );
  const normalizedStall = (stallReason ?? "").toLowerCase();
  const incompatible =
    normalizedStall.includes("no compatible training hardware") ||
    normalizedStall.includes("incompatible");
  const powerBlocked =
    normalizedStall.includes("power") || normalizedStall.includes("brownout");
  const memoryBlocked =
    ramBlocked ||
    Boolean(resources && resources.bottleneck !== "none") ||
    /\b(hbm|ram|memory)\b/.test(normalizedStall);
  const unstable = /\b(unstable|diverg|nan|numerical)\b/.test(normalizedStall);
  const visuallyBlocked =
    memoryBlocked || powerBlocked || incompatible || unstable;
  const diagnosticStall = incompatible
    ? hardwareDiagnostic(resources)
    : stallReason || undefined;
  const statusLabel = failed
    ? "Failed"
    : paused
      ? "Paused"
      : incompatible
        ? "Incompatible"
        : powerBlocked
          ? "Power blocked"
          : memoryBlocked
            ? "Memory blocked"
            : unstable
              ? "Unstable"
              : completeReady
                ? "Ready"
                : plateaued
                  ? "Plateaued"
                  : launchReady
                    ? "Launchable"
                    : "Progressing";

  return {
    diagnosticStall,
    incompatible,
    memoryBlocked,
    powerBlocked,
    ramBlocked,
    statusLabel,
    unstable,
    visuallyBlocked,
  };
}

type LossPoint = NonNullable<TrainingJob["lossHistory"]>[number];

export function lossStageMarkers(points: LossPoint[]) {
  return points.flatMap((point, index) => {
    if (
      index === 0 ||
      point.stage === points[index - 1]!.stage ||
      point.stage === "base"
    )
      return [];
    return [{ point, index }];
  });
}

export function trainingEnergyLabel({
  energyMWh,
  mwDays,
  estimated = false,
}: {
  energyMWh?: number;
  mwDays?: number;
  estimated?: boolean;
}): string {
  const prefix = estimated ? "~" : "";
  const pending = energyMWh == null && mwDays == null;
  return [
    `energy ${energyMWh == null ? "—" : `${prefix}${energyMWh.toFixed(2)} MWh`}`,
    mwDays == null ? undefined : `${prefix}${mwDays.toFixed(2)} MW-d`,
    pending ? "telemetry pending" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

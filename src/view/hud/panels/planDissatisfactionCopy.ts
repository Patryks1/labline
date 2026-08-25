import { createElement } from "react";
import { pct } from "../format";
import { StatusChip } from "../ui/HudPrimitives";

/** Ignore noise that would not surface the dissatisfied chip. */
const CAUSE_MIN = 0.03;
const SERVE_SHORTFALL_MIN = 0.03;

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function operationalBlend(
  allowance: number,
  stability: number,
  slowness: number,
): number {
  return clamp01(
    1 -
      (1 - clamp01(allowance)) *
        (1 - clamp01(stability)) *
        (1 - clamp01(slowness)),
  );
}

/**
 * Brand is blended in market settlement and is not stored on PlanDayStats.
 * Recover it from the same 1-(1-a)(1-b) mix so the HUD does not omit it.
 */
function brandResidual(dissatisfaction: number, operational: number): number {
  const total = clamp01(dissatisfaction);
  const ops = clamp01(operational);
  if (ops >= 0.999) return 0;
  return clamp01(1 - (1 - total) / Math.max(1e-9, 1 - ops));
}

export type PlanDissatisfactionChipInput = {
  isFree: boolean;
  dissatisfaction: number;
  allowanceDissatisfaction?: number;
  stabilityDissatisfaction?: number;
  slownessDissatisfaction?: number;
  /** This plan's admitted share of unconstrained demand. */
  serveFraction?: number;
  serveOutage?: boolean;
  /** Subscription-channel throttle EMA; omit when unknown. */
  subSpeedStrain?: number;
  /** Used only when today's plan stats have not settled. */
  allowanceFallback?: number;
  allowanceFallbackLabel?: string;
};

function slownessCause(input: PlanDissatisfactionChipInput): string {
  const strain = input.subSpeedStrain;
  let text =
    strain == null
      ? "slow streams"
      : strain >= CAUSE_MIN
        ? "slow streams from overload"
        : "streams below 30 tok/s";
  if (input.isFree) text += " (free users are less sensitive)";
  return text;
}

function slownessExtras(input: PlanDissatisfactionChipInput): string[] {
  if (input.serveOutage) return ["inference outage"];
  const served = input.serveFraction;
  if (served == null || !Number.isFinite(served)) return [];
  const unserved = clamp01(1 - served);
  if (unserved < SERVE_SHORTFALL_MIN) return [];
  return [`${pct(unserved, 0)} of this plan unserved`];
}

/**
 * Compact native-title copy for the plan-card dissatisfied chip.
 * Lists the causes the sim actually blends into plan dissatisfaction.
 * Peak API pricing is not a subscription-plan input and is never mentioned.
 */
export function planDissatisfactionChipTitle(
  input: PlanDissatisfactionChipInput,
): string {
  const allowance = input.allowanceDissatisfaction ?? 0;
  const stability = input.stabilityDissatisfaction ?? 0;
  const slowness = input.slownessDissatisfaction ?? 0;
  const hasSettledCauses =
    input.allowanceDissatisfaction != null ||
    input.stabilityDissatisfaction != null ||
    input.slownessDissatisfaction != null;

  const scored: { score: number; parts: string[] }[] = [];

  if (slowness >= CAUSE_MIN) {
    scored.push({
      score: slowness,
      parts: [slownessCause(input), ...slownessExtras(input)],
    });
  }
  if (allowance >= CAUSE_MIN) {
    scored.push({
      score: allowance,
      parts: [
        input.isFree
          ? "include below free-tier floor"
          : "include below expected for this price",
      ],
    });
  }
  if (stability >= CAUSE_MIN) {
    scored.push({
      score: stability,
      parts: [
        input.isFree ? "unsustainable subsidy" : "losing money / sub",
      ],
    });
  }
  if (hasSettledCauses) {
    const brand = brandResidual(
      input.dissatisfaction,
      operationalBlend(allowance, stability, slowness),
    );
    if (brand >= CAUSE_MIN) {
      scored.push({ score: brand, parts: ["weak brand patience"] });
    }
  }

  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score);
    return scored.flatMap((cause) => cause.parts).join(" · ");
  }

  if ((input.allowanceFallback ?? 0) >= CAUSE_MIN) {
    return (
      input.allowanceFallbackLabel ??
      (input.isFree
        ? "include below free-tier floor"
        : "Included usage is below what customers expect at this price and capability.")
    );
  }
  if (input.serveOutage) {
    return "Inference outage is reducing satisfaction.";
  }
  const served = input.serveFraction;
  if (served != null && Number.isFinite(served) && 1 - served >= SERVE_SHORTFALL_MIN) {
    return `${pct(1 - served, 0)} of this plan unserved.`;
  }
  return "Reliability or available compute is reducing satisfaction.";
}

/** Plan-card dissatisfied chip; title carries the sim-backed why breakdown. */
export function PlanDissatisfactionStatusChip(
  input: PlanDissatisfactionChipInput,
) {
  if (input.dissatisfaction <= 0.05) return null;
  return createElement(
    StatusChip,
    {
      tone: "danger",
      title: planDissatisfactionChipTitle(input),
    },
    `${pct(input.dissatisfaction)} dissatisfied`,
  );
}

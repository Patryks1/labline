import type { ResearchEffects, ResearchNodeDef } from "../../../sim/types";
import {
  TRAINING_UNLOCK_LABELS,
} from "../../../sim/training/modifiers";
import type { TrainingUnlock } from "../../../sim/training/types";

export type EffectChipTone = "good" | "neutral" | "unlock";

export interface EffectChip {
  label: string;
  tone: EffectChipTone;
}

function formatTimes(value: number): string {
  return `×${value.toFixed(2).replace(/\.?0+$/, "")}`;
}

function formatDelta(value: number): string {
  const text = value.toFixed(2).replace(/\.?0+$/, "");
  return value > 0 ? `+${text}` : text;
}

function formatPct(value: number): string {
  const pct = value * 100;
  const text = Math.abs(pct).toFixed(0);
  return `${pct >= 0 ? "+" : "−"}${text}%`;
}

const LOWER_IS_BETTER = new Set([
  "paramEfficiency",
  "dataEfficiency",
  "stability",
  "precisionPenaltyMult",
  "hostingDiscount",
  "quantPenaltyMult",
]);

function multChip(
  label: string,
  value: number | undefined,
  key: string,
): EffectChip | null {
  if (value == null || value === 1) return null;
  const better = LOWER_IS_BETTER.has(key) ? value < 1 : value > 1;
  return {
    label: `${label} ${formatTimes(value)}`,
    tone: better ? "good" : "neutral",
  };
}

function addChip(
  chips: EffectChip[],
  label: string,
  value: number | undefined,
  key: string,
): void {
  const chip = multChip(label, value, key);
  if (chip) chips.push(chip);
}

function livePctChip(
  label: string,
  value: number | undefined,
  invert = false,
): EffectChip | null {
  if (value == null || value === 0) return null;
  const better = invert ? value < 0 : value > 0;
  return {
    label: `${label} ${formatPct(value)}`,
    tone: better ? "good" : "neutral",
  };
}

/**
 * Exact V4 modifier chips for a catalog node, plus remaining live
 * serving / PUE / data effects that non-training systems still apply.
 */
export function effectChips(node: ResearchNodeDef): EffectChip[] {
  const e: ResearchEffects = node.effects;
  const chips: EffectChip[] = [];

  addChip(chips, "A", e.paramEfficiency, "paramEfficiency");
  addChip(chips, "B", e.dataEfficiency, "dataEfficiency");
  addChip(chips, "Throughput", e.computeThroughput, "computeThroughput");
  addChip(chips, "σ", e.stability, "stability");
  addChip(chips, "Precision penalty", e.precisionPenaltyMult, "precisionPenaltyMult");
  if (e.ceilingLift) {
    chips.push({
      label: `Ceiling ${formatDelta(e.ceilingLift)}`,
      tone: e.ceilingLift > 0 ? "good" : "neutral",
    });
  }
  addChip(chips, "Post-train", e.postTrainEfficiency, "postTrainEfficiency");
  if (e.rlQuality) {
    chips.push({
      label: `RL ${formatDelta(e.rlQuality)}`,
      tone: e.rlQuality > 0 ? "good" : "neutral",
    });
  }
  addChip(chips, "Synthetic", e.syntheticQuality, "syntheticQuality");
  if (e.verifierStrength) {
    chips.push({
      label: `Verifier ${formatDelta(e.verifierStrength)}`,
      tone: e.verifierStrength > 0 ? "good" : "neutral",
    });
  }
  addChip(chips, "Distill", e.distillEfficiency, "distillEfficiency");
  if (e.routerQuality) {
    chips.push({
      label: `Router ${formatDelta(e.routerQuality)}`,
      tone: e.routerQuality > 0 ? "good" : "neutral",
    });
  }
  addChip(chips, "Serve", e.serveEfficiency, "serveEfficiency");
  addChip(chips, "Hosting", e.hostingDiscount, "hostingDiscount");
  addChip(chips, "Quant penalty", e.quantPenaltyMult, "quantPenaltyMult");
  addChip(chips, "Modality", e.modalityBridge, "modalityBridge");

  for (const unlock of e.unlock ?? []) {
    const name = TRAINING_UNLOCK_LABELS[unlock as TrainingUnlock] ?? unlock;
    chips.push({ label: `Unlock: ${name}`, tone: "unlock" });
  }

  const util = livePctChip("Util", e.utilCap);
  if (util) chips.push(util);
  const tokens = livePctChip("Tokens", e.servingEfficiency);
  if (tokens) chips.push(tokens);
  if (e.energyPue) {
    chips.push({
      label: `PUE ${e.energyPue < 0 ? "−" : "+"}${Math.abs(e.energyPue * 100).toFixed(0)} pts`,
      tone: e.energyPue < 0 ? "good" : "neutral",
    });
  }
  const fly = livePctChip("Data", e.dataFlywheel);
  if (fly) chips.push(fly);
  if (e.gymQualityBonus) {
    chips.push({
      label: `Gym ${formatDelta(e.gymQualityBonus)}`,
      tone: "good",
    });
  }
  const hostOpex = livePctChip("Host opex", e.hostingOpexDiscount, true);
  if (hostOpex) {
    chips.push({
      ...hostOpex,
      label: `Host opex −${(e.hostingOpexDiscount! * 100).toFixed(0)}%`,
      tone: "good",
    });
  }
  if (e.unlockCorpusSpecialists) {
    chips.push({ label: "Specialist data", tone: "unlock" });
  }
  if (e.unlockClosedLoopResearch) {
    chips.push({ label: "Unlock: Closed-loop", tone: "unlock" });
  }

  return chips;
}

import { useGameStore } from "../../../../../store/gameStore";
import { trainingStateOf } from "../../../../../sim/training/state";
import type { IncidentChoice, RunIncident } from "../../../../../sim/training/types";

export function effectSummary(choice: IncidentChoice): string {
  const parts: string[] = [];
  const { effects } = choice;
  if (effects.sigmaMult != null) parts.push(`σ ×${effects.sigmaMult.toFixed(2)}`);
  if (effects.costMult != null) parts.push(`cost ×${effects.costMult.toFixed(2)}`);
  if (effects.rollbackProgress != null) {
    parts.push(`rollback ${(effects.rollbackProgress * 100).toFixed(0)}%`);
  }
  if (effects.daysDelta != null) {
    const sign = effects.daysDelta > 0 ? "+" : "";
    parts.push(`${sign}${effects.daysDelta} days`);
  }
  if (effects.gapDelta != null) {
    const sign = effects.gapDelta > 0 ? "+" : "";
    parts.push(`gap ${sign}${effects.gapDelta.toFixed(2)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "No numeric effect";
}

export function usePendingIncident(): { runId: string; incident: RunIncident } | null {
  return useGameStore((store) => {
    const training = trainingStateOf(store.state, store.state.playerLabId);
    const run = training.runs.find((entry) => entry.status === "awaiting_decision");
    const incident = run?.incidents.find((entry) => entry.resolvedChoiceId == null);
    if (!run || !incident) return null;
    return { runId: run.id, incident };
  });
}

import type { IncidentChoice, RunIncident, TrainingRun } from "./types";

/**
 * AFK convention: `incident.choices[last]` is the conservative auto-resolve
 * option (duty-scientist default). Rivals that fire an incident take
 * `choices[0]` immediately instead. Choices never redraw ε.
 */
export function conservativeChoice(incident: RunIncident): IncidentChoice | undefined {
  return incident.choices[incident.choices.length - 1];
}

export function firstChoice(incident: RunIncident): IncidentChoice | undefined {
  return incident.choices[0];
}

export function unresolvedIncident(run: TrainingRun): RunIncident | undefined {
  return run.incidents.find((incident) => incident.resolvedChoiceId == null);
}

function applyEffects(run: TrainingRun, effects: IncidentChoice["effects"]): TrainingRun {
  const rollback = Math.max(0, effects.rollbackProgress ?? 0);
  return {
    ...run,
    sigmaMult: run.sigmaMult * (effects.sigmaMult ?? 1),
    costMult: run.costMult * (effects.costMult ?? 1),
    progress: Math.max(0, run.progress - rollback),
    etaDays: Math.max(0, run.etaDays + (effects.daysDelta ?? 0)),
    gapDelta: run.gapDelta + (effects.gapDelta ?? 0),
  };
}

/** Apply a catalog choice and mark the incident resolved. No-op if already resolved. */
export function applyIncidentChoice(
  run: TrainingRun,
  incidentId: string,
  choiceId: string,
): TrainingRun {
  const incident = run.incidents.find((row) => row.id === incidentId);
  if (!incident || incident.resolvedChoiceId != null) return run;
  const choice = incident.choices.find((row) => row.id === choiceId);
  if (!choice) return run;
  const applied = applyEffects(run, choice.effects);
  return {
    ...applied,
    incidents: applied.incidents.map((row) =>
      row.id === incidentId ? { ...row, resolvedChoiceId: choiceId } : row,
    ),
  };
}

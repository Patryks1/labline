import { useState } from "react";
import { useGameStore } from "../../../../../store/gameStore";
import type { RunIncident } from "../../../../../sim/training/types";
import { ConsoleDialog } from "../../../ui/ConsoleDialog";
import { effectSummary, usePendingIncident } from "./incidentUi";

export function IncidentModal({
  open,
  runId,
  incident,
  onClose,
}: {
  open: boolean;
  runId: string;
  incident: RunIncident | null;
  onClose: () => void;
}) {
  const resolveIncident = useGameStore((store) => store.resolveIncident);
  if (!incident) return null;

  return (
    <ConsoleDialog
      open={open}
      titleId="run-incident-title"
      eyebrow="Run incident"
      title={incident.title}
      description={incident.body}
      mobileDescription={`Resolve by day ${incident.autoResolveDay}.`}
      onClose={onClose}
      closeLabel="Decide later"
      maxWidthClass="max-w-3xl"
    >
      <div className="space-y-3" data-incident-modal="true">
        <p className="font-mono text-[0.6875rem] leading-5 text-muted">
          Auto-resolve D{incident.autoResolveDay} if you walk away.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {incident.choices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              data-incident-choice={choice.id}
              onClick={() => {
                resolveIncident(runId, incident.id, choice.id);
                onClose();
              }}
              className="min-h-11 rounded-md border border-line/60 bg-void/40 p-3 text-left transition hover:border-train/55 hover:bg-train/10"
            >
              <strong className="block text-[0.8125rem] text-bone">{choice.label}</strong>
              <span className="mt-1.5 block text-[0.75rem] leading-5 text-muted">
                {choice.description}
              </span>
              <span className="mt-2 block font-mono text-[0.625rem] leading-4 text-bone">
                {effectSummary(choice)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </ConsoleDialog>
  );
}

/** Auto-opens when a player Run is awaiting a decision. */
export function IncidentModalHost() {
  const pending = usePendingIncident();
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const incidentId = pending?.incident.id ?? null;
  const open = pending != null && incidentId !== dismissedId;

  if (!pending) return null;
  return (
    <IncidentModal
      open={open}
      runId={pending.runId}
      incident={pending.incident}
      onClose={() => setDismissedId(pending.incident.id)}
    />
  );
}

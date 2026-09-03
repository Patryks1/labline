import { useEffect, useMemo, useState } from "react";
import type { SimState } from "../../../../../../sim/types";
import { canMerge } from "../../../../../../sim/training/merge";
import { trainingStateOf } from "../../../../../../sim/training/state";
import { useGameStore } from "../../../../../../store/gameStore";
import { HudButton, HudInput } from "../../../../ui/HudPrimitives";
import { ConsoleDialog } from "../../../../ui/ConsoleDialog";
import { DialogFooter } from "./DialogStepper";
import { actionError, checkpointById } from "./designState";

function mergeEligibility(state: SimState, aId: string, bId: string) {
  try {
    return canMerge(state, aId, bId);
  } catch (cause) {
    return { ok: false as const, reason: actionError(cause) };
  }
}

export function MergeDialog({
  open,
  onClose,
  aId,
  bId: initialBId,
}: {
  open: boolean;
  onClose: () => void;
  aId: string;
  bId?: string;
}) {
  const sim = useGameStore((s) => s.state);
  const mergeCheckpoints = useGameStore((s) => s.mergeCheckpoints);
  const training = trainingStateOf(sim, sim.playerLabId);
  const left = checkpointById(sim, aId);
  const candidates = training.checkpoints.filter((row) => row.id !== aId);
  const [bId, setBId] = useState(initialBId ?? "");
  const [name, setName] = useState(left ? `${left.name} merge` : "Merged checkpoint");
  const [actionErr, setActionErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const ranked = [...candidates].sort((a, b) => {
      const aOk = mergeEligibility(sim, aId, a.id).ok ? 0 : 1;
      const bOk = mergeEligibility(sim, aId, b.id).ok ? 0 : 1;
      return aOk - bOk;
    });
    const nextB = initialBId && ranked.some((row) => row.id === initialBId)
      ? initialBId
      : ranked.find((row) => mergeEligibility(sim, aId, row.id).ok)?.id ?? ranked[0]?.id ?? "";
    setBId(nextB);
    setName(left ? `${left.name} merge` : "Merged checkpoint");
    setActionErr(null);
    // Re-seed picker when the dialog opens for a new left checkpoint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, aId, initialBId]);

  const eligibility = useMemo(
    () => (bId ? mergeEligibility(sim, aId, bId) : { ok: false as const, reason: "Pick a second checkpoint." }),
    [aId, bId, sim],
  );

  const merge = () => {
    if (!bId || !eligibility.ok) return;
    try {
      const result = mergeCheckpoints(aId, bId, name);
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
      titleId="v4-merge"
      eyebrow="Merge"
      title={left ? `Merge ${left.name}` : "Merge checkpoints"}
      description="Same backbone, preset, and size within 5%. Needs merge research. Bonus 1.5 capability, 15% regression risk. Writes a new child checkpoint."
      mobileDescription="Pick a second checkpoint."
      onClose={onClose}
      closeLabel="Close merge"
      maxWidthClass="max-w-lg"
      footer={
        <DialogFooter
          onCancel={onClose}
          primaryLabel="Merge"
          onPrimary={merge}
          disabled={!eligibility.ok || !bId}
          disabledReason={eligibility.reason}
        />
      }
    >
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-[0.75rem] text-muted">Second checkpoint</p>
          <div className="flex flex-col gap-2" data-merge-picker="true">
            {candidates.length === 0 ? (
              <p className="text-[0.75rem] text-muted">No other checkpoints to merge.</p>
            ) : (
              candidates.map((row) => {
                const rowOk = mergeEligibility(sim, aId, row.id);
                return (
                  <HudButton
                    key={row.id}
                    type="button"
                    variant={bId === row.id ? "primary" : "ghost"}
                    className={`!min-h-11 !justify-between ${rowOk.ok ? "" : "grayscale"}`}
                    aria-pressed={bId === row.id}
                    data-merge-ok={rowOk.ok ? "true" : "false"}
                    onClick={() => setBId(row.id)}
                  >
                    <span className="min-w-0 truncate text-left">{row.name}</span>
                    <span className="shrink-0 font-mono text-[0.625rem] text-muted">
                      {row.arch.totalParamsB}B{rowOk.ok ? "" : " · blocked"}
                    </span>
                  </HudButton>
                );
              })
            )}
          </div>
        </div>
        <label className="block">
          <span className="text-[0.75rem] text-muted">Child name</span>
          <HudInput
            className="mt-1 min-h-11 w-full"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Merged checkpoint name"
          />
        </label>
        <p
          data-merge-reason="true"
          className={`text-[0.75rem] ${eligibility.ok ? "text-mint" : "text-amber"}`}
        >
          {eligibility.ok ? "These checkpoints can merge." : eligibility.reason}
        </p>
        {actionErr ? (
          <p role="alert" className="text-[0.75rem] text-danger">
            {actionErr}
          </p>
        ) : null}
      </div>
    </ConsoleDialog>
  );
}

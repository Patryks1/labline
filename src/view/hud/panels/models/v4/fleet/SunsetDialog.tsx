import { useEffect, useState } from "react";
import { TRAINING_V4 } from "../../../../../../sim/training/constants";
import { useGameStore } from "../../../../../../store/gameStore";
import { ConsoleDialog } from "../../../../ui/ConsoleDialog";
import { HudButton } from "../../../../ui/HudPrimitives";
import { SliderField } from "../../../../ui/SliderField";
import { trySim } from "./fleetModel";

export const DEFAULT_SUNSET_DRAIN_DAYS = TRAINING_V4.endpoints.sunsetDrainDays;

export function SunsetDialog({
  open,
  onClose,
  endpointId,
}: {
  open: boolean;
  onClose: () => void;
  endpointId: string;
}) {
  const sunsetEndpoint = useGameStore((s) => s.sunsetEndpoint);
  const [drainDays, setDrainDays] = useState<number>(DEFAULT_SUNSET_DRAIN_DAYS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDrainDays(DEFAULT_SUNSET_DRAIN_DAYS);
    setError(null);
  }, [open, endpointId]);

  const confirm = () => {
    const result = trySim(() => {
      sunsetEndpoint(endpointId, drainDays);
      return true;
    }, false);
    if (!result) {
      setError("Could not start sunset.");
      return;
    }
    onClose();
  };

  return (
    <ConsoleDialog
      open={open}
      titleId="sunset-dialog-title"
      eyebrow="Fleet"
      title="Sunset endpoint"
      description="Demand drains over the chosen window. HBM stays reserved until the drain completes, then releases."
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-1.5">
          <HudButton variant="ghost" className="min-h-11" onClick={onClose}>
            Cancel
          </HudButton>
          <HudButton variant="danger" className="min-h-11" onClick={confirm}>
            Confirm sunset
          </HudButton>
        </div>
      }
    >
      <div className="space-y-4" data-sunset-dialog={endpointId}>
        <SliderField
          label="Drain days"
          value={drainDays}
          min={7}
          max={120}
          step={1}
          format={(value) => `${Math.round(value)} days`}
          onChange={setDrainDays}
        />
        <p className="text-[0.75rem] leading-5 text-muted">
          Traffic and revenue wind down across the drain. Serving memory stays
          resident until the last day, then the endpoint can be retired.
        </p>
        {error ? (
          <p className="text-[0.75rem] text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </ConsoleDialog>
  );
}

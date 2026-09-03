import type { CapBandVM } from "../viewModels/types";
import { MonoStat } from "./MonoStat";

function fmt(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

/** P50 as the score, half the P10–P90 width as ±. Matches eval mean ± CI. */
export function formatCapScore(band: CapBandVM): string {
  const spread = Math.max(0, (band.p90 - band.p10) / 2);
  return `${fmt(band.p50)} ±${fmt(spread)}`;
}

export function OverallScoreStat({
  band,
  label = "Overall",
}: {
  band: CapBandVM | null;
  label?: string;
}) {
  return (
    <MonoStat
      label={label}
      value={band ? formatCapScore(band) : "-"}
      hint={band ? `ceil ${Math.round(band.ceiling)}` : undefined}
      tone={band ? "good" : "default"}
    />
  );
}

export function CapabilityBandChip({
  band,
  label = "Overall",
}: {
  band: CapBandVM | null;
  label?: string;
}) {
  const text = band ? `${label} ${formatCapScore(band)}` : "Unmeasured";
  return (
    <span
      className={`status-chip max-w-full font-mono ${band ? "status-chip--train" : ""}`}
      data-cap-band={band ? "true" : "empty"}
      title={
        band
          ? `P10 ${fmt(band.p10)} · P90 ${fmt(band.p90)} · ceiling ${Math.round(band.ceiling)}`
          : undefined
      }
    >
      {text}
    </span>
  );
}

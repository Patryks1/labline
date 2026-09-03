import type { Forecast, PostTrainForecast } from "../../../../../../sim/training/types";
import { money } from "../../../../format";
import { BlockerList, StatRow } from "../../../../ui/kit";
import { formatDays, formatPfDays } from "./designState";

export function ForecastBand({
  forecast,
  error,
}: {
  forecast: Forecast | null;
  error?: string | null;
}) {
  if (error || !forecast) {
    return (
      <aside
        data-forecast-band="true"
        data-forecast-unavailable="true"
        role="status"
        className="rounded-lg border border-amber/35 bg-amber/8 p-3"
      >
        <p className="text-[0.75rem] font-semibold text-amber">Forecast unavailable</p>
        <p className="mt-1 text-[0.6875rem] leading-5 text-muted">
          {error && error !== "not implemented"
            ? error
            : "Live P10/P50/P90 cannot be computed yet. Launch is disabled."}
        </p>
      </aside>
    );
  }

  const { p10, p50, p90, ceiling } = forecast.capability;
  const trackMax = Math.max(100, ceiling, p90);
  const pct = (value: number) => `${Math.max(0, Math.min(100, (value / trackMax) * 100))}%`;

  return (
    <aside
      data-forecast-band="true"
      aria-label="Capability forecast"
      className="rounded-lg border border-line/70 bg-void/45 p-3"
    >
      <p className="hud-eyebrow">Forecast</p>
      <div className="mt-3" data-capability-track="true">
        <div className="relative h-3 rounded-full bg-panel-2">
          <span
            data-p10-p90="true"
            className="absolute inset-y-0 rounded-full bg-mint/35"
            style={{ left: pct(p10), width: `calc(${pct(p90)} - ${pct(p10)})` }}
          />
          <span
            data-p50="true"
            className="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-mint"
            style={{ left: pct(p50) }}
          />
          <span
            data-ceiling="true"
            title={`Ceiling ${Math.round(ceiling)}`}
            className="absolute top-0 h-3 w-px bg-gold"
            style={{ left: pct(ceiling) }}
          />
        </div>
        <div className="mt-1.5 flex justify-between font-mono text-[0.625rem] tabular-nums text-muted">
          <span data-p10="true">P10 {Math.round(p10)}</span>
          <span>P50 {Math.round(p50)}</span>
          <span data-p90="true">P90 {Math.round(p90)}</span>
          <span>ceil {Math.round(ceiling)}</span>
        </div>
      </div>
      <div className="mt-2">
        <StatRow label="PF-days" value={formatPfDays(forecast.compute.totalPfDays)} />
        <StatRow label="Days" value={formatDays(forecast.compute.days)} />
        <StatRow label="Cash" value={money(forecast.compute.cashEstimate)} />
      </div>
      {forecast.blockers.length > 0 ? (
        <div className="mt-2" data-forecast-blockers="true">
          <BlockerList
            items={forecast.blockers.map((blocker) => ({ text: blocker.message }))}
          />
        </div>
      ) : null}
      {forecast.warnings.length > 0 ? (
        <ul data-forecast-warnings="true" className="mt-2 space-y-1">
          {forecast.warnings.map((warning) => (
            <li key={warning} className="text-[0.6875rem] text-amber">
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}

export function PostTrainForecastPanel({
  forecast,
  error,
}: {
  forecast: PostTrainForecast | null;
  error?: string | null;
}) {
  if (error || !forecast) {
    return (
      <aside
        data-forecast-band="true"
        data-forecast-unavailable="true"
        role="status"
        className="rounded-lg border border-amber/35 bg-amber/8 p-3"
      >
        <p className="text-[0.75rem] font-semibold text-amber">Forecast unavailable</p>
        <p className="mt-1 text-[0.6875rem] leading-5 text-muted">
          Post-train deltas cannot be computed yet. Start is disabled.
        </p>
      </aside>
    );
  }

  const deltas = Object.entries(forecast.deltas).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number",
  );

  return (
    <aside data-posttrain-forecast="true" className="rounded-lg border border-line/70 bg-void/45 p-3">
      <p className="hud-eyebrow">Post-train forecast</p>
      {forecast.unlocksTiers ? (
        <p className="status-chip status-chip--positive mt-2 font-mono">Can train thinking budgets</p>
      ) : null}
      {deltas.length > 0 ? (
        <table className="mt-2 w-full text-left font-mono text-[0.6875rem] tabular-nums">
          <thead>
            <tr className="text-muted">
              <th className="py-1 font-medium">Domain</th>
              <th className="py-1 text-right font-medium">Delta</th>
            </tr>
          </thead>
          <tbody>
            {deltas.map(([domain, delta]) => (
              <tr key={domain}>
                <td className="py-0.5 capitalize text-bone">{domain}</td>
                <td className={`py-0.5 text-right ${delta >= 0 ? "text-mint" : "text-danger"}`}>
                  {delta >= 0 ? "+" : ""}
                  {delta.toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-2 text-[0.6875rem] text-muted">No predicted deltas yet.</p>
      )}
      <ul className="mt-2 space-y-1">
        {Object.entries(forecast.adequacy).map(([stage, value]) =>
          typeof value === "number" ? (
            <li key={stage} className="flex items-center gap-2">
              <span className="w-20 shrink-0 capitalize text-[0.6875rem] text-muted">{stage}</span>
              <span className="hud-progress min-w-0 flex-1">
                <span
                  className="hud-progress__fill hud-progress__fill--train"
                  style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }}
                />
              </span>
              <span className="font-mono text-[0.625rem] tabular-nums text-bone">
                {Math.round(value * 100)}%
              </span>
            </li>
          ) : null,
        )}
      </ul>
      <div className="mt-2">
        <StatRow label="Days" value={formatDays(forecast.days)} />
        <StatRow label="Cash" value={money(forecast.cash)} />
        <StatRow label="PF-days" value={formatPfDays(forecast.pfDays)} />
      </div>
      {forecast.warnings.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {forecast.warnings.map((warning) => (
            <li key={warning} className="text-[0.6875rem] text-amber">
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}

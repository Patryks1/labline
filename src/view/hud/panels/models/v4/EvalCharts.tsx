import type { RadarAxis } from "../../../ui/radarGeometry";
import { polygonPoints, radarGeometry, scaledPoint } from "../../../ui/radarGeometry";
import type { EvalMeasurement, EvalMetric, LossSample } from "../../../../../sim/training/types";
import { CORE_EVAL_METRICS } from "./dialogs/designState";

const BAR_METRICS: readonly EvalMetric[] = CORE_EVAL_METRICS;

const SHORT_METRIC: Partial<Record<EvalMetric, string>> = {
  language: "Lang",
  reasoning: "Reason",
  science: "Sci",
  overall: "Overall",
};

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function shortMetric(metric: EvalMetric): string {
  return SHORT_METRIC[metric] ?? titleCase(metric);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function measuredRows(
  measured: Partial<Record<EvalMetric, EvalMeasurement>>,
): { metric: EvalMetric; measurement: EvalMeasurement }[] {
  return BAR_METRICS.flatMap((metric) => {
    const measurement = measured[metric];
    return measurement ? [{ metric, measurement }] : [];
  });
}

/** Map measured means ± CI onto the radar so early scores are not a speck at the origin. */
export function relativeEvalScale(
  rows: { measurement: EvalMeasurement }[],
): { lo: number; hi: number; toRadar: (value: number) => number } {
  const lows = rows.map(({ measurement }) => measurement.mean - measurement.ci);
  const highs = rows.map(({ measurement }) => measurement.mean + measurement.ci);
  const rawLo = Math.min(...lows);
  const rawHi = Math.max(...highs);
  const span = Math.max(1, rawHi - rawLo);
  const pad = span * 0.18;
  const lo = rawLo - pad;
  const hi = rawHi + pad;
  return {
    lo,
    hi,
    toRadar: (value: number) => {
      if (hi <= lo) return 50;
      return Math.max(0, Math.min(100, ((value - lo) / (hi - lo)) * 100));
    },
  };
}

function errorBarCaps(
  axis: RadarAxis,
  inner: { x: number; y: number },
  outer: { x: number; y: number },
  cap = 3.6,
): { lo: string; hi: string } {
  const px = -axis.uy * cap;
  const py = axis.ux * cap;
  return {
    lo: `${(inner.x - px).toFixed(2)},${(inner.y - py).toFixed(2)} ${(inner.x + px).toFixed(2)},${(inner.y + py).toFixed(2)}`,
    hi: `${(outer.x - px).toFixed(2)},${(outer.y - py).toFixed(2)} ${(outer.x + px).toFixed(2)},${(outer.y + py).toFixed(2)}`,
  };
}

function radarRingPath(outer: number[], inner: number[], axes: RadarAxis[]): string {
  const toPath = (values: number[], reverse: boolean) => {
    const points = values.map((value, index) => scaledPoint(axes[index]!, value));
    const ordered = reverse ? [...points].reverse() : points;
    const start = ordered[0];
    if (!start) return "";
    return `${ordered
      .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(" ")} Z`;
  };
  return `${toPath(outer, false)} ${toPath(inner, true)}`;
}

export function EvalBarChart({
  measured,
  title = "Measured scores",
}: {
  measured: Partial<Record<EvalMetric, EvalMeasurement>>;
  title?: string;
}) {
  const rows = measuredRows(measured);
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5" data-eval-chart="bars">
      <p className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">{title}</p>
      {rows.map(({ metric, measurement }) => {
        const width = clampScore(measurement.mean);
        const lo = clampScore(measurement.mean - measurement.ci);
        const hi = clampScore(measurement.mean + measurement.ci);
        return (
          <div key={metric} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2 font-mono text-[0.625rem]">
              <span className="truncate text-muted">{titleCase(metric)}</span>
              <span className="shrink-0 tabular-nums text-bone">
                {measurement.mean.toFixed(1)} ±{measurement.ci.toFixed(1)}
              </span>
            </div>
            <div className="relative mt-0.5 h-1.5 overflow-hidden rounded-full bg-void/50">
              <div
                className="absolute inset-y-0 rounded-full bg-train/35"
                style={{ left: `${lo}%`, width: `${Math.max(1, hi - lo)}%` }}
              />
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-train"
                style={{ width: `${width}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function EvalRadar({
  measured,
  title = "Measured scores",
}: {
  measured: Partial<Record<EvalMetric, EvalMeasurement>>;
  title?: string;
}) {
  const rows = measuredRows(measured);
  if (rows.length < 3) return <EvalBarChart measured={measured} title={title} />;
  const geometry = radarGeometry(rows.length);
  const scale = relativeEvalScale(rows);
  const means = rows.map(({ measurement }) => scale.toRadar(measurement.mean));
  const lows = rows.map(({ measurement }) => scale.toRadar(measurement.mean - measurement.ci));
  const highs = rows.map(({ measurement }) => scale.toRadar(measurement.mean + measurement.ci));
  return (
    <figure
      className="models-v4-eval-radar"
      data-eval-chart="radar"
      data-eval-scale="relative"
    >
      <p className="flex min-w-0 items-baseline justify-between gap-2 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
        <span className="truncate">{title}</span>
        <span className="shrink-0 normal-case tabular-nums tracking-normal">
          Relative {scale.lo.toFixed(1)}-{scale.hi.toFixed(1)}
        </span>
      </p>
      <div className="models-v4-eval-radar__plot">
        <svg
          viewBox={geometry.viewBox}
          role="img"
          aria-label={`${title} by domain, relative ${scale.lo.toFixed(1)} to ${scale.hi.toFixed(1)}`}
          className="models-v4-eval-radar__svg text-bone"
        >
          {[25, 50, 75, 100].map((level) => (
            <polygon
              key={level}
              points={polygonPoints(
                rows.map(() => level),
                geometry.axes,
              )}
              fill="none"
              stroke="currentColor"
              strokeWidth="0.7"
              className="text-line"
            />
          ))}
          {geometry.axes.map((axis, index) => (
            <line
              key={rows[index]!.metric}
              x1={geometry.center.x}
              y1={geometry.center.y}
              x2={axis.x}
              y2={axis.y}
              stroke="currentColor"
              strokeWidth="0.7"
              className="text-line"
            />
          ))}
          <path
            d={radarRingPath(highs, lows, geometry.axes)}
            fill="color-mix(in srgb, var(--color-train) 18%, transparent)"
            fillRule="evenodd"
            data-eval-ci="true"
          />
          <polygon
            points={polygonPoints(means, geometry.axes)}
            fill="color-mix(in srgb, var(--color-train) 28%, transparent)"
            stroke="var(--color-train)"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          {geometry.axes.map((axis, index) => {
            const { metric, measurement } = rows[index]!;
            const point = scaledPoint(axis, means[index]!);
            const inner = scaledPoint(axis, lows[index]!);
            const outer = scaledPoint(axis, highs[index]!);
            const caps = errorBarCaps(axis, inner, outer);
            const midX = (inner.x + outer.x) / 2 - axis.uy * 9;
            const midY = (inner.y + outer.y) / 2 + axis.ux * 9;
            const ciLabel = `±${measurement.ci.toFixed(1)}`;
            return (
              <g key={metric}>
                <g data-eval-ci-bar={metric}>
                  <line
                    x1={inner.x}
                    y1={inner.y}
                    x2={outer.x}
                    y2={outer.y}
                    stroke="var(--color-train)"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  />
                  <polyline
                    points={caps.lo}
                    fill="none"
                    stroke="var(--color-train)"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                  <polyline
                    points={caps.hi}
                    fill="none"
                    stroke="var(--color-train)"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                  <text
                    x={midX}
                    y={midY}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="fill-muted font-mono"
                    style={{ fontSize: 8 }}
                  >
                    {ciLabel}
                  </text>
                </g>
                <circle
                  cx={point.x}
                  cy={point.y}
                  r="3"
                  fill="var(--color-train)"
                  stroke="var(--color-void)"
                  strokeWidth="1.25"
                  data-eval-r={means[index]!.toFixed(1)}
                />
                <text
                  x={axis.labelX}
                  y={axis.labelY}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="fill-muted font-mono"
                  style={{ fontSize: 9 }}
                >
                  {shortMetric(metric)}
                </text>
                <title>{`${titleCase(metric)} ${measurement.mean.toFixed(1)} ${ciLabel}`}</title>
              </g>
            );
          })}
        </svg>
        <ul className="models-v4-eval-radar__legend">
          {rows.map(({ metric, measurement }) => (
            <li key={metric} className="flex min-w-0 items-baseline justify-between gap-2">
              <span className="truncate text-muted">{titleCase(metric)}</span>
              <span className="shrink-0 tabular-nums text-bone">
                {measurement.mean.toFixed(1)} ±{measurement.ci.toFixed(1)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}

export function LossSpark({
  samples,
  compact = false,
}: {
  samples: readonly LossSample[];
  compact?: boolean;
}) {
  if (samples.length < 2) {
    if (compact) return null;
    return (
      <p className="font-mono text-[0.6875rem] text-muted" data-loss-spark="empty">
        Loss plots after the first compute tick.
      </p>
    );
  }
  const ys = samples.map((sample) => sample.loss);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = Math.max(1e-6, max - min);
  const width = 240;
  const height = compact ? 28 : 56;
  const pad = 4;
  const d = samples
    .map((sample, index) => {
      const x = pad + (index / (samples.length - 1)) * (width - pad * 2);
      const y = pad + (1 - (sample.loss - min) / span) * (height - pad * 2);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const last = ys[ys.length - 1]!;
  const first = ys[0]!;
  return (
    <figure data-loss-spark={compact ? "compact" : "true"} className="min-w-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Training loss ${last.toFixed(3)}`}
        className={`${compact ? "h-7" : "h-14"} w-full text-train`}
      >
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      {compact ? null : (
        <figcaption className="flex min-w-0 justify-between gap-2 font-mono text-[0.625rem] tabular-nums text-muted">
          <span className="truncate">Loss {last.toFixed(3)} from {first.toFixed(3)}</span>
          <span className="shrink-0">{min.toFixed(2)}-{max.toFixed(2)}</span>
        </figcaption>
      )}
    </figure>
  );
}

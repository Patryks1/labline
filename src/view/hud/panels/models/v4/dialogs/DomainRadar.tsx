import { DATA_DOMAINS, DATA_DOMAIN_META } from "../../../../../../sim/balance/data";
import type { DataDomain } from "../../../../../../sim/types";
import { polygonPoints, radarGeometry } from "../../../../ui/radarGeometry";
import {
  specialistPullDomains,
  type DomainAvailability,
} from "./designState";

export function DomainRadar({
  requested,
  available,
  trained,
  selectedDomain,
  onSelectDomain,
}: {
  requested: Partial<Record<DataDomain, number>>;
  available: DomainAvailability;
  trained?: Partial<Record<DataDomain, number>>;
  selectedDomain?: DataDomain;
  onSelectDomain?: (domain: DataDomain) => void;
}) {
  const geometry = radarGeometry(DATA_DOMAINS.length);
  const maxMTok = Math.max(
    1,
    ...DATA_DOMAINS.map((domain) =>
      Math.max(
        requested[domain] ?? 0,
        available[domain]?.uniqueMTok ?? 0,
        trained?.[domain] ?? 0,
      ),
    ),
  );
  const scale = (mtok: number) => (mtok / maxMTok) * 100;
  const requestedPoints = polygonPoints(
    DATA_DOMAINS.map((domain) => scale(requested[domain] ?? 0)),
    geometry.axes,
  );
  const availablePoints = polygonPoints(
    DATA_DOMAINS.map((domain) => scale(available[domain]?.uniqueMTok ?? 0)),
    geometry.axes,
  );
  const trainedPoints = trained
    ? polygonPoints(
        DATA_DOMAINS.map((domain) => scale(trained[domain] ?? 0)),
        geometry.axes,
      )
    : null;
  const pullDomains = specialistPullDomains(requested);
  const pullSet = new Set(pullDomains);
  const specialistPoints =
    pullDomains.length > 0
      ? polygonPoints(
          DATA_DOMAINS.map((domain) =>
            pullSet.has(domain) ? scale(requested[domain] ?? 0) : 0,
          ),
          geometry.axes,
        )
      : null;
  const selectable = Boolean(onSelectDomain);
  const label = trained
    ? "Already trained versus extra tokens by domain"
    : "Requested versus available unique tokens by domain";
  const ariaLabel =
    pullDomains.length > 0
      ? `${label}. Red marks domains whose mix share specializes the model.`
      : label;

  return (
    <figure data-domain-radar="true" className="min-w-0">
      <svg
        viewBox={geometry.viewBox}
        role="img"
        aria-label={ariaLabel}
        className="mx-auto h-auto w-full max-w-sm text-bone"
      >
        <polygon
          points={availablePoints}
          fill="currentColor"
          className="text-line/80"
          opacity="0.35"
        />
        {trainedPoints ? (
          <polygon
            points={trainedPoints}
            fill="currentColor"
            className="text-muted"
            opacity="0.45"
            stroke="currentColor"
            strokeWidth="1"
            data-radar-trained="true"
          />
        ) : null}
        <polygon
          points={requestedPoints}
          fill="currentColor"
          className="text-train"
          opacity="0.22"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        {specialistPoints ? (
          <polygon
            points={specialistPoints}
            fill="var(--color-danger)"
            opacity="0.62"
            stroke="var(--color-danger)"
            strokeWidth="2.25"
            data-radar-specialist="true"
          />
        ) : null}
        {geometry.axes.map((axis, index) => {
          const domain = DATA_DOMAINS[index]!;
          const selected = selectedDomain === domain;
          const pull = pullSet.has(domain);
          const labelClass = selected
            ? "fill-mint font-mono text-[9px] uppercase"
            : pull
              ? "fill-danger font-mono text-[9px] uppercase"
              : "fill-muted font-mono text-[9px] uppercase";
          if (!selectable) {
            return (
              <text
                key={domain}
                x={axis.labelX}
                y={axis.labelY}
                textAnchor="middle"
                dominantBaseline="middle"
                className={labelClass}
                data-radar-specialist-domain={pull ? domain : undefined}
              >
                {DATA_DOMAIN_META[domain].label}
              </text>
            );
          }
          return (
            <g
              key={domain}
              role="button"
              tabIndex={0}
              data-radar-domain={domain}
              data-continue-intent={domain}
              data-radar-specialist-domain={pull ? domain : undefined}
              className="cursor-pointer"
              aria-label={`Focus ${DATA_DOMAIN_META[domain].label}`}
              aria-pressed={selected}
              onClick={() => onSelectDomain?.(domain)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onSelectDomain?.(domain);
              }}
            >
              <circle cx={axis.x} cy={axis.y} r="16" fill="transparent" />
              <text
                x={axis.labelX}
                y={axis.labelY}
                textAnchor="middle"
                dominantBaseline="middle"
                className={labelClass}
              >
                {DATA_DOMAIN_META[domain].label}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

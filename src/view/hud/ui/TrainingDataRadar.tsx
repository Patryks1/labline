import { useMemo, useRef, useState } from "react";
import type { DataDomain, LabData, Model } from "../../../sim/types";
import {
  DATA_DOMAINS,
  DATA_DOMAIN_META,
  formatTokens,
  normalizeWeights,
} from "../../../sim/balance/data";
import {
  rebalanceTrainingDataDomain,
  trainingDataDomainCapMTok,
} from "./trainingDataRadarMath";

const SIZE = 380;
const CENTER = SIZE / 2;
const RADIUS = 128;

function point(index: number, value: number) {
  const angle = -Math.PI / 2 + (index / DATA_DOMAINS.length) * Math.PI * 2;
  return {
    x: CENTER + Math.cos(angle) * RADIUS * value,
    y: CENTER + Math.sin(angle) * RADIUS * value,
  };
}

function polygon(values: number[]) {
  return values
    .map((value, index) => {
      const p = point(index, value);
      return `${p.x},${p.y}`;
    })
    .join(" ");
}

export function TrainingDataRadar({
  weights,
  totalMTok,
  data,
  autoBalanceDisabled,
  syntheticUnlocked = false,
  syntheticMultiplier = 0,
  teachers,
  syntheticTeacherIds,
  includeSynthHQ,
  includeSynthLQ,
  previousWeights,
  showPreviousOverlay = false,
  onTogglePreviousOverlay,
  onChange,
  onAutoBalance,
  onTeacherChange,
  onIncludeSynthHQChange,
  onIncludeSynthLQChange,
}: {
  weights: Record<DataDomain, number>;
  totalMTok: number;
  data: LabData;
  autoBalanceDisabled?: boolean;
  syntheticUnlocked?: boolean;
  syntheticMultiplier?: number;
  teachers: Model[];
  syntheticTeacherIds: Partial<Record<DataDomain, string>>;
  includeSynthHQ: boolean;
  includeSynthLQ: boolean;
  previousWeights?: Record<DataDomain, number> | null;
  showPreviousOverlay?: boolean;
  onTogglePreviousOverlay?: () => void;
  onChange: (weights: Record<DataDomain, number>, totalMTok: number) => void;
  onAutoBalance: () => void;
  onTeacherChange: (domain: DataDomain, teacherId: string | undefined) => void;
  onIncludeSynthHQChange: (value: boolean) => void;
  onIncludeSynthLQChange: (value: boolean) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingRef = useRef<DataDomain | null>(null);
  const [selected, setSelected] = useState<DataDomain>("code");
  const [dragging, setDragging] = useState<DataDomain | null>(null);
  const normalized = useMemo(() => normalizeWeights(weights), [weights]);
  const allocations = useMemo(
    () => Object.fromEntries(
      DATA_DOMAINS.map((domain) => [domain, totalMTok * normalized[domain]]),
    ) as Record<DataDomain, number>,
    [normalized, totalMTok],
  );
  const axisMaxMTok = Math.max(
    1,
    totalMTok / 3,
    ...DATA_DOMAINS.map((domain) => allocations[domain] * 1.25),
  );
  const target = DATA_DOMAINS.map((domain) => allocations[domain] / axisMaxMTok);
  const layers = useMemo(() => {
    const real: number[] = [];
    const hq: number[] = [];
    const lq: number[] = [];
    for (const domain of DATA_DOMAINS) {
      const stock = data.stocks[domain];
      const need = Math.max(0.01, allocations[domain]);
      const targetRadius = allocations[domain] / axisMaxMTok;
      const realAvailable = Math.max(
        0,
        stock.processed - stock.fromSynthHQ - stock.fromSynthLQ,
      );
      const realTake = Math.min(need, realAvailable);
      const hqTake = includeSynthHQ
        ? Math.min(Math.max(0, need - realTake), stock.fromSynthHQ)
        : 0;
      const lqTake = includeSynthLQ
        ? Math.min(Math.max(0, need - realTake - hqTake), stock.fromSynthLQ)
        : 0;
      real.push((targetRadius * realTake) / need);
      hq.push((targetRadius * (realTake + hqTake)) / need);
      lq.push((targetRadius * (realTake + hqTake + lqTake)) / need);
    }
    return { real, hq, lq };
  }, [allocations, axisMaxMTok, data, includeSynthHQ, includeSynthLQ]);

  const updateFromPointer = (
    domain: DataDomain,
    clientX: number,
    clientY: number,
  ) => {
    if (!svgRef.current) return;
    const bounds = svgRef.current.getBoundingClientRect();
    const x = (clientX - bounds.left) * (SIZE / bounds.width) - CENTER;
    const y = (clientY - bounds.top) * (SIZE / bounds.height) - CENTER;
    const index = DATA_DOMAINS.indexOf(domain);
    const angle = -Math.PI / 2 + (index / DATA_DOMAINS.length) * Math.PI * 2;
    const projected = (x * Math.cos(angle) + y * Math.sin(angle)) / RADIUS;
    const stock = data.stocks[domain];
    const realAvailable = Math.max(0, stock.processed - stock.fromSynthHQ - stock.fromSynthLQ);
    const includedSynthetic =
      (includeSynthHQ ? stock.fromSynthHQ : 0) +
      (includeSynthLQ ? stock.fromSynthLQ : 0);
    const capMTok = trainingDataDomainCapMTok(
      realAvailable,
      includedSynthetic,
      syntheticUnlocked ? syntheticMultiplier : 0,
    );
    const next = rebalanceTrainingDataDomain(
      allocations,
      domain,
      Math.max(0, projected * axisMaxMTok),
      capMTok,
    );
    const nextTotal = DATA_DOMAINS.reduce((sum, candidate) => sum + next[candidate], 0);
    if (nextTotal > 0) onChange(normalizeWeights(next), nextTotal);
  };

  const selectedStock = data.stocks[selected];
  const selectedNeed = allocations[selected];
  const selectedReal = Math.max(
    0,
    selectedStock.processed -
      selectedStock.fromSynthHQ -
      selectedStock.fromSynthLQ,
  );
  const selectedShortfall = Math.max(
    0,
    selectedNeed -
      selectedReal -
      (includeSynthHQ ? selectedStock.fromSynthHQ : 0) -
      (includeSynthLQ ? selectedStock.fromSynthLQ : 0),
  );
  const selectedHq = includeSynthHQ
    ? Math.min(Math.max(0, selectedNeed - selectedReal), selectedStock.fromSynthHQ)
    : 0;
  const selectedLq = includeSynthLQ
    ? Math.min(Math.max(0, selectedNeed - selectedReal - selectedHq), selectedStock.fromSynthLQ)
    : 0;
  const sourceTotals = DATA_DOMAINS.reduce(
    (totals, domain) => {
      const stock = data.stocks[domain];
      const need = allocations[domain];
      const realAvailable = Math.max(0, stock.processed - stock.fromSynthHQ - stock.fromSynthLQ);
      const real = Math.min(need, realAvailable);
      const hq = includeSynthHQ ? Math.min(Math.max(0, need - real), stock.fromSynthHQ) : 0;
      const lq = includeSynthLQ ? Math.min(Math.max(0, need - real - hq), stock.fromSynthLQ) : 0;
      totals.real += real;
      totals.hq += hq;
      totals.lq += lq;
      totals.shortfall += Math.max(0, need - real - hq - lq);
      return totals;
    },
    { real: 0, hq: 0, lq: 0, shortfall: 0 },
  );
  const selectedTeacher = teachers.find(
    (teacher) => teacher.id === syntheticTeacherIds[selected],
  );
  const estimatedQuality = selectedTeacher
    ? Math.min(92, 48 + selectedTeacher.capability * 0.55)
    : null;
  void onIncludeSynthHQChange;
  void onIncludeSynthLQChange;

  return (
    <section
      className="mt-2 overflow-hidden rounded-xl border border-line/80 bg-void/35"
      aria-labelledby="training-data-mix-title"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 px-3 py-2">
        <div>
          <h3
            id="training-data-mix-title"
            className="text-xs font-medium text-bone"
          >
            Training data mix
          </h3>
          <p className="text-[0.6875rem] text-muted">
            {syntheticUnlocked
              ? "Drag a point to change the recipe. Source rings show where real data ends and synthetic data begins."
              : "Drag a point to change the recipe. Available real data determines coverage."}
          </p>
          <p className="mt-0.5 font-mono text-[0.625rem] text-muted">
            {formatTokens(totalMTok)} total · {formatTokens(sourceTotals.real)} real · {formatTokens(sourceTotals.hq + sourceTotals.lq)} synthetic · {formatTokens(sourceTotals.shortfall)} short
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {previousWeights && onTogglePreviousOverlay ? (
            <button
              type="button"
              onClick={onTogglePreviousOverlay}
              aria-pressed={showPreviousOverlay}
              className={`rounded-full border px-3 py-1 text-[0.6875rem] ${
                showPreviousOverlay
                  ? "border-amber/50 bg-amber/15 text-amber"
                  : "border-line text-muted hover:text-bone"
              }`}
            >
              Previous corpus
            </button>
          ) : null}
          <button
            type="button"
            onClick={onAutoBalance}
            disabled={autoBalanceDisabled}
            className="rounded-full border border-mint/40 bg-mint/10 px-3 py-1 text-[0.6875rem] text-mint disabled:opacity-40"
            title={
              autoBalanceDisabled
                ? "Research Mixture Engineering to automate this recipe."
                : "Sets the recommended domain mix, then shifts volume away from shortages while preserving modality minimums."
            }
          >
            Auto-balance · best recipe
          </button>
        </div>
      </header>
      <div className="grid min-w-0 gap-3 p-3 lg:grid-cols-[minmax(280px,1.25fr)_minmax(160px,.7fr)]">
        <div className="min-w-0">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="mx-auto block h-auto w-full max-w-[420px] touch-none overflow-visible"
            role="group"
            aria-label="Draggable radar chart for training data domains"
            onPointerMove={(event) => {
              const domain = draggingRef.current;
              if (domain)
                updateFromPointer(domain, event.clientX, event.clientY);
            }}
            onPointerUp={() => {
              draggingRef.current = null;
              setDragging(null);
            }}
            onPointerCancel={() => {
              draggingRef.current = null;
              setDragging(null);
            }}
          >
            {[0.25, 0.5, 0.75, 1].map((ring) => (
              <polygon
                key={ring}
                points={polygon(DATA_DOMAINS.map(() => ring))}
                fill="none"
                stroke="rgba(139,171,181,.18)"
                strokeWidth="1"
              />
            ))}
            {DATA_DOMAINS.map((domain, index) => {
              const end = point(index, 1);
              const label = point(index, 1.25);
              return (
                <g key={domain}>
                  <line
                    x1={CENTER}
                    y1={CENTER}
                    x2={end.x}
                    y2={end.y}
                    stroke="rgba(139,171,181,.16)"
                  />
                  <text
                    x={label.x}
                    y={label.y}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill={selected === domain ? "#56e1dc" : "#9bb1ba"}
                    fontSize="11"
                  >
                    <title>{`${DATA_DOMAIN_META[domain].label}: ${Math.round(normalized[domain] * 100)}% of ${formatTokens(totalMTok)}`}</title>
                    {DATA_DOMAIN_META[domain].label}{" "}
                    {formatTokens(allocations[domain])}
                  </text>
                </g>
              );
            })}
            {previousWeights && showPreviousOverlay ? (
              <polygon
                points={polygon(
                  DATA_DOMAINS.map((domain) => {
                    const prev = normalizeWeights(previousWeights);
                    const maxPrev = Math.max(
                      0.2,
                      ...DATA_DOMAINS.map((d) => prev[d]),
                    );
                    return prev[domain] / maxPrev;
                  }),
                )}
                fill="rgba(243,183,91,.08)"
                stroke="#f3b75b"
                strokeWidth="1.5"
                opacity="0.85"
              />
            ) : null}
            <polygon
              points={polygon(target)}
              fill="rgba(93,225,217,.035)"
              stroke="#f3b75b"
              strokeDasharray="4 4"
              strokeWidth="1.5"
            />
            {syntheticUnlocked ? (
              <polygon
                points={polygon(layers.lq)}
                fill="rgba(174,126,232,.16)"
                stroke="#ae7ee8"
                strokeWidth="1"
              />
            ) : null}
            {syntheticUnlocked ? (
              <polygon
                points={polygon(layers.hq)}
                fill="rgba(60,173,223,.2)"
                stroke="#3cade0"
                strokeWidth="1"
              />
            ) : null}
            <polygon
              points={polygon(layers.real)}
              fill="rgba(86,225,220,.25)"
              stroke="#56e1dc"
              strokeWidth="1.5"
            />
            {DATA_DOMAINS.map((domain, index) => {
              const handle = point(index, target[index] ?? 0);
              const active = selected === domain;
              const isDragging = dragging === domain;
              return (
                <g key={domain}>
                  {active ? (
                    <circle
                      cx={handle.x}
                      cy={handle.y}
                      r={isDragging ? 11 : 9}
                      fill="rgba(86,225,220,.12)"
                      stroke="#56e1dc"
                      strokeWidth="1"
                      pointerEvents="none"
                    />
                  ) : null}
                  <circle
                    cx={handle.x}
                    cy={handle.y}
                    r={14}
                    fill="transparent"
                    className="cursor-grab outline-none active:cursor-grabbing"
                    tabIndex={0}
                    role="slider"
                    aria-label={`${DATA_DOMAIN_META[domain].label} token volume`}
                    aria-valuemin={0}
                    aria-valuemax={Math.round(axisMaxMTok)}
                    aria-valuenow={Math.round(allocations[domain])}
                    onFocus={() => setSelected(domain)}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      draggingRef.current = domain;
                      setSelected(domain);
                      setDragging(domain);
                      updateFromPointer(domain, event.clientX, event.clientY);
                    }}
                    onKeyDown={(event) => {
                      if (
                        ![
                          "ArrowUp",
                          "ArrowRight",
                          "ArrowDown",
                          "ArrowLeft",
                        ].includes(event.key)
                      )
                        return;
                      event.preventDefault();
                      const delta =
                        event.key === "ArrowUp" || event.key === "ArrowRight"
                          ? Math.max(1, axisMaxMTok * 0.01)
                          : -Math.max(1, axisMaxMTok * 0.01);
                      const next = rebalanceTrainingDataDomain(
                        allocations,
                        domain,
                        allocations[domain] + delta,
                        (() => {
                          const stock = data.stocks[domain];
                          const real = Math.max(0, stock.processed - stock.fromSynthHQ - stock.fromSynthLQ);
                          return trainingDataDomainCapMTok(
                            real,
                            stock.fromSynthHQ + stock.fromSynthLQ,
                            syntheticUnlocked ? syntheticMultiplier : 0,
                          );
                        })(),
                      );
                      const nextTotal = DATA_DOMAINS.reduce((sum, candidate) => sum + next[candidate], 0);
                      if (nextTotal > 0) onChange(normalizeWeights(next), nextTotal);
                    }}
                  />
                  <circle
                    cx={handle.x}
                    cy={handle.y}
                    r={active ? 6.5 : 5}
                    fill={active ? "#f2f6f5" : "#56e1dc"}
                    stroke="#07171d"
                    strokeWidth="2"
                    pointerEvents="none"
                  />
                </g>
              );
            })}
          </svg>
          <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-[0.625rem] text-muted">
            <span>
              <i className="mr-1 inline-block h-2 w-2 rounded-sm bg-mint" />
              Real
            </span>
            {syntheticUnlocked ? (
              <span>
                <i className="mr-1 inline-block h-2 w-2 rounded-sm bg-sky" />
                HQ synthetic
              </span>
            ) : null}
            {syntheticUnlocked ? (
              <span>
                <i className="mr-1 inline-block h-2 w-2 rounded-sm bg-research" />
                LQ synthetic
              </span>
            ) : null}
            <span>
              <i className="mr-1 inline-block h-2 w-2 rounded-sm border border-dashed border-amber" />
              Shortfall
            </span>
          </div>
        </div>
        <aside className="min-w-0 rounded-lg border border-line/70 bg-panel-2/65 p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="font-mono text-[0.625rem] uppercase tracking-widest text-muted">
                Selected domain
              </span>
              <h4 className="text-base font-medium text-bone">
                {DATA_DOMAIN_META[selected].label}{" "}
                <span className="font-mono text-sm text-mint">
                  {formatTokens(selectedNeed)}
                </span>
              </h4>
            </div>
            <span
              className={
                selectedShortfall > 0.05
                  ? "font-mono text-xs text-amber"
                  : "font-mono text-xs text-mint"
              }
            >
              {selectedShortfall > 0.05
                ? `${formatTokens(selectedShortfall)} short`
                : "covered"}
            </span>
          </div>
          <div className="mt-3 space-y-1.5 text-[0.6875rem]">
            <SourceRow label="Needed" value={formatTokens(selectedNeed)} />
            <SourceRow
              label="Real data"
              value={formatTokens(Math.min(selectedNeed, selectedReal))}
              tone="text-mint"
            />
            <SourceRow label="HQ synthetic" value={formatTokens(selectedHq)} tone="text-sky" />
            <SourceRow label="LQ synthetic" value={formatTokens(selectedLq)} tone="text-research" />
            <SourceRow label="Shortfall" value={formatTokens(selectedShortfall)} tone={selectedShortfall > 0.05 ? "text-amber" : "text-muted"} />
            <SourceRow label="Mix share" value={`${Math.round(normalized[selected] * 100)}%`} />
          </div>
          {syntheticUnlocked ? (
            <label className="mt-3 block text-[0.6875rem] text-muted">
              Synthetic teacher
              <select
                value={syntheticTeacherIds[selected] ?? ""}
                onChange={(event) =>
                  onTeacherChange(selected, event.target.value || undefined)
                }
                className="mt-1 w-full min-w-0 rounded-md border border-line bg-void px-2 py-1.5 text-xs text-bone outline-none focus:border-mint/50"
              >
                <option value="">Auto · best teacher</option>
                {teachers.map((teacher) => (
                  <option key={teacher.id} value={teacher.id}>
                    {teacher.name} · cap {teacher.capability.toFixed(0)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {syntheticUnlocked ? (
            <p className="mt-1 min-h-8 text-[0.625rem] leading-snug text-muted">
              {selectedTeacher
                ? `Predicted ${estimatedQuality && estimatedQuality >= 58 ? "high" : "low"} quality · Q${estimatedQuality?.toFixed(0)} from ${selectedTeacher.name}.`
                : "Auto chooses the strongest eligible teacher for this domain."}
            </p>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function SourceRow({
  label,
  value,
  tone = "text-bone",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className={`font-mono ${tone}`}>{value}</span>
    </div>
  );
}

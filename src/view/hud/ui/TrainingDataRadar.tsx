import { useEffect, useMemo, useRef, useState } from "react";
import type { DataDomain, LabData, Model } from "../../../sim/types";
import {
  DATA_DOMAINS,
  DATA_DOMAIN_META,
  formatTokens,
} from "../../../sim/balance/data";
import {
  domainAvailabilityTooltip,
  domainStockAvailability,
  trainingDataDomainFill,
  type TrainingDataDomainAvailability,
} from "./trainingDataRadarMath";
import {
  MAX_POST_TRAIN_SHARE,
  MIN_POST_TRAIN_SHARE,
} from "../../../sim/balance/modelProduct";
import { HudButton, HudInput, HudRange, HudSelect } from "./HudPrimitives";
import {
  RECIPE_VERIFY_META,
  RECIPE_ZONE_META,
  allocationsFromMix,
  clampEnvelopeSplit,
  clampRecipeToUsable,
  clampRecipeZoom,
  focusZoomForVolume,
  formatRecipeTokDraft,
  invertTokenRadius,
  parseRecipeTokInput,
  recipeScaleCeiling,
  recipeZoneCapMTok,
  scaleEnvelope,
  splitOwnedAndSynth,
  stackRadiiFromTokens,
  splitEnvelope,
  splitStackedDrag,
  stackedSpoke,
  tokenRadius,
  verifyTokens,
  type RecipeZone,
} from "../panels/models/recipePlan";

const SIZE = 440;
const CENTER = SIZE / 2;
const RADIUS = 168;

function compactTok(mTok: number): string {
  if (!Number.isFinite(mTok) || mTok <= 0) return "0";
  if (mTok >= 1000) return `${(mTok / 1000).toFixed(mTok >= 10_000 ? 0 : 1)}B`;
  if (mTok >= 10) return `${Math.round(mTok)}M`;
  if (mTok >= 1) return `${mTok.toFixed(1)}M`;
  return `${Math.round(mTok * 1000)}K`;
}

function spokeAngle(index: number) {
  return -Math.PI / 2 + (index / DATA_DOMAINS.length) * Math.PI * 2;
}

function point(index: number, value: number) {
  const angle = spokeAngle(index);
  return {
    x: CENTER + Math.cos(angle) * RADIUS * value,
    y: CENTER + Math.sin(angle) * RADIUS * value,
  };
}

function labelAnchor(index: number) {
  const angle = spokeAngle(index);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  let tx = "-50%";
  let ty = "-50%";
  if (ux > 0.42) tx = "-6%";
  else if (ux < -0.42) tx = "-94%";
  if (uy > 0.5) ty = "-12%";
  else if (uy < -0.5) ty = "-88%";
  return {
    left: `${50 + ux * 47}%`,
    top: `${50 + uy * 47}%`,
    transform: `translate(${tx}, ${ty})`,
  };
}

type VolumeKey = "all" | "base" | "post" | "synth";

function VolumeRow({
  label,
  color,
  valueLabel,
  editable,
  editing,
  draft,
  ariaEdit,
  ariaInput,
  onStart,
  onDraft,
  onCommit,
  onCancel,
  onNudge,
}: {
  label: string;
  color: string;
  valueLabel: string;
  editable: boolean;
  editing: boolean;
  draft: string;
  ariaEdit: string;
  ariaInput: string;
  onStart: () => void;
  onDraft: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onNudge?: (direction: -1 | 1) => void;
}) {
  const swatch = (
    <i
      className="training-data-radar-pop__swatch"
      style={{ background: color }}
    />
  );
  if (editing) {
    return (
      <label className="training-data-radar-pop__row">
        <span className="training-data-radar-pop__edit">
          {swatch}
          <span>{label}</span>
          <HudInput
            autoFocus
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            onBlur={onCommit}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                onCommit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
              }
            }}
            aria-label={ariaInput}
          />
        </span>
      </label>
    );
  }
  if (!editable) {
    return (
      <div className="training-data-radar-pop__row" data-readonly="true">
        <span className="training-data-radar-pop__edit">
          {swatch}
          <span>{label}</span>
          <span className="font-mono text-[0.75rem] tabular-nums">{valueLabel}</span>
        </span>
      </div>
    );
  }
  return (
    <div className="training-data-radar-pop__row training-data-radar-pop__row--edit">
      <button
        type="button"
        className="training-data-radar-pop__edit"
        aria-label={ariaEdit}
        onClick={onStart}
      >
        {swatch}
        <span>{label}</span>
        <span className="font-mono text-[0.75rem] tabular-nums">{valueLabel}</span>
      </button>
      {onNudge ? (
        <span className="training-data-radar-pop__nudge">
          <button
            type="button"
            aria-label={`${ariaEdit} down`}
            onClick={() => onNudge(-1)}
          >
            −
          </button>
          <button
            type="button"
            aria-label={`${ariaEdit} up`}
            onClick={() => onNudge(1)}
          >
            +
          </button>
        </span>
      ) : null}
    </div>
  );
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
  baseWeights,
  postWeights,
  baseMTok,
  postMTok,
  baseVolumes,
  alignVolumes,
  data,
  syntheticUnlocked = false,
  syntheticMultiplier = 0,
  syntheticExpansionAvailable,
  syntheticHeadroomMTok,
  syntheticSource = "lab",
  reservedMTokByDomain,
  teachers,
  syntheticTeacherIds,
  includeSynthHQ,
  includeSynthLQ,
  onOwnedChange,
  onTeacherChange,
  onOpenPlanLibrary,
  trainShare,
  onTrainShareChange,
}: {
  baseWeights: Record<DataDomain, number>;
  postWeights: Record<DataDomain, number>;
  baseMTok: number;
  postMTok: number;
  baseVolumes?: Record<DataDomain, number>;
  alignVolumes?: Record<DataDomain, number>;
  data: LabData;
  syntheticUnlocked?: boolean;
  syntheticMultiplier?: number;
  syntheticExpansionAvailable?: boolean;
  syntheticHeadroomMTok?: Partial<Record<DataDomain, number>>;
  syntheticSource?: "teacher" | "lab";
  reservedMTokByDomain?: Partial<Record<DataDomain, number>>;
  teachers: Model[];
  syntheticTeacherIds: Partial<Record<DataDomain, string>>;
  includeSynthHQ: boolean;
  includeSynthLQ: boolean;
  onOwnedChange: (recipe: {
    base: Record<DataDomain, number>;
    align: Record<DataDomain, number>;
    realMTok: number;
    synthMTok: number;
  }) => void;
  onTeacherChange: (domain: DataDomain, teacherId: string | undefined) => void;
  onOpenPlanLibrary?: () => void;
  trainShare?: number;
  onTrainShareChange?: (share: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingRef = useRef<{
    domain: DataDomain;
    zone: RecipeZone;
  } | null>(null);
  const dragCeilingRef = useRef<number | null>(null);
  const dragZoomRef = useRef<number | null>(null);
  const [selected, setSelected] = useState<DataDomain>("code");
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState<{
    domain: DataDomain;
    zone: RecipeZone;
  } | null>(null);
  const [editing, setEditing] = useState<VolumeKey | null>(null);
  const [draft, setDraft] = useState("");

  const propsBase = useMemo(
    () => baseVolumes ?? allocationsFromMix(baseWeights, baseMTok),
    [baseVolumes, baseWeights, baseMTok],
  );
  const propsAlign = useMemo(
    () => alignVolumes ?? allocationsFromMix(postWeights, postMTok),
    [alignVolumes, postWeights, postMTok],
  );
  const baseKey = DATA_DOMAINS.map((domain) =>
    (propsBase[domain] ?? 0).toFixed(3),
  ).join("|");
  const alignKey = DATA_DOMAINS.map((domain) =>
    (propsAlign[domain] ?? 0).toFixed(3),
  ).join("|");
  const [baseAlloc, setBaseAlloc] = useState(propsBase);
  const [postAlloc, setPostAlloc] = useState(propsAlign);
  const stockKey = DATA_DOMAINS.map(
    (domain) => `${domain}:${(data.stocks[domain]?.processed ?? 0).toFixed(3)}`,
  ).join("|");

  useEffect(() => {
    setEditing(null);
    setDraft("");
  }, [selected]);

  useEffect(() => {
    if (draggingRef.current) return;
    const usable = Object.fromEntries(
      stockKey.split("|").map((part) => {
        const sep = part.lastIndexOf(":");
        return [part.slice(0, sep), Number(part.slice(sep + 1))];
      }),
    ) as Record<DataDomain, number>;
    const clamped = clampRecipeToUsable(propsBase, propsAlign, usable);
    setBaseAlloc(clamped.base);
    setPostAlloc(clamped.align);
  }, [alignKey, baseKey, propsAlign, propsBase, stockKey]);

  const expansionEnabled =
    syntheticExpansionAvailable ?? syntheticMultiplier > 0;

  const availabilityByDomain = useMemo(() => {
    const map = {} as Record<DataDomain, TrainingDataDomainAvailability>;
    for (const domain of DATA_DOMAINS) {
      map[domain] = domainStockAvailability(data.stocks[domain], {
        reservedMTok: reservedMTokByDomain?.[domain] ?? 0,
        includeSynthHQ,
        includeSynthLQ,
        syntheticHeadroomMTok: syntheticHeadroomMTok?.[domain] ?? 0,
        syntheticMultiplier,
        selectedMTok: baseAlloc[domain] + postAlloc[domain],
      });
    }
    return map;
  }, [
    baseAlloc,
    data.stocks,
    includeSynthHQ,
    includeSynthLQ,
    reservedMTokByDomain,
    syntheticHeadroomMTok,
    syntheticMultiplier,
  ]);

  const fills = useMemo(() => {
    const map = {} as Record<
      DataDomain,
      ReturnType<typeof trainingDataDomainFill>
    >;
    for (const domain of DATA_DOMAINS) {
      const availability = availabilityByDomain[domain];
      map[domain] = trainingDataDomainFill({
        needMTok: baseAlloc[domain] + postAlloc[domain],
        realAvailableMTok: availability.processedRealMTok,
        synthHQStockMTok: availability.processedSynthHQMTok,
        synthLQStockMTok: availability.processedSynthLQMTok,
        includeSynthHQ,
        includeSynthLQ,
        reservedMTok: reservedMTokByDomain?.[domain] ?? 0,
        syntheticMultiplier,
        syntheticHeadroomMTok: syntheticHeadroomMTok?.[domain],
      });
    }
    return map;
  }, [
    availabilityByDomain,
    baseAlloc,
    postAlloc,
    includeSynthHQ,
    includeSynthLQ,
    reservedMTokByDomain,
    syntheticHeadroomMTok,
    syntheticMultiplier,
  ]);

  const spokes = useMemo(
    () =>
      Object.fromEntries(
        DATA_DOMAINS.map((domain) => {
          const fill = fills[domain];
          const synth = syntheticUnlocked ? fill.synthTake : 0;
          return [
            domain,
            stackedSpoke(baseAlloc[domain], postAlloc[domain], synth),
          ];
        }),
      ) as Record<DataDomain, ReturnType<typeof stackedSpoke>>,
    [baseAlloc, fills, postAlloc, syntheticUnlocked],
  );

  const stockCeiling = useMemo(
    () =>
      recipeScaleCeiling(
        Object.fromEntries(
          DATA_DOMAINS.map((domain) => [
            domain,
            availabilityByDomain[domain].usableMTok,
          ]),
        ),
      ),
    [availabilityByDomain],
  );
  const [axisCeiling, setAxisCeiling] = useState(0);
  const ceiling = Math.max(1, axisCeiling || stockCeiling);

  useEffect(() => {
    if (axisCeiling <= 0) {
      setAxisCeiling(stockCeiling);
      return;
    }
    if (stockCeiling > axisCeiling * 2.6) setAxisCeiling(stockCeiling);
  }, [axisCeiling, stockCeiling]);

  const stackedRadii = useMemo(
    () =>
      Object.fromEntries(
        DATA_DOMAINS.map((domain) => {
          const spoke = spokes[domain];
          return [
            domain,
            stackRadiiFromTokens(
              spoke.inner,
              spoke.mid,
              spoke.outer,
              ceiling,
              zoom,
              trainShare ?? 0.82,
            ),
          ];
        }),
      ) as Record<DataDomain, ReturnType<typeof stackRadiiFromTokens>>,
    [ceiling, spokes, trainShare, zoom],
  );

  const dragCapMTok = (domain: DataDomain, target: RecipeZone): number => {
    const ownedCap = recipeZoneCapMTok(target, availabilityByDomain[domain], {
      syntheticUnlocked,
      expansionEnabled,
    });
    if (target === "base") {
      return Math.min(
        ownedCap,
        spokes[domain].mid * (1 - MIN_POST_TRAIN_SHARE),
      );
    }
    return ownedCap;
  };

  const commitOwned = (
    nextBase: Record<DataDomain, number>,
    nextAlign: Record<DataDomain, number>,
    extraByDomain?: Partial<Record<DataDomain, number>>,
  ) => {
    const clampedBase = { ...nextBase };
    const clampedAlign = { ...nextAlign };
    for (const domain of DATA_DOMAINS) {
      const split = clampEnvelopeSplit(
        clampedBase[domain] ?? 0,
        clampedAlign[domain] ?? 0,
      );
      clampedBase[domain] = split.base;
      clampedAlign[domain] = split.align;
      const envelope = split.base + split.align;
      const ownedCap = availabilityByDomain[domain].usableMTok;
      if (envelope > ownedCap) {
        const scaled = scaleEnvelope(split.base, split.align, ownedCap);
        clampedBase[domain] = scaled.base;
        clampedAlign[domain] = scaled.align;
      }
    }
    setBaseAlloc(clampedBase);
    setPostAlloc(clampedAlign);
    const owned = DATA_DOMAINS.reduce(
      (sum, domain) =>
        sum +
        Math.max(0, clampedBase[domain] ?? 0) +
        Math.max(0, clampedAlign[domain] ?? 0),
      0,
    );
    if (owned <= 0) return;
    const realMTok = DATA_DOMAINS.reduce((sum, domain) => {
      const envelope =
        Math.max(0, clampedBase[domain] ?? 0) +
        Math.max(0, clampedAlign[domain] ?? 0);
      return sum + Math.min(envelope, availabilityByDomain[domain].usableMTok);
    }, 0);
    const extras = DATA_DOMAINS.reduce((sum, domain) => {
      if (extraByDomain && domain in extraByDomain) {
        return sum + Math.max(0, extraByDomain[domain] ?? 0);
      }
      return sum + (syntheticUnlocked ? spokes[domain].synth : 0);
    }, 0);
    onOwnedChange({
      base: clampedBase,
      align: clampedAlign,
      realMTok,
      synthMTok: extras,
    });
  };

  const commitDomain = (
    target: RecipeZone,
    domain: DataDomain,
    valueMTok: number,
  ) => {
    const value = Math.max(0, Math.min(dragCapMTok(domain, target), valueMTok));
    if (target === "synth") {
      commitOwned(baseAlloc, postAlloc, { [domain]: value });
      return;
    }
    if (target === "base") {
      const split = splitEnvelope(spokes[domain].mid, value);
      commitOwned(
        { ...baseAlloc, [domain]: split.base },
        { ...postAlloc, [domain]: split.align },
      );
      return;
    }
    const usable = availabilityByDomain[domain].usableMTok;
    const split = splitOwnedAndSynth(value, usable);
    const scaled = scaleEnvelope(
      spokes[domain].base,
      spokes[domain].post,
      split.owned,
    );
    commitOwned(
      { ...baseAlloc, [domain]: scaled.base },
      { ...postAlloc, [domain]: scaled.align },
      expansionEnabled && split.synth > 0
        ? { [domain]: split.synth }
        : undefined,
    );
  };

  const commitTypedVolume = (
    key: VolumeKey,
    domain: DataDomain,
    raw: string,
  ) => {
    const parsed = parseRecipeTokInput(raw);
    setEditing(null);
    setDraft("");
    if (parsed == null) return;
    const cap = dragCapMTok(domain, key === "all" ? "post" : key);
    const value = Math.max(0, Math.min(cap, parsed));
    if (key === "all" || key === "synth") {
      commitDomain(key === "all" ? "post" : "synth", domain, value);
      return;
    }
    if (key === "base") {
      const envelope = spokes[domain].mid;
      if (value <= envelope) {
        commitDomain("base", domain, value);
        return;
      }
      const align = spokes[domain].post;
      const owned = Math.min(cap, value + align);
      const nextBase = Math.min(value, owned);
      commitOwned(
        { ...baseAlloc, [domain]: nextBase },
        { ...postAlloc, [domain]: owned - nextBase },
      );
      return;
    }
    const base = spokes[domain].base;
    const owned = Math.min(cap, base + value);
    const nextBase = Math.min(base, owned);
    commitOwned(
      { ...baseAlloc, [domain]: nextBase },
      { ...postAlloc, [domain]: owned - nextBase },
    );
  };

  const startEdit = (key: VolumeKey, valueMTok: number) => {
    setEditing(key);
    setDraft(formatRecipeTokDraft(valueMTok));
  };

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
    const liveCeiling = dragCeilingRef.current ?? ceiling;
    const liveZoom = dragZoomRef.current ?? zoom;
    const target = draggingRef.current?.zone ?? "base";
    let value: number;
    if (target === "base") {
      const ownedR = tokenRadius(spokes[domain].mid, liveCeiling, liveZoom);
      const frac =
        ownedR > 1e-9 ? Math.max(0, Math.min(1, projected / ownedR)) : 0;
      value = spokes[domain].mid * frac;
    } else {
      value = splitStackedDrag(
        target,
        invertTokenRadius(Math.max(0, projected), liveCeiling, liveZoom),
        spokes[domain],
      );
    }
    commitDomain(target, domain, value);
  };

  const useAllData = () => {
    const nextBase = { ...baseAlloc };
    const nextAlign = { ...postAlloc };
    for (const domain of DATA_DOMAINS) {
      const scaled = scaleEnvelope(
        spokes[domain].base,
        spokes[domain].post,
        availabilityByDomain[domain].usableMTok,
      );
      nextBase[domain] = scaled.base;
      nextAlign[domain] = scaled.align;
    }
    commitOwned(nextBase, nextAlign);
  };

  const verifyShare = 1 - (trainShare ?? 0.82);
  const selectedSpoke = spokes[selected];
  const selectedLabel = DATA_DOMAIN_META[selected].label;
  const selectedVerify = verifyTokens(selectedSpoke.mid, trainShare ?? 0.82);
  const selectedRows: {
    key: VolumeKey | "verify";
    label: string;
    color: string;
    value: number;
    editable: boolean;
  }[] = [
    {
      key: "all",
      label: "All",
      color: "#e8f2f2",
      value: selectedSpoke.mid,
      editable: true,
    },
    {
      key: "base",
      label: RECIPE_ZONE_META.base.label,
      color: RECIPE_ZONE_META.base.stroke,
      value: selectedSpoke.base,
      editable: true,
    },
    {
      key: "post",
      label: RECIPE_ZONE_META.post.label,
      color: RECIPE_ZONE_META.post.stroke,
      value: selectedSpoke.post,
      editable: true,
    },
    {
      key: "verify",
      label: RECIPE_VERIFY_META.label,
      color: RECIPE_VERIFY_META.stroke,
      value: selectedVerify,
      editable: false,
    },
    ...(syntheticUnlocked
      ? [
          {
            key: "synth" as const,
            label: "Synth",
            color: RECIPE_ZONE_META.synth.stroke,
            value: selectedSpoke.synth,
            editable: true,
          },
        ]
      : []),
  ];

  return (
    <section
      className="rounded-xl border border-line/80 bg-void/35"
      aria-label="Training data radar"
    >
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-line/70 px-3 py-2">
        {onTrainShareChange && trainShare != null ? (
          <label className="min-w-[12rem] flex-1 text-[0.6875rem] text-muted">
            <span className="flex justify-between gap-2 font-mono tabular-nums">
              <span>Verify {(verifyShare * 100).toFixed(0)}%</span>
              <span className="text-bone">
                Train {(trainShare * 100).toFixed(0)}%
              </span>
            </span>
            <HudRange
              type="range"
              min={5}
              max={60}
              step={1}
              value={Math.round(verifyShare * 100)}
              onChange={(event) =>
                onTrainShareChange(1 - Number(event.target.value) / 100)
              }
              className="mt-1"
              aria-label="Verification holdout"
              title="Share of the recipe held out to verify the run"
            />
          </label>
        ) : (
          <span />
        )}
        <div className="flex flex-wrap gap-1">
          <HudButton
            type="button"
            variant="ghost"
            className="!min-h-9 !px-2.5 !text-[0.6875rem]"
            aria-label="Zoom out"
            onClick={() =>
              setZoom((current) => clampRecipeZoom(current / 1.35))
            }
          >
            -
          </HudButton>
          <HudButton
            type="button"
            variant="ghost"
            className="!min-h-9 !px-2.5 !text-[0.6875rem]"
            aria-label="Fit recipe"
            onClick={() => {
              setAxisCeiling(stockCeiling);
              setZoom(1);
            }}
          >
            Fit
          </HudButton>
          <HudButton
            type="button"
            variant="ghost"
            className="!min-h-9 !px-2.5 !text-[0.6875rem]"
            aria-label="Zoom in"
            onClick={() =>
              setZoom((current) => clampRecipeZoom(current * 1.35))
            }
          >
            +
          </HudButton>
          <HudButton
            type="button"
            variant="ghost"
            className="!min-h-9 !px-2.5 !text-[0.6875rem]"
            aria-label="Focus selected domain"
            title="Zoom this domain's tokens. Other domains keep their amounts."
            onClick={() =>
              setZoom(focusZoomForVolume(spokes[selected].mid, ceiling))
            }
          >
            Focus
          </HudButton>
          <HudButton
            type="button"
            variant="ghost"
            className="!min-h-9 !px-2.5 !text-[0.6875rem]"
            onClick={useAllData}
            title="Fill every domain to owned usable stock. Does not add synthetic expansion."
          >
            Use all data
          </HudButton>
          {onOpenPlanLibrary ? (
            <HudButton
              type="button"
              variant="ghost"
              className="!min-h-9 !px-2.5 !text-[0.6875rem]"
              onClick={onOpenPlanLibrary}
            >
              Load plan
            </HudButton>
          ) : null}
        </div>
      </div>

      <div className="training-data-radar-layout grid min-w-0 gap-3 p-3">
        <div className="min-w-0">
          <div className="training-data-radar-chart">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="block h-auto w-full touch-none overflow-visible"
            role="group"
            aria-label="Draggable radar chart for training data domains"
            onPointerMove={(event) => {
              const drag = draggingRef.current;
              if (drag)
                updateFromPointer(drag.domain, event.clientX, event.clientY);
            }}
            onPointerUp={() => {
              draggingRef.current = null;
              dragCeilingRef.current = null;
              dragZoomRef.current = null;
              setDragging(null);
            }}
            onPointerCancel={() => {
              draggingRef.current = null;
              dragCeilingRef.current = null;
              dragZoomRef.current = null;
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
              const usableMark = tokenRadius(
                availabilityByDomain[domain].usableMTok,
                ceiling,
                zoom,
              );
              return (
                <g key={domain}>
                  <line
                    x1={CENTER}
                    y1={CENTER}
                    x2={end.x}
                    y2={end.y}
                    stroke="rgba(139,171,181,.16)"
                  />
                  {usableMark > 0.04 ? (
                    <circle
                      cx={point(index, usableMark).x}
                      cy={point(index, usableMark).y}
                      r="2.4"
                      fill="none"
                      stroke="rgba(139,171,181,.45)"
                      strokeWidth="1.25"
                      pointerEvents="none"
                    />
                  ) : null}
                </g>
              );
            })}
            {syntheticUnlocked ? (
            <polygon
              points={polygon(
                DATA_DOMAINS.map((domain) => stackedRadii[domain].outer),
              )}
              fill={RECIPE_ZONE_META.synth.fill}
              stroke={RECIPE_ZONE_META.synth.stroke}
              strokeWidth="2"
              pointerEvents="none"
            />
            ) : null}
            <polygon
              points={polygon(
                DATA_DOMAINS.map((domain) => stackedRadii[domain].owned),
              )}
              fill={RECIPE_ZONE_META.post.fill}
              stroke={RECIPE_ZONE_META.post.stroke}
              strokeWidth="1.5"
              pointerEvents="none"
            />
            <polygon
              points={polygon(
                DATA_DOMAINS.map((domain) => stackedRadii[domain].inner),
              )}
              fill={RECIPE_ZONE_META.base.fill}
              stroke={RECIPE_ZONE_META.base.stroke}
              strokeWidth="1.5"
              pointerEvents="none"
            />
            <polygon
              points={polygon(
                DATA_DOMAINS.map((domain) => stackedRadii[domain].verify),
              )}
              fill={RECIPE_VERIFY_META.fill}
              stroke={RECIPE_VERIFY_META.stroke}
              strokeWidth="1.5"
              pointerEvents="none"
            />
            {DATA_DOMAINS.map((domain, index) => {
              const tip = domainAvailabilityTooltip(
                availabilityByDomain[domain],
                syntheticMultiplier,
              );
              const domainSelected = selected === domain;
              const radii = stackedRadii[domain];
              const spoke = spokes[domain];
              const handles: {
                zone: RecipeZone;
                value: number;
                radius: number;
                hit: number;
                size: number;
                label: string;
                tangent: number;
              }[] = [
                {
                  zone: "post",
                  value: spoke.post,
                  radius: radii.owned,
                  hit: domainSelected ? 13 : 10,
                  size: domainSelected ? 5 : 3.5,
                  label: "data volume",
                  tangent: 0,
                },
                ...(syntheticUnlocked
                  ? [
                      {
                        zone: "synth" as const,
                        value: spoke.synth,
                        radius: radii.outer,
                        hit: domainSelected ? 16 : 12,
                        size: domainSelected ? 7 : 5,
                        label: "synthetic volume",
                        tangent: 0,
                      },
                    ]
                  : []),
                {
                  zone: "base",
                  value: spoke.base,
                  radius: radii.inner,
                  hit: domainSelected ? 16 : 12,
                  size: domainSelected ? 6.5 : 4.5,
                  label: "base volume",
                  tangent: 0,
                },
              ];
              return handles.map((handle) => {
                const meta = RECIPE_ZONE_META[handle.zone];
                const along = point(index, handle.radius);
                const angle = spokeAngle(index);
                const pos = {
                  x: along.x - Math.sin(angle) * handle.tangent,
                  y: along.y + Math.cos(angle) * handle.tangent,
                };
                const isDragging =
                  dragging?.domain === domain && dragging.zone === handle.zone;
                return (
                  <g key={`handle-${domain}-${handle.zone}`}>
                    {handle.tangent !== 0 ? (
                      <line
                        x1={along.x}
                        y1={along.y}
                        x2={pos.x}
                        y2={pos.y}
                        stroke={meta.stroke}
                        strokeWidth="1.25"
                        pointerEvents="none"
                      />
                    ) : null}
                    {handle.zone === "base" ? (
                      <circle
                        cx={pos.x}
                        cy={pos.y}
                        r={handle.size + 3.5}
                        fill="rgba(0,229,192,.18)"
                        stroke={meta.stroke}
                        strokeWidth="1.25"
                        pointerEvents="none"
                      />
                    ) : null}
                    {handle.zone === "synth" ? (
                      <circle
                        cx={pos.x}
                        cy={pos.y}
                        r={domainSelected ? 11 : 9}
                        fill={RECIPE_ZONE_META.synth.fill}
                        stroke={meta.stroke}
                        strokeWidth="1"
                        pointerEvents="none"
                      />
                    ) : null}
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={handle.hit}
                      fill="transparent"
                      className="cursor-grab outline-none active:cursor-grabbing"
                      tabIndex={0}
                      role="slider"
                      aria-label={`${DATA_DOMAIN_META[domain].label} ${handle.label}`}
                      aria-valuemin={
                        handle.zone === "base"
                          ? Math.round(
                              spokes[domain].mid * (1 - MAX_POST_TRAIN_SHARE),
                            )
                          : 0
                      }
                      aria-valuemax={Math.round(
                        dragCapMTok(domain, handle.zone),
                      )}
                      aria-valuenow={Math.round(handle.value)}
                      onFocus={() => setSelected(domain)}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        draggingRef.current = {
                          domain,
                          zone: handle.zone,
                        };
                        dragCeilingRef.current = ceiling;
                        dragZoomRef.current = zoom;
                        setSelected(domain);
                        setEditing(null);
                        setDragging({ domain, zone: handle.zone });
                        updateFromPointer(
                          domain,
                          event.clientX,
                          event.clientY,
                        );
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
                          event.key === "ArrowUp" ||
                          event.key === "ArrowRight"
                            ? Math.max(1, ceiling * 0.03)
                            : -Math.max(1, ceiling * 0.03);
                        commitDomain(
                          handle.zone,
                          domain,
                          handle.value + delta,
                        );
                      }}
                    >
                      <title>
                        {`${meta.label} · ${formatTokens(handle.value)}\n${tip}`}
                      </title>
                    </circle>
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={isDragging ? handle.size + 1.5 : handle.size}
                      fill={isDragging ? "#f2f6f5" : meta.stroke}
                      stroke="#07171d"
                      strokeWidth="2"
                      pointerEvents="none"
                    />
                  </g>
                );
              });
            })}
          </svg>
          {DATA_DOMAINS.map((domain, index) => {
            const active = selected === domain;
            const spoke = spokes[domain];
            return (
              <button
                key={`label-${domain}`}
                type="button"
                className={`training-data-radar-label${active ? " is-active" : ""}`}
                data-radar-label={domain}
                style={labelAnchor(index)}
                title={domainAvailabilityTooltip(
                  availabilityByDomain[domain],
                  syntheticMultiplier,
                )}
                onClick={() => setSelected(domain)}
              >
                <span>{DATA_DOMAIN_META[domain].label}</span>
                <strong>{compactTok(spoke.mid)}</strong>
              </button>
            );
          })}
          </div>
          <div
            className="training-data-radar-pop"
            data-radar-pop="true"
            role="dialog"
            aria-label={`${selectedLabel} recipe volumes`}
          >
            <div className="training-data-radar-pop__head">
              <strong className="text-[0.75rem] text-bone">{selectedLabel}</strong>
              <span className="font-mono text-[0.625rem] tabular-nums text-muted">
                {compactTok(selectedSpoke.mid)}
              </span>
            </div>
            <div className="training-data-radar-pop__rows">
            {selectedRows.map((row) => (
              <VolumeRow
                key={row.key}
                label={row.label}
                color={row.color}
                valueLabel={compactTok(row.value)}
                editable={row.editable}
                editing={row.editable && editing === row.key}
                draft={draft}
                ariaEdit={`Edit ${selectedLabel} ${row.label.toLowerCase()}`}
                ariaInput={`${selectedLabel} ${row.label.toLowerCase()} MTok`}
                onStart={() => {
                  if (row.key === "verify") return;
                  startEdit(row.key, row.value);
                }}
                onDraft={setDraft}
                onCommit={() => {
                  if (row.key === "verify") return;
                  commitTypedVolume(row.key, selected, draft);
                }}
                onCancel={() => {
                  setEditing(null);
                  setDraft("");
                }}
                onNudge={
                  row.editable
                    ? (direction) => {
                        const step = Math.max(
                          1,
                          row.key === "base"
                            ? selectedSpoke.mid * 0.04
                            : row.value * 0.05 || 1,
                        );
                        commitTypedVolume(
                          row.key === "verify" ? "all" : row.key,
                          selected,
                          formatRecipeTokDraft(
                            Math.max(0, row.value + direction * step),
                          ),
                        );
                      }
                    : undefined
                }
              />
            ))}
            </div>
          </div>
          <div
            className="training-data-radar-legend mt-3 text-[0.6875rem]"
            data-radar-legend="true"
          >
            {(
              [
                RECIPE_VERIFY_META,
                RECIPE_ZONE_META.base,
                RECIPE_ZONE_META.post,
                ...(syntheticUnlocked ? [RECIPE_ZONE_META.synth] : []),
              ] as const
            ).map((meta) => (
              <div key={meta.label} className="flex min-w-0 items-start gap-2">
                <i
                  className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{
                    background: meta.fill,
                    boxShadow: `inset 0 0 0 1.5px ${meta.stroke}`,
                  }}
                />
                <span>
                  <strong className="block text-bone">{meta.label}</strong>
                  <span className="text-[0.625rem] leading-snug text-muted">
                    {meta.blurb}
                  </span>
                </span>
              </div>
            ))}
          </div>
          {syntheticUnlocked ? (
            <label className="mt-3 block text-[0.6875rem] text-muted">
              Synthetic teacher
              <HudSelect
                value={syntheticTeacherIds[selected] ?? ""}
                onChange={(event) =>
                  onTeacherChange(selected, event.target.value || undefined)
                }
                className="mt-1 w-full min-w-0 text-xs"
              >
                <option value="">Default teacher</option>
                {teachers.map((teacher) => (
                  <option key={teacher.id} value={teacher.id}>
                    {teacher.name} · cap {teacher.capability.toFixed(0)}
                  </option>
                ))}
              </HudSelect>
            </label>
          ) : null}
        </div>
      </div>
    </section>
  );
}

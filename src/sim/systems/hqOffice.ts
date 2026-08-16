import type {
  BuildableKind,
  HqOfficeLayout,
  HqOfficeLayoutAnalysis,
  HqOfficeObjectKind,
  HqOfficeObjectPlacement,
  HallRotation,
  SimState,
} from "../types";
import { isHqAnchor, isHqKind } from "./hqKinds";
import { facilityAnchorTiles } from "./worldAccess";
import { chargeExpense } from "./financeLedger";

/** A compact furniture catalogue shared by the palette, validator, and sim. */
export interface HqOfficeCatalogItem {
  id: string;
  label: string;
  kind: HqOfficeObjectKind;
  width: number;
  depth: number;
  purchasePrice: number;
  dailyOpex: number;
  capacityBonus: number;
  productivityBonus: number;
  buildDays: number;
  blurb: string;
  color: number;
}

export const HQ_OFFICE_CATALOG: readonly HqOfficeCatalogItem[] = [
  {
    id: "desk-standard",
    label: "Work desk",
    kind: "desk",
    width: 1,
    depth: 1,
    purchasePrice: 350_000,
    dailyOpex: 600,
    capacityBonus: 1,
    productivityBonus: 0.008,
    buildDays: 1,
    blurb: "A staffed seat with proper room to work.",
    color: 0x49d5cf,
  },
  {
    id: "plant-biophilic",
    label: "Plant wall",
    kind: "plant",
    width: 1,
    depth: 1,
    purchasePrice: 150_000,
    dailyOpex: 250,
    capacityBonus: 0,
    productivityBonus: 0.012,
    buildDays: 1,
    blurb: "A living divider that steadies the floor mood.",
    color: 0x93d36b,
  },
  {
    id: "copier-pro",
    label: "Copy station",
    kind: "copier",
    width: 1,
    depth: 1,
    purchasePrice: 500_000,
    dailyOpex: 1_100,
    capacityBonus: 0,
    productivityBonus: 0.018,
    buildDays: 2,
    blurb: "Shared operations equipment for faster handoffs.",
    color: 0xf0b85a,
  },
  {
    id: "meeting-room",
    label: "Meeting room",
    kind: "meeting_room",
    width: 2,
    depth: 2,
    purchasePrice: 1_800_000,
    dailyOpex: 2_000,
    capacityBonus: 2,
    productivityBonus: 0.035,
    buildDays: 4,
    blurb: "A room for reviews, pairing, and hard decisions.",
    color: 0xb497f2,
  },
  {
    id: "research-whiteboard",
    label: "Research wall",
    kind: "whiteboard",
    width: 2,
    depth: 1,
    purchasePrice: 850_000,
    dailyOpex: 200,
    capacityBonus: 0,
    productivityBonus: 0.025,
    buildDays: 2,
    blurb: "Visible working memory for research and systems teams.",
    color: 0x80b8ea,
  },
] as const;

export const HQ_OFFICE_GRID_METERS = 1.25;

const HQ_OFFICE_DIMENSIONS: Record<BuildableKind, { width: number; depth: number }> = {
  hq: { width: 8, depth: 6 },
  hq_m: { width: 12, depth: 8 },
  hq_l: { width: 16, depth: 10 },
  office: { width: 8, depth: 6 },
  dc: { width: 8, depth: 6 },
  dc_m: { width: 8, depth: 6 },
  dc_l: { width: 8, depth: 6 },
  substation: { width: 8, depth: 6 },
  solar: { width: 8, depth: 6 },
  gas: { width: 8, depth: 6 },
  nuclear: { width: 8, depth: 6 },
  fab: { width: 8, depth: 6 },
  cooling: { width: 8, depth: 6 },
  battery: { width: 8, depth: 6 },
  lab: { width: 8, depth: 6 },
};

const emptyAnalysis = (): HqOfficeLayoutAnalysis => ({
  revision: 0,
  valid: true,
  hardErrors: [],
  warnings: [],
  capacityBonus: 0,
  productivityBonus: 0,
  dailyOpex: 0,
  objectCount: 0,
});

export function hqOfficeCatalogItem(catalogId: string): HqOfficeCatalogItem | undefined {
  return HQ_OFFICE_CATALOG.find((item) => item.id === catalogId);
}

export function hqOfficeDimensions(kind: BuildableKind): { width: number; depth: number } {
  return HQ_OFFICE_DIMENSIONS[kind] ?? HQ_OFFICE_DIMENSIONS.hq;
}

export function hqOfficeLayoutForKind(
  facilityId: string,
  kind: BuildableKind,
): HqOfficeLayout {
  const dimensions = hqOfficeDimensions(kind);
  return {
    version: 1,
    facilityId,
    width: dimensions.width,
    depth: dimensions.depth,
    revision: 0,
    objects: [],
    analysis: emptyAnalysis(),
  };
}

export type HqOfficeAutomaticPreset = "balanced" | "focus" | "collaboration";

export const HQ_OFFICE_AUTOMATIC_PRESETS: ReadonlyArray<{
  id: HqOfficeAutomaticPreset;
  label: string;
  description: string;
}> = [
  {
    id: "balanced",
    label: "Balanced studio",
    description: "Desks, shared equipment, greenery, and one collaboration zone.",
  },
  {
    id: "focus",
    label: "Focus floor",
    description: "Prioritises staffed desks while keeping core support equipment.",
  },
  {
    id: "collaboration",
    label: "Research commons",
    description: "More meeting space and research walls with a smaller desk footprint.",
  },
] as const;

/** Deterministic, validator-backed office layouts. These use the same
 * catalogue, collision rules, quoting, and simulation effects as manual
 * placement, so auto layout is a convenience rather than a second ruleset. */
export function hqOfficeAutomaticLayout(
  facilityId: string,
  kind: BuildableKind,
  preset: HqOfficeAutomaticPreset,
): HqOfficeLayout {
  const layout = hqOfficeLayoutForKind(facilityId, kind);
  let nextId = 1;
  const addAtFirstOpen = (catalogId: string, count: number) => {
    const item = hqOfficeCatalogItem(catalogId);
    if (!item) return;
    let placed = 0;
    for (let z = 1; z < layout.depth && placed < count; z += 1) {
      for (let x = 0; x < layout.width && placed < count; x += 1) {
        const candidate: HqOfficeObjectPlacement = {
          id: `${facilityId}:auto:${preset}:${nextId}`,
          kind: item.kind,
          catalogId: item.id,
          x,
          z,
          rotation: 0,
          purchasePrice: item.purchasePrice,
        };
        if (previewHqObjectPlacement(layout, candidate) === "valid") {
          layout.objects.push(candidate);
          nextId += 1;
          placed += 1;
        }
      }
    }
  };

  const usableArea = layout.width * Math.max(1, layout.depth - 1);
  if (preset === "focus") {
    addAtFirstOpen("copier-pro", 1);
    addAtFirstOpen("plant-biophilic", Math.max(1, Math.floor(usableArea / 42)));
    addAtFirstOpen("research-whiteboard", 1);
    addAtFirstOpen("desk-standard", Math.max(6, Math.floor(usableArea * 0.42)));
  } else if (preset === "collaboration") {
    addAtFirstOpen("meeting-room", Math.max(1, Math.floor(usableArea / 48)));
    addAtFirstOpen("research-whiteboard", Math.max(1, Math.floor(usableArea / 55)));
    addAtFirstOpen("plant-biophilic", Math.max(2, Math.floor(usableArea / 34)));
    addAtFirstOpen("copier-pro", 1);
    addAtFirstOpen("desk-standard", Math.max(4, Math.floor(usableArea * 0.2)));
  } else {
    addAtFirstOpen("meeting-room", Math.max(1, Math.floor(usableArea / 72)));
    addAtFirstOpen("research-whiteboard", 1);
    addAtFirstOpen("plant-biophilic", Math.max(1, Math.floor(usableArea / 40)));
    addAtFirstOpen("copier-pro", 1);
    addAtFirstOpen("desk-standard", Math.max(5, Math.floor(usableArea * 0.3)));
  }

  layout.analysis = analyzeHqOfficeLayout(layout);
  return layout;
}

/** The free first HQ arrives furnished with twelve real work desks plus core
 * support objects. This preserves onboarding capacity while ensuring every
 * usable player seat is still represented by an object on the floor. */
export function hqOfficeStarterLayout(
  facilityId: string,
  kind: BuildableKind = "hq",
): HqOfficeLayout {
  const source = hqOfficeAutomaticLayout(facilityId, kind, "focus");
  let seats = 0;
  const objects = source.objects.filter((object) => {
    const item = hqOfficeCatalogItem(object.catalogId);
    if (!item) return false;
    if (item.capacityBonus <= 0) return true;
    if (object.kind !== "desk" || seats + item.capacityBonus > 12) return false;
    seats += item.capacityBonus;
    return true;
  });
  const layout = { ...source, objects };
  return { ...layout, analysis: analyzeHqOfficeLayout(layout) };
}

function dimensionsForObject(object: Pick<HqOfficeObjectPlacement, "catalogId" | "rotation">) {
  const item = hqOfficeCatalogItem(object.catalogId);
  const width = item?.width ?? 1;
  const depth = item?.depth ?? 1;
  return object.rotation === 90 || object.rotation === 270
    ? { width: depth, depth: width }
    : { width, depth };
}

function overlaps(a: HqOfficeObjectPlacement, b: HqOfficeObjectPlacement): boolean {
  const ad = dimensionsForObject(a);
  const bd = dimensionsForObject(b);
  return (
    a.x < b.x + bd.width &&
    a.x + ad.width > b.x &&
    a.z < b.z + bd.depth &&
    a.z + ad.depth > b.z
  );
}

export function previewHqObjectPlacement(
  layout: Pick<HqOfficeLayout, "width" | "depth" | "objects">,
  candidate: HqOfficeObjectPlacement,
): "valid" | "warning" | "invalid" {
  const size = dimensionsForObject(candidate);
  if (
    !Number.isInteger(candidate.x) ||
    !Number.isInteger(candidate.z) ||
    candidate.x < 0 ||
    candidate.z < 0 ||
    candidate.x + size.width > layout.width ||
    candidate.z + size.depth > layout.depth
  )
    return "invalid";
  if (layout.objects.some((object) => object.id !== candidate.id && overlaps(object, candidate)))
    return "invalid";
  // The front row is kept open as the entry/egress aisle. The warning lets a
  // player make a deliberate dense fit without making the editor unusable.
  if (candidate.z < 1) return "warning";
  return "valid";
}

export function analyzeHqOfficeLayout(layout: Pick<HqOfficeLayout, "width" | "depth" | "objects" | "revision">): HqOfficeLayoutAnalysis {
  const hardErrors: string[] = [];
  const warnings: string[] = [];
  let capacityBonus = 0;
  let productivityBonus = 0;
  let dailyOpex = 0;
  const seenIds = new Set<string>();
  for (const object of layout.objects) {
    if (seenIds.has(object.id)) {
      hardErrors.push(`Duplicate office object id: ${object.id}`);
      continue;
    }
    seenIds.add(object.id);
    const item = hqOfficeCatalogItem(object.catalogId);
    if (!item) {
      hardErrors.push(`Unknown office object: ${object.catalogId}`);
      continue;
    }
    const status = previewHqObjectPlacement(layout, object);
    if (status === "invalid") hardErrors.push(`${item.label} is outside the HQ or overlaps another object.`);
    if (status === "warning") warnings.push(`${item.label} is close to the entry aisle.`);
    capacityBonus += item.capacityBonus;
    productivityBonus += item.productivityBonus;
    dailyOpex += item.dailyOpex;
  }
  return {
    revision: layout.revision,
    valid: hardErrors.length === 0,
    hardErrors: [...new Set(hardErrors)],
    warnings: [...new Set(warnings)],
    capacityBonus,
    productivityBonus: Math.min(0.45, productivityBonus),
    dailyOpex,
    objectCount: layout.objects.length,
  };
}

export function normalizeHqOfficeLayout(
  raw: Partial<HqOfficeLayout> & Pick<HqOfficeLayout, "facilityId">,
  fallbackKind: BuildableKind = "hq",
): HqOfficeLayout {
  const dimensions = hqOfficeDimensions(fallbackKind);
  // Shell dimensions are authoritative. Do not let a hand-edited or stale
  // save enlarge the room and mint extra seats/productivity outside the HQ.
  const width = dimensions.width;
  const depth = dimensions.depth;
  const objects = Array.isArray(raw.objects)
    ? raw.objects
        .filter((object): object is HqOfficeObjectPlacement => Boolean(object && typeof object === "object"))
        .map((object, index) => {
          const catalogItem = hqOfficeCatalogItem(object.catalogId);
          return {
            id: typeof object.id === "string" && object.id ? object.id : `${raw.facilityId}:object:${index + 1}`,
            // The catalogue is authoritative for migrated saves. This repairs
            // early drafts that persisted a stale/missing kind separately.
            kind: catalogItem?.kind ?? object.kind,
            catalogId: object.catalogId,
            x: Number.isSafeInteger(object.x) ? object.x : 0,
            z: Number.isSafeInteger(object.z) ? object.z : 1,
            rotation: (object.rotation === 90 || object.rotation === 180 || object.rotation === 270 ? object.rotation : 0) as HallRotation,
            purchasePrice: Number.isFinite(object.purchasePrice) ? Math.max(0, object.purchasePrice) : catalogItem?.purchasePrice ?? 0,
          };
        })
        .filter((object) => hqOfficeCatalogItem(object.catalogId))
    : [];
  const layout: HqOfficeLayout = {
    version: 1,
    facilityId: raw.facilityId,
    width,
    depth,
    revision: Number.isSafeInteger(raw.revision) ? Math.max(0, Number(raw.revision)) : 0,
    objects,
    analysis: emptyAnalysis(),
  };
  return { ...layout, analysis: analyzeHqOfficeLayout(layout) };
}

/** Add the optional field and repair malformed legacy entries without
 * mutating the caller's save object. Empty old saves remain valid and cheap. */
export function migrateHqOfficeLayouts(state: SimState): SimState {
  const raw = state.hqOfficeLayouts;
  if (!raw || typeof raw !== "object") return { ...state, hqOfficeLayouts: {} };
  const facilityKinds = new Map(
    facilityAnchorTiles(state).map((tile) => [
      tile.campusId ?? `facility:${tile.x},${tile.y}`,
      tile.kind as BuildableKind,
    ]),
  );
  const layouts: Record<string, HqOfficeLayout> = {};
  for (const [facilityId, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    layouts[facilityId] = normalizeHqOfficeLayout(
      { ...(value as HqOfficeLayout), facilityId },
      facilityKinds.get(facilityId) ?? "hq",
    );
  }
  return { ...state, hqOfficeLayouts: layouts };
}

export function hqOfficeEffects(
  layout: HqOfficeLayout | undefined,
  fallbackKind: BuildableKind = "hq",
): HqOfficeLayoutAnalysis {
  if (!layout) return emptyAnalysis();
  const normalized = normalizeHqOfficeLayout(layout, fallbackKind);
  return normalized.analysis.valid
    ? normalized.analysis
    : {
        ...normalized.analysis,
        capacityBonus: 0,
        productivityBonus: 0,
        dailyOpex: 0,
        objectCount: 0,
      };
}

export function officeProductivityMultiplier(effects: Pick<HqOfficeLayoutAnalysis, "productivityBonus">): number {
  return 1 + Math.max(0, Math.min(0.45, effects.productivityBonus));
}

export interface HqOfficePlan {
  facilityId: string;
  width: number;
  depth: number;
  objects: HqOfficeObjectPlacement[];
}

export function quoteHqOfficePlan(plan: HqOfficePlan, current?: HqOfficeLayout): {
  purchaseCost: number;
  refund: number;
  netCost: number;
  buildDays: number;
} {
  const currentById = new Map<string, HqOfficeObjectPlacement>();
  for (const object of current?.objects ?? []) {
    if (!currentById.has(object.id)) currentById.set(object.id, object);
  }
  const nextById = new Map<string, HqOfficeObjectPlacement>();
  for (const object of plan.objects) {
    if (!nextById.has(object.id)) nextById.set(object.id, object);
  }
  const catalogPrice = (object: HqOfficeObjectPlacement): number =>
    hqOfficeCatalogItem(object.catalogId)?.purchasePrice ?? 0;
  const purchaseCost = [...nextById.values()].reduce((sum, object) => {
    const previous = currentById.get(object.id);
    return sum + (!previous || previous.catalogId !== object.catalogId ? catalogPrice(object) : 0);
  }, 0);
  const refund = [...currentById.values()].reduce((sum, object) => {
    const next = nextById.get(object.id);
    return sum + (!next || next.catalogId !== object.catalogId ? catalogPrice(object) * 0.5 : 0);
  }, 0);
  const buildDays = [...nextById.values()]
    .filter((object) => {
      const previous = currentById.get(object.id);
      return !previous || previous.catalogId !== object.catalogId;
    })
    .reduce((days, object) => Math.max(days, hqOfficeCatalogItem(object.catalogId)?.buildDays ?? 1), 0);
  return { purchaseCost, refund, netCost: Math.max(0, purchaseCost - refund), buildDays };
}

function findOwnedHq(state: SimState, facilityId: string) {
  return facilityAnchorTiles(state, { ownerId: state.playerLabId }).find(
    (tile) =>
      isHqKind(tile.kind) &&
      isHqAnchor(tile) &&
      (tile.campusId ?? `facility:${tile.x},${tile.y}`) === facilityId &&
      tile.buildingProgress >= tile.buildingTarget,
  );
}

export function applyHqOfficePlan(state: SimState, plan: HqOfficePlan): { ok: boolean; state: SimState; error?: string; netCost: number } {
  const hq = findOwnedHq(state, plan.facilityId);
  if (!hq) return { ok: false, state, error: "Open a completed player HQ before fitting it out.", netCost: 0 };
  const expectedDimensions = hqOfficeDimensions(hq.kind as BuildableKind);
  if (plan.width !== expectedDimensions.width || plan.depth !== expectedDimensions.depth) {
    return { ok: false, state, error: "This office plan does not match the HQ shell.", netCost: 0 };
  }
  const current = state.hqOfficeLayouts?.[plan.facilityId];
  const layout: HqOfficeLayout = {
    version: 1,
    facilityId: plan.facilityId,
    width: plan.width,
    depth: plan.depth,
    revision: (current?.revision ?? 0) + 1,
    objects: plan.objects.map((object) => ({ ...object })),
    analysis: emptyAnalysis(),
  };
  layout.analysis = analyzeHqOfficeLayout(layout);
  if (!layout.analysis.valid) return { ok: false, state, error: layout.analysis.hardErrors[0] ?? "HQ layout is invalid.", netCost: 0 };
  const quote = quoteHqOfficePlan(plan, current);
  if (state.player.cash < quote.netCost) {
    return { ok: false, state, error: `Need $${(quote.netCost / 1_000_000).toFixed(2)}M for this fit-out.`, netCost: quote.netCost };
  }
  const charged = chargeExpense(
    {
      ...state,
      hqOfficeLayouts: { ...(state.hqOfficeLayouts ?? {}), [plan.facilityId]: layout },
    },
    quote.netCost,
    "capex",
  );
  return {
    ok: true,
    state: {
      ...charged,
      alerts: [
        {
          id: `hq-fitout-${plan.facilityId}-${layout.revision}`,
          day: state.day,
          severity: "info" as const,
          message: `HQ fit-out saved: ${layout.analysis.objectCount} objects, +${layout.analysis.capacityBonus} seats, ${(layout.analysis.productivityBonus * 100).toFixed(1)}% productivity.`,
        },
        ...charged.alerts,
      ].slice(0, 40),
    },
    netCost: quote.netCost,
  };
}

export function rotateHqObject(object: HqOfficeObjectPlacement): HqOfficeObjectPlacement {
  const rotation: HallRotation = object.rotation === 270 ? 0 : ((object.rotation + 90) as HallRotation);
  return { ...object, rotation };
}

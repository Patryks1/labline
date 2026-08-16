import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowsOutCardinal,
  Backspace,
  Cube,
  Cpu,
  HardDrives,
  MagnifyingGlass,
  Snowflake,
  SquaresFour,
  Trash,
} from "@phosphor-icons/react";
import type {
  DataHallConstructionProject,
  DataHallLayout,
  DataHallObjectPlacement,
  HallAutoLayoutStrategy,
} from "../../../../sim/types";
import {
  DATA_HALL_SHELLS,
  HALL_EQUIPMENT_CATALOG,
  HALL_GRID_METERS,
  analyzeHallLayout,
  autoPlanHall,
  createDoor,
  createWall,
  previewHallObjectPlacement,
  quoteHallPlanNetCost,
  quoteHallRackPurchases,
  rackUnitsForFacility,
  rotateHallObject,
} from "../../../../sim/systems/dataHallLayouts";
import {
  hallInstalledEquipmentOpexDay,
  scheduleHallConstruction,
} from "../../../../sim/systems/dataHallConstruction";
import {
  fullOrderCatalog,
  strategyRackSku,
} from "../../../../sim/systems/dcRacks";
import { quoteRackOrder } from "../../../../sim/balance/rackSkus";
import { aggregateEffects } from "../../../../sim/systems/research";
import { facilityAnchorTiles } from "../../../../sim/systems/worldAccess";
import { resolveRackSku } from "../../../../sim/systems/racks";
import { useGameStore } from "../../../../store/gameStore";
import { money, mw, num } from "../../format";
import {
  BlockerList,
  MeterBar,
  SegmentedTabs,
  StatRow,
} from "../../ui/kit";
import {
  HudButton,
  HudInput,
  MetricTile,
} from "../../ui/HudPrimitives";
import { ResponsiveDonut } from "../../ui/dataViz/ResponsiveDonut";
import {
  captureHallClock,
  projectHallPlanForAnalysis,
  restoreHallClock,
  splitHallWallAroundDoors,
  summarizeHallRackCapacity,
  type HallClockSnapshot,
  type HallRackCapacityTotals,
} from "./hallLayoutModel";
import {
  HALL_PALETTE_DATA_MIME,
  groupHallRackPaletteUnits,
  nextAvailableHallRackUnit,
  parseHallPalettePayload,
  serializeHallEquipmentPayload,
  serializeHallRackSkuPayload,
} from "./hallPaletteModel";
import { createHallEquipmentModel, rackVariantSeed } from "./hallSceneModels";

type Draft = Pick<
  DataHallLayout,
  "objects" | "walls" | "doors" | "preferredStrategy"
>;
type PaletteMode =
  | { kind: "rack"; skuId: string }
  | { kind: "equipment"; catalogId: string }
  | { kind: "wall"; start?: { x: number; z: number } }
  | null;
type HallOverlayMode =
  | "overview"
  | "power"
  | "cooling"
  | "network"
  | "access"
  | "risk"
  | "construction";
export type HallMobileWorkspace = "palette" | "floor" | "inspect";

const HALL_MOBILE_WORKSPACES: ReadonlyArray<{
  id: HallMobileWorkspace;
  label: string;
}> = [
  { id: "palette", label: "Palette" },
  { id: "floor", label: "Floor" },
  { id: "inspect", label: "Inspect" },
];

export function HallMobileWorkspaceTabs({
  active,
  hasSelection,
  placementActive,
  onChange,
}: {
  active: HallMobileWorkspace;
  hasSelection: boolean;
  placementActive: boolean;
  onChange: (workspace: HallMobileWorkspace) => void;
}) {
  return (
    <nav
      className="order-2 hidden border-y border-line/80 bg-panel/98 px-2 py-1 max-[900px]:grid"
    >
      <SegmentedTabs
        ariaLabel="Hall editor workspace"
        active={active}
        onChange={(id) => onChange(id as HallMobileWorkspace)}
        idPrefix="hall-mobile-tab"
        items={HALL_MOBILE_WORKSPACES.map((workspace) => {
          const activeBadge =
            workspace.id === "palette" && placementActive
              ? "placement selected"
              : workspace.id === "inspect" && hasSelection
                ? "asset selected"
                : null;
          return {
            id: workspace.id,
            ariaLabel: activeBadge
              ? `${workspace.label}, ${activeBadge}`
              : workspace.label,
            panelId: `hall-mobile-panel-${workspace.id}`,
            label: (
              <span className="relative inline-flex min-h-11 items-center px-2">
                {workspace.label}
                {activeBadge ? (
                  <span
                    aria-hidden="true"
                    className="absolute right-0 top-2 size-1.5 rounded-full bg-amber"
                  />
                ) : null}
              </span>
            ),
          };
        })}
      />
    </nav>
  );
}

const HALL_OVERLAYS: ReadonlyArray<{
  id: HallOverlayMode;
  label: string;
  description: string;
}> = [
  {
    id: "overview",
    label: "Overview",
    description: "Operational capacity and all service paths",
  },
  {
    id: "power",
    label: "Power",
    description: "Power routes, load, and headroom",
  },
  {
    id: "cooling",
    label: "Cooling",
    description: "Cooling reach, heat load, and airflow",
  },
  {
    id: "network",
    label: "Network",
    description: "Fabric routes, load, and headroom",
  },
  {
    id: "access",
    label: "Access",
    description: "Service routes and unreachable assets",
  },
  {
    id: "risk",
    label: "Risk",
    description: "Redundancy and operational exposure",
  },
  {
    id: "construction",
    label: "Build",
    description: "Live floor and commissioned target",
  },
];

const cloneDraft = (draft: Draft): Draft => ({
  preferredStrategy: draft.preferredStrategy,
  objects: draft.objects.map((entry) => ({ ...entry })),
  walls: draft.walls.map((entry) => ({ ...entry })),
  doors: draft.doors.map((entry) => ({ ...entry })),
});

const hasDifferentHallPlan = (live: Draft, draft: Draft): boolean =>
  JSON.stringify({
    objects: draft.objects,
    walls: draft.walls,
    doors: draft.doors,
    preferredStrategy: draft.preferredStrategy,
  }) !==
  JSON.stringify({
    objects: live.objects,
    walls: live.walls,
    doors: live.doors,
    preferredStrategy: live.preferredStrategy,
  });

const reservedRackAtCell = (
  draft: Pick<Draft, "objects">,
  x: number,
  z: number,
) =>
  draft.objects.find((object) => {
    if (object.kind !== "rack" || !object.reserved) return false;
    const rotated = object.rotation === 90 || object.rotation === 270;
    const width = rotated ? 5 : 3;
    const depth = rotated ? 3 : 5;
    return (
      x >= object.x &&
      x < object.x + width &&
      z >= object.z &&
      z < object.z + depth
    );
  });

export function DataHallEditorOverlay() {
  const facilityId = useGameStore((store) => store.hallEditorFacilityId);
  const state = useGameStore((store) => store.state);
  const close = useGameStore((store) => store.closeHallEditor);
  const applyPlan = useGameStore((store) => store.applyHallEditorPlan);
  const openRackDesigner = useGameStore((store) => store.openRackDesigner);
  const layout = facilityId ? state.dataHallLayouts?.[facilityId] : undefined;
  const hall = facilityId
    ? facilityAnchorTiles(state).find(
        (tile) =>
          (tile.campusId ?? `facility:${tile.x},${tile.y}`) === facilityId,
      )
    : undefined;
  const inventory = useMemo(
    () =>
      facilityId && hall
        ? rackUnitsForFacility(state, facilityId, hall.owner)
        : [],
    [facilityId, hall, state],
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [past, setPast] = useState<Draft[]>([]);
  const [future, setFuture] = useState<Draft[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<PaletteMode>(null);
  const [overlayMode, setOverlayMode] = useState<HallOverlayMode>("overview");
  const [showGrid, setShowGrid] = useState(true);
  const [previewStrategy, setPreviewStrategy] =
    useState<HallAutoLayoutStrategy | null>(null);
  const [message, setMessage] = useState(
    "Draft changes remain a ghost plan until construction and commissioning finish.",
  );
  const [paletteSearch, setPaletteSearch] = useState("");
  const [shiftHeld, setShiftHeld] = useState(false);
  const [mobileWorkspace, setMobileWorkspace] =
    useState<HallMobileWorkspace>("floor");
  const idCounter = useRef(1);
  const priorClock = useRef<HallClockSnapshot | null>(null);
  const repeatPlacement = useRef(false);
  const draftRef = useRef<Draft | null>(null);
  const editingLockedRef = useRef(false);
  const constructionProject = layout?.constructionProject;
  editingLockedRef.current = Boolean(constructionProject);

  useEffect(() => {
    if (!facilityId || !layout) return;
    const initialDraft = cloneDraft(layout);
    draftRef.current = initialDraft;
    setDraft(initialDraft);
    setPast([]);
    setFuture([]);
    setSelectedId(null);
    setMode(null);
    setPaletteSearch("");
    setShiftHeld(false);
    setMobileWorkspace("floor");
    setOverlayMode(layout.constructionProject ? "construction" : "overview");
    repeatPlacement.current = false;
    setPreviewStrategy(null);
    idCounter.current =
      Math.max(
        0,
        ...[...layout.objects, ...layout.walls, ...layout.doors].map(
          (entry) => {
            const match = entry.id.match(/:(\d+)$/);
            return match ? Number(match[1]) : 0;
          },
        ),
      ) + 1;
  }, [facilityId, layout]);

  useEffect(() => {
    if (!facilityId) return;
    const current = useGameStore.getState().state;
    priorClock.current = captureHallClock(current);
    useGameStore.getState().setPaused(true);
    return () => {
      const prior = priorClock.current;
      if (prior)
        useGameStore.setState((store) => ({
          state: restoreHallClock(store.state, prior),
        }));
      priorClock.current = null;
    };
  }, [facilityId]);

  useEffect(() => {
    if (!facilityId) return;
    setMessage(
      "Draft changes remain a ghost plan until construction and commissioning finish.",
    );
  }, [facilityId]);

  const constructionTargetLayout = useMemo<DataHallLayout | null>(
    () =>
      layout?.constructionProject
        ? {
            ...layout,
            revision: layout.constructionProject.targetRevision,
            preferredStrategy:
              layout.constructionProject.targetPreferredStrategy,
            objects: layout.constructionProject.targetObjects,
            walls: layout.constructionProject.targetWalls,
            doors: layout.constructionProject.targetDoors,
            constructionProject: undefined,
          }
        : null,
    [layout],
  );
  const editorLayout = useMemo(
    () =>
      constructionTargetLayout ??
      (layout && draft ? { ...layout, ...draft } : null),
    [constructionTargetLayout, draft, layout],
  );
  const planningProjection = useMemo(() => {
    if (!editorLayout) return null;
    return projectHallPlanForAnalysis(editorLayout, inventory, (skuId) => {
      try {
        return resolveRackSku(skuId, state.player.rackDesigns ?? []);
      } catch {
        return undefined;
      }
    });
  }, [editorLayout, inventory, state.player.rackDesigns]);
  const analysis = useMemo(
    () =>
      planningProjection && hall
        ? analyzeHallLayout(
            planningProjection.layout,
            planningProjection.inventory,
            hall.rackCapacity,
          )
        : null,
    [hall, planningProjection],
  );
  const planNetCost = useMemo(
    () => (layout && draft ? quoteHallPlanNetCost(layout, draft) : 0),
    [draft, layout],
  );
  const purchaseQuote = useMemo(
    () =>
      layout && draft && hall
        ? quoteHallRackPurchases(
            state,
            {
              facilityId: layout.facilityId,
              shellId: layout.shellId,
              objects: draft.objects,
              walls: draft.walls,
              doors: draft.doors,
            },
            hall,
          )
        : {
            drafts: 0,
            cost: 0,
            provisionCost: 0,
            total: 0,
            targetRackCabinets: 0,
            targetRackBays: 0,
            stagedFleetRackBays: 0,
          },
    [state, layout, draft, hall],
  );
  const planTotalCost = planNetCost + purchaseQuote.total;
  const canAffordPlan = state.player.cash >= planTotalCost;
  const canSchedulePlan = analysis?.valid === true && canAffordPlan;
  const plannedOpexDay = useMemo(
    () => (editorLayout ? hallInstalledEquipmentOpexDay(editorLayout) : 0),
    [editorLayout],
  );
  const liveOpexDay = useMemo(
    () => hallInstalledEquipmentOpexDay(layout),
    [layout],
  );
  const buildSchedule = useMemo(
    () =>
      layout && draft && hasDifferentHallPlan(layout, draft)
        ? scheduleHallConstruction(layout, draft)
        : null,
    [draft, layout],
  );
  const placedUnits = useMemo(
    () =>
      new Set(
        draft?.objects.flatMap((object) =>
          object.rackUnitId ? [object.rackUnitId] : [],
        ) ?? [],
      ),
    [draft],
  );
  const staging = inventory.filter(
    (unit) => unit.delivered && !placedUnits.has(unit.unitId),
  );
  const rackGroups = useMemo(
    () => groupHallRackPaletteUnits(inventory, placedUnits),
    [inventory, placedUnits],
  );
  const rackCards = useMemo(() => {
    const staged = new Map(
      rackGroups.map((group) => [group.skuId, group.availableCount]),
    );
    const catalog = fullOrderCatalog(state).map((sku) => ({
      skuId: sku.id,
      sku,
      availableCount: staged.get(sku.id) ?? 0,
    }));
    const known = new Set(catalog.map((card) => card.skuId));
    // Staged legacy designs that are no longer orderable still place from stock.
    for (const group of rackGroups) {
      if (known.has(group.skuId)) continue;
      try {
        catalog.push({
          skuId: group.skuId,
          sku: resolveRackSku(group.skuId, state.player.rackDesigns ?? []),
          availableCount: group.availableCount,
        });
      } catch {
        /* unknown legacy design */
      }
    }
    return catalog;
  }, [rackGroups, state]);
  const paletteQuery = paletteSearch.trim().toLocaleLowerCase();
  const visibleRackCards = rackCards.filter(
    ({ sku, skuId }) =>
      !paletteQuery ||
      `${sku.name} ${sku.blurb} ${skuId}`
        .toLocaleLowerCase()
        .includes(paletteQuery),
  );
  const savedRackImpact = useMemo(
    () =>
      summarizeHallRackCapacity(layout?.objects ?? [], (skuId) => {
        try {
          return resolveRackSku(skuId, state.player.rackDesigns ?? []);
        } catch {
          return undefined;
        }
      }),
    [layout?.objects, state.player.rackDesigns],
  );
  const draftRackImpact = useMemo(
    () =>
      summarizeHallRackCapacity(editorLayout?.objects ?? [], (skuId) => {
        try {
          return resolveRackSku(skuId, state.player.rackDesigns ?? []);
        } catch {
          return undefined;
        }
      }),
    [editorLayout?.objects, state.player.rackDesigns],
  );
  const planCapacity = useMemo<HallRackCapacityTotals>(
    () => ({
      cabinets:
        draftRackImpact.installed.cabinets +
        draftRackImpact.ordered.cabinets +
        draftRackImpact.planned.cabinets,
      rackBays:
        draftRackImpact.installed.rackBays +
        draftRackImpact.ordered.rackBays +
        draftRackImpact.planned.rackBays,
      flopsPf:
        draftRackImpact.installed.flopsPf +
        draftRackImpact.ordered.flopsPf +
        draftRackImpact.planned.flopsPf,
      vramGb:
        draftRackImpact.installed.vramGb +
        draftRackImpact.ordered.vramGb +
        draftRackImpact.planned.vramGb,
      mw:
        draftRackImpact.installed.mw +
        draftRackImpact.ordered.mw +
        draftRackImpact.planned.mw,
      tokPerSec:
        draftRackImpact.installed.tokPerSec +
        draftRackImpact.ordered.tokPerSec +
        draftRackImpact.planned.tokPerSec,
    }),
    [draftRackImpact],
  );
  const hasDraftChanges = useMemo(
    () =>
      !constructionProject &&
      Boolean(layout && draft) &&
      hasDifferentHallPlan(layout!, draft!),
    [constructionProject, draft, layout],
  );
  const selectedObject = editorLayout?.objects.find(
    (object) => object.id === selectedId,
  );
  const selectedWall = editorLayout?.walls.find(
    (wall) => wall.id === selectedId,
  );

  const requestClose = useCallback(() => {
    if (
      hasDraftChanges &&
      !window.confirm("Discard the unsaved data-hall plan?")
    )
      return;
    close();
  }, [close, hasDraftChanges]);

  const mutate = useCallback((operation: (current: Draft) => Draft) => {
    if (editingLockedRef.current) {
      setMessage(
        "This hall is locked while its current project is being built and commissioned.",
      );
      return;
    }
    setPreviewStrategy(null);
    const current = draftRef.current;
    if (!current) return;
    const next = operation(cloneDraft(current));
    draftRef.current = next;
    setPast((entries) => [...entries.slice(-49), cloneDraft(current)]);
    setFuture([]);
    setDraft(next);
  }, []);

  const undo = useCallback(() => {
    setPreviewStrategy(null);
    setPast((entries) => {
      const previous = entries.at(-1);
      if (!previous) return entries;
      setDraft((current) => {
        if (current)
          setFuture((next) => [cloneDraft(current), ...next].slice(0, 50));
        const restored = cloneDraft(previous);
        draftRef.current = restored;
        return restored;
      });
      return entries.slice(0, -1);
    });
  }, []);
  const redo = useCallback(() => {
    setPreviewStrategy(null);
    setFuture((entries) => {
      const next = entries[0];
      if (!next) return entries;
      setDraft((current) => {
        if (current)
          setPast((history) => [...history.slice(-49), cloneDraft(current)]);
        const restored = cloneDraft(next);
        draftRef.current = restored;
        return restored;
      });
      return entries.slice(1);
    });
  }, []);

  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    mutate((current) => ({
      ...current,
      objects: current.objects.filter((entry) => entry.id !== selectedId),
      walls: current.walls.filter((entry) => entry.id !== selectedId),
      doors: current.doors.filter(
        (entry) => entry.id !== selectedId && entry.wallId !== selectedId,
      ),
    }));
    setSelectedId(null);
  }, [mutate, selectedId]);

  const rotateSelected = useCallback(() => {
    if (!selectedId || !layout || !hall) return;
    const current = draftRef.current;
    const object = current?.objects.find((entry) => entry.id === selectedId);
    if (!current || !object) return;
    const rotated = rotateHallObject(object);
    if (
      previewHallObjectPlacement(
        { ...layout, ...current },
        rotated,
        hall.rackCapacity,
      ) === "invalid"
    ) {
      setMessage(
        "Rotation blocked: the rotated footprint would collide with the room or another asset.",
      );
      return;
    }
    mutate((draft) => ({
      ...draft,
      objects: draft.objects.map((entry) =>
        entry.id === selectedId ? rotated : entry,
      ),
    }));
  }, [hall, layout, mutate, selectedId]);

  const duplicateSelected = useCallback(() => {
    if (!selectedObject) return;
    if (selectedObject.kind === "rack") {
      const currentPlacedUnits = new Set(
        draftRef.current?.objects.flatMap((object) =>
          object.rackUnitId ? [object.rackUnitId] : [],
        ) ?? [],
      );
      const replacement = selectedObject.rackUnitId
        ? inventory
            .filter(
              (unit) =>
                unit.delivered &&
                unit.skuId === selectedObject.catalogId &&
                !currentPlacedUnits.has(unit.unitId),
            )
            .sort((a, b) => a.unitId.localeCompare(b.unitId))[0]
        : undefined;
      // No staged unit (or duplicating a purchase draft) → another purchase draft.
      let purchasePrice = selectedObject.purchasePrice;
      if (!replacement) {
        try {
          purchasePrice = resolveRackSku(
            selectedObject.catalogId,
            state.player.rackDesigns ?? [],
          ).price;
        } catch {
          /* keep the source object's price */
        }
      }
      const id = `${facilityId}:draft:${idCounter.current++}`;
      const duplicate = {
        ...selectedObject,
        id,
        rackUnitId: replacement?.unitId,
        x: selectedObject.x + 4,
        purchasePrice,
      };
      const current = draftRef.current;
      if (
        !layout ||
        !hall ||
        !current ||
        previewHallObjectPlacement(
          { ...layout, ...current },
          duplicate,
          hall.rackCapacity,
        ) === "invalid"
      ) {
        setMessage(
          "Duplicate blocked: move the selected rack somewhere with more clear floor space first.",
        );
        return;
      }
      mutate((draft) => ({ ...draft, objects: [...draft.objects, duplicate] }));
      setSelectedId(id);
      return;
    }
    const def = HALL_EQUIPMENT_CATALOG.find(
      (entry) => entry.id === selectedObject.catalogId,
    );
    if (!def) return;
    const id = `${facilityId}:draft:${idCounter.current++}`;
    const duplicate = {
      ...selectedObject,
      id,
      x: selectedObject.x + 4,
      purchasePrice: def.price,
    };
    const current = draftRef.current;
    if (
      !layout ||
      !hall ||
      !current ||
      previewHallObjectPlacement(
        { ...layout, ...current },
        duplicate,
        hall.rackCapacity,
      ) === "invalid"
    ) {
      setMessage(
        "Duplicate blocked: there is not enough clear floor space beside this asset.",
      );
      return;
    }
    mutate((draft) => ({ ...draft, objects: [...draft.objects, duplicate] }));
    setSelectedId(id);
  }, [
    facilityId,
    hall,
    inventory,
    layout,
    mutate,
    selectedObject,
    state.player.rackDesigns,
  ]);

  useEffect(() => {
    if (!facilityId) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.matches(
          'input, textarea, select, button, a, [contenteditable="true"]',
        )
      )
        return;
      if (event.key === "Shift") {
        setShiftHeld(true);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        repeatPlacement.current = false;
        if (mode) setMode(null);
        else requestClose();
        return;
      }
      if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        event.stopImmediatePropagation();
        rotateSelected();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        event.stopImmediatePropagation();
        removeSelected();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        event.stopImmediatePropagation();
        redo();
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Shift") return;
      setShiftHeld(false);
      if (repeatPlacement.current) {
        repeatPlacement.current = false;
        setMode(null);
        setMessage("Repeated placement finished.");
      }
    };
    const clearLostModifier = () => {
      setShiftHeld(false);
      if (!repeatPlacement.current) return;
      repeatPlacement.current = false;
      setMode(null);
      setMessage("Repeated placement finished.");
    };
    const handleVisibility = () => {
      if (document.hidden) clearLostModifier();
    };
    window.addEventListener("keydown", handler, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", clearLostModifier);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", clearLostModifier);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [
    facilityId,
    mode,
    redo,
    removeSelected,
    requestClose,
    rotateSelected,
    undo,
  ]);

  const previewPlacement = useCallback(
    (
      previewMode: NonNullable<PaletteMode>,
      x: number,
      z: number,
    ): "valid" | "warning" | "invalid" => {
      if (!layout || !draft || !hall || !analysis) return "invalid";
      const currentDraft = draftRef.current ?? draft;
      const candidate = cloneDraft(currentDraft);
      if (previewMode.kind === "wall") {
        if (!previewMode.start) return "valid";
        const horizontal =
          Math.abs(x - previewMode.start.x) >=
          Math.abs(z - previewMode.start.z);
        const end = horizontal
          ? { x, z: previewMode.start.z }
          : { x: previewMode.start.x, z };
        candidate.walls.push(
          createWall(
            "__preview-wall",
            previewMode.start.x,
            previewMode.start.z,
            end.x,
            end.z,
          ),
        );
      } else {
        const reserved =
          previewMode.kind === "rack"
            ? reservedRackAtCell(candidate, x, z)
            : undefined;
        if (reserved)
          candidate.objects = candidate.objects.filter(
            (object) => object.id !== reserved.id,
          );
        const object: DataHallObjectPlacement =
          previewMode.kind === "rack"
            ? {
                id: "__preview",
                kind: "rack",
                catalogId: previewMode.skuId,
                x: reserved?.x ?? x,
                z: reserved?.z ?? z,
                rotation: reserved?.rotation ?? 0,
                purchasePrice: 0,
              }
            : (() => {
                const def = HALL_EQUIPMENT_CATALOG.find(
                  (entry) => entry.id === previewMode.catalogId,
                )!;
                return {
                  id: "__preview",
                  kind: def.kind,
                  catalogId: def.id,
                  x,
                  z,
                  rotation: 0,
                  purchasePrice: def.price,
                };
              })();
        candidate.objects.push(object);
      }
      const object = candidate.objects.at(-1);
      if (!object || object.id !== "__preview") {
        const result = analyzeHallLayout(
          { ...layout, ...candidate },
          inventory,
          hall.rackCapacity,
        );
        return result.valid
          ? result.warnings.length > analysis.warnings.length
            ? "warning"
            : "valid"
          : "invalid";
      }
      return previewHallObjectPlacement(
        { ...layout, ...candidate },
        object,
        hall.rackCapacity,
      );
    },
    [analysis, draft, hall, inventory, layout],
  );

  const previewObjectMove = useCallback(
    (object: DataHallObjectPlacement, x: number, z: number) => {
      if (!layout || !draft || !hall) return "invalid" as const;
      return previewHallObjectPlacement(
        { ...layout, ...(draftRef.current ?? draft) },
        { ...object, x, z },
        hall.rackCapacity,
      );
    },
    [draft, hall, layout],
  );

  if (!facilityId) return null;
  if (!layout || !hall || !draft || !analysis)
    return (
      <div className="fixed inset-0 z-[100] grid place-items-center bg-void text-bone">
        Preparing data hall…
      </div>
    );

  const placeAt = (
    x: number,
    z: number,
    keepActive = false,
    requestedMode: PaletteMode = mode,
  ) => {
    if (!requestedMode) return;
    if (requestedMode.kind === "wall") {
      if (!requestedMode.start) {
        setMode({ ...requestedMode, start: { x, z } });
        setMessage("Choose the wall end point.");
        return;
      }
      const horizontal =
        Math.abs(x - requestedMode.start.x) >=
        Math.abs(z - requestedMode.start.z);
      const end = horizontal
        ? { x, z: requestedMode.start.z }
        : { x: requestedMode.start.x, z };
      const wall = createWall(
        `${facilityId}:wall:${idCounter.current++}`,
        requestedMode.start.x,
        requestedMode.start.z,
        end.x,
        end.z,
      );
      const current = draftRef.current;
      if (!current) return;
      const candidate = {
        ...layout,
        ...current,
        walls: [...current.walls, wall],
      };
      const result = analyzeHallLayout(candidate, inventory, hall.rackCapacity);
      if (!result.valid) {
        setMessage(
          `Wall blocked: ${result.hardErrors[0] ?? "choose a clear route."}`,
        );
        setMode({ kind: "wall" });
        return;
      }
      mutate((current) => ({ ...current, walls: [...current.walls, wall] }));
      setMode({ kind: "wall" });
      return;
    }
    const placementState = previewPlacement(requestedMode, x, z);
    if (placementState === "invalid") {
      setMessage("That grid position is blocked. Choose a red-free footprint.");
      return;
    }
    const id = `${facilityId}:draft:${idCounter.current++}`;
    const currentPlacedUnits = new Set(
      draftRef.current?.objects.flatMap((object) =>
        object.rackUnitId ? [object.rackUnitId] : [],
      ) ?? [],
    );
    const stagedUnitId =
      requestedMode.kind === "rack"
        ? (nextAvailableHallRackUnit(
            groupHallRackPaletteUnits(inventory, currentPlacedUnits).find(
              (group) => group.skuId === requestedMode.skuId,
            ) ?? { unitIds: [] },
          ) ?? undefined)
        : undefined;
    // No staged unit → purchase draft: bought and commissioned on Apply.
    let purchasePrice = 0;
    if (requestedMode.kind === "rack" && !stagedUnitId) {
      try {
        purchasePrice = resolveRackSku(
          requestedMode.skuId,
          state.player.rackDesigns ?? [],
        ).price;
      } catch {
        setMessage("That rack design is not available to order.");
        return;
      }
    }
    const reserved =
      requestedMode.kind === "rack" && draftRef.current
        ? reservedRackAtCell(draftRef.current, x, z)
        : undefined;
    const object: DataHallObjectPlacement =
      requestedMode.kind === "rack"
        ? {
            id,
            kind: "rack",
            catalogId: requestedMode.skuId,
            rackUnitId: stagedUnitId,
            x: reserved?.x ?? x,
            z: reserved?.z ?? z,
            rotation: reserved?.rotation ?? 0,
            purchasePrice,
          }
        : (() => {
            const def = HALL_EQUIPMENT_CATALOG.find(
              (entry) => entry.id === requestedMode.catalogId,
            )!;
            return {
              id,
              kind: def.kind,
              catalogId: def.id,
              x,
              z,
              rotation: 0,
              purchasePrice: def.price,
            };
          })();
    mutate((current) => ({
      ...current,
      objects: [
        ...current.objects.filter((entry) => entry.id !== reserved?.id),
        object,
      ],
    }));
    setSelectedId(id);
    if (keepActive) {
      repeatPlacement.current = true;
      setMode(requestedMode);
      setMessage(
        `Placed ${requestedMode.kind === "rack" ? requestedMode.skuId : object.catalogId}. Keep holding Shift to place another.`,
      );
    } else {
      repeatPlacement.current = false;
      setMode(null);
    }
  };

  const moveObject = (id: string, x: number, z: number) => {
    const object = draft.objects.find((entry) => entry.id === id);
    if (object?.x === x && object.z === z) return;
    if (!object || previewObjectMove(object, x, z) === "invalid") {
      setMessage(
        "Move blocked: the rack footprint collides with the room or another asset.",
      );
      return;
    }
    mutate((current) => ({
      ...current,
      objects: current.objects.map((entry) =>
        entry.id === id ? { ...entry, x, z } : entry,
      ),
    }));
  };

  const applyStrategy = (strategy: HallAutoLayoutStrategy) => {
    if (constructionProject) {
      setMessage(
        `Wait for the current ${constructionProject.stage} stage to finish before replacing the target plan.`,
      );
      return;
    }
    const delivered = inventory.filter((unit) => unit.delivered);
    const orderSku = strategyRackSku(state, strategy);
    const placeholderSku = orderSku?.id ?? delivered[0]?.skuId ?? "rack_h100";
    const plannedRackBays = Math.max(1, Math.floor(orderSku?.rackUnits ?? 1));
    const discount =
      aggregateEffects(state.player.researchUnlocked).chipDiscount ?? 0;
    const unitPrice = orderSku
      ? quoteRackOrder(orderSku, 1, { discount }).unitPrice
      : 0;
    const shell = DATA_HALL_SHELLS[layout.shellId];
    // Supply an intentionally generous search inventory. It is not capacity:
    // the first pass keeps only cabinet footprints that actually fit the
    // shell, walls, doors, and existing equipment without overlap.
    const placementSearchBudget = Math.max(
      1,
      Math.floor(
        (shell.width * shell.depth) / (3 * 5 * plannedRackBays),
      ),
    );
    const cashSearchBudget =
      unitPrice > 0 ? Math.max(0, Math.floor(state.player.cash / unitPrice)) : 0;
    const capacityInventory = [
      ...delivered,
      ...Array.from(
        { length: Math.min(placementSearchBudget, cashSearchBudget) },
        (_, index) => ({
        unitId: `\uffffspace:${String(index + 1).padStart(4, "0")}`,
        skuId: placeholderSku,
        // Phantom slots size the utilities like the SKU we are about to order,
        // but score 0 so owned hardware is always placed first.
        mw: orderSku?.mw ?? 0.012,
        networkGbps: orderSku?.networkGbps ?? 400,
        delivered: true,
        flopsPf: 0,
        rackUnits: plannedRackBays,
        }),
      ),
    ];
    const geometryPlan = autoPlanHall(
      {
        ...layout,
        ...draft,
        // A strategy preview replaces old empty reservations with a fresh
        // capacity plan instead of stacking a second reservation layer.
        objects: draft.objects.filter((object) => !object.reserved),
      },
      capacityInventory,
      strategy,
    );
    const physicallyPlacedIds = new Set(
      geometryPlan.objects.flatMap((object) =>
        object.rackUnitId ? [object.rackUnitId] : [],
      ),
    );
    // Provision only for the inventory that survived the physical-fit pass.
    // Utility equipment then competes for real floor space and any rack that
    // cannot retain power/cooling/network/access is removed from the preview.
    const plannedInventory = capacityInventory.filter(
      (unit) =>
        !unit.unitId.startsWith("\uffffspace:") ||
        physicallyPlacedIds.has(unit.unitId),
    );
    let capacityPlan = autoPlanHall(
      {
        ...layout,
        ...draft,
        objects: draft.objects.filter((object) => !object.reserved),
      },
      plannedInventory,
      strategy,
      undefined,
      { provisionUtilities: true },
    );
    // Added infrastructure is charged on Apply, so keep enough cash for the
    // provisioned utilities and spend the rest on rack orders.
    const existingIds = new Set(layout.objects.map((object) => object.id));
    const utilityCost = (candidate: DataHallLayout) =>
      candidate.objects
        .filter(
          (object) => object.kind !== "rack" && !existingIds.has(object.id),
        )
        .reduce(
          (sum, object) =>
            sum +
            (HALL_EQUIPMENT_CATALOG.find(
              (entry) => entry.id === object.catalogId,
            )?.price ??
              object.purchasePrice ??
              0),
          0,
        );
    let addedUtilityCost = utilityCost(capacityPlan);
    const maxDrafts =
      unitPrice > 0
        ? Math.max(
            0,
            Math.floor((state.player.cash - addedUtilityCost) / unitPrice),
          )
        : 0;
    const initiallyPlacedPhantoms = capacityPlan.objects.filter((object) =>
      object.rackUnitId?.startsWith("\uffffspace:"),
    );
    if (maxDrafts < initiallyPlacedPhantoms.length) {
      const fundedIds = new Set(
        initiallyPlacedPhantoms
          .slice(0, maxDrafts)
          .flatMap((object) => (object.rackUnitId ? [object.rackUnitId] : [])),
      );
      capacityPlan = autoPlanHall(
        {
          ...layout,
          ...draft,
          objects: draft.objects.filter((object) => !object.reserved),
        },
        plannedInventory.filter(
          (unit) =>
            !unit.unitId.startsWith("\uffffspace:") ||
            fundedIds.has(unit.unitId),
        ),
        strategy,
        undefined,
        { provisionUtilities: true },
      );
      addedUtilityCost = utilityCost(capacityPlan);
    }
    const phantomObjects = capacityPlan.objects.filter((object) =>
      object.rackUnitId?.startsWith("\uffffspace:"),
    );
    const spaces = phantomObjects.map((object) => {
      const suffix = object.rackUnitId!.slice("\uffffspace:".length);
      // Purchase draft: funding buys the rack into the fleet as an ordered
      // install, while the cabinet remains a ghost until hall commissioning.
      return {
        ...object,
        id: `${facilityId}:order:${suffix}`,
        rackUnitId: undefined,
        reserved: undefined,
        purchasePrice: 0,
      };
    });
    const planned = {
      ...capacityPlan,
      objects: [
        ...capacityPlan.objects.filter(
          (object) => !object.rackUnitId?.startsWith("\uffffspace:"),
        ),
        ...spaces,
      ],
    };
    mutate(() => cloneDraft(planned));
    setPreviewStrategy(strategy);
    const label = `${strategy[0].toUpperCase()}${strategy.slice(1)}`;
    const orderCount = phantomObjects.length;
    setMessage(
      orderCount > 0
        ? `${label} plan: ${orderCount}× ${orderSku?.name ?? "rack"} physically fit and can be funded (~${money(orderCount * unitPrice + addedUtilityCost)} including added utilities). Funding starts build, cabling, and commissioning.`
        : `${label} plan found no additional fundable rack footprint${orderSku ? ` — need ${money(Math.max(0, unitPrice + addedUtilityCost - state.player.cash))} more to start ordering ${orderSku.name}` : ""}.`,
    );
  };

  const apply = () => {
    const current = draftRef.current;
    if (!current) return;
    if (constructionProject) {
      setMessage(
        `This hall is already in ${constructionProject.stage}; ${constructionProject.remainingDays} day${constructionProject.remainingDays === 1 ? "" : "s"} remain.`,
      );
      return;
    }
    if (!hasDraftChanges) {
      setMessage("This hall plan is already saved and live.");
      return;
    }
    const currentAnalysis = analyzeHallLayout(
      { ...layout, ...current },
      inventory,
      hall.rackCapacity,
    );
    if (!currentAnalysis.valid) {
      setMessage(
        `Cannot apply yet: ${currentAnalysis.hardErrors[0] ?? "resolve the blocked layout items."}`,
      );
      return;
    }
    const result = applyPlan({
      facilityId,
      expectedRevision: layout.revision,
      objects: current.objects,
      walls: current.walls,
      doors: current.doors,
      preferredStrategy: current.preferredStrategy,
    });
    if (!result.ok) {
      setMessage(result.error ?? "Plan could not be applied.");
      return;
    }
    setPast([]);
    setFuture([]);
    const days = buildSchedule?.totalDays ?? 3;
    setMessage(
      `Project funded${result.netCost > 0 ? ` · ${money(result.netCost)}` : result.netCost < 0 ? ` · ${money(-result.netCost)} salvage after completion` : ""}. Build, cabling, and commissioning take about ${days} days; the live floor remains unchanged until then.`,
    );
  };

  const startPaletteDrag = (
    event: ReactDragEvent<HTMLButtonElement>,
    selection: NonNullable<PaletteMode>,
  ) => {
    if (selection.kind === "wall") return;
    const payload =
      selection.kind === "rack"
        ? serializeHallRackSkuPayload(selection.skuId)
        : serializeHallEquipmentPayload(selection.catalogId);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(HALL_PALETTE_DATA_MIME, payload);
    event.dataTransfer.setData(
      "text/plain",
      selection.kind === "rack" ? selection.skuId : selection.catalogId,
    );
    setMode(selection);
    setMessage(
      `Drag ${selection.kind === "rack" ? "rack" : "equipment"} onto a clear floor position.`,
    );
  };

  const finishPaletteDrag = () => {
    if (!repeatPlacement.current) setMode(null);
  };

  const planActionDisabled =
    !hasDraftChanges || Boolean(constructionProject) || !canSchedulePlan;
  const planActionTitle = constructionProject
    ? `Project in ${constructionProject.stage}; ${constructionProject.remainingDays} days remain`
    : !analysis.valid
      ? analysis.hardErrors[0]
      : !canAffordPlan
        ? `Need ${money(planTotalCost - state.player.cash)} more`
        : undefined;
  const planActionLabel = constructionProject
    ? `${constructionProject.stage} · ${constructionProject.remainingDays}d`
    : !hasDraftChanges
      ? "Saved"
      : !analysis.valid
        ? `Fix ${analysis.hardErrors.length} blocker${analysis.hardErrors.length === 1 ? "" : "s"}`
        : !canAffordPlan
          ? `Need ${money(planTotalCost - state.player.cash)}`
          : planTotalCost > 0
            ? `Fund project · ${money(planTotalCost)}`
            : planTotalCost < 0
              ? `Schedule · +${money(-planTotalCost)} salvage`
              : "Schedule project";
  const mobilePlanActionLabel = constructionProject
    ? `${constructionProject.stage} · ${constructionProject.remainingDays}d`
    : !hasDraftChanges
      ? "Saved"
      : !analysis.valid
        ? `Fix ${analysis.hardErrors.length}`
        : !canAffordPlan
          ? `Need ${money(planTotalCost - state.player.cash)}`
          : planTotalCost > 0
            ? `Fund · ${money(planTotalCost)}`
            : planTotalCost < 0
              ? `Schedule · +${money(-planTotalCost)}`
              : "Schedule";

  return (
    <section
      className="fixed inset-0 z-[100] flex flex-col overflow-y-auto bg-void text-bone max-[900px]:grid max-[900px]:h-[100dvh] max-[900px]:grid-rows-[minmax(7rem,1fr)_auto_minmax(6rem,36dvh)_auto] max-[900px]:overflow-hidden xl:grid xl:grid-cols-[20rem_minmax(0,1fr)_20rem] xl:grid-rows-[minmax(0,1fr)_auto] xl:overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Data Hall Editor"
    >
      <aside
        id="hall-mobile-panel-palette"
        role="tabpanel"
        aria-labelledby="hall-mobile-tab-palette"
        className={`order-2 max-h-[48vh] min-h-0 overflow-y-auto border-r border-line/80 bg-panel/95 p-4 shadow-2xl max-[900px]:order-3 max-[900px]:max-h-none max-[900px]:border-r-0 max-[900px]:p-3 ${mobileWorkspace === "palette" ? "max-[900px]:block" : "max-[900px]:hidden"} xl:order-none xl:max-h-none`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.2em] text-mint">
              Hall planner
            </p>
            <h1 className="mt-1 text-xl font-semibold">Build inventory</h1>
            <p className="mt-1 text-[0.75rem] text-muted">
              {hall.name} · 250 mm snap grid
            </p>
          </div>
          <div className="rounded-lg border border-line/70 bg-void/60 px-2 py-1 text-right">
            <span className="block font-mono text-sm font-semibold text-bone">
              {staging.length}
            </span>
            <span className="block text-[0.5625rem] uppercase tracking-wider text-muted">
              staged
            </span>
          </div>
        </div>

        {constructionProject ? (
          <div
            className="mt-4 rounded-lg border border-violet-400/45 bg-violet-400/10 p-3"
            role="status"
          >
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-violet-300">
              Floor locked · {constructionProject.stage}
            </p>
            <p className="mt-1 text-[0.75rem] leading-relaxed text-muted">
              The funded target is shown as a ghost.{" "}
              {constructionProject.remainingDays} day
              {constructionProject.remainingDays === 1 ? "" : "s"} remain before
              it replaces the live floor.
            </p>
          </div>
        ) : null}

        <label className="relative mt-4 block">
          <span className="sr-only">Search hall inventory</span>
          <MagnifyingGlass
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
            size={15}
          />
          <HudInput
            disabled={Boolean(constructionProject)}
            value={paletteSearch}
            onChange={(event) => setPaletteSearch(event.target.value)}
            placeholder="Search racks and equipment…"
            className="h-11 w-full pl-8 pr-8 text-[0.75rem] max-[900px]:h-11"
          />
          {paletteSearch ? (
            <HudButton
              type="button"
              variant="ghost"
              onClick={() => setPaletteSearch("")}
              aria-label="Clear search"
              className="absolute right-0 top-1/2 grid size-11 -translate-y-1/2 place-items-center !border-0 !p-0 text-muted"
            >
              <Backspace size={12} />
            </HudButton>
          ) : null}
        </label>

        <div
          className={`mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-[0.6875rem] max-[900px]:hidden ${shiftHeld ? "border-mint/50 bg-mint/10 text-mint" : "border-line/70 bg-void/45 text-muted"}`}
        >
          <ArrowsOutCardinal size={15} weight="duotone" />
          <span>
            {shiftHeld
              ? "Repeat placement active"
              : "Hold Shift to place multiples"}
          </span>
        </div>

        <HudButton
          type="button"
          variant="secondary"
          disabled={Boolean(constructionProject)}
          onClick={() => {
            if (constructionProject) {
              setMessage(
                "Rack designs can be changed after the active hall project commissions.",
              );
              return;
            }
            if (hasDraftChanges) {
              setMessage(
                "Fund or undo the current hall changes before opening the rack designer.",
              );
              return;
            }
            openRackDesigner(facilityId);
          }}
          className="mt-3 flex min-h-11 w-full items-center gap-3 rounded-lg border border-mint/35 bg-mint/10 px-3 py-2.5 text-left transition hover:border-mint/65 hover:bg-mint/15"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-mint text-void">
            <Cpu size={19} weight="duotone" />
          </span>
          <span className="min-w-0">
            <strong className="block text-[0.8125rem] text-bone">
              Design your own rack
            </strong>
            <span className="mt-0.5 block text-[0.625rem] leading-snug text-muted">
              Configure a custom chassis and components, then order it for this
              hall.
            </span>
          </span>
        </HudButton>

        <PaletteGroup title="Racks · buy & place">
          {visibleRackCards.length ? (
            visibleRackCards.map(({ skuId, availableCount, sku }) => (
              <RackPaletteCard
                key={skuId}
                active={mode?.kind === "rack" && mode.skuId === skuId}
                name={sku.name}
                skuId={skuId}
                count={availableCount}
                price={sku.price}
                generation={sku.generation}
                powerMw={sku.mw}
                networkGbps={
                  sku.networkGbps ?? sku.accelerator?.interconnectGbps ?? 0
                }
                custom={Boolean(sku.custom)}
                disabled={Boolean(constructionProject)}
                onClick={() => {
                  setMode({ kind: "rack", skuId });
                  setMobileWorkspace("floor");
                  setMessage(
                    "Rack selected. Tap a clear floor position to place it.",
                  );
                }}
                onDragStart={(event) =>
                  startPaletteDrag(event, { kind: "rack", skuId })
                }
                onDragEnd={finishPaletteDrag}
              />
            ))
          ) : (
            <p className="rounded-lg border border-dashed border-line/80 p-3 text-[0.75rem] text-muted">
              No rack designs match this search.
            </p>
          )}
        </PaletteGroup>
        {(["cooling", "power", "network"] as const).map((kind) => {
          const entries = HALL_EQUIPMENT_CATALOG.filter(
            (entry) =>
              entry.kind === kind &&
              (!paletteQuery ||
                `${entry.name} ${entry.id} ${kind}`
                  .toLocaleLowerCase()
                  .includes(paletteQuery)),
          );
          if (!entries.length && paletteQuery) return null;
          return (
            <PaletteGroup key={kind} title={kind}>
              <div className="grid grid-cols-2 gap-2">
                {entries.map((entry) => (
                  <EquipmentPaletteCard
                    key={entry.id}
                    kind={kind}
                    active={
                      mode?.kind === "equipment" && mode.catalogId === entry.id
                    }
                    name={entry.name}
                    price={money(entry.price)}
                    disabled={Boolean(constructionProject)}
                    onClick={() => {
                      setMode({ kind: "equipment", catalogId: entry.id });
                      setMobileWorkspace("floor");
                      setMessage(
                        `${entry.name} selected. Tap a clear floor position to place it.`,
                      );
                    }}
                    onDragStart={(event) =>
                      startPaletteDrag(event, {
                        kind: "equipment",
                        catalogId: entry.id,
                      })
                    }
                    onDragEnd={finishPaletteDrag}
                  />
                ))}
              </div>
            </PaletteGroup>
          );
        })}
        <PaletteGroup title="Walls & doors">
          <PaletteButton
            active={mode?.kind === "wall"}
            disabled={Boolean(constructionProject)}
            label="Interior wall"
            detail="$18k / cell"
            onClick={() => {
              setMode({ kind: "wall" });
              setMobileWorkspace("floor");
              setMessage("Wall tool selected. Tap its start point on the floor.");
            }}
          />
          <PaletteButton
            active={false}
            disabled={!selectedWall || Boolean(constructionProject)}
            label="Door"
            detail="Select a wall first"
            onClick={() => {
              if (!selectedWall) return;
              const door = createDoor(
                `${facilityId}:door:${idCounter.current++}`,
                selectedWall.id,
                0.5,
              );
              const current = draftRef.current;
              if (!current) return;
              const result = analyzeHallLayout(
                { ...layout, ...current, doors: [...current.doors, door] },
                inventory,
                hall.rackCapacity,
              );
              if (!result.valid) {
                setMessage(
                  `Door blocked: ${result.hardErrors[0] ?? "choose another wall."}`,
                );
                return;
              }
              mutate((current) => ({
                ...current,
                doors: [...current.doors, door],
              }));
            }}
          />
        </PaletteGroup>
      </aside>

      <main className="relative order-1 min-h-[24rem] min-w-0 flex-1 max-[900px]:min-h-0 xl:order-none xl:min-h-0">
        <DataHallEditorScene
          key={facilityId}
          layout={
            constructionProject
              ? layout
              : (planningProjection?.layout ?? editorLayout!)
          }
          analysis={constructionProject ? layout.analysis : analysis}
          selectedId={selectedId}
          mode={constructionProject ? null : mode}
          showGrid={showGrid}
          overlayMode={overlayMode}
          constructionTarget={constructionTargetLayout}
          resolveRackWidth={(skuId) => {
            try {
              return Math.max(
                1,
                resolveRackSku(skuId, state.player.rackDesigns ?? []).rackUnits,
              );
            } catch {
              return 1;
            }
          }}
          onSelect={(id) => {
            setSelectedId(id);
            if (id) setMobileWorkspace("inspect");
          }}
          onPlace={placeAt}
          onMove={moveObject}
          onPreview={previewPlacement}
          onPreviewMove={previewObjectMove}
        />
        <div className="pointer-events-none absolute left-[max(0.75rem,env(safe-area-inset-left))] top-[max(0.75rem,env(safe-area-inset-top))] flex max-w-[calc(100%-4.75rem)] items-center gap-2 rounded-lg border border-line/70 bg-void/90 px-3 py-2 font-mono text-[0.625rem] uppercase tracking-wide text-muted shadow-xl">
          <Cube size={14} className="shrink-0 text-mint" />
          {constructionProject ? (
            "Funded target shown as violet ghost · live floor stays solid"
          ) : (
            <>
              <span className="max-[900px]:hidden">
                Drag cards to build · drag floor to orbit · drag assets to move · Shift repeats · R rotates
              </span>
              <span className="hidden max-[900px]:inline">
                {mode
                  ? "Tap a clear floor position to place"
                  : "Tap an asset to inspect · drag empty floor to orbit"}
              </span>
            </>
          )}
        </div>
        <HudButton
          type="button"
          variant="ghost"
          onClick={requestClose}
          aria-label="Back to map"
          className="absolute right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] z-10 grid size-11 place-items-center rounded-lg border border-line/80 bg-void/90 text-muted shadow-xl transition hover:border-mint/50 hover:text-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/60"
        >
          <ArrowLeft size={17} />
        </HudButton>
        {previewStrategy ? (
          <div className="pointer-events-none absolute right-3 top-16 min-w-56 rounded-lg border border-mint/50 bg-void/90 px-3 py-2 shadow-xl max-[900px]:hidden">
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-mint">
              Layout preview
            </p>
            <p className="mt-1 text-sm font-semibold capitalize text-bone">
              {previewStrategy}
            </p>
            <p className="mt-1 text-[0.6875rem] text-muted">
              {
                draft.objects.filter(
                  (object) => object.kind === "rack" && object.rackUnitId,
                ).length
              }{" "}
              assigned ·{" "}
              {
                draft.objects.filter(
                  (object) =>
                    object.kind === "rack" &&
                    !object.reserved &&
                    !object.rackUnitId,
                ).length
              }{" "}
              to order ·{" "}
              {
                draft.objects.filter(
                  (object) => object.kind === "rack" && object.reserved,
                ).length
              }{" "}
              reserved cabinets
            </p>
            <p className="mt-1 font-mono text-[0.625rem] text-muted">
              {draft.objects.filter((object) => object.kind === "power").length}{" "}
              power ·{" "}
              {
                draft.objects.filter((object) => object.kind === "cooling")
                  .length
              }{" "}
              cooling ·{" "}
              {
                draft.objects.filter((object) => object.kind === "network")
                  .length
              }{" "}
              network
            </p>
            <p className="mt-1 text-[0.625rem] leading-relaxed text-muted">
              Funding buys order drafts and schedules build, cabling, and
              commissioning. Nothing in the ghost target adds capacity before
              the final test. Infrastructure cost:{" "}
              {planNetCost > 0 ? money(planNetCost) : "none"}.
            </p>
          </div>
        ) : null}
      </main>

      <HallMobileWorkspaceTabs
        active={mobileWorkspace}
        hasSelection={Boolean(selectedObject || selectedWall)}
        placementActive={Boolean(mode)}
        onChange={setMobileWorkspace}
      />

      <section
        id="hall-mobile-panel-floor"
        role="tabpanel"
        aria-labelledby="hall-mobile-tab-floor"
        className={`order-3 min-h-0 overflow-y-auto border-b border-line/80 bg-panel/98 p-3 ${mobileWorkspace === "floor" ? "hidden max-[900px]:block" : "hidden"}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-mint">
              {mode ? "Placement armed" : "Floor controls"}
            </p>
            <p className="mt-1 text-[0.6875rem] leading-snug text-muted" role="status">
              {mode
                ? mode.kind === "wall"
                  ? mode.start
                    ? "Tap the wall end point."
                    : "Tap the wall start point."
                  : "Tap a clear floor position. The placement preview turns red when blocked."
                : message}
            </p>
          </div>
          {mode ? (
            <HudButton
              type="button"
              variant="ghost"
              className="min-h-11 shrink-0 rounded-lg border border-line px-3 text-[0.75rem] text-muted hover:border-mint/45 hover:text-bone"
              onClick={() => {
                repeatPlacement.current = false;
                setMode(null);
                setMessage("Placement cancelled.");
              }}
            >
              Cancel
            </HudButton>
          ) : null}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label="Floor editing controls">
          <HudButton
            type="button"
            variant="secondary"
            className="!min-h-11"
            disabled={!past.length}
            onClick={undo}
          >
            Undo
          </HudButton>
          <HudButton
            type="button"
            variant="secondary"
            className="!min-h-11"
            disabled={!future.length}
            onClick={redo}
          >
            Redo
          </HudButton>
          <HudButton
            type="button"
            variant={showGrid ? "primary" : "secondary"}
            aria-pressed={showGrid}
            className="!min-h-11"
            onClick={() => setShowGrid((value) => !value)}
          >
            Grid
          </HudButton>
        </div>

        <p className="mt-3 font-mono text-[0.5625rem] uppercase tracking-widest text-muted">
          Diagnostic layer
        </p>
        <div
          className="mt-1 flex max-w-full gap-1.5 overflow-x-auto pb-1"
          role="group"
          aria-label="Hall diagnostic overlay"
        >
          {HALL_OVERLAYS.map((overlay) => (
            <HudButton
              key={overlay.id}
              type="button"
              variant={overlayMode === overlay.id ? "primary" : "secondary"}
              className="!min-h-11 shrink-0 whitespace-nowrap"
              aria-pressed={overlayMode === overlay.id}
              onClick={() => setOverlayMode(overlay.id)}
            >
              {overlay.label}
            </HudButton>
          ))}
        </div>

        <p className="mt-3 font-mono text-[0.5625rem] uppercase tracking-widest text-muted">
          Layout preview
        </p>
        <div className="mt-1 grid grid-cols-3 gap-2" role="group" aria-label="Automatic hall layout preview">
          {(["density", "efficiency", "resilience"] as const).map(
            (strategy) => (
              <HudButton
                key={strategy}
                type="button"
                variant={previewStrategy === strategy ? "primary" : "secondary"}
                disabled={Boolean(constructionProject)}
                className="!min-h-11 capitalize"
                aria-pressed={previewStrategy === strategy}
                onClick={() => applyStrategy(strategy)}
              >
                {strategy}
              </HudButton>
            ),
          )}
        </div>
      </section>

      <aside
        id="hall-mobile-panel-inspect"
        role="tabpanel"
        aria-labelledby="hall-mobile-tab-inspect"
        className={`order-3 max-h-[55vh] min-h-0 overflow-y-auto border-l border-line/80 bg-panel/95 p-3 max-[900px]:max-h-none max-[900px]:border-l-0 ${mobileWorkspace === "inspect" ? "max-[900px]:block" : "max-[900px]:hidden"} xl:order-none xl:max-h-none`}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-mono text-[0.625rem] uppercase tracking-widest text-mint">
              Selected
            </p>
            <h2 className="mt-1 text-base font-semibold">
              {selectedObject?.catalogId ??
                selectedWall?.id ??
                "Nothing selected"}
            </h2>
          </div>
          <HudButton
            type="button"
            variant="ghost"
            className="grid min-h-11 min-w-11 place-items-center rounded-lg text-muted hover:bg-panel-2 hover:text-bone"
            onClick={requestClose}
            aria-label="Back to map"
          >
            <ArrowLeft />
          </HudButton>
        </div>
        {selectedObject ? (
          <div className="mt-4 space-y-2 text-[0.75rem]">
            <InspectorRow
              label="Kind"
              value={
                selectedObject.reserved
                  ? "reserved rack cabinet"
                  : selectedObject.kind === "rack" && !selectedObject.rackUnitId
                    ? "rack · order draft (bought when funded)"
                    : selectedObject.kind
              }
            />
            <InspectorRow
              label="Position"
              value={`${(selectedObject.x * HALL_GRID_METERS).toFixed(2)}m, ${(selectedObject.z * HALL_GRID_METERS).toFixed(2)}m`}
            />
            <InspectorRow
              label="Rotation"
              value={`${selectedObject.rotation}°`}
            />
            <HudButton
              type="button"
              variant="secondary"
              disabled={Boolean(constructionProject)}
              className="flex !min-h-11 w-full items-center justify-center gap-2"
              onClick={rotateSelected}
            >
              <ArrowCounterClockwise size={14} />
              Rotate · R
            </HudButton>
            {!selectedObject.reserved ? (
              <HudButton
                type="button"
                variant="secondary"
                disabled={Boolean(constructionProject)}
                className="!min-h-11 w-full"
                onClick={duplicateSelected}
              >
                Duplicate
              </HudButton>
            ) : null}
            <HudButton
              type="button"
              variant="danger"
              disabled={Boolean(constructionProject)}
              className="flex !min-h-11 w-full items-center justify-center gap-2"
              onClick={removeSelected}
            >
              <Trash size={14} />
              {selectedObject.reserved
                ? "Remove reserved cabinet"
                : selectedObject.kind === "rack"
                  ? selectedObject.rackUnitId
                    ? "Return to staging"
                    : "Remove order draft"
                  : "Delete"}
            </HudButton>
          </div>
        ) : selectedWall ? (
          <div className="mt-4 space-y-2">
            <InspectorRow
              label="Wall"
              value={`${Math.abs(selectedWall.x2 - selectedWall.x1) + Math.abs(selectedWall.z2 - selectedWall.z1)} cells`}
            />
            <HudButton
              type="button"
              variant="danger"
              disabled={Boolean(constructionProject)}
              className="flex !min-h-11 w-full items-center justify-center gap-2"
              onClick={removeSelected}
            >
              <Trash size={14} />
              Delete wall
            </HudButton>
          </div>
        ) : null}
        <div
          className={`mt-4 rounded-lg border p-3 ${constructionProject ? "border-violet-400/45 bg-violet-400/10" : !hasDraftChanges ? "border-mint/35 bg-mint/5" : canSchedulePlan ? "border-line bg-void/40" : "border-danger/45 bg-danger/5"}`}
        >
          <p
            className={`font-mono text-[0.625rem] uppercase tracking-widest ${constructionProject ? "text-violet-300" : !hasDraftChanges ? "text-mint" : canSchedulePlan ? "text-muted" : "text-danger"}`}
          >
            {constructionProject
              ? `${constructionProject.stage} · ${constructionProject.remainingDays}d left`
              : !hasDraftChanges
                ? "Live layout saved"
                : !analysis.valid
                  ? `${analysis.hardErrors.length} blocker${analysis.hardErrors.length === 1 ? "" : "s"}`
                  : canAffordPlan
                      ? "Ready to fund"
                      : "Insufficient cash"}
          </p>
          <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted">
            {constructionProject
              ? "Solid assets are live; violet ghosts are the funded target. Close the editor and resume time to advance work."
              : !hasDraftChanges
                ? "Every solid placement is commissioned and live."
                : !analysis.valid
                  ? analysis.hardErrors[0]
                  : !canAffordPlan
                      ? `Need ${money(planTotalCost - state.player.cash)} more to build this infrastructure.`
                      : `Funding schedules every visible placement${planTotalCost > 0 ? ` for ${money(planTotalCost)}` : planTotalCost < 0 ? ` with ${money(-planTotalCost)} salvage paid after demolition` : " at no added cost"}${purchaseQuote.drafts > 0 ? ` and orders ${purchaseQuote.drafts} rack${purchaseQuote.drafts === 1 ? "" : "s"}` : ""}. Usable compute changes only after commissioning.${purchaseQuote.stagedFleetRackBays > 0 ? ` ${purchaseQuote.stagedFleetRackBays} inbound or unplaced rack-width units remain staged and consume no floor space.` : ""}`}
          </p>
        </div>
        <section className="mt-4 rounded-lg border border-line bg-void/35 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[0.625rem] uppercase tracking-widest text-muted">
                Physical footprint
              </p>
              <h3 className="mt-1 text-sm font-semibold text-bone">
                Placed hardware vs ghost plan
              </h3>
            </div>
            <HallFootprintMix
              installed={draftRackImpact.installed.rackBays}
              ordered={draftRackImpact.ordered.rackBays}
              planned={draftRackImpact.planned.rackBays}
            />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1 text-[0.5625rem] text-muted">
            <span>
              <i className="mr-1 inline-block size-1.5 rounded-full bg-mint" />
              {draftRackImpact.installed.rackBays} assigned rack-width
            </span>
            <span>
              <i className="mr-1 inline-block size-1.5 rounded-full bg-amber" />
              {draftRackImpact.ordered.rackBays} order-draft rack-width
            </span>
            <span>
              <i className="mr-1 inline-block size-1.5 rounded-full bg-violet-400" />
              {draftRackImpact.planned.rackBays} reserved rack-width
            </span>
            <span>
              <i className="mr-1 inline-block size-1.5 rounded-full bg-line" />
              {purchaseQuote.stagedFleetRackBays} staged off-floor
            </span>
          </div>
          <p className="mt-2 text-[0.5625rem] leading-relaxed text-muted">
            There is no shell bay quota. Additional racks fit only when their
            drawn footprints do not collide and retain service access, power,
            cooling, and network routes.
          </p>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-x-2 border-b border-line/70 pb-1 font-mono text-[0.5625rem] uppercase tracking-wider text-muted">
            <span>Resource</span>
            <span>Have</span>
            <span>With plan</span>
          </div>
          <CapacityImpactRow
            label="Compute"
            current={savedRackImpact.installed.flopsPf}
            withPlan={planCapacity.flopsPf}
            format={(value) => `${num(value, 1)} PF`}
          />
          <CapacityImpactRow
            label="VRAM"
            current={savedRackImpact.installed.vramGb}
            withPlan={planCapacity.vramGb}
            format={formatCapacityVram}
          />
          <CapacityImpactRow
            label="Rack power"
            current={savedRackImpact.installed.mw}
            withPlan={planCapacity.mw}
            format={mw}
          />
          <CapacityImpactRow
            label="Serve rate"
            current={savedRackImpact.installed.tokPerSec}
            withPlan={planCapacity.tokPerSec}
            format={formatServeRate}
          />
          <p className="mt-2 text-[0.625rem] leading-relaxed text-muted">
            Planned capacity assumes each empty cabinet is populated with its
            assigned rack profile. Effective compute at this layout is{" "}
            {num(planCapacity.flopsPf * analysis.throughputMultiplier, 1)} PF.
          </p>
        </section>
        <section className="mt-4 rounded-lg border border-line bg-void/35 p-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="font-mono text-[0.625rem] uppercase tracking-widest text-muted">
                Plan impact
              </p>
              <h3 className="mt-1 text-sm font-semibold text-bone">
                Live → commissioned
              </h3>
            </div>
            {buildSchedule && !constructionProject ? (
              <span className="rounded-full border border-violet-400/40 bg-violet-400/10 px-2 py-1 font-mono text-[0.625rem] text-violet-300">
                ~{buildSchedule.totalDays} days
              </span>
            ) : null}
          </div>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-2 border-b border-line/70 pb-1 font-mono text-[0.5625rem] uppercase tracking-wider text-muted">
            <span>Outcome</span>
            <span>Live</span>
            <span>Plan</span>
          </div>
          <PlanDeltaRow
            label="Throughput"
            live={`${Math.round(layout.analysis.throughputMultiplier * 100)}%`}
            planned={`${Math.round(analysis.throughputMultiplier * 100)}%`}
          />
          <PlanDeltaRow
            label="PUE factor"
            live={layout.analysis.pueMultiplier.toFixed(2)}
            planned={analysis.pueMultiplier.toFixed(2)}
            lowerIsBetter
          />
          <PlanDeltaRow
            label="Service access"
            live={`${Math.round((layout.analysis.accessScore ?? 1) * 100)}%`}
            planned={`${Math.round((analysis.accessScore ?? 1) * 100)}%`}
          />
          <PlanDeltaRow
            label="Redundancy"
            live={`${Math.round((layout.analysis.redundancyScore ?? 0) * 100)}%`}
            planned={`${Math.round((analysis.redundancyScore ?? 0) * 100)}%`}
          />
          <PlanDeltaRow
            label="Infra opex"
            live={`${money(liveOpexDay)}/day`}
            planned={`${money(plannedOpexDay)}/day`}
            lowerIsBetter
          />
        </section>

        {constructionProject ? (
          <ConstructionTimeline project={constructionProject} />
        ) : buildSchedule && hasDraftChanges ? (
          <ConstructionPreview schedule={buildSchedule} />
        ) : null}

        <div className="mt-5 border-t border-line pt-3">
          <p className="font-mono text-[0.625rem] uppercase tracking-widest text-muted">
            {constructionProject ? "Commissioned target" : "Operations"}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Metric
              label="Online"
              value={`${analysis.operationalRackUnitIds.length}`}
              good
            />
            <Metric
              label="Offline"
              value={`${analysis.offlineRackUnitIds.length}`}
              warning={analysis.offlineRackUnitIds.length > 0}
            />
            <Metric
              label="Access"
              value={`${Math.round((analysis.accessScore ?? 1) * 100)}%`}
              good={(analysis.accessScore ?? 1) >= 0.9}
              warning={(analysis.accessScore ?? 1) < 0.75}
            />
            <Metric
              label="Redundancy"
              value={`${Math.round((analysis.redundancyScore ?? 0) * 100)}%`}
              good={(analysis.redundancyScore ?? 0) >= 0.75}
              warning={(analysis.redundancyScore ?? 0) < 0.4}
            />
            <Metric
              label="Power load"
              value={`${Math.round((analysis.powerUtilization ?? 0) * 100)}%`}
              warning={(analysis.powerUtilization ?? 0) > 0.9}
            />
            <Metric
              label="Cooling load"
              value={`${Math.round((analysis.coolingUtilization ?? 0) * 100)}%`}
              warning={(analysis.coolingUtilization ?? 0) > 0.9}
            />
            <Metric
              label="Network load"
              value={`${Math.round((analysis.networkUtilization ?? 0) * 100)}%`}
              warning={(analysis.networkUtilization ?? 0) > 0.9}
            />
            <Metric
              label="Throughput"
              value={`${Math.round(analysis.throughputMultiplier * 100)}%`}
              good={analysis.throughputMultiplier >= 0.95}
            />
          </div>
        </div>
        {analysis.bottlenecks?.length ? (
          <Validation
            title="Bottlenecks"
            items={analysis.bottlenecks.map((entry) => entry.message)}
            danger={analysis.bottlenecks.some(
              (entry) => entry.severity === "critical",
            )}
          />
        ) : null}
        {analysis.hardErrors.length ? (
          <Validation title="Blocked" items={analysis.hardErrors} danger />
        ) : null}
        {analysis.warnings.length ? (
          <Validation title="Warnings" items={analysis.warnings} />
        ) : null}
      </aside>

      <footer className="order-4 flex min-h-[4.5rem] flex-wrap items-center gap-2 border-t border-line/80 bg-panel px-3 py-2 max-[900px]:sticky max-[900px]:bottom-0 max-[900px]:z-30 max-[900px]:min-h-0 max-[900px]:pl-[max(0.75rem,env(safe-area-inset-left))] max-[900px]:pr-[max(0.75rem,env(safe-area-inset-right))] max-[900px]:pb-[max(0.5rem,env(safe-area-inset-bottom))] xl:col-span-3 xl:order-none xl:flex-nowrap">
        <div className="hidden w-full grid-cols-[minmax(5.5rem,0.65fr)_minmax(0,1.35fr)] gap-2 max-[900px]:grid">
          <HudButton
            type="button"
            variant="secondary"
            className="!min-h-11"
            onClick={requestClose}
          >
            Done
          </HudButton>
          <HudButton
            type="button"
            variant={canSchedulePlan && !constructionProject ? "primary" : "danger"}
            className="!min-h-11 min-w-0"
            disabled={planActionDisabled}
            title={planActionTitle}
            onClick={apply}
          >
            <span className="truncate">{mobilePlanActionLabel}</span>
          </HudButton>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 max-[900px]:hidden xl:flex-nowrap">
          <HudButton
            type="button"
            variant="secondary"
            className=""
            disabled={!past.length}
            onClick={undo}
          >
            Undo
          </HudButton>
          <HudButton
            type="button"
            variant="secondary"
            className=""
            disabled={!future.length}
            onClick={redo}
          >
            Redo
          </HudButton>
          <HudButton
            type="button"
            variant={showGrid ? "primary" : "secondary"}
            aria-pressed={showGrid}
            className="flex items-center gap-1.5"
            onClick={() => setShowGrid((value) => !value)}
          >
            <SquaresFour size={14} />
            Grid
          </HudButton>
          <div className="mx-2 h-7 w-px bg-line" />
          <div
            className="flex max-w-full items-center gap-1 overflow-x-auto"
            role="group"
            aria-label="Hall diagnostic overlay"
          >
            {HALL_OVERLAYS.map((overlay) => (
              <HudButton
                key={overlay.id}
                type="button"
                variant={overlayMode === overlay.id ? "primary" : "secondary"}
                className="whitespace-nowrap"
                aria-pressed={overlayMode === overlay.id}
                title={overlay.description}
                onClick={() => setOverlayMode(overlay.id)}
              >
                {overlay.label}
              </HudButton>
            ))}
          </div>
          <div className="mx-2 hidden h-7 w-px bg-line 2xl:block" />
          <span className="font-mono text-[0.625rem] uppercase tracking-wider text-muted">
            Preview
          </span>
          {(["density", "efficiency", "resilience"] as const).map(
            (strategy) => (
              <HudButton
                key={strategy}
                type="button"
                variant={previewStrategy === strategy ? "primary" : "secondary"}
                disabled={Boolean(constructionProject)}
                className="capitalize"
                aria-pressed={previewStrategy === strategy}
                onClick={() => applyStrategy(strategy)}
              >
                {strategy}
              </HudButton>
            ),
          )}
          <p
            className="ml-auto max-w-[30rem] text-[0.6875rem] leading-tight text-muted"
            role="status"
          >
            {message}
          </p>
          <HudButton
            type="button"
            variant="secondary"
            className=""
            onClick={requestClose}
          >
            Done
          </HudButton>
          <HudButton
            type="button"
            variant={canSchedulePlan && !constructionProject ? "primary" : "danger"}
            className="min-w-40"
            disabled={planActionDisabled}
            title={planActionTitle}
            onClick={apply}
          >
            {planActionLabel}
          </HudButton>
        </div>
      </footer>
    </section>
  );
}

function PaletteGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-4">
      <h2 className="mb-2 font-mono text-[0.625rem] uppercase tracking-widest text-muted">
        {title}
      </h2>
      <div className="space-y-1">{children}</div>
    </section>
  );
}
function PaletteButton({
  label,
  detail,
  active,
  disabled,
  onClick,
}: {
  label: string;
  detail?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <HudButton
      type="button"
      variant={active ? "primary" : "ghost"}
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-11 w-full items-center justify-between border px-2 text-left text-[0.75rem] ${active ? "border-mint bg-mint/10 text-mint" : "border-line bg-void/40 text-bone hover:border-mint/40"} disabled:opacity-40`}
    >
      <span className="truncate">{label}</span>
      <span className="ml-2 shrink-0 font-mono text-[0.625rem] text-muted">
        {detail}
      </span>
    </HudButton>
  );
}
function RackPaletteCard({
  name,
  skuId,
  count,
  price,
  generation,
  powerMw,
  networkGbps,
  custom,
  active,
  disabled,
  onClick,
  onDragStart,
  onDragEnd,
}: {
  name: string;
  skuId: string;
  count: number;
  price: number;
  generation: number;
  powerMw: number;
  networkGbps: number;
  custom: boolean;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
}) {
  return (
    <HudButton
      type="button"
      variant="ghost"
      disabled={disabled}
      draggable={!disabled}
      aria-pressed={active}
      onClick={onClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`group flex w-full items-stretch overflow-hidden rounded-lg border text-left transition disabled:cursor-not-allowed disabled:opacity-45 ${active ? "border-mint bg-mint/10 ring-2 ring-mint/20" : "border-line/75 bg-void/45 hover:border-mint/40 hover:bg-panel-2/80"}`}
      title={
        disabled
          ? "Wait for the active hall project to commission"
          : "Click to place or drag onto the hall floor — buys new units when nothing is staged"
      }
    >
      <RackCardVisual skuId={skuId} generation={generation} custom={custom} />
      <span className="min-w-0 flex-1 px-2.5 py-2">
        <span className="flex items-start justify-between gap-2">
          <span className="truncate text-[0.8125rem] font-semibold text-bone">
            {name}
          </span>
          {count > 0 ? (
            <span className="rounded bg-mint/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-mint">
              ×{count} staged
            </span>
          ) : (
            <span className="rounded bg-amber/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-amber">
              {money(price)}
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[0.5625rem] uppercase tracking-wider text-muted">
          {custom ? "Custom design" : `Generation ${generation}`}
        </span>
        <span className="mt-1.5 flex gap-2 font-mono text-[0.5625rem] text-muted">
          <span>{Math.round(powerMw * 1_000)} kW</span>
          <span>
            {networkGbps >= 1_000
              ? `${(networkGbps / 1_000).toFixed(1)}T`
              : `${Math.round(networkGbps)}G`}
          </span>
        </span>
      </span>
    </HudButton>
  );
}
function RackCardVisual({
  skuId,
  generation,
  custom,
}: {
  skuId: string;
  generation: number;
  custom: boolean;
}) {
  const hue =
    [...skuId].reduce(
      (sum, char) => sum + char.charCodeAt(0),
      custom ? 280 : 165,
    ) % 360;
  return (
    <span
      aria-hidden="true"
      className="relative m-2 mr-0 block h-[4.1rem] w-11 shrink-0 overflow-hidden rounded border border-white/15 bg-void shadow-inner"
      style={{
        boxShadow: `inset 0 0 0 1px hsl(${hue} 55% 45% / .18), 0 6px 16px color-mix(in srgb, var(--color-void) 55%, transparent)`,
      }}
    >
      <span className="absolute inset-x-1 top-1 h-1 rounded-sm bg-white/10" />
      {Array.from({ length: Math.min(7, 3 + generation) }, (_, index) => (
        <span
          key={index}
          className="absolute left-1 right-1 h-[4px] rounded-[1px] bg-panel-2 ring-1 ring-black/70"
          style={{ top: `${12 + index * 7}px` }}
        >
          <span
            className="absolute right-0.5 top-1/2 size-0.5 -translate-y-1/2 rounded-full"
            style={{
              backgroundColor: `hsl(${hue} 80% 65%)`,
              boxShadow: `0 0 4px hsl(${hue} 80% 55%)`,
            }}
          />
        </span>
      ))}
      <span className="absolute bottom-1 left-1 right-1 h-1 rounded-sm bg-black/60" />
    </span>
  );
}
function EquipmentPaletteCard({
  kind,
  name,
  price,
  active,
  disabled,
  onClick,
  onDragStart,
  onDragEnd,
}: {
  kind: "cooling" | "power" | "network";
  name: string;
  price: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
}) {
  const Icon =
    kind === "cooling" ? Snowflake : kind === "power" ? Cube : HardDrives;
  return (
    <HudButton
      type="button"
      variant="ghost"
      disabled={disabled}
      draggable={!disabled}
      aria-pressed={active}
      onClick={onClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`min-h-20 rounded-lg border p-2 text-left transition disabled:cursor-not-allowed disabled:opacity-45 ${active ? "border-mint bg-mint/10 ring-2 ring-mint/20" : "border-line/75 bg-void/45 hover:border-mint/40 hover:bg-panel-2/80"}`}
      title={
        disabled
          ? "Wait for the active hall project to commission"
          : "Click to place or drag onto the hall floor"
      }
    >
      <Icon
        size={19}
        weight="duotone"
        className={
          kind === "power"
            ? "text-amber"
            : kind === "cooling"
              ? "text-cyan-300"
              : "text-violet-300"
        }
      />
      <span className="mt-2 block text-[0.6875rem] font-semibold leading-tight text-bone">
        {name}
      </span>
      <span className="mt-1 block font-mono text-[0.5625rem] text-muted">
        {price}
      </span>
    </HudButton>
  );
}
function InspectorRow({ label, value }: { label: string; value: string }) {
  return <StatRow label={label} value={value} />;
}
function Metric({
  label,
  value,
  good,
  warning,
}: {
  label: string;
  value: string;
  good?: boolean;
  warning?: boolean;
}) {
  return <MetricTile label={label} value={value} tone={warning ? "warning" : good ? "positive" : "neutral"} />;
}
function PlanDeltaRow({
  label,
  live,
  planned,
  lowerIsBetter: _lowerIsBetter,
}: {
  label: string;
  live: string;
  planned: string;
  lowerIsBetter?: boolean;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-2 border-b border-line/50 py-1.5 text-[0.6875rem]">
      <span className="text-muted">{label}</span>
      <span className="font-mono text-muted">{live}</span>
      <span className="font-mono text-bone">{planned}</span>
    </div>
  );
}
function ConstructionPreview({
  schedule,
}: {
  schedule: ReturnType<typeof scheduleHallConstruction>;
}) {
  return (
    <section className="mt-4 rounded-lg border border-violet-400/35 bg-violet-400/5 p-3">
      <p className="font-mono text-[0.625rem] uppercase tracking-widest text-violet-300">
        Delivery plan · {schedule.totalDays} days
      </p>
      <div className="mt-3 grid grid-cols-3 gap-1">
        <ConstructionStage label="Build" days={schedule.stageDays.build} />
        <ConstructionStage label="Cable" days={schedule.stageDays.cabling} />
        <ConstructionStage
          label="Test"
          days={schedule.stageDays.commissioning}
        />
      </div>
      <p className="mt-2 text-[0.625rem] leading-relaxed text-muted">
        Funding creates a ghost project. The current floor keeps serving until
        the target passes commissioning.
      </p>
    </section>
  );
}
function ConstructionTimeline({
  project,
}: {
  project: DataHallConstructionProject;
}) {
  const elapsed = Math.max(0, project.totalDays - project.remainingDays);
  const progress = Math.max(
    0,
    Math.min(
      100,
      project.totalDays > 0 ? (elapsed / project.totalDays) * 100 : 100,
    ),
  );
  return (
    <section
      className="mt-4 rounded-lg border border-violet-400/45 bg-violet-400/10 p-3"
      aria-label="Active hall construction"
    >
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[0.625rem] uppercase tracking-widest text-violet-300">
            Active project
          </p>
          <h3 className="mt-1 text-sm font-semibold capitalize text-bone">
            {project.stage}
          </h3>
        </div>
        <strong className="font-mono text-sm text-violet-200">
          {project.remainingDays}d left
        </strong>
      </div>
      <MeterBar
        label="Progress"
        value={progress / 100}
        detail={`${Math.round(progress)}%`}
        tone="research"
        live
      />
      <div className="mt-3 grid grid-cols-3 gap-1">
        <ConstructionStage
          label="Build"
          days={project.stageDays.build}
          active={project.stage === "build"}
        />
        <ConstructionStage
          label="Cable"
          days={project.stageDays.cabling}
          active={project.stage === "cabling"}
        />
        <ConstructionStage
          label="Test"
          days={project.stageDays.commissioning}
          active={project.stage === "commissioning"}
        />
      </div>
      <p className="mt-2 text-[0.625rem] leading-relaxed text-muted">
        Committed {money(Math.max(0, project.totalCost))}. Target equipment
        remains non-operational until the final test completes. Close the editor
        and resume time to advance work.
      </p>
    </section>
  );
}
function ConstructionStage({
  label,
  days,
  active,
}: {
  label: string;
  days: number;
  active?: boolean;
}) {
  return (
    <div
      className={`rounded border px-2 py-1.5 ${active ? "border-violet-300/60 bg-violet-300/10 text-violet-200" : "border-line/70 bg-void/40 text-muted"}`}
    >
      <span className="block text-[0.5625rem] uppercase tracking-wider">
        {label}
      </span>
      <strong className="mt-0.5 block font-mono text-[0.6875rem]">
        {days}d
      </strong>
    </div>
  );
}
function formatCapacityVram(value: number) {
  return value >= 1_024 ? `${num(value / 1_024, 1)} TB` : `${num(value, 0)} GB`;
}
function formatServeRate(value: number) {
  return value >= 1_000_000
    ? `${num(value / 1_000_000, 1)}M tok/s`
    : value >= 1_000
      ? `${num(value / 1_000, 1)}k tok/s`
      : `${num(value, 0)} tok/s`;
}
function CapacityImpactRow({
  label,
  current,
  withPlan,
  format,
}: {
  label: string;
  current: number;
  withPlan: number;
  format: (value: number) => string;
}) {
  const delta = withPlan - current;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 border-b border-line/50 py-1.5 text-[0.6875rem]">
      <span className="truncate text-muted">{label}</span>
      <span className="font-mono text-bone">{format(current)}</span>
      <span className="text-right font-mono text-mint">
        <strong className="block font-medium">{format(withPlan)}</strong>
        <small className="block text-[0.5rem] text-muted">
          {Math.abs(delta) < 1e-9
            ? "no change"
            : `${delta > 0 ? "+" : ""}${format(delta)}`}
        </small>
      </span>
    </div>
  );
}
function HallFootprintMix({
  installed,
  ordered,
  planned,
}: {
  installed: number;
  ordered: number;
  planned: number;
}) {
  const footprint = installed + ordered + planned;
  return (
    <ResponsiveDonut
      slices={[
        { id: "installed", label: "Assigned", value: installed, color: "var(--color-mint)" },
        { id: "ordered", label: "Order draft", value: ordered, color: "var(--color-amber)" },
        { id: "planned", label: "Reserved", value: planned, color: "var(--color-research)" },
      ]}
      centerLabel={String(footprint)}
      caption="placed"
      ariaLabel={`${installed} assigned, ${ordered} order-draft, and ${planned} reserved rack-width units physically drawn in this plan`}
      valueFormatter={(value) => String(value)}
      className="max-w-[6rem]"
    />
  );
}
function Validation({
  title,
  items,
  danger,
}: {
  title: string;
  items: string[];
  danger?: boolean;
}) {
  return (
    <div className="mt-4">
      <p className="mb-1 font-mono text-[0.625rem] uppercase tracking-widest text-muted">{title}</p>
      <BlockerList
        items={items.slice(0, 6).map((item) => ({
          text: item,
          tone: danger ? "danger" : "warning",
        }))}
      />
    </div>
  );
}

function DataHallEditorScene({
  layout,
  analysis,
  selectedId,
  mode,
  showGrid,
  overlayMode,
  constructionTarget,
  resolveRackWidth,
  onSelect,
  onPlace,
  onMove,
  onPreview,
  onPreviewMove,
}: {
  layout: DataHallLayout;
  analysis: ReturnType<typeof analyzeHallLayout>;
  selectedId: string | null;
  mode: PaletteMode;
  showGrid: boolean;
  overlayMode: HallOverlayMode;
  constructionTarget?: DataHallLayout | null;
  resolveRackWidth: (skuId: string) => number;
  onSelect: (id: string | null) => void;
  onPlace: (
    x: number,
    z: number,
    keepActive?: boolean,
    requestedMode?: PaletteMode,
  ) => void;
  onMove: (id: string, x: number, z: number) => void;
  onPreview: (
    mode: NonNullable<PaletteMode>,
    x: number,
    z: number,
  ) => "valid" | "warning" | "invalid";
  onPreviewMove: (
    object: DataHallObjectPlacement,
    x: number,
    z: number,
  ) => "valid" | "warning" | "invalid";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectorRef = useRef<THREE.Mesh | null>(null);
  const renderRef = useRef<() => void>(() => undefined);
  const viewStateRef = useRef<{
    position: THREE.Vector3;
    target: THREE.Vector3;
    zoom: number;
  } | null>(null);
  const modeRef = useRef(mode);
  const handlersRef = useRef({
    onSelect,
    onPlace,
    onMove,
    onPreview,
    onPreviewMove,
  });
  modeRef.current = mode;
  handlersRef.current = { onSelect, onPlace, onMove, onPreview, onPreviewMove };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    } catch {
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    // Three.js maps the deprecated soft variant back to PCF and logs on every
    // editor mount. Use the supported map explicitly for identical runtime
    // behavior without flooding mobile diagnostics.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const shell = DATA_HALL_SHELLS[layout.shellId];
    const widthM = shell.width * HALL_GRID_METERS;
    const depthM = shell.depth * HALL_GRID_METERS;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070b10);
    scene.add(new THREE.HemisphereLight(0xb8dfff, 0x10141a, 2.2));
    const light = new THREE.DirectionalLight(0xffffff, 2.6);
    light.position.set(8, 16, 10);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    scene.add(light);
    const aspect =
      Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight);
    const view = Math.max(widthM, depthM) * 0.52;
    const camera = new THREE.OrthographicCamera(
      -view * aspect,
      view * aspect,
      view,
      -view,
      0.1,
      300,
    );
    const savedView = viewStateRef.current;
    if (savedView) {
      camera.position.copy(savedView.position);
      camera.zoom = savedView.zoom;
    } else {
      camera.position.set(
        widthM * 0.5,
        Math.max(widthM, depthM) * 1.12,
        depthM * 0.62,
      );
    }
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.target.copy(savedView?.target ?? new THREE.Vector3(0, 0, 0));
    controls.minZoom = 0.55;
    controls.maxZoom = 4;
    camera.lookAt(controls.target);
    camera.updateProjectionMatrix();
    const materials = {
      rack: new THREE.MeshStandardMaterial({
        color: 0x15232d,
        metalness: 0.72,
        roughness: 0.35,
        emissive: 0x0a3140,
        emissiveIntensity: 0.22,
      }),
      cooling: new THREE.MeshStandardMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
      power: new THREE.MeshStandardMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
      network: new THREE.MeshStandardMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    };
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(widthM, 0.12, depthM),
      new THREE.MeshStandardMaterial({ color: 0x111820, roughness: 0.92 }),
    );
    floor.position.y = -0.08;
    floor.name = "floor";
    floor.receiveShadow = true;
    scene.add(floor);
    if (showGrid) {
      const fineGrid = new THREE.GridHelper(
        widthM,
        shell.width,
        0x32798a,
        0x264754,
      );
      fineGrid.scale.z = depthM / widthM;
      fineGrid.position.y = 0.004;
      scene.add(fineGrid);
      const majorGrid = new THREE.GridHelper(
        widthM,
        Math.max(1, Math.round(shell.width / 4)),
        0x59c8d0,
        0x3a7480,
      );
      majorGrid.scale.z = depthM / widthM;
      majorGrid.position.y = 0.009;
      scene.add(majorGrid);
    }
    const wallMaterial = new THREE.MeshStandardMaterial({
      color: 0x2c3741,
      roughness: 0.75,
    });
    const wallMeshes: THREE.Mesh[] = [];
    const addWall = (
      length: number,
      thickness: number,
      x: number,
      z: number,
      horizontal: boolean,
      height = 2.4,
      selectionId?: string,
    ) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(
          horizontal ? length : thickness,
          height,
          horizontal ? thickness : length,
        ),
        wallMaterial,
      );
      mesh.position.set(x, height / 2, z);
      if (selectionId) {
        mesh.userData.selectionId = selectionId;
        wallMeshes.push(mesh);
      }
      scene.add(mesh);
      return mesh;
    };
    const exteriorLeftLength = shell.exteriorDoor.x * HALL_GRID_METERS;
    const exteriorRightStart =
      (shell.exteriorDoor.x + shell.exteriorDoor.width) * HALL_GRID_METERS;
    const exteriorRightLength = Math.max(0, widthM - exteriorRightStart);
    if (exteriorLeftLength > 0)
      addWall(
        exteriorLeftLength,
        0.18,
        -widthM / 2 + exteriorLeftLength / 2,
        -depthM / 2,
        true,
      );
    if (exteriorRightLength > 0)
      addWall(
        exteriorRightLength,
        0.18,
        -widthM / 2 + exteriorRightStart + exteriorRightLength / 2,
        -depthM / 2,
        true,
      );
    addWall(widthM, 0.18, 0, depthM / 2, true);
    addWall(depthM, 0.18, -widthM / 2, 0, false);
    addWall(depthM, 0.18, widthM / 2, 0, false);
    for (const wall of layout.walls)
      for (const span of splitHallWallAroundDoors(wall, layout.doors)) {
        const horizontal = span.z1 === span.z2;
        const length =
          (Math.abs(span.x2 - span.x1) + Math.abs(span.z2 - span.z1)) *
          HALL_GRID_METERS;
        addWall(
          length,
          0.12,
          ((span.x1 + span.x2) / 2) * HALL_GRID_METERS - widthM / 2,
          ((span.z1 + span.z2) / 2) * HALL_GRID_METERS - depthM / 2,
          horizontal,
          2.1,
          wall.id,
        );
      }
    const exteriorThreshold = new THREE.Mesh(
      new THREE.BoxGeometry(
        shell.exteriorDoor.width * HALL_GRID_METERS,
        0.02,
        0.5,
      ),
      new THREE.MeshBasicMaterial({
        color: 0x48d7d1,
        transparent: true,
        opacity: 0.7,
      }),
    );
    exteriorThreshold.position.set(
      (shell.exteriorDoor.x + shell.exteriorDoor.width / 2) * HALL_GRID_METERS -
        widthM / 2,
      0.02,
      -depthM / 2,
    );
    scene.add(exteriorThreshold);
    for (const door of layout.doors) {
      const wall = layout.walls.find(
        (candidate) => candidate.id === door.wallId,
      );
      if (!wall) continue;
      const horizontal = wall.z1 === wall.z2;
      const length = Math.abs(wall.x2 - wall.x1) + Math.abs(wall.z2 - wall.z1);
      const start = Math.round(Math.max(0, length - door.width) * door.offset);
      const x = horizontal
        ? Math.min(wall.x1, wall.x2) + start + door.width / 2
        : wall.x1;
      const z = horizontal
        ? wall.z1
        : Math.min(wall.z1, wall.z2) + start + door.width / 2;
      const marker = new THREE.Mesh(
        new THREE.BoxGeometry(
          horizontal ? door.width * HALL_GRID_METERS : 0.18,
          2,
          horizontal ? 0.22 : door.width * HALL_GRID_METERS,
        ),
        new THREE.MeshStandardMaterial({
          color: 0x48d7d1,
          emissive: 0x164b4b,
          emissiveIntensity: 0.4,
        }),
      );
      marker.position.set(
        x * HALL_GRID_METERS - widthM / 2,
        1,
        z * HALL_GRID_METERS - depthM / 2,
      );
      scene.add(marker);
    }
    const offlineRackIds = new Set(analysis.offlineRackUnitIds);
    const inaccessibleIds = new Set(analysis.inaccessibleObjectIds ?? []);
    const groups = new Map<string, DataHallObjectPlacement[]>();
    for (const object of layout.objects) {
      const list = groups.get(object.kind) ?? [];
      list.push(object);
      groups.set(object.kind, list);
    }
    const meshes: THREE.InstancedMesh[] = [];
    const objectDims = (object: DataHallObjectPlacement) => {
      const base =
        object.kind === "rack"
          ? { width: 3 * resolveRackWidth(object.catalogId), depth: 5 }
          : (HALL_EQUIPMENT_CATALOG.find(
              (entry) => entry.id === object.catalogId,
            ) ?? { width: 1, depth: 1 });
      return object.rotation === 90 || object.rotation === 270
        ? { width: base.depth, depth: base.width }
        : { width: base.width, depth: base.depth };
    };
    for (const [kind, objects] of groups) {
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const mesh = new THREE.InstancedMesh(
        geometry,
        materials[kind as keyof typeof materials],
        objects.length,
      );
      mesh.userData.objectIds = objects.map((object) => object.id);
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      objects.forEach((object, index) => {
        const d = objectDims(object);
        position.set(
          (object.x + d.width / 2) * HALL_GRID_METERS - widthM / 2,
          object.kind === "rack" ? 1.05 : 0.75,
          (object.z + d.depth / 2) * HALL_GRID_METERS - depthM / 2,
        );
        scale.set(
          d.width * HALL_GRID_METERS,
          object.kind === "rack" ? 2.1 : 1.5,
          d.depth * HALL_GRID_METERS,
        );
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(index, matrix);
      });
      mesh.castShadow = kind === "rack";
      mesh.receiveShadow = kind === "rack";
      scene.add(mesh);
      meshes.push(mesh);
      if (kind !== "rack") {
        objects.forEach((object) => {
          const def = HALL_EQUIPMENT_CATALOG.find(
            (entry) => entry.id === object.catalogId,
          );
          if (!def) return;
          const d = objectDims(object);
          const model = createHallEquipmentModel({
            kind: kind as "cooling" | "power" | "network",
            width: def.width * HALL_GRID_METERS,
            depth: def.depth * HALL_GRID_METERS,
            height: 1.5,
            offline: inaccessibleIds.has(object.id),
          });
          model.position.set(
            (object.x + d.width / 2) * HALL_GRID_METERS - widthM / 2,
            0,
            (object.z + d.depth / 2) * HALL_GRID_METERS - depthM / 2,
          );
          model.rotation.y = THREE.MathUtils.degToRad(object.rotation);
          scene.add(model);
        });
      }
      if (kind === "rack") {
        const frontMaterial = new THREE.MeshStandardMaterial({
          color: 0x070b0e,
          metalness: 0.82,
          roughness: 0.28,
        });
        const frontPanels = new THREE.InstancedMesh(
          new THREE.BoxGeometry(1, 1, 1),
          frontMaterial,
          objects.length,
        );
        const slotMaterial = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          emissive: 0x123a3a,
          emissiveIntensity: 0.42,
          metalness: 0.55,
          roughness: 0.3,
        });
        const slotCount = 7;
        const installedRackCount = objects.filter(
          (object) => !object.reserved,
        ).length;
        const serverSlots = new THREE.InstancedMesh(
          new THREE.BoxGeometry(1, 1, 1),
          slotMaterial,
          installedRackCount * slotCount,
        );
        const railMaterial = new THREE.MeshStandardMaterial({
          color: 0x32434e,
          metalness: 0.9,
          roughness: 0.24,
        });
        const mountingRails = new THREE.InstancedMesh(
          new THREE.BoxGeometry(1, 1, 1),
          railMaterial,
          objects.length * 2,
        );
        const statusMaterial = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          emissive: 0xffffff,
          emissiveIntensity: 0.65,
          metalness: 0.35,
          roughness: 0.3,
        });
        const statusBars = new THREE.InstancedMesh(
          new THREE.BoxGeometry(1, 1, 1),
          statusMaterial,
          objects.length,
        );
        let slotIndex = 0;
        let railIndex = 0;
        objects.forEach((object, index) => {
          const d = objectDims(object);
          const cx = (object.x + d.width / 2) * HALL_GRID_METERS - widthM / 2;
          const cz = (object.z + d.depth / 2) * HALL_GRID_METERS - depthM / 2;
          const frontOnX = object.rotation === 90 || object.rotation === 270;
          const direction =
            object.rotation === 180 || object.rotation === 270 ? -1 : 1;
          const faceSpan = (frontOnX ? d.depth : d.width) * HALL_GRID_METERS;
          const faceX =
            cx +
            (frontOnX
              ? direction * ((d.width * HALL_GRID_METERS) / 2 + 0.012)
              : 0);
          const faceZ =
            cz +
            (!frontOnX
              ? direction * ((d.depth * HALL_GRID_METERS) / 2 + 0.012)
              : 0);
          const variant = rackVariantSeed(object.catalogId);
          const accent =
            object.rackUnitId && offlineRackIds.has(object.rackUnitId)
              ? new THREE.Color(0xf05252)
              : inaccessibleIds.has(object.id)
                ? new THREE.Color(0xf0ad4e)
                : object.reserved
                  ? new THREE.Color(0x5f7580)
                  : new THREE.Color().setHSL(
                      ((variant % 42) + 170) / 360,
                      0.72,
                      0.62,
                    );
          scale.set(
            frontOnX ? 0.025 : faceSpan * 0.9,
            1.82,
            frontOnX ? faceSpan * 0.9 : 0.025,
          );
          matrix.compose(
            new THREE.Vector3(faceX, 1.05, faceZ),
            quaternion,
            scale,
          );
          frontPanels.setMatrixAt(index, matrix);
          const railOffset = faceSpan * 0.4;
          for (const offset of [-railOffset, railOffset]) {
            const railX = faceX + (frontOnX ? direction * 0.02 : offset);
            const railZ = faceZ + (frontOnX ? offset : direction * 0.02);
            scale.set(frontOnX ? 0.035 : 0.045, 1.78, frontOnX ? 0.045 : 0.035);
            matrix.compose(
              new THREE.Vector3(railX, 1.05, railZ),
              quaternion,
              scale,
            );
            mountingRails.setMatrixAt(railIndex++, matrix);
          }
          if (!object.reserved) {
            for (let slot = 0; slot < slotCount; slot += 1) {
              const y = 0.35 + slot * 0.215;
              scale.set(
                frontOnX ? 0.03 : faceSpan * 0.72,
                0.075,
                frontOnX ? faceSpan * 0.72 : 0.03,
              );
              matrix.compose(
                new THREE.Vector3(
                  faceX + (frontOnX ? direction * 0.018 : 0),
                  y,
                  faceZ + (!frontOnX ? direction * 0.018 : 0),
                ),
                quaternion,
                scale,
              );
              serverSlots.setMatrixAt(slotIndex, matrix);
              serverSlots.setColorAt(
                slotIndex,
                accent.clone().multiplyScalar(0.58 + (slot % 3) * 0.12),
              );
              slotIndex += 1;
            }
          }
          scale.set(
            frontOnX ? 0.035 : faceSpan * 0.34,
            0.035,
            frontOnX ? faceSpan * 0.34 : 0.035,
          );
          matrix.compose(
            new THREE.Vector3(
              faceX + (frontOnX ? direction * 0.02 : 0),
              1.9,
              faceZ + (!frontOnX ? direction * 0.02 : 0),
            ),
            quaternion,
            scale,
          );
          statusBars.setMatrixAt(index, matrix);
          statusBars.setColorAt(index, accent);
        });
        frontPanels.instanceMatrix.needsUpdate = true;
        serverSlots.instanceMatrix.needsUpdate = true;
        if (serverSlots.instanceColor)
          serverSlots.instanceColor.needsUpdate = true;
        mountingRails.instanceMatrix.needsUpdate = true;
        statusBars.instanceMatrix.needsUpdate = true;
        if (statusBars.instanceColor)
          statusBars.instanceColor.needsUpdate = true;
        frontPanels.castShadow = true;
        serverSlots.castShadow = true;
        scene.add(frontPanels, serverSlots, mountingRails, statusBars);
      }
    }
    if (constructionTarget) {
      const sameObject = (
        left: DataHallObjectPlacement | undefined,
        right: DataHallObjectPlacement,
      ) =>
        Boolean(
          left &&
          left.kind === right.kind &&
          left.catalogId === right.catalogId &&
          left.x === right.x &&
          left.z === right.z &&
          left.rotation === right.rotation &&
          left.rackUnitId === right.rackUnitId,
        );
      const liveById = new Map(
        layout.objects.map((object) => [object.id, object]),
      );
      const targetById = new Map(
        constructionTarget.objects.map((object) => [object.id, object]),
      );
      const targetMaterial = new THREE.MeshBasicMaterial({
        color: 0xb7a1ff,
        wireframe: true,
        transparent: true,
        opacity: 0.72,
        depthTest: false,
      });
      const removalMaterial = new THREE.MeshBasicMaterial({
        color: 0xff6d73,
        wireframe: true,
        transparent: true,
        opacity: 0.68,
        depthTest: false,
      });
      const addObjectDiff = (
        object: DataHallObjectPlacement,
        material: THREE.MeshBasicMaterial,
      ) => {
        const d = objectDims(object);
        const diff = new THREE.Mesh(
          new THREE.BoxGeometry(
            d.width * HALL_GRID_METERS,
            object.kind === "rack" ? 2.12 : 1.52,
            d.depth * HALL_GRID_METERS,
          ),
          material,
        );
        diff.position.set(
          (object.x + d.width / 2) * HALL_GRID_METERS - widthM / 2,
          object.kind === "rack" ? 1.06 : 0.76,
          (object.z + d.depth / 2) * HALL_GRID_METERS - depthM / 2,
        );
        diff.renderOrder = 20;
        scene.add(diff);
      };
      for (const object of layout.objects) {
        if (!sameObject(targetById.get(object.id), object))
          addObjectDiff(object, removalMaterial);
      }
      for (const object of constructionTarget.objects) {
        if (!sameObject(liveById.get(object.id), object))
          addObjectDiff(object, targetMaterial);
      }
      const targetWallMaterial = new THREE.LineBasicMaterial({
        color: 0xb7a1ff,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
      });
      const removalWallMaterial = new THREE.LineBasicMaterial({
        color: 0xff6d73,
        transparent: true,
        opacity: 0.82,
        depthTest: false,
      });
      const doorSignature = (wallId: string, doors: DataHallLayout["doors"]) =>
        doors
          .filter((door) => door.wallId === wallId)
          .map((door) => `${door.id}:${door.offset}:${door.width}`)
          .sort()
          .join("|");
      const liveWallsById = new Map(
        layout.walls.map((wall) => [wall.id, wall]),
      );
      const targetWallsById = new Map(
        constructionTarget.walls.map((wall) => [wall.id, wall]),
      );
      const sameWallTopology = (wallId: string) => {
        const live = liveWallsById.get(wallId);
        const target = targetWallsById.get(wallId);
        return Boolean(
          live &&
          target &&
          live.x1 === target.x1 &&
          live.z1 === target.z1 &&
          live.x2 === target.x2 &&
          live.z2 === target.z2 &&
          doorSignature(wallId, layout.doors) ===
            doorSignature(wallId, constructionTarget.doors),
        );
      };
      const addWallDiff = (
        wall: DataHallLayout["walls"][number],
        doors: DataHallLayout["doors"],
        material: THREE.LineBasicMaterial,
        y: number,
      ) => {
        for (const span of splitHallWallAroundDoors(wall, doors)) {
          const points = [
            new THREE.Vector3(
              span.x1 * HALL_GRID_METERS - widthM / 2,
              y,
              span.z1 * HALL_GRID_METERS - depthM / 2,
            ),
            new THREE.Vector3(
              span.x2 * HALL_GRID_METERS - widthM / 2,
              y,
              span.z2 * HALL_GRID_METERS - depthM / 2,
            ),
          ];
          scene.add(
            new THREE.Line(
              new THREE.BufferGeometry().setFromPoints(points),
              material,
            ),
          );
        }
      };
      for (const wall of layout.walls) {
        if (!sameWallTopology(wall.id))
          addWallDiff(wall, layout.doors, removalWallMaterial, 0.12);
      }
      for (const wall of constructionTarget.walls) {
        if (!sameWallTopology(wall.id))
          addWallDiff(wall, constructionTarget.doors, targetWallMaterial, 0.18);
      }
      const sameDoor = (doorId: string) => {
        const live = layout.doors.find((door) => door.id === doorId);
        const target = constructionTarget.doors.find(
          (door) => door.id === doorId,
        );
        return Boolean(
          live &&
          target &&
          live.wallId === target.wallId &&
          live.offset === target.offset &&
          live.width === target.width,
        );
      };
      const addDoorDiff = (
        door: DataHallLayout["doors"][number],
        walls: DataHallLayout["walls"],
        color: number,
      ) => {
        const wall = walls.find((candidate) => candidate.id === door.wallId);
        if (!wall) return;
        const horizontal = wall.z1 === wall.z2;
        const length =
          Math.abs(wall.x2 - wall.x1) + Math.abs(wall.z2 - wall.z1);
        const start = Math.round(
          Math.max(0, length - door.width) * door.offset,
        );
        const x = horizontal
          ? Math.min(wall.x1, wall.x2) + start + door.width / 2
          : wall.x1;
        const z = horizontal
          ? wall.z1
          : Math.min(wall.z1, wall.z2) + start + door.width / 2;
        const marker = new THREE.Mesh(
          new THREE.BoxGeometry(
            horizontal ? door.width * HALL_GRID_METERS : 0.28,
            0.08,
            horizontal ? 0.28 : door.width * HALL_GRID_METERS,
          ),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
          }),
        );
        marker.position.set(
          x * HALL_GRID_METERS - widthM / 2,
          0.1,
          z * HALL_GRID_METERS - depthM / 2,
        );
        marker.renderOrder = 21;
        scene.add(marker);
      };
      for (const door of layout.doors) {
        if (!sameDoor(door.id)) addDoorDiff(door, layout.walls, 0xff6d73);
      }
      for (const door of constructionTarget.doors) {
        if (!sameDoor(door.id))
          addDoorDiff(door, constructionTarget.walls, 0xb7a1ff);
      }
    }
    if (overlayMode !== "construction") {
      const routeLayers: Array<
        [readonly { cells: number[] }[], THREE.LineBasicMaterial]
      > = [];
      const addRouteLayer = (
        routes: readonly { cells: number[] }[],
        color: number,
        opacity = 0.85,
      ) => {
        if (routes.length === 0) return;
        routeLayers.push([
          routes,
          new THREE.LineBasicMaterial({
            color,
            transparent: true,
            opacity,
          }),
        ]);
      };
      if (
        overlayMode === "overview" ||
        overlayMode === "risk" ||
        overlayMode === "power"
      )
        addRouteLayer(analysis.powerRoutes, 0xf2ad49);
      if (
        overlayMode === "overview" ||
        overlayMode === "risk" ||
        overlayMode === "cooling"
      )
        addRouteLayer(analysis.coolingRoutes ?? [], 0x62e6ef);
      if (
        overlayMode === "overview" ||
        overlayMode === "risk" ||
        overlayMode === "network"
      )
        addRouteLayer(analysis.networkRoutes, 0x40d9ff);
      if (overlayMode === "access")
        addRouteLayer(analysis.serviceRoutes ?? [], 0xa8e36f, 0.7);
      for (const [routes, material] of routeLayers)
        for (const route of routes) {
          const points = route.cells.map(
            (cell) =>
              new THREE.Vector3(
                ((cell % shell.width) + 0.5) * HALL_GRID_METERS - widthM / 2,
                0.06,
                (Math.floor(cell / shell.width) + 0.5) * HALL_GRID_METERS -
                  depthM / 2,
              ),
          );
          if (points.length > 1)
            scene.add(
              new THREE.Line(
                new THREE.BufferGeometry().setFromPoints(points),
                material,
              ),
            );
        }
    }
    const selector = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.08, 1),
      new THREE.MeshBasicMaterial({
        color: analysis.valid ? 0x48d7d1 : 0xff5252,
        transparent: true,
        opacity: 0.45,
      }),
    );
    selector.visible = false;
    selectorRef.current = selector;
    scene.add(selector);
    const ghostMaterial = new THREE.MeshBasicMaterial({
      color: 0x48d7d1,
      wireframe: true,
      transparent: true,
      opacity: 0.85,
    });
    const ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), ghostMaterial);
    ghost.visible = false;
    scene.add(ghost);
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let dragging: string | null = null;
    const hitPoint = (event: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObject(floor)[0]?.point;
    };
    const objectHit = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(
        [...meshes, ...wallMeshes],
        false,
      )[0];
      const ids = hit?.object.userData.objectIds as string[] | undefined;
      if (hit?.instanceId != null) return ids?.[hit.instanceId] ?? null;
      return typeof hit?.object.userData.selectionId === "string"
        ? hit.object.userData.selectionId
        : null;
    };
    const pointToCell = (point: THREE.Vector3) => ({
      x: Math.max(
        0,
        Math.min(
          shell.width - 1,
          Math.floor((point.x + widthM / 2) / HALL_GRID_METERS),
        ),
      ),
      z: Math.max(
        0,
        Math.min(
          shell.depth - 1,
          Math.floor((point.z + depthM / 2) / HALL_GRID_METERS),
        ),
      ),
    });
    const preview = (event: { clientX: number; clientY: number }) => {
      const point = hitPoint(event);
      if (!point) {
        ghost.visible = false;
        return;
      }
      const cell = pointToCell(point);
      const draggingObject = dragging
        ? layout.objects.find((entry) => entry.id === dragging)
        : undefined;
      const activeMode = modeRef.current;
      if (!draggingObject && !activeMode) {
        ghost.visible = false;
        return;
      }
      const reservedAtCell =
        activeMode?.kind === "rack"
          ? reservedRackAtCell(layout, cell.x, cell.z)
          : undefined;
      const previewObject = draggingObject
        ? { ...draggingObject, x: cell.x, z: cell.z }
        : activeMode?.kind === "rack"
          ? {
              id: "__ghost",
              kind: "rack" as const,
              catalogId: activeMode.skuId,
              x: reservedAtCell?.x ?? cell.x,
              z: reservedAtCell?.z ?? cell.z,
              rotation: reservedAtCell?.rotation ?? (0 as const),
              purchasePrice: 0,
            }
          : activeMode?.kind === "equipment"
            ? (() => {
                const def = HALL_EQUIPMENT_CATALOG.find(
                  (entry) => entry.id === activeMode.catalogId,
                )!;
                return {
                  id: "__ghost",
                  kind: def.kind,
                  catalogId: def.id,
                  x: cell.x,
                  z: cell.z,
                  rotation: 0 as const,
                  purchasePrice: def.price,
                };
              })()
            : undefined;
      if (!previewObject) {
        ghost.visible = false;
        return;
      }
      const d = objectDims(previewObject);
      ghost.scale.set(
        d.width * HALL_GRID_METERS,
        previewObject.kind === "rack" ? 2.1 : 1.5,
        d.depth * HALL_GRID_METERS,
      );
      ghost.position.set(
        (previewObject.x + d.width / 2) * HALL_GRID_METERS - widthM / 2,
        previewObject.kind === "rack" ? 1.05 : 0.75,
        (previewObject.z + d.depth / 2) * HALL_GRID_METERS - depthM / 2,
      );
      const status = draggingObject
        ? handlersRef.current.onPreviewMove(draggingObject, cell.x, cell.z)
        : activeMode
          ? handlersRef.current.onPreview(activeMode, cell.x, cell.z)
          : "valid";
      ghostMaterial.color.setHex(
        status === "invalid"
          ? 0xff5252
          : status === "warning"
            ? 0xf0ad4e
            : 0x48d7d1,
      );
      ghost.visible = true;
      render();
    };
    const down = (event: PointerEvent) => {
      const id = objectHit(event);
      if (id) {
        handlersRef.current.onSelect(id);
        if (layout.objects.some((object) => object.id === id)) {
          dragging = id;
          controls.enabled = false;
          canvas.setPointerCapture(event.pointerId);
          preview(event);
        }
      } else handlersRef.current.onSelect(null);
    };
    const up = (event: PointerEvent) => {
      const point = hitPoint(event);
      if (point) {
        const cell = pointToCell(point);
        if (dragging) handlersRef.current.onMove(dragging, cell.x, cell.z);
        else if (modeRef.current)
          handlersRef.current.onPlace(cell.x, cell.z, event.shiftKey);
      }
      if (canvas.hasPointerCapture(event.pointerId))
        canvas.releasePointerCapture(event.pointerId);
      dragging = null;
      controls.enabled = true;
      ghost.visible = false;
      render();
    };
    const cancelPointer = (event: PointerEvent) => {
      if (canvas.hasPointerCapture(event.pointerId))
        canvas.releasePointerCapture(event.pointerId);
      dragging = null;
      controls.enabled = true;
      ghost.visible = false;
      render();
    };
    const dragOver = (event: DragEvent) => {
      if (
        !Array.from(event.dataTransfer?.types ?? []).includes(
          HALL_PALETTE_DATA_MIME,
        )
      )
        return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      preview(event);
    };
    const dragLeave = (event: DragEvent) => {
      const related = event.relatedTarget;
      if (related instanceof Node && canvas.contains(related)) return;
      ghost.visible = false;
      render();
    };
    const drop = (event: DragEvent) => {
      const raw = event.dataTransfer?.getData(HALL_PALETTE_DATA_MIME) ?? "";
      const payload = parseHallPalettePayload(raw);
      if (!payload) return;
      event.preventDefault();
      const requestedMode: PaletteMode =
        payload.kind === "rack-sku"
          ? { kind: "rack", skuId: payload.skuId }
          : HALL_EQUIPMENT_CATALOG.some(
                (entry) => entry.id === payload.catalogId,
              )
            ? { kind: "equipment", catalogId: payload.catalogId }
            : null;
      const point = hitPoint(event);
      if (requestedMode && point) {
        const cell = pointToCell(point);
        handlersRef.current.onPlace(
          cell.x,
          cell.z,
          event.shiftKey,
          requestedMode,
        );
      }
      ghost.visible = false;
      render();
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", preview);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancelPointer);
    canvas.addEventListener("dragover", dragOver);
    canvas.addEventListener("dragleave", dragLeave);
    canvas.addEventListener("drop", drop);
    const render = () => renderer.render(scene, camera);
    renderRef.current = render;
    controls.addEventListener("change", render);
    const resize = () => {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      const nextAspect = width / height;
      camera.left = -view * nextAspect;
      camera.right = view * nextAspect;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    return () => {
      viewStateRef.current = {
        position: camera.position.clone(),
        target: controls.target.clone(),
        zoom: camera.zoom,
      };
      observer.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", preview);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancelPointer);
      canvas.removeEventListener("dragover", dragOver);
      canvas.removeEventListener("dragleave", dragLeave);
      canvas.removeEventListener("drop", drop);
      controls.removeEventListener("change", render);
      controls.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
          object.geometry.dispose();
          if (Array.isArray(object.material))
            object.material.forEach((material) => material.dispose());
          else object.material.dispose();
        }
      });
      selectorRef.current = null;
      renderRef.current = () => undefined;
      renderer.renderLists.dispose();
      renderer.dispose();
    };
  }, [
    analysis,
    constructionTarget,
    layout,
    overlayMode,
    resolveRackWidth,
    showGrid,
  ]);
  useEffect(() => {
    const selector = selectorRef.current;
    if (!selector) return;
    const object = layout.objects.find((entry) => entry.id === selectedId);
    const wall = layout.walls.find((entry) => entry.id === selectedId);
    if (!object && !wall) {
      selector.visible = false;
      renderRef.current();
      return;
    }
    const shell = DATA_HALL_SHELLS[layout.shellId];
    const widthM = shell.width * HALL_GRID_METERS;
    const depthM = shell.depth * HALL_GRID_METERS;
    if (wall) {
      const horizontal = wall.z1 === wall.z2;
      const length =
        Math.max(1, Math.abs(wall.x2 - wall.x1) + Math.abs(wall.z2 - wall.z1)) *
        HALL_GRID_METERS;
      selector.scale.set(
        horizontal ? length + 0.12 : 0.24,
        1,
        horizontal ? 0.24 : length + 0.12,
      );
      selector.position.set(
        ((wall.x1 + wall.x2) / 2) * HALL_GRID_METERS - widthM / 2,
        0.04,
        ((wall.z1 + wall.z2) / 2) * HALL_GRID_METERS - depthM / 2,
      );
      selector.visible = true;
      renderRef.current();
      return;
    }
    if (!object) return;
    const base =
      object.kind === "rack"
        ? { width: 3 * resolveRackWidth(object.catalogId), depth: 5 }
        : (HALL_EQUIPMENT_CATALOG.find(
            (entry) => entry.id === object.catalogId,
          ) ?? { width: 1, depth: 1 });
    const d =
      object.rotation === 90 || object.rotation === 270
        ? { width: base.depth, depth: base.width }
        : { width: base.width, depth: base.depth };
    selector.scale.set(
      d.width * HALL_GRID_METERS + 0.12,
      1,
      d.depth * HALL_GRID_METERS + 0.12,
    );
    selector.position.set(
      (object.x + d.width / 2) * HALL_GRID_METERS - widthM / 2,
      0.04,
      (object.z + d.depth / 2) * HALL_GRID_METERS - depthM / 2,
    );
    selector.visible = true;
    renderRef.current();
  }, [layout, overlayMode, resolveRackWidth, selectedId, showGrid]);
  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full touch-none"
      aria-label="Interactive data hall floor"
    />
  );
}

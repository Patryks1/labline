import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  ArrowsClockwise,
  ArrowLeft,
  ChalkboardTeacher,
  Desk,
  MagicWand,
  Plant,
  PresentationChart,
  Printer,
  Trash,
  UserPlus,
  UsersThree,
} from "@phosphor-icons/react";
import type {
  BuildableKind,
  HqOfficeLayout,
  HqOfficeObjectPlacement,
  StaffRole,
} from "../../../sim/types";
import {
  HQ_OFFICE_CATALOG,
  HQ_OFFICE_AUTOMATIC_PRESETS,
  HQ_OFFICE_GRID_METERS,
  analyzeHqOfficeLayout,
  hqOfficeAutomaticLayout,
  hqOfficeCatalogItem,
  hqOfficeLayoutForKind,
  previewHqObjectPlacement,
  quoteHqOfficePlan,
  rotateHqObject,
} from "../../../sim/systems/hqOffice";
import {
  cityForHq,
  hireStaff,
  hireStaffCost,
  playerHqStaffCap,
  playerStaff,
  playerStaffOpenSeats,
  poachRivalStaff,
  poachStaffCost,
  staffWagePerDay,
} from "../../../sim/systems/staff";
import {
  STAFF_BLURBS,
  STAFF_LABELS,
  emptyStaff,
  staffTotal,
} from "../../../sim/balance/staff";
import { facilityAnchorTiles } from "../../../sim/systems/worldAccess";
import { useGameStore } from "../../../store/gameStore";
import { money, num } from "../format";
import { BlockerList, MeterBar, StatRow } from "../ui/kit";
import { HudButton, HudInput, MetricTile, StatusChip } from "../ui/HudPrimitives";

type OfficeMode = string | null;

const cloneLayout = (layout: HqOfficeLayout): HqOfficeLayout => ({
  ...layout,
  objects: layout.objects.map((object) => ({ ...object })),
  analysis: { ...layout.analysis, hardErrors: [...layout.analysis.hardErrors], warnings: [...layout.analysis.warnings] },
});

function facilityKind(state: ReturnType<typeof useGameStore.getState>["state"], facilityId: string): BuildableKind {
  return (
    facilityAnchorTiles(state).find(
      (tile) => (tile.campusId ?? `facility:${tile.x},${tile.y}`) === facilityId,
    )?.kind as BuildableKind | undefined
  ) ?? "hq";
}

function objectIcon(kind: HqOfficeObjectPlacement["kind"]) {
  if (kind === "desk") return Desk;
  if (kind === "plant") return Plant;
  if (kind === "copier") return Printer;
  if (kind === "meeting_room") return PresentationChart;
  return ChalkboardTeacher;
}

export function HqOfficeEditorOverlay() {
  const facilityId = useGameStore((store) => store.hqOfficeEditorFacilityId);
  const state = useGameStore((store) => store.state);
  const close = useGameStore((store) => store.closeHqOfficeEditor);
  const applyPlan = useGameStore((store) => store.applyHqOfficeEditorPlan);
  const kind = facilityId ? facilityKind(state, facilityId) : "hq";
  const persisted = facilityId ? state.hqOfficeLayouts?.[facilityId] : undefined;
  const [draft, setDraft] = useState<HqOfficeLayout | null>(() =>
    facilityId
      ? cloneLayout(persisted ?? hqOfficeLayoutForKind(facilityId, kind))
      : null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<OfficeMode>(null);
  const [workspace, setWorkspace] = useState<"floor" | "team">("floor");
  const [message, setMessage] = useState("Choose an object, then click an open cell on the floor.");
  const idCounter = useRef(1);

  useEffect(() => {
    if (!facilityId) return;
    const initial = cloneLayout(persisted ?? hqOfficeLayoutForKind(facilityId, kind));
    setDraft(initial);
    setSelectedId(null);
    setMode(null);
    setWorkspace("floor");
    setMessage("Choose an object, then click an open cell on the floor.");
    idCounter.current = Math.max(
      0,
      ...initial.objects.map((object) => Number(object.id.match(/:(\d+)$/)?.[1] ?? 0)),
    ) + 1;
  }, [facilityId, persisted, kind]);

  const analysis = useMemo(
    () => (draft ? analyzeHqOfficeLayout(draft) : null),
    [draft],
  );
  const quote = useMemo(
    () => (draft ? quoteHqOfficePlan(draft, persisted) : null),
    [draft, persisted],
  );
  const dirty = Boolean(
    draft && persisted && JSON.stringify(draft.objects) !== JSON.stringify(persisted.objects),
  ) || Boolean(draft && !persisted && draft.objects.length > 0);
  const selected = draft?.objects.find((object) => object.id === selectedId);

  const updateDraft = (nextObjects: HqOfficeObjectPlacement[]) => {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, revision: current.revision + 1, objects: nextObjects };
      return { ...next, analysis: analyzeHqOfficeLayout(next) };
    });
  };

  const place = (x: number, z: number) => {
    if (!draft || !mode) return;
    const item = hqOfficeCatalogItem(mode);
    if (!item) return;
    const candidate: HqOfficeObjectPlacement = {
      id: `${facilityId}:object:${idCounter.current++}`,
      kind: item.kind,
      catalogId: item.id,
      x,
      z,
      rotation: 0,
      purchasePrice: item.purchasePrice,
    };
    const status = previewHqObjectPlacement(draft, candidate);
    if (status === "invalid") {
      setMessage("That cell is blocked. Keep furniture inside the HQ and leave a clear object footprint.");
      return;
    }
    updateDraft([...draft.objects, candidate]);
    setSelectedId(candidate.id);
    setMessage(`${item.label} placed${status === "warning" ? " — close to the entry aisle" : ""}.`);
  };

  const removeSelected = () => {
    if (!draft || !selectedId) return;
    const object = draft.objects.find((entry) => entry.id === selectedId);
    if (!object) return;
    updateDraft(draft.objects.filter((entry) => entry.id !== selectedId));
    setSelectedId(null);
    setMessage(`${hqOfficeCatalogItem(object.catalogId)?.label ?? "Object"} removed from the draft.`);
  };

  const rotateSelected = () => {
    if (!draft || !selected) return;
    const rotated = rotateHqObject(selected);
    if (previewHqObjectPlacement(draft, rotated) === "invalid") {
      setMessage("That rotation would overlap the room boundary or another object.");
      return;
    }
    updateDraft(draft.objects.map((object) => (object.id === selected.id ? rotated : object)));
  };

  const applyAutomaticLayout = (
    preset: (typeof HQ_OFFICE_AUTOMATIC_PRESETS)[number]["id"],
  ) => {
    if (!facilityId) return;
    const automatic = hqOfficeAutomaticLayout(facilityId, kind, preset);
    setDraft(cloneLayout(automatic));
    setSelectedId(null);
    setMode(null);
    idCounter.current = automatic.objects.length + 1;
    setMessage(`${HQ_OFFICE_AUTOMATIC_PRESETS.find((entry) => entry.id === preset)?.label ?? "Automatic layout"} drafted. Review it, then save the fit-out.`);
  };

  const apply = () => {
    if (!facilityId || !draft || !analysis || !quote) return;
    if (!dirty) {
      setMessage("This HQ fit-out is already saved.");
      return;
    }
    if (!analysis.valid) {
      setMessage(analysis.hardErrors[0] ?? "Resolve the blocked furniture first.");
      return;
    }
    const result = applyPlan({
      facilityId,
      width: draft.width,
      depth: draft.depth,
      objects: draft.objects,
    });
    if (!result.ok) {
      setMessage(result.error ?? "Fit-out could not be saved.");
      return;
    }
    setMessage(`Fit-out saved${result.netCost ? ` · ${money(result.netCost)}` : ""}. Productivity is live now.`);
  };

  if (!facilityId || !draft || !analysis || !quote) return null;
  return (
    <section className="pointer-events-auto fixed inset-0 z-[70] flex min-h-0 flex-col overflow-hidden bg-void/95 text-bone backdrop-blur-sm">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line bg-panel/95 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.2em] text-mint">HQ fit-out</p>
          <h1 className="truncate text-lg font-semibold tracking-[-0.03em] sm:text-xl">Make the office earn its footprint</h1>
          <p className="mt-0.5 text-[0.75rem] text-muted">Place desks, plants, copy stations, and collaboration space inside the headquarters.</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <div className="flex rounded-md border border-line bg-void/45 p-1" role="group" aria-label="Office workspace">
            <HudButton type="button" variant="ghost" aria-pressed={workspace === "floor"} className={`min-h-9 px-2.5 text-[0.6875rem] ${workspace === "floor" ? "bg-mint/10 text-mint" : "border-transparent"}`} onClick={() => setWorkspace("floor")}>
              <Desk size="0.95rem" /> Floor plan
            </HudButton>
            <HudButton type="button" variant="ghost" aria-pressed={workspace === "team"} className={`min-h-9 px-2.5 text-[0.6875rem] ${workspace === "team" ? "bg-mint/10 text-mint" : "border-transparent"}`} onClick={() => setWorkspace("team")}>
              <UsersThree size="0.95rem" /> Team & hiring
            </HudButton>
          </div>
          <HudButton type="button" variant="ghost" className="shrink-0 gap-1.5 px-3" onClick={close}>
            <ArrowLeft size="1rem" weight="bold" /> Back to map
          </HudButton>
        </div>
      </header>

      {workspace === "floor" ? <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="relative min-h-[20rem] overflow-hidden border-b border-line bg-[#09151a] lg:border-b-0 lg:border-r">
          <HqOfficeScene
            layout={draft}
            selectedId={selectedId}
            mode={mode}
            onSelect={setSelectedId}
            onPlace={place}
          />
          <div className="pointer-events-none absolute left-3 top-3 rounded border border-line/80 bg-panel/90 px-2.5 py-2 text-[0.6875rem] text-muted">
            <span className="font-mono text-mint">{draft.width}×{draft.depth}</span> grid · click to place · drag to orbit
          </div>
        </div>

        <aside className="min-h-0 overflow-y-auto bg-panel/90 p-3 sm:p-4">
          <div className="grid grid-cols-2 gap-2">
            <MetricTile label="Objects" value={num(analysis.objectCount, 0)} />
            <MetricTile label="New seats" value={`+${num(analysis.capacityBonus, 0)}`} tone="positive" />
            <MetricTile label="Productivity" value={`+${num(analysis.productivityBonus * 100, 1)}%`} tone="serve" />
            <MetricTile label="Fit-out" value={quote.netCost ? money(quote.netCost) : "Free"} tone={quote.netCost > state.player.cash ? "danger" : "neutral"} />
          </div>

          <div className="mt-3 rounded-lg border border-mint/25 bg-mint/5 p-2.5">
            <div className="mb-2 flex items-start gap-2">
              <MagicWand size="1rem" weight="duotone" className="mt-0.5 shrink-0 text-mint" />
              <div>
                <h2 className="text-[0.8125rem] font-semibold text-bone">Automatic layouts</h2>
                <p className="mt-0.5 text-[0.6875rem] leading-5 text-muted">Draft a complete floor using the same objects and placement rules as manual editing.</p>
              </div>
            </div>
            <div className="grid gap-1.5">
              {HQ_OFFICE_AUTOMATIC_PRESETS.map((preset) => (
                <HudButton
                  key={preset.id}
                  type="button"
                  variant="ghost"
                  onClick={() => applyAutomaticLayout(preset.id)}
                  className="min-h-11 w-full justify-start border border-line/70 bg-void/30 px-2.5 py-2 text-left"
                >
                  <span className="block text-[0.75rem] font-semibold text-bone">{preset.label}</span>
                  <span className="mt-0.5 block text-[0.625rem] font-normal leading-4 text-muted">{preset.description}</span>
                </HudButton>
              ))}
            </div>
          </div>

          <div className="mt-3 rounded-lg border border-line bg-void/35 p-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-[0.8125rem] font-semibold text-bone">Office palette</h2>
              <span className="font-mono text-[0.625rem] text-muted">{quote.buildDays}d max install</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {HQ_OFFICE_CATALOG.map((item) => {
                const Icon = objectIcon(item.kind);
                const active = mode === item.id;
                return (
                  <HudButton
                    key={item.id}
                    type="button"
                    variant={active ? "secondary" : "ghost"}
                    aria-pressed={active}
                    onClick={() => {
                      setMode(active ? null : item.id);
                      setMessage(active ? "Placement cancelled." : `Click the floor to place a ${item.label.toLowerCase()}.`);
                    }}
                    className={`min-h-16 w-full justify-start rounded-md border px-2 py-1.5 text-left ${active ? "border-mint/60 bg-mint/10" : "border-line/70 bg-panel-2/40 hover:border-mint/40"}`}
                  >
                    <span className="flex items-center gap-1.5 text-[0.6875rem] text-bone"><Icon size="1rem" weight="duotone" color={`#${item.color.toString(16).padStart(6, "0")}`} />{item.label}</span>
                    <span className="mt-1 block font-mono text-[0.625rem] text-muted">{money(item.purchasePrice)} · +{num(item.productivityBonus * 100, 1)}% prod</span>
                  </HudButton>
                );
              })}
            </div>
          </div>

          <div className="mt-3 rounded-lg border border-line bg-void/35 p-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-[0.8125rem] font-semibold text-bone">Selected object</h2>
              <span className="font-mono text-[0.625rem] text-muted">{selected ? selected.id.split(":").at(-1) : "none"}</span>
            </div>
            {selected ? (
              <>
                <StatRow label="Type" value={hqOfficeCatalogItem(selected.catalogId)?.label ?? selected.kind} />
                <StatRow label="Position" value={`${selected.x}, ${selected.z}`} />
                <StatRow label="Rotation" value={`${selected.rotation}°`} />
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <HudButton type="button" variant="ghost" className="min-h-11 border border-line text-[0.6875rem]" onClick={rotateSelected}><ArrowsClockwise size="0.9rem" /> Rotate</HudButton>
                  <HudButton type="button" variant="danger" className="min-h-11 text-[0.6875rem]" onClick={removeSelected}><Trash size="0.9rem" /> Remove</HudButton>
                </div>
              </>
            ) : <p className="text-[0.75rem] text-muted">Click a model on the floor to inspect or remove it.</p>}
          </div>

          {!analysis.valid ? <div className="mt-3"><BlockerList items={analysis.hardErrors.map((text) => ({ text, tone: "danger" as const }))} /></div> : null}
          {analysis.warnings.length > 0 ? <p className="mt-2 text-[0.6875rem] text-amber">{analysis.warnings[0]}</p> : null}
          <p className="mt-3 rounded-md border border-line/60 bg-panel-2/50 px-2.5 py-2 text-[0.6875rem] leading-relaxed text-muted">Fit-out purchases are charged once on save. Furniture adds a small daily facilities cost and its productivity/capacity effects feed the simulation immediately.</p>
          <MeterBar label="Cash after fit-out" value={Math.max(0, Math.min(1, (state.player.cash - quote.netCost) / Math.max(1, state.player.cash)))} detail={money(Math.max(0, state.player.cash - quote.netCost))} tone={quote.netCost > state.player.cash ? "danger" : "positive"} />
          <HudButton type="button" variant="primary" disabled={!dirty || !analysis.valid || quote.netCost > state.player.cash} className="mt-3 min-h-11 w-full" onClick={apply}>
            {dirty ? `Save fit-out · ${quote.netCost ? money(quote.netCost) : "no charge"}` : "Fit-out saved"}
          </HudButton>
          <p className="mt-2 min-h-8 text-[0.6875rem] text-muted" aria-live="polite">{message}</p>
        </aside>
      </div> : <OfficeTeamPanel facilityId={facilityId} />}
    </section>
  );
}

function OfficeTeamPanel({ facilityId }: { facilityId: string }) {
  const state = useGameStore((store) => store.state);
  const [role, setRole] = useState<StaffRole>("researcher");
  const [quantity, setQuantity] = useState(1);
  const staff = playerStaff(state);
  const seats = playerHqStaffCap(state);
  const openSeats = playerStaffOpenSeats(state);
  const headcount = staffTotal(staff);
  const hq = facilityAnchorTiles(state).find(
    (tile) => (tile.campusId ?? `facility:${tile.x},${tile.y}`) === facilityId,
  );
  const floorSeats = state.hqOfficeLayouts?.[facilityId]?.analysis.capacityBonus ?? 0;
  const city = hq ? cityForHq(state, hq.x, hq.y) : state.map.cities?.[0] ?? null;
  const available = city?.talentAvailable ?? emptyStaff();
  const hireCost = city ? hireStaffCost(state, role, quantity, city.id) : 0;
  const canHire = Boolean(
    city &&
    quantity > 0 &&
    quantity <= openSeats &&
    quantity <= (available[role] ?? 0) &&
    hireCost <= state.player.cash,
  );
  const roles: Array<{ id: StaffRole; label: string; color: string }> = [
    { id: "researcher", label: "Research", color: "text-mint" },
    { id: "data_processor", label: "Data", color: "text-sky-400" },
    { id: "engineer", label: "Engineering", color: "text-amber" },
    { id: "ops", label: "Operations", color: "text-violet-400" },
  ];
  const setState = (next: typeof state) => useGameStore.setState({ state: next });

  return (
    <div className="panel-scroll min-h-0 flex-1 overflow-y-auto bg-panel/90 p-4 sm:p-6">
      <div className="mx-auto grid w-full max-w-[76rem] gap-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
        <div className="space-y-3">
          <section className="rounded-lg border border-mint/25 bg-mint/5 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="hud-eyebrow">This office</p>
                <h2 className="mt-1 text-base font-semibold text-bone">{hq?.name || "Headquarters"}</h2>
                <p className="mt-1 text-[0.75rem] text-muted">Every hire needs a physical seat placed on an owned HQ floor.</p>
              </div>
              <StatusChip tone={floorSeats > 0 ? "positive" : "warning"}>{floorSeats} floor seats</StatusChip>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MetricTile label="Company team" value={`${headcount}/${seats}`} detail={`${openSeats} open`} />
              <MetricTile label="This floor" value={String(floorSeats)} detail="placed seats" tone="positive" />
              <MetricTile label="Payroll" value={`${money(staffWagePerDay(state))}/d`} tone="danger" />
              <MetricTile label="Talent market" value={city?.name ?? "No city"} detail={city ? `wage ×${(city.talentWageMult ?? 1).toFixed(2)}` : undefined} />
            </div>
          </section>

          <section className="rounded-lg border border-line bg-void/35 p-3">
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {roles.map((entry) => (
                <HudButton
                  key={entry.id}
                  type="button"
                  variant="ghost"
                  aria-pressed={role === entry.id}
                  onClick={() => setRole(entry.id)}
                  className={`min-h-16 w-full justify-start border px-2.5 py-2 text-left ${role === entry.id ? "border-mint/50 bg-mint/10" : "border-line/70 bg-panel-2/40"}`}
                >
                  <span className={`block text-[0.6875rem] font-semibold ${entry.color}`}>{entry.label}</span>
                  <span className="mt-1 block font-mono text-base text-bone">{staff[entry.id] ?? 0}</span>
                </HudButton>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-line bg-panel-2/60 p-3">
            <div className="flex items-start gap-2">
              <UserPlus size="1.1rem" weight="duotone" className="mt-0.5 text-mint" />
              <div>
                <h3 className="text-[0.875rem] font-semibold text-bone">Hire {STAFF_LABELS[role].toLowerCase()}</h3>
                <p className="mt-1 text-[0.75rem] leading-5 text-muted">{STAFF_BLURBS[role]}</p>
              </div>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_auto] sm:items-end">
              <div className="rounded-md border border-line/60 bg-void/35 px-2.5 py-2 text-[0.6875rem] text-muted">
                {city ? `${available[role] ?? 0} ready in ${city.name}` : "No local hiring market"} · {openSeats} desk{openSeats === 1 ? "" : "s"} open
              </div>
              <label className="text-[0.625rem] uppercase tracking-wider text-muted">
                Quantity
                <HudInput type="number" min={1} max={Math.max(1, openSeats)} value={quantity} onChange={(event) => setQuantity(Math.max(1, Math.min(20, Number(event.target.value) || 1)))} className="mt-1 w-full font-mono" />
              </label>
              <HudButton
                type="button"
                variant="primary"
                disabled={!canHire}
                title={!canHire ? "Add desks, cash, or available local talent before hiring." : undefined}
                onClick={() => {
                  if (!city) return;
                  setState(hireStaff(state, city.id, role, quantity));
                }}
              >
                Hire · {money(hireCost)}
              </HudButton>
            </div>
          </section>
        </div>

        <section className="rounded-lg border border-line bg-void/35 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <p className="hud-eyebrow">Talent market</p>
              <h3 className="mt-1 text-[0.875rem] font-semibold text-bone">Poach specialist hires</h3>
            </div>
            <span className="text-[0.6875rem] text-muted">premium · immediate</span>
          </div>
          <div className="space-y-1.5">
            {state.rivals.slice(0, 5).map((rival) => {
              const rivalStaff = rival.staff ?? emptyStaff();
              return (
                <div key={rival.id} className="grid gap-2 rounded-md border border-line/60 bg-panel-2/45 p-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="truncate text-[0.75rem] font-medium text-bone">{rival.name}</p>
                    <p className="font-mono text-[0.625rem] text-muted">R{rivalStaff.researcher} · D{rivalStaff.data_processor} · E{rivalStaff.engineer}</p>
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {(["researcher", "data_processor", "engineer"] as StaffRole[]).map((poachRole) => {
                      const cost = poachStaffCost(state, rival.id, poachRole, 1);
                      const enabled = (rivalStaff[poachRole] ?? 0) > 0 && openSeats > 0 && state.player.cash >= cost;
                      return (
                        <HudButton key={poachRole} type="button" variant="ghost" disabled={!enabled} title={enabled ? `${STAFF_LABELS[poachRole]} · ${money(cost)}` : "Need an open desk, cash, and rival talent."} className="min-h-11 px-2 font-mono text-[0.625rem]" onClick={() => setState(poachRivalStaff(state, rival.id, poachRole, 1))}>
                          {poachRole === "researcher" ? "R" : poachRole === "data_processor" ? "D" : "E"} · {money(cost)}
                        </HudButton>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function HqOfficeScene({
  layout,
  selectedId,
  mode,
  onSelect,
  onPlace,
}: {
  layout: HqOfficeLayout;
  selectedId: string | null;
  mode: OfficeMode;
  onSelect: (id: string | null) => void;
  onPlace: (x: number, z: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const widthM = layout.width * HQ_OFFICE_GRID_METERS;
    const depthM = layout.depth * HQ_OFFICE_GRID_METERS;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x09151a);
    const camera = new THREE.OrthographicCamera(-10, 10, 8, -8, 0.1, 100);
    camera.position.set(widthM * 0.9, Math.max(widthM, depthM) * 1.25, depthM * 1.05);
    camera.lookAt(0, 0, 0);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.enablePan = true;
    controls.minZoom = 0.8;
    controls.maxZoom = 2.5;
    const ambient = new THREE.HemisphereLight(0xa9e5e3, 0x071014, 1.5);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 9, 6);
    key.castShadow = true;
    scene.add(key);
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(widthM, 0.12, depthM),
      new THREE.MeshStandardMaterial({ color: 0x122b32, roughness: 0.9, metalness: 0.05 }),
    );
    floor.position.y = -0.08;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(Math.max(widthM, depthM), Math.max(layout.width, layout.depth), 0x3b8789, 0x24545a);
    grid.position.y = 0.01;
    scene.add(grid);
    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x31545b, transparent: true, opacity: 0.7 });
    for (const [x, z, w, d] of [[0, -depthM / 2, widthM, 0.12], [0, depthM / 2, widthM, 0.12], [-widthM / 2, 0, 0.12, depthM], [widthM / 2, 0, 0.12, depthM]] as const) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 0.7, d), wallMaterial);
      wall.position.set(x, 0.3, z);
      scene.add(wall);
    }
    const objectGroups: THREE.Group[] = [];
    for (const object of layout.objects) {
      const item = hqOfficeCatalogItem(object.catalogId);
      if (!item) continue;
      const group = new THREE.Group();
      group.userData.selectionId = object.id;
      const rotated = object.rotation === 90 || object.rotation === 270;
      const w = (rotated ? item.depth : item.width) * HQ_OFFICE_GRID_METERS;
      const d = (rotated ? item.width : item.depth) * HQ_OFFICE_GRID_METERS;
      group.position.set((object.x + (rotated ? item.depth : item.width) / 2) * HQ_OFFICE_GRID_METERS - widthM / 2, 0, (object.z + (rotated ? item.width : item.depth) / 2) * HQ_OFFICE_GRID_METERS - depthM / 2);
      const material = new THREE.MeshStandardMaterial({ color: item.color, roughness: 0.65, metalness: 0.12 });
      const add = (mesh: THREE.Mesh) => {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.selectionId = object.id;
        group.add(mesh);
      };
      if (object.kind === "desk") {
        const top = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, 0.12, d * 0.62), material);
        top.position.y = 0.72;
        add(top);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.68, 0.055), material);
          leg.position.set(sx * w * 0.36, 0.34, sz * d * 0.22);
          leg.userData.selectionId = object.id;
          group.add(leg);
        }
        const screen = new THREE.Mesh(new THREE.BoxGeometry(w * 0.36, 0.3, 0.035), new THREE.MeshStandardMaterial({ color: 0x122126, roughness: 0.25, metalness: 0.45 }));
        screen.position.set(0, 1.0, -d * 0.16);
        add(screen);
        const stand = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.19, 0.035), material);
        stand.position.set(0, 0.84, -d * 0.16);
        add(stand);
        const chairSeat = new THREE.Mesh(new THREE.BoxGeometry(w * 0.38, 0.1, d * 0.28), new THREE.MeshStandardMaterial({ color: 0x24434a, roughness: 0.8 }));
        chairSeat.position.set(0, 0.42, d * 0.3);
        add(chairSeat);
        const chairBack = new THREE.Mesh(new THREE.BoxGeometry(w * 0.38, 0.42, 0.08), new THREE.MeshStandardMaterial({ color: 0x24434a, roughness: 0.8 }));
        chairBack.position.set(0, 0.63, d * 0.41);
        add(chairBack);
      } else if (object.kind === "plant") {
        const pot = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(w, d) * 0.28, Math.min(w, d) * 0.34, 0.36, 10), material);
        pot.position.y = 0.18;
        add(pot);
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.58, 8), new THREE.MeshStandardMaterial({ color: 0x446f3d, roughness: 0.9 }));
        stem.position.y = 0.62;
        add(stem);
        for (let index = 0; index < 5; index += 1) {
          const leaves = new THREE.Mesh(new THREE.SphereGeometry(Math.min(w, d) * 0.23, 10, 7), new THREE.MeshStandardMaterial({ color: index % 2 ? 0x78bf67 : 0x91d477, roughness: 0.88 }));
          const angle = (index / 5) * Math.PI * 2;
          leaves.scale.set(1, 0.55, 0.65);
          leaves.position.set(Math.cos(angle) * w * 0.18, 0.72 + (index % 2) * 0.18, Math.sin(angle) * d * 0.18);
          add(leaves);
        }
      } else if (object.kind === "copier") {
        const body = new THREE.Mesh(new THREE.BoxGeometry(w * 0.62, 0.66, d * 0.62), material);
        body.position.y = 0.33;
        add(body);
        const scanner = new THREE.Mesh(new THREE.BoxGeometry(w * 0.52, 0.09, d * 0.44), new THREE.MeshStandardMaterial({ color: 0xe4eceb, roughness: 0.4 }));
        scanner.position.y = 0.71;
        add(scanner);
        const tray = new THREE.Mesh(new THREE.BoxGeometry(w * 0.48, 0.04, d * 0.32), new THREE.MeshStandardMaterial({ color: 0xa8b8b8, roughness: 0.55 }));
        tray.position.set(0, 0.43, d * 0.38);
        tray.rotation.x = -0.18;
        add(tray);
        const panel = new THREE.Mesh(new THREE.BoxGeometry(w * 0.2, 0.1, 0.025), new THREE.MeshStandardMaterial({ color: 0x17343a, emissive: 0x195d63, emissiveIntensity: 0.35 }));
        panel.position.set(w * 0.16, 0.78, d * 0.1);
        add(panel);
      } else if (object.kind === "meeting_room") {
        const table = new THREE.Mesh(new THREE.BoxGeometry(w * 0.68, 0.16, d * 0.5), material);
        table.position.y = 0.5;
        add(table);
        const pedestal = new THREE.Mesh(new THREE.BoxGeometry(w * 0.12, 0.5, d * 0.12), new THREE.MeshStandardMaterial({ color: 0x5c6e73, roughness: 0.5, metalness: 0.45 }));
        pedestal.position.y = 0.25;
        add(pedestal);
        for (const side of [-1, 1]) for (const offset of [-0.2, 0.2]) {
          const chair = new THREE.Mesh(new THREE.BoxGeometry(w * 0.18, 0.1, d * 0.18), new THREE.MeshStandardMaterial({ color: 0x3a5269, roughness: 0.75 }));
          chair.position.set(offset * w, 0.34, side * d * 0.38);
          add(chair);
        }
        const glass = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, 0.82, 0.035), new THREE.MeshStandardMaterial({ color: 0x7ec6c9, transparent: true, opacity: 0.22, roughness: 0.2 }));
        glass.position.set(0, 0.41, -d * 0.47);
        add(glass);
      } else {
        const frame = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, 1.02, 0.09), material);
        frame.position.y = 0.65;
        add(frame);
        const board = new THREE.Mesh(new THREE.BoxGeometry(w * 0.88, 0.84, 0.045), new THREE.MeshStandardMaterial({ color: 0xe7eeee, roughness: 0.78 }));
        board.position.set(0, 0.67, 0.06);
        add(board);
        for (let index = 0; index < 3; index += 1) {
          const note = new THREE.Mesh(new THREE.BoxGeometry(w * 0.12, 0.12, 0.01), new THREE.MeshStandardMaterial({ color: [0xf0b85a, 0x80b8ea, 0xb497f2][index] }));
          note.position.set((index - 1) * w * 0.24, 0.7 + (index % 2) * 0.15, 0.09);
          add(note);
        }
      }
      if (object.id === selectedId) {
        const outline = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.08, d + 0.12), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.9 }));
        outline.position.y = 0.05;
        outline.userData.selectionId = object.id;
        group.add(outline);
      }
      objectGroups.push(group);
      scene.add(group);
    }
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const point = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObject(floor)[0]?.point;
    };
    const down = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(objectGroups, true)[0];
      const hitId = hit?.object.userData.selectionId as string | undefined;
      if (hitId) {
        onSelect(hitId);
        return;
      }
      if (mode) {
        const p = point(event);
        if (p) onPlace(Math.max(0, Math.min(layout.width - 1, Math.floor((p.x + widthM / 2) / HQ_OFFICE_GRID_METERS))), Math.max(0, Math.min(layout.depth - 1, Math.floor((p.z + depthM / 2) / HQ_OFFICE_GRID_METERS))));
      } else onSelect(null);
    };
    const render = () => renderer.render(scene, camera);
    renderRef.current = render;
    controls.addEventListener("change", render);
    canvas.addEventListener("pointerdown", down);
    const resize = () => {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      const aspect = width / height;
      const view = Math.max(widthM, depthM) * 0.7;
      camera.left = -view * aspect;
      camera.right = view * aspect;
      camera.top = view;
      camera.bottom = -view;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    return () => {
      observer.disconnect();
      controls.removeEventListener("change", render);
      controls.dispose();
      canvas.removeEventListener("pointerdown", down);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
          object.geometry.dispose();
          if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
          else object.material.dispose();
        }
      });
      renderer.renderLists.dispose();
      renderer.dispose();
      renderRef.current = () => undefined;
    };
  }, [layout, mode, onPlace, onSelect, selectedId]);
  return <canvas ref={canvasRef} className="h-full min-h-[20rem] w-full touch-none" aria-label="Interactive HQ office floor" />;
}

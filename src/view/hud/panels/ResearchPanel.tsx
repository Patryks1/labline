import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  RESEARCH_NODES,
  RESEARCH_BRANCHES,
  RESEARCH_TRUNKS,
  TRUNK_META,
  getResearchNode,
  researchBranchForNode,
} from "../../../sim/balance/research";
import {
  RESEARCH_LAYOUT,
  layoutResearchTree,
  type ResearchTreeLayout,
} from "../../../sim/balance/researchLayout";
import type { ResearchEffects } from "../../../sim/types";
import {
  dequeueResearch,
  enqueueResearch,
  moveQueue,
  nodeVisualStatus,
  estimateResearchRate,
  minResearchersForNode,
  researchCashEstimate,
  researchDaysTarget,
  researchPfTarget,
  startResearch,
  planResearchPath,
  type NodeVisualStatus,
} from "../../../sim/systems/research";
import {
  dequeueResearchProgram,
  queueResearchProgram,
  researchPodStaffRequirements,
  startResearchProgram,
} from "../../../sim/systems/researchPrograms";
import { playerStaff } from "../../../sim/systems/staff";
import { useGameStore } from "../../../store/gameStore";
import { computeSnapshot } from "../../../sim/tick";
import { money, mw, num } from "../format";
import { GameCard, LiveDot, MeterBar, StatRow } from "../ui/kit";
import {
  HudButton,
  MetricTile,
  StatusChip,
} from "../ui/HudPrimitives";
import { scrollMobileResearchSelection } from "./researchPanelMobile";

const FULL_RESEARCH_LAYOUT = layoutResearchTree();

function programProgress(program: {
  phase: string;
  engineeringProgress: number;
  insightProgress: number;
}): number {
  return Math.min(
    1,
    program.phase === "integration"
      ? 0.7 + program.engineeringProgress * 0.3
      : program.insightProgress * 0.7,
  );
}

function statusTone(
  status: NodeVisualStatus | "active" | "queued" | null,
): "neutral" | "positive" | "warning" | "danger" | "research" {
  if (status === "done") return "positive";
  if (status === "active") return "research";
  if (status === "queued") return "warning";
  if (status === "blocked" || status === "locked") return "danger";
  return "neutral";
}

export function ResearchPanel() {
  const state = useGameStore((s) => s.state);
  const focusRequest = useGameStore((s) => s.researchFocusRequest);
  const setState = useGameStore.setState;
  const snap = computeSnapshot(state);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPodId, setSelectedPodId] = useState(
    () => state.player.researchPods?.[0]?.id ?? "",
  );
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const mobileSelectedMethodRef = useRef<HTMLElement | null>(null);

  const active = state.player.activeResearch;
  const legacyQueue = state.player.researchQueue;
  const leads = state.player.researchLeads ?? [];
  const pods = state.player.researchPods ?? [];
  const programs = state.player.researchPrograms ?? [];
  const usesPodPrograms = pods.length > 0;
  const queue = usesPodPrograms
    ? (state.player.researchProgramQueue ?? [])
    : legacyQueue;
  const selected = selectedId ? getResearchNode(selectedId) : null;
  const selectedProgram = selectedId
    ? programs.find(
        (program) =>
          program.methodId === selectedId && program.phase !== "complete",
      )
    : undefined;
  const status = selectedId
    ? selectedProgram
      ? ("active" as const)
      : queue.includes(selectedId)
        ? ("queued" as const)
        : nodeVisualStatus(state, selectedId)
    : null;
  const selectedPod = pods.find((pod) => pod.id === selectedPodId);
  const selectedPath = (() => {
    if (!selected) return [];
    const scheduled = usesPodPrograms
      ? [
          ...queue,
          ...programs
            .filter((program) => program.phase !== "complete")
            .map((program) => program.methodId),
        ]
      : [...legacyQueue, ...(active ? [active.nodeId] : [])];
    return planResearchPath(
      state.player.researchUnlocked,
      scheduled,
      selected.id,
    ).nodeIds;
  })();
  const selectedLineage = useMemo(
    () => researchLineage(selectedId),
    [selectedId],
  );

  const apply = (next: typeof state) => setState({ state: next });
  const layout = FULL_RESEARCH_LAYOUT;
  const canvas = useResearchCanvas(layout);
  const centerResearchNode = canvas.centerNode;

  const activePrograms = programs.filter(
    (program) => program.phase !== "complete",
  );
  const unlockedCount = state.player.researchUnlocked.length;
  const staff = playerStaff(state);
  const researcherCount = staff.researcher ?? 0;
  const selectedStaffNeed = selected
    ? researchPodStaffRequirements(selected.id)
    : null;

  useEffect(() => {
    if (!focusRequest) return;
    const node = getResearchNode(focusRequest.nodeId);
    setSelectedId(node.id);
    setHighlightedId(node.id);
    const frame = window.requestAnimationFrame(() =>
      centerResearchNode(node.id),
    );
    const timeout = window.setTimeout(() => setHighlightedId(null), 1800);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [centerResearchNode, focusRequest]);

  useEffect(() => {
    if (!selectedId || !window.matchMedia("(max-width: 900px)").matches) return;
    const frame = window.requestAnimationFrame(() => {
      scrollMobileResearchSelection(mobileSelectedMethodRef.current, true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedId]);

  const startOrQueue = (id: string) => apply(startResearch(state, id));
  const L = RESEARCH_LAYOUT;

  return (
    <div className="flex min-h-full flex-col gap-2 overflow-y-auto overscroll-contain pb-2 xl:h-full xl:min-h-0 xl:overflow-hidden xl:pb-0">
      <header className="shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="hud-eyebrow">Leads · pods · methods</p>
            <h2 className="hud-title hidden sm:block">Research</h2>
            <p className="hud-description hidden sm:block">
              Burn research PF and cash for unlocks.
            </p>
          </div>
          <StatusChip tone="research">
            {num(snap.pools.research, 2)} PF
          </StatusChip>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricTile
            label="Pool"
            value={`${num(snap.pools.research, 2)} PF`}
            detail={`${mw(snap.mwForecast.research)} physical draw`}
            tone="research"
          />
          <MetricTile
            label="Burn today"
            value={money(state.player.researchCashBurnToday ?? 0)}
            tone={
              (state.player.researchCashBurnToday ?? 0) > 0
                ? "warning"
                : "neutral"
            }
          />
          <MetricTile
            label="Unlocked"
            value={`${unlockedCount}/${RESEARCH_NODES.length}`}
          />
          <MetricTile
            label="In flight"
            value={String(
              usesPodPrograms ? activePrograms.length : active ? 1 : 0,
            )}
            detail={`${queue.length} queued`}
            tone={activePrograms.length > 0 || active ? "research" : "neutral"}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-none flex-col gap-2 overflow-visible xl:flex-1 xl:flex-row xl:overflow-hidden">
        <aside className="order-2 flex shrink-0 flex-col gap-2 overflow-visible xl:order-1 xl:max-h-none xl:w-72 xl:overflow-hidden">
          <div className="panel-scroll min-h-0 flex-1 space-y-2 pr-0.5 xl:overflow-y-auto">
            {usesPodPrograms ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="inline-flex items-center gap-1.5 text-[0.8125rem] text-muted">
                    {(activePrograms.length > 0 || !!active) && (
                      <LiveDot className="text-research" />
                    )}
                    Pods · queue
                  </p>
                </div>
                <div className="anim-stagger grid gap-2">
                  {pods.map((pod) => {
                    const lead = leads.find(
                      (candidate) => candidate.id === pod.leadId,
                    );
                    const program = programs.find(
                      (candidate) => candidate.id === pod.assignmentId,
                    );
                    const progress = program ? programProgress(program) : 0;
                    return (
                      <button
                        key={pod.id}
                        type="button"
                        onClick={() => setSelectedPodId(pod.id)}
                        className="text-left"
                      >
                        <GameCard
                          eyebrow={lead?.name ?? "No lead"}
                          title={pod.name}
                          tone="research"
                          live={!!program}
                          className={
                            pod.id === selectedPodId
                              ? "ring-1 ring-research/40"
                              : "hover-lift"
                          }
                          actions={
                            <StatusChip tone={program ? "research" : "neutral"}>
                              {program?.phase ?? "available"}
                            </StatusChip>
                          }
                        >
                          <p className="truncate text-[0.8125rem] text-muted">
                            {pod.researchers} research · {pod.engineers} eng ·{" "}
                            {pod.dataStaff} data
                          </p>
                          {program && (
                            <div className="mt-2">
                              <MeterBar
                                label={getResearchNode(program.methodId).name}
                                value={progress}
                                detail={`${Math.round(progress * 100)}%`}
                                tone="research"
                                live
                              />
                            </div>
                          )}
                        </GameCard>
                      </button>
                    );
                  })}
                </div>
                {queue.length > 0 && (
                  <GameCard
                    eyebrow="Queued"
                    title={`${queue.length} waiting`}
                    tone="research"
                  >
                    <div className="anim-stagger flex flex-wrap gap-1.5">
                      {queue.map((id) => (
                        <button
                          key={id}
                          type="button"
                          className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[0.75rem] text-bone hover:border-research/50"
                          onClick={() => {
                            setSelectedId(id);
                            centerResearchNode(id);
                          }}
                        >
                          {getResearchNode(id).name}
                        </button>
                      ))}
                    </div>
                  </GameCard>
                )}
              </>
            ) : (
              <GameCard
                eyebrow="Queue"
                title={active ? "In flight" : "Waiting"}
                tone="research"
              >
                {queue.length === 0 && !active ? (
                  <p className="text-[0.8125rem] text-muted">Queue is empty.</p>
                ) : (
                  <div className="anim-stagger flex flex-wrap gap-1.5">
                    {active ? (
                      <button
                        type="button"
                        className="rounded-full border border-research/40 bg-research/10 px-2 py-0.5 text-[0.75rem] text-research"
                        onClick={() => {
                          setSelectedId(active.nodeId);
                          centerResearchNode(active.nodeId);
                        }}
                      >
                        {getResearchNode(active.nodeId).name}
                      </button>
                    ) : null}
                    {queue.map((id, index) => (
                      <div
                        key={id}
                        className="flex items-center gap-0.5 rounded-full border border-line bg-panel-2 pl-2 text-[0.75rem]"
                      >
                        <span className="font-mono tabular-nums text-muted">
                          {index + 1}.
                        </span>
                        <button
                          type="button"
                          className="max-w-[90px] truncate text-bone"
                          onClick={() => {
                            setSelectedId(id);
                            centerResearchNode(id);
                          }}
                        >
                          {getResearchNode(id).name}
                        </button>
                        <button
                          type="button"
                          className="px-1 text-muted hover:text-bone"
                          onClick={() => apply(moveQueue(state, id, -1))}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="px-1 text-muted hover:text-bone"
                          onClick={() => apply(moveQueue(state, id, 1))}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="pr-1.5 text-muted hover:text-danger"
                          onClick={() => apply(dequeueResearch(state, id))}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </GameCard>
            )}
          </div>
        </aside>

        <div className="order-1 flex min-h-0 min-w-0 flex-none flex-col gap-2 overflow-visible xl:order-2 xl:flex-1 xl:overflow-hidden">
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-visible xl:overflow-hidden">
            <div
              ref={canvas.viewportRef}
              onPointerDown={canvas.onPointerDown}
              onPointerMove={canvas.onPointerMove}
              onPointerUp={canvas.onPointerUp}
              onPointerCancel={canvas.onPointerUp}
              onWheel={canvas.onWheel}
              className="relative h-[min(62dvh,34rem)] min-h-[24rem] touch-pan-y select-none overflow-hidden rounded-lg border border-line bg-void/90 cursor-grab data-[dragging=true]:cursor-grabbing sm:touch-none xl:h-full xl:min-h-0"
              aria-label="Interactive research tree. Drag to pan and use the zoom controls to inspect methods."
            >
              <div className="absolute right-2 top-2 z-20 grid grid-cols-4 gap-1 rounded-lg border border-line bg-panel/95 p-1.5 shadow-lg backdrop-blur-md sm:right-3 sm:top-3">
                <span className="col-span-4 rounded bg-void/70 px-2 py-1 text-center font-mono text-[0.6875rem] tabular-nums text-bone">
                  {Math.round(canvas.zoom * 100)}%
                </span>
                <HudButton
                  variant="ghost"
                  className="!h-11 !min-h-0 !w-11 !p-0 text-base lg:!h-8 lg:!w-8"
                  onClick={() => canvas.zoomBy(0.84)}
                  aria-label="Zoom research tree out"
                >
                  −
                </HudButton>
                <HudButton
                  variant="ghost"
                  className="!h-11 !min-h-0 !w-11 !p-0 text-base lg:!h-8 lg:!w-8"
                  onClick={() => canvas.zoomBy(1.19)}
                  aria-label="Zoom research tree in"
                >
                  +
                </HudButton>
                <HudButton
                  variant="ghost"
                  className="!h-11 !min-h-0 !px-3 text-[0.6875rem] lg:!h-8 lg:!px-2"
                  onClick={canvas.fit}
                >
                  Fit
                </HudButton>
                <HudButton
                  variant="ghost"
                  className="!h-11 !min-h-0 !px-2 text-[0.6875rem] lg:!h-8"
                  onClick={canvas.reset}
                  aria-label="Reset research tree view"
                >
                  Reset
                </HudButton>
              </div>
              <div className="pointer-events-none absolute bottom-2 left-2 z-20 rounded-md border border-line/70 bg-panel/85 px-2 py-1 font-mono text-[0.625rem] text-muted backdrop-blur-md">
                <span className="sm:hidden">drag · +/− zoom · tap a method</span>
                <span className="hidden sm:inline">drag · wheel · double-click to queue</span>
              </div>
              <div
                ref={canvas.contentRef}
                className="absolute left-0 top-0 will-change-transform"
                style={{ width: layout.width, height: layout.height }}
              >
                {RESEARCH_TRUNKS.map((t) => {
                  const branchRoot = layout.nodes
                    .filter((node) => node.trunk === t)
                    .sort((a, b) => a.depth - b.depth || a.y - b.y)[0];
                  const x = branchRoot?.x ?? layout.trunkX[t] ?? L.padX;
                  const y = Math.max(10, (branchRoot?.y ?? L.padY) - 25);
                  return (
                    <div
                      key={t}
                      className="pointer-events-none absolute z-10 rounded-md border bg-void/85 px-2 py-1 shadow-sm backdrop-blur-sm"
                      style={{
                        left: x,
                        top: y,
                        color: TRUNK_META[t].color,
                        borderColor: `${TRUNK_META[t].color}55`,
                      }}
                    >
                      <div className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em]">
                        {TRUNK_META[t].label}
                      </div>
                    </div>
                  );
                })}

                <svg
                  className="pointer-events-none absolute left-0 top-0 z-[2]"
                  width={layout.width}
                  height={layout.height}
                >
                  {layout.edges.map((e) => {
                    const horizontal =
                      Math.abs(e.x2 - e.x1) >= Math.abs(e.y2 - e.y1);
                    const midX = (e.x1 + e.x2) / 2;
                    const midY = (e.y1 + e.y2) / 2;
                    const done = state.player.researchUnlocked.includes(e.from);
                    const selectedEdge =
                      selectedLineage.has(e.from) && selectedLineage.has(e.to);
                    const path = horizontal
                      ? `M ${e.x1} ${e.y1} C ${midX} ${e.y1}, ${midX} ${e.y2}, ${e.x2} ${e.y2}`
                      : `M ${e.x1} ${e.y1} C ${e.x1} ${midY}, ${e.x2} ${midY}, ${e.x2} ${e.y2}`;
                    return (
                      <g key={`${e.from}-${e.to}`}>
                        <path
                          d={path}
                          fill="none"
                          stroke={
                            e.crossTrunk
                              ? done
                                ? "#3dffc044"
                                : "#2a2f3a88"
                              : done
                                ? "#3dffc088"
                                : "#3a4150"
                          }
                          strokeWidth={e.crossTrunk ? 1 : 1.5}
                          strokeDasharray={e.crossTrunk ? "4 3" : undefined}
                        />
                        {selectedEdge ? (
                          <path
                            data-selected-research-edge="true"
                            className="research-edge-selected"
                            d={path}
                            fill="none"
                            stroke="#bda8ff"
                            strokeWidth={e.crossTrunk ? 2.25 : 2.75}
                            strokeLinecap="round"
                            strokeDasharray="10 8"
                          />
                        ) : null}
                      </g>
                    );
                  })}
                </svg>

                {layout.nodes.map((n) => {
                  const def = getResearchNode(n.id);
                  const program = programs.find(
                    (candidate) =>
                      candidate.methodId === n.id &&
                      candidate.phase !== "complete",
                  );
                  const st = program
                    ? ("active" as const)
                    : queue.includes(n.id)
                      ? ("queued" as const)
                      : nodeVisualStatus(state, n.id);
                  const sel = selectedId === n.id;
                  const highlighted = highlightedId === n.id;
                  const expandedWidth = 340;
                  const expandedLeft =
                    n.x + expandedWidth > layout.width - 12
                      ? Math.max(12, n.x + n.w - expandedWidth)
                      : n.x;
                  return (
                    <div
                      key={n.id}
                      className={`absolute ${sel ? "z-30" : "z-10"}`}
                      style={{
                        left: sel ? expandedLeft : n.x,
                        top: n.y,
                        width: sel ? expandedWidth : n.w,
                      }}
                    >
                      <button
                        type="button"
                        aria-expanded={sel}
                        onClick={() => setSelectedId(sel ? null : n.id)}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          setSelectedId(n.id);
                          if (usesPodPrograms) {
                            apply(queueResearchProgram(state, n.id));
                          } else {
                            startOrQueue(n.id);
                          }
                        }}
                        className={`relative block w-full rounded-lg border px-2 py-1.5 text-left transition ${nodeClass(st, sel, def.riskLevel)} ${sel ? "rounded-b-none !overflow-visible opacity-100" : ""} ${highlighted ? "ring-2 ring-research shadow-[0_0_1.5rem_rgba(147,116,255,0.45)]" : ""}`}
                        style={{ height: n.h }}
                        title={sel ? "Collapse research details" : def.description}
                      >
                        {def.riskLevel && (
                          <span className="absolute right-1.5 top-1 rounded border border-danger/50 bg-danger/15 px-1 font-mono text-[0.5rem] font-semibold uppercase tracking-wider text-danger">
                            {def.riskLevel} risk
                          </span>
                        )}
                        <div
                          className={`truncate text-[0.8125rem] font-medium leading-tight text-bone ${def.riskLevel ? "pr-14" : ""}`}
                        >
                          {def.name}
                        </div>
                        <div className="mt-0.5 flex items-center justify-between gap-2 font-mono text-[0.6875rem] tabular-nums text-muted">
                          <span>
                            {st === "done" ? (
                              <span className="text-mint">DONE</span>
                            ) : (
                              <>
                                {def.costPfDays} PF
                                {st === "queued" ? " · Q" : ""}
                                {st === "active" ? " · …" : ""}
                                {st === "blocked" || st === "locked"
                                  ? " · locked"
                                  : ""}
                              </>
                            )}
                          </span>
                          {sel && (
                            <span className="text-research">details ↑</span>
                          )}
                        </div>
                      </button>

                      {sel && selected && status && (
                        <div
                          className="panel-scroll hidden max-h-[30rem] overflow-y-auto rounded-b-lg border border-t-0 border-research/50 bg-panel-2 p-3 text-left shadow-[0_1rem_2.5rem_rgba(0,0,0,0.55)] backdrop-blur-md xl:block"
                          onPointerDown={(event) => event.stopPropagation()}
                          onWheel={(event) => event.stopPropagation()}
                        >
                          <div className="mb-2 flex items-start justify-between gap-2">
                            <p className="hud-eyebrow">
                              {
                                RESEARCH_BRANCHES[
                                  researchBranchForNode(selected.id)
                                ].label
                              }
                            </p>
                            <StatusChip tone={statusTone(status)}>
                              {status}
                            </StatusChip>
                          </div>

                          <div className="space-y-2">
                            {!usesPodPrograms && (
                              <div className="flex flex-wrap gap-1.5">
                                {status !== "done" &&
                                  status !== "active" &&
                                  status !== "queued" &&
                                  status !== "blocked" && (
                                    <HudButton
                                      variant="primary"
                                      className="!px-3 !py-1 text-[0.8125rem]"
                                      onClick={() => startOrQueue(selected.id)}
                                    >
                                      {status === "locked"
                                        ? `Queue unlock path${selectedPath.length > 1 ? ` (${selectedPath.length})` : ""}`
                                        : active
                                          ? "Queue"
                                          : "Start"}
                                    </HudButton>
                                  )}
                                {status === "available" && active && (
                                  <HudButton
                                    variant="ghost"
                                    className="!px-2 !py-1 text-[0.8125rem]"
                                    onClick={() =>
                                      apply(enqueueResearch(state, selected.id))
                                    }
                                  >
                                    Queue
                                  </HudButton>
                                )}
                                {status === "queued" && (
                                  <HudButton
                                    variant="ghost"
                                    className="!px-2 !py-1 text-[0.8125rem]"
                                    onClick={() =>
                                      apply(dequeueResearch(state, selected.id))
                                    }
                                  >
                                    Remove
                                  </HudButton>
                                )}
                              </div>
                            )}

                            {status === "available" &&
                              selectedPod &&
                              !selectedPod.assignmentId &&
                              !selectedProgram && (
                                <HudButton
                                  variant="primary"
                                  className="w-full"
                                  onClick={() =>
                                    apply(
                                      startResearchProgram(
                                        state,
                                        selected.id,
                                        selectedPod.id,
                                      ),
                                    )
                                  }
                                >
                                  Assign {selectedPod.name}
                                </HudButton>
                              )}
                            {usesPodPrograms &&
                              (status === "available" ||
                                status === "locked") && (
                                <HudButton
                                  variant="secondary"
                                  className="w-full"
                                  onClick={() =>
                                    apply(
                                      queueResearchProgram(state, selected.id),
                                    )
                                  }
                                >
                                  {status === "locked"
                                    ? `Queue unlock path${selectedPath.length > 1 ? ` · ${selectedPath.length} methods` : ""}`
                                    : "Queue for next available pod"}
                                </HudButton>
                              )}
                            {usesPodPrograms && status === "queued" && (
                              <HudButton
                                variant="ghost"
                                className="w-full"
                                onClick={() =>
                                  apply(
                                    dequeueResearchProgram(state, selected.id),
                                  )
                                }
                              >
                                Remove from queue
                              </HudButton>
                            )}

                            {selectedPod?.assignmentId &&
                              status === "available" && (
                                <div className="rounded-md border border-amber/30 bg-amber/10 px-2 py-1.5 text-[0.75rem] text-amber">
                                  {selectedPod.name} is already assigned. Select
                                  an available pod card.
                                </div>
                              )}
                            {selectedProgram && (
                              <div className="rounded-md border border-research/30 bg-research/10 px-2 py-1.5 text-[0.75rem] text-research">
                                In {selectedProgram.phase} with{" "}
                                {pods.find(
                                  (pod) => pod.id === selectedProgram.podId,
                                )?.name ?? "assigned pod"}{" "}
                                · {selectedProgram.evidence.length} evidence
                              </div>
                            )}

                            <p className="text-[0.8125rem] leading-snug text-muted">
                              {selected.description}
                            </p>

                            <div className="grid grid-cols-2 gap-x-3">
                              <StatRow
                                label="PF target"
                                value={`~${num(researchPfTarget(state, selected), 0)}`}
                                strong
                              />
                              <StatRow
                                label="Days"
                                value={`≥${researchDaysTarget(selected, researcherCount)}`}
                              />
                              <StatRow
                                label="Cash"
                                value={`~${money(researchCashEstimate(state, selected))}`}
                              />
                              <StatRow
                                label="Staff"
                                value={selectedStaffNeed
                                  ? `${selectedStaffNeed.researchers}R · ${selectedStaffNeed.engineers}E · ${selectedStaffNeed.dataStaff}D`
                                  : `${minResearchersForNode(selected.id)}R`}
                                tone={
                                  selectedStaffNeed &&
                                  researcherCount >= selectedStaffNeed.researchers &&
                                  (staff.engineer ?? 0) >= selectedStaffNeed.engineers &&
                                  (staff.data_processor ?? 0) >= selectedStaffNeed.dataStaff
                                    ? "positive"
                                    : "warning"
                                }
                              />
                              <StatRow
                                label="Rate now"
                                value={`${num(estimateResearchRate(state, selected.id).pfPerDay, 2)} PF/d`}
                                tone="research"
                              />
                              <StatRow
                                label="Power"
                                value={mw(snap.mwForecast.research)}
                              />
                            </div>

                            {selected.prereqs.length > 0 && (
                              <p className="text-[0.75rem] text-muted">
                                Needs{" "}
                                {selected.prereqs
                                  .map((p) => getResearchNode(p).name)
                                  .join(", ")}
                              </p>
                            )}

                            <EffectsLine effects={selected.effects} />

                            {selected.riskLevel && (
                              <div className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2">
                                <div className="font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-danger">
                                  {selected.riskLevel} variance
                                </div>
                                <p className="mt-1 text-[0.75rem] leading-snug text-muted">
                                  Higher breakthrough odds and capability
                                  upside, with more failed runs and a safety
                                  penalty.
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            {selected && status ? (
              <section
                ref={mobileSelectedMethodRef}
                className="mt-2 rounded-lg border border-research/45 bg-panel-2/95 p-3 xl:hidden"
                aria-label={`Selected research method: ${selected.name}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="hud-eyebrow">
                      {RESEARCH_BRANCHES[researchBranchForNode(selected.id)].label}
                    </p>
                    <h3 className="mt-0.5 text-sm font-semibold text-bone">
                      {selected.name}
                    </h3>
                  </div>
                  <StatusChip tone={statusTone(status)}>{status}</StatusChip>
                </div>

                <p className="mt-2 text-[0.8125rem] leading-5 text-muted">
                  {selected.description}
                </p>

                <div className="mt-2 grid grid-cols-2 gap-x-3">
                  <StatRow
                    label="PF target"
                    value={`~${num(researchPfTarget(state, selected), 0)}`}
                    strong
                  />
                  <StatRow
                    label="Days"
                    value={`≥${researchDaysTarget(selected, researcherCount)}`}
                  />
                  <StatRow
                    label="Cash"
                    value={`~${money(researchCashEstimate(state, selected))}`}
                  />
                  <StatRow
                    label="Staff"
                    value={
                      selectedStaffNeed
                        ? `${selectedStaffNeed.researchers}R · ${selectedStaffNeed.engineers}E · ${selectedStaffNeed.dataStaff}D`
                        : `${minResearchersForNode(selected.id)}R`
                    }
                    tone={
                      selectedStaffNeed &&
                      researcherCount >= selectedStaffNeed.researchers &&
                      (staff.engineer ?? 0) >= selectedStaffNeed.engineers &&
                      (staff.data_processor ?? 0) >= selectedStaffNeed.dataStaff
                        ? "positive"
                        : "warning"
                    }
                  />
                </div>

                {selectedProgram ? (
                  <p className="mt-2 rounded-md border border-research/30 bg-research/10 px-2 py-1.5 text-[0.75rem] text-research">
                    In {selectedProgram.phase} · {selectedProgram.evidence.length}{" "}
                    evidence
                  </p>
                ) : null}

                <div className="mt-3 grid gap-2 min-[420px]:grid-cols-2">
                  {!usesPodPrograms &&
                  status !== "done" &&
                  status !== "active" &&
                  status !== "queued" &&
                  status !== "blocked" ? (
                    <HudButton
                      variant="primary"
                      className="w-full"
                      onClick={() => startOrQueue(selected.id)}
                    >
                      {status === "locked"
                        ? `Queue unlock path${selectedPath.length > 1 ? ` (${selectedPath.length})` : ""}`
                        : active
                          ? "Queue"
                          : "Start"}
                    </HudButton>
                  ) : null}
                  {!usesPodPrograms && status === "queued" ? (
                    <HudButton
                      variant="ghost"
                      className="w-full"
                      onClick={() => apply(dequeueResearch(state, selected.id))}
                    >
                      Remove from queue
                    </HudButton>
                  ) : null}
                  {usesPodPrograms &&
                  status === "available" &&
                  selectedPod &&
                  !selectedPod.assignmentId &&
                  !selectedProgram ? (
                    <HudButton
                      variant="primary"
                      className="w-full"
                      onClick={() =>
                        apply(
                          startResearchProgram(state, selected.id, selectedPod.id),
                        )
                      }
                    >
                      Assign {selectedPod.name}
                    </HudButton>
                  ) : null}
                  {usesPodPrograms &&
                  (status === "available" || status === "locked") ? (
                    <HudButton
                      variant="secondary"
                      className="w-full"
                      onClick={() =>
                        apply(queueResearchProgram(state, selected.id))
                      }
                    >
                      Queue for next pod
                    </HudButton>
                  ) : null}
                  {usesPodPrograms && status === "queued" ? (
                    <HudButton
                      variant="ghost"
                      className="w-full"
                      onClick={() =>
                        apply(dequeueResearchProgram(state, selected.id))
                      }
                    >
                      Remove from queue
                    </HudButton>
                  ) : null}
                </div>

                {selected.prereqs.length > 0 ? (
                  <p className="mt-2 text-[0.75rem] text-muted">
                    Needs{" "}
                    {selected.prereqs
                      .map((prereq) => getResearchNode(prereq).name)
                      .join(", ")}
                  </p>
                ) : null}
                <div className="mt-2">
                  <EffectsLine effects={selected.effects} />
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

type CanvasView = { x: number; y: number; scale: number };

function useResearchCanvas(layout: ResearchTreeLayout) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<CanvasView>({ x: 24, y: 24, scale: 0.72 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(
    null,
  );
  const [zoom, setZoom] = useState(viewRef.current.scale);

  const applyView = useCallback((next: CanvasView) => {
    viewRef.current = next;
    const content = contentRef.current;
    if (content) {
      content.style.transformOrigin = "0 0";
      content.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.scale})`;
    }
    setZoom((current) =>
      Math.abs(current - next.scale) > 0.001 ? next.scale : current,
    );
  }, []);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const scale = Math.max(
      0.38,
      Math.min(
        1.05,
        Math.min(
          (bounds.width - 32) / layout.width,
          (bounds.height - 32) / layout.height,
        ),
      ),
    );
    applyView({
      x: (bounds.width - layout.width * scale) / 2,
      y: (bounds.height - layout.height * scale) / 2,
      scale,
    });
  }, [applyView, layout.height, layout.width]);

  const focus = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const fitScale = Math.min(
      1.05,
      Math.min(
        (bounds.width - 32) / layout.width,
        (bounds.height - 32) / layout.height,
      ),
    );
    const scale = Math.max(0.78, fitScale);
    applyView({
      x: 20,
      y: (bounds.height - layout.height * scale) / 2,
      scale,
    });
  }, [applyView, layout.height, layout.width]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(focus);
    return () => window.cancelAnimationFrame(frame);
  }, [focus]);

  const reset = useCallback(() => focus(), [focus]);

  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const bounds = viewport.getBoundingClientRect();
      const current = viewRef.current;
      const nextScale = Math.max(0.42, Math.min(1.6, current.scale * factor));
      const anchorX = (clientX ?? bounds.left + bounds.width / 2) - bounds.left;
      const anchorY = (clientY ?? bounds.top + bounds.height / 2) - bounds.top;
      const contentX = (anchorX - current.x) / current.scale;
      const contentY = (anchorY - current.y) / current.scale;
      applyView({
        x: anchorX - contentX * nextScale,
        y: anchorY - contentY * nextScale,
        scale: nextScale,
      });
    },
    [applyView],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest("button"))
        return;
      dragRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
      event.currentTarget.dataset.dragging = "true";
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      dragRef.current = { ...drag, x: event.clientX, y: event.clientY };
      const current = viewRef.current;
      applyView({ ...current, x: current.x + dx, y: current.y + dy });
    },
    [applyView],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      dragRef.current = null;
      delete event.currentTarget.dataset.dragging;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const onWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      zoomAt(event.deltaY > 0 ? 0.9 : 1.1, event.clientX, event.clientY);
    },
    [zoomAt],
  );

  const zoomBy = useCallback((factor: number) => zoomAt(factor), [zoomAt]);

  const centerNode = useCallback(
    (nodeId: string) => {
      const viewport = viewportRef.current;
      const node = layout.nodes.find((candidate) => candidate.id === nodeId);
      if (!viewport || !node) return;
      const bounds = viewport.getBoundingClientRect();
      const scale = Math.max(0.8, Math.min(1.15, viewRef.current.scale));
      applyView({
        x: bounds.width / 2 - (node.x + node.w / 2) * scale,
        y: bounds.height / 2 - (node.y + node.h / 2) * scale,
        scale,
      });
    },
    [applyView, layout.nodes],
  );

  return {
    viewportRef,
    contentRef,
    zoom,
    fit,
    reset,
    centerNode,
    zoomBy,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheel,
  };
}

function nodeClass(
  st: NodeVisualStatus,
  sel: boolean,
  riskLevel?: "elevated" | "high",
): string {
  const base = "overflow-hidden ";
  if (st === "done") return base + "border-mint/40 bg-mint/10";
  if (st === "active") return base + "border-research bg-research/20";
  if (st === "queued") return base + "border-amber/50 bg-amber/10";
  if (st === "available")
    return (
      base +
      (sel
        ? riskLevel
          ? "border-danger/80 bg-danger/10 ring-1 ring-danger/40"
          : "border-research/80 bg-panel-2 ring-1 ring-research/40"
        : riskLevel
          ? "border-danger/45 bg-danger/5 hover:border-danger/75"
          : "border-line bg-panel-2 hover:border-research/50")
    );
  if (st === "blocked" || st === "locked")
    return riskLevel
      ? base + "border-danger/30 bg-danger/5 opacity-65"
      : base + "border-line/40 bg-void/50 opacity-55";
  return base + "border-line/40 bg-void/40 opacity-50";
}

function EffectsLine({ effects }: { effects: ResearchEffects }) {
  const bits: string[] = [];
  if (effects.utilCap)
    bits.push(`usable compute +${(effects.utilCap * 100).toFixed(0)}%`);
  if (effects.servingEfficiency) {
    bits.push(`token speed +${(effects.servingEfficiency * 100).toFixed(0)}%`);
    bits.push(
      `inference compute/token −${(100 - 100 / (1 + effects.servingEfficiency)).toFixed(0)}%`,
    );
  }
  if (effects.trainEfficiency) {
    bits.push(`training speed +${(effects.trainEfficiency * 100).toFixed(0)}%`);
    bits.push(
      `training compute/token −${(100 - 100 / (1 + effects.trainEfficiency)).toFixed(0)}%`,
    );
  }
  if (effects.energyPue)
    bits.push(
      `facility power ${effects.energyPue < 0 ? "−" : "+"}${Math.abs(effects.energyPue * 100).toFixed(0)} PUE pts`,
    );
  if (effects.capabilityBonus)
    bits.push(`model capability +${effects.capabilityBonus}`);
  if (effects.moeInferMult)
    bits.push(
      `MoE compute/token −${((1 - effects.moeInferMult) * 100).toFixed(0)}%`,
    );
  if (effects.denseInferMult)
    bits.push(
      `dense compute/token ${effects.denseInferMult < 1 ? "−" : "+"}${Math.abs((1 - effects.denseInferMult) * 100).toFixed(0)}%`,
    );
  if (effects.chipDiscount)
    bits.push(`hardware cost −${(effects.chipDiscount * 100).toFixed(0)}%`);
  if (effects.dataFlywheel)
    bits.push(`data processing +${(effects.dataFlywheel * 100).toFixed(0)}%`);
  if (effects.benchmarkBoost) bits.push("evaluation lift");
  if (effects.unlockCorpusSpecialists) bits.push("specialist data processing");
  if (effects.unlockFamily) bits.push(`unlock ${effects.unlockFamily}`);
  if (effects.trainingBreakthroughBias)
    bits.push(
      `breakthrough odds +${(effects.trainingBreakthroughBias * 100).toFixed(0)} pts`,
    );
  if (effects.trainingStumbleRisk)
    bits.push(
      `failed-run risk +${(effects.trainingStumbleRisk * 100).toFixed(0)} pts`,
    );
  if (effects.trainingSafetyPenalty)
    bits.push(`model safety −${effects.trainingSafetyPenalty.toFixed(0)}`);
  if (bits.length === 0) return null;
  return (
    <p className="font-mono text-[0.75rem] text-research">{bits.join(" · ")}</p>
  );
}

function researchLineage(selectedId: string | null): Set<string> {
  const lineage = new Set<string>();
  const visit = (nodeId: string) => {
    if (lineage.has(nodeId)) return;
    lineage.add(nodeId);
    for (const prereq of getResearchNode(nodeId).prereqs) visit(prereq);
  };
  if (selectedId) visit(selectedId);
  return lineage;
}

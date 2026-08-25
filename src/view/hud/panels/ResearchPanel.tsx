import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type CSSProperties,
} from "react";
import {
  ArrowCounterClockwise,
  CornersOut,
  Lock,
  Minus,
  Plus,
  Trash,
} from "@phosphor-icons/react";
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
import { RESEARCH_POD_TEMPLATES } from "../../../sim/balance/researchPods";
import type {
  ResearchEffects,
  ResearchNodeDef,
  ResearchPod,
  ResearchProgram,
  SimState,
} from "../../../sim/types";
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
  effectiveResearchPodStaff,
  openResearchPod,
  queueResearchProgram,
  researchMethodRunnableOnPod,
  researchPodOpenStatus,
  researchPodQueueStallReason,
  researchPodStaffAvailability,
  researchPodStaffRequirements,
  researchProgramBlockReason,
  setActiveResearchProgram,
  setResearchPodStaff,
  startResearchProgram,
} from "../../../sim/systems/researchPrograms";
import { playerStaff } from "../../../sim/systems/staff";
import { useGameStore } from "../../../store/gameStore";
import { computeSnapshot } from "../../../sim/tick";
import {
  researchComputeUsage,
  type ResearchComputeUsage,
} from "../../../sim/systems/computeBreakdown";
import { money, mw, num } from "../format";
import { GameCard, LiveDot, MeterBar, StatRow } from "../ui/kit";
import {
  HudButton,
  MetricTile,
  PanelScaffold,
  StatusChip,
} from "../ui/HudPrimitives";
import { scrollMobileResearchSelection } from "./researchPanelMobile";
import {
  RESEARCH_TREE_DEFAULT_ZOOM,
  RESEARCH_TREE_MIN_ZOOM,
} from "./researchCanvasLayout";
import { consumeChartEscape } from "../ui/dataViz/chartInteraction";
import {
  ancestorClassTokens,
  initialResearchViewportNodeId,
  nextResearchSelection,
  researchNodeSummaryId,
  researchRelationshipSet,
  researchRelationshipTargets,
  shouldClearResearchSelection,
} from "./researchPanelA11y";

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

export function researchPoolTileValue(usage: ResearchComputeUsage): string {
  if (usage.usedPf > 0.001) {
    return `${num(usage.usedPf, 2)} / ${num(usage.poolPf, 2)} PF`;
  }
  return `${num(usage.poolPf, 2)} PF`;
}

export function researchPoolTileDetail(usage: ResearchComputeUsage): string {
  const draw = `${mw(usage.powerMw)} physical draw`;
  if (usage.slices.length === 0) return `idle · ${draw}`;
  return `${usage.slices.map((slice) => slice.short).join(" · ")} · ${draw}`;
}

export function researchPoolTileTitle(usage: ResearchComputeUsage): string {
  if (usage.slices.length === 0) {
    return `${num(usage.poolPf, 2)} PF reserved · idle`;
  }
  return usage.slices
    .map((slice) => `${num(slice.pf, 2)} PF ${slice.label.toLowerCase()}`)
    .join(" · ");
}

export function ResearchPanel() {
  const state = useGameStore((s) => s.state);
  const focusRequest = useGameStore((s) => s.researchFocusRequest);
  const setState = useGameStore.setState;
  const snap = computeSnapshot(state);
  const researchUsage = researchComputeUsage(state, snap);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPodId, setSelectedPodId] = useState(
    () => state.player.researchPods?.[0]?.id ?? "",
  );
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [queuedPulseId, setQueuedPulseId] = useState<string | null>(null);
  const selectedMethodRef = useRef<HTMLDivElement | null>(null);

  const active = state.player.activeResearch;
  const legacyQueue = state.player.researchQueue;
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
          program.methodId === selectedId &&
          program.phase !== "complete" &&
          pods.some((pod) => pod.assignmentId === program.id),
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
            .filter((program) =>
              pods.some((pod) => pod.assignmentId === program.id),
            )
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
  const focusedId = hoveredId ?? selectedId;
  const focusedRelationships = useMemo(
    () => researchRelationshipSet(focusedId),
    [focusedId],
  );

  const apply = (next: typeof state) => setState({ state: next });
  const layout = FULL_RESEARCH_LAYOUT;
  const canvas = useResearchCanvas(layout);
  const centerResearchNode = canvas.centerNode;
  const relationshipTargets = useMemo(
    () =>
      new Map(
        layout.nodes.map((node) => [
          node.id,
          researchRelationshipTargets(layout, node.id),
        ]),
      ),
    [layout],
  );

  const moveResearchRelationship = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    nodeId: string,
  ) => {
    const relation = relationshipTargets.get(nodeId);
    if (!relation) return;
    const targetIds =
      event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? relation.incoming
        : event.key === "ArrowRight" || event.key === "ArrowDown"
          ? relation.outgoing
          : [];
    const nextId = targetIds[0];
    if (!nextId) return;
    event.preventDefault();
    setSelectedId(nextId);
    centerResearchNode(nextId);
  };

  const activePrograms = programs.filter((program) =>
    pods.some((pod) => pod.assignmentId === program.id),
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
      scrollMobileResearchSelection(selectedMethodRef.current, true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (!shouldClearResearchSelection(ancestorClassTokens(event.target))) return;
      setSelectedId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const ui = useGameStore.getState();
      if (ui.hotkeyHelpOpen || ui.pauseMenuOpen) return;
      consumeChartEscape(event, () => setSelectedId(null));
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [selectedId]);

  const startOrQueue = (id: string) => apply(startResearch(state, id));
  const queueNode = (id: string) => {
    apply(usesPodPrograms ? queueResearchProgram(state, id) : enqueueResearch(state, id));
    setQueuedPulseId(id);
    window.setTimeout(() => setQueuedPulseId((current) => (current === id ? null : current)), 900);
  };
  const L = RESEARCH_LAYOUT;

  return (
    <PanelScaffold
      eyebrow="Leads · pods · methods"
      title="Research"
      description="Burn research PF and cash for unlocks."
      actions={<StatusChip tone="research">{num(snap.pools.research, 2)} PF</StatusChip>}
      className="research-panel-section"
    >
      <div className="research-panel-body flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain pb-2 xl:pb-0">
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricTile
            label="Pool"
            value={researchPoolTileValue(researchUsage)}
            detail={researchPoolTileDetail(researchUsage)}
            title={researchPoolTileTitle(researchUsage)}
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

      <div className="research-workbench-layout flex min-h-0 flex-1 flex-col gap-2 overflow-visible">
        <aside className="research-workbench-queue order-1 flex min-h-0 w-full shrink-0 flex-col gap-2">
          <div className="panel-scroll min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-0.5">
            {usesPodPrograms ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="inline-flex items-center gap-1.5 text-[0.8125rem] text-muted">
                    {(activePrograms.length > 0 || !!active) && (
                      <LiveDot className="text-research" />
                    )}
                    Pods
                  </p>
                </div>
                <ResearchPodRoster
                  state={state}
                  selectedPodId={selectedPodId}
                  onSelectPod={setSelectedPodId}
                  apply={apply}
                />
                {queue.length > 0 && (
                  <GameCard
                    eyebrow="Queued"
                    title={`${queue.length} waiting`}
                    tone="research"
                    pad={false}
                  >
                    <ResearchProgramQueue
                      state={state}
                      queue={queue}
                      selectedPodId={selectedPodId}
                      onSelectMethod={(id) => {
                        setSelectedId(id);
                        centerResearchNode(id);
                      }}
                      apply={apply}
                    />
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
                      <HudButton
                        type="button"
                        variant="ghost"
                        className="min-h-11 rounded-full border border-research/40 bg-research/10 px-2 py-0.5 text-[0.75rem] text-research"
                        onClick={() => {
                          setSelectedId(active.nodeId);
                          centerResearchNode(active.nodeId);
                        }}
                      >
                        {getResearchNode(active.nodeId).name}
                      </HudButton>
                    ) : null}
                    {queue.map((id, index) => (
                      <div
                        key={id}
                        className="flex items-center gap-0.5 rounded-full border border-line bg-panel-2 pl-2 text-[0.75rem]"
                      >
                        <span className="font-mono tabular-nums text-muted">
                          {index + 1}.
                        </span>
                        <HudButton
                          type="button"
                          variant="ghost"
                          className="min-h-11 max-w-[90px] truncate text-bone"
                          onClick={() => {
                            setSelectedId(id);
                            centerResearchNode(id);
                          }}
                        >
                          {getResearchNode(id).name}
                        </HudButton>
                        <HudButton
                          type="button"
                          variant="ghost"
                          aria-label={"Move " + getResearchNode(id).name + " earlier"}
                          className="min-h-11 min-w-11 px-1 text-muted hover:text-bone"
                          onClick={() => apply(moveQueue(state, id, -1))}
                        >
                          ↑
                        </HudButton>
                        <HudButton
                          type="button"
                          variant="ghost"
                          aria-label={"Move " + getResearchNode(id).name + " later"}
                          className="min-h-11 min-w-11 px-1 text-muted hover:text-bone"
                          onClick={() => apply(moveQueue(state, id, 1))}
                        >
                          ↓
                        </HudButton>
                        <HudButton
                          type="button"
                          variant="ghost"
                          aria-label={"Remove " + getResearchNode(id).name + " from research queue"}
                          className="min-h-11 min-w-11 pr-1.5 text-muted hover:text-danger"
                          onClick={() => apply(dequeueResearch(state, id))}
                        >
                          <Trash aria-hidden="true" size="0.8rem" weight="bold" />
                        </HudButton>
                      </div>
                    ))}
                  </div>
                )}
              </GameCard>
            )}
          </div>
        </aside>

        <div className="research-workbench-main order-2 flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-visible">
          <div className="research-canvas-column grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-visible">
            <div className="research-tree-shell relative min-h-0">
              <div
              ref={canvas.viewportRef}
              onPointerDown={canvas.onPointerDown}
              onPointerMove={canvas.onPointerMove}
              onPointerUp={canvas.onPointerUp}
              onPointerCancel={canvas.onPointerUp}
              onWheel={canvas.onWheel}
                className="research-tree-stage relative touch-pan-y select-none overflow-hidden rounded-lg border border-line bg-void/90 cursor-grab data-[dragging=true]:cursor-grabbing sm:touch-none"
              role="group"
              aria-roledescription="research tree"
              aria-label="Interactive research tree. Drag to pan and use the zoom controls to inspect methods."
              aria-describedby="research-tree-summary"
            >
              <div id="research-tree-summary" className="sr-only">
                Research tree with {layout.nodes.length} methods and {layout.edges.length} prerequisite connections. Select a method to inspect its requirements, effects, and queue actions.
                <span>Research prerequisite relationships:</span>
                <ul>
                  {layout.edges.map((edge) => (
                    <li key={"summary-" + edge.from + "-" + edge.to}>
                      {getResearchNode(edge.from).name} unlocks {getResearchNode(edge.to).name}.
                    </li>
                  ))}
                </ul>
              </div>
              <div className="research-tree-toolbar absolute right-2 top-2 z-40 flex items-center gap-1 rounded-lg border border-line bg-panel/95 p-1.5 shadow-lg backdrop-blur-md sm:right-3 sm:top-3">
                <span className="min-w-12 rounded bg-void/70 px-2 py-1 text-center font-mono text-[0.6875rem] tabular-nums text-bone">
                  {Math.round(canvas.zoom * 100)}%
                </span>
                <HudButton
                  variant="ghost"
                  className="!h-11 !min-h-0 !w-11 !p-0 lg:!h-8 lg:!w-8"
                  onClick={() => canvas.zoomBy(0.84)}
                  aria-label="Zoom research tree out"
                >
                  <Minus size="0.9rem" weight="bold" aria-hidden />
                </HudButton>
                <HudButton
                  variant="ghost"
                  className="!h-11 !min-h-0 !w-11 !p-0 lg:!h-8 lg:!w-8"
                  onClick={() => canvas.zoomBy(1.19)}
                  aria-label="Zoom research tree in"
                >
                  <Plus size="0.9rem" weight="bold" aria-hidden />
                </HudButton>
                <HudButton
                  variant="ghost"
                  className="!h-11 !min-h-0 !w-11 !p-0 lg:!h-8 lg:!w-8"
                  onClick={canvas.fit}
                  title="Fit the full research tree"
                  aria-label="Fit the full research tree"
                >
                  <CornersOut size="0.9rem" aria-hidden />
                </HudButton>
                <HudButton
                  variant="ghost"
                  className="!h-11 !min-h-0 !w-11 !p-0 lg:!h-8 lg:!w-8"
                  onClick={canvas.reset}
                  aria-label="Reset research tree view"
                  title="Reset view"
                >
                  <ArrowCounterClockwise size="0.9rem" aria-hidden />
                </HudButton>
              </div>
              <div className="pointer-events-none absolute bottom-2 left-2 z-20 rounded-md border border-line/70 bg-panel/85 px-2 py-1 font-mono text-[0.625rem] text-muted backdrop-blur-md">
                <span className="sm:hidden">tap select · Queue action · pinch/drag</span>
                <span className="hidden sm:inline">click select · double-click or Queue to queue</span>
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
                  aria-hidden="true"
                >
                  {layout.edges.map((e) => {
                    const horizontal =
                      Math.abs(e.x2 - e.x1) >= Math.abs(e.y2 - e.y1);
                    const midX = (e.x1 + e.x2) / 2;
                    const midY = (e.y1 + e.y2) / 2;
                    const done = state.player.researchUnlocked.includes(e.from);
                    const focusedEdge =
                      focusedRelationships.has(e.from) && focusedRelationships.has(e.to);
                    const path = horizontal
                      ? `M ${e.x1} ${e.y1} C ${midX} ${e.y1}, ${midX} ${e.y2}, ${e.x2} ${e.y2}`
                      : `M ${e.x1} ${e.y1} C ${e.x1} ${midY}, ${e.x2} ${midY}, ${e.x2} ${e.y2}`;
                    return (
                      <g key={`${e.from}-${e.to}`}>
                        <path
                          d={path}
                          fill="none"
                          stroke={
                            focusedEdge
                              ? "#bda8ff"
                              : e.crossTrunk
                                ? done
                                  ? "#3dffc044"
                                  : "#2a2f3a88"
                                : done
                                  ? "#3dffc088"
                                  : "#3a4150"
                          }
                          strokeWidth={focusedEdge ? (e.crossTrunk ? 2 : 2.5) : e.crossTrunk ? 1 : 1.5}
                          strokeDasharray={e.crossTrunk ? "4 3" : undefined}
                        />
                        {focusedEdge ? (
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
                      candidate.phase !== "complete" &&
                      pods.some((pod) => pod.assignmentId === candidate.id),
                  );
                  const st = program
                    ? ("active" as const)
                    : queue.includes(n.id)
                      ? ("queued" as const)
                      : nodeVisualStatus(state, n.id);
                  const sel = selectedId === n.id;
                  const highlighted = highlightedId === n.id;
                  const related = !focusedId || focusedRelationships.has(n.id);
                  const inLineage = selectedLineage.has(n.id);
                  const relation = relationshipTargets.get(n.id) ?? {
                    incoming: [],
                    outgoing: [],
                  };
                  const summaryId = researchNodeSummaryId(n.id);
                  const nodeStyle = {
                    "--research-node-height": `${n.h}px`,
                    "--research-tree-zoom": canvas.zoom,
                  } as CSSProperties;
                  return (
                    <div
                      key={n.id}
                      className={`absolute ${sel ? "z-20" : "z-30"}`}
                      style={{
                        left: n.x,
                        top: n.y,
                        width: n.w,
                      }}
                    >
                      <button
                        type="button"
                        aria-expanded={sel}
                        aria-describedby={summaryId}
                        aria-keyshortcuts="Enter Shift+Enter Escape ArrowLeft ArrowRight ArrowUp ArrowDown"
                        onMouseEnter={() => setHoveredId(n.id)}
                        onMouseLeave={() => setHoveredId((current) => (current === n.id ? null : current))}
                        onFocus={() => setHoveredId(n.id)}
                        onBlur={() => setHoveredId((current) => (current === n.id ? null : current))}
                        onClick={() =>
                          setSelectedId((current) => nextResearchSelection(current, n.id))
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && event.shiftKey) {
                            event.preventDefault();
                            queueNode(n.id);
                            return;
                          }
                          if (event.key === "Escape") {
                            consumeChartEscape(event, () => setSelectedId(null));
                            return;
                          }
                          moveResearchRelationship(event, n.id);
                        }}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          queueNode(n.id);
                        }}
                        className={`research-node-hit relative block min-h-11 w-full border-0 bg-transparent p-0 text-left ${related ? "research-node-related" : "research-node-dimmed"} ${hoveredId === n.id ? "research-node-hovered" : ""}`}
                        style={nodeStyle}
                        title={sel ? "Research details are open beside this method" : def.description}
                        data-related={related ? "true" : "false"}
                        data-lineage={inLineage ? "true" : "false"}
                      >
                        <span
                          aria-hidden="true"
                          className={`research-node-surface relative block w-full rounded-lg border px-2 py-1.5 text-left transition ${nodeClass(st, sel, def.riskLevel)} ${sel ? "rounded-b-none !overflow-visible opacity-100" : ""} ${highlighted ? "ring-2 ring-research shadow-[0_0_1.5rem_rgba(147,116,255,0.45)]" : ""}`}
                          style={{ height: n.h }}
                        >
                          {def.riskLevel && (
                            <span className="absolute right-1.5 top-1 rounded border border-danger/50 bg-danger/15 px-1 font-mono text-[0.5rem] font-semibold uppercase tracking-wider text-danger">
                              {def.riskLevel} risk
                            </span>
                          )}
                          <span
                            className={`truncate text-[0.8125rem] font-medium leading-tight text-bone ${def.riskLevel ? "pr-14" : ""}`}
                          >
                            {def.name}
                          </span>
                          <span className="mt-0.5 flex items-center justify-between gap-2 font-mono text-[0.6875rem] tabular-nums text-muted">
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
                            {sel && <span className="text-research">details beside</span>}
                          </span>
                        </span>
                      </button>
                      <HudButton
                        type="button"
                        variant="ghost"
                        aria-label={`Queue ${def.name}`}
                        title={`Queue ${def.name}`}
                        className={`research-node-queue-action absolute bottom-1 right-1 z-20 !min-h-7 !h-7 !min-w-7 !rounded-md !px-1 text-[0.625rem] ${queuedPulseId === n.id ? "!border-research !bg-research/20 !text-research" : "!border-line/70 !bg-void/80 !text-muted"}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedId(n.id);
                          queueNode(n.id);
                        }}
                      >
                        Q
                      </HudButton>
                      <span id={summaryId} className="sr-only">
                        {def.name}. Status: {st}.{" "}
                        {relation.incoming.length > 0
                          ? "Requires " +
                            relation.incoming
                              .map((id) => getResearchNode(id).name)
                              .join(", ") +
                            ". "
                          : "No prerequisites. "}
                        {relation.outgoing.length > 0
                          ? "Unlocks " +
                            relation.outgoing
                              .map((id) => getResearchNode(id).name)
                              .join(", ") +
                            "."
                          : "Unlocks no further methods."}
                      </span>
                    </div>
                  );
                })}
              </div>
              </div>
            {selected && status ? (
              <div
                ref={selectedMethodRef}
                className="research-method-detail absolute z-[25] min-w-0"
                style={canvas.detailPosition(selected.id)}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <ResearchMethodDetail
                  state={state}
                  selected={selected}
                  status={status}
                  usesPodPrograms={usesPodPrograms}
                  selectedPath={selectedPath}
                  selectedPod={selectedPod}
                  selectedProgram={selectedProgram}
                  active={Boolean(active)}
                  pods={pods}
                  researcherCount={researcherCount}
                  selectedStaffNeed={selectedStaffNeed}
                  staff={staff}
                  snap={snap}
                  apply={apply}
                  startOrQueue={startOrQueue}
                  showTitle
                />
              </div>
            ) : null}
            </div>
          </div>
        </div>
      </div>
      </div>
    </PanelScaffold>
  );
}

export function ResearchProgramQueue({
  state,
  queue,
  selectedPodId,
  onSelectMethod,
  apply,
}: {
  state: SimState;
  queue: string[];
  selectedPodId: string;
  onSelectMethod: (id: string) => void;
  apply: (next: SimState) => void;
}) {
  const pods = state.player.researchPods ?? [];
  const targetPod =
    pods.find((pod) => pod.id === selectedPodId) ??
    pods.find((pod) => pod.assignmentId) ??
    pods[0];
  return (
    <ul className="research-queue-list">
      {queue.map((id) => {
        const method = getResearchNode(id);
        const runnable = targetPod
          ? researchMethodRunnableOnPod(state, targetPod, id)
          : { ok: false as const, reason: "Research pod not found." };
        return (
          <li key={id} className="research-queue-row">
            <HudButton
              type="button"
              variant="ghost"
              className="research-queue-name"
              onClick={() => onSelectMethod(id)}
            >
              {method.name}
            </HudButton>
            <div className="research-queue-actions">
              <HudButton
                type="button"
                variant="ghost"
                className="research-queue-action"
                disabled={!runnable.ok}
                disabledReason={runnable.ok ? undefined : runnable.reason}
                aria-label={`Set ${method.name} as active research`}
                onClick={() =>
                  apply(setActiveResearchProgram(state, id, targetPod?.id))
                }
              >
                Active
              </HudButton>
              <HudButton
                type="button"
                variant="ghost"
                className="research-queue-action"
                aria-label={`Unqueue ${method.name}`}
                title="Unqueue"
                onClick={() => apply(dequeueResearchProgram(state, id))}
              >
                <Trash aria-hidden="true" size="0.8rem" weight="bold" />
              </HudButton>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ResearchPodRoster({
  state,
  selectedPodId,
  onSelectPod,
  apply,
}: {
  state: SimState;
  selectedPodId: string;
  onSelectPod: (id: string) => void;
  apply: (next: SimState) => void;
}) {
  const opened = new Map(
    (state.player.researchPods ?? []).map((pod) => [pod.id, pod]),
  );
  const leads = state.player.researchLeads ?? [];
  const programs = state.player.researchPrograms ?? [];
  return (
    <div className="anim-stagger grid gap-1.5">
      {RESEARCH_POD_TEMPLATES.map((template) => {
        const pod = opened.get(template.id);
        if (pod) {
          const lead = leads.find((candidate) => candidate.id === pod.leadId);
          const program = programs.find(
            (candidate) => candidate.id === pod.assignmentId,
          );
          const selected = pod.id === selectedPodId;
          const progress = program ? programProgress(program) : 0;
          const seated = effectiveResearchPodStaff(state, pod);
          const blockReason = program
            ? researchProgramBlockReason(state, program)
            : researchPodQueueStallReason(state, pod);
          return (
            <GameCard
              key={pod.id}
              title={pod.name}
              tone="research"
              live={!!program}
              pad={false}
              interactive={!selected}
              selected={selected}
              ariaLabel={`Select research pod ${pod.name}`}
              onActivate={() => onSelectPod(pod.id)}
              className="research-pod-card min-h-0"
              actions={
                <StatusChip tone={program ? "research" : "neutral"}>
                  {program?.phase ?? "idle"}
                </StatusChip>
              }
            >
              <div className="space-y-1.5 px-2.5 py-2">
                <p className="truncate text-[0.6875rem] text-muted">
                  {lead?.name ?? "No lead"}
                  <span className="font-mono text-bone/80">
                    {" "}
                    · {seated.researchers}/{seated.engineers}/{seated.dataStaff}
                  </span>
                </p>
                {program ? (
                  <div className="space-y-1">
                    <MeterBar
                      label={getResearchNode(program.methodId).name}
                      value={progress}
                      detail={`${Math.round(progress * 100)}%`}
                      tone="research"
                      live
                    />
                    <HudButton
                      type="button"
                      variant="ghost"
                      className="research-queue-action !w-full"
                      aria-label={`Unqueue ${getResearchNode(program.methodId).name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        apply(dequeueResearchProgram(state, program.methodId));
                      }}
                    >
                      Unqueue
                    </HudButton>
                  </div>
                ) : null}
                {blockReason ? (
                  <p
                    className="text-[0.625rem] leading-4 text-amber"
                    role="status"
                  >
                    {blockReason}
                  </p>
                ) : null}
                {selected ? (
                  <ResearchPodStaffEditor
                    state={state}
                    pod={pod}
                    program={program}
                    apply={apply}
                  />
                ) : null}
              </div>
            </GameCard>
          );
        }

        const status = researchPodOpenStatus(state, template.id)!;
        const prerequisite = template.requiresResearch
          ? getResearchNode(template.requiresResearch)
          : undefined;
        const ready = status.prerequisiteMet && status.affordable;
        return (
          <GameCard
            key={template.id}
            title={template.podName}
            pad={false}
            className="research-pod-card min-h-0 opacity-[0.78]"
            actions={
              <StatusChip tone={ready ? "research" : "warning"}>
                {ready ? "ready" : "locked"}
              </StatusChip>
            }
          >
            <div className="space-y-1.5 px-2.5 py-2">
              <p className="flex items-start gap-1.5 text-[0.6875rem] leading-snug text-muted">
                {!status.prerequisiteMet ? (
                  <Lock
                    size="0.75rem"
                    className="mt-0.5 shrink-0 text-amber"
                    aria-hidden
                  />
                ) : null}
                <span>
                  {!status.prerequisiteMet
                    ? `Requires ${prerequisite?.name ?? template.requiresResearch}`
                    : !status.affordable
                      ? `Need ${money(template.openCost)}`
                      : `${template.lead.name} · ${money(template.openCost)}`}
                </span>
              </p>
              {status.prerequisiteMet ? (
                <HudButton
                  type="button"
                  variant={ready ? "primary" : "ghost"}
                  className="!min-h-9 !w-full !px-2 !py-1 !text-[0.6875rem]"
                  disabled={!ready}
                  title={
                    !status.affordable
                      ? `Need ${money(template.openCost)} to open ${template.podName}`
                      : `Open ${template.podName}`
                  }
                  onClick={() => {
                    apply(openResearchPod(state, template.id));
                    onSelectPod(template.id);
                  }}
                >
                  Open
                </HudButton>
              ) : null}
            </div>
          </GameCard>
        );
      })}
    </div>
  );
}

function ResearchPodStaffEditor({
  state,
  pod,
  program,
  apply,
}: {
  state: SimState;
  pod: ResearchPod;
  program?: ResearchProgram;
  apply: (next: SimState) => void;
}) {
  const availability = researchPodStaffAvailability(state, pod.id);
  const required = program
    ? researchPodStaffRequirements(program.methodId)
    : { researchers: 0, engineers: 0, dataStaff: 0 };
  const roles = [
    {
      key: "researchers" as const,
      short: "R",
      label: "Researchers",
    },
    {
      key: "engineers" as const,
      short: "E",
      label: "Engineers",
    },
    {
      key: "dataStaff" as const,
      short: "D",
      label: "Data staff",
    },
  ];
  return (
    <section
      className="research-pod-staff-editor border-t border-research/25 pt-1.5"
      aria-label={`${pod.name} staff assignment`}
    >
      <div className="research-pod-staff">
        {roles.map(({ key, short, label }) => {
          const assigned = Math.max(0, pod[key]);
          const minimum = required[key];
          const max = availability.available[key];
          return (
            <div key={key} className="research-pod-staff-row">
              <span className="research-pod-staff-label">
                <span className="sr-only">{label}</span>
                <span aria-hidden>{short}</span>
              </span>
              <HudButton
                type="button"
                variant="ghost"
                aria-label={`Release one ${label.toLowerCase()} from ${pod.name}`}
                disabled={assigned <= minimum}
                onClick={() =>
                  apply(setResearchPodStaff(state, pod.id, key, -1))
                }
              >
                −
              </HudButton>
              <span className="research-pod-staff-value">{assigned}</span>
              <HudButton
                type="button"
                variant="ghost"
                aria-label={`Assign one ${label.toLowerCase()} to ${pod.name}`}
                disabled={assigned >= max}
                onClick={() =>
                  apply(setResearchPodStaff(state, pod.id, key, 1))
                }
              >
                +
              </HudButton>
            </div>
          );
        })}
      </div>
    </section>
  );
}

type ResearchDetailStatus = NodeVisualStatus | "active" | "queued";

type ResearchMethodDetailProps = {
  state: SimState;
  selected: ResearchNodeDef;
  status: ResearchDetailStatus;
  usesPodPrograms: boolean;
  selectedPath: string[];
  selectedPod?: ResearchPod;
  selectedProgram?: ResearchProgram;
  active: boolean;
  pods: ResearchPod[];
  researcherCount: number;
  selectedStaffNeed: ReturnType<typeof researchPodStaffRequirements> | null;
  staff: ReturnType<typeof playerStaff>;
  snap: ReturnType<typeof computeSnapshot>;
  apply: (next: SimState) => void;
  startOrQueue: (id: string) => void;
  showTitle?: boolean;
};

function ResearchMethodDetail({
  state,
  selected,
  status,
  usesPodPrograms,
  selectedPath,
  selectedPod,
  selectedProgram,
  active,
  pods,
  researcherCount,
  selectedStaffNeed,
  staff,
  snap,
  apply,
  startOrQueue,
  showTitle = true,
}: ResearchMethodDetailProps) {
  const buttonClass = "min-h-11 w-full";
  return (
    <div
      className="rounded-lg border border-research/45 bg-panel-2/95 p-3 text-left"
      aria-label={showTitle ? `Selected research method: ${selected.name}` : undefined}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="hud-eyebrow">
            {RESEARCH_BRANCHES[researchBranchForNode(selected.id)].label}
          </p>
          {showTitle ? (
            <h3 className="mt-0.5 truncate text-sm font-semibold text-bone">
              {selected.name}
            </h3>
          ) : null}
        </div>
        <StatusChip tone={statusTone(status)}>{status}</StatusChip>
      </div>

      <div className="space-y-2">
        {!usesPodPrograms ? (
          <div className="flex flex-wrap gap-1.5">
            {status !== "done" &&
            status !== "active" &&
            status !== "queued" &&
            status !== "blocked" ? (
              <HudButton
                variant="primary"
                className={buttonClass}
                onClick={() => startOrQueue(selected.id)}
              >
                {status === "locked"
                  ? `Queue unlock path${selectedPath.length > 1 ? ` (${selectedPath.length})` : ""}`
                  : active
                    ? "Queue"
                    : "Start"}
              </HudButton>
            ) : null}
            {status === "available" && active ? (
              <HudButton
                variant="ghost"
                className={buttonClass}
                onClick={() => apply(enqueueResearch(state, selected.id))}
              >
                Queue
              </HudButton>
            ) : null}
            {status === "queued" ? (
              <HudButton
                variant="ghost"
                className={buttonClass}
                onClick={() => apply(dequeueResearch(state, selected.id))}
              >
                Remove
              </HudButton>
            ) : null}
          </div>
        ) : null}

        {status === "available" &&
        selectedPod &&
        !selectedPod.assignmentId &&
        !selectedProgram ? (
          <HudButton
            variant="primary"
            className={buttonClass}
            onClick={() =>
              apply(startResearchProgram(state, selected.id, selectedPod.id))
            }
          >
            Assign {selectedPod.name}
          </HudButton>
        ) : null}
        {usesPodPrograms && (status === "available" || status === "locked") ? (
          <HudButton
            variant="secondary"
            className={buttonClass}
            onClick={() => apply(queueResearchProgram(state, selected.id))}
          >
            {status === "locked"
              ? `Queue unlock path${selectedPath.length > 1 ? ` · ${selectedPath.length} methods` : ""}`
              : "Queue for next available pod"}
          </HudButton>
        ) : null}
        {usesPodPrograms && status === "queued" ? (
          <HudButton
            variant="ghost"
            className={buttonClass}
            onClick={() => apply(dequeueResearchProgram(state, selected.id))}
          >
            Unqueue
          </HudButton>
        ) : null}
        {usesPodPrograms && status === "active" && selectedProgram ? (
          <HudButton
            variant="ghost"
            className={buttonClass}
            onClick={() => apply(dequeueResearchProgram(state, selected.id))}
          >
            Unqueue
          </HudButton>
        ) : null}

        {selectedPod?.assignmentId && status === "available" ? (
          <div className="rounded-md border border-amber/30 bg-amber/10 px-2 py-1.5 text-[0.75rem] text-amber">
            {selectedPod.name} is already assigned. Select an available pod card.
          </div>
        ) : null}
        {selectedProgram ? (
          <div className="rounded-md border border-research/30 bg-research/10 px-2 py-1.5 text-[0.75rem] text-research">
            In {selectedProgram.phase} with{" "}
            {pods.find((pod) => pod.id === selectedProgram.podId)?.name ?? "assigned pod"}{" "}
            · {selectedProgram.evidence.length} evidence
          </div>
        ) : null}

        <p className="text-[0.8125rem] leading-snug text-muted">{selected.description}</p>

        <div className="grid grid-cols-2 gap-x-3">
          <StatRow
            label="PF target"
            value={`~${num(researchPfTarget(state, selected), 0)}`}
            strong
          />
          <StatRow label="Days" value={`≥${researchDaysTarget(selected, researcherCount)}`} />
          <StatRow label="Cash" value={`~${money(researchCashEstimate(state, selected))}`} />
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
          <StatRow
            label="Rate now"
            value={`${num(estimateResearchRate(state, selected.id).pfPerDay, 2)} PF/d`}
            tone="research"
          />
          <StatRow label="Power" value={mw(snap.mwForecast.research)} />
        </div>

        {selected.prereqs.length > 0 ? (
          <p className="text-[0.75rem] text-muted">
            Needs {selected.prereqs.map((prereq) => getResearchNode(prereq).name).join(", ")}
          </p>
        ) : null}
        <EffectsLine effects={selected.effects} />
        {selected.riskLevel ? (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2">
            <div className="font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-danger">
              {selected.riskLevel} variance
            </div>
            <p className="mt-1 text-[0.75rem] leading-snug text-muted">
              Higher breakthrough odds and capability upside, with more failed runs and a safety penalty.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type CanvasView = { x: number; y: number; scale: number };

function useResearchCanvas(layout: ResearchTreeLayout) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<CanvasView>({
    x: 24,
    y: 24,
    scale: RESEARCH_TREE_DEFAULT_ZOOM,
  });
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(
    null,
  );
  const [view, setView] = useState(viewRef.current);

  const applyView = useCallback((next: CanvasView) => {
    viewRef.current = next;
    const content = contentRef.current;
    if (content) {
      content.style.transformOrigin = "0 0";
      content.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.scale})`;
    }
    // Keep panning reactive as well as zooming so an anchored detail card
    // follows its node without forcing a camera recenter.
    setView(next);
  }, []);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const scale = Math.max(
      RESEARCH_TREE_MIN_ZOOM,
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

  const centerAtScale = useCallback(
    (scale: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const bounds = viewport.getBoundingClientRect();
      applyView({
        x: (bounds.width - layout.width * scale) / 2,
        y: (bounds.height - layout.height * scale) / 2,
        scale,
      });
    },
    [applyView, layout.height, layout.width],
  );

  const readableDefault = useCallback(() => {
    const viewport = viewportRef.current;
    const nodeId = initialResearchViewportNodeId(layout);
    const node = nodeId
      ? layout.nodes.find((candidate) => candidate.id === nodeId)
      : undefined;
    if (!viewport || !node) {
      centerAtScale(RESEARCH_TREE_DEFAULT_ZOOM);
      return;
    }
    const bounds = viewport.getBoundingClientRect();
    const scale = RESEARCH_TREE_DEFAULT_ZOOM;
    applyView({
      // Roots flow left-to-right. Keep the starting method near the leading
      // edge so its outgoing branches, rather than empty history, fill the
      // initial viewport.
      x: bounds.width * 0.18 - (node.x + node.w / 2) * scale,
      y: bounds.height / 2 - (node.y + node.h / 2) * scale,
      scale,
    });
  }, [applyView, centerAtScale, layout]);

  useEffect(() => {
    // Initialize once. Selecting a method can resize the graph when its detail
    // column opens; observing that resize used to re-center the entire canvas
    // and made a normal click appear to teleport to another branch.
    const frame = window.requestAnimationFrame(readableDefault);
    // The workspace drawer expands after mount. Re-focus once that transition
    // settles, without observing later detail-card resizes or user panning.
    const settle = window.setTimeout(readableDefault, 280);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [readableDefault]);

  const reset = useCallback(() => readableDefault(), [readableDefault]);

  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const bounds = viewport.getBoundingClientRect();
      const current = viewRef.current;
      const nextScale = Math.max(RESEARCH_TREE_MIN_ZOOM, Math.min(1.6, current.scale * factor));
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
      if (
        event.button !== 0 ||
        (event.target as HTMLElement).closest("button, .research-method-detail")
      )
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

  const detailPosition = useCallback(
    (nodeId: string): CSSProperties => {
      const viewport = viewportRef.current;
      const node = layout.nodes.find((candidate) => candidate.id === nodeId);
      if (!viewport || !node) {
        return { top: "0.5rem", right: "0.5rem", width: "min(22rem, calc(100% - 1rem))" };
      }
      const bounds = viewport.getBoundingClientRect();
      const cardWidth = Math.min(352, Math.max(260, bounds.width * 0.34));
      const cardHeight = Math.min(480, Math.max(260, bounds.height * 0.78));
      const nodeLeft = view.x + node.x * view.scale;
      const nodeTop = view.y + node.y * view.scale;
      const nodeRight = nodeLeft + node.w * view.scale;
      const gap = 12;
      const preferredLeft = nodeRight + gap;
      const left = preferredLeft + cardWidth <= bounds.width - 8
        ? preferredLeft
        : nodeLeft - cardWidth - gap;
      const clampedLeft = Math.max(8, Math.min(bounds.width - cardWidth - 8, left));
      const clampedTop = Math.max(8, Math.min(bounds.height - cardHeight - 8, nodeTop));
      return {
        left: `${clampedLeft}px`,
        top: `${clampedTop}px`,
        width: `${cardWidth}px`,
        maxHeight: `${cardHeight}px`,
      };
    },
    [layout.nodes, view],
  );

  return {
    viewportRef,
    contentRef,
    zoom: view.scale,
    fit,
    reset,
    centerNode,
    zoomBy,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheel,
    detailPosition,
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

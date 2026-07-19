import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import {
  RESEARCH_NODES,
  RESEARCH_BRANCHES,
  RESEARCH_TRUNKS,
  TRUNK_META,
  getResearchNode,
  researchBranchForNode,
  type ResearchTrunkId,
} from '../../../sim/balance/research'
import {
  RESEARCH_LAYOUT,
  layoutResearchTree,
  layoutResearchTrunk,
  type ResearchTreeLayout,
} from '../../../sim/balance/researchLayout'
import type { ResearchEffects } from '../../../sim/types'
import {
  cancelActiveResearch,
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
} from '../../../sim/systems/research'
import {
  licenseMethod,
  publishMethod,
  dequeueResearchProgram,
  queueResearchProgram,
  startResearchProgram,
} from '../../../sim/systems/researchPrograms'
import { playerStaff } from '../../../sim/systems/staff'
import { useGameStore } from '../../../store/gameStore'
import { computeSnapshot } from '../../../sim/tick'
import { money, num } from '../format'

export function ResearchPanel() {
  const state = useGameStore((s) => s.state)
  const focusRequest = useGameStore((s) => s.researchFocusRequest)
  const setState = useGameStore.setState
  const snap = computeSnapshot(state)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<ResearchTrunkId | 'all'>('all')
  const [selectedPodId, setSelectedPodId] = useState(
    () => state.player.researchPods?.[0]?.id ?? '',
  )
  const [highlightedId, setHighlightedId] = useState<string | null>(null)

  const active = state.player.activeResearch
  const legacyQueue = state.player.researchQueue
  const leads = state.player.researchLeads ?? []
  const pods = state.player.researchPods ?? []
  const programs = state.player.researchPrograms ?? []
  const usesPodPrograms = pods.length > 0
  const queue = usesPodPrograms ? (state.player.researchProgramQueue ?? []) : legacyQueue
  const selected = selectedId ? getResearchNode(selectedId) : null
  const selectedProgram = selectedId
    ? programs.find((program) => program.methodId === selectedId && program.phase !== 'complete')
    : undefined
  const status = selectedId
    ? selectedProgram
      ? ('active' as const)
      : queue.includes(selectedId)
        ? ('queued' as const)
        : nodeVisualStatus(state, selectedId)
    : null
  const selectedPod = pods.find((pod) => pod.id === selectedPodId)
  const selectedPath = (() => {
    if (!selected) return []
    const scheduled = usesPodPrograms
      ? [
          ...queue,
          ...programs
            .filter((program) => program.phase !== 'complete')
            .map((program) => program.methodId),
        ]
      : [
          ...legacyQueue,
          ...(active ? [active.nodeId] : []),
        ]
    return planResearchPath(state.player.researchUnlocked, scheduled, selected.id).nodeIds
  })()

  const apply = (next: typeof state) => setState({ state: next })

  const layout = useMemo(() => {
    if (filter === 'all') return layoutResearchTree()
    return layoutResearchTrunk(filter)
  }, [filter])
  const canvas = useResearchCanvas(layout)
  const centerResearchNode = canvas.centerNode

  useEffect(() => {
    if (!focusRequest) return
    const node = getResearchNode(focusRequest.nodeId)
    setFilter(node.trunk as ResearchTrunkId)
    setSelectedId(node.id)
    setHighlightedId(node.id)
    const frame = window.requestAnimationFrame(() => centerResearchNode(node.id))
    const timeout = window.setTimeout(() => setHighlightedId(null), 1800)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timeout)
    }
  }, [centerResearchNode, focusRequest])

  const startOrQueue = (id: string) => apply(startResearch(state, id))

  const L = RESEARCH_LAYOUT

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="shrink-0">
        <h2 className="hud-panel-title">Research</h2>
        <p className="mt-0.5 text-[0.8125rem] leading-snug text-muted">
          Research burns <span className="text-bone">research-pool PF</span> and{' '}
          <span className="text-bone">cash</span>. Pool{' '}
          <span className="font-mono text-bone">{num(snap.pools.research, 2)} PF</span>
          {state.player.researchCashBurnToday
            ? ` · today ${money(state.player.researchCashBurnToday)}`
            : ''}
          .
        </p>
      </div>

      {/* Named research organization */}
      {leads.length > 0 && pods.length > 0 && (
        <div className="shrink-0 rounded-xl border border-line bg-panel-2 p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[0.75rem] font-semibold uppercase tracking-wider text-research">
                Research pods
              </div>
              <div className="mt-0.5 text-[0.6875rem] text-muted">
                One named lead and one assignment per pod · seven evidence-driven branches
              </div>
            </div>
            <select
              className="hud-select min-w-44 text-[0.75rem]"
              value={selectedPodId}
              onChange={(event) => setSelectedPodId(event.target.value)}
            >
              {pods.map((pod) => {
                const lead = leads.find((candidate) => candidate.id === pod.leadId)
                return (
                  <option key={pod.id} value={pod.id}>
                    {pod.name} · {lead?.name ?? 'No lead'}
                  </option>
                )
              })}
            </select>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {pods.map((pod) => {
              const lead = leads.find((candidate) => candidate.id === pod.leadId)
              const program = programs.find((candidate) => candidate.id === pod.assignmentId)
              return (
                <button
                  key={pod.id}
                  type="button"
                  onClick={() => setSelectedPodId(pod.id)}
                  className={`rounded-lg border p-2 text-left transition ${
                    pod.id === selectedPodId
                      ? 'border-research/60 bg-research/10'
                      : 'border-line bg-void/40 hover:border-research/30'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[0.75rem] font-medium text-bone">{pod.name}</span>
                    <span className="font-mono text-[0.625rem] uppercase text-muted">
                      {program?.phase ?? 'available'}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[0.6875rem] text-muted">
                    {lead?.name ?? 'No lead'} · {pod.researchers} research · {pod.engineers} eng ·{' '}
                    {pod.dataStaff} data
                  </div>
                  {program && (
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-void">
                      <div
                        className="h-full bg-research"
                        style={{
                          width: `${Math.round(
                            Math.min(
                              1,
                              program.phase === 'integration'
                                ? 0.7 + program.engineeringProgress * 0.3
                                : program.insightProgress * 0.7,
                            ) * 100,
                          )}%`,
                        }}
                      />
                    </div>
                  )}
                </button>
              )
            })}
          </div>
          {queue.length > 0 && (
            <div className="mt-2 border-t border-research/20 pt-2">
              <div className="mb-1 text-[0.625rem] font-semibold uppercase tracking-wider text-muted">Queued methods</div>
              <div className="flex flex-wrap gap-1">
                {queue.map((id, index) => (
                  <div key={id} className="flex items-center gap-1 rounded-full border border-amber/35 bg-amber/10 pl-2 text-[0.6875rem] text-bone">
                    <span className="font-mono text-amber">{index + 1}</span>
                    <span>{getResearchNode(id).name}</span>
                    <button type="button" className="pr-2 text-muted hover:text-danger" onClick={() => apply(usesPodPrograms ? dequeueResearchProgram(state, id) : dequeueResearch(state, id))} aria-label={`Remove ${getResearchNode(id).name} from queue`}>×</button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {programs.some((program) => program.phase === 'complete') && (
            <div className="mt-2 space-y-1 border-t border-line pt-2">
              {programs
                .filter((program) => program.phase === 'complete')
                .slice(-3)
                .map((program) => (
                  <div key={program.id} className="flex items-center justify-between gap-2 text-[0.6875rem]">
                    <span className="min-w-0 truncate text-muted">
                      {getResearchNode(program.methodId).name} · {program.disclosure}
                    </span>
                    {program.disclosure === 'secret' && (
                      <span className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          className="btn-ghost px-2 py-0.5"
                          onClick={() => apply(publishMethod(state, program.id))}
                        >
                          Publish · +2.5 brand
                        </button>
                        <button
                          type="button"
                          className="btn-ghost px-2 py-0.5"
                          onClick={() => apply(licenseMethod(state, program.id))}
                        >
                          License · rival friction
                        </button>
                      </span>
                    )}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {/* Legacy queue remains available only for pre-pod compatibility states. */}
      {!usesPodPrograms && (
      <div className="shrink-0 rounded-xl border border-research/30 bg-research/10 p-2">
        {active ? (
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-bone">
                Active: {getResearchNode(active.nodeId).name}
              </span>
              <button
                type="button"
                className="text-[0.75rem] text-muted hover:text-danger"
                onClick={() => apply(cancelActiveResearch(state))}
              >
                Cancel
              </button>
            </div>
            <div className="mt-1 font-mono text-[0.75rem] text-muted">
              {num(active.progressPfDays, 1)}/
              {num(researchPfTarget(state, getResearchNode(active.nodeId)), 0)} PF · day{' '}
              {active.daysSpent}/
              {researchDaysTarget(
                getResearchNode(active.nodeId),
                playerStaff(state).researcher ?? 0,
              )}{' '}
              · rate {num(estimateResearchRate(state, active.nodeId).pfPerDay, 2)} PF/d · cash ~
              {money(
                researchCashEstimate(state, getResearchNode(active.nodeId)) *
                  Math.min(
                    1,
                    active.progressPfDays /
                      Math.max(1, researchPfTarget(state, getResearchNode(active.nodeId))),
                  ),
              )}{' '}
              spent path
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-void">
              <div
                className="h-full bg-research"
                style={{
                  width: `${Math.min(
                    100,
                    (active.progressPfDays /
                      Math.max(1, researchPfTarget(state, getResearchNode(active.nodeId)))) *
                      100,
                  )}%`,
                }}
              />
            </div>
          </div>
        ) : (
          <p className="text-[0.8125rem] text-muted">No active project — select a node and Start.</p>
        )}
        {queue.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1 border-t border-research/20 pt-2">
            {queue.map((id, i) => (
              <div
                key={id}
                className="flex items-center gap-0.5 rounded-full border border-line bg-panel-2 pl-2 text-[0.75rem]"
              >
                <span className="font-mono text-muted">{i + 1}.</span>
                <span className="max-w-[90px] truncate text-bone">
                  {getResearchNode(id).name}
                </span>
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
      </div>
      )}

      {/* Trunk filters */}
      <div className="flex shrink-0 flex-wrap gap-1">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label="All" />
        {RESEARCH_TRUNKS.map((t) => (
          <FilterChip
            key={t}
            active={filter === t}
            onClick={() => setFilter(t)}
            label={TRUNK_META[t].label}
            color={TRUNK_META[t].color}
          />
        ))}
      </div>

      {/* One navigable tree surface with a fixed decision inspector. */}
      <div className="grid min-h-[400px] flex-1 grid-cols-[minmax(0,1fr)_22rem] gap-2 overflow-hidden">
      <div
        ref={canvas.viewportRef}
        onPointerDown={canvas.onPointerDown}
        onPointerMove={canvas.onPointerMove}
        onPointerUp={canvas.onPointerUp}
        onPointerCancel={canvas.onPointerUp}
        onWheel={canvas.onWheel}
        className="relative min-h-0 touch-none select-none overflow-hidden rounded-xl border border-line bg-void/90 cursor-grab data-[dragging=true]:cursor-grabbing"
        aria-label="Interactive research tree. Drag to pan and use the mouse wheel to zoom."
      >
        <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-lg border border-line bg-panel/90 p-1 shadow-lg backdrop-blur-md">
          <span className="min-w-10 px-1 text-center font-mono text-[0.6875rem] text-muted">
            {Math.round(canvas.zoom * 100)}%
          </span>
          <button type="button" className="btn-ghost h-7 min-h-0 w-7 p-0" onClick={() => canvas.zoomBy(0.84)} aria-label="Zoom research tree out">−</button>
          <button type="button" className="btn-ghost h-7 min-h-0 w-7 p-0" onClick={() => canvas.zoomBy(1.19)} aria-label="Zoom research tree in">+</button>
          <button type="button" className="btn-ghost h-7 min-h-0 px-2 text-[0.6875rem]" onClick={canvas.fit}>Fit</button>
        </div>
        <div className="pointer-events-none absolute bottom-2 left-2 z-20 rounded-md border border-line/70 bg-panel/85 px-2 py-1 font-mono text-[0.625rem] text-muted backdrop-blur-md">
          drag to pan · wheel to zoom · double-click to queue
        </div>
        <div
          ref={canvas.contentRef}
          className="absolute left-0 top-0 will-change-transform"
          style={{ width: layout.width, height: layout.height }}
        >
          {/* Soft category territories make the graph read as a research map, not columns. */}
          {researchRegions(layout).map((region) => (
            <div
              key={region.trunk}
              className="pointer-events-none absolute rounded-2xl border"
              style={{
                left: region.x,
                top: region.y,
                width: region.w,
                height: region.h,
                borderColor: `${TRUNK_META[region.trunk].color}2e`,
                background: `linear-gradient(145deg, ${TRUNK_META[region.trunk].color}12, transparent 64%)`,
              }}
            />
          ))}
          {/* Branch labels */}
          {(filter === 'all' ? RESEARCH_TRUNKS : [filter]).map((t) => {
            const branchRoot = layout.nodes
              .filter((node) => node.trunk === t)
              .sort((a, b) => a.depth - b.depth || a.y - b.y)[0]
            const x = branchRoot?.x ?? layout.trunkX[t] ?? L.padX
            const y = Math.max(10, (branchRoot?.y ?? L.padY) - 25)
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
                <div className="mt-0.5 text-[0.5625rem] font-normal normal-case tracking-normal text-muted">
                  {TRUNK_META[t].blurb}
                </div>
              </div>
            )
          })}

          {/* Edges */}
          <svg
            className="pointer-events-none absolute left-0 top-0 z-[2]"
            width={layout.width}
            height={layout.height}
          >
            {layout.edges.map((e) => {
              const horizontal = Math.abs(e.x2 - e.x1) >= Math.abs(e.y2 - e.y1)
              const midX = (e.x1 + e.x2) / 2
              const midY = (e.y1 + e.y2) / 2
              const done = state.player.researchUnlocked.includes(e.from)
              return (
                <path
                  key={`${e.from}-${e.to}`}
                  d={
                    horizontal
                      ? `M ${e.x1} ${e.y1} C ${midX} ${e.y1}, ${midX} ${e.y2}, ${e.x2} ${e.y2}`
                      : `M ${e.x1} ${e.y1} C ${e.x1} ${midY}, ${e.x2} ${midY}, ${e.x2} ${e.y2}`
                  }
                  fill="none"
                  stroke={
                    e.crossTrunk
                      ? done
                        ? '#3dffc044'
                        : '#2a2f3a88'
                      : done
                        ? '#3dffc088'
                        : '#3a4150'
                  }
                  strokeWidth={e.crossTrunk ? 1 : 1.5}
                  strokeDasharray={e.crossTrunk ? '4 3' : undefined}
                />
              )
            })}
          </svg>

          {/* Nodes */}
          {layout.nodes.map((n) => {
            const def = getResearchNode(n.id)
            const program = programs.find(
              (candidate) => candidate.methodId === n.id && candidate.phase !== 'complete',
            )
            const st = program
              ? ('active' as const)
              : queue.includes(n.id)
                ? ('queued' as const)
                : nodeVisualStatus(state, n.id)
            const sel = selectedId === n.id
            const highlighted = highlightedId === n.id
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => setSelectedId(n.id)}
                onDoubleClick={() => usesPodPrograms ? apply(queueResearchProgram(state, n.id)) : startOrQueue(n.id)}
                className={`absolute z-10 rounded-lg border px-2 py-1.5 text-left transition ${nodeClass(st, sel, def.riskLevel)} ${highlighted ? 'ring-2 ring-research shadow-[0_0_1.5rem_rgba(147,116,255,0.45)]' : ''}`}
                style={{
                  left: n.x,
                  top: n.y,
                  width: n.w,
                  height: n.h,
                }}
                title={def.description}
              >
                {def.riskLevel && (
                  <span className="absolute right-1.5 top-1 rounded border border-danger/50 bg-danger/15 px-1 font-mono text-[0.5rem] font-semibold uppercase tracking-wider text-danger">
                    {def.riskLevel} risk
                  </span>
                )}
                <div className={`truncate text-[0.8125rem] font-medium leading-tight text-bone ${def.riskLevel ? 'pr-14' : ''}`}>
                  {def.name}
                </div>
                <div className="mt-0.5 font-mono text-[0.6875rem] text-muted">
                  {st === 'done' ? (
                    <span className="text-mint">DONE</span>
                  ) : (
                    <>
                      {def.costPfDays} PF
                      {st === 'queued' ? ' · Q' : ''}
                      {st === 'active' ? ' · …' : ''}
                      {st === 'blocked' || st === 'locked' ? ' · locked' : ''}
                    </>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Detail dock */}
        <aside className="panel-scroll min-h-0 overflow-y-auto rounded-xl border border-line bg-panel-2 p-3">
      {selected && status ? (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium text-bone">{selected.name}</div>
              <div className="font-mono text-[0.75rem] text-muted">
                {RESEARCH_BRANCHES[researchBranchForNode(selected.id)].label} · {status}
              </div>
            </div>
            {!usesPodPrograms && <div className="flex shrink-0 gap-1">
              {status !== 'done' &&
                status !== 'active' &&
                status !== 'queued' &&
                status !== 'blocked' && (
                  <button
                    type="button"
                    className="btn-primary px-3 py-1 text-[0.8125rem]"
                    onClick={() => startOrQueue(selected.id)}
                  >
                    {status === 'locked'
                      ? `Queue unlock path${selectedPath.length > 1 ? ` (${selectedPath.length})` : ''}`
                      : active
                        ? 'Queue'
                        : 'Start'}
                  </button>
                )}
              {status === 'available' && active && (
                <button
                  type="button"
                  className="btn-ghost px-2 py-1 text-[0.8125rem]"
                  onClick={() => apply(enqueueResearch(state, selected.id))}
                >
                  Queue
                </button>
              )}
              {status === 'queued' && (
                <button
                  type="button"
                  className="btn-ghost px-2 py-1 text-[0.8125rem]"
                  onClick={() => apply(dequeueResearch(state, selected.id))}
                >
                  Remove
                </button>
              )}
            </div>}
          </div>
          {status === 'available' && selectedPod && !selectedPod.assignmentId && !selectedProgram && (
            <button
              type="button"
              className="btn-primary mt-2 w-full px-3 py-1.5 text-[0.8125rem]"
              onClick={() => apply(startResearchProgram(state, selected.id, selectedPod.id))}
            >
              Assign {selectedPod.name}
            </button>
          )}
          {usesPodPrograms && (status === 'available' || status === 'locked') && (
            <button
              type="button"
              className="btn-ghost mt-2 w-full px-3 py-1.5 text-[0.8125rem]"
              onClick={() => apply(queueResearchProgram(state, selected.id))}
            >
              {status === 'locked'
                ? `Queue unlock path${selectedPath.length > 1 ? ` · ${selectedPath.length} methods` : ''}`
                : 'Queue for next available pod'}
            </button>
          )}
          {usesPodPrograms && status === 'queued' && (
            <button type="button" className="btn-ghost mt-2 w-full px-3 py-1.5 text-[0.8125rem]" onClick={() => apply(dequeueResearchProgram(state, selected.id))}>
              Remove from queue
            </button>
          )}
          {selectedPod?.assignmentId && status === 'available' && (
            <p className="mt-2 rounded-lg border border-amber/30 bg-amber/10 px-2 py-1 text-[0.6875rem] text-amber">
              {selectedPod.name} is already assigned. Select an available pod.
            </p>
          )}
          {selectedProgram && (
            <p className="mt-2 rounded-lg border border-research/30 bg-research/10 px-2 py-1 text-[0.6875rem] text-research">
              In {selectedProgram.phase} with{' '}
              {pods.find((pod) => pod.id === selectedProgram.podId)?.name ?? 'assigned pod'} ·{' '}
              {selectedProgram.evidence.length} evidence item{selectedProgram.evidence.length === 1 ? '' : 's'}
            </p>
          )}
          <p className="mt-1.5 text-[0.8125rem] leading-snug text-muted">{selected.description}</p>
          <div className="mt-1.5 font-mono text-[0.75rem] text-muted">
            ~{num(researchPfTarget(state, selected), 0)} PF-days · ≥
            {researchDaysTarget(selected, playerStaff(state).researcher ?? 0)}d · ~
            {money(researchCashEstimate(state, selected))} cash ·{' '}
            <span
              className={
                (playerStaff(state).researcher ?? 0) >= minResearchersForNode(selected.id)
                  ? 'text-mint'
                  : 'text-amber'
              }
            >
              {minResearchersForNode(selected.id)} researchers
            </span>
            {' · '}
            <span className="text-bone">
              ~{num(estimateResearchRate(state, selected.id).pfPerDay, 2)} PF/d now
            </span>
            {selected.prereqs.length > 0 && (
              <span>
                {' '}
                · needs {selected.prereqs.map((p) => getResearchNode(p).name).join(', ')}
              </span>
            )}
          </div>
          <EffectsLine effects={selected.effects} />
          {selected.riskLevel && (
            <div className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-2">
              <div className="font-mono text-[0.6875rem] font-semibold uppercase tracking-wider text-danger">
                {selected.riskLevel} variance research
              </div>
              <p className="mt-1 text-[0.6875rem] leading-snug text-muted">
                Higher breakthrough odds and capability upside, but also more failed runs and a direct model safety penalty.
              </p>
            </div>
          )}
          <p className="mt-1 text-[0.6875rem] text-muted">
            {RESEARCH_NODES.length} methods · {usesPodPrograms ? 'assign now or double-click to queue' : 'dbl-click to start/queue'}
          </p>
        </>
      ) : (
        <div className="flex h-full min-h-44 flex-col items-center justify-center px-5 text-center">
          <span className="h-2 w-2 rotate-45 border border-research shadow-[0_0_12px_var(--color-research)]" />
          <h3 className="mt-4 text-[0.875rem] font-semibold text-bone">Select a research node</h3>
          <p className="mt-2 text-[0.75rem] leading-relaxed text-muted">Review prerequisites, staffing, cash cost, and expected effects before starting or queueing work.</p>
        </div>
      )}
        </aside>
      </div>
    </div>
  )
}

type CanvasView = { x: number; y: number; scale: number }

function useResearchCanvas(layout: ResearchTreeLayout) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<CanvasView>({ x: 24, y: 24, scale: 0.72 })
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const [zoom, setZoom] = useState(viewRef.current.scale)

  const applyView = useCallback((next: CanvasView) => {
    viewRef.current = next
    const content = contentRef.current
    if (content) {
      content.style.transformOrigin = '0 0'
      content.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.scale})`
    }
    setZoom((current) => (Math.abs(current - next.scale) > 0.001 ? next.scale : current))
  }, [])

  const fit = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const bounds = viewport.getBoundingClientRect()
    const scale = Math.max(
      0.38,
      Math.min(1.05, Math.min((bounds.width - 32) / layout.width, (bounds.height - 32) / layout.height)),
    )
    applyView({
      x: (bounds.width - layout.width * scale) / 2,
      y: (bounds.height - layout.height * scale) / 2,
      scale,
    })
  }, [applyView, layout.height, layout.width])

  const focus = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const bounds = viewport.getBoundingClientRect()
    const fitScale = Math.min(
      1.05,
      Math.min((bounds.width - 32) / layout.width, (bounds.height - 32) / layout.height),
    )
    const scale = Math.max(0.78, fitScale)
    applyView({
      x: 20,
      y: (bounds.height - layout.height * scale) / 2,
      scale,
    })
  }, [applyView, layout.height, layout.width])

  useEffect(() => {
    const frame = window.requestAnimationFrame(focus)
    return () => window.cancelAnimationFrame(frame)
  }, [focus])

  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const viewport = viewportRef.current
      if (!viewport) return
      const bounds = viewport.getBoundingClientRect()
      const current = viewRef.current
      const nextScale = Math.max(0.42, Math.min(1.6, current.scale * factor))
      const anchorX = (clientX ?? bounds.left + bounds.width / 2) - bounds.left
      const anchorY = (clientY ?? bounds.top + bounds.height / 2) - bounds.top
      const contentX = (anchorX - current.x) / current.scale
      const contentY = (anchorY - current.y) / current.scale
      applyView({
        x: anchorX - contentX * nextScale,
        y: anchorY - contentY * nextScale,
        scale: nextScale,
      })
    },
    [applyView],
  )

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
    event.currentTarget.dataset.dragging = 'true'
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      dragRef.current = { ...drag, x: event.clientX, y: event.clientY }
      const current = viewRef.current
      applyView({ ...current, x: current.x + dx, y: current.y + dy })
    },
    [applyView],
  )

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    delete event.currentTarget.dataset.dragging
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const onWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      event.preventDefault()
      zoomAt(event.deltaY > 0 ? 0.9 : 1.1, event.clientX, event.clientY)
    },
    [zoomAt],
  )

  const zoomBy = useCallback((factor: number) => zoomAt(factor), [zoomAt])

  const centerNode = useCallback(
    (nodeId: string) => {
      const viewport = viewportRef.current
      const node = layout.nodes.find((candidate) => candidate.id === nodeId)
      if (!viewport || !node) return
      const bounds = viewport.getBoundingClientRect()
      const scale = Math.max(0.8, Math.min(1.15, viewRef.current.scale))
      applyView({
        x: bounds.width / 2 - (node.x + node.w / 2) * scale,
        y: bounds.height / 2 - (node.y + node.h / 2) * scale,
        scale,
      })
    },
    [applyView, layout.nodes],
  )

  return {
    viewportRef,
    contentRef,
    zoom,
    fit,
    centerNode,
    zoomBy,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheel,
  }
}

function FilterChip({
  active,
  onClick,
  label,
  color,
}: {
  active: boolean
  onClick: () => void
  label: string
  color?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-2 py-0.5 text-[0.75rem] font-medium transition ${
        active ? 'bg-bone text-void' : 'bg-panel-2 text-muted hover:text-bone'
      }`}
      style={!active && color ? { boxShadow: `inset 0 0 0 1px ${color}44` } : undefined}
    >
      {label}
    </button>
  )
}

function nodeClass(
  st: NodeVisualStatus,
  sel: boolean,
  riskLevel?: 'elevated' | 'high',
): string {
  const base = 'overflow-hidden '
  if (st === 'done') return base + 'border-mint/40 bg-mint/10'
  if (st === 'active') return base + 'border-research bg-research/20'
  if (st === 'queued') return base + 'border-amber/50 bg-amber/10'
  if (st === 'available')
    return (
      base +
      (sel
        ? riskLevel
          ? 'border-danger/80 bg-danger/10 ring-1 ring-danger/40'
          : 'border-research/80 bg-panel-2 ring-1 ring-research/40'
        : riskLevel
          ? 'border-danger/45 bg-danger/5 hover:border-danger/75'
          : 'border-line bg-panel-2 hover:border-research/50')
    )
  if (st === 'blocked' || st === 'locked')
    return riskLevel
      ? base + 'border-danger/30 bg-danger/5 opacity-65'
      : base + 'border-line/40 bg-void/50 opacity-55'
  return base + 'border-line/40 bg-void/40 opacity-50'
}

function EffectsLine({ effects }: { effects: ResearchEffects }) {
  const bits: string[] = []
  if (effects.utilCap) bits.push(`usable compute +${(effects.utilCap * 100).toFixed(0)}%`)
  if (effects.servingEfficiency) {
    bits.push(`token speed +${(effects.servingEfficiency * 100).toFixed(0)}%`)
    bits.push(`inference compute/token −${(100 - 100 / (1 + effects.servingEfficiency)).toFixed(0)}%`)
  }
  if (effects.trainEfficiency) {
    bits.push(`training speed +${(effects.trainEfficiency * 100).toFixed(0)}%`)
    bits.push(`training compute/token −${(100 - 100 / (1 + effects.trainEfficiency)).toFixed(0)}%`)
  }
  if (effects.energyPue) bits.push(`facility power ${effects.energyPue < 0 ? '−' : '+'}${Math.abs(effects.energyPue * 100).toFixed(0)} PUE pts`)
  if (effects.capabilityBonus) bits.push(`model capability +${effects.capabilityBonus}`)
  if (effects.moeInferMult) bits.push(`MoE compute/token −${((1 - effects.moeInferMult) * 100).toFixed(0)}%`)
  if (effects.denseInferMult) bits.push(`dense compute/token ${effects.denseInferMult < 1 ? '−' : '+'}${Math.abs((1 - effects.denseInferMult) * 100).toFixed(0)}%`)
  if (effects.chipDiscount) bits.push(`hardware cost −${(effects.chipDiscount * 100).toFixed(0)}%`)
  if (effects.dataFlywheel) bits.push(`data processing +${(effects.dataFlywheel * 100).toFixed(0)}%`)
  if (effects.benchmarkBoost) bits.push('evaluation lift')
  if (effects.unlockCorpusSpecialists) bits.push('specialist data processing')
  if (effects.unlockFamily) bits.push(`unlock ${effects.unlockFamily}`)
  if (effects.trainingBreakthroughBias)
    bits.push(`breakthrough odds +${(effects.trainingBreakthroughBias * 100).toFixed(0)} pts`)
  if (effects.trainingStumbleRisk)
    bits.push(`failed-run risk +${(effects.trainingStumbleRisk * 100).toFixed(0)} pts`)
  if (effects.trainingSafetyPenalty)
    bits.push(`model safety −${effects.trainingSafetyPenalty.toFixed(0)}`)
  if (bits.length === 0) return null
  return <p className="mt-1 font-mono text-[0.75rem] text-research">{bits.join(' · ')}</p>
}

function researchRegions(layout: ResearchTreeLayout) {
  return RESEARCH_TRUNKS.flatMap((trunk) => {
    const nodes = layout.nodes.filter((node) => node.trunk === trunk)
    if (nodes.length === 0) return []
    const padX = 18
    const padY = 34
    const left = Math.min(...nodes.map((node) => node.x)) - padX
    const top = Math.min(...nodes.map((node) => node.y)) - padY
    const right = Math.max(...nodes.map((node) => node.x + node.w)) + padX
    const bottom = Math.max(...nodes.map((node) => node.y + node.h)) + padY
    return [{ trunk, x: left, y: top, w: right - left, h: bottom - top }]
  })
}

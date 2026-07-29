import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { X } from '@phosphor-icons/react'
import type {
  DataHallLayout,
  DataHallObjectPlacement,
  HallAutoLayoutStrategy,
} from '../../../../sim/types'
import {
  DATA_HALL_SHELLS,
  HALL_EQUIPMENT_CATALOG,
  HALL_GRID_METERS,
  analyzeHallLayout,
  autoPlanHall,
  createDoor,
  createWall,
  previewHallObjectPlacement,
  rackUnitsForFacility,
  rotateHallObject,
} from '../../../../sim/systems/dataHallLayouts'
import { facilityAnchorTiles } from '../../../../sim/systems/worldAccess'
import { useGameStore } from '../../../../store/gameStore'
import { money } from '../../format'
import { captureHallClock, restoreHallClock, type HallClockSnapshot } from './hallLayoutModel'

type Draft = Pick<DataHallLayout, 'objects' | 'walls' | 'doors' | 'preferredStrategy'>
type PaletteMode = { kind: 'rack'; unitId: string; skuId: string } | { kind: 'equipment'; catalogId: string } | { kind: 'wall'; start?: { x: number; z: number } } | null

const cloneDraft = (draft: Draft): Draft => ({
  preferredStrategy: draft.preferredStrategy,
  objects: draft.objects.map((entry) => ({ ...entry })),
  walls: draft.walls.map((entry) => ({ ...entry })),
  doors: draft.doors.map((entry) => ({ ...entry })),
})

export function DataHallEditorOverlay() {
  const facilityId = useGameStore((store) => store.hallEditorFacilityId)
  const state = useGameStore((store) => store.state)
  const close = useGameStore((store) => store.closeHallEditor)
  const applyPlan = useGameStore((store) => store.applyHallEditorPlan)
  const layout = facilityId ? state.dataHallLayouts?.[facilityId] : undefined
  const hall = facilityId ? facilityAnchorTiles(state).find((tile) => (tile.campusId ?? `facility:${tile.x},${tile.y}`) === facilityId) : undefined
  const inventory = useMemo(() => facilityId && hall ? rackUnitsForFacility(state, facilityId, hall.owner) : [], [facilityId, hall, state])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [past, setPast] = useState<Draft[]>([])
  const [future, setFuture] = useState<Draft[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<PaletteMode>(null)
  const [showRoutes, setShowRoutes] = useState(true)
  const [showGrid, setShowGrid] = useState(true)
  const [previewStrategy, setPreviewStrategy] = useState<HallAutoLayoutStrategy | null>(null)
  const [plannedSpaces, setPlannedSpaces] = useState<DataHallObjectPlacement[]>([])
  const [message, setMessage] = useState('Draft changes are not live until Apply plan.')
  const idCounter = useRef(1)
  const priorClock = useRef<HallClockSnapshot | null>(null)

  useEffect(() => {
    if (!facilityId || !layout) return
    setDraft(cloneDraft(layout))
    setPast([])
    setFuture([])
    setSelectedId(null)
    setMode(null)
    setPreviewStrategy(null)
    setPlannedSpaces([])
    idCounter.current = Math.max(0, ...[...layout.objects, ...layout.walls, ...layout.doors].map((entry) => {
      const match = entry.id.match(/:(\d+)$/)
      return match ? Number(match[1]) : 0
    })) + 1
  }, [facilityId, layout])

  useEffect(() => {
    if (!facilityId) return
    const current = useGameStore.getState().state
    priorClock.current = captureHallClock(current)
    useGameStore.getState().setPaused(true)
    return () => {
      const prior = priorClock.current
      if (prior) useGameStore.setState((store) => ({ state: restoreHallClock(store.state, prior) }))
      priorClock.current = null
    }
  }, [facilityId])

  const editorLayout = useMemo(() => layout && draft ? { ...layout, ...draft } : null, [draft, layout])
  const analysis = useMemo(() => editorLayout && hall
    ? analyzeHallLayout(editorLayout, inventory, hall.rackCapacity)
    : null, [editorLayout, hall, inventory])
  const placedUnits = useMemo(() => new Set(draft?.objects.flatMap((object) => object.rackUnitId ? [object.rackUnitId] : []) ?? []), [draft])
  const staging = inventory.filter((unit) => unit.delivered && !placedUnits.has(unit.unitId))
  const selectedObject = draft?.objects.find((object) => object.id === selectedId)
  const selectedWall = draft?.walls.find((wall) => wall.id === selectedId)

  const mutate = useCallback((operation: (current: Draft) => Draft) => {
    setPreviewStrategy(null)
    setPlannedSpaces([])
    setDraft((current) => {
      if (!current) return current
      setPast((entries) => [...entries.slice(-49), cloneDraft(current)])
      setFuture([])
      return operation(cloneDraft(current))
    })
  }, [])

  const undo = useCallback(() => {
    setPreviewStrategy(null)
    setPlannedSpaces([])
    setPast((entries) => {
      const previous = entries.at(-1)
      if (!previous) return entries
      setDraft((current) => {
        if (current) setFuture((next) => [cloneDraft(current), ...next].slice(0, 50))
        return cloneDraft(previous)
      })
      return entries.slice(0, -1)
    })
  }, [])
  const redo = useCallback(() => {
    setPreviewStrategy(null)
    setPlannedSpaces([])
    setFuture((entries) => {
      const next = entries[0]
      if (!next) return entries
      setDraft((current) => {
        if (current) setPast((history) => [...history.slice(-49), cloneDraft(current)])
        return cloneDraft(next)
      })
      return entries.slice(1)
    })
  }, [])

  const removeSelected = useCallback(() => {
    if (!selectedId) return
    mutate((current) => ({
      ...current,
      objects: current.objects.filter((entry) => entry.id !== selectedId),
      walls: current.walls.filter((entry) => entry.id !== selectedId),
      doors: current.doors.filter((entry) => entry.id !== selectedId && entry.wallId !== selectedId),
    }))
    setSelectedId(null)
  }, [mutate, selectedId])

  const rotateSelected = useCallback(() => {
    if (!selectedId) return
    mutate((current) => ({ ...current, objects: current.objects.map((entry) => entry.id === selectedId ? rotateHallObject(entry) : entry) }))
  }, [mutate, selectedId])

  const duplicateSelected = useCallback(() => {
    if (!selectedObject) return
    if (selectedObject.kind === 'rack') {
      const replacement = staging.find((unit) => unit.skuId === selectedObject.catalogId)
      if (!replacement) { setMessage('No matching staged rack is available to duplicate this chassis.'); return }
      const id = `${facilityId}:draft:${idCounter.current++}`
      mutate((current) => ({ ...current, objects: [...current.objects, { ...selectedObject, id, rackUnitId: replacement.unitId, x: selectedObject.x + 4, purchasePrice: 0 }] }))
      setSelectedId(id)
      return
    }
    const def = HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === selectedObject.catalogId)
    if (!def) return
    const id = `${facilityId}:draft:${idCounter.current++}`
    mutate((current) => ({ ...current, objects: [...current.objects, { ...selectedObject, id, x: selectedObject.x + 4, purchasePrice: def.price }] }))
    setSelectedId(id)
  }, [facilityId, mutate, selectedObject, staging])

  useEffect(() => {
    if (!facilityId) return
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select')) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (mode) setMode(null); else close(); return }
      if (event.key.toLowerCase() === 'r') { event.preventDefault(); event.stopImmediatePropagation(); rotateSelected(); return }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopImmediatePropagation(); removeSelected(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopImmediatePropagation(); if (event.shiftKey) redo(); else undo(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); event.stopImmediatePropagation(); redo() }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [close, facilityId, mode, redo, removeSelected, rotateSelected, undo])

  const previewPlacement = useCallback((previewMode: NonNullable<PaletteMode>, x: number, z: number): 'valid' | 'warning' | 'invalid' => {
    if (!layout || !draft || !hall || !analysis) return 'invalid'
    const candidate = cloneDraft(draft)
    if (previewMode.kind === 'wall') {
      if (!previewMode.start) return 'valid'
      const horizontal = Math.abs(x - previewMode.start.x) >= Math.abs(z - previewMode.start.z)
      const end = horizontal ? { x, z: previewMode.start.z } : { x: previewMode.start.x, z }
      candidate.walls.push(createWall('__preview-wall', previewMode.start.x, previewMode.start.z, end.x, end.z))
    } else {
      const object: DataHallObjectPlacement = previewMode.kind === 'rack'
        ? { id: '__preview', kind: 'rack', catalogId: previewMode.skuId, rackUnitId: previewMode.unitId, x, z, rotation: 0, purchasePrice: 0 }
        : (() => { const def = HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === previewMode.catalogId)!; return { id: '__preview', kind: def.kind, catalogId: def.id, x, z, rotation: 0, purchasePrice: def.price } })()
      candidate.objects.push(object)
    }
    const object = candidate.objects.at(-1)
    if (!object || object.id !== '__preview') {
      const result = analyzeHallLayout({ ...layout, ...candidate }, inventory, hall.rackCapacity)
      return result.valid ? result.warnings.length > analysis.warnings.length ? 'warning' : 'valid' : 'invalid'
    }
    return previewHallObjectPlacement({ ...layout, ...draft }, object, hall.rackCapacity)
  }, [analysis, draft, hall, inventory, layout])

  const previewObjectMove = useCallback((object: DataHallObjectPlacement, x: number, z: number) => {
    if (!layout || !draft || !hall) return 'invalid' as const
    return previewHallObjectPlacement({ ...layout, ...draft }, { ...object, x, z }, hall.rackCapacity)
  }, [draft, hall, layout])

  if (!facilityId) return null
  if (!layout || !hall || !draft || !analysis) return <div className="fixed inset-0 z-[100] grid place-items-center bg-void text-bone">Preparing data hall…</div>

  const placeAt = (x: number, z: number) => {
    if (!mode) return
    if (mode.kind === 'wall') {
      if (!mode.start) { setMode({ ...mode, start: { x, z } }); setMessage('Choose the wall end point.'); return }
      const horizontal = Math.abs(x - mode.start.x) >= Math.abs(z - mode.start.z)
      const end = horizontal ? { x, z: mode.start.z } : { x: mode.start.x, z }
      const wall = createWall(`${facilityId}:wall:${idCounter.current++}`, mode.start.x, mode.start.z, end.x, end.z)
      mutate((current) => ({ ...current, walls: [...current.walls, wall] }))
      setMode({ kind: 'wall' })
      return
    }
    const placementState = previewPlacement(mode, x, z)
    if (placementState === 'invalid') {
      setMessage('That grid position is blocked. Choose a red-free footprint.')
      return
    }
    const id = `${facilityId}:draft:${idCounter.current++}`
    const object: DataHallObjectPlacement = mode.kind === 'rack'
      ? { id, kind: 'rack', catalogId: mode.skuId, rackUnitId: mode.unitId, x, z, rotation: 0, purchasePrice: 0 }
      : (() => {
          const def = HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === mode.catalogId)!
          return { id, kind: def.kind, catalogId: def.id, x, z, rotation: 0, purchasePrice: def.price }
        })()
    mutate((current) => ({ ...current, objects: [...current.objects, object] }))
    setSelectedId(id)
    if (mode.kind === 'rack') setMode(null)
  }

  const moveObject = (id: string, x: number, z: number) => {
    const object = draft.objects.find((entry) => entry.id === id)
    if (!object || previewObjectMove(object, x, z) === 'invalid') {
      setMessage('Move blocked: the rack footprint collides with the room or another asset.')
      return
    }
    mutate((current) => ({
      ...current,
      objects: current.objects.map((entry) => entry.id === id ? { ...entry, x, z } : entry),
    }))
  }

  const applyStrategy = (strategy: HallAutoLayoutStrategy) => {
    const delivered = inventory.filter((unit) => unit.delivered).slice(0, hall.rackCapacity)
    const placeholderSku = delivered[0]?.skuId ?? 'rack_h100'
    const capacityInventory = [
      ...delivered,
      ...Array.from({ length: Math.max(0, hall.rackCapacity - delivered.length) }, (_, index) => ({
        unitId: `\uffffspace:${String(index + 1).padStart(4, '0')}`,
        skuId: placeholderSku,
        mw: 0.012,
        networkGbps: 400,
        delivered: true,
      })),
    ]
    const capacityPlan = autoPlanHall({ ...layout, ...draft }, capacityInventory, strategy, hall.rackCapacity, { provisionUtilities: true })
    const spaces = capacityPlan.objects.filter((object) => object.rackUnitId?.startsWith('\uffffspace:'))
    const planned = { ...capacityPlan, objects: capacityPlan.objects.filter((object) => !object.rackUnitId?.startsWith('\uffffspace:')) }
    mutate(() => cloneDraft(planned))
    setPlannedSpaces(spaces)
    setPreviewStrategy(strategy)
    setMessage(`${strategy[0].toUpperCase()}${strategy.slice(1)} preview generated with ${spaces.length} open rack spaces. Apply plan to commit infrastructure.`)
  }

  const apply = () => {
    const result = applyPlan({ facilityId, expectedRevision: layout.revision, objects: draft.objects, walls: draft.walls, doors: draft.doors, preferredStrategy: draft.preferredStrategy })
    if (!result.ok) { setMessage(result.error ?? 'Plan could not be applied.'); return }
    setPast([])
    setFuture([])
    setMessage(`Plan applied and saved${result.netCost > 0 ? ` · ${money(result.netCost)}` : result.netCost < 0 ? ` · ${money(-result.netCost)} recovered` : ''}. Placements are now live.`)
  }

  return (
    <section className="fixed inset-0 z-[100] grid grid-cols-[17rem_minmax(0,1fr)_19rem] grid-rows-[minmax(0,1fr)_4.25rem] bg-[#070b10] text-bone" role="dialog" aria-modal="true" aria-label="Data Hall Editor">
      <aside className="min-h-0 overflow-y-auto border-r border-line/80 bg-panel/95 p-3">
        <p className="font-mono text-[0.625rem] uppercase tracking-[0.2em] text-mint">Labline</p>
        <h1 className="mt-1 text-xl font-semibold">Data Hall Editor</h1>
        <p className="mt-1 text-[0.75rem] text-muted">{hall.name} · 250 mm grid</p>
        <PaletteGroup title={`Racks · ${staging.length} staged`}>
          {staging.length ? staging.slice(0, 40).map((unit) => <PaletteButton key={unit.unitId} active={mode?.kind === 'rack' && mode.unitId === unit.unitId} label={unit.skuId} detail={unit.unitId.split(':').at(-1)} onClick={() => setMode({ kind: 'rack', unitId: unit.unitId, skuId: unit.skuId })} />) : <p className="text-[0.75rem] text-muted">No delivered, unplaced racks.</p>}
        </PaletteGroup>
        {(['cooling', 'power', 'network'] as const).map((kind) => <PaletteGroup key={kind} title={kind}>
          {HALL_EQUIPMENT_CATALOG.filter((entry) => entry.kind === kind).map((entry) => <PaletteButton key={entry.id} active={mode?.kind === 'equipment' && mode.catalogId === entry.id} label={entry.name} detail={money(entry.price)} onClick={() => setMode({ kind: 'equipment', catalogId: entry.id })} />)}
        </PaletteGroup>)}
        <PaletteGroup title="Walls & doors">
          <PaletteButton active={mode?.kind === 'wall'} label="Interior wall" detail="$18k / cell" onClick={() => setMode({ kind: 'wall' })} />
          <PaletteButton active={false} disabled={!selectedWall} label="Door" detail="Select a wall first" onClick={() => {
            if (!selectedWall) return
            const door = createDoor(`${facilityId}:door:${idCounter.current++}`, selectedWall.id, 0.5)
            mutate((current) => ({ ...current, doors: [...current.doors, door] }))
          }} />
        </PaletteGroup>
      </aside>

      <main className="relative min-h-0 min-w-0">
        <DataHallEditorScene key={facilityId} layout={editorLayout!} plannedSpaces={plannedSpaces} analysis={analysis} selectedId={selectedId} mode={mode} showGrid={showGrid} showRoutes={showRoutes} onSelect={setSelectedId} onPlace={placeAt} onMove={moveObject} onPreview={previewPlacement} onPreviewMove={previewObjectMove} />
        <div className="pointer-events-none absolute left-3 top-3 rounded border border-line/70 bg-void/85 px-2 py-1 font-mono text-[0.625rem] uppercase text-muted">Drag orbit · click floor to place · drag object to move · R rotate</div>
        {previewStrategy ? <div className="pointer-events-none absolute right-3 top-3 min-w-56 border border-mint/50 bg-void/90 px-3 py-2 shadow-xl"><p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-mint">Layout preview</p><p className="mt-1 text-sm font-semibold capitalize text-bone">{previewStrategy}</p><p className="mt-1 text-[0.6875rem] text-muted">{draft.objects.filter((object) => object.kind === 'rack').length} installed · {plannedSpaces.length} open spaces</p><p className="mt-1 font-mono text-[0.625rem] text-muted">{draft.objects.filter((object) => object.kind === 'power').length} power · {draft.objects.filter((object) => object.kind === 'cooling').length} cooling · {draft.objects.filter((object) => object.kind === 'network').length} network</p><p className="mt-1 text-[0.625rem] text-muted">Outlined cabinets are reserved capacity. Apply saves infrastructure.</p></div> : null}
      </main>

      <aside className="min-h-0 overflow-y-auto border-l border-line/80 bg-panel/95 p-3">
        <div className="flex items-start justify-between gap-2"><div><p className="font-mono text-[0.625rem] uppercase tracking-widest text-mint">Selected</p><h2 className="mt-1 text-base font-semibold">{selectedObject?.catalogId ?? selectedWall?.id ?? 'Nothing selected'}</h2></div><button type="button" className="p-2 text-muted hover:text-bone" onClick={close} aria-label="Close editor"><X /></button></div>
        {selectedObject ? <div className="mt-4 space-y-2 text-[0.75rem]"><InspectorRow label="Kind" value={selectedObject.kind} /><InspectorRow label="Position" value={`${(selectedObject.x * HALL_GRID_METERS).toFixed(2)}m, ${(selectedObject.z * HALL_GRID_METERS).toFixed(2)}m`} /><InspectorRow label="Rotation" value={`${selectedObject.rotation}°`} /><button type="button" className="hud-button hud-button--secondary w-full" onClick={rotateSelected}>Rotate · R</button><button type="button" className="hud-button hud-button--secondary w-full" onClick={duplicateSelected}>Duplicate</button><button type="button" className="hud-button hud-button--danger w-full" onClick={removeSelected}>{selectedObject.kind === 'rack' ? 'Return to staging' : 'Delete'}</button></div> : selectedWall ? <div className="mt-4 space-y-2"><InspectorRow label="Wall" value={`${Math.abs(selectedWall.x2 - selectedWall.x1) + Math.abs(selectedWall.z2 - selectedWall.z1)} cells`} /><button type="button" className="hud-button hud-button--danger w-full" onClick={removeSelected}>Delete wall</button></div> : null}
        <div className="mt-5 border-t border-line pt-3"><p className="font-mono text-[0.625rem] uppercase tracking-widest text-muted">Operations</p><div className="mt-2 grid grid-cols-2 gap-2"><Metric label="Online" value={`${analysis.operationalRackUnitIds.length}`} good /><Metric label="Offline" value={`${analysis.offlineRackUnitIds.length}`} warning={analysis.offlineRackUnitIds.length > 0} /><Metric label="Environment" value={`${Math.round(analysis.environmentScore * 100)}%`} good={analysis.environmentScore >= 0.85} /><Metric label="Throughput" value={`${Math.round(analysis.throughputMultiplier * 100)}%`} /></div></div>
        {analysis.hardErrors.length ? <Validation title="Blocked" items={analysis.hardErrors} danger /> : null}
        {analysis.warnings.length ? <Validation title="Warnings" items={analysis.warnings} /> : null}
      </aside>

      <footer className="col-span-3 flex items-center gap-2 border-t border-line/80 bg-panel px-3">
        <button type="button" className="hud-button hud-button--secondary" disabled={!past.length} onClick={undo}>Undo</button><button type="button" className="hud-button hud-button--secondary" disabled={!future.length} onClick={redo}>Redo</button>
        <button type="button" className={`hud-button ${showGrid ? 'hud-button--primary' : 'hud-button--secondary'}`} onClick={() => setShowGrid((value) => !value)}>Grid</button><button type="button" className={`hud-button ${showRoutes ? 'hud-button--primary' : 'hud-button--secondary'}`} onClick={() => setShowRoutes((value) => !value)}>Utilities</button>
        <div className="mx-2 h-7 w-px bg-line" />
        <span className="font-mono text-[0.625rem] uppercase tracking-wider text-muted">Preview</span>
        {(['density', 'efficiency', 'resilience'] as const).map((strategy) => <button key={strategy} type="button" className={`hud-button capitalize ${previewStrategy === strategy ? 'hud-button--primary' : 'hud-button--secondary'}`} aria-pressed={previewStrategy === strategy} onClick={() => applyStrategy(strategy)}>{strategy}</button>)}
        <p className="ml-auto max-w-[24rem] truncate text-[0.6875rem] text-muted" role="status">{message}</p>
        <button type="button" className="hud-button hud-button--secondary" onClick={close}>Done</button><button type="button" className="hud-button hud-button--primary min-w-32" disabled={!analysis.valid} onClick={apply}>Apply plan</button>
      </footer>
    </section>
  )
}

function PaletteGroup({ title, children }: { title: string; children: React.ReactNode }) { return <section className="mt-4"><h2 className="mb-2 font-mono text-[0.625rem] uppercase tracking-widest text-muted">{title}</h2><div className="space-y-1">{children}</div></section> }
function PaletteButton({ label, detail, active, disabled, onClick }: { label: string; detail?: string; active?: boolean; disabled?: boolean; onClick: () => void }) { return <button type="button" disabled={disabled} onClick={onClick} className={`flex min-h-10 w-full items-center justify-between border px-2 text-left text-[0.75rem] ${active ? 'border-mint bg-mint/10 text-mint' : 'border-line bg-void/40 text-bone hover:border-mint/40'} disabled:opacity-40`}><span className="truncate">{label}</span><span className="ml-2 shrink-0 font-mono text-[0.625rem] text-muted">{detail}</span></button> }
function InspectorRow({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-3 border-b border-line/60 py-1.5"><span className="text-muted">{label}</span><span className="font-mono text-bone">{value}</span></div> }
function Metric({ label, value, good, warning }: { label: string; value: string; good?: boolean; warning?: boolean }) { return <div className="border border-line bg-void/40 p-2"><span className="block text-[0.625rem] uppercase text-muted">{label}</span><strong className={`mt-1 block font-mono text-sm ${warning ? 'text-amber' : good ? 'text-mint' : 'text-bone'}`}>{value}</strong></div> }
function Validation({ title, items, danger }: { title: string; items: string[]; danger?: boolean }) { return <div className={`mt-4 border p-2 ${danger ? 'border-danger/40 bg-danger/5' : 'border-amber/40 bg-amber/5'}`}><strong className={`text-[0.75rem] ${danger ? 'text-danger' : 'text-amber'}`}>{title}</strong><ul className="mt-1 list-disc space-y-1 pl-4 text-[0.6875rem] text-muted">{items.slice(0, 6).map((item) => <li key={item}>{item}</li>)}</ul></div> }

function DataHallEditorScene({ layout, plannedSpaces, analysis, selectedId, mode, showGrid, showRoutes, onSelect, onPlace, onMove, onPreview, onPreviewMove }: { layout: DataHallLayout; plannedSpaces: DataHallObjectPlacement[]; analysis: ReturnType<typeof analyzeHallLayout>; selectedId: string | null; mode: PaletteMode; showGrid: boolean; showRoutes: boolean; onSelect: (id: string | null) => void; onPlace: (x: number, z: number) => void; onMove: (id: string, x: number, z: number) => void; onPreview: (mode: NonNullable<PaletteMode>, x: number, z: number) => 'valid' | 'warning' | 'invalid'; onPreviewMove: (object: DataHallObjectPlacement, x: number, z: number) => 'valid' | 'warning' | 'invalid' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const selectorRef = useRef<THREE.Mesh | null>(null)
  const renderRef = useRef<() => void>(() => undefined)
  const viewStateRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3; zoom: number } | null>(null)
  const modeRef = useRef(mode)
  const handlersRef = useRef({ onSelect, onPlace, onMove, onPreview, onPreviewMove })
  modeRef.current = mode
  handlersRef.current = { onSelect, onPlace, onMove, onPreview, onPreviewMove }
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true }) } catch { return }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    const shell = DATA_HALL_SHELLS[layout.shellId]
    const widthM = shell.width * HALL_GRID_METERS
    const depthM = shell.depth * HALL_GRID_METERS
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x070b10)
    scene.add(new THREE.HemisphereLight(0xb8dfff, 0x10141a, 2.2))
    const light = new THREE.DirectionalLight(0xffffff, 2.6); light.position.set(8, 16, 10); scene.add(light)
    const aspect = Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight)
    const view = Math.max(widthM, depthM) * 0.52
    const camera = new THREE.OrthographicCamera(-view * aspect, view * aspect, view, -view, 0.1, 300)
    const savedView = viewStateRef.current
    if (savedView) {
      camera.position.copy(savedView.position)
      camera.zoom = savedView.zoom
    } else {
      camera.position.set(widthM * 0.5, Math.max(widthM, depthM) * 1.12, depthM * 0.62)
    }
    const controls = new OrbitControls(camera, canvas); controls.enableDamping = false; controls.target.copy(savedView?.target ?? new THREE.Vector3(0, 0, 0)); controls.minZoom = 0.55; controls.maxZoom = 4
    camera.lookAt(controls.target)
    camera.updateProjectionMatrix()
    const materials = {
      rack: new THREE.MeshStandardMaterial({ color: 0x15232d, metalness: 0.72, roughness: 0.35, emissive: 0x0a3140, emissiveIntensity: 0.22 }),
      cooling: new THREE.MeshStandardMaterial({ color: 0x3bbbd1, metalness: 0.35, roughness: 0.5 }),
      power: new THREE.MeshStandardMaterial({ color: 0xe3a84b, metalness: 0.4, roughness: 0.46 }),
      network: new THREE.MeshStandardMaterial({ color: 0x7c82e8, metalness: 0.5, roughness: 0.4 }),
    }
    const floor = new THREE.Mesh(new THREE.BoxGeometry(widthM, 0.12, depthM), new THREE.MeshStandardMaterial({ color: 0x111820, roughness: 0.92 })); floor.position.y = -0.08; floor.name = 'floor'; scene.add(floor)
    if (showGrid) {
      const fineGrid = new THREE.GridHelper(widthM, shell.width, 0x32798a, 0x264754)
      fineGrid.scale.z = depthM / widthM
      fineGrid.position.y = 0.004
      scene.add(fineGrid)
      const majorGrid = new THREE.GridHelper(widthM, Math.max(1, Math.round(shell.width / 4)), 0x59c8d0, 0x3a7480)
      majorGrid.scale.z = depthM / widthM
      majorGrid.position.y = 0.009
      scene.add(majorGrid)
    }
    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x2c3741, roughness: 0.75 })
    const addWall = (length: number, thickness: number, x: number, z: number, horizontal: boolean, height = 2.4) => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? length : thickness, height, horizontal ? thickness : length), wallMaterial); mesh.position.set(x, height / 2, z); scene.add(mesh) }
    addWall(widthM, 0.18, 0, -depthM / 2, true); addWall(depthM, 0.18, -widthM / 2, 0, false); addWall(depthM, 0.18, widthM / 2, 0, false)
    for (const wall of layout.walls) { const horizontal = wall.z1 === wall.z2; const length = (Math.abs(wall.x2 - wall.x1) + Math.abs(wall.z2 - wall.z1)) * HALL_GRID_METERS; addWall(length, 0.12, ((wall.x1 + wall.x2) / 2) * HALL_GRID_METERS - widthM / 2, ((wall.z1 + wall.z2) / 2) * HALL_GRID_METERS - depthM / 2, horizontal, 2.1) }
    for (const door of layout.doors) {
      const wall = layout.walls.find((candidate) => candidate.id === door.wallId)
      if (!wall) continue
      const horizontal = wall.z1 === wall.z2
      const length = Math.abs(wall.x2 - wall.x1) + Math.abs(wall.z2 - wall.z1)
      const start = Math.round(Math.max(0, length - door.width) * door.offset)
      const x = horizontal ? Math.min(wall.x1, wall.x2) + start + door.width / 2 : wall.x1
      const z = horizontal ? wall.z1 : Math.min(wall.z1, wall.z2) + start + door.width / 2
      const marker = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? door.width * HALL_GRID_METERS : 0.18, 2, horizontal ? 0.22 : door.width * HALL_GRID_METERS), new THREE.MeshStandardMaterial({ color: 0x48d7d1, emissive: 0x164b4b, emissiveIntensity: 0.4 }))
      marker.position.set(x * HALL_GRID_METERS - widthM / 2, 1, z * HALL_GRID_METERS - depthM / 2)
      scene.add(marker)
    }
    const groups = new Map<string, DataHallObjectPlacement[]>()
    for (const object of layout.objects) { const list = groups.get(object.kind) ?? []; list.push(object); groups.set(object.kind, list) }
    const meshes: THREE.InstancedMesh[] = []
    const objectDims = (object: DataHallObjectPlacement) => { const base = object.kind === 'rack' ? { width: 3, depth: 5 } : HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === object.catalogId) ?? { width: 1, depth: 1 }; return object.rotation === 90 || object.rotation === 270 ? { width: base.depth, depth: base.width } : { width: base.width, depth: base.depth } }
    if (plannedSpaces.length) {
      const geometry = new THREE.BoxGeometry(1, 1, 1)
      const material = new THREE.MeshBasicMaterial({ color: 0x60d8d2, wireframe: true, transparent: true, opacity: 0.22, depthWrite: false })
      const spaces = new THREE.InstancedMesh(geometry, material, plannedSpaces.length)
      const matrix = new THREE.Matrix4()
      const position = new THREE.Vector3()
      const quaternion = new THREE.Quaternion()
      const scale = new THREE.Vector3()
      plannedSpaces.forEach((object, index) => {
        const d = objectDims(object)
        position.set((object.x + d.width / 2) * HALL_GRID_METERS - widthM / 2, 1.03, (object.z + d.depth / 2) * HALL_GRID_METERS - depthM / 2)
        scale.set(d.width * HALL_GRID_METERS, 2.02, d.depth * HALL_GRID_METERS)
        matrix.compose(position, quaternion, scale)
        spaces.setMatrixAt(index, matrix)
      })
      spaces.instanceMatrix.needsUpdate = true
      scene.add(spaces)
    }
    for (const [kind, objects] of groups) {
      const geometry = new THREE.BoxGeometry(1, 1, 1)
      const mesh = new THREE.InstancedMesh(geometry, materials[kind as keyof typeof materials], objects.length)
      mesh.userData.objectIds = objects.map((object) => object.id)
      const matrix = new THREE.Matrix4(); const position = new THREE.Vector3(); const quaternion = new THREE.Quaternion(); const scale = new THREE.Vector3()
      objects.forEach((object, index) => { const d = objectDims(object); position.set((object.x + d.width / 2) * HALL_GRID_METERS - widthM / 2, object.kind === 'rack' ? 1.05 : 0.75, (object.z + d.depth / 2) * HALL_GRID_METERS - depthM / 2); scale.set(d.width * HALL_GRID_METERS, object.kind === 'rack' ? 2.1 : 1.5, d.depth * HALL_GRID_METERS); matrix.compose(position, quaternion, scale); mesh.setMatrixAt(index, matrix) })
      scene.add(mesh); meshes.push(mesh)
      if (kind === 'rack') {
        const frontMaterial = new THREE.MeshStandardMaterial({ color: 0x070b0e, metalness: 0.82, roughness: 0.28 })
        const frontPanels = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), frontMaterial, objects.length)
        const slotMaterial = new THREE.MeshStandardMaterial({ color: 0x7cebd2, emissive: 0x1d8b7c, emissiveIntensity: 0.55, metalness: 0.38, roughness: 0.35 })
        const slotCount = 7
        const serverSlots = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), slotMaterial, objects.length * slotCount)
        let slotIndex = 0
        objects.forEach((object, index) => {
          const d = objectDims(object)
          const cx = (object.x + d.width / 2) * HALL_GRID_METERS - widthM / 2
          const cz = (object.z + d.depth / 2) * HALL_GRID_METERS - depthM / 2
          const frontOnX = object.rotation === 90 || object.rotation === 270
          const direction = object.rotation === 180 || object.rotation === 270 ? -1 : 1
          const faceSpan = (frontOnX ? d.depth : d.width) * HALL_GRID_METERS
          const faceX = cx + (frontOnX ? direction * (d.width * HALL_GRID_METERS / 2 + 0.012) : 0)
          const faceZ = cz + (!frontOnX ? direction * (d.depth * HALL_GRID_METERS / 2 + 0.012) : 0)
          scale.set(frontOnX ? 0.025 : faceSpan * 0.9, 1.82, frontOnX ? faceSpan * 0.9 : 0.025)
          matrix.compose(new THREE.Vector3(faceX, 1.05, faceZ), quaternion, scale)
          frontPanels.setMatrixAt(index, matrix)
          for (let slot = 0; slot < slotCount; slot += 1) {
            const y = 0.35 + slot * 0.215
            scale.set(frontOnX ? 0.03 : faceSpan * 0.72, 0.075, frontOnX ? faceSpan * 0.72 : 0.03)
            matrix.compose(new THREE.Vector3(faceX + (frontOnX ? direction * 0.018 : 0), y, faceZ + (!frontOnX ? direction * 0.018 : 0)), quaternion, scale)
            serverSlots.setMatrixAt(slotIndex++, matrix)
          }
        })
        frontPanels.instanceMatrix.needsUpdate = true
        serverSlots.instanceMatrix.needsUpdate = true
        scene.add(frontPanels, serverSlots)
      }
    }
    if (showRoutes) {
      const routeMaterialPower = new THREE.LineBasicMaterial({ color: 0xf2ad49, transparent: true, opacity: 0.85 })
      const routeMaterialNetwork = new THREE.LineBasicMaterial({ color: 0x40d9ff, transparent: true, opacity: 0.85 })
      for (const [routes, material] of [[analysis.powerRoutes, routeMaterialPower], [analysis.networkRoutes, routeMaterialNetwork]] as const) for (const route of routes) { const points = route.cells.map((cell) => new THREE.Vector3((cell % shell.width + 0.5) * HALL_GRID_METERS - widthM / 2, 0.06, (Math.floor(cell / shell.width) + 0.5) * HALL_GRID_METERS - depthM / 2)); if (points.length > 1) scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material)) }
    }
    const selector = new THREE.Mesh(new THREE.BoxGeometry(1, 0.08, 1), new THREE.MeshBasicMaterial({ color: analysis.valid ? 0x48d7d1 : 0xff5252, transparent: true, opacity: 0.45 })); selector.visible = false; selectorRef.current = selector; scene.add(selector)
    const ghostMaterial = new THREE.MeshBasicMaterial({ color: 0x48d7d1, wireframe: true, transparent: true, opacity: 0.85 })
    const ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), ghostMaterial); ghost.visible = false; scene.add(ghost)
    const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2(); let dragging: string | null = null
    const hitPoint = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1); raycaster.setFromCamera(pointer, camera); return raycaster.intersectObject(floor)[0]?.point }
    const objectHit = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1); raycaster.setFromCamera(pointer, camera); const hit = raycaster.intersectObjects(meshes, false)[0]; const ids = hit?.object.userData.objectIds as string[] | undefined; return hit?.instanceId != null ? ids?.[hit.instanceId] ?? null : null }
    const pointToCell = (point: THREE.Vector3) => ({ x: Math.max(0, Math.min(shell.width - 1, Math.floor((point.x + widthM / 2) / HALL_GRID_METERS))), z: Math.max(0, Math.min(shell.depth - 1, Math.floor((point.z + depthM / 2) / HALL_GRID_METERS))) })
    const preview = (event: PointerEvent) => {
      const point = hitPoint(event)
      if (!point) { ghost.visible = false; return }
      const cell = pointToCell(point)
      const draggingObject = dragging ? layout.objects.find((entry) => entry.id === dragging) : undefined
      const activeMode = modeRef.current
      if (!draggingObject && !activeMode) { ghost.visible = false; return }
      const previewObject = draggingObject ?? (activeMode?.kind === 'rack'
        ? { id: '__ghost', kind: 'rack' as const, catalogId: activeMode.skuId, rackUnitId: activeMode.unitId, x: cell.x, z: cell.z, rotation: 0 as const, purchasePrice: 0 }
        : activeMode?.kind === 'equipment'
          ? (() => { const def = HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === activeMode.catalogId)!; return { id: '__ghost', kind: def.kind, catalogId: def.id, x: cell.x, z: cell.z, rotation: 0 as const, purchasePrice: def.price } })()
          : undefined)
      if (!previewObject) { ghost.visible = false; return }
      const d = objectDims(previewObject)
      ghost.scale.set(d.width * HALL_GRID_METERS, previewObject.kind === 'rack' ? 2.1 : 1.5, d.depth * HALL_GRID_METERS)
      ghost.position.set((cell.x + d.width / 2) * HALL_GRID_METERS - widthM / 2, previewObject.kind === 'rack' ? 1.05 : 0.75, (cell.z + d.depth / 2) * HALL_GRID_METERS - depthM / 2)
      const status = activeMode
        ? handlersRef.current.onPreview(activeMode, cell.x, cell.z)
        : draggingObject
          ? handlersRef.current.onPreviewMove(draggingObject, cell.x, cell.z)
          : 'valid'
      ghostMaterial.color.setHex(status === 'invalid' ? 0xff5252 : status === 'warning' ? 0xf0ad4e : 0x48d7d1)
      ghost.visible = true
      render()
    }
    const down = (event: PointerEvent) => { const id = objectHit(event); if (id) { dragging = id; handlersRef.current.onSelect(id); controls.enabled = false; preview(event) } else handlersRef.current.onSelect(null) }
    const up = (event: PointerEvent) => { const point = hitPoint(event); if (point) { const cell = pointToCell(point); if (dragging) handlersRef.current.onMove(dragging, cell.x, cell.z); else if (modeRef.current) handlersRef.current.onPlace(cell.x, cell.z) } dragging = null; controls.enabled = true }
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', preview); canvas.addEventListener('pointerup', up)
    const render = () => renderer.render(scene, camera); renderRef.current = render; controls.addEventListener('change', render)
    const resize = () => { const width = Math.max(1, canvas.clientWidth); const height = Math.max(1, canvas.clientHeight); const nextAspect = width / height; camera.left = -view * nextAspect; camera.right = view * nextAspect; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); render() }
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize()
    return () => { viewStateRef.current = { position: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom }; observer.disconnect(); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', preview); canvas.removeEventListener('pointerup', up); controls.removeEventListener('change', render); controls.dispose(); scene.traverse((object) => { if (object instanceof THREE.Mesh || object instanceof THREE.Line) { object.geometry.dispose(); if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose()); else object.material.dispose() } }); selectorRef.current = null; renderRef.current = () => undefined; renderer.renderLists.dispose(); renderer.dispose() }
  }, [analysis, layout, plannedSpaces, showGrid, showRoutes])
  useEffect(() => {
    const selector = selectorRef.current
    if (!selector) return
    const object = layout.objects.find((entry) => entry.id === selectedId)
    if (!object) { selector.visible = false; renderRef.current(); return }
    const shell = DATA_HALL_SHELLS[layout.shellId]
    const widthM = shell.width * HALL_GRID_METERS
    const depthM = shell.depth * HALL_GRID_METERS
    const base = object.kind === 'rack' ? { width: 3, depth: 5 } : HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === object.catalogId) ?? { width: 1, depth: 1 }
    const d = object.rotation === 90 || object.rotation === 270 ? { width: base.depth, depth: base.width } : { width: base.width, depth: base.depth }
    selector.scale.set(d.width * HALL_GRID_METERS + 0.12, 1, d.depth * HALL_GRID_METERS + 0.12)
    selector.position.set((object.x + d.width / 2) * HALL_GRID_METERS - widthM / 2, 0.04, (object.z + d.depth / 2) * HALL_GRID_METERS - depthM / 2)
    selector.visible = true
    renderRef.current()
  }, [layout, selectedId])
  return <canvas ref={canvasRef} className="h-full w-full touch-none" aria-label="Interactive data hall floor" />
}

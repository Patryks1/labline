import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  ArrowCounterClockwise,
  ArrowsOutCardinal,
  Cube,
  Cpu,
  HardDrives,
  MagnifyingGlass,
  Snowflake,
  SquaresFour,
  Trash,
  X,
} from '@phosphor-icons/react'
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
  quoteHallPlanNetCost,
  rackUnitsForFacility,
  rotateHallObject,
} from '../../../../sim/systems/dataHallLayouts'
import { facilityAnchorTiles } from '../../../../sim/systems/worldAccess'
import { resolveRackSku } from '../../../../sim/systems/racks'
import { useGameStore } from '../../../../store/gameStore'
import { money, mw, num } from '../../format'
import { captureHallClock, restoreHallClock, summarizeHallRackCapacity, type HallClockSnapshot, type HallRackCapacityTotals } from './hallLayoutModel'
import {
  HALL_PALETTE_DATA_MIME,
  groupHallRackPaletteUnits,
  nextAvailableHallRackUnit,
  parseHallPalettePayload,
  serializeHallEquipmentPayload,
  serializeHallRackSkuPayload,
} from './hallPaletteModel'
import { createHallEquipmentModel, rackVariantSeed } from './hallSceneModels'

type Draft = Pick<DataHallLayout, 'objects' | 'walls' | 'doors' | 'preferredStrategy'>
type PaletteMode = { kind: 'rack'; skuId: string } | { kind: 'equipment'; catalogId: string } | { kind: 'wall'; start?: { x: number; z: number } } | null

const cloneDraft = (draft: Draft): Draft => ({
  preferredStrategy: draft.preferredStrategy,
  objects: draft.objects.map((entry) => ({ ...entry })),
  walls: draft.walls.map((entry) => ({ ...entry })),
  doors: draft.doors.map((entry) => ({ ...entry })),
})

const reservedRackAtCell = (draft: Pick<Draft, 'objects'>, x: number, z: number) => draft.objects.find((object) => {
  if (object.kind !== 'rack' || !object.reserved) return false
  const rotated = object.rotation === 90 || object.rotation === 270
  const width = rotated ? 5 : 3
  const depth = rotated ? 3 : 5
  return x >= object.x && x < object.x + width && z >= object.z && z < object.z + depth
})

export function DataHallEditorOverlay() {
  const facilityId = useGameStore((store) => store.hallEditorFacilityId)
  const state = useGameStore((store) => store.state)
  const close = useGameStore((store) => store.closeHallEditor)
  const applyPlan = useGameStore((store) => store.applyHallEditorPlan)
  const openRackDesigner = useGameStore((store) => store.openRackDesigner)
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
  const [message, setMessage] = useState('Draft changes are not live until Apply plan.')
  const [paletteSearch, setPaletteSearch] = useState('')
  const [shiftHeld, setShiftHeld] = useState(false)
  const idCounter = useRef(1)
  const priorClock = useRef<HallClockSnapshot | null>(null)
  const repeatPlacement = useRef(false)
  const draftRef = useRef<Draft | null>(null)

  useEffect(() => {
    if (!facilityId || !layout) return
    const initialDraft = cloneDraft(layout)
    draftRef.current = initialDraft
    setDraft(initialDraft)
    setPast([])
    setFuture([])
    setSelectedId(null)
    setMode(null)
    setPaletteSearch('')
    setShiftHeld(false)
    repeatPlacement.current = false
    setPreviewStrategy(null)
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

  useEffect(() => {
    if (!facilityId) return
    setMessage('Draft changes are not live until Apply plan.')
  }, [facilityId])

  const editorLayout = useMemo(() => layout && draft ? { ...layout, ...draft } : null, [draft, layout])
  const analysis = useMemo(() => editorLayout && hall
    ? analyzeHallLayout(editorLayout, inventory, hall.rackCapacity)
    : null, [editorLayout, hall, inventory])
  const planNetCost = useMemo(() => layout && draft ? quoteHallPlanNetCost(layout, draft) : 0, [draft, layout])
  const canAffordPlan = state.player.cash >= planNetCost
  const placedUnits = useMemo(() => new Set(draft?.objects.flatMap((object) => object.rackUnitId ? [object.rackUnitId] : []) ?? []), [draft])
  const staging = inventory.filter((unit) => unit.delivered && !placedUnits.has(unit.unitId))
  const rackGroups = useMemo(() => groupHallRackPaletteUnits(inventory, placedUnits), [inventory, placedUnits])
  const rackCards = useMemo(() => rackGroups.flatMap((group) => {
    try {
      return [{ ...group, sku: resolveRackSku(group.skuId, state.player.rackDesigns ?? []) }]
    } catch {
      return []
    }
  }), [rackGroups, state.player.rackDesigns])
  const paletteQuery = paletteSearch.trim().toLocaleLowerCase()
  const visibleRackCards = rackCards.filter(({ sku, skuId }) => !paletteQuery || `${sku.name} ${sku.blurb} ${skuId}`.toLocaleLowerCase().includes(paletteQuery))
  const savedRackImpact = useMemo(() => summarizeHallRackCapacity(layout?.objects ?? [], (skuId) => {
    try { return resolveRackSku(skuId, state.player.rackDesigns ?? []) } catch { return undefined }
  }), [layout?.objects, state.player.rackDesigns])
  const draftRackImpact = useMemo(() => summarizeHallRackCapacity(draft?.objects ?? [], (skuId) => {
    try { return resolveRackSku(skuId, state.player.rackDesigns ?? []) } catch { return undefined }
  }), [draft?.objects, state.player.rackDesigns])
  const planCapacity = useMemo<HallRackCapacityTotals>(() => ({
    cabinets: draftRackImpact.installed.cabinets + draftRackImpact.planned.cabinets,
    flopsPf: draftRackImpact.installed.flopsPf + draftRackImpact.planned.flopsPf,
    vramGb: draftRackImpact.installed.vramGb + draftRackImpact.planned.vramGb,
    mw: draftRackImpact.installed.mw + draftRackImpact.planned.mw,
    tokPerSec: draftRackImpact.installed.tokPerSec + draftRackImpact.planned.tokPerSec,
  }), [draftRackImpact])
  const hasDraftChanges = useMemo(() => Boolean(layout && draft) && JSON.stringify({ objects: draft!.objects, walls: draft!.walls, doors: draft!.doors, preferredStrategy: draft!.preferredStrategy }) !== JSON.stringify({ objects: layout!.objects, walls: layout!.walls, doors: layout!.doors, preferredStrategy: layout!.preferredStrategy }), [draft, layout])
  const selectedObject = draft?.objects.find((object) => object.id === selectedId)
  const selectedWall = draft?.walls.find((wall) => wall.id === selectedId)

  const mutate = useCallback((operation: (current: Draft) => Draft) => {
    setPreviewStrategy(null)
    const current = draftRef.current
    if (!current) return
    const next = operation(cloneDraft(current))
    draftRef.current = next
    setPast((entries) => [...entries.slice(-49), cloneDraft(current)])
    setFuture([])
    setDraft(next)
  }, [])

  const undo = useCallback(() => {
    setPreviewStrategy(null)
    setPast((entries) => {
      const previous = entries.at(-1)
      if (!previous) return entries
      setDraft((current) => {
        if (current) setFuture((next) => [cloneDraft(current), ...next].slice(0, 50))
        const restored = cloneDraft(previous)
        draftRef.current = restored
        return restored
      })
      return entries.slice(0, -1)
    })
  }, [])
  const redo = useCallback(() => {
    setPreviewStrategy(null)
    setFuture((entries) => {
      const next = entries[0]
      if (!next) return entries
      setDraft((current) => {
        if (current) setPast((history) => [...history.slice(-49), cloneDraft(current)])
        const restored = cloneDraft(next)
        draftRef.current = restored
        return restored
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
    if (!selectedId || !layout || !hall) return
    const current = draftRef.current
    const object = current?.objects.find((entry) => entry.id === selectedId)
    if (!current || !object) return
    const rotated = rotateHallObject(object)
    if (previewHallObjectPlacement({ ...layout, ...current }, rotated, hall.rackCapacity) === 'invalid') {
      setMessage('Rotation blocked: the rotated footprint would collide with the room or another asset.')
      return
    }
    mutate((draft) => ({ ...draft, objects: draft.objects.map((entry) => entry.id === selectedId ? rotated : entry) }))
  }, [hall, layout, mutate, selectedId])

  const duplicateSelected = useCallback(() => {
    if (!selectedObject) return
    if (selectedObject.kind === 'rack') {
      const currentPlacedUnits = new Set(draftRef.current?.objects.flatMap((object) => object.rackUnitId ? [object.rackUnitId] : []) ?? [])
      const replacement = inventory
        .filter((unit) => unit.delivered && unit.skuId === selectedObject.catalogId && !currentPlacedUnits.has(unit.unitId))
        .sort((a, b) => a.unitId.localeCompare(b.unitId))[0]
      if (!replacement) { setMessage('No matching staged rack is available to duplicate this chassis.'); return }
      const id = `${facilityId}:draft:${idCounter.current++}`
      const duplicate = { ...selectedObject, id, rackUnitId: replacement.unitId, x: selectedObject.x + 4, purchasePrice: 0 }
      const current = draftRef.current
      if (!layout || !hall || !current || previewHallObjectPlacement({ ...layout, ...current }, duplicate, hall.rackCapacity) === 'invalid') {
        setMessage('Duplicate blocked: move the selected rack somewhere with more clear floor space first.')
        return
      }
      mutate((draft) => ({ ...draft, objects: [...draft.objects, duplicate] }))
      setSelectedId(id)
      return
    }
    const def = HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === selectedObject.catalogId)
    if (!def) return
    const id = `${facilityId}:draft:${idCounter.current++}`
    const duplicate = { ...selectedObject, id, x: selectedObject.x + 4, purchasePrice: def.price }
    const current = draftRef.current
    if (!layout || !hall || !current || previewHallObjectPlacement({ ...layout, ...current }, duplicate, hall.rackCapacity) === 'invalid') {
      setMessage('Duplicate blocked: there is not enough clear floor space beside this asset.')
      return
    }
    mutate((draft) => ({ ...draft, objects: [...draft.objects, duplicate] }))
    setSelectedId(id)
  }, [facilityId, hall, inventory, layout, mutate, selectedObject])

  useEffect(() => {
    if (!facilityId) return
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select')) return
      if (event.key === 'Shift') { setShiftHeld(true); return }
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); repeatPlacement.current = false; if (mode) setMode(null); else close(); return }
      if (event.key.toLowerCase() === 'r') { event.preventDefault(); event.stopImmediatePropagation(); rotateSelected(); return }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopImmediatePropagation(); removeSelected(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopImmediatePropagation(); if (event.shiftKey) redo(); else undo(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); event.stopImmediatePropagation(); redo() }
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Shift') return
      setShiftHeld(false)
      if (repeatPlacement.current) {
        repeatPlacement.current = false
        setMode(null)
        setMessage('Repeated placement finished.')
      }
    }
    const clearLostModifier = () => {
      setShiftHeld(false)
      if (!repeatPlacement.current) return
      repeatPlacement.current = false
      setMode(null)
      setMessage('Repeated placement finished.')
    }
    const handleVisibility = () => { if (document.hidden) clearLostModifier() }
    window.addEventListener('keydown', handler, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('blur', clearLostModifier)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('keydown', handler, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('blur', clearLostModifier)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [close, facilityId, mode, redo, removeSelected, rotateSelected, undo])

  const previewPlacement = useCallback((previewMode: NonNullable<PaletteMode>, x: number, z: number): 'valid' | 'warning' | 'invalid' => {
    if (!layout || !draft || !hall || !analysis) return 'invalid'
    const currentDraft = draftRef.current ?? draft
    const candidate = cloneDraft(currentDraft)
    if (previewMode.kind === 'wall') {
      if (!previewMode.start) return 'valid'
      const horizontal = Math.abs(x - previewMode.start.x) >= Math.abs(z - previewMode.start.z)
      const end = horizontal ? { x, z: previewMode.start.z } : { x: previewMode.start.x, z }
      candidate.walls.push(createWall('__preview-wall', previewMode.start.x, previewMode.start.z, end.x, end.z))
    } else {
      const reserved = previewMode.kind === 'rack'
        ? reservedRackAtCell(candidate, x, z)
        : undefined
      if (reserved) candidate.objects = candidate.objects.filter((object) => object.id !== reserved.id)
      const object: DataHallObjectPlacement = previewMode.kind === 'rack'
        ? { id: '__preview', kind: 'rack', catalogId: previewMode.skuId, x: reserved?.x ?? x, z: reserved?.z ?? z, rotation: reserved?.rotation ?? 0, purchasePrice: 0 }
        : (() => { const def = HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === previewMode.catalogId)!; return { id: '__preview', kind: def.kind, catalogId: def.id, x, z, rotation: 0, purchasePrice: def.price } })()
      candidate.objects.push(object)
    }
    const object = candidate.objects.at(-1)
    if (!object || object.id !== '__preview') {
      const result = analyzeHallLayout({ ...layout, ...candidate }, inventory, hall.rackCapacity)
      return result.valid ? result.warnings.length > analysis.warnings.length ? 'warning' : 'valid' : 'invalid'
    }
    return previewHallObjectPlacement({ ...layout, ...candidate }, object, hall.rackCapacity)
  }, [analysis, draft, hall, inventory, layout])

  const previewObjectMove = useCallback((object: DataHallObjectPlacement, x: number, z: number) => {
    if (!layout || !draft || !hall) return 'invalid' as const
    return previewHallObjectPlacement({ ...layout, ...(draftRef.current ?? draft) }, { ...object, x, z }, hall.rackCapacity)
  }, [draft, hall, layout])

  if (!facilityId) return null
  if (!layout || !hall || !draft || !analysis) return <div className="fixed inset-0 z-[100] grid place-items-center bg-void text-bone">Preparing data hall…</div>

  const placeAt = (x: number, z: number, keepActive = false, requestedMode: PaletteMode = mode) => {
    if (!requestedMode) return
    if (requestedMode.kind === 'wall') {
      if (!requestedMode.start) { setMode({ ...requestedMode, start: { x, z } }); setMessage('Choose the wall end point.'); return }
      const horizontal = Math.abs(x - requestedMode.start.x) >= Math.abs(z - requestedMode.start.z)
      const end = horizontal ? { x, z: requestedMode.start.z } : { x: requestedMode.start.x, z }
      const wall = createWall(`${facilityId}:wall:${idCounter.current++}`, requestedMode.start.x, requestedMode.start.z, end.x, end.z)
      const current = draftRef.current
      if (!current) return
      const candidate = { ...layout, ...current, walls: [...current.walls, wall] }
      const result = analyzeHallLayout(candidate, inventory, hall.rackCapacity)
      if (!result.valid) {
        setMessage(`Wall blocked: ${result.hardErrors[0] ?? 'choose a clear route.'}`)
        setMode({ kind: 'wall' })
        return
      }
      mutate((current) => ({ ...current, walls: [...current.walls, wall] }))
      setMode({ kind: 'wall' })
      return
    }
    const placementState = previewPlacement(requestedMode, x, z)
    if (placementState === 'invalid') {
      setMessage('That grid position is blocked. Choose a red-free footprint.')
      return
    }
    const id = `${facilityId}:draft:${idCounter.current++}`
    const currentPlacedUnits = new Set(draftRef.current?.objects.flatMap((object) => object.rackUnitId ? [object.rackUnitId] : []) ?? [])
    const rackUnitId = requestedMode.kind === 'rack'
      ? nextAvailableHallRackUnit(groupHallRackPaletteUnits(inventory, currentPlacedUnits).find((group) => group.skuId === requestedMode.skuId) ?? { unitIds: [] }) ?? undefined
      : undefined
    if (requestedMode.kind === 'rack' && !rackUnitId) {
      repeatPlacement.current = false
      setMode(null)
      setMessage('No more staged racks of this design are available.')
      return
    }
    const reserved = requestedMode.kind === 'rack' && draftRef.current
      ? reservedRackAtCell(draftRef.current, x, z)
      : undefined
    const object: DataHallObjectPlacement = requestedMode.kind === 'rack'
      ? { id, kind: 'rack', catalogId: requestedMode.skuId, rackUnitId, x: reserved?.x ?? x, z: reserved?.z ?? z, rotation: reserved?.rotation ?? 0, purchasePrice: 0 }
      : (() => {
          const def = HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === requestedMode.catalogId)!
          return { id, kind: def.kind, catalogId: def.id, x, z, rotation: 0, purchasePrice: def.price }
        })()
    mutate((current) => ({ ...current, objects: [...current.objects.filter((entry) => entry.id !== reserved?.id), object] }))
    setSelectedId(id)
    if (keepActive) {
      repeatPlacement.current = true
      setMode(requestedMode)
      setMessage(`Placed ${requestedMode.kind === 'rack' ? requestedMode.skuId : object.catalogId}. Keep holding Shift to place another.`)
    } else {
      repeatPlacement.current = false
      setMode(null)
    }
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
    const spaces = capacityPlan.objects
      .filter((object) => object.rackUnitId?.startsWith('\uffffspace:'))
      .map((object) => ({
        ...object,
        id: `${facilityId}:reserved:${object.rackUnitId!.slice('\uffffspace:'.length)}`,
        rackUnitId: undefined,
        reserved: true,
        purchasePrice: 0,
      }))
    const planned = {
      ...capacityPlan,
      objects: [
        ...capacityPlan.objects.filter((object) => !object.rackUnitId?.startsWith('\uffffspace:')),
        ...spaces,
      ],
    }
    mutate(() => cloneDraft(planned))
    setPreviewStrategy(strategy)
    setMessage(`${strategy[0].toUpperCase()}${strategy.slice(1)} plan created ${spaces.length} visible rack cabinets. Apply plan to save them and the supporting infrastructure.`)
  }

  const apply = () => {
    const current = draftRef.current
    if (!current) return
    if (!hasDraftChanges) {
      setMessage('This hall plan is already saved and live.')
      return
    }
    const currentAnalysis = analyzeHallLayout({ ...layout, ...current }, inventory, hall.rackCapacity)
    if (!currentAnalysis.valid) {
      setMessage(`Cannot apply yet: ${currentAnalysis.hardErrors[0] ?? 'resolve the blocked layout items.'}`)
      return
    }
    const result = applyPlan({ facilityId, expectedRevision: layout.revision, objects: current.objects, walls: current.walls, doors: current.doors, preferredStrategy: current.preferredStrategy })
    if (!result.ok) { setMessage(result.error ?? 'Plan could not be applied.'); return }
    setPast([])
    setFuture([])
    setMessage(`Plan applied and saved${result.netCost > 0 ? ` · ${money(result.netCost)}` : result.netCost < 0 ? ` · ${money(-result.netCost)} recovered` : ''}. Placements are now live.`)
  }

  const startPaletteDrag = (event: ReactDragEvent<HTMLButtonElement>, selection: NonNullable<PaletteMode>) => {
    if (selection.kind === 'wall') return
    const payload = selection.kind === 'rack'
      ? serializeHallRackSkuPayload(selection.skuId)
      : serializeHallEquipmentPayload(selection.catalogId)
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(HALL_PALETTE_DATA_MIME, payload)
    event.dataTransfer.setData('text/plain', selection.kind === 'rack' ? selection.skuId : selection.catalogId)
    setMode(selection)
    setMessage(`Drag ${selection.kind === 'rack' ? 'rack' : 'equipment'} onto a clear floor position.`)
  }

  const finishPaletteDrag = () => {
    if (!repeatPlacement.current) setMode(null)
  }

  return (
    <section className="fixed inset-0 z-[100] grid grid-cols-[20rem_minmax(0,1fr)_20rem] grid-rows-[minmax(0,1fr)_4.5rem] bg-[#070b10] text-bone" role="dialog" aria-modal="true" aria-label="Data Hall Editor">
      <aside className="min-h-0 overflow-y-auto border-r border-line/80 bg-panel/95 p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.2em] text-mint">Hall planner</p>
            <h1 className="mt-1 text-xl font-semibold">Build inventory</h1>
            <p className="mt-1 text-[0.75rem] text-muted">{hall.name} · 250 mm snap grid</p>
          </div>
          <div className="rounded-lg border border-line/70 bg-void/60 px-2 py-1 text-right">
            <span className="block font-mono text-sm font-semibold text-bone">{staging.length}</span>
            <span className="block text-[0.5625rem] uppercase tracking-wider text-muted">staged</span>
          </div>
        </div>

        <label className="relative mt-4 block">
          <span className="sr-only">Search hall inventory</span>
          <MagnifyingGlass aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" size={15} />
          <input value={paletteSearch} onChange={(event) => setPaletteSearch(event.target.value)} placeholder="Search racks and equipment…" className="h-9 w-full rounded-lg border border-line/80 bg-void/60 pl-8 pr-8 text-[0.75rem] text-bone outline-none placeholder:text-muted/70 focus:border-mint/60 focus:ring-2 focus:ring-mint/15" />
          {paletteSearch ? <button type="button" onClick={() => setPaletteSearch('')} aria-label="Clear search" className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-muted hover:bg-mint/10 hover:text-mint"><X size={12} /></button> : null}
        </label>

        <div className={`mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-[0.6875rem] ${shiftHeld ? 'border-mint/50 bg-mint/10 text-mint' : 'border-line/70 bg-void/45 text-muted'}`}>
          <ArrowsOutCardinal size={15} weight="duotone" />
          <span>{shiftHeld ? 'Repeat placement active' : 'Hold Shift to place multiples'}</span>
        </div>

        <button type="button" onClick={() => {
          if (hasDraftChanges) {
            setMessage('Apply or undo the current hall changes before opening the rack designer.')
            return
          }
          openRackDesigner(facilityId)
        }} className="mt-3 flex w-full items-center gap-3 rounded-lg border border-mint/35 bg-mint/10 px-3 py-2.5 text-left transition hover:border-mint/65 hover:bg-mint/15">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-mint text-void"><Cpu size={19} weight="duotone" /></span>
          <span className="min-w-0"><strong className="block text-[0.8125rem] text-bone">Design your own rack</strong><span className="mt-0.5 block text-[0.625rem] leading-snug text-muted">Configure a custom chassis and components, then order it for this hall.</span></span>
        </button>

        <PaletteGroup title={`Racks · ${rackGroups.length} designs`}>
          {visibleRackCards.length ? visibleRackCards.map(({ skuId, availableCount, sku }) => (
            <RackPaletteCard
              key={skuId}
              active={mode?.kind === 'rack' && mode.skuId === skuId}
              name={sku.name}
              skuId={skuId}
              count={availableCount}
              generation={sku.generation}
              powerMw={sku.mw}
              networkGbps={sku.networkGbps ?? sku.accelerator?.interconnectGbps ?? 0}
              custom={Boolean(sku.custom)}
              onClick={() => setMode({ kind: 'rack', skuId })}
              onDragStart={(event) => startPaletteDrag(event, { kind: 'rack', skuId })}
              onDragEnd={finishPaletteDrag}
            />
          )) : <p className="rounded-lg border border-dashed border-line/80 p-3 text-[0.75rem] text-muted">{rackGroups.length ? 'No rack designs match this search.' : 'No delivered, unplaced racks.'}</p>}
        </PaletteGroup>
        {(['cooling', 'power', 'network'] as const).map((kind) => {
          const entries = HALL_EQUIPMENT_CATALOG.filter((entry) => entry.kind === kind && (!paletteQuery || `${entry.name} ${entry.id} ${kind}`.toLocaleLowerCase().includes(paletteQuery)))
          if (!entries.length && paletteQuery) return null
          return <PaletteGroup key={kind} title={kind}>
            <div className="grid grid-cols-2 gap-2">
              {entries.map((entry) => <EquipmentPaletteCard
                key={entry.id}
                kind={kind}
                active={mode?.kind === 'equipment' && mode.catalogId === entry.id}
                name={entry.name}
                price={money(entry.price)}
                onClick={() => setMode({ kind: 'equipment', catalogId: entry.id })}
                onDragStart={(event) => startPaletteDrag(event, { kind: 'equipment', catalogId: entry.id })}
                onDragEnd={finishPaletteDrag}
              />)}
            </div>
          </PaletteGroup>
        })}
        <PaletteGroup title="Walls & doors">
          <PaletteButton active={mode?.kind === 'wall'} label="Interior wall" detail="$18k / cell" onClick={() => setMode({ kind: 'wall' })} />
          <PaletteButton active={false} disabled={!selectedWall} label="Door" detail="Select a wall first" onClick={() => {
            if (!selectedWall) return
            const door = createDoor(`${facilityId}:door:${idCounter.current++}`, selectedWall.id, 0.5)
            const current = draftRef.current
            if (!current) return
            const result = analyzeHallLayout({ ...layout, ...current, doors: [...current.doors, door] }, inventory, hall.rackCapacity)
            if (!result.valid) {
              setMessage(`Door blocked: ${result.hardErrors[0] ?? 'choose another wall.'}`)
              return
            }
            mutate((current) => ({ ...current, doors: [...current.doors, door] }))
          }} />
        </PaletteGroup>
      </aside>

      <main className="relative min-h-0 min-w-0">
        <DataHallEditorScene key={facilityId} layout={editorLayout!} analysis={analysis} selectedId={selectedId} mode={mode} showGrid={showGrid} showRoutes={showRoutes} onSelect={setSelectedId} onPlace={placeAt} onMove={moveObject} onPreview={previewPlacement} onPreviewMove={previewObjectMove} />
        <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-lg border border-line/70 bg-void/90 px-3 py-2 font-mono text-[0.625rem] uppercase tracking-wide text-muted shadow-xl"><Cube size={14} className="text-mint" />Drag cards to build · drag floor to orbit · drag assets to move · Shift repeats · R rotates</div>
        {previewStrategy ? <div className="pointer-events-none absolute right-3 top-3 min-w-56 rounded-lg border border-mint/50 bg-void/90 px-3 py-2 shadow-xl"><p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-mint">Layout preview</p><p className="mt-1 text-sm font-semibold capitalize text-bone">{previewStrategy}</p><p className="mt-1 text-[0.6875rem] text-muted">{draft.objects.filter((object) => object.kind === 'rack' && !object.reserved).length} installed · {draft.objects.filter((object) => object.kind === 'rack' && object.reserved).length} planned cabinets</p><p className="mt-1 font-mono text-[0.625rem] text-muted">{draft.objects.filter((object) => object.kind === 'power').length} power · {draft.objects.filter((object) => object.kind === 'cooling').length} cooling · {draft.objects.filter((object) => object.kind === 'network').length} network</p><p className="mt-1 text-[0.625rem] leading-relaxed text-muted">Planned cabinets are saved as visible empty racks. Delivered hardware fills them and becomes operational. Infrastructure cost: {planNetCost > 0 ? money(planNetCost) : 'none'}.</p></div> : null}
      </main>

      <aside className="min-h-0 overflow-y-auto border-l border-line/80 bg-panel/95 p-3">
        <div className="flex items-start justify-between gap-2"><div><p className="font-mono text-[0.625rem] uppercase tracking-widest text-mint">Selected</p><h2 className="mt-1 text-base font-semibold">{selectedObject?.catalogId ?? selectedWall?.id ?? 'Nothing selected'}</h2></div><button type="button" className="p-2 text-muted hover:text-bone" onClick={close} aria-label="Close editor"><X /></button></div>
        {selectedObject ? <div className="mt-4 space-y-2 text-[0.75rem]"><InspectorRow label="Kind" value={selectedObject.reserved ? 'planned rack cabinet' : selectedObject.kind} /><InspectorRow label="Position" value={`${(selectedObject.x * HALL_GRID_METERS).toFixed(2)}m, ${(selectedObject.z * HALL_GRID_METERS).toFixed(2)}m`} /><InspectorRow label="Rotation" value={`${selectedObject.rotation}°`} /><button type="button" className="hud-button hud-button--secondary flex w-full items-center justify-center gap-2" onClick={rotateSelected}><ArrowCounterClockwise size={14} />Rotate · R</button>{!selectedObject.reserved ? <button type="button" className="hud-button hud-button--secondary w-full" onClick={duplicateSelected}>Duplicate</button> : null}<button type="button" className="hud-button hud-button--danger flex w-full items-center justify-center gap-2" onClick={removeSelected}><Trash size={14} />{selectedObject.reserved ? 'Remove planned cabinet' : selectedObject.kind === 'rack' ? 'Return to staging' : 'Delete'}</button></div> : selectedWall ? <div className="mt-4 space-y-2"><InspectorRow label="Wall" value={`${Math.abs(selectedWall.x2 - selectedWall.x1) + Math.abs(selectedWall.z2 - selectedWall.z1)} cells`} /><button type="button" className="hud-button hud-button--danger flex w-full items-center justify-center gap-2" onClick={removeSelected}><Trash size={14} />Delete wall</button></div> : null}
        <div className={`mt-4 rounded-lg border p-3 ${!hasDraftChanges ? 'border-mint/35 bg-mint/5' : analysis.valid && canAffordPlan ? 'border-line bg-void/40' : 'border-danger/45 bg-danger/5'}`}><p className={`font-mono text-[0.625rem] uppercase tracking-widest ${!hasDraftChanges ? 'text-mint' : analysis.valid && canAffordPlan ? 'text-muted' : 'text-danger'}`}>{!hasDraftChanges ? 'Plan saved' : !analysis.valid ? `${analysis.hardErrors.length} blocker${analysis.hardErrors.length === 1 ? '' : 's'}` : canAffordPlan ? 'Ready to apply' : 'Insufficient cash'}</p><p className="mt-1 text-[0.6875rem] leading-relaxed text-muted">{!hasDraftChanges ? 'Every visible placement is live.' : !analysis.valid ? analysis.hardErrors[0] : !canAffordPlan ? `Need ${money(planNetCost - state.player.cash)} more to build this infrastructure.` : `Apply commits every visible placement${planNetCost > 0 ? ` for ${money(planNetCost)}` : planNetCost < 0 ? ` and refunds ${money(-planNetCost)}` : ' at no added cost'}.`}</p></div>
        <section className="mt-4 rounded-lg border border-line bg-void/35 p-3">
          <div className="flex items-center justify-between gap-3">
            <div><p className="font-mono text-[0.625rem] uppercase tracking-widest text-muted">Hardware capacity</p><h3 className="mt-1 text-sm font-semibold text-bone">Installed vs planned</h3></div>
            <HallCapacityPie installed={draftRackImpact.installed.cabinets} planned={draftRackImpact.planned.cabinets} capacity={hall.rackCapacity} />
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1 text-[0.5625rem] text-muted"><span><i className="mr-1 inline-block size-1.5 rounded-full bg-mint" />{draftRackImpact.installed.cabinets} installed</span><span><i className="mr-1 inline-block size-1.5 rounded-full bg-violet-400" />{draftRackImpact.planned.cabinets} planned</span><span><i className="mr-1 inline-block size-1.5 rounded-full bg-line" />{Math.max(0, hall.rackCapacity - planCapacity.cabinets)} free</span></div>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-x-2 border-b border-line/70 pb-1 font-mono text-[0.5625rem] uppercase tracking-wider text-muted"><span>Resource</span><span>Have</span><span>With plan</span></div>
          <CapacityImpactRow label="Compute" current={savedRackImpact.installed.flopsPf} withPlan={planCapacity.flopsPf} format={(value) => `${num(value, 1)} PF`} />
          <CapacityImpactRow label="VRAM" current={savedRackImpact.installed.vramGb} withPlan={planCapacity.vramGb} format={formatCapacityVram} />
          <CapacityImpactRow label="Rack power" current={savedRackImpact.installed.mw} withPlan={planCapacity.mw} format={mw} />
          <CapacityImpactRow label="Serve rate" current={savedRackImpact.installed.tokPerSec} withPlan={planCapacity.tokPerSec} format={formatServeRate} />
          <p className="mt-2 text-[0.625rem] leading-relaxed text-muted">Planned capacity assumes each empty cabinet is populated with its assigned rack profile. Effective compute at this layout is {num(planCapacity.flopsPf * analysis.throughputMultiplier, 1)} PF.</p>
        </section>
        <div className="mt-5 border-t border-line pt-3"><p className="font-mono text-[0.625rem] uppercase tracking-widest text-muted">Operations</p><div className="mt-2 grid grid-cols-2 gap-2"><Metric label="Online" value={`${analysis.operationalRackUnitIds.length}`} good /><Metric label="Offline" value={`${analysis.offlineRackUnitIds.length}`} warning={analysis.offlineRackUnitIds.length > 0} /><Metric label="Planned" value={`${draft.objects.filter((object) => object.kind === 'rack' && object.reserved).length}`} /><Metric label="Environment" value={`${Math.round(analysis.environmentScore * 100)}%`} good={analysis.environmentScore >= 0.85} /><Metric label="Throughput" value={`${Math.round(analysis.throughputMultiplier * 100)}%`} /></div></div>
        {analysis.hardErrors.length ? <Validation title="Blocked" items={analysis.hardErrors} danger /> : null}
        {analysis.warnings.length ? <Validation title="Warnings" items={analysis.warnings} /> : null}
      </aside>

      <footer className="col-span-3 flex items-center gap-2 border-t border-line/80 bg-panel px-3">
        <button type="button" className="hud-button hud-button--secondary" disabled={!past.length} onClick={undo}>Undo</button><button type="button" className="hud-button hud-button--secondary" disabled={!future.length} onClick={redo}>Redo</button>
        <button type="button" className={`hud-button flex items-center gap-1.5 ${showGrid ? 'hud-button--primary' : 'hud-button--secondary'}`} onClick={() => setShowGrid((value) => !value)}><SquaresFour size={14} />Grid</button><button type="button" className={`hud-button ${showRoutes ? 'hud-button--primary' : 'hud-button--secondary'}`} onClick={() => setShowRoutes((value) => !value)}>Utilities</button>
        <div className="mx-2 h-7 w-px bg-line" />
        <span className="font-mono text-[0.625rem] uppercase tracking-wider text-muted">Preview</span>
        {(['density', 'efficiency', 'resilience'] as const).map((strategy) => <button key={strategy} type="button" className={`hud-button capitalize ${previewStrategy === strategy ? 'hud-button--primary' : 'hud-button--secondary'}`} aria-pressed={previewStrategy === strategy} onClick={() => applyStrategy(strategy)}>{strategy}</button>)}
        <p className="ml-auto max-w-[30rem] text-[0.6875rem] leading-tight text-muted" role="status">{message}</p>
        <button type="button" className="hud-button hud-button--secondary" onClick={close}>Done</button><button type="button" className={`hud-button min-w-40 ${analysis.valid && canAffordPlan ? 'hud-button--primary' : 'hud-button--danger'}`} disabled={!hasDraftChanges} title={!analysis.valid ? analysis.hardErrors[0] : !canAffordPlan ? `Need ${money(planNetCost - state.player.cash)} more` : undefined} onClick={apply}>{!hasDraftChanges ? 'Saved' : !analysis.valid ? `Fix ${analysis.hardErrors.length} blocker${analysis.hardErrors.length === 1 ? '' : 's'}` : !canAffordPlan ? `Need ${money(planNetCost - state.player.cash)}` : planNetCost > 0 ? `Apply · ${money(planNetCost)}` : planNetCost < 0 ? `Apply · +${money(-planNetCost)}` : 'Apply plan'}</button>
      </footer>
    </section>
  )
}

function PaletteGroup({ title, children }: { title: string; children: React.ReactNode }) { return <section className="mt-4"><h2 className="mb-2 font-mono text-[0.625rem] uppercase tracking-widest text-muted">{title}</h2><div className="space-y-1">{children}</div></section> }
function PaletteButton({ label, detail, active, disabled, onClick }: { label: string; detail?: string; active?: boolean; disabled?: boolean; onClick: () => void }) { return <button type="button" disabled={disabled} onClick={onClick} className={`flex min-h-10 w-full items-center justify-between border px-2 text-left text-[0.75rem] ${active ? 'border-mint bg-mint/10 text-mint' : 'border-line bg-void/40 text-bone hover:border-mint/40'} disabled:opacity-40`}><span className="truncate">{label}</span><span className="ml-2 shrink-0 font-mono text-[0.625rem] text-muted">{detail}</span></button> }
function RackPaletteCard({ name, skuId, count, generation, powerMw, networkGbps, custom, active, onClick, onDragStart, onDragEnd }: { name: string; skuId: string; count: number; generation: number; powerMw: number; networkGbps: number; custom: boolean; active: boolean; onClick: () => void; onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => void; onDragEnd: () => void }) {
  return <button type="button" draggable={count > 0} aria-pressed={active} onClick={onClick} onDragStart={onDragStart} onDragEnd={onDragEnd} className={`group flex w-full items-stretch overflow-hidden rounded-lg border text-left transition ${active ? 'border-mint bg-mint/10 ring-2 ring-mint/20' : 'border-line/75 bg-void/45 hover:border-mint/40 hover:bg-panel-2/80'}`} title="Click to place or drag onto the hall floor">
    <RackCardVisual skuId={skuId} generation={generation} custom={custom} />
    <span className="min-w-0 flex-1 px-2.5 py-2">
      <span className="flex items-start justify-between gap-2"><span className="truncate text-[0.8125rem] font-semibold text-bone">{name}</span><span className="rounded bg-mint/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-mint">×{count}</span></span>
      <span className="mt-0.5 block truncate font-mono text-[0.5625rem] uppercase tracking-wider text-muted">{custom ? 'Custom design' : `Generation ${generation}`}</span>
      <span className="mt-1.5 flex gap-2 font-mono text-[0.5625rem] text-muted"><span>{Math.round(powerMw * 1_000)} kW</span><span>{networkGbps >= 1_000 ? `${(networkGbps / 1_000).toFixed(1)}T` : `${Math.round(networkGbps)}G`}</span></span>
    </span>
  </button>
}
function RackCardVisual({ skuId, generation, custom }: { skuId: string; generation: number; custom: boolean }) {
  const hue = [...skuId].reduce((sum, char) => sum + char.charCodeAt(0), custom ? 280 : 165) % 360
  return <span aria-hidden="true" className="relative m-2 mr-0 block h-[4.1rem] w-11 shrink-0 overflow-hidden rounded border border-white/15 bg-[#111a21] shadow-inner" style={{ boxShadow: `inset 0 0 0 1px hsl(${hue} 55% 45% / .18), 0 6px 16px #0008` }}>
    <span className="absolute inset-x-1 top-1 h-1 rounded-sm bg-white/10" />
    {Array.from({ length: Math.min(7, 3 + generation) }, (_, index) => <span key={index} className="absolute left-1 right-1 h-[4px] rounded-[1px] bg-[#283743] ring-1 ring-black/70" style={{ top: `${12 + index * 7}px` }}><span className="absolute right-0.5 top-1/2 size-0.5 -translate-y-1/2 rounded-full" style={{ backgroundColor: `hsl(${hue} 80% 65%)`, boxShadow: `0 0 4px hsl(${hue} 80% 55%)` }} /></span>)}
    <span className="absolute bottom-1 left-1 right-1 h-1 rounded-sm bg-black/60" />
  </span>
}
function EquipmentPaletteCard({ kind, name, price, active, onClick, onDragStart, onDragEnd }: { kind: 'cooling' | 'power' | 'network'; name: string; price: string; active: boolean; onClick: () => void; onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => void; onDragEnd: () => void }) {
  const Icon = kind === 'cooling' ? Snowflake : kind === 'power' ? Cube : HardDrives
  return <button type="button" draggable aria-pressed={active} onClick={onClick} onDragStart={onDragStart} onDragEnd={onDragEnd} className={`min-h-20 rounded-lg border p-2 text-left transition ${active ? 'border-mint bg-mint/10 ring-2 ring-mint/20' : 'border-line/75 bg-void/45 hover:border-mint/40 hover:bg-panel-2/80'}`} title="Click to place or drag onto the hall floor"><Icon size={19} weight="duotone" className={kind === 'power' ? 'text-amber' : kind === 'cooling' ? 'text-cyan-300' : 'text-violet-300'} /><span className="mt-2 block text-[0.6875rem] font-semibold leading-tight text-bone">{name}</span><span className="mt-1 block font-mono text-[0.5625rem] text-muted">{price}</span></button>
}
function InspectorRow({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-3 border-b border-line/60 py-1.5"><span className="text-muted">{label}</span><span className="font-mono text-bone">{value}</span></div> }
function Metric({ label, value, good, warning }: { label: string; value: string; good?: boolean; warning?: boolean }) { return <div className="border border-line bg-void/40 p-2"><span className="block text-[0.625rem] uppercase text-muted">{label}</span><strong className={`mt-1 block font-mono text-sm ${warning ? 'text-amber' : good ? 'text-mint' : 'text-bone'}`}>{value}</strong></div> }
function formatCapacityVram(value: number) { return value >= 1_024 ? `${num(value / 1_024, 1)} TB` : `${num(value, 0)} GB` }
function formatServeRate(value: number) { return value >= 1_000_000 ? `${num(value / 1_000_000, 1)}M tok/s` : value >= 1_000 ? `${num(value / 1_000, 1)}k tok/s` : `${num(value, 0)} tok/s` }
function CapacityImpactRow({ label, current, withPlan, format }: { label: string; current: number; withPlan: number; format: (value: number) => string }) {
  const delta = withPlan - current
  return <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 border-b border-line/50 py-1.5 text-[0.6875rem]"><span className="truncate text-muted">{label}</span><span className="font-mono text-bone">{format(current)}</span><span className="text-right font-mono text-mint"><strong className="block font-medium">{format(withPlan)}</strong><small className="block text-[0.5rem] text-muted">{Math.abs(delta) < 1e-9 ? 'no change' : `${delta > 0 ? '+' : ''}${format(delta)}`}</small></span></div>
}
function HallCapacityPie({ installed, planned, capacity }: { installed: number; planned: number; capacity: number }) {
  const total = Math.max(1, capacity)
  const installedShare = Math.min(100, Math.max(0, installed / total * 100))
  const plannedShare = Math.min(100 - installedShare, Math.max(0, planned / total * 100))
  const used = Math.min(capacity, installed + planned)
  return <div role="img" aria-label={`${installed} installed, ${planned} planned, ${Math.max(0, capacity - used)} free rack positions`} className="relative grid size-[4.75rem] shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(#48d7d1 0 ${installedShare}%, #8b8cf8 ${installedShare}% ${installedShare + plannedShare}%, #263540 ${installedShare + plannedShare}% 100%)` }}><span className="grid size-[3.25rem] place-items-center rounded-full border border-line/70 bg-panel text-center shadow-inner"><span><strong className="block font-mono text-sm leading-none text-bone">{used}</strong><small className="mt-0.5 block font-mono text-[0.5rem] uppercase text-muted">of {capacity}</small></span></span></div>
}
function Validation({ title, items, danger }: { title: string; items: string[]; danger?: boolean }) { return <div className={`mt-4 border p-2 ${danger ? 'border-danger/40 bg-danger/5' : 'border-amber/40 bg-amber/5'}`}><strong className={`text-[0.75rem] ${danger ? 'text-danger' : 'text-amber'}`}>{title}</strong><ul className="mt-1 list-disc space-y-1 pl-4 text-[0.6875rem] text-muted">{items.slice(0, 6).map((item) => <li key={item}>{item}</li>)}</ul></div> }

function DataHallEditorScene({ layout, analysis, selectedId, mode, showGrid, showRoutes, onSelect, onPlace, onMove, onPreview, onPreviewMove }: { layout: DataHallLayout; analysis: ReturnType<typeof analyzeHallLayout>; selectedId: string | null; mode: PaletteMode; showGrid: boolean; showRoutes: boolean; onSelect: (id: string | null) => void; onPlace: (x: number, z: number, keepActive?: boolean, requestedMode?: PaletteMode) => void; onMove: (id: string, x: number, z: number) => void; onPreview: (mode: NonNullable<PaletteMode>, x: number, z: number) => 'valid' | 'warning' | 'invalid'; onPreviewMove: (object: DataHallObjectPlacement, x: number, z: number) => 'valid' | 'warning' | 'invalid' }) {
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
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    const shell = DATA_HALL_SHELLS[layout.shellId]
    const widthM = shell.width * HALL_GRID_METERS
    const depthM = shell.depth * HALL_GRID_METERS
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x070b10)
    scene.add(new THREE.HemisphereLight(0xb8dfff, 0x10141a, 2.2))
    const light = new THREE.DirectionalLight(0xffffff, 2.6); light.position.set(8, 16, 10); light.castShadow = true; light.shadow.mapSize.set(1024, 1024); scene.add(light)
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
      cooling: new THREE.MeshStandardMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      power: new THREE.MeshStandardMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      network: new THREE.MeshStandardMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    }
    const floor = new THREE.Mesh(new THREE.BoxGeometry(widthM, 0.12, depthM), new THREE.MeshStandardMaterial({ color: 0x111820, roughness: 0.92 })); floor.position.y = -0.08; floor.name = 'floor'; floor.receiveShadow = true; scene.add(floor)
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
    for (const [kind, objects] of groups) {
      const geometry = new THREE.BoxGeometry(1, 1, 1)
      const mesh = new THREE.InstancedMesh(geometry, materials[kind as keyof typeof materials], objects.length)
      mesh.userData.objectIds = objects.map((object) => object.id)
      const matrix = new THREE.Matrix4(); const position = new THREE.Vector3(); const quaternion = new THREE.Quaternion(); const scale = new THREE.Vector3()
      objects.forEach((object, index) => { const d = objectDims(object); position.set((object.x + d.width / 2) * HALL_GRID_METERS - widthM / 2, object.kind === 'rack' ? 1.05 : 0.75, (object.z + d.depth / 2) * HALL_GRID_METERS - depthM / 2); scale.set(d.width * HALL_GRID_METERS, object.kind === 'rack' ? 2.1 : 1.5, d.depth * HALL_GRID_METERS); matrix.compose(position, quaternion, scale); mesh.setMatrixAt(index, matrix) })
      mesh.castShadow = kind === 'rack'
      mesh.receiveShadow = kind === 'rack'
      scene.add(mesh); meshes.push(mesh)
      if (kind !== 'rack') {
        objects.forEach((object) => {
          const def = HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === object.catalogId)
          if (!def) return
          const d = objectDims(object)
          const model = createHallEquipmentModel({
            kind: kind as 'cooling' | 'power' | 'network',
            width: def.width * HALL_GRID_METERS,
            depth: def.depth * HALL_GRID_METERS,
            height: 1.5,
            offline: false,
          })
          model.position.set((object.x + d.width / 2) * HALL_GRID_METERS - widthM / 2, 0, (object.z + d.depth / 2) * HALL_GRID_METERS - depthM / 2)
          model.rotation.y = THREE.MathUtils.degToRad(object.rotation)
          scene.add(model)
        })
      }
      if (kind === 'rack') {
        const frontMaterial = new THREE.MeshStandardMaterial({ color: 0x070b0e, metalness: 0.82, roughness: 0.28 })
        const frontPanels = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), frontMaterial, objects.length)
        const slotMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x123a3a, emissiveIntensity: 0.42, metalness: 0.55, roughness: 0.3 })
        const slotCount = 7
        const installedRackCount = objects.filter((object) => !object.reserved).length
        const serverSlots = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), slotMaterial, installedRackCount * slotCount)
        const railMaterial = new THREE.MeshStandardMaterial({ color: 0x32434e, metalness: 0.9, roughness: 0.24 })
        const mountingRails = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), railMaterial, objects.length * 2)
        const statusMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.65, metalness: 0.35, roughness: 0.3 })
        const statusBars = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), statusMaterial, objects.length)
        let slotIndex = 0
        let railIndex = 0
        objects.forEach((object, index) => {
          const d = objectDims(object)
          const cx = (object.x + d.width / 2) * HALL_GRID_METERS - widthM / 2
          const cz = (object.z + d.depth / 2) * HALL_GRID_METERS - depthM / 2
          const frontOnX = object.rotation === 90 || object.rotation === 270
          const direction = object.rotation === 180 || object.rotation === 270 ? -1 : 1
          const faceSpan = (frontOnX ? d.depth : d.width) * HALL_GRID_METERS
          const faceX = cx + (frontOnX ? direction * (d.width * HALL_GRID_METERS / 2 + 0.012) : 0)
          const faceZ = cz + (!frontOnX ? direction * (d.depth * HALL_GRID_METERS / 2 + 0.012) : 0)
          const variant = rackVariantSeed(object.catalogId)
          const accent = object.reserved
            ? new THREE.Color(0x5f7580)
            : new THREE.Color().setHSL(((variant % 42) + 170) / 360, 0.72, 0.62)
          scale.set(frontOnX ? 0.025 : faceSpan * 0.9, 1.82, frontOnX ? faceSpan * 0.9 : 0.025)
          matrix.compose(new THREE.Vector3(faceX, 1.05, faceZ), quaternion, scale)
          frontPanels.setMatrixAt(index, matrix)
          const railOffset = faceSpan * 0.4
          for (const offset of [-railOffset, railOffset]) {
            const railX = faceX + (frontOnX ? direction * 0.02 : offset)
            const railZ = faceZ + (frontOnX ? offset : direction * 0.02)
            scale.set(frontOnX ? 0.035 : 0.045, 1.78, frontOnX ? 0.045 : 0.035)
            matrix.compose(new THREE.Vector3(railX, 1.05, railZ), quaternion, scale)
            mountingRails.setMatrixAt(railIndex++, matrix)
          }
          if (!object.reserved) {
            for (let slot = 0; slot < slotCount; slot += 1) {
              const y = 0.35 + slot * 0.215
              scale.set(frontOnX ? 0.03 : faceSpan * 0.72, 0.075, frontOnX ? faceSpan * 0.72 : 0.03)
              matrix.compose(new THREE.Vector3(faceX + (frontOnX ? direction * 0.018 : 0), y, faceZ + (!frontOnX ? direction * 0.018 : 0)), quaternion, scale)
              serverSlots.setMatrixAt(slotIndex, matrix)
              serverSlots.setColorAt(slotIndex, accent.clone().multiplyScalar(0.58 + (slot % 3) * 0.12))
              slotIndex += 1
            }
          }
          scale.set(frontOnX ? 0.035 : faceSpan * 0.34, 0.035, frontOnX ? faceSpan * 0.34 : 0.035)
          matrix.compose(new THREE.Vector3(faceX + (frontOnX ? direction * 0.02 : 0), 1.9, faceZ + (!frontOnX ? direction * 0.02 : 0)), quaternion, scale)
          statusBars.setMatrixAt(index, matrix)
          statusBars.setColorAt(index, accent)
        })
        frontPanels.instanceMatrix.needsUpdate = true
        serverSlots.instanceMatrix.needsUpdate = true
        if (serverSlots.instanceColor) serverSlots.instanceColor.needsUpdate = true
        mountingRails.instanceMatrix.needsUpdate = true
        statusBars.instanceMatrix.needsUpdate = true
        if (statusBars.instanceColor) statusBars.instanceColor.needsUpdate = true
        frontPanels.castShadow = true
        serverSlots.castShadow = true
        scene.add(frontPanels, serverSlots, mountingRails, statusBars)
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
    const hitPoint = (event: { clientX: number; clientY: number }) => { const rect = canvas.getBoundingClientRect(); pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1); raycaster.setFromCamera(pointer, camera); return raycaster.intersectObject(floor)[0]?.point }
    const objectHit = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1); raycaster.setFromCamera(pointer, camera); const hit = raycaster.intersectObjects(meshes, false)[0]; const ids = hit?.object.userData.objectIds as string[] | undefined; return hit?.instanceId != null ? ids?.[hit.instanceId] ?? null : null }
    const pointToCell = (point: THREE.Vector3) => ({ x: Math.max(0, Math.min(shell.width - 1, Math.floor((point.x + widthM / 2) / HALL_GRID_METERS))), z: Math.max(0, Math.min(shell.depth - 1, Math.floor((point.z + depthM / 2) / HALL_GRID_METERS))) })
    const preview = (event: { clientX: number; clientY: number }) => {
      const point = hitPoint(event)
      if (!point) { ghost.visible = false; return }
      const cell = pointToCell(point)
      const draggingObject = dragging ? layout.objects.find((entry) => entry.id === dragging) : undefined
      const activeMode = modeRef.current
      if (!draggingObject && !activeMode) { ghost.visible = false; return }
      const reservedAtCell = activeMode?.kind === 'rack'
        ? reservedRackAtCell(layout, cell.x, cell.z)
        : undefined
      const previewObject = draggingObject ?? (activeMode?.kind === 'rack'
        ? { id: '__ghost', kind: 'rack' as const, catalogId: activeMode.skuId, x: reservedAtCell?.x ?? cell.x, z: reservedAtCell?.z ?? cell.z, rotation: reservedAtCell?.rotation ?? 0 as const, purchasePrice: 0 }
        : activeMode?.kind === 'equipment'
          ? (() => { const def = HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === activeMode.catalogId)!; return { id: '__ghost', kind: def.kind, catalogId: def.id, x: cell.x, z: cell.z, rotation: 0 as const, purchasePrice: def.price } })()
          : undefined)
      if (!previewObject) { ghost.visible = false; return }
      const d = objectDims(previewObject)
      ghost.scale.set(d.width * HALL_GRID_METERS, previewObject.kind === 'rack' ? 2.1 : 1.5, d.depth * HALL_GRID_METERS)
      ghost.position.set((previewObject.x + d.width / 2) * HALL_GRID_METERS - widthM / 2, previewObject.kind === 'rack' ? 1.05 : 0.75, (previewObject.z + d.depth / 2) * HALL_GRID_METERS - depthM / 2)
      const status = draggingObject
        ? handlersRef.current.onPreviewMove(draggingObject, cell.x, cell.z)
        : activeMode
          ? handlersRef.current.onPreview(activeMode, cell.x, cell.z)
          : 'valid'
      ghostMaterial.color.setHex(status === 'invalid' ? 0xff5252 : status === 'warning' ? 0xf0ad4e : 0x48d7d1)
      ghost.visible = true
      render()
    }
    const down = (event: PointerEvent) => { const id = objectHit(event); if (id) { dragging = id; handlersRef.current.onSelect(id); controls.enabled = false; preview(event) } else handlersRef.current.onSelect(null) }
    const up = (event: PointerEvent) => { const point = hitPoint(event); if (point) { const cell = pointToCell(point); if (dragging) handlersRef.current.onMove(dragging, cell.x, cell.z); else if (modeRef.current) handlersRef.current.onPlace(cell.x, cell.z, event.shiftKey) } dragging = null; controls.enabled = true; ghost.visible = false; render() }
    const cancelPointer = () => { dragging = null; controls.enabled = true; ghost.visible = false; render() }
    const dragOver = (event: DragEvent) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes(HALL_PALETTE_DATA_MIME)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      preview(event)
    }
    const dragLeave = (event: DragEvent) => {
      const related = event.relatedTarget
      if (related instanceof Node && canvas.contains(related)) return
      ghost.visible = false
      render()
    }
    const drop = (event: DragEvent) => {
      const raw = event.dataTransfer?.getData(HALL_PALETTE_DATA_MIME) ?? ''
      const payload = parseHallPalettePayload(raw)
      if (!payload) return
      event.preventDefault()
      const requestedMode: PaletteMode = payload.kind === 'rack-sku'
        ? { kind: 'rack', skuId: payload.skuId }
        : HALL_EQUIPMENT_CATALOG.some((entry) => entry.id === payload.catalogId)
          ? { kind: 'equipment', catalogId: payload.catalogId }
          : null
      const point = hitPoint(event)
      if (requestedMode && point) {
        const cell = pointToCell(point)
        handlersRef.current.onPlace(cell.x, cell.z, event.shiftKey, requestedMode)
      }
      ghost.visible = false
      render()
    }
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', preview); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', cancelPointer)
    canvas.addEventListener('dragover', dragOver); canvas.addEventListener('dragleave', dragLeave); canvas.addEventListener('drop', drop)
    const render = () => renderer.render(scene, camera); renderRef.current = render; controls.addEventListener('change', render)
    const resize = () => { const width = Math.max(1, canvas.clientWidth); const height = Math.max(1, canvas.clientHeight); const nextAspect = width / height; camera.left = -view * nextAspect; camera.right = view * nextAspect; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); render() }
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize()
    return () => { viewStateRef.current = { position: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom }; observer.disconnect(); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', preview); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', cancelPointer); canvas.removeEventListener('dragover', dragOver); canvas.removeEventListener('dragleave', dragLeave); canvas.removeEventListener('drop', drop); controls.removeEventListener('change', render); controls.dispose(); scene.traverse((object) => { if (object instanceof THREE.Mesh || object instanceof THREE.Line) { object.geometry.dispose(); if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose()); else object.material.dispose() } }); selectorRef.current = null; renderRef.current = () => undefined; renderer.renderLists.dispose(); renderer.dispose() }
  }, [analysis, layout, showGrid, showRoutes])
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
  }, [layout, selectedId, showGrid, showRoutes])
  return <canvas ref={canvasRef} className="h-full w-full touch-none" aria-label="Interactive data hall floor" />
}

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { canPlaceBuilding, dcFootprint } from '../../sim/systems/map'
import { selectionFootprintTiles } from '../../sim/systems/worldAccess'
import { transportAccessFactorAt, transportRegionalCongestionAt } from '../../sim/systems/transport'
import type { BuildableKind, MapOverlayMode, MapRegion, SimState } from '../../sim/types'
import { useGameStore } from '../../store/gameStore'
import { resolveRenderSettings, useUiStore } from '../../store/uiStore'
import {
  hasBuildBlueprintDrag,
  placementCostAt,
  placementTooltipPosition,
  readBuildBlueprintDrag,
} from '../buildPlacement'
import { money } from '../hud/format'
import {
  applyWorldAssetSnapshot,
  WorldAssetCache,
  type WorldAssetSnapshot,
} from './assets/worldAssetCache'
import { regionOverlayFill } from '../hud/mapNavigatorData'
import { currentInteraction, createMapPerfSession, type MapPerfSession } from './integration/perfSession'
import { createArtDirectedArchetypeRegistry } from './integration/artDirectedRegistry'
import { enforceCloseUpNearOnly } from './integration/lodPolicy'
import {
  MAP_TILE_SIZE,
  SimViewportRenderSource,
} from './integration/simRenderSource'
import {
  ArchetypeRegistry,
  LodTier,
  ViewportMapRenderer,
  type TileBounds,
  type ViewportUpdateResult,
} from './v2'
import {
  BALANCED_LOGICAL_VEHICLES,
  BALANCED_VISIBLE_VEHICLES,
  QUALITY_LOGICAL_VEHICLES,
  QUALITY_VISIBLE_VEHICLES,
} from './v2/visualTraffic'
import {
  cameraRelativePanVector,
  createMapCameraRotation,
  grabbedWorldPanDelta,
  hasPointerDragged,
  mapCameraPose,
  mapCameraDistanceScale,
  mapViewportPlaneBounds,
  mapViewportPlaneFootprint,
  retargetMapCameraRotation,
  rotateMapWorldOffset,
  sampleMapCameraRotation,
  sanitizeMapTargetComponent,
  type MapCameraHeading,
  type MapCameraTilt,
} from './mapControls'
import {
  primaryRivalMapSites,
  rivalMapSites,
  rivalSiteIsConstructing,
  rivalSiteKindLabel,
  rivalSiteProgress,
  type RivalMapSite,
} from './rivalMapSites'

const PREVIEW_OK = 0x3dffc0
const PREVIEW_BAD = 0xff4d6a
const SKY = 0xb8d4e8
const HAZE = 0xc5dceb
const ACTIVE_FRAME_MS = 1000 / 60
const IDLE_FRAME_MS = 1000 / 30
const INTERACTION_TAIL_MS = 250
const MAX_WHEEL_DELTA_PX = 120
const VIEWPORT_BASE_MARGIN_TILES = 3
const DEFAULT_FRUSTUM = 11
const MIN_FRUSTUM = 5
const MAX_FRUSTUM = 30
// Detailed city kits can rise several tile widths above their owning tile.
// Expand the ground-plane bounds by their projected camera offset so a tower
// cannot disappear while its roof is still on screen.
// The tallest restored kit is the 2.6-unit large DC; level scaling remains
// below four world units. Keep one conservative unit of headroom without
// loading an unnecessary half-chunk around every close-up viewport.
const MAX_PROP_HEIGHT_WORLD = 4
// Uint8 terrain elevations top out near ten world units. Cover the complete
// relief range around the camera target so quarter-turn chunk selection never
// depends on terrain meshes retained from the previous heading.
const VIEWPORT_HEIGHT_ENVELOPE_WORLD = 12

function activePixelRatio(): number {
  const preset = useUiStore.getState().renderPreset
  const settings = resolveRenderSettings(preset)
  const device = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  return Math.max(0.5, Math.min(settings.pixelRatio, device * (settings.pixelRatio >= 1.5 ? 1.5 : 1)))
}


type SelectedTile = { x: number; y: number } | null

interface DragState {
  active: boolean
  onMap: boolean
  x: number
  y: number
  anchorX: number
  anchorZ: number
  moved: boolean
}

interface PreviewState {
  group: THREE.Group
  meshes: THREE.Mesh[]
  cellGeometry: THREE.BoxGeometry
  okMaterial: THREE.MeshBasicMaterial
  badMaterial: THREE.MeshBasicMaterial
  volume: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>
  hoverKey: string | null
}

interface LiveMapProjection {
  source: SimViewportRenderSource
  viewport: ViewportMapRenderer
  registry: ArchetypeRegistry
  regions: readonly MapRegion[]
}

export function GameMap() {
  const mountRef = useRef<HTMLDivElement>(null)
  const placementTooltipRef = useRef<HTMLDivElement>(null)
  const placementLandRef = useRef<HTMLSpanElement>(null)
  const placementGradeRef = useRef<HTMLSpanElement>(null)
  const placementTotalRef = useRef<HTMLSpanElement>(null)
  // This primitive subscription exists only for the cursor class. All map and
  // simulation updates are consumed imperatively inside the Three lifecycle.
  const buildMode = useGameStore((store) => store.buildMode)
  const mapTool = useGameStore((store) => store.mapTool)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const initialStore = useGameStore.getState()
    const initialWidth = Math.max(1, mount.clientWidth)
    const initialHeight = Math.max(1, mount.clientHeight)
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    })
    renderer.domElement.className = 'game-map-canvas'
    renderer.domElement.style.touchAction = 'none'
    renderer.setPixelRatio(activePixelRatio())
    renderer.setSize(initialWidth, initialHeight, false)
    renderer.setClearColor(SKY, 1)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.08
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(SKY)
    scene.fog = new THREE.Fog(HAZE, 40, 150)

    let renderedWidth = initialWidth
    let renderedHeight = initialHeight
    let aspect = renderedWidth / Math.max(1, renderedHeight)
    let frustum = DEFAULT_FRUSTUM
    const initialUi = useUiStore.getState()
    let cameraHeading: MapCameraHeading = initialUi.mapCameraHeading
    let visualCameraHeading: number = cameraHeading
    let cameraRotation = createMapCameraRotation(cameraHeading)
    let cameraTilt: MapCameraTilt = initialUi.mapCameraTilt
    const camera = new THREE.OrthographicCamera(
      -frustum * aspect,
      frustum * aspect,
      frustum,
      -frustum,
      0.1,
      320,
    )
    const target = new THREE.Vector3()
    const keys = new Set<string>()
    const drag: DragState = {
      active: false,
      onMap: false,
      x: 0,
      y: 0,
      anchorX: 0,
      anchorZ: 0,
      moved: false,
    }

    const ambient = new THREE.AmbientLight(0xfff6e8, 0.82)
    const sun = new THREE.DirectionalLight(0xfff2d6, 1.2)
    sun.position.set(18, 28, 12)
    const fill = new THREE.DirectionalLight(0xa8c8e8, 0.38)
    fill.position.set(-14, 12, -10)
    const hemi = new THREE.HemisphereLight(0xdce9f5, 0x5a7a48, 0.48)
    scene.add(ambient, sun, sun.target, fill, fill.target, hemi)

    const labels = new THREE.Group()
    labels.name = 'map-region-labels'
    scene.add(labels)
    const regionOverlays = new THREE.Group()
    regionOverlays.name = 'map-region-overlays'
    scene.add(regionOverlays)
    const rivalLabels = new THREE.Group()
    rivalLabels.name = 'rival-facility-labels'
    scene.add(rivalLabels)

    const selectionGeometry = new THREE.BoxGeometry(
      MAP_TILE_SIZE * 1.04,
      0.07,
      MAP_TILE_SIZE * 1.04,
    )
    const selectionMaterial = new THREE.MeshBasicMaterial({
      color: PREVIEW_OK,
      transparent: true,
      opacity: 0.52,
      depthWrite: false,
    })
    const selectionMarker = new THREE.Group()
    selectionMarker.name = 'selected-building-footprint-marker'
    selectionMarker.visible = false
    const selectionCells: THREE.Mesh[] = []
    scene.add(selectionMarker)

    const preview = createBuildPreview()
    scene.add(preview.group)

    const pickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const pickHit = new THREE.Vector3()
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const projectA = new THREE.Vector3()
    const projectB = new THREE.Vector3()
    const cameraForward = new THREE.Vector3()
    const assetCache = new WorldAssetCache()
    let assetSnapshot: WorldAssetSnapshot = assetCache.snapshot()

    let projection = createProjection(
      initialStore.state,
      initialStore.selectedTile,
      initialStore.buildMode,
    )
    let perfSession: MapPerfSession | null = createMapPerfSession(
      projection.source.width,
      projection.source.height,
    )
    let viewportDirty = true
    let lastViewportUpdate: ViewportUpdateResult | null = null
    let lastJournalBacklog = 0
    let frameChunkWorkMs = 0
    let lastInteractionAt = performance.now()
    let lastFrameAt = performance.now()
    let lastRenderAt = 0
    let previousUploadBytes = 0
    let previousTrafficSteps = 0
    let previousTrafficReconciles = 0
    let previousTrafficRebuilds = 0
    let previousTrafficUploadBytes = 0
    let replayFrame = perfSession?.nextFrame()
    let warmupPending = true
    let rivalLabelSignature = ''
    let animationFrame = 0
    let resizeFrame = 0
    let disposed = false
    let renderFaultCount = 0
    let contextLost = false

    function createProjection(
      state: SimState,
      selectedTile: SelectedTile,
      nextBuildMode: BuildableKind | null,
    ): LiveMapProjection {
      const source = new SimViewportRenderSource(state, selectedTile, nextBuildMode)
      const registry = createArtDirectedArchetypeRegistry()
      applyWorldAssetSnapshot(registry, assetSnapshot)
      const trafficPreset = useUiStore.getState().renderPreset
      const trafficLimits = trafficPreset === 'performance'
        ? { logical: 0, visible: 0 }
        : trafficPreset === 'quality'
          ? { logical: QUALITY_LOGICAL_VEHICLES, visible: QUALITY_VISIBLE_VEHICLES }
          : { logical: BALANCED_LOGICAL_VEHICLES, visible: BALANCED_VISIBLE_VEHICLES }
      const viewport = new ViewportMapRenderer({
        renderer,
        scene,
        source,
        registry,
        chunkSize: source.chunkSize,
        // The normal game opens in the close-up band. Starting with the full
        // tier avoids a synthetic mid→near transition on the first frame.
        initialLod: LodTier.near,
        trafficLimits,
      })
      viewport.setCloudsVisible(useUiStore.getState().cloudsVisible)
      return { source, viewport, registry, regions: state.map.regions }
    }

    function applyCamera(): void {
      // An orthographic camera's distance does not affect map scale. Move it
      // back as the frustum grows so the bottom-most parallel rays still start
      // above the ground plane. Without this, maximum zoom-out exposes a
      // horizontal band of the sky clear color above the operations HUD.
      const distanceScale = mapCameraDistanceScale(frustum, DEFAULT_FRUSTUM)
      const pose = mapCameraPose(visualCameraHeading, cameraTilt)
      camera.position.set(
        target.x + pose.offsetX * distanceScale,
        target.y + pose.offsetY * distanceScale,
        target.z + pose.offsetZ * distanceScale,
      )
      camera.lookAt(target)
      // Viewport bounds are raycast before the next renderer.render() call.
      // Keep matrixWorld synchronous with keyboard rotation so culling cannot
      // select chunks using the previous heading and leave the new view blank.
      camera.updateMatrixWorld(true)
      const sunOffset = rotateMapWorldOffset(visualCameraHeading, 18, 12)
      const fillOffset = rotateMapWorldOffset(visualCameraHeading, -14, -10)
      sun.position.set(target.x + sunOffset.x, target.y + 28, target.z + sunOffset.z)
      sun.target.position.copy(target)
      sun.target.updateMatrixWorld()
      fill.position.set(target.x + fillOffset.x, target.y + 12, target.z + fillOffset.z)
      fill.target.position.copy(target)
      fill.target.updateMatrixWorld()
    }

    function updateProjectionMatrix(): void {
      if (!Number.isFinite(frustum) || frustum <= 0) frustum = DEFAULT_FRUSTUM
      if (!Number.isFinite(renderedWidth) || renderedWidth < 1) renderedWidth = 1
      if (!Number.isFinite(renderedHeight) || renderedHeight < 1) renderedHeight = 1
      aspect = renderedWidth / Math.max(1, renderedHeight)
      camera.left = -frustum * aspect
      camera.right = frustum * aspect
      camera.top = frustum
      camera.bottom = -frustum
      camera.updateProjectionMatrix()
      const visibleRadius = Math.max(frustum * 1.8, 14)
      scene.fog = new THREE.Fog(HAZE, visibleRadius * 2.2, visibleRadius * 5.5)
    }

    function centerCamera(state: SimState): void {
      const firstCity = state.map.cities?.[0]
      const x = firstCity?.cx ?? state.map.width / 2
      const y = firstCity?.cy ?? state.map.height / 2
      target.set(
        x * MAP_TILE_SIZE,
        projection.source.getTileElevation(x, y),
        y * MAP_TILE_SIZE,
      )
      clampTarget()
      applyCamera()
      viewportDirty = true
    }

    function clampTarget(): void {
      // A non-finite component poisons the camera matrix and every projected
      // ray, leaving a permanently white scene until reload. Recover to the
      // last finite origin instead of propagating it.
      target.x = sanitizeMapTargetComponent(target.x)
      target.y = sanitizeMapTargetComponent(target.y)
      target.z = sanitizeMapTargetComponent(target.z)
      target.x = THREE.MathUtils.clamp(
        target.x,
        0,
        Math.max(0, (projection.source.width - 1) * MAP_TILE_SIZE),
      )
      target.z = THREE.MathUtils.clamp(
        target.z,
        0,
        Math.max(0, (projection.source.height - 1) * MAP_TILE_SIZE),
      )
    }

    function replaceProjection(state: SimState, selected: SelectedTile, nextBuildMode: BuildableKind | null) {
      projection.viewport.dispose()
      projection.registry.dispose()
      perfSession?.dispose()
      projection = createProjection(state, selected, nextBuildMode)
      perfSession = createMapPerfSession(projection.source.width, projection.source.height)
      replayFrame = perfSession?.nextFrame()
      previousUploadBytes = 0
      previousTrafficSteps = 0
      previousTrafficReconciles = 0
      previousTrafficRebuilds = 0
      previousTrafficUploadBytes = 0
      lastViewportUpdate = null
      lastJournalBacklog = 0
      warmupPending = true
      rebuildRegionLabels(labels, projection.regions, projection.source)
      rebuildRegionOverlays(regionOverlays, projection.regions, useGameStore.getState().mapOverlay, projection.source)
      centerCamera(state)
      moveSelectionMarker(selected)
      viewportDirty = true
      reconcileViewport(performance.now())
    }

    function markInteraction(): void {
      lastInteractionAt = performance.now()
    }

    function syncRivalLabels(state: SimState): void {
      const sites = primaryRivalMapSites(rivalMapSites(state))
      const signature = sites
        .map((site) => `${site.id}:${site.progress}:${site.target}:${site.racksUsed}`)
        .join('|')
      if (signature === rivalLabelSignature) return
      rivalLabelSignature = signature
      rebuildRivalFacilityLabels(rivalLabels, sites)
      elevateWorldLabels(rivalLabels, projection.source, 2.7)
    }

    function intersectTerrain(activeRaycaster: THREE.Raycaster, out: THREE.Vector3): THREE.Vector3 | null {
      const meshHit = projection.viewport.raycastTerrain(activeRaycaster)
      if (meshHit) return out.copy(meshHit.point)
      // During the first chunk prewarm (or just outside the resident guard
      // ring), converge against the deterministic height sampler rather than
      // falling back to a permanently flat picking plane.
      let height = target.y
      for (let iteration = 0; iteration < 4; iteration++) {
        pickPlane.constant = -height
        const hit = activeRaycaster.ray.intersectPlane(pickPlane, out)
        if (!hit) return null
        height = projection.viewport.sampleTerrainHeight(out.x, out.z)
      }
      out.y = height
      return out
    }

    function pickGroundAt(clientX: number, clientY: number): THREE.Vector3 | null {
      const rect = renderer.domElement.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return null
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      return intersectTerrain(raycaster, pickHit)
    }

    function pickTileAt(clientX: number, clientY: number): SelectedTile {
      const hit = pickGroundAt(clientX, clientY)
      if (!hit) return null
      const objectHit = projection.viewport.raycastSelectable(raycaster)
      if (objectHit) {
        return {
          x: objectHit.tileId % projection.source.width,
          y: Math.floor(objectHit.tileId / projection.source.width),
        }
      }
      const x = Math.round(hit.x / MAP_TILE_SIZE)
      const y = Math.round(hit.z / MAP_TILE_SIZE)
      if (x < 0 || y < 0 || x >= projection.source.width || y >= projection.source.height) {
        return null
      }
      return { x, y }
    }

    function moveSelectionMarker(selected: SelectedTile): void {
      if (!selected || !projection.source.isSelectable(selected.x, selected.y)) {
        selectionMarker.visible = false
        return
      }
      const footprint = projection.source.getSelectionFootprint?.(selected.x, selected.y)
        ?? selectionFootprintTiles(useGameStore.getState().state, selected.x, selected.y)
      while (selectionCells.length < footprint.length) {
        const cell = new THREE.Mesh(selectionGeometry, selectionMaterial)
        cell.name = `selected-footprint-cell-${selectionCells.length}`
        cell.renderOrder = 10
        selectionCells.push(cell)
        selectionMarker.add(cell)
      }
      for (let index = 0; index < selectionCells.length; index++) {
        const cell = selectionCells[index]!
        const tile = footprint[index]
        cell.visible = tile !== undefined
        if (!tile) continue
        cell.position.set(
          tile.x * MAP_TILE_SIZE,
          projection.source.getTileElevation(tile.x, tile.y) + 0.05,
          tile.y * MAP_TILE_SIZE,
        )
      }
      selectionMarker.visible = true
    }

    function clearBuildPreview(): void {
      preview.group.visible = false
      preview.volume.visible = false
      preview.hoverKey = null
      for (const mesh of preview.meshes) mesh.visible = false
      if (placementTooltipRef.current) placementTooltipRef.current.hidden = true
    }

    function updateBuildPreview(
      clientX: number,
      clientY: number,
      dragKind?: BuildableKind,
    ): void {
      const store = useGameStore.getState()
      const kind = dragKind ?? store.buildMode
      if (!kind) {
        clearBuildPreview()
        return
      }
      const tile = pickTileAt(clientX, clientY)
      if (!tile) {
        clearBuildPreview()
        return
      }
      const hoverKey = `${tile.x},${tile.y},${kind},${store.state.map.worldRevision ?? store.state.day}`
      const check = canPlaceBuilding(store.state, tile.x, tile.y, kind)
      const footprint = dcFootprint(kind)
      const count = Math.max(footprint.length, check.cells.length)
      ensurePreviewMeshes(preview, count)
      for (let index = 0; index < count; index++) {
        const offset = footprint[index] ?? { dx: 0, dy: 0 }
        const cell = check.cells[index] ?? {
          x: tile.x + offset.dx,
          y: tile.y + offset.dy,
          ok: false,
        }
        const mesh = preview.meshes[index]!
        mesh.visible = true
        mesh.position.set(
          cell.x * MAP_TILE_SIZE,
          projection.source.getTileElevation(cell.x, cell.y) + 0.08,
          cell.y * MAP_TILE_SIZE,
        )
        mesh.material = check.ok ? preview.okMaterial : preview.badMaterial
      }
      preview.volume.visible = true
      const finishedElevation = check.cells.reduce(
        (height, cell) => Math.max(height, projection.source.getTileElevation(cell.x, cell.y)),
        projection.source.getTileElevation(tile.x, tile.y),
      )
      preview.volume.position.set(tile.x * MAP_TILE_SIZE, finishedElevation + 0.35, tile.y * MAP_TILE_SIZE)
      const color = check.ok ? PREVIEW_OK : PREVIEW_BAD
      preview.volume.material.color.setHex(color)
      const heightScale = kind === 'dc_l' ? 1.35 : kind === 'dc_m' ? 1.1 : kind === 'dc' ? 0.85 : 1
      const widthScale = kind === 'dc_l' ? 1.15 : kind === 'dc_m' ? 1.05 : 0.9
      preview.volume.scale.set(widthScale, heightScale, widthScale)
      preview.group.visible = true
      preview.hoverKey = hoverKey

      const cost = placementCostAt(store.state, tile.x, tile.y, kind)
      const tooltip = placementTooltipRef.current
      if (cost && tooltip && placementLandRef.current && placementGradeRef.current && placementTotalRef.current) {
        const bounds = renderer.domElement.getBoundingClientRect()
        const position = placementTooltipPosition(clientX, clientY, bounds)
        placementLandRef.current.textContent = `Land ${money(cost.landCash)}`
        placementGradeRef.current.textContent = cost.gradingCash > 0
          ? `Grading ${money(cost.gradingCash)} · ${Math.round(check.maxGrade * 100)}% slope`
          : `Level site · ${Math.round(check.maxGrade * 100)}% slope`
        const tileId = tile.y * store.state.map.width + tile.x
        const access = transportAccessFactorAt(store.state, tileId)
        const congestion = transportRegionalCongestionAt(store.state, tileId)
        placementTotalRef.current.textContent = `${money(cost.totalCash)} total · ${
          check.ok ? 'ready' : 'blocked'
        } · access ${Math.round(access * 100)}% · traffic ${Math.round(congestion * 100)}%`
        tooltip.dataset.placeable = check.ok ? 'true' : 'false'
        tooltip.style.left = `${position.left}px`
        tooltip.style.top = `${position.top}px`
        tooltip.hidden = false
      }
    }

    function viewportBounds(): TileBounds {
      return mapViewportPlaneBounds(
        camera,
        target.y,
        MAP_TILE_SIZE,
        projectedPropMarginTiles(),
        VIEWPORT_HEIGHT_ENVELOPE_WORLD,
      )
    }

    function projectedPropMarginTiles(): number {
      camera.getWorldDirection(cameraForward)
      const horizontal = Math.hypot(cameraForward.x, cameraForward.z)
      const vertical = Math.max(0.05, Math.abs(cameraForward.y))
      const projectedTiles = Math.ceil(
        (MAX_PROP_HEIGHT_WORLD * horizontal) / vertical / MAP_TILE_SIZE,
      )
      return VIEWPORT_BASE_MARGIN_TILES + projectedTiles
    }

    function pixelsPerTile(): number {
      projectA.set(target.x, 0, target.z).project(camera)
      projectB.set(target.x + MAP_TILE_SIZE, 0, target.z).project(camera)
      return Math.hypot(
        (projectB.x - projectA.x) * renderedWidth * 0.5,
        (projectB.y - projectA.y) * renderedHeight * 0.5,
      )
    }

    function reconcileViewport(now: number): void {
      const pixels = pixelsPerTile()
      const bounds = viewportBounds()
      const corners = mapViewportPlaneFootprint(camera, target.y, MAP_TILE_SIZE)
      projection.source.consumeChunkPreparationMs()
      lastViewportUpdate = enforceCloseUpNearOnly(
        projection.registry,
        projection.viewport.updateViewport(bounds, pixels, now),
        pixels,
      )
      frameChunkWorkMs =
        projection.viewport.metrics.snapshot().chunkBuildMs +
        projection.source.consumeChunkPreparationMs()
      viewportDirty = lastViewportUpdate.lod.transitioning || lastViewportUpdate.prewarming
      // Publish camera rectangle for the world navigator minimap.
      const store = useGameStore.getState()
      const next = {
        x: bounds.minX,
        y: bounds.minY,
        w: Math.max(1, bounds.maxX - bounds.minX),
        h: Math.max(1, bounds.maxY - bounds.minY),
        corners,
      }
      const prev = store.mapViewport
      const footprintChanged = !prev?.corners || prev.corners.some((point, index) => {
        const candidate = corners[index]!
        return Math.abs(point.x - candidate.x) > 0.01 || Math.abs(point.y - candidate.y) > 0.01
      })
      if (
        !prev ||
        Math.abs(prev.x - next.x) > 0.25 ||
        Math.abs(prev.y - next.y) > 0.25 ||
        Math.abs(prev.w - next.w) > 0.25 ||
        Math.abs(prev.h - next.h) > 0.25 ||
        footprintChanged
      ) {
        store.setMapViewport(next)
      }
    }

    function applyReplayFrame(): void {
      if (!replayFrame) return
      target.set(
        replayFrame.pose.targetX * MAP_TILE_SIZE,
        projection.source.getTileElevation(replayFrame.pose.targetX, replayFrame.pose.targetY),
        replayFrame.pose.targetY * MAP_TILE_SIZE,
      )
      frustum = THREE.MathUtils.clamp(
        MIN_FRUSTUM / Math.max(0.16, replayFrame.pose.zoom),
        MIN_FRUSTUM,
        MAX_FRUSTUM,
      )
      clampTarget()
      updateProjectionMatrix()
      applyCamera()
      viewportDirty = true
    }

    function moveFromKeys(dtSeconds: number): boolean {
      const speed = 10 * (keys.has('shift') ? 2.2 : 1)
      let forward = 0
      let right = 0
      if (keys.has('w') || keys.has('arrowup')) {
        forward += 1
      }
      if (keys.has('s') || keys.has('arrowdown')) {
        forward -= 1
      }
      if (keys.has('a') || keys.has('arrowleft')) {
        right -= 1
      }
      if (keys.has('d') || keys.has('arrowright')) {
        right += 1
      }
      if (forward === 0 && right === 0) return false
      const movement = cameraRelativePanVector(visualCameraHeading, forward, right)
      target.x += movement.x * speed * dtSeconds
      target.z += movement.z * speed * dtSeconds
      clampTarget()
      applyCamera()
      viewportDirty = true
      return true
    }

    function recordPerfFrame(
      now: number,
      frameMs: number,
      cpuMs: number,
      interactive: boolean,
    ): void {
      if (!perfSession || !lastViewportUpdate) return
      const metrics = projection.viewport.metrics.snapshot()
      const uploadBytes = Math.max(0, metrics.surfaceUploadBytes - previousUploadBytes)
      previousUploadBytes = metrics.surfaceUploadBytes
      const trafficSteps = Math.max(0, metrics.trafficSteps - previousTrafficSteps)
      const trafficReconciles = Math.max(0, metrics.trafficReconciles - previousTrafficReconciles)
      const trafficRebuilds = Math.max(0, metrics.trafficRebuilds - previousTrafficRebuilds)
      const trafficUploadBytes = Math.max(0, metrics.trafficUploadBytes - previousTrafficUploadBytes)
      previousTrafficSteps = metrics.trafficSteps
      previousTrafficReconciles = metrics.trafficReconciles
      previousTrafficRebuilds = metrics.trafficRebuilds
      previousTrafficUploadBytes = metrics.trafficUploadBytes
      const closeUpPlaceholder =
        pixelsPerTile() >= 28 &&
        lastViewportUpdate.lod.layers.some(
          // Near and mid deliberately share the exact restored geometry, so a
          // mid→near crossfade is not a visible placeholder. Only simplified
          // far silhouettes would be a close-up fidelity failure.
          (layer) => layer.tier === LodTier.far && layer.coverage > 0,
        )
          ? 1
          : 0
      const effectiveLod =
        lastViewportUpdate.lod.layers.length === 1
          ? lastViewportUpdate.lod.layers[0]!.tier
          : metrics.lodActive
      perfSession.record({
        timestampMs: now,
        frameMs,
        cpuMs,
        interaction: currentInteraction(replayFrame, interactive),
        lod: effectiveLod,
        drawCalls: metrics.rendererDrawCalls,
        triangles: metrics.rendererTriangles,
        visibleChunks: metrics.visibleChunks,
        residentCpuChunks: metrics.residentChunks,
        gpuChunkLayers: metrics.gpuChunkLayers,
        activeInstances: metrics.instances,
        uploadBytes,
        trafficSteps,
        trafficReconciles,
        trafficRebuilds,
        trafficUploadBytes,
        municipalEffectInstances: metrics.municipalEffectInstances,
        chunkWorkMs: frameChunkWorkMs,
        journalBacklog: lastJournalBacklog,
        // Missing tier geometry and pending visible chunks are both continuity
        // failures; expose them instead of hard-coding a passing metric.
        missingTiles: metrics.missingInstances + metrics.pendingChunks,
        capacityRejects: 0,
        closeUpPlaceholders: closeUpPlaceholder,
      })
      lastJournalBacklog = 0
    }

    function animate(now: number): void {
      animationFrame = 0
      if (disposed || document.hidden) return
      scheduleAnimation()
      const rotationSample = sampleMapCameraRotation(cameraRotation, now)
      const interactive =
        !!perfSession ||
        drag.active ||
        keys.size > 0 ||
        !rotationSample.complete ||
        viewportDirty ||
        now - lastInteractionAt < INTERACTION_TAIL_MS
      const interval = interactive ? ACTIVE_FRAME_MS : IDLE_FRAME_MS
      if (lastRenderAt > 0 && now - lastRenderAt < interval - 0.75) return

      if (contextLost) return

      const frameStarted = performance.now()
      frameChunkWorkMs = 0
      const frameMs = Math.min(250, now - lastFrameAt)
      const dt = Math.min(0.05, frameMs / 1000)
      lastFrameAt = now
      lastRenderAt = now

      applyReplayFrame()
      if (Math.abs(rotationSample.heading - visualCameraHeading) > 1e-6) {
        visualCameraHeading = rotationSample.heading
        applyCamera()
        viewportDirty = true
      }
      if (moveFromKeys(dt)) markInteraction()
      if (viewportDirty) reconcileViewport(now)
      try {
        projection.viewport.render(camera, now * 0.001)
      } catch (error) {
        // A renderer fault must not freeze the loop: the next frame re-renders
        // from the same immutable state instead of leaving a stale white canvas.
        renderFaultCount += 1
        if (renderFaultCount <= 3) {
          console.error('[GameMap] render frame failed; recovering next frame', error)
        }
        viewportDirty = true
      }
      if (warmupPending) {
        // Three r185's async compiler expects each collected material to have a
        // current program. One real render establishes that invariant first.
        warmupPending = false
        void projection.viewport.warmup(camera).catch(() => undefined)
      }
      recordPerfFrame(now, frameMs, performance.now() - frameStarted, interactive)
      if (perfSession) replayFrame = perfSession.nextFrame()
    }

    function scheduleAnimation(): void {
      if (animationFrame || disposed || document.hidden) return
      animationFrame = requestAnimationFrame(animate)
    }

    function onPointerDown(event: PointerEvent): void {
      if (event.button !== 0) return
      const hit = pickGroundAt(event.clientX, event.clientY)
      if (!hit) return
      event.preventDefault()
      mountRef.current?.focus({ preventScroll: true })
      drag.active = true
      drag.onMap = true
      drag.x = event.clientX
      drag.y = event.clientY
      drag.anchorX = hit.x
      drag.anchorZ = hit.z
      drag.moved = false
      renderer.setPixelRatio(activePixelRatio())
      markInteraction()
    }

    function onPointerMove(event: PointerEvent): void {
      if (drag.active && drag.onMap) {
        const hit = pickGroundAt(event.clientX, event.clientY)
        if (!hit) return
        const delta = grabbedWorldPanDelta(drag.anchorX, drag.anchorZ, hit.x, hit.z)
        target.x += delta.x
        target.z += delta.z
        clampTarget()
        applyCamera()
        viewportDirty = true
        markInteraction()
        if (!drag.moved) {
          drag.moved = hasPointerDragged(drag.x, drag.y, event.clientX, event.clientY)
          if (drag.moved) clearBuildPreview()
        }
        return
      }
      updateBuildPreview(event.clientX, event.clientY)
    }

    function onPointerUp(event: PointerEvent): void {
      const startedOnMap = drag.onMap
      const moved = drag.moved || hasPointerDragged(drag.x, drag.y, event.clientX, event.clientY)
      drag.active = false
      drag.onMap = false
      drag.moved = false
      renderer.setPixelRatio(activePixelRatio())
      markInteraction()
      if (startedOnMap && !moved && event.button === 0) {
        const tile = pickTileAt(event.clientX, event.clientY)
        const store = useGameStore.getState()
        if (tile) {
          store.selectTile(tile.x, tile.y)
          // Destroy tool: select the owned facility so the inspector sell/cancel
          // confirmation is the only mutation path (no instant deletion).
          if (store.mapTool === 'destroy') {
            store.setLeftRailOpen(false)
          }
        } else {
          store.selectTile(0, null)
        }
      }
      updateBuildPreview(event.clientX, event.clientY)
    }

    function onPointerLeave(): void {
      if (!drag.active) clearBuildPreview()
    }

    function onBlueprintDragOver(event: DragEvent): void {
      if (!hasBuildBlueprintDrag(event.dataTransfer)) return
      const kind =
        readBuildBlueprintDrag(event.dataTransfer) ?? useGameStore.getState().buildMode
      if (!kind) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      updateBuildPreview(event.clientX, event.clientY, kind)
      markInteraction()
    }

    function onBlueprintDrop(event: DragEvent): void {
      if (!hasBuildBlueprintDrag(event.dataTransfer)) return
      const store = useGameStore.getState()
      const kind = readBuildBlueprintDrag(event.dataTransfer) ?? store.buildMode
      if (!kind) return
      event.preventDefault()
      const tile = pickTileAt(event.clientX, event.clientY)
      if (!tile) {
        clearBuildPreview()
        return
      }
      if (store.buildMode !== kind) store.setBuildMode(kind)
      useGameStore.getState().selectTile(tile.x, tile.y)
      clearBuildPreview()
      markInteraction()
    }

    function onBlueprintDragLeave(event: DragEvent): void {
      if (event.relatedTarget === renderer.domElement) return
      clearBuildPreview()
    }

    function onBlueprintDragEnd(): void {
      clearBuildPreview()
    }

    function onWheel(event: WheelEvent): void {
      event.preventDefault()
      // Some browsers coalesce a fast wheel gesture into a multi-thousand-pixel
      // packet. Limit one event to a modest camera step so the chunk guard ring
      // can prewarm the newly exposed area instead of teleporting across it.
      const modeScale =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? renderedHeight
            : 1
      const deltaPixels = THREE.MathUtils.clamp(
        event.deltaY * modeScale,
        -MAX_WHEEL_DELTA_PX,
        MAX_WHEEL_DELTA_PX,
      )
      frustum = THREE.MathUtils.clamp(
        frustum + deltaPixels * 0.008,
        MIN_FRUSTUM,
        MAX_FRUSTUM,
      )
      updateProjectionMatrix()
      applyCamera()
      viewportDirty = true
      markInteraction()
    }

    function onKeyDown(event: KeyboardEvent): void {
      const targetElement = event.target as HTMLElement | null
      const tagName = targetElement?.tagName
      if (targetElement?.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return
      const key = event.key.toLowerCase()
      if (!event.repeat && key === 'q') {
        useUiStore.getState().rotateMapCamera(-1)
        event.preventDefault()
        return
      }
      if (!event.repeat && key === 'e') {
        useUiStore.getState().rotateMapCamera(1)
        event.preventDefault()
        return
      }
      if (!event.repeat && key === 't') {
        useUiStore.getState().cycleMapCameraTilt()
        event.preventDefault()
        return
      }
      if (!event.repeat && key === 'r') {
        useUiStore.getState().resetMapCamera()
        event.preventDefault()
        return
      }
      if (!['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(key)) {
        return
      }
      keys.add(key)
      markInteraction()
      event.preventDefault()
    }

    function onKeyUp(event: KeyboardEvent): void {
      keys.delete(event.key.toLowerCase())
    }

    function applyResize(): void {
      resizeFrame = 0
      if (disposed || !mountRef.current) return
      const width = Math.max(1, mountRef.current.clientWidth)
      const height = Math.max(1, mountRef.current.clientHeight)
      if (width === renderedWidth && height === renderedHeight) return
      renderedWidth = width
      renderedHeight = height
      updateProjectionMatrix()
      renderer.setSize(width, height, false)
      viewportDirty = true
      markInteraction()
    }

    function onResize(): void {
      if (resizeFrame) return
      resizeFrame = requestAnimationFrame(applyResize)
    }

    function onWebglContextLost(event: Event): void {
      // Without preventDefault the canvas is never restored and the map stays
      // white until a full page reload.
      event.preventDefault()
      contextLost = true
    }

    function onWebglContextRestored(): void {
      contextLost = false
      renderFaultCount = 0
      // GPU chunk/texture buffers were dropped with the context. Force a full
      // projection rebuild from the immutable sim state instead of trusting
      // resident GPU resources that no longer exist.
      const store = useGameStore.getState()
      replaceProjection(store.state, store.selectedTile, store.buildMode)
      viewportDirty = true
      markInteraction()
      scheduleAnimation()
    }

    function onVisibilityChange(): void {
      if (document.hidden) {
        if (animationFrame) cancelAnimationFrame(animationFrame)
        animationFrame = 0
        return
      }
      lastFrameAt = performance.now()
      lastRenderAt = 0
      viewportDirty = true
      scheduleAnimation()
    }

    const unsubscribeStore = useGameStore.subscribe((next, previous) => {
      const stateChanged = next.state !== previous.state
      const uiChanged =
        next.selectedTile !== previous.selectedTile ||
        next.buildMode !== previous.buildMode ||
        next.mapOverlay !== previous.mapOverlay ||
        next.mapTool !== previous.mapTool
      const focusChanged = next.mapFocusRequest !== previous.mapFocusRequest
      let visualChange = false

      if (stateChanged) {
        syncRivalLabels(next.state)
        if (!projection.source.isCompatible(next.state)) {
          replaceProjection(next.state, next.selectedTile, next.buildMode)
          visualChange = true
        } else {
          const delta = projection.source.updateState(next.state)
          lastJournalBacklog = delta.journalBacklog
          if (delta.entireSurface) {
            projection.viewport.updateEntireSurface()
            visualChange = true
          }
          else if (delta.surfaceTileIds.length > 0) {
            projection.viewport.updateSurface(delta.surfaceTileIds)
            visualChange = true
          }
          if (delta.chunkIds.length > 0) {
            viewportDirty = true
            visualChange = true
          }
          // Canonical congestion changes daily even when no road cell changes.
          // Re-enter the traffic projection so it can refresh speeds against
          // the new immutable load snapshot without rebuilding lane topology.
          if (next.state.transport !== previous.state.transport) {
            viewportDirty = true
            visualChange = true
          }
          if (next.state.map.regions !== projection.regions) {
            projection.regions = next.state.map.regions
            rebuildRegionLabels(labels, projection.regions, projection.source)
            rebuildRegionOverlays(regionOverlays, projection.regions, next.mapOverlay, projection.source)
            visualChange = true
          }
          const loadedEarlierDay = next.state.day < previous.state.day
          if (next.state.seed !== previous.state.seed || loadedEarlierDay) {
            centerCamera(next.state)
            visualChange = true
          }
        }
      }

      if (uiChanged) {
        const delta = projection.source.updateUi(next.selectedTile, next.buildMode)
        if (delta.surfaceTileIds.length > 0) projection.viewport.updateSurface(delta.surfaceTileIds)
        moveSelectionMarker(next.selectedTile)
        if (!next.buildMode) clearBuildPreview()
        if (next.mapOverlay !== previous.mapOverlay || next.state.map.regions !== previous.state.map.regions) {
          rebuildRegionOverlays(regionOverlays, projection.regions, next.mapOverlay, projection.source)
        }
        // Destroy tool uses red selection marker so eligible sells are obvious.
        selectionMaterial.color.setHex(next.mapTool === 'destroy' ? PREVIEW_BAD : PREVIEW_OK)
        visualChange = true
      }
      if (focusChanged && next.mapFocusRequest) {
        target.set(
          next.mapFocusRequest.x * MAP_TILE_SIZE,
          0,
          next.mapFocusRequest.y * MAP_TILE_SIZE,
        )
        if (!(next.mapFocusRequest as { preserveZoom?: boolean }).preserveZoom) {
          frustum = Math.min(frustum, DEFAULT_FRUSTUM)
        }
        clampTarget()
        updateProjectionMatrix()
        applyCamera()
        viewportDirty = true
        visualChange = true
      }
      if (visualChange) markInteraction()
    })

    const unsubscribeUiStore = useUiStore.subscribe((next, previous) => {
      const headingChanged = next.mapCameraHeading !== previous.mapCameraHeading
      const tiltChanged = next.mapCameraTilt !== previous.mapCameraTilt
      const reducedMotionEnabled = next.reducedMotion && !previous.reducedMotion
      const cloudsChanged = next.cloudsVisible !== previous.cloudsVisible
      if (cloudsChanged) {
        projection.viewport.setCloudsVisible(next.cloudsVisible)
        markInteraction()
        scheduleAnimation()
      }
      if (!headingChanged && !tiltChanged && !reducedMotionEnabled) return

      const now = performance.now()
      if (headingChanged) {
        cameraRotation = retargetMapCameraRotation(
          cameraRotation,
          previous.mapCameraHeading,
          next.mapCameraHeading,
          now,
          next.reducedMotion ? 0 : undefined,
        )
        cameraHeading = next.mapCameraHeading
      }
      if (reducedMotionEnabled) {
        cameraRotation = createMapCameraRotation(cameraHeading)
      }
      cameraTilt = next.mapCameraTilt
      visualCameraHeading = sampleMapCameraRotation(cameraRotation, now).heading
      updateProjectionMatrix()
      applyCamera()
      viewportDirty = true
      markInteraction()
      scheduleAnimation()
    })

    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerleave', onPointerLeave)
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false })
    renderer.domElement.addEventListener('webglcontextlost', onWebglContextLost)
    renderer.domElement.addEventListener('webglcontextrestored', onWebglContextRestored)
    renderer.domElement.addEventListener('dragover', onBlueprintDragOver)
    renderer.domElement.addEventListener('dragleave', onBlueprintDragLeave)
    renderer.domElement.addEventListener('drop', onBlueprintDrop)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('dragend', onBlueprintDragEnd)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    document.addEventListener('visibilitychange', onVisibilityChange)
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(mount)

    updateProjectionMatrix()
    centerCamera(initialStore.state)
    rebuildRegionLabels(labels, projection.regions, projection.source)
    rebuildRegionOverlays(regionOverlays, projection.regions, initialStore.mapOverlay, projection.source)
    syncRivalLabels(initialStore.state)
    moveSelectionMarker(initialStore.selectedTile)
    reconcileViewport(performance.now())
    scheduleAnimation()

    // Keep first paint immediate through procedural fallbacks, then publish one
    // validated family at a time into the live registry. Only resident batches
    // using those archetypes are retired; camera, surface, simulation and LOD
    // state remain intact instead of paying for a whole projection replacement.
    void (async () => {
      for await (const family of assetCache.streamAll()) {
        if (disposed) return
        assetSnapshot = family.snapshot
        if (family.archetypeIds.length === 0) continue
        for (let offset = 0; offset < family.archetypeIds.length; offset += 16) {
          if (disposed) return
          const publishStarted = performance.now()
          const changed = new Set(family.archetypeIds.slice(offset, offset + 16))
          applyWorldAssetSnapshot(projection.registry, family.snapshot, changed)
          projection.viewport.invalidateArchetypes(changed)
          performance.measure(`labline.asset.publish.${family.family}.${offset / 16}`, {
            start: publishStarted,
            end: performance.now(),
          })
          viewportDirty = true
          markInteraction()
          // Keep each publication slice outside the current input/render task.
          await new Promise<void>(resolve => setTimeout(resolve, 0))
        }
      }
    })()

    return () => {
      disposed = true
      if (animationFrame) cancelAnimationFrame(animationFrame)
      if (resizeFrame) cancelAnimationFrame(resizeFrame)
      unsubscribeStore()
      unsubscribeUiStore()
      resizeObserver.disconnect()
      perfSession?.dispose()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('dragend', onBlueprintDragEnd)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave)
      renderer.domElement.removeEventListener('wheel', onWheel)
      renderer.domElement.removeEventListener('webglcontextlost', onWebglContextLost)
      renderer.domElement.removeEventListener('webglcontextrestored', onWebglContextRestored)
      renderer.domElement.removeEventListener('dragover', onBlueprintDragOver)
      renderer.domElement.removeEventListener('dragleave', onBlueprintDragLeave)
      renderer.domElement.removeEventListener('drop', onBlueprintDrop)
      projection.viewport.dispose()
      projection.registry.dispose()
      assetCache.dispose()
      disposeRegionLabels(labels)
      disposeRegionOverlays(regionOverlays)
      disposeRivalFacilityLabels(rivalLabels)
      disposeBuildPreview(preview)
      selectionGeometry.dispose()
      selectionMaterial.dispose()
      selectionMarker.clear()
      scene.remove(selectionMarker, preview.group, labels, rivalLabels)
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return (
    <div
      ref={mountRef}
      tabIndex={0}
      className={`absolute inset-0 outline-none ${buildMode || mapTool === 'destroy' ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
      title="WASD / arrows to pan · Q/E rotate · T tilt · R reset view · drag · scroll zoom"
    >
      <div
        ref={placementTooltipRef}
        hidden
        className="build-placement-tooltip pointer-events-none absolute z-30 min-w-40 rounded-lg border border-mint/45 bg-void/95 px-2.5 py-2 font-mono shadow-xl backdrop-blur-md"
      >
        <span ref={placementLandRef} className="block text-[0.6875rem] font-semibold text-bone" />
        <span ref={placementGradeRef} className="mt-0.5 block text-[0.5625rem] text-bone/70" />
        <span ref={placementTotalRef} className="build-placement-total mt-0.5 block text-[0.5625rem] text-mint" />
      </div>
    </div>
  )
}

function createBuildPreview(): PreviewState {
  const group = new THREE.Group()
  group.name = 'build-footprint-preview'
  group.visible = false
  const cellGeometry = new THREE.BoxGeometry(MAP_TILE_SIZE * 0.96, 0.1, MAP_TILE_SIZE * 0.96)
  const okMaterial = new THREE.MeshBasicMaterial({
    color: PREVIEW_OK,
    transparent: true,
    opacity: 0.58,
    depthWrite: false,
  })
  const badMaterial = new THREE.MeshBasicMaterial({
    color: PREVIEW_BAD,
    transparent: true,
    opacity: 0.58,
    depthWrite: false,
  })
  const volume = new THREE.Mesh(
    new THREE.BoxGeometry(MAP_TILE_SIZE * 0.72, 0.55, MAP_TILE_SIZE * 0.55),
    new THREE.MeshBasicMaterial({
      color: PREVIEW_OK,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    }),
  )
  volume.name = 'build-volume-preview'
  volume.position.y = 0.35
  volume.visible = false
  volume.renderOrder = 12
  group.add(volume)
  return {
    group,
    meshes: [],
    cellGeometry,
    okMaterial,
    badMaterial,
    volume,
    hoverKey: null,
  }
}

function ensurePreviewMeshes(preview: PreviewState, count: number): void {
  while (preview.meshes.length < count) {
    const mesh = new THREE.Mesh(preview.cellGeometry, preview.okMaterial)
    mesh.position.y = 0.08
    mesh.renderOrder = 12
    preview.group.add(mesh)
    preview.meshes.push(mesh)
  }
  for (let index = 0; index < preview.meshes.length; index++) {
    preview.meshes[index]!.visible = index < count
  }
}

function disposeBuildPreview(preview: PreviewState): void {
  preview.group.clear()
  preview.cellGeometry.dispose()
  preview.okMaterial.dispose()
  preview.badMaterial.dispose()
  preview.volume.geometry.dispose()
  preview.volume.material.dispose()
}


function rebuildRegionOverlays(
  group: THREE.Group,
  regions: readonly MapRegion[],
  overlay: MapOverlayMode,
  source?: SimViewportRenderSource,
): void {
  disposeRegionOverlays(group)
  if (overlay === 'none') return
  for (let index = 0; index < regions.length; index++) {
    const region = regions[index]!
    const color = new THREE.Color(regionOverlayFill(region, regions, overlay, index))
    const geometry = new THREE.PlaneGeometry(region.width * MAP_TILE_SIZE, region.height * MAP_TILE_SIZE)
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: overlay === 'zones' ? 0.18 : 0.28,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `region-overlay-${region.id}`
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(
      (region.originX + region.width / 2 - 0.5) * MAP_TILE_SIZE,
      (source?.getTileElevation(
        Math.floor(region.originX + region.width / 2),
        Math.floor(region.originY + region.height / 2),
      ) ?? 0) + 0.04,
      (region.originY + region.height / 2 - 0.5) * MAP_TILE_SIZE,
    )
    mesh.renderOrder = 2
    group.add(mesh)
  }
}

function disposeRegionOverlays(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child)
    if (!(child instanceof THREE.Mesh)) continue
    child.geometry.dispose()
    const material = child.material
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
    else material.dispose()
  }
}

function rebuildRegionLabels(
  group: THREE.Group,
  regions: readonly MapRegion[],
  source?: SimViewportRenderSource,
): void {
  disposeRegionLabels(group)
  for (const region of regions) {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 128
    const context = canvas.getContext('2d')
    if (!context) continue
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = 'rgba(14,16,22,0.8)'
    context.beginPath()
    context.roundRect(40, 30, 432, 68, 16)
    context.fill()
    context.font = '600 34px Space Grotesk, sans-serif'
    context.fillStyle = '#eceae4'
    context.textAlign = 'center'
    context.fillText(region.name, 256, 74)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    })
    const sprite = new THREE.Sprite(material)
    sprite.name = `region-label-${region.id}`
    sprite.scale.set(4.2, 1.05, 1)
    sprite.position.set(
      (region.originX + region.width / 2) * MAP_TILE_SIZE,
      (source?.getTileElevation(
        Math.floor(region.originX + region.width / 2),
        Math.floor(region.originY + region.height / 2),
      ) ?? 0) + 2.2,
      (region.originY + region.height / 2) * MAP_TILE_SIZE,
    )
    group.add(sprite)
  }
}

function elevateWorldLabels(
  group: THREE.Group,
  source: SimViewportRenderSource,
  clearance: number,
): void {
  for (const child of group.children) {
    const x = Math.round(child.position.x / MAP_TILE_SIZE)
    const y = Math.round(child.position.z / MAP_TILE_SIZE)
    child.position.y = source.getTileElevation(x, y) + clearance
  }
}

function disposeRegionLabels(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child)
    if (!(child instanceof THREE.Sprite)) continue
    child.material.map?.dispose()
    child.material.dispose()
  }
}

function rebuildRivalFacilityLabels(
  group: THREE.Group,
  sites: readonly RivalMapSite[],
): void {
  disposeRivalFacilityLabels(group)
  for (const site of sites) {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 176
    const context = canvas.getContext('2d')
    if (!context) continue

    const accent = `#${site.color.toString(16).padStart(6, '0')}`
    const constructing = rivalSiteIsConstructing(site)
    const status = constructing
      ? `BUILD ${Math.round(rivalSiteProgress(site) * 100)}%`
      : site.rackCapacity > 0
        ? `${site.racksUsed}/${site.rackCapacity} BAYS`
        : 'ONLINE'

    context.clearRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = 'rgba(7,17,23,0.93)'
    context.strokeStyle = accent
    context.lineWidth = 5
    context.beginPath()
    context.roundRect(20, 16, 600, 144, 22)
    context.fill()
    context.stroke()
    context.fillStyle = accent
    context.fillRect(20, 16, 14, 144)
    context.font = '600 34px Space Grotesk, sans-serif'
    context.fillStyle = '#e8f2f2'
    context.textAlign = 'left'
    context.fillText(site.companyName, 58, 70, 360)
    context.font = '500 24px IBM Plex Mono, monospace'
    context.fillStyle = '#91a6ad'
    context.fillText(rivalSiteKindLabel(site.kind), 58, 116, 360)
    context.fillStyle = constructing ? '#e8ad56' : accent
    context.textAlign = 'right'
    context.fillText(status, 590, 96, 170)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    })
    const sprite = new THREE.Sprite(material)
    sprite.name = `rival-site-label-${site.id}`
    sprite.renderOrder = 30
    sprite.scale.set(5.6, 1.54, 1)
    sprite.position.set(site.x * MAP_TILE_SIZE, 2.7, site.y * MAP_TILE_SIZE)
    group.add(sprite)
  }
}

function disposeRivalFacilityLabels(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child)
    if (!(child instanceof THREE.Sprite)) continue
    child.material.map?.dispose()
    child.material.dispose()
  }
}

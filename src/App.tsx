import { useCallback, useEffect, useState } from 'react'
import { installGameSaveLifecycle, useGameStore } from './store/gameStore'
import { GameMap } from './view/three/GameMap'
import { TopBar } from './view/hud/TopBar'
import { BottomBar } from './view/hud/BottomBar'
import { TrainingActivityBar } from './view/hud/TrainingActivityBar'
import { LeftRail } from './view/hud/LeftRail'
import { CommandDock } from './view/hud/CommandDock'
import { HotkeyHelp } from './view/hud/HotkeyHelp'
import { NewGameMenu } from './view/hud/NewGameMenu'
import { PauseMenu } from './view/hud/PauseMenu'
import { VictoryOverlay } from './view/hud/VictoryOverlay'
import { TileInspector } from './view/hud/TileInspector'
import { useHotkeys } from './view/hud/useHotkeys'
import { UiScaleRoot } from './view/hud/UiScaleRoot'
import { panelPresentation } from './view/hud/navConfig'
import { ObjectivesDock } from './view/hud/ObjectivesDock'
import { HudFeedback } from './view/hud/HudFeedback'
import { FULL_BLEED_MAP_STYLE } from './view/hud/layout'
import { MapNavigator } from './view/hud/MapNavigator'
import { ReleaseCelebration } from './view/hud/ReleaseCelebration'
import { DataHallEditorOverlay } from './view/hud/panels/hardware/DataHallEditorOverlay'
import { HqOfficeEditorOverlay } from './view/hud/panels/HqOfficeEditorOverlay'

function GameShell() {
  const paused = useGameStore((s) => s.state.paused)
  const speed = useGameStore((s) => s.state.speed)
  const outcome = useGameStore((s) => s.state.victory.outcome)
  const stepDay = useGameStore((s) => s.stepDay)
  const activePanel = useGameStore((s) => s.activePanel)
  const leftOpen = useGameStore((s) => s.leftRailOpen)
  const dockOpen = useGameStore((s) => s.commandDockOpen)
  const hqOfficeEditorFacilityId = useGameStore((s) => s.hqOfficeEditorFacilityId)
  const setPanel = useGameStore((s) => s.setPanel)
  const [modelsFocusJobId, setModelsFocusJobId] = useState<string | null>(null)
  useHotkeys()

  const openModelsRun = useCallback(
    (jobId: string) => {
      setModelsFocusJobId(jobId)
      setPanel('models')
    },
    [setPanel],
  )
  const openModels = useCallback(() => {
    setModelsFocusJobId(null)
    setPanel('models')
  }, [setPanel])
  const clearModelsFocus = useCallback(() => setModelsFocusJobId(null), [])

  const presentation = panelPresentation(activePanel)
  const workbenchOpen = leftOpen && presentation !== 'drawer'

  useEffect(() => {
    if (paused || speed === 0 || outcome !== 'playing') return
    const ms = Math.max(250, 4000 / speed)
    const id = window.setInterval(() => {
      stepDay()
    }, ms)
    return () => clearInterval(id)
  }, [paused, speed, stepDay, outcome])

  return (
    <div
      className="game-shell grain relative h-full w-full overflow-hidden bg-void text-bone"
      data-workspace-open={leftOpen ? 'true' : 'false'}
      data-presentation={presentation}
      data-active-panel={activePanel}
      data-intel-open={dockOpen && !workbenchOpen ? 'true' : 'false'}
      data-hq-office-open={hqOfficeEditorFacilityId ? 'true' : 'false'}
    >
      <a href="#game-map" className="skip-to-map">Skip controls and focus the map</a>
      <TopBar />
      <LeftRail
        modelsFocusJobId={modelsFocusJobId}
        onModelsFocusHandled={clearModelsFocus}
      />
      <main
        id="game-map"
        tabIndex={-1}
        className="game-map relative min-h-0 min-w-0 overflow-hidden"
        style={FULL_BLEED_MAP_STYLE}
      >
        <GameMap />
        <TileInspector />
      </main>
      <CommandDock forceCollapsed={workbenchOpen} />
      <MapNavigator />
      <BottomBar />
      <TrainingActivityBar
        onOpenModels={openModels}
        onOpenModelsRun={openModelsRun}
      />
      <ObjectivesDock />
      <VictoryOverlay />
      <PauseMenu />
      <HotkeyHelp />
      <HudFeedback />
      <ReleaseCelebration />
      <DataHallEditorOverlay />
      <HqOfficeEditorOverlay key={hqOfficeEditorFacilityId ?? 'hq-office-closed'} />
    </div>
  )
}

function LoadingScreen() {
  const loading = useGameStore((state) => state.loading)
  const progress = Math.max(0, Math.min(1, loading?.progress ?? 0))
  return (
    <UiScaleRoot>
      <main className="grain grid h-full w-full place-items-center bg-void px-6 text-bone">
        <section className="w-full max-w-md border border-line bg-panel/95 p-6 shadow-2xl" role="status" aria-live="polite">
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.22em] text-mint">
            {loading?.operation === 'load-game' ? 'Restoring campaign' : 'Generating operation'}
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-[-0.04em]">Preparing the world</h1>
          <p className="mt-2 text-[0.8125rem] text-muted">{loading?.message ?? 'Initializing…'}</p>
          <div className="mt-5 h-1 overflow-hidden bg-void" aria-hidden="true">
            <div
              className="h-full bg-mint transition-[width] duration-300"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <p className="mt-2 text-right font-mono text-[0.625rem] text-muted">
            {Math.round(progress * 100)}%
          </p>
        </section>
      </main>
    </UiScaleRoot>
  )
}

export default function App() {
  const phase = useGameStore((s) => s.phase)

  useEffect(() => {
    const cleanup = installGameSaveLifecycle()
    void useGameStore.getState().refreshSaves()
    return cleanup
  }, [])

  if (phase === 'loading') return <LoadingScreen />

  if (phase === 'menu') {
    return (
      <UiScaleRoot>
        <div className="grain relative h-full w-full bg-void text-bone">
          <NewGameMenu />
          <HudFeedback />
        </div>
      </UiScaleRoot>
    )
  }

  return (
    <UiScaleRoot>
      <GameShell />
    </UiScaleRoot>
  )
}

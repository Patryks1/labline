import { useRef, type TouchEvent as ReactTouchEvent } from 'react'
import { useGameStore } from '../../../store/gameStore'
import { SegmentedTabs } from '../ui/kit'
import { ChipsPanel } from './ChipsPanel'
import { RacksPanel } from './RacksPanel'
import {
  hardwareViewAfterSwipe,
  type HardwareView,
} from './hardware/mobileHardwareNavigation'

export function HardwarePanel({ view }: { view: HardwareView }) {
  const setPanel = useGameStore((store) => store.setPanel)
  const swipeStart = useRef<{
    x: number
    y: number
    blocked: boolean
  } | null>(null)

  const startSwipe = (event: ReactTouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]
    if (!touch) return
    const target = event.target
    swipeStart.current = {
      x: touch.clientX,
      y: touch.clientY,
      blocked:
        target instanceof Element &&
        Boolean(
          target.closest(
            'input, select, textarea, [role="slider"], [data-horizontal-scroll]',
          ),
        ),
    }
  }

  const finishSwipe = (event: ReactTouchEvent<HTMLDivElement>) => {
    const start = swipeStart.current
    swipeStart.current = null
    const touch = event.changedTouches[0]
    if (!start || start.blocked || !touch) return
    const nextView = hardwareViewAfterSwipe(
      view,
      touch.clientX - start.x,
      touch.clientY - start.y,
    )
    if (nextView !== view) {
      event.preventDefault()
      setPanel(nextView === 'racks' ? 'racks' : 'chips')
    }
  }

  return (
    <div className="min-w-0 space-y-3 overflow-x-clip max-[640px]:space-y-2">
      <SegmentedTabs
        ariaLabel="Hardware sections"
        active={view}
        onChange={(id) => setPanel(id === 'racks' ? 'racks' : 'chips')}
        idPrefix="hardware-sections"
        items={[
          { id: 'racks', label: 'Rack fleet', panelId: 'hardware-panel-racks' },
          { id: 'silicon', label: 'Custom silicon', panelId: 'hardware-panel-silicon' },
        ]}
      />
      <div
        key={view}
        id={`hardware-panel-${view}`}
        role="tabpanel"
        aria-labelledby={`hardware-sections-${view}`}
        aria-describedby="hardware-mobile-swipe-hint"
        data-swipe-navigation="hardware-sections"
        onTouchStart={startSwipe}
        onTouchEnd={finishSwipe}
        onTouchCancel={() => {
          swipeStart.current = null
        }}
        className="panel-swap min-w-0 touch-pan-y overflow-x-clip"
      >
        {view === 'racks' ? <RacksPanel /> : <ChipsPanel />}
      </div>
      <p id="hardware-mobile-swipe-hint" className="sr-only">
        On a touch screen, swipe left or right to switch hardware sections.
      </p>
    </div>
  )
}

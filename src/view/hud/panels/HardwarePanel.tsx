import { useGameStore } from '../../../store/gameStore'
import { ChipsPanel } from './ChipsPanel'
import { RacksPanel } from './RacksPanel'

export function HardwarePanel({ view }: { view: 'racks' | 'silicon' }) {
  const setPanel = useGameStore((store) => store.setPanel)

  return (
    <div className="space-y-3">
      <div
        className="grid grid-cols-2 gap-1 rounded-xl border border-line/70 bg-void/45 p-1"
        role="tablist"
        aria-label="Hardware sections"
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === 'racks'}
          onClick={() => setPanel('racks')}
          className={`rounded-lg px-3 py-1.5 text-[0.75rem] font-medium transition ${
            view === 'racks' ? 'bg-bone text-void' : 'text-muted hover:bg-panel-2 hover:text-bone'
          }`}
        >
          Rack fleet
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'silicon'}
          onClick={() => setPanel('chips')}
          className={`rounded-lg px-3 py-1.5 text-[0.75rem] font-medium transition ${
            view === 'silicon' ? 'bg-bone text-void' : 'text-muted hover:bg-panel-2 hover:text-bone'
          }`}
        >
          Custom silicon
        </button>
      </div>
      {view === 'racks' ? <RacksPanel /> : <ChipsPanel />}
    </div>
  )
}

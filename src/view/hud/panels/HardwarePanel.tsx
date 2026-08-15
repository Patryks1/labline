import { useGameStore } from '../../../store/gameStore'
import { SegmentedTabs } from '../ui/kit'
import { ChipsPanel } from './ChipsPanel'
import { RacksPanel } from './RacksPanel'

export function HardwarePanel({ view }: { view: 'racks' | 'silicon' }) {
  const setPanel = useGameStore((store) => store.setPanel)

  return (
    <div className="space-y-3">
      <SegmentedTabs
        ariaLabel="Hardware sections"
        active={view}
        onChange={(id) => setPanel(id === 'racks' ? 'racks' : 'chips')}
        items={[
          { id: 'racks', label: 'Rack fleet' },
          { id: 'silicon', label: 'Custom silicon' },
        ]}
      />
      <div key={view} className="panel-swap">
        {view === 'racks' ? <RacksPanel /> : <ChipsPanel />}
      </div>
    </div>
  )
}

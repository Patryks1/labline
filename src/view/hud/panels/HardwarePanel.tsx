import { useGameStore } from '../../../store/gameStore'
import { PanelScaffold } from '../ui/HudPrimitives'
import { SegmentedTabs } from '../ui/kit'
import { ChipsPanel } from './ChipsPanel'
import { RacksPanel } from './RacksPanel'

export function HardwarePanel({ view }: { view: 'racks' | 'silicon' }) {
  const setPanel = useGameStore((store) => store.setPanel)

  return (
    <PanelScaffold
      eyebrow="Hardware"
      title={view === 'racks' ? 'Rack fleet' : 'Custom silicon'}
      description={
        view === 'racks'
          ? 'Order racks into halls and manage blueprints.'
          : 'Design dies and run fab campaigns.'
      }
    >
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
    </PanelScaffold>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { BUILD_DEFS, buildingTotalCost, getBuildDef } from '../../sim/systems/map'
import { ECONOMY } from '../../sim/balance/economy'
import { useGameStore } from '../../store/gameStore'
import { mapTileAtAny } from '../../sim/systems/worldAccess'
import { money, num, people } from './format'
import { FacilityModelPreview } from './ui/FacilityModelPreview'

type BuildCategoryId = 'compute' | 'power' | 'people' | 'research' | 'silicon'

const BUILD_CATEGORIES: { id: BuildCategoryId; label: string; kinds: string[] }[] = [
  { id: 'compute', label: 'Compute', kinds: ['dc', 'dc_m', 'dc_l', 'cooling'] },
  { id: 'power', label: 'Power', kinds: ['substation', 'solar', 'gas', 'nuclear', 'battery'] },
  { id: 'people', label: 'People', kinds: ['hq', 'hq_m', 'hq_l'] },
  { id: 'research', label: 'Research', kinds: ['lab'] },
  { id: 'silicon', label: 'Silicon', kinds: ['fab'] },
]

/** Infrastructure-native build catalogue. Placement continues on the map after selection. */
export function BuildPanel() {
  const state = useGameStore((s) => s.state)
  const selected = useGameStore((s) => s.selectedTile)
  const buildMode = useGameStore((s) => s.buildMode)
  const setBuildMode = useGameStore((s) => s.setBuildMode)
  const [buildCategory, setBuildCategory] = useState<BuildCategoryId>('compute')
  const [selectedKind, setSelectedKind] = useState(() => buildMode ?? 'dc')

  useEffect(() => {
    if (!buildMode) return
    setSelectedKind(buildMode)
    const nextCategory = BUILD_CATEGORIES.find((item) => item.kinds.includes(buildMode))
    if (nextCategory) setBuildCategory(nextCategory.id)
  }, [buildMode])

  const category = BUILD_CATEGORIES.find((item) => item.id === buildCategory) ?? BUILD_CATEGORIES[0]!
  const categoryDefs = useMemo(
    () => BUILD_DEFS.filter((definition) => category.kinds.includes(definition.kind)),
    [category],
  )
  const selectedDef = getBuildDef(selectedKind)
  const tile = selected ? mapTileAtAny(state, selected.x, selected.y) : undefined
  const upfrontTotal = tile
    ? buildingTotalCost(state, tile, selectedDef.kind)
    : Math.floor(selectedDef.cash * (state.config?.economyMult ?? 1))
  const buildCash = Math.floor(selectedDef.cash * (state.config?.economyMult ?? 1))
  const landEstimate = Math.max(0, upfrontTotal - buildCash)
  const shellOpex = selectedDef.opexPerDay * (ECONOMY.facilityOpexMultiplier ?? 1)
  const estimatedPowerMw = selectedDef.rack
    ? selectedDef.rack * 0.006
    : selectedDef.mw ?? selectedDef.gen ?? 0

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="hud-panel-title">Build</h2>
          <p className="hud-panel-sub">Choose a facility, review its footprint and cost, then place it on open land.</p>
        </div>
        {buildMode ? (
          <button
            type="button"
            className="shrink-0 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[0.6875rem] font-medium text-danger hover:bg-danger/20"
            onClick={() => setBuildMode(null)}
          >
            Exit placement
          </button>
        ) : null}
      </div>

      <div className="flex gap-1 overflow-x-auto rounded-xl bg-void/50 p-1" role="tablist" aria-label="Build categories">
        {BUILD_CATEGORIES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={buildCategory === item.id}
            onClick={() => {
              setBuildCategory(item.id)
              const first = BUILD_DEFS.find((definition) => item.kinds.includes(definition.kind))
              if (first) setSelectedKind(first.kind)
            }}
            className={`min-h-8 flex-1 shrink-0 rounded-lg px-2 text-[0.6875rem] font-medium transition ${
              buildCategory === item.id
                ? 'bg-mint/20 text-mint ring-1 ring-mint/30'
                : 'text-muted hover:bg-panel-2 hover:text-bone'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {categoryDefs.map((definition) => {
          const selectedBuild = selectedKind === definition.kind
          const broke = state.player.cash < definition.cash
          return (
            <button
              key={definition.kind}
              type="button"
              onClick={() => setSelectedKind(definition.kind)}
              className={`rounded-xl border px-2.5 py-2 text-left transition ${
                selectedBuild
                  ? 'border-mint/45 bg-mint/10'
                  : 'border-line/70 bg-panel-2/55 hover:border-mint/25'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-[0.75rem] font-semibold text-bone">{definition.label}</span>
                <span className={`shrink-0 font-mono text-[0.625rem] ${broke ? 'text-danger' : 'text-mint'}`}>
                  {money(definition.cash)}
                </span>
              </div>
              <span className="mt-0.5 block font-mono text-[0.5625rem] text-muted">
                {money(definition.opexPerDay * (ECONOMY.facilityOpexMultiplier ?? 1))}/d
              </span>
            </button>
          )
        })}
      </div>

      <section className="overflow-hidden rounded-2xl border border-mint/25 bg-mint/5">
        <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3 border-b border-line/60 p-3">
          <div className="min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate text-[0.9375rem] font-semibold text-bone">{selectedDef.label}</h3>
                <p className="mt-0.5 line-clamp-3 text-[0.6875rem] leading-snug text-muted">{selectedDef.blurb}</p>
              </div>
              <span className={`shrink-0 font-mono text-[0.75rem] font-semibold ${state.player.cash < upfrontTotal ? 'text-danger' : 'text-mint'}`}>
                {money(upfrontTotal)}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-1.5 font-mono">
              <BuildMetric label="Build price" value={money(buildCash)} />
              <BuildMetric label="Land" value={landEstimate > 0 ? money(landEstimate) : 'select parcel'} />
              <BuildMetric label="Build time" value={`${selectedDef.days} days`} />
              <BuildMetric label="Daily ops" value={`${money(shellOpex)}/day`} danger />
              <BuildMetric label="Footprint" value={`${selectedDef.footprint?.length ?? 1} tiles`} />
              {estimatedPowerMw > 0 ? (
                <BuildMetric label={selectedDef.gen ? 'Power output' : 'Power / capacity'} value={`${num(estimatedPowerMw, 1)} MW`} />
              ) : null}
              {selectedDef.rack ? <BuildMetric label="Rack bays" value={num(selectedDef.rack)} /> : null}
              {selectedDef.staffCap ? <BuildMetric label="Staff capacity" value={people(selectedDef.staffCap)} /> : null}
            </div>
          </div>
          <FacilityModelPreview definition={selectedDef} />
        </div>

        {buildMode ? (
          <p className="border-b border-mint/25 bg-mint/10 px-3 py-2 text-[0.6875rem] leading-snug text-mint">
            Placement active: hover the map for the footprint, click open land to place, or press Esc to exit.
          </p>
        ) : null}

        <div className="space-y-2 bg-panel-2/70 p-3">
          <div className="font-mono text-[0.6875rem] text-muted">
            {tile?.kind === 'empty'
              ? `${tile.name || 'Selected parcel'} · ${money(tile.landValue ?? 0)} land`
              : 'Select open land for an exact total'}
          </div>
          <button
            type="button"
            disabled={state.player.cash < upfrontTotal}
            title={state.player.cash < upfrontTotal ? `Requires ${money(upfrontTotal - state.player.cash)} more cash` : undefined}
            onClick={() => setBuildMode(selectedDef.kind)}
            className="btn-primary w-full"
          >
            {buildMode === selectedDef.kind ? `Placing ${selectedDef.label}` : `Place ${selectedDef.label} on map`}
          </button>
        </div>
      </section>
    </div>
  )
}

function BuildMetric({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-line/50 bg-void/40 px-2 py-1.5">
      <div className="truncate text-[0.5625rem] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 truncate text-[0.6875rem] font-semibold ${danger ? 'text-danger' : 'text-bone'}`}>{value}</div>
    </div>
  )
}

import { useEffect, useMemo, useState, type DragEvent } from 'react'
import {
  Circuitry,
  Cpu,
  DotsSixVertical,
  Flask,
  Lightning,
  MagnifyingGlass,
  SquaresFour,
  UsersThree,
  X,
  type Icon,
} from '@phosphor-icons/react'
import { BUILD_DEFS, buildingTotalCost, getBuildDef } from '../../sim/systems/map'
import { ECONOMY } from '../../sim/balance/economy'
import type { BuildableKind, BuildDef } from '../../sim/types'
import { useGameStore } from '../../store/gameStore'
import { mapTileAtAny } from '../../sim/systems/worldAccess'
import { money, num, people } from './format'
import { FacilityModelPreview } from './ui/FacilityModelPreview'
import { writeBuildBlueprintDrag } from '../buildPlacement'

type BuildCategoryId = 'all' | 'compute' | 'power' | 'people' | 'research' | 'silicon'

const BUILD_CATEGORIES: {
  id: BuildCategoryId
  label: string
  icon: Icon
  kinds: BuildableKind[]
}[] = [
  { id: 'all', label: 'All', icon: SquaresFour, kinds: BUILD_DEFS.map((definition) => definition.kind) },
  { id: 'compute', label: 'Compute', icon: Cpu, kinds: ['dc', 'dc_m', 'dc_l', 'cooling'] },
  { id: 'power', label: 'Power', icon: Lightning, kinds: ['substation', 'solar', 'gas', 'nuclear', 'battery'] },
  { id: 'people', label: 'People', icon: UsersThree, kinds: ['hq', 'hq_m', 'hq_l'] },
  { id: 'research', label: 'Research', icon: Flask, kinds: ['lab'] },
  { id: 'silicon', label: 'Silicon', icon: Circuitry, kinds: ['fab'] },
]

const CATEGORY_BY_KIND = new Map(
  BUILD_CATEGORIES.filter((category) => category.id !== 'all').flatMap((category) =>
    category.kinds.map((kind) => [kind, category.label] as const),
  ),
)

/** Infrastructure-native construction catalogue. Placement continues on the map after selection. */
export function BuildPanel() {
  const state = useGameStore((s) => s.state)
  const selected = useGameStore((s) => s.selectedTile)
  const buildMode = useGameStore((s) => s.buildMode)
  const setBuildMode = useGameStore((s) => s.setBuildMode)
  const [buildCategory, setBuildCategory] = useState<BuildCategoryId>('all')
  const [selectedKind, setSelectedKind] = useState<BuildableKind>(() => buildMode ?? 'dc')
  const [search, setSearch] = useState('')
  const economyMult = state.config?.economyMult ?? 1

  useEffect(() => {
    if (!buildMode) return
    setSelectedKind(buildMode)
  }, [buildMode])

  const category = BUILD_CATEGORIES.find((item) => item.id === buildCategory) ?? BUILD_CATEGORIES[0]!
  const query = search.trim().toLocaleLowerCase()
  const visibleDefs = useMemo(
    () =>
      BUILD_DEFS.filter((definition) => {
        if (!category.kinds.includes(definition.kind)) return false
        if (!query) return true
        const haystack = `${definition.label} ${definition.blurb} ${CATEGORY_BY_KIND.get(definition.kind) ?? ''}`.toLocaleLowerCase()
        return haystack.includes(query)
      }),
    [category.kinds, query],
  )

  useEffect(() => {
    if (visibleDefs.length > 0 && !visibleDefs.some((definition) => definition.kind === selectedKind)) {
      setSelectedKind(visibleDefs[0]!.kind)
    }
  }, [selectedKind, visibleDefs])

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
  const filtersActive = Boolean(query || buildCategory !== 'all')

  const startPlacement = (kind: BuildableKind) => {
    setSelectedKind(kind)
    setBuildMode(kind)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="hud-panel-title">Build</h2>
          <p className="hud-panel-sub">Choose a blueprint, compare its footprint, then place it on open land.</p>
        </div>
        {buildMode ? (
          <button
            type="button"
            className="shrink-0 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[0.6875rem] font-medium text-danger transition hover:bg-danger/20 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
            onClick={() => setBuildMode(null)}
          >
            Exit placement
          </button>
        ) : null}
      </div>

      <section aria-labelledby="construction-catalog-title" className="rounded-xl border border-line/70 bg-void/25 p-2.5">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h3 id="construction-catalog-title" className="text-[0.75rem] font-semibold text-bone">
            Construction catalog
          </h3>
          <span className="font-mono text-[0.5625rem] uppercase tracking-wider text-muted">
            {visibleDefs.length}/{BUILD_DEFS.length} blueprints
          </span>
        </div>

        <label className="relative block">
          <span className="sr-only">Search blueprints</span>
          <MagnifyingGlass
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
            size={15}
            weight="bold"
          />
          <input
            type="text"
            role="searchbox"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search halls, power, research…"
            className="h-9 w-full rounded-lg border border-line/80 bg-panel-2/80 pl-8 pr-8 text-[0.75rem] text-bone outline-none transition placeholder:text-muted/70 focus:border-mint/60 focus:ring-2 focus:ring-mint/15"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted transition hover:bg-mint/10 hover:text-mint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50"
              aria-label="Clear blueprint search"
            >
              <X aria-hidden="true" size={13} weight="bold" />
            </button>
          ) : null}
        </label>

        <div
          className="mt-2 grid grid-cols-6 gap-1.5"
          role="group"
          aria-label="Blueprint category"
        >
          {BUILD_CATEGORIES.map((item) => {
            const Icon = item.icon
            const active = buildCategory === item.id
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                aria-label={`${item.label} blueprints (${item.kinds.length})`}
                title={`${item.label} · ${item.kinds.length} blueprints`}
                onClick={() => setBuildCategory(item.id)}
                className={`flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg border px-1 py-1.5 text-[0.5rem] font-semibold transition active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50 ${
                  active
                    ? 'border-mint/45 bg-mint/15 text-mint'
                    : 'border-line/70 bg-panel-2 text-muted hover:border-mint/25 hover:text-bone'
                }`}
              >
                <Icon aria-hidden="true" size={16} weight={active ? 'fill' : 'duotone'} />
                <span className="max-w-full truncate">{item.label}</span>
              </button>
            )
          })}
        </div>
      </section>

      <div
        className="max-h-[17rem] space-y-1.5 overflow-y-auto pr-0.5"
        role="group"
        aria-label="Construction blueprints"
      >
        {visibleDefs.map((definition) => (
          <BlueprintRow
            key={definition.kind}
            definition={definition}
            selected={selectedKind === definition.kind}
            cost={Math.floor(definition.cash * economyMult)}
            affordable={state.player.cash >= definition.cash * economyMult}
            onPlace={() => startPlacement(definition.kind)}
            onDragStart={(event) => {
              setSelectedKind(definition.kind)
              setBuildMode(definition.kind)
              writeBuildBlueprintDrag(event.dataTransfer, definition.kind)
            }}
          />
        ))}
        {visibleDefs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line bg-panel-2/35 px-4 py-5 text-center">
            <p className="text-[0.75rem] font-medium text-bone">No matching blueprints</p>
            <p className="mt-1 text-[0.625rem] leading-relaxed text-muted">
              Try another category or include projects outside the current budget.
            </p>
            {filtersActive ? (
              <button
                type="button"
                onClick={() => {
                  setSearch('')
                  setBuildCategory('all')
                }}
                className="mt-2 text-[0.6875rem] font-semibold text-mint hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50"
              >
                Clear filters
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <section className="overflow-hidden rounded-2xl border border-mint/25 bg-mint/5" aria-labelledby="selected-blueprint-title">
        <div className="border-b border-line/60 bg-void/20 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-mint">Selected blueprint</span>
            <span className="font-mono text-[0.5625rem] uppercase tracking-wider text-muted">
              {CATEGORY_BY_KIND.get(selectedDef.kind)}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3 border-b border-line/60 p-3">
          <div className="min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 id="selected-blueprint-title" className="truncate text-[0.9375rem] font-semibold text-bone">
                  {selectedDef.label}
                </h3>
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
              <BuildMetric label="Footprint" value={footprintLabel(selectedDef)} />
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
            onClick={() => startPlacement(selectedDef.kind)}
            className="btn-primary w-full"
          >
            {buildMode === selectedDef.kind ? `Placing ${selectedDef.label}` : `Place ${selectedDef.label} on map`}
          </button>
        </div>
      </section>
    </div>
  )
}

function BlueprintRow({
  definition,
  selected,
  cost,
  affordable,
  onPlace,
  onDragStart,
}: {
  definition: BuildDef
  selected: boolean
  cost: number
  affordable: boolean
  onPlace: () => void
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void
}) {
  const utility = blueprintUtility(definition)
  return (
    <button
      type="button"
      draggable
      aria-pressed={selected}
      title="Click to place, or drag this blueprint onto the map"
      onClick={onPlace}
      onDragStart={onDragStart}
      className={`group w-full cursor-grab rounded-xl border px-2.5 py-2 text-left transition active:cursor-grabbing active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/60 ${
        selected
          ? 'border-mint/50 bg-mint/10 shadow-[inset_3px_0_0_rgba(77,232,211,0.75)]'
          : 'border-line/65 bg-panel-2/50 hover:border-mint/25 hover:bg-panel-2/80'
      }`}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-1.5">
          <DotsSixVertical
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-muted/65 transition group-hover:text-mint"
            size={13}
            weight="bold"
          />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[0.75rem] font-semibold text-bone">{definition.label}</span>
              <span className="shrink-0 font-mono text-[0.5rem] uppercase tracking-wider text-muted">
                {CATEGORY_BY_KIND.get(definition.kind)}
              </span>
            </div>
            <span className="mt-0.5 block truncate font-mono text-[0.5625rem] text-muted">
              {definition.days}d · {footprintLabel(definition)} · {utility}
            </span>
          </div>
        </div>
        <div className="shrink-0 text-right font-mono">
          <div className={`text-[0.6875rem] font-semibold ${affordable ? 'text-mint' : 'text-danger'}`}>
            {money(cost)}
          </div>
          <div className="mt-0.5 text-[0.5rem] text-muted">
            {money(definition.opexPerDay * (ECONOMY.facilityOpexMultiplier ?? 1))}/d
          </div>
        </div>
      </div>
    </button>
  )
}

function footprintLabel(definition: BuildDef): string {
  const footprint = definition.footprint ?? [{ dx: 0, dy: 0 }]
  const width = Math.max(...footprint.map((cell) => cell.dx)) + 1
  const height = Math.max(...footprint.map((cell) => cell.dy)) + 1
  return width === 1 && height === 1 ? '1 tile' : `${width}×${height} · ${footprint.length} tiles`
}

function blueprintUtility(definition: BuildDef): string {
  if (definition.rack) return `${num(definition.rack)} bays`
  if (definition.gen) return `${num(definition.gen, 1)} MW out`
  if (definition.mw) return `${num(definition.mw, 1)} MW cap`
  if (definition.staffCap) return `${people(definition.staffCap)} seats`
  if (definition.kind === 'lab') return 'research PF'
  if (definition.kind === 'fab') return 'silicon line'
  return 'campus utility'
}

function BuildMetric({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-line/50 bg-void/40 px-2 py-1.5">
      <div className="truncate text-[0.5625rem] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 truncate text-[0.6875rem] font-semibold ${danger ? 'text-danger' : 'text-bone'}`}>{value}</div>
    </div>
  )
}

import { useEffect, useMemo, useState, type DragEvent } from 'react'
import {
  Circuitry,
  Cpu,
  Flask,
  Lightning,
  MagnifyingGlass,
  Backspace,
  SquaresFour,
  UsersThree,
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
import {
  BlockerList,
  CardGrid,
  GameCard,
  LiveDot,
  MeterBar,
  SegmentedTabs,
  StatRow,
} from './ui/kit'
import {
  EmptyState,
  HudButton,
  HudInput,
  MetricTile,
  PanelScaffold,
  StatusChip,
} from './ui/HudPrimitives'

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

const CATEGORY_TONE: Record<string, 'mint' | 'train' | 'infer' | 'research' | 'gold'> = {
  Compute: 'infer',
  Power: 'train',
  People: 'mint',
  Research: 'research',
  Silicon: 'gold',
}

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
  const canAfford = state.player.cash >= upfrontTotal
  const canPlaceOnTile = !tile || tile.kind === 'empty'
  const blockers = [
    ...(!canAfford
      ? [{ text: `Need ${money(upfrontTotal - state.player.cash)} more cash`, tone: 'danger' as const }]
      : []),
    ...(tile && tile.kind !== 'empty'
      ? [{ text: 'Select open land for exact total & placement', tone: 'warning' as const }]
      : []),
  ]

  const startPlacement = (kind: BuildableKind) => {
    setSelectedKind(kind)
    setBuildMode(kind)
  }

  return (
    <PanelScaffold
      eyebrow="Construction"
      title="Build"
      description="Pick a blueprint, then place it on open land."
      actions={
        buildMode ? (
          <HudButton type="button" variant="ghost" onClick={() => setBuildMode(null)}>
            Exit placement
          </HudButton>
        ) : null
      }
    >
      <div className="space-y-3">
        {buildMode ? (
          <div className="flex items-center gap-2 rounded-lg border border-mint/35 bg-mint/10 px-3 py-2 text-[0.8125rem] text-mint">
            <LiveDot />
            <span className="min-w-0 truncate">
              Placing {getBuildDef(buildMode).label} — hover map, click open land, Esc to exit.
            </span>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricTile label="Cash" value={money(state.player.cash)} tone="positive" />
          <MetricTile label="Blueprints" value={`${visibleDefs.length}/${BUILD_DEFS.length}`} />
          <MetricTile label="Build price" value={money(buildCash)} tone="train" />
          <MetricTile
            label="Upfront"
            value={money(upfrontTotal)}
            detail={tile?.kind === 'empty' ? 'incl. land' : 'est.'}
            tone={canAfford ? 'neutral' : 'danger'}
          />
        </div>

        <label className="relative block">
          <span className="sr-only">Search blueprints</span>
          <MagnifyingGlass
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
            size={15}
            weight="bold"
          />
          <HudInput
            type="text"
            role="searchbox"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search halls, power, research…"
            className="h-11 w-full pl-8 pr-8 text-[0.8125rem]"
          />
          {search ? (
            <HudButton
              type="button"
              variant="ghost"
              onClick={() => setSearch('')}
              className="absolute right-0.5 top-1/2 grid size-10 -translate-y-1/2 place-items-center !border-0 !p-0 text-muted"
              aria-label="Clear blueprint search"
            >
              <Backspace aria-hidden="true" size={13} weight="bold" />
            </HudButton>
          ) : null}
        </label>

        <div className="build-category-tabs">
          <SegmentedTabs
            ariaLabel="Blueprint category"
            active={buildCategory}
            onChange={(id) => setBuildCategory(id as BuildCategoryId)}
            items={BUILD_CATEGORIES.map((item) => ({
              id: item.id,
              label: item.label,
              icon: <item.icon size={14} weight={buildCategory === item.id ? 'fill' : 'duotone'} />,
            }))}
          />
        </div>

        <div key={`${buildCategory}-${query}`} className="panel-swap">
          {visibleDefs.length === 0 ? (
            <EmptyState
              title="No matching blueprints"
              description="Try another category or clear the search."
              action={
                filtersActive ? (
                  <HudButton
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setSearch('')
                      setBuildCategory('all')
                    }}
                  >
                    Clear filters
                  </HudButton>
                ) : null
              }
            />
          ) : (
            <CardGrid min="11rem" className="anim-stagger">
              {visibleDefs.map((definition) => {
                const cost = Math.floor(definition.cash * economyMult)
                const affordable = state.player.cash >= cost
                const selected = selectedKind === definition.kind
                const cat = CATEGORY_BY_KIND.get(definition.kind) ?? 'Facility'
                const Icon =
                  BUILD_CATEGORIES.find((c) => c.id !== 'all' && c.kinds.includes(definition.kind))
                    ?.icon ?? SquaresFour
                return (
                  <HudButton
                    key={definition.kind}
                    type="button"
                    variant="ghost"
                    draggable={affordable}
                    aria-pressed={selected}
                    disabled={!affordable}
                    title={
                      affordable
                        ? 'Click to place, or drag onto the map'
                        : `Need ${money(cost - state.player.cash)} more`
                    }
                    onClick={() => {
                      if (!affordable) return
                      startPlacement(definition.kind)
                    }}
                    onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                      if (!affordable) {
                        event.preventDefault()
                        return
                      }
                      setSelectedKind(definition.kind)
                      setBuildMode(definition.kind)
                      writeBuildBlueprintDrag(event.dataTransfer, definition.kind)
                    }}
                    className={`min-h-11 hover-lift rounded-lg border text-left transition disabled:cursor-not-allowed disabled:opacity-55 ${
                      selected
                        ? 'border-mint ring-2 ring-mint/50 bg-mint/10'
                        : 'border-line/70 bg-panel-2/70 hover:border-mint/30'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 border-b border-line/50 px-3 pb-2 pt-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <Icon
                          size={18}
                          weight={selected ? 'fill' : 'duotone'}
                          className={affordable ? 'text-mint' : 'text-danger'}
                        />
                        <div className="min-w-0">
                          <p className="hud-eyebrow">{cat}</p>
                          <h3 className="break-words text-sm font-semibold leading-tight text-bone">{definition.label}</h3>
                        </div>
                      </div>
                      <span
                        className={`shrink-0 font-mono text-[0.8125rem] tabular-nums font-semibold ${
                          affordable ? 'text-mint' : 'text-danger'
                        }`}
                      >
                        {money(cost)}
                      </span>
                    </div>
                    <div className="space-y-1 p-3">
                      <div className="font-mono text-[0.6875rem] tabular-nums text-muted">
                        {definition.days}d · {footprintLabel(definition)}
                      </div>
                      <div className="truncate text-[0.8125rem] text-bone">{blueprintUtility(definition)}</div>
                      {!affordable ? (
                        <p className="text-[0.75rem] text-danger">
                          Short {money(cost - state.player.cash)}
                        </p>
                      ) : null}
                    </div>
                  </HudButton>
                )
              })}
            </CardGrid>
          )}
        </div>

        <GameCard
          tone={CATEGORY_TONE[CATEGORY_BY_KIND.get(selectedDef.kind) ?? ''] ?? 'mint'}
          live={Boolean(buildMode === selectedDef.kind)}
          eyebrow="Selected blueprint"
          title={selectedDef.label}
          actions={
            <StatusChip tone={canAfford ? 'positive' : 'danger'}>{money(upfrontTotal)}</StatusChip>
          }
        >
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <div className="min-w-0 space-y-1">
              <StatRow label="Build price" value={money(buildCash)} />
              <StatRow
                label="Land"
                value={landEstimate > 0 ? money(landEstimate) : tile?.kind === 'empty' ? money(0) : '—'}
              />
              <StatRow label="Build time" value={`${selectedDef.days}d`} />
              <StatRow label="Daily ops" value={`${money(shellOpex)}/d`} tone="danger" />
              <StatRow label="Footprint" value={footprintLabel(selectedDef)} />
              {estimatedPowerMw > 0 ? (
                <StatRow
                  label={selectedDef.gen ? 'Power out' : 'Power / cap'}
                  value={`${num(estimatedPowerMw, 1)} MW`}
                />
              ) : null}
              {selectedDef.rack ? <StatRow label="Rack bays" value={num(selectedDef.rack)} /> : null}
              {selectedDef.staffCap ? (
                <StatRow label="Staff seats" value={people(selectedDef.staffCap)} />
              ) : null}
            </div>
            <FacilityModelPreview definition={selectedDef} />
          </div>

          <div className="mt-3 space-y-2 border-t border-line/50 pt-3">
            <div className="font-mono text-[0.6875rem] tabular-nums text-muted">
              {tile?.kind === 'empty'
                ? `${tile.name || 'Selected parcel'} · ${money(tile.landValue ?? 0)} land`
                : 'Select open land for an exact total'}
            </div>
            <BlockerList items={blockers} />
            {!canPlaceOnTile && canAfford ? (
              <MeterBar label="Parcel" value={0} detail="need empty land" tone="warning" />
            ) : null}
          </div>
        </GameCard>
      </div>
    </PanelScaffold>
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

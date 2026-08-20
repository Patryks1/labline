import { Buildings } from '@phosphor-icons/react'
import { isDcKind } from '../../../../sim/systems/map'
import { useGameStore } from '../../../../store/gameStore'
import { money, mw } from '../../format'
import { EmptyState, HudButton, StatusChip } from '../../ui/HudPrimitives'
import { MeterBar, StatRow } from '../../ui/kit'
import { ECONOMY } from '../../../../sim/balance/economy'
import {
  facilityEditorAction,
  facilityIdForTile,
  facilityRackSummary,
  facilityStaffLines,
  facilityTypeLabel,
  playerFacilities,
} from './facilityIntel'

export function FacilitiesIntelView() {
  const state = useGameStore((store) => store.state)
  const selected = useGameStore((store) => store.selectedTile)
  const focusMapTile = useGameStore((store) => store.focusMapTile)
  const openHallEditor = useGameStore((store) => store.openHallEditor)
  const openHqOfficeEditor = useGameStore((store) => store.openHqOfficeEditor)
  const setPanel = useGameStore((store) => store.setPanel)

  const facilities = playerFacilities(state)
  const constructing = facilities.filter(
    (tile) => tile.buildingTarget > 0 && tile.buildingProgress < tile.buildingTarget,
  )
  const live = facilities.filter(
    (tile) => tile.buildingTarget <= 0 || tile.buildingProgress >= tile.buildingTarget,
  )
  const selectedKey = selected ? `${selected.x},${selected.y}` : null
  const active =
    facilities.find((tile) => `${tile.x},${tile.y}` === selectedKey) ?? live[0] ?? constructing[0] ?? null
  const staffLines = active ? facilityStaffLines(state, active) : []
  const racks = active ? facilityRackSummary(state, active) : null
  const editor = active ? facilityEditorAction(active) : null
  const building =
    active && active.buildingTarget > 0 && active.buildingProgress < active.buildingTarget

  const inspect = (x: number, y: number) => {
    focusMapTile(x, y)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="hud-eyebrow">Campus</p>
          <div className="mt-0.5 text-sm font-semibold text-bone">
            {live.length} live
            {constructing.length > 0 ? ` · ${constructing.length} building` : ''}
          </div>
        </div>
        <HudButton type="button" variant="ghost" onClick={() => setPanel('build')} className="shrink-0">
          Build
        </HudButton>
      </div>

      {facilities.length === 0 ? (
        <EmptyState
          title="No facilities yet"
          description="Place an HQ, hall, or lab on the map."
          action={
            <HudButton type="button" variant="primary" onClick={() => setPanel('build')}>
              Open Build
            </HudButton>
          }
        />
      ) : null}

      {constructing.map((tile) => {
        const progress = tile.buildingProgress / Math.max(1, tile.buildingTarget)
        const left = Math.max(0, tile.buildingTarget - tile.buildingProgress)
        const key = `${tile.x},${tile.y}`
        return (
          <button
            key={`build-${key}`}
            type="button"
            onClick={() => inspect(tile.x, tile.y)}
            className={`w-full rounded-lg border px-3 py-2 text-left ${
              selectedKey === key ? 'border-amber/50 bg-amber/10' : 'border-amber/25 bg-amber/5'
            }`}
          >
            <span className="flex items-center justify-between gap-2">
              <strong className="truncate text-[0.8125rem] text-bone">{tile.name || facilityTypeLabel(tile)}</strong>
              <StatusChip tone="warning">{left}d</StatusChip>
            </span>
            <div className="mt-1.5">
              <MeterBar value={progress} tone="train" live detail={`${Math.round(progress * 100)}%`} />
            </div>
          </button>
        )
      })}

      {live.map((tile) => {
        const key = `${tile.x},${tile.y}`
        const selectedRow = active?.x === tile.x && active?.y === tile.y
        const rackLine = facilityRackSummary(state, tile)
        return (
          <button
            key={key}
            type="button"
            onClick={() => inspect(tile.x, tile.y)}
            className={`w-full rounded-lg border px-3 py-2 text-left ${
              selectedRow ? 'border-mint/50 bg-mint/10' : 'border-line/70 bg-panel-2/70'
            }`}
          >
            <span className="flex items-center gap-2">
              <Buildings size="0.9rem" className="shrink-0 text-muted" aria-hidden />
              <strong className="min-w-0 truncate text-[0.8125rem] text-bone">
                {tile.name || facilityTypeLabel(tile)}
              </strong>
            </span>
            <p className="mt-0.5 font-mono text-[0.6875rem] tabular-nums text-muted">
              {facilityTypeLabel(tile)}
              {rackLine ? ` · ${rackLine}` : ''}
            </p>
          </button>
        )
      })}

      {active ? (
        <section className="space-y-2 rounded-lg border border-line/70 bg-void/35 px-3 py-2.5">
          <div>
            <p className="hud-eyebrow">Selected</p>
            <h3 className="mt-0.5 text-sm font-semibold text-bone">{active.name || facilityTypeLabel(active)}</h3>
          </div>
          <div className="space-y-1">
            <StatRow label="Type" value={facilityTypeLabel(active)} />
            {building ? (
              <StatRow
                label="Build"
                value={`${active.buildingProgress}/${active.buildingTarget}d`}
                tone="warning"
              />
            ) : null}
            {racks ? <StatRow label="Racks" value={racks} /> : null}
            {isDcKind(active.kind) && active.powered === false ? (
              <StatRow label="Power" value="Down" tone="danger" />
            ) : null}
            {active.mwGeneration > 0 ? <StatRow label="Generation" value={mw(active.mwGeneration)} /> : null}
            {active.mwCapacity > 0 ? <StatRow label="Grid tap" value={mw(active.mwCapacity)} /> : null}
            {active.opexPerDay > 0 ? (
              <StatRow
                label="Opex"
                value={`${money(active.opexPerDay * (ECONOMY.facilityOpexMultiplier ?? 1))}/d`}
              />
            ) : null}
            {staffLines.map((line) => (
              <StatRow key={line.label} label={line.label} value={line.value} />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1 pt-1">
            <HudButton type="button" variant="ghost" onClick={() => inspect(active.x, active.y)}>
              Map
            </HudButton>
            {editor ? (
              <HudButton
                type="button"
                variant="primary"
                onClick={() => {
                  const id = facilityIdForTile(active)
                  if (editor.kind === 'data-hall') openHallEditor(id)
                  else openHqOfficeEditor(id)
                }}
              >
                {editor.label}
              </HudButton>
            ) : (
              <HudButton type="button" variant="ghost" onClick={() => setPanel('map')}>
                Overview
              </HudButton>
            )}
          </div>
        </section>
      ) : null}
    </div>
  )
}

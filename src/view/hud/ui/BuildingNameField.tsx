import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import { buildingDisplayName, sanitizeBuildingName } from '../../../sim/systems/map'
import { useGameStore } from '../../../store/gameStore'
import { HudButton, HudInput } from './HudPrimitives'

type Props = {
  tile: {
    x: number
    y: number
    name?: string
    kind: string
    owner: string
    campusRole?: string
  }
  /** Visual density */
  compact?: boolean
  className?: string
}

/**
 * Inline rename for player-owned facilities (data halls, power, labs, …).
 * Multi-tile campuses rename via the anchor; pads share the campus name.
 */
export function BuildingNameField({ tile, compact, className = '' }: Props) {
  const renameBuilding = useGameStore((s) => s.renameBuilding)
  const isOurs = tile.owner === 'player'
  const display = buildingDisplayName(tile, tile.kind)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(display)

  useEffect(() => {
    if (!editing) setDraft(display)
  }, [display, editing, tile.x, tile.y])

  if (!isOurs) {
    return (
      <div className={`truncate font-medium text-bone ${compact ? 'text-sm' : 'text-sm'} ${className}`}>
        {display}
      </div>
    )
  }

  const commit = () => {
    const next = sanitizeBuildingName(draft)
    setEditing(false)
    if (!next || next === display) {
      setDraft(display)
      return
    }
    renameBuilding(tile.x, tile.y, next)
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    commit()
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(display)
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <form onSubmit={onSubmit} className={`flex min-h-12 w-full min-w-0 items-center gap-1 lg:h-9 lg:min-h-0 ${className}`}>
        <HudInput
          autoFocus
          value={draft}
          maxLength={40}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="h-12 min-w-0 flex-1 border-mint/40 bg-void px-2 py-1 text-sm font-medium text-bone outline-none ring-mint/30 focus:ring-1 lg:h-9 lg:min-h-0"
          aria-label="Building name"
        />
        <HudButton
          type="submit"
          variant="ghost"
          className="h-12 shrink-0 border-transparent px-2 py-1 text-[0.75rem] text-mint hover:bg-mint/10 lg:h-9 lg:min-h-0"
          onMouseDown={(e) => e.preventDefault()}
        >
          Save
        </HudButton>
      </form>
    )
  }

  return (
    <HudButton
      type="button"
      variant="ghost"
      title="Click to rename"
      onClick={(e) => {
        e.stopPropagation()
        setDraft(display)
        setEditing(true)
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={`group flex min-h-12 w-full min-w-0 items-center gap-1 overflow-hidden border-transparent px-2 text-left hover:bg-line/30 lg:h-9 lg:min-h-0 ${className}`}
    >
      <span className={`truncate font-medium text-bone ${compact ? 'text-sm' : 'text-sm'}`}>
        {display}
      </span>
      <span className="shrink-0 font-mono text-[0.6875rem] uppercase tracking-wide text-muted opacity-0 transition group-hover:opacity-100">
        rename
      </span>
    </HudButton>
  )
}

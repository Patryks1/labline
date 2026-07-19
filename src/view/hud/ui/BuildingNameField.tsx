import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import { buildingDisplayName, sanitizeBuildingName } from '../../../sim/systems/map'
import { useGameStore } from '../../../store/gameStore'

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
      <form onSubmit={onSubmit} className={`flex min-w-0 items-center gap-1 ${className}`}>
        <input
          autoFocus
          value={draft}
          maxLength={40}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 rounded-lg border border-mint/40 bg-void px-2 py-1 text-sm font-medium text-bone outline-none ring-mint/30 focus:ring-1"
          aria-label="Building name"
        />
        <button
          type="submit"
          className="shrink-0 rounded-md px-1.5 py-1 text-[0.75rem] text-mint hover:bg-mint/10"
          onMouseDown={(e) => e.preventDefault()}
        >
          Save
        </button>
      </form>
    )
  }

  return (
    <button
      type="button"
      title="Click to rename"
      onClick={(e) => {
        e.stopPropagation()
        setDraft(display)
        setEditing(true)
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={`group flex min-w-0 max-w-full items-center gap-1 rounded-md text-left hover:bg-line/30 ${className}`}
    >
      <span className={`truncate font-medium text-bone ${compact ? 'text-sm' : 'text-sm'}`}>
        {display}
      </span>
      <span className="shrink-0 font-mono text-[0.6875rem] uppercase tracking-wide text-muted opacity-0 transition group-hover:opacity-100">
        rename
      </span>
    </button>
  )
}

import { Funnel, MinusCircle } from '@phosphor-icons/react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { HudButton } from './HudPrimitives'

export interface HudFilterOption {
  id: string
  label: ReactNode
  active: boolean
  onSelect: () => void
  count?: ReactNode
  disabled?: boolean
  ariaLabel?: string
  title?: string
}

export interface HudFilterGroup {
  id: string
  label: string
  options: readonly HudFilterOption[]
  description?: string
}

/**
 * Shared filter surface for dense HUD panels.
 *
 * Groups stay visible on desktop, while narrow layouts expose one compact
 * disclosure control. Options keep button semantics so filter state remains
 * keyboard and screen-reader addressable without adding nested tab patterns.
 */
export function HudFilterBar({
  groups,
  ariaLabel = 'Filters',
  activeCount,
  onClear,
  clearLabel = 'Clear filters',
  compactLabel = 'Filters',
  className = '',
}: {
  groups: readonly HudFilterGroup[]
  ariaLabel?: string
  /** Count only filters that differ from the default view. */
  activeCount?: number
  onClear?: () => void
  clearLabel?: string
  compactLabel?: string
  className?: string
}) {
  const contentId = `hud-filter-content-${useId().replace(/:/g, '')}`
  const [expanded, setExpanded] = useState(true)
  const selectedCount = groups.reduce(
    (total, group) => total + group.options.filter((option) => option.active).length,
    0,
  )
  const resolvedActiveCount = activeCount ?? selectedCount

  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)')
    const sync = () => setExpanded(!media.matches)
    sync()
    media.addEventListener?.('change', sync)
    return () => media.removeEventListener?.('change', sync)
  }, [])

  return (
    <section
      className={`hud-filter-bar ${className}`}
      aria-label={ariaLabel}
      data-expanded={expanded ? 'true' : 'false'}
    >
      <header className="hud-filter-bar__header">
        <div className="hud-filter-bar__summary">
          <Funnel size="0.9rem" weight="duotone" aria-hidden="true" />
          <span>{compactLabel}</span>
          <span className="hud-filter-bar__count" aria-live="polite">
            {resolvedActiveCount > 0 ? `${resolvedActiveCount} active` : 'All'}
          </span>
        </div>
        <div className="hud-filter-bar__actions">
          <button
            type="button"
            className="hud-filter-bar__toggle"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Hide filters' : 'Show filters'}
          </button>
          {onClear && resolvedActiveCount > 0 ? (
            <HudButton
              type="button"
              variant="ghost"
              className="hud-filter-bar__clear"
              aria-label={clearLabel}
              title={clearLabel}
              onClick={onClear}
            >
              <MinusCircle size="0.8rem" aria-hidden="true" />
              <span>Clear</span>
            </HudButton>
          ) : null}
        </div>
      </header>

      <div id={contentId} className="hud-filter-bar__body">
        {groups.map((group) => (
          <fieldset key={group.id} className="hud-filter-bar__group">
            <legend className="hud-filter-bar__legend">
              <span>{group.label}</span>
              {group.description ? (
                <span className="hud-filter-bar__description">{group.description}</span>
              ) : null}
            </legend>
            <div className="hud-filter-bar__options" role="group" aria-label={`${group.label} filters`}>
              {group.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-label={option.ariaLabel}
                  aria-pressed={option.active}
                  aria-disabled={option.disabled || undefined}
                  disabled={option.disabled}
                  title={option.title}
                  data-filter-option={option.id}
                  data-filter-active={option.active ? 'true' : 'false'}
                  onClick={option.onSelect}
                  className={`hud-filter-bar__option min-h-11 sm:min-h-8 ${option.active ? 'is-active' : ''}`}
                >
                  <span className="hud-filter-bar__option-label">{option.label}</span>
                  {option.count != null ? (
                    <span className="hud-filter-bar__option-count">{option.count}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </section>
  )
}

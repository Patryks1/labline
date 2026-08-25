import { CaretRight } from '@phosphor-icons/react'
import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'

export type HudTone =
  | 'neutral'
  | 'positive'
  | 'warning'
  | 'danger'
  | 'serve'
  | 'research'
  | 'train'
  | 'gold'

export type HudMeterTone = Exclude<HudTone, 'neutral' | 'gold'>

export type HudButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function PanelScaffold({
  title,
  eyebrow,
  description,
  actions,
  className,
  children,
}: {
  title: string
  eyebrow?: string
  description?: string
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section className={`hud-section${className ? ` ${className}` : ''}`}>
      <header className="hud-section__header">
        <div className="min-w-0">
          {eyebrow ? <p className="hud-eyebrow">{eyebrow}</p> : null}
          <h2 className="hud-title">{title}</h2>
          {description ? <p className="hud-description">{description}</p> : null}
        </div>
        {actions ? <div className="hud-section__actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

export function MetricTile({
  label,
  value,
  detail,
  tone = 'neutral',
  title,
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  tone?: HudTone
  title?: string
}) {
  return (
    <div className={`metric-tile metric-tile--${tone}`} title={title}>
      <span className="metric-tile__label">{label}</span>
      <strong className="metric-tile__value">{value}</strong>
      {detail ? <span className="metric-tile__detail">{detail}</span> : null}
    </div>
  )
}

export function StatusChip({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode
  tone?: HudTone
  title?: string
}) {
  return (
    <span className={`status-chip status-chip--${tone}`} title={title}>
      {children}
    </span>
  )
}

function clampMeterValue(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

export function HudMeter({
  value,
  tone = 'positive',
  label,
  detail,
  live = false,
  ariaLabel,
}: {
  value: number
  tone?: HudMeterTone
  label?: ReactNode
  detail?: ReactNode
  live?: boolean
  ariaLabel?: string
}) {
  const clamped = clampMeterValue(value)
  const labelId = useId()
  const hasNonTextLabel = label != null && typeof label !== 'string' && typeof label !== 'number'
  return (
    <div className="hud-meter min-w-0">
      {label != null || detail != null ? (
        <div className="mb-1 flex items-baseline justify-between gap-2 text-[0.6875rem]">
          <span id={hasNonTextLabel ? labelId : undefined} className="min-w-0 truncate text-muted">
            {label}
          </span>
          <span className="shrink-0 font-mono tabular-nums text-bone">{detail}</span>
        </div>
      ) : null}
      <div
        className="hud-progress"
        role="progressbar"
        aria-label={hasNonTextLabel ? undefined : ariaLabel ?? (typeof label === 'string' || typeof label === 'number' ? String(label) : 'Progress')}
        aria-labelledby={hasNonTextLabel ? labelId : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped * 100}
        aria-valuetext={typeof detail === 'string' || typeof detail === 'number' ? String(detail) : undefined}
      >
        <span
          className={`hud-progress__fill hud-progress__fill--${tone} ${live ? 'meter-live' : ''}`}
          style={{ width: `${clamped * 100}%` }}
        />
      </div>
    </div>
  )
}

/** Compatibility wrapper for existing progress-bar consumers. Values remain 0..1. */
export function ProgressBar({
  value,
  tone = 'positive',
  label,
}: {
  value: number
  tone?: HudMeterTone
  label?: string
}) {
  return <HudMeter value={value} tone={tone} ariaLabel={label} />
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <span className="empty-state__marker" aria-hidden />
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  )
}

export function HudState({
  kind = 'empty',
  title,
  description,
  action,
}: {
  kind?: 'loading' | 'empty' | 'error'
  title: string
  description?: string
  action?: ReactNode
}) {
  const isError = kind === 'error'
  return (
    <div className={`hud-state hud-state--${kind}`} role={isError ? 'alert' : undefined}>
      <div>
        <h3 className="hud-state__title">{title}</h3>
        {description ? <p className="hud-state__description">{description}</p> : null}
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  )
}

export function HudInput({
  className = '',
  invalid,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const ariaInvalid = invalid !== undefined ? invalid : props['aria-invalid']
  return <input {...props} aria-invalid={ariaInvalid} className={`hud-input ${className}`} />
}

export function HudSelect({
  className = '',
  invalid,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  const ariaInvalid = invalid !== undefined ? invalid : props['aria-invalid']
  return <select {...props} aria-invalid={ariaInvalid} className={`hud-select ${className}`} />
}

export function HudRange({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} type="range" className={`hud-range ${className}`} />
}

export function HudButton({
  variant = 'secondary',
  className = '',
  type = 'button',
  title,
  disabledReason,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: HudButtonVariant
  disabledReason?: string
}) {
  return (
    <button
      {...props}
      type={type}
      title={title ?? disabledReason}
      data-hud-variant={variant}
      data-destructive={variant === 'danger' ? 'true' : undefined}
      className={`hud-button hud-button--${variant} ${className}`}
    />
  )
}

/** Shared compact collapse affordance for floating HUD surfaces. */
export const HudCloseButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> & { label: string }
>(function HudCloseButton({ label, className = '', ...props }, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={`hud-button hud-button--ghost hud-close-button ${className}`}
    >
      <CaretRight aria-hidden="true" size="0.9rem" weight="bold" />
    </button>
  )
})

import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function PanelScaffold({
  title,
  eyebrow,
  description,
  actions,
  children,
}: {
  title: string
  eyebrow?: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="hud-section">
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
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  tone?: 'neutral' | 'positive' | 'warning' | 'danger' | 'serve' | 'research'
}) {
  return (
    <div className={`metric-tile metric-tile--${tone}`}>
      <span className="metric-tile__label">{label}</span>
      <strong className="metric-tile__value">{value}</strong>
      {detail ? <span className="metric-tile__detail">{detail}</span> : null}
    </div>
  )
}

export function StatusChip({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'positive' | 'warning' | 'danger' | 'serve' | 'research'
}) {
  return <span className={`status-chip status-chip--${tone}`}>{children}</span>
}

export function ProgressBar({
  value,
  tone = 'positive',
  label,
}: {
  value: number
  tone?: 'positive' | 'warning' | 'danger' | 'serve' | 'research'
  label?: string
}) {
  const clamped = Math.max(0, Math.min(1, value))
  return (
    <div className="hud-progress" aria-label={label} role="progressbar" aria-valuenow={clamped * 100}>
      <span className={`hud-progress__fill hud-progress__fill--${tone}`} style={{ width: `${clamped * 100}%` }} />
    </div>
  )
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

export function HudButton({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
}) {
  return <button {...props} className={`hud-button hud-button--${variant} ${className}`} />
}

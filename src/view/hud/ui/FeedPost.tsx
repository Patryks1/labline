/* eslint-disable react/only-export-components -- shared FeedTone/FeedPostProps used by menu + dock */
/* oxlint-disable react(only-export-components) -- shared feed types live beside FeedPost */
import type { ReactNode } from 'react'
import { ChatCircle, CheckCircle, Heart, Repeat } from '@phosphor-icons/react'
import { StatusChip } from './HudPrimitives'

export type FeedTone = 'neutral' | 'positive' | 'warning' | 'danger' | 'serve' | 'research'

export interface FeedPostProps {
  source: string
  dayLabel?: string
  timeLabel?: string
  body: ReactNode
  tone?: FeedTone
  pinned?: boolean
  mark?: ReactNode
  footer?: ReactNode
  className?: string
  handle?: string
  verified?: boolean
}

const TONE_BORDER: Record<FeedTone, string> = {
  neutral: 'border-line/70 bg-panel-2/70',
  positive: 'border-mint/35 bg-mint/8',
  warning: 'border-amber/35 bg-amber/8',
  danger: 'border-danger/35 bg-danger/8',
  serve: 'border-infer/35 bg-infer/8',
  research: 'border-research/35 bg-research/8',
}

const TONE_CHIP: Record<FeedTone, 'neutral' | 'positive' | 'warning' | 'danger' | 'serve' | 'research'> = {
  neutral: 'neutral',
  positive: 'positive',
  warning: 'warning',
  danger: 'danger',
  serve: 'serve',
  research: 'research',
}

/** Shared Twitter-style post used by main-menu News and in-game World feed. */
export function FeedPost({
  source,
  dayLabel,
  timeLabel,
  body,
  tone = 'neutral',
  pinned = false,
  mark,
  footer,
  className = '',
  handle,
  verified = false,
}: FeedPostProps) {
  const initial = source.trim().slice(0, 1).toUpperCase() || '·'
  return (
    <article
      className={`rounded-lg border px-3 py-2.5 transition hover:bg-void/25 ${TONE_BORDER[tone]} ${
        pinned ? 'ring-1 ring-amber/30' : ''
      } ${className}`}
    >
      <div className="flex items-start gap-2.5">
        <div
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-full border border-line/70 bg-void/55 font-mono text-[0.75rem] font-semibold text-mint"
        >
          {mark ?? initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <strong className="truncate text-[0.8125rem] text-bone">{source}</strong>
            {verified ? <CheckCircle aria-label="Verified" weight="fill" className="shrink-0 text-infer" size={14} /> : null}
            {handle ? <span className="truncate text-[0.6875rem] text-muted">@{handle}</span> : null}
            {dayLabel ? (
              <span className="font-mono text-[0.6875rem] tabular-nums text-muted">{dayLabel}</span>
            ) : null}
            {timeLabel ? (
              <span className="font-mono text-[0.6875rem] tabular-nums text-muted/80">{timeLabel}</span>
            ) : null}
            {pinned ? <StatusChip tone="warning">Live</StatusChip> : null}
            {tone !== 'neutral' ? <StatusChip tone={TONE_CHIP[tone]}>{tone}</StatusChip> : null}
          </div>
          <div className="mt-1 text-[0.8125rem] leading-snug text-bone">{body}</div>
          {handle ? (
            <div className="mt-2 flex max-w-[13rem] items-center justify-between text-muted" aria-hidden="true">
              <span className="flex items-center gap-1"><ChatCircle size={13} /></span>
              <span className="flex items-center gap-1"><Repeat size={13} /></span>
              <span className="flex items-center gap-1"><Heart size={13} /></span>
            </div>
          ) : null}
          {footer ? <div className="mt-2">{footer}</div> : null}
        </div>
      </div>
    </article>
  )
}

export function classifyFeedLine(line: string): {
  kind: 'rival' | 'bench' | 'you' | 'world' | 'ops' | 'changelog'
  label: string
  tone: FeedTone
} {
  const l = line.toLowerCase()
  if (l.includes('changelog') || l.includes('update') || l.includes('patch')) {
    return { kind: 'changelog', label: 'Changelog', tone: 'research' }
  }
  if (
    l.includes('overtakes') ||
    l.includes('leaderboard') ||
    l.includes('tops the board') ||
    l.includes('edges') ||
    l.includes('reclaiming')
  ) {
    return { kind: 'bench', label: 'Evals', tone: 'warning' }
  }
  if (l.includes('ships') || l.includes('releases') || l.includes('dropped') || l.includes('publishes')) {
    return { kind: 'rival', label: 'Rival', tone: 'serve' }
  }
  if (l.includes('unlocked') || l.includes('released') || l.includes('benchmark day')) {
    return { kind: 'you', label: 'You', tone: 'positive' }
  }
  if (l.includes('complain') || l.includes('capacity') || l.includes('throttle') || l.includes('timeout')) {
    return { kind: 'ops', label: 'Ops', tone: 'danger' }
  }
  return { kind: 'world', label: 'World', tone: 'neutral' }
}

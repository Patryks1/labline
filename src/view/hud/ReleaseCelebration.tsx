import { useEffect, useMemo } from 'react'
import { RocketLaunch, X } from '@phosphor-icons/react'
import { useUiStore } from '../../store/uiStore'

const PARTICLE_COLORS = ['var(--color-gold)', 'var(--color-mint)', 'var(--color-bone)', 'var(--color-infer)']
const AUTO_DISMISS_MS = 5200

/**
 * Global model-release celebration. Panels announce via
 * useUiStore.getState().announceRelease({ name, capability }).
 */
export function ReleaseCelebration() {
  const event = useUiStore((s) => s.releaseEvent)
  const clear = useUiStore((s) => s.clearRelease)

  useEffect(() => {
    if (!event) return
    const id = window.setTimeout(clear, AUTO_DISMISS_MS)
    return () => window.clearTimeout(id)
  }, [event, clear])

  const particles = useMemo(() => {
    if (!event) return []
    // Deterministic per event id so re-renders don't reshuffle.
    return Array.from({ length: 26 }, (_, i) => {
      const angle = (i / 26) * Math.PI * 2
      const distance = 90 + ((event.id + i * 37) % 70)
      return {
        px: `${Math.cos(angle) * distance}px`,
        py: `${Math.sin(angle) * distance * 0.72 - 30}px`,
        pr: `${((i * 53) % 240) - 120}deg`,
        color: PARTICLE_COLORS[i % PARTICLE_COLORS.length]!,
        delay: `${(i % 6) * 45}ms`,
      }
    })
  }, [event])

  if (!event) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center"
    >
      <div className="absolute inset-0 bg-void/55 backdrop-blur-[2px]" />

      {/* Expanding rings */}
      <span aria-hidden className="release-burst__ring h-40 w-40" />
      <span aria-hidden className="release-burst__ring h-40 w-40" style={{ animationDelay: '140ms' }} />
      <span aria-hidden className="release-burst__ring h-40 w-40" style={{ animationDelay: '280ms' }} />

      {/* Particles */}
      {particles.map((p, i) => (
        <span
          key={i}
          aria-hidden
          className="release-particle"
          style={{
            background: p.color,
            animationDelay: p.delay,
            ['--px' as string]: p.px,
            ['--py' as string]: p.py,
            ['--pr' as string]: p.pr,
          }}
        />
      ))}

      <div className="release-card pointer-events-auto relative w-[min(22rem,90vw)] overflow-hidden rounded-lg border border-gold/50 bg-panel p-5 text-center shadow-[0_24px_80px_rgba(2,12,17,0.7)]">
        <div aria-hidden className="release-card__shine" />
        <button
          type="button"
          aria-label="Dismiss"
          onClick={clear}
          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-bone"
        >
          <X size="0.9rem" />
        </button>
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-gold/60 bg-gold/15 text-gold">
          <RocketLaunch size="1.5rem" weight="fill" />
        </div>
        <p className="hud-eyebrow mt-3 text-gold">Model released</p>
        <h2 className="mt-1 text-xl font-semibold text-bone">{event.name}</h2>
        <p className="mt-1 font-mono text-[0.8125rem] tabular-nums text-muted">
          Capability {event.capability.toFixed(1)} · now serving production traffic
        </p>
        <button
          type="button"
          onClick={clear}
          className="btn-primary mt-4 w-full"
        >
          Ship it
        </button>
      </div>
    </div>
  )
}

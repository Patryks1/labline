import { LodTier, type EntityId } from './types'

export const LOD_THRESHOLDS = {
  // Begin loading the full-detail tier before the camera reaches
  // the unequivocal close-up band (28px/tile). This gives the prefetch ring a
  // full zoom interval to become resident instead of forcing a late swap.
  enterNear: 22,
  leaveNear: 19,
  // At the widest supported overview a tile is only ~15px tall. Enter the
  // complete silhouette tier there so dense metros do not retain a million
  // mid-tier triangles. The two-pixel hysteresis keeps ordinary zoom motion
  // from bouncing tiers, and this remains well below the near-art boundary.
  enterFar: 16,
  leaveFar: 18,
} as const

export interface LodLayer {
  tier: LodTier
  /** Transition weight. The production renderer uses complete layers only. */
  coverage: number
}

export interface LodSnapshot {
  active: LodTier
  desired: LodTier
  transitioning: boolean
  layers: readonly LodLayer[]
}

interface Transition {
  from: LodTier
  to: LodTier
  startedAtMs: number
}

/**
 * Screen-space LOD for an orthographic isometric view. All visible tiles share
 * one tier, avoiding radial seams and making the result independent of camera
 * travel direction once a threshold has decisively been crossed.
 */
export class ScreenSpaceLod {
  readonly transitionMs: number

  private activeTier: LodTier
  private desiredTier: LodTier
  private transition: Transition | null = null

  constructor(initial: LodTier = LodTier.mid, transitionMs = 0) {
    this.activeTier = initial
    this.desiredTier = initial
    this.transitionMs = Math.max(0, transitionMs)
  }

  get active(): LodTier {
    return this.activeTier
  }

  get desired(): LodTier {
    return this.desiredTier
  }

  /**
   * Advance desired/active state. A tier is never activated until every
   * currently visible chunk reports it ready.
   */
  update(
    pixelsPerTile: number,
    nowMs: number,
    isReady: (tier: LodTier) => boolean,
  ): LodSnapshot {
    this.finishTransition(nowMs)
    const desired = selectLodTier(pixelsPerTile, this.desiredTier)

    if (desired !== this.desiredTier) {
      this.desiredTier = desired
      if (this.transition && this.transition.to !== desired) {
        if (desired === this.transition.from) {
          // Reverse in place without changing either layer's current coverage.
          // If A→B is 40% complete, B→A starts 60% complete: B remains at
          // 40% and A at 60% on the reversal frame, then continues smoothly.
          const previous = this.transition
          const reversedProgress = 1 - this.transitionProgress(nowMs)
          this.activeTier = previous.to
          this.transition = {
            from: previous.to,
            to: previous.from,
            startedAtMs: nowMs - reversedProgress * this.transitionMs,
          }
        }
        // A jump toward a third tier finishes the already-visible transition
        // first; the next transition begins from a complete representation.
      }
    }

    if (!this.transition && this.desiredTier !== this.activeTier && isReady(this.desiredTier)) {
      if (this.transitionMs === 0) {
        this.activeTier = this.desiredTier
      } else {
        this.transition = {
          from: this.activeTier,
          to: this.desiredTier,
          startedAtMs: nowMs,
        }
      }
    }

    this.finishTransition(nowMs)
    return this.snapshot(nowMs, pixelsPerTile)
  }

  snapshot(nowMs: number, pixelsPerTile = 16): LodSnapshot {
    const layers = this.layers(nowMs, pixelsPerTile)
    return {
      active: this.activeTier,
      desired: this.desiredTier,
      transitioning: this.transition !== null,
      layers,
    }
  }

  /**
   * At an unequivocal close-up, never expose a persistent mid/far placeholder.
   * If near data missed prefetch, the surface remains visible while props wait.
   */
  layers(nowMs: number, _pixelsPerTile: number): readonly LodLayer[] {
    if (!this.transition) {
      // Never return an empty representation. If the desired tier is not
      // ready, the last complete tier remains visible until it is. The terrain
      // surface is independent, but props must obey the same continuity rule.
      return [{ tier: this.activeTier, coverage: 1 }]
    }

    const progress = this.transitionProgress(nowMs)
    if (progress >= 1) return [{ tier: this.transition.to, coverage: 1 }]
    return [
      { tier: this.transition.from, coverage: 1 - progress },
      { tier: this.transition.to, coverage: progress },
    ]
  }

  private transitionProgress(nowMs: number): number {
    if (!this.transition || this.transitionMs === 0) return 1
    return Math.max(0, Math.min(1, (nowMs - this.transition.startedAtMs) / this.transitionMs))
  }

  private finishTransition(nowMs: number): void {
    if (!this.transition || this.transitionProgress(nowMs) < 1) return
    this.activeTier = this.transition.to
    this.transition = null
  }
}

export function selectLodTier(pixelsPerTile: number, previous: LodTier): LodTier {
  const pixels = Math.max(0, pixelsPerTile)
  if (previous === LodTier.near) {
    if (pixels < LOD_THRESHOLDS.leaveNear) {
      return pixels <= LOD_THRESHOLDS.enterFar ? LodTier.far : LodTier.mid
    }
    return LodTier.near
  }
  if (previous === LodTier.far) {
    if (pixels > LOD_THRESHOLDS.leaveFar) {
      return pixels >= LOD_THRESHOLDS.enterNear ? LodTier.near : LodTier.mid
    }
    return LodTier.far
  }
  if (pixels >= LOD_THRESHOLDS.enterNear) return LodTier.near
  if (pixels <= LOD_THRESHOLDS.enterFar) return LodTier.far
  return LodTier.mid
}

/** Include tier and source revision so zoom direction cannot reuse stale kits. */
export function lodRenderKey(entityId: EntityId, tier: LodTier, revision: number): string {
  return `${entityId}:${tier}:${revision}`
}

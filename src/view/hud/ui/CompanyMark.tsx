import {
  normalizeCompanyLogoSpec,
  type CompanyLogoInk,
  type CompanyLogoSpec,
  type CompanyMarkId,
} from '../../../sim/balance/gameConfig'

type Point = [number, number]

const FILL = { fill: 'currentColor' }
const RING = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

/**
 * Deterministic company marks built from filled silhouettes, counters, and a
 * small number of motif variants. Geometry stays SVG-native so identity
 * survives scaling, recolouring, and save/load.
 */
export function CompanyMark({
  mark,
  logo,
  className = 'size-7',
}: {
  mark: CompanyMarkId
  logo?: CompanyLogoSpec
  className?: string
}) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      {logo ? renderProceduralMark(mark, logo) : renderMark(mark)}
    </svg>
  )
}

export function companyLogoInk(logo?: CompanyLogoSpec): CompanyLogoInk {
  return logo?.ink === 'black' ? 'black' : 'white'
}

/** Contrasting plate so black and white marks stay readable in HUD chrome. */
export function CompanyMarkBadge({
  mark,
  logo,
  className = '',
  markClassName = 'size-7',
}: {
  mark: CompanyMarkId
  logo?: CompanyLogoSpec
  className?: string
  markClassName?: string
}) {
  const spec = logo ? normalizeCompanyLogoSpec(logo, mark) : undefined
  const ink = spec?.ink ?? 'white'
  return (
    <span data-logo-ink={ink} aria-hidden="true" className={`company-mark-badge company-mark-badge--${ink} ${className}`.trim()}>
      <CompanyMark mark={mark} logo={logo} className={markClassName} />
    </span>
  )
}

function seededUnit(seed: number, index: number): number {
  const value = Math.sin(seed * 12.9898 + index * 78.233) * 43_758.5453
  return value - Math.floor(value)
}

function variantIndex(seed: number, lanes: number): number {
  return Math.min(lanes - 1, Math.floor(seededUnit(seed, 5) * lanes))
}

function polarPoint(radius: number, degrees: number): Point {
  const angle = (degrees * Math.PI) / 180
  return [16 + Math.cos(angle) * radius, 16 + Math.sin(angle) * radius]
}

function fmt(value: number): string {
  return value.toFixed(2)
}

function closePath(points: Point[]): string {
  return `M${points.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join('L')}Z`
}

function circlePath(cx: number, cy: number, radius: number): string {
  return `M${fmt(cx - radius)} ${fmt(cy)}a${fmt(radius)} ${fmt(radius)} 0 1 0 ${fmt(radius * 2)} 0a${fmt(radius)} ${fmt(radius)} 0 1 0 ${fmt(-radius * 2)} 0`
}

function polygonPoints(count: number, radius: number, rotation: number, alternate = 1): Point[] {
  const total = alternate === 1 ? count : count * 2
  const points: Point[] = []
  for (let index = 0; index < total; index += 1) {
    const pointRadius = index % 2 === 0 ? radius : radius * alternate
    points.push(polarPoint(pointRadius, rotation + (360 / total) * index))
  }
  return points
}

function chevronPath(width: number, height: number, thickness: number, cy = 16): string {
  const top = cy - height
  const bottom = cy + height * 0.55
  return closePath([
    [16, top],
    [16 + width, bottom],
    [16 + width - thickness, bottom],
    [16, top + thickness * 1.55],
    [16 - width + thickness, bottom],
    [16 - width, bottom],
  ])
}

function renderProceduralMark(mark: CompanyMarkId, input: CompanyLogoSpec) {
  const spec = normalizeCompanyLogoSpec(input, mark)
  const scale = 0.74 + spec.spread * 0.3
  const variant = variantIndex(spec.seed, 3)
  return (
    <g transform={`translate(16 16) rotate(${spec.rotation}) scale(${scale}) translate(-16 -16)`}>
      {renderMotif(mark, spec, variant)}
    </g>
  )
}

function renderMotif(mark: CompanyMarkId, spec: CompanyLogoSpec, variant: number) {
  switch (mark) {
    case 'orbit':
      return renderOrbit(spec, variant)
    case 'delta':
      return renderDelta(spec, variant)
    case 'prism':
      return renderPrism(spec, variant)
    case 'hex':
      return renderHex(spec, variant)
    case 'spire':
      return renderSpire(spec, variant)
    case 'grid':
      return renderGrid(spec, variant)
    case 'nexus':
      return renderNexus(spec, variant)
    case 'wave':
      return renderWave(spec, variant)
    case 'core':
      return renderCore(spec, variant)
    default:
      return renderCore(spec, variant)
  }
}

function renderOrbit(spec: CompanyLogoSpec, variant: number) {
  const discCount = Math.max(2, Math.min(4, 1 + Math.ceil(spec.complexity / 2)))
  const radius = variant === 2 ? 5.4 : 6.4
  const offset = 3.1 + (spec.symmetry - 3) * 0.22
  const discs = Array.from({ length: discCount }, (_, index) => {
    const angle = -90 + index * (360 / discCount)
    const [cx, cy] = polarPoint(offset, angle)
    return <circle key={`disc-${index}`} {...FILL} cx={cx} cy={cy} r={radius - index * 0.35} />
  })
  return (
    <>
      {discs}
      {spec.complexity >= 3 ? (
        <ellipse {...RING} strokeWidth={variant === 1 ? 1.9 : 1.45} cx="16" cy="16" rx={11.4} ry={variant === 1 ? 4.6 : 5.8} />
      ) : null}
      {spec.complexity >= 5 ? <circle {...FILL} cx="16" cy="16" r="2.1" /> : null}
    </>
  )
}

function renderDelta(spec: CompanyLogoSpec, variant: number) {
  const outer = polygonPoints(3, 11.4, -90)
  const innerScale = spec.complexity >= 2 ? 0.42 + spec.complexity * 0.03 : 0
  const inner = innerScale ? polygonPoints(3, 11.4 * innerScale, -90) : null
  if (variant === 1) {
    return (
      <path
        {...FILL}
        fillRule="evenodd"
        d={`${circlePath(16, 16, 11.6)}${closePath(polygonPoints(3, 6.4, -90))}`}
      />
    )
  }
  if (variant === 2) {
    const layers = Math.min(3, spec.complexity)
    return (
      <>
        {Array.from({ length: layers }, (_, index) => (
          <path key={`chevron-${index}`} {...FILL} d={chevronPath(10.4 - index * 1.4, 7.2 - index * 1.1, 2.4)} transform={`translate(0 ${index * 3.1 - (layers - 1) * 1.4})`} />
        ))}
      </>
    )
  }
  return (
    <path
      {...FILL}
      fillRule={inner ? 'evenodd' : 'nonzero'}
      d={inner ? `${closePath(outer)}${closePath(inner)}` : closePath(outer)}
    />
  )
}

function renderPrism(spec: CompanyLogoSpec, variant: number) {
  const outer = polygonPoints(4, 11.2, 45)
  if (variant === 1) {
    return (
      <path
        {...FILL}
        fillRule="evenodd"
        d={`${closePath(polygonPoints(4, 11.4, 0))}${closePath(polygonPoints(4, 11.4, 45))}`}
      />
    )
  }
  if (variant === 2) {
    const left = closePath([[16, 4.4], [10.2, 16], [16, 27.6], [13.2, 16]])
    const right = closePath([[16, 4.4], [18.8, 16], [16, 27.6], [21.8, 16]])
    return (
      <>
        <path {...FILL} d={left} />
        <path {...FILL} d={right} opacity={0.72} />
      </>
    )
  }
  const inner = polygonPoints(4, 11.2 * (0.38 + spec.complexity * 0.02), 45)
  return <path {...FILL} fillRule="evenodd" d={`${closePath(outer)}${closePath(inner)}`} />
}

function renderHex(spec: CompanyLogoSpec, variant: number) {
  const sides = spec.symmetry >= 8 ? 8 : 6
  const outer = polygonPoints(sides, 11.3, -90)
  if (variant === 1) {
    return (
      <path
        {...FILL}
        fillRule="evenodd"
        d={`${closePath(outer)}${closePath(polygonPoints(3, 5.6, -90))}`}
      />
    )
  }
  if (variant === 2) {
    return (
      <path
        {...FILL}
        fillRule="evenodd"
        d={`${closePath(outer)}${closePath(polygonPoints(sides, 5.2, -90))}`}
      />
    )
  }
  const inner = polygonPoints(sides, 11.3 * (0.46 + spec.complexity * 0.02), -90)
  return <path {...FILL} fillRule="evenodd" d={`${closePath(outer)}${closePath(inner)}`} />
}

function renderSpire(spec: CompanyLogoSpec, variant: number) {
  if (variant === 1) {
    const star = polygonPoints(4, 11.6, -90, 0.38)
    const cut = spec.complexity >= 3 ? polygonPoints(4, 4.2, -90) : null
    return <path {...FILL} fillRule={cut ? 'evenodd' : 'nonzero'} d={cut ? `${closePath(star)}${closePath(cut)}` : closePath(star)} />
  }
  if (variant === 2) {
    return <path {...FILL} d={closePath([[16, 3.6], [24.4, 28.2], [16, 21.4], [7.6, 28.2]])} />
  }
  const layers = Math.min(3, spec.complexity)
  return (
    <>
      {Array.from({ length: layers }, (_, index) => (
        <path
          key={`spire-${index}`}
          {...FILL}
          d={chevronPath(10.8 - index * 1.2, 6.8, 2.35 + spec.complexity * 0.12)}
          transform={`translate(0 ${index * 3.4 - 2.2})`}
        />
      ))}
    </>
  )
}

function renderGrid(spec: CompanyLogoSpec, variant: number) {
  const cells = spec.complexity >= 4 || variant === 2 ? 3 : 2
  const gap = cells === 3 ? 0.9 : 1.25
  const size = cells === 3 ? 5.6 : 8.2
  const start = 16 - (cells * size + (cells - 1) * gap) / 2
  const missing = Math.floor(seededUnit(spec.seed, 11) * (cells * cells))
  const offsetCell = Math.floor(seededUnit(spec.seed, 13) * (cells * cells))
  return (
    <>
      {Array.from({ length: cells * cells }, (_, index) => {
        if (variant === 1 && index === missing) return null
        if (variant === 2 && cells === 3) {
          const row = Math.floor(index / 3)
          const col = index % 3
          if (!((row === 1) || (col === 1))) return null
        }
        const col = index % cells
        const row = Math.floor(index / cells)
        const nudge = variant === 0 && index === offsetCell ? 1.15 : 0
        return (
          <rect
            key={`cell-${index}`}
            {...FILL}
            x={start + col * (size + gap) + nudge}
            y={start + row * (size + gap) - nudge * 0.4}
            width={size}
            height={size}
            rx={1.35}
          />
        )
      })}
    </>
  )
}

function renderNexus(spec: CompanyLogoSpec, variant: number) {
  const nodes = Math.max(3, Math.min(6, spec.symmetry >= 7 ? 5 : 3))
  const radius = 7.4
  const nodeR = variant === 2 ? 3.8 : 3.15
  if (variant === 1) {
    return (
      <>
        <path {...FILL} fillRule="evenodd" d={`${circlePath(16, 16, 11.4)}${circlePath(16, 16, 5.1)}`} />
        {Array.from({ length: nodes }, (_, index) => {
          const [cx, cy] = polarPoint(11.4, -90 + index * (360 / nodes))
          return <circle key={`bead-${index}`} {...FILL} cx={cx} cy={cy} r={2.15} />
        })}
      </>
    )
  }
  const points = Array.from({ length: nodes }, (_, index) => polarPoint(radius, -90 + index * (360 / nodes)))
  return (
    <>
      {points.map((from, index) => {
        const to = points[(index + 1) % points.length]
        if (!to || (variant === 2 && index === nodes - 1)) return null
        return (
          <path
            key={`bar-${index}`}
            {...RING}
            strokeWidth={2.6}
            d={`M${fmt(from[0])} ${fmt(from[1])}L${fmt(to[0])} ${fmt(to[1])}`}
          />
        )
      })}
      {points.map(([cx, cy], index) => (
        <circle key={`node-${index}`} {...FILL} cx={cx} cy={cy} r={nodeR - index * 0.12} />
      ))}
      {spec.complexity >= 4 ? <circle {...FILL} cx="16" cy="16" r="2.4" /> : null}
    </>
  )
}

function renderWave(spec: CompanyLogoSpec, variant: number) {
  const layers = Math.min(3, spec.complexity)
  if (variant === 2) {
    const bars = Math.max(3, Math.min(6, spec.symmetry - 2))
    const width = 18 / bars
    return (
      <>
        {Array.from({ length: bars }, (_, index) => {
          const height = 6 + seededUnit(spec.seed, 20 + index) * 10
          const x = 7 + index * width
          return <rect key={`bar-${index}`} {...FILL} x={x} y={16 - height / 2} width={width * 0.62} height={height} rx={1.1} />
        })}
      </>
    )
  }
  const wave = (y: number, amplitude: number) => {
    const left = 4.2
    const right = 27.8
    const mid = 16
    return `M${fmt(left)} ${fmt(y)} C${fmt(mid - 4)} ${fmt(y - amplitude)} ${fmt(mid + 4)} ${fmt(y + amplitude)} ${fmt(right)} ${fmt(y)} L${fmt(right)} ${fmt(y + 4.6)} C${fmt(mid + 4)} ${fmt(y + 4.6 + amplitude)} ${fmt(mid - 4)} ${fmt(y + 4.6 - amplitude)} ${fmt(left)} ${fmt(y + 4.6)}Z`
  }
  if (variant === 1) {
    return (
      <path
        {...FILL}
        fillRule="evenodd"
        d={`${wave(9.4, 5.2)}${wave(13.6, 5.2)}${spec.complexity >= 4 ? wave(17.8, 4.4) : ''}`}
      />
    )
  }
  return (
    <>
      {Array.from({ length: layers }, (_, index) => (
        <path key={`wave-${index}`} {...FILL} d={wave(8.8 + index * 4.4, 4.6 + spec.spread)} opacity={1 - index * 0.12} />
      ))}
    </>
  )
}

function renderCore(spec: CompanyLogoSpec, variant: number) {
  if (variant === 1) {
    return (
      <path
        {...FILL}
        fillRule="evenodd"
        d={`${circlePath(16, 16, 11.5)}M11.4 11.4h9.2v9.2h-9.2Z`}
      />
    )
  }
  if (variant === 2) {
    return (
      <path
        {...FILL}
        fillRule="evenodd"
        d={`${circlePath(16, 16, 11.5)}M14.4 6.4h3.2v19.2h-3.2ZM6.4 14.4h19.2v3.2H6.4Z`}
      />
    )
  }
  const rings = Math.min(3, spec.complexity)
  return (
    <>
      {Array.from({ length: rings }, (_, index) => {
        const outer = 11.5 - index * 3.15
        const inner = outer - 2.4
        if (index === rings - 1 && spec.complexity < 3) {
          return <circle key={`core-${index}`} {...FILL} cx="16" cy="16" r={outer} />
        }
        return (
          <path
            key={`core-${index}`}
            {...FILL}
            fillRule="evenodd"
            d={`${circlePath(16, 16, outer)}${circlePath(16, 16, Math.max(1.2, inner))}`}
          />
        )
      })}
    </>
  )
}

function renderMark(mark: CompanyMarkId) {
  switch (mark) {
    case 'orbit':
      return (
        <>
          <circle {...FILL} cx="12.2" cy="16" r="7.2" />
          <circle {...FILL} cx="19.8" cy="16" r="7.2" />
        </>
      )
    case 'delta':
      return <path {...FILL} fillRule="evenodd" d={`${closePath(polygonPoints(3, 12, -90))}${closePath(polygonPoints(3, 5.2, -90))}`} />
    case 'prism':
      return <path {...FILL} fillRule="evenodd" d={`${closePath(polygonPoints(4, 12, 45))}${closePath(polygonPoints(4, 5.4, 45))}`} />
    case 'hex':
      return <path {...FILL} fillRule="evenodd" d={`${closePath(polygonPoints(6, 12, -90))}${closePath(polygonPoints(6, 6.2, -90))}`} />
    case 'spire':
      return <path {...FILL} d={closePath([[16, 3.4], [24.6, 28.4], [16, 21.2], [7.4, 28.4]])} />
    case 'grid':
      return (
        <>
          <rect {...FILL} x="5.2" y="5.2" width="9.4" height="9.4" rx="1.4" />
          <rect {...FILL} x="17.4" y="5.2" width="9.4" height="9.4" rx="1.4" />
          <rect {...FILL} x="5.2" y="17.4" width="9.4" height="9.4" rx="1.4" />
          <rect {...FILL} x="18.6" y="16.2" width="9.4" height="9.4" rx="1.4" />
        </>
      )
    case 'nexus':
      return (
        <>
          <path {...RING} strokeWidth="2.5" d="M10.2 17.6L21.6 10.4M10.2 17.6L21.6 21.8" />
          <circle {...FILL} cx="9.2" cy="18" r="3.2" />
          <circle {...FILL} cx="22.4" cy="9.6" r="3.2" />
          <circle {...FILL} cx="22.4" cy="22.4" r="3.2" />
        </>
      )
    case 'wave':
      return <path {...FILL} d={`M4.4 11.2 C10.2 4.2 13.8 18.2 16 11.2 S21.8 4.2 27.6 11.2 L27.6 16.4 C21.8 9.4 18.2 23.4 16 16.4 S10.2 9.4 4.4 16.4Z`} />
    case 'core':
      return <path {...FILL} fillRule="evenodd" d={`${circlePath(16, 16, 12)}${circlePath(16, 16, 6.4)}${circlePath(16, 16, 3.1)}`} />
    default: {
      return <path {...FILL} d={closePath(polygonPoints(4, 12, 45))} />
    }
  }
}

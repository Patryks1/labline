export interface RadarAxis {
  x: number
  y: number
  labelX: number
  labelY: number
  ux: number
  uy: number
}

export const RADAR_CENTER = { x: 160, y: 125 }
export const RADAR_RADIUS = 86
/** Clearance between the outer plot ring and the inward face of a label box. */
export const RADAR_LABEL_GAP = 14
/** Axis-aligned box used to keep SVG labels outside the plot ring. */
export const RADAR_LABEL_BOX = { width: 64, height: 18 }

function labelRadius(ux: number, uy: number) {
  return (
    RADAR_RADIUS +
    RADAR_LABEL_GAP +
    (RADAR_LABEL_BOX.width / 2) * Math.abs(ux) +
    (RADAR_LABEL_BOX.height / 2) * Math.abs(uy)
  )
}

export function radarViewBox(axes: RadarAxis[]) {
  const pad = 10
  const halfW = RADAR_LABEL_BOX.width / 2
  const halfH = RADAR_LABEL_BOX.height / 2
  let minX = RADAR_CENTER.x - RADAR_RADIUS
  let minY = RADAR_CENTER.y - RADAR_RADIUS
  let maxX = RADAR_CENTER.x + RADAR_RADIUS
  let maxY = RADAR_CENTER.y + RADAR_RADIUS
  for (const axis of axes) {
    minX = Math.min(minX, axis.labelX - halfW)
    minY = Math.min(minY, axis.labelY - halfH)
    maxX = Math.max(maxX, axis.labelX + halfW)
    maxY = Math.max(maxY, axis.labelY + halfH)
  }
  return `${(minX - pad).toFixed(1)} ${(minY - pad).toFixed(1)} ${(maxX - minX + pad * 2).toFixed(1)} ${(maxY - minY + pad * 2).toFixed(1)}`
}

export function radarGeometry(count: number) {
  const center = RADAR_CENTER
  const radius = RADAR_RADIUS
  const axes: RadarAxis[] = Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, count)
    const ux = Math.cos(angle)
    const uy = Math.sin(angle)
    const labelR = labelRadius(ux, uy)
    return {
      x: center.x + ux * radius,
      y: center.y + uy * radius,
      labelX: center.x + ux * labelR,
      labelY: center.y + uy * labelR,
      ux,
      uy,
    }
  })
  return { center, radius, axes, viewBox: radarViewBox(axes) }
}

export function scaledPoint(axis: RadarAxis, value: number) {
  const fraction = Math.max(0, Math.min(100, value)) / 100
  return {
    x: RADAR_CENTER.x + axis.ux * RADAR_RADIUS * fraction,
    y: RADAR_CENTER.y + axis.uy * RADAR_RADIUS * fraction,
  }
}

export function polygonPoints(values: number[], axes: RadarAxis[]): string {
  return values
    .map((value, index) => {
      const point = scaledPoint(axes[index]!, value)
      return `${point.x.toFixed(2)},${point.y.toFixed(2)}`
    })
    .join(' ')
}

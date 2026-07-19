export interface RadarAxis {
  x: number
  y: number
  labelX: number
  labelY: number
  ux: number
  uy: number
}

export function radarGeometry(count: number) {
  const center = { x: 160, y: 125 }
  const radius = 86
  const axes: RadarAxis[] = Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, count)
    const ux = Math.cos(angle)
    const uy = Math.sin(angle)
    return {
      x: center.x + ux * radius,
      y: center.y + uy * radius,
      labelX: center.x + ux * 112,
      labelY: center.y + uy * 105,
      ux,
      uy,
    }
  })
  return { center, axes }
}

export function scaledPoint(axis: RadarAxis, value: number) {
  const fraction = Math.max(0, Math.min(100, value)) / 100
  return { x: 160 + axis.ux * 86 * fraction, y: 125 + axis.uy * 86 * fraction }
}

export function polygonPoints(values: number[], axes: RadarAxis[]): string {
  return values
    .map((value, index) => {
      const point = scaledPoint(axes[index]!, value)
      return `${point.x.toFixed(2)},${point.y.toFixed(2)}`
    })
    .join(' ')
}

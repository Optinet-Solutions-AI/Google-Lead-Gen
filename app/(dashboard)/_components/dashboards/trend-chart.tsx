/**
 * Lightweight SVG line + area chart. Deliberately no chart library —
 * dashboards render a lot of these and every dependency slows initial
 * paint. Accepts a series of {label, value} points, renders a smooth
 * line with a soft area fill and a hover-friendly baseline.
 *
 * When `values2` is provided, renders a second series overlaid (e.g.
 * total scrapes AND successful scrapes on the same axes).
 */
export type TrendPoint = { label: string; value: number; value2?: number }

export function TrendChart({
  points,
  height = 140,
  color = 'var(--color-accent)',
  color2 = 'var(--color-text-secondary)',
  emptyMessage = 'No data in this window.',
}: {
  points: TrendPoint[]
  height?: number
  color?: string
  color2?: string
  emptyMessage?: string
}) {
  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-4 py-8 text-[11px] text-[color:var(--color-text-secondary)]" style={{ height }}>
        {emptyMessage}
      </div>
    )
  }
  const width = 800 // viewBox width; SVG scales to container
  const padX = 40
  const padTop = 12
  const padBot = 22
  const chartH = height - padTop - padBot
  const chartW = width - padX - 12

  // Y range covers both series if value2 present
  const allVals: number[] = []
  for (const p of points) {
    allVals.push(p.value)
    if (typeof p.value2 === 'number') allVals.push(p.value2)
  }
  const yMax = Math.max(1, ...allVals)
  const stepX = points.length > 1 ? chartW / (points.length - 1) : 0

  const buildPath = (accessor: (p: TrendPoint) => number | undefined): string => {
    let d = ''
    for (let i = 0; i < points.length; i++) {
      const v = accessor(points[i]!)
      if (v === undefined) continue
      const x = padX + i * stepX
      const y = padTop + chartH - (v / yMax) * chartH
      d += (d ? ' L ' : 'M ') + x.toFixed(1) + ' ' + y.toFixed(1)
    }
    return d
  }
  const buildArea = (accessor: (p: TrendPoint) => number | undefined): string => {
    let d = ''
    for (let i = 0; i < points.length; i++) {
      const v = accessor(points[i]!)
      if (v === undefined) continue
      const x = padX + i * stepX
      const y = padTop + chartH - (v / yMax) * chartH
      d += (d ? ' L ' : 'M ') + x.toFixed(1) + ' ' + y.toFixed(1)
    }
    if (!d) return ''
    d += ` L ${(padX + (points.length - 1) * stepX).toFixed(1)} ${(padTop + chartH).toFixed(1)}`
    d += ` L ${padX.toFixed(1)} ${(padTop + chartH).toFixed(1)} Z`
    return d
  }

  const line1 = buildPath(p => p.value)
  const area1 = buildArea(p => p.value)
  const line2 = points.some(p => typeof p.value2 === 'number')
    ? buildPath(p => p.value2)
    : ''

  // Y-axis ticks (0, mid, max)
  const yTicks = [0, Math.round(yMax / 2), yMax]

  // Sparse X-axis labels — first, mid, last so we don't crowd
  const labelIdx = points.length <= 5
    ? points.map((_, i) => i)
    : [0, Math.floor(points.length / 2), points.length - 1]

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label="Trend chart"
    >
      {/* Grid + Y ticks */}
      {yTicks.map(t => {
        const y = padTop + chartH - (t / yMax) * chartH
        return (
          <g key={t}>
            <line
              x1={padX}
              x2={width - 12}
              y1={y}
              y2={y}
              stroke="var(--color-border)"
              strokeWidth={0.5}
              strokeDasharray="2 3"
            />
            <text
              x={padX - 6}
              y={y + 3}
              fill="var(--color-text-secondary)"
              fontSize="9"
              textAnchor="end"
            >
              {t.toLocaleString()}
            </text>
          </g>
        )
      })}
      {/* X-axis labels */}
      {labelIdx.map(i => {
        const p = points[i]!
        const x = padX + i * stepX
        return (
          <text
            key={i}
            x={x}
            y={height - 6}
            fill="var(--color-text-secondary)"
            fontSize="9"
            textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
          >
            {p.label}
          </text>
        )
      })}
      {/* Area under primary line */}
      <path d={area1} fill={color} opacity={0.14} />
      {/* Primary line */}
      <path d={line1} fill="none" stroke={color} strokeWidth={1.5} />
      {/* Secondary line (optional) */}
      {line2 && (
        <path
          d={line2}
          fill="none"
          stroke={color2}
          strokeWidth={1.25}
          strokeDasharray="3 3"
        />
      )}
    </svg>
  )
}

/**
 * 7 × 24 heatmap grid (day-of-week × hour-of-day). Deliberately
 * pure CSS grid — no D3, no plot lib. Each cell's opacity encodes
 * intensity relative to the window's max.
 *
 * `data` is an array of {dayOfWeek: 0-6 (Mon=0), hour: 0-23,
 * value: number}. Missing cells render as empty (opacity 0.05).
 * `title`/hover tooltip live on the parent; individual cells get
 * their own title="Mon 14:00 · 12 events" so operators can hover
 * a hot cell for the exact number.
 */
export type HeatCell = { dayOfWeek: number; hour: number; value: number }

export function HeatMap({
  data,
  color = 'var(--color-accent)',
  emptyMessage = 'No activity in this window.',
}: {
  data: HeatCell[]
  color?: string
  emptyMessage?: string
}) {
  const max = data.reduce((m, c) => (c.value > m ? c.value : m), 0)
  if (max === 0) {
    return (
      <div className="flex items-center justify-center rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-4 py-6 text-[11px] text-[color:var(--color-text-secondary)]">
        {emptyMessage}
      </div>
    )
  }

  // Fast lookup: (day, hour) → value
  const map = new Map<string, number>()
  for (const c of data) map.set(`${c.dayOfWeek}:${c.hour}`, c.value)

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  return (
    <div className="overflow-x-auto">
      <div className="inline-flex min-w-full flex-col gap-1">
        {/* Hour ruler */}
        <div className="grid" style={{ gridTemplateColumns: '32px repeat(24, minmax(14px, 1fr))', gap: '2px' }}>
          <div />
          {Array.from({ length: 24 }).map((_, h) => (
            <div
              key={h}
              className="text-center text-[9px] text-[color:var(--color-text-secondary)]"
            >
              {h % 3 === 0 ? h : ''}
            </div>
          ))}
        </div>
        {DAYS.map((day, di) => (
          <div
            key={day}
            className="grid items-center"
            style={{ gridTemplateColumns: '32px repeat(24, minmax(14px, 1fr))', gap: '2px' }}
          >
            <div className="text-right pr-1 text-[10px] font-medium text-[color:var(--color-text-secondary)]">
              {day}
            </div>
            {Array.from({ length: 24 }).map((_, h) => {
              const v = map.get(`${di}:${h}`) ?? 0
              const opacity = v === 0 ? 0.05 : 0.15 + (v / max) * 0.85
              return (
                <div
                  key={h}
                  className="h-4 rounded-[2px] border border-[color:var(--color-border)]/50"
                  style={{
                    backgroundColor: color,
                    opacity,
                  }}
                  title={`${day} ${String(h).padStart(2, '0')}:00 UTC · ${v.toLocaleString()}`}
                />
              )
            })}
          </div>
        ))}
      </div>
      {/* Legend */}
      <div className="mt-2 flex items-center gap-2 text-[10px] text-[color:var(--color-text-secondary)]">
        <span>less</span>
        {[0.15, 0.35, 0.55, 0.75, 1].map((o, i) => (
          <div
            key={i}
            className="h-2.5 w-4 rounded-[2px]"
            style={{ backgroundColor: color, opacity: o }}
          />
        ))}
        <span>more (max {max.toLocaleString()})</span>
      </div>
    </div>
  )
}

/**
 * Utility: bucket a list of ISO timestamps into a 7×24 HeatCell[]
 * (using UTC day-of-week + hour). Every dashboard heatmap uses this
 * shape.
 */
export function bucketToHeatmap(timestamps: string[]): HeatCell[] {
  const counts = new Map<string, number>()
  for (const iso of timestamps) {
    if (!iso) continue
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) continue
    // JS getUTCDay returns 0=Sun..6=Sat; we want 0=Mon..6=Sun
    const jsDow = d.getUTCDay()
    const dow = jsDow === 0 ? 6 : jsDow - 1
    const key = `${dow}:${d.getUTCHours()}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const out: HeatCell[] = []
  for (const [k, v] of counts.entries()) {
    const [dow, hour] = k.split(':').map(Number)
    out.push({ dayOfWeek: dow!, hour: hour!, value: v })
  }
  return out
}

/**
 * Human-labeled cron presets used by the schedules UI.
 * Users can still pick "Custom" and type their own expression.
 *
 * All expressions are UTC. See /api/scheduler/tick for evaluation.
 */
export const CRON_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '*/15 * * * *', label: 'Every 15 minutes' },
  { value: '*/30 * * * *', label: 'Every 30 minutes' },
  { value: '0 * * * *',    label: 'Hourly' },
  { value: '0 */4 * * *',  label: 'Every 4 hours' },
  { value: '0 */6 * * *',  label: 'Every 6 hours' },
  { value: '0 */12 * * *', label: 'Every 12 hours' },
  { value: '0 0 * * *',    label: 'Daily at 00:00 UTC' },
  { value: '0 9 * * *',    label: 'Daily at 09:00 UTC' },
  { value: '0 0 * * 1',    label: 'Weekly (Mondays 00:00 UTC)' },
]

/** Fallback label when a stored cron doesn't match a preset. */
export function describeCron(expr: string | null): string {
  if (!expr) return 'Ad-hoc only (no schedule)'
  const hit = CRON_PRESETS.find(p => p.value === expr)
  return hit ? hit.label : `Custom: ${expr}`
}

'use client'

import { useActionState } from 'react'
import { Loader2 } from 'lucide-react'
import { updateCostSettingAction, type CostUpdateState } from '../actions'

const initial: CostUpdateState = null

type Props = {
  /** system_settings key — must be one of the allowlisted ones in actions.ts */
  settingKey: string
  /** Display label shown to the operator. */
  label: string
  /** Sub-line shown under the label (units, what it covers, etc.). */
  hint?: string
  /** Current value in the setting (USD). */
  current: number
  /** Unit suffix, e.g. "/ GB" or "/ mo". */
  unit: string
}

export function CostRow({ settingKey, label, hint, current, unit }: Props) {
  const [state, action, pending] = useActionState(updateCostSettingAction, initial)

  return (
    <li className="flex flex-col gap-1 border-b border-[color:var(--color-border)] px-3 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-[color:var(--color-text-primary)]">
            {label}
          </div>
          {hint && (
            <div className="text-[10px] text-[color:var(--color-text-secondary)]">{hint}</div>
          )}
        </div>
        <form action={action} className="flex items-center gap-1.5">
          <input type="hidden" name="key" value={settingKey} />
          <span className="text-[11px] text-[color:var(--color-text-secondary)]">$</span>
          <input
            name="amount"
            type="number"
            min={0}
            step="0.01"
            defaultValue={Number.isFinite(current) ? current : 0}
            required
            className="w-24 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-right text-[12px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
          />
          <span className="text-[11px] text-[color:var(--color-text-secondary)]">{unit}</span>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)] disabled:opacity-50"
          >
            {pending && <Loader2 className="h-3 w-3 animate-spin" />}
            Save
          </button>
        </form>
      </div>
      {state?.status === 'error' && (
        <p className="text-[10px] text-red-700">{state.error}</p>
      )}
      {state?.status === 'ok' && (
        <p className="text-[10px] text-emerald-700">Saved.</p>
      )}
    </li>
  )
}

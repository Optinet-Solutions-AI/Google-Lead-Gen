'use client'

import { useActionState } from 'react'
import { CheckCircle2, Gauge, Loader2, Save } from 'lucide-react'
import { setProxyBandwidthConfigAction, type SettingState } from '../actions'

const initial: SettingState = null

export function ProxyBandwidthSettings({
  limitGb,
  thresholdGb,
  latest,
}: {
  limitGb: number
  thresholdGb: number
  latest: {
    usedGb: number
    remainingGb: number
    isLow: boolean
    capturedAt: string
  } | null
}) {
  const [state, action, pending] = useActionState(setProxyBandwidthConfigAction, initial)

  return (
    <div className="flex flex-col gap-3">
      {latest ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--color-bg-secondary)] px-2 py-0.5 font-medium text-[color:var(--color-text-primary)]">
            <Gauge className="h-3 w-3" />
            {latest.remainingGb.toFixed(1)} GB remaining
          </span>
          <span className="text-[color:var(--color-text-secondary)]">
            {latest.usedGb.toFixed(1)} GB used
          </span>
          {latest.isLow && (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 font-semibold text-rose-800">
              Low
            </span>
          )}
          <span className="text-[color:var(--color-text-secondary)]">
            · last reading {new Date(latest.capturedAt).toLocaleString()}
          </span>
        </div>
      ) : (
        <p className="text-[11px] text-[color:var(--color-text-secondary)]">
          No reading yet — usage refreshes from GoLogin every 30 minutes.
        </p>
      )}

      <form action={action} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[11px] text-[color:var(--color-text-secondary)]">
          Plan size (GB)
          <input
            type="number"
            name="limit_gb"
            min="0.1"
            step="0.1"
            defaultValue={limitGb}
            required
            className="w-28 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[13px] text-[color:var(--color-text-primary)]"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-[color:var(--color-text-secondary)]">
          Warn below (GB)
          <input
            type="number"
            name="threshold_gb"
            min="0"
            step="0.1"
            defaultValue={thresholdGb}
            required
            className="w-28 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[13px] text-[color:var(--color-text-primary)]"
          />
        </label>

        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] transition-colors hover:bg-[color:var(--color-bg-primary)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </button>
      </form>

      {state?.status === 'ok' && (
        <p className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-800">
          <CheckCircle2 className="h-3 w-3" />
          {state.message}
        </p>
      )}
      {state?.status === 'error' && (
        <p className="rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
          {state.error}
        </p>
      )}
    </div>
  )
}

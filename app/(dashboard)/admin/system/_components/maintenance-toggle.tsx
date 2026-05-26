'use client'

import { useActionState } from 'react'
import { CheckCircle2, Construction, Loader2, Power } from 'lucide-react'
import { setMaintenanceModeAction, type SettingState } from '../actions'

const initial: SettingState = null

export function MaintenanceToggle({ enabled }: { enabled: boolean }) {
  const [state, action, pending] = useActionState(setMaintenanceModeAction, initial)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={[
            'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold',
            enabled
              ? 'bg-amber-100 text-amber-900'
              : 'bg-emerald-100 text-emerald-800',
          ].join(' ')}
        >
          <span
            className={[
              'h-2 w-2 rounded-full',
              enabled ? 'bg-amber-600' : 'bg-emerald-600',
            ].join(' ')}
          />
          Maintenance mode is currently {enabled ? 'ON' : 'OFF'}
        </span>

        <form action={action}>
          <input type="hidden" name="value" value={enabled ? 'false' : 'true'} />
          <button
            type="submit"
            disabled={pending}
            className={[
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              enabled
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100'
                : 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100',
            ].join(' ')}
            title={
              enabled
                ? 'Turn off maintenance mode — users can sign back in'
                : 'Turn on maintenance mode — kick everyone except admins'
            }
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : enabled ? (
              <Power className="h-3.5 w-3.5" />
            ) : (
              <Construction className="h-3.5 w-3.5" />
            )}
            {enabled ? 'Turn maintenance OFF' : 'Turn maintenance ON'}
          </button>
        </form>
      </div>

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

'use client'

import { useActionState } from 'react'
import { CheckCircle2, Loader2, Power } from 'lucide-react'
import {
  setAvailableForCaptchaReviewPreference,
  type PreferenceState,
} from '../actions'

const initial: PreferenceState = null

/**
 * Per-user toggle for "I'm available to clear CAPTCHA challenges
 * manually." When ON, the worker parks CAPTCHA-hit scrapes in
 * needs_human and waits up to 65 minutes for the user to click
 * through on /admin/interactive. When OFF (default), the worker
 * skips the wait — it falls back to the 2Captcha auto-solver (if
 * enabled in /admin/system) or fails fast — so the job queue
 * doesn't stall when nobody's around to action it.
 */
export function CaptchaReviewToggle({ enabled }: { enabled: boolean }) {
  const [state, action, pending] = useActionState(
    setAvailableForCaptchaReviewPreference,
    initial,
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={[
            'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold',
            enabled
              ? 'bg-emerald-100 text-emerald-800'
              : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
          ].join(' ')}
        >
          <span
            className={[
              'h-2 w-2 rounded-full',
              enabled ? 'bg-emerald-600' : 'bg-[color:var(--color-text-secondary)]',
            ].join(' ')}
          />
          {enabled
            ? "I'm available for CAPTCHA review"
            : "Not available for CAPTCHA review"}
        </span>

        <form action={action}>
          <input type="hidden" name="value" value={enabled ? 'false' : 'true'} />
          <button
            type="submit"
            disabled={pending}
            className={[
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              enabled
                ? 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]'
                : 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100',
            ].join(' ')}
            title={
              enabled
                ? 'Stop being on the hook — scrapes won’t wait for you anymore'
                : 'Mark yourself available — scrapes will wait up to 65 min for you to clear CAPTCHA walls'
            }
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Power className="h-3.5 w-3.5" />
            )}
            Mark me {enabled ? 'unavailable' : 'available'}
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

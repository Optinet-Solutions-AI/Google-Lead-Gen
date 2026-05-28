'use client'

import { useActionState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, Loader2, RotateCcw, Smartphone } from 'lucide-react'
import { rerunMobileOnly, type RerunMobileOnlyState } from '../actions'

type Props = {
  jobId: string
  captchaSolverEnabled: boolean
}

const initial: RerunMobileOnlyState = null

// Shown on the scrape detail page when a 'both'-mode job completed but
// the mobile pass got silently aborted on a captcha. Lets the operator
// re-queue the same keyword in mobile-only mode (which uses the regular
// Captcha solver path instead of the silent-abort behaviour 'both' mode
// triggers). On success, we navigate the user to the new job page.
export function MobileSkippedRetryBanner({ jobId, captchaSolverEnabled }: Props) {
  const router = useRouter()
  const [state, action, pending] = useActionState(rerunMobileOnly, initial)

  useEffect(() => {
    if (state?.status === 'ok') {
      router.push(`/scrape/${state.newJobId}`)
    }
  }, [state, router])

  return (
    <section className="rounded-md border border-amber-300 bg-amber-50 p-3">
      <header className="flex items-center gap-2 text-amber-900">
        <Smartphone className="h-4 w-4 shrink-0" />
        <h2 className="text-[13px] font-semibold">
          Mobile pass skipped on captcha
        </h2>
      </header>
      <p className="mt-1 text-[12px] leading-relaxed text-amber-900">
        Desktop results are preserved, but the mobile pass was silently
        aborted when Google showed a captcha — so every row is tagged{' '}
        <code className="rounded bg-amber-100 px-1 py-0.5 text-[11px]">seen_on=&ldquo;desktop&rdquo;</code>{' '}
        and there&apos;s no mobile-only / cross-device breakdown for this
        keyword. <strong>Re-run mobile only</strong> below to queue a
        fresh job in mobile-only mode — that path uses the Captcha solver
        instead of the silent abort.
      </p>
      {!captchaSolverEnabled && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-100 px-2 py-1.5 text-[11px] text-amber-900">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            The Captcha solver is currently <strong>off</strong>, so a
            mobile-only re-run on this keyword is likely to abort on the
            same captcha. Turn it on first at{' '}
            <Link
              href="/admin/system"
              className="underline underline-offset-2 hover:text-amber-950"
            >
              /admin/system
            </Link>
            .
          </span>
        </p>
      )}
      <form action={action} className="mt-2">
        <input type="hidden" name="job_id" value={jobId} />
        <button
          type="submit"
          disabled={pending || state?.status === 'ok'}
          className="inline-flex items-center gap-1.5 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-[12px] font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending || state?.status === 'ok' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
          {state?.status === 'ok'
            ? 'Queued — taking you to the new job…'
            : 'Re-run mobile only'}
        </button>
      </form>
      {state?.status === 'error' && (
        <p className="mt-2 rounded-md bg-red-100 px-2 py-1 text-[11px] text-red-800">
          {state.error}
        </p>
      )}
    </section>
  )
}

'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { Hand, Loader2, RotateCcw, ShieldCheck } from 'lucide-react'
import { resetCaptchaRetries, type JobActionState } from '../actions'

type Props = {
  jobId: string
  errorMessage: string | null
}

const initial: JobActionState = null

// Shown on the scrape detail page when a job ended in status='captcha'.
// The recovery flow exists in the row kebab menu on /scrape, but nothing
// on the detail page told operators what to do — so a missed HITL
// notification stranded the job with no obvious way forward.
export function CaptchaRecoveryBanner({ jobId, errorMessage }: Props) {
  const [state, action, pending] = useActionState(resetCaptchaRetries, initial)

  const hint = (errorMessage ?? '').toLowerCase()
  const hitlTimedOut =
    hint.includes('hitl timed out') || hint.includes('nobody was around')

  return (
    <section className="rounded-md border border-amber-300 bg-amber-50 p-3">
      <header className="flex items-center gap-2 text-amber-900">
        <ShieldCheck className="h-4 w-4 shrink-0" />
        <h2 className="text-[13px] font-semibold">
          Scrape stopped on a captcha
        </h2>
      </header>
      <p className="mt-1 text-[12px] leading-relaxed text-amber-900">
        {hitlTimedOut ? (
          <>
            The captcha checkpoint wasn&apos;t solved in time and the worker
            gave up.{' '}
            <strong>Try again</strong>{' '}
            below to re-queue this scrape — it&apos;ll
            restart with a fresh proxy IP. If a captcha shows up again, you&apos;ll
            see it in the{' '}
            <Link
              href="/admin/interactive"
              className="underline underline-offset-2 hover:text-amber-950"
            >
              <Hand className="-mt-0.5 mr-0.5 inline h-3 w-3" />
              Interactive checkpoints
            </Link>{' '}
            page (and in the amber banner at the top of every page).
          </>
        ) : (
          <>
            The scraper hit a captcha it couldn&apos;t auto-solve.{' '}
            <strong>Try again</strong>{' '}
            below to re-queue with a fresh proxy IP —
            the IP rotates per session so a different result is likely.
          </>
        )}
      </p>
      {errorMessage && (
        <p className="mt-1 text-[11px] text-amber-900/80">
          Worker said: <span className="italic">&ldquo;{errorMessage}&rdquo;</span>
        </p>
      )}
      <form action={action} className="mt-2">
        <input type="hidden" name="job_id" value={jobId} />
        <button
          type="submit"
          disabled={pending || state?.status === 'ok'}
          className="inline-flex items-center gap-1.5 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-[12px] font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
          {state?.status === 'ok'
            ? 'Re-queued — refresh to see it pick up'
            : 'Try again — re-queue with a fresh proxy'}
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

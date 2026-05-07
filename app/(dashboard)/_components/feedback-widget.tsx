'use client'

import { useActionState, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import {
  CheckCircle2,
  Link2,
  Loader2,
  MessageCircle,
  Send,
  X,
} from 'lucide-react'
import {
  submitFeedbackAction,
  type SubmitFeedbackState,
} from '../admin/feedback/actions'

const initial: SubmitFeedbackState = null

/**
 * Floating QA-feedback widget. Bottom-right of every dashboard page.
 *
 * Click → small dialog with a URL input (pre-filled to the current
 * page) and a message textarea. Submit lands a row in `qa_feedback`
 * for the admin queue.
 */
export function FeedbackWidget() {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(submitFeedbackAction, initial)
  const pathname = usePathname()

  // Pre-fill the URL field with the current page's full URL so the
  // tester only has to type the message in the common case.
  const [url, setUrl] = useState('')
  const [message, setMessage] = useState('')

  // Reset form on a successful submission and stage a 2.5s "Thanks!"
  // banner before closing the dialog. setState-in-effect is exactly
  // the right tool here — we're syncing post-submit React state with
  // a one-shot side effect (clear textarea + schedule auto-close).
  useEffect(() => {
    if (state?.status === 'ok') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMessage('')
      const t = setTimeout(() => setOpen(false), 2500)
      return () => clearTimeout(t)
    }
  }, [state])

  // Pre-fill the URL field with the current page on every open so
  // testers don't have to type it. Reading window.location is a
  // browser-only side effect — pure useEffect territory.
  useEffect(() => {
    if (open) {
      try {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setUrl(window.location.href)
      } catch {
         
        setUrl('')
      }
    }
  }, [open, pathname])

  return (
    <>
      {/* Floating launcher button */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={open ? 'Close feedback' : 'Send QA feedback'}
        title="Report an issue or send feedback"
        className={[
          'fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full',
          'border border-[color:var(--color-border)] shadow-lg transition-all',
          'bg-[color:var(--color-accent)] text-white hover:scale-105 hover:shadow-xl',
          open ? 'rotate-45' : '',
        ].join(' ')}
      >
        {open ? <X className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}
      </button>

      {/* Dialog */}
      {open && (
        <div
          role="dialog"
          aria-label="QA feedback"
          className="fixed bottom-20 right-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3 shadow-xl"
        >
          <header className="flex items-center justify-between gap-2">
            <h2 className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[color:var(--color-text-primary)]">
              <MessageCircle className="h-4 w-4 text-[color:var(--color-accent)]" />
              QA Feedback
            </h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="rounded-md p-1 text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </header>

          <p className="text-[11px] text-[color:var(--color-text-secondary)]">
            Spotted an issue? Send a quick note. Including a URL (the
            page you were on, or the search-result link you&apos;re
            flagging) makes it much faster to investigate.
          </p>

          <form action={action} className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
                <Link2 className="h-2.5 w-2.5" />
                URL <span className="font-normal normal-case tracking-normal italic text-[color:var(--color-text-secondary)]">(optional, encouraged)</span>
              </span>
              <input
                type="url"
                name="url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://…"
                className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
                Message <span className="text-red-600">*</span>
              </span>
              <textarea
                name="message"
                required
                rows={4}
                maxLength={4000}
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="What went wrong / what should we change?"
                className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
              />
              <span className="ml-auto text-[10px] text-[color:var(--color-text-secondary)]">
                {message.length} / 4000
              </span>
            </label>

            <div className="flex items-center justify-between gap-2">
              {state?.status === 'error' && (
                <p className="rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-700">
                  {state.error}
                </p>
              )}
              {state?.status === 'ok' && (
                <p className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800">
                  <CheckCircle2 className="h-3 w-3" />
                  {state.message}
                </p>
              )}
              <button
                type="submit"
                disabled={pending || message.trim().length === 0}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)] px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Send
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}

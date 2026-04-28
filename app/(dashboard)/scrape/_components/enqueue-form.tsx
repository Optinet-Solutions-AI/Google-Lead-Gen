'use client'

import { useActionState, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { enqueueScrape, type EnqueueState } from '../actions'

type Profile = {
  country_code: string
  country_name: string
  requires_google_login: boolean
  is_google_logged_in: boolean
}

function loginBadge(p: Profile): string {
  if (!p.requires_google_login) return ''
  return p.is_google_logged_in ? ' ✓' : ' ⚠ needs login'
}

const initial: EnqueueState = null

/** Count non-empty, trimmed lines in a textarea. */
function countKeywords(text: string): number {
  return text
    .split(/\r?\n/)
    .map(k => k.trim())
    .filter(k => k.length > 0).length
}

export function EnqueueForm({ profiles }: { profiles: Profile[] }) {
  const [state, formAction, pending] = useActionState(enqueueScrape, initial)
  const formRef = useRef<HTMLFormElement>(null)
  const router = useRouter()

  const [keywordsText, setKeywordsText] = useState('')
  const [selectedCountry, setSelectedCountry] = useState('')
  const count = useMemo(() => countKeywords(keywordsText), [keywordsText])
  const selectedProfile = useMemo(
    () => profiles.find(p => p.country_code === selectedCountry) ?? null,
    [profiles, selectedCountry],
  )
  const loginWarning =
    selectedProfile?.requires_google_login && !selectedProfile.is_google_logged_in

  useEffect(() => {
    if (state?.status === 'ok') {
      formRef.current?.reset()
      // Clearing the controlled textarea state after a successful submit
      // is a legitimate pattern; the lint rule fires because it can't
      // tell this only runs on a state change, not on every render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setKeywordsText('')
      // Refresh the jobs table to show the new rows immediately
      router.refresh()
    }
  }, [state, router])

  return (
    <form
      ref={formRef}
      action={formAction}
      className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4"
    >
      <div className="grid gap-3 md:grid-cols-[1fr_160px_100px_100px] md:items-start">
        <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
          <span className="flex items-baseline justify-between">
            <span>Keywords</span>
            <span className="text-[11px]">
              {count === 0 ? 'one per line' : `${count} keyword${count === 1 ? '' : 's'}`}
            </span>
          </span>
          <textarea
            name="keyword"
            required
            rows={4}
            value={keywordsText}
            onChange={e => setKeywordsText(e.target.value)}
            placeholder={'best online casinos\ntop 10 casinos 2026\nneue online casinos'}
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
          />
        </label>

        <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
          Country
          <select
            name="country_code"
            required
            value={selectedCountry}
            onChange={e => setSelectedCountry(e.target.value)}
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
          >
            <option value="" disabled>
              Pick…
            </option>
            {profiles.map(p => (
              <option key={p.country_code} value={p.country_code}>
                {p.country_name} ({p.country_code}){loginBadge(p)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
          Pages
          <input
            name="pages"
            type="number"
            min={1}
            max={10}
            defaultValue={1}
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
          />
        </label>

        <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
          Priority
          <input
            name="priority"
            type="number"
            min={0}
            max={100}
            defaultValue={0}
            title="Higher = picked up sooner by an idle worker"
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11px] text-[color:var(--color-text-secondary)]">
          Each keyword runs as a separate scrape. One per line.
        </p>
        <button
          type="submit"
          disabled={pending || count === 0}
          className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-[13px] font-medium text-[color:var(--color-text-primary)] transition-colors hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
        >
          {pending
            ? 'Starting…'
            : count <= 1
              ? 'Start scraping'
              : `Start ${count} scrapes`}
        </button>
      </div>

      {loginWarning && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          ⚠ <strong>{selectedProfile?.country_name}</strong> needs a Google account
          signed in for PPC ads to render reliably. The scrape will still run but
          PPC results may be missing or filtered. Mark the profile as logged in
          on{' '}
          <a href="/profiles" className="underline underline-offset-2">
            /profiles
          </a>{' '}
          once you&apos;ve signed in.
        </p>
      )}
      {state?.status === 'ok' && (
        <p className="mt-3 rounded-md bg-green-50 px-3 py-2 text-[12px] text-green-700">
          {state.message}
        </p>
      )}
      {state?.status === 'error' && (
        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {state.error}
        </p>
      )}
    </form>
  )
}

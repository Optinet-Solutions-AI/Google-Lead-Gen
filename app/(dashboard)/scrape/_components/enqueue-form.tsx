'use client'

import { useActionState, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Search } from 'lucide-react'
import { enqueueScrape, type EnqueueState } from '../actions'

/** localStorage key — remembers whether the user wants the enqueue
 *  form open or collapsed across sessions. Open by default. */
const COLLAPSED_KEY = 'lg-enqueue-form-collapsed'

type Profile = {
  country_code: string
  country_name: string
  requires_google_login: boolean
  is_google_logged_in: boolean
  languages: string[]
}

function loginBadge(p: Profile): string {
  if (!p.requires_google_login) return ''
  return p.is_google_logged_in ? ' ✓' : ' ⚠ needs login'
}

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  ar: 'Arabic',
  de: 'German',
  it: 'Italian',
  fr: 'French',
  da: 'Danish',
  no: 'Norwegian',
  sl: 'Slovenian',
}

function langOptions(profile: Profile | null): string[] {
  // Always include 'en' as a fallback even if a profile is missing it.
  const base = profile?.languages?.length ? profile.languages : ['en']
  return base.includes('en') ? base : [...base, 'en']
}

const initial: EnqueueState = null

/** Count non-empty, trimmed lines in a textarea. */
function countKeywords(text: string): number {
  return text
    .split(/\r?\n/)
    .map(k => k.trim())
    .filter(k => k.length > 0).length
}

/** Per-user daily quota snapshot — null when the caller is exempt
 *  (admins, or when the cap is disabled). The form renders a small
 *  "Scrapes today: X/Y" pill in the header and disables the submit
 *  button when remaining hits zero. */
type Quota = {
  cap: number
  usedToday: number
  remaining: number
}

/** Display label for the non-leads-pipeline engines (the ones whose results
 *  land in their own entity table). Used by the enrichment-toggle note. */
const ENGINE_LABELS: Record<string, string> = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  kick: 'Kick',
  x: 'X',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  snapchat: 'Snapchat',
  telegram: 'Telegram',
}
function sourceLabelFor(engine: string): string {
  return ENGINE_LABELS[engine] ?? 'These'
}

export function EnqueueForm({
  profiles,
  quota,
}: {
  profiles: Profile[]
  quota: Quota | null
}) {
  const [state, formAction, pending] = useActionState(enqueueScrape, initial)
  const formRef = useRef<HTMLFormElement>(null)
  const router = useRouter()

  const [keywordsText, setKeywordsText] = useState('')
  const [selectedCountry, setSelectedCountry] = useState('')
  const [selectedLang, setSelectedLang] = useState('en')
  // Drives the enrichment-toggle copy below. The non-google/bing engines
  // bypass the leads-pipeline enrichment entirely (they write to their own
  // entity tables and are scored by a manual "Score & check" step on the job
  // detail), so "Run full enrichment pipeline" is meaningless for them.
  const [selectedEngine, setSelectedEngine] = useState('google')
  const enrichmentBypassed =
    selectedEngine !== 'google' && selectedEngine !== 'bing' && selectedEngine !== 'both'
  // `datetime-local` returns "YYYY-MM-DDTHH:mm" with no zone. We
  // convert to ISO with UTC offset in the browser (where the local TZ
  // is meaningful) so the server doesn't reinterpret the wall-clock
  // time as UTC.
  const [scheduledAtLocal, setScheduledAtLocal] = useState('')
  const scheduledAtIso = useMemo(() => {
    if (!scheduledAtLocal) return ''
    const d = new Date(scheduledAtLocal)
    return Number.isFinite(d.getTime()) ? d.toISOString() : ''
  }, [scheduledAtLocal])
  // Open by default. Collapsed state persists per-browser via
  // localStorage so once an operator hides it, it stays hidden across
  // page navigations.
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    try {
       
      setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === '1')
    } catch {
      /* localStorage unavailable */
    }
  }, [])
  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev
      try {
        window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }
  const count = useMemo(() => countKeywords(keywordsText), [keywordsText])
  const selectedProfile = useMemo(
    () => profiles.find(p => p.country_code === selectedCountry) ?? null,
    [profiles, selectedCountry],
  )
  const availableLangs = useMemo(() => langOptions(selectedProfile), [selectedProfile])
  // If the user picks a country that doesn't have the currently-selected
  // language, fall back to the first available (preferring 'en').
  useEffect(() => {
    if (!availableLangs.includes(selectedLang)) {
      setSelectedLang(availableLangs.includes('en') ? 'en' : availableLangs[0]!)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableLangs.join(',')])
  const loginWarning =
    selectedProfile?.requires_google_login && !selectedProfile.is_google_logged_in

  useEffect(() => {
    if (state?.status === 'ok') {
      formRef.current?.reset()
      // Clearing the controlled textarea state after a successful submit
      // is a legitimate pattern; the lint rule fires because it can't
      // tell this only runs on a state change, not on every render.
       
      setKeywordsText('')
      setScheduledAtLocal('')
      // Refresh the jobs table to show the new rows immediately
      router.refresh()
    }
  }, [state, router])

  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
      {/* Collapsible header — clicking the title bar shows / hides
       *  the form. Open by default; persists to localStorage so the
       *  operator's preference sticks across navigations. */}
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-[color:var(--color-bg-secondary)]"
      >
        <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          <Search className="h-4 w-4 text-[color:var(--color-accent)]" />
          Queue scrapes
          {count > 0 && (
            <span className="rounded-full bg-[color:var(--color-accent)]/15 px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-text-primary)]">
              {count} keyword{count === 1 ? '' : 's'} drafted
            </span>
          )}
          {quota && (
            <span
              className={[
                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                quota.remaining === 0
                  ? 'bg-red-100 text-red-800'
                  : quota.remaining <= Math.max(1, Math.floor(quota.cap * 0.25))
                    ? 'bg-amber-100 text-amber-900'
                    : 'bg-emerald-100 text-emerald-800',
              ].join(' ')}
              title={`You've queued ${quota.usedToday} of ${quota.cap} scrapes today. Resets at UTC midnight.`}
            >
              {quota.remaining}/{quota.cap} left today
            </span>
          )}
        </span>
        <ChevronDown
          className={[
            'h-4 w-4 text-[color:var(--color-text-secondary)] transition-transform',
            collapsed ? '' : 'rotate-180',
          ].join(' ')}
        />
      </button>

      {!collapsed && (
        <form
          ref={formRef}
          action={formAction}
          className="border-t border-[color:var(--color-border)] p-4"
        >
          <div className="grid gap-3 md:grid-cols-[1fr_120px_160px_140px_100px_100px] md:items-start">
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
          Search engine
          <select
            name="search_engine"
            value={selectedEngine}
            onChange={e => setSelectedEngine(e.target.value)}
            title="Google/Bing scrape SERPs and produce URL leads (same downstream enrichment). 'Both' queues a Google job + a Bing job per keyword. YouTube, Kick, X, Facebook, and TikTok find affiliates — results land in youtube_channels / kick_streamers / x_creators / fb_advertisers / tiktok_creators, not the leads table, and the enrichment pipeline is bypassed. X needs the country's GoLogin profile signed into a burner X account (login wall); Facebook's Ad Library and TikTok are public (no login)."
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
          >
            <option value="google">Google</option>
            <option value="bing">Bing</option>
            <option value="both">Both (G + B)</option>
            <option value="twitch">Twitch</option>
            <option value="kick">Kick</option>
            <option value="youtube">YouTube</option>
            {/* X (Twitter) temporarily hidden — login rate-limited, pending
                Enigma resi-proxy routing. DB enum + server-side dispatch still
                accept 'x'; this only gates new job creation from the UI. */}
            {/* <option value="x">X (Twitter)</option> */}
            <option value="facebook">Facebook (Ad Library)</option>
            <option value="tiktok">TikTok</option>
            <option value="snapchat">Snapchat</option>
            <option value="telegram">Telegram</option>
          </select>
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
          Search language
          <select
            name="language"
            value={selectedLang}
            onChange={e => setSelectedLang(e.target.value)}
            disabled={!selectedCountry}
            title={
              selectedCountry
                ? 'Sets the &hl= param on Google search to force local-language results'
                : 'Pick a country first'
            }
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)] disabled:opacity-60"
          >
            {availableLangs.map(code => (
              <option key={code} value={code}>
                {LANG_NAMES[code] ?? code.toUpperCase()} ({code})
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

      <div className="mt-3 flex flex-wrap items-end gap-4 border-t border-[color:var(--color-border)] pt-3">
        {enrichmentBypassed ? (
          // The social engines (and Kick) don't flow through the leads
          // pipeline, so this toggle does nothing for them. Show why, and
          // point at the manual scoring step, instead of a dead checkbox
          // that makes operators expect enrichment that never runs.
          <div className="flex max-w-md flex-col gap-1 text-[12px] text-[color:var(--color-text-primary)]">
            <span className="font-medium">No leads-pipeline enrichment for this engine</span>
            <span className="text-[10px] text-[color:var(--color-text-secondary)]">
              {sourceLabelFor(selectedEngine)} results land in their own table, not the leads
              table. After the scrape completes, open the job and run{' '}
              <strong className="font-medium">Score &amp; check</strong> (▶/⭐) to flag affiliates,
              resolve links, mine contacts, and check Monday. Until then the results view shows no
              relevant leads.
            </span>
          </div>
        ) : (
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[color:var(--color-text-primary)]">
            <input
              type="checkbox"
              name="with_enrichment"
              className="h-4 w-4 rounded border-[color:var(--color-border)] text-[color:var(--color-accent)] focus:ring-[color:var(--color-accent)]"
            />
            <span>
              Run full enrichment pipeline after scrape
              <span className="block text-[10px] text-[color:var(--color-text-secondary)]">
                Auto-runs Monday dup check, affiliate detection, Rooster check, contact extraction, S-tag extraction + verify.
              </span>
            </span>
          </label>
        )}

        <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
          <span>
            View
            <span className="ml-1 text-[10px]">(catches mobile-only PPC + mobile-ranked organic)</span>
          </span>
          <select
            name="view_mode"
            defaultValue="both"
            title="Both: scrape the SERP as desktop AND as iPhone, merge results, mark each with seen_on. Desktop only: legacy behaviour. Mobile only: iPhone UA/viewport only — useful when desktop is heavily captcha'd."
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-1.5 text-[12px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
          >
            <option value="both">Both (desktop + mobile)</option>
            <option value="desktop">Desktop only</option>
            <option value="mobile">Mobile only</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
          <span>
            Schedule for{' '}
            <span className="text-[10px]">(optional — leave empty to run now)</span>
          </span>
          <input
            type="datetime-local"
            value={scheduledAtLocal}
            onChange={e => setScheduledAtLocal(e.target.value)}
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-1.5 text-[12px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none"
          />
          <input type="hidden" name="scheduled_at" value={scheduledAtIso} />
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
      )}
    </section>
  )
}

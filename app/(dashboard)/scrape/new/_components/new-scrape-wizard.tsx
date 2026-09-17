'use client'

/**
 * New Scrape wizard — UI PREVIEW ONLY (admin-only, "On Development").
 *
 * One decision per step so it works one-handed on a phone; the same flow
 * renders on tablet and desktop with a live summary beside it. Nothing here
 * calls the backend yet: the final Submit shows the exact payload that the
 * future server action would receive.
 */

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FlaskConical,
  History,
  Info,
  ListPlus,
  Monitor,
  MonitorSmartphone,
  Plus,
  RotateCcw,
  Search,
  Smartphone,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  BING_DISABLED_COUNTRIES,
  ENGINES,
  ENRICHMENT_STAGES,
  MAX_KEYWORDS,
  MAX_KEYWORD_CHARS,
  SCHEDULE_TIMEZONES,
  dayLabel,
  engineDef,
  flagEmoji,
  langName,
  langOptions,
  splitKeywords,
  utcDay,
  wallClockToUtcIso,
  type EngineKey,
  type LastConfig,
  type QuotaPreview,
  type ScrapeDraft,
} from '../_lib/wizard-helpers'
import { QuotaStatus, remainingFor, useResetCountdown } from './quota-status'

export type WizardProfile = {
  country_code: string
  country_name: string
  requires_google_login: boolean
  is_google_logged_in: boolean
  languages: string[]
}

type Props = {
  profiles: WizardProfile[]
  quota: QuotaPreview
  lastConfig: LastConfig | null
  /** Prefill when arriving from "Edit" on the today's-queue page. */
  prefill: Partial<ScrapeDraft> | null
}

type StepKey =
  | 'start'
  | 'config'
  | 'source'
  | 'country'
  | 'language'
  | 'pages'
  | 'view'
  | 'keywords'
  | 'enrichment'
  | 'topn'
  | 'review'

const STEP_TITLES: Record<StepKey, string> = {
  start: 'When',
  config: 'Setup',
  source: 'Source',
  country: 'Country',
  language: 'Language',
  pages: 'Pages',
  view: 'Device',
  keywords: 'Keywords',
  enrichment: 'Enrichment',
  topn: 'Top N',
  review: 'Review',
}

const TOP_N_PRESETS = [10, 25, 50, 100] as const

// ---------------------------------------------------------------- UI bits ----

function Tile({
  selected,
  disabled,
  onClick,
  children,
  className = '',
  title,
}: {
  selected?: boolean | undefined
  disabled?: boolean | undefined
  onClick: () => void
  children: React.ReactNode
  className?: string | undefined
  title?: string | undefined
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-pressed={selected}
      className={[
        'relative flex min-h-[64px] flex-col items-center justify-center gap-1.5 rounded-lg border px-3 py-3 text-center text-[13px] transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent-hover)]',
        selected
          ? 'border-[color:var(--color-accent-hover)] bg-[color:var(--color-accent)]/25 text-[color:var(--color-text-primary)]'
          : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-primary)] hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-secondary)]',
        disabled ? 'cursor-not-allowed opacity-40 hover:bg-[color:var(--color-bg-primary)]' : '',
        className,
      ].join(' ')}
    >
      {selected && (
        <span className="absolute right-1.5 top-1.5 rounded-full bg-[color:var(--color-accent-hover)] p-0.5 text-white">
          <Check className="h-3 w-3" />
        </span>
      )}
      {children}
    </button>
  )
}

function StepHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">{title}</h2>
      {hint && <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">{hint}</p>}
    </div>
  )
}

function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-red-200 bg-red-50 text-red-800'
      : tone === 'warn'
        ? 'border-amber-200 bg-amber-50 text-amber-900'
        : tone === 'ok'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]'
  const Icon = tone === 'error' || tone === 'warn' ? TriangleAlert : tone === 'ok' ? Check : Info
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] ${cls}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function EngineMono({ engine, size = 'md' }: { engine: EngineKey; size?: 'sm' | 'md' }) {
  const def = engineDef(engine)
  if (!def) return null
  return (
    <span
      className={[
        'inline-flex items-center justify-center rounded-full font-semibold ring-1',
        size === 'sm' ? 'h-5 w-5 text-[9px]' : 'h-9 w-9 text-[12px]',
        def.tone,
      ].join(' ')}
    >
      {def.mono}
    </span>
  )
}

// ---------------------------------------------------------------- wizard ----

export function NewScrapeWizard({ profiles, quota, lastConfig, prefill }: Props) {
  const today = utcDay(new Date())

  // ----- state -----
  const [mode, setMode] = useState<'now' | 'schedule' | null>(prefill?.mode ?? null)
  const [scheduledAtLocal, setScheduledAtLocal] = useState('')
  const [scheduleTz, setScheduleTz] = useState(prefill?.schedule_tz ?? 'Europe/Malta')
  const [configChoice, setConfigChoice] = useState<'new' | 'last' | null>(prefill ? 'new' : null)
  const [engine, setEngine] = useState<EngineKey | null>(prefill?.search_engine ?? null)
  const [country, setCountry] = useState<string | null>(prefill?.country_code ?? null)
  const [language, setLanguage] = useState(prefill?.language ?? 'en')
  const [pages, setPages] = useState<number>(prefill?.pages ?? 1)
  const [viewMode, setViewMode] = useState<'both' | 'desktop' | 'mobile' | null>(prefill?.view_mode ?? null)
  const [keywords, setKeywords] = useState<string[]>(prefill?.keywords ?? [])
  const [keywordInput, setKeywordInput] = useState('')
  const [enrichChoice, setEnrichChoice] = useState<'none' | 'stages' | null>(
    prefill ? (prefill.with_enrichment ? 'stages' : 'none') : null,
  )
  const [stages, setStages] = useState<Set<string>>(new Set(prefill?.enrichment_stages ?? []))
  const [topChoice, setTopChoice] = useState<'all' | 'n' | null>(
    prefill?.top_n_by_follower === undefined ? null : prefill.top_n_by_follower === null ? 'all' : 'n',
  )
  const [topN, setTopN] = useState<number>(prefill?.top_n_by_follower ?? 25)
  const [runAnyway, setRunAnyway] = useState<boolean>(prefill?.duplicate_override ?? false)
  const [countryQuery, setCountryQuery] = useState('')
  const [rawStepIndex, setRawStepIndex] = useState(0)
  const [submitted, setSubmitted] = useState<ScrapeDraft | null>(null)
  const [copied, setCopied] = useState(false)
  const keywordRef = useRef<HTMLInputElement>(null)

  const def = engineDef(engine)
  const isSerp = def?.kind === 'serp'
  const isSocial = def?.kind === 'social'
  const profile = profiles.find(p => p.country_code === country) ?? null
  const scheduledAtIso = useMemo(() => wallClockToUtcIso(scheduledAtLocal, scheduleTz), [scheduledAtLocal, scheduleTz])
  const quotaDay = mode === 'schedule' && scheduledAtIso ? utcDay(scheduledAtIso) : today
  const remaining = remainingFor(quota, quotaDay)
  const todayFull = remainingFor(quota, today) === 0 && !quota.exempt
  const countdown = useResetCountdown(todayFull)
  const distinctKeywords = useMemo(() => new Set(keywords.map(k => k.toLowerCase())).size, [keywords])

  // ----- step list depends on choices -----
  const steps = useMemo<StepKey[]>(() => {
    const s: StepKey[] = ['start', 'config']
    if (configChoice === 'last') return [...s, 'keywords', 'review']
    s.push('source', 'country', 'language', 'pages')
    if (isSerp) s.push('view')
    s.push('keywords')
    if (isSerp) s.push('enrichment')
    if (isSocial) s.push('topn')
    s.push('review')
    return s
  }, [configChoice, isSerp, isSocial])

  // Clamp during render, not in an effect: choosing "use last configuration"
  // shortens the step list and must not leave the index past the end.
  const stepIndex = Math.min(rawStepIndex, steps.length - 1)
  const step: StepKey = steps[stepIndex] ?? 'start'

  // Wall clock for "is that time in the past?" checks. Kept in state and
  // refreshed on a timer so render stays pure and the message updates
  // if the user leaves the page open.
  const [nowMs, setNowMs] = useState(0)
  useEffect(() => {
    const tick = () => setNowMs(Date.now())
    tick()
    const id = setInterval(tick, 30_000)
    return () => clearInterval(id)
  }, [])

  // ----- apply "use last configuration" -----
  function applyLast() {
    if (!lastConfig) return
    setConfigChoice('last')
    const eng = engineDef(lastConfig.search_engine)?.key ?? 'google'
    setEngine(eng)
    setCountry(lastConfig.country_code)
    setLanguage(lastConfig.language || 'en')
    setPages(lastConfig.pages || 1)
    setViewMode(lastConfig.view_mode || 'both')
    setKeywords(lastConfig.keywords)
    if (engineDef(eng)?.kind === 'serp') {
      setEnrichChoice(lastConfig.with_enrichment ? 'stages' : 'none')
      setStages(new Set(lastConfig.with_enrichment ? ['affiliate', 'rooster'] : []))
    } else {
      setTopChoice(lastConfig.top_n_by_follower === null ? 'all' : 'n')
      if (lastConfig.top_n_by_follower !== null) setTopN(lastConfig.top_n_by_follower)
    }
  }

  // ----- validation per step -----
  function validate(k: StepKey): { ok: boolean; message?: string } {
    switch (k) {
      case 'start': {
        if (!mode) return { ok: false, message: 'Choose when this scrape should run.' }
        if (mode === 'now' && todayFull) return { ok: false, message: `Today's limit is used up. It resets in ${countdown}.` }
        if (mode === 'schedule') {
          if (!scheduledAtIso) return { ok: false, message: 'Pick a date and time.' }
          if (nowMs > 0 && new Date(scheduledAtIso).getTime() <= nowMs) return { ok: false, message: 'That time is in the past.' }
          if (remaining === 0 && !quota.exempt) return { ok: false, message: `No quota left for ${dayLabel(quotaDay).toLowerCase()}.` }
        }
        return { ok: true }
      }
      case 'config':
        return configChoice ? { ok: true } : { ok: false, message: 'Start fresh or reuse your last setup.' }
      case 'source':
        return engine ? { ok: true } : { ok: false, message: 'Pick a source.' }
      case 'country': {
        if (!country) return { ok: false, message: 'Pick a country.' }
        if (engine === 'bing' && BING_DISABLED_COUNTRIES.has(country)) return { ok: false, message: 'Bing has too little coverage for this country. Pick another country or use Google.' }
        return { ok: true }
      }
      case 'language':
        return language ? { ok: true } : { ok: false, message: 'Pick a language.' }
      case 'pages':
        return pages >= 1 && pages <= 10 ? { ok: true } : { ok: false, message: 'Pages must be 1 to 10.' }
      case 'view':
        return viewMode ? { ok: true } : { ok: false, message: 'Choose desktop, mobile or both.' }
      case 'keywords': {
        if (keywords.length === 0) return { ok: false, message: 'Add at least one keyword.' }
        if (keywords.length > MAX_KEYWORDS) return { ok: false, message: `At most ${MAX_KEYWORDS} keywords per scrape.` }
        const long = keywords.find(k => k.length > MAX_KEYWORD_CHARS)
        if (long) return { ok: false, message: `"${long.slice(0, 40)}…" is longer than ${MAX_KEYWORD_CHARS} characters.` }
        return { ok: true }
      }
      case 'enrichment':
        if (!enrichChoice) return { ok: false, message: 'Choose no enrichment or pick stages.' }
        if (enrichChoice === 'stages' && stages.size === 0) return { ok: false, message: 'Pick at least one stage.' }
        return { ok: true }
      case 'topn':
        if (!topChoice) return { ok: false, message: 'Choose how many to keep.' }
        if (topChoice === 'n' && (!Number.isInteger(topN) || topN < 1)) return { ok: false, message: 'Enter a whole number of 1 or more.' }
        return { ok: true }
      case 'review': {
        if (remaining !== null && !quota.exempt && distinctKeywords > remaining) {
          return { ok: false, message: `This needs ${distinctKeywords} keywords but only ${remaining} remain for ${dayLabel(quotaDay).toLowerCase()}.` }
        }
        return { ok: true }
      }
    }
  }
  const current = validate(step)
  const isLast = stepIndex === steps.length - 1

  function next() {
    if (!current.ok) return
    if (isLast) {
      setSubmitted(buildDraft())
      return
    }
    setRawStepIndex(i => Math.min(i + 1, steps.length - 1))
  }
  function back() {
    setRawStepIndex(i => Math.max(i - 1, 0))
  }

  function buildDraft(): ScrapeDraft {
    return {
      mode: mode ?? 'now',
      scheduled_at: mode === 'schedule' ? scheduledAtIso : null,
      schedule_tz: scheduleTz,
      search_engine: engine ?? 'google',
      country_code: country ?? '',
      language,
      pages,
      view_mode: isSerp ? (viewMode ?? 'both') : 'both',
      keywords,
      enrichment_stages: isSerp && enrichChoice === 'stages' ? [...stages] : [],
      with_enrichment: isSerp && enrichChoice === 'stages' && stages.size > 0,
      top_n_by_follower: isSocial ? (topChoice === 'n' ? topN : null) : null,
      duplicate_override: runAnyway,
    }
  }

  // ----- keywords -----
  function addKeywords(text: string) {
    const fresh = splitKeywords(text, keywords)
    if (!fresh.length) return
    setKeywords(prev => [...prev, ...fresh].slice(0, MAX_KEYWORDS))
    setKeywordInput('')
  }
  function removeKeyword(k: string) {
    setKeywords(prev => prev.filter(x => x !== k))
  }

  function resetAll() {
    setSubmitted(null)
    setRawStepIndex(0)
    setMode(null)
    setScheduledAtLocal('')
    setConfigChoice(null)
    setEngine(null)
    setCountry(null)
    setLanguage('en')
    setPages(1)
    setViewMode(null)
    setKeywords([])
    setEnrichChoice(null)
    setStages(new Set())
    setTopChoice(null)
    setRunAnyway(false)
  }

  async function copyPayload() {
    if (!submitted) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(submitted, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — the payload is still visible on screen */
    }
  }

  const filteredProfiles = useMemo(() => {
    const q = countryQuery.trim().toLowerCase()
    if (!q) return profiles
    return profiles.filter(p => p.country_name.toLowerCase().includes(q) || p.country_code.toLowerCase().includes(q))
  }, [profiles, countryQuery])

  // ---------------------------------------------------------------- render ----

  if (submitted) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-4 md:px-6 md:py-6">
        <Header quota={quota} day={quotaDay} />
        <div className="mt-4 flex flex-col gap-3">
          <Note tone="ok">
            <span className="font-medium">Preview only.</span> Nothing was queued. This is exactly what the scrape would send once the backend is connected.
          </Note>
          <SummaryCard draft={submitted} profile={profile} />
          <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
            <div className="flex items-center justify-between border-b border-[color:var(--color-border)] px-3 py-2">
              <span className="text-[12px] font-medium text-[color:var(--color-text-secondary)]">Payload</span>
              <button type="button" onClick={copyPayload} className="inline-flex items-center gap-1 text-[12px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]">
                <Copy className="h-3.5 w-3.5" /> {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="overflow-x-auto p-3 text-[11px] leading-relaxed text-[color:var(--color-text-primary)]">{JSON.stringify(submitted, null, 2)}</pre>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={resetAll} className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] hover:bg-[color:var(--color-bg-secondary)]">
              <RotateCcw className="h-3.5 w-3.5" /> Start another
            </button>
            <Link href="/scrape/today" className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] hover:bg-[color:var(--color-bg-secondary)]">
              Today&rsquo;s scraping list
            </Link>
            <Link href="/scrape" className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[13px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Scrape
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-4 md:px-6 md:py-6">
      <Header quota={quota} day={quotaDay} />

      {/* Progress */}
      <ol className="no-scrollbar mt-4 flex gap-1.5 overflow-x-auto pb-1" aria-label="Steps">
        {steps.map((k, i) => {
          const done = i < stepIndex
          const active = i === stepIndex
          return (
            <li key={k} className="shrink-0">
              <button
                type="button"
                onClick={() => { if (done) setRawStepIndex(i) }}
                disabled={!done && !active}
                className={[
                  'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium',
                  active
                    ? 'bg-[color:var(--color-text-primary)] text-white'
                    : done
                      ? 'bg-[color:var(--color-accent)]/30 text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/50'
                      : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
                ].join(' ')}
              >
                <span className="tabular-nums">{i + 1}</span>
                <span>{STEP_TITLES[k]}</span>
                {done && <Check className="h-3 w-3" />}
              </button>
            </li>
          )
        })}
      </ol>

      <div className="mt-4 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start lg:gap-6">
        {/* Step card */}
        <section className="flex min-h-[420px] flex-col rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
          <div className="flex-1 p-4 md:p-6">
            {step === 'start' && (
              <>
                <StepHeading title="When should this scrape run?" hint="Queue it now, or pick a later time. Scheduled scrapes use that day's quota." />
                <div className="grid grid-cols-2 gap-3">
                  <Tile selected={mode === 'now'} onClick={() => setMode('now')} disabled={todayFull}>
                    <ListPlus className="h-6 w-6" />
                    <span className="font-medium">Add to queue now</span>
                    <span className="text-[11px] text-[color:var(--color-text-secondary)]">Starts as soon as a worker is free</span>
                  </Tile>
                  <Tile selected={mode === 'schedule'} onClick={() => setMode('schedule')}>
                    <CalendarClock className="h-6 w-6" />
                    <span className="font-medium">Schedule for later</span>
                    <span className="text-[11px] text-[color:var(--color-text-secondary)]">Runs at a time you choose</span>
                  </Tile>
                </div>
                {todayFull && (
                  <div className="mt-3">
                    <Note tone="error">
                      Today&rsquo;s {quota.cap} keywords are used up. You can queue again in <span className="font-mono tabular-nums">{countdown}</span> (UTC midnight), or schedule for another day below.
                    </Note>
                  </div>
                )}
                {mode === 'schedule' && (
                  <div className="mt-4 flex flex-col gap-3">
                    <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                      <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
                        Date and time
                        <input
                          id="scheduled_at_local"
                          type="datetime-local"
                          value={scheduledAtLocal}
                          onChange={e => setScheduledAtLocal(e.target.value)}
                          className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]">
                        Timezone
                        <select
                          id="schedule_tz"
                          value={scheduleTz}
                          onChange={e => setScheduleTz(e.target.value)}
                          className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
                        >
                          {SCHEDULE_TIMEZONES.map(tz => (
                            <option key={tz.value} value={tz.value}>{tz.label}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {scheduledAtIso && (
                      <p className="text-[12px] text-[color:var(--color-text-secondary)]">
                        Runs {new Date(scheduledAtIso).toLocaleString()} your time · counts against <span className="font-medium text-[color:var(--color-text-primary)]">{dayLabel(quotaDay)}</span>&rsquo;s quota
                      </p>
                    )}
                    <Note>
                      Scheduling for another day deducts that day&rsquo;s quota straight away, so different days can have different amounts left.
                    </Note>
                    <QuotaStatus quota={quota} day={quotaDay} variant="full" />
                  </div>
                )}
              </>
            )}

            {step === 'config' && (
              <>
                <StepHeading title="Start fresh or reuse your last setup?" hint="Reusing skips straight to the keywords. Everything else stays as it was." />
                <div className="grid grid-cols-2 gap-3">
                  <Tile selected={configChoice === 'new'} onClick={() => { setConfigChoice('new'); }}>
                    <Plus className="h-6 w-6" />
                    <span className="font-medium">Create new</span>
                    <span className="text-[11px] text-[color:var(--color-text-secondary)]">Choose every option</span>
                  </Tile>
                  <Tile selected={configChoice === 'last'} onClick={applyLast} disabled={!lastConfig} title={lastConfig ? undefined : 'No previous scrape found for your account'}>
                    <History className="h-6 w-6" />
                    <span className="font-medium">Use last configuration</span>
                    <span className="text-[11px] text-[color:var(--color-text-secondary)]">{lastConfig ? 'Only change the keywords' : 'Nothing to reuse yet'}</span>
                  </Tile>
                </div>
                {lastConfig && (
                  <div className="mt-4 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-3 text-[12px]">
                    <div className="mb-1.5 font-medium text-[color:var(--color-text-primary)]">Your last scrape · {new Date(lastConfig.created_at).toLocaleString()}</div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[color:var(--color-text-secondary)]">
                      <span className="inline-flex items-center gap-1.5">
                        <EngineMono engine={(engineDef(lastConfig.search_engine)?.key ?? 'google')} size="sm" />
                        {engineDef(lastConfig.search_engine)?.label ?? lastConfig.search_engine}
                      </span>
                      <span>{flagEmoji(lastConfig.country_code)} {profiles.find(p => p.country_code === lastConfig.country_code)?.country_name ?? lastConfig.country_code}</span>
                      <span>{langName(lastConfig.language)}</span>
                      <span>{lastConfig.pages} page{lastConfig.pages === 1 ? '' : 's'}</span>
                      <span>{lastConfig.view_mode}</span>
                      <span>{lastConfig.with_enrichment ? 'with enrichment' : 'no enrichment'}</span>
                      <span>{lastConfig.keywords.length} keyword{lastConfig.keywords.length === 1 ? '' : 's'}</span>
                    </div>
                  </div>
                )}
              </>
            )}

            {step === 'source' && (
              <>
                <StepHeading title="Where should we search?" hint="Google and Bing produce leads. The others find channels and creators." />
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
                  {ENGINES.map(e => (
                    <Tile
                      key={e.key}
                      selected={engine === e.key}
                      onClick={() => {
                        setEngine(e.key)
                        if (e.kind === 'social') { setEnrichChoice(null); setStages(new Set()); setViewMode(null) }
                        if (e.kind === 'serp') setTopChoice(null)
                      }}
                      title={e.hint}
                    >
                      <EngineMono engine={e.key} />
                      <span className="text-[12px] font-medium">{e.label}</span>
                    </Tile>
                  ))}
                </div>
                {def && <p className="mt-3 text-[12px] text-[color:var(--color-text-secondary)]">{def.hint}.</p>}
              </>
            )}

            {step === 'country' && (
              <>
                <StepHeading title="Which country?" hint="The scrape runs through that country's browser profile and proxy." />
                {lastConfig && lastConfig.country_code !== country && (
                  <button
                    type="button"
                    onClick={() => { setCountry(lastConfig.country_code); setLanguage('en') }}
                    className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-3 py-1 text-[12px] hover:border-[color:var(--color-border-strong)]"
                  >
                    <History className="h-3.5 w-3.5" /> Use last: {flagEmoji(lastConfig.country_code)} {profiles.find(p => p.country_code === lastConfig.country_code)?.country_name ?? lastConfig.country_code}
                  </button>
                )}
                <label className="mb-3 flex items-center gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] focus-within:border-[color:var(--color-accent)]">
                  <Search className="h-4 w-4 text-[color:var(--color-text-secondary)]" />
                  <input
                    id="country_search"
                    value={countryQuery}
                    onChange={e => setCountryQuery(e.target.value)}
                    placeholder="Find a country"
                    className="w-full bg-transparent outline-none placeholder:text-[color:var(--color-text-secondary)]"
                  />
                </label>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                  {filteredProfiles.map(p => {
                    const bingOff = engine === 'bing' && BING_DISABLED_COUNTRIES.has(p.country_code)
                    return (
                      <Tile
                        key={p.country_code}
                        selected={country === p.country_code}
                        disabled={bingOff}
                        onClick={() => { setCountry(p.country_code); setLanguage('en') }}
                        title={bingOff ? 'Bing is not available for this country' : p.requires_google_login ? (p.is_google_logged_in ? 'Google login active' : 'Needs Google login') : undefined}
                      >
                        <span className="text-2xl leading-none">{flagEmoji(p.country_code)}</span>
                        <span className="text-[12px] font-medium">{p.country_name}</span>
                        <span className="text-[10px] text-[color:var(--color-text-secondary)]">{p.country_code}</span>
                      </Tile>
                    )
                  })}
                  {filteredProfiles.length === 0 && (
                    <p className="col-span-full text-[12px] text-[color:var(--color-text-secondary)]">No country matches &ldquo;{countryQuery}&rdquo;.</p>
                  )}
                </div>
              </>
            )}

            {step === 'language' && (
              <>
                <StepHeading title="Which language?" hint={`Languages configured for ${profile?.country_name ?? 'this country'}. English is the default.`} />
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                  {langOptions(profile?.languages).map(code => (
                    <Tile key={code} selected={language === code} onClick={() => setLanguage(code)}>
                      <span className="text-[13px] font-medium">{langName(code)}</span>
                      <span className="text-[10px] uppercase text-[color:var(--color-text-secondary)]">{code}</span>
                    </Tile>
                  ))}
                </div>
              </>
            )}

            {step === 'pages' && (
              <>
                <StepHeading title="How many result pages?" hint="Each page is about 10 results. Ads only appear on page 1." />
                <div className="grid grid-cols-5 gap-2">
                  {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                    <Tile key={n} selected={pages === n} onClick={() => setPages(n)} className="min-h-[52px]">
                      <span className="text-[16px] font-semibold tabular-nums">{n}</span>
                    </Tile>
                  ))}
                </div>
              </>
            )}

            {step === 'view' && (
              <>
                <StepHeading title="Which device view?" hint="Many casino campaigns only show ads on mobile, so Both is the safe default." />
                <div className="grid grid-cols-3 gap-3">
                  <Tile selected={viewMode === 'both'} onClick={() => setViewMode('both')}>
                    <MonitorSmartphone className="h-6 w-6" />
                    <span className="font-medium">Both</span>
                  </Tile>
                  <Tile selected={viewMode === 'desktop'} onClick={() => setViewMode('desktop')}>
                    <Monitor className="h-6 w-6" />
                    <span className="font-medium">Desktop only</span>
                  </Tile>
                  <Tile selected={viewMode === 'mobile'} onClick={() => setViewMode('mobile')}>
                    <Smartphone className="h-6 w-6" />
                    <span className="font-medium">Mobile only</span>
                  </Tile>
                </div>
              </>
            )}

            {step === 'keywords' && (
              <>
                <StepHeading
                  title={configChoice === 'last' ? 'Keep or change the keywords' : 'What should we search for?'}
                  hint="Type one and press Enter, or paste a list. Line breaks and commas split into separate keywords."
                />
                <div className="flex gap-2">
                  <input
                    id="keyword_input"
                    ref={keywordRef}
                    value={keywordInput}
                    onChange={e => setKeywordInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addKeywords(keywordInput) } }}
                    onPaste={e => {
                      const text = e.clipboardData.getData('text')
                      if (/[\r\n;,]/.test(text)) { e.preventDefault(); addKeywords(text) }
                    }}
                    placeholder="e.g. online casino echtgeld"
                    maxLength={MAX_KEYWORD_CHARS}
                    className="min-w-0 flex-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
                  />
                  <button
                    type="button"
                    onClick={() => addKeywords(keywordInput)}
                    disabled={!keywordInput.trim()}
                    className="inline-flex items-center gap-1 rounded-md bg-[color:var(--color-text-primary)] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-40"
                  >
                    <Plus className="h-4 w-4" /> Add
                  </button>
                </div>
                <div className="mt-3 flex items-center justify-between text-[11px] text-[color:var(--color-text-secondary)]">
                  <span>{keywords.length} of {MAX_KEYWORDS} keywords</span>
                  {keywords.length > 0 && (
                    <button type="button" onClick={() => setKeywords([])} className="hover:text-[color:var(--color-text-primary)]">Clear all</button>
                  )}
                </div>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {keywords.map(k => (
                    <li key={k} className="inline-flex max-w-full items-center gap-1 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] py-1 pl-3 pr-1 text-[12px]">
                      <span className="truncate">{k}</span>
                      <button type="button" onClick={() => removeKeyword(k)} aria-label={`Remove ${k}`} className="rounded-full p-0.5 text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-border)] hover:text-[color:var(--color-text-primary)]">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
                {remaining !== null && distinctKeywords > 0 && (
                  <div className="mt-3">
                    <Note tone={distinctKeywords > remaining && !quota.exempt ? 'error' : 'info'}>
                      This uses <span className="font-medium">{distinctKeywords}</span> of your <span className="font-medium">{remaining}</span> remaining keywords for {dayLabel(quotaDay).toLowerCase()}.
                    </Note>
                  </div>
                )}
              </>
            )}

            {step === 'enrichment' && (
              <>
                <StepHeading title="Enrich the results?" hint="The Monday duplicate check always runs. Pick the extra stages you want." />
                <div className="grid grid-cols-2 gap-3">
                  <Tile selected={enrichChoice === 'none'} onClick={() => { setEnrichChoice('none'); setStages(new Set()) }}>
                    <X className="h-6 w-6" />
                    <span className="font-medium">No enrichment</span>
                    <span className="text-[11px] text-[color:var(--color-text-secondary)]">Just the results list</span>
                  </Tile>
                  <Tile selected={enrichChoice === 'stages'} onClick={() => setEnrichChoice('stages')}>
                    <FlaskConical className="h-6 w-6" />
                    <span className="font-medium">Choose stages</span>
                    <span className="text-[11px] text-[color:var(--color-text-secondary)]">One or more below</span>
                  </Tile>
                </div>
                {enrichChoice === 'stages' && (
                  <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                    {ENRICHMENT_STAGES.map(s => {
                      const on = stages.has(s.key)
                      return (
                        <li key={s.key}>
                          <button
                            type="button"
                            aria-pressed={on}
                            onClick={() => setStages(prev => { const n = new Set(prev); if (n.has(s.key)) n.delete(s.key); else n.add(s.key); return n })}
                            className={[
                              'flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors',
                              on ? 'border-[color:var(--color-accent-hover)] bg-[color:var(--color-accent)]/25' : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] hover:bg-[color:var(--color-bg-secondary)]',
                            ].join(' ')}
                          >
                            <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? 'border-[color:var(--color-accent-hover)] bg-[color:var(--color-accent-hover)] text-white' : 'border-[color:var(--color-border-strong)]'}`}>
                              {on && <Check className="h-3 w-3" />}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-[13px] font-medium">{s.label}</span>
                              <span className="block text-[11px] text-[color:var(--color-text-secondary)]">{s.hint}</span>
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </>
            )}

            {step === 'topn' && (
              <>
                <StepHeading title="How many to keep?" hint={`Keep only the biggest ${def?.label ?? ''} accounts by follower count, or all of them.`} />
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {TOP_N_PRESETS.map(n => (
                    <Tile key={n} selected={topChoice === 'n' && topN === n} onClick={() => { setTopChoice('n'); setTopN(n) }} className="min-h-[52px]">
                      <span className="text-[15px] font-semibold tabular-nums">Top {n}</span>
                    </Tile>
                  ))}
                  <Tile selected={topChoice === 'all'} onClick={() => setTopChoice('all')} className="min-h-[52px]">
                    <span className="text-[15px] font-semibold">All</span>
                  </Tile>
                </div>
                <label className="mt-3 flex items-center gap-2 text-[12px] text-[color:var(--color-text-secondary)]">
                  Or a custom number
                  <input
                    id="top_n_custom"
                    type="number"
                    min={1}
                    value={topChoice === 'n' ? topN : ''}
                    onChange={e => { setTopChoice('n'); setTopN(Number(e.target.value)) }}
                    className="w-24 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1.5 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none"
                  />
                </label>
              </>
            )}

            {step === 'review' && (
              <>
                <StepHeading title="Check and start" hint="Here is what will be queued. Go back to any step to change it." />
                <SummaryCard draft={buildDraft()} profile={profile} />
                <div className="mt-3 flex flex-col gap-3">
                  {remaining !== null && (
                    <Note tone={!quota.exempt && distinctKeywords > remaining ? 'error' : 'ok'}>
                      Uses <span className="font-medium">{distinctKeywords}</span> of <span className="font-medium">{remaining}</span> remaining keywords for {dayLabel(quotaDay).toLowerCase()}.
                      {quota.exempt && ' You are exempt from the cap, so this is informational.'}
                    </Note>
                  )}
                  <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-3">
                    <div className="text-[12px] font-medium text-[color:var(--color-text-primary)]">Duplicate check</div>
                    <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
                      When you submit, keywords that already completed for {profile?.country_name ?? 'this country'} on {def?.label ?? 'this engine'} will be listed and you can decide. Tick below to skip that question and run everything anyway.
                    </p>
                    <label className="mt-2 flex items-center gap-2 text-[13px]">
                      <input id="run_anyway" type="checkbox" checked={runAnyway} onChange={e => setRunAnyway(e.target.checked)} className="h-4 w-4 accent-[color:var(--color-accent-hover)]" />
                      Run anyway if duplicates are found
                    </label>
                  </div>
                  <Note>Preview build: Submit shows the payload and queues nothing yet.</Note>
                </div>
              </>
            )}
          </div>

          {/* Nav bar: sticky on phones so Back / Next stay under the thumb */}
          <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-b-xl border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]/95 px-4 py-3 backdrop-blur md:static">
            <button
              type="button"
              onClick={back}
              disabled={stepIndex === 0}
              className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)] disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" /> Back
            </button>
            <div className="min-w-0 flex-1 text-center text-[11px] text-[color:var(--color-text-secondary)]">
              {!current.ok && current.message ? <span className="text-amber-800">{current.message}</span> : <span>Step {stepIndex + 1} of {steps.length}</span>}
            </div>
            <button
              type="button"
              onClick={next}
              disabled={!current.ok}
              className="inline-flex items-center gap-1 rounded-md bg-[color:var(--color-text-primary)] px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
            >
              {isLast ? (mode === 'schedule' ? 'Schedule scrape' : 'Start scraping') : 'Next'}
              {!isLast && <ChevronRight className="h-4 w-4" />}
            </button>
          </div>
        </section>

        {/* Live summary (desktop) */}
        <aside className="hidden lg:block">
          <div className="sticky top-4 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]/70">Your scrape so far</div>
            <SummaryList draft={buildDraft()} profile={profile} partial />
          </div>
        </aside>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- pieces ----

function Header({ quota, day }: { quota: QuotaPreview; day: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="mb-1 inline-flex items-center gap-1.5 rounded-full bg-[color:var(--color-accent)]/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-text-primary)]">
          <FlaskConical className="h-3 w-3" /> On development
        </div>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">New scrape</h1>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">One choice per step. Works the same on phone, tablet and desktop.</p>
      </div>
      <QuotaStatus quota={quota} day={day} />
    </div>
  )
}

function SummaryList({ draft, profile, partial = false }: { draft: ScrapeDraft; profile: WizardProfile | null; partial?: boolean }) {
  const def = engineDef(draft.search_engine)
  const rows: Array<[string, React.ReactNode]> = [
    ['When', draft.mode === 'schedule' ? (draft.scheduled_at ? new Date(draft.scheduled_at).toLocaleString() : 'Scheduled') : 'Now'],
    ['Source', def ? <span className="inline-flex items-center gap-1.5"><EngineMono engine={def.key} size="sm" />{def.label}</span> : '—'],
    ['Country', draft.country_code ? `${flagEmoji(draft.country_code)} ${profile?.country_name ?? draft.country_code}` : '—'],
    ['Language', draft.language ? langName(draft.language) : '—'],
    ['Pages', String(draft.pages)],
  ]
  if (def?.kind === 'serp') rows.push(['Device', draft.view_mode])
  rows.push(['Keywords', draft.keywords.length ? `${draft.keywords.length}: ${draft.keywords.slice(0, 3).join(', ')}${draft.keywords.length > 3 ? '…' : ''}` : '—'])
  if (def?.kind === 'serp') rows.push(['Enrichment', draft.with_enrichment ? draft.enrichment_stages.map(k => ENRICHMENT_STAGES.find(s => s.key === k)?.label ?? k).join(', ') : 'None'])
  if (def?.kind === 'social') rows.push(['Keep', draft.top_n_by_follower === null ? 'All' : `Top ${draft.top_n_by_follower} by followers`])
  rows.push(['Duplicates', draft.duplicate_override ? 'Run anyway' : 'Ask me'])
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[color:var(--color-text-secondary)]">{k}</dt>
          <dd className={`min-w-0 truncate text-[color:var(--color-text-primary)] ${partial && v === '—' ? 'opacity-40' : ''}`}>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function SummaryCard({ draft, profile }: { draft: ScrapeDraft; profile: WizardProfile | null }) {
  return (
    <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
      <SummaryList draft={draft} profile={profile} />
      {draft.keywords.length > 3 && (
        <details className="mt-2 text-[12px]">
          <summary className="cursor-pointer text-[color:var(--color-text-secondary)]">All {draft.keywords.length} keywords</summary>
          <ul className="mt-1 flex flex-wrap gap-1">
            {draft.keywords.map(k => (
              <li key={k} className="rounded-full bg-[color:var(--color-bg-secondary)] px-2 py-0.5">{k}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

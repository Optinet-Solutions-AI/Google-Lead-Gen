'use client'

/**
 * New Scrape wizard — the real way to queue a scrape, replacing the old
 * inline form on /scrape.
 *
 * Picking an option moves to the next step, so there is no Next button on
 * single-choice steps. Progress is written to this browser after every change,
 * so a refresh or an interruption resumes instead of starting over. Submit
 * calls the same `enqueueScrape` server action the old form used.
 */

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from 'react'
import {
  ArrowLeft,
  CalendarClock,
  Check,
  ChevronLeft,
  FlaskConical,
  ListPlus,
  Monitor,
  MonitorSmartphone,
  Pencil,
  Plus,
  Search,
  Smartphone,
  Star,
  X,
} from 'lucide-react'
import { enqueueScrape, type DuplicateHit } from '../../actions'
import { DuplicateWarning } from '../../_components/duplicate-warning'
import { Modal } from '../../../_components/modal'
import {
  ALL_STAGE_KEYS,
  BING_DISABLED_COUNTRIES,
  DEFAULT_ENGINE,
  ENGINES,
  ENRICHMENT_STAGES,
  MAX_KEYWORDS,
  MAX_KEYWORD_CHARS,
  SCHEDULE_TIMEZONES,
  clearStored,
  dayLabel,
  draftKey,
  engineDef,
  langName,
  langOptions,
  lastStagesKey,
  parseDraft,
  parseSavedConfig,
  parseStageList,
  readStored,
  savedConfigKey,
  splitKeywords,
  utcDay,
  wallClockToUtcIso,
  writeStored,
  type EngineKey,
  type QuotaPreview,
  type SavedConfig,
  type ScrapeDraft,
  type WizardDraft,
} from '../_lib/wizard-helpers'
import { Flag } from '../../../_components/flag'
import { SourceIcon } from '../../../_components/source-icon'
import { QuotaStatus, remainingFor, useResetCountdown } from './quota-status'
import { QueueTicket, type QueueEstimate } from './queue-ticket'

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
  /** Namespaces this browser's saved setup and draft to the signed-in user. */
  userKey: string
  prefill: Partial<ScrapeDraft> | null
  /** Live queue depth per country, for the ticket's position and wait. */
  queueByCountry: Record<string, QueueEstimate>
  totalPending: number
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
  | 'save'
  | 'review'

const TOP_N_PRESETS = [10, 25, 50, 100] as const
const emptySubscribe = () => () => {}

/** True from the `lg` breakpoint up. Used to render EITHER the desktop form
 *  or the stepper — never both. Rendering both and hiding one with CSS would
 *  duplicate every element id and ref in the DOM, which breaks
 *  label-to-input association and sends focus() to the hidden copy. */
const DESKTOP_QUERY = '(min-width: 1024px)'
const subscribeDesktop = (cb: () => void) => {
  const m = window.matchMedia(DESKTOP_QUERY)
  m.addEventListener('change', cb)
  return () => m.removeEventListener('change', cb)
}

function defaultDraft(): WizardDraft {
  return {
    v: 1,
    stepIndex: 0,
    touched: [],
    mode: 'now',
    scheduledAtLocal: '',
    scheduleTz: 'Europe/Malta',
    configChoice: null,
    engine: DEFAULT_ENGINE,
    country: null,
    language: 'en',
    pages: 1,
    viewMode: 'both',
    keywords: [],
    enrichChoice: 'none',
    stages: [],
    topChoice: null,
    topN: 25,
    runAnyway: false,
    saveConfig: false,
  }
}

// ---------------------------------------------------------------- UI bits ----

/**
 * One option.
 *
 * `selected` means the operator actually picked this — it fills in and gets a
 * check. `isDefault` only suggests, with a dashed outline and no check, so a
 * step never looks answered before it is.
 */
function Tile({
  selected,
  isDefault,
  disabled,
  onClick,
  children,
  className = '',
  title,
}: {
  selected?: boolean | undefined
  isDefault?: boolean | undefined
  disabled?: boolean | undefined
  onClick: () => void
  children: React.ReactNode
  className?: string | undefined
  title?: string | undefined
}) {
  const suggested = isDefault && !selected
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-pressed={selected ?? false}
      className={[
        'relative flex min-h-[58px] flex-col items-center justify-center gap-1 rounded-lg border px-3 py-2.5 text-center transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent-hover)]',
        selected
          ? 'border-[color:var(--color-accent-hover)] bg-[color:var(--color-accent)]/25 text-[color:var(--color-text-primary)]'
          : suggested
            ? 'border-dashed border-[color:var(--color-accent-hover)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]'
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

/** One labelled band inside a desktop column. Bands share a card and are
 *  separated by a rule, rather than each floating in its own box. The
 *  stepper supplies its own heading per step; here the band label carries
 *  it, and the step's explainer text is hidden (see StepHeading). */
function FormRow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col p-4">
      <h2 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">
        {title}
      </h2>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

function StepHeading({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3">
      {/* The desktop form shows every section at once and labels them in its
          own headers, so the stepper's big title + explainer would be noise
          there. Both are hidden from `lg` up. */}
      <h2 className="text-[17px] font-semibold text-[color:var(--color-text-primary)] lg:hidden">{title}</h2>
      {children && (
        <div className="mt-1 text-[13px] leading-relaxed text-[color:var(--color-text-secondary)] lg:hidden">{children}</div>
      )}
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
  return <div className={`rounded-md border px-3 py-2 text-[12.5px] leading-relaxed ${cls}`}>{children}</div>
}

function EngineMono({ engine, size = 'md' }: { engine: EngineKey; size?: 'sm' | 'md' }) {
  const def = engineDef(engine)
  if (!def) return null
  // Real brand marks where Simple Icons has one; the tinted ring keeps the
  // shape consistent for Bing, which has no icon.
  return (
    <span
      className={[
        'inline-flex items-center justify-center rounded-full ring-1',
        size === 'sm' ? 'h-5 w-5' : 'h-8 w-8',
        def.tone,
      ].join(' ')}
    >
      <SourceIcon engine={engine} className={size === 'sm' ? 'h-3 w-3' : 'h-4 w-4'} tinted={false} />
    </span>
  )
}

// ---------------------------------------------------------------- wizard ----

export function NewScrapeWizard({ profiles, quota, userKey, prefill, queueByCountry, totalPending }: Props) {
  const isClient = useSyncExternalStore(emptySubscribe, () => true, () => false)
  const isDesktop = useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  )
  const today = utcDay(new Date())

  // Restored once, during the first client render — never in an effect.
  const [restored] = useState(() => {
    if (typeof window === 'undefined' || prefill) return null
    return readStored(draftKey(userKey), parseDraft)
  })
  const [savedConfig, setSavedConfig] = useState<SavedConfig | null>(() =>
    typeof window === 'undefined' ? null : readStored(savedConfigKey(userKey), parseSavedConfig),
  )
  const [rememberedStages] = useState<string[]>(() =>
    typeof window === 'undefined' ? [] : (readStored(lastStagesKey(userKey), parseStageList) ?? []),
  )

  const base = defaultDraft()
  const start: WizardDraft = restored ?? {
    ...base,
    ...(prefill
      ? {
          mode: prefill.mode ?? 'now',
          scheduleTz: prefill.schedule_tz ?? base.scheduleTz,
          engine: prefill.search_engine ?? base.engine,
          country: prefill.country_code ?? null,
          language: prefill.language ?? 'en',
          pages: prefill.pages ?? 1,
          viewMode: prefill.view_mode ?? 'both',
          keywords: prefill.keywords ?? [],
          enrichChoice: prefill.with_enrichment ? ('stages' as const) : ('none' as const),
          stages: prefill.enrichment_stages ?? [],
          configChoice: 'new' as const,
        }
      : {}),
  }

  const [stepIdx, setStepIdx] = useState(start.stepIndex)
  const [touched, setTouched] = useState<string[]>(start.touched)
  const [mode, setMode] = useState(start.mode)
  const [scheduledAtLocal, setScheduledAtLocal] = useState(start.scheduledAtLocal)
  const [scheduleTz, setScheduleTz] = useState(start.scheduleTz)
  const [configChoice, setConfigChoice] = useState(start.configChoice)
  const [engine, setEngine] = useState<EngineKey>(start.engine)
  const [country, setCountry] = useState(start.country)
  const [language, setLanguage] = useState(start.language)
  const [pages, setPages] = useState(start.pages)
  const [viewMode, setViewMode] = useState(start.viewMode)
  const [keywords, setKeywords] = useState<string[]>(start.keywords)
  const [enrichChoice, setEnrichChoice] = useState(start.enrichChoice)
  const [stages, setStages] = useState<string[]>(start.stages.length ? start.stages : rememberedStages)
  const [topChoice, setTopChoice] = useState(start.topChoice)
  const [topN, setTopN] = useState(start.topN)
  const [runAnyway, setRunAnyway] = useState(start.runAnyway)
  const [saveConfig, setSaveConfig] = useState(start.saveConfig)

  const [keywordInput, setKeywordInput] = useState('')
  const [countryQuery, setCountryQuery] = useState('')
  const [submitted, setSubmitted] = useState<ScrapeDraft | null>(null)
  const [ticketRef, setTicketRef] = useState('—')
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [duplicateWarning, setDuplicateWarning] = useState<{ duplicates: DuplicateHit[]; freshCount: number } | null>(null)
  const [isPending, startTransition] = useTransition()
  const [dismissedResume, setDismissedResume] = useState(false)
  const keywordRef = useRef<HTMLInputElement>(null)

  // Wall clock for past-time checks, refreshed on a timer so render stays pure.
  const [nowMs, setNowMs] = useState(0)
  useEffect(() => {
    const tick = () => setNowMs(Date.now())
    tick()
    const id = setInterval(tick, 30_000)
    return () => clearInterval(id)
  }, [])

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

  const steps = useMemo<StepKey[]>(() => {
    const s: StepKey[] = ['start']
    // "Start from" only makes sense once this person has actually saved a
    // setup. Saved setups live in their own browser under their user id, so a
    // first-time user has nothing to choose between.
    if (savedConfig) s.push('config')
    if (configChoice === 'saved') return [...s, 'keywords', 'save', 'review']
    s.push('source', 'country', 'language')
    // Keywords first, then how each one is run.
    s.push('keywords', 'pages')
    if (isSerp) s.push('view')
    if (isSocial) s.push('topn')
    if (isSerp) s.push('enrichment')
    s.push('save', 'review')
    return s
  }, [configChoice, isSerp, isSocial, savedConfig])

  const stepIndex = Math.min(stepIdx, steps.length - 1)
  const step: StepKey = steps[stepIndex] ?? 'start'
  const isLast = stepIndex === steps.length - 1

  // Persist after every change so a refresh resumes exactly here.
  useEffect(() => {
    if (submitted) return
    const draft: WizardDraft = {
      v: 1,
      stepIndex,
      touched,
      mode,
      scheduledAtLocal,
      scheduleTz,
      configChoice,
      engine,
      country,
      language,
      pages,
      viewMode,
      keywords,
      enrichChoice,
      stages,
      topChoice,
      topN,
      runAnyway,
      saveConfig,
    }
    writeStored(draftKey(userKey), draft)
  }, [
    submitted, userKey, stepIndex, touched, mode, scheduledAtLocal, scheduleTz, configChoice, engine, country,
    language, pages, viewMode, keywords, enrichChoice, stages, topChoice, topN, runAnyway, saveConfig,
  ])

  /** True once this step has been answered, which is what turns a Default
   *  suggestion into a filled, checked choice. */
  const answered = touched.includes(step)

  function markAnswered() {
    setTouched(prev => (prev.includes(step) ? prev : [...prev, step]))
  }
  function go(delta: number) {
    setStepIdx(i => Math.max(0, Math.min(i + delta, steps.length - 1)))
  }
  /** Picking an option on a single-choice step answers it and moves on. */
  function pick(fn: () => void) {
    fn()
    markAnswered()
    go(1)
  }
  /** Answers the step without advancing, for steps that need a Continue. */
  function choose(fn: () => void) {
    fn()
    markAnswered()
  }

  function applySaved(cfg: SavedConfig) {
    markAnswered()
    setConfigChoice('saved')
    setEngine(cfg.search_engine)
    setCountry(cfg.country_code)
    setLanguage(cfg.language)
    setPages(cfg.pages)
    setViewMode(cfg.view_mode)
    setEnrichChoice(cfg.with_enrichment ? 'stages' : 'none')
    setStages(cfg.enrichment_stages)
    setTopChoice(cfg.top_n_by_follower === null ? 'all' : 'n')
    if (cfg.top_n_by_follower !== null) setTopN(cfg.top_n_by_follower)
    go(1)
  }

  function validate(k: StepKey): { ok: boolean; message?: string } {
    switch (k) {
      case 'start': {
        if (mode === 'now' && todayFull) return { ok: false, message: `Today's limit is used up. It resets in ${countdown}.` }
        if (mode === 'schedule') {
          if (!scheduledAtIso) return { ok: false, message: 'Pick a date and time.' }
          if (nowMs > 0 && new Date(scheduledAtIso).getTime() <= nowMs) return { ok: false, message: 'That time has already passed.' }
          if (remaining === 0 && !quota.exempt) return { ok: false, message: `No quota left for ${dayLabel(quotaDay).toLowerCase()}.` }
        }
        return { ok: true }
      }
      case 'config':
        return configChoice ? { ok: true } : { ok: false, message: 'Choose how to start.' }
      case 'country': {
        if (!country) return { ok: false, message: 'Pick a country.' }
        if (engine === 'bing' && BING_DISABLED_COUNTRIES.has(country)) return { ok: false, message: 'Bing does not cover this country. Pick another country, or use Google.' }
        return { ok: true }
      }
      case 'keywords': {
        if (keywords.length === 0) return { ok: false, message: 'Add at least one keyword.' }
        if (keywords.length > MAX_KEYWORDS) return { ok: false, message: `At most ${MAX_KEYWORDS} keywords per scrape.` }
        const long = keywords.find(x => x.length > MAX_KEYWORD_CHARS)
        if (long) return { ok: false, message: `"${long.slice(0, 40)}…" is longer than ${MAX_KEYWORD_CHARS} characters.` }
        return { ok: true }
      }
      case 'enrichment':
        if (enrichChoice === 'stages' && stages.length === 0) return { ok: false, message: 'Pick at least one stage, or choose no enrichment.' }
        return { ok: true }
      case 'topn':
        if (!topChoice) return { ok: false, message: 'Choose how many to keep.' }
        if (topChoice === 'n' && (!Number.isInteger(topN) || topN < 1)) return { ok: false, message: 'Enter a whole number of 1 or more.' }
        return { ok: true }
      case 'review':
        if (remaining !== null && !quota.exempt && distinctKeywords > remaining) {
          return { ok: false, message: `This needs ${distinctKeywords} keywords but only ${remaining} remain for ${dayLabel(quotaDay).toLowerCase()}.` }
        }
        return { ok: true }
      default:
        return { ok: true }
    }
  }
  const current = validate(step)
  /** Steps that need a Continue button because one click is not enough:
   *  free text, several answers, or a typed number. Everywhere else, picking
   *  an option moves on by itself. */
  const needsContinue =
    step === 'keywords' || step === 'enrichment' || step === 'topn' || (step === 'start' && mode === 'schedule')

  function buildDraft(): ScrapeDraft {
    return {
      mode,
      scheduled_at: mode === 'schedule' ? scheduledAtIso : null,
      schedule_tz: scheduleTz,
      search_engine: engine,
      country_code: country ?? '',
      language,
      pages,
      view_mode: isSerp ? viewMode : 'both',
      keywords,
      enrichment_stages: isSerp && enrichChoice === 'stages' ? stages : [],
      with_enrichment: isSerp && enrichChoice === 'stages' && stages.length > 0,
      top_n_by_follower: isSocial ? (topChoice === 'n' ? topN : null) : null,
      duplicate_override: runAnyway,
    }
  }

  /** Submits via the same `enqueueScrape` server action the old inline form
   *  used. `forceOverride` lets the duplicate-warning panel resubmit with
   *  `duplicate_override=1` immediately, without waiting on the `runAnyway`
   *  checkbox state to flush through a re-render. */
  function submit(forceOverride?: boolean) {
    const draft = buildDraft()
    const override = forceOverride ?? draft.duplicate_override

    const fd = new FormData()
    fd.set('keyword', draft.keywords.join('\n'))
    fd.set('country_code', draft.country_code)
    fd.set('pages', String(draft.pages))
    fd.set('language', draft.language)
    fd.set('search_engine', draft.search_engine)
    fd.set('view_mode', draft.view_mode)
    if (draft.with_enrichment) fd.set('with_enrichment', 'on')
    if (draft.scheduled_at) fd.set('scheduled_at', draft.scheduled_at)
    if (draft.top_n_by_follower !== null) fd.set('top_n_by_follower', String(draft.top_n_by_follower))
    if (override) fd.set('duplicate_override', '1')

    setSubmitError(null)
    setDuplicateWarning(null)

    startTransition(async () => {
      const result = await enqueueScrape(null, fd)
      if (!result) return
      if (result.status === 'error') {
        setSubmitError(result.error)
        return
      }
      if (result.status === 'duplicate_warning') {
        setDuplicateWarning({ duplicates: result.duplicates, freshCount: result.freshCount })
        return
      }

      // status === 'ok' — actually queued.
      if (saveConfig) {
        const cfg: SavedConfig = {
          savedAt: new Date().toISOString(),
          search_engine: draft.search_engine,
          country_code: draft.country_code,
          language: draft.language,
          pages: draft.pages,
          view_mode: draft.view_mode,
          enrichment_stages: draft.enrichment_stages,
          with_enrichment: draft.with_enrichment,
          top_n_by_follower: draft.top_n_by_follower,
        }
        writeStored(savedConfigKey(userKey), cfg)
        setSavedConfig(cfg)
      }
      if (stages.length > 0) writeStored(lastStagesKey(userKey), stages)
      clearStored(draftKey(userKey))
      // Display reference only — the real batch number is assigned when the
      // job completes (batch_counter), not at enqueue time.
      const stamp = new Date()
      setTicketRef(
        `${stamp.getUTCFullYear()}${String(stamp.getUTCMonth() + 1).padStart(2, '0')}${String(stamp.getUTCDate()).padStart(2, '0')}-${draft.country_code}-${String(stamp.getTime()).slice(-4)}`,
      )
      setSuccessMessage(result.message)
      setSubmitted(draft)
    })
  }

  function addKeywords(text: string) {
    const fresh = splitKeywords(text, keywords)
    if (!fresh.length) return
    setKeywords(prev => [...prev, ...fresh].slice(0, MAX_KEYWORDS))
    setKeywordInput('')
  }

  function resetAll() {
    clearStored(draftKey(userKey))
    const d = defaultDraft()
    setSubmitted(null)
    setStepIdx(0)
    setMode(d.mode)
    setScheduledAtLocal('')
    setConfigChoice(null)
    setEngine(d.engine)
    setCountry(null)
    setLanguage('en')
    setPages(d.pages)
    setViewMode(d.viewMode)
    setKeywords([])
    setEnrichChoice(d.enrichChoice)
    setStages(rememberedStages)
    setTopChoice(null)
    setRunAnyway(false)
    setSaveConfig(false)
    setDismissedResume(true)
    setSubmitError(null)
    setDuplicateWarning(null)
    setSuccessMessage(null)
  }

  const filteredProfiles = useMemo(() => {
    const q = countryQuery.trim().toLowerCase()
    if (!q) return profiles
    return profiles.filter(p => p.country_name.toLowerCase().includes(q) || p.country_code.toLowerCase().includes(q))
  }, [profiles, countryQuery])

  // Server pass and first hydration render the frame only, so the restored
  // draft cannot cause a mismatch.
  if (!isClient) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-4 md:px-6 md:py-5">
        <Header quota={quota} day={today} />
        <div className="mt-4 h-[400px] animate-pulse rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]/40" />
      </div>
    )
  }

  if (submitted) {
    const estimate = queueByCountry[submitted.country_code] ?? null
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-4 md:px-6 md:py-5 lg:max-w-none lg:px-8">
        <Header quota={quota} day={quotaDay} />
        <div className="mt-4 flex flex-col gap-3">
          <QueueTicket
            info={{
              draft: submitted,
              countryName: profile?.country_name ?? submitted.country_code,
              estimate: estimate ? { ...estimate, totalPending } : null,
              reference: ticketRef,
            }}
            onCreateAnother={resetAll}
          />
          <Note tone="ok">
            {successMessage ?? 'Queued.'} The position and wait above are the live queue for{' '}
            {profile?.country_name ?? submitted.country_code} as of page load.
            {saveConfig && ' Your setup was saved to this browser and will be offered next time.'}
          </Note>
          <Link href="/scrape" className="inline-flex w-fit items-center gap-1.5 text-[12.5px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]">
            <ArrowLeft className="h-3.5 w-3.5" /> View scraping table
          </Link>
        </div>
      </div>
    )
  }

  // The desktop form submits in one go, so it needs the first blocking
  // problem across every step this engine uses — the stepper gets the same
  // answer one step at a time via `validate(step)`.
  const firstProblem: string | null = (() => {
    for (const k of steps) {
      if (k === 'review' || k === 'save' || k === 'config') continue
      const v = validate(k)
      if (!v.ok) return v.message ?? 'Something above still needs an answer.'
    }
    return null
  })()

  // ---- step bodies, shared by the mobile stepper and the desktop form ----
  const renderStart = (ans: boolean) => (
              <>
                <StepHeading title="When should this scrape run?">
                  A scrape spends one keyword of your daily quota per keyword and country. Scheduling for a later day spends that
                  day&rsquo;s quota the moment you submit, so different days can have different amounts left.
                </StepHeading>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <Tile selected={ans && mode === 'now'} isDefault onClick={() => pick(() => setMode('now'))} disabled={todayFull}>
                    <ListPlus className="h-5 w-5" />
                    <span className="text-[13.5px] font-medium">Add to queue now</span>
                    <span className="text-[11.5px] text-[color:var(--color-text-secondary)]">Starts when a worker is free</span>
                  </Tile>
                  <Tile selected={ans && mode === 'schedule'} onClick={() => choose(() => setMode('schedule'))}>
                    <CalendarClock className="h-5 w-5" />
                    <span className="text-[13.5px] font-medium">Schedule for later</span>
                    <span className="text-[11.5px] text-[color:var(--color-text-secondary)]">Runs at a time you choose</span>
                  </Tile>
                </div>
                {todayFull && (
                  <div className="mt-3">
                    <Note tone="error">
                      Today&rsquo;s {quota.cap} keywords are used up. The quota resets at UTC midnight, in{' '}
                      <span className="font-mono tabular-nums">{countdown}</span>. You can still schedule for another day.
                    </Note>
                  </div>
                )}
                {mode === 'schedule' && (
                  <div className="mt-4 flex flex-col gap-3">
                    <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                      <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]" htmlFor="scheduled_at_local">
                        Date and time
                        <input
                          id="scheduled_at_local"
                          type="datetime-local"
                          value={scheduledAtLocal}
                          onChange={e => setScheduledAtLocal(e.target.value)}
                          className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-[12px] text-[color:var(--color-text-secondary)]" htmlFor="schedule_tz">
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
                      <p className="text-[12.5px] text-[color:var(--color-text-secondary)]">
                        Runs {new Date(scheduledAtIso).toLocaleString()} your time. Counts against{' '}
                        <span className="font-medium text-[color:var(--color-text-primary)]">{dayLabel(quotaDay)}</span>.
                      </p>
                    )}
                  </div>
                )}
              </>
  )

  const renderConfig = (ans: boolean) => (
              <>
                <StepHeading title="How do you want to start?">
                  A saved configuration keeps the source, country, language, pages, device and enrichment stages you chose last
                  time, so only the keywords change. You can save the current setup at the end of this form.
                </StepHeading>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <Tile selected={ans && configChoice === 'new'} isDefault={!savedConfig} onClick={() => pick(() => setConfigChoice('new'))}>
                    <Plus className="h-5 w-5" />
                    <span className="text-[13.5px] font-medium">Set everything up</span>
                    <span className="text-[11.5px] text-[color:var(--color-text-secondary)]">Choose each option</span>
                  </Tile>
                  <Tile
                    selected={ans && configChoice === 'saved'}
                    isDefault={!!savedConfig}
                    onClick={() => savedConfig && applySaved(savedConfig)}
                    disabled={!savedConfig}
                    title={savedConfig ? undefined : 'You have not saved a configuration yet'}
                  >
                    <Star className="h-5 w-5" />
                    <span className="text-[13.5px] font-medium">Use saved configuration</span>
                    <span className="text-[11.5px] text-[color:var(--color-text-secondary)]">
                      {savedConfig ? 'Go straight to the keywords' : 'Nothing saved yet'}
                    </span>
                  </Tile>
                </div>
                {savedConfig && (
                  <div className="mt-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-3 text-[12.5px]">
                    <div className="mb-1 font-medium text-[color:var(--color-text-primary)]">
                      Saved {new Date(savedConfig.savedAt).toLocaleDateString()} · only on this browser
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[color:var(--color-text-secondary)]">
                      <span className="inline-flex items-center gap-1.5">
                        <EngineMono engine={savedConfig.search_engine} size="sm" />
                        {engineDef(savedConfig.search_engine)?.label}
                      </span>
                      <span className="inline-flex items-center gap-1.5"><Flag code={savedConfig.country_code} />{profiles.find(p => p.country_code === savedConfig.country_code)?.country_name ?? savedConfig.country_code}</span>
                      <span>{langName(savedConfig.language)}</span>
                      <span>{savedConfig.pages} page{savedConfig.pages === 1 ? '' : 's'}</span>
                      <span>{savedConfig.view_mode === 'both' ? 'desktop and mobile' : savedConfig.view_mode}</span>
                      <span>
                        {savedConfig.with_enrichment
                          ? savedConfig.enrichment_stages.map(k => ENRICHMENT_STAGES.find(s => s.key === k)?.label ?? k).join(', ')
                          : 'no enrichment'}
                      </span>
                    </div>
                  </div>
                )}
              </>
  )

  const renderSource = (ans: boolean) => (
              <>
                <StepHeading title="Which source should we search?">
                  Google and Bing return websites, which become leads and can be enriched. The rest return accounts on a platform:
                  they are stored in their own tables, never become leads, and no enrichment stage runs on them.
                </StepHeading>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                  {ENGINES.map(e => (
                    <Tile
                      key={e.key}
                      selected={ans && engine === e.key}
                      isDefault={e.key === DEFAULT_ENGINE}
                      onClick={() =>
                        pick(() => {
                          setEngine(e.key)
                          if (e.kind === 'social') setTopChoice(null)
                        })
                      }
                    >
                      <EngineMono engine={e.key} />
                      <span className="text-[12.5px] font-medium">{e.label}</span>
                      <span className="text-[10.5px] text-[color:var(--color-text-secondary)]">{e.returns}</span>
                    </Tile>
                  ))}
                </div>
                {def && <p className="mt-3 text-[12.5px] leading-relaxed text-[color:var(--color-text-secondary)]">{def.detail}</p>}
              </>
  )

  const renderCountry = (ans: boolean) => (
              <>
                <StepHeading title="Which country?">
                  The scrape runs through that country&rsquo;s browser profile and residential proxy, so results match what someone
                  in that market would see. Only countries with a configured profile are listed.
                </StepHeading>
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
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  {filteredProfiles.map(p => {
                    const bingOff = engine === 'bing' && BING_DISABLED_COUNTRIES.has(p.country_code)
                    return (
                      <Tile
                        key={p.country_code}
                        selected={ans && country === p.country_code}
                        disabled={bingOff}
                        onClick={() => pick(() => { setCountry(p.country_code); setLanguage('en') })}
                        title={
                          bingOff
                            ? 'Bing does not cover this country'
                            : `${p.country_name} (${p.country_code})${p.requires_google_login ? (p.is_google_logged_in ? ' · Google login active' : ' · needs a Google login') : ''}`
                        }
                      >
                        <Flag code={p.country_code} className="h-6 w-9" />
                        <span className="text-[12.5px] font-medium">{p.country_name}</span>
                      </Tile>
                    )
                  })}
                  {filteredProfiles.length === 0 && (
                    <p className="col-span-full text-[12.5px] text-[color:var(--color-text-secondary)]">No country matches &ldquo;{countryQuery}&rdquo;.</p>
                  )}
                </div>
              </>
  )

  const renderLanguage = (ans: boolean) => (
              <>
                <StepHeading title="Which language?">
                  This sets the search language, not the country. Only languages configured for {profile?.country_name ?? 'this country'} are
                  offered. Non-English keywords also get an English translation stored beside them.
                </StepHeading>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {langOptions(profile?.languages).map(code => (
                    <Tile key={code} selected={ans && language === code} isDefault={code === 'en'} onClick={() => pick(() => setLanguage(code))}>
                      <span className="text-[13.5px] font-medium">{langName(code)}</span>
                      <span className="text-[10.5px] uppercase text-[color:var(--color-text-secondary)]">{code}</span>
                    </Tile>
                  ))}
                </div>
              </>
  )

  const renderPages = (ans: boolean) => (
              <>
                <StepHeading title="How many result pages?">
                  Each page is about 10 results, so 3 pages is roughly 30 leads per keyword. Paid ads only ever appear on page one.
                  More pages means more time per keyword and more quota spent on enrichment later.
                </StepHeading>
                <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
                  {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                    <Tile key={n} selected={ans && pages === n} isDefault={n === 1} onClick={() => pick(() => setPages(n))} className="min-h-[48px]">
                      <span className="text-[16px] font-semibold tabular-nums">{n}</span>
                    </Tile>
                  ))}
                </div>
              </>
  )

  const renderView = (ans: boolean) => (
              <>
                <StepHeading title="Desktop, mobile, or both?">
                  Google returns different results and different ads to a phone than to a desktop, and many casino campaigns run
                  mobile only. Both runs the pages twice and merges them, which takes longer but misses less.
                </StepHeading>
                <div className="grid gap-2.5 sm:grid-cols-3">
                  <Tile selected={ans && viewMode === 'both'} isDefault onClick={() => pick(() => setViewMode('both'))}>
                    <MonitorSmartphone className="h-5 w-5" />
                    <span className="text-[13.5px] font-medium">Both</span>
                    <span className="text-[11.5px] text-[color:var(--color-text-secondary)]">Two passes, merged</span>
                  </Tile>
                  <Tile selected={ans && viewMode === 'desktop'} onClick={() => pick(() => setViewMode('desktop'))}>
                    <Monitor className="h-5 w-5" />
                    <span className="text-[13.5px] font-medium">Desktop only</span>
                    <span className="text-[11.5px] text-[color:var(--color-text-secondary)]">Fastest</span>
                  </Tile>
                  <Tile selected={ans && viewMode === 'mobile'} onClick={() => pick(() => setViewMode('mobile'))}>
                    <Smartphone className="h-5 w-5" />
                    <span className="text-[13.5px] font-medium">Mobile only</span>
                    <span className="text-[11.5px] text-[color:var(--color-text-secondary)]">Mobile-only campaigns</span>
                  </Tile>
                </div>
              </>
  )

  const renderKeywords = (_ans: boolean) => (
              <>
                <StepHeading title={configChoice === 'saved' ? 'Which keywords this time?' : 'What should we search for?'}>
                  One search runs per keyword, and each keyword and country pair costs one of your daily quota. Press Enter to add
                  one, or paste a list: line breaks, commas and semicolons all split into separate keywords, and duplicates are dropped.
                </StepHeading>
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
                    className="min-w-0 flex-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2 text-[13.5px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
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
                <div className="mt-2.5 flex items-center justify-between text-[11.5px] text-[color:var(--color-text-secondary)]">
                  <span>{keywords.length} of {MAX_KEYWORDS} keywords</span>
                  {keywords.length > 0 && (
                    <button type="button" onClick={() => setKeywords([])} className="underline hover:text-[color:var(--color-text-primary)]">Clear all</button>
                  )}
                </div>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {keywords.map(k => (
                    <li key={k} className="inline-flex max-w-full items-center gap-1 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] py-1 pl-3 pr-1 text-[12.5px]">
                      <span className="truncate">{k}</span>
                      <button type="button" onClick={() => setKeywords(prev => prev.filter(x => x !== k))} aria-label={`Remove ${k}`} className="rounded-full p-0.5 text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-border)] hover:text-[color:var(--color-text-primary)]">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
                {remaining !== null && distinctKeywords > 0 && (
                  <div className="mt-3">
                    <Note tone={distinctKeywords > remaining && !quota.exempt ? 'error' : 'info'}>
                      Uses <span className="font-medium">{distinctKeywords}</span> of the <span className="font-medium">{remaining}</span> keywords left for {dayLabel(quotaDay).toLowerCase()}.
                    </Note>
                  </div>
                )}
              </>
  )

  const renderEnrichment = (ans: boolean) => (
              <>
                <StepHeading title="What should run on the results?">
                  Enrichment opens each lead&rsquo;s page after the scrape. Every stage costs worker time, so pick only what you need.
                  Stages you choose are remembered for your next scrape.
                </StepHeading>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <Tile selected={ans && enrichChoice === 'none'} isDefault onClick={() => choose(() => { setEnrichChoice('none'); setStages([]) })}>
                    <X className="h-5 w-5" />
                    <span className="text-[13.5px] font-medium">No enrichment</span>
                    <span className="text-[11.5px] text-[color:var(--color-text-secondary)]">Just the results list</span>
                  </Tile>
                  <Tile selected={ans && enrichChoice === 'stages'} onClick={() => choose(() => setEnrichChoice('stages'))}>
                    <FlaskConical className="h-5 w-5" />
                    <span className="text-[13.5px] font-medium">Choose stages</span>
                    <span className="text-[11.5px] text-[color:var(--color-text-secondary)]">
                      {stages.length > 0 ? `${stages.length} selected` : 'Pick from the list'}
                    </span>
                  </Tile>
                </div>
                {enrichChoice === 'stages' && (
                  <>
                    <div className="mt-3 flex items-center justify-between text-[12px]">
                      <span className="text-[color:var(--color-text-secondary)]">{stages.length} of {ALL_STAGE_KEYS.length} stages</span>
                      <span className="flex gap-3">
                        <button type="button" onClick={() => setStages([...ALL_STAGE_KEYS])} className="underline text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]">Select all</button>
                        <button type="button" onClick={() => setStages([])} className="underline text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]">Clear all</button>
                      </span>
                    </div>
                    <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                      {ENRICHMENT_STAGES.map(s => {
                        const on = stages.includes(s.key)
                        return (
                          <li key={s.key}>
                            <button
                              type="button"
                              aria-pressed={on}
                              onClick={() => setStages(prev => (prev.includes(s.key) ? prev.filter(x => x !== s.key) : [...prev, s.key]))}
                              className={[
                                'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
                                on ? 'border-[color:var(--color-accent-hover)] bg-[color:var(--color-accent)]/25' : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] hover:bg-[color:var(--color-bg-secondary)]',
                              ].join(' ')}
                            >
                              <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? 'border-[color:var(--color-accent-hover)] bg-[color:var(--color-accent-hover)] text-white' : 'border-[color:var(--color-border-strong)]'}`}>
                                {on && <Check className="h-3 w-3" />}
                              </span>
                              <span className="min-w-0">
                                <span className="block text-[13px] font-medium">{s.label}</span>
                                <span className="block text-[11.5px] leading-snug text-[color:var(--color-text-secondary)]">{s.hint}</span>
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </>
                )}
              </>
  )

  const renderTopn = (ans: boolean) => (
              <>
                <StepHeading title="How many accounts should we keep?">
                  {def?.label} discovery can return hundreds of accounts. Keeping the largest by follower count trims the list to the
                  ones worth contacting; All keeps everything found.
                </StepHeading>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {TOP_N_PRESETS.map(n => (
                    <Tile key={n} selected={ans && topChoice === 'n' && topN === n} onClick={() => pick(() => { setTopChoice('n'); setTopN(n) })} className="min-h-[48px]">
                      <span className="text-[14.5px] font-semibold tabular-nums">Top {n}</span>
                    </Tile>
                  ))}
                  <Tile selected={ans && topChoice === 'all'} onClick={() => pick(() => setTopChoice('all'))} className="min-h-[48px]">
                    <span className="text-[14.5px] font-semibold">All</span>
                  </Tile>
                </div>
                <label className="mt-3 flex items-center gap-2 text-[12.5px] text-[color:var(--color-text-secondary)]" htmlFor="top_n_custom">
                  Or a custom number
                  <input
                    id="top_n_custom"
                    type="number"
                    min={1}
                    value={topChoice === 'n' ? topN : ''}
                    onChange={e => choose(() => { setTopChoice('n'); setTopN(Number(e.target.value)) })}
                    className="w-24 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1.5 text-[13px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none"
                  />
                </label>
              </>
  )

  const renderSave = (ans: boolean) => (
              <>
                <StepHeading title="Save this setup for next time?">
                  A saved setup keeps the source, country, language, pages, device and enrichment stages, so your next scrape only
                  needs keywords. It is stored in this browser under your account, never on the server, and replaces whatever you
                  saved before. Keywords are never part of it.
                </StepHeading>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <Tile selected={ans && !saveConfig} isDefault onClick={() => pick(() => setSaveConfig(false))}>
                    <X className="h-5 w-5" />
                    <span className="text-[13.5px] font-medium">Do not save</span>
                    <span className="text-[11.5px] text-[color:var(--color-text-secondary)]">Use it this once</span>
                  </Tile>
                  <Tile selected={ans && saveConfig} onClick={() => pick(() => setSaveConfig(true))}>
                    <Star className="h-5 w-5" />
                    <span className="text-[13.5px] font-medium">Save this setup</span>
                    <span className="text-[11.5px] text-[color:var(--color-text-secondary)]">
                      {savedConfig ? 'Replaces the one you saved before' : 'Offered on the next scrape'}
                    </span>
                  </Tile>
                </div>
                <div className="mt-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-3">
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">
                    What would be saved
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-[color:var(--color-text-secondary)]">
                    <span className="inline-flex items-center gap-1.5">
                      <EngineMono engine={engine} size="sm" />
                      {def?.label}
                    </span>
                    <span className="inline-flex items-center gap-1.5">{country ? <><Flag code={country} />{profile?.country_name ?? country}</> : 'no country yet'}</span>
                    <span>{langName(language)}</span>
                    <span>{pages} page{pages === 1 ? '' : 's'}</span>
                    {isSerp && <span>{viewMode === 'both' ? 'desktop and mobile' : viewMode === 'desktop' ? 'desktop only' : 'mobile only'}</span>}
                    {isSerp && (
                      <span>
                        {enrichChoice === 'stages' && stages.length > 0
                          ? stages.map(k => ENRICHMENT_STAGES.find(s => s.key === k)?.label ?? k).join(', ')
                          : 'no enrichment'}
                      </span>
                    )}
                    {isSocial && <span>{topChoice === 'all' ? 'keep all' : `top ${topN} by followers`}</span>}
                  </div>
                  {savedConfig && (
                    <p className="mt-2 text-[11.5px] text-[color:var(--color-text-secondary)]">
                      You currently have a setup saved from {new Date(savedConfig.savedAt).toLocaleDateString()}.
                    </p>
                  )}
                </div>
              </>
  )

  const renderReview = (_ans: boolean) => (
              <>
                <StepHeading title="Check and start">
                  Everything below is what gets queued. Select any line to change it.
                </StepHeading>
                <SummaryCard draft={buildDraft()} profile={profile} onEdit={k => setStepIdx(Math.max(0, steps.indexOf(k)))} steps={steps} />
                <div className="mt-3 flex flex-col gap-3">
                  {remaining !== null && (
                    <Note tone={!quota.exempt && distinctKeywords > remaining ? 'error' : 'ok'}>
                      Uses <span className="font-medium">{distinctKeywords}</span> of the <span className="font-medium">{remaining}</span> keywords left for {dayLabel(quotaDay).toLowerCase()}.
                      {quota.exempt && ' Your account is exempt from the cap, so this is for information only.'}
                    </Note>
                  )}
                  <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-3">
                    <p className="text-[12.5px] leading-relaxed text-[color:var(--color-text-secondary)]">
                      Keywords that already completed for {profile?.country_name ?? 'this country'} on {def?.label ?? 'this source'} are listed
                      after you submit so you can decide. Tick this to skip that question and run them again regardless.
                    </p>
                    <label className="mt-2 flex items-center gap-2 text-[13px]" htmlFor="run_anyway">
                      <input id="run_anyway" type="checkbox" checked={runAnyway} onChange={e => setRunAnyway(e.target.checked)} className="h-4 w-4 accent-[color:var(--color-accent-hover)]" />
                      Run duplicates anyway
                    </label>
                  </div>
                  {submitError && <Note tone="error">{submitError}</Note>}
                </div>
              </>
  )

  const progress = ((stepIndex + 1) / steps.length) * 100

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-4 md:px-6 md:py-5 lg:max-w-none lg:px-8">
      <Header quota={quota} day={quotaDay} />

      {!isDesktop && restored && !dismissedResume && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-3 py-2 text-[12.5px]">
          <span className="text-[color:var(--color-text-secondary)]">
            Picked up where you left off. {keywords.length > 0 ? `${keywords.length} keyword${keywords.length === 1 ? '' : 's'} still here.` : ''}
          </span>
          <span className="flex gap-2">
            <button type="button" onClick={() => setDismissedResume(true)} className="text-[color:var(--color-text-secondary)] underline hover:text-[color:var(--color-text-primary)]">
              Keep going
            </button>
            <button type="button" onClick={resetAll} className="text-[color:var(--color-text-secondary)] underline hover:text-[color:var(--color-text-primary)]">
              Start over
            </button>
          </span>
        </div>
      )}

      {/* Progress: a bar, not a numbered strip. Stepper only. */}
      <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-[color:var(--color-bg-secondary)] lg:hidden" role="presentation">
        <div className="h-full rounded-full bg-[color:var(--color-accent-hover)] transition-all duration-300" style={{ width: `${progress}%` }} />
      </div>

      {/* ---------------- desktop: every input at once ---------------- */}
      {isDesktop && (
      <div className="mt-4">
        {/* Two columns rather than a field of separate boxes: setup on the
            left, and the right column led by the keywords, which is the part
            that changes every time. */}
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
          <div className="divide-y divide-[color:var(--color-border)] rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
            <FormRow title="When">{renderStart(true)}</FormRow>
            {savedConfig && <FormRow title="Start from">{renderConfig(true)}</FormRow>}
            <FormRow title="Source">{renderSource(true)}</FormRow>
            <FormRow title="Country">{renderCountry(true)}</FormRow>
            <FormRow title="Language">{renderLanguage(true)}</FormRow>
          </div>

          <div className="divide-y divide-[color:var(--color-border)] rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
            {/* Keywords first, then how each one is run — same order as the
                stepper on a phone. */}
            <FormRow title="Keywords">{renderKeywords(true)}</FormRow>
            <FormRow title="Pages per keyword">{renderPages(true)}</FormRow>
            {isSerp && <FormRow title="Device">{renderView(true)}</FormRow>}
            {isSocial && <FormRow title="How many to keep">{renderTopn(true)}</FormRow>}
            {isSerp && <FormRow title="Enrichment">{renderEnrichment(true)}</FormRow>}
            <FormRow title="Save this setup">{renderSave(true)}</FormRow>
          </div>
        </div>

        <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]/95 px-4 py-3 backdrop-blur">
          <div className="min-w-0 text-[12.5px] text-[color:var(--color-text-secondary)]">
            {firstProblem ? (
              <span className="text-amber-800">{firstProblem}</span>
            ) : (
              <>
                {distinctKeywords} {distinctKeywords === 1 ? 'keyword' : 'keywords'} ·{' '}
                {country ? `${profile?.country_name ?? country}` : 'no country yet'} · {def?.label ?? engine}
                {remaining !== null && !quota.exempt && ` · ${remaining} left ${dayLabel(quotaDay).toLowerCase()}`}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {submitError && <span className="text-[12.5px] text-red-700">{submitError}</span>}
            <button
              type="button"
              onClick={() => submit()}
              disabled={firstProblem !== null || isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-[color:var(--color-text-primary)] px-5 py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {isPending ? 'Queuing…' : mode === 'schedule' ? 'Schedule scrape' : 'Start scraping'}
            </button>
          </div>
        </div>

      </div>

      )}

      {/* ---------------- phone + tablet: one step at a time ---------------- */}
      {!isDesktop && (
      <div className="mt-4">
        <section className="flex flex-col rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
          {/* A floor on the content height so short steps do not make the card
              jump between one answer and the next. Tall steps still grow. */}
          <div className="flex-1 p-4 md:p-5 min-h-[330px] sm:min-h-[360px]">
            {step === 'start' && renderStart(answered)}

            {step === 'config' && renderConfig(answered)}

            {step === 'source' && renderSource(answered)}

            {step === 'country' && renderCountry(answered)}

            {step === 'language' && renderLanguage(answered)}

            {step === 'pages' && renderPages(answered)}

            {step === 'view' && renderView(answered)}

            {step === 'keywords' && renderKeywords(answered)}

            {step === 'enrichment' && renderEnrichment(answered)}

            {step === 'topn' && renderTopn(answered)}

            {step === 'save' && renderSave(answered)}

            {step === 'review' && renderReview(answered)}
          </div>

          {/* Nav bar: Back only after step one; Continue only where a step
              needs more than a single click. */}
          {(stepIndex > 0 || needsContinue) && (
            <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-b-xl border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]/95 px-4 py-2.5 backdrop-blur md:static">
              {stepIndex > 0 ? (
                <button
                  type="button"
                  onClick={() => go(-1)}
                  className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] px-3 py-2 text-[13px] text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
                >
                  <ChevronLeft className="h-4 w-4" /> Back
                </button>
              ) : (
                <span />
              )}
              <div className="min-w-0 flex-1 text-center text-[11.5px] text-[color:var(--color-text-secondary)]">
                {!current.ok && current.message ? <span className="text-amber-800">{current.message}</span> : null}
              </div>
              {needsContinue || isLast ? (
                <button
                  type="button"
                  onClick={() => { markAnswered(); if (isLast) submit(); else go(1) }}
                  disabled={!current.ok || (isLast && isPending)}
                  className="inline-flex items-center gap-1 rounded-md bg-[color:var(--color-text-primary)] px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
                >
                  {isLast ? (isPending ? 'Queuing…' : mode === 'schedule' ? 'Schedule scrape' : 'Start scraping') : 'Continue'}
                </button>
              ) : (
                <span />
              )}
            </div>
          )}
        </section>
      </div>
      )}

      {/* Both layouts share one modal. Inline, this answer landed below the
          fold on a long form and read as "nothing happened". */}
      <Modal
        open={duplicateWarning !== null}
        onClose={() => setDuplicateWarning(null)}
        title="Already scraped before"
      >
        {duplicateWarning && (
          <DuplicateWarning
            duplicates={duplicateWarning.duplicates}
            freshCount={duplicateWarning.freshCount}
            pending={isPending}
            onRunAnyway={() => {
              setRunAnyway(true)
              submit(true)
            }}
          />
        )}
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------- pieces ----

function Header({ quota, day }: { quota: QuotaPreview; day: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-[17px] font-semibold text-[color:var(--color-text-primary)]">New scrape</h1>
      </div>
      <QuotaStatus quota={quota} day={day} />
    </div>
  )
}

/** Steps a summary line can jump back to. Mirrors StepKey. */
type EditKey = StepKey

function SummaryList({
  draft,
  profile,
  onEdit,
  steps,
}: {
  draft: ScrapeDraft
  profile: WizardProfile | null
  onEdit?: ((k: EditKey) => void) | undefined
  steps?: readonly EditKey[] | undefined
}) {
  const def = engineDef(draft.search_engine)
  const rows: Array<[string, React.ReactNode, EditKey]> = [
    ['When', draft.mode === 'schedule' ? (draft.scheduled_at ? new Date(draft.scheduled_at).toLocaleString() : 'Scheduled') : 'Now', 'start'],
    ['Source', def ? <span className="inline-flex items-center gap-1.5"><EngineMono engine={def.key} size="sm" />{def.label}</span> : '—', 'source'],
    ['Country', draft.country_code ? <span className="inline-flex items-center gap-1.5"><Flag code={draft.country_code} />{profile?.country_name ?? draft.country_code}</span> : '—', 'country'],
    ['Language', draft.language ? langName(draft.language) : '—', 'language'],
    ['Pages', String(draft.pages), 'pages'],
  ]
  if (def?.kind === 'serp') rows.push(['Device', draft.view_mode === 'both' ? 'Desktop and mobile' : draft.view_mode === 'desktop' ? 'Desktop only' : 'Mobile only', 'view'])
  rows.push(['Keywords', draft.keywords.length ? `${draft.keywords.length}: ${draft.keywords.slice(0, 3).join(', ')}${draft.keywords.length > 3 ? '…' : ''}` : '—', 'keywords'])
  if (def?.kind === 'serp') {
    rows.push([
      'Enrichment',
      draft.with_enrichment ? draft.enrichment_stages.map(k => ENRICHMENT_STAGES.find(s => s.key === k)?.label ?? k).join(', ') : 'None',
      'enrichment',
    ])
  }
  if (def?.kind === 'social') rows.push(['Keep', draft.top_n_by_follower === null ? 'All' : `Top ${draft.top_n_by_follower} by followers`, 'topn'])
  rows.push(['Duplicates', draft.duplicate_override ? 'Run anyway' : 'Ask me', 'review'])

  return (
    <dl className="flex flex-col gap-1">
      {rows.map(([k, v, target]) => {
        const editable = onEdit && (!steps || steps.includes(target))
        const content = (
          <>
            <dt className="shrink-0 text-[12px] text-[color:var(--color-text-secondary)]">{k}</dt>
            <dd className="min-w-0 flex-1 truncate text-right text-[12.5px] text-[color:var(--color-text-primary)]">{v}</dd>
          </>
        )
        return editable ? (
          <button
            key={k}
            type="button"
            onClick={() => onEdit(target)}
            className="group flex items-baseline gap-3 rounded px-1 py-0.5 text-left hover:bg-[color:var(--color-bg-secondary)]"
            title={`Change ${k.toLowerCase()}`}
          >
            {content}
            <Pencil className="h-3 w-3 shrink-0 self-center text-transparent group-hover:text-[color:var(--color-text-secondary)]" />
          </button>
        ) : (
          <div key={k} className="flex items-baseline gap-3 px-1 py-0.5">
            {content}
          </div>
        )
      })}
    </dl>
  )
}

function SummaryCard({
  draft,
  profile,
  onEdit,
  steps,
}: {
  draft: ScrapeDraft
  profile: WizardProfile | null
  onEdit?: ((k: EditKey) => void) | undefined
  steps?: readonly EditKey[] | undefined
}) {
  return (
    <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
      <SummaryList draft={draft} profile={profile} onEdit={onEdit} steps={steps} />
      {draft.keywords.length > 3 && (
        <details className="mt-2 text-[12.5px]">
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
